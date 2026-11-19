// W24 F06: a versioned, revision-fenced cache of the canonical credit expiry (policy v1).
//
// Expiry of a grant is a pure function of recorded payment and access facts; the clock is compared
// by the reader later, so crossing an expiry boundary never invalidates anything here. What
// invalidates is a change of a FACT the policy reads. Every actual change of such a fact bumps the
// organization's source_revision atomically, in the same transaction (invalidation matrix below).
// A refresh generation captures one revision and a finite grant upper key, computes bounded pages
// from the canonical policy inside the database, and may publish only while that revision is still
// current. A cache entry is ready only when the active revision equals the source revision; nothing
// ever clears or patches a stale pointer, and no reader here is wired into a product path yet.
//
// Invalidation matrix (INSERT always; UPDATE only when a listed column really changes, compared
// null-safe in the trigger WHEN clause; DELETE always; both organizations of a scope change):
//   organization_credit_grants            organization_id, grant_id, kind, source_reference, granted_at, expires_at
//   organization_credit_grant_adjustments organization_id, grant_id, amount_micros, occurred_at
//   organization_credit_grant_expirations organization_id, grant_id, expires_at
//   stripe_credit_payments                organization_id, grant_id, offer, account_id, mode, subscription_id,
//                                         invoice_id, period_start, period_end, paid_at, confirmed_at,
//                                         credited_micros, checkout_id
//   stripe_subscription_ends              organization_id, account_id, mode, subscription_id, ended_at
//   organization_paid_access_events       organization_id, event_id, occurred_at, enabled, paid_until
//   organization_paid_access              organization_id, enabled, updated_at, paid_until
//   stripe_checkout_requests              organization_id, checkout_id, created_at
//   stripe_recharge_attempts              organization_id, grant_id, created_at
// Movements, reservations, resolutions and the financial aggregate projections do not affect expiry
// and have no trigger. Existing append-only and identity guards fire BEFORE these AFTER triggers and
// are never weakened; for the append-only tables the UPDATE and DELETE triggers are dormant.
//
// Lock order: wallet C0 (mapping row, wallet row, both FOR NO KEY UPDATE), then the expiry state row,
// then build rows. start and publish take all three; advance locks only its build row and reads the
// state without a lock; cleanup locks only the (terminal) build row. A source trigger only updates
// the state row and never reads a build or takes a wallet afterwards. Existing financial writers hold
// C0 first. A caller that wants BOTH a metadata mutation (grant, payment, access, checkout, recharge,
// adjustment rows) AND later financial writes in one transaction must take C0 before the metadata
// mutation; arbitrary uncoordinated operator SQL has no acyclic lock-graph guarantee.
//
// Policy custody: the SQL below is GENERATED from the immutable credit-expiry-policy-v1.mjs by one
// reviewed deterministic rendering (every base relation qualified by @S@, the schema of the
// organization mappings; CTE aliases untouched) and committed as a literal. This file imports
// nothing and reads nothing at execution time, so its manifest hash pins every executed byte. A test
// asserts the literal equals the rendered v1 text; editing either requires regeneration and review,
// and a released v1 is never edited (a future rule is v2 with its own migration).

export const CREDIT_EXPIRY_POLICY_VERSION = "v1";
/** SHA-256 of the unchanged, unqualified UTF-8 v1 CREDIT_EXPIRY_CTES text. */
export const CREDIT_EXPIRY_POLICY_SHA256 =
  "2e9446e462ecc04c7606404a5e550feb9d08738a4a34cc8a87095ecb3e42e07c";

const POLICY_PAID_PAYMENTS = `
  paid_payments AS (
    SELECT p.*,
      CASE WHEN COALESCE(p.paid_at,p.confirmed_at)<p.period_start+interval '14 days' THEN p.period_start
        ELSE COALESCE(p.paid_at,p.confirmed_at) END AS covered_from,
      LEAST(p.period_end+interval '14 days',ended.ended_at) AS covered_until
    FROM @S@.stripe_credit_payments p LEFT JOIN @S@.stripe_subscription_ends ended
      ON ended.account_id=p.account_id AND ended.mode=p.mode AND ended.subscription_id=p.subscription_id
        AND ended.organization_id=p.organization_id
    WHERE p.organization_id=$1 AND p.offer='paid'
  )`;

