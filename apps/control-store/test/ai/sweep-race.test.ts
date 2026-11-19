import { afterAll, beforeAll, expect, it } from "vitest";

import { admitAi, releaseAi, settleAi, sweepAi } from "../../src/catalog/ai/index.js";
import { runReserve } from "../../src/catalog/credit/index.js";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import {
  ESTIMATE_NANO,
  LIVE_CHARGE_MICROS,
  LIVE_COST_NANO,
  balanceOf,
  context,
  markAiReservation,
  openReservations,
  publishAiCard,
  readyProject,
} from "./support.js";

/*
 * A reservation that resolves between the sweep's read of the candidates and its release is counted as skipped, and
 * nothing else is changed. The race is a real interleaved release: the wrapper forwards every statement to the real
 * D1 database and runs the release right after the candidate read.
 */

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
  await publishAiCard(control.core);
}, 120_000);
afterAll(async () => control.dispose());

/** The database with one hook that runs once, right after the first read whose SQL matches. */
function interleaved(
  db: D1Database,
  matches: (sql: string) => boolean,
  hook: () => Promise<void>,
): D1Database {
  let pending = true;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      first: async (...args: []) => {
        const result = await statement.first(...args);
        if (pending && matches(sql)) {
          pending = false;
          await hook();
        }
        return result;
      },
      run: () => statement.run(),
      all: async () => {
        const result = await statement.all();
        if (pending && matches(sql)) {
          pending = false;
          await hook();
        }
        return result;
      },
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, statement);
    sqlOf.set(wrapped, sql);
    return wrapped;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await db.batch(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      if (pending && statements.some((statement) => matches(sqlOf.get(statement) ?? ""))) {
        pending = false;
        await hook();
      }
      return results;
    },
  } as unknown as D1Database;
}

it("counts a reservation that resolves while the sweep runs as skipped, and releases nothing else", async () => {
  const p = await readyProject(control, { credits: 50 });
  const org = p.project.organizationId;
  const id = ulidOf("sweep-race", 1);
  await runReserve(control.core, {
    organizationId: org,
    reservationId: id,
    projectId: p.project.projectId,
    amountMicros: 13_909,
    now: "2026-01-01T00:00:00.000000Z",
    detail: { kind: "ai", model: "claude-haiku-5-5", environmentId: p.project.devEnvironmentId },
  });
  await markAiReservation(
    control.core,
    {
      organizationId: org,
      projectId: p.project.projectId,
      environmentId: p.project.devEnvironmentId,
    },
    id,
    "2026-01-01T00:00:00.000000Z",
  );
  const racing = {
    directory: interleaved(
      control.core,
      (sql) => sql.includes("FROM credit_reservation r"),
      async () => {
        await releaseAi(context(control), {
          scope: p.scope,
          reservationId: id,
          reason: "client_aborted",
        });
      },
    ),
    router: new SharedCoreRouter(control.core),
  };
  expect(await sweepAi(racing, { olderThanMs: 900_000, limit: 100 })).toEqual({
    released: 0,
    skipped: 1,
  });
  expect(await openReservations(control.core, org)).toEqual([]);
});

it("charges a delivered call once when the sweep releases it after settlement reads the open reservation", async () => {
  const p = await readyProject(control, { credits: 50 });
  const id = ulidOf("settle-sweep-race", 1);
  expect(
    await admitAi(p.context, {
      scope: p.scope,
      reservationId: id,
      model: "claude-haiku-5-5",
      estimateNanoUsd: ESTIMATE_NANO,
    }),
  ).toMatchObject({ admitted: true });
  await control.core
    .prepare(
      "UPDATE credit_reservation SET created_at = '2026-01-01T00:00:00.000000Z' WHERE reservation_id = ?1",
    )
    .bind(id)
    .run();
  const before = await balanceOf(control.core, p.project.organizationId);
  let swept = false;
  const racing = {
    directory: control.core,
    router: new SharedCoreRouter(
      interleaved(
        control.core,
        (sql) => sql.includes("FROM credit_reservation") && sql.includes("project_id"),
        async () => {
          swept = true;
          expect(await sweepAi(p.context, { olderThanMs: 900_000, limit: 100 })).toEqual({
            released: 1,
            skipped: 0,
          });
        },
      ),
    ),
  };
  const input = {
    scope: p.scope,
    reservationId: id,
    model: "claude-haiku-5-5",
    costNanoUsd: LIVE_COST_NANO,
    usage: {},
    traceId: null,
  };
  expect(await settleAi(racing, input)).toEqual({
    settled: true,
    chargedMicros: LIVE_CHARGE_MICROS,
  });
  expect(swept).toBe(true);
  expect(await balanceOf(control.core, p.project.organizationId)).toBe(before - LIVE_CHARGE_MICROS);
  expect(await settleAi(p.context, input)).toEqual({ settled: false, reason: "already_resolved" });
});
