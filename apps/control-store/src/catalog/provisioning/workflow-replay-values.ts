// Literal original message/input decisions.
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import type { ProductWorkflowReplayCandidate } from "./workflow-replay-queries.js";
export function originalMessage(row: {
  event_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  operation_id: string;
  billing_epoch_id: string;
  event_type: ProductWorkflowReplayCandidate["eventType"];
  data_change?: string | null;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: 1,
    eventType: row.event_type,
    eventId: row.event_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    operationId: row.operation_id,
    billingEpochId: row.billing_epoch_id,
    ...(row.event_type === "ProjectDataChangeRequestedV1" ? { dataChange: row.data_change } : {}),
  });
}

export function validateReplayInput(input: {
  readonly attemptId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly billingEpochId: Ulid;
  readonly logicalWorkflowId: string;
  readonly physicalWorkflowId: string;
  readonly actorId: string;
  readonly idempotencyDigest: Uint8Array;
  readonly preparedAt: string;
}): void {
  for (const value of [
    input.attemptId,
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.eventId,
    input.billingEpochId,
  ])
    parseUlid(value);
  if (
    input.logicalWorkflowId.trim() !== input.logicalWorkflowId ||
    input.logicalWorkflowId.length === 0 ||
    input.logicalWorkflowId.length > 255 ||
    input.physicalWorkflowId !== `product-command-replay-v1-${input.attemptId}` ||
    input.actorId.trim() !== input.actorId ||
    input.actorId.length === 0 ||
    input.actorId.length > 255 ||
    input.idempotencyDigest.byteLength !== 32 ||
    new Date(input.preparedAt).toISOString() !== input.preparedAt
  ) {
    throw new TypeError("Product Workflow replay input is invalid");
  }
}
