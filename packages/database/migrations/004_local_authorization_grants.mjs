export function up(pgm) {
  pgm.createTable("local_authorization_grants", {
    grant_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", references: "projects", onDelete: "RESTRICT" },
    environment_id: { type: "ulid" },
    principal_kind: { type: "text", notNull: true },
    principal_id: { type: "text", notNull: true },
    role: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    revoked_at: { type: "timestamptz" },
    ownership_version: { type: "integer" },
    billing_epoch_id: { type: "ulid" },
  });
  pgm.addConstraint("local_authorization_grants", "local_authorization_grants_scope_check", {
    check: `principal_kind='user'
      AND principal_id~'^user:[^[:space:]]+$'
      AND role IN ('owner','member')
      AND (revoked_at IS NULL OR revoked_at>=created_at)
      AND (
        (project_id IS NULL AND environment_id IS NULL AND ownership_version IS NULL AND billing_epoch_id IS NULL)
        OR
        (project_id IS NOT NULL AND ownership_version>0 AND billing_epoch_id IS NOT NULL)
      )`,
  });
  pgm.addConstraint("local_authorization_grants", "local_authorization_grants_epoch_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.createIndex(
    "local_authorization_grants",
    ["organization_id", "principal_kind", "principal_id", "project_id", "environment_id"],
    { name: "local_authorization_grants_active_lookup_idx", where: "revoked_at IS NULL" },
  );
  pgm.sql(`CREATE UNIQUE INDEX local_authorization_grants_one_active_scope_idx
    ON local_authorization_grants
      (organization_id,principal_kind,principal_id,
       (COALESCE(project_id::text,'')),(COALESCE(environment_id::text,'')))
    WHERE revoked_at IS NULL`);
}

export function down(pgm) {
  pgm.dropTable("local_authorization_grants");
}
