import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { parseUlid, storageRequirementFromConfig } from "@ohmyhost/platform";
import { parseOhmyhostConfigYaml } from "@ohmyhost/contracts";
import * as database from "@ohmyhost/database";
import type {
  ManagedSourceBlob,
  ManagedSourcePublication,
  ProjectSourceBinding,
  ManagedSourceInitialization,
} from "@ohmyhost/database";
import {
  createManagedSourceSurface,
  ManagedSourceGitInputRefusedError,
  ManagedSourceSurfaceError,
  registerManagedSourceRoutes,
  type ManagedSourceStore,
  type ManagedSourceGitFile,
  type ManagedSourceGitPort,
  type ManagedSourceBlobPort,
} from "../src/managed-source-surface.js";
import {
  createControlApi,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableDevAccessTicketsPort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
} from "../src/index.js";
import { VITE_REACT_DEPENDENCY_FILES } from "../src/vite-react-template.js";
import { initializeRepository } from "../../product-cli/src/repository-init.js";

vi.mock("@ohmyhost/database", { spy: true });

const organizationId = parseUlid("00000000000000000000000001");
const projectId = parseUlid("00000000000000000000000002");
const environmentId = parseUlid("00000000000000000000000003");
const NOW = "2026-10-06T09:00:00.000Z";
const context = {
  organizationId,
  projectId,
  principalId: "user:user_test",
  requestId: "req_source",
};
const hash = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value");
  return value;
}

