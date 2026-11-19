import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { newUlid } from "../../src/catalog/common.js";
import { OrganizationCreditError } from "../../src/catalog/billing/errors.js";
import { configureProjectCreditBudget } from "../../src/catalog/billing/public-budget.js";
import {
  readCreditAccount,
  readCreditOrganization,
  readProjectCreditBudgetPublic,
} from "../../src/catalog/billing/public-reads.js";
import { readCreditUsage } from "../../src/catalog/billing/public-usage.js";
import {
  runChargeOrg,
  runGrantCredit,
  runReserve,
  setPaid,
} from "../../src/catalog/credit/index.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { losingWriteResponses, ulidOf, type SeededProject } from "../support/platform-fixtures.js";
import { all, credits, first, newOrganization } from "./support.js";

/**
 * The customer-facing credit reads and the budget command on the real Core: account, pool, usage and budget are
 * asserted from the returned wire shape and the committed rows.
 */

let control: TestControl;
let context: { readonly directory: TestControl["core"]; readonly router: SharedCoreRouter };
beforeAll(async () => {
  control = await createTestControl();
  context = { directory: control.core, router: new SharedCoreRouter(control.core) };
}, 120_000);
afterAll(async () => control.dispose());

const NOW = "2026-10-30T10:00:00.123Z";
const stored = (iso: string) => iso.replace(/Z$/u, "000Z");

describe("the account", () => {
  it("shows the Free allowance of an organization that was never written, without writing", async () => {
    const p = await newOrganization(control);
    expect(
      await readCreditAccount(context, { organizationId: p.organizationId, now: NOW }),
    ).toEqual({
      organization_id: p.organizationId,
      name: "Workspace",
      workos_organization_id: (
        await first<{ workos_organization_id: string }>(
          control.core,
          "SELECT workos_organization_id FROM organizations WHERE organization_id = ?",
          p.organizationId,
        )
      ).workos_organization_id,
      plan: "free",
      plan_source: "free",
      paid_until: null,
      available_micros: String(credits(200)),
      monthly_micros: String(credits(200)),
      one_time_micros: "0",
      reserved_micros: "0",
      next_expiry: "2026-11-01T00:00:00.000Z",
      as_of: NOW,
    });
    expect(
      await control.core
        .prepare("SELECT 1 AS found FROM credit_account WHERE organization_id = ?")
        .bind(p.organizationId)
        .first(),
    ).toBeNull();
    // only an instant with milliseconds in ISO form is a time the caller may name
    await expect(
      readCreditAccount(context, { organizationId: p.organizationId, now: stored(NOW) }),
    ).rejects.toThrow(ZodError);
  });

  it("splits monthly and one-time credit, holds back the open reservation and names the workspace", async () => {
    const p = await newOrganization(control);
    await control.core
      .prepare(
        `INSERT INTO onboarding_requests(request_id, workos_user_id, idempotency_sha256, request_sha256, name, organization_attempted,
           membership_attempted, workos_organization_id, organization_id, completed_at, created_at)
         VALUES (?1, 'user_named', zeroblob(32), zeroblob(32), 'Acme', 1, 1, 'org_named', ?2, ?3, ?3)`,
      )
      .bind(newUlid(), p.organizationId, stored(NOW))
      .run();
    await runGrantCredit(control.core, {
      organizationId: p.organizationId,
      key: `topup:${p.organizationId}`,
      kind: "onetime",
      amountMicros: credits(10),
      now: NOW,
    });
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: `usage:wfp:${p.organizationId}:w`,
      amountMicros: credits(4),
      now: NOW,
    });
    await runReserve(control.core, {
      organizationId: p.organizationId,
      reservationId: ulidOf("account-reservation", 1),
      projectId: p.projectId,
      amountMicros: credits(3),
      now: NOW,
    });
    expect(
      await readCreditAccount(context, { organizationId: p.organizationId, now: NOW }),
    ).toMatchObject({
      name: "Acme",
      plan: "free",
      available_micros: String(credits(200 + 10 - 4 - 3)),
      monthly_micros: String(credits(196)),
      one_time_micros: String(credits(10)),
      reserved_micros: String(credits(3)),
      next_expiry: "2026-11-01T00:00:00.000Z",
    });
  });

  it("reports Paid with its source and end, and Free again once the coverage ended", async () => {
    const p = await newOrganization(control);
    await control.core.batch(
      setPaid(control.core, {
        organizationId: p.organizationId,
        paidUntil: "2026-11-15T00:00:00.000Z",
        source: "stripe",
        now: NOW,
      }).statements,
    );
    expect(
      await readCreditAccount(context, { organizationId: p.organizationId, now: NOW }),
    ).toMatchObject({
      plan: "paid",
      plan_source: "stripe",
      paid_until: "2026-11-15T00:00:00.000Z",
    });
    // the new period of a Paid account is the 1000-credit allowance until the month turns
    expect(
      await readCreditAccount(context, {
        organizationId: p.organizationId,
        now: "2026-11-02T00:00:00.000Z",
      }),
    ).toMatchObject({ plan: "paid", monthly_micros: String(credits(1000)) });
    expect(
      await readCreditAccount(context, {
        organizationId: p.organizationId,
        now: "2026-11-16T00:00:00.000Z",
      }),
    ).toMatchObject({
      plan: "free",
      plan_source: "free",
      paid_until: null,
      monthly_micros: String(credits(200)),
    });
  });

  it("shows no expiry for an empty month and refuses an organization that does not exist", async () => {
    const p = await newOrganization(control);
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: `usage:wfp:${p.organizationId}:drain`,
      amountMicros: credits(200),
      now: NOW,
    });
    expect(
      await readCreditAccount(context, { organizationId: p.organizationId, now: NOW }),
    ).toMatchObject({
      available_micros: "0",
      monthly_micros: "0",
      next_expiry: null,
    });
    await expect(
      readCreditAccount(context, { organizationId: newUlid(), now: NOW }),
    ).rejects.toMatchObject({ code: "organization_credit_scope_missing" });
  });
});

