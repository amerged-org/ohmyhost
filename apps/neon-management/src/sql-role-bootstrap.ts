import { projectSqlRoleName } from "@ohmyhost/platform";

interface SqlRoleClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}
class SqlRoleBootstrapError extends Error {
  constructor(
    readonly code:
      | "sql_role_conflict"
      | "sql_role_helper_conflict"
      | "sql_role_helper_unavailable"
      | "sql_role_custom_predicate",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "SqlRoleBootstrapError";
  }
}
/** New connections must really authenticate as the restricted role, not SET ROLE from an owner. */
export async function verifyProjectSqlRoleLogin(client: SqlRoleClient, name: string) {
  if (!/^ohmyho_(?:m|ro|rw)_[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(name))
    throw new SqlRoleBootstrapError("sql_role_conflict");
  const result = await client.query(`${ROLE_SQL} AND current_user=$1 AND session_user=$1`, [name]);
  assertSqlRole(result.rows[0], name);
}
function assertSqlRole(value: Record<string, unknown> | undefined, name: string) {
  if (
    !value ||
    value["rolname"] !== name ||
    value["rolcanlogin"] !== true ||
    value["rolsuper"] !== false ||
    value["rolcreatedb"] !== false ||
    value["rolcreaterole"] !== false ||
    value["rolreplication"] !== false ||
    value["rolbypassrls"] !== false ||
    value["member_of_any_role"] !== false
  )
    throw new SqlRoleBootstrapError("sql_role_conflict");
}
const ROLE_SQL = `SELECT role.rolname,role.rolcanlogin,role.rolsuper,role.rolcreatedb,role.rolcreaterole,role.rolreplication,role.rolbypassrls,
  EXISTS(SELECT 1 FROM pg_auth_members membership WHERE membership.member=role.oid) AS member_of_any_role
  FROM pg_roles role WHERE role.rolname=$1`;
/** Trusted preparation runs before customer policies and never replaces an existing helper. */
export async function prepareProjectRlsHelpers(client: SqlRoleClient, environmentId: string) {
  const migration = projectSqlRoleName(environmentId, "migration");
  const runtime = projectSqlRoleName(environmentId, "runtime");
  const readonly = projectSqlRoleName(environmentId, "readonly");
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ohmyhost:migrations', 0))");
    await client.query("CREATE SCHEMA IF NOT EXISTS ohmyhost");
    const schema = await client.query(
      "SELECT nspowner=$1::text::regrole AND current_user::text=$1::text AS owned FROM pg_namespace WHERE nspname='ohmyhost'",
      [migration],
    );
    if (schema.rows.length !== 1 || schema.rows[0]?.["owned"] !== true)
      throw new SqlRoleBootstrapError("sql_role_helper_conflict");
    const existing = await client.query(RLS_HELPERS_SQL, [
      migration,
      RLS_USER_ID_BODY,
      RLS_CLAIMS_BODY,
    ]);
    const names = new Set<string>();
    for (const row of existing.rows) {
      const name = row["proname"];
      if (
        (name !== "user_id" && name !== "claims") ||
        row["known_helper"] !== true ||
        names.has(name)
      )
        throw new SqlRoleBootstrapError("sql_role_helper_conflict");
      names.add(name);
    }
    for (const [name, result, body] of [
      ["user_id", "text", RLS_USER_ID_BODY],
      ["claims", "jsonb", RLS_CLAIMS_BODY],
    ] as const) {
      if (!names.has(name))
        await client.query(
          `CREATE FUNCTION ohmyhost.${name}() RETURNS pg_catalog.${result} LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $omh_rls$${body}$omh_rls$`,
        );
    }
    await client.query(`REVOKE CREATE ON SCHEMA ohmyhost FROM PUBLIC,${runtime},${readonly}`);
    await client.query(`GRANT USAGE ON SCHEMA ohmyhost TO ${runtime},${readonly}`);
    await client.query("REVOKE ALL ON FUNCTION ohmyhost.user_id(),ohmyhost.claims() FROM PUBLIC");
    await client.query(
      `GRANT EXECUTE ON FUNCTION ohmyhost.user_id(),ohmyhost.claims() TO ${runtime},${readonly}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SqlRoleBootstrapError) throw error;
    throw new SqlRoleBootstrapError("sql_role_helper_unavailable");
  }
}

const RLS_USER_ID_BODY =
  "SELECT NULLIF(pg_catalog.current_setting('ohmyhost.request_claims', true), '')::pg_catalog.jsonb ->> 'sub'";
const RLS_CLAIMS_BODY =
  "SELECT COALESCE(NULLIF(pg_catalog.current_setting('ohmyhost.request_claims', true), '')::pg_catalog.jsonb, '{}'::pg_catalog.jsonb)";
const RLS_HELPERS_SQL = `SELECT procedure.proname,
  (procedure.proowner=$1::regrole AND procedure.prokind='f' AND procedure.pronargs=0
   AND procedure.proargtypes=''::oidvector AND procedure.proallargtypes IS NULL
   AND procedure.proargmodes IS NULL AND procedure.proargnames IS NULL AND procedure.pronargdefaults=0
   AND procedure.provariadic=0 AND NOT procedure.proretset AND NOT procedure.proisstrict
   AND language.lanname='sql' AND procedure.provolatile='s' AND procedure.proparallel='u'
   AND NOT procedure.prosecdef AND NOT procedure.proleakproof
   AND procedure.proconfig=ARRAY['search_path=pg_catalog']::text[]
   AND ((procedure.proname='user_id' AND procedure.prorettype='text'::regtype AND procedure.prosrc=$2)
     OR (procedure.proname='claims' AND procedure.prorettype='jsonb'::regtype AND procedure.prosrc=$3))) AS known_helper
  FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
  JOIN pg_language language ON language.oid=procedure.prolang
  WHERE namespace.nspname='ohmyhost' AND procedure.proname IN ('user_id','claims')`;

/** Only the exact emitted helper is adapted; the caller already transferred ownership. */
export async function adaptGeneratedServiceRolePredicate(client: SqlRoleClient) {
  const references = await client.query(LEGACY_RUNTIME_FUNCTIONS_SQL, [LEGACY_SERVICE_ROLE_BODY]);
  if (references.rows.some((row) => row["known_helper"] !== true))
    throw new SqlRoleBootstrapError("sql_role_custom_predicate");
  if (references.rows.length === 0) return false;
  const owner = await client.query(
    "SELECT proowner=current_user::regrole AS owned FROM pg_proc WHERE oid='public.is_service_role_request()'::regprocedure",
  );
  if (owner.rows[0]?.["owned"] !== true)
    throw new SqlRoleBootstrapError("sql_role_custom_predicate");
  await client.query(`CREATE OR REPLACE FUNCTION public.is_service_role_request() RETURNS boolean LANGUAGE sql STABLE AS $omh_service$
  SELECT current_user ~ '^ohmyho_rw_[0-7][0-9a-hjkmnp-tv-z]{25}$'
    AND current_setting('app.service_request', true) = 'on'
$omh_service$`);
  return true;
}
const LEGACY_SERVICE_ROLE_BODY =
  "\n  SELECT current_user = 'ohmyho_runtime'\n    AND current_setting('app.service_request', true) = 'on'\n";
const LEGACY_RUNTIME_FUNCTIONS_SQL = `SELECT procedure.oid::text AS oid,procedure.oid::regprocedure::text AS routine,
  md5(procedure.prosrc) AS fingerprint,
  (namespace.nspname='public' AND procedure.proname='is_service_role_request' AND procedure.pronargs=0
   AND procedure.prorettype='boolean'::regtype AND language.lanname='sql' AND procedure.provolatile='s'
   AND NOT procedure.prosecdef AND procedure.proconfig IS NULL AND procedure.prosrc=$1) AS known_helper
  FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace JOIN pg_language language ON language.oid=procedure.prolang
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND procedure.prosrc ~* 'current_user[[:space:]]*=[[:space:]]*''ohmyho_runtime'''`;

/** The login really is the owner of its database, not a role that was switched to; only the owner runs the owner grants. */
export async function isDatabaseOwnerLogin(client: SqlRoleClient, name: string): Promise<boolean> {
  const owner = await client.query(
    "SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=current_user::regrole AND current_user=$1 AND session_user=$1",
    [name],
  );
  return owner.rows.length === 1;
}
