import { operationResult } from "./product-operation-result.js";
import { z } from "zod";
import {
  parseHostingRegion,
  parseNewProductionFrameworkPlan,
  parseUlid,
  type Clock,
  type UlidFactory,
} from "@ohmyhost/platform";
import { parseProjectHandle } from "@ohmyhost/project-handles";
import {
  DeploymentPersistenceConflictError,
  DeploymentMailDomainRequiredError,
  OrganizationCreditError,
  ProjectDomainDeletionRequiredError,
  ProjectR2BucketConflictError,
} from "@ohmyhost/database";
import {
  IdempotencyKeyReusedError,
  ProductSurfaceConflictError,
  type ProductSurfacePort,
} from "./contracts.js";
import { createProductSurfacePort, type SourceInspectorBinding } from "./product-surface.js";
import type { ProductSurfaceDataPort, ProductStatusFacts } from "./product-surface-data-port.js";
import type { ProjectDataChangesPort } from "./project-data-changes.js";
/** Every method is a named private domain capability. No callback, SQL, pool or clock factory crosses RPC. */
export interface D1ProductSurfaceRuntime {
  readApiProductStatus(input: unknown): Promise<unknown>;
  readApiProductProject(input: unknown): Promise<unknown>;
  readApiProductScope(input: unknown): Promise<unknown>;
  readApiPlanningSource(input: unknown): Promise<unknown>;
  readApiDeploymentPlan(input: unknown): Promise<unknown>;
  readApiProductDeployment(input: unknown): Promise<unknown>;
  readApiProductDeployments(input: unknown): Promise<unknown>;
  readApiPromotionEnvironments(input: unknown): Promise<unknown>;
  readApiPromotionTarget(input: unknown): Promise<unknown>;
  readApiDeletePlanTarget(input: unknown): Promise<unknown>;
  readApiRenameAdmission(input: unknown): Promise<unknown>;
  readApiDeletionAdmission(input: unknown): Promise<unknown>;
  readApiRollbackTarget(input: unknown): Promise<unknown>;
  issueApiActionConfirmation(input: unknown): Promise<unknown>;
  requireApiUsableConfirmation(input: unknown): Promise<unknown>;
  configureApiGithubAutoDeploy(input: unknown): Promise<unknown>;
  readApiGithubAutoDeploy(input: unknown): Promise<unknown>;
  createApiDeploymentPlan(input: unknown): Promise<unknown>;
  readApiProductReplay(input: unknown): Promise<unknown>;
  acceptApiProductOperation(input: unknown): Promise<unknown>;
}
export const D1_PRODUCT_SURFACE_METHODS = [
  "readApiProductStatus",
  "readApiProductProject",
  "readApiProductScope",
  "readApiPlanningSource",
  "readApiDeploymentPlan",
  "readApiProductDeployment",
  "readApiProductDeployments",
  "readApiPromotionEnvironments",
  "readApiPromotionTarget",
  "readApiDeletePlanTarget",
  "readApiRenameAdmission",
  "readApiDeletionAdmission",
  "readApiRollbackTarget",
  "issueApiActionConfirmation",
  "requireApiUsableConfirmation",
  "configureApiGithubAutoDeploy",
  "readApiGithubAutoDeploy",
  "createApiDeploymentPlan",
  "readApiProductReplay",
  "acceptApiProductOperation",
] as const;
export function isD1ProductSurfaceRuntime(value: unknown): value is D1ProductSurfaceRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    D1_PRODUCT_SURFACE_METHODS.every((m) => typeof Reflect.get(value, m) === "function")
  );
}
const id = z.string().transform(parseUlid),
  instant = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z
  .instanceof(Uint8Array)
  .refine((v) => v.byteLength === 32, "Product digest is invalid")
  .transform((v) => Buffer.from(v));
