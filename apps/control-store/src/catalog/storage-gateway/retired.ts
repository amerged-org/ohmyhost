import { z } from "zod";
import type { D1Database, D1PreparedStatement, D1Result } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import { ulid, routeOrganization, type CatalogContext } from "../common.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "../provisioning/authority.js";
import { dataAt, clock, hex, asDate, StorageGatewayConflictError } from "./common.js";
import { encodeErasures, erasureStatements } from "./deletes.js";
const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  dataEnvironmentId: ulid,
  operationId: ulid,
  claimId: ulid,
});
type Scope = z.output<typeof scope>;
const AUTH = `SELECT 1 FROM product_provider_mutation_claims claim JOIN operations operation USING(organization_id,project_id,operation_id) JOIN product_command_intents intent USING(organization_id,project_id,operation_id) JOIN projects p ON p.organization_id=claim.organization_id AND p.project_id=claim.project_id AND p.owner_state='active' AND p.lifecycle_state='active' JOIN environments development ON development.organization_id=claim.organization_id AND development.project_id=claim.project_id AND development.name='dev' AND development.environment_id=?6 WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.operation_id=?3 AND claim.claim_id=?4 AND claim.event_type='ProjectDataChangeRequestedV1' AND intent.event_type=claim.event_type AND intent.data_change IN('reset_dev','share_prod_keeps_data') AND operation.state='running' AND claim.accepted_lifecycle_version=p.lifecycle_version AND NOT EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND ${dataAt("?1", "?2", "e.environment_id")}=?5) AND EXISTS(SELECT 1 FROM environment_data_assignments changed JOIN environment_data_assignments prior ON prior.organization_id=changed.organization_id AND prior.project_id=changed.project_id AND prior.environment_id=changed.environment_id AND prior.assignment_version=changed.assignment_version-1 WHERE changed.organization_id=?1 AND changed.project_id=?2 AND changed.environment_id=?6 AND changed.operation_id=?3 AND prior.data_environment_id=?5)`;
const params = (s: Scope) => [
  s.organizationId,
  s.projectId,
  s.operationId,
  s.claimId,
  s.dataEnvironmentId,
  s.environmentId,
];
async function authority(db: D1Database, s: Scope) {
  if (
    !(await db
      .prepare(AUTH)
      .bind(...params(s))
      .first())
  )
    throw new StorageGatewayConflictError();
  return readWorkflowDelegation(db, s);
}
const authGuards = (
  db: D1Database,
  s: Scope,
  proof: Awaited<ReturnType<typeof readWorkflowDelegation>>,
) => [
  ...workflowExecutionGuards(db, s, proof),
  guard(db, "precondition_changed", `NOT EXISTS(${AUTH})`, params(s)),
];
const digest = async (s: string) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const PAGE = `SELECT r.*,b.jurisdiction,o.transfer_id completed_transfer_id,barrier.transfer_id erased_transfer_id,lower(hex(barrier.marker_sha256)) erasure_marker_sha256,barrier.erased_at erasure_confirmed_at,q.deletion_id,lower(hex(q.request_sha256)) delete_digest,q.object_was_observed,d.deletion_id completed_deletion_id FROM project_r2_upload_reservations r JOIN project_r2_bucket_receipts b USING(organization_id,project_id,environment_id) LEFT JOIN project_r2_objects o USING(transfer_id) LEFT JOIN project_r2_erasure_barriers barrier ON barrier.transfer_id=r.transfer_id AND barrier.organization_id=r.organization_id AND barrier.project_id=r.project_id AND barrier.environment_id=r.environment_id AND barrier.data_environment_id=r.data_environment_id AND barrier.object_key=r.object_key AND barrier.physical_object_key=r.physical_object_key LEFT JOIN project_r2_delete_requests q ON q.organization_id=r.organization_id AND q.project_id=r.project_id AND q.environment_id=r.environment_id AND q.data_environment_id=r.data_environment_id AND q.object_key=r.object_key AND q.physical_object_key=r.physical_object_key AND q.request_environment_id=?4 AND q.idempotency_key='data-change:'||?5||':'||r.transfer_id LEFT JOIN project_r2_delete_receipts d ON d.deletion_id=q.deletion_id AND d.organization_id=q.organization_id AND d.project_id=q.project_id AND d.environment_id=q.environment_id AND d.data_environment_id=q.data_environment_id AND d.object_key=q.object_key AND d.physical_object_key=q.physical_object_key WHERE r.organization_id=?1 AND r.project_id=?2 AND r.data_environment_id=?3 AND r.transfer_id>?6 ORDER BY r.transfer_id LIMIT 128`;
/** Privileged retired-data inventory, never the current-user key/data guard and never a bounded-history shortcut. */
export async function readRetiredStorageInventory(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ limit: z.number().int().min(1).max(1000).optional() }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    proof = await authority(db, i),
    items = [];
  let after = "",
    maxExpiresAt: Date | null = null,
    deletedFiles = 0;
  for (;;) {
    const result = await db.batch([
      ...authGuards(db, i, proof),
      db
        .prepare(PAGE)
        .bind(
          i.organizationId,
          i.projectId,
          i.dataEnvironmentId,
          i.environmentId,
          i.operationId,
          after,
        ),
    ]);
    const rows = result.at(-1)?.results ?? [];
    for (const r of rows) {
      const erased = r["erased_transfer_id"] != null;
      if (!erased && (!maxExpiresAt || asDate(r["expires_at"]) > maxExpiresAt))
        maxExpiresAt = asDate(r["expires_at"]);
      const finished =
        erased &&
        r["completed_deletion_id"] != null &&
        r["delete_digest"] === (await digest(`${i.operationId}:${String(r["transfer_id"])}`));
      if (finished) {
        if (r["object_was_observed"] === 1) deletedFiles++;
      } else if (items.length < (i.limit ?? 1000))
        items.push({
          transferId: String(r["transfer_id"]),
          environmentId: String(r["environment_id"]),
          dataEnvironmentId: String(r["data_environment_id"]),
          objectKey: String(r["object_key"]),
          physicalObjectKey: String(r["physical_object_key"]),
          contentType: String(r["content_type"]),
          expectedBytes: Number(r["expected_bytes"]),
          requestedAt: asDate(r["requested_at"]),
          expiresAt: asDate(r["expires_at"]),
          completed: r["completed_transfer_id"] != null,
          jurisdiction: r["jurisdiction"] as "eu" | "us",
          ...(erased
            ? {
                erasureProof: {
                  markerSha256: String(r["erasure_marker_sha256"]),
                  erasedAt: asDate(r["erasure_confirmed_at"]).toISOString(),
                },
              }
            : {}),
        });
    }
    if (rows.length < 128) break;
    after = String(rows.at(-1)?.["transfer_id"]);
  }
  await db.batch(authGuards(db, i, proof));
  return { items, maxExpiresAt, deletedFiles };
}
const REQUESTS = `SELECT q.deletion_id,q.environment_id,q.data_environment_id,r.transfer_id,q.object_key,q.physical_object_key FROM json_each(?6) wanted JOIN project_r2_upload_reservations r ON r.transfer_id=json_extract(wanted.value,'$.transferId') AND r.organization_id=?1 AND r.project_id=?2 AND r.data_environment_id=?3 JOIN project_r2_delete_requests q ON q.organization_id=r.organization_id AND q.project_id=r.project_id AND q.environment_id=r.environment_id AND q.data_environment_id=r.data_environment_id AND q.object_key=r.object_key AND q.physical_object_key=r.physical_object_key AND q.request_environment_id=?4 AND q.idempotency_key='data-change:'||?5||':'||r.transfer_id AND q.request_sha256=unhex(json_extract(wanted.value,'$.requestDigest')) ORDER BY CAST(wanted.key AS INTEGER)`;
export interface RetiredDeletion {
  deletionId: string;
  environmentId: string;
  dataEnvironmentId: string;
  transferId: string;
  objectKey: string;
  physicalObjectKey: string;
}
export async function claimRetiredStorageDeletes(context: CatalogContext, raw: unknown) {
  const i = scope
      .extend({
        items: z
          .array(
            z.strictObject({ transferId: ulid, deletionId: ulid, objectObserved: z.boolean() }),
          )
          .min(1)
          .max(1000),
        requestedAt: clock,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (new Set(i.items.map((x) => x.transferId)).size !== i.items.length)
    throw new StorageGatewayConflictError();
  const wanted: {
    transferId: string;
    deletionId: string;
    objectObserved: boolean;
    requestDigest: string;
  }[] = [];
  for (const item of i.items)
    wanted.push({ ...item, requestDigest: await digest(`${i.operationId}:${item.transferId}`) });
  const chunks: (typeof wanted)[] = [];
  for (let n = 0; n < wanted.length; n += 128) chunks.push(wanted.slice(n, n + 128));
  const command: Command<Awaited<ReturnType<typeof readWorkflowDelegation>>, RetiredDeletion[]> = {
    name: "storage.claimRetiredDeletes",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_r2_delete_requests"],
    read: (r) => authority(r, i),
    decide(proof) {
      const statements: D1PreparedStatement[] = [...authGuards(db, i, proof)];
      for (const chunk of chunks)
        statements.push(
          guard(
            db,
            "precondition_changed",
            "(SELECT count(*) FROM project_r2_upload_reservations r JOIN json_each(?4) w ON r.transfer_id=json_extract(w.value,'$.transferId') WHERE r.organization_id=?1 AND r.project_id=?2 AND r.data_environment_id=?3)<>?5",
            [
              i.organizationId,
              i.projectId,
              i.dataEnvironmentId,
              JSON.stringify(chunk),
              chunk.length,
            ],
          ),
        );
      for (const chunk of chunks)
        statements.push(
          db
            .prepare(
              "INSERT INTO project_r2_delete_requests(deletion_id,organization_id,project_id,environment_id,idempotency_key,request_sha256,object_key,requested_at,request_environment_id,data_environment_id,physical_object_key,object_was_observed) SELECT json_extract(w.value,'$.deletionId'),r.organization_id,r.project_id,r.environment_id,'data-change:'||?4||':'||r.transfer_id,unhex(json_extract(w.value,'$.requestDigest')),r.object_key,?5,?6,r.data_environment_id,r.physical_object_key,json_extract(w.value,'$.objectObserved') FROM project_r2_upload_reservations r JOIN json_each(?7) w ON r.transfer_id=json_extract(w.value,'$.transferId') WHERE r.organization_id=?1 AND r.project_id=?2 AND r.data_environment_id=?3 ON CONFLICT DO NOTHING",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.dataEnvironmentId,
              i.operationId,
              i.requestedAt,
              i.environmentId,
              JSON.stringify(chunk),
            ),
        );
      const index = statements.length;
      for (const chunk of chunks) {
        const p = [
          i.organizationId,
          i.projectId,
          i.dataEnvironmentId,
          i.environmentId,
          i.operationId,
          JSON.stringify(chunk),
        ];
        statements.push(
          guard(db, "precondition_changed", `(SELECT count(*) FROM(${REQUESTS}))<>?7`, [
            ...p,
            chunk.length,
          ]),
          db.prepare(REQUESTS).bind(...p),
        );
      }
      return {
        statements,
        result: (results: D1Result[]) =>
          results
            .slice(index)
            .filter((_, n) => n % 2 === 1)
            .flatMap((r) =>
              r.results.map((r) => ({
                deletionId: String(r["deletion_id"]),
                environmentId: String(r["environment_id"]),
                dataEnvironmentId: String(r["data_environment_id"]),
                transferId: String(r["transfer_id"]),
                objectKey: String(r["object_key"]),
                physicalObjectKey: String(r["physical_object_key"]),
              })),
            ),
      };
    },
  };
  return runCommand(db, command);
}
export async function completeRetiredStorageDeletes(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ items: z.unknown() }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    encoded = await encodeErasures(i.items);
  if (
    encoded.some(
      (p) =>
        p.organization_id !== i.organizationId ||
        p.project_id !== i.projectId ||
        p.data_environment_id !== i.dataEnvironmentId,
    )
  )
    throw new StorageGatewayConflictError();
  const command: Command<Awaited<ReturnType<typeof readWorkflowDelegation>>, void> = {
    name: "storage.completeRetiredDeletes",
    input: { ...i, items: encoded },
    retryOn: ["precondition_changed"],
    read: (r) => authority(r, i),
    decide(proof) {
      const plan = erasureStatements(db, encoded),
        statements = [...authGuards(db, i, proof)];
      for (let n = 0; n < encoded.length; n += 128) {
        const chunk = encoded.slice(n, n + 128);
        statements.push(
          guard(
            db,
            "precondition_changed",
            "(SELECT count(*) FROM project_r2_delete_requests q JOIN json_each(?5) w ON q.deletion_id=json_extract(w.value,'$.deletion_id') WHERE q.organization_id=?1 AND q.project_id=?2 AND q.data_environment_id=?3 AND q.idempotency_key LIKE('data-change:'||?4||':%'))<>?6",
            [
              i.organizationId,
              i.projectId,
              i.dataEnvironmentId,
              i.operationId,
              JSON.stringify(chunk),
              chunk.length,
            ],
          ),
        );
      }
      return { statements: [...statements, ...plan.statements], result: () => undefined };
    },
  };
  await runCommand(db, command);
}
