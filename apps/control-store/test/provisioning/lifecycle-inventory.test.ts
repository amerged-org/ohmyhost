import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  beforeFirstWrite,
  losingWriteResponses,
  seedProject,
  STORED_NOW,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { seedOperation } from "../support/accepted-operation.js";
import {
  acceptDeletion,
  lifecycleContext,
  seedOwnedResources,
  seedR2Bucket,
  seedSchedule,
} from "./lifecycle.fixture.js";
import { newUlid, ULID_PATTERN } from "../../src/catalog/common.js";
import { legacyMailResourcesStatement } from "../../src/catalog/mail/legacy-resources.js";
import { StoreOutcomeUnknownError } from "../../src/run-command.js";
import { LifecycleInventoryConflictError } from "../../src/catalog/provisioning/lifecycle-conflict.js";
import {
  deleteLifecycleSchedules,
  deletionInventoryRecord,
  deletionInventoryStatements,
  inventoryDigest,
  inventoryInsertStatements,
  inventoryTargetGuards,
  lifecyclePages,
  readDeletionInventoryPlan,
  readLifecycleCleanupResources,
  readLifecycleDeletionEvidence,
  readLifecycleManagedSourceInventory,
  recordLifecycleCleanupAttempt,
} from "../../src/catalog/provisioning/lifecycle-inventory.js";

const AT = "2026-10-28T12:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(() => control.dispose());

const scopeOf = (project: SeededProject) => ({
  organizationId: project.organizationId,
  projectId: project.projectId,
});
const count = async (table: string, project: SeededProject) =>
  (
    await control.core
      .prepare(`SELECT count(*) n FROM ${table} WHERE organization_id=?1 AND project_id=?2`)
      .bind(project.organizationId, project.projectId)
      .first<{ n: number }>()
  )?.n;

it("plans the exact deletion inventory of an owning project, records it once and refuses drift", async () => {
  const project = await seedProject(control),
    owned = await seedOwnedResources(project),
    deletion = await acceptDeletion(project, { cleanup: "running" }),
    input = { ...scopeOf(project), operationId: deletion.operationId, recordedAt: AT },
    plan = await readDeletionInventoryPlan(control.core, input);
  // One row per distinct target, in provider/kind/locator order; legacy and absent families add nothing.
  expect(plan.targets.map((t) => [t.provider, t.resource_kind, t.locator])).toEqual([
    [
      "aws",
      "source-object",
      "ohmyho-poc-private-fullstack-build-123456789012-eu/raw/key/exact-version",
    ],
    ["cloudflare", "build-artifact", "exact-artifact"],
    [
      "cloudflare",
      "build-artifact",
      `r2-version:ohmyho-builds-development-eu/runs/${project.projectId}/${project.devEnvironmentId}/${owned.built.operationId}/output/bundle.tar.gz#${"c".repeat(32)}`,
    ],
    ["cloudflare", "managed-source-blob", `source-bucket/blobs/${sha("a.txt")}/${"e".repeat(32)}`],
    ["cloudflare", "managed-source-blob", `source-bucket/blobs/${sha("b.txt")}/${"e".repeat(32)}`],
    ["cloudflare", "managed-source-repository", `artifacts:${owned.managed.namespace}/repo`],
    [
      "cloudflare",
      "r2-bucket",
      `ohmyho-${project.projectId.toLowerCase()}-${project.prodEnvironmentId.toLowerCase()}`,
    ],
    ["cloudflare", "wfp-script", `ohmyho-production/${owned.published.scriptName}`],
    ["control", "project", project.projectId],
    ["ohmyhost", "gateway-route", project.prodEnvironmentId],
  ]);
  expect(plan.input).toEqual(input);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(new Set(plan.records.map((r) => r.resourceRecordId)).size).toBe(plan.records.length);
  for (const [index, target] of plan.targets.entries()) {
    const record = plan.records[index];
    if (!record) throw new Error("a target has no record");
    expect(record.resourceRecordId).toMatch(ULID_PATTERN);
    expect(record.externalRefHash).toEqual(
      inventoryDigest(target.provider, target.resource_kind, target.locator),
    );
    expect(record.cleanupLocator).toBe(
      `encoded/${Buffer.from(target.locator).toString("base64url")}`,
    );
  }

  // The statements share the acceptance transaction; applying them twice records every target once.
  await control.core.batch(deletionInventoryStatements(control.core, plan));
  await control.core.batch(deletionInventoryStatements(control.core, plan));
  const stored = (
    await control.core
      .prepare(
        "SELECT provider,resource_kind,lower(hex(external_ref_hash)) hash,cleanup_locator,recorded_at FROM run_resource_inventory WHERE operation_id=?1 ORDER BY provider,resource_kind,cleanup_locator",
      )
      .bind(deletion.operationId)
      .all()
  ).results;
  expect(stored).toHaveLength(plan.targets.length);
  const [firstRecord] = plan.records;
  if (!firstRecord) throw new Error("empty plan");
  expect(stored[0]).toMatchObject({
    provider: "aws",
    resource_kind: "source-object",
    hash: Buffer.from(firstRecord.externalRefHash).toString("hex"),
    cleanup_locator: firstRecord.cleanupLocator,
    recorded_at: STORED_NOW.replace("10:00:00", "12:00:00"),
  });

  // A resource that appeared after planning makes the acceptance refuse instead of recording a stale set.
  await seedR2Bucket(project, project.devEnvironmentId);
  await expect(control.core.batch(deletionInventoryStatements(control.core, plan))).rejects.toThrow(
    /guard_precondition_changed/u,
  );
  expect(await count("run_resource_inventory", project)).toBe(plan.targets.length);
});

