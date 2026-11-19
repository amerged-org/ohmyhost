import { nativeAuthLaunchAllowed } from "../identity/native-auth-launch-policy.js";
import {
  RUN,
  terminalIdentity,
  terminalMatches,
  workflowTerminalStatements,
} from "./workflow-terminal-plan.js";
import { resourceHash } from "./context-values.js";
import { z } from "zod";
import { parseOperationDeploymentResult, parseSharedGatewayReceipt } from "@ohmyhost/platform";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  fenceRaceGuard,
  instant,
  ulid,
  type CatalogContext,
} from "../common.js";
import { LATEST } from "../gateway/facts.js";
import { receiptOf, type Route } from "../gateway/mutations.js";
import { functionScheduleStatements } from "../gateway/function-schedules.js";
import {
  readServingCandidate,
  servingStartStatements,
  type ServingCandidate,
} from "../database/serving.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "./authority.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import { bindingRefreshStatements, bindingRefreshSnapshotInput } from "./binding-refresh-proof.js";
import type { D1Database } from "../../d1-types.js";
import { resolveNativeAuthAdminAuthority } from "../identity/native-auth-authority.js";
import { readNativeAuthRegistration } from "../identity/native-auth-registration.js";
import { originsSql } from "../identity/native-auth-config.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
const counter = z.number().int().min(0).max(2147483646),
  scope = { organizationId: ulid, projectId: ulid, environmentId: ulid, operationId: ulid };
const timestamp = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
  .pipe(instant);
