import { z } from "zod";
import { parseUlid, parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import type {
  ProductProviderReconciliationContext,
  ProductProviderReconciliationHint,
  ProductProviderMutationEvent,
  ProductProviderResourceState,
} from "@ohmyhost/database";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import * as q from "./context-queries.js";
import {
  activeReceipt,
  environmentName,
  handle,
  integer,
  text,
  wfpOf,
  type Row,
} from "./context-values.js";

const scopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  claimId: ulid,
});
type Scope = z.infer<typeof scopeInput>;
const BASE = `SELECT project.handle,environment.name environment_name,
 claim.event_id,claim.billing_epoch_id,claim.logical_workflow_id,claim.event_type,
 claim.accepted_lifecycle_version,intent.plan_id,intent.deployment_id,
 intent.target_deployment_id,intent.target_revision_id,run.intermediate_evidence,
 environment.active_deployment_id,environment.active_revision_id
 FROM product_provider_mutation_claims claim
 JOIN product_workflow_runs run ON run.workflow_id=claim.logical_workflow_id AND run.event_id=claim.event_id
 AND run.organization_id=claim.organization_id AND run.project_id=claim.project_id AND run.environment_id=claim.environment_id
 AND run.operation_id=claim.operation_id AND run.billing_epoch_id=claim.billing_epoch_id AND run.event_type=claim.event_type
 JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id
 AND intent.environment_id=claim.environment_id AND intent.operation_id=claim.operation_id AND intent.billing_epoch_id=claim.billing_epoch_id AND intent.event_type=claim.event_type
 JOIN deployments deployment ON deployment.organization_id=claim.organization_id AND deployment.project_id=claim.project_id
 AND deployment.operation_id=claim.operation_id AND deployment.deployment_id=intent.deployment_id
 JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id
 JOIN environments environment ON environment.organization_id=claim.organization_id AND environment.project_id=claim.project_id AND environment.environment_id=claim.environment_id
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
 WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.claim_id=?5
 AND run.state='reconciliation_required' AND deployment.status='reconciliation_required'
 AND operation.state IN('queued','running') AND project.lifecycle_state='active'
 AND project.lifecycle_version=claim.accepted_lifecycle_version AND project.owner_state='active'`;
const CANDIDATE = `SELECT candidate.dispatch_namespace,candidate.immutable_script_name,candidate.artifact_sha256,candidate.binding_set_digest,
 candidate.provider_tag,candidate.build_reused,candidate.staged_at,plan.framework_plan
 FROM wfp_candidate_receipts candidate LEFT JOIN deployment_plans plan ON plan.organization_id=candidate.organization_id
 AND plan.project_id=candidate.project_id AND plan.plan_id=?6
 WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.operation_id=?4 AND candidate.product_deployment_id=?5`;
const ROLLBACK_POLICY = `SELECT plan.framework_plan,COALESCE(run.terminal_evidence->'$.runtimePolicy',
 run.intermediate_evidence->'$.providerReconciliationHint.activationRuntimePolicy') runtime_policy
 FROM deployment_revisions revision JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
 LEFT JOIN environments environment ON environment.organization_id=revision.organization_id AND environment.project_id=revision.project_id AND environment.environment_id=?5
 AND environment.active_deployment_id=revision.deployment_id AND environment.active_revision_id=revision.revision_id
 LEFT JOIN wfp_rollback_activation_receipts activation ON activation.organization_id=environment.organization_id AND activation.project_id=environment.project_id
 AND activation.environment_id=environment.environment_id AND activation.activated_head_version=environment.head_version
 AND activation.target_deployment_id=revision.deployment_id AND activation.target_revision_id=revision.revision_id
 LEFT JOIN product_workflow_runs run ON run.organization_id=revision.organization_id AND run.project_id=revision.project_id AND run.environment_id=?5
 AND run.operation_id=COALESCE(activation.operation_id,revision.operation_id) AND run.state='completed'
 AND EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id AND operation.state='succeeded')
 WHERE revision.organization_id=?1 AND revision.project_id=?2 AND revision.deployment_id=?3 AND revision.revision_id=?4`;

