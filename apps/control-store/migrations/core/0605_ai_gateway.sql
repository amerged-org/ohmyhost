-- AI gateway: the reservations the gateway admitted, marked when they are admitted in the same batch as their credit
-- reservation. The sweep finds an orphaned call here, so a rotated credit log never hides one. A marker without an open
-- credit reservation is a resolved call and is removed by the sweep.
CREATE TABLE ai_gateway_reservations (
  reservation_id  TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  environment_id  TEXT NOT NULL,
  created_at      TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT;
