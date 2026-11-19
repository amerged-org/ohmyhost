import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalizeWorkosOrganizationSnapshot,
  parseWorkosOrganizationSnapshot,
} from "../../../packages/workos-auth-contracts/src/index.js";
import { createD1WorkosPollerPort } from "../../workos-management/src/d1-poller-port.js";

import { newUlid } from "../src/catalog/common.js";
import { runChargeOrg } from "../src/catalog/credit/index.js";
import { derivedOrganizationId } from "../src/catalog/identity/workos-poller.js";
import type { D1Database, D1PreparedStatement } from "../src/d1-types.js";
import { createControlStore } from "../src/store.js";
import { createTestControl, losingNthResponse, type TestControl } from "./support/control-d1.js";
import { makePaid } from "./support/credit-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
let poller: ReturnType<typeof createD1WorkosPollerPort>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  poller = createD1WorkosPollerPort({
    runtime: store.identity,
    auditIds: { next: () => newUlid() },
  });
}, 240_000);
afterAll(async () => control?.dispose());
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const stored = (at: string) => at.replace(/Z$/u, "000Z");
const all = async <Row = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  (
    await control.core
      .prepare(sql)
      .bind(...params)
      .all<Row>()
  ).results;
const event = async (workosOrganizationId: string, type = "organization.created", attempts = 3) => {
  const inboxEventId = newUlid();
  const receivedAt = now();
  await store.operations.recordInboxEvent({
    provider: "workos",
    inboxEventId,
    externalEventId: `evt_${inboxEventId}`,
    eventType: type,
    payload: { schemaVersion: "workos.organization-trigger.v1", workosOrganizationId },
    bodyDigest: "ab".repeat(32),
    receivedAt,
    signatureTimestamp: receivedAt,
    maxAttempts: attempts,
    routing: { kind: "workos_organization", workosOrganizationId },
  });
  return inboxEventId;
};
const claim = () =>
  store.identity.claimWorkosInboxEvent({
    claimId: newUlid(),
    claimedAt: now(),
    leaseExpiresAt: later(60_000),
  });
const snapshot = (
  organizationId: string | null,
  workosOrganizationId: string,
  inboxEventId: string,
  claimId: string,
) => ({
  organizationId,
  workosOrganizationId,
  snapshotDigest: "cd".repeat(32),
  snapshotFetchedAt: now(),
  synchronizedAt: now(),
  triggerEventId: `evt_${inboxEventId}`,
  auditEventId: newUlid(),
  memberships: [
    { workosUserId: "user_poller", role: "admin", status: "active", digest: "ef".repeat(32) },
  ],
  claim: { inboxEventId, claimId },
});
const deletion = (
  organizationId: string | null,
  workosOrganizationId: string,
  inboxEventId: string,
  claimId: string,
) => ({
  organizationId,
  workosOrganizationId,
  tombstoneDigest: "aa".repeat(32),
  triggerEventId: `evt_${inboxEventId}`,
  deletedAt: now(),
  auditEventId: newUlid(),
  claim: { inboxEventId, claimId },
});

/** Delay only a command's final write batch; all snapshots and the claim itself use real workerd D1. */
function beforeWrite(db: D1Database, match: RegExp, before: () => Promise<void>): D1Database {
  let remaining = true;
  const wrap = (
    inner: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement & { inner: D1PreparedStatement; sql: string } => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: () => inner.first(),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as (D1PreparedStatement & {
        inner: D1PreparedStatement;
        sql: string;
      })[];
      if (remaining && wrapped.some((statement) => match.test(statement.sql))) {
        remaining = false;
        await before();
      }
      return db.batch(wrapped.map((statement) => statement.inner));
    },
  };
}

