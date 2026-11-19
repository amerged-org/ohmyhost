-- D459: the maintenance sweep reads at most 50 accesses per category per pass across all tenants, and a row it cannot
-- finish (a provider that keeps refusing the role deletion) used to stay at the head of that list forever, so about 50
-- such rows stopped the revocation of every other tenant's expired credential. The sweep now orders by this column
-- first (never tried before tried) and stamps exactly the rows whose attempt failed, so such a row moves behind all
-- rows not yet tried and the rest rotate. A row the pass never reached is not stamped. No data changes: existing rows
-- start unstamped, and the identity guard and the ULID update check of 0401/0603 are untouched because this column is
-- not part of the immutable identity.
ALTER TABLE project_database_access ADD COLUMN sweep_attempted_at TEXT CHECK(sweep_attempted_at IS NULL OR sweep_attempted_at GLOB '????-??-??T??:??:??.??????Z');
