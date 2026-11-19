/* v8 ignore file -- closed original step-lease wire contract */
export interface DeploymentLeaseRuntimeBinding {
  renewProductOperationLease(input: {
    readonly organizationId: string;
    readonly operationId: string;
    readonly workflowId: string;
    readonly physicalWorkflowId: string;
    readonly now: string;
    readonly durationMilliseconds: number;
  }): Promise<void>;
}
