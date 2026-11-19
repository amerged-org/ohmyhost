import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as inbox from "../../src/catalog/billing/stripe-inbox.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
let control: TestControl;
let store: ReturnType<typeof createControlStore>;
const NOW = "2026-10-29T00:00:00.000Z",
  scope = { accountId: "acct_inbox", mode: "test" as const };
const context = (db: D1Database = control.core) => ({
  directory: db,
  router: new SharedCoreRouter(db),
});
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 240000);
afterAll(async () => control?.dispose());
// time-ordered ids give the claim order (available_at, received_at, inbox_event_id) a deterministic outcome
let sequence = 0;
async function record(account = scope.accountId, mode: "test" | "live" = "test", when = NOW) {
  const id = newUlid(Date.parse(NOW) + ++sequence),
    payload = {
      id: `evt_${id}`,
      type: "checkout.session.completed",
      objectId: `cs_${id}`,
      accountId: account,
      mode,
    };
  expect(
    await store.operations.recordInboxEvent({
      provider: "stripe",
      inboxEventId: id,
      externalEventId: `${account}/${mode}/evt_${id}`,
      eventType: payload.type,
      payload,
      bodyDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      receivedAt: when,
      signatureTimestamp: null,
      maxAttempts: 10,
      routing: { kind: "unscoped", routingKey: `${account}/${mode}` },
    }),
  ).toEqual({ outcome: "created", routed: "unrouted" });
  return { id, payload };
}
async function receipt(id: string) {
  return control.core
    .prepare(
      "SELECT state,attempt_count,claim_id,claimed_at,lease_expires_at,acknowledged_at,last_error_code,available_at,organization_id FROM webhook_inbox WHERE inbox_event_id=?",
    )
    .bind(id)
    .first<Record<string, unknown>>();
}
const T = "2026-10-29T00:00:00.000000Z",
  RETRY = "2026-10-29T00:01:00.000000Z";
