import type { TestControl } from "./control-d1.js";
import { seedProject, STORED_NOW } from "./platform-fixtures.js";
import { seedProviderClaim } from "./accepted-operation.js";
import { runtimeRoleOf } from "../../src/catalog/database/contracts.js";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
let seq = 0;
export async function rig(
  control: TestControl,
  projectOverride?: string,
  endedAt: string | null = "2026-10-28T12:00:00.000000Z",
) {
  seq++;
  const project = await seedProject(control),
    physical = newUlid(),
    providerProjectId = projectOverride ?? `prj_${String(seq).padStart(20, "a")}`,
    databaseId = `d${String(seq).padStart(19, "b")}`;
  const claim = await seedProviderClaim(project, project.devEnvironmentId);
  await control.core
    .prepare(
      "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?,?,?,?)",
    )
    .bind(project.organizationId, project.projectId, physical, STORED_NOW)
    .run();
  for (const env of [project.devEnvironmentId, project.prodEnvironmentId])
    await control.core
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at) VALUES(?,?,1,?,?,?)",
      )
      .bind(project.organizationId, env, project.projectId, physical, STORED_NOW)
      .run();
  await control.core
    .prepare(
      "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?,?,?,1,'pgcf',?,?,'us-dev','r512-s1g',?,'sealed:fixture',?,?)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      physical,
      providerProjectId,
      databaseId,
      runtimeRoleOf(physical),
      claim.operationId,
      STORED_NOW,
    )
    .run();
  await control.core
    .prepare(
      "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?,?,?,1,'active','2026-10-28T09:20:00.000000Z',?)",
    )
    .bind(project.organizationId, project.projectId, physical, STORED_NOW)
    .run();
  if (endedAt !== null)
    await control.core
      .prepare(
        "UPDATE database_provider_target_heads SET state='retired',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3",
      )
      .bind(project.organizationId, project.projectId, physical, endedAt)
      .run();
  return {
    project,
    physical,
    providerProjectId,
    databaseId,
    store: createControlStore(control.bindings),
  };
}
