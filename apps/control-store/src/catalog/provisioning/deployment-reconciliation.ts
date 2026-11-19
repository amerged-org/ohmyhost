import { generatedJsonb } from "../../jsonb-generated.js";
import { z } from "zod";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  instant,
  fenceRaceGuard,
  type CatalogContext,
} from "../common.js";
import { diagnosticInput, diagnosticStatements } from "./diagnostics.js";
import { ProductWorkflowContextConflictError } from "./context.js";
const policy = z.strictObject({
  healthCheckPath: z
    .string()
    .min(1)
    .max(256)
    .regex(/^\/(?!\/)[^?#\\]*$/u)
    .refine((v) => !v.split("/").some((s) => s === "." || s === "..")),
  egressAllowedOrigins: z
    .array(
      z.string().refine((v) => {
        try {
          const u = new URL(v);
          return (
            u.protocol === "https:" &&
            u.origin === v &&
            u.username === "" &&
            u.password === "" &&
            u.pathname === "/" &&
            u.search === "" &&
            u.hash === ""
          );
        } catch {
          return false;
        }
      }),
    )
    .max(32)
    .refine((v) => v.every((s, n) => n === 0 || s > (v[n - 1] ?? ""))),
  browser: z.unknown().transform(parseBrowserPolicy).optional(),
});
const hint = z
  .strictObject({
    phase: z.enum(["source", "build", "database", "runtime-secrets", "storage", "gateway", "wfp"]),
    expectedArtifactDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    currentProviderTag: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => v.trim() === v)
      .nullable()
      .optional(),
    currentProductDeploymentId: ulid.optional(),
    activationRuntimePolicy: policy.optional(),
  })
  .refine(
    (v) => v.activationRuntimePolicy === undefined || v.phase === "gateway" || v.phase === "wfp",
  );
const input = z
  .strictObject({
    workflowId: z.string().min(1).max(255),
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    operationId: ulid,
    outboxEventId: ulid,
    auditEventId: ulid,
    reconciliationAttemptId: ulid.optional(),
    replayAttemptId: ulid.optional(),
    reconciledAt: instant,
    providerReconciliation: z
      .strictObject({
        observationId: ulid,
        evidenceDigest: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
        hint,
      })
      .optional(),
    bindingsOutdated: z.boolean(),
    diagnosticId: ulid.optional(),
  })
  .refine((v) => v.reconciliationAttemptId === undefined || v.replayAttemptId === undefined);
const SCOPE = `SELECT run.*,intent.event_type intent_type,intent.deployment_id,intent.cleanup_run_id FROM product_workflow_runs run JOIN product_command_intents intent ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type WHERE run.workflow_id=?1 AND run.event_id=?2 AND run.organization_id=?3 AND run.project_id=?4 AND run.environment_id=?5 AND run.operation_id=?6`;
type Row = Record<string, unknown>;
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical((v as Row)[k]))
          .join(",")}}`
      : JSON.stringify(v);
const hex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
/** Original uncertain outcome, immutable observation, cleanup/deployment state, run and optional diagnostic are ONE batch. */
export async function reconcileProductWorkflow(
  context: CatalogContext,
  raw: unknown,
): Promise<"reconciliation_required" | "replayed"> {
  return reconcileProductWorkflowOutcome(context, raw, {
    actorId: "deployment-workflow",
    errorCode: "PROVIDER_OBSERVATION_UNCERTAIN",
  });
}

/** Server-local shared native group. The caller fixes its actor/code; neither is a generic public RPC. */
export async function reconcileProductWorkflowOutcome(
  context: CatalogContext,
  raw: unknown,
  authority: { readonly actorId: string; readonly errorCode: string },
): Promise<"reconciliation_required" | "replayed"> {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    args = [
      i.workflowId,
      i.outboxEventId,
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
    ],
    p = i.providerReconciliation,
    intermediate = p === undefined ? null : generatedJsonb({ providerReconciliationHint: p.hint }),
    fail = (m: string) => new ProductWorkflowContextConflictError(m);
  const replay = (r: Row | null) =>
    r?.["state"] === "reconciliation_required" &&
    r["active_reconciliation_attempt_id"] === null &&
    r["active_replay_attempt_id"] === null &&
    (p === undefined ||
      (typeof r["intermediate_evidence"] === "string" &&
        canonical(JSON.parse(r["intermediate_evidence"])) ===
          canonical(p === undefined ? null : { providerReconciliationHint: p.hint })));
  const command: Command<Row | null, "reconciliation_required" | "replayed"> = {
    name: "provisioning.reconcileWorkflow",
    input: i,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["product_provider_mutation_observations", "audit_events"],
    read: (r) =>
      r
        .prepare(SCOPE)
        .bind(...args)
        .first<Row>(),
    decide: (r) => {
      if (!r) return { reject: fail("Product Workflow state changed") };
      if (replay(r)) return { replay: "replayed" };
      if (
        r["state"] !== "queued" ||
        r["active_reconciliation_attempt_id"] !== (i.reconciliationAttemptId ?? null) ||
        (i.replayAttemptId !== undefined && r["active_replay_attempt_id"] !== i.replayAttemptId)
      )
        return { reject: fail("Product Workflow attempt is still active") };
      const providerMutation = [
        "DeploymentRequestedV1",
        "DeploymentRollbackRequestedV1",
        "DeploymentPromotionRequestedV1",
      ].includes(String(r["intent_type"]));
      if (providerMutation !== (p !== undefined))
        throw new TypeError(
          providerMutation
            ? "Provider reconciliation evidence is required"
            : "Provider reconciliation evidence is not allowed for this command",
        );
      if (
        i.bindingsOutdated &&
        (!providerMutation || r["deployment_id"] === null || i.diagnosticId === undefined)
      )
        throw new TypeError("Provider reconciliation reason is invalid");
      const replayId = i.replayAttemptId ?? r["active_replay_attempt_id"];
      const statements = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM(${SCOPE}) WHERE state='queued' AND active_reconciliation_attempt_id IS ?7 AND active_replay_attempt_id IS ?8)`,
          [...args, i.reconciliationAttemptId ?? null, replayId],
        ),
      ];
      if (p) {
        const h = p.hint,
          artifact = h.expectedArtifactDigest?.slice(7) ?? null;
        statements.push(
          db
            .prepare(
              "INSERT INTO product_provider_mutation_observations(observation_id,claim_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,event_type,accepted_lifecycle_version,observation_kind,attempt_number,evidence_sha256,hint_phase,expected_artifact_sha256,hint_provider_tag,hint_product_deployment_id,source_state,build_state,gateway_state,gateway_provider_tag,wfp_state,wfp_provider_tag,wfp_product_deployment_id,wfp_artifact_sha256,actor_id,created_at) SELECT ?1,claim.claim_id,claim.organization_id,claim.project_id,claim.environment_id,claim.operation_id,claim.event_id,claim.billing_epoch_id,claim.logical_workflow_id,claim.event_type,claim.accepted_lifecycle_version,'uncertainty',(SELECT count(*) FROM product_provider_reconciliation_attempts attempt WHERE attempt.claim_id=claim.claim_id),unhex(?2),?3,unhex(?4),?5,?6,'unknown','unknown','unknown',NULL,'unknown',?5,?6,unhex(?4),?14,?7 FROM product_provider_mutation_claims claim WHERE claim.organization_id=?8 AND claim.project_id=?9 AND claim.environment_id=?10 AND claim.operation_id=?11 AND claim.event_id=?12 AND claim.logical_workflow_id=?13",
            )
            .bind(
              p.observationId,
              hex(p.evidenceDigest),
              h.phase,
              artifact,
              h.currentProviderTag ?? null,
              h.currentProductDeploymentId ?? null,
              i.reconciledAt,
              i.organizationId,
              i.projectId,
              i.environmentId,
              i.operationId,
              i.outboxEventId,
              i.workflowId,
              authority.actorId,
            ),
        );
      }
      if (r["deployment_id"] !== null)
        statements.push(
          db
            .prepare(
              "UPDATE deployments SET status='reconciliation_required',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3",
            )
            .bind(i.organizationId, i.projectId, r["deployment_id"], i.reconciledAt),
        );
      if (r["cleanup_run_id"] !== null)
        statements.push(
          db
            .prepare(
              "UPDATE cleanup_runs SET state='reconciliation_required',revision=revision+1,reconciliation_code=?6,updated_at=?5,completed_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND cleanup_run_id=?4",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.operationId,
              r["cleanup_run_id"],
              i.reconciledAt,
              authority.errorCode,
            ),
        );
      statements.push(
        db
          .prepare(
            "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code=?2,active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,intermediate_evidence=?4,updated_at=?3 WHERE workflow_id=?1 AND state='queued' AND active_reconciliation_attempt_id IS ?5 AND active_replay_attempt_id IS ?6",
          )
          .bind(
            i.workflowId,
            authority.errorCode,
            i.reconciledAt,
            intermediate,
            i.reconciliationAttemptId ?? null,
            replayId,
          ),
        guard(db, "operation_conflict", "changes()<>1"),
        db
          .prepare(
            "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProductWorkflowReconciliationRequired','system',?8,?5,?6,?7)",
          )
          .bind(
            i.organizationId,
            i.auditEventId,
            i.projectId,
            i.operationId,
            generatedJsonb({
              errorCode: authority.errorCode,
              workflowId: i.workflowId,
              ...(i.replayAttemptId === undefined ? {} : { replayAttemptId: i.replayAttemptId }),
            }),
            i.reconciledAt,
            r["billing_epoch_id"],
            authority.actorId,
          ),
      );
      if (i.bindingsOutdated)
        statements.push(
          ...diagnosticStatements(
            db,
            diagnosticInput.parse({
              id: i.diagnosticId,
              organizationId: i.organizationId,
              projectId: i.projectId,
              environmentId: i.environmentId,
              deploymentId: r["deployment_id"],
              source: "control",
              code: "WFP_CANDIDATE_OUTDATED",
              catalogMessage: "FINISH_CANDIDATE_RECONCILIATION_THEN_REDEPLOY_CURRENT_SOURCE",
              exceptionClass: null,
              sourceFile: null,
              sourceLine: null,
              sourceColumn: null,
              routeTemplate: null,
              requestId: null,
              traceId: null,
              durationMs: null,
              excerpt: null,
              excerptTruncated: null,
              occurredAt: i.reconciledAt,
              recordedAt: i.reconciledAt,
            }),
          ),
        );
      return { statements, result: () => "reconciliation_required" };
    },
    lookup: async (reader) =>
      replay(
        await reader
          .prepare(SCOPE)
          .bind(...args)
          .first<Row>(),
      )
        ? "replayed"
        : undefined,
  };
  return runCommand(db, command);
}
