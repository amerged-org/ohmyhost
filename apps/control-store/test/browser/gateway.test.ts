import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admitBrowser,
  authorizeBrowserKey,
  releaseBrowser,
  settleBrowser,
  sweepBrowser,
} from "../../src/catalog/browser/index.js";
import { setProjectBudget } from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { sourceFrameworkPlan, seedDeploymentPlan } from "../support/provider-fixtures.js";
import { seedOperation } from "../support/accepted-operation.js";
import { newUlid } from "../../src/catalog/common.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { newOrganization } from "../credit/support.js";
import {
  balanceOf,
  context,
  digestOf,
  installKey,
  makePaid,
  nowIso,
  publishPlan,
  reservedOf,
} from "../ai/support.js";
import { groupUsageDays } from "../../../control-api/src/d1-credits.js";
import { BROWSER_KEY_NAME, createBrowserKey } from "@ohmyhost/platform/shared";
import type { CatalogContext } from "../../src/catalog/common.js";

let control: TestControl;
let sequence = 0;
const id = () => ulidOf("browser-test", ++sequence);
beforeAll(async () => {
  control = await createTestControl();
  const at = "2026-01-01T00:00:00.000000Z";
  const rates = JSON.stringify([
    {
      meter: "browser.duration",
      unit: "millisecond",
      units_per_charge: "1000",
      provider_cost_micros: "25",
      credit_micros: "5000",
    },
  ]);
  await control.core
    .prepare(
      "INSERT INTO published_credit_rate_cards(rate_card_id,published_at,effective_from,rates) VALUES (?1,?2,?2,?3)",
    )
    .bind("browser-test-card", at, rates)
    .run();
  await control.core
    .prepare(
      "INSERT INTO usage_meter_activations(meter,rate_card_id,starts_at,activated_at) VALUES ('browser.duration',?1,?2,?2)",
    )
    .bind("browser-test-card", at)
    .run();
}, 120_000);
afterAll(async () => control.dispose());
async function project(paid = true) {
  const p = await newOrganization(control),
    key = createBrowserKey(p.projectId, "a".repeat(43));
  await installKey(control.core, p, p.devEnvironmentId, key, BROWSER_KEY_NAME);
  await publishPlan(p, p.devEnvironmentId, {
    ...sourceFrameworkPlan(false),
    browser: { enabled: true },
  });
  if (paid) await makePaid(control.core, p.organizationId, 5);
  const ctx = context(control);
  const scope = await authorizeBrowserKey(ctx, {
    projectId: p.projectId,
    keySha256: digestOf(key),
  });
  if (scope === null) throw new Error("browser key fixture is not authorized");
  return { p, key, scope, ctx };
}
async function replaceHead(
  project: Awaited<ReturnType<typeof newOrganization>>,
  frameworkPlan: unknown,
): Promise<void> {
  const environmentId = project.devEnvironmentId,
    db = project.shard;
  const head = await db
    .prepare(
      `SELECT r.build_execution_id,r.artifact_id,r.wfp_receipt_id FROM environments e JOIN deployment_revisions r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.revision_id=e.active_revision_id WHERE e.organization_id=?1 AND e.environment_id=?2`,
    )
    .bind(project.organizationId, environmentId)
    .first<{ build_execution_id: string; artifact_id: string; wfp_receipt_id: string }>();
  if (head === null) throw new Error("missing current revision");
  const planId = newUlid(),
    deploymentId = newUlid(),
    revisionId = newUlid(),
    operationId = await seedOperation(project);
  await seedDeploymentPlan(project, planId, frameworkPlan, environmentId);
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    db
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_revision_id,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','succeeded',?6,1,'2026-10-28T12:00:00.000000Z','2026-10-28T12:00:00.000000Z')",
      )
      .bind(
        project.organizationId,
        deploymentId,
        project.projectId,
        environmentId,
        operationId,
        revisionId,
      ),
    db
      .prepare(
        "INSERT INTO deployment_revisions(organization_id,revision_id,project_id,deployment_id,plan_id,build_execution_id,artifact_id,wfp_receipt_id,operation_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'2026-10-28T12:00:00.000000Z')",
      )
      .bind(
        project.organizationId,
        revisionId,
        project.projectId,
        deploymentId,
        planId,
        head.build_execution_id,
        head.artifact_id,
        head.wfp_receipt_id,
        operationId,
      ),
    db
      .prepare(
        "UPDATE environments SET active_deployment_id=?3,active_revision_id=?4,head_version=head_version+1 WHERE organization_id=?1 AND environment_id=?2",
      )
      .bind(project.organizationId, environmentId, deploymentId, revisionId),
  ]);
}

