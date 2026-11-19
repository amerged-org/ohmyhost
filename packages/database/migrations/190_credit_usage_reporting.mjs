// W24 F07-R: exact credit usage reporting without per-contribution temporal trees. Four derived
// tables, kept transactionally exact by triggers on the immutable reservation and resolution
// tables, answer "what did the old query report as of T" as current totals minus the contributions
// whose effective time is after T:
//   credit_usage_dimensions     current meter-dimension vectors with a contribution count and the
//                               first/last visible time (presence is independent of the sums)
//   credit_usage_project_months compact first-visibility registry of (project, UTC event month)
//   credit_usage_project_holds  positive-hold project summary: current amount/count and the min/max
//                               time of every positive-hold transition
//   credit_usage_visibility_hot indexed locators of the original rows behind those summaries; the
//                               reader proves every tail row against the ORIGINAL ledger row
// For reservation r and resolution s: R = r.reserved_at, V = greatest(R, s.resolved_at). A positive
// reservation holds +amount at R; ANY resolution of it releases -amount at V. A settled or
// corrected resolution adds one usage vector (and one presence count) at V. A zero-amount
// reservation changes nothing, so the metered posting path pays one dimension update, one locator
// and a conditional registry operation per resolution and nothing for the reservation.
//
// Independent of migration 185: its own state/builds/markers, its own organization lock helper and
// its own generation, so a ready reporting generation never depends on a selected 185 generation.
// The protocol is the reviewed 185 one: a finite reservation-id inventory fixed at start (not a
// commit watermark), bounded parent-reservation pages that LEFT JOIN the resolution by its key, one
// marker per meaningful source contribution of a BUILDING generation, live triggers that feed the
// building generation (including ids below a finished cursor), a constant-size activation and
// bounded cleanup. A source-empty generation is a valid zero; a missing state row is not.
//
// Lock order for every writer and builder: mapping row, wallet row (both FOR NO KEY UPDATE), then
// this feature's state, progress and markers, then derived rows. The BEFORE INSERT triggers below
// take the first two themselves (re-entrant for released writers, and independent of the 185
// triggers, which fire earlier by name), so legacy SQL is serialized with the builder as well. A
// zero-amount reservation has no derived effect and fires neither trigger.
//
// Bounds: the DDL arms a 100 ms lock and a 5 s statement limit per driver query and restores the
// runner's settings. They bound each statement, not the migration: the release gate currently
// applies a per-file transaction and a 60 s statement limit only and has no aggregate transaction
// deadline. No data is backfilled here; an organization stays "not ready" until an operator builds
// and activates a generation in bounded chunks.

const SOURCE_TRIGGERS = [
  ["organization_credit_reservations", "reservation"],
  ["organization_credit_resolutions", "resolution"],
];

const DERIVED_TABLES = [
  "credit_usage_dimensions",
  "credit_usage_project_months",
  "credit_usage_project_holds",
  "credit_usage_visibility_hot",
];

// The runtime roles read the state, progress and derived tables; the dedupe markers stay private.
const READABLE_TABLES = [
  "credit_usage_reporting_state",
  "credit_usage_reporting_builds",
  ...DERIVED_TABLES,
];
const ALL_TABLES = [...READABLE_TABLES, "credit_usage_reporting_build_applied"];

const FUNCTION_SIGNATURES = [
  "credit_usage_reporting_cleanup(text,text,integer)",
  "credit_usage_reporting_activate(text,text,text)",
  "credit_usage_reporting_advance(text,text,integer)",
  "credit_usage_reporting_start(text,text,text)",
  "credit_usage_reporting_create_state()",
  "credit_usage_reporting_apply_source()",
  "credit_usage_reporting_lock_source()",
  "credit_usage_reporting_contribute(text,text,text,text,boolean)",
  "credit_usage_reporting_lock_organization(text)",
];

// Every function is created through this wrapper. @S@ becomes the quoted schema that holds the
// organization mappings: all relations and helpers in a body are qualified by it and the function's
// own search_path is only pg_catalog (then pg_temp last), so neither the caller's search_path nor a
// temporary object can substitute anything, in public or in a test schema.
const TRUSTED_SCHEMA = `(SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = 'workos_organization_mappings'::regclass)`;

/** @param {string} definition */
const inTrustedSchema = (definition) => `DO $install$ BEGIN
  EXECUTE replace($definition$${definition}$definition$, '@S@', quote_ident(${TRUSTED_SCHEMA}));
END $install$;`;

const FIXED_PATH = "SET search_path = pg_catalog, pg_temp";

/**
 * A signed integral number of any size: SUM(bigint) is numeric, so a cumulative bigint could
 * reject history the ledger accepts. A building generation may be negative before the matching
 * source row is counted, so there is deliberately no sign constraint.
 * @param {string} column
 */
