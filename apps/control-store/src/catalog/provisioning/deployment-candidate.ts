import { parseUlid } from "@ohmyhost/platform";
import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  ulid,
  instant,
  routeOrganization,
  publicTimestamp,
  type CatalogContext,
} from "../common.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import { sourceArchiveEvidenceInput, sourceArchiveStatements } from "./source-custody.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "./authority.js";
import { ABANDONED } from "./context-queries.js";
import { currentDataEnvironment } from "../database/authority.js";
import { ROUTE_ROW, ROUTE_FROM } from "../gateway/facts.js";
import { receiptOf, type Route } from "../gateway/mutations.js";
const timestamp = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
  .pipe(instant);
const digest = z
  .string()
  .regex(/^(?:sha256:)?[0-9a-f]{64}$/u)
  .transform((v) => v.replace(/^sha256:/u, ""));
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
      candidateReceiptId: ulid,
      organizationId: ulid,
      projectId: ulid,
      environmentId: ulid,
      operationId: ulid,
      productDeploymentId: ulid,
      artifactId: ulid,
      namespace: z
        .string()
        .min(1)
        .refine((v) => v.trim() === v),
      immutableScriptName: z.string().regex(/^p-[0-9a-z]{26}-(?:dev|prod)-[0-9a-z]{26}$/u),
      artifactDigest: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
      bindingSetDigest: z
        .instanceof(Uint8Array)
        .refine((v) => v.byteLength === 32)
        .optional(),
      providerTag: z
        .string()
        .min(1)
        .refine((v) => v.trim() === v),
      buildReused: z.boolean(),
      stagedAt: timestamp,
    })
    .refine(
      (value) => !Object.hasOwn(value, "bindingSetDigest") || value.bindingSetDigest !== undefined,
    ),
);
const evidenceInput = sourceArchiveEvidenceInput.safeExtend({
  deploymentId: ulid,
  planId: ulid,
  uploadId: ulid,
  uploadClaimId: ulid,
  buildExecutionId: ulid,
  artifactId: ulid,
  revisionId: ulid,
  buildPlanSha256: digest,
  build: z.strictObject({ buildId: z.string().min(1), projectName: z.string().min(1) }),
  artifact: z.strictObject({
    artifactDigest: digest,
    manifestDigest: digest,
    sbomDigest: digest,
    outputVersionRef: z.string().min(1),
  }),
  archive: sourceArchiveEvidenceInput.shape.archive.extend({
    bucket: z.string().min(1),
    key: z.string().min(1),
    versionId: z.string().min(1),
    archiveId: z.string().min(1),
    eTag: z.string().min(1),
  }),
});
const recordInput = z.strictObject({
  eventType: z.enum([
    "DeploymentRequestedV1",
    "DeploymentPromotionRequestedV1",
    "DeploymentRollbackRequestedV1",
  ]),
  candidate: candidateInput,
  deploymentEvidence: evidenceInput.nullable(),
});
const logical = z.strictObject({ organizationId: ulid, projectId: ulid, environmentId: ulid });
type Candidate = z.output<typeof candidateInput>;
type Evidence = z.output<typeof evidenceInput>;
type Row = Record<string, unknown>;
const conflict = (message: string) => new ProductWorkflowContextConflictError(message);
const bytesHex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
const COLUMNS =
  "candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at,binding_set_digest".split(
    ",",
  );
