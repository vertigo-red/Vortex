import { VortexError } from "@vortex/shared";
import type { Chunk, Chunker, ResolvedEndpoint, Resolver } from "@vortex/shared/download";
import { TimeoutError } from "got";
import type { RateLimiter } from "limiter";
import type { CookieJar } from "tough-cookie";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { defaultChunkConcurrency, download, type Checkpoint } from "./downloader";
import { ProgressReporter } from "./progress";

const resource = "http://example.test/file.bin";
const dest = "/tmp/out.bin";
const endpointUrl = new URL("https://cdn.example.test/file.bin");
const endpoint: ResolvedEndpoint = { url: endpointUrl };

const resolver: Resolver<string> = (_resource: string) => Promise.resolve({ url: endpointUrl });
const chunker: Chunker<string> = () => [];

const gotMock = vi.hoisted(() => ({
  extend: vi.fn(),
  head: vi.fn(),
  stream: vi.fn(),
}));
const fsMock = vi.hoisted(() => ({
  access: vi.fn(),
  open: vi.fn(),
}));

vi.mock("got", () => {
  class HTTPError extends Error {
    response: { statusCode: number };
    constructor(message?: string) {
      super(message ?? "HTTP error");
      this.response = { statusCode: 0 };
    }
  }
  class RequestError extends Error {
    constructor(message?: string) {
      super(message ?? "Request error");
    }
  }
  class TimeoutError extends Error {
    constructor(message?: string) {
      super(message ?? "Timeout");
    }
  }
  class AbortError extends Error {}

  const session = { head: gotMock.head, stream: gotMock.stream };
  gotMock.extend.mockReturnValue(session);

  return {
    default: { extend: gotMock.extend },
    HTTPError,
    RequestError,
    TimeoutError,
    AbortError,
  };
});

vi.mock("node:fs/promises", () => ({
  access: fsMock.access,
  open: fsMock.open,
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

  const NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPROTO",
  ]);

  const parseError = (
    cause: unknown,
    context?: { path?: string; url?: string },
    getMessage?: (values: {
      data: Record<string, unknown>;
      isTransient: boolean;
    }) => string | undefined,
  ): MockVortexError => {
    if (cause instanceof MockVortexError) return cause;
    if (!(cause instanceof Error)) {
      return new MockVortexError(`Unknown value thrown as error. Type=${typeof cause}`, {
        kind: "unknown",
      });
    }

    const { code, errno, syscall } = cause as { code?: string; errno?: number; syscall?: string };
    if (code !== undefined) {
      const path = context?.path ?? (cause as { path?: string }).path ?? "<unknown path>";
      const osData =
        errno !== undefined && syscall !== undefined
          ? { originalCode: code, errno, syscall }
          : { originalCode: code };

      let data: Record<string, unknown> | undefined;
      let isTransient = false;

      if (code === "ENOENT") {
        data = { kind: "fs:not-found", ...osData, path };
      } else if (code === "EACCES" || code === "EPERM") {
        if (context?.path !== undefined) {
          data = { kind: "fs:no-permissions", ...osData, path };
        }
      } else if (code === "ENOSPC") {
        data = { kind: "fs:no-space", ...osData, path };
      } else if (code === "EEXIST") {
        data = { kind: "fs:already-exists", ...osData, path };
      } else if (code === "ENOTDIR") {
        data = { kind: "fs:not-a-directory", ...osData, path };
      } else if (code === "EISDIR") {
        data = { kind: "fs:not-a-file", ...osData, path };
      } else if (code === "EMFILE" || code === "EBUSY") {
        data = { kind: "os:generic", ...osData };
        isTransient = true;
      } else if (NETWORK_CODES.has(code)) {
        isTransient = code === "ETIMEDOUT";
        data =
          context?.url !== undefined
            ? { kind: "http:generic", url: context.url, ...osData }
            : { kind: "os:generic", ...osData };
      }

      if (data !== undefined) {
        const message = getMessage?.({ data, isTransient }) ?? cause.message;
        return new MockVortexError(message, data, { cause, isTransient });
      }
    }

    return new MockVortexError(
      `Unknown error thrown: ${cause.name} ${cause.message}`,
      {
        kind: "unknown",
      },
      { cause },
    );
  };

  const getErrorCode = (err: unknown): string | null =>
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;

  const unknownToError = (err: unknown): Error =>
    err instanceof Error ? err : new Error(String(err));

  return { VortexError: MockVortexError, parseError, getErrorCode, unknownToError };
});

