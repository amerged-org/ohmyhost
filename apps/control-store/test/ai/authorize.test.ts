import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authorizeAiKey } from "../../src/catalog/ai/index.js";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedOperation } from "../support/accepted-operation.js";
import { seedDeploymentPlan, sourceFrameworkPlan } from "../support/provider-fixtures.js";
import { newOrganization } from "../credit/support.js";
import {
  aiPlan,
  context,
  digestOf,
  installKey,
  keyOf,
  publishPlan,
  readyProject,
} from "./support.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

/**
 * A later revision of an environment that declares `frameworkPlan` and becomes its head, the way a later deployment
 * does. It reuses the build, artifact and publication of the current head, which a re-deploy of the same artifact or a
 * promotion leaves behind, so only the plan and the head change.
 */
async function publishLaterHead(
  project: Parameters<typeof publishPlan>[0],
  environmentId: string,
  frameworkPlan: unknown,
): Promise<{ readonly deploymentId: string; readonly revisionId: string }> {
  const db = project.shard;
  const head = await db
    .prepare(
      `SELECT revision.build_execution_id, revision.artifact_id, revision.wfp_receipt_id FROM environments e
 JOIN deployment_revisions revision ON revision.organization_id = e.organization_id AND revision.project_id = e.project_id AND revision.revision_id = e.active_revision_id
 WHERE e.organization_id = ?1 AND e.environment_id = ?2`,
    )
    .bind(project.organizationId, environmentId)
    .first<{ build_execution_id: string; artifact_id: string; wfp_receipt_id: string }>();
  if (!head) throw new Error("environment has no active revision");
  const planId = newUlid(),
    deploymentId = newUlid(),
    revisionId = newUlid(),
    operationId = await seedOperation(project);
  await seedDeploymentPlan(project, planId, frameworkPlan, environmentId);
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    db
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_revision_id,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','succeeded',?6,1,'2026-10-28T12:00:00.000000Z','2026-10-28T12:00:00.000000Z')",
      )
      .bind(
        project.organizationId,
        deploymentId,
        project.projectId,
        environmentId,
        operationId,
        revisionId,
      ),
    db
      .prepare(
        "INSERT INTO deployment_revisions(organization_id,revision_id,project_id,deployment_id,plan_id,build_execution_id,artifact_id,wfp_receipt_id,operation_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'2026-10-28T12:00:00.000000Z')",
      )
      .bind(
        project.organizationId,
        revisionId,
        project.projectId,
        deploymentId,
        planId,
        head.build_execution_id,
        head.artifact_id,
        head.wfp_receipt_id,
        operationId,
      ),
    db
      .prepare(
        "UPDATE environments SET active_deployment_id = ?3, active_revision_id = ?4, head_version = head_version + 1 WHERE organization_id = ?1 AND environment_id = ?2",
      )
      .bind(project.organizationId, environmentId, deploymentId, revisionId),
  ]);
  return { deploymentId, revisionId };
}

