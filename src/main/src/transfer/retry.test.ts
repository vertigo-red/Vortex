import type { RetryContext, RetryVerdict } from "@vortex/shared/download";
import { VortexError } from "@vortex/shared/errors";
import { AbortError, HTTPError, type HTTPError as HTTPErrorType } from "got";
import { describe, it, expect, vi, afterEach } from "vitest";

import { defaultRetryStrategy, sleep, withRetry } from "./retry";

const errorWithCode = (code: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`error ${code}`), { code, ...extra });

const expectRetryAllowed = (verdict: RetryVerdict): void => {
  expect(verdict.retry).toBe(true);
  if (verdict.retry) {
    expect(verdict.delayMs).toBeGreaterThanOrEqual(0);
  }
};

const httpError = (statusCode: number): HTTPErrorType =>
  new HTTPError({
    statusCode,
    statusMessage: "test",
    request: {
      options: {
        method: "GET",
        url: new URL("https://example.com/file"),
      },
    },
  } as never);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaultRetryStrategy", () => {
  describe("attempt limit", () => {
    it("stops after the max retry count is exceeded", () => {
      const strategy = defaultRetryStrategy(3);
      expect(strategy({ attempt: 4, error: errorWithCode("ETIMEDOUT") })).toEqual({ retry: false });
    });

    it("still retries on the final allowed attempt", () => {
      const strategy = defaultRetryStrategy(3);
      expectRetryAllowed(strategy({ attempt: 3, error: errorWithCode("ETIMEDOUT") }));
    });
  });

  describe("retryable network codes", () => {
    it.each(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH"])(
      "retries %s",
      (code) => {
        const strategy = defaultRetryStrategy();
        expectRetryAllowed(strategy({ attempt: 1, error: errorWithCode(code) }));
      },
    );

    it("does not retry an unknown code", () => {
      const strategy = defaultRetryStrategy();
      expect(strategy({ attempt: 1, error: errorWithCode("SOMECODE") })).toEqual({ retry: false });
    });
  });

  describe("http status codes", () => {
    it.each([408, 429, 500, 502, 503, 504])("retries HTTP %s", (statusCode) => {
      const strategy = defaultRetryStrategy();
      expectRetryAllowed(strategy({ attempt: 1, error: httpError(statusCode) }));
    });

    it("does not retry a 404", () => {
      const strategy = defaultRetryStrategy();
      expect(strategy({ attempt: 1, error: httpError(404) })).toEqual({ retry: false });
    });
  });

  describe("non-retryable Vortex errors", () => {
    it("does not retry fs:not-found", () => {
      const strategy = defaultRetryStrategy();
      const err = new VortexError("gone", { kind: "fs:not-found", path: "/x" });
      expect(strategy({ attempt: 1, error: err })).toEqual({ retry: false });
    });

    it("does not retry user-canceled", () => {
      const strategy = defaultRetryStrategy();
      const err = new VortexError("stopped", { kind: "user-canceled", skipped: true });
      expect(strategy({ attempt: 1, error: err })).toEqual({ retry: false });
    });
  });

  describe("http:generic with a retryable original code", () => {
    it("retries when the classified original code is a network code", () => {
      const strategy = defaultRetryStrategy();
      const err = new VortexError("net", {
        kind: "http:generic",
        url: "https://example.com/file",
        originalCode: "ETIMEDOUT",
      });
      expectRetryAllowed(strategy({ attempt: 1, error: err }));
    });
  });

  describe("wrapped causes", () => {
    it("recurses into the cause chain", () => {
      const strategy = defaultRetryStrategy();
      const inner = errorWithCode("ECONNRESET");
      const outer = new Error("wrapper");
      (outer as { cause?: unknown }).cause = inner;
      expectRetryAllowed(strategy({ attempt: 1, error: outer }));
    });
  });

  describe("backoff", () => {
    it("uses exponential backoff capped at the max delay", () => {
      const strategy = defaultRetryStrategy(10, 1000, 5000);
      vi.spyOn(Math, "random").mockReturnValue(0);
      expect(strategy({ attempt: 1, error: errorWithCode("ECONNRESET") })).toEqual({
        retry: true,
        delayMs: 900,
      });
      expect(strategy({ attempt: 2, error: errorWithCode("ECONNRESET") })).toEqual({
        retry: true,
        delayMs: 1900,
      });
      expect(strategy({ attempt: 10, error: errorWithCode("ECONNRESET") })).toEqual({
        retry: true,
        delayMs: 5000,
      });
    });

    it("adds positive jitter when Math.random() is high", () => {
      const strategy = defaultRetryStrategy(1, 1000);
      vi.spyOn(Math, "random").mockReturnValue(1);
      expect(strategy({ attempt: 1, error: errorWithCode("ECONNRESET") })).toEqual({
        retry: true,
        delayMs: 1100,
      });
    });
  });
});

describe("withRetry", () => {
  it("runs the callback once when no strategy is given", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    await expect(withRetry(fn)).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until the callback succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errorWithCode("ECONNRESET"))
      .mockRejectedValueOnce(errorWithCode("ECONNRESET"))
      .mockResolvedValueOnce("ok");
    const seenAttempts: number[] = [];
    const strategy = vi.fn().mockImplementation((ctx: RetryContext) => {
      seenAttempts.push(ctx.attempt);
      return { retry: true, delayMs: 1 } satisfies RetryVerdict;
    });

    await expect(withRetry(fn, strategy)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(seenAttempts).toEqual([1, 2]);
  });

  it("propagates the error when the strategy says not to retry", async () => {
    const err = errorWithCode("EACCES");
    const fn = vi.fn().mockRejectedValue(err);
    const strategy = vi.fn().mockReturnValue({ retry: false });

    await expect(withRetry(fn, strategy)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("converts a thrown non-Error to an Error for the strategy", async () => {
    const fn = vi.fn().mockRejectedValue("boom");
    const seenErrors: Array<Error | undefined> = [];
    const strategy = vi.fn().mockImplementation((ctx: RetryContext) => {
      seenErrors.push(ctx.error);
      return { retry: false } satisfies RetryVerdict;
    });

    await expect(withRetry(fn, strategy)).rejects.toBe("boom");
    expect(seenErrors[0]).toBeInstanceOf(Error);
  });

  it("never retries a cancellation", async () => {
    const abortError = new AbortError({ options: {} } as never);
    const fn = vi.fn().mockRejectedValue(abortError);
    const strategy = vi.fn().mockReturnValue({ retry: true, delayMs: 1 });

    await expect(withRetry(fn, strategy)).rejects.toBe(abortError);
    expect(strategy).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("interrupts the backoff when the abort signal fires", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(errorWithCode("ECONNRESET"));
    const strategy = vi.fn().mockReturnValue({ retry: true, delayMs: 200 });

    const promise = withRetry(fn, strategy, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 10);

    await expect(promise).rejects.toThrow("cancelled");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("sleep", () => {
  it("resolves after the requested delay", async () => {
    const started = Date.now();
    await sleep(10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(sleep(100, controller.signal)).rejects.toThrow("stopped");
  });

  it("rejects when the signal aborts during the wait", async () => {
    const controller = new AbortController();
    const promise = sleep(100, controller.signal);
    setTimeout(() => controller.abort(new Error("stopped")), 5);
    await expect(promise).rejects.toThrow("stopped");
  });

  it("uses a DOMException reason when aborted without one", async () => {
    const controller = new AbortController();
    controller.abort();
    const err: unknown = await sleep(100, controller.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
  });
});
