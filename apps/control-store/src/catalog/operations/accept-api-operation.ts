import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { type Command } from "../../run-command.js";
import {
  auditStatement,
  conflict,
  hexBytes,
  instant,
  outboxStatement,
  queuedOperationStatements,
  ringDoorbell,
  routeOrganization,
  runMapped,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";
import { activeGrantGuard, activeGrantSelect, isUserRevoked } from "../identity/mcp-sql.js";
import {
  assertOperationDelegationCurrent,
  operationAction,
  restrictionAllows,
} from "../identity/operation-delegations.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "../identity/authorization-restriction.js";
import {
  authorizeOrganizationAction,
  canonicalAuthorizationGuard,
} from "../projects/customer-projects-access.js";
import {
  idempotencyRecordStatement,
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "./idempotency.js";

const DELEGATED_EVENTS = [
  "DeploymentRequestedV1",
  "DeploymentPromotionRequestedV1",
  "DeploymentRollbackRequestedV1",
];

/** The commands that mutate provider state of a project and so wait for a pending PGCF provider cutover to be released. */
const CUTOVER_GATED_EVENTS = [
  ...DELEGATED_EVENTS,
  "ProjectDataChangeRequestedV1",
  "ProjectDeletionRequestedV1",
  "ProjectDatabaseComputeChangeRequestedV1",
];

/** `pgcf_provider_cutover_pending`: an authorization of the project that no release has closed. Binds `?1` organization, `?2` project. */
const CUTOVER_PENDING_SQL = `EXISTS (SELECT 1 FROM database_provider_cutover_authorizations authorization
  WHERE authorization.organization_id = ?1 AND authorization.project_id = ?2
    AND NOT EXISTS (SELECT 1 FROM database_provider_cutover_releases released
      WHERE released.organization_id = authorization.organization_id AND released.operation_id = authorization.operation_id))`;

/**
 * `readProjectDeletionAdmission` for a `deleting` project: a failed deletion continues with a fresh operation, so the
 * previous deletion operation must be failed and nothing else may hold the project (no provider claim, no queued or
 * running operation, no unfinished workflow run). Binds `?1` organization, `?2` project; the row carries what the
 * accepting request must still match.
 */
const DELETION_ADMISSION_SQL = `SELECT env.environment_id, project.active_billing_epoch_id AS billing_epoch_id, project.lifecycle_version
  FROM projects project
  JOIN environments env ON env.organization_id = project.organization_id AND env.project_id = project.project_id AND env.name = CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=project.organization_id AND preferred.project_id=project.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END
  JOIN billing_epochs epoch ON epoch.organization_id = project.organization_id AND epoch.billing_epoch_id = project.active_billing_epoch_id
    AND epoch.project_id = project.project_id AND epoch.ended_at IS NULL
  WHERE project.organization_id = ?1 AND project.project_id = ?2 AND project.owner_state = 'active' AND project.lifecycle_state = 'deleting'
    AND (SELECT operation.state FROM product_command_intents intent
           JOIN operations operation ON operation.organization_id = intent.organization_id AND operation.operation_id = intent.operation_id
          WHERE intent.organization_id = project.organization_id AND intent.project_id = project.project_id
            AND intent.event_type = 'ProjectDeletionRequestedV1'
          ORDER BY operation.created_at DESC, operation.operation_id DESC LIMIT 1) = 'failed'
    AND NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims claim
          WHERE claim.organization_id = project.organization_id AND claim.project_id = project.project_id)
    AND NOT EXISTS (SELECT 1 FROM operations open_operation
          WHERE open_operation.organization_id = project.organization_id AND open_operation.project_id = project.project_id
            AND open_operation.state IN ('queued','running'))
    AND NOT EXISTS (SELECT 1 FROM product_workflow_runs run
          WHERE run.organization_id = project.organization_id AND run.project_id = project.project_id AND run.state <> 'completed')`;

/** A live paid custom domain must be removed before a project deletion is planned (`ProjectDomainDeletionRequiredError`). */
const LIVE_PAID_DOMAIN_SQL = `EXISTS (SELECT 1 FROM paid_project_domains domain
  WHERE domain.organization_id = ?1 AND domain.project_id = ?2 AND domain.state NOT IN ('deleted', 'displaced'))`;

/**
 * The identity of an action confirmation consumed by the accepting batch: the principal it was issued to, the exact
 * subject version it was issued for and the token digest. A promote or rollback also needs the source generation it
 * was issued under to be the project's current one (0 without a binding).
 */
const confirmationInput = z
  .strictObject({
    action: z.enum(["rollback", "promote", "delete", "data_change"]),
    targetDeploymentId: ulid.optional(),
    issuedToPrincipalId: z.string().min(1).max(255),
    subjectEtag: z.string().min(1).max(255),
    tokenDigest: sha256Hex,
    consumedAt: instant,
  })
  .refine(
    (value) =>
      value.issuedToPrincipalId.trim() === value.issuedToPrincipalId &&
      value.subjectEtag.trim() === value.subjectEtag &&
      (value.action === "rollback" || value.action === "promote"
        ? value.targetDeploymentId !== undefined
        : value.targetDeploymentId === undefined),
    { message: "Action confirmation identity is invalid" },
  );

/** The usable-confirmation predicate shared by the snapshot read and the consuming statement; binds `?1`..`?8`. */
const CONFIRMATION_USABLE_SQL = `organization_id = ?1 AND project_id = ?2 AND issued_to_principal_id = ?3
  AND action = ?4 AND target_deployment_id IS ?5 AND subject_etag = ?6 AND token_sha256 = ?7
  AND consumed_at IS NULL AND created_at <= ?8 AND expires_at > ?8
  AND (action NOT IN ('promote','rollback') OR source_generation = COALESCE((SELECT generation FROM project_source_bindings binding
    WHERE binding.organization_id = action_confirmations.organization_id AND binding.project_id = action_confirmations.project_id), 0))`;

function confirmationBinds(input: Accepted): unknown[] {
  const confirmation = input.confirmation;
  /* v8 ignore next -- callers build the binds only for an input that carries a confirmation */
  if (confirmation === undefined) throw new TypeError("No action confirmation to bind");
  return [
    input.organizationId,
    input.projectId,
    confirmation.issuedToPrincipalId,
    confirmation.action,
    confirmation.targetDeploymentId ?? null,
    confirmation.subjectEtag,
    hexBytes(confirmation.tokenDigest),
    confirmation.consumedAt,
  ];
}

export const acceptApiOperationInput = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    billingEpochId: ulid,
    operationId: ulid,
    operationEventId: ulid,
    auditEventId: ulid,
    outboxEventId: ulid,
    principalId: z.string().trim().min(1),
    actorType: z.enum(["principal", "service"]).default("principal"),
    requestId: z.string().trim().min(1),
    /** The rename route `PUT /v1/projects/{project_id}/handle` is accepted like the others. */
    httpMethod: z.enum(["POST", "PUT", "DELETE"]),
    routeTemplate: z.string().startsWith("/v1/"),
    idempotencyKey: z.string().trim().min(1).max(255),
    canonicalRequestDigest: sha256Hex,
    eventType: z.string().trim().min(1),
    occurredAt: instant,
    availableAt: instant.optional(),
    confirmation: confirmationInput.optional(),
    delegation: z
      .strictObject({
        grantId: z.string().length(36),
        clientId: z.string().min(1).max(2048),
        consentHash: sha256Hex,
        action: delegationActionInput,
        authorizationRestriction: authorizationRestrictionInput.optional(),
      })
      .optional(),
  })
  .refine((value) => value.availableAt === undefined || value.availableAt >= value.occurredAt, {
    message: "API operation availability must not precede acceptance",
  });

