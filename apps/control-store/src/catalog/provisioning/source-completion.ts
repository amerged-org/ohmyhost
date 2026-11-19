import { generatedJsonb } from "../../jsonb-generated.js";
import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  instant,
  publicTimestamp,
  fenceRaceGuard,
  type CatalogContext,
} from "../common.js";
import { readProductWorkflowContext, ProductWorkflowContextConflictError } from "./context.js";
import {
  githubConnectionInput,
  readGithubRegistration,
  githubRegistrationStatements,
} from "./github-registration.js";
import {
  readSourceHandoff,
  sourceHandoffPrepared,
  sourceHandoffGuards,
  type SourceHandoffSnapshot,
} from "./source-handoff.js";
const inputSchema = z
  .strictObject({
    eventType: z.literal("SourceLinkRequestedV1"),
    workflowId: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => v.trim() === v),
    reconciliationAttemptId: ulid.optional(),
    replayAttemptId: ulid.optional(),
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    operationId: ulid,
    outboxEventId: ulid,
    startedOperationEventId: ulid,
    operationEventId: ulid,
    auditEventId: ulid,
    externalRepositoryId: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/u)
      .refine((v) => BigInt(v) <= 9007199254740991n),
    completedAt: z
      .string()
      .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
      .pipe(instant),
  })
  .refine(
    (i) => i.reconciliationAttemptId === undefined || i.replayAttemptId === undefined,
    "Product Workflow cannot activate two recovery attempts",
  );
type Row = Record<string, unknown>;
const SCOPE = `SELECT run.state,run.terminal_evidence,run.active_reconciliation_attempt_id,run.active_replay_attempt_id,run.created_at,run.billing_epoch_id,operation.state operation_state,project.lifecycle_version,CAST(intent.installation_id AS TEXT) installation_id,intent.repository_owner,intent.repository_name
 FROM product_workflow_runs run JOIN product_command_intents intent ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
 JOIN operations operation ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id
 JOIN projects project ON project.organization_id=run.organization_id AND project.project_id=run.project_id AND project.owner_state='active' AND project.lifecycle_state='active'
 JOIN environments environment ON environment.organization_id=run.organization_id AND environment.project_id=run.project_id AND environment.environment_id=run.environment_id
 WHERE run.workflow_id=?1 AND run.event_id=?2 AND run.organization_id=?3 AND run.project_id=?4 AND run.environment_id=?5 AND run.operation_id=?6 AND run.event_type='SourceLinkRequestedV1'`;
