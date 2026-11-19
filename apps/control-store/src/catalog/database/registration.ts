import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import type { Command, Plan } from "../../run-command.js";
import { addMilliseconds, organizationLiveGuard } from "../common.js";
import { readSnapshot, shardOfOrganization, type PlatformContext } from "../platform-support.js";
import {
  ACTIVE_TARGET_SQL,
  CLAIM_SQL,
  REAUTHORIZATION_SQL,
  claimParams,
  reauthorizationParams,
} from "./authority.js";
import {
  DatabaseProviderConflictError,
  ORIGIN_HOST,
  ProjectDatabaseRegistrationConflictError,
  canonicalJson,
  isPgcf,
  parseRegistration,
  putReauthorizationInput,
  putRegistrationInput,
  readRegistrationInput,
  reauthorizationInput,
  regionOf,
  reserveRegistrationInput,
  runtimeRoleOf,
  type AnyRegistration,
  type PgcfRegistration,
  type ReauthorizationInput,
} from "./contracts.js";
import { conflictsAs, runOnOrganization, stale } from "./run.js";

type Row = Record<string, unknown>;

export const RECEIPTS_OF = `FROM project_database_registration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3`;
export const RESERVATIONS_OF = `FROM project_database_registration_reservations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3`;
const EXACT = `organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND claim_id = ?5 AND registration_version = ?6 AND metadata = ?7`;
export const ENVIRONMENTS_JSON = `(SELECT COALESCE(json_group_array(listed.environment_id), '[]') FROM (SELECT e.environment_id FROM environments e WHERE e.organization_id = ?1 AND e.project_id = ?2 AND e.name IN('dev','prod') AND (SELECT a.data_environment_id FROM environment_data_assignments a WHERE a.organization_id = e.organization_id AND a.project_id = e.project_id AND a.environment_id = e.environment_id ORDER BY a.assignment_version DESC LIMIT 1) = ?3 ORDER BY e.environment_id) listed)`;
export const LATEST_VERSION = `(SELECT COALESCE(max(registration_version), 0) ${RECEIPTS_OF})`;
const LATEST_RECEIPT = `SELECT metadata ${RECEIPTS_OF} ORDER BY registration_version DESC LIMIT 1`;
/** The registration the product serves: the latest receipt of a physical environment under an active owner. */
const SERVED_RECEIPT = `SELECT r.metadata FROM project_database_registration_receipts r JOIN projects p ON p.organization_id = r.organization_id AND p.project_id = r.project_id WHERE r.organization_id = ?1 AND r.project_id = ?2 AND r.physical_environment_id = ?3 AND p.owner_state = 'active' ORDER BY r.registration_version DESC LIMIT 1`;

interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
}
interface Claim extends Scope {
  readonly operationId: string;
  readonly claimId: string;
}
const scopeParams = (input: Scope) => [
  input.organizationId,
  input.projectId,
  input.physicalEnvironmentId,
];
const stored = (metadata: unknown): AnyRegistration => parseRegistration(String(metadata));
const sameList = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify(left) === JSON.stringify(right);
const exact = (claim: Claim, registration: PgcfRegistration): (string | number)[] => [
  ...claimParams(claim),
  registration.registrationVersion,
  canonicalJson(registration),
];
const matchesClaim = (claim: Claim, registration: PgcfRegistration) =>
  registration.organizationId === claim.organizationId &&
  registration.projectId === claim.projectId &&
  registration.physicalEnvironmentId === claim.physicalEnvironmentId &&
  registration.operationId === claim.operationId &&
  registration.originUser === runtimeRoleOf(claim.physicalEnvironmentId) &&
  registration.originDatabase === registration.databaseId;

function reservationInsert(
  db: D1Database,
  claim: Claim,
  registration: PgcfRegistration,
): D1PreparedStatement[] {
  const values = exact(claim, registration);
  return [
    db
      .prepare(
        "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING",
      )
      .bind(...values),
    // A different row under this version, or a lost insert, leaves nothing to land: stale, decide again.
    stale(
      db,
      `NOT EXISTS (SELECT 1 FROM project_database_registration_reservations WHERE ${EXACT})`,
      values,
    ),
  ];
}

