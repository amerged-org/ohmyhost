// Pinned copy of Native Auth migration 002; verified before execution.
export const NATIVE_AUTH_SCHEMA_V2_SQL =
  "-- Expand-only: old invitation receipts have no request digest and cannot be replayed.\nalter table native_invitation_accept_receipt\n  add column request_digest bytea check (request_digest is null or octet_length(request_digest) = 32);\n";
