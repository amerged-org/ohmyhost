import { z } from "zod";
import { parseFrameworkConversionDiagnostic } from "@ohmyhost/contracts/framework-admission";
import { generatedJsonb } from "../../jsonb-generated.js";
import { guard } from "../../guards.js";
import { runCommand, type Plan } from "../../run-command.js";
import { conflict, instant, routeOrganization, ulid, type CatalogContext } from "../common.js";

/**
 * GitHub push auto-deploy on the Core: the targets of a push, the durable reservation of one deployment per delivery
 * and target, the later attachment of the accepted operation and the typed failure of a push that could not be planned.
 * The operation itself is accepted by the product capability (idempotent by delivery and project), so no financial
 * decision is repeated here; these commands keep only the push ledger and the failed-planning operation exact.
 */
const numeric = z.string().regex(/^[1-9][0-9]*$/u);
const branchRef = z
  .string()
  .max(1035)
  .startsWith("refs/heads/")
  .refine((value) => {
    const name = value.slice("refs/heads/".length);
    return !(
      name.length < 1 ||
      name.startsWith("-") ||
      name.startsWith("/") ||
      name.endsWith("/") ||
      name.endsWith(".") ||
      name.includes("//") ||
      name.includes("..") ||
      name.includes("@{") ||
      [...name].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x20 || code === 0x7f || "\\~^:?*[]".includes(character);
      }) ||
      name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
    );
  });
const commitSha = z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u);
const fullName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u);

const targetsInput = z.strictObject({
  installationId: numeric,
  repositoryId: numeric,
  repositoryFullName: fullName,
});
interface TargetRow {
  organization_id: string;
  project_id: string;
  source_connection_id: string;
  generation: number;
  branch_ref: string;
  github_installation_id: string;
  external_repository_id: string;
  grant_active: number;
  repository_renamed: number;
}
/**
 * The enabled configurations that watch this repository, with whether the repository grant is still live. A repository is
 * matched by its installation and repository id, which GitHub keeps across a rename; `repositoryRenamed` is set when the
 * stored owner and name no longer name it (CORE-44).
 */
export async function readGithubAutoDeployTargets(context: CatalogContext, raw: unknown) {
  const input = targetsInput.parse(raw);
  await context.router.assertLayout();
  const { db } = await context.router.routeShard(0),
    [owner, repository] = input.repositoryFullName.split("/") as [string, string],
    rows = await db
      .prepare(
        `SELECT config.organization_id,config.project_id,config.source_connection_id,config.generation,config.branch_ref,
                grant_record.github_installation_id,grant_record.external_repository_id,
                NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id) grant_active,
                NOT (lower(grant_record.repository_owner)=lower(?3) AND lower(grant_record.repository_name)=lower(?4)) repository_renamed
         FROM github_auto_deploy_configs config
         JOIN repository_grants grant_record ON grant_record.organization_id=config.organization_id AND grant_record.project_id=config.project_id AND grant_record.source_connection_id=config.source_connection_id
         JOIN project_source_bindings binding ON binding.organization_id=config.organization_id AND binding.project_id=config.project_id AND binding.provider='github' AND binding.source_connection_id=config.source_connection_id
         JOIN projects project ON project.organization_id=config.organization_id AND project.project_id=config.project_id AND project.owner_state='active'
         WHERE config.enabled=1 AND grant_record.github_installation_id=?1 AND grant_record.external_repository_id=?2
         ORDER BY config.organization_id,config.project_id`,
      )
      .bind(input.installationId, input.repositoryId, owner, repository)
      .all<TargetRow>();
  return rows.results.map((row) => ({
    organizationId: row.organization_id,
    projectId: row.project_id,
    sourceConnectionId: row.source_connection_id,
    configGeneration: row.generation,
    branchRef: row.branch_ref,
    installationId: row.github_installation_id,
    repositoryId: row.external_repository_id,
    grantActive: row.grant_active === 1,
    repositoryRenamed: row.repository_renamed === 1,
  }));
}

