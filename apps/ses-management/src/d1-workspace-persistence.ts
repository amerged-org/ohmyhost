import { parseUlid } from "@ohmyhost/platform";
import {
  OrganizationCreditError,
  SharedMailDomainError,
  type WorkspaceMailDomainView,
} from "@ohmyhost/database";
import type { WorkspaceProviderRow } from "./workspace-mail-runtime.js";

type Scope = { organizationId: string; domainId: string };
type WorkspaceResourceChange =
  | {
      action: "observe";
      providerDomainId: string;
      records: readonly unknown[];
      sendingStatus: "ready" | "failed" | "pending";
    }
  | { action: "claimDns" | "releaseDns"; leaseToken: string }
  | {
      action:
        | "recoverKey"
        | "claimKey"
        | "clearKey"
        | "resetCreation"
        | "claimCreation"
        | "releaseUnpreparedCreation"
        | "recordPreflight"
        | "clearCreation"
        | "claimVerification";
    }
  | {
      action: "saveKey";
      keyId: string;
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      valueSha256: Uint8Array;
      keyVersion: number;
    }
  | { action: "recordFound"; providerDomainId: string }
  | { action: "clearVerification"; providerDomainId: string };
export interface WorkspaceMailManagementPersistence {
  load(scope: Scope): Promise<WorkspaceProviderRow>;
  view(scope: Scope): Promise<WorkspaceMailDomainView>;
  requirePaid(organizationId: string, now: () => string): Promise<void>;
  change(scope: Scope, change: WorkspaceResourceChange, now: () => string): Promise<boolean>;
  beginRetirement(
    scope: Scope & { expectedRevision: number },
    now: () => Date,
  ): Promise<WorkspaceProviderRow>;
  finishRetirement(scope: Scope, now: () => string): Promise<void>;
}

interface WorkspaceMailManagementBinding {
  readResource(input: unknown): Promise<unknown>;
  readView(input: unknown): Promise<unknown>;
  change(input: unknown): Promise<unknown>;
  beginRetirement(input: unknown): Promise<unknown>;
  finishRetirement(input: unknown): Promise<unknown>;
  requirePaid(input: unknown): Promise<unknown>;
}
const COLUMNS =
    "domain_id,organization_id,domain,legacy_domain_id,status,revision,custody_organization_id,custody_project_id,custody_environment_id,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,records".split(
      ",",
    ),
  TIMES = new Set([
    "provider_claimed_at",
    "provider_preflight_at",
    "verify_requested_at",
    "sending_key_claimed_at",
  ]),
  NULLABLE = new Set([
    "legacy_domain_id",
    "provider_domain_id",
    "provider_claimed_at",
    "provider_preflight_at",
    "verify_requested_at",
    "sending_key_id",
    "sending_key_claimed_at",
  ]);
function invalid(): never {
  throw new TypeError("workspace_mail_response_invalid");
}
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function resource(value: unknown): WorkspaceProviderRow | null {
  if (value === null) return null;
  if (!object(value, COLUMNS)) return invalid();
  const result: Record<string, unknown> = {};
  for (const column of COLUMNS) {
    const v = value[column];
    if (v === null) {
      if (!NULLABLE.has(column)) return invalid();
      result[column] = null;
      continue;
    }
    if (typeof v !== "string") return invalid();
    if (TIMES.has(column)) {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(v) ||
        !Number.isFinite(Date.parse(v))
      )
        return invalid();
      result[column] = new Date(v);
    } else if (column === "revision") {
      if (!/^[1-9][0-9]*$/u.test(v) || BigInt(v) > 9223372036854775807n) return invalid();
      result[column] = v;
    } else if (column === "records") {
      let rows: unknown;
      try {
        rows = JSON.parse(v);
      } catch {
        return invalid();
      }
      if (!Array.isArray(rows)) return invalid();
      result[column] = rows;
    } else if (column.endsWith("_id") && !["provider_domain_id", "sending_key_id"].includes(column))
      result[column] = parseUlid(v);
    else result[column] = v;
  }
  if (!["active", "retiring", "retired"].includes(String(result["status"]))) return invalid();
  return result as unknown as WorkspaceProviderRow;
}
const required = (value: unknown) => {
  const row = resource(value);
  if (!row) throw new Error("mail_scope_unavailable");
  return row;
};
function view(value: unknown): WorkspaceMailDomainView {
  if (
    !object(value, [
      "domain_id",
      "organization_id",
      "domain",
      "registrable_domain",
      "revision",
      "status",
      "sending",
      "receiving",
      "configured_at",
      "observed_at",
      "dns_records",
      "bindings_count",
    ])
  )
    return invalid();
  for (const key of ["domain_id", "organization_id"]) parseUlid(String(value[key]));
  for (const key of ["domain", "registrable_domain", "configured_at"])
    if (typeof value[key] !== "string") return invalid();
  if (
    typeof value["revision"] !== "number" ||
    !Number.isInteger(value["revision"]) ||
    value["revision"] < 1 ||
    typeof value["bindings_count"] !== "number" ||
    !Number.isInteger(value["bindings_count"]) ||
    value["bindings_count"] < 0 ||
    value["bindings_count"] > 2147483647 ||
    !Array.isArray(value["dns_records"])
  )
    return invalid();
  if (
    !["active", "retiring", "retired"].includes(String(value["status"])) ||
    !["ready", "failed", "disabled", "pending"].includes(String(value["sending"])) ||
    !["ready", "failed", "disabled", "pending"].includes(String(value["receiving"]))
  )
    return invalid();
  for (const key of ["configured_at", "observed_at"])
    if (
      value[key] !== null &&
      (typeof value[key] !== "string" ||
        !Number.isFinite(Date.parse(value[key])) ||
        new Date(value[key]).toISOString() !== value[key])
    )
      return invalid();
  return value as unknown as WorkspaceMailDomainView;
}
const boolean = (value: unknown) => (typeof value === "boolean" ? value : invalid()),
  empty = (value: unknown) => (value === undefined ? undefined : invalid());
