// P34: the customer-visible tail of a failed build travels with the BUILD_FAILED diagnostic.
export function up(pgm) {
  pgm.addColumns("deployment_diagnostics", {
    excerpt: { type: "text" },
    excerpt_truncated: { type: "boolean" },
  });
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_excerpt_check", {
    check: `((excerpt IS NULL)=(excerpt_truncated IS NULL)) AND (excerpt IS NULL OR (code='BUILD_FAILED' AND length(excerpt) BETWEEN 1 AND 16384 AND excerpt!~'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]' AND excerpt!~'[[:space:]]$'))`,
  });
}
export function down(pgm) {
  pgm.dropConstraint("deployment_diagnostics", "deployment_diagnostics_excerpt_check");
  pgm.dropColumns("deployment_diagnostics", ["excerpt", "excerpt_truncated"]);
}
