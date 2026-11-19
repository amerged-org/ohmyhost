-- Existing candidate receipts retain NULL; the existing append-only trigger also protects this column.
ALTER TABLE wfp_candidate_receipts ADD COLUMN binding_set_digest BLOB
  CHECK(binding_set_digest IS NULL OR length(binding_set_digest)=32);
