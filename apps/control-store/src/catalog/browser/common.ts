import { z } from "zod";
import {
  BROWSER_METER,
  BROWSER_METER_UNIT,
  type BrowserCardRate,
  type BrowserKeyScope,
} from "@ohmyhost/platform/shared";
import type { D1Database } from "../../d1-types.js";
import { ulid } from "../common.js";

export const browserBillingScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
});
export const browserScope = browserBillingScope.extend({
  keySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  keyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deploymentId: ulid,
  revisionId: ulid,
  ownershipVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  billingEpochId: ulid,
});
export const browserReservationId = ulid;
export function browserInput<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
): z.output<Schema> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new TypeError("Invalid browser gateway input");
  return result.data;
}
export async function coreClock(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') now")
    .first<{ now: string }>();
  if (row === null) throw new Error("browser_unavailable");
  return row.now;
}
export interface BrowserPrice {
  readonly card: string;
  readonly activationStart: string;
  readonly providerCostMicros: bigint;
  readonly rate: BrowserCardRate;
}
export async function readBrowserPrice(db: D1Database, at: string): Promise<BrowserPrice | null> {
  const row = await db
    .prepare(
      `SELECT json_object('card',c.rate_card_id,'activation',a.starts_at,'rate',json(r.value)) price
 FROM usage_meter_activations a JOIN published_credit_rate_cards c ON c.rate_card_id=a.rate_card_id,json_each(c.rates) r
 WHERE a.meter=?1 AND a.starts_at<=?2 AND c.published_at<=?2 AND json_extract(r.value,'$.meter')=?1 AND json_extract(r.value,'$.unit')=?3
 ORDER BY a.starts_at DESC LIMIT 1`,
    )
    .bind(BROWSER_METER, at, BROWSER_METER_UNIT)
    .first<{ price: string }>();
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.price) as {
      card: string;
      activation: string;
      rate: {
        units_per_charge: string;
        provider_cost_micros: string | null;
        credit_micros: string;
      };
    };
    if (parsed.rate.provider_cost_micros === null) return null;
    const unitsPerCharge = BigInt(parsed.rate.units_per_charge),
      providerCostMicros = BigInt(parsed.rate.provider_cost_micros),
      creditMicros = BigInt(parsed.rate.credit_micros);
    if (
      unitsPerCharge <= 0n ||
      providerCostMicros < 0n ||
      creditMicros !== providerCostMicros * 200n
    )
      return null;
    return {
      card: parsed.card,
      activationStart: parsed.activation,
      providerCostMicros,
      rate: { unitsPerCharge, creditMicros },
    };
  } catch {
    return null;
  }
}
/** The admission-time immutable card and rate, retained even if the hold was swept. */
export async function readPinnedBrowserPrice(
  db: D1Database,
  scope: BrowserReservationScope,
  reservationId: string,
): Promise<BrowserPrice | null> {
  const row = await db
    .prepare(
      `SELECT rate_card_id,activation_start,units_per_charge,provider_cost_micros,credit_micros FROM browser_gateway_reservations WHERE reservation_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4`,
    )
    .bind(reservationId, scope.organizationId, scope.projectId, scope.environmentId)
    .first<{
      rate_card_id: string;
      activation_start: string;
      units_per_charge: string;
      provider_cost_micros: string;
      credit_micros: string;
    }>();
  if (row === null) return null;
  const unitsPerCharge = BigInt(row.units_per_charge),
    providerCostMicros = BigInt(row.provider_cost_micros),
    creditMicros = BigInt(row.credit_micros);
  if (unitsPerCharge <= 0n || providerCostMicros < 0n || creditMicros !== providerCostMicros * 200n)
    throw new Error("browser_price_invalid");
  return {
    card: row.rate_card_id,
    activationStart: row.activation_start,
    providerCostMicros,
    rate: { unitsPerCharge, creditMicros },
  };
}

/** Exact authorization snapshot rechecked inside the reservation transaction. */
export const BROWSER_AUTHORITY_SQL = `SELECT 1 FROM environment_secrets s
 JOIN projects p ON p.organization_id=s.organization_id AND p.project_id=s.project_id
 JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
 JOIN environments e ON e.organization_id=s.organization_id AND e.project_id=s.project_id AND e.environment_id=s.environment_id
 JOIN deployment_revisions r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.deployment_id=e.active_deployment_id AND r.revision_id=e.active_revision_id
 JOIN deployment_plans plan ON plan.organization_id=r.organization_id AND plan.project_id=r.project_id AND plan.plan_id=r.plan_id
 WHERE s.organization_id=?1 AND s.project_id=?2 AND s.environment_id=?3 AND s.name='OHMYHOST_BROWSER_KEY'
 AND s.value_sha256=unhex(?4) AND s.revision=?5 AND e.active_deployment_id=?6 AND e.active_revision_id=?7
 AND p.ownership_version=?8 AND p.active_billing_epoch_id=?9 AND p.owner_state='active' AND p.lifecycle_state='active'
 AND json_extract(plan.framework_plan,'$.browser.enabled')=1
 AND (SELECT COUNT(*) FROM environment_secrets other JOIN projects op ON op.organization_id=other.organization_id AND op.project_id=other.project_id AND op.owner_state<>'transferred'
 WHERE other.project_id=s.project_id AND other.name=s.name AND other.value_sha256=s.value_sha256)=1`;
export function browserAuthorityParameters(scope: BrowserKeyScope): readonly unknown[] {
  return [
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    scope.keySha256,
    scope.keyRevision,
    scope.deploymentId,
    scope.revisionId,
    scope.ownershipVersion,
    scope.billingEpochId,
  ];
}
export async function activeScope(db: D1Database, scope: BrowserKeyScope): Promise<boolean> {
  return (
    (await db
      .prepare(BROWSER_AUTHORITY_SQL)
      .bind(...browserAuthorityParameters(scope))
      .first()) !== null
  );
}

export type BrowserReservationState = "open" | "released" | "swept" | "settled" | "unknown";
export type BrowserReservationScope = Pick<
  BrowserKeyScope,
  "organizationId" | "projectId" | "environmentId"
>;
/** A durable, scoped outcome survives credit-log rotation and makes settlement at most once. */
export async function reservationState(
  db: D1Database,
  scope: BrowserReservationScope,
  reservationId: string,
): Promise<BrowserReservationState> {
  const row = await db
    .prepare(
      "SELECT state FROM browser_gateway_reservations WHERE reservation_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4",
    )
    .bind(reservationId, scope.organizationId, scope.projectId, scope.environmentId)
    .first<{ state: Exclude<BrowserReservationState, "unknown"> }>();
  return row?.state ?? "unknown";
}
export function reservationParameters(
  scope: BrowserReservationScope,
  reservationId: string,
): readonly unknown[] {
  return [reservationId, scope.organizationId, scope.projectId, scope.environmentId];
}
