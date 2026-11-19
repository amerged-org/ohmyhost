import { parseUlid } from "@ohmyhost/platform";
import {
  OrganizationCreditError,
  ResendMailScopeError,
  type configureResendMailDomain,
  type MailScope,
  type ResendMailDomainRow,
  type saveResendDomainObservation,
  type saveResendSendingKey,
} from "@ohmyhost/database";

type ResendResourceChange =
  | {
      action: "claimCreation" | "recordPreflight" | "claimVerification" | "claimKey" | "recoverKey";
      domainId: string;
    }
  | { action: "resetUnpreparedCreation"; domainId: string; expectedClaimedAt: Date }
  | { action: "clearCreation" | "clearKey"; domainId: string }
  | { action: "releaseKeyRecovery"; domainId: string; expectedClaimedAt: string }
  | { action: "clearVerification"; domainId: string; providerDomainId: string }
  | {
      action: "saveObservation";
      value: Omit<Parameters<typeof saveResendDomainObservation>[1], "now">;
    }
  | { action: "saveKey"; value: Parameters<typeof saveResendSendingKey>[1] }
  | { action: "recordFound"; domainId: string; providerDomainId: string }
  | { action: "prepareWebhook"; domainId: string; url: string }
  | { action: "verifyWebhook"; domainId: string; url: string }
  | { action: "disableReceiving"; domainId: string }
  | { action: "rotateWebhookSecret"; domainId: string }
  | { action: "finishRetirement"; domainId: string };
export interface ResendManagementPersistence {
  read(
    scope: MailScope | { organizationId: string; projectId: string },
    receivingOwner?: boolean,
  ): Promise<ResendMailDomainRow | null>;
  custody(input: { organizationId: string; domainId: string }): Promise<ResendMailDomainRow | null>;
  receivingOwner(scope: MailScope, domainId: string): Promise<boolean>;
  workspaceStatus(domainId: string): Promise<string | null>;
  liveName(domain: string): Promise<boolean>;
  legacy(
    scope: { organizationId: string; domainId: string },
    status: "active" | "retiring",
  ): Promise<ResendMailDomainRow | null>;
  retireLegacy(
    scope: { organizationId: string; domainId: string },
    now: () => string,
  ): Promise<ResendMailDomainRow>;
  requirePaid(organizationId: string, now: () => string): Promise<void>;
  receivingAdmission(scope: MailScope, now: () => string): Promise<void>;
  configure(
    input: () => Omit<Parameters<typeof configureResendMailDomain>[1], "now">,
    now: () => string,
  ): Promise<ResendMailDomainRow>;
  retire(
    input: MailScope & { idempotencyKey: string },
    now: () => string,
  ): Promise<ResendMailDomainRow>;
  change(input: ResendResourceChange, now: () => string): Promise<boolean>;
}

interface MailManagementBinding {
  readDomain(input: unknown): Promise<unknown>;
  readCustody(input: unknown): Promise<unknown>;
  readLegacy(input: unknown): Promise<unknown>;
  readWorkspaceStatus(input: unknown): Promise<unknown>;
  isReceivingOwner(input: unknown): Promise<unknown>;
  hasLiveName(input: unknown): Promise<unknown>;
  retireLegacy(input: unknown): Promise<unknown>;
  requirePaid(input: unknown): Promise<unknown>;
  admitReceiving(input: unknown): Promise<unknown>;
  configure(input: unknown): Promise<unknown>;
  retire(input: unknown): Promise<unknown>;
  change(input: unknown): Promise<unknown>;
}
const COLUMNS =
  "webhook_secret_generation,domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending,receiving,receiving_suspended,last_entitlement_check_at,last_reconcile_at,sending_status,receiving_status,records,dns_receipts,webhook_url,webhook_verified_at,configured_at,observed_at,deleted_at".split(
    ",",
  );
