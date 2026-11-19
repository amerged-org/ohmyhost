import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { coreRouter } from "../support/control-d1.js";
import { readProjectDatabaseAccessHistory } from "../../src/catalog/database/access-history.js";
import { seedProject, STORED_NOW, ulidOf } from "../support/platform-fixtures.js";

let control: TestControl;
let postgres: TestPostgres;
let serial = 0;
beforeAll(async () => {
  control = await createTestControl();
  postgres = await startTestPostgres();
  // Scalar/type oracles only: LIKE does not copy native foreign keys or triggers.
  // The D1 fixtures separately preserve the real Core FK graph and production guards.
  for (const table of [
    "project_database_access",
    "project_database_writes",
    "pgcf_database_compute_changes",
  ])
    await postgres.pool.query(`CREATE TABLE parity_${table}(LIKE ${table} INCLUDING CONSTRAINTS)`);
}, 120_000);
afterAll(async () => {
  await Promise.all([control?.dispose(), postgres?.stop()]);
});
const accepted = (run: () => Promise<unknown>) =>
  run().then(
    () => true,
    () => false,
  );
async function insert(table: string, row: Record<string, unknown>, engine: "d1" | "postgres") {
  const columns = Object.keys(row),
    values = Object.values(row);
  if (engine === "d1")
    return control.core
      .prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...values)
      .run();
  return postgres.pool.query(
    `INSERT INTO parity_${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    values,
  );
}
async function fixture() {
  serial += 1;
  const project = await seedProject(control),
    operationId = ulidOf("sql-job", serial);
  await control.core
    .prepare(
      "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
    )
    .bind(
      project.organizationId,
      operationId,
      project.projectId,
      project.billingEpochId,
      STORED_NOW,
    )
    .run();
  return { project, operationId };
}

it("preserves original SQL credential domains including Unicode labels, provider targets and mutable revocation evidence", async () => {
  const { project } = await fixture();
  const base = {
    organization_id: project.organizationId,
    project_id: project.projectId,
    environment_id: project.devEnvironmentId,
    environment: "dev",
    data_environment_id: project.devEnvironmentId,
    provider_project_id: "neon-project",
    default_branch_id: "br-main",
    mode: "read",
    label: null,
    principal_id: "user:fixture",
    origin_host: "db.example.com",
    issued_at: STORED_NOW,
    expires_at: "2026-10-29T10:00:00.000000Z",
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
    role_dropped_at: null,
    provider: "neon",
    database_id: null,
    provider_create_operation_id: null,
    provider_delete_operation_id: null,
  };
  const probes: Record<string, unknown>[] = [
    {},
    ...[
      "valid",
      "a\tb",
      "a\nb",
      " a",
      "a\t",
      "a\u0001b",
      "a\u007fb",
      "a\u009fb",
      "a\u00a0",
      "a\u1680",
      "a\u2000",
      "a\u2007",
      "a\u2028",
      "a\u202f",
      "a\u205f",
      "a\u3000",
      "a\uFEFF",
      "x".repeat(65),
    ].map((label) => ({ label })),
    { principal_id: "" },
    { origin_host: "a." },
    { expires_at: STORED_NOW },
    { expires_at: "2026-10-29T10:00:00.000001Z" },
    {
      revoked_at: STORED_NOW,
      revoked_by: "",
      revocation_reason: "data_change",
      role_dropped_at: STORED_NOW,
    },
    { revoked_at: STORED_NOW, revoked_by: null, revocation_reason: "principal" },
    {
      default_branch_id: null,
      provider: "pgcf",
      provider_project_id: `prj_${"a".repeat(20)}`,
      database_id: `d${"b".repeat(19)}`,
      provider_create_operation_id: `op_${"c".repeat(20)}`,
    },
    { provider_create_operation_id: `op_${"c".repeat(20)}` },
  ];
  const pgcf = {
    ...base,
    default_branch_id: null,
    provider: "pgcf",
    provider_project_id: `prj_${"a".repeat(20)}`,
    database_id: `d${"b".repeat(19)}`,
  };
  for (const probe of probes) {
    serial += 1;
    const row = {
      ...base,
      access_id: ulidOf("access", serial),
      role_name: `ohmyho_da_${project.devEnvironmentId.toLowerCase()}_${serial.toString(36).padStart(8, "0")}`,
      ...probe,
    };
    expect
      .soft(
        await accepted(() => insert("project_database_access", row, "d1")),
        JSON.stringify(probe),
      )
      .toBe(await accepted(() => insert("project_database_access", row, "postgres")));
  }
  const row = {
    ...pgcf,
    access_id: ulidOf("access-update", serial),
    role_name: `ohmyho_da_${project.devEnvironmentId.toLowerCase()}_update00`,
  };
  await insert("project_database_access", row, "d1");
  const neon = {
    ...base,
    access_id: ulidOf("access-neon", serial),
    role_name: `ohmyho_da_${project.devEnvironmentId.toLowerCase()}_neon0000`,
  };
  await insert("project_database_access", neon, "d1");
  await expect(
    control.core
      .prepare(
        "UPDATE project_database_access SET origin_host='other.example.com' WHERE access_id=?",
      )
      .bind(row.access_id)
      .run(),
  ).rejects.toThrow(/immutable/u);
  await control.core
    .prepare(
      "UPDATE project_database_access SET revoked_at=?1,revoked_by='',revocation_reason='data_change',role_dropped_at=?1 WHERE access_id=?2",
    )
    .bind(STORED_NOW, row.access_id)
    .run();
  expect(
    await control.core
      .prepare("SELECT revoked_by,revocation_reason FROM project_database_access WHERE access_id=?")
      .bind(row.access_id)
      .first(),
  ).toEqual({ revoked_by: "", revocation_reason: "data_change" });
  const context = { directory: control.core, router: coreRouter(control) },
    scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      now: "2026-10-28T10:00:00.000Z",
    };
  const active = await readProjectDatabaseAccessHistory(context, scope);
  expect(
    active.items.some(
      (item) =>
        item.provider === "pgcf" &&
        item.transport === "wss" &&
        item.websocket_url === `wss://${base.origin_host}/`,
    ),
  ).toBe(true);
  // Stored Neon-era rows stay inert history and never reach the public listing.
  expect(active.items.map((item) => item.access_id)).not.toContain(neon.access_id);
  expect(active.items.find((item) => item.access_id === row.access_id)?.state).toBe("revoked");
  expect(
    (
      await readProjectDatabaseAccessHistory(context, { ...scope, now: "2026-10-30T10:00:00.000Z" })
    ).items.some((item) => item.state === "expired"),
  ).toBe(true);
  expect(
    await readProjectDatabaseAccessHistory(context, { ...scope, environment: "prod" }),
  ).toEqual({ items: [] });
  expect(
    await readProjectDatabaseAccessHistory(context, {
      ...scope,
      projectId: ulidOf("foreign-project", 1),
    }),
  ).toEqual({ items: [] });
  for (let index = 0; index < 55; index += 1) {
    serial += 1;
    await insert(
      "project_database_access",
      {
        ...pgcf,
        access_id: ulidOf("latest", serial),
        role_name: `ohmyho_da_${project.devEnvironmentId.toLowerCase()}_${serial.toString(36).padStart(8, "0")}`,
        issued_at: "2026-10-28T11:00:00.000000Z",
      },
      "d1",
    );
  }
  const latest = await readProjectDatabaseAccessHistory(context, { ...scope, environment: "dev" });
  expect(latest.items).toHaveLength(50);
  expect(latest.items.every((item) => item.issued_at === "2026-10-28T11:00:00.000Z")).toBe(true);
  expect(latest.items.map((item) => item.access_id)).toEqual(
    latest.items
      .map((item) => item.access_id)
      .sort()
      .reverse(),
  );
  await expect(
    readProjectDatabaseAccessHistory(context, { ...scope, environment: "other" }),
  ).rejects.toThrow();
});

