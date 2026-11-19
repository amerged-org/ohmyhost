import { afterAll, beforeAll, expect, it } from "vitest";

import { AI_MAX_OPEN_CALLS } from "@ohmyhost/platform/shared";

import { openCallsGuard } from "../../src/catalog/ai/admit.js";
import { admitAi, settleAi, sweepAi } from "../../src/catalog/ai/index.js";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_NANO,
  LIVE_COST_NANO,
  openReservations,
  publishAiCard,
  readyProject,
  type AiProject,
} from "./support.js";

/*
 * The sweep finds an AI reservation by its own marker, not by the credit log: the log rotates every night and a
 * reservation still open at rotation must stay sweepable.
 */

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
  await publishAiCard(control.core);
}, 120_000);
afterAll(async () => control.dispose());

it("sweeps an AI reservation whose reserve row the credit log no longer holds", async () => {
  const p = await readyProject(control, { credits: 50 });
  const org = p.project.organizationId;
  const id = ulidOf("sweep-marker", 1);
  expect(
    await admitAi(p.context, {
      scope: p.scope,
      reservationId: id,
      model: "claude-haiku-5-5",
      estimateNanoUsd: ESTIMATE_NANO,
    }),
  ).toMatchObject({ admitted: true });
  // the nightly rotation removed the reserve row, and the reservation is an hour old
  await control.core.prepare("DELETE FROM credit_log WHERE key = 'reserve:' || ?1").bind(id).run();
  await control.core
    .prepare(
      "UPDATE credit_reservation SET created_at = '2026-01-01T00:00:00.000000Z' WHERE reservation_id = ?1",
    )
    .bind(id)
    .run();
  expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 })).toEqual({
    released: 1,
    skipped: 0,
  });
  expect(await openReservations(control.core, org)).toEqual([]);
});

const markerCount = async (control: TestControl, organizationId: string): Promise<number> =>
  (
    await control.core
      .prepare("SELECT count(*) AS n FROM ai_gateway_reservations WHERE organization_id = ?1")
      .bind(organizationId)
      .first<{ n: number }>()
  )?.n ?? -1;

/** One call admitted and settled through the gateway, which leaves its marker behind for the sweep. */
async function settledCall(p: AiProject, id: string): Promise<void> {
  expect(
    await admitAi(p.context, {
      scope: p.scope,
      reservationId: id,
      model: "claude-haiku-5-5",
      estimateNanoUsd: ESTIMATE_NANO,
    }),
  ).toMatchObject({ admitted: true });
  expect(
    await settleAi(p.context, {
      scope: p.scope,
      reservationId: id,
      model: "claude-haiku-5-5",
      costNanoUsd: LIVE_COST_NANO,
      usage: {},
      traceId: null,
    }),
  ).toMatchObject({ settled: true });
}

it("leaves the marker of a call that settles through the gateway, which the sweep removes", async () => {
  const p = await readyProject(control, { credits: 50 });
  const org = p.project.organizationId;
  await settledCall(p, ulidOf("sweep-marker-settled-once", 1));
  expect(await markerCount(control, org)).toBe(1);
  expect(await openReservations(control.core, org)).toEqual([]);
  expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 })).toEqual({
    released: 0,
    skipped: 0,
  });
  expect(await markerCount(control, org)).toBe(0);
});

it("removes the markers of settled calls in one sweep, so they never outpace the sweep", async () => {
  const p = await readyProject(control, { credits: 500 });
  const org = p.project.organizationId;
  // Three hundred settled calls: each leaves a marker that only the sweep removes.
  await seedSettledMarkers(p, "sweep-marker-settled", 300);
  expect(await markerCount(control, org)).toBe(300);
  expect(await openReservations(control.core, org)).toEqual([]);
  expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 200 })).toEqual({
    released: 0,
    skipped: 0,
  });
  expect(await markerCount(control, org)).toBe(0);
});

/**
 * The markers of `count` settled calls, written in one batch: a settled call keeps its marker and has no open
 * reservation, which is exactly the state the sweep removes.
 */
async function seedSettledMarkers(p: AiProject, label: string, count: number): Promise<void> {
  await control.core.batch(
    Array.from({ length: count }, (_, index) =>
      control.core
        .prepare(
          "INSERT INTO ai_gateway_reservations(reservation_id, organization_id, project_id, environment_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(
          ulidOf(label, index + 1),
          p.scope.organizationId,
          p.scope.projectId,
          p.scope.environmentId,
          "2026-01-01T00:00:00.000000Z",
        ),
    ),
  );
}

/** A database whose marker cleanup fails the way a lost D1 call does; every other statement runs as it is. */
function failingMarkerCleanup(db: D1Database): D1Database {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      first: () => statement.first(),
      all: () => statement.all(),
      run: () =>
        sql.startsWith("DELETE FROM ai_gateway_reservations")
          ? Promise.reject(new Error("marker cleanup failed"))
          : statement.run(),
    }) as unknown as D1PreparedStatement;
  return { prepare: (sql: string) => wrap(db.prepare(sql), sql) } as unknown as D1Database;
}

it("removes at most twenty-five batches of resolved markers in one sweep, and the rest in the next", async () => {
  const p = await readyProject(control, { credits: 500 });
  const org = p.project.organizationId;
  // With a limit of one, one sweep removes at most twenty-five of the twenty-six markers.
  await seedSettledMarkers(p, "sweep-marker-cap", 26);
  expect(await markerCount(control, org)).toBe(26);
  expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 1 })).toEqual({
    released: 0,
    skipped: 0,
  });
  expect(await markerCount(control, org)).toBe(1);
  expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 1 })).toEqual({
    released: 0,
    skipped: 0,
  });
  expect(await markerCount(control, org)).toBe(0);
});

it("releases the reservations of a sweep even when its marker cleanup fails", async () => {
  const p = await readyProject(control, { credits: 50 });
  const org = p.project.organizationId;
  const id = ulidOf("sweep-marker-release", 1);
  expect(
    await admitAi(p.context, {
      scope: p.scope,
      reservationId: id,
      model: "claude-haiku-5-5",
      estimateNanoUsd: ESTIMATE_NANO,
    }),
  ).toMatchObject({ admitted: true });
  // the call is an hour old and never resolved: the sweep must release it
  await control.core
    .prepare(
      "UPDATE credit_reservation SET created_at = '2026-01-01T00:00:00.000000Z' WHERE reservation_id = ?1",
    )
    .bind(id)
    .run();
  const failing = {
    directory: failingMarkerCleanup(control.core),
    router: new SharedCoreRouter(control.core),
  };
  await expect(sweepAi(failing, { olderThanMs: 900_000, limit: 100 })).rejects.toThrow(
    "marker cleanup failed",
  );
  expect(await openReservations(control.core, org)).toEqual([]);
});

it("counts the open calls of an organization through an index on its markers", async () => {
  // The statement the real open-call guard prepares: a recording database keeps the SQL exactly as the builder wrote it.
  const organizationId = ulidOf("sweep-marker-plan", 1);
  let guardSql = "";
  const recording = {
    prepare: (sql: string) => {
      guardSql = sql;
      return control.core.prepare(sql);
    },
  } as unknown as D1Database;
  openCallsGuard(recording, { organizationId });
  const plan = await control.core
    .prepare(`EXPLAIN QUERY PLAN ${guardSql}`)
    .bind(organizationId, AI_MAX_OPEN_CALLS)
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail);
  expect(details.some((detail) => detail.includes("ai_gateway_reservations_organization"))).toBe(
    true,
  );
});
