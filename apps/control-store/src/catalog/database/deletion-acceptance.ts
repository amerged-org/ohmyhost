import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { organizationLiveGuard } from "../common.js";
import { recoveryCaptureHeldGuard } from "../recovery/fence.js";
import { stale } from "./run.js";

/**
 * The deletion-side acceptance guards, PURE and composed into the ONE D1 batch of a future deletion or data-change
 * acceptance (the cleanup lane writes the intent, the cleanup run and the frozen inventory rows in that same batch).
 * There is no preflight RPC: every statement is a batch guard, so a recovery capture that starts, or a PGCF target
 * that activates, after the acceptance read its snapshot aborts the whole batch with `precondition_changed`.
 *
 * Splice the returned statements BEFORE the acceptance writes:
 * 1. the organization is live (its bucket fence is not moving),
 * 2. no recovery capture holds the project at `now` (the shard form of `allowDeletionDuringRecovery`),
 * 3. the inventory the acceptance freezes is COMPLETE for the database provider: every ACTIVE PGCF target of the
 *    project is among `databaseIds`, and every listed id is a PGCF target of this very project (never a foreign one).
 *
 * Only the database part of the inventory exists in this lane; the other providers (Worker, R2, gateway, DNS, mail)
 * belong to the cleanup lane and must add their own completeness guards to the same batch. Until that lane exists a
 * deletion is NOT end-to-end accepted by this module: it supplies the guards, not the acceptance.
 */
export function deletionAcceptanceGuards(
  db: D1Database,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly now: string;
    readonly databaseIds: readonly string[];
  },
  executionClock = true,
): D1PreparedStatement[] {
  const ids = JSON.stringify([...new Set(input.databaseIds)].sort());
  const scope = [input.organizationId, input.projectId, ids];
  return [
    organizationLiveGuard(db, input.organizationId),
    recoveryCaptureHeldGuard(db, input, input.now, executionClock),
    stale(
      db,
      `EXISTS (SELECT 1 FROM database_provider_target_heads h
         JOIN database_provider_target_revisions r ON r.organization_id = h.organization_id AND r.project_id = h.project_id
          AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
        WHERE h.organization_id = ?1 AND h.project_id = ?2 AND h.state = 'active' AND r.provider = 'pgcf'
          AND r.database_id NOT IN (SELECT value FROM json_each(?3)))`,
      scope,
    ),
    stale(
      db,
      `EXISTS (SELECT 1 FROM json_each(?3) listed WHERE NOT EXISTS (SELECT 1 FROM database_provider_target_revisions r
         WHERE r.organization_id = ?1 AND r.project_id = ?2 AND r.provider = 'pgcf' AND r.database_id = listed.value))`,
      scope,
    ),
  ];
}
