// D249/D251: the customer build runs in a Cloudflare build sandbox and keeps its source and its
// bundle in R2. The build tables of migrations 007-009, 011, 018 and 082 lose their provider
// names, the measured usage records the build runner instead of a CodeBuild ARN, and a stored
// object version reference carries the prefix `r2-version:`.
//
// Owner decision (development mode, every customer project is deleted): the build history of
// deleted and deleting projects is removed instead of being rewritten. What a retained row
// references stays: a source upload that a build execution points at (the deployment history
// and the script lifetime billing evidence hang on that execution) keeps its row and its parts.
// The credit ledger is untouched: no ledger table references a build table, and the reservation
// kind is free text, so the historical kind `codebuild` stays valid next to the new `build`.
const RENAMED_TABLES = [
  ["aws_source_uploads", "build_source_uploads"],
  ["aws_source_upload_parts", "build_source_upload_parts"],
  ["aws_build_receipts", "build_receipts"],
  ["aws_build_input_reservations", "build_input_reservations"],
];
const PROJECT_NAME_TABLES = ["build_receipts", "build_executions"];

const SOURCE_ARCHIVE_CONSTRAINT = "source_archives_content_check";
const sourceArchiveCheck = (versionReference) =>
  `provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND external_repository_id::numeric<=9007199254740991 AND requested_commit_sha~'^[0-9a-f]{40}$' AND requested_commit_sha<>repeat('0',40) AND resolved_commit_sha=requested_commit_sha AND archive_format='tar.gz' AND octet_length(sha256)=32 AND byte_length BETWEEN 1 AND 9007199254740991 AND ((object_ref~'^archive_[0-7][0-9A-HJKMNP-TV-Z]{25}_[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND split_part(object_ref,'_',2)=operation_id::text) OR (length(object_ref)<=512 AND object_ref~'${versionReference}'))`;
const S3_VERSION_REFERENCE =
  "^s3-version:[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#[:space:]]+#[A-Za-z0-9._~!%()*+,-]{1,128}$";
// An R2 object version is 32 lowercase hexadecimal characters.
const R2_VERSION_REFERENCE =
  "^r2-version:ohmyho-builds-(development|production)/[^?#[:space:]]+#[0-9a-f]{32}$";

