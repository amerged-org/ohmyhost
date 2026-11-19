import type { MailDnsPersistence } from "./mail-dns-persistence.js";
import { parseUlid, type Clock } from "@ohmyhost/platform";
import {
  CloudflareCustomerDnsConflictError,
  type CloudflareDesiredDnsRecord,
} from "@ohmyhost/provider-cloudflare";
import type { CustomerDomainDns } from "./paid-domains.js";
import type { ScopedDnsAuthorizationRuntime } from "./d1-scoped-dns-authorization.js";
/** The caller supplies only scope. DNS values are read from the persisted provider observation. */
export function createResendDns(input: {
  persistence: MailDnsPersistence;
  clock: Clock;
  dns: CustomerDomainDns;
  workspaceDns?: Pick<ScopedDnsAuthorizationRuntime, "reconcileWorkspaceMailRecords">;
  /**
   * The project-deletion operation's own grant access; ordinary DNS access never serves it. Null when Cloudflare
   * revoked the grant, which leaves the customer's zone records in place.
   */
  deletionAccess(scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  }): Promise<Readonly<{ accessToken: string; zoneId: string; zoneName: string }> | null>;
}) {
  const persistence = input.persistence;
  return {
    async ensureWorkspaceMailRecords(raw: unknown) {
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "mailDomainId,organizationId"
      )
        throw new TypeError("Invalid workspace mail DNS scope");
      const value = raw as Record<string, unknown>;
      const organizationId = parseUlid(String(value["organizationId"])),
        mailDomainId = parseUlid(String(value["mailDomainId"]));
      const stored = await persistence.workspace({ organizationId, mailDomainId });
      const records = stored.records.map((raw): CloudflareDesiredDnsRecord => {
        if (typeof raw !== "object" || raw === null)
          throw new TypeError("Invalid workspace mail DNS record");
        const row = raw as Record<string, unknown>,
          type = row["type"],
          name = row["name"],
          content = row["value"];
        if (
          (type !== "TXT" && type !== "MX" && type !== "CNAME") ||
          typeof name !== "string" ||
          typeof content !== "string" ||
          !(name === stored.domain || name.endsWith(`.${stored.domain}`))
        )
          throw new TypeError("Workspace mail DNS record is outside the resource");
        return {
          type,
          name,
          content: type === "TXT" ? content : content.replace(/\.$/u, ""),
          ttl: 300,
          proxied: false,
          comment: `ohmyhost:${stored.custody_project_id}:mail:v1`,
          ...(type === "MX" ? { priority: Number(row["priority"]) } : {}),
        };
      });
      if (records.length === 0 || records.length > 32)
        throw new Error("Workspace mail DNS requirements are unavailable");
      await persistence.requirePaid(organizationId, () => input.clock.now().toISOString());
      if (input.workspaceDns === undefined)
        throw new Error("Workspace DNS management is unavailable");
      try {
        const receipt = await input.workspaceDns.reconcileWorkspaceMailRecords({
          organizationId,
          mailDomainId,
          records,
        });
        if (receipt === null) return { status: "action_required", records: stored.records };
        await persistence.saveWorkspace({ organizationId, mailDomainId }, receipt);
        return { status: "configured", records: stored.records };
      } catch (error) {
        if (error instanceof CloudflareCustomerDnsConflictError)
          return { status: "conflict", records: stored.records };
        throw error;
      }
    },
    async deleteMailRecords(raw: unknown) {
      if (typeof raw !== "object" || raw === null)
        throw new TypeError("Invalid mail deletion scope");
      const r = raw as Record<string, unknown>;
      const organizationId = parseUlid(String(r["organizationId"])),
        projectId = parseUlid(String(r["projectId"])),
        operationId = parseUlid(String(r["operationId"])),
        domainId = parseUlid(String(r["domainId"]));
      const row = await persistence.deletion({ organizationId, projectId, operationId, domainId });
      const receipt = row.dns_receipts;
      if (!receipt.records?.length) return { recordIds: [] };
      // The deletion's own grant access, renewed after an ordinary access-token expiry.
      const access = await input.deletionAccess({ organizationId, projectId, operationId });
      if (access === null) return { recordIds: [] };
      if (
        access.zoneId !== receipt.zoneId ||
        access.zoneName !== receipt.zoneName ||
        !(row.domain === access.zoneName || row.domain.endsWith(`.${access.zoneName}`))
      )
        throw new Error("Mail DNS deletion requires original zone access");
      return input.dns.deleteRecords(access.accessToken, {
        zoneId: access.zoneId,
        zoneName: access.zoneName,
        records: receipt.records,
      });
    },
    async ensureMailRecords(raw: unknown) {
      if (typeof raw !== "object" || raw === null) throw new TypeError("Invalid mail DNS scope");
      const value = raw as Record<string, unknown>;
      const scope = {
        organizationId: parseUlid(String(value["organizationId"])),
        projectId: parseUlid(String(value["projectId"])),
        environmentId: parseUlid(String(value["environmentId"])),
      };
      const row = await persistence.legacy(scope);
      if (!row || row.domain_id !== value["domainId"] || !row.provider_domain_id)
        throw new Error("Mail DNS scope unavailable");
      const records = row.records.map((raw): CloudflareDesiredDnsRecord => {
        if (typeof raw !== "object" || raw === null) throw new TypeError("Invalid mail DNS record");
        const record = raw as Record<string, unknown>,
          type = record["type"],
          name = record["name"],
          content = record["value"];
        if (
          (type !== "MX" && type !== "TXT" && type !== "CNAME") ||
          typeof name !== "string" ||
          typeof content !== "string" ||
          !(name === row.domain || name.endsWith(`.${row.domain}`))
        )
          throw new TypeError("Invalid mail DNS ownership");
        return {
          type,
          name,
          content: type === "TXT" ? content : content.replace(/\.$/u, ""),
          ttl: 300,
          proxied: false,
          comment: `ohmyhost:${row.project_id}:mail:v1`,
          ...(type === "MX" ? { priority: Number(record["priority"]) } : {}),
        };
      });
      await persistence.requirePaid(scope.organizationId, () => input.clock.now().toISOString());
      try {
        const workspace = await input.workspaceDns?.reconcileWorkspaceMailRecords({
          organizationId: scope.organizationId,
          mailDomainId: row.domain_id,
          records,
        });
        const access =
          workspace == null ? await input.dns.loadAccess({ ...scope, hostname: row.domain }) : null;
        if (workspace == null && access?.status !== "ready")
          return { status: "action_required", records: row.records };
        const result =
          workspace ??
          (access?.status === "ready"
            ? {
                ...access,
                ...(await input.dns.reconcileRecords(access.accessToken, {
                  zoneId: access.zoneId,
                  zoneName: access.zoneName,
                  records,
                })),
              }
            : null);
        if (result === null) throw new Error("Mail DNS authority is unavailable");
        await persistence.saveLegacy(row.domain_id, {
          zoneId: result.zoneId,
          zoneName: result.zoneName,
          records: result.records,
        });
        return { status: "configured", records: row.records };
      } catch (error) {
        if (error instanceof CloudflareCustomerDnsConflictError)
          return { status: "conflict", records: row.records };
        throw error;
      }
    },
  };
}
