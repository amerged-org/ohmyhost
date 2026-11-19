import { generatedJsonb } from "../../jsonb-generated.js";
import { z } from "zod";
import { parseOperationDataChangeResult, parseSharedGatewayReceipt } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  fenceRaceGuard,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { currentDataEnvironment } from "../database/authority.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import { parseProjectDataChangeSnapshot } from "./context-snapshots.js";
import {
  deletionEnvironmentRowsSql,
  validDeletionEnvironmentSet,
} from "./deletion-environments.js";
import {
  RUN,
  terminalIdentity,
  terminalMatches,
  workflowTerminalStatements,
} from "./workflow-terminal-plan.js";
import {
  runtimeSecretDeletionPublication,
  runtimeSecretDeletionHash,
  runtimeSecretDeletionStatements,
  type RuntimeSecretDeletionPublication,
} from "./runtime-secret-deletion.js";

const scope = { organizationId: ulid, projectId: ulid, environmentId: ulid, operationId: ulid },
  timestamp = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
  workflow = z
    .string()
    .min(1)
    .max(255)
    .refine((v) => v.trim() === v),
  common = z.strictObject({
    ...scope,
    workflowId: workflow,
    outboxEventId: ulid,
    startedOperationEventId: ulid,
    operationEventId: ulid,
    auditEventId: ulid,
    completedAt: timestamp,
    reconciliationAttemptId: ulid.optional(),
    replayAttemptId: ulid.optional(),
  }),
  deletion = z.strictObject({
    tombstoneReceiptId: z.string(),
    inventoryClean: z.literal(true),
    consecutive404s: z.number().refine((v) => Number.isSafeInteger(v) && v >= 3),
    gatewayAbsence: z
      .array(z.unknown().transform((v) => (v === null ? null : parseSharedGatewayReceipt(v))))
      .min(1),
  }),
  completeInput = z.discriminatedUnion("eventType", [
    common.extend({
      eventType: z.literal("ProjectDeletionRequestedV1"),
      expectedEnvironmentHeads: z
        .array(
          z.strictObject({
            environmentId: ulid,
            expectedHeadVersion: z.number().refine((v) => Number.isSafeInteger(v) && v >= 0),
          }),
        )
        .min(1),
      deletion,
    }),
    common.extend({
      eventType: z.literal("ProjectDataChangeRequestedV1"),
      dataChangeResult: z.unknown().transform(parseOperationDataChangeResult),
    }),
    common.extend({ eventType: z.literal("ProjectHandleChangeRequestedV1") }),
  ]),
  tombstoneInput = z.strictObject({
    ...scope,
    workflowId: workflow,
    outboxEventId: ulid,
    startedOperationEventId: ulid,
    recordedAt: timestamp,
    tombstoneReceiptId: z.string(),
  });
type Complete = z.output<typeof completeInput>;
type Row = Record<string, unknown>;
const conflict = (message: string) => new ProductWorkflowContextConflictError(message);
const handleTakenFailure = {
  code: "PROJECT_HANDLE_TAKEN",
  message: "The requested project handle was taken before the rename could finish.",
} as const;
const values = (i: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
}) => [i.organizationId, i.projectId, i.environmentId, i.operationId];
const INTENT =
  "SELECT * FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4";
const PROJECT =
  "SELECT handle,lifecycle_state,lifecycle_version,owner_state FROM projects WHERE organization_id=?1 AND project_id=?2";
