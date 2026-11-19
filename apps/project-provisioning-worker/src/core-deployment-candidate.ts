import { Buffer } from "node:buffer";
import { parseUlid } from "@ohmyhost/platform";
import { callBinding, forwardCalls } from "./core-binding-call.js";
import type {
  DeploymentCandidatePort,
  DeploymentCandidateRuntimeBinding,
} from "./deployment-candidate-port.js";
/** Direct named binding calls preserve unknown outcomes; observed data never becomes provider permission. */
export function createCoreDeploymentCandidatePort(
  binding: DeploymentCandidateRuntimeBinding,
): DeploymentCandidatePort {
  return Object.freeze<DeploymentCandidatePort>({
    ...forwardCalls(binding, {
      recordCandidate: "recordProductDeploymentCandidate",
      recordAbandonedGateway: "recordAbandonedGatewayPredecessor",
    }),
    readDataEnvironment: async (input) => {
      const value = await callBinding(binding, "readProductDataEnvironment", input);
      return value === null ? null : parseUlid(value);
    },
    resolveRollback: async (input) => {
      const value = await callBinding(binding, "resolveProductRollbackCandidate", input);
      return value === null
        ? null
        : {
            ...value,
            candidate: {
              ...value.candidate,
              artifactDigest: Buffer.from(value.candidate.artifactDigest),
            },
          };
    },
  });
}
