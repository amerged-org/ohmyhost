import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, losingNthResponse, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedAcceptedOperation,
  seedPublishedClaim,
  promotionIntent,
  rollbackIntent,
} from "../support/accepted-operation.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("pins authorized cache scopes and retires only after irreversible deletion and its retained tombstone", async () => {
  const store = createControlStore(control.bindings);
  const project = await seedProject(control);
  const scopes: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
  }[] = [];
  for (const environmentId of [project.devEnvironmentId, project.prodEnvironmentId]) {
    const accepted = await seedAcceptedOperation(project, environmentId);
    const deploymentId = accepted.intent.deployment_id;
    if (deploymentId === undefined) throw new Error("fixture has no deployment");
    const scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId,
      deploymentId,
    };
    if (environmentId === project.devEnvironmentId) {
      const lossy = createControlStore({ CONTROL_CORE: losingNthResponse(control.core, 2) });
      expect(await lossy.runtimeSecrets.registerNextCacheScope(scope)).toEqual({ region: "eu" });
      expect(await store.runtimeSecrets.registerNextCacheScope(scope)).toEqual({ region: "eu" });
    } else {
      expect(
        await Promise.all([
          store.runtimeSecrets.registerNextCacheScope(scope),
          store.runtimeSecrets.registerNextCacheScope(scope),
        ]),
      ).toEqual([{ region: "eu" }, { region: "eu" }]);
    }
    expect(
      await store.runtimeSecrets.registerNextCacheScope({ ...scope, environmentId: newUlid() }),
    ).toBeNull();
    expect(
      await store.runtimeSecrets.registerNextCacheScope({ ...scope, organizationId: newUlid() }),
    ).toBeNull();
    await releaseProviderClaim(project);
    expect(await store.runtimeSecrets.registerNextCacheScope(scope)).toBeNull();
    scopes.push(scope);
  }
  const deletion = await seedAcceptedOperation(project, project.prodEnvironmentId, {
    eventType: "ProjectDeletionRequestedV1",
    claim: false,
  });
  const cleanupRunId = deletion.intent.cleanup_run_id;
  if (cleanupRunId === undefined) throw new Error("fixture has no cleanup run");
  await control.core
    .prepare(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=? AND project_id=?",
    )
    .bind(project.organizationId, project.projectId)
    .run();
  const removal = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    operationId: deletion.operationId,
    cleanupRunId,
  };
  const first = scopes[0];
  if (first === undefined) throw new Error("fixture scope missing");
  expect(
    await store.runtimeSecrets.authorizeNextCacheRetirement({ ...first, ...removal }),
  ).toBeNull();
  expect(
    await store.runtimeSecrets.listNextCacheRetirementScopes({ ...removal, limit: 1 }),
  ).toBeNull();
  await store.provisioning.retainDeletionTombstone({
    organizationId: project.organizationId,
    projectId: project.projectId,
    operationId: deletion.operationId,
    environmentId: project.prodEnvironmentId,
    workflowId: deletion.workflowId,
    outboxEventId: deletion.eventId,
    startedOperationEventId: newUlid(),
    recordedAt: "2026-10-28T10:01:00.000Z",
    tombstoneReceiptId: "wfp:tombstone",
  });
  expect(await store.runtimeSecrets.recordNextCacheRetired({ ...first, ...removal })).toBeNull();
  expect(
    await Promise.all([
      store.runtimeSecrets.authorizeNextCacheRetirement({ ...first, ...removal }),
      store.runtimeSecrets.authorizeNextCacheRetirement({ ...first, ...removal }),
    ]),
  ).toEqual([{ region: "eu" }, { region: "eu" }]);
  await expect(
    control.core
      .prepare(
        "UPDATE projects SET lifecycle_state='active' WHERE organization_id=? AND project_id=?",
      )
      .bind(project.organizationId, project.projectId)
      .run(),
  ).rejects.toThrow("project deletion cannot be reversed");
  expect(
    await store.runtimeSecrets.authorizeNextCacheRetirement({
      ...first,
      ...removal,
      deploymentId: newUlid(),
    }),
  ).toBeNull();
  const page = await store.runtimeSecrets.listNextCacheRetirementScopes({ ...removal, limit: 1 });
  expect(page?.scopes).toHaveLength(1);
  expect(page?.nextCursor).not.toBeNull();
  const listed = page?.scopes[0];
  if (listed === undefined || page?.nextCursor == null) throw new Error("fixture page missing");
  const lossy = createControlStore({ CONTROL_CORE: losingNthResponse(control.core, 2) });
  expect(await lossy.runtimeSecrets.recordNextCacheRetired({ ...removal, ...listed })).toBe(
    "existing",
  );
  expect(await store.runtimeSecrets.recordNextCacheRetired({ ...removal, ...listed })).toBe(
    "existing",
  );
  const remaining = await store.runtimeSecrets.listNextCacheRetirementScopes({
    ...removal,
    limit: 1,
  });
  expect(remaining?.scopes).toHaveLength(1);
  expect(remaining?.nextCursor).toBeNull();
  expect(
    await store.runtimeSecrets.recordNextCacheRetired({
      ...removal,
      ...listed,
      cleanupRunId: newUlid(),
    }),
  ).toBeNull();
  const last = remaining?.scopes[0];
  if (last === undefined) throw new Error("last retirement scope missing");
  expect(await store.runtimeSecrets.recordNextCacheRetired({ ...removal, ...last })).toBe(
    "recorded",
  );
  expect(await store.runtimeSecrets.recordNextCacheRetired({ ...removal, ...last })).toBe(
    "existing",
  );
  expect(
    await store.runtimeSecrets.listNextCacheRetirementScopes({ ...removal, limit: 1 }),
  ).toEqual({
    scopes: [],
    nextCursor: null,
  });
});

