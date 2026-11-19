export function up(pgm) {
  pgm.createTable("principal_mappings", {
    provider: { type: "text", notNull: true },
    provider_principal_id: { type: "text", notNull: true },
    principal_id: { type: "text", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    first_observed_at: { type: "timestamptz", notNull: true },
    last_observed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("principal_mappings", "principal_mappings_pkey", {
    primaryKey: ["provider", "provider_principal_id", "organization_id"],
  });
  pgm.addConstraint("principal_mappings", "principal_mappings_provider_check", {
    check: "provider = 'workos'",
  });

  pgm.createTable("api_key_metadata", {
    api_key_id: { type: "ulid", primaryKey: true },
    created_by_principal_id: { type: "text", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    key_digest: { type: "bytea", notNull: true, unique: true },
    key_prefix: { type: "text", notNull: true },
    pepper_version: { type: "integer", notNull: true },
    scopes: { type: "text[]", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz" },
    revoked_at: { type: "timestamptz" },
    last_used_at: { type: "timestamptz" },
  });
  pgm.addConstraint("api_key_metadata", "api_key_metadata_check", {
    check:
      "octet_length(key_digest)=32 AND pepper_version>0 AND cardinality(scopes)>0 AND scopes <@ ARRAY['projects:read','projects:write','operations:read','audit:read']::text[] AND (expires_at IS NULL OR expires_at>created_at) AND (revoked_at IS NULL OR revoked_at>=created_at)",
  });

  pgm.createTable("workos_organization_mappings", {
    organization_id: { type: "ulid", primaryKey: true },
    workos_organization_id: { type: "text", notNull: true, unique: true },
    state: { type: "text", notNull: true },
    mapping_revision: { type: "integer", notNull: true },
    snapshot_sha256: { type: "bytea", notNull: true },
    snapshot_fetched_at: { type: "timestamptz", notNull: true },
    synchronized_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("workos_organization_mappings", "workos_organization_mappings_check", {
    check:
      "state IN ('active','suspended','deleted') AND mapping_revision>0 AND octet_length(snapshot_sha256)=32",
  });
  pgm.sql(
    `CREATE FUNCTION guard_terminal_workos_organization_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state='deleted' AND NEW.state<>'deleted' THEN RAISE EXCEPTION 'deleted WorkOS organization mappings are terminal' USING ERRCODE='23514', CONSTRAINT='workos_organization_mappings_deleted_terminal'; END IF; RETURN NEW; END; $$; CREATE TRIGGER workos_organization_mappings_deleted_terminal BEFORE UPDATE OF state ON workos_organization_mappings FOR EACH ROW EXECUTE FUNCTION guard_terminal_workos_organization_mapping();`,
  );
  pgm.createTable("organization_audit_events", {
    organization_id: { type: "ulid", notNull: true },
    audit_event_id: { type: "ulid", primaryKey: true },
    event_type: { type: "text", notNull: true },
    actor_type: { type: "text", notNull: true },
    actor_id: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("organization_audit_events", "organization_audit_events_identity_check", {
    check:
      "event_type=btrim(event_type) AND length(event_type) BETWEEN 1 AND 128 AND actor_type=btrim(actor_type) AND length(actor_type) BETWEEN 1 AND 64 AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 256",
  });
  pgm.createIndex("organization_audit_events", [
    "organization_id",
    "occurred_at",
    "audit_event_id",
  ]);
  pgm.createTrigger("organization_audit_events", "organization_audit_events_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
  pgm.createTable("organization_memberships", {
    organization_id: { type: "ulid", notNull: true },
    workos_user_id: { type: "text", notNull: true },
    role: { type: "text", notNull: true },
    state: { type: "text", notNull: true },
    mapping_revision: { type: "integer", notNull: true },
    snapshot_sha256: { type: "bytea", notNull: true },
    effective_at: { type: "timestamptz", notNull: true },
    revoked_at: { type: "timestamptz" },
    trigger_event_id: { type: "text", notNull: true },
  });
  pgm.addConstraint("organization_memberships", "organization_memberships_pkey", {
    primaryKey: ["organization_id", "workos_user_id"],
  });
  pgm.addConstraint("organization_memberships", "organization_memberships_check", {
    check:
      "state IN ('active','suspended','revoked') AND mapping_revision>0 AND octet_length(snapshot_sha256)=32",
  });
  pgm.createTable("m2m_organization_bindings", {
    connect_client_id: { type: "text", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    scopes: { type: "text[]", notNull: true },
    state: { type: "text", notNull: true },
    mapping_revision: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz" },
    revoked_at: { type: "timestamptz" },
  });
  pgm.addConstraint("m2m_organization_bindings", "m2m_organization_bindings_pkey", {
    primaryKey: ["connect_client_id", "organization_id"],
  });
  pgm.addConstraint("m2m_organization_bindings", "m2m_organization_bindings_check", {
    check:
      "mapping_revision>0 AND cardinality(scopes)>0 AND (expires_at IS NULL OR expires_at>created_at) AND ((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))",
  });

  pgm.createTable("api_idempotency_records", {
    organization_id: { type: "ulid", notNull: true },
    principal_id: { type: "text", notNull: true },
    http_method: { type: "text", notNull: true },
    route_template: { type: "text", notNull: true },
    idempotency_key: { type: "text", notNull: true },
    canonical_request_sha256: { type: "bytea", notNull: true },
    canonicalization_version: { type: "text", notNull: true },
    request_id: { type: "text", notNull: true },
    operation_id: { type: "ulid" },
    http_status: { type: "integer" },
    response_headers: { type: "jsonb" },
    response_body: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
    expires_at: { type: "timestamptz" },
  });
  pgm.addConstraint("api_idempotency_records", "api_idempotency_records_pkey", {
    primaryKey: [
      "organization_id",
      "principal_id",
      "http_method",
      "route_template",
      "idempotency_key",
    ],
  });
  pgm.addConstraint("api_idempotency_records", "api_idempotency_records_check", {
    check:
      "octet_length(canonical_request_sha256)=32 AND canonicalization_version='rfc8785-v1' AND http_method=upper(http_method) AND route_template LIKE '/v1/%' AND request_id<>COALESCE(operation_id::text,'') AND (completed_at IS NULL OR expires_at>=completed_at+interval '24 hours') AND (response_headers IS NULL OR (jsonb_typeof(response_headers)='object' AND response_headers-'Location'='{}'::jsonb)) AND (response_body IS NULL OR (jsonb_typeof(response_body)='object' AND http_status BETWEEN 200 AND 599))",
  });
  pgm.sql(
    `CREATE FUNCTION require_completed_idempotency_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM api_idempotency_records WHERE organization_id=NEW.organization_id AND principal_id=NEW.principal_id AND http_method=NEW.http_method AND route_template=NEW.route_template AND idempotency_key=NEW.idempotency_key AND operation_id IS NOT NULL AND http_status IS NOT NULL AND response_headers IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL AND expires_at IS NOT NULL; IF NOT FOUND THEN RAISE EXCEPTION 'api idempotency records must be completed before commit' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$; CREATE CONSTRAINT TRIGGER api_idempotency_records_completed AFTER INSERT OR UPDATE ON api_idempotency_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_completed_idempotency_record();`,
  );

  pgm.createTable("webhook_inbox", {
    inbox_event_id: { type: "ulid", primaryKey: true },
    provider: { type: "text", notNull: true },
    external_event_id: { type: "text", notNull: true },
    event_type: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    body_sha256: { type: "bytea", notNull: true },
    received_at: { type: "timestamptz", notNull: true },
    signature_timestamp: { type: "timestamptz", notNull: true },
    state: { type: "text", notNull: true, default: "pending" },
    attempt_count: { type: "integer", notNull: true, default: 0 },
    max_attempts: { type: "integer", notNull: true },
    available_at: { type: "timestamptz", notNull: true },
    claim_id: { type: "ulid" },
    claimed_at: { type: "timestamptz" },
    lease_expires_at: { type: "timestamptz" },
    last_error_code: { type: "text" },
    acknowledged_at: { type: "timestamptz" },
  });
  pgm.addConstraint("webhook_inbox", "webhook_inbox_provider_event_key", {
    unique: ["provider", "external_event_id"],
  });
  pgm.addConstraint("webhook_inbox", "webhook_inbox_check", {
    // Signature freshness is verified cryptographically by webhook ingress against its configured
    // symmetric tolerance before this trusted record is written. The database stores the verified
    // provider timestamp without imposing a second, fixed clock-skew policy.
    check:
      "octet_length(body_sha256)=32 AND attempt_count>=0 AND max_attempts>0 AND attempt_count<=max_attempts AND (last_error_code IS NULL OR last_error_code~'^[A-Z][A-Z0-9_]{1,63}$') AND ((state='pending' AND attempt_count=0 AND claim_id IS NULL AND acknowledged_at IS NULL) OR (state='processing' AND attempt_count>0 AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at AND acknowledged_at IS NULL) OR (state='retry_wait' AND attempt_count>0 AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL) OR (state='acknowledged' AND attempt_count>0 AND claim_id IS NULL AND last_error_code IS NULL AND acknowledged_at IS NOT NULL) OR (state='reconciliation_required' AND attempt_count=max_attempts AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL))",
  });
  pgm.createIndex("webhook_inbox", ["available_at", "received_at", "inbox_event_id"], {
    where: "state IN ('pending','retry_wait','processing') AND acknowledged_at IS NULL",
  });
}

export function down(pgm) {
  pgm.dropTable("webhook_inbox");
  pgm.dropTrigger("api_idempotency_records", "api_idempotency_records_completed");
  pgm.dropFunction("require_completed_idempotency_record", []);
  pgm.dropTable("api_idempotency_records");
  pgm.dropTable("m2m_organization_bindings");
  pgm.dropTable("organization_memberships");
  pgm.dropTrigger("organization_audit_events", "organization_audit_events_append_only");
  pgm.dropTable("organization_audit_events");
  pgm.dropTrigger("workos_organization_mappings", "workos_organization_mappings_deleted_terminal");
  pgm.dropFunction("guard_terminal_workos_organization_mapping", []);
  pgm.dropTable("workos_organization_mappings");
  pgm.dropTable("api_key_metadata");
  pgm.dropTable("principal_mappings");
}
