/* v8 ignore file -- closed reconciliation data contract */
import type { ProductCommandWorkflowPorts } from "@ohmyhost/orchestrator";
import type { reconcileProductCommand } from "@ohmyhost/database/provisioning-persistence";
export interface DeploymentReconciliationPort {
  requireReconciliation: ProductCommandWorkflowPorts["persistence"]["requireReconciliation"];
}
export type DeploymentReconciliationInput = Omit<
  Extract<Parameters<typeof reconcileProductCommand>[1], { workflowId: string }>,
  "actorId" | "errorCode"
> & { readonly bindingsOutdated: boolean; readonly diagnosticId?: string };
export interface DeploymentReconciliationRuntimeBinding {
  reconcileProductWorkflow(
    input: DeploymentReconciliationInput,
  ): Promise<"reconciliation_required" | "replayed">;
}