const TIMES = new Set([
    "provider_claimed_at",
    "provider_preflight_at",
    "verify_requested_at",
    "sending_key_claimed_at",
    "last_entitlement_check_at",
    "last_reconcile_at",
    "webhook_verified_at",
    "configured_at",
    "observed_at",
    "deleted_at",
  ]),
  BLOBS = new Set(["sending_key_ciphertext", "sending_key_nonce", "sending_key_sha256"]),
  BOOLS = new Set(["sending", "receiving", "receiving_suspended"]);
const NULLABLE = new Set(
  "provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,last_entitlement_check_at,last_reconcile_at,webhook_url,webhook_verified_at,observed_at,deleted_at".split(
    ",",
  ),
);
function invalid(): never {
  throw new TypeError("mail_management_response_invalid");
}
function resource(raw: unknown): ResendMailDomainRow | null {
  if (raw === null) return null;
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== [...COLUMNS].sort().join(",")
  )
    return invalid();
  const value = raw as Record<string, unknown>,
    result: Record<string, unknown> = {};
  for (const column of COLUMNS) {
    const v = value[column];
    if (v === null) {
      if (!NULLABLE.has(column)) return invalid();
      result[column] = null;
      continue;
    }
    if (TIMES.has(column)) {
      if (
        typeof v !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(v) ||
        !Number.isFinite(Date.parse(v))
      )
        return invalid();
      result[column] = new Date(v);
    } else if (BLOBS.has(column)) {
      if (typeof v !== "string" || !/^(?:[a-f0-9]{2})*$/u.test(v)) return invalid();
      result[column] = Buffer.from(v, "hex");
    } else if (BOOLS.has(column)) {
      if (v !== 0 && v !== 1) return invalid();
      result[column] = v === 1;
    } else if (column === "sending_key_version") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 2147483647)
        return invalid();
      result[column] = v;
    } else if (column === "webhook_secret_generation") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 2147483647)
        return invalid();
      result[column] = v;
    } else if (column === "records" || column === "dns_receipts") {
      if (typeof v !== "string") return invalid();
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        return invalid();
      }
      if (
        column === "records"
          ? !Array.isArray(parsed)
          : typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      )
        return invalid();
      result[column] = parsed;
    } else {
      if (typeof v !== "string") return invalid();
      result[column] = ["domain_id", "organization_id", "project_id", "environment_id"].includes(
        column,
      )
        ? parseUlid(v)
        : v;
    }
  }
  if (
    !(result["configured_at"] instanceof Date) ||
    !["disabled", "pending", "ready", "failed"].includes(String(result["sending_status"])) ||
    !["disabled", "pending", "ready", "failed"].includes(String(result["receiving_status"]))
  )
    return invalid();
  return result as unknown as ResendMailDomainRow;
}
const required = (raw: unknown) => resource(raw) ?? invalid();
const boolean = (raw: unknown) => (typeof raw === "boolean" ? raw : invalid());
const empty = (raw: unknown) => (raw === undefined ? undefined : invalid());
const ERRORS = [
  "paid_plan_required",
  "insufficient_organization_credits",
  "project_budget_exceeded",
  "organization_credit_scope_missing",
  "credit_request_conflict",
  "mail_scope_unavailable",
  "mail_domain_conflict",
  "mail_retirement_pending",
  "mail_operation_pending",
  "mail_domain_creation_unresolved",
  "mail_webhook_changed",
  "mail_pricing_unavailable",
  "Invalid mail input",
  "Mail domain receipt conflict",
  "store_busy",
  "store_outcome_unknown",
] as const;
async function invoke<T>(run: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let value;
  try {
    value = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "",
      code = ERRORS.find((v) => message === v || message.endsWith(`: ${v}`));
    if (code === undefined) throw new Error("mail_management_unavailable");
    if (
      code === "paid_plan_required" ||
      code === "insufficient_organization_credits" ||
      code === "project_budget_exceeded" ||
      code === "organization_credit_scope_missing" ||
      code === "credit_request_conflict"
    )
      throw new OrganizationCreditError(code);
    if (code === "mail_scope_unavailable" || code === "mail_domain_conflict")
      throw new ResendMailScopeError(code);
    throw Object.assign(new Error(code), { code });
  }
  return parse(value);
}
function changeWire(input: ResendResourceChange) {
  if (input.action === "resetUnpreparedCreation")
    return { ...input, expectedClaimedAt: input.expectedClaimedAt.toISOString() };
  if (input.action !== "saveKey") return input;
  return {
    ...input,
    value: {
      ...input.value,
      ciphertext: Buffer.from(input.value.ciphertext).toString("hex"),
      nonce: Buffer.from(input.value.nonce).toString("hex"),
      valueSha256: Buffer.from(input.value.valueSha256).toString("hex"),
    },
  };
}
const mailScopeWire = (value: {
  organizationId: string;
  projectId: string;
  environmentId?: string;
}) => ({
  organizationId: value.organizationId,
  projectId: value.projectId,
  ...(value.environmentId === undefined ? {} : { environmentId: value.environmentId }),
});
const resourceScopeWire = (value: { organizationId: string; domainId: string }) => ({
  organizationId: value.organizationId,
  domainId: value.domainId,
});
/** Actual manager persistence. Provider/cipher transports and every local supplier stay in the Worker. */
export async function createD1ResendManagementPersistence(
  raw: unknown,
): Promise<ResendManagementPersistence> {
  const methods = [
    "readDomain",
    "readCustody",
    "readLegacy",
    "readWorkspaceStatus",
    "isReceivingOwner",
    "hasLiveName",
    "retireLegacy",
    "requirePaid",
    "admitReceiving",
    "configure",
    "retire",
    "change",
  ];
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    methods.some((name) => typeof Reflect.get(raw, name) !== "function")
  )
    throw new Error("mail_management_binding_required");
  const binding = raw as MailManagementBinding;
  if (
    (await invoke(
      () =>
        binding.readDomain({
          organizationId: "00000000000000000000000000",
          projectId: "00000000000000000000000000",
        }),
      resource,
    )) !== null
  )
    return invalid();
  return {
    read: (scope, receivingOwner = false) =>
      invoke(() => binding.readDomain({ ...mailScopeWire(scope), receivingOwner }), resource),
    custody: (input) => invoke(() => binding.readCustody(resourceScopeWire(input)), resource),
    receivingOwner: (scope, domainId) =>
      invoke(() => binding.isReceivingOwner({ ...mailScopeWire(scope), domainId }), boolean),
    workspaceStatus: (domainId) =>
      invoke(
        () => binding.readWorkspaceStatus({ domainId }),
        (value) => (value === null || typeof value === "string" ? value : invalid()),
      ),
    liveName: (domain) => invoke(() => binding.hasLiveName({ domain }), boolean),
    legacy: (scope, status) =>
      invoke(() => binding.readLegacy({ ...resourceScopeWire(scope), status }), resource),
    retireLegacy: (scope, now) =>
      invoke(() => binding.retireLegacy({ ...resourceScopeWire(scope), now: now() }), required),
    requirePaid: (organizationId, now) =>
      invoke(() => binding.requirePaid({ organizationId, now: now() }), empty),
    receivingAdmission: (scope, now) =>
      invoke(() => binding.admitReceiving({ ...mailScopeWire(scope), now: now() }), empty),
    configure: (input, now) =>
      invoke(() => {
        const value = input();
        return binding.configure({
          ...mailScopeWire(value),
          domainId: value.domainId,
          domain: value.domain,
          sending: value.sending,
          receiving: value.receiving,
          webhookUrl: value.webhookUrl,
          now: now(),
        });
      }, required),
    retire: (input, now) =>
      invoke(
        () =>
          binding.retire({
            ...mailScopeWire(input),
            idempotencyKey: input.idempotencyKey,
            now: now(),
          }),
        required,
      ),
    change: (input, now) =>
      invoke(
        () =>
          binding.change({
            change: changeWire(input),
            ...([
              "claimCreation",
              "recordPreflight",
              "claimVerification",
              "claimKey",
              "recoverKey",
              "saveObservation",
              "verifyWebhook",
              "finishRetirement",
            ].includes(input.action)
              ? { now: now() }
              : {}),
          }),
        boolean,
      ),
  };
}
