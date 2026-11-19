import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitHttpRequest } from "isomorphic-git";
import {
  createManagedGitAdapter,
  ManagedGitError,
  type ManagedArtifactsBinding,
  type ManagedGitCommitMetadata,
} from "../src/managed-git.js";
import { ManagedGitMemoryFileSystem } from "../src/managed-git-filesystem.js";
import {
  createManagedGitRpc,
  type ManagedSourceBindings,
  type ManagedSourceStagingBucket,
} from "../src/managed-git-rpc.js";
import {
  createManagedSourceRuntime,
  isManagedSourceRequest,
} from "../src/managed-source-runtime.js";
import type { ManagedSourceRuntimeBindings } from "../src/managed-source-runtime.js";
import { viteEntries } from "./tar-fixture.js";
import { accountId, namespace, fixture, gitCommand } from "./support/git-artifacts.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public constructor(
      _context: unknown,
      public readonly env: unknown,
    ) {}
  },
}));

const metadata: ManagedGitCommitMetadata = {
  authorName: "ohmyho.st",
  authorEmail: "source@ohmyho.st",
  message: "Create application",
  timestampSeconds: 1_800_000_000,
  operationId: "operation-1",
};

const scope = {
  organizationId: "01J00000000000000000000000",
  billingEpochId: "01J00000000000000000000001",
  projectId: "01J00000000000000000000002",
  environmentId: "01J00000000000000000000003",
  operationId: "01J00000000000000000000004",
  sourceConnectionId: "01J00000000000000000000005",
};

function staging() {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array<ArrayBuffer>;
      customMetadata: Record<string, string>;
      version: string;
      httpEtag: string;
    }
  >();
  const bucket: ManagedSourceStagingBucket = {
    async delete(key) {
      objects.delete(key);
    },
    async get(key) {
      const row = objects.get(key);
      return row === undefined
        ? null
        : {
            key,
            ...row,
            size: row.bytes.byteLength,
            async arrayBuffer() {
              return row.bytes.slice().buffer;
            },
          };
    },
    async put(key, bytes, options) {
      if (objects.has(key)) return null;
      const row = {
        bytes: new Uint8Array(bytes),
        customMetadata: { ...options.customMetadata },
        version: "1".repeat(32),
        httpEtag: '"stage-etag"',
      };
      objects.set(key, row);
      return { key, version: row.version, httpEtag: row.httpEtag, size: bytes.byteLength };
    },
  };
  return { bucket, objects };
}

function managedBindings(
  binding: ManagedArtifactsBinding,
  bucket: ManagedSourceStagingBucket,
): ManagedSourceBindings {
  return {
    ARTIFACTS_US: binding,
    ARTIFACTS_EU: binding,
    MANAGED_ARTIFACTS_ACCOUNT_ID: accountId,
    MANAGED_ARTIFACTS_NAMESPACE_US: namespace,
    MANAGED_ARTIFACTS_NAMESPACE_EU: "test-eu",
    MANAGED_SOURCE_STAGING_US: bucket,
    MANAGED_SOURCE_STAGING_EU: bucket,
    BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-development",
    BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development-eu",
    SOURCE_FETCH_TIMEOUT_MS: "30000",
  };
}

function exactRequest(repoName: string, commitSha: string) {
  return {
    provider: "managed",
    ...scope,
    region: "us",
    idempotencyKey: "deploy:managed",
    commitSha,
    repository: {
      owner: namespace,
      name: repoName,
      externalRepositoryId: `${namespace}/${repoName}`,
    },
    grant: {
      status: "approved",
      grantId: "01J00000000000000000000006",
      grantedAt: "2026-08-19T18:00:00.000Z",
      organizationId: scope.organizationId,
      billingEpochId: scope.billingEpochId,
      projectId: scope.projectId,
      sourceConnectionId: scope.sourceConnectionId,
      installationId: null,
      repositoryId: `${namespace}/${repoName}`,
      owner: namespace,
      repository: repoName,
      permission: "contents:read",
      revokedAt: null,
    },
  };
}

