-- W32: retired original Mail balances/ledger are immutable evidence, NOT active credit funds or wallet presence.
-- Only INSERT under the existing exact attested UNACTIVATED historical context may load their original facts.
-- All static/FK/append-only rules stay active. No new marker, writer RPC, inferred balance or data seed.
CREATE TABLE mail_credit_accounts (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 balance_micros INTEGER NOT NULL DEFAULT 0 CHECK(balance_micros>=0),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE mail_credit_ledger (
 entry_id TEXT PRIMARY KEY CHECK(length(entry_id)=26 AND length(CAST(entry_id AS BLOB))=26 AND substr(entry_id,1,1) BETWEEN '0' AND '7' AND entry_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 request_id TEXT CHECK(request_id IS NULL OR(length(request_id)=26 AND length(CAST(request_id AS BLOB))=26 AND substr(request_id,1,1) BETWEEN '0' AND '7' AND request_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 kind TEXT NOT NULL CHECK(kind IN('grant','reserve','release')),
 amount_micros INTEGER NOT NULL CHECK(amount_micros<>0),
 actor_id TEXT NOT NULL CHECK(instr(actor_id,char(0))=0 AND length(actor_id) BETWEEN 1 AND 255),
 occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
 UNIQUE(request_id,kind),
 FOREIGN KEY(organization_id,project_id) REFERENCES mail_credit_accounts(organization_id,project_id),
 FOREIGN KEY(request_id) REFERENCES mail_send_requests(request_id),
 CHECK((kind='grant' AND request_id IS NULL AND amount_micros>0) OR(kind='reserve' AND request_id IS NOT NULL AND amount_micros<0) OR(kind='release' AND request_id IS NOT NULL AND amount_micros>0))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER retired_mail_accounts_readonly_insert BEFORE INSERT ON mail_credit_accounts
WHEN EXISTS(SELECT 1 FROM core_authority_activation) OR NOT EXISTS(
 SELECT 1 FROM core_historical_import context,json_each(context.temporal_tables) family
 WHERE context.closed_at IS NULL AND family.type='text' AND family.value='mail_credit_accounts')
BEGIN SELECT RAISE(ABORT,'retired Mail accounts are read-only');END;
CREATE TRIGGER retired_mail_accounts_readonly_update BEFORE UPDATE ON mail_credit_accounts
BEGIN SELECT RAISE(ABORT,'retired Mail accounts are read-only');END;
CREATE TRIGGER retired_mail_accounts_readonly_delete BEFORE DELETE ON mail_credit_accounts
BEGIN SELECT RAISE(ABORT,'retired Mail accounts are read-only');END;
CREATE TRIGGER retired_mail_ledger_readonly_insert BEFORE INSERT ON mail_credit_ledger
WHEN EXISTS(SELECT 1 FROM core_authority_activation) OR NOT EXISTS(
 SELECT 1 FROM core_historical_import context,json_each(context.temporal_tables) family
 WHERE context.closed_at IS NULL AND family.type='text' AND family.value='mail_credit_ledger')
BEGIN SELECT RAISE(ABORT,'retired Mail ledger is read-only');END;
CREATE TRIGGER mail_credit_ledger_append_only_update BEFORE UPDATE ON mail_credit_ledger
BEGIN SELECT RAISE(ABORT,'Mail credit ledger is append-only');END;
CREATE TRIGGER mail_credit_ledger_append_only_delete BEFORE DELETE ON mail_credit_ledger
BEGIN SELECT RAISE(ABORT,'Mail credit ledger is append-only');END;
-- Compose the already-qualified source/secret context families plus exactly these two retired INSERT exceptions.
-- Native0466 management must retain these names when adding its own original binding family.
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
 SELECT RAISE(ABORT,'an ever-activated authority can never open historical import') WHERE EXISTS(SELECT 1 FROM core_authority_activation);
 SELECT RAISE(ABORT,'historical import begins loading, never already qualified') WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
 SELECT RAISE(ABORT,'historical temporal admission has a closed exact table allowlist')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.temporal_tables) WHERE type<>'text' OR value NOT IN(
 'wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations','operations','environment_data_assignments','mail_credit_accounts','mail_credit_ledger'))
 OR(SELECT count(*) FROM json_each(NEW.temporal_tables))<>(SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;
