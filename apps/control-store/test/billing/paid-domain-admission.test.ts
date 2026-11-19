import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitPaidProjectDomain } from "../../src/catalog/billing/paid-domain-admission.js";
import { runReserve, setProjectBudget } from "../../src/catalog/credit/index.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import { exhaust, FIXTURE_NOW, grantOneTime, makePaid } from "../support/credit-fixtures.js";
import { seedProject, ulidOf, type SeededProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

const admit = (p: SeededProject, now = FIXTURE_NOW, projectId = p.projectId) =>
  admitPaidProjectDomain(
    { directory: control.core, router: coreRouter(control) },
    { organizationId: p.organizationId, projectId, now },
  );
const accounts = async (organizationId: string) =>
  (
    await control.core
      .prepare("SELECT count(*) n FROM credit_account WHERE organization_id = ?")
      .bind(organizationId)
      .first<{ n: number }>()
  )?.n;

describe("paid domain admission", () => {
  it("admits by the powered-by flag or Paid access, refuses a Free organization otherwise, and only reads", async () => {
    const p = await seedProject(control);
    // Free and without the flag: a Paid plan is required. The answer is a read: no credit account is written.
    expect(await admit(p)).toBe("paid_plan_required");
    expect(await admit(p)).toBe("paid_plan_required");
    expect(await accounts(p.organizationId)).toBe(0);

    // An open powered-by flag period admits the domain on the Free plan.
    await control.core
      .prepare(
        "INSERT INTO project_powered_by_flag_periods(period_id, organization_id, project_id, enabled_at) VALUES (?, ?, ?, ?)",
      )
      .bind(ulidOf("flag-period", 1), p.organizationId, p.projectId, "2026-10-01T00:00:00.000000Z")
      .run();
    expect(await admit(p)).toBeNull();

    // A reached stop budget refuses even with the flag.
    await control.core.batch(
      setProjectBudget(control.core, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        budgetMicros: 2_000_000,
        mode: "stop",
        now: FIXTURE_NOW,
      }).statements,
    );
    expect(
      await runReserve(control.core, {
        organizationId: p.organizationId,
        reservationId: ulidOf("domain-hold", 1),
        projectId: p.projectId,
        amountMicros: 3_000_000,
        now: FIXTURE_NOW,
      }),
    ).toMatchObject({ reserved: true });
    expect(await admit(p)).toBe("project_budget_exceeded");
  });

  it("keeps the exhausted organization inside its 7-day grace and refuses it once the grace lapsed", async () => {
    const free = await seedProject(control);
    await exhaust(control.core, free.organizationId, "2026-10-27T10:00:00.000000Z");
    // Inside the grace the Free organization is only missing the Paid plan.
    expect(await admit(free)).toBe("paid_plan_required");
    await exhaust(control.core, free.organizationId, "2026-10-20T10:00:00.000000Z");
    expect(await admit(free)).toBe("insufficient_organization_credits");

    const paid = await seedProject(control);
    await makePaid(control.core, paid.organizationId);
    expect(await admit(paid)).toBeNull();
    await exhaust(control.core, paid.organizationId, "2026-10-27T10:00:00.000000Z");
    expect(await admit(paid)).toBeNull();
    await exhaust(control.core, paid.organizationId, "2026-10-20T10:00:00.000000Z");
    expect(await admit(paid)).toBe("insufficient_organization_credits");
    await grantOneTime(control.core, paid.organizationId, 5_000_000);
    expect(await admit(paid)).toBeNull();
  });

  it("cannot admit a project without a production environment or one of another organization", async () => {
    const p = await seedProject(control),
      other = await seedProject(control);
    await expect(admit(p, FIXTURE_NOW, other.projectId)).rejects.toThrow(
      "Paid domain environment is unavailable",
    );
    await control.core
      .prepare("UPDATE projects SET lifecycle_state = 'deleting' WHERE project_id = ?")
      .bind(p.projectId)
      .run();
    await expect(admit(p)).rejects.toMatchObject({ code: "organization_credit_scope_missing" });
  });
});
