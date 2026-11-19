import { afterAll, beforeAll, expect, it } from "vitest";

import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  cfFixture,
  declareIdentity,
  hex,
  isoAt,
  revokeUser,
  seedBinding,
  seedWebsite,
  seedWorkspaceDomain,
  type CfFixture,
} from "../support/cf-mail-fixture.js";
import { losingWriteResponses, STORED_NOW } from "../support/platform-fixtures.js";

let control: TestControl, store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const DAY = 86_400_000;
const CHALLENGE = `omh-domain-v1=${"A".repeat(43)}`;
const scope = (f: CfFixture) => ({
  organizationId: f.organizationId,
  projectId: f.projectId,
  actorId: f.principalId,
});
const mutation = (f: CfFixture, key: number, request = 0x41) => ({
  ...scope(f),
  idempotencyKeySha256: hex(key),
  requestSha256: hex(request),
  delegation: null,
});
const action = (
  f: CfFixture,
  kind: "verify" | "revoke",
  key: number,
  extra: Record<string, unknown> = {},
) => {
  const now = Date.now();
  return {
    ...mutation(f, key),
    action: kind,
    revision: 1,
    now: isoAt(now, 0),
    viewAt: isoAt(now, 0),
    ...extra,
  };
};
const verification = (challengeValue: string, validityMs: number) => ({
  challengeValue,
  expiresAt: isoAt(Date.now(), validityMs),
});

it("declares, replays, verifies and revokes an application identity with immutable receipts", async () => {
  const f = await cfFixture(control);
  await seedWebsite(f);
  expect(await store.cfApplicationIdentity.read(scope(f))).toBeNull();

  const declared = await declareIdentity(store, f, { key: 0x21 });
  expect(declared).toMatchObject({
    organizationId: f.organizationId,
    projectId: f.projectId,
    hostname: "www.example.com",
    registrableDomain: "example.com",
    revision: 1,
    state: "pending",
    challengeName: "_omh-project.www.example.com",
    challengeValue: CHALLENGE,
    verifiedAt: null,
    revokedAt: null,
  });
  expect(await declareIdentity(store, f, { key: 0x21 })).toEqual(declared);
  await expect(declareIdentity(store, f, { key: 0x21, request: 0x99 })).rejects.toThrow(
    "idempotency_conflict",
  );
  expect(await store.cfApplicationIdentity.read(scope(f))).toEqual(declared);
  expect(await store.cfApplicationIdentity.readForVerification(scope(f))).toEqual(declared);

  expect(
    await store.cfApplicationIdentity.replay({ ...mutation(f, 0x31), action: "verify" }),
  ).toBeNull();
  expect(
    await store.cfApplicationIdentity.completeAction(
      action(f, "verify", 0x32, verification("omh-domain-v1=wrong", 30 * DAY)),
    ),
  ).toBeNull();
  const verifyInput = action(f, "verify", 0x31, verification(CHALLENGE, 30 * DAY));
  const verified = await store.cfApplicationIdentity.completeAction(verifyInput);
  expect(verified).toMatchObject({
    organization_id: f.organizationId,
    project_id: f.projectId,
    hostname: "www.example.com",
    status: "verified",
    revision: 1,
    challenge: { type: "TXT", name: "_omh-project.www.example.com", value: CHALLENGE },
  });
  expect(await store.cfApplicationIdentity.completeAction(verifyInput)).toEqual(verified);
  expect(
    await store.cfApplicationIdentity.replay({ ...mutation(f, 0x31), action: "verify" }),
  ).toEqual(verified);
  await expect(
    store.cfApplicationIdentity.replay({ ...mutation(f, 0x31, 0x77), action: "verify" }),
  ).rejects.toThrow("idempotency_conflict");

  expect(await store.cfApplicationIdentity.completeAction(action(f, "revoke", 0x33))).toMatchObject(
    { status: "revoked", revision: 1 },
  );
  expect(await store.cfApplicationIdentity.read(scope(f))).toMatchObject({
    state: "revoked",
    revision: 1,
  });
  const redeclared = await declareIdentity(store, f, { key: 0x22 });
  expect(redeclared).toMatchObject({ revision: 2, state: "pending" });
});

