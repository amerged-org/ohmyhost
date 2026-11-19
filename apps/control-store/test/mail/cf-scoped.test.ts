import { afterAll, beforeAll, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  cfFixture,
  declareIdentity,
  hex,
  isoAt,
  nextNumber,
  revokeUser,
  seedRetirementClaim,
  seedWorkspaceDomain,
  type CfFixture,
} from "../support/cf-mail-fixture.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";

let control: TestControl, store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const dns = () => store.cfScopedDns;
const scopeOf = (f: CfFixture, purpose: "application_identity" | "workspace_mail", id: string) => ({
  organizationId: f.organizationId,
  purpose,
  resourceId: id,
});
/** The authorization a consent callback persists: valid for 10 minutes from the real clock. */
function issueInput(f: CfFixture, purpose: "application_identity" | "workspace_mail", id: string) {
  const n = nextNumber(),
    now = Date.now();
  return {
    ...scopeOf(f, purpose, id),
    principalId: f.principalId,
    delegation: null,
    authorizationId: newUlid(),
    resourceRevision: 1,
    zoneName: "example.com",
    idempotencyKeySha256: hex(16 + (n % 200)),
    requestSha256: hex(0x60),
    stateSha256: hex(0x70 + (n % 100)),
    issuedAt: isoAt(now, 0),
    expiresAt: isoAt(now, 600_000),
  };
}
const sealed = (fill: string, version = 1) => ({
  accessCiphertext: fill.repeat(24),
  accessNonce: fill.repeat(12),
  refreshCiphertext: fill.repeat(20),
  refreshNonce: fill.repeat(12),
  keyVersion: version,
  accessExpiresAt: isoAt(Date.now(), 3_600_000),
});
const grantInput = <
  T extends Omit<ReturnType<typeof issueInput>, "delegation"> & { delegation: unknown },
