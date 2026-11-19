export function up(pgm) {
  pgm.createTable("mail_gateway_keys", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    key_version: { type: "integer", notNull: true },
    key_sha256: { type: "bytea", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_gateway_keys", "mail_gateway_keys_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("mail_gateway_keys", "mail_gateway_keys_ready_domain_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "route53_dkim_receipts (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_gateway_keys", "mail_gateway_keys_hash_key", {
    unique: ["key_sha256"],
  });
  pgm.addConstraint("mail_gateway_keys", "mail_gateway_keys_shape", {
    check: "key_version=1 AND octet_length(key_sha256)=32",
  });
  pgm.createTrigger("mail_gateway_keys", "mail_gateway_keys_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("mail_credit_accounts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    balance_micros: { type: "bigint", notNull: true, default: 0 },
    version: { type: "bigint", notNull: true, default: 0 },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_credit_accounts", "mail_credit_accounts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("mail_credit_accounts", "mail_credit_accounts_ownership_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_credit_accounts", "mail_credit_accounts_shape", {
    check: "balance_micros>=0 AND version>=0",
  });

  pgm.createTable("mail_send_requests", {
    request_id: { type: "ulid", notNull: true, primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    idempotency_key: { type: "text", notNull: true },
    request_sha256: { type: "bytea", notNull: true },
    recipient_sha256: { type: "bytea", notNull: true },
    content_sha256: { type: "bytea", notNull: true },
    credit_charge_micros: { type: "bigint", notNull: true },
    state: { type: "text", notNull: true, default: "reserved" },
    provider_started_at: { type: "timestamptz" },
    provider_message_id: { type: "text" },
    requested_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_send_requests", "mail_send_requests_scope_key", {
    unique: ["organization_id", "project_id", "idempotency_key"],
  });
  pgm.addConstraint("mail_send_requests", "mail_send_requests_ready_domain_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "route53_dkim_receipts (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_send_requests", "mail_send_requests_shape", {
    check: `length(idempotency_key) BETWEEN 1 AND 128
      AND octet_length(request_sha256)=32
      AND octet_length(recipient_sha256)=32
      AND octet_length(content_sha256)=32
      AND credit_charge_micros>0
      AND state IN ('reserved','accepted','uncertain','rejected')
      AND ((state='reserved' AND provider_message_id IS NULL)
        OR (state='accepted' AND provider_started_at IS NOT NULL
          AND length(provider_message_id) BETWEEN 1 AND 256
          AND provider_message_id~'^[A-Za-z0-9._-]+$')
        OR (state='uncertain' AND provider_started_at IS NOT NULL
          AND provider_message_id IS NULL)
        OR (state='rejected' AND provider_message_id IS NULL))
      AND updated_at>=requested_at
      AND (provider_started_at IS NULL OR provider_started_at>=requested_at)`,
  });
  pgm.createIndex("mail_send_requests", ["organization_id", "project_id", "requested_at"]);

  pgm.createTable("mail_credit_ledger", {
    entry_id: { type: "ulid", notNull: true, primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    request_id: { type: "ulid" },
    kind: { type: "text", notNull: true },
    amount_micros: { type: "bigint", notNull: true },
    actor_id: { type: "text", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_credit_ledger", "mail_credit_ledger_request_kind_key", {
    unique: ["request_id", "kind"],
  });
  pgm.addConstraint("mail_credit_ledger", "mail_credit_ledger_account_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "mail_credit_accounts (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_credit_ledger", "mail_credit_ledger_request_fkey", {
    foreignKeys: {
      columns: ["request_id"],
      references: "mail_send_requests (request_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_credit_ledger", "mail_credit_ledger_shape", {
    check: `kind IN ('grant','reserve','release')
      AND amount_micros<>0
      AND length(actor_id) BETWEEN 1 AND 255
      AND ((kind='grant' AND request_id IS NULL AND amount_micros>0)
        OR (kind='reserve' AND request_id IS NOT NULL AND amount_micros<0)
        OR (kind='release' AND request_id IS NOT NULL AND amount_micros>0))`,
  });
  pgm.createTrigger("mail_credit_ledger", "mail_credit_ledger_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.sql(`CREATE FUNCTION guard_mail_send_request_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'mail send requests are append-preserving' USING ERRCODE='23514'; END IF;
    IF OLD.request_id IS DISTINCT FROM NEW.request_id
       OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
       OR OLD.project_id IS DISTINCT FROM NEW.project_id
       OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256
       OR OLD.recipient_sha256 IS DISTINCT FROM NEW.recipient_sha256
       OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
       OR OLD.credit_charge_micros IS DISTINCT FROM NEW.credit_charge_micros
       OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
       OR (OLD.state IN ('accepted','rejected'))
       OR NOT ((OLD.state='reserved' AND NEW.state IN ('reserved','accepted','uncertain','rejected'))
         OR (OLD.state='uncertain' AND NEW.state IN ('uncertain','accepted','rejected')))
       OR (OLD.provider_started_at IS NOT NULL AND OLD.provider_started_at IS DISTINCT FROM NEW.provider_started_at)
    THEN RAISE EXCEPTION 'mail send request identity or state transition is immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END $$`);
  pgm.createTrigger("mail_send_requests", "mail_send_requests_guard", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "guard_mail_send_request_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM mail_credit_ledger)
       OR EXISTS (SELECT 1 FROM mail_send_requests)
       OR EXISTS (SELECT 1 FROM mail_credit_accounts)
       OR EXISTS (SELECT 1 FROM mail_gateway_keys) THEN
      RAISE EXCEPTION 'Mail credit/send evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTrigger("mail_send_requests", "mail_send_requests_guard");
  pgm.dropFunction("guard_mail_send_request_change", []);
  pgm.dropTable("mail_credit_ledger");
  pgm.dropTable("mail_send_requests");
  pgm.dropTable("mail_credit_accounts");
  pgm.dropTable("mail_gateway_keys");
}