it("preserves original write terminal and nullable target rules with immutable receipts and atomic late-FK rollback", async () => {
  const { project, operationId } = await fixture();
  const base = {
    operation_id: operationId,
    organization_id: project.organizationId,
    project_id: project.projectId,
    environment_id: project.devEnvironmentId,
    environment: "dev",
    data_environment_id: project.devEnvironmentId,
    billing_epoch_id: project.billingEpochId,
    provider_project_id: `prj_${"a".repeat(20)}`,
    default_branch_id: null,
    principal_id: "",
    idempotency_key: "write",
    request_sha256: new Uint8Array(32),
    started_at: STORED_NOW,
    deadline_at: "2026-10-28T10:01:00.000000Z",
    completed_at: null,
    command: null,
    affected_rows: null,
    failure_code: null,
    provider: "pgcf",
    database_id: `d${"b".repeat(19)}`,
  };
  // A fresh original operation per probe preserves real Core FK/unique constraints throughout.
  for (const probe of [
    {},
    { completed_at: STORED_NOW, command: "INSERT", affected_rows: 1000 },
    { completed_at: STORED_NOW, failure_code: "DATABASE_WRITE_OUTCOME_UNKNOWN" },
    { completed_at: STORED_NOW, command: "SELECT", affected_rows: 1 },
    { completed_at: STORED_NOW, command: "DELETE", affected_rows: 1001 },
    { deadline_at: "2026-10-28T10:01:00.000001Z" },
    { provider: "neon", database_id: null, default_branch_id: "" },
  ]) {
    const f = await fixture();
    // Keep the original project/epoch; the operation is global but its composite FK still proves exact scope.
    const id = f.operationId;
    await control.core
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(
        project.organizationId,
        ulidOf("write-probe", serial),
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      )
      .run();
    const row = {
      ...base,
      operation_id: ulidOf("write-probe", serial),
      idempotency_key: id,
      ...probe,
    };
    expect(
      await accepted(() => insert("project_database_writes", row, "d1")),
      JSON.stringify(probe),
    ).toBe(await accepted(() => insert("project_database_writes", row, "postgres")));
  }
  await insert("project_database_writes", base, "d1");
  await expect(
    control.core
      .prepare("DELETE FROM project_database_writes WHERE operation_id=?")
      .bind(operationId)
      .run(),
  ).rejects.toThrow(/retained/u);
  await control.core
    .prepare(
      "UPDATE project_database_writes SET completed_at=?1,failure_code='DATABASE_WRITE_OUTCOME_UNKNOWN' WHERE operation_id=?2",
    )
    .bind(STORED_NOW, operationId)
    .run();
  await expect(
    control.core
      .prepare(
        "UPDATE project_database_writes SET failure_code='DATABASE_WRITE_REJECTED' WHERE operation_id=?",
      )
      .bind(operationId)
      .run(),
  ).rejects.toThrow(/immutable/u);
  await expect(
    control.core.batch([
      control.core
        .prepare("UPDATE environments SET desired_state=?1 WHERE project_id=?2")
        .bind('{"rollback":true}', project.projectId),
      control.core
        .prepare(
          "INSERT INTO project_database_writes SELECT ?1,organization_id,project_id,environment_id,environment,data_environment_id,billing_epoch_id,provider_project_id,default_branch_id,principal_id,?1,request_sha256,started_at,deadline_at,completed_at,command,affected_rows,failure_code,provider,database_id FROM project_database_writes WHERE operation_id=?2",
        )
        .bind(ulidOf("orphan", 1), operationId),
    ]),
  ).rejects.toThrow(/FOREIGN KEY/u);
  expect(
    await control.core
      .prepare("SELECT desired_state FROM environments WHERE project_id=? LIMIT 1")
      .bind(project.projectId)
      .first(),
  ).toEqual({ desired_state: "{}" });
});

