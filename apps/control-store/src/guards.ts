import type { D1Database, D1PreparedStatement } from "./d1-types.js";

/**
 * Every code that can abort a batch. `guard_fail` carries one named CHECK per code, so a violated guard
 * surfaces as `CHECK constraint failed: guard_<code>`. Adding a code needs a migration that recreates the
 * (always empty) table; the migration test compares the newest definition with this list.
 */
export const GUARD_CODES = [
  "row_version_conflict",
  "claim_lost",
  "operation_conflict",
  "owner_changed",
  "insufficient_credits",
  "wallet_version_conflict",
  "source_head_conflict",
  "scope_inactive",
  "consent_changed",
  "organization_inactive",
  "attribution_conflict",
  "environment_set_invalid",
  "bucket_fenced",
  // Platform contexts H to L: a fact the decision read no longer holds, so the snapshot is stale.
  "precondition_changed",
  // AI gateway: the organization already holds the unresolved calls its cap allows, so the call is refused unreserved.
  "ai_open_calls_exceeded",
] as const;

export type GuardCode = (typeof GUARD_CODES)[number];

/** The batch dies with `guard_<code>` when the SQL condition `violation` holds; nothing of it persists. */
export function guard(
  db: D1Database,
  code: GuardCode,
  violation: string,
  params: readonly unknown[] = [],
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO guard_fail(code) SELECT '${code}' WHERE ${violation}`)
    .bind(...params);
}

export type Failure =
  | { readonly kind: "guard"; readonly code: string }
  | { readonly kind: "unique"; readonly table: string; readonly columns: readonly string[] }
  | { readonly kind: "transient" }
  | { readonly kind: "other" };

/** Classifies a rejected D1 call by its message, which is all D1 exposes. */
export function classifyFailure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const guarded = /CHECK constraint failed: guard_([a-z_]+)/u.exec(message);
  if (guarded?.[1] !== undefined) return { kind: "guard", code: guarded[1] };
  const unique = /UNIQUE constraint failed: ([^:]+)/u.exec(message);
  if (unique?.[1] !== undefined) {
    const columns = unique[1].split(",").map((column) => column.trim());
    return { kind: "unique", table: (columns[0] ?? "").split(".")[0] ?? "", columns };
  }
  // D1 timeouts and isolate memory or CPU resets end a batch that may already have committed: transient, so the
  // command is answered from its log instead of surfacing the raw error (CORE-62). A bare "was reset" is too loose:
  // it is anchored to the isolate, Durable Object or worker that was reset, or to the exact CPU limit sentence the
  // platform reports without a subject.
  if (
    /Network connection lost|caused object to be reset|(isolate|Durable Object|worker)[^.]*was reset|exceeded its CPU time limit and was reset|reset because its code was updated/u.test(
      message,
    )
  ) {
    return { kind: "transient" };
  }
  return { kind: "other" };
}
