import {
  type HostingRegion,
  type AuthorizationAction,
  type AuthorizationRestriction,
} from "@ohmyhost/platform";

type Scope = { readonly organizationId: string; readonly projectId: string };
type ParentScope = Scope & { readonly parentOperationId: string };

export interface ManagedSourceInitialization extends ParentScope {
  readonly sourceConnectionId: string;
  readonly initializationEventId: string;
  readonly principalId: string;
  readonly template: "vite-react" | "empty";
  readonly region: HostingRegion;
  readonly requestId: string;
  readonly billingEpochId: string;
  readonly state: "waiting" | "queued" | "initializing" | "initialized" | "failed";
  readonly childOperationId: string | null;
  /** This proves the original create permission; it is never used as a project edit grant. */
  readonly creationDelegation: {
    readonly grantId: string;
    readonly clientId: string;
    readonly consentHash: string;
    readonly action: AuthorizationAction;
    readonly authorizationRestriction?: AuthorizationRestriction;
  } | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ManagedSourceInitializationError extends Error {
  constructor(readonly kind: "scope" | "identity" | "state") {
    super(`Managed source initialization ${kind} is unavailable`);
    this.name = "ManagedSourceInitializationError";
  }
}
