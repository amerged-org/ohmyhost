-- Original186 metadata. Resource/hint revision counters are distinct, as in PG18.
CREATE TABLE lifetime_day_hints_0391 (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
  resource_reference TEXT NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
  day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
  hint_id TEXT CHECK(length(hint_id)=26 AND hint_id GLOB '[0-7]*' AND hint_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL UNIQUE CHECK (length(hint_id) = 26),
  status TEXT NOT NULL CHECK (status IN ('pending', 'evaluated_no_charge', 'unresolved_route', 'covered')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  evaluated_revision INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0),
  evaluated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
  routed_organization_id TEXT CHECK(length(routed_organization_id)=26 AND routed_organization_id GLOB '[0-7]*' AND routed_organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  routed_project_id TEXT CHECK(length(routed_project_id)=26 AND routed_project_id GLOB '[0-7]*' AND routed_project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  routed_billing_epoch_id TEXT CHECK(length(routed_billing_epoch_id)=26 AND routed_billing_epoch_id GLOB '[0-7]*' AND routed_billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_served_at TEXT,
  last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled',
    'idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown')),
  covered_valuation_id TEXT CHECK(length(covered_valuation_id)=26 AND covered_valuation_id GLOB '[0-7]*' AND covered_valuation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') REFERENCES usage_valuations (valuation_id),
  covered_at TEXT,
  PRIMARY KEY (source_kind, resource_reference, day),
  CHECK ((routed_organization_id IS NULL) = (routed_project_id IS NULL)
    AND (routed_project_id IS NULL) = (routed_billing_epoch_id IS NULL)),
  CHECK ((status = 'pending' AND routed_organization_id IS NOT NULL AND covered_valuation_id IS NULL AND covered_at IS NULL)
    OR (status = 'covered' AND covered_valuation_id IS NOT NULL AND covered_at IS NOT NULL)
    OR (status IN ('evaluated_no_charge','unresolved_route') AND routed_organization_id IS NULL
      AND covered_valuation_id IS NULL AND covered_at IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO lifetime_day_hints_0391 SELECT * FROM lifetime_day_hints;
DROP TABLE lifetime_day_hints;
ALTER TABLE lifetime_day_hints_0391 RENAME TO lifetime_day_hints;
CREATE TABLE lifetime_resource_work (
      source_kind TEXT NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference TEXT NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      next_forward_day TEXT,
      dirty_from_day TEXT,
      dirty_through_day TEXT,
      next_due_at TEXT,
      last_served_at TEXT,
      claim_owner TEXT CHECK (claim_owner IN ('control', 'metering')),
      claim_token TEXT CHECK(length(claim_token)=26 AND claim_token GLOB '[0-7]*' AND claim_token NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      claim_epoch INTEGER CHECK (claim_epoch > 0),
      claimed_at TEXT,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled','idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown')),
      registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
      CONSTRAINT lifetime_resource_work_pkey PRIMARY KEY (source_kind, resource_reference),
      CONSTRAINT lifetime_resource_work_claim_shape CHECK ((claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL AND claimed_at IS NULL AND lease_until IS NULL) OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>claimed_at AND generation>0)),
      CONSTRAINT lifetime_resource_work_dirty_shape CHECK (
        (dirty_from_day IS NULL AND dirty_through_day IS NULL)
        OR (dirty_from_day IS NOT NULL AND dirty_through_day IS NOT NULL
          AND dirty_through_day >= dirty_from_day))
    ) STRICT, WITHOUT ROWID;
CREATE INDEX lifetime_resource_work_due_idx
      ON lifetime_resource_work (next_due_at, source_kind, resource_reference)
      WHERE next_due_at IS NOT NULL;

CREATE TABLE lifetime_resource_sources (
      source_kind TEXT NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference TEXT NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      source_id TEXT CHECK(length(source_id)=26 AND source_id GLOB '[0-7]*' AND source_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,
      operation_id TEXT CHECK(length(operation_id)=26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      cleanup_hash BLOB CHECK (cleanup_hash IS NULL OR length(cleanup_hash) = 32),
      first_at TEXT NOT NULL,
      registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
      CONSTRAINT lifetime_resource_sources_pkey
        PRIMARY KEY (source_kind, resource_reference, organization_id, source_id),
      CONSTRAINT lifetime_resource_sources_shape CHECK (
        (source_kind = 'wfp-script' AND operation_id IS NOT NULL AND cleanup_hash IS NOT NULL)
        OR (source_kind = 'custom-hostname' AND operation_id IS NULL AND cleanup_hash IS NULL
          AND source_id = project_id))
    ) STRICT, WITHOUT ROWID;
CREATE INDEX lifetime_resource_sources_project_idx
      ON lifetime_resource_sources (project_id, source_kind, resource_reference);
CREATE INDEX lifetime_resource_sources_cleanup_idx
      ON lifetime_resource_sources (organization_id, project_id, cleanup_hash, source_kind, resource_reference)
      WHERE cleanup_hash IS NOT NULL;
CREATE INDEX lifetime_resource_sources_operation_idx
      ON lifetime_resource_sources (organization_id, project_id, operation_id, source_kind, resource_reference)
      WHERE operation_id IS NOT NULL;


CREATE INDEX lifetime_day_hints_due_idx
      ON lifetime_day_hints (routed_organization_id, available_at, day, hint_id)
      WHERE status = 'pending';
CREATE INDEX lifetime_day_hints_unresolved_idx
      ON lifetime_day_hints (source_kind, resource_reference, available_at, day)
      WHERE status = 'unresolved_route';

CREATE TABLE lifetime_dirty_notices (
      notice_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL
        CHECK (target_kind IN ('candidate', 'resource', 'cleanup', 'operation', 'project', 'meter')),
      reason TEXT NOT NULL CHECK (reason IN ('candidate_receipt', 'candidate_cleanup',
        'cleanup_attempt', 'inventory', 'refresh_intent', 'domain', 'flag_period', 'billing_epoch',
        'meter_activation')),
      from_at TEXT NOT NULL,
      to_at TEXT,
      source_kind TEXT CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference TEXT,
      organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      project_id TEXT CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      operation_id TEXT CHECK(length(operation_id)=26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      candidate_receipt_id TEXT CHECK(length(candidate_receipt_id)=26 AND candidate_receipt_id GLOB '[0-7]*' AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      external_ref_hash BLOB CHECK (external_ref_hash IS NULL OR length(external_ref_hash) = 32),
      provider TEXT,
      meter TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
      next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      claim_owner TEXT CHECK (claim_owner IN ('control', 'metering')),
      claim_token TEXT CHECK(length(claim_token)=26 AND claim_token GLOB '[0-7]*' AND claim_token NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      claim_epoch INTEGER CHECK (claim_epoch > 0),
      claimed_at TEXT,
      lease_until TEXT,
      cursor_source_kind TEXT,
      cursor_resource_reference TEXT,
      processed_at TEXT,
      last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled','idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown')),
      CONSTRAINT lifetime_dirty_notices_range CHECK (to_at IS NULL OR to_at >= from_at),
      CONSTRAINT lifetime_dirty_notices_claim_shape CHECK ((claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL AND claimed_at IS NULL AND lease_until IS NULL) OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>claimed_at AND generation>0)),
      CONSTRAINT lifetime_dirty_notices_cursor_shape
        CHECK ((cursor_source_kind IS NULL) = (cursor_resource_reference IS NULL)),
      CONSTRAINT lifetime_dirty_notices_target_shape CHECK (
        (target_kind = 'candidate' AND candidate_receipt_id IS NOT NULL
          AND organization_id IS NOT NULL AND project_id IS NOT NULL
          AND reason IN ('candidate_receipt', 'candidate_cleanup'))
        OR (target_kind = 'resource' AND source_kind IS NOT NULL AND resource_reference IS NOT NULL
          AND (organization_id IS NULL) = (project_id IS NULL) AND reason = 'domain')
        OR (target_kind = 'cleanup' AND organization_id IS NOT NULL AND project_id IS NOT NULL
          AND operation_id IS NOT NULL AND external_ref_hash IS NOT NULL AND provider IS NOT NULL
          AND reason IN ('cleanup_attempt', 'inventory'))
        OR (target_kind = 'operation' AND organization_id IS NOT NULL AND project_id IS NOT NULL
          AND operation_id IS NOT NULL AND reason = 'refresh_intent')
        OR (target_kind = 'project' AND project_id IS NOT NULL
          AND reason IN ('flag_period', 'billing_epoch'))
        OR (target_kind = 'meter' AND meter IS NOT NULL AND reason = 'meter_activation'))
    ) STRICT;
CREATE INDEX lifetime_dirty_notices_due_idx
      ON lifetime_dirty_notices (next_attempt_at, notice_id) WHERE processed_at IS NULL;

CREATE TABLE lifetime_discovery_bootstrap (
      job TEXT PRIMARY KEY CHECK (job IN ('candidate-receipts', 'paid-domains')),
      cursor_candidate_receipt_id TEXT CHECK(length(cursor_candidate_receipt_id)=26 AND cursor_candidate_receipt_id GLOB '[0-7]*' AND cursor_candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      cursor_organization_id TEXT CHECK(length(cursor_organization_id)=26 AND cursor_organization_id GLOB '[0-7]*' AND cursor_organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      cursor_project_id TEXT CHECK(length(cursor_project_id)=26 AND cursor_project_id GLOB '[0-7]*' AND cursor_project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned >= 0),
      last_served_at TEXT,
      completed_at TEXT,
      CONSTRAINT lifetime_discovery_bootstrap_cursor_shape CHECK (
        (job = 'candidate-receipts' AND cursor_organization_id IS NULL AND cursor_project_id IS NULL)
        OR (job = 'paid-domains' AND cursor_candidate_receipt_id IS NULL
          AND (cursor_organization_id IS NULL) = (cursor_project_id IS NULL)))
    ) STRICT, WITHOUT ROWID;
INSERT INTO lifetime_discovery_bootstrap(job) VALUES ('candidate-receipts'), ('paid-domains');

CREATE TRIGGER lifetime_resource_work_guard BEFORE UPDATE ON lifetime_resource_work WHEN NEW.source_kind IS NOT OLD.source_kind OR NEW.resource_reference IS NOT OLD.resource_reference OR NEW.registered_at IS NOT OLD.registered_at BEGIN SELECT RAISE(ABORT,'Lifetime metadata identity is immutable and completion terminal'); END;

CREATE TRIGGER lifetime_resource_sources_guard BEFORE UPDATE ON lifetime_resource_sources WHEN NEW.source_kind IS NOT OLD.source_kind OR NEW.resource_reference IS NOT OLD.resource_reference OR NEW.organization_id IS NOT OLD.organization_id OR NEW.source_id IS NOT OLD.source_id OR NEW.project_id IS NOT OLD.project_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.cleanup_hash IS NOT OLD.cleanup_hash OR NEW.registered_at IS NOT OLD.registered_at BEGIN SELECT RAISE(ABORT,'Lifetime metadata identity is immutable and completion terminal'); END;

CREATE TRIGGER lifetime_dirty_notices_guard BEFORE UPDATE ON lifetime_dirty_notices WHEN OLD.processed_at IS NOT NULL OR NEW.notice_id IS NOT OLD.notice_id OR NEW.target_kind IS NOT OLD.target_kind OR NEW.reason IS NOT OLD.reason OR NEW.from_at IS NOT OLD.from_at OR NEW.to_at IS NOT OLD.to_at OR NEW.source_kind IS NOT OLD.source_kind OR NEW.resource_reference IS NOT OLD.resource_reference OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.candidate_receipt_id IS NOT OLD.candidate_receipt_id OR NEW.external_ref_hash IS NOT OLD.external_ref_hash OR NEW.provider IS NOT OLD.provider OR NEW.meter IS NOT OLD.meter OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'Lifetime metadata identity is immutable and completion terminal'); END;

CREATE TRIGGER lifetime_discovery_bootstrap_guard BEFORE UPDATE ON lifetime_discovery_bootstrap WHEN OLD.completed_at IS NOT NULL OR NEW.job IS NOT OLD.job BEGIN SELECT RAISE(ABORT,'Lifetime metadata identity is immutable and completion terminal'); END;
CREATE TRIGGER lifetime_day_hints_identity BEFORE UPDATE ON lifetime_day_hints
WHEN NEW.source_kind IS NOT OLD.source_kind OR NEW.resource_reference IS NOT OLD.resource_reference OR NEW.day IS NOT OLD.day OR NEW.hint_id IS NOT OLD.hint_id
OR (OLD.status='covered' AND (NEW.status IS NOT OLD.status OR NEW.covered_valuation_id IS NOT OLD.covered_valuation_id OR NEW.covered_at IS NOT OLD.covered_at))
BEGIN SELECT RAISE(ABORT,'Lifetime hint identity and covered receipt are immutable'); END;
CREATE INDEX IF NOT EXISTS paid_project_domains_hostname_idx ON paid_project_domains(hostname) WHERE custom_hostname_receipt IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_epochs_project_started_idx ON billing_epochs(project_id,started_at);
CREATE INDEX IF NOT EXISTS product_command_intents_operation_idx ON product_command_intents(organization_id,project_id,operation_id);
CREATE TRIGGER wfp_candidate_receipts_lifetime_notice AFTER INSERT ON wfp_candidate_receipts BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,candidate_receipt_id,organization_id,project_id,operation_id) VALUES('candidate','candidate_receipt',NEW.staged_at,NEW.candidate_receipt_id,NEW.organization_id,NEW.project_id,NEW.operation_id); END;
CREATE TRIGGER wfp_candidate_cleanup_receipts_lifetime_notice AFTER INSERT ON wfp_candidate_cleanup_receipts BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,candidate_receipt_id,organization_id,project_id) VALUES('candidate','candidate_cleanup',NEW.observed_at,NEW.candidate_receipt_id,NEW.organization_id,NEW.project_id); END;
CREATE TRIGGER run_cleanup_attempts_lifetime_notice AFTER INSERT ON run_cleanup_attempts WHEN NEW.resource_kind='wfp-script' AND NEW.outcome IN ('removed','not_found') BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,organization_id,project_id,operation_id,external_ref_hash,provider) VALUES('cleanup','cleanup_attempt',NEW.attempted_at,NEW.organization_id,NEW.project_id,NEW.operation_id,NEW.external_ref_hash,NEW.provider); END;
CREATE TRIGGER run_resource_inventory_lifetime_notice AFTER INSERT ON run_resource_inventory WHEN NEW.provider='cloudflare' AND NEW.resource_kind='wfp-script' BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,organization_id,project_id,operation_id,external_ref_hash,provider) VALUES('cleanup','inventory',NEW.recorded_at,NEW.organization_id,NEW.project_id,NEW.operation_id,NEW.external_ref_hash,NEW.provider); END;
CREATE TRIGGER product_command_intents_lifetime_notice AFTER INSERT ON product_command_intents WHEN NEW.binding_refresh_snapshot IS NOT NULL BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,organization_id,project_id,operation_id) VALUES('operation','refresh_intent',NEW.created_at,NEW.organization_id,NEW.project_id,NEW.operation_id); END;
CREATE TRIGGER paid_project_domains_lifetime_notice AFTER INSERT ON paid_project_domains WHEN NEW.custom_hostname_receipt IS NOT NULL BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,source_kind,resource_reference,organization_id,project_id) VALUES('resource','domain',coalesce(NEW.provisioning_started_at,NEW.created_at),'custom-hostname',NEW.hostname,NEW.organization_id,NEW.project_id); END;
CREATE TRIGGER project_powered_by_flag_periods_lifetime_notice AFTER INSERT ON project_powered_by_flag_periods BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,to_at,project_id,organization_id) VALUES('project','flag_period',NEW.enabled_at,NEW.disabled_at,NEW.project_id,NEW.organization_id); END;
CREATE TRIGGER billing_epochs_lifetime_notice AFTER INSERT ON billing_epochs BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,to_at,project_id) VALUES('project','billing_epoch',NEW.started_at,NEW.ended_at,NEW.project_id); END;
CREATE TRIGGER usage_meter_activations_lifetime_notice AFTER INSERT ON usage_meter_activations WHEN NEW.meter IN ('wfp.script','domain.custom_hostname') BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,meter) VALUES('meter','meter_activation',NEW.starts_at,NEW.meter); END;
CREATE TRIGGER paid_project_domains_lifetime_notice_update AFTER UPDATE ON paid_project_domains
WHEN (OLD.custom_hostname_receipt IS NOT NULL OR NEW.custom_hostname_receipt IS NOT NULL)
AND (OLD.hostname IS NOT NEW.hostname OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.custom_hostname_receipt IS NULL) IS NOT (NEW.custom_hostname_receipt IS NULL) OR OLD.provisioning_started_at IS NOT NEW.provisioning_started_at OR OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,source_kind,resource_reference,organization_id,project_id)
 SELECT 'resource','domain',coalesce((SELECT min(v) FROM (SELECT CASE WHEN OLD.hostname IS NOT NEW.hostname OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.custom_hostname_receipt IS NULL) IS NOT (NEW.custom_hostname_receipt IS NULL) THEN coalesce(NEW.provisioning_started_at,NEW.created_at) END AS v UNION ALL SELECT CASE WHEN OLD.provisioning_started_at IS NOT NEW.provisioning_started_at THEN min(coalesce(OLD.provisioning_started_at,OLD.created_at),coalesce(NEW.provisioning_started_at,NEW.created_at)) END AS v UNION ALL SELECT CASE WHEN OLD.deleted_at IS NOT NEW.deleted_at THEN (SELECT min(v) FROM (SELECT OLD.deleted_at AS v UNION ALL SELECT NEW.deleted_at AS v)) END AS v)),coalesce(NEW.provisioning_started_at,NEW.created_at)),'custom-hostname',NEW.hostname,NEW.organization_id,NEW.project_id WHERE NEW.custom_hostname_receipt IS NOT NULL;
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,source_kind,resource_reference,organization_id,project_id)
 SELECT 'resource','domain',coalesce(OLD.provisioning_started_at,OLD.created_at),'custom-hostname',OLD.hostname,OLD.organization_id,OLD.project_id WHERE OLD.custom_hostname_receipt IS NOT NULL AND (OLD.hostname IS NOT NEW.hostname OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.custom_hostname_receipt IS NULL) IS NOT (NEW.custom_hostname_receipt IS NULL));
