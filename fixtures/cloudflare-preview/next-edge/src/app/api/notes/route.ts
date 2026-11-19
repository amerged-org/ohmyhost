import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
} from "@ohmyhost/customer-runtime/database";

export const dynamic = "force-dynamic";
async function database() {
  const { env } = await getCloudflareContext({ async: true });
  return createPrivateDatabaseClient(
    (env as unknown as { OHMYHOST_DATABASE: CustomerDatabaseBinding }).OHMYHOST_DATABASE,
  );
}
export async function GET() {
  const db = await database();
  const result = await db.query({
    text: "SELECT id, body FROM public.preview_notes ORDER BY id",
    values: [],
  });
  return Response.json({ notes: result.rows }, { headers: { "cache-control": "no-store" } });
}
async function change(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response("Forbidden", { status: 403 });
  const value = (await request.json().catch(() => null)) as { id?: unknown; body?: unknown } | null;
  if (!value || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id))
    return new Response("Invalid id", { status: 400 });
  const db = await database();
  if (request.method === "DELETE") {
    const result = await db.query({
      text: "DELETE FROM public.preview_notes WHERE id = $1 RETURNING id",
      values: [value.id],
    });
    return Response.json({ deleted: result.rowCount === 1 });
  }
  if (typeof value.body !== "string" || value.body.length < 1 || value.body.length > 200)
    return new Response("Invalid body", { status: 400 });
  const result = await db.transaction([
    {
      text: "INSERT INTO public.preview_notes (id, body) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body RETURNING id, body",
      values: [value.id, value.body],
    },
    { text: "SELECT count(*) AS count FROM public.preview_notes", values: [] },
  ]);
  return Response.json({ note: result[0]?.rows[0], count: result[1]?.rows[0]?.count });
}
export const POST = change;
export const DELETE = change;
