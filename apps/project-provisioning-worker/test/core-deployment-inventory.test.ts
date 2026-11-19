import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeploymentPersistenceConflictError } from "@ohmyhost/database/provisioning-persistence";
import { parseUlid } from "@ohmyhost/platform";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
import { DeploymentWorkflowRuntime } from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  planProjectDataChangeTransition,
  parseProjectDataChangeSnapshot,
} from "../../control-store/src/catalog/provisioning/context-snapshots.js";
import { readCurrentDataAssignments } from "../../control-store/src/catalog/provisioning/project-data-change.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  STORED_NOW,
  losingWriteResponses,
  seedProject,
  type SeededProject,
} from "../../control-store/test/support/platform-fixtures.js";
import {
  seedAcceptedOperation,
  seedOperation,
  seedPublishedClaim,
} from "../../control-store/test/support/accepted-operation.js";
import { seedContextPublication } from "../../control-store/test/provisioning/context-source-fixture.js";
import {
  createCoreDeploymentInventory,
  type DeploymentInventoryRuntimeBinding,
} from "../src/core-deployment-inventory.js";

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
});
afterEach(async () => c.dispose());

const NOW = "2026-10-28T10:00:00.000Z";
/** The deployed private entrypoint of the Control store, over a real local D1. */
const entrypoint = (env: { CONTROL_CORE: unknown } = c.bindings) =>
  new DeploymentWorkflowRuntime(
    {} as never,
    env as never,
  ) as unknown as DeploymentInventoryRuntimeBinding;
const ids = (project: SeededProject) => ({
  organizationId: parseUlid(project.organizationId),
  projectId: parseUlid(project.projectId),
});

/** A project with a published production deployment (candidate, active gateway route) and raw source custody. */
async function publication() {
  const project = await seedProject(c),
    { published, claim } = await seedPublishedClaim(project, project.prodEnvironmentId, (op) =>
      seedContextPublication(project, { operationId: op }),
    );
  await c.core
    .prepare(
      "INSERT INTO product_source_archive_objects(operation_id,organization_id,project_id,environment_id,bucket_name,object_key,object_version_id,object_etag,byte_length,source_sha256,recorded_at) VALUES(?1,?2,?3,?4,'ohmyho-builds-production-eu','raw/key','exact-version','exact-etag',19,?5,?6)",
    )
    .bind(
      claim.operationId,
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      new Uint8Array(32).fill(9),
      STORED_NOW,
    )
    .run();
  const scope = {
    ...ids(project),
    environmentId: parseUlid(project.prodEnvironmentId),
    operationId: parseUlid(claim.operationId),
  };
  return { project, published, claim, scope };
}

it("reads deletion evidence and cleanup resources exactly as the real store stores them", async () => {
  const inventory = createCoreDeploymentInventory(entrypoint()),
    { project, published, claim, scope } = await publication();

  const evidence = await inventory.readDeletionEvidence(ids(project));
  expect(evidence.candidates).toHaveLength(1);
  expect(evidence.candidates[0]).toMatchObject({
    candidateReceiptId: published.candidateReceiptId,
    productDeploymentId: published.deploymentId,
    environmentId: project.prodEnvironmentId,
    operationId: claim.operationId,
    buildReused: false,
  });
  expect(evidence.candidates[0]?.artifactDigest).toEqual(new Uint8Array(32).fill(3));
  expect(evidence.activeGateways).toHaveLength(1);
  expect(evidence.activeGateways[0]).toMatchObject({
    environmentId: project.prodEnvironmentId,
    active: true,
  });

  const providerScope = {
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    operationId: claim.operationId,
  };
  const resources = await inventory.readCleanupResources(scope);
  expect(resources.sourceArchives).toEqual([
    {
      bucket: "ohmyho-builds-production-eu",
      key: "raw/key",
      versionId: "exact-version",
      eTag: "exact-etag",
      byteLength: 19,
      scope: providerScope,
      sourceSha256: "09".repeat(32),
    },
  ]);
  expect(resources.artifactExpectations).toHaveLength(1);
  expect(resources.artifactExpectations[0]).toMatchObject({
    receipt: { buildId: "exact-build", projectName: "fixture-build", scope: providerScope },
    deploymentId: published.deploymentId,
    output: {
      bucket: "ohmyho-builds-production-eu",
      key: `runs/${project.projectId}/${project.prodEnvironmentId}/${claim.operationId}/output/bundle.tar.gz`,
      versionId: "a".repeat(32),
      scope: providerScope,
    },
  });
});

