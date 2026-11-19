import {
  reportDeploymentHealth,
  type DeploymentHealthCollector,
  type DeploymentHealthObservation,
  type GrowthHealthContext,
} from "./growth-health.js";
import { readGatewayReceipt } from "./gateway-registry.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  buildEgressContext,
  cpuLimitMessage,
  isCpuLimitError,
  WFP_DISPATCH_LIMITS,
} from "@ohmyhost/contracts/wfp-dispatch";
import {
  createRuntimeSecretManifest,
  projectGatewayPublicOrigin,
  type RuntimeSecretManifest,
} from "@ohmyhost/provider-cloudflare";

import {
  WfpManagementInputError,
  type ActivateCandidateInput,
  type CompensateActivationInput,
  type CompensateGatewayActivationInput,
  type ObserveActivationInput,
  type PrepareExistingCandidateInput,
  type RemoveCandidateInput,
  type ObserveCandidateInput,
  type StageVerifiedArtifactInput,
} from "./management.js";
import { createArtifactReader } from "./artifact-reader.js";
import {
  requireWfpManagementConfiguration,
  type RuntimeSecretAuthorityBinding,
  type WfpDispatchNamespaceBinding,
  type WfpManagementWorkerBindings,
} from "./bindings.js";
import { createWfpActionRunner, parseWfpAction, type WfpAction } from "./wfp-actions.js";

const MAX_PRIVATE_PROBE_RESPONSE_BYTES = 64 * 1024;
const MAX_PRIVATE_PROBE_EXCERPT_CHARACTERS = 4096;

export type { WfpManagementWorkerBindings };

/** Test-only seams; the Worker entrypoint always runs with the platform clock and transport. */
export interface WfpManagementRuntimeOverrides {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly reportHealth?: (observation: DeploymentHealthObservation) => void;
}

