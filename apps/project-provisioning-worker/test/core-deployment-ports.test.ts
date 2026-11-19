import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import {
  DeploymentPersistenceConflictError,
  SourceArchiveReconciliationConflictError,
} from "@ohmyhost/database/provisioning-persistence";
import { parseProductCommandMessageV1, type ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import { parseUlid } from "@ohmyhost/platform";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { DeploymentWorkflowRuntime } from "../../control-store/src/worker-main.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import {
  seedAcceptedOperation,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  seedProject,
  type SeededProject,
} from "../../control-store/test/support/platform-fixtures.js";
import { seedWfpPublication } from "../../control-store/test/support/provider-fixtures.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import { createCoreDeploymentAttemptPort } from "../src/core-deployment-attempt.js";
import { createCoreDeploymentAuthorizationPort } from "../src/core-deployment-authorization.js";
import { createCoreDeploymentCandidatePort } from "../src/core-deployment-candidate.js";
import { createCoreDeploymentCleanupPort } from "../src/core-deployment-cleanup.js";
import { createCoreDeploymentFinalizationPort } from "../src/core-deployment-finalization.js";
import { createCoreDeploymentHandlePort } from "../src/core-deployment-handle.js";
import { createCoreDeploymentLifecyclePort } from "../src/core-deployment-lifecycle.js";
import { createCoreDeploymentReaderPort } from "../src/core-deployment-reader.js";
import { createCoreDeploymentReconciliationPort } from "../src/core-deployment-reconciliation.js";
import { createCoreDeploymentRollbackDataPort } from "../src/core-deployment-rollback-data.js";
import { createCoreDeploymentSourcePort } from "../src/core-deployment-source.js";
import type { FullDeploymentRuntimeBinding } from "../src/core-deployment-workflow.js";

const STAMP = "2026-10-28T10:00:00.000000Z";
const now = () => new Date("2026-10-28T12:00:00.000Z");
let c: TestControl;
let binding: FullDeploymentRuntimeBinding;
beforeEach(async () => {
  c = await createTestControl();
  binding = new DeploymentWorkflowRuntime({} as never, c.bindings) as never;
}, 60_000);
afterEach(async () => c.dispose());

type Scope = Pick<
  SeededProject,
  "organizationId" | "projectId" | "billingEpochId" | "shard" | "devEnvironmentId"
>;
function command<T extends ProductCommandMessageV1["eventType"]>(
  scope: Scope,
  accepted: { eventId: string; operationId: string },
  eventType: T,
  extra: object = {},
) {
  const message = parseProductCommandMessageV1({
    version: 1,
    eventType,
    eventId: accepted.eventId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    billingEpochId: scope.billingEpochId,
    environmentId: scope.devEnvironmentId,
    operationId: accepted.operationId,
    ...extra,
  });
  if (message.eventType !== eventType) throw new Error("fixture command differs");
  return message as Extract<ProductCommandMessageV1, { eventType: T }>;
}
/** An accepted operation of the project whose outbox event the dispatcher already acknowledged. */
async function accepted(
  scope: Scope,
  eventType: "ProjectHandleChangeRequestedV1" | "ProjectDeletionRequestedV1",
) {
  const operation = await seedAcceptedOperation(scope, scope.devEnvironmentId, {
    eventType,
    claim: false,
  });
  await c.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(operation.eventId, STAMP)
    .run();
  return operation;
}
/** A project created by the store itself, with its operation finished, so a handle change can run alone. */
async function storeProject(): Promise<Scope> {
  const store = createControlStore(c.bindings),
    organizationId = await seedOrganization(store, 2, 0),
    p = projectInput(organizationId, `ports-${newUlid().toLowerCase()}`);
  p.outbox.eventType = "ProjectProvisioningRequested";
  p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
  await store.projects.createInitialProject(p);
  await store.provisioning.completeHello({
    organizationId,
    projectId: p.projectId,
    operationId: p.operation.operationId,
    requestEventId: p.outbox.eventId,
    workflowId: `project-provisioning-v1-${p.outbox.eventId}-${p.operation.operationId}`,
    serviceActorId: "project-provisioning-worker",
    started: {
      eventId: newUlid(),
      auditEventId: newUlid(),
      occurredAt: "2026-10-28T10:00:01.000Z",
    },
    succeeded: {
      eventId: newUlid(),
      auditEventId: newUlid(),
      occurredAt: "2026-10-28T10:00:01.001Z",
    },
  });
  return {
    organizationId,
    projectId: p.projectId,
    billingEpochId: p.billingEpochId,
    devEnvironmentId: p.developmentEnvironmentId,
    shard: c.core,
  };
}
const deploymentCommand = (r: Awaited<ReturnType<typeof workflowFixture>>) =>
  parseProductCommandMessageV1({
    version: 1,
    eventType: "DeploymentRequestedV1",
    eventId: r.input.eventId,
    organizationId: r.p.organizationId,
    projectId: r.p.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    billingEpochId: r.p.billingEpochId,
    planId: r.plan,
  });
