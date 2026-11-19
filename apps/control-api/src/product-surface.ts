import { operationResult } from "./product-operation-result.js";
export { operationResult } from "./product-operation-result.js";
import {
  publicOperationFailure,
  publicOperationReconciliation,
} from "@ohmyhost/contracts/operation-failure";
import {
  classifyFrameworkVersion,
  parseFrameworkConversionDiagnostic,
  type FrameworkConversionDiagnostic,
} from "@ohmyhost/contracts/framework-admission";
import { createHash, randomBytes } from "node:crypto";
import { assertManagedSourceResponse } from "@ohmyhost/contracts/managed-sources";
import type { ProjectDataChangesPort } from "./project-data-changes.js";
import type { ProductSurfaceDataPort, ProductStatusFacts } from "./product-surface-data-port.js";

import canonicalize from "canonicalize";
import {
  DeploymentPersistenceConflictError,
  DeploymentMailDomainRequiredError,
  acceptProductApiOperation,
  DEPLOYMENT_PLAN_TTL_MILLISECONDS,
  readDeploymentPlan,
  type BuildInputClaimRequest,
  type BuildInputClaimResult,
  type ConsumeActionConfirmationInput,
  type PersistedBuildReceiptEnvelope,
  type BuildUsageInput,
  type ProductDeploymentRead,
  type PromotionPlanTarget,
} from "@ohmyhost/database";
import {
  parseHostingRegion,
  parseNewProductionFrameworkPlan,
  parseUlid,
  quoteBuildCost,
  type Clock,
  type ProductionFrameworkPlan,
  type Ulid,
  type UlidFactory,
} from "@ohmyhost/platform";
import { projectHandleProblem, projectEnvironmentAddress } from "@ohmyhost/project-handles";

import {
  IdempotencyKeyReusedError,
  ProductSurfaceConflictError,
  SourceAdmissionPolicyInconsistentError,
  type ProductSurfaceConflictReason,
  type ProductSurfaceContext,
  type ProductSurfaceMutationContext,
  type ProductSurfacePort,
  type ProductSurfaceResult,
} from "./contracts.js";

const RESOURCE_EFFECTS = Object.freeze([
  "Build the exact Git commit and publish a new immutable deployment version.",
]);
const DEPLOYMENT_LIMITS = Object.freeze(["The build is limited to 8 minutes."]);
const DEPLOYMENT_RISKS = Object.freeze([
  "Deployment may fail if the project no longer produces its validated deployable artifact.",
  'Pages run under a nonce Content-Security-Policy: inline <style>, style="" attributes and inline scripts without the x-nonce value are blocked in the browser.',
]);
/** Generation 0 with null fields: this project never configured push-to-deploy. */
const NEVER_CONFIGURED_AUTO_DEPLOY = Object.freeze({
  branch: null,
  ref: null,
  environment: "dev",
  enabled: false,
  generation: 0,
  grant_status: null,
  updated_at: null,
});
const PROD_DEPLOYMENT_RISKS = Object.freeze([
  ...DEPLOYMENT_RISKS,
  "This builds straight into Prod: Prod traffic switches to the new version once it is activated.",
]);

export interface SourceInspectorBinding {
  validateRepositoryLink(input: unknown): Promise<unknown>;
  inspectExact(input: unknown): Promise<unknown>;
}

export class ProductSurfaceUnavailableError extends Error {
  constructor() {
    super("Product surface provider execution is unavailable");
    this.name = "ProductSurfaceUnavailableError";
  }
}

export function createUnavailableProductSurfacePort(): ProductSurfacePort {
  const unavailable = async (): Promise<never> => {
    throw new ProductSurfaceUnavailableError();
  };
  return Object.freeze({
    getProjectStatus: unavailable,
    getSource: unavailable,
    configureAutoDeploy: unavailable,
    getAutoDeploy: unavailable,
    planDeployment: unavailable,
    createDeployment: unavailable,
    listDeployments: unavailable,
    getDeployment: unavailable,
    planRollback: unavailable,
    rollback: unavailable,
    changeProjectHandle: unavailable,
    planPromotion: unavailable,
    promote: unavailable,
    planDelete: unavailable,
    deleteProject: unavailable,
  });
}

