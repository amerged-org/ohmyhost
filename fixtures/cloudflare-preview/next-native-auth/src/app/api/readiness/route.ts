import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
} from "@ohmyhost/customer-runtime/database";

export const dynamic = "force-dynamic";
/** Fixture-only readiness: proves the real DB binding without exposing any business or Auth data. */
export async function GET() {
  const { env } = await getCloudflareContext({ async: true });
  const db = createPrivateDatabaseClient(
    (env as unknown as { OHMYHOST_DATABASE: CustomerDatabaseBinding }).OHMYHOST_DATABASE,
  );
  const result = await db.query({ text: "SELECT 1 AS ready", values: [] });
  if (result.rows.length !== 1 || result.rows[0]?.ready !== 1)
    return Response.json(
      { ready: false },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  return Response.json({ ready: true }, { headers: { "cache-control": "no-store" } });
}