const ULID_A = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const ULID_B = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");

type Call = (input: unknown) => Promise<unknown>;
/** Every method answers `answer`, or fails with `failure`; each call is recorded by method name. */
function peer(answer: unknown, failure?: Error) {
  const calls: [string, unknown][] = [];
  const stub = new Proxy(
    {},
    {
      get: (_target, name) => async (input: unknown) => {
        calls.push([String(name), input]);
        if (failure !== undefined) throw failure;
        return answer;
      },
    },
  );
  return { calls, binding: stub as FullDeploymentRuntimeBinding };
}

it("forwards each named binding method unchanged and rebuilds only the original domain refusals", async () => {
  const ports = [
    [
      createCoreDeploymentAttemptPort,
      "activateReconciliation",
      "activateProductProviderReconciliationAttempt",
    ],
    [createCoreDeploymentAttemptPort, "activateReplay", "activateProductWorkflowReplayAttempt"],
    [
      createCoreDeploymentAuthorizationPort,
      "assertExecution",
      "assertProductOperationExecution",
      { organizationId: ULID_A, projectId: ULID_B, operationId: ULID_A },
    ],
    [
      createCoreDeploymentAuthorizationPort,
      "authorizeActivation",
      "authorizeProductActivation",
      {
        organizationId: ULID_A,
        projectId: ULID_B,
        operationId: ULID_A,
        candidateReceiptId: ULID_B,
      },
    ],
    [createCoreDeploymentCleanupPort, "prepare", "prepareProductCandidateCleanup"],
    [createCoreDeploymentCleanupPort, "claim", "claimProductCandidateCleanup"],
    [createCoreDeploymentCleanupPort, "record", "recordProductCandidateCleanup"],
    [createCoreDeploymentCleanupPort, "supersede", "markProductCandidateSuperseded"],
    [createCoreDeploymentSourcePort, "recordArchive", "recordProductSourceArchiveEvidence"],
    [createCoreDeploymentSourcePort, "observeArchive", "observeSourceArchiveReceipt"],
    [createCoreDeploymentCandidatePort, "recordCandidate", "recordProductDeploymentCandidate"],
    [
      createCoreDeploymentCandidatePort,
      "recordAbandonedGateway",
      "recordAbandonedGatewayPredecessor",
    ],
    [
      createCoreDeploymentFinalizationPort,
      "assertBindingRefresh",
      "assertProductBindingRefresh",
      {
        organizationId: ULID_A,
        projectId: ULID_B,
        environmentId: ULID_A,
        operationId: ULID_B,
        snapshot: { sourceDeploymentId: ULID_A },
        allowPublished: true,
      },
    ],
    [createCoreDeploymentReaderPort, "readDatabaseTarget", "readProductWorkflowDatabaseTarget"],
    [createCoreDeploymentReaderPort, "claimProviderMutation", "claimProductProviderMutation"],
  ] as unknown as [
    (binding: FullDeploymentRuntimeBinding) => Record<string, Call>,
    string,
    string,
    unknown?,
  ][];
  const serialized = (name: string, message: string) => Object.assign(new Error(message), { name });
  for (const [create, method, bindingMethod, exact] of ports) {
    const input = exact ?? { marker: bindingMethod };
    const answered = peer("answer");
    expect(await create(answered.binding)[method]?.(input), method).toBe("answer");
    expect(answered.calls, method).toEqual([[bindingMethod, input]]);
    // A lost reply is uncertainty: it passes through unchanged and never becomes a domain refusal.
    const lost = new Error("RPC reply lost");
    await expect(create(peer(null, lost).binding)[method]?.(input), method).rejects.toBe(lost);
    // A refusal arrives by name across the binding and is rebuilt as the original class with its message.
    const refused = await create(
      peer(null, serialized("DeploymentPersistenceConflictError", "stale")).binding,
    )
      [method]?.(input)
      .catch((error: unknown) => error);
    expect(refused, method).toBeInstanceOf(DeploymentPersistenceConflictError);
    expect(refused, method).toMatchObject({ message: "stale" });
    const archive = await create(
      peer(null, serialized("SourceArchiveReconciliationConflictError", "x")).binding,
    )
      [method]?.(input)
      .catch((error: unknown) => error);
    expect(archive, method).toBeInstanceOf(SourceArchiveReconciliationConflictError);
  }
}, 60_000);

