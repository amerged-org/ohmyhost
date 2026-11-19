/* global AbortController, Response, TextDecoder, URL, clearTimeout, fetch, process, setTimeout */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA_VERSION,
  createRunId,
  createWorktreeDigest,
  readGitState,
  sha256,
  validateCandidateArtifact,
  verifyEvidenceFile,
  writeEvidence,
} from "./phase1-evidence-core.mjs";
import { sanitizeCapabilityProbeResult } from "./phase1-auth-preflight-capabilities.mjs";

const SCOPE = "phase1_auth_preflight_capability_producer";
const COMMAND = "pnpm phase1:auth-preflight:capabilities:producer";
const REQUEST_ID = "capability-producer";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_BYTES = 65_536;
const ARTIFACT_HEADER = "x-ohmyhost-management-artifact-sha256";
const VERSION_ID_HEADER = "x-ohmyhost-cloudflare-version-id";
const VERSION_TAG_HEADER = "x-ohmyhost-cloudflare-version-tag";

const exactKeys = (value, expected) => {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
};

const record = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
  }
  return value;
};

const validateEndpoint = (value) => {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("INVALID_CAPABILITY_PRODUCER_ENDPOINT");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    !/^\d{1,5}$/u.test(endpoint.port) ||
    Number(endpoint.port) < 1024 ||
    Number(endpoint.port) > 65_535 ||
    endpoint.pathname !== "/probe" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_ENDPOINT");
  }
  return endpoint.href;
};

const readBoundedJson = async (response, maximumBytes) => {
  if (!(response instanceof Response) || response.status !== 200 || response.body === null) {
    throw new Error("CAPABILITY_PROBE_UNAVAILABLE");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const encoding = response.headers.get("content-encoding");
  if (contentType !== "application/json" || (encoding !== null && encoding !== "identity")) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
  }
  const declared = response.headers.get("content-length");
  let declaredBytes = null;
  if (declared !== null) {
    declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maximumBytes) {
      throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredBytes !== null && declaredBytes !== total) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
  }
};

const invokeLoopbackProbe = async ({ endpoint, timeoutMs, maximumBytes }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = await readBoundedJson(response, maximumBytes);
    return { response, body };
  } catch (error) {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]*$/u.test(error.message)) throw error;
    throw new Error("CAPABILITY_PROBE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
};

const readVerifiedSnapshot = async (path, changedReason) => {
  const before = await readFile(path);
  const record = await verifyEvidenceFile(path);
  const after = await readFile(path);
  if (sha256(before) !== sha256(after)) throw new Error(changedReason);
  return { record, sha256: sha256(after) };
};

const validateP1a = (record, artifactSha256) => {
  if (
    record.scope !== "phase1_p1a_local" ||
    record.runner_state !== "PASS" ||
    record.foundation_outcome !== "BLOCKED" ||
    record.candidate_outcome !== "UNDECIDED" ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(record.run_id ?? "") ||
    record.sanitized_metrics?.management_artifact_sha256 !== artifactSha256 ||
    record.sanitized_metrics?.backend_decision !== null ||
    !Array.isArray(record.sanitized_metrics?.gate_closures) ||
    record.sanitized_metrics.gate_closures.length !== 0 ||
    record.dirty !== false ||
    !/^[a-f0-9]{40}$/u.test(record.git_commit ?? "") ||
    !/^[a-f0-9]{64}$/u.test(record.worktree_digest ?? "")
  ) {
    throw new Error("INVALID_P1A_EVIDENCE");
  }
  const startedAt = Date.parse(record.started_at);
  const finishedAt = Date.parse(record.finished_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt > finishedAt) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_CHRONOLOGY");
  }
  return finishedAt;
};

const parseProbeBody = (value) => {
  const response = record(value);
  if (
    !exactKeys(response, ["method", "requestId", "ok", "result"]) ||
    response.method !== "capabilities.probe_read_only" ||
    response.requestId !== REQUEST_ID ||
    response.ok !== true
  ) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
  }
  const result = record(response.result);
  if (!exactKeys(result, ["observations"]) || !Array.isArray(result.observations)) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
  }
  return sanitizeCapabilityProbeResult({
    runner_state: "PASS",
    reason_code: "CAPABILITY_MEASUREMENT_PASSED",
    provider_calls: 8,
    provider_credentials_resolved: 2,
    observations: result.observations.map((observationValue) => {
      const observation = record(observationValue);
      if (!exactKeys(observation, ["id", "available", "statusCode", "count"])) {
        const keys = Object.keys(observation);
        if (!(keys.length === 3 && !keys.includes("count"))) {
          throw new Error("INVALID_CAPABILITY_PROBE_RESPONSE");
        }
      }
      return observation.count === undefined
        ? {
            id: observation.id,
            available: observation.available,
            status_code: observation.statusCode,
          }
        : {
            id: observation.id,
            available: observation.available,
            count: observation.count,
            status_code: observation.statusCode,
          };
    }),
  });
};

