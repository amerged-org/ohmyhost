import { z } from "zod";
import { guard } from "../../guards.js";
import { addMilliseconds, instant, ulid, type CatalogContext } from "../common.js";
import {
  scopeInput,
  key,
  idempotency,
  contentType,
  digestInput,
  clock,
  hex,
  runStorage,
  dataAt,
  blocked,
  StorageGatewayConflictError,
  StorageGatewayQuotaError,
  asDate,
  objectRow,
  type Row,
  type Scope,
} from "./common.js";
function sameLogical(
  scope: Scope,
  input: { organizationId: string; projectId: string; environmentId: string },
) {
  if (
    scope.organizationId !== input.organizationId ||
    scope.projectId !== input.projectId ||
    scope.environmentId !== input.environmentId
  )
    throw new StorageGatewayConflictError();
}
const logical = z.strictObject({ organizationId: ulid, projectId: ulid, environmentId: ulid });
const upload = logical
  .extend({
    transferId: ulid,
    idempotencyKey: idempotency,
    requestSha256: digestInput,
    objectKey: key,
    contentType,
    expectedBytes: z.number().int().min(0).max(1073741824),
    requestedAt: clock,
    expiresAt: clock,
  })
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.parse(v.requestedAt) &&
      Date.parse(v.expiresAt) <= Date.parse(v.requestedAt) + 300000,
  );