it("authorizes execution and activation on the real Core and refuses stale attempts and candidates", async () => {
  const r = await workflowFixture(c),
    scope = {
      organizationId: parseUlid(r.p.organizationId),
      projectId: parseUlid(r.p.projectId),
      operationId: parseUlid(r.input.operationId),
    },
    authorization = createCoreDeploymentAuthorizationPort(binding);
  await expect(authorization.assertExecution(scope)).resolves.toBeUndefined();
  await expect(authorization.authorizeActivation(scope)).resolves.toEqual({ allowed: true });
  await expect(
    authorization.authorizeActivation({ ...scope, candidateReceiptId: ULID_A }),
  ).rejects.toThrow(DeploymentPersistenceConflictError);

  const attempts = createCoreDeploymentAttemptPort(binding),
    attempt = {
      attemptId: ULID_A,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: parseUlid(r.input.environmentId),
      operationId: scope.operationId,
      eventId: parseUlid(r.input.eventId),
    };
  await expect(
    attempts.activateReconciliation({
      ...attempt,
      physicalWorkflowId: `product-provider-reconcile-v1-${ULID_A}`,
      eventType: "DeploymentRequestedV1",
    }),
  ).rejects.toThrow(DeploymentPersistenceConflictError);
  await expect(
    attempts.activateReplay({
      ...attempt,
      physicalWorkflowId: `product-command-replay-v1-${ULID_A}`,
    }),
  ).rejects.toThrow(DeploymentPersistenceConflictError);
  // Not a domain refusal: the store's own validation error arrives as it is.
  await expect(
    attempts.activateReplay({ ...attempt, physicalWorkflowId: "elsewhere" }),
  ).rejects.toThrow(/execution identity is invalid/u);

  // No cleanup was requested, so there is nothing to claim.
  const cleanup = createCoreDeploymentCleanupPort(binding);
  await expect(
    cleanup.claim({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      claimId: ULID_B,
      claimedAt: "2026-10-28T12:00:00.000Z",
      leaseExpiresAt: "2026-10-28T12:05:00.000Z",
    }),
  ).resolves.toBeNull();
}, 60_000);

it("authorizes the whole parsed command of a deployment on the real Core", async () => {
  const r = await workflowFixture(c),
    cmd = deploymentCommand(r),
    authorization = createCoreDeploymentAuthorizationPort(binding);
  await expect(authorization.assertExecution(cmd)).resolves.toBeUndefined();
  await expect(authorization.authorizeActivation(cmd)).resolves.toEqual({ allowed: true });
  await expect(
    authorization.authorizeActivation({ ...cmd, candidateReceiptId: ULID_A }),
  ).rejects.toThrow(DeploymentPersistenceConflictError);
}, 60_000);

it("refuses a binding refresh of a whole command only by the Core proof, never by its schema", async () => {
  const r = await workflowFixture(c),
    snapshot = {
      sourceDeploymentId: parseUlid(newUlid()),
      sourceRevisionId: parseUlid(newUlid()),
      sourceCandidateReceiptId: parseUlid(newUlid()),
      sourceArtifactId: parseUlid(newUlid()),
      sourcePlanId: parseUlid(newUlid()),
      sourceBuildExecutionId: parseUlid(newUlid()),
      sourceArtifactSha256: "ab".repeat(32),
      sourceNamespace: "ohmyho-development",
      sourceScriptName: `p-${newUlid().toLowerCase()}-dev-${newUlid().toLowerCase()}`,
      sourceProviderTag: "cd".repeat(16),
      expectedHeadVersion: 1,
      expectedGatewayRevision: 1,
      dataEnvironmentId: parseUlid(newUlid()),
      assignmentVersion: 1,
      registrationVersion: 1,
    };
  await expect(
    createCoreDeploymentFinalizationPort(binding).assertBindingRefresh({
      ...deploymentCommand(r),
      snapshot,
      allowPublished: true,
    }),
  ).rejects.toThrow("Binding refresh snapshot is absent");
}, 60_000);

