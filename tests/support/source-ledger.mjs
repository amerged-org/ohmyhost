/** The original credit ledger of the source PostgreSQL written as plain SQL (one INSERT per fact). */

export async function insertGrant(db, input) {
  await db.query(
    "INSERT INTO organization_credit_grants(grant_id,organization_id,kind,source_reference,amount_micros,granted_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      input.grantId,
      input.organizationId,
      input.kind,
      input.sourceReference,
      input.amountMicros.toString(),
      input.grantedAt,
      input.expiresAt,
    ],
  );
}

export async function insertReservation(db, input) {
  await db.query(
    "INSERT INTO organization_credit_reservations(reservation_id,organization_id,project_id,environment_id,billing_epoch_id,kind,source_reference,amount_micros,reserved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      input.reservationId,
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.billingEpochId,
      input.kind,
      input.sourceReference,
      input.amountMicros.toString(),
      input.reservedAt,
    ],
  );
}

export async function insertMovement(db, input) {
  await db.query(
    "INSERT INTO organization_credit_movements(organization_id,reservation_id,grant_id,phase,reserved_micros,spent_micros) VALUES($1,$2,$3,$4,$5,$6)",
    [
      input.organizationId,
      input.reservationId,
      input.grantId,
      input.phase,
      (input.reserved ?? 0n).toString(),
      (input.spent ?? 0n).toString(),
    ],
  );
}

export async function insertResolution(db, input) {
  await db.query(
    "INSERT INTO organization_credit_resolutions(reservation_id,outcome,charge_micros,provider_cost_micros,rate_card_id,meter,unit,quantity,event_time,funded_micros,resolved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      input.reservationId,
      input.outcome,
      input.charge.toString(),
      input.providerCost ?? null,
      input.rateCardId ?? null,
      input.meter ?? null,
      input.unit ?? null,
      input.quantity?.toString() ?? null,
      input.eventTime ?? null,
      input.funded.toString(),
      input.resolvedAt,
    ],
  );
}