function fixture(
  initial?: ProjectSourceBinding,
  pending: ManagedSourceInitialization | null = null,
  region: "us" | "eu" = "us",
) {
  let binding = initial ?? null;
  let nextId = 10;
  let time = new Date(NOW);
  let denyPush = false;
  let losePushResponse = false;
  const journals = new Map<string, ManagedSourcePublication>();
  const replays = new Map<string, { digest: string; operationId: string }>();
  const objects = new Map<string, Uint8Array>();
  const trees = new Map<string, readonly ManagedSourceGitFile[]>();
  const histories = new Map<
    string,
    { commitSha: string; parentSha: string | null; message: string; createdAt: string }
  >();
  let head: string | null = null;
  const authorize = (scope: { organizationId: string; projectId: string; principalId: string }) => {
    if (
      scope.organizationId !== organizationId ||
      scope.projectId !== projectId ||
      scope.principalId !== context.principalId
    )
      throw new ManagedSourceSurfaceError("source_scope_unavailable", 404, "Resource not found.");
  };
  const get = (scope: Parameters<ManagedSourceStore["publication"]>[0]) => {
    authorize(scope);
    return journals.get(scope.operationId) ?? null;
  };
  const update = (
    scope: Parameters<ManagedSourceStore["publication"]>[0],
    change: Partial<ManagedSourcePublication>,
  ) => {
    const journal = get(scope);
    if (!journal) throw new Error("Missing journal");
    const next = { ...journal, ...change };
    journals.set(scope.operationId, next);
    return next;
  };
  const store: ManagedSourceStore = {
    async projectScope(scope) {
      authorize(scope);
      return { environmentId, region };
    },
    async binding(scope) {
      authorize(scope);
      return binding;
    },
    async pendingInitialization(scope) {
      authorize(scope);
      return pending;
    },
    async begin(request) {
      authorize(request);
      const replayKey = `${"routeTemplate" in request ? request.routeTemplate : "publication"}:${request.idempotencyKey}`;
      const digest = Buffer.from(request.canonicalRequestDigest).toString("hex");
      const previous = replays.get(replayKey);
      if (previous) {
        if (previous.digest !== digest) throw new Error("Idempotency conflict");
        return required(journals.get(previous.operationId));
      }
      if (
        (binding?.generation ?? 0) !== request.expectedSourceGeneration ||
        (binding?.sourceConnectionId ?? null) !== request.expectedSourceConnectionId ||
        (request.mode === "commit" &&
          (binding?.provider !== "managed" || binding.commitSha !== request.expectedManagedCommit))
      )
        throw new ManagedSourceSurfaceError("source_generation_conflict", 409, "Source changed");
      if ([...journals.values()].some((j) => j.state === "staging" || j.state === "sealed"))
        throw new Error("Source operation in progress");
      const journal: ManagedSourcePublication = {
        operationId: request.operationId,
        sourceConnectionId: request.sourceConnectionId,
        mode: request.mode,
        state: "staging",
        expectedSourceConnectionId: request.expectedSourceConnectionId,
        expectedSourceGeneration: request.expectedSourceGeneration,
        expectedManagedCommit: request.expectedManagedCommit,
        manifestDigest: null,
        commitSha: null,
        treeSha: null,
        namespace: request.namespace,
        repositoryName: request.repositoryName,
        message: request.message,
        files: [],
        blobs: [],
        createdAt: request.now,
        expiresAt: request.expiresAt,
        errorCode: null,
        delegation: null,
      };
      journals.set(journal.operationId, journal);
      replays.set(replayKey, { digest, operationId: journal.operationId });
      return journal;
    },
    async publication(scope) {
      return get(scope);
    },
    async reserveBlob(request) {
      authorize(request);
      return "created";
    },
    async recordBlob(request) {
      const journal = required(get(request));
      update(request, {
        blobs: [
          ...journal.blobs,
          {
            path: request.path,
            sha256: request.sha256,
            byteLength: request.byteLength,
            executable: request.executable,
            bucket: request.bucket,
            key: request.key,
            versionId: request.versionId,
            eTag: request.eTag,
          },
        ],
      });
    },
    async seal(request) {
      const journal = required(get(request));
      if (journal.state === "sealed" && journal.manifestDigest === request.manifestSha256) return;
      if (
        journal.state !== "staging" ||
        journal.blobs.length !== request.files.length ||
        request.files.some(
          (file) =>
            !journal.blobs.some(
              (blob) =>
                blob.path === file.path &&
                blob.sha256 === file.sha256 &&
                blob.byteLength === file.byteLength &&
                blob.executable === file.executable,
            ),
        )
      )
        throw new Error("Manifest mismatch");
      update(request, {
        state: "sealed",
        files: request.files,
        manifestDigest: request.manifestSha256,
      });
    },
    async prepared(request) {
      const journal = required(get(request));
      if (journal.expectedManagedCommit !== request.parentSha) throw new Error("Parent conflict");
      update(request, { commitSha: request.commitSha, treeSha: request.treeSha });
    },
    async complete(request) {
      const journal = required(get(request));
      if (journal.commitSha !== request.commitSha || journal.treeSha !== request.treeSha)
        throw new Error("Candidate conflict");
      binding = {
        provider: "managed",
        sourceConnectionId: journal.sourceConnectionId,
        generation:
          journal.mode === "commit"
            ? journal.expectedSourceGeneration
            : journal.expectedSourceGeneration + 1,
        commitSha: request.observedHeadCommitSha ?? request.commitSha,
        namespace: journal.namespace,
        repositoryName: journal.repositoryName,
        status: "ready",
        linkedAt: binding?.linkedAt ?? request.now,
        updatedAt: request.now,
      };
      update(request, { state: "committed" });
      return binding;
    },
    async fail(request) {
      update(request, { state: "failed", errorCode: request.errorCode });
    },
    async recordRequest(request) {
      authorize(request);
      return "created";
    },
    async operation(scope) {
      const journal = required(get(scope));
      return {
        status: 202,
        location: `/v1/operations/${scope.operationId}`,
        body: {
          id: scope.operationId,
          state:
            journal.state === "committed"
              ? "succeeded"
              : journal.state === "failed"
                ? "failed"
                : "queued",
          created_at: journal.createdAt,
          updated_at: time.toISOString(),
        },
      };
    },
    async authorizePublication(scope) {
      authorize(scope);
      if (denyPush) throw new Error("Access revoked");
    },
  };
  const blobs: ManagedSourceBlobPort = {
    async put(request) {
      const key = `managed-staging/${request.operationId}/${request.sha256.slice(7)}`;
      objects.set(key, request.bytes);
      return { bucket: "ohmyho-builds-development", key, versionId: "1".repeat(32), eTag: "etag" };
    },
    async get(blob: ManagedSourceBlob) {
      const value = objects.get(blob.key);
      if (!value) throw new Error("Missing source object");
      return value;
    },
  };
  const git: ManagedSourceGitPort = {
    ensureRepository: vi.fn(async () => {}),
    head: vi.fn(async () => head),
    files: vi.fn(async (_repo, sha) => {
      if (!trees.has(sha)) throw new Error("Unknown version");
      return required(trees.get(sha));
    }),
    history: vi.fn(async (_repo, request) => {
      let sha = request.beforeCommitSha ?? head;
      const versions = [];
      while (sha && versions.length < request.limit) {
        const version = histories.get(sha);
        if (!version) break;
        versions.push(version);
        sha = version.parentSha;
      }
      return versions;
    }),
    prepare: vi.fn(
      async (
        _repo: Parameters<ManagedSourceGitPort["prepare"]>[0],
        request: Parameters<ManagedSourceGitPort["prepare"]>[1],
      ) => {
        const serialized = JSON.stringify(
          request.files.map((file) => ({
            path: file.path,
            content: Buffer.from(file.bytes).toString("base64"),
            executable: file.executable,
          })),
        );
        const treeSha = createHash("sha1").update(serialized).digest("hex");
        const commitSha = createHash("sha1")
          .update(
            JSON.stringify({
              treeSha,
              parent: request.expectedCommitSha,
              metadata: request.metadata,
            }),
          )
          .digest("hex");
        return { commitSha, treeSha, parentSha: request.expectedCommitSha, providerState: request };
      },
    ),
    containsCommit: vi.fn(
      async (
        _repo: Parameters<ManagedSourceGitPort["containsCommit"]>[0],
        request: Parameters<ManagedSourceGitPort["containsCommit"]>[1],
      ) => {
        if (head !== request.headCommitSha) throw new Error("Head changed");
        let cursor: string | null = request.headCommitSha;
        for (let count = 0; cursor !== null && count < request.maxCommits; count++) {
          if (cursor === request.candidateCommitSha) return true;
          cursor = histories.get(cursor)?.parentSha ?? null;
        }
        return false;
      },
    ),
    push: vi.fn(async (_repo, prepared) => {
      const request = prepared.providerState as Parameters<ManagedSourceGitPort["prepare"]>[1];
      if (head !== request.expectedCommitSha) throw new Error("Concurrent Git push");
      head = prepared.commitSha;
      trees.set(prepared.commitSha, request.files);
      histories.set(prepared.commitSha, {
        commitSha: prepared.commitSha,
        parentSha: request.expectedCommitSha,
        message: request.metadata.message,
        createdAt: new Date(request.metadata.timestampSeconds * 1000).toISOString(),
      });
      if (losePushResponse) {
        losePushResponse = false;
        throw new Error("Lost push response");
      }
    }),
  };
  const wake = vi.fn(async () => {});
  const port = createManagedSourceSurface({
    store,
    blobs,
    git,
    clock: { now: () => time },
    ids: { next: () => parseUlid(String(nextId++).padStart(26, "0")) },
    namespaces: { us: "managed-us", eu: "managed-eu" },
    wake,
  });
  const mutation = (key: string) => ({
    ...context,
    idempotencyKey: key,
    canonicalRequestDigest: createHash("sha256").update(key).digest(),
  });
  return {
    port,
    store,
    git,
    wake,
    objects,
    journals,
    mutation,
    getBinding: () => binding,
    setTime: (value: Date) => {
      time = value;
    },
    denyPush: () => {
      denyPush = true;
    },
    losePush: () => {
      losePushResponse = true;
    },
    setHead: (value: string) => {
      head = value;
    },
    addIndependentHead: () => {
      const other = "e".repeat(40);
      histories.set(other, {
        commitSha: other,
        parentSha: null,
        message: "Other branch",
        createdAt: NOW,
      });
      trees.set(other, []);
      head = other;
      return other;
    },
    addDescendant: (candidateSha: string) => {
      const descendantSha = createHash("sha1").update(`descendant:${candidateSha}`).digest("hex");
      histories.set(descendantSha, {
        commitSha: descendantSha,
        parentSha: candidateSha,
        message: "Later change",
        createdAt: NOW,
      });
      trees.set(descendantSha, trees.get(candidateSha) ?? []);
      head = descendantSha;
      return descendantSha;
    },
    head: () => head,
  };
}