const gateway = z.unknown().transform(parseSharedGatewayReceipt);
const schedule = z.strictObject({
  crons: z.array(z.string()),
  egressAllowedOrigins: z.array(z.string()).max(16),
});
const policy = z.strictObject({
  healthCheckPath: z.string(),
  egressAllowedOrigins: z.array(z.string()).max(16),
  browser: z.unknown().transform(parseBrowserPolicy).optional(),
});
const completion = z.strictObject({
  workflowId: z.string().min(1).max(255),
  outboxEventId: ulid,
  startedOperationEventId: ulid,
  operationEventId: ulid,
  auditEventId: ulid,
  reconciliationAttemptId: ulid.optional(),
  replayAttemptId: ulid.optional(),
  acceptedLifecycleVersion: z.number().int().min(1).max(2147483647),
  runtimePolicy: policy,
});
const publication = z.strictObject({
  ...scope,
  candidateReceiptId: ulid,
  wfpReceiptId: ulid,
  revisionId: ulid,
  productDeploymentId: ulid,
  expectedHeadVersion: counter,
  deploymentUrl: z.url(),
  publishedAt: timestamp,
  gateway,
});
const candidateInput = z.strictObject({
  bindingRefreshSnapshot: bindingRefreshSnapshotInput.nullable(),
  eventType: z.enum(["DeploymentRequestedV1", "DeploymentPromotionRequestedV1"]),
  publication,
  schedule,
  completion: completion
    .extend({
      result: z.unknown().transform((v) => (v === null ? null : parseOperationDeploymentResult(v))),
    })
    .nullable(),
});
const rollbackInput = z.strictObject({
  activation: z.strictObject({
    ...scope,
    rollbackActivationReceiptId: ulid,
    rollbackDeploymentId: ulid,
    targetDeploymentId: ulid,
    targetRevisionId: ulid,
    candidateReceiptId: ulid,
    wfpReceiptId: ulid,
    gateway,
    expectedHeadVersion: counter,
    completedAt: timestamp,
  }),
  schedule,
  completion,
});
type Row = Record<string, unknown>;
const failure = (message: string) => new ProductWorkflowContextConflictError(message);
const CANDIDATE = `SELECT candidate.*,lower(hex(candidate.artifact_sha256)) artifact_hex FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.operation_id=?4 AND candidate.candidate_receipt_id=?5 AND candidate.product_deployment_id=?6 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)`;
const PROVENANCE = `SELECT deployment.kind,intent.event_type,intent.plan_id deploy_plan_id,artifact.build_execution_id artifact_build_execution_id,reused.plan_id reused_plan_id,reused.build_execution_id reused_build_execution_id,reused.artifact_id reused_artifact_id,intent.binding_refresh_snapshot FROM deployments deployment JOIN build_artifacts artifact ON artifact.organization_id=deployment.organization_id AND artifact.project_id=deployment.project_id AND artifact.artifact_id=?4 LEFT JOIN product_command_intents intent ON intent.organization_id=deployment.organization_id AND intent.project_id=deployment.project_id AND intent.operation_id=deployment.operation_id LEFT JOIN deployment_revisions reused ON reused.organization_id=deployment.organization_id AND reused.project_id=deployment.project_id AND ((deployment.kind='rollback' AND reused.deployment_id=deployment.rollback_target_deployment_id AND reused.revision_id=deployment.rollback_target_revision_id) OR(deployment.kind='promotion' AND reused.deployment_id=deployment.promotion_source_deployment_id AND reused.revision_id=deployment.promotion_source_revision_id)) WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND deployment.deployment_id=?3`;
const PUSH_ALLOWED = `SELECT 1 FROM github_push_deployments push JOIN github_auto_deploy_configs config ON config.organization_id=push.organization_id AND config.project_id=push.project_id WHERE push.organization_id=?1 AND push.project_id=?2 AND push.operation_id=?3 AND (push.state NOT IN('queued','running') OR config.enabled<>1 OR config.generation<>push.config_generation OR EXISTS(SELECT 1 FROM github_push_deployments newer WHERE newer.organization_id=push.organization_id AND newer.project_id=push.project_id AND newer.sequence>push.sequence))`;
const NATIVE_AFFECTED = `SELECT 1 WHERE EXISTS(SELECT 1 FROM deployment_plans plan WHERE plan.organization_id=?1 AND plan.project_id=?2 AND plan.plan_id=?4 AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native') OR EXISTS(SELECT 1 FROM environments e JOIN deployment_revisions r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.deployment_id=e.active_deployment_id AND r.revision_id=e.active_revision_id JOIN deployment_plans plan ON plan.organization_id=r.organization_id AND plan.project_id=r.project_id AND plan.plan_id=r.plan_id WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3 AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native')`;
function nativePendingStatement(
  db: D1Database,
  input: { organizationId: string; projectId: string; environmentId: string; operationId: string },
  data: {
    eventType: string;
    headDeploymentId: string;
    headRevisionId: string;
    headVersion: number;
    completion: unknown;
    publication: unknown;
    schedule: unknown;
    bindingRefreshSnapshot?: unknown;
    evidence: unknown;
    result: unknown;
    url: string;
    artifact: string;
    publishedAt: string;
  },
) {
  const refresh = data.bindingRefreshSnapshot !== undefined;
  return db
    .prepare(
      `INSERT INTO native_auth_policy_syncs(organization_id,project_id,environment_id,operation_id,claim_id,event_type,head_deployment_id,head_revision_id,head_version,completion,publication,schedule,binding_refresh_snapshot,terminal_evidence,result_json,result_url,artifact_sha256,published_at,terminal_at,state)
    SELECT ?1,?2,?3,?4,claim_id,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4`,
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.operationId,
      data.eventType,
      data.headDeploymentId,
      data.headRevisionId,
      data.headVersion,
      refresh ? null : JSON.stringify(data.completion),
      JSON.stringify(data.publication),
      JSON.stringify(data.schedule),
      refresh ? JSON.stringify(data.bindingRefreshSnapshot) : null,
      refresh ? null : JSON.stringify(data.evidence),
      refresh ? null : JSON.stringify(data.result),
      data.url,
      data.artifact,
      data.publishedAt,
      refresh ? null : data.publishedAt,
      refresh ? "refresh_pending_cleanup" : "pending",
    );
}
const REPLAY = `SELECT environment.head_version FROM wfp_publish_receipts receipt JOIN deployment_revisions revision ON revision.organization_id=receipt.organization_id AND revision.project_id=receipt.project_id AND revision.wfp_receipt_id=receipt.wfp_receipt_id JOIN environments environment ON environment.organization_id=revision.organization_id AND environment.project_id=revision.project_id AND environment.environment_id=receipt.environment_id JOIN operations operation ON operation.organization_id=revision.organization_id AND operation.project_id=revision.project_id AND operation.operation_id=revision.operation_id JOIN deployments deployment ON deployment.organization_id=revision.organization_id AND deployment.project_id=revision.project_id AND deployment.deployment_id=revision.deployment_id WHERE receipt.wfp_receipt_id=?1 AND receipt.candidate_receipt_id=?2 AND receipt.organization_id=?3 AND receipt.project_id=?4 AND receipt.environment_id=?5 AND receipt.product_deployment_id=?6 AND revision.revision_id=?7 AND revision.operation_id=?8 AND receipt.deployment_url=?9 AND receipt.published_at=?10 AND receipt.shared_gateway_revision=?11 AND environment.active_deployment_id=?6 AND environment.active_revision_id=?7 AND environment.head_version=?12 AND(operation.state='succeeded' OR(operation.state='running' AND EXISTS(SELECT 1 FROM product_command_intents maintenance WHERE maintenance.organization_id=operation.organization_id AND maintenance.project_id=operation.project_id AND maintenance.operation_id=operation.operation_id AND maintenance.event_type='DeploymentRequestedV1' AND maintenance.binding_refresh_snapshot IS NOT NULL))) AND deployment.status='succeeded' AND deployment.active_revision_id=?7 AND deployment.active_version=1`;
/** Whole parent publication, serving admission, schedule and terminal/claim release stay ONE batch. */
export async function finalizeProductCandidate(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = candidateInput.parse(raw),
    p = i.publication,
    { db } = await routeOrganization(context, p.organizationId),
    scope = [p.organizationId, p.projectId, p.environmentId],
    candidateValues = [...scope, p.operationId, p.candidateReceiptId, p.productDeploymentId],
    replayValues = [
      p.wfpReceiptId,
      p.candidateReceiptId,
      ...scope,
      p.productDeploymentId,
      p.revisionId,
      p.operationId,
      p.deploymentUrl,
      p.publishedAt,
      p.gateway.revision,
      p.expectedHeadVersion + 1,
    ];
  if (
    p.gateway.provider !== "ohmyhost-shared-gateway" ||
    !p.gateway.active ||
    p.gateway.organizationId !== p.organizationId ||
    p.gateway.projectId !== p.projectId ||
    p.gateway.environmentId !== p.environmentId ||
    p.gateway.operationId !== p.operationId ||
    p.gateway.candidateReceiptId !== p.candidateReceiptId ||
    p.deploymentUrl !== p.gateway.publicOrigin
  )
    throw failure("Shared gateway receipt scope changed");
  type Snapshot = {
    candidate: Row | null;
    source: Row | null;
    route: string | null;
    gateway: Awaited<ReturnType<typeof receiptOf>> | null;
    run: Row | null;
    replay: boolean;
    collision: boolean;
    proof: Awaited<ReturnType<typeof readWorkflowDelegation>>;
    serving: ServingCandidate | null;
    nativeAffected: boolean;
    targetNative: boolean;
    nativePending: Row | null;
  };
  const read = async (reader: typeof db): Promise<Snapshot> => {
    const result = await reader.batch([
        reader.prepare(CANDIDATE).bind(...candidateValues),
        reader.prepare(LATEST).bind(...scope),
        i.completion === null
          ? reader.prepare("SELECT 1 WHERE 0")
          : reader.prepare(RUN).bind(...terminalIdentity(p, i.completion, i.eventType)),
        reader.prepare(REPLAY).bind(...replayValues),
        reader
          .prepare(
            "SELECT 1 FROM wfp_publish_receipts WHERE wfp_receipt_id=?1 OR candidate_receipt_id=?2",
          )
          .bind(p.wfpReceiptId, p.candidateReceiptId),
      ]),
      candidate = result[0]?.results[0] ?? null;
    const source = candidate
      ? await reader
          .prepare(PROVENANCE)
          .bind(p.organizationId, p.projectId, p.productDeploymentId, candidate["artifact_id"])
          .first<Row>()
      : null;
    const plan =
      source?.["kind"] === "deploy" ? source["deploy_plan_id"] : source?.["reused_plan_id"];
    const native =
      typeof plan === "string"
        ? await reader
            .prepare(NATIVE_AFFECTED)
            .bind(...scope, plan)
            .first()
        : null;
    const pending = await reader
      .prepare(
        "SELECT * FROM native_auth_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND state IN('refresh_pending_cleanup','pending')",
      )
      .bind(...scope, p.operationId)
      .first<Row>();
    return {
      targetNative:
        typeof plan === "string" &&
        (await reader
          .prepare(
            "SELECT 1 FROM deployment_plans WHERE organization_id=?1 AND project_id=?2 AND plan_id=?3 AND json_extract(framework_plan,'$.auth.provider')='omh-native'",
          )
          .bind(p.organizationId, p.projectId, plan)
          .first()) !== null,
      candidate,
      source,
      route: (result[1]?.results[0]?.["value"] as string | undefined) ?? null,
      gateway:
        typeof result[1]?.results[0]?.["value"] === "string"
          ? await receiptOf(JSON.parse(result[1].results[0]["value"]) as Route)
          : null,
      run: result[2]?.results[0] ?? null,
      replay: (result[3]?.results.length ?? 0) > 0,
      collision: (result[4]?.results.length ?? 0) > 0,
      proof: await readWorkflowDelegation(reader, p),
      serving:
        typeof plan === "string"
          ? await readServingCandidate(reader, { ...p, planId: plan })
          : null,
      nativeAffected: native !== null,
      nativePending: pending,
    };
  };
  const evidence = (s: Snapshot) =>
    i.completion === null
      ? null
      : i.eventType === "DeploymentRequestedV1"
        ? { result: i.completion.result, runtimePolicy: i.completion.runtimePolicy }
        : {
            runtimePolicy: i.completion.runtimePolicy,
            promotion: {
              deploymentId: p.productDeploymentId,
              url: p.deploymentUrl,
              artifactDigest: `sha256:${String(s.candidate?.["artifact_hex"])}`,
              buildReused: true,
            },
          };
  const command: Command<Snapshot, true> = {
    name: "provisioning.finalizeCandidate",
    input: i,
    retryOn: ["operation_conflict", "precondition_changed"],
    naturalKeyTables: [
      "wfp_publish_receipts",
      "deployment_revisions",
      "operation_events",
      "audit_events",
    ],
    read,
    decide: (s) => {
      if (s.targetNative && !nativeAuthLaunchAllowed(context, p.organizationId, p.projectId))
        return { reject: failure("Native Auth launch unavailable") };
      if (!s.candidate || !s.source || !s.route || !s.gateway)
        return { reject: failure("WFP candidate is unavailable") };
      if (
        !Object.entries(s.gateway).every(
          ([key, value]) => JSON.stringify(value) === JSON.stringify(Reflect.get(p.gateway, key)),
        )
      )
        return { reject: failure("Shared gateway route changed before publication") };
      const refresh = s.source["binding_refresh_snapshot"] !== null;
      if (
        refresh !== (i.completion === null) ||
        refresh !== (i.bindingRefreshSnapshot !== null) ||
        (refresh && i.eventType !== "DeploymentRequestedV1")
      )
        return { reject: failure("Binding refresh finalization scope changed") };
      const c = s.candidate,
        source = s.source,
        kind = source["kind"],
        plan = kind === "deploy" ? source["deploy_plan_id"] : source["reused_plan_id"],
        build =
          kind === "deploy"
            ? source["artifact_build_execution_id"]
            : source["reused_build_execution_id"];
      if (
        kind === "rollback" ||
        source["event_type"] !== i.eventType ||
        typeof plan !== "string" ||
        typeof build !== "string" ||
        (kind !== "deploy" &&
          (source["reused_artifact_id"] !== c["artifact_id"] ||
            build !== source["artifact_build_execution_id"]))
      )
        return { reject: failure("WFP reused artifact provenance changed") };
      if (
        p.gateway.targetScriptName !== c["immutable_script_name"] ||
        p.gateway.targetDeploymentId !== p.productDeploymentId ||
        p.gateway.targetProviderTag !== c["provider_tag"] ||
        p.gateway.targetArtifactDigest !== `sha256:${String(c["artifact_hex"])}`
      )
        return { reject: failure("WFP candidate shared gateway target changed") };
      if (s.collision && !s.replay && s.nativePending === null)
        return { reject: failure("WFP candidate finalization receipt changed") };
      const terminal = evidence(s),
        complete = i.completion;
      if (
        i.eventType === "DeploymentRequestedV1" &&
        complete !== null &&
        (complete.result === null ||
          complete.result.operationId !== p.operationId ||
          complete.result.deploymentId !== p.productDeploymentId ||
          complete.result.planId !== plan ||
          complete.result.url !== p.deploymentUrl ||
          complete.result.artifactSha256 !== c["artifact_hex"])
      )
        return { reject: failure("Finalized WFP deployment result changed") };
      if (s.nativePending !== null) {
        const pending = s.nativePending;
        if (
          pending["event_type"] !== i.eventType ||
          pending["head_deployment_id"] !== p.productDeploymentId ||
          pending["head_revision_id"] !== p.revisionId ||
          pending["head_version"] !== p.expectedHeadVersion + 1 ||
          (!refresh &&
            (pending["completion"] !== JSON.stringify(complete) ||
              pending["terminal_evidence"] !== JSON.stringify(terminal))) ||
          (refresh &&
            pending["binding_refresh_snapshot"] !== JSON.stringify(i.bindingRefreshSnapshot)) ||
          pending["publication"] !== JSON.stringify(p) ||
          pending["schedule"] !== JSON.stringify(i.schedule) ||
          pending["result_url"] !== p.deploymentUrl ||
          pending["artifact_sha256"] !== c["artifact_hex"] ||
          pending["published_at"] !== p.publishedAt
        )
          return { reject: failure("Native policy sync publication changed") };
        return {
          statements: [
            fenceRaceGuard(db, "operation_conflict", p.organizationId),
            ...(refresh
              ? bindingRefreshStatements(
                  db,
                  p,
                  s.source["binding_refresh_snapshot"],
                  true,
                  i.bindingRefreshSnapshot,
                )
              : workflowExecutionGuards(db, p, s.proof)),
            guard(
              db,
              "operation_conflict",
              "NOT EXISTS(SELECT 1 FROM native_auth_policy_syncs sync JOIN environments e ON e.organization_id=sync.organization_id AND e.project_id=sync.project_id AND e.environment_id=sync.environment_id WHERE sync.organization_id=?1 AND sync.project_id=?2 AND sync.environment_id=?3 AND sync.operation_id=?4 AND sync.state IN('refresh_pending_cleanup','pending') AND e.active_deployment_id=sync.head_deployment_id AND e.active_revision_id=sync.head_revision_id AND e.head_version=sync.head_version)",
              [...scope, p.operationId],
            ),
          ],
          result: () => true,
        };
      }
      if (s.replay && terminalMatches(s.run, terminal))
        return {
          statements: [
            fenceRaceGuard(db, "operation_conflict", p.organizationId),
            ...workflowExecutionGuards(db, p, s.proof),
            guard(db, "operation_conflict", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
              ...scope,
              s.route,
            ]),
            guard(db, "operation_conflict", `NOT EXISTS(${REPLAY})`, replayValues),
          ],
          result: () => true,
        };
      if (!refresh && (!s.run || s.run["state"] !== "queued"))
        return { reject: failure("Product Workflow state changed") };
      const statements = [
        fenceRaceGuard(db, "operation_conflict", p.organizationId),
        ...(refresh
          ? bindingRefreshStatements(
              db,
              p,
              s.source["binding_refresh_snapshot"],
              true,
              i.bindingRefreshSnapshot,
            )
          : workflowExecutionGuards(db, p, s.proof)),
        guard(db, "operation_conflict", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
          ...scope,
          s.route,
        ]),
        guard(db, "operation_conflict", `EXISTS(${PUSH_ALLOWED})`, [
          p.organizationId,
          p.projectId,
          p.operationId,
        ]),
        guard(db, "operation_conflict", `NOT EXISTS(${CANDIDATE})`, candidateValues),
      ];
      if (!s.replay)
        statements.push(
          db
            .prepare(
              "INSERT INTO wfp_publish_receipts(wfp_receipt_id,organization_id,project_id,artifact_id,dispatch_namespace,script_name,provider_version_id,deployment_url,published_at,environment_id,candidate_receipt_id,product_deployment_id,shared_gateway_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              p.wfpReceiptId,
              p.organizationId,
              p.projectId,
              c["artifact_id"],
              c["dispatch_namespace"],
              c["immutable_script_name"],
              c["provider_tag"],
              p.deploymentUrl,
              p.publishedAt,
              p.environmentId,
              p.candidateReceiptId,
              p.productDeploymentId,
              p.gateway.revision,
            ),
          db
            .prepare(
              "INSERT INTO deployment_revisions(revision_id,organization_id,project_id,operation_id,deployment_id,plan_id,build_execution_id,artifact_id,wfp_receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              p.revisionId,
              p.organizationId,
              p.projectId,
              p.operationId,
              p.productDeploymentId,
              plan,
              build,
              c["artifact_id"],
              p.wfpReceiptId,
              p.publishedAt,
            ),
          db
            .prepare(
              "UPDATE environments SET active_deployment_id=?4,active_revision_id=?5,head_version=?6,updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND head_version=?8",
            )
            .bind(
              ...scope,
              p.productDeploymentId,
              p.revisionId,
              p.expectedHeadVersion + 1,
              p.publishedAt,
              p.expectedHeadVersion,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              "UPDATE deployments SET status='succeeded',active_revision_id=?4,active_version=active_version+1,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND active_version=0",
            )
            .bind(
              p.organizationId,
              p.projectId,
              p.productDeploymentId,
              p.revisionId,
              p.publishedAt,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
          ...(s.serving === null
            ? []
            : servingStartStatements(db, { ...p, activatedAt: p.publishedAt }, s.serving)),
          ...(refresh || s.nativeAffected
            ? []
            : [
                db
                  .prepare(
                    "UPDATE operations SET state='succeeded',lease_expires_at=NULL,result_deployment_id=?4,result_url=?5,result_artifact_sha256=unhex(?6),updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
                  )
                  .bind(
                    p.organizationId,
                    p.projectId,
                    p.operationId,
                    p.productDeploymentId,
                    p.deploymentUrl,
                    c["artifact_hex"],
                    p.publishedAt,
                  ),
              ]),
          db
            .prepare(
              "UPDATE github_push_deployments SET state='active',cleanup_required=0,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
            )
            .bind(p.organizationId, p.projectId, p.operationId, p.publishedAt),
        );
      statements.push(
        ...functionScheduleStatements(db, {
          organizationId: p.organizationId,
          projectId: p.projectId,
          environmentId: p.environmentId,
          candidateReceiptId: p.candidateReceiptId,
          deploymentId: p.productDeploymentId,
          crons: i.schedule.crons,
          egressAllowedOrigins: i.schedule.egressAllowedOrigins,
          now: p.publishedAt,
        }),
      );
      if (s.nativeAffected && (refresh || (complete !== null && s.run !== null))) {
        statements.push(
          nativePendingStatement(db, p, {
            eventType: i.eventType,
            headDeploymentId: p.productDeploymentId,
            headRevisionId: p.revisionId,
            headVersion: p.expectedHeadVersion + 1,
            completion: complete,
            publication: p,
            schedule: i.schedule,
            ...(refresh ? { bindingRefreshSnapshot: i.bindingRefreshSnapshot } : {}),
            evidence: terminal,
            result: i.eventType === "DeploymentRequestedV1" ? (complete?.result ?? null) : null,
            url: p.deploymentUrl,
            artifact: String(c["artifact_hex"]),
            publishedAt: p.publishedAt,
          }),
          guard(db, "operation_conflict", "changes()<>1"),
        );
      }
      if (!refresh && !s.nativeAffected && complete !== null && s.run !== null)
        statements.push(
          db
            .prepare(
              "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND event_type=?5 AND accepted_lifecycle_version=?6",
            )
            .bind(...scope, p.operationId, i.eventType, complete.acceptedLifecycleVersion),
          guard(db, "operation_conflict", "changes()<>1"),
          ...workflowTerminalStatements(
            db,
            p,
            complete,
            i.eventType,
            s.run,
            terminal,
            p.publishedAt,
            i.eventType === "DeploymentRequestedV1" ? complete.result : null,
          ),
        );
      return { statements, result: () => true };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      if (
        !(
          s.replay &&
          terminalMatches(s.run, evidence(s)) &&
          s.gateway !== null &&
          Object.entries(s.gateway).every(
            ([key, value]) => JSON.stringify(value) === JSON.stringify(Reflect.get(p.gateway, key)),
          )
        )
      )
        return undefined;
      await reader.batch([
        ...workflowExecutionGuards(reader, p, s.proof),
        guard(reader, "operation_conflict", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
          ...scope,
          s.route,
        ]),
        guard(reader, "operation_conflict", `NOT EXISTS(${REPLAY})`, replayValues),
      ]);
      return true;
    },
  };
  // The fixed receipt and run identities recover a lost response; normal replay takes the same decision path.
  await runCommand(db, command);
}

