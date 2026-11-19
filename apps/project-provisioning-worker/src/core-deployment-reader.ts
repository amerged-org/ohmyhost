import { Buffer } from "node:buffer";
import { callBinding, forwardCalls } from "./core-binding-call.js";
import type {
  DeploymentPersistenceReaderPort,
  DeploymentWorkflowRuntimeBinding,
} from "./deployment-persistence-port.js";

/** Named calls on the binding itself. This is a partial reader/claim port, never a fake SQL client or full Workflow placeholder. */
export function createCoreDeploymentReaderPort(
  binding: DeploymentWorkflowRuntimeBinding,
): DeploymentPersistenceReaderPort {
  return Object.freeze<DeploymentPersistenceReaderPort>({
    readContext: async (input) => {
      const value = await callBinding(binding, "readProductWorkflowContext", {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        operationId: input.operationId,
      });
      return value === null
        ? null
        : {
            ...value,
            intent: {
              ...value.intent,
              sourceArtifactDigest:
                value.intent.sourceArtifactDigest === null
                  ? null
                  : Buffer.from(value.intent.sourceArtifactDigest),
              sourceDigest:
                value.intent.sourceDigest === null ? null : Buffer.from(value.intent.sourceDigest),
              buildPlanDigest:
                value.intent.buildPlanDigest === null
                  ? null
                  : Buffer.from(value.intent.buildPlanDigest),
            },
          };
    },
    ...forwardCalls(binding, {
      readDatabaseTarget: "readProductWorkflowDatabaseTarget",
      claimProviderMutation: "claimProductProviderMutation",
    }),
  });
}
