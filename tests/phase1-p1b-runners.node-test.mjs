/* global Buffer, process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { createManagementRuntimeContract } from "../apps/workos-management/scripts/runtime-contract.mjs";
import {
  EVIDENCE_SCHEMA_VERSION,
  createWorktreeDigest,
  sha256,
  verifyEvidenceFile,
  writeEvidence,
} from "../scripts/phase1-evidence-core.mjs";
import {
  runCapabilityPreflight,
  sanitizeCapabilityProbeResult,
  validateCapabilityProducerCandidate,
} from "../scripts/phase1-auth-preflight-capabilities.mjs";
import {
  capabilityAttestationExitCode,
  runAttestedCapabilityPreflight,
} from "../scripts/phase1-auth-preflight-capabilities-attested.mjs";
import { runAuthPreflight } from "../scripts/phase1-auth-preflight.mjs";

const roots = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const attestedRunnerPath = join(
  repositoryRoot,
  "scripts/phase1-auth-preflight-capabilities-attested.mjs",
);
const authRunnerPath = join(repositoryRoot, "scripts/phase1-auth-preflight.mjs");
const fixedDate = () => new Date("2026-08-18T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("attested capability CLI maps measured, blocked, and invalid outcomes to 0, 2, and 1", () => {
  assert.equal(capabilityAttestationExitCode("PASS"), 0);
  assert.equal(capabilityAttestationExitCode("BLOCKED_PREREQUISITE"), 2);
  assert.equal(capabilityAttestationExitCode("FAIL"), 1);
});

test("attested capability CLI emits a complete blocked record and exits two when prerequisites are missing", async () => {
  const root = await temporaryRoot();
  const execution = spawnSync(process.execPath, [attestedRunnerPath, "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] },
  });

  assert.equal(execution.status, 2);
  assert.equal(execution.stderr, "");
  const result = JSON.parse(execution.stdout);
  assert.equal(result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(result.foundation_outcome, "BLOCKED");
  assert.equal(result.candidate_outcome, "UNDECIDED");
  assert.equal(result.command, "pnpm phase1:auth-preflight:capabilities:attested");
  assert.equal(result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(result.sanitized_metrics.gate_closures, []);
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

const createArtifact = async (root, source = "export {};\n", launchable = true) => {
  const sources = {
    "dist/index.js": source,
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
  for (const [path, content] of Object.entries(sources)) {
    await write(root, `apps/workos-management/${path}`, content);
    records.push({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) });
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

const baseRecord = ({
  scope,
  runId,
  artifactSha256,
  runnerState = "PASS",
  startedAt,
  finishedAt,
}) => ({
  schema_version: EVIDENCE_SCHEMA_VERSION,
  scope,
  runner_state: runnerState,
  foundation_outcome: "BLOCKED",
  candidate_outcome: "UNDECIDED",
  reason_code: "TEST_RECORD",
  command: "test",
  git_commit: null,
  run_id: runId,
  worktree_digest: "a".repeat(64),
  dirty: true,
  started_at: startedAt,
  finished_at: finishedAt,
  checks: [],
  sanitized_metrics: {
    provider_calls: 0,
    provider_credentials_resolved: 0,
    management_artifact_sha256: artifactSha256,
    gate_closures: [],
    backend_decision: null,
  },
  unmet_prerequisites: [],
});

const createInputs = async (root, artifactSha256) => {
  const p1a = await writeEvidence({
    root,
    runId: "01K00000000000000000000001",
    filename: "p1a-local.json",
    result: baseRecord({
      scope: "phase1_p1a_local",
      runId: "01K00000000000000000000001",
      artifactSha256,
      startedAt: "2026-08-18T10:00:00.000Z",
      finishedAt: "2026-08-18T10:10:00.000Z",
    }),
  });
  const names = await writeEvidence({
    root,
    runId: "01K00000000000000000000002",
    filename: "auth-preflight-names.json",
    result: {
      ...baseRecord({
        scope: "phase1_auth_preflight_names",
        runId: "01K00000000000000000000002",
        artifactSha256: undefined,
        startedAt: "2026-08-18T10:11:00.000Z",
        finishedAt: "2026-08-18T10:12:00.000Z",
      }),
      sanitized_metrics: {
        configuration_names: [{ name: "WORKOS_AUTHKIT_CLIENT_ID", present: true }],
        present_count: 1,
        required_count: 1,
      },
    },
  });
  return { names, p1a };
};

const completeObservations = () => [
  { id: "authkit_oidc_metadata", available: true, status_code: 200 },
  { id: "connect_applications_read", available: true, count: 1, status_code: 200 },
  { id: "connect_client_secrets_metadata_read", available: true, count: 1, status_code: 200 },
  { id: "fga_resources_read", available: false, count: 0, status_code: 403 },
  { id: "memberships_read", available: true, count: 2, status_code: 200 },
  { id: "m2m_token_flow", available: true, status_code: 200 },
  { id: "organizations_read", available: true, count: 2, status_code: 200 },
  { id: "webhook_endpoints_read", available: true, count: 1, status_code: 200 },
];

const producerRecord = ({ artifactSha256, p1a, p1aSha256, overrides = {} }) => ({
  ...baseRecord({
    scope: "phase1_auth_preflight_capability_producer",
    runId: "01K00000000000000000000050",
    artifactSha256,
    startedAt: "2026-08-18T10:20:00.000Z",
    finishedAt: "2026-08-18T10:30:00.000Z",
  }),
  git_commit: "1".repeat(40),
  reason_code: "CAPABILITY_MEASUREMENT_PASSED",
  worktree_digest: p1a.worktree_digest,
  dirty: false,
  command: "pnpm phase1:auth-preflight:capabilities:producer",
  checks: [
    {
      id: "provider_capability_measurement",
      state: "PASS",
      duration_ms: 1,
      evidence_ref: "auth-preflight-capabilities-producer.json#/sanitized_metrics/observations",
    },
  ],
  sanitized_metrics: {
    measurement_mode: "isolated_management_probe",
    provider_calls: 8,
    provider_credentials_resolved: 2,
    management_artifact_sha256: artifactSha256,
    cloudflare_worker_version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
    observations: completeObservations(),
    subordinate_evidence: {
      scope: "phase1_p1a_local",
      run_id: p1a.run_id,
      sha256: p1aSha256,
    },
    gate_closures: [],
    backend_decision: null,
  },
  ...overrides,
});

const commitFixtureRoot = async (root) => {
  await write(root, ".gitignore", "docs/plan/evidence/\n");
  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Capability Attestation Test"],
    ["config", "user.email", "capability-attestation@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "test fixture"],
  ]) {
    const execution = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  }
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
};

const writeAttestationTestLoader = async (root) => {
  const loaderPath = join(root, "attestation-test-loader.mjs");
  await writeFile(
    loaderPath,
    `import { appendFileSync, writeFileSync } from "node:fs";
export async function load(url, context, nextLoad) {
  if (url.endsWith("/scripts/phase1-github-attestation.mjs")) {
    return {
      format: "module",
      shortCircuit: true,
      source: \`import { appendFileSync, writeFileSync } from "node:fs";
export async function verifyGitHubAttestation(input) {
  appendFileSync(process.env.ATTESTATION_MARKER, JSON.stringify(input) + "\\\\n");
  if (process.env.MUTATE_AFTER_ATTESTATION) {
    writeFileSync(process.env.MUTATE_AFTER_ATTESTATION, "{}\\\\n", "utf8");
  }
}\`,
    };
  }
  return nextLoad(url, context);
}
`,
    "utf8",
  );
  return loaderPath;
};

const createAttestedProducerChain = async (root) => {
  const artifact = await createArtifact(root);
  const sourceDigest = await commitFixtureRoot(root);
  const worktreeDigest = await createWorktreeDigest(root);
  const p1a = await writeEvidence({
    root,
    runId: "01K00000000000000000000060",
    filename: "p1a-local.json",
    result: {
      ...baseRecord({
        scope: "phase1_p1a_local",
        runId: "01K00000000000000000000060",
        artifactSha256: artifact.artifactSha256,
        startedAt: "2026-08-18T10:00:00.000Z",
        finishedAt: "2026-08-18T10:10:00.000Z",
      }),
      git_commit: sourceDigest,
      worktree_digest: worktreeDigest,
      dirty: false,
    },
  });
  const producer = await writeEvidence({
    root,
    runId: "01K00000000000000000000061",
    filename: "auth-preflight-capabilities-producer.json",
    result: producerRecord({
      artifactSha256: artifact.artifactSha256,
      p1a: p1a.result,
      p1aSha256: sha256(await readFile(p1a.outputPath)),
      overrides: {
        git_commit: sourceDigest,
        worktree_digest: worktreeDigest,
      },
    }),
  });
  return { artifact, p1a, producer, sourceDigest, worktreeDigest };
};

test("capability preflight blocks fixture-only execution without resolving credentials", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { p1a } = await createInputs(root, artifact.artifactSha256);
  const execution = await runCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    now: fixedDate,
    runId: "01K00000000000000000000003",
  });

  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.reason_code, "CAPABILITY_PROBE_MISSING");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
  assert.equal(execution.result.sanitized_metrics.provider_credentials_resolved, 0);
  assert.equal(
    execution.result.sanitized_metrics.management_artifact_sha256,
    artifact.artifactSha256,
  );
  assert.equal(execution.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(execution.result.sanitized_metrics.gate_closures, []);
  await verifyEvidenceFile(execution.outputPath);
});

test("capability projection accepts only allowlisted sanitized probe observations", () => {
  const sanitized = sanitizeCapabilityProbeResult({
    runner_state: "PASS",
    reason_code: "CAPABILITY_MEASUREMENT_PASSED",
    provider_calls: 8,
    provider_credentials_resolved: 2,
    observations: [
      { id: "authkit_oidc_metadata", available: true, status_code: 200 },
      { id: "connect_applications_read", available: true, count: 1, status_code: 200 },
      { id: "connect_client_secrets_metadata_read", available: true, count: 1, status_code: 200 },
      { id: "fga_resources_read", available: false, count: 0, status_code: 403 },
      { id: "memberships_read", available: true, count: 2, status_code: 200 },
      { id: "m2m_token_flow", available: true, status_code: 200 },
      { id: "organizations_read", available: true, count: 2, status_code: 200 },
      { id: "webhook_endpoints_read", available: true, count: 1, status_code: 200 },
    ],
  });
  assert.equal(sanitized.observations.length, 8);
  assert.deepEqual(sanitized.observations.at(3), {
    id: "fga_resources_read",
    available: false,
    count: 0,
    status_code: 403,
  });
  assert.throws(
    () =>
      sanitizeCapabilityProbeResult({
        runner_state: "PASS",
        reason_code: "CAPABILITY_MEASUREMENT_PASSED",
        provider_calls: 1,
        provider_credentials_resolved: 1,
        observations: [{ id: "organizations_read", available: true, status_code: 200 }],
        secret: "must-not-persist",
      }),
    /INVALID_CAPABILITY_PROBE_RESULT/u,
  );
  assert.throws(
    () =>
      sanitizeCapabilityProbeResult({
        runner_state: "PASS",
        reason_code: "CAPABILITY_MEASUREMENT_PASSED",
        provider_calls: 2,
        provider_credentials_resolved: 1,
        observations: [
          { id: "organizations_read", available: true, count: 1, status_code: 200 },
          { id: "webhook_endpoints_read", available: true, count: 1, status_code: 200 },
        ],
      }),
    /INVALID_CAPABILITY_PROBE_RESULT/u,
  );
});

test("attested capability producer validation binds P1A, source, worktree, artifact, chronology, and eight observations", () => {
  const p1a = baseRecord({
    scope: "phase1_p1a_local",
    runId: "01K00000000000000000000001",
    artifactSha256: "b".repeat(64),
    startedAt: "2026-08-18T10:00:00.000Z",
    finishedAt: "2026-08-18T10:10:00.000Z",
  });
  p1a.git_commit = "1".repeat(40);
  p1a.dirty = false;
  const p1aSha256 = "c".repeat(64);
  const producer = producerRecord({
    artifactSha256: "b".repeat(64),
    p1a,
    p1aSha256,
  });

  const validated = validateCapabilityProducerCandidate({
    producer,
    producerSha256: "d".repeat(64),
    p1aRecord: p1a,
    p1aSha256,
    artifactSha256: "b".repeat(64),
    sourceDigest: "1".repeat(40),
    sourceRef: "refs/heads/main",
    currentWorktreeDigest: p1a.worktree_digest,
    aggregateStartedAt: new Date("2026-08-18T10:40:00.000Z"),
  });

  assert.equal(Object.hasOwn(validated, "producerAttested"), false);
  assert.equal(validated.observations.length, 8);
  assert.equal(validated.producerEvidence.sha256, "d".repeat(64));
  assert.equal(validated.sourceDigest, "1".repeat(40));
  assert.equal(validated.sourceRef, "refs/heads/main");
  assert.equal(validated.cloudflareWorkerVersionId, "095f00a7-23a7-43b7-a227-e4c97cab5f22");
});

test("attested capability producer validation rejects schema leakage and every exact-chain mismatch", () => {
  const p1a = baseRecord({
    scope: "phase1_p1a_local",
    runId: "01K00000000000000000000001",
    artifactSha256: "b".repeat(64),
    startedAt: "2026-08-18T10:00:00.000Z",
    finishedAt: "2026-08-18T10:10:00.000Z",
  });
  p1a.git_commit = "1".repeat(40);
  p1a.dirty = false;
  const p1aSha256 = "c".repeat(64);
  const base = producerRecord({ artifactSha256: "b".repeat(64), p1a, p1aSha256 });
  const validate = (producer) =>
    validateCapabilityProducerCandidate({
      producer,
      producerSha256: "d".repeat(64),
      p1aRecord: p1a,
      p1aSha256,
      artifactSha256: "b".repeat(64),
      sourceDigest: "1".repeat(40),
      sourceRef: "refs/heads/main",
      currentWorktreeDigest: p1a.worktree_digest,
      aggregateStartedAt: new Date("2026-08-18T10:40:00.000Z"),
    });

  assert.throws(
    () => validate({ ...base, secret: "must-not-persist" }),
    /INVALID_CAPABILITY_PRODUCER_SCHEMA/u,
  );
  assert.throws(
    () => validate({ ...base, worktree_digest: "e".repeat(64) }),
    /CAPABILITY_PRODUCER_WORKTREE_MISMATCH/u,
  );
  assert.throws(
    () =>
      validate({
        ...base,
        sanitized_metrics: {
          ...base.sanitized_metrics,
          cloudflare_worker_version_id: "spoofed",
        },
      }),
    /INVALID_CAPABILITY_PRODUCER_SCHEMA/u,
  );
  assert.throws(
    () =>
      validate({
        ...base,
        sanitized_metrics: {
          ...base.sanitized_metrics,
          observations: completeObservations().slice(1),
        },
      }),
    /INVALID_CAPABILITY_PROBE_RESULT/u,
  );
  assert.throws(
    () => validate({ ...base, started_at: "2026-08-18T10:05:00.000Z" }),
    /INVALID_CAPABILITY_PRODUCER_CHRONOLOGY/u,
  );
  assert.throws(
    () =>
      validateCapabilityProducerCandidate({
        producer: base,
        producerSha256: "d".repeat(64),
        p1aRecord: { ...p1a, started_at: "2026-08-18T10:11:00.000Z" },
        p1aSha256,
        artifactSha256: "b".repeat(64),
        sourceDigest: "1".repeat(40),
        sourceRef: "refs/heads/main",
        currentWorktreeDigest: p1a.worktree_digest,
        aggregateStartedAt: new Date("2026-08-18T10:40:00.000Z"),
      }),
    /INVALID_CAPABILITY_PRODUCER_CHRONOLOGY/u,
  );
});

test("attested capability runner reports missing producer evidence as a blocked prerequisite", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { p1a } = await createInputs(root, artifact.artifactSha256);
  const execution = await runAttestedCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    repository: "example/ohmyhost",
    signerWorkflow: "example/ohmyhost/.github/workflows/phase1-workos-capabilities.yml",
    sourceDigest: "1".repeat(40),
    sourceRef: "refs/heads/main",
    now: fixedDate,
    runId: "01K00000000000000000000051",
  });

  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.reason_code, "ATTESTED_CAPABILITY_EVIDENCE_MISSING");
  assert.equal(execution.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(execution.result.sanitized_metrics.gate_closures, []);
  assert.equal((await readFile(execution.outputPath, "utf8")).includes("must-not-persist"), false);
});

test("attested capability runner rejects every signer workflow except the fixed capability producer", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { p1a } = await createInputs(root, artifact.artifactSha256);
  const producer = await writeEvidence({
    root,
    runId: "01K00000000000000000000057",
    filename: "auth-preflight-capabilities-producer.json",
    result: baseRecord({
      scope: "phase1_auth_preflight_capability_producer",
      runId: "01K00000000000000000000057",
      artifactSha256: artifact.artifactSha256,
      startedAt: "2026-08-18T10:20:00.000Z",
      finishedAt: "2026-08-18T10:30:00.000Z",
    }),
  });
  const execution = await runAttestedCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    producer: producer.outputPath,
    repository: "example/ohmyhost",
    signerWorkflow: "example/ohmyhost/.github/workflows/attacker.yml",
    sourceDigest: "1".repeat(40),
    sourceRef: "refs/heads/main",
    now: fixedDate,
    runId: "01K00000000000000000000058",
  });

  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "INVALID_ATTESTATION_WORKFLOW");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
});

test("attested capability CLI fails closed with exit one for producer schema leakage", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const sourceDigest = await commitFixtureRoot(root);
  const { p1a } = await createInputs(root, artifact.artifactSha256);
  const producer = await writeEvidence({
    root,
    runId: "01K00000000000000000000054",
    filename: "auth-preflight-capabilities-producer.json",
    result: {
      ...producerRecord({
        artifactSha256: artifact.artifactSha256,
        p1a: p1a.result,
        p1aSha256: sha256(await readFile(p1a.outputPath)),
      }),
      secret: "must-not-persist",
    },
  });
  const execution = spawnSync(
    process.execPath,
    [
      attestedRunnerPath,
      "--root",
      root,
      "--p1a",
      p1a.outputPath,
      "--producer",
      producer.outputPath,
      "--repository",
      "example/ohmyhost",
      "--signer-workflow",
      "example/ohmyhost/.github/workflows/phase1-workos-capabilities.yml",
      "--source-digest",
      sourceDigest,
      "--source-ref",
      "refs/heads/main",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { PATH: process.env["PATH"] },
    },
  );

  assert.equal(execution.status, 1);
  assert.equal(execution.stderr, "");
  const result = JSON.parse(execution.stdout);
  assert.equal(result.runner_state, "FAIL");
  assert.equal(result.foundation_outcome, "BLOCKED");
  assert.equal(result.candidate_outcome, "UNDECIDED");
  assert.equal(result.reason_code, "INVALID_CAPABILITY_PRODUCER_SCHEMA");
  assert.equal(execution.stdout.includes("must-not-persist"), false);
  assert.equal(result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(result.sanitized_metrics.gate_closures, []);
});

test("attested capability runner re-binds P1A after verification and rejects a mutation race", async () => {
  const root = await temporaryRoot();
  const chain = await createAttestedProducerChain(root);
  const toolingRoot = await temporaryRoot();
  const loaderPath = await writeAttestationTestLoader(toolingRoot);
  const marker = join(toolingRoot, "attestation-calls.ndjson");
  const execution = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loaderPath,
      attestedRunnerPath,
      "--root",
      root,
      "--p1a",
      chain.p1a.outputPath,
      "--producer",
      chain.producer.outputPath,
      "--repository",
      "example/ohmyhost",
      "--signer-workflow",
      "example/ohmyhost/.github/workflows/phase1-workos-capabilities.yml",
      "--source-digest",
      chain.sourceDigest,
      "--source-ref",
      "refs/heads/main",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"],
        ATTESTATION_MARKER: marker,
        MUTATE_AFTER_ATTESTATION: chain.p1a.outputPath,
      },
    },
  );

  assert.equal(execution.status, 1, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.runner_state, "FAIL");
  assert.equal(result.reason_code, "P1A_EVIDENCE_CHANGED_AFTER_ATTESTATION");
  assert.equal(result.sanitized_metrics.provider_calls, 0);
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
});

test("fixed-workflow verification produces capability PASS and Stage 5 independently verifies it", async () => {
  const root = await temporaryRoot();
  const chain = await createAttestedProducerChain(root);
  const toolingRoot = await temporaryRoot();
  const loaderPath = await writeAttestationTestLoader(toolingRoot);
  const marker = join(toolingRoot, "attestation-calls.ndjson");
  const commonEnvironment = {
    PATH: process.env["PATH"],
    ATTESTATION_MARKER: marker,
  };
  const capabilityExecution = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loaderPath,
      attestedRunnerPath,
      "--root",
      root,
      "--p1a",
      chain.p1a.outputPath,
      "--producer",
      chain.producer.outputPath,
      "--repository",
      "example/ohmyhost",
      "--signer-workflow",
      "example/ohmyhost/.github/workflows/phase1-workos-capabilities.yml",
      "--source-digest",
      chain.sourceDigest,
      "--source-ref",
      "refs/heads/main",
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: commonEnvironment },
  );
  assert.equal(capabilityExecution.status, 0, capabilityExecution.stderr);
  const capabilityResult = JSON.parse(capabilityExecution.stdout);
  assert.equal(capabilityResult.runner_state, "PASS");
  assert.equal(capabilityResult.sanitized_metrics.producer_attested, true);
  const capabilityPath = join(
    root,
    "docs/plan/evidence/legacy/phase1",
    capabilityResult.run_id,
    "auth-preflight-capabilities.json",
  );
  const names = await writeEvidence({
    root,
    runId: "01K00000000000000000000062",
    filename: "auth-preflight-names.json",
    result: {
      ...baseRecord({
        scope: "phase1_auth_preflight_names",
        runId: "01K00000000000000000000062",
        artifactSha256: undefined,
        startedAt: "2026-08-18T10:11:00.000Z",
        finishedAt: "2026-08-18T10:12:00.000Z",
      }),
      sanitized_metrics: {
        configuration_names: [{ name: "WORKOS_AUTHKIT_CLIENT_ID", present: true }],
        present_count: 1,
        required_count: 1,
      },
    },
  });
  const aggregateExecution = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loaderPath,
      authRunnerPath,
      "--root",
      root,
      "--names",
      names.outputPath,
      "--capabilities",
      capabilityPath,
      "--repository",
      "example/ohmyhost",
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: commonEnvironment },
  );
  assert.equal(aggregateExecution.status, 0, aggregateExecution.stderr);
  const aggregateResult = JSON.parse(aggregateExecution.stdout);
  assert.equal(aggregateResult.runner_state, "PASS");
  assert.equal(aggregateResult.foundation_outcome, "BLOCKED");
  assert.equal(aggregateResult.candidate_outcome, "UNDECIDED");
  const calls = (await readFile(marker, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].subjectPath, chain.producer.outputPath);
  assert.equal(calls[1].subjectPath, capabilityPath);
  assert.equal(calls[1].sourceDigest, chain.sourceDigest);
  assert.equal(
    calls[1].signerWorkflow,
    "example/ohmyhost/.github/workflows/phase1-workos-capabilities.yml",
  );
  const mutationExecution = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loaderPath,
      authRunnerPath,
      "--root",
      root,
      "--names",
      names.outputPath,
      "--capabilities",
      capabilityPath,
      "--repository",
      "example/ohmyhost",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...commonEnvironment, MUTATE_AFTER_ATTESTATION: capabilityPath },
    },
  );
  assert.equal(mutationExecution.status, 1, mutationExecution.stderr);
  const mutationResult = JSON.parse(mutationExecution.stdout);
  assert.equal(mutationResult.runner_state, "FAIL");
  assert.equal(mutationResult.reason_code, "CAPABILITY_EVIDENCE_CHANGED_AFTER_ATTESTATION");
});

test("capability preflight rejects a P1A digest that is not the current exact artifact", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { p1a } = await createInputs(root, "b".repeat(64));
  const execution = await runCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    probe: async () => assert.fail("probe must not run"),
    now: fixedDate,
    runId: "01K00000000000000000000006",
  });
  assert.notEqual(artifact.artifactSha256, "b".repeat(64));
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "P1A_ARTIFACT_DIGEST_MISMATCH");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
});

test("injected capability callbacks cannot manufacture provider evidence", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { p1a } = await createInputs(root, artifact.artifactSha256);
  let calls = 0;
  const execution = await runCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    probe: async () => {
      calls += 1;
      return {
        runner_state: "PASS",
        reason_code: "CAPABILITY_MEASUREMENT_PASSED",
        provider_calls: 1,
        provider_credentials_resolved: 1,
        observations: [{ id: "organizations_read", available: true, status_code: 200 }],
      };
    },
    now: fixedDate,
    runId: "01K0000000000000000000000C",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.reason_code, "ATTESTED_CAPABILITY_PROBE_UNAVAILABLE");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
  assert.equal(calls, 0);
});

test("capability preflight rejects the current library-only artifact before any provider probe", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root, "export {};\n", false);
  const { p1a } = await createInputs(root, artifact.artifactSha256);
  let calls = 0;
  const execution = await runCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    probe: async () => {
      calls += 1;
      return {
        runner_state: "PASS",
        reason_code: "CAPABILITY_MEASUREMENT_PASSED",
        provider_calls: 1,
        provider_credentials_resolved: 1,
        observations: [{ id: "organizations_read", available: true, status_code: 200 }],
      };
    },
    now: fixedDate,
    runId: "01K0000000000000000000000F",
  });

  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.reason_code, "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
  assert.equal(calls, 0);
});

test("aggregate preserves an unattested capability measurement as blocked", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { names, p1a } = await createInputs(root, artifact.artifactSha256);
  const capability = await runCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    probe: async () => ({
      runner_state: "PASS",
      reason_code: "CAPABILITY_MEASUREMENT_PASSED",
      provider_calls: 1,
      provider_credentials_resolved: 1,
      observations: [{ id: "organizations_read", available: true, count: 1, status_code: 200 }],
    }),
    now: () => new Date("2026-08-18T10:13:00.000Z"),
    runId: "01K00000000000000000000007",
  });
  const aggregate = await runAuthPreflight({
    root,
    names: names.outputPath,
    capabilities: capability.outputPath,
    now: () => new Date("2026-08-18T10:14:00.000Z"),
    runId: "01K00000000000000000000008",
  });

  assert.equal(aggregate.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(aggregate.result.foundation_outcome, "BLOCKED");
  assert.equal(aggregate.result.candidate_outcome, "UNDECIDED");
  assert.equal(aggregate.result.reason_code, "SUBORDINATE_PREFLIGHT_BLOCKED");
  assert.equal(aggregate.result.sanitized_metrics.provider_calls, 0);
  assert.equal(
    aggregate.result.sanitized_metrics.management_artifact_sha256,
    artifact.artifactSha256,
  );
  assert.match(
    aggregate.result.sanitized_metrics.subordinate_evidence.names.sha256,
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    aggregate.result.sanitized_metrics.subordinate_evidence.capabilities.sha256,
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(aggregate.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(aggregate.result.sanitized_metrics.gate_closures, []);
  await verifyEvidenceFile(aggregate.outputPath);
});

test("aggregate rejects a self-asserted capability PASS without the attested producer chain", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { names } = await createInputs(root, artifact.artifactSha256);
  const capability = await writeEvidence({
    root,
    runId: "01K00000000000000000000052",
    filename: "auth-preflight-capabilities.json",
    result: {
      ...baseRecord({
        scope: "phase1_auth_preflight_capabilities",
        runId: "01K00000000000000000000052",
        artifactSha256: artifact.artifactSha256,
        startedAt: "2026-08-18T10:13:00.000Z",
        finishedAt: "2026-08-18T10:14:00.000Z",
      }),
      sanitized_metrics: {
        measurement_mode: "isolated_management_probe",
        provider_calls: 8,
        provider_credentials_resolved: 2,
        management_artifact_sha256: artifact.artifactSha256,
        cloudflare_worker_version_id: null,
        observations: completeObservations(),
        subordinate_evidence: {
          scope: "phase1_p1a_local",
          run_id: "01K00000000000000000000001",
          sha256: "c".repeat(64),
        },
        producer_attested: false,
        producer_evidence: null,
        source_digest: null,
        source_ref: null,
        gate_closures: [],
        backend_decision: null,
      },
    },
  });
  const aggregate = await runAuthPreflight({
    root,
    names: names.outputPath,
    capabilities: capability.outputPath,
    now: () => new Date("2026-08-18T10:15:00.000Z"),
    runId: "01K00000000000000000000053",
  });

  assert.equal(aggregate.result.runner_state, "FAIL");
  assert.equal(aggregate.result.reason_code, "INVALID_SUBORDINATE_PREFLIGHT");
  assert.equal(aggregate.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(aggregate.result.sanitized_metrics.gate_closures, []);
});

test("aggregate rejects a fabricated producer-attested capability projection without independent provenance", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { names } = await createInputs(root, artifact.artifactSha256);
  const sourceDigest = "1".repeat(40);
  const capability = await writeEvidence({
    root,
    runId: "01K00000000000000000000055",
    filename: "auth-preflight-capabilities.json",
    result: {
      ...baseRecord({
        scope: "phase1_auth_preflight_capabilities",
        runId: "01K00000000000000000000055",
        artifactSha256: artifact.artifactSha256,
        startedAt: "2026-08-18T10:13:00.000Z",
        finishedAt: "2026-08-18T10:14:00.000Z",
      }),
      reason_code: "CAPABILITY_MEASUREMENT_PASSED",
      git_commit: sourceDigest,
      dirty: false,
      sanitized_metrics: {
        measurement_mode: "producer_attested_github",
        provider_calls: 8,
        provider_credentials_resolved: 2,
        management_artifact_sha256: artifact.artifactSha256,
        cloudflare_worker_version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
        observations: completeObservations(),
        subordinate_evidence: {
          scope: "phase1_p1a_local",
          run_id: "01K00000000000000000000001",
          sha256: "c".repeat(64),
        },
        producer_attested: true,
        producer_evidence: {
          scope: "phase1_auth_preflight_capability_producer",
          run_id: "01K00000000000000000000054",
          sha256: "d".repeat(64),
        },
        source_digest: sourceDigest,
        source_ref: "refs/heads/main",
        gate_closures: [],
        backend_decision: null,
      },
    },
  });
  const aggregate = await runAuthPreflight({
    root,
    names: names.outputPath,
    capabilities: capability.outputPath,
    now: () => new Date("2026-08-18T10:15:00.000Z"),
    runId: "01K00000000000000000000056",
  });

  assert.equal(aggregate.result.runner_state, "FAIL");
  assert.equal(aggregate.result.foundation_outcome, "BLOCKED");
  assert.equal(aggregate.result.candidate_outcome, "UNDECIDED");
  assert.equal(aggregate.result.reason_code, "CAPABILITY_ATTESTATION_WORKTREE_MISMATCH");
  assert.equal(aggregate.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(aggregate.result.sanitized_metrics.gate_closures, []);
});

test("aggregate remains blocked for blocked subordinate evidence and fails closed on chronology", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const { names, p1a } = await createInputs(root, artifact.artifactSha256);
  const blockedCapability = await runCapabilityPreflight({
    root,
    p1a: p1a.outputPath,
    now: () => new Date("2026-08-18T10:13:00.000Z"),
    runId: "01K00000000000000000000009",
  });
  const blocked = await runAuthPreflight({
    root,
    names: names.outputPath,
    capabilities: blockedCapability.outputPath,
    now: () => new Date("2026-08-18T10:14:00.000Z"),
    runId: "01K0000000000000000000000A",
  });
  assert.equal(blocked.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(blocked.result.reason_code, "SUBORDINATE_PREFLIGHT_BLOCKED");

  const chronologyFailure = await runAuthPreflight({
    root,
    names: names.outputPath,
    capabilities: blockedCapability.outputPath,
    now: () => new Date("2026-08-18T09:00:00.000Z"),
    runId: "01K0000000000000000000000B",
  });
  assert.equal(chronologyFailure.result.runner_state, "FAIL");
  assert.equal(chronologyFailure.result.reason_code, "INVALID_PREFLIGHT_CHRONOLOGY");
  assert.equal(chronologyFailure.result.sanitized_metrics.provider_calls, 0);
});

test("plan commands discover the newest verified predecessor evidence without manual paths", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  await createInputs(root, artifact.artifactSha256);

  const capability = await runCapabilityPreflight({
    root,
    now: () => new Date("2026-08-18T10:13:00.000Z"),
    runId: "01K0000000000000000000000D",
  });
  assert.equal(capability.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(capability.result.reason_code, "CAPABILITY_PROBE_MISSING");

  const aggregate = await runAuthPreflight({
    root,
    now: () => new Date("2026-08-18T10:14:00.000Z"),
    runId: "01K0000000000000000000000E",
  });
  assert.equal(aggregate.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(aggregate.result.reason_code, "SUBORDINATE_PREFLIGHT_BLOCKED");
});
