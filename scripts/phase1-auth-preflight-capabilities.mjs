/* global process */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_SHA256,
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
import { verifyGitHubAttestation } from "./phase1-github-attestation.mjs";

const SCOPE = "phase1_auth_preflight_capabilities";
const COMMAND = "pnpm phase1:auth-preflight:capabilities";
const ATTESTED_COMMAND = "pnpm phase1:auth-preflight:capabilities:attested";
const REQUIRED_OBSERVATION_IDS = Object.freeze([
  "authkit_oidc_metadata",
  "connect_applications_read",
  "connect_client_secrets_metadata_read",
  "fga_resources_read",
  "memberships_read",
  "m2m_token_flow",
  "organizations_read",
  "webhook_endpoints_read",
]);
const ALLOWED_OBSERVATION_IDS = new Set(REQUIRED_OBSERVATION_IDS);
export const CAPABILITY_ATTESTATION_WORKFLOW_PATH =
  ".github/workflows/phase1-workos-capabilities.yml";
const PRODUCER_SCOPE = "phase1_auth_preflight_capability_producer";
const PRODUCER_FILENAME = "auth-preflight-capabilities-producer.json";
const PRODUCER_COMMAND = "pnpm phase1:auth-preflight:capabilities:producer";

const isSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export const sanitizeCapabilityProbeResult = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
  }
  const allowedKeys = new Set([
    "runner_state",
    "reason_code",
    "provider_calls",
    "provider_credentials_resolved",
    "observations",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
  }
  if (
    !["PASS", "BLOCKED_PREREQUISITE"].includes(value.runner_state) ||
    typeof value.reason_code !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/u.test(value.reason_code) ||
    !isSafeInteger(value.provider_calls) ||
    !isSafeInteger(value.provider_credentials_resolved) ||
    !Array.isArray(value.observations)
  ) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
  }
  const observations = value.observations.map((observation) => {
    if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
      throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
    }
    const keys = Object.keys(observation);
    if (
      keys.some((key) => !["id", "available", "count", "status_code"].includes(key)) ||
      !ALLOWED_OBSERVATION_IDS.has(observation.id) ||
      typeof observation.available !== "boolean" ||
      !Number.isSafeInteger(observation.status_code) ||
      observation.status_code < 100 ||
      observation.status_code > 599 ||
      (observation.count !== undefined && !isSafeInteger(observation.count))
    ) {
      throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
    }
    return observation.count === undefined
      ? {
          id: observation.id,
          available: observation.available,
          status_code: observation.status_code,
        }
      : {
          id: observation.id,
          available: observation.available,
          count: observation.count,
          status_code: observation.status_code,
        };
  });
  if (new Set(observations.map(({ id }) => id)).size !== observations.length) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
  }
  if (
    value.runner_state === "PASS" &&
    (value.provider_calls === 0 ||
      value.provider_credentials_resolved === 0 ||
      observations.length !== REQUIRED_OBSERVATION_IDS.length ||
      REQUIRED_OBSERVATION_IDS.some(
        (id) => !observations.some((observation) => observation.id === id),
      ))
  ) {
    throw new Error("INVALID_CAPABILITY_PROBE_RESULT");
  }
  return {
    runnerState: value.runner_state,
    reasonCode: value.reason_code,
    providerCalls: value.provider_calls,
    providerCredentialsResolved: value.provider_credentials_resolved,
    observations,
  };
};

const validP1a = (record, artifactSha256) =>
  record.scope === "phase1_p1a_local" &&
  /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(record.run_id ?? "") &&
  record.runner_state === "PASS" &&
  record.foundation_outcome === "BLOCKED" &&
  record.candidate_outcome === "UNDECIDED" &&
  record.sanitized_metrics?.management_artifact_sha256 === artifactSha256 &&
  record.sanitized_metrics?.backend_decision === null &&
  Array.isArray(record.sanitized_metrics?.gate_closures) &&
  record.sanitized_metrics.gate_closures.length === 0;

const validChronology = (record, startedAt) => {
  const recordStartedAt = Date.parse(record.started_at);
  const finishedAt = Date.parse(record.finished_at);
  return (
    Number.isFinite(recordStartedAt) &&
    Number.isFinite(finishedAt) &&
    recordStartedAt <= finishedAt &&
    finishedAt <= startedAt.getTime()
  );
};

const exactKeys = (value, expected) => {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
};

