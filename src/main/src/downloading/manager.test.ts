import { VortexError } from "@vortex/shared";
import type { Chunker, DownloadCheckpoint, RetryStrategy } from "@vortex/shared/download";
import { describe, it, expect, vi, beforeEach } from "vitest";

const logMock = vi.hoisted(() => vi.fn());
const downloadMock = vi.hoisted(() => vi.fn());

vi.mock("../logging", () => ({ log: logMock }));

vi.mock("./downloader", () => ({ download: downloadMock }));

vi.mock("../transfer/retry", () => ({
  defaultRetryStrategy: () => () => ({ retry: false }),
}));

vi.mock("@vortex/shared", () => {
  class MockVortexError extends Error {
    readonly data: Record<string, unknown>;
    readonly isTransient: boolean;
    constructor(
      message: string,
      data: Record<string, unknown> = { kind: "unknown" },
      meta?: { isTransient?: boolean; cause?: unknown },
    ) {
      super(message);
      this.data = data;
      this.isTransient = meta?.isTransient ?? false;
      if (meta?.cause !== undefined) {
        this.cause = meta.cause;
      }
    }
  }

  const parseError = (err: unknown): MockVortexError => {
    if (err instanceof MockVortexError) return err;
    const fallback = err instanceof Error ? err.message : String(err);
    return new MockVortexError(fallback, { kind: "unknown" });
  };

  return { VortexError: MockVortexError, parseError };
});

vi.mock("@vortex/shared/download", () => ({
  staticChunker: () => () => [],
}));

import { DownloadManager, defaultTimeout } from "./manager";

type ReporterLike = {
  etag: string | undefined;
  fileName: string | undefined;
  isChunked: boolean;
  init(size: number | undefined): { bytesReceived: number; bytesWritten: number };
  initChunked(
    chunks: { index: number; range: { start: number; end: number } }[],
    size: number,
  ): Map<number, { bytesReceived: number; bytesWritten: number }>;
};

type CapturedOptions = {
  abortSignal?: AbortSignal;
  checkpoint?: DownloadCheckpoint<unknown>;
  progressReporter?: ReporterLike;
  timeout?: Record<string, unknown>;
  userAgent?: string;
};

const noRetry: RetryStrategy = () => ({ retry: false });
const resource = "https://example.com/file.bin";
const dest = "/tmp/out.bin";
const chunker: Chunker<string> = () => [];
const resolver = (r: string) => Promise.resolve({ url: new URL(r) });

