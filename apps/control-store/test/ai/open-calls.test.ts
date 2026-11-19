import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi, releaseAi, settleAi } from "../../src/catalog/ai/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_MICROS,
  ESTIMATE_NANO,
  LIVE_COST_NANO,
  openReservations,
  publishAiCard,
  readyProject,
  reservedOf,
  type AiProject,
} from "./support.js";

/*
 * An organization holds at most eight unresolved AI calls. The cap is read in the batch that reserves, so concurrent
 * admissions cannot pass it together. A settled or released call stops counting at once, even before the sweep removes
 * its marker.
 */

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-open-calls", (sequence += 1));

beforeAll(async () => {
  control = await createTestControl();
  await publishAiCard(control.core);
}, 120_000);
afterAll(async () => control.dispose());

const call = (p: AiProject, id = reservationId()) => ({
  scope: p.scope,
  reservationId: id,
  model: "claude-haiku-5-5",
  estimateNanoUsd: ESTIMATE_NANO,
});

async function fill(p: AiProject, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = reservationId();
    expect(await admitAi(p.context, call(p, id))).toMatchObject({ admitted: true });
    ids.push(id);
  }
  return ids;
}

describe("the cap of unresolved AI calls per organization", () => {
  it("admits eight calls and refuses the ninth before anything is reserved", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const [first] = await fill(p, 8);
    expect(await admitAi(p.context, call(p, first))).toEqual({
      admitted: true,
      reservedMicros: ESTIMATE_MICROS,
    });
    const reserved = await reservedOf(control.core, org);
    expect(reserved).toBe(8 * ESTIMATE_MICROS);
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "too_many_open_calls",
    });
    expect(await reservedOf(control.core, org)).toBe(reserved);
    expect(await openReservations(control.core, org)).toHaveLength(8);
  });

  it("admits no more than eight of twelve concurrent calls", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => admitAi(p.context, call(p))),
    );
    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(8);
    expect(outcomes.filter((outcome) => !outcome.admitted)).toEqual(
      Array.from({ length: 4 }, () => ({ admitted: false, denial: "too_many_open_calls" })),
    );
    expect(await reservedOf(control.core, org)).toBe(8 * ESTIMATE_MICROS);
    expect(await openReservations(control.core, org)).toHaveLength(8);
  });

  it("frees a slot when an open call is released", async () => {
    const p = await readyProject(control, { credits: 50 });
    const [first] = await fill(p, 8);
    expect(await admitAi(p.context, call(p))).toEqual({
      admitted: false,
      denial: "too_many_open_calls",
    });
    expect(
      await releaseAi(p.context, {
        scope: p.scope,
        reservationId: first,
        reason: "upstream_error",
      }),
    ).toEqual({ released: true });
    expect(await admitAi(p.context, call(p))).toMatchObject({ admitted: true });
  });

  it("frees a slot when an open call is settled, before the sweep removes its marker", async () => {
    const p = await readyProject(control, { credits: 50 });
    const [first] = await fill(p, 8);
    expect(
      await settleAi(p.context, {
        scope: p.scope,
        reservationId: first,
        model: "claude-haiku-5-5",
        costNanoUsd: LIVE_COST_NANO,
        usage: {},
        traceId: null,
      }),
    ).toMatchObject({ settled: true });
    const markers = await control.core
      .prepare("SELECT count(*) AS n FROM ai_gateway_reservations WHERE organization_id = ?1")
      .bind(p.project.organizationId)
      .first<{ n: number }>();
    expect(markers?.n).toBe(8);
    expect(await admitAi(p.context, call(p))).toMatchObject({ admitted: true });
  });

  it("counts the open calls of its own organization only", async () => {
    const busy = await readyProject(control, { credits: 50 });
    const other = await readyProject(control, { credits: 50 });
    await fill(busy, 8);
    expect(await admitAi(busy.context, call(busy))).toEqual({
      admitted: false,
      denial: "too_many_open_calls",
    });
    expect(await admitAi(other.context, call(other))).toMatchObject({ admitted: true });
  });
});
