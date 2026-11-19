import { createHash, timingSafeEqual } from "node:crypto";
import { createResendProvider } from "@ohmyhost/provider-resend";

export interface InfrastructureAlertPersistence {
  claim(input: {
    eventId: string;
    requestSha256: string;
    now: string;
  }): Promise<"send" | "wait" | "accepted" | "conflict">;
  complete(input: {
    eventId: string;
    requestSha256: string;
    providerMessageId: string;
    acceptedAt: string;
  }): Promise<boolean>;
}

interface InfrastructureAlert {
  version: 1;
  event_id: string;
  kind: "regional_ram_warning" | "regional_node_cap_reached";
  region_id: string;
  occurred_at: string;
  regional_ram_utilization_ppm: number | null;
  allocated_nodes: number;
  max_nodes: number | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const fields =
  "allocated_nodes,event_id,kind,max_nodes,occurred_at,region_id,regional_ram_utilization_ppm,version";
function parseAlert(value: unknown, now: number): InfrastructureAlert {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("invalid_alert");
  const alert = value as Record<string, unknown>,
    utilization = alert["regional_ram_utilization_ppm"],
    maximum = alert["max_nodes"];
  if (
    Object.keys(alert).sort().join(",") !== fields ||
    alert["version"] !== 1 ||
    typeof alert["event_id"] !== "string" ||
    !uuid.test(alert["event_id"]) ||
    typeof alert["kind"] !== "string" ||
    !["regional_ram_warning", "regional_node_cap_reached"].includes(alert["kind"]) ||
    typeof alert["region_id"] !== "string" ||
    !/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/u.test(alert["region_id"]) ||
    typeof alert["occurred_at"] !== "string" ||
    !Number.isFinite(Date.parse(alert["occurred_at"])) ||
    new Date(alert["occurred_at"]).toISOString() !== alert["occurred_at"] ||
    Date.parse(alert["occurred_at"]) > now + 300_000 ||
    (utilization !== null &&
      (!Number.isSafeInteger(utilization) ||
        Number(utilization) < 0 ||
        Number(utilization) > 1_000_000)) ||
    !Number.isSafeInteger(alert["allocated_nodes"]) ||
    Number(alert["allocated_nodes"]) < 0 ||
    (maximum !== null && (!Number.isSafeInteger(maximum) || Number(maximum) < 1))
  )
    throw new TypeError("invalid_alert");
  return {
    version: 1,
    event_id: alert["event_id"].toLowerCase(),
    kind: alert["kind"] as InfrastructureAlert["kind"],
    region_id: alert["region_id"],
    occurred_at: alert["occurred_at"],
    regional_ram_utilization_ppm: utilization as number | null,
    allocated_nodes: Number(alert["allocated_nodes"]),
    max_nodes: maximum as number | null,
  };
}
function response(status: number, eventId?: string): Response {
  return Response.json(
    eventId
      ? { event_id: eventId, status: "accepted" }
      : { code: status === 409 ? "event_identity_conflict" : "infrastructure_alert_unavailable" },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Operator-only adapter: recipient and mail-provider credentials never enter PGCF payloads. */
export function createInfrastructureAlertReceiver(input: {
  persistence: InfrastructureAlertPersistence;
  secret: string;
  recipient: string;
  apiKey: string;
  platform: "development" | "production";
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}) {
  if (
    input.secret.length < 32 ||
    input.secret.length > 4096 ||
    !/^[^\s<>@]+@[^\s<>@]+$/u.test(input.recipient) ||
    !["development", "production"].includes(input.platform)
  )
    throw new TypeError("invalid_alert_configuration");
  const persistence = input.persistence;
  const provider = createResendProvider({
      apiKey: input.apiKey,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }),
    clock = input.now ?? (() => new Date()),
    providerKeyFingerprint = createHash("sha256").update(input.apiKey).digest("hex"),
    secretHash = createHash("sha256").update(input.secret).digest();
  return {
    async fetch(request: Request): Promise<Response> {
      const authorization = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
      if (
        !authorization ||
        !timingSafeEqual(
          secretHash,
          createHash("sha256")
            .update(authorization[1] ?? "")
            .digest(),
        )
      )
        return response(401);
      if (
        request.method !== "POST" ||
        new URL(request.url).search !== "" ||
        request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
      )
        return response(400);
      const now = clock();
      let alert: InfrastructureAlert;
      try {
        const reader = request.body?.getReader();
        if (!reader) return response(400);
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > 8192) return response(413);
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        alert = parseAlert(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          now.getTime(),
        );
        if (request.headers.get("idempotency-key")?.toLowerCase() !== alert.event_id)
          return response(400);
      } catch {
        return response(400);
      }
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            alert,
            recipient: input.recipient,
            platform: input.platform,
            provider_key_fingerprint: providerKeyFingerprint,
          }),
        )
        .digest("hex");
      try {
        const decision = await persistence.claim({
          eventId: alert.event_id,
          requestSha256: digest,
          now: now.toISOString(),
        });
        if (decision === "conflict") return response(409);
        if (decision === "accepted") return response(200, alert.event_id);
        if (decision === "wait") return response(503);
        const utilization =
            alert.regional_ram_utilization_ppm === null
              ? "unknown"
              : `${(alert.regional_ram_utilization_ppm / 10_000).toFixed(2)}%`,
          capacity = alert.max_nodes === null ? "no configured ceiling" : String(alert.max_nodes);
        const sent = await provider.send({
          from: `no-reply@${input.platform === "production" ? "ohmyho.st" : "dev.ohmyho.st"}`,
          to: input.recipient,
          subject: `${input.platform === "development" ? "[Development] " : ""}PGCF ${alert.kind === "regional_ram_warning" ? "regional RAM warning" : "regional VPS limit reached"}: ${alert.region_id}`,
          text: `PGCF infrastructure notification\n\nRegion: ${alert.region_id}\nObserved at: ${alert.occurred_at}\nActual ten-minute RAM utilization: ${utilization}\nAllocated VPS: ${alert.allocated_nodes}\nRegional VPS limit: ${capacity}\nEvent: ${alert.event_id}\n\n${alert.kind === "regional_ram_warning" ? "Review regional capacity before the automatic expansion threshold." : "The regional infrastructure ceiling has been reached. Review capacity before raising the ceiling."}`,
          idempotencyKey: `pgcf:${input.platform}:${alert.event_id}`,
          tags: {
            infrastructure_alert_id: alert.event_id,
            region: alert.region_id,
            platform: input.platform,
          },
        });
        const saved = await persistence.complete({
          eventId: alert.event_id,
          requestSha256: digest,
          providerMessageId: sent.messageId,
          acceptedAt: clock().toISOString(),
        });
        return saved ? response(200, alert.event_id) : response(503);
      } catch {
        return response(503);
      }
    },
  };
}
