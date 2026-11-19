import type { D1Database } from "../../d1-types.js";
import type { Command, Plan } from "../../run-command.js";
import { organizationLiveGuard } from "../common.js";
import { readSnapshot, type PlatformContext } from "../platform-support.js";
import { DELETE_AUTHORIZED, deleteAuthorityParams } from "./authority.js";
import {
  DatabaseProviderConflictError,
  canonicalJson,
  cleanupLocatorOf,
  parseRegistration,
  deletionRequest,
  recordRevocationInput,
  retireTargetInput,
  sameRegistration,
  type DeletionRequest,
  type PgcfRegistration,
  isPgcf,
} from "./contracts.js";
import { readOnOrganization, runOnOrganization, stale } from "./run.js";

type Row = Record<string, unknown>;

export interface PgcfDeletionRead {
  readonly claim: DeletionRequest & { readonly claimId: string };
  readonly registration: PgcfRegistration | null;
  readonly registrationClaimId: string | null;
  readonly region: "us" | "eu";
}

const TARGET_SQL = `SELECT r.region_id, h.state, h.target_version FROM database_provider_target_heads h JOIN database_provider_target_revisions r ON r.organization_id = h.organization_id AND r.project_id = h.project_id AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version WHERE h.organization_id = ?1 AND h.project_id = ?2 AND h.physical_environment_id = ?3 AND r.provider = 'pgcf' AND r.provider_project_id = ?4 AND r.database_id = ?5`;
/** The newest registration row of the environment, a receipt before a reservation of the same version. */
const LATEST_ROW_SQL = `SELECT metadata, claim_id, registration_version FROM (SELECT metadata, claim_id, registration_version, 0 AS source FROM project_database_registration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 UNION ALL SELECT metadata, claim_id, registration_version, 1 AS source FROM project_database_registration_reservations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3) ORDER BY registration_version DESC, source ASC LIMIT 1`;
const LATEST_VERSION_SQL = `(SELECT COALESCE(max(registration_version), 0) FROM (SELECT registration_version FROM project_database_registration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 UNION ALL SELECT registration_version FROM project_database_registration_reservations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3))`;

const authorityParams = (request: DeletionRequest) =>
  deleteAuthorityParams(request, cleanupLocatorOf(request.databaseId));
const scopeOf = (request: DeletionRequest) => [
  request.organizationId,
  request.projectId,
  request.physicalEnvironmentId,
];

interface DeletionSnapshot {
  readonly authorized: boolean;
  readonly target: Row | null;
  readonly latest: Row | null;
  readonly completed: boolean;
  readonly globalClaim: Row | null;
}

async function readDeletionSnapshot(
  db: D1Database,
  request: DeletionRequest,
): Promise<DeletionSnapshot> {
  const [authorized, target, latest, completed, globalClaim] = await readSnapshot(db, [
    [`SELECT 1 WHERE ${DELETE_AUTHORIZED}`, ...authorityParams(request)],
    [TARGET_SQL, ...scopeOf(request), request.providerProjectId, request.databaseId],
    [LATEST_ROW_SQL, ...scopeOf(request)],
    [
      "SELECT 1 FROM database_provider_operations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND step = 'database.delete' AND state = 'succeeded' AND database_id = ?5",
      ...scopeOf(request),
      request.operationId,
      request.databaseId,
    ],
    [
      "SELECT *,json_array(organization_id,project_id,physical_environment_id,target_version,claim_id,state) fingerprint FROM pgcf_database_claims WHERE provider_project_id=?1 AND database_id=?2",
      request.providerProjectId,
      request.databaseId,
    ],
  ]);
  return {
    globalClaim: globalClaim?.[0] ?? null,
    authorized: (authorized?.length ?? 0) === 1,
    target: target?.length === 1 ? (target[0] ?? null) : null,
    latest: latest?.[0] ?? null,
    completed: (completed?.length ?? 0) === 1,
  };
}

type Decision = { readonly ok: true; readonly read: PgcfDeletionRead } | { readonly ok: false };

