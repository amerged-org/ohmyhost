const OLD_COLUMNS = [
  "organization_id",
  "project_id",
  "environment_id",
  "candidate_receipt_id",
  "operation_id",
  "product_deployment_id",
];

const TARGET_COLUMNS = [
  "organization_id",
  "project_id",
  "environment_id",
  "candidate_receipt_id",
  "product_deployment_id",
];

function replaceStageCandidateReference(pgm, columns) {
  pgm.dropConstraint(
    "runtime_secret_delivery_stages",
    "runtime_secret_delivery_stages_candidate_fkey",
  );
  pgm.addConstraint(
    "runtime_secret_delivery_stages",
    "runtime_secret_delivery_stages_candidate_fkey",
    {
      foreignKeys: {
        columns,
        references: `wfp_candidate_receipts (${columns.join(", ")})`,
        onDelete: "RESTRICT",
      },
    },
  );
}

export function up(pgm) {
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_runtime_target_key", {
    unique: TARGET_COLUMNS,
  });
  replaceStageCandidateReference(pgm, TARGET_COLUMNS);
}

export function down(pgm) {
  replaceStageCandidateReference(pgm, OLD_COLUMNS);
  pgm.dropConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_runtime_target_key");
}
