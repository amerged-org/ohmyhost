import { sealData, unsealData } from "iron-session";

import { readBoundedText } from "./workos-session-status.js";
export const PORTAL_SESSION_COOKIE = "__Host-omh-session";
export const CLEAR_PORTAL_SESSION = `${PORTAL_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
export interface BrowserSession {
  accessToken: string;
  refreshToken: string;
  csrf: string;
  origin: string;
  createdAt: number;
  organizationId: string | null;
}
export async function openBrowserSession(
  cookie: string | null,
  password: string,
  origin: string,
  now: number,
): Promise<BrowserSession | null> {
  if (password.length < 32) throw Error("Session configuration unavailable");
  const values = (cookie ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(PORTAL_SESSION_COOKIE + "="));
  if (values.length !== 1) return null;
  try {
    const encoded = values[0]?.slice(PORTAL_SESSION_COOKIE.length + 1) ?? "";
    if (!/^Fe26\.2\*[^~]+~2$/u.test(encoded)) return null;
    const session = await unsealData<BrowserSession>(
      values[0]?.slice(PORTAL_SESSION_COOKIE.length + 1) ?? "",
      { password, ttl: 604800 },
    );
    if (
      session.origin !== origin ||
      !Number.isFinite(session.createdAt) ||
      session.createdAt > now ||
      now - session.createdAt >= 604800000 ||
      typeof session.csrf !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(session.csrf) ||
      typeof session.accessToken !== "string" ||
      session.accessToken.length > 8192 ||
      !session.accessToken ||
      typeof session.refreshToken !== "string" ||
      session.refreshToken.length > 8192 ||
      !session.refreshToken ||
      (session.organizationId !== null && !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(session.organizationId))
    )
      return null;
    return session;
  } catch {
    return null;
  }
}
export async function closeBrowserSession(
  session: BrowserSession,
  password: string,
): Promise<string> {
  const sealed = await sealData(session, { password, ttl: 604800 });
  if (sealed.length > 3800) throw Error("Session exceeds cookie capacity");
  return `${PORTAL_SESSION_COOKIE}=${sealed}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

/** What a WorkOS user-management token exchange needs from the Worker. */
export interface WorkosTokenExchange {
  readonly origin: string;
  readonly clientId: string;
  readonly crypto: Crypto;
  /** Needed only when no prior session exists; a refresh always has one. */
  readonly now?: () => Date;
  readonly providerFetch: (request: Request) => Promise<Response>;
}

/**
 * Exchanges a WorkOS grant (an authorization code or a refresh token) for a session. `prior` keeps the session's CSRF
 * token, its creation time and its workspace. A rejected grant throws with status 401, any other failure with 503.
 */
export async function exchangeWorkosToken(
  exchange: WorkosTokenExchange,
  body: Record<string, string>,
  prior?: BrowserSession,
): Promise<BrowserSession> {
  const response = await exchange.providerFetch(
    new Request("https://api.workos.com/user_management/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: exchange.clientId, ...body }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error("Authentication unavailable"), {
      status: response.status === 400 || response.status === 401 ? 401 : 503,
    });
  }
  const value: unknown = JSON.parse(await readBoundedText(response, 65536));
  if (
    !value ||
    typeof value !== "object" ||
    !("access_token" in value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    value.access_token.length > 8192 ||
    !("refresh_token" in value) ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token ||
    value.refresh_token.length > 8192
  )
    throw Error("Invalid session");
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    csrf: prior?.csrf ?? randomToken(exchange.crypto),
    createdAt: prior?.createdAt ?? exchange.now?.().getTime() ?? Date.now(),
    origin: exchange.origin,
    organizationId: prior?.organizationId ?? null,
  };
}

export function randomToken(crypto: Crypto): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
