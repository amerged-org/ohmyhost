import { z } from "zod";
import type { ProjectDatabaseAccessPage } from "@ohmyhost/contracts/database-access";
import { instant, publicTimestamp, ulid, type CatalogContext } from "../common.js";

const query = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environment: z.enum(["dev", "prod"]).optional(),
  now: instant,
});
interface AccessRow {
  access_id: string;
  environment: "dev" | "prod";
  mode: "read" | "write";
  role_name: string;
  origin_host: string;
  label: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: "principal" | "expired" | "budget" | "creation_failed" | "data_change" | null;
  database_id: string;
}

/** Original122 listing: exact organization/project, optional logical environment and newest50 PGCF accesses; stored Neon-era rows stay inert history. No provider call or credential. */
export async function readProjectDatabaseAccessHistory(
  context: CatalogContext,
  raw: unknown,
): Promise<ProjectDatabaseAccessPage> {
  const input = query.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const rows = await db
    .prepare(
      `SELECT access_id,environment,mode,role_name,origin_host,label,database_id,issued_at,expires_at,revoked_at,revocation_reason
    FROM project_database_access WHERE provider='pgcf' AND organization_id=?1 AND project_id=?2 AND(?3 IS NULL OR environment=?3)
    ORDER BY issued_at DESC,access_id DESC LIMIT 50`,
    )
    .bind(input.organizationId, input.projectId, input.environment ?? null)
    .all<AccessRow>();
  return {
    items: rows.results.map((row) => ({
      access_id: row.access_id,
      environment: row.environment,
      mode: row.mode,
      role_name: row.role_name,
      host: row.origin_host,
      provider: "pgcf" as const,
      transport: "wss" as const,
      websocket_url: `wss://${row.origin_host}/`,
      database: row.database_id,
      label: row.label,
      // Source public projection uses Date#getTime, hence millisecond resolution for expiry only.
      state:
        row.revoked_at !== null
          ? "revoked"
          : Date.parse(row.expires_at) <= Date.parse(input.now)
            ? "expired"
            : "active",
      issued_at: publicTimestamp(row.issued_at),
      expires_at: publicTimestamp(row.expires_at),
      revoked_at: row.revoked_at === null ? null : publicTimestamp(row.revoked_at),
      revocation_reason: row.revocation_reason,
    })),
  };
}
