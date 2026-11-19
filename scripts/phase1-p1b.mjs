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
import { verifyGitHubAttestation } from "./phase1-github-attestation.mjs";

const SCOPE = "phase1_p1b_provider";
const COMMAND = "pnpm phase1:p1b";
const E2E_CHECKS = Object.freeze(["human", "device", "api_key", "m2m", "bola", "idempotency"]);
const NATIVE_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);
const NATIVE_BACKENDS = Object.freeze({
  darwin: "keychain",
  linux: "secret_service",
  win32: "credential_manager",
});
const BACKEND_BY_CANDIDATE = Object.freeze({
  FGA_ELIGIBLE: "workos_fga",
  LOCAL_GRANTS_REQUIRED: "local_grants",
});

const loadEvidence = async (path, label) => {
  try {
    const record = await verifyEvidenceFile(path);
    if (record.scope === "phase1_p1a_local") throw new Error("P1A_CANNOT_SATISFY_P1B");
    return { record, sha256: sha256(await readFile(path)) };
  } catch (error) {
    if (error instanceof Error && error.message === "P1A_CANNOT_SATISFY_P1B") throw error;
    throw new Error(`${label}_EVIDENCE_INVALID`);
  }
};

const chronology = (record, p1bStartedAt) => {
  const startedAt = Date.parse(record.started_at);
  const finishedAt = Date.parse(record.finished_at);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    startedAt > finishedAt ||
    finishedAt > p1bStartedAt.getTime()
  ) {
    throw new Error("INVALID_P1B_CHRONOLOGY");
  }
  return { startedAt, finishedAt };
};

const noGateClosure = (record) =>
  Array.isArray(record.sanitized_metrics?.gate_closures) &&
  record.sanitized_metrics.gate_closures.length === 0;

const validateSandbox = (record) => {
  if (record.scope !== "phase1_auth_sandbox" || !noGateClosure(record)) {
    throw new Error("INVALID_AUTH_SANDBOX_EVIDENCE");
  }
  const state = [record.runner_state, record.foundation_outcome, record.candidate_outcome].join(
    "/",
  );
  if (
    ![
      "BLOCKED_PREREQUISITE/BLOCKED/UNDECIDED",
      "PASS/BLOCKED/UNDECIDED",
      "BLOCKED_PREREQUISITE/READY/UNDECIDED",
      "PASS/READY/FGA_ELIGIBLE",
      "PASS/READY/LOCAL_GRANTS_REQUIRED",
    ].includes(state)
  ) {
    throw new Error("INVALID_AUTH_SANDBOX_EVIDENCE");
  }
  return state.startsWith("PASS/READY/") && record.candidate_outcome !== "UNDECIDED";
};

const validatePlatforms = (record) => {
  if (
    record.scope !== "phase1_credential_store_platforms" ||
    !["PASS", "BLOCKED_PREREQUISITE"].includes(record.runner_state) ||
    record.foundation_outcome !== "BLOCKED" ||
    record.candidate_outcome !== "UNDECIDED" ||
    record.sanitized_metrics?.provider_calls !== 0 ||
    record.sanitized_metrics?.backend_decision !== null ||
    !noGateClosure(record)
  ) {
    throw new Error("INVALID_CREDENTIAL_STORE_PLATFORM_EVIDENCE");
  }
  if (record.runner_state === "PASS") {
    const requiredPlatforms = record.sanitized_metrics?.required_platforms;
    const platformEvidence = record.sanitized_metrics?.platform_evidence;
    if (
      !Array.isArray(requiredPlatforms) ||
      JSON.stringify(requiredPlatforms) !== JSON.stringify(NATIVE_PLATFORMS) ||
      platformEvidence === null ||
      typeof platformEvidence !== "object" ||
      Array.isArray(platformEvidence) ||
      JSON.stringify(Object.keys(platformEvidence)) !== JSON.stringify(NATIVE_PLATFORMS) ||
      record.sanitized_metrics?.producer_attested !== true ||
      !/^[a-f0-9]{40}$/u.test(record.sanitized_metrics?.source_digest ?? "") ||
      record.git_commit !== record.sanitized_metrics.source_digest ||
      record.dirty !== false
    ) {
      throw new Error("INVALID_CREDENTIAL_STORE_PLATFORM_EVIDENCE");
    }
    for (const platform of NATIVE_PLATFORMS) {
      const evidence = platformEvidence[platform];
      if (
        evidence === null ||
        typeof evidence !== "object" ||
        Array.isArray(evidence) ||
        evidence.runner_state !== "PASS" ||
        evidence.real_native !== true ||
        evidence.native_backend !== NATIVE_BACKENDS[platform] ||
        typeof evidence.run_id !== "string" ||
        !/^[a-f0-9]{64}$/u.test(evidence.sha256 ?? "")
      ) {
        throw new Error("INVALID_CREDENTIAL_STORE_PLATFORM_EVIDENCE");
      }
    }
  }
};