const values = (c: Candidate) => [
  c.candidateReceiptId,
  c.organizationId,
  c.projectId,
  c.environmentId,
  c.operationId,
  c.productDeploymentId,
  c.artifactId,
  c.namespace,
  c.immutableScriptName,
  bytesHex(c.artifactDigest),
  c.providerTag,
  c.buildReused ? 1 : 0,
  c.stagedAt,
  c.bindingSetDigest === undefined ? null : bytesHex(c.bindingSetDigest),
];
const CANDIDATE = `SELECT candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,lower(hex(artifact_sha256)) artifact_sha256,provider_tag,build_reused,staged_at,CASE WHEN binding_set_digest IS NULL THEN NULL ELSE lower(hex(binding_set_digest)) END binding_set_digest FROM wfp_candidate_receipts WHERE candidate_receipt_id=?1`;
const BUILDS = `SELECT build.build_execution_id,build.operation_id,build.source_upload_id,lower(hex(build.build_plan_sha256)) build_plan_sha256,build.build_project_name,build.provider_build_id,build.state,artifact.artifact_id,lower(hex(artifact.artifact_sha256)) artifact_sha256,lower(hex(artifact.manifest_sha256)) manifest_sha256,lower(hex(artifact.sbom_sha256)) sbom_sha256,artifact.object_version_ref FROM build_executions build LEFT JOIN build_artifacts artifact ON artifact.organization_id=build.organization_id AND artifact.project_id=build.project_id AND artifact.build_execution_id=build.build_execution_id WHERE build.organization_id=?1 AND build.project_id=?2 AND(build.build_execution_id=?3 OR artifact.artifact_id=?4)`;
const CLAIM = `SELECT 1 FROM product_provider_mutation_claims claim JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id AND project.owner_state='active' WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.event_type='DeploymentRequestedV1' AND operation.state IN('queued','running') AND project.lifecycle_state='active' AND project.lifecycle_version=claim.accepted_lifecycle_version`;
function sameCandidate(row: Row, c: Candidate) {
  const v = values(c);
  return COLUMNS.every((k, n) => row[k] === v[n]);
}
function checkBuild(rows: Row[], e: Evidence): boolean {
  if (rows.length === 0) return false;
  const row = rows[0],
    expected = {
      build_execution_id: e.buildExecutionId,
      operation_id: e.operationId,
      source_upload_id: e.uploadId,
      build_plan_sha256: e.buildPlanSha256,
      build_project_name: e.build.projectName,
      provider_build_id: e.build.buildId,
      state: "succeeded",
      artifact_id: e.artifactId,
      artifact_sha256: e.artifact.artifactDigest,
      manifest_sha256: e.artifact.manifestDigest,
      sbom_sha256: e.artifact.sbomDigest,
      object_version_ref: e.artifact.outputVersionRef,
    };
  if (rows.length !== 1 || !row || Object.entries(expected).some(([k, v]) => row[k] !== v))
    throw conflict("Product deployment evidence changed");
  return true;
}
function uploadMatches(row: Row, e: Evidence) {
  return (
    row["upload_id"] === e.uploadId &&
    row["bucket_name"] === e.archive.bucket &&
    row["object_key"] === e.archive.key &&
    row["object_version_id"] === e.archive.versionId
  );
}
/** Source custody, four raw Build facts and candidate form the original SINGLE effect, including late rollback. */
export async function recordProductDeploymentCandidate(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = recordInput.parse(raw),
    c = i.candidate,
    e = i.deploymentEvidence,
    { db } = await routeOrganization(context, c.organizationId);
  if (
    e &&
    (i.eventType !== "DeploymentRequestedV1" ||
      e.organizationId !== c.organizationId ||
      e.projectId !== c.projectId ||
      e.environmentId !== c.environmentId ||
      e.operationId !== c.operationId ||
      e.deploymentId !== c.productDeploymentId ||
      e.artifactId !== c.artifactId)
  )
    throw conflict("Candidate and deployment evidence scope changed");
  const buildParams = e ? [e.organizationId, e.projectId, e.buildExecutionId, e.artifactId] : [];
  const read = async (reader: D1Database) => {
    const [candidate, build, upload] = await reader.batch([
      reader.prepare(CANDIDATE).bind(c.candidateReceiptId),
      reader.prepare(e ? BUILDS : "SELECT 1 WHERE false").bind(...buildParams),
      reader
        .prepare(
          e
            ? "SELECT upload_id,bucket_name,object_key,object_version_id FROM build_source_uploads WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND source_connection_id=?4 AND commit_sha=?5"
            : "SELECT 1 WHERE false",
        )
        .bind(
          ...(e
            ? [e.organizationId, e.projectId, e.operationId, e.sourceConnectionId, e.commitSha]
            : []),
        ),
    ]);
    return {
      candidate: candidate?.results[0] ?? null,
      build: build?.results ?? [],
      upload: upload?.results[0] ?? null,
      proof: await readWorkflowDelegation(reader, c),
    };
  };
  const command: Command<Awaited<ReturnType<typeof read>>, "created" | "existing"> = {
    name: "provisioning.recordDeploymentCandidate",
    input: i,
    read,
    retryOn: ["precondition_changed"],
    naturalKeyTables: [
      "source_archives",
      "product_source_archive_objects",
      "build_source_uploads",
      "build_executions",
      "build_artifacts",
      "wfp_candidate_receipts",
    ],
    decide(s) {
      if (s.candidate && !sameCandidate(s.candidate, c))
        return { reject: conflict("WFP candidate receipt identity changed") };
      const statements: D1PreparedStatement[] = [];
      if (e && !checkBuild(s.build, e)) {
        statements.push(
          ...workflowExecutionGuards(db, c, s.proof),
          guard(db, "scope_inactive", `NOT EXISTS(${CLAIM})`, [
            c.organizationId,
            c.projectId,
            c.environmentId,
            c.operationId,
          ]),
          ...sourceArchiveStatements(db, e),
        );
        if (s.upload && !uploadMatches(s.upload, e))
          return { reject: conflict("Source archive evidence changed") };
        if (!s.upload)
          statements.push(
            db
              .prepare(
                "INSERT INTO build_source_uploads(upload_id,organization_id,project_id,operation_id,source_connection_id,commit_sha,bucket_name,object_key,object_version_id,state,claim_id,claimed_at,lease_expires_at,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'completed',?10,?11,?12,1,?11,?11)",
              )
              .bind(
                e.uploadId,
                e.organizationId,
                e.projectId,
                e.operationId,
                e.sourceConnectionId,
                e.commitSha,
                e.archive.bucket,
                e.archive.key,
                e.archive.versionId,
                e.uploadClaimId,
                e.recordedAt,
                new Date(Date.parse(e.recordedAt) + 1000).toISOString().replace("Z", "000Z"),
              ),
          );
        statements.push(
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM build_source_uploads WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND source_connection_id=?4 AND commit_sha=?5 AND upload_id=?6 AND bucket_name=?7 AND object_key=?8 AND object_version_id=?9)",
            [
              e.organizationId,
              e.projectId,
              e.operationId,
              e.sourceConnectionId,
              e.commitSha,
              e.uploadId,
              e.archive.bucket,
              e.archive.key,
              e.archive.versionId,
            ],
          ),
          db
            .prepare(
              "INSERT INTO build_executions(build_execution_id,organization_id,project_id,operation_id,source_upload_id,build_plan_sha256,build_project_name,provider_build_id,state,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,unhex(?6),?7,?8,'succeeded',1,?9,?9)",
            )
            .bind(
              e.buildExecutionId,
              e.organizationId,
              e.projectId,
              e.operationId,
              e.uploadId,
              e.buildPlanSha256,
              e.build.projectName,
              e.build.buildId,
              e.recordedAt,
            ),
          db
            .prepare(
              "INSERT INTO build_artifacts(artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,manifest_sha256,sbom_sha256,object_version_ref,created_at) VALUES(?1,?2,?3,?4,unhex(?5),unhex(?6),unhex(?7),?8,?9)",
            )
            .bind(
              e.artifactId,
              e.organizationId,
              e.projectId,
              e.buildExecutionId,
              e.artifact.artifactDigest,
              e.artifact.manifestDigest,
              e.artifact.sbomDigest,
              e.artifact.outputVersionRef,
              e.recordedAt,
            ),
        );
      }
      const inserted = statements.length,
        v = values(c);
      statements.push(
        db
          .prepare(
            `INSERT INTO wfp_candidate_receipts(${COLUMNS.join(",")}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,unhex(?10),?11,?12,?13,unhex(?14)) ON CONFLICT(candidate_receipt_id) DO NOTHING RETURNING 1`,
          )
          .bind(...v),
        guard(
          db,
          "precondition_changed",
          `NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts WHERE ${COLUMNS.map((k, n) => (k === "artifact_sha256" ? `lower(hex(${k})) IS ?${n + 1}` : k === "binding_set_digest" ? `${k} IS unhex(?${n + 1})` : `${k} IS ?${n + 1}`)).join(" AND ")})`,
          v,
        ),
      );
      return {
        statements,
        result: (r) => (r[inserted]?.results.length === 1 ? "created" : "existing"),
      };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      if (!s.candidate) return undefined;
      if (!sameCandidate(s.candidate, c)) throw conflict("WFP candidate receipt identity changed");
      if (e && !checkBuild(s.build, e)) return undefined;
      return "existing";
    },
  };
  return runCommand(db, command);
}
const abandonedInput = logical.extend({
  operationId: ulid,
  candidateReceiptId: ulid,
  sharedGatewayRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  auditEventId: ulid,
  observedAt: timestamp,
});
/** Literal abandoned-target authority and exact audit replay, guarded again in the audit's commit. */
export async function recordAbandonedGatewayPredecessor(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = abandonedInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    params = [i.organizationId, i.projectId, i.environmentId, i.operationId];
  const command: Command<{ target: Row | undefined; audit: Row | null }, "created" | "existing"> = {
    name: "provisioning.recordAbandonedGateway",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["audit_events"],
    read: async (reader) => ({
      target: (
        await reader
          .prepare(ABANDONED)
          .bind(...params)
          .all()
      ).results.find((r) => r["candidate_receipt_id"] === i.candidateReceiptId),
      audit: await reader
        .prepare("SELECT * FROM audit_events WHERE audit_event_id=?1")
        .bind(i.auditEventId)
        .first<Row>(),
    }),
    decide(s) {
      if (!s.target) return { reject: conflict("Abandoned gateway predecessor scope changed") };
      const payload = {
        environmentId: i.environmentId,
        predecessorOperationId: s.target["operation_id"],
        candidateReceiptId: i.candidateReceiptId,
        targetDeploymentId: s.target["product_deployment_id"],
        sharedGatewayRevision: i.sharedGatewayRevision,
      };
      if (
        s.audit &&
        (s.audit["organization_id"] !== i.organizationId ||
          s.audit["project_id"] !== i.projectId ||
          s.audit["operation_id"] !== i.operationId ||
          s.audit["event_type"] !== "AbandonedGatewayPredecessorVerified" ||
          s.audit["actor_type"] !== "service" ||
          s.audit["actor_id"] !== "deployment-workflow" ||
          Object.keys(JSON.parse(String(s.audit["payload"]))).length !==
            Object.keys(payload).length ||
          Object.entries(payload).some(
            ([k, v]) => JSON.parse(String(s.audit?.["payload"]))[k] !== v,
          ))
      )
        return { reject: conflict("Abandoned gateway predecessor audit changed") };
      return {
        statements: [
          guard(
            db,
            "scope_inactive",
            `NOT EXISTS(SELECT 1 FROM (${ABANDONED}) target WHERE target.candidate_receipt_id=?5 AND target.operation_id=?6 AND target.product_deployment_id=?7)`,
            [
              ...params,
              i.candidateReceiptId,
              s.target["operation_id"],
              s.target["product_deployment_id"],
            ],
          ),
          db
            .prepare(
              "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) SELECT ?1,?2,?3,?4,'AbandonedGatewayPredecessorVerified','service','deployment-workflow',?5,?6,claim.billing_epoch_id FROM product_provider_mutation_claims claim WHERE claim.organization_id=?1 AND claim.project_id=?3 AND claim.operation_id=?4 ON CONFLICT(audit_event_id) DO NOTHING RETURNING 1",
            )
            .bind(
              i.organizationId,
              i.auditEventId,
              i.projectId,
              i.operationId,
              JSON.stringify(payload),
              i.observedAt,
            ),
        ],
        result: (r) => (r[1]?.results.length === 1 ? "created" : "existing"),
      };
    },
  };
  return runCommand(db, command);
}
export async function readProductDataEnvironment(context: CatalogContext, raw: unknown) {
  const i = logical.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      `SELECT ${currentDataEnvironment("p.organization_id", "p.project_id", "e.environment_id")} AS data_environment_id FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id WHERE p.organization_id=?1 AND p.project_id=?2 AND e.environment_id=?3 AND p.owner_state='active'`,
    )
    .bind(i.organizationId, i.projectId, i.environmentId)
    .first<{ data_environment_id: string | null }>();
  return row?.data_environment_id == null ? null : parseUlid(row.data_environment_id);
}
const rollbackInput = logical.extend({ targetDeploymentId: ulid, targetRevisionId: ulid });
const ROLLBACK = `SELECT receipt.wfp_receipt_id,receipt.deployment_url,CAST(receipt.shared_gateway_revision AS TEXT) shared_gateway_revision,candidate.*
 FROM deployment_revisions revision JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=receipt.organization_id AND candidate.project_id=receipt.project_id AND candidate.candidate_receipt_id=receipt.candidate_receipt_id
 WHERE revision.organization_id=?1 AND revision.project_id=?2 AND receipt.environment_id=?3 AND revision.deployment_id=?4 AND revision.revision_id=?5 AND receipt.product_deployment_id=revision.deployment_id AND receipt.shared_gateway_revision IS NOT NULL
 AND(NOT EXISTS(SELECT 1 FROM deployment_plans plan WHERE plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id AND json_extract(plan.framework_plan,'$.database.enabled') IN(1,'true'))
 OR NOT EXISTS(SELECT 1 FROM database_provider_target_heads head JOIN database_provider_target_revisions target USING(organization_id,project_id,physical_environment_id,target_version) WHERE head.organization_id=revision.organization_id AND head.project_id=revision.project_id AND head.physical_environment_id=${currentDataEnvironment("revision.organization_id", "revision.project_id", "receipt.environment_id")} AND head.state='active' AND target.provider='pgcf' AND candidate.staged_at<=(SELECT min(bound.created_at) FROM database_provider_target_revisions bound WHERE bound.organization_id=target.organization_id AND bound.project_id=target.project_id AND bound.physical_environment_id=target.physical_environment_id AND bound.provider='pgcf' AND bound.provider_project_id=target.provider_project_id AND bound.database_id=target.database_id)))`;
