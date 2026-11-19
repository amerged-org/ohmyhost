import { parseUlid } from "../../shared/ulid.js";
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;

export function createDatabaseRoleBootstrapStatements(databaseName: string): readonly string[] {
  if (!DATABASE_NAME.test(databaseName)) throw new TypeError("Database name is invalid");
  return Object.freeze([
    `REVOKE CREATE ON DATABASE ${databaseName} FROM PUBLIC`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT CREATE ON DATABASE ${databaseName} TO ohmyho_migration`,
    "GRANT USAGE, CREATE ON SCHEMA public TO ohmyho_migration",
    "GRANT USAGE ON SCHEMA public TO ohmyho_runtime, ohmyho_readonly",
  ]);
}

export const DATABASE_RUNTIME_GRANT_STATEMENTS = Object.freeze([
  "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ohmyho_runtime",
  "GRANT SELECT ON ALL TABLES IN SCHEMA public TO ohmyho_readonly",
  "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ohmyho_runtime",
  "GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ohmyho_readonly",
  "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ohmyho_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ohmyho_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ohmyho_readonly",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ohmyho_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO ohmyho_readonly",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ohmyho_runtime",
]);

/**
 * Takes the shared read-only role off the customer auth schema, for databases whose older migrations granted it there.
 * Dropping a grant from the current statements does not remove the one an earlier migration left, so the statements
 * revoke it explicitly: the tables, the sequences, the schema and the default privileges of later relations.
 */
export function projectSqlAuthReaderRevokes(readonly: string): readonly string[] {
  return [
    `REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM ${readonly}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM ${readonly}`,
    `REVOKE USAGE ON SCHEMA auth FROM ${readonly}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE SELECT ON TABLES FROM ${readonly}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE SELECT ON SEQUENCES FROM ${readonly}`,
  ];
}

export const DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS = Object.freeze([
  "GRANT USAGE ON SCHEMA auth TO ohmyho_runtime",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO ohmyho_runtime",
  "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth TO ohmyho_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ohmyho_runtime",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ohmyho_runtime",
  ...projectSqlAuthReaderRevokes("ohmyho_readonly"),
]);

export type SqlRolePurpose = "migration" | "readonly" | "runtime";
export const DATABASE_SQL_ROLE_PURPOSES = Object.freeze([
  "migration",
  "readonly",
  "runtime",
] as const);
/** Fixed policy; role names are scoped identities, never accepted from a customer request. */
export function projectSqlRoleName(environmentId: string, purpose: SqlRolePurpose): string {
  parseUlid(environmentId);
  const prefix = { migration: "m", readonly: "ro", runtime: "rw" }[purpose];
  if (!prefix) throw new TypeError("Invalid SQL role purpose");
  return `ohmyho_${prefix}_${environmentId.toLowerCase()}`;
}
/**
 * The pg_catalog functions that PostgreSQL lets PUBLIC execute and that let a login persist state or WAL: the three
 * large-object creators (a persistent large object, which also keeps a role from being dropped) and the two
 * `pg_logical_emit_message` signatures (a WAL record of up to 1 GB per call). A login that holds no write privilege
 * can fill the volume with any of them. Only a superuser changes these ACLs: PGCF revokes them from PUBLIC and grants
 * them to the database owner WITH GRANT OPTION. This is the one list of them, for the grant and for the read proof.
 * The signatures are those of PostgreSQL 17 and later (the fourth argument of `pg_logical_emit_message` is `flush`);
 * PGCF runs PostgreSQL 18, and on an older server the GRANT would fail with undefined_function.
 */
export const PERSISTING_FUNCTION_SIGNATURES = Object.freeze([
  "pg_catalog.lo_create(oid)",
  "pg_catalog.lo_creat(integer)",
  "pg_catalog.lo_from_bytea(oid,bytea)",
  "pg_catalog.pg_logical_emit_message(boolean,text,text,boolean)",
  "pg_catalog.pg_logical_emit_message(boolean,text,bytea,boolean)",
] as const);

/**
 * The three owner statements that decide TEMPORARY and the persisting functions: PUBLIC loses TEMPORARY, the migration
 * and runtime roles keep it, and the contained GRANT of the five functions (see `projectSqlRoleGrants`). The one source
 * of `projectSqlRoleGrants` and `projectSqlPersistenceGrants`.
 */
function persistenceStatements(environmentId: string, databaseName: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(databaseName)) throw new TypeError("Invalid database name");
  const writers = `${projectSqlRoleName(environmentId, "migration")},${projectSqlRoleName(environmentId, "runtime")}`;
  return {
    revokeTemporary: `REVOKE TEMPORARY ON DATABASE ${databaseName} FROM PUBLIC`,
    grantTemporary: `GRANT TEMPORARY ON DATABASE ${databaseName} TO ${writers}`,
    grantFunctions: `DO $omh_persisting_functions$ BEGIN GRANT EXECUTE ON FUNCTION ${PERSISTING_FUNCTION_SIGNATURES.join(",")} TO ${writers}; EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING 'persisting functions were not granted to the migration and runtime roles: the database owner does not hold them'; END $omh_persisting_functions$`,
  };
}

/**
 * Only the three statements above, in their order, for the owner connection that issues a read credential: an
 * environment that has not migrated since they existed, or that lost the functions to the PGCF baseline, gets them
 * without waiting for a deploy. Idempotent; run in one transaction so the writing roles never see PUBLIC's TEMPORARY
 * revoked before their own is granted.
 */
export function projectSqlPersistenceGrants(environmentId: string, databaseName: string) {
  const { revokeTemporary, grantTemporary, grantFunctions } = persistenceStatements(
    environmentId,
    databaseName,
  );
  return [revokeTemporary, grantTemporary, grantFunctions];
}

/**
 * Run by the database owner on every migration. A read-only member holds none of the volume-writing defaults of
 * PostgreSQL: temporary tables and the persisting functions stay with the two roles that write.
 *
 * The owner's GRANT of the persisting functions depends on what PGCF has done to the database. While PUBLIC still
 * holds them it is a no-op (a warning). Once PGCF has revoked them from PUBLIC and granted them to the owner WITH
 * GRANT OPTION it takes effect. If PGCF revoked them but the owner holds nothing, PostgreSQL raises
 * insufficient_privilege, which would abort the migration and the deployment; the statement is therefore contained in
 * a DO block that turns that error into a warning, and it runs after every essential grant. The migration and runtime
 * roles then lack the functions until the owner holds them and the next migration runs again.
 */
export function projectSqlRoleGrants(environmentId: string, databaseName: string) {
  const { revokeTemporary, grantTemporary, grantFunctions } = persistenceStatements(
    environmentId,
    databaseName,
  );
  const migration = projectSqlRoleName(environmentId, "migration"),
    runtime = projectSqlRoleName(environmentId, "runtime"),
    readonly = projectSqlRoleName(environmentId, "readonly");
  return [
    `REVOKE CREATE ON DATABASE ${databaseName} FROM PUBLIC`,
    revokeTemporary,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT CONNECT ON DATABASE ${databaseName} TO ${migration},${runtime},${readonly}`,
    `GRANT CREATE ON DATABASE ${databaseName} TO ${migration}`,
    grantTemporary,
    `GRANT USAGE,CREATE ON SCHEMA public TO ${migration}`,
    `GRANT USAGE ON SCHEMA public TO ${runtime},${readonly}`,
    grantFunctions,
    `ALTER ROLE ${runtime} SET search_path = auth,public`,
    `ALTER ROLE ${runtime} SET statement_timeout = '10s'`,
    `ALTER ROLE ${runtime} SET idle_in_transaction_session_timeout = '5s'`,
    `DO $omh_timeout$ BEGIN IF current_setting('server_version_num')::integer >= 170000 THEN EXECUTE 'ALTER ROLE ${runtime} SET transaction_timeout = ''30s'''; END IF; END $omh_timeout$`,
  ];
}
/**
 * Run by the migration role after its migrations and before the runtime grants. A SECURITY DEFINER function runs with
 * its owner's rights, so PUBLIC may not execute the ones this role owns: the runtime keeps its own grant from
 * `projectSqlRuntimeGrants`, and a read login gets none. The read proof refuses a credential whose role can still run one.
 */
export const PROJECT_SQL_DEFINER_REVOKE_STATEMENT = `DO $omh_definer$ DECLARE routine regprocedure; BEGIN FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND pg_get_userbyid(p.proowner)=current_user LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $omh_definer$`;
export function projectSqlRuntimeGrants(
  environmentId: string,
  customerAuth: boolean,
  additionalSchemas: readonly ("auth" | "private" | "extensions")[] = [],
) {
  if (additionalSchemas.some((schema) => !["auth", "private", "extensions"].includes(schema)))
    throw new TypeError("Invalid customer schema");
  const runtime = projectSqlRoleName(environmentId, "runtime"),
    readonly = projectSqlRoleName(environmentId, "readonly");
  return [...new Set(["public", ...(customerAuth ? ["auth"] : []), ...additionalSchemas])]
    .flatMap((schema) => {
      // The shared read-only role never reads the customer auth schema: it holds password hashes, OAuth and session
      // tokens, which a read credential or a prompt-injected query must not be able to select.
      const reader = schema === "auth" ? null : readonly;
      const readers = reader ? `${runtime},${reader}` : runtime;
      return [
        ...(reader ? [] : projectSqlAuthReaderRevokes(readonly)),
        `GRANT USAGE ON SCHEMA ${schema} TO ${readers}`,
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`,
        `GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime}`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO ${runtime}`,
        ...(reader
          ? [
              `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${reader}`,
              `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${reader}`,
              `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${reader}`,
              `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON SEQUENCES TO ${reader}`,
            ]
          : []),
        // The definer revoke takes PUBLIC's EXECUTE in every schema, so the runtime gets its own in each one, the
        // functions a migration creates there (an RLS helper such as private.is_member()) included.
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${runtime}`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${runtime}`,
      ];
    })
    .concat([
      `GRANT USAGE ON SCHEMA ohmyhost TO ${readonly}`,
      `GRANT SELECT ON TABLE ohmyhost.schema_migrations TO ${readonly}`,
    ]);
}
