import { fail } from "./control-d1-codec.mjs";

export const WFP_COLUMNS = Object.freeze({
  deployments:
    "deployment_id,organization_id,project_id,active_revision_id,active_version,created_at,updated_at,operation_id,environment_id,kind,status,rollback_target_deployment_id,rollback_target_revision_id,promotion_source_environment_id,promotion_source_deployment_id,promotion_source_revision_id",
  wfp_candidate_receipts:
    "candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at",
  shared_gateway_route_revisions:
    "organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at,browser_policy",
  wfp_publish_receipts:
    "wfp_receipt_id,organization_id,project_id,artifact_id,dispatch_namespace,script_name,provider_version_id,deployment_url,published_at,environment_id,gateway_contract_version,gateway_script_name,gateway_target_script_name,gateway_workers_dev_subdomain,gateway_provider_tag,gateway_module_sha256,gateway_public_origin,gateway_compatibility_date,gateway_observed_at,gateway_egress_policy_sha256,gateway_dev_access_service,gateway_dev_access_entrypoint,gateway_dev_access_key_id,gateway_dev_access_public_key_sha256,candidate_receipt_id,product_deployment_id,gateway_version_id,gateway_deployment_id,gateway_internal_origin,shared_gateway_revision",
  deployment_revisions:
    "revision_id,organization_id,project_id,deployment_id,plan_id,build_execution_id,artifact_id,wfp_receipt_id,created_at,operation_id",
  wfp_rollback_activation_receipts:
    "rollback_activation_receipt_id,organization_id,project_id,environment_id,operation_id,rollback_deployment_id,target_deployment_id,target_revision_id,candidate_receipt_id,wfp_receipt_id,gateway_version_id,gateway_deployment_id,activated_at,activated_head_version,gateway_contract_version,gateway_script_name,gateway_workers_dev_subdomain,gateway_internal_origin,gateway_public_origin,gateway_provider_tag,gateway_egress_policy_sha256,gateway_dev_access_service,gateway_dev_access_entrypoint,gateway_dev_access_key_id,gateway_dev_access_public_key_sha256,gateway_module_sha256,gateway_compatibility_date,gateway_observed_at,shared_gateway_revision",
  shared_gateway_address_receipts:
    "organization_id,project_id,environment_id,operation_id,wfp_receipt_id,shared_gateway_revision,head_version,handle,public_origin,observed_at",
  wfp_candidate_cleanup_requests:
    "cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at",
  wfp_candidate_cleanup_claims:
    "candidate_receipt_id,organization_id,project_id,claim_id,attempt_number,claimed_at,lease_expires_at",
  wfp_candidate_cleanup_resource_expectations:
    "cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256",
  wfp_candidate_cleanup_receipts:
    "cleanup_receipt_id,candidate_receipt_id,organization_id,project_id,outcome,compensated_target_script_name,gateway_version_id,gateway_deployment_id,observed_provider_tag,observed_at,environment_id,shared_gateway_revision",
});
export const WFP_TARGETS = Object.freeze(Object.keys(WFP_COLUMNS));
export const WFP_SCHEMA_PINS = Object.freeze({
  "0334_lifetime_source_evidence.sql":
    "8b499068b7e175ee1b9d7bd4f364425faf65091902d5db4b8d5ae2963ee23a44",
  "0336_deployment_static_integrity.sql":
    "dfe68ee1d68c7a7f49c7d3452da9eda8447d8b4d2af8064890bfed3f6379bc4b",
  "0362_gateway_rollback_history.sql":
    "c86d57a6940e806ac28bf2faa6b7dcec693c0b7dd361c4af267a45c685095ca3",
  "0363_effective_gateway_publications.sql":
    "cf1561e5aa055b76c62b9cf5977506830d3a0ce60f041f255873df1626ad2b4d",
  "0364_gateway_cleanup_authority.sql":
    "f7331616cb9edfbba8109045230508ea5f194cac4217033f6ebe8e5c7985731b",
  "0365_wfp_cleanup_resource_expectations.sql":
    "656157652899cd5314f7898fcbe4ab8af076fc080f822e227162d77a29cb42b9",
});
const KINDS = {
  deployments: {
    active_version: "integer",
    created_at: "timestamp",
    updated_at: "timestamp",
  },
  wfp_candidate_receipts: {
    artifact_sha256: "bytea",
    build_reused: "boolean",
    staged_at: "timestamp",
  },
  shared_gateway_route_revisions: {
    revision: "integer",
    predecessor_revision: "integer",
    active: "boolean",
    observed_at: "timestamp",
  },
  wfp_publish_receipts: {
    published_at: "timestamp",
    gateway_provider_tag: "bytea",
    gateway_module_sha256: "bytea",
    gateway_observed_at: "timestamp",
    gateway_egress_policy_sha256: "bytea",
    gateway_dev_access_key_id: "bytea",
    gateway_dev_access_public_key_sha256: "bytea",
    shared_gateway_revision: "integer",
  },
  deployment_revisions: {
    created_at: "timestamp",
  },
  wfp_rollback_activation_receipts: {
    activated_at: "timestamp",
    activated_head_version: "integer",
    gateway_provider_tag: "bytea",
    gateway_egress_policy_sha256: "bytea",
    gateway_dev_access_key_id: "bytea",
    gateway_dev_access_public_key_sha256: "bytea",
    gateway_module_sha256: "bytea",
    gateway_observed_at: "timestamp",
    shared_gateway_revision: "integer",
  },
  shared_gateway_address_receipts: {
    shared_gateway_revision: "integer",
    head_version: "integer",
    observed_at: "timestamp",
  },
  wfp_candidate_cleanup_requests: {
    requested_at: "timestamp",
  },
  wfp_candidate_cleanup_claims: {
    attempt_number: "integer",
    claimed_at: "timestamp",
    lease_expires_at: "timestamp",
  },
  wfp_candidate_cleanup_resource_expectations: {
    resource_identity_sha256: "bytea",
  },
  wfp_candidate_cleanup_receipts: {
    observed_at: "timestamp",
    shared_gateway_revision: "integer",
  },
};

