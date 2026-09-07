import { VortexError } from "@vortex/shared";
import { HTTPError, RequestError, TimeoutError } from "got";
import { describe, expect, it } from "vitest";

import { toNetworkError } from "./errors";

const DOWNLOAD_URL = "https://example.com/files/archive.zip";

const httpError = (statusCode: number): HTTPError => {
  // got v15 builds HTTPError.request from `response.request` and copies the
  // response back from `request.response`, so both have to be set for
  // `err.response.statusCode` to be readable.
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

const timeoutError = (): TimeoutError =>
  new TimeoutError(
    { message: "Request timed out", event: "socket" } as never,
    undefined as never,
    {} as never,
  );

const requestErrorWithCode = (code: string): RequestError => {
  const err = new RequestError("Network request failed", { code }, {} as never);
  Object.assign(err, { errno: -1, syscall: "connect" });
  return err;
};

describe("toNetworkError", () => {
  it("classifies a got TimeoutError as http:timeout", () => {
    const cause = timeoutError();
    const result = toNetworkError(new URL(DOWNLOAD_URL), cause);

    expect(result.data.kind).toBe("http:timeout");
    expect(result.data).toMatchObject({ url: DOWNLOAD_URL });
    expect(result.cause).toBe(cause);
    expect(result.message).toMatch(/timed out/i);
  });

  it("classifies HTTP 412 as http:precondition-failed", () => {
    const result = toNetworkError({ url: new URL(DOWNLOAD_URL) }, httpError(412));

    expect(result.data).toMatchObject({ kind: "http:precondition-failed", url: DOWNLOAD_URL });
    expect(result.message).toContain("resource change");
  });

  it("classifies other HTTP statuses as http:bad-status with the status code", () => {
    const result = toNetworkError(new URL(DOWNLOAD_URL), httpError(404));

    expect(result.data).toMatchObject({
      kind: "http:bad-status",
      url: DOWNLOAD_URL,
      statusCode: 404,
    });
    expect(result.message).toContain("404");
  });

  it("classifies a retryable network failure code as http:generic", () => {
    const result = toNetworkError(new URL(DOWNLOAD_URL), requestErrorWithCode("ECONNRESET"));

    expect(result.data).toMatchObject({
      kind: "http:generic",
      url: DOWNLOAD_URL,
      originalCode: "ECONNRESET",
    });
    expect(result.data.kind).toBe("http:generic");
    expect(result.message).toBe("Network request failed");
  });

  it("marks timeouts as transient request errors", () => {
    const result = toNetworkError(new URL(DOWNLOAD_URL), requestErrorWithCode("ETIMEDOUT"));

    expect(result.data.kind).toBe("http:generic");
    expect(result.message).toBe("Network request failed (transient)");
  });

  it("passes a VortexError through unchanged", () => {
    const original = new VortexError("gone", { kind: "fs:not-found", path: "/mods/missing" });
    const result = toNetworkError(new URL(DOWNLOAD_URL), original);

    expect(result).toBe(original);
  });

  it("classifies a plain node-style network error as http:generic", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
    });
    const result = toNetworkError(new URL(DOWNLOAD_URL), cause);

    expect(result.data.kind).toBe("http:generic");
    expect(result.data).toMatchObject({ url: DOWNLOAD_URL, originalCode: "ECONNREFUSED" });
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("funnels unclassifiable errors into the unknown kind", () => {
    const result = toNetworkError(new URL(DOWNLOAD_URL), new Error("boom"));

    expect(result.data.kind).toBe("unknown");
  });
});