// The v1 policy CTE list for organization $1, base relations qualified by the @S@ placeholder.
export const CREDIT_EXPIRY_POLICY_V1_SQL = `
  ${POLICY_PAID_PAYMENTS}, access_events AS (
    SELECT occurred_at,enabled,paid_until,
      lead(occurred_at) OVER (ORDER BY occurred_at,event_id) AS next_at
    FROM @S@.organization_paid_access_events WHERE organization_id=$1
  ), payment_changes AS (
    SELECT p.grant_id,p.covered_from AS at,0::bigint AS amount FROM paid_payments p
    UNION ALL
    SELECT a.grant_id,a.occurred_at,sum(a.amount_micros)::bigint
    FROM @S@.organization_credit_grant_adjustments a JOIN paid_payments p USING(grant_id)
    WHERE a.organization_id=$1 AND a.occurred_at>=p.covered_from AND a.occurred_at<p.covered_until
    GROUP BY a.grant_id,a.occurred_at
  ), payment_timeline AS (
    SELECT grant_id,at,sum(amount) AS delta FROM payment_changes GROUP BY grant_id,at
  ), payment_segments AS (
    SELECT t.grant_id,t.at,
      lead(t.at,1,p.covered_until) OVER (PARTITION BY t.grant_id ORDER BY t.at) AS until,
      sum(t.delta) OVER (PARTITION BY t.grant_id ORDER BY t.at) AS revoked,
      p.credited_micros
    FROM payment_timeline t JOIN paid_payments p USING(grant_id)
  ), paid_intervals AS (
    SELECT at AS since,until FROM payment_segments WHERE revoked<credited_micros
    UNION ALL
    SELECT occurred_at,LEAST(paid_until,next_at) FROM access_events WHERE enabled
    UNION ALL
    SELECT updated_at,paid_until FROM @S@.organization_paid_access
      WHERE organization_id=$1 AND enabled
  ), paid_coverage AS (
    SELECT unnest(range_agg(tstzrange(since,until,'[)'))) AS period
    FROM paid_intervals WHERE until IS NULL OR until>since
  ), credit_expiry AS (
    SELECT g.grant_id,
      CASE
        WHEN g.kind IN ('stripe_topup','stripe_recharge') THEN
          LEAST(preserved.expires_at,
            CASE WHEN coverage.period IS NULL THEN g.granted_at ELSE upper(coverage.period) END)
        WHEN g.kind IN ('paid_monthly','flag_paid_bonus') THEN COALESCE(p.period_end,g.expires_at)
        ELSE g.expires_at
      END AS expires_at,
      g.kind IN ('stripe_topup','stripe_recharge') AS is_topup
    FROM @S@.organization_credit_grants g
    LEFT JOIN @S@.organization_credit_grant_expirations preserved
      ON preserved.organization_id=g.organization_id AND preserved.grant_id=g.grant_id
    LEFT JOIN @S@.stripe_credit_payments purchase ON purchase.organization_id=g.organization_id AND purchase.grant_id=g.grant_id AND purchase.offer='topup'
    LEFT JOIN @S@.stripe_checkout_requests checkout ON checkout.checkout_id=purchase.checkout_id
    LEFT JOIN @S@.stripe_recharge_attempts recharge ON recharge.organization_id=g.organization_id AND recharge.grant_id=g.grant_id
    LEFT JOIN paid_coverage coverage ON g.kind IN ('stripe_topup','stripe_recharge')
      AND coverage.period @> COALESCE(checkout.created_at,recharge.created_at,g.granted_at)
    LEFT JOIN paid_payments p ON (g.kind='paid_monthly' AND p.grant_id=g.grant_id)
      OR (g.kind='flag_paid_bonus' AND g.source_reference=p.account_id||'/'||p.mode||'/'||p.invoice_id)
    WHERE g.organization_id=$1
  )`;

/**
 * The one statement an advance runs for a page: the canonical policy for organization $1 plus the
 * revision of the SAME statement snapshot, restricted to the selected grant ids $2. The restriction
 * is a plain `grant_id = ANY($2)` on the grant table, which the planner can push into the index
 * scan; a tiny table can legitimately use a sequential scan. Coverage history remains subject to
 * the page statement budget. The policy is unchanged; aggregates check exactly one row per grant.
 */
export const CREDIT_EXPIRY_PAGE_V1_SQL = `WITH${CREDIT_EXPIRY_POLICY_V1_SQL}, revision_now AS (
    SELECT s.source_revision FROM @S@.credit_expiry_state s WHERE s.organization_id=$1
  )
  SELECT array_agg(e.grant_id::text ORDER BY e.grant_id) AS grant_ids,
    array_agg(e.expires_at ORDER BY e.grant_id) AS expires_ats,
    array_agg(e.is_topup ORDER BY e.grant_id) AS is_topups,
    max(r.source_revision) AS source_revision,
    count(*) AS result_rows,
    count(DISTINCT e.grant_id) AS distinct_grants
  FROM credit_expiry e CROSS JOIN revision_now r
  WHERE e.grant_id = ANY($2::text[])`;

