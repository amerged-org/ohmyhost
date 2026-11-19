import { z } from "zod";
import {
  AI_METER,
  AI_METER_UNIT,
  type AiCardRate,
  type AiKeyScope,
} from "@ohmyhost/platform/shared";
import type { D1Database } from "../../d1-types.js";
import { ulid } from "../common.js";

// What the AI gateway needs of the Core: the input contracts, the Core clock, the active price and the ownership of a
// reservation. The money itself is the credit core's (`runReserve`, `runSettleReservation`, `runReleaseReservation`).

export const aiJurisdiction = z.enum(["eu", "any"]);
export const aiScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  jurisdiction: aiJurisdiction,
});
export const aiModel = z.string().min(1).max(200);
export const aiReservationId = ulid;

export function aiInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid AI gateway input");
  return result.data;
}

/** A settlement needs the price of the meter, and the card has been withdrawn: the reservation stays for the sweep. */
export class AiPriceUnavailable extends Error {
  readonly code = "ai_price_unavailable";
  constructor() {
    super("ai_price_unavailable");
  }
}

/** The Core clock as a stored timestamp (microsecond form): every money decision of the gateway is taken at it. */
export async function coreClock(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') now")
    .first<{ now: string }>();
  if (row === null) throw new Error("ai_unavailable");
  return row.now;
}

export interface AiPrice {
  readonly card: string;
  readonly rate: AiCardRate;
}

/**
 * The published rate of the AI meter at the instant `at`: the card of the meter's latest activation that started by
 * then, with its rate for the meter and unit. Null when no activation covers the instant. A later activation replaces
 * the earlier one from its own start time, the same rule the mail meters follow.
 */
const PRICE_SQL = `SELECT json_object('card',c.rate_card_id,'rate',json(r.value)) price
 FROM usage_meter_activations a JOIN published_credit_rate_cards c ON c.rate_card_id=a.rate_card_id,json_each(c.rates) r
 WHERE a.meter=?1 AND a.starts_at<=?2 AND c.published_at<=?2 AND json_extract(r.value,'$.meter')=?1 AND json_extract(r.value,'$.unit')=?3
 ORDER BY a.starts_at DESC LIMIT 1`;

export async function readAiPrice(db: D1Database, at: string): Promise<AiPrice | null> {
  const row = await db
    .prepare(PRICE_SQL)
    .bind(AI_METER, at, AI_METER_UNIT)
    .first<{ price: string }>();
  if (row === null) return null;
  const parsed = JSON.parse(row.price) as {
    card: string;
    rate: { units_per_charge: string; credit_micros: string };
  };
  return {
    card: parsed.card,
    rate: {
      unitsPerCharge: BigInt(parsed.rate.units_per_charge),
      creditMicros: BigInt(parsed.rate.credit_micros),
    },
  };
}

/** Whether the project is active under active ownership and the environment belongs to it in the organization. */
export async function activeScope(db: D1Database, scope: AiKeyScope): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM projects p JOIN environments e ON e.organization_id = p.organization_id AND e.project_id = p.project_id
       WHERE p.organization_id = ?1 AND p.project_id = ?2 AND e.environment_id = ?3
         AND p.owner_state = 'active' AND p.lifecycle_state = 'active'`,
    )
    .bind(scope.organizationId, scope.projectId, scope.environmentId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * Where an AI reservation stands for one organization, project and environment: `open` (the credit core may settle or release it),
 * `resolved` (its settle or release was logged for this organization) or `unknown` (another project's, another
 * organization's, or never). Only the organization's own rows are read, so another tenant's reservation is never
 * reported as resolved.
 */
export async function reservationState(
  db: D1Database,
  scope: Pick<AiKeyScope, "organizationId" | "projectId" | "environmentId">,
  reservationId: string,
): Promise<"open" | "resolved" | "unknown"> {
  const row = await db
    .prepare(
      `SELECT r.project_id FROM credit_reservation r JOIN ai_gateway_reservations m ON m.reservation_id = r.reservation_id
       WHERE r.reservation_id = ?1 AND r.organization_id = ?2 AND m.organization_id = ?2 AND m.project_id = ?3 AND m.environment_id = ?4`,
    )
    .bind(reservationId, scope.organizationId, scope.projectId, scope.environmentId)
    .first<{ project_id: string | null }>();
  if (row !== null) return row.project_id === scope.projectId ? "open" : "unknown";
  const resolved = await db
    .prepare(
      `SELECT 1 AS ok FROM credit_log WHERE organization_id = ?2 AND key IN ('settle:' || ?1, 'release:' || ?1)
       AND json_extract(detail, '$.kind') = 'ai' AND json_extract(detail, '$.projectId') = ?3 AND json_extract(detail, '$.environmentId') = ?4`,
    )
    .bind(reservationId, scope.organizationId, scope.projectId, scope.environmentId)
    .first<{ ok: number }>();
  return resolved === null ? "unknown" : "resolved";
}
