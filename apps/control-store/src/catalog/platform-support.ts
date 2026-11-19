import { z } from "zod";

import type { D1Database } from "../d1-types.js";
import type { AuthorityRouter } from "../router.js";
import { CommandConflictError } from "../run-command.js";
import { storedTimestamp } from "../timestamps.js";

/**
 * What every platform command (contexts H to L) needs: the authority router and the Directory tables, which live in the
 * same shared core database as every tenant table (`directory` and a routed `db` are one authority).
 */
export interface PlatformContext {
  readonly directory: D1Database;
  readonly router: AuthorityRouter;
}

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
export const ulid = z.string().regex(ULID_PATTERN);
/** An ISO-8601 UTC instant; stored with microseconds. */
export const instant = z.string().transform(storedTimestamp);
export const sha256 = z.instanceof(Uint8Array).refine((value) => value.byteLength === 32, {
  message: "must be 32 bytes",
});
export const principal = z.string().min(1).max(256);
export const idempotencyKey = z.string().min(1).max(128);
export const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const handle = z
  .string()
  .max(59)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u);

/** Rows of a BLOB column come back from D1 as number arrays. */
export function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError("expected a BLOB value");
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** `2026-10-28T10:00:00.123456Z` to the JavaScript form `2026-10-28T10:00:00.123Z`. */
export function isoOf(stored: string): string {
  return `${stored.slice(0, 23)}Z`;
}

export function isoOrNull(stored: unknown): string | null {
  return typeof stored === "string" ? isoOf(stored) : null;
}

export function reject(code: string, message: string): { readonly reject: CommandConflictError } {
  return { reject: new CommandConflictError(code, message) };
}

export async function shardOfOrganization(
  context: PlatformContext,
  organizationId: string,
): Promise<D1Database> {
  return (await context.router.routeOrganization(organizationId)).db;
}

/**
 * The project is active, owned by the organization, has an open billing epoch and the environment exists:
 * the shard form of `project_ownerships JOIN billing_epochs JOIN environments`. Usable inside EXISTS(...).
 */
export const ACTIVE_SCOPE_SQL = `SELECT 1 FROM projects p
  JOIN billing_epochs be ON be.organization_id = p.organization_id AND be.billing_epoch_id = p.active_billing_epoch_id AND be.project_id = p.project_id AND be.ended_at IS NULL
  JOIN environments e ON e.organization_id = p.organization_id AND e.project_id = p.project_id AND e.environment_id = ?
 WHERE p.organization_id = ? AND p.project_id = ? AND p.owner_state = 'active'`;

export function activeScopeParams(
  organizationId: string,
  projectId: string,
  environmentId: string,
): string[] {
  return [environmentId, organizationId, projectId];
}

/** An active project (lifecycle and ownership), the guard behind most project-scoped writes. */
export const ACTIVE_PROJECT_SQL = `SELECT 1 FROM projects p
 WHERE p.organization_id = ? AND p.project_id = ? AND p.owner_state = 'active' AND p.lifecycle_state = 'active'`;

/** The provider mutation claim is current: its operation is queued or running and the project has not left the accepted lifecycle. */
export const PROVIDER_CLAIM_SQL = `SELECT 1 FROM product_provider_mutation_claims c
  JOIN operations o ON o.organization_id = c.organization_id AND o.operation_id = c.operation_id
  JOIN projects p ON p.organization_id = c.organization_id AND p.project_id = c.project_id
  JOIN environments e ON e.organization_id = c.organization_id AND e.project_id = c.project_id AND e.environment_id = c.environment_id
 WHERE c.claim_id = ? AND c.organization_id = ? AND c.project_id = ? AND c.environment_id = ? AND c.operation_id = ?
   AND o.state IN ('queued', 'running') AND p.owner_state = 'active' AND p.lifecycle_state = 'active'
   AND p.lifecycle_version = c.accepted_lifecycle_version`;

export function providerClaimParams(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
}): string[] {
  return [
    scope.claimId,
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    scope.operationId,
  ];
}

/** One consistent snapshot: the SELECTs of a command run as one D1 batch, which is one transaction. */
export async function readSnapshot(
  db: D1Database,
  queries: readonly (readonly [sql: string, ...params: unknown[]])[],
): Promise<Record<string, unknown>[][]> {
  const results = await db.batch(
    queries.map(([sql, ...params]) => db.prepare(sql).bind(...params)),
  );
  return results.map((result) => result.results);
}
