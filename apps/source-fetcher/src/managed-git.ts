import git, { type HttpClient, type GitHttpRequest, type GitHttpResponse } from "isomorphic-git";
import { isManagedSourcePath } from "@ohmyhost/contracts/managed-sources";
import { ManagedGitMemoryFileSystem } from "./managed-git-filesystem.js";

const encoder = new TextEncoder();
const ZERO_SHA = "0".repeat(40);
const SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const ROOT = "/workspace";
const MAXIMUM_TREE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_FILES = 2_000;
const MAXIMUM_TREES = MAXIMUM_FILES * 4;
const MAXIMUM_TRANSPORT_BYTES = 16 * 1024 * 1024;

export class ManagedGitError extends Error {
  public constructor(
    public readonly code:
      | "managed_source_input_invalid"
      | "managed_source_not_found"
      | "managed_source_conflict"
      | "managed_source_limit_exceeded"
      | "managed_source_provider_invalid"
      | "managed_source_unavailable"
      | "managed_source_result_uncertain",
  ) {
    // The code is the message: a service binding delivers only the message, and the control API classifies by it.
    super(code);
    this.name = "ManagedGitError";
  }
}

/** The trusted regional binding is selected by composition, never by a customer URL. */
export interface ManagedArtifactsRepository {
  info(): Promise<unknown>;
  createToken(scope: "read" | "write", ttl: number): Promise<unknown>;
  readCommit(hash: string): Promise<unknown>;
  readTree(hash: string): Promise<unknown>;
  readBlob(hash: string): Promise<Blob | null>;
  log(options: { ref: string; limit: number; offset: number }): Promise<unknown>;
  [Symbol.dispose]?: () => void;
}

export interface ManagedArtifactsBinding {
  get(name: string): Promise<ManagedArtifactsRepository>;
  create(name: string, options: { readOnly: false; setDefaultBranch: string }): Promise<unknown>;
  delete?(name: string): Promise<boolean>;
}

export interface ManagedGitRepositoryInfo {
  readonly name: string;
  readonly remote: string;
  readonly defaultBranch: string;
}

export interface ManagedGitCommit {
  readonly hash: string;
  readonly treeHash: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: Readonly<{ name: string; email: string }>;
  readonly authoredAt: number;
}

export interface ManagedGitFile {
  readonly path: string;
  readonly hash: string;
  readonly byteLength: number;
  readonly mode: "100644" | "100755";
}

export interface ManagedGitCommitMetadata {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly message: string;
  /** Persist this value with the idempotency request before preparing a candidate. */
  readonly timestampSeconds: number;
  readonly operationId: string;
}

export interface ManagedGitChange {
  readonly path: string;
  /** null deletes a file; bytes preserve uploaded binary files exactly. */
  readonly content: string | Uint8Array | null;
  readonly executable?: boolean;
}

export interface ManagedGitCommitRequest {
  readonly name: string;
  readonly branch: string;
  readonly expectedHead: string | null;
  readonly changes: readonly ManagedGitChange[];
  readonly metadata: ManagedGitCommitMetadata;
}

export interface PreparedManagedGitCommit {
  readonly repoName: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly parentSha: string | null;
  readonly files: readonly ManagedGitFile[];
  readonly totalBytes: number;
}

