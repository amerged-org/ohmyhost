import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi, releaseAi, settleAi, sweepAi } from "../../src/catalog/ai/index.js";
import { runReserve } from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_NANO,
  balanceOf,
  markAiReservation,
  openReservations,
  publishAiCard,
  readyProject,
  reservedOf,
  type AiProject,
} from "./support.js";

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-release", (sequence += 1));
/** A reservation written long before the Core clock: its reserve row is what the sweep reads. */
const OLD = "2026-01-01T00:00:00.000000Z";

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

/** An AI reservation as the gateway would have written it long ago (`kind: "ai"` in its reserve row). */
async function oldAiReservation(p: AiProject): Promise<string> {
  const id = reservationId();
  const outcome = await runReserve(control.core, {
    organizationId: p.project.organizationId,
    reservationId: id,
    projectId: p.project.projectId,
    amountMicros: 13_909,
    now: OLD,
    detail: { kind: "ai", model: "claude-haiku-5-5", environmentId: p.project.devEnvironmentId },
  });
  expect(outcome).toMatchObject({ reserved: true });
  await markAiReservation(
    control.core,
    {
      organizationId: p.project.organizationId,
      projectId: p.project.projectId,
      environmentId: p.project.devEnvironmentId,
    },
    id,
    OLD,
  );
  return id;
}

describe("releasing an AI reservation", () => {
  it("gives the reserved credit back and leaves the balance as it was", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const before = await balanceOf(control.core, org);
    const id = await admitted(p);
    expect(await reservedOf(control.core, org)).toBe(13_909);

    expect(
      await releaseAi(p.context, { scope: p.scope, reservationId: id, reason: "upstream_error" }),
    ).toEqual({ released: true });
    expect(await reservedOf(control.core, org)).toBe(0);
    expect(await balanceOf(control.core, org)).toBe(before);
    expect(await openReservations(control.core, org)).toEqual([]);
    const logged = await control.core
      .prepare("SELECT kind, delta_micros, detail FROM credit_log WHERE key = ?1")
      .bind(`release:${id}`)
      .first<{ kind: string; delta_micros: number; detail: string }>();
    expect(logged).toMatchObject({ kind: "release", delta_micros: 0 });
    expect(JSON.parse(logged?.detail ?? "{}")).toMatchObject({
      kind: "ai",
      reason: "upstream_error",
      releasedMicros: 13_909,
    });
  });

  it("answers released false for a second release, a released-then-settled id and another tenant's id", async () => {
    const p = await readyProject(control, { credits: 50 });
    const other = await readyProject(control, { credits: 50 });
    const id = await admitted(p);
    const org = p.project.organizationId;
    expect(
      await releaseAi(other.context, {
        scope: other.scope,
        reservationId: id,
        reason: "client_aborted",
      }),
    ).toEqual({ released: false });
    expect(
      await releaseAi(p.context, {
        scope: { ...p.scope, environmentId: p.project.prodEnvironmentId },
        reservationId: id,
        reason: "client_aborted",
      }),
    ).toEqual({ released: false });
    expect(await openReservations(control.core, org)).toEqual([id]);
    expect(
      await releaseAi(p.context, { scope: p.scope, reservationId: id, reason: "client_aborted" }),
    ).toEqual({ released: true });
    expect(
      await releaseAi(p.context, { scope: p.scope, reservationId: id, reason: "client_aborted" }),
    ).toEqual({ released: false });
    expect(
      await settleAi(p.context, {
        scope: p.scope,
        reservationId: id,
        model: "claude-haiku-5-5",
        costNanoUsd: 3_600n,
        usage: {},
        traceId: null,
      }),
    ).toEqual({ settled: false, reason: "already_resolved" });
  });

  it("refuses a reason outside the closed list", async () => {
    const p = await readyProject(control, { credits: 50 });
    await expect(
      releaseAi(p.context, {
        scope: p.scope,
        reservationId: reservationId(),
        reason: "because" as "upstream_error",
      }),
    ).rejects.toThrow("Invalid AI gateway input");
  });
});

describe("sweeping AI reservations that were never resolved", () => {
  it("releases the old AI reservations only, and leaves a build reservation and a fresh call alone", async () => {
    const p = await readyProject(control, { credits: 50 });
    const org = p.project.organizationId;
    const old = await oldAiReservation(p);
    const build = reservationId();
    await runReserve(control.core, {
      organizationId: org,
      reservationId: build,
      projectId: p.project.projectId,
      amountMicros: 5_000_000,
      now: OLD,
      detail: { operationId: "build-1" },
    });
    const fresh = await admitted(p);

    expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 })).toEqual({
      released: 1,
      skipped: 0,
    });
    expect(await openReservations(control.core, org)).toEqual([build, fresh].sort());
    expect(await openReservations(control.core, org)).not.toContain(old);
    expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 })).toEqual({
      released: 0,
      skipped: 0,
    });
  });

  it("releases at most the limit per run", async () => {
    const p = await readyProject(control, { credits: 50 });
    const first = await oldAiReservation(p);
    const second = await oldAiReservation(p);
    expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 1 })).toEqual({
      released: 1,
      skipped: 0,
    });
    const remaining = await openReservations(control.core, p.project.organizationId);
    expect(remaining).toHaveLength(1);
    expect([first, second]).toContain(remaining[0]);
    expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 5 })).toEqual({
      released: 1,
      skipped: 0,
    });
  });

  it("refuses a cutoff below one minute and a limit above the page", async () => {
    const p = await readyProject(control, { credits: 50 });
    await expect(sweepAi(p.context, { olderThanMs: 1000, limit: 1 })).rejects.toThrow(
      "Invalid AI gateway input",
    );
    await expect(sweepAi(p.context, { olderThanMs: 900_000, limit: 1001 })).rejects.toThrow(
      "Invalid AI gateway input",
    );
  });
});