const ENVIRONMENTS = `SELECT environment_id,name,head_version,active_deployment_id,active_revision_id,${currentDataEnvironment("environments.organization_id", "environments.project_id", "environments.environment_id")} data_environment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod') ORDER BY name`;
const INVENTORY_REMAINS = `SELECT 1 FROM run_resource_inventory inventory WHERE inventory.organization_id=?1 AND inventory.project_id=?2 AND inventory.operation_id=?3 AND NOT EXISTS(SELECT 1 FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash AND attempt.outcome IN('removed','not_found'))`;
const canonical = (value: unknown): string =>
  value !== null && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonical((value as Row)[key]))
          .join(",")}}`
    : JSON.stringify(value);
function terminal(i: Complete, intent: Row, project: Row | null, environments: Row[]) {
  if (i.eventType === "ProjectHandleChangeRequestedV1")
    return { requestedHandle: intent["requested_handle"], outcome: "project_handle_taken" };
  if (i.eventType === "ProjectDataChangeRequestedV1") {
    if (
      i.dataChangeResult.operationId !== i.operationId ||
      i.dataChangeResult.change !== intent["data_change"]
    )
      throw conflict("Data change terminal evidence changed");
    return i.dataChangeResult;
  }
  if (!project || !validDeletionEnvironmentSet(environments))
    throw conflict("Deletion environments are incomplete");
  if (
    i.expectedEnvironmentHeads.length !== environments.length ||
    i.deletion.gatewayAbsence.length !== environments.length ||
    new Set(i.expectedEnvironmentHeads.map((head) => head.environmentId)).size !==
      environments.length ||
    environments.some(
      (env) =>
        !i.expectedEnvironmentHeads.some((head) => head.environmentId === env["environment_id"]),
    )
  )
    throw conflict("Deletion environment heads are incomplete");
  return {
    tombstoneReceiptId: i.deletion.tombstoneReceiptId,
    inventoryClean: true,
    consecutive404s: i.deletion.consecutive404s,
    gatewayAbsence: i.deletion.gatewayAbsence.map((receipt, index) => {
      if (receipt === null) return null;
      const environment = environments[index];
      if (
        !environment ||
        receipt.organizationId !== i.organizationId ||
        receipt.projectId !== i.projectId ||
        receipt.environmentId !== environment["environment_id"] ||
        receipt.environmentName !== environment["name"] ||
        receipt.handle !== project["handle"] ||
        receipt.active
      )
        throw new TypeError("Shared gateway absence receipt is invalid");
      return { ...receipt, observedAt: receipt.observedAt.toISOString() };
    }),
  };
}
function originalIntentGuard(db: D1Database, i: Complete, intent: Row) {
  return guard(
    db,
    "operation_conflict",
    `NOT EXISTS(${INTENT} AND event_type=?5 AND billing_epoch_id IS ?6 AND requested_handle IS ?7 AND cleanup_run_id IS ?8 AND data_change IS ?9 AND data_change_snapshot IS ?10)`,
    [
      ...values(i),
      i.eventType,
      intent["billing_epoch_id"],
      intent["requested_handle"],
      intent["cleanup_run_id"],
      intent["data_change"],
      intent["data_change_snapshot"],
    ],
  );
}
function currentProjectGuard(db: D1Database, i: Complete, project: Row) {
  return guard(
    db,
    "operation_conflict",
    `NOT EXISTS(${PROJECT} AND owner_state='active' AND lifecycle_state=?3 AND lifecycle_version=?4)`,
    [
      i.organizationId,
      i.projectId,
      i.eventType === "ProjectDeletionRequestedV1" ? "deleting" : "active",
      project["lifecycle_version"],
    ],
  );
}
/** Fixed native lifecycle completion. Secret purge, heads, inventory, project and Workflow history share ONE batch. */
export async function completeProductLifecycleCommand(
  context: CatalogContext,
  raw: unknown,
): Promise<"completed" | "replayed"> {
  const i = completeInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (i.reconciliationAttemptId !== undefined && i.replayAttemptId !== undefined)
    throw new TypeError("Product Workflow cannot activate two recovery attempts");
  type Snapshot = {
    intent: Row | null;
    run: Row | null;
    project: Row | null;
    environments: Row[];
    publications: (RuntimeSecretDeletionPublication | null)[];
    hashes: (string | null)[];
  };
  const read = async (r: D1Database): Promise<Snapshot> => {
    const heads = i.eventType === "ProjectDeletionRequestedV1" ? i.expectedEnvironmentHeads : [],
      rows = await r.batch([
        r.prepare(INTENT).bind(...values(i)),
        r.prepare(RUN).bind(...terminalIdentity(i, i, i.eventType)),
        r.prepare(PROJECT).bind(i.organizationId, i.projectId),
        r
          .prepare(
            i.eventType === "ProjectDeletionRequestedV1"
              ? deletionEnvironmentRowsSql()
              : ENVIRONMENTS,
          )
          .bind(i.organizationId, i.projectId),
        ...heads.map((head) =>
          runtimeSecretDeletionPublication(r, { ...i, environmentId: head.environmentId }),
        ),
      ]),
      publications = heads.map(
        (_head, index) =>
          (rows[index + 4]?.results[0] ?? null) as RuntimeSecretDeletionPublication | null,
      );
    return {
      intent: rows[0]?.results[0] ?? null,
      run: rows[1]?.results[0] ?? null,
      project: rows[2]?.results[0] ?? null,
      environments: rows[3]?.results ?? [],
      publications,
      hashes: await Promise.all(publications.map(runtimeSecretDeletionHash)),
    };
  };
  const command: Command<Snapshot, "completed" | "replayed"> = {
    name: "provisioning.completeLifecycle",
    input: i,
    retryOn: ["operation_conflict"],
    read,
    decide: (s) => {
      const intent = s.intent,
        run = s.run;
      if (!intent || intent["event_type"] !== i.eventType)
        throw conflict("Product command intent scope changed");
      const evidence = terminal(i, intent, s.project, s.environments);
      if (terminalMatches(run, evidence)) return { replay: "replayed" };
      if (
        !run ||
        run["state"] !== "queued" ||
        run["active_reconciliation_attempt_id"] !== (i.reconciliationAttemptId ?? null) ||
        (i.replayAttemptId !== undefined && run["active_replay_attempt_id"] !== i.replayAttemptId)
      )
        throw conflict("Product Workflow state changed");
      if (
        !s.project ||
        s.project["owner_state"] !== "active" ||
        s.project["lifecycle_state"] !==
          (i.eventType === "ProjectDeletionRequestedV1" ? "deleting" : "active")
      )
        throw conflict("Product Workflow has no exact persisted command context");
      const statements: D1PreparedStatement[] = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        originalIntentGuard(db, i, intent),
        currentProjectGuard(db, i, s.project),
      ];
      if (i.eventType === "ProjectDataChangeRequestedV1") {
        const snapshot =
            intent["data_change_snapshot"] === null
              ? null
              : parseProjectDataChangeSnapshot(JSON.parse(String(intent["data_change_snapshot"]))),
          after = snapshot?.transition.after;
        if (
          !after ||
          s.environments.length !== 2 ||
          s.environments.some(
            (env) =>
              env["data_environment_id"] !==
              after[env["name"] as "dev" | "prod"]?.dataEnvironmentId,
          )
        )
          throw conflict("Data change assignments are incomplete");
        statements.push(
          guard(db, "operation_conflict", `EXISTS(${INVENTORY_REMAINS})`, [
            i.organizationId,
            i.projectId,
            i.operationId,
          ]),
          guard(
            db,
            "operation_conflict",
            `(SELECT count(*) FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod'))<>2 OR EXISTS(SELECT 1 FROM(${ENVIRONMENTS}) current WHERE current.data_environment_id IS NOT CASE current.name WHEN 'dev' THEN ?3 WHEN 'prod' THEN ?4 END)`,
            [
              i.organizationId,
              i.projectId,
              after.dev.dataEnvironmentId,
              after.prod.dataEnvironmentId,
            ],
          ),
          db
            .prepare(
              "UPDATE operations SET state='succeeded',updated_at=?4,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.completedAt),
          db
            .prepare(
              "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectDataChangeRequestedV1'",
            )
            .bind(i.organizationId, i.projectId, i.operationId),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              "UPDATE cleanup_runs SET state='succeeded',revision=revision+1,completed_at=?4,updated_at=?4,reconciliation_code=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('pending','running','reconciliation_required')",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.completedAt),
        );
      } else if (i.eventType === "ProjectDeletionRequestedV1") {
        statements.push(
          guard(
            db,
            "operation_conflict",
            "EXISTS(SELECT 1 FROM project_previews WHERE organization_id=?1 AND project_id=?2 AND retirement<>'retired')",
            [i.organizationId, i.projectId],
          ),
          guard(
            db,
            "operation_conflict",
            `(SELECT count(*) FROM environments WHERE organization_id=?1 AND project_id=?2)<>?4 OR EXISTS(SELECT 1 FROM(${deletionEnvironmentRowsSql()}) actual WHERE actual.name IS NULL OR NOT EXISTS(SELECT 1 FROM json_each(?3) expected WHERE expected.value=actual.environment_id))`,
            [
              i.organizationId,
              i.projectId,
              JSON.stringify(i.expectedEnvironmentHeads.map((head) => head.environmentId)),
              i.expectedEnvironmentHeads.length,
            ],
          ),
          db
            .prepare("DELETE FROM dev_access_tickets WHERE organization_id=?1 AND project_id=?2")
            .bind(i.organizationId, i.projectId),
          db.prepare("DELETE FROM dev_share_links WHERE project_id=?1").bind(i.projectId),
        );
        for (const [index, head] of i.expectedEnvironmentHeads.entries())
          statements.push(
            ...runtimeSecretDeletionStatements(
              db,
              { ...i, environmentId: head.environmentId },
              s.publications[index] ?? null,
              s.hashes[index] ?? null,
            ),
            db
              .prepare(
                "UPDATE environments SET active_deployment_id=NULL,active_revision_id=NULL,head_version=head_version+1,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND head_version=?4",
              )
              .bind(
                i.organizationId,
                i.projectId,
                head.environmentId,
                head.expectedHeadVersion,
                i.completedAt,
              ),
            guard(db, "operation_conflict", "changes()<>1"),
          );
        statements.push(
          guard(
            db,
            "operation_conflict",
            "EXISTS(SELECT 1 FROM environments WHERE organization_id=?1 AND project_id=?2 AND(active_deployment_id IS NOT NULL OR active_revision_id IS NOT NULL))",
            [i.organizationId, i.projectId],
          ),
          guard(
            db,
            "operation_conflict",
            `EXISTS(${INVENTORY_REMAINS} AND NOT(inventory.provider='control' AND inventory.resource_kind='project')) OR EXISTS(SELECT 1 FROM native_export_effects effect WHERE effect.project_id=?2 AND effect.state NOT IN('tombstoned','absent')) OR EXISTS(SELECT 1 FROM project_recovery_jobs j WHERE j.project_id=?2 AND j.native_manifest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM native_export_effects e WHERE e.organization_id=j.organization_id AND e.operation_id=j.operation_id))`,
            [i.organizationId, i.projectId, i.operationId],
          ),
          db
            .prepare(
              "UPDATE cleanup_runs SET state='succeeded',revision=revision+1,updated_at=?5,completed_at=?5,reconciliation_code=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND cleanup_run_id=?4 AND state IN('pending','running')",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.operationId,
              intent["cleanup_run_id"],
              i.completedAt,
            ),
          guard(
            db,
            "operation_conflict",
            "EXISTS(SELECT 1 FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3 AND state IN('queued','running'))",
            [i.organizationId, i.projectId, i.operationId],
          ),
          // The project's Cloudflare application-identity grants end with it. The rows are revoked here; the Domain
          // Management sweep then revokes each refresh token upstream and keeps the row until Cloudflare accepts it.
          db
            .prepare(
              "UPDATE scoped_customer_dns_authorizations SET revoked_at=?3 WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2 AND revoked_at IS NULL",
            )
            .bind(i.organizationId, i.projectId, i.completedAt),
          db
            .prepare(
              "UPDATE scoped_customer_dns_grants SET revoked_at=?3 WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2 AND revoked_at IS NULL",
            )
            .bind(i.organizationId, i.projectId, i.completedAt),
          // `updated_at` is the instant the deletion completed: the credit attribution reads it as the end of the project.
          db
            .prepare(
              "UPDATE projects SET lifecycle_state='deleted',lifecycle_version=lifecycle_version+1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='deleting' AND lifecycle_version=?3",
            )
            .bind(i.organizationId, i.projectId, s.project["lifecycle_version"], i.completedAt),
          guard(db, "operation_conflict", "changes()<>1"),
          db.prepare("DELETE FROM project_database_writes WHERE project_id=?1").bind(i.projectId),
          db
            .prepare(
              "UPDATE operations SET state='succeeded',updated_at=?4,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.completedAt),
        );
      }
      // A refused rename ends failed and releases its provider claim, as the success path does.
      if (i.eventType === "ProjectHandleChangeRequestedV1")
        statements.push(
          db
            .prepare(
              "UPDATE operations SET state='failed',failure=?4,updated_at=?5,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.operationId,
              JSON.stringify(handleTakenFailure),
              i.completedAt,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1'",
            )
            .bind(i.organizationId, i.projectId, i.operationId),
        );
      statements.push(
        ...workflowTerminalStatements(
          db,
          i,
          i,
          i.eventType,
          { ...run, billing_epoch_id: intent["billing_epoch_id"] },
          evidence,
          i.completedAt,
          i.eventType === "ProjectDataChangeRequestedV1" ? evidence : null,
          i.eventType === "ProjectHandleChangeRequestedV1" ? handleTakenFailure : null,
        ),
      );
      return { statements, result: () => "completed" };
    },
    lookup: async (r) => {
      const s = await read(r);
      if (!s.intent || s.intent["event_type"] !== i.eventType) return undefined;
      return terminalMatches(s.run, terminal(i, s.intent, s.project, s.environments))
        ? "replayed"
        : undefined;
    },
  };
  return runCommand(db, command);
}
/** Fixed tombstone intermediate evidence and original deletion start/cleanup transition in one commit. */
export async function retainProductDeletionTombstone(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = tombstoneInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    evidence = { tombstoneReceiptId: i.tombstoneReceiptId };
  return runCommand(db, {
    name: "provisioning.retainDeletionTombstone",
    input: i,
    retryOn: ["operation_conflict"],
    read: async (r) => {
      const rows = await r.batch([
        r.prepare(RUN).bind(...terminalIdentity(i, i, "ProjectDeletionRequestedV1")),
        r.prepare(INTENT).bind(...values(i)),
        r.prepare(PROJECT).bind(i.organizationId, i.projectId),
      ]);
      return {
        run: rows[0]?.results[0] ?? null,
        intent: rows[1]?.results[0] ?? null,
        project: rows[2]?.results[0] ?? null,
      };
    },
    decide: (s) => {
      const r = s.run;
      if (
        !r ||
        r["state"] !== "queued" ||
        !s.intent ||
        s.intent["event_type"] !== "ProjectDeletionRequestedV1" ||
        !s.project ||
        s.project["owner_state"] !== "active" ||
        s.project["lifecycle_state"] !== "deleting" ||
        (r["intermediate_evidence"] !== null &&
          canonical(JSON.parse(String(r["intermediate_evidence"]))) !== canonical(evidence))
      )
        throw conflict("Product Workflow intermediate evidence changed");
      if (r["operation_state"] !== "queued" && r["operation_state"] !== "running")
        throw conflict("Deletion operation is not active");
      const statements: D1PreparedStatement[] = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(${INTENT} AND event_type='ProjectDeletionRequestedV1')`,
          values(i),
        ),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(${PROJECT} AND owner_state='active' AND lifecycle_state='deleting' AND lifecycle_version=?3)`,
          [i.organizationId, i.projectId, s.project["lifecycle_version"]],
        ),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM(${RUN}) WHERE state='queued' AND operation_state=?9 AND intermediate_evidence IS ?8)`,
          [
            ...terminalIdentity(i, i, "ProjectDeletionRequestedV1"),
            r["intermediate_evidence"],
            r["operation_state"],
          ],
        ),
        db
          .prepare(
            "UPDATE product_workflow_runs SET intermediate_evidence=?2,updated_at=?3 WHERE workflow_id=?1 AND state='queued'",
          )
          .bind(i.workflowId, generatedJsonb(evidence), i.recordedAt),
        guard(db, "operation_conflict", "changes()<>1"),
      ];
      if (r["operation_state"] === "queued")
        statements.push(
          guard(
            db,
            "operation_conflict",
            "EXISTS(SELECT 1 FROM operation_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND revision=1 AND(event_type<>'OperationStarted' OR substr(occurred_at,1,23)>substr(?4,1,23)))",
            [i.organizationId, i.projectId, i.operationId, i.recordedAt],
          ),
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) SELECT ?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6 WHERE NOT EXISTS(SELECT 1 FROM operation_events WHERE organization_id=?1 AND project_id=?4 AND operation_id=?3 AND revision=1)",
            )
            .bind(
              i.organizationId,
              i.startedOperationEventId,
              i.operationId,
              i.projectId,
              `${i.workflowId}:start`,
              i.recordedAt,
            ),
          db
            .prepare(
              "UPDATE operations SET state='running',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='queued'",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.recordedAt),
          db
            .prepare(
              "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'OperationStarted','system','deployment-workflow','{}',?5,?6)",
            )
            .bind(
              i.organizationId,
              i.startedOperationEventId,
              i.projectId,
              i.operationId,
              i.recordedAt,
              r["billing_epoch_id"],
            ),
        );
      statements.push(
        db
          .prepare(
            "UPDATE cleanup_runs SET state='running',revision=revision+1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='pending'",
          )
          .bind(i.organizationId, i.projectId, i.operationId, i.recordedAt),
      );
      return { statements, result: () => "created" as const };
    },
    lookup: async (r) => {
      const row = await r
        .prepare(RUN)
        .bind(...terminalIdentity(i, i, "ProjectDeletionRequestedV1"))
        .first<Row>();
      return row?.["state"] === "queued" &&
        typeof row["intermediate_evidence"] === "string" &&
        canonical(JSON.parse(row["intermediate_evidence"])) === canonical(evidence)
        ? ("created" as const)
        : undefined;
    },
  });
}
