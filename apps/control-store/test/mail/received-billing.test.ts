import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { billReceivedMail } from "../../src/catalog/mail/received-billing.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { accountOf, creditLog, mailFixture, fundMailFixture } from "./mail-fixture.js";
import { SharedCoreRouter } from "../../src/router.js";
import type { D1Database } from "../../src/d1-types.js";
import { MailDeliveryRuntime } from "../../src/worker-main.js";
import { createD1ReceivedBillingPersistence } from "../../../mail-gateway/src/d1-received-billing-persistence.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
type Fixture = Awaited<ReturnType<typeof mailFixture>>;
/** A received message of the fixture's receiving domain; `receivedAt` is the instant the provider delivered it. */
async function receive(f: Fixture, receivedAt = f.now) {
  const messageId = parseUlid(newUlid()),
    received = storedTimestamp(receivedAt),
    expires = storedTimestamp(new Date(Date.parse(receivedAt) + 72 * 3600_000).toISOString());
  await control.core
    .prepare(
      "INSERT INTO mail_received_messages(message_id,provider_message_id,domain_id,organization_id,project_id,environment_id,received_at,expires_at,next_attempt_at,state)VALUES(?,?,?,?,?,?,?,?,?,'pending')",
    )
    .bind(
      messageId,
      `received_${newUlid()}`,
      f.domainId,
      f.scope.organizationId,
      f.scope.projectId,
      f.scope.environmentId,
      received,
      expires,
      received,
    )
    .run();
  return { messageId, input: { messageId, now: f.now } };
}
const billedAt = (messageId: string) =>
  control.core
    .prepare("SELECT billed_at FROM mail_received_messages WHERE message_id=?")
    .bind(messageId)
    .first();
it("charges a received message once with its billed mark in the same batch and replays without a second charge", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const message = await receive(f),
    persistence = await createD1ReceivedBillingPersistence(
      new MailDeliveryRuntime({} as never, control.bindings as never),
    );
  expect(await persistence.unbilled()).toContain(message.messageId);
  await persistence.bill(() => ({ ...message.input, valuationId: parseUlid(newUlid()) }));
  expect(await persistence.unbilled()).not.toContain(message.messageId);
  expect(await creditLog(control, f.scope.organizationId, "mailrecv:")).toEqual([
    {
      key: `mailrecv:${message.messageId}`,
      kind: "usage",
      delta_micros: -180000,
      balance_micros: 1_999_820_000,
      detail: {
        source: "mail",
        messageId: message.messageId,
        projectId: f.scope.projectId,
        environmentId: f.scope.environmentId,
        meter: "mail.received",
        quantity: "1",
        unit: "message",
        receivedAt: f.now,
        rateCardId: "resend-2026-09-22-v1",
        chargeMicros: 180000,
        lines: [
          {
            projectId: f.scope.projectId,
            environmentId: f.scope.environmentId,
            meter: "mail.received",
            unit: "message",
            rateCardId: "resend-2026-09-22-v1",
            quantity: "1",
            chargeMicros: 180000,
          },
        ],
        spent: { monthly: 180000, onetime: 0, overrun: 0 },
      },
    },
  ]);
  expect(await accountOf(control, f.scope.organizationId)).toMatchObject({
    monthly_micros: 999_820_000,
    onetime_micros: 1_000_000_000,
  });
  expect(
    await control.core
      .prepare("SELECT used_micros FROM project_credit WHERE project_id=?")
      .bind(f.scope.projectId)
      .first(),
  ).toEqual({ used_micros: 180000 });
  expect(await billedAt(message.messageId)).toEqual({ billed_at: storedTimestamp(f.now) });
  await billReceivedMail(f.context, message.input);
  await billReceivedMail(f.context, { messageId: parseUlid(newUlid()), now: f.now });
  expect(await creditLog(control, f.scope.organizationId, "mailrecv:")).toHaveLength(1);
}, 120000);
it("bills a message that arrived before the meter was active without a charge, so it cannot block the queue", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const early = await receive(f, "2026-09-01T00:00:00.000Z");
  await billReceivedMail(f.context, early.input);
  expect(await billedAt(early.messageId)).toEqual({ billed_at: storedTimestamp(f.now) });
  expect(await creditLog(control, f.scope.organizationId, "mailrecv:")).toEqual([]);
  expect(await accountOf(control, f.scope.organizationId)).toMatchObject({
    monthly_micros: 1_000_000_000,
  });
}, 120000);
it("reads at most twenty unbilled messages, oldest first", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const ids: string[] = [];
  for (let n = 0; n < 21; n++)
    ids.push(
      (await receive(f, new Date(Date.parse("2026-10-02T00:00:00.000Z") + n * 1000).toISOString()))
        .messageId,
    );
  const persistence = await createD1ReceivedBillingPersistence(
    new MailDeliveryRuntime({} as never, control.bindings as never),
  );
  const listed = await persistence.unbilled();
  expect(listed).toHaveLength(20);
  expect(listed).not.toContain(ids[20]);
}, 120000);
it("rolls the charge back if the billed mark fails and never changes the delivered-attempt facts", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const message = await receive(f),
    snapshot = async () =>
      JSON.stringify({
        account: await accountOf(control, f.scope.organizationId),
        message: await control.core
          .prepare("SELECT * FROM mail_received_messages WHERE message_id=?")
          .bind(message.messageId)
          .first(),
        log: await creditLog(control, f.scope.organizationId, "mailrecv:"),
      }),
    before = await snapshot();
  await control.core
    .prepare(
      "CREATE TRIGGER test_received_billed_final BEFORE UPDATE OF billed_at ON mail_received_messages BEGIN SELECT RAISE(ABORT,'test_received_billed_final');END",
    )
    .run();
  await expect(billReceivedMail(f.context, message.input)).rejects.toThrow(
    "test_received_billed_final",
  );
  expect(await snapshot()).toBe(before);
  await control.core.prepare("DROP TRIGGER test_received_billed_final").run();
  await billReceivedMail(f.context, message.input);
  expect(await creditLog(control, f.scope.organizationId, "mailrecv:")).toHaveLength(1);
}, 120000);
it("surfaces committed reply loss and observes the billed mark on replay without a second charge", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const message = await receive(f);
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
  };
  await expect(
    billReceivedMail({ directory: db, router: new SharedCoreRouter(db) }, message.input),
  ).rejects.toThrow(": store_outcome_unknown");
  await billReceivedMail(f.context, message.input);
  expect(await creditLog(control, f.scope.organizationId, "mailrecv:")).toHaveLength(1);
}, 120000);
