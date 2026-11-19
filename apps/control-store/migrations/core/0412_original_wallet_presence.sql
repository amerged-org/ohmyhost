-- Original182 creates the original wallet as part of organization INSERT; a missing wallet is an invariant failure.
-- Historical loading records only captured original wallet rows, never presence inferred from0395's technical seed.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE control_source_wallet_presence (
  organization_id TEXT NOT NULL PRIMARY KEY,
  FOREIGN KEY(organization_id) REFERENCES credit_wallets(organization_id) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;
CREATE TRIGGER control_source_wallet_presence_no_update BEFORE UPDATE ON control_source_wallet_presence
BEGIN SELECT RAISE(ABORT,'original wallet presence is append-only'); END;
CREATE TRIGGER control_source_wallet_presence_no_delete BEFORE DELETE ON control_source_wallet_presence
BEGIN SELECT RAISE(ABORT,'original wallet presence is append-only'); END;
-- SQLite AFTER-trigger order is deliberately irrelevant:0395 must supply the physical wallet before COMMIT.
-- This new provenance writer is quiet ONLY while the exact unserved capture loader supplies explicit source facts;
-- no existing seed, integrity, financial or admission guard is disabled or given a loading exception.
CREATE TRIGGER organizations_original_wallet_presence AFTER INSERT ON organizations
WHEN NOT EXISTS(SELECT 1 FROM core_historical_import WHERE closed_at IS NULL)
BEGIN INSERT INTO control_source_wallet_presence(organization_id) VALUES(NEW.organization_id); END;