/** Moves the exact reservation to its receipt (twin-safe), then requires that exact receipt to exist. */
function receiptInsert(
  db: D1Database,
  claim: Claim,
  registration: PgcfRegistration,
  observedAt: string,
): D1PreparedStatement[] {
  const values = exact(claim, registration);
  return [
    db
      .prepare(
        `INSERT INTO project_database_registration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, status, metadata, observed_at) SELECT organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, json_extract(metadata, '$.status'), metadata, ?8 FROM project_database_registration_reservations WHERE ${EXACT} ON CONFLICT DO NOTHING`,
      )
      .bind(...values, observedAt),
    stale(
      db,
      `NOT EXISTS (SELECT 1 FROM project_database_registration_receipts WHERE ${EXACT})`,
      values,
    ),
  ];
}

/** Only a PGCF registration is returned: a historical Neon one is provenance, never a target. */
export async function readPgcfDatabaseRegistration(
  context: PlatformContext,
  input: unknown,
): Promise<PgcfRegistration | null> {
  const scope = readRegistrationInput.parse(input);
  const db = await shardOfOrganization(context, scope.organizationId);
  const [latest] = await readSnapshot(db, [[SERVED_RECEIPT, ...scopeParams(scope)]]);
  const row = latest?.[0];
  if (row === undefined) return null;
  const registration = stored(row["metadata"]);
  return isPgcf(registration) ? registration : null;
}

export interface ReservedRegistration {
  readonly registration: PgcfRegistration;
  readonly completed: boolean;
  readonly previous: AnyRegistration | null;
}

interface ReserveSnapshot {
  readonly claimed: boolean;
  readonly target: Row | null;
  readonly migrations: readonly Row[];
  readonly environments: readonly string[];
  readonly prior: AnyRegistration | null;
  readonly retirements: readonly Row[];
  readonly reservations: readonly Row[];
}