type MockFn = Mock<(...args: any[]) => any>;
type FakeStream = {
  requestUrl: URL;
  on(_event: string, _listener: () => void): FakeStream;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer, void, unknown>;
};
type FakeFd = {
  truncate: MockFn;
  write: MockFn;
  close: MockFn;
};

function fakeStream(
  buffers: Buffer[],
  overrides: { requestUrl?: URL; error?: unknown } = {},
): FakeStream {
  const stream: FakeStream = {
    requestUrl: overrides.requestUrl ?? endpointUrl,
    on: () => stream,
    async *[Symbol.asyncIterator]() {
      for (const buffer of buffers) {
        await Promise.resolve();
        yield buffer;
      }
      if (overrides.error !== undefined) {
        throw overrides.error;
      }
    },
  };
  return stream;
}

function makeFd(overrides: Partial<FakeFd> = {}): FakeFd {
  return {
    truncate: vi.fn(() => Promise.resolve()),
    write: vi.fn((_buffer: Buffer, _offset: number, len: number, _position: number) =>
      Promise.resolve({ bytesWritten: len }),
    ),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function primeFd(fd?: FakeFd): FakeFd {
  const handle = fd ?? makeFd();
  fsMock.open.mockImplementation(() => Promise.resolve(handle));
  return handle;
}

function primeHead(headers: Record<string, string | undefined>): void {
  gotMock.head.mockResolvedValue({ headers });
}

function primeStream(
  buffers: Buffer[],
  overrides: { requestUrl?: URL; error?: unknown } = {},
): void {
  gotMock.stream.mockImplementation(() => fakeStream(buffers, overrides));
}

function instanceOf(proto: object, message: string): Error {
  return Object.assign(Object.create(proto), { message });
}

function makeRateLimiter(bucketSize: number): {
  tokenBucket: { bucketSize: number };
  removeTokens: MockFn;
} {
  return {
    tokenBucket: { bucketSize },
    removeTokens: vi.fn((tokens: number) => Promise.resolve(tokens)),
  };
}

function twiceChunks(_size: number, _resource: string): Chunk[] {
  return [
    { index: 0, range: { start: 0, end: 49 } },
    { index: 1, range: { start: 50, end: 99 } },
  ];
}

beforeEach(() => {
  gotMock.extend.mockClear();
  gotMock.head.mockReset();
  gotMock.stream.mockReset();
  fsMock.access.mockReset();
  fsMock.open.mockReset();

  fsMock.access.mockResolvedValue(undefined);
  fsMock.open.mockImplementation(() => Promise.resolve(makeFd()));
  gotMock.head.mockResolvedValue({
    headers: { "content-length": "100", "accept-ranges": "bytes" },
  });
  gotMock.stream.mockImplementation(() => fakeStream([Buffer.alloc(100)]));
});

describe("download() setup", () => {
  it("throws user-canceled before touching anything when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolverSpy = vi.fn((_r: string) => Promise.resolve({ url: endpointUrl }));

    await expect(
      download(
        resource,
        dest,
        { resolver: resolverSpy, chunker },
        { abortSignal: controller.signal },
      ),
    ).rejects.toMatchObject({ data: { kind: "user-canceled", skipped: false } });

    expect(resolverSpy).not.toHaveBeenCalled();
    expect(gotMock.extend).not.toHaveBeenCalled();
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("wraps resolver failures as download:resolver-error with the cause", async () => {
    const cause = new Error("boom");
    const failing = vi.fn((_r: string) => Promise.reject(cause));

    await expect(download(resource, dest, { resolver: failing, chunker })).rejects.toMatchObject({
      message: "Resolver failed",
      data: { kind: "download:resolver-error" },
      cause,
    });
  });

  it("builds a got session carrying user agent, signal, cookie jar and mapped timeouts", async () => {
    const cookieJar = {} as CookieJar;
    const controller = new AbortController();

    await download(
      resource,
      dest,
      { resolver, chunker },
      {
        cookieJar,
        abortSignal: controller.signal,
        timeout: { lookup: 1000, connect: 2000, stall: 5000 },
        userAgent: "Vortex/Test",
      },
    );

    expect(gotMock.extend).toHaveBeenCalledTimes(1);
    expect(gotMock.extend).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieJar,
        signal: controller.signal,
        timeout: { lookup: 1000, connect: 2000, secureConnect: 2000, socket: 5000, response: 5000 },
        retry: { limit: 0 },
        headers: { "User-Agent": "Vortex/Test" },
      }),
    );
  });

  it("passes no session options when none are provided", async () => {
    await download(resource, dest, { resolver, chunker });

    expect(gotMock.extend).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieJar: undefined,
        signal: undefined,
        timeout: undefined,
        retry: { limit: 0 },
        headers: { "User-Agent": undefined },
      }),
    );
  });

  it("opens the destination with w+ for a fresh download without truncating", async () => {
    primeHead({ "content-length": "2" });
    primeStream([Buffer.from("ab")]);
    const fd = primeFd();

    await download(resource, dest, { resolver, chunker });

    expect(fsMock.open).toHaveBeenCalledWith(dest, "w+");
    expect(fd.truncate).not.toHaveBeenCalled();
    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({ headers: expect.objectContaining({ Range: undefined }) }),
    );
  });

  it("drops the checkpoint when the destination file is missing", async () => {
    const checkpoint: Checkpoint = { etag: "old", completedRanges: [{ start: 0, end: 39 }] };
    fsMock.access.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
    );
    const fd = primeFd();

    await download(resource, dest, { resolver, chunker }, { checkpoint });

    expect(fsMock.open).toHaveBeenCalledWith(dest, "w+");
    expect(fd.truncate).not.toHaveBeenCalled();
    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Range: undefined, "If-Match": undefined }),
      }),
    );
  });

  it("keeps the checkpoint and truncates to the probe size when the file exists", async () => {
    const checkpoint: Checkpoint = { etag: "v1", completedRanges: [{ start: 0, end: 39 }] };
    primeHead({ "content-length": "100", "accept-ranges": "bytes", etag: "v1" });
    primeStream([Buffer.alloc(60)]);
    const fd = primeFd();

    await download(resource, dest, { resolver, chunker }, { checkpoint });

    expect(fsMock.open).toHaveBeenCalledWith(dest, "r+");
    expect(fd.truncate).toHaveBeenCalledWith(100);
  });

  it("keeps the checkpoint for a non-ENOENT access failure", async () => {
    const checkpoint: Checkpoint = { etag: "v1", completedRanges: [] };
    fsMock.access.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );

    await download(resource, dest, { resolver, chunker }, { checkpoint });

    expect(fsMock.open).toHaveBeenCalledWith(dest, "r+");
  });
});

