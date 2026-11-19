import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi, settleAi } from "../../src/catalog/ai/index.js";
import { runReserve } from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { markAiReservation, openReservations, readyProject } from "./support.js";

/*
 * The price of the AI meter is an operator activation. Activations are immutable, so this database never gets one: a call
 * is `unavailable` before anything is reserved, and a reservation that is still open cannot be settled at an unpriced
 * cost; it stays open for the sweep.
 */

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

describe("an AI meter without an active card", () => {
  it("refuses every call as unavailable before anything is reserved", async () => {
    const p = await readyProject(control, { credits: 50 });
    expect(
      await admitAi(p.context, {
        scope: p.scope,
        reservationId: ulidOf("unpriced", 1),
        model: "claude-haiku-5-5",
        estimateNanoUsd: 3_600n,
      }),
    ).toEqual({ admitted: false, denial: "unavailable" });
    expect(await openReservations(control.core, p.project.organizationId)).toEqual([]);
  });

  it("refuses to settle an open reservation at an unpriced cost, and leaves it open", async () => {
    const p = await readyProject(control, { credits: 50 });
    const id = ulidOf("unpriced", 2);
    await runReserve(control.core, {
      organizationId: p.project.organizationId,
      reservationId: id,
      projectId: p.project.projectId,
      amountMicros: 501,
      now: "2026-01-01T00:00:00.000000Z",
      detail: { kind: "ai", model: "claude-haiku-5-5", environmentId: p.project.devEnvironmentId },
    });
    await markAiReservation(control.core, p.scope, id, "2026-01-01T00:00:00.000000Z");
    await expect(
      settleAi(p.context, {
        scope: p.scope,
        reservationId: id,
        model: "claude-haiku-5-5",
        costNanoUsd: 3_600n,
        usage: {},
        traceId: null,
      }),
    ).rejects.toMatchObject({ code: "ai_price_unavailable" });
    expect(await openReservations(control.core, p.project.organizationId)).toEqual([id]);
  });
});
