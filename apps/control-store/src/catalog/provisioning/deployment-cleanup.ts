import { generatedJsonb } from "../../jsonb-generated.js";
import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
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
import { LATEST, ROUTE_ROW, ROUTE_FROM } from "../gateway/facts.js";
import { type Route, revisionOf } from "../gateway/mutations.js";
import { resourceHash } from "./context-values.js";
import { ProductWorkflowContextConflictError } from "./context.js";
const stamp = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
  bytes = z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
  scope = { organizationId: ulid, projectId: ulid };
const candidateInput = z.preprocess(
  (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "bindingSetDigest" in value &&
      !Object.hasOwn(value, "bindingSetDigest")
    )
      throw new TypeError("WFP candidate binding digest must be an own property");
    return value;
  },
  z
    .strictObject({
      ...scope,
      candidateReceiptId: ulid,
      environmentId: ulid,
      operationId: ulid,
      productDeploymentId: ulid,
      artifactId: ulid,
      namespace: z.string().min(1),
      immutableScriptName: z.string().regex(/^p-[0-9a-z]{26}-(?:dev|prod)-[0-9a-z]{26}$/u),
      artifactDigest: bytes,
      bindingSetDigest: bytes.optional(),
      providerTag: z.string().min(1),
      buildReused: z.boolean(),
      stagedAt: stamp,
    })
    .refine(
      (value) => !Object.hasOwn(value, "bindingSetDigest") || value.bindingSetDigest !== undefined,
    ),
);
const claimInput = z
  .strictObject({
    ...scope,
    candidateReceiptId: ulid.optional(),
    claimId: ulid,
    claimedAt: stamp,
    leaseExpiresAt: stamp,
  })
  .refine((i) => i.leaseExpiresAt > i.claimedAt);
const prepareInput = z
  .strictObject({
    cleanupRequestId: ulid,
    candidate: candidateInput,
    reason: z.enum(["superseded", "failed", "compensate"]),
    supersededById: ulid.optional(),
    requestedAt: stamp,
    claimId: ulid,
    leaseExpiresAt: stamp,
  })
  .refine(
    (i) =>
      (i.reason === "superseded") === (i.supersededById !== undefined) &&
      i.leaseExpiresAt > i.requestedAt,
  );
const gatewayInput = z.strictObject({
  compensatedTargetScriptName: z
    .string()
    .regex(/^p-[0-9a-z]{26}-(?:dev|prod)-[0-9a-z]{26}$/u)
    .nullable(),
  sharedGatewayRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
});
const receiptInput = z.strictObject({
  ...scope,
  cleanupReceiptId: ulid,
  candidateReceiptId: ulid,
  claimId: ulid,
  outcome: z.enum(["removed", "not_found"]),
  observedProviderTag: z
    .string()
    .min(1)
    .refine((v) => v.trim() === v),
  observedAt: stamp,
});
const resourceInput = z.strictObject({
  ...scope,
  operationCleanupReceiptId: ulid,
  candidateReceiptId: ulid,
  operationId: ulid,
  provider: z.literal("cloudflare"),
  resourceKind: z.enum(["source-archive", "build-artifact"]),
  resourceIdentityDigest: bytes,
  outcome: z.enum(["removed", "not_found"]),
  observedAt: stamp,
});
const recordInput = z.strictObject({
  receipt: receiptInput,
  gateway: gatewayInput.nullable(),
  resources: z.array(resourceInput),
});
const supersedeInput = z.strictObject({
  ...scope,
  operationId: ulid,
  candidateReceiptId: ulid,
  cleanupReceiptId: ulid,
  supersededById: ulid,
  terminalAt: stamp,
});
type Row = Record<string, unknown>;
const fail = (m: string) => new ProductWorkflowContextConflictError(m),
  hex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
