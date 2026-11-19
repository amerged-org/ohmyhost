-- core-v1 source: migrations/directory/0001_directory.sql

-- GLOBAL directory database (one per environment). Small, hot, strongly consistent. No tenant business data.
-- Conventions: ULID = 26 chars Crockford base32, first char 0-7. Timestamps = ISO-8601 UTC, exactly 27 chars
-- 'YYYY-MM-DDTHH:MM:SS.ffffffZ'. Booleans = INTEGER 0/1. JSON = TEXT checked with json_valid().

CREATE TABLE org_directory (
  organization_id         TEXT    NOT NULL PRIMARY KEY
    CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  workos_organization_id  TEXT    NOT NULL UNIQUE
    CHECK (workos_organization_id GLOB 'org_*' AND length(workos_organization_id) BETWEEN 5 AND 128),
  bucket                  INTEGER NOT NULL REFERENCES shard_buckets (bucket),
  state                   TEXT    NOT NULL CHECK (state IN ('active','suspended','deleted')),
  created_at              TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at              TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

-- project -> organization routing and the global handle namespace. Rows for deleted projects stay (handle is never reused).
CREATE TABLE project_directory (
  project_id       TEXT NOT NULL PRIMARY KEY
    CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id  TEXT NOT NULL REFERENCES org_directory (organization_id),
  handle           TEXT NOT NULL UNIQUE
    CHECK (length(handle) BETWEEN 1 AND 59 AND handle NOT GLOB '*[^a-z0-9-]*' AND handle NOT GLOB '-*'
           AND handle NOT GLOB '*-' AND handle NOT GLOB '*--*'
           AND length(handle) - length(replace(handle, '-', '')) <= 4),
  state            TEXT NOT NULL CHECK (state IN ('reserved','active','deleting','deleted')),
  reserved_until   TEXT CHECK (reserved_until IS NULL OR reserved_until GLOB '????-??-??T??:??:??.??????Z'),
  created_at       TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK ((state = 'reserved') = (reserved_until IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX project_directory_org ON project_directory (organization_id, project_id);

-- one row per currently claimed domain in each uniqueness class of today's schema.
CREATE TABLE domain_directory (
  class            TEXT NOT NULL CHECK (class IN ('app_prod','app_dev','cf_mail','paid_hostname','project_mail','resend_live','workspace_live')),
  domain           TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  organization_id  TEXT NOT NULL REFERENCES org_directory (organization_id),
  project_id       TEXT CHECK (project_id IS NULL OR length(project_id) = 26),
  updated_at       TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (class, domain)
) STRICT, WITHOUT ROWID;
CREATE INDEX domain_directory_org ON domain_directory (organization_id, class);

-- provider identifier -> owner, for inbound webhooks and provider-keyed sweeps. A key may map to several projects.
CREATE TABLE external_route (
  kind             TEXT NOT NULL CHECK (kind IN ('github_installation','github_repository','resend_domain','pgcf_database')),
  external_id      TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  organization_id  TEXT NOT NULL REFERENCES org_directory (organization_id),
  project_id       TEXT NOT NULL DEFAULT '' CHECK (project_id = '' OR length(project_id) = 26),
  PRIMARY KEY (kind, external_id, organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX external_route_org ON external_route (organization_id, kind);

-- terminal WorkOS revocations checked on every authenticated request (replaces workos_terminal_revocations).
CREATE TABLE revocations (
  kind                    TEXT NOT NULL CHECK (kind IN ('session','user','organization')),
  resource_id             TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  workos_user_id          TEXT,
  workos_organization_id  TEXT,
  source_event_id         TEXT NOT NULL UNIQUE,
  effective_at            TEXT NOT NULL CHECK (effective_at GLOB '????-??-??T??:??:??.??????Z'),
  purge_after             TEXT CHECK (purge_after IS NULL OR purge_after GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (kind, resource_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX revocations_purge ON revocations (purge_after) WHERE purge_after IS NOT NULL;

-- doorbell: "shard S has work of kind K due at or after due_at". Advisory; shard rows are the truth.
CREATE TABLE work_due (
  kind         TEXT    NOT NULL CHECK (kind IN ('outbox','op_lease','inbox','secret_delivery','schedule','database','mail','recovery','retention')),
  shard_id     INTEGER NOT NULL REFERENCES shards (shard_id),
  due_at       TEXT    NOT NULL CHECK (due_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_token  TEXT,
  claim_until  TEXT CHECK (claim_until IS NULL OR claim_until GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (kind, shard_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX work_due_ready ON work_due (due_at, kind, shard_id);

-- provider events whose routing key has no directory row yet (e.g. WorkOS organization.created before onboarding finished).
CREATE TABLE inbox_unrouted (
  inbox_event_id     TEXT    NOT NULL PRIMARY KEY CHECK (length(inbox_event_id) = 26),
  provider           TEXT    NOT NULL CHECK (provider IN ('workos','github','resend','stripe')),
  external_event_id  TEXT    NOT NULL,
  routing_key        TEXT    NOT NULL,
  event_type         TEXT    NOT NULL,
  payload            TEXT    NOT NULL CHECK (json_valid(payload)),
  body_sha256        BLOB    NOT NULL CHECK (length(body_sha256) = 32),
  received_at        TEXT    NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.??????Z'),
  purge_after        TEXT    NOT NULL CHECK (purge_after GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE (provider, external_event_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX inbox_unrouted_key ON inbox_unrouted (provider, routing_key);
CREATE INDEX inbox_unrouted_purge ON inbox_unrouted (purge_after);

-- first-login onboarding before an organization (and thus a shard) exists; purged 7 days after completion.
CREATE TABLE onboarding_requests (
  request_id              TEXT NOT NULL PRIMARY KEY CHECK (length(request_id) = 26),
  workos_user_id          TEXT NOT NULL,
  idempotency_sha256      BLOB NOT NULL CHECK (length(idempotency_sha256) = 32),
  request_sha256          BLOB NOT NULL CHECK (length(request_sha256) = 32),
  name                    TEXT NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 128),
  organization_attempted  INTEGER NOT NULL CHECK (organization_attempted IN (0,1)),
  membership_attempted    INTEGER NOT NULL CHECK (membership_attempted IN (0,1)),
  workos_organization_id  TEXT UNIQUE,
  organization_id         TEXT CHECK (organization_id IS NULL OR length(organization_id) = 26),
  signup_source           TEXT,
  completed_at            TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  created_at              TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE (workos_user_id, idempotency_sha256)
) STRICT, WITHOUT ROWID;

-- user-level signup attribution (merges user_signup_origins + user_signup_attributions).
CREATE TABLE user_signup (
  workos_user_id       TEXT NOT NULL PRIMARY KEY,
  origin_source        TEXT,
  attributed_source    TEXT,
  first_request_id     TEXT UNIQUE,
  bonus_micros         TEXT CHECK (bonus_micros IS NULL OR bonus_micros NOT GLOB '*[^0-9]*'),
  credit_grant_id      TEXT UNIQUE,
  recorded_at          TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  attributed_at        TEXT CHECK (attributed_at IS NULL OR attributed_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

-- platform-wide configuration rows (signup_sources, shared_mail_capabilities, feature flags).
CREATE TABLE platform_settings (
  key         TEXT    NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 128),
  value       TEXT    NOT NULL CHECK (json_valid(value)),
  revision    INTEGER NOT NULL CHECK (revision >= 1),
  updated_at  TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

-- pre-login public intake with TTL (beta_interests, beta_feature_interests, contact_requests): payload JSON per kind.
CREATE TABLE public_intake (
  intake_id   TEXT NOT NULL PRIMARY KEY CHECK (length(intake_id) BETWEEN 26 AND 64),
  kind        TEXT NOT NULL CHECK (kind IN ('beta_interest','beta_feature_vote','contact_request')),
  dedupe_key  TEXT NOT NULL,
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  created_at  TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at  TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE (kind, dedupe_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX public_intake_expiry ON public_intake (expires_at);
