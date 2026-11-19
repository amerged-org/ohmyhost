export function up(pgm) {
  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_identity_key");
  pgm.createIndex(
    "wfp_publish_receipts",
    ["dispatch_namespace", "script_name", "provider_version_id"],
    { name: "wfp_publish_receipts_provider_tag_idx" },
  );
}

export function down(pgm) {
  pgm.dropIndex("wfp_publish_receipts", [], {
    name: "wfp_publish_receipts_provider_tag_idx",
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_identity_key", {
    unique: ["dispatch_namespace", "script_name", "provider_version_id"],
  });
}
