import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  NATIVE_AUTH_SCHEMA_V1_SHA256,
  NATIVE_AUTH_SCHEMA_V2_SHA256,
} from "@ohmyhost/contracts/native-auth";
import { DatabaseProviderConflictError } from "@ohmyhost/database";
import { NATIVE_AUTH_SCHEMA_SQL } from "./native-auth-schema.js";
import { NATIVE_AUTH_SCHEMA_V2_SQL } from "./native-auth-schema-v2.js";
import { NATIVE_AUTH_SCHEMA_V3_SQL } from "./native-auth-schema-v3.js";
import { nativeAuthRoleNames } from "./native-auth-roles.js";

interface Client {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** One pinned platform migration, transactional and replayable under the schema's private migrator role. */
export async function applyNativeAuthMigration(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly databaseId: string;
  readonly client: Client;
}): Promise<void> {
  const names = nativeAuthRoleNames(input.projectId, input.environmentId);
  const digest = async (sql: string) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  if (
    (await digest(NATIVE_AUTH_SCHEMA_SQL)) !== NATIVE_AUTH_SCHEMA_V1_SHA256 ||
    (await digest(NATIVE_AUTH_SCHEMA_V2_SQL)) !== NATIVE_AUTH_SCHEMA_V2_SHA256 ||
    (await digest(NATIVE_AUTH_SCHEMA_V3_SQL)) !== NATIVE_AUTH_SCHEMA_MIGRATION_SHA256 ||
    NATIVE_AUTH_SCHEMA_MIGRATION_VERSION !== 3 ||
    !/^[a-z][a-z0-9]{19}$/u.test(input.databaseId)
  )
    throw new DatabaseProviderConflictError();
  await input.client.query("BEGIN");
  try {
    const identity = await input.client.query(
      "SELECT current_database()=$1 AND current_user=$2 AND session_user=$2 AS safe",
      [input.databaseId, names.migrator],
    );
    if (identity.rows[0]?.["safe"] !== true) throw new DatabaseProviderConflictError();
    await input.client.query(`SET LOCAL search_path = ${names.schema}, pg_catalog`);
    await input.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `native-auth-migration:${input.environmentId}`,
    ]);
    const current = await input.client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `${names.schema}.omh_native_migrations`,
    ]);
    if (current.rows[0]?.["present"] !== true) {
      const existing = await input.client.query(
        "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','S','v','m','f')",
        [names.schema],
      );
      if (existing.rows[0]?.["n"] !== 0) throw new DatabaseProviderConflictError();
      await input.client.query(
        `CREATE TABLE ${names.schema}.omh_native_migrations(version integer PRIMARY KEY, digest text NOT NULL)`,
      );
      await input.client.query(NATIVE_AUTH_SCHEMA_SQL);
      await input.client.query(
        `INSERT INTO ${names.schema}.omh_native_migrations(version,digest) VALUES($1,$2)`,
        [1, NATIVE_AUTH_SCHEMA_V1_SHA256],
      );
    }
    const record = await input.client.query(
      `SELECT version,digest FROM ${names.schema}.omh_native_migrations ORDER BY version`,
    );
    if (
      (record.rows.length !== 1 && record.rows.length !== 2 && record.rows.length !== 3) ||
      record.rows[0]?.["version"] !== 1 ||
      record.rows[0]?.["digest"] !== NATIVE_AUTH_SCHEMA_V1_SHA256 ||
      (record.rows.length >= 2 &&
        (record.rows[1]?.["version"] !== 2 ||
          record.rows[1]?.["digest"] !== NATIVE_AUTH_SCHEMA_V2_SHA256)) ||
      (record.rows.length === 3 &&
        (record.rows[2]?.["version"] !== NATIVE_AUTH_SCHEMA_MIGRATION_VERSION ||
          record.rows[2]?.["digest"] !== NATIVE_AUTH_SCHEMA_MIGRATION_SHA256))
    )
      throw new DatabaseProviderConflictError();
    if (record.rows.length === 1) {
      await input.client.query(NATIVE_AUTH_SCHEMA_V2_SQL);
      await input.client.query(
        `INSERT INTO ${names.schema}.omh_native_migrations(version,digest) VALUES($1,$2)`,
        [2, NATIVE_AUTH_SCHEMA_V2_SHA256],
      );
    }
    if (record.rows.length < 3) {
      await input.client.query(NATIVE_AUTH_SCHEMA_V3_SQL);
      await input.client.query(
        `INSERT INTO ${names.schema}.omh_native_migrations(version,digest) VALUES($1,$2)`,
        [NATIVE_AUTH_SCHEMA_MIGRATION_VERSION, NATIVE_AUTH_SCHEMA_MIGRATION_SHA256],
      );
    }
    await input.client.query(
      `REVOKE ALL ON ${names.schema}.omh_native_migrations FROM PUBLIC, ${names.runtime}`,
    );
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