/** Public product orchestration over a closed data port. */
export function createProductSurfacePort(input: {
  readonly persistence: ProductSurfaceDataPort;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly sourceInspector: SourceInspectorBinding;
  readonly dataChanges: ProjectDataChangesPort;
}): ProductSurfacePort {
  const unavailable = createUnavailableProductSurfacePort();
  const dataChanges = input.dataChanges;
  const port: ProductSurfacePort = {
    ...unavailable,
    planDataChange: dataChanges.plan,
    changeData: dataChanges.change,
    async getProjectStatus(context) {
      const facts = await input.persistence.readProjectStatus(context);
      return facts === null ? null : productStatusResult(context, facts);
    },
    async getSource(context: ProductSurfaceContext): Promise<ProductSurfaceResult | null> {
      const projection = await input.persistence.readProductProject(() => context);
      if (projection === null || projection["lifecycle_state"] !== "active") return null;
      const source = projection["source"];
      if (!isRecord(source)) return null;
      return { status: 200, body: publicSourceBody(source) };
    },
    async configureAutoDeploy(request) {
      try {
        const configured = await input.persistence.configureGithubAutoDeployIdempotently(() => ({
          organizationId: request.organizationId,
          projectId: request.projectId,
          principalId: request.principalId,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: request.canonicalRequestDigest,
          operationId: input.ids.next(),
          queuedEventId: input.ids.next(),
          succeededEventId: input.ids.next(),
          auditEventId: input.ids.next(),
          branchRef: request.branchRef,
          enabled: request.enabled,
          configuredAt: canonicalNow(input.clock),
        }));
        return configured === null ? null : { status: 200, body: publicAutoDeploy(configured) };
      } catch (error) {
        // Only the Core's idempotency refusal is a key reuse; any other persistence conflict is retried, not refused.
        if (
          error instanceof DeploymentPersistenceConflictError &&
          error.message.includes("Idempotency")
        ) {
          throw new IdempotencyKeyReusedError();
        }
        throw error;
      }
    },
    async getAutoDeploy(context) {
      const configured = await input.persistence.readGithubAutoDeployConfig(() => context);
      return {
        status: 200,
        body: configured === null ? NEVER_CONFIGURED_AUTO_DEPLOY : publicAutoDeploy(configured),
      };
    },
    async planDeployment(request) {
      const now = canonicalNow(input.clock);
      const planId = input.ids.next();
      const operationId = input.ids.next();
      const source = await input.persistence.readPlanningSource({
        ...request,
        ...(request.environment === undefined ? {} : { environmentName: request.environment }),
      });
      if (source === null) {
        if (request.environment === "dev") {
          const project = await input.persistence.readProductProject(() => ({
            organizationId: request.organizationId,
            projectId: request.projectId,
          }));
          const environments = project?.["environments"];
          const onlyEnvironment =
            Array.isArray(environments) && environments.length === 1 ? environments[0] : null;
          if (
            isRecord(onlyEnvironment) &&
            onlyEnvironment["name"] === "prod" &&
            typeof onlyEnvironment["id"] === "string"
          ) {
            parseUlid(onlyEnvironment["id"]);
            throw new ProductSurfaceConflictError("development_environment_missing");
          }
        }
        throw new ProductSurfaceUnavailableError();
      }
      const environmentName = source.environmentName;
      let rawInspection: unknown;
      try {
        const sourceRequest = {
          provider: "managed",
          organizationId: request.organizationId,
          billingEpochId: source.billingEpochId,
          projectId: request.projectId,
          environmentId: source.environmentId,
          operationId,
          idempotencyKey: request.requestId,
          sourceConnectionId: source.sourceConnectionId,
          region: source.region,
          repository: {
            owner: source.repositoryOwner,
            name: source.repositoryName,
            externalRepositoryId: source.externalRepositoryId,
          },
          commitSha: request.commitSha,
          grant: {
            status: "approved",
            grantId: source.grantId,
            organizationId: request.organizationId,
            billingEpochId: source.billingEpochId,
            projectId: request.projectId,
            sourceConnectionId: source.sourceConnectionId,
            installationId: null,
            repositoryId: source.externalRepositoryId,
            owner: source.repositoryOwner,
            repository: source.repositoryName,
            permission: "contents:read",
            grantedAt: source.grantedAt,
            revokedAt: null,
          },
        };
        if (source.provider === "managed") {
          rawInspection = await input.sourceInspector.inspectExact(sourceRequest);
        } else {
          rawInspection = await input.sourceInspector.inspectExact({
            organizationId: request.organizationId,
            billingEpochId: source.billingEpochId,
            projectId: request.projectId,
            environmentId: source.environmentId,
            operationId,
            idempotencyKey: request.requestId,
            sourceConnectionId: source.sourceConnectionId,
            repository: {
              owner: source.repositoryOwner,
              name: source.repositoryName,
              externalRepositoryId: source.externalRepositoryId,
            },
            commitSha: request.commitSha,
            grant: {
              status: "approved",
              grantId: source.grantId,
              organizationId: request.organizationId,
              billingEpochId: source.billingEpochId,
              projectId: request.projectId,
              sourceConnectionId: source.sourceConnectionId,
              installationId: safeProviderInteger(source.installationId ?? ""),
              repositoryId: safeProviderInteger(source.externalRepositoryId),
              owner: source.repositoryOwner,
              repository: source.repositoryName,
              permission: "contents:read",
              grantedAt: source.grantedAt,
              revokedAt: null,
            },
          });
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          ["requested_commit_not_found", "source_commit_not_found"].includes(
            String(Reflect.get(error, "code")),
          )
        ) {
          throw new ProductSurfaceConflictError("source_commit_not_found");
        }
        if (isWorkersRuntimeIncompatible(error)) {
          throw new ProductSurfaceConflictError("workers_runtime_incompatible");
        }
        const refusal = frameworkConversionRefusal(error);
        if (refusal !== null) {
          if (refusal.diagnostic !== null && !frameworkVersionPoliciesAgree(refusal.diagnostic))
            throw new SourceAdmissionPolicyInconsistentError();
          throw new ProductSurfaceConflictError(
            "framework_conversion_required",
            refusal.diagnostic,
          );
        }
        if (
          typeof error === "object" &&
          error !== null &&
          Reflect.get(error, "code") === "source_repository_configuration_missing"
        ) {
          throw new ProductSurfaceConflictError("repository_configuration_missing");
        }
        if (isMigrationFilenameNoncanonical(error)) {
          throw new ProductSurfaceConflictError("migration_filename_noncanonical");
        }
        throw error;
      }
      const inspection = parseInspection(rawInspection, request.commitSha);
      if (
        inspection.frameworkPlan.storage.enabled &&
        inspection.frameworkPlan.storage.jurisdiction !== source.storageJurisdiction
      ) {
        throw new ProductSurfaceConflictError("storage_jurisdiction_conflict");
      }
      const risks =
        environmentName === "prod"
          ? [
              ...PROD_DEPLOYMENT_RISKS,
              ...(source.dataMode === "shared" && inspection.frameworkPlan.database.enabled
                ? ["Dev and Prod share data; database migrations affect both environments."]
                : []),
            ]
          : DEPLOYMENT_RISKS;
      const runtime =
        inspection.frameworkPlan.runtime !== "static"
          ? "cloudflare_workers_edge_ssr"
          : "cloudflare_workers_static_assets";
      const costEstimate = quoteBuildCost(now);
      const body = Object.freeze({
        id: planId,
        project_id: request.projectId,
        environment: environmentName,
        commit_sha: request.commitSha,
        source_digest: `sha256:${inspection.sourceSha256}`,
        build_plan_digest: `sha256:${inspection.buildPlanSha256}`,
        application_root: inspection.frameworkPlan.applicationRoot,
        runtime,
        route: source.publicOrigin,
        resource_effects: RESOURCE_EFFECTS,
        limits: Object.freeze([
          ...DEPLOYMENT_LIMITS,
          ...(inspection.frameworkPlan.adapter === "nextjs"
            ? [
                `Private prerender cache is limited to ${(inspection.frameworkPlan.ssgCacheMaxBytes ?? 32 * 1024 * 1024) / (1024 * 1024)} MiB; ordinary public assets retain their separate 25 MiB limit.`,
                "Prerender cache storage has zero supplier cost and costs 0 credits including the 50% markup; build and Worker execution fees still apply.",
                "The compressed artifact is limited to 30 MiB and its expanded archive to 64 MiB; cache, public assets, Worker modules and metadata must fit this combined limit.",
              ]
            : []),
        ]),
        estimated_cost: costEstimate,
        risks,
        destructive_effects: Object.freeze([]),
        required_confirmations: Object.freeze([]),
        created_at: now,
        expires_at: new Date(Date.parse(now) + DEPLOYMENT_PLAN_TTL_MILLISECONDS).toISOString(),
      });
      try {
        await input.persistence.createDeploymentPlan(() => ({
          planId,
          organizationId: request.organizationId,
          projectId: request.projectId,
          environmentId: source.environmentId,
          sourceConnectionId: source.sourceConnectionId,
          sourceGeneration: source.sourceGeneration,
          commitSha: request.commitSha,
          sourceDigest: digestBytes(inspection.sourceSha256),
          buildPlanDigest: digestBytes(inspection.buildPlanSha256),
          planDigest: sha256Bytes(canonical(body)),
          runtime,
          frameworkPlan: inspection.frameworkPlan,
          impacts: RESOURCE_EFFECTS,
          risks,
          costEstimate,
          createdAt: now,
        }));
      } catch (error) {
        if (error instanceof DeploymentMailDomainRequiredError) {
          throw new ProductSurfaceConflictError("mail_domain_required");
        }
        throw error;
      }
      return { status: 200, body };
    },
    async createDeployment(request) {
      const replay = await input.persistence.replayAcceptedOperation(
        request,
        "POST",
        "/v1/projects/{project_id}/deployments",
      );
      if (replay !== null) return replay;
      const now = canonicalNow(input.clock);
      let plan: Awaited<ReturnType<typeof readDeploymentPlan>>;
      try {
        plan = await input.persistence.readDeploymentPlan(() => ({
          organizationId: request.organizationId,
          projectId: request.projectId,
          planId: request.planId,
          readAt: now,
        }));
      } catch (error) {
        if (error instanceof TypeError)
          throw new ProductSurfaceConflictError("deployment_plan_incompatible");
        throw error;
      }
      if (plan === null) throw new ProductSurfaceConflictError("deployment_plan_expired");
      return acceptOperation(input, request, {
        operationId: input.ids.next(),
        environmentId: plan.environmentId,
        billingEpochId: plan.billingEpochId,
        eventType: "DeploymentRequestedV1",
        httpMethod: "POST",
        routeTemplate: "/v1/projects/{project_id}/deployments",
        planId: request.planId,
        planDigest: plan.planDigest,
        deploymentId: input.ids.next(),
      });
    },
    async listDeployments(request) {
      if ((await input.persistence.readScope(request)) === null) {
        throw new ProductSurfaceUnavailableError();
      }
      const page = await input.persistence.readProductDeployments(() => ({
        organizationId: request.organizationId,
        projectId: request.projectId,
        ...(request.cursor === undefined ? {} : { cursor: parseUlid(request.cursor) }),
        limit: request.limit,
      }));
      if (page === null) throw new ProductSurfaceUnavailableError();
      return {
        status: 200,
        body: {
          items: page.items.map(publicDeployment),
          ...(page.nextCursor === null ? {} : { next_cursor: page.nextCursor }),
        },
      };
    },
    async getDeployment(request) {
      if ((await input.persistence.readScope(request)) === null) return null;
      const deployment = await input.persistence.readProductDeployment(() => ({
        organizationId: request.organizationId,
        projectId: request.projectId,
        deploymentId: request.deploymentId,
      }));
      if (deployment === null) return null;
      const body = publicDeployment(deployment);
      return { status: 200, body, etag: strongEtag(body) };
    },
    async planRollback(request) {
      const now = canonicalNow(input.clock);
      const target = await input.persistence.readRollbackTargetForDeployment({
        organizationId: request.organizationId,
        projectId: request.projectId,
        deploymentId: request.targetDeploymentId,
      });
      if (target === null) return null;
      if (target.dataChangeInProgress)
        throw new ProductSurfaceConflictError("data_change_in_progress");
      if (target.dataChanged) throw new ProductSurfaceConflictError("rollback_target_data_changed");
      const resourceEtag = strongEtag({
        environmentId: target.environmentId,
        headVersion: target.expectedHeadVersion,
        dataEnvironmentId: target.dataEnvironmentId,
        assignmentVersion: target.assignmentVersion,
        registrationVersion: target.registrationVersion,
      });
      const confirmationToken = validateConfirmationToken(randomBytes(32).toString("base64url"));
      await input.persistence.issueActionConfirmation(() => ({
        confirmationId: input.ids.next(),
        organizationId: request.organizationId,
        projectId: request.projectId,
        issuedToPrincipalId: request.principalId,
        action: "rollback",
        targetDeploymentId: request.targetDeploymentId,
        subjectEtag: resourceEtag,
        tokenDigest: sha256Bytes(confirmationToken),
        issuedAt: now,
      }));
      return {
        status: 200,
        body: {
          action: "rollback",
          project_id: request.projectId,
          target_deployment_id: request.targetDeploymentId,
          target_artifact_digest: digestString(target.artifactDigest),
          resource_etag: resourceEtag,
          effects: ["Activate the selected immutable deployment artifact without a new build."],
          risks: ["Requests will immediately use the selected earlier deployment version."],
          confirmation_token: confirmationToken,
          created_at: now,
          expires_at: new Date(Date.parse(now) + 600_000).toISOString(),
        },
      };
    },
    async rollback(request) {
      const replay = await input.persistence.replayAcceptedOperation(
        request,
        "POST",
        "/v1/projects/{project_id}/deployments/{deployment_id}:rollback",
      );
      if (replay !== null) return replay;
      const scope = await input.persistence.readScope(request);
      if (scope === null) return null;
      const target = await input.persistence.readRollbackTargetForDeployment({
        organizationId: request.organizationId,
        projectId: request.projectId,
        deploymentId: request.targetDeploymentId,
      });
      if (target === null) return null;
      if (target.dataChangeInProgress)
        throw new ProductSurfaceConflictError("data_change_in_progress");
      if (target.dataChanged) throw new ProductSurfaceConflictError("rollback_target_data_changed");
      const expectedEtag = strongEtag({
        environmentId: target.environmentId,
        headVersion: target.expectedHeadVersion,
        dataEnvironmentId: target.dataEnvironmentId,
        assignmentVersion: target.assignmentVersion,
        registrationVersion: target.registrationVersion,
      });
      if (request.ifMatch !== expectedEtag) throw new ProductSurfaceConflictError("etag_mismatch");
      await input.persistence.requireUsableConfirmation({
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        action: "rollback",
        targetDeploymentId: request.targetDeploymentId,
        subjectEtag: expectedEtag,
        tokenDigest: sha256Bytes(request.confirmationToken),
        now: canonicalNow(input.clock),
      });
      return acceptOperation(input, request, {
        operationId: input.ids.next(),
        environmentId: target.environmentId,
        billingEpochId: scope.billingEpochId,
        eventType: "DeploymentRollbackRequestedV1",
        httpMethod: "POST",
        routeTemplate: "/v1/projects/{project_id}/deployments/{deployment_id}:rollback",
        deploymentId: input.ids.next(),
        targetDeploymentId: request.targetDeploymentId,
        targetRevisionId: target.revisionId,
        targetArtifactId: target.artifactId,
        expectedHeadVersion: target.expectedHeadVersion,
        expectedDataEnvironmentId: target.dataEnvironmentId,
        expectedAssignmentVersion: target.assignmentVersion,
        expectedRegistrationVersion: target.registrationVersion,
        expectedEtag,
        confirmation: {
          organizationId: request.organizationId,
          projectId: request.projectId,
          issuedToPrincipalId: request.principalId,
          action: "rollback",
          targetDeploymentId: request.targetDeploymentId,
          subjectEtag: expectedEtag,
          tokenDigest: sha256Bytes(request.confirmationToken),
          consumedAt: canonicalNow(input.clock),
        },
      });
    },
    async planPromotion(request) {
      const now = canonicalNow(input.clock);
      const environments = await input.persistence.readPromotionEnvironments(request);
      if (environments === null) return null;
      const target = await input.persistence.readPromotionPlanTarget(() => ({
        organizationId: request.organizationId,
        projectId: request.projectId,
        sourceEnvironmentId: environments.sourceEnvironmentId,
        targetEnvironmentId: environments.targetEnvironmentId,
      }));
      if (target === null) throw new ProductSurfaceConflictError("promotion_invalid_target");
      if (target.sourceDeploymentId !== request.sourceDeploymentId) {
        throw new ProductSurfaceConflictError("promotion_source_stale");
      }
      const resourceEtag = promotionEtag(target);
      const confirmationToken = promotionConfirmationToken(target);
      await input.persistence.issueActionConfirmation(() => ({
        confirmationId: input.ids.next(),
        organizationId: request.organizationId,
        projectId: request.projectId,
        issuedToPrincipalId: request.principalId,
        action: "promote",
        targetDeploymentId: request.sourceDeploymentId,
        subjectEtag: resourceEtag,
        tokenDigest: sha256Bytes(confirmationToken),
        issuedAt: now,
      }));
      return {
        status: 200,
        body: {
          action: "promote",
          project_id: request.projectId,
          source_deployment_id: request.sourceDeploymentId,
          source_artifact_digest: digestString(target.sourceArtifactDigest),
          source_environment: "dev",
          target_environment: "prod",
          resource_etag: resourceEtag,
          effects: [
            "Activate the verified dev artifact in prod without rebuilding.",
            ...(target.databaseEnabled
              ? [
                  target.dataMode === "isolated"
                    ? "Apply missing verified SQL migrations to the separate prod database; do not copy dev data or credentials."
                    : "Keep the explicitly shared database and file namespace; dev schema/data changes already affect prod.",
                ]
              : []),
          ],
          risks: [
            "Production requests use the promoted artifact after activation.",
            ...(target.databaseEnabled && target.dataMode === "isolated"
              ? [
                  "The separate prod database adds measured compute/storage consumption. Unsupported or conflicting migrations stop activation.",
                ]
              : []),
          ],
          confirmation_token: confirmationToken,
          created_at: now,
          expires_at: new Date(Date.parse(now) + 600_000).toISOString(),
        },
      };
    },
    async promote(request) {
      const routeTemplate = "/v1/projects/{project_id}/deployments/{source_deployment_id}:promote";
      const replay = await input.persistence.replayAcceptedOperation(
        request,
        "POST",
        routeTemplate,
      );
      if (replay !== null) return replay;
      const environments = await input.persistence.readPromotionEnvironments(request);
      if (environments === null) return null;
      const target = await input.persistence.readPromotionPlanTarget(() => ({
        organizationId: request.organizationId,
        projectId: request.projectId,
        sourceEnvironmentId: environments.sourceEnvironmentId,
        targetEnvironmentId: environments.targetEnvironmentId,
      }));
      if (target === null) throw new ProductSurfaceConflictError("promotion_invalid_target");
      if (target.sourceDeploymentId !== request.sourceDeploymentId) {
        throw new ProductSurfaceConflictError("promotion_source_stale");
      }
      const plannedHeads = parsePromotionConfirmationToken(request.confirmationToken);
      if (plannedHeads === null) {
        throw new ProductSurfaceConflictError("confirmation_invalid");
      }
      if (plannedHeads.sourceHeadVersion !== target.expectedSourceHeadVersion) {
        throw new ProductSurfaceConflictError("promotion_source_stale");
      }
      if (plannedHeads.targetHeadVersion !== target.expectedTargetHeadVersion) {
        throw new ProductSurfaceConflictError("promotion_target_stale");
      }
      const expectedEtag = promotionEtag(target);
      if (request.ifMatch !== expectedEtag) {
        throw new ProductSurfaceConflictError("etag_mismatch");
      }
      await input.persistence.requireUsableConfirmation({
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        action: "promote",
        targetDeploymentId: request.sourceDeploymentId,
        subjectEtag: expectedEtag,
        tokenDigest: sha256Bytes(request.confirmationToken),
        now: canonicalNow(input.clock),
      });
      try {
        return await acceptOperation(input, request, {
          operationId: input.ids.next(),
          environmentId: target.targetEnvironmentId,
          billingEpochId: target.billingEpochId,
          eventType: "DeploymentPromotionRequestedV1",
          httpMethod: "POST",
          routeTemplate,
          deploymentId: input.ids.next(),
          sourceEnvironmentId: target.sourceEnvironmentId,
          sourceDeploymentId: target.sourceDeploymentId,
          sourceRevisionId: target.sourceRevisionId,
          sourceArtifactId: target.sourceArtifactId,
          sourceArtifactDigest: target.sourceArtifactDigest,
          expectedSourceHeadVersion: target.expectedSourceHeadVersion,
          expectedHeadVersion: target.expectedTargetHeadVersion,
          expectedEtag,
          confirmation: {
            organizationId: request.organizationId,
            projectId: request.projectId,
            issuedToPrincipalId: request.principalId,
            action: "promote",
            targetDeploymentId: request.sourceDeploymentId,
            subjectEtag: expectedEtag,
            tokenDigest: sha256Bytes(request.confirmationToken),
            consumedAt: canonicalNow(input.clock),
          },
        });
      } catch (error) {
        if (
          error instanceof ProductSurfaceConflictError &&
          error.reason === "confirmation_invalid"
        ) {
          const current = await input.persistence.readPromotionPlanTarget(() => ({
            organizationId: request.organizationId,
            projectId: request.projectId,
            sourceEnvironmentId: environments.sourceEnvironmentId,
            targetEnvironmentId: environments.targetEnvironmentId,
          }));
          if (current === null || current.sourceDeploymentId !== request.sourceDeploymentId) {
            throw new ProductSurfaceConflictError("promotion_source_stale");
          }
          if (current.expectedSourceHeadVersion !== plannedHeads.sourceHeadVersion) {
            throw new ProductSurfaceConflictError("promotion_source_stale");
          }
          if (current.expectedTargetHeadVersion !== plannedHeads.targetHeadVersion) {
            throw new ProductSurfaceConflictError("promotion_target_stale");
          }
        }
        throw error;
      }
    },
    async planDelete(request) {
      const now = canonicalNow(input.clock);
      const target = await input.persistence.readDeletePlanTarget(() => request);
      if (target === null) return null;
      const resourceEtag = strongEtag({
        projectId: request.projectId,
        version: target.expectedProjectVersion,
      });
      const confirmationToken = validateConfirmationToken(randomBytes(32).toString("base64url"));
      await input.persistence.issueActionConfirmation(() => ({
        confirmationId: input.ids.next(),
        organizationId: request.organizationId,
        projectId: request.projectId,
        issuedToPrincipalId: request.principalId,
        action: "delete",
        subjectEtag: resourceEtag,
        tokenDigest: sha256Bytes(confirmationToken),
        issuedAt: now,
      }));
      return {
        status: 200,
        body: {
          action: "delete",
          project_id: request.projectId,
          resource_etag: resourceEtag,
          effects: [
            "Delete Dev and Prod with their deployments, databases, files, function schedules and stored SQL exports.",
            "Remove the domain routes ohmyho.st created for this project. A workspace mail domain stays until it is retired.",
            ...(target.managedRepositoryCount > 0 || target.stagedSourceObjectCount > 0
              ? [
                  `Delete ${target.managedRepositoryCount} managed Git ${target.managedRepositoryCount === 1 ? "repository" : "repositories"} with saved code history and ${target.stagedSourceObjectCount} staged source ${target.stagedSourceObjectCount === 1 ? "object" : "objects"}.`,
                ]
              : []),
          ],
          risks: [
            "This cannot be undone: both addresses stop answering and the project's data is removed. Download a SQL export and needed application files first if the data matters.",
          ],
          confirmation_token: confirmationToken,
          created_at: now,
          expires_at: new Date(Date.parse(now) + 600_000).toISOString(),
        },
      };
    },
    async changeProjectHandle(request) {
      const routeTemplate = "/v1/projects/{project_id}/handle";
      const replay = await input.persistence.replayAcceptedOperation(request, "PUT", routeTemplate);
      if (replay !== null) return replay;
      if (projectHandleProblem(request.handle) !== null)
        throw new ProductSurfaceConflictError("project_handle_invalid");
      const target = await input.persistence.readProjectRenameAdmission(() => request);
      if (target === null) return null;
      // A deployment in flight moves the same gateways, so a rename waits for it.
      if (target.busy || target.nativePreparationPending)
        throw new ProductSurfaceConflictError("project_rename_blocked");
      // Renaming to the address the project already has is not a change to make.
      if (target.handle === request.handle && !target.nativeRecoveryPending)
        throw new ProductSurfaceConflictError("project_handle_unchanged");
      // The unique address is the authority, but refusing here saves a gateway round trip.
      if (target.taken) throw new ProductSurfaceConflictError("project_handle_taken");
      const expectedEtag = strongEtag({
        handle: target.handle,
        projectId: request.projectId,
        version: target.lifecycleVersion,
      });
      if (request.ifMatch !== expectedEtag) throw new ProductSurfaceConflictError("etag_mismatch");
      return acceptOperation(input, request, {
        operationId: input.ids.next(),
        environmentId: target.environmentId,
        billingEpochId: target.billingEpochId,
        eventType: "ProjectHandleChangeRequestedV1",
        httpMethod: "PUT",
        routeTemplate,
        requestedHandle: request.handle,
        expectedEtag,
      });
    },
    async deleteProject(request) {
      const replay = await input.persistence.replayAcceptedOperation(
        request,
        "DELETE",
        "/v1/projects/{project_id}",
      );
      if (replay !== null) return replay;
      const target = await input.persistence.readProjectDeletionAdmission(() => request);
      if (target === null) return null;
      const expectedEtag = strongEtag({
        projectId: request.projectId,
        version: target.expectedProjectVersion,
      });
      if (request.ifMatch !== expectedEtag) throw new ProductSurfaceConflictError("etag_mismatch");
      await input.persistence.requireUsableConfirmation({
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        action: "delete",
        subjectEtag: expectedEtag,
        tokenDigest: sha256Bytes(request.confirmationToken),
        now: canonicalNow(input.clock),
      });
      return acceptOperation(input, request, {
        operationId: input.ids.next(),
        environmentId: target.environmentId,
        billingEpochId: target.billingEpochId,
        eventType: "ProjectDeletionRequestedV1",
        httpMethod: "DELETE",
        routeTemplate: "/v1/projects/{project_id}",
        cleanupRunId: input.ids.next(),
        expectedProjectVersion: target.expectedProjectVersion,
        expectedEtag,
        confirmation: {
          organizationId: request.organizationId,
          projectId: request.projectId,
          issuedToPrincipalId: request.principalId,
          action: "delete",
          subjectEtag: expectedEtag,
          tokenDigest: sha256Bytes(request.confirmationToken),
          consumedAt: canonicalNow(input.clock),
        },
      });
    },
  };
  return Object.freeze(port);
}
function productStatusBase(
  context: ProductSurfaceContext,
  projection: Readonly<Record<string, unknown>>,
) {
  const lifecycle = exactString(projection, "lifecycle_state");
  if (!/^(?:active|deleting|deleted)$/u.test(lifecycle)) {
    throw new TypeError("Persisted project lifecycle is invalid");
  }
  const handle = exactString(projection, "handle");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(handle) || handle.length > 59) {
    throw new TypeError("Persisted project handle is invalid");
  }
  const lifecycleVersion = projection["lifecycle_version"];
  if (
    typeof lifecycleVersion !== "number" ||
    !Number.isSafeInteger(lifecycleVersion) ||
    lifecycleVersion < 1
  )
    throw new TypeError("Persisted project lifecycle version is invalid");
  const etag = strongEtag({
    handle,
    projectId: context.projectId,
    version: lifecycleVersion,
  });
  const region = parseHostingRegion(projection["region"]);
  const devAccessMode = projection["dev_access_mode"];
  if (devAccessMode !== "protected" && devAccessMode !== "public")
    throw new TypeError("Persisted Dev access mode is invalid");
  const gatewayEvidence = projection["gateway_evidence"];
  if (!isRecord(gatewayEvidence)) throw new TypeError("Persisted gateway evidence is invalid");
  const devUrl = persistedGatewayUrl(gatewayEvidence, "dev", context.projectId, handle);
  const prodUrl = persistedGatewayUrl(gatewayEvidence, "prod", context.projectId, handle);
  const sourceValue = projection["source"];
  const environmentValue = projection["default_environment"];
  const source = isRecord(sourceValue) ? publicSourceBody(sourceValue) : null;
  let environment: Readonly<{ id: Ulid; name: string }> | null = null;
  let activeDeploymentId: Ulid | null = null;
  if (isRecord(environmentValue)) {
    const environmentId = parseUlid(exactString(environmentValue, "environment_id"));
    const environmentName = exactString(environmentValue, "name");
    environment = Object.freeze({ id: environmentId, name: environmentName });
    const rawActiveDeploymentId = environmentValue["active_deployment_id"];
    if (rawActiveDeploymentId !== null && rawActiveDeploymentId !== undefined) {
      if ((environmentName === "dev" ? devUrl : prodUrl) === null)
        throw new TypeError("Persisted environment gateway evidence is invalid");
      if (typeof rawActiveDeploymentId !== "string") {
        throw new TypeError("Persisted active deployment ID is invalid");
      }
      activeDeploymentId = parseUlid(rawActiveDeploymentId);
    }
  } else if (environmentValue !== null && environmentValue !== undefined) {
    throw new TypeError("Persisted default environment is invalid");
  }
  return {
    projection,
    lifecycle,
    handle,
    etag,
    region,
    devAccessMode,
    devUrl,
    prodUrl,
    source,
    environment,
    activeDeploymentId,
  };
}
export function productStatusResult(
  context: ProductSurfaceContext,
  facts: ProductStatusFacts,
): ProductSurfaceResult {
  const {
    projection,
    lifecycle,
    handle,
    etag,
    region,
    devAccessMode,
    devUrl,
    prodUrl,
    source,
    environment,
    activeDeploymentId,
  } = productStatusBase(context, facts.projection);
  let headDeployment: Readonly<Record<string, unknown>> | null = null;
  if (activeDeploymentId !== null) {
    const deployment = facts.headDeployment;
    if (deployment === null) throw new TypeError("Persisted head deployment is missing");
    if (
      deployment.deploymentId !== activeDeploymentId ||
      deployment.projectId !== context.projectId
    )
      throw new TypeError("Persisted head deployment is invalid");
    headDeployment = publicDeployment(deployment);
  }
  const latestOperationRecord = facts.latestOperation;
  let latestOperation: Readonly<Record<string, unknown>> | null = null;
  if (latestOperationRecord !== undefined) {
    const operationId = parseUlid(latestOperationRecord.operation_id);
    const state = latestOperationRecord.state;
    const blockingOperationId = latestOperationRecord.blockingOperationId;
    if (!/^(?:queued|running|succeeded|failed|cancelled)$/u.test(state)) {
      throw new TypeError("Persisted latest operation state is invalid");
    }
    const reconciliation = latestOperationRecord.reconciliation;
    latestOperation = Object.freeze({
      ...(blockingOperationId === null ? {} : { blocking_operation_id: blockingOperationId }),
      id: operationId,
      state,
      created_at: latestOperationRecord.created_at,
      updated_at: latestOperationRecord.updated_at,
      ...(reconciliation === null
        ? {}
        : { reconciliation: publicOperationReconciliation(reconciliation) }),
      ...(state === "failed"
        ? {
            error: publicOperationFailure(
              latestOperationRecord.failure_code ?? "operation_failed",
              latestOperationRecord.failure_diagnostic,
            ),
          }
        : {}),
    });
  }
  const rawCleanup = facts.cleanupState;
  const cleanupState =
    rawCleanup === undefined
      ? "not_started"
      : rawCleanup === "succeeded"
        ? "completed"
        : rawCleanup === "reconciliation_required"
          ? "reconciliation_required"
          : rawCleanup === "pending" || rawCleanup === "running"
            ? "pending"
            : null;
  if (cleanupState === null) throw new TypeError("Persisted cleanup state is invalid");
  return {
    status: 200,
    body: Object.freeze({
      project_id: context.projectId,
      etag,
      handle,
      region,
      dev_access_mode: devAccessMode,
      lifecycle,
      source,
      default_environment: environment,
      environments: projection["environments"],
      head_deployment: headDeployment,
      dev_url: devUrl,
      prod_url: prodUrl,
      custom_domains: facts.customDomains ?? [],
      latest_operation: latestOperation,
      cleanup_state: cleanupState,
    }),
  };
}