describe("download() probe (HEAD)", () => {
  it("throws download:is-html when the server returns an HTML page", async () => {
    const chunkerSpy = vi.fn(() => []);
    primeHead({ "content-type": "text/html", "content-length": "123" });

    await expect(download(resource, dest, { resolver, chunker: chunkerSpy })).rejects.toMatchObject(
      {
        data: { kind: "download:is-html", url: endpointUrl.toString() },
      },
    );
    expect(chunkerSpy).not.toHaveBeenCalled();
  });

  it("throws http:protocol-violation when the ETag diverges from the checkpoint", async () => {
    const checkpoint: Checkpoint = { etag: "old", completedRanges: [] };
    primeHead({ "content-length": "100", etag: "new" });

    await expect(
      download(resource, dest, { resolver, chunker }, { checkpoint }),
    ).rejects.toMatchObject({
      data: { kind: "http:protocol-violation", url: endpointUrl.toString() },
    });
  });

  it("records etag, fileName and size from the probe onto the reporter", async () => {
    const reporter = new ProgressReporter();
    primeHead({
      "content-length": "123",
      "accept-ranges": "bytes",
      etag: '"e1"',
      "content-disposition": 'attachment; filename="file.bin"',
    });
    primeStream([Buffer.alloc(123)]);

    await download(resource, dest, { resolver, chunker }, { progressReporter: reporter });

    expect(reporter.etag).toBe('"e1"');
    expect(reporter.fileName).toBe("file.bin");
    expect(reporter.size).toBe(123);
  });

  it("prefers filename* over filename and falls back to the URL basename", async () => {
    const firstReporter = new ProgressReporter();
    primeHead({
      "content-length": "5",
      "content-disposition": "attachment; filename=\"plain.bin\"; filename*=UTF-8''caf%C3%A9.bin",
    });
    primeStream([Buffer.alloc(5)]);

    await download(resource, dest, { resolver, chunker }, { progressReporter: firstReporter });
    expect(firstReporter.fileName).toBe("caf\u00e9.bin");

    const zipResolver: Resolver<string> = (_r: string) =>
      Promise.resolve({ url: new URL("https://cdn.example.test/archives/2017.zip") });
    const secondReporter = new ProgressReporter();
    primeHead({ "content-length": "5" });
    primeStream([Buffer.alloc(5)]);

    await download(
      resource,
      dest,
      { resolver: zipResolver, chunker },
      { progressReporter: secondReporter },
    );
    expect(secondReporter.fileName).toBe("2017.zip");
  });

  it("does not invoke the chunker when the server rejects range requests", async () => {
    const chunkerSpy = vi.fn(() => []);
    primeHead({ "content-length": "100" });
    primeStream([Buffer.alloc(100)]);

    await download(resource, dest, { resolver, chunker: chunkerSpy });

    expect(chunkerSpy).not.toHaveBeenCalled();
  });

  it("does not invoke the chunker when the size is unknown", async () => {
    const chunkerSpy = vi.fn((_size: number, _resource: string) => []);
    primeHead({});
    primeStream([Buffer.alloc(9)]);

    await download(resource, dest, { resolver, chunker: chunkerSpy });

    expect(chunkerSpy).not.toHaveBeenCalled();
  });

  it("maps probe failures through toNetworkError (timeout)", async () => {
    primeHeadRejected(instanceOf(TimeoutError.prototype, "boom"));

    await expect(download(resource, dest, { resolver, chunker })).rejects.toMatchObject({
      data: { kind: "http:timeout", url: endpointUrl.toString() },
    });
  });

  it("wraps a probe cancellation as user-canceled", async () => {
    primeHeadRejected(new DOMException("Aborted", "AbortError"));

    await expect(download(resource, dest, { resolver, chunker })).rejects.toMatchObject({
      data: { kind: "user-canceled", skipped: false },
    });
  });
});

