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
  validateCandidateArtifact,
  verifyEvidenceFile,
  writeEvidence,
} from "./phase1-evidence-core.mjs";
import { sanitizeCapabilityProbeResult } from "./phase1-auth-preflight-capabilities.mjs";
import { verifyGitHubAttestation } from "./phase1-github-attestation.mjs";

const SCOPE = "phase1_auth_preflight";
const COMMAND = "pnpm phase1:auth-preflight";
const REQUIRED_CAPABILITY_OBSERVATIONS = Object.freeze([
  "authkit_oidc_metadata",
  "connect_applications_read",
  "connect_client_secrets_metadata_read",
  "fga_resources_read",
  "memberships_read",
  "m2m_token_flow",
  "organizations_read",
  "webhook_endpoints_read",
]);

const validDate = (value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

const readVerifiedSnapshot = async (path, changedReason) => {
  const before = await readFile(path);
  const record = await verifyEvidenceFile(path);
  const after = await readFile(path);
  if (
    sha256(before) !== sha256(after) ||
    JSON.stringify(JSON.parse(after.toString("utf8"))) !== JSON.stringify(record)
  ) {
    throw new Error(changedReason);
  }
  return { record, sha256: sha256(after) };
};

const safeSubordinate = (record, expectedScope) => {
  if (
    record.scope !== expectedScope ||
    !["PASS", "BLOCKED_PREREQUISITE"].includes(record.runner_state) ||
    record.foundation_outcome !== "BLOCKED" ||
    record.candidate_outcome !== "UNDECIDED"
  ) {
    return false;
  }
  if (expectedScope === "phase1_auth_preflight_names") return true;
  if (
    record.sanitized_metrics?.backend_decision !== null ||
    !Array.isArray(record.sanitized_metrics?.gate_closures) ||
    record.sanitized_metrics.gate_closures.length !== 0
  ) {
    return false;
  }
  if (record.runner_state === "BLOCKED_PREREQUISITE") return true;
  const observations = record.sanitized_metrics?.observations;
  const producerEvidence = record.sanitized_metrics?.producer_evidence;
  let sanitizedProbe;
  try {
    sanitizedProbe = sanitizeCapabilityProbeResult({
      runner_state: record.runner_state,
      reason_code: record.reason_code,
      provider_calls: record.sanitized_metrics?.provider_calls,
      provider_credentials_resolved: record.sanitized_metrics?.provider_credentials_resolved,
      observations,
    });
  } catch {
    return false;
  }
  return (
    record.reason_code === "CAPABILITY_MEASUREMENT_PASSED" &&
    JSON.stringify(Object.keys(record.sanitized_metrics).sort()) ===
      JSON.stringify(
        [
          "backend_decision",
          "cloudflare_worker_version_id",
          "gate_closures",
          "management_artifact_sha256",
          "measurement_mode",
          "observations",
          "producer_attested",
          "producer_evidence",
          "provider_calls",
          "provider_credentials_resolved",
          "source_digest",
          "source_ref",
          "subordinate_evidence",
        ].sort(),
      ) &&
    record.sanitized_metrics?.measurement_mode === "producer_attested_github" &&
    record.sanitized_metrics?.producer_attested === true &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      record.sanitized_metrics?.cloudflare_worker_version_id ?? "",
    ) &&
    sanitizedProbe.providerCalls >= REQUIRED_CAPABILITY_OBSERVATIONS.length &&
    sanitizedProbe.providerCredentialsResolved >= 2 &&
    sanitizedProbe.observations.length === REQUIRED_CAPABILITY_OBSERVATIONS.length &&
    REQUIRED_CAPABILITY_OBSERVATIONS.every((id) =>
      sanitizedProbe.observations.some((observation) => observation.id === id),
    ) &&
    producerEvidence !== null &&
    typeof producerEvidence === "object" &&
    !Array.isArray(producerEvidence) &&
    JSON.stringify(Object.keys(producerEvidence).sort()) ===
      JSON.stringify(["run_id", "scope", "sha256"]) &&
    producerEvidence.scope === "phase1_auth_preflight_capability_producer" &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(producerEvidence.run_id ?? "") &&
    /^[a-f0-9]{64}$/u.test(producerEvidence.sha256 ?? "") &&
    /^[a-f0-9]{40}$/u.test(record.sanitized_metrics?.source_digest ?? "") &&
    record.sanitized_metrics?.source_ref === "refs/heads/main" &&
    record.git_commit === record.sanitized_metrics.source_digest &&
    record.dirty === false &&
    record.sanitized_metrics?.backend_decision === null &&
    Array.isArray(record.sanitized_metrics?.gate_closures) &&
    record.sanitized_metrics.gate_closures.length === 0
  );
};

