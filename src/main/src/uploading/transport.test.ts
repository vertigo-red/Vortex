import type { RetryStrategy } from "@vortex/shared/download";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createSession, postBody, putFile, uploadFile } from "./transport";

type FakeUploadEvent = { transferred: number };
type FakeRequest = Promise<unknown> & {
  on(event: "uploadProgress", listener: (arg: FakeUploadEvent) => void): FakeRequest;
};
type RequestOptions = { method: string; body: unknown; headers: Record<string, string> };
type RequestFn = (url: string, options: RequestOptions) => FakeRequest;
type ExtendFn = (options: unknown) => unknown;
type WithRetryFn = (
  attempt: () => Promise<unknown>,
  retry: RetryStrategy,
  abortSignal?: AbortSignal,
) => Promise<unknown>;
type IsCancellationFn = (err: unknown) => boolean;
type ToUploadErrorFn = (
  url: string,
  err: unknown,
) => {
  message: string;
  data: { kind: string; statusCode?: number };
};
type MissingSignedHeadersFn = (url: string, sent: Iterable<string>) => string[];
type DescribePresignedUrlFn = (url: string) => Record<string, unknown>;
type CreateGotTimeoutOptionsFn = () => Record<string, boolean>;
type Stream = { destroy: Mock<() => void> };

const gotMock = vi.hoisted<{ extend: Mock<ExtendFn> }>(() => {
  const callable = vi.fn();
  Object.assign(callable, { extend: vi.fn() });
  return callable as unknown as { extend: Mock<ExtendFn> };
});
const fsMock = vi.hoisted(() => ({
  createReadStream: vi.fn<(path: string, options?: { start?: number; end?: number }) => Stream>(),
}));
const logMock = vi.hoisted(() => ({
  log: vi.fn<(level: string, message: string, meta: Record<string, unknown>) => void>(),
}));
const transferRetryMock = vi.hoisted(() => ({
  withRetry: vi.fn<WithRetryFn>(),
  defaultRetryStrategy: vi.fn<() => RetryStrategy>(),
}));
const cancellationMock = vi.hoisted(() => ({
  isCancellation: vi.fn<IsCancellationFn>(),
}));
const timeoutsMock = vi.hoisted(() => ({
  createGotTimeoutOptions: vi.fn<CreateGotTimeoutOptionsFn>(),
}));
const errorsMock = vi.hoisted(() => ({
  redactUrl: vi.fn<(url: string) => string>(),
  missingSignedHeaders: vi.fn<MissingSignedHeadersFn>(),
  describePresignedUrl: vi.fn<DescribePresignedUrlFn>(),
  toUploadError: vi.fn<ToUploadErrorFn>(),
}));

vi.mock("node:fs", () => fsMock);
vi.mock("got", () => ({ default: gotMock }));
vi.mock("../logging", () => logMock);
vi.mock("../transfer/cancellation", () => cancellationMock);
vi.mock("../transfer/retry", () => transferRetryMock);
vi.mock("../transfer/timeouts", () => timeoutsMock);
vi.mock("./errors", () => errorsMock);

const requestFn = vi.fn<RequestFn>();
const retrySentinel = {} as RetryStrategy;
const mappedUploadError = { message: "mapped", data: { kind: "http:bad-status", statusCode: 403 } };

type FakeHandle = {
  request: FakeRequest;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  upload: (transferred: number) => void;
};

function makeFakeHandle(): FakeHandle {
  let resolve: (value: unknown) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  let uploadListener: ((arg: FakeUploadEvent) => void) | undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const request = Object.assign(promise, {
    on(event: "uploadProgress", listener: (arg: FakeUploadEvent) => void) {
      if (event === "uploadProgress") {
        uploadListener = listener;
      }
      return request;
    },
  });
  return {
    request,
    resolve,
    reject,
    upload: (transferred: number) => {
      uploadListener?.({ transferred });
    },
  };
}

let handles: FakeHandle[] = [];
let streams: Stream[] = [];

function nthHandle(index: number): FakeHandle {
  const handle = handles[index];
  if (handle === undefined) {
    throw new Error(`no request handle at index ${index}`);
  }
  return handle;
}

function nthStream(index: number): Stream {
  const stream = streams[index];
  if (stream === undefined) {
    throw new Error(`no stream at index ${index}`);
  }
  return stream;
}

