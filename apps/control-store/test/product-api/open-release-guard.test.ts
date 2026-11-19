import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  acceptance,
  issueConfirmation,
  linkSource,
  productRig,
  publishedRevision,
} from "../support/product-api-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

const one = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

describe("productApi open release guard", () => {
  it("refuses a rollback of an environment while a promotion into it is open", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const dev = await publishedRevision(rig, rig.devEnvironmentId),
      prod = await publishedRevision(rig, rig.prodEnvironmentId);
    const promotion = await api.readApiPromotionTarget({
      ...scope,
      sourceEnvironmentId: rig.devEnvironmentId,
      targetEnvironmentId: rig.prodEnvironmentId,
    });
    const promote = acceptance(rig, rig.prodEnvironmentId, {
      eventType: "DeploymentPromotionRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments/promote",
      deploymentId: newUlid(),
      sourceEnvironmentId: rig.devEnvironmentId,
      sourceDeploymentId: dev.deploymentId,
      sourceRevisionId: dev.revisionId,
      sourceArtifactId: dev.artifactId,
      sourceArtifactDigest: promotion?.sourceArtifactDigest,
      expectedSourceHeadVersion: promotion?.expectedSourceHeadVersion,
      expectedHeadVersion: promotion?.expectedTargetHeadVersion,
      expectedEtag: '"promote"',
      confirmation: await issueConfirmation(rig, "promote", '"promote"', dev.deploymentId),
    });
    await expect(api.acceptApiProductOperation(promote)).resolves.toMatchObject({
      state: "queued",
    });
    // While that promotion is open, a rollback of Prod that would run after it is refused.
    const target = await api.readApiRollbackTarget({ ...scope, deploymentId: prod.deploymentId });
    const rollback = acceptance(rig, rig.prodEnvironmentId, {
      eventType: "DeploymentRollbackRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments/{deployment_id}/rollback",
      deploymentId: newUlid(),
      targetDeploymentId: prod.deploymentId,
      targetRevisionId: prod.revisionId,
      targetArtifactId: prod.artifactId,
      expectedHeadVersion: target?.expectedHeadVersion,
      expectedDataEnvironmentId: target?.dataEnvironmentId,
      expectedAssignmentVersion: target?.assignmentVersion,
      expectedRegistrationVersion: target?.registrationVersion,
      expectedEtag: '"rollback"',
      confirmation: await issueConfirmation(rig, "rollback", '"rollback"', prod.deploymentId),
    });
    await expect(api.acceptApiProductOperation(rollback)).rejects.toThrow();
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", rollback.operationId),
    ).toEqual({ n: 0 });
  }, 30_000);

  it("refuses a promotion into an environment while a rollback of it is open", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const dev = await publishedRevision(rig, rig.devEnvironmentId),
      prod = await publishedRevision(rig, rig.prodEnvironmentId);
    const target = await api.readApiRollbackTarget({ ...scope, deploymentId: prod.deploymentId });
    const rollback = acceptance(rig, rig.prodEnvironmentId, {
      eventType: "DeploymentRollbackRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments/{deployment_id}/rollback",
      deploymentId: newUlid(),
      targetDeploymentId: prod.deploymentId,
      targetRevisionId: prod.revisionId,
      targetArtifactId: prod.artifactId,
      expectedHeadVersion: target?.expectedHeadVersion,
      expectedDataEnvironmentId: target?.dataEnvironmentId,
      expectedAssignmentVersion: target?.assignmentVersion,
      expectedRegistrationVersion: target?.registrationVersion,
      expectedEtag: '"rollback"',
      confirmation: await issueConfirmation(rig, "rollback", '"rollback"', prod.deploymentId),
    });
    await expect(api.acceptApiProductOperation(rollback)).resolves.toMatchObject({
      state: "queued",
    });
    // A promotion into Prod is refused while that rollback is open, so it cannot be overtaken by it.
    const promotion = await api.readApiPromotionTarget({
      ...scope,
      sourceEnvironmentId: rig.devEnvironmentId,
      targetEnvironmentId: rig.prodEnvironmentId,
    });
    const promote = acceptance(rig, rig.prodEnvironmentId, {
      eventType: "DeploymentPromotionRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments/promote",
      deploymentId: newUlid(),
      sourceEnvironmentId: rig.devEnvironmentId,
      sourceDeploymentId: dev.deploymentId,
      sourceRevisionId: dev.revisionId,
      sourceArtifactId: dev.artifactId,
      sourceArtifactDigest: promotion?.sourceArtifactDigest,
      expectedSourceHeadVersion: promotion?.expectedSourceHeadVersion,
      expectedHeadVersion: promotion?.expectedTargetHeadVersion,
      expectedEtag: '"promote"',
      confirmation: await issueConfirmation(rig, "promote", '"promote"', dev.deploymentId),
    });
    await expect(api.acceptApiProductOperation(promote)).rejects.toThrow();
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", promote.operationId),
    ).toEqual({ n: 0 });
  }, 30_000);
});