const binary = (v: unknown) => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v))
    throw fail("Candidate digest is invalid");
  return Uint8Array.from(
    Array.from({ length: 32 }, (_, n) => parseInt(v.slice(n * 2, n * 2 + 2), 16)),
  );
};
function candidate(row: Row) {
  return {
    candidateReceiptId: parseUlid(String(row["candidate_receipt_id"])),
    organizationId: parseUlid(String(row["organization_id"])),
    projectId: parseUlid(String(row["project_id"])),
    environmentId: parseUlid(String(row["environment_id"])),
    operationId: parseUlid(String(row["operation_id"])),
    productDeploymentId: parseUlid(String(row["product_deployment_id"])),
    artifactId: parseUlid(String(row["artifact_id"])),
    namespace: String(row["dispatch_namespace"]),
    immutableScriptName: String(row["immutable_script_name"]),
    artifactDigest: binary(row["artifact_hex"]),
    ...(row["binding_hex"] == null ? {} : { bindingSetDigest: binary(row["binding_hex"]) }),
    providerTag: String(row["provider_tag"]),
    buildReused: row["build_reused"] === 1,
    stagedAt: publicTimestamp(String(row["staged_at"])),
  };
}
type Resource = {
  provider: "cloudflare";
  resourceKind: "source-archive" | "build-artifact";
  resourceIdentityDigest: Uint8Array;
};
function claimDto(c: Row, q: Row, resources: Resource[]) {
  return {
    candidateReceiptId: parseUlid(String(c["candidate_receipt_id"])),
    claimId: parseUlid(String(q["claim_id"])),
    attemptNumber: Number(q["attempt_number"]),
    claimedAt: publicTimestamp(String(q["claimed_at"])),
    leaseExpiresAt: publicTimestamp(String(q["lease_expires_at"])),
    candidate: candidate(c),
    expectedResources: resources,
  };
}
const CANDIDATE = `SELECT candidate.*,lower(hex(candidate.artifact_sha256)) artifact_hex,CASE WHEN candidate.binding_set_digest IS NULL THEN NULL ELSE lower(hex(candidate.binding_set_digest)) END binding_hex FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.candidate_receipt_id=?3`;
const PENDING = `SELECT candidate.*,lower(hex(candidate.artifact_sha256)) artifact_hex,CASE WHEN candidate.binding_set_digest IS NULL THEN NULL ELSE lower(hex(candidate.binding_set_digest)) END binding_hex FROM wfp_candidate_receipts candidate JOIN wfp_candidate_cleanup_requests request ON request.organization_id=candidate.organization_id AND request.project_id=candidate.project_id AND request.candidate_receipt_id=candidate.candidate_receipt_id WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND(?3 IS NULL OR candidate.candidate_receipt_id=?3) AND NOT EXISTS(SELECT 1 FROM wfp_publish_receipts published WHERE published.candidate_receipt_id=candidate.candidate_receipt_id) AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id) ORDER BY candidate.staged_at,candidate.candidate_receipt_id LIMIT 1`;
const EXPECTED = `SELECT provider,resource_kind,lower(hex(resource_identity_sha256)) digest FROM wfp_candidate_cleanup_resource_expectations WHERE candidate_receipt_id=?1 ORDER BY resource_kind,resource_identity_sha256`;
const claimStatements = (db: D1Database, i: z.output<typeof claimInput>, id: unknown) => [
  db
    .prepare(
      "INSERT INTO wfp_candidate_cleanup_claims(candidate_receipt_id,organization_id,project_id,claim_id,attempt_number,claimed_at,lease_expires_at) VALUES(?1,?2,?3,?4,1,?5,?6) ON CONFLICT(candidate_receipt_id) DO UPDATE SET claim_id=?4,attempt_number=CASE WHEN wfp_candidate_cleanup_claims.claim_id=?4 AND wfp_candidate_cleanup_claims.lease_expires_at>?5 THEN wfp_candidate_cleanup_claims.attempt_number ELSE wfp_candidate_cleanup_claims.attempt_number+1 END,claimed_at=CASE WHEN wfp_candidate_cleanup_claims.claim_id=?4 AND wfp_candidate_cleanup_claims.lease_expires_at>?5 THEN wfp_candidate_cleanup_claims.claimed_at ELSE ?5 END,lease_expires_at=CASE WHEN wfp_candidate_cleanup_claims.claim_id=?4 AND wfp_candidate_cleanup_claims.lease_expires_at>?5 THEN wfp_candidate_cleanup_claims.lease_expires_at ELSE ?6 END WHERE wfp_candidate_cleanup_claims.claim_id=?4 OR wfp_candidate_cleanup_claims.lease_expires_at<=?5 RETURNING *",
    )
    .bind(id, i.organizationId, i.projectId, i.claimId, i.claimedAt, i.leaseExpiresAt),
  guard(
    db,
    "precondition_changed",
    "NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?1 AND organization_id=?2 AND project_id=?3 AND claim_id=?4)",
    [id, i.organizationId, i.projectId, i.claimId],
  ),
];
const resourceDtos = (rows: Row[]): Resource[] =>
  rows.map((r) => ({
    provider: "cloudflare",
    resourceKind: r["resource_kind"] as Resource["resourceKind"],
    resourceIdentityDigest: binary(r["digest"]),
  }));