const validTimestamp = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  return { record, content: after, sha256: sha256(after) };
};

export const validateCapabilityProducerCandidate = ({
  producer,
  producerSha256,
  p1aRecord,
  p1aSha256,
  artifactSha256,
  sourceDigest,
  sourceRef,
  currentWorktreeDigest,
  aggregateStartedAt,
}) => {
  if (producer === null || typeof producer !== "object" || Array.isArray(producer)) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_SCHEMA");
  }
  const allowedProducerKeys = new Set([
    "schema_version",
    "scope",
    "runner_state",
    "foundation_outcome",
    "candidate_outcome",
    "reason_code",
    "command",
    "git_commit",
    "run_id",
    "worktree_digest",
    "dirty",
    "started_at",
    "finished_at",
    "checks",
    "sanitized_metrics",
    "unmet_prerequisites",
    "evidence_artifacts",
    "evidence_manifest_sha256",
  ]);
  if (Object.keys(producer).some((key) => !allowedProducerKeys.has(key))) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_SCHEMA");
  }
  if (
    producer.scope !== PRODUCER_SCOPE ||
    producer.runner_state !== "PASS" ||
    producer.foundation_outcome !== "BLOCKED" ||
    producer.candidate_outcome !== "UNDECIDED" ||
    producer.reason_code !== "CAPABILITY_MEASUREMENT_PASSED" ||
    producer.command !== PRODUCER_COMMAND ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(producer.run_id ?? "") ||
    producer.git_commit !== sourceDigest ||
    producer.dirty !== false ||
    !/^[a-f0-9]{64}$/u.test(producer.worktree_digest ?? "") ||
    sourceRef !== "refs/heads/main" ||
    !/^[a-f0-9]{40}$/u.test(sourceDigest) ||
    !/^[a-f0-9]{64}$/u.test(producerSha256) ||
    !/^[a-f0-9]{64}$/u.test(p1aSha256) ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256) ||
    !Array.isArray(producer.unmet_prerequisites) ||
    producer.unmet_prerequisites.length !== 0 ||
    !Array.isArray(producer.checks) ||
    producer.checks.length !== 1 ||
    producer.checks[0]?.id !== "provider_capability_measurement" ||
    producer.checks[0]?.state !== "PASS" ||
    !exactKeys(producer.checks[0], ["id", "state", "duration_ms", "evidence_ref"]) ||
    !isSafeInteger(producer.checks[0].duration_ms) ||
    producer.checks[0].evidence_ref !==
      "auth-preflight-capabilities-producer.json#/sanitized_metrics/observations" ||
    (producer.evidence_artifacts !== undefined &&
      (!Array.isArray(producer.evidence_artifacts) || producer.evidence_artifacts.length !== 0)) ||
    (producer.evidence_manifest_sha256 !== undefined &&
      producer.evidence_manifest_sha256 !== EMPTY_SHA256)
  ) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_SCHEMA");
  }
  const metrics = producer.sanitized_metrics;
  if (
    metrics === null ||
    typeof metrics !== "object" ||
    Array.isArray(metrics) ||
    !exactKeys(metrics, [
      "measurement_mode",
      "provider_calls",
      "provider_credentials_resolved",
      "management_artifact_sha256",
      "cloudflare_worker_version_id",
      "observations",
      "subordinate_evidence",
      "gate_closures",
      "backend_decision",
    ]) ||
    metrics.measurement_mode !== "isolated_management_probe" ||
    metrics.management_artifact_sha256 !== artifactSha256 ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      metrics.cloudflare_worker_version_id ?? "",
    ) ||
    metrics.backend_decision !== null ||
    !Array.isArray(metrics.gate_closures) ||
    metrics.gate_closures.length !== 0 ||
    metrics.subordinate_evidence === null ||
    typeof metrics.subordinate_evidence !== "object" ||
    Array.isArray(metrics.subordinate_evidence) ||
    !exactKeys(metrics.subordinate_evidence, ["scope", "run_id", "sha256"]) ||
    metrics.subordinate_evidence.scope !== "phase1_p1a_local" ||
    metrics.subordinate_evidence.run_id !== p1aRecord.run_id ||
    metrics.subordinate_evidence.sha256 !== p1aSha256
  ) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_SCHEMA");
  }
  const sanitized = sanitizeCapabilityProbeResult({
    runner_state: producer.runner_state,
    reason_code: producer.reason_code,
    provider_calls: metrics.provider_calls,
    provider_credentials_resolved: metrics.provider_credentials_resolved,
    observations: metrics.observations,
  });
  if (
    sanitized.providerCalls < REQUIRED_OBSERVATION_IDS.length ||
    sanitized.providerCredentialsResolved < 2
  ) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_SCHEMA");
  }
  if (
    !validP1a(p1aRecord, artifactSha256) ||
    p1aRecord.git_commit !== sourceDigest ||
    p1aRecord.dirty !== false
  ) {
    throw new Error("CAPABILITY_PRODUCER_P1A_MISMATCH");
  }
  if (
    producer.worktree_digest !== p1aRecord.worktree_digest ||
    producer.worktree_digest !== currentWorktreeDigest
  ) {
    throw new Error("CAPABILITY_PRODUCER_WORKTREE_MISMATCH");
  }
  const p1aStartedAt = validTimestamp(p1aRecord.started_at);
  const p1aFinishedAt = validTimestamp(p1aRecord.finished_at);
  const producerStartedAt = validTimestamp(producer.started_at);
  const producerFinishedAt = validTimestamp(producer.finished_at);
  if (
    p1aStartedAt === null ||
    p1aFinishedAt === null ||
    producerStartedAt === null ||
    producerFinishedAt === null ||
    p1aStartedAt > p1aFinishedAt ||
    p1aFinishedAt > producerStartedAt ||
    producerStartedAt > producerFinishedAt ||
    producerFinishedAt > aggregateStartedAt.getTime()
  ) {
    throw new Error("INVALID_CAPABILITY_PRODUCER_CHRONOLOGY");
  }
  return {
    ...sanitized,
    producerEvidence: {
      scope: producer.scope,
      run_id: producer.run_id,
      sha256: producerSha256,
    },
    sourceDigest,
    sourceRef,
    cloudflareWorkerVersionId: metrics.cloudflare_worker_version_id,
  };
};