export function githubPlanningFailureCode(reason: ProductSurfaceConflictReason) {
  const mapped = {
    workers_runtime_incompatible: "WORKERS_RUNTIME_INCOMPATIBLE",
    framework_conversion_required: "FRAMEWORK_CONVERSION_REQUIRED",
    migration_filename_noncanonical: "MIGRATION_FILENAME_NONCANONICAL",
    mail_domain_required: "MAIL_DOMAIN_REQUIRED",
  } as const;
  return reason in mapped
    ? mapped[reason as keyof typeof mapped]
    : ("SOURCE_ADMISSION_REJECTED" as const);
}

function persistedGatewayUrl(
  record: Readonly<Record<string, unknown>>,
  key: "dev" | "prod",
  projectId: Ulid,
  handle: string,
): string | null {
  const value = record[key];
  if (value === null) return null;
  const invalid = (): never => {
    throw new TypeError(`Persisted ${key} gateway evidence is invalid`);
  };
  if (!isRecord(value)) return invalid();
  const runtimeProvider = value["runtime_provider"];
  if (runtimeProvider !== "wfp") return invalid();
  const receiptId = value["wfp_receipt_id"];
  if (typeof receiptId !== "string") return invalid();
  try {
    parseUlid(receiptId);
  } catch {
    return invalid();
  }
  const label = key === "dev" ? `dev-${handle}` : handle;
  const address = projectEnvironmentAddress({
    projectId,
    handle,
    environmentName: key,
    platform:
      value["public_origin"] === `https://${label}.check.omh.st` ? "production" : "development",
  });
  const productDeploymentId = value["product_deployment_id"];
  if (typeof productDeploymentId !== "string") return invalid();
  try {
    parseUlid(productDeploymentId);
  } catch {
    return invalid();
  }
  const targetScriptName = `p-${projectId.toLowerCase()}-${key}-${productDeploymentId.toLowerCase()}`;
  const publicOrigin = value["public_origin"];
  if (
    value["contract_version"] !== "ohmyhost.shared-gateway/v1" ||
    value["script_name"] !== targetScriptName ||
    value["target_script_name"] !== targetScriptName ||
    value["deployment_url"] !== address.origin ||
    publicOrigin !== address.origin ||
    !Number.isSafeInteger(Number(value["route_revision"])) ||
    Number(value["route_revision"]) < 1
  )
    return invalid();
  try {
    canonicalTimestamp(value, "observed_at");
  } catch {
    return invalid();
  }
  return publicOrigin;
}

