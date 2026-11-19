import { buildRig, cid, fundBuild } from "../support/build-fixtures.js";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { D1Database } from "../../src/d1-types.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { runReleaseReservation } from "../../src/catalog/credit/index.js";
import { accountOf } from "../support/credit-fixtures.js";
import {
  beforeFirstWrite,
  freezeOwnership,
  losingWriteResponses,
} from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});
async function waitClock(db: D1Database, after: string) {
  while (true) {
    const row = await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z' AS now")
      .first<{ now: string }>();
    if (row !== null && row.now > after) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("fences actual SQL-clock claims, duplicate launch attempts, immutable receipt identity and lost provider replies", async () => {
  const r = await buildRig(control);
  const twins = await Promise.all([
    r.store.build.claimBuildInput(r.claim),
    r.store.build.claimBuildInput({ ...r.claim, claimId: cid() }),
  ]);
  expect(twins.map((t) => t.status).sort()).toEqual(["claimed", "pending"]);
  await expect(
    r.store.build.authorizeBuildStart({ scope: r.scope, claimId: r.claim.claimId }),
  ).resolves.toBe(false);
  await fundBuild(r);
  const reservation = await control.core
    .prepare("SELECT claim_id FROM build_input_reservations WHERE operation_id=?")
    .bind(r.scope.operationId)
    .first<{ claim_id: string }>();
  const winner = reservation?.claim_id as string;
  await expect(
    r.store.build.authorizeBuildStart({ scope: r.scope, claimId: winner }),
  ).resolves.toBe(true);
  await expect(r.store.build.authorizeBuildStart({ scope: r.scope, claimId: cid() })).resolves.toBe(
    false,
  );
  await expect(
    r.store.build.claimBuildInput({ ...r.claim, inputFingerprint: `sha256:${"cd".repeat(32)}` }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  await expect(
    r.store.build.claimBuildInput({ ...r.claim, now: "2099-01-01T00:00:00.000Z" }),
  ).rejects.toThrow();
  await expect(
    r.store.build.claimBuildInput({ ...r.claim, leaseMilliseconds: 300_001 }),
  ).rejects.toThrow();
  await expect(r.store.build.claimBuildInput({ ...r.claim, claimId: "invalid" })).rejects.toThrow();
  await expect(
    r.store.build.claimBuildInput({
      ...r.claim,
      scope: { ...r.scope, projectId: r.project.organizationId },
    }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  const envelope = { ...r.envelope, claimId: winner };
  const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
  await lossy.build.putBuildReceipt(envelope);
  await r.store.build.putBuildReceipt(envelope);
  await expect(
    r.store.build.authorizeBuildStart({ scope: r.scope, claimId: winner }),
  ).resolves.toBe(false);
  expect(await r.store.build.claimBuildInput({ ...r.claim, claimId: cid() })).toEqual({
    status: "completed",
    envelope,
  });
  await expect(
    r.store.build.putBuildReceipt({ ...envelope, receipt: { ...r.receipt, buildId: "different" } }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  const other = await buildRig(control);
  await expect(
    other.store.build.claimBuildInput({ ...other.claim, claimId: winner }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  await other.store.build.claimBuildInput(other.claim);
  await expect(
    other.store.build.putBuildReceipt({
      ...other.envelope,
      receipt: { ...other.receipt, buildId: r.receipt.buildId },
    }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  await freezeOwnership(other.project);
  await expect(other.store.build.putBuildReceipt(other.envelope)).rejects.toMatchObject({
    code: "build_input_conflict",
  });

  const expired = await buildRig(control);
  const first = await expired.store.build.claimBuildInput({
    ...expired.claim,
    leaseMilliseconds: 5,
  });
  if (first.status !== "claimed") throw new Error("claim not created");
  await waitClock(control.core, first.leaseExpiresAt.toISOString().replace(/Z$/u, "000Z"));
  await expect(
    expired.store.build.authorizeBuildStart({
      scope: expired.scope,
      claimId: expired.claim.claimId,
    }),
  ).resolves.toBe(false);
  const reclaimed = await expired.store.build.claimBuildInput({ ...expired.claim, claimId: cid() });
  expect(reclaimed).toMatchObject({ status: "claimed", attemptNumber: 2, mode: "start" });
  await expect(expired.store.build.putBuildReceipt(expired.envelope)).rejects.toMatchObject({
    code: "build_input_conflict",
  });

  const delayed = await buildRig(control);
  const delayedStore = createControlStore({
    CONTROL_CORE: beforeFirstWrite(control.core, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }),
  });
  const began = Date.now();
  const delayedClaim = await delayedStore.build.claimBuildInput({
    ...delayed.claim,
    leaseMilliseconds: 500,
  });
  expect(delayedClaim.status).toBe("claimed");
  if (delayedClaim.status === "claimed")
    expect(delayedClaim.leaseExpiresAt.getTime()).toBeGreaterThan(began + 500);
  const lost = await buildRig(control);
  const lostClaim = await createControlStore({
    CONTROL_CORE: losingWriteResponses(control.core, 1),
  }).build.claimBuildInput(lost.claim);
  expect(lostClaim).toMatchObject({ status: "claimed", attemptNumber: 1 });

  // Imported expired reservation: the original four-minute window is retained; a fresh claim can only observe.
  const old = await buildRig(control);
  const stamp = (modifier: string) =>
    `(strftime('%Y-%m-%dT%H:%M:%f','now','${modifier}') || '000Z')`;
  await control.core
    .prepare(
      `INSERT INTO build_input_reservations(organization_id,project_id,environment_id,operation_id,input_fingerprint,claim_id,claim_mode,
    claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until)
    VALUES (?1,?2,?3,?4,?5,?6,'start',${stamp("-5 minutes")},${stamp("-270 seconds")},1,${stamp("-5 minutes")},${stamp("-1 minute")})`,
    )
    .bind(
      old.project.organizationId,
      old.scope.projectId,
      old.scope.environmentId,
      old.scope.operationId,
      new Uint8Array(32).fill(0xab),
      old.claim.claimId,
    )
    .run();
  const observe = await old.store.build.claimBuildInput({ ...old.claim, claimId: cid() });
  expect(observe).toMatchObject({ status: "claimed", mode: "observe", attemptNumber: 2 });
  if (observe.status === "claimed") {
    expect(observe.startAllowedUntil.getTime() - observe.reservationCreatedAt.getTime()).toBe(
      240_000,
    );
  }
  await fundBuild(old);
  await expect(
    old.store.build.authorizeBuildStart({
      scope: old.scope,
      claimId:
        observe.status === "claimed"
          ? (
              await control.core
                .prepare("SELECT claim_id FROM build_input_reservations WHERE operation_id=?")
                .bind(old.scope.operationId)
                .first<{ claim_id: string }>()
            )?.claim_id
          : old.claim.claimId,
    }),
  ).resolves.toBe(false);

  const race = await buildRig(control);
  const racingStore = createControlStore({
    CONTROL_CORE: beforeFirstWrite(control.core, () => freezeOwnership(race.project)),
  });
  await expect(racingStore.build.claimBuildInput(race.claim)).rejects.toMatchObject({
    code: "build_input_conflict",
  });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM build_input_reservations WHERE operation_id=?")
        .bind(race.scope.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
}, 30_000);

it("commits immutable usage and accepted-plan settlement together, preserves historical attribution, and never charges an unpriced instance or unreserved history", async () => {
  const r = await buildRig(control);
  await fundBuild(r);
  await r.store.build.claimBuildInput(r.claim);
  await r.store.build.putBuildReceipt(r.envelope);
  const measured = {
    receipt: r.receipt,
    usage: {
      runner: "cloudflare-build-sandbox",
      instanceType: "standard-3",
      status: "SUCCEEDED",
      startedAt: "2026-10-28T12:00:00.000Z",
      provisioningStartedAt: "2026-10-28T12:00:00.800Z",
      completedAt: "2026-10-28T12:01:57.286Z",
    },
  };
  // A build whose sandbox never started releases its reservation instead (build-settlement.test.ts); the unpriced instance still refuses.
  await expect(
    r.store.build.putBuildUsage({
      ...measured,
      usage: { ...measured.usage, instanceType: "unpriced" },
    }),
  ).rejects.toThrow("no published price");
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM build_usage WHERE operation_id=?")
        .bind(r.scope.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  const orgId = r.project.organizationId;
  await control.core
    .prepare(
      "CREATE TRIGGER build_test_late_abort BEFORE UPDATE ON credit_account WHEN NEW.reserved_micros < OLD.reserved_micros BEGIN SELECT RAISE(ABORT, 'late settlement failure'); END",
    )
    .run();
  const before = await accountOf(control.core, orgId);
  expect(before).toMatchObject({ reserved_micros: 16_869_120, monthly_micros: 200_000_000 });
  await expect(r.store.build.putBuildUsage(measured)).rejects.toThrow("late settlement failure");
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM build_usage WHERE operation_id=?")
        .bind(r.scope.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  expect(await accountOf(control.core, orgId)).toEqual(before);
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM credit_log WHERE key=?")
      .bind(`settle:${r.scope.operationId}`)
      .first(),
  ).toEqual({ n: 0 });
  await control.core.prepare("DROP TRIGGER build_test_late_abort").run();
  // A later ownership freeze affects new launch authority, never the accepted receipt's immutable financial attribution.
  await freezeOwnership(r.project);
  await createControlStore({
    CONTROL_CORE: losingWriteResponses(control.core, 1),
  }).build.putBuildUsage(measured);
  // 117 measured seconds at the quoted rate (16.86912 credits per 840 s) are charged; the rest of the reservation is released.
  const settled = await accountOf(control.core, orgId);
  expect(settled).toMatchObject({
    reserved_micros: 0,
    monthly_micros: 200_000_000 - 2_349_628,
    onetime_micros: 0,
  });
  expect(
    await control.core
      .prepare("SELECT 1 FROM credit_reservation WHERE reservation_id=?")
      .bind(r.scope.operationId)
      .first(),
  ).toBeNull();
  const logged = await control.core
    .prepare("SELECT kind,delta_micros,detail FROM credit_log WHERE key=?")
    .bind(`settle:${r.scope.operationId}`)
    .first<{ kind: string; delta_micros: number; detail: string }>();
  expect(logged).toMatchObject({ kind: "settle", delta_micros: -2_349_628 });
  expect(JSON.parse(logged?.detail ?? "{}")).toMatchObject({
    projectId: r.project.projectId,
    operationId: r.scope.operationId,
    seconds: "117",
    chargedMicros: 2_349_628,
    releasedMicros: 16_869_120 - 2_349_628,
  });
  expect(
    await control.core
      .prepare("SELECT used_micros FROM project_credit WHERE project_id=?")
      .bind(r.project.projectId)
      .first(),
  ).toEqual({ used_micros: 2_349_628 });
  const logRows = (
    await control.core.prepare("SELECT count(*) n FROM credit_log").first<{ n: number }>()
  )?.n;
  await r.store.build.putBuildUsage(measured);
  expect(await accountOf(control.core, orgId)).toEqual(settled);
  expect(
    (await control.core.prepare("SELECT count(*) n FROM credit_log").first<{ n: number }>())?.n,
  ).toBe(logRows);
  await expect(
    r.store.build.putBuildUsage({
      ...measured,
      usage: { ...measured.usage, completedAt: "2026-10-28T12:02:00.000Z" },
    }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  await expect(
    r.store.build.putBuildUsage({ ...measured, receipt: { ...r.receipt, buildId: "foreign" } }),
  ).rejects.toMatchObject({ code: "build_input_conflict" });
  await expect(
    control.core
      .prepare("UPDATE build_usage SET status='FAILED' WHERE operation_id=?")
      .bind(r.scope.operationId)
      .run(),
  ).rejects.toThrow("append-only");
  await expect(
    control.core
      .prepare("DELETE FROM build_receipts WHERE operation_id=?")
      .bind(r.scope.operationId)
      .run(),
  ).rejects.toThrow("append-only");
  const unreserved = await buildRig(control);
  await unreserved.store.build.claimBuildInput(unreserved.claim);
  await unreserved.store.build.putBuildReceipt(unreserved.envelope);
  await unreserved.store.build.putBuildUsage({
    ...measured,
    receipt: unreserved.receipt,
    usage: { ...measured.usage, provisioningStartedAt: null },
  });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM credit_log WHERE key=?")
        .bind(`settle:${unreserved.scope.operationId}`)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  // A build whose reservation was released before its usage arrived keeps the usage as evidence and is not charged.
  const released = await buildRig(control);
  await fundBuild(released);
  await released.store.build.claimBuildInput(released.claim);
  await released.store.build.putBuildReceipt(released.envelope);
  await runReleaseReservation(control.core, {
    organizationId: released.project.organizationId,
    reservationId: released.scope.operationId,
    now: "2026-10-28T11:00:00.000Z",
  });
  const releasedBefore = await accountOf(control.core, released.project.organizationId);
  await released.store.build.putBuildUsage({ ...measured, receipt: released.receipt });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM build_usage WHERE operation_id=?")
        .bind(released.scope.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(await accountOf(control.core, released.project.organizationId)).toEqual(releasedBefore);
}, 30_000);
