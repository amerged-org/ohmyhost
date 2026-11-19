/* eslint-disable @typescript-eslint/no-explicit-any -- direct boundary tests intentionally probe dynamically shaped RPC evidence */
import {
  deterministicProductCommandWorkflowId,
  type ProductCommandMessageV1,
} from "@ohmyhost/orchestrator";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseUlid } from "@ohmyhost/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";

const database = vi.hoisted(() => ({
  assertOperationExecutionAuthorized: vi.fn(async () => undefined),
  observeSourceArchiveReceipt: vi.fn(async () => null),
  readManagedSourceDeletionInventory: vi.fn(async () => ({ repos: [], blobOperations: [] })),
  DeploymentPersistenceConflictError: class DeploymentPersistenceConflictError extends Error {},
  activateProductProviderReconciliationAttempt: vi.fn(async () => "activated" as const),
  activateProductWorkflowReplayAttempt: vi.fn(async () => "active" as const),
  completeProductCommand: vi.fn(async (_client: unknown, _input: { auditEventId: string }) => {
    void _client;
    void _input;
    return "completed" as const;
  }),
  completeDeploymentPromotion: vi.fn(async () => ({ targetHeadVersion: 1 })),
  claimProductProviderMutation: vi.fn(async () => "created" as const),
  lockProductCommandOperationTransaction: vi.fn(async () => undefined),
  authorizeGithubPushActivation: vi.fn(async () => true),
  authorizeWfpCandidateActivation: vi.fn(async () => ({ allowed: true as const })),
  recordWfpCandidateReceipt: vi.fn(async () => "created" as const),
  recordEnvironmentFunctionSchedule: vi.fn(async () => ({
    scheduled: true,
    immutableScriptName: null as string | null,
  })),
  deleteProjectFunctionSchedules: vi.fn(async () => 0),
  finalizeWfpCandidateDeployment: vi.fn(async () => ({ headVersion: 1 })),
  finalizeRollbackActivation: vi.fn(async () => ({ headVersion: 1 })),
  resolveRollbackCandidate: vi.fn(),
  readRollbackPlanTarget: vi.fn(),
  assertProjectBindingRefreshSnapshot: vi.fn(async () => undefined),
  readWfpProjectDeletionEvidence: vi.fn(async () => ({ candidates: [], activeGateways: [] })),
  prepareCandidateCleanup: vi.fn(),
  claimPendingWfpCandidateCleanup: vi.fn(async (): Promise<any> => null),
  recordWfpCandidateCleanupReceipt: vi.fn(async () => "created" as const),
  settleSharedGatewayCandidateCleanup: vi.fn(async () => ({
    compensatedTargetScriptName: null as string | null,
    sharedGatewayRevision: null as number | null,
  })),
  recordWfpCandidateOperationCleanupReceipt: vi.fn(async () => "created" as const),
  markCandidateSuperseded: vi.fn(async () => "superseded" as const),
  failProductDeploymentCommand: vi.fn(async () => "failed" as const),
  recordRuntimeHealthDiagnostic: vi.fn(async () => "created" as const),
  readCandidateCleanupResources: vi.fn(async (_client: unknown, _scope: any): Promise<any> => {
    void _client;
    void _scope;
    return { sourceArchives: [], artifactExpectations: [] };
  }),
  readProductWorkflowContext: vi.fn(),
  recordAbandonedGatewayPredecessor: vi.fn(async () => "created" as const),
  recordProductDeploymentEvidence: vi.fn(async () => undefined),
  recordProductSourceArchiveEvidence: vi.fn(async () => "created" as const),
  recordProductRollbackEvidence: vi.fn(async () => undefined),
  appendAuditedProjectDataChangeAssignments: vi.fn(async () => "created" as const),
  startProjectDataChangeCleanup: vi.fn(async () => "created" as const),
  readNeonProjectPlacement: vi.fn(),
  readProductWorkflowDatabaseTarget: vi.fn(async (_client: unknown, scope: any): Promise<any> => {
    const placement = (await database.readNeonProjectPlacement(_client, scope)) ?? null;
    return {
      dataEnvironmentId: scope.physicalEnvironmentId,
      providerTarget:
        placement === null
          ? null
          : {
              ...scope,
              provider: "neon",
              providerProjectId: placement.providerProjectId,
              branchId: placement.defaultBranchId,
              targetVersion: 1,
              state: "active",
            },
      neonPlacement: placement,
      databaseRegistration:
        (await database.readProjectDatabaseRegistrationTarget(_client, scope)) ?? null,
    };
  }),
  readProjectDatabaseRegistrationTarget: vi.fn(),
  readProjectDataEnvironment: vi.fn(),
  recordCleanupAttempt: vi.fn(async () => "created" as const),
  recordPromotionRevision: vi.fn(async () => "created" as const),
}));

vi.mock("@ohmyhost/database/provisioning-persistence", async () => ({
  ...database,
  readPgcfPostgresTarget: (
    await vi.importActual<typeof import("../../../packages/database/src/worker-postgres.js")>(
      "../../../packages/database/src/worker-postgres.js",
    )
  ).readPgcfPostgresTarget,
}));

import {
  activateDeploymentReconciliationAttempt,
  activateDeploymentReplayAttempt,
  createDeploymentWorkflowPorts as createPorts,
} from "../src/product-workflow-composition.js";
import { createCoreDeploymentInventory } from "../src/core-deployment-inventory.js";
import {
  createRecordedDataPorts,
  lifecycleRecorders,
  nextCacheRetirementRecorders,
  recordedAttempts,
} from "./support/recorded-persistence.js";

/** The composition under test over the recorded persistence groups. */
function createDeploymentWorkflowPorts(
  bindings: Parameters<typeof createPorts>[0],
  now: () => Date = () => new Date(),
) {
  return createPorts(bindings, createRecordedDataPorts(now), now);
}

const ids = {
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  targetDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  targetRevisionId: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  sourceEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  sourceRevisionId: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
} as const;

const hex = "ab".repeat(32);
const digest = `sha256:${hex}`;
const deployedAt = "2026-08-19T12:00:00.000Z";
const databaseRegistration: import("@ohmyhost/database").ProjectDatabaseRegistrationMetadata = {
  operationId: ids.operationId,
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  physicalEnvironmentId: ids.environmentId,
  registrationVersion: 1,
  region: "us" as const,
  providerProjectId: "quiet-snow-12345678",
  branchId: "br-green-river-12345678",
  originHost: "ep-runtime-pooler.c-5.us-east-2.aws.neon.tech",
  originDatabase: "neondb" as const,
  originUser: `ohmyho_rw_${ids.environmentId.toLowerCase()}`,
  authorizedEnvironmentIds: [ids.environmentId, ids.sourceEnvironmentId],
  status: "active" as const,
};
const deletionInventoryRecord = (provider: string, resourceKind: string, locator: string) => ({
  resourceRecordId: ids.targetRevisionId,
  provider,
  resourceKind,
  externalRefHash: new Uint8Array(32).fill(locator.length % 255),
  cleanupLocator: `encoded/${Buffer.from(locator).toString("base64url")}`,
});
const frameworkPlan = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: "site",
  adapter: "tanstack-start",
  runtime: "edge",
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "pnpm build",
  outputDirectory: "dist/client",
  serverOutputDirectory: "dist/server",
  serverEntryPoint: "dist/server/index.js",
  serverConfigPath: "dist/server/wrangler.json",
  compatibilityDate: "2026-08-21",
  compatibilityFlags: ["nodejs_compat"],
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
} as const;

const command = <EventType extends ProductCommandMessageV1["eventType"]>(
  eventType: EventType,
): Extract<ProductCommandMessageV1, { eventType: EventType }> =>
  ({
    version: 1,
    eventType,
    eventId: ids.eventId,
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    billingEpochId: ids.billingEpochId,
    environmentId: ids.environmentId,
    operationId: ids.operationId,
    ...(eventType === "DeploymentRequestedV1" ? { planId: ids.planId } : {}),
    ...(eventType === "ProjectHandleChangeRequestedV1" ? { requestedHandle: "acme-shop" } : {}),
  }) as Extract<ProductCommandMessageV1, { eventType: EventType }>;

const archive = {
  organizationId: ids.organizationId,
  billingEpochId: ids.billingEpochId,
  archiveId: "r2-version:ohmyho-builds-development/source.zip#0123456789abcdef0123456789abcdef",
  byteLength: 42,
  sha256: hex,
  archive: {
    bucket: "ohmyho-builds-development",
    key: "source.zip",
    versionId: "0123456789abcdef0123456789abcdef",
    eTag: "etag-1",
    byteLength: 42,
    scope: {
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
    },
    sourceSha256: hex,
  },
} as const;

const buildReceipt = {
  buildId: "build-1",
  projectName: "sandbox-build",
  scope: {
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    operationId: ids.operationId,
  },
} as const;

const migrationBody = new TextEncoder().encode(
  "create table public.accounts(id uuid primary key);",
);

const artifact = {
  manifestDigest: digest,
  manifestBody: new TextEncoder().encode(JSON.stringify({ sbom: { digest } })),
  files: [{ path: "large.js", body: new Uint8Array(2 * 1024 * 1024) }],
  modules: [{ path: "index.js", body: new Uint8Array(2 * 1024 * 1024) }],
  migrations: [],
  provenance: {
    artifactDigest: digest,
    sourceCommit: "a".repeat(40),
    sourceDigest: digest,
    buildPlanDigest: digest,
    lifecycleEvidence: {
      configurationDigest: "0".repeat(64),
      frozenInstall: {
        packageManager: "pnpm",
        packageManagerVersion: "10.28.2",
        lockfile: "pnpm-lock.yaml",
        lockfileSha256: "1".repeat(64),
        installCommandSha256: "2".repeat(64),
        dependencyInventorySha256: "3".repeat(64),
      },
      frameworkBuild: {
        framework: "tanstack-start",
        runtime: "edge",
        buildCommandSha256: "4".repeat(64),
        frameworkPlanSha256: hex,
        buildOutputSha256: "5".repeat(64),
      },
      buildSandbox: {
        buildId: buildReceipt.buildId,
        projectName: buildReceipt.projectName,
        buildInputFingerprint: "6".repeat(64),
        sourceArchiveSha256: hex,
        terminalStatus: "SUCCEEDED" as const,
      },
      credentialScan: {
        scannerSha256: "7".repeat(64),
        rulesSha256: "8".repeat(64),
        findingsCount: 0 as const,
      },
    },
    deploymentId: ids.deploymentId,
    buildId: buildReceipt.buildId,
    database: { enabled: false as const },
    auth: { provider: "none" as const },
    storage: { enabled: false as const },
    scope: {
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
    },
    output: {
      bucket: "ohmyho-builds-development",
      key: "artifact.zip",
      versionId: "fedcba9876543210fedcba9876543210",
      eTag: "artifact-etag-1",
      byteLength: 84,
      sha256: hex,
    },
  },
} as const;

const artifactReference = {
  schemaVersion: "ohmyhost.verified-artifact-reference/v1" as const,
  expectation: {
    receipt: buildReceipt,
    deploymentId: ids.deploymentId,
    commitSha: "a".repeat(40),
    sourceSha256: hex,
    buildPlanSha256: hex,
    frameworkPlan,
  },
  manifestDigest: digest,
  sbomDigest: digest,
  provenance: artifact.provenance,
} as const;

const wfpReceipt = {
  provider: "cloudflare-wfp",
  namespace: "sandbox",
  scriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.deploymentId.toLowerCase()}`,
  projectId: ids.projectId,
  environmentId: ids.environmentId,
  productDeploymentId: ids.deploymentId,
  providerTag: "a".repeat(32),
  artifactDigest: digest,
  buildReused: false,
  deployedAt,
} as const;

const rollbackReceipt = {
  ...wfpReceipt,
  scriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
  productDeploymentId: ids.targetDeploymentId,
} as const;

const sharedGatewayWorkerName = "ohmyho-gateway-sandbox";
const gatewayReceipt = {
  provider: "ohmyhost-shared-gateway",
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  environmentId: ids.environmentId,
  environmentName: "dev" as const,
  handle: "calm-otter-builds",
  hostname: "dev-calm-otter-builds.dev.check.omh.st",
  publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
  targetDeploymentId: ids.deploymentId,
  targetScriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.deploymentId.toLowerCase()}`,
  targetArtifactDigest: digest,
  targetProviderTag: "a".repeat(32),
  egressPolicyDigest: `sha256:${"b".repeat(64)}`,
  egressAllowedOrigins: [],
  candidateReceiptId: ids.sourceConnectionId,
  revision: 1,
  predecessorRevision: null,
  operationId: ids.operationId,
  active: true,
  observedAt: deployedAt,
} as const;
const gatewayAbsence = {
  ...gatewayReceipt,
  active: false,
  revision: 2,
  predecessorRevision: 1,
} as const;
const prodGatewayAbsence = {
  ...gatewayAbsence,
  environmentId: ids.sourceEnvironmentId,
  environmentName: "prod" as const,
  hostname: "calm-otter-builds.dev.check.omh.st",
  publicOrigin: "https://calm-otter-builds.dev.check.omh.st",
  targetScriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
} as const;

function contextFor(eventType: ProductCommandMessageV1["eventType"]) {
  return {
    ...(eventType === "SourceLinkRequestedV1" ? { authorizedRepositoryId: "456" } : {}),
    dataMode: "shared" as "shared" | "isolated",
    region: "us" as const,
    handle: "calm-otter-builds",
    environmentName: "dev" as const,
    intent: {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      eventType,
      // Only an accepted deletion carries a cleanup run; it authorizes its gateway removal.
      cleanupRunId: eventType === "ProjectDeletionRequestedV1" ? ids.eventId : null,
      deploymentId: ids.deploymentId,
      planId: ids.planId,
      sourceConnectionId: ids.sourceConnectionId,
      targetDeploymentId: ids.targetDeploymentId,
      targetRevisionId: ids.targetRevisionId,
      commitSha: "a".repeat(40),
      sourceDigest: Buffer.from(hex, "hex"),
      buildPlanDigest: Buffer.from(hex, "hex"),
      installationId: "123",
      repositoryOwner: "sebmer-com",
      repositoryName: "fixture",
    },
    headVersion: 7,
    projectLifecycleVersion: 3,
    sourceGrant: {
      sourceConnectionId: ids.sourceConnectionId,
      sourceGeneration: 1,
      provider: "github",
      revoked: false,
      grantId: ids.sourceConnectionId,
      installationId: "123",
      externalRepositoryId: "456",
      repositoryOwner: "sebmer-com",
      repositoryName: "fixture",
      grantedAt: deployedAt,
    },
    knownDeployments:
      eventType === "DeploymentRollbackRequestedV1" ? [wfpReceipt, rollbackReceipt] : [wfpReceipt],
    rollbackArtifact: {
      receipt: buildReceipt,
      deploymentId: artifact.provenance.deploymentId,
      commitSha: "a".repeat(40),
      sourceSha256: hex,
      buildPlanSha256: hex,
      frameworkPlan,
      output: {
        bucket: "ohmyho-builds-development",
        key: `runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz`,
        versionId: "fedcba9876543210fedcba9876543210",
        scope: {
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          operationId: ids.operationId,
        },
      },
    },
    promotionArtifact: null,
    promotionSourceDeployment: null,
    artifactExpectations: [
      {
        receipt: buildReceipt,
        deploymentId: ids.deploymentId,
        commitSha: "a".repeat(40),
        sourceSha256: hex,
        buildPlanSha256: hex,
        frameworkPlan,
        output: {
          bucket: "ohmyho-builds-development",
          key: `runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz`,
          versionId: "fedcba9876543210fedcba9876543210",
          scope: {
            projectId: ids.projectId,
            environmentId: ids.environmentId,
            operationId: ids.operationId,
          },
        },
      },
    ],
    activeDeploymentId: ids.deploymentId,
    activeDeployment: wfpReceipt,
    activeGateway: gatewayReceipt,
    deletionDataEnvironments: [],
    deletionEnvironments: [
      {
        environmentId: ids.environmentId,
        environmentName: "dev" as const,
        headVersion: 7,
        activeDeploymentId: ids.deploymentId,
        activeRevisionId: ids.targetRevisionId,
        activeDeployment: wfpReceipt,
        activeGateway: gatewayReceipt,
        environmentSecretCount: 0,
        artifactExpectations: [
          {
            receipt: buildReceipt,
            deploymentId: ids.deploymentId,
            commitSha: "a".repeat(40),
            sourceSha256: hex,
            buildPlanSha256: hex,
            frameworkPlan,
            output: {
              bucket: "ohmyho-builds-development",
              key: `runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz`,
              versionId: "fedcba9876543210fedcba9876543210",
              scope: {
                projectId: ids.projectId,
                environmentId: ids.environmentId,
                operationId: ids.operationId,
              },
            },
          },
        ],
        sourceArchives: [archive.archive],
        deletionBuildArtifacts: [
          {
            artifactId: ids.targetRevisionId,
            buildExecutionId: ids.operationId,
            artifactDigest: digest,
            output: {
              bucket: "ohmyho-builds-development",
              key: `runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz`,
              versionId: "fedcba9876543210fedcba9876543210",
              scope: {
                projectId: ids.projectId,
                environmentId: ids.environmentId,
                operationId: ids.operationId,
              },
            },
          },
        ],
        r2Bucket: null,
        neonPlacement: null,
        databaseRegistration: null,
      },
      {
        environmentId: ids.sourceEnvironmentId,
        environmentName: "prod" as const,
        headVersion: 0,
        activeDeploymentId: null,
        activeRevisionId: null,
        activeDeployment: null,
        activeGateway: null,
        environmentSecretCount: 0,
        artifactExpectations: [],
        sourceArchives: [],
        deletionBuildArtifacts: [],
        r2Bucket: null,
        neonPlacement: null,
        databaseRegistration: null,
      },
    ],
    deletionInventory: [
      deletionInventoryRecord(
        "cloudflare",
        "build-artifact",
        `r2-version:ohmyho-builds-development/runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz#fedcba9876543210fedcba9876543210`,
      ),
      deletionInventoryRecord(
        "cloudflare",
        "source-object",
        `${archive.archive.bucket}/${archive.archive.key}/${archive.archive.versionId}`,
      ),
      deletionInventoryRecord("ohmyhost", "gateway-route", ids.environmentId),
      deletionInventoryRecord("ohmyhost", "gateway-route", ids.sourceEnvironmentId),
      deletionInventoryRecord(
        "cloudflare",
        "wfp-script",
        `${wfpReceipt.namespace}/${wfpReceipt.scriptName}`,
      ),
    ],
    environmentSecretCount: 0,
    acceptedAt: deployedAt,
    sourceArchives: [archive.archive],
    frameworkPlan: eventType === "DeploymentRequestedV1" ? frameworkPlan : null,
    mailDomain: "mail.example.com",
  };
}

function mailDeletionScenario() {
  const base = contextFor("ProjectDeletionRequestedV1");
  const tenantName = `ohmyho-${ids.projectId.toLowerCase()}`;
  const configurationSetArn = `arn:aws:ses:eu-central-1:123456789012:configuration-set/${tenantName}`;
  const tenantArn = `arn:aws:ses:eu-central-1:123456789012:tenant/${tenantName}/tenant-1`;
  const domainReceiptId = ids.targetRevisionId;
  const cleanup = [
    {
      provider: "aws",
      resourceKind: "ses-event-destination",
      locator: `${configurationSetArn}/event-destination/ohmyho-events`,
      outcome: "removed",
    },
    {
      provider: "aws",
      resourceKind: "ses-configuration-set",
      locator: configurationSetArn,
      outcome: "removed",
    },
    { provider: "aws", resourceKind: "ses-tenant", locator: tenantArn, outcome: "removed" },
  ] as const;
  return {
    context: {
      ...base,
      deletionEnvironments: base.deletionEnvironments.map((environment) => ({
        ...environment,
        deletionBuildArtifacts: [],
        sourceArchives: [],
        r2Bucket: null,
        neonPlacement: null,
        databaseRegistration: null,
      })),
      deletionInventory: [
        deletionInventoryRecord("cloudflare", "domain-receipt", domainReceiptId),
        ...cleanup.map((item) =>
          deletionInventoryRecord(item.provider, item.resourceKind, item.locator),
        ),
      ],
    },
    cleanup,
    domainReceiptId,
  };
}

function bindings() {
  return {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    NEXT_CACHE_RETIREMENT: { retire: vi.fn(async () => ({ kind: "retired" })) },
    PROJECT_PROVISIONING_WORKFLOW: { create: vi.fn(), get: vi.fn() },
    DEPLOYMENT_WORKFLOW: { create: vi.fn(), get: vi.fn() },
    PROVIDER_RECONCILIATION_WORKFLOW: { create: vi.fn(), get: vi.fn() },
    SOURCE_FETCHER: {
      managedGit: vi.fn(async () => null),
      managedBlob: vi.fn(async () => null),
      acquireExact: vi.fn(async () => archive),
      inspectExact: vi.fn(async () => ({})),
      validateRepositoryLink: vi.fn(async () => ({
        permission: "contents:read",
        externalRepositoryId: "456",
      })),
    },
    BUILD_RUNNER: {
      startBuild: vi.fn(async () => buildReceipt),
      readBuild: vi.fn(async () => ({ status: "succeeded" })),
      readBuildArtifact: vi.fn(async () => artifact),
      removeBuildArtifact: vi.fn(async () => ({ state: "absent" })),
      removeBuildArtifactObject: vi.fn(async () => ({ state: "absent" })),
      removeArchive: vi.fn(async () => ({ state: "absent" })),
    },
    RECOVERY_INVOKER: {
      async invokeRecovery(): Promise<unknown> {
        throw new Error("Unexpected recovery call");
      },
    },
    RUNTIME_SECRET_DELIVERY: {
      ensureCustomerAuthSecret: vi.fn(async () => ({
        name: "BETTER_AUTH_SECRET",
        revision: 1,
        keyVersion: 1,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
      })),
      ensureMailGatewayKey: vi.fn(async () => ({
        name: "OHMYHOST_MAIL_KEY",
        revision: 1,
        keyVersion: 1,
        createdAt: deployedAt,
        updatedAt: deployedAt,
      })),
      ensureStorageGatewayKey: vi.fn(async () => ({
        name: "OHMYHOST_STORAGE_KEY",
        revision: 1,
        keyVersion: 1,
        createdAt: deployedAt,
        updatedAt: deployedAt,
      })),
      ensureAiGatewayKey: vi.fn(async () => ({
        name: "OHMYHOST_AI_KEY",
        revision: 1,
        keyVersion: 1,
        createdAt: deployedAt,
        updatedAt: deployedAt,
      })),
      ensureBrowserGatewayKey: vi.fn(async () => ({
        name: "OHMYHOST_BROWSER_KEY",
        revision: 1,
        keyVersion: 1,
        createdAt: deployedAt,
        updatedAt: deployedAt,
      })),
      stageCandidate: vi.fn(async () => ({
        status: "staged",
        candidate: wfpReceipt,
        priorGateway: gatewayReceipt,
        activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        deploymentUrl: gatewayReceipt.publicOrigin,
        runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
        runtimeSecretDelivery: {
          generation: 1,
          secretCount: 0,
          manifestDigest: `sha256:${"e".repeat(64)}`,
        },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      })),
      stagePromotionCandidate: vi.fn(async () => ({
        status: "staged",
        candidate: wfpReceipt,
        priorGateway: gatewayReceipt,
        activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        deploymentUrl: gatewayReceipt.publicOrigin,
        runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      })),
      recordStagedCandidate: vi.fn(async () => ({ status: "recorded" })),
      prepareExistingCandidate: vi.fn(async () => ({
        status: "replayed",
        candidate: { ...rollbackReceipt, buildReused: true },
        activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
        runtimeSecretDelivery: {
          generation: 1,
          secretCount: 0,
          manifestDigest: `sha256:${"e".repeat(64)}`,
        },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      })),
      recordActivatedCandidate: vi.fn(async () => ({ status: "activated" })),
      activateCandidate: vi.fn(async () => ({
        status: "activated",
        candidate: wfpReceipt,
        gateway: gatewayReceipt,
        deploymentUrl: gatewayReceipt.publicOrigin,
      })),
      observeActivation: vi.fn(async () => ({
        status: "activated",
        candidate: wfpReceipt,
        gateway: gatewayReceipt,
        deploymentUrl: gatewayReceipt.publicOrigin,
      })),
      compensateActivation: vi.fn(async () => ({
        status: "compensated",
        candidate: { outcome: "removed", observedAt: deployedAt },
        gateway: gatewayReceipt,
      })),
      compensateGatewayActivation: vi.fn(async () => ({
        status: "compensated",
        gateway: gatewayReceipt,
      })),
      removeCandidate: vi.fn(async () => ({
        status: "absent",
        outcome: "removed",
        observedAt: deployedAt,
      })),
      removePersistedCandidate: vi.fn(async () => ({
        status: "removed",
        outcome: "not_found",
        candidateAbsence: { state: "metadata_absent", observedAt: deployedAt },
        gateway: null,
        runtimeSecretDeliveryCompensation: null,
      })),
      reconcileRuntimeSecrets: vi.fn(async () => ({ status: "synchronized" })),
    },
    NATIVE_AUTH_RESOURCE_RUNTIME: {
      readProvisioningPolicy: vi.fn(),
      readPendingNativePolicySync: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return null;
      }),
      completeNativePolicySync: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return undefined;
      }),
      readDomainPolicySync: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return [];
      }),
      ackDomainPolicySync: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return "acknowledged";
      }),
      beginHandleDomainRecovery: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return null;
      }),
      completeHandleDomainRecovery: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return "completed";
      }),
    },
    NATIVE_AUTH_ADMIN_US: {
      applyRealmPolicy: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return undefined;
      }),
    },
    NATIVE_AUTH_ADMIN_EU: {
      applyRealmPolicy: vi.fn(async (input: unknown): Promise<unknown> => {
        void input;
        return undefined;
      }),
    },
    NEON_MANAGEMENT: {
      deleteNativeAuthProject: vi.fn(async (): Promise<unknown> => undefined),
      placeNativeAuthDatabase: vi.fn(async (): Promise<unknown> => undefined),
      prepareNativeAuthRealm: vi.fn(async (): Promise<unknown> => undefined),
      reauthorizeDataEnvironment: vi.fn(async () => ({ status: "ready", databaseRegistration })),
      revokeDataChangeAccess: vi.fn(async () => ({ status: "completed", revoked: 0 })),
      placeProject: vi.fn(async () => ({
        status: "ready",
        providerProjectId: "quiet-snow-12345678",
        defaultBranchId: "br-green-river-12345678",
      })),
      migrateProject: vi.fn(async () => ({
        status: "ready",
        appliedPaths: ["20260821090000_foundation.sql"],
        replayedPaths: [],
      })),
      readRuntimeBinding: vi.fn(async () => ({
        status: "ready",
        databaseRegistration,
      })),
      deleteProject: vi.fn(async (input: unknown) => {
        void input;
        return {
          status: "ready",
          outcome: "already_absent",
          provider: "neon",
          providerProjectId: "quiet-snow-12345678",
          absenceVerifiedAt: deployedAt,
          databaseRegistration: {
            ...databaseRegistration,
            ...(input as object),
            status: "revoked",
            registrationVersion: Number((input as any).registrationVersion) + 1,
          },
        };
      }),
    },
    STORAGE_DATA_MANAGEMENT: {
      purgeRetiredData: vi.fn(async (): Promise<unknown> => ({ status: "ready", deletedFiles: 0 })),
    },
    R2_MANAGEMENT: {
      ensureBucket: vi.fn(async () => ({
        status: "ready",
        outcome: "existing",
        receipt: {
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          operationId: ids.operationId,
          claimId: ids.targetRevisionId,
          bucketName: `ohmyho-${ids.projectId.toLowerCase()}-${ids.environmentId.toLowerCase()}`,
          bucketId: "1234567890abcdef1234567890abcdef",
          jurisdiction: "eu",
          storageClass: "Standard",
          publicAccess: false,
          observedAt: deployedAt,
        },
      })),
      readRuntimeBinding: vi.fn(async () => ({
        status: "ready",
        jurisdiction: "eu",
        bucketName: `ohmyho-${ids.projectId.toLowerCase()}-${ids.environmentId.toLowerCase()}`,
      })),
      purgeAndDeleteBucket: vi.fn(async () => ({ status: "absent", outcome: "replayed" })),
    },
    SES_MANAGEMENT: {
      ensureTenant: vi.fn(
        async (): Promise<unknown> => ({
          status: "ready",
          receipt: {
            provider: "aws-ses-v2",
            organizationId: ids.organizationId,
            projectId: ids.projectId,
            region: "eu-central-1",
            tenantName: `ohmyho-${ids.projectId.toLowerCase()}`,
            tenantId: "tenant-1",
            tenantArn: `arn:aws:ses:eu-central-1:123456789012:tenant/ohmyho-${ids.projectId.toLowerCase()}/tenant-1`,
            sendingStatus: "enabled",
            createdAt: deployedAt,
          },
        }),
      ),
      ensureMailDomain: vi.fn(
        async (): Promise<unknown> => ({
          status: "ready",
          receipt: {
            organizationId: ids.organizationId,
            projectId: ids.projectId,
            domain: "mail.example.com",
            provider: "resend",
            environmentId: ids.environmentId,
            domainId: ids.projectId,
            providerDomainId: "resend-domain-1",
          },
        }),
      ),
      deleteMailProject: vi.fn(async () => ({
        status: "absent",
        projectId: ids.projectId,
        resourcesAbsent: true,
        cleanup: [],
      })),
    },
    CLOUDFLARE_DOMAIN_MANAGEMENT: {
      ensureEnvironment: vi.fn(async (input: Record<string, unknown>) => {
        const publicUrl = gatewayReceipt.publicOrigin;
        return {
          status: "ready",
          environmentName: String(input["environmentName"]),
          hostname: new URL(publicUrl).hostname,
          dnsRecordId: "a".repeat(32),
          routeId: "b".repeat(32),
          publicUrl,
          observedAt: deployedAt,
          probe: {
            url: domainProbeUrl(input, publicUrl),
            status: 404,
            observedAt: "2026-08-19T12:00:01.000Z",
          },
        };
      }),
      deleteProject: vi.fn(async () => ({
        outcome: "absent",
        operationId: ids.operationId,
        receipts: [],
        oauthGrant: "absent",
        observedAt: deployedAt,
      })),
    },
    WFP_MANAGEMENT: {
      removeCandidate: vi.fn(async () => ({ status: "removed", outcome: "removed" })),
      observeCandidate: vi.fn(async () => ({
        state: "ready",
        providerTag: wfpReceipt.providerTag,
        productDeploymentId: ids.deploymentId,
        artifactDigest: digest,
      })),
      activateCandidate: vi.fn(async () => ({
        status: "activated",
        candidate: wfpReceipt,
        gateway: gatewayReceipt,
        deploymentUrl: gatewayReceipt.publicOrigin,
      })),
      observeActivation: vi.fn(async () => ({
        status: "activated",
        candidate: wfpReceipt,
        gateway: gatewayReceipt,
        deploymentUrl: gatewayReceipt.publicOrigin,
      })),
      remove: vi.fn(async (input: unknown) => {
        void input;
        return {
          status: "tombstoned",
          receipt: { providerTag: "tombstone-provider-tag" },
        };
      }),
      finalizeRemoval: vi.fn(async (input: unknown) => {
        const record = input as Readonly<Record<string, unknown>>;
        if (record["deploymentId"] === undefined) {
          const scope = record["scope"] as Readonly<Record<string, unknown>>;
          return {
            status: "removed",
            database: {
              state: "absent",
              scriptName: `d-${ids.projectId.toLowerCase()}-${String(scope["environmentId"]).toLowerCase()}`,
              projectId: ids.projectId,
              environmentId: scope["environmentId"],
              observedAt: deployedAt,
            },
          };
        }
        return {
          status: "removed",
          gateway: gatewayAbsence,
          consecutive404s: 3,
        };
      }),
    },
  };
}

