export interface PgcfEntitlementScope {
  organizationId: string;
  projectId: string;
  physicalEnvironmentId: string;
  providerProjectId: string;
  databaseId: string;
}
export interface PgcfEntitlementObservation {
  id: string;
  projectId: string;
  sizeClassId: string;
  resources: { memoryMiB: number; storageMiB: number };
  desiredState: "running" | "suspended" | "deleted";
  suspensionReason?: "manual" | "idle" | null;
  generation: number;
  observedGeneration: number;
  observedState: string;
}
export interface PgcfEntitlementAction extends PgcfEntitlementScope {
  actionId: string;
  claimId: string;
  billingEpochId: string;
  action: "suspend" | "resume";
  expectedGeneration: number;
  idempotencyKey: string;
  providerOperationId: string | null;
  state: "reserved" | "dispatched" | "pending";
}
export declare class PgcfEntitlementConflictError extends Error {
  constructor();
}
