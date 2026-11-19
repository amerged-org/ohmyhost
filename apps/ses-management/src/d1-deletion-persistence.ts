import { LegacyAwsMailAbsenceError, type requireLegacyAwsMailAbsence } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";

interface MailDeletionDomain {
  domain_id: string;
  provider_domain_id: string | null;
  sending_key_id: string | null;
  sending_key_claimed_at: Date | null;
  provider_claimed_at: Date | null;
  provider_preflight_at: Date | null;
  retirement_completed: boolean;
  domain: string;
}
interface MailDeletionPreparation {
  inventory: readonly string[];
  legacy: Awaited<ReturnType<typeof requireLegacyAwsMailAbsence>>;
  retained: readonly { domain_id: string; provider_domain_id: string; sending: boolean }[];
  domains: readonly MailDeletionDomain[];
}
export interface MailProjectDeletionPersistence {
  prepare(scope: {
    organizationId: string;
    projectId: string;
    operationId: string;
  }): Promise<MailDeletionPreparation>;
  recordFound(domainId: string, providerDomainId: string): Promise<void>;
  finish(domainId: string, now: () => Date): Promise<void>;
}

interface MailProjectDeletionBinding {
  readScope(input: unknown): Promise<unknown>;
  prepare(input: unknown): Promise<unknown>;
  recordFound(input: unknown): Promise<unknown>;
  finish(input: unknown): Promise<unknown>;
}
function invalid(): never {
  throw new TypeError("mail_deletion_response_invalid");
}
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
const kinds = ["ses-tenant", "ses-configuration-set", "ses-event-destination"] as const;
function preparation(raw: unknown): MailDeletionPreparation {
  if (
    !object(raw, ["inventory", "legacy", "retained", "domains"]) ||
    !Array.isArray(raw["inventory"]) ||
    !Array.isArray(raw["legacy"]) ||
    !Array.isArray(raw["retained"]) ||
    !Array.isArray(raw["domains"])
  )
    return invalid();
  const inventory = raw["inventory"].map((value) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return invalid();
    return value;
  });
  const legacy = raw["legacy"].map((value) => {
    if (
      !object(value, ["provider", "resourceKind", "locator", "outcome"]) ||
      value["provider"] !== "aws" ||
      value["outcome"] !== "not_found" ||
      !kinds.includes(value["resourceKind"] as (typeof kinds)[number]) ||
      typeof value["locator"] !== "string"
    )
      return invalid();
    return {
      provider: "aws" as const,
      resourceKind: value["resourceKind"] as (typeof kinds)[number],
      locator: value["locator"],
      outcome: "not_found" as const,
    };
  });
  const retained = raw["retained"].map((value) => {
    if (
      !object(value, ["domain_id", "provider_domain_id", "sending"]) ||
      typeof value["provider_domain_id"] !== "string" ||
      typeof value["sending"] !== "boolean"
    )
      return invalid();
    return {
      domain_id: parseUlid(String(value["domain_id"])),
      provider_domain_id: value["provider_domain_id"],
      sending: value["sending"],
    };
  });
  const domains = raw["domains"].map((value) => {
    if (
      !object(value, [
        "domain_id",
        "provider_domain_id",
        "sending_key_id",
        "sending_key_claimed_at",
        "provider_claimed_at",
        "provider_preflight_at",
        "domain",
        "retirement_completed",
      ]) ||
      typeof value["domain"] !== "string" ||
      typeof value["retirement_completed"] !== "boolean"
    )
      return invalid();
    for (const key of ["provider_domain_id", "sending_key_id"])
      if (value[key] !== null && typeof value[key] !== "string") return invalid();
    const row: Record<string, unknown> = {
      ...value,
      domain_id: parseUlid(String(value["domain_id"])),
    };
    for (const key of ["sending_key_claimed_at", "provider_claimed_at", "provider_preflight_at"]) {
      const v = value[key];
      if (v === null) {
        row[key] = null;
        continue;
      }
      if (
        typeof v !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(v) ||
        !Number.isFinite(Date.parse(v))
      )
        return invalid();
      row[key] = new Date(v);
    }
    return row as unknown as MailDeletionDomain;
  });
  return { inventory, legacy, retained, domains };
}
const empty = (value: unknown) => (value === undefined ? undefined : invalid());
async function invoke<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    for (const code of [
      "legacy_aws_mail_absence_missing",
      "Mail deletion scope unavailable",
      "Mail domain receipt conflict",
      "store_busy",
      "store_outcome_unknown",
    ]) {
      if (message !== code && !message.endsWith(`: ${code}`)) continue;
      if (code === "legacy_aws_mail_absence_missing")
        throw new LegacyAwsMailAbsenceError("Legacy AWS mail resource absence is not recorded");
      if (code === "store_busy" || code === "store_outcome_unknown")
        throw Object.assign(new Error(code), { code });
      throw new Error(code);
    }
    throw new Error("mail_deletion_unavailable");
  }
  return parse(raw);
}
/** Frozen original deletion scope and recorded facts only; no provider result or observed absence is supplied. */
export async function createD1MailProjectDeletionPersistence(
  raw: unknown,
): Promise<MailProjectDeletionPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["readScope", "prepare", "recordFound", "finish"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_deletion_binding_required");
  const binding = raw as MailProjectDeletionBinding;
  if (
    (await invoke(
      () =>
        binding.readScope({
          organizationId: "00000000000000000000000000",
          projectId: "00000000000000000000000000",
          operationId: "00000000000000000000000000",
        }),
      (value) => (typeof value === "boolean" ? value : invalid()),
    )) !== false
  )
    return invalid();
  return {
    prepare: (scope) => invoke(() => binding.prepare(scope), preparation),
    recordFound: (domainId, providerDomainId) =>
      invoke(() => binding.recordFound({ domainId, providerDomainId }), empty),
    finish: (domainId, now) =>
      invoke(
        () =>
          binding.finish({
            domainId,
            deletedAt: now().toISOString(),
            completedAt: now().toISOString(),
          }),
        empty,
      ),
  };
}