async function unpack(bytes: Uint8Array) {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start: number, end: number) =>
      new TextDecoder().decode(header.subarray(start, end)).split("\0")[0] ?? "";
    const prefix = field(345, 500);
    const filePath = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 136), 8);
    if (header[156] !== 53) files.set(filePath, tar.slice(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe("Artifacts managed source", () => {
  it("commits real Git files, preserves exact versions, restores forward, and exports only deterministic source", async () => {
    const source = fixture();
    // Exercise the production HTTPS transport without crossing any external provider boundary.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const bytes =
        init.body === undefined
          ? undefined
          : new Uint8Array(await new Response(init.body).arrayBuffer());
      const request: GitHttpRequest = {
        url,
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(bytes === undefined
          ? {}
          : {
              body: (async function* () {
                yield bytes;
              })(),
            }),
      };
      const result = await source.http.request(request);
      const chunks: Uint8Array[] = [];
      if (result.body !== undefined) for await (const chunk of result.body) chunks.push(chunk);
      expect(init.redirect).toBe("manual");
      return new Response(Buffer.concat(chunks), {
        status: result.statusCode,
        headers: result.headers ?? {},
      });
    });
    try {
      const adapter = createManagedGitAdapter({ artifacts: source.binding, accountId, namespace });
      const repo = await adapter.ensureRepository({ name: "project-one", branch: "main" });
      expect(await adapter.ensureRepository({ name: "project-one", branch: "main" })).toEqual(repo);
      expect(await adapter.info("project-one")).toEqual(repo);
      expect(await adapter.head({ name: "project-one", branch: "main" })).toBeNull();
      const request = {
        name: "project-one",
        branch: "main",
        expectedHead: null,
        metadata,
        changes: [
          { path: "ohmyhost.yaml", content: "version: 1\n" },
          { path: ".gitignore", content: "src/\n" },
          { path: "src/main.ts", content: "export const version = 1;\n", executable: true },
          { path: "src/nested/feature.ts", content: "export const enabled = true;\n" },
          { path: "public/logo.bin", content: new Uint8Array([0, 1, 255]) },
          { path: `${"long/".repeat(25)}file.ts`, content: "export {};\n" },
        ],
      };
      const first = await adapter.prepareCommit(request);
      expect((await adapter.prepareCommit(request)).commitSha).toBe(first.commitSha);
      expect(first.treeSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(JSON.stringify(first)).not.toContain("art_v1");
      expect(await adapter.pushPrepared(first)).toBe(first.commitSha);
      expect(await adapter.head({ name: repo.name, branch: "main" })).toBe(first.commitSha);
      expect(
        (await adapter.readSnapshot({ name: repo.name, commitSha: first.commitSha })).find(
          (file) => file.path === "src/main.ts",
        )?.executable,
      ).toBe(true);
      expect(source.text(repo.name, "rev-parse", `${first.commitSha}^{tree}`).trim()).toBe(
        first.treeSha,
      );
      const secondRequest = {
        ...request,
        expectedHead: first.commitSha,
        metadata: {
          ...metadata,
          operationId: "operation-2",
          timestampSeconds: metadata.timestampSeconds + 1,
        },
        changes: [
          { path: "src/main.ts", content: "export const version = 2;\n" },
          { path: "src/nested/feature.ts", content: null },
          { path: "public/new.txt", content: "new" },
        ],
      };
      const second = await adapter.prepareCommit(secondRequest);
      expect((await adapter.prepareCommit(secondRequest)).commitSha).toBe(second.commitSha);
      await adapter.pushPrepared(second);
      expect(
        new TextDecoder().decode(
          (await adapter.readFile({
            name: repo.name,
            commitSha: first.commitSha,
            path: "src/main.ts",
          })) ?? new Uint8Array(),
        ),
      ).toContain("version = 1");
      expect(
        await adapter.readFile({
          name: repo.name,
          commitSha: second.commitSha,
          path: "src/nested/feature.ts",
        }),
      ).toBeNull();
      expect(
        (await adapter.listFiles({ name: repo.name, commitSha: second.commitSha })).map(
          (file) => file.path,
        ),
      ).toContain("src/main.ts");
      const history = await adapter.history({ name: repo.name, ref: "main", limit: 10 });
      expect(history.map((value) => value.hash)).toEqual([second.commitSha, first.commitSha]);
      expect(
        (await adapter.history({ name: repo.name, ref: second.commitSha, limit: 1, offset: 1 }))[0]
          ?.hash,
      ).toBe(first.commitSha);
      const restored = await adapter.prepareRestore({
        name: repo.name,
        branch: "main",
        expectedHead: second.commitSha,
        restoreCommitSha: first.commitSha,
        metadata: {
          ...metadata,
          operationId: "restore-1",
          timestampSeconds: metadata.timestampSeconds + 2,
        },
      });
      await adapter.pushPrepared(restored);
      expect(restored.parentSha).toBe(second.commitSha);
      expect(restored.treeSha).toBe(first.treeSha);
      const unchanged = await adapter.prepareCommit({
        name: repo.name,
        branch: "main",
        expectedHead: restored.commitSha,
        changes: [],
        metadata: { ...metadata, operationId: "unchanged" },
      });
      expect(unchanged.commitSha).toBe(restored.commitSha);
      expect(await adapter.pushPrepared(unchanged)).toBe(restored.commitSha);
      expect((await adapter.history({ name: repo.name, ref: "main" })).length).toBe(3);
      expect(
        await adapter.containsCommit({
          name: repo.name,
          branch: "main",
          headCommitSha: restored.commitSha,
          candidateCommitSha: first.commitSha,
        }),
      ).toBe(true);
      expect(
        await adapter.containsCommit({
          name: repo.name,
          branch: "main",
          headCommitSha: restored.commitSha,
          candidateCommitSha: "1".repeat(40),
        }),
      ).toBe(false);
      const orphan = new TextDecoder()
        .decode(
          gitCommand(source.root, [
            `--git-dir=${join(source.root, `${repo.name}.git`)}`,
            "-c",
            "user.name=Orphan fixture",
            "-c",
            "user.email=orphan@example.test",
            "commit-tree",
            first.treeSha,
            "-p",
            first.commitSha,
            "-m",
            "Unpublished candidate",
          ]),
        )
        .trim();
      expect(source.text(repo.name, "cat-file", "-t", orphan).trim()).toBe("commit");
      expect(
        await adapter.containsCommit({
          name: repo.name,
          branch: "main",
          headCommitSha: restored.commitSha,
          candidateCommitSha: orphan,
        }),
      ).toBe(false);
      await expect(
        adapter.containsCommit({
          name: repo.name,
          branch: "main",
          headCommitSha: first.commitSha,
          candidateCommitSha: first.commitSha,
        }),
      ).rejects.toMatchObject({ code: "managed_source_conflict" });
      await expect(
        adapter.containsCommit({
          name: repo.name,
          branch: "main",
          headCommitSha: restored.commitSha,
          candidateCommitSha: first.commitSha,
          maxCommits: 1,
        }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      const exported = await adapter.exportCommit({
        name: repo.name,
        commitSha: restored.commitSha,
      });
      expect(
        (await adapter.exportCommit({ name: repo.name, commitSha: restored.commitSha })).bytes,
      ).toEqual(exported.bytes);
      expect(exported.sha256).toBe(
        Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(exported.bytes))).toString(
          "hex",
        ),
      );
      const archived = await unpack(exported.bytes);
      expect(
        [...archived.keys()].some((key) => key.includes("/.git/") || key.endsWith("/.git")),
      ).toBe(false);
      expect(archived.get("source/public/logo.bin")).toEqual(new Uint8Array([0, 1, 255]));
      expect(new TextDecoder().decode(archived.get("source/src/main.ts"))).toContain("version = 1");
      expect(source.tokens.every((value) => value.ttl === 300)).toBe(true);
      expect(source.tokens.some((value) => value.scope === "read")).toBe(true);
      expect(source.requests.some((value) => value.body !== undefined)).toBe(true);
      // Production did not persist either credential or Authorization in Git source/config.
      expect(source.text(repo.name, "show", `${restored.commitSha}:.gitignore`)).toBe("src/\n");
      const stage = staging();
      const bindings = managedBindings(source.binding, stage.bucket);
      const rpc = createManagedGitRpc(bindings);
      const repository = { namespace, repositoryName: "rpc-project" };
      await rpc.managedGit("ensureRepository", { repository });
      expect(await rpc.managedGit("head", { repository })).toBeNull();
      const files = viteEntries()
        .filter((file) => file.content !== undefined)
        .map((file) => ({
          path: file.path.slice("fixture/".length),
          content_base64: Buffer.from(
            typeof file.content === "string" ? file.content : (file.content ?? new Uint8Array()),
          ).toString("base64"),
          executable: false,
        }));
      const prepared = (await rpc.managedGit("prepare", {
        repository,
        input: { expectedCommitSha: null, files, metadata },
      })) as { commitSha: string; treeSha: string; parentSha: null; providerState: unknown };
      // Prepare and push intentionally cross independent service invocations.
      await createManagedGitRpc(bindings).managedGit("push", { repository, prepared });
      const read = (await rpc.managedGit("files", {
        repository,
        commitSha: prepared.commitSha,
      })) as { path: string; bytes: Uint8Array; executable: boolean }[];
      expect(read.find((file) => file.path === "ohmyhost.yaml")?.bytes.byteLength).toBeGreaterThan(
        0,
      );
      const nextRpc = (await rpc.managedGit("prepare", {
        repository,
        input: {
          expectedCommitSha: prepared.commitSha,
          files: read.filter((file) => file.path !== "index.html"),
          metadata: { ...metadata, operationId: "rpc-2" },
        },
      })) as typeof prepared;
      await createManagedGitRpc(bindings).managedGit("push", { repository, prepared: nextRpc });
      const versions = (await rpc.managedGit("history", {
        repository,
        input: { beforeCommitSha: prepared.commitSha, limit: 10 },
      })) as { commitSha: string; message: string }[];
      expect(versions[0]?.commitSha).toBe(prepared.commitSha);
      expect(versions[0]?.message).not.toContain("Ohmyhost-Operation");
      const bytes = new TextEncoder().encode("uploaded-source");
      const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      const stagedInput = {
        ...scope,
        path: "src/file.ts",
        bytes,
        sha256: `sha256:${sha256}`,
        executable: false,
        region: "us",
      };
      const blob = (await rpc.managedBlob("put", stagedInput)) as {
        bucket: string;
        key: string;
        versionId: string;
        eTag: string;
      };
      expect(await rpc.managedBlob("put", stagedInput)).toEqual(blob);
      expect(
        await rpc.managedBlob("get", {
          ...scope,
          ...blob,
          path: stagedInput.path,
          sha256,
          byteLength: bytes.byteLength,
        }),
      ).toEqual(bytes);
      const buildScope = {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        operationId: scope.operationId,
      };
      const upload = {
        bucket: bindings.BUILD_OBJECTS_BUCKET_US,
        key: `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/input/source.tar.gz`,
        uploadId: "managed-upload",
        scope: buildScope,
      };
      let durableArchive: unknown = null;
      const build: ManagedSourceRuntimeBindings = {
        ...bindings,
        BINDING_REQUEST_TIMEOUT_MS: "5000",
        BUILD_RUNNER: {
          async observeArchive() {
            return durableArchive;
          },
          async beginArchive() {
            return upload;
          },
          async uploadArchivePart(input) {
            return {
              partNumber: input.partNumber,
              eTag: '"part"',
              checksumSha256: input.checksumSha256,
            };
          },
          async completeArchive(input) {
            durableArchive = {
              ...upload,
              versionId: "2".repeat(32),
              eTag: '"archive"',
              byteLength: input.byteLength,
              sourceSha256: input.sourceSha256,
            };
            delete (durableArchive as Record<string, unknown>)["uploadId"];
            return durableArchive;
          },
          async abortArchive() {},
        },
      };
      const runtime = createManagedSourceRuntime(build, {
        now: () => new Date("2026-10-06T00:00:00.000Z"),
      });
      const exact = exactRequest(repository.repositoryName, prepared.commitSha);
      expect(isManagedSourceRequest(exact)).toBe(true);
      expect(isManagedSourceRequest({ provider: "github" })).toBe(false);
      const inspection = await runtime.inspectExact(exact);
      expect(inspection.resolvedCommitSha).toBe(prepared.commitSha);
      // A compute-region move keeps the authenticated original Git namespace.
      const movedRuntime = createManagedSourceRuntime(
        {
          ...build,
          MANAGED_ARTIFACTS_NAMESPACE_US: "new-us",
          MANAGED_ARTIFACTS_NAMESPACE_EU: namespace,
          ARTIFACTS_US: undefined,
          ARTIFACTS_EU: bindings.ARTIFACTS_US,
        } as unknown as ManagedSourceRuntimeBindings,
        { now: () => new Date("2026-10-06T00:00:00.000Z") },
      );
      expect(await movedRuntime.inspectExact(exact)).toEqual(inspection);
      const acquisition = {
        ...exact,
        expectedSourceSha256: inspection.sourceSha256,
        knownArchiveSha256: null,
      };
      const receipt = await runtime.acquireExact(acquisition);
      expect((await movedRuntime.acquireExact(acquisition)).archive.bucket).toBe(
        bindings.BUILD_OBJECTS_BUCKET_US,
      );
      expect(receipt.repositoryId).toBe(`${namespace}/${repository.repositoryName}`);
      expect(receipt.archive.key).toBe(upload.key);
      expect((await runtime.acquireExact(acquisition)).archive.versionId).toBe(
        receipt.archive.versionId,
      );
      const { SourceFetcherService } = await import("../src/worker-main.js");
      const service = new SourceFetcherService({} as never, build as never);
      expect(await service.managedGit("head", { repository })).toBe(nextRpc.commitSha);
      expect(
        await service.managedGit("containsCommit", {
          repository,
          input: {
            branch: "main",
            headCommitSha: nextRpc.commitSha,
            candidateCommitSha: prepared.commitSha,
          },
        }),
      ).toBe(true);
      expect(
        await service.managedBlob("get", {
          ...scope,
          ...blob,
          path: stagedInput.path,
          sha256,
          byteLength: bytes.byteLength,
        }),
      ).toEqual(bytes);
      expect((await service.inspectExact(exact)).resolvedCommitSha).toBe(prepared.commitSha);
      expect((await service.acquireExact(acquisition)).sha256).toBe(inspection.sourceSha256);
      const ownedRepository = {
        namespace,
        repositoryName: `${scope.projectId.toLowerCase()}-${scope.sourceConnectionId.toLowerCase()}`,
      };
      await service.managedGit("ensureRepository", { repository: ownedRepository });
      await service.managedGit("deleteRepository", { repository: ownedRepository, ...scope });
      await service.managedGit("deleteRepository", { repository: ownedRepository, ...scope });
      expect(source.repos.has(ownedRepository.repositoryName)).toBe(false);
      const cleanup = {
        ...scope,
        region: "eu",
        blobs: [{ ...blob, path: stagedInput.path, sha256, byteLength: bytes.byteLength }],
      };
      const otherStage = staging();
      const movedCleanupRpc = createManagedGitRpc({
        ...bindings,
        MANAGED_SOURCE_STAGING_EU: otherStage.bucket,
      });
      await movedCleanupRpc.managedBlob("deleteOperation", cleanup);
      await service.managedBlob("deleteOperation", cleanup);
      expect(stage.objects.size).toBe(0);
      expect(otherStage.objects.size).toBe(0);
      await adapter.ensureRepository({ name: "empty-source", branch: "main" });
      const empty = await adapter.prepareCommit({
        name: "empty-source",
        branch: "main",
        expectedHead: null,
        changes: [],
        metadata,
      });
      expect(empty.commitSha).toMatch(/^(?!0{40}$)[0-9a-f]{40}$/u);
      expect(empty.treeSha).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      await adapter.pushPrepared(empty);
      expect(await adapter.listFiles({ name: "empty-source", commitSha: empty.commitSha })).toEqual(
        [],
      );
      expect(source.text("empty-source", "rev-parse", "main^{tree}").trim()).toBe(empty.treeSha);
      // One actual worst-case working-tree boundary, preserving production filesystem limits.
      const measuredFiles = new WeakMap<ManagedGitMemoryFileSystem, Map<string, number>>();
      let peakFilesystemBytes = 0;
      const realWrite = ManagedGitMemoryFileSystem.prototype.writeFile;
      const realUnlink = ManagedGitMemoryFileSystem.prototype.unlink;
      const writeProbe = vi
        .spyOn(ManagedGitMemoryFileSystem.prototype, "writeFile")
        .mockImplementation(async function (this: ManagedGitMemoryFileSystem, path, content) {
          await realWrite.call(this, path, content);
          const files = measuredFiles.get(this) ?? new Map<string, number>();
          files.set(
            path,
            typeof content === "string"
              ? new TextEncoder().encode(content).byteLength
              : content.byteLength,
          );
          measuredFiles.set(this, files);
          peakFilesystemBytes = Math.max(
            peakFilesystemBytes,
            [...files.values()].reduce((sum, length) => sum + length, 0),
          );
        });
      const unlinkProbe = vi
        .spyOn(ManagedGitMemoryFileSystem.prototype, "unlink")
        .mockImplementation(async function (this: ManagedGitMemoryFileSystem, path) {
          await realUnlink.call(this, path);
          measuredFiles.get(this)?.delete(path);
        });
      const fullTree = () =>
        Array.from({ length: 4 }, (_unused, index) => {
          const bytes = new Uint8Array(2 * 1024 * 1024);
          for (let offset = 0; offset < bytes.byteLength; offset += 65_536)
            crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
          return { path: `binary/part-${index}.bin`, content: bytes };
        });
      const boundaryStarted = performance.now();
      const transferStart = source.transfers.length;
      try {
        const publishFullTree = async (
          expectedHead: string | null,
          changes: ReturnType<typeof fullTree>,
          operationId: string,
        ) => {
          const writer = createManagedGitAdapter({
            artifacts: source.binding,
            accountId,
            namespace,
          });
          await writer.ensureRepository({ name: "full-boundary", branch: "main" });
          const candidate = await writer.prepareCommit({
            name: "full-boundary",
            branch: "main",
            expectedHead,
            changes,
            metadata: { ...metadata, operationId },
          });
          expect(candidate.totalBytes).toBe(8 * 1024 * 1024);
          await writer.pushPrepared(candidate);
          return candidate.commitSha;
        };
        const original = fullTree();
        const firstFull = await publishFullTree(null, original, "full-initial");
        const replacement = fullTree();
        const secondFull = await publishFullTree(firstFull, replacement, "full-replace");
        const restoreWriter = createManagedGitAdapter({
          artifacts: source.binding,
          accountId,
          namespace,
        });
        const restoredFull = await restoreWriter.prepareRestore({
          name: "full-boundary",
          branch: "main",
          expectedHead: secondFull,
          restoreCommitSha: firstFull,
          metadata: { ...metadata, operationId: "full-restore" },
        });
        expect(restoredFull.totalBytes).toBe(8 * 1024 * 1024);
        await restoreWriter.pushPrepared(restoredFull);
        const fullArchive = await restoreWriter.exportCommit({
          name: "full-boundary",
          commitSha: restoredFull.commitSha,
        });
        const extracted = await unpack(fullArchive.bytes);
        expect(extracted.size).toBe(4);
        for (const file of original)
          expect(extracted.get(`source/${file.path}`)).toEqual(file.content);
        const observedTransfers = source.transfers.slice(transferStart);
        const peakRequestBytes = Math.max(
          ...observedTransfers.map((transfer) => transfer.requestBytes),
        );
        const peakResponseBytes = Math.max(
          ...observedTransfers.map((transfer) => transfer.responseBytes),
        );
        expect(peakFilesystemBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
        expect(peakRequestBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
        expect(peakResponseBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
        console.info(
          JSON.stringify({
            acceptance: "full-managed-working-tree",
            treeBytes: 8 * 1024 * 1024,
            files: 4,
            fileBytes: 2 * 1024 * 1024,
            peakFilesystemBytes,
            peakRequestBytes,
            peakResponseBytes,
            archiveBytes: fullArchive.byteLength,
            elapsedMs: Math.round(performance.now() - boundaryStarted),
            v8PeakMeasured: false,
          }),
        );
      } finally {
        writeProbe.mockRestore();
        unlinkProbe.mockRestore();
      }
    } finally {
      vi.unstubAllGlobals();
      source.close();
    }
  }, 60_000);

  it("rejects concurrent stale writes, unsafe provider objects, bad identities, and bounded source growth", async () => {
    const source = fixture();
    try {
      const adapter = createManagedGitAdapter({
        artifacts: source.binding,
        accountId,
        namespace,
        http: source.http,
      });
      await adapter.ensureRepository({ name: "race", branch: "main" });
      const first = await adapter.prepareCommit({
        name: "race",
        branch: "main",
        expectedHead: null,
        metadata,
        changes: [{ path: "src/app.ts", content: "first" }],
      });
      await adapter.pushPrepared(first);
      const request = {
        name: "race",
        branch: "main",
        expectedHead: first.commitSha,
        metadata,
        changes: [{ path: "src/app.ts", content: "second" }],
      };
      const winner = await adapter.prepareCommit(request);
      const loser = await adapter.prepareCommit({
        ...request,
        metadata: { ...metadata, operationId: "another-operation" },
      });
      await adapter.pushPrepared(winner);
      await expect(adapter.pushPrepared(loser)).rejects.toMatchObject({
        code: "managed_source_conflict",
      });
      // Race after discovery: the real receive-pack rejects the stale old hash too.
      let changeDuringPush = false;
      let receivePackReport = "";
      const raced = createManagedGitAdapter({
        artifacts: source.binding,
        accountId,
        namespace,
        http: {
          request: async (input) => {
            if (changeDuringPush && input.url.endsWith("/git-receive-pack")) {
              changeDuringPush = false;
              source.text(
                "race",
                "update-ref",
                "refs/heads/main",
                first.commitSha,
                winner.commitSha,
              );
            }
            const result = await source.http.request(input);
            if (!input.url.endsWith("/git-receive-pack")) return result;
            const chunks: Uint8Array[] = [];
            if (result.body !== undefined)
              for await (const chunk of result.body) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            receivePackReport = new TextDecoder().decode(bytes);
            return {
              ...result,
              body: (async function* () {
                yield bytes;
              })(),
            };
          },
        },
      });
      const racedCandidate = await raced.prepareCommit({
        ...request,
        expectedHead: winner.commitSha,
        changes: [{ path: "src/app.ts", content: "raced-change" }],
      });
      changeDuringPush = true;
      const raceError = await raced.pushPrepared(racedCandidate).then(
        () => null,
        (error: unknown) => error,
      );
      expect(receivePackReport).toContain("unpack ok\n");
      expect(receivePackReport).toMatch(/ng refs\/heads\/main [^\n]+\n/u);
      expect(source.resolve("race", "main")).toBe(first.commitSha);
      expect(raceError).toMatchObject({
        code: "managed_source_conflict",
      });
      source.text("race", "update-ref", "refs/heads/main", winner.commitSha, first.commitSha);
      await expect(adapter.prepareCommit(request)).rejects.toMatchObject({
        code: "managed_source_conflict",
      });
      expect(await adapter.head({ name: "race", branch: "main" })).toBe(winner.commitSha);
      await expect(adapter.pushPrepared({ ...winner })).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      await expect(adapter.info("absent")).rejects.toMatchObject({
        code: "managed_source_not_found",
      });
      await expect(
        adapter.listFiles({ name: "race", commitSha: "1".repeat(40) }),
      ).rejects.toMatchObject({ code: "managed_source_not_found" });
      await expect(adapter.history({ name: "race", ref: "main", limit: 0 })).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      await expect(
        adapter.history({ name: "race", ref: "main", offset: -1 }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      for (const filePath of [
        "../escape",
        "/root",
        ".git/config",
        "src/.Git/token",
        "a\\b",
        "a\0b",
        "a//b",
        "é.ts",
      ]) {
        await expect(
          adapter.prepareCommit({ ...request, changes: [{ path: filePath, content: "data" }] }),
        ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      }
      for (const badMetadata of [
        { ...metadata, authorName: "injected\nheader" },
        { ...metadata, authorEmail: "bad" },
        { ...metadata, message: "" },
        { ...metadata, timestampSeconds: -1 },
        { ...metadata, operationId: "invalid id" },
      ]) {
        await expect(
          adapter.prepareCommit({ ...request, metadata: badMetadata }),
        ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      }
      await expect(
        adapter.prepareCommit({
          ...request,
          changes: [
            { path: "file", content: "a" },
            { path: "file", content: "b" },
          ],
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        adapter.prepareCommit({
          ...request,
          changes: [{ path: "huge", content: new Uint8Array(2 * 1024 * 1024 + 1) }],
        }),
      ).rejects.toMatchObject({ code: "managed_source_limit_exceeded" });
      await expect(
        adapter.prepareCommit({
          ...request,
          changes: Array.from({ length: 4001 }, (_v, index) => ({
            path: `f${index}`,
            content: "",
          })),
        }),
      ).rejects.toMatchObject({ code: "managed_source_limit_exceeded" });
      await expect(
        adapter.prepareCommit({
          ...request,
          expectedHead: winner.commitSha,
          changes: Array.from({ length: 5 }, (_v, index) => ({
            path: `f${index}`,
            content: new Uint8Array(2 * 1024 * 1024),
          })),
        }),
      ).rejects.toMatchObject({ code: "managed_source_limit_exceeded" });
      await expect(
        adapter.prepareCommit({
          ...request,
          expectedHead: winner.commitSha,
          changes: [{ path: "src", content: "conflicts with directory" }],
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      expect(() =>
        createManagedGitAdapter({ artifacts: source.binding, accountId: "bad", namespace }),
      ).toThrow(ManagedGitError);
      expect(() =>
        createManagedGitAdapter({ artifacts: source.binding, accountId, namespace, timeoutMs: 0 }),
      ).toThrow(ManagedGitError);
      const original = source.repos.get("race");
      if (original === undefined) throw new Error("test repo missing");
      source.repos.set("race", {
        ...original,
        info: async () => ({
          name: "race",
          defaultBranch: "main",
          remote: "https://attacker.test/private.git",
        }),
      });
      await expect(adapter.info("race")).rejects.toMatchObject({
        code: "managed_source_provider_invalid",
      });
      source.repos.set("race", {
        ...original,
        readTree: async () => [{ name: "link", hash: "2".repeat(40), mode: "120000" }],
      });
      await expect(
        adapter.exportCommit({ name: "race", commitSha: winner.commitSha }),
      ).rejects.toMatchObject({ code: "managed_source_provider_invalid" });
      source.repos.set("race", { ...original, readBlob: async () => new Blob(["tampered"]) });
      await expect(
        adapter.listFiles({ name: "race", commitSha: winner.commitSha }),
      ).rejects.toMatchObject({ code: "managed_source_provider_invalid" });
      source.repos.set("race", { ...original, log: async () => [{ hash: "invalid" }] });
      await expect(adapter.head({ name: "race", branch: "main" })).rejects.toMatchObject({
        code: "managed_source_provider_invalid",
      });
      source.repos.set("race", {
        ...original,
        createToken: async () => ({ plaintext: "secret-dont-print" }),
      });
      const tokenFailure = await adapter.pushPrepared(winner).catch((error: unknown) => error);
      expect(tokenFailure).toMatchObject({ code: "managed_source_provider_invalid" });
      expect(String(tokenFailure)).not.toContain("secret-dont-print");
      source.repos.set("race", original);
      const failing = createManagedGitAdapter({
        artifacts: {
          ...source.binding,
          get: async () => {
            throw new Error("private credential");
          },
        },
        accountId,
        namespace,
      });
      await expect(
        failing.ensureRepository({ name: "no-fallback", branch: "main" }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      expect(source.repos.has("no-fallback")).toBe(false);
      const uncertain = createManagedGitAdapter({
        artifacts: {
          ...source.binding,
          create: async () => {
            throw new Error("private credential");
          },
        },
        accountId,
        namespace,
      });
      await expect(
        uncertain.ensureRepository({ name: "unknown-create", branch: "main" }),
      ).rejects.toMatchObject({ code: "managed_source_result_uncertain" });
      const transportFailure = createManagedGitAdapter({
        artifacts: source.binding,
        accountId,
        namespace,
        http: {
          request: async () => {
            throw new Error("private token");
          },
        },
      });
      const forTransport = await adapter.prepareCommit({
        ...request,
        expectedHead: winner.commitSha,
      });
      // Opaque candidates belong to the adapter which prepared them.
      await expect(transportFailure.pushPrepared(forTransport)).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      await expect(
        transportFailure.prepareCommit({
          ...request,
          expectedHead: winner.commitSha,
          changes: [{ path: "src/app.ts", content: "transport-change" }],
        }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      const stage = staging();
      const rpcBindings = managedBindings(source.binding, stage.bucket);
      const rpc = createManagedGitRpc(rpcBindings);
      const repository = { namespace, repositoryName: "race" };
      let releaseRead: () => void = () => {};
      let markReadStarted: () => void = () => {};
      const pausedRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      let readCalls = 0;
      source.repos.set("race", {
        ...original,
        readBlob: async (sha) => {
          readCalls += 1;
          markReadStarted();
          await pausedRead;
          return original.readBlob(sha);
        },
      });
      const firstRead = rpc.managedGit("files", { repository, commitSha: winner.commitSha });
      await readStarted;
      await expect(
        createManagedGitRpc(rpcBindings).managedGit("files", {
          repository,
          commitSha: winner.commitSha,
        }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      expect(readCalls).toBe(1);
      releaseRead();
      await firstRead;
      source.repos.set("race", original);
      expect(
        ((await rpc.managedGit("files", { repository, commitSha: winner.commitSha })) as unknown[])
          .length,
      ).toBe(1);
      await expect(rpc.managedGit("bad-method", { repository })).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      await expect(rpc.managedGit("head", null)).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      await expect(
        rpc.managedGit("head", { repository: { namespace: "unbound", repositoryName: "race" } }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        createManagedGitRpc({
          ...rpcBindings,
          MANAGED_ARTIFACTS_NAMESPACE_US: undefined,
        } as unknown as ManagedSourceBindings).managedGit("head", { repository }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      await expect(
        rpc.managedGit("prepare", {
          repository,
          input: {
            expectedCommitSha: null,
            files: [{ path: "../escape", content_base64: "", executable: false }],
            metadata,
          },
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        rpc.managedGit("prepare", {
          repository,
          input: {
            expectedCommitSha: null,
            files: [{ path: "x", content_base64: "not base64", executable: false }],
            metadata,
          },
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        rpc.managedGit("history", { repository, input: { limit: 10, beforeCommitSha: "bad" } }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(rpc.managedGit("files", { repository })).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      const bytes = new TextEncoder().encode("stage-data");
      const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      const blobInput = {
        ...scope,
        path: "file.ts",
        bytes,
        sha256: `sha256:${sha256}`,
        executable: false,
        region: "eu",
      };
      const receipt = (await rpc.managedBlob("put", blobInput)) as {
        bucket: string;
        key: string;
        versionId: string;
        eTag: string;
      };
      await expect(
        rpc.managedGit("deleteRepository", { repository, ...scope }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await adapter.ensureRepository({ name: "retained", branch: "main" });
      const retained = createManagedGitAdapter({
        artifacts: { ...source.binding, delete: async () => false },
        accountId,
        namespace,
        http: source.http,
      });
      await expect(retained.deleteRepository("retained")).rejects.toMatchObject({
        code: "managed_source_result_uncertain",
      });
      expect(source.repos.has("retained")).toBe(true);
      // Neither an unreadable re-check nor a rejected delete, even one that took effect, proves
      // absence; only a later observation does.
      let reads = 0;
      for (const artifacts of [
        {
          ...source.binding,
          delete: async () => true,
          get: async (repo: string) => {
            reads += 1;
            if (reads > 1) throw new Error("private provider failure");
            return source.binding.get(repo);
          },
        },
        {
          ...source.binding,
          delete: async (repo: string) => {
            await source.binding.delete?.(repo);
            throw new Error("private provider failure");
          },
        },
      ])
        await expect(
          createManagedGitAdapter({ artifacts, accountId, namespace }).deleteRepository("retained"),
        ).rejects.toMatchObject({ code: "managed_source_result_uncertain" });
      expect([reads, source.repos.has("retained")]).toEqual([2, false]);
      await retained.deleteRepository("retained");
      await expect(
        rpc.managedBlob("deleteOperation", {
          ...scope,
          region: "eu",
          blobs: [
            {
              ...receipt,
              path: "file.ts",
              sha256,
              byteLength: bytes.length,
              versionId: "9".repeat(32),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      expect(stage.objects.size).toBe(1);
      await expect(
        rpc.managedBlob("put", { ...blobInput, sha256: `sha256:${"f".repeat(64)}` }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        rpc.managedBlob("get", {
          ...scope,
          ...receipt,
          organizationId: "01J00000000000000000000009",
          path: "file.ts",
          sha256,
          byteLength: bytes.length,
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        rpc.managedBlob("get", {
          ...scope,
          ...receipt,
          path: "file.ts",
          sha256,
          byteLength: bytes.length,
          versionId: "3".repeat(32),
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        rpc.managedBlob("get", {
          ...scope,
          ...receipt,
          path: "file.ts",
          sha256,
          byteLength: bytes.length,
          bucket: "other-bucket",
        }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(
        rpc.managedBlob("put", { ...blobInput, operationId: "bad" }),
      ).rejects.toMatchObject({ code: "managed_source_input_invalid" });
      await expect(rpc.managedBlob("get", null)).rejects.toMatchObject({
        code: "managed_source_input_invalid",
      });
      const disabledRpc = createManagedGitRpc({
        ...rpcBindings,
        MANAGED_SOURCE_STAGING_EU: undefined,
      } as unknown as ManagedSourceBindings);
      await expect(disabledRpc.managedBlob("put", blobInput)).rejects.toMatchObject({
        code: "managed_source_unavailable",
      });
      const runtimeBindings = {
        ...rpcBindings,
        BUILD_RUNNER: {} as never,
        BINDING_REQUEST_TIMEOUT_MS: "5000",
      };
      const runtime = createManagedSourceRuntime(runtimeBindings);
      const exact = exactRequest("race", winner.commitSha);
      await expect(
        runtime.inspectExact({
          ...exact,
          grant: { ...exact.grant, projectId: "01J00000000000000000000009" },
        }),
      ).rejects.toMatchObject({ code: "source_fetch_input_invalid" });
      await expect(
        runtime.inspectExact({ ...exact, grant: { ...exact.grant, installationId: 1 } }),
      ).rejects.toMatchObject({ code: "source_fetch_input_invalid" });
      await expect(runtime.acquireExact(exact)).rejects.toMatchObject({
        code: "source_fetch_input_invalid",
      });
      await expect(
        createManagedSourceRuntime({
          ...runtimeBindings,
          MANAGED_ARTIFACTS_NAMESPACE_US: undefined,
        } as unknown as ManagedSourceRuntimeBindings).inspectExact(exact),
      ).rejects.toMatchObject({ code: "source_fetch_configuration_unavailable" });
      await expect(
        createManagedSourceRuntime(runtimeBindings, {
          now: () => new Date(Number.NaN),
        }).inspectExact(exact),
      ).rejects.toMatchObject({ code: "source_fetch_configuration_unavailable" });
    } finally {
      source.close();
    }
  }, 30_000);

  it("bounds the request-local filesystem and leaves unavailable or ambiguous provider outcomes explicit", async () => {
    const fs = new ManagedGitMemoryFileSystem(16);
    await fs.mkdir("/workspace/a/b", { recursive: true });
    await fs.writeFile("/workspace/a/b/file", "hello");
    expect(await fs.promises.readFile("/workspace/a/b/file", "utf8")).toBe("hello");
    expect(await fs.readFile("/workspace/a/b/file", { encoding: "utf8" })).toBe("hello");
    expect(await fs.readFile("/workspace/a/b/file")).toEqual(new TextEncoder().encode("hello"));
    await fs.chmod("/workspace/a/b/file", 0o755);
    const stat = await fs.lstat("/workspace/a/b/file");
    expect([stat.isFile(), stat.isDirectory(), stat.isSymbolicLink(), stat.mode]).toEqual([
      true,
      false,
      false,
      0o100755,
    ]);
    expect((await fs.stat("/workspace")).isDirectory()).toBe(true);
    expect(await fs.readdir("/workspace/a/b")).toEqual(["file"]);
    await expect(fs.writeFile("/workspace/large", new Uint8Array(17))).rejects.toMatchObject({
      code: "ENOSPC",
    });
    await expect(fs.rmdir("/workspace/a/b")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await expect(fs.readFile("/workspace/a")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(fs.writeFile("/workspace/a", "x")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(fs.mkdir("/workspace/a/b/file")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.mkdir("/workspace/a")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.mkdir("/missing/parent")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.writeFile("/missing/file", "x")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile("relative")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(fs.readFile("/../../escape")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(fs.readlink()).rejects.toMatchObject({ code: "EINVAL" });
    await expect(fs.symlink()).rejects.toMatchObject({ code: "EPERM" });
    await fs.writeFile("/workspace/a/./b/../b/file", "short");
    await fs.unlink("/workspace/a/b/file");
    await fs.rmdir("/workspace/a/b");
    await expect(fs.stat("/workspace/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.unlink("/workspace/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.chmod("/workspace/missing", 0o755)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.rmdir("/workspace/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir("/workspace/missing")).rejects.toMatchObject({ code: "ENOENT" });
    // Exercise admission before candidate writes, without another large Git commit in group one.
    const excessivePaths = Array.from(
      { length: 2000 },
      (_value, index) => `dir-${String(index).padStart(4, "0")}/a/b/c/file.txt`,
    );
    const boundaryPaths = [...excessivePaths];
    boundaryPaths[1999] = "dir-1999/a/b/file.txt";
    const emptyBlobHash = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const snapshotSha = "f".repeat(40);
    let engineStarts = 0;
    const stopAtEngine = () => {
      engineStarts++;
      throw new ManagedGitError("managed_source_unavailable");
    };
    const treeBinding = (files: readonly string[], current: boolean): ManagedArtifactsBinding => {
      const nodes = new Map<string, { hash: string; entries: Map<string, unknown> }>();
      const node = (prefix: string) => {
        let value = nodes.get(prefix);
        if (value === undefined) {
          value = { hash: (nodes.size + 1).toString(16).padStart(40, "0"), entries: new Map() };
          nodes.set(prefix, value);
        }
        return value;
      };
      node("");
      for (const file of files) {
        const parts = file.split("/");
        let prefix = "";
        for (const [index, part] of parts.entries()) {
          const parent = node(prefix);
          if (index === parts.length - 1)
            parent.entries.set(part, { name: part, hash: emptyBlobHash, mode: "100644" });
          else {
            const child = prefix ? `${prefix}/${part}` : part;
            parent.entries.set(part, { name: part, hash: node(child).hash, mode: "40000" });
            prefix = child;
          }
        }
      }
      const commit = {
        hash: snapshotSha,
        treeHash: node("").hash,
        parents: [],
        author: { name: metadata.authorName, email: metadata.authorEmail },
        authoredAt: metadata.timestampSeconds,
        message: metadata.message,
      };
      const entriesByHash = new Map(
        [...nodes.values()].map((value) => [value.hash, [...value.entries.values()]]),
      );
      return {
        create: async () => {
          throw new Error("Unexpected repository creation");
        },
        get: async () => ({
          info: async () => ({
            name: "tree-limits",
            remote: `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/tree-limits.git`,
            defaultBranch: "main",
          }),
          log: async () => (current ? [commit] : []),
          readCommit: async () => commit,
          readTree: async (hash) => entriesByHash.get(hash) ?? [],
          readBlob: async () => new Blob([]),
          createToken: async () => stopAtEngine(),
        }),
      };
    };
    const request = {
      name: "tree-limits",
      branch: "main",
      expectedHead: null,
      metadata,
      changes: excessivePaths.map((path) => ({ path, content: new Uint8Array() })),
    };
    const candidateWrite = vi.spyOn(ManagedGitMemoryFileSystem.prototype, "writeFile");
    const candidateStart = vi
      .spyOn(ManagedGitMemoryFileSystem.prototype, "mkdir")
      .mockImplementation(async () => stopAtEngine());
    try {
      const empty = createManagedGitAdapter({
        artifacts: treeBinding([], false),
        accountId,
        namespace,
      });
      await expect(empty.prepareCommit(request)).rejects.toMatchObject({
        code: "managed_source_limit_exceeded",
      });
      expect(engineStarts).toBe(0);
      for (const paths of [
        boundaryPaths,
        excessivePaths.map((_path, index) => `file-${index}`),
        excessivePaths.map((_path, index) => `shared/a/b/c/file-${index}`),
      ]) {
        await expect(
          empty.prepareCommit({
            ...request,
            changes: paths.map((path) => ({ path, content: new Uint8Array() })),
          }),
        ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      }
      expect(engineStarts).toBe(3);
      const current = createManagedGitAdapter({
        artifacts: treeBinding(boundaryPaths, true),
        accountId,
        namespace,
      });
      const changes = [
        { path: "dir-1999/a/b/file.txt", content: null },
        { path: "dir-1999/a/b/c/file.txt", content: new Uint8Array() },
      ];
      await expect(
        current.prepareCommit({ ...request, expectedHead: snapshotSha, changes }),
      ).rejects.toMatchObject({ code: "managed_source_limit_exceeded" });
      expect(engineStarts).toBe(3);
      await expect(
        current.prepareCommit({
          ...request,
          expectedHead: snapshotSha,
          changes: [...changes, { path: "dir-0000/a/b/c/file.txt", content: null }],
        }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      expect(engineStarts).toBe(4);
      const restoring = createManagedGitAdapter({
        artifacts: treeBinding(boundaryPaths, false),
        accountId,
        namespace,
      });
      await expect(
        restoring.prepareRestore({
          name: request.name,
          branch: request.branch,
          expectedHead: null,
          restoreCommitSha: snapshotSha,
          metadata,
        }),
      ).rejects.toMatchObject({ code: "managed_source_unavailable" });
      expect(engineStarts).toBe(5);
      expect(candidateWrite).not.toHaveBeenCalled();
    } finally {
      candidateStart.mockRestore();
      candidateWrite.mockRestore();
    }
    const redirectSource = fixture();
    try {
      const redirectAdapter = createManagedGitAdapter({
        artifacts: redirectSource.binding,
        accountId,
        namespace,
      });
      await redirectAdapter.ensureRepository({ name: "redirect-probe", branch: "main" });
      const redirectCandidate = await redirectAdapter.prepareCommit({
        name: "redirect-probe",
        branch: "main",
        expectedHead: null,
        metadata,
        changes: [{ path: "file.txt", content: "source" }],
      });
      for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
        const requests: { origin: string; authorized: boolean }[] = [];
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
          expect(init.redirect).toBe("manual");
          requests.push({
            origin: new URL(url).origin,
            authorized: new Headers(init.headers).has("authorization"),
          });
          return new Response(null, {
            status,
            headers: { location: "https://unowned.example/credential-target" },
          });
        });
        await expect(redirectAdapter.pushPrepared(redirectCandidate)).rejects.toMatchObject({
          code: "managed_source_result_uncertain",
        });
        expect(requests).toEqual([
          { origin: `https://${accountId}.artifacts.cloudflare.net`, authorized: true },
        ]);
        expect(await redirectAdapter.head({ name: "redirect-probe", branch: "main" })).toBeNull();
      }
    } finally {
      vi.unstubAllGlobals();
      redirectSource.close();
    }
    const hanging: ManagedArtifactsBinding = {
      get: () => new Promise(() => {}),
      create: () => new Promise(() => {}),
    };
    const unavailable = createManagedGitAdapter({
      artifacts: hanging,
      accountId,
      namespace,
      timeoutMs: 5,
    });
    await expect(unavailable.info("timeout")).rejects.toMatchObject({
      code: "managed_source_unavailable",
    });
    const unknownCreate = createManagedGitAdapter({
      artifacts: {
        get: async () => {
          throw new Error("NOT_FOUND");
        },
        create: hanging.create,
      },
      accountId,
      namespace,
      timeoutMs: 5,
    });
    await expect(
      unknownCreate.ensureRepository({ name: "timeout", branch: "main" }),
    ).rejects.toMatchObject({ code: "managed_source_result_uncertain" });
    const emptySha = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array())).toString(
      "hex",
    );
    let releaseProvider: (value: null) => void = () => {};
    const pendingProvider = new Promise<null>((resolve) => {
      releaseProvider = resolve;
    });
    const hangingBucket: ManagedSourceStagingBucket = {
      get: () => pendingProvider,
      put: async () => {
        throw new Error("private R2 credential");
      },
    };
    const rpc = createManagedGitRpc({
      ...managedBindings(hanging, hangingBucket),
      SOURCE_FETCH_TIMEOUT_MS: "5",
    });
    await expect(
      rpc.managedBlob("get", {
        ...scope,
        path: "file",
        sha256: emptySha,
        byteLength: 0,
        bucket: "ohmyho-builds-development",
        key: `managed-staging/${scope.operationId}/${scope.organizationId}/${scope.projectId}/${emptySha}`,
        versionId: "1".repeat(32),
        eTag: '"stage"',
      }),
    ).rejects.toMatchObject({ code: "managed_source_unavailable" });
    let prohibitedGitCalls = 0;
    const competing = createManagedGitRpc({
      ...managedBindings(
        {
          ...hanging,
          get: async () => {
            prohibitedGitCalls += 1;
            throw new Error("must not start");
          },
        },
        hangingBucket,
      ),
      SOURCE_FETCH_TIMEOUT_MS: "5",
    });
    await expect(
      competing.managedGit("head", { repository: { namespace, repositoryName: "blocked" } }),
    ).rejects.toMatchObject({ code: "managed_source_unavailable" });
    expect(prohibitedGitCalls).toBe(0);
    releaseProvider(null);
    await pendingProvider;
    const failure = await rpc
      .managedBlob("put", {
        ...scope,
        path: "file",
        bytes: new Uint8Array(),
        sha256: emptySha,
        executable: false,
        region: "us",
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "managed_source_result_uncertain" });
    expect(String(failure)).not.toContain("private R2 credential");
  });
});

describe("managed Git refusals across the service binding", () => {
  it("carries the refusal code as the error message, the only part a service binding delivers", async () => {
    // The control API classifies a refused preparation by its message: the code must survive the binding.
    await expect(createManagedGitRpc({} as never).managedGit("prepare", {})).rejects.toMatchObject({
      code: "managed_source_input_invalid",
      message: "managed_source_input_invalid",
    });
  });
});
