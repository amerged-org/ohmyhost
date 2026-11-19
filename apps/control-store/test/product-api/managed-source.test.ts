import { createHash } from "node:crypto";

import { MANAGED_SOURCE_LIMITS } from "@ohmyhost/contracts/managed-sources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import {
  managedAuthorized,
  readManagedSnapshot,
} from "../../src/catalog/product-api/managed-source-common.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  MANAGED_PRINCIPAL,
  MANAGED_USER,
  seedManagedSourceProject,
} from "../support/managed-source-fixture.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";
import type { Store } from "../support/seed.js";

const NOW = "2026-10-29T10:00:00.000Z",
  LATER = "2026-10-29T10:05:00.000Z",
  EXPIRES = "2026-10-29T11:00:00.000Z",
  AFTER_EXPIRY = "2026-10-29T12:00:00.000Z",
  BUCKET = "ohmyho-builds-development-eu";
const hash = (value: string) => createHash("sha256").update(value).digest("hex"),
  commitA = "a".repeat(40),
  commitB = "b".repeat(40),
  treeA = "d".repeat(40),
  treeB = "e".repeat(40);

let control: TestControl;
let store: Store;
let ms: Store["managedSource"];
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
  ms = store.managedSource;
});
afterAll(async () => control.dispose());

type Project = Awaited<ReturnType<typeof seedManagedSourceProject>>;