beforeEach(() => {
  handles = [];
  streams = [];
  gotMock.extend.mockReset();
  gotMock.extend.mockReturnValue(requestFn);
  requestFn.mockReset();
  requestFn.mockImplementation(() => {
    const handle = makeFakeHandle();
    handles.push(handle);
    return handle.request;
  });
  fsMock.createReadStream.mockReset();
  fsMock.createReadStream.mockImplementation(() => {
    const stream = { destroy: vi.fn<() => void>() };
    streams.push(stream);
    return stream;
  });
  transferRetryMock.withRetry.mockReset();
  transferRetryMock.withRetry.mockImplementation((attempt) => attempt());
  transferRetryMock.defaultRetryStrategy.mockReset();
  transferRetryMock.defaultRetryStrategy.mockReturnValue(retrySentinel);
  cancellationMock.isCancellation.mockReset();
  cancellationMock.isCancellation.mockReturnValue(false);
  timeoutsMock.createGotTimeoutOptions.mockReset();
  timeoutsMock.createGotTimeoutOptions.mockReturnValue({ fakeTimeout: true });
  errorsMock.redactUrl.mockReset();
  errorsMock.redactUrl.mockImplementation((url) => url);
  errorsMock.missingSignedHeaders.mockReset();
  errorsMock.missingSignedHeaders.mockReturnValue([]);
  errorsMock.describePresignedUrl.mockReset();
  errorsMock.describePresignedUrl.mockReturnValue({});
  errorsMock.toUploadError.mockReset();
  errorsMock.toUploadError.mockReturnValue(mappedUploadError);
  logMock.log.mockReset();
});

describe("createSession", () => {
  it("extends got with upload defaults and keeps the shared retry strategy", () => {
    const controller = new AbortController();

    const session = createSession({ userAgent: "vortex/1.0", abortSignal: controller.signal });

    expect(gotMock.extend.mock.calls[0]?.[0]).toEqual({
      signal: controller.signal,
      timeout: { fakeTimeout: true },
      retry: { limit: 0 },
      headers: { "User-Agent": "vortex/1.0" },
    });
    expect(session.retry).toBe(retrySentinel);
    expect(transferRetryMock.defaultRetryStrategy).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit retry strategy and custom session headers", () => {
    const strategy = {} as RetryStrategy;
    const headers = { contentType: "application/x-msdownload" };

    const session = createSession({ retry: strategy, headers });

    expect(session.retry).toBe(strategy);
    expect(session.headers).toEqual(headers);
    expect(transferRetryMock.defaultRetryStrategy).not.toHaveBeenCalled();
  });
});