describe("the organization's credit pool", () => {
  it("shows only the balance and the grace from the exhaustion, never what the credit was spent on", async () => {
    const p = await newOrganization(control);
    const funded = await readCreditOrganization(context, {
      organizationId: p.organizationId,
      now: NOW,
    });
    expect(funded).toMatchObject({
      organization_id: p.organizationId,
      unit: "microcredits",
      as_of: NOW,
      available_micros: String(credits(200)),
      reserved_micros: "0",
      grace_started_at: null,
      grace_expires_at: null,
    });
    expect(Object.keys(funded).sort()).toEqual([
      "as_of",
      "available_micros",
      "grace_expires_at",
      "grace_started_at",
      "organization_id",
      "reserved_micros",
      "unit",
    ]);
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: `usage:wfp:${p.organizationId}:exhaust`,
      amountMicros: credits(200),
      now: "2026-10-29T08:00:00.000Z",
    });
    const exhausted = await readCreditOrganization(context, {
      organizationId: p.organizationId,
      now: NOW,
    });
    expect(exhausted).toMatchObject({
      available_micros: "0",
      grace_started_at: "2026-10-29T08:00:00.000Z",
      grace_expires_at: "2026-11-05T08:00:00.000Z",
    });
    // the grace ends with the month it began in: the next month brings the allowance back
    expect(
      await readCreditOrganization(context, {
        organizationId: p.organizationId,
        now: "2026-11-01T00:00:00.000Z",
      }),
    ).toMatchObject({ available_micros: String(credits(200)), grace_started_at: null });
    await expect(
      readCreditOrganization(context, { organizationId: newUlid(), now: NOW }),
    ).rejects.toBeInstanceOf(OrganizationCreditError);
  });
});

describe("the month's use per project", () => {
  it("lists the use of this month per project, leaves out an earlier month and filters one project", async () => {
    const p = await newOrganization(control);
    const second = ulidOf("usage-second-project", 1);
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: `usage:wfp:${p.organizationId}:a`,
      amountMicros: credits(5),
      now: NOW,
      projects: [
        { projectId: p.projectId, amountMicros: credits(2) },
        { projectId: second, amountMicros: credits(3) },
      ],
    });
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: `usage:wfp:${p.organizationId}:b`,
      amountMicros: credits(1),
      now: NOW,
      projects: [{ projectId: p.projectId, amountMicros: credits(1) }],
    });
    const report = await readCreditUsage(context, { organizationId: p.organizationId, now: NOW });
    expect(report).toEqual({
      organization_id: p.organizationId,
      as_of: NOW,
      unit: "microcredits",
      period: "2026-10",
      projects: [
        { project_id: p.projectId, used_micros: String(credits(3)) },
        { project_id: second, used_micros: String(credits(3)) },
      ].sort((a, b) => (a.project_id < b.project_id ? -1 : 1)),
    });
    expect(
      await readCreditUsage(context, {
        organizationId: p.organizationId,
        projectId: second,
        now: NOW,
      }),
    ).toMatchObject({ projects: [{ project_id: second, used_micros: String(credits(3)) }] });
    // the use belongs to October; November has used nothing yet
    expect(
      await readCreditUsage(context, {
        organizationId: p.organizationId,
        now: "2026-11-02T00:00:00.000Z",
      }),
    ).toMatchObject({ period: "2026-11", projects: [] });
  });
});