export function createWfpManagementRuntime(
  bindings: WfpManagementWorkerBindings,
  overrides: WfpManagementRuntimeOverrides = {},
) {
  const configuration = requireWfpManagementConfiguration(bindings);
  const run = createWfpActionRunner({
    configuration,
    readArtifact: createArtifactReader(configuration.buildObjectsBuckets),
    fetch: overrides.fetch ?? ((request, init) => globalThis.fetch(request, init)),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
  });
  const invoke = async (event: unknown) => {
    let parsed: WfpAction;
    try {
      parsed = parseWfpAction(event);
    } catch {
      throw new WfpManagementInputError();
    }
    console.info("wfp-management:action-start");
    let result: unknown;
    try {
      result = await run(parsed);
    } catch (error) {
      // Provider, artifact and contract failures leave this Worker without their detail; the
      // log keeps the action and the fixed failure code only.
      console.error("wfp-management:action-failed", parsed.action, failureCode(error));
      throw new WfpManagementInputError();
    }
    console.info("wfp-management:action-complete");
    return sanitizeWfpResult(parsed, result);
  };
  return Object.freeze({
    async stageVerifiedArtifact(input: StageVerifiedArtifactInput) {
      const record = input as unknown as UnknownRecord;
      const expectedKeys = [
        "organizationId",
        "scope",
        "deploymentId",
        "artifact",
        ...(record["artifactReuse"] === undefined ? [] : ["artifactReuse"]),
        "knownDeployments",
        ...(record["previousGateway"] === undefined ? [] : ["previousGateway"]),
        "runtimeSecretManifest",
        ...(record["databaseRegistration"] === undefined ? [] : ["databaseRegistration"]),
        ...(record["databaseOriginHost"] === undefined ? [] : ["databaseOriginHost"]),
        ...(record["storageBucketName"] === undefined ? [] : ["storageBucketName"]),
        ...(record["storageDataEnvironmentId"] === undefined ? [] : ["storageDataEnvironmentId"]),
      ];
      if (!hasExactKeys(record, expectedKeys)) throw new WfpManagementInputError();
      const artifact = asRecord(record["artifact"]);
      return invoke({
        action: "stage-candidate",
        input: {
          organizationId: record["organizationId"],
          scope: record["scope"],
          deploymentId: record["deploymentId"],
          artifactProvenance: artifact["provenance"],
          ...(record["artifactReuse"] === undefined
            ? {}
            : { artifactReuse: record["artifactReuse"] }),
          knownDeployments: serializeReceipts(record["knownDeployments"]),
          ...(record["previousGateway"] === undefined
            ? {}
            : { previousGateway: serializeGatewayReceipt(record["previousGateway"]) }),
          runtimeSecretManifest: await serializeRuntimeSecretManifest(
            record["runtimeSecretManifest"],
          ),
          ...(record["databaseRegistration"] === undefined
            ? {}
            : { databaseRegistration: record["databaseRegistration"] }),
          ...(record["databaseOriginHost"] === undefined
            ? {}
            : { databaseOriginHost: record["databaseOriginHost"] }),
          ...(record["storageBucketName"] === undefined
            ? {}
            : { storageBucketName: record["storageBucketName"] }),
          ...(record["storageDataEnvironmentId"] === undefined
            ? {}
            : { storageDataEnvironmentId: record["storageDataEnvironmentId"] }),
        },
      });
    },
    async activateCandidate(input: ActivateCandidateInput) {
      const record = input as unknown as UnknownRecord;
      const expectedKeys = [
        "operationId",
        "claimId",
        "candidateReceiptId",
        "organizationId",
        "scope",
        "candidate",
        ...(record["previousGateway"] === undefined ? [] : ["previousGateway"]),
        "runtimePolicy",
      ];
      if (!hasExactKeys(record, expectedKeys)) throw new WfpManagementInputError();
      const event = {
        action: "activate-candidate" as const,
        input: {
          operationId: record["operationId"],
          claimId: record["claimId"],
          candidateReceiptId: record["candidateReceiptId"],

          organizationId: record["organizationId"],
          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
          ...(record["previousGateway"] === undefined
            ? {}
            : { previousGateway: serializeGatewayReceipt(record["previousGateway"]) }),
          runtimePolicy: record["runtimePolicy"],
        },
      };
      parseWfpAction(event);
      const probeDeadline = await beginPrivateProbe(bindings, input);
      const result = await invoke(event);
      const activated = asRecord(result);
      if (activated["status"] !== "activated") return result;
      const gateway = asRecord(activated["gateway"]);
      const healthStatus = await probePrivateCandidate(bindings.WFP_DISPATCH, input, probeDeadline);
      if (healthStatus === null) {
        console.warn("growth deployment health gap: probe unobserved");
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "health" as const,
          currentProviderTag:
            typeof gateway["targetProviderTag"] === "string" ? gateway["targetProviderTag"] : null,
          currentProductDeploymentId: input.candidate.productDeploymentId,
          gateway: result && typeof result === "object" ? activated["gateway"] : null,
        });
      }
      if (
        healthStatus.actualResponse &&
        gateway["candidateReceiptId"] === input.candidateReceiptId &&
        gateway["targetDeploymentId"] === input.candidate.productDeploymentId &&
        gateway["targetScriptName"] === input.candidate.scriptName &&
        gateway["targetProviderTag"] === input.candidate.providerTag &&
        gateway["targetArtifactDigest"] === input.candidate.artifactDigest
      ) {
        try {
          overrides.reportHealth?.({
            schema_version: 1,
            observation_id: crypto.randomUUID(),
            candidate_receipt_id: input.candidateReceiptId,
            organization_id: input.organizationId,
            project_id: input.scope.projectId,
            environment_id: input.scope.environmentId,
            deployment_id: input.candidate.productDeploymentId,
            health_status:
              healthStatus.status >= 200 && healthStatus.status < 300 ? "passed" : "failed",
            http_status: healthStatus.status,
            observed_at: (overrides.now?.() ?? new Date()).toISOString(),
          });
        } catch {
          console.warn("growth deployment health gap: scheduling unavailable");
        }
      }
      if (healthStatus.status < 200 || healthStatus.status >= 300) {
        return Object.freeze({
          status: "unhealthy" as const,
          candidate: activated["candidate"],
          gateway: activated["gateway"],
          deploymentUrl: activated["deploymentUrl"],
          // The verdict travels with the removal, because the candidate is gone right after this.
          health: Object.freeze({
            status: healthStatus.status,
            path: input.runtimePolicy.healthCheckPath,
            excerpt: healthStatus.excerpt,
            truncated: healthStatus.truncated,
          }),
        });
      }
      return result;
    },
    async observeActivation(input: ObserveActivationInput) {
      const record = input as unknown as UnknownRecord;
      if (
        !hasExactKeys(record, [
          "organizationId",
          "scope",
          "candidate",
          "runtimePolicy",
          ...(input.expectedGateway === undefined ? [] : ["expectedGateway"]),
        ])
      ) {
        throw new WfpManagementInputError();
      }
      const event = {
        action: "observe-activation" as const,
        input: {
          organizationId: record["organizationId"],
          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
          runtimePolicy: record["runtimePolicy"],
          ...(input.expectedGateway === undefined
            ? {}
            : { expectedGateway: serializeGatewayReceipt(input.expectedGateway) }),
        },
      };
      parseWfpAction(event);
      const result = await invoke(event);
      const observed = asRecord(result);
      if (observed["status"] !== "observed") return result;
      const probeDeadline = await beginPrivateProbe(bindings, input);
      const healthStatus = await probePrivateCandidate(bindings.WFP_DISPATCH, input, probeDeadline);
      if (healthStatus === null) {
        console.warn("growth deployment health gap: probe unobserved");
        const gateway = asRecord(observed["gateway"]);
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "health" as const,
          currentProviderTag:
            typeof gateway["targetProviderTag"] === "string" ? gateway["targetProviderTag"] : null,
          currentProductDeploymentId: input.candidate.productDeploymentId,
          gateway: observed["gateway"],
        });
      }
      const candidateReceiptId = asRecord(observed["gateway"])["candidateReceiptId"];
      if (healthStatus.actualResponse && isUlid(candidateReceiptId)) {
        try {
          overrides.reportHealth?.({
            schema_version: 1,
            observation_id: crypto.randomUUID(),
            candidate_receipt_id: candidateReceiptId,
            organization_id: input.organizationId,
            project_id: input.scope.projectId,
            environment_id: input.scope.environmentId,
            deployment_id: input.candidate.productDeploymentId,
            health_status:
              healthStatus.status >= 200 && healthStatus.status < 300 ? "passed" : "failed",
            http_status: healthStatus.status,
            observed_at: (overrides.now?.() ?? new Date()).toISOString(),
          });
        } catch {
          console.warn("growth deployment health gap: scheduling unavailable");
        }
      }
      if (healthStatus.status < 200 || healthStatus.status >= 300) {
        return Object.freeze({
          status: "unhealthy" as const,
          candidate: observed["candidate"],
          gateway: observed["gateway"],
          deploymentUrl: observed["deploymentUrl"],
          // The verdict travels with the removal, because the candidate is gone right after this.
          health: Object.freeze({
            status: healthStatus.status,
            path: input.runtimePolicy.healthCheckPath,
            excerpt: healthStatus.excerpt,
            truncated: healthStatus.truncated,
          }),
        });
      }
      return Object.freeze({
        status: "activated" as const,
        candidate: observed["candidate"],
        gateway: observed["gateway"],
        deploymentUrl: observed["deploymentUrl"],
        health: Object.freeze({
          status: 200 as const,
          path: input.runtimePolicy.healthCheckPath,
          excerpt: null,
          truncated: false,
        }),
      });
    },
    compensateActivation(input: CompensateActivationInput) {
      const record = input as unknown as UnknownRecord;
      const expectedKeys = [
        "organizationId",
        "operationId",
        "claimId",
        "cleanupClaimId",
        "scope",
        "candidate",
        "expectedGateway",
        ...(record["previousGateway"] === undefined ? [] : ["previousGateway"]),
      ];
      if (!hasExactKeys(record, expectedKeys)) throw new WfpManagementInputError();
      return invoke({
        action: "compensate-activation",
        input: {
          organizationId: record["organizationId"],
          operationId: record["operationId"],
          claimId: record["claimId"],
          cleanupClaimId: record["cleanupClaimId"],

          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
          expectedGateway: serializeGatewayReceipt(record["expectedGateway"]),
          ...(record["previousGateway"] === undefined
            ? {}
            : { previousGateway: serializeGatewayReceipt(record["previousGateway"]) }),
        },
      });
    },
    compensateGatewayActivation(input: CompensateGatewayActivationInput) {
      const record = input as unknown as UnknownRecord;
      const expectedKeys = [
        "organizationId",
        "operationId",
        "claimId",
        "scope",
        "candidate",
        "expectedGateway",
        ...(record["previousGateway"] === undefined ? [] : ["previousGateway"]),
      ];
      if (!hasExactKeys(record, expectedKeys)) throw new WfpManagementInputError();
      return invoke({
        action: "compensate-gateway-activation",
        input: {
          organizationId: record["organizationId"],
          operationId: record["operationId"],
          claimId: record["claimId"],

          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
          expectedGateway: serializeGatewayReceipt(record["expectedGateway"]),
          ...(record["previousGateway"] === undefined
            ? {}
            : { previousGateway: serializeGatewayReceipt(record["previousGateway"]) }),
        },
      });
    },
    async prepareExistingCandidate(input: PrepareExistingCandidateInput) {
      const record = input as unknown as UnknownRecord;
      const expectedKeys = [
        "artifactSourceDeploymentId",
        "organizationId",
        "scope",
        "candidate",
        "artifact",
        "runtimeSecretManifest",
        ...(record["databaseRegistration"] === undefined ? [] : ["databaseRegistration"]),
        ...(record["storageBucketName"] === undefined ? [] : ["storageBucketName"]),
        ...(record["storageDataEnvironmentId"] === undefined ? [] : ["storageDataEnvironmentId"]),
      ];
      if (!hasExactKeys(record, expectedKeys)) throw new WfpManagementInputError();
      const artifact = asRecord(record["artifact"]);
      const runtimeSecretManifest = await serializeRuntimeSecretManifest(
        record["runtimeSecretManifest"],
      );
      await requireAuthorizedManifest(configuration.runtimeSecretAuthority, {
        organizationId: record["organizationId"],
        scope: record["scope"],
        manifest: runtimeSecretManifest,
      });
      return invoke({
        action: "prepare-existing-candidate",
        input: {
          artifactSourceDeploymentId: record["artifactSourceDeploymentId"],
          organizationId: record["organizationId"],
          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
          artifactProvenance: artifact["provenance"],
          runtimeSecretManifest,
          ...(record["databaseRegistration"] === undefined
            ? {}
            : { databaseRegistration: record["databaseRegistration"] }),
          ...(record["storageBucketName"] === undefined
            ? {}
            : { storageBucketName: record["storageBucketName"] }),
          ...(record["storageDataEnvironmentId"] === undefined
            ? {}
            : { storageDataEnvironmentId: record["storageDataEnvironmentId"] }),
        },
      });
    },
    removeCandidate(input: RemoveCandidateInput) {
      const record = input as unknown as UnknownRecord;
      if (
        !hasExactKeys(record, [
          "organizationId",
          "operationId",
          "claimId",
          "candidateReceiptId",
          "scope",
          "candidate",
        ])
      )
        throw new WfpManagementInputError();
      return invoke({
        action: "remove-candidate",
        input: {
          organizationId: record["organizationId"],
          operationId: record["operationId"],
          claimId: record["claimId"],
          candidateReceiptId: record["candidateReceiptId"],
          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
        },
      });
    },
    observeCandidate(input: ObserveCandidateInput) {
      const record = input as unknown as UnknownRecord;
      if (!hasExactKeys(record, ["scope", "candidate"])) throw new WfpManagementInputError();
      return invoke({
        action: "observe-candidate",
        input: {
          scope: record["scope"],
          candidate: serializeReceipt(record["candidate"]),
        },
      });
    },
    async syncRuntimeSecrets(input: unknown) {
      const record = asRecord(input);
      if (
        !hasExactKeys(record, [
          "organizationId",
          "scope",
          "expectedDeployment",
          "runtimeSecretManifest",
        ])
      ) {
        throw new WfpManagementInputError();
      }
      const expectedDeployment = serializeReceipt(record["expectedDeployment"]);
      const runtimeSecretManifest = await serializeRuntimeSecretManifest(
        record["runtimeSecretManifest"],
      );
      await requireAuthorizedManifest(configuration.runtimeSecretAuthority, {
        organizationId: record["organizationId"],
        scope: record["scope"],
        manifest: runtimeSecretManifest,
      });
      return invoke({
        action: "sync-secrets",
        input: {
          scope: record["scope"],
          expectedDeployment,
          runtimeSecretManifest,
        },
      });
    },
    finalizeRemoval(input: unknown) {
      const record = asRecord(input);
      if (
        !hasExactKeys(record, [
          "organizationId",
          "operationId",
          "claimId",
          "scope",
          "deploymentId",
          "expectedGateway",
        ])
      )
        throw new WfpManagementInputError();
      return invoke({
        action: "finalize-removal",
        input: {
          organizationId: record["organizationId"],
          operationId: record["operationId"],
          claimId: record["claimId"],
          scope: record["scope"],
          deploymentId: record["deploymentId"],
          expectedGateway: serializeGatewayReceipt(record["expectedGateway"]),
        },
      });
    },
  });
}