function makeManager(options?: {
  concurrency?: number;
  bytesPerSecond?: number;
  timeout?: { lookup?: number; connect?: number; stall?: number };
  userAgent?: string;
}) {
  return new DownloadManager({
    concurrency: options?.concurrency ?? 2,
    ...(options?.bytesPerSecond !== undefined ? { bytesPerSecond: options.bytesPerSecond } : {}),
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options?.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortGate(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}

const canceledError = () =>
  new VortexError("Download cancelled", { kind: "user-canceled", skipped: false });
const protocolError = () =>
  new VortexError("Server sent too many bytes", { kind: "http:protocol-violation", url: resource });

function makeCheckpoint(
  overrides: Partial<DownloadCheckpoint<string>> = {},
): DownloadCheckpoint<string> {
  return {
    downloadId: "cp-1",
    resource,
    dest,
    completedRanges: [],
    etag: undefined,
    ...overrides,
  };
}

function abortAwareDownload() {
  downloadMock.mockImplementation(
    async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
      await abortGate(options.abortSignal);
      throw canceledError();
    },
  );
}

beforeEach(() => {
  logMock.mockClear();
  downloadMock.mockReset();
  downloadMock.mockResolvedValue(undefined);
});

describe("DownloadManager.download", () => {
  it("returns a handle that starts running and completes after the download settles", async () => {
    const manager = makeManager();

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);

    expect(handle.promise).toBeInstanceOf(Promise);
    expect(typeof handle.downloadId).toBe("string");
    expect(handle.downloadId.length).toBeGreaterThan(0);
    expect(handle.getState()).toMatchObject({
      status: "running",
      bytesReceived: 0,
      bytesWritten: 0,
      isChunked: false,
    });

    await flush();

    expect(handle.getState()).toMatchObject({ status: "completed" });
    await expect(handle.promise).resolves.toBeUndefined();
  });

  it("forwards resource, dest, strategy and options to the downloader", async () => {
    const manager = makeManager({
      userAgent: "TestAgent",
      timeout: { connect: 1234 },
      bytesPerSecond: 1000,
    });
    let capturedStrategy:
      | { rateLimiter?: unknown; chunker: unknown; resolver: unknown; retry: unknown }
      | undefined;
    let capturedOptions: CapturedOptions | undefined;
    downloadMock.mockImplementation(
      (
        _r: unknown,
        _d: unknown,
        strategy: NonNullable<typeof capturedStrategy>,
        options: CapturedOptions,
      ) => {
        capturedStrategy = strategy;
        capturedOptions = options;
      },
    );

    manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    expect(downloadMock).toHaveBeenCalledWith(
      resource,
      dest,
      expect.objectContaining({ chunker, resolver, retry: noRetry }),
      expect.any(Object),
    );
    expect(capturedStrategy).toMatchObject({ chunker, resolver, retry: noRetry });
    expect(capturedStrategy?.rateLimiter).toBeDefined();
    expect(capturedOptions?.userAgent).toBe("TestAgent");
    expect(capturedOptions?.timeout).toEqual({ lookup: 5000, connect: 1234, stall: 15000 });
    expect(capturedOptions?.checkpoint).toBeUndefined();
  });

  it("exposes the default timeout settings", () => {
    expect(defaultTimeout()).toEqual({ lookup: 5000, connect: 30000, stall: 15000 });
  });

  it("creates a rate limiter only when a positive bandwidth limit is configured", async () => {
    let rateLimiter: unknown;
    downloadMock.mockImplementation(
      (_r: unknown, _d: unknown, strategy: { rateLimiter?: unknown }) => {
        rateLimiter = strategy.rateLimiter;
      },
    );

    makeManager({ bytesPerSecond: 500 }).download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(rateLimiter).toBeDefined();
  });

  it("leaves the rate limiter undefined without a bandwidth limit", async () => {
    let rateLimiter: unknown;
    downloadMock.mockImplementation(
      (_r: unknown, _d: unknown, strategy: { rateLimiter?: unknown }) => {
        rateLimiter = strategy.rateLimiter;
      },
    );

    makeManager().download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(rateLimiter).toBeUndefined();
  });

  it("ignores a zero or NaN bandwidth limit", async () => {
    let rateLimiter: unknown;
    downloadMock.mockImplementation(
      (_r: unknown, _d: unknown, strategy: { rateLimiter?: unknown }) => {
        rateLimiter = strategy.rateLimiter;
      },
    );

    makeManager({ bytesPerSecond: 0 }).download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(rateLimiter).toBeUndefined();

    const nanManager = new DownloadManager({ concurrency: 1, bytesPerSecond: Number.NaN });
    nanManager.download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(rateLimiter).toBeUndefined();
  });

  it("honours a caller-supplied downloadId and replaces a previously tracked one", async () => {
    const manager = makeManager();

    const first = manager.download(resource, dest, resolver, chunker, noRetry, "known-id");
    const second = manager.download(resource, dest, resolver, chunker, noRetry, "known-id");

    expect(first.downloadId).toBe("known-id");
    expect(second.downloadId).toBe("known-id");
    expect(manager.get("known-id")).toBe(second);
    expect(manager.get("known-id")).not.toBe(first);

    await flush();
    await Promise.allSettled([first.promise, second.promise]);
  });

  it("exposes progress and metadata on the state after a successful transfer", async () => {
    const manager = makeManager();
    downloadMock.mockImplementation(
      (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        const reporter = options.progressReporter;
        if (reporter) {
          reporter.etag = "abc123";
          reporter.fileName = "file.bin";
          const progress = reporter.init(200);
          progress.bytesReceived = 200;
          progress.bytesWritten = 200;
        }
      },
    );

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    expect(handle.getState()).toMatchObject({
      status: "completed",
      size: 200,
      fileName: "file.bin",
      bytesReceived: 200,
      bytesWritten: 200,
      isChunked: false,
    });
  });

  it("marks a non-cancellation failure as failed and rejects the promise", async () => {
    const manager = makeManager();
    downloadMock.mockRejectedValue(protocolError());

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    const settled = handle.promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    await flush();

    const state = handle.getState();
    expect(state.status).toBe("failed");
    if (state.status === "failed") {
      expect(state.error.data.kind).toBe("http:protocol-violation");
    }
    await expect(settled).resolves.toMatchObject({ data: { kind: "http:protocol-violation" } });
  });

  it("treats a spontaneous cancellation as canceled without failing the promise", async () => {
    const manager = makeManager();
    downloadMock.mockRejectedValue(canceledError());

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    expect(handle.getState().status).toBe("canceled");
    await expect(handle.promise).resolves.toBeUndefined();
  });

  it("does not log a failure for a spontaneous cancellation", async () => {
    const manager = makeManager();
    downloadMock.mockRejectedValue(canceledError());

    manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    expect(logMock).not.toHaveBeenCalledWith("warn", "download failed", expect.any(Object));
    expect(logMock).not.toHaveBeenCalledWith("debug", "download completed", expect.any(Object));
  });
});

describe("DownloadManager.get / getState", () => {
  it("returns undefined for an unknown download", () => {
    const manager = makeManager();
    expect(manager.get("nope")).toBeUndefined();
    expect(manager.getState("nope")).toBeUndefined();
  });

  it("returns the handle and a state snapshot for a known download", async () => {
    const manager = makeManager();
    const handle = manager.download(resource, dest, resolver, chunker, noRetry);

    expect(manager.get(handle.downloadId)).toBe(handle);
    expect(manager.getState(handle.downloadId)).toEqual(handle.getState());

    await flush();
  });
});

describe("DownloadManager.cancel", () => {
  it("throws for an unknown download", () => {
    const manager = makeManager();
    expect(() => manager.cancel("missing")).toThrow("Unknown download: missing");
  });

  it("cancels a running download, aborts the signal and settles the promise", async () => {
    const manager = makeManager();
    let capturedSignal: AbortSignal | undefined;
    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        capturedSignal = options.abortSignal;
        await abortGate(options.abortSignal);
        throw canceledError();
      },
    );

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(handle.getState().status).toBe("running");

    const state = handle.cancel();

    expect(state.status).toBe("canceled");
    expect(capturedSignal?.aborted).toBe(true);
    await flush();
    expect(handle.getState().status).toBe("canceled");
    await expect(handle.promise).resolves.toBeUndefined();
  });

  it("returns the current state unchanged for a queued download", async () => {
    const manager = makeManager({ concurrency: 1 });
    let startedDownloads = 0;
    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        startedDownloads += 1;
        await abortGate(options.abortSignal);
      },
    );

    manager.download(`${resource}?1`, dest, resolver, chunker, noRetry);
    await flush();
    const second = manager.download(`${resource}?2`, dest, resolver, chunker, noRetry);
    await flush();

    expect(second.getState().status).toBe("queued");

    const state = manager.cancel(second.downloadId);

    expect(state.status).toBe("queued");
    await flush();
    expect(second.getState().status).toBe("queued");
    expect(startedDownloads).toBe(1);
  });
});