function isWorkersRuntimeIncompatible(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "code") === "source_runtime_workers_incompatible" &&
    Array.isArray(Reflect.get(value, "findings"))
  );
}

/**
 * A SourceFetcher conversion refusal with its validated diagnostic, or null for any other error.
 * An adapter refuses with its own requirement; a configuration that selects no adapter refuses with
 * neither and a typed diagnostic. Anything else is a platform contract error, not a refusal.
 */
function frameworkConversionRefusal(
  value: unknown,
): { readonly diagnostic: FrameworkConversionDiagnostic | null } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "code") !== "source_framework_conversion_required"
  ) {
    return null;
  }
  const adapter = Reflect.get(value, "adapter");
  const requirement = Reflect.get(value, "requirement");
  const diagnostic = parseFrameworkConversionDiagnostic(Reflect.get(value, "diagnostic"));
  return (adapter === null && requirement === null && diagnostic !== null) ||
    (adapter === "functions" && requirement === "functions-adapter") ||
    (adapter === "nextjs" && requirement === "nextjs-adapter") ||
    (adapter === "astro" && requirement === "astro-adapter") ||
    (adapter === "tanstack-start" && requirement === "tanstack-adapter") ||
    (adapter === "vite-static" && requirement === "vite-adapter")
    ? { diagnostic }
    : null;
}

