import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { claimMailSend } from "../../src/catalog/mail/send-claim.js";
import {
  authorizeMailSend,
  completeMailSend,
  rejectMailSend,
  settleMailSendAttempt,
} from "../../src/catalog/mail/send-transitions.js";
import { newUlid } from "../../src/catalog/common.js";
import { accountOf, creditLog, hash, mailFixture, fundMailFixture } from "./mail-fixture.js";
import { SharedCoreRouter } from "../../src/router.js";
import type { D1Database } from "../../src/d1-types.js";
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
async function fixture(key: string) {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const input = {
    ...f.scope,
    provider: "resend" as const,
    requestId: parseUlid(newUlid()),
    idempotencyKey: key,
    requestSha256: hash(key),
    recipientSha256: hash("recipient"),
    contentSha256: hash("content"),
    sender: {},
    requestedAt: f.now,
    paidAt: f.now,
  };
  await claimMailSend(f.context, input);
  const scope = {
    organizationId: f.scope.organizationId,
    projectId: f.scope.projectId,
    requestId: input.requestId,
  };
  return {
    ...f,
    input,
    scope,
    authorize: {
      ...scope,
      environmentId: parseUlid(f.fixture.scope.environmentId),
      idempotencyKey: key,
      now: f.now,
    },
  };
}
const state = (requestId: string) =>
  control.core
    .prepare("SELECT state,provider_message_id FROM mail_send_requests WHERE request_id=?")
    .bind(requestId)
    .first();
it("authorizes the provider start once and completes an accepted send without touching the credit charged at the claim", async () => {
  const f = await fixture("ordinary-complete");
  expect(await authorizeMailSend(f.context, f.authorize)).toBe(true);
  expect(await authorizeMailSend(f.context, f.authorize)).toBe(false);
  const done = { ...f.scope, providerMessageId: "message_complete", completedAt: f.now };
  expect(await completeMailSend(f.context, done)).toBe("completed");
  expect(await completeMailSend(f.context, done)).toBe("existing");
  expect(await state(f.input.requestId)).toEqual({
    state: "accepted",
    provider_message_id: "message_complete",
  });
  expect(await creditLog(control, f.scope.organizationId, "mail")).toMatchObject([
    { key: `mail:${f.input.requestId}`, kind: "usage", delta_micros: -180000 },
  ]);
  expect(await accountOf(control, f.scope.organizationId)).toMatchObject({
    monthly_micros: 999_820_000,
    onetime_micros: 1_000_000_000,
  });
  await expect(
    completeMailSend(f.context, { ...done, providerMessageId: "different" }),
  ).rejects.toMatchObject({ code: "mail_send_conflict" });
  expect(
    await settleMailSendAttempt(f.context, { ...f.scope, observedAt: f.now, refused: true }),
  ).toEqual({ state: "accepted", providerMessageId: "message_complete" });
});
it("keeps the charge of an uncertain send, refunds a refused or rejected one once and rolls the refund back with the state", async () => {
  const uncertain = await fixture("attempt-uncertain");
  await authorizeMailSend(uncertain.context, uncertain.authorize);
  const attempt = { ...uncertain.scope, observedAt: uncertain.now, refused: false };
  expect(await settleMailSendAttempt(uncertain.context, attempt)).toEqual({ state: "uncertain" });
  expect(await settleMailSendAttempt(uncertain.context, { ...attempt, refused: true })).toEqual({
    state: "uncertain",
  });
  expect(await creditLog(control, uncertain.scope.organizationId, "mail")).toHaveLength(1);

  const refused = await fixture("attempt-refused");
  await authorizeMailSend(refused.context, refused.authorize);
  const refusal = { ...refused.scope, observedAt: refused.now, refused: true };
  expect(await settleMailSendAttempt(refused.context, refusal)).toEqual({ state: "rejected" });
  expect(await settleMailSendAttempt(refused.context, refusal)).toEqual({ state: "rejected" });
  expect(await creditLog(control, refused.scope.organizationId, "mail")).toMatchObject([
    { key: `mail:${refused.input.requestId}`, delta_micros: -180000 },
    {
      key: `mailrefund:${refused.input.requestId}`,
      kind: "refund",
      delta_micros: 180000,
      balance_micros: 2_000_000_000,
      detail: { source: "mail", reason: "refused", chargeMicros: 180000 },
    },
  ]);
  // the refund returns the monthly part to the monthly allowance, not to one-time credit that never expires
  expect(await accountOf(control, refused.scope.organizationId)).toMatchObject({
    monthly_micros: 1_000_000_000,
    onetime_micros: 1_000_000_000,
  });
  expect(
    await control.core
      .prepare("SELECT used_micros FROM project_credit WHERE project_id=?")
      .bind(refused.scope.projectId)
      .first(),
  ).toEqual({ used_micros: 0 });

  const f = await fixture("reject-not-started"),
    reject = { ...f.scope, rejectedAt: f.now };
  expect(await rejectMailSend(f.context, reject)).toBe("released");
  expect(await rejectMailSend(f.context, reject)).toBe("existing");
  expect(await creditLog(control, f.scope.organizationId, "mailrefund")).toHaveLength(1);
  await expect(
    rejectMailSend(f.context, { ...reject, organizationId: newUlid() }),
  ).rejects.toThrow();

  const late = await fixture("late-refund-rollback");
  await control.core
    .prepare(
      "CREATE TRIGGER test_mail_refund_final BEFORE INSERT ON credit_log WHEN NEW.key LIKE 'mailrefund:%' BEGIN SELECT RAISE(ABORT,'test_mail_refund_final');END",
    )
    .run();
  await expect(
    rejectMailSend(late.context, { ...late.scope, rejectedAt: late.now }),
  ).rejects.toThrow("test_mail_refund_final");
  expect(await state(late.input.requestId)).toEqual({
    state: "reserved",
    provider_message_id: null,
  });
  expect(await accountOf(control, late.scope.organizationId)).toMatchObject({
    monthly_micros: 999_820_000,
    onetime_micros: 1_000_000_000,
  });
  await control.core.prepare("DROP TRIGGER test_mail_refund_final").run();
});
it("surfaces committed authorization loss without reconstructing permission and observes the retained next action", async () => {
  const f = await fixture("authorize-unknown");
  let lose = true;
  const db: D1Database = {
    prepare: (sql) => control.core.prepare(sql),
    batch: async (statements) => {
      const result = await control.core.batch(statements);
      if (lose && result.some((item) => Number(item.meta?.changes ?? 0) > 0)) {
        lose = false;
        throw new Error("Network connection lost");
      }
      return result;
    },
  };
  await expect(
    authorizeMailSend({ directory: db, router: new SharedCoreRouter(db) }, f.authorize),
  ).rejects.toThrow(": store_outcome_unknown");
  expect(await authorizeMailSend(f.context, f.authorize)).toBe(false);
  expect(
    await claimMailSend(f.context, { ...f.input, requestId: parseUlid(newUlid()) }),
  ).toMatchObject({ outcome: "uncertain", providerStarted: true, requestId: f.input.requestId });
  lose = true;
  const done = { ...f.scope, providerMessageId: "accepted_after_unknown", completedAt: f.now };
  await expect(
    completeMailSend({ directory: db, router: new SharedCoreRouter(db) }, done),
  ).rejects.toThrow(": store_outcome_unknown");
  expect(await completeMailSend(f.context, done)).toBe("existing");
  expect(await creditLog(control, f.scope.organizationId, "mail")).toHaveLength(1);
});
