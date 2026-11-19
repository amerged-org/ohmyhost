/* global process */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA_VERSION,
  createRunId,
  createWorktreeDigest,
  findNewestEvidence,
  readGitState,
  sha256,
  verifyEvidenceFile,
  writeEvidence,
} from "./phase1-evidence-core.mjs";
import { verifyGitHubAttestation } from "./phase1-github-attestation.mjs";

const SCOPE = "phase1_credential_store_platforms";
const COMMAND = "pnpm phase1:credential-store-platforms";
const PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);
const BACKENDS = Object.freeze({
  darwin: "keychain",
  linux: "secret_service",
  win32: "credential_manager",
});
const REQUIRED_CHECKS = Object.freeze(["create", "read", "rotate", "delete", "security"]);

const validateChronology = (record, aggregateStartedAt) => {
  const startedAt = Date.parse(record.started_at);
  const finishedAt = Date.parse(record.finished_at);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    startedAt > finishedAt ||
    finishedAt > aggregateStartedAt.getTime()
  ) {
    throw new Error("INVALID_NATIVE_PLATFORM_CHRONOLOGY");
  }
};

const validateCommonState = (record, platform) => {
  if (
    record.scope !== "phase1_credential_store_platform" ||
    record.foundation_outcome !== "BLOCKED" ||
    record.candidate_outcome !== "UNDECIDED" ||
    record.sanitized_metrics?.platform !== platform ||
    record.sanitized_metrics?.native_backend !== BACKENDS[platform] ||
    record.sanitized_metrics?.backend_verified !== (record.runner_state === "PASS") ||
    record.sanitized_metrics?.provider_calls !== 0 ||
    record.sanitized_metrics?.backend_decision !== null ||
    !Array.isArray(record.sanitized_metrics?.gate_closures) ||
    record.sanitized_metrics.gate_closures.length !== 0 ||
    !Array.isArray(record.checks)
  ) {
    throw new Error("INVALID_NATIVE_PLATFORM_EVIDENCE");
  }
  const ids = record.checks.map(({ id }) => id);
  if (
    ids.length !== REQUIRED_CHECKS.length ||
    new Set(ids).size !== REQUIRED_CHECKS.length ||
    REQUIRED_CHECKS.some((id) => !ids.includes(id))
  ) {
    throw new Error("INVALID_NATIVE_PLATFORM_EVIDENCE");
  }
};

const validatePlatformRecord = (record, platform, aggregateStartedAt) => {
  validateCommonState(record, platform);
  validateChronology(record, aggregateStartedAt);
  if (record.runner_state === "BLOCKED_PREREQUISITE") {
    if (
      record.sanitized_metrics.real_native !== false ||
      record.checks.some(({ state }) => state !== "BLOCKED_PREREQUISITE")
    ) {
      throw new Error("INVALID_NATIVE_PLATFORM_EVIDENCE");
    }
    return "BLOCKED_PREREQUISITE";
  }
  if (record.runner_state === "FAIL") throw new Error("NATIVE_PLATFORM_CHILD_FAILED");
  if (record.runner_state !== "PASS" || record.sanitized_metrics.real_native !== true) {
    throw new Error("INVALID_NATIVE_PLATFORM_EVIDENCE");
  }
  if (record.checks.some(({ state }) => state !== "PASS")) {
    throw new Error("NATIVE_PLATFORM_CHECK_FAILED");
  }
  return "PASS";
};

const runCredentialStorePlatformsInternal = async (
  {
    root,
    platformEvidence = {},
    credentialStorePaths = [],
    now = () => new Date(),
    runId = createRunId(),
  },
  verifiedAttestations,
) => {
  const startedAt = now();
  let runnerState = "BLOCKED_PREREQUISITE";
  let reasonCode = "NATIVE_PLATFORM_EVIDENCE_MISSING";
  let unmetPrerequisites = [];
  const sanitizedPlatformEvidence = {};
  const platformStates = {};
  let producerAttested = false;
  let sourceDigest = null;

  try {
    const paths = {};
    for (const platform of PLATFORMS) {
      paths[platform] =
        platformEvidence[platform] ??
        (await findNewestEvidence(root, `credential-store-platform-${platform}.json`));
    }
    unmetPrerequisites = PLATFORMS.filter((platform) => paths[platform] === null);
    for (const platform of PLATFORMS) {
      const path = paths[platform];
      if (path === null) continue;
      let record;
      try {
        record = await verifyEvidenceFile(path);
      } catch {
        throw new Error("NATIVE_PLATFORM_EVIDENCE_INVALID");
      }
      const state = validatePlatformRecord(record, platform, startedAt);
      platformStates[platform] = state;
      sanitizedPlatformEvidence[platform] = {
        run_id: record.run_id,
        runner_state: record.runner_state,
        real_native: record.sanitized_metrics.real_native,
        native_backend: record.sanitized_metrics.native_backend,
        sha256: sha256(await readFile(path)),
      };
    }
    const blockedPlatforms = PLATFORMS.filter(
      (platform) => platformStates[platform] === "BLOCKED_PREREQUISITE",
    );
    unmetPrerequisites = [...new Set([...unmetPrerequisites, ...blockedPlatforms])];
    if (unmetPrerequisites.length > 0) {
      runnerState = "BLOCKED_PREREQUISITE";
      reasonCode =
        blockedPlatforms.length > 0
          ? "NATIVE_PLATFORM_PREREQUISITE_BLOCKED"
          : "NATIVE_PLATFORM_EVIDENCE_MISSING";
    } else {
      const attestations = PLATFORMS.map((platform) => verifiedAttestations[platform]);
      const firstSourceDigest = attestations[0]?.source_digest;
      const verified = attestations.every(
        (attestation, index) =>
          attestation?.platform === PLATFORMS[index] &&
          attestation?.proof_sha256 === sanitizedPlatformEvidence[PLATFORMS[index]].sha256 &&
          attestation?.source_digest === firstSourceDigest &&
          attestation?.source_ref === "refs/heads/main" &&
          attestation?.hosted_runner_only === true,
      );
      if (verified && typeof firstSourceDigest === "string") {
        runnerState = "PASS";
        reasonCode = "ATTESTED_NATIVE_PLATFORM_EVIDENCE_PASSED";
        unmetPrerequisites = [];
        producerAttested = true;
        sourceDigest = firstSourceDigest;
      } else {
        runnerState = "BLOCKED_PREREQUISITE";
        reasonCode = "ATTESTED_NATIVE_PLATFORM_EVIDENCE_UNAVAILABLE";
        unmetPrerequisites = ["native_platform_attestation"];
      }
    }
  } catch (error) {
    runnerState = "FAIL";
    reasonCode = error instanceof Error ? error.message : "NATIVE_PLATFORM_EVIDENCE_INVALID";
    unmetPrerequisites = [];
  }

  const gitState = await readGitState(root);
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
    worktree_digest: await createWorktreeDigest(root, credentialStorePaths),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks: PLATFORMS.map((platform) => ({
      id: `native_credential_store_${platform}`,
      state: platformStates[platform] ?? (runnerState === "FAIL" ? "FAIL" : "BLOCKED_PREREQUISITE"),
      duration_ms: 0,
      evidence_ref: `credential-store-platforms.json#/sanitized_metrics/platform_evidence/${platform}`,
    })),
    sanitized_metrics: {
      required_platforms: [...PLATFORMS],
      native_operations: 0,
      provider_calls: 0,
      platform_evidence: sanitizedPlatformEvidence,
      producer_attested: producerAttested,
      source_digest: sourceDigest,
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: unmetPrerequisites,
  };
  return writeEvidence({ root, runId, filename: "credential-store-platforms.json", result });
};