/**
 * Control decides a refused framework version again with its own copy of the shared policy. The
 * policies agree only when Control refuses the same version with the same minimum; a lockfile
 * resolves a release, never a ^ or ~ range.
 */
function frameworkVersionPoliciesAgree(diagnostic: FrameworkConversionDiagnostic): boolean {
  if (diagnostic.code !== "framework_version_unsupported") return true;
  // The diagnostic parser admits only a package.json or a lockfile path for this code.
  const declared = diagnostic.path.slice(diagnostic.path.lastIndexOf("/") + 1) === "package.json";
  if (!declared && /^[~^]/u.test(diagnostic.version)) return false;
  const admission = classifyFrameworkVersion(
    diagnostic.package,
    diagnostic.version,
    declared ? null : diagnostic.version,
  );
  return admission.status === "unsupported" && admission.minimum === diagnostic.minimum;
}

function isMigrationFilenameNoncanonical(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "code") === "source_migration_filename_noncanonical"
  );
}

export interface BuildReceiptPersistencePort {
  claimBuildInput(claim: BuildInputClaimRequest): Promise<BuildInputClaimResult>;
  authorizeBuildStart(scope: BuildInputClaimRequest["scope"], claimId: string): Promise<boolean>;
  putBuildReceipt(envelope: PersistedBuildReceiptEnvelope): Promise<void>;
  putBuildUsage(input: BuildUsageInput): Promise<void>;
}

