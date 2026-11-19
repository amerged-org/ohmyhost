import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareDomainManagementRuntime,
  type CloudflareCustomerOAuthProvider,
  type CloudflareDomainManagementPersistence,
} from "../src/runtime.js";
import { createCloudflareDomainSecrets } from "../src/secrets.js";
import type { CustomerDomainDns } from "../src/paid-domains.js";

const ORGANIZATION_ID = "00000000000000000000000001";
const PROJECT_ID = "00000000000000000000000002";
const AUTHORIZATION_ID = "00000000000000000000000003";
const OPERATION_ID = "00000000000000000000000004";
const NOW = new Date("2026-08-29T12:00:00.000Z");
const IDEMPOTENCY = `sha256:${"a".repeat(64)}`;
const REQUEST = `sha256:${"c".repeat(64)}`;
const SIGNATURE = "b".repeat(43);
const STATE = `${AUTHORIZATION_ID}.${SIGNATURE}`;

describe("private Cloudflare domain management", () => {
  it("creates the production OAuth state with the real control-character-rejecting signer", async () => {
    const prepared = fixture();
    const persistence = {
      ...prepared.persistence,
      claimAuthorization: vi.fn(async (input) => input),
    } satisfies CloudflareDomainManagementPersistence;
    const secrets = createCloudflareDomainSecrets({
      keyBase64: Buffer.alloc(32, 0x41).toString("base64"),
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    const runtime = createCloudflareDomainManagementRuntime({
      platform: "development",
      clock: { now: () => new Date(NOW) },
      ids: { next: () => AUTHORIZATION_ID },
      stateSigner: secrets.stateSigner,
      tokenCipher: prepared.tokenCipher,
      oauth: prepared.oauth,
      persistence,
      grantAccess: prepared.grantAccess,
    });

    await expect(runtime.beginAuthorization(beginInput())).resolves.toMatchObject({
      authorizationId: AUTHORIZATION_ID,
      expiresAt: "2026-08-29T12:10:00.000Z",
    });
  });

  it("stores only a state digest and replays the same short-lived authorization URL", async () => {
    const { runtime, persistence, oauth } = fixture();

    const first = await runtime.beginAuthorization(beginInput());
    const replay = await runtime.beginAuthorization(beginInput());

    expect(first).toEqual(replay);
    expect(first).toEqual({
      authorizationId: AUTHORIZATION_ID,
      authorizationUrl: `https://dash.cloudflare.com/oauth2/auth?state=${STATE}`,
      expiresAt: "2026-08-29T12:10:00.000Z",
    });
    expect(persistence.claimAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        stateSha256: sha256(STATE),
        idempotencyKeySha256: IDEMPOTENCY,
        requestSha256: REQUEST,
      }),
    );
    expect(JSON.stringify(persistence.claimAuthorization.mock.calls)).not.toContain(STATE);
    expect(oauth.authorizationUrl).toHaveBeenCalledWith({ state: STATE });
    const persisted = await persistence.claimAuthorization.mock.results[0]?.value;
    persistence.claimAuthorization.mockResolvedValueOnce({
      ...persisted,
      stateSha256: new Uint8Array(32),
    });
    await expect(runtime.beginAuthorization(beginInput())).rejects.toThrow(
      "state conflicts with the requested operation",
    );
  });

  it("exchanges one state-bound code, proves the exact zone, and persists only ciphertext", async () => {
    const { runtime, persistence, oauth, tokenCipher } = fixture();
    persistence.consumeAuthorization.mockResolvedValueOnce({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      authorizationId: AUTHORIZATION_ID,
      principalId: "user:user_1",
      zoneName: "tenant-fixture.com",
    });
    oauth.observeZone.mockResolvedValueOnce({
      state: "found",
      zoneId: "a".repeat(32),
      zoneName: "tenant-fixture.com",
      accountId: "account_1",
    });

    await expect(
      runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "authorized" });

    expect(persistence.consumeAuthorization).toHaveBeenCalledWith({
      authorizationId: AUTHORIZATION_ID,
      stateSha256: sha256(STATE),
      principalId: "user:user_1",
      consumedAt: NOW.toISOString(),
    });
    expect(oauth.observeZone).toHaveBeenCalledWith("access-token-secret", "tenant-fixture.com");
    expect(tokenCipher.seal).toHaveBeenCalledTimes(2);
    expect(persistence.putGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        zoneName: "tenant-fixture.com",
        zoneId: "a".repeat(32),
        accountId: "account_1",
        scopes: ["dns.write", "zone.read"],
        accessCiphertext: "ciphertext-access",
        refreshCiphertext: "ciphertext-refresh",
        keyVersion: 1,
        accessExpiresAt: "2026-08-29T13:00:00.000Z",
      }),
    );
    expect(JSON.stringify(persistence.putGrant.mock.calls)).not.toContain("access-token-secret");
    expect(JSON.stringify(persistence.putGrant.mock.calls)).not.toContain("refresh-token-secret");
  });

  it("fails closed for replayed state and for an absent or ambiguous zone", async () => {
    const replayed = fixture();
    replayed.persistence.consumeAuthorization.mockResolvedValueOnce(null);
    await expect(
      replayed.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "invalid" });
    expect(replayed.oauth.exchangeAuthorizationCode).not.toHaveBeenCalled();

    const absent = fixture();
    absent.oauth.observeZone.mockResolvedValueOnce({ state: "absent", zoneName: "aixyte.com" });
    await expect(
      absent.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "zone_observe_failed" });
    expect(absent.persistence.putGrant).not.toHaveBeenCalled();
  });

  it("returns a credential-free completion stage when a consumed callback cannot finish", async () => {
    const rejected = fixture();
    rejected.oauth.exchangeAuthorizationCode.mockRejectedValueOnce(new Error("provider detail"));

    await expect(
      rejected.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "token_exchange_failed" });
    expect(JSON.stringify(rejected.persistence.putGrant.mock.calls)).not.toContain(
      "provider detail",
    );

    const encrypted = fixture();
    encrypted.tokenCipher.seal.mockRejectedValueOnce(new Error("cipher detail"));
    await expect(
      encrypted.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "token_encrypt_failed" });

    const persisted = fixture();
    persisted.persistence.putGrant.mockRejectedValueOnce(new Error("database detail"));
    await expect(
      persisted.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "grant_persist_failed" });
  });

  it("revokes the exchanged refresh token when the callback stores no grant, and keeps the status when that revoke fails", async () => {
    const zoneChanged = fixture();
    zoneChanged.oauth.observeZone.mockResolvedValueOnce({
      state: "found" as const,
      zoneId: "b".repeat(32),
      zoneName: "other.example" as const,
      accountId: "account_1",
    });
    await expect(
      zoneChanged.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "zone_observe_failed" });
    expect(zoneChanged.oauth.revokeRefreshToken).toHaveBeenCalledTimes(1);
    expect(zoneChanged.oauth.revokeRefreshToken).toHaveBeenCalledWith("refresh-token-secret");

    const sealing = fixture();
    sealing.tokenCipher.seal.mockRejectedValueOnce(new Error("cipher detail"));
    await expect(
      sealing.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "token_encrypt_failed" });
    expect(sealing.oauth.revokeRefreshToken).toHaveBeenCalledWith("refresh-token-secret");

    const persisted = fixture();
    persisted.persistence.putGrant.mockRejectedValueOnce(new Error("database detail"));
    persisted.oauth.revokeRefreshToken.mockRejectedValueOnce(new Error("revoke detail"));
    await expect(
      persisted.runtime.completeAuthorization({
        code: "provider-code",
        state: STATE,
        principalId: "user:user_1",
      }),
    ).resolves.toEqual({ status: "grant_persist_failed" });
    expect(persisted.oauth.revokeRefreshToken).toHaveBeenCalledWith("refresh-token-secret");
  });

  it("returns a credential-free status and derives no caller-controlled hostnames", async () => {
    const { runtime, persistence } = fixture();
    await expect(runtime.getStatus(scopeInput())).resolves.toEqual({
      status: "authorized",
      zone: "aixyte.com",
      scopes: ["dns.write", "zone.read"],
      expiresAt: "2026-08-29T13:00:00.000Z",
    });
    await expect(runtime.configureDomains(configureInput())).resolves.toEqual(operation());
    expect(persistence.configureDomains).toHaveBeenCalledWith(
      expect.objectContaining({
        projectHandle: "calm-otter-waves",
        platform: "development",
      }),
    );
    await expect(
      runtime.configureDomains({ ...configureInput(), productionHostname: "attacker.example" }),
    ).rejects.toThrow(TypeError);
  });

  it("renews an expired access token before reporting the grant expired and never claims more", async () => {
    const { runtime, persistence, grantAccess } = fixture();
    const expired = {
      status: "expired" as const,
      zone: "aixyte.com" as const,
      scopes: ["dns.write", "zone.read"] as const,
      expiresAt: "2026-08-29T11:00:00.000Z",
    };
    // offline_access renewed the token: the stored grant now reads as authorized.
    persistence.readStatus.mockResolvedValueOnce(expired);
    grantAccess.refreshAccess.mockResolvedValueOnce({
      status: "ready",
      accessToken: "access-token-secret",
      zoneId: "a".repeat(32),
      zoneName: "aixyte.com",
    });
    await expect(runtime.getStatus(scopeInput())).resolves.toMatchObject({ status: "authorized" });
    // The refresh renews the token of the grant; it names no DNS record, so no hostname is sent.
    expect(grantAccess.refreshAccess).toHaveBeenLastCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });
    // A refused refresh token keeps the existing reauthorization outcome, and so does a pending
    // authorization that expired without any stored grant.
    for (const outcome of [{ status: "expired" as const }, { status: "absent" as const }]) {
      persistence.readStatus.mockResolvedValueOnce(expired);
      grantAccess.refreshAccess.mockResolvedValueOnce(outcome);
      await expect(runtime.getStatus(scopeInput())).resolves.toEqual(expired);
    }
    // A refresh outage is unavailable, never a false authorized or expired status.
    persistence.readStatus.mockResolvedValueOnce(expired);
    grantAccess.refreshAccess.mockRejectedValueOnce(new Error("refresh unavailable"));
    await expect(runtime.getStatus(scopeInput())).rejects.toThrow("refresh unavailable");
    // Authorized, revoked and never-authorized states are reported without any refresh.
    const calls = grantAccess.refreshAccess.mock.calls.length;
    await runtime.getStatus(scopeInput());
    expect(grantAccess.refreshAccess).toHaveBeenCalledTimes(calls);
  });
});

