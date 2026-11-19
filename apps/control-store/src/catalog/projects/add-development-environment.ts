import { z } from "zod";
import { guard } from "../../guards.js";
import type { Command } from "../../run-command.js";
import {
  auditStatement,
  conflict,
  instant,
  outboxStatement,
  publicTimestamp,
  queuedOperationStatements,
  ringDoorbell,
  routeOrganization,
  rowsOf,
  runMapped,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";
import { authorizationRestrictionInput } from "../identity/authorization-restriction.js";
import { activeGrantGuard, activeGrantSelect } from "../identity/mcp-sql.js";
import { restrictionAllows } from "../identity/operation-delegations.js";
import {
  idempotencyRecordStatement,
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import {
  canonicalAuthorizationCondition,
  canonicalAuthorizationGuard,
} from "./customer-projects-access.js";

const ROUTE = "/v1/projects/{project_id}/environments/dev";
export const addDevelopmentEnvironmentInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  operationEventId: ulid,
  auditEventId: ulid,
  outboxEventId: ulid,
  principalId: z.string().trim().min(1),
  requestId: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().min(1).max(255),
  canonicalRequestDigest: sha256Hex,
  occurredAt: instant,
  delegation: z
    .strictObject({
      grantId: z.string().length(36),
      clientId: z.string().min(1).max(2048),
      consentHash: sha256Hex,
      action: z.literal("projects:write"),
      authorizationRestriction: authorizationRestrictionInput.optional(),
    })
    .optional(),
});

type Input = z.output<typeof addDevelopmentEnvironmentInput>;
export interface AddDevelopmentEnvironmentResult {
  readonly status: 202;
  readonly location: string;
  readonly body: {
    readonly id: string;
    readonly state: "queued";
    readonly created_at: string;
    readonly updated_at: string;
  };
}
interface Scope {
  readonly billing_epoch_id: string;
  readonly data_mode: "shared" | "isolated";
  readonly data_environment_id: string;
  readonly assignment_version: number;
  readonly dev_exists: number;
}
interface Snapshot {
  readonly record: ReturnType<typeof storedIdempotencyRecord>;
  readonly recordProjectId: string | null;
  readonly scope: Scope | null;
  readonly grant: { readonly grant_id: string } | null;
  readonly revoked: boolean;
  readonly authorized: boolean;
}

const scopeSql = `SELECT p.active_billing_epoch_id AS billing_epoch_id, p.data_mode,
    a.data_environment_id, a.assignment_version,
    EXISTS(SELECT 1 FROM environments d WHERE d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.name='dev') AS dev_exists
  FROM projects p
  JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
  JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
  JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='prod'
  JOIN environment_data_assignments a ON a.organization_id=e.organization_id AND a.project_id=e.project_id AND a.environment_id=e.environment_id
    AND a.assignment_version=(SELECT MAX(latest.assignment_version) FROM environment_data_assignments latest WHERE latest.organization_id=e.organization_id AND latest.project_id=e.project_id AND latest.environment_id=e.environment_id)
  WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'`;

function response(input: Input): AddDevelopmentEnvironmentResult {
  const created = publicTimestamp(input.occurredAt);
  return {
    status: 202,
    location: `/v1/operations/${input.operationId}`,
    body: { id: input.operationId, state: "queued", created_at: created, updated_at: created },
  };
}

function replay(record: NonNullable<Snapshot["record"]>): AddDevelopmentEnvironmentResult {
  const { body, operationId } = record;
  if (
    record.httpStatus !== 202 ||
    operationId === null ||
    record.headers["Location"] !== `/v1/operations/${operationId}` ||
    body["id"] !== operationId ||
    body["state"] !== "queued" ||
    typeof body["created_at"] !== "string" ||
    typeof body["updated_at"] !== "string" ||
    Object.keys(body).sort().join(",") !== "created_at,id,state,updated_at"
  )
    throw conflict("idempotency_record_invalid");
  return {
    status: 202,
    location: `/v1/operations/${operationId}`,
    body: {
      id: operationId,
      state: "queued",
      created_at: body["created_at"],
      updated_at: body["updated_at"],
    },
  };
}

