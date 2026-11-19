import { createHash } from "node:crypto";
import type { ProductWorkflowStepPort } from "@ohmyhost/orchestrator";
import { newUlid } from "../../../control-store/src/catalog/common.js";

/** One failed step of the chain: the name the Workflow gave it and the error the Core or a provider raised. */
interface StepFailure {
  readonly step: string;
  readonly name: string;
  readonly message: string;
}

/**
 * A Workflow step port that runs each step for real and records its name. The Workflow turns any step failure
 * into a reconciliation, so the chain test asserts these recorded failures before it reads the result.
 * Step results are cloned to approximate Workflows persistence, so a value that cannot be persisted fails here.
 */
export function recordingStep() {
  const steps: string[] = [];
  const failures: StepFailure[] = [];
  const step = {
    async do<T>(name: string, _config: unknown, run: () => Promise<T>): Promise<T> {
      steps.push(name);
      try {
        return structuredClone(await run());
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push({ step: name, name: failure.name, message: failure.message });
        throw error;
      }
    },
    async sleep(name: string) {
      steps.push(name);
    },
  } as ProductWorkflowStepPort;
  return { step, steps, failures };
}

/** The private provider bindings with their exact method inventory (apps/project-provisioning-worker/src/bindings.ts). */
const INVENTORY = {
  SOURCE_FETCHER: [
    "acquireExact",
    "inspectExact",
    "validateRepositoryLink",
    "managedGit",
    "managedBlob",
  ],
  BUILD_RUNNER: [
    "startBuild",
    "readBuild",
    "readBuildArtifact",
    "removeBuildArtifact",
    "removeBuildArtifactObject",
    "removeArchive",
  ],
  RECOVERY_INVOKER: ["invokeRecovery"],
  NEXT_CACHE_RETIREMENT: ["retire"],
  RUNTIME_SECRET_DELIVERY: [
    "ensureCustomerAuthSecret",
    "ensureMailGatewayKey",
    "ensureStorageGatewayKey",
    "ensureAiGatewayKey",
    "ensureBrowserGatewayKey",
    "stageCandidate",
    "stagePromotionCandidate",
    "recordStagedCandidate",
    "recordActivatedCandidate",
    "prepareExistingCandidate",
    "activateCandidate",
    "observeActivation",
    "compensateActivation",
    "compensateGatewayActivation",
    "removeCandidate",
    "removePersistedCandidate",
    "reconcileRuntimeSecrets",
  ],
  NEON_MANAGEMENT: [
    "deleteNativeAuthProject",
    "placeNativeAuthDatabase",
    "prepareNativeAuthRealm",
    "placeProject",
    "migrateProject",
    "readRuntimeBinding",
    "deleteProject",
    "reauthorizeDataEnvironment",
    "revokeDataChangeAccess",
  ],
  NATIVE_AUTH_RESOURCE_RUNTIME: [
    "readProvisioningPolicy",
    "readPendingNativePolicySync",
    "completeNativePolicySync",
    "readDomainPolicySync",
    "ackDomainPolicySync",
    "beginHandleDomainRecovery",
    "completeHandleDomainRecovery",
  ],
  NATIVE_AUTH_ADMIN_US: ["applyRealmPolicy"],
  NATIVE_AUTH_ADMIN_EU: ["applyRealmPolicy"],
  R2_MANAGEMENT: ["ensureBucket", "readRuntimeBinding", "purgeAndDeleteBucket"],
  STORAGE_DATA_MANAGEMENT: ["purgeRetiredData"],
  SES_MANAGEMENT: ["ensureMailDomain", "deleteMailProject"],
  CLOUDFLARE_DOMAIN_MANAGEMENT: ["ensureEnvironment", "deleteProject"],
  WFP_MANAGEMENT: [
    "observeCandidate",
    "activateCandidate",
    "observeActivation",
    "remove",
    "finalizeRemoval",
    "removeCandidate",
  ],
} as const;
type ServiceName = keyof typeof INVENTORY;
type Handler = (input: unknown) => unknown;
export type Handlers = Partial<Record<ServiceName, Readonly<Record<string, Handler>>>>;

/** The Workflow bindings the product chains start: a chain answers them only when it starts or reads an instance. */
const WORKFLOW_NAMES = [
  "PROJECT_PROVISIONING_WORKFLOW",
  "DEPLOYMENT_WORKFLOW",
  "PROVIDER_RECONCILIATION_WORKFLOW",
] as const;
export interface WorkflowAnswers {
  readonly create: (input: { readonly id: string; readonly params: unknown }) => Promise<unknown>;
  readonly get: (id: string) => Promise<unknown>;
}
export type WorkflowOverrides = Partial<Record<(typeof WORKFLOW_NAMES)[number], WorkflowAnswers>>;

