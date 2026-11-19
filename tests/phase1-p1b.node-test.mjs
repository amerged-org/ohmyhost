/* global Buffer, process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { createManagementRuntimeContract } from "../apps/workos-management/scripts/runtime-contract.mjs";
import {
  EVIDENCE_SCHEMA_VERSION,
  sha256,
  verifyEvidenceFile,
  writeEvidence,
} from "../scripts/phase1-evidence-core.mjs";
import { runP1b } from "../scripts/phase1-p1b.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repositoryRoot, "scripts/phase1-p1b.mjs");
const roots = [];
const fixedNow = () => new Date("2026-08-18T16:00:00.000Z");
const e2eChecks = ["human", "device", "api_key", "m2m", "bola", "idempotency"];
const platformSourceDigest = "1".repeat(40);
const nativePlatformEvidence = {
  darwin: {
    run_id: "01K00000000000000000000191",
    runner_state: "PASS",
    real_native: true,
    native_backend: "keychain",
    sha256: "a".repeat(64),
  },
  linux: {
    run_id: "01K00000000000000000000192",
    runner_state: "PASS",
    real_native: true,
    native_backend: "secret_service",
    sha256: "b".repeat(64),
  },
  win32: {
    run_id: "01K00000000000000000000193",
    runner_state: "PASS",
    real_native: true,
    native_backend: "credential_manager",
    sha256: "c".repeat(64),
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-phase1-p1b-"));
  roots.push(root);
  return root;
};

const write = async (root, path, content) => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const createArtifact = async (root, launchable = true) => {
  const sources = {
    "dist/index.js": "export {};\n",
    "dist/worker-bundle/README.md": "deterministic worker bundle\n",
    "dist/worker-bundle/worker-main.js": "export {};\n",
    "dist/worker-bundle/metafile.json": "{}\n",
    "dist/runtime/runtime-contract.json": `${JSON.stringify(createManagementRuntimeContract())}\n`,
    "dist/runtime/wrangler.jsonc":
      '{"main":"src/worker-main.ts","workers_dev":false,"preview_urls":false}\n',
    ...(launchable
      ? {
          "dist/sandbox-main.js":
            'const digest = process.argv[3]; process.stdout.write(`${JSON.stringify({schema_version:"workos-management-sandbox-self-test-v1",artifact_sha256:digest,components:{resolver:"configured",transport:"read_only",rpc:"authenticated"}})}\\n`);\n',
        }
      : {}),
  };
  const records = [];
  for (const [path, source] of Object.entries(sources)) {
    await write(root, `apps/workos-management/${path}`, source);
    records.push({ path, bytes: Buffer.byteLength(source), sha256: sha256(source) });
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  const frame = records
    .map(
      (record) =>
        `${String(record.path.length)}:${record.path}${String(record.sha256.length)}:${record.sha256}`,
    )
    .join("");
  const artifact = {
    schemaVersion: 2,
    artifact: "workos-management",
    deploymentPolicy: "service-binding-only",
    ...(launchable ? { entrypoint: "dist/sandbox-main.js" } : {}),
    runtimeEntrypoint: "dist/worker-bundle/worker-main.js",
    runtimeContract: "dist/runtime/runtime-contract.json",
    files: records,
    artifactSha256: sha256(frame),
  };
  await write(
    root,
    "apps/workos-management/dist/candidate-artifact.json",
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
};

const evidence = ({
  root,
  runId,
  filename,
  scope,
  runnerState = "PASS",
  foundationOutcome = "BLOCKED",
  candidateOutcome = "UNDECIDED",
  startedAt,
  finishedAt,
  checks = [],
  metrics = {},
  gitCommit = null,
  dirty = true,
}) =>
  writeEvidence({
    root,
    runId,
    filename,
    result: {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      scope,
      runner_state: runnerState,
      foundation_outcome: foundationOutcome,
      candidate_outcome: candidateOutcome,
      reason_code: "TEST_EVIDENCE",
      command: "test",
      git_commit: gitCommit,
      run_id: runId,
      worktree_digest: "a".repeat(64),
      dirty,
      started_at: startedAt,
      finished_at: finishedAt,
      checks,
      sanitized_metrics: {
        provider_calls: 0,
        gate_closures: [],
        backend_decision: null,
        ...metrics,
      },
      unmet_prerequisites: runnerState === "PASS" ? [] : ["TEST_PREREQUISITE"],
    },
  });

const createChain = async (root, candidateOutcome = "FGA_ELIGIBLE", launchable = true) => {
  const artifact = await createArtifact(root, launchable);
  const backend = candidateOutcome === "FGA_ELIGIBLE" ? "workos_fga" : "local_grants";
  const sandbox = await evidence({
    root,
    runId: "01K00000000000000000000101",
    filename: "auth-sandbox.json",
    scope: "phase1_auth_sandbox",
    foundationOutcome: "READY",
    candidateOutcome,
    startedAt: "2026-08-18T10:00:00.000Z",
    finishedAt: "2026-08-18T11:00:00.000Z",
    metrics: { management_artifact_sha256: artifact.artifactSha256 },
  });
  const platforms = await evidence({
    root,
    runId: "01K00000000000000000000102",
    filename: "credential-store-platforms.json",
    scope: "phase1_credential_store_platforms",
    startedAt: "2026-08-18T09:00:00.000Z",
    finishedAt: "2026-08-18T12:00:00.000Z",
    gitCommit: platformSourceDigest,
    dirty: false,
    metrics: {
      required_platforms: ["darwin", "linux", "win32"],
      platform_evidence: nativePlatformEvidence,
      producer_attested: true,
      source_digest: platformSourceDigest,
    },
  });
  const adr = await evidence({
    root,
    runId: "01K00000000000000000000103",
    filename: "authorization-backend-adr.json",
    scope: "phase1_authorization_backend_adr",
    foundationOutcome: "READY",
    candidateOutcome,
    startedAt: "2026-08-18T11:01:00.000Z",
    finishedAt: "2026-08-18T12:01:00.000Z",
    metrics: { selected_backend: backend },
  });
  const composition = await evidence({
    root,
    runId: "01K00000000000000000000104",
    filename: "authorization-backend-composition.json",
    scope: "phase1_authorization_backend_composition",
    foundationOutcome: "READY",
    candidateOutcome,
    startedAt: "2026-08-18T12:02:00.000Z",
    finishedAt: "2026-08-18T13:00:00.000Z",
    metrics: { enabled_backends: [backend] },
  });
  const e2e = await evidence({
    root,
    runId: "01K00000000000000000000105",
    filename: "p1b-client-e2e.json",
    scope: "phase1_p1b_client_e2e",
    foundationOutcome: "READY",
    candidateOutcome,
    startedAt: "2026-08-18T13:01:00.000Z",
    finishedAt: "2026-08-18T15:00:00.000Z",
    checks: e2eChecks.map((id) => ({ id, state: "PASS", duration_ms: 1, evidence_ref: "e2e" })),
    metrics: { provider_verified: true },
  });
  return { artifact, backend, sandbox, platforms, adr, composition, e2e };
};

const explicitInputs = (chain) => ({
  adr: chain.adr.outputPath,
  composition: chain.composition.outputPath,
  e2e: chain.e2e.outputPath,
});

test("missing evidence blocks without provider, native, or client calls", async () => {
  const root = await temporaryRoot();
  const execution = await runP1b({
    root,
    now: fixedNow,
    runId: "01K00000000000000000000110",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
  assert.equal(execution.result.sanitized_metrics.native_operations, 0);
  assert.equal(execution.result.sanitized_metrics.client_calls, 0);
});

test("self-asserted complete chains fail before provider evidence without aggregate attestation", async () => {
  for (const [index, candidate] of ["FGA_ELIGIBLE", "LOCAL_GRANTS_REQUIRED"].entries()) {
    const root = await temporaryRoot();
    const chain = await createChain(root, candidate);
    const execution = await runP1b({
      root,
      ...explicitInputs(chain),
      githubRepository: "owner/repository",
      now: fixedNow,
      runId: `01K0000000000000000000012${index}`,
    });
    assert.equal(execution.result.runner_state, "FAIL");
    assert.equal(execution.result.foundation_outcome, "READY");
    assert.equal(execution.result.candidate_outcome, candidate);
    assert.equal(execution.result.reason_code, "INVALID_GITHUB_ATTESTATION_CONTEXT");
    assert.equal(execution.result.sanitized_metrics.backend_decision, null);
    assert.deepEqual(execution.result.unmet_prerequisites, []);
    assert.deepEqual(execution.result.sanitized_metrics.gate_closures, []);
    assert.equal(
      execution.result.sanitized_metrics.management_artifact_sha256,
      chain.artifact.artifactSha256,
    );
    await verifyEvidenceFile(execution.outputPath);
  }
});

test("missing ADR preserves a safe decided sandbox result but remains blocked", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  const execution = await runP1b({
    root,
    composition: chain.composition.outputPath,
    e2e: chain.e2e.outputPath,
    now: fixedNow,
    runId: "01K00000000000000000000130",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "READY");
  assert.equal(execution.result.candidate_outcome, "FGA_ELIGIBLE");
  assert.ok(execution.result.unmet_prerequisites.includes("adr"));
});

test("composition must enable exactly one backend matching candidate and ADR", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  chain.composition = await evidence({
    root,
    runId: "01K00000000000000000000131",
    filename: "authorization-backend-composition.json",
    scope: "phase1_authorization_backend_composition",
    foundationOutcome: "READY",
    candidateOutcome: "FGA_ELIGIBLE",
    startedAt: "2026-08-18T12:02:00.000Z",
    finishedAt: "2026-08-18T13:00:00.000Z",
    metrics: { enabled_backends: ["workos_fga", "local_grants"] },
  });
  const execution = await runP1b({
    root,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000132",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "INVALID_BACKEND_COMPOSITION");
});

test("P1A reuse and ADR/backend mismatch are rejected", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  const p1a = await evidence({
    root,
    runId: "01K00000000000000000000133",
    filename: "p1a-local.json",
    scope: "phase1_p1a_local",
    startedAt: "2026-08-18T11:01:00.000Z",
    finishedAt: "2026-08-18T12:01:00.000Z",
  });
  const reused = await runP1b({
    root,
    ...explicitInputs(chain),
    adr: p1a.outputPath,
    now: fixedNow,
    runId: "01K00000000000000000000134",
  });
  assert.equal(reused.result.runner_state, "FAIL");
  assert.equal(reused.result.reason_code, "P1A_CANNOT_SATISFY_P1B");

  chain.adr = await evidence({
    root,
    runId: "01K00000000000000000000135",
    filename: "authorization-backend-adr.json",
    scope: "phase1_authorization_backend_adr",
    foundationOutcome: "READY",
    candidateOutcome: "FGA_ELIGIBLE",
    startedAt: "2026-08-18T11:01:00.000Z",
    finishedAt: "2026-08-18T12:01:00.000Z",
    metrics: { selected_backend: "local_grants" },
  });
  const mismatch = await runP1b({
    root,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000136",
  });
  assert.equal(mismatch.result.runner_state, "FAIL");
  assert.equal(mismatch.result.reason_code, "ADR_BACKEND_MISMATCH");
});

test("blocked platform evidence blocks while invalid E2E evidence fails", async () => {
  const blockedRoot = await temporaryRoot();
  const blockedChain = await createChain(blockedRoot);
  blockedChain.platforms = await evidence({
    root: blockedRoot,
    runId: "01K00000000000000000000137",
    filename: "credential-store-platforms.json",
    scope: "phase1_credential_store_platforms",
    runnerState: "BLOCKED_PREREQUISITE",
    startedAt: "2026-08-18T09:00:00.000Z",
    finishedAt: "2026-08-18T12:00:00.000Z",
  });
  const blocked = await runP1b({
    root: blockedRoot,
    ...explicitInputs(blockedChain),
    credentialStorePlatforms: blockedChain.platforms.outputPath,
    now: fixedNow,
    runId: "01K00000000000000000000138",
  });
  assert.equal(blocked.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(blocked.result.reason_code, "CREDENTIAL_STORE_PLATFORMS_BLOCKED");
  assert.equal(blocked.result.foundation_outcome, "READY");

  const invalidRoot = await temporaryRoot();
  const invalidChain = await createChain(invalidRoot);
  invalidChain.e2e = await evidence({
    root: invalidRoot,
    runId: "01K00000000000000000000139",
    filename: "p1b-client-e2e.json",
    scope: "phase1_p1b_client_e2e",
    foundationOutcome: "READY",
    candidateOutcome: "FGA_ELIGIBLE",
    startedAt: "2026-08-18T13:01:00.000Z",
    finishedAt: "2026-08-18T15:00:00.000Z",
    checks: e2eChecks.slice(0, -1).map((id) => ({ id, state: "PASS" })),
    metrics: { provider_verified: true },
  });
  const invalid = await runP1b({
    root: invalidRoot,
    ...explicitInputs(invalidChain),
    now: fixedNow,
    runId: "01K00000000000000000000140",
  });
  assert.equal(invalid.result.runner_state, "FAIL");
  assert.equal(invalid.result.reason_code, "INVALID_P1B_E2E_EVIDENCE");
});

test("a shallow platform PASS without all three real native proofs cannot satisfy P1B", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  chain.platforms = await evidence({
    root,
    runId: "01K00000000000000000000194",
    filename: "credential-store-platforms.json",
    scope: "phase1_credential_store_platforms",
    startedAt: "2026-08-18T09:00:00.000Z",
    finishedAt: "2026-08-18T12:00:00.000Z",
    metrics: { verified_platform_count: 3 },
  });

  const execution = await runP1b({
    root,
    credentialStorePlatforms: chain.platforms.outputPath,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000195",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "INVALID_CREDENTIAL_STORE_PLATFORM_EVIDENCE");
});

test("a complete-looking platform PASS without verified producer provenance cannot satisfy P1B", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  chain.platforms = await evidence({
    root,
    runId: "01K00000000000000000000196",
    filename: "credential-store-platforms.json",
    scope: "phase1_credential_store_platforms",
    startedAt: "2026-08-18T09:00:00.000Z",
    finishedAt: "2026-08-18T12:00:00.000Z",
    gitCommit: platformSourceDigest,
    dirty: false,
    metrics: {
      required_platforms: ["darwin", "linux", "win32"],
      platform_evidence: nativePlatformEvidence,
      producer_attested: false,
      source_digest: platformSourceDigest,
    },
  });

  const execution = await runP1b({
    root,
    credentialStorePlatforms: chain.platforms.outputPath,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000197",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "INVALID_CREDENTIAL_STORE_PLATFORM_EVIDENCE");
});

test("digest and dependency chronology mismatches fail closed", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  chain.sandbox = await evidence({
    root,
    runId: "01K00000000000000000000141",
    filename: "auth-sandbox.json",
    scope: "phase1_auth_sandbox",
    foundationOutcome: "READY",
    candidateOutcome: "FGA_ELIGIBLE",
    startedAt: "2026-08-18T10:00:00.000Z",
    finishedAt: "2026-08-18T11:00:00.000Z",
    metrics: { management_artifact_sha256: "b".repeat(64) },
  });
  const mismatch = await runP1b({
    root,
    authSandbox: chain.sandbox.outputPath,
    credentialStorePlatforms: chain.platforms.outputPath,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000142",
  });
  assert.equal(mismatch.result.runner_state, "FAIL");
  assert.equal(mismatch.result.reason_code, "SANDBOX_ARTIFACT_DIGEST_MISMATCH");

  const chronologyRoot = await temporaryRoot();
  const chronologyChain = await createChain(chronologyRoot);
  chronologyChain.adr = await evidence({
    root: chronologyRoot,
    runId: "01K00000000000000000000143",
    filename: "authorization-backend-adr.json",
    scope: "phase1_authorization_backend_adr",
    foundationOutcome: "READY",
    candidateOutcome: "FGA_ELIGIBLE",
    startedAt: "2026-08-18T10:30:00.000Z",
    finishedAt: "2026-08-18T12:01:00.000Z",
    metrics: { selected_backend: "workos_fga" },
  });
  const chronology = await runP1b({
    root: chronologyRoot,
    ...explicitInputs(chronologyChain),
    now: fixedNow,
    runId: "01K00000000000000000000144",
  });
  assert.equal(chronology.result.runner_state, "FAIL");
  assert.equal(chronology.result.reason_code, "INVALID_P1B_DEPENDENCY_ORDER");
});

test("P1B rejects a decided sandbox chain bound to a library-only artifact", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root, "FGA_ELIGIBLE", false);

  const execution = await runP1b({
    root,
    authSandbox: chain.sandbox.outputPath,
    credentialStorePlatforms: chain.platforms.outputPath,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000147",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE");
});

test("tampered explicit evidence fails manifest verification", async () => {
  const root = await temporaryRoot();
  const chain = await createChain(root);
  await writeFile(chain.composition.outputPath, "{}\n", "utf8");
  const execution = await runP1b({
    root,
    ...explicitInputs(chain),
    now: fixedNow,
    runId: "01K00000000000000000000145",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "COMPOSITION_EVIDENCE_INVALID");
});

test("direct CLI without arguments exits two without external calls", async () => {
  const root = await temporaryRoot();
  const execution = spawnSync(process.execPath, [runnerPath], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] },
  });
  assert.equal(execution.status, 2);
  assert.equal(execution.stderr, "");
  const result = JSON.parse(execution.stdout);
  assert.equal(result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(result.sanitized_metrics.provider_calls, 0);
  assert.equal(result.sanitized_metrics.native_operations, 0);
  assert.equal(result.sanitized_metrics.client_calls, 0);
});