END;
CREATE TRIGGER project_powered_by_flag_periods_lifetime_notice_update AFTER UPDATE ON project_powered_by_flag_periods WHEN OLD.disabled_at IS NOT NEW.disabled_at BEGIN
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,project_id,organization_id) VALUES('project','flag_period',NEW.disabled_at,NEW.project_id,NEW.organization_id); END;
CREATE TRIGGER billing_epochs_lifetime_notice_update AFTER UPDATE ON billing_epochs
WHEN OLD.ended_at IS NOT NEW.ended_at OR OLD.started_at IS NOT NEW.started_at OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id
BEGIN
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,project_id)
 SELECT 'project','billing_epoch',min(OLD.started_at,NEW.started_at),NEW.project_id WHERE OLD.started_at IS NOT NEW.started_at OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id;
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,project_id)
 SELECT 'project','billing_epoch',min(OLD.started_at,NEW.started_at),OLD.project_id WHERE OLD.project_id IS NOT NEW.project_id;
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,project_id)
 SELECT 'project','billing_epoch',(SELECT min(v) FROM (SELECT OLD.ended_at AS v UNION ALL SELECT NEW.ended_at AS v)),NEW.project_id WHERE OLD.started_at IS NEW.started_at AND OLD.organization_id IS NEW.organization_id AND OLD.project_id IS NEW.project_id;
END;
