/**
 * AWS exit (owner authorization 2026-09-24): the platform no longer calls SES or Route 53. A
 * project's historical SES tenant, configuration set, event destination, identity, hosted zone and
 * DKIM records stay as receipts. An operator appends the observed absence of each such resource
 * after deleting it and reading the deletion back; project deletion then reports exactly those
 * receipts as absent instead of asking a removed provider. The Control runtime may only read.
 */
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE legacy_aws_mail_absence (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    resource_kind text NOT NULL CHECK (resource_kind IN ('ses-tenant','ses-configuration-set',
      'ses-event-destination','ses-identity','route53-hosted-zone','route53-dkim-record')),
    locator text NOT NULL CHECK (length(locator) BETWEEN 1 AND 1024),
    observed_at timestamptz NOT NULL,
    evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256)=32),
    recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 256),
    recorded_at timestamptz NOT NULL CHECK (recorded_at>=observed_at),
    PRIMARY KEY (project_id,resource_kind,locator),
    FOREIGN KEY (organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id)
  )`);
  pgm.createTrigger("legacy_aws_mail_absence", "legacy_aws_mail_absence_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON legacy_aws_mail_absence FROM control_runtime;
      GRANT SELECT ON legacy_aws_mail_absence TO control_runtime;
    END IF;
  END $$`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM legacy_aws_mail_absence) THEN
      RAISE EXCEPTION 'Observed AWS absence evidence must be retained';
    END IF;
  END $$`);
  pgm.dropTable("legacy_aws_mail_absence");
}
