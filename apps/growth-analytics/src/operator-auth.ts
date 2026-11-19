import type { OperatorPrincipal } from "./operator-routes.js";

type AccessKey = JsonWebKey & { kid?: string; alg?: string };
const cache = new Map<string, { until: number; keys: AccessKey[] }>();
async function readKeys(response: Response): Promise<AccessKey[]> {
  if (!response.ok || !response.body) throw new Error("access keys unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 65536) throw new Error("access keys too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !value ||
    typeof value !== "object" ||
    !("keys" in value) ||
    !Array.isArray(value.keys) ||
    value.keys.length > 32
  )
    throw new Error("invalid access keys");
  return value.keys as AccessKey[];
}
/** Verify the Access assertion itself: edge policy and customer roles are not authorization substitutes. */
export async function verifyOperatorAccess(
  request: Request,
  config: {
    issuer: string;
    audience: string;
    environment: "development" | "production";
    permissions: Record<string, string[]>;
    fetcher?: typeof fetch;
  },
): Promise<OperatorPrincipal | null> {
  try {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (
      !token ||
      token.length > 16384 ||
      !config.audience ||
      config.audience.length > 200 ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(config.issuer)
    )
      return null;
    const parts = token.split(".");
    const [headerPart, payloadPart, signaturePart] = parts;
    if (
      !headerPart ||
      !payloadPart ||
      !signaturePart ||
      parts.length !== 3 ||
      parts.some((p) => !/^[A-Za-z0-9_-]+$/u.test(p)) ||
      headerPart.length > 2048
    )
      return null;
    const decode = (part: string) =>
      Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const header: unknown = JSON.parse(new TextDecoder().decode(decode(headerPart)));
    const payload: unknown = JSON.parse(new TextDecoder().decode(decode(payloadPart)));
    if (
      !header ||
      typeof header !== "object" ||
      Array.isArray(header) ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return null;
    const h = header as Record<string, unknown>,
      c = payload as Record<string, unknown>,
      now = Date.now() / 1000;
    if (
      h["alg"] !== "RS256" ||
      typeof h["kid"] !== "string" ||
      h["kid"].length > 200 ||
      c["iss"] !== config.issuer ||
      typeof c["sub"] !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/u.test(c["sub"]) ||
      typeof c["exp"] !== "number" ||
      !Number.isSafeInteger(c["exp"]) ||
      c["exp"] <= now ||
      (c["nbf"] !== undefined &&
        (typeof c["nbf"] !== "number" || !Number.isSafeInteger(c["nbf"]) || c["nbf"] > now + 60)) ||
      !(Array.isArray(c["aud"])
        ? c["aud"].length <= 10 &&
          c["aud"].every((x) => typeof x === "string") &&
          c["aud"].includes(config.audience)
        : c["aud"] === config.audience)
    )
      return null;
    const cached = cache.get(config.issuer);
    let keys =
      config.fetcher === undefined && cached && cached.until > Date.now() ? cached.keys : null;
    if (!keys || !keys.some((k) => k.kid === h["kid"])) {
      keys = await readKeys(
        await (config.fetcher ?? fetch)(`${config.issuer}/cdn-cgi/access/certs`, {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        }),
      );
      if (config.fetcher === undefined)
        cache.set(config.issuer, { until: Date.now() + 300000, keys });
    }
    const jwk = keys.find(
      (k) =>
        k.kid === h["kid"] &&
        k.kty === "RSA" &&
        (!k.alg || k.alg === "RS256") &&
        typeof k.n === "string" &&
        typeof k.e === "string",
    );
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decode(signaturePart),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      return null;
    const email =
      typeof c["email"] === "string" && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/u.test(c["email"])
        ? c["email"].toLowerCase()
        : null;
    const permissionKey = Object.hasOwn(config.permissions, c["sub"])
      ? c["sub"]
      : email && Object.hasOwn(config.permissions, `email:${email}`)
        ? `email:${email}`
        : null;
    const permissions = permissionKey ? config.permissions[permissionKey] : [];
    if (
      !Array.isArray(permissions) ||
      !permissions.every((p) =>
        [
          "growth.read_aggregate",
          "growth.read_identity",
          "growth.manage_experiments",
          "growth.manage_segments",
        ].includes(p),
      )
    )
      return null;
    return { subject: c["sub"], permissions };
  } catch {
    return null;
  }
}
