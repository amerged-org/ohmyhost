import { parseUlid } from "@ohmyhost/platform";
import { isManagedSourcePath } from "@ohmyhost/contracts/managed-sources";
import {
  createManagedGitAdapter,
  ManagedGitError,
  type ManagedArtifactsBinding,
  type ManagedGitAdapter,
  type ManagedGitCommitRequest,
} from "./managed-git.js";

const SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
interface MemoryLease {
  closed: boolean;
  pending: number;
}
let heavyOperation: MemoryLease | null = null;
interface MemoryWaiter {
  readonly resolve: (release: () => void) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const memoryWaiters: MemoryWaiter[] = [];
const MAXIMUM_MEMORY_WAITERS = 32;
const MEMORY_WAIT_MS = 20_000;

function releaseMemory(lease: MemoryLease): void {
  if (heavyOperation !== lease) return;
  heavyOperation = null;
  const next = memoryWaiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(reserveManagedSourceMemory());
  }
}

function settleUnderlying(lease: MemoryLease): void {
  lease.pending -= 1;
  if (lease.closed && lease.pending === 0) releaseMemory(lease);
}

/** Counts underlying lifetimes without retaining their payloads or credential values. */
export function observeManagedSourceOperation(operation: Promise<unknown>): void {
  const lease = heavyOperation;
  if (lease === null) return;
  lease.pending += 1;
  void operation.then(
    () => settleUnderlying(lease),
    () => settleUnderlying(lease),
  );
}

function reserveManagedSourceMemory(): () => void {
  if (heavyOperation !== null) throw new ManagedGitError("managed_source_unavailable");
  const lease = { closed: false, pending: 0 };
  heavyOperation = lease;
  return () => {
    lease.closed = true;
    if (lease.pending === 0) releaseMemory(lease);
  };
}

function waitForManagedSourceMemory(): Promise<() => void> {
  if (heavyOperation === null) return Promise.resolve(reserveManagedSourceMemory());
  if (memoryWaiters.length >= MAXIMUM_MEMORY_WAITERS)
    return Promise.reject(new ManagedGitError("managed_source_unavailable"));
  return new Promise((resolve, reject) => {
    const waiter: MemoryWaiter = {
      resolve,
      timer: setTimeout(() => {
        const index = memoryWaiters.indexOf(waiter);
        if (index >= 0) memoryWaiters.splice(index, 1);
        reject(new ManagedGitError("managed_source_unavailable"));
      }, MEMORY_WAIT_MS),
    };
    memoryWaiters.push(waiter);
  });
}

/** One heavy managed operation per isolate, across every service/factory instance. */
export async function withManagedSourceMemoryBudget<T>(action: () => Promise<T>): Promise<T> {
  const release = await waitForManagedSourceMemory();
  try {
    return await action();
  } finally {
    release();
  }
}

interface StagingObject {
  readonly key: string;
  readonly version: string;
  readonly httpEtag: string;
  readonly size: number;
  readonly customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface StagingReceipt {
  readonly key: string;
  readonly version: string;
  readonly httpEtag: string;
  readonly size: number;
}

export interface ManagedSourceStagingBucket {
  get(key: string): Promise<StagingObject | null>;
  delete?(key: string): Promise<void>;
  put(
    key: string,
    bytes: Uint8Array,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
      readonly customMetadata: Record<string, string>;
    },
  ): Promise<StagingReceipt | null>;
}

export interface ManagedSourceBindings {
  readonly ARTIFACTS_US?: ManagedArtifactsBinding;
  readonly ARTIFACTS_EU?: ManagedArtifactsBinding;
  readonly MANAGED_ARTIFACTS_ACCOUNT_ID?: string;
  readonly MANAGED_ARTIFACTS_NAMESPACE_US?: string;
  readonly MANAGED_ARTIFACTS_NAMESPACE_EU?: string;
  readonly MANAGED_SOURCE_STAGING_US?: ManagedSourceStagingBucket;
  readonly MANAGED_SOURCE_STAGING_EU?: ManagedSourceStagingBucket;
  readonly BUILD_OBJECTS_BUCKET_US: string;
  readonly BUILD_OBJECTS_BUCKET_EU: string;
  readonly SOURCE_FETCH_TIMEOUT_MS: string;
}

