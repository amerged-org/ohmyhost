import { createRequire } from "node:module";
import { URL } from "node:url";
import { fail, integerText } from "./control-d1-codec.mjs";
const { types } = createRequire(new URL("../packages/database/package.json", import.meta.url))(
  "pg",
);
const parseTextArray = types.getTypeParser(1009, "text");

export const CLOUDFLARE_COLUMNS = Object.freeze({
  cloudflare_project_domains:
    "organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,mail_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at,deleted_at",
  cloudflare_project_authorization_states:
    "authorization_id,organization_id,project_id,principal_id,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at,consumed_at,declaration_snapshot",
  cloudflare_project_dns_grants:
    "organization_id,project_id,authorization_id,principal_id,zone_id,zone_name,account_id,scopes,access_ciphertext,access_nonce,refresh_ciphertext,refresh_nonce,key_version,access_expires_at,status,connected_at,updated_at,revoked_at",
  cloudflare_project_oauth_revocations:
    "organization_id,project_id,operation_id,authorization_id,refresh_token_sha256,state,provider_started_at,readback_started_at,confirmed_at",
  cloudflare_project_domain_receipts:
    "receipt_id,organization_id,project_id,kind,environment_name,provider_resource_id,zone_id,zone_name,dns_type,dns_name,dns_content,dns_ttl,dns_proxied,dns_comment,hostname,hostname_status,provider_created_at,ownership_verification,ownership_verification_http,verification_errors,custom_hostname_id,ssl_status,ssl_type,ssl_method,ssl_bundle_method,ssl_certificate_authority,ssl_validation_records,route_pattern,route_script,observed_at",
  scoped_customer_dns_authorizations:
    "authorization_id,organization_id,purpose,resource_id,resource_revision,principal_id,delegation,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at,consumed_at,revoked_at,dns_receipts",
  scoped_customer_dns_grants:
    "organization_id,purpose,resource_id,resource_revision,authorization_id,principal_id,zone_name,zone_id,account_id,access_ciphertext,access_nonce,refresh_ciphertext,refresh_nonce,key_version,access_expires_at,connected_at,revoked_at,dns_receipts",
  scoped_customer_dns_revocations:
    "organization_id,purpose,resource_id,resource_revision,principal_id,idempotency_key_sha256,request_sha256,revoked_at,response",
});
export const CLOUDFLARE_TYPES = Object.freeze({
  cloudflare_project_domains: {
    organization_id: "ulid",
    project_id: "ulid",
    operation_id: "ulid",
    handle: "text",
    zone_name: "text",
    production_domain: "text",
    development_domain: "text",
    mail_domain: "text",
    configured_by_principal_id: "text",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    configured_at: "timestamp with time zone",
    deleted_at: "timestamp with time zone",
  },
  cloudflare_project_authorization_states: {
    authorization_id: "ulid",
    organization_id: "ulid",
    project_id: "ulid",
    principal_id: "text",
    zone_name: "text",
    state_sha256: "bytea",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    issued_at: "timestamp with time zone",
    expires_at: "timestamp with time zone",
    consumed_at: "timestamp with time zone",
    declaration_snapshot: "jsonb",
  },
  cloudflare_project_dns_grants: {
    organization_id: "ulid",
    project_id: "ulid",
    authorization_id: "ulid",
    principal_id: "text",
    zone_id: "text",
    zone_name: "text",
    account_id: "text",
    scopes: "text[]",
    access_ciphertext: "bytea",
    access_nonce: "bytea",
    refresh_ciphertext: "bytea",
    refresh_nonce: "bytea",
    key_version: "integer",
    access_expires_at: "timestamp with time zone",
    status: "text",
    connected_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    revoked_at: "timestamp with time zone",
  },
  cloudflare_project_oauth_revocations: {
    organization_id: "ulid",
    project_id: "ulid",
    operation_id: "ulid",
    authorization_id: "ulid",
    refresh_token_sha256: "bytea",
    state: "text",
    provider_started_at: "timestamp with time zone",
    readback_started_at: "timestamp with time zone",
    confirmed_at: "timestamp with time zone",
  },
  cloudflare_project_domain_receipts: {
    receipt_id: "ulid",
    organization_id: "ulid",
    project_id: "ulid",
    kind: "text",
    environment_name: "text",
    provider_resource_id: "text",
    zone_id: "text",
    zone_name: "text",
    dns_type: "text",
    dns_name: "text",
    dns_content: "text",
    dns_ttl: "integer",
    dns_proxied: "boolean",
    dns_comment: "text",
    hostname: "text",
    hostname_status: "text",
    provider_created_at: "timestamp with time zone",
    ownership_verification: "jsonb",
    ownership_verification_http: "jsonb",
    verification_errors: "text[]",
    custom_hostname_id: "text",
    ssl_status: "text",
    ssl_type: "text",
    ssl_method: "text",
    ssl_bundle_method: "text",
    ssl_certificate_authority: "text",
    ssl_validation_records: "jsonb",
    route_pattern: "text",
    route_script: "text",
    observed_at: "timestamp with time zone",
  },
  scoped_customer_dns_authorizations: {
    authorization_id: "ulid",
    organization_id: "ulid",
    purpose: "text",
    resource_id: "ulid",
    resource_revision: "bigint",
    principal_id: "text",
    delegation: "jsonb",
    zone_name: "text",
    state_sha256: "bytea",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    issued_at: "timestamp with time zone",
    expires_at: "timestamp with time zone",
    consumed_at: "timestamp with time zone",
    revoked_at: "timestamp with time zone",
    dns_receipts: "jsonb",
  },
  scoped_customer_dns_grants: {
    organization_id: "ulid",
    purpose: "text",
    resource_id: "ulid",
    resource_revision: "bigint",
    authorization_id: "ulid",
    principal_id: "text",
    zone_name: "text",
    zone_id: "text",
    account_id: "text",
    access_ciphertext: "bytea",
    access_nonce: "bytea",
    refresh_ciphertext: "bytea",
    refresh_nonce: "bytea",
    key_version: "integer",
    access_expires_at: "timestamp with time zone",
    connected_at: "timestamp with time zone",
    revoked_at: "timestamp with time zone",
    dns_receipts: "jsonb",
  },
  scoped_customer_dns_revocations: {
    organization_id: "ulid",
    purpose: "text",
    resource_id: "ulid",
    resource_revision: "bigint",
    principal_id: "text",
    idempotency_key_sha256: "bytea",
    request_sha256: "bytea",
    revoked_at: "timestamp with time zone",
    response: "jsonb",
  },
});
export const CLOUDFLARE_TARGETS = Object.freeze(Object.keys(CLOUDFLARE_COLUMNS));
export const CLOUDFLARE_SCHEMA_PINS = Object.freeze({
  "0231_secrets.sql": "bb3654de5910b03f03955bd417696ea1f4dd3918705724a894941572c21b4f54",
  "0232_domains_mail.sql": "5634eb6c4b97abf3f49a78f57456acda2fa824916b56ad40464f97391b3676d7",
  "0467_mail_original_scoped_dns.sql":
    "adabefcb89c92dad3b9b78e5057ec153630b1b9a8b1d19e27ccf4a1a1aa4374f",
  "0498_cloudflare_original_receipt_fields.sql":
    "df02f16dc05b44cde690ee8dacbe8b2627abb1ca130690799d777e30a00e8b5a",
});
export const CLOUDFLARE_TEMPORAL_TABLES = Object.freeze([
  "scoped_customer_dns_authorizations",
  "scoped_customer_dns_grants",
]);
export const CLOUDFLARE_KINDS = Object.freeze(
  Object.fromEntries(
    Object.entries(CLOUDFLARE_TYPES).map(([table, fields]) => [
      table,
      Object.fromEntries(
        Object.entries(fields).map(([field, type]) => [
          field,
          type === "bytea"
            ? "bytea"
            : ["integer", "bigint", "boolean"].includes(type)
              ? "integer"
              : type.startsWith("timestamp")
                ? "timestamp"
                : "text",
        ]),
      ),
    ]),
  ),
);