describe("authorizing a gateway key", () => {
  it("returns the scope of the key with the jurisdiction its environment's head declares", async () => {
    const p = await readyProject(control, { jurisdiction: "eu" });
    expect(
      await authorizeAiKey(p.context, {
        projectId: p.project.projectId,
        keySha256: digestOf(p.key),
      }),
    ).toEqual(p.scope);
  });

  it("is reachable through the store facet the Worker delegates to", async () => {
    const p = await readyProject(control, { jurisdiction: "any" });
    const store = createControlStore({ CONTROL_CORE: control.core });
    expect(
      await store.aiGateway.authorizeKey({
        projectId: p.project.projectId,
        keySha256: digestOf(p.key),
      }),
    ).toEqual({ ...p.scope, jurisdiction: "any" });
  });

  it("answers null for an unknown digest and for another project's key", async () => {
    const p = await readyProject(control);
    const other = await readyProject(control);
    expect(
      await authorizeAiKey(p.context, {
        projectId: p.project.projectId,
        keySha256: "00".repeat(32),
      }),
    ).toBeNull();
    expect(
      await authorizeAiKey(p.context, {
        projectId: other.project.projectId,
        keySha256: digestOf(p.key),
      }),
    ).toBeNull();
  });

  it("answers null for a digest that two environments of the project share", async () => {
    const p = await readyProject(control);
    const key = keyOf(p.project.projectId);
    await installKey(control.core, p.project, p.project.prodEnvironmentId, key);
    await publishPlan(p.project, p.project.prodEnvironmentId, aiPlan("eu"));
    expect(
      await authorizeAiKey(p.context, {
        projectId: p.project.projectId,
        keySha256: digestOf(key),
      }),
    ).toBeNull();
  });

  it("answers null for a retired project", async () => {
    const retired = await readyProject(control);
    await control.core
      .prepare(
        "UPDATE projects SET lifecycle_state = 'deleting', lifecycle_version = lifecycle_version + 1 WHERE project_id = ?1",
      )
      .bind(retired.project.projectId)
      .run();
    expect(
      await authorizeAiKey(retired.context, {
        projectId: retired.project.projectId,
        keySha256: digestOf(retired.key),
      }),
    ).toBeNull();
  });

  it("answers null for a frozen owner, and refuses input that is not a project id or a digest", async () => {
    const frozen = await readyProject(control);
    await control.core
      .prepare("UPDATE projects SET owner_state = 'security_frozen' WHERE project_id = ?1")
      .bind(frozen.project.projectId)
      .run();
    expect(
      await authorizeAiKey(frozen.context, {
        projectId: frozen.project.projectId,
        keySha256: digestOf(frozen.key),
      }),
    ).toBeNull();
    await expect(
      authorizeAiKey(frozen.context, { projectId: "not-a-ulid", keySha256: digestOf(frozen.key) }),
    ).rejects.toThrow("Invalid AI gateway input");
    await expect(
      authorizeAiKey(frozen.context, {
        projectId: frozen.project.projectId,
        keySha256: "ABC",
      }),
    ).rejects.toThrow("Invalid AI gateway input");
  });
});

describe("the jurisdiction is the one of the environment's active revision", () => {
  it("follows the head: a later head declaring any answers any, and a head back to the first revision answers eu", async () => {
    const p = await readyProject(control, { jurisdiction: "eu" });
    const first = await control.core
      .prepare(
        "SELECT active_deployment_id, active_revision_id FROM environments WHERE organization_id = ?1 AND environment_id = ?2",
      )
      .bind(p.project.organizationId, p.project.devEnvironmentId)
      .first<{ active_deployment_id: string; active_revision_id: string }>();
    if (!first) throw new Error("dev environment missing");
    const input = { projectId: p.project.projectId, keySha256: digestOf(p.key) };
    await publishLaterHead(p.project, p.project.devEnvironmentId, aiPlan("any"));
    expect(await authorizeAiKey(p.context, input)).toMatchObject({ jurisdiction: "any" });

    await control.core
      .prepare(
        "UPDATE environments SET active_deployment_id = ?3, active_revision_id = ?4 WHERE organization_id = ?1 AND environment_id = ?2",
      )
      .bind(
        p.project.organizationId,
        p.project.devEnvironmentId,
        first.active_deployment_id,
        first.active_revision_id,
      )
      .run();
    expect(await authorizeAiKey(p.context, input)).toMatchObject({ jurisdiction: "eu" });
  });

  it("answers null when the head's plan does not declare ai, although the key row exists", async () => {
    const p = await newOrganization(control).then(async (project) => {
      const key = keyOf(project.projectId);
      await installKey(control.core, project, project.devEnvironmentId, key);
      await publishPlan(project, project.devEnvironmentId, sourceFrameworkPlan(false));
      return { project, key, context: context(control) };
    });
    expect(
      await authorizeAiKey(p.context, {
        projectId: p.project.projectId,
        keySha256: digestOf(p.key),
      }),
    ).toBeNull();
  });

  it("answers null for an environment without an active revision", async () => {
    const project = await newOrganization(control);
    const key = keyOf(project.projectId);
    await installKey(control.core, project, project.devEnvironmentId, key);
    expect(
      await authorizeAiKey(context(control), {
        projectId: project.projectId,
        keySha256: digestOf(key),
      }),
    ).toBeNull();
  });

  it("ignores a plan that is not the head of its environment", async () => {
    const p = await readyProject(control, { jurisdiction: "eu" });
    await seedDeploymentPlan(p.project, newUlid(), aiPlan("any"), p.project.devEnvironmentId);
    expect(
      await authorizeAiKey(p.context, {
        projectId: p.project.projectId,
        keySha256: digestOf(p.key),
      }),
    ).toMatchObject({ jurisdiction: "eu" });
  });
});