it("preserves the native PGCF compute job domain without inventing size-class, lifecycle or terminal restrictions", async () => {
  const { project, operationId } = await fixture(),
    physical = project.devEnvironmentId;
  await control.core
    .prepare(
      "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
    )
    .bind(project.organizationId, project.projectId, physical, STORED_NOW)
    .run();
  await control.core
    .prepare(
      "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev','omh-512',?6,'sealed:fixture',?7)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      physical,
      `prj_${"a".repeat(20)}`,
      `d${"b".repeat(19)}`,
      `ohmyho_rw_${physical.toLowerCase()}`,
      STORED_NOW,
    )
    .run();
  const base = {
    operation_id: operationId,
    organization_id: project.organizationId,
    project_id: project.projectId,
    environment_id: physical,
    data_environment_id: physical,
    billing_epoch_id: project.billingEpochId,
    provider_project_id: `prj_${"a".repeat(20)}`,
    database_id: `d${"b".repeat(19)}`,
    target_version: 1,
    memory_mib: 512,
    size_class_id: "",
    accepted_lifecycle_version: -2147483648,
    requested_at: STORED_NOW,
    claim_id: null,
    claim_expires_at: null,
    last_attempted_at: null,
    completed_at: STORED_NOW,
    failure_code: "arbitrary original text",
  };
  for (const probe of [
    {},
    { memory_mib: 500 },
    { accepted_lifecycle_version: 2147483648 },
    { database_id: "INVALID" },
    { provider_project_id: "neon" },
  ]) {
    // The completed valid row can be removed: original221 has no retained-identity or terminal trigger.
    const row = { ...base, ...probe };
    expect(
      await accepted(() => insert("pgcf_database_compute_changes", row, "d1")),
      JSON.stringify(probe),
    ).toBe(await accepted(() => insert("pgcf_database_compute_changes", row, "postgres")));
    await control.core.prepare("DELETE FROM pgcf_database_compute_changes").run();
    await postgres.pool.query("DELETE FROM parity_pgcf_database_compute_changes");
  }
  await insert("pgcf_database_compute_changes", base, "d1");
  await control.core
    .prepare(
      "UPDATE pgcf_database_compute_changes SET accepted_lifecycle_version=2147483647,size_class_id='unmapped-historical-class',claim_id=? WHERE operation_id=?",
    )
    .bind(ulidOf("claim", 1), operationId)
    .run();
  expect(
    await control.core
      .prepare("SELECT accepted_lifecycle_version,size_class_id FROM pgcf_database_compute_changes")
      .first(),
  ).toEqual({ accepted_lifecycle_version: 2147483647, size_class_id: "unmapped-historical-class" });
});
