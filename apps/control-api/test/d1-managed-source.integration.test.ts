import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ManagedSourceConflictError,
  ManagedSourceInitializationError,
  ManagedSourceReservationError,
} from "@ohmyhost/database";
import { createUlidFactory, parseUlid, SystemEntropy } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { digest, projectInput } from "../../control-store/test/support/seed.js";
import { ManagedSourceSurfaceError } from "../src/managed-source-surface.js";
import {
  createD1ManagedSourceStore,
  isD1ManagedSourceRuntime,
  managedSourceCoreCall,
} from "../src/d1-managed-source-store.js";
import { createD1ManagedSourceProcessor } from "../src/d1-managed-source-processor.js";

// The Worker host binds env through its constructor; the private class runs unchanged over the real Core.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, environment: unknown) {
      this.env = environment;
    }
  },
}));

const NOW = "2026-10-29T13:14:15.123Z";
const LATER = "2026-10-29T15:14:15.123Z";
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const ulid = () => parseUlid(newUlid());
const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const ids = () => createUlidFactory({ clock: clockAt(NOW), entropy: new SystemEntropy() });
const namespaces = { us: "omh-production-us", eu: "omh-production-eu" };

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

let seq = 0;
/**
 * A project admitted through the real admission command with a managed `empty` template whose provisioning finished:
 * the parent operation succeeded and the recipe is queued, which is the state the initialization consumer starts from.
 */
