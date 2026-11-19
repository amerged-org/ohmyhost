import { expect, test, vi } from "vitest";
import { revokeMakeToken } from "../src/providers/make-oauth.js";
import { makeRegistration } from "../src/registry.js";
import { verifyMakeIdToken } from "../src/oidc.js";
const b64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const json = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));

test("identity requires a pinned issuer, audience, nonce and valid Make signature", async () => {
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "k",
    alg: "RS256",
    use: "sig",
  };
  const claims = {
    iss: "https://www.make.com",
    aud: "client",
    sub: "subject",
    nonce: "nonce",
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
  };
  const issue = async (payload: object) => {
    const prefix = `${json({ alg: "RS256", kid: "k" })}.${json(payload)}`;
    return `${prefix}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(prefix))))}`;
  };
  const fetcher = async () => Response.json({ keys: [jwk] });
  const token = await issue(claims);
  expect(await verifyMakeIdToken(token, "client", "nonce", fetcher)).toBe("subject");
  const withoutNonce = Object.fromEntries(
    Object.entries(claims).filter(([key]) => key !== "nonce"),
  );
  const unrequested = await issue(withoutNonce);
  expect(await verifyMakeIdToken(unrequested, "client", null, fetcher)).toBe("subject");
  await expect(
    verifyMakeIdToken(unrequested, "client", undefined as never, fetcher),
  ).rejects.toThrow("invalid_id_token");
  await expect(verifyMakeIdToken(unrequested, "client", "nonce", fetcher)).rejects.toThrow(
    "invalid_id_token",
  );
  await expect(verifyMakeIdToken(token, "client", null, fetcher)).rejects.toThrow(
    "invalid_id_token",
  );
  for (const [changed, reason] of [
    [{ iss: "https://evil.example" }, "issuer"],
    [{ aud: "other" }, "audience"],
    [{ nonce: "other" }, "nonce"],
    [{ exp: 1 }, "expiry"],
    [{ sub: "" }, "subject"],
  ] as const) {
    await expect(
      verifyMakeIdToken(await issue({ ...claims, ...changed }), "client", "nonce", fetcher),
    ).rejects.toThrow("invalid_id_token");
    expect(JSON.parse(String(logs.mock.lastCall?.[0]))).toEqual({
      event: "connection_broker_failure",
      phase: "oidc",
      reason,
    });
  }
  await expect(
    verifyMakeIdToken("private-malformed-token", "client", "nonce", fetcher),
  ).rejects.toThrow("invalid_id_token");
  expect(JSON.parse(String(logs.mock.lastCall?.[0])).reason).toBe("format");
  const segments = token.split(".");
  await expect(
    verifyMakeIdToken(
      `${json({ alg: "none", kid: "k" })}.${segments[1]}.${segments[2]}`,
      "client",
      "nonce",
      fetcher,
    ),
  ).rejects.toThrow("invalid_id_token");
  expect(JSON.parse(String(logs.mock.lastCall?.[0])).reason).toBe("header");
  await expect(
    verifyMakeIdToken(
      await issue({ ...claims, aud: ["client", "other"], azp: "private-other" }),
      "client",
      "nonce",
      fetcher,
    ),
  ).rejects.toThrow("invalid_id_token");
  expect(JSON.parse(String(logs.mock.lastCall?.[0])).reason).toBe("azp");
  for (const [failure, reason] of [
    [
      async () => {
        throw new Error("private-network-error");
      },
      "jwks_network",
    ],
    [async () => new Response("private-provider-body", { status: 503 }), "jwks_http"],
    [async () => new Response("private-malformed-json"), "jwks_payload"],
    [async () => Response.json({ keys: [] }), "jwks_key"],
  ] as const) {
    await expect(verifyMakeIdToken(token, "client", "nonce", failure)).rejects.toThrow(
      "invalid_id_token",
    );
    expect(JSON.parse(String(logs.mock.lastCall?.[0])).reason).toBe(reason);
  }
  const signature = segments[2] ?? "";
  const changed = `${segments[0]}.${segments[1]}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await expect(verifyMakeIdToken(changed, "client", "nonce", fetcher)).rejects.toThrow(
    "invalid_id_token",
  );
  expect(JSON.parse(String(logs.mock.lastCall?.[0]))).toEqual({
    event: "connection_broker_failure",
    phase: "oidc",
    reason: "signature",
  });
  const revokeClient = { clientId: "private-client", clientSecret: "private-secret" };
  for (const [response, reason] of [
    [async () => new Response(null, { status: 302 }), "http_3xx"],
    [async () => new Response("private-provider-body", { status: 404 }), "http_4xx"],
    [async () => new Response(null, { status: 503 }), "http_5xx"],
    [
      async () => {
        throw new Error("private-network-error");
      },
      "network",
    ],
  ] as const) {
    await expect(
      revokeMakeToken(makeRegistration("development"), revokeClient, "private-token", response),
    ).rejects.toThrow("revocation_outcome_unknown");
    expect(JSON.parse(String(logs.mock.lastCall?.[0]))).toEqual({
      event: "connection_broker_failure",
      phase: "revocation",
      reason,
    });
  }
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-|evil\.example/);
  logs.mockRestore();
});
