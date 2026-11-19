import type { PgcfEntitlementObservation } from "@ohmyhost/database";
import type { PgcfEntitlementPersistence } from "./pgcf-entitlements.js";

/** Closed original entitlement transactions; the provider stays in database management. */
export interface D1PgcfEntitlementRuntime {
  readProductEntitlementTargets(input: {
    providerProjectId: string;
  }): ReturnType<PgcfEntitlementPersistence["listTargets"]>;
  claimProductEntitlement(input: {
    scope: Parameters<PgcfEntitlementPersistence["claim"]>[0];
    observation: PgcfEntitlementObservation;
    input: Parameters<PgcfEntitlementPersistence["claim"]>[2];
  }): ReturnType<PgcfEntitlementPersistence["claim"]>;
  beginProductEntitlement(input: {
    job: Parameters<PgcfEntitlementPersistence["begin"]>[0];
    now: string;
    observation: PgcfEntitlementObservation;
  }): ReturnType<PgcfEntitlementPersistence["begin"]>;
  recordProductEntitlement(input: {
    job: Parameters<PgcfEntitlementPersistence["record"]>[0];
    input: Parameters<PgcfEntitlementPersistence["record"]>[1];
  }): ReturnType<PgcfEntitlementPersistence["record"]>;
  recordProductEntitlementCheckFailure(input: {
    scope: Parameters<PgcfEntitlementPersistence["claim"]>[0];
    now: string;
  }): Promise<void>;
}
/** Provider records may carry additional metadata. Send only the original policy observation contract. */
function observationOf(o: PgcfEntitlementObservation): PgcfEntitlementObservation {
  return {
    id: o.id,
    projectId: o.projectId,
    sizeClassId: o.sizeClassId,
    resources: { memoryMiB: o.resources.memoryMiB, storageMiB: o.resources.storageMiB },
    desiredState: o.desiredState,
    ...(o.suspensionReason === undefined ? {} : { suspensionReason: o.suspensionReason }),
    generation: o.generation,
    observedGeneration: o.observedGeneration,
    observedState: o.observedState,
  };
}
export function createD1PgcfEntitlementPersistence(
  runtime: D1PgcfEntitlementRuntime,
): PgcfEntitlementPersistence {
  return {
    listTargets: (providerProjectId) =>
      runtime.readProductEntitlementTargets({ providerProjectId }),
    claim: (scope, observation, input) =>
      runtime.claimProductEntitlement({ scope, observation: observationOf(observation), input }),
    begin: (job, now, observation) =>
      runtime.beginProductEntitlement({ job, now, observation: observationOf(observation) }),
    record: (job, input) => runtime.recordProductEntitlement({ job, input }),
    recordCheckFailure: (scope, now) =>
      runtime.recordProductEntitlementCheckFailure({ scope, now }),
  };
}
