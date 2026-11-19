import { z } from "zod";

import type { ProjectMailDomainsPort } from "./contracts.js";
import { ProjectMailDomainsUnavailableError } from "./project-mail-domains.js";

/** The Mail management capability's one read; the wire row is the original projection, columns unchanged. */
export interface D1MailDomainReadRuntime {
  readDomain(input: unknown): Promise<unknown>;
}
const stored = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const status = z.enum(["disabled", "pending", "ready", "failed"]);
const row = z
  .object({
    domain: z.string(),
    sending_status: status,
    sending_key_id: z.string().nullable(),
    receiving: z.union([z.literal(0), z.literal(1)]),
    receiving_status: status,
    configured_at: stored,
    observed_at: stored.nullable(),
    records: z.string(),
  })
  .passthrough();
const publicInstant = (value: string) => `${value.slice(0, 23)}Z`;

/**
 * The project's managed Resend domain as the customer sees it. Only Resend sends mail: an older sender record is history
 * and names no active sender. Setting a domain goes through the managed mail port, so `configure` has no caller here.
 */
export function createD1ProjectMailDomainsPort(
  runtime: D1MailDomainReadRuntime,
): ProjectMailDomainsPort {
  return Object.freeze({
    async configure(): Promise<never> {
      throw new ProjectMailDomainsUnavailableError();
    },
    async get(request: Parameters<ProjectMailDomainsPort["get"]>[0]) {
      const raw = await runtime.readDomain({
        organizationId: request.organizationId,
        projectId: request.projectId,
      });
      if (raw === null) return null;
      const managed = row.parse(raw),
        sending =
          managed.sending_status === "ready" && !managed.sending_key_id
            ? ("pending" as const)
            : managed.sending_status;
      let records: unknown;
      try {
        records = JSON.parse(managed.records);
      } catch {
        throw new ProjectMailDomainsUnavailableError();
      }
      return {
        domain: managed.domain,
        status: sending === "ready" ? ("ready" as const) : ("verification_pending" as const),
        sending,
        receiving: managed.receiving_status,
        configuredAt: publicInstant(managed.configured_at),
        ...(managed.observed_at ? { observedAt: publicInstant(managed.observed_at) } : {}),
        nextCheckAfterSeconds:
          sending === "ready" && (managed.receiving === 0 || managed.receiving_status === "ready")
            ? null
            : (60 as const),
        dnsRecords: dnsRecords(records, managed.domain),
      };
    },
  });
}
function dnsRecords(value: unknown, domain: string) {
  if (!Array.isArray(value) || value.length > 16) throw new ProjectMailDomainsUnavailableError();
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new ProjectMailDomainsUnavailableError();
    const record = raw as Record<string, unknown>;
    if (
      !["MX", "TXT", "CNAME"].includes(String(record["type"])) ||
      typeof record["name"] !== "string" ||
      record["name"].length > 253 ||
      /[\r\n\0]/u.test(record["name"]) ||
      !(record["name"] === domain || record["name"].endsWith(`.${domain}`)) ||
      typeof record["value"] !== "string" ||
      record["value"].length === 0 ||
      record["value"].length > 4096 ||
      /[\r\n\0]/u.test(record["value"]) ||
      typeof record["status"] !== "string" ||
      record["status"].length === 0 ||
      record["status"].length > 32 ||
      /[\r\n\0]/u.test(record["status"]) ||
      (record["type"] === "MX" &&
        (!Number.isInteger(record["priority"]) ||
          Number(record["priority"]) < 0 ||
          Number(record["priority"]) > 65535))
    )
      throw new ProjectMailDomainsUnavailableError();
    return {
      type: record["type"] as "MX" | "TXT" | "CNAME",
      name: record["name"],
      value: record["value"],
      status: record["status"],
      ...(record["type"] === "MX" ? { priority: record["priority"] as number } : {}),
    };
  });
}