const CODES = [
  "mail_scope_unavailable",
  "mail_domain_in_use",
  "mail_resource_revision_conflict",
  "mail_operation_pending",
  "paid_plan_required",
  "insufficient_organization_credits",
  "organization_credit_scope_missing",
  "store_busy",
  "store_outcome_unknown",
] as const;
async function invoke<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "",
      code = CODES.find((v) => message === v || message.endsWith(`: ${v}`));
    if (code === undefined) throw new Error("workspace_mail_unavailable");
    if (code === "mail_domain_in_use") throw new SharedMailDomainError(code);
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
  return parse(raw);
}
const CLOCKED = new Set([
  "observe",
  "claimDns",
  "recoverKey",
  "claimKey",
  "claimCreation",
  "recordPreflight",
  "claimVerification",
]);
function changeWire(value: WorkspaceResourceChange) {
  return value.action !== "saveKey"
    ? value
    : {
        ...value,
        ciphertext: Buffer.from(value.ciphertext).toString("hex"),
        nonce: Buffer.from(value.nonce).toString("hex"),
        valueSha256: Buffer.from(value.valueSha256).toString("hex"),
      };
}
const scopeWire = (value: { organizationId: string; domainId: string }) => ({
  organizationId: value.organizationId,
  domainId: value.domainId,
});
/** Narrow native/adopted workspace resource commands; no provider credential, cipher or supplier crosses RPC. */
export async function createD1WorkspaceMailManagementPersistence(
  raw: unknown,
): Promise<WorkspaceMailManagementPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    [
      "readResource",
      "readView",
      "change",
      "beginRetirement",
      "finishRetirement",
      "requirePaid",
    ].some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("workspace_mail_binding_required");
  const binding = raw as WorkspaceMailManagementBinding;
  if (
    (await invoke(
      () =>
        binding.readResource({
          organizationId: "00000000000000000000000000",
          domainId: "00000000000000000000000000",
        }),
      resource,
    )) !== null
  )
    return invalid();
  return {
    load: (scope) => invoke(() => binding.readResource(scopeWire(scope)), required),
    view: (scope) => invoke(() => binding.readView(scopeWire(scope)), view),
    requirePaid: (organizationId, now) =>
      invoke(() => binding.requirePaid({ organizationId, now: now() }), empty),
    change: (scope, value, now) =>
      invoke(
        () =>
          binding.change({
            ...scopeWire(scope),
            change: changeWire(value),
            ...(CLOCKED.has(value.action) ? { now: now() } : {}),
          }),
        boolean,
      ),
    beginRetirement: (scope, now) =>
      invoke(
        () =>
          binding.beginRetirement({
            ...scopeWire(scope),
            expectedRevision: scope.expectedRevision,
            now: now().toISOString(),
          }),
        required,
      ),
    finishRetirement: (scope, now) =>
      invoke(() => binding.finishRetirement({ ...scopeWire(scope), now: now() }), empty),
  };
}
