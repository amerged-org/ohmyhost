-- Original 084/184 WFP raw evidence and nonfinancial discovery, on the same Core.
CREATE TABLE wfp_usage_batches (
 dispatch_namespace TEXT NOT NULL,
 batch_sha256 BLOB NOT NULL CHECK(length(batch_sha256)=32),
 object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 event_count INTEGER NOT NULL CHECK(event_count BETWEEN 0 AND 5000),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(dispatch_namespace,batch_sha256)
) STRICT, WITHOUT ROWID;
CREATE TABLE wfp_usage_events (
 dispatch_namespace TEXT NOT NULL CHECK(length(dispatch_namespace) BETWEEN 1 AND 64 AND dispatch_namespace NOT GLOB '*[^a-z0-9-]*'),
 event_sha256 BLOB NOT NULL CHECK(length(event_sha256)=32),
 script_name TEXT NOT NULL CHECK(substr(script_name,1,2)='p-' AND substr(script_name,3,26) NOT GLOB '*[^0-9a-z]*' AND ((length(script_name)=59 AND substr(script_name,29,5)='-dev-') OR (length(script_name)=60 AND substr(script_name,29,6)='-prod-')) AND substr(script_name,-26) NOT GLOB '*[^0-9a-z]*'),
 script_version_id TEXT CHECK(script_version_id IS NULL OR length(script_version_id)=36),
 entrypoint TEXT CHECK(length(entrypoint)<=128),
 event_type TEXT NOT NULL CHECK(event_type IN ('fetch','scheduled','alarm','queue','email','worker_rpc','hibernatable_web_socket')),
 outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 64),
 occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
 cpu_ms INTEGER NOT NULL CHECK(cpu_ms>=0),
 wall_ms INTEGER NOT NULL CHECK(wall_ms>=0),
 first_batch_sha256 BLOB NOT NULL,
 PRIMARY KEY(dispatch_namespace,event_sha256),
 FOREIGN KEY(dispatch_namespace,first_batch_sha256) REFERENCES wfp_usage_batches(dispatch_namespace,batch_sha256)
) STRICT, WITHOUT ROWID;
CREATE INDEX wfp_usage_events_time ON wfp_usage_events(occurred_at);
CREATE INDEX wfp_usage_events_first_batch_idx ON wfp_usage_events(dispatch_namespace,first_batch_sha256);
CREATE TRIGGER wfp_usage_batches_append_only_update BEFORE UPDATE ON wfp_usage_batches BEGIN SELECT RAISE(ABORT,'WFP usage batches are append only'); END;
CREATE TRIGGER wfp_usage_batches_append_only_delete BEFORE DELETE ON wfp_usage_batches BEGIN SELECT RAISE(ABORT,'WFP usage batches are append only'); END;
CREATE TRIGGER wfp_usage_events_append_only_update BEFORE UPDATE ON wfp_usage_events BEGIN SELECT RAISE(ABORT,'WFP usage events are append only'); END;
CREATE TRIGGER wfp_usage_events_append_only_delete BEFORE DELETE ON wfp_usage_events BEGIN SELECT RAISE(ABORT,'WFP usage events are append only'); END;
CREATE VIEW attributed_wfp_usage AS SELECT usage.*,candidate.project_id,candidate.environment_id,candidate.product_deployment_id,
 epoch.organization_id,epoch.billing_epoch_id FROM wfp_usage_events usage
 LEFT JOIN wfp_candidate_receipts candidate ON candidate.dispatch_namespace=usage.dispatch_namespace AND candidate.immutable_script_name=usage.script_name
 AND candidate.staged_at<=usage.occurred_at AND NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts other
 WHERE other.dispatch_namespace=candidate.dispatch_namespace AND other.immutable_script_name=candidate.immutable_script_name AND other.candidate_receipt_id<>candidate.candidate_receipt_id)
 LEFT JOIN billing_epochs epoch ON epoch.project_id=candidate.project_id AND epoch.started_at<=usage.occurred_at
 AND (epoch.ended_at IS NULL OR epoch.ended_at>usage.occurred_at) AND NOT EXISTS(SELECT 1 FROM billing_epochs other
 WHERE other.project_id=epoch.project_id AND other.billing_epoch_id<>epoch.billing_epoch_id AND other.started_at<=usage.occurred_at AND (other.ended_at IS NULL OR other.ended_at>usage.occurred_at));