const RESOURCE_STATES = `SELECT
       (SELECT state FROM build_source_uploads
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3
        ORDER BY created_at DESC LIMIT 1) source_state,
       (SELECT state FROM build_executions
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3
        ORDER BY created_at DESC LIMIT 1) build_state,
       EXISTS(SELECT 1 FROM build_input_reservations
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3) build_reserved,
       EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected
        WHERE expected.organization_id=?1 AND expected.project_id=?2 AND expected.operation_id=?3
          AND expected.provider='cloudflare' AND expected.resource_kind='source-archive')
       AND NOT EXISTS(
         SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected
         WHERE expected.organization_id=?1 AND expected.project_id=?2 AND expected.operation_id=?3
           AND expected.provider='cloudflare' AND expected.resource_kind='source-archive'
           AND NOT EXISTS(
             SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual
             WHERE actual.cleanup_request_id=expected.cleanup_request_id
               AND actual.candidate_receipt_id=expected.candidate_receipt_id
               AND actual.organization_id=expected.organization_id
               AND actual.project_id=expected.project_id
               AND actual.operation_id=expected.operation_id
               AND actual.provider=expected.provider AND actual.resource_kind=expected.resource_kind
               AND actual.resource_identity_sha256=expected.resource_identity_sha256)) source_cleaned,
       EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected
        WHERE expected.organization_id=?1 AND expected.project_id=?2 AND expected.operation_id=?3
          AND expected.provider='cloudflare' AND expected.resource_kind='build-artifact')
       AND NOT EXISTS(
         SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected
         WHERE expected.organization_id=?1 AND expected.project_id=?2 AND expected.operation_id=?3
           AND expected.provider='cloudflare' AND expected.resource_kind='build-artifact'
           AND NOT EXISTS(
             SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual
             WHERE actual.cleanup_request_id=expected.cleanup_request_id
               AND actual.candidate_receipt_id=expected.candidate_receipt_id
               AND actual.organization_id=expected.organization_id
               AND actual.project_id=expected.project_id
               AND actual.operation_id=expected.operation_id
               AND actual.provider=expected.provider AND actual.resource_kind=expected.resource_kind
               AND actual.resource_identity_sha256=expected.resource_identity_sha256)) build_cleaned`;

/** Fixed original reconciliation context. Every conditional raw projection is read in one native
 * snapshot. The server-local guard factory rechecks those exact facts in a consuming effect batch;
 * neither a prepared statement nor a callback crosses a Worker binding. No open-epoch restriction. */
export async function readProductProviderReconciliationPlan(
  context: CatalogContext,
  raw: unknown,
): Promise<{
  readonly value: ProductProviderReconciliationContext | null;
  guards(db: D1Database): D1PreparedStatement[];
}> {
  const input = scopeInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const scope = [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.claimId,
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    const initial = await db
      .prepare(BASE)
      .bind(...scope)
      .all();
    const base = initial.results[0];
    if (base === undefined) return { value: null, guards: () => [] };
    const specs = new Map<string, q.ContextRead>();
    const add = (key: string, sql: string, parameters: readonly unknown[]) =>
      specs.set(key, { sql, parameters });
    const env = [input.organizationId, input.projectId, input.environmentId];
    add("base", BASE, scope);
    add("known", q.KNOWN, env);
    add("runtime", q.RUNTIME_SECRET, env);
    add("resources", RESOURCE_STATES, [input.organizationId, input.projectId, input.operationId]);
    if (base["event_type"] === "DeploymentRollbackRequestedV1") {
      for (const [key, deployment, revision] of [
        ["target", base["target_deployment_id"], base["target_revision_id"]],
        ["retained", base["active_deployment_id"], base["active_revision_id"]],
      ] as const)
        if (deployment != null && revision != null) {
          add(key, q.RECEIPT, [...env, deployment, revision]);
          add(key + ":policy", ROLLBACK_POLICY, [
            input.organizationId,
            input.projectId,
            deployment,
            revision,
            input.environmentId,
          ]);
        }
    } else if (
      (base["event_type"] === "DeploymentRequestedV1" && base["plan_id"] !== null) ||
      base["event_type"] === "DeploymentPromotionRequestedV1"
    )
      add("candidate", CANDIDATE, [
        ...env,
        input.operationId,
        base["deployment_id"],
        base["plan_id"],
      ]);
    if (
      base["active_deployment_id"] === null &&
      base["active_revision_id"] === null &&
      (base["event_type"] === "DeploymentRequestedV1" ||
        base["event_type"] === "DeploymentPromotionRequestedV1")
    )
      add("abandoned", q.ABANDONED, [...env, input.operationId]);
    const reads = [...specs.values()],
      snapshot = await q.readContextSnapshot(db, reads);
    if (snapshot === null) continue;
    const rows = new Map([...specs.keys()].map((key, index) => [key, snapshot[index] ?? []]));
    if (JSON.stringify(rows.get("base")) !== JSON.stringify(initial.results)) continue;
    const value = await assemble(input, base, rows);
    return { value, guards: (target) => snapshotGuards(target, reads, snapshot) };
  }
  throw new ProductWorkflowContextConflictError(
    "Provider reconciliation context changed while reading",
  );
}
export async function readProductProviderReconciliationContext(
  context: CatalogContext,
  raw: unknown,
): Promise<ProductProviderReconciliationContext | null> {
  return (await readProductProviderReconciliationPlan(context, raw)).value;
}
/** Internal fixed-projection fact guards. Row multiplicity and every returned scalar/blob are
 * compared, so a concurrent insert, deletion, change or duplicate cannot authorize a stale effect. */