it("reads the managed source inventory only while the project is being deleted", async () => {
  const inventory = createCoreDeploymentInventory(entrypoint()),
    project = await seedProject(c),
    deletion = await seedAcceptedOperation(project, project.prodEnvironmentId, {
      eventType: "ProjectDeletionRequestedV1",
      claim: false,
    }),
    input = { ...ids(project), operationId: parseUlid(deletion.operationId) };
  // Authority is the deleting project with its running cleanup run: an active project is refused.
  await expect(inventory.readManagedSourceInventory(input)).rejects.toThrow(
    "deployment_inventory_unavailable",
  );

  const connection = newUlid(),
    publicationOperation = await seedOperation(project),
    sha = "ab".repeat(32),
    micro = STORED_NOW;
  await c.core.batch([
    c.core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=? AND project_id=?",
      )
      .bind(project.organizationId, project.projectId),
    c.core
      .prepare(
        "INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at) VALUES(?,?,?,?,'ns-one','repo-one',?)",
      )
      .bind(connection, project.organizationId, project.projectId, project.billingEpochId, micro),
    c.core
      .prepare(
        "INSERT INTO managed_source_publications(operation_id,organization_id,project_id,billing_epoch_id,principal_id,source_connection_id,mode,expected_source_generation,state,message,created_at,expires_at,updated_at) VALUES(?,?,?,?,'user:fixture',?,'initialize',0,'staging','m',?,'2026-10-29T10:00:00.000000Z',?)",
      )
      .bind(
        publicationOperation,
        project.organizationId,
        project.projectId,
        project.billingEpochId,
        connection,
        micro,
        micro,
      ),
    c.core
      .prepare(
        "INSERT INTO managed_source_reservations(operation_id,path,sha256,byte_length,executable,created_at) VALUES(?,'src/main.ts',?,12,1,?)",
      )
      .bind(publicationOperation, sha, micro),
    c.core
      .prepare(
        "INSERT INTO managed_source_blobs(operation_id,path,sha256,byte_length,executable,bucket,object_key,version_id,etag,created_at) VALUES(?,'src/main.ts',?,12,1,'ohmyho-source','blobs/one',?,'etag-one',?)",
      )
      .bind(publicationOperation, sha, "c".repeat(32), micro),
  ]);
  expect(await inventory.readManagedSourceInventory(input)).toEqual({
    repos: [{ sourceConnectionId: connection, namespace: "ns-one", repositoryName: "repo-one" }],
    blobOperations: [
      {
        operationId: publicationOperation,
        blobs: [
          {
            path: "src/main.ts",
            sha256: sha,
            byteLength: 12,
            executable: true,
            bucket: "ohmyho-source",
            key: "blobs/one",
            versionId: "c".repeat(32),
            eTag: "etag-one",
          },
        ],
      },
    ],
  });
});