export type AcceptApiOperationInput = z.input<typeof acceptApiOperationInput>;
type Accepted = z.output<typeof acceptApiOperationInput>;

export interface AcceptApiOperationResult {
  readonly outcome: "created" | "replayed";
  readonly operationId: string;
}

interface Snapshot {
  readonly record: ReturnType<typeof storedIdempotencyRecord>;
  readonly scope: {
    readonly lifecycle_state: string;
    readonly active_billing_epoch_id: string;
    readonly environment_name: string;
  } | null;
  readonly grant: { readonly grant_id: string; readonly allow_publish: number } | null;
  readonly cutoverPending: boolean;
  readonly deletion: {
    readonly environment_id: string;
    readonly billing_epoch_id: string;
  } | null;
  readonly liveDomain: boolean;
  readonly confirmationUsable: boolean;
}

function delegatedUserId(principalId: string): string {
  return principalId.startsWith("user:") ? principalId.slice(5) : "";
}

/** Only an `active` project accepts an operation, except that a `deleting` one accepts one further `DELETE` deletion request after the previous deletion failed. */
function admitsDeletion(input: Accepted): boolean {
  return input.eventType === "ProjectDeletionRequestedV1" && input.httpMethod === "DELETE";
}

/**
 * `acceptApiOperation` as one batch: the idempotency receipt (complete), the scope and ownership guards, the PGCF
 * provider-cutover gate, the project-deletion admission of a `deleting` project, the consumed action confirmation,
 * the optional delegation, the operation with its first event, the audit event and the outbox event. Any failing
 * statement rolls all of it back (no operation, audit or outbox row, and the confirmation stays unconsumed); a
 * duplicate key aborts the batch and the retry finds the receipt. A fact that changed between the snapshot and the
 * write aborts with `precondition_changed`; the retry reads again and rejects with the typed conflict.
 */