const runCapabilityPreflightInternal = async (
  {
    root,
    p1a = null,
    probe = null,
    measurementMode = probe === null ? "fixture_only" : "isolated_management_probe",
    credentialStorePaths = [],
    now = () => new Date(),
    runId = createRunId(),
  },
  trusted = {},
) => {
  const startedAt = now();
  const safeMeasurementMode = [
    "fixture_only",
    "isolated_management_probe",
    "producer_attested_github",
  ].includes(measurementMode)
    ? measurementMode
    : "invalid";
  let artifact = null;
  let p1aRecord = null;
  let p1aSha256 = null;
  let runnerState = "FAIL";
  let reasonCode = "CAPABILITY_PREFLIGHT_VALIDATION_FAILED";
  let providerCalls = 0;
  let providerCredentialsResolved = 0;
  let observations = [];
  let producerAttested = false;
  let producerEvidence = null;
  let sourceDigest = null;
  let sourceRef = null;
  let cloudflareWorkerVersionId = null;

  try {
    if (trusted.snapshot !== undefined) {
      artifact = trusted.snapshot.artifact;
      p1aRecord = trusted.snapshot.p1aRecord;
      p1aSha256 = trusted.snapshot.p1aSha256;
    } else {
      const p1aPath = p1a ?? (await findNewestEvidence(root, "p1a-local.json"));
      if (p1aPath === null) {
        runnerState = "BLOCKED_PREREQUISITE";
        reasonCode = "P1A_EVIDENCE_MISSING";
      } else {
        artifact = await validateCandidateArtifact(root);
        p1aRecord = await verifyEvidenceFile(p1aPath);
        p1aSha256 = sha256(await readFile(p1aPath));
      }
    }
    if (p1aRecord === null) {
      // Missing P1A evidence is a prerequisite gap, not a runner malfunction.
    } else if (!artifact.launchable) {
      runnerState = "BLOCKED_PREREQUISITE";
      reasonCode = "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE";
    } else if (!validP1a(p1aRecord, artifact.artifact_sha256)) {
      reasonCode =
        p1aRecord.sanitized_metrics?.management_artifact_sha256 === artifact.artifact_sha256
          ? "INVALID_P1A_EVIDENCE"
          : "P1A_ARTIFACT_DIGEST_MISMATCH";
    } else if (!validChronology(p1aRecord, startedAt)) {
      reasonCode = "INVALID_CAPABILITY_CHRONOLOGY";
    } else if (trusted.failureReason !== undefined) {
      reasonCode = trusted.failureReason;
    } else if (trusted.verifiedProducer !== undefined) {
      runnerState = trusted.verifiedProducer.runnerState;
      reasonCode = trusted.verifiedProducer.reasonCode;
      providerCalls = trusted.verifiedProducer.providerCalls;
      providerCredentialsResolved = trusted.verifiedProducer.providerCredentialsResolved;
      observations = trusted.verifiedProducer.observations;
      producerAttested = true;
      producerEvidence = trusted.verifiedProducer.producerEvidence;
      sourceDigest = trusted.verifiedProducer.sourceDigest;
      sourceRef = trusted.verifiedProducer.sourceRef;
      cloudflareWorkerVersionId = trusted.verifiedProducer.cloudflareWorkerVersionId;
    } else if (safeMeasurementMode === "fixture_only" || probe === null) {
      runnerState = "BLOCKED_PREREQUISITE";
      reasonCode = trusted.prerequisiteReason ?? "CAPABILITY_PROBE_MISSING";
    } else if (safeMeasurementMode !== "isolated_management_probe") {
      reasonCode = "INVALID_CAPABILITY_MEASUREMENT_MODE";
    } else {
      runnerState = "BLOCKED_PREREQUISITE";
      reasonCode = "ATTESTED_CAPABILITY_PROBE_UNAVAILABLE";
    }
  } catch {
    reasonCode = "CAPABILITY_PREFLIGHT_VALIDATION_FAILED";
  }

  const gitState = trusted.snapshot?.gitState ?? (await readGitState(root));
  const worktreeDigest =
    trusted.snapshot?.worktreeDigest ?? (await createWorktreeDigest(root, credentialStorePaths));
  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: SCOPE,
    runner_state: runnerState,
    foundation_outcome: "BLOCKED",
    candidate_outcome: "UNDECIDED",
    reason_code: reasonCode,
    command: trusted.evidenceCommand ?? COMMAND,
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: worktreeDigest,
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks: [
      {
        id: "p1a_artifact_binding",
        state:
          artifact !== null &&
          artifact.launchable &&
          p1aRecord !== null &&
          validP1a(p1aRecord, artifact.artifact_sha256)
            ? "PASS"
            : "FAIL",
        duration_ms: 0,
        evidence_ref: "auth-preflight-capabilities.json#/sanitized_metrics/subordinate_evidence",
      },
      {
        id: "provider_capability_measurement",
        state: runnerState,
        duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        evidence_ref: "auth-preflight-capabilities.json#/sanitized_metrics/observations",
      },
    ],
    sanitized_metrics: {
      measurement_mode: safeMeasurementMode,
      provider_calls: providerCalls,
      provider_credentials_resolved: providerCredentialsResolved,
      management_artifact_sha256: artifact?.artifact_sha256 ?? null,
      cloudflare_worker_version_id: cloudflareWorkerVersionId,
      observations,
      producer_attested: producerAttested,
      producer_evidence: producerEvidence,
      source_digest: sourceDigest,
      source_ref: sourceRef,
      subordinate_evidence:
        p1aRecord === null
          ? null
          : { scope: p1aRecord.scope, run_id: p1aRecord.run_id, sha256: p1aSha256 },
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: runnerState === "PASS" ? [] : [reasonCode],
  };
  return writeEvidence({
    root,
    runId,
    filename: "auth-preflight-capabilities.json",
    result,
  });
};