CREATE TABLE wfp_batch_discovery (
 dispatch_namespace TEXT NOT NULL, batch_sha256 BLOB NOT NULL,
 discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 last_served_at TEXT, claim_owner TEXT CHECK(claim_owner IN ('control','metering')), claim_token TEXT,
 claim_epoch INTEGER CHECK(claim_epoch>0), claimed_at TEXT, lease_until TEXT,
 last_failure_stage TEXT CHECK(last_failure_stage IN ('discovery','classification')),
 last_failure_code TEXT CHECK(last_failure_code IN ('lock_not_available','statement_canceled','idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','invalid_measurement','measurement_conflict','attribution_unresolved','rate_unresolved','unknown')),
 completed_at TEXT, plan_version INTEGER CHECK(plan_version=1), plan_frozen_at TEXT, plan_business_as_of TEXT,
 plan_root BLOB CHECK(length(plan_root)=32), plan_owned_events INTEGER CHECK(plan_owned_events BETWEEN 0 AND 5000),
 plan_excluded_events INTEGER CHECK(plan_excluded_events BETWEEN 0 AND 5000), plan_cohort_count INTEGER CHECK(plan_cohort_count BETWEEN 0 AND 10000),
 plan_covered_count INTEGER NOT NULL DEFAULT 0 CHECK(plan_covered_count>=0),
 PRIMARY KEY(dispatch_namespace,batch_sha256), FOREIGN KEY(dispatch_namespace,batch_sha256) REFERENCES wfp_usage_batches(dispatch_namespace,batch_sha256),
 CHECK((claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL AND claimed_at IS NULL AND lease_until IS NULL)
 OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL AND claimed_at IS NOT NULL AND lease_until>claimed_at AND generation>0 AND completed_at IS NULL)),
 CHECK((last_failure_stage IS NULL)=(last_failure_code IS NULL)),
 CHECK((plan_version IS NULL AND plan_frozen_at IS NULL AND plan_business_as_of IS NULL AND plan_root IS NULL AND plan_owned_events IS NULL AND plan_excluded_events IS NULL AND plan_cohort_count IS NULL AND plan_covered_count=0)
 OR (plan_version IS NOT NULL AND plan_frozen_at IS NOT NULL AND plan_business_as_of IS NOT NULL AND plan_root IS NOT NULL AND plan_owned_events IS NOT NULL AND plan_excluded_events IS NOT NULL AND plan_cohort_count IS NOT NULL AND plan_excluded_events<=plan_owned_events AND plan_cohort_count<=2*plan_owned_events AND plan_covered_count<=plan_cohort_count)),
 CHECK(completed_at IS NULL OR (plan_frozen_at IS NOT NULL AND plan_covered_count=plan_cohort_count))
) STRICT, WITHOUT ROWID;
CREATE INDEX wfp_batch_discovery_due_idx ON wfp_batch_discovery(next_attempt_at,dispatch_namespace,batch_sha256) WHERE completed_at IS NULL;
CREATE TABLE wfp_discovery_cohort_plan (
 dispatch_namespace TEXT NOT NULL,batch_sha256 BLOB NOT NULL,source_reference TEXT NOT NULL CHECK(length(source_reference)=64 AND source_reference NOT GLOB '*[^0-9a-f]*'),
 organization_id TEXT CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') NOT NULL,project_id TEXT NOT NULL,environment_id TEXT,billing_epoch_id TEXT NOT NULL,
 meter TEXT NOT NULL CHECK(length(meter) BETWEEN 1 AND 128),unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
 quantity INTEGER NOT NULL CHECK(quantity>0),event_time TEXT NOT NULL,observed_at TEXT NOT NULL,rate_card_id TEXT NOT NULL CHECK(length(rate_card_id) BETWEEN 1 AND 128),
 PRIMARY KEY(dispatch_namespace,batch_sha256,source_reference),FOREIGN KEY(dispatch_namespace,batch_sha256) REFERENCES wfp_batch_discovery(dispatch_namespace,batch_sha256),CHECK(event_time<=observed_at)
) STRICT, WITHOUT ROWID;
CREATE TABLE metering_discovery_backfills (
 backfill_name TEXT NOT NULL PRIMARY KEY CHECK(backfill_name='wfp-batches'),cursor_dispatch_namespace TEXT,cursor_batch_sha256 BLOB CHECK(length(cursor_batch_sha256)=32),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),scanned_batches INTEGER NOT NULL DEFAULT 0 CHECK(scanned_batches>=0),last_served_at TEXT,completed_at TEXT,
 CHECK((cursor_dispatch_namespace IS NULL)=(cursor_batch_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO metering_discovery_backfills(backfill_name) VALUES('wfp-batches');
CREATE TRIGGER wfp_batch_discovery_guard BEFORE UPDATE ON wfp_batch_discovery WHEN OLD.completed_at IS NOT NULL OR NEW.dispatch_namespace IS NOT OLD.dispatch_namespace OR NEW.batch_sha256 IS NOT OLD.batch_sha256 OR NEW.discovered_at IS NOT OLD.discovered_at
 OR (OLD.plan_frozen_at IS NOT NULL AND (NEW.plan_version IS NOT OLD.plan_version OR NEW.plan_frozen_at IS NOT OLD.plan_frozen_at OR NEW.plan_business_as_of IS NOT OLD.plan_business_as_of OR NEW.plan_root IS NOT OLD.plan_root OR NEW.plan_owned_events IS NOT OLD.plan_owned_events OR NEW.plan_excluded_events IS NOT OLD.plan_excluded_events OR NEW.plan_cohort_count IS NOT OLD.plan_cohort_count))
 OR NEW.plan_covered_count<OLD.plan_covered_count OR NEW.plan_covered_count-OLD.plan_covered_count>256 OR (OLD.plan_frozen_at IS NULL AND NEW.plan_covered_count<>0)
 BEGIN SELECT RAISE(ABORT,'WFP discovery identity, frozen plan and completion are immutable'); END;
CREATE TRIGGER wfp_discovery_cohort_plan_immutable BEFORE UPDATE ON wfp_discovery_cohort_plan BEGIN SELECT RAISE(ABORT,'WFP discovery cohort plan rows are immutable'); END;
CREATE TRIGGER metering_discovery_backfills_guard BEFORE UPDATE ON metering_discovery_backfills WHEN OLD.completed_at IS NOT NULL OR NEW.backfill_name IS NOT OLD.backfill_name BEGIN SELECT RAISE(ABORT,'Discovery bootstrap identity is immutable and completion terminal'); END;
CREATE TRIGGER wfp_usage_batches_discovery AFTER INSERT ON wfp_usage_batches BEGIN INSERT INTO wfp_batch_discovery(dispatch_namespace,batch_sha256) VALUES(NEW.dispatch_namespace,NEW.batch_sha256) ON CONFLICT DO NOTHING; END;
