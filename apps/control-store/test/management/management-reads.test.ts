import { readFileSync } from "node:fs";
import { splitStatements } from "../support/sql.js";
import { preProviderScopeCore, providerScopeRows } from "./provider-scope-fixture.js";
import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { makePaid } from "../support/credit-fixtures.js";
import { createControlStore } from "../../src/store.js";
import {
  CORE_DATABASE_ID,
  MANAGEMENT_CLAIM,
  MANAGEMENT_SCOPE,
  seedManagementScope,
  seedOtherProviderOperation,
} from "../../../neon-management/test/support/d1-pgcf-scope.js";
import { id, pgcfFixture } from "../../../neon-management/test/pgcf-runtime-fixture.js";
it("reads actual qualified Core identity and a current claim/epoch/region with the Paid coverage of the credit account in real D1", async () => {
  const control = await createTestControl(),
    native = await pgcfFixture(false);
  try {
    const nativeKeys = await native.control.pool.query(
      "SELECT conrelid::regclass::text table_name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE contype='f' AND conrelid IN('neon_project_placement_receipts'::regclass,'neon_project_role_receipts'::regclass,'neon_project_placement_reservations'::regclass,'database_provider_target_revisions'::regclass,'project_database_registration_receipts'::regclass,'database_provider_cutover_binding_refreshes'::regclass,'database_provider_operations'::regclass,'project_database_registration_reservations'::regclass,'pgcf_database_migration_receipts'::regclass) ORDER BY table_name,definition",
    );
    const groups = new Map<string, string[]>();
    for (const table of [
      "database_provider_operations",
      "database_provider_target_revisions",
      "project_database_registration_reservations",
      "project_database_registration_receipts",
      "pgcf_database_migration_receipts",
      "neon_project_placement_reservations",
    ]) {
      const keys = (await control.core.prepare(`PRAGMA foreign_key_list(${table})`).all()).results;
      const byId = new Map<unknown, typeof keys>();
      for (const row of keys) {
        const list = byId.get(row["id"]) ?? [];
        list.push(row);
        byId.set(row["id"], list);
      }
      groups.set(
        table,
        [...byId.values()].map((rows) => {
          rows.sort((a, b) => Number(a["seq"]) - Number(b["seq"]));
          return `FOREIGN KEY (${rows.map((r) => r["from"]).join(", ")}) REFERENCES ${rows[0]?.["table"]}(${rows.map((r) => r["to"]).join(", ")})`;
        }),
      );
    }
    for (const row of nativeKeys.rows)
      if (groups.has(row.table_name)) expect(groups.get(row.table_name)).toContain(row.definition);
    await seedManagementScope(control.core);
    const store = createControlStore({
      ...control.bindings,
      CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
      CONTROL_PLATFORM_ENVIRONMENT: "development",
    });
    expect(await store.databaseManagement.readControlAuthority(undefined)).toEqual({
      provider: "d1",
      databaseId: CORE_DATABASE_ID,
      environment: "development",
      activationId: "00000000-0000-4000-8000-000000000001",
      qualificationSha256: "00".repeat(32),
      runtimeSchemaSha256: "11".repeat(32),
    });
    const claim = await store.databaseManagement.resolveClaim(MANAGEMENT_CLAIM);
    expect(claim).toEqual({
      organizationId: id(1),
      projectId: id(2),
      physicalEnvironmentId: id(4),
      operationId: id(30),
      claimId: id(31),
      regionId: "us-dev",
    });
    const { regionId, ...scope } = claim;
    void regionId;
    const placementPaid = () =>
      store.databaseManagement.readPlacementPaidAccess({
        ...scope,
        now: new Date().toISOString(),
      });
    expect(await placementPaid()).toBe(false);
    await makePaid(control.core, id(1));
    expect(await placementPaid()).toBe(true);
    await expect(
      store.databaseManagement.readPlacementPaidAccess({
        ...scope,
        claimId: id(77),
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    expect(await store.databaseManagement.readRuntimeBinding(MANAGEMENT_SCOPE)).toBeNull();
    await expect(
      store.databaseManagement.resolveClaim({ ...MANAGEMENT_CLAIM, organizationId: id(77) }),
    ).rejects.toThrow();
    await expect(
      store.databaseManagement.readRuntimeBinding({ ...MANAGEMENT_SCOPE, environmentId: id(77) }),
    ).rejects.toThrow();
    await expect(
      createControlStore(control.bindings).databaseManagement.readControlAuthority(undefined),
    ).rejects.toThrow();
    // Logical claim4 can reserve real physical identity6; no logical environment6 is manufactured.
    await control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?,?,?,'2026-09-01T00:00:00.000000Z')",
      )
      .bind(id(1), id(2), id(6))
      .run();
    const reserve = (physical: string) =>
      control.core
        .prepare(
          "INSERT INTO neon_project_placement_reservations(organization_id,project_id,environment_id,operation_id,claim_id,project_name,region_id,postgres_version,reserved_at) VALUES(?,?,?,?,?,'ohmyho-'||lower(?),'aws-us-east-1',18,'2026-09-01T00:00:00.000000Z')",
        )
        .bind(id(1), id(2), physical, id(30), id(31), id(2))
        .run();
    await expect(reserve(id(99))).rejects.toThrow("FOREIGN KEY");
    await reserve(id(6));
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM environments WHERE environment_id=?")
        .bind(id(6))
        .first(),
    ).toEqual({ n: 0 });
    // A same-organization operation of another project is not a parent of this project's provider facts.
    await seedOtherProviderOperation(control.core);
    await expect(
      control.core
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?,?,?,1,'pgcf','prj_abcdefghijklmnopqrst','abcdefghijklmnopqrst','us-dev','r512-s1g',?,'registry:fixture',?,'2026-09-01T00:00:00.000000Z')",
        )
        .bind(id(1), id(2), id(4), "ohmyho_rw_" + id(4).toLowerCase(), id(83))
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const old = await preProviderScopeCore();
    try {
      await seedManagementScope(old.core);
      await seedOtherProviderOperation(old.core);
      await old.core
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?,?,?,1,'pgcf','prj_abcdefghijklmnopqrst','abcdefghijklmnopqrst','us-dev','r512-s1g',?,'registry:fixture',?,'2026-09-01T00:00:00.000000Z')",
        )
        .bind(id(1), id(2), id(4), "ohmyho_rw_" + id(4).toLowerCase(), id(83))
        .run();
      const rows = await providerScopeRows(old.core),
        schema = (
          await old.core
            .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
            .all()
        ).results;
      await expect(
        old.core.batch(
          splitStatements(
            readFileSync(
              new URL("../../migrations/core/0353_provider_operation_scope.sql", import.meta.url),
              "utf8",
            ),
          ).map((sql) => old.core.prepare(sql)),
        ),
      ).rejects.toThrow("FOREIGN KEY");
      expect(await providerScopeRows(old.core)).toEqual(rows);
      expect(
        (
          await old.core
            .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
            .all()
        ).results,
      ).toEqual(schema);
      expect((await old.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally {
      await old.dispose();
    }
  } finally {
    await control.dispose();
    await native.control.stop();
  }
}, 60_000);
