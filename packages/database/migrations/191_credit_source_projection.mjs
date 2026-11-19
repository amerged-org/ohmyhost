// W24 F07-S FOUNDATION: a source-current projection of the immutable measured-usage ledger.
//
// A measured source (source_kind, source_reference) is a global key over usage_credit_valuations.
// postMeasuredUsage reads ALL of its valuations on every post (scope, replay, latest observation)
// and, for a decreasing target, SUM(movement.spent) per grant over every valuation of the source.
// This migration keeps the answers of those two reads as small, transactionally exact rows:
//   credit_source_heads              one row per source: immutable scope (organization, project,
//                                    nullable environment, billing epoch, meter, unit, event time),
//                                    the LATEST valuation (id, observed_at, rate card, cumulative
//                                    quantity/charge/provider cost) and positive_allocation_total
//   credit_source_grant_allocations  (source, grant) -> exact signed net spent, plus the grant's RAW
//                                    expires_at/granted_at (grants are append-only, so the copy is
//                                    immutable); a partial index serves net_spent > 0 in the ORIGINAL
//                                    refund order (expires_at DESC NULLS FIRST, granted_at DESC,
//                                    grant_id DESC). Rows whose net is exactly zero are deleted.
//   credit_source_builds             bounded, resumable backfill progress (one row per source)
//   credit_source_build_applied      temporary exact primary-key markers of a BUILDING source only
//   credit_source_custody            the hot-only custody guard (see below)
// Nothing reads these tables yet: the original postMeasuredUsage SQL stays authoritative, a source
// without a ready head is simply "not ready", and no original fact is read-modified or deleted.
//
// Semantics preserved from measured-credits.ts (root-reviewed refinements):
//  * The head stores the LATEST prior rate card exactly. Mixed historical rates are not an error; the
//    consumer compares only the latest card with the currently selected card, as today.
//  * Scope disagreement (organization, project, environment, epoch, meter, unit or event time)
//    between valuations is a rejection: a build fails and never becomes ready, and a live insert that
//    contradicts a READY head is refused (CS422). Event times are compared at the millisecond
//    resolution the pg driver exposes (Date truncation); the exact microsecond values are stored.
//  * The old read ordered by observed_at DESC without a tiebreaker. Two valuations with EXACTLY equal
//    observed_at and materially different values (rate card, quantity, charge, provider cost) make
//    the latest ambiguous: latest_tie_ambiguous marks the head unavailable (never ready for a reader,
//    never activated) and no tie policy is invented. A strictly newer valuation clears it.
//  * positive_allocation_total is Σ max(net,0) over the allocation rows, maintained from actual
//    movement deltas (not from resolution.funded_micros) and therefore independent of apply order.
//
// Trigger protocol (postMeasuredUsage inserts reservation, movements, resolution and the valuation
// LAST, so a movement trigger that only joins the valuation would miss new work):
//  * BEFORE INSERT on the valuation takes C0 of the PARENT reservation's real organization and then
//    the existing transaction-scoped source advisory lock (hashtextextended(kind || '/' || ref, 0)).
//    A valuation of another organization therefore never takes the owner organization's wallet.
//  * AFTER INSERT on the valuation (only for a really inserted row; an ignored duplicate has no
//    effect) validates the parent reservation and resolution, merges the head and applies every
//    movement of THIS reservation. AFTER INSERT on a movement with spent <> 0 does nothing while no
//    valuation exists yet (the valuation trigger accounts for it) and applies exactly that movement
//    once when the valuation already exists. The two routes never overlap: they are ordered by
//    separate statements under C0 at READ COMMITTED (a higher isolation level is refused, because a
//    stale snapshot could miss the other route's row). A data-modifying CTE that inserts a
//    valuation and its movements in ONE statement is refused atomically (matching xmin/cmin),
//    so neither AFTER route can apply the same movement twice. Nested and savepoint commands
//    have distinct command identities and retain the ordinary once-only routes.
//  * While a source BUILDS, both routes and the builder use the same exact markers: one per
//    valuation (head metadata) and one per movement primary key. Markers exist only while building
//    and are removed in bounded pages after activation; READY sources have none.
//  * A source gets a ready head directly from its first valuation only when absence is PROVEN: no
//    head, no build, no other hot valuation (an indexed lookup under C0 and the advisory lock) and
//    the custody guard says hot_only. A source with history and no head stays unready until a build.
//
// Lock order for every writer and builder: mapping row, wallet row (C0, both FOR NO KEY UPDATE),
// then the source advisory lock, then build, head and allocation rows. Nothing here takes a source
// row and then requests C0.
//
// Custody (F13) is NOT implemented. credit_source_custody admits only hot_only; a later migration
// that introduces eviction must change it, which makes every absence proof fail closed. Heads and
// positive allocations are not evicted by this migration, so the bounded-footprint obligation is
// explicitly still open: with all facts hot, one head per source remains.
//
// Authority: private helpers and trigger functions are owner-only; the four administration
// functions (start, advance, activate, cleanup) are SECURITY DEFINER and executable by the runtime
// roles, which can read heads, allocations, builds and the custody row and write nothing.
//
// Bounds: the DDL arms a 100 ms lock and a 5 s statement limit per driver query and restores the
// runner's settings. Two indexes are added to usage_credit_valuations without CONCURRENTLY inside
// that bounded transaction against today's volume; a much larger table needs a supported
// concurrent-index phase. No data is backfilled here.

const SOURCE_TABLES = [
  "credit_source_custody",
  "credit_source_heads",
  "credit_source_grant_allocations",
  "credit_source_builds",
  "credit_source_build_applied",
];

// The runtime roles read everything except the dedupe markers.
const READABLE_TABLES = [
  "credit_source_custody",
  "credit_source_heads",
  "credit_source_grant_allocations",
  "credit_source_builds",
];

const PUBLIC_FUNCTIONS = [
  "credit_source_start(text,text,text,text)",
  "credit_source_advance(text,text,text,text,integer)",
  "credit_source_activate(text,text,text,text)",
  "credit_source_cleanup(text,text,text,text,integer)",
];

const PRIVATE_FUNCTIONS = [
  "credit_source_require_read_committed()",
  "credit_source_lock_organization(text)",
  "credit_source_lock_source(text,text)",
  "credit_source_adjust_head(text,text,numeric,integer)",
  "credit_source_contribute_valuation(text,text,text,boolean,text,text)",
  "credit_source_contribute_movement(text,text,text,text,text,boolean)",
  "credit_source_lock_valuation()",
  "credit_source_apply_valuation()",
  "credit_source_apply_movement()",
];

