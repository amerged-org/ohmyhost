import { Client } from "pg";

/**
 * The pg_catalog functions PUBLIC may execute by default that let a login persist state or WAL: the large-object
 * creators and the two `pg_logical_emit_message` signatures (a SELECT-only login writes up to 1 GB of WAL per call).
 * Spelled out here on purpose, apart from the production list, so that a drift of that list shows as a failing test.
 */
export const PERSISTING_FUNCTIONS = [
  "pg_catalog.lo_create(oid)",
  "pg_catalog.lo_creat(integer)",
  "pg_catalog.lo_from_bytea(oid, bytea)",
  "pg_catalog.pg_logical_emit_message(boolean, text, text, boolean)",
  "pg_catalog.pg_logical_emit_message(boolean, text, bytea, boolean)",
] as const;
const CREATORS = PERSISTING_FUNCTIONS.join(", ");

/** One superuser session on one database: only a superuser can change a pg_catalog function ACL, and it is per database. */
async function inDatabase(superuserUrl: string, database: string, statements: readonly string[]) {
  const url = new URL(superuserUrl);
  url.pathname = `/${database}`;
  url.search = "";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * The PGCF baseline on one database: PUBLIC loses the five persisting functions and the database's owner role holds them
 * WITH GRANT OPTION, so the owner can pass them on to the roles that need them.
 */
export function applyPgcfBaseline(superuserUrl: string, database: string, owner: string) {
  return inDatabase(superuserUrl, database, [
    `REVOKE EXECUTE ON FUNCTION ${CREATORS} FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION ${CREATORS} TO ${owner} WITH GRANT OPTION`,
  ]);
}

/** The stock ACL again, as on a database the PGCF baseline has not reached: PUBLIC holds the five functions, nobody passes them on. */
export function undoPgcfBaseline(superuserUrl: string, database: string, owner: string) {
  return inDatabase(superuserUrl, database, [
    `REVOKE ALL ON FUNCTION ${CREATORS} FROM PUBLIC, ${owner} CASCADE`,
    `GRANT EXECUTE ON FUNCTION ${CREATORS} TO PUBLIC`,
  ]);
}

/** A database between baseline steps: PUBLIC lost the five functions, but the owner holds none of them to pass on. */
export function stripOwnerCreators(superuserUrl: string, database: string, owner: string) {
  return inDatabase(superuserUrl, database, [
    `REVOKE ALL ON FUNCTION ${CREATORS} FROM ${owner} CASCADE`,
  ]);
}

/**
 * The platform schema PGCF installs in every tenant database (pgcf `schema.sql`): owned by the superuser that applies
 * it, tables closed to PUBLIC, the schema usable by PUBLIC, SECURITY DEFINER functions owned by a NOLOGIN role.
 */
export function createPgcfPlatformSchema(superuserUrl: string, database: string, owner: string) {
  return inDatabase(superuserUrl, database, [
    `CREATE ROLE "pgcf-events" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
    "CREATE SCHEMA pgcf",
    "CREATE TABLE pgcf.settings (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), epoch bigint NOT NULL)",
    "CREATE TABLE pgcf.outbox (seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, epoch bigint NOT NULL, topic text NOT NULL, payload jsonb NOT NULL)",
    "REVOKE ALL ON TABLE pgcf.settings, pgcf.outbox FROM PUBLIC",
    "REVOKE ALL ON SCHEMA pgcf FROM PUBLIC",
    "GRANT USAGE ON SCHEMA pgcf TO PUBLIC",
    `GRANT SELECT ON TABLE pgcf.settings TO "pgcf-events"`,
    `GRANT SELECT, INSERT ON TABLE pgcf.outbox TO "pgcf-events"`,
    "CREATE FUNCTION pgcf.emit(topic text, payload jsonb) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, topic, payload) RETURNING seq $$",
    "CREATE FUNCTION pgcf.capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NULL; END $$",
    `ALTER FUNCTION pgcf.emit(text, jsonb) OWNER TO "pgcf-events"`,
    `ALTER FUNCTION pgcf.capture() OWNER TO "pgcf-events"`,
    "REVOKE ALL ON FUNCTION pgcf.emit(text, jsonb) FROM PUBLIC",
    "REVOKE ALL ON FUNCTION pgcf.capture() FROM PUBLIC",
    "GRANT EXECUTE ON FUNCTION pgcf.capture() TO PUBLIC",
    `GRANT EXECUTE ON FUNCTION pgcf.emit(text, jsonb) TO ${owner} WITH GRANT OPTION`,
  ]);
}

/** Runs superuser statements on one database, for example a deliberate grant that a proof has to refuse. */
export const asSuperuser = inDatabase;
