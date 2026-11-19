import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
const input = z.strictObject({
  version: z.literal(1),
  eventType: z.enum([
    "ManagedSourcePublicationRequestedV1",
    "ManagedSourceInitializationRequestedV1",
  ]),
  eventId: ulid,
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  billingEpochId: ulid,
  environmentId: ulid,
});
/** Exact original Queue provenance: no provider response can substitute for the durable child journal/operation. */
export async function readManagedSourceDispatchState(context: CatalogContext, raw: unknown) {
  const v = input.parse(raw),
    { db } = await routeOrganization(context, v.organizationId),
    values = [
      v.eventId,
      v.organizationId,
      v.projectId,
      v.operationId,
      v.billingEpochId,
      v.environmentId,
      v.eventType,
    ];
  if (v.eventType === "ManagedSourceInitializationRequestedV1") {
    const result = await db
      .prepare(
        `SELECT initialization.state,initialization.child_operation_id,child.state AS child_state,child_operation.state AS child_operation_state,
   (child.state IN ('sealed','committed','failed') AND EXISTS(SELECT 1 FROM outbox_events child_event WHERE child_event.operation_id=child.operation_id AND child_event.organization_id=child.organization_id
   AND child_event.project_id=child.project_id AND child_event.billing_epoch_id=child.billing_epoch_id AND child_event.event_type='ManagedSourcePublicationRequestedV1'
   AND json(child_event.payload)=json_object('environmentId',?6))) IS TRUE AS handoff
 FROM outbox_events event JOIN managed_source_initializations initialization ON initialization.parent_operation_id=event.operation_id AND initialization.organization_id=event.organization_id
   AND initialization.project_id=event.project_id AND initialization.billing_epoch_id=event.billing_epoch_id AND initialization.initialization_event_id=event.event_id
 JOIN operations parent ON parent.operation_id=event.operation_id AND parent.organization_id=event.organization_id AND parent.project_id=event.project_id AND parent.billing_epoch_id=event.billing_epoch_id
 LEFT JOIN managed_source_publications child ON child.operation_id=initialization.child_operation_id AND child.organization_id=initialization.organization_id AND child.project_id=initialization.project_id
   AND child.billing_epoch_id=initialization.billing_epoch_id AND child.source_connection_id=initialization.source_connection_id
 LEFT JOIN operations child_operation ON child_operation.operation_id=child.operation_id AND child_operation.organization_id=child.organization_id AND child_operation.project_id=child.project_id AND child_operation.billing_epoch_id=child.billing_epoch_id
 WHERE event.event_id=?1 AND event.organization_id=?2 AND event.project_id=?3 AND event.operation_id=?4 AND event.billing_epoch_id=?5 AND parent.state='succeeded' AND event.event_type=?7
   AND json(event.payload)=json_object('environmentId',?6)`,
      )
      .bind(...values)
      .all<{
        state: string;
        child_operation_id: string | null;
        child_state: string | null;
        child_operation_state: string | null;
        handoff: number;
      }>();
    const r = result.results[0];
    if (
      result.results.length !== 1 ||
      !r ||
      !["waiting", "queued", "initializing", "initialized", "failed"].includes(r.state)
    )
      throw new Error("Managed source initialization message has no exact durable provenance");
    return {
      kind: "initialization" as const,
      state: r.state,
      childOperationId: r.child_operation_id,
      childState: r.child_state,
      childOperationState: r.child_operation_state,
      handoff: r.handoff === 1,
    };
  }
  const result = await db
    .prepare(
      `SELECT publication.state,operation.state AS operation_state,initialization.state AS initialization_state
 FROM outbox_events event JOIN managed_source_publications publication ON publication.operation_id=event.operation_id AND publication.organization_id=event.organization_id AND publication.project_id=event.project_id AND publication.billing_epoch_id=event.billing_epoch_id
 JOIN operations operation ON operation.operation_id=event.operation_id AND operation.organization_id=event.organization_id AND operation.project_id=event.project_id AND operation.billing_epoch_id=event.billing_epoch_id
 LEFT JOIN managed_source_initializations initialization ON initialization.child_operation_id=publication.operation_id
 WHERE event.event_id=?1 AND event.organization_id=?2 AND event.project_id=?3 AND event.operation_id=?4 AND event.billing_epoch_id=?5 AND event.event_type=?7
   AND json(event.payload)=json_object('environmentId',?6) AND(initialization.parent_operation_id IS NULL OR(initialization.organization_id=publication.organization_id
   AND initialization.project_id=publication.project_id AND initialization.billing_epoch_id=publication.billing_epoch_id AND initialization.source_connection_id=publication.source_connection_id))`,
    )
    .bind(...values)
    .all<{ state: string; operation_state: string; initialization_state: string | null }>();
  const r = result.results[0];
  if (
    result.results.length !== 1 ||
    !r ||
    !["staging", "sealed", "committed", "failed"].includes(r.state) ||
    (r.initialization_state !== null &&
      !["waiting", "queued", "initializing", "initialized", "failed"].includes(
        r.initialization_state,
      ))
  )
    throw new Error("Managed source Queue message has no exact durable provenance");
  return {
    kind: "publication" as const,
    state: r.state,
    operationState: r.operation_state,
    initializationState: r.initialization_state,
  };
}
