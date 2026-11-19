import { beforeAll, describe, expect, it, vi } from "vitest";

import { InvalidWorkosJwksError, InvalidWorkosTokenError, verifyWorkosToken } from "./index.js";

const encodeBytes = (value: Uint8Array) => {
  const binary = [...value].map((byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
const encode = (value: unknown) => encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
const nowSeconds = Date.parse("2026-08-18T10:00:00Z") / 1_000;
let privateKey: Parameters<typeof globalThis.crypto.subtle.sign>[1];
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const generated = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) throw new Error("RSA fixture did not return a key pair");
  const pair = generated;
  privateKey = pair.privateKey;
  jwks = {
    keys: [
      {
        ...(await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey)),
        alg: "RS256",
        use: "sig",
        kid: "key_1",
      },
    ],
  };
});

const token = async (
  claims: Record<string, unknown>,
  headerValue: Record<string, unknown> = { alg: "RS256", kid: "key_1", typ: "JWT" },
) => {
  const header = encode(headerValue);
  const payload = encode(claims);
  const signature = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBytes(new Uint8Array(signature))}`;
};

const dependencies = () => ({
  jwks: { load: vi.fn(async () => jwks) },
  clock: { now: () => new Date("2026-08-18T10:00:00Z") },
});

describe("offline WorkOS token verifier", () => {
  it("verifies delegated Connect users only for their exact MCP resource and unexpired signed token", async () => {
    const policy = {
      kind: "connect_user",
      issuer: "https://connect.example.test",
      audience: "https://app.ohmyho.st/mcp",
    } as const;
    const claims = {
      iss: policy.issuer,
      aud: policy.audience,
      sub: "user_1",
      client_id: "client_chat",
      org_id: "org_1",
      sid: "app_consent_1",
      scope: "openid profile",
      iat: nowSeconds,
      exp: nowSeconds + 300,
    };
    const signed = await token(claims);
    await expect(verifyWorkosToken(signed, policy, dependencies())).resolves.toMatchObject({
      kind: "connect_user",
      clientId: "client_chat",
      consentId: "app_consent_1",
      subject: "user_1",
      audience: [policy.audience],
    });
    for (const [change, code] of [
      [{ iss: "https://other-issuer.example.test" }, "invalid_issuer"],
      [{ aud: "https://app.ohmyho.st" }, "invalid_audience"],
      [{ aud: [policy.audience, "https://other-api.example.test"] }, "invalid_audience"],
      [{ sid: "session_1" }, "invalid_consent"],
      [{ sub: "client_1" }, "invalid_principal_kind"],
      [{ iat: nowSeconds - 1, exp: nowSeconds }, "token_expired"],
      [{ iat: nowSeconds - 1, exp: nowSeconds - 1 }, "invalid_token_lifetime"],
    ] as const) {
      await expect(
        verifyWorkosToken(await token({ ...claims, ...change }), policy, dependencies()),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      verifyWorkosToken(
        signed,
        { kind: "m2m", issuer: policy.issuer, audience: policy.audience },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_principal_kind" });
    const parts = signed.split(".") as [string, string, string];
    await expect(
      verifyWorkosToken(
        `${parts[0]}.${encode({ ...claims, sub: "user_other" })}.${parts[2]}`,
        policy,
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_jwt_signature" });
  });

  it("verifies real RS256 and official AuthKit session claims", async () => {
    const deps = dependencies();
    const signed = await token({
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      org_id: "org_1",
      sid: "session_1",
      permissions: ["projects:read"],
      iat: nowSeconds,
      exp: nowSeconds + 300,
    });
    await expect(
      verifyWorkosToken(
        signed,
        { issuer: "https://auth.example.test", clientId: "client_public", kind: "session" },
        deps,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      subject: "user_1",
      clientId: "client_public",
      permissions: ["projects:read"],
    });
    expect(deps.jwks.load).toHaveBeenCalledOnce();
    // The source needs the token's kid to refetch a rotated signing key.
    expect(deps.jwks.load).toHaveBeenCalledWith({ kid: "key_1" });
  });

  it("confines Connect audience tokens to the M2M claim contract", async () => {
    const signed = await token({
      iss: "https://connect.example.test",
      aud: ["control-api"],
      sub: "client_1",
      org_id: "org_1",
      sid: "consent_1",
      scope: "projects:read operations:read",
      iat: nowSeconds,
      exp: nowSeconds + 300,
    });
    await expect(
      verifyWorkosToken(
        signed,
        { issuer: "https://connect.example.test", audience: "control-api", kind: "m2m" },
        dependencies(),
      ),
    ).resolves.toMatchObject({
      kind: "m2m",
      clientId: "client_1",
      organizationId: "org_1",
    });
    await expect(
      verifyWorkosToken(
        signed,
        { issuer: "https://connect.example.test", clientId: "client_public", kind: "session" },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_principal_kind" });
    await expect(
      verifyWorkosToken(
        signed,
        { issuer: "https://connect.example.test", audience: "wrong-audience", kind: "m2m" },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_audience" });
  });

  it("redacts malformed contents and rejects a tampered real signature", async () => {
    const secret = "sensitive-token-fragment";
    await expect(
      verifyWorkosToken(
        secret,
        { issuer: "https://auth.example.test", clientId: "client_public", kind: "session" },
        dependencies(),
      ),
    ).rejects.toMatchObject({
      name: "InvalidWorkosTokenError",
      code: "invalid_jwt",
      message: expect.not.stringContaining(secret),
    });

    const signed = await token({
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      iat: nowSeconds,
      exp: nowSeconds + 300,
    });
    const [header, payload, signature] = signed.split(".") as [string, string, string];
    const tamperedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const tampered = `${header}.${payload}.${tamperedSignature}`;
    await expect(
      verifyWorkosToken(
        tampered,
        { issuer: "https://auth.example.test", clientId: "client_public", kind: "session" },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_jwt_signature" });
  });

  it("exports verifier-owned auth errors while preserving JWKS infrastructure failures", async () => {
    const signed = await token({
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      iat: nowSeconds,
      exp: nowSeconds + 300,
    });
    const policy = {
      issuer: "https://auth.example.test",
      clientId: "client_public",
      kind: "session",
    } as const;
    const malformed = verifyWorkosToken("not-a-jwt", policy, dependencies());
    await expect(malformed).rejects.toBeInstanceOf(InvalidWorkosTokenError);

    const invalidJwks = verifyWorkosToken(signed, policy, {
      jwks: { load: async () => ({ keys: [{ broken: true }] }) },
      clock: dependencies().clock,
    });
    await expect(invalidJwks).rejects.toBeInstanceOf(InvalidWorkosJwksError);

    const outage = new Error("JWKS network unavailable");
    const infrastructureFailure = verifyWorkosToken(signed, policy, {
      jwks: {
        load: async () => {
          throw outage;
        },
      },
      clock: dependencies().clock,
    });
    await expect(infrastructureFailure).rejects.toBe(outage);
  });

  it("fails closed across temporal, client, signing-key, algorithm, and clock failures", async () => {
    const base = {
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      iat: nowSeconds,
      exp: nowSeconds + 300,
    };
    const policy = {
      issuer: "https://auth.example.test",
      clientId: "client_public",
      kind: "session",
    } as const;

    await expect(
      verifyWorkosToken(await token({ ...base, exp: nowSeconds - 31 }), policy, dependencies()),
    ).rejects.toMatchObject({ code: "token_expired" });
    await expect(
      verifyWorkosToken(await token({ ...base, nbf: nowSeconds + 31 }), policy, dependencies()),
    ).rejects.toMatchObject({ code: "token_not_active" });
    await expect(
      verifyWorkosToken(await token({ ...base, iat: nowSeconds + 31 }), policy, dependencies()),
    ).rejects.toMatchObject({ code: "token_issued_in_future" });
    await expect(
      verifyWorkosToken(await token({ ...base, iat: nowSeconds - 3_631 }), policy, dependencies()),
    ).rejects.toMatchObject({ code: "token_too_old" });
    await expect(
      verifyWorkosToken(
        await token({ ...base, client_id: "other_client" }),
        policy,
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_client" });
    await expect(
      verifyWorkosToken(
        await token(base),
        { ...policy, issuer: "https://wrong-issuer.example" },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "invalid_issuer" });
    await expect(
      verifyWorkosToken(
        await token(base, { alg: "RS256", kid: "unknown_key" }),
        policy,
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "unknown_signing_key" });
    await expect(
      verifyWorkosToken(await token(base, { alg: "HS256", kid: "key_1" }), policy, dependencies()),
    ).rejects.toMatchObject({ code: "unsupported_algorithm" });
    await expect(
      verifyWorkosToken(await token(base), policy, {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date(Number.NaN) },
      }),
    ).rejects.toMatchObject({ code: "invalid_clock" });
  });
});
