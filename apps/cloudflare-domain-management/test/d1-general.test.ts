import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CloudflareAuthorizationClosedError,
  CloudflareProjectDomainConflictError,
} from "@ohmyhost/database";
import { createUlidFactory, SystemClock, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import { CloudflareDomainRuntime } from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import { seam } from "../../control-store/test/support/wire.js";
import {
  createCloudflareDomainManagementRuntime,
  CloudflareZoneNotBoundError,
} from "../src/runtime.js";
import { createCloudflareDomainSecrets } from "../src/secrets.js";
import { createD1CloudflareDomainManagementPersistence } from "../src/d1-persistence.js";
import {
  createD1CustomerDomainDnsAccess,
  decodeGeneralCloudflareGrant,
} from "../src/d1-general-dns.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const clock = new SystemClock(),
  ids = createUlidFactory({ clock, entropy: new SystemEntropy() }),
  secrets = createCloudflareDomainSecrets({
    keyBase64: Buffer.alloc(32, 0x42).toString("base64"),
    keyVersion: 1,
    crypto: globalThis.crypto,
  }),
  digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 60_000);
afterAll(async () => control.dispose());

/** The Cloudflare HTTP boundary as the provider class sees it: one token endpoint and the DNS record batch. */
function cloudflare() {
  const calls: string[] = [];
  const tokens = (n: number) => ({
    accessToken: `fixture-access-token-${n}`,
    refreshToken: `fixture-refresh-token-${n}`,
    tokenType: "Bearer" as const,
    expiresInSeconds: 3600,
    scopes: ["dns.write", "zone.read"] as ["dns.write", "zone.read"],
  });
  let refreshes = 0,
    revoked = false;
  const oauth = {
    authorizationUrl: ({ state }: { state: string }) =>
      `https://dash.cloudflare.com/oauth2/auth?state=${state}`,
    exchangeAuthorizationCode: async (code: string) => {
      if (code === "rejected-code") throw new Error("rejected");
      return tokens(0);
    },
    observeZone: async (_token: string, zone: string) =>
      zone === "elsewhere.test"
        ? ({ state: "absent", zoneName: zone } as const)
        : ({
            state: "found",
            zoneName: zone,
            zoneId: "d".repeat(32),
            accountId: "e".repeat(32),
          } as const),
    revokeRefreshToken: async () => undefined,
  };
  const providerForUse = (beforeRequest: () => Promise<void>) => ({
    observeRefreshToken: async () => {
      await beforeRequest();
      calls.push("refresh");
      return revoked
        ? ({ state: "revoked" } as const)
        : ({ state: "active", tokens: tokens(++refreshes) } as const);
    },
    reconcileRecords: async (
      _token: string,
      input: { records: readonly object[] },
      options?: object,
    ) => {
      await beforeRequest();
      calls.push(`reconcile:${JSON.stringify(options)}`);
      return { status: "applied" as const, records: input.records as never };
    },
    deleteRecords: async (_token: string, input: { records: readonly { id: string }[] }) => {
      await beforeRequest();
      calls.push("delete");
      return { status: "deleted" as const, recordIds: input.records.map(({ id }) => id) };
    },
  });
  return { calls, oauth, providerForUse, revoke: () => (revoked = true) };
}