it("renews a verified proof automatically only while the installed state is unchanged", async () => {
  const f = await cfFixture(control);
  const website = await seedWebsite(f);
  await declareIdentity(store, f, { key: 0x23 });
  await store.cfApplicationIdentity.completeAction(
    action(f, "verify", 0x34, verification(CHALLENGE, 3 * DAY)),
  );
  const workspace = await seedWorkspaceDomain(f);
  await seedBinding(f, workspace, 1);

  const request = { organizationId: f.organizationId, projectId: f.projectId, expectedRevision: 1 };
  const due = { ...request, now: isoAt(Date.now(), 0) };
  const proof = await store.cfApplicationIdentity.readAutomatic(due);
  expect(proof).toMatchObject({
    hostname: "www.example.com",
    revision: 1,
    mailDomainId: workspace.domainId,
    resourceDomain: workspace.domain,
    customHostnames: [website],
  });
  expect(
    await store.cfApplicationIdentity.completeAutomatic({ ...due, witness: proof }),
  ).toMatchObject({ status: "revalidated", revision: 1 });
  const renewed = await f.db
    .prepare(
      "SELECT expires_at > ?3 AS later FROM project_application_domain_identities WHERE organization_id = ?1 AND project_id = ?2",
    )
    .bind(f.organizationId, f.projectId, `${isoAt(Date.now(), 20 * DAY).slice(0, 23)}000Z`)
    .first<{ later: number }>();
  expect(renewed?.later).toBe(1);
  expect(
    await store.cfApplicationIdentity.completeAutomatic({ ...due, witness: proof }),
  ).toMatchObject({ status: "not_due", revision: 1 });

  const missing = { ...due, expectedRevision: 2 };
  expect(await store.cfApplicationIdentity.readAutomatic(missing)).toBeNull();
  expect(
    await store.cfApplicationIdentity.completeAutomatic({ ...missing, witness: proof }),
  ).toEqual({ status: "stale", revision: 2, expiresAt: null });
});

it("refuses every mutation once the actor's terminal revocation or delegated client consent is gone", async () => {
  const revoked = await cfFixture(control);
  await revokeUser(revoked);
  await expect(declareIdentity(store, revoked)).rejects.toThrow("dns_authority_revoked");
  await expect(
    store.cfApplicationIdentity.replay({ ...mutation(revoked, 0x35), action: "revoke" }),
  ).rejects.toThrow("dns_authority_revoked");

  const f = await cfFixture(control);
  const grant = {
    grantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    grantRevision: 1,
    clientId: "https://client.example/mcp",
    consentHash: "c".repeat(64),
  };
  await f.db
    .prepare(
      "INSERT INTO mcp_client_grants(organization_id, grant_id, user_id, client_id, consent_hash, project_id, ownership_version, billing_epoch_id, allow_publish, revision, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 0, 1, ?8)",
    )
    .bind(
      f.organizationId,
      grant.grantId,
      f.userId,
      grant.clientId,
      grant.consentHash,
      f.projectId,
      f.project.billingEpochId,
      STORED_NOW,
    )
    .run();
  const delegated = { ...mutation(f, 0x36), delegation: grant };
  const declare = (input: typeof delegated) => {
    // One clock reading: two readings can straddle a millisecond and exceed the one-day proof limit.
    const declaredAt = Date.now();
    return store.cfApplicationIdentity.declare({
      ...input,
      hostname: "www.example.com",
      registrableDomain: "example.com",
      challengeValue: CHALLENGE,
      declaredAt: isoAt(declaredAt, 0),
      expiresAt: isoAt(declaredAt, DAY),
    });
  };
  expect(await declare(delegated)).toMatchObject({ revision: 1, state: "pending" });
  await f.db
    .prepare(
      "INSERT INTO mcp_client_revocations(organization_id, user_id, client_id, consent_hash, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(f.organizationId, f.userId, grant.clientId, grant.consentHash, STORED_NOW)
    .run();
  await expect(declare({ ...delegated, idempotencyKeySha256: hex(0x37) })).rejects.toThrow(
    "dns_authority_revoked",
  );
});

it("surfaces a lost reply of a committed declaration as an unknown outcome and replays it afterwards", async () => {
  const f = await cfFixture(control);
  const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
  await expect(declareIdentity(lossy, f, { key: 0x24 })).rejects.toThrow("store_outcome_unknown");
  const stored = await store.cfApplicationIdentity.read(scope(f));
  expect(stored).toMatchObject({ revision: 1, state: "pending" });
  expect(await declareIdentity(store, f, { key: 0x24 })).toEqual(stored);
});

it("leaves an active mail binding and its verified identity untouched when the project's Paid connection is deleted", async () => {
  const f = await cfFixture(control);
  const website = await seedWebsite(f);
  await declareIdentity(store, f, { key: 0x61 });
  await store.cfApplicationIdentity.completeAction(
    action(f, "verify", 0x62, verification(CHALLENGE, 3 * DAY)),
  );
  const workspace = await seedWorkspaceDomain(f);
  await seedBinding(f, workspace, 1);

  await store.cloudflareDomain.claimPaidDomainDelete({
    organizationId: f.organizationId,
    projectId: f.projectId,
    hostname: website,
    principalId: f.principalId,
    idempotencyKeySha256: `sha256:${hex(0x63)}`,
    requestSha256: `sha256:${hex(0x64)}`,
    now: new Date().toISOString(),
  });
  expect(
    await f.db
      .prepare("SELECT state,sending FROM project_mail_domain_bindings WHERE project_id=?1")
      .bind(f.projectId)
      .first(),
  ).toEqual({ state: "active", sending: 1 });
  expect(
    await f.db
      .prepare("SELECT state FROM project_application_domain_identities WHERE project_id=?1")
      .bind(f.projectId)
      .first(),
  ).toEqual({ state: "verified" });
});
