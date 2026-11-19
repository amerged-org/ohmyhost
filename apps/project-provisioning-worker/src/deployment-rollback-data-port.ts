/* v8 ignore file -- original rollback data-target contract */
import type { readRollbackPlanTarget } from "@ohmyhost/database/provisioning-persistence";
export interface DeploymentRollbackDataPort {
  readRollbackDataTarget(
    input: Parameters<typeof readRollbackPlanTarget>[1],
  ): ReturnType<typeof readRollbackPlanTarget>;
}
export interface DeploymentRollbackDataRuntimeBinding {
  readProductRollbackDataTarget(input: Parameters<typeof readRollbackPlanTarget>[1]): Promise<
    | (Omit<NonNullable<Awaited<ReturnType<typeof readRollbackPlanTarget>>>, "artifactDigest"> & {
        readonly artifactDigest: Uint8Array;
      })
    | null
  >;
}
