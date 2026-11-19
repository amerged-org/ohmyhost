import { createHash } from "node:crypto";
import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import type { Context, Hono } from "hono";
import {
  MANAGED_SOURCE_LIMITS,
  assertManagedSourceResponse,
  managedSourcePathConflict,
  parseManagedSourceRequest,
  type ManagedSourceBlobRequest,
  type ManagedSourceChangesRequest,
  type ManagedSourceFinalizeRequest,
  type ManagedSourceInitializeRequest,
  type ManagedSourceRestoreRequest,
  type ManagedSourceSwitchRequest,
  type ManagedSourceUploadRequest,
  type SourceManifestFile,
} from "@ohmyhost/contracts/managed-sources";
import {
  ManagedSourceConflictError,
  ManagedSourceReservationError,
  type BeginManagedSourcePublicationInput,
  type ManagedSourceBlob,
  type ManagedSourcePublication,
  type ProjectSourceBinding,
  type ManagedSourceInitialization,
} from "@ohmyhost/database";
import {
  parseUlid,
  type AuthorizationAction,
  type Clock,
  type HostingRegion,
  type UlidFactory,
} from "@ohmyhost/platform";
import type {
  ProductSurfaceContext,
  ProductSurfaceMutationContext,
  ProductSurfaceResult,
} from "./contracts.js";
import { VITE_REACT_DEPENDENCY_FILES } from "./vite-react-template.js";

type Scope = ProductSurfaceContext;
type PublicationScope = Scope & { readonly operationId: string };
type BeginInput = BeginManagedSourcePublicationInput;
type Repo = { readonly namespace: string; readonly repositoryName: string };

export interface ManagedSourceGitFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export interface ManagedSourcePreparedCommit {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly parentSha: string | null;
  /** Opaque private provider input; never exposed through the public API. */
  readonly providerState: unknown;
}

export interface ManagedSourceGitPort {
  ensureRepository(repository: Repo): Promise<void>;
  head(repository: Repo): Promise<string | null>;
  files(repository: Repo, commitSha: string): Promise<readonly ManagedSourceGitFile[]>;
  history(
    repository: Repo,
    input: { readonly beforeCommitSha?: string; readonly limit: number },
  ): Promise<
    readonly {
      readonly commitSha: string;
      readonly parentSha: string | null;
      readonly message: string;
      readonly createdAt: string;
    }[]
  >;
  prepare(
    repository: Repo,
    input: {
      readonly expectedCommitSha: string | null;
      readonly files: readonly ManagedSourceGitFile[];
      readonly metadata: {
        readonly message: string;
        readonly operationId: string;
        readonly timestampSeconds: number;
      };
    },
  ): Promise<ManagedSourcePreparedCommit>;
  push(repository: Repo, prepared: ManagedSourcePreparedCommit): Promise<void>;
  /** Proves branch ancestry from the pinned main head; the existence of an orphan is insufficient. */
  containsCommit(
    repository: Repo,
    input: {
      readonly branch: "main";
      readonly headCommitSha: string;
      readonly candidateCommitSha: string;
      readonly maxCommits: number;
    },
  ): Promise<boolean>;
}

export interface ManagedSourceBlobPort {
  put(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly executable: boolean;
    readonly region: HostingRegion;
  }): Promise<Pick<ManagedSourceBlob, "bucket" | "key" | "versionId" | "eTag">>;
  get(
    input: ManagedSourceBlob & {
      readonly organizationId: string;
      readonly projectId: string;
      readonly operationId: string;
    },
  ): Promise<Uint8Array>;
}

/** All store methods authorize the live owner scope, including idempotent replays. */
export interface ManagedSourceStore {
  projectScope(
    context: Scope,
  ): Promise<{ readonly environmentId: string; readonly region: HostingRegion }>;
  binding(context: Scope): Promise<ProjectSourceBinding | null>;
  pendingInitialization?(context: Scope): Promise<ManagedSourceInitialization | null>;
  begin(input: BeginInput): Promise<ManagedSourcePublication>;
  publication(context: PublicationScope): Promise<ManagedSourcePublication | null>;
  reserveBlob(
    input: PublicationScope & {
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
      readonly executable: boolean;
      readonly now: string;
    },
  ): Promise<"created" | "replayed">;
  recordBlob(input: PublicationScope & ManagedSourceBlob & { readonly now: string }): Promise<void>;
  seal(
    input: PublicationScope & {
      readonly files: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly byteLength: number;
        readonly executable: boolean;
      }[];
      readonly manifestSha256: string;
      readonly now: string;
    },
  ): Promise<void>;
  prepared(
    input: PublicationScope & {
      readonly commitSha: string;
      readonly parentSha: string | null;
      readonly treeSha: string;
      readonly now: string;
    },
  ): Promise<void>;
  complete(
    input: PublicationScope & {
      readonly commitSha: string;
      readonly treeSha: string;
      readonly now: string;
      readonly eventId: string;
      readonly observedHeadCommitSha?: string;
    },
  ): Promise<ProjectSourceBinding>;
  fail(
    input: PublicationScope & {
      readonly errorCode: string;
      readonly now: string;
      readonly eventId: string;
    },
  ): Promise<void>;
  recordRequest(
    input: ProductSurfaceMutationContext & {
      readonly operationId: string;
      readonly httpMethod: "POST" | "PUT";
      readonly routeTemplate: string;
      readonly now: string;
    },
  ): Promise<"created" | "replayed">;
  operation(context: PublicationScope): Promise<ProductSurfaceResult>;
  /** Recheck membership, project binding and exclusions immediately before an external push. */
  authorizePublication(context: PublicationScope): Promise<void>;
}

