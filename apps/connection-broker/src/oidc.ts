const encoder = new TextEncoder();
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("invalid_id_token");
  const raw = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_id_token");
  return value as Record<string, unknown>;
}
export async function verifyMakeIdToken(
  token: string,
  clientId: string,
  nonce: string | null,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let reason:
    | "format"
    | "header"
    | "issuer"
    | "nonce"
    | "subject"
    | "expiry"
    | "audience"
    | "azp"
    | "jwks_network"
    | "jwks_http"
    | "jwks_payload"
    | "jwks_key"
    | "signature" = "format";
  try {
    if (
      token.length > 16384 ||
      !clientId ||
      (nonce !== null && (typeof nonce !== "string" || !nonce))
    )
      throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    reason = "header";
    const header = object(JSON.parse(new TextDecoder().decode(decode(parts[0] ?? ""))) as unknown);
    if (header["alg"] !== "RS256" || typeof header["kid"] !== "string" || !header["kid"])
      throw new Error();
    reason = "format";
    const claims = object(JSON.parse(new TextDecoder().decode(decode(parts[1] ?? ""))) as unknown);
    const now = Math.floor(Date.now() / 1000);
    reason = "issuer";
    if (claims["iss"] !== "https://www.make.com") throw new Error();
    reason = "nonce";
    if (nonce === null ? claims["nonce"] !== undefined : claims["nonce"] !== nonce)
      throw new Error();
    reason = "subject";
    if (typeof claims["sub"] !== "string" || !claims["sub"] || claims["sub"].length > 1024)
      throw new Error();
    reason = "expiry";
    if (
      typeof claims["exp"] !== "number" ||
      !Number.isFinite(claims["exp"]) ||
      claims["exp"] <= now ||
      typeof claims["iat"] !== "number" ||
      !Number.isFinite(claims["iat"]) ||
      claims["iat"] > now + 60
    )
      throw new Error();
    reason = "audience";
    const audience = claims["aud"];
    if (
      typeof audience === "string"
        ? audience !== clientId
        : !Array.isArray(audience) || !audience.includes(clientId)
    )
      throw new Error();
    reason = "azp";
    if (Array.isArray(audience) && audience.length > 1 && claims["azp"] !== clientId)
      throw new Error();
    reason = "expiry";
    if (
      claims["nbf"] !== undefined &&
      (typeof claims["nbf"] !== "number" || !Number.isFinite(claims["nbf"]) || claims["nbf"] > now)
    )
      throw new Error();
    reason = "azp";
    if (claims["azp"] !== undefined && claims["azp"] !== clientId) throw new Error();
    reason = "jwks_network";
    const response = await fetcher("https://www.make.com/oauth/v2/oidc/jwks", {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    reason = "jwks_http";
    if (!response.ok || !response.body) throw new Error();
    reason = "jwks_payload";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const jwks = object(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    if (!Array.isArray(jwks["keys"])) throw new Error();
    reason = "jwks_key";
    const matching = jwks["keys"]
      .map(object)
      .filter(
        (key) =>
          key["kid"] === header["kid"] &&
          key["kty"] === "RSA" &&
          (key["alg"] === undefined || key["alg"] === "RS256") &&
          (key["use"] === undefined || key["use"] === "sig"),
      );
    if (matching.length !== 1) throw new Error();
    const key = await crypto.subtle.importKey(
      "jwk",
      matching[0] ?? {},
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    reason = "signature";
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        new Uint8Array(decode(parts[2] ?? "")),
        encoder.encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      throw new Error();
    return claims["sub"];
  } catch {
    console.error(JSON.stringify({ event: "connection_broker_failure", phase: "oidc", reason }));
    throw new Error("invalid_id_token");
  }
}
