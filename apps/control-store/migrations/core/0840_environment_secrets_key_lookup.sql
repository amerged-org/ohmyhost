-- Gateway key lookups (mail send, mail receive and the AI gateway) filter environment_secrets by project, name and
-- digest, without the organization. The primary key leads with organization_id, so each request scanned every
-- tenant's secret rows, and the duplicate-key count scanned them again. This index serves both predicates.
CREATE INDEX environment_secrets_key_lookup ON environment_secrets (project_id, name, value_sha256);
