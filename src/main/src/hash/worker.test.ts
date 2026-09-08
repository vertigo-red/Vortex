import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HashJob, HashResult } from "./protocol";
import "./worker";

type JobHandler = (job: HashJob) => void;

const portMock = vi.hoisted(() => ({
  on: vi.fn(),
  postMessage: vi.fn(),
}));
const computeMock = vi.hoisted(() => ({
  hashFileStream: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: portMock,
}));

vi.mock("./compute", () => computeMock);

vi.mock("@vortex/shared", () => ({
  getErrorMessageOrDefault: (err: unknown): string => {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "unknown error";
  },
}));

// The worker registers its message handler during import, so capture it once
// after the mocked modules are in place.
const handler = portMock.on.mock.calls[0]?.[1] as JobHandler;

beforeEach(() => {
  portMock.postMessage.mockClear();
  computeMock.hashFileStream.mockReset();
});

describe("hash worker", () => {
  it("answers each job with a result carrying the same id", async () => {
    computeMock.hashFileStream
      .mockResolvedValueOnce({ hash: "h1", numBytes: 1 })
      .mockResolvedValueOnce({ hash: "h2", numBytes: 2 });

    handler({ id: 1, algorithm: "md5", filePath: "/a" });
    handler({ id: 2, algorithm: "md5", filePath: "/b" });

    await vi.waitFor(() => {
      expect(portMock.postMessage).toHaveBeenCalledTimes(2);
    });

    expect(computeMock.hashFileStream.mock.calls).toEqual([
      ["md5", "/a"],
      ["md5", "/b"],
    ]);
    expect(portMock.postMessage.mock.calls.map((call) => call[0] as HashResult)).toEqual([
      { id: 1, hash: "h1", numBytes: 1 },
      { id: 2, hash: "h2", numBytes: 2 },
    ]);
  });

  it("posts the hash and byte count for a successful job", async () => {
    computeMock.hashFileStream.mockResolvedValue({ hash: "abc", numBytes: 42 });

    handler({ id: 7, algorithm: "md5", filePath: "/file.bin" });

    await vi.waitFor(() => {
      expect(portMock.postMessage).toHaveBeenCalledWith({ id: 7, hash: "abc", numBytes: 42 });
    });

    expect(computeMock.hashFileStream).toHaveBeenCalledWith("md5", "/file.bin");
  });

  it("posts an error message instead of an exception when hashing fails", async () => {
    computeMock.hashFileStream.mockRejectedValue(new Error("disk read failed"));

    handler({ id: 9, algorithm: "md5", filePath: "/broken" });

    await vi.waitFor(() => {
      expect(portMock.postMessage).toHaveBeenCalledWith({ id: 9, error: "disk read failed" });
    });
  });

  it("stringifies non-Error rejections via getErrorMessageOrDefault", async () => {
    computeMock.hashFileStream.mockRejectedValue("corrupt stream");

    handler({ id: 11, algorithm: "md5", filePath: "/odd" });

    await vi.waitFor(() => {
      expect(portMock.postMessage).toHaveBeenCalledWith({ id: 11, error: "corrupt stream" });
    });
  });

  it("uses the fallback message for unknown rejection values", async () => {
    computeMock.hashFileStream.mockRejectedValue(null);

    handler({ id: 13, algorithm: "md5", filePath: "/null" });

    await vi.waitFor(() => {
      expect(portMock.postMessage).toHaveBeenCalledWith({ id: 13, error: "unknown error" });
    });
  });
});