/** Same exact first eligible candidate and lease generation; a live other claimant returns no work. */
export async function claimProductCandidateCleanup(context: CatalogContext, raw: unknown) {
  const i = claimInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    args = [i.organizationId, i.projectId, i.candidateReceiptId ?? null];
  const read = async (reader: D1Database) => {
    const c = await reader
      .prepare(PENDING)
      .bind(...args)
      .first<Row>();
    if (!c) return { c: null, q: null, resources: [] as Resource[] };
    const result = await reader.batch([
      reader
        .prepare("SELECT * FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?1")
        .bind(c["candidate_receipt_id"]),
      reader.prepare(EXPECTED).bind(c["candidate_receipt_id"]),
    ]);
    return {
      c,
      q: result[0]?.results[0] ?? null,
      resources: resourceDtos(result[1]?.results ?? []),
    };
  };
  const command: Command<Awaited<ReturnType<typeof read>>, ReturnType<typeof claimDto> | null> = {
    name: "provisioning.claimCandidateCleanup",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["wfp_candidate_cleanup_claims"],
    read,
    decide: (s) => {
      if (!s.c) return { replay: null };
      if (s.q && s.q["claim_id"] !== i.claimId && String(s.q["lease_expires_at"]) > i.claimedAt)
        return { replay: null };
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", i.organizationId),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${PENDING}) WHERE candidate_receipt_id=?4)`,
            [...args, s.c["candidate_receipt_id"]],
          ),
          ...claimStatements(db, i, s.c["candidate_receipt_id"]),
        ],
        result: (r) => {
          const q = r[2]?.results[0];
          if (!q) throw fail("Candidate cleanup claim is unavailable");
          if (s.c === null) throw fail("Candidate cleanup source is unavailable");
          return claimDto(s.c, q, s.resources);
        },
      };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      return s.c && s.q?.["claim_id"] === i.claimId ? claimDto(s.c, s.q, s.resources) : undefined;
    },
  };
  return runCommand(db, command);
}
/** Request, captured resource expectations, optional push transition and first claim commit together. */
export async function prepareProductCandidateCleanup(context: CatalogContext, raw: unknown) {
  const i = prepareInput.parse(raw),
    c = i.candidate,
    { db } = await routeOrganization(context, c.organizationId),
    q = claimInput.parse({
      organizationId: c.organizationId,
      projectId: c.projectId,
      candidateReceiptId: c.candidateReceiptId,
      claimId: i.claimId,
      claimedAt: publicTimestamp(i.requestedAt),
      leaseExpiresAt: publicTimestamp(i.leaseExpiresAt),
    });
  const resourceSql =
    "SELECT 'cloudflare' provider,'source-archive' resource_kind,bucket_name||'/'||object_key||'/'||object_version_id locator FROM product_source_archive_objects WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 UNION ALL SELECT 'cloudflare','build-artifact',artifact.object_version_ref FROM build_executions build JOIN build_artifacts artifact ON artifact.organization_id=build.organization_id AND artifact.project_id=build.project_id AND artifact.build_execution_id=build.build_execution_id WHERE build.organization_id=?1 AND build.project_id=?2 AND build.operation_id=?3 ORDER BY resource_kind,locator";
  const read = async (reader: D1Database) => {
    const rows = await reader.batch([
      reader.prepare(CANDIDATE).bind(c.organizationId, c.projectId, c.candidateReceiptId),
      reader
        .prepare("SELECT * FROM wfp_candidate_cleanup_requests WHERE candidate_receipt_id=?1")
        .bind(c.candidateReceiptId),
      reader
        .prepare("SELECT * FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?1")
        .bind(c.candidateReceiptId),
      reader.prepare(resourceSql).bind(c.organizationId, c.projectId, c.operationId),
      reader.prepare(EXPECTED).bind(c.candidateReceiptId),
    ]);
    const resources = [] as Resource[];
    for (const row of rows[3]?.results ?? [])
      resources.push({
        provider: "cloudflare",
        resourceKind: row["resource_kind"] as Resource["resourceKind"],
        resourceIdentityDigest: binary(
          await resourceHash("cloudflare", String(row["resource_kind"]), String(row["locator"])),
        ),
      });
    resources.sort(
      (a, b) =>
        a.resourceKind.localeCompare(b.resourceKind) ||
        hex(a.resourceIdentityDigest).localeCompare(hex(b.resourceIdentityDigest)),
    );
    return {
      row: rows[0]?.results[0] ?? null,
      request: rows[1]?.results[0] ?? null,
      claim: rows[2]?.results[0] ?? null,
      resources: rows[1]?.results.length ? resourceDtos(rows[4]?.results ?? []) : resources,
    };
  };
  const exact = `SELECT 1 FROM wfp_candidate_receipts WHERE candidate_receipt_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4 AND operation_id=?5 AND product_deployment_id=?6 AND artifact_id=?7 AND dispatch_namespace=?8 AND immutable_script_name=?9 AND lower(hex(artifact_sha256))=?10 AND provider_tag=?11 AND build_reused=?12 AND staged_at=?13 AND binding_set_digest IS unhex(?14) AND NOT EXISTS(SELECT 1 FROM wfp_publish_receipts WHERE candidate_receipt_id=?1) AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=?1)`;
  const args = [
    c.candidateReceiptId,
    c.organizationId,
    c.projectId,
    c.environmentId,
    c.operationId,
    c.productDeploymentId,
    c.artifactId,
    c.namespace,
    c.immutableScriptName,
    hex(c.artifactDigest),
    c.providerTag,
    c.buildReused ? 1 : 0,
    c.stagedAt,
    c.bindingSetDigest === undefined ? null : hex(c.bindingSetDigest),
  ];
  const command: Command<Awaited<ReturnType<typeof read>>, ReturnType<typeof claimDto>> = {
    name: "provisioning.prepareCandidateCleanup",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["wfp_candidate_cleanup_requests", "wfp_candidate_cleanup_claims"],
    read,
    decide: (s) => {
      if (!s.row) return { reject: fail("WFP candidate cleanup scope changed") };
      if (
        s.request &&
        (s.request["cleanup_request_id"] !== i.cleanupRequestId ||
          s.request["organization_id"] !== c.organizationId ||
          s.request["project_id"] !== c.projectId ||
          s.request["operation_id"] !== c.operationId ||
          s.request["reason"] !== i.reason ||
          s.request["requested_at"] !== i.requestedAt)
      )
        return { reject: fail("WFP candidate cleanup request changed") };
      if (
        s.claim &&
        s.claim["claim_id"] !== i.claimId &&
        String(s.claim["lease_expires_at"]) > i.requestedAt
      )
        return { reject: fail("WFP candidate cleanup claim is unavailable") };
      const statements: D1PreparedStatement[] = [
        fenceRaceGuard(db, "operation_conflict", c.organizationId),
        guard(db, "operation_conflict", `NOT EXISTS(${exact})`, args),
      ];
      if (!s.request) {
        statements.push(
          db
            .prepare(
              "INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at) VALUES(?,?,?,?,?,?,?)",
            )
            .bind(
              i.cleanupRequestId,
              c.candidateReceiptId,
              c.organizationId,
              c.projectId,
              c.operationId,
              i.reason,
              i.requestedAt,
            ),
        );
        for (const resource of s.resources)
          statements.push(
            db
              .prepare(
                "INSERT INTO wfp_candidate_cleanup_resource_expectations(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256) VALUES(?,?,?,?,?,?,?,unhex(?))",
              )
              .bind(
                i.cleanupRequestId,
                c.candidateReceiptId,
                c.organizationId,
                c.projectId,
                c.operationId,
                "cloudflare",
                resource.resourceKind,
                hex(resource.resourceIdentityDigest),
              ),
          );
      }
      // Only a superseded push waits in cleanup_pending: its CHECK requires the superseding push. A failed or
      // compensated candidate leaves the push as it is, so neither statement runs for those reasons.
      if (i.reason === "superseded")
        statements.push(
          db
            .prepare(
              "UPDATE github_push_deployments SET state='cleanup_pending',superseded_by_id=?4,cleanup_required=1,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running') AND cleanup_required=0",
            )
            .bind(
              c.organizationId,
              c.projectId,
              c.operationId,
              i.supersededById ?? null,
              i.requestedAt,
            ),
          guard(
            db,
            "operation_conflict",
            "EXISTS(SELECT 1 FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND(cleanup_required<>1 OR state<>'cleanup_pending'))",
            [c.organizationId, c.projectId, c.operationId],
          ),
        );
      const at = statements.length;
      statements.push(...claimStatements(db, q, c.candidateReceiptId));
      return {
        statements,
        result: (r) => {
          const claimed = r[at]?.results[0];
          if (!claimed) throw fail("WFP candidate cleanup claim is unavailable");
          if (s.row === null) throw fail("Candidate cleanup source is unavailable");
          return claimDto(s.row, claimed, s.resources);
        },
      };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      if (
        !s.request ||
        !s.row ||
        s.claim?.["claim_id"] !== i.claimId ||
        s.request["cleanup_request_id"] !== i.cleanupRequestId ||
        s.request["organization_id"] !== c.organizationId ||
        s.request["project_id"] !== c.projectId ||
        s.request["operation_id"] !== c.operationId ||
        s.request["reason"] !== i.reason ||
        s.request["requested_at"] !== i.requestedAt
      )
        return undefined;
      return (await reader
        .prepare(exact)
        .bind(...args)
        .first()) === null
        ? undefined
        : claimDto(s.row, s.claim, s.resources);
    },
  };
  return runCommand(db, command);
}
const CLEANED = `SELECT 1 FROM wfp_candidate_receipts candidate JOIN wfp_candidate_cleanup_requests request ON request.organization_id=candidate.organization_id AND request.project_id=candidate.project_id AND request.candidate_receipt_id=candidate.candidate_receipt_id JOIN wfp_candidate_cleanup_receipts cleanup ON cleanup.organization_id=candidate.organization_id AND cleanup.project_id=candidate.project_id AND cleanup.candidate_receipt_id=candidate.candidate_receipt_id WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.operation_id=?3 AND candidate.candidate_receipt_id=?4 AND cleanup.cleanup_receipt_id=?5 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected WHERE expected.candidate_receipt_id=candidate.candidate_receipt_id AND NOT EXISTS(SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual WHERE actual.cleanup_request_id=expected.cleanup_request_id AND actual.provider=expected.provider AND actual.resource_kind=expected.resource_kind AND actual.resource_identity_sha256=expected.resource_identity_sha256)) AND NOT EXISTS(SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual WHERE actual.candidate_receipt_id=candidate.candidate_receipt_id AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected WHERE expected.cleanup_request_id=actual.cleanup_request_id AND expected.provider=actual.provider AND expected.resource_kind=actual.resource_kind AND expected.resource_identity_sha256=actual.resource_identity_sha256))`;
/**
 * The conditions under which the claim of the cancelled operation (?1 organization, ?2 project, ?3 operation) must stay.
 * They are the closure that the delete guard of `product_provider_mutation_claims` (core migration 0634) re-checks as its own
 * condition: the Workflow run is not completed or still has a reconciliation attempt, a deployment is not
 * closed, a reconciliation attempt stayed unknown, or a placement or bucket reservation or a Native database create that
 * was not resolved still belongs to the operation.
 */