const ALL_FUNCTIONS = [...PUBLIC_FUNCTIONS, ...PRIVATE_FUNCTIONS];

const KIND_CHECK = "CHECK (source_kind ~ '^[a-z][a-z0-9_.-]{0,63}$')";
const REFERENCE_CHECK = "CHECK (length(source_reference) BETWEEN 1 AND 256)";

// Every function is created through this wrapper. @S@ becomes the quoted schema that holds the
// organization mappings: all relations and helpers in a body are qualified by it and the function's
// own search_path is only pg_catalog (then pg_temp last), so neither the caller's search_path nor a
// temporary object can substitute anything, in public or in a test schema. The schema itself is
// discovered by a catalog lookup of the base table in the migration's own target schema, never by an
// unqualified name that a temporary table could shadow; a missing mapping table makes the
// replacement NULL and the installation fails instead of installing anything.
const TRUSTED_SCHEMA = `(SELECT n.nspname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'workos_organization_mappings' AND c.relkind = 'r'
    AND n.nspname = pg_catalog.current_schema())`;

/** @param {string} definition */
const inTrustedSchema = (definition) => `DO $install$ BEGIN
  EXECUTE pg_catalog.replace($definition$${definition}$definition$, '@S@', pg_catalog.quote_ident(${TRUSTED_SCHEMA}));
END $install$;`;