function fixture() {
  const claimAuthorization = vi.fn(async (input) => ({
    ...input,
    authorizationId: AUTHORIZATION_ID,
    stateSha256: sha256(STATE),
  }));
  const consumeAuthorization = vi.fn<CloudflareDomainManagementPersistence["consumeAuthorization"]>(
    async () => ({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      authorizationId: AUTHORIZATION_ID,
      principalId: "user:user_1",
      zoneName: "aixyte.com" as const,
    }),
  );
  const putGrant = vi.fn(async () => "created" as const);
  const readStatus = vi.fn<CloudflareDomainManagementPersistence["readStatus"]>(async () => ({
    status: "authorized" as const,
    zone: "aixyte.com" as const,
    scopes: ["dns.write", "zone.read"] as const,
    expiresAt: "2026-08-29T13:00:00.000Z",
  }));
  const configureDomains = vi.fn(async () => operation());
  const persistence = {
    claimAuthorization,
    consumeAuthorization,
    putGrant,
    readStatus,
    configureDomains,
  } satisfies CloudflareDomainManagementPersistence;
  const observeZone = vi.fn<CloudflareCustomerOAuthProvider["observeZone"]>(async () => ({
    state: "found" as const,
    zoneId: "a".repeat(32),
    zoneName: "aixyte.com" as const,
    accountId: "account_1",
  }));
  const oauth = {
    authorizationUrl: vi.fn(
      ({ state }: { state: string }) => `https://dash.cloudflare.com/oauth2/auth?state=${state}`,
    ),
    exchangeAuthorizationCode: vi.fn(async () => ({
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresInSeconds: 3600,
      scopes: ["dns.write", "zone.read"] as const,
    })),
    observeZone,
    revokeRefreshToken: vi.fn(async () => undefined),
  } satisfies CloudflareCustomerOAuthProvider;
  const tokenCipher = {
    seal: vi.fn(async (plaintext: string) => ({
      ciphertext: plaintext.startsWith("access") ? "ciphertext-access" : "ciphertext-refresh",
      nonce: plaintext.startsWith("access") ? "nonce-access" : "nonce-refresh",
      keyVersion: 1,
    })),
  };
  const grantAccess = {
    refreshAccess: vi.fn<CustomerDomainDns["loadAccess"]>(async () => ({
      status: "absent" as const,
    })),
  };
  return {
    persistence,
    oauth,
    tokenCipher,
    grantAccess,
    runtime: createCloudflareDomainManagementRuntime({
      platform: "development",
      clock: { now: () => new Date(NOW) },
      ids: { next: () => AUTHORIZATION_ID },
      stateSigner: { sign: async () => SIGNATURE },
      tokenCipher,
      oauth,
      persistence,
      grantAccess,
    }),
  };
}

function beginInput() {
  return {
    ...scopeInput(),
    idempotencyKeySha256: IDEMPOTENCY,
    requestSha256: REQUEST,
    zone: "aixyte.com",
  };
}

function scopeInput() {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    actorId: "user:user_1",
  };
}

function configureInput() {
  return {
    ...scopeInput(),
    idempotencyKeySha256: IDEMPOTENCY,
    requestSha256: REQUEST,
    projectHandle: "calm-otter-waves",
  };
}

function operation() {
  return {
    status: 202 as const,
    location: `/v1/operations/${OPERATION_ID}`,
    body: {
      id: OPERATION_ID,
      state: "succeeded",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  };
}

function sha256(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}
