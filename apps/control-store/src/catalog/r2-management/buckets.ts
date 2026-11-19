import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError, type Command } from "../../run-command.js";
import { instant, ulid, routeOrganization, type CatalogContext } from "../common.js";
import { authorizeProductProviderMutation } from "../provisioning/provider-authorization.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "../provisioning/authority.js";

const NOW = `(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`;
const scope = z.strictObject({ organizationId: ulid, projectId: ulid, environmentId: ulid });
const mutation = scope.extend({ operationId: ulid, claimId: ulid });
const target = mutation
  .extend({
    bucketName: z.string(),
    jurisdiction: z.enum(["eu", "us"]),
    storageClass: z.literal("Standard"),
    publicAccess: z.literal(false),
  })
  .refine(
    (v) => v.bucketName === `ohmyho-${v.projectId.toLowerCase()}-${v.environmentId.toLowerCase()}`,
  );
const receipt = mutation
  .extend({
    bucketName: z.string(),
    jurisdiction: z.enum(["eu", "us"]),
    storageClass: z.literal("Standard"),
    publicAccess: z.literal(false),
    bucketId: z.string().regex(/^[0-9a-f]{32}$/u),
    observedAt: instant,
  })
  .refine(
    (v) => v.bucketName === `ohmyho-${v.projectId.toLowerCase()}-${v.environmentId.toLowerCase()}`,
  );
type Scope = z.output<typeof scope>;
type Mutation = z.output<typeof mutation>;
type Target = z.output<typeof target>;
type Row = Record<string, unknown>;
const CONFLICT = "Project R2 bucket conflicts with durable state";
const fail = () => new Error(CONFLICT);
const scopeValues = (i: Scope) => [i.organizationId, i.projectId, i.environmentId];
const mutationValues = (i: Mutation) => [...scopeValues(i), i.operationId, i.claimId];
const READ = `SELECT r.* FROM project_r2_bucket_receipts r JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.owner_state='active' WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3`;
const CLAIM = `SELECT accepted_lifecycle_version FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5`;
const CURRENT_CLAIM = `SELECT 1 FROM product_provider_mutation_claims claim
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
 JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id
 JOIN environments environment ON environment.organization_id=claim.organization_id AND environment.project_id=claim.project_id AND environment.environment_id=claim.environment_id
 WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.claim_id=?5 AND claim.accepted_lifecycle_version=?6
 AND operation.state IN('queued','running') AND project.owner_state='active' AND project.lifecycle_state='active' AND project.lifecycle_version=?6`;