async function rows(sql: string, ...binds: unknown[]) {
  return (
    await control.core
      .prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;
}

/** The begin request of one publication; `n` varies the idempotency key and request digest. */
function begin(p: Project, n: number, overrides: Record<string, unknown> = {}) {
  return {
    ...p.scope,
    environmentId: p.devEnvironmentId,
    operationId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    outboxEventId: newUlid(),
    requestId: `managed-${n}`,
    idempotencyKey: `managed-${n}`,
    canonicalRequestDigest: new Uint8Array(32).fill(n),
    mode: "initialize",
    sourceConnectionId: p.sourceConnectionId,
    expectedSourceConnectionId: null,
    expectedSourceGeneration: 0,
    expectedManagedCommit: null,
    namespace: "omh-development-eu",
    repositoryName: `managed-${p.projectId.toLowerCase()}`,
    message: "Publish the managed source",
    now: NOW,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

const file = (path: string, content: string, executable = false) => ({
  path,
  sha256: hash(content),
  byteLength: content.length,
  executable,
});
const publicationOf = (b: { operationId: string }, p: Project) => ({
  ...p.scope,
  operationId: b.operationId,
});
const receiptOf = (p: Project, operationId: string, f: ReturnType<typeof file>) => ({
  ...f,
  bucket: BUCKET,
  key: `managed-staging/${operationId}/${p.organizationId}/${p.projectId}/${f.sha256}`,
  versionId: "b".repeat(32),
  eTag: `"${"c".repeat(32)}"`,
});
const manifestOf = (files: ReturnType<typeof file>[]) => ({
  files,
  manifestSha256: hash(
    JSON.stringify(
      [...files]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => ({
          path: f.path,
          sha256: f.sha256,
          byteLength: f.byteLength,
          executable: f.executable,
        })),
    ),
  ),
});
const kind = (name: string) => expect.objectContaining({ message: name });

/** Reserves and records every file of a staging publication, the order the upload route follows. */
async function upload(p: Project, operationId: string, files: ReturnType<typeof file>[]) {
  const write = { ...p.scope, operationId, now: NOW };
  for (const f of files) {
    await ms.reserveApiManagedSourceBlob({ ...write, ...f });
    await ms.recordApiManagedSourceBlob({ ...write, ...receiptOf(p, operationId, f) });
  }
}

describe("managed source journal", () => {
  let first: Project;
  let initialize: ReturnType<typeof begin>;
  const readme = file("README.md", "managed"),
    index = file("src/index.ts", "export {};", true);

  it("initializes a managed repository through the journal, the blobs and the processor handoff", async () => {
    const p = (first = await seedManagedSourceProject(control, { delegated: true }));

    // the creation recipe and the project scope are readable before any publication exists
    expect(await ms.readApiManagedSourceProjectScope(p.scope)).toEqual({
      environmentId: p.devEnvironmentId,
      region: "eu",
    });
    expect(await ms.readApiProjectSourceBinding(p.scope)).toBeNull();
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      parentOperationId: p.parentOperationId,
      sourceConnectionId: p.sourceConnectionId,
      template: "empty",
      region: "eu",
      state: "queued",
      childOperationId: null,
      creationDelegation: p.creation,
      errorCode: null,
    });
    expect(await ms.readProcessorManagedSourceInitialization(p.parent)).toMatchObject({
      state: "queued",
    });
    expect(
      await ms.readProcessorManagedSourceInitialization({
        ...p.parent,
        parentOperationId: newUlid(),
      }),
    ).toBeNull();
    expect(await ms.authorizeProcessorManagedSourceInitialization(p.parent)).toMatchObject({
      state: "queued",
      principalId: MANAGED_PRINCIPAL,
    });

    // begin: ONE batch accepts the operation, the repository custody and the journal; the same key replays
    if (!p.publication) throw new Error("Publication fixture missing");
    const bounded = {
      ...p.publication,
      authorizationRestriction: {
        actions: ["sources:link"],
        organizationIds: [p.organizationId],
        projectIds: [p.projectId],
      },
    };
    await expect(
      ms.beginApiManagedSourcePublication(
        begin(p, 99, { delegation: { ...bounded, authorizationRestriction: { actions: [] } } }),
      ),
    ).rejects.toEqual(kind("managed_source_scope"));
    initialize = begin(p, 1, { delegation: bounded });
    const publication = publicationOf(initialize, p);
    const started = await ms.beginApiManagedSourcePublication(initialize);
    expect(started).toMatchObject({
      operationId: initialize.operationId,
      mode: "initialize",
      state: "staging",
      files: [],
      blobs: [],
      commitSha: null,
      delegation: bounded,
    });
    expect(await ms.beginApiManagedSourcePublication(initialize)).toEqual(started);
    await expect(
      ms.beginApiManagedSourcePublication({
        ...initialize,
        operationId: newUlid(),
        canonicalRequestDigest: new Uint8Array(32).fill(99),
      }),
    ).rejects.toEqual(kind("managed_source_idempotency"));
    expect(
      await rows("SELECT state FROM operations WHERE operation_id=?", initialize.operationId),
    ).toEqual([{ state: "running" }]);
    expect(
      await rows(
        "SELECT event_type,available_at FROM outbox_events WHERE operation_id=?",
        initialize.operationId,
      ),
    ).toEqual([
      {
        event_type: "ManagedSourcePublicationRequestedV1",
        available_at: "2026-10-29T11:00:00.000000Z",
      },
    ]);
    expect(await ms.readApiManagedSourcePublication(publication)).toEqual(started);
    expect(await ms.readApiManagedSourceOperation(publication)).toMatchObject({
      operationId: initialize.operationId,
      state: "running",
    });

    // request receipts retain the original operation and exact digest
    const receipt = {
      ...publication,
      now: NOW,
      httpMethod: "PUT",
      routeTemplate: "/v1/projects/{project_id}/source/uploads",
      idempotencyKey: "blob-upload-1",
      canonicalRequestDigest: new Uint8Array(32).fill(82),
      requestId: "managed-blob",
    };
    expect(await ms.recordApiManagedSourceRequest(receipt)).toBe("created");
    expect(await ms.recordApiManagedSourceRequest(receipt)).toBe("replayed");
    await expect(
      ms.recordApiManagedSourceRequest({
        ...receipt,
        canonicalRequestDigest: new Uint8Array(32).fill(83),
      }),
    ).rejects.toEqual(kind("managed_source_idempotency"));

    // admission precedes any object write: reservations are idempotent and immutable
    const write = { ...publication, now: NOW };
    expect(await ms.reserveApiManagedSourceBlob({ ...write, ...readme })).toBe("created");
    expect(await ms.reserveApiManagedSourceBlob({ ...write, ...readme })).toBe("replayed");
    await expect(
      ms.reserveApiManagedSourceBlob({ ...write, ...readme, executable: true }),
    ).rejects.toEqual(kind("managed_source_reservation_identity"));
    await expect(
      ms.reserveApiManagedSourceBlob({ ...write, ...index, now: AFTER_EXPIRY }),
    ).rejects.toEqual(kind("managed_source_reservation_expired"));
    await expect(
      ms.reserveApiManagedSourceBlob({
        ...write,
        ...index,
        principalId: "user:user_stranger",
      }),
    ).rejects.toEqual(kind("managed_source_reservation_scope"));

    // an object receipt must be the exact staged key, bucket region and version
    const receiptFor = (f: typeof readme) => ({
      ...write,
      ...receiptOf(p, initialize.operationId, f),
    });
    await expect(
      ms.recordApiManagedSourceBlob({ ...receiptFor(readme), bucket: "other-bucket" }),
    ).rejects.toThrow("Managed source object receipt is invalid");
    await expect(
      ms.recordApiManagedSourceBlob({ ...receiptFor(readme), bucket: "ohmyho-builds-development" }),
    ).rejects.toEqual(kind("managed_source_scope"));
    await ms.recordApiManagedSourceBlob(receiptFor(readme));
    await ms.recordApiManagedSourceBlob(receiptFor(readme));
    await expect(
      ms.recordApiManagedSourceBlob({ ...receiptFor(readme), versionId: "f".repeat(32) }),
    ).rejects.toEqual(kind("managed_source_manifest"));
    expect(await ms.reserveApiManagedSourceBlob({ ...write, ...index })).toBe("created");
    await ms.recordApiManagedSourceBlob(receiptFor(index));
    expect(
      await rows(
        "SELECT path,bucket,executable FROM managed_source_blobs WHERE operation_id=? ORDER BY path",
        initialize.operationId,
      ),
    ).toEqual([
      { path: "README.md", bucket: BUCKET, executable: 0 },
      { path: "src/index.ts", bucket: BUCKET, executable: 1 },
    ]);

    // seal: the canonical manifest must equal the recorded blob set; the original wake becomes due now
    const files = [index, readme],
      manifest = manifestOf(files);
    await expect(
      ms.sealApiManagedSourceManifest({ ...write, ...manifestOf([readme]) }),
    ).rejects.toEqual(kind("managed_source_manifest"));
    await expect(
      ms.sealApiManagedSourceManifest({ ...write, ...manifest, manifestSha256: hash("other") }),
    ).rejects.toEqual(kind("managed_source_manifest"));
    await expect(
      ms.sealApiManagedSourceManifest({ ...write, ...manifestOf([readme, readme]) }),
    ).rejects.toEqual(kind("managed_source_manifest"));
    await ms.sealApiManagedSourceManifest({ ...write, ...manifest });
    await ms.sealApiManagedSourceManifest({ ...write, ...manifest });
    expect(
      await rows(
        "SELECT state,manifest_sha256 FROM managed_source_publications WHERE operation_id=?",
        initialize.operationId,
      ),
    ).toEqual([{ state: "sealed", manifest_sha256: manifest.manifestSha256 }]);
    expect(
      await rows(
        "SELECT available_at FROM outbox_events WHERE operation_id=?",
        initialize.operationId,
      ),
    ).toEqual([{ available_at: "2026-10-29T10:00:00.000000Z" }]);
    await expect(ms.reserveApiManagedSourceBlob({ ...write, ...index })).rejects.toEqual(
      kind("managed_source_reservation_state"),
    );
    expect(await ms.readApiManagedSourcePublication(publication)).toMatchObject({
      state: "sealed",
      manifestDigest: manifest.manifestSha256,
      files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
      blobs: [expect.objectContaining({ path: "README.md", bucket: BUCKET }), expect.anything()],
    });

    // the prepared Git candidate is fixed once; another candidate is refused
    const prepared = { ...write, commitSha: commitA, parentSha: null, treeSha: treeA };
    await ms.recordApiManagedSourcePreparedCommit(prepared);
    await ms.recordApiManagedSourcePreparedCommit(prepared);
    await expect(
      ms.recordApiManagedSourcePreparedCommit({ ...prepared, treeSha: treeB }),
    ).rejects.toEqual(kind("managed_source_candidate"));
    await expect(
      ms.recordApiManagedSourcePreparedCommit({ ...prepared, parentSha: commitB }),
    ).rejects.toEqual(kind("managed_source_candidate"));
    await ms.authorizeApiManagedSourcePublication(write);
    await expect(
      ms.authorizeApiManagedSourcePublication({ ...write, now: AFTER_EXPIRY }),
    ).rejects.toEqual(kind("managed_source_expired"));

    // the processor attaches the sealed child to the creation recipe; a foreign child is refused
    const child = { ...p.parent, childOperationId: initialize.operationId, now: NOW };
    await ms.attachProcessorManagedSourceInitializationChild(child);
    await ms.attachProcessorManagedSourceInitializationChild(child);
    await expect(
      ms.attachProcessorManagedSourceInitializationChild({
        ...child,
        childOperationId: newUlid(),
      }),
    ).rejects.toEqual(kind("managed_source_initialization_identity"));
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      state: "initializing",
      childOperationId: initialize.operationId,
    });

    // complete: the selected source, history, audit and recipe change in one batch; a second observation replays
    const done = { ...write, commitSha: commitA, treeSha: treeA, eventId: newUlid() };
    const binding = await ms.completeApiManagedSourcePublication(done);
    expect(binding).toMatchObject({
      provider: "managed",
      sourceConnectionId: p.sourceConnectionId,
      generation: 1,
      commitSha: commitA,
      namespace: "omh-development-eu",
      status: "ready",
    });
    expect(
      await ms.completeApiManagedSourcePublication({ ...done, eventId: newUlid() }),
    ).toMatchObject({ generation: 1, commitSha: commitA, status: "ready" });
    await expect(
      ms.completeApiManagedSourcePublication({ ...done, eventId: newUlid(), treeSha: treeB }),
    ).rejects.toEqual(kind("managed_source_candidate"));
    expect(await ms.readApiProjectSourceBinding(p.scope)).toEqual(binding);
    expect(
      await rows(
        "SELECT state,failure FROM operations WHERE operation_id=?",
        initialize.operationId,
      ),
    ).toEqual([{ state: "succeeded", failure: null }]);
    expect(
      await rows(
        "SELECT event_type FROM audit_events WHERE operation_id=?",
        initialize.operationId,
      ),
    ).toContainEqual({ event_type: "ManagedSourcePublished" });
    expect(
      await rows(
        "SELECT generation,commit_sha FROM project_source_bindings WHERE project_id=?",
        p.projectId,
      ),
    ).toEqual([{ generation: 1, commit_sha: commitA }]);
    expect(
      await rows(
        "SELECT provider,state,revision FROM project_sources WHERE project_id=?",
        p.projectId,
      ),
    ).toEqual([{ provider: "managed", state: "ready", revision: 1 }]);
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      state: "initialized",
      childOperationId: initialize.operationId,
    });
    await ms.completeProcessorManagedSourceInitializationChild({
      organizationId: p.organizationId,
      projectId: p.projectId,
      childOperationId: initialize.operationId,
      now: LATER,
    });
    expect(
      await ms.readProcessorManagedSourceContext({
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: initialize.operationId,
      }),
    ).toEqual({
      principalId: MANAGED_PRINCIPAL,
      sourceState: "committed",
      operationState: "succeeded",
    });
    expect(
      await ms.readProcessorManagedSourceContext({
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: newUlid(),
      }),
    ).toBeNull();
  }, 60_000);

  it("carries the original project creation authority into only its matching template initialization", async () => {
    const p = await seedManagedSourceProject(control, { delegated: true });
    if (!p.publication) throw new Error("Publication fixture missing");
    const delegated = { ...p.publication, action: "projects:create" as const };
    const request = begin(p, 98, { delegation: delegated });
    await expect(
      ms.beginApiManagedSourcePublication({ ...request, sourceConnectionId: newUlid() }),
    ).rejects.toEqual(kind("managed_source_scope"));
    await expect(
      ms.beginApiManagedSourcePublication({
        ...request,
        delegation: { ...delegated, authorizationRestriction: { actions: [] } },
      }),
    ).rejects.toEqual(kind("managed_source_scope"));
    const accepted = await ms.beginApiManagedSourcePublication(request);
    expect(accepted.delegation).toEqual(delegated);
    await ms.reserveApiManagedSourceBlob({
      ...p.scope,
      operationId: request.operationId,
      now: NOW,
      ...file("init.txt", "template"),
    });
  });

  it("commits a further version and refuses a stale journal, a busy project and a lost source scope", async () => {
    const p = first,
      commit = begin(p, 2, {
        mode: "commit",
        expectedSourceConnectionId: p.sourceConnectionId,
        expectedSourceGeneration: 1,
        expectedManagedCommit: commitA,
        message: "Second version",
      }),
      publication = publicationOf(commit, p),
      write = { ...publication, now: NOW };
    await expect(
      ms.beginApiManagedSourcePublication({ ...commit, expectedManagedCommit: commitB }),
    ).rejects.toEqual(kind("managed_source_commit"));
    await expect(
      ms.beginApiManagedSourcePublication({ ...commit, expectedSourceGeneration: 7 }),
    ).rejects.toEqual(kind("managed_source_generation"));
    await expect(
      ms.beginApiManagedSourcePublication({
        ...commit,
        mode: "initialize",
        expectedSourceGeneration: 0,
        expectedSourceConnectionId: null,
        expectedManagedCommit: null,
      }),
    ).rejects.toEqual(kind("managed_source_generation"));
    await expect(
      ms.beginApiManagedSourcePublication({ ...commit, expiresAt: NOW }),
    ).rejects.toThrow("Managed source publication input is invalid");

    const started = await ms.beginApiManagedSourcePublication(commit);
    expect(started).toMatchObject({
      mode: "commit",
      state: "staging",
      expectedManagedCommit: commitA,
    });
    // a commit does not create a repository; the first source connection stays the only one
    expect(
      await rows(
        "SELECT count(*) n FROM managed_source_repositories WHERE project_id=?",
        p.projectId,
      ),
    ).toEqual([{ n: 1 }]);
    // a switch or initialize publication is refused while this journal is open
    await expect(
      ms.beginApiManagedSourcePublication(
        begin(p, 3, {
          mode: "switch",
          sourceConnectionId: newUlid(),
          expectedSourceConnectionId: p.sourceConnectionId,
          expectedSourceGeneration: 1,
        }),
      ),
    ).rejects.toEqual(kind("managed_source_operation"));

    // the byte budget of a journal is reserved up front
    const wide = Array.from({ length: 4 }, (_, n) => ({
      path: `blob-${n}.bin`,
      sha256: hash(`wide-${n}`),
      byteLength: MANAGED_SOURCE_LIMITS.fileBytes,
      executable: false,
    }));
    for (const f of wide)
      expect(await ms.reserveApiManagedSourceBlob({ ...write, ...f })).toBe("created");
    await expect(
      ms.reserveApiManagedSourceBlob({ ...write, ...file("one-more.txt", "x") }),
    ).rejects.toEqual(kind("managed_source_reservation_limit"));
    await expect(
      ms.recordApiManagedSourceBlob({
        ...write,
        ...receiptOf(p, commit.operationId, wide[0] as (typeof wide)[number]),
        key: "managed-staging/elsewhere",
      }),
    ).rejects.toThrow("Managed source object receipt is invalid");
    await expect(
      ms.sealApiManagedSourceManifest({ ...write, ...manifestOf(wide) }),
    ).rejects.toEqual(kind("managed_source_manifest"));

    // a failure is durable and terminal: the journal, the operation and its history agree, and it replays
    const fail = { ...write, errorCode: "SOURCE_FIXTURE_REJECTED", eventId: newUlid() };
    await ms.failApiManagedSourcePublication(fail);
    await ms.failApiManagedSourcePublication({ ...fail, eventId: newUlid() });
    await expect(
      ms.failApiManagedSourcePublication({
        ...fail,
        errorCode: "OTHER_REJECTION",
        eventId: newUlid(),
      }),
    ).rejects.toEqual(kind("managed_source_state"));
    expect(
      await rows(
        "SELECT state,json_extract(failure,'$.code') code FROM operations WHERE operation_id=?",
        commit.operationId,
      ),
    ).toEqual([{ state: "failed", code: "SOURCE_FIXTURE_REJECTED" }]);
    expect(await ms.readApiManagedSourceOperation(publication)).toMatchObject({
      state: "failed",
      failure: { code: "SOURCE_FIXTURE_REJECTED" },
    });
    expect(await ms.readApiManagedSourcePublication(publication)).toMatchObject({
      state: "failed",
      errorCode: "SOURCE_FIXTURE_REJECTED",
    });
    await expect(ms.sealApiManagedSourceManifest({ ...write, ...manifestOf([]) })).rejects.toEqual(
      kind("managed_source_state"),
    );
  }, 60_000);

  it("commits the observed Git head of a managed commit and keeps the generation", async () => {
    const p = first,
      files = [file("package.json", "{}")],
      commit = begin(p, 4, {
        mode: "commit",
        expectedSourceConnectionId: p.sourceConnectionId,
        expectedSourceGeneration: 1,
        expectedManagedCommit: commitA,
        message: "Third version",
        delegation: p.publication,
      }),
      write = { ...publicationOf(commit, p), now: NOW };
    await ms.beginApiManagedSourcePublication(commit);
    await upload(p, commit.operationId, files);
    await ms.sealApiManagedSourceManifest({ ...write, ...manifestOf(files) });
    await ms.recordApiManagedSourcePreparedCommit({
      ...write,
      commitSha: commitB,
      parentSha: commitA,
      treeSha: treeB,
    });
    const binding = await ms.completeApiManagedSourcePublication({
      ...write,
      now: LATER,
      commitSha: commitB,
      treeSha: treeB,
      eventId: newUlid(),
      observedHeadCommitSha: "f".repeat(40),
    });
    expect(binding).toMatchObject({ generation: 1, commitSha: "f".repeat(40), status: "ready" });
    expect(
      await rows(
        "SELECT commit_sha,generation FROM project_source_bindings WHERE project_id=?",
        p.projectId,
      ),
    ).toEqual([{ commit_sha: "f".repeat(40), generation: 1 }]);
  }, 60_000);

  it("rejects a publication durably by principal, expiry and replays the rejection", async () => {
    const p = first,
      current = (await ms.readApiProjectSourceBinding(p.scope)) as { commitSha: string },
      open = (n: number) =>
        begin(p, n, {
          mode: "commit",
          expectedSourceConnectionId: p.sourceConnectionId,
          expectedSourceGeneration: 1,
          expectedManagedCommit: current.commitSha,
        });
    const revoked = open(5),
      expired = open(6),
      scope = { organizationId: p.organizationId, projectId: p.projectId };
    await ms.beginApiManagedSourcePublication(revoked);
    await ms.beginApiManagedSourcePublication(expired);

    const reject = {
      ...scope,
      operationId: revoked.operationId,
      principalId: MANAGED_PRINCIPAL,
      eventId: newUlid(),
      now: NOW,
    };
    expect(await ms.rejectProcessorManagedSourcePublication(reject)).toBe(true);
    expect(
      await ms.rejectProcessorManagedSourcePublication({ ...reject, eventId: newUlid() }),
    ).toBe(true);
    expect(
      await ms.rejectProcessorManagedSourcePublication({
        ...reject,
        eventId: newUlid(),
        errorCode: "SOURCE_COMMIT_CONFLICT",
      }),
    ).toBe(false);
    expect(
      await rows(
        "SELECT error_code FROM managed_source_publications WHERE operation_id=?",
        revoked.operationId,
      ),
    ).toEqual([{ error_code: "AUTHORIZATION_CHANGED" }]);

    await expect(
      ms.rejectProcessorManagedSourcePublication({
        ...scope,
        operationId: expired.operationId,
        errorCode: "SOURCE_UPLOAD_EXPIRED",
        eventId: newUlid(),
        now: NOW,
      }),
    ).rejects.toEqual(kind("managed_source_expired"));
    expect(
      await ms.rejectProcessorManagedSourcePublication({
        ...scope,
        operationId: expired.operationId,
        errorCode: "SOURCE_UPLOAD_EXPIRED",
        eventId: newUlid(),
        now: AFTER_EXPIRY,
      }),
    ).toBe(true);
    await expect(
      ms.rejectProcessorManagedSourcePublication({
        ...scope,
        operationId: newUlid(),
        eventId: newUlid(),
        now: NOW,
      }),
    ).rejects.toEqual(kind("managed_source_scope"));
    expect(
      await rows(
        "SELECT state FROM operations WHERE operation_id IN (?,?) ORDER BY operation_id",
        revoked.operationId,
        expired.operationId,
      ),
    ).toEqual([{ state: "failed" }, { state: "failed" }]);
  }, 60_000);

  it("ends a sealed publication whose dispatch exhausted, once, so later source writes are not blocked", async () => {
    const p = first,
      dispatch = store.projectDispatch.managedSource,
      current = (await ms.readApiProjectSourceBinding(p.scope)) as { commitSha: string },
      file0 = file("package.json", "{}"),
      stuck = begin(p, 12, {
        mode: "commit",
        expectedSourceConnectionId: p.sourceConnectionId,
        expectedSourceGeneration: 1,
        expectedManagedCommit: current.commitSha,
        message: "Stuck dispatch",
      }),
      write = { ...publicationOf(stuck, p), now: NOW };
    await ms.beginApiManagedSourcePublication(stuck);
    await upload(p, stuck.operationId, [file0]);
    await ms.sealApiManagedSourceManifest({ ...write, ...manifestOf([file0]) });
    // a dispatch that still has attempts left is not ended
    expect(await dispatch.sweep({ now: LATER })).toBe(false);

    await control.core
      .prepare(
        "UPDATE outbox_events SET attempt_count=5,max_attempts=5,last_error_code='MANAGED_SOURCE_QUEUE_SEND_UNCERTAIN',reconciliation_required_at=?2,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
      )
      .bind(stuck.outboxEventId, LATER.replace("Z", "000Z"))
      .run();
    expect(await dispatch.sweep({ now: LATER })).toBe(true);
    expect(
      await rows(
        "SELECT state,error_code FROM managed_source_publications WHERE operation_id=?",
        stuck.operationId,
      ),
    ).toEqual([{ state: "failed", error_code: "MANAGED_SOURCE_DISPATCH_FAILED" }]);
    expect(
      await rows("SELECT state FROM operations WHERE operation_id=?", stuck.operationId),
    ).toEqual([{ state: "failed" }]);
    expect(await dispatch.sweep({ now: LATER })).toBe(false);
  }, 60_000);

  it("ends a queued initialization whose dispatch exhausted, so the source reports the failure instead of pending", async () => {
    const p = await seedManagedSourceProject(control, { parent: "succeeded" }),
      dispatch = store.projectDispatch.managedSource,
      [recipe] = await rows(
        "SELECT initialization_event_id FROM managed_source_initializations WHERE parent_operation_id=?",
        p.parentOperationId,
      );
    // the recipe was queued and its initialization event used every delivery without being acknowledged
    await control.core.batch([
      control.core
        .prepare(
          "UPDATE managed_source_initializations SET state='queued' WHERE parent_operation_id=?",
        )
        .bind(p.parentOperationId),
      control.core
        .prepare(
          "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,billing_epoch_id) VALUES(?1,?2,?3,?4,'ManagedSourceInitializationRequestedV1',json_object('environmentId',?5),?6,?6,?6,5,?7)",
        )
        .bind(
          p.organizationId,
          recipe?.["initialization_event_id"],
          p.projectId,
          p.parentOperationId,
          p.devEnvironmentId,
          NOW.replace("Z", "000Z"),
          p.billingEpochId,
        ),
    ]);
    expect(await dispatch.sweep({ now: LATER })).toBe(false);
    await control.core
      .prepare(
        "UPDATE outbox_events SET attempt_count=5,max_attempts=5,last_error_code='MANAGED_SOURCE_QUEUE_SEND_UNCERTAIN',reconciliation_required_at=?2,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
      )
      .bind(recipe?.["initialization_event_id"], LATER.replace("Z", "000Z"))
      .run();
    expect(await dispatch.sweep({ now: LATER })).toBe(true);
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      state: "failed",
      errorCode: "MANAGED_SOURCE_DISPATCH_FAILED",
    });
    expect(await dispatch.sweep({ now: LATER })).toBe(false);
  }, 60_000);

  it("ends a sealed publication whose dispatch was acknowledged more than 30 minutes ago and never completed", async () => {
    const p = first,
      dispatch = store.projectDispatch.managedSource,
      current = (await ms.readApiProjectSourceBinding(p.scope)) as { commitSha: string },
      file0 = file("package.json", "{}"),
      stuck = begin(p, 13, {
        mode: "commit",
        expectedSourceConnectionId: p.sourceConnectionId,
        expectedSourceGeneration: 1,
        expectedManagedCommit: current.commitSha,
        message: "Acknowledged dispatch that never ran",
      }),
      write = { ...publicationOf(stuck, p), now: NOW };
    await ms.beginApiManagedSourcePublication(stuck);
    await upload(p, stuck.operationId, [file0]);
    await ms.sealApiManagedSourceManifest({ ...write, ...manifestOf([file0]) });
    // The Queue accepted the message at NOW, and every delivery of it is gone: nothing runs the publication.
    await control.core
      .prepare(
        "UPDATE outbox_events SET attempt_count=1,claimed_at=NULL,lease_expires_at=NULL,acknowledged_at=?2 WHERE event_id=?1",
      )
      .bind(stuck.outboxEventId, NOW.replace("Z", "000Z"))
      .run();
    // exactly 30 minutes after the acknowledgement is not yet older than the bound
    expect(await dispatch.sweep({ now: "2026-10-29T10:30:00.000Z" })).toBe(false);
    expect(
      await rows(
        "SELECT state FROM managed_source_publications WHERE operation_id=?",
        stuck.operationId,
      ),
    ).toEqual([{ state: "sealed" }]);
    expect(await dispatch.sweep({ now: "2026-10-29T10:30:00.001Z" })).toBe(true);
    expect(
      await rows(
        "SELECT state,error_code FROM managed_source_publications WHERE operation_id=?",
        stuck.operationId,
      ),
    ).toEqual([{ state: "failed", error_code: "MANAGED_SOURCE_DISPATCH_FAILED" }]);
    expect(
      await rows("SELECT state FROM operations WHERE operation_id=?", stuck.operationId),
    ).toEqual([{ state: "failed" }]);
    expect(await dispatch.sweep({ now: "2026-10-29T10:30:00.001Z" })).toBe(false);
  }, 60_000);

  it("ends a queued initialization whose dispatch was acknowledged more than 30 minutes ago and never attached a child", async () => {
    const p = await seedManagedSourceProject(control, { parent: "succeeded" }),
      dispatch = store.projectDispatch.managedSource,
      [recipe] = await rows(
        "SELECT initialization_event_id FROM managed_source_initializations WHERE parent_operation_id=?",
        p.parentOperationId,
      );
    await control.core.batch([
      control.core
        .prepare(
          "UPDATE managed_source_initializations SET state='queued' WHERE parent_operation_id=?",
        )
        .bind(p.parentOperationId),
      control.core
        .prepare(
          "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,billing_epoch_id,acknowledged_at) VALUES(?1,?2,?3,?4,'ManagedSourceInitializationRequestedV1',json_object('environmentId',?5),?6,?6,?6,5,?7,?6)",
        )
        .bind(
          p.organizationId,
          recipe?.["initialization_event_id"],
          p.projectId,
          p.parentOperationId,
          p.devEnvironmentId,
          NOW.replace("Z", "000Z"),
          p.billingEpochId,
        ),
    ]);
    // the Queue accepted the initialization at NOW, and the processor never attached a child publication
    expect(await dispatch.sweep({ now: "2026-10-29T10:30:00.000Z" })).toBe(false);
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      state: "queued",
    });
    expect(await dispatch.sweep({ now: "2026-10-29T10:30:00.001Z" })).toBe(true);
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      state: "failed",
      errorCode: "MANAGED_SOURCE_DISPATCH_FAILED",
    });
    expect(await dispatch.sweep({ now: "2026-10-29T10:30:00.001Z" })).toBe(false);
  }, 60_000);

  it("keeps the recipe, the owner scope and a lost response exact", async () => {
    const p = await seedManagedSourceProject(control, { parent: "running" });
    await expect(ms.authorizeProcessorManagedSourceInitialization(p.parent)).rejects.toEqual(
      kind("managed_source_initialization_state"),
    );
    await expect(
      ms.authorizeProcessorManagedSourceInitialization({
        ...p.parent,
        parentOperationId: newUlid(),
      }),
    ).rejects.toEqual(kind("managed_source_initialization_scope"));
    await expect(
      ms.attachProcessorManagedSourceInitializationChild({
        ...p.parent,
        childOperationId: newUlid(),
        now: NOW,
      }),
    ).rejects.toEqual(kind("managed_source_initialization_identity"));
    await ms.rejectProcessorManagedSourceInitialization({
      ...p.parent,
      errorCode: "AUTHORIZATION_CHANGED",
      now: NOW,
    });
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      state: "failed",
      errorCode: "AUTHORIZATION_CHANGED",
    });
    // a failed recipe is never reopened
    await ms.rejectProcessorManagedSourceInitialization({
      ...p.parent,
      errorCode: "OTHER_CODE",
      now: LATER,
    });
    expect(await ms.readApiManagedSourceInitialization(p.scope)).toMatchObject({
      errorCode: "AUTHORIZATION_CHANGED",
    });

    // a stranger and a member never read or write the project's source
    const stranger = { ...p.scope, principalId: "user:user_stranger" };
    await expect(ms.readApiManagedSourceProjectScope(stranger)).rejects.toEqual(
      kind("managed_source_scope"),
    );
    await expect(ms.readApiProjectSourceBinding(stranger)).rejects.toEqual(
      kind("managed_source_scope"),
    );
    await expect(ms.readApiManagedSourceInitialization(stranger)).rejects.toEqual(
      kind("managed_source_initialization_scope"),
    );
    await expect(
      ms.readApiManagedSourcePublication({ ...stranger, operationId: newUlid() }),
    ).rejects.toEqual(kind("managed_source_scope"));
    await expect(
      ms.readApiManagedSourceOperation({ ...p.scope, operationId: newUlid() }),
    ).rejects.toEqual(kind("source_scope_unavailable"));
    expect(
      await ms.readApiManagedSourcePublication({ ...p.scope, operationId: newUlid() }),
    ).toBeNull();

    // the response of the committed begin batch is lost: the retry answers the original journal
    const q = await seedManagedSourceProject(control),
      lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }),
      created = begin(q, 8);
    const answer = await lossy.managedSource.beginApiManagedSourcePublication(created);
    expect(answer).toMatchObject({ operationId: created.operationId, state: "staging" });
    expect(
      await rows(
        "SELECT count(*) n FROM managed_source_publications WHERE operation_id=?",
        created.operationId,
      ),
    ).toEqual([{ n: 1 }]);
  }, 60_000);
});

