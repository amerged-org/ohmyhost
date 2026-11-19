CREATE TABLE native_preview_realm_policy (
  preview_id text NOT NULL CHECK (preview_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  auth_generation bigint NOT NULL CHECK (auth_generation > 0),
  enabled boolean NOT NULL,
  revocation_epoch bigint NOT NULL CHECK (revocation_epoch > 0),
  configuration_revision bigint NOT NULL CHECK (configuration_revision > 0),
  PRIMARY KEY (preview_id, auth_generation)
);