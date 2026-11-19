import type { IssuerDefense } from "./registry.js";
export type CallbackParameters = { state: string; code: string } | { state: string; error: string };
export function parseCallback(
  url: URL,
  issuer: string,
  defense: IssuerDefense,
): CallbackParameters {
  const params = url.searchParams;
  if (url.search.length > 8192) throw new Error("invalid_callback");
  for (const name of ["state", "code", "error", "iss"])
    if (params.getAll(name).length > 1) throw new Error("invalid_callback");
  const state = params.get("state"),
    code = params.get("code"),
    error = params.get("error"),
    iss = params.get("iss");
  if (
    !state ||
    state.length > 512 ||
    (code === null) === (error === null) ||
    (code !== null && (!code || code.length > 4096)) ||
    (error !== null && (!error || error.length > 256)) ||
    (iss !== null && iss !== issuer) ||
    defense === "signed-response" ||
    (defense === "rfc9207" && iss !== issuer)
  )
    throw new Error("invalid_callback");
  return code !== null ? { state, code } : { state, error: error ?? "" };
}
export function parseAttemptCookie(header: string | null): string | null {
  if (!header || header.length > 8192) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-omh-connect="))
    .map((part) => part.slice("__Host-omh-connect=".length));
  return values.length === 1 && /^[A-Za-z0-9_-]{1,512}$/.test(values[0] ?? "")
    ? (values[0] ?? "")
    : null;
}