describe("DownloadManager.pause", () => {
  it("throws for an unknown download", () => {
    const manager = makeManager();
    expect(() => manager.pause("missing")).toThrow("Unknown download: missing");
  });

  it("pauses a running download and builds an empty checkpoint", async () => {
    const manager = makeManager();
    abortAwareDownload();

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(handle.getState().status).toBe("running");

    const result = await handle.pause();

    expect(result.status).toBe("paused");
    if (result.status === "paused") {
      expect(result.checkpoint.downloadId).toBe(handle.downloadId);
      expect(result.checkpoint.resource).toBe(resource);
      expect(result.checkpoint.dest).toBe(dest);
      expect(result.checkpoint.completedRanges).toEqual([]);
      expect(result.checkpoint.etag).toBeUndefined();
    }
    expect(handle.getState().status).toBe("paused");
  });

  it("includes completed bytes in the checkpoint for a non-chunked download", async () => {
    const manager = makeManager();
    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        const reporter = options.progressReporter;
        if (reporter) {
          reporter.etag = "e1";
          reporter.fileName = "f.bin";
          const progress = reporter.init(100);
          progress.bytesReceived = 40;
          progress.bytesWritten = 40;
        }
        await abortGate(options.abortSignal);
        throw canceledError();
      },
    );

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    const result = await handle.pause();

    expect(result.status).toBe("paused");
    if (result.status === "paused") {
      expect(result.checkpoint).toMatchObject({
        completedRanges: [{ start: 0, end: 40 }],
        etag: "e1",
      });
      expect(result).toMatchObject({
        size: 100,
        fileName: "f.bin",
        bytesWritten: 40,
        bytesReceived: 40,
      });
    }
  });

  it("records only fully written chunks in a chunked checkpoint", async () => {
    const manager = makeManager();
    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        const reporter = options.progressReporter;
        if (reporter) {
          const chunks = [
            { index: 0, range: { start: 0, end: 49 } },
            { index: 1, range: { start: 50, end: 99 } },
          ];
          const progress = reporter.initChunked(chunks, 100);
          const first = progress.get(0);
          const second = progress.get(1);
          if (first && second) {
            first.bytesReceived = 50;
            first.bytesWritten = 50;
            second.bytesReceived = 10;
            second.bytesWritten = 10;
          }
        }
        await abortGate(options.abortSignal);
        throw canceledError();
      },
    );

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    const result = await handle.pause();

    expect(result.status).toBe("paused");
    if (result.status === "paused") {
      expect(result.checkpoint.completedRanges).toEqual([{ start: 0, end: 49 }]);
    }
  });

  it("returns the state unchanged for a queued download", async () => {
    const manager = makeManager({ concurrency: 1 });
    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        await abortGate(options.abortSignal);
      },
    );

    manager.download(`${resource}?1`, dest, resolver, chunker, noRetry);
    await flush();
    const second = manager.download(`${resource}?2`, dest, resolver, chunker, noRetry);
    await flush();

    const result = await second.pause();

    expect(result.status).toBe("queued");
  });

  it("returns the completed state for a download that already finished", async () => {
    const manager = makeManager();
    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    const result = await handle.pause();

    expect(result.status).toBe("completed");
    expect("checkpoint" in result).toBe(false);
  });

  it("returns the failed state with the recorded error", async () => {
    const manager = makeManager();
    downloadMock.mockRejectedValue(protocolError());

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    const settled = handle.promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    await flush();

    const result = await handle.pause();

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.data.kind).toBe("http:protocol-violation");
    }
    await expect(settled).resolves.toMatchObject({ data: { kind: "http:protocol-violation" } });
  });

  it("keeps a paused download paused on the second pause call", async () => {
    const manager = makeManager();
    abortAwareDownload();

    const handle = manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    const first = await handle.pause();
    const second = await handle.pause();

    expect(first.status).toBe("paused");
    expect(second.status).toBe("paused");
  });
});