async function managedProject() {
  seq += 1;
  const organizationId = newUlid(),
    userId = `user_managed${seq}`,
    principalId = `user:${userId}`,
    sourceConnectionId = newUlid();
  await store.identity.applyOrganizationSnapshot({
    organizationId,
    workosOrganizationId: `org_managed${seq}`,
    state: "active",
    snapshotDigest: digest(seq),
    snapshotFetchedAt: "2026-10-28T12:00:00.000Z",
    synchronizedAt: "2026-10-28T12:00:00.000Z",
    triggerEventId: `evt_managed${seq}`,
    auditEventId: newUlid(),
    memberships: [
      { workosUserId: userId, role: "admin", status: "active", digest: digest(50 + seq) },
    ],
  });
  await control.core
    .prepare(
      "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(organizationId)
    .run();
  const project = projectInput(organizationId, `managed-${seq}`);
  await store.projects.admitCustomerProject({
    platform: "production",
    operationCreatedAt: project.createdAt,
    request: {
      requestId: `req-managed-${seq}`,
      idempotencyKey: `key-managed-${seq}`,
      canonicalRequestDigest: digest(10 + seq),
    },
    project: {
      ...project,
      principalId,
      projectHandleVersion: "human-id-4.2.0-sha256-project-handle-words-v1",
      developmentDataEnvironmentId: project.developmentEnvironmentId,
      productionDataEnvironmentId: project.developmentEnvironmentId,
      outbox: { ...project.outbox, eventType: "ProjectProvisioningRequested" },
    },
    source: { template: "empty", sourceConnectionId, initializationEventId: newUlid() },
  });
  const stored = "2026-10-29T13:00:00.000000Z";
  await control.core.batch([
    control.core
      .prepare("UPDATE operations SET state='succeeded',updated_at=?2 WHERE operation_id=?1")
      .bind(project.operation.operationId, stored),
    control.core
      .prepare(
        "UPDATE managed_source_initializations SET state='queued',updated_at=?2 WHERE parent_operation_id=?1",
      )
      .bind(project.operation.operationId, stored),
  ]);
  return {
    organizationId: parseUlid(organizationId),
    projectId: parseUlid(project.projectId),
    environmentId: parseUlid(project.developmentEnvironmentId),
    principalId,
    userId,
    parentOperationId: parseUlid(project.operation.operationId),
    sourceConnectionId: parseUlid(sourceConnectionId),
  };
}
type Managed = Awaited<ReturnType<typeof managedProject>>;
const scopeOf = (p: Managed) => ({
  organizationId: p.organizationId,
  projectId: p.projectId,
  principalId: p.principalId,
  requestId: "req-managed",
});
const revoke = (p: Managed) =>
  control.core
    .prepare("UPDATE organization_memberships SET state='revoked' WHERE organization_id=?")
    .bind(p.organizationId)
    .run();

function beginInput(
  p: Managed,
  mode: "initialize" | "commit",
  fill: number,
  repository: { namespace: string; repositoryName: string } = {
    namespace: namespaces.eu,
    repositoryName: `repo-${fill}`,
  },
  at = NOW,
) {
  return {
    ...scopeOf(p),
    environmentId: p.environmentId,
    operationId: ulid(),
    operationEventId: ulid(),
    auditEventId: ulid(),
    outboxEventId: ulid(),
    requestId: `req-source-${fill}`,
    idempotencyKey: `source-${fill}`,
    canonicalRequestDigest: new Uint8Array(32).fill(fill),
    mode,
    sourceConnectionId: p.sourceConnectionId,
    expectedSourceConnectionId: mode === "initialize" ? null : p.sourceConnectionId,
    expectedSourceGeneration: mode === "initialize" ? 0 : 1,
    expectedManagedCommit: mode === "initialize" ? null : COMMIT,
    ...repository,
    message: "Publish the exact controlled fixture",
    now: at,
    expiresAt: new Date(Date.parse(at) + 3_600_000).toISOString(),
  } as const;
}

/** The provider boundary of the managed Git service: an in-memory repository that records which methods were reached. */
function memoryProvider() {
  let head: string | null = null;
  const calls: string[] = [];
  return {
    calls,
    managedGit: async (method: string, input: unknown) => {
      calls.push(method);
      const value = input as {
        input?: { expectedCommitSha: string | null };
        prepared?: { commitSha: string };
      };
      if (method === "head") return head;
      if (method === "prepare")
        return {
          commitSha: COMMIT,
          treeSha: TREE,
          parentSha: value.input?.expectedCommitSha ?? null,
          providerState: null,
        };
      if (method === "push") head = value.prepared?.commitSha ?? null;
      return undefined;
    },
    managedBlob: async () => {
      throw new Error("the empty template stages no files");
    },
  };
}
const never = (): never => {
  throw new Error("the fixture expected a source binding");
};
const noDelegation = {
  ensureConnectionProof: async () => {
    throw new Error("a recipe without creation consent never touches delegations");
  },
  attachCreatedProject: async () => {
    throw new Error("a recipe without creation consent never touches delegations");
  },
  findGrant: async () => {
    throw new Error("a recipe without creation consent never touches delegations");
  },
};

describe("D1 managed source store over the real Core", () => {
  it("serves the original journal operations: scope, begin and replay, upload receipts, seal, commit, binding, failure and revocation", async () => {
    const p = await managedProject(),
      adapter = createD1ManagedSourceStore({ runtime: store.managedSource, clock: clockAt(NOW) });
    expect(isD1ManagedSourceRuntime(store.managedSource)).toBe(true);
    expect(() => createD1ManagedSourceStore({ runtime: {} as never, clock: clockAt(NOW) })).toThrow(
      "managed_source_core_binding_required",
    );

    expect(await adapter.projectScope(scopeOf(p))).toEqual({
      environmentId: p.environmentId,
      region: "eu",
    });
    expect(await adapter.binding(scopeOf(p))).toBeNull();
    expect(await adapter.pendingInitialization(scopeOf(p))).toMatchObject({
      parentOperationId: p.parentOperationId,
      sourceConnectionId: p.sourceConnectionId,
      template: "empty",
      state: "queued",
      childOperationId: null,
    });

    const first = beginInput(p, "initialize", 7),
      begun = await adapter.begin(first);
    expect(begun).toMatchObject({
      operationId: first.operationId,
      mode: "initialize",
      state: "staging",
      namespace: namespaces.eu,
      files: [],
      blobs: [],
    });
    expect(await adapter.begin(first)).toEqual(begun);
    const publication = { ...scopeOf(p), operationId: first.operationId },
      write = { ...publication, now: NOW },
      file = {
        path: "README.md",
        sha256: createHash("sha256").update("managed").digest("hex"),
        byteLength: 7,
        executable: false,
      };
    const request = {
      ...write,
      httpMethod: "PUT" as const,
      routeTemplate: "/v1/projects/{project_id}/source/uploads",
      idempotencyKey: "managed-blob-request",
      canonicalRequestDigest: new Uint8Array(32).fill(82),
      requestId: "req-blob",
    };
    expect(await adapter.recordRequest(request)).toBe("created");
    expect(await adapter.recordRequest(request)).toBe("replayed");
    expect(await adapter.reserveBlob({ ...write, ...file })).toBe("created");
    expect(await adapter.reserveBlob({ ...write, ...file })).toBe("replayed");
    await adapter.recordBlob({
      ...write,
      ...file,
      bucket: "ohmyho-builds-production-eu",
      key: `managed-staging/${first.operationId}/${p.organizationId}/${p.projectId}/${file.sha256}`,
      versionId: "b".repeat(32),
      eTag: `"${"c".repeat(32)}"`,
    });
    expect((await adapter.publication(publication))?.blobs).toMatchObject([
      { path: "README.md", sha256: file.sha256, byteLength: 7 },
    ]);
    await adapter.seal({
      ...write,
      files: [file],
      manifestSha256: createHash("sha256")
        .update(JSON.stringify([file]))
        .digest("hex"),
    });
    await adapter.prepared({ ...write, commitSha: COMMIT, parentSha: null, treeSha: TREE });
    await adapter.authorizePublication(publication);
    expect(await adapter.publication(publication)).toMatchObject({
      state: "sealed",
      commitSha: COMMIT,
      treeSha: TREE,
    });
    const completion = { ...write, commitSha: COMMIT, treeSha: TREE, eventId: ulid() };
    const bound = await adapter.complete(completion);
    expect(bound).toMatchObject({
      provider: "managed",
      sourceConnectionId: p.sourceConnectionId,
      generation: 1,
      commitSha: COMMIT,
      status: "ready",
    });
    expect(await adapter.complete({ ...completion, eventId: ulid() })).toEqual(bound);
    expect(await adapter.binding(scopeOf(p))).toEqual(bound);
    expect(await adapter.operation(publication)).toMatchObject({
      status: 202,
      body: { id: first.operationId },
    });

    // A second snapshot of the committed source that the owner abandons ends as a failed, replayable operation.
    const second = beginInput(p, "commit", 8, bound);
    await adapter.begin(second);
    await adapter.fail({
      ...scopeOf(p),
      operationId: second.operationId,
      errorCode: "SOURCE_FIXTURE_REJECTED",
      eventId: ulid(),
      now: NOW,
    });
    expect(
      await adapter.operation({ ...scopeOf(p), operationId: second.operationId }),
    ).toMatchObject({ body: { id: second.operationId, state: "failed" } });

    // Once the owner is no longer an active member every read names the closed scope refusal.
    await revoke(p);
    await expect(adapter.binding(scopeOf(p))).rejects.toMatchObject({
      name: "ManagedSourceConflictError",
      kind: "scope",
    });
    // The RPC peer's scope refusal for an unknown project is the same 404 the customer API serves.
    await expect(
      adapter.operation({ ...scopeOf(p), operationId: ulid(), projectId: ulid() }),
    ).rejects.toBeInstanceOf(ManagedSourceConflictError);
  });

  it("refuses a Core answer that belongs to another scope and keeps closed refusal codes through an RPC error", async () => {
    const p = await managedProject(),
      foreign = await managedProject(),
      adapter = createD1ManagedSourceStore({
        runtime: {
          ...store.managedSource,
          readApiManagedSourceInitialization: () =>
            store.managedSource.readApiManagedSourceInitialization({
              organizationId: foreign.organizationId,
              projectId: foreign.projectId,
              principalId: foreign.principalId,
            }),
          readApiManagedSourcePublication: async (input: unknown) => {
            const own = (await store.managedSource.readApiManagedSourcePublication(input)) as {
              operationId: string;
            } | null;
            return own === null ? null : { ...own, operationId: ulid() };
          },
        },
        clock: clockAt(NOW),
      });
    await expect(adapter.pendingInitialization(scopeOf(p))).rejects.toThrow(
      "managed_source_core_scope_invalid",
    );
    const own = beginInput(p, "initialize", 9);
    await createD1ManagedSourceStore({
      runtime: store.managedSource,
      clock: clockAt(NOW),
    }).begin(own);
    await expect(
      adapter.publication({ ...scopeOf(p), operationId: own.operationId }),
    ).rejects.toThrow("managed_source_core_scope_invalid");

    const rpc = (code: string) => () =>
      managedSourceCoreCall(async () => {
        throw Object.assign(new Error("Remote error"), { code });
      });
    await expect(rpc("source_scope_unavailable")()).rejects.toBeInstanceOf(
      ManagedSourceSurfaceError,
    );
    await expect(rpc("managed_source_commit")()).rejects.toMatchObject({
      name: "ManagedSourceConflictError",
      kind: "commit",
    });
    await expect(
      managedSourceCoreCall(async () => {
        throw new Error("Managed source expired conflict");
      }),
    ).rejects.toMatchObject({ kind: "expired" });
    await expect(rpc("managed_source_reservation_limit")()).rejects.toBeInstanceOf(
      ManagedSourceReservationError,
    );
    await expect(rpc("managed_source_initialization_state")()).rejects.toBeInstanceOf(
      ManagedSourceInitializationError,
    );
    await expect(rpc("unrelated")()).rejects.toThrow("Remote error");
  });
});

describe("D1 managed source processor over the real Core", () => {
  const processorFor = (clockIso: string, provider = memoryProvider()) => ({
    provider,
    processor: createD1ManagedSourceProcessor({
      runtime: store.managedSource,
      clock: clockAt(clockIso),
      ids: ids(),
      binding: provider,
      namespaces,
      wake: async () => undefined,
      delegations: noDelegation,
    }),
  });

  it("initializes the template once, publishes the sealed snapshot, then rejects expired and unauthorized work durably", async () => {
    const p = await managedProject(),
      parent = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: p.parentOperationId,
      },
      { processor, provider } = processorFor(NOW);
    expect(() =>
      createD1ManagedSourceProcessor({
        runtime: {} as never,
        clock: clockAt(NOW),
        ids: ids(),
        binding: provider,
        namespaces,
        wake: async () => undefined,
        delegations: noDelegation,
      }),
    ).toThrow("managed_source_processor_core_binding_required");

    // The recipe is authorized, the child publication is sealed and attached, and the push is still outstanding.
    const started = await processor.initialize(parent);
    expect(started).toMatchObject({ state: "pending" });
    const childOperationId = (started as { childOperationId: string }).childOperationId;
    expect(await processor.initialize(parent)).toEqual({ state: "pending", childOperationId });
    expect(provider.calls).toEqual([]);

    // The consumer pushes once and the recipe becomes initialized; replays change nothing.
    const child = { ...parent, operationId: childOperationId };
    expect(await processor.process(child)).toEqual({ state: "committed" });
    expect(provider.calls).toEqual(["ensureRepository", "head", "prepare", "push", "head"]);
    expect(await processor.process(child)).toEqual({ state: "committed" });
    expect(await processor.initialize(parent)).toEqual({ state: "initialized", childOperationId });
    expect(
      await control.core
        .prepare(
          "SELECT state,child_operation_id FROM managed_source_initializations WHERE parent_operation_id=?",
        )
        .bind(p.parentOperationId)
        .first(),
    ).toEqual({ state: "initialized", child_operation_id: childOperationId });

    // A staging upload that outlived its deadline fails durably instead of waiting forever.
    const adapter = createD1ManagedSourceStore({
        runtime: store.managedSource,
        clock: clockAt(NOW),
      }),
      repository = (await adapter.binding(scopeOf(p))) ?? never(),
      expired = beginInput(p, "commit", 21, repository);
    await adapter.begin(expired);
    const late = processorFor(LATER).processor;
    expect(await late.process({ ...parent, operationId: expired.operationId })).toEqual({
      state: "failed",
    });
    expect(
      await control.core
        .prepare("SELECT state,error_code FROM managed_source_publications WHERE operation_id=?")
        .bind(expired.operationId)
        .first(),
    ).toEqual({ state: "failed", error_code: "SOURCE_UPLOAD_EXPIRED" });
    const stillStaging = beginInput(p, "commit", 22, repository);
    await adapter.begin(stillStaging);
    expect(await processor.process({ ...parent, operationId: stillStaging.operationId })).toEqual({
      state: "staging",
    });

    // Losing the edit grant mid-flight ends the publication with the authorization code, once.
    await revoke(p);
    expect(await processor.process({ ...parent, operationId: stillStaging.operationId })).toEqual({
      state: "failed",
    });
    expect(
      await control.core
        .prepare("SELECT state,error_code FROM managed_source_publications WHERE operation_id=?")
        .bind(stillStaging.operationId)
        .first(),
    ).toEqual({ state: "failed", error_code: "AUTHORIZATION_CHANGED" });
    await expect(processor.process({ ...parent, operationId: newUlid() })).rejects.toThrow(
      "Managed source operation is unavailable",
    );
  });

  it("runs the Worker's processor service over the Core and wakes the publisher through its RPC binding", async () => {
    const p = await managedProject(),
      parent = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: p.parentOperationId,
      },
      provider = memoryProvider(),
      entry = await import("../../control-store/src/worker-main.js"),
      { ManagedSourceProcessor } = await import("../src/worker-main.js");
    let wakes = 0;
    const publisher = {
        // A copy bound to another receiver would not reach the publisher: the binding needs its own `this`.
        wake: async function (this: unknown) {
          if (this !== publisher) throw new Error("wake needs the publisher binding");
          wakes += 1;
        },
      },
      service = new ManagedSourceProcessor(
        {} as never,
        {
          MANAGED_SOURCE_RUNTIME: store.managedSource,
          CONTROL_RUNTIME: new (entry.ControlRuntime as unknown as new (
            context: unknown,
            environment: unknown,
          ) => object)({}, control.bindings),
          MANAGED_ARTIFACTS_NAMESPACE_US: namespaces.us,
          MANAGED_ARTIFACTS_NAMESPACE_EU: namespaces.eu,
          SOURCE_INSPECTOR: provider,
          OPERATION_PUBLISHER: publisher,
        } as never,
      );

    const started = (await service.initialize(parent)) as {
      state: string;
      childOperationId: string;
    };
    expect(started.state).toBe("pending");
    expect(wakes).toBe(1);
    expect(await service.process({ ...parent, operationId: started.childOperationId })).toEqual({
      state: "committed",
    });
    expect(provider.calls).toEqual(["ensureRepository", "head", "prepare", "push", "head"]);
    expect(await service.initialize(parent)).toEqual({
      state: "initialized",
      childOperationId: started.childOperationId,
    });
  });

  it("fails the recipe of a creator whose authorization changed before initialization started", async () => {
    const p = await managedProject(),
      parent = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: p.parentOperationId,
      },
      { processor } = processorFor(NOW);
    await revoke(p);
    expect(await processor.initialize(parent)).toEqual({ state: "failed" });
    expect(
      await control.core
        .prepare(
          "SELECT state,error_code FROM managed_source_initializations WHERE parent_operation_id=?",
        )
        .bind(p.parentOperationId)
        .first(),
    ).toEqual({ state: "failed", error_code: "AUTHORIZATION_CHANGED" });
    expect(await processor.initialize(parent)).toEqual({ state: "failed" });
    await expect(
      processor.initialize({ ...parent, operationId: parseUlid(newUlid()) }),
    ).rejects.toThrow("Managed source initialization is unavailable");
  });
});