const deployment = z.strictObject({
  deploymentId: id,
  projectId: id,
  environmentId: id,
  operationId: id,
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  sourceDigest: digest,
  buildPlanDigest: digest,
  artifactDigest: digest.nullable(),
  buildCompletedAt: instant.optional(),
  mailRequired: z.boolean().optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "reconciliation_required"]),
  deploymentUrl: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
  activeVersion: counter,
  kind: z.enum(["deploy", "rollback", "promotion"]),
  isEnvironmentHead: z.boolean(),
  environmentHeadVersion: counter,
});
const activeScope = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  billingEpochId: id,
  lifecycleVersion: counter.min(1),
  headVersion: counter,
});
const planning = activeScope.extend({
  sourceConnectionId: id,
  grantId: id,
  provider: z.enum(["github", "managed"]),
  installationId: z.string().nullable(),
  externalRepositoryId: z.string(),
  repositoryOwner: z.string(),
  repositoryName: z.string(),
  grantedAt: instant,
  revoked: z.literal(false),
  sourceGeneration: counter.min(1),
  projectHandle: z.string().transform(parseProjectHandle),
  region: z.unknown().transform(parseHostingRegion),
  storageJurisdiction: z.enum(["eu", "us"]),
  environmentName: z.enum(["dev", "prod"]),
  publicOrigin: z.string(),
  dataMode: z.enum(["shared", "isolated"]),
});
const plan = z.strictObject({
  planId: id,
  sourceConnectionId: id,
  environmentId: id,
  billingEpochId: id,
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  planDigest: digest,
  sourceDigest: digest,
  buildPlanDigest: digest,
  runtime: z.string(),
  applicationRoot: z.string(),
  frameworkPlan: z.unknown().transform(parseNewProductionFrameworkPlan),
  expiresAt: instant,
  sourceGeneration: counter.min(1),
});
const promotion = z.strictObject({
  dataMode: z.enum(["shared", "isolated"]),
  databaseEnabled: z.boolean(),
  billingEpochId: id,
  sourceEnvironmentId: id,
  sourceDeploymentId: id,
  sourceRevisionId: id,
  sourceArtifactId: id,
  sourceArtifactDigest: digest,
  expectedSourceHeadVersion: counter,
  targetEnvironmentId: id,
  expectedTargetHeadVersion: counter,
});
const rollback = z.strictObject({
  deploymentId: id,
  environmentId: id,
  revisionId: id,
  artifactId: id,
  artifactDigest: digest,
  expectedHeadVersion: counter,
  dataEnvironmentId: id,
  assignmentVersion: counter.min(1),
  registrationVersion: counter,
  dataChanged: z.boolean(),
  dataChangeInProgress: z.boolean(),
});
const config = z.strictObject({
  organizationId: id,
  projectId: id,
  sourceConnectionId: id,
  branchRef: z.string(),
  generation: counter.min(1),
  enabled: z.boolean(),
  updatedAt: instant,
  grantActive: z.boolean(),
});
const accepted = z.strictObject({
  operationId: z.string().transform(parseUlid),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  createdAt: instant,
  updatedAt: instant,
  failure: z.strictObject({ code: z.string() }).nullable().optional(),
  failureDiagnostic: z.unknown().optional(),
});
const reconciliation = z.strictObject({
  state: z.enum(["required", "pending"]),
  attempt_id: id.nullable(),
  observed_at: instant,
});
const latest = z.strictObject({
  operation_id: id,
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  created_at: instant,
  updated_at: instant,
  failure_code: z.string().nullable(),
  failure_diagnostic: z.unknown(),
  blockingOperationId: id.nullable(),
  reconciliation: reconciliation.nullable(),
});
const status = z.strictObject({
  projection: z.record(z.string(), z.unknown()),
  customDomains: z
    .array(
      z.strictObject({
        hostname: z.string().min(1).max(253),
        environment: z.literal("prod"),
        state: z.enum(["awaiting_deployment", "pending", "active", "deleting"]),
      }),
    )
    .optional(),
  headDeployment: deployment.nullable(),
  latestOperation: latest.optional(),
  cleanupState: z.string().optional(),
});
const scope = (i: { readonly organizationId: string; readonly projectId: string }) => ({
  organizationId: i.organizationId,
  projectId: i.projectId,
});
function checkScope(
  i: { readonly organizationId: string; readonly projectId: string },
  result: { readonly organizationId: string; readonly projectId: string },
) {
  if (i.organizationId !== result.organizationId || i.projectId !== result.projectId)
    throw new Error("product_core_response_scope_invalid");
}
/** Closed refusal codes survive an actual Workers RPC error serialization. */
export async function productCoreCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const code =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined,
      message = error instanceof Error ? error.message : "",
      reason = typeof code === "string" ? code : message;
    if (reason === "idempotency_key_reused")
      throw new DeploymentPersistenceConflictError("Idempotency key was reused");
    if (reason === "deployment_persistence_conflict")
      throw new DeploymentPersistenceConflictError("Core product persistence conflict");
    if (reason === "mail_domain_required") throw new DeploymentMailDomainRequiredError();
    if (reason === "project_domain_delete_required") throw new ProjectDomainDeletionRequiredError();
    if (reason === "project_r2_bucket_conflict") throw new ProjectR2BucketConflictError();
    if (
      [
        "confirmation_invalid",
        "confirmation_expired",
        "data_change_in_progress",
        "rollback_target_data_changed",
        "native_domain_sync_pending",
        "database_limit_reached",
        "development_environment_missing",
        "auto_deploy_source_unavailable",
        "cutover_pending",
        "project_operation_in_progress",
      ].includes(reason)
    )
      throw new ProductSurfaceConflictError(
        reason as
          | "confirmation_invalid"
          | "confirmation_expired"
          | "data_change_in_progress"
          | "rollback_target_data_changed"
          | "native_domain_sync_pending"
          | "database_limit_reached"
          | "development_environment_missing"
          | "auto_deploy_source_unavailable"
          | "cutover_pending"
          | "project_operation_in_progress",
      );
    if (
      [
        "paid_plan_required",
        "insufficient_organization_credits",
        "project_budget_exceeded",
      ].includes(reason)
    )
      throw new OrganizationCreditError(
        reason as
          | "paid_plan_required"
          | "insufficient_organization_credits"
          | "project_budget_exceeded",
      );
    throw error;
  }
}
/** DataPort producers execute here, before the RPC. */
export function createD1ProductSurfaceDataPort(
  runtime: D1ProductSurfaceRuntime,
): ProductSurfaceDataPort {
  if (!isD1ProductSurfaceRuntime(runtime)) throw new Error("product_core_binding_required");
  const core = (method: (typeof D1_PRODUCT_SURFACE_METHODS)[number], input: unknown) =>
    productCoreCall(() => runtime[method](input));
  return {
    async readProjectStatus(i) {
      const raw = await core("readApiProductStatus", scope(i));
      if (raw === null) return null;
      const r = status.parse(raw);
      if (
        r.projection["project_id"] !== i.projectId ||
        (r.headDeployment !== null && r.headDeployment.projectId !== i.projectId)
      )
        throw new Error("product_core_response_scope_invalid");
      return {
        ...r,
        latestOperation: r.latestOperation,
        cleanupState: r.cleanupState,
      } as ProductStatusFacts;
    },
    async readProductProject(produce) {
      const i = produce(),
        raw = await core("readApiProductProject", scope(i));
      if (raw === null) return null;
      const r = z.record(z.string(), z.unknown()).parse(raw);
      if (r["project_id"] !== i.projectId) throw new Error("product_core_response_scope_invalid");
      return r;
    },
    async readScope(i) {
      const raw = await core("readApiProductScope", scope(i));
      if (raw === null) return null;
      const r = activeScope.parse(raw);
      checkScope(i, r);
      return r;
    },
    async readPlanningSource(i) {
      const raw = await core("readApiPlanningSource", {
        ...scope(i),
        ...(i.sourceConnectionId === undefined ? {} : { sourceConnectionId: i.sourceConnectionId }),
        ...(i.environmentName === undefined ? {} : { environmentName: i.environmentName }),
      });
      if (raw === null) return null;
      const r = planning.parse(raw);
      checkScope(i, r);
      if (i.sourceConnectionId !== undefined && i.sourceConnectionId !== r.sourceConnectionId)
        throw new Error("product_core_response_scope_invalid");
      if (i.environmentName !== undefined && i.environmentName !== r.environmentName)
        throw new Error("product_core_response_scope_invalid");
      return r;
    },
    async readDeploymentPlan(produce) {
      const i = produce(),
        raw = await core("readApiDeploymentPlan", {
          ...scope(i),
          planId: i.planId,
          readAt: i.readAt,
        });
      if (raw === null) return null;
      const r = plan.parse(raw);
      if (r.planId !== i.planId || r.applicationRoot !== r.frameworkPlan.applicationRoot)
        throw new Error("product_core_response_scope_invalid");
      return { ...r, applicationRoot: r.frameworkPlan.applicationRoot };
    },
    async readProductDeployment(produce) {
      const i = produce(),
        raw = await core("readApiProductDeployment", { ...scope(i), deploymentId: i.deploymentId });
      if (raw === null) return null;
      const r = deployment.parse(raw);
      if (r.projectId !== i.projectId || r.deploymentId !== i.deploymentId)
        throw new Error("product_core_response_scope_invalid");
      return r;
    },
    async readProductDeployments(produce) {
      const i = produce(),
        raw = await core("readApiProductDeployments", {
          ...scope(i),
          limit: i.limit,
          ...(i.cursor === undefined ? {} : { cursor: i.cursor }),
        });
      if (raw === null) return null;
      const r = z
        .strictObject({ items: z.array(deployment), nextCursor: id.nullable() })
        .parse(raw);
      if (r.items.length > i.limit || r.items.some((d) => d.projectId !== i.projectId))
        throw new Error("product_core_response_scope_invalid");
      return r;
    },
    async readPromotionEnvironments(i) {
      return z
        .strictObject({ sourceEnvironmentId: id, targetEnvironmentId: id })
        .nullable()
        .parse(await core("readApiPromotionEnvironments", scope(i)));
    },
    async readPromotionPlanTarget(produce) {
      const i = produce(),
        r = promotion.nullable().parse(
          await core("readApiPromotionTarget", {
            ...scope(i),
            sourceEnvironmentId: i.sourceEnvironmentId,
            targetEnvironmentId: i.targetEnvironmentId,
          }),
        );
      if (
        r !== null &&
        (r.sourceEnvironmentId !== i.sourceEnvironmentId ||
          r.targetEnvironmentId !== i.targetEnvironmentId)
      )
        throw new Error("product_core_response_scope_invalid");
      return r;
    },
    async readDeletePlanTarget(produce) {
      const i = produce();
      return z
        .strictObject({
          expectedProjectVersion: counter.min(1),
          expectedEtag: z.string(),
          managedRepositoryCount: counter,
          stagedSourceObjectCount: counter,
        })
        .nullable()
        .parse(await core("readApiDeletePlanTarget", scope(i)));
    },
    async readProjectRenameAdmission(produce) {
      const i = produce();
      return z
        .strictObject({
          environmentId: id,
          billingEpochId: id,
          lifecycleVersion: counter.min(1),
          handle: z.string(),
          busy: z.boolean(),
          nativeRecoveryPending: z.boolean(),
          nativePreparationPending: z.boolean(),
          taken: z.boolean(),
        })
        .nullable()
        .parse(await core("readApiRenameAdmission", { ...scope(i), handle: i.handle }));
    },
    async readProjectDeletionAdmission(produce) {
      const i = produce();
      return z
        .strictObject({
          environmentId: id,
          billingEpochId: id,
          expectedProjectVersion: counter.min(1),
          lifecycleState: z.enum(["active", "deleting"]),
          previousOperationId: id.nullable(),
        })
        .nullable()
        .parse(
          await core("readApiDeletionAdmission", {
            ...scope(i),
            ...(i.acceptingOperationId === undefined
              ? {}
              : { acceptingOperationId: i.acceptingOperationId }),
          }),
        );
    },
    async readRollbackTargetForDeployment(i) {
      const r = rollback
        .nullable()
        .parse(await core("readApiRollbackTarget", { ...scope(i), deploymentId: i.deploymentId }));
      if (r !== null && r.deploymentId !== i.deploymentId)
        throw new Error("product_core_response_scope_invalid");
      return r;
    },
    async issueActionConfirmation(produce) {
      const i = produce();
      return z.enum(["created", "existing"]).parse(await core("issueApiActionConfirmation", i));
    },
    async requireUsableConfirmation(i) {
      z.undefined().parse(await core("requireApiUsableConfirmation", i));
    },
    async configureGithubAutoDeployIdempotently(produce) {
      const i = produce(),
        r = config.nullable().parse(await core("configureApiGithubAutoDeploy", i));
      if (r !== null) checkScope(i, r);
      return r;
    },
    async readGithubAutoDeployConfig(produce) {
      const i = produce(),
        r = config.nullable().parse(await core("readApiGithubAutoDeploy", scope(i)));
      if (r !== null) checkScope(i, r);
      return r;
    },
    async createDeploymentPlan(produce) {
      const i = produce();
      return z.enum(["created", "existing"]).parse(await core("createApiDeploymentPlan", i));
    },
    async replayAcceptedOperation(i, httpMethod, routeTemplate) {
      try {
        const r = accepted.nullable().parse(
          await core("readApiProductReplay", {
            organizationId: i.organizationId,
            principalId: i.principalId,
            httpMethod,
            routeTemplate,
            idempotencyKey: i.idempotencyKey,
            canonicalRequestDigest: i.canonicalRequestDigest,
          }),
        );
        return r === null ? null : operationResult(r);
      } catch (error) {
        // The original lookup answers a key reused for another request with its own closed refusal.
        if (error instanceof DeploymentPersistenceConflictError)
          throw new IdempotencyKeyReusedError();
        throw error;
      }
    },
    async acceptProductOperation(produce) {
      const i = produce();
      return accepted.parse(await core("acceptApiProductOperation", i));
    },
  };
}
export function createD1ProductSurfacePort(input: {
  readonly runtime: D1ProductSurfaceRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly sourceInspector: SourceInspectorBinding;
  readonly dataChanges: ProjectDataChangesPort;
}): ProductSurfacePort {
  return createProductSurfacePort({
    ...input,
    persistence: createD1ProductSurfaceDataPort(input.runtime),
  });
}
