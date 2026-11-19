-- SHARED CORE authority database (binding CONTROL_CORE, layout shared-core-v1). One D1 database per environment holds the
-- authoritative Directory, every mutable Control catalog and the finance ledger.
--
-- What this layout guarantees, and what each guarantee is tested by (test/core-layout.test.ts and the named tests):
--   * Lineage: 0101..0190 carry the Directory objects and 0201..0290 the tenant objects of the original separate schemas
--     (migrations/directory, migrations/shard) with identical DDL, except the objects named in core-layout.test.ts as
--     replaced (guard_fail, command_log, shards, shard_buckets), changed (projects, billing_epochs_one_open_per_project and the
--     environment parent of credit_holds / usage_sources / metering_cohort_work) or added (0001, 0300, 0310).
--   * Ownership history and one current owner per project: 0300 (test/ownership-history.test.ts, FKs enforced).
--   * Global economic identities (grant / hold / valuation / paid period): 0310 (test/global-identity.test.ts).
--   * One batch for the commands that were one PostgreSQL transaction AND needed both former databases: ONLY
--     projects.createInitialProject, identity.applyWorkosSnapshot and domains.claimCloudflareProjectDomainsOperation have been
--     composed into one batch and tested for late-failure rollback. Every other Directory + tenant sequence (for example the
--     PGCF database claim reserve/confirm of database/provider-targets) keeps its original separate statements and is NOT
--     qualified as atomic by this layout.
-- The 1024 bucket identities remain as routing METADATA for future derived fact shards; they never route money,
-- authentication or operations.

-- The layout record a Worker verifies before it serves a single command: a database that is not this layout is refused.
CREATE TABLE core_layout (
  singleton                 INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  layout                    TEXT    NOT NULL CHECK (layout = 'shared-core-v1'),
  command_namespace_version INTEGER NOT NULL CHECK (command_namespace_version = 1)
) STRICT;
INSERT INTO core_layout(singleton, layout, command_namespace_version) VALUES (1, 'shared-core-v1', 1);

-- guard_fail never holds a row: inserting one aborts the whole D1 batch with "CHECK constraint failed: guard_<code>".
-- ONE catalog for the Directory and tenant commands: the union of every code either original catalog carried (both carried
-- the same fourteen), pinned against GUARD_CODES by test/core-layout.test.ts. A new code needs a migration that recreates this
-- always-empty table.
CREATE TABLE guard_fail (
  code TEXT NOT NULL,
  CONSTRAINT guard_row_version_conflict CHECK (code <> 'row_version_conflict'),
  CONSTRAINT guard_claim_lost CHECK (code <> 'claim_lost'),
  CONSTRAINT guard_operation_conflict CHECK (code <> 'operation_conflict'),
  CONSTRAINT guard_owner_changed CHECK (code <> 'owner_changed'),
  CONSTRAINT guard_insufficient_credits CHECK (code <> 'insufficient_credits'),
  CONSTRAINT guard_wallet_version_conflict CHECK (code <> 'wallet_version_conflict'),
  CONSTRAINT guard_source_head_conflict CHECK (code <> 'source_head_conflict'),
  CONSTRAINT guard_scope_inactive CHECK (code <> 'scope_inactive'),
  CONSTRAINT guard_consent_changed CHECK (code <> 'consent_changed'),
  CONSTRAINT guard_organization_inactive CHECK (code <> 'organization_inactive'),
  CONSTRAINT guard_attribution_conflict CHECK (code <> 'attribution_conflict'),
  CONSTRAINT guard_environment_set_invalid CHECK (code <> 'environment_set_invalid'),
  CONSTRAINT guard_bucket_fenced CHECK (code <> 'bucket_fenced'),
  -- Platform contexts H to L: a fact the decision read no longer holds, so the snapshot is stale.
  CONSTRAINT guard_precondition_changed CHECK (code <> 'precondition_changed'),
  -- Declared last, so a registered code always fails on its own named constraint above. A code nobody registered still
  -- aborts the batch (a guard that merely inserted a row would let the write through), as `guard_unregistered`.
  CONSTRAINT guard_unregistered CHECK (length(code) < 0)
) STRICT;

-- Exactly-once identity of commands that have no natural unique key. ONE namespace for the former Directory and tenant
-- commands: a command id reused by a different command name or input is an idempotency conflict (never a second effect).
CREATE TABLE command_log (
  command_id TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  digest     TEXT NOT NULL,
  result     TEXT NOT NULL CHECK (json_valid(result)),
  applied_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- The logical partition registry. The shared core is exactly one partition: shard id 0, no other authority exists.
-- Doorbells and sweepers address work by (kind, shard_id), so the id stays; the physical database id is a release-time
-- resource fact and is never stored here.
CREATE TABLE shards (
  shard_id   INTEGER NOT NULL PRIMARY KEY CHECK (shard_id = 0),
  binding    TEXT    NOT NULL UNIQUE CHECK (binding = 'CONTROL_CORE'),
  state      TEXT    NOT NULL CHECK (state = 'live')
) STRICT;
INSERT INTO shards(shard_id, binding, state) VALUES (0, 'CONTROL_CORE', 'live');

-- 1024 fixed hash buckets: routing metadata of every organization (`org_directory.bucket`, `organizations.bucket`), kept for
-- future derived fact routing. Every bucket maps to the one core partition.
CREATE TABLE shard_buckets (
  bucket    INTEGER NOT NULL PRIMARY KEY CHECK (bucket BETWEEN 0 AND 1023),
  shard_id  INTEGER NOT NULL REFERENCES shards (shard_id),
  state     TEXT    NOT NULL DEFAULT 'live' CHECK (state = 'live')
) STRICT;
INSERT INTO shard_buckets(bucket, shard_id, state)
  WITH RECURSIVE numbers(bucket) AS (SELECT 0 UNION ALL SELECT bucket + 1 FROM numbers WHERE bucket < 1023)
  SELECT bucket, 0, 'live' FROM numbers;
