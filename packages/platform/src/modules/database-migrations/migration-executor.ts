import {
  admitMigrationsAfterAppliedPrefix,
  DatabaseMigrationAdmissionError,
  parseDatabaseMigrationStatements,
  type DatabaseMigrationCaptureTrigger,
} from "./sql-admission.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
/** The pg_get_triggerdef(oid, true) shape of a PGCF capture trigger on PostgreSQL 18. */
const CAPTURE_TRIGGER_DEFINITION =
  /^CREATE TRIGGER \S+ AFTER (?:INSERT|DELETE|UPDATE)(?: OR (?:INSERT|DELETE|UPDATE))* ON .+ FOR EACH ROW EXECUTE FUNCTION pgcf\.capture\('[A-Za-z_][A-Za-z0-9_]*'(?:, '[A-Za-z_][A-Za-z0-9_]*')*\)$/u;

export interface DatabaseMigrationQueryResult<Row extends Readonly<Record<string, unknown>>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

/**
 * One customer statement, sent as a single extended-protocol command. PostgreSQL refuses a second command in such a
 * command, so a statement that the lexer read as one cannot run as several even if the lexer were wrong.
 */
export interface DatabaseMigrationPreparedStatement {
  readonly text: string;
  readonly values: unknown[];
  readonly queryMode: "extended";
}

export interface DatabaseMigrationClient {
  query<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>>(
    sql: string | DatabaseMigrationPreparedStatement,
    parameters?: readonly unknown[],
  ): Promise<DatabaseMigrationQueryResult<Row>>;
}

export interface VerifiedDatabaseMigration {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly body: Uint8Array;
}

export interface DatabaseMigrationReceipt {
  readonly appliedPaths: readonly string[];
  readonly replayedPaths: readonly string[];
  readonly completedAt: string;
}

export type DatabaseMigrationExecutionReason =
  | "catalog_changed"
  | "execution_failed"
  | "ledger_conflict"
  | "not_admitted"
  | "uncertain";

/**
 * A refused migration run or an uncertain outcome. For a proven rollback, `path` names the
 * customer's migration file the reason concerns; it is null when no single file is to blame.
 * `uncertain` never claims that a commit or rollback did or did not occur.
 */
export class DatabaseMigrationExecutionError extends Error {
  public readonly code = "database_migration_execution_failed";
  public readonly statementIndex?: number;
  public readonly sqlstate?: string;

  public constructor(
    public readonly reason: DatabaseMigrationExecutionReason,
    public readonly path: string | null = null,
    diagnostic?: Readonly<{ statementIndex: number; sqlstate?: string }>,
  ) {
    super("Database migration execution failed");
    this.name = "DatabaseMigrationExecutionError";
    if (diagnostic !== undefined) {
      this.statementIndex = diagnostic.statementIndex;
      if (diagnostic.sqlstate !== undefined) this.sqlstate = diagnostic.sqlstate;
    }
  }
}

/**
 * The first migration file static admission refuses on its own, or null when only the set is. The first `appliedCount`
 * files are proven applied and held to the structural rules only, as in `admitMigrationsAfterAppliedPrefix`.
 */
export function firstNotAdmittedMigrationPath(
  migrations: readonly VerifiedDatabaseMigration[],
  appliedCount = 0,
): string | null {
  for (const [index, migration] of migrations.entries()) {
    try {
      admitMigrationsAfterAppliedPrefix([migration], index < appliedCount ? 1 : 0);
    } catch (error) {
      if (error instanceof DatabaseMigrationAdmissionError) return migration.path;
      throw error;
    }
  }
  return null;
}

