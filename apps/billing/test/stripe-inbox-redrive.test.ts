import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createUlidFactory, SystemEntropy } from "@ohmyhost/platform";
import { StripeBillingError } from "@ohmyhost/provider-stripe";
import { newUlid } from "../../control-store/src/catalog/common.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { createControlStore } from "../../control-store/src/store.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { createD1BillingPersistence } from "../src/d1-persistence.js";
import {
  createD1RechargePersistence,
  type RechargeRuntimeBinding,
} from "../src/d1-recharge-persistence.js";
import { createBillingRuntime, type BillingProvider } from "../src/runtime.js";

const nativeState = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = nativeState.env;
  },
}));
import { BillingRuntime } from "../../control-store/src/worker-main.js";

// The real Core (D1) behind the Billing Worker's own persistence; only the Stripe provider answer is scripted.
let control: TestControl;
let db: D1Database;
let store: ReturnType<typeof createControlStore>;
let nowMs = Date.parse("2026-11-06T10:00:00.000Z");
let failure: Error | null = null;
const clock = { now: () => new Date(nowMs) };
const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
const MINUTE = 60_000;

beforeAll(async () => {
  control = await createTestControl();
  db = control.core;
  store = createControlStore(control.bindings);
  nativeState.env = control.bindings;
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});

/** Stored instants carry six fractional digits; Date.parse reads milliseconds. */
const ms = (stamp: unknown) => Date.parse(String(stamp).replace(/(\.\d{3})\d{3}Z$/u, "$1Z"));
const stamp = (value: number) => new Date(value).toISOString();
/** Stored instants carry six fractional digits, as the rows' CHECK constraints require. */
const stored = (value: number) => stamp(value).replace(/Z$/u, "000Z");

function billingFor(accountId: string) {
  const configuration = {
    accountId,
    mode: "test" as const,
    paidPriceId: "price_paid",
    topupPriceId: "price_topup",
  };
  const runtime = new (BillingRuntime as unknown as new () => RechargeRuntimeBinding)();
  const provider = {
    resolveWebhookEvent: async () => {
      if (failure) throw failure;
      return null;
    },
  };
  return createBillingRuntime({
    persistence: createD1BillingPersistence(runtime, clock, ids),
    rechargePersistence: createD1RechargePersistence(runtime, configuration, clock),
    provider: provider as unknown as BillingProvider,
    configuration,
    clock,
    ids,
  });
}

async function record(accountId: string) {
  const id = newUlid(nowMs);
  await store.ingress.recordStripeWebhook({
    inboxEventId: id,
    receivedAt: stamp(nowMs),
    event: {
      id: `evt_${id}`,
      type: "invoice.paid",
      objectId: `in_${id}`,
      accountId,
      mode: "test",
    },
  });
  return id;
}

async function receipt(id: string) {
  return db
    .prepare(
      "SELECT state,attempt_count,available_at,last_error_code,acknowledged_at FROM webhook_inbox WHERE inbox_event_id=?",
    )
    .bind(id)
    .first<Record<string, unknown>>();
}

it("keeps a provider outage from consuming the attempt budget, backs off with a growing wait capped at one hour, and acknowledges the event once Stripe answers", async () => {
  const accountId = "acct_redrive_outage";
  const id = await record(accountId);
  const billing = billingFor(accountId);
  const received = nowMs;
  failure = new StripeBillingError("stripe_unavailable");

  let previousWait = 0;
  for (let tick = 0; tick < 12; tick++) {
    expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 0, failed: 1 });
    const row = await receipt(id);
    expect(row).toEqual({
      state: "pending",
      attempt_count: 0,
      available_at: expect.any(String),
      last_error_code: "STRIPE_UNAVAILABLE",
      acknowledged_at: null,
    });
    const wait = ms(row?.["available_at"]) - nowMs;
    expect(wait).toBeGreaterThanOrEqual(previousWait);
    expect(wait).toBeLessThanOrEqual(60 * MINUTE);
    previousWait = wait;
    nowMs = ms(row?.["available_at"]);
  }
  expect(previousWait).toBeGreaterThan(MINUTE);

  // After a long outage the wait is exactly the one-hour cap, and the event is still claimable.
  nowMs = received + 70 * MINUTE;
  expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 0, failed: 1 });
  expect(ms((await receipt(id))?.["available_at"]) - nowMs).toBe(60 * MINUTE);

  // Stripe answers again: the same event is claimed once more and acknowledged.
  failure = null;
  nowMs = ms((await receipt(id))?.["available_at"]);
  expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 1, failed: 0 });
  expect(await receipt(id)).toMatchObject({ state: "acknowledged", last_error_code: null });
  expect((await receipt(id))?.["acknowledged_at"]).not.toBeNull();
}, 60_000);

it("still parks an event whose failure is not a provider outage after its tenth attempt", async () => {
  const accountId = "acct_redrive_rejected";
  const id = await record(accountId);
  const billing = billingFor(accountId);
  failure = new Error("stripe_rejected");

  for (let attempt = 1; attempt <= 10; attempt++) {
    expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 0, failed: 1 });
    const row = await receipt(id);
    expect(row).toMatchObject({ attempt_count: attempt, last_error_code: "STRIPE_REJECTED" });
    nowMs = ms(row?.["available_at"]);
  }
  expect(await receipt(id)).toMatchObject({
    state: "reconciliation_required",
    attempt_count: 10,
    acknowledged_at: null,
  });
  // Parked: not claimed before its backoff passes, then re-driven with a fresh attempt on the same event.
  const due = ms((await receipt(id))?.["available_at"]);
  expect(due - nowMs).toBeLessThanOrEqual(60 * MINUTE);
  nowMs = due - MINUTE;
  expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 0, failed: 0 });
  nowMs = due;
  expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 0, failed: 1 });
  expect(await receipt(id)).toMatchObject({
    state: "reconciliation_required",
    attempt_count: 11,
    last_error_code: "STRIPE_REJECTED",
  });
  // Once Stripe answers, the parked event is acknowledged and its grant can apply.
  failure = null;
  nowMs = ms((await receipt(id))?.["available_at"]);
  expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 1, failed: 0 });
  expect(await receipt(id)).toMatchObject({ state: "acknowledged", last_error_code: null });
}, 60_000);

it("never claims a Stripe event received more than thirty days ago, so a deterministic failure stops being re-driven", async () => {
  const accountId = "acct_redrive_expired";
  const id = await record(accountId);
  const billing = billingFor(accountId);
  failure = new Error("stripe_rejected");
  // Parked by its tenth failed attempt, then received longer ago than Stripe keeps the event.
  const thirtyOneDays = 31 * 24 * 60 * MINUTE;
  await db
    .prepare(
      "UPDATE webhook_inbox SET state='reconciliation_required',attempt_count=max_attempts,last_error_code='STRIPE_REJECTED',received_at=?2,available_at=?3 WHERE inbox_event_id=?1",
    )
    .bind(id, stored(nowMs - thirtyOneDays), stored(nowMs - MINUTE))
    .run();
  expect(await billing.syncWebhookBatch()).toEqual({ acknowledged: 0, failed: 0 });
  expect(await receipt(id)).toMatchObject({
    state: "reconciliation_required",
    last_error_code: "STRIPE_REJECTED",
  });
  failure = null;
}, 60_000);
