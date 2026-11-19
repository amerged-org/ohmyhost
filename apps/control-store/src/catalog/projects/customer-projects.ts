import { canonicalAuthorizationGuard } from "./customer-projects-access.js";
import { restrictionAllows } from "../identity/operation-delegations.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "../identity/authorization-restriction.js";
import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { CommandConflictError, type Command } from "../../run-command.js";
import {
  projectDomainClaims,
  projectDomainNameReads,
  projectDomainsClaimPlan,
  type ClaimInput,
} from "../domains-mail/cloudflare-project-domains.js";
import type { ClaimAbortRow, DirectoryClaimRow } from "../domains-mail/domain-claims.js";
import {
  conflict,
  hexBytes,
  instant,
  publicTimestamp,
  ringDoorbell,
  routeOrganization,
  rowsOf,
  runMapped,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";
import { activeGrantGuard, activeGrantSelect } from "../identity/mcp-sql.js";
import {
  idempotencyRecordStatement,
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import {
  claimRefusal,
  coreStatements,
  createInitialProjectInput,
  type DirectoryClaim,
  type HandleRelease,
} from "./create-initial-project.js";

const ROUTE = "/v1/projects";
const SOURCE_PRINCIPAL = /^user:[A-Za-z0-9_:-]{1,250}$/u;

/**
 * Every refusal that crosses the service binding. A refusal travels as an error whose MESSAGE is its closed code, so the
 * caller classifies it without parsing prose; anything not listed stays an unclassified failure.
 */
export const ADMISSION_REFUSALS = [
  "idempotency_key_reused",
  "organization_inactive",
  "project_handle_taken",
  "project_identity_conflict",
  "project_deleted",
  "project_reservation_expired",
  "managed_source_scope",
  "invalid_project_cursor",
] as const;

const refuse = (code: (typeof ADMISSION_REFUSALS)[number]) => ({ reject: conflict(code) });

const admissionDelegation = z.strictObject({
  clientId: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/[\s\p{Cc}]/u.test(value), "invalid MCP client identity"),
  consentHash: sha256Hex,
  action: delegationActionInput,
  authorizationRestriction: authorizationRestrictionInput.optional(),
});

export const admitCustomerProjectInput = z
  .strictObject({
    /** Which platform hostnames the initial project claims: the Production or the Development domain root. */
    platform: z.enum(["development", "production"]),
    request: z.strictObject({
      requestId: z.string().trim().min(1).max(256),
      idempotencyKey: z.string().min(1).max(255),
      /** SHA-256 of the canonical request (`rfc8785-v1`), lowercase hex. */
      canonicalRequestDigest: sha256Hex,
    }),
    project: createInitialProjectInput,
    operationCreatedAt: instant,
    delegation: admissionDelegation.optional(),
    /** The waiting managed-source recipe; absent for a project without a template. */
    source: z
      .strictObject({
        template: z.enum(["vite-react", "empty"]),
        sourceConnectionId: ulid,
        initializationEventId: ulid,
        /** The verified Connect identity of the original create call; the store resolves the grant itself. */
        delegation: admissionDelegation.optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (value.request.requestId === value.project.operation.operationId)
      issue("request id must differ from the operation id");
    if (
      value.project.projectHandleVersion !== "human-id-4.2.0-sha256-project-handle-words-v1" ||
      value.project.projectHandle.length < 3
    )
      issue("customer project handle receipt is invalid");
    if (
      value.project.projectId === value.project.developmentEnvironmentId ||
      value.project.projectId === value.project.productionEnvironmentId
    )
      issue("project and environment identities must differ");
    if (
      (value.project.includeDevelopmentEnvironment &&
        value.project.developmentDataEnvironmentId !== value.project.developmentEnvironmentId) ||
      value.project.productionDataEnvironmentId !==
        (value.project.dataMode === "shared" && value.project.includeDevelopmentEnvironment
          ? value.project.developmentEnvironmentId
          : value.project.productionEnvironmentId)
    )
      issue("initial customer data assignments must retain the original environment identities");
    if (value.project.outbox.eventType !== "ProjectProvisioningRequested")
      issue("the admission outbox event is the provisioning request");
    if (value.project.audit.eventType !== "ProjectCreated")
      issue("the admission audit event is the project creation");
    if (
      value.delegation !== undefined &&
      !/^user:user_[A-Za-z0-9_]{1,123}$/u.test(value.project.principalId)
    )
      issue("invalid MCP user identity");
    if (
      value.source?.delegation !== undefined &&
      JSON.stringify(value.source.delegation) !== JSON.stringify(value.delegation)
    )
      issue("source and admission authority must match");
    if (value.source !== undefined) {
      if (!SOURCE_PRINCIPAL.test(value.project.principalId)) issue("source principal is invalid");
      if (/\p{Cc}/u.test(value.request.requestId)) issue("source request id is invalid");
      if (
        value.source.delegation !== undefined &&
        !/^user:user_[A-Za-z0-9_]{1,123}$/u.test(value.project.principalId)
      )
        issue("invalid MCP user identity");
    }
  });

export type AdmitCustomerProjectInput = z.input<typeof admitCustomerProjectInput>;
type Admission = z.output<typeof admitCustomerProjectInput>;

export interface AdmittedCustomerProject {
  readonly outcome: "created" | "replayed";
  readonly operationId: string;
  readonly status: 202;
  readonly location: string;
  readonly body: {
    readonly id: string;
    readonly state: "queued";
    readonly created_at: string;
    readonly updated_at: string;
    readonly project_id: string;
  };
}

interface Snapshot {
  readonly record: ReturnType<typeof storedIdempotencyRecord>;
  readonly claims: readonly DirectoryClaim[];
  readonly releases: readonly HandleRelease[];
  readonly identityExists: boolean;
  readonly aborted: boolean;
  readonly organizationLive: boolean;
  readonly directory: readonly DirectoryClaimRow[];
  readonly aborts: readonly ClaimAbortRow[];
  readonly grant: { readonly grant_id: string } | null;
  readonly userRevoked: boolean;
  /** The project already committed by this operation, including for earlier four-field receipts. */
  readonly receiptProjectId: string | null;
}

async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The first request's stored answer, checked field by field like the PostgreSQL replay (a malformed row is never served).
 * Reconstruct an older receipt's project ID from its scoped operation and verify an extended receipt against that same operation.
 */
function replayOf(
  record: NonNullable<Snapshot["record"]>,
  receiptProjectId: string | null,
): AdmittedCustomerProject {
  const { body, headers } = record;
  const location = headers["Location"];
  const keys = Object.keys(body).sort().join(",");
  const ordinary = keys === "created_at,id,state,updated_at";
  const extended =
    keys === "created_at,id,project_id,state,updated_at" && body["project_id"] === receiptProjectId;
  if (
    record.httpStatus !== 202 ||
    record.operationId === null ||
    typeof location !== "string" ||
    typeof body["id"] !== "string" ||
    body["state"] !== "queued" ||
    typeof body["created_at"] !== "string" ||
    typeof body["updated_at"] !== "string" ||
    receiptProjectId === null ||
    body["id"] !== record.operationId ||
    location !== `/v1/operations/${record.operationId}` ||
    (!ordinary && !extended)
  ) {
    throw conflict("idempotency_record_invalid", "Stored idempotency response is invalid");
  }
  return {
    outcome: "replayed",
    operationId: record.operationId,
    status: 202,
    location,
    body: {
      id: body["id"],
      state: "queued",
      created_at: body["created_at"],
      updated_at: body["updated_at"],
      project_id: receiptProjectId,
    },
  };
}

function admitted(input: Admission): AdmittedCustomerProject {
  const operationId = input.project.operation.operationId;
  return {
    outcome: "created",
    operationId,
    status: 202,
    location: `/v1/operations/${operationId}`,
    body: {
      id: operationId,
      state: "queued",
      created_at: publicTimestamp(input.operationCreatedAt),
      updated_at: publicTimestamp(input.operationCreatedAt),
      project_id: input.project.projectId,
    },
  };
}

/**
 * The waiting recipe of a managed-source template in the admission batch. The row is selected from the very scope the
 * batch just wrote (project, open epoch of the creating principal, the provisioning request), so it exists only for the
 * exact project it belongs to; a guard aborts the batch when it did not. With a Connect delegation the exact consent
 * grant must be current in this batch and the user must not be revoked.
 */
function managedSourceStatements(
  db: D1Database,
  input: Admission,
  grantId: string | null,
): D1PreparedStatement[] {
  const source = input.source;
  /* v8 ignore next -- callers build the statements only for an admission that carries a source */
  if (source === undefined) return [];
  const { project } = input;
  const operationId = project.operation.operationId;
  const delegation = source.delegation;
  const userId = project.principalId.slice(5);
  return [
    ...(delegation === undefined || grantId === null
      ? []
      : [
          canonicalAuthorizationGuard(db, {
            organizationId: project.organizationId,
            principalId: project.principalId,
            action: "projects:create",
          }),
          activeGrantGuard(
            db,
            {
              organizationId: project.organizationId,
              userId,
              clientId: delegation.clientId,
              consentHash: delegation.consentHash,
            },
            null,
            false,
            grantId,
          ),
          guard(
            db,
            "consent_changed",
            "EXISTS (SELECT 1 FROM revocations WHERE kind = 'user' AND resource_id = ?1)",
            [userId],
          ),
        ]),
    db
      .prepare(
        `INSERT INTO managed_source_initializations(organization_id, parent_operation_id, project_id, billing_epoch_id, source_connection_id, initialization_event_id, principal_id, template, region, request_id, state, delegation_grant_id, delegation_client_id, delegation_consent_sha256, delegation_action, delegation_restriction, created_at, updated_at)
         SELECT ?1, ?3, ?2, epoch.billing_epoch_id, ?4, ?5, ?6, ?7, ?8, ?9, 'waiting', ?10, ?11, ?12, ?14, ?15, ?13, ?13
         FROM projects project
         JOIN billing_epochs epoch ON epoch.organization_id = project.organization_id AND epoch.billing_epoch_id = project.active_billing_epoch_id AND epoch.project_id = project.project_id
         JOIN operations operation ON operation.organization_id = project.organization_id AND operation.operation_id = ?3 AND operation.project_id = project.project_id AND operation.billing_epoch_id = epoch.billing_epoch_id
         JOIN outbox_events request ON request.organization_id = operation.organization_id AND request.operation_id = operation.operation_id AND request.project_id = operation.project_id AND request.billing_epoch_id = operation.billing_epoch_id AND request.event_type = 'ProjectProvisioningRequested'
         WHERE project.organization_id = ?1 AND project.project_id = ?2 AND project.owner_state = 'active'
           AND epoch.created_by_principal_id = ?6 AND epoch.started_at = project.created_at
           AND project.created_organization_id = ?1 AND project.region = ?8`,
      )
      .bind(
        project.organizationId,
        project.projectId,
        operationId,
        source.sourceConnectionId,
        source.initializationEventId,
        project.principalId,
        source.template,
        project.region,
        input.request.requestId,
        grantId,
        delegation?.clientId ?? null,
        delegation?.consentHash ?? null,
        project.createdAt,
        delegation?.action ?? null,
        delegation?.authorizationRestriction === undefined
          ? null
          : JSON.stringify(delegation.authorizationRestriction),
      ),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS (SELECT 1 FROM managed_source_initializations WHERE organization_id = ?1 AND parent_operation_id = ?2)",
      [project.organizationId, operationId],
    ),
  ];
}

/**
 * Customer project admission as ONE core batch (the single PostgreSQL transaction of `createProject`): the canonical HTTP
 * idempotency receipt with its 202 answer, the Directory claim of the id and handle, the project with its one current
 * owner, billing epoch, environments and data assignments, the first operation, audit and outbox event, the optional
 * waiting managed-source recipe and the claim of both initial platform domains commit together or not at all. A late
 * failure of any statement rolls everything back, so no receipt, handle or domain is left behind.
 *
 * The receipt is read first: the same key with the same canonical request answers the ORIGINAL response whatever new
 * identifiers this attempt proposed; another request under the key is `idempotency_key_reused`. A receipt is replayed
 * until the retention sweep deletes it, as before. A handle another project holds is `project_handle_taken`: the caller
 * proposes its next collision attempt. The consumer that executes a managed-source template is NOT part of this
 * command; the recipe stays `waiting`.
 */
export async function admitCustomerProject(
  context: CatalogContext,
  rawInput: unknown,
): Promise<AdmittedCustomerProject> {
  const input = admitCustomerProjectInput.parse(rawInput);
  const { project, request } = input;
  const core = await routeOrganization(context, project.organizationId);
  const operationId = project.operation.operationId;
  const domainInput: ClaimInput = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    platform: input.platform,
    proposedOperationId: operationId,
    principalId: project.principalId,
    idempotencyKeySha256: new Uint8Array(
      await sha256Bytes(`initial-project-domains:${operationId}`),
    ),
    requestSha256: new Uint8Array(hexBytes(request.canonicalRequestDigest)),
    configuredAt: project.createdAt,
  };
  const key = {
    organizationId: project.organizationId,
    principalId: project.principalId,
    httpMethod: "POST",
    routeTemplate: ROUTE,
    idempotencyKey: request.idempotencyKey,
  };
  const names = projectDomainClaims(domainInput, project.projectHandle, operationId);
  const delegation = input.delegation;
  const command: Command<Snapshot, AdmittedCustomerProject> = {
    name: "projects.admitCustomerProject",
    input,
    retryOn: ["precondition_changed", "claim_lost", "consent_changed", "scope_inactive"],
    naturalKeyTables: [
      "api_idempotency_records",
      "projects",
      "operations",
      "project_directory",
      "project_identities",
      "domain_directory",
      "cloudflare_project_domains",
      "managed_source_initializations",
    ],
    read: async (reader) => {
      const [
        record,
        claims,
        identity,
        aborted,
        organization,
        directory,
        aborts,
        grant,
        revoked,
        releases,
        receiptOperation,
      ] = await reader.batch([
        readIdempotencyRecordStatement(reader, key),
        reader
          .prepare(
            "SELECT project_id, organization_id, handle, state FROM project_directory WHERE project_id = ?1 OR handle = ?2",
          )
          .bind(project.projectId, project.projectHandle),
        reader
          .prepare("SELECT 1 AS present FROM project_identities WHERE project_id = ?1")
          .bind(project.projectId),
        reader
          .prepare("SELECT 1 AS aborted FROM project_creation_aborts WHERE project_id = ?1")
          .bind(project.projectId),
        reader
          .prepare(
            "SELECT 1 AS live FROM organizations WHERE organization_id = ?1 AND state <> 'deleted'",
          )
          .bind(project.organizationId),
        ...projectDomainNameReads(reader, names),
        delegation === undefined
          ? reader.prepare("SELECT NULL AS grant_id WHERE 0")
          : activeGrantSelect(
              reader,
              {
                organizationId: project.organizationId,
                userId: project.principalId.slice(5),
                clientId: delegation.clientId,
                consentHash: delegation.consentHash,
              },
              null,
              false,
            ),
        reader
          .prepare("SELECT 1 AS revoked FROM revocations WHERE kind = 'user' AND resource_id = ?1")
          .bind(project.principalId.slice(5)),
        reader
          .prepare(
            "SELECT organization_id, quarantined_until FROM project_handle_releases WHERE handle = ?1",
          )
          .bind(project.projectHandle),
        reader
          .prepare(
            "SELECT operation.project_id FROM operations operation JOIN api_idempotency_records receipt ON receipt.organization_id = operation.organization_id AND receipt.operation_id = operation.operation_id WHERE receipt.organization_id = ?1 AND receipt.principal_id = ?2 AND receipt.http_method = ?3 AND receipt.route_template = ?4 AND receipt.idempotency_key = ?5",
          )
          .bind(
            key.organizationId,
            key.principalId,
            key.httpMethod,
            key.routeTemplate,
            key.idempotencyKey,
          ),
      ]);
      return {
        receiptProjectId: rowsOf<{ project_id: string }>(receiptOperation)[0]?.project_id ?? null,
        record: storedIdempotencyRecord(rowsOf(record)[0]),
        claims: rowsOf<DirectoryClaim>(claims),
        identityExists: rowsOf(identity).length > 0,
        aborted: rowsOf(aborted).length > 0,
        organizationLive: rowsOf(organization).length > 0,
        directory: rowsOf<DirectoryClaimRow>(directory),
        aborts: rowsOf<ClaimAbortRow>(aborts),
        grant: rowsOf<{ grant_id: string }>(grant)[0] ?? null,
        userRevoked: rowsOf(revoked).length > 0,
        releases: rowsOf<HandleRelease>(releases),
      };
    },
    decide: (snapshot) => {
      // A deleted organization admits nothing, a replay included (the PostgreSQL command checked it first).
      if (!snapshot.organizationLive) return refuse("organization_inactive");
      if (snapshot.record !== null) {
        if (snapshot.record.digestHex !== request.canonicalRequestDigest) {
          return refuse("idempotency_key_reused");
        }
        return { replay: replayOf(snapshot.record, snapshot.receiptProjectId) };
      }
      const claim = claimRefusal(snapshot.claims, project, snapshot.releases);
      if (claim instanceof CommandConflictError) {
        return refuse(claim.code as (typeof ADMISSION_REFUSALS)[number]);
      }
      if (snapshot.identityExists) return refuse("project_identity_conflict");
      if (snapshot.aborted) return refuse("project_reservation_expired");
      if (
        delegation !== undefined &&
        (snapshot.grant === null ||
          snapshot.userRevoked ||
          delegation.action !== "projects:create" ||
          !restrictionAllows(delegation.authorizationRestriction, {
            action: "projects:create",
            organizationId: project.organizationId,
          }))
      ) {
        return refuse("managed_source_scope");
      }
      const domains = projectDomainsClaimPlan(
        core.db,
        domainInput,
        project.projectHandle,
        snapshot,
      );
      if ("reject" in domains) return domains;
      return {
        statements: [
          idempotencyRecordStatement(
            core.db,
            key,
            { digestHex: request.canonicalRequestDigest, requestId: request.requestId },
            {
              operationId,
              httpStatus: 202,
              headers: { Location: `/v1/operations/${operationId}` },
              body: {
                id: operationId,
                state: "queued",
                created_at: publicTimestamp(input.operationCreatedAt),
                updated_at: publicTimestamp(input.operationCreatedAt),
                project_id: project.projectId,
              },
            },
            project.createdAt,
          ),
          ...coreStatements(core.db, project, input.operationCreatedAt),
          ...(delegation === undefined || snapshot.grant === null
            ? []
            : [
                canonicalAuthorizationGuard(core.db, {
                  organizationId: project.organizationId,
                  principalId: project.principalId,
                  action: "projects:create",
                }),
                activeGrantGuard(
                  core.db,
                  {
                    organizationId: project.organizationId,
                    userId: project.principalId.slice(5),
                    clientId: delegation.clientId,
                    consentHash: delegation.consentHash,
                  },
                  null,
                  false,
                  snapshot.grant.grant_id,
                ),
                core.db
                  .prepare(
                    `INSERT INTO operation_mcp_delegations(organization_id,operation_id,project_id,environment_id,billing_epoch_id,principal_id,grant_id,client_id,consent_hash,requires_publication,event_type,created_at,authorization_action,authorization_restriction)
              SELECT organization_id,operation_id,project_id,?3,billing_epoch_id,?4,?5,?6,?7,0,'ProjectProvisioningRequested',?8,?9,?10 FROM operations WHERE organization_id=?1 AND operation_id=?2`,
                  )
                  .bind(
                    project.organizationId,
                    operationId,
                    project.includeDevelopmentEnvironment
                      ? project.developmentEnvironmentId
                      : project.productionEnvironmentId,
                    project.principalId,
                    snapshot.grant.grant_id,
                    delegation.clientId,
                    delegation.consentHash,
                    project.createdAt,
                    delegation.action,
                    delegation.authorizationRestriction === undefined
                      ? null
                      : JSON.stringify(delegation.authorizationRestriction),
                  ),
              ]),
          ...(project.dataMode !== "shared"
            ? []
            : [
                core.db
                  .prepare(
                    "INSERT OR IGNORE INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
                  )
                  .bind(
                    project.organizationId,
                    project.projectId,
                    project.productionEnvironmentId,
                    project.createdAt,
                  ),
              ]),
          ...(input.source === undefined
            ? []
            : managedSourceStatements(core.db, input, snapshot.grant?.grant_id ?? null)),
          ...domains.statements,
        ],
        result: () => admitted(input),
      };
    },
  };
  const result = await runMapped(core.db, command, {
    organization_inactive: () => conflict("organization_inactive"),
  });
  // The doorbell is advisory and idempotent (the earliest due time wins): every attempt rings it again.
  await ringDoorbell(
    context.directory,
    "outbox",
    core.shardId,
    project.outbox.availableAt ?? project.outbox.createdAt,
  );
  return result;
}

export const listCustomerProjectsInput = z.strictObject({
  organizationIds: z.array(ulid),
  projectIds: z.array(ulid).optional(),
  cursor: ulid.optional(),
  limit: z.number().int().min(1).max(100),
});

export interface CustomerProjectView {
  readonly projectId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly handle: string;
  readonly dataMode: "shared" | "isolated";
  readonly region: "us" | "eu";
  readonly createdAt: string;
}

export interface CustomerProjectPage {
  readonly projects: readonly CustomerProjectView[];
  readonly nextCursor: string | null;
}

interface ProjectRow {
  readonly project_id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly handle: string;
  readonly data_mode: "shared" | "isolated";
  readonly region: "us" | "eu";
  readonly created_at: string;
}

const viewOf = (row: ProjectRow): CustomerProjectView => ({
  projectId: row.project_id,
  organizationId: row.organization_id,
  name: row.name,
  handle: row.handle,
  dataMode: row.data_mode,
  region: row.region,
  createdAt: publicTimestamp(row.created_at),
});

/**
 * One page of the active, undeleted projects of the AUTHORIZED organizations, ordered by global project id. The caller
 * names the set it is authorized for; the command never widens it. A cursor must be a project of that very set (and of
 * the optional project filter), otherwise `invalid_project_cursor`. The cursor check and the page are one read batch.
 */
export async function listCustomerProjects(
  context: CatalogContext,
  rawInput: unknown,
): Promise<CustomerProjectPage> {
  const input = listCustomerProjectsInput.parse(rawInput);
  if (input.organizationIds.length === 0) return { projects: [], nextCursor: null };
  const db = (await context.router.routeShard(0)).db;
  const organizations = JSON.stringify(input.organizationIds);
  const filter = JSON.stringify(input.projectIds ?? []);
  const filtered = input.projectIds !== undefined ? 1 : 0;
  const [cursor, page] = await db.batch([
    db
      .prepare(
        `SELECT 1 AS present FROM projects WHERE project_id = ?2 AND owner_state = 'active'
           AND organization_id IN (SELECT value FROM json_each(?1))
           AND (?3 = 0 OR project_id IN (SELECT value FROM json_each(?4)))`,
      )
      .bind(organizations, input.cursor ?? null, filtered, filter),
    db
      .prepare(
        `SELECT project_id, organization_id, name, handle, data_mode, region, created_at FROM projects
         WHERE organization_id IN (SELECT value FROM json_each(?1)) AND owner_state = 'active'
           AND lifecycle_state <> 'deleted' AND (?2 IS NULL OR project_id > ?2)
           AND (?4 = 0 OR project_id IN (SELECT value FROM json_each(?5)))
         ORDER BY project_id ASC LIMIT ?3`,
      )
      .bind(organizations, input.cursor ?? null, input.limit + 1, filtered, filter),
  ]);
  if (input.cursor !== undefined && rowsOf(cursor).length !== 1) {
    throw conflict("invalid_project_cursor");
  }
  const rows = rowsOf<ProjectRow>(page);
  const items = rows.slice(0, input.limit);
  return {
    projects: items.map(viewOf),
    nextCursor: rows.length > input.limit ? (items.at(-1)?.project_id ?? null) : null,
  };
}

export const getCustomerProjectInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
});

