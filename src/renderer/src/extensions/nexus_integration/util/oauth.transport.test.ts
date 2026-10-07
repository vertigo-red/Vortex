import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import { createServer, type AddressInfo, type Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type * as constants from "../constants";
import OAuth, { requestTokenRefresh } from "./oauth";

vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("../constants", async (importOriginal) => ({
  ...(await importOriginal<typeof constants>()),
  OAUTH_REDIRECT_BASE: "nxm://oauth/callback",
}));

const token = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid",
};
const requestMock = vi.mocked(https.request);
type ResponseCallback = (response: IncomingMessage) => void;

function makeRequest() {
  const request = new EventEmitter();
  return Object.assign(request, {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn((err: Error) => request.emit("error", err)),
  });
}

describe("OAuth token transport", () => {
  let requests: ReturnType<typeof makeRequest>[];
  let callbacks: ResponseCallback[];

  beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    callbacks = [];
    requestMock.mockImplementation(((_options: https.RequestOptions, cb: ResponseCallback) => {
      const request = makeRequest();
      requests.push(request);
      callbacks.push(cb);
      return request as unknown as ClientRequest;
    }) as typeof https.request);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const respond = (statusCode = 200, index = 0) => {
    const response = Object.assign(new EventEmitter(), { statusCode, complete: true });
    callbacks[index](response as unknown as IncomingMessage);
    return response;
  };

  it("reads a complete token reply and cancels the request deadline", async () => {
    const pending = requestTokenRefresh("test-refresh");
    const response = respond();
    const body = JSON.stringify(token);
    response.emit("data", Buffer.from(body.slice(0, 20)));
    response.emit("data", Buffer.from(body.slice(20)));
    response.emit("end");
    response.emit("close");
    await expect(pending).resolves.toEqual(token);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests[0].destroy).not.toHaveBeenCalled();
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED"])(
    "rejects %s without waiting for a response",
    async (code) => {
      const error = Object.assign(new Error("Connection failed"), { code });
      const pending = requestTokenRefresh("test-refresh");
      const checked = expect(pending).rejects.toBe(error);
      requests[0].emit("error", error);
      await checked;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a response stream error without an end event", async () => {
    const pending = requestTokenRefresh("test-refresh");
    const error = Object.assign(new Error("Socket reset"), { code: "ECONNRESET" });
    const checked = expect(pending).rejects.toBe(error);
    respond().emit("error", error);
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an incomplete response that closes without an error event", async () => {
    const pending = requestTokenRefresh("test-refresh");
    const checked = expect(pending).rejects.toMatchObject({ code: "ECONNRESET" });
    const response = respond();
    response.complete = false;
    response.emit("data", Buffer.from('{"access_token":'));
    response.emit("close");
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys a request that never connects after 30 seconds", async () => {
    const pending = requestTokenRefresh("test-refresh");
    const checked = expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requests[0].destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(requests[0].destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the complete response even when some token data has arrived", async () => {
    const pending = requestTokenRefresh("test-refresh");
    const checked = expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(20_000);
    const response = respond();
    response.emit("data", Buffer.from('{"access_token":'));
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(requests[0].destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the OAuth rejection code and developer details", async () => {
    const pending = requestTokenRefresh("test-refresh");
    const checked = expect(pending).rejects.toMatchObject({
      code: "invalid_grant",
      details: "Expired test grant",
    });
    const response = respond(400);
    response.emit(
      "data",
      Buffer.from(
        JSON.stringify({ error: "invalid_grant", error_description: "Expired test grant" }),
      ),
    );
    response.emit("end");
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows another login after a failed token exchange", async () => {
    const oauth = new OAuth({
      baseUrl: "https://oauth.invalid",
      clientId: "test-client",
      redirectUrl: "nxm://oauth/callback",
    });
    const first = vi.fn();
    let page = "";
    await oauth.sendRequest(first, (url) => {
      page = url;
    });
    const pending = oauth.receiveCode("test-code", new URL(page).searchParams.get("state"));
    const error = Object.assign(new Error("Offline"), { code: "ENOTFOUND" });
    requests[0].emit("error", error);
    await pending;
    expect(first).toHaveBeenCalledExactlyOnceWith(error, undefined);

    const second = vi.fn();
    await oauth.sendRequest(second, (url) => {
      page = url;
    });
    const retry = oauth.receiveCode("retry-code", new URL(page).searchParams.get("state"));
    const response = respond(200, 1);
    response.emit("data", Buffer.from(JSON.stringify(token)));
    response.emit("end");
    await retry;
    expect(second).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(first).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a real TLS connection failure to the login callback", async () => {
    vi.useRealTimers();
    const actual = await vi.importActual<typeof https>("node:https");
    requestMock.mockImplementation(actual.request);
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const oauth = new OAuth({
      baseUrl: `https://127.0.0.1:${port}`,
      clientId: "test-client",
      redirectUrl: "nxm://oauth/callback",
    });
    const onToken = vi.fn();
    let page = "";
    await oauth.sendRequest(onToken, (url) => {
      page = url;
    });

    await oauth.receiveCode("test-code", new URL(page).searchParams.get("state"));
    expect(onToken).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "ECONNRESET" }),
      undefined,
    );
  });

  it("cancels a real TLS token request while the handshake is pending", async () => {
    vi.useRealTimers();
    const actual = await vi.importActual<typeof https>("node:https");
    requestMock.mockImplementation(actual.request);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // Consume the ClientHello so the peer's later EOF is observable, without replying.
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    const oauth = new OAuth({
      baseUrl: `https://127.0.0.1:${port}`,
      clientId: "test-client",
      redirectUrl: "nxm://oauth/callback",
    });
    const onToken = vi.fn();
    let page: URL;
    await oauth.sendRequest(onToken, (address) => {
      page = new URL(address);
    });
    const pending = oauth.receiveCode("test-code", page.searchParams.get("state"));
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    const canceled = new Error("Test canceled TLS exchange");
    expect(oauth.cancel(canceled)).toBe(true);
    await pending;
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    expect(onToken).toHaveBeenCalledExactlyOnceWith(canceled, undefined);
  });
});
