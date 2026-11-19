import { assertOperationDelegationCurrent } from "../identity/operation-delegations.js";
import { acceptApiOperationInput } from "../operations/accept-api-operation.js";
import { z } from "zod";
import { conflict, routeOrganization, ulid, type CatalogContext } from "../common.js";
import {
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
  type StoredHttpResponse,
} from "../operations/idempotency.js";
import { loadOperation, type StoredOperation } from "../operations/operation-store.js";
import { acceptRecoveryJob, acceptRecoveryJobInput } from "./jobs.js";
import { ProjectRecoveryDailyLimitError } from "./errors.js";
import { readBlockingProductOperation } from "../operations/operation-leases.js";
import { recoveryEnvironmentAllowedSql } from "./shared.js";

const ROUTE = "/v1/projects/{project_id}/exports";
const replayInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(255),
  canonicalRequestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  delegation: acceptApiOperationInput.shape.delegation,
});
const exportInput = acceptRecoveryJobInput.omit({
  environmentId: true,
  billingEpochId: true,
  httpMethod: true,
  routeTemplate: true,
  projectAnchor: true,
  developmentAnchor: true,
});
export type ExportReplay =
  | { outcome: "absent" }
  | { outcome: "conflict" }
  | { outcome: "replayed"; operation: StoredOperation };
export type ExportAcceptance =
  | { outcome: "limited"; retryAt: string }
  | { outcome: "created"; response: StoredHttpResponse }
  | { outcome: "replayed"; operation: StoredOperation };

/** Operation polling is enabled only for the qualified recovery kind. Other existing operation kinds stay explicitly
 * unported here, so their deployment/reconciliation observations cannot silently disappear from a partial reader. */
export async function readRecoveryOperation(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ organizationId: ulid, operationId: ulid }).parse(raw);
  const { db } = await routeOrganization(context, input.organizationId);
  const operation = await loadOperation(context, input);
  if (operation === null) return { outcome: "absent" as const };
  const job = await db
    .prepare(
      "SELECT 1 AS present FROM project_recovery_jobs WHERE organization_id=?1 AND operation_id=?2",
    )
    .bind(input.organizationId, input.operationId)
    .first();
  if (job === null) return { outcome: "unported" as const };
  const blockingOperationId =
    operation.state === "queued" || operation.state === "running"
      ? await readBlockingProductOperation(context, input)
      : null;
  return { outcome: "ready" as const, operation, blockingOperationId };
}

/** Exact route/key/HMAC read before inventory, sealing or identity allocation, as in the original API. */
export async function readExportReplay(
  context: CatalogContext,
  raw: unknown,
): Promise<ExportReplay> {
  const input = replayInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const record = storedIdempotencyRecord(
    await readIdempotencyRecordStatement(db, {
      ...input,
      httpMethod: "POST",
      routeTemplate: ROUTE,
    }).first(),
  );
  if (record === null) return { outcome: "absent" };
  if (record.digestHex !== input.canonicalRequestDigest || record.operationId === null)
    return { outcome: "conflict" };
  await assertOperationDelegationCurrent(context, {
    organizationId: input.organizationId,
    operationId: record.operationId,
  });
  const operation = await loadOperation(context, {
    organizationId: input.organizationId,
    operationId: record.operationId,
  });
  if (operation === null) throw new Error("Project export operation unavailable");
  return { outcome: "replayed", operation };
}

/** Paid projects with canonical Dev retain that anchor; Free or Prod-only projects use their actual Prod identity. The
 * acceptance writes remain ONE guarded batch; the preferred canonical anchor/owner/epoch are checked there again.
 * A first response uses the immutable HTTP receipt (queued), while replay projects the current operation. */
export async function acceptProjectExport(
  context: CatalogContext,
  raw: unknown,
): Promise<ExportAcceptance> {
  const input = exportInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const anchor = await db
    .prepare(
      `SELECT e.environment_id,p.active_billing_epoch_id FROM projects p JOIN environments e
    ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND ${recoveryEnvironmentAllowedSql("e")}
    WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'
      AND EXISTS(SELECT 1 FROM environments prod WHERE prod.organization_id=p.organization_id AND prod.project_id=p.project_id AND prod.name='prod')
    ORDER BY e.name LIMIT 1`,
    )
    .bind(input.organizationId, input.projectId)
    .first<{ environment_id: string; active_billing_epoch_id: string }>();
  if (anchor === null) throw new Error("recovery_database_not_ready");
  try {
    const accepted = await acceptRecoveryJob(context, {
      ...input,
      environmentId: anchor.environment_id,
      billingEpochId: anchor.active_billing_epoch_id,
      httpMethod: "POST",
      routeTemplate: ROUTE,
      projectAnchor: true,
    });
    const operation = await loadOperation(context, {
      organizationId: input.organizationId,
      operationId: accepted.operationId,
    });
    if (operation === null) throw new Error("Project export operation unavailable");
    if (accepted.outcome === "created") {
      // The original generic idempotency row stores operation_id, not the public operation representation. Keep those
      // historical bytes. The first response is the queued acceptance at its stored creation instant, even if the
      // background worker has already advanced the live operation by the time this read returns.
      return {
        outcome: "created",
        response: {
          httpStatus: 202,
          responseHeaders: { Location: `/v1/operations/${accepted.operationId}` },
          responseBody: {
            id: accepted.operationId,
            state: "queued",
            created_at: operation.createdAt,
            updated_at: operation.createdAt,
          },
        },
      };
    }
    return { outcome: "replayed", operation };
  } catch (error) {
    if (error instanceof ProjectRecoveryDailyLimitError)
      return { outcome: "limited", retryAt: error.retryAt };
    // RPC preserves a closed message, not arbitrary properties of a remote Error.
    if (error instanceof Error && /Idempotency/u.test(error.message))
      throw conflict("idempotency_conflict", "Idempotency key reused");
    throw error;
  }
}
