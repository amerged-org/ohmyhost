import { newUlid } from "../../src/catalog/common.js";
import type { D1Database } from "../../src/d1-types.js";

/**
 * The retained state of a retired Development environment: a completed retirement, the immutable restoration
 * boundary, the renamed archived row and its fresh replacement on the same physical environment.
 * The caller keeps the organization on Paid while this runs; the environment name trigger requires it.
 */
export async function archiveDevEnvironment(
  db: D1Database,
  scope: { organizationId: string; projectId: string; devEnvironmentId: string },
  physicalEnvironmentId: string,
  at: string,
): Promise<string> {
  const fresh = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO free_dev_retirements(organization_id,project_id,retirement_id,environment_id,ownership_version,policy_epoch,state,created_at,updated_at) SELECT organization_id,project_id,?3,?4,ownership_version,'','completed',?5,?5 FROM projects WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(scope.organizationId, scope.projectId, newUlid(), scope.devEnvironmentId, at),
    db
      .prepare(
        "INSERT INTO dev_environment_restorations(organization_id,project_id,previous_environment_id,environment_id,physical_environment_id,archived_at)VALUES(?,?,?,?,?,?)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.devEnvironmentId,
        fresh,
        physicalEnvironmentId,
        at,
      ),
    db
      .prepare(
        "UPDATE environments SET name='retired-dev-'||environment_id,active_deployment_id=NULL,active_revision_id=NULL,dev_access_epoch=dev_access_epoch+1,updated_at=?3 WHERE organization_id=?1 AND environment_id=?2",
      )
      .bind(scope.organizationId, scope.devEnvironmentId, at),
    db
      .prepare(
        "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at)VALUES(?,?,?,'dev','{}',0,1,?,?)",
      )
      .bind(scope.organizationId, scope.projectId, fresh, at, at),
    db
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at)VALUES(?,?,?,?,1,?)",
      )
      .bind(scope.organizationId, scope.projectId, fresh, physicalEnvironmentId, at),
  ]);
  return fresh;
}