describe("putFile", () => {
  it("streams the whole file via PUT and clamps progress at the file size", async () => {
    const session = createSession();
    const onProgress = vi.fn<(transferred: number) => void>();

    const p = putFile(
      session,
      "https://s3.example.com/up",
      "/tmp/f.bin",
      100,
      "whole file",
      undefined,
      onProgress,
    );
    nthHandle(0).upload(40);
    nthHandle(0).resolve({ statusCode: 200 });

    await expect(p).resolves.toMatchObject({ statusCode: 200 });
    expect(fsMock.createReadStream.mock.calls).toEqual([["/tmp/f.bin", undefined]]);
    expect(requestFn.mock.calls[0]?.[0]).toBe("https://s3.example.com/up");
    const options = requestFn.mock.calls[0]?.[1];
    expect(options?.method).toBe("PUT");
    expect(options?.headers).toEqual({
      "content-type": "application/octet-stream",
      "content-length": "100",
    });
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([40, 100]);
  });

  it("streams only the requested byte range with the caller's headers", async () => {
    const session = createSession({
      headers: { contentType: "application/x-msdownload", contentDisposition: "attachment" },
    });

    const p = putFile(session, "https://s3.example.com/up", "/tmp/f.bin", 70, "part 1/1", {
      start: 10,
      end: 80,
    });
    nthHandle(0).resolve({ statusCode: 200 });

    await p;
    expect(fsMock.createReadStream.mock.calls).toEqual([["/tmp/f.bin", { start: 10, end: 79 }]]);
    const options = requestFn.mock.calls[0]?.[1];
    expect(options?.headers).toEqual({
      "content-type": "application/x-msdownload",
      "content-length": "70",
      "content-disposition": "attachment",
    });
  });

  it("rejects with the mapped upload error and logs rejection diagnostics", async () => {
    errorsMock.missingSignedHeaders.mockReturnValue(["content-type"]);
    const session = createSession();
    const err = new Error("network reset");

    const p = putFile(session, "https://s3.example.com/up", "/tmp/f.bin", 100, "whole file");
    nthHandle(0).reject(err);

    await expect(p).rejects.toThrow("mapped");
    expect(errorsMock.toUploadError).toHaveBeenCalledWith("https://s3.example.com/up", err);
    expect(nthStream(0).destroy).toHaveBeenCalled();
    const [level, message, meta] = logMock.log.mock.calls[0] ?? [];
    expect(level).toBe("warn");
    expect(message).toBe("upload request rejected");
    expect(meta).toEqual({
      label: "whole file",
      url: "https://s3.example.com/up",
      size: 100,
      code: "http:bad-status",
      statusCode: 403,
      error: "mapped",
      sentHeaders: "content-type, content-length",
      missingSignedHeaders: "content-type",
    });
  });

  it("rethrows cancellations as-is without mapping or logging them", async () => {
    cancellationMock.isCancellation.mockReturnValue(true);
    const session = createSession();
    const err = new Error("user cancelled");

    const p = putFile(session, "https://s3.example.com/up", "/tmp/f.bin", 50, "whole file");
    nthHandle(0).reject(err);

    await expect(p).rejects.toThrow("user cancelled");
    expect(errorsMock.toUploadError).not.toHaveBeenCalled();
    expect(logMock.log).not.toHaveBeenCalled();
  });

  it("creates a fresh stream per retry attempt and reports progress from zero", async () => {
    transferRetryMock.withRetry.mockImplementation(async (attempt) => {
      try {
        return await attempt();
      } catch {
        return attempt();
      }
    });
    const session = createSession();
    const onProgress = vi.fn<(transferred: number) => void>();

    const p = putFile(
      session,
      "https://s3.example.com/up",
      "/tmp/f.bin",
      100,
      "whole file",
      undefined,
      onProgress,
    );
    nthHandle(0).upload(5);
    nthHandle(0).reject(new Error("network reset"));

    await vi.waitFor(() => expect(handles).toHaveLength(2));
    nthHandle(1).upload(7);
    nthHandle(1).resolve({ statusCode: 200 });

    await expect(p).resolves.toMatchObject({ statusCode: 200 });
    expect(fsMock.createReadStream).toHaveBeenCalledTimes(2);
    expect(nthStream(0).destroy).toHaveBeenCalled();
    expect(nthStream(1).destroy).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([5, 7, 100]);
  });
});

describe("postBody", () => {
  it("POSTs the body with its content type", async () => {
    const session = createSession();

    const p = postBody(
      session,
      "https://s3.example.com/complete",
      "<CompleteMultipartUpload/>",
      "application/xml",
    );
    nthHandle(0).resolve({ statusCode: 200 });

    await p;
    const options = requestFn.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe("<CompleteMultipartUpload/>");
    expect(options?.headers).toEqual({ "content-type": "application/xml" });
  });

  it("maps a failed completion and logs it with the body size", async () => {
    const session = createSession();

    const p = postBody(session, "https://s3.example.com/complete", "ABC", "application/xml");
    nthHandle(0).reject(new Error("reset"));

    await expect(p).rejects.toThrow("mapped");
    const [level, message, meta] = logMock.log.mock.calls[0] ?? [];
    expect(level).toBe("warn");
    expect(message).toBe("upload request rejected");
    expect(meta).toMatchObject({ label: "completion", size: 3 });
  });
});

describe("uploadFile", () => {
  it("uploads the whole file through a fresh session", async () => {
    const onProgress = vi.fn<(transferred: number) => void>();

    const p = uploadFile("https://s3.example.com/up", "/tmp/f.bin", 100, { onProgress });
    nthHandle(0).resolve({ statusCode: 200 });

    await p;
    expect(gotMock.extend).toHaveBeenCalledTimes(1);
    expect(fsMock.createReadStream.mock.calls).toEqual([["/tmp/f.bin", undefined]]);
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([100]);
  });
});
