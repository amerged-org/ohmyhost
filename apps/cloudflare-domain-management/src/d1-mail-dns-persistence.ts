import { parseUlid } from "@ohmyhost/platform";
import { OrganizationCreditError } from "@ohmyhost/database";
import type { MailDnsPersistence, MailDnsDeletionRequirements } from "./mail-dns-persistence.js";
interface MailDnsBinding {
  workspace(input: unknown): Promise<unknown>;
  legacy(input: unknown): Promise<unknown>;
  deletion(input: unknown): Promise<unknown>;
  requirePaid(input: unknown): Promise<unknown>;
  saveWorkspace(input: unknown): Promise<unknown>;
  saveLegacy(input: unknown): Promise<unknown>;
}
function invalid(): never {
  throw new TypeError("mail_dns_response_invalid");
}
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function json(value: unknown, array: boolean): unknown {
  if (typeof value !== "string") return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (
    array
      ? !Array.isArray(parsed)
      : typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  )
    return invalid();
  return parsed;
}
const empty = (value: unknown) => (value === undefined ? undefined : invalid());
async function invoke<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    for (const code of [
      "paid_plan_required",
      "insufficient_organization_credits",
      "organization_credit_scope_missing",
      "Workspace mail DNS resource is unavailable",
      "Mail deletion unavailable",
      "store_busy",
      "store_outcome_unknown",
    ]) {
      if (message !== code && !message.endsWith(`: ${code}`)) continue;
      if (
        code === "paid_plan_required" ||
        code === "insufficient_organization_credits" ||
        code === "organization_credit_scope_missing"
      )
        throw new OrganizationCreditError(code);
      if (code === "store_busy" || code === "store_outcome_unknown")
        throw Object.assign(new Error(code), { code });
      throw new Error(code);
    }
    throw new Error("mail_dns_core_unavailable");
  }
  return parse(raw);
}
/** CF receives requirements/receipts only; it never obtains Mail sending-key custody through this capability. */
export async function createD1MailDnsPersistence(raw: unknown): Promise<MailDnsPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["workspace", "legacy", "deletion", "requirePaid", "saveWorkspace", "saveLegacy"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_dns_binding_required");
  const binding = raw as MailDnsBinding;
  const legacy = (value: unknown) => {
    if (value === null) return null;
    if (
      !record(value, ["domain_id", "provider_domain_id", "domain", "records", "project_id"]) ||
      typeof value["domain"] !== "string" ||
      (value["provider_domain_id"] !== null && typeof value["provider_domain_id"] !== "string")
    )
      return invalid();
    return {
      domain_id: parseUlid(String(value["domain_id"])),
      provider_domain_id: value["provider_domain_id"] as string | null,
      domain: value["domain"],
      records: json(value["records"], true) as unknown[],
      project_id: parseUlid(String(value["project_id"])),
    };
  };
  if (
    (await invoke(
      () =>
        binding.legacy({
          organizationId: "00000000000000000000000000",
          projectId: "00000000000000000000000000",
          environmentId: "00000000000000000000000000",
        }),
      legacy,
    )) !== null
  )
    return invalid();
  return {
    workspace: (scope) =>
      invoke(
        () => binding.workspace(scope),
        (value) => {
          if (
            !record(value, ["domain", "custody_project_id", "records"]) ||
            typeof value["domain"] !== "string"
          )
            return invalid();
          return {
            domain: value["domain"],
            custody_project_id: parseUlid(String(value["custody_project_id"])),
            records: json(value["records"], true) as unknown[],
          };
        },
      ),
    legacy: (scope) => invoke(() => binding.legacy(scope), legacy),
    deletion: (scope) =>
      invoke(
        () => binding.deletion(scope),
        (value) => {
          if (!record(value, ["domain", "dns_receipts"]) || typeof value["domain"] !== "string")
            return invalid();
          return {
            domain: value["domain"],
            dns_receipts: json(
              value["dns_receipts"],
              false,
            ) as MailDnsDeletionRequirements["dns_receipts"],
          };
        },
      ),
    requirePaid: (organizationId, now) =>
      invoke(() => binding.requirePaid({ organizationId, now: now() }), empty),
    saveWorkspace: (scope, receipt) =>
      invoke(() => binding.saveWorkspace({ ...scope, receipt }), empty),
    saveLegacy: (domainId, receipt) =>
      invoke(() => binding.saveLegacy({ domainId, receipt }), empty),
  };
}
