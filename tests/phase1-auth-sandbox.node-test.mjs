/* global Buffer, process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
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
import { evaluateSandboxMeasurement, runAuthSandbox } from "../scripts/phase1-auth-sandbox.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repositoryRoot, "scripts/phase1-auth-sandbox.mjs");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-phase1-auth-sandbox-"));
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

const createAggregate = async ({
  root,
  artifactSha256,
  runId,
  runnerState = "PASS",
  finishedAt = "2026-08-18T10:00:00.000Z",
}) =>
  writeEvidence({
    root,
    runId,
    filename: "auth-preflight.json",
    result: {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      scope: "phase1_auth_preflight",
      runner_state: runnerState,
      foundation_outcome: "BLOCKED",
      candidate_outcome: "UNDECIDED",
      reason_code:
        runnerState === "PASS"
          ? "AUTH_PREFLIGHT_MEASUREMENT_PASSED"
          : "SUBORDINATE_PREFLIGHT_BLOCKED",
      command: "pnpm phase1:auth-preflight",
      git_commit: null,
      run_id: runId,
      worktree_digest: "a".repeat(64),
      dirty: true,
      started_at: "2026-08-18T09:59:00.000Z",
      finished_at: finishedAt,
      checks: [],
      sanitized_metrics: {
        provider_calls: 0,
        provider_credentials_resolved: 0,
        management_artifact_sha256: artifactSha256,
        subordinate_evidence: {},
        gate_closures: [],
        backend_decision: null,
      },
      unmet_prerequisites: runnerState === "PASS" ? [] : ["SUBORDINATE_PREFLIGHT_BLOCKED"],
    },
  });

const measurement = ({ sharedComplete, sharedPassed, fgaComplete, fgaPassed }) => {
  const fgaAllowed = sharedComplete && sharedPassed;
  return {
    provider_calls: 4,
    provider_credentials_resolved: 1,
    shared: {
      complete: sharedComplete,
      passed: sharedPassed,
      measured_count: sharedComplete ? 2 : 1,
      required_count: 2,
      status_codes: [200, sharedPassed ? 200 : 403],
    },
    fga: {
      complete: fgaComplete,
      passed: fgaPassed,
      measured_count: fgaComplete ? 2 : fgaAllowed ? 1 : 0,
      required_count: 2,
      status_codes: fgaAllowed ? [200, fgaPassed ? 200 : 422] : [],
    },
  };
};

const fixedNow = () => new Date("2026-08-18T11:00:00.000Z");

test("missing or blocked aggregate evidence blocks without invoking measurement", async () => {
  const missingRoot = await temporaryRoot();
  let calls = 0;
  const missing = await runAuthSandbox({
    root: missingRoot,
    measurement: async () => {
      calls += 1;
      return measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: true,
      });
    },
    now: fixedNow,
    runId: "01K00000000000000000000001",
  });
  assert.equal(missing.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(missing.result.reason_code, "AUTH_PREFLIGHT_EVIDENCE_MISSING");
  assert.equal(calls, 0);

  const blockedRoot = await temporaryRoot();
  const artifact = await createArtifact(blockedRoot);
  await createAggregate({
    root: blockedRoot,
    artifactSha256: artifact.artifactSha256,
    runId: "01K00000000000000000000002",
    runnerState: "BLOCKED_PREREQUISITE",
  });
  const blocked = await runAuthSandbox({
    root: blockedRoot,
    measurement: async () => {
      calls += 1;
      return measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: true,
      });
    },
    now: fixedNow,
    runId: "01K00000000000000000000003",
  });
  assert.equal(blocked.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(blocked.result.foundation_outcome, "BLOCKED");
  assert.equal(blocked.result.candidate_outcome, "UNDECIDED");
  assert.equal(blocked.result.reason_code, "AUTH_PREFLIGHT_BLOCKED");
  assert.equal(calls, 0);
});

test("auto-discovery selects the newest aggregate and fixture-only mode stays blocked", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const old = await createAggregate({
    root,
    artifactSha256: artifact.artifactSha256,
    runId: "01K00000000000000000000004",
    runnerState: "BLOCKED_PREREQUISITE",
  });
  const newest = await createAggregate({
    root,
    artifactSha256: artifact.artifactSha256,
    runId: "01K00000000000000000000005",
  });
  await utimes(
    old.outputPath,
    new Date("2026-08-18T09:00:00.000Z"),
    new Date("2026-08-18T09:00:00.000Z"),
  );
  await utimes(
    newest.outputPath,
    new Date("2026-08-18T10:00:00.000Z"),
    new Date("2026-08-18T10:00:00.000Z"),
  );

  const execution = await runAuthSandbox({
    root,
    now: fixedNow,
    runId: "01K00000000000000000000006",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.reason_code, "SANDBOX_MEASUREMENT_MISSING");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
  assert.equal(
    execution.result.sanitized_metrics.management_artifact_sha256,
    artifact.artifactSha256,
  );
  assert.equal(
    execution.result.sanitized_metrics.subordinate_evidence.run_id,
    "01K00000000000000000000005",
  );
  await verifyEvidenceFile(execution.outputPath);
});

test("sandbox measurement projection maps only the five allowed plan outcomes", () => {
  const cases = [
    {
      name: "shared missing",
      observed: measurement({
        sharedComplete: false,
        sharedPassed: false,
        fgaComplete: false,
        fgaPassed: false,
      }),
      expected: [
        "BLOCKED_PREREQUISITE",
        "BLOCKED",
        "UNDECIDED",
        "SHARED_FOUNDATION_EVIDENCE_MISSING",
      ],
    },
    {
      name: "shared measured failure",
      observed: measurement({
        sharedComplete: true,
        sharedPassed: false,
        fgaComplete: false,
        fgaPassed: false,
      }),
      expected: ["PASS", "BLOCKED", "UNDECIDED", "SHARED_FOUNDATION_MEASUREMENT_FAILED"],
    },
    {
      name: "FGA missing",
      observed: measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: false,
        fgaPassed: false,
      }),
      expected: ["BLOCKED_PREREQUISITE", "READY", "UNDECIDED", "FGA_CANDIDATE_EVIDENCE_MISSING"],
    },
    {
      name: "FGA measured failure",
      observed: measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: false,
      }),
      expected: ["PASS", "READY", "LOCAL_GRANTS_REQUIRED", "FGA_CANDIDATE_MEASUREMENT_FAILED"],
    },
    {
      name: "all pass",
      observed: measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: true,
      }),
      expected: ["PASS", "READY", "FGA_ELIGIBLE", "SANDBOX_MEASUREMENT_PASSED"],
    },
  ];

  for (const testCase of cases) {
    const { outcome } = evaluateSandboxMeasurement(testCase.observed);
    assert.deepEqual(
      [
        outcome.runnerState,
        outcome.foundationOutcome,
        outcome.candidateOutcome,
        outcome.reasonCode,
      ],
      testCase.expected,
      testCase.name,
    );
  }
});

test("invalid measurement projection rejects unallowlisted data", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const aggregate = await createAggregate({
    root,
    artifactSha256: artifact.artifactSha256,
    runId: "01K00000000000000000000030",
  });
  assert.throws(
    () =>
      evaluateSandboxMeasurement({
        ...measurement({
          sharedComplete: true,
          sharedPassed: true,
          fgaComplete: true,
          fgaPassed: true,
        }),
        secret: "must-not-persist",
      }),
    /INVALID_SANDBOX_MEASUREMENT/u,
  );

  const stale = await runAuthSandbox({
    root,
    authPreflight: aggregate.outputPath,
    measurement: async () => assert.fail("measurement must not run"),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
    runId: "01K00000000000000000000032",
  });
  assert.equal(stale.result.runner_state, "FAIL");
  assert.equal(stale.result.reason_code, "INVALID_SANDBOX_CHRONOLOGY");
});

test("injected sandbox callbacks cannot manufacture provider evidence", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  const aggregate = await createAggregate({
    root,
    artifactSha256: artifact.artifactSha256,
    runId: "01K00000000000000000000031",
  });
  let calls = 0;
  const execution = await runAuthSandbox({
    root,
    authPreflight: aggregate.outputPath,
    measurement: async () => {
      calls += 1;
      return measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: true,
      });
    },
    now: fixedNow,
    runId: "01K00000000000000000000037",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.reason_code, "ATTESTED_SANDBOX_MEASUREMENT_UNAVAILABLE");
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
  assert.equal(calls, 0);
});

test("artifact mismatch fails before the measurement callback is invoked", async () => {
  const root = await temporaryRoot();
  await createArtifact(root);
  const aggregate = await createAggregate({
    root,
    artifactSha256: "b".repeat(64),
    runId: "01K00000000000000000000033",
  });
  let called = false;
  const execution = await runAuthSandbox({
    root,
    authPreflight: aggregate.outputPath,
    measurement: async () => {
      called = true;
      return measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: true,
      });
    },
    now: fixedNow,
    runId: "01K00000000000000000000034",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "AUTH_PREFLIGHT_ARTIFACT_DIGEST_MISMATCH");
  assert.equal(called, false);
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
});

test("a library-only artifact blocks sandbox measurement before provider access", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root, false);
  const aggregate = await createAggregate({
    root,
    artifactSha256: artifact.artifactSha256,
    runId: "01K00000000000000000000035",
  });
  let called = false;
  const execution = await runAuthSandbox({
    root,
    authPreflight: aggregate.outputPath,
    measurement: async () => {
      called = true;
      return measurement({
        sharedComplete: true,
        sharedPassed: true,
        fgaComplete: true,
        fgaPassed: true,
      });
    },
    now: fixedNow,
    runId: "01K00000000000000000000036",
  });

  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.reason_code, "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE");
  assert.equal(called, false);
});

test("direct CLI without arguments exits two with an honest blocked record", async () => {
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
  assert.equal(result.foundation_outcome, "BLOCKED");
  assert.equal(result.candidate_outcome, "UNDECIDED");
  assert.equal(result.sanitized_metrics.provider_calls, 0);
});
