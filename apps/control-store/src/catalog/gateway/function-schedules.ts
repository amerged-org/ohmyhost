import { normalizeCrons } from "@ohmyhost/contracts/functions";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { instant, ulid } from "../common.js";
import { scopeInput } from "./contracts.js";

const schedule = scopeInput.extend({
  deploymentId: ulid,
  candidateReceiptId: ulid,
  crons: z.array(z.string()),
  egressAllowedOrigins: z.array(z.string()).max(16),
  now: instant,
});

/** Original120 schedule update/removal, as pure statements for the publication/completion ONE batch.
 * Not an RPC. The surrounding finalizer owns current-head/claim/operation authority. */
export function functionScheduleStatements(db: D1Database, raw: unknown): D1PreparedStatement[] {
  const input = schedule.parse(raw);
  // The original scheduler sorts origins but retains duplicates; it has a distinct policy from route admission.
  const origins = input.egressAllowedOrigins
    .map((origin) => {
      if (!isDnsEgressOrigin(origin)) throw new TypeError("Egress origins are invalid");
      return origin;
    })
    .sort();
  if (input.crons.length === 0)
    return [
      db
        .prepare(
          "DELETE FROM environment_function_schedules WHERE organization_id=?1 AND environment_id=?2",
        )
        .bind(input.organizationId, input.environmentId),
    ];
  const crons = normalizeCrons(input.crons);
  return [
    db
      .prepare(
        `INSERT INTO environment_function_schedules(organization_id,project_id,environment_id,deployment_id,candidate_receipt_id,immutable_script_name,crons,egress_allowed_origins,updated_at)
      SELECT ?1,?2,?3,?4,?5,candidate.immutable_script_name,?6,?7,?8 FROM wfp_candidate_receipts candidate
      WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.product_deployment_id=?4 AND candidate.candidate_receipt_id=?5
      ON CONFLICT(organization_id,environment_id) DO UPDATE SET project_id=excluded.project_id,deployment_id=excluded.deployment_id,candidate_receipt_id=excluded.candidate_receipt_id,
      immutable_script_name=excluded.immutable_script_name,crons=excluded.crons,egress_allowed_origins=excluded.egress_allowed_origins,updated_at=excluded.updated_at`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.deploymentId,
        input.candidateReceiptId,
        JSON.stringify(crons),
        JSON.stringify(origins),
        input.now,
      ),
    guard(db, "precondition_changed", "changes()<>1"),
  ];
}
