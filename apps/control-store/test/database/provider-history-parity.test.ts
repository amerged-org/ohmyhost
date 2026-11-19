import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  STORED_NOW,
  seedProject,
  ulidOf,
  type SeededProject,
} from "../support/platform-fixtures.js";

/**
 * Source parity: the historical Neon evidence tables of shard migration 0073 must accept and refuse exactly what the
 * PostgreSQL 18 originals (migrations 023/025/119) accept and refuse. Each probe row runs against a real D1 table and
 * against a PostgreSQL temp copy of the original table that carries the original CHECK constraints (`INCLUDING
 * CONSTRAINTS`; foreign keys are exercised on the D1 side by seeding the real parents).
 */
let control: TestControl;
let pg: TestPostgres;
beforeAll(async () => {
  control = await createTestControl(1);
  pg = await startTestPostgres();
  await pg.pool.query(
    "CREATE TABLE parity_placement (LIKE neon_project_placement_receipts INCLUDING CONSTRAINTS)",
  );
  await pg.pool.query(
    "CREATE TABLE parity_role (LIKE neon_project_role_receipts INCLUDING CONSTRAINTS)",
  );
}, 120_000);
afterAll(async () => {
  await pg.stop();
  await control.dispose();
});

let sequence = 0;
async function seeded(): Promise<{ project: SeededProject; physical: string }> {
  sequence += 1;
  const project = await seedProject(control, { shard: 0 });
  const physical = ulidOf("physical", sequence);
  await project.shard
    .prepare(
      "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(project.organizationId, project.projectId, physical, STORED_NOW)
    .run();
  return { project, physical };
}

const accepted = async (run: () => Promise<unknown>): Promise<boolean> =>
  run().then(
    () => true,
    () => false,
  );

describe("neon_project_placement_receipts parity with PostgreSQL 18", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a valid placement", {}],
    ["region without the aws prefix", { region_id: "eu-central-1" }],
    ["uppercase region", { region_id: "aws-EU-central-1" }],
    ["region without numeric tail", { region_id: "aws-eu-central" }],
    ["region with an empty segment", { region_id: "aws-eu--central-1" }],
    ["region that is only the prefix", { region_id: "aws-1" }],
    ["region with an underscore", { region_id: "aws-eu_central-1" }],
    ["single-segment region", { region_id: "aws-eu-1" }],
    ["postgres 13", { postgres_version: 13 }],
    ["postgres 14", { postgres_version: 14 }],
    ["postgres 18", { postgres_version: 18 }],
    ["postgres 19", { postgres_version: 19 }],
    ["empty provider project", { provider_project_id: "" }],
    ["uppercase provider project", { provider_project_id: "Neon-1" }],
    ["61 character provider project", { provider_project_id: "a".repeat(61) }],
    ["60 character provider project", { provider_project_id: "a".repeat(60) }],
    ["branch with a dot", { default_branch_id: "br.main" }],
    ["state other than ready", { state: "pending" }],
    ["foreign project name", { project_name: "ohmyho-other" }],
    ["compute profile paid", { provisioned_compute_profile: "paid" }],
    ["compute profile unknown", { provisioned_compute_profile: "huge" }],
  ];

  it.each(cases)("%s", async (_name, override) => {
    const { project, physical } = await seeded();
    const row: Record<string, unknown> = {
      organization_id: project.organizationId,
      project_id: project.projectId,
      environment_id: physical,
      operation_id: ulidOf("op", sequence),
      claim_id: ulidOf("claim", sequence),
      project_name: `ohmyho-${project.projectId.toLowerCase()}`,
      region_id: "aws-eu-central-1",
      postgres_version: 17,
      provider_project_id: `neon-project-${sequence}`,
      default_branch_id: "br-main-1",
      operation_ids: "[]",
      state: "ready",
      observed_at: STORED_NOW,
      created_at: STORED_NOW,
      provisioned_compute_profile: null,
      ...override,
    };
    const columns = Object.keys(row);
    const d1 = await accepted(() =>
      project.shard
        .prepare(
          `INSERT INTO neon_project_placement_receipts(${columns.join(", ")}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`,
        )
        .bind(...columns.map((column) => row[column]))
        .run(),
    );
    const pgRow: Record<string, unknown> = { ...row, operation_ids: "{}" };
    const postgres = await accepted(() =>
      pg.pool.query(
        `INSERT INTO parity_placement(${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        columns.map((column) => pgRow[column]),
      ),
    );
    expect(d1, `${_name}: D1 ${d1} vs PostgreSQL ${postgres}`).toBe(postgres);
  });
});

describe("neon_project_role_receipts parity with PostgreSQL 18", () => {
  const roleCases: Array<[string, (physical: string) => string]> = [
    ["legacy migration role", () => "ohmyho_migration"],
    ["legacy readonly role", () => "ohmyho_readonly"],
    ["legacy runtime role", () => "ohmyho_runtime"],
    ["per-environment migration role", (p) => `ohmyho_m_${p.toLowerCase()}`],
    ["per-environment readonly role", (p) => `ohmyho_ro_${p.toLowerCase()}`],
    ["per-environment runtime role", (p) => `ohmyho_rw_${p.toLowerCase()}`],
    ["backup role (private, never a receipt)", (p) => `ohmyho_backup_${p.toLowerCase()}`],
    ["another environment's role", () => `ohmyho_ro_${"x".repeat(26)}`],
    ["owner role", () => "neondb_owner"],
  ];

  it.each(roleCases)("%s", async (_name, roleOf) => {
    const { project, physical } = await seeded();
    const placement = {
      organization_id: project.organizationId,
      project_id: project.projectId,
      environment_id: physical,
      operation_id: ulidOf("op", sequence),
      claim_id: ulidOf("claim", sequence),
      project_name: `ohmyho-${project.projectId.toLowerCase()}`,
      region_id: "aws-eu-central-1",
      postgres_version: 17,
      provider_project_id: `neon-project-${sequence}`,
      default_branch_id: "br-main-1",
      operation_ids: "[]",
      state: "ready",
      observed_at: STORED_NOW,
      created_at: STORED_NOW,
    };
    const columns = Object.keys(placement);
    await project.shard
      .prepare(
        `INSERT INTO neon_project_placement_receipts(${columns.join(", ")}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`,
      )
      .bind(...columns.map((column) => (placement as Record<string, unknown>)[column]))
      .run();
    const role = {
      organization_id: project.organizationId,
      project_id: project.projectId,
      environment_id: physical,
      operation_id: ulidOf("roleop", sequence),
      claim_id: ulidOf("roleclaim", sequence),
      provider_project_id: placement.provider_project_id,
      branch_id: "br-main-1",
      role_name: roleOf(physical),
      operation_ids: "[]",
      state: "ready",
      observed_at: STORED_NOW,
      created_at: STORED_NOW,
    };
    const roleColumns = Object.keys(role);
    const d1 = await accepted(() =>
      project.shard
        .prepare(
          `INSERT INTO neon_project_role_receipts(${roleColumns.join(", ")}) VALUES (${roleColumns.map((_, i) => `?${i + 1}`).join(", ")})`,
        )
        .bind(...roleColumns.map((column) => (role as Record<string, unknown>)[column]))
        .run(),
    );
    const postgres = await accepted(() =>
      pg.pool.query(
        `INSERT INTO parity_role(${roleColumns.join(", ")}) VALUES (${roleColumns.map((_, i) => `$${i + 1}`).join(", ")})`,
        roleColumns.map((column) =>
          column === "operation_ids" ? "{}" : (role as Record<string, unknown>)[column],
        ),
      ),
    );
    expect(d1, `${_name}: D1 ${d1} vs PostgreSQL ${postgres}`).toBe(postgres);
  });

  it("keeps both tables append-only like the originals", async () => {
    const { project, physical } = await seeded();
    const providerProjectId = `neon-project-append-${sequence}`;
    await project.shard
      .prepare(
        "INSERT INTO neon_project_placement_receipts(organization_id, project_id, environment_id, operation_id, claim_id, project_name, region_id, postgres_version, provider_project_id, default_branch_id, operation_ids, state, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'aws-eu-central-1', 17, ?7, 'br-main-1', '[]', 'ready', ?8, ?8)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        physical,
        ulidOf("op", sequence),
        ulidOf("claim", sequence),
        `ohmyho-${project.projectId.toLowerCase()}`,
        providerProjectId,
        STORED_NOW,
      )
      .run();
    await project.shard
      .prepare(
        "INSERT INTO neon_project_role_receipts(organization_id, project_id, environment_id, operation_id, claim_id, provider_project_id, branch_id, role_name, operation_ids, state, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'br-main-1', 'ohmyho_migration', '[]', 'ready', ?7, ?7)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        physical,
        ulidOf("roleop", sequence),
        ulidOf("roleclaim", sequence),
        providerProjectId,
        STORED_NOW,
      )
      .run();
    for (const table of ["neon_project_placement_receipts", "neon_project_role_receipts"]) {
      await expect(
        project.shard
          .prepare(`UPDATE ${table} SET state = 'ready' WHERE organization_id = ?`)
          .bind(project.organizationId)
          .run(),
      ).rejects.toThrow(/append-only/u);
      await expect(
        project.shard
          .prepare(`DELETE FROM ${table} WHERE organization_id = ?`)
          .bind(project.organizationId)
          .run(),
      ).rejects.toThrow(/append-only/u);
    }
  });
});
