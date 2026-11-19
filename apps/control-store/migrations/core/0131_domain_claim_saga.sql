-- core-v1 source: migrations/directory/0031_domain_claim_saga.sql
-- A globally unique name is claimed by a resumable saga (core-model 5.5): reserve in this directory, write the truth in the shard, confirm here.
-- Existing rows are confirmed claims, so they take the defaults. claim_id is the stable id of the claiming command (identical on every retry);
-- expires_at bounds a reservation whose command never reached its shard write. The sweep settles only reserved rows past expires_at.
ALTER TABLE domain_directory ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('reserved', 'active'));
ALTER TABLE domain_directory ADD COLUMN claim_id TEXT CHECK (claim_id IS NULL OR length(claim_id) BETWEEN 1 AND 128);
ALTER TABLE domain_directory ADD COLUMN expires_at TEXT CHECK (expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??.??????Z');
CREATE INDEX domain_directory_reserved ON domain_directory (expires_at) WHERE state = 'reserved';
