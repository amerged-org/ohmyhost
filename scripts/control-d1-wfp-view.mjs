import { Buffer } from "node:buffer";
import { canonical, sha256 } from "./control-d1-codec.mjs";
import { readFixedProjectionPages } from "./control-d1-readback-pages.mjs";
import { WFP_SCHEMA_PINS } from "./control-d1-wfp-mappings.mjs";

// Literal fresh synthetic PG18 pg_get_viewdef(...,true) after original146. No source SQL normalization.
export const EFFECTIVE_WFP_DEFINITION =
  " SELECT receipt.wfp_receipt_id,\n    receipt.organization_id,\n    receipt.project_id,\n    receipt.artifact_id,\n    receipt.dispatch_namespace,\n    receipt.script_name,\n    receipt.provider_version_id,\n    route.public_origin AS deployment_url,\n    receipt.published_at,\n    receipt.environment_id,\n    receipt.candidate_receipt_id,\n    receipt.product_deployment_id,\n    receipt.script_name AS gateway_target_script_name,\n    NULL::text AS gateway_contract_version,\n    NULL::text AS gateway_script_name,\n    NULL::text AS gateway_workers_dev_subdomain,\n    NULL::text AS gateway_internal_origin,\n    route.public_origin AS gateway_public_origin,\n    NULL::bytea AS gateway_provider_tag,\n    NULL::bytea AS gateway_egress_policy_sha256,\n    NULL::text AS gateway_dev_access_service,\n    NULL::text AS gateway_dev_access_entrypoint,\n    NULL::bytea AS gateway_dev_access_key_id,\n    NULL::bytea AS gateway_dev_access_public_key_sha256,\n    NULL::bytea AS gateway_module_sha256,\n    NULL::date AS gateway_compatibility_date,\n    NULL::timestamp with time zone AS gateway_observed_at,\n    NULL::text AS gateway_version_id,\n    NULL::text AS gateway_deployment_id,\n    route.revision AS shared_gateway_revision\n   FROM wfp_publish_receipts receipt\n     LEFT JOIN environments environment ON environment.organization_id::text = receipt.organization_id::text AND environment.project_id::text = receipt.project_id::text AND environment.environment_id::text = receipt.environment_id::text AND environment.active_deployment_id::text = receipt.product_deployment_id::text AND (EXISTS ( SELECT 1\n           FROM deployment_revisions revision\n          WHERE revision.organization_id::text = receipt.organization_id::text AND revision.project_id::text = receipt.project_id::text AND revision.wfp_receipt_id::text = receipt.wfp_receipt_id::text AND revision.deployment_id::text = environment.active_deployment_id::text AND revision.revision_id::text = environment.active_revision_id::text))\n     LEFT JOIN wfp_rollback_activation_receipts activation ON activation.organization_id::text = environment.organization_id::text AND activation.project_id::text = environment.project_id::text AND activation.environment_id::text = environment.environment_id::text AND activation.target_deployment_id::text = environment.active_deployment_id::text AND activation.target_revision_id::text = environment.active_revision_id::text AND activation.wfp_receipt_id::text = receipt.wfp_receipt_id::text AND activation.activated_head_version = environment.head_version\n     LEFT JOIN projects project ON project.project_id::text = receipt.project_id::text\n     LEFT JOIN LATERAL ( SELECT address_1.shared_gateway_revision\n           FROM shared_gateway_address_receipts address_1\n          WHERE address_1.organization_id::text = receipt.organization_id::text AND address_1.project_id::text = receipt.project_id::text AND address_1.environment_id::text = receipt.environment_id::text AND address_1.wfp_receipt_id::text = receipt.wfp_receipt_id::text AND address_1.head_version = environment.head_version AND address_1.handle = project.handle\n          ORDER BY address_1.shared_gateway_revision DESC\n         LIMIT 1) address ON true\n     JOIN shared_gateway_route_revisions route ON route.organization_id::text = receipt.organization_id::text AND route.project_id::text = receipt.project_id::text AND route.environment_id::text = receipt.environment_id::text AND route.candidate_receipt_id::text = receipt.candidate_receipt_id::text AND route.active AND route.revision = COALESCE(address.shared_gateway_revision,\n        CASE\n            WHEN activation.rollback_activation_receipt_id IS NOT NULL THEN activation.shared_gateway_revision\n            ELSE receipt.shared_gateway_revision\n        END);";
// Original ordered type/domain identities, independently checked against the actual PG18 view catalogue.
export const EFFECTIVE_WFP_COLUMNS = Object.freeze([
  {
    name: "wfp_receipt_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "organization_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "project_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "artifact_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "dispatch_namespace",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "script_name",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "provider_version_id",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "deployment_url",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "published_at",
    pgType: "timestamp with time zone",
    sourceType: "timestamp with time zone",
    kind: "timestamp",
  },
  {
    name: "environment_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "candidate_receipt_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "product_deployment_id",
    pgType: "text",
    sourceType: "ulid",
    kind: "text",
  },
  {
    name: "gateway_target_script_name",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_contract_version",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_script_name",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_workers_dev_subdomain",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_internal_origin",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_public_origin",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_provider_tag",
    pgType: "bytea",
    sourceType: "bytea",
    kind: "bytea",
  },
  {
    name: "gateway_egress_policy_sha256",
    pgType: "bytea",
    sourceType: "bytea",
    kind: "bytea",
  },
  {
    name: "gateway_dev_access_service",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_dev_access_entrypoint",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_dev_access_key_id",
    pgType: "bytea",
    sourceType: "bytea",
    kind: "bytea",
  },
  {
    name: "gateway_dev_access_public_key_sha256",
    pgType: "bytea",
    sourceType: "bytea",
    kind: "bytea",
  },
  {
    name: "gateway_module_sha256",
    pgType: "bytea",
    sourceType: "bytea",
    kind: "bytea",
  },
  {
    name: "gateway_compatibility_date",
    pgType: "date",
    sourceType: "date",
    kind: "text",
  },
  {
    name: "gateway_observed_at",
    pgType: "timestamp with time zone",
    sourceType: "timestamp with time zone",
    kind: "timestamp",
  },
  {
    name: "gateway_version_id",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "gateway_deployment_id",
    pgType: "text",
    sourceType: "text",
    kind: "text",
  },
  {
    name: "shared_gateway_revision",
    pgType: "bigint",
    sourceType: "bigint",
    kind: "integer",
  },
]);
const PARENTS = Object.freeze([
  "wfp_publish_receipts",
  "environments",
  "deployment_revisions",
  "wfp_rollback_activation_receipts",
  "projects",
  "shared_gateway_route_revisions",
  "shared_gateway_address_receipts",
]);

