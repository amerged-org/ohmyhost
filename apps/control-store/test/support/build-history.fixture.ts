import type { TestControl } from "./control-d1.js";
import type { buildRig } from "./build-fixtures.js";
import { seedOrganization } from "./seed.js";
import { ulidOf } from "./platform-fixtures.js";
import { ownershipInvariantGuard } from "../../src/catalog/common.js";

export const BUILD_TRANSFER_AT = "2026-10-28T12:02:00.000000Z";

/** Faithful ownership-history import: the accepted operation, epoch, financial scope and payloads keep their owner.
 * The original 149 plan FK may require its historical environment alias; it is not a new current-owner admission. */
export async function transferBuildProject(
  control: TestControl,
  rig: Awaited<ReturnType<typeof buildRig>>,
) {
  const p = rig.project,
    nextOrg = await seedOrganization(rig.store, 2, 1),
    nextEpoch = ulidOf(`build-history-${p.projectId}`, 1),
    db = control.core;
  await db.batch([
    db
      .prepare(
        "UPDATE billing_epochs SET ended_at=?3 WHERE organization_id=?1 AND billing_epoch_id=?2",
      )
      .bind(p.organizationId, p.billingEpochId, BUILD_TRANSFER_AT),
    db
      .prepare(
        "UPDATE projects SET owner_state='transferred',updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId, BUILD_TRANSFER_AT),
    db
      .prepare(
        `INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at)
        SELECT ?1,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,'active',ownership_version+1,?3,data_mode,region,dev_access_mode,created_at,?4 FROM projects WHERE organization_id=?2 AND project_id=?5`,
      )
      .bind(nextOrg, p.organizationId, nextEpoch, BUILD_TRANSFER_AT, p.projectId),
    db
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?1,?2,?3,?4,'user:build-history-import')",
      )
      .bind(nextOrg, nextEpoch, p.projectId, BUILD_TRANSFER_AT),
    db
      .prepare(
        `INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at)
        SELECT ?1,environment_id,project_id,name,desired_state,0,dev_access_epoch,created_at,?4 FROM environments WHERE organization_id=?2 AND project_id=?3`,
      )
      .bind(nextOrg, p.organizationId, p.projectId, BUILD_TRANSFER_AT),
    db
      .prepare("UPDATE project_directory SET organization_id=?1 WHERE project_id=?2")
      .bind(nextOrg, p.projectId),
    ownershipInvariantGuard(db, p.projectId),
  ]);
  return { nextOrg, nextEpoch };
}