/** The Postgres `readPgcfDatabaseDeletion` decision: the exact PGCF target and the registration generation it expects. */
function decideDeletion(request: DeletionRequest, snapshot: DeletionSnapshot): Decision {
  if (!snapshot.authorized || snapshot.target === null) return { ok: false };
  const identity = snapshot.globalClaim;
  if (
    identity !== null &&
    (identity["organization_id"] !== request.organizationId ||
      identity["project_id"] !== request.projectId ||
      identity["physical_environment_id"] !== request.physicalEnvironmentId)
  )
    return { ok: false };
  const parsed =
    snapshot.latest === null ? null : parseRegistration(String(snapshot.latest["metadata"]));
  if (parsed !== null && !isPgcf(parsed)) return { ok: false };
  if (
    parsed !== null &&
    (parsed.databaseId !== request.databaseId ||
      parsed.providerProjectId !== request.providerProjectId ||
      (parsed.registrationVersion !== request.registrationVersion &&
        !(
          parsed.status === "revoked" &&
          parsed.registrationVersion === Number(request.registrationVersion) + 1
        )))
  )
    return { ok: false };
  if (parsed === null && request.registrationVersion !== null) return { ok: false };
  return {
    ok: true,
    read: {
      claim: { ...request, claimId: request.operationId },
      registration: parsed,
      registrationClaimId: parsed === null ? null : String(snapshot.latest?.["claim_id"]),
      region: snapshot.target["region_id"] === "us-dev" ? "us" : "eu",
    },
  };
}

/** Read-only: what a deletion or data-change cleanup may act on, under the frozen deletion inventory. */
export async function readPgcfDatabaseDeletion(
  context: PlatformContext,
  input: unknown,
): Promise<PgcfDeletionRead> {
  const request = deletionRequest.parse(input);
  return readOnOrganization(context, request.organizationId, async (db) => {
    const decision = decideDeletion(request, await readDeletionSnapshot(db, request));
    if (!decision.ok) throw new DatabaseProviderConflictError();
    return decision.read;
  });
}

/** Guards shared by the two writers: authority, exact target and the registry generation the decision read. */
function fenceStatements(db: D1Database, request: DeletionRequest, latestVersion: number) {
  return [
    organizationLiveGuard(db, request.organizationId),
    stale(db, `NOT ${DELETE_AUTHORIZED}`, authorityParams(request)),
    stale(db, `NOT EXISTS (${TARGET_SQL})`, [
      ...scopeOf(request),
      request.providerProjectId,
      request.databaseId,
    ]),
    stale(db, `${LATEST_VERSION_SQL} <> ?4`, [...scopeOf(request), latestVersion]),
  ];
}

/**
 * Records the revocation of the registration under the original deletion or data-change proof. The receipt keeps
 * the claim of the generation it revokes. An already recorded identical revocation is a replay.
 */
export async function recordPgcfDeletionRevocation(
  context: PlatformContext,
  input: unknown,
): Promise<void> {
  const { request, registration, observedAt } = recordRevocationInput.parse(input);
  return runOnOrganization(
    context,
    request.organizationId,
    (db: D1Database): Command<DeletionSnapshot, void> => ({
      name: "database.recordPgcfDeletionRevocation",
      input: { request, registration },
      retryOn: ["precondition_changed"],
      read: () => readDeletionSnapshot(db, request),
      decide(snapshot): Plan<void> {
        const refuse = { reject: new DatabaseProviderConflictError() };
        const decision = decideDeletion(request, snapshot);
        if (!decision.ok) return refuse;
        const { registration: prior, registrationClaimId } = decision.read;
        if (
          prior === null ||
          registrationClaimId === null ||
          registration.status !== "revoked" ||
          registration.databaseId !== request.databaseId ||
          registration.operationId !== request.operationId
        )
          return refuse;
        if (prior.status === "revoked")
          return sameRegistration(prior, registration) ? { replay: undefined } : refuse;
        const expected = {
          ...prior,
          status: "revoked",
          registrationVersion: prior.registrationVersion + 1,
          operationId: request.operationId,
        };
        if (!sameRegistration(expected, registration)) return refuse;
        const values = [
          ...scopeOf(request),
          request.operationId,
          registrationClaimId,
          registration.registrationVersion,
          canonicalJson(registration),
        ];
        return {
          statements: [
            ...fenceStatements(db, request, prior.registrationVersion),
            db
              .prepare(
                "INSERT INTO project_database_registration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, status, metadata, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'revoked', ?7, ?8) ON CONFLICT DO NOTHING",
              )
              .bind(...values, observedAt),
            // The Postgres insert ignored a conflicting row silently; here the exact receipt must exist.
            stale(
              db,
              "NOT EXISTS (SELECT 1 FROM project_database_registration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND claim_id = ?5 AND registration_version = ?6 AND metadata = ?7)",
              values,
            ),
          ],
          result: () => undefined,
        };
      },
    }),
  );
}