export interface ManagedGitArchive {
  readonly commitSha: string;
  readonly archiveFormat: "tar.gz";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ManagedGitAdapter {
  deleteRepository(name: string): Promise<void>;
  containsCommit(input: {
    name: string;
    branch: string;
    headCommitSha: string;
    candidateCommitSha: string;
    maxCommits?: number;
  }): Promise<boolean>;
  ensureRepository(input: { name: string; branch: string }): Promise<ManagedGitRepositoryInfo>;
  info(name: string): Promise<ManagedGitRepositoryInfo>;
  head(input: { name: string; branch: string }): Promise<string | null>;
  history(input: {
    name: string;
    ref: string;
    limit?: number;
    offset?: number;
  }): Promise<readonly ManagedGitCommit[]>;
  listFiles(input: { name: string; commitSha: string }): Promise<readonly ManagedGitFile[]>;
  readSnapshot(input: { name: string; commitSha: string }): Promise<
    readonly {
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly executable: boolean;
    }[]
  >;
  readFile(input: { name: string; commitSha: string; path: string }): Promise<Uint8Array | null>;
  prepareCommit(input: ManagedGitCommitRequest): Promise<PreparedManagedGitCommit>;
  prepareRestore(
    input: Omit<ManagedGitCommitRequest, "changes"> & { restoreCommitSha: string },
  ): Promise<PreparedManagedGitCommit>;
  pushPrepared(input: PreparedManagedGitCommit): Promise<string>;
  exportCommit(input: { name: string; commitSha: string }): Promise<ManagedGitArchive>;
}

export interface ManagedGitDependencies {
  readonly artifacts: ManagedArtifactsBinding;
  readonly accountId: string;
  readonly namespace: string;
  /** Tests may provide a deterministic transport; production defaults to HTTPS fetch. */
  readonly http?: HttpClient;
  readonly timeoutMs?: number;
  readonly underlyingOperation?: (operation: Promise<unknown>) => void;
}

interface Snapshot {
  readonly files: ManagedGitFile[];
  readonly bodies: Map<string, Uint8Array>;
  readonly totalBytes: number;
}

interface PreparedState {
  readonly fs: ManagedGitMemoryFileSystem;
  readonly info: ManagedGitRepositoryInfo;
  readonly unchanged: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: ManagedGitError["code"]): never {
  throw new ManagedGitError(code);
}

function name(value: string): string {
  if (typeof value !== "string" || !NAME.test(value)) fail("managed_source_input_invalid");
  return value;
}

function hash(value: string): string {
  if (typeof value !== "string" || !SHA.test(value)) fail("managed_source_input_invalid");
  return value;
}

function path(value: string): string {
  if (
    !isManagedSourcePath(value) ||
    value.length === 0 ||
    value.length > 240 ||
    !/^[\x20-\x7e]+$/u.test(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some(
        (part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git",
      ) ||
    value.split("/").length > 32
  )
    fail("managed_source_input_invalid");
  archivePath(`source/${value}`);
  return value;
}

function commit(value: unknown): ManagedGitCommit {
  if (
    !record(value) ||
    typeof value["hash"] !== "string" ||
    !SHA.test(value["hash"]) ||
    typeof value["treeHash"] !== "string" ||
    !SHA.test(value["treeHash"]) ||
    !Array.isArray(value["parents"]) ||
    value["parents"].some((p) => typeof p !== "string" || !SHA.test(p)) ||
    typeof value["message"] !== "string" ||
    !record(value["author"]) ||
    typeof value["author"]["name"] !== "string" ||
    typeof value["author"]["email"] !== "string" ||
    typeof value["authoredAt"] !== "number" ||
    !Number.isSafeInteger(value["authoredAt"])
  )
    fail("managed_source_provider_invalid");
  return Object.freeze({
    hash: value["hash"],
    treeHash: value["treeHash"],
    parents: Object.freeze([...value["parents"]] as string[]),
    message: value["message"],
    author: Object.freeze({ name: value["author"]["name"], email: value["author"]["email"] }),
    authoredAt: value["authoredAt"],
  });
}

function validateMetadata(value: ManagedGitCommitMetadata): void {
  if (
    typeof value.authorName !== "string" ||
    value.authorName.length === 0 ||
    value.authorName.length > 100 ||
    /[<>\r\n\0]/u.test(value.authorName) ||
    typeof value.authorEmail !== "string" ||
    !/^[^<>\s@]+@[^<>\s@]+$/u.test(value.authorEmail) ||
    value.authorEmail.length > 254 ||
    typeof value.message !== "string" ||
    value.message.trim().length === 0 ||
    value.message.length > 2_000 ||
    value.message.includes("\0") ||
    !Number.isSafeInteger(value.timestampSeconds) ||
    value.timestampSeconds < 0 ||
    typeof value.operationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.operationId)
  )
    fail("managed_source_input_invalid");
}

function validateChanges(changes: readonly ManagedGitChange[]): void {
  if (!Array.isArray(changes) || changes.length > MAXIMUM_FILES * 2)
    fail("managed_source_limit_exceeded");
  const seen = new Set<string>();
  for (const change of changes) {
    const filePath = path(change.path);
    if (seen.has(filePath)) fail("managed_source_input_invalid");
    seen.add(filePath);
    if (
      change.content !== null &&
      typeof change.content !== "string" &&
      !(change.content instanceof Uint8Array)
    )
      fail("managed_source_input_invalid");
    if (change.executable !== undefined && typeof change.executable !== "boolean")
      fail("managed_source_input_invalid");
    if (
      change.content !== null &&
      (typeof change.content === "string"
        ? encoder.encode(change.content).byteLength
        : change.content.byteLength) > MAXIMUM_FILE_BYTES
    )
      fail("managed_source_limit_exceeded");
  }
}

function isNotFound(error: unknown): boolean {
  return record(error) && (error["code"] === "NOT_FOUND" || error["message"] === "NOT_FOUND");
}

function rejectedRefChanged(error: unknown, branch: string): boolean {
  if (!record(error) || error["code"] !== "GitPushError" || !record(error["data"])) return false;
  const result = error["data"]["result"];
  if (!record(result) || !record(result["refs"])) return false;
  const ref = result["refs"][`refs/heads/${branch}`];
  return (
    record(ref) &&
    ref["ok"] === false &&
    typeof ref["error"] === "string" &&
    /stale|cannot lock|failed to update ref|non-fast-forward|expected|changed|incorrect old value provided/iu.test(
      ref["error"],
    )
  );
}

async function usingRepo<T>(
  binding: ManagedArtifactsBinding,
  repoName: string,
  action: (repo: ManagedArtifactsRepository) => Promise<T>,
): Promise<T> {
  let repo: ManagedArtifactsRepository;
  try {
    repo = await binding.get(name(repoName));
  } catch (error) {
    if (isNotFound(error)) fail("managed_source_not_found");
    fail("managed_source_unavailable");
  }
  try {
    return await action(repo);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

async function bounded<T>(
  timeoutMs: number,
  mutation: boolean,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new ManagedGitError(
              mutation ? "managed_source_result_uncertain" : "managed_source_unavailable",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ManagedGitError) throw error;
    if (record(error) && error["code"] === "ENOSPC") fail("managed_source_limit_exceeded");
    return fail(mutation ? "managed_source_result_uncertain" : "managed_source_unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function boundedHttp(transport: HttpClient, signal: AbortSignal, mutation: boolean): HttpClient {
  return {
    request(request) {
      if (signal.aborted)
        fail(mutation ? "managed_source_result_uncertain" : "managed_source_unavailable");
      return transport.request({ ...request, signal });
    },
  };
}

async function snapshot(repo: ManagedArtifactsRepository, commitSha: string): Promise<Snapshot> {
  const raw = await repo.readCommit(hash(commitSha));
  if (raw === null) fail("managed_source_not_found");
  const resolved = commit(raw);
  if (resolved.hash !== commitSha) fail("managed_source_provider_invalid");
  const files: ManagedGitFile[] = [];
  const bodies = new Map<string, Uint8Array>();
  const queue = [{ hash: resolved.treeHash, prefix: "" }];
  let totalBytes = 0;
  let trees = 0;
  while (queue.length !== 0) {
    const next = queue.shift();
    if (next === undefined) fail("managed_source_provider_invalid");
    if (++trees > MAXIMUM_TREES) fail("managed_source_limit_exceeded");
    const entries = await repo.readTree(next.hash);
    if (!Array.isArray(entries) || entries.length > MAXIMUM_FILES)
      fail("managed_source_provider_invalid");
    const names = new Set<string>();
    for (const entry of entries) {
      if (
        !record(entry) ||
        typeof entry["name"] !== "string" ||
        entry["name"].includes("/") ||
        typeof entry["hash"] !== "string" ||
        !SHA.test(entry["hash"]) ||
        typeof entry["mode"] !== "string"
      )
        fail("managed_source_provider_invalid");
      const filePath = path(next.prefix + entry["name"]);
      if (names.has(entry["name"])) fail("managed_source_provider_invalid");
      names.add(entry["name"]);
      if (entry["mode"] === "40000" || entry["mode"] === "040000") {
        queue.push({ hash: entry["hash"], prefix: `${filePath}/` });
        continue;
      }
      if (entry["mode"] !== "100644" && entry["mode"] !== "100755")
        fail("managed_source_provider_invalid");
      if (files.length >= MAXIMUM_FILES) fail("managed_source_limit_exceeded");
      const blob = await repo.readBlob(entry["hash"]);
      if (!(blob instanceof Blob)) fail("managed_source_provider_invalid");
      totalBytes += blob.size;
      if (blob.size > MAXIMUM_FILE_BYTES || totalBytes > MAXIMUM_TREE_BYTES)
        fail("managed_source_limit_exceeded");
      const body = new Uint8Array(await blob.arrayBuffer());
      if ((await git.hashBlob({ object: body })).oid !== entry["hash"])
        fail("managed_source_provider_invalid");
      bodies.set(filePath, body);
      files.push({
        path: filePath,
        hash: entry["hash"],
        byteLength: blob.size,
        mode: entry["mode"],
      });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, bodies, totalBytes };
}

async function mkdirParents(fs: ManagedGitMemoryFileSystem, filePath: string): Promise<void> {
  const index = filePath.lastIndexOf("/");
  if (index > 0) await fs.mkdir(filePath.slice(0, index), { recursive: true });
}

function archivePath(value: string): { name: string; prefix: string } {
  if (value.length <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    if (index <= 155 && value.length - index - 1 > 0 && value.length - index - 1 <= 100)
      return { name: value.slice(index + 1), prefix: value.slice(0, index) };
  }
  return fail("managed_source_input_invalid");
}

function tarHeader(filePath: string, size: number, mode: string, directory: boolean): Uint8Array {
  const header = new Uint8Array(512);
  const split = archivePath(filePath);
  header.set(encoder.encode(split.name), 0);
  header.set(
    encoder.encode(directory ? "0000755\0" : mode === "100755" ? "0000755\0" : "0000644\0"),
    100,
  );
  header.set(encoder.encode("0000000\0"), 108);
  header.set(encoder.encode("0000000\0"), 116);
  header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  header.set(encoder.encode("00000000000\0"), 136);
  header.fill(32, 148, 156);
  header[156] = directory ? 53 : 48;
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  header.set(encoder.encode(split.prefix), 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

async function archive(commitSha: string, source: Snapshot): Promise<ManagedGitArchive> {
  const chunks = [tarHeader("source/", 0, "100644", true)];
  const directories = new Set<string>();
  for (const file of source.files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++)
      directories.add(parts.slice(0, index).join("/"));
  }
  for (const directory of [...directories].sort())
    chunks.push(tarHeader(`source/${directory}/`, 0, "100644", true));
  for (const file of source.files) {
    const body = source.bodies.get(file.path);
    if (body === undefined) fail("managed_source_provider_invalid");
    chunks.push(
      tarHeader(`source/${file.path}`, body.byteLength, file.mode, false),
      body,
      new Uint8Array((512 - (body.byteLength % 512)) % 512),
    );
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const compressed = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Object.freeze({
    commitSha,
    archiveFormat: "tar.gz",
    bytes,
    byteLength: bytes.byteLength,
    sha256,
  });
}

/** Strict no-redirect transport: bearer credentials never leave the pinned Artifacts remote. */
async function fetchGit(request: GitHttpRequest): Promise<GitHttpResponse> {
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.body !== undefined) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of request.body) {
      length += chunk.byteLength;
      if (length > MAXIMUM_TRANSPORT_BYTES) fail("managed_source_limit_exceeded");
      chunks.push(chunk);
    }
    body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("Managed Git redirects are not accepted");
  }
  const responseChunks: Uint8Array[] = [];
  let responseLength = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseLength += chunk.value.byteLength;
        if (responseLength > MAXIMUM_TRANSPORT_BYTES) fail("managed_source_limit_exceeded");
        responseChunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(responseLength);
  let responseOffset = 0;
  for (const chunk of responseChunks) {
    bytes.set(chunk, responseOffset);
    responseOffset += chunk.byteLength;
  }
  return {
    url: response.url,
    method: request.method ?? "GET",
    statusCode: response.status,
    statusMessage: response.statusText,
    headers: Object.fromEntries(response.headers),
    body: (async function* () {
      yield bytes;
    })(),
  };
}

export function createManagedGitAdapter(dependencies: ManagedGitDependencies): ManagedGitAdapter {
  if (!/^[0-9a-f]{32}$/u.test(dependencies.accountId)) fail("managed_source_input_invalid");
  name(dependencies.namespace);
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    fail("managed_source_input_invalid");
  function boundedOperation<T>(
    mutation: boolean,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return bounded(timeoutMs, mutation, (signal) => {
      const operation = action(signal);
      dependencies.underlyingOperation?.(operation);
      return operation;
    });
  }
  const states = new WeakMap<PreparedManagedGitCommit, PreparedState>();
  const transport = dependencies.http ?? { request: fetchGit };

  function parseInfo(value: unknown, repoName: string): ManagedGitRepositoryInfo {
    const remote = `https://${dependencies.accountId}.artifacts.cloudflare.net/git/${dependencies.namespace}/${repoName}.git`;
    if (
      !record(value) ||
      value["name"] !== repoName ||
      value["remote"] !== remote ||
      typeof value["defaultBranch"] !== "string"
    )
      fail("managed_source_provider_invalid");
    return Object.freeze({ name: repoName, remote, defaultBranch: name(value["defaultBranch"]) });
  }

  async function token(repo: ManagedArtifactsRepository, scope: "read" | "write"): Promise<string> {
    const value = await repo.createToken(scope, 300);
    if (
      !record(value) ||
      typeof value["plaintext"] !== "string" ||
      value["plaintext"].length < 32 ||
      value["plaintext"].length > 4_096 ||
      !/^[\x21-\x7e]+$/u.test(value["plaintext"])
    )
      fail("managed_source_provider_invalid");
    // The provider owns token encoding; observed tokens need not use the documented prefix.
    const expiry = /\?expires=([^?&]+)$/u.exec(value["plaintext"]);
    if (
      expiry !== null &&
      (!/^\d+$/u.test(expiry[1] ?? "") ||
        !Number.isSafeInteger(Number(expiry[1])) ||
        Number(expiry[1]) <= 0)
    )
      fail("managed_source_provider_invalid");
    return value["plaintext"];
  }

  async function prepare(
    input: ManagedGitCommitRequest,
    restored?: Snapshot,
  ): Promise<PreparedManagedGitCommit> {
    name(input.name);
    name(input.branch);
    validateMetadata(input.metadata);
    validateChanges(input.changes);
    if (input.expectedHead !== null) hash(input.expectedHead);
    return boundedOperation(false, (signal) =>
      usingRepo(dependencies.artifacts, input.name, async (repo) => {
        const info = parseInfo(await repo.info(), input.name);
        const history = await repo.log({ ref: input.branch, limit: 1, offset: 0 });
        if (!Array.isArray(history) || history.length > 1) fail("managed_source_provider_invalid");
        const currentCommit = history.length === 0 ? null : commit(history[0]);
        const current = currentCommit?.hash ?? null;
        if (current !== input.expectedHead) fail("managed_source_conflict");
        const previous =
          current === null
            ? { files: [], bodies: new Map<string, Uint8Array>(), totalBytes: 0 }
            : await snapshot(repo, current);
        const desired = new Map(restored?.bodies ?? previous.bodies);
        for (const change of input.changes) {
          if (change.content === null) desired.delete(change.path);
          else
            desired.set(
              change.path,
              typeof change.content === "string"
                ? encoder.encode(change.content)
                : change.content.slice(),
            );
        }
        const totalBytes = [...desired.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
        if (desired.size > MAXIMUM_FILES || totalBytes > MAXIMUM_TREE_BYTES)
          fail("managed_source_limit_exceeded");
        const treeDirectories = new Set([""]);
        for (const filePath of desired.keys()) {
          const parts = filePath.split("/");
          for (let index = 1; index < parts.length; index++) {
            const directory = parts.slice(0, index).join("/");
            if (desired.has(directory)) fail("managed_source_input_invalid");
            treeDirectories.add(directory);
            if (treeDirectories.size > MAXIMUM_TREES) fail("managed_source_limit_exceeded");
          }
        }
        const modes = new Map(
          (restored?.files ?? previous.files).map((file) => [file.path, file.mode]),
        );
        for (const change of input.changes) {
          if (change.content !== null && change.executable !== undefined)
            modes.set(change.path, change.executable ? "100755" : "100644");
        }
        let unchanged = currentCommit !== null && desired.size === previous.files.length;
        for (const file of previous.files) {
          const bytes = desired.get(file.path);
          if (
            bytes === undefined ||
            bytes.byteLength !== file.byteLength ||
            (modes.get(file.path) ?? "100644") !== file.mode ||
            (await git.hashBlob({ object: bytes })).oid !== file.hash
          )
            unchanged = false;
        }
        if (unchanged && currentCommit !== null) {
          const result = Object.freeze({
            repoName: input.name,
            branch: input.branch,
            commitSha: currentCommit.hash,
            treeSha: currentCommit.treeHash,
            parentSha: currentCommit.hash,
            files: Object.freeze(previous.files.map((file) => Object.freeze(file))),
            totalBytes,
          });
          states.set(result, { fs: new ManagedGitMemoryFileSystem(), info, unchanged: true });
          return result;
        }
        const fs = new ManagedGitMemoryFileSystem();
        if (current === null) {
          await fs.mkdir(ROOT);
          await git.init({ fs, dir: ROOT, defaultBranch: input.branch });
        } else {
          const headers = { Authorization: `Bearer ${await token(repo, "read")}` };
          await git.clone({
            fs,
            http: boundedHttp(transport, signal, false),
            dir: ROOT,
            url: info.remote,
            ref: input.branch,
            singleBranch: true,
            depth: 1,
            noTags: true,
            headers,
          });
          if ((await git.resolveRef({ fs, dir: ROOT, ref: "HEAD" })) !== current)
            fail("managed_source_conflict");
        }
        for (const file of previous.files) {
          await git.remove({ fs, dir: ROOT, filepath: file.path });
          await fs.unlink(`${ROOT}/${file.path}`);
        }
        // Remove empty checkout directories so file/directory replacements cannot collide.
        const directories = new Set(
          previous.files.flatMap((file) => {
            const parts = file.path.split("/");
            return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
          }),
        );
        for (const directory of [...directories].sort((a, b) => b.length - a.length))
          await fs.rmdir(`${ROOT}/${directory}`);
        for (const [filePath, body] of [...desired].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          await mkdirParents(fs, `${ROOT}/${filePath}`);
          await fs.writeFile(`${ROOT}/${filePath}`, body);
          if (modes.get(filePath) === "100755") await fs.chmod(`${ROOT}/${filePath}`, 0o755);
          await git.add({ fs, dir: ROOT, filepath: filePath, force: true });
        }
        const identity = {
          name: input.metadata.authorName,
          email: input.metadata.authorEmail,
          timestamp: input.metadata.timestampSeconds,
          timezoneOffset: 0,
        };
        const commitSha = await git.commit({
          fs,
          dir: ROOT,
          message: `${input.metadata.message.trim()}\n\nOhmyhost-Operation: ${input.metadata.operationId}\n`,
          author: identity,
          committer: identity,
        });
        const files: ManagedGitFile[] = [];
        for (const [filePath, body] of desired)
          files.push({
            path: filePath,
            hash: (await git.hashBlob({ object: body })).oid,
            byteLength: body.byteLength,
            mode: modes.get(filePath) ?? "100644",
          });
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const treeSha = (await git.readCommit({ fs, dir: ROOT, oid: commitSha })).commit.tree;
        const result = Object.freeze({
          repoName: input.name,
          branch: input.branch,
          commitSha,
          treeSha,
          parentSha: current,
          files: Object.freeze(files.map((file) => Object.freeze(file))),
          totalBytes,
        });
        states.set(result, { fs, info, unchanged: false });
        return result;
      }),
    );
  }

  return Object.freeze({
    async containsCommit(input) {
      name(input.name);
      name(input.branch);
      hash(input.headCommitSha);
      hash(input.candidateCommitSha);
      const maxCommits = input.maxCommits ?? 1_000;
      if (!Number.isSafeInteger(maxCommits) || maxCommits < 1 || maxCommits > 1_000)
        fail("managed_source_input_invalid");
      return boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, input.name, async (repo) => {
          const head = await repo.log({ ref: input.branch, limit: 1, offset: 0 });
          if (
            !Array.isArray(head) ||
            head.length !== 1 ||
            commit(head[0]).hash !== input.headCommitSha
          )
            fail("managed_source_conflict");
          let cursor = input.headCommitSha;
          const seen = new Set<string>();
          for (let index = 0; index < maxCommits; index++) {
            if (seen.has(cursor)) fail("managed_source_provider_invalid");
            seen.add(cursor);
            const raw = await repo.readCommit(cursor);
            if (raw === null) fail("managed_source_provider_invalid");
            const entry = commit(raw);
            if (entry.hash !== cursor || entry.parents.length > 1 || entry.parents.includes(cursor))
              fail("managed_source_provider_invalid");
            if (cursor === input.candidateCommitSha) return true;
            const parent = entry.parents[0];
            if (parent === undefined) return false;
            cursor = parent;
          }
          // Exhausting the proof bound does not prove absence and must remain unresolved.
          return fail("managed_source_unavailable");
        }),
      );
    },
    async deleteRepository(repoName) {
      name(repoName);
      // Artifacts is a Workers RPC binding: `delete.bind` would name a remote method and never
      // delete, so delete is only ever called on the binding itself.
      if (dependencies.artifacts.delete === undefined) fail("managed_source_unavailable");
      try {
        await boundedOperation(false, () =>
          usingRepo(dependencies.artifacts, repoName, async (repo) =>
            parseInfo(await repo.info(), repoName),
          ),
        );
      } catch (error) {
        if (error instanceof ManagedGitError && error.code === "managed_source_not_found") return;
        throw error;
      }
      await boundedOperation(true, async () => {
        await dependencies.artifacts.delete?.(repoName);
        try {
          await usingRepo(dependencies.artifacts, repoName, async (repo) =>
            parseInfo(await repo.info(), repoName),
          );
        } catch (error) {
          if (error instanceof ManagedGitError && error.code === "managed_source_not_found") return;
          fail("managed_source_result_uncertain");
        }
        fail("managed_source_result_uncertain");
      });
    },
    async ensureRepository(input) {
      name(input.name);
      name(input.branch);
      try {
        return await boundedOperation(false, () =>
          usingRepo(dependencies.artifacts, input.name, async (repo) =>
            parseInfo(await repo.info(), input.name),
          ),
        );
      } catch (error) {
        if (!(error instanceof ManagedGitError) || error.code !== "managed_source_not_found")
          throw error;
      }
      // Creation has its own uncertainty classification; an unknown get never triggers creation.
      return boundedOperation(true, async () =>
        parseInfo(
          await dependencies.artifacts.create(input.name, {
            readOnly: false,
            setDefaultBranch: input.branch,
          }),
          input.name,
        ),
      );
    },
    async info(repoName) {
      return boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, repoName, async (repo) =>
          parseInfo(await repo.info(), repoName),
        ),
      );
    },
    async head(input) {
      const values = await this.history({ name: input.name, ref: name(input.branch), limit: 1 });
      return values[0]?.hash ?? null;
    },
    async history(input) {
      name(input.name);
      if (!SHA.test(input.ref)) name(input.ref);
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1_000 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        fail("managed_source_input_invalid");
      return boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, input.name, async (repo) => {
          const values = await repo.log({ ref: input.ref, limit, offset });
          if (!Array.isArray(values) || values.length > limit)
            fail("managed_source_provider_invalid");
          return Object.freeze(values.map(commit));
        }),
      );
    },
    async listFiles(input) {
      return boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, input.name, async (repo) =>
          Object.freeze((await snapshot(repo, input.commitSha)).files),
        ),
      );
    },
    async readSnapshot(input) {
      return boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, input.name, async (repo) => {
          const source = await snapshot(repo, input.commitSha);
          return Object.freeze(
            source.files.map((file) => ({
              path: file.path,
              bytes: source.bodies.get(file.path) ?? fail("managed_source_provider_invalid"),
              executable: file.mode === "100755",
            })),
          );
        }),
      );
    },
    async readFile(input) {
      path(input.path);
      return boundedOperation(false, () =>
        usingRepo(
          dependencies.artifacts,
          input.name,
          async (repo) => (await snapshot(repo, input.commitSha)).bodies.get(input.path) ?? null,
        ),
      );
    },
    prepareCommit(input) {
      return prepare(input);
    },
    async prepareRestore(input) {
      const restored = await boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, input.name, (repo) =>
          snapshot(repo, input.restoreCommitSha),
        ),
      );
      return prepare({ ...input, changes: [] }, restored);
    },
    async pushPrepared(input) {
      const state = states.get(input);
      if (state === undefined) fail("managed_source_input_invalid");
      return boundedOperation(true, (signal) =>
        usingRepo(dependencies.artifacts, input.repoName, async (repo) => {
          const info = parseInfo(await repo.info(), input.repoName);
          if (info.remote !== state.info.remote) fail("managed_source_provider_invalid");
          if (state.unchanged) {
            const history = await repo.log({ ref: input.branch, limit: 1, offset: 0 });
            if (
              !Array.isArray(history) ||
              history.length !== 1 ||
              commit(history[0]).hash !== input.commitSha
            )
              fail("managed_source_conflict");
            return input.commitSha;
          }
          const headers = { Authorization: `Bearer ${await token(repo, "write")}` };
          try {
            await git.push({
              fs: state.fs,
              http: boundedHttp(transport, signal, true),
              dir: ROOT,
              url: info.remote,
              ref: input.branch,
              remoteRef: input.branch,
              force: false,
              headers,
              onPrePush({ remoteRef }) {
                if (remoteRef.oid !== (input.parentSha ?? ZERO_SHA))
                  fail("managed_source_conflict");
                return true;
              },
            });
          } catch (error) {
            if (rejectedRefChanged(error, input.branch)) fail("managed_source_conflict");
            throw error;
          }
          return input.commitSha;
        }),
      );
    },
    async exportCommit(input) {
      return boundedOperation(false, () =>
        usingRepo(dependencies.artifacts, input.name, async (repo) =>
          archive(input.commitSha, await snapshot(repo, input.commitSha)),
        ),
      );
    },
  } satisfies ManagedGitAdapter);
}
