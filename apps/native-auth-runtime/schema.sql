-- Run with the private realm schema as search_path by the migration role.
-- This is separate from the application database and its auth schema.
create table "user" (
  "id" uuid primary key default pg_catalog.gen_random_uuid(),
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null default false,
  "image" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);
create table "session" (
  "id" uuid primary key default pg_catalog.gen_random_uuid(),
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid not null references "user" ("id") on delete cascade
);
create table "account" (
  "id" uuid primary key default pg_catalog.gen_random_uuid(),
  "accountId" text not null,
  "providerId" text not null,
  "userId" uuid not null references "user" ("id") on delete cascade,
  "accessToken" text check ("accessToken" is null),
  "refreshToken" text check ("refreshToken" is null),
  "idToken" text check ("idToken" is null),
  "accessTokenExpiresAt" timestamptz check ("accessTokenExpiresAt" is null),
  "refreshTokenExpiresAt" timestamptz check ("refreshTokenExpiresAt" is null),
  "scope" text,
  "password" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null,
  unique ("providerId", "accountId")
);
create table "verification" (
  "id" uuid primary key default pg_catalog.gen_random_uuid(),
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);
create table "rateLimit" (
  "id" uuid primary key default pg_catalog.gen_random_uuid(),
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);
create table native_user_policy (
  user_id uuid primary key references "user" ("id") on delete cascade,
  status text not null check (status in ('pending', 'active', 'suspended')),
  recovery_verified_at timestamptz,
  revocation_epoch bigint not null default 0 check (revocation_epoch >= 0)
);
create table native_session_policy (
  session_id uuid primary key references "session" ("id") on delete cascade,
  realm_epoch bigint not null check (realm_epoch >= 0),
  user_epoch bigint not null check (user_epoch >= 0),
  authenticated_at timestamptz not null
);
create table native_invitation (
  token_digest bytea primary key,
  user_id uuid not null references "user" ("id") on delete cascade,
  realm_epoch bigint not null check (realm_epoch >= 0),
  configuration_revision bigint not null check (configuration_revision >= 0),
  user_epoch bigint not null check (user_epoch >= 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (user_id)
);
create index session_user_id_idx on "session" ("userId");
create index account_user_id_idx on "account" ("userId");
create index verification_identifier_idx on "verification" ("identifier");

-- Authority transitions and credential/session mutations serialize on this row.
-- The private authority must update it before acknowledging a realm revocation.
create table native_realm_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null,
  revocation_epoch bigint not null check (revocation_epoch >= 0),
  configuration_revision bigint not null check (configuration_revision >= 0)
);
create table native_mail_challenge (
  token_digest bytea primary key,
  user_id uuid not null references "user" ("id") on delete cascade,
  purpose text not null check (purpose in ('invitation', 'verification', 'password-reset')),
  realm_epoch bigint not null check (realm_epoch >= 0),
  configuration_revision bigint not null check (configuration_revision >= 0),
  user_epoch bigint not null check (user_epoch >= 0),
  expires_at timestamptz not null,
  unique (user_id, purpose)
);

create unique index native_user_email_normalized_idx on "user" (lower("email"));
create table native_admin_receipt (
  request_id text primary key,
  request_digest bytea not null,
  response jsonb not null,
  created_at timestamptz not null default current_timestamp
);
create table native_admin_audit (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  request_id text not null unique references native_admin_receipt (request_id),
  action text not null,
  user_id uuid not null,
  created_at timestamptz not null default current_timestamp
);
create table native_mail_outbox (
  message_id uuid primary key,
  request_id text not null unique references native_admin_receipt (request_id),
  user_id uuid not null,
  kind text not null check (kind = 'invitation'),
  sealed_payload bytea not null,
  token_digest bytea not null,
  lease_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  delivered_at timestamptz,
  cancelled_at timestamptz
);

create table native_invitation_accept_receipt (
  request_id text primary key,
  token_digest bytea not null,
  user_id uuid not null,
  created_at timestamptz not null default current_timestamp
);

-- Private sealed mail, staged in the same transaction as the credential token.
create table native_auth_mail_outbox (
  message_id uuid primary key,
  request_id text not null,
  kind text not null check (kind in ('verification', 'password-reset')),
  sealed_payload bytea not null,
  user_id uuid not null references "user" (id) on delete cascade,
  token_digest bytea not null,
  realm_epoch bigint not null,
  configuration_revision bigint not null,
  lease_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  delivered_at timestamptz
);

create table native_password_receipt (
  request_id text primary key,
  request_digest bytea not null,
  response_body text not null,
  response_status integer not null,
  created_at timestamptz not null default current_timestamp
);

create table native_password_rate_limit (
  key_digest bytea primary key,
  window_start bigint not null,
  count integer not null check (count > 0),
  updated_at timestamptz not null default current_timestamp
);
create index native_password_rate_limit_updated_idx on native_password_rate_limit (updated_at);
