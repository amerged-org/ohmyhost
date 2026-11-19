import { parseUlid } from "@ohmyhost/platform";
import { parseProjectHandle } from "@ohmyhost/project-handles";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  DEV_ACCESS_SESSION_TTL_SECONDS,
  DEV_ACCESS_SESSION_CLOCK_SKEW_SECONDS,
  DEV_ACCESS_SESSION_MAX_TOKEN_LENGTH,
  DEV_RUNTIME_PROBE_TTL_SECONDS,
  DEV_ACCESS_TICKET_TTL_SECONDS,
  createDevAccessTicket,
  digestDevAccessPublicJwk,
  digestDevAccessTicket,
  signDevAccessSession,
  signDevRuntimeProbe,
  proveDevAccessSigningKeyPair,
  validateDevAccessPublicJwk,
  verifyDevAccessSession,
  verifyDevRuntimeProbe,
} from "../src/index.js";

const scope = Object.freeze({
  projectId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDM"),
  environmentId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDN"),
  handle: parseProjectHandle("calm-otter-waves"),
  origin: "https://dev-calm-otter-waves.dev.check.omh.st",
});
const issuedAt = "2026-08-25T12:00:00.000Z";
const expiresAt = "2026-08-26T00:00:00.000Z";

describe("dev access token contracts", () => {
  it("creates exactly 32 random bytes and exposes only a stable SHA-256 digest for persistence", async () => {
    const first = await createDevAccessTicket(globalThis.crypto);
    const second = await createDevAccessTicket(globalThis.crypto);

    expect(DEV_ACCESS_TICKET_TTL_SECONDS).toBe(3_600);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.token).not.toBe(second.token);
    expect(first.digest).toHaveLength(32);
    expect(await digestDevAccessTicket(globalThis.crypto, first.token)).toEqual(first.digest);
    await expect(digestDevAccessTicket(globalThis.crypto, "invalid")).rejects.toThrow(
      "Dev access ticket is invalid",
    );
  });

  it("signs and verifies one exact root-bound twelve-hour dev session", async () => {
    const pair = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwk = exactPublicJwk(
      await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
    );
    const kid = await digestDevAccessPublicJwk(globalThis.crypto, publicJwk);
    const token = await signDevAccessSession(globalThis.crypto, privateJwk, {
      ...scope,
      subjectId: "user:user_1",
      devAccessEpoch: 7,
      kid,
      issuedAt,
      expiresAt,
    });

    expect(DEV_ACCESS_SESSION_TTL_SECONDS).toBe(43_200);
    expect(DEV_ACCESS_SESSION_CLOCK_SKEW_SECONDS).toBe(30);
    expect(DEV_ACCESS_SESSION_MAX_TOKEN_LENGTH).toBe(2_048);
    expect(token.split(".")).toHaveLength(2);
    await expect(
      verifyDevAccessSession(globalThis.crypto, publicJwk, token, scope, issuedAt),
    ).resolves.toMatchObject({
      ...scope,
      subjectId: "user:user_1",
      devAccessEpoch: 7,
      issuer: "ohmyhost",
      audience: "ohmyhost:dev-gateway",
      kid,
      path: "/",
    });
    await expect(
      verifyDevAccessSession(
        globalThis.crypto,
        publicJwk,
        token,
        {
          ...scope,
          handle: parseProjectHandle("quiet-raven-builds"),
          origin: "https://dev-quiet-raven-builds.dev.check.omh.st",
        },
        issuedAt,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyDevAccessSession(globalThis.crypto, publicJwk, token, scope, expiresAt),
    ).resolves.toBeNull();
    const productionScope = { ...scope, origin: "https://dev-calm-otter-waves.check.omh.st" };
    await expect(
      verifyDevAccessSession(globalThis.crypto, publicJwk, token, productionScope, issuedAt),
    ).resolves.toBeNull();
    const productionToken = await signDevAccessSession(globalThis.crypto, privateJwk, {
      ...productionScope,
      subjectId: "user:user_1",
      devAccessEpoch: 7,
      kid,
      issuedAt,
      expiresAt,
    });
    await expect(
      verifyDevAccessSession(
        globalThis.crypto,
        publicJwk,
        productionToken,
        productionScope,
        issuedAt,
      ),
    ).resolves.toMatchObject(productionScope);
    await expect(
      verifyDevAccessSession(globalThis.crypto, publicJwk, productionToken, scope, issuedAt),
    ).resolves.toBeNull();
    const futureIssuedAt = "2026-08-25T12:00:30.000Z";
    const futureToken = await signDevAccessSession(globalThis.crypto, privateJwk, {
      ...scope,
      subjectId: "user:user_1",
      devAccessEpoch: 7,
      kid,
      issuedAt: futureIssuedAt,
      expiresAt: "2026-08-26T00:00:30.000Z",
    });
    await expect(
      verifyDevAccessSession(globalThis.crypto, publicJwk, futureToken, scope, issuedAt),
    ).resolves.not.toBeNull();
    await expect(
      verifyDevAccessSession(
        globalThis.crypto,
        publicJwk,
        futureToken,
        scope,
        "2026-08-25T11:59:59.999Z",
      ),
    ).resolves.toBeNull();
  });

  it("signs one short-lived exact read-only deployment runtime probe", async () => {
    const pair = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwk = exactPublicJwk(
      await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
    );
    const kid = await digestDevAccessPublicJwk(globalThis.crypto, publicJwk);
    const probeScope = {
      organizationId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDP"),
      ...scope,
      operationId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDQ"),
      deploymentId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDR"),
      path: "/health",
      method: "GET" as const,
    };
    const probeExpiresAt = new Date(
      Date.parse(issuedAt) + DEV_RUNTIME_PROBE_TTL_SECONDS * 1_000,
    ).toISOString();
    const token = await signDevRuntimeProbe(globalThis.crypto, privateJwk, {
      ...probeScope,
      kid,
      issuedAt,
      expiresAt: probeExpiresAt,
    });

    expect(DEV_RUNTIME_PROBE_TTL_SECONDS).toBe(60);
    await expect(
      verifyDevRuntimeProbe(globalThis.crypto, publicJwk, token, probeScope, issuedAt),
    ).resolves.toMatchObject({
      ...probeScope,
      version: "ohmyhost.dev-runtime-probe/v1",
      audience: "ohmyhost:dev-runtime-probe",
      kid,
    });
    for (const changedScope of [
      {
        ...probeScope,
        operationId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDS"),
      },
      {
        ...probeScope,
        deploymentId: parseUlid("01M0G4WP010GZ77JSDCJEPYJDT"),
      },
      { ...probeScope, path: "/other" },
      { ...probeScope, method: "HEAD" as const },
      {
        ...probeScope,
        handle: parseProjectHandle("quiet-raven-builds"),
        origin: "https://dev-quiet-raven-builds.dev.check.omh.st",
      },
    ]) {
      await expect(
        verifyDevRuntimeProbe(globalThis.crypto, publicJwk, token, changedScope, issuedAt),
      ).resolves.toBeNull();
    }
    await expect(
      verifyDevRuntimeProbe(
        globalThis.crypto,
        publicJwk,
        `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
        probeScope,
        issuedAt,
      ),
    ).resolves.toBeNull();
    const wrongKidToken = await signDevRuntimeProbe(globalThis.crypto, privateJwk, {
      ...probeScope,
      kid: `sha256:${"0".repeat(64)}`,
      issuedAt,
      expiresAt: probeExpiresAt,
    });
    await expect(
      verifyDevRuntimeProbe(globalThis.crypto, publicJwk, wrongKidToken, probeScope, issuedAt),
    ).resolves.toBeNull();
    await expect(
      verifyDevRuntimeProbe(globalThis.crypto, publicJwk, token, probeScope, probeExpiresAt),
    ).resolves.toBeNull();
    await expect(
      signDevRuntimeProbe(globalThis.crypto, privateJwk, {
        ...probeScope,
        method: "POST",
        kid,
        issuedAt,
        expiresAt: probeExpiresAt,
      }),
    ).rejects.toThrow("Dev runtime probe scope is invalid");
  });

  it("rejects widened claims, invalid lifetimes, and signatures from another key", async () => {
    const first = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const second = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", first.privateKey);
    const publicJwk = exactPublicJwk(
      await globalThis.crypto.subtle.exportKey("jwk", first.publicKey),
    );
    const kid = await digestDevAccessPublicJwk(globalThis.crypto, publicJwk);
    const wrongPublicJwk = exactPublicJwk(
      await globalThis.crypto.subtle.exportKey("jwk", second.publicKey),
    );
    await expect(
      signDevAccessSession(globalThis.crypto, privateJwk, {
        ...scope,
        subjectId: "user:user_1",
        devAccessEpoch: 7,
        kid,
        issuedAt,
        expiresAt: "2026-08-26T00:00:01.000Z",
      }),
    ).rejects.toThrow("Dev access session claims are invalid");
    for (const origin of [
      "https://dev-calm-otter-waves.your-omh-account.workers.dev",
      "https://dev-calm-otter-waves.attacker.example",
    ]) {
      await expect(
        signDevAccessSession(globalThis.crypto, privateJwk, {
          ...scope,
          origin,
          subjectId: "user:user_1",
          devAccessEpoch: 7,
          kid,
          issuedAt,
          expiresAt,
        }),
      ).rejects.toThrow("Dev access scope is invalid");
    }
    await expect(
      signDevAccessSession(globalThis.crypto, privateJwk, {
        ...scope,
        subjectId: "user:user_1",
        devAccessEpoch: 7,
        kid,
        issuedAt,
        expiresAt,
        extra: true,
      } as never),
    ).rejects.toThrow("Dev access session claims are invalid");
    const token = await signDevAccessSession(globalThis.crypto, privateJwk, {
      ...scope,
      subjectId: "user:user_1",
      devAccessEpoch: 7,
      kid,
      issuedAt,
      expiresAt,
    });
    await expect(
      verifyDevAccessSession(globalThis.crypto, wrongPublicJwk, token, scope, issuedAt),
    ).resolves.toBeNull();
    const wrongKidToken = await signDevAccessSession(globalThis.crypto, privateJwk, {
      ...scope,
      subjectId: "user:user_1",
      devAccessEpoch: 7,
      kid: `sha256:${"0".repeat(64)}`,
      issuedAt,
      expiresAt,
    });
    await expect(
      verifyDevAccessSession(globalThis.crypto, publicJwk, wrongKidToken, scope, issuedAt),
    ).resolves.toBeNull();
    await expect(
      verifyDevAccessSession(
        globalThis.crypto,
        publicJwk,
        `${"A".repeat(2_049)}.${"A".repeat(86)}`,
        scope,
        issuedAt,
      ),
    ).resolves.toBeNull();
    await expect(
      digestDevAccessPublicJwk(globalThis.crypto, { kty: "oct", k: "secret" }),
    ).rejects.toThrow("Dev access public JWK is invalid");
    await expect(validateDevAccessPublicJwk(globalThis.crypto, publicJwk)).resolves.toEqual(
      publicJwk,
    );
    expect(Object.isFrozen(await validateDevAccessPublicJwk(globalThis.crypto, publicJwk))).toBe(
      true,
    );
    await expect(
      proveDevAccessSigningKeyPair(globalThis.crypto, privateJwk, publicJwk),
    ).resolves.toBe(kid);
    await expect(
      proveDevAccessSigningKeyPair(globalThis.crypto, privateJwk, wrongPublicJwk),
    ).rejects.toThrow("Dev access signing key pair is invalid");
    await expect(
      validateDevAccessPublicJwk(globalThis.crypto, {
        ...publicJwk,
        x: `${String(publicJwk.x).slice(0, -1)}!`,
      }),
    ).rejects.toThrow();
    for (const widened of [
      { ...publicJwk, d: "private-sentinel" },
      { ...publicJwk, alg: "ES256" },
      { ...publicJwk, key_ops: ["verify"] },
      { ...publicJwk, ext: true },
      { ...publicJwk, use: "sig" },
      { ...publicJwk, kid: "unexpected" },
      { ...publicJwk, extra: "unexpected" },
    ]) {
      await expect(validateDevAccessPublicJwk(globalThis.crypto, widened)).rejects.toThrow(
        "Dev access public JWK is invalid",
      );
    }
    const hiddenPrivate = Object.defineProperty({ ...publicJwk }, "d", {
      value: "private-sentinel",
      enumerable: false,
    });
    await expect(validateDevAccessPublicJwk(globalThis.crypto, hiddenPrivate)).rejects.toThrow(
      "Dev access public JWK is invalid",
    );
    const symbolWidened = { ...publicJwk } as JsonWebKey & Record<symbol, string>;
    symbolWidened[Symbol("private")] = "private-sentinel";
    await expect(validateDevAccessPublicJwk(globalThis.crypto, symbolWidened)).rejects.toThrow(
      "Dev access public JWK is invalid",
    );
    await expect(
      validateDevAccessPublicJwk(globalThis.crypto, {
        ...publicJwk,
        x: "A".repeat(43),
        y: "A".repeat(43),
      }),
    ).rejects.toThrow();
  });

  it("keeps the gateway package free of Node runtime imports and Buffer", async () => {
    const source = await readFile(new URL("../src/tokens.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']node:/u);
    expect(source).not.toMatch(/\bBuffer\b/u);
  });
});

function exactPublicJwk(value: JsonWebKey): JsonWebKey {
  if (
    typeof value.kty !== "string" ||
    typeof value.crv !== "string" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new Error("generated public JWK is incomplete");
  }
  return { kty: value.kty, crv: value.crv, x: value.x, y: value.y };
}
