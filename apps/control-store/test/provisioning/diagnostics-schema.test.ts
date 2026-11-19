import { seedProject } from "../support/platform-fixtures.js";
import type { TestControl } from "../support/control-d1.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";
import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createTestControl, migrationFiles } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { workflowFixture } from "./workflow-fixture.js";
import { recordWorkflowDiagnostic } from "../../src/catalog/provisioning/diagnostics.js";
import { purgeConsumerDiagnostics } from "../../src/catalog/diagnostics/consumer.js";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import type { D1Database } from "../../src/d1-types.js";
const columns =
  "diagnostic_event_id,organization_id,project_id,environment_id,deployment_id,source,code,catalog_message,exception_class,source_file,source_line,source_column,route_template,request_id,trace_id,duration_ms,occurred_at,recorded_at,excerpt,excerpt_truncated,status_code".split(
    ",",
  );
it("keeps all 21 diagnostic columns and the physical shape, calendar and FK rules of the original schema", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    expect(
      (
        await c.core.prepare("PRAGMA table_info(deployment_diagnostics)").all<{ name: string }>()
      ).results
        .map((v) => v.name)
        .sort(),
    ).toEqual([...columns].sort());
    const base: Record<string, unknown> = {
      diagnostic_event_id: newUlid(),
      organization_id: r.p.organizationId,
      project_id: r.p.projectId,
      environment_id: r.input.environmentId,
      deployment_id: r.deployment,
      source: "runtime",
      code: "HEALTH_CHECK_FAILED",
      catalog_message: "CUSTOMER_HEALTH_CHECK_FAILED",
      exception_class: null,
      source_file: null,
      source_line: null,
      source_column: null,
      route_template: "/",
      request_id: null,
      trace_id: null,
      duration_ms: null,
      occurred_at: "2026-10-28T11:00:00.000001Z",
      recorded_at: "2026-10-28T11:00:00.000001Z",
      excerpt: null,
      excerpt_truncated: null,
      status_code: 503,
    };
    // Each patch is applied to a valid row; the lists are the accept/reject verdicts of the original PostgreSQL schema.
    const accepted: Record<string, unknown>[] = [
      {},
      { exception_class: "TypeError" },
      { source_file: "src/file.ts", source_line: 1, source_column: 0 },
      { source_line: 1, source_column: null },
      { source_line: null, source_column: 0 },
      { request_id: "valid-request-id" },
      { request_id: "trace-😀" },
      { request_id: "x\uFEFFy" },
      { occurred_at: "2026-10-21T11:00:00.000001Z" },
      { excerpt: "healthy\noutput", excerpt_truncated: 0 },
      { excerpt: "x".repeat(16384), excerpt_truncated: 1 },
    ];
    const rejected: Record<string, unknown>[] = [
      { source: "unknown" },
      { code: "X" },
      { code: "BAD\0TRAIL" },
      { catalog_message: "bad" },
      { exception_class: "_bad" },
      { source_file: "../file.ts" },
      { source_file: "/file.ts" },
      { source_file: "a\u0085b" },
      { source_line: 2147483648, source_column: 0 },
      { request_id: "x\u2003y" },
      { request_id: "a b" },
      { request_id: "x\u00a0y" },
      { trace_id: "a/b" },
      { duration_ms: 900001 },
      { occurred_at: "2026-02-30T11:00:00.000001Z", recorded_at: "2026-03-01T11:00:00.000001Z" },
      { occurred_at: "2026-10-28T11:00:00.00000XZ" },
      { occurred_at: "2026-10-28T24:00:00.000001Z" },
      { occurred_at: "2026-10-28T1x:00:00.000001Z", recorded_at: "2026-10-28T1x:00:00.000001Z" },
      { occurred_at: "2026-10-28T11:2x:00.000001Z", recorded_at: "2026-10-28T11:2x:00.000001Z" },
      { occurred_at: "2026-10-21T11:00:00.000000Z" },
      { occurred_at: "2026-10-28T11:00:00.000002Z" },
      { excerpt: "tail ", excerpt_truncated: 0 },
      { excerpt: "tail\u00a0", excerpt_truncated: 0 },
      { excerpt: "tail\u2003", excerpt_truncated: 0 },
      { excerpt: "bad\u0001control", excerpt_truncated: 0 },
      { excerpt: "x".repeat(16385), excerpt_truncated: 1 },
      { status_code: 99 },
      { status_code: 600 },
      { code: "DEPLOYMENT_FAILED", status_code: 503 },
      { deployment_id: newUlid() },
    ];
    const accepts = async (patch: Record<string, unknown>) => {
      const row = { ...base, ...patch },
        values = columns.map((k) => row[k]);
      try {
        await c.core.batch([
          c.core
            .prepare(
              `INSERT INTO deployment_diagnostics(${columns}) VALUES(${columns.map(() => "?")})`,
            )
            .bind(...values),
          c.core
            .prepare("DELETE FROM deployment_diagnostics WHERE diagnostic_event_id=?")
            .bind(base["diagnostic_event_id"]),
        ]);
        return true;
      } catch {
        return false;
      }
    };
    for (const patch of accepted)
      expect(await accepts(patch), JSON.stringify(patch).slice(0, 120)).toBe(true);
    for (const patch of rejected)
      expect(await accepts(patch), JSON.stringify(patch).slice(0, 120)).toBe(false);
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 60_000);
it("applies the original diagnostic prerequisite atomically only to an unserved Core", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {}",
    d1Databases: ["CONTROL_CORE"],
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database,
      migration = migrationFiles("core").find((v) => v.name.startsWith("0454_"));
    if (!migration) throw new Error("Diagnostic prerequisite missing");
    for (const file of migrationFiles("core").filter((v) => v.name < "0454"))
      await db.batch(splitStatements(file.sql).map((s) => db.prepare(s)));
    await expect(
      db.batch([
        ...splitStatements(migration.sql).map((s) => db.prepare(s)),
        db.prepare("INSERT INTO guard_fail(code) VALUES('precondition_changed')"),
      ]),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT 1 FROM sqlite_schema WHERE name='deployment_diagnostics'").first(),
    ).toBeNull();
    await db.batch(splitStatements(migration.sql).map((s) => db.prepare(s)));
    const repair = migrationFiles("core").find((v) => v.name.startsWith("0457"));
    if (!repair) throw new Error("Finite diagnostic repair missing");
    const harness: TestControl = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db },
        dispose: () => mf.dispose(),
      },
      project = await seedProject(harness),
      op = newUlid(),
      deployment = newUlid(),
      diagnostic = newUlid(),
      at = "2026-10-28T11:00:00.000000Z";
    await db.batch([
      db
        .prepare(
          "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
        )
        .bind(project.organizationId, project.projectId, op, project.billingEpochId, at, at),
      db
        .prepare(
          "INSERT INTO deployments(organization_id,project_id,environment_id,deployment_id,operation_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'deploy','queued',?,?)",
        )
        .bind(
          project.organizationId,
          project.projectId,
          project.devEnvironmentId,
          deployment,
          op,
          at,
          at,
        ),
      db
        .prepare(
          "INSERT INTO deployment_diagnostics(diagnostic_event_id,organization_id,project_id,environment_id,deployment_id,source,code,catalog_message,occurred_at,recorded_at) VALUES(?,?,?,?,?,'control','DEPLOYMENT_FAILED','DEPLOYMENT_FAILED_SEE_OPERATION_ERROR',?,?)",
        )
        .bind(
          diagnostic,
          project.organizationId,
          project.projectId,
          project.devEnvironmentId,
          deployment,
          at,
          at,
        ),
    ]);
    const before = (await db.prepare("SELECT * FROM deployment_diagnostics").all()).results;
    await expect(
      db.batch([
        ...splitStatements(repair.sql).map((sql) => db.prepare(sql)),
        db.prepare("INSERT INTO guard_fail(code) VALUES('precondition_changed')"),
      ]),
    ).rejects.toThrow("guard_precondition_changed");
    expect((await db.prepare("SELECT * FROM deployment_diagnostics").all()).results).toEqual(
      before,
    );
    await db.batch(splitStatements(repair.sql).map((sql) => db.prepare(sql)));
    expect((await db.prepare("SELECT * FROM deployment_diagnostics").all()).results).toEqual(
      before,
    );
    await db
      .prepare(
        "UPDATE deployment_diagnostics SET request_id='valid-😀-request' WHERE diagnostic_event_id=?",
      )
      .bind(diagnostic)
      .run();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00.000000Z',zeroblob(32),zeroblob(32))",
      )
      .run();
    await expect(
      db.batch(splitStatements(migration.sql).map((s) => db.prepare(s))),
    ).rejects.toThrow("precondition_changed");
  } finally {
    await mf.dispose();
  }
});
it("keeps original diagnostic identity excluding recordedAt, scoped seven-day purge and10000-item cap", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c),
      ctx = { directory: c.core, router: new SharedCoreRouter(c.core) },
      at = "2026-10-28T11:00:00.000000Z";
    const i = {
      id: newUlid(),
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      deploymentId: r.deployment,
      source: "control",
      code: "DEPLOYMENT_FAILED",
      catalogMessage: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
      exceptionClass: null,
      sourceFile: null,
      sourceLine: null,
      sourceColumn: null,
      routeTemplate: null,
      requestId: null,
      traceId: null,
      durationMs: null,
      excerpt: null,
      excerptTruncated: null,
      statusCode: null,
      occurredAt: at,
      recordedAt: at,
    };
    const lost = losingWriteResponses(c.core, 1);
    expect(
      await recordWorkflowDiagnostic({ directory: lost, router: new SharedCoreRouter(lost) }, i),
    ).toBe("existing");
    expect(
      await recordWorkflowDiagnostic(ctx, { ...i, recordedAt: "2026-10-28T11:00:01.000000Z" }),
    ).toBe("existing");
    await expect(
      recordWorkflowDiagnostic(ctx, { ...i, routeTemplate: "/different" }),
    ).rejects.toThrow("identity conflicts");
    await c.core
      .prepare(
        `WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO deployment_diagnostics(diagnostic_event_id,organization_id,project_id,environment_id,deployment_id,source,code,catalog_message,occurred_at,recorded_at) SELECT printf('%026d',i),?1,?2,?3,?4,'control','DEPLOYMENT_FAILED','DEPLOYMENT_FAILED_SEE_OPERATION_ERROR',?5,?5 FROM n`,
      )
      .bind(i.organizationId, i.projectId, i.environmentId, i.deploymentId, at)
      .run();
    await recordWorkflowDiagnostic(ctx, { ...i, id: newUlid() });
    // A write never trims the environment: the cap is enforced by the purge, one bounded page per pass.
    const count = () => c.core.prepare("SELECT count(*) n FROM deployment_diagnostics").first();
    expect(await count()).toEqual({ n: 10003 });
    const purged = { cutoff: "2026-10-27T00:00:00.000Z" };
    // Three rows sit beyond the cap: one page of one, then the rest.
    expect(await purgeConsumerDiagnostics(ctx, { ...purged, limit: 1 })).toBe(1);
    expect(await count()).toEqual({ n: 10002 });
    expect(await purgeConsumerDiagnostics(ctx, { ...purged, limit: 1000 })).toBe(2);
    expect(await count()).toEqual({ n: 10000 });
    await recordWorkflowDiagnostic(ctx, {
      ...i,
      id: newUlid(),
      occurredAt: "2026-11-05T11:00:00.000000Z",
      recordedAt: "2026-11-05T11:00:00.000000Z",
    });
    expect(await c.core.prepare("SELECT count(*) n FROM deployment_diagnostics").first()).toEqual({
      n: 1,
    });
  } finally {
    await c.dispose();
  }
});
