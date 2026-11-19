/* v8 ignore file -- fixed SourceLink completion data contracts */
import type { Ulid } from "@ohmyhost/platform";
import type { ProductCommandWorkflowPorts, ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
export type SourceCompletionInput = Omit<
  Parameters<ProductCommandWorkflowPorts["persistence"]["complete"]>[0],
  "command"
> & { command: Extract<ProductCommandMessageV1, { eventType: "SourceLinkRequestedV1" }> };
export interface SourceCompletionPort {
  complete(input: SourceCompletionInput): Promise<"applied" | "duplicate">;
}
export interface SourceCompletionRuntimeInput {
  eventType: "SourceLinkRequestedV1";
  workflowId: string;
  reconciliationAttemptId?: Ulid;
  replayAttemptId?: Ulid;
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
  operationId: Ulid;
  outboxEventId: Ulid;
  startedOperationEventId: Ulid;
  operationEventId: Ulid;
  auditEventId: Ulid;
  externalRepositoryId: string;
  completedAt: string;
}
export interface SourceCompletionRuntimeBinding {
  completeSourceLink(input: SourceCompletionRuntimeInput): Promise<"completed" | "replayed">;
}