async function waitUntil(at: string): Promise<void> {
  while (Date.now() <= Date.parse(at) + 10) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the actual WorkOS poller commands over the shared Core", () => {
  it("turns automatic recharge off with its WorkOS organization, so a deleted organization is never recharged", async () => {
    const workosId = "org_recharge_deleted";
    const adopt = await event(workosId);
    const held = await claim();
    if (held === null) throw new Error("claim missing");
    const organizationId = held.organizationId ?? (await derivedOrganizationId(workosId));
    await store.identity.applyPolledWorkosSnapshot(
      snapshot(organizationId, workosId, adopt, held.claimId),
    );
    const at = now();
    await makePaid(control.core, organizationId, "2099-01-01T00:00:00.000Z", at, "manual");
    const scope = { organizationId, accountId: "acct_poller_recharge", mode: "test" as const };
    await store.stripeBilling.configureRecharge({
      ...scope,
      now: at,
      enabled: true,
      monthlyLimitMinor: 3000,
      consent: "off_session_v1",
      revision: 0,
      actorId: "user:owner",
      idempotencyKey: "poller-recharge",
      id: newUlid(),
    });
    await store.stripeBilling.saveRechargeSetup({
      ...scope,
      now: at,
      revision: 1,
      sessionId: "cs_poller_recharge",
      paymentMethodId: "pm_poller_recharge",
      expired: false,
    });
    await runChargeOrg(control.core, {
      organizationId,
      key: `spend:${organizationId}`,
      amountMicros: 950_000_000,
      now: at,
    });
    const due = async () =>
      store.stripeBilling.listRechargeCandidates({
        accountId: scope.accountId,
        mode: scope.mode,
        now: now(),
      });
    expect(await due()).toEqual([{ organization_id: organizationId }]);
    // a suspended organization is not recharged, enabling it is refused, and switching the policy off is always allowed
    await control.core
      .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?1")
      .bind(organizationId)
      .run();
    expect(await due()).toEqual([]);
    expect(await store.stripeBilling.claimRecharge({ ...scope, now: now() })).toBeNull();
    await expect(
      store.stripeBilling.configureRecharge({
        ...scope,
        now: now(),
        enabled: true,
        monthlyLimitMinor: 3000,
        consent: "off_session_v1",
        revision: 1,
        actorId: "user:owner",
        idempotencyKey: "suspended-on",
        id: newUlid(),
      }),
    ).rejects.toThrow("billing_conflict");
    expect(
      await store.stripeBilling.configureRecharge({
        ...scope,
        now: now(),
        enabled: false,
        monthlyLimitMinor: 3000,
        consent: null,
        revision: 1,
        actorId: "user:owner",
        idempotencyKey: "suspended-off",
        id: newUlid(),
      }),
    ).toMatchObject({ enabled: false, revision: 2, status: "off" });
    await control.core
      .prepare("UPDATE organizations SET state = 'active' WHERE organization_id = ?1")
      .bind(organizationId)
      .run();
    // the policy stays off until its owner switches it on again, at the revision that owner now sees
    expect(await due()).toEqual([]);
    await store.stripeBilling.configureRecharge({
      ...scope,
      now: now(),
      enabled: true,
      monthlyLimitMinor: 3000,
      consent: "off_session_v1",
      revision: 2,
      actorId: "user:owner",
      idempotencyKey: "reactivated-on",
      id: newUlid(),
    });
    expect(await due()).toEqual([{ organization_id: organizationId }]);
    const deleteId = await event(workosId, "organization.deleted");
    const deleteClaim = await claim();
    if (deleteClaim === null) throw new Error("delete claim missing");
    expect(
      await store.identity.applyWorkosOrganizationDeletion(
        deletion(organizationId, workosId, deleteId, deleteClaim.claimId),
      ),
    ).toEqual({ organizationId, changed: true });
    expect(await due()).toEqual([]);
    expect(await store.stripeBilling.claimRecharge({ ...scope, now: now() })).toBeNull();
    expect(
      await all(
        "SELECT enabled, status FROM stripe_recharge_policies WHERE organization_id = ?1",
        organizationId,
      ),
    ).toEqual([{ enabled: 0, status: "off" }]);
  });

  it("adopts the first event, atomically applies authority with its ACK, preserves deletion history and never revives it", async () => {
    const workosId = "org_new_poller";
    const id = await event(workosId);
    const held = await claim();
    expect(held).toMatchObject({
      inboxEventId: id,
      organizationId: null,
      attemptNumber: 1,
    });
    if (held === null) throw new Error("claim missing");
    const scope = held.organizationId ?? (await derivedOrganizationId(workosId));
    const apply = snapshot(scope, workosId, id, held.claimId);
    await expect(
      store.identity.applyPolledWorkosSnapshot({
        ...apply,
        claim: { ...apply.claim, claimId: newUlid() },
      }),
    ).rejects.toMatchObject({ code: "inbox_claim_stale" });
    const foreign = newUlid();
    await expect(
      store.identity.applyPolledWorkosSnapshot({ ...apply, organizationId: foreign }),
    ).rejects.toMatchObject({ code: "inbox_claim_stale" });
    expect(await all("SELECT * FROM organizations WHERE organization_id = ?", foreign)).toEqual([]);
    expect(await all("SELECT * FROM organizations WHERE organization_id = ?", scope)).toEqual([]);
    expect(
      await all("SELECT * FROM local_authorization_grants WHERE organization_id = ?", scope),
    ).toEqual([]);
    expect(await store.identity.applyPolledWorkosSnapshot(apply)).toMatchObject({
      organizationId: scope,
      organizationChanged: true,
    });
    expect(await store.identity.applyPolledWorkosSnapshot(apply)).toMatchObject({
      organizationId: scope,
    });
    expect(
      await all("SELECT state, attempt_count FROM webhook_inbox WHERE inbox_event_id = ?", id),
    ).toEqual([{ state: "acknowledged", attempt_count: 1 }]);
    expect(
      await all(
        "SELECT role, state FROM organization_memberships WHERE organization_id = ?",
        scope,
      ),
    ).toEqual([{ role: "admin", state: "active" }]);
    expect(
      await all(
        "SELECT role FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
        scope,
      ),
    ).toEqual([{ role: "owner" }]);
    const key = newUlid();
    const at = stored(now());
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO api_key_metadata VALUES (?1, 'user:owner', ?2, ?3, 'omh_test', 1, '[\"projects:read\"]', ?4, NULL, NULL, NULL)",
        )
        .bind(key, scope, new Uint8Array(32), at),
      control.core
        .prepare(
          "INSERT INTO m2m_organization_bindings VALUES (?1, 'client_poller', '[\"projects:read\"]', 'active', 1, ?2, NULL, NULL)",
        )
        .bind(scope, at),
    ]);
    await expect(
      control.core
        .prepare("UPDATE api_key_metadata SET scopes = '[1]' WHERE api_key_id = ?")
        .bind(key)
        .run(),
    ).rejects.toThrow(/invalid API key scopes/u);
    await expect(
      control.core
        .prepare("UPDATE api_key_metadata SET scopes = json_array('admin') WHERE api_key_id = ?")
        .bind(key)
        .run(),
    ).rejects.toThrow(/invalid API key scopes/u);
    expect(await all("SELECT scopes FROM api_key_metadata WHERE api_key_id = ?", key)).toEqual([
      { scopes: '["projects:read"]' },
    ]);
    const deleteId = await event(workosId, "organization.deleted");
    const deleteClaim = await claim();
    if (deleteClaim === null) throw new Error("delete claim missing");
    expect(deleteClaim.inboxEventId).toBe(deleteId);
    const remove = deletion(scope, workosId, deleteId, deleteClaim.claimId);
    expect(await store.identity.applyWorkosOrganizationDeletion(remove)).toEqual({
      organizationId: scope,
      changed: true,
    });
    expect(await store.identity.applyWorkosOrganizationDeletion(remove)).toEqual({
      organizationId: scope,
      changed: true,
    });
    expect(await all("SELECT state FROM organizations WHERE organization_id = ?", scope)).toEqual([
      { state: "deleted" },
    ]);
    expect(
      await all("SELECT state FROM m2m_organization_bindings WHERE organization_id = ?", scope),
    ).toEqual([{ state: "revoked" }]);
    expect(
      await all(
        "SELECT api_key_id FROM api_key_metadata WHERE organization_id = ? AND revoked_at IS NULL",
        scope,
      ),
    ).toEqual([]);
    expect(
      await all(
        "SELECT grant_id FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
        scope,
      ),
    ).toEqual([]);
    const late = await event(workosId, "organization.updated");
    const lateClaim = await claim();
    if (lateClaim === null) throw new Error("late claim missing");
    expect(lateClaim.organizationId).toBeNull(); // Routing metadata may be absent even for a retained deleted subject.
    expect(
      await store.identity.applyPolledWorkosSnapshot(
        snapshot(scope, workosId, late, lateClaim.claimId),
      ),
    ).toMatchObject({ ignoredAfterDeletion: true });
    expect(await all("SELECT state FROM organizations WHERE organization_id = ?", scope)).toEqual([
      { state: "deleted" },
    ]);
    expect(
      await all(
        "SELECT grant_id FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
        scope,
      ),
    ).toEqual([]);
    // A delete-before-create observation retains its stable identity and blocks a later first snapshot as well.
    const unbornWorkos = "org_unborn_poller";
    const unbornDelete = await event(unbornWorkos, "organization.deleted");
    const unborn = await claim();
    if (unborn === null) throw new Error("unborn claim missing");
    expect(
      await store.identity.applyWorkosOrganizationDeletion(
        deletion(unborn.organizationId, unbornWorkos, unbornDelete, unborn.claimId),
      ),
    ).toMatchObject({ changed: true });
    await poller.revokeLocalAuthorizationForUncertainSnapshot({
      workosOrganizationId: "org_unknown_poller",
      revokedAt: now(),
    });
    await poller.revokeLocalAuthorizationForUncertainSnapshot({
      workosOrganizationId: " ",
      revokedAt: now(),
    });
    await poller.revokeLocalAuthorizationForUncertainSnapshot({
      workosOrganizationId: workosId,
      revokedAt: now(),
    });
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
    await exercisePollerPort();
  });

  it("keeps a WorkOS outage retrying after the attempt budget is used, while a permanent error still parks the event", async () => {
    const outage = await event("org_outage_poller", "organization.updated", 2);
    const first = await claim();
    if (first === null) throw new Error("outage claim missing");
    expect(first).toMatchObject({ inboxEventId: outage, attemptNumber: 1 });
    const retryAt = later(30);
    expect(
      await store.identity.recordWorkosInboxFailure({
        organizationId: first.organizationId,
        inboxEventId: outage,
        claimId: first.claimId,
        failedAt: now(),
        errorCode: "WORKOS_UNAVAILABLE",
        nextAvailableAt: retryAt,
      }),
    ).toBe("retry_scheduled");
    await waitUntil(retryAt);
    const second = await claim();
    if (second === null) throw new Error("second outage claim missing");
    expect(second).toMatchObject({ inboxEventId: outage, attemptNumber: 2 });
    const secondRetryAt = later(30);
    expect(
      await store.identity.recordWorkosInboxFailure({
        organizationId: second.organizationId,
        inboxEventId: outage,
        claimId: second.claimId,
        failedAt: now(),
        errorCode: "WORKOS_UNAVAILABLE",
        nextAvailableAt: secondRetryAt,
      }),
    ).toBe("retry_scheduled");
    expect(
      await all("SELECT state, attempt_count FROM webhook_inbox WHERE inbox_event_id = ?", outage),
    ).toEqual([{ state: "retry_wait", attempt_count: 1 }]);
    await waitUntil(secondRetryAt);
    const third = await claim();
    if (third === null) throw new Error("third outage claim missing");
    expect(third).toMatchObject({ inboxEventId: outage, attemptNumber: 2 });
    // A permanent contract error on the final attempt is still terminal.
    expect(
      await store.identity.recordWorkosInboxFailure({
        organizationId: third.organizationId,
        inboxEventId: outage,
        claimId: third.claimId,
        failedAt: now(),
        errorCode: "WORKOS_INVALID_SNAPSHOT",
        nextAvailableAt: later(30),
      }),
    ).toBe("reconciliation_required");
  });

  it("resets a WorkOS outage at the attempt limit only while its receipt is under 24 hours old, and parks an older one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const young = await event("org_outage_young", "organization.updated", 2);
    const old = await event("org_outage_old", "organization.updated", 2);
    // Received 23 h 59 min and 24 h 1 min before the failure: the window closes exactly at 24 hours.
    const receivedAgo = (ms: number) => stored(new Date(Date.now() - ms).toISOString());
    for (const [inboxEventId, ms] of [
      [young, 86_340_000],
      [old, 86_460_000],
    ] as const)
      await control.core
        .prepare(
          "UPDATE webhook_inbox SET received_at = ?1, available_at = ?1 WHERE inbox_event_id = ?2",
        )
        .bind(receivedAgo(ms), inboxEventId)
        .run();
    const failed = (
      claimed: NonNullable<Awaited<ReturnType<typeof claim>>>,
      nextAvailableAt: string,
    ) =>
      store.identity.recordWorkosInboxFailure({
        organizationId: claimed.organizationId,
        inboxEventId: claimed.inboxEventId,
        claimId: claimed.claimId,
        failedAt: now(),
        errorCode: "WORKOS_UNAVAILABLE",
        nextAvailableAt,
      });
    // The first attempt of each event fails with a retry.
    for (let round = 0; round < 2; round++) {
      const first = await claim();
      if (first === null) throw new Error("first outage claim missing");
      expect(first).toMatchObject({ attemptNumber: 1 });
      expect(await failed(first, later(30))).toBe("retry_scheduled");
    }
    await waitUntil(later(40));
    // The second attempt is the limit: a young receipt is re-driven with a fresh count, an old one is parked. The
    // re-driven event is due an hour ahead, so no later test in this file claims it.
    const outcome = new Map([
      [young, "retry_scheduled"],
      [old, "reconciliation_required"],
    ]);
    for (let round = 0; round < 2; round++) {
      const last = await claim();
      if (last === null) throw new Error("final outage claim missing");
      expect(last).toMatchObject({ attemptNumber: 2 });
      expect(await failed(last, later(3_600_000))).toBe(outcome.get(last.inboxEventId));
    }
    expect(
      await all("SELECT state, attempt_count FROM webhook_inbox WHERE inbox_event_id = ?", young),
    ).toEqual([{ state: "retry_wait", attempt_count: 1 }]);
    expect(
      await all("SELECT state, attempt_count FROM webhook_inbox WHERE inbox_event_id = ?", old),
    ).toEqual([{ state: "reconciliation_required", attempt_count: 2 }]);
    // Only the re-driven receipt is a reset, so only it is logged.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "workos_inbox_outage_reset",
      inboxEventId: young,
    });
    warn.mockRestore();
  });

  it("fences expiry at SQL execution, recovers final attempts, observes a lost claim reply and rolls back late ACK failures", async () => {
    expect(await claim()).toBeNull();
    const id = await event("org_retry_poller", "organization.updated", 2);
    const token = { claimId: newUlid(), claimedAt: now(), leaseExpiresAt: later(60_000) };
    const lostStore = createControlStore({ CONTROL_CORE: losingNthResponse(control.core, 2) });
    const held = await lostStore.identity.claimWorkosInboxEvent(token);
    if (held === null) throw new Error("retry claim missing");
    expect((await store.identity.claimWorkosInboxEvent(token))?.inboxEventId).toBe(id);
    expect(
      await all("SELECT attempt_count FROM webhook_inbox WHERE inbox_event_id = ?", id),
    ).toEqual([{ attempt_count: 1 }]);
    const failure = {
      organizationId: held.organizationId,
      inboxEventId: id,
      claimId: held.claimId,
      failedAt: now(),
      errorCode: "WORKOS_UNAVAILABLE",
      nextAvailableAt: later(30),
    };
    await expect(
      store.identity.recordWorkosInboxFailure({ ...failure, nextAvailableAt: failure.failedAt }),
    ).rejects.toThrow(RangeError);
    expect(await store.identity.recordWorkosInboxFailure({ ...failure, claimId: newUlid() })).toBe(
      "stale_claim",
    );
    expect(
      await poller.recordFailure({
        claim: held,
        failedAt: failure.failedAt,
        errorCode: failure.errorCode,
        nextAvailableAt: failure.nextAvailableAt,
      }),
    ).toBe("retry_scheduled");
    await waitUntil(failure.nextAvailableAt);
    const lastLease = later(1_500);
    const last = await store.identity.claimWorkosInboxEvent({
      claimId: newUlid(),
      claimedAt: now(),
      leaseExpiresAt: lastLease,
    });
    if (last === null) throw new Error("last claim missing");
    expect(last.attemptNumber).toBe(2);
    expect(
      await store.identity.findExpiredFinalWorkosInboxClaim({ observedAt: later(86_400_000) }),
    ).toBeNull();
    expect(
      await store.identity.recoverExpiredFinalWorkosInboxLease({
        organizationId: last.organizationId,
        inboxEventId: id,
        claimId: last.claimId,
        recoveredAt: later(86_400_000),
        errorCode: "WORKOS_LEASE_EXPIRED",
      }),
    ).toBe(false);
    await waitUntil(lastLease);
    expect(await poller.findExpiredFinalClaim({ observedAt: now() })).toMatchObject({
      inboxEventId: id,
    });
    expect(
      await store.identity.recordWorkosInboxFailure({
        ...failure,
        claimId: last.claimId,
        failedAt: now(),
        nextAvailableAt: later(1_000),
      }),
    ).toBe("stale_claim");
    expect(
      await poller.recoverExpiredFinalClaim({
        claim: last,
        recoveredAt: now(),
        errorCode: "WORKOS_LEASE_EXPIRED",
      }),
    ).toBe(true);
    expect(
      await all(
        "SELECT state, attempt_count, max_attempts FROM webhook_inbox WHERE inbox_event_id = ?",
        id,
      ),
    ).toEqual([{ state: "reconciliation_required", attempt_count: 2, max_attempts: 2 }]);

    const delayedId = await event("org_delayed_poller");
    const lease = later(2_500);
    const delayed = await store.identity.claimWorkosInboxEvent({
      claimId: newUlid(),
      claimedAt: now(),
      leaseExpiresAt: lease,
    });
    if (delayed === null) throw new Error("delayed claim missing");
    const delayedStore = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, /INSERT INTO organizations/u, () => waitUntil(lease)),
    });
    const apply = snapshot(
      delayed.organizationId,
      "org_delayed_poller",
      delayedId,
      delayed.claimId,
    );
    await expect(delayedStore.identity.applyPolledWorkosSnapshot(apply)).rejects.toMatchObject({
      code: "inbox_claim_stale",
    });
    for (const table of [
      "org_directory",
      "organizations",
      "organization_memberships",
      "local_authorization_grants",
      "audit_events",
      "organization_audit_events",
    ]) {
      expect(
        await all(`SELECT * FROM ${table} WHERE organization_id = ?`, delayed.organizationId),
        table,
      ).toEqual([]);
    }
    expect(
      await all("SELECT state FROM webhook_inbox WHERE inbox_event_id = ?", delayedId),
    ).toEqual([{ state: "processing" }]);
    // The same rolled-back event is reclaimable, but a later deletion ACK failure must also roll back its tombstone.
    const reclaim = await claim();
    if (reclaim === null) throw new Error("reclaim missing");
    const removal = deletion(reclaim.organizationId, "org_delayed_poller", delayedId, newUlid());
    await expect(store.identity.applyWorkosOrganizationDeletion(removal)).rejects.toMatchObject({
      code: "inbox_claim_stale",
    });
    expect(
      await all("SELECT * FROM organizations WHERE organization_id = ?", reclaim.organizationId),
    ).toEqual([]);
    // Complete the event to leave no live work for a later test.
    await store.identity.applyPolledWorkosSnapshot(
      snapshot(reclaim.organizationId, "org_delayed_poller", delayedId, reclaim.claimId),
    );
    expect(await claim()).toBeNull();
    // The canonical global identity is answered regardless of a newly proposed routing hint or id.
    for (const bodyDigest of ["ab".repeat(32), "de".repeat(32)]) {
      const duplicateId = newUlid();
      const record = store.operations.recordInboxEvent({
        provider: "workos",
        inboxEventId: duplicateId,
        externalEventId: `evt_${id}`,
        eventType: "organization.updated",
        payload: {
          schemaVersion: "workos.organization-trigger.v1",
          workosOrganizationId: "org_retry_poller",
        },
        bodyDigest,
        receivedAt: now(),
        signatureTimestamp: now(),
        maxAttempts: 2,
        routing: { kind: "workos_organization", workosOrganizationId: "org_retry_poller" },
      });
      if (bodyDigest.startsWith("ab")) expect(await record).toMatchObject({ outcome: "existing" });
      else await expect(record).rejects.toMatchObject({ code: "webhook_inbox_content_conflict" });
      expect(await all("SELECT 1 FROM inbox_unrouted WHERE inbox_event_id=?", duplicateId)).toEqual(
        [],
      );
      expect(await claim()).toBeNull();
    }
    await expect(
      store.identity.claimWorkosInboxEvent({
        claimId: newUlid(),
        claimedAt: now(),
        leaseExpiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(RangeError);
  });

  it("parks a permanent transport failure at the attempt limit, and logs only the outage reset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const permanent = await event("org_permanent_transport", "organization.updated", 1);
      const parked = await claim();
      if (parked === null) throw new Error("permanent transport claim missing");
      expect(parked).toMatchObject({ inboxEventId: permanent, attemptNumber: 1 });
      expect(
        await store.identity.recordWorkosInboxFailure({
          organizationId: parked.organizationId,
          inboxEventId: permanent,
          claimId: parked.claimId,
          failedAt: now(),
          errorCode: "WORKOS_TRANSPORT_PERMANENT",
          nextAvailableAt: later(30),
        }),
      ).toBe("reconciliation_required");
      expect(warn).not.toHaveBeenCalled();
      expect(
        await all(
          "SELECT state, attempt_count, last_error_code FROM webhook_inbox WHERE inbox_event_id = ?",
          permanent,
        ),
      ).toEqual([
        {
          state: "reconciliation_required",
          attempt_count: 1,
          last_error_code: "WORKOS_TRANSPORT_PERMANENT",
        },
      ]);

      const outage = await event("org_outage_logged", "organization.updated", 1);
      const outaged = await claim();
      if (outaged === null) throw new Error("outage claim missing");
      expect(outaged).toMatchObject({ inboxEventId: outage, attemptNumber: 1 });
      expect(
        await store.identity.recordWorkosInboxFailure({
          organizationId: outaged.organizationId,
          inboxEventId: outage,
          claimId: outaged.claimId,
          failedAt: now(),
          errorCode: "WORKOS_UNAVAILABLE",
          nextAvailableAt: later(30),
        }),
      ).toBe("retry_scheduled");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        event: "workos_inbox_outage_reset",
        inboxEventId: outage,
      });
      expect(
        await all(
          "SELECT state, attempt_count FROM webhook_inbox WHERE inbox_event_id = ?",
          outage,
        ),
      ).toEqual([{ state: "retry_wait", attempt_count: 1 }]);
    } finally {
      warn.mockRestore();
    }
  });
});

