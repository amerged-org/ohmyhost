import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
} from "@ohmyhost/customer-runtime/database";
import {
  createNativeAuthServer,
  NativeAuthRequiredError,
  type NativeAuthBinding,
} from "@ohmyhost/customer-runtime/auth-server";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  const { env } = await getCloudflareContext({ async: true });
  const bindings = env as unknown as {
    OHMYHOST_DATABASE: CustomerDatabaseBinding;
    OHMYHOST_AUTH: NativeAuthBinding;
  };
  let owner: string;
  try {
    owner = (await createNativeAuthServer(bindings.OHMYHOST_AUTH).requireUser(request)).id;
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof NativeAuthRequiredError
            ? "authentication_required"
            : "authentication_unavailable",
      },
      { status: error instanceof NativeAuthRequiredError ? 401 : 503 },
    );
  }
  const db = createPrivateDatabaseClient(bindings.OHMYHOST_DATABASE);
  if (request.method === "GET")
    return Response.json(
      {
        notes: (
          await db.query({
            text: "SELECT id, body FROM public.preview_notes WHERE owner_id = $1 ORDER BY id",
            values: [owner],
          })
        ).rows,
      },
      { headers: { "cache-control": "no-store" } },
    );
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response("Forbidden", { status: 403 });
  const input = (await request.json().catch(() => null)) as { id?: unknown; body?: unknown } | null;
  if (!input || typeof input.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id))
    return new Response("Invalid id", { status: 400 });
  if (request.method === "DELETE")
    return Response.json({
      deleted:
        (
          await db.query({
            text: "DELETE FROM public.preview_notes WHERE owner_id = $1 AND id = $2 RETURNING id",
            values: [owner, input.id],
          })
        ).rowCount === 1,
    });
  if (typeof input.body !== "string" || !input.body || input.body.length > 200)
    return new Response("Invalid body", { status: 400 });
  const result = await db.transaction([
    {
      text: "INSERT INTO public.preview_notes (owner_id, id, body) VALUES ($1, $2, $3) ON CONFLICT (owner_id, id) DO UPDATE SET body = EXCLUDED.body RETURNING id, body",
      values: [owner, input.id, input.body],
    },
    {
      text: "SELECT count(*) AS count FROM public.preview_notes WHERE owner_id = $1",
      values: [owner],
    },
  ]);
  return Response.json({ note: result[0]?.rows[0], count: result[1]?.rows[0]?.count });
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
