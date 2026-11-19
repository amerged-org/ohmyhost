import { z } from "zod";
import { Buffer } from "node:buffer";
import { guard } from "../../guards.js";
import { fenceRaceGuard, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readWorkflowDelegation } from "../provisioning/authority.js";
import {
  domainPolicyExecutionGuards,
  handleDomainAuthorityGuards,
  paidDomainAuthorityGuards,
} from "./native-auth-domain-sync.js";
import { handoffAuthorityInput } from "./handoff-effect.js";
import { bytesOf } from "../platform-support.js";

const fresh = z.strictObject({ organizationId: ulid, projectId: ulid, operationId: ulid });
const unavailable = () => new Error("Native domain recovery unavailable");
const paid = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  hostname: z.string().min(1).max(253),
  principalId: z.string().min(1).max(256),
  delegation: handoffAuthorityInput.optional(),
  idempotencyKeySha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  requestSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

/** A fresh Owner deletion can adopt only the same already-retiring Paid hostname. */
export async function beginPaidDomainRecovery(context: CatalogContext, raw: unknown) {
  const i = paid.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    recoveryId = i.idempotencyKeySha256.slice(7);
  const row = await db
    .prepare(
      `SELECT lower(hex(d.delete_idempotency_sha256)) identity,d.hostname FROM paid_project_domains d JOIN native_auth_domain_operations p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.kind='paid_delete' AND p.identity=lower(hex(d.delete_idempotency_sha256)) AND p.state='pending' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.state='deleting'`,
    )
    .bind(i.organizationId, i.projectId)
    .first<{ identity: string; hostname: string }>();
  if (!row || row.identity === recoveryId) return null;
  if (row.hostname !== i.hostname) throw unavailable();
  const values = [i.organizationId, i.projectId, row.identity, recoveryId],
    delegation = i.delegation === undefined ? null : JSON.stringify(i.delegation),
    request = Uint8Array.from(Buffer.from(i.requestSha256.slice(7), "hex"));
  await db.batch([
    fenceRaceGuard(db, "operation_conflict", i.organizationId),
    ...paidDomainAuthorityGuards(db, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      principalId: i.principalId,
      ...(i.delegation === undefined ? {} : { delegation: i.delegation }),
    }),
    guard(
      db,
      "operation_conflict",
      "NOT EXISTS(SELECT 1 FROM paid_project_domains d JOIN native_auth_domain_operations p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.kind='paid_delete' AND p.identity=?3 AND p.state='pending' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.state='deleting' AND lower(hex(d.delete_idempotency_sha256))=?3 AND d.hostname=?5)",
      [...values, i.hostname],
    ),
    guard(
      db,
      "operation_conflict",
      "EXISTS(SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?4)",
      values,
    ),
    db
      .prepare(
        "UPDATE native_auth_domain_recoveries SET state='cancelled' WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3 AND recovery_id<>?4 AND state='pending'",
      )
      .bind(...values),
    db
      .prepare(
        "INSERT INTO native_auth_domain_recoveries(organization_id,project_id,kind,identity,recovery_id,principal_id,delegation,request_sha256,recovery_operation_id,state) VALUES(?1,?2,'paid_delete',?3,?4,?5,?6,?7,NULL,'pending') ON CONFLICT DO NOTHING",
      )
      .bind(...values, i.principalId, delegation, request),
    guard(
      db,
      "operation_conflict",
      "NOT EXISTS(SELECT 1 FROM native_auth_domain_recoveries WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3 AND recovery_id=?4 AND principal_id=?5 AND delegation IS ?6 AND request_sha256=?7 AND state='pending')",
      [...values, i.principalId, delegation, request],
    ),
  ]);
  return {
    organizationId: i.organizationId,
    projectId: i.projectId,
    kind: "paid_delete" as const,
    identity: row.identity,
    recoveryId,
  };
}

