export function up(pgm) {
  pgm.addConstraint("environments", "environments_authorization_scope_key", {
    unique: ["organization_id", "project_id", "environment_id"],
  });
  pgm.addConstraint("local_authorization_grants", "local_authorization_grants_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "CASCADE",
    },
  });
}

export function down(pgm) {
  pgm.dropConstraint("local_authorization_grants", "local_authorization_grants_environment_fkey");
  pgm.dropConstraint("environments", "environments_authorization_scope_key");
}
