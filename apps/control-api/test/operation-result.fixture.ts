import { createOperationDeploymentResult } from "@ohmyhost/platform";

export function operationDeploymentResultFixture(input: {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly planId: string;
}) {
  return createOperationDeploymentResult({
    operationId: input.operationId,
    deploymentId: input.deploymentId,
    planId: input.planId,
    artifactSha256: "4".repeat(64),
    url: "https://demo.ohmyho.st/",
  });
}
