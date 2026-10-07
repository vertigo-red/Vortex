import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as https from "node:https";

import jwt from "jsonwebtoken";
import { afterEach, expect, vi } from "vitest";

import { test } from "../../test-utils/harnessTest";
import { UserCanceled } from "../../util/CustomErrors";
import opn from "../../util/opn";
import { clearOAuthCredentials } from "./actions/account";
import { accessTokenSchema } from "./types/IJWTAccessToken";
import { ensureLoggedIn, oauthCallback, onCancelLoginImpl, requestLogin } from "./util";

vi.mock("../../util/opn", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const servers = vi.hoisted(() => [] as http.Server[]);
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof http>();
  return {
    ...actual,
    createServer: vi.fn((...args: Parameters<typeof http.createServer>) => {
      const server = actual.createServer(...args);
      servers.push(server);
      return server;
    }),
  };
});

let activeRequest: http.ClientRequest;

// requestLogin brings Vortex to the foreground when the attempt finishes.
Object.assign(window.api.window, {
  getPosition: vi.fn().mockResolvedValue([0, 0]),
  getSize: vi.fn().mockResolvedValue([800, 600]),
  setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
  setPosition: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
});

afterEach(async () => {
  activeRequest?.destroy(new Error("Test cleanup"));
  activeRequest = undefined;
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

function tokenExchange() {
  let responseCallback: (response: http.IncomingMessage) => void;
  const request = new EventEmitter();
  Object.assign(request, {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn((err: Error) => request.emit("error", err)),
  });
  activeRequest = request as unknown as http.ClientRequest;
  vi.mocked(https.request).mockImplementationOnce(((options: https.RequestOptions, respond) => {
    responseCallback = respond;
    options.signal?.addEventListener("abort", () => activeRequest.destroy(options.signal.reason));
    return activeRequest;
  }) as typeof https.request);
  return (reply: object) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, complete: true });
    responseCallback(response as unknown as http.IncomingMessage);
    response.emit("data", JSON.stringify(reply));
    response.emit("end");
  };
}

function validTokenReply() {
  const accessToken = jwt.sign(
    {
      application_id: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "nexusmods",
      jti: "test-token",
      sub: "7",
      user: {
        group_id: 1,
        id: 7,
        joined: 0,
        membership_roles: [],
        other_group_ids: "",
        permissions: {},
        premium_expiry: 0,
        age_verified: true,
        username: "Test User",
      },
    },
    "not-verified-here",
  );
  expect(accessTokenSchema.safeParse(jwt.decode(accessToken)).success).toBe(true);
  return { access_token: accessToken, refresh_token: "test-refresh" };
}

test("stores a successful token through the normal login callback", async ({ makeApi }) => {
  const harness = makeApi({ userInfo: undefined });
  harness.api.store.dispatch(clearOAuthCredentials(null));
  const callback = vi.fn();
  await requestLogin({} as never, harness.api, callback);
  const page = new URL(vi.mocked(opn).mock.calls.at(-1)[0]);
  const respond = tokenExchange();
  const pending = oauthCallback(harness.api, "test-code", page.searchParams.get("state"));
  const reply = validTokenReply();
  respond(reply);
  await pending;

  expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  expect(harness.getState().confidential.account["nexus"].OAuthCredentials).toMatchObject({
    token: reply.access_token,
    refreshToken: reply.refresh_token,
  });
  expect(harness.getState().session["nexus"].oauthPending).toBeUndefined();
  expect(vi.mocked(http.createServer).mock.results.at(-1).value.listening).toBe(false);
});

test("dismisses a real pending OAuth login and cancels all waiting installs", async ({
  makeApi,
}) => {
  const harness = makeApi({ userInfo: undefined });
  harness.api.store.dispatch(clearOAuthCredentials(null));
  const callback = vi.fn();
  await requestLogin({} as never, harness.api, callback);
  const page = new URL(vi.mocked(opn).mock.calls.at(-1)[0]);
  const state = page.searchParams.get("state");
  const waiting = [ensureLoggedIn(harness.api), ensureLoggedIn(harness.api)].map((login) =>
    login.catch((err) => err),
  );
  const event = vi.fn();
  harness.api.events.on("did-login", event);

  onCancelLoginImpl(harness.api);

  const errors = await Promise.all(waiting);
  errors.forEach((error) => expect(error).toBeInstanceOf(UserCanceled));
  expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled));
  expect(event).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled));
  expect(harness.api.events.listenerCount("did-login")).toBe(1);
  expect(harness.getState().session["nexus"].oauthPending).toBeUndefined();
  expect(vi.mocked(http.createServer).mock.results.at(-1).value.listening).toBe(false);
  await oauthCallback(harness.api, "late-code", state);
  expect(https.request).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledOnce();
});

test("does not store a late valid token after an in-flight login is canceled", async ({
  makeApi,
}) => {
  const harness = makeApi({ userInfo: undefined });
  harness.api.store.dispatch(clearOAuthCredentials(null));
  const callback = vi.fn();
  await requestLogin({} as never, harness.api, callback);
  const page = new URL(vi.mocked(opn).mock.calls.at(-1)[0]);
  const respond = tokenExchange();
  const pending = oauthCallback(harness.api, "test-code", page.searchParams.get("state"));
  onCancelLoginImpl(harness.api);
  await pending;

  respond(validTokenReply());
  await Promise.resolve();

  expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled));
  expect(harness.getState().confidential.account["nexus"].OAuthCredentials).toBeUndefined();
  expect(harness.getState().session["nexus"].oauthPending).toBeUndefined();
  expect(vi.mocked(http.createServer).mock.results.at(-1).value.listening).toBe(false);
});