>(
  issue: T,
) => ({
  ...issue,
  ...sealed("ab"),
  zoneId: "1".repeat(32),
  accountId: "2".repeat(32),
  connectedAt: isoAt(Date.now(), 1000),
});
const record = (f: CfFixture, id: string, name: string) => ({
  id,
  type: "TXT" as const,
  name,
  content: `"v=1 ${id}"`,
  ttl: 1,
  proxied: false,
  comment: `ohmyhost:${f.projectId}:mail:v1`,
});
/** Issue, consume and seal a grant: the OAuth callback of the consent. */
async function connect(
  f: CfFixture,
  purpose: "application_identity" | "workspace_mail",
  id: string,
) {
  const issue = issueInput(f, purpose, id);
  await dns().issue(issue);
  await dns().consume({
    authorizationId: issue.authorizationId,
    stateSha256: issue.stateSha256,
    principalId: issue.principalId,
    now: isoAt(Date.now(), 500),
  });
  await dns().saveGrant(grantInput(issue));
  return issue;
}
const row = <T>(sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<T>();
const leases = async (f: CfFixture) =>
  (
    await row<{ n: number }>(
      "SELECT count(*) n FROM scoped_dns_provider_uses WHERE organization_id = ?",
      f.organizationId,
    )
  )?.n;

it("issues, consumes and seals a grant, then runs guarded provider uses and revokes it", async () => {
  const f = await cfFixture(control);
  await declareIdentity(store, f);
  const scope = scopeOf(f, "application_identity", f.projectId);
  const clock = () => ({ ...scope, now: isoAt(Date.now(), 1000) });
  expect(await dns().readAuthorization({ authorizationId: newUlid() })).toBeNull();
  expect(await dns().status(clock())).toEqual({
    status: "not_authorized",
    zone: null,
    scopes: [],
    expiresAt: null,
  });

  const issue = issueInput(f, "application_identity", f.projectId);
  const issued = await dns().issue(issue);
  expect(issued).toMatchObject({ authorizationId: issue.authorizationId, zoneName: "example.com" });
  expect(await dns().issue({ ...issue, authorizationId: newUlid() })).toEqual(issued);
  expect(await dns().readAuthorization({ authorizationId: issue.authorizationId })).toEqual(issued);
  expect(await dns().status(clock())).toMatchObject({ status: "pending", zone: "example.com" });

  const consume = {
    authorizationId: issue.authorizationId,
    stateSha256: issue.stateSha256,
    principalId: issue.principalId,
    now: isoAt(Date.now(), 500),
  };
  expect(await dns().consume({ ...consume, stateSha256: hex(0x01) })).toBeNull();
  // Only the user who started the consent consumes it; another principal leaves it open.
  expect(await dns().consume({ ...consume, principalId: "user:someone-else" })).toBeNull();
  expect(await dns().consume(consume)).toEqual(issued);
  expect(await dns().consume(consume)).toBeNull();
  await dns().saveGrant(grantInput(issue));
  expect(await dns().status(clock())).toMatchObject({ status: "authorized", zone: "example.com" });

  const first = crypto.randomUUID();
  const claimed = await dns().claimUse({ ...clock(), leaseToken: first, cleanup: false });
  expect(claimed).toMatchObject({
    leaseToken: first,
    resource: { revision: 1, hostname: "www.example.com", challengeName: expect.any(String) },
    grant: { authorizationId: issue.authorizationId, zoneId: "1".repeat(32), revokedAt: null },
  });
  await expect(
    dns().claimUse({ ...clock(), leaseToken: crypto.randomUUID(), cleanup: false }),
  ).rejects.toMatchObject({ code: "store_busy" });
  const use = { ...scope, leaseToken: first };
  await dns().renewUse(use);
  expect(await dns().authorizeUse(use)).toBe(true);
  await dns().releaseUse(use);
  expect(await leases(f)).toBe(0);
  await expect(dns().authorizeUse(use)).rejects.toThrow("dns_use_lease_lost");

  const second = { ...scope, leaseToken: crypto.randomUUID() };
  await dns().claimUse({ ...clock(), leaseToken: second.leaseToken, cleanup: false });
  const rotated = sealed("cd", 2);
  await dns().finishUse({
    ...second,
    result: {
      kind: "applied",
      tokens: rotated,
      records: [record(f, "rec1", "_omh-project.www.example.com")],
      authorizationReceipt: {
        zoneId: "1".repeat(32),
        zoneName: "example.com",
        records: [record(f, "rec1", "_omh-project.www.example.com")],
      },
    },
  });
  expect(await leases(f)).toBe(0);
  expect(
    await row(
      "SELECT key_version, lower(hex(access_nonce)) nonce, dns_receipts FROM scoped_customer_dns_grants WHERE organization_id = ? AND resource_id = ?",
      f.organizationId,
      f.projectId,
    ),
  ).toMatchObject({
    key_version: 2,
    nonce: "cd".repeat(12),
    dns_receipts: expect.stringContaining("rec1"),
  });

  const third = { ...scope, leaseToken: crypto.randomUUID() };
  await dns().claimUse({ ...clock(), leaseToken: third.leaseToken, cleanup: false });
  await dns().finishUse({ ...third, result: { kind: "revoked", revokedAt: isoAt(Date.now(), 0) } });
  expect(await dns().status(clock())).toMatchObject({ status: "revoked" });
  expect(
    await dns().claimUse({ ...clock(), leaseToken: crypto.randomUUID(), cleanup: false }),
  ).toBeNull();

  const revoke = {
    ...scope,
    principalId: f.principalId,
    delegation: null,
    resourceRevision: 1,
    idempotencyKeySha256: hex(0x81),
    requestSha256: hex(0x82),
    now: isoAt(Date.now(), 2000),
  };
  const revoked = await dns().revoke(revoke);
  expect(revoked).toMatchObject({ status: "revoked", zone: "example.com" });
  expect(await dns().revoke(revoke)).toEqual(revoked);
  await expect(dns().revoke({ ...revoke, requestSha256: hex(0x83) })).rejects.toThrow(
    "idempotency_key_reused",
  );
});

it("refuses stale resources, a closed replay and an actor whose authority is gone", async () => {
  const f = await cfFixture(control);
  await declareIdentity(store, f);
  const issue = issueInput(f, "application_identity", f.projectId);
  await expect(dns().issue({ ...issue, resourceRevision: 2 })).rejects.toThrow(
    "dns_resource_stale",
  );
  await dns().issue(issue);
  await expect(dns().issue({ ...issue, requestSha256: hex(0x99) })).rejects.toThrow(
    "authorization_closed",
  );
  await revokeUser(f);
  await expect(dns().issue({ ...issue, idempotencyKeySha256: hex(0x98) })).rejects.toThrow(
    "dns_authority_revoked",
  );
  expect(
    await dns().status({
      ...scopeOf(f, "application_identity", f.projectId),
      now: isoAt(Date.now(), 0),
    }),
  ).toMatchObject({ status: "revoked" });
});

it("deletes mail DNS records under a retiring domain's cleanup and settles an empty one without a provider call", async () => {
  const f = await cfFixture(control);
  const name = `mail${nextNumber()}.example.com`;
  const withRecords = await seedWorkspaceDomain(f, {
    domain: name,
    status: "retiring",
    receipts: {
      zoneId: "1".repeat(32),
      zoneName: "example.com",
      records: [record(f, "r1", name), record(f, "r2", `_dmarc.${name}`)],
    },
  });
  await seedRetirementClaim(f, withRecords.domainId);
  await connect(f, "workspace_mail", withRecords.domainId);
  const scope = scopeOf(f, "workspace_mail", withRecords.domainId);
  await expect(dns().readCleanup({ ...scope, purpose: "application_identity" })).rejects.toThrow(
    "Invalid mail cleanup",
  );
  const pending = await dns().readCleanup(scope);
  expect(pending).toMatchObject({ cleanup: null, zoneName: "example.com" });

  const lease = { ...scope, leaseToken: crypto.randomUUID() };
  await dns().claimUse({ ...lease, now: isoAt(Date.now(), 1000), cleanup: true });
  await expect(
    dns().finishUse({
      ...lease,
      result: {
        kind: "applied",
        tokens: null,
        cleanup: { recordIds: ["r1"], observedAt: isoAt(Date.now(), 0), expectedReceipt: "{}" },
      },
    }),
  ).rejects.toThrow("mail_dns_receipt_changed");
  await dns().finishUse({
    ...lease,
    result: {
      kind: "applied",
      tokens: null,
      cleanup: {
        recordIds: ["r2", "r1"],
        observedAt: isoAt(Date.now(), 0),
        expectedReceipt: (pending as { receipt: string }).receipt,
      },
    },
  });
  expect(await dns().readCleanup(scope)).toMatchObject({
    cleanup: { status: "deleted", recordIds: ["r2", "r1"] },
  });
  expect(
    await row<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM scoped_customer_dns_grants WHERE organization_id = ? AND resource_id = ?",
      f.organizationId,
      withRecords.domainId,
    ),
  ).toMatchObject({ revoked_at: expect.any(String) });

  const empty = await seedWorkspaceDomain(f, {
    domain: `empty${nextNumber()}.example.com`,
    status: "retiring",
    receipts: { zoneId: "1".repeat(32), zoneName: "example.com", records: [] },
  });
  await seedRetirementClaim(f, empty.domainId);
  const emptyScope = scopeOf(f, "workspace_mail", empty.domainId);
  const receipt = (await dns().readCleanup(emptyScope)) as { receipt: string };
  const settle = { ...emptyScope, expectedReceipt: receipt.receipt, now: isoAt(Date.now(), 0) };
  await expect(dns().completeEmptyCleanup({ ...settle, expectedReceipt: "{}" })).rejects.toThrow(
    "mail_dns_receipt_changed",
  );
  expect(await dns().completeEmptyCleanup(settle)).toEqual({ status: "deleted", recordIds: [] });
  expect(await dns().completeEmptyCleanup(settle)).toEqual({ status: "deleted", recordIds: [] });
});

