-- core-v1 source: migrations/shard/0053_measure_effects.sql
-- A measured posting is a financial fact of its own (Q2-B): the cumulative target a source was valued at, the
-- delta it posted and the funded part. Its archive intent joins the immutable effect outbox as kind 'measure', next
-- to the reserve/settle or refund effects of the lots it moved. The table is recreated (SQLite cannot alter a
-- CHECK) with every existing row copied; it carries no foreign key.
CREATE TABLE credit_effects_v3 (
  organization_id TEXT NOT NULL,
  effect_id       TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 192),
  effect_kind     TEXT NOT NULL CHECK (effect_kind IN ('grant', 'reserve', 'settle', 'release', 'refund', 'adjust', 'measure')),
  occurred_at     TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  payload         TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  archived_at     TEXT CHECK (archived_at IS NULL OR archived_at GLOB '????-??-??T??:??:??.??????Z'),
  archive_key     TEXT,
  archive_sha256  TEXT CHECK (archive_sha256 IS NULL OR (length(archive_sha256) = 64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (organization_id, effect_id),
  CHECK ((archived_at IS NULL) = (archive_key IS NULL) AND (archived_at IS NULL) = (archive_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO credit_effects_v3 SELECT organization_id, effect_id, effect_kind, occurred_at, payload, archived_at, archive_key, archive_sha256 FROM credit_effects;
DROP TABLE credit_effects;
ALTER TABLE credit_effects_v3 RENAME TO credit_effects;
CREATE INDEX credit_effects_unarchived ON credit_effects (organization_id, occurred_at) WHERE archived_at IS NULL;
CREATE INDEX credit_effects_archived ON credit_effects (organization_id, archived_at) WHERE archived_at IS NOT NULL;
CREATE TRIGGER credit_effects_immutable BEFORE UPDATE OF organization_id, effect_id, effect_kind, occurred_at, payload ON credit_effects
BEGIN SELECT RAISE(ABORT, 'credit_effects is append-only'); END;
CREATE TRIGGER credit_effects_archive_once BEFORE UPDATE OF archived_at, archive_key, archive_sha256 ON credit_effects WHEN OLD.archived_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'credit_effects archive pointer is written once'); END;
CREATE TRIGGER credit_effects_delete_only_archived BEFORE DELETE ON credit_effects WHEN OLD.archived_at IS NULL
BEGIN SELECT RAISE(ABORT, 'credit_effects rows are deletable only after archive'); END;