/**
 * Retires the target head once the provider confirmed the delete step and the registration is no longer active.
 * Metadata only: the customer database and every provider resource are untouched by this command. Retiring an
 * already retired head is a replay; the serving interval closes through the head's trigger in the same batch.
 */
export async function retirePgcfDatabaseTarget(
  context: PlatformContext,
  input: unknown,
): Promise<void> {
  const { request, retiredAt } = retireTargetInput.parse(input);
  return runOnOrganization(
    context,
    request.organizationId,
    (db: D1Database): Command<DeletionSnapshot, void> => ({
      name: "database.retirePgcfTarget",
      input: { request },
      retryOn: ["precondition_changed"],
      read: () => readDeletionSnapshot(db, request),
      decide(snapshot): Plan<void> {
        const refuse = { reject: new DatabaseProviderConflictError() };
        const decision = decideDeletion(request, snapshot);
        if (!decision.ok || decision.read.registration?.status === "active" || !snapshot.completed)
          return refuse;
        if (snapshot.target?.["state"] !== "active" && snapshot.globalClaim === null)
          return { replay: undefined };
        return {
          statements: [
            ...fenceStatements(db, request, decision.read.registration?.registrationVersion ?? 0),
            stale(
              db,
              "(SELECT json_array(organization_id,project_id,physical_environment_id,target_version,claim_id,state) FROM pgcf_database_claims WHERE provider_project_id=?1 AND database_id=?2) IS NOT ?3",
              [
                request.providerProjectId,
                request.databaseId,
                snapshot.globalClaim?.["fingerprint"] ?? null,
              ],
            ),
            stale(
              db,
              "NOT EXISTS (SELECT 1 FROM database_provider_operations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND step = 'database.delete' AND state = 'succeeded' AND database_id = ?5)",
              [...scopeOf(request), request.operationId, request.databaseId],
            ),
            db
              .prepare(
                "UPDATE database_provider_target_heads SET state = 'retired', updated_at = ?4 WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND state = 'active'",
              )
              .bind(...scopeOf(request), retiredAt),
            stale(
              db,
              "EXISTS (SELECT 1 FROM database_provider_target_heads WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND state = 'active')",
              scopeOf(request),
            ),
            stale(
              db,
              "EXISTS(SELECT 1 FROM database_provider_target_heads h JOIN database_provider_target_revisions r ON r.organization_id=h.organization_id AND r.project_id=h.project_id AND r.physical_environment_id=h.physical_environment_id AND r.target_version=h.target_version WHERE h.state='active' AND r.provider='pgcf' AND r.provider_project_id=?1 AND r.database_id=?2)",
              [request.providerProjectId, request.databaseId],
            ),
            // The deleted database takes its roles with it: every credential it still holds is closed here, so the
            // access sweep never retries a role of a retired database. The reason is the closest allowed one.
            db
              .prepare(
                "UPDATE project_database_access SET revoked_at=COALESCE(revoked_at,?3),revoked_by=COALESCE(revoked_by,'platform'),revocation_reason=COALESCE(revocation_reason,'data_change'),role_dropped_at=COALESCE(role_dropped_at,?3) WHERE provider='pgcf' AND provider_project_id=?1 AND database_id=?2 AND role_dropped_at IS NULL",
              )
              .bind(request.providerProjectId, request.databaseId, retiredAt),
            db
              .prepare(
                "INSERT OR IGNORE INTO pgcf_database_claim_aborts(provider_project_id,database_id,organization_id,claim_id,aborted_at) SELECT provider_project_id,database_id,organization_id,claim_id,?6 FROM pgcf_database_claims WHERE provider_project_id=?1 AND database_id=?2 AND organization_id=?3 AND project_id=?4 AND physical_environment_id=?5",
              )
              .bind(request.providerProjectId, request.databaseId, ...scopeOf(request), retiredAt),
            db
              .prepare(
                "DELETE FROM pgcf_database_claims WHERE provider_project_id=?1 AND database_id=?2 AND organization_id=?3 AND project_id=?4 AND physical_environment_id=?5 AND EXISTS(SELECT 1 FROM pgcf_database_claim_aborts a WHERE a.provider_project_id=pgcf_database_claims.provider_project_id AND a.database_id=pgcf_database_claims.database_id AND a.claim_id=pgcf_database_claims.claim_id)",
              )
              .bind(request.providerProjectId, request.databaseId, ...scopeOf(request)),
          ],
          result: () => undefined,
        };
      },
    }),
  );
}
