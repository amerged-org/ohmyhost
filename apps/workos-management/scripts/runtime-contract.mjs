import { isDeepStrictEqual } from "node:util";

/**
 * Artifact capability, not an activation: the Worker's only Control authority is the private `CONTROL_RUNTIME`
 * service binding to the Core's WorkosRuntime entrypoint; a deployment carries no direct database binding.
 */
export function createManagementRuntimeContract() {
  return {
    schemaVersion: 3,
    runtime: "cloudflare-worker",
    access: "service-binding-only",
    secretDelivery: "cloudflare-worker-secret",
    requiredBindings: [
      "CF_VERSION_METADATA",
      "CONTROL_RUNTIME",
      "MANAGEMENT_ARTIFACT_SHA256",
      "WORKOS_DEPLOYMENT",
      "WORKOS_MANAGEMENT_CREDENTIAL",
    ],
    serviceBinding: { name: "CONTROL_RUNTIME", entrypoint: "WorkosRuntime" },
    forbiddenBindings: ["CONTROL_CORE", "CONTROL_GLOBAL"],
    forbiddenBindingPatterns: ["^CONTROL_SHARD_\\d{4}$"],
    forbiddenBindingTypes: ["d1"],
    scheduledTriggers: ["*/1 * * * *"],
    snapshotDeadlineMs: 20_000,
    publicRoutes: [],
  };
}

/** Only the current closed contract is accepted; an artifact built from an older contract is rebuilt. */
export function isManagementRuntimeContract(value) {
  return isDeepStrictEqual(value, createManagementRuntimeContract());
}
