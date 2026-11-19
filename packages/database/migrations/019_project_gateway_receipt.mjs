const GATEWAY_COLUMNS = [
  "gateway_contract_version",
  "gateway_script_name",
  "gateway_target_script_name",
  "gateway_workers_dev_subdomain",
  "gateway_provider_tag",
  "gateway_module_sha256",
  "gateway_public_origin",
  "gateway_compatibility_date",
  "gateway_observed_at",
];

export function up(pgm) {
  pgm.addColumns("wfp_publish_receipts", {
    gateway_contract_version: { type: "text" },
    gateway_script_name: { type: "text" },
    gateway_target_script_name: { type: "text" },
    gateway_workers_dev_subdomain: { type: "text" },
    gateway_provider_tag: { type: "bytea" },
    gateway_module_sha256: { type: "bytea" },
    gateway_public_origin: { type: "text" },
    gateway_compatibility_date: { type: "date" },
    gateway_observed_at: { type: "timestamptz" },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check", {
    check: `((${GATEWAY_COLUMNS.map((column) => `${column} IS NULL`).join(" AND ")}) OR (
      ${GATEWAY_COLUMNS.map((column) => `${column} IS NOT NULL`).join(" AND ")}
      AND gateway_contract_version='ohmyhost.project-gateway/v1'
      AND gateway_script_name='g-'||lower(project_id::text)
      AND gateway_target_script_name=script_name
      AND gateway_target_script_name='p-'||lower(project_id::text)
      AND gateway_workers_dev_subdomain~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
      AND octet_length(gateway_provider_tag)=32
      AND octet_length(gateway_module_sha256)=32
      AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
      AND deployment_url=gateway_public_origin||'/p/'||project_id::text
      AND gateway_compatibility_date>='2024-09-23'::date
    ))`,
  });
  pgm.sql(`CREATE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.gateway_contract_version IS NULL THEN
        RAISE EXCEPTION 'new WFP receipts require project gateway evidence'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_insert_required';
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.createTrigger("wfp_publish_receipts", "wfp_publish_receipts_gateway_insert_required", {
    when: "BEFORE",
    operation: "INSERT",
    level: "ROW",
    function: "require_project_gateway_receipt_insert",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM wfp_publish_receipts WHERE gateway_contract_version IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'project gateway receipts prevent a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END
  $$`);
  pgm.dropTrigger("wfp_publish_receipts", "wfp_publish_receipts_gateway_insert_required");
  pgm.sql("DROP FUNCTION require_project_gateway_receipt_insert()");
  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check");
  pgm.dropColumns("wfp_publish_receipts", GATEWAY_COLUMNS);
}
