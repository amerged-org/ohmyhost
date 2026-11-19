/* global structuredClone */
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestPostgres } from "../../../control-api/test/postgres.ts";
import { createTestControl } from "../support/control-d1.ts";
import { seedProject, STORED_NOW, ulidOf } from "../support/platform-fixtures.ts";
import {
  captureExpression,
  columnKind,
  tableProof,
} from "../../../../scripts/control-d1-codec.mjs";
import {
  PRODUCT_DATABASE_COLUMNS,
  PRODUCT_DATABASE_SCHEMA_PINS,
  mapProductDatabase,
  readProductDatabaseSourceFacts,
} from "../../../../scripts/control-d1-product-database-mappings.mjs";

let pg, control, manifest, source;
beforeAll(async () => {
  [pg, control] = await Promise.all([startTestPostgres(), createTestControl()]);
  const project = await seedProject(control),
    operation = ulidOf("product-db", 1),
    physical = project.devEnvironmentId,
    provider = `prj_${"a".repeat(20)}`,
    database = `d${"b".repeat(19)}`,
    version = "9007199254740993";
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(
        project.organizationId,
        operation,
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      ),
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(project.organizationId, project.projectId, physical, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,CAST(?4 AS INTEGER),'pgcf',?5,?6,'us-dev','omh-512',?7,'sealed:fixture',?8)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        physical,
        version,
        provider,
        database,
        `ohmyho_rw_${physical.toLowerCase()}`,
        STORED_NOW,
      ),
  ]);
  const scope = {
      organization_id: project.organizationId,
      project_id: project.projectId,
      environment_id: physical,
      data_environment_id: physical,
    },
    rows = {
      project_database_access: {
        ...scope,
        access_id: ulidOf("access", 1),
        environment: "dev",
        provider_project_id: provider,
        default_branch_id: null,
        role_name: `ohmyho_da_${physical.toLowerCase()}_native00`,
        mode: "write",
        label: "historical SQL",
        principal_id: "user:fixture",
        origin_host: "db.example.com",
        issued_at: STORED_NOW,
        expires_at: "2026-10-29T10:00:00.000000Z",
        revoked_at: STORED_NOW,
        revoked_by: "",
        revocation_reason: "data_change",
        role_dropped_at: STORED_NOW,
        provider: "pgcf",
        database_id: database,
        provider_create_operation_id: `op_${"c".repeat(20)}`,
        provider_delete_operation_id: null,
      },
      project_database_writes: {
        ...scope,
        operation_id: operation,
        environment: "dev",
        billing_epoch_id: project.billingEpochId,
        provider_project_id: provider,
        default_branch_id: null,
        principal_id: "",
        idempotency_key: "original",
        request_sha256: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
        started_at: STORED_NOW,
        deadline_at: "2026-10-28T10:01:00.000000Z",
        completed_at: "2026-10-28T10:01:00.123456Z",
        command: null,
        affected_rows: null,
        failure_code: "DATABASE_WRITE_OUTCOME_UNKNOWN",
        provider: "pgcf",
        database_id: database,
      },
      pgcf_database_compute_changes: {
        ...scope,
        operation_id: operation,
        billing_epoch_id: project.billingEpochId,
        provider_project_id: provider,
        database_id: database,
        target_version: version,
        memory_mib: 512,
        size_class_id: "historical-unmapped-class",
        accepted_lifecycle_version: -2147483648,
        requested_at: STORED_NOW,
        claim_id: ulidOf("compute-claim", 1),
        claim_expires_at: null,
        last_attempted_at: null,
        completed_at: "2026-10-28T10:00:01.123456Z",
        failure_code: "opaque original text",
      },
    };
  manifest = {
    targetPin: {
      migrations: Object.entries(PRODUCT_DATABASE_SCHEMA_PINS).map(([name, sha256]) => ({
        name,
        sha256,
      })),
    },
    tables: [],
  };
  source = new Map();
  for (const table of Object.keys(PRODUCT_DATABASE_COLUMNS)) {
    // Scalar/type oracle only: LIKE does not copy the native FK graph or triggers.
    // Core imports below retain their real checked-in FK graph and guards.
    await pg.pool.query(`CREATE TABLE parity_${table}(LIKE ${table} INCLUDING CONSTRAINTS)`);
    const row = rows[table],
      names = Object.keys(row);
    await pg.pool.query(
      `INSERT INTO parity_${table}(${names.join(",")}) VALUES(${names.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(row),
    );
    const columns = (
      await pg.pool.query(
        "SELECT a.attname name,format_type(a.atttypid,a.atttypmod) type FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
        [table],
      )
    ).rows.map((c) => ({ name: c.name, pgType: c.type, kind: columnKind(c.type) }));
    manifest.tables.push({ name: table, columns });
    source.set(
      table,
      (
        await pg.pool.query(
          `SELECT ${columns.map((c) => `${captureExpression(c)} AS ${c.name}`).join(",")} FROM parity_${table}`,
        )
      ).rows,
    );
  }
}, 120_000);
afterAll(async () => {
  await Promise.all([pg?.stop(), control?.dispose()]);
});

it("imports actual PG18 typed SQL/compute rows and reads them back unchanged, including int8, binary digests, nulls and unknown outcomes", async () => {
  const records = mapProductDatabase(source, manifest);
  await control.core.batch(
    records.map((record) => {
      const names = Object.keys(record.row),
        definition = manifest.tables.find((t) => t.name === record.table);
      return control.core
        .prepare(
          `INSERT INTO ${record.table}(${names.join(",")}) VALUES(${names.map((name) => (definition.columns.find((c) => c.name === name).kind === "bytea" ? "unhex(?)" : definition.columns.find((c) => c.name === name).kind === "integer" ? "CAST(? AS INTEGER)" : "?")).join(",")})`,
        )
        .bind(...Object.values(record.row));
    }),
  );
  const readback = await readProductDatabaseSourceFacts(control.core);
  for (const definition of manifest.tables) {
    const values = (rows) => rows.map((row) => definition.columns.map((c) => row[c.name]));
    expect(tableProof(definition.columns, values(readback.get(definition.name)))).toEqual(
      tableProof(definition.columns, values(source.get(definition.name))),
    );
  }
  expect(readback.get("pgcf_database_compute_changes")[0].target_version).toBe("9007199254740993");
  expect(readback.get("project_database_writes")[0].failure_code).toBe(
    "DATABASE_WRITE_OUTCOME_UNKNOWN",
  );
  expect(
    records.some((r) =>
      Object.keys(r.row).some((key) => ["ciphertext", "password", "connection_uri"].includes(key)),
    ),
  ).toBe(false);
});

it("refuses missing/drifted source or schema and unrepresentable facts rather than rounding or repairing them", () => {
  for (const pin of Object.keys(PRODUCT_DATABASE_SCHEMA_PINS)) {
    const missingPin = structuredClone(manifest);
    missingPin.targetPin.migrations = missingPin.targetPin.migrations.filter(
      (entry) => entry.name !== pin,
    );
    expect(() => mapProductDatabase(source, missingPin)).toThrow(/SCHEMA_PREREQUISITE/u);
  }
  const missingTable = structuredClone(manifest);
  missingTable.tables.pop();
  expect(() => mapProductDatabase(source, missingTable)).toThrow(/SOURCE_COLUMNS/u);
  const missingRows = new Map(source);
  missingRows.delete("project_database_writes");
  expect(() => mapProductDatabase(missingRows, manifest)).toThrow(/SOURCE_TABLE/u);
  for (const [table, field, value, error] of [
    ["project_database_writes", "extra", "invented", /ROW_SHAPE/u],
    ["project_database_writes", "principal_id", 1, /ROW_VALUE/u],
    ["project_database_writes", "started_at", "+infinity", /TIMESTAMP_UNREPRESENTABLE/u],
    ["project_database_writes", "request_sha256", "NOT-HEX", /BYTEA_UNREPRESENTABLE/u],
    ["pgcf_database_compute_changes", "target_version", "9223372036854775808", /INTEGER_RANGE/u],
  ]) {
    const invalid = new Map(source);
    invalid.set(table, [{ ...source.get(table)[0], [field]: value }]);
    expect(() => mapProductDatabase(invalid, manifest)).toThrow(error);
  }
});