it("refuses an empty inventory and pages targets beyond one statement of 128", async () => {
  const project = await seedProject(control),
    operationId = await seedOperation(project);
  // A project that does not exist has no 'control/project' target: the plan is empty and refused.
  const unknown = readDeletionInventoryPlan(control.core, {
    organizationId: project.organizationId,
    projectId: newUlid(),
    operationId,
    recordedAt: AT,
  });
  await expect(unknown).rejects.toBeInstanceOf(LifecycleInventoryConflictError);
  await expect(unknown).rejects.toMatchObject({
    code: "deployment_persistence_conflict",
    message: "Deletion inventory cannot be empty or ambiguous",
  });

  expect(lifecyclePages([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  const targets = Array.from({ length: 130 }, (_, i) => ({
    provider: "cloudflare",
    resource_kind: "r2-bucket",
    locator: `bucket-${i}`,
  }));
  // The "current" set is the 130 locators of a JSON parameter; the guards must see all of them across both pages.
  const current = (locators: string[]) => [
    "SELECT 'cloudflare' provider,'r2-bucket' resource_kind,value locator FROM json_each(?1)",
    [JSON.stringify(locators)],
  ];
  const [sql, params] = current(targets.map((t) => t.locator)) as [string, string[]];
  const guards = inventoryTargetGuards(control.core, sql, params, targets);
  expect(guards).toHaveLength(1 + 2);
  await control.core.batch(guards);
  const [sqlMissing, paramsMissing] = current(targets.slice(0, 129).map((t) => t.locator)) as [
    string,
    string[],
  ];
  await expect(
    control.core.batch(inventoryTargetGuards(control.core, sqlMissing, paramsMissing, targets)),
  ).rejects.toThrow(/guard_precondition_changed/u);
  const [sqlSwapped, paramsSwapped] = current([
    ...targets.slice(0, 129).map((t) => t.locator),
    "bucket-other",
  ]) as [string, string[]];
  await expect(
    control.core.batch(inventoryTargetGuards(control.core, sqlSwapped, paramsSwapped, targets)),
  ).rejects.toThrow(/guard_precondition_changed/u);

  const records = targets.map((t) => deletionInventoryRecord(operationId, t)),
    inserts = inventoryInsertStatements(
      control.core,
      { ...scopeOf(project), operationId, recordedAt: AT },
      records,
    );
  expect(inserts).toHaveLength(2);
  await control.core.batch(inserts);
  expect(await count("run_resource_inventory", project)).toBe(130);
  // A locator beyond the column limit is stored as its digest, never truncated.
  expect(
    deletionInventoryRecord(operationId, {
      provider: "cloudflare",
      resource_kind: "r2-bucket",
      locator: "x".repeat(2000),
    }).cleanupLocator,
  ).toMatch(/^hash\/[0-9a-f]{64}$/u);
  // D1 refuses compound SELECTs of more than 5 terms: the legacy mail statement must stay executable on its own.
  expect(
    (await legacyMailResourcesStatement(control.core, scopeOf(project)).all()).results,
  ).toEqual([]);
});

it("reads the historical candidates, cleanup resources and managed source of a deleting project", async () => {
  const project = await seedProject(control),
    owned = await seedOwnedResources(project),
    deletion = await acceptDeletion(project, { cleanup: "running" }),
    context = lifecycleContext(control.core),
    scope = scopeOf(project);

  const evidence = await readLifecycleDeletionEvidence(context, scope);
  expect(evidence.candidates).toEqual([
    {
      candidateReceiptId: owned.published.candidateReceiptId,
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
      operationId: owned.published.operationId,
      productDeploymentId: owned.published.deploymentId,
      artifactId: owned.published.artifactId,
      namespace: "ohmyho-production",
      immutableScriptName: owned.published.scriptName,
      artifactDigest: new Uint8Array(32).fill(3),
      providerTag: "exact-fixture-tag",
      buildReused: false,
      stagedAt: "2026-10-28T10:00:00.000Z",
    },
  ]);
  expect(evidence.activeGateways).toHaveLength(1);
  expect(evidence.activeGateways[0]).toMatchObject({
    environmentId: project.prodEnvironmentId,
    environmentName: "prod",
    candidateReceiptId: owned.published.candidateReceiptId,
    targetScriptName: owned.published.scriptName,
    revision: 1,
    active: true,
  });

  const built = {
    ...scope,
    environmentId: project.devEnvironmentId,
    operationId: owned.built.operationId,
  };
  const resources = await readLifecycleCleanupResources(context, built);
  const operationScope = {
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    operationId: owned.built.operationId,
  };
  expect(resources.sourceArchives).toEqual([
    {
      bucket: "ohmyho-poc-private-fullstack-build-123456789012-eu",
      key: "raw/key",
      versionId: "exact-version",
      eTag: "exact-etag",
      byteLength: 4096,
      scope: operationScope,
      sourceSha256: "09".repeat(32),
    },
  ]);
  expect(resources.artifactExpectations).toHaveLength(1);
  expect(resources.artifactExpectations[0]).toMatchObject({
    receipt: { buildId: "exact-build", projectName: "fixture-build", scope: operationScope },
    deploymentId: owned.built.accepted.intent.deployment_id,
    commitSha: "a".repeat(40),
    output: {
      bucket: "ohmyho-builds-development-eu",
      key: `runs/${project.projectId}/${project.devEnvironmentId}/${owned.built.operationId}/output/bundle.tar.gz`,
      versionId: "c".repeat(32),
      scope: operationScope,
    },
  });
  // The published fixture artifact is not a bundle reference of this operation: the read refuses it.
  await expect(
    readLifecycleCleanupResources(context, {
      ...scope,
      environmentId: project.prodEnvironmentId,
      operationId: owned.published.operationId,
    }),
  ).rejects.toThrow("Persisted build artifact object reference is invalid");

  expect(
    await readLifecycleManagedSourceInventory(context, {
      ...scope,
      operationId: deletion.operationId,
    }),
  ).toEqual({
    repos: [
      {
        sourceConnectionId: owned.managed.sourceConnectionId,
        namespace: owned.managed.namespace,
        repositoryName: "repo",
      },
    ],
    blobOperations: [
      {
        operationId: owned.managed.operationId,
        blobs: [
          {
            path: "a.txt",
            sha256: sha("a.txt"),
            byteLength: 10,
            executable: true,
            bucket: "source-bucket",
            key: `blobs/${sha("a.txt")}`,
            versionId: "e".repeat(32),
            eTag: "etag",
          },
          {
            path: "b.txt",
            sha256: sha("b.txt"),
            byteLength: 10,
            executable: false,
            bucket: "source-bucket",
            key: `blobs/${sha("b.txt")}`,
            versionId: "e".repeat(32),
            eTag: "etag",
          },
        ],
      },
    ],
  });
  // Without an accepted deletion of the exact operation the managed inventory is not readable.
  await expect(
    readLifecycleManagedSourceInventory(context, {
      ...scope,
      operationId: owned.managed.operationId,
    }),
  ).rejects.toMatchObject({ name: "ManagedSourceConflictError", kind: "scope" });
});

it("records cleanup attempts append-only, replays them and resolves a lost response by re-sending", async () => {
  const project = await seedProject(control),
    operationId = await seedOperation(project),
    attempt = {
      ...scopeOf(project),
      operationId,
      cleanupAttemptId: newUlid(),
      provider: "cloudflare",
      resourceKind: "r2-bucket",
      externalRefHash: inventoryDigest("cloudflare", "r2-bucket", "bucket"),
      outcome: "removed" as const,
      attemptedAt: AT,
    },
    context = lifecycleContext(control.core),
    rows = async () =>
      (
        await control.core
          .prepare(
            "SELECT cleanup_attempt_id,provider,resource_kind,lower(hex(external_ref_hash)) hash,outcome,error_code,attempted_at FROM run_cleanup_attempts WHERE operation_id=?1 ORDER BY cleanup_attempt_id",
          )
          .bind(operationId)
          .all()
      ).results;

  expect(await recordLifecycleCleanupAttempt(context, attempt)).toBe("created");
  expect(await rows()).toEqual([
    {
      cleanup_attempt_id: attempt.cleanupAttemptId,
      provider: "cloudflare",
      resource_kind: "r2-bucket",
      hash: Buffer.from(attempt.externalRefHash).toString("hex"),
      outcome: "removed",
      error_code: null,
      attempted_at: STORED_NOW.replace("10:00:00", "12:00:00"),
    },
  ]);
  expect(await recordLifecycleCleanupAttempt(context, attempt)).toBe("existing");
  // A second observation of an already removed resource may arrive as not_found for the same attempt.
  expect(await recordLifecycleCleanupAttempt(context, { ...attempt, outcome: "not_found" })).toBe(
    "existing",
  );
  expect(await rows()).toHaveLength(1);

  // Evidence is append-only: the same attempt id with other facts is refused, and so is an invalid identity.
  await expect(
    recordLifecycleCleanupAttempt(context, { ...attempt, outcome: "failed", errorCode: "E_X" }),
  ).rejects.toBeInstanceOf(LifecycleInventoryConflictError);
  await expect(
    recordLifecycleCleanupAttempt(context, { ...attempt, provider: "aws" }),
  ).rejects.toBeInstanceOf(LifecycleInventoryConflictError);
  for (const bad of [
    { outcome: "failed" },
    { errorCode: "E_X" },
    { provider: " cloudflare" },
    { resourceKind: "" },
    { externalRefHash: new Uint8Array(31) },
  ])
    await expect(
      recordLifecycleCleanupAttempt(context, { ...attempt, cleanupAttemptId: newUlid(), ...bad }),
    ).rejects.toThrow("Cleanup resource identity is invalid");
  expect(await rows()).toHaveLength(1);

  // The commit succeeded but its response was lost: the outcome is unknown, re-sending the same attempt is safe.
  const lost = { ...attempt, cleanupAttemptId: newUlid(), outcome: "not_found" as const };
  const lossy = lifecycleContext(losingWriteResponses(control.core, 1));
  await expect(recordLifecycleCleanupAttempt(lossy, lost)).rejects.toBeInstanceOf(
    StoreOutcomeUnknownError,
  );
  expect(await rows()).toHaveLength(2);
  expect(await recordLifecycleCleanupAttempt(context, lost)).toBe("existing");
  expect(await rows()).toHaveLength(2);
});

it("deletes the schedules of a project exactly as read, retrying when one appears meanwhile", async () => {
  const project = await seedProject(control);
  await seedSchedule(project, project.devEnvironmentId);
  await seedSchedule(project, project.prodEnvironmentId);
  const context = lifecycleContext(control.core);
  expect(await deleteLifecycleSchedules(context, scopeOf(project))).toBe(2);
  expect(await count("environment_function_schedules", project)).toBe(0);
  expect(await deleteLifecycleSchedules(context, scopeOf(project))).toBe(0);

  // The prod schedule is created between the read (one schedule) and the write: the guard fails, the retry reads two.
  const racing = await seedProject(control);
  await seedSchedule(racing, racing.devEnvironmentId);
  const raced = lifecycleContext(
    beforeFirstWrite(control.core, () => seedSchedule(racing, racing.prodEnvironmentId)),
  );
  expect(await deleteLifecycleSchedules(raced, scopeOf(racing))).toBe(2);
  expect(await count("environment_function_schedules", racing)).toBe(0);

  // Lost response of the deleting commit: the outcome is unknown and the same command can be re-sent.
  const lossy = await seedProject(control);
  await seedSchedule(lossy, lossy.devEnvironmentId);
  await expect(
    deleteLifecycleSchedules(
      lifecycleContext(losingWriteResponses(control.core, 1)),
      scopeOf(lossy),
    ),
  ).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
  expect(await count("environment_function_schedules", lossy)).toBe(0);
  expect(await deleteLifecycleSchedules(context, scopeOf(lossy))).toBe(0);
});