const reservationGuard = (reservations, receipts) => `
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION '${reservations} is append-only'
          USING ERRCODE='55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ${receipts} receipt
        WHERE receipt.organization_id=OLD.organization_id
          AND receipt.project_id=OLD.project_id
          AND receipt.environment_id=OLD.environment_id
          AND receipt.operation_id=OLD.operation_id
      ) OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.start_allowed_until IS DISTINCT FROM OLD.start_allowed_until
        OR NEW.claim_id=OLD.claim_id
        OR OLD.lease_expires_at>NEW.claimed_at
        OR NEW.claimed_at<=OLD.claimed_at
        OR NEW.lease_expires_at<=OLD.lease_expires_at
        OR NEW.attempt_number<>OLD.attempt_number+1
        OR (OLD.claim_mode='observe' AND NEW.claim_mode<>'observe')
        OR (NEW.claim_mode='start' AND NEW.claimed_at>=NEW.start_allowed_until) THEN
        RAISE EXCEPTION '${reservations} permits only expired claim renewal'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END
  `;

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM projects project WHERE project.lifecycle_state='active' AND (
        EXISTS (SELECT 1 FROM aws_source_uploads build WHERE build.project_id=project.project_id)
        OR EXISTS (SELECT 1 FROM aws_build_receipts build WHERE build.project_id=project.project_id)
        OR EXISTS (SELECT 1 FROM aws_build_input_reservations build
          WHERE build.project_id=project.project_id)
        OR EXISTS (SELECT 1 FROM aws_build_usage build WHERE build.project_id=project.project_id)
        OR EXISTS (SELECT 1 FROM source_archives archive
          WHERE archive.project_id=project.project_id AND archive.object_ref LIKE 's3-version:%')))
    THEN RAISE EXCEPTION 'build history of an active project prevents the provider-neutral build tables'
      USING ERRCODE='23514'; END IF; END $$`);

  // The guard above leaves only rows of deleted and deleting projects.
  pgm.dropTable("aws_build_usage");
  purge(pgm, "aws_build_receipts", "aws_build_receipts_append_only");
  purge(pgm, "aws_build_input_reservations", "aws_build_input_reservations_renewal_guard");
  const unreferencedUpload = `NOT EXISTS (
    SELECT 1 FROM build_executions build WHERE build.source_upload_id=upload.upload_id)`;
  purge(
    pgm,
    "aws_source_upload_parts",
    "aws_source_upload_parts_append_only",
    `upload_id IN (SELECT upload.upload_id FROM aws_source_uploads upload WHERE ${unreferencedUpload})`,
  );
  pgm.sql(`DELETE FROM aws_source_uploads upload WHERE ${unreferencedUpload}`);
  purge(pgm, "source_archives", "source_archives_append_only", "object_ref LIKE 's3-version:%'");

  for (const [from, to] of RENAMED_TABLES) renameTable(pgm, from, to);
  for (const table of PROJECT_NAME_TABLES) {
    pgm.renameColumn(table, "codebuild_project_name", "build_project_name");
    renameOwnNames(pgm, table, "codebuild_project_name", "build_project_name");
  }
  pgm.sql(`ALTER FUNCTION enforce_aws_build_input_reservation_change()
    RENAME TO enforce_build_input_reservation_change`);
  pgm.sql(`CREATE OR REPLACE FUNCTION enforce_build_input_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$${reservationGuard("build_input_reservations", "build_receipts")}$$`);

  pgm.sql(`CREATE TABLE build_usage (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    operation_id ulid NOT NULL,
    billing_epoch_id ulid NOT NULL,
    provider_build_id text NOT NULL,
    build_project_name text NOT NULL,
    runner text NOT NULL CHECK (runner='cloudflare-build-sandbox'),
    instance_type text NOT NULL CHECK (instance_type ~ '^[a-z][a-z0-9-]{0,63}$'),
    status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT')),
    started_at timestamptz NOT NULL,
    provisioning_started_at timestamptz,
    completed_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id,project_id,environment_id,operation_id),
    CONSTRAINT build_usage_receipt_fkey
      FOREIGN KEY (organization_id,project_id,environment_id,operation_id)
      REFERENCES build_receipts(organization_id,project_id,environment_id,operation_id),
    CONSTRAINT build_usage_billing_epoch_fkey FOREIGN KEY (billing_epoch_id,project_id,organization_id)
      REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    CONSTRAINT build_usage_time_check CHECK (completed_at>=started_at
      AND (provisioning_started_at IS NULL
        OR provisioning_started_at BETWEEN started_at AND completed_at))
  );
  CREATE TRIGGER build_usage_append_only BEFORE UPDATE OR DELETE ON build_usage
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();`);

  pgm.dropConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT);
  pgm.addConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT, {
    check: sourceArchiveCheck(R2_VERSION_REFERENCE),
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM build_usage)
      OR EXISTS (SELECT 1 FROM source_archives WHERE object_ref LIKE 'r2-version:%')
    THEN RAISE EXCEPTION 'build sandbox history prevents a lossless migration downgrade'
      USING ERRCODE='23514'; END IF; END $$`);

  pgm.dropConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT);
  pgm.addConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT, {
    check: sourceArchiveCheck(S3_VERSION_REFERENCE),
  });
  pgm.dropTable("build_usage");

  pgm.sql(`ALTER FUNCTION enforce_build_input_reservation_change()
    RENAME TO enforce_aws_build_input_reservation_change`);
  pgm.sql(`CREATE OR REPLACE FUNCTION enforce_aws_build_input_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$${reservationGuard("aws_build_input_reservations", "aws_build_receipts")}$$`);
  for (const table of PROJECT_NAME_TABLES) {
    pgm.renameColumn(table, "build_project_name", "codebuild_project_name");
    renameOwnNames(pgm, table, "build_project_name", "codebuild_project_name");
  }
  for (const [from, to] of RENAMED_TABLES) renameTable(pgm, to, from);

  // Exactly the table of migration 082.
  pgm.sql(`CREATE TABLE aws_build_usage (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    operation_id ulid NOT NULL,
    billing_epoch_id ulid NOT NULL,
    provider_build_id text NOT NULL,
    codebuild_project_name text NOT NULL,
    arn text NOT NULL UNIQUE,
    status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT')),
    started_at timestamptz NOT NULL,
    provisioning_started_at timestamptz,
    completed_at timestamptz NOT NULL,
    environment_type text NOT NULL CHECK (environment_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    compute_type text NOT NULL CHECK (compute_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id,project_id,environment_id,operation_id),
    FOREIGN KEY (organization_id,project_id,environment_id,operation_id)
      REFERENCES aws_build_receipts(organization_id,project_id,environment_id,operation_id),
    FOREIGN KEY (billing_epoch_id,project_id,organization_id)
      REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    CHECK (completed_at>=started_at AND (provisioning_started_at IS NULL OR
      provisioning_started_at BETWEEN started_at AND completed_at)),
    CHECK (arn ~ '^arn:aws:codebuild:[a-z0-9-]+:[0-9]{12}:build/'
      AND split_part(arn,':build/',2)=provider_build_id)
  );
  CREATE TRIGGER aws_build_usage_append_only BEFORE UPDATE OR DELETE ON aws_build_usage
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();`);
}

/** These tables are append-only: only this migration may delete, so it lifts exactly one trigger. */
function purge(pgm, table, trigger, condition = "true") {
  pgm.sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger};
    DELETE FROM ${table} WHERE ${condition};
    ALTER TABLE ${table} ENABLE TRIGGER ${trigger};`);
}

function renameTable(pgm, from, to) {
  pgm.renameTable(from, to);
  renameOwnNames(pgm, to, from, to);
}

/**
 * Renames every constraint (with its index) and trigger of the table whose name contains the old
 * name. PostgreSQL 18 also names each NOT NULL constraint after its table and column, earlier
 * versions do not, so the names come from the catalog instead of a list.
 */
function renameOwnNames(pgm, table, from, to) {
  pgm.sql(`DO $$
    DECLARE own_name text;
    BEGIN
      FOR own_name IN SELECT unnest(ARRAY(SELECT conname::text FROM pg_constraint
        WHERE conrelid='${table}'::regclass AND position('${from}' in conname)>0)) LOOP
        EXECUTE format('ALTER TABLE ${table} RENAME CONSTRAINT %I TO %I',
          own_name, replace(own_name, '${from}', '${to}'));
      END LOOP;
      FOR own_name IN SELECT unnest(ARRAY(SELECT tgname::text FROM pg_trigger
        WHERE tgrelid='${table}'::regclass AND NOT tgisinternal
          AND position('${from}' in tgname)>0)) LOOP
        EXECUTE format('ALTER TRIGGER %I ON ${table} RENAME TO %I',
          own_name, replace(own_name, '${from}', '${to}'));
      END LOOP;
    END $$`);
}
