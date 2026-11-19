import type { BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";

const RESOURCE_DIRECTIVES = [
  ["connect-src", "connect"],
  ["script-src", "scripts"],
  ["style-src", "styles"],
  ["img-src", "images"],
  ["font-src", "fonts"],
  ["frame-src", "frames"],
] as const;

/** Extends only the declared resource directive; platform nonces and other controls stay intact. */
export function browserContentSecurityPolicy(base: string, policy?: BrowserPolicy): string {
  if (policy === undefined) return base;
  let result = base;
  for (const [directive, group] of RESOURCE_DIRECTIVES) {
    if (policy[group].length > 0) result = setDirective(result, directive, policy[group]);
  }
  if (policy.frameAncestors.length > 0)
    result = setDirective(result, "frame-ancestors", policy.frameAncestors, true);
  const workers = [
    ...(policy.workers.self ? ["'self'"] : []),
    ...(policy.workers.blob ? ["blob:"] : []),
  ];
  if (workers.length > 0) result = setDirective(result, "worker-src", workers, true);
  return result;
}

function setDirective(
  policy: string,
  directive: string,
  origins: readonly string[],
  replace = false,
): string {
  const parts = policy.split(";").map((part) => part.trim());
  const index = parts.findIndex((part) => part.startsWith(`${directive} `));
  const existing = replace || index === -1 ? [] : (parts[index]?.split(/\s+/u).slice(1) ?? []);
  const sources = [...new Set([...existing.filter((source) => source !== "'none'"), ...origins])];
  const value = `${directive} ${sources.join(" ")}`;
  if (index === -1) parts.push(value);
  else parts[index] = value;
  return parts.join("; ");
}

/**
 * Whether a response's Set-Cookie header must not reach the browser, because it would store the named platform cookie.
 * A browser trims spaces and tabs around the cookie name, so `name =value` stores the same cookie; a header with no
 * "=" in its first segment is refused too, since a browser keeps it under an empty name.
 */
export function refusesPlatformCookie(setCookie: string, name: string): boolean {
  const first = setCookie.split(";", 1)[0] ?? "";
  const equals = first.indexOf("=");
  if (equals === -1) return true;
  return first.slice(0, equals).replace(/^[ \t]+|[ \t]+$/gu, "") === name;
}

/** Configured origins extend the existing same-origin mutation rule; cookies need explicit consent. */
export function isBrowserMutationAllowed(request: Request, policy?: BrowserPolicy): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return !request.headers.has("cookie");
  if (origin === new URL(request.url).origin) return true;
  return (
    policy?.cors.origins.includes(origin) === true &&
    (!request.headers.has("cookie") || policy.cors.credentials)
  );
}

/** Application CORS is retained only when both the stored policy and exact response authorize it. */
export function secureBrowserCors(
  headers: Headers,
  actualOrigin: string | null,
  policy?: BrowserPolicy,
): void {
  const source = new Headers(headers);
  for (const name of [...headers.keys()])
    if (name.startsWith("access-control-")) headers.delete(name);
  if (policy === undefined || policy.cors.origins.length === 0) return;
  const vary = headers.get("vary");
  if (!vary?.split(",").some((value) => ["origin", "*"].includes(value.trim().toLowerCase())))
    headers.append("vary", "Origin");
  if (
    actualOrigin === null ||
    !policy.cors.origins.includes(actualOrigin) ||
    source.get("access-control-allow-origin") !== actualOrigin
  )
    return;
  headers.set("access-control-allow-origin", actualOrigin);
  if (policy.cors.credentials && source.get("access-control-allow-credentials") === "true")
    headers.set("access-control-allow-credentials", "true");
  for (const name of [
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "access-control-max-age",
  ]) {
    const value = safeCorsValue(name, source.get(name));
    if (value !== null) headers.set(name, value);
  }
}

function safeCorsValue(name: string, value: string | null): string | null {
  if (value === null || value.length > 4096) return null;
  if (name === "access-control-max-age")
    return /^\d{1,8}$/u.test(value) ? String(Math.min(Number(value), 600)) : null;
  const items = value.split(",").map((item) => item.trim());
  const token =
    name === "access-control-allow-methods"
      ? /^[A-Z][A-Z0-9-]{0,31}$/u
      : /^[!#$%&'+.^_`|~0-9A-Za-z-]{1,64}$/u;
  return items.length <= 32 && items.every((item) => token.test(item)) ? value : null;
}