const JURISDICTION = `SELECT p.region,(SELECT json_group_array(jurisdiction) FROM(SELECT jurisdiction FROM project_r2_bucket_receipts WHERE organization_id=?1 AND project_id=?2 UNION SELECT jurisdiction FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2)) AS jurisdictions FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active'`;
const JURISDICTION_STATE = `SELECT json_array(region,json(jurisdictions)) FROM (${JURISDICTION})`;
function decoded(row: Row) {
  return {
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    operationId: String(row["operation_id"]),
    claimId: String(row["claim_id"]),
    bucketName: String(row["bucket_name"]),
    bucketId: String(row["provider_bucket_id"]),
    jurisdiction: row["jurisdiction"] as "eu" | "us",
    storageClass: "Standard" as const,
    publicAccess: false as const,
    observedAt: new Date(String(row["observed_at"])),
  };
}
async function currentAuthority(context: CatalogContext, db: D1Database, i: Mutation) {
  const claim = await db
    .prepare(CLAIM)
    .bind(...mutationValues(i))
    .first<{ accepted_lifecycle_version: number }>();
  if (claim === null) throw fail();
  // This metadata is ONLY an argument to the actual qualified void check, never a permission flag.
  await authorizeProductProviderMutation(context, {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    operationId: i.operationId,
    acceptedLifecycleVersion: claim.accepted_lifecycle_version,
  });
  return { version: claim.accepted_lifecycle_version, proof: await readWorkflowDelegation(db, i) };
}
function authorityGuards(
  db: D1Database,
  i: Mutation,
  authority: Awaited<ReturnType<typeof currentAuthority>>,
) {
  return [
    ...workflowExecutionGuards(db, i, authority.proof),
    guard(db, "scope_inactive", `NOT EXISTS(${CURRENT_CLAIM})`, [
      ...mutationValues(i),
      authority.version,
    ]),
  ];
}
function sameTarget(row: Row, i: Target) {
  return (
    row["bucket_name"] === i.bucketName &&
    row["jurisdiction"] === i.jurisdiction &&
    row["storage_class"] === i.storageClass &&
    row["public_access"] === 0
  );
}
export async function readR2Bucket(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(READ)
    .bind(...scopeValues(i))
    .first<Row>();
  return row === null ? null : decoded(row);
}
/** Whole original claim transaction; durable jurisdiction precedes current compute region. */
export async function claimR2Bucket(context: CatalogContext, raw: unknown) {
  const i = target.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const read = async (reader: D1Database) => {
    const [jurisdiction, saved, reservation] = await reader.batch([
      reader.prepare(JURISDICTION).bind(i.organizationId, i.projectId),
      reader.prepare(READ).bind(...scopeValues(i)),
      reader
        .prepare(
          "SELECT * FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(...scopeValues(i)),
    ]);
    const authority = saved?.results[0] ? null : await currentAuthority(context, reader, i);
    return {
      authority,
      jurisdiction: jurisdiction?.results[0],
      saved: saved?.results[0],
      reservation: reservation?.results[0],
    };
  };
  const command: Command<Awaited<ReturnType<typeof read>>, unknown> = {
    name: "r2.claimBucket",
    input: i,
    read,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_r2_bucket_reservations"],
    decide(s) {
      if (!s.jurisdiction) return { reject: fail() };
      const locations = JSON.parse(String(s.jurisdiction["jurisdictions"])) as string[];
      if (locations.length > 1 || (locations[0] ?? s.jurisdiction["region"]) !== i.jurisdiction)
        return { reject: fail() };
      if (s.saved)
        return sameTarget(s.saved, i)
          ? { replay: { status: "completed", receipt: decoded(s.saved) } }
          : { reject: fail() };
      if (
        s.reservation &&
        (!sameTarget(s.reservation, i) || s.reservation["claim_id"] !== i.claimId)
      )
        return { reject: fail() };
      if (!s.authority) return { reject: fail() };
      const started = s.reservation?.["create_started_at"];
      return {
        statements: [
          ...authorityGuards(db, i, s.authority),
          guard(db, "precondition_changed", `NOT EXISTS(${CLAIM})`, mutationValues(i)),
          guard(db, "precondition_changed", `(${JURISDICTION_STATE}) IS NOT ?3`, [
            i.organizationId,
            i.projectId,
            JSON.stringify([s.jurisdiction["region"], locations]),
          ]),
          db
            .prepare(
              `INSERT INTO project_r2_bucket_reservations(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,jurisdiction,storage_class,public_access) SELECT ?1,?2,?3,?4,?5,?6,?7,'Standard',0 WHERE EXISTS(${CLAIM}) ON CONFLICT DO NOTHING`,
            )
            .bind(...mutationValues(i), i.bucketName, i.jurisdiction),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?5 AND bucket_name=?6 AND jurisdiction=?7 AND storage_class='Standard' AND public_access=0 AND create_started_at IS ?8)",
            [...mutationValues(i), i.bucketName, i.jurisdiction, started ?? null],
          ),
        ],
        result: () => ({ status: "claimed", mode: started == null ? "create" : "observe" }),
      };
    },
    lookup: async () => {
      throw new StoreOutcomeUnknownError("R2 bucket claim outcome unknown");
    },
  };
  return runCommand(db, command);
}
/** One delivery permission. Never reconstruct true or re-decide after a lost mutation reply. */
export async function authorizeR2Bucket(context: CatalogContext, raw: unknown) {
  const i = mutation.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const authority = await currentAuthority(context, db, i);
  try {
    const results = await db.batch([
      ...authorityGuards(db, i, authority),
      db
        .prepare(
          `UPDATE project_r2_bucket_reservations SET create_started_at=${NOW} WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND create_started_at IS NULL AND EXISTS(${CLAIM}) RETURNING 1`,
        )
        .bind(...mutationValues(i)),
    ]);
    return (results.at(-1)?.results.length ?? 0) === 1;
  } catch (error) {
    throw new StoreOutcomeUnknownError(
      `R2 create authorization outcome unavailable: ${error instanceof Error ? error.name : "Error"}`,
    );
  }
}
const absence = mutation.extend({ bucketName: z.string(), observedAt: instant });
const RESERVATION_OF_CLAIM = `SELECT * FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?4`;
const EVIDENCE_OF_CLAIM = `SELECT observed_at FROM project_r2_bucket_absences WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?4 AND bucket_name=?5`;
const RECEIPT_OF_CLAIM = `SELECT 1 FROM project_r2_bucket_receipts WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?4`;
/**
 * Durable evidence that the provider read found the reserved bucket absent. An unused reservation may be evidenced at any
 * time; a reservation whose create authorization was spent only by an absence observed after that spend, because a create
 * made before it may still have produced the bucket. Evidence observed before the spend is refused, so the reservation stays.
 */