// Nonconstant output type/domain identities come from these exact captured physical columns.
const OUTPUT_SOURCES = Object.freeze({
  wfp_receipt_id: ["wfp_publish_receipts", "wfp_receipt_id"],
  organization_id: ["wfp_publish_receipts", "organization_id"],
  project_id: ["wfp_publish_receipts", "project_id"],
  artifact_id: ["wfp_publish_receipts", "artifact_id"],
  dispatch_namespace: ["wfp_publish_receipts", "dispatch_namespace"],
  script_name: ["wfp_publish_receipts", "script_name"],
  provider_version_id: ["wfp_publish_receipts", "provider_version_id"],
  deployment_url: ["shared_gateway_route_revisions", "public_origin"],
  published_at: ["wfp_publish_receipts", "published_at"],
  environment_id: ["wfp_publish_receipts", "environment_id"],
  candidate_receipt_id: ["wfp_publish_receipts", "candidate_receipt_id"],
  product_deployment_id: ["wfp_publish_receipts", "product_deployment_id"],
  gateway_target_script_name: ["wfp_publish_receipts", "script_name"],
  gateway_public_origin: ["shared_gateway_route_revisions", "public_origin"],
  shared_gateway_revision: ["shared_gateway_route_revisions", "revision"],
});

/** A standalone reader never retires unqualified parent mappers or a changed original view/schema. */
export function qualifyEffectiveWfpView(capture, mapped) {
  const readers = [],
    gaps = [],
    group = "effective-wfp-view-v1",
    definitions = capture.manifest.views.filter(
      (view) => view.name === "effective_wfp_publish_receipts",
    );
  if (definitions.length === 0) {
    if (mapped.has("wfp_publish_receipts")) gaps.push({ group, code: "CONTROL_D1_VIEW_REQUIRED" });
  } else if (definitions.length !== 1 || definitions[0].definition !== EFFECTIVE_WFP_DEFINITION)
    gaps.push({ group, code: "CONTROL_D1_VIEW_DEFINITION_UNQUALIFIED" });
  else if (PARENTS.some((parent) => !mapped.has(parent)))
    gaps.push({ group, code: "CONTROL_D1_VIEW_PARENT_UNQUALIFIED" });
  else if (
    Object.entries(OUTPUT_SOURCES).some(([name, [table, column]]) => {
      const expected = EFFECTIVE_WFP_COLUMNS.find((entry) => entry.name === name),
        actual = capture.manifest.tables
          ?.find((entry) => entry.name === table)
          ?.columns?.find((entry) => entry.name === column);
      return actual?.pgType !== expected.pgType || actual?.sourceType !== expected.sourceType;
    })
  )
    gaps.push({ group, code: "CONTROL_D1_VIEW_COLUMN_CONTRACT_UNQUALIFIED" });
  else if (
    Object.entries(WFP_SCHEMA_PINS).some(
      ([name, sha]) =>
        !capture.manifest.targetPin?.migrations?.some(
          (entry) => entry.name === name && entry.sha256 === sha,
        ),
    )
  )
    gaps.push({ group, code: "CONTROL_D1_VIEW_SCHEMA_UNQUALIFIED" });
  else
    readers.push({
      sourceName: "effective_wfp_publish_receipts",
      reader: "effective-wfp-publications-v1",
      sourceDefinitionSha256: sha256(Buffer.from(definitions[0].definition)),
      columnsSha256: sha256(Buffer.from(canonical(EFFECTIVE_WFP_COLUMNS))),
      parents: [...PARENTS],
    });
  return { readers, gaps };
}

/** Publication PK remains unique after the pinned native one-head/activation/route and latest-address joins. */
export function readEffectiveWfpPages(db) {
  const columns = EFFECTIVE_WFP_COLUMNS.map((column) => column.name),
    selected = EFFECTIVE_WFP_COLUMNS.map((column) =>
      column.kind === "integer"
        ? `CAST(${column.name} AS TEXT) ${column.name}`
        : column.kind === "bytea"
          ? `CASE WHEN ${column.name} IS NULL THEN NULL ELSE lower(hex(${column.name})) END ${column.name}`
          : column.name,
    );
  return readFixedProjectionPages(db, {
    sql: `SELECT ${selected.join(",")} FROM effective_wfp_publish_receipts`,
    columns,
    keys: [{ column: "wfp_receipt_id", kind: "text", maxBytes: 26 }],
    keyProof: {
      kind: "owner-qualified",
      source:
        "Original146 publication ULID PK; one environment/head, UNIQUE activation(environment,head), exact route PK and lateral latest address LIMIT1; qualified0336/0362/0363 preserve each multiplicity guard",
    },
  });
}