describe("download() single-stream transfer", () => {
  it("writes yielded buffers at offset 0 and reports progress", async () => {
    const reporter = new ProgressReporter();
    primeHead({ "content-length": "6", "accept-ranges": "bytes" });
    primeStream([Buffer.from("abc"), Buffer.from("def")]);
    const fd = primeFd();

    await download(resource, dest, { resolver, chunker }, { progressReporter: reporter });

    expect(fd.write).toHaveBeenCalledTimes(2);
    expect(fd.write).toHaveBeenCalledWith(expect.any(Buffer), 0, 3, 0);
    expect(fd.close).toHaveBeenCalled();
    expect(reporter.getProgress()).toMatchObject({
      size: 6,
      isChunked: false,
      bytesReceived: 6,
      bytesWritten: 6,
    });
  });

  it("rethrows VortexError failures from the stream unchanged", async () => {
    const failing = new VortexError("boom", {
      kind: "download:is-html",
      url: endpointUrl.toString(),
    });
    primeStream([Buffer.alloc(4)], { error: failing });

    await expect(download(resource, dest, { resolver, chunker })).rejects.toMatchObject({
      data: { kind: "download:is-html" },
    });
  });

  it("maps network stream failures through toNetworkError with the request URL", async () => {
    const ec = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      errno: -104,
      syscall: "read",
    });
    primeStream([], { error: ec });
    const fd = primeFd();

    await expect(download(resource, dest, { resolver, chunker })).rejects.toMatchObject({
      data: {
        kind: "http:generic",
        url: endpointUrl.toString(),
        originalCode: "ECONNRESET",
      },
    });
    expect(fd.close).toHaveBeenCalled();
  });

  it("wraps open() failures via parseError with the destination path", async () => {
    primeHead({ "content-length": "2" });
    fsMock.open.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, open"), {
        code: "EACCES",
        errno: -13,
        syscall: "open",
      }),
    );

    await expect(download(resource, dest, { resolver, chunker })).rejects.toMatchObject({
      message: `Failed to open ${dest}`,
      data: { kind: "fs:no-permissions", originalCode: "EACCES", path: dest },
    });
  });

  it("wraps write() failures via parseError with the file path", async () => {
    primeStream([Buffer.from("abc")]);
    const fd = primeFd(
      makeFd({
        write: vi.fn(() =>
          Promise.reject(
            Object.assign(new Error("ENOSPC: no space left on device"), {
              code: "ENOSPC",
              errno: -28,
              syscall: "write",
            }),
          ),
        ),
      }),
    );

    await expect(download(resource, dest, { resolver, chunker })).rejects.toMatchObject({
      message: `Failed to write to ${dest}`,
      data: { kind: "fs:no-space", path: dest },
    });
    expect(fd.close).toHaveBeenCalled();
  });
});