function withDatabaseResources(
  value: {
    readonly [key: string]: unknown;
    deletionEnvironments: readonly {
      readonly [key: string]: unknown;
      environmentId: string;
      environmentName: "dev" | "prod";
    }[];
    deletionInventory: readonly ReturnType<typeof deletionInventoryRecord>[];
  },
  dataMode: "shared" | "isolated" = "shared",
) {
  const deletionEnvironments = value.deletionEnvironments.map((environment) => {
    const physical = dataMode === "isolated" || environment.environmentName === "dev";
    const registration = !physical
      ? null
      : {
          ...databaseRegistration,
          physicalEnvironmentId: environment.environmentId,
          originUser: `ohmyho_rw_${environment.environmentId.toLowerCase()}`,
          authorizedEnvironmentIds:
            dataMode === "shared"
              ? value.deletionEnvironments.map((e) => e.environmentId)
              : [environment.environmentId],
          providerProjectId:
            environment.environmentName === "dev"
              ? "quiet-snow-12345678"
              : "quiet-snow-prod-12345678",
          branchId:
            environment.environmentName === "dev"
              ? "br-green-river-12345678"
              : "br-green-prod-12345678",
          claimId: ids.targetRevisionId,
          observedAt: new Date(deployedAt),
        };
    return {
      ...environment,
      databaseRegistration: registration,
      neonPlacement:
        registration === null
          ? null
          : {
              organizationId: ids.organizationId,
              projectId: ids.projectId,
              environmentId: environment.environmentId,
              operationId: ids.operationId,
              claimId: ids.targetRevisionId,
              projectName: `ohmyho-${ids.projectId.toLowerCase()}-${environment.environmentId.toLowerCase()}`,
              regionId: "aws-us-east-2",
              postgresVersion: 17 as const,
              providerProjectId: registration.providerProjectId,
              defaultBranchId: registration.branchId,
              operationIds: [],
              state: "ready" as const,
              observedAt: new Date(deployedAt),
            },
    };
  });
  return {
    ...value,
    dataMode,
    deletionEnvironments,
    deletionDataEnvironments: deletionEnvironments.flatMap((environment) =>
      environment.databaseRegistration === null
        ? []
        : [
            {
              dataEnvironmentId: environment.databaseRegistration.physicalEnvironmentId,
              neonPlacement: environment.neonPlacement,
              databaseRegistration: environment.databaseRegistration,
            },
          ],
    ),
    deletionInventory: [
      ...value.deletionInventory.filter(
        (record) =>
          record.resourceKind !== "database-registration" &&
          record.resourceKind !== "project-database-worker" &&
          record.resourceKind !== "hyperdrive-configuration" &&
          !(record.provider === "neon" && record.resourceKind === "project"),
      ),
      ...deletionEnvironments.flatMap((environment) =>
        environment.databaseRegistration === null
          ? []
          : [
              deletionInventoryRecord(
                "ohmyhost",
                "database-registration",
                environment.databaseRegistration.physicalEnvironmentId,
              ),
              deletionInventoryRecord(
                "neon",
                "project",
                environment.databaseRegistration.providerProjectId,
              ),
            ],
      ),
    ],
  };
}