/** The project as the CURRENT owner scope sees it (a transferred former owner sees nothing); a deleted project stays readable. */
export async function getCustomerProject(
  context: CatalogContext,
  rawInput: unknown,
): Promise<CustomerProjectView | null> {
  const input = getCustomerProjectInput.parse(rawInput);
  const core = await routeOrganization(context, input.organizationId);
  const row = await core.db
    .prepare(
      "SELECT project_id, organization_id, name, handle, data_mode, region, created_at FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND owner_state <> 'transferred'",
    )
    .bind(input.organizationId, input.projectId)
    .first<ProjectRow>();
  return row === null ? null : viewOf(row);
}

export const readTakenProjectHandlesInput = z.strictObject({
  candidates: z.array(z.string()),
});

/** The original global project-table lookup: current project handles include retained deleted rows, not former-owner aliases. */
export async function readTakenProjectHandles(
  context: CatalogContext,
  rawInput: unknown,
): Promise<string[]> {
  const input = readTakenProjectHandlesInput.parse(rawInput);
  const wanted = [...new Set(input.candidates)].filter((handle) => handle.length > 0).slice(0, 64);
  if (wanted.length === 0) return [];
  const db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(
      "SELECT handle FROM projects WHERE owner_state <> 'transferred' AND handle IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(wanted))
    .all<{ handle: string }>();
  return result.results.map((row) => row.handle);
}