describe("download() resume from checkpoint", () => {
  it("resumes from a contiguous checkpoint using a Range header and If-Match", async () => {
    const checkpoint: Checkpoint = { etag: '"v1"', completedRanges: [{ start: 0, end: 39 }] };
    const reporter = new ProgressReporter();
    primeHead({ "content-length": "100", "accept-ranges": "bytes", etag: '"v1"' });
    primeStream([Buffer.alloc(60)]);
    const fd = primeFd();

    await download(
      resource,
      dest,
      { resolver, chunker },
      { checkpoint, progressReporter: reporter },
    );

    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Range: "bytes=40-99", "If-Match": '"v1"' }),
      }),
    );
    expect(fd.write).toHaveBeenCalledWith(expect.any(Buffer), 0, 60, 40);
    expect(reporter.getProgress()).toMatchObject({ bytesReceived: 100, bytesWritten: 100 });
  });

  it("extends the baseline across multiple contiguous ranges", async () => {
    const checkpoint: Checkpoint = {
      etag: undefined,
      completedRanges: [
        { start: 0, end: 9 },
        { start: 10, end: 19 },
      ],
    };
    primeStream([Buffer.alloc(80)]);

    await download(resource, dest, { resolver, chunker }, { checkpoint });

    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Range: "bytes=20-99" }),
      }),
    );
  });

  it("stops the baseline at the first gap in completed ranges", async () => {
    const checkpoint: Checkpoint = {
      etag: undefined,
      completedRanges: [
        { start: 0, end: 9 },
        { start: 20, end: 29 },
      ],
    };
    primeStream([Buffer.alloc(90)]);

    await download(resource, dest, { resolver, chunker }, { checkpoint });

    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Range: "bytes=10-99" }),
      }),
    );
  });

  it("sends no If-Match for a weak ETag on the resume request", async () => {
    const checkpoint: Checkpoint = { etag: 'W/"weak"', completedRanges: [] };
    primeHead({ "content-length": "100", etag: 'W/"weak"' });
    primeStream([Buffer.alloc(100)]);

    await download(resource, dest, { resolver, chunker }, { checkpoint });

    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({ headers: expect.objectContaining({ "If-Match": undefined }) }),
    );
  });
});

describe("download() protocol violations", () => {
  it("rejects when a chunk stream sends more bytes than its range", async () => {
    primeHead({ "content-length": "100", "accept-ranges": "bytes" });
    primeStream([Buffer.alloc(51)]);

    await expect(
      download(resource, dest, { resolver, chunker: twiceChunks }),
    ).rejects.toMatchObject({
      data: { kind: "http:protocol-violation", url: endpointUrl.toString() },
    });
  });
});