const CLAIM_STAYS = [
  "EXISTS(SELECT 1 FROM product_workflow_runs run WHERE run.organization_id=?1 AND run.project_id=?2 AND run.operation_id=?3 AND (run.state<>'completed' OR run.active_reconciliation_attempt_id IS NOT NULL))",
  "EXISTS(SELECT 1 FROM deployments deployment WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND deployment.operation_id=?3 AND deployment.status NOT IN('succeeded','failed'))",
  "EXISTS(SELECT 1 FROM product_provider_reconciliation_attempts attempt WHERE attempt.organization_id=?1 AND attempt.project_id=?2 AND attempt.operation_id=?3 AND attempt.outcome='unknown')",
  "EXISTS(SELECT 1 FROM neon_project_placement_reservations placement WHERE placement.organization_id=?1 AND placement.project_id=?2 AND placement.operation_id=?3)",
  "EXISTS(SELECT 1 FROM project_r2_bucket_reservations bucket WHERE bucket.organization_id=?1 AND bucket.project_id=?2 AND bucket.operation_id=?3)",
  "EXISTS(SELECT 1 FROM native_auth_database_operations native_create WHERE native_create.organization_id=?1 AND native_create.project_id=?2 AND native_create.operation_id=?3 AND native_create.state IN('reserved','dispatched'))",
].join(" OR ");
/**
 * Ends a superseded push: the operation is cancelled and its Workflow run, deployment and provider mutation claim are
 * closed and released in the same batch.
 *
 * Why releasing the claim cannot hide an unknown provider outcome: the Workflow reaches this command only through
 * `compensateSupersededCandidate`, after the candidate was staged (`authorize-candidate-activation`) or even activated
 * (`authorize-candidate-finalization`), so the operation HAS mutated the provider. It then removes or compensates the
 * candidate and its operation artifacts and records their observed absence (`recordProductCandidateCleanup`), and an
 * uncertain removal returns to `reconcile` without ever calling this command. The `CLEANED` guard below is the same
 * evidence in this batch: the candidate's cleanup receipt and a receipt for every expected provider resource. No
 * provider call of the operation is in flight when the claim is released, and the guard of the claim re-checks that
 * evidence itself.
 *
 * Rollout: apply core migration 0634 BEFORE the Worker that contains this batch, because the earlier delete guard refuses
 * the claim of a cancelled operation. A Worker without the release that cancels during the overlap strands one claim, and
 * running the statements of the migration again releases it.
 */
