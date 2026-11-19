import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  addMilliseconds,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { text, type Row } from "../provisioning/context-values.js";
import { activeGrantSelect, isUserRevoked } from "../identity/mcp-sql.js";
import { MANAGED_RECIPE, managedInitializationOf } from "./managed-source-reads.js";
import { managedAuthorized, readManagedSnapshot } from "./managed-source-common.js";
import {
  managedInitializationChildStatement,
  managedSourceTerminalStatements,
} from "./managed-source-journal.js";
const scope = z.strictObject({ organizationId: ulid, projectId: ulid }),
  parent = scope.extend({ parentOperationId: ulid });
const now = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
  code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);
/** Queued-recipe metadata only; original processor read needs no current edit grant. */
export async function readProcessorManagedSourceInitialization(
  context: CatalogContext,
  raw: unknown,
) {
  const i = parent.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    r = await db
      .prepare(MANAGED_RECIPE)
      .bind(i.organizationId, i.projectId, i.parentOperationId)
      .first<Row>();
  return r === null ? null : managedInitializationOf(r);
}
/** Original creation consent remains an organization grant; a later attach command creates the project edit grant. */
export async function authorizeProcessorManagedSourceInitialization(
  context: CatalogContext,
  raw: unknown,
) {
  const i = parent.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    recipe = await readProcessorManagedSourceInitialization(context, i);
  if (
    recipe === null ||
    !["queued", "initializing", "initialized", "failed"].includes(recipe.state)
  )
    throw new Error("managed_source_initialization_scope");
  const source = await readManagedSnapshot(db, {
    organizationId: i.organizationId,
    projectId: i.projectId,
    principalId: recipe.principalId,
  });
  if (!managedAuthorized(source, true)) throw new Error("managed_source_initialization_scope");
  const d = recipe.creationDelegation;
  if (d !== null) {
    const userId = recipe.principalId.slice(5),
      r = await activeGrantSelect(
        db,
        {
          organizationId: i.organizationId,
          userId,
          clientId: d.clientId,
          consentHash: d.consentHash,
        },
        null,
        false,
      ).first<{ grant_id: string }>();
    if (r?.grant_id !== d.grantId || (await isUserRevoked(db, userId)))
      throw new Error("managed_source_initialization_scope");
  }
  const op = await db
    .prepare(
      "SELECT 1 valid FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='succeeded' AND billing_epoch_id=?4",
    )
    .bind(i.organizationId, i.projectId, i.parentOperationId, recipe.billingEpochId)
    .first();
  if (op === null) throw new Error("managed_source_initialization_state");
  return recipe;
}
export async function attachProcessorManagedSourceInitializationChild(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = parent.extend({ childOperationId: ulid, now }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE managed_source_initializations AS recipe SET child_operation_id=?4,state=CASE WHEN recipe.state IN('initialized','failed') THEN recipe.state ELSE 'initializing' END,updated_at=?5
 WHERE recipe.organization_id=?1 AND recipe.project_id=?2 AND recipe.parent_operation_id=?3
 AND((recipe.state IN('queued','initializing') AND recipe.child_operation_id IS NULL)OR(recipe.state IN('initializing','initialized','failed') AND recipe.child_operation_id=?4))
 AND EXISTS(SELECT 1 FROM managed_source_publications publication JOIN outbox_events event ON event.operation_id=publication.operation_id AND event.organization_id=publication.organization_id AND event.project_id=publication.project_id AND event.billing_epoch_id=publication.billing_epoch_id AND event.event_type='ManagedSourcePublicationRequestedV1'
 WHERE publication.operation_id=?4 AND publication.organization_id=recipe.organization_id AND publication.project_id=recipe.project_id AND publication.billing_epoch_id=recipe.billing_epoch_id AND publication.source_connection_id=recipe.source_connection_id AND publication.principal_id=recipe.principal_id AND publication.mode='initialize' AND publication.state IN('sealed','committed','failed'))`,
        )
        .bind(i.organizationId, i.projectId, i.parentOperationId, i.childOperationId, i.now),
      guard(db, "precondition_changed", "changes()<>1"),
      managedInitializationChildStatement(db, { ...i, operationId: i.childOperationId }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("guard_precondition_changed"))
      throw new Error("managed_source_initialization_identity");
    throw error;
  }
}
export async function completeProcessorManagedSourceInitializationChild(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = scope.extend({ childOperationId: ulid, now }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  await db.batch([
    managedInitializationChildStatement(db, { ...i, operationId: i.childOperationId }),
  ]);
}
export async function rejectProcessorManagedSourceInitialization(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = parent.extend({ errorCode: code, now }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  await db
    .prepare(
      "UPDATE managed_source_initializations SET state='failed',error_code=?4,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND parent_operation_id=?3 AND state IN('waiting','queued')",
    )
    .bind(i.organizationId, i.projectId, i.parentOperationId, i.errorCode, i.now)
    .run();
}
/**
 * A dispatch acknowledged longer ago than this and still unfinished has no Queue delivery left: the consumer retries every
 * 30 seconds for at most 30 retries (about 15 minutes), then the message is dead-lettered and nothing reads it.
 */
const ACKNOWLEDGED_DISPATCH_LIMIT_MILLISECONDS = 30 * 60 * 1000;
/**
 * An outbox event whose delivery can never succeed: either it used every attempt and was never acknowledged, or it was
 * acknowledged more than 30 minutes before the sweep (the Queue message was dead-lettered or lost). The stale bound is
 * the first parameter, in the stored microsecond form that every acknowledgement carries.
 */
const DISPATCH_NEVER_SUCCEEDS = `((event.attempt_count>=event.max_attempts AND event.reconciliation_required_at IS NOT NULL AND event.acknowledged_at IS NULL AND event.claimed_at IS NULL AND event.lease_expires_at IS NULL)
 OR (event.acknowledged_at IS NOT NULL AND event.acknowledged_at<?1))`;
const EXHAUSTED_PUBLICATION = `SELECT event.organization_id,event.project_id,event.operation_id,event.event_id FROM outbox_events event
 JOIN managed_source_publications publication ON publication.organization_id=event.organization_id AND publication.project_id=event.project_id AND publication.operation_id=event.operation_id
 JOIN operations operation ON operation.organization_id=event.organization_id AND operation.project_id=event.project_id AND operation.operation_id=event.operation_id
 WHERE event.event_type='ManagedSourcePublicationRequestedV1' AND ${DISPATCH_NEVER_SUCCEEDS}
 AND publication.state='sealed' AND operation.state IN ('queued','running')
 ORDER BY COALESCE(event.reconciliation_required_at,event.acknowledged_at),event.event_id LIMIT 1`;
/**
 * A queued initialization whose event can never succeed and which has no child publication: the publisher never reached
 * it, so nothing of it exists at the provider.
 */
const EXHAUSTED_INITIALIZATION = `SELECT recipe.organization_id,recipe.project_id,recipe.parent_operation_id FROM outbox_events event
 JOIN managed_source_initializations recipe ON recipe.organization_id=event.organization_id AND recipe.project_id=event.project_id
  AND recipe.parent_operation_id=event.operation_id AND recipe.initialization_event_id=event.event_id
 WHERE event.event_type='ManagedSourceInitializationRequestedV1' AND ${DISPATCH_NEVER_SUCCEEDS}
 AND recipe.state='queued' AND recipe.child_operation_id IS NULL
 ORDER BY COALESCE(event.reconciliation_required_at,event.acknowledged_at),event.event_id LIMIT 1`;
/**
 * Ends one managed-source dispatch whose delivery can never succeed (see DISPATCH_NEVER_SUCCEEDS). A sealed publication and
 * its operation fail with MANAGED_SOURCE_DISPATCH_FAILED, so the source stops blocking later writes; a queued initialization
 * recipe fails with the same code, so the source reports the failure instead of pending.
 * Returns false when no such dispatch exists.
 */
export async function sweepExhaustedManagedSourcePublication(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  // The reject command validates the exact ISO form of `now`, so the caller's string goes through unchanged.
  const i = z.strictObject({ now: z.string() }).parse(raw);
  const acknowledgedBefore = addMilliseconds(
    instant.parse(i.now),
    -ACKNOWLEDGED_DISPATCH_LIMIT_MILLISECONDS,
  );
  const row = await context.directory
    .prepare(EXHAUSTED_PUBLICATION)
    .bind(acknowledgedBefore)
    .first<Row>();
  if (row === null) return endExhaustedInitialization(context, i.now, acknowledgedBefore);
  return rejectProcessorManagedSourcePublication(context, {
    organizationId: text(row, "organization_id"),
    projectId: text(row, "project_id"),
    operationId: text(row, "operation_id"),
    eventId: text(row, "event_id"),
    errorCode: "MANAGED_SOURCE_DISPATCH_FAILED",
    now: i.now,
  });
}
async function endExhaustedInitialization(
  context: CatalogContext,
  now: string,
  acknowledgedBefore: string,
): Promise<boolean> {
  const row = await context.directory
    .prepare(EXHAUSTED_INITIALIZATION)
    .bind(acknowledgedBefore)
    .first<Row>();
  if (row === null) return false;
  const organizationId = text(row, "organization_id"),
    { db } = await routeOrganization(context, organizationId),
    at = instant.parse(now);
  const changed = await db
    .prepare(
      "UPDATE managed_source_initializations SET state='failed',error_code='MANAGED_SOURCE_DISPATCH_FAILED',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND parent_operation_id=?3 AND state='queued' AND child_operation_id IS NULL",
    )
    .bind(organizationId, text(row, "project_id"), text(row, "parent_operation_id"), at)
    .run();
  return changed.meta.changes === 1;
}
/** Original durable journal/operation observation, also available after a user's edit grant is revoked. */
export async function readProcessorManagedSourceContext(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ operationId: ulid }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    r = await db
      .prepare(
        "SELECT publication.principal_id,publication.state source_state,operation.state operation_state FROM managed_source_publications publication JOIN operations operation USING(organization_id,project_id,operation_id) WHERE publication.organization_id=?1 AND publication.project_id=?2 AND publication.operation_id=?3",
      )
      .bind(i.organizationId, i.projectId, i.operationId)
      .first<Row>();
  return r === null
    ? null
    : {
        principalId: text(r, "principal_id"),
        sourceState: z.enum(["staging", "sealed", "committed", "failed"]).parse(r["source_state"]),
        operationState: z
          .enum(["queued", "running", "succeeded", "failed", "cancelled"])
          .parse(r["operation_state"]),
      };
}
const REJECTION = `SELECT publication.state,publication.principal_id,publication.expires_at,publication.error_code FROM managed_source_publications publication
 JOIN operations operation USING(organization_id,project_id,operation_id,billing_epoch_id)
 JOIN outbox_events event USING(organization_id,project_id,operation_id,billing_epoch_id)
 WHERE publication.organization_id=?1 AND publication.project_id=?2 AND publication.operation_id=?3 AND event.event_type='ManagedSourcePublicationRequestedV1' AND(?4 IS NULL OR publication.principal_id=?4)
 AND(?5 IS NULL OR(event.current_attempt_id=?5 AND event.lease_expires_at>?6))`;
/** Durable rejection owns the original outbox/attempt or principal predicate, even after permission is revoked. */
export async function rejectProcessorManagedSourcePublication(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = scope
      .extend({
        operationId: ulid,
        principalId: z.string().optional(),
        attemptId: ulid.optional(),
        errorCode: z
          .enum([
            "AUTHORIZATION_CHANGED",
            "SOURCE_UPLOAD_EXPIRED",
            "SOURCE_COMMIT_CONFLICT",
            "MANAGED_SOURCE_DISPATCH_FAILED",
          ])
          .optional(),
        eventId: ulid,
        now,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    errorCode = i.errorCode ?? "AUTHORIZATION_CHANGED",
    parameters = [
      i.organizationId,
      i.projectId,
      i.operationId,
      i.principalId ?? null,
      i.attemptId ?? null,
      i.now,
    ];
  const command: Command<Row | null, boolean> = {
    name: "managedSource.rejectPublication",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["operation_events", "audit_events"],
    read: async (reader) => {
      const rows = (
        await reader
          .prepare(REJECTION)
          .bind(...parameters)
          .all<Row>()
      ).results;
      if (rows.length !== 1) throw new Error("managed_source_scope");
      return rows[0] ?? null;
    },
    decide: (r) => {
      if (r === null) throw new Error("managed_source_scope");
      if (r["state"] === "committed") return { replay: false };
      if (r["state"] === "failed") return { replay: r["error_code"] === errorCode };
      if (errorCode === "SOURCE_UPLOAD_EXPIRED" && String(r["expires_at"]) > i.now)
        throw new Error("managed_source_expired");
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `(SELECT count(*) FROM(${REJECTION}))<>1 OR NOT EXISTS(SELECT 1 FROM(${REJECTION}) current WHERE state=?7 AND principal_id=?8 AND expires_at=?9 AND error_code IS ?10)`,
            [...parameters, r["state"], r["principal_id"], r["expires_at"], r["error_code"]],
          ),
          db
            .prepare(
              "UPDATE managed_source_publications SET state='failed',error_code=?2,updated_at=?3 WHERE operation_id=?1",
            )
            .bind(i.operationId, errorCode, i.now),
          ...managedSourceTerminalStatements(
            db,
            { ...i, principalId: text(r, "principal_id") },
            "failed",
            { error_code: errorCode },
          ),
          managedInitializationChildStatement(db, i),
        ],
        result: () => true,
      };
    },
  };
  return runCommand(db, command);
}