/** Interleave a real D1 write immediately before the hold transaction, after all admission reads. */
function beforeAdmissionBatch(
  ctx: CatalogContext,
  mutate: () => Promise<void>,
  clockOverride?: string,
): CatalogContext {
  const base = ctx.router;
  return {
    directory: ctx.directory,
    router: {
      assertLayout: () => base.assertLayout(),
      invalidate: () => base.invalidate(),
      routeBucket: (bucket) => base.routeBucket(bucket),
      routeShard: (shard) => base.routeShard(shard),
      async routeOrganization(organizationId) {
        const route = await base.routeOrganization(organizationId);
        return {
          ...route,
          db: {
            prepare: (sql) => {
              const actual = route.db.prepare(sql);
              if (
                clockOverride === undefined ||
                !sql.startsWith("SELECT(strftime('%Y-%m-%dT%H:%M:%f','now')")
              )
                return actual;
              return {
                bind: (...values) => actual.bind(...values),
                first: async <Row>() => ({ now: clockOverride }) as Row,
                all: <Row>() => actual.all<Row>(),
                run: () => actual.run(),
              };
            },
            async batch(statements) {
              await mutate();
              return route.db.batch(statements);
            },
          },
        };
      },
    },
  };
}
describe("browser gateway Core", () => {
  it("authenticates the current enabled environment, requires Paid, enforces budget and scopes keys", async () => {
    const free = await project(false);
    expect(
      await authorizeBrowserKey(free.ctx, {
        projectId: free.p.projectId,
        keySha256: digestOf(free.key),
      }),
    ).toEqual(free.scope);
    expect(
      await authorizeBrowserKey(free.ctx, {
        projectId: free.p.projectId,
        keySha256: digestOf("wrong"),
      }),
    ).toBeNull();
    expect(await admitBrowser(free.ctx, { scope: free.scope, reservationId: id() })).toEqual({
      admitted: false,
      denial: "paid_plan_required",
    });
    expect(
      await admitBrowser(free.ctx, {
        scope: { ...free.scope, environmentId: free.p.prodEnvironmentId },
        reservationId: id(),
      }),
    ).toEqual({ admitted: false, denial: "unavailable" });
    const paid = await project();
    await control.core.batch(
      setProjectBudget(control.core, {
        organizationId: paid.p.organizationId,
        projectId: paid.p.projectId,
        budgetMicros: 100_000,
        mode: "stop",
        now: nowIso(),
      }).statements,
    );
    expect(await admitBrowser(paid.ctx, { scope: paid.scope, reservationId: id() })).toEqual({
      admitted: false,
      denial: "project_budget_exceeded",
    });
    const capped = await project();
    const openCalls: string[] = [];
    for (let index = 0; index < 8; index++) {
      const reservationId = id();
      openCalls.push(reservationId);
      expect(await admitBrowser(capped.ctx, { scope: capped.scope, reservationId })).toMatchObject({
        admitted: true,
      });
    }
    expect(await admitBrowser(capped.ctx, { scope: capped.scope, reservationId: id() })).toEqual({
      admitted: false,
      denial: "too_many_open_calls",
    });
    for (const reservationId of openCalls)
      await releaseBrowser(capped.ctx, {
        scope: {
          organizationId: capped.scope.organizationId,
          projectId: capped.scope.projectId,
          environmentId: capped.scope.environmentId,
        },
        reservationId,
        reason: "client_aborted",
      });
    const monthCandidate = await project();
    const currentTime = new Date();
    const previousMonth = new Date(
      Date.UTC(currentTime.getUTCFullYear(), currentTime.getUTCMonth(), 0, 23, 59, 59),
    )
      .toISOString()
      .replace(".000Z", ".000000Z");
    let checkedMonthFence = false;
    const rollover = beforeAdmissionBatch(
      monthCandidate.ctx,
      async () => {
        checkedMonthFence = true;
      },
      previousMonth,
    );
    expect(
      await admitBrowser(rollover, { scope: monthCandidate.scope, reservationId: id() }),
    ).toEqual({ admitted: false, denial: "unavailable" });
    expect(checkedMonthFence).toBe(true);
    expect(await reservedOf(control.core, monthCandidate.p.organizationId)).toBe(0);
    for (const change of [
      "key",
      "keyRevision",
      "revision",
      "disabled",
      "owner",
      "ownershipVersion",
      "deletion",
      "paid",
    ] as const) {
      const candidate = await project(),
        reservationId = id();
      let interleaved = false;
      const race = beforeAdmissionBatch(candidate.ctx, async () => {
        interleaved = true;
        if (change === "key")
          await control.core
            .prepare(
              "UPDATE environment_secrets SET value_sha256=unhex(?4),revision=revision+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='OHMYHOST_BROWSER_KEY'",
            )
            .bind(
              candidate.p.organizationId,
              candidate.p.projectId,
              candidate.p.devEnvironmentId,
              "aa".repeat(32),
            )
            .run();
        if (change === "keyRevision")
          await control.core
            .prepare(
              "UPDATE environment_secrets SET revision=revision+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='OHMYHOST_BROWSER_KEY'",
            )
            .bind(candidate.p.organizationId, candidate.p.projectId, candidate.p.devEnvironmentId)
            .run();
        if (change === "ownershipVersion")
          await control.core
            .prepare(
              "UPDATE projects SET ownership_version=ownership_version+1 WHERE organization_id=?1 AND project_id=?2",
            )
            .bind(candidate.p.organizationId, candidate.p.projectId)
            .run();
        if (change === "revision" || change === "disabled")
          await replaceHead(
            candidate.p,
            change === "disabled"
              ? sourceFrameworkPlan(false)
              : { ...sourceFrameworkPlan(false), browser: { enabled: true } },
          );
        if (change === "owner")
          await control.core
            .prepare(
              "UPDATE projects SET owner_state='transfer_pending_frozen' WHERE organization_id=?1 AND project_id=?2",
            )
            .bind(candidate.p.organizationId, candidate.p.projectId)
            .run();
        if (change === "deletion")
          await control.core
            .prepare(
              "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=?1 AND project_id=?2",
            )
            .bind(candidate.p.organizationId, candidate.p.projectId)
            .run();
        if (change === "paid")
          await control.core
            .prepare(
              "UPDATE credit_account SET paid_until=NULL,paid_source=NULL WHERE organization_id=?1",
            )
            .bind(candidate.p.organizationId)
            .run();
      });
      expect(await admitBrowser(race, { scope: candidate.scope, reservationId }), change).toEqual({
        admitted: false,
        denial: "unavailable",
      });
      expect(interleaved, change).toBe(true);
      expect(await reservedOf(control.core, candidate.p.organizationId), change).toBe(0);
      expect(
        await control.core
          .prepare("SELECT 1 FROM browser_gateway_reservations WHERE reservation_id=?1")
          .bind(reservationId)
          .first(),
        change,
      ).toBeNull();
    }
  });
  it("holds the 30-second cost, settles measured time once, and marks missing measurement without charging", async () => {
    const p = await project(),
      reservationId = id(),
      before = await balanceOf(control.core, p.p.organizationId);
    expect(await admitBrowser(p.ctx, { scope: p.scope, reservationId })).toEqual({
      admitted: true,
      reservedMicros: 150_000,
    });
    expect(await admitBrowser(p.ctx, { scope: p.scope, reservationId })).toEqual({
      admitted: true,
      reservedMicros: 150_000,
    });
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.p.prodEnvironmentId,
        },
        reservationId,
        browserMs: "100",
      }),
    ).toEqual({ settled: false, reason: "unknown_reservation" });
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId,
        browserMs: "100",
      }),
    ).toEqual({
      settled: true,
      chargedMicros: 500,
    });
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId,
        browserMs: "100",
      }),
    ).toEqual({
      settled: false,
      reason: "already_resolved",
    });
    expect(await balanceOf(control.core, p.p.organizationId)).toBe(before - 500);
    const fractional = id();
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: fractional });
    const billingScope = {
      organizationId: p.scope.organizationId,
      projectId: p.scope.projectId,
      environmentId: p.scope.environmentId,
    };
    expect(
      await settleBrowser(p.ctx, {
        scope: billingScope,
        reservationId: fractional,
        browserMs: "1393.57373046875",
      }),
    ).toEqual({ settled: true, chargedMicros: 6968 });
    const fractionalRow = await control.core
      .prepare("SELECT at,kind,delta_micros,detail FROM credit_log WHERE key=?1")
      .bind(`settle:${fractional}`)
      .first<{ at: string; kind: string; delta_micros: number; detail: string }>();
    if (!fractionalRow) throw new Error("missing fractional settlement");
    const days = groupUsageDays([
      {
        organizationId: p.p.organizationId,
        at: fractionalRow.at,
        kind: fractionalRow.kind,
        deltaMicros: fractionalRow.delta_micros,
        detail: JSON.parse(fractionalRow.detail),
      },
    ]);
    expect(days[0]?.projects[0]?.meters[0]).toMatchObject({
      quantity: "1393.57373046875",
      charged_micros: "6968",
    });
    const precise = id();
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: precise });
    expect(
      await settleBrowser(p.ctx, {
        scope: billingScope,
        reservationId: precise,
        browserMs: "0.12345678901234567891",
      }),
    ).toEqual({ settled: true, chargedMicros: 1 });
    const preciseRow = await control.core
      .prepare("SELECT at,kind,delta_micros,detail FROM credit_log WHERE key=?1")
      .bind(`settle:${precise}`)
      .first<{ at: string; kind: string; delta_micros: number; detail: string }>();
    if (!preciseRow) throw new Error("missing exact settlement");
    expect(
      groupUsageDays([
        {
          organizationId: p.p.organizationId,
          at: preciseRow.at,
          kind: preciseRow.kind,
          deltaMicros: preciseRow.delta_micros,
          detail: JSON.parse(preciseRow.detail),
        },
      ])[0]?.projects[0]?.meters[0],
    ).toMatchObject({ quantity: "0.12345678901234567891", charged_micros: "1" });
    const missing = id();
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: missing });
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: missing,
        browserMs: null,
      }),
    ).toEqual({ settled: true, chargedMicros: 0 });
    expect(await reservedOf(control.core, p.p.organizationId)).toBe(0);
    const row = await control.core
      .prepare("SELECT detail FROM credit_log WHERE key=?1")
      .bind(`settle:${missing}`)
      .first<{ detail: string }>();
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({
      meter: "browser.duration",
      quantity: "0",
      browserMs: null,
      measurement: "missing",
    });
  });
  it("releases a hold and settles once after a swept orphan", async () => {
    const p = await project(),
      released = id();
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: released });
    expect(
      await releaseBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: released,
        reason: "provider_error",
      }),
    ).toEqual({ released: true });
    expect(
      await releaseBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: released,
        reason: "provider_error",
      }),
    ).toEqual({ released: false });
    const swept = id(),
      open = id();
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: swept });
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: open });
    const future = new Date(Date.now() + 120_000).toISOString().replace("Z", "000Z");
    const originalDirectory = p.ctx.directory;
    const sweepDirectory = {
      ...originalDirectory,
      prepare(sql: string) {
        const actual = originalDirectory.prepare(sql);
        return sql.startsWith("SELECT(strftime('%Y-%m-%dT%H:%M:%f','now')")
          ? {
              bind: (...values: unknown[]) => actual.bind(...values),
              first: async <Row>() => ({ now: future }) as Row,
              all: <Row>() => actual.all<Row>(),
              run: () => actual.run(),
            }
          : actual;
      },
      batch: (statements: Parameters<typeof originalDirectory.batch>[0]) =>
        originalDirectory.batch(statements),
    };
    // The earlier reservation is swept first; the second stays open across the price change.
    expect(
      await sweepBrowser(
        { ...p.ctx, directory: sweepDirectory },
        { olderThanMs: 60_000, limit: 1 },
      ),
    ).toMatchObject({ released: 1 });
    const queryPlan = await control.core
      .prepare(
        "EXPLAIN QUERY PLAN SELECT reservation_id FROM browser_gateway_reservations WHERE state='open' AND created_at<?1 ORDER BY created_at,reservation_id LIMIT 20",
      )
      .bind(future)
      .all<{ detail: string }>();
    expect(queryPlan.results.some((row) => row.detail.includes("browser_gateway_open_age"))).toBe(
      true,
    );
    const admissionPlan = await control.core
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM browser_gateway_reservations WHERE organization_id=?1 AND state='open'",
      )
      .bind(p.p.organizationId)
      .all<{ detail: string }>();
    expect(
      admissionPlan.results.some((row) => row.detail.includes("browser_gateway_open_org")),
    ).toBe(true);
    // Rotation of the old credit log must not erase the swept state or its pinned price.
    await control.core
      .prepare("DELETE FROM credit_log WHERE key=?1")
      .bind(`release:${swept}`)
      .run();
    const changedAt = "2026-01-02T00:00:00.000000Z";
    const higherRate = JSON.stringify([
      {
        meter: "browser.duration",
        unit: "millisecond",
        units_per_charge: "1000",
        provider_cost_micros: "50",
        credit_micros: "10000",
      },
    ]);
    await control.core
      .prepare(
        "INSERT INTO published_credit_rate_cards(rate_card_id,published_at,effective_from,rates) VALUES (?1,?2,?2,?3)",
      )
      .bind("browser-price-changed", changedAt, higherRate)
      .run();
    await control.core
      .prepare(
        "INSERT INTO usage_meter_activations(meter,rate_card_id,starts_at,activated_at) VALUES ('browser.duration',?1,?2,?2)",
      )
      .bind("browser-price-changed", changedAt)
      .run();
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: swept,
        browserMs: "100",
      }),
    ).toEqual({ settled: true, chargedMicros: 500 });
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: open,
        browserMs: "100",
      }),
    ).toEqual({ settled: true, chargedMicros: 500 });
    await control.core.prepare("DELETE FROM credit_log WHERE key=?1").bind(`settle:${swept}`).run();
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: swept,
        browserMs: "100",
      }),
    ).toEqual({ settled: false, reason: "already_resolved" });
    const concurrent = id();
    await admitBrowser(p.ctx, { scope: p.scope, reservationId: concurrent });
    const outcomes = await Promise.all([
      settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: concurrent,
        browserMs: "50",
      }),
      settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: concurrent,
        browserMs: "50",
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.settled)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.settled)).toHaveLength(1);
    const current = id();
    expect(await admitBrowser(p.ctx, { scope: p.scope, reservationId: current })).toEqual({
      admitted: true,
      reservedMicros: 300_000,
    });
    expect(
      await settleBrowser(p.ctx, {
        scope: {
          organizationId: p.scope.organizationId,
          projectId: p.scope.projectId,
          environmentId: p.scope.environmentId,
        },
        reservationId: current,
        browserMs: "100",
      }),
    ).toEqual({ settled: true, chargedMicros: 1000 });
    const raced = id(),
      nextAt = "2026-01-03T00:00:00.000000Z";
    const racing = beforeAdmissionBatch(p.ctx, async () => {
      const next = JSON.stringify([
        {
          meter: "browser.duration",
          unit: "millisecond",
          units_per_charge: "1000",
          provider_cost_micros: "75",
          credit_micros: "15000",
        },
      ]);
      await control.core
        .prepare(
          "INSERT INTO published_credit_rate_cards(rate_card_id,published_at,effective_from,rates) VALUES (?1,?2,?2,?3)",
        )
        .bind("browser-price-raced", nextAt, next)
        .run();
      await control.core
        .prepare(
          "INSERT INTO usage_meter_activations(meter,rate_card_id,starts_at,activated_at) VALUES ('browser.duration',?1,?2,?2)",
        )
        .bind("browser-price-raced", nextAt)
        .run();
    });
    expect(await admitBrowser(racing, { scope: p.scope, reservationId: raced })).toEqual({
      admitted: false,
      denial: "unavailable",
    });
    expect(
      await control.core
        .prepare("SELECT 1 FROM browser_gateway_reservations WHERE reservation_id=?1")
        .bind(raced)
        .first(),
    ).toBeNull();
    const invalidAt = "2026-01-04T00:00:00.000000Z";
    const invalid = JSON.stringify([
      {
        meter: "browser.duration",
        unit: "millisecond",
        units_per_charge: "1000",
        provider_cost_micros: null,
        credit_micros: "5000",
      },
    ]);
    await control.core
      .prepare(
        "INSERT INTO published_credit_rate_cards(rate_card_id,published_at,effective_from,rates) VALUES (?1,?2,?2,?3)",
      )
      .bind("browser-price-invalid", invalidAt, invalid)
      .run();
    await control.core
      .prepare(
        "INSERT INTO usage_meter_activations(meter,rate_card_id,starts_at,activated_at) VALUES ('browser.duration',?1,?2,?2)",
      )
      .bind("browser-price-invalid", invalidAt)
      .run();
    expect(await admitBrowser(p.ctx, { scope: p.scope, reservationId: id() })).toEqual({
      admitted: false,
      denial: "unavailable",
    });
  });
});