/** The actual poller port: claim, snapshot with its ACK, deletion with its ACK and a late snapshot, checked against the stored Core rows. */
async function exercisePollerPort() {
  const workosId = "org_port_poller";
  const scope = await derivedOrganizationId(workosId);
  const snapshotAt = now();
  const source = parseWorkosOrganizationSnapshot(
    {
      organization: { id: workosId, name: "Port", created_at: snapshotAt, updated_at: snapshotAt },
      memberships: [
        {
          id: "om_port",
          organization_id: workosId,
          user_id: "user_port",
          status: "active",
          roles: [{ slug: "admin" }],
          created_at: snapshotAt,
          updated_at: snapshotAt,
        },
      ],
    },
    new Date(),
  );
  const application = {
    organizationId: scope,
    triggerEventId: "",
    snapshot: source,
    canonicalSnapshot: canonicalizeWorkosOrganizationSnapshot(source),
  };
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const inboxIds: string[] = [];
  const claimed = async (type: string) => {
    inboxIds.push(await event(workosId, type));
    const claim = await poller.claim({
      claimId: newUlid(),
      claimedAt: now(),
      leaseExpiresAt: later(60_000),
    });
    if (claim === null) throw new Error("port claim missing");
    return claim;
  };
  const state = async () => ({
    organization: await all(
      "SELECT state, mapping_revision, lower(hex(snapshot_sha256)) AS digest FROM organizations WHERE organization_id = ?",
      scope,
    ),
    memberships: await all(
      "SELECT workos_user_id, role, state, mapping_revision, lower(hex(snapshot_sha256)) AS digest FROM organization_memberships WHERE organization_id = ? ORDER BY workos_user_id",
      scope,
    ),
    grants: await all(
      "SELECT principal_kind, principal_id, role FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL ORDER BY principal_id",
      scope,
    ),
    inbox: await all(
      "SELECT external_event_id, state, attempt_count, max_attempts FROM webhook_inbox WHERE provider='workos' AND json_extract(payload,'$.workosOrganizationId') = ? ORDER BY external_event_id",
      workosId,
    ),
  });
  const acknowledged = () =>
    inboxIds.map((id) => ({
      external_event_id: `evt_${id}`,
      state: "acknowledged",
      attempt_count: 1,
      max_attempts: 3,
    }));
  const live = {
    organization: [
      { state: "active", mapping_revision: 1, digest: sha256(application.canonicalSnapshot) },
    ],
    memberships: [
      {
        workos_user_id: "user_port",
        role: "admin",
        state: "active",
        mapping_revision: 1,
        digest: sha256(JSON.stringify(source.memberships[0])),
      },
    ],
    grants: [{ principal_kind: "user", principal_id: "user:user_port", role: "owner" }],
  };
  for (const type of ["organization.created", "organization.updated"]) {
    const claim = await claimed(type);
    expect(claim).toMatchObject({ eventType: type, attemptNumber: 1 });
    expect(
      await poller.applySnapshotAndAcknowledge({
        claim,
        application: { ...application, triggerEventId: claim.externalEventId },
        synchronizedAt: now(),
      }),
    ).toEqual({ organizationId: scope });
    // The second, identical snapshot keeps revision 1 and its digest; only the new inbox event is acknowledged.
    expect(await state()).toEqual({ ...live, inbox: acknowledged() });
  }
  const keyId = newUlid();
  await control.core
    .prepare(
      "INSERT INTO api_key_metadata(api_key_id, created_by_principal_id, organization_id, key_digest, key_prefix, pepper_version, scopes, created_at) VALUES (?1, 'user:owner', ?2, ?3, 'omh_test', 1, json_array('projects:read'), ?4)",
    )
    .bind(keyId, scope, new Uint8Array(32).fill(9), stored(now()))
    .run();
  const removal = await claimed("organization.deleted");
  const tombstone = JSON.stringify({
    schemaVersion: "workos.organization-deletion.v1",
    workosOrganizationId: workosId,
  });
  expect(
    await poller.applyDeletionAndAcknowledge({
      claim: removal,
      deletion: {
        organizationId: scope,
        workosOrganizationId: workosId,
        triggerEventId: removal.externalEventId,
        canonicalTombstone: tombstone,
      },
      deletedAt: now(),
    }),
  ).toEqual({ organizationId: scope });
  const deleted = {
    organization: [{ state: "deleted", mapping_revision: 2, digest: sha256(tombstone) }],
    memberships: [
      {
        workos_user_id: "user_port",
        role: "admin",
        state: "revoked",
        mapping_revision: 2,
        digest: sha256(tombstone),
      },
    ],
    grants: [],
    inbox: acknowledged(),
  };
  expect(await state()).toEqual(deleted);
  expect(
    await all(
      "SELECT revoked_at IS NOT NULL AS revoked FROM api_key_metadata WHERE api_key_id = ?",
      keyId,
    ),
  ).toEqual([{ revoked: 1 }]);
  // A snapshot observed after deletion is acknowledged but never revives the organization.
  const late = await claimed("organization.updated");
  await poller.applySnapshotAndAcknowledge({
    claim: late,
    application: { ...application, triggerEventId: late.externalEventId },
    synchronizedAt: now(),
  });
  expect(await state()).toEqual({ ...deleted, inbox: acknowledged() });
}

