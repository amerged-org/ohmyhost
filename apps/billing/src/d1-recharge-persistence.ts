import type { Clock } from "@ohmyhost/platform";
import { parseUlid } from "@ohmyhost/platform";
import { assertRecharge, type RechargeView } from "@ohmyhost/contracts/billing";
import { call, integer, invalid, keys, nullableText, record, text } from "./d1-persistence.js";
import type { BillingRuntimeBinding } from "./d1-persistence.js";
import type { BillingConfiguration, RechargePolicy, RechargeStatus } from "./types.js";

export interface RechargeRuntimeBinding extends BillingRuntimeBinding {
  readRechargePolicy(input: unknown): Promise<unknown>;
  readRecharge(input: unknown): Promise<unknown>;
  configureRecharge(input: unknown): Promise<unknown>;
  claimRecharge(input: unknown): Promise<unknown>;
  saveRechargeSetup(input: unknown): Promise<unknown>;
  transitionRechargePolicy(input: unknown): Promise<unknown>;
  listRechargeCandidates(input: unknown): Promise<unknown>;
}
export const RECHARGE_RUNTIME_METHODS = [
  "readRechargePolicy",
  "readRecharge",
  "configureRecharge",
  "claimRecharge",
  "saveRechargeSetup",
  "transitionRechargePolicy",
  "listRechargeCandidates",
] as const satisfies readonly (keyof RechargeRuntimeBinding)[];

export type RechargeTransition =
  | "reconciliation"
  | "payment_required"
  | "tax_required"
  | "on"
  | "monthly_limit";

export interface RechargePersistence {
  readPolicy(organizationId: string): Promise<RechargePolicy | null>;
  readView(organizationId: string): Promise<RechargeView>;
  configure(input: {
    organizationId: string;
    actorId: string;
    idempotencyKey: string;
    enabled: boolean;
    monthlyLimitMinor: number;
    consent: string | null;
    revision: number;
    id: string;
  }): Promise<RechargeView>;
  saveSetup(
    organizationId: string,
    revision: number,
    setup: { sessionId: string | null; paymentMethodId: string | null; expired: boolean },
  ): Promise<void>;
  /** Leases the organization for this look; null when somebody else has it or recharge is off. */
  claim(organizationId: string): Promise<{
    policy: RechargePolicy;
    /** A new recharge invoice is due. */
    create: boolean;
    /** What the monthly limit still allows to spend this month, in minor units. */
    remainingMinor: number;
  } | null>;
  transitionPolicy(
    organizationId: string,
    kind: RechargeTransition,
    revision?: number,
  ): Promise<void>;
  candidates(): Promise<{ organization_id: string }[]>;
}

const STATUSES: readonly RechargeStatus[] = [
  "off",
  "setup_required",
  "on",
  "payment_required",
  "monthly_limit",
  "needs_reconciliation",
  "tax_required",
];
function date(value: unknown): Date {
  const textValue = text(value),
    result = new Date(textValue);
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== textValue) throw invalid();
  return result;
}
function policy(value: unknown): RechargePolicy {
  const row = record(value);
  keys(row, [
    "organization_id",
    "account_id",
    "mode",
    "enabled",
    "revision",
    "monthly_limit_minor",
    "status",
    "setup_id",
    "setup_session_id",
    "payment_method_id",
    "updated_at",
    "checked_at",
  ]);
  const status = STATUSES.find((candidate) => candidate === row["status"]),
    mode = row["mode"];
  if (
    status === undefined ||
    (mode !== "test" && mode !== "live") ||
    typeof row["enabled"] !== "boolean"
  )
    throw invalid();
  return {
    organization_id: parseUlid(text(row["organization_id"])),
    account_id: text(row["account_id"]),
    mode,
    enabled: row["enabled"],
    revision: integer(row["revision"]),
    monthly_limit_minor: integer(row["monthly_limit_minor"]),
    status,
    setup_id: parseUlid(text(row["setup_id"])),
    setup_session_id: nullableText(row["setup_session_id"]),
    payment_method_id: nullableText(row["payment_method_id"]),
    updated_at: date(row["updated_at"]),
    checked_at: row["checked_at"] === null ? null : date(row["checked_at"]),
  };
}
function receipt(value: unknown) {
  const row = record(value);
  keys(row, ["recorded"]);
  if (row["recorded"] !== true) throw invalid();
}

/** Domain objects only cross the real private binding; no SQL or closures. */
export function createD1RechargePersistence(
  binding: RechargeRuntimeBinding,
  configuration: BillingConfiguration,
  clock: Clock,
): RechargePersistence {
  const rpc = binding as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const scope = (organizationId: string) => ({
    organizationId,
    accountId: configuration.accountId,
    mode: configuration.mode,
    now: clock.now().toISOString(),
  });
  return {
    async readPolicy(organizationId) {
      const value = await call(rpc, "readRechargePolicy", scope(organizationId));
      return value === null ? null : policy(value);
    },
    async readView(organizationId) {
      const value = await call(rpc, "readRecharge", scope(organizationId));
      assertRecharge(value);
      return value;
    },
    async configure(input) {
      const value = await call(rpc, "configureRecharge", {
        ...scope(input.organizationId),
        ...input,
      });
      assertRecharge(value);
      return value;
    },
    async saveSetup(organizationId, revision, setup) {
      receipt(
        await call(rpc, "saveRechargeSetup", {
          ...scope(organizationId),
          revision,
          sessionId: setup.sessionId,
          paymentMethodId: setup.paymentMethodId,
          expired: setup.expired,
        }),
      );
    },
    async claim(organizationId) {
      const value = await call(rpc, "claimRecharge", scope(organizationId));
      if (value === null) return null;
      const row = record(value);
      keys(row, ["policy", "create", "remainingMinor"]);
      if (typeof row["create"] !== "boolean" || row["policy"] === null) throw invalid();
      return {
        policy: policy(row["policy"]),
        create: row["create"],
        remainingMinor: Number(row["remainingMinor"]),
      };
    },
    async transitionPolicy(organizationId, kind, revision) {
      receipt(
        await call(rpc, "transitionRechargePolicy", {
          ...scope(organizationId),
          kind,
          ...(revision === undefined ? {} : { revision }),
        }),
      );
    },
    async candidates() {
      const value = await call(rpc, "listRechargeCandidates", {
        accountId: configuration.accountId,
        mode: configuration.mode,
        now: clock.now().toISOString(),
      });
      if (!Array.isArray(value)) throw invalid();
      return value.map((row) => {
        const item = record(row);
        keys(item, ["organization_id"]);
        return { organization_id: parseUlid(text(item["organization_id"])) };
      });
    },
  };
}