/** Exact original read-only rollback selection. Cleanup finality and PGCF binding history never become absence fallbacks. */
export async function resolveProductRollbackCandidate(context: CatalogContext, raw: unknown) {
  const i = rollbackInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    p = [i.organizationId, i.projectId, i.environmentId, i.targetDeploymentId, i.targetRevisionId];
  const r = await db
    .prepare(ROLLBACK)
    .bind(...p)
    .first<Row>();
  if (!r) return null;
  const hash = bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `cloudflare\0wfp-script\0${String(r["dispatch_namespace"])}/${String(r["immutable_script_name"])}`,
        ),
      ),
    ),
  );
  const cleaned = await db
    .prepare(
      `SELECT 1 FROM product_command_intents maintenance JOIN run_resource_inventory inventory ON inventory.organization_id=maintenance.organization_id AND inventory.project_id=maintenance.project_id AND inventory.operation_id=maintenance.operation_id WHERE maintenance.organization_id=?1 AND maintenance.project_id=?2 AND inventory.provider='cloudflare' AND inventory.resource_kind='wfp-script' AND inventory.external_ref_hash=unhex(?3) AND(SELECT outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash ORDER BY attempted_at DESC,cleanup_attempt_id DESC LIMIT 1) IN('removed','not_found')`,
    )
    .bind(i.organizationId, i.projectId, hash)
    .first();
  if (cleaned) return null;
  const gateway = await db
    .prepare(
      `SELECT ${ROUTE_ROW} AS value ${ROUTE_FROM} WHERE route.organization_id=?1 AND route.project_id=?2 AND route.environment_id=?3 AND route.revision=CAST(?4 AS INTEGER)`,
    )
    .bind(i.organizationId, i.projectId, i.environmentId, r["shared_gateway_revision"])
    .first<{ value: string }>();
  if (!gateway) throw conflict("Shared gateway route revision is unavailable");
  const artifact = r["artifact_sha256"];
  const digestBytes =
    artifact instanceof Uint8Array
      ? artifact
      : artifact instanceof ArrayBuffer
        ? new Uint8Array(artifact)
        : Array.isArray(artifact)
          ? Uint8Array.from(artifact)
          : null;
  if (!digestBytes) throw conflict("Rollback artifact digest is invalid");
  const bindingDigest = r["binding_set_digest"];
  const bindingBytes =
    bindingDigest == null
      ? undefined
      : bindingDigest instanceof Uint8Array
        ? bindingDigest
        : bindingDigest instanceof ArrayBuffer
          ? new Uint8Array(bindingDigest)
          : Array.isArray(bindingDigest)
            ? Uint8Array.from(bindingDigest)
            : null;
  if (bindingBytes === null || (bindingBytes !== undefined && bindingBytes.byteLength !== 32))
    throw conflict("Rollback binding set digest is invalid");
  return {
    targetDeploymentId: parseUlid(i.targetDeploymentId),
    targetRevisionId: parseUlid(i.targetRevisionId),
    wfpReceiptId: parseUlid(String(r["wfp_receipt_id"])),
    deploymentUrl: String(r["deployment_url"]),
    gateway: await receiptOf(JSON.parse(gateway.value) as Route),
    candidate: {
      candidateReceiptId: parseUlid(String(r["candidate_receipt_id"])),
      organizationId: parseUlid(String(r["organization_id"])),
      projectId: parseUlid(String(r["project_id"])),
      environmentId: parseUlid(String(r["environment_id"])),
      operationId: parseUlid(String(r["operation_id"])),
      productDeploymentId: parseUlid(String(r["product_deployment_id"])),
      artifactId: parseUlid(String(r["artifact_id"])),
      namespace: String(r["dispatch_namespace"]),
      immutableScriptName: String(r["immutable_script_name"]),
      artifactDigest: digestBytes,
      ...(bindingBytes === undefined ? {} : { bindingSetDigest: bindingBytes }),
      providerTag: String(r["provider_tag"]),
      buildReused: r["build_reused"] === 1,
      stagedAt: publicTimestamp(String(r["staged_at"])),
    },
  };
}
