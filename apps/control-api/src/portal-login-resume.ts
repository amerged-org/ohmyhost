import { sealData, unsealData } from "iron-session";
import { STRICT_TRANSPORT_SECURITY } from "./portal-page.js";

const COOKIE = "__Host-omh-login-resume";
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";
const LIFETIME_SECONDS = 600;
const HANDOFF = /^[A-Za-z0-9_-]{43}$/u;
export const PORTAL_RESUME_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const CLEAR_PORTAL_RESUME = `${COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

function resumePath(url: URL): string | null {
  if (url.hash || url.search.length > 2300) return null;
  const { pathname, searchParams } = url;
  const mcp = pathname === "/mcp/github" || pathname === "/mcp/secrets";
  if (!mcp && pathname !== "/connections/authorize" && pathname !== "/connections/complete")
    return null;
  const handoff = pathname === "/connections/complete" ? "result" : "request";
  const allowed = mcp ? [handoff, "return_url", "redirectUrl"] : [handoff];
  if (
    !HANDOFF.test(searchParams.get(handoff) ?? "") ||
    [...searchParams.keys()].some((name) => !allowed.includes(name)) ||
    allowed.some((name) => searchParams.getAll(name).length > 1)
  )
    return null;
  // The MCP handler validates chat navigation hints against the authenticated handoff.
  return pathname + url.search;
}

/** The browser retains the form link locally. AuthKit sees only the normal login state. */
export async function redirectToPortalLogin(
  url: URL,
  password: string,
  now: number,
): Promise<Response | null> {
  const path = resumePath(url);
  if (!path || password.length < 32) return null;
  const id = crypto.randomUUID();
  const sealed = await sealData(
    { id, origin: url.origin, path, createdAt: now },
    { password, ttl: LIFETIME_SECONDS },
  );
  if (sealed.length > 3800) return null;
  return new Response(null, {
    status: 303,
    headers: {
      location: `/login?resume=${id}`,
      "set-cookie": `${COOKIE}=${sealed}; ${COOKIE_ATTRIBUTES}; Max-Age=${LIFETIME_SECONDS}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "strict-transport-security": STRICT_TRANSPORT_SECURITY,
    },
  });
}

export async function readPortalResume(
  cookie: string | null,
  password: string,
  origin: string,
  now: number,
  id: string,
): Promise<string | null> {
  const values = (cookie ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(COOKIE + "="));
  const sealed = values[0]?.slice(COOKIE.length + 1);
  if (values.length !== 1 || !sealed || sealed.length > 3800) return null;
  try {
    const saved = await unsealData<{
      id: string;
      origin: string;
      path: string;
      createdAt: number;
    }>(sealed, { password, ttl: LIFETIME_SECONDS });
    if (
      saved.id !== id ||
      saved.origin !== origin ||
      typeof saved.path !== "string" ||
      !saved.path.startsWith("/") ||
      !Number.isFinite(saved.createdAt) ||
      saved.createdAt > now ||
      now - saved.createdAt >= LIFETIME_SECONDS * 1000
    )
      return null;
    const url = new URL(saved.path, origin);
    return url.origin === origin && resumePath(url) === saved.path ? saved.path : null;
  } catch {
    return null;
  }
}
