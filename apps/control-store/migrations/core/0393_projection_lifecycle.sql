-- Original185/187/190/191/198 projection lifecycle. These caches do not grant a financial authority.
CREATE TABLE credit_projection_state (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') PRIMARY KEY,
      active_generation TEXT CHECK(length(active_generation)=26 AND active_generation GLOB '[0-7]*' AND active_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      building_generation TEXT CHECK(length(building_generation)=26 AND building_generation GLOB '[0-7]*' AND building_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      CONSTRAINT credit_projection_state_generations_differ CHECK (
        active_generation IS NULL OR building_generation IS NULL OR active_generation <> building_generation),
      FOREIGN KEY(organization_id) REFERENCES organizations(organization_id),
      FOREIGN KEY(organization_id,active_generation) REFERENCES credit_projection_builds(organization_id,generation),
      FOREIGN KEY(organization_id,building_generation) REFERENCES credit_projection_builds(organization_id,generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_projection_builds (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL REFERENCES credit_projection_state(organization_id),
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','active','retired')),
      base_active_generation TEXT CHECK(length(base_active_generation)=26 AND base_active_generation GLOB '[0-7]*' AND base_active_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      grant_upper_id TEXT CHECK(length(grant_upper_id)=26 AND grant_upper_id GLOB '[0-7]*' AND grant_upper_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      reservation_upper_id TEXT CHECK(length(reservation_upper_id)=26 AND reservation_upper_id GLOB '[0-7]*' AND reservation_upper_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      phase TEXT NOT NULL CHECK (phase IN ('grants','movements','reservations','complete')),
      grant_cursor TEXT CHECK(length(grant_cursor)=26 AND grant_cursor GLOB '[0-7]*' AND grant_cursor NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      movement_cursor_reservation_id TEXT CHECK(length(movement_cursor_reservation_id)=26 AND movement_cursor_reservation_id GLOB '[0-7]*' AND movement_cursor_reservation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      movement_cursor_grant_id TEXT CHECK(length(movement_cursor_grant_id)=26 AND movement_cursor_grant_id GLOB '[0-7]*' AND movement_cursor_grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      movement_cursor_phase TEXT,
      reservation_cursor TEXT CHECK(length(reservation_cursor)=26 AND reservation_cursor GLOB '[0-7]*' AND reservation_cursor NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      PRIMARY KEY (organization_id, generation),
      CONSTRAINT credit_projection_builds_base_differs CHECK (
        base_active_generation IS NULL OR base_active_generation <> generation),
      CONSTRAINT credit_projection_builds_movement_cursor_shape CHECK (
        (movement_cursor_reservation_id IS NULL) = (movement_cursor_grant_id IS NULL)
        AND (movement_cursor_grant_id IS NULL) = (movement_cursor_phase IS NULL)),
      CONSTRAINT credit_projection_builds_complete_before_ready CHECK (status = 'building' OR phase = 'complete'),
      CONSTRAINT credit_projection_builds_activation_shape CHECK ((status = 'building') = (activated_at IS NULL))
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_projection_build_applied (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('grant','movement','reservation','resolution')),
      source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 26 AND 64),
      PRIMARY KEY (organization_id, generation, source_kind, source_key),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_lot_totals (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      grant_id TEXT CHECK(length(grant_id)=26 AND grant_id GLOB '[0-7]*' AND grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      reserved_micros TEXT CHECK((reserved_micros='0' OR (reserved_micros NOT GLOB '*[^0-9]*' AND substr(reserved_micros,1,1) GLOB '[1-9]') OR (substr(reserved_micros,1,1)='-' AND substr(reserved_micros,2,1) GLOB '[1-9]' AND substr(reserved_micros,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(reserved_micros,'-'))<=38) NOT NULL DEFAULT 0,
      spent_micros TEXT CHECK((spent_micros='0' OR (spent_micros NOT GLOB '*[^0-9]*' AND substr(spent_micros,1,1) GLOB '[1-9]') OR (substr(spent_micros,1,1)='-' AND substr(spent_micros,2,1) GLOB '[1-9]' AND substr(spent_micros,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(spent_micros,'-'))<=38) NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation, grant_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;
CREATE TABLE credit_org_exposure (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      resolution_unfunded_micros TEXT CHECK((resolution_unfunded_micros='0' OR (resolution_unfunded_micros NOT GLOB '*[^0-9]*' AND substr(resolution_unfunded_micros,1,1) GLOB '[1-9]') OR (substr(resolution_unfunded_micros,1,1)='-' AND substr(resolution_unfunded_micros,2,1) GLOB '[1-9]' AND substr(resolution_unfunded_micros,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(resolution_unfunded_micros,'-'))<=38) NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;
CREATE TABLE credit_project_outstanding (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      amount_micros TEXT CHECK((amount_micros='0' OR (amount_micros NOT GLOB '*[^0-9]*' AND substr(amount_micros,1,1) GLOB '[1-9]') OR (substr(amount_micros,1,1)='-' AND substr(amount_micros,2,1) GLOB '[1-9]' AND substr(amount_micros,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(amount_micros,'-'))<=38) NOT NULL DEFAULT 0,
      open_reservations INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation, project_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;
CREATE TABLE credit_project_period_totals (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      event_month TEXT NOT NULL CHECK (event_month GLOB '????-??-01'),
      charged_micros TEXT CHECK((charged_micros='0' OR (charged_micros NOT GLOB '*[^0-9]*' AND substr(charged_micros,1,1) GLOB '[1-9]') OR (substr(charged_micros,1,1)='-' AND substr(charged_micros,2,1) GLOB '[1-9]' AND substr(charged_micros,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(charged_micros,'-'))<=38) NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, generation, project_id, event_month),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_projection_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_expiry_state (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') PRIMARY KEY,
      source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
      active_generation TEXT CHECK(length(active_generation)=26 AND active_generation GLOB '[0-7]*' AND active_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      active_revision INTEGER CHECK (active_revision >= 0),
      building_generation TEXT CHECK(length(building_generation)=26 AND building_generation GLOB '[0-7]*' AND building_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      CONSTRAINT credit_expiry_state_generations_differ CHECK (
        active_generation IS NULL OR building_generation IS NULL OR active_generation <> building_generation),
      CONSTRAINT credit_expiry_state_active_shape CHECK (
        (active_generation IS NULL) = (active_revision IS NULL)),
      CONSTRAINT credit_expiry_state_active_not_ahead CHECK (
        active_revision IS NULL OR active_revision <= source_revision),
      FOREIGN KEY(organization_id) REFERENCES organizations(organization_id),
      FOREIGN KEY(organization_id,active_generation) REFERENCES credit_expiry_builds(organization_id,generation),
      FOREIGN KEY(organization_id,building_generation) REFERENCES credit_expiry_builds(organization_id,generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_expiry_builds (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL REFERENCES credit_expiry_state(organization_id),
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      policy_version TEXT NOT NULL CHECK (policy_version = 'v1'),
      target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
      expected_active_generation TEXT CHECK(length(expected_active_generation)=26 AND expected_active_generation GLOB '[0-7]*' AND expected_active_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      grant_upper_id TEXT CHECK(length(grant_upper_id)=26 AND grant_upper_id GLOB '[0-7]*' AND grant_upper_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      grant_cursor TEXT CHECK(length(grant_cursor)=26 AND grant_cursor GLOB '[0-7]*' AND grant_cursor NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      status TEXT NOT NULL CHECK (status IN ('building','complete','active','retired','invalidated')),
      scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      written_count INTEGER NOT NULL DEFAULT 0 CHECK (written_count >= 0),
      created_at TEXT NOT NULL,
      published_at TEXT,
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
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_expiry_lots (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      grant_id TEXT CHECK(length(grant_id)=26 AND grant_id GLOB '[0-7]*' AND grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      expires_at TEXT,
      is_topup INTEGER CHECK(is_topup IN(0,1)) NOT NULL,
      PRIMARY KEY (organization_id, generation, grant_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_expiry_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_usage_reporting_state (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') PRIMARY KEY,
      active_generation TEXT CHECK(length(active_generation)=26 AND active_generation GLOB '[0-7]*' AND active_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      building_generation TEXT CHECK(length(building_generation)=26 AND building_generation GLOB '[0-7]*' AND building_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      CONSTRAINT credit_usage_reporting_state_generations_differ CHECK (
        active_generation IS NULL OR building_generation IS NULL OR active_generation <> building_generation),
      FOREIGN KEY(organization_id) REFERENCES organizations(organization_id),
      FOREIGN KEY(organization_id,active_generation) REFERENCES credit_usage_reporting_builds(organization_id,generation),
      FOREIGN KEY(organization_id,building_generation) REFERENCES credit_usage_reporting_builds(organization_id,generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_usage_reporting_builds (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL REFERENCES credit_usage_reporting_state(organization_id),
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','active','retired')),
      base_active_generation TEXT CHECK(length(base_active_generation)=26 AND base_active_generation GLOB '[0-7]*' AND base_active_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      reservation_upper_id TEXT CHECK(length(reservation_upper_id)=26 AND reservation_upper_id GLOB '[0-7]*' AND reservation_upper_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      phase TEXT NOT NULL CHECK (phase IN ('reservations','complete')),
      reservation_cursor TEXT CHECK(length(reservation_cursor)=26 AND reservation_cursor GLOB '[0-7]*' AND reservation_cursor NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      PRIMARY KEY (organization_id, generation),
      CONSTRAINT credit_usage_reporting_builds_base_differs CHECK (
        base_active_generation IS NULL OR base_active_generation <> generation),
      CONSTRAINT credit_usage_reporting_builds_complete_before_ready CHECK (status = 'building' OR phase = 'complete'),
      CONSTRAINT credit_usage_reporting_builds_activation_shape CHECK ((status = 'building') = (activated_at IS NULL))
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_usage_reporting_build_applied (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('reservation','resolution')),
      source_key TEXT NOT NULL,
      PRIMARY KEY (organization_id, generation, source_kind, source_key),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_usage_dimensions (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      dimension_id INTEGER NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      event_month TEXT NOT NULL CHECK (event_month GLOB '????-??-01'),
      environment_id TEXT CHECK(length(environment_id)=26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      rate_card_id TEXT NOT NULL,
      meter TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity TEXT CHECK((quantity='0' OR (quantity NOT GLOB '*[^0-9]*' AND substr(quantity,1,1) GLOB '[1-9]') OR (substr(quantity,1,1)='-' AND substr(quantity,2,1) GLOB '[1-9]' AND substr(quantity,2) NOT GLOB '*[^0-9]*'))) NOT NULL CHECK (quantity='0' OR (quantity NOT GLOB '*[^0-9-]*' AND ltrim(quantity,'-') NOT GLOB '0*')),
      charged_micros TEXT CHECK((charged_micros='0' OR (charged_micros NOT GLOB '*[^0-9]*' AND substr(charged_micros,1,1) GLOB '[1-9]') OR (substr(charged_micros,1,1)='-' AND substr(charged_micros,2,1) GLOB '[1-9]' AND substr(charged_micros,2) NOT GLOB '*[^0-9]*'))) NOT NULL CHECK (charged_micros='0' OR (charged_micros NOT GLOB '*[^0-9-]*' AND ltrim(charged_micros,'-') NOT GLOB '0*')),
      funded_micros TEXT CHECK((funded_micros='0' OR (funded_micros NOT GLOB '*[^0-9]*' AND substr(funded_micros,1,1) GLOB '[1-9]') OR (substr(funded_micros,1,1)='-' AND substr(funded_micros,2,1) GLOB '[1-9]' AND substr(funded_micros,2) NOT GLOB '*[^0-9]*'))) NOT NULL CHECK (funded_micros='0' OR (funded_micros NOT GLOB '*[^0-9-]*' AND ltrim(funded_micros,'-') NOT GLOB '0*')),
      platform_overrun_micros TEXT CHECK((platform_overrun_micros='0' OR (platform_overrun_micros NOT GLOB '*[^0-9]*' AND substr(platform_overrun_micros,1,1) GLOB '[1-9]') OR (substr(platform_overrun_micros,1,1)='-' AND substr(platform_overrun_micros,2,1) GLOB '[1-9]' AND substr(platform_overrun_micros,2) NOT GLOB '*[^0-9]*'))) NOT NULL CHECK (platform_overrun_micros='0' OR (platform_overrun_micros NOT GLOB '*[^0-9-]*' AND ltrim(platform_overrun_micros,'-') NOT GLOB '0*')),
      report_row_count INTEGER NOT NULL,
      first_visible_at TEXT NOT NULL,
      last_visible_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, generation, dimension_id),
      CONSTRAINT credit_usage_dimensions_identity_key UNIQUE (
        organization_id, generation, project_id, event_month, environment_id, rate_card_id, meter, unit),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;
CREATE INDEX credit_usage_dimensions_project_month_idx
      ON credit_usage_dimensions (organization_id, generation, project_id, event_month, dimension_id);

CREATE TABLE credit_usage_project_months (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      event_month TEXT NOT NULL CHECK (event_month GLOB '????-??-01'),
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      first_visible_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, generation, event_month, project_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_usage_project_holds (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      current_amount_micros TEXT CHECK((current_amount_micros='0' OR (current_amount_micros NOT GLOB '*[^0-9]*' AND substr(current_amount_micros,1,1) GLOB '[1-9]') OR (substr(current_amount_micros,1,1)='-' AND substr(current_amount_micros,2,1) GLOB '[1-9]' AND substr(current_amount_micros,2) NOT GLOB '*[^0-9]*'))) NOT NULL CHECK (current_amount_micros='0' OR (current_amount_micros NOT GLOB '*[^0-9-]*' AND ltrim(current_amount_micros,'-') NOT GLOB '0*')),
      positive_open_count INTEGER NOT NULL,
      first_positive_reserved_at TEXT NOT NULL,
      last_effective_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, generation, project_id),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_usage_visibility_hot (
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('reservation','resolution')),
      source_key TEXT NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      effective_at TEXT NOT NULL,
      has_positive_hold INTEGER CHECK(has_positive_hold IN(0,1)) NOT NULL,
      dimension_id INTEGER,
      event_month TEXT,
      PRIMARY KEY (organization_id, generation, source_kind, source_key),
      FOREIGN KEY (organization_id, generation) REFERENCES credit_usage_reporting_builds(organization_id, generation),
      CONSTRAINT credit_usage_visibility_hot_shape CHECK (
        (dimension_id IS NULL) = (event_month IS NULL)
        AND (source_kind = 'resolution' OR (has_positive_hold AND dimension_id IS NULL))
        AND (has_positive_hold OR dimension_id IS NOT NULL))
    ) STRICT, WITHOUT ROWID;
CREATE INDEX credit_usage_visibility_hot_hold_tail_idx
      ON credit_usage_visibility_hot (organization_id, generation, project_id, effective_at, source_kind, source_key)
      WHERE has_positive_hold;
CREATE INDEX credit_usage_visibility_hot_usage_tail_idx
      ON credit_usage_visibility_hot (organization_id, generation, project_id, event_month, dimension_id, effective_at, source_key)
      WHERE dimension_id IS NOT NULL;

CREATE TABLE credit_source_custody (
      singleton INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK(singleton=1),
      mode TEXT NOT NULL CHECK (mode = 'hot_only')
    ) STRICT, WITHOUT ROWID;
INSERT INTO credit_source_custody(singleton, mode) VALUES (1, 'hot_only');

CREATE TABLE credit_source_builds (
      source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
      source_reference TEXT NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 256),
      generation TEXT CHECK(length(generation)=26 AND generation GLOB '[0-7]*' AND generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','active','failed')),
      phase TEXT NOT NULL CHECK (phase IN ('valuations','movements','complete')),
      failure TEXT CHECK (failure IN ('organization_conflict','scope_conflict','resolution_missing')),
      valuation_upper_id TEXT CHECK(length(valuation_upper_id)=26 AND valuation_upper_id GLOB '[0-7]*' AND valuation_upper_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      valuation_cursor TEXT CHECK(length(valuation_cursor)=26 AND valuation_cursor GLOB '[0-7]*' AND valuation_cursor NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      movement_cursor_grant_id TEXT CHECK(length(movement_cursor_grant_id)=26 AND movement_cursor_grant_id GLOB '[0-7]*' AND movement_cursor_grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      movement_cursor_phase TEXT,
      scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      PRIMARY KEY (source_kind, source_reference),
      CONSTRAINT credit_source_builds_cursor_shape CHECK (
        (movement_cursor_grant_id IS NULL) = (movement_cursor_phase IS NULL)
        AND (movement_cursor_grant_id IS NULL OR valuation_cursor IS NOT NULL)),
      CONSTRAINT credit_source_builds_failure_shape CHECK ((status = 'failed') = (failure IS NOT NULL)),
      CONSTRAINT credit_source_builds_active_shape CHECK (
        (status = 'active') = (activated_at IS NOT NULL) AND (status <> 'active' OR phase = 'complete'))
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_source_heads (
      source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
      source_reference TEXT NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 256),
      state TEXT NOT NULL CHECK (state IN ('building','ready')),
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      environment_id TEXT CHECK(length(environment_id)=26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      billing_epoch_id TEXT CHECK(length(billing_epoch_id)=26 AND billing_epoch_id GLOB '[0-7]*' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      meter TEXT NOT NULL CHECK (length(meter) BETWEEN 1 AND 128),
      unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 64),
      event_time TEXT NOT NULL,
      latest_valuation_id TEXT CHECK(length(latest_valuation_id)=26 AND latest_valuation_id GLOB '[0-7]*' AND latest_valuation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      latest_observed_at TEXT NOT NULL,
      latest_rate_card_id TEXT NOT NULL CHECK (length(latest_rate_card_id) BETWEEN 1 AND 128),
      target_quantity INTEGER NOT NULL CHECK (target_quantity >= 0),
      target_charge_micros INTEGER NOT NULL CHECK (target_charge_micros >= 0),
      target_provider_cost_micros INTEGER CHECK (target_provider_cost_micros >= 0),
      latest_tie_ambiguous INTEGER CHECK(latest_tie_ambiguous IN(0,1)) NOT NULL DEFAULT false,
      positive_allocation_total TEXT CHECK((positive_allocation_total='0' OR (positive_allocation_total NOT GLOB '*[^0-9]*' AND substr(positive_allocation_total,1,1) GLOB '[1-9]') OR (substr(positive_allocation_total,1,1)='-' AND substr(positive_allocation_total,2,1) GLOB '[1-9]' AND substr(positive_allocation_total,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(positive_allocation_total,'-'))<=38) NOT NULL DEFAULT 0 CHECK (positive_allocation_total >= 0),
      build_generation TEXT CHECK(length(build_generation)=26 AND build_generation GLOB '[0-7]*' AND build_generation NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      custody_version INTEGER NOT NULL DEFAULT 0 CHECK (custody_version >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      PRIMARY KEY (source_kind, source_reference),
      CONSTRAINT credit_source_heads_building_generation CHECK (state = 'ready' OR build_generation IS NOT NULL)
    ) STRICT, WITHOUT ROWID;

CREATE TABLE credit_source_grant_allocations (
      source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
      source_reference TEXT NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 256),
      grant_id TEXT CHECK(length(grant_id)=26 AND grant_id GLOB '[0-7]*' AND grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      net_spent_micros TEXT CHECK((net_spent_micros='0' OR (net_spent_micros NOT GLOB '*[^0-9]*' AND substr(net_spent_micros,1,1) GLOB '[1-9]') OR (substr(net_spent_micros,1,1)='-' AND substr(net_spent_micros,2,1) GLOB '[1-9]' AND substr(net_spent_micros,2) NOT GLOB '*[^0-9]*'))) CHECK(length(ltrim(net_spent_micros,'-'))<=38) NOT NULL CHECK (net_spent_micros <> 0),
      expires_at TEXT,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (source_kind, source_reference, grant_id),
      FOREIGN KEY (source_kind, source_reference)
        REFERENCES credit_source_heads(source_kind, source_reference)
    ) STRICT, WITHOUT ROWID;
CREATE INDEX credit_source_allocations_refund_idx ON credit_source_grant_allocations
      (source_kind, source_reference, (expires_at IS NULL) DESC, expires_at DESC, granted_at DESC, grant_id DESC)
      WHERE net_spent_micros > 0;

CREATE TABLE credit_source_build_applied (
      source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
      source_reference TEXT NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 256),
      marker_kind TEXT NOT NULL CHECK (marker_kind IN ('valuation','movement')),
      marker_key TEXT NOT NULL CHECK (length(marker_key) BETWEEN 26 AND 64),
      PRIMARY KEY (source_kind, source_reference, marker_kind, marker_key),
      FOREIGN KEY (source_kind, source_reference)
        REFERENCES credit_source_builds(source_kind, source_reference)
    ) STRICT, WITHOUT ROWID;


CREATE UNIQUE INDEX credit_usage_dimensions_null_identity ON credit_usage_dimensions(organization_id,generation,project_id,event_month,coalesce(environment_id,''),rate_card_id,meter,unit);
CREATE TABLE credit_usage_dimension_sequence(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),last_value INTEGER NOT NULL CHECK(last_value>0),is_called INTEGER NOT NULL CHECK(is_called IN(0,1))) STRICT, WITHOUT ROWID;
INSERT INTO credit_usage_dimension_sequence VALUES(1,1,0);
CREATE TABLE metering_projection_cursors (
 family TEXT NOT NULL PRIMARY KEY CHECK(family IN('wallet','expiry','reporting','source')),cleanup_turn INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_turn IN(0,1)),work_after TEXT,cleanup_organization_after TEXT,cleanup_generation_after TEXT,source_kind_after TEXT,source_reference_after TEXT,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),CHECK((cleanup_organization_after IS NULL)=(cleanup_generation_after IS NULL)),CHECK((source_kind_after IS NULL)=(source_reference_after IS NULL)),CHECK(source_kind_after IS NULL OR length(source_kind_after) BETWEEN 1 AND 64),CHECK(source_reference_after IS NULL OR length(source_reference_after) BETWEEN 1 AND 256)
) STRICT, WITHOUT ROWID;
INSERT INTO metering_projection_cursors(family) VALUES('wallet'),('expiry'),('reporting'),('source');
CREATE VIEW metering_projection_reservations AS
 SELECT h.organization_id,h.hold_id AS reservation_id,h.project_id,h.environment_id,h.billing_epoch_id,h.kind,h.source_reference,h.amount_micros,h.created_at AS reserved_at FROM credit_holds h WHERE NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=h.hold_id)
 UNION ALL SELECT organization_id,reservation_id,project_id,environment_id,billing_epoch_id,kind,source_reference,amount_micros,reserved_at FROM measured_credit_reservations;
CREATE VIEW metering_projection_resolutions AS
 SELECT h.hold_id AS reservation_id,h.state AS outcome,h.charge_micros,h.funded_micros,h.provider_cost_micros,h.rate_card_id,h.meter,h.unit,h.quantity,h.event_time,h.resolved_at FROM credit_holds h WHERE h.state<>'open' AND NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=h.hold_id)
 UNION ALL SELECT reservation_id,outcome,charge_micros,funded_micros,provider_cost_micros,rate_card_id,meter,unit,quantity,event_time,resolved_at FROM measured_credit_resolutions;
-- held_micros is the retained ORIGINAL reserve allocation. It is not the wallet's current-held counter.
-- spent_micros is the original gross resolve allocation; ordinary correction-phase rows are rejected by import.
CREATE VIEW metering_projection_movements AS
 SELECT l.organization_id,l.hold_id AS reservation_id,l.grant_id,'reserve' AS phase,l.held_micros AS reserved_micros,0 AS spent_micros FROM credit_hold_lots l WHERE l.held_micros>0 AND NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=l.hold_id)
 UNION ALL SELECT l.organization_id,l.hold_id,l.grant_id,'resolve',-l.held_micros,l.spent_micros FROM credit_hold_lots l JOIN credit_holds h ON h.organization_id=l.organization_id AND h.hold_id=l.hold_id WHERE h.state<>'open' AND (l.held_micros>0 OR l.spent_micros>0) AND NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=l.hold_id)
 UNION ALL SELECT organization_id,reservation_id,grant_id,phase,reserved_micros,spent_micros FROM measured_credit_movements;
INSERT INTO credit_projection_state(organization_id) SELECT organization_id FROM organizations;
CREATE TRIGGER organizations_credit_projection_state AFTER INSERT ON organizations BEGIN INSERT INTO credit_projection_state(organization_id) VALUES(NEW.organization_id); END;
INSERT INTO credit_expiry_state(organization_id) SELECT organization_id FROM organizations;
CREATE TRIGGER organizations_credit_expiry_state AFTER INSERT ON organizations BEGIN INSERT INTO credit_expiry_state(organization_id) VALUES(NEW.organization_id); END;
INSERT INTO credit_usage_reporting_state(organization_id) SELECT organization_id FROM organizations;
CREATE TRIGGER organizations_credit_usage_reporting_state AFTER INSERT ON organizations BEGIN INSERT INTO credit_usage_reporting_state(organization_id) VALUES(NEW.organization_id); END;
CREATE TRIGGER credit_source_optional_cost_insert BEFORE INSERT ON credit_source_heads WHEN NEW.target_provider_cost_micros IS NULL AND (NEW.source_kind<>'pgcf' OR NEW.meter<>'pgcf.memory.active') BEGIN SELECT RAISE(ABORT,'Source optional provider cost is only PGCF active memory'); END;
CREATE TRIGGER credit_source_optional_cost_update BEFORE UPDATE ON credit_source_heads WHEN NEW.target_provider_cost_micros IS NULL AND (NEW.source_kind<>'pgcf' OR NEW.meter<>'pgcf.memory.active') BEGIN SELECT RAISE(ABORT,'Source optional provider cost is only PGCF active memory'); END;
