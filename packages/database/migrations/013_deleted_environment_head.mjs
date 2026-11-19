const relaxedHeadCheck = `head_version>=0 AND (
  (active_deployment_id IS NULL AND active_revision_id IS NULL)
  OR
  (head_version>0 AND active_deployment_id IS NOT NULL AND active_revision_id IS NOT NULL)
)`;

const originalHeadCheck = `head_version>=0 AND (
  (head_version=0 AND active_deployment_id IS NULL AND active_revision_id IS NULL)
  OR
  (head_version>0 AND active_deployment_id IS NOT NULL AND active_revision_id IS NOT NULL)
)`;

export function up(pgm) {
  pgm.dropConstraint("environments", "environments_head_shape_check");
  pgm.addConstraint("environments", "environments_head_shape_check", {
    check: relaxedHeadCheck,
  });
}

export function down(pgm) {
  pgm.dropConstraint("environments", "environments_head_shape_check");
  pgm.addConstraint("environments", "environments_head_shape_check", {
    check: originalHeadCheck,
  });
}
