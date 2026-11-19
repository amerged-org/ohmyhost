import { nativeAuthLaunchAllowed } from "../identity/native-auth-launch-policy.js";
import { z } from "zod";
import { guard } from "../../guards.js";
import { type Command } from "../../run-command.js";
import {
  conflict,
  fenceRaceGuard,
  routeOrganization,
  runMapped,
  ulid,
  type CatalogContext,
} from "../common.js";
import { assertOperationDelegationCurrent } from "../identity/operation-delegations.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "./authority.js";
import { ProductWorkflowContextConflictError } from "./context.js";
const executionInput = z.strictObject({ organizationId: ulid, projectId: ulid, operationId: ulid });
const activationInput = executionInput.extend({ candidateReceiptId: ulid.optional() });
type Input = z.output<typeof activationInput>;
type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly supersededById: string };
// int8 sequence values stay SQL integers and are transported as text, never JS numbers.
const PUSH = `SELECT json_object('state',push.state,'generation',push.config_generation,'sequence',CAST(push.sequence AS TEXT),'enabled',config.enabled,'configGeneration',config.generation,'latest',(SELECT CAST(max(newer.sequence) AS TEXT) FROM github_push_deployments newer WHERE newer.organization_id=push.organization_id AND newer.project_id=push.project_id),'supersededById',(SELECT newer.push_deployment_id FROM github_push_deployments newer WHERE newer.organization_id=push.organization_id AND newer.project_id=push.project_id AND newer.sequence>push.sequence ORDER BY newer.sequence DESC LIMIT 1)) value FROM github_push_deployments push LEFT JOIN github_auto_deploy_configs config ON config.organization_id=push.organization_id AND config.project_id=push.project_id WHERE push.organization_id=?1 AND push.project_id=?2 AND push.operation_id=?3`;
/** Deployment parent authorization only. Provider services receive the separate current-claim five-field capability. */
async function authorize(
  context: CatalogContext,
  raw: unknown,
  activation: boolean,
): Promise<Decision> {
  const i = (activation ? activationInput : executionInput).parse(raw) as Input,
    { db } = await routeOrganization(context, i.organizationId),
    scope = [i.organizationId, i.projectId, i.operationId];
  const changed = () => {
    const e = conflict(
      "operation_authorization_changed",
      "Queued operation authorization or source generation changed",
    );
    e.name = "OperationAuthorizationConflictError";
    return e;
  };
  const delegated = { organizationId: i.organizationId, operationId: i.operationId };
  await assertOperationDelegationCurrent(context, delegated);
  type Snapshot = {
    proof: Awaited<ReturnType<typeof readWorkflowDelegation>>;
    push: string | null;
    candidate: boolean;
    targetNative: boolean;
  };
  const read = async (reader: typeof db): Promise<Snapshot> => ({
    proof: await readWorkflowDelegation(reader, i),
    push: activation
      ? ((
          await reader
            .prepare(PUSH)
            .bind(...scope)
            .first<{ value: string }>()
        )?.value ?? null)
      : null,
    targetNative:
      activation &&
      (await reader
        .prepare(
          `SELECT 1 FROM deployments d
      LEFT JOIN product_command_intents intent ON intent.organization_id=d.organization_id AND intent.project_id=d.project_id AND intent.operation_id=d.operation_id
      LEFT JOIN deployment_revisions reused ON reused.organization_id=d.organization_id AND reused.project_id=d.project_id AND ((d.kind='rollback' AND reused.deployment_id=d.rollback_target_deployment_id AND reused.revision_id=d.rollback_target_revision_id) OR (d.kind='promotion' AND reused.deployment_id=d.promotion_source_deployment_id AND reused.revision_id=d.promotion_source_revision_id))
      JOIN deployment_plans plan ON plan.organization_id=d.organization_id AND plan.project_id=d.project_id AND plan.plan_id=CASE WHEN d.kind='deploy' THEN intent.plan_id ELSE reused.plan_id END
      WHERE d.organization_id=?1 AND d.project_id=?2 AND d.operation_id=?3 AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native'`,
        )
        .bind(...scope)
        .first()) !== null,
    candidate:
      i.candidateReceiptId === undefined ||
      (await reader
        .prepare(
          "SELECT 1 FROM wfp_candidate_receipts WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND candidate_receipt_id=?4",
        )
        .bind(...scope, i.candidateReceiptId)
        .first()) !== null,
  });
  const decide = (s: Snapshot): Decision => {
    if (s.targetNative && !nativeAuthLaunchAllowed(context, i.organizationId, i.projectId))
      throw new ProductWorkflowContextConflictError("Native Auth launch unavailable");
    if (!s.candidate)
      throw new ProductWorkflowContextConflictError("WFP candidate activation scope changed");
    if (!activation || s.push === null) return { allowed: true };
    const p = JSON.parse(s.push) as Record<string, unknown>;
    if (i.candidateReceiptId === undefined)
      return p["enabled"] === 1 &&
        p["configGeneration"] === p["generation"] &&
        p["latest"] === p["sequence"] &&
        ["queued", "running"].includes(String(p["state"]))
        ? { allowed: true }
        : { allowed: false, supersededById: i.operationId };
    // Native candidate authorization's INNER JOIN treats an absent config as no push scope.
    if (p["configGeneration"] === null) return { allowed: true };
    if (p["supersededById"] !== null)
      return { allowed: false, supersededById: ulid.parse(p["supersededById"]) };
    if (
      p["enabled"] !== 1 ||
      p["configGeneration"] !== p["generation"] ||
      !["queued", "running"].includes(String(p["state"]))
    )
      throw new ProductWorkflowContextConflictError(
        "GitHub auto-deployment activation state changed",
      );
    return { allowed: true };
  };
  const statements = (reader: typeof db, s: Snapshot) => [
    fenceRaceGuard(reader, "operation_conflict", i.organizationId),
    ...workflowExecutionGuards(reader, i, s.proof),
    ...(activation
      ? [
          guard(reader, "operation_conflict", `coalesce((SELECT value FROM(${PUSH})),'null')<>?4`, [
            ...scope,
            s.push ?? "null",
          ]),
        ]
      : []),
    ...(i.candidateReceiptId === undefined
      ? []
      : [
          guard(
            reader,
            "operation_conflict",
            "NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND candidate_receipt_id=?4)",
            [...scope, i.candidateReceiptId],
          ),
        ]),
  ];
  const command: Command<Snapshot, Decision> = {
    name: activation ? "provisioning.authorizeActivation" : "provisioning.assertExecution",
    input: i,
    retryOn: ["operation_conflict"],
    read,
    decide: (s) => {
      const result = decide(s);
      return { statements: statements(db, s), result: () => result };
    },
    lookup: async (reader) => {
      await assertOperationDelegationCurrent(context, delegated);
      const s = await read(reader),
        result = decide(s);
      await reader.batch(statements(reader, s));
      return result;
    },
  };
  return runMapped(db, command, { consent_changed: changed, source_head_conflict: changed });
}
export async function assertProductOperationExecution(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  await authorize(context, raw, false);
}
export function authorizeProductActivation(
  context: CatalogContext,
  raw: unknown,
): Promise<Decision> {
  return authorize(context, raw, true);
}