export const runCredentialStorePlatforms = (options) =>
  runCredentialStorePlatformsInternal(options, {});

const validateAttestationInputs = ({ repository, signerWorkflow, sourceDigest, sourceRef }) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("INVALID_ATTESTATION_REPOSITORY");
  }
  if (signerWorkflow !== `${repository}/.github/workflows/phase1-native-keyring.yml`) {
    throw new Error("INVALID_ATTESTATION_WORKFLOW");
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceDigest) || sourceRef !== "refs/heads/main") {
    throw new Error("INVALID_ATTESTATION_SOURCE");
  }
};

export const runAttestedCredentialStorePlatforms = async ({
  root,
  platformEvidence,
  repository,
  signerWorkflow,
  sourceDigest,
  sourceRef,
  ...aggregateOptions
}) => {
  validateAttestationInputs({ repository, signerWorkflow, sourceDigest, sourceRef });
  const gitState = await readGitState(root);
  if (gitState.gitCommit !== sourceDigest || gitState.dirty) {
    throw new Error("ATTESTATION_WORKTREE_MISMATCH");
  }
  const verifiedAttestations = {};
  let worktreeDigest;
  for (const platform of PLATFORMS) {
    const evidencePath = platformEvidence[platform];
    if (typeof evidencePath !== "string") throw new Error("NATIVE_PLATFORM_EVIDENCE_MISSING");
    const record = await verifyEvidenceFile(evidencePath);
    if (
      record.scope !== "phase1_credential_store_platform" ||
      record.runner_state !== "PASS" ||
      record.git_commit !== sourceDigest ||
      record.dirty !== false ||
      record.sanitized_metrics?.platform !== platform ||
      record.sanitized_metrics?.backend_verified !== true
    ) {
      throw new Error("NATIVE_PLATFORM_ATTESTATION_INVALID");
    }
    worktreeDigest ??= record.worktree_digest;
    if (record.worktree_digest !== worktreeDigest) {
      throw new Error("NATIVE_PLATFORM_WORKTREE_MISMATCH");
    }
    await verifyGitHubAttestation({
      root,
      subjectPath: evidencePath,
      repository,
      signerWorkflow,
      sourceDigest,
      sourceRef,
    });
    verifiedAttestations[platform] = {
      platform,
      proof_sha256: sha256(await readFile(evidencePath)),
      source_digest: sourceDigest,
      source_ref: sourceRef,
      hosted_runner_only: true,
    };
  }
  return runCredentialStorePlatformsInternal(
    { root, platformEvidence, ...aggregateOptions },
    verifiedAttestations,
  );
};

const parseArguments = (arguments_) => {
  const options = { root: process.cwd(), platformEvidence: {}, credentialStorePaths: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (PLATFORMS.some((platform) => argument === `--${platform}`)) {
      options.platformEvidence[argument.slice(2)] = value;
    } else if (argument === "--credential-store-path") {
      options.credentialStorePaths.push(value);
    } else {
      throw new Error("INVALID_ARGUMENTS");
    }
    index += 1;
  }
  const root = resolve(options.root);
  return {
    ...options,
    root,
    platformEvidence: Object.fromEntries(
      Object.entries(options.platformEvidence).map(([platform, path]) => [
        platform,
        resolve(root, path),
      ]),
    ),
  };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const execution = await runCredentialStorePlatforms(parseArguments(process.argv.slice(2)));
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "CREDENTIAL_STORE_PLATFORM_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
