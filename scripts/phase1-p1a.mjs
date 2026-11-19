/* global process */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  createRunId,
  createWorktreeDigest,
  executeHashedCommand,
  parseCommonArguments,
  readGitState,
  validateCandidateArtifact,
  writeEvidence,
} from "./phase1-evidence-core.mjs";

const SCOPE = "phase1_p1a_local";
const COMMAND = "pnpm phase1:p1a";
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const P1A_CHECKS = Object.freeze([
  Object.freeze({
    id: "management_candidate_build",
    command: PNPM,
    arguments_: ["--filter", "@ohmyhost/workos-management", "build"],
  }),
  Object.freeze({
    id: "evidence_runner_tests",
    command: PNPM,
    arguments_: ["phase1:evidence-runner:test"],
  }),
  Object.freeze({ id: "contracts_drift", command: PNPM, arguments_: ["contracts:check"] }),
  Object.freeze({ id: "sdk_ts_drift", command: PNPM, arguments_: ["sdk-ts:check"] }),
  Object.freeze({
    id: "webhook_ingress_boundary",
    command: PNPM,
    arguments_: ["--filter", "@ohmyhost/webhook-ingress", "boundary"],
  }),
  Object.freeze({
    id: "product_cli_boundary",
    command: PNPM,
    arguments_: ["phase1:product-cli-boundary"],
  }),
  ...[
    ["platform_tests", "@ohmyhost/platform"],
    ["database_tests", "@ohmyhost/database"],
    ["workos_auth_contracts_tests", "@ohmyhost/workos-auth-contracts"],
    ["workos_token_verifier_tests", "@ohmyhost/workos-token-verifier"],
    ["control_api_tests", "@ohmyhost/control-api"],
    ["webhook_ingress_tests", "@ohmyhost/webhook-ingress"],
    ["workos_management_tests", "@ohmyhost/workos-management"],
    ["sdk_ts_tests", "@ohmyhost/sdk-ts"],
    ["product_cli_tests", "@ohmyhost/product-cli"],
  ].map(([id, packageName]) =>
    Object.freeze({ id, command: PNPM, arguments_: ["--filter", packageName, "test"] }),
  ),
]);

const runCheck = async (specification, root, commandRunner) =>
  commandRunner({ ...specification, cwd: root });

const normalizeStreamDigest = (value) => {
  if (
    !Number.isSafeInteger(value?.bytes) ||
    value.bytes < 0 ||
    typeof value?.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new Error("INVALID_COMMAND_EVIDENCE");
  }
  return { bytes: value.bytes, sha256: value.sha256 };
};

export const runP1a = async ({
  root,
  credentialStorePaths = [],
  commandRunner = executeHashedCommand,
  now = () => new Date(),
  runId = createRunId(),
}) => {
  const startedAt = now();
  const commandResults = [];
  let artifact = null;
  let artifactValidationState = null;
  let failureReason = null;

  for (const specification of P1A_CHECKS) {
    const observed = await runCheck(specification, root, commandRunner);
    const result = {
      id: specification.id,
      command: [specification.command, ...specification.arguments_].join(" "),
      exit_code: observed.exit_code,
      duration_ms: observed.duration_ms,
      stdout: normalizeStreamDigest(observed.stdout),
      stderr: normalizeStreamDigest(observed.stderr),
    };
    commandResults.push(result);
    if (result.exit_code !== 0) {
      failureReason = `CHECK_FAILED_${specification.id.toUpperCase()}`;
      break;
    }
    if (specification.id === "management_candidate_build") {
      try {
        artifact = await validateCandidateArtifact(root);
        if (!artifact.launchable) {
          artifactValidationState = "FAIL";
          failureReason = "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE";
          break;
        }
        artifactValidationState = "PASS";
      } catch (error) {
        artifactValidationState = "FAIL";
        failureReason =
          error instanceof Error ? error.message : "MANAGEMENT_ARTIFACT_VALIDATION_FAILED";
        break;
      }
    }
  }

  if (artifact === null && failureReason === null) {
    failureReason = "MANAGEMENT_ARTIFACT_MISSING";
  }
  const runnerState = failureReason === null ? "PASS" : "FAIL";
  const gitState = await readGitState(root);
  const checks = commandResults.map((result) => ({
    id: result.id,
    state: result.exit_code === 0 ? "PASS" : "FAIL",
    duration_ms: result.duration_ms,
    evidence_ref: "checks.json",
  }));
  if (artifactValidationState !== null) {
    checks.splice(1, 0, {
      id: "management_candidate_artifact",
      state: artifactValidationState,
      duration_ms: 0,
      evidence_ref: "management-artifact.json",
    });
  }
  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: SCOPE,
    runner_state: runnerState,
    foundation_outcome: "BLOCKED",
    candidate_outcome: "UNDECIDED",
    reason_code: failureReason ?? "P1A_LOCAL_VERIFICATION_PASSED",
    command: COMMAND,
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: await createWorktreeDigest(root, credentialStorePaths),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks,
    sanitized_metrics: {
      inventory_schema_version: EVIDENCE_INVENTORY_SCHEMA_VERSION,
      verification_mode: "fixture_only_local",
      provider_calls: 0,
      provider_credentials_resolved: 0,
      management_artifact_sha256: artifact?.artifact_sha256 ?? null,
      completed_check_count: checks.length,
      required_check_count: P1A_CHECKS.length + 1,
      elapsed_ms: Math.max(0, now().getTime() - startedAt.getTime()),
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: runnerState === "PASS" ? ["P1B_PROVIDER_MEASUREMENT"] : [failureReason],
  };
  const payloads = [
    { filename: "checks.json", content: { schema_version: 1, checks: commandResults } },
  ];
  if (artifact !== null) {
    payloads.push({ filename: "management-artifact.json", content: artifact });
  }
  return writeEvidence({ root, runId, filename: "p1a-local.json", result, payloads });
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const options = parseCommonArguments(process.argv.slice(2));
    const execution = await runP1a(options);
    process.stdout.write(execution.serialized);
    process.exitCode = execution.result.runner_state === "PASS" ? 0 : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "P1A_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
