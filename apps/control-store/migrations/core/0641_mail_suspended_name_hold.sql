-- A reputation-suspended workspace sender name stays held for every organization while the suspension holds, also after
-- its owner retired the sender. The hold used to apply only inside the owning organization, so a second organization
-- registered the name and skipped the operator-reviewed reinstatement. This sibling trigger refuses a legacy Resend row
-- for such a name in any organization. The pinned mirror trigger of 0466 stays as it is: the import overlay checks its
-- text against that migration. No row, receipt or money value moves.
CREATE TRIGGER resend_mail_domains_suspended_name_hold BEFORE INSERT ON resend_mail_domains WHEN NEW.deleted_at IS NULL
BEGIN
 SELECT RAISE(ABORT,'mail_domain_conflict') WHERE EXISTS(SELECT 1 FROM workspace_mail_domains WHERE domain=NEW.domain AND reputation_state='suspended');
END;
