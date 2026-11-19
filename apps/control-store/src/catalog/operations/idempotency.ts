import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import {
  addMilliseconds,
  conflict,
  hexBytes,
  instant,
  notFencedOrganization,
  parseJson,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";

const REPLAY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface IdempotencyKey {
  readonly organizationId: string;
  readonly principalId: string;
  readonly httpMethod: string;
  readonly routeTemplate: string;
  readonly idempotencyKey: string;
}

export interface IdempotencyResponse {
  readonly operationId: string;
  readonly httpStatus: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The receipt of an accepted request, inserted complete in the same batch as its effect: there is no
 * half-written record to complete later. A duplicate key aborts the whole batch.
 */
export function idempotencyRecordStatement(
  db: D1Database,
  key: IdempotencyKey,
  request: { readonly digestHex: string; readonly requestId: string },
  response: IdempotencyResponse,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO api_idempotency_records(organization_id, principal_id, http_method, route_template, idempotency_key, canonical_request_sha256, canonicalization_version, request_id, operation_id, http_status, response_headers, response_body, created_at, completed_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'rfc8785-v1', ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)",
    )
    .bind(
      key.organizationId,
      key.principalId,
      key.httpMethod,
      key.routeTemplate,
      key.idempotencyKey,
      hexBytes(request.digestHex),
      request.requestId,
      response.operationId,
      response.httpStatus,
      JSON.stringify(response.headers),
      JSON.stringify(response.body),
      now,
      addMilliseconds(now, REPLAY_WINDOW_MILLISECONDS),
    );
}

export interface StoredIdempotencyRecord {
  readonly digestHex: string;
  readonly requestId: string;
  readonly operationId: string | null;
  readonly httpStatus: number;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export function readIdempotencyRecordStatement(
  db: D1Database,
  key: IdempotencyKey,
): D1PreparedStatement {
  return db
    .prepare(
      "SELECT lower(hex(canonical_request_sha256)) AS digest, request_id, operation_id, http_status, response_headers, response_body FROM api_idempotency_records WHERE organization_id = ?1 AND principal_id = ?2 AND http_method = ?3 AND route_template = ?4 AND idempotency_key = ?5",
    )
    .bind(
      key.organizationId,
      key.principalId,
      key.httpMethod,
      key.routeTemplate,
      key.idempotencyKey,
    );
}

export function storedIdempotencyRecord(row: unknown): StoredIdempotencyRecord | null {
  if (row === undefined || row === null) return null;
  const value = row as {
    digest: string;
    request_id: string;
    operation_id: string | null;
    http_status: number;
    response_headers: string;
    response_body: string;
  };
  return {
    digestHex: value.digest,
    requestId: value.request_id,
    operationId: value.operation_id,
    httpStatus: value.http_status,
    headers: parseJson<Record<string, string>>(value.response_headers) ?? {},
    body: parseJson<Record<string, unknown>>(value.response_body) ?? {},
  };
}

export const readStoredIdempotencyResponseInput = z.strictObject({
  organizationId: ulid,
  principalId: z.string().min(1),
  httpMethod: z.string().min(1),
  routeTemplate: z.string().startsWith("/v1/"),
  idempotencyKey: z.string().min(1).max(255),
});

export interface StoredHttpResponse {
  readonly httpStatus: number;
  readonly responseHeaders: { readonly Location: string };
  readonly responseBody: Readonly<Record<string, unknown>>;
}

/** `readStoredIdempotencyHttpResponse`: the stored 2xx representation of a completed request, or null. */
export async function readStoredIdempotencyResponse(
  context: CatalogContext,
  rawInput: unknown,
): Promise<StoredHttpResponse | null> {
  const input = readStoredIdempotencyResponseInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const record = storedIdempotencyRecord(
    await readIdempotencyRecordStatement(shard.db, input).first(),
  );
  if (record === null) return null;
  const location = record.headers["Location"];
  if (typeof location !== "string" || !Number.isInteger(record.httpStatus)) {
    throw conflict(
      "idempotency_record_invalid",
      "Stored idempotency HTTP representation is invalid",
    );
  }
  return {
    httpStatus: record.httpStatus,
    responseHeaders: { Location: location },
    responseBody: record.body,
  };
}

export const purgeExpiredIdempotencyRecordsInput = z.strictObject({
  shardId: z.number().int().min(0).max(1023),
  now: instant,
  limit: z.number().int().min(1).max(1000),
});

/**
 * `deleteExpiredIdempotencyRecords`: one chunk of expired receipts, oldest first. The statement deletes by
 * primary key from the expiry index, never locks anything, and two sweepers deleting the same chunk simply
 * delete it once. Returns the number removed; a full chunk means more may be due.
 */
export async function purgeExpiredIdempotencyRecords(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = purgeExpiredIdempotencyRecordsInput.parse(rawInput);
  const shard = await context.router.routeShard(input.shardId);
  const result = await shard.db
    .prepare(
      `DELETE FROM api_idempotency_records
       WHERE (organization_id, principal_id, http_method, route_template, idempotency_key) IN (
         SELECT organization_id, principal_id, http_method, route_template, idempotency_key
         FROM api_idempotency_records WHERE expires_at <= ?1
           AND ${notFencedOrganization("api_idempotency_records.organization_id")}
         ORDER BY expires_at LIMIT ?2)`,
    )
    .bind(input.now, input.limit)
    .run();
  return result.meta.changes;
}