function reserveCommand(
  db: D1Database,
  claim: ReturnType<typeof reserveRegistrationInput.parse>,
): Command<ReserveSnapshot, ReservedRegistration> {
  return {
    name: "database.reservePgcfRegistration",
    input: claim,
    retryOn: ["precondition_changed"],
    async read() {
      const [claimed, target, migrations, environments, prior, retirements, reservations] =
        await readSnapshot(db, [
          [CLAIM_SQL, ...claimParams(claim)],
          [ACTIVE_TARGET_SQL, ...scopeParams(claim)],
          [
            "SELECT provider_project_id, database_id FROM pgcf_database_migration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4",
            ...claimParams(claim).slice(0, 4),
          ],
          [`SELECT ${ENVIRONMENTS_JSON} AS ids`, ...scopeParams(claim)],
          [LATEST_RECEIPT, ...scopeParams(claim)],
          [
            "SELECT target_version, provider_project_id, branch_id FROM database_provider_legacy_retirements WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3",
            ...scopeParams(claim),
          ],
          [
            `SELECT r.registration_version, r.operation_id, r.claim_id, r.metadata, o.state AS operation_state,
                    EXISTS (SELECT 1 FROM product_provider_mutation_claims c WHERE c.organization_id = r.organization_id AND c.project_id = r.project_id AND c.operation_id = r.operation_id) AS has_claim
               FROM project_database_registration_reservations r
               LEFT JOIN operations o ON o.organization_id = r.organization_id AND o.project_id = r.project_id AND o.operation_id = r.operation_id
              WHERE r.organization_id = ?1 AND r.project_id = ?2 AND r.physical_environment_id = ?3`,
            ...scopeParams(claim),
          ],
        ]);
      const priorRow = prior?.[0];
      return {
        claimed: (claimed?.length ?? 0) === 1,
        target: target?.[0] ?? null,
        migrations: migrations ?? [],
        environments: JSON.parse(String(environments?.[0]?.["ids"] ?? "[]")) as string[],
        prior: priorRow === undefined ? null : stored(priorRow["metadata"]),
        retirements: retirements ?? [],
        reservations: reservations ?? [],
      };
    },
    decide(snapshot): Plan<ReservedRegistration> {
      const refuse = { reject: new DatabaseProviderConflictError() };
      const target = snapshot.target;
      if (
        !snapshot.claimed ||
        target === null ||
        target["provider"] !== "pgcf" ||
        !ORIGIN_HOST.test(claim.originHost)
      )
        return refuse;
      const databaseId = String(target["database_id"]);
      const providerProjectId = String(target["provider_project_id"]);
      const targetVersion = Number(target["target_version"]);
      if (
        !snapshot.migrations.some(
          (row) =>
            row["database_id"] === databaseId && row["provider_project_id"] === providerProjectId,
        )
      )
        return refuse;
      let previous: AnyRegistration | null = null;
      const existing = snapshot.prior;
      if (existing !== null) {
        if (isPgcf(existing)) {
          if (
            existing.databaseId !== databaseId ||
            existing.providerProjectId !== providerProjectId ||
            existing.originHost !== claim.originHost
          )
            return refuse;
          if (
            existing.status === "active" &&
            sameList(existing.authorizedEnvironmentIds, snapshot.environments)
          )
            return { replay: { registration: existing, completed: true, previous: null } };
          // Fresh canonical Dev identities rejoin the same shared database at a new registry generation.
          previous = existing;
        } else {
          // A provider change is explicit: the owner-proven absence of exactly that Neon branch at the previous target.
          const absent = snapshot.retirements.some(
            (row) =>
              Number(row["target_version"]) === targetVersion - 1 &&
              row["provider_project_id"] === existing.providerProjectId &&
              row["branch_id"] === existing.branchId,
          );
          if (!absent || !sameList(existing.authorizedEnvironmentIds, snapshot.environments))
            return refuse;
          previous = existing;
        }
      }
      const region = regionOf(String(target["region_id"]));
      const floor = previous?.registrationVersion ?? 0;
      const pending = snapshot.reservations.filter(
        (row) => Number(row["registration_version"]) > floor,
      );
      const own = pending.filter(
        (row) => row["operation_id"] === claim.operationId && row["claim_id"] === claim.claimId,
      );
      if (own.length > 1) return refuse;
      const maxReservation = snapshot.reservations.reduce(
        (max, row) => Math.max(max, Number(row["registration_version"])),
        0,
      );
      const minimumVersion = previous
        ? previous.registrationVersion + (previous.region === region ? 1 : 2)
        : 1;
      // An exact retry keeps its reservation. A new operation must advance past every retained reservation.
      const version =
        own.length === 1
          ? Number(own[0]?.["registration_version"])
          : Math.max(minimumVersion, maxReservation + 1);
      if (
        !Number.isSafeInteger(version) ||
        version < minimumVersion ||
        (own.length === 1 && maxReservation > version)
      )
        return refuse;
      const registration: PgcfRegistration = {
        provider: "pgcf",
        databaseId,
        operationId: claim.operationId,
        organizationId: claim.organizationId,
        projectId: claim.projectId,
        physicalEnvironmentId: claim.physicalEnvironmentId,
        registrationVersion: version,
        region,
        providerProjectId,
        originHost: claim.originHost,
        originDatabase: databaseId,
        originUser: runtimeRoleOf(claim.physicalEnvironmentId),
        authorizedEnvironmentIds: [...snapshot.environments],
        status: "active",
      };
      const metadata = canonicalJson(registration);
      // Only an active same-region PGCF refresh can pass a failed, unclaimed reservation for the exact same
      // target and authority. Neon cutover, target changes and authorization changes remain independently gated.
      const recoverable =
        previous !== null &&
        isPgcf(previous) &&
        previous.status === "active" &&
        previous.region === region;
      const blocked = (row: Row) => {
        if (
          row["operation_id"] === claim.operationId &&
          row["claim_id"] === claim.claimId &&
          row["metadata"] === metadata
        )
          return false;
        return !(
          recoverable &&
          row["operation_state"] === "failed" &&
          Number(row["has_claim"]) === 0 &&
          row["metadata"] ===
            canonicalJson({
              ...registration,
              operationId: row["operation_id"],
              registrationVersion: Number(row["registration_version"]),
            })
        );
      };
      if (pending.some(blocked)) return refuse;
      const result: ReservedRegistration = { registration, completed: false, previous };
      return {
        statements: [
          organizationLiveGuard(db, claim.organizationId),
          stale(db, `NOT EXISTS (${CLAIM_SQL})`, claimParams(claim)),
          stale(
            db,
            `NOT EXISTS (SELECT 1 FROM (${ACTIVE_TARGET_SQL}) t WHERE t.provider = 'pgcf' AND t.database_id = ?4 AND t.provider_project_id = ?5 AND t.target_version = ?6)`,
            [...scopeParams(claim), databaseId, providerProjectId, targetVersion],
          ),
          stale(
            db,
            "NOT EXISTS (SELECT 1 FROM pgcf_database_migration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND database_id = ?5 AND provider_project_id = ?6)",
            [...scopeParams(claim), claim.operationId, databaseId, providerProjectId],
          ),
          stale(db, `${LATEST_VERSION} <> ?4`, [
            ...scopeParams(claim),
            existing?.registrationVersion ?? 0,
          ]),
          stale(db, `${ENVIRONMENTS_JSON} <> ?4`, [
            ...scopeParams(claim),
            JSON.stringify(snapshot.environments),
          ]),
          stale(db, `(SELECT COALESCE(max(registration_version), 0) ${RESERVATIONS_OF}) <> ?4`, [
            ...scopeParams(claim),
            maxReservation,
          ]),
          stale(
            db,
            `EXISTS (SELECT 1 FROM project_database_registration_reservations r
              WHERE r.organization_id = ?1 AND r.project_id = ?2 AND r.physical_environment_id = ?3 AND r.registration_version > ?4
                AND NOT ((r.operation_id = ?5 AND r.claim_id = ?6 AND r.metadata = ?7)
                  OR (?8 = 1 AND r.metadata = json_set(?7, '$.operationId', r.operation_id, '$.registrationVersion', r.registration_version)
                    AND EXISTS (SELECT 1 FROM operations o WHERE o.organization_id = r.organization_id AND o.project_id = r.project_id AND o.operation_id = r.operation_id AND o.state = 'failed')
                    AND NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims c WHERE c.organization_id = r.organization_id AND c.project_id = r.project_id AND c.operation_id = r.operation_id))))`,
            [
              ...scopeParams(claim),
              floor,
              claim.operationId,
              claim.claimId,
              metadata,
              recoverable ? 1 : 0,
            ],
          ),
          ...reservationInsert(db, claim, registration),
        ],
        result: () => result,
      };
    },
  };
}