const integral = (column) =>
  `CHECK (${column} = trunc(${column}) AND ${column} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_usage_reporting_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='100ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_usage_reporting_migration_timeouts;
           DROP TABLE pg_temp.w24_usage_reporting_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  pgm.sql(`
    DO $check$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.oid IN ('organization_credit_wallets'::regclass,
          'organization_credit_reservations'::regclass, 'organization_credit_resolutions'::regclass)
          AND c.relnamespace IS DISTINCT FROM
            (SELECT relnamespace FROM pg_class WHERE oid = 'workos_organization_mappings'::regclass)
      ) THEN
        RAISE EXCEPTION 'Credit usage reporting requires the credit ledger and wallets in the schema of the organization mappings';
      END IF;
    END $check$;

    -- Generation pointers, one row per organization. A missing row is an invariant failure, never zero.
    CREATE TABLE credit_usage_reporting_state (
      organization_id ulid PRIMARY KEY,
      active_generation ulid,
      building_generation ulid,
      CONSTRAINT credit_usage_reporting_state_generations_differ CHECK (
        active_generation IS NULL OR building_generation IS NULL OR active_generation <> building_generation)
    );

    -- Progress of one generation, apart from the pointers. The generation id is the caller's
    -- idempotency token; the upper reservation id bounds the finite inventory that existed at start.
    CREATE TABLE credit_usage_reporting_builds (
      organization_id ulid NOT NULL REFERENCES credit_usage_reporting_state(organization_id),
      generation ulid NOT NULL,
      status text NOT NULL CHECK (status IN ('building','active','retired')),
      base_active_generation ulid,
      reservation_upper_id ulid,
      phase text NOT NULL CHECK (phase IN ('reservations','complete')),
      reservation_cursor ulid,
      scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      applied_count bigint NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      activated_at timestamptz,
      PRIMARY KEY (organization_id, generation),
      CONSTRAINT credit_usage_reporting_builds_base_differs CHECK (
        base_active_generation IS NULL OR base_active_generation <> generation),
      CONSTRAINT credit_usage_reporting_builds_complete_before_ready CHECK (status = 'building' OR phase = 'complete'),
      CONSTRAINT credit_usage_reporting_builds_activation_shape CHECK ((status = 'building') = (activated_at IS NULL))
    );

    -- Temporary dedupe markers of a BUILDING generation: one per meaningful source contribution
    -- (a positive reservation, a resolution with a hold release or a usage vector), keyed by the
    -- exact reservation key. Deleted in bounded chunks once the generation no longer builds.
    CREATE TABLE credit_usage_reporting_build_applied (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      source_kind text NOT NULL CHECK (source_kind IN ('reservation','resolution')),
      source_key ulid NOT NULL,
      PRIMARY KEY (organization_id, generation, source_kind, source_key),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    );

    -- One row per (project, UTC event month, nullable environment, rate card, meter, unit). The row
    -- is never dropped for net zero: report_row_count always counts +1 per contribution, so presence
    -- (first_visible_at <= T) is exact even when every sum is zero. dimension_id is identity only,
    -- never an ingestion or commit watermark. The dimension_id index lets a reader take any bounded
    -- subset of a project-month; visibility columns stay out of every index so that a posting is a
    -- heap-only-tuple candidate.
    CREATE TABLE credit_usage_dimensions (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      dimension_id bigint GENERATED ALWAYS AS IDENTITY,
      project_id ulid NOT NULL,
      event_month date NOT NULL CHECK (isfinite(event_month) AND EXTRACT(day FROM event_month) = 1),
      environment_id ulid,
      rate_card_id text NOT NULL,
      meter text NOT NULL,
      unit text NOT NULL,
      quantity numeric NOT NULL ${integral("quantity")},
      charged_micros numeric NOT NULL ${integral("charged_micros")},
      funded_micros numeric NOT NULL ${integral("funded_micros")},
      platform_overrun_micros numeric NOT NULL ${integral("platform_overrun_micros")},
      report_row_count bigint NOT NULL,
      first_visible_at timestamptz NOT NULL,
      last_visible_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id, generation, dimension_id),
      CONSTRAINT credit_usage_dimensions_identity_key UNIQUE NULLS NOT DISTINCT (
        organization_id, generation, project_id, event_month, environment_id, rate_card_id, meter, unit),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    );
    CREATE INDEX credit_usage_dimensions_project_month_idx
      ON credit_usage_dimensions (organization_id, generation, project_id, event_month, dimension_id);

    -- Registry of the first visible settled or corrected contribution of a project-month. The
    -- included time keeps candidate scans on the compact index; it changes only when an earlier
    -- contribution arrives.
    CREATE TABLE credit_usage_project_months (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      event_month date NOT NULL CHECK (isfinite(event_month) AND EXTRACT(day FROM event_month) = 1),
      project_id ulid NOT NULL,
      first_visible_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id, generation, event_month, project_id) INCLUDE (first_visible_at),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    );

    -- Positive holds of a project over every event month: the current open amount and count, the
    -- earliest reservation time of ANY positive reservation (resolved ones included) and the latest
    -- time of any applied positive-hold transition (resolutions included). A project whose holds are
    -- all closed keeps its row, because a historical read still needs its min/max.
    CREATE TABLE credit_usage_project_holds (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      project_id ulid NOT NULL,
      current_amount_micros numeric NOT NULL ${integral("current_amount_micros")},
      positive_open_count bigint NOT NULL,
      first_positive_reserved_at timestamptz NOT NULL,
      last_effective_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id, generation, project_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    );

    -- Hot locators of original rows. source_key is the reservation key for both kinds. A resolution
    -- is ONE locator carrying a hold release and/or a usage vector; a zero-amount reservation, and a
    -- released resolution of a zero-amount reservation, have none. Only the original row is
    -- authoritative: the locator says where to look, never what to add.
    CREATE TABLE credit_usage_visibility_hot (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      source_kind text NOT NULL CHECK (source_kind IN ('reservation','resolution')),
      source_key ulid NOT NULL,
      project_id ulid NOT NULL,
      effective_at timestamptz NOT NULL,
      has_positive_hold boolean NOT NULL,
      dimension_id bigint,
      event_month date,
      PRIMARY KEY (organization_id, generation, source_kind, source_key),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation),
      CONSTRAINT credit_usage_visibility_hot_shape CHECK (
        (dimension_id IS NULL) = (event_month IS NULL)
        AND (source_kind = 'resolution' OR (has_positive_hold AND dimension_id IS NULL))
        AND (has_positive_hold OR dimension_id IS NOT NULL))
    );
    CREATE INDEX credit_usage_visibility_hot_hold_tail_idx
      ON credit_usage_visibility_hot (organization_id, generation, project_id, effective_at, source_kind, source_key)
      WHERE has_positive_hold;
    CREATE INDEX credit_usage_visibility_hot_usage_tail_idx
      ON credit_usage_visibility_hot (organization_id, generation, project_id, event_month, dimension_id, effective_at, source_key)
      WHERE dimension_id IS NOT NULL;

    -- The pointers reference validated builds. MATCH SIMPLE leaves a NULL pointer unchecked.
    ALTER TABLE credit_usage_reporting_state
      ADD CONSTRAINT credit_usage_reporting_state_active_fk FOREIGN KEY (organization_id, active_generation)
        REFERENCES credit_usage_reporting_builds(organization_id, generation),
      ADD CONSTRAINT credit_usage_reporting_state_building_fk FOREIGN KEY (organization_id, building_generation)
        REFERENCES credit_usage_reporting_builds(organization_id, generation);
  `);

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_lock_organization(p_organization_id text) RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      PERFORM 1 FROM @S@.workos_organization_mappings m
        WHERE m.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_scope_missing' USING ERRCODE = '23503';
      END IF;
      PERFORM 1 FROM @S@.organization_credit_wallets w
        WHERE w.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;
    END
    $body$;`),
  );

  // The only place a contribution is computed. It takes a source identity, never an amount: every
  // value is read from the immutable ledger. A source row with no hold and no usage vector is a
  // true no-op (no marker, no metadata); a marked contribution is applied at most once per generation.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_contribute(
      p_organization_id text, p_generation text, p_source_kind text, p_source_key text, p_marked boolean
    ) RETURNS boolean
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    DECLARE
      v_inserted bigint;
      v_project_id text;
      v_environment_id text;
      v_reserved_at timestamptz;
      v_amount bigint;
      v_outcome text;
      v_charge bigint;
      v_funded bigint;
      v_quantity bigint;
      v_rate_card_id text;
      v_meter text;
      v_unit text;
      v_event_time timestamptz;
      v_resolved_at timestamptz;
      v_effective timestamptz;
      v_sign integer;
      v_hold boolean;
      v_usage boolean;
      v_month date;
      v_dimension bigint;
    BEGIN
      IF p_source_kind = 'reservation' THEN
        SELECT r.project_id, r.amount_micros, r.reserved_at
          INTO v_project_id, v_amount, v_reserved_at
          FROM @S@.organization_credit_reservations r
          WHERE r.organization_id = p_organization_id AND r.reservation_id = p_source_key;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_usage_reporting_source_missing' USING ERRCODE = '55000';
        END IF;
        v_sign := 1;
        v_effective := v_reserved_at;
        v_usage := false;
      ELSIF p_source_kind = 'resolution' THEN
        SELECT r.project_id, r.environment_id, r.reserved_at, r.amount_micros, x.outcome,
            x.charge_micros, x.funded_micros, x.quantity, x.rate_card_id, x.meter, x.unit,
            x.event_time, x.resolved_at
          INTO v_project_id, v_environment_id, v_reserved_at, v_amount, v_outcome,
            v_charge, v_funded, v_quantity, v_rate_card_id, v_meter, v_unit,
            v_event_time, v_resolved_at
          FROM @S@.organization_credit_resolutions x
          JOIN @S@.organization_credit_reservations r ON r.reservation_id = x.reservation_id
          WHERE x.reservation_id = p_source_key AND r.organization_id = p_organization_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_usage_reporting_source_missing' USING ERRCODE = '55000';
        END IF;
        v_sign := -1;
        v_effective := greatest(v_reserved_at, v_resolved_at);
        -- A non-finite event time can never match the finite public month: no usage contribution,
        -- though the hold release still applies.
        v_usage := COALESCE(v_outcome IN ('settled', 'corrected') AND isfinite(v_event_time), false);
      ELSE
        RAISE EXCEPTION 'credit_usage_reporting_source_kind' USING ERRCODE = '22023';
      END IF;
      v_hold := v_amount > 0;
      IF NOT v_hold AND NOT v_usage THEN
        RETURN false;
      END IF;

      IF p_marked THEN
        INSERT INTO @S@.credit_usage_reporting_build_applied(organization_id, generation, source_kind, source_key)
        VALUES (p_organization_id, p_generation, p_source_kind, p_source_key)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          RETURN false;
        END IF;
      END IF;

      IF v_hold THEN
        -- The first reservation time is the PARENT's whichever handler runs first, so a resolution
        -- applied before its reservation never leaves it unknown or invents V.
        INSERT INTO @S@.credit_usage_project_holds AS h(organization_id, generation, project_id,
          current_amount_micros, positive_open_count, first_positive_reserved_at, last_effective_at)
        VALUES (p_organization_id, p_generation, v_project_id, v_sign * v_amount::numeric, v_sign,
          v_reserved_at, v_effective)
        ON CONFLICT (organization_id, generation, project_id) DO UPDATE
          SET current_amount_micros = h.current_amount_micros + EXCLUDED.current_amount_micros,
              positive_open_count = h.positive_open_count + EXCLUDED.positive_open_count,
              first_positive_reserved_at = least(h.first_positive_reserved_at, EXCLUDED.first_positive_reserved_at),
              last_effective_at = greatest(h.last_effective_at, EXCLUDED.last_effective_at);
      END IF;

      IF v_usage THEN
        v_month := date_trunc('month', v_event_time AT TIME ZONE 'UTC')::date;
        -- An update by key first, in two index-friendly forms for a NULL or real environment, so a
        -- posting into an existing dimension neither burns an identity value nor scans.
        IF v_environment_id IS NULL THEN
          UPDATE @S@.credit_usage_dimensions d
            SET quantity = d.quantity + v_quantity,
                charged_micros = d.charged_micros + v_charge,
                funded_micros = d.funded_micros + v_funded,
                platform_overrun_micros = d.platform_overrun_micros + (v_charge::numeric - v_funded::numeric),
                report_row_count = d.report_row_count + 1,
                first_visible_at = least(d.first_visible_at, v_effective),
                last_visible_at = greatest(d.last_visible_at, v_effective)
            WHERE d.organization_id = p_organization_id AND d.generation = p_generation
              AND d.project_id = v_project_id AND d.event_month = v_month AND d.environment_id IS NULL
              AND d.rate_card_id = v_rate_card_id AND d.meter = v_meter AND d.unit = v_unit
            RETURNING d.dimension_id INTO v_dimension;
        ELSE
          UPDATE @S@.credit_usage_dimensions d
            SET quantity = d.quantity + v_quantity,
                charged_micros = d.charged_micros + v_charge,
                funded_micros = d.funded_micros + v_funded,
                platform_overrun_micros = d.platform_overrun_micros + (v_charge::numeric - v_funded::numeric),
                report_row_count = d.report_row_count + 1,
                first_visible_at = least(d.first_visible_at, v_effective),
                last_visible_at = greatest(d.last_visible_at, v_effective)
            WHERE d.organization_id = p_organization_id AND d.generation = p_generation
              AND d.project_id = v_project_id AND d.event_month = v_month AND d.environment_id = v_environment_id
              AND d.rate_card_id = v_rate_card_id AND d.meter = v_meter AND d.unit = v_unit
            RETURNING d.dimension_id INTO v_dimension;
        END IF;
        IF v_dimension IS NULL THEN
          INSERT INTO @S@.credit_usage_dimensions(organization_id, generation, project_id, event_month,
            environment_id, rate_card_id, meter, unit, quantity, charged_micros, funded_micros,
            platform_overrun_micros, report_row_count, first_visible_at, last_visible_at)
          VALUES (p_organization_id, p_generation, v_project_id, v_month, v_environment_id,
            v_rate_card_id, v_meter, v_unit, v_quantity, v_charge, v_funded,
            v_charge::numeric - v_funded::numeric, 1, v_effective, v_effective)
          RETURNING dimension_id INTO v_dimension;
        END IF;
        -- Conditional upsert: it still probes and may lock the row, it is not free.
        INSERT INTO @S@.credit_usage_project_months AS m(organization_id, generation, event_month,
          project_id, first_visible_at)
        VALUES (p_organization_id, p_generation, v_month, v_project_id, v_effective)
        ON CONFLICT (organization_id, generation, event_month, project_id) DO UPDATE
          SET first_visible_at = EXCLUDED.first_visible_at
          WHERE EXCLUDED.first_visible_at < m.first_visible_at;
      END IF;

      INSERT INTO @S@.credit_usage_visibility_hot(organization_id, generation, source_kind, source_key,
        project_id, effective_at, has_positive_hold, dimension_id, event_month)
      VALUES (p_organization_id, p_generation, p_source_kind, p_source_key, v_project_id, v_effective,
        v_hold, v_dimension, CASE WHEN v_usage THEN v_month END);
      RETURN true;
    END
    $body$;`),
  );

  // BEFORE INSERT: mapping, then wallet, for the concrete source organization, before any foreign-key
  // check or derived-row mutation. It fires for a duplicate ignored by ON CONFLICT DO NOTHING too.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_lock_source() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_organization_id text;
    BEGIN
      IF TG_ARGV[0] = 'resolution' THEN
        SELECT r.organization_id INTO v_organization_id
          FROM @S@.organization_credit_reservations r WHERE r.reservation_id = NEW.reservation_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_usage_reporting_scope_missing' USING ERRCODE = '23503';
        END IF;
      ELSE
        v_organization_id := NEW.organization_id;
      END IF;
      PERFORM @S@.credit_usage_reporting_lock_organization(v_organization_id);
      RETURN NEW;
    END
    $body$;`),
  );

  // AFTER INSERT: runs only for rows that were really inserted. The writer holds the organization's
  // wallet, so the shared state lock is never contended and is never upgraded. A resolution that
  // neither releases a positive hold nor carries a usage vector is an early no-op.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_apply_source() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_kind text := TG_ARGV[0];
      v_organization_id text;
      v_amount bigint;
      v_active text;
      v_building text;
    BEGIN
      IF v_kind = 'reservation' THEN
        IF NEW.amount_micros = 0 THEN
          RETURN NULL;
        END IF;
        v_organization_id := NEW.organization_id;
      ELSE
        SELECT r.organization_id, r.amount_micros INTO v_organization_id, v_amount
          FROM @S@.organization_credit_reservations r WHERE r.reservation_id = NEW.reservation_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_usage_reporting_source_missing' USING ERRCODE = '55000';
        END IF;
        IF v_amount = 0 AND NOT COALESCE(NEW.outcome IN ('settled', 'corrected') AND isfinite(NEW.event_time), false) THEN
          RETURN NULL;
        END IF;
      END IF;
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_usage_reporting_state s WHERE s.organization_id = v_organization_id FOR SHARE;
      IF NOT FOUND OR (v_active IS NOT NULL AND v_active = v_building) THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;
      IF v_active IS NOT NULL THEN
        PERFORM @S@.credit_usage_reporting_contribute(v_organization_id, v_active, v_kind, NEW.reservation_id, false);
      END IF;
      IF v_building IS NOT NULL THEN
        PERFORM @S@.credit_usage_reporting_contribute(v_organization_id, v_building, v_kind, NEW.reservation_id, true);
      END IF;
      RETURN NULL;
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_create_state() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    BEGIN
      INSERT INTO @S@.credit_usage_reporting_state(organization_id) VALUES (NEW.organization_id);
      RETURN NULL;
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_start(
      p_organization_id text, p_generation text, p_expected_active_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_active text;
      v_building text;
      v_status text;
      v_base text;
      v_reservation_upper text;
    BEGIN
      PERFORM @S@.credit_usage_reporting_lock_organization(p_organization_id);
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_usage_reporting_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT b.status, b.base_active_generation INTO v_status, v_base
        FROM @S@.credit_usage_reporting_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF FOUND THEN
        IF v_status = 'retired' OR v_base IS DISTINCT FROM p_expected_active_generation THEN
          RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
        END IF;
        IF (v_status = 'building' AND v_building IS DISTINCT FROM p_generation)
          OR (v_status = 'active' AND v_active IS DISTINCT FROM p_generation) THEN
          RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
        END IF;
        RETURN jsonb_build_object('outcome', 'resumed');
      END IF;
      IF v_building IS NOT NULL OR v_active IS DISTINCT FROM p_expected_active_generation THEN
        RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
      END IF;
      SELECT r.reservation_id INTO v_reservation_upper FROM @S@.organization_credit_reservations r
        WHERE r.organization_id = p_organization_id ORDER BY r.reservation_id DESC LIMIT 1;
      INSERT INTO @S@.credit_usage_reporting_builds(organization_id, generation, status, base_active_generation,
        reservation_upper_id, phase, created_at, updated_at)
      VALUES (p_organization_id, p_generation, 'building', p_expected_active_generation,
        v_reservation_upper, 'reservations', now(), now());
      UPDATE @S@.credit_usage_reporting_state SET building_generation = p_generation
        WHERE organization_id = p_organization_id;
      RETURN jsonb_build_object('outcome', 'started');
    END
    $body$;`),
  );

  // One page of parent reservations per call. The constrained lateral lookup prevents a merge
  // join from scanning other organizations' resolution history before returning the first parent.
  // A custom plan keeps the NULL-cursor test a constant,
  // so every page is an index range scan from the cursor, never a rescan from the start of the
  // organization. scanned counts parents; applied counts meaningful source contributions.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_advance(
      p_organization_id text, p_generation text, p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} SET plan_cache_mode = force_custom_plan AS $body$
    DECLARE
      v_building text;
      v_status text;
      v_phase text;
      v_reservation_upper text;
      v_reservation_cursor text;
      v_last_key text;
      v_rows integer := 0;
      v_applied integer := 0;
      v_page record;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_usage_reporting_limit' USING ERRCODE = '22023';
      END IF;
      PERFORM @S@.credit_usage_reporting_lock_organization(p_organization_id);
      SELECT s.building_generation INTO v_building
        FROM @S@.credit_usage_reporting_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;
      IF v_building IS DISTINCT FROM p_generation THEN
        RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
      END IF;
      SELECT b.status, b.phase, b.reservation_upper_id, b.reservation_cursor
        INTO v_status, v_phase, v_reservation_upper, v_reservation_cursor
        FROM @S@.credit_usage_reporting_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND OR v_status <> 'building' THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;

      IF v_phase = 'reservations' THEN
        FOR v_page IN
          SELECT r.reservation_id, (x.reservation_id IS NOT NULL) AS resolved
          FROM @S@.organization_credit_reservations r
          LEFT JOIN LATERAL (
            SELECT x.reservation_id FROM @S@.organization_credit_resolutions x
            WHERE x.reservation_id = r.reservation_id LIMIT 1
          ) x ON true
          WHERE r.organization_id = p_organization_id AND r.reservation_id <= v_reservation_upper
            AND (v_reservation_cursor IS NULL OR r.reservation_id > v_reservation_cursor)
          ORDER BY r.reservation_id LIMIT p_limit
        LOOP
          v_rows := v_rows + 1;
          IF @S@.credit_usage_reporting_contribute(p_organization_id, p_generation, 'reservation', v_page.reservation_id, true) THEN
            v_applied := v_applied + 1;
          END IF;
          IF v_page.resolved THEN
            IF @S@.credit_usage_reporting_contribute(p_organization_id, p_generation, 'resolution', v_page.reservation_id, true) THEN
              v_applied := v_applied + 1;
            END IF;
          END IF;
          v_last_key := v_page.reservation_id;
        END LOOP;
        IF v_last_key IS NOT NULL THEN
          v_reservation_cursor := v_last_key;
        END IF;
        IF v_rows < p_limit THEN
          v_phase := 'complete';
        END IF;
      END IF;

      UPDATE @S@.credit_usage_reporting_builds b
        SET phase = v_phase, reservation_cursor = v_reservation_cursor,
          scanned_count = b.scanned_count + v_rows, applied_count = b.applied_count + v_applied,
          updated_at = now()
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation;
      RETURN jsonb_build_object('phase', v_phase, 'scanned', v_rows, 'applied', v_applied,
        'complete', v_phase = 'complete');
    END
    $body$;`),
  );

  // Constant-size: pointer and status updates only, no replay, reconciliation or scan.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_activate(
      p_organization_id text, p_generation text, p_expected_active_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_active text;
      v_building text;
      v_status text;
      v_phase text;
      v_base text;
    BEGIN
      PERFORM @S@.credit_usage_reporting_lock_organization(p_organization_id);
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_usage_reporting_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT b.status, b.phase, b.base_active_generation INTO v_status, v_phase, v_base
        FROM @S@.credit_usage_reporting_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
      END IF;
      IF v_status = 'active' THEN
        IF v_active IS DISTINCT FROM p_generation OR v_base IS DISTINCT FROM p_expected_active_generation THEN
          RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
        END IF;
        RETURN jsonb_build_object('outcome', 'already_active');
      END IF;
      IF v_status <> 'building' OR v_building IS DISTINCT FROM p_generation
        OR v_active IS DISTINCT FROM p_expected_active_generation THEN
        RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
      END IF;
      IF v_phase <> 'complete' THEN
        RAISE EXCEPTION 'credit_usage_reporting_not_ready' USING ERRCODE = 'CU503';
      END IF;
      IF v_active IS NOT NULL THEN
        UPDATE @S@.credit_usage_reporting_builds SET status = 'retired', updated_at = now()
          WHERE organization_id = p_organization_id AND generation = v_active;
      END IF;
      UPDATE @S@.credit_usage_reporting_builds SET status = 'active', activated_at = now(), updated_at = now()
        WHERE organization_id = p_organization_id AND generation = p_generation;
      UPDATE @S@.credit_usage_reporting_state SET active_generation = p_generation, building_generation = NULL
        WHERE organization_id = p_organization_id;
      RETURN jsonb_build_object('outcome', 'activated');
    END
    $body$;`),
  );

  // Deletes at most p_limit rows in total, never one whole-organization purge under the wallet:
  // dedupe markers of any generation that no longer builds first, then the derived rows of a
  // RETIRED generation (the active one is never touched), each by primary key in bounded chunks.
  // Ordered index keys avoid scanning unrelated heap prefixes; a custom plan keeps these small
  // pages as indexed target probes instead of a generic whole-table semijoin.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_usage_reporting_cleanup(
      p_organization_id text, p_generation text, p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} SET plan_cache_mode = force_custom_plan AS $body$
    DECLARE
      v_building text;
      v_status text;
      v_deleted bigint := 0;
      v_step bigint;
      v_remaining boolean;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_usage_reporting_limit' USING ERRCODE = '22023';
      END IF;
      PERFORM @S@.credit_usage_reporting_lock_organization(p_organization_id);
      SELECT s.building_generation INTO v_building
        FROM @S@.credit_usage_reporting_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_usage_reporting_unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT b.status INTO v_status FROM @S@.credit_usage_reporting_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND OR v_status = 'building' OR v_building IS NOT DISTINCT FROM p_generation THEN
        RAISE EXCEPTION 'credit_usage_reporting_conflict' USING ERRCODE = 'CU409';
      END IF;
      DELETE FROM @S@.credit_usage_reporting_build_applied a
        WHERE (a.organization_id, a.generation, a.source_kind, a.source_key) IN (
          SELECT m.organization_id, m.generation, m.source_kind, m.source_key
          FROM @S@.credit_usage_reporting_build_applied m
          WHERE m.organization_id = p_organization_id AND m.generation = p_generation
          ORDER BY m.source_kind, m.source_key LIMIT p_limit);
      GET DIAGNOSTICS v_step = ROW_COUNT;
      v_deleted := v_step;
      IF v_status = 'retired' AND v_deleted < p_limit THEN
        DELETE FROM @S@.credit_usage_visibility_hot a
          WHERE (a.organization_id, a.generation, a.source_kind, a.source_key) IN (
            SELECT m.organization_id, m.generation, m.source_kind, m.source_key
            FROM @S@.credit_usage_visibility_hot m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation
            ORDER BY m.source_kind, m.source_key LIMIT p_limit - v_deleted);
        GET DIAGNOSTICS v_step = ROW_COUNT;
        v_deleted := v_deleted + v_step;
      END IF;
      IF v_status = 'retired' AND v_deleted < p_limit THEN
        DELETE FROM @S@.credit_usage_project_holds a
          WHERE (a.organization_id, a.generation, a.project_id) IN (
            SELECT m.organization_id, m.generation, m.project_id
            FROM @S@.credit_usage_project_holds m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation
            ORDER BY m.project_id LIMIT p_limit - v_deleted);
        GET DIAGNOSTICS v_step = ROW_COUNT;
        v_deleted := v_deleted + v_step;
      END IF;
      IF v_status = 'retired' AND v_deleted < p_limit THEN
        DELETE FROM @S@.credit_usage_project_months a
          WHERE (a.organization_id, a.generation, a.event_month, a.project_id) IN (
            SELECT m.organization_id, m.generation, m.event_month, m.project_id
            FROM @S@.credit_usage_project_months m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation
            ORDER BY m.event_month, m.project_id LIMIT p_limit - v_deleted);
        GET DIAGNOSTICS v_step = ROW_COUNT;
        v_deleted := v_deleted + v_step;
      END IF;
      IF v_status = 'retired' AND v_deleted < p_limit THEN
        DELETE FROM @S@.credit_usage_dimensions a
          WHERE (a.organization_id, a.generation, a.dimension_id) IN (
            SELECT m.organization_id, m.generation, m.dimension_id
            FROM @S@.credit_usage_dimensions m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation
            ORDER BY m.dimension_id LIMIT p_limit - v_deleted);
        GET DIAGNOSTICS v_step = ROW_COUNT;
        v_deleted := v_deleted + v_step;
      END IF;
      v_remaining := EXISTS (SELECT 1 FROM @S@.credit_usage_reporting_build_applied m
          WHERE m.organization_id = p_organization_id AND m.generation = p_generation)
        OR (v_status = 'retired' AND (
          EXISTS (SELECT 1 FROM @S@.credit_usage_visibility_hot m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation)
          OR EXISTS (SELECT 1 FROM @S@.credit_usage_project_holds m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation)
          OR EXISTS (SELECT 1 FROM @S@.credit_usage_project_months m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation)
          OR EXISTS (SELECT 1 FROM @S@.credit_usage_dimensions m
            WHERE m.organization_id = p_organization_id AND m.generation = p_generation)));
      RETURN jsonb_build_object('deleted', v_deleted, 'remaining', v_remaining);
    END
    $body$;`),
  );

  // Owner-only: nothing here is callable by PUBLIC or by the runtime roles. Trigger functions are
  // invoked by the attached source events, which do not check EXECUTE of the inserting role.
  for (const signature of FUNCTION_SIGNATURES) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
  }

  // Explicit default ACLs may grant PUBLIC or a runtime role rights independently of the revokes
  // above. Reset every private function, table and the identity sequence for PUBLIC and both known
  // roles, then grant the roles SELECT on the approved read tables only. No directly callable admin
  // function exists for them yet; original ledger inserts reach the triggers without it.
  pgm.sql(`DO $grants$
  DECLARE
    role_name text;
    function_signature text;
    sequence_name text := pg_get_serial_sequence('credit_usage_dimensions', 'dimension_id');
  BEGIN
    REVOKE ALL ON ${ALL_TABLES.join(", ")} FROM PUBLIC;
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', sequence_name);
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        FOREACH function_signature IN ARRAY ARRAY[${FUNCTION_SIGNATURES.map((signature) => `'${signature}'`).join(", ")}] LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_signature, role_name);
        END LOOP;
        EXECUTE format('REVOKE ALL ON ${ALL_TABLES.join(", ")} FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', sequence_name, role_name);
        EXECUTE format('GRANT SELECT ON ${READABLE_TABLES.join(", ")} TO %I', role_name);
      END IF;
    END LOOP;
  END $grants$;`);

  // Seed one state row per mapping. The short table fence stops mapping writers until commit, so the
  // seed and the trigger below cover exactly the same organizations. The seed carries no foreign key
  // (a per-parent KEY SHARE would wait on released FOR UPDATE financial writers); the constraint is
  // added NOT VALID and validated with a snapshot join. The committed schema has a validated FK.
  pgm.sql(`
    LOCK TABLE workos_organization_mappings IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO credit_usage_reporting_state(organization_id)
      SELECT organization_id FROM workos_organization_mappings;
    ALTER TABLE credit_usage_reporting_state
      ADD CONSTRAINT credit_usage_reporting_state_organization_fk FOREIGN KEY (organization_id)
      REFERENCES workos_organization_mappings(organization_id) NOT VALID;
    ALTER TABLE credit_usage_reporting_state VALIDATE CONSTRAINT credit_usage_reporting_state_organization_fk;
    CREATE TRIGGER workos_organization_mappings_credit_usage_reporting_state AFTER INSERT
      ON workos_organization_mappings FOR EACH ROW EXECUTE FUNCTION credit_usage_reporting_create_state();
  `);

  // A zero-amount reservation changes nothing, so neither trigger fires for it.
  for (const [table, kind] of SOURCE_TRIGGERS) {
    const when = kind === "reservation" ? " WHEN (NEW.amount_micros > 0)" : "";
    pgm.sql(`
      CREATE TRIGGER ${table}_usage_reporting_lock BEFORE INSERT ON ${table}
        FOR EACH ROW${when} EXECUTE FUNCTION credit_usage_reporting_lock_source('${kind}');
      CREATE TRIGGER ${table}_usage_reporting_apply AFTER INSERT ON ${table}
        FOR EACH ROW${when} EXECUTE FUNCTION credit_usage_reporting_apply_source('${kind}');
    `);
  }

  restoreBounds(pgm);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  boundDdl(pgm);
  // Only owned derived objects. No original financial row is read, changed or deleted.
  pgm.sql(
    "DROP TRIGGER workos_organization_mappings_credit_usage_reporting_state ON workos_organization_mappings;",
  );
  for (const [table] of SOURCE_TRIGGERS) {
    pgm.sql(`
      DROP TRIGGER ${table}_usage_reporting_apply ON ${table};
      DROP TRIGGER ${table}_usage_reporting_lock ON ${table};
    `);
  }
  for (const signature of FUNCTION_SIGNATURES) {
    pgm.sql(`DROP FUNCTION ${signature};`);
  }
  pgm.sql(`
    ALTER TABLE credit_usage_reporting_state
      DROP CONSTRAINT credit_usage_reporting_state_active_fk,
      DROP CONSTRAINT credit_usage_reporting_state_building_fk;
    DROP TABLE ${DERIVED_TABLES.join(", ")}, credit_usage_reporting_build_applied;
    DROP TABLE credit_usage_reporting_builds;
    DROP TABLE credit_usage_reporting_state;
  `);
  restoreBounds(pgm);
}
