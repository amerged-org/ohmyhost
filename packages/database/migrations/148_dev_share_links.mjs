export function up(pgm) {
  pgm.sql(`ALTER TABLE projects
    ADD COLUMN dev_access_mode text NOT NULL DEFAULT 'protected',
    ADD CONSTRAINT projects_dev_access_mode_check
      CHECK (dev_access_mode IN ('protected', 'public'))`);

  pgm.sql(`CREATE TABLE dev_share_links (
    project_id ulid PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    organization_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    token_sha256 bytea NOT NULL UNIQUE,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    key_version integer NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT dev_share_links_environment_fkey
      FOREIGN KEY (organization_id, project_id, environment_id)
      REFERENCES environments(organization_id, project_id, environment_id),
    CONSTRAINT dev_share_links_shape_check CHECK (
      octet_length(token_sha256)=32
      AND octet_length(ciphertext) BETWEEN 17 AND 5120
      AND octet_length(nonce)=12
      AND key_version>0
      AND generation>=1
      AND (revoked_at IS NULL OR revoked_at>=created_at)
    )
  )`);
  pgm.sql(`CREATE TABLE dev_share_link_rotations (
    project_id ulid NOT NULL REFERENCES dev_share_links(project_id) ON DELETE CASCADE,
    key_sha256 bytea NOT NULL CHECK (octet_length(key_sha256)=32),
    generation bigint NOT NULL CHECK (generation>=1),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (project_id,key_sha256)
  )`);
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT(dev_access_mode),UPDATE(dev_access_mode) ON projects TO control_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON dev_share_links TO control_runtime;
      GRANT SELECT,INSERT ON dev_share_link_rotations TO control_runtime;
    END IF;
  END $$`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM projects WHERE dev_access_mode <> 'protected')
      OR EXISTS (SELECT 1 FROM dev_share_links WHERE revoked_at IS NULL) THEN
      RAISE EXCEPTION 'active Dev sharing state prevents a lossless downgrade';
    END IF;
  END $$`);
  pgm.sql(`DROP TABLE dev_share_link_rotations`);
  pgm.sql(`DROP TABLE dev_share_links`);
  pgm.sql(`ALTER TABLE projects
    DROP CONSTRAINT projects_dev_access_mode_check,
    DROP COLUMN dev_access_mode`);
}