export function snapshotGuards(
  db: D1Database,
  reads: readonly q.ContextRead[],
  snapshot: readonly q.ContextRows[],
): D1PreparedStatement[] {
  return reads.flatMap(({ sql, parameters }, index) => {
    const rows = snapshot[index] ?? [],
      next = parameters.length + 1;
    const result = [
      guard(db, "operation_conflict", `(SELECT count(*) FROM (${sql}))<>?${next}`, [
        ...parameters,
        rows.length,
      ]),
    ];
    const seen = new Set<string>();
    for (const row of rows) {
      const identity = JSON.stringify(row, (_key, value) =>
        value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value,
      );
      if (seen.has(identity)) continue;
      seen.add(identity);
      const entries = Object.entries(row);
      if (entries.some(([key]) => !/^[_a-z0-9]+$/u.test(key)))
        throw new TypeError("Reconciliation projection has an invalid field");
      const equal = entries.map(([key], offset) => `"${key}" IS ?${next + offset}`).join(" AND ");
      const count = rows.filter(
        (other) =>
          JSON.stringify(other, (_key, value) =>
            value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value,
          ) === identity,
      ).length;
      result.push(
        guard(
          db,
          "operation_conflict",
          `(SELECT count(*) FROM (${sql}) WHERE ${equal})<>?${next + entries.length}`,
          [
            ...parameters,
            ...entries.map(([, value]) =>
              Array.isArray(value) &&
              value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
                ? Uint8Array.from(value as number[])
                : value,
            ),
            count,
          ],
        ),
      );
    }
    return result;
  });
}
async function assemble(
  input: Scope,
  base: Row,
  rows: ReadonlyMap<string, Row[]>,
): Promise<ProductProviderReconciliationContext> {
  const evidence = JSON.parse(text(base, "intermediate_evidence")) as unknown;
  const hint = isRecord(evidence) ? evidence["providerReconciliationHint"] : undefined;
  if (!isProviderReconciliationHint(hint))
    throw new TypeError("Persisted provider reconciliation hint is invalid");
  const projectHandle = handle(base["handle"]),
    name = environmentName(base["environment_name"]);
  const known = (rows.get("known") ?? []).map((row) =>
    wfpOf(row, input.projectId, input.environmentId),
  );
  const runtime = rows.get("runtime")?.[0];
  if (
    runtime !== undefined &&
    !known.some(
      (receipt) =>
        receipt.providerTag === runtime["provider_version_id"] &&
        receipt.productDeploymentId === runtime["deployment_id"],
    )
  )
    known.push(wfpOf(runtime, input.projectId, input.environmentId));
  const rollback = async (
    key: string,
    deployment: unknown,
    policyHint: ProductProviderReconciliationHint,
  ): Promise<ProductProviderReconciliationContext["wfpTarget"]> => {
    const receiptRow = rows.get(key)?.[0],
      plan = rows.get(key + ":policy")?.[0];
    if (receiptRow === undefined || plan === undefined || deployment == null) return null;
    const receipt = await activeReceipt(receiptRow, {
      projectId: input.projectId,
      environmentId: input.environmentId,
      deploymentId: String(deployment),
      handle: projectHandle,
      environmentName: name,
    });
    if (receipt === null) return null;
    const declared = parseNewProductionFrameworkPlan(JSON.parse(text(plan, "framework_plan")));
    return {
      candidate: receipt.wfp,
      gateway: receipt.gateway,
      runtimePolicy: parseNewProductionFrameworkPlan({
        ...declared,
        runtimePolicy:
          policyHint.activationRuntimePolicy ??
          (plan["runtime_policy"] == null ? null : JSON.parse(text(plan, "runtime_policy"))) ??
          declared.runtimePolicy,
      }).runtimePolicy,
    };
  };
  let target: ProductProviderReconciliationContext["wfpTarget"] = null,
    retained: ProductProviderReconciliationContext["wfpTarget"] = null;
  if (base["event_type"] === "DeploymentRollbackRequestedV1") {
    target = await rollback("target", base["target_deployment_id"], hint);
    retained = await rollback("retained", base["active_deployment_id"], { phase: "wfp" });
  } else {
    const candidates = rows.get("candidate") ?? [],
      candidate = candidates[0];
    if (candidates.length === 1 && candidate !== undefined) {
      const policy =
        hint.activationRuntimePolicy ??
        (candidate["framework_plan"] == null
          ? null
          : parseNewProductionFrameworkPlan(JSON.parse(text(candidate, "framework_plan")))
              .runtimePolicy);
      if (policy !== null)
        target = {
          candidate: wfpOf(
            {
              ...candidate,
              deployment_id: base["deployment_id"],
              script_name: candidate["immutable_script_name"],
              provider_version_id: candidate["provider_tag"],
              published_at: candidate["staged_at"],
            },
            input.projectId,
            input.environmentId,
          ),
          runtimePolicy: policy,
        };
    }
  }
  const abandoned = (rows.get("abandoned") ?? []).map((row) => {
    const plan = parseNewProductionFrameworkPlan(JSON.parse(text(row, "framework_plan")));
    const policy =
      row["runtime_policy"] == null
        ? plan.runtimePolicy
        : (JSON.parse(text(row, "runtime_policy")) ?? plan.runtimePolicy);
    return {
      candidateReceiptId: parseUlid(text(row, "candidate_receipt_id")),
      operationId: parseUlid(text(row, "operation_id")),
      candidate: wfpOf(
        {
          ...row,
          deployment_id: row["product_deployment_id"],
          script_name: row["immutable_script_name"],
          provider_version_id: row["provider_tag"],
          published_at: row["staged_at"],
        },
        input.projectId,
        input.environmentId,
      ),
      runtimePolicy: parseNewProductionFrameworkPlan({ ...plan, runtimePolicy: policy })
        .runtimePolicy,
    };
  });
  const resources = rows.get("resources")?.[0];
  const sourceState: ProductProviderResourceState =
    resources?.["source_cleaned"] === 1
      ? "absent"
      : resources?.["source_state"] === "uploading"
        ? "running"
        : resources?.["source_state"] === "completed"
          ? "ready"
          : resources?.["source_state"] === "reconciliation_required"
            ? "cleanup_failable"
            : resources?.["source_state"] === "aborted"
              ? "failed"
              : "absent";
  const buildState: ProductProviderResourceState =
    resources?.["build_cleaned"] === 1
      ? "absent"
      : ["pending", "running"].includes(String(resources?.["build_state"]))
        ? "running"
        : resources?.["build_state"] === "succeeded"
          ? "succeeded"
          : resources?.["build_state"] === "reconciliation_required"
            ? "cleanup_failable"
            : resources?.["build_state"] === "failed"
              ? "failed"
              : resources?.["build_reserved"] === 1
                ? "running"
                : "absent";
  const eventType = text(base, "event_type") as ProductProviderMutationEvent;
  return {
    claimId: parseUlid(input.claimId),
    organizationId: parseUlid(input.organizationId),
    projectId: parseUlid(input.projectId),
    environmentId: parseUlid(input.environmentId),
    operationId: parseUlid(input.operationId),
    handle: projectHandle,
    environmentName: name,
    eventId: parseUlid(text(base, "event_id")),
    billingEpochId: parseUlid(text(base, "billing_epoch_id")),
    logicalWorkflowId: text(base, "logical_workflow_id"),
    eventType,
    acceptedLifecycleVersion: integer(base["accepted_lifecycle_version"], 1),
    originalMessage: {
      version: 1,
      eventType,
      eventId: base["event_id"],
      organizationId: input.organizationId,
      projectId: input.projectId,
      billingEpochId: base["billing_epoch_id"],
      environmentId: input.environmentId,
      operationId: input.operationId,
      ...(eventType === "DeploymentRequestedV1" && base["plan_id"] !== null
        ? { planId: base["plan_id"] }
        : {}),
    },
    knownDeployments: known,
    hasActiveGateway: base["active_deployment_id"] != null || base["active_revision_id"] != null,
    ...(abandoned.length === 0 ? {} : { abandonedWfpTargets: abandoned }),
    wfpTarget: target,
    retainedWfpTarget: retained,
    providerHint: hint,
    sourceState,
    buildState,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderReconciliationHint(value: unknown): value is ProductProviderReconciliationHint {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.includes("phase") &&
    keys.every((key) =>
      [
        "activationRuntimePolicy",
        "currentProductDeploymentId",
        "currentProviderTag",
        "expectedArtifactDigest",
        "phase",
      ].includes(key),
    ) &&
    ["source", "build", "database", "runtime-secrets", "storage", "gateway", "wfp"].includes(
      String(value["phase"]),
    ) &&
    (value["expectedArtifactDigest"] === undefined ||
      (typeof value["expectedArtifactDigest"] === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(value["expectedArtifactDigest"]))) &&
    (value["currentProviderTag"] === undefined ||
      value["currentProviderTag"] === null ||
      (typeof value["currentProviderTag"] === "string" &&
        value["currentProviderTag"].trim() === value["currentProviderTag"] &&
        value["currentProviderTag"].length > 0 &&
        value["currentProviderTag"].length <= 255)) &&
    (value["currentProductDeploymentId"] === undefined ||
      (typeof value["currentProductDeploymentId"] === "string" &&
        /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value["currentProductDeploymentId"]))) &&
    (value["activationRuntimePolicy"] === undefined ||
      ((value["phase"] === "gateway" || value["phase"] === "wfp") &&
        isProviderReconciliationRuntimePolicy(value["activationRuntimePolicy"])))
  );
}

