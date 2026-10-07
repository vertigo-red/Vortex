import crypto from "crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as querystring from "node:querystring";

import { unknownToError } from "@vortex/shared";
import { v1 as uuidv1 } from "uuid";

import { log } from "../../../util/log";
import { OAUTH_CLIENT_ID, OAUTH_REDIRECT_BASE, OAUTH_URL } from "../constants";
import NEXUSMODS_LOGO from "./nexusmodslogo";

type TokenType = "Bearer";

// see https://www.oauth.com/oauth2-servers/access-tokens/access-token-response/
type TokenErrorType =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_grant_type";

export interface ITokenReply {
  access_token: string;
  token_type: TokenType;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface IOAuthServerSettings {
  baseUrl: string;
  clientId: string;
  redirectUrl: string; // Deprecated - for backward compatibility
  getRedirectUrl?: (port: number) => string; // New way to get redirect URL
}

interface IOAuthAttempt {
  onToken: (err: Error, token: ITokenReply) => void;
  verifier: string;
  controller: AbortController;
  canceled?: boolean;
  redirectUrl?: string;
  result?: Promise<boolean>;
}

function makeResultPage(success: boolean) {
  const html = [];

  html.push(
    `<!DOCTYPE html>

    <html lang="en">
    
    <head>
    <title>Authentication Status</title>
    
      <meta http-equiv="refresh" content="6; url=http://www.nexusmods.com/" />
    
    </head>
    
    <body style="display: flex; flex-direction: column; height: 50vh; justify-content: center; align-items: center; background-color: black; font-family: sans-serif; color: white;">
    
    <div style="text-align: center; ">
    
    <img width="200px" src="data:image/png;base64,${NEXUSMODS_LOGO}" />`,
  );

  if (success) {
    html.push(`
    <h1>Vortex log in successful!</h1>
  `);
  } else {
    html.push(`
    <h1>Vortex was unable to log in</h1>
    <p style="font-size: 1.2em;">Please check Vortex for more information</a></p>
  `);
  }

  html.push(`

  <p style="font-size: 1.2em;">Taking you to the <a href="http://www.nexusmods.com/" style="color: #D98F40;">Nexus Mods homepage</a></p>
    </div>
    </body>
    
    </html>
  `);

  return html.join("");
}

async function postRequest(tokenUrl: string, request: any, signal?: AbortSignal): Promise<string> {
  const requestStr = querystring.stringify(request);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const parsedUrl = new URL(tokenUrl);
      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Content-Length": requestStr.length,
          },
        },
        (res) => {
          let responseStr = "";
          res
            .on("data", (chunk) => (responseStr += chunk.toString()))
            .on("error", reject)
            .on("close", () => {
              if (!res.complete) {
                reject(
                  Object.assign(new Error("OAuth token response was interrupted"), {
                    code: "ECONNRESET",
                  }),
                );
              }
            })
            .on("end", () => {
              if (res.statusCode !== 200) {
                try {
                  const errDetails = JSON.parse(responseStr);
                  const err = new Error(`Invalid request: "${errDetails?.error}"`);
                  err["code"] = errDetails?.error;
                  // these details are explicitly intended for the developer, not for the user
                  err["details"] = errDetails?.error_description;
                  reject(err);
                } catch (err) {
                  const errMessage = responseStr.includes("<!DOCTYPE html>")
                    ? `Received HTML response from ${tokenUrl} when JSON was expected. Please check your connection settings.`
                    : `Failed to parse failure response: "${responseStr.substring(0, 50)}"`;
                  reject(new Error(errMessage));
                }
              } else {
                resolve(responseStr);
              }
            });
        },
      );
      req.on("error", reject);
      // A socket timeout alone does not bound DNS, connecting or a trickling response.
      deadline = setTimeout(() => {
        req.destroy(
          Object.assign(new Error("OAuth token request timed out"), {
            code: "ETIMEDOUT",
          }),
        );
      }, 30_000);
      req.write(requestStr);
      req.end();
    });
  } finally {
    clearTimeout(deadline);
  }
}

