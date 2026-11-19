import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi } from "../../src/catalog/ai/index.js";
import { setProjectBudget } from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_MICROS,
  ESTIMATE_NANO,
  nowIso,
  openReservations,
  publishAiCard,
  readyProject,
  reservedOf,
  type AiProject,
} from "./support.js";

/*
 * The Stop budget of a project bounds the use of the month plus the open reservations plus the call's own estimate. The
 * estimate of one call is 13_909 micros, so a budget of 20_000 holds one call and no second one.
 */

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-budget", (sequence += 1));
const BUDGET = 20_000;

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

async function stopBudget(p: AiProject, budgetMicros: number): Promise<void> {
  await control.core.batch(
    setProjectBudget(control.core, {
      organizationId: p.project.organizationId,
      projectId: p.project.projectId,
      budgetMicros,
      mode: "stop",
      now: nowIso(),
    }).statements,
  );
}

describe("the Stop budget of a project against sequential and concurrent calls", () => {
  it("admits a call only while the use, the open reservations and its own estimate fit the budget", async () => {
    const p = await readyProject(control, { credits: 50 });
    await stopBudget(p, BUDGET);
    const first = call(p);
    expect(await admitAi(p.context, first)).toEqual({
      admitted: true,
      reservedMicros: ESTIMATE_MICROS,
    });
    expect(await admitAi(p.context, first)).toEqual({
      admitted: true,
      reservedMicros: ESTIMATE_MICROS,
    });
    const admitted: boolean[] = [];
    for (let index = 0; index < 4; index += 1) {
      admitted.push((await admitAi(p.context, call(p))).admitted);
    }
    expect(admitted).toEqual([false, false, false, false]);
    expect(await reservedOf(control.core, p.project.organizationId)).toBe(ESTIMATE_MICROS);
  });

  it("admits no more concurrent calls than the budget holds, and reserves no more than the budget", async () => {
    const p = await readyProject(control, { credits: 50 });
    await stopBudget(p, BUDGET);
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => admitAi(p.context, call(p))),
    );
    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.admitted)).toEqual(
      Array.from({ length: 11 }, () => ({ admitted: false, denial: "project_budget_exceeded" })),
    );
    expect(await reservedOf(control.core, p.project.organizationId)).toBe(ESTIMATE_MICROS);
    expect(await openReservations(control.core, p.project.organizationId)).toHaveLength(1);
  });
});
