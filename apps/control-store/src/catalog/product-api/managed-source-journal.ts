import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { generatedJsonb } from "../../jsonb-generated.js";
import { runCommand, type Command } from "../../run-command.js";
import { acceptApiOperationInput, acceptStatements } from "../operations/accept-api-operation.js";
import { acceptedPreviewSourceStatements } from "../previews/source.js";
import {
  idempotencyRecordStatement,
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import { instant, ringDoorbell, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { bytes, hex, integer, iso, text } from "../provisioning/context-values.js";
import {
  managedAuthorityGuards,
  managedAuthorized,
  managedBindingGuards,
  managedBindingOf,
  managedConflict,
  managedDelegationGuards,
  managedDelegationInput,
  managedDelegationOf,
  managedNoOtherGuard,
  managedPublicationGuards,
  managedPublicationOf,
  managedScopeInput,
  managedWriteInput,
  readManagedSnapshot,
  type ManagedSnapshot,
} from "./managed-source-common.js";
const sha = z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
  digest = z
    .unknown()
    .transform(bytes)
    .refine((v) => v.byteLength === 32);
const scope = (i: z.output<typeof managedScopeInput>) => ({
  organizationId: i.organizationId,
  projectId: i.projectId,
  principalId: i.principalId,
});
const begin = managedWriteInput.extend({
  environmentId: ulid,
  operationEventId: ulid,
  auditEventId: ulid,
  outboxEventId: ulid,
  requestId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  canonicalRequestDigest: digest,
  mode: z.enum(["initialize", "commit", "switch"]),
  sourceConnectionId: ulid,
  expectedSourceConnectionId: ulid.nullable(),
  expectedSourceGeneration: z.number().int().min(0).max(2147483646),
  expectedManagedCommit: z.string().nullable(),
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  repositoryName: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  message: z
    .string()
    .min(1)
    .max(1024)
    .refine((v) => !/\p{Cc}/u.test(v)),
  expiresAt: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
  routeTemplate: z.string().optional(),
  delegation: managedDelegationInput.optional(),
});
/** The accepted operation, initial history, repository custody, journal and future outbox form ONE native batch. */
export async function beginApiManagedSourcePublication(context: CatalogContext, raw: unknown) {
  const i = begin.parse(raw),
    { db, shardId } = await routeOrganization(context, i.organizationId),
    routeTemplate = i.routeTemplate ?? "/v1/projects/{project_id}/source:publish";
  if (
    Date.parse(i.expiresAt) <= Date.parse(i.now) ||
    Date.parse(i.expiresAt) - Date.parse(i.now) > 86400000 ||
    !/^\/v1\/projects\/\{project_id\}\/source(?::(?:publish|initialize|switch|changes|restore)|\/(?:uploads|changes))$/u.test(
      routeTemplate,
    )
  )
    throw new TypeError("Managed source publication input is invalid");
  const key = {
    organizationId: i.organizationId,
    principalId: i.principalId,
    httpMethod: "POST",
    routeTemplate,
    idempotencyKey: i.idempotencyKey,
  };
  type Snapshot = {
    source: ManagedSnapshot;
    delegation: D1PreparedStatement[];
    record: ReturnType<typeof storedIdempotencyRecord>;
    replay: ReturnType<typeof managedPublicationOf>;
  };
  type Result = NonNullable<ReturnType<typeof managedPublicationOf>>;
  const command: Command<Snapshot, Result> = {
    name: "managedSource.beginPublication",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: [
      "api_idempotency_records",
      "managed_source_repositories",
      "managed_source_publications",
      "operations",
      "operation_events",
      "audit_events",
      "outbox_events",
    ],
    read: async (reader) => {
      const source = await readManagedSnapshot(reader, scope(i), i.operationId),
        delegation = await managedDelegationGuards(reader, source, i.delegation ?? null, {
          mode: i.mode,
          sourceConnectionId: i.sourceConnectionId,
        }),
        record = storedIdempotencyRecord(await readIdempotencyRecordStatement(reader, key).first());
      const previous =
        record?.operationId === null || record?.operationId === undefined
          ? null
          : await readManagedSnapshot(reader, scope(i), record.operationId);
      return {
        source,
        delegation,
        record,
        replay:
          previous === null || !managedAuthorized(previous, false)
            ? null
            : managedPublicationOf(previous),
      };
    },
    decide: ({ source: s, delegation, record, replay }) => {
      if (!managedAuthorized(s, true)) managedConflict("scope");
      if (record !== null) {
        if (record.digestHex !== hex(i.canonicalRequestDigest) || replay === null)
          managedConflict("idempotency");
        return { replay };
      }
      if (i.mode !== "commit" && s.busy) managedConflict("operation");
      const current = managedBindingOf(s.binding);
      if (
        (current?.sourceConnectionId ?? null) !== i.expectedSourceConnectionId ||
        (current?.generation ?? 0) !== i.expectedSourceGeneration
      )
        managedConflict("generation");
      if (
        (i.mode === "initialize" && current !== null) ||
        (i.mode === "switch" && current?.provider !== "github") ||
        (i.mode === "commit" &&
          (current?.provider !== "managed" ||
            current.status !== "ready" ||
            current.sourceConnectionId !== i.sourceConnectionId ||
            current.namespace !== i.namespace ||
            current.repositoryName !== i.repositoryName))
      )
        managedConflict("generation");
      if (i.mode === "commit") {
        if (current?.commitSha !== i.expectedManagedCommit) managedConflict("commit");
        sha.parse(i.expectedManagedCommit);
      } else if (i.expectedManagedCommit !== null) managedConflict("generation");
      const epoch = text(s.owner ?? {}, "active_billing_epoch_id"),
        base = acceptApiOperationInput.parse({
          organizationId: i.organizationId,
          projectId: i.projectId,
          environmentId: i.environmentId,
          billingEpochId: epoch,
          operationId: i.operationId,
          operationEventId: i.operationEventId,
          auditEventId: i.auditEventId,
          outboxEventId: i.outboxEventId,
          principalId: i.principalId,
          requestId: i.requestId,
          httpMethod: "POST",
          routeTemplate,
          idempotencyKey: i.idempotencyKey,
          canonicalRequestDigest: hex(i.canonicalRequestDigest),
          eventType: "ManagedSourcePublicationRequestedV1",
          occurredAt: i.now,
          availableAt: i.expiresAt,
        });
      const result: Result = {
        operationId: i.operationId,
        sourceConnectionId: i.sourceConnectionId,
        mode: i.mode,
        state: "staging",
        expectedSourceConnectionId: i.expectedSourceConnectionId,
        expectedSourceGeneration: i.expectedSourceGeneration,
        expectedManagedCommit: i.expectedManagedCommit,
        manifestDigest: null,
        commitSha: null,
        treeSha: null,
        namespace: i.namespace,
        repositoryName: i.repositoryName,
        message: i.message,
        files: [],
        blobs: [],
        createdAt: iso(i.now),
        expiresAt: iso(i.expiresAt),
        errorCode: null,
        delegation: i.delegation ?? null,
      };
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedBindingGuards(db, s),
          ...delegation,
          ...(i.mode === "commit" ? [] : [managedNoOtherGuard(db, i)]),
          ...acceptStatements(db, base, false, false),
          db
            .prepare("UPDATE operations SET state='running' WHERE operation_id=?1")
            .bind(i.operationId),
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at)VALUES(?1,?2,?2,?3,1,'OperationStarted',?4,'{}',?5)",
            )
            .bind(
              i.organizationId,
              i.operationId,
              i.projectId,
              `managed-source:start:${i.operationId}`,
              i.now,
            ),
          ...(i.mode === "commit"
            ? []
            : [
                db
                  .prepare(
                    "INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7)",
                  )
                  .bind(
                    i.sourceConnectionId,
                    i.organizationId,
                    i.projectId,
                    epoch,
                    i.namespace,
                    i.repositoryName,
                    i.now,
                  ),
              ]),
          db
            .prepare(
              "INSERT INTO managed_source_publications(operation_id,organization_id,project_id,billing_epoch_id,principal_id,source_connection_id,mode,expected_source_connection_id,expected_source_generation,expected_managed_commit,state,message,created_at,expires_at,updated_at,delegation_grant_id,delegation_client_id,delegation_consent_sha256,delegation_action,delegation_restriction)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'staging',?11,?12,?13,?12,?14,?15,?16,?17,?18)",
            )
            .bind(
              i.operationId,
              i.organizationId,
              i.projectId,
              epoch,
              i.principalId,
              i.sourceConnectionId,
              i.mode,
              i.expectedSourceConnectionId,
              i.expectedSourceGeneration,
              i.expectedManagedCommit,
              i.message,
              i.now,
              base.availableAt,
              i.delegation?.grantId ?? null,
              i.delegation?.clientId ?? null,
              i.delegation?.consentHash ?? null,
              i.delegation?.action ?? null,
              i.delegation?.authorizationRestriction === undefined
                ? null
                : JSON.stringify(i.delegation.authorizationRestriction),
            ),
        ],
        result: () => result,
      };
    },
  };
  const result = await runCommand(db, command);
  await ringDoorbell(context.directory, "outbox", shardId, i.expiresAt);
  return result;
}
/** Blob/seal request receipts retain the original operation and exact request digest; they never create a second operation. */
export async function recordApiManagedSourceRequest(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "replayed"> {
  const i = managedWriteInput
      .extend({
        httpMethod: z.enum(["POST", "PUT"]),
        routeTemplate: z.string().regex(/^\/v1\/projects\/\{project_id\}\/source[:/]/u),
        idempotencyKey: z
          .string()
          .min(1)
          .max(128)
          .refine((v) => v.trim() === v),
        canonicalRequestDigest: digest,
        requestId: z.string(),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  type Snapshot = {
    source: ManagedSnapshot;
    delegation: D1PreparedStatement[];
    record: ReturnType<typeof storedIdempotencyRecord>;
  };
  const command: Command<Snapshot, "created" | "replayed"> = {
    name: "managedSource.recordRequest",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["api_idempotency_records"],
    read: async (reader) => {
      const source = await readManagedSnapshot(reader, scope(i), i.operationId);
      return {
        source,
        delegation: await managedDelegationGuards(
          reader,
          source,
          managedDelegationOf(source.publication),
        ),
        record: storedIdempotencyRecord(await readIdempotencyRecordStatement(reader, i).first()),
      };
    },
    decide: ({ source: s, delegation, record }) => {
      if (!managedAuthorized(s, true) || s.publication === null) managedConflict("scope");
      if (record !== null) {
        if (
          record.operationId !== i.operationId ||
          record.digestHex !== hex(i.canonicalRequestDigest)
        )
          managedConflict("idempotency");
        return { replay: "replayed" as const };
      }
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          ...delegation,
          idempotencyRecordStatement(
            db,
            i,
            { digestHex: hex(i.canonicalRequestDigest), requestId: i.requestId },
            {
              operationId: i.operationId,
              httpStatus: 200,
              headers: {},
              body: { operation_id: i.operationId },
            },
            i.now,
          ),
        ],
        result: () => "created" as const,
      };
    },
  };
  return runCommand(db, command);
}
export function managedInitializationChildStatement(
  db: D1Database,
  i: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly now: string;
  },
) {
  return db
    .prepare(
      `UPDATE managed_source_initializations AS recipe SET state=CASE WHEN publication.state='committed' THEN 'initialized' ELSE 'failed' END,error_code=CASE WHEN publication.state='failed' THEN publication.error_code ELSE NULL END,updated_at=?4
 FROM managed_source_publications publication JOIN operations operation USING(organization_id,project_id,operation_id)
 WHERE recipe.organization_id=?1 AND recipe.project_id=?2 AND recipe.child_operation_id=?3 AND publication.operation_id=?3 AND publication.organization_id=recipe.organization_id AND publication.project_id=recipe.project_id AND publication.billing_epoch_id=recipe.billing_epoch_id AND publication.source_connection_id=recipe.source_connection_id
 AND recipe.state='initializing' AND((publication.state='failed' AND operation.state='failed')OR(publication.state='committed' AND operation.state='succeeded' AND EXISTS(SELECT 1 FROM project_source_bindings binding WHERE binding.organization_id=recipe.organization_id AND binding.project_id=recipe.project_id AND binding.source_connection_id=recipe.source_connection_id)))`,
    )
    .bind(i.organizationId, i.projectId, i.operationId, i.now);
}
export function managedSourceTerminalStatements(
  db: D1Database,
  i: {
    organizationId: string;
    projectId: string;
    operationId: string;
    principalId: string;
    eventId: string;
    now: string;
  },
  state: "succeeded" | "failed",
  payload: Record<string, unknown>,
): D1PreparedStatement[] {
  const failure =
    state === "failed"
      ? { code: String(payload["error_code"]), message: "Managed source publication was rejected." }
      : null;
  return [
    db
      .prepare("UPDATE operations SET state=?2,updated_at=?3,failure=?4 WHERE operation_id=?1")
      .bind(i.operationId, state, i.now, failure === null ? null : generatedJsonb(failure)),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at,idempotency_key)SELECT ?1,?2,?3,?4,COALESCE(max(revision),-1)+1,?5,?6,?7,?8 FROM operation_events WHERE operation_id=?3",
      )
      .bind(
        i.organizationId,
        i.eventId,
        i.operationId,
        i.projectId,
        state === "succeeded" ? "OperationSucceeded" : "OperationFailed",
        generatedJsonb(failure === null ? {} : { failure }),
        i.now,
        `managed-source:${state}:${i.operationId}`,
      ),
    db
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) SELECT organization_id,?2,project_id,operation_id,?3,'user',?4,?5,?6,billing_epoch_id FROM operations WHERE operation_id=?1",
      )
      .bind(
        i.operationId,
        i.eventId,
        state === "succeeded" ? "ManagedSourcePublished" : "ManagedSourcePublicationFailed",
        i.principalId,
        generatedJsonb(payload),
        i.now,
      ),
  ];
}
/** Observed Git publication changes the selected source and terminal journal/history in one exact guarded batch. */
export async function completeApiManagedSourcePublication(context: CatalogContext, raw: unknown) {
  const i = managedWriteInput
      .extend({
        commitSha: sha,
        treeSha: sha,
        eventId: ulid,
        observedHeadCommitSha: sha.optional(),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  type Snapshot = { source: ManagedSnapshot; delegation: D1PreparedStatement[] };
  type Result = NonNullable<ReturnType<typeof managedBindingOf>>;
  const command: Command<Snapshot, Result> = {
    name: "managedSource.completePublication",
    input: i,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: [
      "source_connections",
      "repository_grants",
      "project_sources",
      "operation_events",
      "audit_events",
    ],
    read: async (reader) => {
      const source = await readManagedSnapshot(reader, scope(i), i.operationId);
      return {
        source,
        delegation: await managedDelegationGuards(
          reader,
          source,
          managedDelegationOf(source.publication),
        ),
      };
    },
    decide: ({ source: s, delegation }) => {
      const p = s.publication;
      if (!managedAuthorized(s, true) || p === null) managedConflict("scope");
      const generation =
          integer(p["expected_source_generation"]) + (p["mode"] === "commit" ? 0 : 1),
        sourceConnectionId = text(p, "source_connection_id"),
        namespace = text(p, "namespace"),
        repositoryName = text(p, "repository_name");
      if (p["state"] === "committed") {
        if (p["commit_sha"] !== i.commitSha || p["tree_sha"] !== i.treeSha)
          managedConflict("candidate");
        return {
          replay: {
            provider: "managed" as const,
            sourceConnectionId,
            generation,
            commitSha: text(p, "commit_sha"),
            namespace,
            repositoryName,
            status: "ready" as const,
            linkedAt: iso(p["created_at"]),
            updatedAt: iso(p["updated_at"]),
          },
        };
      }
      if (p["state"] !== "sealed" || p["commit_sha"] !== i.commitSha || p["tree_sha"] !== i.treeSha)
        managedConflict("candidate");
      if (p["mode"] !== "commit" && s.busy) managedConflict("operation");
      const current = managedBindingOf(s.binding);
      if (
        (current?.sourceConnectionId ?? null) !== p["expected_source_connection_id"] ||
        (current?.generation ?? 0) !== p["expected_source_generation"]
      )
        managedConflict("generation");
      if (
        p["mode"] === "commit" &&
        current?.commitSha !== p["expected_managed_commit"] &&
        (i.observedHeadCommitSha === undefined || current?.commitSha !== i.observedHeadCommitSha)
      )
        managedConflict("commit");
      const epoch = text(p, "billing_epoch_id"),
        external = `${namespace}/${repositoryName}`,
        newSource = p["mode"] !== "commit";
      const result: Result = {
        provider: "managed",
        sourceConnectionId,
        generation,
        commitSha: i.observedHeadCommitSha ?? i.commitSha,
        namespace,
        repositoryName,
        status: newSource ? "ready" : (current?.status ?? "ready"),
        linkedAt: newSource ? iso(i.now) : (current?.linkedAt ?? iso(i.now)),
        updatedAt: iso(i.now),
      };
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          ...managedBindingGuards(db, s),
          ...delegation,
          ...(newSource
            ? [
                managedNoOtherGuard(db, i),
                db
                  .prepare(
                    "INSERT INTO source_connections(source_connection_id,organization_id,project_id,billing_epoch_id,provider,external_repository_id,created_at)VALUES(?1,?2,?3,?4,'managed',?5,?6)",
                  )
                  .bind(sourceConnectionId, i.organizationId, i.projectId, epoch, external, i.now),
                db
                  .prepare(
                    "INSERT INTO repository_grants(grant_id,organization_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at)VALUES(?1,?2,?3,?4,?1,'managed',NULL,?5,?6,?7,'contents:read',?8)",
                  )
                  .bind(
                    sourceConnectionId,
                    i.organizationId,
                    i.projectId,
                    epoch,
                    external,
                    namespace,
                    repositoryName,
                    i.now,
                  ),
                db
                  .prepare(
                    "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at)VALUES(?1,?2,?3,?4,?3,'managed',NULL,?5,?6,?7,'ready',?8,?9,?9)",
                  )
                  .bind(
                    i.organizationId,
                    i.projectId,
                    sourceConnectionId,
                    epoch,
                    external,
                    namespace,
                    repositoryName,
                    generation,
                    i.now,
                  ),
              ]
            : []),
          db
            .prepare(
              "INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at)VALUES(?1,?2,?3,'managed',?4,?5,?6)ON CONFLICT(organization_id,project_id)DO UPDATE SET source_connection_id=excluded.source_connection_id,provider='managed',generation=excluded.generation,commit_sha=excluded.commit_sha,updated_at=excluded.updated_at",
            )
            .bind(
              i.organizationId,
              i.projectId,
              sourceConnectionId,
              generation,
              i.observedHeadCommitSha ?? i.commitSha,
              i.now,
            ),
          ...acceptedPreviewSourceStatements(db, {
            organizationId: i.organizationId,
            projectId: i.projectId,
            eventId: `managed:${i.operationId}`,
            sourceConnectionId,
            sourceGeneration: generation,
            commitSha: i.observedHeadCommitSha ?? i.commitSha,
            now: i.now,
          }),
          ...(p["mode"] === "switch"
            ? [
                db
                  .prepare(
                    "UPDATE github_auto_deploy_configs SET enabled=0,generation=generation+1,updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
                  )
                  .bind(i.organizationId, i.projectId, i.now),
              ]
            : []),
          db
            .prepare(
              "UPDATE managed_source_publications SET state='committed',updated_at=?2 WHERE operation_id=?1",
            )
            .bind(i.operationId, i.now),
          ...managedSourceTerminalStatements(db, i, "succeeded", {
            source_connection_id: sourceConnectionId,
            source_generation: generation,
            commit_sha: i.commitSha,
          }),
          managedInitializationChildStatement(db, i),
        ],
        result: () => result,
      };
    },
  };
  return runCommand(db, command);
}
export async function failApiManagedSourcePublication(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = managedWriteInput
      .extend({ errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u), eventId: ulid })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const command: Command<ManagedSnapshot, void> = {
    name: "managedSource.failPublication",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["operation_events", "audit_events"],
    read: (reader) => readManagedSnapshot(reader, scope(i), i.operationId),
    decide: (s) => {
      const p = s.publication;
      if (!managedAuthorized(s, true) || p === null) managedConflict("scope");
      if (p["state"] === "failed" && p["error_code"] === i.errorCode) return { replay: undefined };
      if (p["state"] === "committed" || p["state"] === "failed") managedConflict("state");
      return {
        statements: [
          ...managedAuthorityGuards(db, s, true),
          ...managedPublicationGuards(db, s),
          db
            .prepare(
              "UPDATE managed_source_publications SET state='failed',error_code=?2,updated_at=?3 WHERE operation_id=?1",
            )
            .bind(i.operationId, i.errorCode, i.now),
          ...managedSourceTerminalStatements(db, i, "failed", { error_code: i.errorCode }),
          managedInitializationChildStatement(db, i),
        ],
        result: () => undefined,
      };
    },
  };
  await runCommand(db, command);
}