describe("DownloadManager.resume", () => {
  it("delegates to the downloader with the stored checkpoint and downloadId", async () => {
    const manager = makeManager();
    const checkpoint = makeCheckpoint();

    const handle = manager.resume(checkpoint, resolver, chunker, noRetry);

    expect(handle.downloadId).toBe("cp-1");
    expect(manager.get("cp-1")).toBe(handle);
    expect(downloadMock).toHaveBeenCalledWith(
      checkpoint.resource,
      checkpoint.dest,
      expect.objectContaining({ chunker, resolver, retry: noRetry }),
      expect.objectContaining({ checkpoint }),
    );

    await flush();
    expect(handle.getState().status).toBe("completed");
  });
});

describe("DownloadManager queue accounting", () => {
  it("is idle after downloads settle", async () => {
    const manager = makeManager();
    manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();

    expect(manager.numPending).toBe(0);
    expect(manager.numRunning).toBe(0);
  });

  it("limits concurrency and exposes queue occupancy", async () => {
    const manager = makeManager({ concurrency: 1 });
    const started: number[] = [];
    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        started.push(started.length + 1);
        await abortGate(options.abortSignal);
        throw canceledError();
      },
    );

    const first = manager.download(resource, dest, resolver, chunker, noRetry, "one");
    await flush();
    const second = manager.download(resource, dest, resolver, chunker, noRetry, "two");
    await flush();

    expect(started).toEqual([1]);
    expect(manager.numRunning).toBe(1);
    expect(manager.numPending).toBe(1);
    expect(first.getState().status).toBe("running");
    expect(second.getState().status).toBe("queued");

    manager.cancel("one");
    await flush();
    await flush();

    expect(started).toEqual([1, 2]);
    expect(manager.numRunning).toBe(1);
    expect(second.getState().status).toBe("running");

    manager.cancel("two");
    await flush();
    await flush();

    expect(manager.numRunning).toBe(0);
    expect(manager.numPending).toBe(0);
  });
});

describe("DownloadManager.configure", () => {
  it("logs a concurrency change", () => {
    const manager = makeManager({ concurrency: 1 });
    manager.configure({ concurrency: 3 });

    expect(logMock).toHaveBeenCalledWith("info", "download concurrency changed", {
      from: 1,
      to: 3,
    });
  });

  it("raises the number of concurrently running downloads", async () => {
    const manager = makeManager({ concurrency: 1 });
    manager.configure({ concurrency: 3 });

    downloadMock.mockImplementation(
      async (_r: unknown, _d: unknown, _s: unknown, options: CapturedOptions) => {
        await abortGate(options.abortSignal);
        throw canceledError();
      },
    );

    manager.download(resource, dest, resolver, chunker, noRetry, "one");
    manager.download(resource, dest, resolver, chunker, noRetry, "two");
    await flush();

    expect(manager.numRunning).toBe(2);

    manager.cancel("one");
    manager.cancel("two");
    await flush();
    await flush();
  });

  it("applies and removes the bandwidth limit at runtime", async () => {
    const manager = makeManager();
    let rateLimiter: unknown;
    downloadMock.mockImplementation(
      (_r: unknown, _d: unknown, strategy: { rateLimiter?: unknown }) => {
        rateLimiter = strategy.rateLimiter;
      },
    );

    manager.configure({ bytesPerSecond: 500 });
    manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(rateLimiter).toBeDefined();

    logMock.mockClear();
    manager.configure({ bytesPerSecond: 0 });
    manager.download(resource, dest, resolver, chunker, noRetry);
    await flush();
    expect(rateLimiter).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith("info", "download bandwidth limit removed");
  });
});
