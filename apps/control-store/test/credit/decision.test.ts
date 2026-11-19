import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DECISION_TTL_MS,
  OVERRUN_CEILING_MICROS,
  accountView,
  readRuntimeDecision,
  runChargeOrg,
  runReserve,
  runtimeDecision,
  setProjectBudget,
  type AccountRow,
  type ProjectBudget,
  type RuntimeFacts,
} from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { freezeOwnership, ulidOf } from "../support/platform-fixtures.js";
import { OCT, credits, newOrganization } from "./support.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

const NOW = "2026-11-10T12:00:00.000Z";
const FUNDED: AccountRow = {
  monthly_micros: credits(50),
  monthly_ends_at: "2026-12-01T00:00:00.000000Z",
  onetime_micros: 0,
  reserved_micros: 0,
  overrun_micros: 0,
  exhausted_at: null,
  paid_until: null,
  paid_source: null,
};
/** No balance at all, and no grace yet: what a ceiling denial needs. */
const EMPTY: AccountRow = { ...FUNDED, monthly_micros: 0, exhausted_at: null };
/** Exhausted `days` days before NOW: nothing left, and the 7-day grace runs from that instant. */
const exhaustedFor = (days: number): AccountRow => ({
  ...FUNDED,
  monthly_micros: 0,
  exhausted_at: new Date(Date.parse(NOW) - days * 86_400_000).toISOString().replace("Z", "000Z"),
});
const PAID = { paid_until: "2026-12-01T00:00:00.000000Z", paid_source: "stripe" } as const;
const budget = (overrides: Partial<ProjectBudget> = {}): ProjectBudget => ({
  budgetMicros: credits(100),
  budgetMode: "stop",
  period: "2026-11",
  usedMicros: 0,
  reservedMicros: 0,
  ...overrides,
});
const decide = (
  stored: AccountRow,
  extra: { active?: boolean; project?: ProjectBudget | null; poweredBy?: boolean } = {},
) => {
  const facts: RuntimeFacts = {
    now: NOW,
    active: extra.active ?? true,
    account: accountView("o", stored, NOW),
    project: extra.project ?? null,
    poweredBy: extra.poweredBy ?? false,
  };
  return runtimeDecision(facts);
};

