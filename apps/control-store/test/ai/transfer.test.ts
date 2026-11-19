import { afterAll, beforeAll, expect, it } from "vitest";

import { newUlid, ownershipInvariantGuard } from "../../src/catalog/common.js";
import { authorizeAiKey } from "../../src/catalog/ai/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import type { SeededProject } from "../support/platform-fixtures.js";
import { newOrganization } from "../credit/support.js";
import { aiPlan, context, digestOf, installKey, keyOf, publishPlan } from "./support.js";

/*
 * A project moved from its former owner to a new one keeps the former owner's rows. The new owner's key and plan are its
 * own: the former owner's head neither answers for the new owner nor blocks its key.
 */

let control: TestControl;
const TRANSFER = "2026-12-10T00:00:00.000000Z";

beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("keeps the former owner's key and head, and the new owner's jurisdiction is its own plan", async () => {
  const project = await newOrganization(control);
  const oldOrg = project.organizationId;
  const newOrg = (await newOrganization(control)).organizationId;
  const ctx = context(control);
  const key = keyOf(project.projectId);
  const environmentId = project.devEnvironmentId;
  await installKey(control.core, project, environmentId, key);
  await publishPlan(project, environmentId, aiPlan("eu"));
  expect(
    await authorizeAiKey(ctx, { projectId: project.projectId, keySha256: digestOf(key) }),
  ).toMatchObject({ organizationId: oldOrg, jurisdiction: "eu" });

  const newEpoch = await transfer(control, project, newOrg);
  expect(
    await authorizeAiKey(ctx, { projectId: project.projectId, keySha256: digestOf(key) }),
  ).toBeNull();

  const newOwner: SeededProject = { ...project, organizationId: newOrg, billingEpochId: newEpoch };
  await installKey(control.core, newOwner, environmentId, key);
  await publishPlan(newOwner, environmentId, aiPlan("any"));

  const rows = await control.core
    .prepare(
      "SELECT organization_id, owner_state FROM projects WHERE project_id = ?1 ORDER BY organization_id",
    )
    .bind(project.projectId)
    .all<{ organization_id: string; owner_state: string }>();
  expect(rows.results).toHaveLength(2);
  expect(
    await authorizeAiKey(ctx, { projectId: project.projectId, keySha256: digestOf(key) }),
  ).toEqual({
    organizationId: newOrg,
    projectId: project.projectId,
    environmentId,
    jurisdiction: "any",
  });
});

/** The ownership transfer as the import writes it (the same statements as `ownership-history.test.ts`): one current owner. */
async function transfer(
  control: TestControl,
  project: SeededProject,
  newOrg: string,
): Promise<string> {
  const T = TRANSFER;
  const oldOrg = project.organizationId;
  const newEpoch = newUlid();
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE billing_epochs SET ended_at = ?3 WHERE organization_id = ?1 AND billing_epoch_id = ?2",
      )
      .bind(oldOrg, project.billingEpochId, T),
    control.core
      .prepare(
        "UPDATE projects SET owner_state = 'transferred', updated_at = ?3 WHERE organization_id = ?1 AND project_id = ?2",
      )
      .bind(oldOrg, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version,
           handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode,
           region, dev_access_mode, created_at, updated_at)
         SELECT ?1, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt,
           lifecycle_state, lifecycle_version, 'active', 1, ?3, data_mode, region, dev_access_mode, created_at, ?4
         FROM projects WHERE organization_id = ?2 AND project_id = ?5`,
      )
      .bind(newOrg, oldOrg, newEpoch, T, project.projectId),
    control.core
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:import')",
      )
      .bind(newOrg, newEpoch, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at)
         SELECT ?1, environment_id, project_id, name, desired_state, 0, dev_access_epoch, created_at, ?4
         FROM environments WHERE organization_id = ?2 AND project_id = ?3`,
      )
      .bind(newOrg, oldOrg, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at)
         SELECT ?1, project_id, data_environment_id, ?4 FROM project_data_environments WHERE organization_id = ?2 AND project_id = ?3`,
      )
      .bind(newOrg, oldOrg, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at, operation_id)
         SELECT ?1, environment_id, 1, project_id, data_environment_id, ?4, NULL FROM environment_data_assignments
          WHERE organization_id = ?2 AND project_id = ?3 AND assignment_version = 1`,
      )
      .bind(newOrg, oldOrg, project.projectId, T),
    control.core
      .prepare("UPDATE project_directory SET organization_id = ?1 WHERE project_id = ?2")
      .bind(newOrg, project.projectId),
    ownershipInvariantGuard(control.core, project.projectId),
  ]);
  return newEpoch;
}
