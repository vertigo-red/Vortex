import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as https from "node:https";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OAuth from "./oauth";

vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof http>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

const token = {
  access_token: "loopback-test-access",
  refresh_token: "loopback-test-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid",
};

function makeTokenRequest() {
  const request = new EventEmitter();
  return Object.assign(request, {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn((err: Error) => request.emit("error", err)),
  });
}

const createServer = vi.mocked(http.createServer);
const requestToken = vi.mocked(https.request);
let posts: Array<{
  request: ReturnType<typeof makeTokenRequest>;
  respond: (response: http.IncomingMessage) => void;
}>;
let clients: http.ClientRequest[];

beforeEach(() => {
  posts = [];
  clients = [];
  createServer.mockClear();
  requestToken.mockClear();
  requestToken.mockImplementation(((options: https.RequestOptions, respond) => {
    const request = makeTokenRequest();
    options.signal?.addEventListener("abort", () => request.destroy(options.signal.reason), {
      once: true,
    });
    posts.push({ request, respond });
    return request as unknown as http.ClientRequest;
  }) as typeof https.request);
});

afterEach(async () => {
  posts.forEach(({ request }) => request.destroy(new Error("Test cleanup")));
  clients.forEach((client) => client.destroy());
  await Promise.all(
    createServer.mock.results
      .filter((result) => result.type === "return")
      .map(({ value: server }) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
  vi.restoreAllMocks();
});

function makeOAuth() {
  return new OAuth({
    baseUrl: "https://oauth.invalid",
    clientId: "loopback-test-client",
    redirectUrl: "http://127.0.0.1:PORT",
    getRedirectUrl: (port) => `http://127.0.0.1:${port}`,
  });
}

async function startLogin(oauth: OAuth) {
  const onToken = vi.fn();
  let page: URL;
  await oauth.sendRequest(onToken, (address) => {
    page = new URL(address);
  });
  return {
    onToken,
    page,
    state: page.searchParams.get("state"),
    redirect: page.searchParams.get("redirect_uri"),
    server: createServer.mock.results.at(-1).value as http.Server,
  };
}

function respond(index = 0, statusCode = 200, body: object = token) {
  const response = Object.assign(new EventEmitter(), { statusCode, complete: true });
  posts[index].respond(response as unknown as http.IncomingMessage);
  response.emit("data", Buffer.from(JSON.stringify(body)));
  response.emit("end");
}

function callbackPage(redirect: string, query: Record<string, string>) {
  const address = new URL(redirect);
  address.search = new URLSearchParams(query).toString();
  const pending = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const client = http.get(address, { agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    clients.push(client);
    client.on("error", reject);
  });
  void pending.catch(() => undefined);
  return pending;
}

async function completeCode(oauth: OAuth, state: string, code = "test-code") {
  const index = posts.length;
  const pending = oauth.receiveCode(code, state);
  await vi.waitFor(() => expect(posts).toHaveLength(index + 1));
  respond(index);
  await pending;
}

describe("OAuth browser callback and attempts", () => {
  it("keeps each attempt's PKCE verifier and redirect URI", async () => {
    const oauth = makeOAuth();
    const first = await startLogin(oauth);
    const second = await startLogin(oauth);
    await completeCode(oauth, first.state, "first-code");
    await completeCode(oauth, second.state, "second-code");

    const verifiers = [first, second].map((login, index) => {
      const form = new URLSearchParams(posts[index].request.write.mock.calls[0][0]);
      const verifier = form.get("code_verifier");
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
        login.page.searchParams.get("code_challenge"),
      );
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(form.get("redirect_uri")).toBe(login.redirect);
      expect(login.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
      return verifier;
    });
    expect(verifiers[0]).not.toBe(verifiers[1]);
  });

  it("shares server readiness when two login requests start together", async () => {
    const oauth = makeOAuth();
    const [first, second] = await Promise.all([startLogin(oauth), startLogin(oauth)]);
    expect(createServer).toHaveBeenCalledOnce();
    expect(first.redirect).toBe(second.redirect);
    await completeCode(oauth, first.state);
    expect(first.server.listening).toBe(true);
    await completeCode(oauth, second.state);
    expect(first.server.listening).toBe(false);
  });

  it("waits for the token before showing success and releases the listener", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    let browserResponse: http.ServerResponse;
    login.server.once("request", (_request, response) => {
      browserResponse = response;
    });
    const pending = callbackPage(login.redirect, { code: "test-code", state: login.state });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const endedBeforeToken = browserResponse.writableEnded;
    respond();
    const page = await pending;

    expect(endedBeforeToken).toBe(false);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Vortex log in successful!");
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(login.server.listening).toBe(false);
  });

  it("shows failure when the token endpoint rejects the code", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    const pending = callbackPage(login.redirect, { code: "expired-code", state: login.state });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    respond(0, 400, { error: "invalid_grant", error_description: "Expired grant" });
    const page = await pending;

    expect(page.body).toContain("Vortex was unable to log in");
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "invalid_grant" }),
      undefined,
    );
    expect(login.server.listening).toBe(false);
  });

  it.each(["ENOTFOUND", "ECONNRESET"])(
    "shows failure and releases the listener after token transport error %s",
    async (code) => {
      const oauth = makeOAuth();
      const login = await startLogin(oauth);
      const pending = callbackPage(login.redirect, { code: "test-code", state: login.state });
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      const error = Object.assign(new Error("Test connection failed"), { code });
      posts[0].request.emit("error", error);
      const page = await pending;
      expect(page.body).toContain("Vortex was unable to log in");
      expect(login.onToken).toHaveBeenCalledExactlyOnceWith(error, undefined);
      expect(login.server.listening).toBe(false);
    },
  );

  it("reports provider denial and releases the listener", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    const page = await callbackPage(login.redirect, {
      state: login.state,
      error: "access_denied",
      error_description: "Test user declined",
    });

    expect(page.body).toContain("Vortex was unable to log in");
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "access_denied", message: "Test user declined" }),
      undefined,
    );
    expect(requestToken).not.toHaveBeenCalled();
    expect(login.server.listening).toBe(false);
  });

  it.each(["not-pending", "constructor", "__proto__"])(
    "rejects unknown state %s without consuming the real login",
    async (state) => {
      const oauth = makeOAuth();
      const login = await startLogin(oauth);
      const page = await callbackPage(login.redirect, { code: "unrelated-code", state });

      expect(page.status).toBe(400);
      expect(page.body).toContain("Vortex was unable to log in");
      expect(requestToken).not.toHaveBeenCalled();
      expect(login.onToken).not.toHaveBeenCalled();
      expect(login.server.listening).toBe(true);
      await completeCode(oauth, login.state);
      expect(login.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    },
  );

  it("exchanges a duplicate browser callback only once", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    const received = vi.fn();
    login.server.on("request", received);
    const replies = [
      callbackPage(login.redirect, { code: "same-code", state: login.state }),
      callbackPage(login.redirect, { code: "same-code", state: login.state }),
    ];
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    // Complete every baseline request as well, so the regression fails without a timeout.
    for (let index = 0; index < posts.length; index++) respond(index);
    const pages = await Promise.all(replies);

    expect(requestToken).toHaveBeenCalledOnce();
    pages.forEach((page) => expect(page.body).toContain("Vortex log in successful!"));
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(login.server.listening).toBe(false);
  });

  it("cleans up when opening the authorization page fails and permits retry", async () => {
    const oauth = makeOAuth();
    const error = new Error("Browser unavailable");
    await expect(
      oauth.sendRequest(vi.fn(), () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const oldServer = createServer.mock.results.at(-1).value as http.Server;
    expect(oldServer.listening).toBe(false);
    const retry = await startLogin(oauth);
    await completeCode(oauth, retry.state);
    expect(retry.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(retry.server.listening).toBe(false);
  });

  it("permits retry after the local server fails to listen", async () => {
    const error = Object.assign(new Error("Loopback unavailable"), { code: "EACCES" });
    const failedServer = http.createServer();
    vi.spyOn(failedServer, "listen").mockImplementationOnce((() => {
      queueMicrotask(() => failedServer.emit("error", error));
      return failedServer;
    }) as typeof failedServer.listen);
    createServer.mockReturnValueOnce(failedServer);
    const oauth = makeOAuth();
    const openPage = vi.fn();
    await expect(oauth.sendRequest(vi.fn(), openPage)).rejects.toBe(error);
    expect(openPage).not.toHaveBeenCalled();
    const retry = await startLogin(oauth);
    await completeCode(oauth, retry.state);
    expect(retry.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(retry.server.listening).toBe(false);
  });

  it("invokes a throwing application callback once and still releases the listener", async () => {
    const oauth = makeOAuth();
    const error = new Error("Application callback failed");
    const onToken = vi.fn(() => {
      throw error;
    });
    let page: URL;
    await oauth.sendRequest(onToken, (address) => {
      page = new URL(address);
    });
    const server = createServer.mock.results.at(-1).value as http.Server;
    const pending = oauth.receiveCode("test-code", page.searchParams.get("state"));
    const checked = expect(pending).rejects.toBe(error);
    respond();
    await checked;
    expect(onToken).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });

  it("preserves code callbacks without state for a single pending attempt", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    const pending = oauth.receiveCode("legacy-code");
    respond();
    await pending;
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(login.server.listening).toBe(false);
  });

  it("requires state for overlapping manual callbacks without consuming either attempt", async () => {
    const oauth = makeOAuth();
    const first = await startLogin(oauth);
    const second = await startLogin(oauth);
    await expect(oauth.receiveCode("unbound-code")).rejects.toThrow("OAuth state is required");
    expect(requestToken).not.toHaveBeenCalled();
    expect(first.onToken).not.toHaveBeenCalled();
    expect(second.onToken).not.toHaveBeenCalled();
    await completeCode(oauth, first.state);
    await completeCode(oauth, second.state);
    expect(first.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(second.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(first.server.listening).toBe(false);
  });

  it("cancels waiting login, ignores its late code and permits a fresh login", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    const canceled = new Error("Test canceled");
    expect(oauth.cancel(canceled)).toBe(true);
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(canceled, undefined);
    expect(login.server.listening).toBe(false);
    await oauth.receiveCode("late-code", login.state);
    expect(requestToken).not.toHaveBeenCalled();
    expect(oauth.cancel(canceled)).toBe(false);
    const retry = await startLogin(oauth);
    await completeCode(oauth, retry.state);
    expect(retry.onToken).toHaveBeenCalledExactlyOnceWith(null, token);
    expect(login.onToken).toHaveBeenCalledOnce();
  });

  it("cancels login while the local listener is still starting", async () => {
    const oauth = makeOAuth();
    const onToken = vi.fn();
    const openPage = vi.fn();
    const pending = oauth.sendRequest(onToken, openPage);
    const canceled = new Error("Test canceled while starting");
    expect(oauth.cancel(canceled)).toBe(true);
    await pending;
    expect(onToken).toHaveBeenCalledExactlyOnceWith(canceled, undefined);
    expect(openPage).not.toHaveBeenCalled();
    const server = createServer.mock.results.at(-1).value as http.Server;
    expect(server.listening).toBe(false);
  });

  it("aborts an in-flight token request and never reports its late token", async () => {
    const oauth = makeOAuth();
    const login = await startLogin(oauth);
    const pending = callbackPage(login.redirect, { code: "test-code", state: login.state });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const canceled = new Error("Test canceled during exchange");
    expect(oauth.cancel(canceled)).toBe(true);
    const page = await pending;
    respond();
    expect(page.body).toContain("Vortex was unable to log in");
    expect(posts[0].request.destroy).toHaveBeenCalledExactlyOnceWith(canceled);
    expect(login.onToken).toHaveBeenCalledExactlyOnceWith(canceled, undefined);
    expect(login.server.listening).toBe(false);
  });

  it("cancels every pending attempt even if an application callback throws", async () => {
    const oauth = makeOAuth();
    const first = await startLogin(oauth);
    first.onToken.mockImplementation(() => {
      throw new Error("Test callback failed");
    });
    const second = await startLogin(oauth);
    const canceled = new Error("Test canceled all attempts");
    expect(oauth.cancel(canceled)).toBe(true);
    expect(first.onToken).toHaveBeenCalledExactlyOnceWith(canceled, undefined);
    expect(second.onToken).toHaveBeenCalledExactlyOnceWith(canceled, undefined);
    expect(first.server.listening).toBe(false);
    await oauth.receiveCode("late-first", first.state);
    await oauth.receiveCode("late-second", second.state);
    expect(requestToken).not.toHaveBeenCalled();
  });
});
