import { z } from "zod";
import { parseHostingRegion, parseNewProductionFrameworkPlan, parseUlid } from "@ohmyhost/platform";
import type {
  ProductWorkflowContext,
  ProductWorkflowDeletionEnvironment,
  ProductWorkflowDeletionDataEnvironment,
  ProductWorkflowSourceArchive,
} from "@ohmyhost/database";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import {
  ProductWorkflowContextConflictError,
  WORKFLOW_TARGET,
  WORKFLOW_REGISTRATION,
  WORKFLOW_PLACEMENT,
  workflowDatabaseTargetFromRows,
} from "./context.js";
import * as q from "./context-queries.js";
import { validDeletionEnvironmentSet } from "./deletion-environments.js";
import {
  activeReceipt,
  artifactOf,
  bytes,
  environmentName,
  handle,
  hex,
  integer,
  intentOf,
  iso,
  nullableText,
  outputOf,
  resourceHash,
  text,
  wfpOf,
  type ProductWorkflowWireIntent,
  type Row,
} from "./context-values.js";

/** Worker RPC transports native bytes, never Node Buffer methods. The application restores those
 * three original intent Buffer fields before passing this otherwise unchanged DTO to its domain. */
export type ProductWorkflowWireContext = Omit<ProductWorkflowContext, "intent"> & {
  readonly intent: ProductWorkflowWireIntent;
};
const scopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
});
type Scope = z.infer<typeof scopeInput>;
type Snapshot = ReadonlyMap<string, Row[]>;
function requireFact<Value>(value: Value | null | undefined): Value {
  if (value == null)
    throw new ProductWorkflowContextConflictError("Workflow context evidence is missing");
  return value;
}
const first = (snapshot: Snapshot, key: string) => snapshot.get(key)?.[0];
const rows = (snapshot: Snapshot, key: string) => snapshot.get(key) ?? [];

/** The full original product Workflow context, assembled only from a single native D1 snapshot.
 * Planning counts only size raw-row pages. No caller SQL, provider capability or history cap exists. */
