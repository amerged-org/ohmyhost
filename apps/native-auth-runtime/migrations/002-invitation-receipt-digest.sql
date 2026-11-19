-- Expand-only: old invitation receipts have no request digest and cannot be replayed.
alter table native_invitation_accept_receipt
  add column request_digest bytea check (request_digest is null or octet_length(request_digest) = 32);
