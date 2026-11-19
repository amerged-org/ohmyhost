import { parseUlid } from "@ohmyhost/platform";
import type { ResendIngressObservation } from "./resend-ingress.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DELIVERY_TYPES = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
]);
type Status = "pending" | "ready" | "failed";
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
function tag(value: unknown): string | null {
  return typeof value === "string" && ULID.test(value) ? value : null;
}

/** Domain classification over signed metadata; invalid owned observations are deferred to Core. */
function domainObservation(type: string, data: Record<string, unknown>) {
  if (
    (type !== "domain.updated" && type !== "domain.deleted") ||
    typeof data["id"] !== "string" ||
    typeof data["name"] !== "string"
  )
    return null;
  const base = { providerDomainId: data["id"], domain: data["name"] };
  if (type === "domain.deleted")
    return {
      ...base,
      valid: true,
      sending: "failed" as Status,
      receiving: "failed" as Status,
      workspaceSending: "failed" as Status,
    };
  const records = data["records"],
    capabilities = data["capabilities"];
  if (
    !Array.isArray(records) ||
    (capabilities !== undefined &&
      (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)))
  )
    return {
      ...base,
      valid: false,
      sending: "pending" as Status,
      receiving: "pending" as Status,
      workspaceSending: "pending" as Status,
    };
  const caps = capabilities as Record<string, unknown> | undefined;
  const status = (capability: "sending" | "receiving", verificationOnly = false): Status => {
    if (!verificationOnly && caps?.[capability] !== "enabled") return "pending";
    const relevant = records.filter((raw: unknown) => {
      if (typeof raw !== "object" || raw === null || !("record" in raw)) return false;
      const record = String(raw.record).toLowerCase();
      return capability === "receiving"
        ? record.startsWith("receiving")
        : ["dkim", "spf"].includes(record);
    }) as Record<string, unknown>[];
    if (!relevant.length) return "pending";
    if (relevant.every((record) => record["status"] === "verified")) return "ready";
    return relevant.some((record) => record["status"] === "failed") ? "failed" : "pending";
  };
  let workspaceSending = status("sending", true);
  if (workspaceSending === "ready" && data["status"] !== "verified")
    workspaceSending = data["status"] === "failed" ? "failed" : "pending";
  return {
    ...base,
    valid: true,
    sending: caps === undefined ? null : status("sending"),
    receiving: caps === undefined ? null : status("receiving"),
    workspaceSending,
  };
}

/** Recipient addresses are reduced to their original unique domain set; no address, subject or body enters this DTO. */
export function minimizeResendObservation(event: ResendIngressObservation) {
  const { data } = event,
    occurredAt = timestamp(event.createdAt),
    providerMessageId = typeof data["email_id"] === "string" ? data["email_id"] : null,
    rawTags = data["tags"],
    tags =
      typeof rawTags === "object" && rawTags !== null && !Array.isArray(rawTags)
        ? (rawTags as Record<string, unknown>)
        : {},
    bounce = data["bounce"],
    delivery =
      DELIVERY_TYPES.has(event.type) && providerMessageId !== null
        ? {
            requestId: tag(tags["request_id"]),
            projectId: tag(tags["project_id"]),
            permanentBounce:
              typeof bounce === "object" &&
              bounce !== null &&
              "type" in bounce &&
              bounce.type === "Permanent",
          }
        : null,
    domains =
      event.type === "email.received"
        ? [
            ...new Set(
              (Array.isArray(data["to"]) ? data["to"] : []).flatMap((entry: unknown) => {
                if (typeof entry !== "string") return [];
                const address = /<([^\s<>@]+@[^\s<>@]+)>\s*$/u.exec(entry)?.[1] ?? entry.trim();
                return /^[^\s<>@]+@[^\s<>@]+$/u.test(address)
                  ? [address.slice(address.lastIndexOf("@") + 1).toLowerCase()]
                  : [];
              }),
            ),
          ]
        : [],
    receivedAt = timestamp(data["created_at"] ?? event.createdAt),
    received =
      event.type === "email.received" &&
      providerMessageId !== null &&
      domains.length > 0 &&
      domains.length <= 100
        ? {
            recipientDomains: domains,
            receivedAt,
            // Receipt replay is checked by the caller first. Invalid time fails before drawing an id.
            messageId:
              occurredAt !== null && receivedAt !== null ? parseUlid(event.nextMessageId()) : null,
          }
        : null;
  return {
    eventId: event.eventId,
    type: event.type,
    occurredAt,
    providerMessageId,
    digest: Buffer.from(event.digest).toString("hex"),
    now: event.now,
    domain: domainObservation(event.type, data),
    delivery,
    received,
  };
}