export const runAuthPreflight = async ({
  root,
  names = null,
  capabilities = null,
  credentialStorePaths = [],
  githubRepository = process.env["GITHUB_REPOSITORY"] ?? "",
  now = () => new Date(),
  runId = createRunId(),
}) => {
  const startedAt = now();
  let artifact = null;
  let namesRecord = null;
  let capabilityRecord = null;
  let subordinateEvidence = null;
  let runnerState = "FAIL";
  let reasonCode = "AUTH_PREFLIGHT_VALIDATION_FAILED";
  let boundGitState = null;
  let boundWorktreeDigest = null;

  try {
    const namesPath = names ?? (await findNewestEvidence(root, "auth-preflight-names.json"));
    const capabilitiesPath =
      capabilities ?? (await findNewestEvidence(root, "auth-preflight-capabilities.json"));
    if (namesPath === null || capabilitiesPath === null) {
      runnerState = "BLOCKED_PREREQUISITE";
      reasonCode = "SUBORDINATE_PREFLIGHT_MISSING";
    } else {
      artifact = await validateCandidateArtifact(root);
    }
    if (artifact === null) {
      // Missing subordinate evidence is a prerequisite gap, not a runner malfunction.
    } else {
      const [namesSnapshot, capabilitySnapshot] = await Promise.all([
        readVerifiedSnapshot(namesPath, "NAMES_EVIDENCE_CHANGED_DURING_VALIDATION"),
        readVerifiedSnapshot(capabilitiesPath, "CAPABILITY_EVIDENCE_CHANGED_DURING_VALIDATION"),
      ]);
      namesRecord = namesSnapshot.record;
      capabilityRecord = capabilitySnapshot.record;
      subordinateEvidence = {
        names: {
          scope: namesRecord.scope,
          run_id: namesRecord.run_id,
          sha256: namesSnapshot.sha256,
        },
        capabilities: {
          scope: capabilityRecord.scope,
          run_id: capabilityRecord.run_id,
          sha256: capabilitySnapshot.sha256,
        },
      };
      if (
        !safeSubordinate(namesRecord, "phase1_auth_preflight_names") ||
        !safeSubordinate(capabilityRecord, "phase1_auth_preflight_capabilities")
      ) {
        reasonCode = "INVALID_SUBORDINATE_PREFLIGHT";
      } else if (
        capabilityRecord.sanitized_metrics?.management_artifact_sha256 !== artifact.artifact_sha256
      ) {
        reasonCode = "CAPABILITY_ARTIFACT_DIGEST_MISMATCH";
      } else {
        const namesFinished = validDate(namesRecord.finished_at);
        const capabilitiesStarted = validDate(capabilityRecord.started_at);
        const capabilitiesFinished = validDate(capabilityRecord.finished_at);
        const aggregateStarted = startedAt.getTime();
        if (
          namesFinished === null ||
          capabilitiesStarted === null ||
          capabilitiesFinished === null ||
          namesFinished > capabilitiesStarted ||
          capabilitiesStarted > capabilitiesFinished ||
          capabilitiesFinished > aggregateStarted
        ) {
          reasonCode = "INVALID_PREFLIGHT_CHRONOLOGY";
        } else if (
          namesRecord.runner_state === "BLOCKED_PREREQUISITE" ||
          capabilityRecord.runner_state === "BLOCKED_PREREQUISITE"
        ) {
          runnerState = "BLOCKED_PREREQUISITE";
          reasonCode = "SUBORDINATE_PREFLIGHT_BLOCKED";
        } else {
          const sourceDigest = capabilityRecord.sanitized_metrics.source_digest;
          const [preGitState, preWorktreeDigest] = await Promise.all([
            readGitState(root),
            createWorktreeDigest(root, credentialStorePaths),
          ]);
          if (
            preGitState.gitCommit !== sourceDigest ||
            preGitState.dirty ||
            capabilityRecord.worktree_digest !== preWorktreeDigest
          ) {
            throw new Error("CAPABILITY_ATTESTATION_WORKTREE_MISMATCH");
          }
          await verifyGitHubAttestation({
            root,
            subjectPath: capabilitiesPath,
            repository: githubRepository,
            signerWorkflow: `${githubRepository}/.github/workflows/phase1-workos-capabilities.yml`,
            sourceDigest,
            sourceRef: "refs/heads/main",
          });
          const [postCapability, postArtifact, postGitState, postWorktreeDigest] =
            await Promise.all([
              readFile(capabilitiesPath),
              validateCandidateArtifact(root),
              readGitState(root),
              createWorktreeDigest(root, credentialStorePaths),
            ]);
          if (sha256(postCapability) !== subordinateEvidence.capabilities.sha256) {
            throw new Error("CAPABILITY_EVIDENCE_CHANGED_AFTER_ATTESTATION");
          }
          if (postArtifact.artifact_sha256 !== artifact.artifact_sha256) {
            throw new Error("MANAGEMENT_ARTIFACT_CHANGED_AFTER_ATTESTATION");
          }
          if (
            postGitState.gitCommit !== preGitState.gitCommit ||
            postGitState.dirty !== preGitState.dirty ||
            postWorktreeDigest !== preWorktreeDigest
          ) {
            throw new Error("WORKTREE_CHANGED_AFTER_ATTESTATION");
          }
          boundGitState = postGitState;
          boundWorktreeDigest = postWorktreeDigest;
          runnerState = "PASS";
          reasonCode = "AUTH_PREFLIGHT_MEASUREMENT_PASSED";
        }
      }
    }
  } catch (error) {
    reasonCode =
      error instanceof Error && /^[A-Z][A-Z0-9_]*$/u.test(error.message)
        ? error.message
        : "AUTH_PREFLIGHT_VALIDATION_FAILED";
  }

  const gitState = boundGitState ?? (await readGitState(root));
  const worktreeDigest =
    boundWorktreeDigest ?? (await createWorktreeDigest(root, credentialStorePaths));
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
        id: "subordinate_preflight_evidence",
        state: runnerState,
        duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        evidence_ref: "auth-preflight.json#/sanitized_metrics/subordinate_evidence",
      },
    ],
    sanitized_metrics: {
      provider_calls: 0,
      provider_credentials_resolved: 0,
      management_artifact_sha256: artifact?.artifact_sha256 ?? null,
      subordinate_evidence: subordinateEvidence,
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: runnerState === "PASS" ? [] : [reasonCode],
  };
  return writeEvidence({ root, runId, filename: "auth-preflight.json", result });
};

const parseArguments = (arguments_) => {
  const options = {
    root: process.cwd(),
    names: null,
    capabilities: null,
    githubRepository: process.env["GITHUB_REPOSITORY"] ?? "",
    credentialStorePaths: [],
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--names") options.names = value;
    else if (argument === "--capabilities") options.capabilities = value;
    else if (argument === "--repository") options.githubRepository = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  return {
    ...options,
    root: resolve(options.root),
    names: options.names === null ? null : resolve(options.root, options.names),
    capabilities:
      options.capabilities === null ? null : resolve(options.root, options.capabilities),
  };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const execution = await runAuthPreflight(parseArguments(process.argv.slice(2)));
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "AUTH_PREFLIGHT_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
