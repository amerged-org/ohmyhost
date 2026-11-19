import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
} from "@ohmyhost/customer-runtime/database";
import { createTransactionalMailClient } from "@ohmyhost/customer-runtime/mail";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const { env } = await getCloudflareContext({ async: true });
  const e = env as unknown as {
    OHMYHOST_DATABASE: CustomerDatabaseBinding;
    OHMYHOST_MAIL_GATEWAY_URL: string;
    OHMYHOST_MAIL_KEY: string;
    OHMYHOST_PROJECT_ID: string;
    PREVIEW_MAIL_RECIPIENT: string;
    PREVIEW_ACCEPTANCE_KEY: string;
  };
  if (
    !e.PREVIEW_ACCEPTANCE_KEY ||
    request.headers.get("authorization") !== `Bearer ${e.PREVIEW_ACCEPTANCE_KEY}` ||
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return new Response("Forbidden", { status: 403 });
  const value = (await request.json().catch(() => null)) as { id?: unknown } | null;
  if (!value || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id))
    return new Response("Invalid id", { status: 400 });
  const db = createPrivateDatabaseClient(e.OHMYHOST_DATABASE);
  await db.query({
    text: "INSERT INTO public.preview_notes (id, body) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    values: [value.id, "mail requested"],
  });
  const receipt = await createTransactionalMailClient({
    endpoint: e.OHMYHOST_MAIL_GATEWAY_URL,
    key: e.OHMYHOST_MAIL_KEY,
    projectId: e.OHMYHOST_PROJECT_ID,
    fetch: (request) => fetch(request),
  }).send({
    idempotencyKey: value.id,
    to: e.PREVIEW_MAIL_RECIPIENT,
    subject: `Preview acceptance ${value.id}`,
    text: `Preview acceptance ${value.id}`,
  });
  return Response.json({ receipt });
}