function failureCode(error: unknown): string {
  const record = typeof error === "object" && error !== null ? (error as UnknownRecord) : {};
  const code = [record["code"], record["message"]].find(
    (value) => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value),
  );
  return typeof code === "string" ? code : "unclassified";
}

function sanitizeWfpResult(event: WfpAction, value: unknown): unknown {
  const result = asRecord(value);
  const status = result["status"];
  const scope = {
    ...asRecord(asRecord(event.input)["scope"]),
    organizationId: asRecord(event.input)["organizationId"],
  };
  if (status === "reconciliation_required") {
    if (event.action === "sync-secrets") {
      if (!hasExactKeys(result, ["status", "currentSecretNames"])) {
        throw new WfpManagementInputError();
      }
      if (!(result["currentSecretNames"] === null || Array.isArray(result["currentSecretNames"]))) {
        throw new WfpManagementInputError();
      }
      if (
        Array.isArray(result["currentSecretNames"]) &&
        (result["currentSecretNames"].some(
          (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name),
        ) ||
          result["currentSecretNames"].some(
            (name, index) =>
              index > 0 &&
              String(name) <= String((result["currentSecretNames"] as unknown[])[index - 1]),
          ))
      ) {
        throw new WfpManagementInputError();
      }
      return Object.freeze({
        status: "reconciliation_required" as const,
        currentSecretNames:
          result["currentSecretNames"] === null
            ? null
            : Object.freeze([...result["currentSecretNames"]]),
      });
    }
    if (event.action === "finalize-removal") {
      if (!hasExactKeys(result, ["status", "reason", "currentProviderTag"])) {
        throw new WfpManagementInputError();
      }
      if (
        (result["reason"] !== "stale_edge" && result["reason"] !== "provider_conflict") ||
        !isProviderIdentity(result["currentProviderTag"], true)
      ) {
        throw new WfpManagementInputError();
      }
      return Object.freeze({
        status: "reconciliation_required" as const,
        reason: result["reason"],
        currentProviderTag: result["currentProviderTag"],
      });
    }
    if (event.action === "observe-candidate") {
      throw new WfpManagementInputError();
    }
    const hasGateway = "gateway" in result;
    const hasReason = Object.hasOwn(result, "reason");
    if (
      !hasExactKeys(result, [
        "status",
        "reconciliationPhase",
        "currentProviderTag",
        "currentProductDeploymentId",
        ...(hasGateway ? ["gateway"] : []),
        ...(hasReason ? ["reason"] : []),
      ])
    ) {
      throw new WfpManagementInputError();
    }
    const phase = result["reconciliationPhase"];
    const allowedPhases: Readonly<Record<string, readonly string[]>> = {
      "stage-candidate": ["candidate", "secrets"],
      "prepare-existing-candidate": ["candidate", "secrets"],
      "activate-candidate": ["candidate", "gateway", "health"],
      "observe-activation": ["candidate", "gateway"],
      "compensate-activation": ["gateway", "candidate"],
      "compensate-gateway-activation": ["gateway", "candidate"],
      "remove-candidate": ["candidate"],
    };
    if (!allowedPhases[event.action]?.includes(String(phase))) {
      throw new WfpManagementInputError();
    }
    if (
      hasReason &&
      (result["reason"] !== "candidate_bindings_outdated" ||
        phase !== "candidate" ||
        ![
          "stage-candidate",
          "prepare-existing-candidate",
          "activate-candidate",
          "observe-activation",
        ].includes(event.action))
    )
      throw new WfpManagementInputError();
    if (
      !isProviderIdentity(result["currentProviderTag"], true) ||
      !(
        result["currentProductDeploymentId"] === null ||
        isUlid(result["currentProductDeploymentId"])
      )
    ) {
      throw new WfpManagementInputError();
    }
    const eventInput = asRecord(event.input);
    const expectedDeploymentId =
      event.action === "stage-candidate"
        ? eventInput["deploymentId"]
        : asRecord(eventInput["candidate"])["productDeploymentId"];
    if (
      result["currentProductDeploymentId"] !== null &&
      result["currentProductDeploymentId"] !== expectedDeploymentId
    ) {
      throw new WfpManagementInputError();
    }
    const common = {
      status: "reconciliation_required" as const,
      reconciliationPhase: result["reconciliationPhase"],
      currentProviderTag: result["currentProviderTag"],
      currentProductDeploymentId: result["currentProductDeploymentId"],
      ...(hasReason ? { reason: "candidate_bindings_outdated" as const } : {}),
    };
    if (!hasGateway) return Object.freeze(common);
    const predecessorEvidence =
      event.action === "observe-activation" && phase === "candidate" && hasReason;
    if (!predecessorEvidence && (event.action !== "activate-candidate" || phase !== "health")) {
      throw new WfpManagementInputError();
    }
    const candidate = asRecord(event.input)["candidate"];
    if (candidate === undefined) throw new WfpManagementInputError();
    if (predecessorEvidence && result["gateway"] === null) throw new WfpManagementInputError();
    return Object.freeze({
      ...common,
      gateway:
        result["gateway"] === null ? null : parseGatewayResult(scope, candidate, result["gateway"]),
    });
  }
  if (status === "rejected") {
    // The provider refused the script itself; only the numeric provider facts pass through so the
    // deployment workflow can fail terminally without a retry.
    const providerStatus = result["providerStatus"];
    const providerCode = result["providerCode"];
    if (
      event.action !== "stage-candidate" ||
      !hasExactKeys(result, ["status", "reason", "providerStatus", "providerCode"]) ||
      result["reason"] !== "script_rejected" ||
      !Number.isSafeInteger(providerStatus) ||
      Number(providerStatus) < 400 ||
      Number(providerStatus) > 499 ||
      !(
        providerCode === null ||
        (Number.isSafeInteger(providerCode) &&
          Number(providerCode) >= 1 &&
          Number(providerCode) <= 999_999)
      )
    ) {
      throw new WfpManagementInputError();
    }
    return Object.freeze({
      status: "rejected" as const,
      reason: "script_rejected" as const,
      providerStatus: Number(providerStatus),
      providerCode: providerCode === null ? null : Number(providerCode),
    });
  }
  switch (event.action) {
    case "stage-candidate": {
      if (
        (status !== "staged" && status !== "replayed") ||
        !hasExactKeys(result, [
          "status",
          "candidate",
          "priorGateway",
          "activationRuntimePolicy",
          "deploymentUrl",
          "runtimeSecretManifestDigest",
        ])
      )
        throw new WfpManagementInputError();
      const eventInput = asRecord(event.input);
      const candidate = parseCandidateResult(scope, result["candidate"]);
      const priorGateway = eventInput["previousGateway"] ?? null;
      if (!sameExactRecord(result["priorGateway"], priorGateway)) {
        throw new WfpManagementInputError();
      }
      if (
        !isDigest(result["runtimeSecretManifestDigest"]) ||
        !isCanonicalPublicOrigin(result["deploymentUrl"], scope)
      ) {
        throw new WfpManagementInputError();
      }
      return Object.freeze({
        status,
        candidate,
        priorGateway,
        activationRuntimePolicy: parseRuntimePolicyResult(result["activationRuntimePolicy"]),
        deploymentUrl: result["deploymentUrl"],
        runtimeSecretManifestDigest: result["runtimeSecretManifestDigest"],
      });
    }
    case "activate-candidate": {
      if (
        status !== "activated" ||
        !hasExactKeys(result, ["status", "candidate", "gateway", "deploymentUrl"])
      ) {
        throw new WfpManagementInputError();
      }
      const candidate = parseCandidateResult(scope, result["candidate"]);
      const gateway = parseGatewayResult(scope, candidate, result["gateway"]);
      return Object.freeze({
        status: "activated" as const,
        candidate,
        gateway,
        deploymentUrl: gateway.publicOrigin,
      });
    }
    case "observe-activation": {
      if (status === "absent") {
        if (!hasExactKeys(result, ["status"])) throw new WfpManagementInputError();
        return Object.freeze({ status: "absent" as const });
      }
      if (
        status !== "observed" ||
        !hasExactKeys(result, ["status", "candidate", "gateway", "deploymentUrl"])
      ) {
        throw new WfpManagementInputError();
      }
      const candidate = parseCandidateResult(scope, result["candidate"]);
      const expectedCandidate = asRecord(event.input)["candidate"];
      if (!sameExactRecord(candidate, expectedCandidate)) throw new WfpManagementInputError();
      const gateway = parseGatewayResult(scope, candidate, result["gateway"]);
      return Object.freeze({
        status: "observed" as const,
        candidate,
        gateway,
        deploymentUrl: gateway.publicOrigin,
      });
    }
    case "prepare-existing-candidate": {
      if (
        status !== "prepared" ||
        !hasExactKeys(result, [
          "status",
          "candidate",
          "activationRuntimePolicy",
          "runtimeSecretManifestDigest",
        ])
      ) {
        throw new WfpManagementInputError();
      }
      if (!isDigest(result["runtimeSecretManifestDigest"])) throw new WfpManagementInputError();
      return Object.freeze({
        status: "prepared" as const,
        candidate: parseCandidateResult(scope, result["candidate"]),
        activationRuntimePolicy: parseRuntimePolicyResult(result["activationRuntimePolicy"]),
        runtimeSecretManifestDigest: result["runtimeSecretManifestDigest"],
      });
    }
    case "compensate-activation":
      if (status !== "compensated" || !hasExactKeys(result, ["status", "gateway", "candidate"]))
        throw new WfpManagementInputError();
      return Object.freeze({
        status: "compensated" as const,
        gateway: parseCompensatedGateway(
          scope,
          asRecord(event.input)["candidate"],
          asRecord(event.input)["expectedGateway"],
          result["gateway"],
        ),
        candidate: parseMetadataAbsence(result["candidate"], asRecord(event.input)["candidate"]),
      });
    case "compensate-gateway-activation":
      if (
        status !== "compensated" ||
        !hasExactKeys(result, ["status", "gateway", "candidateRetained"]) ||
        result["candidateRetained"] !== true
      ) {
        throw new WfpManagementInputError();
      }
      return Object.freeze({
        status: "compensated" as const,
        gateway: parseCompensatedGateway(
          scope,
          asRecord(event.input)["candidate"],
          asRecord(event.input)["expectedGateway"],
          result["gateway"],
        ),
        candidateRetained: true as const,
      });
    case "observe-candidate":
      if (
        !hasExactKeys(result, [
          "state",
          "scriptName",
          "providerTag",
          "productDeploymentId",
          "artifactDigest",
          "observedAt",
          ...(Object.hasOwn(result, "reason") ? ["reason"] : []),
        ])
      ) {
        throw new WfpManagementInputError();
      }
      return parseCandidateObservation(result, asRecord(event.input)["candidate"]);
    case "remove-candidate":
      if (
        status !== "removed" ||
        !hasExactKeys(result, ["status", "outcome", "receipt"]) ||
        (result["outcome"] !== "removed" && result["outcome"] !== "not_found")
      ) {
        throw new WfpManagementInputError();
      }
      return Object.freeze({
        status: "removed" as const,
        outcome: result["outcome"],
        receipt: parseMetadataAbsence(result["receipt"], asRecord(event.input)["candidate"]),
      });
    case "sync-secrets":
      if (status !== "synchronized" || !hasExactKeys(result, ["status", "receipt"]))
        throw new WfpManagementInputError();
      {
        const receipt = parseSecretReceipt(result["receipt"]);
        const expected = asRecord(event.input)["expectedDeployment"];
        const manifest = asRecord(asRecord(event.input)["runtimeSecretManifest"]);
        const candidate = asRecord(expected);
        if (
          receipt["projectId"] !== candidate["projectId"] ||
          receipt["environmentId"] !== candidate["environmentId"] ||
          receipt["namespace"] !== candidate["namespace"] ||
          receipt["scriptName"] !== candidate["scriptName"] ||
          receipt["manifestDigest"] !== manifest["digest"]
        ) {
          throw new WfpManagementInputError();
        }
        return Object.freeze({ status: "synchronized" as const, receipt });
      }
    case "finalize-removal": {
      if (
        status !== "removed" ||
        !hasExactKeys(result, ["status", "metadata", "gateway", "consecutive404s"]) ||
        result["consecutive404s"] !== 3
      ) {
        throw new WfpManagementInputError();
      }
      return Object.freeze({
        status: "removed" as const,
        metadata:
          result["metadata"] === null
            ? null
            : parseMetadataAbsence(
                result["metadata"],
                candidateFromGateway(scope, asRecord(asRecord(event.input)["expectedGateway"])),
              ),
        gateway:
          result["gateway"] === null
            ? null
            : parseGatewayAbsence(
                result["gateway"],
                scope,
                asRecord(asRecord(event.input)["expectedGateway"]),
              ),
        consecutive404s: 3 as const,
      });
    }
  }
}