const now = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
/** Entire original SourceLink metadata, binding, terminal history and accepted run close in ONE batch. */
export async function completeSourceLink(
  context: CatalogContext,
  raw: unknown,
): Promise<"completed" | "replayed"> {
  const i = inputSchema.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    values = [
      i.workflowId,
      i.outboxEventId,
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
    ],
    handoffScope = {
      workflowId: i.workflowId,
      eventId: i.outboxEventId,
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: i.environmentId,
      operationId: i.operationId,
    },
    terminal = generatedJsonb({ externalRepositoryId: i.externalRepositoryId });
  const conflict = (message = "Product Workflow completion state changed") =>
    new ProductWorkflowContextConflictError(message);
  const replay = (r: Row | null) =>
    r?.["state"] === "completed" &&
    r["active_reconciliation_attempt_id"] === null &&
    r["active_replay_attempt_id"] === null &&
    r["terminal_evidence"] !== null &&
    JSON.stringify(JSON.parse(String(r["terminal_evidence"]))) ===
      JSON.stringify({ externalRepositoryId: i.externalRepositoryId });
  type Snapshot = {
    row: Row | null;
    current: Awaited<ReturnType<typeof readProductWorkflowContext>>;
    start: Row | null;
    ack: boolean;
    handoff: SourceHandoffSnapshot | null;
    github: Awaited<ReturnType<typeof readGithubRegistration>>;
    grant: Row | null;
  };
  const command: Command<Snapshot, "completed" | "replayed"> = {
    name: "provisioning.completeSourceLink",
    input: i,
    retryOn: ["operation_conflict", "precondition_changed"],
    naturalKeyTables: [
      "github_source_connections",
      "repository_grants",
      "project_sources",
      "operation_events",
      "audit_events",
    ],
    read: async (reader) => {
      const current = await readProductWorkflowContext(context, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        environmentId: i.environmentId,
        operationId: i.operationId,
      });
      const result = await reader.batch([
        reader.prepare(SCOPE).bind(...values),
        reader
          .prepare(
            "SELECT event_type,occurred_at FROM operation_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND revision=1",
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        reader
          .prepare(
            "SELECT 1 FROM outbox_events WHERE event_id=?1 AND organization_id=?2 AND project_id=?3 AND operation_id=?4 AND acknowledged_at IS NOT NULL",
          )
          .bind(i.outboxEventId, i.organizationId, i.projectId, i.operationId),
        reader.prepare("SELECT * FROM repository_grants WHERE grant_id=?1").bind(i.operationId),
      ]);
      const row = result[0]?.results[0] ?? null,
        ack = (result[2]?.results.length ?? 0) > 0;
      const github = row
        ? await readGithubRegistration(
            reader,
            githubConnectionInput.parse({
              sourceConnectionId: i.operationId,
              organizationId: i.organizationId,
              projectId: i.projectId,
              billingEpochId: row["billing_epoch_id"],
              externalRepositoryId: i.externalRepositoryId,
              createdAt: publicTimestamp(String(row["created_at"])),
            }),
          )
        : null;
      return {
        row,
        current,
        start: result[1]?.results[0] ?? null,
        ack,
        handoff: ack || replay(row) ? null : await readSourceHandoff(reader, handoffScope),
        github,
        grant: result[3]?.results[0] ?? null,
      };
    },
    decide: (s) => {
      const r = s.row;
      if (!r || !s.current || s.current.intent.eventType !== "SourceLinkRequestedV1")
        return { reject: conflict("Product Workflow has no exact persisted command context") };
      if (replay(r)) return { replay: "replayed" };
      if (
        r["state"] !== "queued" ||
        r["active_reconciliation_attempt_id"] !== (i.reconciliationAttemptId ?? null) ||
        (i.replayAttemptId !== undefined && r["active_replay_attempt_id"] !== i.replayAttemptId)
      )
        return { reject: conflict() };
      if (!s.ack && (!s.handoff || !sourceHandoffPrepared(handoffScope, s.handoff)))
        return { reject: conflict("Product command Queue handoff is not durable") };
      if (
        s.start &&
        (s.start["event_type"] !== "OperationStarted" ||
          publicTimestamp(String(s.start["occurred_at"])) > publicTimestamp(i.completedAt))
      )
        return { reject: conflict("Operation start evidence conflicts") };
      const replayId = i.replayAttemptId ?? r["active_replay_attempt_id"],
        github = githubConnectionInput.parse({
          sourceConnectionId: i.operationId,
          organizationId: i.organizationId,
          projectId: i.projectId,
          billingEpochId: r["billing_epoch_id"],
          externalRepositoryId: i.externalRepositoryId,
          createdAt: publicTimestamp(String(r["created_at"])),
        }),
        grantedAt = github.createdAt;
      const expected = {
        grant_id: i.operationId,
        organization_id: i.organizationId,
        project_id: i.projectId,
        billing_epoch_id: r["billing_epoch_id"],
        source_connection_id: i.operationId,
        github_installation_id: r["installation_id"],
        external_repository_id: i.externalRepositoryId,
        repository_owner: r["repository_owner"],
        repository_name: r["repository_name"],
      };
      if (
        s.grant &&
        (Object.entries(expected).some(([k, v]) => s.grant?.[k] !== v) ||
          String(s.grant["granted_at"]).slice(0, 23) !== grantedAt.slice(0, 23))
      )
        return { reject: conflict("Repository grant identity conflicts with the request") };
      const statements = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM(${SCOPE}) WHERE state='queued' AND active_reconciliation_attempt_id IS ?7 AND active_replay_attempt_id IS ?8 AND lifecycle_version=?9)`,
          [
            ...values,
            i.reconciliationAttemptId ?? null,
            replayId,
            s.current.projectLifecycleVersion,
          ],
        ),
        ...githubRegistrationStatements(db, github, s.github),
      ];
      // Admission is checked before effects; all existing immutable source facts stay unchanged on replay.
      statements.splice(
        1,
        0,
        ...(s.ack
          ? [
              guard(
                db,
                "operation_conflict",
                "NOT EXISTS(SELECT 1 FROM outbox_events WHERE event_id=?1 AND organization_id=?2 AND project_id=?3 AND operation_id=?4 AND acknowledged_at IS NOT NULL)",
                [i.outboxEventId, i.organizationId, i.projectId, i.operationId],
              ),
            ]
          : sourceHandoffGuards(db, handoffScope, s.handoff as SourceHandoffSnapshot)),
      );
      if (!s.grant)
        statements.push(
          db
            .prepare(
              "INSERT INTO repository_grants(grant_id,organization_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?1,'github',?5,?6,?7,?8,'contents:read',?9)",
            )
            .bind(
              i.operationId,
              i.organizationId,
              i.projectId,
              r["billing_epoch_id"],
              r["installation_id"],
              i.externalRepositoryId,
              r["repository_owner"],
              r["repository_name"],
              grantedAt,
            ),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?3,'github',?5,?6,?7,?8,'ready',1,?9,?9)",
          )
          .bind(
            i.organizationId,
            i.projectId,
            i.operationId,
            r["billing_epoch_id"],
            r["installation_id"],
            i.externalRepositoryId,
            r["repository_owner"],
            r["repository_name"],
            i.completedAt,
          ),
        db
          .prepare(
            `INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at) VALUES(?1,?2,?3,'github',1,NULL,${now}) ON CONFLICT(organization_id,project_id) DO UPDATE SET source_connection_id=excluded.source_connection_id,generation=CASE WHEN project_source_bindings.source_connection_id=excluded.source_connection_id THEN project_source_bindings.generation ELSE project_source_bindings.generation+1 END,updated_at=excluded.updated_at WHERE project_source_bindings.provider='github'`,
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        guard(
          db,
          "operation_conflict",
          "changes()<>1 AND NOT EXISTS(SELECT 1 FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2 AND provider='managed')",
          [i.organizationId, i.projectId],
        ),
        db
          .prepare(
            "UPDATE operations SET state='succeeded',updated_at=?4,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(i.organizationId, i.projectId, i.operationId, i.completedAt),
        guard(db, "operation_conflict", "changes()<>1"),
      );
      if (!s.start)
        statements.push(
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6)",
            )
            .bind(
              i.organizationId,
              i.startedOperationEventId,
              i.operationId,
              i.projectId,
              `${i.workflowId}:start`,
              i.completedAt,
            ),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,2,'OperationSucceeded',?5,'{}',?6)",
          )
          .bind(
            i.organizationId,
            i.operationEventId,
            i.operationId,
            i.projectId,
            `${i.workflowId}:complete`,
            i.completedAt,
          ),
        db
          .prepare(
            "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'SourceLinkRequestedV1Completed','system','deployment-workflow','{}',?5,?6)",
          )
          .bind(
            i.organizationId,
            i.auditEventId,
            i.projectId,
            i.operationId,
            i.completedAt,
            r["billing_epoch_id"],
          ),
        db
          .prepare(
            "UPDATE product_workflow_runs SET state='completed',terminal_evidence=?2,active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,updated_at=?3,completed_at=?3 WHERE workflow_id=?1 AND state='queued' AND active_reconciliation_attempt_id IS ?4 AND active_replay_attempt_id IS ?5",
          )
          .bind(i.workflowId, terminal, i.completedAt, i.reconciliationAttemptId ?? null, replayId),
        guard(db, "operation_conflict", "changes()<>1"),
      );
      return { statements, result: () => "completed" };
    },
    lookup: async (reader) =>
      replay(
        await reader
          .prepare(SCOPE)
          .bind(...values)
          .first<Row>(),
      )
        ? "replayed"
        : undefined,
  };
  return runCommand(db, command);
}
