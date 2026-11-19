import { createHash } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { generatedJsonb } from "../../jsonb-generated.js";
import { publicTimestamp } from "../common.js";
import { recoveryCaptureHeldGuard } from "../recovery/fence.js";
import {
  deletionInventoryStatements,
  lifecycleEncodedUlid,
  type DeletionInventoryPlan,
} from "../provisioning/lifecycle-inventory.js";
import {
  dataChangeAcceptanceStatements,
  dataChangeInventoryStatements,
  type DataChangeInventoryPlan,
} from "../provisioning/project-data-change.js";
import { apiRollbackGuardStatements, type ApiRollbackSnapshot } from "./rollback-target.js";
import type { ApiProductAcceptance } from "./accept-product-input.js";

type Row = Record<string, unknown>;
export const UNFINISHED_DATA_SQL = `EXISTS(SELECT 1 FROM project_database_writes WHERE project_id=?1 AND completed_at IS NULL)`;
export const UNFINISHED_COMPUTE_SQL = `EXISTS(SELECT 1 FROM project_database_compute_changes WHERE project_id=?1 AND completed_at IS NULL UNION ALL SELECT 1 FROM pgcf_database_compute_changes WHERE project_id=?1 AND completed_at IS NULL UNION ALL SELECT 1 FROM pgcf_database_entitlement_actions WHERE project_id=?1 AND state IN('reserved','dispatched','pending') UNION ALL SELECT 1 FROM database_provider_cutover_authorizations a WHERE a.project_id=?1 AND NOT EXISTS(SELECT 1 FROM database_provider_cutover_releases r WHERE r.operation_id=a.operation_id))`;
export const PROMOTION_ACCEPT_SQL = `SELECT 1 FROM environments source JOIN environments target ON target.organization_id=source.organization_id AND target.project_id=source.project_id AND target.environment_id=?3 AND target.name='prod' AND target.head_version=?10
 JOIN deployments deployment ON deployment.organization_id=source.organization_id AND deployment.project_id=source.project_id AND deployment.environment_id=source.environment_id AND deployment.deployment_id=?5 AND deployment.status='succeeded' AND deployment.active_revision_id=?6
 JOIN deployment_revisions revision ON revision.organization_id=source.organization_id AND revision.project_id=source.project_id AND revision.deployment_id=?5 AND revision.revision_id=?6 AND revision.artifact_id=?7
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id AND artifact.artifact_sha256=?8
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.environment_id=source.environment_id AND receipt.artifact_id=revision.artifact_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 WHERE source.organization_id=?1 AND source.project_id=?2 AND source.environment_id=?4 AND source.name='dev' AND source.active_deployment_id=?5 AND source.active_revision_id=?6 AND source.head_version=?9`;
/**
 * An open operation of one event type for an environment. A rollback and a promotion of the same
 * environment must never both be open: the later one would revert or overwrite the release the other
 * activates, because the rollback carries no head.
 */
const OPEN_EVENT_SQL = `SELECT 1 FROM product_command_intents pi JOIN operations o ON o.organization_id=pi.organization_id
  AND o.project_id=pi.project_id AND o.operation_id=pi.operation_id
  WHERE pi.organization_id=?1 AND pi.project_id=?2 AND pi.environment_id=?3 AND pi.event_type=?4 AND o.state IN ('queued','running')`;
