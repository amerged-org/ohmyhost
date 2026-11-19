import { describe, expect, it } from "vitest";

import {
  parseWorkosJwks,
  parseWorkosJwtHeader,
  parseWorkosTokenClaims,
  WorkosContractError,
} from "./index.js";

const commonClaims = {
  iss: "https://auth.example.test",
  sub: "user_1",
  iat: 1_787_047_200,
  exp: 1_787_047_500,
};
const validModulus = globalThis
  .btoa(String.fromCharCode(0x80, ...Array<number>(255).fill(1)))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/u, "");

describe("WorkOS token and JWKS contracts", () => {
  it("keeps delegated Connect identity separate from sessions, service tokens, and product permissions", () => {
    const claims = {
      ...commonClaims,
      aud: "https://app.ohmyho.st/mcp",
      client_id: "https://chat.example.test/oauth-client.json",
      org_id: "org_1",
      sid: "app_consent_1",
      jti: "token_1",
      scope: "openid profile openid offline_access",
      permissions: ["projects:write"],
    };
    expect(parseWorkosTokenClaims(claims, "connect_user")).toEqual({
      kind: "connect_user",
      issuer: commonClaims.iss,
      subject: "user_1",
      audience: ["https://app.ohmyho.st/mcp"],
      clientId: "https://chat.example.test/oauth-client.json",
      organizationId: "org_1",
      consentId: "app_consent_1",
      tokenId: "token_1",
      expiresAt: commonClaims.exp,
      issuedAt: commonClaims.iat,
      scopes: ["offline_access", "openid", "profile"],
    });
    expect(
      parseWorkosTokenClaims(
        { ...claims, org_id: undefined, jti: undefined, nbf: commonClaims.iat },
        "connect_user",
      ),
    ).toMatchObject({ notBefore: commonClaims.iat });
    expect(
      parseWorkosTokenClaims(
        { ...claims, ohmyhost_authorization: { actions: [], projectIds: ["A", "A"] } },
        "connect_user",
      ),
    ).toMatchObject({ authorizationRestriction: { actions: [], projectIds: ["A"] } });
    for (const invalid of [
      { ohmyhost_authorization: { unknown: [] } },
      { ohmyhost_authorization: { actions: "projects:read" } },
      { sub: "client_1" },
      { sub: "user_ contains space" },
      { client_id: undefined },
      { client_id: "client_ has space" },
      { client_id: "x".repeat(2_049) },
      { org_id: "foreign_1" },
      { sid: "session_1" },
      { sid: undefined },
      { aud: [] },
    ]) {
      expect(() => parseWorkosTokenClaims({ ...claims, ...invalid }, "connect_user")).toThrow(
        WorkosContractError,
      );
    }
  });

  it("parses only RS256 signing keys and session claims", () => {
    expect(parseWorkosJwtHeader({ alg: "RS256", kid: "key_1", typ: "JWT" })).toEqual({
      alg: "RS256",
      kid: "key_1",
      typ: "JWT",
    });
    expect(
      parseWorkosJwks({
        keys: [{ kty: "RSA", kid: "key_1", alg: "RS256", use: "sig", n: validModulus, e: "AQAB" }],
      }),
    ).toHaveLength(1);
    expect(
      parseWorkosTokenClaims(
        {
          ...commonClaims,
          org_id: "org_1",
          sid: "session_1",
          client_id: "client_public",
          role: "admin",
          permissions: ["projects:read"],
        },
        "session",
      ),
    ).toMatchObject({
      kind: "session",
      clientId: "client_public",
      organizationId: "org_1",
      sessionId: "session_1",
      role: "admin",
      permissions: ["projects:read"],
    });
  });

  it("normalizes Connect scopes and rejects duplicate signing key IDs", () => {
    const multipleAudiences = {
      ...commonClaims,
      sub: "client_1",
      org_id: "org_1",
      aud: ["control-api", "secondary-api", "control-api"],
    };
    expect(parseWorkosTokenClaims(multipleAudiences, "m2m")).toMatchObject({
      clientId: "client_1",
      organizationId: "org_1",
      audience: ["control-api", "secondary-api"],
    });
    for (const aud of [[], ["control-api", ""], ["control-api", 1]]) {
      expect(() => parseWorkosTokenClaims({ ...multipleAudiences, aud }, "m2m")).toThrowError(
        /Token audience is invalid/u,
      );
    }
    expect(
      parseWorkosTokenClaims(
        {
          ...commonClaims,
          sub: "client_1",
          aud: "control-api",
          org_id: "org_1",
          sid: "consent_1",
          scope: "projects:read projects:read operations:read",
        },
        "m2m",
      ),
    ).toMatchObject({
      kind: "m2m",
      clientId: "client_1",
      organizationId: "org_1",
      scopes: ["operations:read", "projects:read"],
    });
    expect(() =>
      parseWorkosJwks({
        keys: [
          { kty: "RSA", kid: "same", alg: "RS256", use: "sig", n: validModulus, e: "AQAB" },
          { kty: "RSA", kid: "same", alg: "RS256", use: "sig", n: validModulus, e: "AQAB" },
        ],
      }),
    ).toThrowError(WorkosContractError);
    expect(() =>
      parseWorkosJwks({
        keys: [{ kty: "RSA", kid: "bad", alg: "RS256", use: "sig", n: "not+url", e: "Ag" }],
      }),
    ).toThrowError(/JWK field n is invalid/u);
    expect(() =>
      parseWorkosJwks({
        keys: [{ kty: "RSA", kid: "bad-e", alg: "RS256", use: "sig", n: validModulus, e: "Ag" }],
      }),
    ).toThrowError(/exponent is invalid/u);
  });
});