describe("managed source authority withdrawal", () => {
  it("stops a non-delegated owner's managed authority once a membership barrier or a user revocation opens", async () => {
    const p = await seedManagedSourceProject(control);
    const organization = await rows(
      "SELECT workos_organization_id FROM organizations WHERE organization_id=?",
      p.organizationId,
    );
    const workosOrganizationId = String(organization[0]?.["workos_organization_id"]);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      principalId: MANAGED_PRINCIPAL,
    };
    const authorized = async () =>
      managedAuthorized(await readManagedSnapshot(control.core, scope), true);
    expect(await authorized()).toBe(true);

    await store.identity.recordMembershipBarrier({
      workosOrganizationId,
      workosUserId: MANAGED_USER,
      sourceEventId: newUlid(),
      eventCreatedAt: NOW,
    });
    expect(await authorized()).toBe(false);
    await expect(
      ms.authorizeApiManagedSourcePublication({
        ...p.scope,
        principalId: MANAGED_PRINCIPAL,
        operationId: newUlid(),
        now: NOW,
      }),
    ).rejects.toEqual(kind("managed_source_scope"));
  });

  it("denies a managed snapshot after a terminal revocation of the user", async () => {
    // A global user revocation is shared by every organization of the Core, so this test owns its Core.
    const own = await createTestControl(),
      ownStore = createControlStore(own.bindings),
      p = await seedManagedSourceProject(own);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      principalId: MANAGED_PRINCIPAL,
    };
    expect(managedAuthorized(await readManagedSnapshot(own.core, scope), true)).toBe(true);
    await ownStore.identity.recordTerminalRevocation({
      kind: "user",
      workosUserId: MANAGED_USER,
      sourceEventId: newUlid(),
      effectiveAt: NOW,
    });
    expect(managedAuthorized(await readManagedSnapshot(own.core, scope), true)).toBe(false);
    await own.dispose();
  });

  it("keeps a managed snapshot authorized under a user revocation scoped to another organization", async () => {
    const p = await seedManagedSourceProject(control);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      principalId: MANAGED_PRINCIPAL,
    };
    await store.identity.recordTerminalRevocation({
      kind: "user",
      workosUserId: MANAGED_USER,
      workosOrganizationId: "org_some_other_organization",
      sourceEventId: newUlid(),
      effectiveAt: NOW,
    });
    expect(managedAuthorized(await readManagedSnapshot(control.core, scope), true)).toBe(true);
  });
});