function parseCandidateResult(scope: UnknownRecord, value: unknown) {
  const candidate = serializeReceipt(value);
  const parsed = parseWfpAction({
    action: "observe-candidate",
    input: {
      scope: {
        projectId: scope["projectId"],
        environmentId: scope["environmentId"],
        environmentName: scope["environmentName"],
        handle: scope["handle"],
      },
      candidate,
    },
  });
  if (parsed.action !== "observe-candidate") throw new WfpManagementInputError();
  return parsed.input.candidate;
}

function parseGatewayResult(scope: UnknownRecord, candidate: unknown, value: unknown) {
  let receipt;
  try {
    receipt = readGatewayReceipt(value);
  } catch {
    throw new WfpManagementInputError();
  }
  if (
    receipt.projectId !== scope["projectId"] ||
    receipt.environmentId !== scope["environmentId"] ||
    receipt.environmentName !== scope["environmentName"] ||
    receipt.handle !== scope["handle"] ||
    (scope["organizationId"] !== undefined && receipt.organizationId !== scope["organizationId"])
  )
    throw new WfpManagementInputError();
  if (candidate !== null) {
    const expected = asRecord(candidate);
    if (
      receipt.publicOrigin !==
        projectGatewayPublicOrigin(
          {
            projectId: String(scope["projectId"]),
            handle: String(scope["handle"]),
            environmentName: scope["environmentName"] as "dev" | "prod",
          },
          String(expected["namespace"]),
        ) ||
      receipt.targetDeploymentId !== expected["productDeploymentId"] ||
      receipt.targetScriptName !== expected["scriptName"] ||
      receipt.targetProviderTag !== expected["providerTag"] ||
      receipt.targetArtifactDigest !== expected["artifactDigest"]
    )
      throw new WfpManagementInputError();
  }
  return receipt;
}

