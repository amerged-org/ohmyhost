import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { claimMailSend } from "../../src/catalog/mail/send-claim.js";
import { newUlid } from "../../src/catalog/common.js";
import { OVERRUN_CEILING_MICROS, setProjectBudget } from "../../src/catalog/credit/index.js";
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
type Fixture = Awaited<ReturnType<typeof mailFixture>>;
function input(f: Fixture, key: string) {
  return {
    ...f.scope,
    provider: "resend" as const,
    requestId: parseUlid(newUlid()),
    idempotencyKey: key,
    requestSha256: hash("effective-request"),
    requestInputSha256: hash("explicit-request"),
    recipientSha256: hash("recipient"),
    contentSha256: hash("content"),
    sender: {} as { from?: string; replyTo?: string } | undefined,
    paidAt: f.now,
    requestedAt: f.now,
  };
}
const requestRows = (organizationId: string) =>
  control.core
    .prepare("SELECT COUNT(*) n FROM mail_send_requests WHERE organization_id=?")
    .bind(organizationId)
    .first<{ n: number }>();
it("claims a send, charges its recipient in the same batch and answers an unresolved replay without a second charge", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const value = input(f, "claim-normal");
  expect(await claimMailSend(f.context, value)).toEqual({
    outcome: "claimed",
    requestId: value.requestId,
    remainingCreditMicros: "1999820000",
    sender: {
      domainId: f.domainId,
      bindingRevision: "1",
      from: `no-reply@${f.domain}`,
      replyTo: null,
    },
  });
  expect(
    await control.core
      .prepare(
        "SELECT state,provider_message_id,effective_from,request_sha256=unhex(?) exact FROM mail_send_requests WHERE request_id=?",
      )
      .bind(value.requestInputSha256, value.requestId)
      .first(),
  ).toEqual({
    state: "reserved",
    provider_message_id: null,
    effective_from: `no-reply@${f.domain}`,
    exact: 1,
  });
  expect(await accountOf(control, f.scope.organizationId)).toMatchObject({
    monthly_micros: 999_820_000,
    onetime_micros: 1_000_000_000,
    overrun_micros: 0,
  });
  expect(await creditLog(control, f.scope.organizationId, "mail:")).toEqual([
    {
      key: `mail:${value.requestId}`,
      kind: "usage",
      delta_micros: -180000,
      balance_micros: 1_999_820_000,
      detail: {
        source: "mail",
        requestId: value.requestId,
        projectId: f.scope.projectId,
        meter: "mail.sent",
        quantity: "1",
        unit: "recipient",
        rateCardId: "resend-2026-09-22-v1",
        chargeMicros: 180000,
        // The usage report reads the charge from its lines, as it reads an AI or browser charge.
        lines: [
          {
            projectId: f.scope.projectId,
            environmentId: f.scope.environmentId,
            meter: "mail.sent",
            unit: "recipient",
            rateCardId: "resend-2026-09-22-v1",
            quantity: "1",
            chargeMicros: 180000,
          },
        ],
        spent: { monthly: 180000, onetime: 0, overrun: 0 },
      },
    },
  ]);
  expect(
    await control.core
      .prepare("SELECT used_micros FROM project_credit WHERE project_id=?")
      .bind(f.scope.projectId)
      .first(),
  ).toEqual({ used_micros: 180000 });
  const again = { ...value, requestId: parseUlid(newUlid()) };
  expect(await claimMailSend(f.context, again)).toEqual({
    outcome: "uncertain",
    requestId: value.requestId,
    requestedAt: f.now,
    providerStarted: false,
    sender: {
      domainId: f.domainId,
      bindingRevision: "1",
      from: `no-reply@${f.domain}`,
      replyTo: null,
    },
  });
  expect(await creditLog(control, f.scope.organizationId, "mail:")).toHaveLength(1);
  await expect(
    claimMailSend(f.context, { ...again, contentSha256: hash("different") }),
  ).rejects.toMatchObject({ code: "mail_send_conflict" });
  await f.update(
    "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  await expect(
    claimMailSend(f.context, { ...input(f, "revoked-legacy-scope"), sender: undefined }),
  ).rejects.toMatchObject({ code: "mail_send_scope_unavailable" });
});
it("sends only while Paid, through the grace of an exhausted credit and inside a Stop budget", async () => {
  const unpaid = await mailFixture(control);
  await expect(claimMailSend(unpaid.context, input(unpaid, "unpaid"))).rejects.toMatchObject({
    code: "paid_plan_required",
  });
  expect(await requestRows(unpaid.scope.organizationId)).toEqual({ n: 0 });

  const lapsed = await mailFixture(control);
  await fundMailFixture(control, lapsed);
  await control.core
    .prepare(
      "UPDATE credit_account SET paid_until='2026-01-01T00:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(lapsed.scope.organizationId)
    .run();
  await expect(claimMailSend(lapsed.context, input(lapsed, "lapsed"))).rejects.toMatchObject({
    code: "paid_plan_required",
  });

  // Exhausted: mail continues through the 7-day grace on overrun the platform absorbs, then it stops.
  const grace = await mailFixture(control);
  await fundMailFixture(control, grace);
  const exhaust = (organizationId: string, at: string) =>
    control.core
      .prepare(
        "UPDATE credit_account SET monthly_micros=0,onetime_micros=0,exhausted_at=? WHERE organization_id=?",
      )
      .bind(at, organizationId)
      .run();
  await exhaust(
    grace.scope.organizationId,
    new Date(Date.now() - 6 * 86400000).toISOString().replace("Z", "000Z"),
  );
  const inside = input(grace, "inside-grace");
  expect(await claimMailSend(grace.context, inside)).toMatchObject({
    outcome: "claimed",
    remainingCreditMicros: "0",
  });
  expect(await accountOf(control, grace.scope.organizationId)).toMatchObject({
    monthly_micros: 0,
    onetime_micros: 0,
    overrun_micros: 180000,
  });
  await exhaust(
    grace.scope.organizationId,
    new Date(Date.now() - 8 * 86400000).toISOString().replace("Z", "000Z"),
  );
  await expect(claimMailSend(grace.context, input(grace, "after-grace"))).rejects.toMatchObject({
    code: "insufficient_organization_credits",
  });
  expect(await requestRows(grace.scope.organizationId)).toEqual({ n: 1 });
  expect(await creditLog(control, grace.scope.organizationId, "mail:")).toHaveLength(1);

  // A Stop budget refuses once the month's use reached it; a Continue budget never does.
  const budget = await mailFixture(control);
  await fundMailFixture(control, budget);
  const set = (mode: "stop" | "continue") =>
    control.core.batch(
      setProjectBudget(control.core, {
        organizationId: budget.scope.organizationId,
        projectId: budget.scope.projectId,
        budgetMicros: 180000,
        mode,
        now: budget.now,
      }).statements,
    );
  await set("stop");
  expect(await claimMailSend(budget.context, input(budget, "budget-1"))).toMatchObject({
    outcome: "claimed",
  });
  await expect(claimMailSend(budget.context, input(budget, "budget-2"))).rejects.toMatchObject({
    code: "project_budget_exceeded",
  });
  await set("continue");
  expect(await claimMailSend(budget.context, input(budget, "budget-3"))).toMatchObject({
    outcome: "claimed",
  });
});
it("refuses a send once the month's platform overrun reached its ceiling, even inside the grace", async () => {
  const capped = await mailFixture(control);
  await fundMailFixture(control, capped);
  await control.core
    .prepare(
      "UPDATE credit_account SET monthly_micros=0,onetime_micros=0,exhausted_at=?,overrun_micros=?,overrun_base_micros=0 WHERE organization_id=?",
    )
    .bind(
      new Date(Date.now() - 86400000).toISOString().replace("Z", "000Z"),
      OVERRUN_CEILING_MICROS,
      capped.scope.organizationId,
    )
    .run();
  await expect(claimMailSend(capped.context, input(capped, "ceiling"))).rejects.toMatchObject({
    code: "insufficient_organization_credits",
  });
  expect(await requestRows(capped.scope.organizationId)).toEqual({ n: 0 });
  expect(await creditLog(control, capped.scope.organizationId, "mail:")).toHaveLength(0);
});
it("refuses a send that no published price covers", async () => {
  const bare = await createTestControl();
  try {
    const f = await mailFixture(bare);
    await bare.core.batch(
      (await import("../../src/catalog/credit/index.js")).setPaid(bare.core, {
        organizationId: f.scope.organizationId,
        paidUntil: "2099-01-01T00:00:00.000Z",
        source: "manual",
        now: f.now,
      }).statements,
    );
    await expect(claimMailSend(f.context, input(f, "no-price"))).rejects.toMatchObject({
      code: "mail_send_scope_unavailable",
    });
  } finally {
    await bare.dispose();
  }
}, 120000);
it("rolls the request and the charge back together", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const value = input(f, "claim-rollback"),
    before = await accountOf(control, f.scope.organizationId);
  await control.core
    .prepare(
      "CREATE TRIGGER test_mail_claim_final BEFORE INSERT ON mail_send_requests BEGIN SELECT RAISE(ABORT,'test_mail_claim_final');END",
    )
    .run();
  await expect(claimMailSend(f.context, value)).rejects.toThrow("test_mail_claim_final");
  expect(await accountOf(control, f.scope.organizationId)).toEqual(before);
  expect(await creditLog(control, f.scope.organizationId, "mail:")).toEqual([]);
  await control.core.prepare("DROP TRIGGER test_mail_claim_final").run();
  await control.core
    .prepare(
      "CREATE TRIGGER test_mail_charge_final BEFORE INSERT ON credit_log WHEN NEW.key LIKE 'mail:%' BEGIN SELECT RAISE(ABORT,'test_mail_charge_final');END",
    )
    .run();
  await expect(claimMailSend(f.context, value)).rejects.toThrow("test_mail_charge_final");
  expect(
    await control.core
      .prepare("SELECT request_id FROM mail_send_requests WHERE request_id=?")
      .bind(value.requestId)
      .first(),
  ).toBeNull();
  await control.core.prepare("DROP TRIGGER test_mail_charge_final").run();
  expect(await claimMailSend(f.context, value)).toMatchObject({ outcome: "claimed" });
});
it("surfaces committed unknown claim delivery and keeps the original next action and the project-wide daily cap", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const value = input(f, "claim-unknown");
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
    claimMailSend({ directory: db, router: new SharedCoreRouter(db) }, value),
  ).rejects.toThrow("store_outcome_unknown");
  const again = { ...value, requestId: parseUlid(newUlid()) };
  expect(await claimMailSend(f.context, again)).toMatchObject({
    outcome: "uncertain",
    requestId: value.requestId,
    providerStarted: false,
  });
  expect(await creditLog(control, f.scope.organizationId, "mail:")).toHaveLength(1);
  for (let n = 1; n < 10; n++)
    expect(await claimMailSend(f.context, input(f, `cap-${n}`))).toMatchObject({
      outcome: "claimed",
    });
  await expect(claimMailSend(f.context, input(f, "over-cap"))).rejects.toMatchObject({
    code: "mail_send_daily_limit",
  });
  expect(await creditLog(control, f.scope.organizationId, "mail:")).toHaveLength(10);
});