/** A failed operation's pending reservation is superseded once its failure is this much older than the claim (CORE-07). */
const SUPERSEDE_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

interface SupersedeSnapshot {
  readonly claimed: boolean;
  readonly opened: string | null;
  readonly failed: readonly Row[];
}

/**
 * Deletes the pending reservations of failed operations that never registered and whose failure is at least seven days
 * older than the claim's operation. Such a reservation can no longer become a receipt, yet it blocks every later
 * registration of the database. The `delete_after_receipt` trigger admits exactly this deletion (migration 0920).
 */
function supersedeCommand(db: D1Database, claim: Claim): Command<SupersedeSnapshot, void> {
  return {
    name: "database.supersedePgcfReservations",
    input: claim,
    retryOn: ["precondition_changed"],
    async read() {
      const [claimed, opened, failed] = await readSnapshot(db, [
        [CLAIM_SQL, ...claimParams(claim)],
        [
          "SELECT created_at FROM operations WHERE organization_id = ?1 AND operation_id = ?2",
          claim.organizationId,
          claim.operationId,
        ],
        [
          `SELECT r.registration_version, r.operation_id, r.claim_id, r.metadata, o.updated_at AS failed_at
             FROM project_database_registration_reservations r
             JOIN operations o ON o.organization_id = r.organization_id AND o.operation_id = r.operation_id
            WHERE r.organization_id = ?1 AND r.project_id = ?2 AND r.physical_environment_id = ?3 AND o.state = 'failed'
              AND NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims c WHERE c.organization_id = r.organization_id AND c.operation_id = r.operation_id)`,
          ...scopeParams(claim),
        ],
      ]);
      const openedRow = opened?.[0];
      return {
        claimed: (claimed?.length ?? 0) === 1,
        opened: openedRow === undefined ? null : String(openedRow["created_at"]),
        failed: failed ?? [],
      };
    },
    decide(snapshot): Plan<void> {
      if (!snapshot.claimed || snapshot.opened === null) return { replay: undefined };
      const cutoff = addMilliseconds(snapshot.opened, -SUPERSEDE_AFTER_MILLISECONDS);
      const superseded = snapshot.failed.filter((row) => String(row["failed_at"]) <= cutoff);
      if (superseded.length === 0) return { replay: undefined };
      return {
        statements: [
          stale(db, `NOT EXISTS (${CLAIM_SQL})`, claimParams(claim)),
          ...superseded.map((row) =>
            db
              .prepare(
                "DELETE FROM project_database_registration_reservations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND claim_id = ?5 AND registration_version = ?6 AND metadata = ?7",
              )
              .bind(
                claim.organizationId,
                claim.projectId,
                claim.physicalEnvironmentId,
                row["operation_id"],
                row["claim_id"],
                row["registration_version"],
                row["metadata"],
              ),
          ),
        ],
        result: () => undefined,
      };
    },
  };
}

