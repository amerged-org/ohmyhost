import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

/** Refuse before withdrawing the origin when a private realm is only partly prepared. */
export function nativeDomainPreparationViolation(originPredicate: string) {
  return `EXISTS(SELECT 1 FROM native_auth_realms realm WHERE realm.organization_id=?1 AND realm.project_id=?2 AND (${originPredicate})
    AND NOT EXISTS(SELECT 1 FROM native_auth_registrations reg JOIN native_auth_database_targets target ON target.organization_id=reg.organization_id AND target.project_id=reg.project_id AND target.target_version=reg.target_version AND target.provider_project_id=reg.provider_project_id AND target.database_id=reg.database_id AND target.region_id=reg.region_id AND target.ended_at IS NULL JOIN native_auth_preparation_receipts proof ON proof.organization_id=reg.organization_id AND proof.project_id=reg.project_id AND proof.environment_id=reg.environment_id AND proof.operation_id=reg.operation_id AND proof.claim_id=reg.claim_id AND proof.target_version=reg.target_version AND proof.provider_project_id=reg.provider_project_id AND proof.database_id=reg.database_id AND proof.schema_name=reg.schema_name AND proof.runtime_role=reg.role_name WHERE reg.organization_id=realm.organization_id AND reg.project_id=realm.project_id AND reg.environment_id=realm.environment_id AND reg.state='active' AND proof.migrator_role='omh_am_'||lower(reg.environment_id) AND proof.backup_role='omh_ab_'||lower(reg.project_id) AND proof.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND proof.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}' AND (NOT EXISTS(SELECT 1 FROM native_auth_restores restore WHERE restore.organization_id=reg.organization_id AND restore.project_id=reg.project_id) OR EXISTS(SELECT 1 FROM native_auth_restores restore JOIN native_auth_restore_realms restored ON restored.organization_id=restore.organization_id AND restored.project_id=restore.project_id AND restored.restore_id=restore.restore_id AND restored.environment_id=reg.environment_id JOIN native_auth_restore_verifications verified ON verified.organization_id=restored.organization_id AND verified.project_id=restored.project_id AND verified.restore_id=restored.restore_id AND verified.environment_id=restored.environment_id WHERE restore.organization_id=reg.organization_id AND restore.project_id=reg.project_id AND restore.database_id=reg.database_id AND restore.state='complete' AND restore.restore_generation=(SELECT max(latest.restore_generation) FROM native_auth_restores latest WHERE latest.organization_id=restore.organization_id AND latest.project_id=restore.project_id) AND verified.target_version=reg.target_version AND verified.registry_version=reg.registry_version AND verified.schema_name=reg.schema_name AND verified.runtime_role=reg.role_name AND verified.migrator_role='omh_am_'||lower(reg.environment_id) AND verified.backup_role='omh_ab_'||lower(reg.project_id) AND verified.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND verified.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}')))
    AND (EXISTS(SELECT 1 FROM native_auth_registrations n WHERE n.organization_id=realm.organization_id AND n.project_id=realm.project_id AND n.environment_id=realm.environment_id)
      OR EXISTS(SELECT 1 FROM native_auth_role_operations n WHERE n.organization_id=realm.organization_id AND n.project_id=realm.project_id AND n.environment_id=realm.environment_id)
      OR EXISTS(SELECT 1 FROM native_auth_preparation_receipts n WHERE n.organization_id=realm.organization_id AND n.project_id=realm.project_id AND n.environment_id=realm.environment_id)
      OR EXISTS(SELECT 1 FROM native_auth_restore_realms n WHERE n.organization_id=realm.organization_id AND n.project_id=realm.project_id AND n.environment_id=realm.environment_id)
      OR EXISTS(SELECT 1 FROM environments e JOIN deployment_revisions revision ON revision.organization_id=e.organization_id AND revision.project_id=e.project_id AND revision.deployment_id=e.active_deployment_id AND revision.revision_id=e.active_revision_id JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id WHERE e.organization_id=realm.organization_id AND e.project_id=realm.project_id AND e.environment_id=realm.environment_id AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native')))`;
}

export function nativeDomainPreparationGuard(
  db: D1Database,
  input: {
    organizationId: string;
    projectId: string;
    originPredicate: string;
    originValues: readonly unknown[];
  },
) {
  return guard(db, "operation_conflict", nativeDomainPreparationViolation(input.originPredicate), [
    input.organizationId,
    input.projectId,
    ...input.originValues,
  ]);
}

/**
 * Freeze every realm affected by an origin withdrawal before the domain update fires the
 * origin-loss trigger. The parent and these rows must commit in the same D1 batch as that update.
 * `originPredicate` is internal SQL supplied by the caller, never customer input.
 */
export function snapshotNativeDomainPolicies(
  db: D1Database,
  input: {
    organizationId: string;
    projectId: string;
    kind: "paid_delete" | "handle_change";
    identity: string;
    originalInput: string;
    parentPredicate?: string;
    originPredicate: string;
    originValues: readonly unknown[];
  },
) {
  const values = [input.organizationId, input.projectId, input.kind, input.identity];
  return [
    db
      .prepare(
        `INSERT INTO native_auth_domain_operations(organization_id,project_id,kind,identity,original_input,state)
      SELECT ?1,?2,?3,?4,?5,'pending' WHERE ${input.parentPredicate ?? "1"} ON CONFLICT DO NOTHING`,
      )
      .bind(...values, input.originalInput, ...input.originValues),
    db
      .prepare(
        `INSERT INTO native_auth_domain_policy_syncs(
         organization_id,project_id,kind,identity,environment_id,old_origin,
         head_deployment_id,head_revision_id,head_version,configuration_revision,
         revocation_epoch,owner_enabled,registry_version,state,acknowledgement)
       SELECT realm.organization_id,realm.project_id,?3,?4,realm.environment_id,realm.canonical_origin,
         e.active_deployment_id,e.active_revision_id,e.head_version,realm.configuration_revision+1,
         realm.revocation_epoch+1,realm.enabled,registration.registry_version,'pending',NULL
       FROM native_auth_realms realm
       JOIN environments e ON e.organization_id=realm.organization_id AND e.project_id=realm.project_id AND e.environment_id=realm.environment_id
       LEFT JOIN native_auth_registrations registration ON registration.organization_id=realm.organization_id AND registration.project_id=realm.project_id AND registration.environment_id=realm.environment_id AND registration.state='active'
       WHERE realm.organization_id=?1 AND realm.project_id=?2 AND (${input.originPredicate})
       ON CONFLICT DO NOTHING`,
      )
      .bind(...values, ...input.originValues),
  ];
}
