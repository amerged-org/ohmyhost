import { generateKeyPairSync, webcrypto } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { GithubProviderInputError } from "./errors.js";
import { createGithubAppJwt } from "./app-jwt.js";
import { createGitHubAppJwtIssuer } from "./source-provider.js";

let privateKey: webcrypto.CryptoKey;
let publicKey: webcrypto.CryptoKey;
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

beforeAll(async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    pair.privateKey.export({ format: "der", type: "pkcs8" }),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  publicKey = await webcrypto.subtle.importKey(
    "spki",
    pair.publicKey.export({ format: "der", type: "spki" }),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
});

describe("GitHub App JWT", () => {
  it("creates a canonical RS256 JWT with GitHub's bounded clock claims", async () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const jwt = await createGithubAppJwt({ clientId: "Iv1.client123", privateKey, now });
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");

    expect(encodedHeader).toBeTypeOf("string");
    expect(encodedPayload).toBeTypeOf("string");
    expect(encodedSignature).toBeTypeOf("string");
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw new TypeError("JWT must contain exactly three encoded segments");
    }

    expect(encodedHeader).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encodedPayload).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encodedSignature).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))).toEqual({
      iat: 1_787_140_740,
      exp: 1_787_141_340,
      iss: "Iv1.client123",
    });
    await expect(
      webcrypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        Buffer.from(encodedSignature, "base64url"),
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    ["empty client ID", { clientId: "", privateKey, now: new Date() }],
    ["invalid clock", { clientId: "client", privateKey, now: new Date(Number.NaN) }],
  ])("rejects %s without credential details", async (_name, input) => {
    await expect(createGithubAppJwt(input)).rejects.toMatchObject({
      name: "GithubProviderInputError",
      message: "GitHub provider input is invalid",
    });
  });

  it("rejects extractable or non-signing keys", async () => {
    const extractable = await webcrypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign"],
    );
    await expect(
      createGithubAppJwt({ clientId: "client", privateKey: extractable, now: new Date() }),
    ).rejects.toBeInstanceOf(GithubProviderInputError);
  });

  it("rejects an RSA signing key bound to a hash other than SHA-256", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sha384Key = await webcrypto.subtle.importKey(
      "pkcs8",
      pair.privateKey.export({ format: "der", type: "pkcs8" }),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
      false,
      ["sign"],
    );
    await expect(
      createGithubAppJwt({ clientId: "client", privateKey: sha384Key, now: new Date() }),
    ).rejects.toMatchObject({ code: "invalid_app_private_key" });
  });

  it("redacts signing failures behind a stable key error", async () => {
    const crypto = {
      sign: async () => {
        throw new Error("private signing implementation detail");
      },
    } as unknown as SubtleCrypto;
    const failure = await createGithubAppJwt({
      clientId: "client",
      privateKey,
      now: new Date(),
      crypto,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "GithubProviderInputError",
      code: "invalid_app_private_key",
      message: "GitHub provider input is invalid",
    });
    expect(String(failure)).not.toContain("implementation detail");
  });

  it("wraps the injected non-extractable key as a credential capability", async () => {
    const issuer = createGitHubAppJwtIssuer({
      clientId: "Iv1.client123",
      privateKey,
      crypto: subtle,
    });
    await expect(issuer.issue(new Date("2026-08-19T12:00:00.000Z"))).resolves.toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
  });
});