const push = z.strictObject({
  inboxEventId: ulid,
  deliveryGuid: z.string().length(36),
  installationId: numeric,
  repositoryId: numeric,
  ref: branchRef,
  commitSha,
  claimedAt: instant,
  organizationId: ulid,
  projectId: ulid,
  sourceConnectionId: ulid,
  configGeneration: z.number().int().min(1).max(2147483647),
  branchRef,
  pushDeploymentId: ulid,
});
interface ConfigRow {
  generation: number;
  enabled: number;
  github_installation_id: string;
  external_repository_id: string;
  grant_active: number;
}
interface ExistingRow {
  push_deployment_id: string;
  operation_id: string | null;
  source_connection_id: string;
  config_generation: number;
  commit_sha: string;
  github_installation_id: string;
  external_repository_id: string;
  branch_ref: string;
  attached: number;
}
export type PushReservation = {
  readonly pushDeploymentId: string;
  readonly outcome: "reserved" | "replay";
  readonly operationId: string | null;
  readonly workflowAttached: boolean;
};

/**
 * Reserves the one push deployment of a delivery and target. A repeated delivery answers the stored reservation; a new
 * delivery of a commit already pushed (a reset back to it) reserves a push of its own, and an older push still queued or
 * running is marked superseded.
 */
export async function reserveGithubPushDeployment(context: CatalogContext, raw: unknown) {
  const i = push.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    scope = [i.organizationId, i.projectId];
  return runCommand(db, {
    name: "github.reservePushDeployment",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["github_push_deployments"],
    read: async (reader) => ({
      config: await reader
        .prepare(
          `SELECT config.generation,config.enabled,grant_record.github_installation_id,grant_record.external_repository_id,
                  NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id) grant_active
           FROM github_auto_deploy_configs config
           JOIN repository_grants grant_record ON grant_record.organization_id=config.organization_id AND grant_record.project_id=config.project_id AND grant_record.source_connection_id=config.source_connection_id
           JOIN projects project ON project.organization_id=config.organization_id AND project.project_id=config.project_id AND project.owner_state='active'
           WHERE config.organization_id=?1 AND config.project_id=?2 AND config.source_connection_id=?3`,
        )
        .bind(...scope, i.sourceConnectionId)
        .first<ConfigRow>(),
      existing: await reader
        .prepare(
          `SELECT push.push_deployment_id,push.operation_id,push.source_connection_id,push.config_generation,push.commit_sha,
                  push.github_installation_id,push.external_repository_id,push.branch_ref,
                  EXISTS(SELECT 1 FROM product_command_intents intent WHERE intent.organization_id=push.organization_id AND intent.project_id=push.project_id
                    AND intent.operation_id=push.operation_id AND intent.event_type='DeploymentRequestedV1') attached
           FROM github_push_deployments push
           WHERE push.organization_id=?1 AND push.project_id=?2 AND push.delivery_guid=?3
           ORDER BY push.sequence DESC LIMIT 1`,
        )
        .bind(...scope, i.deliveryGuid)
        .first<ExistingRow>(),
      latest:
        (
          await reader
            .prepare(
              "SELECT COALESCE(max(sequence),0) latest FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2",
            )
            .bind(...scope)
            .first<{ latest: number }>()
        )?.latest ?? 0,
    }),
    decide: ({ config, existing, latest }): Plan<PushReservation> => {
      if (
        config === null ||
        config.generation !== i.configGeneration ||
        config.github_installation_id !== i.installationId ||
        config.external_repository_id !== i.repositoryId ||
        i.ref !== i.branchRef
      )
        throw conflict("github_auto_deploy_config_stale");
      if (config.enabled !== 1) throw conflict("GITHUB_AUTO_DEPLOY_DISABLED");
      if (config.grant_active !== 1) throw conflict("GITHUB_AUTO_DEPLOY_GRANT_REVOKED");
      if (
        existing !== null &&
        (existing.source_connection_id !== i.sourceConnectionId ||
          existing.config_generation !== i.configGeneration ||
          existing.commit_sha !== i.commitSha ||
          existing.github_installation_id !== i.installationId ||
          existing.external_repository_id !== i.repositoryId ||
          existing.branch_ref !== i.ref)
      )
        throw conflict("github_push_replay_conflict");
      if (existing !== null)
        return {
          replay: {
            pushDeploymentId: existing.push_deployment_id,
            outcome: "replay",
            operationId: existing.operation_id,
            workflowAttached: existing.attached === 1,
          },
        };
      const sequence = latest + 1;
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "(SELECT COALESCE(max(sequence),0) FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2)<>?3",
            [...scope, latest],
          ),
          db
            .prepare(
              "INSERT INTO github_push_deployments(push_deployment_id,inbox_event_id,organization_id,project_id,source_connection_id,config_generation,delivery_guid,github_installation_id,external_repository_id,branch_ref,commit_sha,sequence,operation_id,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,'reserved',?13,?13)",
            )
            .bind(
              i.pushDeploymentId,
              i.inboxEventId,
              i.organizationId,
              i.projectId,
              i.sourceConnectionId,
              i.configGeneration,
              i.deliveryGuid,
              i.installationId,
              i.repositoryId,
              i.ref,
              i.commitSha,
              sequence,
              i.claimedAt,
            ),
          db
            .prepare(
              "UPDATE github_push_deployments SET state='cleanup_pending',superseded_by_id=?3,cleanup_required=1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND push_deployment_id<>?3 AND state IN('queued','running') AND sequence<?5",
            )
            .bind(...scope, i.pushDeploymentId, i.claimedAt, sequence),
        ],
        result: () => ({
          pushDeploymentId: i.pushDeploymentId,
          outcome: "reserved",
          operationId: null,
          workflowAttached: false,
        }),
      };
    },
  });
}

const attachInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  pushDeploymentId: ulid,
  operationId: ulid,
  now: instant,
});
/**
 * Binds the accepted deployment operation to its reserved push. A push another delivery already overtook is marked
 * for cleanup in the same step, exactly like an older queued push; a repeated call changes nothing.
 */
export async function attachGithubPushOperation(context: CatalogContext, raw: unknown) {
  const i = attachInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "github.attachPushOperation",
    input: i,
    retryOn: ["precondition_changed"],
    read: async (reader) => ({
      current: await reader
        .prepare(
          "SELECT state,operation_id,sequence FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2 AND push_deployment_id=?3",
        )
        .bind(i.organizationId, i.projectId, i.pushDeploymentId)
        .first<{ state: string; operation_id: string | null; sequence: number }>(),
      newest: await reader
        .prepare(
          "SELECT push_deployment_id,sequence FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2 ORDER BY sequence DESC LIMIT 1",
        )
        .bind(i.organizationId, i.projectId)
        .first<{ push_deployment_id: string; sequence: number }>(),
    }),
    decide: ({ current, newest }): Plan<"attached" | "existing"> => {
      if (current === null) throw conflict("github_push_missing");
      if (current.state !== "reserved")
        return current.operation_id === i.operationId
          ? { replay: "existing" }
          : { reject: conflict("github_push_attachment_changed") };
      const overtaken = newest !== null && newest.sequence > current.sequence;
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "(SELECT state FROM github_push_deployments WHERE push_deployment_id=?1) IS NOT 'reserved'",
            [i.pushDeploymentId],
          ),
          overtaken
            ? db
                .prepare(
                  "UPDATE github_push_deployments SET operation_id=?4,state='cleanup_pending',superseded_by_id=?5,cleanup_required=1,updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND push_deployment_id=?3 AND state='reserved'",
                )
                .bind(
                  i.organizationId,
                  i.projectId,
                  i.pushDeploymentId,
                  i.operationId,
                  newest.push_deployment_id,
                  i.now,
                )
            : db
                .prepare(
                  "UPDATE github_push_deployments SET operation_id=?4,state='queued',updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND push_deployment_id=?3 AND state='reserved'",
                )
                .bind(i.organizationId, i.projectId, i.pushDeploymentId, i.operationId, i.now),
        ],
        result: () => "attached",
      };
    },
  });
}

const PUBLIC_PLANNING_FAILURE_CODES = new Set([
  "PAID_PLAN_REQUIRED",
  "INSUFFICIENT_ORGANIZATION_CREDITS",
  "PROJECT_BUDGET_EXCEEDED",
]);
const failInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  pushDeploymentId: ulid,
  operationId: ulid,
  billingEpochId: ulid,
  auditEventId: ulid,
  queuedOperationEventId: ulid,
  startedOperationEventId: ulid,
  operationEventId: ulid,
  failedAt: instant,
  errorCode: z.enum([
    "WORKERS_RUNTIME_INCOMPATIBLE",
    "FRAMEWORK_CONVERSION_REQUIRED",
    "MIGRATION_FILENAME_NONCANONICAL",
    "MAIL_DOMAIN_REQUIRED",
    "PAID_PLAN_REQUIRED",
    "INSUFFICIENT_ORGANIZATION_CREDITS",
    "PROJECT_BUDGET_EXCEEDED",
    "SOURCE_ADMISSION_REJECTED",
    "REPOSITORY_RENAMED",
  ]),
  diagnostic: z.unknown().nullable(),
});
/**
 * Ends a push whose commit could not be planned: the operation that never ran is recorded as started and failed with
 * the public planning code, and the push becomes `failed`. A push already overtaken or finished changes nothing.
 */
