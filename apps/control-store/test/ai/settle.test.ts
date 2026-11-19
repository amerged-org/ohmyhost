import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi, settleAi } from "../../src/catalog/ai/index.js";
import { runReserve } from "../../src/catalog/credit/index.js";
import { groupUsageDays } from "../../../control-api/src/d1-credits.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_MICROS,
  ESTIMATE_NANO,
  LIVE_CHARGE_MICROS,
  LIVE_COST_NANO,
  balanceOf,
  openReservations,
  publishAiCard,
  readyProject,
  reservedOf,
  type AiProject,
} from "./support.js";

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-settle", (sequence += 1));

beforeAll(async () => {
  control = await createTestControl();
  await publishAiCard(control.core);
}, 120_000);
afterAll(async () => control.dispose());

/** Admits one call of the estimate and returns its reservation id. */
async function admitted(p: AiProject, estimate = ESTIMATE_NANO): Promise<string> {
  const id = reservationId();
  const outcome = await admitAi(p.context, {
    scope: p.scope,
    reservationId: id,
    model: "claude-haiku-5-5",
    estimateNanoUsd: estimate,
  });
  expect(outcome).toMatchObject({ admitted: true });
  return id;
}

const settle = (
  p: AiProject,
  id: string,
  costNanoUsd: bigint,
  overrides: { scope?: AiProject["scope"]; traceId?: string | null } = {},
) =>
  settleAi(p.context, {
    scope: overrides.scope ?? p.scope,
    reservationId: id,
    model: "claude-haiku-5-5",
    costNanoUsd,
    usage: { prompt_tokens: 120, completion_tokens: 40 },
    traceId: overrides.traceId === undefined ? "trace-1" : overrides.traceId,
  });

