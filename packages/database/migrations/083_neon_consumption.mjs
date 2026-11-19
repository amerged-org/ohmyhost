export function up(pgm) {
  pgm.sql(`CREATE TABLE neon_consumption_observations (
    provider_organization_id text NOT NULL CHECK (provider_organization_id ~ '^org-[a-z0-9-]{1,56}$'),
    provider_project_id text NOT NULL CHECK (provider_project_id ~ '^[a-z0-9-]{1,60}$'),
    period_id uuid NOT NULL,
    period_plan text NOT NULL CHECK (period_plan ~ '^[a-z][a-z0-9_-]{0,63}$'),
    period_start timestamptz NOT NULL,
    timeframe_start timestamptz NOT NULL,
    timeframe_end timestamptz NOT NULL,
    metric text NOT NULL CHECK (metric IN ('compute_unit_seconds','root_branch_bytes_month','child_branch_bytes_month','instant_restore_bytes_month','snapshot_storage_bytes_month','public_network_transfer_bytes','private_network_transfer_bytes','extra_branches_month')),
    unit text NOT NULL CHECK (unit IN ('cu_second','byte_month','byte','branch_hour')),
    quantity bigint NOT NULL CHECK (quantity>=0),
    list_cost_micros bigint CHECK (list_cost_micros>=0),
    cost_basis_version text NOT NULL,
    scope text NOT NULL CHECK (scope IN ('platform','project_shared','unattributed')),
    organization_id ulid REFERENCES workos_organization_mappings(organization_id),
    project_id ulid REFERENCES projects(project_id),
    billing_epoch_id ulid,
    environment_ids ulid[] NOT NULL,
    observed_at timestamptz NOT NULL,
    PRIMARY KEY(provider_organization_id,provider_project_id,period_id,timeframe_start,metric,observed_at),
    FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    CHECK (timeframe_end=timeframe_start+interval '1 hour' AND period_start<timeframe_end AND observed_at>=timeframe_end),
    CHECK ((scope='project_shared' AND organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL AND cardinality(environment_ids)=2)
      OR (scope='platform' AND organization_id IS NULL AND project_id IS NULL AND billing_epoch_id IS NULL AND cardinality(environment_ids)=0)
      OR (scope='unattributed' AND organization_id IS NULL AND billing_epoch_id IS NULL AND cardinality(environment_ids)=0))
  );
  CREATE TRIGGER neon_consumption_append_only BEFORE UPDATE OR DELETE ON neon_consumption_observations
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE VIEW latest_neon_consumption WITH (security_invoker=true) AS
    SELECT DISTINCT ON (provider_organization_id,provider_project_id,period_id,timeframe_start,metric) *
    FROM neon_consumption_observations
    ORDER BY provider_organization_id,provider_project_id,period_id,timeframe_start,metric,observed_at DESC;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM neon_consumption_observations) THEN
    RAISE EXCEPTION 'Neon usage observations must be retained before downgrade'; END IF; END $$;`);
  pgm.dropView("latest_neon_consumption");
  pgm.dropTable("neon_consumption_observations");
}
