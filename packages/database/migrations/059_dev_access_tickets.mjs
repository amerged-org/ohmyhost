export function up(pgm) {
  pgm.addColumns("environments", {
    dev_access_epoch: { type: "bigint", notNull: true, default: 0 },
  });
  pgm.sql(`UPDATE environments SET dev_access_epoch=1 WHERE name='dev'`);
  pgm.sql(`CREATE FUNCTION initialize_dev_access_epoch() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name='dev' AND NEW.dev_access_epoch=0 THEN
        NEW.dev_access_epoch=1;
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.createTrigger("environments", "environments_initialize_dev_access_epoch", {
    when: "BEFORE",
    operation: "INSERT",
    level: "ROW",
    function: "initialize_dev_access_epoch",
  });
  pgm.addConstraint("environments", "environments_dev_access_epoch_check", {
    check: "(name='dev' AND dev_access_epoch>=1) OR (name='prod' AND dev_access_epoch=0)",
  });
  pgm.createTable("dev_access_tickets", {
    ticket_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    environment_name: { type: "text", notNull: true },
    handle: { type: "text", notNull: true },
    public_origin: { type: "text", notNull: true },
    dev_access_epoch: { type: "bigint", notNull: true },
    issued_to_principal_id: { type: "text", notNull: true },
    token_sha256: { type: "bytea", notNull: true, unique: true },
    issued_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    consumed_at: { type: "timestamptz" },
    revoked_at: { type: "timestamptz" },
  });
  pgm.addConstraint("dev_access_tickets", "dev_access_tickets_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
      onUpdate: "RESTRICT",
    },
  });
  pgm.addConstraint("dev_access_tickets", "dev_access_tickets_shape_check", {
    check: `environment_name='dev'
      AND handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
      AND public_origin='https://dev-'||handle||'.your-omh-account.workers.dev'
      AND issued_to_principal_id=btrim(issued_to_principal_id)
      AND length(issued_to_principal_id) BETWEEN 1 AND 256
      AND octet_length(token_sha256)=32
      AND dev_access_epoch>=1
      AND expires_at=issued_at+interval '10 minutes'
      AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
      AND (revoked_at IS NULL OR (revoked_at>=issued_at AND consumed_at IS NULL))
      AND NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)`,
  });
  pgm.createIndex(
    "dev_access_tickets",
    ["organization_id", "project_id", "issued_to_principal_id"],
    {
      name: "dev_access_tickets_active_principal_idx",
      unique: true,
      where: "consumed_at IS NULL AND revoked_at IS NULL",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM projects)
        OR EXISTS (SELECT 1 FROM dev_access_tickets) THEN
        RAISE EXCEPTION 'project dev access state prevents a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END
  $$`);
  pgm.dropTable("dev_access_tickets");
  pgm.dropTrigger("environments", "environments_initialize_dev_access_epoch");
  pgm.sql(`DROP FUNCTION initialize_dev_access_epoch()`);
  pgm.dropConstraint("environments", "environments_dev_access_epoch_check");
  pgm.dropColumns("environments", ["dev_access_epoch"]);
}