function parseCompensatedGateway(
  scope: UnknownRecord,
  _candidate: unknown,
  expectedGateway: unknown,
  value: unknown,
) {
  const receipt = parseGatewayResult(scope, null, value);
  const expected = asRecord(expectedGateway);
  if (
    receipt.organizationId !== expected["organizationId"] ||
    receipt.publicOrigin !== expected["publicOrigin"] ||
    receipt.hostname !== expected["hostname"] ||
    receipt.revision <= Number(expected["revision"])
  )
    throw new WfpManagementInputError();
  return receipt;
}

function parseMetadataAbsence(value: unknown, expectedCandidate?: unknown) {
  const record = asRecord(value);
  if (
    !hasExactKeys(record, [
      "state",
      "namespace",
      "scriptName",
      "projectId",
      "environmentId",
      "expectedProviderTag",
      "observedAt",
    ]) ||
    record["state"] !== "metadata_absent"
  ) {
    throw new WfpManagementInputError();
  }
  const observedAt = parseExactDate(record["observedAt"]);
  if (observedAt === null || !isProviderIdentity(record["expectedProviderTag"], false)) {
    throw new WfpManagementInputError();
  }
  if (expectedCandidate !== undefined) {
    const expected = asRecord(expectedCandidate);
    if (
      (expected["namespace"] !== undefined && record["namespace"] !== expected["namespace"]) ||
      record["scriptName"] !== expected["scriptName"] ||
      record["projectId"] !== expected["projectId"] ||
      record["environmentId"] !== expected["environmentId"] ||
      record["expectedProviderTag"] !== expected["providerTag"]
    ) {
      throw new WfpManagementInputError();
    }
  }
  return Object.freeze({ ...record, state: "metadata_absent" as const, observedAt });
}

