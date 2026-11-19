/* global process */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  createRunId,
  createWorktreeDigest,
  parseCommonArguments,
  readGitState,
  writeEvidence,
} from "./phase1-evidence-core.mjs";

export const runP1aRed = async ({
  root,
  credentialStorePaths = [],
  now = () => new Date(),
  runId = createRunId(),
}) => {
  const startedAt = now();
  const gitState = await readGitState(root);
  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: "phase1_p1a_red_historical_checkpoint",
    runner_state: "BLOCKED_PREREQUISITE",
    foundation_outcome: "BLOCKED",
    candidate_outcome: "UNDECIDED",
    reason_code: "HISTORICAL_EVIDENCE_UNAVAILABLE",
    command: "pnpm phase1:p1a:red",
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: await createWorktreeDigest(root, credentialStorePaths),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks: [
      {
        id: "preimplementation_red_checkpoint",
        state: "BLOCKED",
        duration_ms: 0,
        evidence_ref: "p1a-red.json#/sanitized_metrics",
      },
    ],
    sanitized_metrics: {
      inventory_schema_version: EVIDENCE_INVENTORY_SCHEMA_VERSION,
      historical_checkpoint_state: "UNAVAILABLE",
      tests_executed: 0,
      expected_failures_claimed: 0,
      passing_implementation_claimed: false,
      explanation:
        "Implementation predates this runner and no retained preimplementation failure artifact exists.",
    },
    unmet_prerequisites: ["RETAINED_PREIMPLEMENTATION_RED_ARTIFACT"],
  };
  return writeEvidence({ root, runId, filename: "p1a-red.json", result });
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const options = parseCommonArguments(process.argv.slice(2));
    const execution = await runP1aRed(options);
    process.stdout.write(execution.serialized);
    process.exitCode = 2;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "P1A_RED_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