export const runCapabilityPreflight = (options) => runCapabilityPreflightInternal(options);

export const runAttestedCapabilityPreflight = async ({
  root,
  p1a = null,
  producer = null,
  repository,
  signerWorkflow,
  sourceDigest,
  sourceRef,
  ...options
}) => {
  const common = {
    root,
    p1a,
    measurementMode: "producer_attested_github",
    ...options,
  };
  const producerPath = producer ?? (await findNewestEvidence(root, PRODUCER_FILENAME));
  if (producerPath === null) {
    return runCapabilityPreflightInternal(common, {
      prerequisiteReason: "ATTESTED_CAPABILITY_EVIDENCE_MISSING",
      evidenceCommand: ATTESTED_COMMAND,
    });
  }
  let snapshot;
  try {
    if (signerWorkflow !== `${repository}/${CAPABILITY_ATTESTATION_WORKFLOW_PATH}`) {
      throw new Error("INVALID_ATTESTATION_WORKFLOW");
    }
    const p1aPath = p1a ?? (await findNewestEvidence(root, "p1a-local.json"));
    if (p1aPath === null) {
      return runCapabilityPreflightInternal(common, {
        prerequisiteReason: "P1A_EVIDENCE_MISSING",
        evidenceCommand: ATTESTED_COMMAND,
      });
    }
    const [artifact, p1aSnapshot, producerSnapshot, gitState, currentWorktreeDigest] =
      await Promise.all([
        validateCandidateArtifact(root),
        readVerifiedSnapshot(p1aPath, "P1A_EVIDENCE_CHANGED_DURING_VALIDATION"),
        readVerifiedSnapshot(producerPath, "CAPABILITY_PRODUCER_CHANGED_DURING_VALIDATION"),
        readGitState(root),
        createWorktreeDigest(root, options.credentialStorePaths ?? []),
      ]);
    if (gitState.gitCommit !== sourceDigest || gitState.dirty) {
      throw new Error("ATTESTATION_WORKTREE_MISMATCH");
    }
    const p1aRecord = p1aSnapshot.record;
    const producerRecord = producerSnapshot.record;
    snapshot = {
      artifact,
      p1aRecord,
      p1aSha256: p1aSnapshot.sha256,
      gitState,
      worktreeDigest: currentWorktreeDigest,
    };
    const producerCandidate = validateCapabilityProducerCandidate({
      producer: producerRecord,
      producerSha256: producerSnapshot.sha256,
      p1aRecord,
      p1aSha256: snapshot.p1aSha256,
      artifactSha256: artifact.artifact_sha256,
      sourceDigest,
      sourceRef,
      currentWorktreeDigest,
      aggregateStartedAt: options.now?.() ?? new Date(),
    });
    await verifyGitHubAttestation({
      root,
      subjectPath: producerPath,
      repository,
      signerWorkflow,
      sourceDigest,
      sourceRef,
    });
    const [postP1a, postProducer, postArtifact, postGitState, postWorktreeDigest] =
      await Promise.all([
        readFile(p1aPath),
        readFile(producerPath),
        validateCandidateArtifact(root),
        readGitState(root),
        createWorktreeDigest(root, options.credentialStorePaths ?? []),
      ]);
    if (sha256(postP1a) !== snapshot.p1aSha256) {
      throw new Error("P1A_EVIDENCE_CHANGED_AFTER_ATTESTATION");
    }
    if (sha256(postProducer) !== producerCandidate.producerEvidence.sha256) {
      throw new Error("CAPABILITY_PRODUCER_CHANGED_AFTER_ATTESTATION");
    }
    if (postArtifact.artifact_sha256 !== snapshot.artifact.artifact_sha256) {
      throw new Error("MANAGEMENT_ARTIFACT_CHANGED_AFTER_ATTESTATION");
    }
    if (
      postGitState.gitCommit !== snapshot.gitState.gitCommit ||
      postGitState.dirty !== snapshot.gitState.dirty ||
      postWorktreeDigest !== snapshot.worktreeDigest
    ) {
      throw new Error("WORKTREE_CHANGED_AFTER_ATTESTATION");
    }
    return runCapabilityPreflightInternal(common, {
      verifiedProducer: { ...producerCandidate, producerAttested: true },
      evidenceCommand: ATTESTED_COMMAND,
      snapshot,
    });
  } catch (error) {
    const failureReason =
      error instanceof Error && /^[A-Z][A-Z0-9_]*$/u.test(error.message)
        ? error.message
        : "CAPABILITY_ATTESTATION_VALIDATION_FAILED";
    return runCapabilityPreflightInternal(common, {
      failureReason,
      evidenceCommand: ATTESTED_COMMAND,
      ...(snapshot === undefined ? {} : { snapshot }),
    });
  }
};

const parseArguments = (arguments_) => {
  const options = { root: process.cwd(), p1a: null, credentialStorePaths: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--p1a") options.p1a = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  return {
    ...options,
    root: resolve(options.root),
    p1a: options.p1a === null ? null : resolve(options.root, options.p1a),
  };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const execution = await runCapabilityPreflight(parseArguments(process.argv.slice(2)));
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "CAPABILITY_PREFLIGHT_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
