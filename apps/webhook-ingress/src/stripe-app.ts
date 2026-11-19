import type { recordStripeInboxEvent } from "@ohmyhost/database";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import { verifyStripeWebhook } from "@ohmyhost/provider-stripe/webhooks";

export interface StripeWebhookInboxRecorder {
  record(input: Parameters<typeof recordStripeInboxEvent>[1]): Promise<"created" | "existing">;
}

export function createStripeWebhookIngress(dependencies: {
  inbox: StripeWebhookInboxRecorder;
  configuration: { accountId: string; mode: "test" | "live" };
  secret: string;
  clock: Clock;
  ids: UlidFactory;
}) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/webhooks/stripe" || url.search)
        return new Response(null, { status: 404 });
      const signature = request.headers.get("stripe-signature");
      if (!signature || signature.length > 4096)
        return Response.json({ error: "stripe_webhook_invalid" }, { status: 400 });
      const reader = request.body?.getReader();
      if (!reader) return Response.json({ error: "stripe_webhook_invalid" }, { status: 400 });
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 256 * 1024) {
            await reader.cancel();
            return Response.json({ error: "webhook_body_too_large" }, { status: 413 });
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.length;
      }
      let event;
      try {
        event = await verifyStripeWebhook({
          ...dependencies.configuration,
          payload: new TextDecoder("utf-8", { fatal: true }).decode(raw),
          signature,
          secret: dependencies.secret,
        });
      } catch {
        return Response.json({ error: "stripe_webhook_invalid" }, { status: 400 });
      }
      try {
        const input = {
          inboxEventId: dependencies.ids.next(),
          event: { ...event, ...dependencies.configuration },
          receivedAt: dependencies.clock.now().toISOString(),
        };
        const result = await dependencies.inbox.record(input);
        return Response.json(
          { accepted: true, duplicate: result === "existing" },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        const conflict =
          error instanceof Error && error.message === "stripe_inbox_identity_conflict";
        return Response.json(
          { error: conflict ? "stripe_inbox_identity_conflict" : "webhook_inbox_unavailable" },
          { status: conflict ? 409 : 503 },
        );
      }
    },
  };
}
