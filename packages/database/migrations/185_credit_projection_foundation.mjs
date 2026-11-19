// W24 F05a: transactionally maintained, generation-versioned derived views of the immutable credit
// ledger. Four views per organization: per-lot movement totals, resolution exposure, per-project
// outstanding reservations and per-project UTC event-month charges. Triggers on the four source
// tables keep the active generation exact and feed a building generation exactly once (a marker per
// source row), while a resumable, bounded per-organization backfill builds a new generation in small
// pages under the C0 lock protocol of migration 182. No monetary projection is backfilled here and no
// existing query reads these tables yet; released binaries and SQL stay authoritative and unchanged.
//
// Lock order for every writer and builder: mapping row, wallet row (both FOR NO KEY UPDATE), then the
// organization's projection state, then progress and markers, then derived rows. The BEFORE INSERT
// triggers take the first two themselves, so legacy SQL that bypasses the application is serialized
// with the builder as well; released writers already hold them (re-entrant in one transaction).

const SOURCE_TRIGGERS = [
  ["organization_credit_grants", "grant"],
  ["organization_credit_movements", "movement"],
  ["organization_credit_reservations", "reservation"],
  ["organization_credit_resolutions", "resolution"],
];

const DERIVED_TABLES = [
  "credit_lot_totals",
  "credit_org_exposure",
  "credit_project_outstanding",
  "credit_project_period_totals",
];

const FUNCTION_SIGNATURES = [
  "credit_projection_cleanup(text,text,integer)",
  "credit_projection_activate(text,text,text)",
  "credit_projection_advance(text,text,integer)",
  "credit_projection_start(text,text,text)",
  "credit_projection_create_state()",
  "credit_projection_apply_source()",
  "credit_projection_lock_source()",
  "credit_projection_contribute(text,text,text,text,boolean)",
  "credit_projection_lock_organization(text)",
];

// Every SECURITY DEFINER or trigger function is created through this wrapper. @S@ becomes the quoted
// schema that holds the organization mappings: all relations and helpers in a body are qualified by
// it and the function's own search_path is only pg_catalog (then pg_temp last), so neither the
// caller's search_path nor a temporary object can substitute anything, in public or in a test schema.
const TRUSTED_SCHEMA = `(SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = 'workos_organization_mappings'::regclass)`;

/** @param {string} definition */
const inTrustedSchema = (definition) => `DO $install$ BEGIN
  EXECUTE replace($definition$${definition}$definition$, '@S@', quote_ident(${TRUSTED_SCHEMA}));
END $install$;`;