/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
const SOURCES = [
  [
    "organization_credit_grants",
    ["organization_id", "grant_id", "kind", "source_reference", "granted_at", "expires_at"],
  ],
  [
    "organization_credit_grant_adjustments",
    ["organization_id", "grant_id", "amount_micros", "occurred_at"],
  ],
  ["organization_credit_grant_expirations", ["organization_id", "grant_id", "expires_at"]],
  [
    "stripe_credit_payments",
    [
      "organization_id",
      "grant_id",
      "offer",
      "account_id",
      "mode",
      "subscription_id",
      "invoice_id",
      "period_start",
      "period_end",
      "paid_at",
      "confirmed_at",
      "credited_micros",
      "checkout_id",
    ],
  ],
  [
    "stripe_subscription_ends",
    ["organization_id", "account_id", "mode", "subscription_id", "ended_at"],
  ],
  [
    "organization_paid_access_events",
    ["organization_id", "event_id", "occurred_at", "enabled", "paid_until"],
  ],
  ["organization_paid_access", ["organization_id", "enabled", "updated_at", "paid_until"]],
  ["stripe_checkout_requests", ["organization_id", "checkout_id", "created_at"]],
  ["stripe_recharge_attempts", ["organization_id", "grant_id", "created_at"]],
];

const PUBLIC_FUNCTIONS = [
  "credit_expiry_start(text,text,text)",
  "credit_expiry_advance(text,text,integer)",
  "credit_expiry_publish(text,text,text)",
  "credit_expiry_cleanup(text,text,integer)",
];

// Owner-only: callable by no runtime role. Trigger functions run for the attached source events,
// which do not check EXECUTE of the writing role.
const PRIVATE_FUNCTIONS = [
  "credit_expiry_lock_organization(text)",
  "credit_expiry_invalidate_source()",
  "credit_expiry_create_state()",
  "credit_expiry_guard_state()",
  "credit_expiry_guard_build()",
];

const ALL_FUNCTIONS = [...PUBLIC_FUNCTIONS, ...PRIVATE_FUNCTIONS];

const MAPPING_TRIGGER = "workos_organization_mappings_credit_expiry_state";

// Every SECURITY DEFINER or trigger function is created through this wrapper. @S@ becomes the quoted
// schema that holds the organization mappings and @L@ the same name as a string literal: all
// relations and helpers in a body are qualified by it and the function's own search_path is only
// pg_catalog (then pg_temp last), so neither the caller's search_path nor a temporary object can
// substitute anything, in public or in a test schema.
const TRUSTED_SCHEMA = `(SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = 'workos_organization_mappings'::regclass)`;

/** @param {string} definition */
const inTrustedSchema = (definition) => `DO $install$ BEGIN
  EXECUTE replace(replace($definition$${definition}$definition$,
    '@S@', quote_ident(${TRUSTED_SCHEMA})), '@L@', quote_literal(${TRUSTED_SCHEMA}));
END $install$;`;

const FIXED_PATH = "SET search_path = pg_catalog, pg_temp";

/**
 * @param {string} table
 * @param {readonly string[]} columns
 */