it("surfaces a lost reply of a committed authorization as an unknown outcome and answers the replay", async () => {
  const f = await cfFixture(control);
  await declareIdentity(store, f);
  const issue = issueInput(f, "application_identity", f.projectId);
  const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
  await expect(lossy.cfScopedDns.issue(issue)).rejects.toThrow("store_outcome_unknown");
  expect(await dns().issue({ ...issue, authorizationId: newUlid() })).toMatchObject({
    authorizationId: issue.authorizationId,
  });
});

it("keeps the accepted token ceiling and waits for an active DNS use before disconnect", async () => {
  const f = await cfFixture(control);
  await declareIdentity(store, f);
  const identity = {
    organizationId: f.organizationId,
    userId: f.userId,
    clientId: "client_dns",
    consentHash: hex(0x22),
  };
  const proof = await store.identity.ensureMcpConnectionProof({
    ...identity,
    projectId: f.projectId,
    now: isoAt(Date.now(), 0),
  });
  expect(proof).not.toBeNull();
  if (!proof) throw new Error("Connection proof fixture missing");
  const base = {
    grantId: proof.grantId,
    grantRevision: 1,
    clientId: identity.clientId,
    consentHash: identity.consentHash,
    action: "projects:write" as const,
  };
  const denied = {
    ...issueInput(f, "application_identity", f.projectId),
    delegation: { ...base, authorizationRestriction: { actions: [] } },
  };
  await expect(dns().issue(denied)).rejects.toThrow();
  const issue = {
    ...issueInput(f, "application_identity", f.projectId),
    delegation: {
      ...base,
      authorizationRestriction: { actions: ["projects:write"], projectIds: [f.projectId] },
    },
  };
  await dns().issue(issue);
  await dns().consume({
    authorizationId: issue.authorizationId,
    stateSha256: issue.stateSha256,
    principalId: issue.principalId,
    now: isoAt(Date.now(), 500),
  });
  await dns().saveGrant(grantInput(issue));
  const scope = scopeOf(f, "application_identity", f.projectId);
  const lease = { ...scope, leaseToken: crypto.randomUUID() };
  await dns().claimUse({ ...lease, now: isoAt(Date.now(), 1000), cleanup: false });
  const disconnect = {
    userId: f.userId,
    clientId: identity.clientId,
    consentHash: identity.consentHash,
    now: isoAt(Date.now(), 1000),
  };
  expect(await store.identity.revokeMcpConsent(disconnect)).toEqual({ state: "pending" });
  await dns().releaseUse(lease);
  expect(await store.identity.revokeMcpConsent(disconnect)).toEqual({ state: "revoked" });
  expect(
    await dns().claimUse({
      ...scope,
      leaseToken: crypto.randomUUID(),
      now: isoAt(Date.now(), 1000),
      cleanup: false,
    }),
  ).toBeNull();
});

it("revokes the scoped DNS authorization and grant when the application identity is withdrawn", async () => {
  const f = await cfFixture(control);
  await declareIdentity(store, f);
  await connect(f, "application_identity", f.projectId);
  await store.cfApplicationIdentity.completeAction({
    organizationId: f.organizationId,
    projectId: f.projectId,
    actorId: f.principalId,
    idempotencyKeySha256: hex(0x91),
    requestSha256: hex(0x92),
    delegation: null,
    action: "revoke",
    revision: 1,
    now: isoAt(Date.now(), 2000),
    viewAt: isoAt(Date.now(), 2000),
  });
  // Withdrawing the identity ends the consent bookkeeping too: the sealed grant is no longer usable.
  for (const table of ["scoped_customer_dns_authorizations", "scoped_customer_dns_grants"])
    expect(
      await row<{ revoked_at: string | null }>(
        `SELECT revoked_at FROM ${table} WHERE organization_id = ? AND purpose = 'application_identity' AND resource_id = ?`,
        f.organizationId,
        f.projectId,
      ),
      table,
    ).toMatchObject({ revoked_at: expect.any(String) });
});
