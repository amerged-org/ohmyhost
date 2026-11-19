import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createWorkosBearerAuthenticator,
  createWorkosConnectUserAuthenticator,
} from "../src/workos-authenticator.js";
import { parseUlid } from "@ohmyhost/platform";

const NOW_SECONDS = Date.parse("2026-08-18T10:00:00Z") / 1_000;
const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
let privateKey: Parameters<typeof globalThis.crypto.subtle.sign>[1];
let jwks: { readonly keys: readonly unknown[] };

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
  privateKey = generated.privateKey;
  jwks = {
    keys: [
      {
        ...(await globalThis.crypto.subtle.exportKey("jwk", generated.publicKey)),
        alg: "RS256",
        use: "sig",
        kid: "control-api-key",
      },
    ],
  };
});

describe("Control API WorkOS bearer adapter", () => {
  it("returns a verified Connect delegation identity without granting session or tenant capabilities", async () => {
    const resolve = vi.fn(async (id: string) => (id === "org_1" ? ORGANIZATION_ID : null));
    const dependencies = {
      policy: {
        kind: "connect_user",
        issuer: "https://connect.example.test",
        audience: "https://app.ohmyho.st/mcp",
      } as const,
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      organizations: { resolve },
    };
    const authenticator = createWorkosConnectUserAuthenticator(dependencies);
    const claims = {
      iss: dependencies.policy.issuer,
      aud: dependencies.policy.audience,
      sub: "user_1",
      client_id: "client_chat",
      org_id: "org_1",
      sid: "app_consent_1",
      jti: "token_1",
      scope: "openid projects:write",
      permissions: ["projects:write"],
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    };
    await expect(authenticator.authenticate(await sign(claims))).resolves.toEqual({
      actorId: "user:user_1",
      credentialId: "workos_connect:client_chat:app_consent_1",
      authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
      organizationIds: [ORGANIZATION_ID],
      connectUser: {
        issuer: dependencies.policy.issuer,
        audience: [dependencies.policy.audience],
        clientId: "client_chat",
        userId: "user_1",
        workosOrganizationId: "org_1",
        consentId: "app_consent_1",
        tokenId: "token_1",
        tokenExpiresAt: NOW_SECONDS + 300,
      },
    });
    const bootstrap = await authenticator.authenticate(
      await sign({ ...claims, org_id: undefined, jti: undefined }),
    );
    expect(bootstrap).toMatchObject({
      organizationIds: [],
      connectUser: { workosOrganizationId: null, tokenId: null },
    });
    expect(bootstrap).not.toHaveProperty("session");
    expect(resolve).toHaveBeenCalledOnce();
    await expect(
      authenticator.authenticate(await sign({ ...claims, org_id: "org_deleted" })),
    ).resolves.toMatchObject({
      organizationIds: [],
      connectUser: { workosOrganizationId: "org_deleted" },
    });
    await expect(authenticator.authenticate("secret malformed token")).resolves.toBeNull();
    await expect(
      authenticator.authenticate(await sign({ ...claims, sid: "session_1" })),
    ).resolves.toBeNull();
    const outage = new Error("private mapping details");
    resolve.mockRejectedValueOnce(outage);
    await expect(authenticator.authenticate(await sign(claims))).rejects.toMatchObject({
      name: "AuthenticationUnavailableError",
      message: "Authentication infrastructure is unavailable",
    });
  });

  it("accepts a verified session token without treating WorkOS UI permissions as product scopes", async () => {
    const sessionStatus = vi.fn().mockResolvedValue(true);
    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: sessionStatus },
      organizations: {
        async resolve(workosOrganizationId) {
          return workosOrganizationId === "org_1" ? ORGANIZATION_ID : null;
        },
        resolveM2m: async () => null,
      },
    });

    const token = await sign({
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      org_id: "org_1",
      sid: "session_1",
      permissions: ["widgets:users-table:manage"],
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    });
    await expect(authenticator.authenticate(token)).resolves.toEqual({
      actorId: "user:user_1",
      session: {
        sessionId: "session_1",
        userId: "user_1",
        organizationId: "org_1",
        tokenExpiresAt: NOW_SECONDS + 300,
      },
      credentialId: "workos_session:session_1",
      authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
      organizationIds: [ORGANIZATION_ID],
    });
    expect(sessionStatus).toHaveBeenCalledWith({
      sessionId: "session_1",
      userId: "user_1",
      organizationId: "org_1",
      tokenExpiresAt: NOW_SECONDS + 300,
    });
  });

  it("rejects a verified session token when its organization mapping is no longer active", async () => {
    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: async () => true },
      organizations: {
        resolve: async () => null,
        resolveM2m: async () => null,
      },
    });

    await expect(
      authenticator.authenticate(
        await sign({
          iss: "https://auth.example.test",
          sub: "user_deleted",
          client_id: "client_public",
          org_id: "org_deleted",
          sid: "session_deleted",
          permissions: ["projects:read"],
          iat: NOW_SECONDS,
          exp: NOW_SECONDS + 300,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("fails closed for malformed tokens and requires at least one verification policy", async () => {
    const sessionStatus = vi.fn().mockResolvedValue(true);
    expect(() =>
      createWorkosBearerAuthenticator({
        policies: [],
        verifier: {
          jwks: { load: async () => jwks },
          clock: { now: () => new Date("2026-08-18T10:00:00Z") },
        },
        sessionStatus: { isActive: sessionStatus },
        organizations: { resolve: async () => ORGANIZATION_ID, resolveM2m: async () => null },
      }),
    ).toThrow("At least one WorkOS token policy is required");

    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: sessionStatus },
      organizations: { resolve: async () => ORGANIZATION_ID, resolveM2m: async () => null },
    });
    await expect(authenticator.authenticate("sensitive malformed token")).resolves.toBeNull();
    expect(sessionStatus).not.toHaveBeenCalled();
  });

  it("requires a live session and gives a new organizationless user no tenant permissions", async () => {
    const sessionStatus = vi.fn().mockResolvedValue(true);
    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: sessionStatus },
      organizations: { resolve: async () => ORGANIZATION_ID, resolveM2m: async () => null },
    });
    const common = {
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      permissions: [],
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    };

    await expect(
      authenticator.authenticate(await sign({ ...common, org_id: "org_1" })),
    ).resolves.toBeNull();
    expect(sessionStatus).not.toHaveBeenCalled();
    const token = await sign({ ...common, sid: "session_1" });
    await expect(authenticator.authenticate(token)).resolves.toEqual({
      session: {
        sessionId: "session_1",
        userId: "user_1",
        organizationId: null,
        tokenExpiresAt: NOW_SECONDS + 300,
      },
      actorId: "user:user_1",
      credentialId: "workos_session:session_1",
      authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
      organizationIds: [],
      authorizationScopeConstraint: [],
    });
    expect(sessionStatus).toHaveBeenCalledWith({
      sessionId: "session_1",
      userId: "user_1",
      organizationId: null,
      tokenExpiresAt: NOW_SECONDS + 300,
    });
    sessionStatus.mockResolvedValue(false);
    await expect(authenticator.authenticate(token)).resolves.toBeNull();
  });

  it("rejects an expired session token locally without calling private session status", async () => {
    const sessionStatus = vi.fn().mockResolvedValue(true);
    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: sessionStatus },
      organizations: { resolve: async () => ORGANIZATION_ID, resolveM2m: async () => null },
    });

    await expect(
      authenticator.authenticate(
        await sign({
          iss: "https://auth.example.test",
          sub: "user_1",
          client_id: "client_public",
          org_id: "org_1",
          sid: "session_1",
          permissions: [],
          iat: NOW_SECONDS - 600,
          exp: NOW_SECONDS - 300,
        }),
      ),
    ).resolves.toBeNull();
    expect(sessionStatus).not.toHaveBeenCalled();
  });

  it("rejects revoked sessions and maps status outages to authentication unavailable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStatus = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error());
    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: sessionStatus },
      organizations: { resolve: async () => ORGANIZATION_ID, resolveM2m: async () => null },
    });
    const token = await sign({
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      org_id: "org_1",
      sid: "session_1",
      permissions: [],
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    });

    await expect(authenticator.authenticate(token)).resolves.toBeNull();
    await expect(authenticator.authenticate(token)).rejects.toMatchObject({
      name: "AuthenticationUnavailableError",
    });
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: "error",
        service: "control-api",
        code: "WORKOS_AUTH_SESSION_UNAVAILABLE",
      }),
    );
    errors.mockRestore();
  });

  it("distinguishes organization-resolution infrastructure failure from an invalid token", async () => {
    const authenticator = createWorkosBearerAuthenticator({
      policies: [
        { kind: "session", issuer: "https://auth.example.test", clientId: "client_public" },
      ],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: async () => true },
      organizations: {
        resolve: async () => {
          throw new Error("mapping store unavailable");
        },
        resolveM2m: async () => null,
      },
    });
    const signed = await sign({
      iss: "https://auth.example.test",
      sub: "user_1",
      client_id: "client_public",
      org_id: "org_1",
      permissions: [],
      sid: "session_1",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    });

    await expect(authenticator.authenticate(signed)).rejects.toMatchObject({
      name: "AuthenticationUnavailableError",
    });
  });

  it("requires an active Connect binding and intersects token scopes with binding scopes", async () => {
    const sessionStatus = vi.fn().mockResolvedValue(true);
    const authenticator = createWorkosBearerAuthenticator({
      policies: [{ kind: "m2m", issuer: "https://connect.example.test", audience: "control-api" }],
      verifier: {
        jwks: { load: async () => jwks },
        clock: { now: () => new Date("2026-08-18T10:00:00Z") },
      },
      sessionStatus: { isActive: sessionStatus },
      organizations: {
        resolve: async () => ORGANIZATION_ID,
        resolveM2m: async ({ connectClientId, workosOrganizationId }) =>
          connectClientId === "client_1" && workosOrganizationId === "org_1"
            ? {
                organizationId: ORGANIZATION_ID,
                scopes: ["audit:read", "projects:read"],
              }
            : null,
      },
    });
    const signed = await sign({
      iss: "https://connect.example.test",
      aud: "control-api",
      sub: "client_1",
      org_id: "org_1",
      jti: "token_1",
      scope: "projects:write projects:read operations:read",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    });

    await expect(authenticator.authenticate(signed)).resolves.toEqual({
      actorId: "service:client_1",
      credentialId: "workos_token:token_1",
      authorizationPrincipal: { kind: "m2m_service", subjectId: "service:client_1" },
      organizationIds: [ORGANIZATION_ID],
      authorizationScopeConstraint: ["projects:read"],
    });
    expect(sessionStatus).not.toHaveBeenCalled();
  });
});

async function sign(claims: Readonly<Record<string, unknown>>): Promise<string> {
  const header = encode({ alg: "RS256", kid: "control-api-key", typ: "JWT" });
  const payload = encode(claims);
  const signature = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBytes(new Uint8Array(signature))}`;
}

function encode(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBytes(value: Uint8Array): string {
  const binary = [...value].map((byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