/**
 * The provider bindings: every inventoried method records `[BINDING.method, clone of input]` and answers its handler.
 * A method without a handler fails as a named unplanned provider call, so the chain never reaches a provider silently.
 * A Workflow binding without an answer fails when touched.
 */
export function providerServices(
  handlers: Handlers,
  calls: [string, unknown][],
  workflows: WorkflowOverrides = {},
) {
  const services: Record<string, unknown> = {};
  for (const [name, methods] of Object.entries(INVENTORY)) {
    const own = handlers[name as ServiceName] ?? {};
    services[name] = Object.fromEntries(
      methods.map((method) => [
        method,
        async (input: unknown) => {
          const handler = own[method];
          if (
            handler === undefined &&
            name === "NATIVE_AUTH_RESOURCE_RUNTIME" &&
            method === "readPendingNativePolicySync"
          )
            return null;
          if (
            handler === undefined &&
            name === "NATIVE_AUTH_RESOURCE_RUNTIME" &&
            method === "beginHandleDomainRecovery"
          )
            return null;
          calls.push([`${name}.${method}`, structuredClone(input)]);
          if (handler === undefined) throw new Error(`Unexpected provider call ${name}.${method}`);
          return structuredClone(await handler(input));
        },
      ]),
    );
  }
  const unplanned = async () => {
    throw new Error("Unexpected Workflow call in the chain");
  };
  for (const name of WORKFLOW_NAMES)
    services[name] = workflows[name] ?? { create: unplanned, get: unplanned };
  return services;
}

/** The fixed digest every archive, artifact and plan of the chain agrees on (deployment_plans.source_sha256 is 0x03 * 32). */
export const CHAIN_HEX = "03".repeat(32);
export const CHAIN_DIGEST = `sha256:${CHAIN_HEX}`;
const now = () => new Date().toISOString();

export interface ChainIds {
  readonly organizationId: string;
  readonly billingEpochId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly environmentName: "dev" | "prod";
  readonly operationId: string;
  readonly deploymentId: string;
  readonly buildId: string;
}

/** The exact scope every provider answer repeats: the Core's own ids, never invented ones. */
export function chainScope(ids: ChainIds) {
  return {
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    operationId: ids.operationId,
  };
}

export function sourceArchive(ids: ChainIds) {
  const versionId = "0123456789abcdef0123456789abcdef";
  return {
    organizationId: ids.organizationId,
    billingEpochId: ids.billingEpochId,
    archiveId: `r2-version:ohmyho-builds-development/source.zip#${versionId}`,
    byteLength: 42,
    sha256: CHAIN_HEX,
    archive: {
      bucket: "ohmyho-builds-development",
      key: "source.zip",
      versionId,
      eTag: "etag-1",
      byteLength: 42,
      scope: chainScope(ids),
      sourceSha256: CHAIN_HEX,
    },
  };
}

export function buildReceipt(ids: ChainIds) {
  return { buildId: ids.buildId, projectName: "sandbox-build", scope: chainScope(ids) };
}

/** A build artifact of the chain: the real parser's shape, bound to the Core's ids and the fixed digests. */
export function buildArtifact(ids: ChainIds) {
  const manifest = JSON.stringify({ sbom: { digest: CHAIN_DIGEST } });
  return {
    manifestDigest: CHAIN_DIGEST,
    manifestBody: new TextEncoder().encode(manifest),
    files: [{ path: "index.html", body: new Uint8Array([60, 33]) }],
    modules: [{ path: "index.js", body: new Uint8Array([1]) }],
    migrations: [],
    provenance: {
      artifactDigest: CHAIN_DIGEST,
      sourceCommit: "a".repeat(40),
      sourceDigest: CHAIN_DIGEST,
      buildPlanDigest: CHAIN_DIGEST,
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
          frameworkPlanSha256: CHAIN_HEX,
          buildOutputSha256: "5".repeat(64),
        },
        buildSandbox: {
          buildId: ids.buildId,
          projectName: "sandbox-build",
          buildInputFingerprint: "6".repeat(64),
          sourceArchiveSha256: CHAIN_HEX,
          terminalStatus: "SUCCEEDED" as const,
        },
        credentialScan: {
          scannerSha256: "7".repeat(64),
          rulesSha256: "8".repeat(64),
          findingsCount: 0 as const,
        },
      },
      deploymentId: ids.deploymentId,
      buildId: ids.buildId,
      database: { enabled: false as const },
      auth: { provider: "none" as const },
      storage: { enabled: false as const },
      scope: chainScope(ids),
      output: {
        bucket: "ohmyho-builds-development",
        // The key the build broker writes for the bundle of this run (packages/build-broker bundleKey).
        key: `runs/${ids.projectId}/${ids.environmentId}/${ids.operationId}/output/bundle.tar.gz`,
        versionId: "fedcba9876543210fedcba9876543210",
        eTag: "artifact-etag-1",
        byteLength: 84,
        sha256: CHAIN_HEX,
      },
    },
  };
}

