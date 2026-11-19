import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runChargeOrg,
  runGrantCredit,
  setPaid,
  setProjectBudget,
} from "../../src/catalog/credit/index.js";
import { readGatewayRuntimeCreditDecision } from "../../src/catalog/billing/gateway-credit-decision.js";
import type { D1Database } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { OCT, credits, newOrganization } from "./support.js";

/**
 * The gateway's serving read on the real Core: the shape the gateway validates, the three denials of the money model
 * and the promise that a serving read changes nothing.
 */

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

/** The Core as the serving read sees it: every statement it prepares must be a SELECT. */
const readonly = (): D1Database => ({
  prepare: (sql) => {
    if (!/^\s*SELECT\b/iu.test(sql)) throw new Error("serving_read_attempted_write");
    return control.core.prepare(sql);
  },
  batch: (statements) => control.core.batch(statements),
});
const decide = (
  p: { organizationId: string; projectId: string; devEnvironmentId: string },
  now = OCT,
) =>
  readGatewayRuntimeCreditDecision(
    { directory: control.core, router: new SharedCoreRouter(readonly()) },
    {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      now,
    },
  );

describe("the gateway serving decision", () => {
  it("answers exactly the shape the gateway validates, for an organization that was never written", async () => {
    const p = await newOrganization(control);
    expect(await decide(p)).toEqual({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      allowed: true,
      paidAllowed: false,
      reason: null,
      checkedAt: "2026-10-30T10:00:00.000Z",
      expiresAt: "2026-10-30T10:15:00.000Z",
    });
    expect(
      await control.core
        .prepare("SELECT 1 FROM credit_account WHERE organization_id = ?")
        .bind(p.organizationId)
        .first(),
    ).toBeNull();
  });

  it("keeps serving through the 7-day grace after the credit ran out and denies once it lapsed", async () => {
    const p = await newOrganization(control);
    // the first write of November renews the Free allowance, and spending all of it starts the grace
    const exhaustedAt = "2026-11-02T10:00:00.000Z";
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: "gw-drain",
      amountMicros: credits(200),
      now: exhaustedAt,
    });
    expect(await decide(p, "2026-11-02T10:00:01.000Z")).toMatchObject({ allowed: true });
    expect(await decide(p, "2026-11-09T09:59:59.000Z")).toMatchObject({ allowed: true });
    expect(await decide(p, "2026-11-09T10:00:00.000Z")).toMatchObject({
      allowed: false,
      reason: "insufficient_organization_credits",
      paidAllowed: false,
    });
    await runGrantCredit(control.core, {
      organizationId: p.organizationId,
      key: "topup:gw",
      kind: "onetime",
      amountMicros: credits(1),
      now: "2026-11-09T12:00:00.000Z",
    });
    expect(await decide(p, "2026-11-09T12:00:00.000Z")).toMatchObject({ allowed: true });
  });

  it("denies a stop budget that is used up and leaves Paid features to a Paid organization", async () => {
    const p = await newOrganization(control);
    const configure = setProjectBudget(control.core, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      budgetMicros: credits(10),
      mode: "stop",
      now: OCT,
    });
    await control.core.batch(configure.statements);
    const paid = setPaid(control.core, {
      organizationId: p.organizationId,
      paidUntil: "2026-12-01T00:00:00.000Z",
      source: "stripe",
      now: OCT,
    });
    await control.core.batch(paid.statements);
    expect(await decide(p)).toMatchObject({ allowed: true, paidAllowed: true });
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: "gw-budget",
      amountMicros: credits(10),
      now: OCT,
      projects: [{ projectId: p.projectId, amountMicros: credits(10) }],
    });
    expect(await decide(p)).toMatchObject({
      allowed: false,
      reason: "project_budget_exceeded",
      paidAllowed: true,
    });
  });

  it("denies a project that is not in the organization and rejects a malformed request", async () => {
    const p = await newOrganization(control);
    const other = await newOrganization(control);
    expect(
      await readGatewayRuntimeCreditDecision(
        { directory: control.core, router: new SharedCoreRouter(readonly()) },
        {
          organizationId: p.organizationId,
          projectId: other.projectId,
          environmentId: other.devEnvironmentId,
          now: OCT,
        },
      ),
    ).toMatchObject({ allowed: false, reason: "project_unavailable", paidAllowed: false });
    await expect(
      readGatewayRuntimeCreditDecision(
        { directory: control.core, router: new SharedCoreRouter(readonly()) },
        { organizationId: p.organizationId, projectId: p.projectId, now: OCT },
      ),
    ).rejects.toThrow();
  });
});