export function promotionAcceptParameters(p: ApiProductAcceptance) {
  const i = p.input;
  if (i.eventType !== "DeploymentPromotionRequestedV1") return [];
  return [
    i.organizationId,
    i.projectId,
    i.environmentId,
    i.sourceEnvironmentId,
    i.sourceDeploymentId,
    i.sourceRevisionId,
    i.sourceArtifactId,
    i.sourceArtifactDigest,
    i.expectedSourceHeadVersion,
    i.expectedHeadVersion,
  ];
}
export interface AcceptanceEffects {
  readonly confirmedSourceGeneration: number | null;
  readonly plan: Row | null;
  readonly rollback: ApiRollbackSnapshot | null;
  readonly deletion: DeletionInventoryPlan | null;
  readonly dataChange: DataChangeInventoryPlan | null;
  readonly previousOperationId: string | null;
  readonly previousAbsences: readonly Row[];
}
function insert(db: D1Database, table: string, row: Row) {
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(row));
}
function digestId(operationId: string, value: string) {
  const input = createHash("sha256").update(value).digest();
  const digest = new Uint8Array(
    createHash("sha256").update(operationId).update(input).digest().subarray(0, 16),
  );
  digest[0] = (digest[0] ?? 0) & 127;
  return lifecycleEncodedUlid(digest);
}
/** The original seven intent/effect groups; only fixed server-local plans enter this compound. */
export function productAcceptanceStatements(
  db: D1Database,
  p: ApiProductAcceptance,
  s: AcceptanceEffects,
): D1PreparedStatement[] {
  const i = p.input,
    at = p.at,
    scope = {
      organization_id: i.organizationId,
      project_id: i.projectId,
      environment_id: i.environmentId,
      operation_id: i.operationId,
      billing_epoch_id: i.billingEpochId,
      event_type: i.eventType,
    };
  const intent = (extra: Row) =>
    insert(db, "product_command_intents", { ...scope, ...extra, created_at: at });
  const deployment = (kind: string, extra: Row = {}) =>
    insert(db, "deployments", {
      deployment_id: Reflect.get(i, "deploymentId"),
      organization_id: i.organizationId,
      project_id: i.projectId,
      operation_id: i.operationId,
      environment_id: i.environmentId,
      kind,
      status: "queued",
      ...extra,
      created_at: at,
      updated_at: at,
    });
  const cleanup = () =>
    insert(db, "cleanup_runs", {
      cleanup_run_id: Reflect.get(i, "cleanupRunId"),
      organization_id: i.organizationId,
      project_id: i.projectId,
      operation_id: i.operationId,
      state: "pending",
      revision: 1,
      created_at: at,
      updated_at: at,
    });
  switch (i.eventType) {
    case "SourceLinkRequestedV1":
      return [
        intent({
          installation_id: i.installationId,
          repository_owner: i.repositoryOwner,
          repository_name: i.repositoryName,
        }),
      ];
    case "DeploymentRequestedV1": {
      if (!s.plan) throw new Error("deployment_persistence_conflict");
      return [
        deployment("deploy"),
        intent({
          plan_id: i.planId,
          source_connection_id: s.plan["source_connection_id"],
          source_generation: s.plan["source_generation"],
          deployment_id: i.deploymentId,
        }),
      ];
    }
    case "DeploymentRollbackRequestedV1": {
      if (!s.rollback) throw new Error("rollback_target_data_changed");
      if (s.confirmedSourceGeneration === null) throw new Error("deployment_persistence_conflict");
      return [
        ...apiRollbackGuardStatements(db, s.rollback),
        guard(db, "precondition_changed", `EXISTS(${OPEN_EVENT_SQL})`, [
          i.organizationId,
          i.projectId,
          i.environmentId,
          "DeploymentPromotionRequestedV1",
        ]),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM deployment_revisions r JOIN environments e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.environment_id=?3 AND e.head_version=?7 WHERE r.organization_id=?1 AND r.project_id=?2 AND r.deployment_id=?4 AND r.revision_id=?5 AND r.artifact_id=?6)",
          [
            i.organizationId,
            i.projectId,
            i.environmentId,
            i.targetDeploymentId,
            i.targetRevisionId,
            i.targetArtifactId,
            i.expectedHeadVersion,
          ],
        ),
        deployment("rollback", {
          rollback_target_deployment_id: i.targetDeploymentId,
          rollback_target_revision_id: i.targetRevisionId,
        }),
        intent({
          deployment_id: i.deploymentId,
          target_deployment_id: i.targetDeploymentId,
          target_revision_id: i.targetRevisionId,
          target_artifact_id: i.targetArtifactId,
          source_generation: s.confirmedSourceGeneration,
          expected_etag: i.expectedEtag,
        }),
      ];
    }
    case "DeploymentPromotionRequestedV1":
      if (s.confirmedSourceGeneration === null) throw new Error("deployment_persistence_conflict");
      return [
        guard(db, "precondition_changed", `EXISTS(${OPEN_EVENT_SQL})`, [
          i.organizationId,
          i.projectId,
          i.environmentId,
          "DeploymentRollbackRequestedV1",
        ]),
        guard(
          db,
          "precondition_changed",
          `NOT EXISTS(${PROMOTION_ACCEPT_SQL})`,
          promotionAcceptParameters(p),
        ),
        deployment("promotion", {
          promotion_source_environment_id: i.sourceEnvironmentId,
          promotion_source_deployment_id: i.sourceDeploymentId,
          promotion_source_revision_id: i.sourceRevisionId,
        }),
        intent({
          deployment_id: i.deploymentId,
          source_environment_id: i.sourceEnvironmentId,
          source_deployment_id: i.sourceDeploymentId,
          source_revision_id: i.sourceRevisionId,
          source_artifact_id: i.sourceArtifactId,
          source_artifact_sha256: i.sourceArtifactDigest,
          expected_source_head_version: i.expectedSourceHeadVersion,
          expected_target_head_version: i.expectedHeadVersion,
          source_generation: s.confirmedSourceGeneration,
          expected_etag: i.expectedEtag,
        }),
      ];
    case "ProjectHandleChangeRequestedV1":
      return [
        guard(
          db,
          "precondition_changed",
          "EXISTS(SELECT 1 FROM projects WHERE owner_state<>'transferred' AND handle=?1 AND project_id<>?2)",
          [i.requestedHandle, i.projectId],
        ),
        intent({ expected_etag: i.expectedEtag, requested_handle: i.requestedHandle }),
      ];
    case "ProjectDataChangeRequestedV1": {
      if (!p.snapshot || !s.dataChange) throw new Error("deployment_persistence_conflict");
      const statements = [
        guard(
          db,
          "precondition_changed",
          "EXISTS(SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND state='pending')",
          [i.organizationId, i.projectId],
        ),
        recoveryCaptureHeldGuard(db, i, at),
        guard(
          db,
          "precondition_changed",
          `(${UNFINISHED_DATA_SQL}) OR(${UNFINISHED_COMPUTE_SQL})`,
          [i.projectId],
        ),
        ...dataChangeAcceptanceStatements(db, { ...i, snapshot: p.snapshot }),
        cleanup(),
        intent({
          expected_etag: i.expectedEtag,
          cleanup_run_id: i.cleanupRunId,
          data_change: i.dataChange,
          data_change_snapshot: generatedJsonb(p.snapshot),
        }),
        ...dataChangeInventoryStatements(db, s.dataChange),
      ];
      if (p.snapshot.transition.removeDevDeployment) {
        const head = p.snapshot.environmentHeads.find((h) => h.environmentId === i.environmentId);
        statements.push(
          db
            .prepare(
              "UPDATE environments SET active_deployment_id=NULL,active_revision_id=NULL,head_version=head_version+1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='dev' AND head_version=?5",
            )
            .bind(i.organizationId, i.projectId, i.environmentId, at, head?.expectedHeadVersion),
          guard(db, "precondition_changed", "changes()<>1"),
          db
            .prepare(
              "DELETE FROM environment_function_schedules WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
            )
            .bind(i.organizationId, i.projectId, i.environmentId),
        );
      }
      return statements;
    }
    case "ProjectDeletionRequestedV1": {
      if (!s.deletion) throw new Error("deployment_persistence_conflict");
      const nativeDeletionKey = `omh-${createHash("sha256")
        .update(
          JSON.stringify([
            i.organizationId,
            i.projectId,
            i.operationId,
            "native-auth-database.delete",
          ]),
        )
        .digest("hex")}`;
      const statements = [
        recoveryCaptureHeldGuard(db, i, at),
        guard(
          db,
          "precondition_changed",
          `(${UNFINISHED_DATA_SQL}) OR(${UNFINISHED_COMPUTE_SQL})`,
          [i.projectId],
        ),
        // A dispatched create without its provider identity cannot be safely inventoried.
        guard(
          db,
          "precondition_changed",
          `EXISTS(SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND state='dispatched') OR EXISTS(SELECT 1 FROM native_auth_deletion_operations d JOIN operations op USING(organization_id,project_id,operation_id) WHERE d.organization_id=?1 AND d.project_id=?2 AND op.state IN('queued','running')) OR (EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.organization_id=?1 AND r.project_id=?2 AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms f JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN native_auth_database_targets t ON t.organization_id=d.organization_id AND t.project_id=d.project_id AND t.target_version=d.target_version WHERE f.organization_id=r.organization_id AND f.project_id=r.project_id AND f.environment_id=r.environment_id AND f.registry_version>=r.registry_version AND f.purged_at IS NOT NULL AND d.state='absent' AND t.ended_at IS NOT NULL)) AND NOT EXISTS(SELECT 1 FROM native_auth_database_targets WHERE organization_id=?1 AND project_id=?2 AND ended_at IS NULL)) OR EXISTS(SELECT 1 FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND (revocation_epoch>=2147483647 OR configuration_revision>=2147483647))`,
          [i.organizationId, i.projectId],
        ),
        db
          .prepare(
            `UPDATE native_auth_realms SET enabled=0,revocation_epoch=revocation_epoch+1,configuration_revision=configuration_revision+1 WHERE organization_id=?1 AND project_id=?2`,
          )
          .bind(i.organizationId, i.projectId),
        db
          .prepare(
            `UPDATE native_auth_providers SET ciphertext=NULL,nonce=NULL,value_sha256=NULL,key_version=NULL,enabled=0 WHERE organization_id=?1 AND project_id=?2 AND ciphertext IS NOT NULL AND NOT EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.organization_id=?1 AND t.project_id=?2 AND t.ended_at IS NULL)`,
          )
          .bind(i.organizationId, i.projectId),
        db
          .prepare(
            `INSERT INTO native_auth_deletion_operations(organization_id,project_id,operation_id,target_version,provider_project_id,database_id,idempotency_key,state) SELECT t.organization_id,t.project_id,?3,t.target_version,t.provider_project_id,t.database_id,COALESCE((SELECT d.idempotency_key FROM native_auth_deletion_operations d JOIN operations op USING(organization_id,project_id,operation_id) WHERE d.organization_id=t.organization_id AND d.project_id=t.project_id AND d.target_version=t.target_version AND d.provider_project_id=t.provider_project_id AND d.database_id=t.database_id AND op.state NOT IN('queued','running') ORDER BY op.created_at DESC,op.operation_id DESC LIMIT 1),?4),'reserved' FROM native_auth_database_targets t WHERE t.organization_id=?1 AND t.project_id=?2 AND t.ended_at IS NULL`,
          )
          .bind(i.organizationId, i.projectId, i.operationId, nativeDeletionKey),
        db
          .prepare(
            `INSERT INTO native_auth_deletion_realms(organization_id,project_id,operation_id,environment_id,registry_version,registry_reference,revocation_epoch) SELECT r.organization_id,r.project_id,?3,r.environment_id,r.registry_version,r.registry_reference,realm.revocation_epoch FROM native_auth_registrations r JOIN native_auth_realms realm USING(organization_id,project_id,environment_id) JOIN native_auth_deletion_operations d ON d.organization_id=r.organization_id AND d.project_id=r.project_id AND d.operation_id=?3 AND d.target_version=r.target_version AND d.database_id=r.database_id WHERE r.organization_id=?1 AND r.project_id=?2 AND r.registry_version=(SELECT max(r2.registry_version) FROM native_auth_registrations r2 WHERE r2.organization_id=r.organization_id AND r2.project_id=r.project_id AND r2.environment_id=r.environment_id)`,
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        guard(
          db,
          "precondition_changed",
          `EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.organization_id=?1 AND r.project_id=?2 AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms d WHERE d.organization_id=r.organization_id AND d.project_id=r.project_id AND d.operation_id=?3 AND d.environment_id=r.environment_id) AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms f JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN native_auth_database_targets t ON t.organization_id=d.organization_id AND t.project_id=d.project_id AND t.target_version=d.target_version WHERE f.organization_id=r.organization_id AND f.project_id=r.project_id AND f.environment_id=r.environment_id AND f.registry_version>=r.registry_version AND f.purged_at IS NOT NULL AND d.state='absent' AND t.ended_at IS NOT NULL))`,
          [i.organizationId, i.projectId, i.operationId],
        ),
        db
          .prepare(
            "UPDATE environments SET dev_access_epoch=dev_access_epoch+1 WHERE organization_id=?1 AND project_id=?2 AND name='dev'",
          )
          .bind(i.organizationId, i.projectId),
        guard(
          db,
          "precondition_changed",
          "changes()<>(SELECT count(*) FROM environments WHERE organization_id=?1 AND project_id=?2 AND name='dev')",
          [i.organizationId, i.projectId],
        ),
        db
          .prepare("DELETE FROM dev_access_tickets WHERE project_id=?1 AND organization_id=?2")
          .bind(i.projectId, i.organizationId),
        db.prepare("DELETE FROM dev_share_links WHERE project_id=?1").bind(i.projectId),
        db
          .prepare(
            "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state IN('active','deleting') AND lifecycle_version=?3 AND NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims c WHERE c.organization_id=?1 AND c.project_id=?2)",
          )
          .bind(i.organizationId, i.projectId, i.expectedProjectVersion),
        guard(db, "precondition_changed", "changes()<>1"),
        cleanup(),
        intent({ expected_etag: i.expectedEtag, cleanup_run_id: i.cleanupRunId }),
        ...deletionInventoryStatements(db, s.deletion),
        // A prior dispatched request already waited for the same realm fences while the project remained frozen.
        db
          .prepare(
            `UPDATE native_auth_deletion_realms SET quiesced_at=(SELECT old.quiesced_at FROM native_auth_deletion_realms old JOIN native_auth_deletion_operations prior USING(organization_id,project_id,operation_id) JOIN operations op USING(organization_id,project_id,operation_id) JOIN native_auth_deletion_operations current ON current.organization_id=old.organization_id AND current.project_id=old.project_id AND current.operation_id=?3 AND current.target_version=prior.target_version AND current.idempotency_key=prior.idempotency_key WHERE old.organization_id=?1 AND old.project_id=?2 AND old.environment_id=native_auth_deletion_realms.environment_id AND old.registry_version=native_auth_deletion_realms.registry_version AND old.operation_id<>?3 AND old.quiesced_at IS NOT NULL AND prior.state IN('dispatched','observed','absent') AND op.state NOT IN('queued','running') ORDER BY op.created_at DESC,op.operation_id DESC LIMIT 1) WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND EXISTS(SELECT 1 FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) JOIN native_auth_deletion_operations current ON current.organization_id=prior.organization_id AND current.project_id=prior.project_id AND current.operation_id=?3 AND current.target_version=prior.target_version AND current.idempotency_key=prior.idempotency_key WHERE prior.operation_id<>?3 AND prior.state IN('dispatched','observed','absent') AND op.state NOT IN('queued','running'))`,
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        guard(
          db,
          "precondition_changed",
          `EXISTS(SELECT 1 FROM native_auth_deletion_realms r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.operation_id=?3 AND r.quiesced_at IS NULL AND EXISTS(SELECT 1 FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) JOIN native_auth_deletion_operations current ON current.organization_id=prior.organization_id AND current.project_id=prior.project_id AND current.operation_id=?3 AND current.target_version=prior.target_version AND current.idempotency_key=prior.idempotency_key WHERE prior.operation_id<>?3 AND prior.state IN('dispatched','observed','absent') AND op.state NOT IN('queued','running')))`,
          [i.organizationId, i.projectId, i.operationId],
        ),
        db
          .prepare(
            `UPDATE native_auth_deletion_operations SET state='dispatched' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='reserved' AND EXISTS(SELECT 1 FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) WHERE prior.organization_id=?1 AND prior.project_id=?2 AND prior.operation_id<>?3 AND prior.target_version=native_auth_deletion_operations.target_version AND prior.idempotency_key=native_auth_deletion_operations.idempotency_key AND prior.state='absent' AND op.state NOT IN('queued','running'))`,
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        db
          .prepare(
            `UPDATE native_auth_deletion_operations SET state='absent',provider_operation_id=(SELECT prior.provider_operation_id FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) WHERE prior.organization_id=?1 AND prior.project_id=?2 AND prior.operation_id<>?3 AND prior.target_version=native_auth_deletion_operations.target_version AND prior.idempotency_key=native_auth_deletion_operations.idempotency_key AND prior.state='absent' AND op.state NOT IN('queued','running') ORDER BY op.created_at DESC,op.operation_id DESC LIMIT 1),absent_at=(SELECT prior.absent_at FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) WHERE prior.organization_id=?1 AND prior.project_id=?2 AND prior.operation_id<>?3 AND prior.target_version=native_auth_deletion_operations.target_version AND prior.idempotency_key=native_auth_deletion_operations.idempotency_key AND prior.state='absent' AND op.state NOT IN('queued','running') ORDER BY op.created_at DESC,op.operation_id DESC LIMIT 1) WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='dispatched' AND EXISTS(SELECT 1 FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) WHERE prior.organization_id=?1 AND prior.project_id=?2 AND prior.operation_id<>?3 AND prior.target_version=native_auth_deletion_operations.target_version AND prior.idempotency_key=native_auth_deletion_operations.idempotency_key AND prior.state='absent' AND op.state NOT IN('queued','running'))`,
          )
          .bind(i.organizationId, i.projectId, i.operationId),
      ];
      if (s.previousOperationId !== null) {
        const copied: Array<{
          sourceAttemptId: string;
          cleanupAttemptId: string;
          observedAt: string;
        }> = [];
        for (const r of s.previousAbsences) {
          const hash = String(r["hash"]),
            provider = String(r["provider"]),
            kind = String(r["resource_kind"]);
          const record = s.deletion.records.find(
            (v) =>
              v.provider === provider &&
              v.resourceKind === kind &&
              Buffer.from(v.externalRefHash).toString("hex") === hash,
          );
          if (
            !record ||
            !["aws", "cloudflare"].includes(provider) ||
            !["source-object", "build-artifact"].includes(kind) ||
            !["removed", "not_found"].includes(String(r["outcome"]))
          )
            continue;
          const sourceAttemptId = String(r["cleanup_attempt_id"]),
            cleanupAttemptId = digestId(i.operationId, `inherited-absence:${sourceAttemptId}`),
            observedAt = publicTimestamp(String(r["attempted_at"]));
          statements.push(
            guard(
              db,
              "precondition_changed",
              "NOT EXISTS(SELECT 1 FROM run_cleanup_attempts a WHERE a.organization_id=?1 AND a.project_id=?2 AND a.operation_id=?3 AND a.provider=?4 AND a.resource_kind=?5 AND a.external_ref_hash=unhex(?6) AND a.cleanup_attempt_id=?7 AND NOT EXISTS(SELECT 1 FROM run_cleanup_attempts n WHERE n.organization_id=a.organization_id AND n.project_id=a.project_id AND n.operation_id=a.operation_id AND n.provider=a.provider AND n.resource_kind=a.resource_kind AND n.external_ref_hash=a.external_ref_hash AND(n.attempted_at>a.attempted_at OR(n.attempted_at=a.attempted_at AND n.cleanup_attempt_id>a.cleanup_attempt_id))))",
              [
                i.organizationId,
                i.projectId,
                s.previousOperationId,
                provider,
                kind,
                hash,
                sourceAttemptId,
              ],
            ),
            insert(db, "run_cleanup_attempts", {
              cleanup_attempt_id: cleanupAttemptId,
              organization_id: i.organizationId,
              project_id: i.projectId,
              operation_id: i.operationId,
              provider,
              resource_kind: kind,
              external_ref_hash: record.externalRefHash,
              outcome: r["outcome"],
              error_code: null,
              attempted_at: observedAt.replace(/Z$/u, "000Z"),
            }),
          );
          copied.push({ sourceAttemptId, cleanupAttemptId, observedAt });
        }
        statements.push(
          insert(db, "organization_audit_events", {
            organization_id: i.organizationId,
            audit_event_id: digestId(i.operationId, "deletion-continuation"),
            event_type: "ProjectDeletionContinuationAccepted",
            actor_type: "principal",
            actor_id: i.principalId,
            payload: generatedJsonb({
              projectId: i.projectId,
              operationId: i.operationId,
              previousOperationId: s.previousOperationId,
              inheritedObjectAbsence: copied,
            }),
            occurred_at: at,
          }),
        );
      }
      return statements;
    }
  }
}
