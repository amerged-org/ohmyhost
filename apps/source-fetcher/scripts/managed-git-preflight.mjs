/* global URL, fetch, AbortSignal, console, URLSearchParams, TextDecoder */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createManagedGitAdapter } from "../dist/managed-git.js";
import { cleanupDisposableRepository } from "./managed-git-preflight-cleanup.mjs";

// Operator-only Dev acceptance. Credentials remain in process memory and are never reported.
const accountId = "00000000000000000000000000000001";
const values = new Map();
for (const line of (await readFile(new URL("../../../.env.local", import.meta.url), "utf8")).split(
  /\r?\n/u,
)) {
  if (line.trimStart().startsWith("#") || !line.includes("=")) continue;
  const at = line.indexOf("=");
  values.set(
    line.slice(0, at).trim(),
    line
      .slice(at + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/u, "$2"),
  );
}
const credential = values.get("CLOUDFLARE_API_TOKEN_ADMIN");
if (!credential) throw new Error("Artifacts acceptance credential is unavailable");
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
async function api(path, method = "GET", body, binary = false) {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status === 404) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    console.error(
      JSON.stringify({
        path,
        http_status: response.status,
        error_codes: failure?.errors?.map((error) => error.code) ?? [],
      }),
    );
    throw new Error(`ARTIFACTS_HTTP_${response.status}`);
  }
  if (response.status === 204) return null;
  if (binary) return response.blob();
  const envelope = await response.json();
  if (envelope.success !== true) {
    console.error(
      JSON.stringify({
        path,
        envelope_keys: Object.keys(envelope),
        error_codes: envelope.errors?.map((error) => error.code) ?? [],
      }),
    );
    throw new Error("ARTIFACTS_RESPONSE_INVALID");
  }
  return envelope.result;
}
const account = await api("");
if (account.id !== accountId || account.name !== "amerged")
  throw new Error("ARTIFACTS_ACCOUNT_MISMATCH");
const receipts = [];
for (const region of ["us", "eu"]) {
  const namespace = `ohmyhost-development-${region}`;
  const repository = `p39-proof-${randomUUID().slice(0, 12)}`;
  const prefix = `/artifacts/namespaces/${namespace}`;
  const repositoryPath = `${prefix}/repos/${repository}`;
  let creationAttempted = false;
  const normalizeInfo = (value) => ({ ...value, defaultBranch: value.default_branch });
  const handle = {
    info: async () => normalizeInfo(await api(repositoryPath)),
    createToken: async (scope, ttl) => {
      const result = await api(`${prefix}/tokens`, "POST", { repo: repository, scope, ttl });
      return result;
    },
    readCommit: (hash) => api(`${repositoryPath}/commit/${hash}`),
    readTree: (hash) => api(`${repositoryPath}/tree/${hash}`),
    readBlob: (hash) => api(`${repositoryPath}/blob/${hash}`, "GET", undefined, true),
    log: ({ ref, limit, offset }) =>
      api(
        `${repositoryPath}/log?${new URLSearchParams({ ref, limit: String(limit), offset: String(offset) })}`,
      ),
  };
  const adapter = createManagedGitAdapter({
    accountId,
    namespace,
    timeoutMs: 60_000,
    artifacts: {
      get: async (name) => {
        if (name !== repository) throw new Error("Acceptance repository mismatch");
        await api(repositoryPath);
        if (!creationAttempted) throw new Error("Acceptance repository already exists");
        return handle;
      },
      create: async (name, options) => {
        if (name !== repository) throw new Error("Acceptance repository mismatch");
        creationAttempted = true;
        return normalizeInfo(
          await api(`${prefix}/repos`, "POST", {
            name,
            default_branch: options.setDefaultBranch,
            read_only: options.readOnly,
          }),
        );
      },
    },
  });
  let failure = null;
  try {
    await adapter.ensureRepository({ name: repository, branch: "main" });
    const metadata = {
      authorName: "ohmyho.st acceptance",
      authorEmail: "agent@ohmyho.st",
      message: "Initial source",
      timestampSeconds: Math.floor(Date.now() / 1000),
      operationId: randomUUID(),
    };
    const first = await adapter.prepareCommit({
      name: repository,
      branch: "main",
      expectedHead: null,
      changes: [
        { path: "README.md", content: "# Managed source acceptance\n" },
        { path: "src/main.ts", content: "export const version = 1;\n" },
      ],
      metadata,
    });
    await adapter.pushPrepared(first);
    const firstHead = await adapter.head({ name: repository, branch: "main" });
    if (firstHead !== first.commitSha) throw new Error("INITIAL_HEAD_MISMATCH");
    const request = {
      name: repository,
      branch: "main",
      expectedHead: first.commitSha,
      changes: [{ path: "src/main.ts", content: "export const version = 2;\n" }],
      metadata: { ...metadata, message: "Second source", operationId: randomUUID() },
    };
    const second = await adapter.prepareCommit(request);
    const repeated = await adapter.prepareCommit(request);
    if (second.commitSha !== repeated.commitSha) throw new Error("CANDIDATE_NOT_DETERMINISTIC");
    const competing = await adapter.prepareCommit({
      ...request,
      changes: [{ path: "README.md", content: "# Competing source\n" }],
      metadata: { ...request.metadata, operationId: randomUUID() },
    });
    const outcomes = await Promise.allSettled([
      adapter.pushPrepared(second),
      adapter.pushPrepared(competing),
    ]);
    if (outcomes.filter((value) => value.status === "fulfilled").length !== 1)
      throw new Error("CAS_PROOF_FAILED");
    const current = await adapter.head({ name: repository, branch: "main" });
    const restored = await adapter.prepareRestore({
      name: repository,
      branch: "main",
      expectedHead: current,
      restoreCommitSha: first.commitSha,
      metadata: { ...metadata, message: "Restore source", operationId: randomUUID() },
    });
    await adapter.pushPrepared(restored);
    const file = await adapter.readFile({
      name: repository,
      commitSha: restored.commitSha,
      path: "src/main.ts",
    });
    if (new TextDecoder().decode(file) !== "export const version = 1;\n")
      throw new Error("RESTORE_PROOF_FAILED");
    const archive = await adapter.exportCommit({ name: repository, commitSha: restored.commitSha });
    const archiveAgain = await adapter.exportCommit({
      name: repository,
      commitSha: restored.commitSha,
    });
    if (archive.sha256 !== archiveAgain.sha256) throw new Error("ARCHIVE_NOT_DETERMINISTIC");
    receipts.push({
      region,
      namespace,
      repository,
      initial_commit: first.commitSha,
      restored_commit: restored.commitSha,
      concurrent_successes: 1,
      history_length: (await adapter.history({ name: repository, ref: "main" })).length,
      archive_sha256: archive.sha256,
      archive_bytes: archive.byteLength,
    });
  } catch (error) {
    failure = error ?? new Error("ARTIFACTS_PROOF_FAILED");
  } finally {
    failure = await cleanupDisposableRepository(
      {
        creationAttempted,
        name: repository,
        remote: `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repository}.git`,
        read: () => api(repositoryPath),
        remove: () => api(repositoryPath, "DELETE"),
      },
      failure,
    );
  }
  if (failure !== null) throw failure;
}
console.log(
  JSON.stringify(
    { account_id: accountId, proofs: receipts, disposable_repositories_deleted: true },
    null,
    2,
  ),
);
