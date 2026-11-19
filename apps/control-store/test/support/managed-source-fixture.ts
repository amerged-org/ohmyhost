import { newUlid } from "../../src/catalog/common.js";
import type { TestControl } from "./control-d1.js";
import { seedProject, STORED_NOW } from "./platform-fixtures.js";

export const MANAGED_USER = "user_managed";
export const MANAGED_PRINCIPAL = `user:${MANAGED_USER}`;
export const CLIENT_ID = "managed-source-client";
export const CONSENT_HASH = "c".repeat(64);

/**
 * A project of an active, beta-admitted organization whose owner may write managed sources, with the queued
 * managed-source recipe the project-creation batch leaves behind and its succeeded parent operation. With
 * `delegated` the recipe carries an organization-wide Connect creation grant and the project holds a project-scoped
 * grant of the same consent, the two delegations a creating and a publishing client present.
 */
export async function seedManagedSourceProject(
  control: TestControl,
  options: { readonly delegated?: boolean; readonly parent?: "succeeded" | "running" } = {},
) {
  const project = await seedProject(control),
    db = control.core,
    parentOperationId = newUlid(),
    sourceConnectionId = newUlid(),
    creationGrantId = crypto.randomUUID(),
    publishGrantId = crypto.randomUUID(),
    delegated = options.delegated === true;
  const grant = (grantId: string, scoped: boolean) =>
    db
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,1,?9)",
      )
      .bind(
        project.organizationId,
        grantId,
        MANAGED_USER,
        CLIENT_ID,
        CONSENT_HASH,
        scoped ? project.projectId : null,
        scoped ? 1 : null,
        scoped ? project.billingEpochId : null,
        STORED_NOW,
      );
  await db.batch([
    db
      .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
      .bind(project.organizationId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'owner','active',1,?3,?4,'evt_managed')",
      )
      .bind(project.organizationId, MANAGED_USER, new Uint8Array(32).fill(1), STORED_NOW),
    db
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
      )
      .bind(project.organizationId, newUlid(), MANAGED_PRINCIPAL, STORED_NOW),
    db
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
      )
      .bind(
        project.organizationId,
        parentOperationId,
        project.projectId,
        options.parent ?? "succeeded",
        project.billingEpochId,
        STORED_NOW,
      ),
    ...(delegated ? [grant(creationGrantId, false), grant(publishGrantId, true)] : []),
    db
      .prepare(
        "INSERT INTO managed_source_initializations(organization_id,parent_operation_id,project_id,billing_epoch_id,source_connection_id,initialization_event_id,principal_id,template,region,request_id,state,delegation_grant_id,delegation_client_id,delegation_consent_sha256,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'empty','eu','managed-create','queued',?8,?9,?10,?11,?11)",
      )
      .bind(
        project.organizationId,
        parentOperationId,
        project.projectId,
        project.billingEpochId,
        sourceConnectionId,
        newUlid(),
        MANAGED_PRINCIPAL,
        delegated ? creationGrantId : null,
        delegated ? CLIENT_ID : null,
        delegated ? CONSENT_HASH : null,
        STORED_NOW,
      ),
  ]);
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    principalId: MANAGED_PRINCIPAL,
  };
  return {
    ...project,
    scope,
    parent: {
      organizationId: project.organizationId,
      projectId: project.projectId,
      parentOperationId,
    },
    parentOperationId,
    sourceConnectionId,
    creation: delegated
      ? {
          grantId: creationGrantId,
          clientId: CLIENT_ID,
          consentHash: CONSENT_HASH,
          action: "projects:create" as const,
        }
      : null,
    publication: delegated
      ? {
          grantId: publishGrantId,
          clientId: CLIENT_ID,
          consentHash: CONSENT_HASH,
          action: "sources:link" as const,
        }
      : null,
  };
}
