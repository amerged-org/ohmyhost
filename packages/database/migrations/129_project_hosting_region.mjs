// Owner decision 2026-09-17: a project chooses its hosting region once, at creation. US stays
// the default, EU is the alternative; the choice places the project's Neon database, its files,
// its build sandbox and its build objects. Like `data_mode` (migration 097) the region never
// changes afterwards, and the build objects of an EU project live in the `-eu` build bucket, so
// the object reference check of migration 127 accepts that bucket name as well.
const SOURCE_ARCHIVE_CONSTRAINT = "source_archives_content_check";
const sourceArchiveCheck = (versionReference) =>
  `provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND external_repository_id::numeric<=9007199254740991 AND requested_commit_sha~'^[0-9a-f]{40}$' AND requested_commit_sha<>repeat('0',40) AND resolved_commit_sha=requested_commit_sha AND archive_format='tar.gz' AND octet_length(sha256)=32 AND byte_length BETWEEN 1 AND 9007199254740991 AND ((object_ref~'^archive_[0-7][0-9A-HJKMNP-TV-Z]{25}_[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND split_part(object_ref,'_',2)=operation_id::text) OR (length(object_ref)<=512 AND object_ref~'${versionReference}'))`;
// Exactly the reference of migration 127: the US build bucket only.
const US_R2_VERSION_REFERENCE =
  "^r2-version:ohmyho-builds-(development|production)/[^?#[:space:]]+#[0-9a-f]{32}$";
const REGIONAL_R2_VERSION_REFERENCE =
  "^r2-version:ohmyho-builds-(development|production)(-eu)?/[^?#[:space:]]+#[0-9a-f]{32}$";

export function up(pgm) {
  pgm.addColumn("projects", { region: { type: "text", notNull: true, default: "us" } });
  pgm.addConstraint("projects", "projects_region_shape", { check: "region IN ('us','eu')" });
  pgm.sql(`CREATE FUNCTION reject_project_region_change() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.region IS DISTINCT FROM OLD.region THEN
        RAISE EXCEPTION 'project hosting region is chosen at creation and cannot change'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.createTrigger("projects", "projects_region_immutable", {
    when: "BEFORE",
    operation: "UPDATE",
    level: "ROW",
    function: "reject_project_region_change",
  });

  pgm.dropConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT);
  pgm.addConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT, {
    check: sourceArchiveCheck(REGIONAL_R2_VERSION_REFERENCE),
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM projects WHERE region<>'us')
      OR EXISTS (SELECT 1 FROM source_archives WHERE object_ref LIKE 'r2-version:ohmyho-builds-%-eu/%')
    THEN RAISE EXCEPTION 'EU hosting evidence prevents a lossless migration downgrade'
      USING ERRCODE='23514'; END IF; END $$`);

  pgm.dropConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT);
  pgm.addConstraint("source_archives", SOURCE_ARCHIVE_CONSTRAINT, {
    check: sourceArchiveCheck(US_R2_VERSION_REFERENCE),
  });

  pgm.dropTrigger("projects", "projects_region_immutable");
  pgm.sql("DROP FUNCTION reject_project_region_change()");
  pgm.dropConstraint("projects", "projects_region_shape");
  pgm.dropColumn("projects", "region");
}
