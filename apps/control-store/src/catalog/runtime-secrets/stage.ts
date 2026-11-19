import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { parse, stageInput, DeliveryConflictError, type Row } from "./contracts.js";
import { params } from "./facts.js";

export const STAGE_COLUMNS = `stage.*,CAST(stage.generation AS TEXT) generation,CAST(stage.release_sequence AS TEXT) release_sequence,lower(hex(stage.manifest_sha256)) manifest_sha256`;
const ELIGIBLE = `SELECT 1 FROM runtime_secret_delivery_states state
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=state.organization_id AND candidate.project_id=state.project_id AND candidate.environment_id=state.environment_id
 AND candidate.product_deployment_id=?6 AND candidate.candidate_receipt_id=?7 AND (candidate.operation_id=?5 OR ?11='rollback')
 WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3 AND state.active_lease_id=?8
 AND state.claimed_generation=CAST(?9 AS INTEGER) AND state.claimed_release_sequence=CAST(?10 AS INTEGER) AND state.claimed_trigger=?11 AND state.lease_expires_at>=?16`;
export async function stageDelivery(
  context: CatalogContext,
  raw: unknown,
): Promise<{ outcome: "staged" | "existing"; stageReceiptId: string }> {
  const input = parse(stageInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    hash = Array.from(input.manifestSha256, (v) => v.toString(16).padStart(2, "0")).join("");
  const values = [
    ...params(input),
    input.stageReceiptId,
    input.operationId,
    input.productDeploymentId,
    input.candidateReceiptId,
    input.leaseId,
    String(input.generation),
    String(input.releaseSequence),
    input.trigger,
    input.providerTag,
    JSON.stringify(input.appliedSecretNames),
    hash,
    input.manifestSecretCount,
    input.stagedAt,
  ];
  const read = async (reader: typeof db) => {
    const [stage, eligible] = await reader.batch([
      reader
        .prepare(
          `SELECT ${STAGE_COLUMNS} FROM runtime_secret_delivery_stages stage WHERE stage.lease_id=?`,
        )
        .bind(input.leaseId),
      reader.prepare(`SELECT EXISTS(${ELIGIBLE}) eligible`).bind(...values),
    ]);
    return { stage: stage?.results[0] ?? null, eligible: eligible?.results[0]?.["eligible"] === 1 };
  };
  const exact = (row: Row) =>
    row["organization_id"] === input.organizationId &&
    row["project_id"] === input.projectId &&
    row["environment_id"] === input.environmentId &&
    row["operation_id"] === input.operationId &&
    row["product_deployment_id"] === input.productDeploymentId &&
    row["candidate_receipt_id"] === input.candidateReceiptId &&
    row["generation"] === String(input.generation) &&
    row["release_sequence"] === String(input.releaseSequence) &&
    row["trigger"] === input.trigger &&
    row["provider_tag"] === input.providerTag &&
    JSON.stringify(JSON.parse(String(row["applied_secret_names"]))) ===
      JSON.stringify(input.appliedSecretNames) &&
    row["manifest_sha256"] === hash &&
    row["manifest_secret_count"] === input.manifestSecretCount &&
    row["staged_at"] === input.stagedAt;
  const replay = (row: Row | null) => {
    if (row === null) return undefined;
    if (!exact(row) || typeof row["stage_receipt_id"] !== "string")
      throw new DeliveryConflictError();
    return { outcome: "existing" as const, stageReceiptId: row["stage_receipt_id"] };
  };
  const command: Command<
    Awaited<ReturnType<typeof read>>,
    { outcome: "staged" | "existing"; stageReceiptId: string }
  > = {
    name: "runtimeSecrets.stage",
    input,
    read,
    decide: (snapshot) => {
      const existing = replay(snapshot.stage);
      if (existing !== undefined) return { replay: existing };
      if (!snapshot.eligible) return { reject: new DeliveryConflictError() };
      return {
        statements: [
          guard(db, "precondition_changed", `NOT EXISTS(${ELIGIBLE})`, values),
          db
            .prepare(
              `INSERT INTO runtime_secret_delivery_stages(stage_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,candidate_receipt_id,lease_id,generation,release_sequence,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,staged_at)
    VALUES(?4,?1,?2,?3,?5,?6,?7,?8,CAST(?9 AS INTEGER),CAST(?10 AS INTEGER),?11,?12,?13,unhex(?14),?15,?16) ON CONFLICT(lease_id) DO NOTHING`,
            )
            .bind(...values),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        result: () => ({ outcome: "staged", stageReceiptId: input.stageReceiptId }),
      };
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["runtime_secret_delivery_stages"],
    lookup: async (reader) => replay((await read(reader)).stage),
  };
  return runCommand(db, command);
}
