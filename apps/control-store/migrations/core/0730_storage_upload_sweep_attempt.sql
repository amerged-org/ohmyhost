-- The platform upload sweep reads at most 50 unconfirmed claims a day old, oldest first. A claim it cannot erase (a provider
-- that keeps refusing the erasure, or a locator it cannot observe) used to stay at the head of that list forever, so about
-- 50 such claims stopped the erasure of every other abandoned upload. The sweep now stamps each claim it tried and did not
-- erase here, and lists the claims never tried first, then the least recently tried. The reservation table is immutable
-- (0492 triggers), so the stamp lives in its own table. It is not part of the claim identity and never decides erasure.
-- The erasure of a claim deletes its stamp in the same batch, so no stamp outlives its claim.
-- No data changes: existing claims start unstamped, and the sweep lists them as it did before.
CREATE TABLE project_r2_upload_sweep_attempts (
  transfer_id  TEXT NOT NULL PRIMARY KEY REFERENCES project_r2_upload_reservations(transfer_id),
  attempted_at TEXT NOT NULL CHECK (attempted_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
