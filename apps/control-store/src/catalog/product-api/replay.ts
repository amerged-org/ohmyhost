import { z } from "zod";
import { conflict, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { bytes, hex } from "../provisioning/context-values.js";
import { acceptedOperationOf } from "./accepted-operation.js";
const replay = z.strictObject({
  organizationId: ulid,
  principalId: z.string().min(1),
  httpMethod: z.enum(["POST", "PUT", "DELETE"]),
  routeTemplate: z.string().startsWith("/v1/"),
  idempotencyKey: z.string().min(1),
  canonicalRequestDigest: z
    .unknown()
    .transform(bytes)
    .refine((v) => v.byteLength === 32),
});
/** Exact original preflight replay lookup. An incomplete or differently-digested receipt is a conflict. */
export async function readApiProductReplay(context: CatalogContext, raw: unknown) {
  const i = replay.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const [receipt, operation, history] = await db.batch([
    db
      .prepare(
        "SELECT lower(hex(canonical_request_sha256)) digest,operation_id FROM api_idempotency_records WHERE organization_id=?1 AND principal_id=?2 AND http_method=?3 AND route_template=?4 AND idempotency_key=?5",
      )
      .bind(i.organizationId, i.principalId, i.httpMethod, i.routeTemplate, i.idempotencyKey),
    db
      .prepare(
        "SELECT operation.* FROM operations operation JOIN api_idempotency_records receipt ON receipt.organization_id=operation.organization_id AND receipt.operation_id=operation.operation_id WHERE receipt.organization_id=?1 AND receipt.principal_id=?2 AND receipt.http_method=?3 AND receipt.route_template=?4 AND receipt.idempotency_key=?5",
      )
      .bind(i.organizationId, i.principalId, i.httpMethod, i.routeTemplate, i.idempotencyKey),
    db
      .prepare(
        "SELECT event.* FROM operation_events event JOIN api_idempotency_records receipt ON receipt.organization_id=event.organization_id AND receipt.operation_id=event.operation_id WHERE receipt.organization_id=?1 AND receipt.principal_id=?2 AND receipt.http_method=?3 AND receipt.route_template=?4 AND receipt.idempotency_key=?5 ORDER BY event.revision",
      )
      .bind(i.organizationId, i.principalId, i.httpMethod, i.routeTemplate, i.idempotencyKey),
  ]);
  const r = receipt?.results[0];
  if (r === undefined) return null;
  if (r["digest"] !== hex(i.canonicalRequestDigest) || r["operation_id"] === null)
    throw conflict("idempotency_key_reused");
  const op = operation?.results[0];
  if (op === undefined || !history?.results.length)
    throw new Error("Accepted operation projection is unavailable");
  return acceptedOperationOf(op, history.results);
}