/** Add the missing Dev identity and its data assignment atomically with the operation receipt. */
export async function addDevelopmentEnvironment(
  context: CatalogContext,
  raw: unknown,
): Promise<AddDevelopmentEnvironmentResult> {
  const input = addDevelopmentEnvironmentInput.parse(raw);
  const core = await routeOrganization(context, input.organizationId);
  const key = {
    organizationId: input.organizationId,
    principalId: input.principalId,
    httpMethod: "POST",
    routeTemplate: ROUTE,
    idempotencyKey: input.idempotencyKey,
  };
  const delegation = input.delegation;
  const isUser = input.principalId.startsWith("user:");
  const authorization = canonicalAuthorizationCondition({
    organizationId: input.organizationId,
    projectId: input.projectId,
    principalId: input.principalId,
    action: "projects:write",
  });
  const userId = input.principalId.slice(5);
  const command: Command<Snapshot, AddDevelopmentEnvironmentResult> = {
    name: "projects.addDevelopmentEnvironment",
    input,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["api_idempotency_records", "environments", "operations", "outbox_events"],
    read: async (db) => {
      const [record, recordScope, scope, grant, revoked, permission] = await db.batch([
        readIdempotencyRecordStatement(db, key),
        db
          .prepare(
            `SELECT op.project_id FROM api_idempotency_records receipt
          JOIN operations op ON op.organization_id=receipt.organization_id AND op.operation_id=receipt.operation_id
          WHERE receipt.organization_id=?1 AND receipt.principal_id=?2 AND receipt.http_method=?3 AND receipt.route_template=?4 AND receipt.idempotency_key=?5`,
          )
          .bind(
            key.organizationId,
            key.principalId,
            key.httpMethod,
            key.routeTemplate,
            key.idempotencyKey,
          ),
        db.prepare(scopeSql).bind(input.organizationId, input.projectId),
        delegation === undefined
          ? db.prepare("SELECT NULL AS grant_id WHERE 0")
          : activeGrantSelect(
              db,
              {
                organizationId: input.organizationId,
                userId,
                clientId: delegation.clientId,
                consentHash: delegation.consentHash,
              },
              input.projectId,
              false,
            ),
        db.prepare("SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?").bind(userId),
        isUser
          ? db.prepare(`SELECT ${authorization.sql} AS allowed`).bind(...authorization.params)
          : db.prepare("SELECT 1 AS allowed"),
      ]);
      return {
        record: storedIdempotencyRecord(rowsOf(record)[0]),
        recordProjectId: rowsOf<{ project_id: string }>(recordScope)[0]?.project_id ?? null,
        scope: rowsOf<Scope>(scope)[0] ?? null,
        grant: rowsOf<{ grant_id: string }>(grant)[0] ?? null,
        revoked: rowsOf(revoked).length > 0,
        authorized: rowsOf<{ allowed: number }>(permission)[0]?.allowed === 1,
      };
    },
    decide: (snapshot) => {
      const { record, scope, grant } = snapshot;
      if (scope === null) return { reject: conflict("scope_inactive") };
      if (isUser && (!snapshot.authorized || snapshot.revoked))
        return { reject: conflict("operation_authorization_changed") };
      if (
        delegation !== undefined &&
        (!/^user:user_[A-Za-z0-9_]{1,123}$/u.test(input.principalId) ||
          grant === null ||
          grant.grant_id !== delegation.grantId ||
          snapshot.revoked ||
          !restrictionAllows(delegation.authorizationRestriction, {
            action: "projects:write",
            organizationId: input.organizationId,
            projectId: input.projectId,
          }))
      )
        return { reject: conflict("operation_authorization_changed") };
      if (record !== null)
        return record.digestHex === input.canonicalRequestDigest &&
          snapshot.recordProjectId === input.projectId
          ? { replay: replay(record) }
          : { reject: conflict("idempotency_key_reused") };
      if (scope.dev_exists === 1) return { reject: conflict("development_environment_exists") };
      const dataId = scope.data_mode === "shared" ? scope.data_environment_id : input.environmentId;
      const result = response(input);
      const operationScope = {
        organizationId: input.organizationId,
        projectId: input.projectId,
        operationId: input.operationId,
        billingEpochId: scope.billing_epoch_id,
      };
      return {
        statements: [
          idempotencyRecordStatement(
            core.db,
            key,
            { digestHex: input.canonicalRequestDigest, requestId: input.requestId },
            {
              operationId: input.operationId,
              httpStatus: 202,
              headers: { Location: result.location },
              body: result.body,
            },
            input.occurredAt,
          ),
          guard(
            core.db,
            "precondition_changed",
            `NOT EXISTS (SELECT 1 FROM (${scopeSql}) s WHERE s.billing_epoch_id=?3 AND s.data_mode=?4 AND s.data_environment_id=?5 AND s.assignment_version=?6 AND s.dev_exists=0)`,
            [
              input.organizationId,
              input.projectId,
              scope.billing_epoch_id,
              scope.data_mode,
              scope.data_environment_id,
              scope.assignment_version,
            ],
          ),
          ...(isUser
            ? [
                canonicalAuthorizationGuard(core.db, {
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  principalId: input.principalId,
                  action: "projects:write",
                }),
                guard(
                  core.db,
                  "consent_changed",
                  "EXISTS (SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1)",
                  [userId],
                ),
              ]
            : []),
          ...(delegation === undefined || grant === null
            ? []
            : [
                activeGrantGuard(
                  core.db,
                  {
                    organizationId: input.organizationId,
                    userId,
                    clientId: delegation.clientId,
                    consentHash: delegation.consentHash,
                  },
                  input.projectId,
                  false,
                  grant.grant_id,
                ),
              ]),
          core.db
            .prepare(
              "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,'dev','{}',0,0,?4,?4)",
            )
            .bind(input.organizationId, input.environmentId, input.projectId, input.occurredAt),
          ...(scope.data_mode === "shared"
            ? []
            : [
                core.db
                  .prepare(
                    "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
                  )
                  .bind(input.organizationId, input.projectId, dataId, input.occurredAt),
              ]),
          core.db
            .prepare(
              "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at,operation_id) VALUES(?1,?2,?3,?4,1,?5,NULL)",
            )
            .bind(
              input.organizationId,
              input.projectId,
              input.environmentId,
              dataId,
              input.occurredAt,
            ),
          ...queuedOperationStatements(core.db, operationScope, {
            eventId: input.operationEventId,
            occurredAt: input.occurredAt,
          }),
          auditStatement(core.db, input.organizationId, {
            auditEventId: input.auditEventId,
            projectId: input.projectId,
            operationId: input.operationId,
            billingEpochId: scope.billing_epoch_id,
            eventType: "DevelopmentEnvironmentAdded",
            actorType: "principal",
            actorId: input.principalId,
            payload: { environmentId: input.environmentId, dataMode: scope.data_mode },
            occurredAt: input.occurredAt,
          }),
          outboxStatement(core.db, operationScope, {
            eventId: input.outboxEventId,
            eventType: "ProjectProvisioningRequested",
            payload: { projectId: input.projectId, operationId: input.operationId },
            createdAt: input.occurredAt,
            maxAttempts: 3,
          }),
        ],
        result: () => result,
      };
    },
  };
  const result = await runMapped(core.db, command, {});
  await ringDoorbell(context.directory, "outbox", core.shardId, input.occurredAt);
  return result;
}