const validateAdr = (record, sandbox, expectedBackend) => {
  if (
    record.scope !== "phase1_authorization_backend_adr" ||
    record.runner_state !== "PASS" ||
    record.foundation_outcome !== sandbox.foundation_outcome ||
    record.candidate_outcome !== sandbox.candidate_outcome ||
    !noGateClosure(record) ||
    record.sanitized_metrics?.selected_backend !== expectedBackend
  ) {
    throw new Error("ADR_BACKEND_MISMATCH");
  }
};

const validateComposition = (record, sandbox, expectedBackend) => {
  const enabled = record.sanitized_metrics?.enabled_backends;
  if (
    record.scope !== "phase1_authorization_backend_composition" ||
    record.runner_state !== "PASS" ||
    record.foundation_outcome !== sandbox.foundation_outcome ||
    record.candidate_outcome !== sandbox.candidate_outcome ||
    !noGateClosure(record) ||
    !Array.isArray(enabled) ||
    enabled.length !== 1 ||
    enabled[0] !== expectedBackend
  ) {
    throw new Error("INVALID_BACKEND_COMPOSITION");
  }
};

const validateE2e = (record, sandbox) => {
  const ids = Array.isArray(record.checks) ? record.checks.map(({ id }) => id) : [];
  if (
    record.scope !== "phase1_p1b_client_e2e" ||
    record.runner_state !== "PASS" ||
    record.foundation_outcome !== sandbox.foundation_outcome ||
    record.candidate_outcome !== sandbox.candidate_outcome ||
    record.sanitized_metrics?.provider_verified !== true ||
    !noGateClosure(record) ||
    ids.length !== E2E_CHECKS.length ||
    new Set(ids).size !== E2E_CHECKS.length ||
    E2E_CHECKS.some((id) => !ids.includes(id)) ||
    record.checks.some(({ state }) => state !== "PASS")
  ) {
    throw new Error("INVALID_P1B_E2E_EVIDENCE");
  }
};

