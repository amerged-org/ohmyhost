import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  accountView,
  buildAdmissionDenial,
  OVERRUN_CEILING_MICROS,
  paidDenial,
  readProjectBudget,
  runChargeOrg,
  runReserve,
  setProjectBudget,
  type AccountRow,
  type ProjectBudget,
} from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
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
const PAID = { paid_until: "2026-12-01T00:00:00.000000Z", paid_source: "stripe" } as const;
/** Exhausted `days` days before NOW: nothing left, and the 7-day grace runs from that instant. */
const exhaustedFor = (days: number): AccountRow => ({
  ...FUNDED,
  monthly_micros: 0,
  exhausted_at: new Date(Date.parse(NOW) - days * 86_400_000).toISOString().replace("Z", "000Z"),
});
const view = (row: AccountRow) => accountView("o", row, NOW);
const budget = (overrides: Partial<ProjectBudget> = {}): ProjectBudget => ({
  budgetMicros: credits(100),
  budgetMode: "stop",
  period: "2026-11",
  usedMicros: 0,
  reservedMicros: 0,
  ...overrides,
});

describe("the admission of Paid features", () => {
  it("needs Paid coverage, and once the credit is exhausted a grace that has not lapsed", () => {
    expect(paidDenial(view(FUNDED))).toBe("paid_plan_required");
    expect(paidDenial(view({ ...exhaustedFor(30) }))).toBe("paid_plan_required");
    expect(paidDenial(view({ ...FUNDED, ...PAID }))).toBeNull();
    expect(paidDenial(view({ ...exhaustedFor(2), ...PAID }))).toBeNull();
    expect(paidDenial(view({ ...exhaustedFor(8), ...PAID }))).toBe(
      "insufficient_organization_credits",
    );
    // credit that is only reserved for builds does not start the grace
    expect(paidDenial(view({ ...FUNDED, ...PAID, reserved_micros: credits(50) }))).toBeNull();
  });
  it("refuses Paid features at the month's overrun ceiling with no balance, even inside the grace", () => {
    const overrun = (overrun_micros: number) => ({
      ...exhaustedFor(2),
      ...PAID,
      overrun_micros,
      overrun_base_micros: 0,
    });
    expect(paidDenial(view(overrun(OVERRUN_CEILING_MICROS)))).toBe(
      "insufficient_organization_credits",
    );
    expect(paidDenial(view(overrun(OVERRUN_CEILING_MICROS - 1)))).toBeNull();
  });
});

describe("the admission of a build", () => {
  const admit = (
    account: AccountRow,
    amountMicros: number,
    extra: { project?: ProjectBudget | null; requirePaid?: boolean } = {},
  ) =>
    buildAdmissionDenial({
      now: NOW,
      account: view(account),
      project: extra.project ?? null,
      amountMicros,
      requirePaid: extra.requirePaid ?? false,
    });

  it("reserves the quote only from the available credit, without any grace", () => {
    expect(admit(FUNDED, credits(50))).toBeNull();
    expect(admit(FUNDED, credits(50) + 1)).toBe("insufficient_organization_credits");
    expect(admit({ ...FUNDED, reserved_micros: credits(40) }, credits(11))).toBe(
      "insufficient_organization_credits",
    );
    expect(admit({ ...FUNDED, onetime_micros: credits(5) }, credits(55))).toBeNull();
    // exhausted a day ago: serving continues in the grace, a build does not start
    expect(admit(exhaustedFor(1), 1)).toBe("insufficient_organization_credits");
  });

  it("holds a stop budget to the use of the month, the open reservations and the quote", () => {
    const stop = (overrides: Partial<ProjectBudget>) =>
      admit(FUNDED, credits(10), { project: budget(overrides) });
    expect(stop({})).toBeNull();
    expect(stop({ usedMicros: credits(90) })).toBeNull();
    expect(stop({ usedMicros: credits(91) })).toBe("project_budget_exceeded");
    expect(stop({ usedMicros: credits(50), reservedMicros: credits(41) })).toBe(
      "project_budget_exceeded",
    );
    // the use of an earlier month does not count; neither do a continue budget and a missing amount
    expect(stop({ usedMicros: credits(500), period: "2026-10" })).toBeNull();
    expect(stop({ usedMicros: credits(500), budgetMode: "continue" })).toBeNull();
    expect(stop({ usedMicros: credits(500), budgetMicros: null })).toBeNull();
    // the budget is refused before the credit
    expect(
      admit({ ...FUNDED, monthly_micros: 0 }, credits(10), {
        project: budget({ usedMicros: credits(95) }),
      }),
    ).toBe("project_budget_exceeded");
  });

  it("asks a Paid feature for Paid coverage first", () => {
    expect(admit(FUNDED, credits(1), { requirePaid: true })).toBe("paid_plan_required");
    expect(admit({ ...FUNDED, ...PAID }, credits(1), { requirePaid: true })).toBeNull();
    expect(admit({ ...exhaustedFor(8), ...PAID }, credits(1), { requirePaid: true })).toBe(
      "insufficient_organization_credits",
    );
  });
});

describe("the budget of a project as the admission reads it", () => {
  it("is nothing before a charge or a budget, then the use, the budget and the open reservations", async () => {
    const p = await newOrganization(control);
    const input = { organizationId: p.organizationId, projectId: p.projectId };
    expect(await readProjectBudget(control.core, input)).toBeNull();

    await control.core.batch(
      setProjectBudget(control.core, {
        ...input,
        budgetMicros: credits(20),
        mode: "stop",
        now: OCT,
      }).statements,
    );
    expect(await readProjectBudget(control.core, input)).toEqual({
      budgetMicros: credits(20),
      budgetMode: "stop",
      period: "2026-10",
      usedMicros: 0,
      reservedMicros: 0,
    });

    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: "usage:wfp:budget-read",
      amountMicros: credits(3),
      now: OCT,
      projects: [{ projectId: p.projectId, amountMicros: credits(3) }],
    });
    await runReserve(control.core, {
      organizationId: p.organizationId,
      reservationId: "01BUDGETREAD0000000000000A",
      projectId: p.projectId,
      amountMicros: credits(7),
      now: OCT,
    });
    // a reservation of another project of the organization is not this project's
    await runReserve(control.core, {
      organizationId: p.organizationId,
      reservationId: "01BUDGETREAD0000000000000B",
      projectId: null,
      amountMicros: credits(1),
      now: OCT,
    });
    expect(await readProjectBudget(control.core, input)).toMatchObject({
      usedMicros: credits(3),
      reservedMicros: credits(7),
    });
  });
});