const FIXED_PATH = "SET search_path = pg_catalog, pg_temp";

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_source_projection_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='100ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_source_projection_migration_timeouts;
           DROP TABLE pg_temp.w24_source_projection_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  pgm.sql(
    inTrustedSchema(`
    DO $check$ BEGIN
      IF (SELECT count(*) FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${TRUSTED_SCHEMA} AND c.relkind = 'r'
            AND c.relname IN ('workos_organization_mappings','organization_credit_wallets',
              'organization_credit_grants','organization_credit_movements',
              'organization_credit_reservations','organization_credit_resolutions','usage_credit_valuations')) <> 7 THEN
        RAISE EXCEPTION 'Credit source projections require the credit ledger and wallets in the migration target schema';
      END IF;
    END $check$;

    -- Custody guard. Absence of a head or of a hot valuation proves "new source" only while every
    -- fact is hot. The CHECK admits nothing else; a cold protocol must change it deliberately.
    CREATE TABLE @S@.credit_source_custody (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      mode text NOT NULL CHECK (mode = 'hot_only')
    );
    INSERT INTO @S@.credit_source_custody(singleton, mode) VALUES (true, 'hot_only');

    -- Progress of the backfill of ONE source. The generation is the caller's idempotency token; the
    -- upper valuation id bounds the finite inventory that existed at start (an id, not a commit
    -- watermark). valuation_cursor is the last parent of the current phase; the movement cursor is
    -- the last child inside that parent when a parent was left partially applied.
    CREATE TABLE @S@.credit_source_builds (
      source_kind text NOT NULL ${KIND_CHECK},
      source_reference text NOT NULL ${REFERENCE_CHECK},
      generation @S@.ulid NOT NULL,
      organization_id @S@.ulid NOT NULL,
      status text NOT NULL CHECK (status IN ('building','active','failed')),
      phase text NOT NULL CHECK (phase IN ('valuations','movements','complete')),
      failure text CHECK (failure IN ('organization_conflict','scope_conflict','resolution_missing')),
      valuation_upper_id @S@.ulid NOT NULL,
      valuation_cursor @S@.ulid,
      movement_cursor_grant_id @S@.ulid,
      movement_cursor_phase text,
      scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      applied_count bigint NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      activated_at timestamptz,
      PRIMARY KEY (source_kind, source_reference),
      CONSTRAINT credit_source_builds_cursor_shape CHECK (
        (movement_cursor_grant_id IS NULL) = (movement_cursor_phase IS NULL)
        AND (movement_cursor_grant_id IS NULL OR valuation_cursor IS NOT NULL)),
      CONSTRAINT credit_source_builds_failure_shape CHECK ((status = 'failed') = (failure IS NOT NULL)),
      CONSTRAINT credit_source_builds_active_shape CHECK (
        (status = 'active') = (activated_at IS NOT NULL) AND (status <> 'active' OR phase = 'complete'))
    );

    -- The source head. state 'building' heads are written by a backfill and are invisible to readers;
    -- 'ready' heads are exact. event_time is the earliest exact representative within one
    -- millisecond bucket (a deterministic value whatever the apply order). The latest_* columns are
    -- the valuation the old read ordered first by observed_at DESC. revision counts every change of
    -- the head (the hot overlay version); custody_version is reserved for the cold protocol.
    CREATE TABLE @S@.credit_source_heads (
      source_kind text NOT NULL ${KIND_CHECK},
      source_reference text NOT NULL ${REFERENCE_CHECK},
      state text NOT NULL CHECK (state IN ('building','ready')),
      organization_id @S@.ulid NOT NULL,
      project_id @S@.ulid NOT NULL,
      environment_id @S@.ulid,
      billing_epoch_id @S@.ulid NOT NULL,
      meter text NOT NULL CHECK (length(meter) BETWEEN 1 AND 128),
      unit text NOT NULL CHECK (length(unit) BETWEEN 1 AND 64),
      event_time timestamptz NOT NULL,
      latest_valuation_id @S@.ulid NOT NULL,
      latest_observed_at timestamptz NOT NULL,
      latest_rate_card_id text NOT NULL CHECK (length(latest_rate_card_id) BETWEEN 1 AND 128),
      target_quantity bigint NOT NULL CHECK (target_quantity >= 0),
      target_charge_micros bigint NOT NULL CHECK (target_charge_micros >= 0),
      target_provider_cost_micros bigint NOT NULL CHECK (target_provider_cost_micros >= 0),
      latest_tie_ambiguous boolean NOT NULL DEFAULT false,
      positive_allocation_total numeric(38,0) NOT NULL DEFAULT 0 CHECK (positive_allocation_total >= 0),
      build_generation @S@.ulid,
      custody_version bigint NOT NULL DEFAULT 0 CHECK (custody_version >= 0),
      revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
      PRIMARY KEY (source_kind, source_reference),
      CONSTRAINT credit_source_heads_building_generation CHECK (state = 'ready' OR build_generation IS NOT NULL)
    ) WITH (fillfactor = 70);

    -- Exact signed net spent of one source on one grant. A net of exactly zero has no row. Integral
    -- numeric: SUM(bigint) is numeric, and a building source can be negative before the matching
    -- movement is counted. The ordering facts are copies of the append-only grant row.
    CREATE TABLE @S@.credit_source_grant_allocations (
      source_kind text NOT NULL ${KIND_CHECK},
      source_reference text NOT NULL ${REFERENCE_CHECK},
      grant_id @S@.ulid NOT NULL,
      net_spent_micros numeric(38,0) NOT NULL CHECK (net_spent_micros <> 0),
      expires_at timestamptz,
      granted_at timestamptz NOT NULL,
      PRIMARY KEY (source_kind, source_reference, grant_id),
      FOREIGN KEY (source_kind, source_reference)
        REFERENCES @S@.credit_source_heads(source_kind, source_reference)
    );
    CREATE INDEX credit_source_allocations_refund_idx ON @S@.credit_source_grant_allocations
      (source_kind, source_reference, expires_at DESC NULLS FIRST, granted_at DESC, grant_id DESC)
      WHERE net_spent_micros > 0;

    -- Temporary exact markers of a BUILDING source: the original key of every applied valuation
    -- (head metadata) and movement (reservation:grant:phase). Deleted in bounded pages afterwards.
    CREATE TABLE @S@.credit_source_build_applied (
      source_kind text NOT NULL ${KIND_CHECK},
      source_reference text NOT NULL ${REFERENCE_CHECK},
      marker_kind text NOT NULL CHECK (marker_kind IN ('valuation','movement')),
      marker_key text NOT NULL CHECK (length(marker_key) BETWEEN 26 AND 64),
      PRIMARY KEY (source_kind, source_reference, marker_kind, marker_key),
      FOREIGN KEY (source_kind, source_reference)
        REFERENCES @S@.credit_source_builds(source_kind, source_reference)
    );

  `),
  );

  // The two indexes on the ledger: parent pages by exact source/valuation id, and the latest
  // valuation of a source by observed_at (tie and head audits). The unique observation key already
  // serves the exact replay lookup.
  pgm.sql(
    inTrustedSchema(`CREATE INDEX usage_credit_valuations_source_valuation_idx
    ON @S@.usage_credit_valuations (source_kind, source_reference, valuation_id);`),
  );
  pgm.sql(
    inTrustedSchema(`CREATE INDEX usage_credit_valuations_source_observed_idx
    ON @S@.usage_credit_valuations (source_kind, source_reference, observed_at DESC, valuation_id DESC);`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_require_read_committed() RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
      END IF;
    END
    $body$;`),
  );

  // C0: mapping row, then wallet row, both FOR NO KEY UPDATE (the lock protocol of migration 182).
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_lock_organization(p_organization_id text) RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      PERFORM 1 FROM @S@.workos_organization_mappings m
        WHERE m.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_scope_missing' USING ERRCODE = '23503';
      END IF;
      PERFORM 1 FROM @S@.organization_credit_wallets w
        WHERE w.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
      END IF;
    END
    $body$;`),
  );

  // The existing source serialization, byte for byte the key postMeasuredUsage takes.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_lock_source(p_source_kind text, p_source_reference text) RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_source_kind || '/' || p_source_reference, 0));
    END
    $body$;`),
  );

  // One atomic version update for an allocation batch. The revision advances for EVERY signed
  // allocation mutation, including negative/zero-net changes whose positive-total delta is zero.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_adjust_head(
      p_source_kind text, p_source_reference text, p_delta numeric, p_mutations integer
    ) RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      IF p_mutations = 0 THEN
        RETURN;
      END IF;
      UPDATE @S@.credit_source_heads h
        SET positive_allocation_total = h.positive_allocation_total + p_delta, revision = h.revision + p_mutations
        WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
      END IF;
    END
    $body$;`),
  );

  // Head metadata of ONE valuation, read from the immutable ledger (never from a caller value).
  // Returns 'applied', 'duplicate' (its marker exists) or a conflict code the caller turns into a
  // rejection (live READY source) or a failed build (BUILDING source). A head is created only when
  // p_create_state says so; otherwise a missing head is an invariant failure.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_contribute_valuation(
      p_source_kind text, p_source_reference text, p_valuation_id text, p_marked boolean,
      p_create_state text, p_generation text
    ) RETURNS text
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    DECLARE
      v_inserted bigint;
      v_val record;
      v_head record;
      v_event timestamptz;
      v_differs boolean;
      v_take boolean;
    BEGIN
      SELECT v.target_quantity, v.target_charge_micros, v.target_provider_cost_micros, v.rate_card_id,
          v.observed_at, r.organization_id, r.project_id, r.environment_id, r.billing_epoch_id,
          x.reservation_id AS resolution_id, x.meter, x.unit, x.event_time
        INTO v_val
        FROM @S@.usage_credit_valuations v
        JOIN @S@.organization_credit_reservations r ON r.reservation_id = v.valuation_id
        LEFT JOIN @S@.organization_credit_resolutions x ON x.reservation_id = v.valuation_id
        WHERE v.valuation_id = p_valuation_id AND v.source_kind = p_source_kind
          AND v.source_reference = p_source_reference;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_source_missing' USING ERRCODE = '55000';
      END IF;
      IF v_val.resolution_id IS NULL THEN
        RETURN 'resolution_missing';
      END IF;
      IF p_marked THEN
        INSERT INTO @S@.credit_source_build_applied(source_kind, source_reference, marker_kind, marker_key)
        VALUES (p_source_kind, p_source_reference, 'valuation', p_valuation_id)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          RETURN 'duplicate';
        END IF;
      END IF;

      SELECT h.organization_id, h.project_id, h.environment_id, h.billing_epoch_id, h.meter, h.unit,
          h.event_time, h.latest_valuation_id, h.latest_observed_at, h.latest_rate_card_id,
          h.target_quantity, h.target_charge_micros, h.target_provider_cost_micros,
          h.latest_tie_ambiguous
        INTO v_head
        FROM @S@.credit_source_heads h
        WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference FOR UPDATE;
      IF NOT FOUND THEN
        IF p_create_state IS NULL THEN
          RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
        END IF;
        INSERT INTO @S@.credit_source_heads(source_kind, source_reference, state, organization_id,
          project_id, environment_id, billing_epoch_id, meter, unit, event_time, latest_valuation_id,
          latest_observed_at, latest_rate_card_id, target_quantity, target_charge_micros,
          target_provider_cost_micros, build_generation)
        VALUES (p_source_kind, p_source_reference, p_create_state, v_val.organization_id,
          v_val.project_id, v_val.environment_id, v_val.billing_epoch_id, v_val.meter, v_val.unit,
          v_val.event_time, p_valuation_id, v_val.observed_at, v_val.rate_card_id,
          v_val.target_quantity, v_val.target_charge_micros, v_val.target_provider_cost_micros,
          p_generation);
        RETURN 'applied';
      END IF;

      IF v_head.organization_id <> v_val.organization_id THEN
        RETURN 'organization_conflict';
      END IF;
      -- Exactly the old per-row checks; the event time at the driver's millisecond resolution.
      IF v_head.project_id <> v_val.project_id
        OR v_head.environment_id IS DISTINCT FROM v_val.environment_id
        OR v_head.billing_epoch_id <> v_val.billing_epoch_id
        OR v_head.meter <> v_val.meter OR v_head.unit <> v_val.unit
        OR pg_catalog.date_trunc('milliseconds', v_head.event_time)
          <> pg_catalog.date_trunc('milliseconds', v_val.event_time) THEN
        RETURN 'scope_conflict';
      END IF;

      v_event := least(v_head.event_time, v_val.event_time);
      IF v_val.observed_at > v_head.latest_observed_at THEN
        UPDATE @S@.credit_source_heads h
          SET event_time = v_event, latest_valuation_id = p_valuation_id,
            latest_observed_at = v_val.observed_at, latest_rate_card_id = v_val.rate_card_id,
            target_quantity = v_val.target_quantity, target_charge_micros = v_val.target_charge_micros,
            target_provider_cost_micros = v_val.target_provider_cost_micros,
            latest_tie_ambiguous = false, revision = h.revision + 1
          WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      ELSIF v_val.observed_at = v_head.latest_observed_at THEN
        v_differs := v_head.latest_rate_card_id <> v_val.rate_card_id
          OR v_head.target_quantity <> v_val.target_quantity
          OR v_head.target_charge_micros <> v_val.target_charge_micros
          OR v_head.target_provider_cost_micros <> v_val.target_provider_cost_micros;
        v_take := p_valuation_id > v_head.latest_valuation_id;
        IF v_differs OR v_take OR v_event <> v_head.event_time THEN
          UPDATE @S@.credit_source_heads h
            SET event_time = v_event,
              latest_valuation_id = CASE WHEN v_take THEN p_valuation_id ELSE h.latest_valuation_id END,
              latest_rate_card_id = CASE WHEN v_take THEN v_val.rate_card_id ELSE h.latest_rate_card_id END,
              target_quantity = CASE WHEN v_take THEN v_val.target_quantity ELSE h.target_quantity END,
              target_charge_micros = CASE WHEN v_take THEN v_val.target_charge_micros
                ELSE h.target_charge_micros END,
              target_provider_cost_micros = CASE WHEN v_take THEN v_val.target_provider_cost_micros
                ELSE h.target_provider_cost_micros END,
              latest_tie_ambiguous = h.latest_tie_ambiguous OR v_differs, revision = h.revision + 1
            WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
        END IF;
      ELSIF v_event <> v_head.event_time THEN
        UPDATE @S@.credit_source_heads h SET event_time = v_event, revision = h.revision + 1
          WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      END IF;
      RETURN 'applied';
    END
    $body$;`),
  );

  // The allocation effect of ONE movement, read from the ledger. Returns the change of the head's
  // positive total (possibly zero), or NULL when nothing was applied (zero spend, or its marker
  // already exists). The caller owns the single head update.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_contribute_movement(
      p_source_kind text, p_source_reference text, p_reservation_id text, p_grant_id text,
      p_phase text, p_marked boolean
    ) RETURNS numeric
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    DECLARE
      v_spent bigint;
      v_inserted bigint;
      v_expires timestamptz;
      v_granted timestamptz;
      v_old numeric;
      v_new numeric;
    BEGIN
      SELECT m.spent_micros INTO v_spent
        FROM @S@.organization_credit_movements m
        WHERE m.reservation_id = p_reservation_id AND m.grant_id = p_grant_id AND m.phase = p_phase;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_source_missing' USING ERRCODE = '55000';
      END IF;
      IF v_spent = 0 THEN
        RETURN NULL;
      END IF;
      IF p_marked THEN
        INSERT INTO @S@.credit_source_build_applied(source_kind, source_reference, marker_kind, marker_key)
        VALUES (p_source_kind, p_source_reference, 'movement',
          p_reservation_id || ':' || p_grant_id || ':' || p_phase)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          RETURN NULL;
        END IF;
      END IF;
      SELECT g.expires_at, g.granted_at INTO v_expires, v_granted
        FROM @S@.organization_credit_grants g WHERE g.grant_id = p_grant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_source_missing' USING ERRCODE = '55000';
      END IF;
      SELECT a.net_spent_micros INTO v_old
        FROM @S@.credit_source_grant_allocations a
        WHERE a.source_kind = p_source_kind AND a.source_reference = p_source_reference
          AND a.grant_id = p_grant_id FOR UPDATE;
      IF NOT FOUND THEN
        v_old := 0;
      END IF;
      v_new := v_old + v_spent;
      IF v_new = 0 THEN
        DELETE FROM @S@.credit_source_grant_allocations a
          WHERE a.source_kind = p_source_kind AND a.source_reference = p_source_reference
            AND a.grant_id = p_grant_id;
      ELSIF v_old = 0 THEN
        INSERT INTO @S@.credit_source_grant_allocations(source_kind, source_reference, grant_id,
          net_spent_micros, expires_at, granted_at)
        VALUES (p_source_kind, p_source_reference, p_grant_id, v_new, v_expires, v_granted);
      ELSE
        UPDATE @S@.credit_source_grant_allocations a SET net_spent_micros = v_new
          WHERE a.source_kind = p_source_kind AND a.source_reference = p_source_reference
            AND a.grant_id = p_grant_id;
      END IF;
      RETURN greatest(v_new, 0) - greatest(v_old, 0);
    END
    $body$;`),
  );

  // BEFORE INSERT on a valuation: C0 of the parent reservation's REAL organization, then the
  // existing source advisory lock. It fires for a duplicate ignored by ON CONFLICT DO NOTHING too
  // and has no other effect. A missing parent is left to the foreign key.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_lock_valuation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_organization_id text;
    BEGIN
      SELECT r.organization_id INTO v_organization_id
        FROM @S@.organization_credit_reservations r WHERE r.reservation_id = NEW.valuation_id;
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;
      PERFORM @S@.credit_source_lock_organization(v_organization_id);
      PERFORM @S@.credit_source_lock_source(NEW.source_kind, NEW.source_reference);
      RETURN NEW;
    END
    $body$;`),
  );

  // AFTER INSERT on a valuation. The valuation is written LAST by postMeasuredUsage, so this is the
  // route that accounts for every movement already written for the same reservation.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_apply_valuation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_head_state text;
      v_has_head boolean;
      v_build_status text;
      v_build_generation text;
      v_has_build boolean;
      v_custody text;
      v_mode text;
      v_outcome text;
      v_delta numeric := 0;
      v_mutations integer := 0;
      v_part numeric;
      v_row record;
    BEGIN
      IF EXISTS (SELECT 1 FROM @S@.usage_credit_valuations v
          JOIN @S@.organization_credit_movements m ON m.reservation_id = v.valuation_id
          WHERE v.valuation_id = NEW.valuation_id AND m.spent_micros <> 0
            AND m.xmin = v.xmin AND m.cmin = v.cmin) THEN
        RAISE EXCEPTION 'credit_source_same_command' USING ERRCODE = '55000';
      END IF;
      SELECT h.state INTO v_head_state FROM @S@.credit_source_heads h
        WHERE h.source_kind = NEW.source_kind AND h.source_reference = NEW.source_reference;
      v_has_head := FOUND;
      SELECT b.status, b.generation INTO v_build_status, v_build_generation
        FROM @S@.credit_source_builds b
        WHERE b.source_kind = NEW.source_kind AND b.source_reference = NEW.source_reference;
      v_has_build := FOUND;
      IF v_has_head AND v_head_state = 'ready' THEN
        v_mode := 'ready';
      ELSIF v_has_build AND v_build_status = 'building' THEN
        v_mode := 'building';
      ELSIF v_has_head OR v_has_build THEN
        -- A failed build or a leftover: the source stays unready and the legacy path is unchanged.
        RETURN NULL;
      ELSE
        SELECT c.mode INTO v_custody FROM @S@.credit_source_custody c WHERE c.singleton;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
        END IF;
        -- Absence is proof of a new source only with hot-only custody and no other hot valuation.
        IF v_custody <> 'hot_only' OR EXISTS (
            SELECT 1 FROM @S@.usage_credit_valuations o
            WHERE o.source_kind = NEW.source_kind AND o.source_reference = NEW.source_reference
              AND o.valuation_id <> NEW.valuation_id) THEN
          RETURN NULL;
        END IF;
        v_mode := 'new';
      END IF;
      PERFORM @S@.credit_source_require_read_committed();

      IF v_mode = 'building' THEN
        v_outcome := @S@.credit_source_contribute_valuation(NEW.source_kind, NEW.source_reference,
          NEW.valuation_id, true, 'building', v_build_generation);
      ELSIF v_mode = 'new' THEN
        v_outcome := @S@.credit_source_contribute_valuation(NEW.source_kind, NEW.source_reference,
          NEW.valuation_id, false, 'ready', NULL);
      ELSE
        v_outcome := @S@.credit_source_contribute_valuation(NEW.source_kind, NEW.source_reference,
          NEW.valuation_id, false, NULL, NULL);
      END IF;
      IF v_outcome NOT IN ('applied', 'duplicate') THEN
        IF v_mode = 'ready' THEN
          RAISE EXCEPTION 'credit_source_inconsistent' USING ERRCODE = 'CS422', DETAIL = v_outcome;
        ELSIF v_mode = 'building' THEN
          UPDATE @S@.credit_source_builds b
            SET status = 'failed', failure = v_outcome, updated_at = now()
            WHERE b.source_kind = NEW.source_kind AND b.source_reference = NEW.source_reference;
        END IF;
        RETURN NULL;
      END IF;

      FOR v_row IN
        SELECT m.grant_id, m.phase FROM @S@.organization_credit_movements m
        WHERE m.reservation_id = NEW.valuation_id AND m.spent_micros <> 0
        ORDER BY m.grant_id, m.phase
      LOOP
        v_part := @S@.credit_source_contribute_movement(NEW.source_kind, NEW.source_reference,
          NEW.valuation_id, v_row.grant_id, v_row.phase, v_mode = 'building');
        IF v_part IS NOT NULL THEN
          v_delta := v_delta + v_part;
          v_mutations := v_mutations + 1;
        END IF;
      END LOOP;
      PERFORM @S@.credit_source_adjust_head(NEW.source_kind, NEW.source_reference, v_delta, v_mutations);
      RETURN NULL;
    END
    $body$;`),
  );

  // AFTER INSERT on a movement that spends or corrects. While no valuation exists the later
  // valuation trigger accounts for it; once it exists, exactly this movement is applied.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_apply_movement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_kind text;
      v_reference text;
      v_head_state text;
      v_has_head boolean;
      v_build_status text;
      v_build_generation text;
      v_has_build boolean;
      v_mode text;
      v_outcome text;
      v_part numeric;
    BEGIN
      SELECT v.source_kind, v.source_reference INTO v_kind, v_reference
        FROM @S@.usage_credit_valuations v WHERE v.valuation_id = NEW.reservation_id;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM @S@.usage_credit_valuations v
          JOIN @S@.organization_credit_movements m ON m.reservation_id = v.valuation_id
          WHERE v.valuation_id = NEW.reservation_id AND m.grant_id = NEW.grant_id
            AND m.phase = NEW.phase AND m.xmin = v.xmin AND m.cmin = v.cmin) THEN
        RAISE EXCEPTION 'credit_source_same_command' USING ERRCODE = '55000';
      END IF;
      -- C0 is normally held already by the ledger's own lock trigger; taking it again is free and
      -- keeps the order C0, source lock, then head and allocations without depending on that trigger.
      PERFORM @S@.credit_source_lock_organization(NEW.organization_id);
      PERFORM @S@.credit_source_lock_source(v_kind, v_reference);
      SELECT h.state INTO v_head_state FROM @S@.credit_source_heads h
        WHERE h.source_kind = v_kind AND h.source_reference = v_reference;
      v_has_head := FOUND;
      SELECT b.status, b.generation INTO v_build_status, v_build_generation
        FROM @S@.credit_source_builds b
        WHERE b.source_kind = v_kind AND b.source_reference = v_reference;
      v_has_build := FOUND;
      IF v_has_head AND v_head_state = 'ready' THEN
        v_mode := 'ready';
      ELSIF v_has_build AND v_build_status = 'building' THEN
        v_mode := 'building';
      ELSE
        RETURN NULL;
      END IF;
      PERFORM @S@.credit_source_require_read_committed();
      IF v_mode = 'building' THEN
        -- The head may not exist yet when the backfill has not reached this source's first page.
        v_outcome := @S@.credit_source_contribute_valuation(v_kind, v_reference, NEW.reservation_id,
          true, 'building', v_build_generation);
        IF v_outcome NOT IN ('applied', 'duplicate') THEN
          UPDATE @S@.credit_source_builds b
            SET status = 'failed', failure = v_outcome, updated_at = now()
            WHERE b.source_kind = v_kind AND b.source_reference = v_reference;
          RETURN NULL;
        END IF;
      END IF;
      v_part := @S@.credit_source_contribute_movement(v_kind, v_reference, NEW.reservation_id,
        NEW.grant_id, NEW.phase, v_mode = 'building');
      IF v_part IS NOT NULL THEN
        PERFORM @S@.credit_source_adjust_head(v_kind, v_reference, v_part, 1);
      END IF;
      RETURN NULL;
    END
    $body$;`),
  );

  // Begin (or read back) the backfill of one existing source: the finite valuation inventory is
  // fixed by one indexed maximum lookup. Nothing is scanned or counted here.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_start(
      p_organization_id text, p_source_kind text, p_source_reference text, p_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_generation text;
      v_organization text;
      v_head_state text;
      v_upper text;
    BEGIN
      PERFORM @S@.credit_source_require_read_committed();
      PERFORM @S@.credit_source_lock_organization(p_organization_id);
      PERFORM @S@.credit_source_lock_source(p_source_kind, p_source_reference);
      SELECT b.generation, b.organization_id INTO v_generation, v_organization
        FROM @S@.credit_source_builds b
        WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference
        FOR NO KEY UPDATE;
      IF FOUND THEN
        IF v_generation = p_generation AND v_organization = p_organization_id THEN
          RETURN jsonb_build_object('outcome', 'resumed');
        END IF;
        RAISE EXCEPTION 'credit_source_conflict' USING ERRCODE = 'CS409';
      END IF;
      SELECT h.state INTO v_head_state FROM @S@.credit_source_heads h
        WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      IF FOUND THEN
        IF v_head_state <> 'ready' THEN
          RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
        END IF;
        RETURN jsonb_build_object('outcome', 'already_ready');
      END IF;
      SELECT v.valuation_id INTO v_upper FROM @S@.usage_credit_valuations v
        WHERE v.source_kind = p_source_kind AND v.source_reference = p_source_reference
        ORDER BY v.valuation_id DESC LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_absent' USING ERRCODE = 'CS404';
      END IF;
      INSERT INTO @S@.credit_source_builds(source_kind, source_reference, generation, organization_id,
        status, phase, valuation_upper_id, created_at, updated_at)
      VALUES (p_source_kind, p_source_reference, p_generation, p_organization_id, 'building',
        'valuations', v_upper, now(), now());
      RETURN jsonb_build_object('outcome', 'started');
    END
    $body$;`),
  );

  // One bounded page. Phase 'valuations' examines at most p_limit parent valuations; phase
  // 'movements' examines at most p_limit parents AND applies at most p_limit movement rows, with a
  // resumable (parent, grant, phase) cursor, so neither many empty parents nor one huge valuation
  // can exceed a chunk. A scope disagreement ends the build as 'failed' (committed, not raised) and
  // leaves the original read behaviour untouched.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_advance(
      p_organization_id text, p_source_kind text, p_source_reference text, p_generation text,
      p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} SET plan_cache_mode = force_custom_plan AS $body$
    DECLARE
      v_generation text;
      v_organization text;
      v_status text;
      v_phase text;
      v_failure text;
      v_upper text;
      v_cursor text;
      v_child_grant text;
      v_child_phase text;
      v_from_grant text;
      v_from_phase text;
      v_start_cursor text;
      v_start_resume boolean;
      v_parents integer := 0;
      v_movements integer := 0;
      v_applied integer := 0;
      v_budget integer;
      v_delta numeric := 0;
      v_mutations integer := 0;
      v_part numeric;
      v_outcome text;
      v_last text;
      v_page record;
      v_child record;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_source_limit' USING ERRCODE = '22023';
      END IF;
      PERFORM @S@.credit_source_require_read_committed();
      PERFORM @S@.credit_source_lock_organization(p_organization_id);
      PERFORM @S@.credit_source_lock_source(p_source_kind, p_source_reference);
      SELECT b.generation, b.organization_id, b.status, b.phase, b.failure, b.valuation_upper_id,
          b.valuation_cursor, b.movement_cursor_grant_id, b.movement_cursor_phase
        INTO v_generation, v_organization, v_status, v_phase, v_failure, v_upper, v_cursor,
          v_child_grant, v_child_phase
        FROM @S@.credit_source_builds b
        WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference
        FOR NO KEY UPDATE;
      IF NOT FOUND OR v_generation <> p_generation OR v_organization <> p_organization_id
        OR v_status = 'active' THEN
        RAISE EXCEPTION 'credit_source_conflict' USING ERRCODE = 'CS409';
      END IF;
      IF v_status = 'failed' OR v_phase = 'complete' THEN
        RETURN jsonb_build_object('phase', v_phase, 'status', v_status, 'failure', v_failure,
          'parents', 0, 'movements', 0, 'applied', 0, 'complete', v_phase = 'complete');
      END IF;
      v_budget := p_limit;

      IF v_phase = 'valuations' THEN
        FOR v_page IN
          SELECT v.valuation_id, r.organization_id
          FROM @S@.usage_credit_valuations v
          JOIN @S@.organization_credit_reservations r ON r.reservation_id = v.valuation_id
          WHERE v.source_kind = p_source_kind AND v.source_reference = p_source_reference
            AND v.valuation_id <= v_upper AND (v_cursor IS NULL OR v.valuation_id > v_cursor)
          ORDER BY v.valuation_id LIMIT p_limit
        LOOP
          v_parents := v_parents + 1;
          v_last := v_page.valuation_id;
          IF v_page.organization_id <> p_organization_id THEN
            v_failure := 'organization_conflict';
            EXIT;
          END IF;
          v_outcome := @S@.credit_source_contribute_valuation(p_source_kind, p_source_reference,
            v_page.valuation_id, true, 'building', p_generation);
          IF v_outcome = 'applied' THEN
            v_applied := v_applied + 1;
          ELSIF v_outcome <> 'duplicate' THEN
            v_failure := v_outcome;
            EXIT;
          END IF;
        END LOOP;
        IF v_failure IS NULL THEN
          v_cursor := COALESCE(v_last, v_cursor);
          IF v_parents < p_limit THEN
            v_phase := 'movements';
            v_cursor := NULL;
          END IF;
        END IF;
      ELSE
        -- The page query reads only variables this loop never assigns; the child query below reads
        -- the resume position, which is cleared once the cursor parent is finished.
        v_start_cursor := v_cursor;
        v_start_resume := v_child_grant IS NOT NULL;
        v_from_grant := v_child_grant;
        v_from_phase := v_child_phase;
        FOR v_page IN
          SELECT v.valuation_id
          FROM @S@.usage_credit_valuations v
          WHERE v.source_kind = p_source_kind AND v.source_reference = p_source_reference
            AND v.valuation_id <= v_upper
            AND (v_start_cursor IS NULL OR v.valuation_id > v_start_cursor
              OR (v_start_resume AND v.valuation_id = v_start_cursor))
          ORDER BY v.valuation_id LIMIT p_limit
        LOOP
          v_parents := v_parents + 1;
          FOR v_child IN
            SELECT m.grant_id, m.phase FROM @S@.organization_credit_movements m
            WHERE m.reservation_id = v_page.valuation_id
              AND (v_from_grant IS NULL OR (m.grant_id, m.phase) > (v_from_grant, v_from_phase))
            ORDER BY m.grant_id, m.phase LIMIT v_budget
          LOOP
            v_movements := v_movements + 1;
            v_budget := v_budget - 1;
            v_part := @S@.credit_source_contribute_movement(p_source_kind, p_source_reference,
              v_page.valuation_id, v_child.grant_id, v_child.phase, true);
            IF v_part IS NOT NULL THEN
              v_applied := v_applied + 1;
              v_delta := v_delta + v_part;
              v_mutations := v_mutations + 1;
            END IF;
            v_cursor := v_page.valuation_id;
            v_child_grant := v_child.grant_id;
            v_child_phase := v_child.phase;
          END LOOP;
          v_from_grant := NULL;
          v_from_phase := NULL;
          v_cursor := v_page.valuation_id;
          IF v_budget = 0 THEN
            -- This parent may have more rows: keep the child cursor and resume inside it.
            EXIT;
          END IF;
          v_child_grant := NULL;
          v_child_phase := NULL;
        END LOOP;
        IF v_budget > 0 AND v_parents < p_limit THEN
          v_phase := 'complete';
          v_cursor := NULL;
          v_child_grant := NULL;
          v_child_phase := NULL;
        END IF;
        PERFORM @S@.credit_source_adjust_head(p_source_kind, p_source_reference, v_delta, v_mutations);
      END IF;

      IF v_failure IS NOT NULL THEN
        UPDATE @S@.credit_source_builds b
          SET status = 'failed', failure = v_failure, updated_at = now()
          WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference;
        RETURN jsonb_build_object('phase', v_phase, 'status', 'failed', 'failure', v_failure,
          'parents', v_parents, 'movements', v_movements, 'applied', v_applied, 'complete', false);
      END IF;
      UPDATE @S@.credit_source_builds b
        SET phase = v_phase, valuation_cursor = v_cursor, movement_cursor_grant_id = v_child_grant,
          movement_cursor_phase = v_child_phase,
          scanned_count = b.scanned_count + v_parents + v_movements,
          applied_count = b.applied_count + v_applied, updated_at = now()
        WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference;
      RETURN jsonb_build_object('phase', v_phase, 'status', 'building', 'failure', v_failure,
        'parents', v_parents, 'movements', v_movements, 'applied', v_applied,
        'complete', v_phase = 'complete');
    END
    $body$;`),
  );

  // Constant-size exact-pointer compare-and-swap: the head moves from building (this generation)
  // to ready and the build row to active. No replay, reconciliation or scan runs here.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_activate(
      p_organization_id text, p_source_kind text, p_source_reference text, p_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_generation text;
      v_organization text;
      v_status text;
      v_phase text;
      v_head_state text;
      v_head_generation text;
      v_ambiguous boolean;
    BEGIN
      PERFORM @S@.credit_source_require_read_committed();
      PERFORM @S@.credit_source_lock_organization(p_organization_id);
      PERFORM @S@.credit_source_lock_source(p_source_kind, p_source_reference);
      SELECT b.generation, b.organization_id, b.status, b.phase
        INTO v_generation, v_organization, v_status, v_phase
        FROM @S@.credit_source_builds b
        WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference
        FOR NO KEY UPDATE;
      IF NOT FOUND OR v_generation <> p_generation OR v_organization <> p_organization_id THEN
        RAISE EXCEPTION 'credit_source_conflict' USING ERRCODE = 'CS409';
      END IF;
      IF v_status = 'active' THEN
        RETURN jsonb_build_object('outcome', 'already_active');
      END IF;
      IF v_status = 'failed' THEN
        RAISE EXCEPTION 'credit_source_inconsistent' USING ERRCODE = 'CS422';
      END IF;
      IF v_phase <> 'complete' THEN
        RAISE EXCEPTION 'credit_source_not_ready' USING ERRCODE = 'CS503';
      END IF;
      SELECT h.state, h.build_generation, h.latest_tie_ambiguous
        INTO v_head_state, v_head_generation, v_ambiguous
        FROM @S@.credit_source_heads h
        WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference FOR UPDATE;
      IF NOT FOUND OR v_head_state <> 'building' OR v_head_generation IS DISTINCT FROM p_generation THEN
        RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
      END IF;
      IF v_ambiguous THEN
        RAISE EXCEPTION 'credit_source_ambiguous' USING ERRCODE = 'CS423';
      END IF;
      UPDATE @S@.credit_source_heads h SET state = 'ready', revision = h.revision + 1
        WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      UPDATE @S@.credit_source_builds b SET status = 'active', activated_at = now(), updated_at = now()
        WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference;
      RETURN jsonb_build_object('outcome', 'activated');
    END
    $body$;`),
  );

  // Deletes at most p_limit rows in total (markers first, then the partial rows of a FAILED build);
  // once nothing remains, the failed head (never a ready one) and the build row go too, so a failed
  // source can restart with a new generation and a ready source keeps no progress row.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_source_cleanup(
      p_organization_id text, p_source_kind text, p_source_reference text, p_generation text,
      p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_generation text;
      v_organization text;
      v_status text;
      v_deleted bigint := 0;
      v_step bigint;
      v_remaining boolean;
      v_finished boolean := false;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_source_limit' USING ERRCODE = '22023';
      END IF;
      PERFORM @S@.credit_source_require_read_committed();
      PERFORM @S@.credit_source_lock_organization(p_organization_id);
      PERFORM @S@.credit_source_lock_source(p_source_kind, p_source_reference);
      SELECT b.generation, b.organization_id, b.status INTO v_generation, v_organization, v_status
        FROM @S@.credit_source_builds b
        WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference
        FOR NO KEY UPDATE;
      IF NOT FOUND OR v_generation <> p_generation OR v_organization <> p_organization_id
        OR v_status = 'building' THEN
        RAISE EXCEPTION 'credit_source_conflict' USING ERRCODE = 'CS409';
      END IF;
      DELETE FROM @S@.credit_source_build_applied a
        WHERE (a.source_kind, a.source_reference, a.marker_kind, a.marker_key) IN (
          SELECT m.source_kind, m.source_reference, m.marker_kind, m.marker_key
          FROM @S@.credit_source_build_applied m
          WHERE m.source_kind = p_source_kind AND m.source_reference = p_source_reference
          LIMIT p_limit);
      GET DIAGNOSTICS v_step = ROW_COUNT;
      v_deleted := v_step;
      IF v_status = 'failed' AND v_deleted < p_limit THEN
        DELETE FROM @S@.credit_source_grant_allocations a
          WHERE (a.source_kind, a.source_reference, a.grant_id) IN (
            SELECT m.source_kind, m.source_reference, m.grant_id
            FROM @S@.credit_source_grant_allocations m
            WHERE m.source_kind = p_source_kind AND m.source_reference = p_source_reference
            LIMIT p_limit - v_deleted);
        GET DIAGNOSTICS v_step = ROW_COUNT;
        v_deleted := v_deleted + v_step;
      END IF;
      v_remaining := EXISTS (SELECT 1 FROM @S@.credit_source_build_applied m
          WHERE m.source_kind = p_source_kind AND m.source_reference = p_source_reference)
        OR (v_status = 'failed' AND EXISTS (SELECT 1 FROM @S@.credit_source_grant_allocations m
          WHERE m.source_kind = p_source_kind AND m.source_reference = p_source_reference));
      IF NOT v_remaining THEN
        IF v_status = 'failed' THEN
          DELETE FROM @S@.credit_source_heads h
            WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference
              AND h.state = 'building';
        END IF;
        DELETE FROM @S@.credit_source_builds b
          WHERE b.source_kind = p_source_kind AND b.source_reference = p_source_reference;
        v_finished := true;
      END IF;
      RETURN jsonb_build_object('deleted', v_deleted, 'remaining', v_remaining, 'finished', v_finished);
    END
    $body$;`),
  );

  // Owner-only by default: PUBLIC loses everything. Trigger functions are invoked by the attached
  // events, which do not check EXECUTE of the inserting role.
  for (const signature of ALL_FUNCTIONS) {
    pgm.sql(inTrustedSchema(`REVOKE ALL ON FUNCTION @S@.${signature} FROM PUBLIC;`));
  }

  // Explicit default ACLs may grant PUBLIC or a runtime role rights independently of the revokes
  // above. Reset every function and table for PUBLIC and both known roles, then grant the roles
  // EXECUTE on the four administration entry points and SELECT on the readable tables only.
  pgm.sql(
    inTrustedSchema(`DO $grants$
  DECLARE role_name text; function_signature text;
  BEGIN
    REVOKE ALL ON ${SOURCE_TABLES.map((table) => `@S@.${table}`).join(", ")} FROM PUBLIC;
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        FOREACH function_signature IN ARRAY ARRAY[${ALL_FUNCTIONS.map((signature) => `'@S@.${signature}'`).join(", ")}] LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_signature, role_name);
        END LOOP;
        FOREACH function_signature IN ARRAY ARRAY[${PUBLIC_FUNCTIONS.map((signature) => `'@S@.${signature}'`).join(", ")}] LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', function_signature, role_name);
        END LOOP;
        EXECUTE format('REVOKE ALL ON ${SOURCE_TABLES.map((table) => `@S@.${table}`).join(", ")} FROM %I', role_name);
        EXECUTE format('GRANT SELECT ON ${READABLE_TABLES.map((table) => `@S@.${table}`).join(", ")} TO %I', role_name);
      END IF;
    END LOOP;
  END $grants$;`),
  );

  // The ledger triggers. The valuation lock fires for every insert (also an ignored duplicate); the
  // movement trigger only for rows that change a net (reserve-phase rows spend nothing).
  pgm.sql(
    inTrustedSchema(`
    CREATE TRIGGER usage_credit_valuations_source_lock BEFORE INSERT ON @S@.usage_credit_valuations
      FOR EACH ROW EXECUTE FUNCTION @S@.credit_source_lock_valuation();
    CREATE TRIGGER usage_credit_valuations_source_apply AFTER INSERT ON @S@.usage_credit_valuations
      FOR EACH ROW EXECUTE FUNCTION @S@.credit_source_apply_valuation();
    CREATE TRIGGER organization_credit_movements_source_apply AFTER INSERT ON @S@.organization_credit_movements
      FOR EACH ROW WHEN (NEW.spent_micros <> 0) EXECUTE FUNCTION @S@.credit_source_apply_movement();
  `),
  );

  restoreBounds(pgm);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  boundDdl(pgm);
  // Only owned derived objects. No original financial row is read, changed or deleted; product use
  // of the projection must be removed first.
  pgm.sql(
    inTrustedSchema(`
    DROP TRIGGER organization_credit_movements_source_apply ON @S@.organization_credit_movements;
    DROP TRIGGER usage_credit_valuations_source_apply ON @S@.usage_credit_valuations;
    DROP TRIGGER usage_credit_valuations_source_lock ON @S@.usage_credit_valuations;
  `),
  );
  for (const signature of ALL_FUNCTIONS) {
    pgm.sql(inTrustedSchema(`DROP FUNCTION @S@.${signature};`));
  }
  pgm.sql(
    inTrustedSchema(`
    DROP TABLE @S@.credit_source_build_applied, @S@.credit_source_grant_allocations, @S@.credit_source_builds,
      @S@.credit_source_heads, @S@.credit_source_custody;
    DROP INDEX @S@.usage_credit_valuations_source_observed_idx;
    DROP INDEX @S@.usage_credit_valuations_source_valuation_idx;
  `),
  );
  restoreBounds(pgm);
}