export async function executeExpandOnlyMigrations(
  client: DatabaseMigrationClient,
  migrations: readonly VerifiedDatabaseMigration[],
): Promise<DatabaseMigrationReceipt> {
  if (typeof client?.query !== "function") throw new TypeError("Migration client is invalid");
  // The ledger is only readable under the migrations lock, so the bundle is first held to its structural rules alone.
  admitBundle(migrations, migrations.length);
  await validateMigrationDigests(migrations);
  let committing = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Match the lexical reader's ordinary-string rules on every migration connection.
    await client.query("SET LOCAL standard_conforming_strings = on");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ohmyhost:migrations', 0))");
    await client.query("CREATE SCHEMA IF NOT EXISTS ohmyhost");
    await client.query(`CREATE TABLE IF NOT EXISTS ohmyhost.schema_migrations(
      path text PRIMARY KEY,
      sha256 bytea NOT NULL CHECK(octet_length(sha256)=32),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const ledger = await readLedger(client);
    validateLedgerPrefix(ledger, migrations);
    // Only the proven applied prefix skips today's SQL policy; pending files are admitted as a fresh deployment would.
    admitBundle(migrations, ledger.length);
    const before = await readCatalog(client);
    let rlsBefore: ReadonlyMap<string, string> = new Map(
      [...before].filter(
        ([identity]) => identity.startsWith("policy:") || identity.startsWith("row-security:"),
      ),
    );
    const appliedPaths: string[] = [];
    const allowedChanges = new Set<string>();
    const touchedTables = new Map<string, string>();
    const replayedPaths = ledger.map((entry) => entry.path);
    // A snapshot after every applied file names the file whose change breaks the catalog; the
    // verdict itself stays the one of the whole run, from the first to the last snapshot.
    const snapshots: Readonly<{
      path: string;
      catalog: ReadonlyMap<string, string>;
      allowedChanges: ReadonlySet<string>;
    }>[] = [];
    for (const migration of migrations.slice(ledger.length)) {
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(migration.body);
      try {
        for (const [index, statement] of parseDatabaseMigrationStatements(sql).entries()) {
          const statementChanges = new Set<string>();
          if (statement.rlsTarget !== undefined) {
            const target = statement.rlsTarget;
            const table = await verifyRlsTarget(
              client,
              target.schema,
              target.table,
              migration.path,
            );
            touchedTables.set(table, migration.path);
            const identity =
              target.policy === undefined
                ? `row-security:${table}`
                : `policy:${table}:${target.policy}`;
            statementChanges.add(identity);
            allowedChanges.add(identity);
          }
          if (statement.captureTrigger !== undefined) {
            const relation = await verifyCaptureTrigger(
              client,
              statement.captureTrigger,
              migration.path,
            );
            const identity = `capture:${relation}`;
            statementChanges.add(identity);
            allowedChanges.add(identity);
          }
          // A preceding customer statement can alter session settings. Every SQL
          // parse must use the same ordinary-string semantics as static admission.
          await client.query("SET LOCAL standard_conforming_strings = on");
          try {
            await client.query({ text: statement.sql, values: [], queryMode: "extended" });
          } catch (error) {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? error.code
                : undefined;
            // An interrupted transport, server shutdown or an unclassifiable client failure is
            // not proof that PostgreSQL rejected the customer's statement.
            if (
              !(error instanceof Error) ||
              error.name !== "error" ||
              !("severity" in error) ||
              error.severity !== "ERROR" ||
              typeof code !== "string" ||
              !/^[0-9A-Z]{5}$/u.test(code) ||
              code.startsWith("08") ||
              /^57P0[123]$/u.test(code)
            )
              throw new DatabaseMigrationExecutionError("uncertain");
            throw new DatabaseMigrationExecutionError("execution_failed", migration.path, {
              statementIndex: index + 1,
              sqlstate: code,
            });
          }
          const rlsAfter = await readCatalog(client, true);
          if (!preservesCatalog(rlsBefore, rlsAfter, statementChanges)) {
            throw new DatabaseMigrationExecutionError("catalog_changed", migration.path);
          }
          rlsBefore = rlsAfter;
        }
      } catch (error) {
        if (error instanceof DatabaseMigrationExecutionError) throw error;
        throw new DatabaseMigrationExecutionError("uncertain");
      }
      const inserted = await client.query(
        `INSERT INTO ohmyhost.schema_migrations(path,sha256)
         VALUES($1,decode($2,'hex')) ON CONFLICT DO NOTHING`,
        [migration.path, migration.digest.slice("sha256:".length)],
      );
      if (inserted.rowCount !== 1) {
        throw new DatabaseMigrationExecutionError("ledger_conflict", migration.path);
      }
      appliedPaths.push(migration.path);
      snapshots.push({
        path: migration.path,
        catalog: await readCatalog(client),
        allowedChanges: new Set(allowedChanges),
      });
    }
    const after = snapshots.at(-1)?.catalog ?? (await readCatalog(client));
    if (!preservesCatalog(before, after, allowedChanges)) {
      throw new DatabaseMigrationExecutionError(
        "catalog_changed",
        snapshots.find(
          (snapshot) => !preservesCatalog(before, snapshot.catalog, snapshot.allowedChanges),
        )?.path ?? null,
      );
    }
    for (const [table, path] of touchedTables) {
      if (after.get(`row-security:${table}`) !== "true:true") {
        throw new DatabaseMigrationExecutionError("catalog_changed", path);
      }
    }
    // Customer functions may execute during DDL; catalog equality alone does not
    // prove that the immutable ledger still contains exactly this verified bundle.
    const finalLedger = await readLedger(client);
    if (
      finalLedger.length !== migrations.length ||
      finalLedger.some(
        (entry, index) =>
          entry.path !== migrations[index]?.path || entry.digest !== migrations[index]?.digest,
      )
    ) {
      throw new DatabaseMigrationExecutionError("ledger_conflict", appliedPaths.at(-1) ?? null);
    }
    const time = await client.query<{ completed_at: Date }>(
      "SELECT clock_timestamp() completed_at",
    );
    const completedAt = time.rows[0]?.completed_at;
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
      throw new DatabaseMigrationExecutionError("execution_failed");
    }
    committing = true;
    await client.query("COMMIT");
    return Object.freeze({
      appliedPaths: Object.freeze(appliedPaths),
      replayedPaths: Object.freeze(replayedPaths),
      completedAt: completedAt.toISOString(),
    });
  } catch (error) {
    if (committing) throw new DatabaseMigrationExecutionError("uncertain");
    try {
      await client.query("ROLLBACK");
    } catch {
      throw new DatabaseMigrationExecutionError("uncertain");
    }
    if (
      error instanceof DatabaseMigrationExecutionError &&
      (error.reason !== "execution_failed" ||
        (error.statementIndex !== undefined && error.sqlstate !== undefined))
    )
      throw error;
    throw new DatabaseMigrationExecutionError("uncertain");
  }
}

function admitBundle(migrations: readonly VerifiedDatabaseMigration[], appliedCount: number): void {
  try {
    admitMigrationsAfterAppliedPrefix(migrations, appliedCount);
  } catch (error) {
    if (!(error instanceof DatabaseMigrationAdmissionError)) throw error;
    throw new DatabaseMigrationExecutionError(
      "not_admitted",
      firstNotAdmittedMigrationPath(migrations, appliedCount),
    );
  }
}

interface LedgerRow extends Readonly<Record<string, unknown>> {
  readonly path: string;
  readonly sha256: Uint8Array;
}

async function readLedger(client: DatabaseMigrationClient) {
  const result = await client.query<LedgerRow>(
    "SELECT path,sha256 FROM ohmyhost.schema_migrations ORDER BY path",
  );
  return result.rows.map((row) => {
    if (typeof row.path !== "string" || !(row.sha256 instanceof Uint8Array)) {
      throw new DatabaseMigrationExecutionError("ledger_conflict");
    }
    return Object.freeze({ path: row.path, digest: `sha256:${hex(row.sha256)}` as const });
  });
}

// An applied file is immutable: the ledger names the first applied file the bundle changed,
// renamed or dropped.
function validateLedgerPrefix(
  ledger: readonly Readonly<{ path: string; digest: `sha256:${string}` }>[],
  migrations: readonly VerifiedDatabaseMigration[],
): void {
  for (const [index, entry] of ledger.entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      migration.path !== entry.path ||
      migration.digest !== entry.digest
    ) {
      throw new DatabaseMigrationExecutionError("ledger_conflict", entry.path);
    }
  }
}

async function validateMigrationDigests(migrations: readonly VerifiedDatabaseMigration[]) {
  for (const migration of migrations) {
    if (
      !DIGEST_PATTERN.test(migration.digest) ||
      migration.size !== migration.body.byteLength ||
      migration.digest !== `sha256:${await sha256(migration.body)}`
    ) {
      throw new TypeError("Verified migration digest is invalid");
    }
  }
}

async function readCatalog(
  client: DatabaseMigrationClient,
  rlsOnly = false,
): Promise<ReadonlyMap<string, string>> {
  const result = await client.query<{ identity: string; definition: string }>(
    rlsOnly ? RLS_CATALOG_SNAPSHOT_SQL : CATALOG_SNAPSHOT_SQL,
  );
  const snapshot = new Map<string, string>();
  for (const row of result.rows) {
    if (
      typeof row.identity !== "string" ||
      row.identity.length === 0 ||
      typeof row.definition !== "string" ||
      snapshot.has(row.identity)
    ) {
      throw new DatabaseMigrationExecutionError("execution_failed");
    }
    snapshot.set(row.identity, row.definition);
  }
  return snapshot;
}

/** Whether `after` only adds to `before`: nothing existing changes and nothing new binds it. */
function preservesCatalog(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  allowedChanges: ReadonlySet<string>,
): boolean {
  for (const [identity, definition] of before) {
    if (!allowedChanges.has(identity) && after.get(identity) !== definition) return false;
  }
  for (const [identity, definition] of after) {
    if (identity.startsWith("policy:") && allowedChanges.has(identity)) {
      if (!definition.startsWith("public=true:")) return false;
    }
    if (before.has(identity)) continue;
    if (identity.startsWith("policy:") && !allowedChanges.has(identity)) return false;
    if (
      identity.startsWith("row-security:") &&
      definition !== "false:false" &&
      !allowedChanges.has(identity)
    )
      return false;
  }
  const existingRelations = new Set(
    [...before.keys()]
      .map((identity) => /^relation:(\d+)$/u.exec(identity)?.[1])
      .filter((value): value is string => value !== undefined),
  );
  for (const [identity, definition] of after) {
    if (before.has(identity)) continue;
    const columnRelation = /^column:(\d+):\d+$/u.exec(identity)?.[1];
    if (
      columnRelation !== undefined &&
      existingRelations.has(columnRelation) &&
      !/^[^:]+:false:::$/u.test(definition)
    ) {
      return false;
    }
    const attachedRelation = /^(?:constraint|trigger):(\d+):\d+$/u.exec(identity)?.[1];
    if (
      attachedRelation !== undefined &&
      existingRelations.has(attachedRelation) &&
      !isVerifiedCapture(identity, definition, attachedRelation, allowedChanges)
    )
      return false;
    const indexRelation = /^parent=(\d+)\|/u.exec(definition)?.[1];
    if (
      identity.startsWith("index:") &&
      indexRelation !== undefined &&
      existingRelations.has(indexRelation) &&
      /\|CREATE UNIQUE INDEX\b/iu.test(definition)
    ) {
      return false;
    }
  }
  return true;
}

/** Only the verified capture target may gain the PGCF capture trigger, and no other trigger. */
function isVerifiedCapture(
  identity: string,
  definition: string,
  relation: string,
  allowedChanges: ReadonlySet<string>,
): boolean {
  return (
    identity.startsWith("trigger:") &&
    allowedChanges.has(`capture:${relation}`) &&
    CAPTURE_TRIGGER_DEFINITION.test(definition)
  );
}

/** Resolve the one table of a capture trigger, with every column it publishes present. */
async function verifyCaptureTrigger(
  client: DatabaseMigrationClient,
  target: DatabaseMigrationCaptureTrigger,
  path: string,
): Promise<string> {
  const result = await client.query<{ oid: string; eligible: boolean; found: number }>(
    `SELECT c.oid::text AS oid,
      (c.relkind='r' AND NOT c.relispartition AND c.relpersistence='p' AND c.relowner=current_user::regrole
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal
         AND t.tgfoid=to_regprocedure('pgcf.capture()'))) AS eligible,
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
         AND a.attname::text = ANY($3::text[]))::int AS found
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname=$2`,
    [target.schema, target.table, [...target.columns]],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.eligible !== true ||
    row.found !== target.columns.length ||
    !/^\d+$/u.test(row.oid)
  ) {
    throw new DatabaseMigrationExecutionError("not_admitted", path);
  }
  return row.oid;
}

/** Resolve explicit schema/name bindings before executing each RLS operation. */
async function verifyRlsTarget(
  client: DatabaseMigrationClient,
  schema: "public" | "private",
  table: string,
  path: string,
): Promise<string> {
  const result = await client.query<{ oid: string; eligible: boolean }>(
    `SELECT c.oid::text AS oid,
      (c.relkind='r' AND NOT c.relispartition AND c.relowner=current_user::regrole) AS eligible
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname=$2`,
    [schema, table],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.eligible !== true || !/^\d+$/u.test(row.oid)) {
    throw new DatabaseMigrationExecutionError("not_admitted", path);
  }
  return row.oid;
}

async function sha256(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>);
  return hex(new Uint8Array(digest));
}

function hex(body: Uint8Array): string {
  return Array.from(body, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CATALOG_SNAPSHOT_SQL = `WITH namespaces AS (
  SELECT oid,nspname FROM pg_namespace
  WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
), catalog AS (
  SELECT 'relation:'||c.oid identity,
         n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relpersistence::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'')||':'||coalesce(pg_get_viewdef(c.oid,true),'') definition
  FROM pg_class c JOIN namespaces n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT 'row-security:'||c.oid,c.relrowsecurity::text||':'||c.relforcerowsecurity::text
  FROM pg_class c JOIN namespaces n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p')
  UNION ALL
  SELECT 'policy:'||p.polrelid||':'||p.polname,
         'public='||(p.polroles=ARRAY[0]::oid[])::text||':'||p.polcmd::text||':'||p.polpermissive::text||':'||
         p.polroles::text||':'||coalesce(pg_get_expr(p.polqual,p.polrelid),'')||':'||
         coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  JOIN namespaces n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'column:'||c.oid||':'||a.attnum,
         format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||a.attidentity::text||':'||
         a.attgenerated::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  JOIN namespaces n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint:'||con.conrelid||':'||con.oid,
         pg_get_constraintdef(con.oid,true)
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
  JOIN namespaces n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'index:'||c.oid,'parent='||i.indrelid||'|'||pg_get_indexdef(c.oid)
  FROM pg_class c JOIN namespaces n ON n.oid=c.relnamespace
  JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relkind='i'
  UNION ALL
  SELECT 'function:'||p.oid,
         p.proowner::text||':'||coalesce(p.proacl::text,'')||':'||
         CASE WHEN p.prokind = 'a' THEN to_jsonb(p)::text||':'||to_jsonb(a)::text
              ELSE pg_get_functiondef(p.oid) END
  FROM pg_proc p JOIN namespaces n ON n.oid=p.pronamespace
  LEFT JOIN pg_aggregate a ON a.aggfnoid=p.oid
  UNION ALL
  SELECT 'trigger:'||t.tgrelid||':'||t.oid,pg_get_triggerdef(t.oid,true)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN namespaces n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'type:'||t.oid,
         t.typtype::text||':'||t.typcategory::text||':'||t.typnotnull||':'||coalesce(t.typdefault,'')
  FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace
  WHERE t.typtype IN ('c','d','e','r')
)
SELECT identity,definition FROM catalog ORDER BY identity`;

const RLS_CATALOG_SNAPSHOT_SQL = `/* migration RLS checkpoint */ ${CATALOG_SNAPSHOT_SQL.replace(
  "SELECT identity,definition FROM catalog ORDER BY identity",
  "SELECT identity,definition FROM catalog WHERE identity LIKE 'policy:%' OR identity LIKE 'row-security:%' ORDER BY identity",
)}`;
