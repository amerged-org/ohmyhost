-- Expand-only: bind engine OAuth state to private realm policy and flow intent.
create table native_social_flow (
  state_digest bytea primary key,
  provider text not null check (provider in ('google', 'github')),
  intent text not null check (intent in ('login', 'link', 'reauth')),
  realm_epoch bigint not null check (realm_epoch >= 0),
  configuration_revision bigint not null check (configuration_revision >= 0),
  session_id uuid references "session" (id) on delete cascade,
  user_id uuid references "user" (id) on delete cascade,
  invitation_digest bytea,
  expires_at timestamptz not null,
  check ((intent in ('link', 'reauth')) = (session_id is not null and user_id is not null))
);

create table native_social_pending (
  user_id uuid primary key references "user" (id) on delete cascade,
  provider text not null check (provider = 'google'),
  subject text not null,
  realm_epoch bigint not null,
  configuration_revision bigint not null,
  invitation_digest bytea,
  unique (provider, subject)
);

alter table native_mail_challenge drop constraint native_mail_challenge_purpose_check;
alter table native_mail_challenge add constraint native_mail_challenge_purpose_check
  check (purpose in ('invitation', 'verification', 'password-reset', 'recovery'));

create index native_social_flow_expires_idx on native_social_flow (expires_at);