const ROLLBACK_REPLAY = `SELECT environment.head_version FROM wfp_rollback_activation_receipts activation
     INNER JOIN environments environment ON environment.organization_id=activation.organization_id AND environment.project_id=activation.project_id AND environment.environment_id=activation.environment_id
     INNER JOIN operations operation ON operation.organization_id=activation.organization_id AND operation.project_id=activation.project_id AND operation.operation_id=activation.operation_id
     INNER JOIN deployments rollback ON rollback.organization_id=activation.organization_id AND rollback.project_id=activation.project_id AND rollback.deployment_id=activation.rollback_deployment_id
     WHERE activation.rollback_activation_receipt_id=?1 AND activation.organization_id=?2 AND activation.project_id=?3 AND activation.environment_id=?4 AND activation.operation_id=?5
       AND activation.rollback_deployment_id=?6 AND activation.target_deployment_id=?7 AND activation.target_revision_id=?8
       AND activation.candidate_receipt_id=?9 AND activation.wfp_receipt_id=?10 AND activation.shared_gateway_revision=?11
       AND activation.activated_at=?12 AND activation.activated_head_version=?13
       AND environment.active_deployment_id=?7 AND environment.active_revision_id=?8 AND environment.head_version=?13
       AND operation.state='succeeded' AND rollback.status='succeeded'`;