function converted(rows, manifest) {
  for (const [name, sha256] of Object.entries(WFP_SCHEMA_PINS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("WFP_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, columns] of Object.entries(WFP_COLUMNS)) {
    const definition = manifest.tables.find((entry) => entry.name === table);
    if (
      !definition ||
      [...definition.columns.map((c) => c.name)].sort().join(",") !==
        columns.split(",").sort().join(",")
    )
      fail("WFP_SOURCE_COLUMNS");
    const originals = rows.get(table);
    if (!Array.isArray(originals)) fail("WFP_SOURCE_TABLE");
    for (const original of originals) {
      if (Object.keys(original).sort().join(",") !== columns.split(",").sort().join(","))
        fail("WFP_ROW_SHAPE");
      const row = { ...original };
      for (const name of columns.split(",")) {
        const kind = KINDS[table][name];
        const value = row[name];
        if (value === null) continue;
        if (typeof value !== "string") fail("WFP_ROW_VALUE");
        if (kind === "timestamp" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
          fail("WFP_TIMESTAMP_UNREPRESENTABLE");
        if (
          kind === "integer" &&
          (!/^-?(?:0|[1-9][0-9]*)$/u.test(value) ||
            BigInt(value) < -9223372036854775808n ||
            BigInt(value) > 9223372036854775807n)
        )
          fail("WFP_INTEGER_UNREPRESENTABLE");
        if (kind === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value))
          fail("WFP_BYTEA_UNREPRESENTABLE");
        if (kind === "boolean") {
          if (value !== "true" && value !== "false") fail("WFP_BOOLEAN_UNREPRESENTABLE");
          row[name] = value === "true" ? "1" : "0";
        }
      }
      records.push({ table, row });
    }
  }
  return records;
}

/** Original typed facts only: opaque evidence and sealed ciphertext/AAD identities are never rewritten. */
export async function readWfpSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(WFP_COLUMNS)) {
    const selected = columns.split(",").map((name) => {
      const kind = KINDS[table][name];
      return kind === "integer"
        ? `CAST(${name} AS TEXT) ${name}`
        : kind === "bytea"
          ? `CASE WHEN ${name} IS NULL THEN NULL ELSE lower(hex(${name})) END ${name}`
          : kind === "boolean"
            ? `CASE ${name} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END ${name}`
            : name;
    });
    const values = (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results;
    facts.set(
      table,
      values.map((original) => {
        return { ...original };
      }),
    );
  }
  return facts;
}

function identity(table, row) {
  const fields = {
    deployments: ["deployment_id"],
    deployment_revisions: ["revision_id"],
    wfp_candidate_receipts: ["candidate_receipt_id"],
    shared_gateway_route_revisions: ["organization_id", "project_id", "environment_id", "revision"],
    wfp_publish_receipts: ["wfp_receipt_id"],
    wfp_rollback_activation_receipts: ["rollback_activation_receipt_id"],
    shared_gateway_address_receipts: [
      "organization_id",
      "project_id",
      "environment_id",
      "operation_id",
    ],
    wfp_candidate_cleanup_requests: ["cleanup_request_id"],
    wfp_candidate_cleanup_claims: ["candidate_receipt_id"],
    wfp_candidate_cleanup_resource_expectations: [
      "cleanup_request_id",
      "provider",
      "resource_kind",
      "resource_identity_sha256",
    ],
    wfp_candidate_cleanup_receipts: ["cleanup_receipt_id"],
  }[table];
  return `${table}:${fields.map((field) => row[field]).join(":")}`;
}

function dependencies({ table, row }) {
  const refs = [];
  const add = (target, field, key = field) => {
    if (row[field] !== null) refs.push(identity(target, { [key]: row[field] }));
  };
  const route = (revision) => {
    if (revision !== null)
      refs.push(identity("shared_gateway_route_revisions", { ...row, revision }));
  };
  switch (table) {
    case "deployments":
      add("deployment_revisions", "active_revision_id", "revision_id");
      add("deployment_revisions", "rollback_target_revision_id", "revision_id");
      add("deployment_revisions", "promotion_source_revision_id", "revision_id");
      break;
    case "deployment_revisions":
      add("deployments", "deployment_id");
      add("wfp_publish_receipts", "wfp_receipt_id");
      break;
    case "wfp_candidate_receipts":
      add("deployments", "product_deployment_id", "deployment_id");
      break;
    case "shared_gateway_route_revisions":
      add("wfp_candidate_receipts", "candidate_receipt_id");
      route(row.predecessor_revision);
      break;
    case "wfp_publish_receipts":
      add("deployments", "product_deployment_id", "deployment_id");
      add("wfp_candidate_receipts", "candidate_receipt_id");
      route(row.shared_gateway_revision);
      break;
    case "wfp_rollback_activation_receipts":
      add("deployments", "rollback_deployment_id", "deployment_id");
      add("deployment_revisions", "target_revision_id", "revision_id");
      add("wfp_candidate_receipts", "candidate_receipt_id");
      add("wfp_publish_receipts", "wfp_receipt_id");
      route(row.shared_gateway_revision);
      break;
    case "shared_gateway_address_receipts":
      add("wfp_publish_receipts", "wfp_receipt_id");
      route(row.shared_gateway_revision);
      break;
    case "wfp_candidate_cleanup_resource_expectations":
      add("wfp_candidate_cleanup_requests", "cleanup_request_id");
      add("wfp_candidate_receipts", "candidate_receipt_id");
      break;
    case "wfp_candidate_cleanup_requests":
    case "wfp_candidate_cleanup_claims":
      add("wfp_candidate_receipts", "candidate_receipt_id");
      break;
    case "wfp_candidate_cleanup_receipts":
      add("wfp_candidate_receipts", "candidate_receipt_id");
      route(row.shared_gateway_revision);
      break;
  }
  return refs;
}

/**
 * Only actual retained FK cycles get a deferred transaction. Iterative SCC traversal has no history-depth cap;
 * immutable older deployments/routes remain topological. Within a cycle, native INSERT predicates still see
 * deployment→candidate→route→publication→revision in that order; no static trigger is suppressed.
 */
export function mapWfp(rows, manifest) {
  const records = converted(rows, manifest);
  const nodes = new Map();
  for (const record of records) {
    const key = identity(record.table, record.row);
    if (nodes.has(key)) fail("WFP_DUPLICATE_IDENTITY");
    nodes.set(key, record);
  }
  const graph = new Map(),
    reverse = new Map([...nodes.keys()].map((key) => [key, []]));
  for (const [key, record] of nodes) {
    const refs = [...new Set(dependencies(record))];
    if (refs.some((ref) => !nodes.has(ref))) fail("WFP_PARENT_UNREPRESENTABLE");
    graph.set(key, refs);
    for (const ref of refs) reverse.get(ref).push(key);
  }
  const visited = new Set(),
    finished = [];
  for (const first of [...nodes.keys()].sort()) {
    const stack = [[first, false]];
    while (stack.length) {
      const [key, exiting] = stack.pop();
      if (exiting) {
        finished.push(key);
        continue;
      }
      if (visited.has(key)) continue;
      visited.add(key);
      stack.push([key, true]);
      for (const next of graph.get(key)) if (!visited.has(next)) stack.push([next, false]);
    }
  }
  const groups = [],
    membership = new Map();
  for (const first of finished.reverse()) {
    if (membership.has(first)) continue;
    const index = groups.length,
      keys = [],
      stack = [first];
    membership.set(first, index);
    while (stack.length) {
      const key = stack.pop();
      keys.push(key);
      for (const next of reverse.get(key))
        if (!membership.has(next)) {
          membership.set(next, index);
          stack.push(next);
        }
    }
    groups.push(keys);
  }
  const needed = groups.map(() => new Set()),
    children = groups.map(() => []);
  for (const [key, refs] of graph)
    for (const ref of refs) {
      const child = membership.get(key),
        parent = membership.get(ref);
      if (child !== parent) needed[child].add(parent);
    }
  for (let child = 0; child < needed.length; child++)
    for (const parent of needed[child]) children[parent].push(child);
  const ready = needed.flatMap((parents, index) => (parents.size === 0 ? [index] : []));
  const result = [];
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const index = ready[cursor],
      keys = groups[index];
    const deferred = keys.length > 1 || graph.get(keys[0]).includes(keys[0]);
    keys.sort((left, right) => {
      const a = nodes.get(left),
        b = nodes.get(right);
      const order = WFP_TARGETS.indexOf(a.table) - WFP_TARGETS.indexOf(b.table);
      if (order) return order;
      if (a.table === "shared_gateway_route_revisions") {
        const delta = BigInt(a.row.revision) - BigInt(b.row.revision);
        if (delta !== 0n) return delta < 0n ? -1 : 1;
      }
      return left.localeCompare(right);
    });
    for (const key of keys)
      result.push({
        ...nodes.get(key),
        ...(deferred ? { atomicGroup: `wfp.cycle:${index}`, deferForeignKeys: true } : {}),
      });
    for (const child of children[index]) {
      needed[child].delete(index);
      if (needed[child].size === 0) ready.push(child);
    }
  }
  if (result.length !== records.length) fail("WFP_DEPENDENCY_GRAPH");
  return result;
}
