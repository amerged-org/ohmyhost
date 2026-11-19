import { parseSharedGatewayReceipt } from "@ohmyhost/platform";
import type { ProductAbandonedWfpTarget } from "@ohmyhost/database";
import { projectEnvironmentAddress } from "@ohmyhost/project-handles";
import type { WfpManagementBinding } from "./bindings.js";

/** A provider observation is a predecessor proof, never a published application head. */
export async function observeAbandonedGateway(
  binding: Pick<WfpManagementBinding, "observeActivation">,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly environmentName: "dev" | "prod";
    readonly handle: string;
  },
  targets: readonly ProductAbandonedWfpTarget[],
): Promise<{
  readonly target: ProductAbandonedWfpTarget;
  readonly gateway: Readonly<Record<string, unknown>>;
} | null> {
  for (const target of targets) {
    const candidate = target.candidate;
    if (candidate.projectId !== scope.projectId || candidate.environmentId !== scope.environmentId)
      continue;
    const raw = await binding.observeActivation({
      organizationId: scope.organizationId,
      scope: {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        environmentName: scope.environmentName,
        handle: scope.handle,
      },
      candidate,
      // A new deployment may have different egress; its policy cannot prove the old gateway.
      runtimePolicy: target.runtimePolicy,
    });
    if (!isRecord(raw)) continue;
    const observed = raw["candidate"],
      gateway = raw["gateway"];
    // This phase is emitted only after exact candidate + gateway observation succeeded.
    // An abandoned application's health does not authorize or prevent replacing that identity.
    const healthUncertain =
      raw["status"] === "reconciliation_required" &&
      raw["reconciliationPhase"] === "health" &&
      isRecord(gateway) &&
      raw["currentProviderTag"] === gateway["targetProviderTag"] &&
      raw["currentProductDeploymentId"] === candidate.productDeploymentId;
    // A retired runtime contract can prove only this exact predecessor, never execution readiness.
    const outdatedCandidate =
      raw["status"] === "reconciliation_required" &&
      raw["reconciliationPhase"] === "candidate" &&
      raw["reason"] === "candidate_bindings_outdated" &&
      Object.keys(raw).sort().join(",") ===
        "currentProductDeploymentId,currentProviderTag,gateway,reason,reconciliationPhase,status" &&
      isRecord(gateway) &&
      raw["currentProviderTag"] === candidate.providerTag &&
      raw["currentProductDeploymentId"] === candidate.productDeploymentId;
    if ("reason" in raw && !outdatedCandidate) continue;
    const identityOnly = healthUncertain || outdatedCandidate;
    if (!identityOnly && !["observed", "activated", "unhealthy"].includes(String(raw["status"])))
      continue;
    let verified;
    try {
      verified = parseSharedGatewayReceipt(gateway);
    } catch {
      continue;
    }
    const address = projectEnvironmentAddress({
      projectId: scope.projectId,
      handle: scope.handle,
      environmentName: scope.environmentName,
      platform: candidate.namespace === "ohmyho-production" ? "production" : "development",
    });
    if (
      (!identityOnly &&
        (!isRecord(observed) ||
          observed["projectId"] !== scope.projectId ||
          observed["environmentId"] !== scope.environmentId ||
          observed["namespace"] !== candidate.namespace ||
          observed["scriptName"] !== candidate.scriptName ||
          observed["productDeploymentId"] !== candidate.productDeploymentId ||
          observed["providerTag"] !== candidate.providerTag ||
          observed["artifactDigest"] !== candidate.artifactDigest)) ||
      !verified.active ||
      verified.organizationId !== scope.organizationId ||
      verified.projectId !== scope.projectId ||
      verified.environmentId !== scope.environmentId ||
      verified.environmentName !== scope.environmentName ||
      verified.handle !== scope.handle ||
      verified.targetScriptName !== candidate.scriptName ||
      verified.targetDeploymentId !== candidate.productDeploymentId ||
      verified.targetProviderTag !== candidate.providerTag ||
      verified.targetArtifactDigest !== candidate.artifactDigest ||
      verified.publicOrigin !== address.origin ||
      (!identityOnly && raw["deploymentUrl"] !== address.origin) ||
      (outdatedCandidate &&
        (verified.candidateReceiptId !== target.candidateReceiptId ||
          verified.operationId !== target.operationId ||
          JSON.stringify(verified.egressAllowedOrigins) !==
            JSON.stringify(target.runtimePolicy.egressAllowedOrigins) ||
          JSON.stringify(verified.browserPolicy) !== JSON.stringify(target.runtimePolicy.browser)))
    )
      continue;
    return Object.freeze({
      target,
      gateway: Object.freeze({ ...verified, observedAt: verified.observedAt.toISOString() }),
    });
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
