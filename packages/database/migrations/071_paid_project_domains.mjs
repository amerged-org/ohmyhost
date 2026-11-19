export function up(pgm) {
  pgm.sql(`CREATE TABLE paid_project_domains (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    hostname text NOT NULL UNIQUE,
    gateway_script_name text NOT NULL,
    state text NOT NULL,
    configured_by_principal_id text NOT NULL,
    apply_idempotency_sha256 bytea NOT NULL,
    apply_request_sha256 bytea NOT NULL,
    custom_hostname_receipt jsonb,
    worker_route_receipt jsonb,
    delete_idempotency_sha256 bytea,
    delete_request_sha256 bytea,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    PRIMARY KEY (organization_id, project_id),
    FOREIGN KEY (organization_id, project_id)
      REFERENCES project_ownerships (organization_id, project_id),
    CHECK (hostname=lower(hostname) AND length(hostname)<=253
      AND hostname~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      AND hostname!~'\\.poc\\.aixyte\\.com$'),
    CHECK (gateway_script_name~'^[a-z]+-[a-z]+-[a-z]+$'),
    CHECK (state IN ('pending','active','deleting','deleted')),
    CHECK (octet_length(apply_idempotency_sha256)=32 AND octet_length(apply_request_sha256)=32),
    CHECK ((state='pending' AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
        AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL
        AND deleted_at IS NULL)
      OR (state='active' AND jsonb_typeof(custom_hostname_receipt)='object'
        AND jsonb_typeof(worker_route_receipt)='object' AND deleted_at IS NULL)
      OR (state='deleting' AND jsonb_typeof(custom_hostname_receipt)='object'
        AND jsonb_typeof(worker_route_receipt)='object'
        AND octet_length(delete_idempotency_sha256)=32
        AND octet_length(delete_request_sha256)=32 AND deleted_at IS NULL)
      OR (state='deleted' AND jsonb_typeof(custom_hostname_receipt)='object'
        AND jsonb_typeof(worker_route_receipt)='object'
        AND octet_length(delete_idempotency_sha256)=32
        AND octet_length(delete_request_sha256)=32 AND deleted_at IS NOT NULL)),
    CHECK (updated_at>=created_at AND (deleted_at IS NULL OR deleted_at>=created_at))
  )`);
}

export function down(pgm) {
  pgm.dropTable("paid_project_domains");
}
