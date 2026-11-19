import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
} from "@ohmyhost/customer-runtime/database";
interface Environment {
  OHMYHOST_DATABASE: CustomerDatabaseBinding;
}
export default {
  async fetch(request: Request, env: Environment) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
    if (url.pathname !== "/api/notes") return new Response("Not found", { status: 404 });
    const db = createPrivateDatabaseClient(env.OHMYHOST_DATABASE);
    if (request.method === "GET") {
      const result = await db.query({
        text: "SELECT id, body FROM public.preview_notes ORDER BY id",
        values: [],
      });
      return Response.json({ notes: result.rows }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "POST" && request.method !== "DELETE")
      return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("origin") !== url.origin)
      return new Response("Forbidden", { status: 403 });
    const value = (await request.json().catch(() => null)) as {
      id?: unknown;
      body?: unknown;
    } | null;
    if (!value || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id))
      return new Response("Invalid id", { status: 400 });
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
  },
};
