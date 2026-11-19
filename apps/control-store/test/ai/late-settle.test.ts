import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi, settleAi, sweepAi } from "../../src/catalog/ai/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_NANO,
  LIVE_CHARGE_MICROS,
  LIVE_COST_NANO,
  balanceOf,
  publishAiCard,
  readyProject,
  type AiProject,
} from "./support.js";

/*
 * A call that was delivered after the sweep released its reservation is still charged once: the platform paid orq for
 * it. A trace id the gateway cannot store never makes a settlement fail.
 */

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-late-settle", (sequence += 1));

beforeAll(async () => {
  control = await createTestControl();
  await publishAiCard(control.core);
}, 120_000);
afterAll(async () => control.dispose());

async function admitted(p: AiProject): Promise<string> {
  const id = reservationId();
  expect(
    await admitAi(p.context, {
      scope: p.scope,
      reservationId: id,
      model: "claude-haiku-5-5",
      estimateNanoUsd: ESTIMATE_NANO,
    }),
  ).toMatchObject({ admitted: true });
  return id;
}

/** The reservation is older than the sweep's cutoff, as a call whose Worker died would leave it. */
async function ageReservation(id: string): Promise<void> {
  await control.core
    .prepare(
      "UPDATE credit_reservation SET created_at = '2026-01-01T00:00:00.000000Z' WHERE reservation_id = ?1",
    )
    .bind(id)
    .run();
}

const settle = (p: AiProject, id: string, traceId: string | null) =>
  settleAi(p.context, {
    scope: p.scope,
    reservationId: id,
    model: "claude-haiku-5-5",
    costNanoUsd: LIVE_COST_NANO,
    usage: { prompt_tokens: 120, completion_tokens: 40 },
    traceId,
  });

describe("settling a call whose reservation the sweep released", () => {
  it("charges the measured cost once, after the release, and answers a second settlement as resolved", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const id = await admitted(p);
    await ageReservation(id);
    expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 })).toEqual({
      released: 1,
      skipped: 0,
    });
    const afterRelease = await balanceOf(control.core, org);

    expect(await settle(p, id, "trace-late")).toEqual({
      settled: true,
      chargedMicros: LIVE_CHARGE_MICROS,
    });
    expect(await balanceOf(control.core, org)).toBe(afterRelease - LIVE_CHARGE_MICROS);
    expect(await settle(p, id, "trace-late")).toEqual({
      settled: false,
      reason: "already_resolved",
    });
    expect(await balanceOf(control.core, org)).toBe(afterRelease - LIVE_CHARGE_MICROS);
  });

  it("charges the late settlement to the project and environment of the call in the usage report", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    await ageReservation(id);
    await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 });
    await settle(p, id, null);
    const row = await control.core
      .prepare("SELECT kind, detail FROM credit_log WHERE key = ?1")
      .bind(`settle:${id}`)
      .first<{ kind: string; detail: string }>();
    expect(row?.kind).toBe("usage");
    expect(JSON.parse(row?.detail ?? "{}").lateAfterSweep).toBe(true);
    expect(JSON.parse(row?.detail ?? "{}").lines).toEqual([
      {
        projectId: p.project.projectId,
        environmentId: p.project.devEnvironmentId,
        meter: "ai.cost",
        unit: "usd_micro",
        rateCardId: "ai-card-1390895",
        quantity: "3.6",
        chargeMicros: LIVE_CHARGE_MICROS,
      },
    ]);
  });

  it("does not charge a swept reservation to another project of the organization", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    await ageReservation(id);
    await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 });
    const before = await balanceOf(control.core, p.project.organizationId);
    const otherProject: AiProject["scope"] = {
      ...p.scope,
      projectId: ulidOf("ai-late-foreign", 1),
    };
    expect(
      await settleAi(p.context, {
        scope: otherProject,
        reservationId: id,
        model: "claude-haiku-5-5",
        costNanoUsd: LIVE_COST_NANO,
        usage: {},
        traceId: null,
      }),
    ).toEqual({ settled: false, reason: "unknown_reservation" });
    expect(await balanceOf(control.core, p.project.organizationId)).toBe(before);
  });
});

describe("the trace id of a settlement", () => {
  it("accepts an empty or an over-long trace id, and stores at most 256 characters of it", async () => {
    const p = await readyProject(control, { credits: 50 });
    const empty = await admitted(p);
    expect(await settle(p, empty, "")).toEqual({
      settled: true,
      chargedMicros: LIVE_CHARGE_MICROS,
    });
    const long = await admitted(p);
    expect(await settle(p, long, "t".repeat(400))).toEqual({
      settled: true,
      chargedMicros: LIVE_CHARGE_MICROS,
    });
    const stored = await control.core
      .prepare("SELECT detail FROM credit_log WHERE key = ?1")
      .bind(`settle:${long}`)
      .first<{ detail: string }>();
    expect(JSON.parse(stored?.detail ?? "{}").traceId).toHaveLength(256);
    const none = await control.core
      .prepare("SELECT detail FROM credit_log WHERE key = ?1")
      .bind(`settle:${empty}`)
      .first<{ detail: string }>();
    expect(JSON.parse(none?.detail ?? "{}").traceId).toBeNull();
  });
});