function promotionEtag(target: PromotionPlanTarget): string {
  return strongEtag({
    sourceEnvironmentId: target.sourceEnvironmentId,
    sourceDeploymentId: target.sourceDeploymentId,
    sourceHeadVersion: target.expectedSourceHeadVersion,
    targetEnvironmentId: target.targetEnvironmentId,
    targetHeadVersion: target.expectedTargetHeadVersion,
  });
}

function promotionConfirmationToken(target: PromotionPlanTarget): string {
  return validateConfirmationToken(
    `p1.${String(target.expectedSourceHeadVersion)}.${String(target.expectedTargetHeadVersion)}.${randomBytes(32).toString("base64url")}`,
  );
}

function parsePromotionConfirmationToken(
  value: string,
): Readonly<{ sourceHeadVersion: number; targetHeadVersion: number }> | null {
  const match = /^p1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/u.exec(value);
  if (match === null) return null;
  const sourceHeadVersion = Number(match[1]);
  const targetHeadVersion = Number(match[2]);
  return Number.isSafeInteger(sourceHeadVersion) && Number.isSafeInteger(targetHeadVersion)
    ? Object.freeze({ sourceHeadVersion, targetHeadVersion })
    : null;
}

type AcceptCommand = Parameters<typeof acceptProductApiOperation>[1];
export type AcceptCommandDetails =
  | {
      readonly eventType: "ProjectHandleChangeRequestedV1";
      readonly operationId: Ulid;
      readonly environmentId: Ulid;
      readonly billingEpochId: Ulid;
      readonly httpMethod: "PUT";
      readonly routeTemplate: string;
      readonly requestedHandle: string;
      readonly expectedEtag: string;
    }
  | {
      readonly eventType: "DeploymentRequestedV1";
      readonly operationId: Ulid;
      readonly environmentId: Ulid;
      readonly billingEpochId: Ulid;
      readonly httpMethod: "POST";
      readonly routeTemplate: string;
      readonly planId: Ulid;
      readonly planDigest: Uint8Array;
      readonly deploymentId: Ulid;
    }
  | {
      readonly eventType: "DeploymentRollbackRequestedV1";
      readonly operationId: Ulid;
      readonly environmentId: Ulid;
      readonly billingEpochId: Ulid;
      readonly httpMethod: "POST";
      readonly routeTemplate: string;
      readonly deploymentId: Ulid;
      readonly targetDeploymentId: Ulid;
      readonly targetRevisionId: Ulid;
      readonly targetArtifactId: Ulid;
      readonly expectedHeadVersion: number;
      readonly expectedDataEnvironmentId: Ulid;
      readonly expectedAssignmentVersion: number;
      readonly expectedRegistrationVersion: number;
      readonly expectedEtag: string;
      readonly confirmation: ConsumeActionConfirmationInput;
    }
  | {
      readonly eventType: "DeploymentPromotionRequestedV1";
      readonly operationId: Ulid;
      readonly environmentId: Ulid;
      readonly billingEpochId: Ulid;
      readonly httpMethod: "POST";
      readonly routeTemplate: string;
      readonly deploymentId: Ulid;
      readonly sourceEnvironmentId: Ulid;
      readonly sourceDeploymentId: Ulid;
      readonly sourceRevisionId: Ulid;
      readonly sourceArtifactId: Ulid;
      readonly sourceArtifactDigest: Uint8Array;
      readonly expectedSourceHeadVersion: number;
      readonly expectedHeadVersion: number;
      readonly expectedEtag: string;
      readonly confirmation: ConsumeActionConfirmationInput;
    }
  | {
      readonly eventType: "ProjectDeletionRequestedV1";
      readonly operationId: Ulid;
      readonly environmentId: Ulid;
      readonly billingEpochId: Ulid;
      readonly httpMethod: "DELETE";
      readonly routeTemplate: string;
      readonly cleanupRunId: Ulid;
      readonly expectedProjectVersion: number;
      readonly expectedEtag: string;
      readonly confirmation: ConsumeActionConfirmationInput;
    };

