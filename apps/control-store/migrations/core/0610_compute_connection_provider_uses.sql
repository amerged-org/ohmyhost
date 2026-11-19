-- Bounded, connection-attributed provider use; disconnect reports pending until release or expiry.
CREATE TABLE compute_connection_provider_uses (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  lease_until TEXT NOT NULL CHECK (lease_until GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id,project_id,operation_id),
  FOREIGN KEY (organization_id,operation_id) REFERENCES operations(organization_id,operation_id)
) STRICT, WITHOUT ROWID;
