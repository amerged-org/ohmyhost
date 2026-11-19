-- Original148 has ONE mutable sealed link per global project. Rotation receipts reference that
-- project identity, not the link's mutable current organization. Retain the Core-only historical
-- rotation organization attribution byte-for-byte when a legitimate new sealed link rehomes.
-- Initial UNSERVED construction only. A duplicate prototype project/token/rotation key refuses
-- this entire schema batch; no row is deduplicated, relabelled or assigned a replacement identity.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE _0506_dev_share_link_rotations AS SELECT * FROM dev_share_link_rotations;
DROP TABLE dev_share_link_rotations;
CREATE TABLE _0506_dev_share_links AS SELECT * FROM dev_share_links;
DROP TABLE dev_share_links;
CREATE TABLE dev_share_links (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL PRIMARY KEY CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 token_sha256 BLOB NOT NULL UNIQUE CHECK(length(token_sha256)=32),
 ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 17 AND 5120),
 nonce BLOB NOT NULL CHECK(length(nonce)=12),
 key_version INTEGER NOT NULL CHECK(key_version BETWEEN 1 AND 2147483647),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
 UNIQUE(organization_id,project_id),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
) STRICT, WITHOUT ROWID;
CREATE TABLE dev_share_link_rotations (
 -- Preserved capture attribution only; it is deliberately NOT the mutable link's parent key.
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 key_sha256 BLOB NOT NULL CHECK(length(key_sha256)=32),
 generation INTEGER NOT NULL CHECK(generation>=1),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(project_id,key_sha256),
 FOREIGN KEY(project_id) REFERENCES dev_share_links(project_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX dev_share_link_rotations_purge ON dev_share_link_rotations(created_at);
INSERT INTO dev_share_links SELECT * FROM _0506_dev_share_links;
INSERT INTO dev_share_link_rotations SELECT * FROM _0506_dev_share_link_rotations;
DROP TABLE _0506_dev_share_link_rotations;
DROP TABLE _0506_dev_share_links;

-- Retain the qualified0502 inventory names and exact original static parent predicates.
CREATE UNIQUE INDEX dev_share_links_original_global_identity ON dev_share_links(project_id);
CREATE TRIGGER dev_share_links_original_static_parent_insert BEFORE INSERT ON dev_share_links
WHEN NOT EXISTS(SELECT 1 FROM environments parent WHERE parent.organization_id=NEW.organization_id AND parent.project_id=NEW.project_id AND parent.environment_id=NEW.environment_id)
BEGIN SELECT RAISE(ABORT,'Original dev_share_links static parent differs'); END;
CREATE TRIGGER dev_share_links_original_static_parent_update BEFORE UPDATE ON dev_share_links
WHEN NOT EXISTS(SELECT 1 FROM environments parent WHERE parent.organization_id=NEW.organization_id AND parent.project_id=NEW.project_id AND parent.environment_id=NEW.environment_id)
BEGIN SELECT RAISE(ABORT,'Original dev_share_links static parent differs'); END;