export class ManagedSourceSurfaceError extends Error {
  constructor(
    readonly code:
      | "source_generation_conflict"
      | "source_commit_conflict"
      | "source_upload_conflict"
      | "source_upload_expired"
      | "source_scope_unavailable"
      | "source_snapshot_invalid"
      | "source_snapshot_too_large",
    readonly status: 404 | 409 | 413,
    message: string,
  ) {
    super(message);
    this.name = "ManagedSourceSurfaceError";
  }
}

/**
 * A file that is also another file's folder. The refusal repeats on every retry, unlike a receipt or
 * object read mismatch that may be transient, so only this marker fails a sealed snapshot once.
 */
class ManagedSourcePathConflictError extends ManagedSourceSurfaceError {
  constructor() {
    super(
      "source_snapshot_invalid",
      409,
      "A file and a folder in the snapshot have the same path. Rename one of them.",
    );
  }
}

/** The managed Git adapter refused the reconstructed input of a sealed snapshot: the same refusal repeats on every attempt. */
export class ManagedSourceGitInputRefusedError extends ManagedSourceSurfaceError {
  constructor() {
    super(
      "source_snapshot_invalid",
      409,
      "The source snapshot is not a valid input for the managed Git repository.",
    );
  }
}

export function createManagedSourceSurface(input: {
  readonly store: ManagedSourceStore;
  readonly git: ManagedSourceGitPort;
  readonly blobs: ManagedSourceBlobPort;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly namespaces: Readonly<Record<HostingRegion, string>>;
  /** Wake the durable outbox drain after sealing; its queued command survives this request. */
  readonly wake: () => Promise<void>;
  /** Remote client grants are checked again before push, after the durable store check. */
  readonly authorizeBeforePush?: (context: PublicationScope) => Promise<void>;
}) {
  const scope = (context: Scope, operationId: string): PublicationScope => ({
    ...context,
    operationId: parseUlid(operationId),
  });
  const publication = async (context: PublicationScope): Promise<ManagedSourcePublication> => {
    const row = await input.store.publication(context);
    if (!row)
      throw new ManagedSourceSurfaceError("source_scope_unavailable", 404, "Resource not found.");
    return row;
  };
  const managed = async (context: Scope): Promise<ProjectSourceBinding> => {
    const binding = await input.store.binding(context);
    if (!binding || binding.provider !== "managed" || binding.status !== "ready")
      throw new ManagedSourceSurfaceError(
        "source_scope_unavailable",
        404,
        "Managed source not found.",
      );
    return binding;
  };
  const start = async (
    context: ProductSurfaceMutationContext,
    request: ManagedSourceUploadRequest,
    routeTemplate: string,
    reservedSourceConnectionId?: string,
  ) => {
    parseManagedSourceRequest("upload", request);
    const project = await input.store.projectScope(context);
    const binding = await input.store.binding(context);
    const sourceConnectionId =
      request.mode === "commit" && binding
        ? binding.sourceConnectionId
        : reservedSourceConnectionId === undefined
          ? input.ids.next()
          : parseUlid(reservedSourceConnectionId);
    const now = input.clock.now().toISOString();
    return input.store.begin({
      ...context,
      environmentId: project.environmentId,
      operationId: input.ids.next(),
      operationEventId: input.ids.next(),
      auditEventId: input.ids.next(),
      outboxEventId: input.ids.next(),
      sourceConnectionId,
      mode: request.mode,
      expectedSourceConnectionId: request.expected_source_connection_id,
      expectedSourceGeneration: request.expected_source_generation,
      expectedManagedCommit: request.expected_commit_sha,
      namespace:
        request.mode === "commit" && binding ? binding.namespace : input.namespaces[project.region],
      repositoryName:
        request.mode === "commit" && binding
          ? binding.repositoryName
          : `${context.projectId.toLowerCase()}-${sourceConnectionId.toLowerCase()}`,
      message: request.message,
      routeTemplate,
      now,
      expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
    } as BeginInput);
  };
  const put = async (
    context: PublicationScope,
    request: ManagedSourceBlobRequest,
  ): Promise<SourceManifestFile> => {
    parseManagedSourceRequest("blob", request);
    const row = await publication(context);
    const bytes = decode(request.content_base64);
    const digest = hash(bytes);
    if (digest !== request.sha256)
      throw new ManagedSourceSurfaceError(
        "source_snapshot_invalid",
        409,
        "The uploaded file does not match its content hash.",
      );
    const existing = row.blobs.find((blob) => blob.path === request.path);
    if (existing) {
      if (
        `sha256:${existing.sha256}` !== digest ||
        existing.byteLength !== bytes.byteLength ||
        existing.executable !== request.executable
      )
        throw new ManagedSourceSurfaceError(
          "source_upload_conflict",
          409,
          "A different file already occupies this immutable upload path.",
        );
    } else {
      assertStaging(row, input.clock.now());
      if (
        row.blobs.length >= MANAGED_SOURCE_LIMITS.files ||
        row.blobs.reduce((total, blob) => total + blob.byteLength, 0) + bytes.byteLength >
          MANAGED_SOURCE_LIMITS.treeBytes
      )
        throw new ManagedSourceSurfaceError(
          "source_snapshot_too_large",
          413,
          "The staged source snapshot exceeds 8 MiB or 2,000 files.",
        );
      const project = await input.store.projectScope(context);
      await input.store.reserveBlob({
        ...context,
        path: request.path,
        sha256: digest.slice(7),
        byteLength: bytes.byteLength,
        executable: request.executable,
        now: input.clock.now().toISOString(),
      });
      const receipt = await input.blobs.put({
        organizationId: context.organizationId,
        projectId: context.projectId,
        operationId: row.operationId,
        path: request.path,
        bytes,
        sha256: digest,
        executable: request.executable,
        region: project.region,
      });
      await input.store.recordBlob({
        ...context,
        ...receipt,
        path: request.path,
        sha256: digest.slice(7),
        byteLength: bytes.byteLength,
        executable: request.executable,
        now: input.clock.now().toISOString(),
      });
    }
    return {
      path: request.path,
      sha256: digest,
      byte_length: bytes.byteLength,
      executable: request.executable,
    };
  };
  const seal = async (
    context: PublicationScope,
    request: ManagedSourceFinalizeRequest,
    switchConnectionId?: string,
  ): Promise<ProductSurfaceResult> => {
    parseManagedSourceRequest("finalize", request);
    const row = await publication(context);
    if (
      row.expectedSourceGeneration !== request.expected_source_generation ||
      (switchConnectionId !== undefined &&
        (row.mode !== "switch" || row.expectedSourceConnectionId !== switchConnectionId)) ||
      (switchConnectionId === undefined && row.mode === "switch")
    )
      throw new ManagedSourceSurfaceError(
        "source_generation_conflict",
        409,
        "The snapshot belongs to a different source binding.",
      );
    const files = [...request.files].sort(comparePath).map((file) => ({
      path: file.path,
      sha256: file.sha256.slice(7),
      byteLength: file.byte_length,
      executable: file.executable,
    }));
    const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    if (row.state === "committed") {
      if (row.manifestDigest !== digest)
        throw new ManagedSourceSurfaceError(
          "source_upload_conflict",
          409,
          "This upload already committed a different snapshot.",
        );
      return input.store.operation(context);
    }
    if (row.state === "failed")
      throw new ManagedSourceSurfaceError(
        "source_upload_conflict",
        409,
        "This source upload failed. Start a new upload.",
      );
    await input.store.seal({
      ...context,
      files,
      manifestSha256: digest,
      now: input.clock.now().toISOString(),
    });
    await input.wake();
    return input.store.operation(context);
  };
  const stageFiles = async (context: PublicationScope, files: readonly ManagedSourceGitFile[]) => {
    validateFiles(files);
    const manifest: SourceManifestFile[] = [];
    for (const file of [...files].sort(comparePath))
      manifest.push(
        await put(context, {
          path: file.path,
          content_base64: Buffer.from(file.bytes).toString("base64"),
          sha256: hash(file.bytes),
          executable: file.executable,
        }),
      );
    return manifest;
  };
  const finishObservedCandidate = async (
    context: PublicationScope,
    row: ManagedSourcePublication,
    observed: string | null,
  ): Promise<boolean> => {
    if (row.commitSha === null || observed === null) return false;
    if (
      observed !== row.commitSha &&
      !(await input.git.containsCommit(row, {
        branch: "main",
        headCommitSha: observed,
        candidateCommitSha: row.commitSha,
        maxCommits: 1000,
      }))
    )
      return false;
    if ((await input.git.head(row)) !== observed)
      throw new ManagedSourceSurfaceError(
        "source_commit_conflict",
        409,
        "The branch changed while its recorded commit was being observed. Observe the same operation again.",
      );
    await input.store.complete({
      ...context,
      commitSha: row.commitSha,
      treeSha: row.treeSha ?? "",
      now: input.clock.now().toISOString(),
      eventId: input.ids.next(),
      observedHeadCommitSha: observed,
    });
    return true;
  };

  return {
    async getSource(context: Scope): Promise<ProductSurfaceResult | null> {
      const binding = await input.store.binding(context);
      if (!binding) {
        const pending = await input.store.pendingInitialization?.(context);
        if (!pending) return null;
        const body = {
          provider: "managed",
          source_connection_id: pending.sourceConnectionId,
          source_generation: 0,
          namespace: input.namespaces[pending.region],
          repository_name: `${context.projectId.toLowerCase()}-${pending.sourceConnectionId.toLowerCase()}`,
          branch: "main",
          current_commit_sha: null,
          status: pending.state === "failed" ? "failed" : "pending",
          linked_at: pending.createdAt,
          updated_at: pending.updatedAt,
          ...(pending.childOperationId === null
            ? {}
            : { initialization_operation_id: pending.childOperationId }),
          ...(pending.errorCode === null
            ? {}
            : { initialization_error_code: publicOperationFailure(pending.errorCode).code }),
        };
        assertManagedSourceResponse("source", body);
        return { status: 200, body };
      }
      if (binding.provider !== "managed") return null;
      const body = {
        provider: "managed",
        source_connection_id: binding.sourceConnectionId,
        source_generation: binding.generation,
        namespace: binding.namespace,
        repository_name: binding.repositoryName,
        branch: "main",
        current_commit_sha:
          binding.status === "ready" ? await input.git.head(binding) : binding.commitSha,
        status: binding.status,
        linked_at: binding.linkedAt,
        updated_at: binding.updatedAt,
      };
      assertManagedSourceResponse("source", body);
      return { status: 200, body };
    },
    async files(
      context: Scope,
      request: { readonly commit_sha?: string; readonly path?: string },
    ): Promise<ProductSurfaceResult | null> {
      const binding = await managed(context);
      const commitSha = request.commit_sha ?? (await input.git.head(binding));
      if (commitSha === null) return null;
      const files = await input.git.files(binding, commitSha);
      validateFiles(files);
      if (request.path !== undefined) {
        const file = files.find((candidate) => candidate.path === request.path);
        if (!file) return null;
        const body = {
          commit_sha: commitSha,
          file: {
            ...fileManifest(file),
            content_base64: Buffer.from(file.bytes).toString("base64"),
          },
        };
        assertManagedSourceResponse("files", body);
        return { status: 200, body };
      }
      const body = { commit_sha: commitSha, files: [...files].sort(comparePath).map(fileManifest) };
      assertManagedSourceResponse("files", body);
      return { status: 200, body };
    },
    async versions(
      context: Scope,
      request: { readonly limit: number; readonly before_commit_sha?: string },
    ): Promise<ProductSurfaceResult> {
      const binding = await managed(context);
      const versions = await input.git.history(binding, {
        limit: request.limit + 1,
        ...(request.before_commit_sha ? { beforeCommitSha: request.before_commit_sha } : {}),
      });
      const body = {
        versions: versions.slice(0, request.limit).map((version) => ({
          commit_sha: version.commitSha,
          parent_commit_sha: version.parentSha,
          message: version.message,
          created_at: version.createdAt,
        })),
        next_commit_sha:
          versions.length > request.limit ? (versions[request.limit]?.commitSha ?? null) : null,
      };
      assertManagedSourceResponse("versions", body);
      return { status: 200, body };
    },
    async diff(
      context: Scope,
      request: { readonly from_commit_sha: string; readonly to_commit_sha: string },
    ): Promise<ProductSurfaceResult> {
      const binding = await managed(context);
      const beforeFiles = await input.git.files(binding, request.from_commit_sha),
        afterFiles = await input.git.files(binding, request.to_commit_sha);
      validateFiles(beforeFiles);
      validateFiles(afterFiles);
      const before = new Map(beforeFiles.map((file) => [file.path, fileManifest(file)])),
        after = new Map(afterFiles.map((file) => [file.path, fileManifest(file)]));
      const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
        const previous = before.get(path),
          next = after.get(path);
        if (previous?.sha256 === next?.sha256 && previous?.executable === next?.executable)
          return [];
        return [
          {
            path,
            change: previous === undefined ? "added" : next === undefined ? "deleted" : "modified",
            before_sha256: previous?.sha256 ?? null,
            after_sha256: next?.sha256 ?? null,
            before_executable: previous?.executable ?? null,
            after_executable: next?.executable ?? null,
          },
        ];
      });
      const body = { ...request, changes };
      assertManagedSourceResponse("diff", body);
      return { status: 200, body };
    },
    async createUpload(
      context: ProductSurfaceMutationContext,
      request: ManagedSourceUploadRequest,
    ): Promise<ProductSurfaceResult> {
      const row = await start(context, request, "/v1/projects/{project_id}/source/uploads");
      return input.store.operation(scope(context, row.operationId));
    },
    async getUpload(context: Scope, operationId: string): Promise<ProductSurfaceResult | null> {
      const row = await input.store.publication(scope(context, operationId));
      if (!row) return null;
      const body = {
        operation_id: row.operationId,
        state: row.state,
        expected_source_generation: row.expectedSourceGeneration,
        expected_commit_sha: row.expectedManagedCommit,
        commit_sha: row.commitSha,
        expires_at: row.expiresAt,
      };
      assertManagedSourceResponse("upload", body);
      return { status: 200, body };
    },
    async putBlob(
      context: ProductSurfaceMutationContext,
      operationId: string,
      request: ManagedSourceBlobRequest,
    ): Promise<ProductSurfaceResult> {
      await input.store.recordRequest({
        ...context,
        operationId,
        httpMethod: "PUT",
        routeTemplate: "/v1/projects/{project_id}/source/uploads/{operation_id}/files",
        now: input.clock.now().toISOString(),
      });
      return { status: 200, body: { ...(await put(scope(context, operationId), request)) } };
    },
    async commitUpload(
      context: ProductSurfaceMutationContext,
      operationId: string,
      request: ManagedSourceFinalizeRequest,
    ): Promise<ProductSurfaceResult> {
      await input.store.recordRequest({
        ...context,
        operationId,
        httpMethod: "POST",
        routeTemplate: "/v1/projects/{project_id}/source/uploads/{operation_id}:commit",
        now: input.clock.now().toISOString(),
      });
      return seal(scope(context, operationId), request);
    },
    async switchSource(
      context: ProductSurfaceMutationContext,
      request: ManagedSourceSwitchRequest,
    ): Promise<ProductSurfaceResult> {
      parseManagedSourceRequest("switch", request);
      await input.store.recordRequest({
        ...context,
        operationId: request.upload_operation_id,
        httpMethod: "POST",
        routeTemplate: "/v1/projects/{project_id}/source:switch",
        now: input.clock.now().toISOString(),
      });
      return seal(
        scope(context, request.upload_operation_id),
        { files: request.files, expected_source_generation: request.expected_source_generation },
        request.expected_source_connection_id,
      );
    },
    async initialize(
      context: ProductSurfaceMutationContext & { readonly reservedSourceConnectionId?: string },
      request: ManagedSourceInitializeRequest,
    ): Promise<ProductSurfaceResult> {
      parseManagedSourceRequest("initialize", request);
      const row = await start(
        context,
        {
          mode: "initialize",
          expected_source_connection_id: null,
          expected_source_generation: request.expected_source_generation,
          expected_commit_sha: null,
          message: "Create application",
        },
        "/v1/projects/{project_id}/source:initialize",
        context.reservedSourceConnectionId,
      );
      const publicationScope = scope(context, row.operationId);
      if (row.state !== "staging") return input.store.operation(publicationScope);
      const files = request.template === "empty" ? [] : viteReactFiles();
      return seal(publicationScope, {
        files: await stageFiles(publicationScope, files),
        expected_source_generation: request.expected_source_generation,
      });
    },
    async changes(
      context: ProductSurfaceMutationContext,
      request: ManagedSourceChangesRequest,
    ): Promise<ProductSurfaceResult> {
      parseManagedSourceRequest("changes", request);
      const binding = await managed(context);
      // The base commit is read before a publication opens, so an unreadable base leaves nothing staging.
      const base =
        request.expected_commit_sha === null
          ? []
          : await input.git.files(binding, request.expected_commit_sha);
      const row = await start(
        context,
        {
          mode: "commit",
          expected_source_connection_id: binding.sourceConnectionId,
          expected_source_generation: request.expected_source_generation,
          expected_commit_sha: request.expected_commit_sha,
          message: request.message,
        },
        "/v1/projects/{project_id}/source/changes",
      );
      const publicationScope = scope(context, row.operationId);
      if (row.state !== "staging") return input.store.operation(publicationScope);
      try {
        const files = new Map(base.map((file) => [file.path, file]));
        for (const change of request.changes) {
          if (change.content_base64 === null) files.delete(change.path);
          else
            files.set(change.path, {
              path: change.path,
              bytes: decode(change.content_base64),
              executable: change.executable,
            });
        }
        return await seal(publicationScope, {
          files: await stageFiles(publicationScope, [...files.values()]),
          expected_source_generation: request.expected_source_generation,
        });
      } catch (error) {
        if (error instanceof ManagedSourceReservationError && error.kind === "commit")
          await input.store.fail({
            ...publicationScope,
            errorCode: "SOURCE_COMMIT_CONFLICT",
            now: input.clock.now().toISOString(),
            eventId: input.ids.next(),
          });
        if (
          error instanceof ManagedSourceSurfaceError &&
          (error.code === "source_snapshot_invalid" || error.code === "source_snapshot_too_large")
        )
          await input.store.fail({
            ...publicationScope,
            errorCode: "SOURCE_SNAPSHOT_INVALID",
            now: input.clock.now().toISOString(),
            eventId: input.ids.next(),
          });
        throw error;
      }
    },
    async restore(
      context: ProductSurfaceMutationContext,
      request: ManagedSourceRestoreRequest,
    ): Promise<ProductSurfaceResult> {
      parseManagedSourceRequest("restore", request);
      const binding = await managed(context);
      // The restored version is read and checked before a publication opens: an unreadable commit
      // must not leave a staging publication and running operation that block the project.
      const files = await input.git.files(binding, request.restore_commit_sha);
      validateFiles(files);
      const row = await start(
        context,
        {
          mode: "commit",
          expected_source_connection_id: binding.sourceConnectionId,
          expected_source_generation: request.expected_source_generation,
          expected_commit_sha: request.expected_commit_sha,
          message: request.message,
        },
        "/v1/projects/{project_id}/source:restore",
      );
      const publicationScope = scope(context, row.operationId);
      if (row.state !== "staging") return input.store.operation(publicationScope);
      return seal(publicationScope, {
        files: await stageFiles(publicationScope, files),
        expected_source_generation: request.expected_source_generation,
      });
    },
    /** Called by the durable outbox consumer; uncertain provider outcomes stay sealed for observation. */
    async execute(
      context: Scope,
      operationId: string,
    ): Promise<"staging" | "committed" | "failed"> {
      const publicationScope = scope(context, operationId);
      try {
        const row = await publication(publicationScope);
        if (row.state !== "sealed") return row.state;
        if (row.commitSha === null) {
          await input.store.authorizePublication(publicationScope);
          await input.authorizeBeforePush?.(publicationScope);
          await input.git.ensureRepository(row);
        }
        const observed = await input.git.head(row);
        if (await finishObservedCandidate(publicationScope, row, observed)) return "committed";
        if (observed !== row.expectedManagedCommit) {
          await input.store.fail({
            ...publicationScope,
            errorCode: "SOURCE_COMMIT_CONFLICT",
            now: input.clock.now().toISOString(),
            eventId: input.ids.next(),
          });
          return "failed";
        }
        const files: ManagedSourceGitFile[] = [];
        for (const manifest of row.files) {
          const blob = row.blobs.find((candidate) => candidate.path === manifest.path);
          if (
            !blob ||
            blob.sha256 !== manifest.sha256 ||
            blob.byteLength !== manifest.byteLength ||
            blob.executable !== manifest.executable
          )
            throw new ManagedSourceSurfaceError(
              "source_snapshot_invalid",
              409,
              "The sealed snapshot has no matching immutable file receipt.",
            );
          const bytes = await input.blobs.get({
            ...blob,
            organizationId: context.organizationId,
            projectId: context.projectId,
            operationId: row.operationId,
          });
          if (bytes.byteLength !== blob.byteLength || hash(bytes) !== `sha256:${blob.sha256}`)
            throw new ManagedSourceSurfaceError(
              "source_snapshot_invalid",
              409,
              "The source object no longer matches its immutable receipt.",
            );
          files.push({ path: manifest.path, bytes, executable: manifest.executable });
        }
        validateFiles(files);
        const prepared = await input.git.prepare(row, {
          expectedCommitSha: row.expectedManagedCommit,
          files,
          metadata: {
            message: row.message,
            operationId: row.operationId,
            timestampSeconds: Math.floor(Date.parse(row.createdAt) / 1000),
          },
        });
        if (
          row.commitSha !== null &&
          (prepared.commitSha !== row.commitSha || prepared.treeSha !== row.treeSha)
        )
          throw new ManagedSourceSurfaceError(
            "source_snapshot_invalid",
            409,
            "The reconstructed candidate does not match the recorded commit.",
          );
        await input.store.prepared({
          ...publicationScope,
          commitSha: prepared.commitSha,
          parentSha: prepared.parentSha,
          treeSha: prepared.treeSha,
          now: input.clock.now().toISOString(),
        });
        await input.store.authorizePublication(publicationScope);
        await input.authorizeBeforePush?.(publicationScope);
        await input.git.push(row, prepared);
        const pushed = await input.git.head(row);
        if (pushed !== prepared.commitSha)
          throw new ManagedSourceSurfaceError(
            "source_commit_conflict",
            409,
            "The Git push outcome requires observation before retry.",
          );
        await input.store.complete({
          ...publicationScope,
          commitSha: prepared.commitSha,
          treeSha: prepared.treeSha,
          now: input.clock.now().toISOString(),
          eventId: input.ids.next(),
        });
        return "committed";
      } catch (error) {
        if (
          error instanceof ManagedSourcePathConflictError ||
          error instanceof ManagedSourceGitInputRefusedError
        ) {
          // Refused before any candidate exists, and a retry repeats the refusal: fail it once.
          const refused = await publication(publicationScope);
          if (refused.state !== "sealed") return refused.state;
          if (refused.commitSha !== null) throw error;
          await input.store.fail({
            ...publicationScope,
            errorCode: "SOURCE_SNAPSHOT_INVALID",
            now: input.clock.now().toISOString(),
            eventId: input.ids.next(),
          });
          return "failed";
        }
        if (!(error instanceof ManagedSourceConflictError) || error.kind !== "commit") throw error;
        const latest = await publication(publicationScope);
        if (latest.state !== "sealed") return latest.state;
        if (
          latest.commitSha !== null &&
          (await finishObservedCandidate(publicationScope, latest, await input.git.head(latest)))
        )
          return "committed";
        await input.store.fail({
          ...publicationScope,
          errorCode: "SOURCE_COMMIT_CONFLICT",
          now: input.clock.now().toISOString(),
          eventId: input.ids.next(),
        });
        return "failed";
      }
    },
  };
}