/** Domain management probes its own host under the environment's wildcard (independent derivation). */
function domainProbeUrl(input: Record<string, unknown>, publicUrl: string): string {
  const label = createHash("sha256")
    .update(
      [
        "shared-gateway-preflight",
        input["projectId"],
        input["environmentId"],
        input["operationId"],
        input["deploymentId"],
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
  const zone = new URL(publicUrl).hostname.split(".").slice(1).join(".");
  return new URL(String(input["healthCheckPath"]), `https://gateway-probe-${label}.${zone}/`).href;
}

describe("DeploymentWorkflow production composition", () => {
  it("retries a committed Native head by ACKing the current policy before terminal completion", async () => {
    const env = bindings();
    env.NATIVE_AUTH_RESOURCE_RUNTIME.readPendingNativePolicySync.mockImplementation(
      async (input) => ({
        ...(input as object),
        state: "pending",
        headVersion: 2,
        targetDeploymentId: ids.deploymentId,
        region: "eu",
        configurationRevision: 3,
        revocationEpoch: 4,
        ownerEnabled: false,
        canonicalOrigin: "https://app.example.test",
        registryVersion: 1,
      }),
    );
    env.NATIVE_AUTH_ADMIN_EU.applyRealmPolicy.mockResolvedValue({ outcome: "applied" });
    env.NATIVE_AUTH_RESOURCE_RUNTIME.completeNativePolicySync.mockResolvedValue("completed");
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "retry",
        executionId: "retry",
        command: command("DeploymentRequestedV1"),
        evidence: {},
      }),
    ).resolves.toBe("applied");
    expect(env.NATIVE_AUTH_ADMIN_EU.applyRealmPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, configurationRevision: 3, revocationEpoch: 4 }),
    );
    expect(env.NATIVE_AUTH_RESOURCE_RUNTIME.completeNativePolicySync).toHaveBeenCalledWith(
      expect.objectContaining({ headVersion: 2, acknowledgement: "applied" }),
    );
    expect(database.readProductWorkflowContext).not.toHaveBeenCalled();
    env.NATIVE_AUTH_RESOURCE_RUNTIME.readPendingNativePolicySync.mockImplementation(
      async (input) => ({
        ...(input as object),
        state: "cleanup_required",
        headVersion: 2,
        targetDeploymentId: ids.deploymentId,
        publication: {},
        bindingRefreshSnapshot: {},
      }),
    );
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "retry",
        executionId: "retry",
        command: command("DeploymentRequestedV1"),
        evidence: {},
      }),
    ).resolves.toEqual({ status: "binding_refresh_pending" });
    expect(database.readProductWorkflowContext).not.toHaveBeenCalled();
  });
  it("loads only accepted immutable custody for fresh binding refresh and stages under its current claim", async () => {
    const refreshCommand = {
      ...command("DeploymentRequestedV1"),
      operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FD5"),
    };
    const newDeployment = "01ARZ3NDEKTSV4RRFFQ69G5FD6";
    const original = contextFor("DeploymentRequestedV1");
    const snapshot = {
      sourceDeploymentId: ids.targetDeploymentId,
      sourceRevisionId: ids.targetRevisionId,
      sourceCandidateReceiptId: ids.sourceConnectionId,
      sourceArtifactId: ids.operationId,
      sourcePlanId: ids.planId,
      sourceBuildExecutionId: ids.operationId,
      sourceArtifactSha256: hex,
      sourceNamespace: rollbackReceipt.namespace,
      sourceScriptName: rollbackReceipt.scriptName,
      sourceProviderTag: rollbackReceipt.providerTag,
      expectedHeadVersion: 7,
      expectedGatewayRevision: 1,
      dataEnvironmentId: ids.environmentId,
      assignmentVersion: 1,
      registrationVersion: 0,
    };
    const current = {
      ...original,
      intent: {
        ...original.intent,
        operationId: refreshCommand.operationId,
        deploymentId: newDeployment,
        bindingRefreshSnapshot: snapshot,
      },
      bindingRefreshArtifact: {
        ...original.rollbackArtifact,
        deploymentId: artifact.provenance.deploymentId,
        output: { ...original.rollbackArtifact.output, ...artifact.provenance.output },
      },
      bindingRefreshPublished: false,
      activeDeploymentId: ids.targetDeploymentId,
      activeDeployment: rollbackReceipt,
      activeGateway: {
        ...gatewayReceipt,
        targetDeploymentId: ids.targetDeploymentId,
        targetScriptName: rollbackReceipt.scriptName,
      },
      knownDeployments: [rollbackReceipt],
    };
    database.readProductWorkflowContext.mockResolvedValue(current);
    const env = bindings();
    env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockResolvedValueOnce({
      status: "staged",
      candidate: {
        ...wfpReceipt,
        productDeploymentId: newDeployment,
        scriptName: `p-${ids.projectId.toLowerCase()}-dev-${newDeployment.toLowerCase()}`,
      },
      priorGateway: current.activeGateway,
      deploymentUrl: gatewayReceipt.publicOrigin,
      activationRuntimePolicy: frameworkPlan.runtimePolicy,
      runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
      runtimeSecretDelivery: {
        generation: 1,
        secretCount: 0,
        manifestDigest: `sha256:${"e".repeat(64)}`,
      },
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);
    const reuse = await ports.build.readBindingRefresh(refreshCommand);
    expect(reuse).toMatchObject({ artifactDigest: digest, published: false });
    if (reuse === null || "completed" in reuse) throw new Error("Private artifact reuse missing");
    await expect(ports.wfp.stage(refreshCommand, reuse.artifact)).resolves.toMatchObject({
      status: "staged",
      artifactDigest: digest,
    });
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactReuse: "binding-refresh",
        deploymentId: newDeployment,
        artifact: expect.objectContaining({
          provenance: expect.objectContaining({ deploymentId: artifact.provenance.deploymentId }),
        }),
      }),
    );
    expect(env.SOURCE_FETCHER.acquireExact).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.startBuild).not.toHaveBeenCalled();
    const newReceipt = {
      ...wfpReceipt,
      productDeploymentId: newDeployment,
      scriptName: `p-${ids.projectId.toLowerCase()}-dev-${newDeployment.toLowerCase()}`,
    };
    const persisted = await ports.persistence.recordCandidate({
      workflowId: deterministicProductCommandWorkflowId(refreshCommand),
      executionId: deterministicProductCommandWorkflowId(refreshCommand),
      command: refreshCommand,
      candidate: {
        candidateReceiptId: null,
        operationId: refreshCommand.operationId,
        receipt: newReceipt,
        previousGateway: gatewayReceipt,
        runtimePolicy: frameworkPlan.runtimePolicy,
        deploymentUrl: gatewayReceipt.publicOrigin,
        artifactDigest: digest,
      },
      evidence: { artifact: reuse.artifact, bindingRefresh: true },
    });
    expect(database.recordProductDeploymentEvidence).not.toHaveBeenCalled();
    expect(database.recordWfpCandidateReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        artifactId: snapshot.sourceArtifactId,
        operationId: refreshCommand.operationId,
        productDeploymentId: newDeployment,
      }),
    );
    const newGateway = {
      ...gatewayReceipt,
      operationId: refreshCommand.operationId,
      candidateReceiptId: persisted.candidateReceiptId,
      targetDeploymentId: newDeployment,
      targetScriptName: newReceipt.scriptName,
      revision: 2,
    };
    const refreshWorkflow = deterministicProductCommandWorkflowId(refreshCommand);
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: refreshWorkflow,
        executionId: refreshWorkflow,
        command: refreshCommand,
        evidence: {
          artifact: reuse.artifact,
          artifactDigest: digest,
          wfp: newReceipt,
          gateway: newGateway,
          deploymentUrl: newGateway.publicOrigin,
          runtimePolicy: frameworkPlan.runtimePolicy,
        },
      }),
    ).resolves.toEqual({ status: "binding_refresh_pending" });
    expect(database.completeProductCommand).not.toHaveBeenCalled();
    const sourceInventory = deletionInventoryRecord(
      "cloudflare",
      "wfp-script",
      `${snapshot.sourceNamespace}/${snapshot.sourceScriptName}`,
    );
    const published = {
      ...current,
      headVersion: 8,
      bindingRefreshPublished: true,
      activeDeploymentId: newDeployment,
      activeDeployment: newReceipt,
      activeGateway: newGateway,
      deletionInventory: [sourceInventory],
      knownDeployments: [rollbackReceipt, newReceipt],
    };
    database.readProductWorkflowContext.mockResolvedValue(published);
    expect(await ports.build.readBindingRefresh(refreshCommand)).toMatchObject({ published: true });
    env.WFP_MANAGEMENT.removeCandidate.mockResolvedValueOnce({
      status: "reconciliation_required",
    } as never);
    await expect(
      ports.persistence.finishBindingRefresh({
        workflowId: refreshWorkflow,
        executionId: refreshWorkflow,
        command: refreshCommand,
        artifact: reuse.artifact,
      }),
    ).resolves.toEqual({ status: "uncertain" });
    expect(database.completeProductCommand).not.toHaveBeenCalled();
    await expect(
      ports.persistence.finishBindingRefresh({
        workflowId: refreshWorkflow,
        executionId: refreshWorkflow,
        command: refreshCommand,
        artifact: reuse.artifact,
      }),
    ).resolves.toBe("applied");
    expect(env.WFP_MANAGEMENT.removeCandidate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateReceiptId: snapshot.sourceCandidateReceiptId,
        candidate: expect.objectContaining({
          productDeploymentId: snapshot.sourceDeploymentId,
          scriptName: snapshot.sourceScriptName,
        }),
      }),
    );
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: refreshCommand.operationId,
        provider: "cloudflare",
        resourceKind: "wfp-script",
        outcome: "removed",
      }),
    );
    expect(database.completeProductCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "DeploymentRequestedV1",
        revisionId: refreshCommand.operationId,
        finalizedWfpResult: expect.objectContaining({
          deploymentId: newDeployment,
          artifactSha256: hex,
        }),
      }),
    );
    const removals = env.WFP_MANAGEMENT.removeCandidate.mock.calls.length;
    database.readProductWorkflowContext.mockResolvedValue({
      ...published,
      deletionInventory: [{ ...sourceInventory, cleanupOutcome: "removed" }],
    });
    await expect(
      ports.persistence.finishBindingRefresh({
        workflowId: refreshWorkflow,
        executionId: refreshWorkflow,
        command: refreshCommand,
        artifact: reuse.artifact,
      }),
    ).resolves.toBe("applied");
    expect(env.WFP_MANAGEMENT.removeCandidate.mock.calls).toHaveLength(removals);
    expect(env.BUILD_RUNNER.removeArchive).not.toHaveBeenCalled();
    env.BUILD_RUNNER.readBuildArtifact.mockResolvedValueOnce({
      ...artifact,
      provenance: { ...artifact.provenance, sourceCommit: "f".repeat(40) },
    });
    await expect(ports.build.readBindingRefresh(refreshCommand)).rejects.toThrow("custody changed");
    database.readProductWorkflowContext.mockResolvedValue({
      ...published,
      bindingRefreshCompleted: true,
    });
    expect(await ports.build.readBindingRefresh(refreshCommand)).toEqual({ completed: true });
    await expect(
      ports.persistence.finishBindingRefresh({
        workflowId: refreshWorkflow,
        executionId: refreshWorkflow,
        command: refreshCommand,
        artifact: reuse.artifact,
      }),
    ).resolves.toBe("duplicate");
  });
  it.each([
    "observed",
    "unhealthy",
    "unknown",
    "wrong-target",
    "health-uncertain",
    "health-mismatch",
    "gateway-uncertain",
    "layout-outdated",
    "layout-missing-reason",
    "layout-wrong-reason",
    "layout-wrong-phase",
    "layout-wrong-scope",
    "layout-wrong-target",
    "layout-wrong-source",
    "layout-wrong-operation",
    "layout-policy-mismatch",
    "layout-current-mismatch",
    "layout-inactive",
    "layout-null-gateway",
    "layout-extra-field",
  ])(
    "uses only the observed abandoned predecessor for gateway replacement (%s)",
    async (observation) => {
      const oldCandidate = { ...rollbackReceipt, providerTag: "b".repeat(32) };
      const oldPolicy = {
        healthCheckPath: "/old-health",
        egressAllowedOrigins: ["https://old.example.com"],
      };
      const predecessor = {
        ...gatewayReceipt,
        observedAt: new Date(gatewayReceipt.observedAt),
        targetScriptName: oldCandidate.scriptName,
        targetDeploymentId: oldCandidate.productDeploymentId,
        targetArtifactDigest: oldCandidate.artifactDigest,
        targetProviderTag: oldCandidate.providerTag,
        operationId: ids.targetRevisionId,
        egressAllowedOrigins: oldPolicy.egressAllowedOrigins,
      };
      database.readProductWorkflowContext.mockResolvedValue({
        ...contextFor("DeploymentRequestedV1"),
        activeDeploymentId: null,
        activeDeployment: null,
        activeGateway: null,
        abandonedWfpTargets: [
          {
            candidateReceiptId: ids.sourceConnectionId,
            operationId: ids.targetRevisionId,
            candidate: oldCandidate,
            runtimePolicy: oldPolicy,
          },
        ],
      });
      const env = bindings();
      const uncertain = observation.startsWith("health-") || observation === "gateway-uncertain";
      env.WFP_MANAGEMENT.observeActivation.mockResolvedValueOnce(
        (observation.startsWith("layout-")
          ? {
              status: "reconciliation_required",
              reconciliationPhase: observation === "layout-wrong-phase" ? "gateway" : "candidate",
              ...(observation === "layout-missing-reason"
                ? {}
                : {
                    reason:
                      observation === "layout-wrong-reason"
                        ? "provider secret text"
                        : "candidate_bindings_outdated",
                  }),
              currentProviderTag:
                observation === "layout-current-mismatch"
                  ? "c".repeat(32)
                  : oldCandidate.providerTag,
              currentProductDeploymentId: oldCandidate.productDeploymentId,
              gateway:
                observation === "layout-null-gateway"
                  ? null
                  : {
                      ...predecessor,
                      ...(observation === "layout-wrong-scope"
                        ? { organizationId: ids.sourceConnectionId }
                        : {}),
                      ...(observation === "layout-wrong-target"
                        ? { targetProviderTag: "c".repeat(32) }
                        : {}),
                      ...(observation === "layout-wrong-source"
                        ? { candidateReceiptId: ids.targetRevisionId }
                        : {}),
                      ...(observation === "layout-wrong-operation"
                        ? { operationId: ids.operationId }
                        : {}),
                      ...(observation === "layout-policy-mismatch"
                        ? { egressAllowedOrigins: [] }
                        : {}),
                      ...(observation === "layout-inactive" ? { active: false } : {}),
                    },
              ...(observation === "layout-extra-field" ? { providerSecret: "must-not-cross" } : {}),
            }
          : uncertain
            ? {
                status: "reconciliation_required",
                reconciliationPhase: observation === "gateway-uncertain" ? "gateway" : "health",
                currentProviderTag: predecessor.targetProviderTag,
                currentProductDeploymentId:
                  observation === "health-mismatch"
                    ? ids.deploymentId
                    : oldCandidate.productDeploymentId,
                gateway: predecessor,
              }
            : {
                status:
                  observation === "unknown"
                    ? "reconciliation_required"
                    : observation === "wrong-target"
                      ? "observed"
                      : observation,
                candidate: oldCandidate,
                gateway:
                  observation === "wrong-target"
                    ? { ...predecessor, targetProviderTag: "c".repeat(32) }
                    : predecessor,
                deploymentUrl: predecessor.publicOrigin,
              }) as never,
      );
      const verified =
        observation === "observed" ||
        observation === "unhealthy" ||
        observation === "health-uncertain" ||
        observation === "layout-outdated";
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockResolvedValueOnce({
        status: "staged",
        candidate: wfpReceipt,
        priorGateway: verified ? predecessor : null,
        activationRuntimePolicy: frameworkPlan.runtimePolicy,
        deploymentUrl: gatewayReceipt.publicOrigin,
        runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
        runtimeSecretDelivery: {
          generation: 4,
          secretCount: 0,
          manifestDigest: `sha256:${"e".repeat(64)}`,
        },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      } as never);
      const ports = createDeploymentWorkflowPorts(env);
      await ports.wfp.stage(command("DeploymentRequestedV1"), artifact);
      expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: oldCandidate, runtimePolicy: oldPolicy }),
      );
      const request = (
        env.RUNTIME_SECRET_DELIVERY.stageCandidate.mock.calls[0] as unknown as [
          Record<string, unknown>,
        ]
      )[0];
      if (verified) {
        expect(request["previousGateway"]).toMatchObject({
          targetDeploymentId: oldCandidate.productDeploymentId,
          revision: predecessor.revision,
          targetProviderTag: predecessor.targetProviderTag,
        });
        expect(database.recordAbandonedGatewayPredecessor).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            operationId: ids.operationId,
            candidateReceiptId: ids.sourceConnectionId,
            sharedGatewayRevision: predecessor.revision,
          }),
        );
      } else {
        expect(request).not.toHaveProperty("previousGateway");
        expect(database.recordAbandonedGatewayPredecessor).not.toHaveBeenCalled();
      }
      expect(database.finalizeWfpCandidateDeployment).not.toHaveBeenCalled();
    },
  );

  it("removes the environment schedules and runs the complete data-change step ports", async () => {
    const ports = createDeploymentWorkflowPorts(bindings());

    await expect(ports.schedules.remove(command("ProjectDeletionRequestedV1"))).resolves.toEqual({
      removed: 0,
    });

    const env = bindings();
    const dataPorts = createDeploymentWorkflowPorts(env, () => new Date(deployedAt));
    const dataCommand = {
      ...command("ProjectDataChangeRequestedV1"),
      dataChange: "reset_dev" as const,
    };
    const assignments = {
      dataMode: "isolated" as const,
      dev: { environmentId: ids.environmentId, dataEnvironmentId: ids.environmentId },
      prod: { environmentId: ids.sourceEnvironmentId, dataEnvironmentId: ids.sourceEnvironmentId },
    };
    const transition = {
      change: "reset_dev",
      before: assignments,
      after: {
        ...assignments,
        dev: { ...assignments.dev, dataEnvironmentId: ids.targetRevisionId },
      },
      retiredDataEnvironmentIds: [ids.environmentId],
      reauthorizations: [
        { dataEnvironmentId: ids.environmentId, authorizedEnvironmentIds: [], direction: "narrow" },
      ],
      redeployEnvironments: ["dev"],
      removeDevDeployment: true,
    };
    const current = {
      ...contextFor("ProjectDataChangeRequestedV1"),
      intent: {
        ...contextFor("ProjectDataChangeRequestedV1").intent,
        dataChange: "reset_dev",
        dataChangeSnapshot: {
          transition,
          registrationGenerations: [
            { dataEnvironmentId: ids.environmentId, registrationVersion: 1 },
            { dataEnvironmentId: ids.sourceEnvironmentId, registrationVersion: 0 },
          ],
        },
        cleanupRunId: ids.eventId,
      },
      deletionInventory: [
        deletionInventoryRecord(
          "cloudflare",
          "wfp-script",
          `${wfpReceipt.namespace}/${wfpReceipt.scriptName}`,
        ),
        deletionInventoryRecord("neon", "project", "quiet-snow-12345678"),
      ],
    };
    const candidate = {
      candidateReceiptId: ids.sourceConnectionId,
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      productDeploymentId: ids.deploymentId,
      artifactId: ids.operationId,
      namespace: wfpReceipt.namespace,
      immutableScriptName: wfpReceipt.scriptName,
      artifactDigest: Buffer.from(hex, "hex"),
      providerTag: wfpReceipt.providerTag,
      buildReused: false,
      stagedAt: deployedAt,
    };
    database.readProductWorkflowContext.mockResolvedValue(current);
    database.readWfpProjectDeletionEvidence.mockResolvedValue({
      candidates: [candidate],
      activeGateways: [{ ...gatewayReceipt, observedAt: new Date(deployedAt) }],
    } as never);
    database.readNeonProjectPlacement.mockResolvedValue({
      providerProjectId: "quiet-snow-12345678",
      defaultBranchId: "br-green-river-12345678",
    });
    database.readProjectDatabaseRegistrationTarget.mockResolvedValue(databaseRegistration);
    const port = dataPorts.dataChange;
    if (!port) throw new Error("Data change ports missing");
    await expect(port.readPlan(dataCommand)).resolves.toMatchObject({
      removeDevDeployment: true,
      retiredDataEnvironmentIds: [ids.environmentId],
    });
    expect(database.startProjectDataChangeCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ids.organizationId,
        operationId: ids.operationId,
        snapshot: current.intent.dataChangeSnapshot,
      }),
    );
    await expect(port.revokeDatabaseAccess(dataCommand)).resolves.toEqual({ status: "ready" });
    expect(env.NEON_MANAGEMENT.revokeDataChangeAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        losingEnvironmentId: ids.environmentId,
        operationId: ids.operationId,
      }),
    );
    await expect(port.reauthorize(dataCommand, ids.environmentId, "narrow")).resolves.toEqual({
      status: "ready",
    });
    expect(env.NEON_MANAGEMENT.reauthorizeDataEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        physicalEnvironmentId: ids.environmentId,
        authorizedEnvironmentIds: [],
      }),
    );
    await expect(port.removeDevDeployment(dataCommand)).resolves.toEqual({ status: "ready" });
    expect(env.WFP_MANAGEMENT.removeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          environmentId: ids.environmentId,
          environmentName: "dev",
        }),
      }),
    );
    await expect(port.switchAssignments(dataCommand)).resolves.toBe("applied");
    expect(database.appendAuditedProjectDataChangeAssignments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ids.organizationId,
        operationId: ids.operationId,
        snapshot: current.intent.dataChangeSnapshot,
      }),
    );
    await expect(port.purgeFiles(dataCommand, ids.environmentId)).resolves.toEqual({
      status: "ready",
      deletedFiles: 0,
    });
    env.STORAGE_DATA_MANAGEMENT.purgeRetiredData.mockResolvedValueOnce({
      status: "pending",
      retryAfterSeconds: 1,
      progress: "page_completed",
    });
    await expect(port.purgeFiles(dataCommand, ids.environmentId)).resolves.toEqual({
      status: "pending",
      retryAfterSeconds: 1,
      progress: "page_completed",
    });
    env.STORAGE_DATA_MANAGEMENT.purgeRetiredData.mockResolvedValueOnce({
      status: "pending",
      retryAfterSeconds: 1,
      progress: "unconfirmed",
    });
    await expect(port.purgeFiles(dataCommand, ids.environmentId)).rejects.toThrow(
      "Retired upload expiry is invalid",
    );
    await expect(port.retireDatabase(dataCommand, ids.environmentId)).resolves.toEqual({
      status: "ready",
      deletedDatabase: true,
    });
    const reauthorizationsBefore = env.NEON_MANAGEMENT.reauthorizeDataEnvironment.mock.calls.length;
    database.readProductWorkflowContext.mockResolvedValue({
      ...current,
      intent: {
        ...current.intent,
        dataChangeSnapshot: {
          ...current.intent.dataChangeSnapshot,
          registrationGenerations: [
            { dataEnvironmentId: ids.environmentId, registrationVersion: 0 },
            { dataEnvironmentId: ids.sourceEnvironmentId, registrationVersion: 0 },
          ],
        },
      },
    });
    database.readNeonProjectPlacement.mockResolvedValue(null);
    database.readProjectDatabaseRegistrationTarget.mockResolvedValue(null);
    await expect(port.reauthorize(dataCommand, ids.environmentId, "narrow")).resolves.toEqual({
      status: "ready",
    });
    expect(env.NEON_MANAGEMENT.reauthorizeDataEnvironment).toHaveBeenCalledTimes(
      reauthorizationsBefore,
    );
    await expect(port.switchAssignments(dataCommand)).resolves.toBe("applied");
    await expect(port.retireDatabase(dataCommand, ids.environmentId)).resolves.toEqual({
      status: "ready",
      deletedDatabase: false,
    });
    await expect(port.purgeFiles(dataCommand, ids.sourceEnvironmentId)).rejects.toThrow(
      "retired database",
    );
    await expect(port.retireDatabase(dataCommand, ids.sourceEnvironmentId)).rejects.toThrow(
      "not retired",
    );
  });

  it("retires registered Next cache scopes only under deletion authority and records each success before paging", async () => {
    database.readProductWorkflowContext.mockResolvedValue(contextFor("ProjectDeletionRequestedV1"));
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const scope = { environmentId: ids.environmentId, deploymentId: ids.deploymentId };
    nextCacheRetirementRecorders.list
      .mockResolvedValueOnce({ scopes: [scope], nextCursor: ids.deploymentId })
      .mockResolvedValueOnce(null);
    expect(await ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).toEqual({
      status: "uncertain",
    });
    const authority = {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      operationId: ids.operationId,
      cleanupRunId: ids.eventId,
    };
    expect(env.NEXT_CACHE_RETIREMENT.retire).toHaveBeenCalledWith({ ...authority, ...scope });
    expect(nextCacheRetirementRecorders.record).toHaveBeenCalledWith({ ...authority, ...scope });
    expect(nextCacheRetirementRecorders.list).toHaveBeenLastCalledWith({
      ...authority,
      cursor: ids.deploymentId,
      limit: 100,
    });
    env.NEXT_CACHE_RETIREMENT.retire.mockClear();
    nextCacheRetirementRecorders.list.mockResolvedValueOnce(null);
    expect(await ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).toEqual({
      status: "uncertain",
    });
    expect(env.NEXT_CACHE_RETIREMENT.retire).not.toHaveBeenCalled();
    nextCacheRetirementRecorders.list.mockResolvedValueOnce({ scopes: [scope], nextCursor: null });
    nextCacheRetirementRecorders.record.mockResolvedValueOnce(null);
    expect(await ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).toEqual({
      status: "uncertain",
    });
  });

  it("deletes current PGCF targets without touching retained Neon provenance, including retired retries", async () => {
    const legacy = withDatabaseResources(contextFor("ProjectDeletionRequestedV1"), "shared");
    const old = legacy.deletionDataEnvironments[0];
    if (!old?.databaseRegistration) throw new Error("Legacy registration fixture is absent");
    const { branchId: _branchId, ...base } = old.databaseRegistration;
    void _branchId;
    const registration = {
      ...base,
      provider: "pgcf" as const,
      providerProjectId: "prj_abcdefghijklmnopqrst",
      databaseId: "abcdefghijklmnopqrst",
      originHost: "abcdefghijklmnopqrst.us.db.example.com",
      originDatabase: "abcdefghijklmnopqrst",
    };
    const target = {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      physicalEnvironmentId: ids.environmentId,
      provider: "pgcf" as const,
      providerProjectId: registration.providerProjectId,
      databaseId: registration.databaseId,
      targetVersion: 2,
      state: "active" as const,
    };
    const historicalNeon = {
      dataEnvironmentId: ids.targetRevisionId,
      providerTarget: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        physicalEnvironmentId: ids.targetRevisionId,
        provider: "neon" as const,
        state: "retired" as const,
        targetVersion: 1,
        providerProjectId: "retained-neon-history",
        branchId: "br-retained-history",
      },
      neonPlacement: {
        ...old.neonPlacement,
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.targetRevisionId,
        providerProjectId: "retained-neon-history",
        defaultBranchId: "br-retained-history",
      },
      databaseRegistration: {
        ...old.databaseRegistration,
        physicalEnvironmentId: ids.targetRevisionId,
        providerProjectId: "retained-neon-history",
        branchId: "br-retained-history",
      },
    };
    const scoped = {
      ...legacy,
      deletionDataEnvironments: [
        historicalNeon,
        { ...old, providerTarget: target, databaseRegistration: registration },
      ],
      deletionInventory: [
        ...legacy.deletionInventory.filter((item) => item.provider !== "neon"),
        deletionInventoryRecord("pgcf", "database", target.databaseId),
      ],
    };
    database.readProductWorkflowContext.mockResolvedValue(scoped);
    const env = bindings(),
      ports = createDeploymentWorkflowPorts(env);
    const revoked = { ...registration, status: "revoked", registrationVersion: 2 };
    env.NEON_MANAGEMENT.deleteProject.mockResolvedValueOnce({
      status: "reconciliation_required",
      phase: "pgcf",
      databaseRegistration: revoked,
    } as never);
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "uncertain" });
    expect(env.NEON_MANAGEMENT.deleteProject).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      operationId: ids.operationId,
      providerProjectId: target.providerProjectId,
      databaseId: target.databaseId,
      physicalEnvironmentId: ids.environmentId,
      registrationVersion: 1,
    });
    const response = {
      status: "absent",
      provider: "pgcf",
      providerProjectId: target.providerProjectId,
      databaseId: target.databaseId,
      databaseRegistration: revoked,
      outcome: "replayed",
    };
    env.NEON_MANAGEMENT.deleteProject.mockResolvedValue(response as never);
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(
      env.NEON_MANAGEMENT.deleteProject.mock.calls.every(
        ([input]) => !("defaultBranchId" in (input as object)),
      ),
    ).toBe(true);
    env.NEON_MANAGEMENT.deleteProject.mockClear();
    env.SES_MANAGEMENT.deleteMailProject.mockClear();
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      deletionInventory: [
        ...scoped.deletionInventory,
        deletionInventoryRecord("neon", "project", "retained-neon-history"),
      ],
    });
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "no active provider target",
    );
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.deleteMailProject).not.toHaveBeenCalled();
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      deletionDataEnvironments: [
        {
          ...scoped.deletionDataEnvironments[1],
          providerTarget: { ...target, state: "retired" },
          databaseRegistration: revoked,
        },
      ],
    });
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "pgcf", resourceKind: "database", outcome: "not_found" }),
    );
    expect(
      database.recordCleanupAttempt.mock.calls.some((call) => (call as any)[1].provider === "neon"),
    ).toBe(false);
    env.NEON_MANAGEMENT.deleteProject.mockClear();
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      deletionInventory: scoped.deletionInventory.filter((item) => item.provider !== "pgcf"),
    });
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "PGCF cleanup evidence",
    );
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      deletionDataEnvironments: [
        {
          ...scoped.deletionDataEnvironments[1],
          providerTarget: { ...target, organizationId: ids.eventId },
        },
      ],
    });
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "provider scope",
    );
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      deletionInventory: scoped.deletionInventory.filter((item) => item.provider !== "pgcf"),
      deletionDataEnvironments: [
        {
          ...scoped.deletionDataEnvironments[1],
          providerTarget: { ...target, state: "retired" },
          databaseRegistration: revoked,
        },
      ],
    });
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    const reset = { ...command("ProjectDataChangeRequestedV1"), dataChange: "reset_dev" as const };
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      intent: {
        ...contextFor("ProjectDataChangeRequestedV1").intent,
        eventType: reset.eventType,
        dataChange: reset.dataChange,
        dataChangeSnapshot: {
          transition: {
            change: reset.dataChange,
            before: { dev: { environmentId: ids.environmentId } },
            retiredDataEnvironmentIds: [ids.environmentId],
          },
        },
      },
    });
    database.readProductWorkflowDatabaseTarget.mockResolvedValueOnce({
      ...old,
      providerTarget: target,
      databaseRegistration: registration,
    });
    if (!ports.dataChange) throw new Error("Data change ports are absent");
    await expect(ports.dataChange.retireDatabase(reset, ids.environmentId)).resolves.toEqual({
      status: "ready",
      deletedDatabase: true,
    });
    expect(env.NEON_MANAGEMENT.deleteProject).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: target.databaseId,
        physicalEnvironmentId: ids.environmentId,
      }),
    );
  });

  it("carries the trusted binding digest over private RPC and persisted workflow restart", async () => {
    const expected = `sha256:${"cd".repeat(32)}`;
    const bundle = await build({
      stdin: {
        contents: `
          import { WorkerEntrypoint } from "cloudflare:workers";
          import { createRuntimeSecretDelivery } from "./apps/runtime-secret-delivery/src/runtime.ts";
          const expected = ${JSON.stringify(expected)};
          const lease = ${JSON.stringify(ids.eventId)};
          const receipt = {...${JSON.stringify(wfpReceipt)},bindingSetDigest:expected};
          const gateway = ${JSON.stringify(gatewayReceipt)};
          function runtime(mismatch = false) {
            const unused = async () => { throw new Error("unexpected call"); };
            return createRuntimeSecretDelivery({
              persistence: {
                claim: async (input) => ({outcome:"claimed", generation:1, releaseSequence:1,
                  trigger:input.trigger, runtimeProvider:"wfp", leaseId:lease,
                  leaseExpiresAt:"2026-08-21T00:02:00.000Z", providerTag:null,
                  appliedSecretNames:[], secrets:[]}),
                fail: async () => "failed", release: async () => "released",
                readPending: async () => [], readState: async () => undefined,
                readRecordedWfpStage: async () => null,
                readActiveWfpTarget: async () => ({deployment:receipt,
                  candidateReceiptId:${JSON.stringify(ids.sourceConnectionId)},
                  operationId:${JSON.stringify(ids.operationId)},gateway}),
              },
              cipher: {openEnvironmentSecret: unused},
              wfp: {
                stageVerifiedArtifact: async (input) => ({
                  status:"staged", candidate:{provider:"cloudflare-wfp", namespace:"sandbox",
                    scriptName:"p-"+input.scope.projectId.toLowerCase()+"-dev-"+input.deploymentId.toLowerCase(),
                    projectId:input.scope.projectId, environmentId:input.scope.environmentId,
                    productDeploymentId:input.deploymentId, providerTag:"a".repeat(32),
                    artifactDigest:${JSON.stringify(digest)}, buildReused:false,
                    deployedAt:new Date(${JSON.stringify(deployedAt)}), bindingSetDigest:expected},
                  priorGateway:null, activationRuntimePolicy:{healthCheckPath:"/",egressAllowedOrigins:[]},
                  deploymentUrl:${JSON.stringify(gatewayReceipt.publicOrigin)},
                  runtimeSecretManifestDigest:input.runtimeSecretManifest.digest,
                }),
                prepareExistingCandidate: async (input) => ({status:"prepared",
                  candidate:mismatch ? {...input.candidate,bindingSetDigest:"sha256:"+"ef".repeat(32)} : input.candidate,
                  activationRuntimePolicy:{healthCheckPath:"/",egressAllowedOrigins:[]},
                  runtimeSecretManifestDigest:input.runtimeSecretManifest.digest}),
                activateCandidate:async (input) => ({status:"activated",
                  candidate:mismatch ? {...input.candidate,bindingSetDigest:"sha256:"+"ef".repeat(32)} : input.candidate,
                  gateway,deploymentUrl:gateway.publicOrigin}),
                observeActivation:async (input) => ({status:"activated",
                  candidate:mismatch ? {...input.candidate,bindingSetDigest:"sha256:"+"ef".repeat(32)} : input.candidate,
                  gateway,deploymentUrl:gateway.publicOrigin,
                  health:{status:200,path:"/",excerpt:null,truncated:false}}),
                removeCandidate:async (input) => {
                  if (input.candidate.bindingSetDigest !== expected) throw new Error("digest missing");
                  return {status:"removed",outcome:"removed",receipt:{state:"metadata_absent",
                    namespace:input.candidate.namespace,scriptName:input.candidate.scriptName,
                    projectId:input.scope.projectId,environmentId:input.scope.environmentId,
                    expectedProviderTag:input.candidate.providerTag,observedAt:new Date(${JSON.stringify(deployedAt)})}};
                },
                compensateGatewayActivation:unused, compensateActivation:unused,
                syncRuntimeSecrets:unused,
              },
              ids:{next:()=>lease}, clock:{now:()=>new Date("2026-08-21T00:00:00.000Z")},
              entropy:{fill:(bytes)=>bytes.fill(7)},
            });
          }
          export class Secret extends WorkerEntrypoint {
            stageCandidate(input) { return runtime().stageCandidate(input); }
            prepareExistingCandidate(input) { return runtime().prepareExistingCandidate(input); }
            prepareMismatch(input) { return runtime(true).prepareExistingCandidate(input); }
            activateCandidate(input) { return runtime().activateCandidate(input); }
            activateMismatch(input) { return runtime(true).activateCandidate(input); }
            observeActivation(input) { return runtime().observeActivation(input); }
            observeMismatch(input) { return runtime(true).observeActivation(input); }
            reconcileRuntimeSecrets(input) { return runtime().reconcileRuntimeSecrets(input); }
            removePersistedCandidate(input) { return runtime().removePersistedCandidate(input); }
            prepareInherited(input) {
              const candidate=Object.assign(Object.create({get bindingSetDigest(){throw new Error("inherited getter read");}}),input.candidate);
              return runtime().prepareExistingCandidate({...input,candidate});
            }
          }
          export default {fetch(){return new Response("private");}};
        `,
        resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2024",
      conditions: ["source", "workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["cloudflare:workers", "node:*"],
      write: false,
      logLevel: "error",
    });
    const require = createRequire(new URL("../../control-store/package.json", import.meta.url));
    const { Miniflare, convertV4MiniflareOptions } = createRequire(
      require.resolve("wrangler/package.json"),
    )("miniflare") as {
      convertV4MiniflareOptions(value: unknown): unknown;
      Miniflare: new (value: unknown) => {
        getWorker(
          name: string,
        ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
        dispose(): Promise<void>;
      };
    };
    const script = bundle.outputFiles[0]?.text;
    if (script === undefined) throw new Error("Missing secret delivery bundle");
    const common = {
      modules: true,
      compatibilityDate: "2026-08-24",
      compatibilityFlags: ["nodejs_compat"],
    };
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          { ...common, name: "secret", script },
          {
            ...common,
            name: "caller",
            serviceBindings: { SECRET: { name: "secret", entrypoint: "Secret" } },
            script: `export default {async fetch(req,env){const {action,input,injectUndefined}=await req.json();if(injectUndefined) input.candidate.bindingSetDigest=undefined;try{return Response.json({value:await env.SECRET[action](input)});}catch(error){return Response.json({error:String(error.message)},{status:400});}}};`,
          },
        ],
      }),
    );
    try {
      const caller = await mf.getWorker("caller");
      const rpc = async (action: string, input: unknown, injectUndefined = false): Promise<any> => {
        const response = await caller.fetch("https://fixture/", {
          method: "POST",
          body: JSON.stringify({ action, input, injectUndefined }),
        });
        const result = (await response.json()) as { value?: unknown; error?: string };
        if (!response.ok) throw new Error(result.error);
        return result.value;
      };
      const initialScope = {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        environmentName: "dev",
        handle: "calm-otter-builds",
        operationId: ids.operationId,
      };
      const prepared = await rpc("prepareExistingCandidate", {
        scope: initialScope,
        artifact: {},
        artifactSourceDeploymentId: ids.deploymentId,
        candidate: { ...wfpReceipt, bindingSetDigest: expected },
      });
      expect(prepared.candidate.bindingSetDigest).toBe(expected);
      const env = bindings();
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockImplementation(
        async (input?: unknown): Promise<any> => rpc("stageCandidate", input),
      );
      env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate.mockImplementation(
        async (input?: unknown): Promise<any> => rpc("removePersistedCandidate", input),
      );
      const ports = createDeploymentWorkflowPorts(env);
      const deploy = command("DeploymentRequestedV1");
      const published = await ports.wfp.stage(deploy, artifact);
      if (published.status !== "staged") throw new Error("Expected staged candidate");
      expect(published.receipt).toMatchObject({ bindingSetDigest: expected });
      await ports.persistence.recordCandidate({
        workflowId: "binding-digest",
        executionId: "binding-digest",
        command: deploy,
        candidate: published,
        evidence: { archive, build: buildReceipt, artifact: artifactReference },
      });
      const stored = (
        database.recordWfpCandidateReceipt.mock.calls as unknown as [unknown, any][]
      ).at(-1)?.[1];
      expect(stored.bindingSetDigest).toEqual(
        Uint8Array.from(Buffer.from(expected.slice(7), "hex")),
      );
      database.claimPendingWfpCandidateCleanup.mockResolvedValueOnce({
        claimId: parseUlid(ids.targetRevisionId),
        candidateReceiptId: stored.candidateReceiptId,
        candidate: stored,
        expectedResources: [],
      });
      const restarted = createDeploymentWorkflowPorts(env);
      const claimed = await restarted.persistence.claimCandidateCleanup(deploy);
      if (claimed === null) throw new Error("Expected persisted candidate");
      expect(claimed.candidate.receipt).toMatchObject({ bindingSetDigest: expected });
      const candidate = {
        ...published,
        candidateReceiptId: stored.candidateReceiptId,
        receipt: claimed.candidate.receipt,
      };
      await restarted.wfp.activate(deploy, candidate);
      await restarted.wfp.observeActivation(deploy, candidate);
      expect(env.WFP_MANAGEMENT.activateCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: expected }),
        }),
      );
      expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: expected }),
        }),
      );
      await restarted.wfp.removeClaimedCandidate(deploy, claimed);
      expect(env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: expected }),
        }),
      );
      const scope = {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        environmentName: "dev",
        handle: "calm-otter-builds",
        operationId: ids.operationId,
      };
      const input = {
        scope,
        artifact: {},
        artifactSourceDeploymentId: ids.deploymentId,
        candidate: published.receipt,
      };
      expect((await rpc("prepareExistingCandidate", input)).candidate.bindingSetDigest).toBe(
        expected,
      );
      const legacy = { ...(published.receipt as Record<string, unknown>) };
      delete legacy["bindingSetDigest"];
      const legacyResult = await rpc("prepareExistingCandidate", { ...input, candidate: legacy });
      expect(legacyResult.candidate).toEqual(legacy);
      expect(Object.keys(legacyResult.candidate)).toHaveLength(10);
      const inheritedResult = await rpc("prepareInherited", { ...input, candidate: legacy });
      expect(inheritedResult.candidate).toEqual(legacy);
      const inherited = Object.assign(
        Object.create({
          get bindingSetDigest(): never {
            throw new Error("inherited getter read");
          },
        }),
        legacy,
      );
      await ports.persistence.recordCandidate({
        workflowId: "inherited",
        executionId: "inherited",
        command: deploy,
        candidate: { ...published, receipt: inherited },
        evidence: { archive, build: buildReceipt, artifact: artifactReference },
      });
      const inheritedStored = (
        database.recordWfpCandidateReceipt.mock.calls as unknown as [unknown, any][]
      ).at(-1)?.[1];
      expect(inheritedStored).not.toHaveProperty("bindingSetDigest");
      const stage = {
        ...prepared.runtimeSecretDeliveryStage,
        candidateReceiptId: ids.sourceConnectionId,
        outcome: "staged",
      };
      const action = {
        scope,
        candidate: published.receipt,
        runtimeSecretDeliveryStage: stage,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      };
      expect(
        (await rpc("activateCandidate", { ...action, claimId: ids.targetRevisionId })).candidate
          .bindingSetDigest,
      ).toBe(expected);
      expect((await rpc("observeActivation", action)).candidate.bindingSetDigest).toBe(expected);
      await expect(
        rpc("activateMismatch", { ...action, claimId: ids.targetRevisionId }),
      ).rejects.toThrow();
      await expect(rpc("observeMismatch", action)).rejects.toThrow();
      await expect(
        rpc("reconcileRuntimeSecrets", { scope, expectedDeployment: legacy }),
      ).rejects.toThrow();
      await ports.persistence.recordCandidate({
        workflowId: "legacy",
        executionId: "legacy",
        command: deploy,
        candidate: { ...published, receipt: legacy },
        evidence: { archive, build: buildReceipt, artifact: artifactReference },
      });
      const legacyStored = (
        database.recordWfpCandidateReceipt.mock.calls as unknown as [unknown, any][]
      ).at(-1)?.[1];
      expect(legacyStored).not.toHaveProperty("bindingSetDigest");
      database.claimPendingWfpCandidateCleanup.mockResolvedValueOnce({
        claimId: parseUlid(ids.targetRevisionId),
        candidateReceiptId: legacyStored.candidateReceiptId,
        candidate: legacyStored,
        expectedResources: [],
      });
      const legacyClaim = await restarted.persistence.claimCandidateCleanup(deploy);
      expect(legacyClaim?.candidate.receipt).not.toHaveProperty("bindingSetDigest");
      const inheritedPersisted = Object.assign(
        Object.create({
          get bindingSetDigest(): never {
            throw new Error("inherited getter read");
          },
        }),
        legacyStored,
      );
      database.claimPendingWfpCandidateCleanup.mockResolvedValueOnce({
        claimId: parseUlid(ids.targetRevisionId),
        candidateReceiptId: legacyStored.candidateReceiptId,
        candidate: inheritedPersisted,
        expectedResources: [],
      });
      const inheritedClaim = await restarted.persistence.claimCandidateCleanup(deploy);
      expect(inheritedClaim?.candidate.receipt).not.toHaveProperty("bindingSetDigest");
      let inventoryCandidate: any = stored;
      const inventory = createCoreDeploymentInventory({
        listNextCacheRetirementScopes: async () => null,
        recordNextCacheRetired: async () => null,
        readWfpProjectDeletionEvidence: async () => ({
          candidates: [inventoryCandidate],
          activeGateways: [],
        }),
        readCandidateCleanupResources: async () => ({
          sourceArchives: [],
          artifactExpectations: [],
        }),
        recordCleanupAttempt: async () => "created",
        startProjectDataChangeCleanup: async () => "created",
        appendAuditedProjectDataChangeAssignments: async () => "created",
        deleteProjectFunctionSchedules: async () => 0,
        readManagedSourceDeletionInventory: async () => ({ repos: [], blobOperations: [] }),
      });
      const inventoryScope = {
        organizationId: parseUlid(ids.organizationId),
        projectId: parseUlid(ids.projectId),
      };
      expect(
        (await inventory.readDeletionEvidence(inventoryScope)).candidates[0]?.bindingSetDigest,
      ).toEqual(stored.bindingSetDigest);
      inventoryCandidate = legacyStored;
      expect(
        (await inventory.readDeletionEvidence(inventoryScope)).candidates[0],
      ).not.toHaveProperty("bindingSetDigest");
      inventoryCandidate = inheritedPersisted;
      expect(
        (await inventory.readDeletionEvidence(inventoryScope)).candidates[0],
      ).not.toHaveProperty("bindingSetDigest");
      for (const invalid of [null, undefined, new Uint8Array(31)]) {
        inventoryCandidate = { ...legacyStored, bindingSetDigest: invalid };
        await expect(inventory.readDeletionEvidence(inventoryScope)).rejects.toThrow(
          "deployment_inventory_response_invalid",
        );
      }
      inventoryCandidate = { ...legacyStored, foreign: true };
      await expect(inventory.readDeletionEvidence(inventoryScope)).rejects.toThrow(
        "deployment_inventory_response_invalid",
      );
      inventoryCandidate = stored;
      const inventoryPorts = createPorts(
        env,
        {
          ...createRecordedDataPorts(() => new Date(deployedAt)),
          inventory,
        },
        () => new Date(deployedAt),
      );
      database.readProductWorkflowContext.mockResolvedValue(
        contextFor("ProjectDeletionRequestedV1"),
      );
      env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate.mockClear();
      await expect(
        inventoryPorts.wfp.tombstone(command("ProjectDeletionRequestedV1")),
      ).resolves.toMatchObject({ status: "observed" });
      expect(env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: expected }),
        }),
      );
      const dataCommand = {
        ...command("ProjectDataChangeRequestedV1"),
        dataChange: "reset_dev" as const,
      };
      const assignments = {
        dataMode: "isolated" as const,
        dev: { environmentId: ids.environmentId, dataEnvironmentId: ids.environmentId },
        prod: {
          environmentId: ids.sourceEnvironmentId,
          dataEnvironmentId: ids.sourceEnvironmentId,
        },
      };
      const base = contextFor("ProjectDataChangeRequestedV1");
      database.readProductWorkflowContext.mockResolvedValue({
        ...base,
        intent: {
          ...base.intent,
          dataChange: "reset_dev",
          cleanupRunId: ids.eventId,
          dataChangeSnapshot: {
            transition: {
              change: "reset_dev",
              before: assignments,
              after: {
                ...assignments,
                dev: { ...assignments.dev, dataEnvironmentId: ids.targetRevisionId },
              },
              retiredDataEnvironmentIds: [ids.environmentId],
              reauthorizations: [],
              redeployEnvironments: ["dev"],
              removeDevDeployment: true,
            },
            registrationGenerations: [],
          },
        },
      });
      if (inventoryPorts.dataChange === undefined) throw new Error("Data change port is missing");
      await expect(inventoryPorts.dataChange.removeDevDeployment(dataCommand)).resolves.toEqual({
        status: "ready",
      });
      expect(env.WFP_MANAGEMENT.removeCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: expected }),
        }),
      );
      database.readProductWorkflowContext.mockImplementation(async (_client, scope) =>
        contextFor((scope as ProductCommandMessageV1).eventType),
      );
      for (const invalid of [null, undefined, new Uint8Array(31)]) {
        database.claimPendingWfpCandidateCleanup.mockResolvedValueOnce({
          claimId: parseUlid(ids.targetRevisionId),
          candidateReceiptId: stored.candidateReceiptId,
          candidate: { ...stored, bindingSetDigest: invalid },
          expectedResources: [],
        });
        await expect(restarted.persistence.claimCandidateCleanup(deploy)).rejects.toThrow(
          "Persisted WFP binding digest is invalid",
        );
      }
      for (const invalid of [null, undefined, "sha256:BAD", "sha256:" + "A".repeat(64)]) {
        if (invalid === undefined)
          await expect(
            rpc("prepareExistingCandidate", { ...input, candidate: legacy }, true),
          ).rejects.toThrow();
        else
          await expect(
            rpc("prepareExistingCandidate", {
              ...input,
              candidate: { ...legacy, bindingSetDigest: invalid },
            }),
          ).rejects.toThrow();
        await expect(
          ports.persistence.recordCandidate({
            workflowId: "bad",
            executionId: "bad",
            command: deploy,
            candidate: { ...published, receipt: { ...legacy, bindingSetDigest: invalid } },
            evidence: { archive, build: buildReceipt, artifact: artifactReference },
          }),
        ).rejects.toThrow();
      }
      await expect(
        rpc("prepareExistingCandidate", { ...input, candidate: { ...legacy, foreign: true } }),
      ).rejects.toThrow();
      await expect(
        ports.persistence.recordCandidate({
          workflowId: "bad",
          executionId: "bad",
          command: deploy,
          candidate: { ...published, receipt: { ...legacy, foreign: true } },
          evidence: { archive, build: buildReceipt, artifact: artifactReference },
        }),
      ).rejects.toThrow();
      await expect(rpc("prepareMismatch", input)).rejects.toThrow();
    } finally {
      await mf.dispose();
    }
  });

  it("persists and cleans the complete immutable candidate lifecycle through current v6 ports", async () => {
    const env = bindings();
    const cleanupClaimedAt = "2026-08-20T12:00:00.000Z";
    const ports = createDeploymentWorkflowPorts(env, () => new Date(cleanupClaimedAt));
    const deploy = command("DeploymentRequestedV1");
    const candidate = {
      candidateReceiptId: ids.sourceConnectionId,
      operationId: ids.operationId,
      receipt: wfpReceipt,
      previousGateway: gatewayReceipt,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      deploymentUrl: gatewayReceipt.publicOrigin,
      artifactDigest: digest,
    } as const;
    const activation = {
      candidateReceipt: wfpReceipt,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    } as const;

    await expect(ports.persistence.authorizeActivation(deploy)).resolves.toEqual({
      allowed: true,
    });
    await expect(ports.persistence.authorizeActivation(deploy, candidate)).resolves.toEqual({
      allowed: true,
    });
    database.lockProductCommandOperationTransaction.mockClear();
    await expect(
      ports.persistence.recordCandidate({
        workflowId: "candidate-lifecycle",
        executionId: "candidate-lifecycle",
        command: deploy,
        candidate,
        evidence: { archive, build: buildReceipt, artifact: artifactReference },
      }),
    ).resolves.toEqual({
      persistence: "applied",
      candidateReceiptId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
    expect(database.recordProductDeploymentEvidence).toHaveBeenCalledOnce();
    expect(database.recordProductDeploymentEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: ids.operationId,
        deploymentId: ids.deploymentId,
        buildExecutionId: ids.operationId,
        artifactId: ids.operationId,
        artifact: expect.objectContaining({ artifactDigest: digest }),
      }),
    );
    expect(database.recordProductDeploymentEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      database.recordWfpCandidateReceipt.mock.invocationCallOrder[0] ?? 0,
    );
    expect(database.lockProductCommandOperationTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: ids.organizationId,
        operationId: ids.operationId,
      },
    );
    expect(
      database.lockProductCommandOperationTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(database.recordProductDeploymentEvidence.mock.invocationCallOrder[0] ?? 0);

    database.prepareCandidateCleanup.mockResolvedValueOnce({
      claimId: parseUlid(ids.targetRevisionId),
      candidateReceiptId: parseUlid(ids.sourceConnectionId),
      expectedResources: [],
    });
    const prepared = await ports.persistence.prepareCandidateCleanup({
      command: deploy,
      candidate,
      reason: "superseded",
      supersededById: ids.targetDeploymentId,
    });
    expect(prepared).toMatchObject({ supersededById: ids.targetDeploymentId });

    database.claimPendingWfpCandidateCleanup.mockResolvedValueOnce({
      claimId: parseUlid(ids.targetRevisionId),
      candidateReceiptId: parseUlid(ids.sourceConnectionId),
      candidate: {
        candidateReceiptId: parseUlid(ids.sourceConnectionId),
        organizationId: parseUlid(ids.organizationId),
        projectId: parseUlid(ids.projectId),
        environmentId: parseUlid(ids.environmentId),
        operationId: parseUlid(ids.operationId),
        productDeploymentId: parseUlid(ids.deploymentId),
        artifactId: parseUlid(ids.operationId),
        namespace: wfpReceipt.namespace,
        immutableScriptName: wfpReceipt.scriptName,
        artifactDigest: Buffer.from(hex, "hex"),
        providerTag: wfpReceipt.providerTag,
        buildReused: false,
        stagedAt: deployedAt,
      },
      expectedResources: [],
    });
    await expect(ports.persistence.claimCandidateCleanup(deploy)).resolves.toMatchObject({
      candidateReceiptId: ids.sourceConnectionId,
    });
    expect(database.claimPendingWfpCandidateCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claimedAt: cleanupClaimedAt,
        leaseExpiresAt: "2026-08-20T12:15:00.000Z",
      }),
    );
    await expect(
      ports.persistence.markCandidateSuperseded({
        workflowId: "candidate-lifecycle",
        executionId: "candidate-lifecycle",
        command: deploy,
        candidate,
        claim: prepared,
      }),
    ).resolves.toBe("applied");

    await expect(
      ports.wfp.recordStagedCandidate(deploy, ids.sourceConnectionId, candidate),
    ).resolves.toMatchObject({ status: "recorded" });
    await expect(
      ports.wfp.recordActivatedCandidate(deploy, candidate, activation),
    ).resolves.toEqual({ status: "activated" });
    await expect(ports.wfp.compensate(deploy, prepared, activation)).resolves.toMatchObject({
      status: "compensated",
      outcome: "removed",
    });
    await expect(
      ports.wfp.restoreGateway(command("DeploymentRollbackRequestedV1"), candidate, activation),
    ).resolves.toMatchObject({ status: "restored" });
    await expect(ports.wfp.removeCandidate(deploy, prepared)).resolves.toMatchObject({
      status: "removed",
      outcome: "removed",
    });
    await expect(ports.schedules.remove(command("ProjectDeletionRequestedV1"))).resolves.toEqual({
      removed: 0,
    });
  });

  it("removes exact operation artifacts and hashes fallback cleanup evidence", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const sourceLocator = `${archive.archive.bucket}/${archive.archive.key}/${archive.archive.versionId}`;
    const buildLocator = `r2-version:ohmyho-builds-development/runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz#fedcba9876543210fedcba9876543210`;
    const identity = async (kind: string, locator: string) =>
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`cloudflare\0${kind}\0${locator}`),
        ),
      );
    const claim = {
      claimId: ids.targetRevisionId,
      candidateReceiptId: ids.sourceConnectionId,
      cleanupReceiptId: ids.sourceRevisionId,
      candidate: {
        candidateReceiptId: ids.sourceConnectionId,
        operationId: ids.operationId,
        receipt: wfpReceipt,
        previousGateway: gatewayReceipt,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
        deploymentUrl: gatewayReceipt.publicOrigin,
        artifactDigest: digest,
      },
      supersededById: ids.targetDeploymentId,
      expectedResources: [
        {
          provider: "cloudflare" as const,
          resourceKind: "source-archive" as const,
          resourceIdentityDigest: await identity("source-archive", sourceLocator),
        },
        {
          provider: "cloudflare" as const,
          resourceKind: "build-artifact" as const,
          resourceIdentityDigest: await identity("build-artifact", buildLocator),
        },
      ],
    };
    const removed = await ports.cleanup.removeOperationArtifacts(deploy, claim);
    expect(removed).toMatchObject({ status: "removed", evidence: expect.any(Array) });
    if (removed.status !== "removed") throw new Error("Expected exact operation cleanup");
    expect(removed.evidence).toHaveLength(2);

    await expect(
      ports.persistence.recordCandidateCleanup({
        command: deploy,
        claim,
        cleanup: {
          outcome: "removed",
          candidateAbsence: { observedAt: deployedAt },
          gateway: null,
          operationResources: [
            {
              resourceKind: "source-archive",
              identity: { locator: sourceLocator },
              outcome: "not_found",
            },
          ],
        },
      }),
    ).resolves.toBe("applied");
    expect(database.recordWfpCandidateOperationCleanupReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "cloudflare",
        resourceKind: "source-archive",
        resourceIdentityDigest: expect.any(Uint8Array),
      }),
    );

    env.BUILD_RUNNER.removeArchive.mockResolvedValueOnce({ state: "present" } as never);
    await expect(ports.cleanup.removeOperationArtifacts(deploy, claim)).resolves.toMatchObject({
      status: "uncertain",
      providerHint: { phase: "build" },
    });
  });

  it("removes the artifacts of the claimed candidate's own operation, not the draining one", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    // A pending candidate is drained by the next deployment, so the claim names an older operation
    // than the command. Its artifacts belong to that older operation and to no other.
    const staged = command("DeploymentRequestedV1");
    const draining = { ...staged, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FC0" } as typeof staged;
    const sourceLocator = `${archive.archive.bucket}/${archive.archive.key}/${archive.archive.versionId}`;
    const buildLocator = `r2-version:ohmyho-builds-development/runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz#fedcba9876543210fedcba9876543210`;
    const identity = async (kind: string, locator: string) =>
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`cloudflare\0${kind}\0${locator}`),
        ),
      );
    const claim = {
      claimId: ids.targetRevisionId,
      candidateReceiptId: ids.sourceConnectionId,
      cleanupReceiptId: ids.sourceRevisionId,
      candidate: {
        candidateReceiptId: ids.sourceConnectionId,
        operationId: ids.operationId,
        receipt: wfpReceipt,
        previousGateway: gatewayReceipt,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
        deploymentUrl: gatewayReceipt.publicOrigin,
        artifactDigest: digest,
      },
      supersededById: ids.targetDeploymentId,
      expectedResources: [
        {
          provider: "cloudflare" as const,
          resourceKind: "source-archive" as const,
          resourceIdentityDigest: await identity("source-archive", sourceLocator),
        },
        {
          provider: "cloudflare" as const,
          resourceKind: "build-artifact" as const,
          resourceIdentityDigest: await identity("build-artifact", buildLocator),
        },
      ],
    };
    const removed = await ports.cleanup.removeOperationArtifacts(draining, claim);
    expect(removed).toMatchObject({ status: "removed" });
    if (removed.status !== "removed")
      throw new Error("Expected the claimed operation to be drained");
    expect(removed.evidence).toHaveLength(2);

    await expect(
      ports.persistence.recordCandidateCleanup({
        command: draining,
        claim,
        cleanup: {
          outcome: "removed",
          candidateAbsence: { observedAt: deployedAt },
          gateway: null,
          operationResources: removed.evidence,
        },
      }),
    ).resolves.toBe("applied");
    // The receipt has to name the operation whose resources were staged, or it matches no
    // expectation and the cleanup can never be booked.
    expect(database.recordWfpCandidateOperationCleanupReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operationId: ids.operationId }),
    );
  });

  // Sebmer Prod operation 01M3C6QP35V682DK0J5KGNY6AA (2026-09-25) drained the Dev candidate's cleanup
  // and looked for its archive and build artifact among Prod's, found none and stayed uncertain.
  // They are read in the candidate's own recorded environment, scoped to this project.
  it("reads a drained candidate's artifacts in the candidate's own environment", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const prodEnvironmentId = "01ARZ3NDEKTSV4RRFFQ69G5FD1";
    const staged = command("DeploymentRequestedV1");
    const draining = {
      ...staged,
      environmentId: prodEnvironmentId,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
    } as typeof staged;
    database.readProductWorkflowContext.mockImplementation(async (_client, scope: any) => {
      const context = contextFor(scope.eventType);
      return scope.environmentId === prodEnvironmentId
        ? { ...context, environmentName: "prod", sourceArchives: [], artifactExpectations: [] }
        : context;
    });
    const identity = async (kind: string, locator: string) =>
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`cloudflare\0${kind}\0${locator}`),
        ),
      );
    const claim = {
      claimId: ids.targetRevisionId,
      candidateReceiptId: ids.sourceConnectionId,
      cleanupReceiptId: ids.sourceRevisionId,
      candidate: {
        candidateReceiptId: ids.sourceConnectionId,
        operationId: ids.operationId,
        receipt: wfpReceipt,
        previousGateway: null,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
        deploymentUrl: gatewayReceipt.publicOrigin,
        artifactDigest: digest,
      },
      supersededById: null,
      expectedResources: [
        {
          provider: "cloudflare" as const,
          resourceKind: "source-archive" as const,
          resourceIdentityDigest: await identity(
            "source-archive",
            `${archive.archive.bucket}/${archive.archive.key}/${archive.archive.versionId}`,
          ),
        },
        {
          provider: "cloudflare" as const,
          resourceKind: "build-artifact" as const,
          resourceIdentityDigest: await identity(
            "build-artifact",
            `r2-version:ohmyho-builds-development/runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz#fedcba9876543210fedcba9876543210`,
          ),
        },
      ],
    };

    const removed = await ports.cleanup.removeOperationArtifacts(draining, claim);

    expect(removed).toMatchObject({ status: "removed" });
    expect(database.readCandidateCleanupResources).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
    });
    expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledOnce();
    expect(env.BUILD_RUNNER.removeBuildArtifactObject).toHaveBeenCalledOnce();

    // Sebmer Prod operation 01M3GHSSBVVWZFYBHXNYHKBN0Z (2026-09-27) then failed to book that same
    // cleanup with "WFP receipt is invalid": the receipt was checked against the Prod command. The
    // next attempt (01M3J29NSRYCT9DXF6PKKF8310) was refused because Dev's route still pointed at the
    // candidate; the booking now records the route that the candidate's environment keeps.
    database.settleSharedGatewayCandidateCleanup.mockResolvedValueOnce({
      compensatedTargetScriptName: "p-restored-script",
      sharedGatewayRevision: 3,
    });
    await expect(
      ports.persistence.recordCandidateCleanup({
        command: draining,
        claim,
        cleanup: {
          outcome: "not_found",
          candidateAbsence: { observedAt: deployedAt },
          gateway: null,
          operationResources: removed.status === "removed" ? removed.evidence : [],
        },
      }),
    ).resolves.toBe("applied");
    expect(database.settleSharedGatewayCandidateCleanup).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      candidateReceiptId: claim.candidateReceiptId,
      claimId: claim.claimId,
    });
    expect(database.recordWfpCandidateCleanupReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        observedProviderTag: wfpReceipt.providerTag,
        compensatedTargetScriptName: "p-restored-script",
        sharedGatewayRevision: 3,
      }),
    );
  });

  // Since 3d120a2f runtime secret delivery requires the claim that authorizes each provider
  // mutation, and the compensation paths sent none (Sebmer Dev, 2026-09-25: "Runtime secret
  // delivery input is invalid" on every retry). A route change acts under the operation's
  // provider-mutation claim, the one activation used; removing a candidate under its cleanup claim.
  it("compensates and removes candidates under the exact claims that authorize them", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const candidate = {
      candidateReceiptId: ids.sourceConnectionId,
      operationId: ids.operationId,
      receipt: wfpReceipt,
      previousGateway: gatewayReceipt,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      deploymentUrl: gatewayReceipt.publicOrigin,
      artifactDigest: digest,
    };
    const claim = {
      claimId: ids.targetRevisionId,
      candidateReceiptId: ids.sourceConnectionId,
      cleanupReceiptId: ids.sourceRevisionId,
      candidate,
      supersededById: null,
      expectedResources: [],
    };
    const activation = {
      candidateReceipt: wfpReceipt,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    };
    await ports.wfp.activate(deploy, candidate);
    const activationClaimId = (
      env.WFP_MANAGEMENT.activateCandidate.mock.calls[0] as unknown as [{ claimId: string }]
    )[0].claimId;

    await expect(ports.wfp.compensate(deploy, claim, activation)).resolves.toMatchObject({
      status: "compensated",
    });
    expect(env.RUNTIME_SECRET_DELIVERY.compensateActivation).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: activationClaimId, cleanupClaimId: claim.claimId }),
    );
    expect(activationClaimId).not.toBe(claim.claimId);

    await ports.wfp.removeCandidate(deploy, claim);
    expect(env.RUNTIME_SECRET_DELIVERY.removeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: claim.claimId }),
    );

    const rollback = command("DeploymentRollbackRequestedV1");
    await ports.wfp.activate(rollback, candidate);
    const rollbackClaimId = (
      env.WFP_MANAGEMENT.activateCandidate.mock.calls[1] as unknown as [{ claimId: string }]
    )[0].claimId;
    await ports.wfp.restoreGateway(rollback, candidate, activation);
    expect(env.RUNTIME_SECRET_DELIVERY.compensateGatewayActivation).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: rollbackClaimId }),
    );
  });

  it("stores the health verdict before compensation and keeps it with the terminal failure", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const workflowId = deterministicProductCommandWorkflowId(deploy);
    const health = { status: 500, path: "/", excerpt: "boom", truncated: false };

    await expect(
      ports.persistence.recordHealthFailure({
        workflowId,
        executionId: workflowId,
        command: deploy,
        health,
      }),
    ).resolves.toBe("applied");
    expect(database.recordRuntimeHealthDiagnostic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workflowId,
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        outboxEventId: deploy.eventId,
        health,
      }),
    );

    await expect(
      ports.persistence.fail({
        workflowId,
        executionId: workflowId,
        command: deploy,
        errorCode: "RUNTIME_CANDIDATE_FAILED",
        health,
      }),
    ).resolves.toBe("applied");
    expect(database.failProductDeploymentCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "RUNTIME_CANDIDATE_FAILED", health }),
    );
  });

  it.each(["DeploymentRequestedV1", "DeploymentPromotionRequestedV1"] as const)(
    "activates one exact prepared %s retry before the physical Workflow executes",
    async (eventType) => {
      const productCommand = command(eventType);
      await expect(
        activateDeploymentReconciliationAttempt(recordedAttempts(), {
          attemptId: ids.targetRevisionId,
          physicalWorkflowId: `product-provider-reconcile-v1-${ids.targetRevisionId}`,
          command: productCommand,
        }),
      ).resolves.toBe("activated");
      expect(database.activateProductProviderReconciliationAttempt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          attemptId: ids.targetRevisionId,
          eventType,
          operationId: ids.operationId,
        }),
      );
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    database.readManagedSourceDeletionInventory.mockResolvedValue({
      repos: [],
      blobOperations: [],
    });
    database.completeProductCommand.mockResolvedValue("completed");
    database.readRollbackPlanTarget.mockResolvedValue({
      dataChanged: false,
      dataChangeInProgress: false,
    });
    database.resolveRollbackCandidate.mockResolvedValue({
      targetDeploymentId: ids.targetDeploymentId,
      targetRevisionId: ids.targetRevisionId,
      wfpReceiptId: ids.operationId,
      deploymentUrl: gatewayReceipt.publicOrigin,
      sharedGatewayRevision: gatewayReceipt.revision,
      gatewayScriptName: sharedGatewayWorkerName,
      gatewayTargetScriptName: gatewayReceipt.targetScriptName,
      candidate: {
        candidateReceiptId: ids.sourceConnectionId,
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        productDeploymentId: ids.targetDeploymentId,
        artifactId: ids.operationId,
        namespace: wfpReceipt.namespace,
        immutableScriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
        artifactDigest: Buffer.from(hex, "hex"),
        providerTag: wfpReceipt.providerTag,
        buildReused: false,
        stagedAt: deployedAt,
      },
    });
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) =>
      contextFor((scope as ProductCommandMessageV1).eventType),
    );
    database.readProjectDataEnvironment.mockImplementation(async (_client, scope) => {
      const current = await database.readProductWorkflowContext(_client, scope);
      return current.dataMode === "shared" ? ids.environmentId : scope.environmentId;
    });
    database.readCandidateCleanupResources.mockImplementation(async (_client, scope) => {
      const context = contextFor("DeploymentRequestedV1");
      return scope.organizationId === ids.organizationId &&
        scope.projectId === ids.projectId &&
        scope.environmentId === ids.environmentId
        ? {
            sourceArchives: context.sourceArchives,
            artifactExpectations: context.artifactExpectations,
          }
        : { sourceArchives: [], artifactExpectations: [] };
    });
  });

  it("accepts functions build evidence without relaxing runtime or credential validation", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const evidence = artifact.provenance.lifecycleEvidence;
    const withRuntime = (runtime: string, findingsCount = 0) => ({
      ...artifact,
      provenance: {
        ...artifact.provenance,
        lifecycleEvidence: {
          ...evidence,
          frameworkBuild: { ...evidence.frameworkBuild, framework: "functions", runtime },
          credentialScan: { ...evidence.credentialScan, findingsCount },
        },
      },
    });
    for (const runtime of ["static", "edge", "functions"]) {
      env.BUILD_RUNNER.readBuildArtifact.mockResolvedValueOnce(withRuntime(runtime) as never);
      const observed = await ports.build.observe(command("DeploymentRequestedV1"), buildReceipt);
      expect(observed).toMatchObject({ status: "observed", artifactDigest: digest });
      if (observed.status !== "observed") throw new Error("Expected observed build");
      await expect(
        ports.database.ensure(command("DeploymentRequestedV1"), observed.artifact),
      ).resolves.toMatchObject({ status: "ready" });
    }
    for (const invalid of [withRuntime("unknown"), withRuntime("functions", 1)]) {
      env.BUILD_RUNNER.readBuildArtifact.mockResolvedValueOnce(invalid as never);
      await expect(
        ports.build.observe(command("DeploymentRequestedV1"), buildReceipt),
      ).rejects.toThrow("Build lifecycle evidence is invalid");
    }
  });

  it("places an EU project's source archive, build reads and database in the EU", async () => {
    const env = bindings();
    const euArchive = {
      ...archive,
      archiveId:
        "r2-version:ohmyho-builds-development-eu/source.zip#0123456789abcdef0123456789abcdef",
      archive: { ...archive.archive, bucket: "ohmyho-builds-development-eu" },
    };
    env.SOURCE_FETCHER.acquireExact.mockResolvedValue(euArchive as never);
    env.BUILD_RUNNER.readBuildArtifact.mockResolvedValue({
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: true as const, migrations: "supabase/migrations" },
      },
      migrations: [
        {
          path: "20260821090000_foundation.sql",
          digest,
          size: migrationBody.byteLength,
          body: migrationBody,
        },
      ],
    } as never);
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      region: "eu" as const,
      dataMode: "isolated" as const,
      sourceArchives: [euArchive.archive],
    }));
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");

    const fetched = await ports.source.fetchExactArchive(deploy);
    expect(env.SOURCE_FETCHER.acquireExact).toHaveBeenCalledWith(
      expect.objectContaining({ region: "eu" }),
    );
    if (fetched.status !== "observed") throw new Error("Expected observed archive");
    const started = await ports.build.start(deploy, fetched.archive);
    expect(env.BUILD_RUNNER.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        archive: expect.objectContaining({ bucket: "ohmyho-builds-development-eu" }),
      }),
    );
    if (started.status !== "started") throw new Error("Expected started build");
    const observed = await ports.build.observe(deploy, started.receipt);
    expect(observed).toMatchObject({ status: "observed" });
    expect(env.BUILD_RUNNER.readBuild).toHaveBeenCalledWith({
      receipt: buildReceipt,
      bucket: "ohmyho-builds-development-eu",
    });
    expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledWith({
      bucket: "ohmyho-builds-development-eu",
      expectation: expect.objectContaining({ receipt: buildReceipt }),
    });
    if (observed.status !== "observed") throw new Error("Expected observed build");
    env.NEON_MANAGEMENT.placeProject.mockResolvedValueOnce({
      status: "reconciliation_required",
      reason: "provider_provisioning",
    } as never);
    await expect(ports.database.ensure(deploy, observed.artifact)).resolves.toEqual({
      status: "provisioning_pending",
    });
    expect(env.NEON_MANAGEMENT.migrateProject).not.toHaveBeenCalled();
    env.NEON_MANAGEMENT.placeProject.mockResolvedValueOnce({
      status: "reconciliation_required",
      reason: "other",
    } as never);
    await expect(ports.database.ensure(deploy, observed.artifact)).resolves.toEqual({
      status: "uncertain",
    });
    await expect(ports.database.ensure(deploy, observed.artifact)).resolves.toMatchObject({
      status: "ready",
    });
    expect(env.NEON_MANAGEMENT.placeProject).toHaveBeenCalledTimes(3);
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      region: "eu" as const,
      environmentName: "prod" as const,
      dataMode: "shared" as const,
      sourceArchives: [euArchive.archive],
    }));
    await expect(ports.database.ensure(deploy, observed.artifact)).resolves.toMatchObject({
      status: "ready",
    });
    expect(env.NEON_MANAGEMENT.placeProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: deploy.projectId,
        environmentId: deploy.environmentId,
        operationId: deploy.operationId,
      }),
    );
    expect(env.NEON_MANAGEMENT.migrateProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: deploy.projectId,
        environmentId: deploy.environmentId,
        operationId: deploy.operationId,
        migrations: expect.any(Array),
      }),
    );

    // A build whose archive was never recorded cannot be observed in any bucket.
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      sourceArchives: [],
    }));
    await expect(ports.build.observe(deploy, started.receipt)).rejects.toThrow(
      "Deployment Workflow has no source archive",
    );
  });

  it("runs the credential-free deploy provider chain and persists exact evidence", async () => {
    const env = bindings();
    // This chain covers an app that declares Mail next to Better Auth.
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: { ...frameworkPlan, mail: { enabled: true } },
    }));
    const databaseArtifact = {
      ...artifact,
      migrations: [
        {
          path: "20260821090000_foundation.sql",
          digest,
          size: migrationBody.byteLength,
          body: migrationBody,
        },
      ],
      provenance: {
        ...artifact.provenance,
        database: { enabled: true as const, migrations: "supabase/migrations" },
        auth: {
          provider: "better-auth" as const,
          version: "1.7.7",
          deployment: "embedded" as const,
          routePath: "/api/auth",
          databaseSchema: "auth",
          databaseBindingName: "OHMYHOST_DATABASE",
          authSecretName: "BETTER_AUTH_SECRET",
        },
      },
    };
    env.BUILD_RUNNER.readBuildArtifact
      .mockResolvedValueOnce(artifact)
      .mockResolvedValueOnce(databaseArtifact as never);
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");

    const fetched = await ports.source.fetchExactArchive(deploy);
    expect(fetched).toEqual({ status: "observed", archive });
    expect(env.SOURCE_FETCHER.acquireExact).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ids.organizationId,
        billingEpochId: ids.billingEpochId,
        projectId: ids.projectId,
        sourceConnectionId: ids.sourceConnectionId,
        region: "us",
        grant: {
          status: "approved",
          grantId: ids.sourceConnectionId,
          organizationId: ids.organizationId,
          billingEpochId: ids.billingEpochId,
          projectId: ids.projectId,
          sourceConnectionId: ids.sourceConnectionId,
          installationId: 123,
          repositoryId: 456,
          owner: "sebmer-com",
          repository: "fixture",
          permission: "contents:read",
          grantedAt: deployedAt,
          revokedAt: null,
        },
      }),
    );
    expect(database.claimProductProviderMutation.mock.invocationCallOrder[0]).toBeLessThan(
      env.SOURCE_FETCHER.acquireExact.mock.invocationCallOrder[0] ?? 0,
    );
    expect(database.recordProductSourceArchiveEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        archive: expect.objectContaining({
          bucket: archive.archive.bucket,
          key: archive.archive.key,
          versionId: archive.archive.versionId,
        }),
      }),
    );
    if (fetched.status !== "observed") throw new Error("Expected observed archive");
    const started = await ports.build.start(deploy, fetched.archive);
    expect(started).toEqual({ status: "started", receipt: buildReceipt });
    expect(database.recordProductSourceArchiveEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      env.BUILD_RUNNER.startBuild.mock.invocationCallOrder[0] ?? 0,
    );
    if (started.status !== "started") throw new Error("Expected started build");
    const observed = await ports.build.observe(deploy, started.receipt);
    expect(observed).toMatchObject({ status: "observed", artifactDigest: digest });
    if (observed.status !== "observed") throw new Error("Expected observed build");
    expect(observed.artifact).toMatchObject({
      schemaVersion: "ohmyhost.verified-artifact-reference/v1",
      manifestDigest: digest,
      sbomDigest: digest,
    });
    expect(observed.artifact).not.toHaveProperty("files");
    expect(observed.artifact).not.toHaveProperty("modules");
    expect(JSON.stringify(observed).length).toBeLessThan(1_000_000);
    const databaseReady = await ports.database.ensure(deploy, {
      ...(observed.artifact as Readonly<Record<string, unknown>>),
      provenance: {
        ...databaseArtifact.provenance,
      },
    });
    expect(databaseReady).toMatchObject({ status: "ready" });
    env.NEON_MANAGEMENT.placeNativeAuthDatabase.mockResolvedValue({ status: "ready" });
    env.NEON_MANAGEMENT.prepareNativeAuthRealm.mockResolvedValue({
      status: "ready",
      registration: {
        status: "active",
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
      },
      policy: { canonicalOrigin: "https://app.example.test" },
    });
    await expect(
      ports.database.ensure(deploy, {
        ...databaseArtifact,
        provenance: {
          ...databaseArtifact.provenance,
          auth: { ...databaseArtifact.provenance.auth, databaseBindingName: "HYPERDRIVE" },
        },
      } as never),
    ).rejects.toThrow("Verified artifact bundle is invalid");
    await expect(
      ports.database.ensure(deploy, {
        ...artifact,
        provenance: {
          ...artifact.provenance,
          auth: {
            provider: "omh-native",
            routePath: "/api/auth/v1",
            bindingName: "OHMYHOST_AUTH",
          },
        },
      } as never),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: { nativeAuthRegistration: { status: "active" } },
    });
    expect(env.NEON_MANAGEMENT.placeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      }),
    );
    expect(env.NEON_MANAGEMENT.migrateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        auth: expect.objectContaining({ provider: "better-auth", version: "1.7.7" }),
        migrations: expect.arrayContaining([
          expect.objectContaining({ path: "20260821090000_foundation.sql" }),
        ]),
      }),
    );
    expect(env.RUNTIME_SECRET_DELIVERY.ensureCustomerAuthSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      }),
    );
    expect(env.SES_MANAGEMENT.ensureTenant).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureMailDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
        acceptedLifecycleVersion: 3,
        domain: "mail.example.com",
      }),
    );
    expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      }),
    );
    const published = await (ports.wfp.stage as any)(deploy, observed.artifact);
    expect(published).toMatchObject({ status: "staged", receipt: wfpReceipt });
    if (published.status !== "staged") throw new Error("Expected staged deployment");
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          environmentName: "dev",
          handle: "calm-otter-builds",
          operationId: ids.operationId,
        },
      }),
    );
    expect(env.NEON_MANAGEMENT.readRuntimeBinding).not.toHaveBeenCalled();
    expect(database.claimProductProviderMutation).toHaveBeenCalledWith(expect.anything(), {
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      eventType: "DeploymentRequestedV1",
      eventId: ids.eventId,
      logicalWorkflowId: `product-command-v1-deploy-${ids.eventId}-${ids.operationId}`,
      acceptedLifecycleVersion: 3,
    });
    expect(database.claimProductProviderMutation.mock.invocationCallOrder[0]).toBeLessThan(
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(env.SES_MANAGEMENT.ensureMailDomain.mock.invocationCallOrder[0]).toBeLessThan(
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey.mock.invocationCallOrder[0],
    ).toBeLessThan(env.RUNTIME_SECRET_DELIVERY.stageCandidate.mock.invocationCallOrder[0] ?? 0);
    await expect((ports.wfp.observeActivation as any)(deploy, published)).resolves.toMatchObject({
      status: "activated",
    });
    expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          environmentName: "dev",
          handle: "calm-otter-builds",
        }),
      }),
    );
    // The Workflow activates only after persisting the candidate and adding its receipt ID.
    const persistedCandidate = { ...published, candidateReceiptId: ids.eventId };
    const activated = await ports.wfp.activate(deploy, persistedCandidate);
    if (activated.status !== "activated") throw new Error("Expected activated candidate");
    // WfpManagementService.activateCandidate accepts exactly these keys (Dev deploy 2026-09-23
    // was refused because operation, claim and candidate receipt were missing).
    const activation = (
      env.WFP_MANAGEMENT.activateCandidate.mock.calls.at(-1) as unknown[]
    )[0] as Record<string, unknown>;
    expect(Object.keys(activation).sort()).toEqual(
      [
        "candidate",
        "candidateReceiptId",
        "claimId",
        "operationId",
        "organizationId",
        ...(published.previousGateway === null ? [] : ["previousGateway"]),
        "runtimePolicy",
        "scope",
      ].sort(),
    );
    expect(activation).toMatchObject({
      operationId: ids.operationId,
      candidateReceiptId: ids.eventId,
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
    database.lockProductCommandOperationTransaction.mockClear();
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "product-workflow-deploy",
        executionId: "product-workflow-deploy",
        command: deploy,
        evidence: {
          archive,
          build: buildReceipt,
          artifact: artifactReference,
          artifactDigest: digest,
          wfp: published.receipt,
          gateway: activated.gateway,
          deploymentUrl: activated.deploymentUrl,
          runtimePolicy: frameworkPlan.runtimePolicy,
        },
      }),
    ).resolves.toBe("applied");

    expect(env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      deploymentId: ids.deploymentId,
      environmentName: "dev",
      gatewayScriptName: sharedGatewayWorkerName,
      healthCheckPath: "/",
    });
    expect(
      env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment.mock.invocationCallOrder[0],
    ).toBeLessThan(database.finalizeWfpCandidateDeployment.mock.invocationCallOrder[0] ?? 0);
    expect(database.lockProductCommandOperationTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: ids.organizationId,
        operationId: ids.operationId,
      },
    );
    expect(
      database.lockProductCommandOperationTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(database.finalizeWfpCandidateDeployment.mock.invocationCallOrder[0] ?? 0);

    expect(env.BUILD_RUNNER.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        archive: archive.archive,
        deploymentId: ids.deploymentId,
        frameworkPlan: expect.objectContaining({
          adapter: "tanstack-start",
          runtime: "edge",
          outputDirectory: "dist/client",
        }),
      }),
    );
    expect(env.BUILD_RUNNER.readBuild).toHaveBeenCalledWith({
      receipt: buildReceipt,
      bucket: "ohmyho-builds-development",
    });
    expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledWith({
      bucket: "ohmyho-builds-development",
      expectation: expect.objectContaining({
        receipt: buildReceipt,
        frameworkPlan: expect.objectContaining({
          schemaVersion: "ohmyhost.framework-plan/v5",
          applicationRoot: "site",
        }),
      }),
    });
    expect(database.recordProductDeploymentEvidence).not.toHaveBeenCalled();
    expect(database.finalizeWfpCandidateDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        productDeploymentId: ids.deploymentId,
        deploymentUrl: gatewayReceipt.publicOrigin,
      }),
    );
    expect(database.completeProductCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "DeploymentRequestedV1",
        finalizedWfpResult: expect.objectContaining({
          schemaVersion: "ohmyhost.operation-deployment-result/v2",
          operationId: ids.operationId,
          deploymentId: ids.deploymentId,
          planId: ids.planId,
          artifactSha256: hex,
        }),
      }),
    );
  });

  it("fails closed before WFP finalization for missing or mixed durable lifecycle facts", async () => {
    const ports = createDeploymentWorkflowPorts(bindings());
    const deploy = command("DeploymentRequestedV1");
    const evidence = {
      artifact,
      artifactDigest: digest,
      wfp: wfpReceipt,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
      runtimePolicy: frameworkPlan.runtimePolicy,
    };
    const missing = {
      ...artifact,
      provenance: { ...artifact.provenance, lifecycleEvidence: undefined },
    };
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "deploy-missing-lifecycle",
        executionId: "deploy-missing-lifecycle",
        command: deploy,
        evidence: { ...evidence, artifact: missing },
      }),
    ).rejects.toThrow(/build lifecycle evidence/u);
    const mixed = {
      ...artifact,
      provenance: { ...artifact.provenance, sourceDigest: `sha256:${"9".repeat(64)}` },
    };
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "deploy-mixed-lifecycle",
        executionId: "deploy-mixed-lifecycle",
        command: deploy,
        evidence: { ...evidence, artifact: mixed },
      }),
    ).rejects.toThrow(/Verified artifact bundle|lifecycle provenance changed/u);
    expect(database.finalizeWfpCandidateDeployment).not.toHaveBeenCalled();
  });

  it("returns the exact durable conflict reason without classifying it as superseded", async () => {
    const ports = createDeploymentWorkflowPorts(bindings());
    database.finalizeWfpCandidateDeployment.mockRejectedValueOnce(
      new database.DeploymentPersistenceConflictError("Environment deployment head changed"),
    );

    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "deploy-finalization-conflict",
        executionId: "deploy-finalization-conflict",
        command: command("DeploymentRequestedV1"),
        evidence: {
          artifact,
          artifactDigest: digest,
          wfp: wfpReceipt,
          gateway: gatewayReceipt,
          deploymentUrl: gatewayReceipt.publicOrigin,
          runtimePolicy: frameworkPlan.runtimePolicy,
        },
      }),
    ).resolves.toEqual({
      status: "conflict",
      reason: "Environment deployment head changed",
    });
  });

  it("retries a pending project domain before final WFP persistence", async () => {
    const env = bindings();
    env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment.mockImplementationOnce((async (
      input: Record<string, unknown>,
    ) => ({
      status: "pending",
      environmentName: "dev",
      hostname: new URL(gatewayReceipt.publicOrigin).hostname,
      dnsRecordId: "a".repeat(32),
      routeId: "b".repeat(32),
      publicUrl: gatewayReceipt.publicOrigin,
      observedAt: deployedAt,
      probe: {
        url: domainProbeUrl(input, gatewayReceipt.publicOrigin),
        status: 503,
        observedAt: "2026-08-19T12:00:01.000Z",
      },
    })) as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "deploy-domain-pending",
        executionId: "deploy-domain-pending",
        command: command("DeploymentRequestedV1"),
        evidence: {
          artifact,
          artifactDigest: digest,
          wfp: wfpReceipt,
          gateway: gatewayReceipt,
          deploymentUrl: gatewayReceipt.publicOrigin,
          runtimePolicy: frameworkPlan.runtimePolicy,
        },
      }),
    ).rejects.toThrow("Cloudflare project domain is pending");
    expect(database.finalizeWfpCandidateDeployment).not.toHaveBeenCalled();
  });

  it("rejects project-domain readiness without an exact public 200 probe", async () => {
    const env = bindings();
    env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment.mockResolvedValueOnce({
      status: "ready",
      environmentName: "dev",
      hostname: new URL(gatewayReceipt.publicOrigin).hostname,
      dnsRecordId: "a".repeat(32),
      routeId: "b".repeat(32),
      publicUrl: gatewayReceipt.publicOrigin,
      observedAt: deployedAt,
      probe: null,
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "deploy-domain-unproved",
        executionId: "deploy-domain-unproved",
        command: command("DeploymentRequestedV1"),
        evidence: {
          artifact,
          artifactDigest: digest,
          wfp: wfpReceipt,
          gateway: gatewayReceipt,
          deploymentUrl: gatewayReceipt.publicOrigin,
          runtimePolicy: frameworkPlan.runtimePolicy,
        },
      }),
    ).rejects.toThrow("Cloudflare project domain result is invalid");
    expect(database.finalizeWfpCandidateDeployment).not.toHaveBeenCalled();
  });

  it("canonicalizes root deployment origins and rejects non-origin HTTPS URLs", async () => {
    const finalize = async (deploymentUrl: string) => {
      const ports = createDeploymentWorkflowPorts(bindings());
      return ports.persistence.finalizeCandidate({
        workflowId: "deploy-origin",
        executionId: "deploy-origin",
        command: command("DeploymentRequestedV1"),
        evidence: {
          artifact,
          artifactDigest: digest,
          wfp: wfpReceipt,
          gateway: gatewayReceipt,
          deploymentUrl,
          runtimePolicy: frameworkPlan.runtimePolicy,
        },
      });
    };

    await expect(finalize(`${gatewayReceipt.publicOrigin}/`)).resolves.toBe("applied");
    expect(database.finalizeWfpCandidateDeployment).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ deploymentUrl: gatewayReceipt.publicOrigin }),
    );
    for (const value of [
      gatewayReceipt.publicOrigin.replace("https://", "http://"),
      `https://user@${new URL(gatewayReceipt.publicOrigin).host}`,
      `${gatewayReceipt.publicOrigin}/health`,
      `${gatewayReceipt.publicOrigin}?probe=1`,
      `${gatewayReceipt.publicOrigin}#probe`,
      `${gatewayReceipt.publicOrigin.replace(".dev.check.omh.st", ".dev.check.omh.st:443")}`,
    ]) {
      await expect(finalize(value)).rejects.toThrow("Deployment URL is invalid");
    }
  });

  it("propagates the persisted production environment identity without a dev fallback", async () => {
    database.readProductWorkflowContext.mockResolvedValueOnce({
      ...contextFor("DeploymentRequestedV1"),
      handle: "calm-otter-builds",
      environmentName: "prod",
    });
    const env = bindings();
    env.WFP_MANAGEMENT.observeActivation.mockResolvedValueOnce({
      status: "activated",
      candidate: wfpReceipt,
      gateway: {
        ...gatewayReceipt,
        targetScriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
        environmentName: "prod",
        hostname: "calm-otter-builds.ohmyho.st",
        publicOrigin: "https://calm-otter-builds.ohmyho.st",
      },
      deploymentUrl: "https://calm-otter-builds.ohmyho.st",
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      (ports.wfp.observeActivation as any)(command("DeploymentRequestedV1"), {
        receipt: wfpReceipt,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      }),
    ).resolves.toMatchObject({ status: "activated" });
    expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          environmentName: "prod",
          handle: "calm-otter-builds",
        }),
      }),
    );
  });

  it("rejects a malformed migration bundle before a provider claim and leaves SQL policy to the ledger-aware executor", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const providerClaimsBefore = database.claimProductProviderMutation.mock.calls.length;
    const sql = new TextEncoder().encode("select auth.uid();");
    const bundle = (path: string) => ({
      ...artifact,
      migrations: [{ path, digest, size: sql.byteLength, body: sql }],
      provenance: {
        ...artifact.provenance,
        database: { enabled: true, migrations: "supabase/migrations" },
      },
    });

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), bundle("supabase.sql")),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "DATABASE_MIGRATION_FAILED",
      migration: { reason: "not_admitted", path: "supabase.sql" },
    });
    expect(database.claimProductProviderMutation.mock.calls).toHaveLength(providerClaimsBefore);
    expect(env.NEON_MANAGEMENT.placeProject).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureTenant).not.toHaveBeenCalled();
    // This Worker cannot read the ledger, so well-formed SQL that today's policy refuses is decided by the
    // executor, which may find it already applied.
    await ports.database.ensure(
      command("DeploymentRequestedV1"),
      bundle("20260821090000_supabase.sql"),
    );
    expect(env.NEON_MANAGEMENT.migrateProject).toHaveBeenCalledTimes(1);
    const deploy = command("DeploymentRequestedV1");
    const workflowId = deterministicProductCommandWorkflowId(deploy);
    await expect(
      ports.persistence.fail({
        workflowId,
        executionId: workflowId,
        command: deploy,
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: { reason: "not_admitted", path: "20260821090000_supabase.sql" },
      }),
    ).resolves.toBe("applied");
    expect(database.failProductDeploymentCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: { reason: "not_admitted", path: "20260821090000_supabase.sql" },
      }),
    );
    for (const reason of [
      "catalog_changed",
      "ledger_conflict",
      "execution_failed",
      "not_admitted",
    ] as const) {
      env.NEON_MANAGEMENT.migrateProject.mockResolvedValueOnce({
        status: "failed",
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: { reason, path: "20260821090000_foundation.sql" },
      } as never);
      await expect(
        ports.database.ensure(deploy, {
          ...artifact,
          migrations: [
            {
              path: "20260821090000_foundation.sql",
              digest,
              size: migrationBody.byteLength,
              body: migrationBody,
            },
          ],
          provenance: {
            ...artifact.provenance,
            database: { enabled: true, migrations: "postgres/migrations" },
          },
        }),
      ).resolves.toMatchObject({
        status: "failed",
        migration: { reason, path: "20260821090000_foundation.sql" },
      });
    }
    const diagnostic = {
      reason: "execution_failed",
      path: "20260821090000_foundation.sql",
      statementIndex: 2,
      sqlstate: "42P01",
    } as const;
    const withMigration = {
      ...artifact,
      migrations: [
        {
          path: "20260821090000_foundation.sql",
          digest,
          size: migrationBody.byteLength,
          body: migrationBody,
        },
      ],
      provenance: {
        ...artifact.provenance,
        database: { enabled: true as const, migrations: "postgres/migrations" },
      },
    };
    env.NEON_MANAGEMENT.migrateProject.mockResolvedValueOnce({
      status: "failed",
      errorCode: "DATABASE_MIGRATION_FAILED",
      migration: diagnostic,
    } as never);
    await expect(ports.database.ensure(deploy, withMigration)).resolves.toMatchObject({
      status: "failed",
      migration: diagnostic,
    });
    await ports.persistence.fail({
      workflowId,
      executionId: workflowId,
      command: deploy,
      errorCode: "DATABASE_MIGRATION_FAILED",
      migration: diagnostic,
    });
    expect(database.failProductDeploymentCommand).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ migration: diagnostic }),
    );
    for (const invalid of [
      { ...diagnostic, statementIndex: 0 },
      { ...diagnostic, statementIndex: 1.5 },
      { ...diagnostic, sqlstate: "42P01 secret SQL" },
      { ...diagnostic, sqlstate: "08007" },
      { ...diagnostic, sqlstate: "57P01" },
      { ...diagnostic, reason: "catalog_changed" },
      { ...diagnostic, path: null },
      { reason: "execution_failed", path: diagnostic.path, sqlstate: "42P01" },
      { reason: "execution_failed", path: diagnostic.path, statementIndex: 2 },
    ]) {
      env.NEON_MANAGEMENT.migrateProject.mockResolvedValueOnce({
        status: "failed",
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: invalid,
      } as never);
      await expect(ports.database.ensure(deploy, withMigration)).rejects.toThrow(
        "Neon migration failure is invalid",
      );
    }
    env.NEON_MANAGEMENT.migrateProject.mockResolvedValueOnce({
      status: "failed",
      errorCode: "DATABASE_MIGRATION_FAILED",
      migration: { reason: "execution_failed", path: "../secrets.sql" },
    } as never);
    await expect(
      ports.database.ensure(deploy, {
        ...artifact,
        migrations: [
          {
            path: "20260821090000_foundation.sql",
            digest,
            size: migrationBody.byteLength,
            body: migrationBody,
          },
        ],
        provenance: {
          ...artifact.provenance,
          database: { enabled: true, migrations: "postgres/migrations" },
        },
      }),
    ).rejects.toThrow("Neon migration failure is invalid");
  });

  it("fails a deployment terminally when the runtime rejects the candidate script", async () => {
    const env = bindings();
    env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockResolvedValueOnce({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      (ports.wfp.stage as any)(command("DeploymentRequestedV1"), artifact),
    ).resolves.toEqual({ status: "failed", errorCode: "RUNTIME_CANDIDATE_REJECTED" });
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).toHaveBeenCalledOnce();
  });

  it("fails a deployment terminally when the stored storage target conflicts with the plan", async () => {
    const storage = {
      enabled: true as const,
      provider: "r2" as const,
      jurisdiction: "us" as const,
      public: false as const,
    };
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: { ...frameworkPlan, storage },
    }));
    const env = bindings();
    env.R2_MANAGEMENT.ensureBucket.mockResolvedValueOnce({
      status: "conflict",
      reason: "target_changed",
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), {
        ...artifact,
        provenance: { ...artifact.provenance, storage },
      }),
    ).resolves.toEqual({ status: "failed", errorCode: "STORAGE_JURISDICTION_CONFLICT" });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureStorageGatewayKey).not.toHaveBeenCalled();
    expect(env.NEON_MANAGEMENT.placeProject).not.toHaveBeenCalled();
  });

  it.each(["failed", "stopped"] as const)(
    "maps a definitive build sandbox %s observation to a terminal build failure",
    async (status) => {
      const env = bindings();
      const failure = { excerpt: "npm ERR! missing script: build", truncated: true };
      env.BUILD_RUNNER.readBuild
        .mockResolvedValueOnce({ status, failure } as never)
        .mockResolvedValueOnce({ status, failure: null } as never)
        .mockResolvedValueOnce({ status })
        .mockResolvedValueOnce({
          status,
          failure: { excerpt: "\u001b[31mred", truncated: false },
        } as never)
        .mockResolvedValueOnce({
          status,
          failure: { ...failure, credential: "must-not-leak" },
        } as never);
      const ports = createDeploymentWorkflowPorts(env);
      const receipt = {
        buildId: "ohmyho-sandbox-build:5e54d675-02d5-44c9-b2af-4d3e4f0eacec",
        projectName: "ohmyho-sandbox-build",
        scope: {
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          operationId: ids.operationId,
        },
      };

      await expect(ports.build.observe(command("DeploymentRequestedV1"), receipt)).resolves.toEqual(
        { status: "failed", errorCode: "BUILD_FAILED", failure },
      );
      for (const absent of [1, 2]) {
        expect(absent).toBeGreaterThan(0);
        await expect(
          ports.build.observe(command("DeploymentRequestedV1"), receipt),
        ).resolves.toEqual({ status: "failed", errorCode: "BUILD_FAILED", failure: null });
      }
      for (const hostile of [1, 2]) {
        expect(hostile).toBeGreaterThan(0);
        await expect(
          ports.build.observe(command("DeploymentRequestedV1"), receipt),
        ).rejects.toThrow("build failure excerpt is invalid");
      }
    },
  );

  it("persists the build excerpt with a terminal BUILD_FAILED deployment", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const workflowId = deterministicProductCommandWorkflowId(deploy);
    const failure = { excerpt: "npm ERR! missing script: build", truncated: false };

    await expect(
      ports.persistence.fail({
        workflowId,
        executionId: workflowId,
        command: deploy,
        errorCode: "BUILD_FAILED",
        failure,
      }),
    ).resolves.toBe("applied");
    expect(database.failProductDeploymentCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "BUILD_FAILED", failure }),
    );
  });

  it("maps exact provider build-start absence to a terminal build failure", async () => {
    const env = bindings();
    env.BUILD_RUNNER.startBuild.mockResolvedValueOnce({
      status: "failed",
      errorCode: "BUILD_NOT_STARTED",
    } as never);
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const fetched = await ports.source.fetchExactArchive(deploy);
    if (fetched.status !== "observed") throw new Error("Expected source archive");

    await expect(ports.build.start(deploy, fetched.archive)).resolves.toEqual({
      status: "failed",
      errorCode: "BUILD_NOT_STARTED",
    });
    expect(database.recordProductSourceArchiveEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      env.BUILD_RUNNER.startBuild.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("provisions transactional mail for a database-backed project without Better Auth", async () => {
    const env = bindings();
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: "site",
        adapter: "tanstack-start",
        runtime: "edge",
        installCommand: "pnpm install --frozen-lockfile",
        buildCommand: "pnpm build",
        outputDirectory: "dist/client",
        serverOutputDirectory: "dist/server",
        serverEntryPoint: "dist/server/index.js",
        serverConfigPath: "dist/server/wrangler.json",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: true, migrations: "migrations" },
        auth: { provider: "none" },
        mail: { enabled: true },
        storage: { enabled: false },
      },
    }));
    const ports = createDeploymentWorkflowPorts(env);
    const result = await ports.database.ensure(command("DeploymentRequestedV1"), {
      ...artifact,
      migrations: [
        {
          path: "20260821090000_foundation.sql",
          digest,
          size: migrationBody.byteLength,
          body: migrationBody,
        },
      ],
      provenance: {
        ...artifact.provenance,
        database: { enabled: true, migrations: "migrations" },
        auth: { provider: "none" },
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      receipt: {
        authSecret: null,
        mailDomain: expect.any(Object),
        mailGatewayKey: expect.any(Object),
      },
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureCustomerAuthSecret).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureTenant).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureMailDomain).toHaveBeenCalledOnce();
    expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).toHaveBeenCalledOnce();
  });

  it("provisions transactional mail for an edge project without a database", async () => {
    const env = bindings();
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: "site",
        adapter: "nextjs",
        runtime: "edge",
        installCommand: "pnpm install --frozen-lockfile",
        buildCommand: "pnpm build:cloudflare",
        outputDirectory: ".open-next/assets",
        serverOutputDirectory: ".ohmyhost-worker",
        serverEntryPoint: ".ohmyhost-worker/worker.js",
        serverConfigPath: "wrangler.jsonc",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: true },
        storage: { enabled: false },
      },
    }));
    const ports = createDeploymentWorkflowPorts(env);
    const result = await ports.database.ensure(command("DeploymentRequestedV1"), {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: false },
        auth: { provider: "none" },
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      receipt: {
        placement: null,
        migration: null,
        authSecret: null,
        mailDomain: expect.any(Object),
        mailGatewayKey: expect.any(Object),
      },
    });
    expect(env.NEON_MANAGEMENT.placeProject).not.toHaveBeenCalled();
    expect(env.NEON_MANAGEMENT.migrateProject).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureTenant).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureMailDomain).toHaveBeenCalledOnce();
    expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).toHaveBeenCalledOnce();
  });

  it("provisions the AI gateway key for a declared AI capability before staging", async () => {
    const env = bindings();
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: { ...frameworkPlan, ai: { enabled: true, jurisdiction: "eu" } },
    }));
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const plainArtifact = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: false },
        auth: { provider: "none" },
      },
    };
    const result = await ports.database.ensure(deploy, plainArtifact);

    expect(result).toMatchObject({
      status: "ready",
      receipt: {
        placement: null,
        migration: null,
        authSecret: null,
        mailDomain: null,
        mailGatewayKey: null,
        aiGatewayKey: { name: "OHMYHOST_AI_KEY" },
      },
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey).toHaveBeenCalledExactlyOnceWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
    expect(env.SES_MANAGEMENT.ensureMailDomain).not.toHaveBeenCalled();
    expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).not.toHaveBeenCalled();

    await (ports.wfp.stage as any)(deploy, plainArtifact);
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey.mock.invocationCallOrder[0]).toBeLessThan(
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("skips the AI gateway key when no AI capability is declared", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const plainArtifact = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: false },
        auth: { provider: "none" },
        storage: { enabled: false },
      },
    };

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), plainArtifact),
    ).resolves.toEqual({ status: "ready", receipt: null });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey).not.toHaveBeenCalled();
  });

  it("provisions a Browser gateway key from the promoted source plan for the target environment", async () => {
    const env = bindings();
    const promotionArtifact = {
      ...contextFor("DeploymentRollbackRequestedV1").rollbackArtifact,
      frameworkPlan: { ...frameworkPlan, browser: { enabled: true } },
    };
    database.readProductWorkflowContext.mockImplementation(async () => ({
      ...contextFor("DeploymentPromotionRequestedV1"),
      frameworkPlan: null,
      promotionArtifact,
      promotionSourceDeployment: null,
    }));
    env.BUILD_RUNNER.readBuildArtifact.mockResolvedValue({
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: false },
        auth: { provider: "none" },
      },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.database.ensure(command("DeploymentPromotionRequestedV1")),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: { browserGatewayKey: { name: "OHMYHOST_BROWSER_KEY" } },
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureBrowserGatewayKey).toHaveBeenCalledExactlyOnceWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey).not.toHaveBeenCalled();
  });

  it("provisions the AI gateway key for the target environment of a promotion", async () => {
    const env = bindings();
    const promotionArtifact = {
      ...contextFor("DeploymentRollbackRequestedV1").rollbackArtifact,
      frameworkPlan: { ...frameworkPlan, ai: { enabled: true, jurisdiction: "any" } },
    };
    database.readProductWorkflowContext.mockImplementation(async () => ({
      ...contextFor("DeploymentPromotionRequestedV1"),
      frameworkPlan: null,
      promotionArtifact,
      promotionSourceDeployment: null,
    }));
    env.BUILD_RUNNER.readBuildArtifact.mockResolvedValue({
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: false },
        auth: { provider: "none" },
      },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.database.ensure(command("DeploymentPromotionRequestedV1")),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: { aiGatewayKey: { name: "OHMYHOST_AI_KEY" } },
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey).toHaveBeenCalledExactlyOnceWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
  });

  it("refuses an AI gateway key result that does not match the declared name", async () => {
    const env = bindings();
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: { ...frameworkPlan, ai: { enabled: true, jurisdiction: "eu" } },
    }));
    env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey.mockResolvedValueOnce({
      name: "OHMYHOST_MAIL_KEY",
      revision: 1,
      keyVersion: 1,
      createdAt: deployedAt,
      updatedAt: deployedAt,
    });
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), {
        ...artifact,
        provenance: {
          ...artifact.provenance,
          database: { enabled: false },
          auth: { provider: "none" },
        },
      }),
    ).rejects.toThrow("AI gateway key result is invalid");
  });

  it("calls the AI gateway key once after a mail domain that is ready", async () => {
    const env = bindings();
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: {
        ...frameworkPlan,
        mail: { enabled: true },
        ai: { enabled: true, jurisdiction: "eu" },
      },
    }));
    const ports = createDeploymentWorkflowPorts(env);
    const plainArtifact = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        database: { enabled: false },
        auth: { provider: "none" },
      },
    };

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), plainArtifact),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: { mailGatewayKey: expect.any(Object), aiGatewayKey: expect.any(Object) },
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).toHaveBeenCalledOnce();
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey).toHaveBeenCalledOnce();

    env.SES_MANAGEMENT.ensureMailDomain.mockResolvedValueOnce({ status: "verification_pending" });
    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), plainArtifact),
    ).resolves.toEqual({ status: "verification_pending" });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey).toHaveBeenCalledOnce();
  });

  it("blocks publication while Resend verification is pending or Paid entitlement is denied", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const sql = new TextEncoder().encode("create table foundation(id bigint);\n");
    const authArtifact = {
      ...artifact,
      migrations: [
        {
          path: "20260821090000_foundation.sql",
          digest,
          size: sql.byteLength,
          body: sql,
        },
      ],
      provenance: {
        ...artifact.provenance,
        database: { enabled: true as const, migrations: "supabase/migrations" },
        auth: {
          provider: "better-auth" as const,
          version: "1.7.7" as const,
          deployment: "embedded" as const,
          routePath: "/api/auth" as const,
          databaseSchema: "auth" as const,
          databaseBindingName: "OHMYHOST_DATABASE" as const,
          authSecretName: "BETTER_AUTH_SECRET" as const,
        },
      },
    };

    // Better Auth without a declared Mail capability deploys without any sender.
    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), authArtifact),
    ).resolves.toMatchObject({ status: "ready", receipt: { mailDomain: null } });
    expect(env.SES_MANAGEMENT.ensureMailDomain).not.toHaveBeenCalled();
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: { ...frameworkPlan, mail: { enabled: true } },
    }));
    env.SES_MANAGEMENT.ensureMailDomain.mockResolvedValueOnce({ status: "verification_pending" });
    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), authArtifact),
    ).resolves.toEqual({ status: "verification_pending" });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).not.toHaveBeenCalled();
    env.SES_MANAGEMENT.ensureMailDomain.mockResolvedValueOnce({
      status: "failed",
      errorCode: "PAID_PLAN_REQUIRED",
    });
    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), authArtifact),
    ).resolves.toEqual({ status: "failed", errorCode: "PAID_PLAN_REQUIRED" });
    env.SES_MANAGEMENT.ensureMailDomain.mockResolvedValueOnce({
      status: "reconciliation_required",
    });
    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), authArtifact),
    ).resolves.toEqual({ status: "uncertain" });
    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), authArtifact),
    ).resolves.toMatchObject({ status: "ready" });
    expect(env.SES_MANAGEMENT.ensureTenant).not.toHaveBeenCalled();
  });

  it("binds the persisted project registration before database-backed WFP publication", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const sql = new TextEncoder().encode("create table foundation(id bigint);\n");
    const databaseArtifact = {
      ...artifact,
      migrations: [
        {
          path: "20260821090000_foundation.sql",
          digest,
          size: sql.byteLength,
          body: sql,
        },
      ],
      provenance: {
        ...artifact.provenance,
        database: { enabled: true as const, migrations: "supabase/migrations" },
      },
    };

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), databaseArtifact),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      (ports.wfp.stage as any)(command("DeploymentRequestedV1"), databaseArtifact),
    ).resolves.toMatchObject({ status: "staged" });
    expect(env.NEON_MANAGEMENT.readRuntimeBinding).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
    });
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseRegistration,
      }),
    );
  });

  it("provisions one private EU R2 bucket before storage-enabled WFP publication", async () => {
    const storage = {
      enabled: true as const,
      provider: "r2" as const,
      jurisdiction: "eu" as const,
      public: false as const,
    };
    database.readProductWorkflowContext.mockImplementation(async (_client, scope) => ({
      ...contextFor((scope as ProductCommandMessageV1).eventType),
      frameworkPlan: { ...frameworkPlan, storage },
    }));
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const storageArtifact = {
      ...artifact,
      provenance: { ...artifact.provenance, storage },
    };
    const expectedBucket = `ohmyho-${ids.projectId.toLowerCase()}-${ids.environmentId.toLowerCase()}`;

    await expect(
      ports.database.ensure(command("DeploymentRequestedV1"), storageArtifact),
    ).resolves.toMatchObject({
      status: "ready",
      receipt: {
        storageBucket: {
          bucketName: expectedBucket,
          jurisdiction: "eu",
          storageClass: "Standard",
          publicAccess: false,
        },
      },
    });
    expect(env.R2_MANAGEMENT.ensureBucket).toHaveBeenCalledWith({
      jurisdiction: "eu",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
    expect(env.RUNTIME_SECRET_DELIVERY.ensureStorageGatewayKey).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });

    await expect(
      (ports.wfp.stage as any)(command("DeploymentRequestedV1"), storageArtifact),
    ).resolves.toMatchObject({ status: "staged" });
    expect(env.R2_MANAGEMENT.readRuntimeBinding).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
    });
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ storageBucketName: expectedBucket }),
    );
    expect(env.NEON_MANAGEMENT.placeProject).not.toHaveBeenCalled();
    expect(env.SES_MANAGEMENT.ensureTenant).not.toHaveBeenCalled();
  });

  it("retains exact WFP ambiguity evidence for provider reconciliation", async () => {
    for (const reconciliationPhase of ["candidate", "secrets"] as const) {
      const env = bindings();
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockResolvedValueOnce({
        status: "reconciliation_required",
        reconciliationPhase,
        currentProviderTag: "provider-ambiguous",
        currentProductDeploymentId: ids.deploymentId,
        runtimeSecretDelivery: { outcome: "claimed", generation: 1 },
      } as never);
      const ports = createDeploymentWorkflowPorts(env);
      const deploy = command("DeploymentRequestedV1");

      await expect((ports.wfp.stage as any)(deploy, artifact)).resolves.toEqual({
        status: "uncertain",
        providerHint: {
          phase: "wfp",
          expectedArtifactDigest: digest,
          currentProviderTag: "provider-ambiguous",
          currentProductDeploymentId: ids.deploymentId,
        },
      });
    }
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");
    const outdated = {
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: "provider-ambiguous",
      currentProductDeploymentId: ids.deploymentId,
      reason: "candidate_bindings_outdated",
    };
    env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockResolvedValueOnce(outdated as never);
    await expect((ports.wfp.stage as any)(deploy, artifact)).resolves.toMatchObject({
      status: "uncertain",
      providerHint: { phase: "wfp", reason: "candidate_bindings_outdated" },
    });
    for (const invalid of [
      { ...outdated, reason: undefined },
      { ...outdated, reason: "provider secret text" },
      { ...outdated, reconciliationPhase: "secrets" },
      { ...outdated, reconciliationPhase: "gateway" },
    ]) {
      env.RUNTIME_SECRET_DELIVERY.stageCandidate.mockResolvedValueOnce(invalid as never);
      await expect((ports.wfp.stage as any)(deploy, artifact)).rejects.toThrow(
        "Provider reconciliation reason is invalid",
      );
    }
  });

  it("persists the exact restored gateway identity in candidate cleanup evidence", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const deploy = command("DeploymentRequestedV1");

    await expect(
      ports.persistence.recordCandidateCleanup({
        command: deploy,
        claim: {
          claimId: ids.targetRevisionId,
          candidateReceiptId: ids.sourceConnectionId,
          cleanupReceiptId: ids.sourceRevisionId,
          candidate: {
            candidateReceiptId: ids.sourceConnectionId,
            operationId: ids.operationId,
            receipt: wfpReceipt,
            previousGateway: gatewayReceipt,
            runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
            runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
            deploymentUrl: gatewayReceipt.publicOrigin,
            artifactDigest: digest,
          },
          supersededById: ids.targetDeploymentId,
          expectedResources: [],
        },
        cleanup: {
          outcome: "removed",
          candidateAbsence: { state: "metadata_absent", observedAt: deployedAt },
          gateway: gatewayReceipt,
          operationResources: [],
        },
      }),
    ).resolves.toBe("applied");

    expect(database.recordWfpCandidateCleanupReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        compensatedTargetScriptName: gatewayReceipt.targetScriptName,
        sharedGatewayRevision: gatewayReceipt.revision,
      }),
    );

    // Compensating a first activation closes the route (Sebmer Prod 01M3J68F78766D1CT2A703JFWQ,
    // 2026-09-27); a closed route leaves nothing to name, so the cleanup books no revision.
    await expect(
      ports.persistence.recordCandidateCleanup({
        command: deploy,
        claim: {
          claimId: ids.targetRevisionId,
          candidateReceiptId: ids.sourceConnectionId,
          cleanupReceiptId: ids.sourceRevisionId,
          candidate: {
            candidateReceiptId: ids.sourceConnectionId,
            operationId: ids.operationId,
            receipt: wfpReceipt,
            previousGateway: null,
            runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
            runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
            deploymentUrl: gatewayReceipt.publicOrigin,
            artifactDigest: digest,
          },
          supersededById: null,
          expectedResources: [],
        },
        cleanup: {
          outcome: "removed",
          candidateAbsence: { state: "metadata_absent", observedAt: deployedAt },
          gateway: { ...gatewayReceipt, active: false },
          operationResources: [],
        },
      }),
    ).resolves.toBe("applied");
    expect(database.recordWfpCandidateCleanupReceipt).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ compensatedTargetScriptName: null, sharedGatewayRevision: null }),
    );
    expect(database.settleSharedGatewayCandidateCleanup).not.toHaveBeenCalled();
  });

  it("records the activated deployment's crons in the finalization transaction", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.persistence.finalizeCandidate({
        workflowId: "deploy-scheduled",
        executionId: "deploy-scheduled",
        command: command("DeploymentRequestedV1"),
        evidence: {
          artifact,
          artifactDigest: digest,
          wfp: wfpReceipt,
          gateway: gatewayReceipt,
          deploymentUrl: gatewayReceipt.publicOrigin,
          runtimePolicy: {
            healthCheckPath: "/",
            egressAllowedOrigins: ["https://api.example.test"],
            browser: normalizeBrowserPolicy({
              connect: ["wss://live.example.test"],
              cors: { origins: ["https://app.example.test"], credentials: true },
            }),
          },
          scheduledFunctions: { crons: ["*/5 * * * *"] },
        },
      }),
    ).resolves.toBe("applied");
    expect(database.recordEnvironmentFunctionSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deploymentId: ids.deploymentId,
        crons: ["*/5 * * * *"],
        egressAllowedOrigins: ["https://api.example.test"],
      }),
    );
  });

  it("preserves declared crons through WFP staging", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const scheduledArtifact = {
      ...artifact,
      provenance: { ...artifact.provenance, functions: { crons: ["*/5 * * * *"] } },
    };

    await expect(
      (ports.wfp.stage as any)(command("DeploymentRequestedV1"), scheduledArtifact),
    ).resolves.toMatchObject({ status: "staged" });
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({
          provenance: expect.objectContaining({
            functions: scheduledArtifact.provenance.functions,
          }),
        }),
      }),
    );
  });

  it("records the rollback target's crons as the environment schedule", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.persistence.finalizeRollback({
        workflowId: "rollback-scheduled",
        executionId: "rollback-scheduled",
        command: command("DeploymentRollbackRequestedV1"),
        evidence: {
          gateway: {
            ...gatewayReceipt,
            targetDeploymentId: ids.targetDeploymentId,
            targetScriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
          },
          runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
          scheduledFunctions: { crons: ["*/5 * * * *"] },
        },
      }),
    ).resolves.toBe("applied");
    expect(env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      deploymentId: ids.targetDeploymentId,
      environmentName: "dev",
      gatewayScriptName: sharedGatewayWorkerName,
      healthCheckPath: "/",
    });
    expect(
      env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment.mock.invocationCallOrder[0],
    ).toBeLessThan(database.finalizeRollbackActivation.mock.invocationCallOrder[0] ?? 0);
    expect(database.recordEnvironmentFunctionSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deploymentId: ids.targetDeploymentId,
        candidateReceiptId: ids.sourceConnectionId,
        crons: ["*/5 * * * *"],
      }),
    );
  });

  it("retries a pending rollback domain without treating readiness as a head conflict", async () => {
    const env = bindings();
    env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment.mockResolvedValueOnce({
      status: "pending",
      environmentName: "dev",
      hostname: "dev-calm-otter-builds.dev.check.omh.st",
      dnsRecordId: "a".repeat(32),
      routeId: "b".repeat(32),
      publicUrl: "https://dev-calm-otter-builds.dev.check.omh.st",
      observedAt: deployedAt,
      probe: null,
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.persistence.finalizeRollback({
        workflowId: "rollback-pending-domain",
        executionId: "rollback-pending-domain",
        command: command("DeploymentRollbackRequestedV1"),
        evidence: {
          gateway: {
            ...gatewayReceipt,
            targetDeploymentId: ids.targetDeploymentId,
            targetScriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
          },
          runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
          scheduledFunctions: null,
        },
      }),
    ).rejects.toThrow("Rollback domain is not ready");
    expect(database.finalizeRollbackActivation).not.toHaveBeenCalled();
  });

  it("rejects mixed rollback target identity before Domain or DB finalization", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.persistence.finalizeRollback({
        workflowId: "rollback-mixed-target",
        executionId: "rollback-mixed-target",
        command: command("DeploymentRollbackRequestedV1"),
        evidence: {
          gateway: gatewayReceipt,
          runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
          scheduledFunctions: null,
        },
      }),
    ).rejects.toThrow("Candidate gateway target is invalid");
    expect(env.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment).not.toHaveBeenCalled();
    expect(database.finalizeRollbackActivation).not.toHaveBeenCalled();
  });

  it("resumes a claimed cleanup through the persisted runtime-secret stage", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const candidate = {
      candidateReceiptId: ids.sourceConnectionId,
      operationId: ids.operationId,
      receipt: wfpReceipt,
      previousGateway: gatewayReceipt,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      runtimeSecretDeliveryStage: null,
      deploymentUrl: gatewayReceipt.publicOrigin,
      artifactDigest: digest,
    } as const;

    await expect(
      ports.wfp.removeClaimedCandidate(command("DeploymentRequestedV1"), {
        claimId: ids.targetRevisionId,
        candidateReceiptId: ids.sourceConnectionId,
        cleanupReceiptId: ids.sourceRevisionId,
        candidate,
        supersededById: ids.targetDeploymentId,
        expectedResources: [],
      }),
    ).resolves.toMatchObject({ status: "not_found", outcome: "not_found" });

    expect(env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate).toHaveBeenCalledWith({
      scope: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        environmentName: "dev",
        handle: "calm-otter-builds",
        operationId: ids.operationId,
      },
      candidateReceiptId: ids.sourceConnectionId,
      claimId: ids.targetRevisionId,
      candidate: expect.objectContaining({ providerTag: wfpReceipt.providerTag }),
    });
  });

  it("rejects an impossible persisted-removal status instead of inventing not-found success", async () => {
    const env = bindings();
    env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate.mockResolvedValueOnce({
      status: "not_found",
      outcome: "not_found",
    } as never);
    const ports = createDeploymentWorkflowPorts(env);
    const candidate = {
      candidateReceiptId: ids.sourceConnectionId,
      operationId: ids.operationId,
      receipt: wfpReceipt,
      previousGateway: gatewayReceipt,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      deploymentUrl: gatewayReceipt.publicOrigin,
      artifactDigest: digest,
    } as const;

    await expect(
      ports.wfp.removeClaimedCandidate(command("DeploymentRequestedV1"), {
        claimId: ids.targetRevisionId,
        candidateReceiptId: ids.sourceConnectionId,
        cleanupReceiptId: ids.sourceRevisionId,
        candidate,
        supersededById: ids.targetDeploymentId,
        expectedResources: [],
      }),
    ).rejects.toThrow("Persisted candidate removal is invalid");
  });

  it("rejects null runtime-secret stage evidence before gateway activation", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.wfp.activate(command("DeploymentRequestedV1"), {
        candidateReceiptId: ids.sourceConnectionId,
        operationId: ids.operationId,
        receipt: wfpReceipt,
        previousGateway: gatewayReceipt,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: null,
        deploymentUrl: gatewayReceipt.publicOrigin,
        artifactDigest: digest,
      }),
    ).rejects.toThrow("no recorded runtime-secret stage");
    expect(env.WFP_MANAGEMENT.activateCandidate).not.toHaveBeenCalled();
  });

  it("returns an exact unhealthy candidate for the existing compensation path", async () => {
    const env = bindings();
    env.WFP_MANAGEMENT.activateCandidate.mockResolvedValueOnce({
      status: "unhealthy",
      candidate: wfpReceipt,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
      health: { status: 500, path: "/", excerpt: null, truncated: false },
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.wfp.activate(command("DeploymentRequestedV1"), {
        candidateReceiptId: ids.sourceConnectionId,
        operationId: ids.operationId,
        receipt: wfpReceipt,
        previousGateway: null,
        runtimePolicy: { healthCheckPath: "/api/health", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
        deploymentUrl: gatewayReceipt.publicOrigin,
        artifactDigest: digest,
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      candidateReceipt: wfpReceipt,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    });
  });

  it("reports an in-progress build sandbox run as running without reading an artifact", async () => {
    const env = bindings();
    env.BUILD_RUNNER.readBuild.mockResolvedValueOnce({ status: "running" });
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      ports.build.observe(command("DeploymentRequestedV1"), buildReceipt),
    ).resolves.toEqual({ status: "running" });
    expect(env.BUILD_RUNNER.readBuildArtifact).not.toHaveBeenCalled();
  });

  it("validates source links and completes their exact repository identity", async () => {
    const ports = createDeploymentWorkflowPorts(bindings());
    const link = command("SourceLinkRequestedV1");
    const observation = await ports.source.observeLink(link);
    expect(observation).toEqual({
      status: "observed",
      evidence: { externalRepositoryId: "456" },
    });
    if (observation.status !== "observed") throw new Error("Expected observed source link");
    await expect(
      ports.persistence.complete({
        workflowId: "product-workflow-link",
        executionId: "product-workflow-link",
        command: link,
        evidence: observation.evidence,
      }),
    ).resolves.toBe("applied");
    expect(database.completeProductCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ terminalEvidence: { externalRepositoryId: "456" } }),
    );
    database.readProductWorkflowContext.mockResolvedValueOnce({
      ...contextFor("SourceLinkRequestedV1"),
      authorizedRepositoryId: "789",
    });
    await expect(ports.source.observeLink(link)).rejects.toThrow(
      "identity changed after customer consent",
    );
    database.readProductWorkflowContext.mockResolvedValueOnce({
      ...contextFor("SourceLinkRequestedV1"),
      authorizedRepositoryId: undefined,
    });
    await expect(ports.source.observeLink(link)).rejects.toThrow();
  });

  it("binds replay completion and activation to the exact audited attempt", async () => {
    const ports = createDeploymentWorkflowPorts(bindings());
    const link = command("SourceLinkRequestedV1");
    const replayAttemptId = ids.targetRevisionId;
    const physicalWorkflowId = `product-command-replay-v1-${replayAttemptId}`;
    await expect(
      ports.persistence.complete({
        workflowId: deterministicProductCommandWorkflowId(link),
        executionId: physicalWorkflowId,
        command: link,
        evidence: { externalRepositoryId: "456" },
      }),
    ).resolves.toBe("applied");
    expect(database.completeProductCommand).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ replayAttemptId }),
    );
    await expect(
      activateDeploymentReplayAttempt(recordedAttempts(), {
        attemptId: replayAttemptId,
        physicalWorkflowId,
        command: link,
      }),
    ).resolves.toBe("active");
    expect(database.activateProductWorkflowReplayAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: replayAttemptId, physicalWorkflowId }),
    );
    await expect(
      activateDeploymentReplayAttempt(recordedAttempts(), {
        attemptId: replayAttemptId,
        physicalWorkflowId,
        command: command("DeploymentRollbackRequestedV1"),
      }),
    ).resolves.toBe("active");
    await expect(
      activateDeploymentReplayAttempt(recordedAttempts(), {
        attemptId: replayAttemptId,
        physicalWorkflowId,
        command: command("DeploymentRequestedV1"),
      }),
    ).rejects.toThrow("replay command type is invalid");
  });

  it("rolls back the requested deployment when two receipts share the same artifact without rebuilding", async () => {
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    const rollback = command("DeploymentRollbackRequestedV1");
    const published = await (ports.wfp.prepareRollback as any)(rollback);
    expect(published).toMatchObject({
      status: "replayed",
      artifactDigest: digest,
      receipt: expect.objectContaining({
        productDeploymentId: ids.targetDeploymentId,
        providerTag: rollbackReceipt.providerTag,
      }),
    });
    if (published.status !== "replayed") throw new Error("Expected prepared rollback");
    const [prepared] = env.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate.mock
      .calls[0] as unknown as [{ candidate: typeof rollbackReceipt }];
    expect(prepared.candidate.productDeploymentId).toBe(ids.targetDeploymentId);
    expect(prepared.candidate.scriptName).toBe(rollbackReceipt.scriptName);
    expect(env.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactSourceDeploymentId: artifact.provenance.deploymentId,
        scope: {
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          environmentName: "dev",
          handle: "calm-otter-builds",
          operationId: ids.operationId,
        },
      }),
    );
    expect(database.claimProductProviderMutation).toHaveBeenCalledWith(expect.anything(), {
      claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      eventType: "DeploymentRollbackRequestedV1",
      eventId: ids.eventId,
      logicalWorkflowId: `product-command-v1-rollback-${ids.eventId}-${ids.operationId}`,
      acceptedLifecycleVersion: 3,
    });
    expect(database.claimProductProviderMutation.mock.invocationCallOrder[0]).toBeLessThan(
      env.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(env.SOURCE_FETCHER.acquireExact).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.startBuild).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledWith({
      bucket: "ohmyho-builds-development",
      expectation: expect.not.objectContaining({ output: expect.anything() }),
    });
    expect(database.recordProductRollbackEvidence).not.toHaveBeenCalled();

    database.readProductWorkflowContext.mockResolvedValueOnce({
      ...contextFor("DeploymentRollbackRequestedV1"),
      knownDeployments: [wfpReceipt],
    } as never);
    await expect((ports.wfp.prepareRollback as any)(rollback)).rejects.toThrow(
      "Rollback target has no WFP receipt",
    );
    expect(database.claimProductProviderMutation).toHaveBeenCalledTimes(1);
    expect(env.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate).toHaveBeenCalledTimes(1);
    database.readRollbackPlanTarget.mockResolvedValueOnce({
      dataChanged: true,
      dataChangeInProgress: false,
    });
    await expect((ports.wfp.prepareRollback as any)(rollback)).rejects.toThrow(
      "Rollback target data changed",
    );
    expect(env.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate).toHaveBeenCalledTimes(1);
  });

  it("rolls back a promoted prod head without rebuilding or touching the dev environment", async () => {
    const currentProdReceipt = {
      ...wfpReceipt,
      scriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
    } as const;
    const prodReceipt = {
      ...rollbackReceipt,
      scriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.targetDeploymentId.toLowerCase()}`,
      environmentId: ids.environmentId,
      providerTag: "prod-rollback-tag",
      buildReused: true,
    } as const;
    const prodGateway = {
      ...gatewayReceipt,
      targetScriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
      environmentName: "prod" as const,
      hostname: "calm-otter-builds.ohmyho.st",
      publicOrigin: "https://calm-otter-builds.ohmyho.st",
    } as const;
    database.readProductWorkflowContext.mockResolvedValue({
      ...contextFor("DeploymentRollbackRequestedV1"),
      environmentName: "prod",
      headVersion: 4,
      activeDeployment: currentProdReceipt,
      activeGateway: prodGateway,
      knownDeployments: [currentProdReceipt, prodReceipt],
    } as never);
    const env = bindings();
    env.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate.mockResolvedValueOnce({
      status: "replayed",
      candidate: prodReceipt,
      priorGateway: null,
      activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      deploymentUrl: `${prodGateway.publicOrigin}/`,
      runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
      runtimeSecretDelivery: {
        generation: 4,
        secretCount: 1,
        manifestDigest: `sha256:${"e".repeat(64)}`,
      },
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
    } as never);
    env.WFP_MANAGEMENT.observeActivation.mockResolvedValueOnce({
      status: "activated",
      candidate: prodReceipt,
      gateway: prodGateway,
      deploymentUrl: `${prodGateway.publicOrigin}/`,
    } as never);
    env.WFP_MANAGEMENT.observeCandidate.mockResolvedValueOnce({
      state: "ready",
      providerTag: prodReceipt.providerTag,
      productDeploymentId: prodReceipt.productDeploymentId,
      artifactDigest: prodReceipt.artifactDigest,
    } as never);
    const ports = createDeploymentWorkflowPorts(env);
    const rollback = command("DeploymentRollbackRequestedV1");
    const published = await (ports.wfp.prepareRollback as any)(rollback);
    expect(published).toMatchObject({
      status: "replayed",
      deploymentUrl: prodGateway.publicOrigin,
    });
    if (published.status !== "replayed") throw new Error("Expected prepared prod rollback");
    await expect((ports.wfp.observeActivation as any)(rollback, published)).resolves.toMatchObject({
      status: "activated",
    });
    expect(env.SOURCE_FETCHER.acquireExact).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.startBuild).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.readBuild).not.toHaveBeenCalled();
    expect(database.completeProductCommand).not.toHaveBeenCalled();
  });

  it.each(["shared", "isolated"] as const)(
    "promotes the same verified artifact with %s data and source-declared mail without managed auth",
    async (dataMode) => {
      const prodReceipt = {
        ...wfpReceipt,
        scriptName: `p-${ids.projectId.toLowerCase()}-prod`,
        environmentId: ids.environmentId,
        productDeploymentId: ids.deploymentId,
        providerTag: "b".repeat(32),
        buildReused: true,
      } as const;
      const sourceReceipt = {
        ...wfpReceipt,
        scriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
        environmentId: ids.sourceEnvironmentId,
        productDeploymentId: ids.targetDeploymentId,
        providerTag: "c".repeat(32),
      } as const;
      const prodGateway = {
        ...gatewayReceipt,
        targetScriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
        environmentName: "prod" as const,
        hostname: "calm-otter-builds.ohmyho.st",
        publicOrigin: "https://calm-otter-builds.ohmyho.st",
      } as const;
      const promotionArtifact = {
        ...contextFor("DeploymentRollbackRequestedV1").rollbackArtifact,
        frameworkPlan: { ...frameworkPlan, mail: { enabled: true } },
        deploymentId: ids.targetDeploymentId,
        output: {
          ...contextFor("DeploymentRollbackRequestedV1").rollbackArtifact.output,
          scope: {
            projectId: ids.projectId,
            environmentId: ids.sourceEnvironmentId,
            operationId: ids.operationId,
          },
        },
      };
      const promotionSql = new TextEncoder().encode(
        "CREATE TABLE public.items (id integer PRIMARY KEY);",
      );
      const promotedArtifact = {
        ...artifact,
        migrations: [
          {
            path: "20260908000000_items.sql",
            digest,
            size: promotionSql.byteLength,
            body: promotionSql,
          },
        ],
        provenance: {
          ...artifact.provenance,
          database: { enabled: true as const, migrations: "migrations" },
          deploymentId: ids.targetDeploymentId,
          storage: {
            enabled: true as const,
            provider: "r2" as const,
            jurisdiction: "eu" as const,
            public: false as const,
          },
          scope: {
            projectId: ids.projectId,
            environmentId: ids.sourceEnvironmentId,
            operationId: ids.operationId,
          },
        },
      };
      database.readProductWorkflowContext.mockImplementation(async () => ({
        ...contextFor("DeploymentPromotionRequestedV1"),
        frameworkPlan: null,
        dataMode,
        environmentName: "prod" as const,
        intent: {
          ...contextFor("DeploymentPromotionRequestedV1").intent,
          sourceEnvironmentId: ids.sourceEnvironmentId,
          sourceDeploymentId: ids.targetDeploymentId,
          sourceRevisionId: ids.sourceRevisionId,
          sourceArtifactId: ids.targetRevisionId,
          sourceArtifactDigest: Buffer.from(hex, "hex"),
          expectedSourceHeadVersion: 4,
          expectedTargetHeadVersion: 0,
        },
        headVersion: 0,
        activeDeploymentId: null,
        activeDeployment: null,
        activeGateway: null,
        knownDeployments: [],
        promotionArtifact,
        promotionSourceDeployment: sourceReceipt,
      }));
      const env = bindings();
      env.BUILD_RUNNER.readBuildArtifact.mockResolvedValue(promotedArtifact as never);
      env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate.mockResolvedValueOnce({
        status: "staged",
        candidate: prodReceipt,
        priorGateway: null,
        activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        deploymentUrl: prodGateway.publicOrigin,
        promotion: {
          sourceDeploymentId: ids.targetDeploymentId,
          targetDeploymentId: ids.deploymentId,
          sourceEnvironmentId: ids.sourceEnvironmentId,
          targetEnvironmentId: ids.environmentId,
          artifactDigest: digest,
          buildReused: true,
        },
        runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
        runtimeSecretDelivery: {
          generation: 2,
          secretCount: 1,
          manifestDigest: `sha256:${"e".repeat(64)}`,
        },
      } as never);
      const ports = createDeploymentWorkflowPorts(env);
      const promotion = command("DeploymentPromotionRequestedV1");

      await expect(ports.database.ensure(promotion)).resolves.toMatchObject({
        status: "ready",
        receipt: {
          authSecret: null,
          mailDomain: expect.any(Object),
          mailGatewayKey: { name: "OHMYHOST_MAIL_KEY" },
        },
      });
      const published = await (ports.wfp.stage as any)(promotion);

      expect(env.RUNTIME_SECRET_DELIVERY.ensureCustomerAuthSecret).not.toHaveBeenCalled();
      expect(env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey).toHaveBeenCalledExactlyOnceWith({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      });
      expect(
        env.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey.mock.invocationCallOrder[0],
      ).toBeLessThan(
        env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate.mock.invocationCallOrder[0] ?? 0,
      );

      expect(published).toMatchObject({
        status: "staged",
        artifactDigest: digest,
        receipt: expect.objectContaining({ providerTag: "b".repeat(32) }),
        deploymentUrl: prodGateway.publicOrigin,
      });
      expect(env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: {
            organizationId: ids.organizationId,
            projectId: ids.projectId,
            environmentId: ids.environmentId,
            environmentName: "prod",
            handle: "calm-otter-builds",
            operationId: ids.operationId,
          },
          deploymentId: ids.deploymentId,
          artifactReuse: "promotion",
          artifact: expect.objectContaining({
            provenance: expect.objectContaining({
              artifactDigest: digest,
              deploymentId: ids.targetDeploymentId,
              scope: expect.objectContaining({ environmentId: ids.sourceEnvironmentId }),
            }),
          }),
        }),
      );
      expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).not.toHaveBeenCalled();
      expect(env.SOURCE_FETCHER.acquireExact).not.toHaveBeenCalled();
      expect(env.BUILD_RUNNER.startBuild).not.toHaveBeenCalled();
      expect(env.BUILD_RUNNER.readBuild).not.toHaveBeenCalled();
      expect(env.RUNTIME_SECRET_DELIVERY.ensureStorageGatewayKey).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: ids.environmentId }),
      );
      expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledTimes(2);
      expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledWith({
        bucket: "ohmyho-builds-development",
        expectation: expect.objectContaining({
          deploymentId: ids.targetDeploymentId,
          receipt: buildReceipt,
          commitSha: "a".repeat(40),
          sourceSha256: hex,
          buildPlanSha256: hex,
        }),
      });
      expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledWith({
        bucket: "ohmyho-builds-development",
        expectation: expect.not.objectContaining({ output: expect.anything() }),
      });
      if (dataMode === "shared") {
        expect(env.NEON_MANAGEMENT.placeProject).not.toHaveBeenCalled();
        expect(env.NEON_MANAGEMENT.migrateProject).not.toHaveBeenCalled();
      } else {
        expect(env.NEON_MANAGEMENT.placeProject).toHaveBeenCalledOnce();
        expect(env.NEON_MANAGEMENT.migrateProject).toHaveBeenCalledWith(
          expect.objectContaining({
            organizationId: ids.organizationId,
            projectId: ids.projectId,
            environmentId: ids.environmentId,
            operationId: ids.operationId,
            migrations: promotedArtifact.migrations,
          }),
        );
      }
      expect(env.R2_MANAGEMENT.ensureBucket).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          operationId: ids.operationId,
          claimId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
        }),
      );
      expect(env.R2_MANAGEMENT.ensureBucket.mock.invocationCallOrder[0]).toBeLessThan(
        env.R2_MANAGEMENT.readRuntimeBinding.mock.invocationCallOrder[0] ?? 0,
      );
      expect(env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          storageBucketName: `ohmyho-${ids.projectId.toLowerCase()}-${ids.environmentId.toLowerCase()}`,
        }),
      );
      const promotionInput = (env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate as any).mock
        .calls[0]?.[0];
      expect(JSON.stringify(promotionInput)).not.toMatch(
        /runtimeSecretManifest|customerSecrets|dev-secret-value|prod-secret-value/u,
      );

      if (published.status !== "staged") throw new Error("Expected staged promotion");
      expect(database.recordPromotionRevision).not.toHaveBeenCalled();
      expect(database.completeDeploymentPromotion).not.toHaveBeenCalled();
      expect(database.completeProductCommand).not.toHaveBeenCalled();
    },
  );

  it("passes the exact current prod receipts when promotion replaces an existing prod head", async () => {
    const sourceReceipt = {
      ...wfpReceipt,
      scriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
      environmentId: ids.sourceEnvironmentId,
      productDeploymentId: ids.targetDeploymentId,
      providerTag: "d".repeat(32),
      buildReused: true,
    } as const;
    const previousProd = {
      ...wfpReceipt,
      scriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
      providerTag: "e".repeat(32),
    } as const;
    const previousGateway = {
      ...gatewayReceipt,
      targetScriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
      environmentName: "prod" as const,
      hostname: "calm-otter-builds.ohmyho.st",
      publicOrigin: "https://calm-otter-builds.ohmyho.st",
    } as const;
    database.readProductWorkflowContext.mockResolvedValue({
      ...contextFor("DeploymentPromotionRequestedV1"),
      environmentName: "prod",
      headVersion: 3,
      intent: {
        ...contextFor("DeploymentPromotionRequestedV1").intent,
        sourceEnvironmentId: ids.sourceEnvironmentId,
        sourceDeploymentId: ids.targetDeploymentId,
        sourceRevisionId: ids.sourceRevisionId,
        sourceArtifactId: ids.targetRevisionId,
        sourceArtifactDigest: Buffer.from(hex, "hex"),
        expectedSourceHeadVersion: 5,
        expectedTargetHeadVersion: 3,
      },
      promotionArtifact: contextFor("DeploymentRollbackRequestedV1").rollbackArtifact,
      promotionSourceDeployment: sourceReceipt,
      activeDeployment: previousProd,
      activeGateway: previousGateway,
    });
    const env = bindings();
    env.BUILD_RUNNER.readBuildArtifact.mockResolvedValueOnce({
      ...artifact,
      provenance: { ...artifact.provenance, deploymentId: ids.targetDeploymentId },
    } as never);
    env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate.mockResolvedValueOnce({
      status: "replayed",
      candidate: { ...previousProd, providerTag: "a".repeat(32), buildReused: true },
      priorGateway: previousGateway,
      activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      deploymentUrl: previousGateway.publicOrigin,
      promotion: {
        sourceDeploymentId: ids.targetDeploymentId,
        targetDeploymentId: ids.deploymentId,
        sourceEnvironmentId: ids.sourceEnvironmentId,
        targetEnvironmentId: ids.environmentId,
        artifactDigest: digest,
        buildReused: true,
      },
      runtimeSecretManifestDigest: `sha256:${"e".repeat(64)}`,
      runtimeSecretDelivery: {
        generation: 4,
        secretCount: 2,
        manifestDigest: `sha256:${"e".repeat(64)}`,
      },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      (ports.wfp.stage as any)(command("DeploymentPromotionRequestedV1")),
    ).resolves.toMatchObject({ status: "replayed" });
    expect(env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        previousGateway: expect.objectContaining({
          environmentName: "prod",
        }),
      }),
    );
  });

  it("rejects a stale promotion context before artifact or provider access", async () => {
    database.readProductWorkflowContext.mockResolvedValueOnce({
      ...contextFor("DeploymentPromotionRequestedV1"),
      environmentName: "prod",
      headVersion: 2,
      intent: {
        ...contextFor("DeploymentPromotionRequestedV1").intent,
        sourceEnvironmentId: ids.sourceEnvironmentId,
        sourceDeploymentId: ids.targetDeploymentId,
        sourceRevisionId: ids.sourceRevisionId,
        sourceArtifactDigest: Buffer.from(hex, "hex"),
        expectedSourceHeadVersion: 5,
        expectedTargetHeadVersion: 1,
      },
      promotionArtifact: contextFor("DeploymentRollbackRequestedV1").rollbackArtifact,
      promotionSourceDeployment: {
        ...wfpReceipt,
        environmentId: ids.sourceEnvironmentId,
        productDeploymentId: ids.targetDeploymentId,
      },
    });
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      (ports.wfp.stage as any)(command("DeploymentPromotionRequestedV1")),
    ).rejects.toThrow("Promotion target head changed");
    expect(env.BUILD_RUNNER.readBuildArtifact).not.toHaveBeenCalled();
    expect(env.RUNTIME_SECRET_DELIVERY.stageCandidate).not.toHaveBeenCalled();
    expect(database.claimProductProviderMutation).not.toHaveBeenCalled();
  });

  // A promotion whose Dev head moved after acceptance keeps its persisted context, marked stale:
  // it answers that staleness and can fail or park, but no provider port may act on it.
  it("answers a moved promotion head and lets only failure or reconciliation use its context", async () => {
    const promotion = command("DeploymentPromotionRequestedV1");
    const workflowId = deterministicProductCommandWorkflowId(promotion);
    const ports = createDeploymentWorkflowPorts(bindings());
    await expect(ports.persistence.readPromotionStaleness(promotion)).resolves.toBeNull();

    database.readProductWorkflowContext.mockResolvedValue({
      ...contextFor("DeploymentPromotionRequestedV1"),
      environmentName: "prod",
      promotionArtifact: null,
      promotionSourceDeployment: null,
      promotionStale: "source",
    });
    await expect(ports.persistence.readPromotionStaleness(promotion)).resolves.toBe("source");
    await expect(ports.persistence.claimCandidateCleanup(promotion)).rejects.toThrow(
      "Product Workflow has no exact persisted command context",
    );
    await expect(ports.database.ensure(promotion)).rejects.toThrow(
      "Product Workflow has no exact persisted command context",
    );
    await expect(
      ports.persistence.fail({
        workflowId,
        executionId: workflowId,
        command: promotion,
        errorCode: "PROMOTION_SOURCE_STALE",
      }),
    ).resolves.toBe("applied");
    expect(database.failProductDeploymentCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "PROMOTION_SOURCE_STALE" }),
    );
    await expect(
      ports.persistence.requireReconciliation({
        workflowId,
        executionId: workflowId,
        command: promotion,
        providerHint: null,
      }),
    ).resolves.toBe("applied");
    expect(lifecycleRecorders.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ command: promotion }),
    );
    await expect(
      ports.persistence.complete({
        workflowId,
        executionId: workflowId,
        command: promotion,
        evidence: {},
      }),
    ).rejects.toThrow("require their original typed finalization group");
    expect(database.claimPendingWfpCandidateCleanup).not.toHaveBeenCalled();
    expect(database.claimProductProviderMutation).not.toHaveBeenCalled();
  });

  it("turns an uncertain promotion reply into provider reconciliation without retrying a build", async () => {
    const sourceReceipt = {
      ...wfpReceipt,
      environmentId: ids.sourceEnvironmentId,
      productDeploymentId: ids.targetDeploymentId,
    } as const;
    database.readProductWorkflowContext.mockResolvedValue({
      ...contextFor("DeploymentPromotionRequestedV1"),
      environmentName: "prod",
      headVersion: 0,
      intent: {
        ...contextFor("DeploymentPromotionRequestedV1").intent,
        sourceEnvironmentId: ids.sourceEnvironmentId,
        sourceDeploymentId: ids.targetDeploymentId,
        sourceRevisionId: ids.sourceRevisionId,
        sourceArtifactDigest: Buffer.from(hex, "hex"),
        expectedSourceHeadVersion: 5,
        expectedTargetHeadVersion: 0,
      },
      activeDeploymentId: null,
      activeDeployment: null,
      activeGateway: null,
      knownDeployments: [],
      promotionArtifact: contextFor("DeploymentRollbackRequestedV1").rollbackArtifact,
      promotionSourceDeployment: sourceReceipt,
    });
    const env = bindings();
    env.BUILD_RUNNER.readBuildArtifact.mockResolvedValueOnce({
      ...artifact,
      provenance: { ...artifact.provenance, deploymentId: ids.targetDeploymentId },
    } as never);
    env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "wfp",
      currentProviderTag: null,
      currentProductDeploymentId: ids.deploymentId,
      runtimeSecretDelivery: { outcome: "claimed", generation: 3 },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      (ports.wfp.stage as any)(command("DeploymentPromotionRequestedV1")),
    ).resolves.toEqual({
      status: "uncertain",
      providerHint: {
        phase: "wfp",
        expectedArtifactDigest: digest,
        currentProviderTag: null,
        currentProductDeploymentId: ids.deploymentId,
      },
    });
    expect(env.BUILD_RUNNER.startBuild).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.readBuild).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.readBuildArtifact).toHaveBeenCalledOnce();
    expect(env.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate).toHaveBeenCalledOnce();
  });

  it("retains the exact activation runtime policy when gateway observation is uncertain", async () => {
    const env = bindings();
    const activationRuntimePolicy = {
      healthCheckPath: "/api/health",
      egressAllowedOrigins: [
        "https://00000000000000000000000000000001.r2.cloudflarestorage.com",
        "https://ohmyho-mail-gateway-poc-private-fullstack.your-omh-account.workers.dev",
        "https://ohmyho-storage-gateway-poc-private-fullstack.your-omh-account.workers.dev",
      ],
    };
    env.WFP_MANAGEMENT.observeActivation.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "health",
      currentProviderTag: gatewayReceipt.targetProviderTag,
      currentProductDeploymentId: ids.deploymentId,
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(
      (ports.wfp.observeActivation as any)(command("DeploymentRequestedV1"), {
        receipt: wfpReceipt,
        runtimePolicy: activationRuntimePolicy,
        runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      }),
    ).resolves.toEqual({
      status: "uncertain",
      providerHint: {
        phase: "gateway",
        expectedArtifactDigest: digest,
        currentProviderTag: gatewayReceipt.targetProviderTag,
        currentProductDeploymentId: ids.deploymentId,
        activationRuntimePolicy,
      },
    });
  });

  it("removes WFP once, retains its tombstone, and proves exact inventory absence", async () => {
    const env = bindings();
    const observedAt = new Date("2026-09-13T02:10:00.000Z");
    const ports = createDeploymentWorkflowPorts(env, () => observedAt);
    const deletion = command("ProjectDeletionRequestedV1");
    const tombstone = await ports.wfp.tombstone(deletion);
    expect(tombstone).toEqual({
      status: "observed",
      tombstoneReceiptId: "dev:removed",
      consecutive404s: 3,
    });
    if (tombstone.status !== "observed") throw new Error("Expected deletion tombstone");
    await expect(
      ports.persistence.retainDeletionTombstone({
        workflowId: "product-workflow-delete",
        executionId: "product-workflow-delete",
        command: deletion,
        tombstoneReceiptId: tombstone.tombstoneReceiptId,
      }),
    ).resolves.toBe("applied");
    const inventory = await ports.wfp.cleanupInventory(deletion);
    expect(inventory).toEqual({ status: "observed", inventoryClean: true });
    const route = await ports.wfp.observeRoute404(deletion, tombstone);
    expect(route).toEqual({ status: "observed", consecutive404s: 3 });
    if (route.status !== "observed") throw new Error("Expected sustained route absence");
    await expect(ports.wfp.finalizeRemoval(deletion)).resolves.toEqual({
      status: "observed",
      consecutive404s: 3,
      gatewayAbsence: [gatewayAbsence, null],
    });
    await expect(
      ports.persistence.complete({
        workflowId: "product-workflow-delete",
        executionId: "product-workflow-delete",
        command: deletion,
        evidence: {
          tombstoneReceiptId: tombstone.tombstoneReceiptId,
          inventoryClean: true,
          consecutive404s: route.consecutive404s,
          gatewayAbsence: [
            { ...gatewayAbsence, observedAt: new Date(gatewayAbsence.observedAt) } as never,
            prodGatewayAbsence,
          ],
        },
      }),
    ).resolves.toBe("applied");

    expect(env.WFP_MANAGEMENT.remove).not.toHaveBeenCalled();
    expect(env.WFP_MANAGEMENT.finalizeRemoval).toHaveBeenCalledTimes(2);
    // WfpManagementService.finalizeRemoval accepts exactly these keys; the deletion's cleanup run
    // is its authority because an accepted deletion owns no provider-mutation claim.
    for (const [input] of env.WFP_MANAGEMENT.finalizeRemoval.mock.calls as unknown as [
      Record<string, unknown>,
    ][]) {
      expect(Object.keys(input).sort()).toEqual([
        "claimId",
        "deploymentId",
        "expectedGateway",
        "operationId",
        "organizationId",
        "scope",
      ]);
      expect(input).toMatchObject({
        organizationId: ids.organizationId,
        operationId: ids.operationId,
        claimId: ids.eventId,
      });
    }
    expect(database.claimProductProviderMutation).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.removeBuildArtifact).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.removeBuildArtifactObject).toHaveBeenCalledOnce();
    expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledOnce();
    expect(lifecycleRecorders.retainDeletionTombstone).toHaveBeenCalledWith(
      expect.objectContaining({
        command: deletion,
        tombstoneReceiptId: "dev:removed",
      }),
    );
    expect(lifecycleRecorders.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        command: deletion,
        evidence: expect.objectContaining({
          tombstoneReceiptId: "dev:removed",
          inventoryClean: true,
          consecutive404s: 3,
        }),
      }),
    );
  });
  it("rejects revoked deployment authority with exact candidate cleanup while retaining unknown activation", async () => {
    const env = bindings(),
      ports = createDeploymentWorkflowPorts(env),
      deploy = command("DeploymentRequestedV1");
    const reject = ports.persistence.rejectAuthorization;
    if (reject === undefined) throw new Error("Missing authorization rejection port");
    const workflowId = deterministicProductCommandWorkflowId(deploy);
    expect(
      await reject({
        workflowId,
        executionId: workflowId,
        command: deploy as never,
        candidate: null,
        candidateEvidence: null,
        activation: null,
        activationAttempted: false,
      }),
    ).toEqual({ status: "failed", persistence: "applied" });
    expect(database.failProductDeploymentCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "AUTHORIZATION_CHANGED" }),
    );
    const current = contextFor("DeploymentRequestedV1"),
      source = current.sourceArchives[0],
      artifact = current.artifactExpectations[0];
    if (source === undefined || artifact === undefined)
      throw new Error("Missing scoped custody fixtures");
    const sourceIdentity = `${source.bucket}/${source.key}/${source.versionId}`,
      artifactIdentity = `r2-version:${artifact.output.bucket}/${artifact.output.key}#${artifact.output.versionId}`;
    database.prepareCandidateCleanup.mockResolvedValue({
      claimId: parseUlid(ids.targetRevisionId),
      candidateReceiptId: parseUlid(ids.sourceConnectionId),
      expectedResources: [
        {
          provider: "cloudflare",
          resourceKind: "source-archive",
          resourceIdentityDigest: createHash("sha256")
            .update(`cloudflare\0source-archive\0${sourceIdentity}`)
            .digest(),
        },
        {
          provider: "cloudflare",
          resourceKind: "build-artifact",
          resourceIdentityDigest: createHash("sha256")
            .update(`cloudflare\0build-artifact\0${artifactIdentity}`)
            .digest(),
        },
      ],
    });
    const candidate = {
      candidateReceiptId: ids.sourceConnectionId,
      operationId: ids.operationId,
      receipt: wfpReceipt,
      previousGateway: gatewayReceipt,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      runtimeSecretDeliveryStage: { stageReceiptId: ids.eventId },
      deploymentUrl: gatewayReceipt.publicOrigin,
      artifactDigest: digest,
    };
    expect(
      await reject({
        workflowId,
        executionId: workflowId,
        command: deploy as never,
        candidate,
        candidateEvidence: null,
        activation: null,
        activationAttempted: false,
      }),
    ).toMatchObject({ status: "failed" });
    expect(env.RUNTIME_SECRET_DELIVERY.removeCandidate).toHaveBeenCalledOnce();
    expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledOnce();
    expect(env.BUILD_RUNNER.removeBuildArtifactObject).toHaveBeenCalledOnce();
    expect(database.recordWfpCandidateCleanupReceipt).toHaveBeenCalled();
    // A revoked grant cannot authorize new writes; its operation's immutable archive still
    // supplies custody so an already-staged candidate can be recorded and removed.
    database.readProductWorkflowContext.mockResolvedValue({
      ...current,
      sourceGrant: null,
    } as never);
    const custody = {
      provider: "managed",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      operationId: ids.operationId,
      billingEpochId: ids.billingEpochId,
      sourceConnectionId: ids.sourceConnectionId,
      externalRepositoryId: "managed/owned-repository",
      requestedCommitSha: "a".repeat(40),
      resolvedCommitSha: "a".repeat(40),
      sha256: Buffer.from(hex, "hex"),
    };
    database.observeSourceArchiveReceipt.mockResolvedValue(custody as never);
    await expect(
      ports.persistence.recordCandidate({
        workflowId,
        executionId: workflowId,
        command: deploy,
        candidate: { ...candidate, candidateReceiptId: null },
        evidence: { archive, build: buildReceipt, artifact: artifactReference },
      }),
    ).resolves.toMatchObject({ persistence: "applied" });
    expect(database.recordProductDeploymentEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "managed",
        externalRepositoryId: custody.externalRepositoryId,
      }),
    );
    database.observeSourceArchiveReceipt.mockResolvedValue({
      ...custody,
      sha256: Buffer.alloc(32),
    } as never);
    await expect(
      ports.persistence.recordCandidate({
        workflowId,
        executionId: workflowId,
        command: deploy,
        candidate: { ...candidate, candidateReceiptId: null },
        evidence: { archive, build: buildReceipt, artifact: artifactReference },
      }),
    ).rejects.toThrow("evidence changed");
    database.readProductWorkflowContext.mockResolvedValue(current);
    database.failProductDeploymentCommand.mockClear();
    env.WFP_MANAGEMENT.observeActivation.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "gateway",
      currentProviderTag: null,
      currentProductDeploymentId: null,
    } as never);
    expect(
      await reject({
        workflowId,
        executionId: workflowId,
        command: deploy as never,
        candidate,
        candidateEvidence: null,
        activation: null,
        activationAttempted: true,
      }),
    ).toMatchObject({ status: "uncertain" });
    expect(database.failProductDeploymentCommand).not.toHaveBeenCalled();
  });

  it("deletes only frozen managed repository and staging identities after the project tombstone", async () => {
    const env = bindings(),
      deletion = command("ProjectDeletionRequestedV1"),
      base = contextFor("ProjectDeletionRequestedV1");
    const repository = {
      sourceConnectionId: ids.sourceConnectionId,
      namespace: "managed",
      repositoryName: `${ids.projectId.toLowerCase()}-repository`,
    };
    const blob = {
      path: "package.json",
      sha256: "a".repeat(64),
      byteLength: 2,
      executable: false,
      bucket: "ohmyho-builds-development",
      key: `managed-staging/${ids.operationId}/${ids.organizationId}/${ids.projectId}/${"a".repeat(64)}`,
      versionId: "b".repeat(32),
      eTag: `"${"c".repeat(32)}"`,
    };
    const repositoryInventory = deletionInventoryRecord(
        "cloudflare",
        "managed-source-repository",
        `artifacts:${repository.namespace}/${repository.repositoryName}`,
      ),
      blobInventory = deletionInventoryRecord(
        "cloudflare",
        "managed-source-blob",
        `${blob.bucket}/${blob.key}/${blob.versionId}`,
      );
    database.readManagedSourceDeletionInventory.mockResolvedValue({
      repos: [repository],
      blobOperations: [{ operationId: ids.operationId, blobs: [blob] }],
    } as never);
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      deletionInventory: [...base.deletionInventory, repositoryInventory, blobInventory],
    });
    const ports = createDeploymentWorkflowPorts(env);
    expect(await ports.wfp.cleanupInventory(deletion)).toEqual({
      status: "observed",
      inventoryClean: true,
    });
    expect(env.SOURCE_FETCHER.managedGit).toHaveBeenCalledWith(
      "deleteRepository",
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        operationId: ids.operationId,
        repository: { namespace: repository.namespace, repositoryName: repository.repositoryName },
      }),
    );
    expect(env.SOURCE_FETCHER.managedBlob).toHaveBeenCalledWith(
      "deleteOperation",
      expect.objectContaining({ operationId: ids.operationId, blobs: [blob], region: "us" }),
    );
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceKind: "managed-source-repository", outcome: "not_found" }),
    );
    env.SOURCE_FETCHER.managedGit.mockClear();
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      deletionInventory: [...base.deletionInventory, blobInventory],
    });
    await expect(ports.wfp.cleanupInventory(deletion)).rejects.toThrow("frozen deletion inventory");
    expect(env.SOURCE_FETCHER.managedGit).not.toHaveBeenCalled();
  });

  it("records Native deletion only after the private manager proves its exact frozen resources absent", async () => {
    const env = bindings(),
      base = contextFor("ProjectDeletionRequestedV1"),
      databaseId = "a1234567890123456789",
      ref = `${ids.projectId}:${ids.environmentId}`;
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      deletionInventory: [
        ...base.deletionInventory,
        deletionInventoryRecord("pgcf", "native-auth-database", databaseId),
        deletionInventoryRecord("ohmyhost", "native-auth-registry", ref),
      ],
    });
    env.NEON_MANAGEMENT.deleteNativeAuthProject
      .mockResolvedValueOnce({ status: "reconciliation_required" })
      .mockResolvedValueOnce({ status: "absent", databaseId, registries: [ref] });
    const ports = createDeploymentWorkflowPorts(env),
      deletion = command("ProjectDeletionRequestedV1");
    expect(await ports.wfp.cleanupInventory(deletion)).toEqual({ status: "uncertain" });
    expect(await ports.wfp.cleanupInventory(deletion)).toEqual({
      status: "observed",
      inventoryClean: true,
    });
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "pgcf",
        resourceKind: "native-auth-database",
        outcome: "not_found",
      }),
    );
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "ohmyhost",
        resourceKind: "native-auth-registry",
        outcome: "not_found",
      }),
    );
  });

  it("retires only the exact frozen Native restore pin and records verified absence", async () => {
    const env = bindings(),
      base = contextFor("ProjectDeletionRequestedV1"),
      restoreId = ids.targetRevisionId;
    const locator = `ohmyho-development-backups/restore-pins/${ids.organizationId}/${ids.projectId}/${restoreId}.zip`;
    const pin = deletionInventoryRecord("cloudflare", "native-auth-restore-pin", locator);
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      deletionInventory: [...base.deletionInventory, pin],
    });
    const invokeRecovery = vi
      .fn()
      .mockResolvedValueOnce({ status: "absent", restoreId: ids.eventId })
      .mockResolvedValueOnce({ status: "absent", restoreId });
    Object.assign(env.RECOVERY_INVOKER, { invokeRecovery });
    const ports = createDeploymentWorkflowPorts(env),
      deletion = command("ProjectDeletionRequestedV1");
    await expect(ports.wfp.cleanupInventory(deletion)).rejects.toThrow(
      "Native restore pin cleanup absence is unverified",
    );
    expect(database.recordCleanupAttempt).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceKind: "native-auth-restore-pin" }),
    );
    await expect(ports.wfp.cleanupInventory(deletion)).resolves.toEqual({
      status: "observed",
      inventoryClean: true,
    });
    expect(invokeRecovery).toHaveBeenCalledWith({
      action: "purge-restore-pin",
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      operationId: ids.operationId,
      restoreId,
    });
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "cloudflare",
        resourceKind: "native-auth-restore-pin",
        outcome: "not_found",
      }),
    );
    const calls = invokeRecovery.mock.calls.length;
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      deletionInventory: [...base.deletionInventory, { ...pin, cleanupOutcome: "not_found" }],
    });
    await expect(ports.wfp.cleanupInventory(deletion)).resolves.toEqual({
      status: "observed",
      inventoryClean: true,
    });
    expect(invokeRecovery).toHaveBeenCalledTimes(calls);
  });

  it("completes and replays deletion when source inventory exists without any WFP", async () => {
    const completedAt = "2026-08-19T12:05:00.000Z";
    const base = contextFor("ProjectDeletionRequestedV1");
    const withoutWfp = {
      ...base,
      knownDeployments: [],
      activeDeploymentId: null,
      activeDeployment: null,
      activeGateway: null,
      deletionEnvironments: base.deletionEnvironments.map((environment) => ({
        ...environment,
        activeDeploymentId: null,
        activeRevisionId: null,
        activeDeployment: null,
        activeGateway: null,
      })),
      deletionInventory: base.deletionInventory.filter(
        ({ provider, resourceKind }) =>
          provider !== "cloudflare" ||
          resourceKind === "build-artifact" ||
          resourceKind === "source-object",
      ),
    };
    database.readProductWorkflowContext.mockResolvedValue(withoutWfp);
    database.readWfpProjectDeletionEvidence.mockResolvedValue({
      candidates: [],
      activeGateways: [],
    });
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env, () => new Date(completedAt));
    const deletion = command("ProjectDeletionRequestedV1");
    const receiptId = `wfp:absent:${ids.projectId}:${[ids.environmentId, ids.sourceEnvironmentId]
      .sort()
      .join(",")}`;

    const first = await ports.wfp.tombstone(deletion);
    const replay = await ports.wfp.tombstone(deletion);
    expect(first).toEqual({
      status: "observed",
      tombstoneReceiptId: receiptId,
      consecutive404s: 3,
    });
    expect(replay).toEqual(first);
    if (first.status !== "observed") throw new Error("Expected absence tombstone");
    await expect(
      ports.persistence.retainDeletionTombstone({
        workflowId: "product-workflow-delete-absent",
        executionId: "product-workflow-delete-absent",
        command: deletion,
        tombstoneReceiptId: first.tombstoneReceiptId,
      }),
    ).resolves.toBe("applied");
    await expect(ports.wfp.cleanupInventory(deletion)).resolves.toEqual({
      status: "observed",
      inventoryClean: true,
    });
    await expect(ports.wfp.observeRoute404(deletion, first)).resolves.toEqual({
      status: "observed",
      consecutive404s: 3,
    });
    const finalized = await ports.wfp.finalizeRemoval(deletion);
    expect(finalized).toEqual({
      status: "observed",
      consecutive404s: 3,
      gatewayAbsence: [null, null],
    });
    await expect(
      ports.persistence.complete({
        workflowId: "product-workflow-delete-absent",
        executionId: "product-workflow-delete-absent",
        command: deletion,
        evidence: {
          tombstoneReceiptId: first.tombstoneReceiptId,
          inventoryClean: true,
          consecutive404s: 3,
          gatewayAbsence: [null, null],
        },
      }),
    ).resolves.toBe("applied");
    expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledOnce();
    expect(env.WFP_MANAGEMENT.finalizeRemoval).not.toHaveBeenCalled();
    expect(lifecycleRecorders.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        command: deletion,
        evidence: expect.objectContaining({ gatewayAbsence: [null, null] }),
      }),
    );
  });

  it("removes the project's environment schedules before project cleanup", async () => {
    database.deleteProjectFunctionSchedules.mockResolvedValueOnce(2);
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env, () => new Date("2026-08-25T21:00:00.000Z"));
    const deletion = command("ProjectDeletionRequestedV1");

    await expect(ports.schedules.remove(deletion)).resolves.toEqual({ removed: 2 });
    expect(database.deleteProjectFunctionSchedules).toHaveBeenCalledWith(expect.anything(), {
      organizationId: deletion.organizationId,
      projectId: deletion.projectId,
    });
  });

  it("removes a non-active deletion candidate through its persisted runtime-secret stage", async () => {
    const context = contextFor("ProjectDeletionRequestedV1");
    database.readProductWorkflowContext.mockResolvedValue(context);
    database.readWfpProjectDeletionEvidence.mockResolvedValueOnce({
      activeGateways: [],
      candidates: [
        {
          candidateReceiptId: ids.eventId,
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          operationId: ids.operationId,
          productDeploymentId: ids.deploymentId,
          artifactId: ids.operationId,
          namespace: wfpReceipt.namespace,
          immutableScriptName: wfpReceipt.scriptName,
          artifactDigest: Buffer.from(hex, "hex"),
          providerTag: wfpReceipt.providerTag,
          buildReused: false,
          stagedAt: deployedAt,
        },
        {
          candidateReceiptId: ids.sourceConnectionId,
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
          operationId: ids.targetRevisionId,
          productDeploymentId: ids.targetDeploymentId,
          artifactId: ids.sourceRevisionId,
          namespace: "sandbox",
          immutableScriptName: `p-${ids.projectId.toLowerCase()}-dev-${ids.targetDeploymentId.toLowerCase()}`,
          artifactDigest: Buffer.from(hex, "hex"),
          providerTag: "f".repeat(32),
          buildReused: true,
          stagedAt: deployedAt,
        },
      ],
    } as never);
    const env = bindings();
    const observedAt = "2026-09-13T08:00:00.000Z";
    const ports = createDeploymentWorkflowPorts(env, () => new Date(observedAt));

    await expect(ports.wfp.tombstone(command("ProjectDeletionRequestedV1"))).resolves.toMatchObject(
      { status: "observed" },
    );

    expect(env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate).toHaveBeenCalledWith({
      scope: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        environmentName: "dev",
        handle: "calm-otter-builds",
        // The deletion operation removes it, authorized by the deletion's cleanup run.
        operationId: ids.operationId,
      },
      candidateReceiptId: ids.sourceConnectionId,
      claimId: ids.eventId,
      candidate: expect.objectContaining({
        productDeploymentId: ids.targetDeploymentId,
        providerTag: "f".repeat(32),
      }),
    });
    expect(env.RUNTIME_SECRET_DELIVERY.removePersistedCandidate).toHaveBeenCalledTimes(2);
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "cloudflare",
        resourceKind: "wfp-script",
        attemptedAt: observedAt,
      }),
    );
  });

  it("removes both dev and prod gateways, completes both heads, and replays deletion without mutation", async () => {
    const prodReceipt = {
      ...wfpReceipt,
      scriptName: `p-${ids.projectId.toLowerCase()}-prod`,
      environmentId: ids.sourceEnvironmentId,
      productDeploymentId: ids.targetDeploymentId,
      providerTag: "prod-provider-tag",
      buildReused: true,
    } as const;
    const prodGateway = {
      ...gatewayReceipt,
      targetScriptName: `p-${ids.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
      environmentId: ids.sourceEnvironmentId,
      environmentName: "prod" as const,
      hostname: "calm-otter-builds.ohmyho.st",
      publicOrigin: "https://calm-otter-builds.ohmyho.st",
    } as const;
    const prodAbsence = {
      ...prodGateway,
      active: false,
      revision: 2,
      predecessorRevision: 1,
    } as const;
    const activeContext = {
      ...contextFor("ProjectDeletionRequestedV1"),
      deletionInventory: [
        ...contextFor("ProjectDeletionRequestedV1").deletionInventory,
        deletionInventoryRecord(
          "cloudflare",
          "wfp-script",
          `${prodReceipt.namespace}/${prodReceipt.scriptName}`,
        ),
      ],
      deletionEnvironments: [
        contextFor("ProjectDeletionRequestedV1").deletionEnvironments[0],
        {
          environmentId: ids.sourceEnvironmentId,
          environmentName: "prod" as const,
          headVersion: 4,
          activeDeploymentId: ids.targetDeploymentId,
          activeRevisionId: ids.sourceRevisionId,
          activeDeployment: prodReceipt,
          activeGateway: prodGateway,
          environmentSecretCount: 2,
          artifactExpectations: [],
          deletionBuildArtifacts: [],
          sourceArchives: [],
          r2Bucket: null,
          neonPlacement: null,
          databaseRegistration: null,
        },
      ],
    };
    database.readProductWorkflowContext.mockResolvedValue(activeContext);
    const env = bindings();
    env.WFP_MANAGEMENT.remove.mockImplementation(async (input: unknown) => {
      const scope = (input as { scope: { environmentName: "dev" | "prod" } }).scope;
      return {
        status: "tombstoned",
        receipt: { providerTag: `${scope.environmentName}-tombstone` },
      };
    });
    env.WFP_MANAGEMENT.finalizeRemoval.mockImplementation((async (input: unknown) => {
      const scope = (input as { scope: { environmentName: "dev" | "prod" } }).scope;
      return {
        status: "removed",
        gateway: scope.environmentName === "dev" ? gatewayAbsence : prodAbsence,
        consecutive404s: 3,
      };
    }) as never);
    const ports = createDeploymentWorkflowPorts(env);
    const deletion = command("ProjectDeletionRequestedV1");

    await expect(ports.wfp.cleanupInventory(deletion)).resolves.toEqual({
      status: "observed",
      inventoryClean: true,
    });
    const tombstone = await ports.wfp.tombstone(deletion);
    expect(tombstone).toEqual({
      status: "observed",
      tombstoneReceiptId: "dev:removed|prod:removed",
      consecutive404s: 3,
    });
    const finalized = await ports.wfp.finalizeRemoval(deletion);
    expect(finalized).toEqual({
      status: "observed",
      consecutive404s: 3,
      gatewayAbsence: [gatewayAbsence, prodAbsence],
    });
    if (tombstone.status !== "observed" || finalized.status !== "observed") {
      throw new Error("Expected complete deletion evidence");
    }
    await expect(
      ports.persistence.complete({
        workflowId: "product-workflow-delete-both",
        executionId: "product-workflow-delete-both",
        command: deletion,
        evidence: {
          tombstoneReceiptId: tombstone.tombstoneReceiptId,
          inventoryClean: true,
          consecutive404s: 3,
          gatewayAbsence: finalized.gatewayAbsence,
        },
      }),
    ).resolves.toBe("applied");
    expect(env.WFP_MANAGEMENT.remove).not.toHaveBeenCalled();
    expect(env.WFP_MANAGEMENT.finalizeRemoval).toHaveBeenCalledTimes(4);
    expect(database.recordCleanupAttempt).toHaveBeenCalledTimes(
      activeContext.deletionInventory.length,
    );
    const recordedHashes = database.recordCleanupAttempt.mock.calls.map((call) =>
      Buffer.from(
        (call as unknown as readonly [unknown, { externalRefHash: Uint8Array }])[1].externalRefHash,
      ).toString("hex"),
    );
    expect(recordedHashes.sort()).toEqual(
      activeContext.deletionInventory
        .map((record) => Buffer.from(record.externalRefHash).toString("hex"))
        .sort(),
    );
    expect(lifecycleRecorders.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        command: deletion,
        evidence: expect.objectContaining({ gatewayAbsence: finalized.gatewayAbsence }),
      }),
    );

    database.readProductWorkflowContext.mockResolvedValue({
      ...activeContext,
      deletionEnvironments: activeContext.deletionEnvironments.map((environment) => {
        if (environment === undefined) throw new Error("Missing deletion environment");
        return {
          ...environment,
          headVersion: environment.headVersion + 1,
          activeDeploymentId: null,
          activeRevisionId: null,
          activeDeployment: null,
          activeGateway: null,
          environmentSecretCount: 0,
        };
      }),
    });
    await expect(ports.wfp.tombstone(deletion)).resolves.toEqual({
      status: "observed",
      tombstoneReceiptId: `wfp:absent:${ids.projectId}:${[
        ids.environmentId,
        ids.sourceEnvironmentId,
      ]
        .sort()
        .join(",")}`,
      consecutive404s: 3,
    });
    expect(env.WFP_MANAGEMENT.remove).not.toHaveBeenCalled();
    expect(env.WFP_MANAGEMENT.finalizeRemoval).toHaveBeenCalled();
  });

  it("deletes Prod-only and historical Dev scopes without fabricating environment evidence", async () => {
    const base = contextFor("ProjectDeletionRequestedV1"),
      prod = base.deletionEnvironments.find(
        (environment) => environment.environmentName === "prod",
      );
    if (!prod) throw new Error("The deletion fixture must have Prod");
    const prodReceipt = {
        ...wfpReceipt,
        environmentId: ids.sourceEnvironmentId,
        scriptName: prodGatewayAbsence.targetScriptName,
      },
      prodGateway = { ...prodGatewayAbsence, active: true, revision: 1, predecessorRevision: null },
      current = {
        ...base,
        environmentName: "prod" as const,
        activeDeploymentId: ids.deploymentId,
        activeDeployment: prodReceipt,
        activeGateway: prodGateway,
        knownDeployments: [prodReceipt],
        deletionEnvironments: [
          {
            ...prod,
            headVersion: 4,
            activeDeploymentId: ids.deploymentId,
            activeRevisionId: ids.sourceRevisionId,
            activeDeployment: prodReceipt,
            activeGateway: prodGateway,
          },
        ],
        deletionInventory: [
          deletionInventoryRecord(
            "cloudflare",
            "wfp-script",
            `${prodReceipt.namespace}/${prodReceipt.scriptName}`,
          ),
          deletionInventoryRecord("ohmyhost", "gateway-route", ids.sourceEnvironmentId),
        ],
      };
    database.readProductWorkflowContext.mockResolvedValue(current);
    database.readWfpProjectDeletionEvidence.mockResolvedValue({
      candidates: [],
      activeGateways: [prodGateway],
    } as never);
    const env = bindings();
    env.WFP_MANAGEMENT.finalizeRemoval.mockResolvedValue({
      status: "removed",
      gateway: prodGatewayAbsence,
      consecutive404s: 3,
    } as never);
    const ports = createDeploymentWorkflowPorts(env),
      deletion = {
        ...command("ProjectDeletionRequestedV1"),
        environmentId: parseUlid(ids.sourceEnvironmentId),
      };
    await expect(ports.wfp.cleanupInventory(deletion)).resolves.toEqual({
      status: "observed",
      inventoryClean: true,
    });
    const tombstone = await ports.wfp.tombstone(deletion);
    expect(tombstone).toEqual({
      status: "observed",
      tombstoneReceiptId: "prod:removed",
      consecutive404s: 3,
    });
    const finalized = await ports.wfp.finalizeRemoval(deletion);
    expect(finalized).toEqual({
      status: "observed",
      consecutive404s: 3,
      gatewayAbsence: [prodGatewayAbsence],
    });
    if (tombstone.status !== "observed" || finalized.status !== "observed")
      throw new Error("Expected exact Prod-only absence evidence");
    await expect(
      ports.persistence.complete({
        workflowId: "product-workflow-delete-prod-only",
        executionId: "product-workflow-delete-prod-only",
        command: deletion,
        evidence: {
          tombstoneReceiptId: tombstone.tombstoneReceiptId,
          inventoryClean: true,
          consecutive404s: 3,
          gatewayAbsence: finalized.gatewayAbsence,
        },
      }),
    ).resolves.toBe("applied");
    expect(env.WFP_MANAGEMENT.finalizeRemoval).toHaveBeenCalledTimes(2);
    for (const [input] of env.WFP_MANAGEMENT.finalizeRemoval.mock.calls)
      expect(input).toMatchObject({
        scope: {
          projectId: ids.projectId,
          environmentId: ids.sourceEnvironmentId,
          environmentName: "prod",
        },
      });
    expect(lifecycleRecorders.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        command: deletion,
        evidence: expect.objectContaining({ gatewayAbsence: [prodGatewayAbsence] }),
      }),
    );
    expect(database.recordCleanupAttempt).toHaveBeenCalledTimes(2);
    database.readProductWorkflowContext.mockResolvedValue({
      ...current,
      deletionEnvironments: base.deletionEnvironments.slice(0, 1),
    });
    await expect(ports.wfp.tombstone(deletion)).rejects.toThrow(
      "Deletion Workflow requires unique dev environments followed by prod",
    );
    expect(env.WFP_MANAGEMENT.finalizeRemoval).toHaveBeenCalledTimes(2);
    const dev = base.deletionEnvironments.find(
        (environment) => environment.environmentName === "dev",
      ),
      activeProd = current.deletionEnvironments[0];
    if (!dev || !activeProd)
      throw new Error("The historical deletion fixture must have Dev and Prod");
    const quietDev = {
        ...dev,
        activeDeploymentId: null,
        activeRevisionId: null,
        activeDeployment: null,
        activeGateway: null,
        artifactExpectations: [],
        sourceArchives: [],
        deletionBuildArtifacts: [],
      },
      historicalDev = {
        ...quietDev,
        environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB8"),
        headVersion: 2,
      };
    // Core supplies this historical role only after checking its immutable restoration proof.
    database.readProductWorkflowContext.mockResolvedValue({
      ...current,
      deletionEnvironments: [historicalDev, quietDev, activeProd],
    });
    await expect(ports.wfp.cleanupInventory(deletion)).resolves.toEqual({
      status: "observed",
      inventoryClean: true,
    });
    await expect(ports.wfp.tombstone(deletion)).resolves.toEqual({
      status: "observed",
      tombstoneReceiptId: "prod:removed",
      consecutive404s: 3,
    });
    await expect(ports.wfp.finalizeRemoval(deletion)).resolves.toEqual({
      status: "observed",
      consecutive404s: 3,
      gatewayAbsence: [null, null, prodGatewayAbsence],
    });
    expect(env.WFP_MANAGEMENT.finalizeRemoval).toHaveBeenCalledTimes(4);
    for (const [input] of env.WFP_MANAGEMENT.finalizeRemoval.mock.calls)
      expect(input).toMatchObject({
        scope: { environmentId: ids.sourceEnvironmentId, environmentName: "prod" },
      });
  });

  it("includes the exact source archive in delete cleanup when the build never produced an artifact", async () => {
    const base = contextFor("ProjectDeletionRequestedV1");
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      artifactExpectations: [],
      deletionEnvironments: base.deletionEnvironments.map((environment, index) => ({
        ...environment,
        artifactExpectations: [],
        deletionBuildArtifacts: [],
        sourceArchives: index === 0 ? [archive.archive] : [],
      })),
      deletionInventory: [
        deletionInventoryRecord(
          "cloudflare",
          "source-object",
          `${archive.archive.bucket}/${archive.archive.key}/${archive.archive.versionId}`,
        ),
      ],
    });
    const env = bindings();
    let observedAt = "2026-09-13T08:00:00.000Z";
    const ports = createDeploymentWorkflowPorts(env, () => new Date(observedAt));

    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledOnce();
    expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledWith(archive.archive);
    expect(env.BUILD_RUNNER.removeBuildArtifactObject).not.toHaveBeenCalled();
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "cloudflare",
        resourceKind: "source-object",
        outcome: "not_found",
        attemptedAt: observedAt,
      }),
    );
    const attempts = database.recordCleanupAttempt.mock.calls as unknown as Array<
      [unknown, { cleanupAttemptId: string; attemptedAt: string; outcome: string }]
    >;
    const first = attempts.at(-1)?.[1];
    await ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"));
    expect(attempts.at(-1)?.[1]).toEqual(first);
    observedAt = "2026-09-13T08:01:00.000Z";
    await ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"));
    const latest = attempts.at(-1)?.[1];
    expect(latest).toMatchObject({ attemptedAt: observedAt, outcome: "not_found" });
    expect(latest?.cleanupAttemptId).not.toBe(first?.cleanupAttemptId);
  });

  it("deletes exact Cloudflare-domain and SES mail inventory before reporting clean", async () => {
    const scenario = mailDeletionScenario();
    const exportId = "00000000000000000000009000";
    const locator = `ohmyho-development-backups/snapshots/${ids.organizationId}/${ids.projectId}/${exportId}.zip`;
    const context = {
      ...scenario.context,
      deletionInventory: [
        ...scenario.context.deletionInventory,
        deletionInventoryRecord("cloudflare", "sql-export", locator),
      ],
    };
    database.readProductWorkflowContext.mockResolvedValue(context);
    const env = bindings();
    env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject.mockResolvedValueOnce({
      outcome: "deleted",
      operationId: ids.operationId,
      receipts: [
        {
          receiptId: scenario.domainReceiptId,
          kind: "dns_record",
          providerResourceId: "a".repeat(32),
          outcome: "deleted",
        },
      ],
      oauthGrant: "revoked",
      observedAt: deployedAt,
    } as never);
    env.SES_MANAGEMENT.deleteMailProject.mockResolvedValueOnce({
      status: "deleted",
      projectId: ids.projectId,
      resourcesAbsent: true,
      cleanup: scenario.cleanup,
    } as never);
    const received: unknown[] = [];
    let purgeResult: unknown = { status: "ready", exportId };
    Object.assign(env.RECOVERY_INVOKER, {
      async invokeRecovery(input: unknown) {
        received.push(input);
        return purgeResult;
      },
    });
    const ports = createDeploymentWorkflowPorts(env);
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "SQL export cleanup absence is unverified",
    );
    expect(database.recordCleanupAttempt).not.toHaveBeenCalled();
    purgeResult = { status: "absent", exportId };

    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      operationId: ids.operationId,
    });
    expect(env.SES_MANAGEMENT.deleteMailProject).toHaveBeenCalledWith({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      operationId: ids.operationId,
    });
    expect(env.SES_MANAGEMENT.deleteMailProject.mock.invocationCallOrder[0]).toBeLessThan(
      env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject.mock.invocationCallOrder[0] ?? 0,
    );
    expect(database.recordCleanupAttempt).toHaveBeenCalledTimes(context.deletionInventory.length);
    expect(received).toEqual(
      [0, 1].map(() => ({
        action: "purge",
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        operationId: ids.operationId,
        exportId,
      })),
    );
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    expect(env.R2_MANAGEMENT.purgeAndDeleteBucket).not.toHaveBeenCalled();
  });

  it("accepts a retired receipt only with durable exact cleanup evidence and still rejects extra receipts", async () => {
    const scenario = mailDeletionScenario();
    const retired = deletionInventoryRecord("cloudflare", "domain-receipt", ids.sourceRevisionId);
    const env = bindings();
    env.SES_MANAGEMENT.deleteMailProject.mockResolvedValue({
      status: "deleted",
      projectId: ids.projectId,
      resourcesAbsent: true,
      cleanup: scenario.cleanup,
    } as never);
    const receipt = {
      receiptId: scenario.domainReceiptId,
      kind: "dns_record",
      providerResourceId: "a".repeat(32),
      outcome: "absent",
    };
    const response = {
      outcome: "absent",
      operationId: ids.operationId,
      receipts: [receipt],
      oauthGrant: "revoked",
      observedAt: deployedAt,
    };
    env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject.mockResolvedValue(response as never);
    const ports = createDeploymentWorkflowPorts(env);
    database.readProductWorkflowContext.mockResolvedValue({
      ...scenario.context,
      deletionInventory: [...scenario.context.deletionInventory, retired],
    });
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "Provider cleanup evidence does not match deletion inventory",
    );
    for (const cleanupOutcome of ["removed", "not_found"] as const) {
      database.readProductWorkflowContext.mockResolvedValue({
        ...scenario.context,
        deletionInventory: [...scenario.context.deletionInventory, { ...retired, cleanupOutcome }],
      });
      await expect(
        ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
      ).resolves.toEqual({
        status: "observed",
        inventoryClean: true,
      });
    }
    env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject.mockResolvedValue({
      ...response,
      receipts: [...response.receipts, { ...receipt, receiptId: ids.sourceConnectionId }],
    } as never);
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "Provider cleanup evidence does not match deletion inventory",
    );
  });

  it("refuses mail cleanup evidence that names the retired Route 53 provider", async () => {
    const scenario = mailDeletionScenario();
    database.readProductWorkflowContext.mockResolvedValue(scenario.context);
    const env = bindings();
    env.SES_MANAGEMENT.deleteMailProject.mockResolvedValue({
      status: "deleted",
      projectId: ids.projectId,
      resourcesAbsent: true,
      cleanup: [
        ...scenario.cleanup,
        {
          provider: "aws",
          resourceKind: "route53-hosted-zone",
          locator: "Z0123456789ABC",
          outcome: "removed",
        },
      ],
    } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "SES mail cleanup evidence is invalid",
    );
    expect(env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
  });

  it("stops cleanup when SES mail deletion is uncertain", async () => {
    const scenario = mailDeletionScenario();
    database.readProductWorkflowContext.mockResolvedValue(scenario.context);
    const env = bindings();
    env.SES_MANAGEMENT.deleteMailProject.mockRejectedValueOnce(
      new Error("SES mail deletion uncertain"),
    );
    const ports = createDeploymentWorkflowPorts(env);

    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "SES mail deletion uncertain",
    );
    expect(env.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    expect(env.R2_MANAGEMENT.purgeAndDeleteBucket).not.toHaveBeenCalled();
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
  });

  it.each(["shared", "isolated"] as const)(
    "cleans both environment inventories, private files, and %s databases",
    async (dataMode) => {
      const neonPlacement = {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        operationId: ids.operationId,
        claimId: ids.targetRevisionId,
        projectName: "ohmyho-project",
        regionId: "aws-eu-central-1",
        postgresVersion: 17 as const,
        providerProjectId: "quiet-snow-12345678",
        defaultBranchId: "br-green-river-12345678",
        operationIds: [ids.operationId],
        state: "ready" as const,
        observedAt: new Date(deployedAt),
      };
      const deletionContext = contextFor("ProjectDeletionRequestedV1");
      const devInventory = deletionContext.deletionEnvironments[0];
      if (devInventory === undefined) throw new Error("Missing dev inventory");
      const deletionEnvironments = deletionContext.deletionEnvironments.map((environment) => ({
        ...environment,
        artifactExpectations: devInventory.artifactExpectations,
        deletionBuildArtifacts: devInventory.deletionBuildArtifacts,
        sourceArchives: devInventory.sourceArchives,
        r2Bucket: {
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: environment.environmentId,
          operationId: ids.operationId,
          claimId: ids.targetRevisionId,
          bucketName: `ohmyho-${ids.projectId.toLowerCase()}-${environment.environmentId.toLowerCase()}`,
          bucketId: environment.environmentName === "dev" ? "1".repeat(32) : "2".repeat(32),
          jurisdiction: "eu" as const,
          storageClass: "Standard" as const,
          publicAccess: false as const,
          observedAt: new Date(deployedAt),
        },
        neonPlacement,
      }));
      const expectedDatabaseContext = withDatabaseResources(
        {
          ...contextFor("ProjectDeletionRequestedV1"),
          deletionEnvironments,
          deletionInventory: [
            ...contextFor("ProjectDeletionRequestedV1").deletionInventory,
            ...deletionEnvironments.map((environment) =>
              deletionInventoryRecord(
                "cloudflare",
                "r2-bucket",
                `ohmyho-${ids.projectId.toLowerCase()}-${environment.environmentId.toLowerCase()}`,
              ),
            ),
            deletionInventoryRecord("neon", "project", neonPlacement.providerProjectId),
          ],
        },
        dataMode,
      );
      database.readProductWorkflowContext.mockResolvedValue(expectedDatabaseContext);
      const env = bindings();
      env.NEON_MANAGEMENT.deleteProject.mockImplementation(async (input: unknown) => {
        const request = input as {
          physicalEnvironmentId: string;
          providerProjectId: string;
          registrationVersion: number;
        };
        const receipt = expectedDatabaseContext.deletionEnvironments
          .map((environment) => environment.databaseRegistration)
          .find(
            (registration) => registration?.physicalEnvironmentId === request.physicalEnvironmentId,
          );
        if (!receipt) throw new Error("Unknown fixture database");
        return {
          status: "ready",
          outcome: "already_absent",
          provider: "neon",
          providerProjectId: request.providerProjectId,
          absenceVerifiedAt: deployedAt,
          databaseRegistration: {
            ...receipt,
            operationId: ids.operationId,
            status: "revoked",
            registrationVersion: request.registrationVersion + 1,
          },
        };
      });
      env.R2_MANAGEMENT.purgeAndDeleteBucket.mockImplementation((async (receipt: unknown) => ({
        status: "absent",
        outcome: "deleted",
        receipt,
      })) as never);
      const ports = createDeploymentWorkflowPorts(env);

      await expect(
        ports.wfp.tombstone(command("ProjectDeletionRequestedV1")),
      ).resolves.toMatchObject({ status: "observed" });
      await expect(
        ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
      ).resolves.toEqual({ status: "observed", inventoryClean: true });
      await expect(
        ports.wfp.finalizeRemoval(command("ProjectDeletionRequestedV1")),
      ).resolves.toMatchObject({ status: "observed" });
      expect(env.BUILD_RUNNER.removeBuildArtifactObject).toHaveBeenCalledTimes(2);
      expect(env.BUILD_RUNNER.removeArchive).toHaveBeenCalledTimes(2);
      expect(env.R2_MANAGEMENT.purgeAndDeleteBucket).toHaveBeenCalledTimes(2);
      expect(env.NEON_MANAGEMENT.deleteProject).toHaveBeenCalledTimes(
        dataMode === "shared" ? 1 : 2,
      );
      expect(env.NEON_MANAGEMENT.deleteProject).toHaveBeenCalledWith({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        operationId: ids.operationId,
        providerProjectId: neonPlacement.providerProjectId,
        defaultBranchId: neonPlacement.defaultBranchId,
        physicalEnvironmentId: ids.environmentId,
        registrationVersion: 1,
      });
      expect(env.WFP_MANAGEMENT.finalizeRemoval.mock.invocationCallOrder[0]).toBeLessThan(
        env.NEON_MANAGEMENT.deleteProject.mock.invocationCallOrder[0] ?? 0,
      );
      expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: "ohmyhost",
          resourceKind: "database-registration",
          outcome: "removed",
        }),
      );
      expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: "neon",
          resourceKind: "project",
          outcome: "not_found",
          externalRefHash: expect.any(Uint8Array),
        }),
      );
    },
  );

  it("keeps inventory uncertain for a non-empty R2 bucket or uncertain Neon deletion", async () => {
    const base = contextFor("ProjectDeletionRequestedV1");
    const r2Bucket = {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operationId: ids.operationId,
      claimId: ids.targetRevisionId,
      bucketName: `ohmyho-${ids.projectId.toLowerCase()}-${ids.environmentId.toLowerCase()}`,
      bucketId: "3".repeat(32),
      jurisdiction: "eu" as const,
      storageClass: "Standard" as const,
      publicAccess: false as const,
      observedAt: new Date(deployedAt),
    };
    database.readProductWorkflowContext.mockResolvedValue({
      ...base,
      deletionEnvironments: base.deletionEnvironments.map((environment, index) => ({
        ...environment,
        artifactExpectations: [],
        deletionBuildArtifacts: [],
        sourceArchives: [],
        r2Bucket: index === 0 ? r2Bucket : null,
      })),
      deletionInventory: [deletionInventoryRecord("cloudflare", "r2-bucket", r2Bucket.bucketName)],
    });
    const env = bindings();
    env.R2_MANAGEMENT.purgeAndDeleteBucket.mockResolvedValueOnce({
      status: "reconciliation_required",
      reason: "bucket_not_empty",
    } as never);
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "uncertain" });
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "failed", errorCode: "R2_BUCKET_DELETION_UNCERTAIN" }),
    );

    vi.clearAllMocks();
    database.readProductWorkflowContext.mockResolvedValue(
      withDatabaseResources({
        ...base,
        deletionEnvironments: base.deletionEnvironments.map((environment) => ({
          ...environment,
          artifactExpectations: [],
          deletionBuildArtifacts: [],
          sourceArchives: [],
          r2Bucket: null,
          neonPlacement: {
            providerProjectId: "quiet-snow-12345678",
            defaultBranchId: "br-green-river-12345678",
          },
        })),
        deletionInventory: [
          deletionInventoryRecord("neon", "project", "quiet-snow-12345678"),
          deletionInventoryRecord(
            "cloudflare",
            "project-database-worker",
            `d-${ids.projectId.toLowerCase()}`,
          ),
          deletionInventoryRecord(
            "cloudflare",
            "hyperdrive-configuration",
            "1234567890abcdef1234567890abcdef",
          ),
        ],
      }),
    );
    env.NEON_MANAGEMENT.deleteProject.mockResolvedValueOnce({
      status: "reconciliation_required",
      reason: "provider_uncertain",
      phase: "neon",
      databaseRegistration: { ...databaseRegistration, status: "revoked", registrationVersion: 2 },
    } as never);
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "uncertain" });
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "neon",
        outcome: "failed",
        errorCode: "NEON_PROJECT_DELETION_UNCERTAIN",
      }),
    );

    vi.clearAllMocks();
    database.readProductWorkflowContext.mockResolvedValue(
      withDatabaseResources({
        ...base,
        deletionEnvironments: base.deletionEnvironments.map((environment) => ({
          ...environment,
          artifactExpectations: [],
          deletionBuildArtifacts: [],
          sourceArchives: [],
          r2Bucket: null,
          neonPlacement: {
            providerProjectId: "quiet-snow-12345678",
            defaultBranchId: "br-green-river-12345678",
          },
        })),
        deletionInventory: [
          deletionInventoryRecord("neon", "project", "quiet-snow-12345678"),
          deletionInventoryRecord(
            "cloudflare",
            "project-database-worker",
            `d-${ids.projectId.toLowerCase()}`,
          ),
          deletionInventoryRecord(
            "cloudflare",
            "hyperdrive-configuration",
            "1234567890abcdef1234567890abcdef",
          ),
        ],
      }),
    );
    env.NEON_MANAGEMENT.deleteProject.mockResolvedValueOnce({
      status: "reconciliation_required",
      reason: "provider_uncertain",
      phase: "database",
    } as never);
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "uncertain" });
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "ohmyhost",
        resourceKind: "database-registration",
        outcome: "failed",
        errorCode: "DATABASE_REGISTRATION_REVOCATION_UNCERTAIN",
      }),
    );
    expect(
      (
        database.recordCleanupAttempt.mock.calls as unknown as readonly [
          unknown,
          { readonly provider: string },
        ][]
      ).some(([, attempt]) => attempt.provider === "neon"),
    ).toBe(false);
  });

  it("reconciles provider absence when the database has no active gateway receipt", async () => {
    database.readProductWorkflowContext.mockResolvedValueOnce({
      ...contextFor("ProjectDeletionRequestedV1"),
      activeGateway: null,
      deletionEnvironments: contextFor("ProjectDeletionRequestedV1").deletionEnvironments.map(
        (environment) =>
          environment.environmentName === "dev"
            ? { ...environment, activeGateway: null }
            : environment,
      ),
    });
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);

    await expect(ports.wfp.tombstone(command("ProjectDeletionRequestedV1"))).resolves.toMatchObject(
      {
        status: "observed",
      },
    );
    expect(env.WFP_MANAGEMENT.remove).not.toHaveBeenCalled();
  });

  it("revokes a registered database before deleting Neon even without an active application", async () => {
    const base = contextFor("ProjectDeletionRequestedV1");
    database.readProductWorkflowContext.mockResolvedValue(
      withDatabaseResources({
        ...base,
        activeDeploymentId: null,
        activeDeployment: null,
        activeGateway: null,
        deletionEnvironments: base.deletionEnvironments.map((environment) => ({
          ...environment,
          activeDeploymentId: null,
          activeRevisionId: null,
          activeDeployment: null,
          activeGateway: null,
          wfpDeployments: [],
          artifactExpectations: [],
          deletionBuildArtifacts: [],
          sourceArchives: [],
        })),
        deletionInventory: [],
      }),
    );
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(env.NEON_MANAGEMENT.deleteProject).toHaveBeenCalledOnce();
    expect(env.WFP_MANAGEMENT.finalizeRemoval).not.toHaveBeenCalled();
    expect(database.recordCleanupAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "ohmyhost",
        resourceKind: "database-registration",
        outcome: "removed",
      }),
    );
    const scoped = await database.readProductWorkflowContext(
      {},
      command("ProjectDeletionRequestedV1"),
    );
    const surviving = scoped.deletionDataEnvironments[0];
    const historicalRegistration = {
      ...surviving.databaseRegistration,
      operationId: ids.targetDeploymentId,
      physicalEnvironmentId: ids.targetRevisionId,
      originUser: `ohmyho_rw_${ids.targetRevisionId.toLowerCase()}`,
      providerProjectId: "quiet-retired-12345678",
      branchId: "br-green-retired-12345678",
      registrationVersion: 2,
      status: "revoked",
    };
    const historical = {
      dataEnvironmentId: ids.targetRevisionId,
      databaseRegistration: historicalRegistration,
      neonPlacement: {
        ...surviving.neonPlacement,
        environmentId: ids.targetRevisionId,
        providerProjectId: historicalRegistration.providerProjectId,
        defaultBranchId: historicalRegistration.branchId,
      },
    };
    const all = {
      ...scoped,
      deletionDataEnvironments: [...scoped.deletionDataEnvironments, historical],
      deletionInventory: [
        ...scoped.deletionInventory,
        deletionInventoryRecord("ohmyhost", "database-registration", ids.targetRevisionId),
        deletionInventoryRecord("neon", "project", historicalRegistration.providerProjectId),
      ],
    };
    database.readProductWorkflowContext.mockResolvedValue(all);
    env.NEON_MANAGEMENT.deleteProject.mockImplementation(async (input: any) => {
      const expected = all.deletionDataEnvironments.find(
        (data: any) => data.dataEnvironmentId === input.physicalEnvironmentId,
      ).databaseRegistration;
      return {
        status: "ready",
        provider: "neon",
        providerProjectId: expected.providerProjectId,
        outcome: "already_absent",
        absenceVerifiedAt: deployedAt,
        databaseRegistration:
          expected.status === "revoked"
            ? expected
            : {
                ...expected,
                operationId: ids.operationId,
                status: "revoked",
                registrationVersion: expected.registrationVersion + 1,
              },
      };
    });
    await expect(
      ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1")),
    ).resolves.toEqual({ status: "observed", inventoryClean: true });
    expect(env.NEON_MANAGEMENT.deleteProject).toHaveBeenCalledWith(
      expect.objectContaining({
        physicalEnvironmentId: ids.targetRevisionId,
        providerProjectId: historicalRegistration.providerProjectId,
      }),
    );
  });

  it("rejects foreign registration scope and revocation evidence before marking inventory removed", async () => {
    const base = contextFor("ProjectDeletionRequestedV1");
    const scoped = withDatabaseResources({
      ...base,
      deletionEnvironments: base.deletionEnvironments.map((environment) => ({
        ...environment,
        artifactExpectations: [],
        deletionBuildArtifacts: [],
        sourceArchives: [],
      })),
      deletionInventory: [],
    });
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);
    database.readProductWorkflowContext.mockResolvedValue({
      ...scoped,
      deletionDataEnvironments: scoped.deletionDataEnvironments.map((data) => ({
        ...data,
        databaseRegistration: {
          ...data.databaseRegistration,
          organizationId: ids.sourceEnvironmentId,
        },
      })),
    });
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "database scope is invalid",
    );
    expect(env.NEON_MANAGEMENT.deleteProject).not.toHaveBeenCalled();
    database.readProductWorkflowContext.mockResolvedValue(scoped);
    env.NEON_MANAGEMENT.deleteProject.mockResolvedValueOnce({
      status: "ready",
      provider: "neon",
      providerProjectId: databaseRegistration.providerProjectId,
      outcome: "deleted",
      absenceVerifiedAt: deployedAt,
      databaseRegistration: {
        ...databaseRegistration,
        organizationId: ids.sourceEnvironmentId,
        status: "revoked",
        registrationVersion: 2,
      },
    } as never);
    await expect(ports.wfp.cleanupInventory(command("ProjectDeletionRequestedV1"))).rejects.toThrow(
      "Database revocation evidence is invalid",
    );
    expect(database.recordCleanupAttempt).not.toHaveBeenCalled();
  });

  it("replays one uncertain tombstone publication to observe a timeout-after-commit", async () => {
    const env = bindings();
    env.WFP_MANAGEMENT.remove
      .mockResolvedValueOnce({ status: "reconciliation_required" } as never)
      .mockResolvedValueOnce({ status: "tombstoned", receipt: null } as never);
    const ports = createDeploymentWorkflowPorts(env);

    await expect(ports.wfp.tombstone(command("ProjectDeletionRequestedV1"))).resolves.toEqual({
      status: "observed",
      tombstoneReceiptId: "dev:removed",
      consecutive404s: 3,
    });
    expect(env.WFP_MANAGEMENT.remove).not.toHaveBeenCalled();
    // The closed WFP reason survives only in the private Workflow step output, never as deletion reconciliation authority.
    for (const reason of ["stale_edge", "provider_conflict"]) {
      env.WFP_MANAGEMENT.finalizeRemoval.mockResolvedValueOnce({
        status: "reconciliation_required",
        reason,
        currentProviderTag: null,
      } as never);
      await expect(ports.wfp.tombstone(command("ProjectDeletionRequestedV1"))).resolves.toEqual({
        status: "uncertain",
        reason,
      });
      env.WFP_MANAGEMENT.finalizeRemoval.mockResolvedValueOnce({
        status: "reconciliation_required",
        reason,
        currentProviderTag: null,
      } as never);
      await expect(
        ports.wfp.finalizeRemoval(command("ProjectDeletionRequestedV1")),
      ).resolves.toEqual({
        status: "uncertain",
        reason,
      });
    }
    env.WFP_MANAGEMENT.finalizeRemoval.mockResolvedValueOnce({
      status: "reconciliation_required",
      reason: "private provider response",
    } as never);
    await expect(ports.wfp.tombstone(command("ProjectDeletionRequestedV1"))).resolves.toEqual({
      status: "uncertain",
    });
  });

  it("moves a published gateway to a chosen address and stores it only when it is free", async () => {
    database.readProductWorkflowContext.mockResolvedValue(
      contextFor("ProjectHandleChangeRequestedV1"),
    );
    const rename = command("ProjectHandleChangeRequestedV1");
    const env = bindings();
    const ports = createDeploymentWorkflowPorts(env);

    // Only environments with a published gateway move, and each carries the stored address so a
    // lost rename can be put back.
    const environments = await ports.persistence.readGatewayAddressMoves(rename);
    expect(environments).toEqual([
      {
        environmentId: ids.environmentId,
        environmentName: "dev",
        handle: "calm-otter-builds",
        publicOrigin: gatewayReceipt.publicOrigin,
      },
    ]);

    const first = environments[0];
    if (first === undefined) throw new Error("Expected one environment to move");
    await expect(ports.wfp.moveGatewayAddress(rename, first, "acme-shop")).resolves.toMatchObject({
      status: "moved",
      publicOrigin: new URL(gatewayReceipt.publicOrigin).origin,
    });
    // The provider rebuilds the module around the address it is given, not the stored one.
    expect(env.WFP_MANAGEMENT.activateCandidate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ environmentName: "dev", handle: "acme-shop" }),
      }),
    );

    const moved = [
      {
        environmentId: ids.environmentId,
        publicOrigin: new URL(gatewayReceipt.publicOrigin).origin,
      },
    ];
    const finalize = {
      workflowId: "product-workflow-rename",
      executionId: "product-workflow-rename",
      command: rename,
      moved,
      evidence: { requestedHandle: "acme-shop", environments: 1 },
    };
    await expect(ports.persistence.finalizeHandleChange(finalize)).resolves.toBe("applied");
    expect(lifecycleRecorders.finalizeHandleChange).toHaveBeenCalledWith(finalize);
    lifecycleRecorders.finalizeHandleChange.mockResolvedValueOnce("pending");
    env.NATIVE_AUTH_RESOURCE_RUNTIME.readDomainPolicySync.mockResolvedValue([
      {
        environmentId: ids.environmentId,
        region: "eu",
        configurationRevision: 2,
        revocationEpoch: 2,
        ownerEnabled: true,
        canonicalOrigin: null,
        registryVersion: 1,
      },
    ]);
    env.NATIVE_AUTH_ADMIN_EU.applyRealmPolicy.mockRejectedValueOnce(
      new Error("private unavailable"),
    );
    await expect(ports.persistence.finalizeHandleChange(finalize)).rejects.toThrow(
      "private unavailable",
    );
    expect(env.NATIVE_AUTH_RESOURCE_RUNTIME.ackDomainPolicySync).not.toHaveBeenCalled();
    lifecycleRecorders.finalizeHandleChange
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("applied");
    env.NATIVE_AUTH_ADMIN_EU.applyRealmPolicy.mockResolvedValueOnce({ outcome: "applied" });
    await expect(ports.persistence.finalizeHandleChange(finalize)).resolves.toBe("applied");
    expect(env.NATIVE_AUTH_RESOURCE_RUNTIME.ackDomainPolicySync).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationRevision: 2,
        revocationEpoch: 2,
        acknowledgement: "applied",
      }),
    );
  });
});