/** Compatibility body only; every original field, JSONB/array string and microsecond is separately retained unchanged. */
function receiptBody(row) {
  const json = (field) => (row[field] === null ? null : JSON.parse(row[field]));
  switch (row.kind) {
    case "dns_record":
      return {
        zoneId: row.zone_id,
        zoneName: row.zone_name,
        type: row.dns_type,
        name: row.dns_name,
        content: row.dns_content,
        ttl: Number(row.dns_ttl),
        proxied: row.dns_proxied === "true",
        comment: row.dns_comment,
      };
    case "custom_hostname":
      return {
        environmentName: row.environment_name,
        hostname: row.hostname,
        status: row.hostname_status,
        providerCreatedAt:
          row.provider_created_at === null ? null : new Date(row.provider_created_at).toISOString(),
        ownershipVerification: json("ownership_verification"),
        ownershipVerificationHttp: json("ownership_verification_http"),
        verificationErrors:
          row.verification_errors === null ? null : parseTextArray(row.verification_errors),
      };
    case "ssl":
      return {
        customHostnameId: row.custom_hostname_id,
        environmentName: row.environment_name,
        hostname: row.hostname,
        status: row.ssl_status,
        type: row.ssl_type,
        method: row.ssl_method,
        bundleMethod: row.ssl_bundle_method,
        certificateAuthority: row.ssl_certificate_authority,
        validationRecords: json("ssl_validation_records"),
      };
    case "worker_route":
      return {
        environmentName: row.environment_name,
        zoneId: row.zone_id,
        pattern: row.route_pattern,
        script: row.route_script,
      };
    default:
      return fail("CLOUDFLARE_RECEIPT_KIND");
  }
}