const ROLLBACK_TARGET = `SELECT receipt.deployment_url,lower(hex(artifact.artifact_sha256)) artifact_hex,target.plan_id
     FROM deployments rollback
     INNER JOIN product_command_intents intent ON intent.organization_id=rollback.organization_id AND intent.project_id=rollback.project_id AND intent.operation_id=rollback.operation_id AND intent.environment_id=rollback.environment_id AND intent.event_type='DeploymentRollbackRequestedV1' AND intent.deployment_id=rollback.deployment_id AND intent.target_deployment_id=rollback.rollback_target_deployment_id AND intent.target_revision_id=rollback.rollback_target_revision_id
     INNER JOIN deployment_revisions target
       ON target.organization_id=rollback.organization_id AND target.project_id=rollback.project_id
      AND target.deployment_id=rollback.rollback_target_deployment_id
      AND target.revision_id=rollback.rollback_target_revision_id
     INNER JOIN wfp_publish_receipts receipt
       ON receipt.organization_id=target.organization_id AND receipt.project_id=target.project_id
      AND receipt.wfp_receipt_id=target.wfp_receipt_id
     INNER JOIN wfp_candidate_receipts candidate
       ON candidate.organization_id=receipt.organization_id AND candidate.project_id=receipt.project_id
      AND candidate.candidate_receipt_id=receipt.candidate_receipt_id
     INNER JOIN build_artifacts artifact
       ON artifact.organization_id=target.organization_id AND artifact.project_id=target.project_id
      AND artifact.artifact_id=target.artifact_id
     WHERE rollback.organization_id=?1 AND rollback.project_id=?2
       AND rollback.environment_id=?3 AND rollback.operation_id=?4
       AND rollback.deployment_id=?5 AND rollback.kind='rollback'
       AND rollback.rollback_target_deployment_id=?6 AND rollback.rollback_target_revision_id=?7
       AND candidate.candidate_receipt_id=?8 AND receipt.wfp_receipt_id=?9
       AND receipt.shared_gateway_revision IS NOT NULL AND receipt.script_name=candidate.immutable_script_name`;

