import { z } from "zod";
import { guard } from "../../guards.js";
import { ulid, type CatalogContext } from "../common.js";
import {
  runStorage,
  scopeInput,
  key,
  idempotency,
  digestInput,
  clock,
  hex,
  dataAt,
  blocked,
  StorageGatewayConflictError,
  StorageErasureConflictError,
  asDate,
} from "./common.js";
const claim = z.strictObject({
  deletionId: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  idempotencyKey: idempotency,
  requestSha256: digestInput,
  objectKey: key,
  requestedAt: clock,
});
const ROWS = `WITH wanted AS(SELECT json_extract(value,'$.objectKey') object_key,json_extract(value,'$.idempotencyKey') idempotency_key FROM json_each(?4)) SELECT r.*,lower(hex(r.request_sha256)) reservation_digest,o.transfer_id completed_transfer_id,b.jurisdiction,q.deletion_id,q.object_key delete_object_key,q.idempotency_key delete_idempotency,lower(hex(q.request_sha256)) delete_digest,d.deletion_id completed_deletion_id,d.deleted_at completed_at,EXISTS(SELECT 1 FROM project_r2_erasure_barriers barrier WHERE barrier.transfer_id=r.transfer_id AND barrier.environment_id=r.environment_id AND barrier.data_environment_id=r.data_environment_id AND barrier.physical_object_key=r.physical_object_key) payload_erased FROM project_r2_upload_reservations r JOIN project_r2_bucket_receipts b USING(organization_id,project_id,environment_id) JOIN wanted ON wanted.object_key=r.object_key LEFT JOIN project_r2_objects o USING(transfer_id) LEFT JOIN project_r2_delete_requests q ON q.organization_id=r.organization_id AND q.project_id=r.project_id AND q.data_environment_id=r.data_environment_id AND q.request_environment_id=?3 AND q.idempotency_key=wanted.idempotency_key LEFT JOIN project_r2_delete_receipts d ON d.deletion_id=q.deletion_id JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE r.organization_id=?1 AND r.project_id=?2 AND r.data_environment_id=${dataAt("?1", "?2", "?3")} AND NOT ${blocked("?1", "?2", "?3")}`;
const SNAP = `SELECT json_group_array(json_array(transfer_id,object_key,environment_id,data_environment_id,physical_object_key,deletion_id,delete_object_key,delete_idempotency,delete_digest,completed_deletion_id,completed_at,payload_erased)) snapshot FROM(${ROWS})`;
async function claimDeletes(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ scope: scopeInput, inputs: z.array(claim).min(1).max(4000) })
      .parse(raw),
    s = i.scope;
  if (
    i.inputs.some(
      (q) =>
        q.organizationId !== s.organizationId ||
        q.projectId !== s.projectId ||
        q.environmentId !== s.environmentId,
    ) ||
    new Set(i.inputs.map((q) => q.objectKey)).size !== i.inputs.length ||
    new Set(i.inputs.map((q) => q.idempotencyKey)).size !== i.inputs.length
  )
    throw new StorageGatewayConflictError();
  const chunks: (typeof i.inputs)[] = [];
  for (let n = 0; n < i.inputs.length; n += 128) chunks.push(i.inputs.slice(n, n + 128));
  return runStorage(
    context,
    s,
    "storage.claimDeletes",
    i,
    async (db) => {
      const statements = chunks.flatMap((c) => {
        const p = [
          s.organizationId,
          s.projectId,
          s.environmentId,
          JSON.stringify(
            c.map((q) => ({ objectKey: q.objectKey, idempotencyKey: q.idempotencyKey })),
          ),
        ];
        return [db.prepare(ROWS).bind(...p), db.prepare(SNAP).bind(...p)];
      });
      return db.batch(statements);
    },
    (db, snapshot) => {
      const rows = snapshot.flatMap((r, n) => (n % 2 === 0 ? r.results : [])),
        byKey = new Map(rows.map((r) => [String(r["object_key"]), r]));
      if (byKey.size !== rows.length)
        return { reject: new StorageGatewayConflictError("storage_object_conflict") };
      const insert: unknown[][] = [];
      const outcomes = i.inputs.map((q) => {
        const r = byKey.get(q.objectKey);
        if (!r) return { state: "not_found" as const, objectKey: q.objectKey, replayed: false };
        if (
          r["deletion_id"] != null &&
          (r["delete_object_key"] !== q.objectKey ||
            r["delete_idempotency"] !== q.idempotencyKey ||
            r["delete_digest"] !== hex(q.requestSha256))
        )
          throw new StorageGatewayConflictError();
        const deletionId = r["deletion_id"] == null ? q.deletionId : String(r["deletion_id"]);
        if (r["deletion_id"] == null)
          insert.push([
            deletionId,
            q.organizationId,
            q.projectId,
            r["environment_id"],
            q.idempotencyKey,
            hex(q.requestSha256),
            q.objectKey,
            q.requestedAt,
            q.environmentId,
            r["data_environment_id"],
            r["physical_object_key"],
          ]);
        return {
          state: r["completed_deletion_id"] != null ? ("completed" as const) : ("claimed" as const),
          replayed: r["deletion_id"] != null,
          objectKey: q.objectKey,
          deletionId,
          environmentId: String(r["environment_id"]),
          dataEnvironmentId: String(r["data_environment_id"]),
          physicalObjectKey: String(r["physical_object_key"]),
          jurisdiction: r["jurisdiction"] as "eu" | "us",
          expiresAt: asDate(r["expires_at"]),
          completedAt: r["completed_at"] == null ? null : asDate(r["completed_at"]),
          transferId: String(r["transfer_id"]),
          payloadErased: r["payload_erased"] === 1,
        };
      });
      const statements = chunks.map((c, n) =>
        guard(db, "precondition_changed", `(${SNAP}) IS NOT ?5`, [
          s.organizationId,
          s.projectId,
          s.environmentId,
          JSON.stringify(
            c.map((q) => ({ objectKey: q.objectKey, idempotencyKey: q.idempotencyKey })),
          ),
          snapshot[n * 2 + 1]?.results[0]?.["snapshot"],
        ]),
      );
      for (let n = 0; n < insert.length; n += 128)
        statements.push(
          db
            .prepare(
              "INSERT INTO project_r2_delete_requests(deletion_id,organization_id,project_id,environment_id,idempotency_key,request_sha256,object_key,requested_at,request_environment_id,data_environment_id,physical_object_key) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),unhex(json_extract(value,'$[5]')),json_extract(value,'$[6]'),json_extract(value,'$[7]'),json_extract(value,'$[8]'),json_extract(value,'$[9]'),json_extract(value,'$[10]') FROM json_each(?1)",
            )
            .bind(JSON.stringify(insert.slice(n, n + 128))),
        );
      return { statements, result: () => outcomes };
    },
    ["project_r2_delete_requests"],
  );
}
export async function claimStorageDeletes(context: CatalogContext, raw: unknown) {
  return (await claimDeletes(context, raw)).map(({ replayed, ...row }) => {
    void replayed;
    return row;
  });
}
export async function claimStorageDelete(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ scope: scopeInput, input: claim }).parse(raw);
  const result = (await claimDeletes(context, { scope: i.scope, inputs: [i.input] }))[0];
  if (!result || result.state === "not_found") throw new StorageGatewayConflictError();
  return {
    outcome:
      result.state === "completed"
        ? ("completed" as const)
        : result.replayed
          ? ("existing" as const)
          : ("claimed" as const),
    deletionId: result.deletionId,
    environmentId: result.environmentId,
    jurisdiction: result.jurisdiction,
    physicalObjectKey: result.physicalObjectKey,
    dataEnvironmentId: result.dataEnvironmentId,
    expiresAt: result.expiresAt,
    completedAt: result.completedAt,
    transferId: result.transferId,
    payloadErased: result.payloadErased,
  };
}
const proof = z.strictObject({
  deletionId: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  dataEnvironmentId: ulid,
  transferId: ulid,
  objectKey: key,
  physicalObjectKey: z
    .string()
    .refine(
      (v) =>
        new TextEncoder().encode(v).length <= 544 &&
        /^[A-Za-z0-9._/-]+$/u.test(v) &&
        v.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    ),
  markerSha256: digestInput,
  erasedAt: clock,
});
export type Erasure = z.output<typeof proof>;
export async function encodeErasures(inputs: unknown) {
  const proofs = z.array(proof).min(1).max(4000).parse(inputs);
  if (
    new Set(proofs.map((p) => p.deletionId)).size !== proofs.length ||
    new Set(proofs.map((p) => p.transferId)).size !== proofs.length
  )
    throw new StorageErasureConflictError();
  const encoded = [];
  for (const p of proofs) {
    const expected = hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            [
              "ohmyhost.r2-erasure/v1",
              p.organizationId,
              p.projectId,
              p.environmentId,
              p.dataEnvironmentId,
              p.transferId,
              p.physicalObjectKey,
            ].join("\n"),
          ),
        ),
      ),
    );
    if (expected !== hex(p.markerSha256)) throw new StorageErasureConflictError();
    encoded.push({
      deletion_id: p.deletionId,
      organization_id: p.organizationId,
      project_id: p.projectId,
      environment_id: p.environmentId,
      data_environment_id: p.dataEnvironmentId,
      transfer_id: p.transferId,
      object_key: p.objectKey,
      physical_object_key: p.physicalObjectKey,
      marker_sha256: expected,
      erased_at: p.erasedAt,
    });
  }
  return encoded;
}
export type EncodedErasure = Awaited<ReturnType<typeof encodeErasures>>[number];
const SOURCES = `SELECT wanted.key ordinal,r.transfer_id,q.deletion_id,r.organization_id,r.project_id,r.environment_id,r.data_environment_id,r.object_key,r.physical_object_key,b.bucket_name,b.jurisdiction,json_extract(wanted.value,'$.marker_sha256') marker_sha256,json_extract(wanted.value,'$.erased_at') erased_at FROM json_each(?1) wanted JOIN project_r2_delete_requests q ON q.deletion_id=json_extract(wanted.value,'$.deletion_id') AND q.organization_id=json_extract(wanted.value,'$.organization_id') AND q.project_id=json_extract(wanted.value,'$.project_id') AND q.environment_id=json_extract(wanted.value,'$.environment_id') AND q.data_environment_id=json_extract(wanted.value,'$.data_environment_id') AND q.object_key=json_extract(wanted.value,'$.object_key') AND q.physical_object_key=json_extract(wanted.value,'$.physical_object_key') JOIN project_r2_upload_reservations r USING(organization_id,project_id,environment_id,data_environment_id,object_key,physical_object_key) JOIN project_r2_bucket_receipts b USING(organization_id,project_id,environment_id) LEFT JOIN project_r2_erasure_barriers barrier ON barrier.transfer_id=r.transfer_id LEFT JOIN project_r2_delete_receipts prior ON prior.deletion_id=q.deletion_id WHERE r.transfer_id=json_extract(wanted.value,'$.transfer_id') AND json_extract(wanted.value,'$.erased_at')>=q.requested_at AND json_extract(wanted.value,'$.erased_at')>=r.requested_at AND(barrier.transfer_id IS NULL OR(barrier.organization_id=r.organization_id AND barrier.project_id=r.project_id AND barrier.environment_id=r.environment_id AND barrier.data_environment_id=r.data_environment_id AND barrier.object_key=r.object_key AND barrier.physical_object_key=r.physical_object_key AND barrier.bucket_name=b.bucket_name AND barrier.jurisdiction=b.jurisdiction AND barrier.marker_sha256=unhex(json_extract(wanted.value,'$.marker_sha256')))) AND(prior.deletion_id IS NULL OR(prior.organization_id=r.organization_id AND prior.project_id=r.project_id AND prior.environment_id=r.environment_id AND prior.data_environment_id=r.data_environment_id AND prior.object_key=r.object_key AND prior.physical_object_key=r.physical_object_key))`;
/** Pure all-valid-first vector plan, used by current-user and DISTINCT retired-parent compounds. */
export function erasureStatements(
  db: import("../../d1-types.js").D1Database,
  encoded: readonly EncodedErasure[],
) {
  const chunks = [];
  for (let n = 0; n < encoded.length; n += 128) chunks.push(encoded.slice(n, n + 128));
  const statements = chunks.map((c) =>
    guard(db, "precondition_changed", `(SELECT count(*) FROM(${SOURCES}))<>?2`, [
      JSON.stringify(c),
      c.length,
    ]),
  );
  const barrierIndexes: number[] = [];
  for (const c of chunks) {
    barrierIndexes.push(statements.length);
    statements.push(
      db
        .prepare(
          `INSERT INTO project_r2_erasure_barriers(transfer_id,deletion_id,organization_id,project_id,environment_id,data_environment_id,object_key,physical_object_key,bucket_name,jurisdiction,marker_sha256,erased_at) SELECT transfer_id,deletion_id,organization_id,project_id,environment_id,data_environment_id,object_key,physical_object_key,bucket_name,jurisdiction,unhex(marker_sha256),erased_at FROM(${SOURCES}) WHERE true ON CONFLICT(transfer_id) DO NOTHING RETURNING transfer_id`,
        )
        .bind(JSON.stringify(c)),
      db
        .prepare(
          `INSERT INTO project_r2_delete_receipts(deletion_id,organization_id,project_id,environment_id,object_key,deleted_at,data_environment_id,physical_object_key) SELECT deletion_id,organization_id,project_id,environment_id,object_key,erased_at,data_environment_id,physical_object_key FROM(${SOURCES}) WHERE true ON CONFLICT(deletion_id) DO NOTHING`,
        )
        .bind(JSON.stringify(c)),
      // The erased claim leaves the platform sweep for good, so its attempt stamp goes in the same atomic batch.
      db
        .prepare(
          `DELETE FROM project_r2_upload_sweep_attempts WHERE transfer_id IN(SELECT transfer_id FROM(${SOURCES}))`,
        )
        .bind(JSON.stringify(c)),
    );
  }
  return {
    statements,
    result: (results: import("../../d1-types.js").D1Result[]) => {
      const inserted = new Set(
        barrierIndexes.flatMap(
          (n) => results[n]?.results.map((r) => String(r["transfer_id"])) ?? [],
        ),
      );
      return encoded.map((p) =>
        inserted.has(p.transfer_id) ? ("created" as const) : ("existing" as const),
      );
    },
  };
}
export async function completeStorageErasures(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ scope: scopeInput, inputs: z.unknown() }).parse(raw),
    encoded = await encodeErasures(i.inputs);
  if (
    encoded.some(
      (p) =>
        p.organization_id !== i.scope.organizationId ||
        p.project_id !== i.scope.projectId ||
        p.data_environment_id !== i.scope.dataEnvironmentId,
    )
  )
    throw new StorageErasureConflictError();
  return runStorage(
    context,
    i.scope,
    "storage.completeErasures",
    { ...i, inputs: encoded },
    async () => null,
    (db) => erasureStatements(db, encoded),
  );
}
export async function completeStorageErasure(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ scope: scopeInput, input: z.unknown() }).parse(raw),
    outcome = (await completeStorageErasures(context, { scope: i.scope, inputs: [i.input] }))[0];
  if (!outcome) throw new StorageErasureConflictError();
  return outcome;
}