/** Keep the withdrawn origin fenced, then transfer only the retiring connection to the fresh request. */
export async function completePaidDomainRecovery(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        organizationId: ulid,
        projectId: ulid,
        kind: z.literal("paid_delete"),
        identity: z.string().regex(/^[a-f0-9]{64}$/u),
        recoveryId: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      "SELECT r.principal_id,r.delegation,r.request_sha256,d.hostname FROM native_auth_domain_recoveries r JOIN paid_project_domains d ON d.organization_id=r.organization_id AND d.project_id=r.project_id WHERE r.organization_id=?1 AND r.project_id=?2 AND r.kind='paid_delete' AND r.identity=?3 AND r.recovery_id=?4 AND r.state='pending' AND d.state='deleting' AND lower(hex(d.delete_idempotency_sha256))=r.identity",
    )
    .bind(i.organizationId, i.projectId, i.identity, i.recoveryId)
    .first<{
      principal_id: string;
      delegation: string | null;
      request_sha256: unknown;
      hostname: string;
    }>();
  if (!row) throw unavailable();
  const request = bytesOf(row.request_sha256),
    original = JSON.stringify({
      hostname: row.hostname,
      requestSha256: Buffer.from(request).toString("hex"),
      principalId: row.principal_id,
      ...(row.delegation === null
        ? {}
        : { delegation: handoffAuthorityInput.parse(JSON.parse(row.delegation)) }),
    });
  const values = [i.organizationId, i.projectId, i.identity, i.recoveryId];
  await db.batch([
    ...(await domainPolicyExecutionGuards(db, i)),
    guard(
      db,
      "operation_conflict",
      "EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3 AND state<>'acknowledged')",
      values.slice(0, 3),
    ),
    db
      .prepare(
        "UPDATE native_auth_domain_operations SET state='cancelled' WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3 AND state='pending'",
      )
      .bind(...values.slice(0, 3)),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "UPDATE paid_project_domains SET delete_idempotency_sha256=unhex(?4),delete_request_sha256=?5 WHERE organization_id=?1 AND project_id=?2 AND state='deleting' AND lower(hex(delete_idempotency_sha256))=?3",
      )
      .bind(...values, request),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "INSERT INTO native_auth_domain_operations(organization_id,project_id,kind,identity,original_input,state) VALUES(?1,?2,'paid_delete',?4,?5,'pending')",
      )
      .bind(...values, original),
    db
      .prepare(
        "UPDATE native_auth_domain_recoveries SET state='completed' WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3 AND recovery_id=?4 AND state='pending'",
      )
      .bind(...values),
    guard(db, "operation_conflict", "changes()<>1"),
  ]);
  return "completed" as const;
}

/** A fresh accepted Owner rename may take over only a previously fenced Native rename. */
export async function beginHandleDomainRecovery(context: CatalogContext, raw: unknown) {
  const i = fresh.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const old = await db
    .prepare(
      `SELECT d.identity FROM native_auth_domain_operations d JOIN product_provider_mutation_claims c ON c.organization_id=d.organization_id AND c.project_id=d.project_id AND c.operation_id=d.identity AND c.event_type='ProjectHandleChangeRequestedV1' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.kind='handle_change' AND d.state='pending' AND d.identity<>?3`,
    )
    .bind(i.organizationId, i.projectId, i.operationId)
    .all<{ identity: string }>();
  if (old.results.length === 0) return null;
  if (old.results.length !== 1 || old.results[0] === undefined) throw unavailable();
  const identity = old.results[0].identity;
  const actor = await db
    .prepare(
      "SELECT actor_id FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1' AND actor_type='principal'",
    )
    .bind(i.organizationId, i.projectId, i.operationId)
    .first<{ actor_id: string }>();
  if (!actor) throw unavailable();
  const proof = await readWorkflowDelegation(db, i);
  const authority = await handleDomainAuthorityGuards(db, i);
  const values = [i.organizationId, i.projectId, identity, i.operationId];
  await db.batch([
    fenceRaceGuard(db, "operation_conflict", i.organizationId),
    ...authority,
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM product_command_intents n JOIN operations o USING(organization_id,project_id,operation_id) JOIN projects p USING(organization_id,project_id) JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL WHERE n.organization_id=?1 AND n.project_id=?2 AND n.operation_id=?4 AND n.event_type='ProjectHandleChangeRequestedV1' AND n.billing_epoch_id=p.active_billing_epoch_id AND p.owner_state='active' AND p.lifecycle_state='active' AND o.state IN('queued','running'))`,
      values,
    ),
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM native_auth_domain_operations d JOIN product_provider_mutation_claims c ON c.organization_id=d.organization_id AND c.project_id=d.project_id AND c.operation_id=d.identity AND c.event_type='ProjectHandleChangeRequestedV1' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.kind='handle_change' AND d.identity=?3 AND d.state='pending')`,
      values.slice(0, 3),
    ),
    db
      .prepare(
        "UPDATE native_auth_domain_recoveries SET state='cancelled' WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND recovery_id<>?4 AND state='pending'",
      )
      .bind(...values),
    db
      .prepare(
        "INSERT INTO native_auth_domain_recoveries(organization_id,project_id,kind,identity,recovery_id,principal_id,delegation,request_sha256,recovery_operation_id,state) VALUES(?1,?2,'handle_change',?3,?4,?5,?6,NULL,?4,'pending') ON CONFLICT DO NOTHING",
      )
      .bind(...values, actor.actor_id, proof === null ? null : JSON.stringify(proof)),
    guard(
      db,
      "operation_conflict",
      "NOT EXISTS(SELECT 1 FROM native_auth_domain_recoveries WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND recovery_id=?4 AND principal_id=?5 AND delegation IS ?6 AND recovery_operation_id=?4 AND state='pending')",
      [...values, actor.actor_id, proof === null ? null : JSON.stringify(proof)],
    ),
  ]);
  return {
    organizationId: i.organizationId,
    projectId: i.projectId,
    kind: "handle_change" as const,
    identity,
    recoveryId: i.operationId,
  };
}