export async function acceptApiOperation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<AcceptApiOperationResult> {
  const input = acceptApiOperationInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  if (
    input.delegation !== undefined &&
    (operationAction(input.eventType) !== input.delegation.action ||
      !restrictionAllows(input.delegation.authorizationRestriction, {
        action: input.delegation.action,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }) ||
      (await authorizeOrganizationAction(context, {
        organizationId: input.organizationId,
        principalId: input.principalId,
        projectId: input.projectId,
        action: input.delegation.action,
      })) !== "allow")
  ) {
    throw conflict("operation_authorization_changed", "Queued operation authorization changed");
  }
  const command: Command<Snapshot, AcceptApiOperationResult> = {
    name: "operations.acceptApiOperation",
    input,
    retryOn: ["consent_changed", "precondition_changed"],
    naturalKeyTables: ["api_idempotency_records", "operations"],
    read: async (reader) => {
      const scoped = [input.organizationId, input.projectId];
      const [record, scope, grant, cutover, deletion, domain, confirmation] = await reader.batch([
        readIdempotencyRecordStatement(reader, input),
        reader
          .prepare(
            `SELECT p.lifecycle_state, p.active_billing_epoch_id, e.name AS environment_name
             FROM projects p JOIN environments e ON e.organization_id = p.organization_id AND e.project_id = p.project_id
             WHERE p.organization_id = ?1 AND p.project_id = ?2 AND p.owner_state = 'active' AND e.environment_id = ?3
               AND (p.lifecycle_state = 'active' OR (p.lifecycle_state = 'deleting' AND ?4 = 1))`,
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            admitsDeletion(input) ? 1 : 0,
          ),
        input.delegation === undefined
          ? reader.prepare("SELECT NULL AS grant_id, 0 AS allow_publish WHERE 0")
          : activeGrantSelect(
              reader,
              {
                organizationId: input.organizationId,
                userId: delegatedUserId(input.principalId),
                clientId: input.delegation.clientId,
                consentHash: input.delegation.consentHash,
              },
              input.projectId,
              false,
            ),
        reader.prepare(`SELECT ${CUTOVER_PENDING_SQL} AS pending`).bind(...scoped),
        reader.prepare(DELETION_ADMISSION_SQL).bind(...scoped),
        reader.prepare(`SELECT ${LIVE_PAID_DOMAIN_SQL} AS live`).bind(...scoped),
        input.confirmation === undefined
          ? reader.prepare("SELECT 1 AS usable WHERE 0")
          : reader
              .prepare(
                `SELECT 1 AS usable FROM action_confirmations WHERE ${CONFIRMATION_USABLE_SQL}`,
              )
              .bind(...confirmationBinds(input)),
      ]);
      return {
        record: storedIdempotencyRecord((record?.results ?? [])[0]),
        scope: ((scope?.results ?? [])[0] as Snapshot["scope"]) ?? null,
        grant: ((grant?.results ?? [])[0] as Snapshot["grant"]) ?? null,
        cutoverPending: ((cutover?.results ?? [])[0] as { pending: number }).pending === 1,
        deletion: ((deletion?.results ?? [])[0] as Snapshot["deletion"]) ?? null,
        liveDomain: ((domain?.results ?? [])[0] as { live: number }).live === 1,
        confirmationUsable: (confirmation?.results ?? []).length === 1,
      };
    },
    decide: ({
      record,
      scope,
      grant,
      cutoverPending,
      deletion,
      liveDomain,
      confirmationUsable,
    }) => {
      if (record !== null) {
        if (record.digestHex !== input.canonicalRequestDigest || record.operationId === null) {
          return {
            reject: conflict(
              "idempotency_conflict",
              "Idempotency key conflicts or the first request is incomplete",
            ),
          };
        }
        return { replay: { outcome: "replayed", operationId: record.operationId } };
      }
      if (scope === null) {
        return {
          reject: conflict(
            "scope_inactive",
            "API operation requires one active tenant-scoped project environment",
          ),
        };
      }
      if (CUTOVER_GATED_EVENTS.includes(input.eventType) && cutoverPending) {
        return {
          reject: conflict(
            "deployment_persistence_conflict",
            "Database provider cutover is not released",
          ),
        };
      }
      const deleting = scope.lifecycle_state === "deleting";
      if (deleting && input.eventType === "ProjectDeletionRequestedV1") {
        if (liveDomain && deletion !== null) {
          return {
            reject: conflict(
              "project_domain_delete_required",
              "Remove the project's live custom domain connection before planning project deletion",
            ),
          };
        }
        if (
          deletion === null ||
          deletion.environment_id !== input.environmentId ||
          deletion.billing_epoch_id !== input.billingEpochId
        ) {
          return {
            reject: conflict(
              "deployment_persistence_conflict",
              "Project deletion is already active or its scope changed",
            ),
          };
        }
      }
      if (input.confirmation !== undefined && !confirmationUsable) {
        return {
          reject: conflict(
            "deployment_persistence_conflict",
            "Action confirmation is invalid, expired, mismatched, or already consumed",
          ),
        };
      }
      const delegated = input.delegation !== undefined;
      const requiresPublication =
        scope.environment_name === "prod" || input.eventType === "DeploymentPromotionRequestedV1";
      if (
        input.delegation !== undefined &&
        (grant === null ||
          grant.grant_id !== input.delegation?.grantId ||
          operationAction(input.eventType) !== input.delegation?.action ||
          !restrictionAllows(input.delegation?.authorizationRestriction, {
            action: input.delegation.action,
            organizationId: input.organizationId,
            projectId: input.projectId,
          }))
      ) {
        return {
          reject: conflict(
            "operation_authorization_changed",
            "Queued operation authorization changed",
          ),
        };
      }
      return {
        statements: acceptStatements(shard.db, input, requiresPublication, delegated, {
          lifecycle: deleting ? "deleting" : "active",
        }),
        result: () => ({ outcome: "created", operationId: input.operationId }),
      };
    },
  };
  if (
    input.delegation !== undefined &&
    (await isUserRevoked(context.directory, delegatedUserId(input.principalId)))
  ) {
    throw conflict("operation_authorization_changed", "Queued operation authorization changed");
  }
  const result = await runMapped(shard.db, command, {
    owner_changed: () =>
      conflict("owner_changed", "The project ownership or billing epoch changed before acceptance"),
    scope_inactive: () =>
      conflict(
        "scope_inactive",
        "API operation requires one active tenant-scoped project environment",
      ),
  });
  if (result.outcome === "replayed") {
    await assertOperationDelegationCurrent(context, {
      organizationId: input.organizationId,
      operationId: result.operationId,
    });
  }
  await ringDoorbell(
    context.directory,
    "outbox",
    shard.shardId,
    input.availableAt ?? input.occurredAt,
  );
  return result;
}

