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

const SCOPE = "phase1_auth_sandbox";
const COMMAND = "pnpm phase1:auth-sandbox";

const isCount = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;

const sanitizeStage = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_SANDBOX_MEASUREMENT");
  }
  if (
    Object.keys(value).some(
      (key) =>
        !["complete", "passed", "measured_count", "required_count", "status_codes"].includes(key),
    ) ||
    typeof value.complete !== "boolean" ||
    typeof value.passed !== "boolean" ||
    !isCount(value.measured_count) ||
    !isCount(value.required_count, 1) ||
    value.measured_count > value.required_count ||
    value.complete !== (value.measured_count === value.required_count) ||
    (!value.complete && value.passed) ||
    !Array.isArray(value.status_codes) ||
    value.status_codes.some(
      (statusCode) => !Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599,
    )
  ) {
    throw new Error("INVALID_SANDBOX_MEASUREMENT");
  }
  return {
    complete: value.complete,
    passed: value.passed,
    measured_count: value.measured_count,
    required_count: value.required_count,
    status_codes: [...value.status_codes],
  };
};

const sanitizeMeasurement = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_SANDBOX_MEASUREMENT");
  }
  if (
    Object.keys(value).some(
      (key) => !["provider_calls", "provider_credentials_resolved", "shared", "fga"].includes(key),
    ) ||
    !isCount(value.provider_calls, 1) ||
    !isCount(value.provider_credentials_resolved, 1)
  ) {
    throw new Error("INVALID_SANDBOX_MEASUREMENT");
  }
  return {
    providerCalls: value.provider_calls,
    providerCredentialsResolved: value.provider_credentials_resolved,
    shared: sanitizeStage(value.shared),
    fga: sanitizeStage(value.fga),
  };
};

const validateMeasurementOrder = (measurement) => {
  if (
    (!measurement.shared.complete || !measurement.shared.passed) &&
    (measurement.fga.complete ||
      measurement.fga.passed ||
      measurement.fga.measured_count !== 0 ||
      measurement.fga.status_codes.length !== 0)
  ) {
    throw new Error("INVALID_SANDBOX_MEASUREMENT");
  }
  return measurement;
};

const validateAggregateState = (record) => {
  if (
    record.scope !== "phase1_auth_preflight" ||
    !["PASS", "BLOCKED_PREREQUISITE"].includes(record.runner_state) ||
    record.foundation_outcome !== "BLOCKED" ||
    record.candidate_outcome !== "UNDECIDED" ||
    record.sanitized_metrics?.backend_decision !== null ||
    !Array.isArray(record.sanitized_metrics?.gate_closures) ||
    record.sanitized_metrics.gate_closures.length !== 0
  ) {
    throw new Error("INVALID_AUTH_PREFLIGHT_EVIDENCE");
  }
};

const validateChronology = (record, sandboxStartedAt) => {
  const aggregateStartedAt = Date.parse(record.started_at);
  const aggregateFinishedAt = Date.parse(record.finished_at);
  if (
    !Number.isFinite(aggregateStartedAt) ||
    !Number.isFinite(aggregateFinishedAt) ||
    aggregateStartedAt > aggregateFinishedAt ||
    aggregateFinishedAt > sandboxStartedAt.getTime()
  ) {
    throw new Error("INVALID_SANDBOX_CHRONOLOGY");
  }
};

const deriveOutcome = (measurement) => {
  if (!measurement.shared.complete) {
    return {
      runnerState: "BLOCKED_PREREQUISITE",
      foundationOutcome: "BLOCKED",
      candidateOutcome: "UNDECIDED",
      reasonCode: "SHARED_FOUNDATION_EVIDENCE_MISSING",
    };
  }
  if (!measurement.shared.passed) {
    return {
      runnerState: "PASS",
      foundationOutcome: "BLOCKED",
      candidateOutcome: "UNDECIDED",
      reasonCode: "SHARED_FOUNDATION_MEASUREMENT_FAILED",
    };
  }
  if (!measurement.fga.complete) {
    return {
      runnerState: "BLOCKED_PREREQUISITE",
      foundationOutcome: "READY",
      candidateOutcome: "UNDECIDED",
      reasonCode: "FGA_CANDIDATE_EVIDENCE_MISSING",
    };
  }
  if (!measurement.fga.passed) {
    return {
      runnerState: "PASS",
      foundationOutcome: "READY",
      candidateOutcome: "LOCAL_GRANTS_REQUIRED",
      reasonCode: "FGA_CANDIDATE_MEASUREMENT_FAILED",
    };
  }
  return {
    runnerState: "PASS",
    foundationOutcome: "READY",
    candidateOutcome: "FGA_ELIGIBLE",
    reasonCode: "SANDBOX_MEASUREMENT_PASSED",
  };
};

export const evaluateSandboxMeasurement = (value) => {
  const measurement = validateMeasurementOrder(sanitizeMeasurement(value));
  return { measurement, outcome: deriveOutcome(measurement) };
};