it("sends exactly the closed keys of the Core to execution, activation and refresh", async () => {
  const r = await workflowFixture(c),
    cmd = deploymentCommand(r),
    ids = {
      organizationId: cmd.organizationId,
      projectId: cmd.projectId,
      operationId: cmd.operationId,
    },
    snapshot = { sourceDeploymentId: ULID_A },
    recorder = peer("ok");
  await createCoreDeploymentAuthorizationPort(recorder.binding).assertExecution(cmd);
  await createCoreDeploymentAuthorizationPort(recorder.binding).authorizeActivation(cmd);
  await createCoreDeploymentAuthorizationPort(recorder.binding).authorizeActivation({
    ...cmd,
    candidateReceiptId: ULID_A,
  });
  await createCoreDeploymentFinalizationPort(recorder.binding).assertBindingRefresh({
    ...cmd,
    snapshot: snapshot as never,
    allowPublished: true,
  });
  expect(recorder.calls).toEqual([
    ["assertProductOperationExecution", ids],
    ["authorizeProductActivation", ids],
    ["authorizeProductActivation", { ...ids, candidateReceiptId: ULID_A }],
    [
      "assertProductBindingRefresh",
      {
        organizationId: cmd.organizationId,
        projectId: cmd.projectId,
        environmentId: cmd.environmentId,
        operationId: cmd.operationId,
        snapshot,
        allowPublished: true,
      },
    ],
  ]);
  expect("candidateReceiptId" in (recorder.calls[1]?.[1] as object)).toBe(false);
}, 60_000);

it("reconciles a provider uncertainty once, replays it, and refuses an attempt that is not active", async () => {
  const port = createCoreDeploymentReconciliationPort(
      binding,
      createCoreDeploymentReaderPort(binding),
      now,
    ),
    hint = {
      phase: "build" as const,
      expectedArtifactDigest: null,
      currentProviderTag: null,
      currentProductDeploymentId: null,
    };
  const r = await workflowFixture(c),
    workflowId = r.input.logicalWorkflowId,
    input = {
      workflowId,
      executionId: workflowId,
      command: deploymentCommand(r),
      providerHint: hint,
    };
  await expect(port.requireReconciliation(input)).resolves.toBe("applied");
  expect(
    await c.core
      .prepare("SELECT state,reconciliation_code FROM product_workflow_runs WHERE workflow_id=?")
      .bind(workflowId)
      .first(),
  ).toEqual({
    state: "reconciliation_required",
    reconciliation_code: "PROVIDER_OBSERVATION_UNCERTAIN",
  });
  await expect(port.requireReconciliation(input)).resolves.toBe("duplicate");

  const other = await workflowFixture(c),
    otherId = other.input.logicalWorkflowId,
    otherCommand = deploymentCommand(other);
  // A recovery attempt that the run has not activated is refused with the original domain error.
  await expect(
    port.requireReconciliation({
      workflowId: otherId,
      executionId: `product-provider-reconcile-v1-${ULID_A}`,
      command: otherCommand,
      providerHint: hint,
    }),
  ).rejects.toThrow(DeploymentPersistenceConflictError);
  // Outdated candidate bindings record their one diagnostic together with the reconciliation.
  await expect(
    port.requireReconciliation({
      workflowId: otherId,
      executionId: otherId,
      command: otherCommand,
      providerHint: { ...hint, phase: "wfp", reason: "candidate_bindings_outdated" },
    }),
  ).resolves.toBe("applied");
  expect(
    await c.core
      .prepare("SELECT count(*) n FROM deployment_diagnostics WHERE code='WFP_CANDIDATE_OUTDATED'")
      .first(),
  ).toEqual({ n: 1 });
}, 60_000);

