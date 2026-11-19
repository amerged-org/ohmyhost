export function up(pgm) {
  pgm.addColumn("workos_organization_mappings", { beta_admitted_at: { type: "timestamptz" } });
}

export function down(pgm) {
  pgm.dropColumn("workos_organization_mappings", "beta_admitted_at");
}