describe("the project budget", () => {
  let seed = 0;
  const command = (
    p: SeededProject,
    n: number,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    organizationId: p.organizationId,
    projectId: p.projectId,
    now: NOW,
    amountMicros: String(credits(20)),
    mode: "stop",
    principalId: "user:budget",
    requestId: `req-${n}`,
    idempotencyKey: `key-${p.projectId}`,
    canonicalRequestDigest: "ab".repeat(32),
    operationId: ulidOf(`budget-operation-${seed}`, n),
    queuedEventId: ulidOf(`budget-queued-${seed}`, n),
    succeededEventId: ulidOf(`budget-succeeded-${seed}`, n),
    auditEventId: ulidOf(`budget-audit-${seed}`, n),
    ...extra,
  });
  const rows = (sql: string, ...binds: unknown[]) =>
    all<Record<string, unknown>>(control.core, sql, ...binds);

  it("configures, replays, conflicts and refuses with the operation, audit and idempotency rows of one command", async () => {
    seed += 1;
    const p = await newOrganization(control);
    const base = { organizationId: p.organizationId, projectId: p.projectId, now: NOW };
    expect(await readProjectCreditBudgetPublic(context, base)).toEqual({
      project_id: p.projectId,
      amount_micros: null,
      mode: "continue",
      used_micros: "0",
      reserved_micros: "0",
      period_start: "2026-10-01T00:00:00.000Z",
      period_end: "2026-11-01T00:00:00.000Z",
      as_of: NOW,
    });

    const created = await configureProjectCreditBudget(context, command(p, 1));
    expect(created).toMatchObject({
      project_id: p.projectId,
      amount_micros: String(credits(20)),
      mode: "stop",
      used_micros: "0",
      reserved_micros: "0",
    });
    expect(await readProjectCreditBudgetPublic(context, base)).toEqual(created);
    expect(
      await rows(
        "SELECT budget_micros, budget_mode, period FROM project_credit WHERE project_id = ?",
        p.projectId,
      ),
    ).toEqual([{ budget_micros: credits(20), budget_mode: "stop", period: "2026-10" }]);
    expect(
      await rows(
        "SELECT state, billing_epoch_id FROM operations WHERE operation_id = ?",
        command(p, 1)["operationId"],
      ),
    ).toEqual([{ state: "succeeded", billing_epoch_id: p.billingEpochId }]);
    expect(
      await rows(
        "SELECT revision, event_type FROM operation_events WHERE operation_id = ? ORDER BY revision",
        command(p, 1)["operationId"],
      ),
    ).toEqual([
      { revision: 0, event_type: "OperationQueued" },
      { revision: 1, event_type: "OperationSucceeded" },
    ]);
    const audit = await rows(
      "SELECT event_type, actor_id, payload FROM audit_events WHERE operation_id = ?",
      command(p, 1)["operationId"],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event_type: "ProjectCreditBudgetConfiguredV1",
      actor_id: "user:budget",
    });
    expect(String(audit[0]?.["payload"])).toContain("sha256:");
    expect(String(audit[0]?.["payload"])).not.toContain(`key-${p.projectId}`);

    // The same key and digest answers the stored response without another write.
    expect(await configureProjectCreditBudget(context, command(p, 2))).toEqual(created);
    expect(
      await rows(
        "SELECT count(*) AS n FROM operations WHERE project_id = ? AND organization_id = ?",
        p.projectId,
        p.organizationId,
      ),
    ).toEqual([{ n: 1 }]);
    // The same key with another request digest is a conflict that writes nothing.
    await expect(
      configureProjectCreditBudget(
        context,
        command(p, 3, { canonicalRequestDigest: "cd".repeat(32) }),
      ),
    ).rejects.toMatchObject({ code: "credit_request_conflict" });

    // A new key changes the budget; removing it restores continue.
    expect(
      await configureProjectCreditBudget(
        context,
        command(p, 4, {
          idempotencyKey: `other-${p.projectId}`,
          amountMicros: String(credits(5)),
          mode: "continue",
        }),
      ),
    ).toMatchObject({ amount_micros: String(credits(5)), mode: "continue" });
    expect(
      await configureProjectCreditBudget(
        context,
        command(p, 5, {
          idempotencyKey: `third-${p.projectId}`,
          amountMicros: null,
          mode: "continue",
        }),
      ),
    ).toMatchObject({ amount_micros: null, mode: "continue" });
    expect(
      await rows(
        "SELECT budget_micros, budget_mode FROM project_credit WHERE project_id = ?",
        p.projectId,
      ),
    ).toEqual([{ budget_micros: null, budget_mode: "continue" }]);
  });

  it("refuses a stop budget without an amount, an amount beyond exact money, an unknown project and a frozen one", async () => {
    seed += 1;
    const p = await newOrganization(control);
    await expect(
      configureProjectCreditBudget(
        context,
        command(p, 6, { idempotencyKey: `bad-${p.projectId}`, amountMicros: null, mode: "stop" }),
      ),
    ).rejects.toThrow(ZodError);
    await expect(
      configureProjectCreditBudget(
        context,
        command(p, 7, { idempotencyKey: `big-${p.projectId}`, amountMicros: "9007199254740992" }),
      ),
    ).rejects.toThrow(ZodError);
    await expect(
      configureProjectCreditBudget(
        context,
        command(p, 8, {
          idempotencyKey: `ghost-${p.projectId}`,
          projectId: ulidOf("ghost-project", 1),
        }),
      ),
    ).rejects.toBeInstanceOf(OrganizationCreditError);
    await expect(
      readProjectCreditBudgetPublic(context, {
        organizationId: p.organizationId,
        projectId: ulidOf("ghost-project", 1),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "organization_credit_scope_missing" });
    await control.core
      .prepare("UPDATE projects SET owner_state = 'security_frozen' WHERE project_id = ?")
      .bind(p.projectId)
      .run();
    await expect(
      configureProjectCreditBudget(
        context,
        command(p, 9, { idempotencyKey: `frozen-${p.projectId}` }),
      ),
    ).rejects.toMatchObject({ code: "organization_credit_scope_missing" });
    expect(await rows("SELECT 1 FROM project_credit WHERE project_id = ?", p.projectId)).toEqual(
      [],
    );
  });

  it("reports this month's use and the open reservations of the project, and the use of an earlier month as zero", async () => {
    seed += 1;
    const p = await newOrganization(control);
    await configureProjectCreditBudget(context, command(p, 10));
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: `usage:wfp:${p.organizationId}:budget`,
      amountMicros: credits(6),
      now: NOW,
      projects: [{ projectId: p.projectId, amountMicros: credits(6) }],
    });
    await runReserve(control.core, {
      organizationId: p.organizationId,
      reservationId: ulidOf("budget-reservation", seed),
      projectId: p.projectId,
      amountMicros: credits(2),
      now: NOW,
    });
    const base = { organizationId: p.organizationId, projectId: p.projectId };
    expect(await readProjectCreditBudgetPublic(context, { ...base, now: NOW })).toMatchObject({
      amount_micros: String(credits(20)),
      used_micros: String(credits(6)),
      reserved_micros: String(credits(2)),
    });
    expect(
      await readProjectCreditBudgetPublic(context, { ...base, now: "2026-11-03T00:00:00.000Z" }),
    ).toMatchObject({
      used_micros: "0",
      reserved_micros: String(credits(2)),
      period_start: "2026-11-01T00:00:00.000Z",
      period_end: "2026-12-01T00:00:00.000Z",
    });
  });

  it("answers a lost response from the committed rows without a second write", async () => {
    seed += 1;
    const p = await newOrganization(control);
    const lossy = {
      directory: control.core,
      router: new SharedCoreRouter(losingWriteResponses(control.core, 1)),
    };
    expect(
      await configureProjectCreditBudget(
        lossy,
        command(p, 11, { amountMicros: String(credits(7)) }),
      ),
    ).toMatchObject({ amount_micros: String(credits(7)), mode: "stop" });
    expect(
      await rows(
        "SELECT count(*) AS n FROM api_idempotency_records WHERE organization_id = ?",
        p.organizationId,
      ),
    ).toEqual([{ n: 1 }]);
  });
});
