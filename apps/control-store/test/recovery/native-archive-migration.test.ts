import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { seedProject } from "../support/platform-fixtures.js";
import { seedOperation } from "../support/accepted-operation.js";

it("preserves old recovery jobs and guards while admitting only the bounded Native archive sets", async () => {
  const engine = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response(null)}}",
    d1Databases: { CONTROL_CORE: "native-recovery-migration" },
  });
  try {
    const db = (await engine.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    const files = migrationFiles("core"),
      next = files.find((file) => file.name === "0615_native_auth_recovery_archive.sql");
    if (!next) throw new Error("Migration missing");
    for (const file of files.filter((file) => file.name < next.name))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db },
      dispose: async () => {},
    };
    const project = await seedProject(control),
      operationId = await seedOperation(project);
    await db
      .prepare(
        `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,captured_at,archive_expires_at)
      VALUES(?1,?2,?3,?4,'2026-10-28T11:00:00.000000Z','2026-10-28T10:00:00.000000Z','ohmyho-development-backups',123,?5,'["dev.sql"]','2026-10-28T10:00:00.000000Z','2026-11-04T10:00:00.000000Z')`,
      )
      .bind(
        project.organizationId,
        operationId,
        project.projectId,
        project.devEnvironmentId,
        new Uint8Array(32).fill(4),
      )
      .run();
    const sql =
      "SELECT organization_id,operation_id,archive_key,archive_bytes,lower(hex(archive_sha256)) digest,sql_files,captured_at,archive_expires_at FROM project_recovery_jobs WHERE organization_id=?1 AND operation_id=?2";
    const before = await db.prepare(sql).bind(project.organizationId, operationId).first();
    await db.batch(splitStatements(next.sql).map((statement) => db.prepare(statement)));
    expect(await db.prepare(sql).bind(project.organizationId, operationId).first()).toEqual(before);
    await expect(
      db
        .prepare("DELETE FROM project_recovery_jobs WHERE organization_id=?1 AND operation_id=?2")
        .bind(project.organizationId, operationId)
        .run(),
    ).rejects.toThrow("project_recovery_jobs is retained");
    await expect(
      db
        .prepare(
          "UPDATE project_recovery_jobs SET sql_files='[\"auth.sql\"]' WHERE organization_id=?1 AND operation_id=?2",
        )
        .bind(project.organizationId, operationId)
        .run(),
    ).rejects.toThrow("archive is final");
    const nextOperation = await seedOperation(project);
    await db
      .prepare(
        `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,native_manifest,native_manifest_sha256,captured_at,archive_expires_at)
      VALUES(?1,?2,?3,?4,'2026-10-28T11:00:00.000000Z','2026-10-28T10:00:00.000000Z','ohmyho-development-backups',123,?5,'["auth.sql"]',?6,?7,'2026-10-28T10:00:00.000000Z','2026-11-04T10:00:00.000000Z')`,
      )
      .bind(
        project.organizationId,
        nextOperation,
        project.projectId,
        project.devEnvironmentId,
        new Uint8Array(32).fill(5),
        JSON.stringify({
          schemaVersion: "ohmyhost.native-auth-inventory/v1",
          organizationId: project.organizationId,
          projectId: project.projectId,
          databaseId: "a1234567890123456789",
          migrationVersion: 3,
          migrationDigest: "ab".repeat(32),
          realms: [
            {
              environmentId: project.devEnvironmentId,
              schemaName: "omh_auth_fixture",
              revocationEpoch: 1,
              configurationRevision: 1,
            },
          ],
        }),
        new Uint8Array(32).fill(7),
      )
      .run();
    const invalidOperation = await seedOperation(project);
    const missingManifestOperation = await seedOperation(project);
    await expect(
      db
        .prepare(
          `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,captured_at,archive_expires_at)
      VALUES(?1,?2,?3,?4,'2026-10-28T11:00:00.000000Z','2026-10-28T10:00:00.000000Z','ohmyho-development-backups',123,?5,'["auth.sql"]','2026-10-28T10:00:00.000000Z','2026-11-04T10:00:00.000000Z')`,
        )
        .bind(
          project.organizationId,
          missingManifestOperation,
          project.projectId,
          project.devEnvironmentId,
          new Uint8Array(32).fill(8),
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,captured_at,archive_expires_at)
      VALUES(?1,?2,?3,?4,'2026-10-28T11:00:00.000000Z','2026-10-28T10:00:00.000000Z','ohmyho-development-backups',123,?5,'["auth.sql","dev.sql"]','2026-10-28T10:00:00.000000Z','2026-11-04T10:00:00.000000Z')`,
        )
        .bind(
          project.organizationId,
          invalidOperation,
          project.projectId,
          project.devEnvironmentId,
          new Uint8Array(32).fill(6),
        )
        .run(),
    ).rejects.toThrow();
  } finally {
    await engine.dispose();
  }
}, 120_000);
