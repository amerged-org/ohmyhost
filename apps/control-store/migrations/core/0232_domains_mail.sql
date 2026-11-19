-- core-v1 source: migrations/shard/0032_domains_mail.sql
-- Context I: domains and mail (tenant shard). Globally unique names are claimed in the directory first (domain_directory, classes
-- app_prod, app_dev, cf_mail, paid_hostname, project_mail, resend_live, workspace_live); the shard row is the truth.
-- Legacy AWS receipts (ses_*, route53_*, absence) are in legacy_aws_mail_receipts (0002); resend_event_receipts and
-- infrastructure_alert_receipts are Workers KV entries and shared_mail_capabilities is a platform_settings row.

-- Project domain configuration: the platform hostnames of a project. Rows of deleted projects stay (hostnames are never reused).
CREATE TABLE cloudflare_project_domains (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  handle                      TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 59 AND handle NOT GLOB '*[^a-z0-9-]*' AND handle NOT GLOB '-*' AND handle NOT GLOB '*-'),
  -- Original migration 065: the first Development domains were configured in the PoC zone and are retained history.
  zone_name                   TEXT NOT NULL CHECK (zone_name IN ('omh.st','aixyte.com')),
  production_domain           TEXT NOT NULL CHECK (production_domain = lower(production_domain) AND length(production_domain) BETWEEN 3 AND 253),
  development_domain          TEXT NOT NULL CHECK (development_domain = lower(development_domain) AND length(development_domain) BETWEEN 3 AND 253),
  mail_domain                 TEXT CHECK (mail_domain IS NULL OR (mail_domain = lower(mail_domain) AND length(mail_domain) BETWEEN 3 AND 253)),
  configured_by_principal_id  TEXT NOT NULL CHECK (length(configured_by_principal_id) BETWEEN 1 AND 256),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  configured_at TEXT NOT NULL CHECK (configured_at GLOB '????-??-??T??:??:??.??????Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  UNIQUE (organization_id, project_id, idempotency_key_sha256),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX cloudflare_project_domains_by_handle ON cloudflare_project_domains (handle);
-- Only the handle rename (the three names together) and the soft delete may change a configured row.
CREATE TRIGGER cloudflare_project_domains_identity_guard BEFORE UPDATE ON cloudflare_project_domains
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.zone_name IS NOT OLD.zone_name
    OR NEW.mail_domain IS NOT OLD.mail_domain OR NEW.configured_by_principal_id IS NOT OLD.configured_by_principal_id
    OR NEW.idempotency_key_sha256 IS NOT OLD.idempotency_key_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256
    OR NEW.configured_at IS NOT OLD.configured_at
    OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
    OR ((NEW.handle IS NOT OLD.handle OR NEW.production_domain IS NOT OLD.production_domain OR NEW.development_domain IS NOT OLD.development_domain)
        AND (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL
             OR NOT (NEW.production_domain = NEW.handle || substr(OLD.production_domain, length(OLD.handle) + 1)
                 AND NEW.development_domain = 'dev-' || NEW.handle || substr(OLD.development_domain, length(OLD.handle) + 5))))
BEGIN SELECT RAISE(ABORT, 'E55000 a project domain configuration changes only by a handle rename or its soft delete'); END;
-- A Dev access ticket is bound to the development origin of the active domain row of the same handle.
CREATE TRIGGER dev_access_tickets_origin BEFORE INSERT ON dev_access_tickets
  WHEN NOT EXISTS (SELECT 1 FROM cloudflare_project_domains d WHERE d.organization_id = NEW.organization_id AND d.project_id = NEW.project_id
                      AND d.handle = NEW.handle AND d.deleted_at IS NULL AND 'https://' || d.development_domain = NEW.public_origin)
BEGIN SELECT RAISE(ABORT, 'E23514 a Dev access ticket origin must be the development domain of the active project domain'); END;

-- Observation history of DNS records, custom hostnames, SSL and worker routes. The kind-specific columns of the PostgreSQL table are the body.
CREATE TABLE cloudflare_project_domain_receipts (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) = 26 AND receipt_id GLOB '[0-7]*' AND receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  kind                 TEXT NOT NULL CHECK (kind IN ('dns_record', 'custom_hostname', 'ssl', 'worker_route')),
  environment_name     TEXT CHECK (environment_name IS NULL OR environment_name IN ('dev', 'prod')),
  provider_resource_id TEXT CHECK (provider_resource_id IS NULL OR length(provider_resource_id) BETWEEN 1 AND 256),
  hostname             TEXT,
  custom_hostname_id   TEXT,
  body TEXT NOT NULL CHECK (json_valid(body)),
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, receipt_id),
  UNIQUE (organization_id, project_id, kind, provider_resource_id, observed_at),
  FOREIGN KEY (organization_id, project_id) REFERENCES cloudflare_project_domains (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX cloudflare_project_domain_receipts_latest ON cloudflare_project_domain_receipts (organization_id, project_id, kind, provider_resource_id, observed_at DESC);

-- A customer-owned hostname on the production gateway (one connection per project).
CREATE TABLE paid_project_domains (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  hostname                    TEXT NOT NULL CHECK (hostname = lower(hostname) AND length(hostname) BETWEEN 3 AND 253),
  gateway_script_name         TEXT CHECK (gateway_script_name IS NULL OR length(gateway_script_name) BETWEEN 1 AND 255),
  state                       TEXT NOT NULL CHECK (state IN ('awaiting_deployment', 'pending', 'active', 'deleting', 'deleted')),
  configured_by_principal_id  TEXT NOT NULL CHECK (length(configured_by_principal_id) BETWEEN 1 AND 256),
  apply_idempotency_sha256 BLOB NOT NULL CHECK (length(apply_idempotency_sha256) = 32),
  apply_request_sha256 BLOB NOT NULL CHECK (length(apply_request_sha256) = 32),
  custom_hostname_receipt TEXT CHECK (custom_hostname_receipt IS NULL OR json_valid(custom_hostname_receipt)),
  worker_route_receipt TEXT CHECK (worker_route_receipt IS NULL OR json_valid(worker_route_receipt)),
  delete_idempotency_sha256 BLOB CHECK (delete_idempotency_sha256 IS NULL OR length(delete_idempotency_sha256) = 32),
  delete_request_sha256 BLOB CHECK (delete_request_sha256 IS NULL OR length(delete_request_sha256) = 32),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.??????Z'),
  provisioning_started_at TEXT CHECK (provisioning_started_at IS NULL OR provisioning_started_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  CHECK ((state = 'awaiting_deployment' AND gateway_script_name IS NULL AND provisioning_started_at IS NULL)
      OR (state IN ('pending', 'active') AND gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)
      OR (state IN ('deleting', 'deleted')
          AND ((gateway_script_name IS NULL AND provisioning_started_at IS NULL AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL)
            OR (gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)))),
  CHECK (provisioning_started_at IS NULL OR provisioning_started_at >= created_at),
  CHECK ((state IN ('awaiting_deployment', 'pending') AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
          AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL AND deleted_at IS NULL)
      OR (state = 'active' AND custom_hostname_receipt IS NOT NULL AND worker_route_receipt IS NOT NULL AND deleted_at IS NULL)
      OR (state IN ('deleting', 'deleted')
          AND ((custom_hostname_receipt IS NOT NULL AND worker_route_receipt IS NOT NULL) OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL))
          AND delete_idempotency_sha256 IS NOT NULL AND delete_request_sha256 IS NOT NULL
          AND (deleted_at IS NULL) = (state = 'deleting')))
) STRICT, WITHOUT ROWID;

-- Legacy declared project mail domain (with its idempotency receipt, purged 7 days after completion).
CREATE TABLE project_mail_domains (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  domain                  TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  configured_by           TEXT NOT NULL CHECK (length(configured_by) BETWEEN 1 AND 256),
  configured_at TEXT NOT NULL CHECK (configured_at GLOB '????-??-??T??:??:??.??????Z'),
  declaration_generation  TEXT NOT NULL CHECK (length(declaration_generation) BETWEEN 1 AND 64),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE project_mail_domain_requests (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  domain           TEXT NOT NULL,
  response TEXT NOT NULL CHECK (json_valid(response)),
  requested_at TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT NOT NULL CHECK (completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, idempotency_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX project_mail_domain_requests_purge ON project_mail_domain_requests (completed_at);

-- Legacy Resend mail domain of a project's prod environment (at most one live row per project).
CREATE TABLE resend_mail_domains (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  domain_id TEXT NOT NULL CHECK (length(domain_id) = 26 AND domain_id GLOB '[0-7]*' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  domain                  TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  provider_domain_id      TEXT,
  provider_claimed_at TEXT CHECK (provider_claimed_at IS NULL OR provider_claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_preflight_at TEXT CHECK (provider_preflight_at IS NULL OR provider_preflight_at GLOB '????-??-??T??:??:??.??????Z'),
  verify_requested_at TEXT CHECK (verify_requested_at IS NULL OR verify_requested_at GLOB '????-??-??T??:??:??.??????Z'),
  sending_key_id          TEXT,
  sending_key_claimed_at TEXT CHECK (sending_key_claimed_at IS NULL OR sending_key_claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  sending_key_ciphertext  BLOB CHECK (sending_key_ciphertext IS NULL OR length(sending_key_ciphertext) >= 17),
  sending_key_nonce       BLOB CHECK (sending_key_nonce IS NULL OR length(sending_key_nonce) = 12),
  sending_key_sha256 BLOB CHECK (sending_key_sha256 IS NULL OR length(sending_key_sha256) = 32),
  sending_key_version     INTEGER CHECK (sending_key_version IS NULL OR sending_key_version >= 1),
  sending INTEGER NOT NULL CHECK (sending IN (0,1)),
  receiving INTEGER NOT NULL CHECK (receiving IN (0,1)),
  receiving_suspended INTEGER NOT NULL CHECK (receiving_suspended IN (0,1)),
  last_entitlement_check_at TEXT CHECK (last_entitlement_check_at IS NULL OR last_entitlement_check_at GLOB '????-??-??T??:??:??.??????Z'),
  last_reconcile_at TEXT CHECK (last_reconcile_at IS NULL OR last_reconcile_at GLOB '????-??-??T??:??:??.??????Z'),
  sending_status          TEXT NOT NULL DEFAULT 'pending' CHECK (sending_status IN ('disabled', 'pending', 'ready', 'failed')),
  receiving_status        TEXT NOT NULL DEFAULT 'pending' CHECK (receiving_status IN ('disabled', 'pending', 'ready', 'failed')),
  records                 TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(records) AND json_type(records) = 'array'),
  dns_receipts            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dns_receipts) AND json_type(dns_receipts) = 'object'),
  webhook_url             TEXT CHECK (webhook_url IS NULL OR webhook_url GLOB 'https://*'),
  webhook_verified_at TEXT CHECK (webhook_verified_at IS NULL OR webhook_verified_at GLOB '????-??-??T??:??:??.??????Z'),
  configured_at TEXT NOT NULL CHECK (configured_at GLOB '????-??-??T??:??:??.??????Z'),
  observed_at TEXT CHECK (observed_at IS NULL OR observed_at GLOB '????-??-??T??:??:??.??????Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, domain_id),
  UNIQUE (domain_id),
  UNIQUE (provider_domain_id),
  UNIQUE (sending_key_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  CHECK ((sending_key_id IS NULL) = (sending_key_ciphertext IS NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX resend_mail_domains_one_live_per_project ON resend_mail_domains (organization_id, project_id) WHERE deleted_at IS NULL;
CREATE INDEX resend_mail_domains_by_domain ON resend_mail_domains (domain);
CREATE TRIGGER resend_mail_domains_prod_environment BEFORE INSERT ON resend_mail_domains
  WHEN NOT EXISTS (SELECT 1 FROM environments e WHERE e.organization_id = NEW.organization_id AND e.environment_id = NEW.environment_id
                      AND e.project_id = NEW.project_id AND e.name = 'prod')
BEGIN SELECT RAISE(ABORT, 'E23514 a Resend mail domain belongs to the prod environment of its project'); END;
CREATE TRIGGER resend_mail_domains_identity BEFORE UPDATE ON resend_mail_domains
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.domain_id IS NOT OLD.domain_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.environment_id IS NOT OLD.environment_id OR NEW.domain IS NOT OLD.domain OR NEW.configured_at IS NOT OLD.configured_at
    OR (OLD.provider_domain_id IS NOT NULL AND NEW.provider_domain_id IS NOT OLD.provider_domain_id)
    OR (OLD.sending_key_id IS NOT NULL AND NEW.sending_key_id IS NOT OLD.sending_key_id)
    OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN SELECT RAISE(ABORT, 'E55000 a Resend mail domain keeps its identity; provider ids and deletion are set once'); END;

-- Idempotent Resend command with its lease (setup, retry and retirement of one project environment). Purged 7 days after completion.
CREATE TABLE resend_mail_commands (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  response TEXT CHECK (response IS NULL OR json_valid(response)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_until TEXT CHECK (lease_until IS NULL OR lease_until GLOB '????-??-??T??:??:??.??????Z'),
  claimed_attempt  INTEGER CHECK (claimed_attempt IS NULL OR claimed_attempt >= 1),
  domain_id TEXT CHECK (domain_id IS NULL OR (length(domain_id) = 26 AND domain_id GLOB '[0-7]*' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  PRIMARY KEY (organization_id, project_id, environment_id, idempotency_key),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  CHECK ((response IS NULL) = (completed_at IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX resend_mail_commands_by_domain ON resend_mail_commands (organization_id, domain_id) WHERE domain_id IS NOT NULL;
CREATE INDEX resend_mail_commands_purge ON resend_mail_commands (completed_at) WHERE completed_at IS NOT NULL;

-- Workspace-level verified sender domain: custody of the sealed sending key, provider ids and reputation latch.
CREATE TABLE workspace_mail_domains (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  domain_id TEXT NOT NULL CHECK (length(domain_id) = 26 AND domain_id GLOB '[0-7]*' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  domain                       TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  registrable_domain           TEXT CHECK (registrable_domain IS NULL OR (registrable_domain = lower(registrable_domain) AND length(registrable_domain) BETWEEN 3 AND 253)),
  legacy_domain_id TEXT CHECK (legacy_domain_id IS NULL OR (length(legacy_domain_id) = 26 AND legacy_domain_id GLOB '[0-7]*' AND legacy_domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  custody_organization_id TEXT NOT NULL CHECK (length(custody_organization_id) = 26 AND custody_organization_id GLOB '[0-7]*' AND custody_organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  custody_project_id TEXT NOT NULL CHECK (length(custody_project_id) = 26 AND custody_project_id GLOB '[0-7]*' AND custody_project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  custody_environment_id TEXT NOT NULL CHECK (length(custody_environment_id) = 26 AND custody_environment_id GLOB '[0-7]*' AND custody_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  revision                     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status                       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retiring', 'retired')),
  reputation_state             TEXT NOT NULL DEFAULT 'active' CHECK (reputation_state IN ('active', 'suspended')),
  reputation_suspended_at TEXT CHECK (reputation_suspended_at IS NULL OR reputation_suspended_at GLOB '????-??-??T??:??:??.??????Z'),
  reputation_suspension_reason TEXT CHECK (reputation_suspension_reason IS NULL OR reputation_suspension_reason IN ('bounce_rate', 'complaint_rate')),
  reputation_triggering_event_id TEXT,
  reputation_version           INTEGER NOT NULL DEFAULT 1 CHECK (reputation_version >= 1),
  capabilities_lease_until TEXT CHECK (capabilities_lease_until IS NULL OR capabilities_lease_until GLOB '????-??-??T??:??:??.??????Z'),
  capabilities_lease_token     TEXT,
  last_reconcile_at TEXT CHECK (last_reconcile_at IS NULL OR last_reconcile_at GLOB '????-??-??T??:??:??.??????Z'),
  capabilities_dirty           INTEGER NOT NULL DEFAULT 0 CHECK (capabilities_dirty IN (0, 1)),
  provider_domain_id           TEXT,
  provider_claimed_at TEXT CHECK (provider_claimed_at IS NULL OR provider_claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_preflight_at TEXT CHECK (provider_preflight_at IS NULL OR provider_preflight_at GLOB '????-??-??T??:??:??.??????Z'),
  verify_requested_at TEXT CHECK (verify_requested_at IS NULL OR verify_requested_at GLOB '????-??-??T??:??:??.??????Z'),
  sending_key_id               TEXT,
  sending_key_claimed_at TEXT CHECK (sending_key_claimed_at IS NULL OR sending_key_claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  sending_key_ciphertext       BLOB CHECK (sending_key_ciphertext IS NULL OR length(sending_key_ciphertext) >= 17),
  sending_key_nonce            BLOB CHECK (sending_key_nonce IS NULL OR length(sending_key_nonce) = 12),
  sending_key_sha256 BLOB CHECK (sending_key_sha256 IS NULL OR length(sending_key_sha256) = 32),
  sending_key_version          INTEGER CHECK (sending_key_version IS NULL OR sending_key_version >= 1),
  sending_status               TEXT NOT NULL DEFAULT 'pending' CHECK (sending_status IN ('disabled', 'pending', 'ready', 'failed')),
  receiving_status             TEXT NOT NULL DEFAULT 'disabled' CHECK (receiving_status IN ('disabled', 'pending', 'ready', 'failed')),
  records                      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(records) AND json_type(records) = 'array'),
  dns_receipts                 TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dns_receipts) AND json_type(dns_receipts) = 'object'),
  configured_at TEXT NOT NULL CHECK (configured_at GLOB '????-??-??T??:??:??.??????Z'),
  observed_at TEXT CHECK (observed_at IS NULL OR observed_at GLOB '????-??-??T??:??:??.??????Z'),
  retired_at TEXT CHECK (retired_at IS NULL OR retired_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, domain_id),
  UNIQUE (legacy_domain_id),
  UNIQUE (provider_domain_id),
  UNIQUE (sending_key_id),
  FOREIGN KEY (organization_id) REFERENCES organizations (organization_id),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CHECK ((reputation_state = 'suspended') = (reputation_suspended_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX workspace_mail_domains_by_domain ON workspace_mail_domains (domain);
CREATE TRIGGER workspace_mail_domains_identity BEFORE UPDATE ON workspace_mail_domains
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.domain_id IS NOT OLD.domain_id OR NEW.domain IS NOT OLD.domain
    OR NEW.legacy_domain_id IS NOT OLD.legacy_domain_id OR NEW.custody_organization_id IS NOT OLD.custody_organization_id
    OR NEW.custody_project_id IS NOT OLD.custody_project_id OR NEW.custody_environment_id IS NOT OLD.custody_environment_id
    OR NEW.configured_at IS NOT OLD.configured_at
    OR (OLD.provider_domain_id IS NOT NULL AND NEW.provider_domain_id IS NOT OLD.provider_domain_id)
    OR (OLD.sending_key_id IS NOT NULL AND (NEW.sending_key_id IS NOT OLD.sending_key_id OR NEW.sending_key_ciphertext IS NOT OLD.sending_key_ciphertext
        OR NEW.sending_key_nonce IS NOT OLD.sending_key_nonce OR NEW.sending_key_sha256 IS NOT OLD.sending_key_sha256
        OR NEW.sending_key_version IS NOT OLD.sending_key_version))
    OR (OLD.registrable_domain IS NOT NULL AND NEW.registrable_domain IS NOT OLD.registrable_domain)
    OR (OLD.status = 'retired' AND NEW.status <> 'retired')
BEGIN SELECT RAISE(ABORT, 'E55000 a workspace mail domain keeps its identity and custody; a retired domain is terminal'); END;

-- Idempotent workspace mail command with its lease. Purged 7 days after completion.
CREATE TABLE workspace_mail_commands (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  domain_id TEXT NOT NULL CHECK (length(domain_id) = 26 AND domain_id GLOB '[0-7]*' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  operation        TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  principal_id     TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  response TEXT CHECK (response IS NULL OR json_valid(response)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_until TEXT CHECK (lease_until IS NULL OR lease_until GLOB '????-??-??T??:??:??.??????Z'),
  claimed_attempt  INTEGER CHECK (claimed_attempt IS NULL OR claimed_attempt >= 1),
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, domain_id) REFERENCES workspace_mail_domains (organization_id, domain_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX workspace_mail_commands_by_domain ON workspace_mail_commands (organization_id, domain_id, operation);
CREATE INDEX workspace_mail_commands_purge ON workspace_mail_commands (completed_at) WHERE completed_at IS NOT NULL;

-- Project to workspace mail domain binding (one per project).
CREATE TABLE project_mail_domain_bindings (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  mail_domain_id TEXT NOT NULL CHECK (length(mail_domain_id) = 26 AND mail_domain_id GLOB '[0-7]*' AND mail_domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state                          TEXT NOT NULL CHECK (state IN ('active', 'detached', 'suspended')),
  sending INTEGER NOT NULL CHECK (sending IN (0,1)),
  legacy INTEGER NOT NULL CHECK (legacy IN (0,1)),
  sender_addresses               TEXT NOT NULL CHECK (json_valid(sender_addresses) AND json_type(sender_addresses) = 'array'),
  default_from                   TEXT,
  default_reply_to               TEXT,
  application_identity_revision  INTEGER CHECK (application_identity_revision IS NULL OR application_identity_revision >= 1),
  configured_at TEXT NOT NULL CHECK (configured_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  FOREIGN KEY (organization_id, mail_domain_id) REFERENCES workspace_mail_domains (organization_id, domain_id),
  CHECK (sending = 0 OR state = 'active')
) STRICT, WITHOUT ROWID;
CREATE INDEX project_mail_domain_bindings_by_domain ON project_mail_domain_bindings (organization_id, mail_domain_id) WHERE state = 'active';

-- Application identity proof of a project's website domain (one per project; the revision grows with every declaration).
CREATE TABLE project_application_domain_identities (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  hostname                TEXT NOT NULL CHECK (hostname = lower(hostname) AND length(hostname) BETWEEN 3 AND 240),
  registrable_domain      TEXT NOT NULL CHECK (registrable_domain = lower(registrable_domain) AND length(registrable_domain) BETWEEN 3 AND 253),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state                   TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'revoked')),
  challenge_name          TEXT NOT NULL CHECK (length(challenge_name) BETWEEN 1 AND 300),
  challenge_value         TEXT NOT NULL CHECK (length(challenge_value) BETWEEN 32 AND 128),
  declared_at TEXT NOT NULL CHECK (declared_at GLOB '????-??-??T??:??:??.??????Z'),
  verified_at TEXT CHECK (verified_at IS NULL OR verified_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  automatic_revalidation_attempted_at TEXT CHECK (automatic_revalidation_attempted_at IS NULL OR automatic_revalidation_attempted_at GLOB '????-??-??T??:??:??.??????Z'),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  actor_id                TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  PRIMARY KEY (organization_id, project_id),
  UNIQUE (organization_id, project_id, revision),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER project_application_domain_identities_revision BEFORE UPDATE ON project_application_domain_identities
  WHEN NEW.revision < OLD.revision
    OR (NEW.revision = OLD.revision AND (NEW.hostname IS NOT OLD.hostname OR NEW.registrable_domain IS NOT OLD.registrable_domain
        OR NEW.challenge_name IS NOT OLD.challenge_name OR NEW.challenge_value IS NOT OLD.challenge_value))
BEGIN SELECT RAISE(ABORT, 'E55000 an application identity revision never decreases and keeps its challenge'); END;

-- Idempotency receipts of application identity commands. Purged 7 days after recording.
CREATE TABLE project_application_identity_commands (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  response TEXT NOT NULL CHECK (json_valid(response)),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, idempotency_key_sha256),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX project_application_identity_commands_purge ON project_application_identity_commands (recorded_at);
CREATE TABLE project_application_identity_action_commands (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  actor_id                TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  action                  TEXT NOT NULL CHECK (action IN ('verify', 'revoke')),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  response TEXT NOT NULL CHECK (json_valid(response)),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, actor_id, action, idempotency_key_sha256),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX project_application_identity_action_commands_purge ON project_application_identity_action_commands (recorded_at);

-- Digest of the project's mail gateway key (authentication uses the environment secret; this row retains reputation history).
CREATE TABLE mail_gateway_keys (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  key_sha256 BLOB NOT NULL CHECK (length(key_sha256) = 32),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  UNIQUE (organization_id, key_sha256),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;

-- Per-project send reputation. version = old + 1 on every change; suspension is reviewed by an operator.
CREATE TABLE mail_reputation_states (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  state               TEXT NOT NULL CHECK (state IN ('active', 'suspended')),
  warmup_started_at TEXT NOT NULL CHECK (warmup_started_at GLOB '????-??-??T??:??:??.??????Z'),
  suspended_at TEXT CHECK (suspended_at IS NULL OR suspended_at GLOB '????-??-??T??:??:??.??????Z'),
  suspension_reason   TEXT CHECK (suspension_reason IS NULL OR suspension_reason IN ('bounce_rate', 'complaint_rate')),
  triggering_event_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES mail_gateway_keys (organization_id, project_id),
  CHECK ((state = 'suspended') = (suspended_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER mail_reputation_states_no_delete BEFORE DELETE ON mail_reputation_states
BEGIN SELECT RAISE(ABORT, 'E55000 mail_reputation_states is append-preserving'); END;
CREATE TRIGGER mail_reputation_states_version BEFORE UPDATE ON mail_reputation_states
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'E55000 mail reputation versions advance by one and time never goes back'); END;

-- Reputation decisions (suspend, reinstate, retain) of a project (domain_id '') or of a shared workspace domain. Append-only.
CREATE TABLE mail_reputation_decisions (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  decision_id         TEXT NOT NULL CHECK (length(decision_id) BETWEEN 26 AND 36),
  domain_id           TEXT NOT NULL DEFAULT '' CHECK (domain_id = '' OR length(domain_id) = 26),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  action              TEXT NOT NULL CHECK (action IN ('suspend', 'reinstate', 'retain')),
  reason              TEXT NOT NULL CHECK (reason IN ('bounce_rate', 'complaint_rate', 'manual_review')),
  triggering_event_id TEXT,
  eligible_send_count INTEGER NOT NULL CHECK (eligible_send_count >= 0),
  hard_bounce_count INTEGER NOT NULL CHECK (hard_bounce_count >= 0),
  complaint_count INTEGER NOT NULL CHECK (complaint_count >= 0),
  actor_id            TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  evidence_sha256 BLOB CHECK (evidence_sha256 IS NULL OR length(evidence_sha256) = 32),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, decision_id, domain_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER mail_reputation_decisions_append_only_update BEFORE UPDATE ON mail_reputation_decisions
BEGIN SELECT RAISE(ABORT, 'E55000 mail_reputation_decisions is append-only'); END;
CREATE TRIGGER mail_reputation_decisions_append_only_delete BEFORE DELETE ON mail_reputation_decisions
BEGIN SELECT RAISE(ABORT, 'E55000 mail_reputation_decisions is append-only'); END;

-- Provider delivery, bounce and complaint events of sent mail. 90 days hot, then R2.
CREATE TABLE mail_send_events (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider_event_id   TEXT NOT NULL CHECK (length(provider_event_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  request_id TEXT NOT NULL CHECK (length(request_id) = 26 AND request_id GLOB '[0-7]*' AND request_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 256),
  event_type          TEXT NOT NULL CHECK (event_type IN ('Send', 'Delivery', 'DeliveryDelay', 'Bounce', 'Complaint', 'Reject', 'Rendering Failure')),
  outcome             TEXT NOT NULL CHECK (outcome IN ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed')),
  detail_sha256 BLOB NOT NULL CHECK (length(detail_sha256) = 32),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  sent_at TEXT NOT NULL CHECK (sent_at GLOB '????-??-??T??:??:??.??????Z'),
  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.??????Z'),
  reputation_kind     TEXT CHECK (reputation_kind IS NULL OR reputation_kind IN ('hard_bounce', 'complaint')),
  PRIMARY KEY (organization_id, provider_event_id),
  FOREIGN KEY (organization_id, request_id) REFERENCES mail_send_requests (organization_id, request_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX mail_send_events_by_request ON mail_send_events (organization_id, project_id, request_id);
CREATE INDEX mail_send_events_reputation ON mail_send_events (organization_id, project_id, received_at) WHERE reputation_kind IS NOT NULL;
CREATE TRIGGER mail_send_events_append_only_update BEFORE UPDATE ON mail_send_events
BEGIN SELECT RAISE(ABORT, 'E55000 mail_send_events is append-only'); END;

-- Inbound mail delivery attempts with their lease. Purged 14 days after delivery or expiry.
CREATE TABLE mail_received_messages (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  message_id TEXT NOT NULL CHECK (length(message_id) = 26 AND message_id GLOB '[0-7]*' AND message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider_message_id  TEXT NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 128),
  domain_id TEXT NOT NULL CHECK (length(domain_id) = 26 AND domain_id GLOB '[0-7]*' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  state                TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'delivery_failed', 'expired')),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  first_attempt_at TEXT CHECK (first_attempt_at IS NULL OR first_attempt_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_until TEXT CHECK (lease_until IS NULL OR lease_until GLOB '????-??-??T??:??:??.??????Z'),
  next_attempt_at TEXT NOT NULL CHECK (next_attempt_at GLOB '????-??-??T??:??:??.??????Z'),
  last_http_status     INTEGER CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  billed_at TEXT CHECK (billed_at IS NULL OR billed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, message_id),
  UNIQUE (provider_message_id),
  FOREIGN KEY (organization_id, domain_id) REFERENCES resend_mail_domains (organization_id, domain_id),
  CHECK (attempts = 0 OR first_attempt_at IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX mail_received_messages_due ON mail_received_messages (next_attempt_at) WHERE state IN ('pending', 'delivering');
CREATE INDEX mail_received_messages_unbilled ON mail_received_messages (received_at) WHERE billed_at IS NULL;
CREATE INDEX mail_received_messages_purge ON mail_received_messages (expires_at);
CREATE TRIGGER mail_received_messages_identity BEFORE UPDATE ON mail_received_messages
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.message_id IS NOT OLD.message_id OR NEW.provider_message_id IS NOT OLD.provider_message_id
    OR NEW.domain_id IS NOT OLD.domain_id OR NEW.project_id IS NOT OLD.project_id OR NEW.environment_id IS NOT OLD.environment_id
    OR NEW.received_at IS NOT OLD.received_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.attempts NOT BETWEEN OLD.attempts AND OLD.attempts + 1
    OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS NOT OLD.first_attempt_at)
BEGIN SELECT RAISE(ABORT, 'E55000 received mail keeps its identity; attempts grow by at most one'); END;

-- The mail send ledger (mail_send_requests, 0002): identity and charge are immutable and the state machine is one way.
CREATE TRIGGER mail_send_requests_no_delete BEFORE DELETE ON mail_send_requests
BEGIN SELECT RAISE(ABORT, 'E23514 mail send requests are append-preserving'); END;
CREATE TRIGGER mail_send_requests_guard BEFORE UPDATE ON mail_send_requests
  WHEN NEW.request_id IS NOT OLD.request_id OR NEW.organization_id IS NOT OLD.organization_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.recipient_sha256 IS NOT OLD.recipient_sha256
    OR NEW.content_sha256 IS NOT OLD.content_sha256 OR NEW.credit_charge_micros IS NOT OLD.credit_charge_micros
    OR NEW.requested_at IS NOT OLD.requested_at
    OR OLD.state IN ('accepted', 'rejected')
    OR NOT ((OLD.state = 'reserved' AND NEW.state IN ('reserved', 'accepted', 'uncertain', 'rejected'))
         OR (OLD.state = 'uncertain' AND NEW.state IN ('uncertain', 'accepted', 'rejected')))
    OR (OLD.provider_started_at IS NOT NULL AND NEW.provider_started_at IS NOT OLD.provider_started_at)
BEGIN SELECT RAISE(ABORT, 'E23514 mail send request identity or state transition is immutable'); END;
CREATE TRIGGER mail_send_requests_sender_snapshot BEFORE UPDATE ON mail_send_requests
  WHEN NEW.mail_domain_id IS NOT OLD.mail_domain_id OR NEW.mail_binding_revision IS NOT OLD.mail_binding_revision
    OR NEW.effective_from IS NOT OLD.effective_from OR NEW.effective_reply_to IS NOT OLD.effective_reply_to
    OR NEW.request_input_sha256 IS NOT OLD.request_input_sha256
BEGIN SELECT RAISE(ABORT, 'E23514 the sender snapshot of a mail send request is immutable'); END;