function parseGatewayAbsence(
  value: unknown,
  scope: UnknownRecord,
  expectedGateway?: UnknownRecord,
) {
  const receipt = parseGatewayResult(scope, null, value);
  if (
    receipt.active ||
    (expectedGateway !== undefined &&
      (receipt.organizationId !== expectedGateway["organizationId"] ||
        receipt.publicOrigin !== expectedGateway["publicOrigin"] ||
        receipt.hostname !== expectedGateway["hostname"] ||
        receipt.revision <= Number(expectedGateway["revision"])))
  )
    throw new WfpManagementInputError();
  return receipt;
}

function parseSecretReceipt(value: unknown): UnknownRecord {
  const record = asRecord(value);
  if (
    !hasExactKeys(record, [
      "provider",
      "namespace",
      "scriptName",
      "projectId",
      "environmentId",
      "manifestDigest",
      "secretNames",
      "providerTag",
      "observedAt",
    ]) ||
    record["provider"] !== "cloudflare-wfp" ||
    !Array.isArray(record["secretNames"]) ||
    !isDigest(record["manifestDigest"]) ||
    !isProviderIdentity(record["providerTag"], false) ||
    parseExactDate(record["observedAt"]) === null
  ) {
    throw new WfpManagementInputError();
  }
  const secretNames = record["secretNames"];
  if (
    secretNames.some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name),
    ) ||
    secretNames.some((name, index) => index > 0 && name <= secretNames[index - 1])
  ) {
    throw new WfpManagementInputError();
  }
  return Object.freeze({
    ...record,
    provider: "cloudflare-wfp" as const,
    secretNames: Object.freeze([...secretNames]),
    observedAt: parseExactDate(record["observedAt"]) as Date,
  }) as UnknownRecord;
}

function parseRuntimePolicyResult(value: unknown) {
  const record = asRecord(value);
  if (
    !hasExactKeys(record, [
      "healthCheckPath",
      "egressAllowedOrigins",
      ...(record["browser"] === undefined ? [] : ["browser"]),
    ]) ||
    typeof record["healthCheckPath"] !== "string" ||
    !record["healthCheckPath"].startsWith("/") ||
    record["healthCheckPath"].includes("?") ||
    record["healthCheckPath"].includes("#") ||
    !Array.isArray(record["egressAllowedOrigins"]) ||
    record["egressAllowedOrigins"].some(
      (origin) => typeof origin !== "string" || !isDnsEgressOrigin(origin),
    ) ||
    record["egressAllowedOrigins"].some(
      (origin, index) =>
        index > 0 &&
        String(origin) <= String((record["egressAllowedOrigins"] as unknown[])[index - 1]),
    )
  ) {
    throw new WfpManagementInputError();
  }
  let browser: BrowserPolicy | undefined;
  try {
    browser = record["browser"] === undefined ? undefined : parseBrowserPolicy(record["browser"]);
  } catch {
    throw new WfpManagementInputError();
  }
  return Object.freeze({
    healthCheckPath: record["healthCheckPath"],
    egressAllowedOrigins: Object.freeze([...record["egressAllowedOrigins"]]),
    ...(browser === undefined ? {} : { browser }),
  });
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalPublicOrigin(value: unknown, scope: UnknownRecord): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const prefix =
      scope["environmentName"] === "prod"
        ? String(scope["handle"])
        : `dev-${String(scope["handle"])}`;
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "" &&
      [`${prefix}.dev.check.omh.st`, `${prefix}.check.omh.st`, `${prefix}.poc.aixyte.com`].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

function parseExactDate(value: unknown): Date | null {
  const date =
    value instanceof Date ? new Date(value) : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) return null;
  if (typeof value === "string" && date.toISOString() !== value) return null;
  return date;
}

