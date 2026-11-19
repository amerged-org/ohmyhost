import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MailInfrastructureRuntime } from "../../src/worker-main.js";
import { createD1InfrastructurePersistence } from "../../../mail-gateway/src/d1-infrastructure-persistence.js";
import { createInfrastructureAlertReceiver } from "../../../mail-gateway/src/infrastructure-alerts.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  claimInfrastructureAlert,
  completeInfrastructureAlert,
  readInfrastructureAlertReceipt,
} from "../../src/catalog/mail/infrastructure.js";
import { SharedCoreRouter } from "../../src/router.js";
import type { D1Database } from "../../src/d1-types.js";
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
it("keeps the durable infrastructure receipt lease, same-identity replay and first accepted-at", async () => {
  const context = { directory: control.core, router: new SharedCoreRouter(control.core) },
    now = new Date().toISOString(),
    input = { eventId: crypto.randomUUID(), requestSha256: "a".repeat(64), now };
  expect(await claimInfrastructureAlert(context, input)).toBe("send");
  // The 30-second lease blocks a concurrent sender and expires exactly after 30 seconds.
  expect(await claimInfrastructureAlert(context, input)).toBe("wait");
  const later = { ...input, now: new Date(Date.parse(now) + 31000).toISOString() };
  expect(await claimInfrastructureAlert(context, later)).toBe("send");
  expect(await claimInfrastructureAlert(context, { ...later, requestSha256: "b".repeat(64) })).toBe(
    "conflict",
  );
  const done = {
    eventId: input.eventId,
    requestSha256: input.requestSha256,
    providerMessageId: "provider_message",
    acceptedAt: later.now,
  };
  expect(await completeInfrastructureAlert(context, done)).toBe(true);
  expect(await claimInfrastructureAlert(context, later)).toBe("accepted");
  expect(
    await completeInfrastructureAlert(context, { ...done, providerMessageId: "different" }),
  ).toBe(false);
  expect(await readInfrastructureAlertReceipt(context, { eventId: input.eventId })).toEqual({
    eventId: input.eventId,
    requestSha256: input.requestSha256,
    firstAttemptAt: now,
    leaseUntil: new Date(Date.parse(later.now) + 30000).toISOString(),
    providerMessageId: done.providerMessageId,
    acceptedAt: done.acceptedAt,
  });
  // An unanswered claim is not sent again once the 23-hour replay window of the same provider identity has passed.
  const expired = { ...input, eventId: crypto.randomUUID() };
  expect(await claimInfrastructureAlert(context, expired)).toBe("send");
  const after23 = { ...expired, now: new Date(Date.parse(now) + 23 * 3600000).toISOString() };
  expect(await claimInfrastructureAlert(context, after23)).toBe("wait");
});
it("surfaces an unknown committed infrastructure claim and retains its lease before any new send permission", async () => {
  let lose = true;
  const db: D1Database = {
      prepare: (sql) => control.core.prepare(sql),
      batch: async (statements) => {
        const rows = await control.core.batch(statements);
        if (lose && rows.some((r) => Number(r.meta?.changes ?? 0) > 0)) {
          lose = false;
          throw new Error("Network connection lost");
        }
        return rows;
      },
    },
    context = { directory: db, router: new SharedCoreRouter(db) },
    input = {
      eventId: crypto.randomUUID(),
      requestSha256: "a".repeat(64),
      now: new Date().toISOString(),
    };
  await expect(claimInfrastructureAlert(context, input)).rejects.toThrow(": store_outcome_unknown");
  expect(await claimInfrastructureAlert(context, input)).toBe("wait");
  lose = true;
  const done = {
    eventId: input.eventId,
    requestSha256: input.requestSha256,
    providerMessageId: "accepted_unknown",
    acceptedAt: input.now,
  };
  await expect(completeInfrastructureAlert(context, done)).rejects.toThrow(
    ": store_outcome_unknown",
  );
  expect(await completeInfrastructureAlert(context, done)).toBe(true);

  expect(
    await readInfrastructureAlertReceipt(context, { eventId: crypto.randomUUID() }),
  ).toBeNull();
});

it("runs the actual infrastructure receiver through typed Core persistence, retaining unknown claim without provider permission", async () => {
  let lose = true,
    calls = 0,
    now = new Date();
  const db: D1Database = {
      prepare: (sql) => control.core.prepare(sql),
      batch: async (statements) => {
        const rows = await control.core.batch(statements);
        if (lose && rows.some((r) => Number(r.meta?.changes ?? 0) > 0)) {
          lose = false;
          throw new Error("Network connection lost");
        }
        return rows;
      },
    },
    target = new MailInfrastructureRuntime({} as never, { CONTROL_CORE: db } as never),
    persistence = await createD1InfrastructurePersistence(target),
    secret = "b".repeat(43),
    event = {
      version: 1,
      event_id: crypto.randomUUID(),
      kind: "regional_ram_warning",
      region_id: "eu-1",
      occurred_at: now.toISOString(),
      regional_ram_utilization_ppm: 750000,
      allocated_nodes: 3,
      max_nodes: 3,
    },
    receiver = createInfrastructureAlertReceiver({
      persistence,
      secret,
      recipient: "operator@example.net",
      apiKey: "re_fixture_platform",
      platform: "development",
      now: () => now,
      fetch: async () => {
        calls++;
        return Response.json({ id: "platform_message" });
      },
    }),
    request = () =>
      new Request("https://infra.test/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": event.event_id,
        },
        body: JSON.stringify(event),
      });
  expect((await receiver.fetch(request())).status).toBe(503);
  expect((await receiver.fetch(request())).status).toBe(503);
  expect(calls).toBe(0);
  now = new Date(now.getTime() + 31000);
  expect((await receiver.fetch(request())).status).toBe(200);
  expect((await receiver.fetch(request())).status).toBe(200);
  expect(calls).toBe(1);
  await expect(createD1InfrastructurePersistence({})).rejects.toThrow(
    "infrastructure_core_binding_required",
  );
  await expect(
    createD1InfrastructurePersistence({
      readReceipt: async () => ({
        eventId: event.event_id,
        requestSha256: "a".repeat(64),
        firstAttemptAt: now.toISOString(),
        leaseUntil: now.toISOString(),
        providerMessageId: null,
        acceptedAt: null,
      }),
      claim: async () => "send",
      complete: async () => true,
    }),
  ).rejects.toThrow("infrastructure_core_response_invalid");
  await expect(
    createD1InfrastructurePersistence({
      readReceipt: async () => ({ ready: true }),
      claim: async () => "send",
      complete: async () => true,
    }),
  ).rejects.toThrow("infrastructure_core_response_invalid");
});
