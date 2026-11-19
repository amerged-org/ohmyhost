import { parseUlid } from "@ohmyhost/platform";
export interface MailManagementJobPersistence {
  listPendingLegacy(): Promise<
    readonly {
      domain_id: string;
      organization_id: string;
      project_id: string;
      environment_id: string;
    }[]
  >;
  claimLegacy(domainId: string, now: string): Promise<boolean>;
  claimDueIdentityRevalidation(
    now: string,
  ): Promise<readonly { organization_id: string; project_id: string; revision: string }[]>;
  suspendExpiredBindings(now: string): Promise<void>;
  listPendingWorkspaces(
    now: string,
  ): Promise<readonly { organization_id: string; domain_id: string; provisioning: boolean }[]>;
  claimWorkspace(organizationId: string, domainId: string, now: string): Promise<boolean>;
  /** Unverified workspace reservations configured before the cutoff, oldest first. */
  listExpiredUnverifiedWorkspaces(
    cutoff: string,
    limit: number,
  ): Promise<readonly { organizationId: string; domainId: string; expectedRevision: number }[]>;
}
interface MailManagementJobBinding {
  listPendingLegacy(input: unknown): Promise<unknown>;
  claimLegacy(input: unknown): Promise<unknown>;
  claimDueIdentity(input: unknown): Promise<unknown>;
  suspendExpiredBindings(input: unknown): Promise<unknown>;
  listPendingWorkspaces(input: unknown): Promise<unknown>;
  claimWorkspace(input: unknown): Promise<unknown>;
  listExpiredUnverifiedWorkspaces(input: unknown): Promise<unknown>;
}
function invalid(): never {
  throw new TypeError("mail_job_response_invalid");
}
function rows(raw: unknown, keys: string[]): Record<string, unknown>[] {
  if (
    !Array.isArray(raw) ||
    raw.length > 20 ||
    raw.some(
      (row) =>
        typeof row !== "object" ||
        row === null ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== [...keys].sort().join(","),
    )
  )
    return invalid();
  return raw as Record<string, unknown>[];
}
function legacy(raw: unknown) {
  return rows(raw, ["domain_id", "organization_id", "project_id", "environment_id"]).map((row) => ({
    domain_id: parseUlid(String(row["domain_id"])),
    organization_id: parseUlid(String(row["organization_id"])),
    project_id: parseUlid(String(row["project_id"])),
    environment_id: parseUlid(String(row["environment_id"])),
  }));
}
const boolean = (raw: unknown) => (typeof raw === "boolean" ? raw : invalid()),
  empty = (raw: unknown) => (raw === undefined ? undefined : invalid());
async function invoke<T>(call: () => Promise<unknown>, parse: (raw: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    for (const code of ["store_busy", "store_outcome_unknown"]) {
      if (message === code || message.endsWith(`: ${code}`))
        throw Object.assign(new Error(code), { code });
    }
    throw new Error("mail_job_unavailable");
  }
  return parse(raw);
}
/** Complete original fixed scheduled cohorts; no primitive SQL, arbitrary cursor or healthy partial result. */
export async function createD1MailManagementJobPersistence(
  raw: unknown,
): Promise<MailManagementJobPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    [
      "listPendingLegacy",
      "claimLegacy",
      "claimDueIdentity",
      "suspendExpiredBindings",
      "listPendingWorkspaces",
      "claimWorkspace",
      "listExpiredUnverifiedWorkspaces",
    ].some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("mail_job_binding_required");
  const binding = raw as MailManagementJobBinding;
  await invoke(() => binding.listPendingLegacy({}), legacy);
  return {
    listPendingLegacy: () => invoke(() => binding.listPendingLegacy({}), legacy),
    claimLegacy: (domainId, now) => invoke(() => binding.claimLegacy({ domainId, now }), boolean),
    claimDueIdentityRevalidation: (now) =>
      invoke(
        () => binding.claimDueIdentity({ now }),
        (raw) =>
          rows(raw, ["organization_id", "project_id", "revision"]).map((row) => {
            const revision = row["revision"];
            if (
              typeof revision !== "string" ||
              !/^[1-9][0-9]*$/u.test(revision) ||
              BigInt(revision) > 9223372036854775807n
            )
              return invalid();
            return {
              organization_id: parseUlid(String(row["organization_id"])),
              project_id: parseUlid(String(row["project_id"])),
              revision,
            };
          }),
      ),
    suspendExpiredBindings: (now) => invoke(() => binding.suspendExpiredBindings({ now }), empty),
    listPendingWorkspaces: (now) =>
      invoke(
        () => binding.listPendingWorkspaces({ now }),
        (raw) =>
          rows(raw, ["organization_id", "domain_id", "provisioning"]).map((row) => {
            if (typeof row["provisioning"] !== "boolean") return invalid();
            return {
              organization_id: parseUlid(String(row["organization_id"])),
              domain_id: parseUlid(String(row["domain_id"])),
              provisioning: row["provisioning"],
            };
          }),
      ),
    listExpiredUnverifiedWorkspaces: (cutoff, limit) =>
      invoke(
        () => binding.listExpiredUnverifiedWorkspaces({ cutoff, limit }),
        (raw) =>
          (Array.isArray(raw) ? raw : invalid()).map((row: unknown) => {
            if (typeof row !== "object" || row === null) return invalid();
            const value = row as Record<string, unknown>;
            if (
              typeof value["organizationId"] !== "string" ||
              typeof value["domainId"] !== "string" ||
              typeof value["expectedRevision"] !== "number" ||
              !Number.isSafeInteger(value["expectedRevision"]) ||
              value["expectedRevision"] < 1
            )
              return invalid();
            return {
              organizationId: parseUlid(value["organizationId"]),
              domainId: parseUlid(value["domainId"]),
              expectedRevision: value["expectedRevision"],
            };
          }),
      ),
    claimWorkspace: (organizationId, domainId, now) =>
      invoke(() => binding.claimWorkspace({ organizationId, domainId, now }), boolean),
  };
}