it("reads rollback candidates, data targets and data environments with native byte digests", async () => {
  const r = await workflowFixture(c),
    p = r.p,
    scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      devEnvironmentId: p.developmentEnvironmentId,
      billingEpochId: p.billingEpochId,
      shard: c.core,
    },
    published = await seedWfpPublication(
      { ...scope, prodEnvironmentId: p.productionEnvironmentId, handle: p.projectHandle },
      { operationId: await seedOperation(scope), environmentId: p.developmentEnvironmentId },
    ),
    organizationId = parseUlid(p.organizationId),
    projectId = parseUlid(p.projectId),
    environmentId = parseUlid(p.developmentEnvironmentId),
    candidates = createCoreDeploymentCandidatePort(binding);

  await expect(
    candidates.readDataEnvironment({ organizationId, projectId, environmentId }),
  ).resolves.toBe(p.developmentDataEnvironmentId);
  await expect(
    candidates.readDataEnvironment({ organizationId, projectId, environmentId: ULID_A }),
  ).resolves.toBeNull();

  const target = {
      targetDeploymentId: parseUlid(published.deploymentId),
      targetRevisionId: parseUlid(published.revisionId),
    },
    resolved = await candidates.resolveRollback({
      organizationId,
      projectId,
      environmentId,
      ...target,
    });
  expect(resolved?.candidate.candidateReceiptId).toBe(published.candidateReceiptId);
  expect(Buffer.isBuffer(resolved?.candidate.artifactDigest)).toBe(true);
  expect(resolved?.candidate.artifactDigest).toEqual(Buffer.alloc(32, 3));
  await expect(
    candidates.resolveRollback({
      organizationId,
      projectId,
      environmentId,
      targetDeploymentId: ULID_A,
      targetRevisionId: ULID_B,
    }),
  ).resolves.toBeNull();

  const rollbackData = createCoreDeploymentRollbackDataPort(binding),
    data = await rollbackData.readRollbackDataTarget({
      organizationId,
      projectId,
      environmentId,
      deploymentId: target.targetDeploymentId,
      revisionId: target.targetRevisionId,
    });
  expect(data).toMatchObject({
    deploymentId: published.deploymentId,
    revisionId: published.revisionId,
    dataEnvironmentId: p.developmentDataEnvironmentId,
    dataChanged: false,
    dataChangeInProgress: false,
  });
  expect(Buffer.isBuffer(data?.artifactDigest)).toBe(true);
  await expect(
    rollbackData.readRollbackDataTarget({
      organizationId,
      projectId,
      environmentId,
      deploymentId: ULID_A,
    }),
  ).resolves.toBeNull();
}, 60_000);

it("stores a new project handle once, replays it, and completes a lifecycle refusal once", async () => {
  const scope = await storeProject(),
    port = createCoreDeploymentHandlePort(binding, now),
    handleChange = await accepted(scope, "ProjectHandleChangeRequestedV1"),
    cmd = command(scope, handleChange, "ProjectHandleChangeRequestedV1", {
      requestedHandle: "renamed-handle",
    }),
    input = {
      workflowId: handleChange.workflowId,
      executionId: handleChange.workflowId,
      command: cmd,
      moved: [],
      evidence: {},
    };
  await expect(port.finalizeHandleChange(input)).resolves.toBe("applied");
  expect(
    await c.core
      .prepare("SELECT handle FROM projects WHERE project_id=?")
      .bind(scope.projectId)
      .first(),
  ).toEqual({ handle: "renamed-handle" });
  await expect(port.finalizeHandleChange(input)).resolves.toBe("duplicate");
  // The same address for another project is the customer-visible refusal, returned as data and not thrown.
  const other = await storeProject(),
    taken = await accepted(other, "ProjectHandleChangeRequestedV1");
  await expect(
    port.finalizeHandleChange({
      workflowId: taken.workflowId,
      executionId: taken.workflowId,
      command: command(other, taken, "ProjectHandleChangeRequestedV1", {
        requestedHandle: "renamed-handle",
      }),
      moved: [],
      evidence: {},
    } as never),
  ).resolves.toEqual({ status: "conflict", reason: "taken" });

  const lifecycle = createCoreDeploymentLifecyclePort(
      binding,
      createCoreDeploymentReaderPort(binding),
      now,
    ),
    refusal = await accepted(other, "ProjectHandleChangeRequestedV1"),
    refused = command(other, refusal, "ProjectHandleChangeRequestedV1", {
      requestedHandle: "renamed-handle",
    });
  const refusalInput = {
    workflowId: refusal.workflowId,
    executionId: refusal.workflowId,
    command: refused,
    evidence: {},
  };
  await expect(lifecycle.complete(refusalInput)).resolves.toBe("applied");
  await expect(lifecycle.complete(refusalInput)).resolves.toBe("duplicate");
  // A run that completed differently is a domain refusal, rebuilt from its name.
  await expect(lifecycle.complete({ ...input, evidence: {} } as never)).rejects.toThrow(
    DeploymentPersistenceConflictError,
  );
}, 60_000);