describe("general project grant over the actual Core", () => {
  it("authorizes a zone, stores the sealed grant, refreshes it under a lease and serves DNS access", async () => {
    const project = await seedProject(control, { handle: "general-check" }),
      scope = { organizationId: project.organizationId, projectId: project.projectId },
      actor = { ...scope, actorId: "user:user_consent" },
      api = cloudflare(),
      wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
      customerDns = createD1CustomerDomainDnsAccess({
        binding: wire.binding as never,
        clock,
        ids,
        tokenCipher: secrets.tokenCipher,
        providerForUse: api.providerForUse,
      }),
      runtime = createCloudflareDomainManagementRuntime({
        platform: "development",
        clock,
        ids,
        stateSigner: secrets.stateSigner,
        tokenCipher: secrets.tokenCipher,
        oauth: api.oauth,
        persistence: createD1CloudflareDomainManagementPersistence({
          binding: wire.binding as never,
          clock,
          ids,
        }),
        grantAccess: customerDns,
      }),
      begin = (zone: string, key: string) =>
        runtime.beginAuthorization({
          ...actor,
          zone,
          idempotencyKeySha256: digest(`key:${key}`),
          requestSha256: digest(`request:${zone}`),
        });
    await control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.example.test',NULL,'awaiting_deployment','user:user_consent',?3,?4,?5,?5,NULL)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        STORED_NOW,
      )
      .run();

    // Only a zone the project declared can be authorized, and a replayed key answers the same ticket.
    await expect(begin("undeclared.test", "u")).rejects.toBeInstanceOf(CloudflareZoneNotBoundError);
    const first = await begin("example.test", "a"),
      replay = await begin("example.test", "a");
    expect(replay.authorizationId).toBe(first.authorizationId);
    await expect(
      runtime.beginAuthorization({
        ...actor,
        zone: "example.test",
        idempotencyKeySha256: digest("key:a"),
        requestSha256: digest("another request"),
      }),
    ).rejects.toBeInstanceOf(CloudflareProjectDomainConflictError);
    expect(await runtime.getStatus(actor)).toMatchObject({
      status: "pending",
      zone: "example.test",
    });

    // The callback is consumed once; a failing code exchange or an absent zone grants nothing.
    const state = new URL(first.authorizationUrl).searchParams.get("state") ?? "";
    expect(
      await runtime.completeAuthorization({
        code: "fixture-code-1",
        state,
        principalId: "user:user_consent",
      }),
    ).toEqual({
      status: "authorized",
    });
    expect(
      await runtime.completeAuthorization({
        code: "fixture-code-1",
        state,
        principalId: "user:user_consent",
      }),
    ).toEqual({
      status: "invalid",
    });
    expect(await runtime.getStatus(actor)).toMatchObject({ status: "authorized" });
    await expect(begin("example.test", "a")).rejects.toBeInstanceOf(
      CloudflareAuthorizationClosedError,
    );

    // A fresh token is opened without a lease; a stale one is refreshed under the grant-use lease.
    const target = { ...scope, hostname: "app.example.test" };
    const ready = await customerDns.loadAccess({
      organizationId: parseUlid(scope.organizationId),
      projectId: parseUlid(scope.projectId),
      hostname: target.hostname,
    });
    expect(ready).toMatchObject({ status: "ready", accessToken: "fixture-access-token-0" });
    expect(api.calls).toEqual([]);
    expect(
      await customerDns.loadAccess({
        organizationId: parseUlid(scope.organizationId),
        projectId: parseUlid(scope.projectId),
        hostname: "other.example",
      }),
    ).toEqual({ status: "absent" });
    // The zone is consented for the declared hostname only: an undeclared name of the same zone stays out of reach.
    expect(
      await customerDns.loadAccess({
        organizationId: parseUlid(scope.organizationId),
        projectId: parseUlid(scope.projectId),
        hostname: "sibling.example.test",
      }),
    ).toEqual({ status: "absent" });
    await control.core
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_expires_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(scope.organizationId, scope.projectId)
      .run();
    expect(await runtime.getStatus(actor)).toMatchObject({ status: "authorized" });
    expect(api.calls).toEqual(["refresh"]);
    expect(
      await control.core.prepare("SELECT count(*) n FROM cloudflare_general_grant_uses").first(),
    ).toEqual({ n: 0 });

    // DNS writes go through the provider with the grant's adoption policy.
    const record = {
      type: "TXT" as const,
      name: "_x.example.test",
      content: "v",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:x",
    };
    await customerDns.reconcileRecords("token", {
      zoneId: "d".repeat(32),
      zoneName: "example.test",
      records: [record],
    });
    await customerDns.reconcileRecords(
      "token",
      { zoneId: "d".repeat(32), zoneName: "example.test", records: [record] },
      { observeOnly: true },
    );
    await customerDns.deleteRecords("token", {
      zoneId: "d".repeat(32),
      zoneName: "example.test",
      records: [{ ...record, id: "a".repeat(32) }],
    });

    // Domains are configured idempotently for the project handle.
    const configure = () =>
      runtime.configureDomains({
        ...actor,
        projectHandle: project.handle,
        idempotencyKeySha256: digest("configure"),
        requestSha256: digest("configure request"),
      });
    expect(await configure()).toMatchObject({ status: 202 });
    expect(await configure()).toMatchObject({ status: 202 });

    // A lease that cannot be released afterwards never hides a completed refresh (the lease expires by itself).
    await control.core
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_expires_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(scope.organizationId, scope.projectId)
      .run();
    wire.refuse("releaseGrantUse", "lost");
    expect(
      await customerDns.loadAccess({
        organizationId: parseUlid(scope.organizationId),
        projectId: parseUlid(scope.projectId),
        hostname: target.hostname,
      }),
    ).toMatchObject({ status: "ready" });
    wire.restore();

    // A newer, still pending authorization closes the grant for refresh; the grant itself is not gone.
    const pending = await begin("example.test", "pending");
    expect(pending.authorizationId).not.toBe(first.authorizationId);
    await control.core
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_expires_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(scope.organizationId, scope.projectId)
      .run();
    expect(
      await customerDns.loadAccess({
        organizationId: parseUlid(scope.organizationId),
        projectId: parseUlid(scope.projectId),
        hostname: target.hostname,
      }),
    ).toEqual({ status: "reconciliation_required" });
    await control.core
      .prepare("DELETE FROM cloudflare_project_authorization_states WHERE authorization_id=?")
      .bind(pending.authorizationId)
      .run();

    // A revoked refresh token expires the grant instead of renewing it.
    await control.core
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_expires_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(scope.organizationId, scope.projectId)
      .run();
    api.revoke();
    expect(
      await customerDns.loadAccess({
        organizationId: parseUlid(scope.organizationId),
        projectId: parseUlid(scope.projectId),
        hostname: target.hostname,
      }),
    ).toEqual({ status: "expired" });
    expect(await runtime.getStatus(actor)).toMatchObject({ status: "expired" });
    expect(
      await control.core.prepare("SELECT count(*) n FROM cloudflare_general_grant_uses").first(),
    ).toEqual({ n: 0 });
    void newUlid;
  });
});

