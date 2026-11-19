import { callBinding } from "./core-binding-call.js";
import type {
  DeploymentAuthorizationPort,
  DeploymentAuthorizationRuntimeBinding,
} from "./deployment-authorization-port.js";
/** Callers hold the whole parsed command; the Core refuses any key beyond its closed scope, so each port narrows it here. */
export function createCoreDeploymentAuthorizationPort(
  binding: DeploymentAuthorizationRuntimeBinding,
): DeploymentAuthorizationPort {
  return Object.freeze<DeploymentAuthorizationPort>({
    assertExecution: ({ organizationId, projectId, operationId }) =>
      callBinding(binding, "assertProductOperationExecution", {
        organizationId,
        projectId,
        operationId,
      }),
    authorizeActivation: ({ organizationId, projectId, operationId, candidateReceiptId }) =>
      callBinding(binding, "authorizeProductActivation", {
        organizationId,
        projectId,
        operationId,
        ...(candidateReceiptId === undefined ? {} : { candidateReceiptId }),
      }),
  });
}