export const runCapabilityProducer = async ({
  root,
  p1a,
  endpoint,
  credentialStorePaths = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  now = () => new Date(),
  runId = createRunId(),
  probe = invokeLoopbackProbe,
}) => {
  const safeEndpoint = validateEndpoint(endpoint);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > DEFAULT_MAXIMUM_BYTES
  ) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_LIMIT");
  }
  const startedAt = now();
  let runnerState = "FAIL";
  let reasonCode = "CAPABILITY_PRODUCER_VALIDATION_FAILED";
  let artifact = null;
  let p1aSnapshot = null;
  let observations = [];
  let providerCalls = 0;
  let providerCredentialsResolved = 0;
  let cloudflareWorkerVersionId = null;
  let gitState = await readGitState(root);
  let worktreeDigest = await createWorktreeDigest(root, credentialStorePaths);

  try {
    [artifact, p1aSnapshot] = await Promise.all([
      validateCandidateArtifact(root),
      readVerifiedSnapshot(p1a, "P1A_EVIDENCE_CHANGED_DURING_CAPABILITY_PROBE"),
    ]);
    const p1aFinishedAt = validateP1a(p1aSnapshot.record, artifact.artifact_sha256);
    if (p1aFinishedAt > startedAt.getTime()) {
      throw new Error("INVALID_CAPABILITY_PRODUCER_CHRONOLOGY");
    }
    if (
      gitState.dirty ||
      gitState.gitCommit !== p1aSnapshot.record.git_commit ||
      worktreeDigest !== p1aSnapshot.record.worktree_digest
    ) {
      throw new Error("CAPABILITY_PRODUCER_WORKTREE_MISMATCH");
    }
    const probed = await probe({
      endpoint: safeEndpoint,
      requestId: REQUEST_ID,
      timeoutMs,
      maximumBytes,
    });
    const response = probed instanceof Response ? probed : probed.response;
    const body =
      probed instanceof Response ? await readBoundedJson(probed, maximumBytes) : probed.body;
    if (
      !(response instanceof Response) ||
      response.headers.get(ARTIFACT_HEADER) !== artifact.artifact_sha256
    ) {
      throw new Error("REMOTE_MANAGEMENT_ARTIFACT_MISMATCH");
    }
    const versionId = response.headers.get(VERSION_ID_HEADER);
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(versionId ?? "") ||
      response.headers.get(VERSION_TAG_HEADER) !== artifact.artifact_sha256
    ) {
      throw new Error("REMOTE_MANAGEMENT_VERSION_MISMATCH");
    }
    const sanitized = parseProbeBody(body);
    const [postP1a, postArtifact, postGitState, postWorktreeDigest] = await Promise.all([
      readFile(p1a),
      validateCandidateArtifact(root),
      readGitState(root),
      createWorktreeDigest(root, credentialStorePaths),
    ]);
    if (sha256(postP1a) !== p1aSnapshot.sha256) {
      throw new Error("P1A_EVIDENCE_CHANGED_DURING_CAPABILITY_PROBE");
    }
    if (postArtifact.artifact_sha256 !== artifact.artifact_sha256) {
      throw new Error("MANAGEMENT_ARTIFACT_CHANGED_DURING_CAPABILITY_PROBE");
    }
    if (
      postGitState.dirty ||
      postGitState.gitCommit !== gitState.gitCommit ||
      postWorktreeDigest !== worktreeDigest
    ) {
      throw new Error("WORKTREE_CHANGED_DURING_CAPABILITY_PROBE");
    }
    observations = sanitized.observations;
    providerCalls = sanitized.providerCalls;
    providerCredentialsResolved = sanitized.providerCredentialsResolved;
    cloudflareWorkerVersionId = versionId;
    runnerState = "PASS";
    reasonCode = sanitized.reasonCode;
    gitState = postGitState;
    worktreeDigest = postWorktreeDigest;
  } catch (error) {
    reasonCode =
      error instanceof Error && /^[A-Z][A-Z0-9_]*$/u.test(error.message)
        ? error.message
        : "CAPABILITY_PRODUCER_VALIDATION_FAILED";
  }

  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: SCOPE,
    runner_state: runnerState,
    foundation_outcome: "BLOCKED",
    candidate_outcome: "UNDECIDED",
    reason_code: reasonCode,
    command: COMMAND,
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: worktreeDigest,
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks: [
      {
        id: "provider_capability_measurement",
        state: runnerState,
        duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        evidence_ref: "auth-preflight-capabilities-producer.json#/sanitized_metrics/observations",
      },
    ],
    sanitized_metrics: {
      measurement_mode: "isolated_management_probe",
      provider_calls: providerCalls,
      provider_credentials_resolved: providerCredentialsResolved,
      management_artifact_sha256: artifact?.artifact_sha256 ?? null,
      cloudflare_worker_version_id: cloudflareWorkerVersionId,
      observations,
      subordinate_evidence:
        p1aSnapshot === null
          ? null
          : {
              scope: p1aSnapshot.record.scope,
              run_id: p1aSnapshot.record.run_id,
              sha256: p1aSnapshot.sha256,
            },
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: runnerState === "PASS" ? [] : [reasonCode],
  };
  return writeEvidence({
    root,
    runId,
    filename: "auth-preflight-capabilities-producer.json",
    result,
  });
};

export const parseCapabilityProducerArguments = (arguments_, rootDirectory = process.cwd()) => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const options = { root: rootDirectory, p1a: null, endpoint: null, credentialStorePaths: [] };
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const value = normalized[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--p1a") options.p1a = value;
    else if (argument === "--endpoint") options.endpoint = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  if (options.p1a === null || options.endpoint === null) throw new Error("INVALID_ARGUMENTS");
  const root = resolve(options.root);
  return {
    ...options,
    root,
    p1a: resolve(root, options.p1a),
    endpoint: validateEndpoint(options.endpoint),
  };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const execution = await runCapabilityProducer(
      parseCapabilityProducerArguments(process.argv.slice(2)),
    );
    process.stdout.write(execution.serialized);
    process.exitCode = execution.result.runner_state === "PASS" ? 0 : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({
        runner_state: "FAIL",
        foundation_outcome: "BLOCKED",
        candidate_outcome: "UNDECIDED",
        reason_code: "CAPABILITY_PRODUCER_RUNNER_FAILURE",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