const RES = `SELECT r.*,lower(hex(r.request_sha256)) request_digest,o.transfer_id completed_transfer_id,EXISTS(SELECT 1 FROM project_r2_delete_requests d WHERE d.organization_id=r.organization_id AND d.project_id=r.project_id AND d.data_environment_id=r.data_environment_id AND d.object_key=r.object_key) deleted FROM project_r2_upload_reservations r LEFT JOIN project_r2_objects o USING(transfer_id) WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.idempotency_key=?4 AND r.data_environment_id=?5`;
/** Whether another claim already names this object key or its physical key: a reservation or a delete request. */
const KEY_CONFLICT = `SELECT (EXISTS(SELECT 1 FROM project_r2_upload_reservations WHERE organization_id=?1 AND project_id=?2 AND((data_environment_id=?3 AND object_key=?4) OR(environment_id=?5 AND physical_object_key=?6))) OR EXISTS(SELECT 1 FROM project_r2_delete_requests WHERE organization_id=?1 AND project_id=?2 AND data_environment_id=?3 AND object_key=?4)) AS conflict`;
/** The bytes of every object and every unconfirmed claim of the environment: an expired claim still counts until it is completed or erased. */
const TOTAL = `SELECT CAST(coalesce((SELECT sum(o.size) FROM project_r2_objects o WHERE o.organization_id=?1 AND o.project_id=?2 AND o.environment_id=?3 AND NOT EXISTS(SELECT 1 FROM project_r2_delete_receipts d WHERE d.organization_id=o.organization_id AND d.project_id=o.project_id AND d.environment_id=o.environment_id AND d.physical_object_key=o.physical_object_key)),0)+coalesce((SELECT sum(r.expected_bytes) FROM project_r2_upload_reservations r LEFT JOIN project_r2_objects o USING(transfer_id) WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND o.transfer_id IS NULL AND NOT EXISTS(SELECT 1 FROM project_r2_erasure_barriers b WHERE b.transfer_id=r.transfer_id AND b.organization_id=r.organization_id AND b.project_id=r.project_id AND b.environment_id=r.environment_id AND b.data_environment_id=r.data_environment_id AND b.object_key=r.object_key AND b.physical_object_key=r.physical_object_key)),0) AS TEXT) total`;
export async function claimStorageUpload(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ scope: scopeInput, input: upload }).parse(raw),
    q = i.input,
    s = i.scope;
  if (
    q.organizationId !== s.organizationId ||
    q.projectId !== s.projectId ||
    q.environmentId !== s.environmentId
  )
    throw new StorageGatewayConflictError();
  const p = [q.organizationId, q.projectId, q.environmentId, q.idempotencyKey, s.dataEnvironmentId];
  return runStorage(
    context,
    s,
    "storage.claimUpload",
    i,
    async (db) => ({
      row: await db
        .prepare(RES)
        .bind(...p)
        .first<Row>(),
      total: await db
        .prepare(TOTAL)
        .bind(q.organizationId, q.projectId, q.environmentId)
        .first<{ total: string }>(),
      conflict: await db
        .prepare(KEY_CONFLICT)
        .bind(
          q.organizationId,
          q.projectId,
          s.dataEnvironmentId,
          q.objectKey,
          q.environmentId,
          `d/${s.dataEnvironmentId}/${q.objectKey}`,
        )
        .first<{ conflict: number }>(),
    }),
    (db, state) => {
      if (state.row) {
        const r = state.row;
        if (
          r["request_digest"] !== hex(q.requestSha256) ||
          r["object_key"] !== q.objectKey ||
          r["content_type"] !== q.contentType ||
          Number(r["expected_bytes"]) !== q.expectedBytes ||
          r["deleted"]
        )
          return { reject: new StorageGatewayConflictError() };
        return {
          statements: [
            guard(
              db,
              "precondition_changed",
              `NOT EXISTS(SELECT 1 FROM(${RES}) r WHERE r.transfer_id=?6 AND r.completed_transfer_id IS ?7 AND r.deleted=0)`,
              [...p, r["transfer_id"], r["completed_transfer_id"]],
            ),
          ],
          result: () => ({
            outcome: (r["completed_transfer_id"] == null ? "existing" : "completed") as
              | "claimed"
              | "existing"
              | "completed",
            transferId: String(r["transfer_id"]),
            expiresAt: asDate(r["expires_at"]),
            physicalObjectKey: String(r["physical_object_key"]),
            dataEnvironmentId: String(r["data_environment_id"]),
          }),
        };
      }
      // An earlier claim of this key under another idempotency key is a settled conflict, not a race: the guard below
      // would fire on every retry, so the claim is refused here.
      if (state.conflict?.conflict) return { reject: new StorageGatewayConflictError() };
      const total = state.total?.total;
      if (total === undefined) throw new StorageGatewayConflictError();
      if (BigInt(total) + BigInt(q.expectedBytes) > 1073741824n)
        return { reject: new StorageGatewayQuotaError() };
      const physical = `d/${s.dataEnvironmentId}/${q.objectKey}`;
      return {
        statements: [
          guard(db, "precondition_changed", `(${TOTAL}) IS NOT ?4`, [
            q.organizationId,
            q.projectId,
            q.environmentId,
            total,
          ]),
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM project_r2_upload_reservations WHERE organization_id=?1 AND project_id=?2 AND((data_environment_id=?3 AND object_key=?4) OR(environment_id=?5 AND physical_object_key=?6))) OR EXISTS(SELECT 1 FROM project_r2_delete_requests WHERE organization_id=?1 AND project_id=?2 AND data_environment_id=?3 AND object_key=?4)",
            [
              q.organizationId,
              q.projectId,
              s.dataEnvironmentId,
              q.objectKey,
              q.environmentId,
              physical,
            ],
          ),
          db
            .prepare(
              "INSERT INTO project_r2_upload_reservations(transfer_id,organization_id,project_id,environment_id,idempotency_key,request_sha256,object_key,content_type,expected_bytes,requested_at,expires_at,data_environment_id,physical_object_key,logical_namespace_version) VALUES(?1,?2,?3,?4,?5,unhex(?6),?7,?8,?9,?10,?11,?12,?13,2)",
            )
            .bind(
              q.transferId,
              q.organizationId,
              q.projectId,
              q.environmentId,
              q.idempotencyKey,
              hex(q.requestSha256),
              q.objectKey,
              q.contentType,
              q.expectedBytes,
              q.requestedAt,
              q.expiresAt,
              s.dataEnvironmentId,
              physical,
            ),
        ],
        result: () => ({
          outcome: "claimed" as const,
          transferId: q.transferId,
          expiresAt: asDate(q.expiresAt),
          physicalObjectKey: physical,
          dataEnvironmentId: s.dataEnvironmentId,
        }),
      };
    },
    ["project_r2_upload_reservations"],
  );
}
const receipt = logical.extend({
  transferId: ulid,
  objectKey: key,
  contentType,
  size: z.number().int().min(0).max(1073741824),
  etag: z.string().regex(/^[0-9a-f]{32}(?:-[1-9][0-9]{0,4})?$/u),
  uploadedAt: z.date(),
});
export async function completeStorageUpload(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ scope: scopeInput, input: receipt }).parse(raw),
    q = i.input;
  if (q.organizationId !== i.scope.organizationId || q.projectId !== i.scope.projectId)
    throw new StorageGatewayConflictError();
  return runStorage(
    context,
    i.scope,
    "storage.completeUpload",
    i,
    (db) =>
      db
        .prepare("SELECT * FROM project_r2_upload_reservations WHERE transfer_id=?1")
        .bind(q.transferId)
        .first<Row>(),
    (db, r) => {
      if (
        !r ||
        r["organization_id"] !== q.organizationId ||
        r["project_id"] !== q.projectId ||
        r["environment_id"] !== q.environmentId ||
        r["object_key"] !== q.objectKey ||
        r["content_type"] !== q.contentType ||
        Number(r["expected_bytes"]) !== q.size ||
        q.uploadedAt.getTime() < Math.floor(asDate(r["requested_at"]).getTime() / 1000) * 1000 ||
        q.uploadedAt.getTime() > asDate(r["expires_at"]).getTime()
      )
        return { reject: new StorageGatewayConflictError() };
      const uploaded = q.uploadedAt.toISOString().replace("Z", "000Z");
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND ${dataAt("e.organization_id", "e.project_id", "e.environment_id")}=?3) OR EXISTS(SELECT 1 FROM project_r2_delete_requests WHERE organization_id=?1 AND project_id=?2 AND data_environment_id=?3 AND object_key=?4)`,
            [q.organizationId, q.projectId, r["data_environment_id"], q.objectKey],
          ),
          db
            .prepare(
              "INSERT INTO project_r2_objects(organization_id,project_id,environment_id,transfer_id,object_key,content_type,size,etag,uploaded_at,created_at,data_environment_id,physical_object_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),?10,?11) ON CONFLICT DO NOTHING RETURNING 1",
            )
            .bind(
              q.organizationId,
              q.projectId,
              q.environmentId,
              q.transferId,
              q.objectKey,
              q.contentType,
              q.size,
              q.etag,
              uploaded,
              r["data_environment_id"],
              r["physical_object_key"],
            ),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_r2_objects WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND transfer_id=?4 AND object_key=?5 AND content_type=?6 AND size=?7 AND etag=?8 AND substr(uploaded_at,1,23)=substr(?9,1,23))",
            [
              q.organizationId,
              q.projectId,
              q.environmentId,
              q.transferId,
              q.objectKey,
              q.contentType,
              q.size,
              q.etag,
              uploaded,
            ],
          ),
        ],
        result: (r) => (r[1]?.results.length === 1 ? ("created" as const) : ("existing" as const)),
      };
    },
    ["project_r2_objects"],
  );
}
const READ_RES = `SELECT r.*,o.transfer_id completed_transfer_id,b.jurisdiction FROM project_r2_upload_reservations r JOIN project_r2_bucket_receipts b USING(organization_id,project_id,environment_id) LEFT JOIN project_r2_objects o USING(transfer_id) JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE r.organization_id=?1 AND r.project_id=?2 AND r.data_environment_id=${dataAt("?1", "?2", "?3")} AND r.transfer_id=?4 AND NOT ${blocked("?1", "?2", "?3")} AND NOT EXISTS(SELECT 1 FROM project_r2_delete_requests d WHERE d.organization_id=r.organization_id AND d.project_id=r.project_id AND d.data_environment_id=r.data_environment_id AND d.object_key=r.object_key)`;
export async function readStorageUploadReservation(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ scope: scopeInput, input: logical.extend({ transferId: ulid }) })
      .parse(raw),
    q = i.input;
  sameLogical(i.scope, q);
  return runStorage(
    context,
    i.scope,
    "storage.readReservation",
    i,
    async () => null,
    (db) => ({
      statements: [
        db.prepare(READ_RES).bind(q.organizationId, q.projectId, q.environmentId, q.transferId),
      ],
      result: (rows) => {
        const r = rows[0]?.results[0];
        return r
          ? {
              transferId: String(r["transfer_id"]),
              objectKey: String(r["object_key"]),
              contentType: String(r["content_type"]),
              expectedBytes: Number(r["expected_bytes"]),
              requestedAt: asDate(r["requested_at"]),
              expiresAt: asDate(r["expires_at"]),
              completed: r["completed_transfer_id"] != null,
              environmentId: String(r["environment_id"]),
              dataEnvironmentId: String(r["data_environment_id"]),
              physicalObjectKey: String(r["physical_object_key"]),
              jurisdiction: r["jurisdiction"] as "eu" | "us",
            }
          : null;
      },
    }),
  );
}
const OBJECTS = `SELECT o.*,b.jurisdiction FROM project_r2_objects o JOIN project_r2_bucket_receipts b USING(organization_id,project_id,environment_id) JOIN projects p ON p.organization_id=o.organization_id AND p.project_id=o.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE o.organization_id=?1 AND o.project_id=?2 AND o.data_environment_id=${dataAt("?1", "?2", "?3")} AND NOT ${blocked("?1", "?2", "?3")} AND o.object_key IN(SELECT value FROM json_each(?4)) AND NOT EXISTS(SELECT 1 FROM project_r2_delete_requests d WHERE d.organization_id=o.organization_id AND d.project_id=o.project_id AND d.environment_id=o.environment_id AND d.physical_object_key=o.physical_object_key)`;
export async function readStorageObjects(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        scope: scopeInput,
        input: logical.extend({
          objectKeys: z
            .array(key)
            .min(1)
            .max(4000)
            .refine((v) => new Set(v).size === v.length),
        }),
      })
      .parse(raw),
    q = i.input;
  sameLogical(i.scope, q);
  return runStorage(
    context,
    i.scope,
    "storage.readObjects",
    i,
    async () => null,
    (db) => {
      const statements = [];
      for (let n = 0; n < q.objectKeys.length; n += 128)
        statements.push(
          db
            .prepare(OBJECTS)
            .bind(
              q.organizationId,
              q.projectId,
              q.environmentId,
              JSON.stringify(q.objectKeys.slice(n, n + 128)),
            ),
        );
      return {
        statements,
        result: (results) => {
          const rows = results.flatMap((r) => r.results),
            byKey = new Map(rows.map((r) => [String(r["object_key"]), objectRow(r)]));
          if (byKey.size !== rows.length)
            throw new StorageGatewayConflictError("storage_object_conflict");
          return q.objectKeys.map((k) => byKey.get(k) ?? null);
        },
      };
    },
  );
}
export async function readStorageObject(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({ scope: scopeInput, input: logical.extend({ objectKey: key }) })
    .parse(raw);
  return (
    (
      await readStorageObjects(context, {
        scope: i.scope,
        input: {
          organizationId: i.input.organizationId,
          projectId: i.input.projectId,
          environmentId: i.input.environmentId,
          objectKeys: [i.input.objectKey],
        },
      })
    )[0] ?? null
  );
}
const UNCONFIRMED_AGE_MILLISECONDS = 86400000;
/** Unconfirmed claims requested before the cutoff, of the current data area and a live, unblocked project, with no object row and no erasure barrier. */
const UNCONFIRMED = `SELECT r.organization_id,r.project_id,r.environment_id,r.data_environment_id,r.transfer_id,r.object_key,r.physical_object_key,r.requested_at,receipt.jurisdiction FROM project_r2_upload_reservations r JOIN project_r2_bucket_receipts receipt USING(organization_id,project_id,environment_id) JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.owner_state='active' AND p.lifecycle_state='active' LEFT JOIN project_r2_upload_sweep_attempts a ON a.transfer_id=r.transfer_id WHERE r.requested_at<?1 AND r.data_environment_id=${dataAt("r.organization_id", "r.project_id", "r.environment_id")} AND NOT ${blocked("r.organization_id", "r.project_id", "r.environment_id")} AND NOT EXISTS(SELECT 1 FROM project_r2_objects o WHERE o.transfer_id=r.transfer_id) AND NOT EXISTS(SELECT 1 FROM project_r2_erasure_barriers barrier WHERE barrier.transfer_id=r.transfer_id) ORDER BY COALESCE(a.attempted_at,''),r.requested_at,r.transfer_id LIMIT ?2`;
/**
 * Platform sweep read across every tenant of the partition: the unconfirmed claims a day old or more, the claims never
 * tried first and then the least recently tried, oldest first within each.
 * A pure read; the Gateway erases each listed claim in its own frozen scope through claimStorageDelete and
 * completeStorageErasure, and an erased claim leaves this list and the quota.
 */
export async function readUnconfirmedStorageClaims(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ now: instant, limit: z.number().int().min(1).max(50) }).parse(raw),
    db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(UNCONFIRMED)
    .bind(addMilliseconds(i.now, -UNCONFIRMED_AGE_MILLISECONDS), i.limit)
    .all<Row>();
  return result.results.map((r) => ({
    organizationId: String(r["organization_id"]),
    projectId: String(r["project_id"]),
    environmentId: String(r["environment_id"]),
    dataEnvironmentId: String(r["data_environment_id"]),
    transferId: String(r["transfer_id"]),
    objectKey: String(r["object_key"]),
    physicalObjectKey: String(r["physical_object_key"]),
    jurisdiction: r["jurisdiction"] as "eu" | "us",
    requestedAt: asDate(r["requested_at"]),
  }));
}

const attemptStamp = z.strictObject({ now: instant, transferIds: z.array(ulid).min(1).max(50) });
/**
 * Stamps the claims the platform sweep tried and did not erase, with the pass time the caller supplies, so the next pass
 * lists every claim not yet tried first. A claim the pass never reached is not stamped. The stamp never decides erasure.
 */
export async function markUnconfirmedStorageClaimAttempts(context: CatalogContext, raw: unknown) {
  const i = attemptStamp.parse(raw),
    db = (await context.router.routeShard(0)).db;
  await db
    .prepare(
      "INSERT INTO project_r2_upload_sweep_attempts(transfer_id,attempted_at) SELECT value,?1 FROM json_each(?2) WHERE true ON CONFLICT(transfer_id) DO UPDATE SET attempted_at=excluded.attempted_at",
    )
    .bind(i.now, JSON.stringify(i.transferIds))
    .run();
}
