import { z } from "zod";

import { runCommand, type Command } from "../../run-command.js";
import {
  auditRecordInput,
  auditStatement,
  conflict,
  instant,
  outboxRecordInput,
  outboxStatement,
  ownershipGuard,
  queuedOperationStatements,
  ringDoorbell,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";

export const queueOperationInput = z.strictObject({
  organizationId: ulid,
  billingEpochId: ulid,
  operation: z.strictObject({
    operationId: ulid,
    projectId: ulid,
    eventId: ulid,
    occurredAt: instant,
  }),
  audit: auditRecordInput.extend({ projectId: ulid, operationId: ulid }),
  outbox: outboxRecordInput,
});

export type QueueOperationInput = z.input<typeof queueOperationInput>;

interface Snapshot {
  readonly existing: { readonly project_id: string } | null;
  readonly owned: boolean;
}

/**
 * `persistQueuedOperationForCurrentOwner`: a new queued operation with its first event, audit event and
 * outbox event, for a project the organization actively owns at the given billing epoch. Re-sending the same
 * operation answers `existing`; an operation id that belongs to something else is a conflict.
 */
export async function queueOperation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<"created" | "existing"> {
  const input = queueOperationInput.parse(rawInput);
  if (
    input.audit.projectId !== input.operation.projectId ||
    input.audit.operationId !== input.operation.operationId
  ) {
    throw new TypeError("Audit event must share the operation scope");
  }
  const shard = await routeOrganization(context, input.organizationId);
  const scope = {
    organizationId: input.organizationId,
    projectId: input.operation.projectId,
    operationId: input.operation.operationId,
    billingEpochId: input.billingEpochId,
  };
  const command: Command<Snapshot, "created" | "existing"> = {
    name: "operations.queueOperation",
    input,
    retryOn: ["scope_inactive"],
    naturalKeyTables: ["operations"],
    read: async (reader) => {
      const [existing, owned] = await reader.batch([
        reader
          .prepare(
            "SELECT project_id FROM operations WHERE organization_id = ?1 AND operation_id = ?2",
          )
          .bind(input.organizationId, input.operation.operationId),
        reader
          .prepare(
            "SELECT 1 AS owned FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND active_billing_epoch_id = ?3 AND owner_state = 'active'",
          )
          .bind(input.organizationId, input.operation.projectId, input.billingEpochId),
      ]);
      return {
        existing: ((existing?.results ?? [])[0] as Snapshot["existing"]) ?? null,
        owned: (owned?.results ?? []).length === 1,
      };
    },
    decide: ({ existing, owned }) => {
      if (existing !== null) {
        return existing.project_id === input.operation.projectId
          ? { replay: "existing" }
          : { reject: conflict("operation_id_taken", "Operation id belongs to another project") };
      }
      if (!owned) {
        return {
          reject: conflict("scope_inactive", "Organization does not actively own the project"),
        };
      }
      return {
        statements: [
          ownershipGuard(shard.db, {
            organizationId: input.organizationId,
            projectId: input.operation.projectId,
            billingEpochId: input.billingEpochId,
          }),
          ...queuedOperationStatements(shard.db, scope, {
            eventId: input.operation.eventId,
            occurredAt: input.operation.occurredAt,
          }),
          auditStatement(shard.db, input.organizationId, {
            ...input.audit,
            billingEpochId: input.billingEpochId,
          }),
          outboxStatement(shard.db, scope, input.outbox),
        ],
        result: () => "created",
      };
    },
  };
  const result = await runCommand(shard.db, command);
  await ringDoorbell(
    context.directory,
    "outbox",
    shard.shardId,
    input.outbox.availableAt ?? input.outbox.createdAt,
  );
  return result;
}
