/* v8 ignore file -- closed deployment authorization contracts */
import type { Ulid } from "@ohmyhost/platform";
export interface DeploymentAuthorizationScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
}
export type DeploymentActivationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly supersededById: Ulid };
export interface DeploymentAuthorizationPort {
  assertExecution(input: DeploymentAuthorizationScope): Promise<void>;
  authorizeActivation(
    input: DeploymentAuthorizationScope & { readonly candidateReceiptId?: Ulid },
  ): Promise<DeploymentActivationDecision>;
}
export interface DeploymentAuthorizationRuntimeBinding {
  assertProductOperationExecution(input: DeploymentAuthorizationScope): Promise<void>;
  authorizeProductActivation(
    input: DeploymentAuthorizationScope & { readonly candidateReceiptId?: Ulid },
  ): Promise<DeploymentActivationDecision>;
}