/** Eight original physical families only; no alias, new receipt, provider action or current authority is inferred. */
export function mapCloudflareFacts(rows, manifest) {
  for (const [name, sha256] of Object.entries(CLOUDFLARE_SCHEMA_PINS))
    if (
      !manifest.targetPin?.migrations?.some(
        (entry) => entry.name === name && entry.sha256 === sha256,
      )
    )
      fail("CLOUDFLARE_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, declaration] of Object.entries(CLOUDFLARE_COLUMNS)) {
    const fields = declaration.split(","),
      definition = manifest.tables.find((entry) => entry.name === table),
      source = rows.get(table);
    if (
      !definition ||
      definition.columns.map((column) => column.name).join(",") !== declaration ||
      !Array.isArray(source)
    )
      fail("CLOUDFLARE_SOURCE_COLUMNS");
    for (const column of definition.columns) {
      const sourceType = CLOUDFLARE_TYPES[table][column.name],
        type = sourceType === "ulid" ? "text" : sourceType;
      if (column.pgType !== type || (column.sourceType ?? column.pgType) !== sourceType)
        fail("CLOUDFLARE_SOURCE_TYPE");
    }
    for (const original of source) {
      if (!original || Object.keys(original).sort().join(",") !== fields.slice().sort().join(","))
        fail("CLOUDFLARE_ROW_SHAPE");
      const row = { ...original };
      for (const field of fields) {
        const value = row[field],
          type = CLOUDFLARE_TYPES[table][field];
        if (value === null) continue;
        if (typeof value !== "string") fail("CLOUDFLARE_ROW_VALUE");
        if (["integer", "bigint"].includes(type)) integerText(value);
        if (type === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value)) fail("CLOUDFLARE_BYTEA");
        if (
          type.startsWith("timestamp") &&
          (!/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
        )
          fail("CLOUDFLARE_TIMESTAMP_UNREPRESENTABLE");
        if (type === "boolean") {
          if (value !== "true" && value !== "false") fail("CLOUDFLARE_BOOLEAN");
          row[field] = value === "true" ? "1" : "0";
        }
      }
      if (table === "cloudflare_project_dns_grants") {
        // Original native equality constrains the complete one-dimensional array and its ordinary bounds.
        if (original.scopes !== "{dns.write,zone.read}")
          fail("CLOUDFLARE_SCOPE_ARRAY_UNREPRESENTABLE");
        row.scopes = '["dns.write","zone.read"]';
      }
      if (table === "cloudflare_project_domain_receipts")
        row.body = JSON.stringify(receiptBody(original));
      records.push({ table, row });
    }
  }
  return records;
}