describe("the runtime decision", () => {
  const cases: [string, ReturnType<typeof decide>, object][] = [
    [
      "serves an organization with credit",
      decide(FUNDED),
      { allowed: true, reason: null, paidAllowed: false, customDomainAllowed: false },
    ],
    [
      "denies what is not active, whatever the credit and the plan",
      decide({ ...FUNDED, ...PAID }, { active: false, poweredBy: true }),
      {
        allowed: false,
        reason: "project_unavailable",
        paidAllowed: false,
        customDomainAllowed: false,
      },
    ],
    [
      "keeps serving inside the 7-day grace after the credit ran out",
      decide(exhaustedFor(6.9)),
      { allowed: true, reason: null },
    ],
    [
      "denies when no credit is left and the grace lapsed",
      decide(exhaustedFor(7)),
      { allowed: false, reason: "insufficient_organization_credits", paidAllowed: false },
    ],
    [
      "takes the Paid features and custom domains along with exhausted credit",
      decide({ ...exhaustedFor(8), ...PAID }, { poweredBy: true }),
      {
        allowed: false,
        reason: "insufficient_organization_credits",
        paidAllowed: false,
        customDomainAllowed: false,
      },
    ],
    [
      "does not count credit that is merely reserved as exhausted",
      decide({ ...FUNDED, monthly_micros: credits(10), reserved_micros: credits(10) }),
      { allowed: true, reason: null },
    ],
    [
      "renews a month that ended instead of denying for the old exhaustion",
      decide({ ...exhaustedFor(30), monthly_ends_at: "2026-11-01T00:00:00.000000Z" }),
      { allowed: true, reason: null },
    ],
    [
      "grants Paid features to a Paid organization",
      decide({ ...FUNDED, ...PAID }),
      { allowed: true, paidAllowed: true, customDomainAllowed: true },
    ],
    [
      "opens custom domains with the powered-by flag, without Paid",
      decide(FUNDED, { poweredBy: true }),
      { allowed: true, paidAllowed: false, customDomainAllowed: true },
    ],
    [
      "stops a project whose budget is used up",
      decide(FUNDED, { project: budget({ usedMicros: credits(100) }) }),
      { allowed: false, reason: "project_budget_exceeded" },
    ],
    [
      "counts the open reservations of the project into the budget",
      decide(FUNDED, { project: budget({ usedMicros: credits(60), reservedMicros: credits(40) }) }),
      { allowed: false, reason: "project_budget_exceeded" },
    ],
    [
      "serves a project one micro-credit under its budget",
      decide(FUNDED, {
        project: budget({ usedMicros: credits(60), reservedMicros: credits(40) - 1 }),
      }),
      { allowed: true, reason: null },
    ],
    [
      "stops a project whose stop budget is zero at once",
      decide(FUNDED, { project: budget({ budgetMicros: 0 }) }),
      { allowed: false, reason: "project_budget_exceeded" },
    ],
    [
      "ignores the use of an earlier month",
      decide(FUNDED, { project: budget({ period: "2026-10", usedMicros: credits(500) }) }),
      { allowed: true, reason: null },
    ],
    [
      "never stops a project on a continue budget or without one",
      decide(FUNDED, { project: budget({ budgetMode: "continue", usedMicros: credits(500) }) }),
      { allowed: true, reason: null },
    ],
    [
      "has no budget to exceed without an amount",
      decide(FUNDED, {
        project: budget({ budgetMicros: null, budgetMode: null, usedMicros: credits(500) }),
      }),
      { allowed: true, reason: null },
    ],
    [
      "denies exhausted credit before the budget",
      decide(exhaustedFor(9), { project: budget({ usedMicros: credits(500) }) }),
      { allowed: false, reason: "insufficient_organization_credits" },
    ],
    [
      "leaves the Paid features to a Paid organization whose budget stopped the project",
      decide(
        { ...FUNDED, ...PAID },
        { project: budget({ usedMicros: credits(100) }), poweredBy: true },
      ),
      {
        allowed: false,
        reason: "project_budget_exceeded",
        paidAllowed: true,
        customDomainAllowed: true,
      },
    ],
  ];

  it.each(cases)("%s", (_name, decision, expected) => {
    expect(decision).toMatchObject(expected);
  });
});

