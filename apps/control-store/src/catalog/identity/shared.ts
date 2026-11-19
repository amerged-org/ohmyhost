import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";
import { CommandConflictError } from "../../run-command.js";

/** A WorkOS identifier as the PostgreSQL boundary accepted it: trimmed, no whitespace, bounded (the D1 columns cap it at 128). */
export const boundedId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value && !/\s/u.test(value), "identifier is invalid");

export const workosUserId = z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u);
export const workosOrganizationId = z.string().regex(/^org_[A-Za-z0-9_]{1,124}$/u);
export const sessionId = z.string().regex(/^session_[A-Za-z0-9_]{1,120}$/u);

/** The exact JavaScript ISO form (`toISOString`), normalised to the stored microsecond form. */
export const exactInstant = z
  .string()
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, "timestamp must be an exact ISO-8601 UTC instant")
  .transform(storedTimestamp);

export const hex256 = z.string().regex(/^[0-9a-f]{64}$/u);

export function bytesToHex(value: unknown): string {
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : Uint8Array.from(value as number[]);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface DirectoryOrganization {
  readonly organization_id: string;
  readonly workos_organization_id: string;
  readonly state: "active" | "suspended" | "deleted";
  readonly bucket: number;
}

/** The directory mapping of a WorkOS organization, the route to its shard; null while unmapped. */
export async function directoryOrganizationByWorkosId(
  directory: D1Database,
  workosOrganization: string,
): Promise<DirectoryOrganization | null> {
  return directory
    .prepare(
      "SELECT organization_id, workos_organization_id, state, bucket FROM org_directory WHERE workos_organization_id = ?",
    )
    .bind(workosOrganization)
    .first<DirectoryOrganization>();
}

export function identityConflict(code: string, message: string = code): CommandConflictError {
  return new CommandConflictError(code, message);
}

/** A ULID-shaped identifier derived from a seed: replaying the same command derives the same id. */
export async function derivedUlid(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let id = alphabet[(digest[0] as number) % 8] as string;
  for (let index = 1; index < 26; index += 1) {
    id += alphabet[(digest[index] as number) % 32] as string;
  }
  return id;
}

/** A UUID-shaped (36 character) identifier derived from a seed, for MCP grants whose column is a UUID. */
export async function derivedUuid(seed: string): Promise<string> {
  const hex = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(
      0,
      16,
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A change detector for what one identity command reads in a shard for one organization (`?1`), constant in
 * size however many members the organization has (a listing would hit SQLite's string limit). It is exact
 * because every write to these tables moves one of its terms in one direction only:
 *  - organization: `mapping_revision` bumps on every state change, `snapshot_fetched_at` only grows;
 *  - memberships: rows are never deleted and every update bumps `mapping_revision`, so (count, sum of revisions) grows;
 *  - grants: rows are never deleted and only gain `revoked_at`, so (count, revoked count) grows;
 *  - barriers: rows are never deleted, a reopen strictly advances `event_created_at` (the sum of the instants
 *    in microseconds grows) and a reconciliation only adds to the reconciled count.
 * The read batch stores it; the write batch aborts with `precondition_changed` when it differs, so a
 * concurrent change makes the command read and decide again.
 */
export const IDENTITY_FINGERPRINT_EXPR = `
  COALESCE((SELECT mapping_revision || ':' || state || ':' || snapshot_fetched_at FROM organizations WHERE organization_id = ?1), 'none')
  || '|' || (SELECT count(*) || ':' || COALESCE(sum(mapping_revision), 0) FROM organization_memberships WHERE organization_id = ?1)
  || '|' || (SELECT count(*) || ':' || count(revoked_at) FROM local_authorization_grants WHERE organization_id = ?1)
  || '|' || (SELECT count(*) || ':' || count(reconciled_at) || ':' || COALESCE(sum(CAST(strftime('%s', event_created_at) AS INTEGER) * 1000000 + CAST(substr(event_created_at, 21, 6) AS INTEGER)), 0) FROM workos_membership_sync_barriers WHERE organization_id = ?1)`;

/** Splits a list into chunks that each travel as ONE JSON parameter of one statement (far below D1's string limit). */
export const JSON_CHUNK = 500;

export function chunked<Item>(items: readonly Item[], size: number = JSON_CHUNK): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