describe("private replies of the general Core capability", () => {
  it("refuses grants and use claims that are not exactly what the Core answers", async () => {
    const project = await seedProject(control, { handle: "general-wire" }),
      scope = { organizationId: project.organizationId, projectId: project.projectId },
      core = new CloudflareDomainRuntime({} as never, control.bindings as never),
      authorizationId = newUlid();
    expect(decodeGeneralCloudflareGrant(null)).toBeNull();
    // An authorized grant exactly as the Core stores it, then each field corrupted in turn.
    await control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.wire.test',NULL,'awaiting_deployment','user:user_consent',?3,?4,?5,?5,NULL)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        new Uint8Array(32).fill(3),
        new Uint8Array(32).fill(4),
        STORED_NOW,
      )
      .run();
    const now = new Date(),
      iso = (delta: number) => new Date(now.getTime() + delta).toISOString();
    await core.claimAuthorization({
      ...scope,
      authorizationId,
      principalId: "user:user_consent",
      zoneName: "wire.test",
      idempotencyKeySha256: digest("wire"),
      requestSha256: digest("wire request"),
      stateSha256: new Uint8Array(32).fill(5),
      issuedAt: iso(0),
      expiresAt: iso(600_000),
    });
    await core.consumeAuthorization({
      authorizationId,
      stateSha256: new Uint8Array(32).fill(5),
      principalId: "user:user_consent",
      consumedAt: iso(1),
    });
    await core.putGrant({
      ...scope,
      authorizationId,
      principalId: "user:user_consent",
      zoneName: "wire.test",
      zoneId: "a".repeat(32),
      accountId: "b".repeat(32),
      scopes: ["dns.write", "zone.read"],
      accessCiphertext: Buffer.alloc(32, 1).toString("base64"),
      accessNonce: Buffer.alloc(12, 2).toString("base64"),
      refreshCiphertext: Buffer.alloc(32, 3).toString("base64"),
      refreshNonce: Buffer.alloc(12, 4).toString("base64"),
      keyVersion: 1,
      accessExpiresAt: iso(3_600_000),
      connectedAt: iso(2),
    });
    const stored = (await core.readGrant(scope)) as Record<string, unknown>;
    expect(decodeGeneralCloudflareGrant(stored)).toMatchObject({
      status: "active",
      accessCiphertext: new Uint8Array(32).fill(1),
    });
    expect(
      decodeGeneralCloudflareGrant({
        ...stored,
        accessCiphertext: new Uint8Array(32).fill(1).buffer,
      }),
    ).toMatchObject({ status: "active" });
    expect(
      decodeGeneralCloudflareGrant({
        ...stored,
        status: "revoked",
        revokedAt: iso(9),
        accessCiphertext: null,
      }),
    ).toMatchObject({ status: "revoked", accessCiphertext: null });
    for (const [field, value, message] of [
      ["organizationId", 7, "Invalid private Cloudflare DNS field"],
      ["accessExpiresAt", "2026-01-01T00:00:00Z", "Invalid private Cloudflare DNS time"],
      ["updatedAt", "2026-01-01T00:00:00.000Z", "Invalid private Cloudflare DNS version"],
      ["zoneId", "short", "Invalid private Cloudflare DNS identity"],
      ["scopes", ["dns.write"], "Invalid private Cloudflare DNS identity"],
      ["status", "pending", "Invalid private Cloudflare DNS state"],
      ["accessCiphertext", "text", "Invalid sealed Cloudflare DNS response"],
      ["accessCiphertext", [1, 2, 3], "Invalid private Cloudflare DNS envelope"],
      ["accessNonce", new Uint8Array(3), "Invalid private Cloudflare DNS envelope"],
    ] as const)
      expect(() => decodeGeneralCloudflareGrant({ ...stored, [field]: value })).toThrow(message);

    // A use claim must be one of the three exact answers.
    const wire = seam(core),
      access = createD1CustomerDomainDnsAccess({
        binding: wire.binding as never,
        clock,
        ids,
        tokenCipher: secrets.tokenCipher,
        providerForUse: () => ({}) as never,
      }),
      load = () =>
        access.loadAccess({
          organizationId: parseUlid(scope.organizationId),
          projectId: parseUlid(scope.projectId),
          hostname: "app.wire.test",
        });
    wire.reply("readGrant", { ...stored, accessExpiresAt: "2026-01-01T00:00:00.000Z" });
    wire.reply("claimGrantUse", { status: "absent" });
    expect(await load()).toEqual({ status: "absent" });
    // Closed means the project is not active or a re-authorization is pending: the grant still exists, so
    // nothing is known to be gone and the caller must reconcile later.
    wire.reply("claimGrantUse", { status: "closed" });
    expect(await load()).toEqual({ status: "reconciliation_required" });
    wire.reply("claimGrantUse", { status: "maybe" });
    await expect(load()).rejects.toThrow("Invalid private Cloudflare grant claim");
    wire.reply("claimGrantUse", { status: "claimed", grant: null });
    expect(await load()).toEqual({ status: "absent" });
    wire.reply("claimGrantUse", { status: "claimed", grant: "grant" });
    await expect(load()).rejects.toThrow("Invalid private Cloudflare DNS response");
    wire.reply("claimGrantUse", "claim");
    await expect(load()).rejects.toThrow("Invalid private Cloudflare DNS response");
  });
});