function sourceTriggers(table, columns) {
  const changed = columns
    .map((column) => `OLD.${column} IS DISTINCT FROM NEW.${column}`)
    .join("\n        OR ");
  return `
    CREATE TRIGGER ${table}_credit_expiry_insert AFTER INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION credit_expiry_invalidate_source();
    CREATE TRIGGER ${table}_credit_expiry_update AFTER UPDATE ON ${table}
      FOR EACH ROW WHEN (${changed})
      EXECUTE FUNCTION credit_expiry_invalidate_source();
    CREATE TRIGGER ${table}_credit_expiry_delete AFTER DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION credit_expiry_invalidate_source();
  `;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  // These limits apply per statement, not to the total migration transaction.
  // The release runner commits each file separately; a total deadline requires a separate gate.
  pgm.sql(`CREATE TEMP TABLE w24_expiry_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_expiry_migration_timeouts;
           DROP TABLE pg_temp.w24_expiry_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  pgm.sql(`
    DO $check$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.oid IN ('organization_credit_wallets'::regclass,
          ${SOURCES.map(([table]) => `'${table}'::regclass`).join(",\n          ")})
          AND c.relnamespace IS DISTINCT FROM
            (SELECT relnamespace FROM pg_class WHERE oid = 'workos_organization_mappings'::regclass)
      ) THEN
        RAISE EXCEPTION 'Credit expiry projections require the credit ledger, payment, access and wallet tables in the schema of the organization mappings';
      END IF;
    END $check$;

    -- Pointers and the monotonic source revision, one row per organization. A missing row is an
    -- invariant failure, never a zero or a ready cache.
    CREATE TABLE credit_expiry_state (
      organization_id ulid PRIMARY KEY,
      source_revision bigint NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
      active_generation ulid,
      active_revision bigint CHECK (active_revision >= 0),
      building_generation ulid,
      CONSTRAINT credit_expiry_state_generations_differ CHECK (
        active_generation IS NULL OR building_generation IS NULL OR active_generation <> building_generation),
      CONSTRAINT credit_expiry_state_active_shape CHECK (
        (active_generation IS NULL) = (active_revision IS NULL)),
      CONSTRAINT credit_expiry_state_active_not_ahead CHECK (
        active_revision IS NULL OR active_revision <= source_revision)
    );

    -- One refresh generation. The generation is the caller's idempotency token; identity, policy
    -- version, target revision and the finite grant upper key never change after start.
    CREATE TABLE credit_expiry_builds (
      organization_id ulid NOT NULL REFERENCES credit_expiry_state(organization_id),
      generation ulid NOT NULL,
      policy_version text NOT NULL CHECK (policy_version = '${CREDIT_EXPIRY_POLICY_VERSION}'),
      target_revision bigint NOT NULL CHECK (target_revision >= 0),
      expected_active_generation ulid,
      grant_upper_id ulid,
      grant_cursor ulid,
      status text NOT NULL CHECK (status IN ('building','complete','active','retired','invalidated')),
      scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      written_count bigint NOT NULL DEFAULT 0 CHECK (written_count >= 0),
      created_at timestamptz NOT NULL,
      published_at timestamptz,
      PRIMARY KEY (organization_id, generation),
      CONSTRAINT credit_expiry_builds_expected_differs CHECK (
        expected_active_generation IS NULL OR expected_active_generation <> generation),
      CONSTRAINT credit_expiry_builds_cursor_bound CHECK (
        grant_cursor IS NULL OR (grant_upper_id IS NOT NULL AND grant_cursor <= grant_upper_id)),
      CONSTRAINT credit_expiry_builds_written_within_scanned CHECK (written_count <= scanned_count),
      CONSTRAINT credit_expiry_builds_publication_shape CHECK (
        (published_at IS NOT NULL) = (status IN ('active','retired'))),
      CONSTRAINT credit_expiry_builds_scan_finished CHECK (
        status NOT IN ('complete','active','retired')
        OR grant_upper_id IS NULL OR grant_cursor = grant_upper_id)
    );

    -- A cached lot. A NULL expires_at means "never expires", not a missing row: an active generation
    -- holds exactly one row per grant that existed at its start. The primary key serves the point
    -- lookup, the page keyset and the bounded cleanup.
    CREATE TABLE credit_expiry_lots (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      grant_id ulid NOT NULL,
      expires_at timestamptz,
      is_topup boolean NOT NULL,
      PRIMARY KEY (organization_id, generation, grant_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_expiry_builds(organization_id, generation)
    );

    -- The pointers reference validated builds. MATCH SIMPLE leaves a NULL pointer unchecked. No
    -- cache table references the wallet row.
    ALTER TABLE credit_expiry_state
      ADD CONSTRAINT credit_expiry_state_active_fk FOREIGN KEY (organization_id, active_generation)
        REFERENCES credit_expiry_builds(organization_id, generation),
      ADD CONSTRAINT credit_expiry_state_building_fk FOREIGN KEY (organization_id, building_generation)
        REFERENCES credit_expiry_builds(organization_id, generation);

    -- The functions below qualify every relation by the mapping schema, so the tables must live there.
    DO $placed$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.oid IN ('credit_expiry_state'::regclass, 'credit_expiry_builds'::regclass,
          'credit_expiry_lots'::regclass)
          AND c.relnamespace IS DISTINCT FROM
            (SELECT relnamespace FROM pg_class WHERE oid = 'workos_organization_mappings'::regclass)
      ) THEN
        RAISE EXCEPTION 'Credit expiry tables must live in the schema of the organization mappings';
      END IF;
    END $placed$;
  `);

  // Cache rows are written only by the owner-owned functions below; these guards additionally keep
  // the immutable parts immutable and the revision monotonic against any owner-level statement.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_guard_state() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.source_revision < OLD.source_revision
        OR (OLD.active_generation IS NOT NULL AND NEW.active_generation IS NULL)
        OR (OLD.active_revision IS NOT NULL AND NEW.active_revision < OLD.active_revision) THEN
        RAISE EXCEPTION 'Credit expiry state identity, revision and active pointer only move forward'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_guard_build() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.generation IS DISTINCT FROM OLD.generation
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.target_revision IS DISTINCT FROM OLD.target_revision
        OR NEW.expected_active_generation IS DISTINCT FROM OLD.expected_active_generation
        OR NEW.grant_upper_id IS DISTINCT FROM OLD.grant_upper_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Credit expiry build identity, revision and upper bound are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'building' AND NEW.status IN ('complete', 'invalidated'))
        OR (OLD.status = 'complete' AND NEW.status IN ('active', 'invalidated'))
        OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
        RAISE EXCEPTION 'Credit expiry build status transition is not allowed' USING ERRCODE = '55000';
      END IF;
      IF NEW.scanned_count < OLD.scanned_count OR NEW.written_count < OLD.written_count
        OR (NEW.grant_cursor IS DISTINCT FROM OLD.grant_cursor
          AND (NEW.grant_cursor IS NULL
            OR (OLD.grant_cursor IS NOT NULL AND NEW.grant_cursor <= OLD.grant_cursor))) THEN
        RAISE EXCEPTION 'Credit expiry build progress only moves forward' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $body$;`),
  );

  pgm.sql(`
    CREATE TRIGGER credit_expiry_state_guard BEFORE UPDATE ON credit_expiry_state
      FOR EACH ROW EXECUTE FUNCTION credit_expiry_guard_state();
    CREATE TRIGGER credit_expiry_builds_guard BEFORE UPDATE ON credit_expiry_builds
      FOR EACH ROW EXECUTE FUNCTION credit_expiry_guard_build();
  `);

  // C0: mapping row, then wallet row, both FOR NO KEY UPDATE (the lock protocol of migration 182).
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_lock_organization(p_organization_id text) RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      PERFORM 1 FROM @S@.workos_organization_mappings m
        WHERE m.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_expiry_scope_missing' USING ERRCODE = 'CE404';
      END IF;
      PERFORM 1 FROM @S@.organization_credit_wallets w
        WHERE w.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
    END
    $body$;`),
  );

  // AFTER ROW on a source table: one atomic increment per affected organization (both organizations
  // of a permitted scope change, once each, in key order). It reads no cache, build or wallet row,
  // and fails the source statement when the required state row is absent. The checks tie the
  // definer function to the exact attached events, never to a caller-supplied argument.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_invalidate_source() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_old text;
      v_new text;
      v_organization_id text;
    BEGIN
      IF TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' OR TG_NARGS <> 0
        OR TG_TABLE_SCHEMA::text <> @L@
        OR TG_TABLE_NAME::text <> ALL (ARRAY[${SOURCES.map(([table]) => `'${table}'`).join(", ")}]::text[]) THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
      IF TG_OP = 'INSERT' THEN
        v_new := NEW.organization_id;
      ELSIF TG_OP = 'DELETE' THEN
        v_old := OLD.organization_id;
      ELSE
        v_old := OLD.organization_id;
        v_new := NEW.organization_id;
      END IF;
      FOR v_organization_id IN
        SELECT DISTINCT t.org FROM unnest(ARRAY[v_old, v_new]) AS t(org)
        WHERE t.org IS NOT NULL ORDER BY t.org
      LOOP
        UPDATE @S@.credit_expiry_state s SET source_revision = s.source_revision + 1
          WHERE s.organization_id = v_organization_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
        END IF;
      END LOOP;
      RETURN NULL;
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_create_state() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    BEGIN
      INSERT INTO @S@.credit_expiry_state(organization_id) VALUES (NEW.organization_id);
      RETURN NULL;
    END
    $body$;`),
  );

  // Under C0 and the state lock: capture the revision and the finite grant upper key with one
  // indexed maximum lookup. No history aggregate, count or expiry computation runs here.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_start(
      p_organization_id text, p_generation text, p_expected_active_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_revision bigint;
      v_active text;
      v_active_revision bigint;
      v_building text;
      v_status text;
      v_target bigint;
      v_base text;
      v_building_status text;
      v_building_target bigint;
      v_upper text;
    BEGIN
      PERFORM @S@.credit_expiry_lock_organization(p_organization_id);
      SELECT s.source_revision, s.active_generation, s.active_revision, s.building_generation
        INTO v_revision, v_active, v_active_revision, v_building
        FROM @S@.credit_expiry_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
      SELECT b.status, b.target_revision, b.expected_active_generation
        INTO v_status, v_target, v_base
        FROM @S@.credit_expiry_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF FOUND THEN
        -- The same generation with its original basis reads back only while it is still current. An
        -- invalidated or superseded generation is never retargeted to a newer revision.
        IF v_base IS NOT DISTINCT FROM p_expected_active_generation THEN
          IF v_status IN ('building', 'complete') AND v_building IS NOT DISTINCT FROM p_generation
            AND v_target = v_revision THEN
            RETURN jsonb_build_object('outcome', 'resumed');
          END IF;
          IF v_status = 'active' AND v_active IS NOT DISTINCT FROM p_generation
            AND v_active_revision = v_revision THEN
            RETURN jsonb_build_object('outcome', 'resumed');
          END IF;
        END IF;
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      IF v_active IS DISTINCT FROM p_expected_active_generation THEN
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      IF v_building IS NOT NULL THEN
        SELECT b.status, b.target_revision INTO v_building_status, v_building_target
          FROM @S@.credit_expiry_builds b
          WHERE b.organization_id = p_organization_id AND b.generation = v_building FOR NO KEY UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
        END IF;
        IF v_building_status IN ('building', 'complete') THEN
          IF v_building_target = v_revision THEN
            RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
          END IF;
          UPDATE @S@.credit_expiry_builds b SET status = 'invalidated'
            WHERE b.organization_id = p_organization_id AND b.generation = v_building;
        END IF;
      END IF;
      SELECT g.grant_id::text INTO v_upper FROM @S@.organization_credit_grants g
        WHERE g.organization_id = p_organization_id ORDER BY g.grant_id DESC LIMIT 1;
      INSERT INTO @S@.credit_expiry_builds(organization_id, generation, policy_version,
        target_revision, expected_active_generation, grant_upper_id, status, created_at)
      VALUES (p_organization_id, p_generation, '${CREDIT_EXPIRY_POLICY_VERSION}', v_revision,
        p_expected_active_generation, v_upper,
        CASE WHEN v_upper IS NULL THEN 'complete' ELSE 'building' END, now());
      UPDATE @S@.credit_expiry_state s SET building_generation = p_generation
        WHERE s.organization_id = p_organization_id;
      RETURN jsonb_build_object('outcome', 'started');
    END
    $body$;`),
  );

  // One bounded page, no wallet and no state write lock: only the exact build row is locked. The
  // canonical policy runs inside this function against the selected grant ids and the state revision
  // of the SAME statement snapshot, so the page is proven to describe the target revision; a page
  // seen under another revision writes nothing. Publication still rejects any revision change since
  // start, so pages of different revisions can never become active. The caller supplies no expiry
  // value, delta or row: the cache is whatever the policy derives from the recorded facts.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_advance(
      p_organization_id text, p_generation text, p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} SET plan_cache_mode = force_custom_plan AS $body$
    DECLARE
      v_status text;
      v_target bigint;
      v_upper text;
      v_cursor text;
      v_revision bigint;
      v_selected text[];
      v_count integer;
      v_ids text[];
      v_expires timestamptz[];
      v_topups boolean[];
      v_seen bigint;
      v_rows bigint;
      v_distinct bigint;
      v_last text;
      v_complete boolean;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_expiry_limit' USING ERRCODE = '22023';
      END IF;
      SELECT b.status, b.target_revision, b.grant_upper_id, b.grant_cursor
        INTO v_status, v_target, v_upper, v_cursor
        FROM @S@.credit_expiry_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        IF NOT EXISTS (SELECT 1 FROM @S@.workos_organization_mappings m
          WHERE m.organization_id = p_organization_id) THEN
          RAISE EXCEPTION 'credit_expiry_scope_missing' USING ERRCODE = 'CE404';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM @S@.credit_expiry_state s
          WHERE s.organization_id = p_organization_id) THEN
          RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
        END IF;
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      IF v_status = 'invalidated' THEN
        RETURN jsonb_build_object('outcome', 'stale', 'scanned', 0, 'written', 0, 'complete', false);
      END IF;
      IF v_status NOT IN ('building', 'complete') THEN
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      SELECT s.source_revision INTO v_revision FROM @S@.credit_expiry_state s
        WHERE s.organization_id = p_organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
      IF v_revision <> v_target THEN
        RETURN jsonb_build_object('outcome', 'stale', 'scanned', 0, 'written', 0, 'complete', false);
      END IF;
      IF v_status = 'complete' THEN
        RETURN jsonb_build_object('outcome', 'complete', 'scanned', 0, 'written', 0, 'complete', true);
      END IF;

      -- At most p_limit grant keys from the cursor to the recorded upper key, by the grant-key index.
      SELECT COALESCE(array_agg(x.grant_id ORDER BY x.grant_id), ARRAY[]::text[]) INTO v_selected
        FROM (SELECT g.grant_id::text AS grant_id FROM @S@.organization_credit_grants g
          WHERE g.organization_id = p_organization_id
            AND (v_cursor IS NULL OR g.grant_id > v_cursor)
            AND g.grant_id <= v_upper
          ORDER BY g.grant_id LIMIT p_limit) x;
      v_count := cardinality(v_selected);

      IF v_count > 0 THEN
        EXECUTE $page$${CREDIT_EXPIRY_PAGE_V1_SQL}$page$
          INTO v_ids, v_expires, v_topups, v_seen, v_rows, v_distinct
          USING p_organization_id, v_selected;
        IF v_seen IS NOT NULL AND v_seen <> v_target THEN
          RETURN jsonb_build_object('outcome', 'stale', 'scanned', 0, 'written', 0, 'complete', false);
        END IF;
        -- Exactly one result per selected grant: a missing or duplicate result is corruption of the
        -- facts or of the policy, never a NULL expiry.
        IF v_seen IS NULL OR v_rows <> v_count OR v_distinct <> v_rows
          OR v_ids IS DISTINCT FROM v_selected THEN
          RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
        END IF;
        INSERT INTO @S@.credit_expiry_lots(organization_id, generation, grant_id, expires_at, is_topup)
          SELECT p_organization_id, p_generation, t.grant_id, t.expires_at, t.is_topup
          FROM unnest(v_ids, v_expires, v_topups) AS t(grant_id, expires_at, is_topup);
        v_last := v_selected[v_count];
      END IF;
      -- Finished when the finite key range is exhausted; the cursor is the last SELECTED grant.
      v_complete := v_count < p_limit OR v_last IS NOT DISTINCT FROM v_upper;
      UPDATE @S@.credit_expiry_builds b
        SET grant_cursor = COALESCE(v_last, b.grant_cursor),
            scanned_count = b.scanned_count + v_count,
            written_count = b.written_count + v_count,
            status = CASE WHEN v_complete THEN 'complete' ELSE 'building' END
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation;
      RETURN jsonb_build_object('outcome', 'advanced', 'scanned', v_count, 'written', v_count,
        'complete', v_complete);
    END
    $body$;`),
  );

  // Constant-size: pointer and status updates only. No policy, aggregate, cache scan, delta replay or
  // cleanup runs while the wallet is held. Never revives or patches a stale generation.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_publish(
      p_organization_id text, p_generation text, p_expected_active_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_revision bigint;
      v_active text;
      v_active_revision bigint;
      v_building text;
      v_status text;
      v_target bigint;
      v_base text;
      v_policy text;
    BEGIN
      PERFORM @S@.credit_expiry_lock_organization(p_organization_id);
      SELECT s.source_revision, s.active_generation, s.active_revision, s.building_generation
        INTO v_revision, v_active, v_active_revision, v_building
        FROM @S@.credit_expiry_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
      SELECT b.status, b.target_revision, b.expected_active_generation, b.policy_version
        INTO v_status, v_target, v_base, v_policy
        FROM @S@.credit_expiry_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND OR v_base IS DISTINCT FROM p_expected_active_generation THEN
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      IF v_status = 'active' THEN
        IF v_active IS NOT DISTINCT FROM p_generation AND v_active_revision = v_revision THEN
          RETURN jsonb_build_object('outcome', 'already_active');
        END IF;
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      IF v_status = 'building' THEN
        RAISE EXCEPTION 'credit_expiry_not_ready' USING ERRCODE = 'CE503';
      END IF;
      IF v_status <> 'complete' OR v_building IS DISTINCT FROM p_generation
        OR v_active IS DISTINCT FROM p_expected_active_generation OR v_target <> v_revision THEN
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      IF v_policy <> '${CREDIT_EXPIRY_POLICY_VERSION}' THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
      IF v_active IS NOT NULL THEN
        UPDATE @S@.credit_expiry_builds b SET status = 'retired'
          WHERE b.organization_id = p_organization_id AND b.generation = v_active;
      END IF;
      UPDATE @S@.credit_expiry_builds b SET status = 'active', published_at = now()
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation;
      UPDATE @S@.credit_expiry_state s
        SET active_generation = p_generation, active_revision = v_target, building_generation = NULL
        WHERE s.organization_id = p_organization_id;
      RETURN jsonb_build_object('outcome', 'published');
    END
    $body$;`),
  );

  // Only a terminal (invalidated or retired) generation, which no pointer references and no function
  // can leave again, so a build-row lock alone excludes advance and start. At most p_limit staging
  // rows per call by primary-key keyset; the progress row stays as evidence. No source fact is read
  // or written.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_expiry_cleanup(
      p_organization_id text, p_generation text, p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_active text;
      v_building text;
      v_status text;
      v_deleted bigint;
      v_remaining boolean;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_expiry_limit' USING ERRCODE = '22023';
      END IF;
      SELECT b.status INTO v_status FROM @S@.credit_expiry_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        IF NOT EXISTS (SELECT 1 FROM @S@.workos_organization_mappings m
          WHERE m.organization_id = p_organization_id) THEN
          RAISE EXCEPTION 'credit_expiry_scope_missing' USING ERRCODE = 'CE404';
        END IF;
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_expiry_state s WHERE s.organization_id = p_organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_expiry_unavailable' USING ERRCODE = 'CE500';
      END IF;
      IF v_status NOT IN ('invalidated', 'retired')
        OR v_active IS NOT DISTINCT FROM p_generation
        OR v_building IS NOT DISTINCT FROM p_generation THEN
        RAISE EXCEPTION 'credit_expiry_conflict' USING ERRCODE = 'CE409';
      END IF;
      DELETE FROM @S@.credit_expiry_lots l
        WHERE l.organization_id = p_organization_id AND l.generation = p_generation
          AND l.grant_id IN (
            SELECT d.grant_id FROM @S@.credit_expiry_lots d
            WHERE d.organization_id = p_organization_id AND d.generation = p_generation
            ORDER BY d.grant_id LIMIT p_limit);
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      v_remaining := EXISTS (SELECT 1 FROM @S@.credit_expiry_lots d
        WHERE d.organization_id = p_organization_id AND d.generation = p_generation);
      RETURN jsonb_build_object('deleted', v_deleted, 'remaining', v_remaining);
    END
    $body$;`),
  );

  // Default privileges may already grant a runtime role more than it needs, independently of PUBLIC:
  // reset both known roles explicitly on every function and cache table, then grant only the narrow
  // public entry points (EXECUTE) and read access to the cache (SELECT). No DML, DDL or private helper.
  for (const signature of ALL_FUNCTIONS) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
  }
  pgm.sql(
    `REVOKE ALL ON credit_expiry_state, credit_expiry_builds, credit_expiry_lots FROM PUBLIC;`,
  );
  pgm.sql(`DO $grants$
  DECLARE role_name text; function_signature text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        FOREACH function_signature IN ARRAY ARRAY[${ALL_FUNCTIONS.map((signature) => `'${signature}'`).join(", ")}] LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_signature, role_name);
        END LOOP;
        FOREACH function_signature IN ARRAY ARRAY[${PUBLIC_FUNCTIONS.map((signature) => `'${signature}'`).join(", ")}] LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', function_signature, role_name);
        END LOOP;
        EXECUTE format('REVOKE ALL ON credit_expiry_state, credit_expiry_builds, credit_expiry_lots FROM %I', role_name);
        EXECUTE format('GRANT SELECT ON credit_expiry_state, credit_expiry_builds, credit_expiry_lots TO %I', role_name);
      END IF;
    END LOOP;
  END $grants$;`);

  // Seed one state row per mapping. The short table fence stops mapping writers until commit, so the
  // seed and the trigger below cover exactly the same organizations. The seed carries no foreign key
  // (a per-parent KEY SHARE would wait on released FOR UPDATE financial writers, as migration 182
  // showed); the constraint is added NOT VALID and validated with a snapshot join. The committed
  // schema has a validated FK. No expiry history is computed here.
  pgm.sql(`
    LOCK TABLE workos_organization_mappings IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO credit_expiry_state(organization_id)
      SELECT organization_id FROM workos_organization_mappings;
    ALTER TABLE credit_expiry_state
      ADD CONSTRAINT credit_expiry_state_organization_fk FOREIGN KEY (organization_id)
      REFERENCES workos_organization_mappings(organization_id) NOT VALID;
    ALTER TABLE credit_expiry_state VALIDATE CONSTRAINT credit_expiry_state_organization_fk;
    CREATE TRIGGER ${MAPPING_TRIGGER} AFTER INSERT ON workos_organization_mappings
      FOR EACH ROW EXECUTE FUNCTION credit_expiry_create_state();
  `);

  // Invalidation triggers. They only bump a revision: old binaries keep reading canonical expiry.
  for (const [table, columns] of SOURCES) {
    pgm.sql(sourceTriggers(table, columns));
  }

  restoreBounds(pgm);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  boundDdl(pgm);
  // Only owned cache objects. No financial fact is read, changed or deleted; product use of the
  // cache must be removed first.
  pgm.sql(`DROP TRIGGER ${MAPPING_TRIGGER} ON workos_organization_mappings;`);
  for (const [table] of SOURCES) {
    pgm.sql(`
      DROP TRIGGER ${table}_credit_expiry_delete ON ${table};
      DROP TRIGGER ${table}_credit_expiry_update ON ${table};
      DROP TRIGGER ${table}_credit_expiry_insert ON ${table};
    `);
  }
  pgm.sql(`
    DROP TABLE credit_expiry_lots;
    ALTER TABLE credit_expiry_state
      DROP CONSTRAINT credit_expiry_state_active_fk,
      DROP CONSTRAINT credit_expiry_state_building_fk;
    DROP TABLE credit_expiry_builds;
    DROP TABLE credit_expiry_state;
  `);
  for (const signature of ALL_FUNCTIONS) {
    pgm.sql(`DROP FUNCTION ${signature};`);
  }
  restoreBounds(pgm);
}