it("completes a project deletion with its tombstone and gateway absence and refuses invalid evidence", async () => {
  const project = await seedProject(c),
    deletion = await accepted(project, "ProjectDeletionRequestedV1"),
    cmd = command(project, deletion, "ProjectDeletionRequestedV1"),
    readers = createCoreDeploymentReaderPort(binding),
    lifecycle = createCoreDeploymentLifecyclePort(binding, readers, now);
  await c.core
    .prepare(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(project.organizationId, project.projectId)
    .run();
  const hash = new Uint8Array(32).fill(7);
  await c.core
    .prepare(
      "INSERT INTO run_resource_inventory(organization_id, resource_record_id, project_id, operation_id, provider, resource_kind, external_ref_hash, recorded_at, cleanup_locator) VALUES (?1, ?2, ?3, ?4, 'pgcf', 'database', ?5, ?6, 'locator')",
    )
    .bind(project.organizationId, newUlid(), project.projectId, deletion.operationId, hash, STAMP)
    .run();
  const base = { workflowId: deletion.workflowId, executionId: deletion.workflowId, command: cmd },
    evidence = {
      tombstoneReceiptId: "tombstone-1",
      inventoryClean: true,
      consecutive404s: 3,
      gatewayAbsence: [null, null],
    };

  await expect(
    lifecycle.retainDeletionTombstone({ ...base, tombstoneReceiptId: "tombstone-1" }),
  ).resolves.toBe("applied");
  const full = await readers.readContext({
    organizationId: cmd.organizationId,
    projectId: cmd.projectId,
    environmentId: cmd.environmentId,
    operationId: cmd.operationId,
  });
  if (full === null) throw new Error("The deletion must have a persisted context");
  const prod = full.deletionEnvironments.find(
    (environment) => environment.environmentName === "prod",
  );
  if (!prod) throw new Error("The deletion fixture must have Prod");
  const completeProd = vi.fn(async () => "completed" as const),
    prodLifecycle = createCoreDeploymentLifecyclePort(
      { completeProductLifecycleCommand: completeProd, retainProductDeletionTombstone: vi.fn() },
      {
        readContext: async () => ({
          ...full,
          environmentName: "prod",
          deletionEnvironments: [prod],
        }),
      },
      now,
    ),
    prodInput = { ...base, command: { ...cmd, environmentId: prod.environmentId } };
  await expect(
    prodLifecycle.complete({ ...prodInput, evidence: { ...evidence, gatewayAbsence: [null] } }),
  ).resolves.toBe("applied");
  expect(completeProd).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: prod.environmentId,
      expectedEnvironmentHeads: [
        { environmentId: prod.environmentId, expectedHeadVersion: prod.headVersion },
      ],
      deletion: expect.objectContaining({ gatewayAbsence: [null] }),
    }),
  );
  await expect(prodLifecycle.complete({ ...prodInput, evidence })).rejects.toThrow(
    "Deletion evidence is invalid",
  );
  expect(completeProd).toHaveBeenCalledTimes(1);
  // Dev-only, noncanonical or duplicate environments never manufacture missing Prod/Dev evidence.
  const partial = createCoreDeploymentLifecyclePort(
    binding,
    {
      ...readers,
      readContext: async (scope) => {
        const full = await readers.readContext(scope);
        return full === null
          ? null
          : { ...full, deletionEnvironments: full.deletionEnvironments.slice(0, 1) };
      },
    },
    now,
  );
  await expect(partial.complete({ ...base, evidence })).rejects.toThrow(
    "Deletion Workflow requires unique dev environments followed by prod",
  );
  for (const environments of [
    [],
    [prod, prod],
    [...full.deletionEnvironments].reverse(),
    full.deletionEnvironments.map((environment) =>
      environment.environmentName === "dev"
        ? { ...environment, environmentName: "retired-dev-unproven" }
        : environment,
    ) as never,
    full.deletionEnvironments.map((environment) => ({
      ...environment,
      environmentId: prod.environmentId,
    })),
  ]) {
    const malformed = createCoreDeploymentLifecyclePort(
      { completeProductLifecycleCommand: completeProd, retainProductDeletionTombstone: vi.fn() },
      { readContext: async () => ({ ...full, deletionEnvironments: environments }) },
      now,
    );
    await expect(malformed.complete({ ...base, evidence })).rejects.toThrow(
      "Deletion Workflow requires unique dev environments followed by prod",
    );
  }
  expect(completeProd).toHaveBeenCalledTimes(1);
  const dev = full.deletionEnvironments.find(
    (environment) => environment.environmentName === "dev",
  );
  if (!dev) throw new Error("The historical deletion fixture must have Dev");
  // The trusted Core can additionally return an archived Dev ID whose role is backed by restoration history.
  const historicalDev = { ...dev, environmentId: parseUlid(newUlid()), headVersion: 2 },
    historicalEnvironments = [historicalDev, dev, prod],
    completeHistorical = vi.fn(async () => "completed" as const),
    historicalLifecycle = createCoreDeploymentLifecyclePort(
      {
        completeProductLifecycleCommand: completeHistorical,
        retainProductDeletionTombstone: vi.fn(),
      },
      { readContext: async () => ({ ...full, deletionEnvironments: historicalEnvironments }) },
      now,
    );
  await expect(
    historicalLifecycle.complete({
      ...prodInput,
      evidence: { ...evidence, gatewayAbsence: [null, null, null] },
    }),
  ).resolves.toBe("applied");
  expect(completeHistorical).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedEnvironmentHeads: historicalEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        expectedHeadVersion: environment.headVersion,
      })),
      deletion: expect.objectContaining({ gatewayAbsence: [null, null, null] }),
    }),
  );
  // Evidence that is not exactly the original shape never reaches the store.
  for (const invalid of [
    { ...evidence, tombstoneReceiptId: 1 },
    { ...evidence, inventoryClean: false },
    { ...evidence, consecutive404s: 2 },
    { ...evidence, gatewayAbsence: [null] },
    { ...evidence, gatewayAbsence: "none" },
  ])
    await expect(lifecycle.complete({ ...base, evidence: invalid })).rejects.toThrow(
      "Deletion evidence is invalid",
    );
  // An absence receipt of another address is refused before the store sees it.
  const receipt = {
    provider: "ohmyhost-shared-gateway",
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    environmentName: "dev",
    handle: "another-handle",
    hostname: "dev-another-handle.check.omh.st",
    publicOrigin: "https://dev-another-handle.check.omh.st",
    targetDeploymentId: ULID_A,
    targetScriptName: `p-${project.projectId.toLowerCase()}-dev-${ULID_A.toLowerCase()}`,
    targetArtifactDigest: `sha256:${"03".repeat(32)}`,
    targetProviderTag: "tag",
    egressPolicyDigest: `sha256:${"04".repeat(32)}`,
    egressAllowedOrigins: [],
    candidateReceiptId: ULID_B,
    revision: 2,
    predecessorRevision: 1,
    operationId: deletion.operationId,
    active: false,
    observedAt: "2026-10-28T10:00:00.000Z",
  };
  await expect(
    lifecycle.complete({ ...base, evidence: { ...evidence, gatewayAbsence: [receipt, null] } }),
  ).rejects.toThrow("Shared gateway absence receipt is invalid");
  // The inventory is not cleaned yet: the store refuses and its busy error is not a domain refusal.
  await expect(lifecycle.complete({ ...base, evidence })).rejects.toThrow(/lost the race/u);
  await c.core
    .prepare(
      "INSERT INTO run_cleanup_attempts(organization_id, cleanup_attempt_id, project_id, operation_id, provider, resource_kind, external_ref_hash, outcome, attempted_at) VALUES (?1, ?2, ?3, ?4, 'pgcf', 'database', ?5, 'not_found', ?6)",
    )
    .bind(project.organizationId, newUlid(), project.projectId, deletion.operationId, hash, STAMP)
    .run();
  const absent = {
    ...receipt,
    handle: project.handle,
    hostname: `dev-${project.handle}.check.omh.st`,
    publicOrigin: `https://dev-${project.handle}.check.omh.st`,
  };
  await expect(
    lifecycle.complete({ ...base, evidence: { ...evidence, gatewayAbsence: [absent, null] } }),
  ).resolves.toBe("applied");
  expect(
    await c.core
      .prepare("SELECT lifecycle_state FROM projects WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ lifecycle_state: "deleted" });
}, 60_000);

