import { z } from "zod";
import { OrganizationCreditError } from "@ohmyhost/database";
import {
  assertOrganizationAccount,
  assertOrganizationCreditUsage,
  type OrganizationCreditUsage,
} from "@ohmyhost/contracts/credit-pricing";
import { BUILD_METER, BUILD_PRICE_VERSION, BUILD_UNIT } from "@ohmyhost/platform/shared";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { CreditManagementPort, OrganizationAccountBody } from "./credits.js";

export interface D1CreditRuntime {
  readCreditAccount(input: unknown): Promise<unknown>;
  readCreditOrganization(input: unknown): Promise<unknown>;
  readCreditUsage(input: unknown): Promise<unknown>;
  readProjectCreditBudgetPublic(input: unknown): Promise<unknown>;
  configureProjectCreditBudget(input: unknown): Promise<unknown>;
}

/** The credit service's private read of the credit log: today's rows from the Core and the 14 rotated days from R2. */
export interface CreditServiceBinding {
  readUsage(input: unknown): Promise<unknown>;
}

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  money = z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/u)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
  instant = z
    .string()
    .refine(
      (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    ),
  budget = z.strictObject({
    project_id: ulid,
    amount_micros: money.nullable(),
    mode: z.enum(["continue", "stop"]),
    used_micros: money,
    reserved_micros: money,
    period_start: instant,
    period_end: instant,
    as_of: instant,
  }),
  credits = z.strictObject({
    organization_id: ulid,
    unit: z.literal("microcredits"),
    as_of: instant,
    available_micros: money,
    reserved_micros: money,
    grace_started_at: instant.nullable(),
    grace_expires_at: instant.nullable(),
  }),
  monthUse = z.strictObject({
    organization_id: ulid,
    as_of: instant,
    unit: z.literal("microcredits"),
    period: z.string().regex(/^20[0-9]{2}-(0[1-9]|1[0-2])$/u),
    projects: z.array(z.strictObject({ project_id: ulid, used_micros: money })),
  }),
  logRow = z.object({
    organizationId: ulid,
    at: z.string(),
    kind: z.string(),
    deltaMicros: z.number(),
    detail: z.unknown(),
  }),
  logLine = z.object({
    projectId: ulid,
    environmentId: ulid.nullable().default(null),
    meter: z.string(),
    unit: z.string(),
    rateCardId: z.string(),
    quantity: z.union([z.string(), z.number()]),
    chargeMicros: z.number().int().nonnegative(),
  });
const fail = (): never => {
  throw new Error("credit_core_response_invalid");
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const DAY_MS = 86_400_000;
/** The report covers the current UTC day and the 13 before it: the 14 days the rotated log is kept. */
const REPORT_DAYS = 14;
const QUANTITY_SCALE = 20;

/** A decimal quantity (`1234`, `0.5`) as an integer count of 10^-20 units, so sums stay exact. */
function scaledQuantity(value: string | number): bigint {
  const text = typeof value === "number" ? String(value) : value;
  const match = /^(\d{1,30})(?:\.(\d{1,20}))?$/u.exec(text);
  if (match === null) return fail();
  return (
    BigInt(match[1] as string) * 10n ** BigInt(QUANTITY_SCALE) +
    BigInt((match[2] ?? "").padEnd(QUANTITY_SCALE, "0"))
  );
}

function quantityText(scaled: bigint): string {
  const whole = scaled / 10n ** BigInt(QUANTITY_SCALE);
  const fraction = (scaled % 10n ** BigInt(QUANTITY_SCALE))
    .toString()
    .padStart(QUANTITY_SCALE, "0")
    .replace(/0+$/u, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * A settlement charged to the project of its reservation. Its quantity is `quantity`, else the build's `seconds`, else
 * zero; its unit is `unit` (a build's default is seconds). A build writes `seconds` only, so it reads as before.
 */
const settlement = z
  .object({
    projectId: ulid.nullable(),
    environmentId: ulid.nullable().default(null),
    chargedMicros: z.number().int().nonnegative(),
    meter: z.string().default(BUILD_METER),
    unit: z.string().default(BUILD_UNIT),
    rateCardId: z.string().default(BUILD_PRICE_VERSION),
    quantity: z.union([z.string(), z.number()]).optional(),
    seconds: z.union([z.string(), z.number()]).optional(),
  })
  .transform((detail) => ({
    ...detail,
    quantity: detail.quantity ?? detail.seconds ?? "0",
  }));
const usagePosting = z.object({ lines: z.array(logLine).optional() });
/** A mail charge is posted with its flat detail and no lines: that detail is its one line. */
const flatUsage = z.object({
  projectId: ulid,
  environmentId: ulid.nullable().default(null),
  meter: z.string(),
  unit: z.string(),
  rateCardId: z.string(),
  quantity: z.union([z.string(), z.number()]),
  chargeMicros: z.number().int().nonnegative(),
});

/**
 * The charges of one credit-log row: the lines of a usage posting (or its flat detail when it has no lines), or what a
 * settlement charged. A refund is not a charge here: the report shows what was charged on each day, and a refund only
 * reduces the month's use (`projects[].used_micros`). A flat detail this release cannot read is skipped and logged, so
 * it does not fail the report of every other charge.
 */
function chargesOf(row: z.infer<typeof logRow>): z.infer<typeof logLine>[] {
  if (row.kind === "usage") {
    const posting = usagePosting.parse(row.detail ?? {});
    if (posting.lines !== undefined) return posting.lines;
    if (!("meter" in Object(row.detail))) return [];
    const flat = flatUsage.safeParse(row.detail);
    if (flat.success) return [flat.data];
    console.log(
      JSON.stringify({
        event: "credit_usage_row_skipped",
        kind: row.kind,
        day: row.at.slice(0, 10),
        reason: "flat_usage_unreadable",
      }),
    );
    return [];
  }
  if (row.kind !== "settle") return [];
  const detail = settlement.parse(row.detail ?? {});
  return detail.projectId === null
    ? []
    : [
        {
          projectId: detail.projectId,
          environmentId: detail.environmentId,
          meter: detail.meter,
          unit: detail.unit,
          rateCardId: detail.rateCardId,
          quantity: detail.quantity,
          chargeMicros: detail.chargedMicros,
        },
      ];
}

type Meters = OrganizationCreditUsage["days"][number]["projects"][number]["meters"];

const order = (left: readonly string[], right: readonly string[]): number => {
  const at = left.findIndex((part, index) => part !== right[index]);
  return at === -1 ? 0 : (left[at] as string) < (right[at] as string) ? -1 : 1;
};

/**
 * The charges of the credit-log rows grouped by UTC day, project and meter, oldest day first and a shared project cost
 * (no environment) before the environments. Grants, renewals and reservations are no usage; a charge counts on the day
 * its row is filed under.
 */
export function groupUsageDays(
  rows: readonly unknown[],
  projectId?: string,
): OrganizationCreditUsage["days"] {
  const groups = new Map<
    string,
    { key: string[]; line: z.infer<typeof logLine>; quantity: bigint; charged: number }
  >();
  for (const input of rows) {
    const row = logRow.parse(input);
    for (const line of chargesOf(row)) {
      if (projectId !== undefined && line.projectId !== projectId) continue;
      const key = [
        row.at.slice(0, 10),
        line.projectId,
        line.environmentId ?? "",
        line.meter,
        line.unit,
        line.rateCardId,
      ];
      const group = groups.get(JSON.stringify(key)) ?? { key, line, quantity: 0n, charged: 0 };
      group.quantity += scaledQuantity(line.quantity);
      group.charged += line.chargeMicros;
      groups.set(JSON.stringify(key), group);
    }
  }
  const days = new Map<string, Map<string, Meters>>();
  for (const { key, line, quantity, charged } of [...groups.values()].sort((left, right) =>
    order(left.key, right.key),
  )) {
    const day = key[0] as string;
    const projects = days.get(day) ?? new Map<string, Meters>();
    const meters = projects.get(line.projectId) ?? [];
    meters.push({
      environment_id: line.environmentId,
      meter: line.meter,
      unit: line.unit,
      rate_card_id: line.rateCardId,
      quantity: quantityText(quantity),
      charged_micros: String(charged),
    });
    projects.set(line.projectId, meters);
    days.set(day, projects);
  }
  return [...days].map(([day, projects]) => ({
    day,
    projects: [...projects].map(([project, meters]) => ({ project_id: project, meters })),
  }));
}

/** The existing public credit port over named capabilities of the Core and the credit service; no SQL, no fallback. */
export function createD1CreditManagement(input: {
  runtime: D1CreditRuntime;
  /** Absent in a Worker without the credit service: only the usage report needs it, and it names the binding. */
  service?: CreditServiceBinding | undefined;
  clock: Clock;
  ids: UlidFactory;
}): CreditManagementPort {
  const { runtime, service, clock, ids } = input;
  for (const method of [
    "readCreditAccount",
    "readCreditOrganization",
    "readCreditUsage",
    "readProjectCreditBudgetPublic",
    "configureProjectCreditBudget",
  ] as const)
    if (typeof runtime?.[method] !== "function") throw new Error("credit_core_binding_required");
  return {
    async readUsage(organizationId, projectId) {
      if (typeof service?.readUsage !== "function")
        throw new Error("credit_service_binding_required");
      const nowDate = clock.now(),
        now = nowDate.toISOString(),
        from = new Date(
          Math.floor(nowDate.getTime() / DAY_MS) * DAY_MS - (REPORT_DAYS - 1) * DAY_MS,
        ).toISOString();
      const [use, log] = await Promise.all([
        runtime.readCreditUsage({ organizationId, now, ...(projectId ? { projectId } : {}) }),
        service.readUsage({ organizationId, from, to: now }),
      ]);
      const month = monthUse.parse(use);
      if (
        month.organization_id !== organizationId ||
        month.as_of !== now ||
        !Array.isArray(log) ||
        log.some((row) => Object(row).organizationId !== organizationId) ||
        (projectId && month.projects.some((row) => row.project_id !== projectId))
      )
        return fail();
      const report = {
        organization_id: organizationId,
        as_of: now,
        unit: "microcredits" as const,
        period: month.period,
        from,
        projects: month.projects,
        days: groupUsageDays(log, projectId),
      };
      assertOrganizationCreditUsage(report);
      return report;
    },
    async readOrganization(organizationId) {
      const now = clock.now().toISOString(),
        balance = credits.parse(await runtime.readCreditOrganization({ organizationId, now }));
      if (balance.organization_id !== organizationId || balance.as_of !== now) return fail();
      return balance;
    },
    async readAccount(organizationId) {
      const now = clock.now().toISOString(),
        value = await runtime.readCreditAccount({ organizationId, now });
      assertOrganizationAccount(value);
      const account = value as OrganizationAccountBody;
      if (account.organization_id !== organizationId || account.as_of !== now) return fail();
      return account;
    },
    async readBudget(context) {
      const now = clock.now().toISOString(),
        body = budget.parse(
          await runtime.readProjectCreditBudgetPublic({
            organizationId: context.organizationId,
            projectId: context.projectId,
            now,
          }),
        );
      if (body.project_id !== context.projectId || body.as_of !== now) return fail();
      return { status: 200 as const, body };
    },
    async setBudget(context) {
      const now = clock.now().toISOString(),
        written = await runtime
          .configureProjectCreditBudget({
            organizationId: context.organizationId,
            projectId: context.projectId,
            principalId: context.principalId,
            requestId: context.requestId,
            idempotencyKey: context.idempotencyKey,
            canonicalRequestDigest: hex(context.canonicalRequestDigest),
            amountMicros: context.amountMicros,
            mode: context.mode,
            now,
            operationId: ids.next(),
            queuedEventId: ids.next(),
            succeededEventId: ids.next(),
            auditEventId: ids.next(),
          })
          // The Core's refusals cross the service binding as plain errors. A key conflict is answered as one; a project
          // that is no longer active is absent for this write, so the route answers it as not found.
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === "organization_credit_scope_missing")
              return null;
            throw error instanceof Error && error.message === "credit_request_conflict"
              ? new OrganizationCreditError("credit_request_conflict")
              : error;
          });
      if (written === null) return null;
      const body = budget.parse(written);
      // A replay retains its original as_of; it must never be rewritten to this retry's clock.
      if (body.project_id !== context.projectId) return fail();
      return { status: 200 as const, body };
    },
  };
}
