import type { Clock, UlidFactory } from "@ohmyhost/platform";
import { verifyResendWebhook } from "@ohmyhost/provider-resend/webhooks";

export interface ResendIngressObservation {
  readonly eventId: string;
  readonly type: string;
  readonly createdAt: unknown;
  readonly data: Record<string, unknown>;
  readonly digest: Uint8Array;
  readonly now: string;
  /** Lazy identity draw for a received message; only an event that receives mail consumes it. */
  readonly nextMessageId: () => string;
}
export interface ResendIngressPersistence {
  ingest(event: ResendIngressObservation): Promise<void>;
}

/** Only signature verification and durable metadata intake; no mail-management key or content access. */
export function createResendIngress(input: {
  persistence: ResendIngressPersistence;
  clock: Clock;
  ids: UlidFactory;
  secret: string;
}) {
  const { persistence } = input;
  return {
    async fetch(request: Request): Promise<Response> {
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
      )
        return result(400);
      let body: string, eventId: string, value: Record<string, unknown>;
      try {
        const reader = request.body?.getReader();
        if (!reader) return result(400);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > 262144) return result(413);
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        eventId = await verifyResendWebhook(body, request.headers, input.secret, input.clock.now());
        value = JSON.parse(body) as Record<string, unknown>;
        if (
          typeof value !== "object" ||
          value === null ||
          typeof value["type"] !== "string" ||
          typeof value["data"] !== "object" ||
          value["data"] === null
        )
          throw Error();
      } catch {
        return result(400);
      }
      const data = value["data"] as Record<string, unknown>,
        now = input.clock.now().toISOString();
      try {
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
        );
        await persistence.ingest({
          eventId,
          type: String(value["type"]),
          createdAt: value["created_at"],
          data,
          digest,
          now,
          nextMessageId: () => input.ids.next(),
        });
        return result(200);
      } catch {
        // Only a failure on a project-owned event reaches this point; Resend retries it.
        return result(503);
      }
    },
  };
}
function result(status: number) {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}
