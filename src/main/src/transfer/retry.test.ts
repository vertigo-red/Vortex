import { VortexError } from "@vortex/shared";
import { AbortError, HTTPError } from "got";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultRetryStrategy, sleep, withRetry } from "./retry";

const DOWNLOAD_URL = "https://example.com/files/archive.zip";

const httpError = (statusCode: number): HTTPError => {
  const request: {
    _onResponse: () => void;
    options: { method: string; url: URL };
    response?: unknown;
  } = {
    _onResponse: () => undefined,
    options: {
      method: "GET",
      url: new URL(DOWNLOAD_URL),
    },
  };
  const response = { statusCode, statusMessage: "test", request };
  request.response = response;
  return new HTTPError(response as never);
};

describe("defaultRetryStrategy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up after the configured number of attempts", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const strategy = defaultRetryStrategy();
    const err = httpError(503);

    expect(strategy({ attempt: 3, error: err })).toEqual({ retry: true, delayMs: 4000 });
    expect(strategy({ attempt: 4, error: err })).toEqual({ retry: false });
  });

  it("backs off exponentially and caps the delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const strategy = defaultRetryStrategy(5, 1000, 30_000);
    const err = httpError(503);

    expect(strategy({ attempt: 1, error: err })).toEqual({ retry: true, delayMs: 1000 });
    expect(strategy({ attempt: 2, error: err })).toEqual({ retry: true, delayMs: 2000 });
    expect(strategy({ attempt: 6, error: err })).toEqual({ retry: true, delayMs: 30_000 });
  });

  it("does not retry when retries are disabled", () => {
    const strategy = defaultRetryStrategy(0);
    expect(strategy({ attempt: 1, error: httpError(503) })).toEqual({ retry: false });
  });

  it("retries retryable HTTP status codes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const strategy = defaultRetryStrategy();
    for (const statusCode of [408, 429, 500, 502, 503, 504]) {
      expect(strategy({ attempt: 1, error: httpError(statusCode) })).toMatchObject({
        retry: true,
      });
    }
  });

  it("does not retry other HTTP status codes", () => {
    const strategy = defaultRetryStrategy();
    expect(strategy({ attempt: 1, error: httpError(404) })).toEqual({ retry: false });
  });

  it("retries known retryable system error codes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const strategy = defaultRetryStrategy();
    const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

    expect(strategy({ attempt: 1, error: err })).toEqual({ retry: true, delayMs: 1000 });
  });

  it("does not retry local filesystem errors", () => {
    const strategy = defaultRetryStrategy();
    const err = new VortexError("Disk full", { kind: "fs:no-space", path: "/dev/sda1" });

    expect(strategy({ attempt: 1, error: err })).toEqual({ retry: false });
  });

  it("classifies errors by their cause", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const strategy = defaultRetryStrategy();
    const err = new Error("server rejected us");
    err.cause = httpError(503);

    expect(strategy({ attempt: 1, error: err })).toEqual({ retry: true, delayMs: 1000 });
  });
});

describe("withRetry", () => {
  it("runs the callback once without a strategy", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates failures without a strategy", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a failed attempt and returns the successful result", async () => {
    const httpErr = httpError(503);
    const fn = vi.fn().mockRejectedValueOnce(httpErr).mockResolvedValueOnce("ok");
    const strategy = vi.fn().mockReturnValue({ retry: true, delayMs: 5 });

    await expect(withRetry(fn, strategy)).resolves.toBe("ok");
    expect(strategy).toHaveBeenCalledTimes(1);
    expect(strategy).toHaveBeenCalledWith({ attempt: 1, error: httpErr });
  });

  it("gives up when the strategy says so and rethrows the last error", async () => {
    const err = httpError(503);
    const fn = vi.fn().mockRejectedValue(err);
    const strategy = vi
      .fn()
      .mockReturnValueOnce({ retry: true, delayMs: 5 })
      .mockReturnValueOnce({ retry: false });

    await expect(withRetry(fn, strategy)).rejects.toBe(err);
    expect(strategy).toHaveBeenCalledTimes(2);
    expect(strategy).toHaveBeenCalledWith({ attempt: 2, error: err });
  });

  it("never retries cancellations", async () => {
    const err = new AbortError({} as never);
    const fn = vi.fn().mockRejectedValue(err);
    const strategy = vi.fn().mockReturnValue({ retry: true, delayMs: 5 });

    await expect(withRetry(fn, strategy)).rejects.toBe(err);
    expect(strategy).not.toHaveBeenCalled();
  });

  it("aborts the backoff sleep when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce("ok");
    const strategy = vi.fn().mockReturnValue({ retry: true, delayMs: 100 });

    await expect(withRetry(fn, strategy, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(strategy).toHaveBeenCalledTimes(1);
  });
});

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });

  it("resolves even with an un-aborted signal", async () => {
    await expect(sleep(5, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects with the abort reason when it is an error", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(sleep(1000, controller.signal)).rejects.toBe(reason);
  });

  it("rejects when the signal aborts while waiting", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = sleep(1000, controller.signal);
    setTimeout(() => {
      controller.abort(reason);
    }, 5);

    await expect(pending).rejects.toBe(reason);
  });
});