it("isolates a promoted deployment and reuses the original cache scope on rollback", async () => {
  const store = createControlStore(control.bindings);
  const project = await seedProject(control);
  const { published } = await seedPublishedClaim(project, project.devEnvironmentId, (operationId) =>
    seedWfpPublication(project, { operationId, environmentId: project.devEnvironmentId }),
  );
  const original = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    deploymentId: published.deploymentId,
  };
  expect(await store.runtimeSecrets.registerNextCacheScope(original)).toEqual({ region: "eu" });
  await releaseProviderClaim(project);
  const promotion = await seedAcceptedOperation(project, project.prodEnvironmentId, {
    eventType: "DeploymentPromotionRequestedV1",
    intent: (operationId) =>
      promotionIntent(project, operationId, project.prodEnvironmentId, {
        ...published,
        environmentId: project.devEnvironmentId,
      }),
  });
  const promoted = {
    ...original,
    environmentId: project.prodEnvironmentId,
    deploymentId: promotion.intent.deployment_id,
  };
  expect(await store.runtimeSecrets.registerNextCacheScope(promoted)).toEqual({ region: "eu" });
  expect(
    await store.runtimeSecrets.registerNextCacheScope({
      ...original,
      environmentId: project.prodEnvironmentId,
    }),
  ).toBeNull();
  await releaseProviderClaim(project);
  const rollback = await seedAcceptedOperation(project, project.devEnvironmentId, {
    eventType: "DeploymentRollbackRequestedV1",
    intent: (operationId) =>
      rollbackIntent(project, operationId, project.devEnvironmentId, published),
  });
  expect(await store.runtimeSecrets.registerNextCacheScope(original)).toEqual({ region: "eu" });
  expect(
    await store.runtimeSecrets.registerNextCacheScope({
      ...original,
      deploymentId: rollback.intent.deployment_id,
    }),
  ).toBeNull();
  expect(
    (
      await control.core
        .prepare("SELECT count(*) n FROM next_cache_scopes WHERE project_id=?")
        .bind(project.projectId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(2);
});