it("records cleanup attempts append-only, deletes schedules and reports an unknown outcome", async () => {
  const inventory = createCoreDeploymentInventory(entrypoint()),
    { project, claim } = await publication(),
    attempt = {
      cleanupAttemptId: parseUlid(newUlid()),
      ...ids(project),
      operationId: parseUlid(claim.operationId),
      provider: "cloudflare",
      resourceKind: "wfp-script",
      externalRefHash: new Uint8Array(32).fill(5),
      outcome: "removed" as const,
      attemptedAt: "2026-10-28T10:05:00.000Z",
    };
  expect(await inventory.recordCleanupAttempt(attempt)).toBe("created");
  expect(await inventory.recordCleanupAttempt(attempt)).toBe("existing");
  // A second removal that finds the resource already gone is the same append-only fact.
  expect(await inventory.recordCleanupAttempt({ ...attempt, outcome: "not_found" })).toBe(
    "existing",
  );
  await expect(
    inventory.recordCleanupAttempt({ ...attempt, outcome: "failed", errorCode: "provider_down" }),
  ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
  const failed = { ...attempt, cleanupAttemptId: parseUlid(newUlid()), outcome: "failed" as const };
  expect(await inventory.recordCleanupAttempt({ ...failed, errorCode: "provider_down" })).toBe(
    "created",
  );
  expect(
    (
      await c.core
        .prepare(
          "SELECT outcome,error_code FROM run_cleanup_attempts WHERE operation_id=? ORDER BY outcome",
        )
        .bind(claim.operationId)
        .all()
    ).results,
  ).toEqual([
    { outcome: "failed", error_code: "provider_down" },
    { outcome: "removed", error_code: null },
  ]);

  expect(await inventory.deleteSchedules(ids(project))).toBe(0);

  // The write commits and its reply is lost: the adapter reports the outcome as unknown, a replay finds it.
  const lossy = createCoreDeploymentInventory(
    entrypoint({ CONTROL_CORE: losingWriteResponses(c.core, 1) }),
  );
  const lost = { ...attempt, cleanupAttemptId: parseUlid(newUlid()), attemptedAt: NOW };
  await expect(lossy.recordCleanupAttempt(lost)).rejects.toMatchObject({
    code: "store_outcome_unknown",
  });
  expect(await inventory.recordCleanupAttempt(lost)).toBe("existing");
});

it("starts a data change once and replays it from the real store", async () => {
  const inventory = createCoreDeploymentInventory(entrypoint()),
    project = await seedProject(c),
    physical = newUlid();
  await c.core.batch([
    c.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?,?,?,?)",
      )
      .bind(project.organizationId, project.projectId, physical, STORED_NOW),
    ...[project.devEnvironmentId, project.prodEnvironmentId].map((environmentId) =>
      c.core
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at) VALUES(?,?,1,?,?,?)",
        )
        .bind(project.organizationId, environmentId, project.projectId, physical, STORED_NOW),
    ),
  ]);
  const assignments = await readCurrentDataAssignments(c.core, ids(project));
  if (assignments === null) throw new Error("fixture assignments missing");
  const snapshot = parseProjectDataChangeSnapshot({
    transition: planProjectDataChangeTransition({
      change: "isolate_prod_keeps_data",
      assignments,
      newDataEnvironmentId: parseUlid(newUlid()),
      prodDatabaseReady: true,
    }),
    environmentHeads: [
      { environmentId: project.devEnvironmentId, expectedHeadVersion: 0 },
      { environmentId: project.prodEnvironmentId, expectedHeadVersion: 0 },
    ],
    registrationGenerations: [{ dataEnvironmentId: physical, registrationVersion: 0 }],
  });
  const operationId = await seedOperation(project),
    cleanupRunId = newUlid();
  await c.core
    .prepare(
      "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?,?,?,?,'pending',1,?,?)",
    )
    .bind(
      project.organizationId,
      cleanupRunId,
      project.projectId,
      operationId,
      STORED_NOW,
      STORED_NOW,
    )
    .run();
  const accepted = await seedAcceptedOperation(project, project.devEnvironmentId, {
    eventType: "ProjectDataChangeRequestedV1",
    operationId,
    intent: {
      expected_etag: `"${"a".repeat(64)}"`,
      cleanup_run_id: cleanupRunId,
      data_change: "isolate_prod_keeps_data",
      data_change_snapshot: JSON.stringify(snapshot),
    },
  });
  const input = {
    ...ids(project),
    operationId: parseUlid(operationId),
    claimId: parseUlid(accepted.claimId),
    snapshot,
    now: NOW,
  };

  expect(await inventory.startDataChange(input)).toBe("created");
  expect(await inventory.startDataChange(input)).toBe("existing");
  expect(
    await c.core
      .prepare("SELECT state FROM cleanup_runs WHERE cleanup_run_id=?")
      .bind(cleanupRunId)
      .first(),
  ).toEqual({ state: "running" });
});

const METHODS = [
  "readWfpProjectDeletionEvidence",
  "readCandidateCleanupResources",
  "recordCleanupAttempt",
  "startProjectDataChangeCleanup",
  "appendAuditedProjectDataChangeAssignments",
  "deleteProjectFunctionSchedules",
  "readManagedSourceDeletionInventory",
  "listNextCacheRetirementScopes",
  "recordNextCacheRetired",
] as const;
/** A peer that answers one method with the given response; a faithful Control store never sends these. */
function peer(method: (typeof METHODS)[number], respond: () => Promise<unknown>) {
  return createCoreDeploymentInventory(
    Object.fromEntries(METHODS.map((name) => [name, name === method ? respond : async () => null])),
  );
}

