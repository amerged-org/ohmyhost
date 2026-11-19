-- The sweeper stamps when it last tried each pending runtime-secret scope. A scope that fails before its claim leaves
-- no other trace, so without this stamp it would keep the head of the shared batch. Nullable: a scope never tried yet
-- sorts first, and no existing row changes.
ALTER TABLE runtime_secret_delivery_states ADD COLUMN last_attempted_at TEXT
  CHECK(last_attempted_at IS NULL OR last_attempted_at GLOB '????-??-??T??:??:??.??????Z');