async function acceptOperation(
  dependencies: {
    readonly persistence: ProductSurfaceDataPort;
    readonly clock: Clock;
    readonly ids: UlidFactory;
  },
  request: ProductSurfaceMutationContext,
  command: AcceptCommandDetails,
): Promise<ProductSurfaceResult> {
  const occurredAt = canonicalNow(dependencies.clock);
  try {
    const accepted = await dependencies.persistence.acceptProductOperation(
      () =>
        ({
          ...command,
          organizationId: request.organizationId,
          projectId: request.projectId,
          principalId: request.principalId,
          requestId: request.requestId,
          ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: request.canonicalRequestDigest,
          operationEventId: dependencies.ids.next(),
          auditEventId: dependencies.ids.next(),
          outboxEventId: dependencies.ids.next(),
          occurredAt,
        }) as AcceptCommand,
      command.eventType,
    );
    return operationResult(accepted);
  } catch (error) {
    if (error instanceof DeploymentPersistenceConflictError) {
      if (error.message.includes("Idempotency")) throw new IdempotencyKeyReusedError();
      if ("confirmation" in command) throw new ProductSurfaceConflictError("confirmation_invalid");
      if (command.eventType === "DeploymentRequestedV1")
        throw new ProductSurfaceConflictError("deployment_plan_expired");
    }
    throw error;
  }
}

