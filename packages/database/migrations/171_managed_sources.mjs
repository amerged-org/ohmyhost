const gitShape = `provider='github' AND permission='contents:read' AND github_installation_id IS NOT NULL
  AND github_installation_id~'^[1-9][0-9]{0,19}$'
  AND external_repository_id~'^[1-9][0-9]{0,15}$'
  AND repository_owner~'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
  AND repository_name=btrim(repository_name) AND length(repository_name) BETWEEN 1 AND 100`;
const archiveShape = (managed) => `
  (${managed ? "(provider='managed' AND external_repository_id~'^[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$') OR " : ""}
    (provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$'
     AND CASE WHEN external_repository_id~'^[1-9][0-9]{0,15}$' THEN external_repository_id::numeric<=9007199254740991 ELSE false END))
  AND requested_commit_sha~'^[0-9a-f]{40}$' AND requested_commit_sha<>repeat('0',40)
  AND resolved_commit_sha=requested_commit_sha AND archive_format='tar.gz'
  AND octet_length(sha256)=32 AND byte_length BETWEEN 1 AND 9007199254740991
  AND ((object_ref~'^archive_[0-7][0-9A-HJKMNP-TV-Z]{25}_[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    AND split_part(object_ref,'_',2)=operation_id::text)
    OR (length(object_ref)<=512 AND object_ref~'^r2-version:ohmyho-builds-(development|production)(-eu)?/[^?#[:space:]]+#[0-9a-f]{32}$'))`;