/**
 * Reserves the next registration of the ACTIVE PGCF target under the accepted provider claim, in one batch whose
 * guards are the claim, the active target, the registry version, the environment set and any competing reservation
 * the decision read. A historical Neon registration only supplies provenance and its owner-proven absence; it never
 * makes a Neon target active. Superseded reservations of failed operations leave first (CORE-07).
 */
export async function reservePgcfDatabaseRegistration(
  context: PlatformContext,
  input: unknown,
): Promise<ReservedRegistration> {
  const claim = reserveRegistrationInput.parse(input);
  await runOnOrganization(context, claim.organizationId, (db) => supersedeCommand(db, claim));
  return runOnOrganization(context, claim.organizationId, (db) => reserveCommand(db, claim));
}

interface PutSnapshot {
  readonly fenced: boolean;
  readonly reserved: boolean;
  readonly received: boolean;
}

function putCommand(
  db: D1Database,
  name: string,
  claim: Claim,
  registration: PgcfRegistration,
  observedAt: string,
  fenceSql: string,
  fenceParams: readonly unknown[],
  failure: () => Error,
): Command<PutSnapshot, void> {
  const values = exact(claim, registration);
  return {
    name,
    input: { claim, registration },
    retryOn: ["precondition_changed"],
    async read() {
      const [fenced, reserved, received] = await readSnapshot(db, [
        [fenceSql, ...fenceParams],
        [`SELECT 1 FROM project_database_registration_reservations WHERE ${EXACT}`, ...values],
        [`SELECT 1 FROM project_database_registration_receipts WHERE ${EXACT}`, ...values],
      ]);
      return {
        fenced: (fenced?.length ?? 0) === 1,
        reserved: (reserved?.length ?? 0) === 1,
        received: (received?.length ?? 0) === 1,
      };
    },
    decide(snapshot): Plan<void> {
      if (snapshot.received) return { replay: undefined };
      if (!snapshot.fenced || !snapshot.reserved || !matchesClaim(claim, registration))
        return { reject: failure() };
      return {
        statements: [
          organizationLiveGuard(db, claim.organizationId),
          stale(db, `NOT EXISTS (${fenceSql})`, fenceParams),
          ...receiptInsert(db, claim, registration, observedAt),
        ],
        result: () => undefined,
      };
    },
  };
}

/** Makes the reserved registration a receipt. The receipt is the exact reservation, or the batch aborts whole. */
export async function putPgcfDatabaseRegistration(
  context: PlatformContext,
  input: unknown,
): Promise<void> {
  const { claim, registration, observedAt } = putRegistrationInput.parse(input);
  return runOnOrganization(context, claim.organizationId, (db) =>
    putCommand(
      db,
      "database.putPgcfRegistration",
      claim,
      registration,
      observedAt,
      CLAIM_SQL,
      claimParams(claim),
      () => new DatabaseProviderConflictError(),
    ),
  );
}

export interface ReservedReauthorization {
  readonly registration: PgcfRegistration;
  readonly previous: PgcfRegistration;
  readonly completed: boolean;
}

interface ReauthorizeSnapshot {
  readonly fenced: boolean;
  readonly previous: AnyRegistration | null;
}