function publicDeployment(deployment: ProductDeploymentRead): Readonly<Record<string, unknown>> {
  const status = {
    queued: "queued",
    running:
      deployment.buildCompletedAt !== undefined || deployment.kind !== "deploy"
        ? "publishing"
        : "building",
    succeeded: deployment.isEnvironmentHead ? "active" : "rolled_back",
    failed: "failed",
    reconciliation_required: "reconciliation_required",
  } as const;
  return Object.freeze({
    id: deployment.deploymentId,
    project_id: deployment.projectId,
    operation_id: deployment.operationId,
    commit_sha: deployment.commitSha,
    source_digest: digestString(deployment.sourceDigest),
    build_plan_digest: digestString(deployment.buildPlanDigest),
    ...(deployment.artifactDigest === null
      ? {}
      : { artifact_digest: digestString(deployment.artifactDigest) }),
    status: status[deployment.status],
    ...(deployment.deploymentUrl === null ? {} : { url: deployment.deploymentUrl }),
    created_at: deployment.createdAt,
    updated_at: deployment.updatedAt,
  });
}

function parseInspection(value: unknown, commitSha: string) {
  let frameworkPlan: ProductionFrameworkPlan;
  try {
    frameworkPlan = parseNewProductionFrameworkPlan(
      isRecord(value) ? value["frameworkPlan"] : null,
    );
  } catch {
    throw new ProductSurfaceUnavailableError();
  }
  const requiresCompanionSource =
    (frameworkPlan.adapter === "vite-static" && frameworkPlan.runtime === "edge") ||
    frameworkPlan.runtime === "functions";
  const expectedKeys = [
    "resolvedCommitSha",
    "sourceSha256",
    "byteLength",
    "frameworkPlan",
    "buildPlanSha256",
    ...(requiresCompanionSource ? ["companionSource"] : []),
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    value["resolvedCommitSha"] !== commitSha ||
    typeof value["sourceSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value["sourceSha256"]) ||
    typeof value["buildPlanSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value["buildPlanSha256"]) ||
    !Number.isSafeInteger(value["byteLength"]) ||
    Number(value["byteLength"]) <= 0 ||
    (requiresCompanionSource &&
      !validCompanionSource(value["companionSource"], frameworkPlan.runtime === "functions"))
  ) {
    throw new ProductSurfaceUnavailableError();
  }
  return Object.freeze({
    sourceSha256: value["sourceSha256"],
    buildPlanSha256: value["buildPlanSha256"],
    frameworkPlan,
  });
}

function validCompanionSource(value: unknown, workerModule: boolean): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "path", "byteLength", "sha256"]) &&
    value["schemaVersion"] ===
      (workerModule ? "ohmyhost.worker-module/v1" : "ohmyhost.vite-api-companion/v1") &&
    value["path"] === (workerModule ? "src/ohmyhost/worker.ts" : "src/ohmyhost/companion.ts") &&
    Number.isSafeInteger(value["byteLength"]) &&
    Number(value["byteLength"]) > 0 &&
    Number(value["byteLength"]) <= 256 * 1024 &&
    typeof value["sha256"] === "string" &&
    /^[0-9a-f]{64}$/u.test(value["sha256"])
  );
}

function publicAutoDeploy(config: {
  readonly branchRef: string;
  readonly generation: number;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly grantActive: boolean;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    branch: config.branchRef.slice("refs/heads/".length),
    ref: config.branchRef,
    environment: "dev",
    enabled: config.enabled,
    generation: config.generation,
    grant_status: config.grantActive ? "active" : "revoked",
    updated_at: config.updatedAt,
  });
}

function publicSourceBody(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const provider = exactString(source, "provider");
  const sourceConnectionId = parseUlid(exactString(source, "source_connection_id"));
  const sourceGeneration = source["source_generation"];
  if (!Number.isSafeInteger(sourceGeneration) || Number(sourceGeneration) < 1)
    throw new TypeError("Persisted source generation is invalid");
  if (provider === "managed") {
    const body = {
      provider,
      source_connection_id: sourceConnectionId,
      source_generation: sourceGeneration,
      namespace: exactString(source, "repository_owner"),
      repository_name: exactString(source, "repository_name"),
      branch: "main",
      current_commit_sha: source["current_commit_sha"] ?? null,
      status: exactString(source, "state"),
      linked_at: canonicalTimestamp(source, "created_at"),
      updated_at: canonicalTimestamp(source, "updated_at"),
    };
    assertManagedSourceResponse("source", body);
    return Object.freeze(body);
  }
  const installationId = exactString(source, "installation_id");
  const repositoryOwner = exactString(source, "repository_owner");
  const repositoryName = exactString(source, "repository_name");
  const status = exactString(source, "state");
  const linkedAt = canonicalTimestamp(source, "created_at");
  const updatedAt = canonicalTimestamp(source, "updated_at");
  if (
    provider !== "github" ||
    !/^[1-9][0-9]{0,19}$/u.test(installationId) ||
    !/^[^/]+$/u.test(repositoryOwner) ||
    !/^[^/]+$/u.test(repositoryName) ||
    !/^(?:pending|ready|failed|revoked)$/u.test(status)
  )
    throw new TypeError("Persisted project source is invalid");
  return Object.freeze({
    provider,
    source_connection_id: sourceConnectionId,
    source_generation: sourceGeneration,
    installation_id: installationId,
    repository_full_name: `${repositoryOwner}/${repositoryName}`,
    status,
    linked_at: linkedAt,
    updated_at: updatedAt,
    ...(status === "failed"
      ? { failure_summary: "The GitHub source connection could not be verified." }
      : {}),
  });
}

function exactString(value: Readonly<Record<string, unknown>>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0)
    throw new TypeError("Persisted product data is invalid");
  return item;
}

function canonicalTimestamp(value: Readonly<Record<string, unknown>>, key: string): string {
  const item = exactString(value, key);
  const parsed = new Date(item);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Persisted product data is invalid");
  return parsed.toISOString();
}

function canonicalNow(clock: Clock): string {
  return clock.now().toISOString();
}
function canonical(value: unknown): string {
  const result = (canonicalize as unknown as (input: unknown) => string | undefined)(value);
  if (result === undefined) throw new TypeError("Product plan cannot be canonicalized");
  return result;
}
function sha256Bytes(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function digestBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
function digestString(value: Uint8Array): string {
  if (value.byteLength !== 32) throw new TypeError("Persisted product digest is invalid");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}
function strongEtag(value: unknown): string {
  return `"sha256-${createHash("sha256").update(canonical(value)).digest("hex")}"`;
}
function validateConfirmationToken(value: string): string {
  if (!/^[A-Za-z0-9._~-]{32,256}$/u.test(value)) throw new TypeError("Invalid confirmation token");
  return value;
}
function safeProviderInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ProductSurfaceUnavailableError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ProductSurfaceUnavailableError();
  return parsed;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}
