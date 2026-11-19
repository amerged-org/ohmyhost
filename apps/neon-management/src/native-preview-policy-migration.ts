import {
  PREVIEW_NATIVE_POLICY_SCHEMA_SHA256,
  PREVIEW_NATIVE_POLICY_SCHEMA_VERSION,
} from "@ohmyhost/contracts/previews";
import { DatabaseProviderConflictError } from "@ohmyhost/database";
import { nativeAuthRoleNames } from "./native-auth-roles.js";
import { NATIVE_PREVIEW_POLICY_SQL } from "./native-preview-policy-schema.js";

interface Client {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
/** One platform-owned, source-independent migration under the scoped Native migrator role. */
export async function applyNativePreviewPolicyMigration(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly databaseId: string;
  readonly client: Client;
}) {
  const names = nativeAuthRoleNames(input.projectId, input.environmentId);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(NATIVE_PREVIEW_POLICY_SQL)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (
    digest !== PREVIEW_NATIVE_POLICY_SCHEMA_SHA256 ||
    PREVIEW_NATIVE_POLICY_SCHEMA_VERSION !== 1 ||
    !/^[a-z][a-z0-9]{19}$/u.test(input.databaseId)
  )
    throw new DatabaseProviderConflictError();
  const client = input.client;
  await client.query("BEGIN");
  try {
    const identity = await client.query(
      "SELECT current_database()=$1 AND current_user=$2 AND session_user=$2 AS safe",
      [input.databaseId, names.migrator],
    );
    if (identity.rows[0]?.["safe"] !== true) throw new DatabaseProviderConflictError();
    await client.query(`SET LOCAL search_path = ${names.schema}, pg_catalog`);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `native-preview-policy:${input.environmentId}`,
    ]);
    const existing = await client.query(
      "SELECT to_regclass($1) IS NOT NULL AS ledger,to_regclass($2) IS NOT NULL AS policy",
      [
        `${names.schema}.native_preview_policy_migrations`,
        `${names.schema}.native_preview_realm_policy`,
      ],
    );
    if (existing.rows[0]?.["ledger"] !== true) {
      if (existing.rows[0]?.["policy"] === true) throw new DatabaseProviderConflictError();
      await client.query(
        `CREATE TABLE ${names.schema}.native_preview_policy_migrations(version integer PRIMARY KEY,digest text NOT NULL)`,
      );
      await client.query(NATIVE_PREVIEW_POLICY_SQL);
      await client.query(
        `INSERT INTO ${names.schema}.native_preview_policy_migrations(version,digest) VALUES($1,$2)`,
        [PREVIEW_NATIVE_POLICY_SCHEMA_VERSION, PREVIEW_NATIVE_POLICY_SCHEMA_SHA256],
      );
    }
    const ledger = await client.query(
      `SELECT version,digest FROM ${names.schema}.native_preview_policy_migrations ORDER BY version`,
    );
    if (
      ledger.rows.length !== 1 ||
      ledger.rows[0]?.["version"] !== 1 ||
      ledger.rows[0]?.["digest"] !== PREVIEW_NATIVE_POLICY_SCHEMA_SHA256
    )
      throw new DatabaseProviderConflictError();
    const shape = await client.query(
      `SELECT c.relowner=current_user::regrole AND c.relkind='r'
    AND (SELECT array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['preview_id:text','auth_generation:bigint','enabled:boolean','revocation_epoch:bigint','configuration_revision:bigint']::text[]
    AND EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p' AND pg_get_constraintdef(k.oid)='PRIMARY KEY (preview_id, auth_generation)') AS safe
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='native_preview_realm_policy'`,
      [names.schema],
    );
    if (shape.rows.length !== 1 || shape.rows[0]?.["safe"] !== true)
      throw new DatabaseProviderConflictError();
    await client.query(
      `REVOKE ALL ON ${names.schema}.native_preview_policy_migrations FROM PUBLIC, ${names.runtime}, ${names.backup}`,
    );
    await client.query(
      `REVOKE ALL ON ${names.schema}.native_preview_realm_policy FROM PUBLIC, ${names.runtime}, ${names.backup}`,
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE ON ${names.schema}.native_preview_realm_policy TO ${names.runtime}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
