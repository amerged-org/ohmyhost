import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { newUlid } from "../common.js";

/** An open customer database access, as the membership commands read it to decide which accesses an event ends. */
export interface OpenDatabaseAccessRow {
  readonly access_id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly principal_id: string;
  readonly mode: string;
  readonly environment: string;
  readonly expires_at: string;
}

/** Every open access of the Core, or of one organization or principal when the caller appends a filter. */
export const OPEN_DATABASE_ACCESS_SELECT = `SELECT access_id, organization_id, project_id, principal_id, mode, environment, expires_at
  FROM project_database_access WHERE revoked_at IS NULL`;

/**
 * Revokes open database accesses inside the caller's batch, one DatabaseAccessRevoked audit event each (the same shape
 * as `revokeStatements`, with the platform as actor). Membership, barrier and terminal user events end the access with
 * reason `principal` and name the event in `revokedBy`; the access sweep then drops the login roles. A row that is not
 * open any more fails the batch with precondition_changed, so the caller reads and decides again.
 */
export function revokeOpenDatabaseAccessStatements(
  db: D1Database,
  rows: readonly OpenDatabaseAccessRow[],
  revokedAt: string,
  revokedBy: string,
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const entries = JSON.stringify(
    rows.map((row) => [
      row.access_id,
      row.organization_id,
      row.project_id,
      newUlid(),
      row.mode,
      row.environment,
      row.expires_at,
    ]),
  );
  const ids = "SELECT json_extract(value, '$[0]') FROM json_each(?1)";
  return [
    guard(
      db,
      "precondition_changed",
      `(SELECT count(*) FROM project_database_access WHERE revoked_at IS NULL AND access_id IN(${ids})) <> ?2`,
      [entries, rows.length],
    ),
    db
      .prepare(
        `UPDATE project_database_access SET revoked_at = max(?2, issued_at), revoked_by = ?3, revocation_reason = 'principal'
         WHERE revoked_at IS NULL AND access_id IN(${ids})`,
      )
      .bind(entries, revokedAt, revokedBy),
    db
      .prepare(
        `INSERT INTO audit_events(organization_id, audit_event_id, project_id, operation_id, event_type, actor_type, actor_id, payload, occurred_at, billing_epoch_id)
         SELECT json_extract(j.value, '$[1]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[2]'), NULL,
           'DatabaseAccessRevoked', 'platform', ?3,
           json_object('mode', json_extract(j.value, '$[4]'), 'environment', json_extract(j.value, '$[5]'),
             'expires_at', substr(json_extract(j.value, '$[6]'), 1, 23) || 'Z', 'revocation_reason', 'principal'),
           ?2, p.active_billing_epoch_id
         FROM json_each(?1) j JOIN projects p ON p.organization_id = json_extract(j.value, '$[1]') AND p.project_id = json_extract(j.value, '$[2]')`,
      )
      .bind(entries, revokedAt, revokedBy),
  ];
}
