import { Buffer } from "node:buffer";
import type {
  DeploymentRollbackDataPort,
  DeploymentRollbackDataRuntimeBinding,
} from "./deployment-rollback-data-port.js";
export function createCoreDeploymentRollbackDataPort(
  binding: DeploymentRollbackDataRuntimeBinding,
): DeploymentRollbackDataPort {
  return Object.freeze<DeploymentRollbackDataPort>({
    readRollbackDataTarget: async (input) => {
      const result = await binding.readProductRollbackDataTarget(input);
      return result === null
        ? null
        : { ...result, artifactDigest: Buffer.from(result.artifactDigest) };
    },
  });
}
