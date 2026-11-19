import { expect, it } from "vitest";
import { startTestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl } from "../support/control-d1.js";
import { workflowFixture } from "./workflow-fixture.js";
import { newUlid } from "../../src/catalog/common.js";

it("preserves original binding snapshot numeric/shape semantics against PostgreSQL18, including fractions rounded by SQLite", async () => {
  const [control, pg] = await Promise.all([createTestControl(), startTestPostgres()]);
  try {
    for (const raw of [
      "1",
      "0",
      "-0",
      "1.0",
      "1e0",
      "9007199254740991",
      "9.007199254740991e15",
      "9007199254740991.1",
      "1e-1000",
      "9007199254740992",
      "-1",
    ]) {
      let encoded = "";
      const insert = workflowFixture(control, {
        bindingSnapshot: ({ project, planId }) => {
          const oldDeployment = newUlid();
          const value = {
            sourceDeploymentId: oldDeployment,
            sourceRevisionId: newUlid(),
            sourceCandidateReceiptId: newUlid(),
            sourceArtifactId: newUlid(),
            sourcePlanId: planId,
            sourceBuildExecutionId: newUlid(),
            sourceArtifactSha256: "ab".repeat(32),
            sourceNamespace: "fixture-ns",
            sourceScriptName: `p-${project.projectId.toLowerCase()}-dev-${oldDeployment.toLowerCase()}`,
            sourceProviderTag: "cd".repeat(16),
            expectedHeadVersion: 1,
            expectedGatewayRevision: 1,
            dataEnvironmentId: project.developmentDataEnvironmentId,
            assignmentVersion: 1,
            registrationVersion: 1,
          };
          encoded = JSON.stringify(value).replace(
            '"registrationVersion":1',
            `"registrationVersion":${raw}`,
          );
          return encoded;
        },
      });
      let actual: boolean;
      try {
        const r = await insert;
        actual = true;
        expect(
          await control.core
            .prepare(
              "SELECT binding_refresh_snapshot_sha256 FROM product_command_intents WHERE operation_id=?",
            )
            .bind(r.accepted.operationId)
            .first(),
        ).toEqual({ binding_refresh_snapshot_sha256: null });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        actual = false;
      }
      const native = (
        await pg.pool.query("SELECT valid_binding_refresh_snapshot($1::jsonb) valid", [encoded])
      ).rows[0]?.valid;
      expect(actual, raw).toBe(native);
    }
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await Promise.all([control.dispose(), pg.stop()]);
  }
}, 240_000);

it("retains original TEXT data-change values, exact key/scope constraints and immutable accepted intent bytes", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c),
      cleanup = newUlid(),
      snapshot = JSON.stringify({
        transition: {},
        environmentHeads: [{}, {}],
        registrationGenerations: [],
      });
    await c.core
      .prepare(
        `INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?,?,?,?,'pending',1,'2026-10-28T11:00:00.000000Z','2026-10-28T11:00:00.000000Z')`,
      )
      .bind(r.p.organizationId, cleanup, r.p.projectId, r.accepted.operationId)
      .run();
    const sql = `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,expected_etag,cleanup_run_id,data_change,data_change_snapshot,created_at) VALUES(?,?,?,?,?,'ProjectDataChangeRequestedV1','fixture-etag',?,?,?,'2026-10-28T11:00:00.000000Z')`;
    const values = [
      r.p.organizationId,
      r.p.projectId,
      r.p.productionEnvironmentId,
      r.accepted.operationId,
      r.p.billingEpochId,
      cleanup,
    ];
    await expect(
      c.core
        .prepare(sql)
        .bind(...values, JSON.stringify("reset_dev"), snapshot)
        .run(),
    ).rejects.toThrow();
    await expect(
      c.core
        .prepare(sql)
        .bind(
          ...values,
          "reset_dev",
          JSON.stringify({
            transition: {},
            environmentHeads: [{}, {}],
            registrationGenerations: [],
            unexpected: true,
          }),
        )
        .run(),
    ).rejects.toThrow();
    await c.core
      .prepare(sql)
      .bind(...values, "reset_dev", snapshot)
      .run();
    expect(
      await c.core
        .prepare(
          "SELECT data_change,data_change_snapshot FROM product_command_intents WHERE operation_id=? AND environment_id=?",
        )
        .bind(r.accepted.operationId, r.p.productionEnvironmentId)
        .first(),
    ).toEqual({ data_change: "reset_dev", data_change_snapshot: snapshot });
    await expect(
      c.core
        .prepare("UPDATE product_command_intents SET expected_etag='changed' WHERE operation_id=?")
        .bind(r.accepted.operationId)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      c.core
        .prepare("DELETE FROM product_command_intents WHERE operation_id=?")
        .bind(r.accepted.operationId)
        .run(),
    ).rejects.toThrow("append-only");
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
});

