/* v8 ignore file -- type-only closed parent transaction contracts */
import type { ProductCommandWorkflowPorts } from "@ohmyhost/orchestrator";
import type {
  failProductDeploymentCommand,
  recordRuntimeHealthDiagnostic,
} from "@ohmyhost/database/provisioning-persistence";
export type DeploymentTerminalPort = Pick<
  ProductCommandWorkflowPorts["persistence"],
  "fail" | "recordHealthFailure"
>;
export interface DeploymentTerminalRuntimeBinding {
  failProductDeployment(
    input: Parameters<typeof failProductDeploymentCommand>[1],
  ): ReturnType<typeof failProductDeploymentCommand>;
  recordRuntimeHealthDiagnostic(
    input: Parameters<typeof recordRuntimeHealthDiagnostic>[1],
  ): ReturnType<typeof recordRuntimeHealthDiagnostic>;
}
