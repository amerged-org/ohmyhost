import { expect, it } from "vitest";
import {
  accountView,
  FREE_MONTHLY_MICROS,
  OVERRUN_CEILING_MICROS,
  type AccountRow,
} from "../../src/catalog/credit/index.js";
import {
  mailChargeMicros,
  requireMailAccess,
  requireMailBudget,
} from "../../src/catalog/mail/credit.js";

const NOW = "2026-10-30T10:00:00.000000Z";
const row = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  monthly_micros: FREE_MONTHLY_MICROS,
  monthly_ends_at: "2026-11-01T00:00:00.000000Z",
  onetime_micros: 0,
  reserved_micros: 0,
  overrun_micros: 0,
  exhausted_at: null,
  paid_until: "2099-01-01T00:00:00.000000Z",
  paid_source: "manual",
  ...overrides,
});
const view = (overrides?: Partial<AccountRow>) => accountView("org", row(overrides), NOW);

it("charges the published rate per unit, rounded up, and refuses a card that rates no unit", () => {
  expect(mailChargeMicros({ units_per_charge: "1", credit_micros: "180000" })).toBe(180000);
  expect(mailChargeMicros({ units_per_charge: "3", credit_micros: "180000" })).toBe(60000);
  expect(mailChargeMicros({ units_per_charge: "7", credit_micros: "10" })).toBe(2);
  expect(mailChargeMicros({ units_per_charge: "0", credit_micros: "180000" })).toBeNull();
});

it("lets Paid mail through exhaustion until the 7-day grace has passed", () => {
  requireMailAccess(view());
  expect(() => requireMailAccess(view({ paid_until: null, paid_source: null }))).toThrow(
    "paid_plan_required",
  );
  const exhausted = (at: string) => view({ monthly_micros: 0, exhausted_at: at });
  requireMailAccess(exhausted("2026-10-25T10:00:00.000000Z"));
  expect(() => requireMailAccess(exhausted("2026-10-23T09:00:00.000000Z"))).toThrow(
    "insufficient_organization_credits",
  );
});

it("refuses mail at the month's overrun ceiling with no balance, even inside the grace", () => {
  const exhaustedAt = "2026-10-29T10:00:00.000000Z";
  const overrun = (overrun_micros: number) =>
    view({ monthly_micros: 0, exhausted_at: exhaustedAt, overrun_micros, overrun_base_micros: 0 });
  expect(() => requireMailAccess(overrun(OVERRUN_CEILING_MICROS))).toThrow(
    "insufficient_organization_credits",
  );
  requireMailAccess(overrun(OVERRUN_CEILING_MICROS - 1));
});

it("refuses mail only for a Stop budget whose use of the month is spent", () => {
  const project = (budgetMode: "stop" | "continue", usedMicros: number) => ({
    budgetMicros: 100,
    budgetMode,
    period: "2026-10",
    usedMicros,
    reservedMicros: 0,
  });
  requireMailBudget(view(), null, NOW);
  requireMailBudget(view(), project("stop", 99), NOW);
  requireMailBudget(view(), project("continue", 500), NOW);
  expect(() => requireMailBudget(view(), project("stop", 100), NOW)).toThrow(
    "project_budget_exceeded",
  );
});