it("claims the original global account/mode queue without organization routing, retries behind the next event and acknowledges separately", async () => {
  await record("acct_other", "test", "2026-10-28T23:00:00.000Z");
  await record(scope.accountId, "live", "2026-10-28T23:00:00.000Z");
  const first = await record(),
    second = await record();
  const token = newUlid(),
    input = { ...scope, claimId: token, now: NOW };
  // Only the account/mode queue is served: the other account's and the live event stay untouched.
  expect(await inbox.claimStripeInboxEvent(context(), input)).toEqual({
    inbox_event_id: first.id,
    payload: first.payload,
  });
  expect(await receipt(first.id)).toEqual({
    state: "processing",
    attempt_count: 1,
    claim_id: token,
    claimed_at: T,
    lease_expires_at: "2026-10-29T00:02:00.000000Z",
    acknowledged_at: null,
    last_error_code: null,
    available_at: T,
    organization_id: null,
  });
  expect(
    await inbox.finishStripeInboxEvent(context(), {
      inboxEventId: first.id,
      claimId: token,
      now: NOW,
      errorCode: "STRIPE_UNAVAILABLE",
    }),
  ).toMatchObject({ finished: true });
  // A provider outage gives its claim back: it does not spend the attempt budget, and the row is claimable again.
  expect(await receipt(first.id)).toEqual({
    state: "pending",
    attempt_count: 0,
    claim_id: null,
    claimed_at: null,
    lease_expires_at: null,
    acknowledged_at: null,
    last_error_code: "STRIPE_UNAVAILABLE",
    available_at: RETRY,
    organization_id: null,
  });
  const next = { ...scope, claimId: newUlid(), now: NOW };
  expect(await inbox.claimStripeInboxEvent(context(), next)).toEqual({
    inbox_event_id: second.id,
    payload: second.payload,
  });
  const ack = { inboxEventId: second.id, claimId: next.claimId, now: NOW, errorCode: null };
  expect(await inbox.finishStripeInboxEvent(context(), ack)).toMatchObject({ finished: true });
  expect(await inbox.finishStripeInboxEvent(context(), ack)).toMatchObject({ finished: false });
  expect(await receipt(second.id)).toEqual({
    state: "acknowledged",
    attempt_count: 1,
    claim_id: null,
    claimed_at: null,
    lease_expires_at: null,
    acknowledged_at: T,
    last_error_code: null,
    available_at: RETRY,
    organization_id: null,
  });
  expect((await receipt(first.id))?.["state"]).toBe("pending");
  expect(
    await inbox.claimStripeInboxEvent(context(), { ...scope, claimId: newUlid(), now: NOW }),
  ).toBeNull();
});
it("never parks a provider outage within three days of the receipt, and parks one that old like any other failure", async () => {
  const finishAfterTenClaims = async (account: string, receivedAt: string) => {
    const { id } = await record(account, "test", receivedAt),
      token = newUlid();
    await control.core
      .prepare(
        "UPDATE webhook_inbox SET state='processing',attempt_count=max_attempts,claim_id=?,claimed_at=?,lease_expires_at=? WHERE inbox_event_id=?",
      )
      .bind(token, "2026-10-28T23:59:00.000000Z", "2026-10-29T00:02:00.000000Z", id)
      .run();
    expect(
      await inbox.finishStripeInboxEvent(context(), {
        inboxEventId: id,
        claimId: token,
        now: NOW,
        errorCode: "STRIPE_UNAVAILABLE",
      }),
    ).toMatchObject({ finished: true });
    return receipt(id);
  };
  // On its tenth claim, a day after the receipt: the claim is given back and the row waits the longest time.
  expect(await finishAfterTenClaims("acct_outage_fresh", "2026-10-28T00:00:00.000Z")).toMatchObject(
    {
      state: "retry_wait",
      attempt_count: 9,
      last_error_code: "STRIPE_UNAVAILABLE",
      available_at: "2026-10-29T01:00:00.000000Z",
    },
  );
  // Nine days after the receipt it counts, and the tenth attempt parks it for an operator.
  expect(await finishAfterTenClaims("acct_outage_old", "2026-10-20T00:00:00.000Z")).toMatchObject({
    state: "reconciliation_required",
    attempt_count: 10,
  });
});
it("reports a parking only the first time a row is parked, so a re-driven row that fails again is not a new loss", async () => {
  const account = "acct_first_park";
  const { id } = await record(account, "test", "2026-10-20T00:00:00.000Z");
  const first = newUlid();
  await control.core
    .prepare(
      "UPDATE webhook_inbox SET state='processing',attempt_count=max_attempts,claim_id=?,claimed_at=?,lease_expires_at=? WHERE inbox_event_id=?",
    )
    .bind(first, "2026-10-28T23:59:00.000000Z", "2026-10-29T00:02:00.000000Z", id)
    .run();
  expect(
    await inbox.finishStripeInboxEvent(context(), {
      inboxEventId: id,
      claimId: first,
      now: NOW,
      errorCode: "STRIPE_REJECTED",
    }),
  ).toEqual({ finished: true, parked: true });
  // The re-drive claims the parked row again; its next failure parks it again, which is not a new loss.
  const later = "2026-10-29T03:00:00.000Z",
    second = newUlid();
  expect(
    await inbox.claimStripeInboxEvent(context(), {
      accountId: account,
      mode: "test",
      claimId: second,
      now: later,
    }),
  ).toMatchObject({ inbox_event_id: id });
  expect(
    await inbox.finishStripeInboxEvent(context(), {
      inboxEventId: id,
      claimId: second,
      now: later,
      errorCode: "STRIPE_REJECTED",
    }),
  ).toEqual({ finished: true, parked: false });
  expect(await receipt(id)).toMatchObject({ state: "reconciliation_required", attempt_count: 11 });
  // An interrupted re-drive is not reported either; an interrupted first claim is.
  const third = newUlid();
  expect(
    await inbox.claimStripeInboxEvent(context(), {
      accountId: account,
      mode: "test",
      claimId: third,
      now: "2026-10-29T04:00:00.000Z",
    }),
  ).toMatchObject({ inbox_event_id: id });
  expect(
    await inbox.recoverExpiredStripeInboxClaims(context(), {
      accountId: account,
      mode: "test",
      now: "2026-10-29T05:00:00.000Z",
    }),
  ).toEqual({ count: 1, parkedIds: [] });
  const fresh = await record(account, "test", "2026-10-20T00:00:00.000Z"),
    freshToken = newUlid();
  await control.core
    .prepare(
      "UPDATE webhook_inbox SET state='processing',attempt_count=max_attempts,claim_id=?,claimed_at=?,lease_expires_at=? WHERE inbox_event_id=?",
    )
    .bind(freshToken, "2026-10-28T23:55:00.000000Z", "2026-10-28T23:57:00.000000Z", fresh.id)
    .run();
  expect(
    await inbox.recoverExpiredStripeInboxClaims(context(), {
      accountId: account,
      mode: "test",
      now: "2026-10-29T06:00:00.000Z",
    }),
  ).toEqual({ count: 1, parkedIds: [fresh.id] });
});
it("recovers only the original final expired Stripe claims and keeps wrong tokens/expired ACKs from changing receipt history", async () => {
  const { id } = await record(),
    token = newUlid();
  await control.core
    .prepare(
      "UPDATE webhook_inbox SET state='processing',attempt_count=max_attempts,claim_id=?,claimed_at=?,lease_expires_at=? WHERE inbox_event_id=?",
    )
    .bind(token, "2026-10-28T23:55:00.000000Z", "2026-10-28T23:57:00.000000Z", id)
    .run();
  expect(
    await inbox.finishStripeInboxEvent(context(), {
      inboxEventId: id,
      claimId: token,
      now: NOW,
      errorCode: null,
    }),
  ).toMatchObject({ finished: false });
  expect(
    await inbox.recoverExpiredStripeInboxClaims(context(), { ...scope, now: NOW }),
  ).toMatchObject({ count: 1 });
  expect(await receipt(id)).toEqual({
    state: "reconciliation_required",
    attempt_count: 10,
    claim_id: null,
    claimed_at: null,
    lease_expires_at: null,
    acknowledged_at: null,
    last_error_code: "STRIPE_PROCESSING_INTERRUPTED",
    available_at: T,
    organization_id: null,
  });
  expect(
    await inbox.recoverExpiredStripeInboxClaims(context(), { ...scope, now: NOW }),
  ).toMatchObject({ count: 0 });
  await expect(
    inbox.finishStripeInboxEvent(context(), {
      inboxEventId: id,
      claimId: token,
      now: NOW,
      errorCode: "not redacted",
    }),
  ).rejects.toThrow();
});
it("surfaces an ambiguous claim delivery without claiming a second row or inventing an organization", async () => {
  const a = (await record("acct_unknown")).id,
    b = (await record("acct_unknown")).id;
  let lost = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    bind: (...values) => wrap(statement.bind(...values), sql),
    async first<Row>() {
      const result = await statement.first<Row>();
      if (!lost && sql.includes("WITH candidate")) {
        lost = true;
        throw new Error("Network connection lost");
      }
      return result;
    },
    all: <Row>() => statement.all<Row>(),
    run: () => statement.run(),
  });
  const db: D1Database = {
    prepare: (sql) => wrap(control.core.prepare(sql), sql),
    batch: (statements) => control.core.batch(statements),
  };
  await expect(
    inbox.claimStripeInboxEvent(context(db), {
      accountId: "acct_unknown",
      mode: "test",
      claimId: newUlid(),
      now: NOW,
    }),
  ).rejects.toThrow("Network connection lost");
  expect(lost).toBe(true);
  const states = (
    await control.core
      .prepare(
        "SELECT state,attempt_count,organization_id FROM webhook_inbox WHERE inbox_event_id IN(?,?) ORDER BY attempt_count",
      )
      .bind(a, b)
      .all()
  ).results;
  expect(states).toEqual([
    { state: "pending", attempt_count: 0, organization_id: null },
    { state: "processing", attempt_count: 1, organization_id: null },
  ]);
});