describe("settling an AI call", () => {
  it("prices recorded and marked fallback cost, persists provenance, and resolves each hold once", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const id = await admitted(p);
    const before = await balanceOf(control.core, org);
    expect(await reservedOf(control.core, org)).toBe(ESTIMATE_MICROS);

    expect(await settle(p, id, LIVE_COST_NANO)).toEqual({
      settled: true,
      chargedMicros: LIVE_CHARGE_MICROS,
    });
    expect(await balanceOf(control.core, org)).toBe(before - LIVE_CHARGE_MICROS);
    expect(await reservedOf(control.core, org)).toBe(0);
    expect(await openReservations(control.core, org)).toEqual([]);
    const settled = await control.core
      .prepare("SELECT kind, delta_micros, detail FROM credit_log WHERE key = ?1")
      .bind(`settle:${id}`)
      .first<{ kind: string; delta_micros: number; detail: string }>();
    expect(settled).toMatchObject({ kind: "settle", delta_micros: -LIVE_CHARGE_MICROS });
    expect(JSON.parse(settled?.detail ?? "{}")).toMatchObject({
      kind: "ai",
      meter: "ai.cost",
      unit: "usd_micro",
      rateCardId: "ai-card-1390895",
      model: "claude-haiku-5-5",
      environmentId: p.project.devEnvironmentId,
      projectId: p.project.projectId,
      reservedMicros: ESTIMATE_MICROS,
      chargedMicros: LIVE_CHARGE_MICROS,
      releasedMicros: ESTIMATE_MICROS - LIVE_CHARGE_MICROS,
      quantity: "3.6",
      costNanoUsd: "3600",
      usage: { prompt_tokens: 120, completion_tokens: 40 },
      traceId: "trace-1",
    });

    // The gateway's explicit USD 0.01 LLM fallback remains distinguishable from measured cost in durable accounting.
    const fallbackId = await admitted(p, 10_000_000n);
    const fallback = {
      scope: p.scope,
      reservationId: fallbackId,
      model: "claude-haiku-5-5",
      costNanoUsd: 10_000_000n,
      usage: { fallback_nano_usd: 10_000_000 },
      traceId: null,
    };
    expect(await reservedOf(control.core, org)).toBe(1_390_895);
    expect(await settleAi(p.context, fallback)).toEqual({
      settled: true,
      chargedMicros: 1_390_895,
    });
    expect(await balanceOf(control.core, org)).toBe(before - LIVE_CHARGE_MICROS - 1_390_895);
    expect(await reservedOf(control.core, org)).toBe(0);
    expect(await openReservations(control.core, org)).toEqual([]);
    const fallbackRow = await control.core
      .prepare("SELECT kind,delta_micros,detail FROM credit_log WHERE key=?1")
      .bind(`settle:${fallbackId}`)
      .first<{ kind: string; delta_micros: number; detail: string }>();
    expect(fallbackRow).toMatchObject({ kind: "settle", delta_micros: -1_390_895 });
    expect(JSON.parse(fallbackRow?.detail ?? "{}")).toMatchObject({
      kind: "ai",
      meter: "ai.cost",
      unit: "usd_micro",
      rateCardId: "ai-card-1390895",
      environmentId: p.project.devEnvironmentId,
      projectId: p.project.projectId,
      reservedMicros: 1_390_895,
      chargedMicros: 1_390_895,
      releasedMicros: 0,
      quantity: "10000",
      costNanoUsd: "10000000",
      usage: { fallback_nano_usd: 10_000_000 },
      traceId: null,
    });
    expect(
      await control.core
        .prepare(
          "SELECT sum(used_micros) used_micros FROM project_credit WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(org, p.project.projectId)
        .first(),
    ).toEqual({ used_micros: LIVE_CHARGE_MICROS + 1_390_895 });
    const rows = (
      await control.core
        .prepare(
          "SELECT at,kind,delta_micros,detail FROM credit_log WHERE organization_id=?1 ORDER BY seq",
        )
        .bind(org)
        .all<{ at: string; kind: string; delta_micros: number; detail: string }>()
    ).results.map((row) => ({
      organizationId: org,
      at: row.at,
      kind: row.kind,
      deltaMicros: row.delta_micros,
      balanceMicros: 0,
      detail: JSON.parse(row.detail) as unknown,
    }));
    expect(
      groupUsageDays(rows, p.project.projectId).flatMap((day) =>
        day.projects.flatMap((project) => project.meters),
      ),
    ).toEqual([
      expect.objectContaining({
        environment_id: p.project.devEnvironmentId,
        meter: "ai.cost",
        unit: "usd_micro",
        quantity: "10003.6",
        rate_card_id: "ai-card-1390895",
        charged_micros: String(LIVE_CHARGE_MICROS + 1_390_895),
      }),
    ]);
    // A duplicate cannot replace the original assumed-cost provenance with a later zero or debit again.
    expect(await settleAi(p.context, { ...fallback, costNanoUsd: 0n, usage: {} })).toEqual({
      settled: false,
      reason: "already_resolved",
    });
    expect(await balanceOf(control.core, org)).toBe(before - LIVE_CHARGE_MICROS - 1_390_895);
    expect(
      await control.core
        .prepare("SELECT kind,delta_micros,detail FROM credit_log WHERE key=?1")
        .bind(`settle:${fallbackId}`)
        .first(),
    ).toEqual(fallbackRow);
  });

  it("shows the charge in the usage report through the read the report uses", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const id = await admitted(p);
    await settle(p, id, LIVE_COST_NANO);
    const rows = (
      await control.core
        .prepare(
          "SELECT organization_id, at, kind, delta_micros, detail FROM credit_log WHERE organization_id = ?1 ORDER BY seq",
        )
        .bind(org)
        .all<{
          organization_id: string;
          at: string;
          kind: string;
          delta_micros: number;
          detail: string;
        }>()
    ).results.map((row) => ({
      organizationId: row.organization_id,
      at: row.at,
      kind: row.kind,
      deltaMicros: row.delta_micros,
      balanceMicros: 0,
      detail: JSON.parse(row.detail) as unknown,
    }));
    const meters = groupUsageDays(rows, p.project.projectId).flatMap((day) =>
      day.projects.flatMap((project) => project.meters),
    );
    expect(meters).toEqual([
      expect.objectContaining({
        environment_id: p.project.devEnvironmentId,
        meter: "ai.cost",
        unit: "usd_micro",
        quantity: "3.6",
        rate_card_id: "ai-card-1390895",
        charged_micros: String(LIVE_CHARGE_MICROS),
      }),
    ]);
  });

  it("refuses a second settlement as already resolved and changes nothing", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const id = await admitted(p);
    await settle(p, id, LIVE_COST_NANO);
    const after = await balanceOf(control.core, org);
    expect(await settle(p, id, 9_000_000n)).toEqual({ settled: false, reason: "already_resolved" });
    expect(await balanceOf(control.core, org)).toBe(after);
  });

  it("answers an id that was never reserved as an unknown reservation", async () => {
    const p = await readyProject(control, { credits: 50 });
    expect(await settle(p, reservationId(), LIVE_COST_NANO)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
  });

  it("charges nothing for a call that cost nothing, and returns the whole reservation", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const id = await admitted(p);
    const before = await balanceOf(control.core, org);
    expect(await settle(p, id, 0n)).toEqual({ settled: true, chargedMicros: 0 });
    expect(await balanceOf(control.core, org)).toBe(before);
    expect(await reservedOf(control.core, org)).toBe(0);
  });

  it("refuses a replayed admission of a settled id, because its reservation is gone", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    await settle(p, id, LIVE_COST_NANO);
    expect(
      await admitAi(p.context, {
        scope: p.scope,
        reservationId: id,
        model: "claude-haiku-5-5",
        estimateNanoUsd: ESTIMATE_NANO,
      }),
    ).toEqual({ admitted: false, denial: "unavailable" });
  });

  it("never settles another organization's reservation, nor another project's of the same organization", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const other = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    const before = await balanceOf(control.core, org);

    expect(await settle(other, id, LIVE_COST_NANO)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
    const otherProject: AiProject["scope"] = { ...p.scope, projectId: ulidOf("foreign", 1) };
    expect(await settle(p, id, LIVE_COST_NANO, { scope: otherProject })).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
    expect(
      await settle(p, id, LIVE_COST_NANO, {
        scope: { ...p.scope, environmentId: p.project.prodEnvironmentId },
      }),
    ).toEqual({ settled: false, reason: "unknown_reservation" });
    const build = reservationId();
    await runReserve(control.core, {
      organizationId: org,
      reservationId: build,
      projectId: p.project.projectId,
      amountMicros: 1000,
      now: new Date().toISOString(),
      detail: { operationId: "build" },
    });
    expect(await settle(p, build, LIVE_COST_NANO)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
    expect(await balanceOf(control.core, org)).toBe(before);
    expect(await openReservations(control.core, org)).toEqual([id, build].sort());

    // the owner still settles it, and the other organization's settlement of it stays refused afterwards
    expect(await settle(p, id, LIVE_COST_NANO)).toEqual({ settled: true, chargedMicros: 501 });
    expect(await settle(other, id, LIVE_COST_NANO)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
  });

  it("tells another organization only that the id is unknown, and the owner that it is already resolved", async () => {
    const p = await readyProject(control, { credits: 50 });
    const other = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    await settle(p, id, LIVE_COST_NANO);
    expect(await settle(other, id, LIVE_COST_NANO)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
    expect(await settle(p, id, LIVE_COST_NANO)).toEqual({
      settled: false,
      reason: "already_resolved",
    });
  });

  it("refuses input that is not a non-negative cost or carries text where a counter belongs", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    await expect(settle(p, id, -1n)).rejects.toThrow("Invalid AI gateway input");
    await expect(
      settleAi(p.context, {
        scope: p.scope,
        reservationId: id,
        model: "m",
        costNanoUsd: 1n,
        usage: { prompt: "the question itself" as unknown as number },
        traceId: null,
      }),
    ).rejects.toThrow("Invalid AI gateway input");
  });
});
