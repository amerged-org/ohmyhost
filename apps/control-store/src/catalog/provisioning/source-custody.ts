import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import {
  routeOrganization,
  ulid,
  instant,
  hexBytes,
  fenceRaceGuard,
  type CatalogContext,
} from "../common.js";
import { ProductWorkflowContextConflictError } from "./context.js";
const digest = z
  .string()
  .regex(/^(?:sha256:)?[0-9a-f]{64}$/u)
  .transform((v) => v.replace(/^sha256:/u, ""));
export const sourceArchiveEvidenceInput = z
  .strictObject({
    provider: z.enum(["github", "managed"]).default("github"),
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    operationId: ulid,
    billingEpochId: ulid,
    sourceConnectionId: ulid,
    externalRepositoryId: z.string(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .refine((v) => v !== "0".repeat(40)),
    sourceSha256: digest,
    archive: z.strictObject({
      bucket: z.string(),
      key: z.string(),
      versionId: z.string(),
      archiveId: z.string(),
      eTag: z.string(),
      byteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
    recordedAt: z
      .string()
      .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
      .pipe(instant),
  })
  .superRefine((v, c) => {
    if (!repositoryMatches(v.provider, v.externalRepositoryId))
      c.addIssue({ code: "custom", message: "Source repository identity is invalid" });
    if (!opaqueReference(v.archive.archiveId, v.operationId))
      c.addIssue({ code: "custom", message: "Source archive reference is invalid" });
  });
export type SourceArchiveEvidenceInput = z.output<typeof sourceArchiveEvidenceInput>;
type Row = Record<string, unknown>;
function repositoryMatches(provider: "github" | "managed", id: string): boolean {
  return provider === "github"
    ? /^[1-9][0-9]{0,15}$/u.test(id) && BigInt(id) <= 9007199254740991n
    : /^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/u.test(id);
}
function opaqueReference(ref: string, operationId: string): boolean {
  const opaque = /^archive_([0-7][0-9A-HJKMNP-TV-Z]{25})_([0-7][0-9A-HJKMNP-TV-Z]{25})$/u.exec(ref);
  return (
    (ref.length <= 512 &&
      /^r2-version:ohmyho-builds-(?:development|production)(?:-eu)?\/[^?#\s]{1,400}#[0-9a-f]{32}$/u.test(
        ref,
      )) ||
    opaque?.[1] === operationId
  );
}
const RECEIPT_COLUMNS =
  "operation_id,organization_id,project_id,billing_epoch_id,provider,source_connection_id,external_repository_id,requested_commit_sha,resolved_commit_sha,archive_format,sha256,byte_length,object_ref,acquired_at".split(
    ",",
  );
const OBJECT_COLUMNS =
  "operation_id,organization_id,project_id,environment_id,bucket_name,object_key,object_version_id,object_etag,byte_length,source_sha256,recorded_at".split(
    ",",
  );
function receiptValues(i: SourceArchiveEvidenceInput): unknown[] {
  return [
    i.operationId,
    i.organizationId,
    i.projectId,
    i.billingEpochId,
    i.provider,
    i.sourceConnectionId,
    i.externalRepositoryId,
    i.commitSha,
    i.commitSha,
    "tar.gz",
    i.sourceSha256,
    i.archive.byteLength,
    i.archive.archiveId,
    i.recordedAt,
  ];
}
function objectValues(i: SourceArchiveEvidenceInput): unknown[] {
  return [
    i.operationId,
    i.organizationId,
    i.projectId,
    i.environmentId,
    i.archive.bucket,
    i.archive.key,
    i.archive.versionId,
    i.archive.eTag,
    i.archive.byteLength,
    i.sourceSha256,
    i.recordedAt,
  ];
}
function equal(
  row: Row | null,
  columns: readonly string[],
  values: readonly unknown[],
  time: string,
): boolean {
  return (
    row !== null &&
    columns.every((k, index) =>
      k === time
        ? String(row[k]).slice(0, 23) === String(values[index]).slice(0, 23)
        : row[k] === values[index],
    )
  );
}
export class SourceArchiveCustodyConflictError extends Error {
  readonly code = "source_archive_reconciliation_required";
  constructor() {
    super("Source archive receipt conflicts with immutable persisted evidence");
    this.name = "SourceArchiveReconciliationConflictError";
  }
}
/** Both original custody rows are one effect. This records an observed artifact; it authorizes no provider mutation. */
export function sourceArchiveStatements(
  db: D1Database,
  i: SourceArchiveEvidenceInput,
): D1PreparedStatement[] {
  const receipt = receiptValues(i),
    object = objectValues(i);
  return [
    db
      .prepare(
        `INSERT INTO source_archives(${RECEIPT_COLUMNS}) VALUES(${receipt.map((_, n) => (n === 10 ? `unhex(?${n + 1})` : `?${n + 1}`))}) ON CONFLICT(operation_id) DO NOTHING`,
      )
      .bind(...receipt),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM source_archives WHERE ${RECEIPT_COLUMNS.map((k, n) => (k === "sha256" ? `lower(hex(${k}))=?${n + 1}` : k === "acquired_at" ? `substr(${k},1,23)=substr(?${n + 1},1,23)` : `${k} IS ?${n + 1}`)).join(" AND ")})`,
      receipt,
    ),
    db
      .prepare(
        `INSERT INTO product_source_archive_objects(${OBJECT_COLUMNS}) VALUES(${object.map((_, n) => (n === 9 ? `unhex(?${n + 1})` : `?${n + 1}`))}) ON CONFLICT(operation_id) DO NOTHING`,
      )
      .bind(...object),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM product_source_archive_objects WHERE ${OBJECT_COLUMNS.map((k, n) => (k === "source_sha256" ? `lower(hex(${k}))=?${n + 1}` : `${k} IS ?${n + 1}`)).join(" AND ")})`,
      object,
    ),
  ];
}
async function readCustody(db: D1Database, operationId: string) {
  const [receipt, object] = await db.batch([
    db
      .prepare(
        `SELECT ${RECEIPT_COLUMNS.map((k) => (k === "sha256" ? "lower(hex(sha256)) sha256" : k))} FROM source_archives WHERE operation_id=?1`,
      )
      .bind(operationId),
    db
      .prepare(
        `SELECT ${OBJECT_COLUMNS.map((k) => (k === "source_sha256" ? "lower(hex(source_sha256)) source_sha256" : k))} FROM product_source_archive_objects WHERE operation_id=?1`,
      )
      .bind(operationId),
  ]);
  return { receipt: receipt?.results[0] ?? null, object: object?.results[0] ?? null };
}
export async function recordProductSourceArchiveEvidence(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = sourceArchiveEvidenceInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    receipt = receiptValues(input),
    object = objectValues(input);
  const command: Command<Awaited<ReturnType<typeof readCustody>>, "created" | "existing"> = {
    name: "provisioning.recordSourceArchive",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["source_archives", "product_source_archive_objects"],
    read: (reader) => readCustody(reader, input.operationId),
    decide: (s) => {
      if (s.receipt && !equal(s.receipt, RECEIPT_COLUMNS, receipt, "acquired_at"))
        return { reject: new SourceArchiveCustodyConflictError() };
      // The object comparison is the original SQL timestamp equality, including all microseconds.
      if (
        s.object &&
        (!equal(s.object, OBJECT_COLUMNS, object, "") ||
          s.object["recorded_at"] !== input.recordedAt)
      )
        return {
          reject: new ProductWorkflowContextConflictError("Source archive object evidence changed"),
        };
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", input.organizationId),
          ...sourceArchiveStatements(db, input),
        ],
        result: () => (s.receipt && s.object ? "existing" : "created"),
      };
    },
    lookup: async (reader) => {
      const s = await readCustody(reader, input.operationId);
      return equal(s.receipt, RECEIPT_COLUMNS, receipt, "acquired_at") &&
        equal(s.object, OBJECT_COLUMNS, object, "") &&
        s.object?.["recorded_at"] === input.recordedAt
        ? "existing"
        : undefined;
    },
  };
  return runCommand(db, command);
}
/** Original readback projection only; the source receipt retains its separate original epoch/provider identity. */
export async function observeSourceArchiveReceipt(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ organizationId: ulid, projectId: ulid, operationId: ulid }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    row = await db
      .prepare(
        "SELECT *,lower(hex(sha256)) digest,CAST(byte_length AS TEXT) byte_length FROM source_archives WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      )
      .bind(i.organizationId, i.projectId, i.operationId)
      .first<Row>();
  if (!row) return null;
  const provider = z.enum(["github", "managed"]).parse(row["provider"]),
    repository = String(row["external_repository_id"]),
    ref = String(row["object_ref"]);
  if (!repositoryMatches(provider, repository) || !opaqueReference(ref, i.operationId))
    throw new TypeError("Source archive receipt is invalid");
  return {
    organizationId: parseUlid(String(row["organization_id"])),
    projectId: parseUlid(String(row["project_id"])),
    operationId: parseUlid(String(row["operation_id"])),
    billingEpochId: parseUlid(String(row["billing_epoch_id"])),
    provider,
    sourceConnectionId: parseUlid(String(row["source_connection_id"])),
    externalRepositoryId: repository,
    requestedCommitSha: String(row["requested_commit_sha"]),
    resolvedCommitSha: String(row["resolved_commit_sha"]),
    archiveFormat: z.literal("tar.gz").parse(row["archive_format"]),
    sha256: hexBytes(String(row["digest"])),
    byteLength: Number(row["byte_length"]),
    objectRef: ref,
    acquiredAt: String(row["acquired_at"]).slice(0, 23) + "Z",
  };
}