it("upgrades source-legal populated intent bytes atomically and refuses prototype or cross-scope facts without rewriting them", async () => {
  const { Miniflare } = await import("miniflare");
  const { migrationFiles } = await import("../support/control-d1.js");
  const { splitStatements } = await import("../support/sql.js");
  const { seedProject } = await import("../support/platform-fixtures.js");
  const { guard } = await import("../../src/guards.js");
  for (const variant of ["legal", "prototype", "scope"]) {
    const runtime = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('unserved')}}",
      d1Databases: { CONTROL_CORE: `intent-${variant}` },
    });
    try {
      const db = (await runtime.getD1Database(
        "CONTROL_CORE",
      )) as unknown as import("../../src/d1-types.js").D1Database;
      const migration = migrationFiles("core").find(
        (f) => f.name === "0451_original_product_intents.sql",
      );
      if (!migration) throw new Error("0451 migration missing");
      for (const file of migrationFiles("core").filter((f) => f.name < migration.name))
        await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
      const control = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
        dispose: () => runtime.dispose(),
      };
      const project = await seedProject(control),
        op = newUlid(),
        env =
          variant === "scope"
            ? (await seedProject(control)).devEnvironmentId
            : project.devEnvironmentId,
        stamp = "2026-10-28T11:00:00.000000Z";
      await db
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)",
        )
        .bind(project.organizationId, op, project.projectId, project.billingEpochId, stamp, stamp)
        .run();
      if (variant === "prototype")
        await db
          .prepare(
            `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,data_change,data_change_snapshot,created_at) VALUES(?,?,?,?,?,'ProjectDataChangeRequestedV1','"reset_dev"','{}',?)`,
          )
          .bind(project.organizationId, project.projectId, env, op, project.billingEpochId, stamp)
          .run();
      else
        await db
          .prepare(
            `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at) VALUES(?,?,?,?,?,'SourceLinkRequestedV1','7','fixture owner','opaque repo',?)`,
          )
          .bind(project.organizationId, project.projectId, env, op, project.billingEpochId, stamp)
          .run();
      const before = (await db.prepare("SELECT * FROM product_command_intents").all()).results;
      const statements = splitStatements(migration.sql).map((sql) => db.prepare(sql));
      if (variant !== "legal") {
        await expect(db.batch(statements), variant).rejects.toThrow();
        expect((await db.prepare("SELECT * FROM product_command_intents").all()).results).toEqual(
          before,
        );
      } else {
        await expect(
          db.batch([...statements, guard(db, "precondition_changed", "1")]),
        ).rejects.toThrow("guard_precondition_changed");
        expect((await db.prepare("SELECT * FROM product_command_intents").all()).results).toEqual(
          before,
        );
        await db.batch(statements);
        expect((await db.prepare("SELECT * FROM product_command_intents").all()).results).toEqual(
          before,
        );
        expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      }
      expect(
        await db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name GLOB '*_0451_*'").first(),
      ).toEqual({ n: 0 });
    } finally {
      await runtime.dispose();
    }
  }
}, 240_000);