/** Original immutable rollback activation, current schedule, claim release and terminal group. */
export async function finalizeProductRollback(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = rollbackInput.parse(raw),
    a = i.activation,
    c = i.completion,
    { db } = await routeOrganization(context, a.organizationId),
    scope = [a.organizationId, a.projectId, a.environmentId],
    targetValues = [
      ...scope,
      a.operationId,
      a.rollbackDeploymentId,
      a.targetDeploymentId,
      a.targetRevisionId,
      a.candidateReceiptId,
      a.wfpReceiptId,
    ],
    replayValues = [
      a.rollbackActivationReceiptId,
      ...scope,
      a.operationId,
      a.rollbackDeploymentId,
      a.targetDeploymentId,
      a.targetRevisionId,
      a.candidateReceiptId,
      a.wfpReceiptId,
      a.gateway.revision,
      a.completedAt,
      a.expectedHeadVersion + 1,
    ];
  if (
    a.gateway.provider !== "ohmyhost-shared-gateway" ||
    !a.gateway.active ||
    a.gateway.organizationId !== a.organizationId ||
    a.gateway.projectId !== a.projectId ||
    a.gateway.environmentId !== a.environmentId ||
    a.gateway.operationId !== a.operationId ||
    a.gateway.candidateReceiptId !== a.candidateReceiptId
  )
    throw failure("Shared gateway receipt scope changed");
  type Snapshot = {
    target: Row | null;
    route: string | null;
    gateway: Awaited<ReturnType<typeof receiptOf>> | null;
    run: Row | null;
    replay: boolean;
    collision: boolean;
    proof: Awaited<ReturnType<typeof readWorkflowDelegation>>;
    nativeAffected: boolean;
    targetNative: boolean;
    nativePending: Row | null;
  };
  const read = async (reader: typeof db): Promise<Snapshot> => {
    const rows = await reader.batch([
        reader.prepare(ROLLBACK_TARGET).bind(...targetValues),
        reader.prepare(LATEST).bind(...scope),
        reader.prepare(RUN).bind(...terminalIdentity(a, c, "DeploymentRollbackRequestedV1")),
        reader.prepare(ROLLBACK_REPLAY).bind(...replayValues),
        reader
          .prepare(
            "SELECT 1 FROM wfp_rollback_activation_receipts WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(a.organizationId, a.projectId, a.operationId),
      ]),
      route = (rows[1]?.results[0]?.["value"] as string | undefined) ?? null;
    const plan = rows[0]?.results[0]?.["plan_id"];
    const native =
      typeof plan === "string"
        ? await reader
            .prepare(NATIVE_AFFECTED)
            .bind(...scope, plan)
            .first()
        : null;
    const pending = await reader
      .prepare(
        "SELECT * FROM native_auth_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND state='pending'",
      )
      .bind(...scope, a.operationId)
      .first<Row>();
    return {
      targetNative:
        typeof plan === "string" &&
        (await reader
          .prepare(
            "SELECT 1 FROM deployment_plans WHERE organization_id=?1 AND project_id=?2 AND plan_id=?3 AND json_extract(framework_plan,'$.auth.provider')='omh-native'",
          )
          .bind(a.organizationId, a.projectId, plan)
          .first()) !== null,
      target: rows[0]?.results[0] ?? null,
      route,
      gateway: route === null ? null : await receiptOf(JSON.parse(route) as Route),
      run: rows[2]?.results[0] ?? null,
      replay: (rows[3]?.results.length ?? 0) > 0,
      collision: (rows[4]?.results.length ?? 0) > 0,
      proof: await readWorkflowDelegation(reader, a),
      nativeAffected: native !== null,
      nativePending: pending,
    };
  };
  const evidence = (s: Snapshot) => ({
    runtimePolicy: c.runtimePolicy,
    rollback: {
      deploymentId: a.rollbackDeploymentId,
      targetDeploymentId: a.targetDeploymentId,
      artifactDigest: `sha256:${String(s.target?.["artifact_hex"])}`,
      url: a.gateway.publicOrigin,
      buildReused: true,
    },
  });
  const command: Command<Snapshot, true> = {
    name: "provisioning.finalizeRollback",
    input: i,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["wfp_rollback_activation_receipts", "operation_events", "audit_events"],
    read,
    decide: (s) => {
      if (s.targetNative && !nativeAuthLaunchAllowed(context, a.organizationId, a.projectId))
        return { reject: failure("Native Auth launch unavailable") };
      if (!s.target || !s.route || !s.gateway)
        return { reject: failure("Rollback immutable candidate changed") };
      if (
        !Object.entries(s.gateway).every(
          ([key, value]) => JSON.stringify(value) === JSON.stringify(Reflect.get(a.gateway, key)),
        )
      )
        return { reject: failure("Shared gateway route changed before publication") };
      if (
        a.gateway.targetDeploymentId !== a.targetDeploymentId ||
        a.gateway.targetArtifactDigest !== `sha256:${String(s.target["artifact_hex"])}`
      )
        return { reject: failure("Rollback shared gateway target changed") };
      const terminal = evidence(s);
      if (s.nativePending !== null) {
        const pending = s.nativePending;
        if (
          pending["event_type"] !== "DeploymentRollbackRequestedV1" ||
          pending["head_deployment_id"] !== a.targetDeploymentId ||
          pending["head_revision_id"] !== a.targetRevisionId ||
          pending["head_version"] !== a.expectedHeadVersion + 1 ||
          pending["completion"] !== JSON.stringify(c) ||
          pending["publication"] !== JSON.stringify(a) ||
          pending["schedule"] !== JSON.stringify(i.schedule) ||
          pending["terminal_evidence"] !== JSON.stringify(terminal) ||
          pending["result_url"] !== a.gateway.publicOrigin ||
          pending["artifact_sha256"] !== s.target["artifact_hex"] ||
          pending["published_at"] !== a.completedAt
        )
          return { reject: failure("Native rollback policy sync publication changed") };
        return {
          statements: [
            fenceRaceGuard(db, "operation_conflict", a.organizationId),
            ...workflowExecutionGuards(db, a, s.proof),
            guard(
              db,
              "operation_conflict",
              "NOT EXISTS(SELECT 1 FROM native_auth_policy_syncs sync JOIN environments e ON e.organization_id=sync.organization_id AND e.project_id=sync.project_id AND e.environment_id=sync.environment_id WHERE sync.organization_id=?1 AND sync.project_id=?2 AND sync.environment_id=?3 AND sync.operation_id=?4 AND sync.state='pending' AND e.active_deployment_id=sync.head_deployment_id AND e.active_revision_id=sync.head_revision_id AND e.head_version=sync.head_version)",
              [...scope, a.operationId],
            ),
          ],
          result: () => true,
        };
      }
      if (s.replay && terminalMatches(s.run, terminal))
        return {
          statements: [
            ...workflowExecutionGuards(db, a, s.proof),
            guard(db, "operation_conflict", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
              ...scope,
              s.route,
            ]),
            guard(db, "operation_conflict", `NOT EXISTS(${ROLLBACK_REPLAY})`, replayValues),
          ],
          result: () => true,
        };
      if (s.collision && !s.replay)
        return { reject: failure("Rollback activation receipt changed") };
      if (!s.run || s.run["state"] !== "queued")
        return { reject: failure("Product Workflow state changed") };
      const statements = [
        fenceRaceGuard(db, "operation_conflict", a.organizationId),
        ...workflowExecutionGuards(db, a, s.proof),
        guard(db, "operation_conflict", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
          ...scope,
          s.route,
        ]),
        guard(db, "operation_conflict", `NOT EXISTS(${ROLLBACK_TARGET})`, targetValues),
      ];
      if (!s.replay)
        statements.push(
          db
            .prepare(
              "INSERT INTO wfp_rollback_activation_receipts(rollback_activation_receipt_id,organization_id,project_id,environment_id,operation_id,rollback_deployment_id,target_deployment_id,target_revision_id,candidate_receipt_id,wfp_receipt_id,shared_gateway_revision,activated_at,activated_head_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              a.rollbackActivationReceiptId,
              ...scope,
              a.operationId,
              a.rollbackDeploymentId,
              a.targetDeploymentId,
              a.targetRevisionId,
              a.candidateReceiptId,
              a.wfpReceiptId,
              a.gateway.revision,
              a.completedAt,
              a.expectedHeadVersion + 1,
            ),
          db
            .prepare(
              "UPDATE environments SET active_deployment_id=?4,active_revision_id=?5,head_version=?6,updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND head_version=?8",
            )
            .bind(
              ...scope,
              a.targetDeploymentId,
              a.targetRevisionId,
              a.expectedHeadVersion + 1,
              a.completedAt,
              a.expectedHeadVersion,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              "UPDATE deployments SET status='succeeded',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND kind='rollback'",
            )
            .bind(a.organizationId, a.projectId, a.rollbackDeploymentId, a.completedAt),
          ...(s.nativeAffected
            ? []
            : [
                db
                  .prepare(
                    "UPDATE operations SET state='succeeded',lease_expires_at=NULL,result_deployment_id=?4,result_url=?5,result_artifact_sha256=unhex(?6),updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
                  )
                  .bind(
                    a.organizationId,
                    a.projectId,
                    a.operationId,
                    a.targetDeploymentId,
                    a.gateway.publicOrigin,
                    s.target["artifact_hex"],
                    a.completedAt,
                  ),
              ]),
        );
      statements.push(
        ...functionScheduleStatements(db, {
          organizationId: a.organizationId,
          projectId: a.projectId,
          environmentId: a.environmentId,
          deploymentId: a.targetDeploymentId,
          candidateReceiptId: a.candidateReceiptId,
          crons: i.schedule.crons,
          egressAllowedOrigins: i.schedule.egressAllowedOrigins,
          now: a.completedAt,
        }),
        ...(s.nativeAffected
          ? [
              nativePendingStatement(db, a, {
                eventType: "DeploymentRollbackRequestedV1",
                headDeploymentId: a.targetDeploymentId,
                headRevisionId: a.targetRevisionId,
                headVersion: a.expectedHeadVersion + 1,
                completion: c,
                publication: a,
                schedule: i.schedule,
                evidence: terminal,
                result: null,
                url: a.gateway.publicOrigin,
                artifact: String(s.target["artifact_hex"]),
                publishedAt: a.completedAt,
              }),
              guard(db, "operation_conflict", "changes()<>1"),
            ]
          : [
              db
                .prepare(
                  "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND event_type='DeploymentRollbackRequestedV1' AND accepted_lifecycle_version=?5",
                )
                .bind(...scope, a.operationId, c.acceptedLifecycleVersion),
              guard(db, "operation_conflict", "changes()<>1"),
              ...workflowTerminalStatements(
                db,
                a,
                c,
                "DeploymentRollbackRequestedV1",
                s.run,
                terminal,
                a.completedAt,
                null,
              ),
            ]),
      );
      return { statements, result: () => true };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      if (
        !(
          s.replay &&
          terminalMatches(s.run, evidence(s)) &&
          s.gateway !== null &&
          Object.entries(s.gateway).every(
            ([key, value]) => JSON.stringify(value) === JSON.stringify(Reflect.get(a.gateway, key)),
          )
        )
      )
        return undefined;
      await reader.batch([
        ...workflowExecutionGuards(reader, a, s.proof),
        guard(reader, "operation_conflict", `coalesce((SELECT value FROM(${LATEST})),'null')<>?4`, [
          ...scope,
          s.route,
        ]),
        guard(reader, "operation_conflict", `NOT EXISTS(${ROLLBACK_REPLAY})`, replayValues),
      ]);
      return true;
    },
  };
  await runCommand(db, command);
}
const refreshScope = z.strictObject({
  ...scope,
  snapshot: bindingRefreshSnapshotInput,
  allowPublished: z.boolean(),
});
/** The original frozen metadata precheck used immediately before refresh provider staging/retirement. */
export async function assertProductBindingRefresh(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = refreshScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const read = async (reader: typeof db) =>
    (
      await reader
        .prepare(
          "SELECT binding_refresh_snapshot FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND event_type='DeploymentRequestedV1'",
        )
        .bind(i.organizationId, i.projectId, i.environmentId, i.operationId)
        .first<Row>()
    )?.["binding_refresh_snapshot"];
  const statements = (reader: typeof db, stored: unknown) => [
    fenceRaceGuard(reader, "operation_conflict", i.organizationId),
    ...bindingRefreshStatements(reader, i, stored, i.allowPublished, i.snapshot),
  ];
  const command: Command<unknown, true> = {
    name: "provisioning.assertBindingRefresh",
    input: i,
    retryOn: ["operation_conflict"],
    read,
    decide: (stored) => ({ statements: statements(db, stored), result: () => true }),
    lookup: async (reader) => {
      await reader.batch(statements(reader, await read(reader)));
      return true;
    },
  };
  await runCommand(db, command);
}
const finishRefreshInput = z.strictObject({
  ...scope,
  completedAt: timestamp,
  completion: completion.extend({ result: z.unknown().transform(parseOperationDeploymentResult) }),
});
const REFRESH_PUBLICATION = `SELECT intent.binding_refresh_snapshot,intent.deployment_id,intent.plan_id,revision.revision_id,lower(hex(artifact.artifact_sha256)) artifact_hex,receipt.deployment_url FROM product_command_intents intent JOIN environments environment ON environment.organization_id=intent.organization_id AND environment.project_id=intent.project_id AND environment.environment_id=intent.environment_id JOIN deployment_revisions revision ON revision.organization_id=intent.organization_id AND revision.project_id=intent.project_id AND revision.operation_id=intent.operation_id AND revision.deployment_id=intent.deployment_id AND revision.revision_id=?4 AND revision.plan_id=intent.plan_id JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?4 AND intent.event_type='DeploymentRequestedV1' AND intent.binding_refresh_snapshot IS NOT NULL`;
const REFRESH_ABSENCE = `SELECT 1 FROM run_resource_inventory inventory WHERE inventory.organization_id=?1 AND inventory.project_id=?2 AND inventory.operation_id=?3 AND inventory.provider='cloudflare' AND inventory.resource_kind='wfp-script' AND lower(hex(inventory.external_ref_hash))=?4 AND(SELECT attempt.outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1)IN('removed','not_found')`;
/** Original refresh source-absence proof, operation result, claim release and terminal history remain one effect. */
export async function finishProductBindingRefresh(
  context: CatalogContext,
  raw: unknown,
): Promise<"completed" | "replayed" | "native_policy_pending"> {
  const i = finishRefreshInput.parse(raw),
    c = i.completion,
    { db } = await routeOrganization(context, i.organizationId),
    ids = [i.organizationId, i.projectId, i.environmentId, i.operationId],
    terminal = { result: c.result, runtimePolicy: c.runtimePolicy };
  type Snapshot = {
    published: Row | null;
    run: Row | null;
    proof: Awaited<ReturnType<typeof readWorkflowDelegation>>;
    sourceHash: string | null;
    nativeSync: Row | null;
  };
  const read = async (reader: typeof db): Promise<Snapshot> => {
    const rows = await reader.batch([
        reader.prepare(REFRESH_PUBLICATION).bind(...ids),
        reader.prepare(RUN).bind(...terminalIdentity(i, c, "DeploymentRequestedV1")),
        reader
          .prepare(
            "SELECT * FROM native_auth_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND state IN('refresh_pending_cleanup','pending')",
          )
          .bind(...ids),
      ]),
      published = rows[0]?.results[0] ?? null;
    let sourceHash: string | null = null;
    if (typeof published?.["binding_refresh_snapshot"] === "string") {
      const snapshot = bindingRefreshSnapshotInput.parse(
        JSON.parse(published["binding_refresh_snapshot"]),
      );
      sourceHash = await resourceHash(
        "cloudflare",
        "wfp-script",
        `${snapshot.sourceNamespace}/${snapshot.sourceScriptName}`,
      );
    }
    return {
      published,
      run: rows[1]?.results[0] ?? null,
      proof: await readWorkflowDelegation(reader, i),
      sourceHash,
      nativeSync: rows[2]?.results[0] ?? null,
    };
  };
  const command: Command<Snapshot, "completed" | "replayed" | "native_policy_pending"> = {
    name: "provisioning.finishBindingRefresh",
    input: i,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["operation_events", "audit_events"],
    read,
    decide: (s) => {
      if (terminalMatches(s.run, terminal))
        return {
          statements: [
            fenceRaceGuard(db, "operation_conflict", i.organizationId),
            ...workflowExecutionGuards(db, i, s.proof),
          ],
          result: () => "replayed",
        };
      if (
        !s.published ||
        !s.run ||
        s.sourceHash === null ||
        s.published["deployment_id"] !== c.result.deploymentId ||
        s.published["plan_id"] !== c.result.planId ||
        s.published["artifact_hex"] !== c.result.artifactSha256 ||
        s.published["deployment_url"] !== c.result.url ||
        c.result.operationId !== i.operationId
      )
        return { reject: failure("Finalized WFP deployment result changed") };
      const statements = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        ...workflowExecutionGuards(db, i, s.proof),
        ...bindingRefreshStatements(db, i, s.published["binding_refresh_snapshot"], true),
        guard(db, "operation_conflict", `NOT EXISTS(${REFRESH_PUBLICATION})`, ids),
        guard(db, "operation_conflict", `NOT EXISTS(${REFRESH_ABSENCE})`, [
          i.organizationId,
          i.projectId,
          i.operationId,
          s.sourceHash,
        ]),
      ];
      if (s.run["state"] !== "queued") return { reject: failure("Product Workflow state changed") };
      if (s.nativeSync !== null) {
        const sync = s.nativeSync;
        const expectedSnapshot = JSON.stringify(
          bindingRefreshSnapshotInput.parse(
            JSON.parse(String(s.published["binding_refresh_snapshot"])),
          ),
        );
        if (
          sync["binding_refresh_snapshot"] !== expectedSnapshot ||
          sync["head_deployment_id"] !== c.result.deploymentId ||
          sync["head_revision_id"] !== s.published["revision_id"] ||
          sync["result_url"] !== c.result.url ||
          sync["artifact_sha256"] !== c.result.artifactSha256
        )
          return { reject: failure("Native binding refresh publication changed") };
        const claimId = String(sync["claim_id"]),
          syncScope = [...ids, claimId];
        statements.push(guard(db, "operation_conflict", `NOT EXISTS(${NATIVE_SYNC})`, syncScope));
        if (sync["state"] === "pending") {
          if (
            sync["completion"] !== JSON.stringify(c) ||
            sync["terminal_evidence"] !== JSON.stringify(terminal) ||
            sync["result_json"] !== JSON.stringify(c.result) ||
            sync["refresh_source_hash"] !== s.sourceHash ||
            sync["terminal_at"] !== i.completedAt
          )
            return { reject: failure("Native binding refresh completion changed") };
          return { statements, result: () => "native_policy_pending" };
        }
        statements.push(
          db
            .prepare(
              "UPDATE native_auth_policy_syncs SET completion=?6,terminal_evidence=?7,result_json=?8,terminal_at=?9,refresh_source_hash=?10,state='pending' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND state='refresh_pending_cleanup'",
            )
            .bind(
              ...syncScope,
              JSON.stringify(c),
              JSON.stringify(terminal),
              JSON.stringify(c.result),
              i.completedAt,
              s.sourceHash,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
        );
        return { statements, result: () => "native_policy_pending" };
      }
      statements.push(
        db
          .prepare(
            "UPDATE operations SET state='succeeded',lease_expires_at=NULL,result_deployment_id=?4,result_url=?5,result_artifact_sha256=unhex(?6),updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
          )
          .bind(
            i.organizationId,
            i.projectId,
            i.operationId,
            c.result.deploymentId,
            c.result.url,
            c.result.artifactSha256,
            i.completedAt,
          ),
        guard(
          db,
          "operation_conflict",
          "NOT EXISTS(SELECT 1 FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='succeeded' AND result_deployment_id=?4 AND result_url=?5 AND lower(hex(result_artifact_sha256))=?6)",
          [
            i.organizationId,
            i.projectId,
            i.operationId,
            c.result.deploymentId,
            c.result.url,
            c.result.artifactSha256,
          ],
        ),
        db
          .prepare(
            "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND event_type='DeploymentRequestedV1' AND accepted_lifecycle_version=?5",
          )
          .bind(...ids, c.acceptedLifecycleVersion),
        guard(db, "operation_conflict", "changes()<>1"),
        ...workflowTerminalStatements(
          db,
          i,
          c,
          "DeploymentRequestedV1",
          s.run,
          terminal,
          i.completedAt,
          c.result,
        ),
      );
      return { statements, result: () => "completed" };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      if (!terminalMatches(s.run, terminal)) return undefined;
      await reader.batch([...workflowExecutionGuards(reader, i, s.proof)]);
      return "replayed";
    },
  };
  return runCommand(db, command);
}