describe("download() chunked transfer", () => {
  it("downloads each chunk at its start offset and reports chunk progress", async () => {
    const reporter = new ProgressReporter();
    const chunkedResolver: Resolver<string> = (_r: string) =>
      Promise.resolve({
        probeEndpoint: endpoint,
        chunkEndpoint: (chunk: Chunk) =>
          Promise.resolve({ url: new URL(`https://chunks.example.test/${chunk.index}`) }),
      });
    primeHead({ "content-length": "100", "accept-ranges": "bytes" });
    gotMock.stream.mockImplementation(() => fakeStream([Buffer.alloc(50)]));
    const fd = primeFd();

    await download(
      resource,
      dest,
      { resolver: chunkedResolver, chunker: twiceChunks },
      { progressReporter: reporter },
    );

    expect(gotMock.head).toHaveBeenCalledWith(endpointUrl, expect.any(Object));
    expect(gotMock.stream).toHaveBeenCalledWith(
      new URL("https://chunks.example.test/0"),
      expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=0-49" }) }),
    );
    expect(gotMock.stream).toHaveBeenCalledWith(
      new URL("https://chunks.example.test/1"),
      expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=50-99" }) }),
    );
    expect(fd.write).toHaveBeenCalledWith(expect.any(Buffer), 0, 50, 0);
    expect(fd.write).toHaveBeenCalledWith(expect.any(Buffer), 0, 50, 50);

    const progress = reporter.getProgress();
    expect(progress.isChunked).toBe(true);
    if (progress.isChunked) {
      expect(progress.chunks).toHaveLength(2);
      expect(progress.bytesReceived).toBe(100);
    }
  });

  it("skips already-completed ranges and fast-forwards their progress", async () => {
    const reporter = new ProgressReporter();
    const checkpoint: Checkpoint = {
      etag: undefined,
      completedRanges: [{ start: 0, end: 49 }],
    };
    primeHead({ "content-length": "100", "accept-ranges": "bytes" });
    primeStream([Buffer.alloc(50)]);
    primeFd();

    await download(
      resource,
      dest,
      { resolver, chunker: twiceChunks },
      { checkpoint, progressReporter: reporter },
    );

    expect(gotMock.stream).toHaveBeenCalledTimes(1);
    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=50-99" }) }),
    );
    const progress = reporter.getProgress();
    if (progress.isChunked) {
      expect(progress.chunks).toHaveLength(2);
      const [first] = progress.chunks;
      expect(first).toMatchObject({
        chunkRange: { start: 0, end: 49 },
        bytesReceived: 50,
        bytesWritten: 50,
      });
    }
  });

  it("skips all transfers when every chunk is already complete", async () => {
    const reporter = new ProgressReporter();
    const checkpoint: Checkpoint = {
      etag: undefined,
      completedRanges: [
        { start: 0, end: 49 },
        { start: 50, end: 99 },
      ],
    };
    primeHead({ "content-length": "100", "accept-ranges": "bytes" });
    const fd = primeFd();

    await download(
      resource,
      dest,
      { resolver, chunker: twiceChunks },
      { checkpoint, progressReporter: reporter },
    );

    expect(gotMock.stream).not.toHaveBeenCalled();
    expect(fd.truncate).toHaveBeenCalledWith(100);
  });

  it("uses the plain single-stream path when chunking produces a single chunk", async () => {
    const oneChunk: Chunker<string> = () => [{ index: 0, range: { start: 0, end: 99 } }];
    const guardedResolver: Resolver<string> = () =>
      Promise.resolve({
        probeEndpoint: endpoint,
        chunkEndpoint: () => Promise.reject(new Error("chunk endpoint must not be called")),
      });
    primeHead({ "content-length": "100", "accept-ranges": "bytes" });
    primeStream([Buffer.alloc(100)]);

    await download(resource, dest, { resolver: guardedResolver, chunker: oneChunk });

    expect(gotMock.stream).toHaveBeenCalledTimes(1);
    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({ headers: expect.objectContaining({ Range: undefined }) }),
    );
  });

  it("forwards endpoint headers into probe and chunk requests", async () => {
    const authedResolver: Resolver<string> = (_r: string) =>
      Promise.resolve({
        url: endpointUrl,
        headers: { Authorization: "Bearer xyz" },
      });
    primeStream([Buffer.alloc(10)]);

    await download(resource, dest, { resolver: authedResolver, chunker });

    expect(gotMock.head).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer xyz" }),
      }),
    );
    expect(gotMock.stream).toHaveBeenCalledWith(
      endpointUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer xyz" }),
      }),
    );
  });

  it("wraps a chunk interrupted by cancellation as user-canceled", async () => {
    let streamCalls = 0;
    gotMock.stream.mockImplementation(() => {
      streamCalls += 1;
      return streamCalls === 1
        ? fakeStream([Buffer.alloc(50)])
        : fakeStream([], { error: new DOMException("Aborted", "AbortError") });
    });
    primeHead({ "content-length": "100", "accept-ranges": "bytes" });
    primeFd();

    await expect(
      download(resource, dest, { resolver, chunker: twiceChunks }),
    ).rejects.toMatchObject({ data: { kind: "user-canceled", skipped: false } });
  });
});

describe("download() rate limiting", () => {
  it("consumes rate limiter tokens for every received buffer", async () => {
    const limiter = makeRateLimiter(10);
    primeStream([Buffer.alloc(10), Buffer.alloc(3)]);

    await download(resource, dest, {
      resolver,
      chunker,
      rateLimiter: limiter as unknown as RateLimiter,
    });

    expect(limiter.removeTokens).toHaveBeenCalledWith(10);
    expect(limiter.removeTokens).toHaveBeenCalledWith(3);
  });

  it("splits large buffers at the token bucket size", async () => {
    const limiter = makeRateLimiter(10);
    primeStream([Buffer.alloc(25)]);

    await download(resource, dest, {
      resolver,
      chunker,
      rateLimiter: limiter as unknown as RateLimiter,
    });

    expect(limiter.removeTokens.mock.calls.map((call) => call[0])).toEqual([10, 10, 5]);
  });
});

it("exposes the default chunk concurrency", () => {
  expect(defaultChunkConcurrency).toBe(4);
});

function primeHeadRejected(error: unknown): void {
  gotMock.head.mockRejectedValue(error);
}