/**
 * The statements of an accepted operation, for the commands that must add steps of their own (a consumed
 * confirmation, a deletion admission) inside the same batch: they build on this list instead of copying it.
 */
export function acceptStatements(
  db: D1Database,
  input: Accepted,
  requiresPublication: boolean,
  delegated: boolean,
  admission: { readonly lifecycle: "active" | "deleting" } = { lifecycle: "active" },
): D1PreparedStatement[] {
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    operationId: input.operationId,
    billingEpochId: input.billingEpochId,
  };
  const deleting = admission.lifecycle === "deleting";
  return [
    idempotencyRecordStatement(
      db,
      input,
      { digestHex: input.canonicalRequestDigest, requestId: input.requestId },
      {
        operationId: input.operationId,
        httpStatus: 202,
        headers: { Location: `/v1/operations/${input.operationId}` },
        body: { operation_id: input.operationId },
      },
      input.occurredAt,
    ),
    guard(
      db,
      "scope_inactive",
      `NOT EXISTS (SELECT 1 FROM projects p JOIN environments e ON e.organization_id = p.organization_id AND e.project_id = p.project_id
         WHERE p.organization_id = ?1 AND p.project_id = ?2 AND p.owner_state = 'active' AND e.environment_id = ?3
           AND p.lifecycle_state = ?4)`,
      [input.organizationId, input.projectId, input.environmentId, admission.lifecycle],
    ),
    guard(
      db,
      "owner_changed",
      "NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND active_billing_epoch_id = ?3)",
      [input.organizationId, input.projectId, input.billingEpochId],
    ),
    // The PGCF provider-cutover gate and the deletion admission are re-proven in the writing batch: a cutover
    // authorized, a live domain connected or a competing deletion started since the snapshot aborts everything.
    ...(CUTOVER_GATED_EVENTS.includes(input.eventType)
      ? [
          guard(db, "precondition_changed", CUTOVER_PENDING_SQL, [
            input.organizationId,
            input.projectId,
          ]),
        ]
      : []),
    ...(deleting && input.eventType === "ProjectDeletionRequestedV1"
      ? [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS (SELECT 1 FROM (${DELETION_ADMISSION_SQL}) admitted
               WHERE admitted.environment_id = ?3 AND admitted.billing_epoch_id = ?4)`,
            [input.organizationId, input.projectId, input.environmentId, input.billingEpochId],
          ),
          guard(db, "precondition_changed", LIVE_PAID_DOMAIN_SQL, [
            input.organizationId,
            input.projectId,
          ]),
        ]
      : []),
    ...(input.confirmation !== undefined
      ? [
          db
            .prepare(
              `UPDATE action_confirmations SET consumed_at = ?8 WHERE ${CONFIRMATION_USABLE_SQL}`,
            )
            .bind(...confirmationBinds(input)),
          guard(db, "precondition_changed", "changes() = 0"),
        ]
      : []),
    ...(delegated && input.delegation !== undefined
      ? [
          canonicalAuthorizationGuard(db, {
            organizationId: input.organizationId,
            principalId: input.principalId,
            projectId: input.projectId,
            action: input.delegation.action,
          }),
          activeGrantGuard(
            db,
            {
              organizationId: input.organizationId,
              userId: delegatedUserId(input.principalId),
              clientId: input.delegation.clientId,
              consentHash: input.delegation.consentHash,
            },
            input.projectId,
            requiresPublication,
            input.delegation.grantId,
          ),
        ]
      : []),
    ...queuedOperationStatements(db, scope, {
      eventId: input.operationEventId,
      occurredAt: input.occurredAt,
    }),
    // The delegation references the operation row, so it follows it inside the same batch.
    ...(delegated && input.delegation !== undefined
      ? [
          db
            .prepare(
              "INSERT INTO operation_mcp_delegations(organization_id, operation_id, project_id, environment_id, billing_epoch_id, principal_id, grant_id, client_id, consent_hash, requires_publication, event_type, created_at, authorization_action, authorization_restriction) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )
            .bind(
              input.organizationId,
              input.operationId,
              input.projectId,
              input.environmentId,
              input.billingEpochId,
              input.principalId,
              input.delegation.grantId,
              input.delegation.clientId,
              input.delegation.consentHash,
              requiresPublication ? 1 : 0,
              input.eventType,
              input.occurredAt,
              input.delegation.action,
              input.delegation.authorizationRestriction === undefined
                ? null
                : JSON.stringify(input.delegation.authorizationRestriction),
            ),
        ]
      : []),
    auditStatement(db, input.organizationId, {
      auditEventId: input.auditEventId,
      projectId: input.projectId,
      operationId: input.operationId,
      billingEpochId: input.billingEpochId,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.principalId,
      payload: {},
      occurredAt: input.occurredAt,
    }),
    outboxStatement(db, scope, {
      eventId: input.outboxEventId,
      eventType: input.eventType,
      payload: { environmentId: input.environmentId },
      createdAt: input.occurredAt,
      availableAt: input.availableAt,
      maxAttempts: 5,
    }),
  ];
}