/** Trade a refresh token for a new token pair (RFC 6749 §6). */
export async function requestTokenRefresh(refreshToken: string): Promise<ITokenReply> {
  const reply = await postRequest(`${OAUTH_URL}/token`, {
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  return JSON.parse(reply);
}

/**
 * deals with token exchange for OAuth2
 **/
class OAuth {
  private mServerSettings: IOAuthServerSettings;
  private mStates = new Map<string, IOAuthAttempt>();
  private mServer: http.Server;
  private mStartingServer: Promise<void>;
  private mLocalhost: boolean;

  constructor(settings: IOAuthServerSettings) {
    this.mServerSettings = settings;
    // Check if we're using localhost redirect (http protocol)
    this.mLocalhost = OAUTH_REDIRECT_BASE.startsWith("http:");
  }

  public async sendRequest(
    onToken: (err: Error, token: ITokenReply) => void,
    onOpenPage: (url: string) => void,
  ): Promise<void> {
    const state = uuidv1();
    // see https://www.rfc-editor.org/rfc/rfc7636#section-4.1
    const attempt: IOAuthAttempt = {
      onToken,
      verifier: crypto.randomBytes(32).toString("base64url"),
      controller: new AbortController(),
    };
    // Register before awaiting the shared listener, including other requests still starting.
    this.mStates.set(state, attempt);
    // see https://www.rfc-editor.org/rfc/rfc7636#section-4.2
    const challenge = crypto.createHash("sha256").update(attempt.verifier).digest("base64url");

    try {
      const port = this.mLocalhost ? await this.ensureServer() : -1;
      if (attempt.canceled) {
        this.mStates.delete(state);
        this.checkServerStillRequired();
        return;
      }
      attempt.redirectUrl = this.mServerSettings.getRedirectUrl
        ? this.mServerSettings.getRedirectUrl(port)
        : this.mServerSettings.redirectUrl.replace("PORT", port.toString());
      // The token exchange must retain this attempt's verifier and exact redirect URI.
      onOpenPage(this.authorizeUrl(challenge, state, attempt.redirectUrl));
    } catch (err) {
      this.mStates.delete(state);
      this.checkServerStillRequired();
      if (!attempt.canceled) throw err;
    }
  }

  public cancel(error: Error): boolean {
    const attempts = [...this.mStates].filter(([, attempt]) => !attempt.canceled);
    for (const [state, attempt] of attempts) {
      attempt.canceled = true;
      // A starting listener must finish before sendRequest can release it safely.
      if (attempt.redirectUrl !== undefined) this.mStates.delete(state);
      attempt.controller.abort(error);
    }
    for (const [, attempt] of attempts) {
      try {
        attempt.onToken(error, undefined);
      } catch (err) {
        log("warn", "failed to report OAuth cancellation", err);
      }
    }
    this.checkServerStillRequired();
    return attempts.length > 0;
  }

  public async receiveCode(code: string, state?: string): Promise<void> {
    if (state === undefined) {
      const states = [...this.mStates]
        .filter(([, attempt]) => !attempt.canceled)
        .map(([key]) => key);
      if (states.length > 1) {
        throw new Error("OAuth state is required while multiple login attempts are pending");
      }
      if (states.length === 1) {
        await this.exchangeCode(code, states[0]);
      }
    } else {
      await this.exchangeCode(code, state);
    }
  }

  private async exchangeCode(code: string, state: string): Promise<boolean> {
    const attempt = this.mStates.get(state);
    if (attempt?.redirectUrl === undefined) {
      log("debug", "ignoring OAuth callback with unknown state token", { state });
      return false;
    }
    return this.finishAttempt(state, attempt, () => this.sentAuthorizeToken(code, attempt));
  }

  private finishAttempt(
    state: string,
    attempt: IOAuthAttempt,
    receive: () => Promise<ITokenReply>,
  ): Promise<boolean> {
    // Browser retries share the in-flight result instead of redeeming the same code twice.
    attempt.result ??= this.completeAttempt(state, attempt, receive);
    return attempt.result;
  }

  private async completeAttempt(
    state: string,
    attempt: IOAuthAttempt,
    receive: () => Promise<ITokenReply>,
  ): Promise<boolean> {
    let token: ITokenReply;
    let error: Error = null;
    try {
      token = await receive();
    } catch (err) {
      error = unknownToError(err);
    }
    if (attempt.canceled) return false;
    this.mStates.delete(state);
    try {
      attempt.onToken(error, token);
      return error === null;
    } finally {
      this.checkServerStillRequired();
    }
  }

  private async ensureServer(): Promise<number> {
    if (this.mStartingServer === undefined) {
      log("info", "starting localhost server to receive oauth response");
      this.mStartingServer = this.startServer();
    }
    await this.mStartingServer;
    const addr: AddressInfo = this.mServer.address() as AddressInfo;
    log("info", "using localhost server for oauth response", {
      port: addr.port,
    });
    return addr.port;
  }

  private checkServerStillRequired() {
    if (this.mLocalhost && this.mStates.size === 0) {
      log("info", "no more oauth responses outstanding, stopping server");
      this.stopServer();
    }
  }

  private stopServer() {
    this.mServer?.close(() => undefined);
    this.mServer = undefined;
    this.mStartingServer = undefined;
  }

  private async startServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.mServer = http
          .createServer()
          .listen(0, "127.0.0.1")
          .on("error", reject)
          .on("listening", resolve)
          .on("request", (req, resp) => {
            void this.onHTTPRequest(req, resp).catch((err) => {
              log("warn", "failed to write OAuth callback response", err);
              resp.destroy();
            });
          });
      } catch (err) {
        reject(err);
      }
    });
  }

  private async onHTTPRequest(
    req: http.IncomingMessage,
    resp: http.ServerResponse<http.IncomingMessage> & {
      req: http.IncomingMessage;
    },
  ) {
    let success = false;
    try {
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      const code = query.get("code");
      const state = query.get("state");
      const error = query.get("error");
      const attempt = this.mStates.get(state);
      if (attempt === undefined || (!code && !error)) {
        resp.statusCode = 400;
      } else if (code) {
        success = await this.exchangeCode(code, state);
      } else {
        const err = new Error(query.get("error_description") ?? "Description missing");
        err["code"] = error;
        success = await this.finishAttempt(state, attempt, () => Promise.reject(err));
      }
    } catch (err) {
      log("warn", "failed to handle OAuth callback", err);
    }
    if (!resp.destroyed) {
      resp.setHeader("Content-Type", "text/html; charset=utf-8");
      resp.end(makeResultPage(success));
    }
  }

  private authorizeUrl(challenge: string, state: string, redirectUrl: string): string {
    const request = {
      response_type: "code",
      scope: "openid profile email",
      code_challenge_method: "S256",
      client_id: this.mServerSettings.clientId,
      redirect_uri: redirectUrl,
      state,
      code_challenge: challenge,
    };
    return `${this.mServerSettings.baseUrl}/authorize?${querystring.stringify(request)}`;
  }

  private async sentAuthorizeToken(code: string, attempt: IOAuthAttempt): Promise<ITokenReply> {
    const request = {
      grant_type: "authorization_code",
      client_id: this.mServerSettings.clientId,
      redirect_uri: attempt.redirectUrl,
      code,
      code_verifier: attempt.verifier,
    };
    const tokenUrl = `${this.mServerSettings.baseUrl}/token`;
    // TODO: validate result
    return JSON.parse(await postRequest(tokenUrl, request, attempt.controller.signal));
  }
}

export default OAuth;