/** The WFP candidate of one deployment, named by the Core's own regex p-<project>-<env>-<deployment>. */
export function wfpReceipt(ids: ChainIds) {
  return {
    provider: "cloudflare-wfp",
    namespace: "sandbox",
    scriptName: `p-${ids.projectId.toLowerCase()}-${ids.environmentName}-${ids.deploymentId.toLowerCase()}`,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    productDeploymentId: ids.deploymentId,
    providerTag: "a".repeat(32),
    artifactDigest: CHAIN_DIGEST,
    buildReused: false,
    deployedAt: now(),
  };
}

/** The pending runtime-secret stage the real stage answer carries (runtime-secret-delivery parsePendingStage keys). */
function pendingStage(ids: ChainIds) {
  return {
    stageReceiptId: newUlid(),
    operationId: ids.operationId,
    productDeploymentId: ids.deploymentId,
    leaseId: newUlid(),
    generation: 1,
    releaseSequence: 1,
    trigger: "deploy",
    providerTag: "a".repeat(32),
    appliedSecretNames: [],
    manifestDigest: RUNTIME_DELIVERY.manifestDigest,
    manifestSecretCount: 0,
    stagedAt: now(),
  };
}

/** The recorded stage: the pending stage plus the candidate it was staged for (runtime-secret-delivery recorded shape). */
export function recordedStage(stage: Record<string, unknown>, candidateReceiptId: unknown) {
  return { ...stage, candidateReceiptId, outcome: "staged" };
}

const RUNTIME_DELIVERY = {
  generation: 1,
  secretCount: 0,
  manifestDigest: `sha256:${"e".repeat(64)}`,
};
const RUNTIME_POLICY = { healthCheckPath: "/", egressAllowedOrigins: [] };

/** The stage answer of the runtime secret delivery (`stageCandidate` / `stagePromotionCandidate`). */
export function stagedCandidate(ids: ChainIds) {
  return {
    status: "staged",
    candidate: wfpReceipt(ids),
    priorGateway: null,
    activationRuntimePolicy: RUNTIME_POLICY,
    deploymentUrl: "https://dev-chain.dev.check.omh.st",
    runtimeSecretManifestDigest: RUNTIME_DELIVERY.manifestDigest,
    runtimeSecretDelivery: RUNTIME_DELIVERY,
    runtimeSecretDeliveryStage: pendingStage(ids),
  };
}

/** A domain probe answer built like the composition's expected probe URL (shared-gateway-preflight label). */
export function domainEnvironment(input: Record<string, unknown>, publicUrl: string) {
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
  return {
    status: "ready",
    environmentName: String(input["environmentName"]),
    hostname: new URL(publicUrl).hostname,
    dnsRecordId: "a".repeat(32),
    routeId: "b".repeat(32),
    publicUrl,
    observedAt: now(),
    probe: {
      url: new URL(String(input["healthCheckPath"]), `https://gateway-probe-${label}.${zone}/`)
        .href,
      status: 404,
      observedAt: now(),
    },
  };
}

/** The SES mail deletion of a project without mail resources (the composition's parseSesMailCleanup shape). */
export function sesMailDeletion(ids: { readonly projectId: string }) {
  return {
    status: "absent",
    projectId: ids.projectId,
    resourcesAbsent: true,
    cleanup: [],
  };
}

/** The Cloudflare domain deletion of a project without domain receipts (parseCloudflareDomainCleanup shape). */
export function domainDeletion(input: { readonly operationId: string }) {
  return {
    operationId: input.operationId,
    outcome: "absent",
    oauthGrant: "absent",
    observedAt: now(),
    receipts: [],
  };
}