export async function markProductCandidateSuperseded(context: CatalogContext, raw: unknown) {
  const i = supersedeInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    args = [i.organizationId, i.projectId, i.operationId, i.candidateReceiptId, i.cleanupReceiptId];
  const read = async (reader: D1Database) => {
    const rows = await reader.batch([
      reader.prepare(CLEANED).bind(...args),
      reader
        .prepare(
          "SELECT * FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
        )
        .bind(i.organizationId, i.projectId, i.operationId),
      reader
        .prepare(
          "SELECT state FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
        )
        .bind(i.organizationId, i.projectId, i.operationId),
    ]);
    return {
      cleaned: (rows[0]?.results.length ?? 0) > 0,
      push: rows[1]?.results[0] ?? null,
      state: rows[2]?.results[0]?.["state"],
    };
  };
  const existing = (s: Awaited<ReturnType<typeof read>>) =>
    s.push?.["state"] === "superseded" &&
    s.push["superseded_by_id"] === i.supersededById &&
    s.push["cleanup_required"] === 0 &&
    s.state === "cancelled";
  const command: Command<
    Awaited<ReturnType<typeof read>>,
    "superseded" | "existing" | "not_linked"
  > = {
    name: "provisioning.markCandidateSuperseded",
    input: i,
    retryOn: ["precondition_changed"],
    read,
    decide: (s) => {
      if (!s.cleaned) return { reject: fail("WFP candidate cleanup evidence is unavailable") };
      if (!s.push) return { replay: "not_linked" };
      if (existing(s)) return { replay: "existing" };
      if (
        s.push["state"] !== "cleanup_pending" ||
        s.push["superseded_by_id"] !== i.supersededById ||
        s.push["cleanup_required"] !== 1
      )
        return { reject: fail("WFP candidate terminal push state changed") };
      return {
        statements: [
          guard(db, "precondition_changed", `NOT EXISTS(${CLEANED})`, args),
          db
            .prepare(
              "UPDATE github_push_deployments SET state='superseded',superseded_by_id=?4,cleanup_required=0,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='cleanup_pending' AND superseded_by_id=?4 AND cleanup_required=1",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.supersededById, i.terminalAt),
          guard(db, "precondition_changed", "changes()<>1"),
          db
            .prepare(
              "UPDATE operations SET state='cancelled',updated_at=?4,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.terminalAt),
          guard(db, "operation_conflict", "changes()<>1"),
          // The cancelled operation ends the way a failed one does: its Workflow run and deployment close and its provider
          // mutation claim is released, or the project stays blocked for every later push, rename, data change and deletion.
          // A run with an active reconciliation attempt, or a deployment awaiting reconciliation, is left open and refused below.
          db
            .prepare(
              "UPDATE product_workflow_runs SET state='completed',terminal_evidence=?5,active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,updated_at=?4,completed_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='queued' AND active_reconciliation_attempt_id IS NULL",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.operationId,
              i.terminalAt,
              JSON.stringify({ errorCode: "SUPERSEDED", supersededById: i.supersededById }),
            ),
          db
            .prepare(
              "UPDATE deployments SET status='failed',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND status IN('queued','running')",
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.terminalAt),
          guard(db, "operation_conflict", CLAIM_STAYS, [
            i.organizationId,
            i.projectId,
            i.operationId,
          ]),
          db
            .prepare(
              "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
            )
            .bind(i.organizationId, i.projectId, i.operationId),
        ],
        result: () => "superseded",
      };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      return s.cleaned && existing(s) ? "existing" : undefined;
    },
  };
  return runCommand(db, command);
}
/** Observed absence, any required route settlement, resource receipts and lease release are ONE effect. */
export async function recordProductCandidateCleanup(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = recordInput.parse(raw),
    r = i.receipt,
    { db } = await routeOrganization(context, r.organizationId),
    args = [r.organizationId, r.projectId, r.candidateReceiptId];
  if (
    i.resources.some(
      (v) =>
        v.organizationId !== r.organizationId ||
        v.projectId !== r.projectId ||
        v.candidateReceiptId !== r.candidateReceiptId,
    )
  )
    throw fail("Candidate operation cleanup scope changed");
  const resourceExact = (v: z.output<typeof resourceInput>) => ({
    sql: "SELECT 1 FROM wfp_candidate_operation_cleanup_receipts WHERE operation_cleanup_receipt_id=?1 AND candidate_receipt_id=?2 AND organization_id=?3 AND project_id=?4 AND operation_id=?5 AND provider=?6 AND resource_kind=?7 AND lower(hex(resource_identity_sha256))=?8 AND outcome=?9 AND observed_at=?10",
    values: [
      v.operationCleanupReceiptId,
      v.candidateReceiptId,
      v.organizationId,
      v.projectId,
      v.operationId,
      v.provider,
      v.resourceKind,
      hex(v.resourceIdentityDigest),
      v.outcome,
      v.observedAt,
    ],
  });
  const read = async (reader: D1Database) => {
    const rows = await reader.batch([
        reader.prepare(CANDIDATE).bind(...args),
        reader
          .prepare(
            "SELECT * FROM wfp_candidate_cleanup_receipts WHERE organization_id=?1 AND project_id=?2 AND candidate_receipt_id=?3",
          )
          .bind(...args),
        reader
          .prepare(
            "SELECT * FROM wfp_candidate_cleanup_claims WHERE organization_id=?1 AND project_id=?2 AND candidate_receipt_id=?3",
          )
          .bind(...args),
        reader
          .prepare(
            "SELECT 1 FROM wfp_candidate_receipts candidate JOIN wfp_candidate_cleanup_requests request ON request.organization_id=candidate.organization_id AND request.project_id=candidate.project_id AND request.candidate_receipt_id=candidate.candidate_receipt_id JOIN wfp_candidate_cleanup_claims claim ON claim.organization_id=candidate.organization_id AND claim.project_id=candidate.project_id AND claim.candidate_receipt_id=candidate.candidate_receipt_id JOIN projects project ON project.organization_id=candidate.organization_id AND project.project_id=candidate.project_id AND project.owner_state='active' AND project.lifecycle_state='active' JOIN environments environment ON environment.organization_id=candidate.organization_id AND environment.project_id=candidate.project_id AND environment.environment_id=candidate.environment_id WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.candidate_receipt_id=?3 AND claim.claim_id=?4",
          )
          .bind(...args, r.claimId),
      ]),
      c = rows[0]?.results[0] ?? null;
    let latest: string | null = null,
      prior: string | null = null;
    if (c) {
      latest =
        (
          await reader
            .prepare(LATEST)
            .bind(r.organizationId, r.projectId, c["environment_id"])
            .first<{ value: string }>()
        )?.value ?? null;
      if (latest) {
        const route = JSON.parse(latest) as Route;
        if (route.predecessor_revision !== null)
          prior =
            (
              await reader
                .prepare(
                  `SELECT ${ROUTE_ROW} value ${ROUTE_FROM} WHERE route.organization_id=?1 AND route.project_id=?2 AND route.environment_id=?3 AND route.revision=CAST(?4 AS INTEGER)`,
                )
                .bind(
                  r.organizationId,
                  r.projectId,
                  c["environment_id"],
                  route.predecessor_revision,
                )
                .first<{ value: string }>()
            )?.value ?? null;
      }
    }
    return {
      candidate: c,
      receipt: rows[1]?.results[0] ?? null,
      claim: rows[2]?.results[0] ?? null,
      settleAllowed: (rows[3]?.results.length ?? 0) > 0,
      latest,
      prior,
    };
  };
  const receiptMatches = (row: Row, selected: z.output<typeof gatewayInput> | null) =>
    row["cleanup_receipt_id"] === r.cleanupReceiptId &&
    row["outcome"] === r.outcome &&
    row["observed_provider_tag"] === r.observedProviderTag &&
    row["observed_at"] === r.observedAt &&
    (selected === null ||
      (row["compensated_target_script_name"] === selected.compensatedTargetScriptName &&
        row["shared_gateway_revision"] === selected.sharedGatewayRevision));
  const command: Command<Awaited<ReturnType<typeof read>>, "created" | "existing"> = {
    name: "provisioning.recordCandidateCleanup",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: [
      "wfp_candidate_cleanup_receipts",
      "wfp_candidate_operation_cleanup_receipts",
      "shared_gateway_route_revisions",
    ],
    read,
    decide: (s) => {
      if (!s.candidate) return { reject: fail("WFP candidate cleanup scope changed") };
      const c = s.candidate,
        env = String(c["environment_id"]),
        route = s.latest === null ? null : (JSON.parse(s.latest) as Route),
        previous = s.prior === null ? null : (JSON.parse(s.prior) as Route);
      if (s.receipt && !receiptMatches(s.receipt, i.gateway))
        return { reject: fail("WFP candidate cleanup receipt changed") };
      if (
        !s.receipt &&
        (!s.claim ||
          s.claim["claim_id"] !== r.claimId ||
          c["provider_tag"] !== r.observedProviderTag)
      )
        return { reject: fail("WFP candidate cleanup claim or provider tag changed") };
      const statements: D1PreparedStatement[] = [
        fenceRaceGuard(db, "operation_conflict", r.organizationId),
      ];
      let selected = i.gateway;
      if (!s.receipt && selected === null) {
        if (!s.settleAllowed) return { reject: fail("Shared gateway cleanup scope changed") };
        statements.push(
          guard(db, "precondition_changed", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
            r.organizationId,
            r.projectId,
            env,
            s.latest ?? "null",
          ]),
          guard(
            db,
            "operation_conflict",
            "NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_claims claim JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.candidate_receipt_id=?3 AND claim.claim_id=?4)",
            [...args, r.claimId],
          ),
        );
        if (!route || !route.active)
          selected = { compensatedTargetScriptName: null, sharedGatewayRevision: null };
        else if (route.candidate_receipt_id !== r.candidateReceiptId)
          selected = {
            compensatedTargetScriptName: route.immutable_script_name,
            sharedGatewayRevision: revisionOf(route.revision),
          };
        else {
          if (previous?.active)
            statements.push(
              guard(
                db,
                "operation_conflict",
                "NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.candidate_receipt_id=?4 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id) AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_requests cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id))",
                [r.organizationId, r.projectId, env, previous.candidate_receipt_id],
              ),
            );
          const next = previous ?? route,
            revision = revisionOf(route.revision) + 1;
          if (!Number.isSafeInteger(revision)) throw fail("Shared gateway revision is invalid");
          statements.push(
            db
              .prepare(
                "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,browser_policy,observed_at) VALUES(?,?,?,?,?,?,?,'compensate',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",
              )
              .bind(
                r.organizationId,
                r.projectId,
                env,
                revision,
                revisionOf(route.revision),
                route.operation_id,
                next.candidate_receipt_id,
                previous?.active ? 1 : 0,
                next.handle,
                next.public_origin,
                generatedJsonb(next.egress_allowed_origins),
                next.browser_policy === null ? null : generatedJsonb(next.browser_policy),
              ),
          );
          selected = previous?.active
            ? {
                compensatedTargetScriptName: previous.immutable_script_name,
                sharedGatewayRevision: revision,
              }
            : { compensatedTargetScriptName: null, sharedGatewayRevision: null };
        }
      }
      if (!s.receipt) {
        if (selected === null) throw fail("Candidate gateway cleanup evidence is absent");
        statements.push(
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_claims WHERE organization_id=?1 AND project_id=?2 AND candidate_receipt_id=?3 AND claim_id=?4)",
            [...args, r.claimId],
          ),
          db
            .prepare(
              "INSERT INTO wfp_candidate_cleanup_receipts(cleanup_receipt_id,candidate_receipt_id,organization_id,project_id,outcome,compensated_target_script_name,shared_gateway_revision,observed_provider_tag,observed_at,environment_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              r.cleanupReceiptId,
              r.candidateReceiptId,
              r.organizationId,
              r.projectId,
              r.outcome,
              selected.compensatedTargetScriptName,
              selected.sharedGatewayRevision,
              r.observedProviderTag,
              r.observedAt,
              env,
            ),
          db
            .prepare(
              "DELETE FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?1 AND organization_id=?2 AND project_id=?3 AND claim_id=?4",
            )
            .bind(r.candidateReceiptId, r.organizationId, r.projectId, r.claimId),
        );
      }
      for (const resource of i.resources) {
        if (resource.operationId !== c["operation_id"])
          return { reject: fail("Candidate cleanup producing operation changed") };
        const exact = resourceExact(resource);
        statements.push(
          db
            .prepare(
              "INSERT INTO wfp_candidate_operation_cleanup_receipts(operation_cleanup_receipt_id,cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256,outcome,observed_at) SELECT ?1,expected.cleanup_request_id,?2,?3,?4,?5,?6,?7,unhex(?8),?9,?10 FROM wfp_candidate_cleanup_resource_expectations expected JOIN wfp_candidate_cleanup_receipts cleanup ON cleanup.candidate_receipt_id=expected.candidate_receipt_id WHERE expected.candidate_receipt_id=?2 AND expected.organization_id=?3 AND expected.project_id=?4 AND expected.operation_id=?5 AND expected.provider=?6 AND expected.resource_kind=?7 AND lower(hex(expected.resource_identity_sha256))=?8 ON CONFLICT(cleanup_request_id,provider,resource_kind,resource_identity_sha256) DO NOTHING",
            )
            .bind(...exact.values),
          guard(db, "precondition_changed", `NOT EXISTS(${exact.sql})`, exact.values),
        );
      }
      return { statements, result: () => (s.receipt ? "existing" : "created") };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      if (!s.receipt || !receiptMatches(s.receipt, i.gateway)) return undefined;
      for (const resource of i.resources) {
        const e = resourceExact(resource);
        if (
          (await reader
            .prepare(e.sql)
            .bind(...e.values)
            .first()) === null
        )
          return undefined;
      }
      return "existing";
    },
  };
  return runCommand(db, command);
}
