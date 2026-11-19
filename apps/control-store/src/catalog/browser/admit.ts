import { z } from "zod";
import {
  BROWSER_MAX_MS,
  BROWSER_MAX_OPEN_CALLS,
  browserCreditMicros,
  type BrowserAdmitResult,
} from "@ohmyhost/platform/shared";
import { type CatalogContext, routeOrganization } from "../common.js";
import { readAccount, readProjectBudget, reserve, stopBudgetGuard } from "../credit/index.js";
import { isDuplicate } from "../credit/spend.js";
import { classifyFailure, guard } from "../../guards.js";
import { aiAdmissionDenial } from "../ai/credit.js";
import {
  activeScope,
  BROWSER_AUTHORITY_SQL,
  browserAuthorityParameters,
  browserInput,
  browserReservationId,
  browserScope,
  coreClock,
  readBrowserPrice,
} from "./common.js";
const schema = z.strictObject({ scope: browserScope, reservationId: browserReservationId });
/** Reserve the current price of the full permitted duration, atomically with budget and open-call guards. */
export async function admitBrowser(
  context: CatalogContext,
  raw: unknown,
): Promise<BrowserAdmitResult> {
  const input = browserInput(schema, raw),
    { scope } = input,
    { db } = await routeOrganization(context, scope.organizationId),
    now = await coreClock(db),
    price = await readBrowserPrice(db, now);
  if (price === null || !(await activeScope(db, scope)))
    return { admitted: false, denial: "unavailable" };
  const account = await readAccount(db, scope.organizationId, now),
    project = await readProjectBudget(db, scope),
    denial = aiAdmissionDenial(account, project, now);
  if (denial !== null) return { admitted: false, denial };
  const reservedMicros = Math.max(1, browserCreditMicros(BROWSER_MAX_MS, price.rate));
  const plan = reserve(db, {
    organizationId: scope.organizationId,
    reservationId: input.reservationId,
    projectId: scope.projectId,
    amountMicros: reservedMicros,
    now,
    detail: { kind: "browser", environmentId: scope.environmentId },
  });
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO browser_gateway_reservations(reservation_id,organization_id,project_id,environment_id,rate_card_id,activation_start,units_per_charge,provider_cost_micros,credit_micros,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        )
        .bind(
          input.reservationId,
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          price.card,
          price.activationStart,
          price.rate.unitsPerCharge.toString(),
          price.providerCostMicros.toString(),
          price.rate.creditMicros.toString(),
          now,
        ),
      guard(
        db,
        "scope_inactive",
        `NOT EXISTS(${BROWSER_AUTHORITY_SQL})`,
        browserAuthorityParameters(scope),
      ),
      guard(
        db,
        "scope_inactive",
        "NOT EXISTS(SELECT 1 FROM credit_account WHERE organization_id=?1 AND paid_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))",
        [scope.organizationId],
      ),
      guard(
        db,
        "scope_inactive",
        `NOT EXISTS(SELECT 1 FROM usage_meter_activations a JOIN published_credit_rate_cards c ON c.rate_card_id=a.rate_card_id WHERE a.meter=?1 AND a.starts_at<= (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND c.published_at<= (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ORDER BY a.starts_at DESC LIMIT 1) OR NOT EXISTS(SELECT 1 FROM usage_meter_activations a WHERE a.meter=?1 AND a.rate_card_id=?2 AND a.starts_at=?3 AND a.starts_at=(SELECT MAX(latest.starts_at) FROM usage_meter_activations latest JOIN published_credit_rate_cards card ON card.rate_card_id=latest.rate_card_id WHERE latest.meter=?1 AND latest.starts_at<= (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND card.published_at<= (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')))`,
        ["browser.duration", price.card, price.activationStart],
      ),
      guard(db, "scope_inactive", "substr(?1,1,7) <> strftime('%Y-%m','now')", [now]),
      stopBudgetGuard(db, scope, now, reservedMicros),
      // Reuse the established guard code; its name is internal and does not affect the denial contract.
      guard(
        db,
        "ai_open_calls_exceeded",
        `(SELECT COUNT(*) FROM browser_gateway_reservations m WHERE m.organization_id=?1 AND m.state='open')>?2`,
        [scope.organizationId, BROWSER_MAX_OPEN_CALLS],
      ),
      ...plan.statements,
    ]);
    return { admitted: true, reservedMicros };
  } catch (error) {
    const failure = classifyFailure(error);
    if (failure.kind === "guard" && failure.code === "scope_inactive")
      return { admitted: false, denial: "unavailable" };
    if (failure.kind === "guard" && failure.code === "precondition_changed")
      return { admitted: false, denial: "project_budget_exceeded" };
    if (failure.kind === "guard" && failure.code === "ai_open_calls_exceeded")
      return { admitted: false, denial: "too_many_open_calls" };
    if (failure.kind === "guard" && failure.code === "insufficient_credits")
      return { admitted: false, denial: "insufficient_organization_credits" };
    if (
      failure.kind === "unique" &&
      (isDuplicate(error) || failure.table === "browser_gateway_reservations")
    ) {
      const row = await db
        .prepare(
          `SELECT r.amount_micros,r.project_id FROM credit_reservation r JOIN browser_gateway_reservations m ON m.reservation_id=r.reservation_id
 WHERE r.reservation_id=?1 AND r.organization_id=?2 AND m.organization_id=?2 AND m.project_id=?3 AND m.environment_id=?4`,
        )
        .bind(input.reservationId, scope.organizationId, scope.projectId, scope.environmentId)
        .first<{ amount_micros: number; project_id: string | null }>();
      return row !== null && row.project_id === scope.projectId
        ? { admitted: true, reservedMicros: row.amount_micros }
        : { admitted: false, denial: "unavailable" };
    }
    throw error;
  }
}
