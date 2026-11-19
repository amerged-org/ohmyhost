export function up(pgm) {
  pgm.sql(`CREATE TABLE wfp_usage_batches (
    dispatch_namespace text NOT NULL,
    batch_sha256 bytea NOT NULL CHECK(octet_length(batch_sha256)=32),
    object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
    event_count integer NOT NULL CHECK(event_count BETWEEN 0 AND 5000),
    observed_at timestamptz NOT NULL,
    PRIMARY KEY(dispatch_namespace,batch_sha256)
  );
  CREATE TABLE wfp_usage_events (
    dispatch_namespace text NOT NULL CHECK(dispatch_namespace ~ '^[a-z0-9-]{1,64}$'),
    event_sha256 bytea NOT NULL CHECK(octet_length(event_sha256)=32),
    script_name text NOT NULL CHECK(script_name ~ '^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'),
    script_version_id uuid,
    entrypoint text CHECK(length(entrypoint)<=128),
    event_type text NOT NULL CHECK(event_type IN ('fetch','scheduled','alarm','queue','email','worker_rpc','hibernatable_web_socket')),
    outcome text NOT NULL CHECK(length(outcome) BETWEEN 1 AND 64),
    occurred_at timestamptz NOT NULL,
    cpu_ms bigint NOT NULL CHECK(cpu_ms>=0),
    wall_ms bigint NOT NULL CHECK(wall_ms>=0),
    first_batch_sha256 bytea NOT NULL,
    PRIMARY KEY(dispatch_namespace,event_sha256),
    FOREIGN KEY(dispatch_namespace,first_batch_sha256) REFERENCES wfp_usage_batches(dispatch_namespace,batch_sha256)
  );
  CREATE INDEX wfp_usage_events_time ON wfp_usage_events(occurred_at);
  CREATE TRIGGER wfp_usage_batches_append_only BEFORE UPDATE OR DELETE ON wfp_usage_batches
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE TRIGGER wfp_usage_events_append_only BEFORE UPDATE OR DELETE ON wfp_usage_events
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE VIEW attributed_wfp_usage WITH (security_invoker=true) AS
    SELECT usage.*,candidate.project_id,candidate.environment_id,candidate.product_deployment_id,
      epoch.organization_id,epoch.billing_epoch_id
    FROM wfp_usage_events usage
    LEFT JOIN wfp_candidate_receipts candidate
      ON candidate.dispatch_namespace=usage.dispatch_namespace AND candidate.immutable_script_name=usage.script_name
      AND candidate.staged_at<=usage.occurred_at
      AND NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts other
        WHERE other.dispatch_namespace=candidate.dispatch_namespace AND other.immutable_script_name=candidate.immutable_script_name
          AND other.candidate_receipt_id<>candidate.candidate_receipt_id)
    LEFT JOIN billing_epochs epoch ON epoch.project_id=candidate.project_id
      AND epoch.started_at<=usage.occurred_at AND (epoch.ended_at IS NULL OR epoch.ended_at>usage.occurred_at)
      AND NOT EXISTS(SELECT 1 FROM billing_epochs other WHERE other.project_id=epoch.project_id
        AND other.billing_epoch_id<>epoch.billing_epoch_id AND other.started_at<=usage.occurred_at
        AND (other.ended_at IS NULL OR other.ended_at>usage.occurred_at));`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM wfp_usage_batches) THEN
    RAISE EXCEPTION 'WFP usage must be retained before downgrade'; END IF; END $$;`);
  pgm.dropView("attributed_wfp_usage");
  pgm.dropTable("wfp_usage_events");
  pgm.dropTable("wfp_usage_batches");
}
