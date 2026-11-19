/* global process */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  createRunId,
  createWorktreeDigest,
  readGitState,
  sha256,
  verifyEvidenceFile,
  writeEvidence,
} from "./phase1-evidence-core.mjs";

const EVIDENCE_ROOT = "docs/plan/evidence/legacy/phase1";

const findNewestEvidence = async (root, filename) => {
  const directory = join(root, EVIDENCE_ROOT);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, filename);
    try {
      const metadata = await stat(path);
      candidates.push({ path, modified: metadata.mtimeMs });
    } catch (error) {
      if (
        !(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.path ?? null;
};

export const parseVerifyArguments = (arguments_) => {
  const options = {
    root: process.cwd(),
    p1a: null,
    names: null,
    p1b: null,
    credentialStorePaths: [],
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--p1a") options.p1a = value;
    else if (argument === "--names") options.names = value;
    else if (argument === "--p1b") options.p1b = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  options.root = resolve(options.root);
  for (const name of ["p1a", "names", "p1b"]) {
    if (options[name] !== null) options[name] = resolve(options.root, options[name]);
  }
  return options;
};

const validateP1aState = (record) => {
  if (record.scope !== "phase1_p1a_local") throw new Error("P1A_SCOPE_MISMATCH");
  if (
    record.foundation_outcome !== "BLOCKED" ||
    record.candidate_outcome !== "UNDECIDED" ||
    record.sanitized_metrics?.backend_decision !== null ||
    (record.sanitized_metrics?.gate_closures?.length ?? 0) !== 0
  ) {
    throw new Error("P1A_STATE_ESCALATION_REJECTED");
  }
  if (record.runner_state === "FAIL") throw new Error("P1A_LOCAL_FAILED");
  if (record.runner_state !== "PASS") throw new Error("P1A_INVALID_STATE");
};

const validateNamesState = (record) => {
  if (record.scope !== "phase1_auth_preflight_names") {
    throw new Error("NAME_PREFLIGHT_SCOPE_MISMATCH");
  }
  if (
    record.runner_state === "BLOCKED_PREREQUISITE" &&
    (record.foundation_outcome !== "BLOCKED" || record.candidate_outcome !== "UNDECIDED")
  ) {
    throw new Error("BLOCKED_NAMES_BACKEND_DECISION_REJECTED");
  }
};

const validateP1bState = (record) => {
  if (
    record.scope !== "phase1_p1b_provider" ||
    !Array.isArray(record.sanitized_metrics?.gate_closures) ||
    record.sanitized_metrics.gate_closures.length !== 0
  ) {
    throw new Error("INVALID_P1B_EVIDENCE");
  }
  if (record.runner_state === "FAIL") throw new Error("P1B_EVIDENCE_FAILED");
  if (record.runner_state === "BLOCKED_PREREQUISITE") {
    const validBlockedOutcome =
      (record.foundation_outcome === "BLOCKED" && record.candidate_outcome === "UNDECIDED") ||
      (record.foundation_outcome === "READY" &&
        ["UNDECIDED", "FGA_ELIGIBLE", "LOCAL_GRANTS_REQUIRED"].includes(record.candidate_outcome));
    if (
      !validBlockedOutcome ||
      record.sanitized_metrics?.backend_decision !== null ||
      record.sanitized_metrics?.provider_verified !== false
    ) {
      throw new Error("INVALID_P1B_BLOCKED_STATE");
    }
    return;
  }
  if (record.runner_state === "PASS") {
    throw new Error("ATTESTED_P1B_EVIDENCE_UNAVAILABLE");
  }
  const expectedBackend =
    record.candidate_outcome === "FGA_ELIGIBLE"
      ? "workos_fga"
      : record.candidate_outcome === "LOCAL_GRANTS_REQUIRED"
        ? "local_grants"
        : null;
  if (
    record.runner_state !== "PASS" ||
    record.foundation_outcome !== "READY" ||
    expectedBackend === null ||
    record.sanitized_metrics?.backend_decision !== expectedBackend ||
    record.sanitized_metrics?.provider_verified !== true
  ) {
    throw new Error("INVALID_P1B_READY_STATE");
  }
};

const sourceDescriptor = async (root, path, record) => ({
  relative_path: path
    .split(sep)
    .join("/")
    .startsWith(`${root.split(sep).join("/")}/`)
    ? relative(root, path).split(sep).join("/")
    : null,
  sha256: sha256(await readFile(path)),
  scope: record.scope,
  runner_state: record.runner_state,
  foundation_outcome: record.foundation_outcome,
  candidate_outcome: record.candidate_outcome,
  run_id: record.run_id,
});

export const runPhase1Verify = async ({
  root,
  p1a = null,
  names = null,
  p1b = null,
  credentialStorePaths = [],
  now = () => new Date(),
  runId = createRunId(),
  evidenceReader = verifyEvidenceFile,
  worktreeDigest = createWorktreeDigest,
}) => {
  const startedAt = now();
  const p1aPath = p1a ?? (await findNewestEvidence(root, "p1a-local.json"));
  const namesPath = names ?? (await findNewestEvidence(root, "auth-preflight-names.json"));
  const p1bPath = p1b ?? (await findNewestEvidence(root, "p1b-provider.json"));
  const checks = [];
  const sources = [];
  let reasonCode = "P1B_EVIDENCE_MISSING";
  let runnerState = "BLOCKED_PREREQUISITE";
  let foundationOutcome = "BLOCKED";
  let candidateOutcome = "UNDECIDED";
  let backendDecision = null;
  let p1aLocalFailed = false;

  try {
    if (p1aPath === null) {
      checks.push({
        id: "p1a_local_evidence",
        state: "BLOCKED_PREREQUISITE",
        duration_ms: 0,
        evidence_ref: "aggregation.json",
      });
      reasonCode = "P1A_EVIDENCE_MISSING";
    } else {
      const p1aRecord = await evidenceReader(p1aPath);
      validateP1aState(p1aRecord);
      const currentDigest = await worktreeDigest(root, credentialStorePaths);
      if (p1aRecord.worktree_digest !== currentDigest) {
        throw new Error("P1A_WORKTREE_DIGEST_MISMATCH");
      }
      checks.push({
        id: "p1a_local_evidence",
        state: "PASS",
        duration_ms: 0,
        evidence_ref: "aggregation.json",
      });
      sources.push(await sourceDescriptor(root, p1aPath, p1aRecord));
    }

    if (namesPath !== null) {
      const namesRecord = await evidenceReader(namesPath);
      validateNamesState(namesRecord);
      checks.push({
        id: "name_preflight_state_preserved",
        state: namesRecord.runner_state,
        duration_ms: 0,
        evidence_ref: "aggregation.json",
      });
      sources.push(await sourceDescriptor(root, namesPath, namesRecord));
    }

    if (p1bPath !== null) {
      const p1bRecord = await evidenceReader(p1bPath);
      sources.push(await sourceDescriptor(root, p1bPath, p1bRecord));
      if (p1bRecord.scope === "phase1_p1a_local") {
        throw new Error("P1A_CANNOT_SATISFY_P1B");
      }
      validateP1bState(p1bRecord);
      runnerState = p1bRecord.runner_state;
      foundationOutcome = p1bRecord.foundation_outcome;
      candidateOutcome = p1bRecord.candidate_outcome;
      backendDecision = p1bRecord.sanitized_metrics.backend_decision;
      reasonCode = runnerState === "PASS" ? "PHASE1_PROVIDER_VERIFIED" : "P1B_EVIDENCE_BLOCKED";
      checks.push({
        id: "p1b_provider_evidence",
        state: runnerState,
        duration_ms: 0,
        evidence_ref: "aggregation.json",
      });
    } else {
      checks.push({
        id: "p1b_provider_evidence",
        state: "BLOCKED_PREREQUISITE",
        duration_ms: 0,
        evidence_ref: "aggregation.json",
      });
    }
  } catch (error) {
    runnerState = "FAIL";
    foundationOutcome = "BLOCKED";
    candidateOutcome = "UNDECIDED";
    backendDecision = null;
    reasonCode = error instanceof Error ? error.message : "PHASE1_EVIDENCE_INVALID";
    p1aLocalFailed = reasonCode === "P1A_LOCAL_FAILED";
    checks.push({
      id: p1aLocalFailed ? "p1a_local_evidence" : "state_escalation_guard",
      state: "FAIL",
      duration_ms: 0,
      evidence_ref: "aggregation.json",
    });
  }

  const gitState = await readGitState(root);
  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: "phase1_verification_summary",
    runner_state: runnerState,
    foundation_outcome: foundationOutcome,
    candidate_outcome: candidateOutcome,
    reason_code: reasonCode,
    command: "pnpm phase1:verify",
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: await worktreeDigest(root, credentialStorePaths),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks,
    sanitized_metrics: {
      inventory_schema_version: EVIDENCE_INVENTORY_SCHEMA_VERSION,
      aggregate_mode: "phase1_dependency_chain",
      backend_decision: backendDecision,
      gate_closures: [],
      p1a_is_p1b: false,
      source_count: sources.length,
    },
    unmet_prerequisites:
      runnerState === "PASS"
        ? []
        : [...(p1aLocalFailed ? ["P1A_LOCAL_EVIDENCE"] : []), "P1B_PROVIDER_EVIDENCE"],
  };
  return writeEvidence({
    root,
    runId,
    filename: "phase1-summary.json",
    result,
    payloads: [{ filename: "aggregation.json", content: { schema_version: 1, sources } }],
  });
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const options = parseVerifyArguments(process.argv.slice(2));
    const execution = await runPhase1Verify(options);
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "PHASE1_VERIFY_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