function comparePath(a: { readonly path: string }, b: { readonly path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function fileManifest(file: ManagedSourceGitFile): SourceManifestFile {
  return {
    path: file.path,
    sha256: hash(file.bytes),
    byte_length: file.bytes.byteLength,
    executable: file.executable,
  };
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decode(content: string): Uint8Array {
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content)
    throw new ManagedSourceSurfaceError(
      "source_snapshot_invalid",
      409,
      "Source content must use canonical base64.",
    );
  return bytes;
}

function validateFiles(files: readonly ManagedSourceGitFile[]): void {
  // A file that is also another file's folder is a snapshot the customer must change, not a size limit.
  if (managedSourcePathConflict(files.map((file) => file.path)))
    throw new ManagedSourcePathConflictError();
  try {
    assertManagedSourceResponse("files", {
      commit_sha: "1".repeat(40),
      files: files.map(fileManifest),
    });
  } catch {
    throw new ManagedSourceSurfaceError(
      "source_snapshot_too_large",
      413,
      "Source snapshots are limited to 8 MiB, 2 MiB per file and 2,000 safe relative paths.",
    );
  }
}

function assertStaging(row: ManagedSourcePublication, now: Date): void {
  if (row.state !== "staging")
    throw new ManagedSourceSurfaceError(
      "source_upload_conflict",
      409,
      "This immutable source upload is no longer accepting files.",
    );
  if (Date.parse(row.expiresAt) <= now.getTime())
    throw new ManagedSourceSurfaceError(
      "source_upload_expired",
      409,
      "The source upload expired. Start a new upload.",
    );
}

function viteReactFiles(): readonly ManagedSourceGitFile[] {
  const files = {
    ...VITE_REACT_DEPENDENCY_FILES,
    "index.html":
      '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My application</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    "src/main.tsx":
      'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport "./style.css";\ncreateRoot(document.getElementById("root")!).render(<React.StrictMode><main><h1>My application</h1><p>Your application is ready to build.</p></main></React.StrictMode>);\n',
    "src/style.css":
      "body { margin: 0; font-family: system-ui, sans-serif; color: #171717; background: #fafafa; } main { max-width: 48rem; margin: 5rem auto; padding: 2rem; }\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            useDefineForClassFields: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            verbatimModuleSyntax: true,
            moduleDetection: "force",
            noEmit: true,
            jsx: "react-jsx",
            strict: true,
          },
          include: ["src"],
        },
        null,
        2,
      ) + "\n",
    "vite.config.ts": 'import { defineConfig } from "vite";\nexport default defineConfig({});\n',
    ".gitignore": "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.ohmyhost/\n",
  };
  return Object.entries(files).map(([path, text]) => ({
    path,
    bytes: new TextEncoder().encode(text),
    executable: false,
  }));
}