function isUlid(value: unknown): value is string {
  return typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function isProviderIdentity(value: unknown, nullable: boolean): boolean {
  return (
    (nullable && value === null) ||
    (typeof value === "string" &&
      (/^[a-f0-9]{32}$/u.test(value) || /^sha256:[a-f0-9]{64}$/u.test(value)))
  );
}

function candidateFromGateway(scope: UnknownRecord, gateway: UnknownRecord): UnknownRecord {
  return Object.freeze({
    scriptName: gateway["targetScriptName"],
    projectId: scope["projectId"],
    environmentId: scope["environmentId"],
    providerTag: gateway["targetProviderTag"],
  });
}

function parseCandidateObservation(value: UnknownRecord, expectedCandidate: unknown) {
  const expected = asRecord(expectedCandidate);
  if (
    Object.hasOwn(value, "reason") &&
    (value["reason"] !== "candidate_bindings_outdated" ||
      value["state"] !== "unknown" ||
      value["providerTag"] !== expected["providerTag"] ||
      value["productDeploymentId"] !== expected["productDeploymentId"] ||
      value["artifactDigest"] !== expected["artifactDigest"])
  )
    throw new WfpManagementInputError();
  const observedAt = parseExactDate(value["observedAt"]);
  if (observedAt === null || value["scriptName"] !== expected["scriptName"]) {
    throw new WfpManagementInputError();
  }
  if (value["state"] === "ready") {
    if (
      value["providerTag"] !== expected["providerTag"] ||
      value["productDeploymentId"] !== expected["productDeploymentId"] ||
      value["artifactDigest"] !== expected["artifactDigest"]
    )
      throw new WfpManagementInputError();
  } else if (value["state"] === "metadata_absent") {
    if (
      value["providerTag"] !== null ||
      value["productDeploymentId"] !== null ||
      value["artifactDigest"] !== null
    )
      throw new WfpManagementInputError();
  } else if (value["state"] === "unknown") {
    if (
      !isProviderIdentity(value["providerTag"], true) ||
      !(value["productDeploymentId"] === null || isUlid(value["productDeploymentId"])) ||
      !(value["artifactDigest"] === null || isDigest(value["artifactDigest"]))
    )
      throw new WfpManagementInputError();
  } else {
    throw new WfpManagementInputError();
  }
  return Object.freeze({ ...value, observedAt });
}

function sameExactRecord(value: unknown, expected: unknown): boolean {
  if (value === null || expected === null) return value === expected;
  if (typeof value !== "object" || typeof expected !== "object") return false;
  const left = Object.keys(value as object).sort();
  const right = Object.keys(expected as object).sort();
  return (
    left.length === right.length &&
    left.every(
      (key, index) =>
        key === right[index] &&
        JSON.stringify((value as Record<string, unknown>)[key]) ===
          JSON.stringify((expected as Record<string, unknown>)[key]),
    )
  );
}

const privateWorker = {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};

export default privateWorker;

export class WfpManagementService extends WorkerEntrypoint<
  WfpManagementWorkerBindings & { GROWTH_ANALYTICS?: DeploymentHealthCollector }
> {
  private runtime() {
    const context = (this as unknown as { ctx: GrowthHealthContext }).ctx;
    return createWfpManagementRuntime(this.env, {
      reportHealth: (observation) =>
        reportDeploymentHealth(this.env.GROWTH_ANALYTICS, context, observation),
    });
  }
  public async stageVerifiedArtifact(input: StageVerifiedArtifactInput) {
    return createWfpManagementRuntime(this.env).stageVerifiedArtifact(input);
  }

  public async activateCandidate(input: ActivateCandidateInput) {
    return this.runtime().activateCandidate(input);
  }

  public async observeActivation(input: ObserveActivationInput) {
    return this.runtime().observeActivation(input);
  }

  public async compensateActivation(input: CompensateActivationInput) {
    return createWfpManagementRuntime(this.env).compensateActivation(input);
  }

  public async compensateGatewayActivation(input: CompensateGatewayActivationInput) {
    return createWfpManagementRuntime(this.env).compensateGatewayActivation(input);
  }

  public async prepareExistingCandidate(input: PrepareExistingCandidateInput) {
    return createWfpManagementRuntime(this.env).prepareExistingCandidate(input);
  }

  public async removeCandidate(input: RemoveCandidateInput) {
    return createWfpManagementRuntime(this.env).removeCandidate(input);
  }

  public async observeCandidate(input: ObserveCandidateInput) {
    return createWfpManagementRuntime(this.env).observeCandidate(input);
  }

  public async syncRuntimeSecrets(input: unknown) {
    return createWfpManagementRuntime(this.env).syncRuntimeSecrets(input);
  }

  public async finalizeRemoval(input: unknown) {
    return createWfpManagementRuntime(this.env).finalizeRemoval(input);
  }
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

async function probePrivateCandidate(
  dispatch: WfpDispatchNamespaceBinding,
  input: ObserveActivationInput,
  deadline: number,
): Promise<{
  status: number;
  excerpt: string | null;
  truncated: boolean;
  actualResponse: boolean;
} | null> {
  // The probe runs customer code before the gateway routes to it, so it carries what the gateway
  // gives live traffic: the platform limits and the project's egress policy. Without them the
  // candidate would run with default limits and no Outbound Worker, free to open sockets.
  const target = dispatch.get(
    input.candidate.scriptName,
    {},
    {
      limits: WFP_DISPATCH_LIMITS,
      outbound: {
        EGRESS_CONTEXT: buildEgressContext(
          input.scope.projectId,
          input.runtimePolicy.egressAllowedOrigins,
        ),
      },
    },
  );
  if (target === null || typeof target !== "object" || typeof target.fetch !== "function") {
    throw new WfpManagementInputError();
  }
  const url = `https://candidate.internal${input.runtimePolicy.healthCheckPath}`;
  let observed: {
    status: number;
    excerpt: string | null;
    truncated: boolean;
    actualResponse: boolean;
  } | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (Date.now() + 5000 > deadline) return observed;
    try {
      const response = await target.fetch(
        new Request(url, {
          method: "GET",
          headers: { accept: "*/*", "cache-control": "no-store" },
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        }),
      );
      const body = await consumePrivateProbeBody(response);
      if (!body.ok) continue;
      observed = {
        status: response.status,
        excerpt: body.excerpt,
        truncated: body.truncated,
        actualResponse: true,
      };
      if (response.status >= 200 && response.status < 300) return observed;
    } catch (error) {
      // The bounded private probe retries without exposing a provider error. Only the CPU limit,
      // which the gateway answers to visitors with the same sentence, becomes a verdict: it is
      // deterministic for the code, so it is unhealthy with its explanation, not unknown.
      if (isCpuLimitError(error))
        observed = {
          status: 429,
          excerpt: cpuLimitMessage(),
          truncated: false,
          actualResponse: false,
        };
    }
  }
  return observed;
}

async function beginPrivateProbe(
  bindings: WfpManagementWorkerBindings,
  input: ObserveActivationInput,
) {
  const result = await bindings.RUNTIME_PROBES.beginProbe({
    organizationId: input.organizationId,
    projectId: input.scope.projectId,
    environmentId: input.scope.environmentId,
    deploymentId: input.candidate.productDeploymentId,
  });
  const value = asRecord(result),
    deadline = Date.parse(String(value["expiresAt"]));
  if (
    !hasExactKeys(value, ["expiresAt"]) ||
    typeof value["expiresAt"] !== "string" ||
    !Number.isFinite(deadline) ||
    new Date(deadline).toISOString() !== value["expiresAt"] ||
    deadline < Date.now() + 30000 ||
    deadline > Date.now() + 210000
  )
    throw new Error("Runtime probe accounting is unavailable");
  return deadline;
}

/**
 * Keep a bounded excerpt for failed health checks. A large response body is not a failed HTTP
 * response: stop reading at the byte budget and retain the status while cancelling the remainder.
 */
async function consumePrivateProbeBody(
  response: Response,
): Promise<{ ok: boolean; excerpt: string | null; truncated: boolean }> {
  const refused = { ok: false, excerpt: null, truncated: false } as const;
  const declared = response.headers.get("content-length");
  if (declared !== null && !/^\d+$/u.test(declared)) {
    void response.body?.cancel();
    return refused;
  }
  if (response.body === null) return { ok: true, excerpt: null, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let byteLength = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const item = await reader.read();
    if (item.done) return { ok: true, excerpt: sanitizeProbeExcerpt(text), truncated };
    const prefix = item.value.subarray(0, MAX_PRIVATE_PROBE_RESPONSE_BYTES - byteLength);
    byteLength += prefix.byteLength;
    if (text.length < MAX_PRIVATE_PROBE_EXCERPT_CHARACTERS) {
      // Even if one stream chunk is huge, decode at most the bytes needed for the excerpt.
      const excerptBytes = prefix.subarray(
        0,
        (MAX_PRIVATE_PROBE_EXCERPT_CHARACTERS - text.length) * 4,
      );
      text += decoder.decode(excerptBytes, { stream: true });
      if (excerptBytes.byteLength < prefix.byteLength) truncated = true;
      if (text.length > MAX_PRIVATE_PROBE_EXCERPT_CHARACTERS) {
        text = text.slice(0, MAX_PRIVATE_PROBE_EXCERPT_CHARACTERS);
        truncated = true;
      }
    } else truncated = true;
    if (byteLength === MAX_PRIVATE_PROBE_RESPONSE_BYTES) {
      void reader.cancel();
      return { ok: true, excerpt: sanitizeProbeExcerpt(text), truncated: true };
    }
  }
}

function sanitizeProbeExcerpt(value: string): string | null {
  const text = value.replaceAll(/(?![\t\n])\p{Cc}|\p{Cs}/gu, "").trimEnd();
  return text === "" ? null : text;
}

function asRecord(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WfpManagementInputError();
  }
  return value as UnknownRecord;
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function serializeReceipts(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new WfpManagementInputError();
  return value.map(serializeReceipt);
}

function serializeReceipt(value: unknown): unknown {
  const record = asRecord(value);
  return {
    ...record,
    deployedAt:
      record["deployedAt"] instanceof Date
        ? record["deployedAt"].toISOString()
        : record["deployedAt"],
  };
}

function serializeGatewayReceipt(value: unknown): unknown {
  const record = asRecord(value);
  return {
    ...record,
    observedAt:
      record["observedAt"] instanceof Date
        ? record["observedAt"].toISOString()
        : record["observedAt"],
  };
}

/**
 * Core decides whether a manifest may reach a provider before any provider action: the scope's secrets must be stored
 * at exactly the names and revisions the manifest carries. A refusal, or an unreachable authority, is one fixed error.
 */
async function requireAuthorizedManifest(
  authority: RuntimeSecretAuthorityBinding,
  input: { organizationId: unknown; scope: unknown; manifest: RuntimeSecretManifest },
): Promise<void> {
  const scope = asRecord(input.scope);
  const organizationId = input.organizationId;
  const projectId = scope["projectId"];
  const environmentId = scope["environmentId"];
  if (
    typeof organizationId !== "string" ||
    typeof projectId !== "string" ||
    typeof environmentId !== "string"
  ) {
    throw new WfpManagementInputError();
  }
  try {
    const result = asRecord(
      await authority.authorizeManifest({
        organizationId,
        projectId,
        environmentId,
        secrets: input.manifest.secrets.map((secret) => ({
          name: secret.name,
          revision: secret.revision,
        })),
      }),
    );
    if (result["authorized"] !== true) throw new WfpManagementInputError();
  } catch {
    console.error("wfp-management:manifest-refused");
    throw new WfpManagementInputError();
  }
}

async function serializeRuntimeSecretManifest(value: unknown): Promise<RuntimeSecretManifest> {
  const record = asRecord(value);
  if (typeof record["digest"] !== "string" || !Array.isArray(record["secrets"])) {
    throw new WfpManagementInputError();
  }
  console.info("wfp-management:manifest-validation-start");
  const manifest = await createRuntimeSecretManifest(
    record["secrets"].map((value) => {
      const secret = asRecord(value);
      if (
        typeof secret["name"] !== "string" ||
        typeof secret["value"] !== "string" ||
        !Number.isSafeInteger(secret["revision"]) ||
        typeof secret["valueSha256"] !== "string"
      ) {
        throw new WfpManagementInputError();
      }
      return {
        name: secret["name"],
        value: secret["value"],
        revision: Number(secret["revision"]),
        valueSha256: secret["valueSha256"] as `sha256:${string}`,
      };
    }),
  );
  if (manifest.digest !== record["digest"]) throw new WfpManagementInputError();
  console.info("wfp-management:manifest-validation-complete");
  return manifest;
}