const nativeSyncScope = z.strictObject({ ...scope, claimId: ulid });
const nativeSyncInput = nativeSyncScope.extend({
  headVersion: z.number().int().positive(),
  configurationRevision: z.number().int().positive().nullable(),
  revocationEpoch: z.number().int().positive().nullable(),
  ownerEnabled: z.boolean().nullable(),
  canonicalOrigin: z.string().nullable(),
  registryVersion: z.number().int().positive().nullable(),
  acknowledgement: z.enum(["applied", "unprovisioned"]),
});
const NATIVE_SYNC = `SELECT sync.* FROM native_auth_policy_syncs sync JOIN product_provider_mutation_claims claim
 ON claim.organization_id=sync.organization_id AND claim.project_id=sync.project_id AND claim.environment_id=sync.environment_id AND claim.operation_id=sync.operation_id AND claim.claim_id=sync.claim_id AND claim.event_type=sync.event_type
 JOIN projects p ON p.organization_id=sync.organization_id AND p.project_id=sync.project_id AND p.owner_state='active' AND p.lifecycle_state='active' AND p.lifecycle_version=claim.accepted_lifecycle_version AND p.active_billing_epoch_id=claim.billing_epoch_id
 JOIN billing_epochs epoch ON epoch.organization_id=p.organization_id AND epoch.project_id=p.project_id AND epoch.billing_epoch_id=p.active_billing_epoch_id AND epoch.ended_at IS NULL
 JOIN operations op ON op.organization_id=sync.organization_id AND op.project_id=sync.project_id AND op.operation_id=sync.operation_id AND op.billing_epoch_id=claim.billing_epoch_id AND op.state IN('queued','running')
 JOIN environments e ON e.organization_id=sync.organization_id AND e.project_id=sync.project_id AND e.environment_id=sync.environment_id AND e.active_deployment_id=sync.head_deployment_id AND e.active_revision_id=sync.head_revision_id AND e.head_version=sync.head_version
 WHERE sync.organization_id=?1 AND sync.project_id=?2 AND sync.environment_id=?3 AND sync.operation_id=?4 AND sync.claim_id=?5 AND sync.state IN('refresh_pending_cleanup','pending')`;