export const runP1b = async ({
  root,
  authSandbox = null,
  credentialStorePlatforms = null,
  adr = null,
  composition = null,
  e2e = null,
  credentialStorePaths = [],
  githubRepository = process.env["GITHUB_REPOSITORY"] ?? "",
  now = () => new Date(),
  runId = createRunId(),
}) => {
  const startedAt = now();
  let runnerState = "BLOCKED_PREREQUISITE";
  let foundationOutcome = "BLOCKED";
  let candidateOutcome = "UNDECIDED";
  let reasonCode = "P1B_INPUT_EVIDENCE_MISSING";
  let managementArtifactSha256 = null;
  let backendDecision = null;
  let unmetPrerequisites = [];
  const sources = {};

  try {
    const paths = {
      sandbox: authSandbox ?? (await findNewestEvidence(root, "auth-sandbox.json")),
      platforms:
        credentialStorePlatforms ??
        (await findNewestEvidence(root, "credential-store-platforms.json")),
      adr,
      composition,
      e2e,
    };
    const loaded = {};
    for (const [label, path] of Object.entries(paths)) {
      if (path === null) continue;
      loaded[label] = await loadEvidence(path, label.toUpperCase());
      sources[label] = {
        scope: loaded[label].record.scope,
        run_id: loaded[label].record.run_id,
        runner_state: loaded[label].record.runner_state,
        foundation_outcome: loaded[label].record.foundation_outcome,
        candidate_outcome: loaded[label].record.candidate_outcome,
        sha256: loaded[label].sha256,
      };
    }

    const sandboxRecord = loaded.sandbox?.record ?? null;
    const sandboxDecided = sandboxRecord === null ? false : validateSandbox(sandboxRecord);
    if (sandboxRecord !== null) {
      foundationOutcome = sandboxRecord.foundation_outcome;
      candidateOutcome = sandboxRecord.candidate_outcome;
      chronology(sandboxRecord, startedAt);
      const sandboxArtifactSha256 = sandboxRecord.sanitized_metrics?.management_artifact_sha256;
      if (sandboxDecided && !/^[a-f0-9]{64}$/u.test(sandboxArtifactSha256 ?? "")) {
        throw new Error("SANDBOX_ARTIFACT_DIGEST_MISSING");
      }
      if (sandboxArtifactSha256 !== null && sandboxArtifactSha256 !== undefined) {
        const artifact = await validateCandidateArtifact(root);
        if (!artifact.launchable) throw new Error("MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE");
        managementArtifactSha256 = artifact.artifact_sha256;
        if (sandboxArtifactSha256 !== managementArtifactSha256) {
          throw new Error("SANDBOX_ARTIFACT_DIGEST_MISMATCH");
        }
      }
    }

    const platformsRecord = loaded.platforms?.record ?? null;
    if (platformsRecord !== null) {
      validatePlatforms(platformsRecord);
      chronology(platformsRecord, startedAt);
    }

    unmetPrerequisites = Object.entries(paths)
      .filter(([, path]) => path === null)
      .map(([label]) => label);
    if (sandboxRecord !== null && !sandboxDecided) unmetPrerequisites.push("sandbox_decision");
    if (platformsRecord?.runner_state === "BLOCKED_PREREQUISITE") {
      unmetPrerequisites.push("credential_store_platforms");
    }

    if (sandboxDecided) {
      const expectedBackend = BACKEND_BY_CANDIDATE[sandboxRecord.candidate_outcome];
      const adrRecord = loaded.adr?.record ?? null;
      const compositionRecord = loaded.composition?.record ?? null;
      const e2eRecord = loaded.e2e?.record ?? null;
      if (adrRecord !== null) validateAdr(adrRecord, sandboxRecord, expectedBackend);
      if (compositionRecord !== null) {
        validateComposition(compositionRecord, sandboxRecord, expectedBackend);
      }
      if (e2eRecord !== null) validateE2e(e2eRecord, sandboxRecord);

      const times = {
        sandbox: chronology(sandboxRecord, startedAt),
        platforms: platformsRecord === null ? null : chronology(platformsRecord, startedAt),
        adr: adrRecord === null ? null : chronology(adrRecord, startedAt),
        composition: compositionRecord === null ? null : chronology(compositionRecord, startedAt),
        e2e: e2eRecord === null ? null : chronology(e2eRecord, startedAt),
      };
      if (
        (times.adr !== null && times.adr.startedAt < times.sandbox.finishedAt) ||
        (times.composition !== null &&
          times.adr !== null &&
          times.composition.startedAt < times.adr.finishedAt) ||
        (times.e2e !== null &&
          ((times.composition !== null && times.e2e.startedAt < times.composition.finishedAt) ||
            (times.platforms !== null && times.e2e.startedAt < times.platforms.finishedAt)))
      ) {
        throw new Error("INVALID_P1B_DEPENDENCY_ORDER");
      }

      if (
        unmetPrerequisites.length === 0 &&
        platformsRecord.runner_state === "PASS" &&
        adrRecord !== null &&
        compositionRecord !== null &&
        e2eRecord !== null
      ) {
        await verifyGitHubAttestation({
          root,
          subjectPath: paths.platforms,
          repository: githubRepository,
          signerWorkflow: `${githubRepository}/.github/workflows/phase1-native-keyring.yml`,
          sourceDigest: platformsRecord.sanitized_metrics.source_digest,
          sourceRef: "refs/heads/main",
        });
        runnerState = "BLOCKED_PREREQUISITE";
        reasonCode = "ATTESTED_P1B_EVIDENCE_UNAVAILABLE";
        unmetPrerequisites.push("provider_attestation");
      } else if (platformsRecord?.runner_state === "BLOCKED_PREREQUISITE") {
        reasonCode = "CREDENTIAL_STORE_PLATFORMS_BLOCKED";
      }
    }
    if (runnerState !== "PASS" && reasonCode === "P1B_INPUT_EVIDENCE_MISSING") {
      reasonCode =
        sandboxRecord !== null && !sandboxDecided
          ? "AUTH_SANDBOX_NOT_DECIDED"
          : "P1B_INPUT_EVIDENCE_MISSING";
    }
  } catch (error) {
    runnerState = "FAIL";
    reasonCode = error instanceof Error ? error.message : "P1B_EVIDENCE_INVALID";
    backendDecision = null;
    unmetPrerequisites = [];
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
    checks: Object.entries(sources).map(([id, source]) => ({
      id: `${id}_evidence`,
      state: runnerState === "FAIL" ? "FAIL" : source.runner_state,
      duration_ms: 0,
      evidence_ref: `p1b-provider.json#/sanitized_metrics/sources/${id}`,
    })),
    sanitized_metrics: {
      provider_calls: 0,
      native_operations: 0,
      client_calls: 0,
      provider_verified: runnerState === "PASS",
      management_artifact_sha256: managementArtifactSha256,
      sources,
      gate_closures: [],
      backend_decision: backendDecision,
    },
    unmet_prerequisites: [...new Set(unmetPrerequisites)],
  };
  return writeEvidence({ root, runId, filename: "p1b-provider.json", result });
};

const parseArguments = (arguments_) => {
  const options = {
    root: process.cwd(),
    authSandbox: null,
    credentialStorePlatforms: null,
    adr: null,
    composition: null,
    e2e: null,
    credentialStorePaths: [],
  };
  const paths = {
    "--auth-sandbox": "authSandbox",
    "--credential-store-platforms": "credentialStorePlatforms",
    "--adr": "adr",
    "--composition": "composition",
    "--e2e": "e2e",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else if (paths[argument] !== undefined) options[paths[argument]] = value;
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  const root = resolve(options.root);
  for (const name of Object.values(paths)) {
    if (options[name] !== null) options[name] = resolve(root, options[name]);
  }
  return { ...options, root };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const execution = await runP1b(parseArguments(process.argv.slice(2)));
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "P1B_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
