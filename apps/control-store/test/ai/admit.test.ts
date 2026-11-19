import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi } from "../../src/catalog/ai/index.js";
import {
  OVERRUN_CEILING_MICROS,
  readAccount,
  runReserve,
  setProjectBudget,
} from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { newOrganization } from "../credit/support.js";
import {
  ESTIMATE_MICROS,
  ESTIMATE_NANO,
  balanceOf,
  context,
  nowIso,
  openReservations,
  publishAiCard,
  readyProject,
  reservedOf,
  type AiProject,
} from "./support.js";

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-admit", (sequence += 1));

beforeAll(async () => {
  control = await createTestControl();
  await publishAiCard(control.core);
}, 120_000);
afterAll(async () => control.dispose());

const call = (p: AiProject, id = reservationId(), estimate = ESTIMATE_NANO) => ({
  scope: p.scope,
  reservationId: id,
  model: "claude-haiku-5-5",
  estimateNanoUsd: estimate,
});

describe("admitting an AI call", () => {
  it("refuses a Free workspace before anything is reserved", async () => {
    const p = await readyProject(control, { paid: false });
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "paid_plan_required",
    });
    expect(await openReservations(control.core, p.project.organizationId)).toEqual([]);
  });

  it("admits a Paid call with credit and raises the reserved micros by the card's charge", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = reservationId();
    expect(await admitAi(p.context, call(p, id))).toEqual({
      admitted: true,
      reservedMicros: ESTIMATE_MICROS,
    });
    expect(await reservedOf(control.core, p.project.organizationId)).toBe(ESTIMATE_MICROS);
    expect(await openReservations(control.core, p.project.organizationId)).toEqual([id]);
    const logged = await control.core
      .prepare("SELECT kind, detail FROM credit_log WHERE key = ?1")
      .bind(`reserve:${id}`)
      .first<{ kind: string; detail: string }>();
    expect(logged?.kind).toBe("reserve");
    expect(JSON.parse(logged?.detail ?? "{}")).toEqual({
      kind: "ai",
      model: "claude-haiku-5-5",
      environmentId: p.project.devEnvironmentId,
      projectId: p.project.projectId,
      reservedMicros: ESTIMATE_MICROS,
    });
  });

  it("reserves at least one micro-credit for an estimate of nothing", async () => {
    const p = await readyProject(control, { credits: 5 });
    expect(await admitAi(p.context, call(p, reservationId(), 0n))).toEqual({
      admitted: true,
      reservedMicros: 1,
    });
  });

  it("refuses a Stop budget whose use of the month, with the open reservations, is spent", async () => {
    const p = await readyProject(control, { credits: 50 });
    const now = nowIso();
    await control.core.batch(
      setProjectBudget(control.core, {
        organizationId: p.project.organizationId,
        projectId: p.project.projectId,
        budgetMicros: 1_000_000,
        mode: "stop",
        now,
      }).statements,
    );
    // the budget of one credit is spent by an open reservation of exactly that amount
    await runReserve(control.core, {
      organizationId: p.project.organizationId,
      reservationId: reservationId(),
      projectId: p.project.projectId,
      amountMicros: 1_000_000,
      now,
    });
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "project_budget_exceeded",
    });
  });

  it("refuses a call whose credit is all reserved, with nothing reserved for it", async () => {
    const p = await readyProject(control, { credits: 2 });
    const account = await readAccount(control.core, p.project.organizationId, nowIso());
    await runReserve(control.core, {
      organizationId: p.project.organizationId,
      reservationId: reservationId(),
      projectId: null,
      amountMicros: account.availableMicros,
      now: nowIso(),
    });
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "insufficient_organization_credits",
    });
    expect(await openReservations(control.core, p.project.organizationId)).toHaveLength(1);
  });

  it("refuses an exhausted credit whose 7-day grace has lapsed", async () => {
    const p = await readyProject(control, { credits: 1 });
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_micros = 0, onetime_micros = 0, monthly_ends_at = '2099-01-01T00:00:00.000000Z', exhausted_at = '2026-01-01T00:00:00.000000Z' WHERE organization_id = ?1",
      )
      .bind(p.project.organizationId)
      .run();
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "insufficient_organization_credits",
    });
  });

  it("refuses a call once the platform overrun of the month reached its ceiling with no balance, with nothing reserved, and admits it after a top-up", async () => {
    const p = await readyProject(control, { credits: 1 });
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_micros = 0, onetime_micros = 0, overrun_micros = ?2, overrun_base_micros = 0 WHERE organization_id = ?1",
      )
      .bind(p.project.organizationId, OVERRUN_CEILING_MICROS)
      .run();
    const before = await openReservations(control.core, p.project.organizationId);
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "insufficient_organization_credits",
    });
    expect(await openReservations(control.core, p.project.organizationId)).toEqual(before);
    await control.core
      .prepare("UPDATE credit_account SET onetime_micros = 1000000 WHERE organization_id = ?1")
      .bind(p.project.organizationId)
      .run();
    expect(await admitAi(p.context, call(p))).toMatchObject({ admitted: true });
  });

  it("answers a repeated reservation id with the open amount, and never reserves twice", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = reservationId();
    const before = await balanceOf(control.core, p.project.organizationId);
    expect(await admitAi(p.context, call(p, id))).toEqual({
      admitted: true,
      reservedMicros: ESTIMATE_MICROS,
    });
    expect(await admitAi(p.context, call(p, id, ESTIMATE_NANO * 10n))).toEqual({
      admitted: true,
      reservedMicros: ESTIMATE_MICROS,
    });
    expect(await reservedOf(control.core, p.project.organizationId)).toBe(ESTIMATE_MICROS);
    expect(await balanceOf(control.core, p.project.organizationId)).toBe(before);
    expect(await openReservations(control.core, p.project.organizationId)).toEqual([id]);
  });

  it("refuses a repeated reservation id of another organization", async () => {
    const p = await readyProject(control, { credits: 50 });
    const other = await readyProject(control, { credits: 50 });
    const id = reservationId();
    expect(await admitAi(p.context, call(p, id))).toMatchObject({ admitted: true });
    // the same id from another organization: the reservation is the first one's, so the call is refused
    expect(await admitAi(other.context, call(other, id))).toEqual({
      admitted: false,
      denial: "unavailable",
    });
    expect(await openReservations(control.core, other.project.organizationId)).toEqual([]);
  });

  it("refuses an environment that does not belong to the organization of the call", async () => {
    const p = await readyProject(control, { credits: 50 });
    const other = await newOrganization(control);
    expect(
      await admitAi(context(control), {
        ...call(p),
        scope: { ...p.scope, environmentId: other.devEnvironmentId },
      }),
    ).toEqual({ admitted: false, denial: "unavailable" });
    expect(await openReservations(control.core, p.project.organizationId)).toEqual([]);
  });

  it("refuses input that is not a scope, a ULID or a non-negative estimate", async () => {
    const p = await readyProject(control, { credits: 5 });
    await expect(admitAi(p.context, { ...call(p), reservationId: "x" })).rejects.toThrow(
      "Invalid AI gateway input",
    );
    await expect(admitAi(p.context, { ...call(p), estimateNanoUsd: -1n })).rejects.toThrow(
      "Invalid AI gateway input",
    );
    await expect(
      admitAi(p.context, { ...call(p), scope: { ...p.scope, jurisdiction: "us" } }),
    ).rejects.toThrow("Invalid AI gateway input");
  });

  it("denies a call once the Paid coverage of the organization has ended", async () => {
    const p = await readyProject(control, { credits: 50 });
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until = NULL, paid_source = NULL WHERE organization_id = ?1",
      )
      .bind(p.project.organizationId)
      .run();
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "paid_plan_required",
    });
  });
});