export async function readProductWorkflowContext(
  context: CatalogContext,
  raw: unknown,
): Promise<ProductWorkflowWireContext | null> {
  const scope = scopeInput.parse(raw),
    { db } = await routeOrganization(context, scope.organizationId);
  const parameters = [
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    scope.operationId,
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    const plannedRows = await q.readContextSnapshot(db, [
      { sql: q.INTENT, parameters },
      { sql: q.BASE, parameters },
      { sql: q.WORKFLOW_ENVIRONMENTS, parameters },
      { sql: q.DATA_ENVIRONMENTS, parameters: [scope.organizationId, scope.projectId] },
    ]);
    if (plannedRows === null) continue;
    const planned = plannedRows.map((results) => ({ results }));
    const intentRow = planned[0]?.results[0],
      base = planned[1]?.results[0];
    if (intentRow === undefined || base === undefined) return null;
    const intent = intentOf(intentRow);
    if (!validBase(base, intent)) return null;
    const specs = new Map<string, q.ContextRead>();
    const add = (key: string, sql: string, parameters: readonly unknown[]) =>
      specs.set(key, { sql, parameters });
    add("intent", q.INTENT, parameters);
    add("base", q.BASE, parameters);
    add("environments", q.WORKFLOW_ENVIRONMENTS, parameters);
    add("data", q.DATA_ENVIRONMENTS, [scope.organizationId, scope.projectId]);
    add("mail", q.MAIL, [scope.organizationId, scope.projectId, scope.environmentId]);
    if (intent.planId !== null)
      add("plan", q.PLAN, [scope.organizationId, scope.projectId, intent.planId]);
    if (intent.sourceConnectionId !== null)
      add("grant", q.GRANT, [scope.organizationId, scope.projectId, intent.sourceConnectionId]);
    const deletionLike =
      intent.eventType === "ProjectDeletionRequestedV1" ||
      intent.eventType === "ProjectDataChangeRequestedV1";
    const projectEnvironments =
      deletionLike || intent.eventType === "ProjectHandleChangeRequestedV1";
    const inventory = deletionLike || intent.bindingRefreshSnapshot != null;
    if (inventory || projectEnvironments)
      add("inventory", q.INVENTORY, [scope.organizationId, scope.projectId, scope.operationId]);
    if (intent.eventType === "SourceLinkRequestedV1")
      add("consent", q.CONSENT, [
        ...parameters,
        intent.billingEpochId,
        intent.installationId,
        intent.repositoryOwner,
        intent.repositoryName,
      ]);
    addEnvironmentReads(add, "current", scope, base, intent, !deletionLike);
    if (intent.targetDeploymentId !== null && intent.targetRevisionId !== null)
      add("rollback", q.ARTIFACT, [
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        intent.targetDeploymentId,
        intent.targetRevisionId,
      ]);
    if (intent.bindingRefreshSnapshot != null)
      add("refresh", q.ARTIFACT, [
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        intent.bindingRefreshSnapshot.sourceDeploymentId,
        intent.bindingRefreshSnapshot.sourceRevisionId,
      ]);
    if (intent.eventType === "DeploymentPromotionRequestedV1") {
      if (!validPromotion(intent, base)) return null;
      const source = [
        scope.organizationId,
        scope.projectId,
        intent.sourceEnvironmentId,
        intent.sourceDeploymentId,
        intent.sourceRevisionId,
      ];
      add("sourceHead", q.SOURCE_HEAD, [...source, intent.expectedSourceHeadVersion]);
      add("promotionFence", q.PROMOTION_FENCE, [
        ...source,
        intent.sourceArtifactId,
        intent.sourceArtifactDigest,
        intent.expectedSourceHeadVersion,
      ]);
      add("promotionArtifact", q.ARTIFACT, source);
      add("promotionReceipt", q.RECEIPT, source);
    }
    if (projectEnvironments)
      for (const row of planned[2]?.results ?? []) {
        const environmentId = text(row, "environment_id");
        addEnvironmentReads(add, environmentId, { ...scope, environmentId }, row, intent, false);
        if (row["active_deployment_id"] != null && row["active_revision_id"] != null)
          add(`${environmentId}:policy`, q.POLICY, [
            scope.organizationId,
            scope.projectId,
            row["active_deployment_id"],
            row["active_revision_id"],
          ]);
        add(`${environmentId}:r2`, q.R2, [scope.organizationId, scope.projectId, environmentId]);
        add(`${environmentId}:builds`, q.DELETION_ARTIFACTS, [
          scope.organizationId,
          scope.projectId,
          environmentId,
        ]);
      }
    if (intent.eventType === "ProjectDeletionRequestedV1")
      for (const row of planned[3]?.results ?? []) {
        const identity = text(row, "data_environment_id"),
          params = [scope.organizationId, scope.projectId, identity];
        add(`${identity}:target`, WORKFLOW_TARGET, params);
        add(`${identity}:registration`, WORKFLOW_REGISTRATION, params);
        add(`${identity}:placement`, WORKFLOW_PLACEMENT, params);
      }
    const values = await q.readContextSnapshot(db, [...specs.values()]);
    if (values === null) continue;
    const snapshot = new Map(
      [...specs.keys()].map((key, index) => [key, requireFact(values[index])]),
    );
    // The base and identities used to plan conditional reads must be exactly this snapshot's facts.
    if (
      ["intent", "base", "environments", "data"].some(
        (key, index) =>
          JSON.stringify(snapshot.get(key)) !== JSON.stringify(planned[index]?.results),
      )
    )
      continue;
    return assemble(snapshot, scope);
  }
  throw new ProductWorkflowContextConflictError("Workflow context changed while reading");
}
function validBase(base: Row, intent: ProductWorkflowWireIntent): boolean {
  return (
    (base["data_mode"] === "shared" || base["data_mode"] === "isolated") &&
    base["lifecycle_state"] ===
      (intent.eventType === "ProjectDeletionRequestedV1" ? "deleting" : "active") &&
    base["ownership_state"] === "active"
  );
}
function validPromotion(intent: ProductWorkflowWireIntent, base: Row): boolean {
  return (
    intent.sourceEnvironmentId !== null &&
    intent.sourceDeploymentId !== null &&
    intent.sourceRevisionId !== null &&
    intent.sourceArtifactId !== null &&
    intent.sourceArtifactDigest !== null &&
    intent.expectedSourceHeadVersion !== null &&
    intent.expectedTargetHeadVersion !== null &&
    base["environment_name"] === "prod"
  );
}
function addEnvironmentReads(
  add: (key: string, sql: string, parameters: readonly unknown[]) => unknown,
  key: string,
  scope: Scope,
  base: Row,
  intent: ProductWorkflowWireIntent,
  artifacts: boolean,
): void {
  const params = [scope.organizationId, scope.projectId, scope.environmentId];
  add(`${key}:known`, q.KNOWN, params);
  add(`${key}:runtime`, q.RUNTIME_SECRET, params);
  add(`${key}:archives`, q.ARCHIVES, params);
  add(`${key}:secrets`, q.SECRETS, params);
  if (artifacts) add(`${key}:artifacts`, q.ARTIFACTS, params);
  if (base["active_deployment_id"] != null && base["active_revision_id"] != null)
    add(`${key}:active`, q.RECEIPT, [
      ...params,
      base["active_deployment_id"],
      base["active_revision_id"],
    ]);
  if (
    key === "current" &&
    base["active_deployment_id"] == null &&
    base["active_revision_id"] == null &&
    (intent.eventType === "DeploymentRequestedV1" ||
      intent.eventType === "DeploymentPromotionRequestedV1")
  )
    add("abandoned", q.ABANDONED, [...params, scope.operationId]);
}
function known(snapshot: Snapshot, key: string, scope: Scope) {
  const result = rows(snapshot, `${key}:known`).map((row) =>
    wfpOf(row, scope.projectId, scope.environmentId),
  );
  const runtime = first(snapshot, `${key}:runtime`);
  if (
    runtime !== undefined &&
    !result.some(
      (receipt) =>
        receipt.providerTag === runtime["provider_version_id"] &&
        receipt.productDeploymentId === runtime["deployment_id"],
    )
  )
    result.push(wfpOf(runtime, scope.projectId, scope.environmentId));
  return result;
}
async function receipt(
  snapshot: Snapshot,
  key: string,
  scope: Scope,
  base: Row,
  projectHandle: string,
  name: "dev" | "prod",
) {
  const deploymentId = nullableText(base, "active_deployment_id");
  return deploymentId === null || base["active_revision_id"] == null
    ? null
    : activeReceipt(first(snapshot, `${key}:active`), {
        ...scope,
        deploymentId,
        handle: projectHandle,
        environmentName: name,
      });
}
function inventoryOf(snapshot: Snapshot): ProductWorkflowContext["deletionInventory"] {
  return rows(snapshot, "inventory").map((row) => ({
    resourceRecordId: parseUlid(text(row, "resource_record_id")),
    provider: text(row, "provider"),
    resourceKind: text(row, "resource_kind"),
    externalRefHash: bytes(row["external_ref_hash"]),
    cleanupLocator: text(row, "cleanup_locator"),
    ...(row["cleanup_outcome"] === "removed" || row["cleanup_outcome"] === "not_found"
      ? { cleanupOutcome: row["cleanup_outcome"] }
      : {}),
  }));
}
async function removed(
  snapshot: Snapshot,
  provider: string,
  kind: string,
  locator: string,
): Promise<boolean> {
  const hash = await resourceHash(provider, kind, locator);
  return rows(snapshot, "inventory").some(
    (row) =>
      row["provider"] === provider &&
      row["resource_kind"] === kind &&
      hex(row["external_ref_hash"]) === hash &&
      (row["cleanup_outcome"] === "removed" || row["cleanup_outcome"] === "not_found"),
  );
}
async function archives(
  snapshot: Snapshot,
  key: string,
  scope: Scope,
  deleting: boolean,
): Promise<ProductWorkflowSourceArchive[]> {
  const result: ProductWorkflowSourceArchive[] = [];
  for (const row of rows(snapshot, `${key}:archives`)) {
    const bucket = text(row, "bucket_name"),
      objectKey = text(row, "object_key"),
      versionId = text(row, "object_version_id");
    const provider = /^ohmyho-(poc-private-fullstack|production)-build-[0-9]{12}-[a-z0-9-]+$/u.test(
      bucket,
    )
      ? "aws"
      : "cloudflare";
    if (
      deleting &&
      (await removed(snapshot, provider, "source-object", `${bucket}/${objectKey}/${versionId}`))
    )
      continue;
    result.push({
      bucket,
      key: objectKey,
      versionId,
      eTag: text(row, "object_etag"),
      byteLength: integer(row["byte_length"], 1),
      scope: {
        projectId: parseUlid(scope.projectId),
        environmentId: parseUlid(scope.environmentId),
        operationId: parseUlid(text(row, "operation_id")),
      },
      sourceSha256: hex(row["sha256"]),
    });
  }
  return result;
}
async function deletionBuilds(
  snapshot: Snapshot,
  key: string,
  scope: Scope,
): Promise<ProductWorkflowDeletionEnvironment["deletionBuildArtifacts"]> {
  const result: ProductWorkflowDeletionEnvironment["deletionBuildArtifacts"][number][] = [];
  for (const row of rows(snapshot, `${key}:builds`)) {
    const ref = text(row, "object_version_ref");
    if (
      await removed(
        snapshot,
        ref.startsWith("s3-version:") ? "aws" : "cloudflare",
        "build-artifact",
        ref,
      )
    )
      continue;
    result.push({
      artifactId: parseUlid(text(row, "artifact_id")),
      buildExecutionId: parseUlid(text(row, "build_execution_id")),
      artifactDigest: `sha256:${hex(row["artifact_sha256"])}`,
      output: outputOf(
        ref,
        {
          projectId: parseUlid(scope.projectId),
          environmentId: parseUlid(scope.environmentId),
          operationId: parseUlid(text(row, "operation_id")),
        },
        false,
      ),
    });
  }
  return result;
}
function r2Of(row: Row | undefined): ProductWorkflowDeletionEnvironment["r2Bucket"] {
  if (row === undefined) return null;
  if (row["jurisdiction"] !== "eu" && row["jurisdiction"] !== "us")
    throw new TypeError("Project R2 bucket jurisdiction is invalid");
  return {
    organizationId: parseUlid(text(row, "organization_id")),
    projectId: parseUlid(text(row, "project_id")),
    environmentId: parseUlid(text(row, "environment_id")),
    operationId: parseUlid(text(row, "operation_id")),
    claimId: parseUlid(text(row, "claim_id")),
    bucketName: text(row, "bucket_name"),
    bucketId: text(row, "provider_bucket_id"),
    jurisdiction: row["jurisdiction"],
    storageClass: "Standard",
    publicAccess: false,
    observedAt: new Date(text(row, "observed_at")),
  };
}
async function deletionEnvironments(
  snapshot: Snapshot,
  scope: Scope,
  projectHandle: string,
): Promise<ProductWorkflowDeletionEnvironment[]> {
  const environments = rows(snapshot, "environments");
  if (!validDeletionEnvironmentSet(environments))
    throw new ProductWorkflowContextConflictError("Project deletion environment set is invalid");
  const result: ProductWorkflowDeletionEnvironment[] = [];
  for (const row of environments) {
    const environmentId = parseUlid(text(row, "environment_id")),
      name = environmentName(row["name"]),
      envScope = { ...scope, environmentId };
    const active = await receipt(snapshot, environmentId, envScope, row, projectHandle, name),
      policy = first(snapshot, `${environmentId}:policy`);
    result.push({
      environmentId,
      environmentName: name,
      headVersion: integer(row["head_version"]),
      activeDeploymentId:
        row["active_deployment_id"] == null ? null : parseUlid(text(row, "active_deployment_id")),
      activeRevisionId:
        row["active_revision_id"] == null ? null : parseUlid(text(row, "active_revision_id")),
      activeDeployment: active?.wfp ?? null,
      activeGateway: active?.gateway ?? null,
      activeRuntimePolicy:
        policy?.["framework_plan"] == null
          ? null
          : parseNewProductionFrameworkPlan(JSON.parse(text(policy, "framework_plan")))
              .runtimePolicy,
      wfpDeployments: known(snapshot, environmentId, envScope),
      environmentSecretCount: integer(first(snapshot, `${environmentId}:secrets`)?.["count"]),
      artifactExpectations: [],
      sourceArchives: await archives(snapshot, environmentId, envScope, true),
      r2Bucket: r2Of(first(snapshot, `${environmentId}:r2`)),
      deletionBuildArtifacts: await deletionBuilds(snapshot, environmentId, envScope),
    });
  }
  return result;
}
function deletionDataEnvironments(
  snapshot: Snapshot,
  scope: Scope,
): ProductWorkflowDeletionDataEnvironment[] {
  return rows(snapshot, "data").map((row) => {
    const identity = text(row, "data_environment_id");
    return workflowDatabaseTargetFromRows(
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        physicalEnvironmentId: identity,
      },
      first(snapshot, `${identity}:target`) as unknown as Parameters<
        typeof workflowDatabaseTargetFromRows
      >[1],
      first(snapshot, `${identity}:registration`) as unknown as Parameters<
        typeof workflowDatabaseTargetFromRows
      >[2],
      first(snapshot, `${identity}:placement`) as unknown as Parameters<
        typeof workflowDatabaseTargetFromRows
      >[3],
    );
  });
}
function sourceGrant(
  snapshot: Snapshot,
  intent: ProductWorkflowWireIntent,
): ProductWorkflowContext["sourceGrant"] {
  const row = first(snapshot, "grant");
  if (row === undefined || intent.sourceConnectionId === null) return null;
  const provider = text(row, "provider");
  if (provider !== "github" && provider !== "managed")
    throw new TypeError("Persisted source provider is invalid");
  return {
    sourceConnectionId: intent.sourceConnectionId,
    grantId: parseUlid(text(row, "grant_id")),
    provider,
    installationId: nullableText(row, "github_installation_id"),
    externalRepositoryId: text(row, "external_repository_id"),
    repositoryOwner: text(row, "repository_owner"),
    repositoryName: text(row, "repository_name"),
    grantedAt: iso(row["granted_at"]),
    revoked: false,
    sourceGeneration: integer(row["source_generation"], 1),
  };
}
async function assemble(
  snapshot: Snapshot,
  scope: Scope,
): Promise<ProductWorkflowWireContext | null> {
  const base = requireFact(first(snapshot, "base")),
    intent = intentOf(requireFact(first(snapshot, "intent")));
  const projectHandle = handle(base["handle"]),
    name = environmentName(base["environment_name"]),
    headVersion = integer(base["head_version"]);
  const promotionStale =
    intent.eventType !== "DeploymentPromotionRequestedV1"
      ? null
      : rows(snapshot, "sourceHead").length !== 1
        ? "source"
        : headVersion !== intent.expectedTargetHeadVersion
          ? "target"
          : null;
  if (
    intent.eventType === "DeploymentPromotionRequestedV1" &&
    promotionStale === null &&
    rows(snapshot, "promotionFence").length !== 1
  )
    return null;
  const promotionRow = first(snapshot, "promotionArtifact");
  const promotionArtifact =
    intent.eventType === "DeploymentPromotionRequestedV1" &&
    promotionStale === null &&
    promotionRow !== undefined
      ? artifactOf(promotionRow, scope.projectId, requireFact(intent.sourceEnvironmentId), true)
      : null;
  if (
    intent.eventType === "DeploymentPromotionRequestedV1" &&
    promotionStale === null &&
    promotionArtifact === null
  )
    return null;
  const promotionSource =
    intent.eventType === "DeploymentPromotionRequestedV1" && promotionStale === null
      ? await activeReceipt(first(snapshot, "promotionReceipt"), {
          projectId: scope.projectId,
          environmentId: requireFact(intent.sourceEnvironmentId),
          deploymentId: requireFact(intent.sourceDeploymentId),
          handle: projectHandle,
          environmentName: "dev",
        })
      : null;
  if (
    intent.eventType === "DeploymentPromotionRequestedV1" &&
    promotionStale === null &&
    (promotionSource === null ||
      intent.sourceArtifactDigest === null ||
      promotionSource.wfp.artifactDigest !== `sha256:${hex(intent.sourceArtifactDigest)}`)
  )
    return null;
  const plan = first(snapshot, "plan");
  const frameworkPlan =
    plan?.["framework_plan"] == null
      ? null
      : parseNewProductionFrameworkPlan(JSON.parse(text(plan, "framework_plan")));
  if (intent.eventType === "DeploymentRequestedV1" && frameworkPlan === null) return null;
  const deleting =
    intent.eventType === "ProjectDeletionRequestedV1" ||
    intent.eventType === "ProjectDataChangeRequestedV1";
  const inventory = deleting || intent.bindingRefreshSnapshot != null ? inventoryOf(snapshot) : [];
  if (intent.eventType === "ProjectDeletionRequestedV1" && inventory.length === 0) return null;
  const active = await receipt(snapshot, "current", scope, base, projectHandle, name);
  const rollback = first(snapshot, "rollback"),
    refresh = first(snapshot, "refresh");
  const abandoned = rows(snapshot, "abandoned").map((row) => {
    const plan = parseNewProductionFrameworkPlan(JSON.parse(text(row, "framework_plan"))),
      policy =
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
        scope.projectId,
        scope.environmentId,
      ),
      runtimePolicy: parseNewProductionFrameworkPlan({ ...plan, runtimePolicy: policy })
        .runtimePolicy,
    };
  });
  const consent = first(snapshot, "consent");
  return {
    ...(consent === undefined ? {} : { authorizedRepositoryId: text(consent, "repository_id") }),
    handle: projectHandle,
    environmentName: name,
    intent,
    dataMode: base["data_mode"] as "shared" | "isolated",
    region: parseHostingRegion(base["region"]),
    projectLifecycleVersion: integer(base["lifecycle_version"], 1),
    headVersion,
    sourceGrant: sourceGrant(snapshot, intent),
    knownDeployments: known(snapshot, "current", scope),
    ...(abandoned.length === 0 ? {} : { abandonedWfpTargets: abandoned }),
    rollbackArtifact:
      rollback === undefined
        ? null
        : artifactOf(rollback, scope.projectId, scope.environmentId, true),
    promotionArtifact,
    bindingRefreshArtifact:
      refresh === undefined
        ? null
        : artifactOf(refresh, scope.projectId, scope.environmentId, true),
    bindingRefreshPublished:
      intent.bindingRefreshSnapshot != null &&
      base["active_deployment_id"] === intent.deploymentId &&
      base["active_revision_id"] === scope.operationId,
    bindingRefreshCompleted:
      intent.bindingRefreshSnapshot != null &&
      base["workflow_state"] === "completed" &&
      base["operation_state"] === "succeeded",
    promotionSourceDeployment: promotionSource?.wfp ?? null,
    artifactExpectations: deleting
      ? []
      : rows(snapshot, "current:artifacts").map((row) =>
          artifactOf(row, scope.projectId, scope.environmentId),
        ),
    activeDeploymentId:
      base["active_deployment_id"] == null ? null : parseUlid(text(base, "active_deployment_id")),
    activeDeployment: active?.wfp ?? null,
    activeGateway: active?.gateway ?? null,
    deletionEnvironments:
      deleting || intent.eventType === "ProjectHandleChangeRequestedV1"
        ? await deletionEnvironments(snapshot, scope, projectHandle)
        : [],
    deletionDataEnvironments:
      intent.eventType === "ProjectDeletionRequestedV1"
        ? deletionDataEnvironments(snapshot, scope)
        : [],
    deletionInventory: inventory,
    environmentSecretCount: integer(first(snapshot, "current:secrets")?.["count"]),
    acceptedAt: iso(base["accepted_at"]),
    sourceArchives: await archives(snapshot, "current", scope, deleting),
    frameworkPlan,
    mailDomain:
      first(snapshot, "mail") === undefined
        ? null
        : text(requireFact(first(snapshot, "mail")), "domain"),
    ...(promotionStale === null ? {} : { promotionStale }),
  };
}