const FIXED_PATH = "SET search_path = pg_catalog, pg_temp";

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_projection_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='100ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_projection_migration_timeouts;
           DROP TABLE pg_temp.w24_projection_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  pgm.sql(`
    DO $check$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.oid IN ('organization_credit_wallets'::regclass, 'organization_credit_grants'::regclass,
          'organization_credit_movements'::regclass, 'organization_credit_reservations'::regclass,
          'organization_credit_resolutions'::regclass)
          AND c.relnamespace IS DISTINCT FROM
            (SELECT relnamespace FROM pg_class WHERE oid = 'workos_organization_mappings'::regclass)
      ) THEN
        RAISE EXCEPTION 'Credit projections require the credit ledger and wallets in the schema of the organization mappings';
      END IF;
    END $check$;

    -- Generation pointers, one row per organization. A missing row is an invariant failure, never zero.
    CREATE TABLE credit_projection_state (
      organization_id ulid PRIMARY KEY,
      active_generation ulid,
      building_generation ulid,
      CONSTRAINT credit_projection_state_generations_differ CHECK (
        active_generation IS NULL OR building_generation IS NULL OR active_generation <> building_generation)
    );

    -- Progress of one generation, apart from the pointers. The generation id is the caller's
    -- idempotency token; the upper ids bound the finite inventory that existed at start.
    CREATE TABLE credit_projection_builds (
      organization_id ulid NOT NULL REFERENCES credit_projection_state(organization_id),
      generation ulid NOT NULL,
      status text NOT NULL CHECK (status IN ('building','active','retired')),
      base_active_generation ulid,
      grant_upper_id ulid,
      reservation_upper_id ulid,
      phase text NOT NULL CHECK (phase IN ('grants','movements','reservations','complete')),
      grant_cursor ulid,
      movement_cursor_reservation_id ulid,
      movement_cursor_grant_id ulid,
      movement_cursor_phase text,
      reservation_cursor ulid,
      scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      applied_count bigint NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      activated_at timestamptz,
      PRIMARY KEY (organization_id, generation),
      CONSTRAINT credit_projection_builds_base_differs CHECK (
        base_active_generation IS NULL OR base_active_generation <> generation),
      CONSTRAINT credit_projection_builds_movement_cursor_shape CHECK (
        (movement_cursor_reservation_id IS NULL) = (movement_cursor_grant_id IS NULL)
        AND (movement_cursor_grant_id IS NULL) = (movement_cursor_phase IS NULL)),
      CONSTRAINT credit_projection_builds_complete_before_ready CHECK (status = 'building' OR phase = 'complete'),
      CONSTRAINT credit_projection_builds_activation_shape CHECK ((status = 'building') = (activated_at IS NULL))
    );

    -- Temporary dedupe markers of a BUILDING generation: the exact original key of every applied
    -- source row. Deleted in bounded chunks once the generation no longer builds.
    CREATE TABLE credit_projection_build_applied (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      source_kind text NOT NULL CHECK (source_kind IN ('grant','movement','reservation','resolution')),
      source_key text NOT NULL CHECK (length(source_key) BETWEEN 26 AND 64),
      PRIMARY KEY (organization_id, generation, source_kind, source_key),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    );

    -- Integral numeric columns: SUM(bigint) is numeric, so a cumulative bigint could reject history the
    -- ledger accepts. A building generation may be negative before the matching reservation is counted.
    CREATE TABLE credit_lot_totals (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      grant_id ulid NOT NULL,
      reserved_micros numeric(38,0) NOT NULL DEFAULT 0,
      spent_micros numeric(38,0) NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation, grant_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    );
    CREATE TABLE credit_org_exposure (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      resolution_unfunded_micros numeric(38,0) NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    );
    CREATE TABLE credit_project_outstanding (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      project_id ulid NOT NULL,
      amount_micros numeric(38,0) NOT NULL DEFAULT 0,
      open_reservations bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation, project_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    );
    CREATE TABLE credit_project_period_totals (
      organization_id ulid NOT NULL,
      generation ulid NOT NULL,
      project_id ulid NOT NULL,
      event_month date NOT NULL CHECK (EXTRACT(day FROM event_month) = 1),
      charged_micros numeric(38,0) NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation, project_id, event_month),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    );

    -- The pointers reference validated builds. MATCH SIMPLE leaves a NULL pointer unchecked.
    ALTER TABLE credit_projection_state
      ADD CONSTRAINT credit_projection_state_active_fk FOREIGN KEY (organization_id, active_generation)
        REFERENCES credit_projection_builds(organization_id, generation),
      ADD CONSTRAINT credit_projection_state_building_fk FOREIGN KEY (organization_id, building_generation)
        REFERENCES credit_projection_builds(organization_id, generation);
  `);

  // The one index the movement keyset needs: (organization_id, grant_id) cannot bound a page ordered
  // by (reservation_id, grant_id, phase). Built without CONCURRENTLY inside the bounded transaction
  // against today's movement volume; a much larger table needs a supported concurrent-index phase.
  pgm.sql(`CREATE INDEX organization_credit_movements_projection_keyset_idx
    ON organization_credit_movements (organization_id, reservation_id, grant_id, phase);`);

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_lock_organization(p_organization_id text) RETURNS void
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      PERFORM 1 FROM @S@.workos_organization_mappings m
        WHERE m.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_scope_missing' USING ERRCODE = '23503';
      END IF;
      PERFORM 1 FROM @S@.organization_credit_wallets w
        WHERE w.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;
    END
    $body$;`),
  );

  // The only place a contribution is computed. It takes a source identity, never an amount: the row
  // is read from the immutable ledger. A marked contribution is applied at most once per generation.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_contribute(
      p_organization_id text, p_generation text, p_source_kind text, p_source_key text, p_marked boolean
    ) RETURNS boolean
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    DECLARE
      v_inserted bigint;
      v_reserved bigint;
      v_spent bigint;
      v_grant_id text;
      v_project_id text;
      v_amount bigint;
      v_outcome text;
      v_charge bigint;
      v_funded bigint;
      v_event_time timestamptz;
    BEGIN
      IF p_marked THEN
        INSERT INTO @S@.credit_projection_build_applied(organization_id, generation, source_kind, source_key)
        VALUES (p_organization_id, p_generation, p_source_kind, p_source_key)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          RETURN false;
        END IF;
      END IF;
      IF p_source_kind = 'grant' THEN
        PERFORM 1 FROM @S@.organization_credit_grants g
          WHERE g.organization_id = p_organization_id AND g.grant_id = p_source_key;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_projection_source_missing' USING ERRCODE = '55000';
        END IF;
        INSERT INTO @S@.credit_lot_totals(organization_id, generation, grant_id, reserved_micros, spent_micros)
        VALUES (p_organization_id, p_generation, p_source_key, 0, 0)
        ON CONFLICT DO NOTHING;
      ELSIF p_source_kind = 'movement' THEN
        v_grant_id := split_part(p_source_key, ':', 2);
        SELECT m.reserved_micros, m.spent_micros INTO v_reserved, v_spent
          FROM @S@.organization_credit_movements m
          WHERE m.organization_id = p_organization_id
            AND m.reservation_id = split_part(p_source_key, ':', 1)
            AND m.grant_id = v_grant_id
            AND m.phase = split_part(p_source_key, ':', 3);
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_projection_source_missing' USING ERRCODE = '55000';
        END IF;
        INSERT INTO @S@.credit_lot_totals AS t(organization_id, generation, grant_id, reserved_micros, spent_micros)
        VALUES (p_organization_id, p_generation, v_grant_id, v_reserved, v_spent)
        ON CONFLICT (organization_id, generation, grant_id) DO UPDATE
          SET reserved_micros = t.reserved_micros + EXCLUDED.reserved_micros,
              spent_micros = t.spent_micros + EXCLUDED.spent_micros;
      ELSIF p_source_kind = 'reservation' THEN
        SELECT r.project_id, r.amount_micros INTO v_project_id, v_amount
          FROM @S@.organization_credit_reservations r
          WHERE r.organization_id = p_organization_id AND r.reservation_id = p_source_key;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_projection_source_missing' USING ERRCODE = '55000';
        END IF;
        INSERT INTO @S@.credit_project_outstanding AS t(organization_id, generation, project_id, amount_micros, open_reservations)
        VALUES (p_organization_id, p_generation, v_project_id, v_amount, 1)
        ON CONFLICT (organization_id, generation, project_id) DO UPDATE
          SET amount_micros = t.amount_micros + EXCLUDED.amount_micros,
              open_reservations = t.open_reservations + EXCLUDED.open_reservations;
      ELSIF p_source_kind = 'resolution' THEN
        SELECT r.project_id, r.amount_micros, x.outcome, x.charge_micros, x.funded_micros, x.event_time
          INTO v_project_id, v_amount, v_outcome, v_charge, v_funded, v_event_time
          FROM @S@.organization_credit_resolutions x
          JOIN @S@.organization_credit_reservations r ON r.reservation_id = x.reservation_id
          WHERE x.reservation_id = p_source_key AND r.organization_id = p_organization_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_projection_source_missing' USING ERRCODE = '55000';
        END IF;
        UPDATE @S@.credit_org_exposure e
          SET resolution_unfunded_micros = e.resolution_unfunded_micros + (v_charge::numeric - v_funded::numeric)
          WHERE e.organization_id = p_organization_id AND e.generation = p_generation;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
        END IF;
        INSERT INTO @S@.credit_project_outstanding AS t(organization_id, generation, project_id, amount_micros, open_reservations)
        VALUES (p_organization_id, p_generation, v_project_id, -v_amount, -1)
        ON CONFLICT (organization_id, generation, project_id) DO UPDATE
          SET amount_micros = t.amount_micros + EXCLUDED.amount_micros,
              open_reservations = t.open_reservations + EXCLUDED.open_reservations;
        IF v_outcome IN ('settled', 'corrected') THEN
          INSERT INTO @S@.credit_project_period_totals AS t(organization_id, generation, project_id, event_month, charged_micros)
          VALUES (p_organization_id, p_generation, v_project_id,
            date_trunc('month', v_event_time AT TIME ZONE 'UTC')::date, v_charge)
          ON CONFLICT (organization_id, generation, project_id, event_month) DO UPDATE
            SET charged_micros = t.charged_micros + EXCLUDED.charged_micros;
        END IF;
      ELSE
        RAISE EXCEPTION 'credit_projection_source_kind' USING ERRCODE = '22023';
      END IF;
      RETURN true;
    END
    $body$;`),
  );

  // BEFORE INSERT: mapping, then wallet, for the concrete source organization, before any foreign-key
  // check or derived-row mutation. It fires for a duplicate ignored by ON CONFLICT DO NOTHING too.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_lock_source() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_organization_id text;
    BEGIN
      IF TG_ARGV[0] = 'resolution' THEN
        SELECT r.organization_id INTO v_organization_id
          FROM @S@.organization_credit_reservations r WHERE r.reservation_id = NEW.reservation_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'credit_projection_scope_missing' USING ERRCODE = '23503';
        END IF;
      ELSE
        v_organization_id := NEW.organization_id;
      END IF;
      PERFORM @S@.credit_projection_lock_organization(v_organization_id);
      RETURN NEW;
    END
    $body$;`),
  );

  // AFTER INSERT: runs only for rows that were really inserted. The writer holds the organization's
  // wallet, so the shared state lock is never contended and is never upgraded.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_apply_source() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_kind text := TG_ARGV[0];
      v_organization_id text;
      v_key text;
      v_active text;
      v_building text;
    BEGIN
      IF v_kind = 'grant' THEN
        v_organization_id := NEW.organization_id;
        v_key := NEW.grant_id;
      ELSIF v_kind = 'movement' THEN
        v_organization_id := NEW.organization_id;
        v_key := NEW.reservation_id::text || ':' || NEW.grant_id::text || ':' || NEW.phase;
      ELSIF v_kind = 'reservation' THEN
        v_organization_id := NEW.organization_id;
        v_key := NEW.reservation_id;
      ELSE
        SELECT r.organization_id INTO v_organization_id
          FROM @S@.organization_credit_reservations r WHERE r.reservation_id = NEW.reservation_id;
        v_key := NEW.reservation_id;
      END IF;
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_projection_state s WHERE s.organization_id = v_organization_id FOR SHARE;
      IF NOT FOUND OR (v_active IS NOT NULL AND v_active = v_building) THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;
      IF v_active IS NOT NULL THEN
        PERFORM @S@.credit_projection_contribute(v_organization_id, v_active, v_kind, v_key, false);
      END IF;
      IF v_building IS NOT NULL THEN
        PERFORM @S@.credit_projection_contribute(v_organization_id, v_building, v_kind, v_key, true);
      END IF;
      RETURN NULL;
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_create_state() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    BEGIN
      INSERT INTO @S@.credit_projection_state(organization_id) VALUES (NEW.organization_id);
      RETURN NULL;
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_start(
      p_organization_id text, p_generation text, p_expected_active_generation text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_active text;
      v_building text;
      v_status text;
      v_base text;
      v_grant_upper text;
      v_reservation_upper text;
    BEGIN
      PERFORM @S@.credit_projection_lock_organization(p_organization_id);
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_projection_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT b.status, b.base_active_generation INTO v_status, v_base
        FROM @S@.credit_projection_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF FOUND THEN
        IF v_status = 'retired' OR v_base IS DISTINCT FROM p_expected_active_generation THEN
          RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
        END IF;
        IF (v_status = 'building' AND v_building IS DISTINCT FROM p_generation)
          OR (v_status = 'active' AND v_active IS DISTINCT FROM p_generation) THEN
          RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
        END IF;
        RETURN jsonb_build_object('outcome', 'resumed');
      END IF;
      IF v_building IS NOT NULL OR v_active IS DISTINCT FROM p_expected_active_generation THEN
        RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
      END IF;
      SELECT g.grant_id INTO v_grant_upper FROM @S@.organization_credit_grants g
        WHERE g.organization_id = p_organization_id ORDER BY g.grant_id DESC LIMIT 1;
      SELECT r.reservation_id INTO v_reservation_upper FROM @S@.organization_credit_reservations r
        WHERE r.organization_id = p_organization_id ORDER BY r.reservation_id DESC LIMIT 1;
      INSERT INTO @S@.credit_projection_builds(organization_id, generation, status, base_active_generation,
        grant_upper_id, reservation_upper_id, phase, created_at, updated_at)
      VALUES (p_organization_id, p_generation, 'building', p_expected_active_generation,
        v_grant_upper, v_reservation_upper, 'grants', now(), now());
      INSERT INTO @S@.credit_org_exposure(organization_id, generation) VALUES (p_organization_id, p_generation);
      UPDATE @S@.credit_projection_state SET building_generation = p_generation
        WHERE organization_id = p_organization_id;
      RETURN jsonb_build_object('outcome', 'started');
    END
    $body$;`),
  );

  // One page of one phase per call. A custom plan keeps the NULL-cursor test a constant, so every
  // page is an index range scan from the cursor, never a rescan from the start of the organization.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_advance(
      p_organization_id text, p_generation text, p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} SET plan_cache_mode = force_custom_plan AS $body$
    DECLARE
      v_building text;
      v_status text;
      v_phase text;
      v_grant_upper text;
      v_reservation_upper text;
      v_grant_cursor text;
      v_movement_reservation text;
      v_movement_grant text;
      v_movement_phase text;
      v_reservation_cursor text;
      v_last_key text;
      v_last_reservation text;
      v_last_grant text;
      v_last_phase text;
      v_rows integer := 0;
      v_scanned integer := 0;
      v_applied integer := 0;
      v_page record;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_projection_limit' USING ERRCODE = '22023';
      END IF;
      PERFORM @S@.credit_projection_lock_organization(p_organization_id);
      SELECT s.building_generation INTO v_building
        FROM @S@.credit_projection_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;
      IF v_building IS DISTINCT FROM p_generation THEN
        RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
      END IF;
      SELECT b.status, b.phase, b.grant_upper_id, b.reservation_upper_id, b.grant_cursor,
          b.movement_cursor_reservation_id, b.movement_cursor_grant_id, b.movement_cursor_phase,
          b.reservation_cursor
        INTO v_status, v_phase, v_grant_upper, v_reservation_upper, v_grant_cursor,
          v_movement_reservation, v_movement_grant, v_movement_phase, v_reservation_cursor
        FROM @S@.credit_projection_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND OR v_status <> 'building' THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;

      IF v_phase = 'grants' THEN
        FOR v_page IN
          SELECT g.grant_id FROM @S@.organization_credit_grants g
          WHERE g.organization_id = p_organization_id AND g.grant_id <= v_grant_upper
            AND (v_grant_cursor IS NULL OR g.grant_id > v_grant_cursor)
          ORDER BY g.grant_id LIMIT p_limit
        LOOP
          v_rows := v_rows + 1;
          v_scanned := v_scanned + 1;
          IF @S@.credit_projection_contribute(p_organization_id, p_generation, 'grant', v_page.grant_id, true) THEN
            v_applied := v_applied + 1;
          END IF;
          v_last_key := v_page.grant_id;
        END LOOP;
        IF v_last_key IS NOT NULL THEN
          v_grant_cursor := v_last_key;
        END IF;
        IF v_rows < p_limit THEN
          v_phase := 'movements';
        END IF;
      ELSIF v_phase = 'movements' THEN
        FOR v_page IN
          SELECT m.reservation_id, m.grant_id, m.phase FROM @S@.organization_credit_movements m
          WHERE m.organization_id = p_organization_id AND m.reservation_id <= v_reservation_upper
            AND (v_movement_reservation IS NULL
              OR (m.reservation_id, m.grant_id, m.phase) > (v_movement_reservation, v_movement_grant, v_movement_phase))
          ORDER BY m.reservation_id, m.grant_id, m.phase LIMIT p_limit
        LOOP
          v_rows := v_rows + 1;
          v_scanned := v_scanned + 1;
          IF @S@.credit_projection_contribute(p_organization_id, p_generation, 'movement',
            v_page.reservation_id::text || ':' || v_page.grant_id::text || ':' || v_page.phase, true) THEN
            v_applied := v_applied + 1;
          END IF;
          v_last_reservation := v_page.reservation_id;
          v_last_grant := v_page.grant_id;
          v_last_phase := v_page.phase;
        END LOOP;
        IF v_last_reservation IS NOT NULL THEN
          v_movement_reservation := v_last_reservation;
          v_movement_grant := v_last_grant;
          v_movement_phase := v_last_phase;
        END IF;
        IF v_rows < p_limit THEN
          v_phase := 'reservations';
        END IF;
      ELSIF v_phase = 'reservations' THEN
        FOR v_page IN
          SELECT r.reservation_id, (x.reservation_id IS NOT NULL) AS resolved
          FROM @S@.organization_credit_reservations r
          LEFT JOIN @S@.organization_credit_resolutions x ON x.reservation_id = r.reservation_id
          WHERE r.organization_id = p_organization_id AND r.reservation_id <= v_reservation_upper
            AND (v_reservation_cursor IS NULL OR r.reservation_id > v_reservation_cursor)
          ORDER BY r.reservation_id LIMIT p_limit
        LOOP
          v_rows := v_rows + 1;
          v_scanned := v_scanned + 1;
          IF @S@.credit_projection_contribute(p_organization_id, p_generation, 'reservation', v_page.reservation_id, true) THEN
            v_applied := v_applied + 1;
          END IF;
          IF v_page.resolved THEN
            v_scanned := v_scanned + 1;
            IF @S@.credit_projection_contribute(p_organization_id, p_generation, 'resolution', v_page.reservation_id, true) THEN
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

      UPDATE @S@.credit_projection_builds b
        SET phase = v_phase, grant_cursor = v_grant_cursor,
          movement_cursor_reservation_id = v_movement_reservation,
          movement_cursor_grant_id = v_movement_grant, movement_cursor_phase = v_movement_phase,
          reservation_cursor = v_reservation_cursor,
          scanned_count = b.scanned_count + v_scanned, applied_count = b.applied_count + v_applied,
          updated_at = now()
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation;
      RETURN jsonb_build_object('phase', v_phase, 'scanned', v_scanned, 'applied', v_applied,
        'complete', v_phase = 'complete');
    END
    $body$;`),
  );

  // Constant-size: pointer and status updates only, no replay, reconciliation or per-lot scan.
  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_activate(
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
      PERFORM @S@.credit_projection_lock_organization(p_organization_id);
      SELECT s.active_generation, s.building_generation INTO v_active, v_building
        FROM @S@.credit_projection_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT b.status, b.phase, b.base_active_generation INTO v_status, v_phase, v_base
        FROM @S@.credit_projection_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
      END IF;
      IF v_status = 'active' THEN
        IF v_active IS DISTINCT FROM p_generation OR v_base IS DISTINCT FROM p_expected_active_generation THEN
          RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
        END IF;
        RETURN jsonb_build_object('outcome', 'already_active');
      END IF;
      IF v_status <> 'building' OR v_building IS DISTINCT FROM p_generation
        OR v_active IS DISTINCT FROM p_expected_active_generation THEN
        RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
      END IF;
      IF v_phase <> 'complete' THEN
        RAISE EXCEPTION 'credit_projection_not_ready' USING ERRCODE = 'CP503';
      END IF;
      IF v_active IS NOT NULL THEN
        UPDATE @S@.credit_projection_builds SET status = 'retired', updated_at = now()
          WHERE organization_id = p_organization_id AND generation = v_active;
      END IF;
      UPDATE @S@.credit_projection_builds SET status = 'active', activated_at = now(), updated_at = now()
        WHERE organization_id = p_organization_id AND generation = p_generation;
      UPDATE @S@.credit_projection_state SET active_generation = p_generation, building_generation = NULL
        WHERE organization_id = p_organization_id;
      RETURN jsonb_build_object('outcome', 'activated');
    END
    $body$;`),
  );

  pgm.sql(
    inTrustedSchema(`
    CREATE FUNCTION @S@.credit_projection_cleanup(
      p_organization_id text, p_generation text, p_limit integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_building text;
      v_status text;
      v_deleted bigint;
      v_remaining boolean;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 64 THEN
        RAISE EXCEPTION 'credit_projection_limit' USING ERRCODE = '22023';
      END IF;
      PERFORM @S@.credit_projection_lock_organization(p_organization_id);
      SELECT s.building_generation INTO v_building
        FROM @S@.credit_projection_state s WHERE s.organization_id = p_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_projection_unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT b.status INTO v_status FROM @S@.credit_projection_builds b
        WHERE b.organization_id = p_organization_id AND b.generation = p_generation FOR NO KEY UPDATE;
      IF NOT FOUND OR v_status = 'building' OR v_building IS NOT DISTINCT FROM p_generation THEN
        RAISE EXCEPTION 'credit_projection_conflict' USING ERRCODE = 'CP409';
      END IF;
      DELETE FROM @S@.credit_projection_build_applied a
        WHERE (a.organization_id, a.generation, a.source_kind, a.source_key) IN (
          SELECT m.organization_id, m.generation, m.source_kind, m.source_key
          FROM @S@.credit_projection_build_applied m
          WHERE m.organization_id = p_organization_id AND m.generation = p_generation LIMIT p_limit);
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      v_remaining := EXISTS (SELECT 1 FROM @S@.credit_projection_build_applied m
        WHERE m.organization_id = p_organization_id AND m.generation = p_generation);
      RETURN jsonb_build_object('deleted', v_deleted, 'remaining', v_remaining);
    END
    $body$;`),
  );

  // Owner-only: nothing here is callable by PUBLIC or by the runtime role. Trigger functions are
  // invoked by the attached source events, which do not check EXECUTE of the inserting role.
  for (const signature of FUNCTION_SIGNATURES) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
  }

  // Explicit default ACLs may grant a runtime role rights independently of PUBLIC. Reset both
  // known roles on every private function and derived table, then grant only reader access.
  // Original ledger inserts invoke attached triggers without the inserting role's EXECUTE privilege.
  pgm.sql(`DO $grants$
  DECLARE role_name text; function_signature text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        FOREACH function_signature IN ARRAY ARRAY[${FUNCTION_SIGNATURES.map((signature) => `'${signature}'`).join(", ")}] LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_signature, role_name);
        END LOOP;
        EXECUTE format('REVOKE ALL ON credit_projection_state, credit_projection_builds,
          credit_projection_build_applied, credit_lot_totals, credit_org_exposure,
          credit_project_outstanding, credit_project_period_totals FROM %I', role_name);
        EXECUTE format('GRANT SELECT ON credit_projection_state, credit_projection_builds,
          credit_lot_totals, credit_org_exposure, credit_project_outstanding,
          credit_project_period_totals TO %I', role_name);
      END IF;
    END LOOP;
  END $grants$;`);

  // Seed one state row per mapping. The short table fence stops mapping writers until commit, so the
  // seed and the trigger below cover exactly the same organizations. The seed carries no foreign key
  // (a per-parent KEY SHARE would wait on released FOR UPDATE financial writers); the constraint is
  // added NOT VALID and validated with a snapshot join. The committed schema has a validated FK.
  pgm.sql(`
    LOCK TABLE workos_organization_mappings IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO credit_projection_state(organization_id)
      SELECT organization_id FROM workos_organization_mappings;
    ALTER TABLE credit_projection_state
      ADD CONSTRAINT credit_projection_state_organization_fk FOREIGN KEY (organization_id)
      REFERENCES workos_organization_mappings(organization_id) NOT VALID;
    ALTER TABLE credit_projection_state VALIDATE CONSTRAINT credit_projection_state_organization_fk;
    CREATE TRIGGER workos_organization_mappings_credit_projection_state AFTER INSERT
      ON workos_organization_mappings FOR EACH ROW EXECUTE FUNCTION credit_projection_create_state();
  `);

  for (const [table, kind] of SOURCE_TRIGGERS) {
    pgm.sql(`
      CREATE TRIGGER ${table}_projection_lock BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION credit_projection_lock_source('${kind}');
      CREATE TRIGGER ${table}_projection_apply AFTER INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION credit_projection_apply_source('${kind}');
    `);
  }

  restoreBounds(pgm);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  boundDdl(pgm);
  // Only owned derived objects. No original financial row is read, changed or deleted.
  pgm.sql(
    "DROP TRIGGER workos_organization_mappings_credit_projection_state ON workos_organization_mappings;",
  );
  for (const [table] of SOURCE_TRIGGERS) {
    pgm.sql(`
      DROP TRIGGER ${table}_projection_apply ON ${table};
      DROP TRIGGER ${table}_projection_lock ON ${table};
    `);
  }
  for (const signature of FUNCTION_SIGNATURES) {
    pgm.sql(`DROP FUNCTION ${signature};`);
  }
  pgm.sql("DROP INDEX organization_credit_movements_projection_keyset_idx;");
  pgm.sql(`
    ALTER TABLE credit_projection_state
      DROP CONSTRAINT credit_projection_state_active_fk,
      DROP CONSTRAINT credit_projection_state_building_fk;
    DROP TABLE ${DERIVED_TABLES.join(", ")}, credit_projection_build_applied;
    DROP TABLE credit_projection_builds;
    DROP TABLE credit_projection_state;
  `);
  restoreBounds(pgm);
}
