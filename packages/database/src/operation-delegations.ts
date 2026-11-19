import type { AuthorizationAction, AuthorizationRestriction } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface OperationDelegation {
  readonly grantId: string;
  readonly clientId: string;
  readonly consentHash: string;
  readonly action: AuthorizationAction;
  readonly authorizationRestriction?: AuthorizationRestriction;
}
interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
}
export class OperationAuthorizationConflictError extends Error {
  readonly code = "operation_authorization_changed" as const;
  constructor() {
    super("Queued operation authorization or source generation changed");
    this.name = "OperationAuthorizationConflictError";
  }
}

/** Every provider write and activation rechecks consent and the pinned source selection. */
export declare function assertOperationExecutionAuthorized(
  client: TransactionClient,
  input: Scope,
): Promise<void>;