const syncValues = (i: z.output<typeof nativeSyncScope>) => [
  i.organizationId,
  i.projectId,
  i.environmentId,
  i.operationId,
  i.claimId,
];
const NOT_PROVISIONED = `NOT EXISTS(SELECT 1 FROM native_auth_database_targets WHERE project_id=?2 AND ended_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM native_auth_database_operations WHERE project_id=?2 AND state='dispatched')
 AND NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE project_id=?2 AND environment_id=?3)`;

/** Exact current policy for a head already committed by a pending Native publication. */
export async function readPendingNativePolicySync(context: CatalogContext, raw: unknown) {
  const i = nativeSyncScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = syncValues(i);
  const completed = await db
    .prepare(
      `SELECT 1 FROM native_auth_policy_syncs sync JOIN operations op ON op.organization_id=sync.organization_id AND op.project_id=sync.project_id AND op.operation_id=sync.operation_id JOIN projects p ON p.organization_id=sync.organization_id AND p.project_id=sync.project_id WHERE sync.organization_id=?1 AND sync.project_id=?2 AND sync.environment_id=?3 AND sync.operation_id=?4 AND sync.claim_id=?5 AND sync.state='completed' AND op.state='succeeded' AND p.owner_state='active'`,
    )
    .bind(...v)
    .first();
  if (completed !== null) return { ...i, state: "completed" as const };
  const row = await db
    .prepare(NATIVE_SYNC)
    .bind(...v)
    .first<Row>();
  if (row === null) return null;
  const proof = await readWorkflowDelegation(db, i);
  await db.batch([
    fenceRaceGuard(db, "operation_conflict", i.organizationId),
    ...(row["binding_refresh_snapshot"] === null
      ? workflowExecutionGuards(db, i, proof)
      : bindingRefreshStatements(db, i, row["binding_refresh_snapshot"], true)),
    guard(db, "operation_conflict", `NOT EXISTS(${NATIVE_SYNC})`, v),
  ]);
  if (row["state"] === "refresh_pending_cleanup")
    return {
      ...i,
      state: "cleanup_required" as const,
      headVersion: Number(row["head_version"]),
      targetDeploymentId: String(row["head_deployment_id"]),
      publication: JSON.parse(String(row["publication"])) as unknown,
      bindingRefreshSnapshot: JSON.parse(String(row["binding_refresh_snapshot"])) as unknown,
    };
  const realm = await db
    .prepare(
      "SELECT 1 FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(...v.slice(0, 3))
    .first();
  const registration = await readNativeAuthRegistration(context, {
    projectId: i.projectId,
    environmentId: i.environmentId,
  });
  if (registration === null) {
    const absent = await db
      .prepare(`SELECT ${NOT_PROVISIONED} AS absent`)
      .bind(...v.slice(0, 3))
      .first<{ absent: number }>();
    if (absent?.absent !== 1) throw failure("Native private policy is not yet registered");
  }
  const project = await db
    .prepare("SELECT region FROM projects WHERE organization_id=?1 AND project_id=?2")
    .bind(i.organizationId, i.projectId)
    .first<{ region: "us" | "eu" }>();
  if (!project || (project.region !== "us" && project.region !== "eu"))
    throw failure("Native project region changed");
  const authority =
    realm === null
      ? null
      : await resolveNativeAuthAdminAuthority(context, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          environmentId: i.environmentId,
        });
  if (registration === null) {
    const nativeHead = await db
      .prepare(
        `SELECT 1 FROM environments e JOIN deployment_revisions revision ON revision.organization_id=e.organization_id AND revision.project_id=e.project_id AND revision.deployment_id=e.active_deployment_id AND revision.revision_id=e.active_revision_id JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3 AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native'`,
      )
      .bind(...v.slice(0, 3))
      .first();
    if (nativeHead !== null) throw failure("Native deployment requires verified private storage");
  }
  if (
    registration !== null &&
    (authority === null ||
      !authority.storageReady ||
      registration.organizationId !== i.organizationId)
  )
    throw failure("Native private policy is not ready");
  return {
    ...i,
    state: "pending" as const,
    headVersion: Number(row["head_version"]),
    targetDeploymentId: String(row["head_deployment_id"]),
    region: project.region,
    configurationRevision: authority?.realm.configurationRevision ?? null,
    revocationEpoch: authority?.revocationEpoch ?? null,
    ownerEnabled: authority?.ownerEnabled ?? null,
    canonicalOrigin: authority?.realm.canonicalOrigin ?? null,
    registryVersion: registration?.registryVersion ?? null,
  };
}

