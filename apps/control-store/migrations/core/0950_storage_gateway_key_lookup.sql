-- RTG-12: every storage gateway request authenticates by project, environment and key digest. The primary key of
-- storage_gateway_keys leads with organization_id, which that lookup does not bind, so the lookup and the cross-environment
-- reuse check scanned the whole table. This index serves the lookup by equality and the reuse check by its project and
-- digest prefix; the append-only triggers are unchanged.
CREATE INDEX storage_gateway_keys_project_digest ON storage_gateway_keys (project_id, key_sha256, environment_id);
