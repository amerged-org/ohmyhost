// W24 foundation, lock protocol C0: one dedicated lock row per organization beside its identity
// mapping. Financial writers lock the mapping row first and the wallet row second, both FOR NO KEY
// UPDATE, so inserts that only KEY SHARE the mapping through a foreign key stop waiting for them,
// while released binaries (FOR UPDATE on the mapping) still exclude and are excluded by them.
// The table is derived from the mappings; released binaries never read it and no ledger or evidence
// table is touched here or by the downgrade.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // Each pgm.sql is a separate driver query. Arm the statement limit before executing DDL,
  // and restore prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_wallet_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
  pgm.sql(`
    -- Hold off mapping writers until this transaction commits: the backfill and the trigger below
    -- then cover exactly the same organizations.
    LOCK TABLE workos_organization_mappings IN SHARE ROW EXCLUSIVE MODE;
    CREATE TABLE organization_credit_wallets (
      organization_id ulid PRIMARY KEY
    );
    -- The trigger function qualifies the wallet table by the mapping's schema, so it must live there.
    DO $$ BEGIN
      IF (SELECT relnamespace FROM pg_class WHERE oid='organization_credit_wallets'::regclass)
        IS DISTINCT FROM (SELECT relnamespace FROM pg_class WHERE oid='workos_organization_mappings'::regclass) THEN
        RAISE EXCEPTION 'Credit wallets must live in the schema of the organization mappings';
      END IF;
    END $$;
    -- Backfill without per-parent FK KEY SHARE checks: released FOR UPDATE financial writers
    -- may still hold individual mapping rows while this short global table lock excludes changes.
    INSERT INTO organization_credit_wallets(organization_id)
      SELECT organization_id FROM workos_organization_mappings;
    ALTER TABLE organization_credit_wallets
      ADD CONSTRAINT organization_credit_wallets_organization_fk FOREIGN KEY(organization_id)
      REFERENCES workos_organization_mappings(organization_id) NOT VALID;
    -- Validation uses a snapshot join, not one KEY SHARE per parent. The committed schema always
    -- has a validated FK; any failure rolls the entire migration back.
    ALTER TABLE organization_credit_wallets VALIDATE CONSTRAINT organization_credit_wallets_organization_fk;
    -- Invoker rights, a fixed search_path and a schema-qualified target: correct in public, in a
    -- test schema and under any caller search_path.
    CREATE FUNCTION create_organization_credit_wallet() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      EXECUTE format('INSERT INTO %I.organization_credit_wallets(organization_id) VALUES($1)', TG_TABLE_SCHEMA)
        USING NEW.organization_id;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER workos_organization_mappings_credit_wallet AFTER INSERT ON workos_organization_mappings
      FOR EACH ROW EXECUTE FUNCTION create_organization_credit_wallet();
    -- Wallet rows only exist to be locked, never to change.
    CREATE TRIGGER organization_credit_wallets_append_only BEFORE UPDATE OR DELETE ON organization_credit_wallets
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    -- UPDATE is the privilege PostgreSQL requires for any FOR [NO KEY] UPDATE row lock; the trigger
    -- above keeps it from changing a row. No DELETE, TRUNCATE or DDL.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        REVOKE ALL ON organization_credit_wallets FROM control_runtime;
        GRANT SELECT,INSERT,UPDATE ON organization_credit_wallets TO control_runtime;
      END IF;
    END $$;
  `);
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_wallet_migration_timeouts;
           DROP TABLE pg_temp.w24_wallet_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DROP TRIGGER workos_organization_mappings_credit_wallet ON workos_organization_mappings;
    DROP FUNCTION create_organization_credit_wallet();
    DROP TABLE organization_credit_wallets;
  `);
}