const reauthorizationClaim = (input: ReauthorizationInput): Claim => ({
  organizationId: input.organizationId,
  projectId: input.projectId,
  physicalEnvironmentId: input.physicalEnvironmentId,
  operationId: input.operationId,
  claimId: input.claimId,
});
const REAUTHORIZATION_CONFLICTS = conflictsAs(() => new ProjectDatabaseRegistrationConflictError());

function reauthorizeCommand(
  db: D1Database,
  input: ReauthorizationInput,
): Command<ReauthorizeSnapshot, ReservedReauthorization | null> {
  const claim = reauthorizationClaim(input);
  const fenceParams = reauthorizationParams(input);
  return {
    name: "database.reservePgcfReauthorization",
    input,
    retryOn: ["precondition_changed"],
    async read() {
      const [fenced, previous] = await readSnapshot(db, [
        [REAUTHORIZATION_SQL, ...fenceParams],
        [SERVED_RECEIPT, ...scopeParams(input)],
      ]);
      const row = previous?.[0];
      return {
        fenced: (fenced?.length ?? 0) === 1,
        previous: row === undefined ? null : stored(row["metadata"]),
      };
    },
    decide(snapshot): Plan<ReservedReauthorization | null> {
      if (!snapshot.fenced) return { reject: new ProjectDatabaseRegistrationConflictError() };
      const previous = snapshot.previous;
      if (previous === null || !isPgcf(previous)) return { replay: null };
      const wanted = [...input.authorizedEnvironmentIds].sort();
      // Revoking an already revoked head changes nothing, whichever operation asks for it.
      if (wanted.length === 0 && previous.status === "revoked")
        return { replay: { registration: previous, previous, completed: true } };
      if (
        previous.operationId === input.operationId &&
        wanted.length > 0 &&
        previous.status === "active" &&
        sameList(previous.authorizedEnvironmentIds, wanted)
      )
        return { replay: { registration: previous, previous, completed: true } };
      // A revoked head is re-authorized at the next version.
      const registration: PgcfRegistration = {
        ...previous,
        operationId: input.operationId,
        registrationVersion: previous.registrationVersion + 1,
        authorizedEnvironmentIds: wanted.length ? wanted : previous.authorizedEnvironmentIds,
        status: wanted.length ? "active" : "revoked",
      };
      const result: ReservedReauthorization = { registration, previous, completed: false };
      return {
        statements: [
          organizationLiveGuard(db, input.organizationId),
          stale(db, `NOT EXISTS (${REAUTHORIZATION_SQL})`, fenceParams),
          stale(db, `${LATEST_VERSION} <> ?4`, [
            ...scopeParams(input),
            previous.registrationVersion,
          ]),
          ...reservationInsert(db, claim, registration),
        ],
        result: () => result,
      };
    },
  };
}

/**
 * Reserves the next registry generation of a data-change reauthorization (or its revocation when no environment
 * stays authorized). Null: the physical environment has no PGCF registration to change.
 */
export async function reservePgcfDatabaseReauthorization(
  context: PlatformContext,
  input: unknown,
): Promise<ReservedReauthorization | null> {
  const parsed = reauthorizationInput.parse(input);
  await runOnOrganization(
    context,
    parsed.organizationId,
    (db) => supersedeCommand(db, reauthorizationClaim(parsed)),
    REAUTHORIZATION_CONFLICTS,
  );
  return runOnOrganization(
    context,
    parsed.organizationId,
    (db) => reauthorizeCommand(db, parsed),
    REAUTHORIZATION_CONFLICTS,
  );
}

/** Makes the reserved reauthorization a receipt under the same data-change fence. */
export async function putPgcfDatabaseReauthorization(
  context: PlatformContext,
  input: unknown,
): Promise<void> {
  const parsed = putReauthorizationInput.parse(input);
  return runOnOrganization(
    context,
    parsed.input.organizationId,
    (db) =>
      putCommand(
        db,
        "database.putPgcfReauthorization",
        reauthorizationClaim(parsed.input),
        parsed.registration,
        parsed.observedAt,
        REAUTHORIZATION_SQL,
        reauthorizationParams(parsed.input),
        () => new ProjectDatabaseRegistrationConflictError(),
      ),
    REAUTHORIZATION_CONFLICTS,
  );
}