it("returns the same claimed event to concurrent identical claim requests after both snapshots read no held token", async () => {
  const control = await createTestControl();
  try {
    const original = createControlStore(control.bindings);
    const organizationId = newUlid();
    await original.identity.applyOrganizationSnapshot({
      organizationId,
      workosOrganizationId: "org_claim_race",
      state: "active",
      snapshotDigest: "ab".repeat(32),
      snapshotFetchedAt: now(),
      synchronizedAt: now(),
      triggerEventId: "evt_seed_race",
      memberships: [],
      auditEventId: newUlid(),
    });
    for (const routing of ["routed", "unrouted"] as const) {
      // Start each scenario with no previous processing token; the historical rows remain intact.
      await control.core
        .prepare(
          "UPDATE webhook_inbox SET state='acknowledged',attempt_count=max(attempt_count,1),last_error_code=NULL,acknowledged_at=?1,claim_id=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE acknowledged_at IS NULL",
        )
        .bind(stored(now()))
        .run();
      const spareId = newUlid();
      await original.operations.recordInboxEvent({
        provider: "workos",
        inboxEventId: spareId,
        externalEventId: `evt_${spareId}`,
        eventType: "organization.updated",
        payload: {
          schemaVersion: "workos.organization-trigger.v1",
          workosOrganizationId: "org_claim_race",
        },
        bodyDigest: "ab".repeat(32),
        receivedAt: now(),
        signatureTimestamp: now(),
        maxAttempts: 3,
        routing: { kind: "organization", organizationId },
      });
      const spare = await original.identity.claimWorkosInboxEvent({
        claimId: newUlid(),
        claimedAt: now(),
        leaseExpiresAt: later(60_000),
      });
      expect(spare?.inboxEventId).toBe(spareId);
      const ids = [newUlid(), newUlid()];
      for (const id of ids) {
        if (routing === "unrouted") {
          await control.core
            .prepare(
              `INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,max_attempts,signature_timestamp) VALUES (?1,'workos',?2,'org_claim_race_unmapped','organization.updated',?3,unhex(?4),?5,?6,3,?5)`,
            )
            .bind(
              id,
              `evt_${id}`,
              JSON.stringify({
                schemaVersion: "workos.organization-trigger.v1",
                workosOrganizationId: "org_claim_race_unmapped",
              }),
              "cd".repeat(32),
              stored(now()),
              stored(later(60_000)),
            )
            .run();
          continue;
        }
        await original.operations.recordInboxEvent({
          provider: "workos",
          inboxEventId: id,
          externalEventId: `evt_${id}`,
          eventType: "organization.updated",
          payload: {
            schemaVersion: "workos.organization-trigger.v1",
            workosOrganizationId:
              routing === "routed" ? "org_claim_race" : "org_claim_race_unmapped",
          },
          bodyDigest: "cd".repeat(32),
          receivedAt: now(),
          signatureTimestamp: now(),
          maxAttempts: 3,
          routing:
            routing === "routed"
              ? { kind: "organization", organizationId }
              : { kind: "workos_organization", workosOrganizationId: "org_claim_race_unmapped" },
        });
      }
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let readCount = 0;
      // Real D1 snapshots complete first. Neither mutation can begin until BOTH snapshots returned no held claim.
      const blocked = (db: D1Database): D1Database => {
        const wrap = (
          inner: D1PreparedStatement,
          sql: string,
        ): D1PreparedStatement & { inner: D1PreparedStatement; sql: string } => ({
          inner,
          sql,
          bind: (...values) => wrap(inner.bind(...values), sql),
          first: () => inner.first(),
          all: () => inner.all(),
          run: () => inner.run(),
        });
        let first = true;
        return {
          prepare: (sql) => wrap(db.prepare(sql), sql),
          batch: async (statements) => {
            const typed = statements as (D1PreparedStatement & {
              inner: D1PreparedStatement;
              sql: string;
            })[];
            const result = await db.batch(typed.map((x) => x.inner));
            if (
              first &&
              typed.some((x) => x.sql.includes("WHERE claim_id = ?1 AND provider = 'workos'"))
            ) {
              first = false;
              expect(result[0]?.results).toEqual([]);
              readCount++;
              if (readCount === 2) release?.();
              await gate;
            }
            return result;
          },
        };
      };
      const request = { claimId: newUlid(), claimedAt: now(), leaseExpiresAt: later(60_000) };
      // The same token in another provider is unrelated, just as in the original global inbox.
      const githubId = newUlid();
      await original.operations.recordInboxEvent({
        provider: "github",
        inboxEventId: githubId,
        externalEventId: crypto.randomUUID(),
        eventType: "push",
        payload: {},
        bodyDigest: "ef".repeat(32),
        receivedAt: request.claimedAt,
        maxAttempts: 3,
        routing: { kind: "organization", organizationId },
      });
      await original.operations.claimInboxEvent({ ...request, organizationId, provider: "github" });
      const workers = [
        createControlStore({ CONTROL_CORE: blocked(control.core) }),
        createControlStore({ CONTROL_CORE: blocked(control.core) }),
      ];
      const [first, second] = await Promise.all(
        workers.map((worker) => worker.identity.claimWorkosInboxEvent(request)),
      );
      expect(readCount).toBe(2);
      expect(first?.inboxEventId).toBe(second?.inboxEventId);
      expect(ids).toContain(first?.inboxEventId);
      const rows = (
        await control.core
          .prepare(
            "SELECT inbox_event_id,attempt_count FROM webhook_inbox WHERE provider='workos' AND state='processing' AND claim_id=?1",
          )
          .bind(request.claimId)
          .all()
      ).results;
      expect(rows).toEqual([{ inbox_event_id: first?.inboxEventId, attempt_count: 1 }]);
      expect(
        await control.core
          .prepare(
            "SELECT count(*) AS n FROM webhook_inbox WHERE provider='workos' AND state='processing'",
          )
          .first(),
      ).toEqual({ n: 2 });
      expect(
        await control.core
          .prepare("SELECT claim_id FROM webhook_inbox WHERE inbox_event_id=?")
          .bind(spareId)
          .first(),
      ).toEqual({ claim_id: spare?.claimId });
      expect(
        await control.core
          .prepare("SELECT claim_id FROM webhook_inbox WHERE inbox_event_id=?")
          .bind(githubId)
          .first(),
      ).toEqual({ claim_id: request.claimId });
    }
  } finally {
    await control.dispose();
  }
}, 30_000);