export interface ManagedRepository {
  readonly namespace: string;
  readonly repositoryName: string;
}

interface FileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

interface PrepareInput {
  readonly expectedCommitSha: string | null;
  readonly files: readonly FileInput[];
  readonly metadata: {
    readonly message: string;
    readonly operationId: string;
    readonly timestampSeconds: number;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ManagedGitError("managed_source_input_invalid");
}

function unavailable(): never {
  throw new ManagedGitError("managed_source_unavailable");
}

function scopedId(value: unknown): string {
  if (typeof value !== "string") return invalid();
  try {
    return parseUlid(value);
  } catch {
    return invalid();
  }
}

function sourcePath(value: unknown): string {
  if (
    !isManagedSourcePath(value) ||
    value.length === 0 ||
    value.length > 240 ||
    !/^[\x20-\x7e]+$/u.test(value) ||
    value.includes("\\") ||
    value.split("/").some((p) => p === "" || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    return invalid();
  return value;
}

function canonicalBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string" || value.length > Math.ceil((2 * 1024 * 1024) / 3) * 4)
    return invalid();
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return invalid();
  }
  if (btoa(binary) !== value) return invalid();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parsePrepare(value: unknown): PrepareInput {
  if (
    !object(value) ||
    (value["expectedCommitSha"] !== null &&
      (typeof value["expectedCommitSha"] !== "string" || !SHA.test(value["expectedCommitSha"]))) ||
    !Array.isArray(value["files"]) ||
    value["files"].length > 2_000 ||
    !object(value["metadata"])
  )
    return invalid();
  const files: FileInput[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const item of value["files"]) {
    if (!object(item) || typeof item["executable"] !== "boolean") return invalid();
    const path = sourcePath(item["path"]);
    if (seen.has(path)) return invalid();
    seen.add(path);
    const bytes = canonicalBytes(item["bytes"] ?? item["content_base64"]);
    total += bytes.byteLength;
    if (bytes.byteLength > 2 * 1024 * 1024 || total > 8 * 1024 * 1024)
      throw new ManagedGitError("managed_source_limit_exceeded");
    files.push({ path, bytes, executable: item["executable"] });
  }
  const metadata = value["metadata"];
  if (
    typeof metadata["message"] !== "string" ||
    typeof metadata["operationId"] !== "string" ||
    typeof metadata["timestampSeconds"] !== "number"
  )
    return invalid();
  return {
    expectedCommitSha: value["expectedCommitSha"] as string | null,
    files,
    metadata: {
      message: metadata["message"],
      operationId: metadata["operationId"],
      timestampSeconds: metadata["timestampSeconds"],
    },
  };
}

export function createManagedGitRpc(bindings: ManagedSourceBindings) {
  async function providerCall<T>(mutation: boolean, action: () => Promise<T>): Promise<T> {
    const timeout = Number(bindings.SOURCE_FETCH_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) return unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = action();
      observeManagedSourceOperation(operation);
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ManagedGitError(
                  mutation ? "managed_source_result_uncertain" : "managed_source_unavailable",
                ),
              ),
            timeout,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof ManagedGitError) throw error;
      throw new ManagedGitError(
        mutation ? "managed_source_result_uncertain" : "managed_source_unavailable",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  function select(repository: ManagedRepository): ManagedGitAdapter {
    if (
      bindings.MANAGED_ARTIFACTS_NAMESPACE_US === undefined ||
      bindings.MANAGED_ARTIFACTS_NAMESPACE_EU === undefined
    )
      return unavailable();
    if (!NAME.test(repository.repositoryName) || !NAME.test(repository.namespace)) return invalid();
    const us = repository.namespace === bindings.MANAGED_ARTIFACTS_NAMESPACE_US;
    const eu = repository.namespace === bindings.MANAGED_ARTIFACTS_NAMESPACE_EU;
    if (us === eu) return invalid();
    const artifacts = us ? bindings.ARTIFACTS_US : bindings.ARTIFACTS_EU;
    const timeoutMs = Number(bindings.SOURCE_FETCH_TIMEOUT_MS);
    if (
      artifacts === undefined ||
      bindings.MANAGED_ARTIFACTS_ACCOUNT_ID === undefined ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    )
      return unavailable();
    return createManagedGitAdapter({
      artifacts,
      accountId: bindings.MANAGED_ARTIFACTS_ACCOUNT_ID,
      namespace: repository.namespace,
      timeoutMs,
      underlyingOperation: observeManagedSourceOperation,
    });
  }

  async function prepare(
    adapter: ManagedGitAdapter,
    repository: ManagedRepository,
    input: PrepareInput,
  ) {
    const current =
      input.expectedCommitSha === null
        ? []
        : await adapter.listFiles({
            name: repository.repositoryName,
            commitSha: input.expectedCommitSha,
          });
    const paths = new Set(input.files.map((file) => file.path));
    const request: ManagedGitCommitRequest = {
      name: repository.repositoryName,
      branch: "main",
      expectedHead: input.expectedCommitSha,
      changes: [
        ...current
          .filter((file) => !paths.has(file.path))
          .map((file) => ({ path: file.path, content: null })),
        ...input.files.map((file) => ({
          path: file.path,
          content: file.bytes,
          executable: file.executable,
        })),
      ],
      metadata: {
        ...input.metadata,
        authorName: "ohmyho.st",
        authorEmail: "managed-source@ohmyho.st",
      },
    };
    return adapter.prepareCommit(request);
  }

  return Object.freeze({
    adapterForNamespace(namespace: string) {
      return select({ namespace, repositoryName: "validation" });
    },
    async managedGit(method: string, raw: unknown): Promise<unknown> {
      const release = reserveManagedSourceMemory();
      try {
        if (
          !object(raw) ||
          !object(raw["repository"]) ||
          typeof raw["repository"]["namespace"] !== "string" ||
          typeof raw["repository"]["repositoryName"] !== "string"
        )
          return invalid();
        const repository = {
          namespace: raw["repository"]["namespace"],
          repositoryName: raw["repository"]["repositoryName"],
        };
        const adapter = select(repository);
        if (method === "containsCommit") {
          const input = raw["input"];
          if (
            !object(input) ||
            input["branch"] !== "main" ||
            typeof input["headCommitSha"] !== "string" ||
            typeof input["candidateCommitSha"] !== "string" ||
            (input["maxCommits"] !== undefined && typeof input["maxCommits"] !== "number")
          )
            return invalid();
          return adapter.containsCommit({
            name: repository.repositoryName,
            branch: "main",
            headCommitSha: input["headCommitSha"],
            candidateCommitSha: input["candidateCommitSha"],
            ...(typeof input["maxCommits"] === "number" ? { maxCommits: input["maxCommits"] } : {}),
          });
        }
        if (method === "deleteRepository") {
          scopedId(raw["organizationId"]);
          scopedId(raw["operationId"]);
          const projectId = scopedId(raw["projectId"]);
          if (!repository.repositoryName.startsWith(`${projectId.toLowerCase()}-`))
            return invalid();
          await adapter.deleteRepository(repository.repositoryName);
          return null;
        }
        if (method === "ensureRepository") {
          await adapter.ensureRepository({ name: repository.repositoryName, branch: "main" });
          return null;
        }
        if (method === "head")
          return adapter.head({ name: repository.repositoryName, branch: "main" });
        if (method === "files") {
          if (typeof raw["commitSha"] !== "string") return invalid();
          return adapter.readSnapshot({
            name: repository.repositoryName,
            commitSha: raw["commitSha"],
          });
        }
        if (method === "history") {
          if (!object(raw["input"]) || typeof raw["input"]["limit"] !== "number") return invalid();
          const before = raw["input"]["beforeCommitSha"];
          if (before !== undefined && (typeof before !== "string" || !SHA.test(before)))
            return invalid();
          const history = await adapter.history({
            name: repository.repositoryName,
            ref: typeof before === "string" ? before : "main",
            limit: raw["input"]["limit"],
          });
          return history.map((commit) => ({
            commitSha: commit.hash,
            parentSha: commit.parents[0] ?? null,
            message: commit.message.replace(/\n\nOhmyhost-Operation: [a-zA-Z0-9_-]+\n?$/u, ""),
            createdAt: new Date(commit.authoredAt * 1_000).toISOString(),
          }));
        }
        if (method === "prepare") {
          const input = parsePrepare(raw["input"]);
          const candidate = await prepare(adapter, repository, input);
          return {
            commitSha: candidate.commitSha,
            treeSha: candidate.treeSha,
            parentSha: candidate.parentSha,
            providerState: input,
          };
        }
        if (method === "push") {
          if (!object(raw["prepared"])) return invalid();
          const saved = raw["prepared"];
          const input = parsePrepare(saved["providerState"]);
          const candidate = await prepare(adapter, repository, input);
          if (
            candidate.commitSha !== saved["commitSha"] ||
            candidate.treeSha !== saved["treeSha"] ||
            candidate.parentSha !== saved["parentSha"]
          )
            return invalid();
          await adapter.pushPrepared(candidate);
          return null;
        }
        return invalid();
      } finally {
        release();
      }
    },
    async managedBlob(method: string, raw: unknown): Promise<unknown> {
      const release = reserveManagedSourceMemory();
      try {
        if (!object(raw)) return invalid();
        const organizationId = scopedId(raw["organizationId"]);
        const projectId = scopedId(raw["projectId"]);
        const operationId = scopedId(raw["operationId"]);
        if (method === "deleteOperation") {
          if (raw["region"] !== "us" && raw["region"] !== "eu") return invalid();
          if (!Array.isArray(raw["blobs"]) || raw["blobs"].length > 2_000) return invalid();
          const receipts = raw["blobs"].map((blob) => {
            if (
              !object(blob) ||
              typeof blob["sha256"] !== "string" ||
              !DIGEST.test(blob["sha256"]) ||
              typeof blob["versionId"] !== "string" ||
              !/^[0-9a-f]{32}$/u.test(blob["versionId"]) ||
              typeof blob["eTag"] !== "string" ||
              typeof blob["byteLength"] !== "number" ||
              !Number.isSafeInteger(blob["byteLength"]) ||
              blob["byteLength"] < 0 ||
              blob["byteLength"] > 2 * 1024 * 1024
            )
              return invalid();
            // A region move does not relocate historical staging receipts.
            const bucket =
              blob["bucket"] === bindings.BUILD_OBJECTS_BUCKET_US
                ? bindings.MANAGED_SOURCE_STAGING_US
                : blob["bucket"] === bindings.BUILD_OBJECTS_BUCKET_EU
                  ? bindings.MANAGED_SOURCE_STAGING_EU
                  : invalid();
            if (bucket?.delete === undefined) return unavailable();
            sourcePath(blob["path"]);
            const key = `managed-staging/${operationId}/${organizationId}/${projectId}/${blob["sha256"]}`;
            if (blob["key"] !== key) return invalid();
            return {
              bucket,
              key,
              version: blob["versionId"],
              eTag: blob["eTag"],
              byteLength: blob["byteLength"],
              sha256: blob["sha256"],
            };
          });
          for (const receipt of receipts) {
            const bucket = receipt.bucket;
            const observed = await providerCall(false, () => bucket.get(receipt.key));
            if (observed === null) continue;
            if (
              observed.version !== receipt.version ||
              observed.httpEtag !== receipt.eTag ||
              observed.size !== receipt.byteLength ||
              observed.customMetadata?.["organizationId"] !== organizationId ||
              observed.customMetadata["projectId"] !== projectId ||
              observed.customMetadata["operationId"] !== operationId ||
              observed.customMetadata["sha256"] !== receipt.sha256
            )
              return invalid();
            // R2 has no conditional delete. The caller's frozen claim excludes writes here.
            await providerCall(true, () => {
              if (bucket.delete === undefined) return unavailable();
              return bucket.delete(receipt.key);
            });
            if ((await providerCall(false, () => bucket.get(receipt.key))) !== null)
              throw new ManagedGitError("managed_source_result_uncertain");
          }
          return null;
        }
        const sha256 =
          typeof raw["sha256"] === "string" ? raw["sha256"].replace(/^sha256:/u, "") : invalid();
        if (!DIGEST.test(sha256)) return invalid();
        const key = `managed-staging/${operationId}/${organizationId}/${projectId}/${sha256}`;
        const bucketName =
          method === "put"
            ? raw["region"] === "us"
              ? bindings.BUILD_OBJECTS_BUCKET_US
              : raw["region"] === "eu"
                ? bindings.BUILD_OBJECTS_BUCKET_EU
                : invalid()
            : raw["bucket"];
        const bucket =
          bucketName === bindings.BUILD_OBJECTS_BUCKET_US
            ? bindings.MANAGED_SOURCE_STAGING_US
            : bucketName === bindings.BUILD_OBJECTS_BUCKET_EU
              ? bindings.MANAGED_SOURCE_STAGING_EU
              : invalid();
        if (bucket === undefined) return unavailable();
        if (method === "put") {
          sourcePath(raw["path"]);
          if (typeof raw["executable"] !== "boolean") return invalid();
          const bytes = canonicalBytes(raw["bytes"] ?? raw["content_base64"]);
          if (bytes.byteLength > 2 * 1024 * 1024 || (await digest(bytes)) !== sha256)
            return invalid();
          let receipt = await providerCall(true, () =>
            bucket.put(key, bytes, {
              onlyIf: { etagDoesNotMatch: "*" },
              customMetadata: { organizationId, projectId, operationId, sha256 },
            }),
          );
          if (receipt === null) receipt = await providerCall(false, () => bucket.get(key));
          if (
            receipt === null ||
            receipt.key !== key ||
            receipt.size !== bytes.byteLength ||
            !/^[0-9a-f]{32}$/u.test(receipt.version) ||
            !/^"[^"\r\n]{1,256}"$/u.test(receipt.httpEtag)
          )
            throw new ManagedGitError("managed_source_result_uncertain");
          const observed = await providerCall(false, () => bucket.get(key));
          if (
            observed === null ||
            observed.version !== receipt.version ||
            observed.httpEtag !== receipt.httpEtag ||
            observed.size !== bytes.byteLength ||
            observed.customMetadata?.["organizationId"] !== organizationId ||
            observed.customMetadata["projectId"] !== projectId ||
            observed.customMetadata["operationId"] !== operationId ||
            observed.customMetadata["sha256"] !== sha256 ||
            (await digest(
              new Uint8Array(await providerCall(false, () => observed.arrayBuffer())),
            )) !== sha256
          )
            throw new ManagedGitError("managed_source_result_uncertain");
          return { bucket: bucketName, key, versionId: receipt.version, eTag: receipt.httpEtag };
        }
        if (method === "get") {
          sourcePath(raw["path"]);
          if (
            raw["key"] !== key ||
            typeof raw["versionId"] !== "string" ||
            !/^[0-9a-f]{32}$/u.test(raw["versionId"]) ||
            typeof raw["eTag"] !== "string" ||
            typeof raw["byteLength"] !== "number" ||
            !Number.isSafeInteger(raw["byteLength"]) ||
            raw["byteLength"] < 0 ||
            raw["byteLength"] > 2 * 1024 * 1024
          )
            return invalid();
          const observed = await providerCall(false, () => bucket.get(key));
          if (observed === null) throw new ManagedGitError("managed_source_not_found");
          if (
            observed.key !== key ||
            observed.version !== raw["versionId"] ||
            observed.httpEtag !== raw["eTag"] ||
            observed.size !== raw["byteLength"] ||
            observed.customMetadata?.["organizationId"] !== organizationId ||
            observed.customMetadata["projectId"] !== projectId ||
            observed.customMetadata["operationId"] !== operationId ||
            observed.customMetadata["sha256"] !== sha256
          )
            return invalid();
          const bytes = new Uint8Array(await providerCall(false, () => observed.arrayBuffer()));
          if (bytes.byteLength !== raw["byteLength"] || (await digest(bytes)) !== sha256)
            return invalid();
          return bytes;
        }
        return invalid();
      } finally {
        release();
      }
    },
  });
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