export async function failGithubPushPlanning(context: CatalogContext, raw: unknown) {
  const i = failInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    diagnostic = i.diagnostic === null ? null : parseFrameworkConversionDiagnostic(i.diagnostic);
  if (i.diagnostic !== null && diagnostic === null)
    throw new TypeError("GitHub push planning diagnostic is invalid");
  const failure = {
    // A repository renamed on GitHub since it was linked has its own public code, so the customer can re-link it (CORE-44).
    code:
      i.errorCode === "REPOSITORY_RENAMED"
        ? "AUTO_DEPLOY_REPOSITORY_RENAMED"
        : PUBLIC_PLANNING_FAILURE_CODES.has(i.errorCode)
          ? i.errorCode
          : "AUTO_DEPLOY_PLAN_REJECTED",
    message: "The pushed commit could not be planned.",
    ...(diagnostic === null ? {} : { diagnostic }),
  };
  const key = `github-push:${i.pushDeploymentId}`;
  return runCommand(db, {
    name: "github.failPushPlanning",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["operations"],
    read: async (reader) => ({
      current: await reader
        .prepare(
          "SELECT state,operation_id,sequence FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2 AND push_deployment_id=?3",
        )
        .bind(i.organizationId, i.projectId, i.pushDeploymentId)
        .first<{ state: string; operation_id: string | null; sequence: number }>(),
      newer:
        (
          await reader
            .prepare(
              "SELECT count(*) n FROM github_push_deployments WHERE organization_id=?1 AND project_id=?2 AND sequence>(SELECT sequence FROM github_push_deployments WHERE push_deployment_id=?3)",
            )
            .bind(i.organizationId, i.projectId, i.pushDeploymentId)
            .first<{ n: number }>()
        )?.n ?? 0,
    }),
    decide: ({ current, newer }): Plan<"failed" | "superseded" | "existing"> => {
      if (current === null) throw conflict("github_push_missing");
      if (current.state === "cleanup_pending") return { replay: "superseded" };
      if (current.state !== "reserved") return { replay: "existing" };
      // Overtaken while it was being planned: the newer push owns the project, nothing is recorded for this one.
      if (newer > 0) return { replay: "superseded" };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "(SELECT state FROM github_push_deployments WHERE push_deployment_id=?1) IS NOT 'reserved'",
            [i.pushDeploymentId],
          ),
          db
            .prepare(
              "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?5,?5)",
            )
            .bind(i.organizationId, i.operationId, i.projectId, i.billingEpochId, i.failedAt),
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at) VALUES(?1,?2,?3,?4,0,'OperationQueued','{}',?5)",
            )
            .bind(
              i.organizationId,
              i.queuedOperationEventId,
              i.operationId,
              i.projectId,
              i.failedAt,
            ),
          db
            .prepare(
              "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'GithubPushDeploymentQueuedV1','system','github-push','{}',?5,?6)",
            )
            .bind(
              i.organizationId,
              i.auditEventId,
              i.projectId,
              i.operationId,
              i.failedAt,
              i.billingEpochId,
            ),
          db
            .prepare(
              "UPDATE operations SET state='failed',failure=?4,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='queued'",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.operationId,
              generatedJsonb(failure),
              i.failedAt,
            ),
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6),(?1,?7,?3,?4,2,'OperationFailed',?8,?9,?6)",
            )
            .bind(
              i.organizationId,
              i.startedOperationEventId,
              i.operationId,
              i.projectId,
              `${key}:start`,
              i.failedAt,
              i.operationEventId,
              `${key}:failed`,
              generatedJsonb({ failure: { code: failure.code, message: failure.message } }),
            ),
          db
            .prepare(
              "UPDATE github_push_deployments SET operation_id=?4,state='failed',updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND push_deployment_id=?3 AND state='reserved'",
            )
            .bind(i.organizationId, i.projectId, i.pushDeploymentId, i.operationId, i.failedAt),
        ],
        result: () => "failed",
      };
    },
  });
}
