import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createBase64GithubAppJwtIssuer, SourceFetcherConfigurationError } from "../src/index.js";

async function privateKeyBase64(): Promise<string> {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  return Buffer.from(bytes).toString("base64");
}

describe("in-process GitHub App signer", () => {
  it("imports a non-extractable PKCS#8 secret and issues only a short-lived JWT", async () => {
    const now = new Date("2026-08-19T20:00:00.000Z");
    const issuer = createBase64GithubAppJwtIssuer({
      clientId: "Iv23Example000000001",
      privateKeyBase64: await privateKeyBase64(),
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });
    const jwt = await issuer.issue(now);
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8")) as {
      iss: string;
      exp: number;
    };
    expect(claims).toMatchObject({ iss: "Iv23Example000000001" });
    expect(claims.exp).toBe(Math.floor(now.getTime() / 1_000) + 9 * 60);
    expect(jwt).not.toContain("PRIVATE KEY");
  });

  it("fails closed for malformed secret material", async () => {
    const issuer = createBase64GithubAppJwtIssuer({
      clientId: "Iv23Example000000001",
      privateKeyBase64: "bm90LWEtcHJpdmF0ZS1rZXk=",
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });
    await expect(issuer.issue(new Date())).rejects.toBeInstanceOf(SourceFetcherConfigurationError);
  });
});