describe("managed source application surface", () => {
  it("creates a real seed snapshot, reads/diffs changes, restores history and observes a lost push before retry", async () => {
    const f = fixture();
    expect(await f.port.getSource(context)).toBeNull();
    const pending: ManagedSourceInitialization = {
      organizationId,
      projectId,
      parentOperationId: environmentId,
      sourceConnectionId: "00000000000000000000000009",
      initializationEventId: "00000000000000000000000008",
      principalId: context.principalId,
      template: "vite-react",
      region: "eu",
      requestId: context.requestId,
      billingEpochId: "00000000000000000000000007",
      state: "queued",
      childOperationId: null,
      creationDelegation: null,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const failedInitialization = fixture(
      undefined,
      {
        ...pending,
        state: "failed",
        childOperationId: environmentId,
        errorCode: "AUTHORIZATION_CHANGED",
      },
      "eu",
    );
    expect((await failedInitialization.port.getSource(context))?.body).toMatchObject({
      status: "failed",
      initialization_operation_id: environmentId,
      initialization_error_code: "authorization_changed",
    });
    const regional = fixture(undefined, pending, "eu");
    expect((await regional.port.getSource(context))?.body).toMatchObject({
      status: "pending",
      source_generation: 0,
      namespace: "managed-eu",
      source_connection_id: pending.sourceConnectionId,
    });
    const regionalOp = await regional.port.initialize(
      {
        ...regional.mutation("reserved-init"),
        reservedSourceConnectionId: pending.sourceConnectionId,
      },
      { template: "vite-react", expected_source_generation: 0 },
    );
    await regional.port.execute(context, String(regionalOp.body["id"]));
    expect(regional.getBinding()?.sourceConnectionId).toBe(pending.sourceConnectionId);
    expect(regional.getBinding()?.namespace).toBe("managed-eu");
    const initialized = await f.port.initialize(f.mutation("initialize"), {
      template: "vite-react",
      expected_source_generation: 0,
    });
    const operationId = String(initialized.body["id"]);
    expect(f.git.ensureRepository).not.toHaveBeenCalled();
    expect(await f.port.execute(context, operationId)).toBe("committed");
    expect(await f.port.execute(context, operationId)).toBe("committed");
    const first = required(f.head());
    const source = await f.port.getSource(context);
    expect(source?.body).toMatchObject({
      provider: "managed",
      source_generation: 1,
      current_commit_sha: first,
      branch: "main",
    });
    const files = await f.port.files(context, {});
    const manifest = required(files).body["files"] as { path: string }[];
    for (const file of ["package.json", "pnpm-lock.yaml", "ohmyhost.yaml", "src/main.tsx"])
      expect(manifest.some((entry) => entry.path === file)).toBe(true);
    const packageFile = await f.port.files(context, { path: "package.json" });
    const content = required(packageFile).body["file"] as { content_base64: string };
    expect(JSON.parse(Buffer.from(content.content_base64, "base64").toString())).toMatchObject({
      packageManager: "pnpm@10.28.2",
    });
    for (const [seed, region] of [
      [f, "us"],
      [regional, "eu"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "ohmyhost-managed-seed-"));
      try {
        const entries = required(await seed.port.files(context, {})).body["files"] as {
          path: string;
        }[];
        for (const entry of entries) {
          const file = required(await seed.port.files(context, { path: entry.path })).body[
            "file"
          ] as { content_base64: string };
          const target = join(directory, entry.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.content_base64, "base64"));
        }
        const inspected = await initializeRepository({ directory, dryRun: true });
        expect(inspected.blockers).toEqual([]);
        expect(inspected.requirements).toEqual([]);
        expect(inspected.companion).toBeNull();
        expect(inspected.runtime).toBeNull();
        expect(inspected.inventory.storage).toEqual({ r2: false, supabase: false });
        const configuration = parseOhmyhostConfigYaml(
          await readFile(join(directory, "ohmyhost.yaml"), "utf8"),
        );
        expect(configuration.runtime.mode).toBe("static");
        expect(configuration.storage).toBeUndefined();
        expect(storageRequirementFromConfig(configuration)).toEqual({ enabled: false });
        expect(seed.getBinding()?.namespace).toBe(`managed-${region}`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(await f.port.files(context, { path: "absent" })).toBeNull();
    const change = {
      expected_source_generation: 1,
      expected_commit_sha: first,
      message: "Improve application",
      changes: [
        {
          path: "src/new.ts",
          content_base64: Buffer.from("export const value = 42;").toString("base64"),
          executable: false,
        },
        { path: "src/style.css", content_base64: null, executable: false },
      ],
    };
    const accepted = await f.port.changes(f.mutation("changes"), change);
    const changedId = String(accepted.body["id"]);
    f.losePush();
    await expect(f.port.execute(context, changedId)).rejects.toThrow("Lost push response");
    const changed = required(f.head());
    expect(f.journals.get(changedId)?.state).toBe("sealed");
    f.objects.clear();
    expect(await f.port.execute(context, changedId)).toBe("committed");
    expect(f.git.push).toHaveBeenCalledTimes(2);
    expect((await f.port.changes(f.mutation("changes"), change)).body["id"]).toBe(changedId);
    const diff = await f.port.diff(context, { from_commit_sha: first, to_commit_sha: changed });
    expect(diff.body["changes"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/new.ts", change: "added" }),
        expect.objectContaining({ path: "src/style.css", change: "deleted" }),
      ]),
    );
    const versions = await f.port.versions(context, { limit: 1 });
    expect(versions.body["next_commit_sha"]).toBe(first);
    expect(
      (await f.port.versions(context, { limit: 10, before_commit_sha: first })).body["versions"],
    ).toHaveLength(1);
    const restored = await f.port.restore(f.mutation("restore"), {
      expected_source_generation: 1,
      expected_commit_sha: changed,
      restore_commit_sha: first,
      message: "Restore first version",
    });
    expect(await f.port.execute(context, String(restored.body["id"]))).toBe("committed");
    expect(
      (await f.port.diff(context, { from_commit_sha: first, to_commit_sha: required(f.head()) }))
        .body["changes"],
    ).toEqual([]);
    expect((await f.port.getUpload(context, changedId))?.body).toMatchObject({
      state: "committed",
      commit_sha: changed,
    });
    expect(await f.port.getUpload(context, "00000000000000000000000999")).toBeNull();
    await expect(
      f.port.files({ ...context, organizationId: parseUlid("00000000000000000000000009") }, {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.wake).toHaveBeenCalledTimes(3);
    expect(VITE_REACT_DEPENDENCY_FILES["pnpm-lock.yaml"]).toContain("lockfileVersion: '9.0'");
    const ancestor = fixture();
    const ancestorOp = await ancestor.port.initialize(ancestor.mutation("ancestor-init"), {
      template: "empty",
      expected_source_generation: 0,
    });
    const ancestorId = String(ancestorOp.body["id"]);
    ancestor.losePush();
    await expect(ancestor.port.execute(context, ancestorId)).rejects.toThrow("Lost push response");
    const candidate = required(ancestor.head());
    const descendant = ancestor.addDescendant(candidate);
    expect(await ancestor.port.execute(context, ancestorId)).toBe("committed");
    expect(ancestor.getBinding()?.commitSha).toBe(descendant);
    expect((await ancestor.port.getUpload(context, ancestorId))?.body["commit_sha"]).toBe(
      candidate,
    );
    expect(await ancestor.port.execute(context, ancestorId)).toBe("committed");
    expect(ancestor.git.push).toHaveBeenCalledTimes(1);
    expect(
      (
        await ancestor.port.initialize(ancestor.mutation("ancestor-init"), {
          template: "empty",
          expected_source_generation: 0,
        })
      ).body["id"],
    ).toBe(ancestorId);
    expect((await ancestor.port.getSource(context))?.body["current_commit_sha"]).toBe(descendant);
    const orphan = fixture();
    const orphanOp = await orphan.port.initialize(orphan.mutation("orphan-init"), {
      template: "empty",
      expected_source_generation: 0,
    });
    orphan.losePush();
    await expect(orphan.port.execute(context, String(orphanOp.body["id"]))).rejects.toThrow(
      "Lost push response",
    );
    const orphanCandidate = orphan.head();
    const independent = orphan.addIndependentHead();
    expect(independent).not.toBe(orphanCandidate);
    expect(await orphan.port.execute(context, String(orphanOp.body["id"]))).toBe("failed");
    expect(orphan.getBinding()).toBeNull();
    expect(orphan.git.push).toHaveBeenCalledTimes(1);
  });

  it("reads the commit a restore or change starts from before it opens a publication", async () => {
    const f = fixture();
    const initialized = await f.port.initialize(f.mutation("seed"), {
      template: "vite-react",
      expected_source_generation: 0,
    });
    expect(await f.port.execute(context, String(initialized.body["id"]))).toBe("committed");
    const head = required(f.head());
    const opened = f.journals.size;
    await expect(
      f.port.restore(f.mutation("restore-unknown"), {
        expected_source_generation: 1,
        expected_commit_sha: head,
        restore_commit_sha: "f".repeat(40),
        message: "Restore an unknown version",
      }),
    ).rejects.toThrow("Unknown version");
    expect(f.journals.size).toBe(opened);
    vi.mocked(f.git.files).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      f.port.changes(f.mutation("changes-unreadable"), {
        expected_source_generation: 1,
        expected_commit_sha: head,
        message: "Change an unreadable base",
        changes: [
          {
            path: "src/new.ts",
            content_base64: Buffer.from("export const value = 1;").toString("base64"),
            executable: false,
          },
        ],
      }),
    ).rejects.toThrow("provider unavailable");
    expect(f.journals.size).toBe(opened);
    expect([...f.journals.values()].some((journal) => journal.state === "staging")).toBe(false);
  });

  it("refuses a snapshot whose file is another file's folder as an invalid snapshot, before any Git write", async () => {
    const f = fixture();
    const initialized = await f.port.initialize(f.mutation("seed"), {
      template: "vite-react",
      expected_source_generation: 0,
    });
    expect(await f.port.execute(context, String(initialized.body["id"]))).toBe("committed");
    const pushes = vi.mocked(f.git.push).mock.calls.length;
    await expect(
      f.port.changes(f.mutation("folder-conflict"), {
        expected_source_generation: 1,
        expected_commit_sha: required(f.head()),
        message: "Add a file and a folder with its name",
        changes: [
          {
            path: "docs",
            content_base64: Buffer.from("a file").toString("base64"),
            executable: false,
          },
          {
            path: "docs/readme.md",
            content_base64: Buffer.from("a folder member").toString("base64"),
            executable: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "source_snapshot_invalid", status: 409 });
    expect(vi.mocked(f.git.push).mock.calls.length).toBe(pushes);
    expect([...f.journals.values()].at(-1)?.errorCode).toBe("SOURCE_SNAPSHOT_INVALID");
  });

  it("fails an already sealed snapshot with a file and folder conflict instead of retrying it", async () => {
    const f = fixture();
    const initialized = await f.port.initialize(f.mutation("seed"), {
      template: "vite-react",
      expected_source_generation: 0,
    });
    expect(await f.port.execute(context, String(initialized.body["id"]))).toBe("committed");
    const sealed = await f.port.changes(f.mutation("sealed-before-fix"), {
      expected_source_generation: 1,
      expected_commit_sha: required(f.head()),
      message: "Seal a snapshot",
      changes: [
        {
          path: "src/new.ts",
          content_base64: Buffer.from("export const value = 1;").toString("base64"),
          executable: false,
        },
      ],
    });
    const operationId = String(sealed.body["id"]);
    // A snapshot sealed before the contract refused folder conflicts: the manifest names both paths.
    const journal = required(f.journals.get(operationId));
    const blob = required(journal.blobs[0]);
    f.journals.set(operationId, {
      ...journal,
      files: [
        { path: "docs", sha256: blob.sha256, byteLength: blob.byteLength, executable: false },
        {
          path: "docs/readme.md",
          sha256: blob.sha256,
          byteLength: blob.byteLength,
          executable: false,
        },
      ],
      blobs: [
        { ...blob, path: "docs" },
        { ...blob, path: "docs/readme.md" },
      ],
    });
    expect(await f.port.execute(context, operationId)).toBe("failed");
    expect(f.journals.get(operationId)?.errorCode).toBe("SOURCE_SNAPSHOT_INVALID");
  });

  it("fails a snapshot that the Git preparation refuses as an invalid input once instead of retrying it", async () => {
    const f = fixture();
    const initialized = await f.port.initialize(f.mutation("seed"), {
      template: "vite-react",
      expected_source_generation: 0,
    });
    expect(await f.port.execute(context, String(initialized.body["id"]))).toBe("committed");
    const sealed = await f.port.changes(f.mutation("prepare-refused"), {
      expected_source_generation: 1,
      expected_commit_sha: required(f.head()),
      message: "Seal a snapshot",
      changes: [
        {
          path: "src/new.ts",
          content_base64: Buffer.from("export const value = 1;").toString("base64"),
          executable: false,
        },
      ],
    });
    const operationId = String(sealed.body["id"]);
    // The managed Git adapter refuses the reconstructed input before any candidate exists; a retry repeats the refusal.
    vi.mocked(f.git.prepare).mockRejectedValueOnce(new ManagedSourceGitInputRefusedError());
    expect(await f.port.execute(context, operationId)).toBe("failed");
    expect(f.journals.get(operationId)).toMatchObject({
      state: "failed",
      errorCode: "SOURCE_SNAPSHOT_INVALID",
    });
  });

  it("retries a sealed snapshot whose stored object read mismatches once instead of failing it", async () => {
    const f = fixture();
    const initialized = await f.port.initialize(f.mutation("seed"), {
      template: "vite-react",
      expected_source_generation: 0,
    });
    expect(await f.port.execute(context, String(initialized.body["id"]))).toBe("committed");
    const sealed = await f.port.changes(f.mutation("object-read-mismatch"), {
      expected_source_generation: 1,
      expected_commit_sha: required(f.head()),
      message: "Change one file",
      changes: [
        {
          path: "src/new.ts",
          content_base64: Buffer.from("export const value = 1;").toString("base64"),
          executable: false,
        },
      ],
    });
    const operationId = String(sealed.body["id"]);
    const key = required(required(f.journals.get(operationId)).blobs[0]).key;
    const stored = required(f.objects.get(key));
    // The first read returns other bytes than the immutable receipt; a retry reads the object again.
    f.objects.set(key, Buffer.from("returned by a stale read"));
    await expect(f.port.execute(context, operationId)).rejects.toMatchObject({
      code: "source_snapshot_invalid",
    });
    expect(f.journals.get(operationId)).toMatchObject({ state: "sealed", errorCode: null });
    f.objects.set(key, stored);
    expect(await f.port.execute(context, operationId)).toBe("committed");
  });

  it("seals one full local snapshot, keeps GitHub active until switch succeeds, rejects altered uploads and revoked pushes", async () => {
    const initial: ProjectSourceBinding = {
      provider: "github",
      sourceConnectionId: "00000000000000000000000005",
      generation: 4,
      commitSha: null,
      namespace: "customer",
      repositoryName: "application",
      status: "ready",
      linkedAt: NOW,
      updatedAt: NOW,
    };
    const f = fixture(initial);
    const upload = await f.port.createUpload(f.mutation("switch"), {
      mode: "switch",
      expected_source_generation: 4,
      expected_source_connection_id: initial.sourceConnectionId,
      expected_commit_sha: null,
      message: "Use ohmyho.st versioning",
    });
    const id = String(upload.body["id"]);
    expect(await f.port.execute(context, id)).toBe("staging");
    expect(f.getBinding()?.provider).toBe("github");
    const data = Buffer.from("#!/bin/sh\nexit 0\n");
    const blob = {
      path: "bin/run",
      content_base64: data.toString("base64"),
      sha256: hash(data),
      executable: true,
    };
    const receipt = await f.port.putBlob(f.mutation("blob"), id, blob);
    expect((await f.port.putBlob(f.mutation("blob"), id, blob)).body).toEqual(receipt.body);
    await expect(
      f.port.putBlob(f.mutation("blob"), id, { ...blob, content_base64: "eA==" }),
    ).rejects.toMatchObject({ code: "source_snapshot_invalid" });
    await expect(
      f.port.putBlob(f.mutation("blob"), id, { ...blob, executable: false }),
    ).rejects.toMatchObject({ code: "source_upload_conflict" });
    const manifest = [
      { path: "bin/run", sha256: hash(data), byte_length: data.byteLength, executable: true },
    ];
    await expect(
      f.port.commitUpload(f.mutation("wrong-finalize"), id, {
        expected_source_generation: 4,
        files: manifest,
      }),
    ).rejects.toMatchObject({ code: "source_generation_conflict" });
    await f.port.switchSource(f.mutation("switch-finalize"), {
      upload_operation_id: id,
      expected_source_generation: 4,
      expected_source_connection_id: initial.sourceConnectionId,
      files: manifest,
    });
    expect(await f.port.execute(context, id)).toBe("committed");
    expect(f.getBinding()).toMatchObject({ provider: "managed", generation: 5 });
    expect((await f.port.files(context, { path: "bin/run" }))?.body["file"]).toMatchObject({
      executable: true,
    });
    await f.port.switchSource(f.mutation("switch-finalize"), {
      upload_operation_id: id,
      expected_source_generation: 4,
      expected_source_connection_id: initial.sourceConnectionId,
      files: manifest,
    });
    await expect(
      f.port.switchSource(f.mutation("different-manifest"), {
        upload_operation_id: id,
        expected_source_generation: 4,
        expected_source_connection_id: initial.sourceConnectionId,
        files: [],
      }),
    ).rejects.toMatchObject({ code: "source_upload_conflict" });
    expect((await f.port.putBlob(f.mutation("blob"), id, blob)).body).toEqual(receipt.body);
    const current = f.head();
    const next = await f.port.createUpload(f.mutation("next"), {
      mode: "commit",
      expected_source_generation: 5,
      expected_source_connection_id: required(f.getBinding()).sourceConnectionId,
      expected_commit_sha: current,
      message: "Next snapshot",
    });
    const nextId = String(next.body["id"]);
    await f.port.putBlob(f.mutation("blob"), nextId, blob);
    await f.port.commitUpload(f.mutation("commit-next"), nextId, {
      expected_source_generation: 5,
      files: manifest,
    });
    f.denyPush();
    await expect(f.port.execute(context, nextId)).rejects.toThrow("Access revoked");
    expect(f.head()).toBe(current);
    const empty = fixture();
    const emptyOp = await empty.port.initialize(empty.mutation("empty"), {
      template: "empty",
      expected_source_generation: 0,
    });
    expect(await empty.port.execute(context, String(emptyOp.body["id"]))).toBe("committed");
    expect((await empty.port.files(context, {}))?.body["files"]).toEqual([]);
    const bounded = fixture();
    const boundedOp = await bounded.port.createUpload(bounded.mutation("budget"), {
      mode: "initialize",
      expected_source_generation: 0,
      expected_source_connection_id: null,
      expected_commit_sha: null,
      message: "Upload",
    });
    const boundedId = String(boundedOp.body["id"]);
    const boundedJournal = required(bounded.journals.get(boundedId));
    bounded.journals.set(boundedId, {
      ...boundedJournal,
      blobs: Array.from({ length: 2000 }, (_, index) => ({
        path: `file${index}`,
        sha256: "f".repeat(64),
        byteLength: 0,
        executable: false,
        bucket: "ohmyho-builds-development",
        key: "unused",
        versionId: "f".repeat(32),
        eTag: "etag",
      })),
    });
    await expect(
      bounded.port.putBlob(bounded.mutation("budget-file"), boundedId, blob),
    ).rejects.toMatchObject({ code: "source_snapshot_too_large", status: 413 });
    bounded.journals.set(boundedId, {
      ...boundedJournal,
      blobs: [
        {
          path: "large",
          sha256: "f".repeat(64),
          byteLength: 8 * 1024 * 1024,
          executable: false,
          bucket: "ohmyho-builds-development",
          key: "unused",
          versionId: "f".repeat(32),
          eTag: "etag",
        },
      ],
    });
    await expect(
      bounded.port.putBlob(bounded.mutation("budget-bytes"), boundedId, blob),
    ).rejects.toMatchObject({ code: "source_snapshot_too_large", status: 413 });
    expect(bounded.objects.size).toBe(0);
    const expired = fixture();
    const expiredOp = await expired.port.createUpload(expired.mutation("expires"), {
      mode: "initialize",
      expected_source_generation: 0,
      expected_source_connection_id: null,
      expected_commit_sha: null,
      message: "Upload",
    });
    expired.setTime(new Date(Date.parse(NOW) + 3600_001));
    await expect(
      expired.port.putBlob(expired.mutation("blob"), String(expiredOp.body["id"]), blob),
    ).rejects.toMatchObject({ code: "source_upload_expired" });
    const conflict = fixture();
    const conflictOp = await conflict.port.initialize(conflict.mutation("conflict"), {
      template: "empty",
      expected_source_generation: 0,
    });
    conflict.setHead("f".repeat(40));
    expect(await conflict.port.execute(context, String(conflictOp.body["id"]))).toBe("failed");
    expect(conflict.git.push).not.toHaveBeenCalled();
  });

  it("registers strict REST inputs behind the existing scoped authorization handler", async () => {
    const f = fixture();
    const app = new Hono();
    const authorization = vi.fn(async () => true);
    registerManagedSourceRoutes(
      app,
      async (ctx, options) => {
        if (ctx.req.param("project_id") !== projectId || !(await authorization()))
          return new Response(null, { status: 404 });
        const parsed = await options.body(ctx, "req_test");
        if (parsed.outcome === "error") return parsed.response;
        const result = await options.invoke(
          { context, mutation: f.mutation(ctx.req.path) },
          parsed.value,
        );
        return result
          ? Response.json(result.body, { status: result.status })
          : new Response(null, { status: 404 });
      },
      f.port,
    );
    const base = `https://api.test/v1/projects/${projectId}/source`;
    const initialized = await app.request(`${base}:initialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "empty", expected_source_generation: 0 }),
    });
    expect(initialized.status).toBe(202);
    const op = (await initialized.json()) as { id: string };
    await f.port.execute(context, op.id);
    for (const suffix of [
      "/files",
      "/versions?limit=1",
      `/diff?from_commit_sha=${f.head()}&to_commit_sha=${f.head()}`,
      `/uploads/${op.id}`,
    ])
      expect((await app.request(base + suffix)).status).toBe(200);
    for (const suffix of [
      "/files?unknown=x",
      "/files?path=../secret",
      "/versions?limit=0",
      "/versions?limit=101",
      "/versions?limit=1&limit=2",
      "/diff?from_commit_sha=bad",
      "/uploads/bad",
    ])
      expect((await app.request(base + suffix)).status).toBe(400);
    for (const [headers, body] of [
      [{}, "{}"],
      [{ "content-type": "application/json" }, "{"],
      [
        { "content-type": "application/json" },
        JSON.stringify({ template: "empty", expected_source_generation: 0, token: "hidden" }),
      ],
    ] as const)
      expect(
        (await app.request(`${base}:initialize`, { method: "POST", headers, body })).status,
      ).toBe(400);
    authorization.mockResolvedValueOnce(false);
    expect((await app.request(`${base}/files`)).status).toBe(404);
    expect(
      (await app.request(`https://api.test/v1/projects/00000000000000000000000009/source/files`))
        .status,
    ).toBe(404);
    const uploaded = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "commit",
        expected_source_generation: 1,
        expected_source_connection_id: f.getBinding()?.sourceConnectionId,
        expected_commit_sha: f.head(),
        message: "Replace snapshot",
      }),
    });
    expect(uploaded.status).toBe(202);
    const uploadedId = ((await uploaded.json()) as { id: string }).id;
    const blobRequest = {
      path: "main.ts",
      content_base64: "eA==",
      sha256: hash(Buffer.from("x")),
      executable: false,
    };
    const filePut = await app.request(`${base}/uploads/${uploadedId}/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(blobRequest),
    });
    expect(filePut.status).toBe(200);
    const uploadedFile = await filePut.json();
    const committed = await app.request(`${base}/uploads/${uploadedId}:commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_source_generation: 1, files: [uploadedFile] }),
    });
    expect(committed.status).toBe(202);
    await f.port.execute(context, uploadedId);

    const changed = await app.request(`${base}/changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_source_generation: 1,
        expected_commit_sha: f.head(),
        message: "Change",
        changes: [{ path: "main.ts", content_base64: "eQ==", executable: false }],
      }),
    });
    expect(changed.status).toBe(202);
    await f.port.execute(context, ((await changed.json()) as { id: string }).id);
    const restored = await app.request(`${base}:restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_source_generation: 1,
        expected_commit_sha: f.head(),
        restore_commit_sha: f.journals.get(op.id)?.commitSha,
        message: "Restore",
      }),
    });
    expect(restored.status).toBe(202);
    await f.port.execute(context, ((await restored.json()) as { id: string }).id);
    const github: ProjectSourceBinding = {
      provider: "github",
      sourceConnectionId: "00000000000000000000000005",
      generation: 4,
      commitSha: null,
      namespace: "customer",
      repositoryName: "application",
      status: "ready",
      linkedAt: NOW,
      updatedAt: NOW,
    };
    const switchFixture = fixture(github);
    const switchOp = await switchFixture.port.createUpload(switchFixture.mutation("switch"), {
      mode: "switch",
      expected_source_generation: 4,
      expected_source_connection_id: github.sourceConnectionId,
      expected_commit_sha: null,
      message: "Switch source",
    });
    const switchApp = new Hono();
    registerManagedSourceRoutes(
      switchApp,
      async (ctx, options) => {
        const parsed = await options.body(ctx, "req_test");
        if (parsed.outcome === "error") return parsed.response;
        const result = await options.invoke(
          { context, mutation: switchFixture.mutation(ctx.req.path) },
          parsed.value,
        );
        return result
          ? Response.json(result.body, { status: result.status })
          : new Response(null, { status: 404 });
      },
      switchFixture.port,
    );
    const switchResponse = await switchApp.request(`${base}:switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        upload_operation_id: switchOp.body["id"],
        expected_source_generation: 4,
        expected_source_connection_id: github.sourceConnectionId,
        files: [],
      }),
    });
    expect(switchResponse.status).toBe(202);
    await switchFixture.port.execute(context, String(switchOp.body["id"]));

    const sourceFallback = vi.fn(async () => ({
      status: 200 as const,
      body: {
        provider: "github",
        source_connection_id: environmentId,
        source_generation: 1,
        installation_id: "1",
        repository_full_name: "customer/application",
        status: "ready",
        linked_at: NOW,
        updated_at: NOW,
      },
    }));
    let createResponseOverrides: Record<string, unknown> = {};
    const createProject = vi.fn(async () => ({
      status: 202 as const,
      location: `/v1/operations/${environmentId}`,
      body: {
        id: environmentId,
        state: "queued" as const,
        created_at: NOW,
        updated_at: NOW,
        project_id: environmentId,
        ...createResponseOverrides,
      },
    }));
    const linkOperation = vi.fn(async () => ({
      status: 202 as const,
      location: `/v1/operations/${environmentId}`,
      body: { id: environmentId, state: "queued" as const, created_at: NOW, updated_at: NOW },
    }));
    const principal = {
      actorId: context.principalId,
      credentialId: "api_key:test",
      authorizationPrincipal: {
        kind: "user" as const,
        subjectId: context.principalId as `user:${string}`,
      },
      organizationIds: [organizationId],
    };
    const dependencies: ControlApiDependencies = {
      authentication: { authenticate: async () => principal },
      authorization: { check: async () => "allow" },
      persistence: {
        submitFeedback: async () => {
          throw new Error("unused");
        },
        readFeedbackStatus: async () => null,
        listProjects: async () => ({ projects: [], nextCursor: null }),
        takenProjectHandles: async () => new Set<string>(),
        createProject,
        getProject: async (org, id) =>
          org === organizationId && id === projectId
            ? {
                projectId,
                organizationId,
                name: "Application",
                handle: "calm-source-work",
                dataMode: "shared",
                region: "us",
                createdAt: NOW,
              }
            : null,
        getOperation: async () => null,
        readAuditEvents: async () => ({ events: [], nextCursor: null }),
      },
      productSurface: { ...createUnavailableProductSurfacePort(), getSource: sourceFallback },
      managedSources: f.port,
      providerReconciliation: createUnavailableProviderReconciliationPort(),
      environmentSecrets: createUnavailableEnvironmentSecretsPort(),
      projectMailDomains: createUnavailableProjectMailDomainsPort(),
      devAccessTickets: createUnavailableDevAccessTicketsPort(),
      clock: { now: () => new Date(NOW) },
      ids: { next: () => environmentId },
      allowedOrigins: new Set<string>(),
      applicationId: "managed-source-test",
      rateLimits: { consume: async () => ({ allowed: true }) },
      reporter: { report: () => undefined },
    };
    const actualApi = createControlApi(dependencies);
    const apiHeaders = {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
      "Idempotency-Key": "source-create",
    };
    const actualSource = await actualApi.request(base, { headers: apiHeaders });
    expect(actualSource.status).toBe(200);
    expect(await actualSource.json()).toMatchObject({
      provider: "managed",
      current_commit_sha: f.head(),
    });
    expect(sourceFallback).not.toHaveBeenCalled();
    expect((await actualApi.request(`${base}/files`, { headers: apiHeaders })).status).toBe(200);
    expect(
      (
        await actualApi.request(
          `https://api.test/v1/projects/00000000000000000000000099/source/files`,
          { headers: apiHeaders },
        )
      ).status,
    ).toBe(404);
    const projectBody = {
      organization_id: organizationId,
      name: "Application",
      source: { provider: "managed", template: "vite-react" },
    };
    expect(
      (
        await actualApi.request("https://api.test/v1/projects", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify(projectBody),
        })
      ).status,
    ).toBe(202);
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ source: projectBody.source, region: "us" }),
    );
    for (const fields of [{ state: "running" }, { blocking_operation_id: projectId }]) {
      createResponseOverrides = fields;
      const invalid = await actualApi.request("https://api.test/v1/projects", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify(projectBody),
      });
      expect.soft(invalid.status).toBe(503);
    }
    createResponseOverrides = {};
    expect(
      (
        await actualApi.request("https://api.test/v1/projects", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({
            ...projectBody,
            source: { ...projectBody.source, unknown: true },
          }),
        })
      ).status,
    ).toBe(400);
    const unavailable = createControlApi({ ...dependencies, managedSources: undefined });
    const before = createProject.mock.calls.length;
    expect(
      (
        await unavailable.request("https://api.test/v1/projects", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify(projectBody),
        })
      ).status,
    ).toBe(503);
    expect(createProject.mock.calls).toHaveLength(before);
    const defaultGithub = await unavailable.request(base, { headers: apiHeaders });
    expect(defaultGithub.status).toBe(200);
    expect(sourceFallback).toHaveBeenCalledTimes(1);
    const fullGithub = (await sourceFallback()).body;
    const legacyGithub = {
      provider: fullGithub.provider,
      installation_id: fullGithub.installation_id,
      repository_full_name: fullGithub.repository_full_name,
      status: fullGithub.status,
      linked_at: fullGithub.linked_at,
      updated_at: fullGithub.updated_at,
    };
    expect(await defaultGithub.json()).toEqual(legacyGithub);
    for (const [query, expected] of [
      ["include_binding=false", legacyGithub],
      ["include_binding=true", fullGithub],
    ] as const) {
      const response = await unavailable.request(`${base}?${query}`, { headers: apiHeaders });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    for (const query of [
      "include_binding=1",
      "include_binding=True",
      "include_binding=",
      "include_binding=true&include_binding=false",
      "unknown=true",
    ])
      expect((await unavailable.request(`${base}?${query}`, { headers: apiHeaders })).status).toBe(
        400,
      );
    const optInManaged = await actualApi.request(`${base}?include_binding=true`, {
      headers: apiHeaders,
    });
    expect(await optInManaged.json()).toEqual(await f.port.getSource(context).then((r) => r?.body));
    const projectStatus = {
      project_id: projectId,
      etag: `"sha256-${"a".repeat(64)}"`,
      handle: "calm-source-work",
      region: "us",
      dev_access_mode: "protected",
      lifecycle: "active",
      source: fullGithub,
      default_environment: null,
      head_deployment: null,
      dev_url: null,
      prod_url: null,
      latest_operation: null,
      cleanup_state: "not_started",
    };
    const preservedGitHub = createControlApi({
      ...dependencies,
      managedSources: undefined,
      productSurface: {
        ...dependencies.productSurface,
        getProjectStatus: async () => ({ status: 200, body: projectStatus }),
      },
      githubOrganizationConnection: {
        status: async () => {
          throw new Error("Unused status");
        },
        begin: async () => {
          throw new Error("Unused begin");
        },
        callback: async () => {
          throw new Error("Unused callback");
        },
        disconnect: async () => {
          throw new Error("Unused disconnect");
        },
        link: linkOperation,
      },
    });
    const statusReply = await preservedGitHub.request(
      `https://api.test/v1/projects/${projectId}/status`,
      { headers: apiHeaders },
    );
    expect(statusReply.status).toBe(200);
    expect(await statusReply.json()).toEqual({ ...projectStatus, source: legacyGithub });
    expect(projectStatus.source).toEqual(fullGithub);
    const linked = await preservedGitHub.request(`${base}:link`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ repository_owner: "customer", repository_name: "application" }),
    });
    expect(linked.status).toBe(202);
    expect(await linked.json()).toEqual((await linkOperation()).body);
    for (const invalidSource of [
      { ...fullGithub, source_generation: undefined },
      { ...fullGithub, token: "private" },
    ]) {
      const invalidProjection = createControlApi({
        ...dependencies,
        managedSources: undefined,
        productSurface: {
          ...dependencies.productSurface,
          getSource: async () => ({ status: 200, body: invalidSource }),
          getProjectStatus: async () => ({
            status: 200,
            body: { ...projectStatus, source: invalidSource },
          }),
        },
      });
      for (const url of [
        base,
        `${base}?include_binding=true`,
        `https://api.test/v1/projects/${projectId}/status`,
      ])
        expect((await invalidProjection.request(url, { headers: apiHeaders })).status).toBe(503);
    }
    const connect = {
      ...principal,
      credentialId: "connect:test",
      connectUser: {
        issuer: "https://issuer.test",
        audience: ["https://api.test/mcp"],
        clientId: "client_test",
        userId: "user_test",
        workosOrganizationId: null,
        consentId: "consent_test",
        tokenId: null,
        tokenExpiresAt: 9999999999,
      },
    };
    const deniedConnect = createControlApi({
      ...dependencies,
      authentication: { authenticate: async () => connect },
      remoteAuthorization: async () => false,
    });
    expect((await deniedConnect.request(`${base}/files`, { headers: apiHeaders })).status).toBe(
      404,
    );
    const deniedCreation = await deniedConnect.request("https://api.test/v1/projects", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify(projectBody),
    });
    expect(deniedCreation.status).toBe(403);
    const allowedConnect = createControlApi({
      ...dependencies,
      authentication: { authenticate: async () => connect },
      remoteAuthorization: async () => true,
      remoteDelegation: async () => ({
        grantId: "00000000-0000-0000-0000-000000000001",
        clientId: "client_test",
        consentHash: "f".repeat(64),
      }),
    });
    expect(
      (
        await allowedConnect.request("https://api.test/v1/projects", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify(projectBody),
        })
      ).status,
    ).toBe(202);
    expect(createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceDelegation: {
          clientId: "client_test",
          consentHash: createHash("sha256").update("consent_test").digest("hex"),
          action: "projects:create",
          authorizationRestriction: undefined,
        },
      }),
    );
    const unavailableDelegation = createControlApi({
      ...dependencies,
      authentication: { authenticate: async () => connect },
      remoteAuthorization: async () => true,
      remoteDelegation: async () => {
        throw new Error("Authorization store unavailable");
      },
    });
    expect((await unavailableDelegation.request(base, { headers: apiHeaders })).status).toBe(503);
    const revokedPending = createControlApi({
      ...dependencies,
      managedSources: {
        ...f.port,
        getSource: async () => {
          throw new database.ManagedSourceInitializationError("scope");
        },
      },
    });
    expect((await revokedPending.request(base, { headers: apiHeaders })).status).toBe(404);

    for (const [kind, status] of [
      ["limit", 413],
      ["scope", 404],
      ["expired", 409],
      ["identity", 409],
      ["commit", 409],
    ] as const) {
      const refusedUpload = createControlApi({
        ...dependencies,
        managedSources: {
          ...f.port,
          putBlob: async () => {
            throw new database.ManagedSourceReservationError(kind);
          },
        },
      });
      const response = await refusedUpload.request(`${base}/uploads/${uploadedId}/files`, {
        method: "PUT",
        headers: apiHeaders,
        body: JSON.stringify(blobRequest),
      });
      expect(response.status).toBe(status);
    }
    for (const [kind, code] of [
      ["expired", "source_upload_expired"],
      ["manifest", "source_snapshot_invalid"],
      ["operation", "source_upload_conflict"],
      ["state", "source_upload_conflict"],
      ["candidate", "source_upload_conflict"],
      ["generation", "source_generation_conflict"],
      ["commit", "source_commit_conflict"],
    ] as const) {
      const rejectedManifest = createControlApi({
        ...dependencies,
        managedSources: {
          ...f.port,
          commitUpload: async () => {
            throw new database.ManagedSourceConflictError(kind);
          },
        },
      });
      const response = await rejectedManifest.request(`${base}/uploads/${uploadedId}:commit`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ expected_source_generation: 1, files: [] }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code, retryable: false });
    }
  });
});
