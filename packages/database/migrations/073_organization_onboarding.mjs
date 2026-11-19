export function up(pgm) {
  pgm.sql(`
    CREATE TABLE organization_onboarding_requests (
      request_id ulid PRIMARY KEY,
      workos_user_id text NOT NULL,
      idempotency_sha256 bytea NOT NULL,
      request_sha256 bytea NOT NULL,
      name text NOT NULL,
      organization_attempted boolean NOT NULL DEFAULT false,
      membership_attempted boolean NOT NULL DEFAULT false,
      workos_organization_id text UNIQUE,
      organization_id ulid REFERENCES workos_organization_mappings(organization_id),
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (workos_user_id,idempotency_sha256),
      CHECK (workos_user_id ~ '^user_[A-Za-z0-9_]+$'
        AND length(workos_user_id)<=128
        AND octet_length(idempotency_sha256)=32 AND octet_length(request_sha256)=32
        AND name=btrim(name) AND length(name) BETWEEN 1 AND 128
        AND (NOT membership_attempted OR workos_organization_id IS NOT NULL)
        AND ((completed_at IS NULL AND organization_id IS NULL)
          OR (completed_at IS NOT NULL AND organization_id IS NOT NULL
            AND workos_organization_id IS NOT NULL)))
    );
  `);
}

export function down(pgm) {
  pgm.dropTable("organization_onboarding_requests");
}