describe("reading the decision from the Core", () => {
  const read = (
    p: { organizationId: string; projectId: string; devEnvironmentId: string },
    now = OCT,
  ) =>
    readRuntimeDecision(control.core, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      now,
    });

  it("serves an active project, with a decision that lives 15 minutes", async () => {
    const p = await newOrganization(control);
    expect(await read(p)).toEqual({
      allowed: true,
      reason: null,
      paidAllowed: false,
      customDomainAllowed: false,
      checkedAt: "2026-10-30T10:00:00.000Z",
      expiresAt: "2026-10-30T10:15:00.000Z",
    });
    expect(DECISION_TTL_MS).toBe(900_000);
  });

  it("denies an organization with no balance whose platform overrun this month reached the ceiling", () => {
    expect(
      decide({
        ...EMPTY,
        overrun_micros: OVERRUN_CEILING_MICROS,
        overrun_base_micros: 0,
      }).reason,
    ).toBe("insufficient_organization_credits");
  });

  it("serves an organization at the ceiling that still has credit, and serves it again after a top-up", () => {
    expect(
      decide({ ...FUNDED, overrun_micros: OVERRUN_CEILING_MICROS, overrun_base_micros: 0 }).reason,
    ).toBeNull();
    const topped = decide({
      ...EMPTY,
      overrun_micros: OVERRUN_CEILING_MICROS,
      overrun_base_micros: 0,
      onetime_micros: credits(10),
    });
    expect(topped.reason).toBeNull();
    expect(topped.allowed).toBe(true);
  });

  it("serves an organization just below the ceiling, and counts only the overrun of this month", () => {
    expect(
      decide({ ...FUNDED, overrun_micros: OVERRUN_CEILING_MICROS - 1, overrun_base_micros: 0 })
        .reason,
    ).toBeNull();
    expect(
      decide({
        ...FUNDED,
        overrun_micros: OVERRUN_CEILING_MICROS * 3,
        overrun_base_micros: OVERRUN_CEILING_MICROS * 3 - 1,
      }).reason,
    ).toBeNull();
  });

  it("counts no overrun of a month whose renewal is pending, since the renewal starts the month at zero", () => {
    expect(
      decide({
        ...FUNDED,
        monthly_ends_at: "2026-11-01T00:00:00.000000Z",
        overrun_micros: OVERRUN_CEILING_MICROS,
        overrun_base_micros: 0,
      }).reason,
    ).toBeNull();
  });

  it("denies an environment, a project or an organization that is not active", async () => {
    const p = await newOrganization(control);
    expect(
      await readRuntimeDecision(control.core, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: ulidOf("no-environment", 1),
        now: OCT,
      }),
    ).toMatchObject({ allowed: false, reason: "project_unavailable" });
    expect(
      await readRuntimeDecision(control.core, {
        organizationId: ulidOf("ghost", 30),
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        now: OCT,
      }),
    ).toMatchObject({ allowed: false, reason: "project_unavailable" });

    await control.core
      .prepare("UPDATE projects SET lifecycle_state = 'deleting' WHERE project_id = ?")
      .bind(p.projectId)
      .run();
    expect(await read(p)).toMatchObject({ allowed: false, reason: "project_unavailable" });
    await control.core
      .prepare("UPDATE projects SET lifecycle_state = 'active' WHERE project_id = ?")
      .bind(p.projectId)
      .run();
    expect(await read(p)).toMatchObject({ allowed: true });

    await freezeOwnership(p);
    expect(await read(p)).toMatchObject({ allowed: false, reason: "project_unavailable" });

    const q = await newOrganization(control);
    await control.core
      .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?")
      .bind(q.organizationId)
      .run();
    expect(await read(q)).toMatchObject({ allowed: false, reason: "project_unavailable" });
  });

  it("stops a project at its budget for the month and serves it again in the next one", async () => {
    const p = await newOrganization(control);
    const configure = async (budgetMicros: number | null, mode: "continue" | "stop") => {
      const plan = setProjectBudget(control.core, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        budgetMicros,
        mode,
        now: OCT,
      });
      return plan.read(await control.core.batch(plan.statements));
    };
    expect(await configure(credits(60), "stop")).toEqual({ changed: true });
    expect(await read(p)).toMatchObject({ allowed: true });
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: "b-use",
      amountMicros: credits(40),
      now: OCT,
      projects: [{ projectId: p.projectId, amountMicros: credits(40) }],
    });
    expect(await read(p)).toMatchObject({ allowed: true });
    // an open reservation of the project counts like use
    expect(
      await runReserve(control.core, {
        organizationId: p.organizationId,
        reservationId: ulidOf("budget-reservation", 1),
        projectId: p.projectId,
        amountMicros: credits(20),
        now: OCT,
      }),
    ).toMatchObject({ reserved: true });
    expect(await read(p)).toMatchObject({ allowed: false, reason: "project_budget_exceeded" });
    // the use belongs to October, so November starts at zero; only the open reservation still counts
    expect(await read(p, "2026-11-02T00:00:00.000Z")).toMatchObject({
      allowed: true,
      reason: null,
    });
    expect(await configure(null, "continue")).toEqual({ changed: true });
    expect(await read(p)).toMatchObject({ allowed: true });
    expect(() =>
      setProjectBudget(control.core, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        budgetMicros: null,
        mode: "stop",
        now: OCT,
      }),
    ).toThrow(TypeError);
  });

  it("opens custom domains for a project with the powered-by flag", async () => {
    const p = await newOrganization(control);
    expect(await read(p)).toMatchObject({ customDomainAllowed: false });
    await control.core
      .prepare("INSERT INTO project_powered_by_flag_periods VALUES (?1, ?2, ?3, ?4, NULL)")
      .bind(ulidOf("flag-period", 1), p.organizationId, p.projectId, "2026-10-29T00:00:00.000000Z")
      .run();
    expect(await read(p)).toMatchObject({
      allowed: true,
      paidAllowed: false,
      customDomainAllowed: true,
    });
  });
});