function isProviderReconciliationRuntimePolicy(value: unknown): value is Readonly<{
  readonly healthCheckPath: string;
  readonly egressAllowedOrigins: readonly string[];
  readonly browser?: BrowserPolicy;
}> {
  if (
    !isRecord(value) ||
    ![
      "egressAllowedOrigins,healthCheckPath",
      "browser,egressAllowedOrigins,healthCheckPath",
    ].includes(Object.keys(value).sort().join(","))
  ) {
    return false;
  }
  const path = value["healthCheckPath"];
  try {
    if (Object.hasOwn(value, "browser")) parseBrowserPolicy(value["browser"]);
  } catch {
    return false;
  }
  const origins = value["egressAllowedOrigins"];
  if (
    typeof path !== "string" ||
    path.length < 1 ||
    path.length > 256 ||
    !/^\/(?!\/)[^?#\\]*$/u.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..") ||
    !Array.isArray(origins) ||
    origins.length > 32
  ) {
    return false;
  }
  for (const [index, origin] of origins.entries()) {
    if (typeof origin !== "string" || (index > 0 && origin <= String(origins[index - 1]))) {
      return false;
    }
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export {
  findProductProviderReconciliationClaim,
  findClaimlessProductProviderReconciliationCandidate,
  readProductProviderReconciliationAttempt,
  prepareProductProviderReconciliation,
  recoverTerminalProductProviderReconciliationAttempt,
} from "./provider-reconciliation-commands.js";
