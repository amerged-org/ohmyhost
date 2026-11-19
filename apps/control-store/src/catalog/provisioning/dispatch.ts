import {
  recoverExpiredOperationLease,
  releaseStaleTerminalClaim,
} from "../operations/operation-leases.js";
import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  conflict,
  fenceRaceGuard,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import {
  claimOutboxEvent,
  recoverExpiredFinalOutboxLease,
  acknowledgeOutboxEvent,
  recordOutboxDeliveryFailure,
  requireOutboxReconciliation,
} from "../operations/outbox.js";

export const PRODUCT_DISPATCH_EVENTS = [
  "SourceLinkRequestedV1",
  "DeploymentRequestedV1",
  "DeploymentRollbackRequestedV1",
  "DeploymentPromotionRequestedV1",
  "ProjectHandleChangeRequestedV1",
  "ProjectDeletionRequestedV1",
  "ProjectDataChangeRequestedV1",
] as const;
const MANAGED_DISPATCH_EVENTS = [
  "ManagedSourcePublicationRequestedV1",
  "ManagedSourceInitializationRequestedV1",
] as const;
const groups = {
  provisioning: ["ProjectProvisioningRequested"],
  product: PRODUCT_DISPATCH_EVENTS,
  managedSource: MANAGED_DISPATCH_EVENTS,
} as const;
export type DispatchFamily = keyof typeof groups;
const claim = z.strictObject({ attemptId: ulid, now: instant });
const recover = z.strictObject({ auditEventId: ulid, now: instant });
const exact = z.strictObject({ eventId: ulid, attemptId: ulid });
const acknowledge = exact.extend({ now: instant });
const failure = exact.extend({
  auditEventId: ulid,
  failedAt: instant,
  errorCode: z.enum([
    "PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT",
    "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN",
    "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR",
    "PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID",
    "PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID",
    "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN",
    "MANAGED_SOURCE_QUEUE_SEND_UNCERTAIN",
    "INVALID_PROJECT_PROVISIONING_MESSAGE",
  ]),
  cause: z.string().optional(),
});
/** Fixed event-family drains, one Core authority; no caller-selected table, SQL, event list or actor. */
export async function claimProjectDispatch(
  context: CatalogContext,
  family: DispatchFamily,
  raw: unknown,
) {
  const input = claim.parse(raw);
  return claimOutboxEvent(context, {
    ...input,
    shardId: 0,
    leaseMilliseconds: 30_000,
    supportedEventTypes: groups[family],
    ...(family === "provisioning" ? {} : { excludeProjectsWithActiveProviderMutation: true }),
  });
}
export async function recoverProjectDispatch(
  context: CatalogContext,
  family: DispatchFamily,
  raw: unknown,
) {
  const input = recover.parse(raw);
  return recoverExpiredFinalOutboxLease(context, {
    ...input,
    shardId: 0,
    supportedEventTypes: groups[family],
    actorType: "service",
    actorId: "project-provisioning-worker",
  });
}
async function locate(
  context: CatalogContext,
  family: DispatchFamily,
  input: z.output<typeof exact>,
) {
  const event = await context.directory
    .prepare(
      `SELECT organization_id,project_id,operation_id,attempt_count,max_attempts FROM outbox_events WHERE event_id=?1 AND EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.event_id=outbox_events.event_id AND attempt.attempt_id=?2) AND event_type IN(SELECT value FROM json_each(?3))`,
    )
    .bind(input.eventId, input.attemptId, JSON.stringify(groups[family]))
    .first<{
      organization_id: string;
      project_id: string;
      operation_id: string;
      attempt_count: number;
      max_attempts: number;
    }>();
  if (event === null) throw conflict("claim_lost", "Project dispatch attempt is stale");
  return event;
}
export async function acknowledgeProjectDispatch(
  context: CatalogContext,
  family: DispatchFamily,
  raw: unknown,
) {
  const input = acknowledge.parse(raw),
    event = await locate(context, family, input);
  return acknowledgeOutboxEvent(context, { ...input, organizationId: event.organization_id });
}
export async function failProjectDispatch(
  context: CatalogContext,
  family: DispatchFamily,
  raw: unknown,
) {
  const input = failure.parse(raw),
    event = await locate(context, family, input),
    exhausted = event.attempt_count >= event.max_attempts;
  const allowed =
    family === "provisioning"
      ? input.errorCode.startsWith("PROJECT_PROVISIONING_") ||
        input.errorCode === "INVALID_PROJECT_PROVISIONING_MESSAGE"
      : input.errorCode ===
        (family === "product"
          ? "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN"
          : "MANAGED_SOURCE_QUEUE_SEND_UNCERTAIN");
  if (!allowed) throw new TypeError("Dispatch diagnostic family differs");
  const audit = {
    auditEventId: input.auditEventId,
    projectId: event.project_id,
    operationId: event.operation_id,
    eventType:
      exhausted || input.errorCode === "INVALID_PROJECT_PROVISIONING_MESSAGE"
        ? "OutboxReconciliationRequired"
        : "OutboxRetryScheduled",
    actorType: "service",
    actorId: "project-provisioning-worker",
    occurredAt: input.failedAt,
    payload:
      family === "provisioning"
        ? input.errorCode === "INVALID_PROJECT_PROVISIONING_MESSAGE"
          ? { reasonCode: input.errorCode }
          : { cause: input.cause ?? "definitive_configuration" }
        : { reasonCode: input.errorCode },
  };
  if (input.errorCode === "INVALID_PROJECT_PROVISIONING_MESSAGE")
    return requireOutboxReconciliation(context, {
      organizationId: event.organization_id,
      eventId: input.eventId,
      attemptId: input.attemptId,
      errorCode: input.errorCode,
      reconciledAt: input.failedAt,
      audit,
    });
  return recordOutboxDeliveryFailure(context, {
    organizationId: event.organization_id,
    eventId: input.eventId,
    attemptId: input.attemptId,
    errorCode: input.errorCode,
    failedAt: input.failedAt,
    ...(exhausted
      ? {}
      : { nextAvailableAt: new Date(Date.parse(input.failedAt) + 5_000).toISOString() }),
    audit,
  });
}
const accept = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  eventId: ulid,
  attemptId: ulid,
  workflowId: z.string().trim().min(1).max(255),
  acceptedAt: instant,
});
export interface ProductDispatchIntent {
  eventType: (typeof PRODUCT_DISPATCH_EVENTS)[number];
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
  billingEpochId: string;
  planId: string | null;
  requestedHandle: string | null;
  dataChange:
    | "isolate_prod_keeps_data"
    | "isolate_dev_keeps_data"
    | "share_prod_keeps_data"
    | "reset_dev"
    | null;
}
type Row = Record<string, unknown>;
function projection(row: Row): ProductDispatchIntent {
  return {
    eventType: row["event_type"] as ProductDispatchIntent["eventType"],
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    operationId: String(row["operation_id"]),
    billingEpochId: String(row["billing_epoch_id"]),
    planId: row["plan_id"] as string | null,
    requestedHandle: row["requested_handle"] as string | null,
    dataChange: row["data_change"] as ProductDispatchIntent["dataChange"],
  };
}
/** Immutable intent projection and first accepted run share the original transaction. Claim/ACK remain separate. */
export async function acceptProductDispatch(
  context: CatalogContext,
  raw: unknown,
): Promise<ProductDispatchIntent> {
  const input = accept.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const values = [input.organizationId, input.projectId, input.environmentId, input.operationId];
  const command: Command<
    { intent: Row | undefined; run: Row | undefined; event: Row | undefined },
    ProductDispatchIntent
  > = {
    name: "provisioning.acceptProductDispatch",
    input,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["product_workflow_runs"],
    read: async (reader) => {
      const [intent, run, event] = await reader.batch([
        reader
          .prepare(
            `SELECT * FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4`,
          )
          .bind(...values),
        reader
          .prepare(
            `SELECT * FROM product_workflow_runs WHERE workflow_id=?1 OR (organization_id=?2 AND project_id=?3 AND environment_id=?4 AND operation_id=?5)`,
          )
          .bind(
            input.workflowId,
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.operationId,
          ),
        reader
          .prepare(
            `SELECT * FROM outbox_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_id=?4 AND current_attempt_id=?5`,
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.operationId,
            input.eventId,
            input.attemptId,
          ),
      ]);
      return { intent: intent?.results[0], run: run?.results[0], event: event?.results[0] };
    },
    decide: ({ intent, run, event }) => {
      if (
        !intent ||
        !event ||
        event["event_type"] !== intent["event_type"] ||
        event["billing_epoch_id"] !== intent["billing_epoch_id"] ||
        !PRODUCT_DISPATCH_EVENTS.includes(
          intent["event_type"] as (typeof PRODUCT_DISPATCH_EVENTS)[number],
        ) ||
        JSON.stringify(JSON.parse(String(event["payload"]))) !==
          JSON.stringify({ environmentId: input.environmentId })
      )
        return {
          reject: conflict(
            "product_dispatch_conflict",
            "Claimed product command has no immutable intent",
          ),
        };
      const result = projection(intent);
      if (run) {
        if (
          run["workflow_id"] !== input.workflowId ||
          run["event_id"] !== input.eventId ||
          run["organization_id"] !== input.organizationId ||
          run["project_id"] !== input.projectId ||
          run["environment_id"] !== input.environmentId ||
          run["operation_id"] !== input.operationId ||
          run["billing_epoch_id"] !== result.billingEpochId ||
          run["event_type"] !== result.eventType
        )
          return {
            reject: conflict("product_dispatch_conflict", "Product Workflow identity changed"),
          };
        return { replay: result };
      }
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", input.organizationId),
          guard(
            db,
            "operation_conflict",
            `NOT EXISTS(SELECT 1 FROM outbox_events WHERE organization_id=?1 AND event_id=?2 AND current_attempt_id=?3)`,
            [input.organizationId, input.eventId, input.attemptId],
          ),
          db
            .prepare(
              `INSERT INTO product_workflow_runs(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9,?9)`,
            )
            .bind(
              input.workflowId,
              input.eventId,
              ...values,
              result.billingEpochId,
              result.eventType,
              input.acceptedAt,
            ),
        ],
        result: () => result,
      };
    },
  };
  return runCommand(db, command);
}
const intentScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
});
export async function readProductDispatchIntent(
  context: CatalogContext,
  raw: unknown,
): Promise<ProductDispatchIntent | null> {
  const v = intentScope.parse(raw),
    { db } = await routeOrganization(context, v.organizationId);
  const r = await db
    .prepare(
      `SELECT * FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4`,
    )
    .bind(v.organizationId, v.projectId, v.environmentId, v.operationId)
    .first<Row>();
  return r === null ? null : projection(r);
}

export async function recoverProductDispatchExecution(context: CatalogContext, raw: unknown) {
  const v = z.strictObject({ now: instant }).parse(raw);
  const recovered = await recoverExpiredOperationLease(context, { ...v, shardId: 0 });
  // The publisher stops at the first null, so a tick releases at most one stale claim, and only after no lease is expired.
  if (recovered === null) await releaseStaleTerminalClaim(context, { ...v, shardId: 0 });
  return recovered;
}