/** A trusted workflow supplies the exact private ACK; terminal evidence and claim release commit together. */
export async function completeNativePolicySync(
  context: CatalogContext,
  raw: unknown,
): Promise<"completed" | "replayed"> {
  const i = nativeSyncInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = syncValues(i);
  const any = await db
    .prepare(
      "SELECT * FROM native_auth_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5",
    )
    .bind(...v)
    .first<Row>();
  const acknowledgement = JSON.stringify({
    headVersion: i.headVersion,
    configurationRevision: i.configurationRevision,
    revocationEpoch: i.revocationEpoch,
    ownerEnabled: i.ownerEnabled,
    canonicalOrigin: i.canonicalOrigin,
    registryVersion: i.registryVersion,
    acknowledgement: i.acknowledgement,
  });
  if (any?.["state"] === "completed") {
    if (any["acknowledgement"] !== acknowledgement)
      throw failure("Native policy acknowledgement changed");
    return "replayed";
  }
  const pending = await readPendingNativePolicySync(context, {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    operationId: i.operationId,
    claimId: i.claimId,
  });
  if (
    pending === null ||
    pending.state !== "pending" ||
    pending.headVersion !== i.headVersion ||
    pending.configurationRevision !== i.configurationRevision ||
    pending.revocationEpoch !== i.revocationEpoch ||
    pending.ownerEnabled !== i.ownerEnabled ||
    pending.canonicalOrigin !== i.canonicalOrigin ||
    pending.registryVersion !== i.registryVersion ||
    (i.registryVersion === null
      ? i.acknowledgement !== "unprovisioned"
      : i.acknowledgement !== "applied")
  )
    throw failure("Native policy acknowledgement changed");
  const row = await db
    .prepare(NATIVE_SYNC)
    .bind(...v)
    .first<Row>();
  if (!row) throw failure("Native policy publication changed");
  const c = completion
      .extend({ result: z.unknown().optional() })
      .parse(JSON.parse(String(row["completion"]))),
    eventType = String(row["event_type"]),
    terminal = JSON.parse(String(row["terminal_evidence"])) as unknown,
    result = JSON.parse(String(row["result_json"])) as unknown;
  const run = await db
    .prepare(RUN)
    .bind(...terminalIdentity(i, c, eventType))
    .first<Row>();
  if (!run || run["state"] !== "queued") throw failure("Product Workflow state changed");
  const proof = await readWorkflowDelegation(db, i);
  const acknowledgedAt = instant.parse(new Date().toISOString());
  const completedAt =
    acknowledgedAt < String(row["terminal_at"]) ? String(row["terminal_at"]) : acknowledgedAt;
  await db.batch([
    fenceRaceGuard(db, "operation_conflict", i.organizationId),
    ...(row["binding_refresh_snapshot"] === null
      ? workflowExecutionGuards(db, i, proof)
      : bindingRefreshStatements(db, i, row["binding_refresh_snapshot"], true)),
    guard(db, "operation_conflict", `NOT EXISTS(${NATIVE_SYNC})`, v),
    ...(i.configurationRevision === null
      ? [
          guard(
            db,
            "operation_conflict",
            "EXISTS(SELECT 1 FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3)",
            v.slice(0, 3),
          ),
        ]
      : [
          guard(
            db,
            "operation_conflict",
            `NOT EXISTS(SELECT 1 FROM native_auth_realms realm WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND configuration_revision=?4 AND revocation_epoch=?5 AND enabled=?6 AND (CASE WHEN realm.canonical_origin IS NOT NULL AND EXISTS(SELECT 1 FROM json_each((${originsSql})) origin WHERE origin.value=realm.canonical_origin) THEN realm.canonical_origin ELSE NULL END) IS ?7)`,
            [
              ...v.slice(0, 3),
              i.configurationRevision,
              i.revocationEpoch,
              i.ownerEnabled ? 1 : 0,
              i.canonicalOrigin,
            ],
          ),
        ]),
    ...(i.registryVersion === null
      ? [guard(db, "operation_conflict", `NOT (${NOT_PROVISIONED})`, v.slice(0, 3))]
      : [
          guard(
            db,
            "operation_conflict",
            `NOT EXISTS(SELECT 1 FROM native_auth_registrations reg JOIN native_auth_database_targets target ON target.organization_id=reg.organization_id AND target.project_id=reg.project_id AND target.target_version=reg.target_version AND target.provider_project_id=reg.provider_project_id AND target.database_id=reg.database_id AND target.ended_at IS NULL JOIN native_auth_preparation_receipts proof ON proof.organization_id=reg.organization_id AND proof.project_id=reg.project_id AND proof.environment_id=reg.environment_id AND proof.operation_id=reg.operation_id AND proof.claim_id=reg.claim_id AND proof.target_version=reg.target_version AND proof.provider_project_id=reg.provider_project_id AND proof.database_id=reg.database_id AND proof.schema_name=reg.schema_name AND proof.runtime_role=reg.role_name WHERE reg.organization_id=?1 AND reg.project_id=?2 AND reg.environment_id=?3 AND reg.registry_version=?4 AND reg.state='active' AND proof.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND proof.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}')`,
            [...v.slice(0, 3), i.registryVersion],
          ),
        ]),
    ...(row["refresh_source_hash"] === null
      ? []
      : [
          guard(db, "operation_conflict", `NOT EXISTS(${REFRESH_ABSENCE})`, [
            i.organizationId,
            i.projectId,
            i.operationId,
            row["refresh_source_hash"],
          ]),
        ]),
    db
      .prepare(
        "UPDATE operations SET state='succeeded',lease_expires_at=NULL,result_deployment_id=?4,result_url=?5,result_artifact_sha256=unhex(?6),updated_at=?7 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.operationId,
        row["head_deployment_id"],
        row["result_url"],
        row["artifact_sha256"],
        completedAt,
      ),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND event_type=?6 AND accepted_lifecycle_version=?7",
      )
      .bind(...v, eventType, c.acceptedLifecycleVersion),
    guard(db, "operation_conflict", "changes()<>1"),
    ...workflowTerminalStatements(db, i, c, eventType, run, terminal, completedAt, result),
    db
      .prepare(
        "UPDATE native_auth_policy_syncs SET state='completed',acknowledgement=?6,acknowledged_at=?7 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND state='pending'",
      )
      .bind(...v, acknowledgement, acknowledgedAt),
    guard(db, "operation_conflict", "changes()<>1"),
    // A reconciliation may have downgraded this head while its policy sync was pending. The head is restored in the same
    // batch, and only while it is still the environment's active head at the sync's head version (CORE-27).
    db
      .prepare(
        "UPDATE deployments SET status='succeeded',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND status IN('reconciliation_required','running') AND EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=deployments.organization_id AND e.project_id=deployments.project_id AND e.environment_id=?5 AND e.active_deployment_id=deployments.deployment_id AND e.head_version=?6)",
      )
      .bind(
        i.organizationId,
        i.projectId,
        row["head_deployment_id"],
        completedAt,
        i.environmentId,
        row["head_version"],
      ),
  ]);
  return "completed";
}