/** Fail the superseded original only after its exact private policy has acknowledged. */
export async function completeHandleDomainRecovery(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        organizationId: ulid,
        projectId: ulid,
        kind: z.literal("handle_change"),
        identity: ulid,
        recoveryId: ulid,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const parent = await db
    .prepare(
      "SELECT original_input FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state='pending'",
    )
    .bind(i.organizationId, i.projectId, i.identity)
    .first<{ original_input: string }>();
  if (!parent) throw unavailable();
  const original = z
    .object({
      workflowId: z.string(),
      outboxEventId: ulid,
      startedOperationEventId: ulid,
      operationEventId: ulid,
      auditEventId: ulid,
      requestedHandle: z.string(),
    })
    .passthrough()
    .parse(JSON.parse(parent.original_input));
  const at = new Date().toISOString().replace(/Z$/u, "000Z"),
    values = [i.organizationId, i.projectId, i.identity];
  await db.batch([
    ...(await domainPolicyExecutionGuards(db, i)),
    guard(
      db,
      "operation_conflict",
      "EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state<>'acknowledged')",
      values,
    ),
    guard(
      db,
      "operation_conflict",
      "NOT EXISTS(SELECT 1 FROM product_workflow_runs WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND workflow_id=?4 AND event_id=?5 AND event_type='ProjectHandleChangeRequestedV1' AND state='queued' AND active_reconciliation_attempt_id IS NULL AND active_replay_attempt_id IS NULL)",
      [...values, original.workflowId, original.outboxEventId],
    ),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) SELECT ?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6 WHERE NOT EXISTS(SELECT 1 FROM operation_events WHERE organization_id=?1 AND operation_id=?3 AND revision=1)",
      )
      .bind(
        i.organizationId,
        original.startedOperationEventId,
        i.identity,
        i.projectId,
        `${original.workflowId}:start`,
        at,
      ),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,2,'OperationFailed',?5,?6,?7)",
      )
      .bind(
        i.organizationId,
        original.operationEventId,
        i.identity,
        i.projectId,
        `${original.workflowId}:failed`,
        JSON.stringify({
          failure: {
            code: "OPERATION_ABANDONED",
            message: "A current owner replaced this pending address change.",
          },
        }),
        at,
      ),
    db
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) SELECT ?1,?2,?3,?4,'ProjectHandleChangeRequestedV1Failed','system','deployment-workflow',?5,?6,billing_epoch_id FROM operations WHERE organization_id=?1 AND project_id=?3 AND operation_id=?4",
      )
      .bind(
        i.organizationId,
        original.auditEventId,
        i.projectId,
        i.identity,
        JSON.stringify({ recoveryOperationId: i.recoveryId }),
        at,
      ),
    db
      .prepare(
        "UPDATE operations SET state='failed',failure=?5,lease_expires_at=NULL,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
      )
      .bind(
        ...values,
        at,
        JSON.stringify({
          code: "OPERATION_ABANDONED",
          message: "A current owner replaced this pending address change.",
        }),
      ),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "UPDATE product_workflow_runs SET state='completed',terminal_evidence=?2,updated_at=?3,completed_at=?3 WHERE workflow_id=?1 AND state='queued'",
      )
      .bind(
        original.workflowId,
        JSON.stringify({
          requestedHandle: original.requestedHandle,
          outcome: "superseded_by_owner",
        }),
        at,
      ),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1'",
      )
      .bind(...values),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "UPDATE native_auth_domain_operations SET state='cancelled' WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state='pending'",
      )
      .bind(...values),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "UPDATE native_auth_domain_recoveries SET state='completed' WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND recovery_id=?4 AND state='pending'",
      )
      .bind(...values, i.recoveryId),
    guard(db, "operation_conflict", "changes()<>1"),
  ]);
  return "completed" as const;
}