export async function proveR2BucketAbsence(context: CatalogContext, raw: unknown) {
  const i = absence.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const command: Command<Row | null, "proven"> = {
    name: "r2.proveBucketAbsence",
    input: i,
    read: (reader) =>
      reader
        .prepare(RESERVATION_OF_CLAIM)
        .bind(...scopeValues(i), i.claimId)
        .first<Row>(),
    naturalKeyTables: ["project_r2_bucket_absences"],
    decide(saved) {
      const started = saved?.["create_started_at"];
      if (
        !saved ||
        saved["bucket_name"] !== i.bucketName ||
        saved["operation_id"] !== i.operationId ||
        (typeof started === "string" && i.observedAt < started)
      )
        return { reject: fail() };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${RESERVATION_OF_CLAIM} AND bucket_name=?5 AND create_started_at IS ?6)`,
            [...scopeValues(i), i.claimId, i.bucketName, started ?? null],
          ),
          db
            .prepare(
              "INSERT INTO project_r2_bucket_absences(organization_id,project_id,environment_id,claim_id,bucket_name,observed_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
            )
            .bind(...scopeValues(i), i.claimId, i.bucketName, i.observedAt),
        ],
        result: () => "proven",
      };
    },
    lookup: async () => {
      throw new StoreOutcomeUnknownError("R2 bucket absence outcome unknown");
    },
  };
  return runCommand(db, command);
}
/**
 * Releases the reservation of a claim whose bucket is proven absent, so a later operation of the target can reserve it again.
 * The reservation leaves with its claim row in the same batch. While the claim's operation has not ended (succeeded or failed),
 * nothing is written and the answer is `operation_open`: the claim row cannot leave before its operation ends.
 */
export async function supersedeR2BucketReservation(context: CatalogContext, raw: unknown) {
  const i = absence.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const command: Command<
    { reservation: Row | null; evidence: Row | null; operation: Row | null; receipt: Row | null },
    "superseded" | "operation_open"
  > = {
    name: "r2.supersedeReservation",
    input: i,
    read: async (reader) => {
      const [reservation, evidence, operation, receipt] = await reader.batch([
        reader.prepare(RESERVATION_OF_CLAIM).bind(...scopeValues(i), i.claimId),
        reader.prepare(EVIDENCE_OF_CLAIM).bind(...scopeValues(i), i.claimId, i.bucketName),
        reader
          .prepare(
            "SELECT state FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        reader.prepare(RECEIPT_OF_CLAIM).bind(...scopeValues(i), i.claimId),
      ]);
      return {
        reservation: (reservation?.results[0] as Row | undefined) ?? null,
        evidence: (evidence?.results[0] as Row | undefined) ?? null,
        operation: (operation?.results[0] as Row | undefined) ?? null,
        receipt: (receipt?.results[0] as Row | undefined) ?? null,
      };
    },
    naturalKeyTables: ["project_r2_bucket_reservations"],
    decide(s) {
      // A lost reply may hide a supersede that committed: the reservation and its claim are gone, the absence evidence stays,
      // and no receipt was made for the claim. The retry answers the committed outcome.
      if (!s.reservation && s.evidence && !s.receipt) return { replay: "superseded" as const };
      const started = s.reservation?.["create_started_at"];
      if (
        !s.reservation ||
        !s.evidence ||
        s.reservation["bucket_name"] !== i.bucketName ||
        s.reservation["operation_id"] !== i.operationId ||
        (typeof started === "string" && String(s.evidence["observed_at"]) < started)
      )
        return { reject: fail() };
      if (s.operation?.["state"] !== "succeeded" && s.operation?.["state"] !== "failed")
        return { replay: "operation_open" as const };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${RESERVATION_OF_CLAIM} AND bucket_name=?5 AND create_started_at IS ?6)`,
            [...scopeValues(i), i.claimId, i.bucketName, started ?? null],
          ),
          db
            .prepare(
              "DELETE FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?4",
            )
            .bind(...scopeValues(i), i.claimId),
          db
            .prepare(
              "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?4 AND operation_id=?5",
            )
            .bind(...scopeValues(i), i.claimId, i.operationId),
        ],
        result: () => "superseded" as const,
      };
    },
    lookup: async () => {
      throw new StoreOutcomeUnknownError("R2 reservation supersede outcome unknown");
    },
  };
  return runCommand(db, command);
}
/** Provider evidence can reconcile its exact started reservation without granting another provider call. */
export async function putR2Bucket(context: CatalogContext, raw: unknown) {
  const i = receipt.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const command: Command<Row | null, "created" | "existing"> = {
    name: "r2.putBucket",
    input: i,
    read: (reader) =>
      reader
        .prepare(READ)
        .bind(...scopeValues(i))
        .first<Row>(),
    naturalKeyTables: ["project_r2_bucket_receipts"],
    decide(saved) {
      if (
        saved &&
        (saved["claim_id"] !== i.claimId ||
          saved["operation_id"] !== i.operationId ||
          saved["bucket_name"] !== i.bucketName ||
          saved["provider_bucket_id"] !== i.bucketId ||
          saved["jurisdiction"] !== i.jurisdiction ||
          new Date(String(saved["observed_at"])).getTime() !== Date.parse(i.observedAt))
      )
        return { reject: fail() };
      return {
        statements: [
          db
            .prepare(
              `INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at) SELECT organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,?6,jurisdiction,storage_class,public_access,?7,${NOW} FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND create_started_at IS NOT NULL ON CONFLICT DO NOTHING RETURNING 1`,
            )
            .bind(...mutationValues(i), i.bucketId, i.observedAt),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${READ} AND r.operation_id=?4 AND r.claim_id=?5 AND r.provider_bucket_id=?6 AND r.observed_at=?7 AND r.bucket_name=?8 AND r.jurisdiction=?9)`,
            [...mutationValues(i), i.bucketId, i.observedAt, i.bucketName, i.jurisdiction],
          ),
          db
            .prepare(
              "DELETE FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND claim_id=?4",
            )
            .bind(...scopeValues(i), i.claimId),
        ],
        result: (results) => (results[0]?.results.length === 1 ? "created" : "existing"),
      };
    },
    lookup: async () => {
      throw new StoreOutcomeUnknownError(
        "R2 receipt outcome unknown; retry the same immutable receipt",
      );
    },
  };
  return runCommand(db, command);
}