it("rejects every response that is not exactly the Control store's protocol", async () => {
  const real = entrypoint(),
    { project, scope } = await publication(),
    evidence = (await real.readWfpProjectDeletionEvidence(ids(project))) as {
      candidates: Record<string, unknown>[];
      activeGateways: Record<string, unknown>[];
    },
    resources = (await real.readCandidateCleanupResources(scope)) as {
      sourceArchives: Record<string, unknown>[];
      artifactExpectations: Record<string, unknown>[];
    },
    foreign = newUlid();
  const withCandidate = (patch: Record<string, unknown>) => ({
    ...evidence,
    candidates: [{ ...evidence.candidates[0], ...patch }],
  });
  const withArchive = (patch: Record<string, unknown>) => ({
    ...resources,
    sourceArchives: [{ ...resources.sourceArchives[0], ...patch }],
  });
  const withExpectation = (patch: Record<string, unknown>) => ({
    ...resources,
    artifactExpectations: [{ ...resources.artifactExpectations[0], ...patch }],
  });
  const archiveScope = resources.sourceArchives[0]?.["scope"] as Record<string, unknown>;
  const expectation = resources.artifactExpectations[0] as {
    receipt: Record<string, unknown>;
    output: Record<string, unknown>;
  };
  const cases: [(typeof METHODS)[number], unknown][] = [
    ["readWfpProjectDeletionEvidence", null],
    ["readWfpProjectDeletionEvidence", [evidence]],
    ["readWfpProjectDeletionEvidence", { ...evidence, extra: true }],
    ["readWfpProjectDeletionEvidence", { ...evidence, candidates: {} }],
    ["readWfpProjectDeletionEvidence", withCandidate({ projectId: foreign })],
    ["readWfpProjectDeletionEvidence", withCandidate({ artifactId: "not-a-ulid" })],
    ["readWfpProjectDeletionEvidence", withCandidate({ namespace: 7 })],
    ["readWfpProjectDeletionEvidence", withCandidate({ buildReused: 0 })],
    ["readWfpProjectDeletionEvidence", withCandidate({ stagedAt: "2026-10-28" })],
    ["readWfpProjectDeletionEvidence", withCandidate({ artifactDigest: new Uint8Array(31) })],
    [
      "readWfpProjectDeletionEvidence",
      { ...evidence, activeGateways: [{ ...evidence.activeGateways[0], active: false }] },
    ],
    [
      "readWfpProjectDeletionEvidence",
      { ...evidence, activeGateways: [{ ...evidence.activeGateways[0], projectId: foreign }] },
    ],
    ["readCandidateCleanupResources", withArchive({ byteLength: 0 })],
    ["readCandidateCleanupResources", withArchive({ sourceSha256: "AB".repeat(32) })],
    [
      "readCandidateCleanupResources",
      withArchive({ scope: { ...archiveScope, operationId: foreign } }),
    ],
    ["readCandidateCleanupResources", withExpectation({ buildPlanSha256: "ab" })],
    ["readCandidateCleanupResources", withExpectation({ frameworkPlan: { runtime: "unknown" } })],
    [
      "readCandidateCleanupResources",
      withExpectation({
        receipt: { ...expectation.receipt, scope: { ...archiveScope, projectId: foreign } },
      }),
    ],
    [
      "readCandidateCleanupResources",
      withExpectation({ output: { ...expectation.output, extra: 1 } }),
    ],
    ["recordCleanupAttempt", "replayed"],
    ["startProjectDataChangeCleanup", undefined],
    ["appendAuditedProjectDataChangeAssignments", { result: "created" }],
    ["listNextCacheRetirementScopes", { scopes: [], nextCursor: foreign }],
    ["recordNextCacheRetired", "retired"],
    ["deleteProjectFunctionSchedules", -1],
    ["deleteProjectFunctionSchedules", 1.5],
    [
      "readManagedSourceDeletionInventory",
      { repos: [], blobOperations: [{ operationId: foreign, blobs: [{}] }] },
    ],
  ];
  for (const [method, response] of cases) {
    const port = peer(method, async () => response);
    const call: Record<(typeof METHODS)[number], () => Promise<unknown>> = {
      readWfpProjectDeletionEvidence: () => port.readDeletionEvidence(ids(project)),
      readCandidateCleanupResources: () => port.readCleanupResources(scope),
      recordCleanupAttempt: () => port.recordCleanupAttempt({} as never),
      startProjectDataChangeCleanup: () => port.startDataChange({} as never),
      appendAuditedProjectDataChangeAssignments: () => port.switchAssignments({} as never),
      deleteProjectFunctionSchedules: () => port.deleteSchedules(ids(project)),
      readManagedSourceDeletionInventory: () =>
        port.readManagedSourceInventory({ ...ids(project), operationId: scope.operationId }),
      listNextCacheRetirementScopes: () =>
        port.listNextCacheRetirementScopes({
          ...ids(project),
          operationId: scope.operationId,
          cleanupRunId: scope.operationId,
          limit: 100,
        }),
      recordNextCacheRetired: () =>
        port.recordNextCacheRetired({
          ...ids(project),
          environmentId: scope.environmentId,
          deploymentId: scope.operationId,
          operationId: scope.operationId,
          cleanupRunId: scope.operationId,
        }),
    };
    await expect(call[method](), `${method} ${JSON.stringify(response)}`).rejects.toThrow(
      /deployment_inventory_response_invalid|Invalid canonical ULID|framework plan|invalid/iu,
    );
  }

  // The transport: conflicts keep their class, an unknown outcome keeps its code, anything else is unavailable.
  const failing = (error: Error) =>
    peer("deleteProjectFunctionSchedules", async () => {
      throw error;
    }).deleteSchedules(ids(project));
  await expect(
    failing(new Error("workflow.x: DeploymentPersistenceConflictError")),
  ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
  await expect(failing(new Error("workflow.x: store_outcome_unknown"))).rejects.toMatchObject({
    code: "store_outcome_unknown",
  });
  await expect(failing(new Error("socket closed"))).rejects.toThrow(
    "deployment_inventory_unavailable",
  );

  expect(() => createCoreDeploymentInventory(null)).toThrow(
    "deployment_inventory_binding_required",
  );
  expect(() => createCoreDeploymentInventory({ readWfpProjectDeletionEvidence() {} })).toThrow(
    "deployment_inventory_binding_required",
  );
});

it("sends only the native wire fields of the write methods and copies the hash it records", async () => {
  const received: Record<string, unknown> = {},
    port = createCoreDeploymentInventory(
      Object.fromEntries(
        METHODS.map((name) => [
          name,
          async (input: unknown) => {
            received[name] = input;
            return name === "deleteProjectFunctionSchedules" ? 3 : "created";
          },
        ]),
      ),
    ),
    scope = {
      organizationId: parseUlid(newUlid()),
      projectId: parseUlid(newUlid()),
      operationId: parseUlid(newUlid()),
      claimId: parseUlid(newUlid()),
      now: NOW,
      leak: "never crosses the private RPC",
    },
    snapshot = { frozen: "plan" } as never,
    hash = new Uint8Array(32).fill(7);
  const { organizationId, projectId, operationId, claimId, now } = scope;

  await port.startDataChange({ ...scope, snapshot });
  await port.switchAssignments({ ...scope, snapshot });
  for (const method of [
    "startProjectDataChangeCleanup",
    "appendAuditedProjectDataChangeAssignments",
  ])
    expect(received[method]).toStrictEqual({
      organizationId,
      projectId,
      operationId,
      claimId,
      snapshot,
      now,
    });

  await port.recordCleanupAttempt({
    ...scope,
    cleanupAttemptId: parseUlid(newUlid()),
    provider: "cloudflare",
    resourceKind: "wfp-script",
    externalRefHash: hash,
    outcome: "removed",
    attemptedAt: NOW,
  });
  const sent = received["recordCleanupAttempt"] as Record<string, unknown>;
  expect(Object.keys(sent).sort()).toEqual([
    "attemptedAt",
    "cleanupAttemptId",
    "externalRefHash",
    "operationId",
    "organizationId",
    "outcome",
    "projectId",
    "provider",
    "resourceKind",
  ]);
  expect(sent["externalRefHash"]).toEqual(hash);
  expect(sent["externalRefHash"]).not.toBe(hash);

  expect(await port.deleteSchedules({ organizationId, projectId })).toBe(3);
  expect(received["deleteProjectFunctionSchedules"]).toStrictEqual({ organizationId, projectId });
});