export type ManagedSourceSurface = ReturnType<typeof createManagedSourceSurface>;

type RequestKind = "initialize" | "upload" | "changes" | "restore" | "blob" | "finalize" | "switch";
type ParsedBody =
  | { readonly outcome: "ok"; readonly value: unknown; readonly canonicalValue: unknown }
  | { readonly outcome: "error"; readonly response: Response };
interface PreparedRoute {
  readonly context: ProductSurfaceContext;
  readonly mutation: Pick<
    ProductSurfaceMutationContext,
    "idempotencyKey" | "canonicalRequestDigest"
  >;
}
export interface ManagedSourceRouteOptions {
  readonly action: AuthorizationAction;
  readonly responseShape:
    | "operation"
    | "managed-source-files"
    | "managed-source-versions"
    | "managed-source-diff"
    | "managed-source-upload"
    | "managed-source-blob";
  readonly mutation?: boolean;
  readonly body: (context: Context, requestId: string) => Promise<ParsedBody>;
  readonly invoke: (prepared: PreparedRoute, body: unknown) => Promise<ProductSurfaceResult | null>;
}
export type ManagedSourceRequestHandler = (
  context: Context,
  options: ManagedSourceRouteOptions,
) => Promise<Response>;

/** Reuses the Control API's existing authentication, concrete tenant authorization and limits. */
export function registerManagedSourceRoutes(
  app: Hono,
  handle: ManagedSourceRequestHandler,
  port: ManagedSourceSurface,
): void {
  const add = (
    method: "get" | "post" | "put",
    path: string,
    responseShape: ManagedSourceRouteOptions["responseShape"],
    kind: RequestKind | "files-query" | "versions-query" | "diff-query" | "upload-query",
    invoke: ManagedSourceRouteOptions["invoke"],
  ) => {
    app[method](path, (context) =>
      handle(context, {
        action: method === "get" ? "sources:read" : "sources:link",
        responseShape,
        mutation: method !== "get",
        body: (c, id) => parseRouteBody(c, id, kind),
        invoke,
      }),
    );
  };
  const mutation = (prepared: PreparedRoute): ProductSurfaceMutationContext => ({
    ...prepared.context,
    ...prepared.mutation,
  });
  add("post", "/v1/projects/:project_id/source:initialize", "operation", "initialize", (p, body) =>
    port.initialize(mutation(p), body as ManagedSourceInitializeRequest),
  );
  add(
    "get",
    "/v1/projects/:project_id/source/files",
    "managed-source-files",
    "files-query",
    (p, body) => port.files(p.context, body as Parameters<ManagedSourceSurface["files"]>[1]),
  );
  add(
    "get",
    "/v1/projects/:project_id/source/versions",
    "managed-source-versions",
    "versions-query",
    (p, body) => port.versions(p.context, body as Parameters<ManagedSourceSurface["versions"]>[1]),
  );
  add(
    "get",
    "/v1/projects/:project_id/source/diff",
    "managed-source-diff",
    "diff-query",
    (p, body) => port.diff(p.context, body as Parameters<ManagedSourceSurface["diff"]>[1]),
  );
  add("post", "/v1/projects/:project_id/source/changes", "operation", "changes", (p, body) =>
    port.changes(mutation(p), body as ManagedSourceChangesRequest),
  );
  add("post", "/v1/projects/:project_id/source:restore", "operation", "restore", (p, body) =>
    port.restore(mutation(p), body as ManagedSourceRestoreRequest),
  );
  add("post", "/v1/projects/:project_id/source/uploads", "operation", "upload", (p, body) =>
    port.createUpload(mutation(p), body as ManagedSourceUploadRequest),
  );
  app.get("/v1/projects/:project_id/source/uploads/:operation_id", (context) =>
    handle(context, {
      action: "sources:read",
      responseShape: "managed-source-upload",
      body: (c, id) => parseRouteBody(c, id, "upload-query"),
      invoke: (p) => port.getUpload(p.context, operationId(context)),
    }),
  );
  app.put("/v1/projects/:project_id/source/uploads/:operation_id/files", (context) =>
    handle(context, {
      action: "sources:link",
      responseShape: "managed-source-blob",
      mutation: true,
      body: (c, id) => parseRouteBody(c, id, "blob"),
      invoke: (p, body) =>
        port.putBlob(mutation(p), operationId(context), body as ManagedSourceBlobRequest),
    }),
  );
  app.post("/v1/projects/:project_id/source/uploads/:operation_commit", (context) =>
    handle(context, {
      action: "sources:link",
      responseShape: "operation",
      mutation: true,
      body: (c, id) => parseRouteBody(c, id, "finalize"),
      invoke: (p, body) =>
        port.commitUpload(mutation(p), operationId(context), body as ManagedSourceFinalizeRequest),
    }),
  );
  add("post", "/v1/projects/:project_id/source:switch", "operation", "switch", (p, body) =>
    port.switchSource(mutation(p), body as ManagedSourceSwitchRequest),
  );
}

