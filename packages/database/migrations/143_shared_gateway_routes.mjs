/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE shared_gateway_route_revisions (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      revision bigint NOT NULL CHECK (revision>0),
      predecessor_revision bigint,
      operation_id ulid NOT NULL,
      candidate_receipt_id ulid NOT NULL,
      action text NOT NULL CHECK (action IN ('activate','remove','compensate')),
      active boolean NOT NULL,
      handle text NOT NULL,
      public_origin text NOT NULL CHECK (public_origin ~ '^https://[a-z0-9.-]+$'),
      egress_allowed_origins jsonb NOT NULL CHECK (jsonb_typeof(egress_allowed_origins)='array' AND jsonb_array_length(egress_allowed_origins)<=16),
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id,project_id,environment_id,revision),
      UNIQUE (organization_id,project_id,environment_id,operation_id,action),
      FOREIGN KEY (organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
      FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
      FOREIGN KEY (organization_id,project_id,candidate_receipt_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id),
      FOREIGN KEY (organization_id,project_id,environment_id,predecessor_revision) REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision),
      CHECK (predecessor_revision IS NULL OR predecessor_revision<revision),
      CHECK ((revision=1)=(predecessor_revision IS NULL)),
      CHECK (action<>'remove' OR active=false)
    );
    CREATE INDEX shared_gateway_routes_origin_idx ON shared_gateway_route_revisions(public_origin);
    CREATE TRIGGER shared_gateway_route_revisions_append_only
      BEFORE UPDATE OR DELETE ON shared_gateway_route_revisions
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $grant$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT,INSERT ON shared_gateway_route_revisions TO control_runtime;
      END IF;
    END $grant$;
  `);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.dropTable("shared_gateway_route_revisions");
}