export const runAuthSandbox = async ({
  root,
  authPreflight = null,
  measurement = null,
  measurementMode = measurement === null ? "fixture_only" : "isolated_management_measurement",
  credentialStorePaths = [],
  now = () => new Date(),
  runId = createRunId(),
}) => {
  const startedAt = now();
  let artifact = null;
  let aggregateRecord = null;
  let subordinateEvidence = null;
  let shared = null;
  let fga = null;
  let providerCalls = 0;
  let providerCredentialsResolved = 0;
  let runnerState = "FAIL";
  let foundationOutcome = "BLOCKED";
  let candidateOutcome = "UNDECIDED";
  let reasonCode = "AUTH_SANDBOX_VALIDATION_FAILED";
  const safeMeasurementMode = ["fixture_only", "isolated_management_measurement"].includes(
    measurementMode,
  )
    ? measurementMode
    : "invalid";

  try {
    const aggregatePath = authPreflight ?? (await findNewestEvidence(root, "auth-preflight.json"));
    if (aggregatePath === null) {
      runnerState = "BLOCKED_PREREQUISITE";
      reasonCode = "AUTH_PREFLIGHT_EVIDENCE_MISSING";
    } else {
      aggregateRecord = await verifyEvidenceFile(aggregatePath);
      validateAggregateState(aggregateRecord);
      subordinateEvidence = {
        scope: aggregateRecord.scope,
        run_id: aggregateRecord.run_id,
        sha256: sha256(await readFile(aggregatePath)),
      };
      if (aggregateRecord.runner_state === "BLOCKED_PREREQUISITE") {
        runnerState = "BLOCKED_PREREQUISITE";
        reasonCode = "AUTH_PREFLIGHT_BLOCKED";
      } else {
        artifact = await validateCandidateArtifact(root);
        if (
          aggregateRecord.sanitized_metrics?.management_artifact_sha256 !== artifact.artifact_sha256
        ) {
          throw new Error("AUTH_PREFLIGHT_ARTIFACT_DIGEST_MISMATCH");
        }
        validateChronology(aggregateRecord, startedAt);
        if (!artifact.launchable) {
          runnerState = "BLOCKED_PREREQUISITE";
          reasonCode = "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE";
        } else if (safeMeasurementMode === "fixture_only" || measurement === null) {
          runnerState = "BLOCKED_PREREQUISITE";
          reasonCode = "SANDBOX_MEASUREMENT_MISSING";
        } else if (safeMeasurementMode !== "isolated_management_measurement") {
          throw new Error("INVALID_SANDBOX_MEASUREMENT_MODE");
        } else {
          runnerState = "BLOCKED_PREREQUISITE";
          reasonCode = "ATTESTED_SANDBOX_MEASUREMENT_UNAVAILABLE";
        }
      }
    }
  } catch (error) {
    runnerState = "FAIL";
    foundationOutcome = "BLOCKED";
    candidateOutcome = "UNDECIDED";
    reasonCode = error instanceof Error ? error.message : "AUTH_SANDBOX_VALIDATION_FAILED";
    providerCalls = 0;
    providerCredentialsResolved = 0;
    shared = null;
    fga = null;
  }

  const gitState = await readGitState(root);
  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: SCOPE,
    runner_state: runnerState,
    foundation_outcome: foundationOutcome,
    candidate_outcome: candidateOutcome,
    reason_code: reasonCode,
    command: COMMAND,
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: await createWorktreeDigest(root, credentialStorePaths),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks: [
      {
        id: "auth_preflight_dependency",
        state: aggregateRecord === null ? "BLOCKED_PREREQUISITE" : aggregateRecord.runner_state,
        duration_ms: 0,
        evidence_ref: "auth-sandbox.json#/sanitized_metrics/subordinate_evidence",
      },
      {
        id: "sandbox_measurement",
        state: runnerState,
        duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        evidence_ref: "auth-sandbox.json#/sanitized_metrics/measurement",
      },
    ],
    sanitized_metrics: {
      measurement_mode: safeMeasurementMode,
      provider_calls: providerCalls,
      provider_credentials_resolved: providerCredentialsResolved,
      management_artifact_sha256: artifact?.artifact_sha256 ?? null,
      subordinate_evidence: subordinateEvidence,
      measurement: { shared, fga },
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: runnerState === "BLOCKED_PREREQUISITE" ? [reasonCode] : [],
  };
  return writeEvidence({ root, runId, filename: "auth-sandbox.json", result });
};

const parseArguments = (arguments_) => {
  const options = { root: process.cwd(), authPreflight: null, credentialStorePaths: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--auth-preflight") options.authPreflight = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  return {
    ...options,
    root: resolve(options.root),
    authPreflight:
      options.authPreflight === null ? null : resolve(options.root, options.authPreflight),
  };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const execution = await runAuthSandbox(parseArguments(process.argv.slice(2)));
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "AUTH_SANDBOX_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