function operationId(context: Context): string {
  return parseUlid(
    context.req.param("operation_id") ??
      /^([^:]+):commit$/u.exec(context.req.param("operation_commit") ?? "")?.[1] ??
      "",
  );
}

async function parseRouteBody(
  context: Context,
  requestId: string,
  kind: RequestKind | "files-query" | "versions-query" | "diff-query" | "upload-query",
): Promise<ParsedBody> {
  try {
    let value: unknown;
    if (kind.endsWith("-query")) {
      const query = new URL(context.req.url).searchParams;
      const keys =
        kind === "files-query"
          ? ["commit_sha", "path"]
          : kind === "versions-query"
            ? ["limit", "before_commit_sha"]
            : kind === "diff-query"
              ? ["from_commit_sha", "to_commit_sha"]
              : [];
      if ([...query.keys()].some((key) => !keys.includes(key) || query.getAll(key).length !== 1))
        throw new TypeError("Invalid query");
      const body = Object.fromEntries(query.entries());
      for (const key of ["commit_sha", "before_commit_sha", "from_commit_sha", "to_commit_sha"])
        if (key in body && !/^[a-f0-9]{40}$/u.test(body[key] ?? ""))
          throw new TypeError("Invalid commit");
      if (kind === "diff-query" && (!body["from_commit_sha"] || !body["to_commit_sha"]))
        throw new TypeError("Two commits are required");
      if (kind === "files-query" && body["path"] !== undefined)
        parseManagedSourceRequest("blob", {
          path: body["path"],
          content_base64: "",
          sha256: `sha256:${"0".repeat(64)}`,
          executable: false,
        });
      if (kind === "versions-query") {
        const limit = body["limit"] ?? "50";
        if (!/^[1-9][0-9]{0,2}$/u.test(limit) || Number(limit) > 100)
          throw new TypeError("Invalid limit");
        value = { ...body, limit: Number(limit) };
      } else value = body;
    } else {
      if ((context.req.header("content-type") ?? "").split(";")[0]?.trim() !== "application/json")
        throw new TypeError("JSON is required");
      const bytes = new Uint8Array(
        await readBoundedBody(
          context.req.raw,
          Math.ceil(MANAGED_SOURCE_LIMITS.uploadBytes / 3) * 4 + 512 * 2000 + 65536,
        ),
      );
      const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      value = (parseManagedSourceRequest as (kind: RequestKind, value: unknown) => unknown)(
        kind as RequestKind,
        json,
      );
    }
    if (
      context.req.param("operation_id") !== undefined ||
      context.req.param("operation_commit") !== undefined
    )
      operationId(context);
    return { outcome: "ok", value, canonicalValue: value };
  } catch {
    return {
      outcome: "error",
      response: new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "invalid_request",
          request_id: requestId,
          retryable: false,
          suggested_action:
            "Use the managed source request schema, safe relative paths and content hashes.",
        }),
        {
          status: 400,
          headers: { "content-type": "application/problem+json", "x-request-id": requestId },
        },
      ),
    };
  }
}

async function readBoundedBody(request: Request, limit: number): Promise<ArrayBuffer> {
  if (!request.body) throw new TypeError("JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new TypeError("Source request is too large");
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
