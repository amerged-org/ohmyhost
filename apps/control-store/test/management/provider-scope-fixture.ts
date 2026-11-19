import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { migrationFiles, activateTestCore, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
/** A populated forward-migration oracle, not an alternative production schema loader. */
export async function preProviderScopeCore(): Promise<TestControl> {
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('private')}}",
    d1Databases: { CONTROL_CORE: "before-provider-scope" },
  });
  try {
    const core = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    for (const file of migrationFiles("core").filter((file) => file.name < "0353"))
      await core.batch(splitStatements(file.sql).map((sql) => core.prepare(sql)));
    await activateTestCore(core);
    return {
      core,
      directory: core,
      bindings: { CONTROL_CORE: core },
      shards: { CONTROL_SHARD_0000: core },
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
export const PROVIDER_SCOPE_TABLES = [
  "database_provider_operations",
  "database_provider_target_revisions",
  "neon_project_placement_reservations",
  "pgcf_database_migration_receipts",
  "pgcf_database_serving_intervals",
  "project_database_registration_receipts",
  "project_database_registration_reservations",
  "database_provider_cutover_binding_refreshes",
  "database_provider_legacy_retirements",
  "database_provider_target_heads",
] as const;
export async function providerScopeRows(core: D1Database) {
  const results = await core.batch(
    PROVIDER_SCOPE_TABLES.map((table) => core.prepare(`SELECT * FROM ${table}`)),
  );
  return results.map((result) => result.results);
}
