import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { publicTimestamp, routeOrganization, type CatalogContext } from "../common.js";
import { LATEST } from "../gateway/facts.js";
import { receiptOf, type Route } from "../gateway/mutations.js";
import {
  activateInput,
  compensateInput,
  parse,
  DeliveryInputError,
  DeliveryLeaseError,
  DeliveryConflictError,
  type Row,
} from "./contracts.js";
import { params, STATE_DOCUMENT, parseState, CLEAR_LEASE } from "./facts.js";
import { STAGE_COLUMNS } from "./stage.js";

function hex(value: Uint8Array): string {
  return Array.from(value, (v) => v.toString(16).padStart(2, "0")).join("");
}
export async function activateDelivery(
  context: CatalogContext,
  raw: unknown,
): Promise<{
  outcome: "activated" | "existing";
  activationReceiptId: string;
  activatedAt: string;
}> {
  const input = parse(activateInput, raw),
    g = input.gateway;
  if (
    !g.active ||
    g.organizationId !== input.organizationId ||
    g.projectId !== input.projectId ||
    g.environmentId !== input.environmentId ||
    g.operationId !== input.operationId ||
    g.candidateReceiptId !== input.candidateReceiptId ||
    g.targetDeploymentId !== input.productDeploymentId ||
    g.targetScriptName !== input.candidateScriptName ||
    g.targetProviderTag !== input.candidateProviderTag ||
    g.targetArtifactDigest !== `sha256:${hex(input.candidateArtifactDigest)}`
  )
    throw new DeliveryInputError();
  const { db } = await routeOrganization(context, input.organizationId),
    p = params(input);
  const read = async (reader: typeof db) => {
    const [route, stage, activation, compensation, state] = await reader.batch([
      reader.prepare(LATEST).bind(...p),
      reader
        .prepare(
          `SELECT ${STAGE_COLUMNS},candidate.immutable_script_name,lower(hex(candidate.artifact_sha256)) artifact_sha256 FROM runtime_secret_delivery_stages stage JOIN wfp_candidate_receipts candidate ON candidate.organization_id=stage.organization_id AND candidate.project_id=stage.project_id AND candidate.environment_id=stage.environment_id AND candidate.candidate_receipt_id=stage.candidate_receipt_id WHERE stage.stage_receipt_id=?`,
        )
        .bind(input.stageReceiptId),
      reader
        .prepare("SELECT * FROM runtime_secret_delivery_stage_activations WHERE stage_receipt_id=?")
        .bind(input.stageReceiptId),
      reader
        .prepare(
          "SELECT 1 FROM runtime_secret_delivery_stage_compensations WHERE stage_receipt_id=?",
        )
        .bind(input.stageReceiptId),
      reader.prepare(STATE_DOCUMENT).bind(...p),
    ]);
    const routeDocument = route?.results[0]?.["value"],
      document = state?.results[0]?.["value"];
    return {
      routeDocument: typeof routeDocument === "string" ? routeDocument : null,
      stage: stage?.results[0] ?? null,
      activation: activation?.results[0] ?? null,
      compensated: (compensation?.results.length ?? 0) !== 0,
      state: parseState(typeof document === "string" ? document : null),
    };
  };
  const validate = async (snapshot: Awaited<ReturnType<typeof read>>) => {
    // Original source locks/reobserves the CURRENT full Gateway even before an existing activation reply.
    if (snapshot.routeDocument === null) throw new DeliveryConflictError();
    const current = await receiptOf(JSON.parse(snapshot.routeDocument) as Route);
    if (
      !Object.entries(current).every(
        ([key, value]) => JSON.stringify(value) === JSON.stringify(Reflect.get(g, key)),
      )
    )
      throw new DeliveryConflictError();
    const s = snapshot.stage;
    if (
      s === null ||
      s["organization_id"] !== input.organizationId ||
      s["project_id"] !== input.projectId ||
      s["environment_id"] !== input.environmentId ||
      s["operation_id"] !== input.operationId ||
      s["product_deployment_id"] !== input.productDeploymentId ||
      s["candidate_receipt_id"] !== input.candidateReceiptId ||
      s["immutable_script_name"] !== input.candidateScriptName ||
      s["provider_tag"] !== input.candidateProviderTag ||
      s["artifact_sha256"] !== hex(input.candidateArtifactDigest)
    )
      throw new DeliveryConflictError();
  };
  const existing = (snapshot: Awaited<ReturnType<typeof read>>) => {
    const a = snapshot.activation;
    if (a === null) return undefined;
    if (
      a["activation_receipt_id"] !== input.activationReceiptId ||
      String(a["shared_gateway_revision"]) !== String(g.revision) ||
      typeof a["activated_at"] !== "string"
    )
      throw new DeliveryConflictError();
    return {
      outcome: "existing" as const,
      activationReceiptId: input.activationReceiptId,
      activatedAt: publicTimestamp(a["activated_at"]),
    };
  };
  const command: Command<
    Awaited<ReturnType<typeof read>>,
    { outcome: "activated" | "existing"; activationReceiptId: string; activatedAt: string }
  > = {
    name: "runtimeSecrets.activate",
    input,
    read: async (reader) => {
      const s = await read(reader);
      await validate(s);
      return s;
    },
    decide: (snapshot) => {
      const found = existing(snapshot);
      if (found !== undefined) return { replay: found };
      const s = snapshot.stage;
      if (s === null || snapshot.compensated) return { reject: new DeliveryConflictError() };
      // Deliberately no new expiry/generation fence. Source accepts an expired but still-same staged lease.
      if (snapshot.state?.["active_lease_id"] !== s["lease_id"])
        return { reject: new DeliveryLeaseError() };
      return {
        statements: [
          guard(db, "precondition_changed", `(${LATEST}) IS NOT ?4`, [
            ...p,
            snapshot.routeDocument,
          ]),
          db
            .prepare(
              "INSERT INTO runtime_secret_delivery_stage_activations(activation_receipt_id,stage_receipt_id,organization_id,project_id,environment_id,shared_gateway_revision,activated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            )
            .bind(
              input.activationReceiptId,
              input.stageReceiptId,
              ...p,
              g.revision,
              input.activatedAt,
            ),
          db
            .prepare(
              `INSERT INTO runtime_secret_delivery_receipts(receipt_id,organization_id,project_id,environment_id,lease_id,generation,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,completed_at,release_sequence)
    SELECT ?1,organization_id,project_id,environment_id,lease_id,generation,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,?2,release_sequence FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?3`,
            )
            .bind(input.activationReceiptId, input.activatedAt, input.stageReceiptId),
          db
            .prepare(
              `UPDATE runtime_secret_delivery_states SET applied_generation=max(applied_generation,(SELECT generation FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4)),applied_release_sequence=max(applied_release_sequence,(SELECT release_sequence FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4)),${CLEAR_LEASE},provider_tag=(SELECT provider_tag FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4),applied_secret_names=(SELECT applied_secret_names FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4),applied_manifest_sha256=(SELECT manifest_sha256 FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4),applied_secret_count=(SELECT manifest_secret_count FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4),last_failure_code=NULL,last_failed_at=NULL,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND active_lease_id=(SELECT lease_id FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4)`,
            )
            .bind(...p, input.stageReceiptId, input.activatedAt),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        result: () => ({
          outcome: "activated",
          activationReceiptId: input.activationReceiptId,
          activatedAt: publicTimestamp(input.activatedAt),
        }),
      };
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: [
      "runtime_secret_delivery_stage_activations",
      "runtime_secret_delivery_receipts",
    ],
    lookup: async (reader) => {
      const s = await read(reader);
      await validate(s);
      return existing(s);
    },
  };
  return runCommand(db, command);
}

export async function compensateDelivery(
  context: CatalogContext,
  raw: unknown,
): Promise<{
  outcome: "compensated" | "existing";
  compensationReceiptId: string;
  compensatedAt: string;
}> {
  const input = parse(compensateInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    p = params(input);
  const read = async (reader: typeof db) => {
    const [stage, compensation, activation, state] = await reader.batch([
      reader
        .prepare(
          `SELECT ${STAGE_COLUMNS} FROM runtime_secret_delivery_stages stage WHERE stage.stage_receipt_id=?`,
        )
        .bind(input.stageReceiptId),
      reader
        .prepare(
          "SELECT * FROM runtime_secret_delivery_stage_compensations WHERE stage_receipt_id=?",
        )
        .bind(input.stageReceiptId),
      reader
        .prepare("SELECT 1 FROM runtime_secret_delivery_stage_activations WHERE stage_receipt_id=?")
        .bind(input.stageReceiptId),
      reader.prepare(STATE_DOCUMENT).bind(...p),
    ]);
    const doc = state?.results[0]?.["value"];
    return {
      stage: stage?.results[0] ?? null,
      compensation: compensation?.results[0] ?? null,
      activated: (activation?.results.length ?? 0) !== 0,
      state: parseState(typeof doc === "string" ? doc : null),
    };
  };
  const validate = (s: Row | null) => {
    if (
      s === null ||
      s["organization_id"] !== input.organizationId ||
      s["project_id"] !== input.projectId ||
      s["environment_id"] !== input.environmentId ||
      s["candidate_receipt_id"] !== input.candidateReceiptId
    )
      throw new DeliveryConflictError();
  };
  const existing = (s: Awaited<ReturnType<typeof read>>) => {
    validate(s.stage);
    const c = s.compensation;
    if (c === null) return undefined;
    if (
      c["compensation_receipt_id"] !== input.compensationReceiptId ||
      c["failure_code"] !== input.failureCode ||
      typeof c["compensated_at"] !== "string"
    )
      throw new DeliveryConflictError();
    return {
      outcome: "existing" as const,
      compensationReceiptId: input.compensationReceiptId,
      compensatedAt: publicTimestamp(c["compensated_at"]),
    };
  };
  const SUPERSEDED = `SELECT 1 FROM runtime_secret_delivery_states state JOIN runtime_secret_delivery_stages stage ON stage.organization_id=state.organization_id AND stage.project_id=state.project_id AND stage.environment_id=state.environment_id WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3 AND stage.stage_receipt_id=?4 AND state.active_lease_id IS NULL AND state.applied_release_sequence>stage.release_sequence AND state.provider_tag IS NOT stage.provider_tag`;
  const command: Command<
    Awaited<ReturnType<typeof read>>,
    { outcome: "compensated" | "existing"; compensationReceiptId: string; compensatedAt: string }
  > = {
    name: "runtimeSecrets.compensate",
    input,
    read,
    decide: (s) => {
      const found = existing(s);
      if (found !== undefined) return { replay: found };
      if (s.stage === null || s.activated) return { reject: new DeliveryConflictError() };
      const state = s.state,
        stage = s.stage;
      const superseded =
        state !== null &&
        state["active_lease_id"] === null &&
        BigInt(String(state["applied_release_sequence"])) >
          BigInt(String(stage["release_sequence"])) &&
        state["provider_tag"] !== stage["provider_tag"];
      if (state === null || (state["active_lease_id"] !== stage["lease_id"] && !superseded))
        return { reject: new DeliveryLeaseError() };
      return {
        statements: [
          db
            .prepare(
              "INSERT INTO runtime_secret_delivery_stage_compensations(compensation_receipt_id,stage_receipt_id,failure_code,compensated_at) VALUES(?1,?2,?3,?4)",
            )
            .bind(
              input.compensationReceiptId,
              input.stageReceiptId,
              input.failureCode,
              input.compensatedAt,
            ),
          db
            .prepare(
              `UPDATE runtime_secret_delivery_states SET ${CLEAR_LEASE},last_failure_code=?5,last_failed_at=?6,updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND active_lease_id=(SELECT lease_id FROM runtime_secret_delivery_stages WHERE stage_receipt_id=?4)`,
            )
            .bind(...p, input.stageReceiptId, input.failureCode, input.compensatedAt),
          guard(db, "precondition_changed", `changes()<>1 AND NOT EXISTS(${SUPERSEDED})`, [
            ...p,
            input.stageReceiptId,
          ]),
        ],
        result: () => ({
          outcome: "compensated",
          compensationReceiptId: input.compensationReceiptId,
          compensatedAt: publicTimestamp(input.compensatedAt),
        }),
      };
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["runtime_secret_delivery_stage_compensations"],
    lookup: async (reader) => existing(await read(reader)),
  };
  return runCommand(db, command);
}
