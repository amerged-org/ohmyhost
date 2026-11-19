import { z } from "zod";

import { instant, type CatalogContext } from "../common.js";

const purgeInput = z.strictObject({
  before: instant,
  limit: z.number().int().min(1).max(1000),
});

/**
 * Retention of the directory's handoff routes: a route whose handoff expired before the cutoff goes. The
 * shard row has its own purge (`purgeMcpHandoffs`, expired or consumed); a route that outlives its row only
 * answers `null` from `findMcpHandoff`, and a route can never be purged while its handoff can still be
 * consumed (consumption needs `expires_at` in the future). One bounded chunk by primary key, so two
 * sweepers deleting the same chunk delete it once.
 */
export async function purgeMcpHandoffRoutes(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = purgeInput.parse(rawInput);
  const result = await context.directory
    .prepare(
      `DELETE FROM mcp_handoff_routes WHERE request_hash IN
         (SELECT request_hash FROM mcp_handoff_routes WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2)`,
    )
    .bind(input.before, input.limit)
    .run();
  return result.meta.changes;
}