export function up(pgm) {
  pgm.sql(`
    CREATE TABLE source_connections (
      source_connection_id ulid PRIMARY KEY, organization_id ulid NOT NULL,
      project_id ulid NOT NULL, billing_epoch_id ulid NOT NULL,
      provider text NOT NULL CHECK(provider IN ('github','managed')),
      external_repository_id text NOT NULL, created_at timestamptz NOT NULL,
      UNIQUE(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id),
      UNIQUE(organization_id,project_id,source_connection_id),
      UNIQUE(organization_id,project_id,source_connection_id,provider),
      FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id)
    );
    INSERT INTO source_connections SELECT source_connection_id,organization_id,project_id,billing_epoch_id,provider,external_repository_id,created_at FROM github_source_connections;
    CREATE TRIGGER source_connections_immutable BEFORE UPDATE OR DELETE ON source_connections FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE FUNCTION register_github_source_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO source_connections VALUES(NEW.source_connection_id,NEW.organization_id,NEW.project_id,NEW.billing_epoch_id,NEW.provider,NEW.external_repository_id,NEW.created_at);
      RETURN NEW; END $$;
    CREATE TRIGGER github_source_connection_register AFTER INSERT ON github_source_connections FOR EACH ROW EXECUTE FUNCTION register_github_source_connection();
    ALTER TABLE repository_grants DROP CONSTRAINT repository_grants_source_connection_fkey;
    ALTER TABLE repository_grants ADD CONSTRAINT repository_grants_source_connection_fkey FOREIGN KEY(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id) REFERENCES source_connections(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id);
    ALTER TABLE source_archives DROP CONSTRAINT source_archives_source_connection_fkey;
    ALTER TABLE source_archives ADD CONSTRAINT source_archives_source_connection_fkey FOREIGN KEY(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id) REFERENCES source_connections(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id);
    ALTER TABLE repository_grants ALTER COLUMN github_installation_id DROP NOT NULL;
    ALTER TABLE project_sources ALTER COLUMN installation_id DROP NOT NULL;
    ALTER TABLE repository_grants DROP CONSTRAINT repository_grants_shape_check;
    ALTER TABLE repository_grants ADD CONSTRAINT repository_grants_shape_check CHECK((${gitShape}) OR
      (provider='managed' AND permission='contents:read' AND github_installation_id IS NULL
       AND repository_owner~'^[A-Za-z0-9_-]{1,128}$' AND repository_name~'^[A-Za-z0-9_-]{1,128}$'
       AND external_repository_id=repository_owner||'/'||repository_name));
    ALTER TABLE project_sources DROP CONSTRAINT project_sources_check;
    ALTER TABLE project_sources ADD CONSTRAINT project_sources_check CHECK(provider IN ('github','managed') AND state IN ('pending','ready','failed','revoked') AND revision>0 AND updated_at>=created_at
      AND ((provider='github' AND installation_id IS NOT NULL) OR (provider='managed' AND installation_id IS NULL))
      AND ((state='failed' AND failure_code IS NOT NULL) OR (state<>'failed' AND failure_code IS NULL)));
    ALTER TABLE source_archives DROP CONSTRAINT source_archives_content_check;
    ALTER TABLE source_archives ADD CONSTRAINT source_archives_content_check CHECK(${archiveShape(true)});

    CREATE TABLE managed_source_repositories (
      source_connection_id ulid PRIMARY KEY, organization_id ulid NOT NULL, project_id ulid NOT NULL,
      billing_epoch_id ulid NOT NULL, namespace text NOT NULL CHECK(namespace~'^[A-Za-z0-9_-]{1,128}$'),
      repository_name text NOT NULL CHECK(repository_name~'^[A-Za-z0-9_-]{1,128}$'), created_at timestamptz NOT NULL,
      UNIQUE(namespace,repository_name), UNIQUE(organization_id,project_id,source_connection_id),
      FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id)
    );
    CREATE TRIGGER managed_source_repositories_immutable BEFORE UPDATE OR DELETE ON managed_source_repositories FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TABLE project_source_bindings (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, source_connection_id ulid NOT NULL,
      provider text NOT NULL CHECK(provider IN ('github','managed')), generation integer NOT NULL CHECK(generation>0),
      commit_sha text CHECK(commit_sha~'^[0-9a-f]{40}$' AND commit_sha<>repeat('0',40)), updated_at timestamptz NOT NULL,
      PRIMARY KEY(organization_id,project_id), FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES source_connections(organization_id,project_id,source_connection_id),
      CHECK(provider='github' OR commit_sha IS NOT NULL)
    );
    ALTER TABLE project_source_bindings ADD CONSTRAINT project_source_bindings_provider_fkey FOREIGN KEY(organization_id,project_id,source_connection_id,provider) REFERENCES source_connections(organization_id,project_id,source_connection_id,provider);
    INSERT INTO project_source_bindings SELECT DISTINCT ON(source.organization_id,source.project_id)
      source.organization_id,source.project_id,grant_record.source_connection_id,'github',source.revision,NULL,source.updated_at
      FROM project_sources source JOIN repository_grants grant_record USING(organization_id,project_id,grant_id)
      WHERE source.state='ready' ORDER BY source.organization_id,source.project_id,source.updated_at DESC,source.source_id DESC;
    CREATE TABLE managed_source_publications (
      operation_id ulid PRIMARY KEY REFERENCES operations(operation_id), organization_id ulid NOT NULL,
      project_id ulid NOT NULL, billing_epoch_id ulid NOT NULL, principal_id text NOT NULL,
      source_connection_id ulid NOT NULL, mode text NOT NULL CHECK(mode IN ('initialize','commit','switch')),
      delegation_grant_id uuid, delegation_client_id text, delegation_consent_sha256 text,
      expected_source_connection_id ulid, expected_source_generation integer NOT NULL CHECK(expected_source_generation>=0),
      expected_managed_commit text CHECK(expected_managed_commit~'^[0-9a-f]{40}$'),
      state text NOT NULL CHECK(state IN ('staging','sealed','committed','failed')),
      message text NOT NULL CHECK(length(message) BETWEEN 1 AND 1024),
      manifest_sha256 text CHECK(manifest_sha256~'^[0-9a-f]{64}$'), manifest jsonb,
      commit_sha text CHECK(commit_sha~'^[0-9a-f]{40}$' AND commit_sha<>repeat('0',40)),
      tree_sha text CHECK(tree_sha~'^[0-9a-f]{40}$' AND tree_sha<>repeat('0',40)), error_code text,
      created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>created_at), updated_at timestamptz NOT NULL,
      FOREIGN KEY(organization_id,project_id,operation_id,billing_epoch_id) REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
      FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES managed_source_repositories(organization_id,project_id,source_connection_id),
      CHECK((manifest IS NULL)=(manifest_sha256 IS NULL)), CHECK((commit_sha IS NULL)=(tree_sha IS NULL)),
      CHECK((delegation_grant_id IS NULL AND delegation_client_id IS NULL AND delegation_consent_sha256 IS NULL)
        OR (delegation_grant_id IS NOT NULL AND delegation_client_id IS NOT NULL AND delegation_consent_sha256~'^[0-9a-f]{64}$')),
      CHECK((state='failed')=(error_code IS NOT NULL)), CHECK(state<>'committed' OR (manifest IS NOT NULL AND commit_sha IS NOT NULL)),
      CHECK((mode='initialize' AND expected_source_connection_id IS NULL AND expected_source_generation=0 AND expected_managed_commit IS NULL)
        OR (mode='switch' AND expected_source_connection_id IS NOT NULL AND expected_source_generation>0 AND expected_managed_commit IS NULL)
        OR (mode='commit' AND expected_source_connection_id=source_connection_id AND expected_source_generation>0 AND expected_managed_commit IS NOT NULL))
    );
    CREATE TABLE managed_source_blobs (
      operation_id ulid NOT NULL REFERENCES managed_source_publications(operation_id), path text NOT NULL,
      sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'), byte_length bigint NOT NULL CHECK(byte_length BETWEEN 0 AND 2097152), executable boolean NOT NULL,
      bucket text NOT NULL, object_key text NOT NULL, version_id text NOT NULL CHECK(version_id~'^[0-9a-f]{32}$'), etag text NOT NULL,
      created_at timestamptz NOT NULL, PRIMARY KEY(operation_id,path)
    );
    CREATE TRIGGER managed_source_blobs_immutable BEFORE UPDATE OR DELETE ON managed_source_blobs FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM managed_source_repositories) OR EXISTS(SELECT 1 FROM managed_source_publications)
    OR EXISTS(SELECT 1 FROM source_connections WHERE provider='managed') THEN
    RAISE EXCEPTION 'Managed source history prevents a lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TABLE managed_source_blobs,managed_source_publications,project_source_bindings,managed_source_repositories;
    ALTER TABLE repository_grants DROP CONSTRAINT repository_grants_source_connection_fkey;
    ALTER TABLE repository_grants ADD CONSTRAINT repository_grants_source_connection_fkey FOREIGN KEY(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id) REFERENCES github_source_connections(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id);
    ALTER TABLE source_archives DROP CONSTRAINT source_archives_source_connection_fkey;
    ALTER TABLE source_archives ADD CONSTRAINT source_archives_source_connection_fkey FOREIGN KEY(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id) REFERENCES github_source_connections(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id);
    DROP TRIGGER github_source_connection_register ON github_source_connections;
    DROP FUNCTION register_github_source_connection(); DROP TABLE source_connections;
    ALTER TABLE repository_grants ALTER COLUMN github_installation_id SET NOT NULL;
    ALTER TABLE project_sources ALTER COLUMN installation_id SET NOT NULL;
    ALTER TABLE repository_grants DROP CONSTRAINT repository_grants_shape_check;
    ALTER TABLE repository_grants ADD CONSTRAINT repository_grants_shape_check CHECK(${gitShape});
    ALTER TABLE project_sources DROP CONSTRAINT project_sources_check;
    ALTER TABLE project_sources ADD CONSTRAINT project_sources_check CHECK(provider='github' AND state IN ('pending','ready','failed','revoked') AND revision>0 AND updated_at>=created_at AND ((state='failed' AND failure_code IS NOT NULL) OR (state<>'failed' AND failure_code IS NULL)));
    ALTER TABLE source_archives DROP CONSTRAINT source_archives_content_check;
    ALTER TABLE source_archives ADD CONSTRAINT source_archives_content_check CHECK(${archiveShape(false)});
  `);
}