it("sends the finalization groups with their exact wire keys and requires the original Workflow identity", async () => {
  const identity = {
    workflowId: "product-command-v1-deploy-fixture",
    outboxEventId: ULID_A,
    startedOperationEventId: ULID_B,
    operationEventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    auditEventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    acceptedLifecycleVersion: 3,
  };
  const scope = {
    organizationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1"),
    environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB2"),
    operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB3"),
  };
  const schedule = {
    crons: ["0 * * * *"],
    egressAllowedOrigins: ["https://api.example.test"],
    extra: "never sent",
  };
  const policy = { healthCheckPath: "/health", egressAllowedOrigins: [] };
  const wire = {
    ...identity,
    runtimePolicy: policy,
  };
  const { calls, binding: recorder } = peer("completed");
  const port = createCoreDeploymentFinalizationPort(recorder);

  await port.finishBindingRefresh({
    ...scope,
    ...identity,
    completedAt: "2026-10-28T12:00:00.000Z",
    terminalEvidence: { runtimePolicy: policy },
    finalizedWfpResult: { deployment: "result" },
    replayAttemptId: ULID_A,
  } as never);
  await port.finalizeCandidate({
    eventType: "DeploymentRequestedV1",
    bindingRefreshSnapshot: null,
    publication: { publication: "group" },
    schedule,
    completion: {
      ...identity,
      eventType: "DeploymentRequestedV1",
      terminalEvidence: { runtimePolicy: policy },
      finalizedWfpResult: { deployment: "result" },
      reconciliationAttemptId: ULID_B,
    },
  } as never);
  await port.finalizeCandidate({
    eventType: "DeploymentPromotionRequestedV1",
    bindingRefreshSnapshot: null,
    publication: { publication: "group" },
    schedule,
    completion: {
      ...identity,
      eventType: "DeploymentPromotionRequestedV1",
      finalizedWfpResult: { ignored: true },
    },
  } as never);
  await port.finalizeCandidate({
    eventType: "DeploymentRequestedV1",
    bindingRefreshSnapshot: { refresh: "snapshot" },
    publication: { publication: "group" },
    schedule,
    completion: null,
  } as never);
  await port.finalizeRollback({
    activation: { activation: "group" },
    schedule,
    completion: { ...identity, terminalEvidence: { runtimePolicy: policy } },
  } as never);

  const sent = { crons: schedule.crons, egressAllowedOrigins: schedule.egressAllowedOrigins };
  expect(calls).toEqual([
    [
      "finishProductBindingRefresh",
      {
        ...scope,
        completedAt: "2026-10-28T12:00:00.000Z",
        completion: { ...wire, replayAttemptId: ULID_A, result: { deployment: "result" } },
      },
    ],
    [
      "finalizeProductCandidate",
      {
        eventType: "DeploymentRequestedV1",
        bindingRefreshSnapshot: null,
        publication: { publication: "group" },
        schedule: sent,
        completion: { ...wire, reconciliationAttemptId: ULID_B, result: { deployment: "result" } },
      },
    ],
    [
      "finalizeProductCandidate",
      {
        eventType: "DeploymentPromotionRequestedV1",
        bindingRefreshSnapshot: null,
        publication: { publication: "group" },
        schedule: sent,
        completion: { ...identity, runtimePolicy: undefined, result: null },
      },
    ],
    [
      "finalizeProductCandidate",
      {
        eventType: "DeploymentRequestedV1",
        bindingRefreshSnapshot: { refresh: "snapshot" },
        publication: { publication: "group" },
        schedule: sent,
        completion: null,
      },
    ],
    [
      "finalizeProductRollback",
      { activation: { activation: "group" }, schedule: sent, completion: wire },
    ],
  ]);
  // A completion without the Workflow identity of the original execution is never sent.
  await expect(
    port.finalizeRollback({
      activation: {},
      schedule,
      completion: { ...identity, workflowId: undefined },
    } as never),
  ).rejects.toThrow("requires its original Workflow identity");
  expect(calls).toHaveLength(5);
}, 60_000);
