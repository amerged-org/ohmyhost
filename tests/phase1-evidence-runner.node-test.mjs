/* global Buffer */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { URL } from "node:url";

import { createManagementRuntimeContract } from "../apps/workos-management/scripts/runtime-contract.mjs";
import {
  EMPTY_SHA256,
  createWorktreeDigest,
  findNewestEvidence,
  resolveOfflineSandboxInvocation,
  sha256,
  validateCandidateArtifact,
  verifyEvidenceFile,
  writeEvidence,
} from "../scripts/phase1-evidence-core.mjs";
import { P1A_CHECKS, runP1a } from "../scripts/phase1-p1a.mjs";
import { runP1aRed } from "../scripts/phase1-p1a-red.mjs";
import { runPhase1Verify } from "../scripts/phase1-verify.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-phase1-evidence-"));
  roots.push(root);
  return root;
};

test("falls back to the Node permission sandbox when the host namespace sandbox cannot start", async () => {
  const nodeArguments = ["--permission", "--import", "/offline-guard.mjs", "/candidate.js"];
  const systemInvocations = [];
  const invocation = await resolveOfflineSandboxInvocation(nodeArguments, {
    createSystemInvocation: async (arguments_) => {
      systemInvocations.push(arguments_);
      return { command: "/usr/bin/unshare", arguments_: ["--net", ...arguments_] };
    },
    probeInvocation: async () => false,
    nodeExecutable: "/opt/node/bin/node",
  });

  assert.deepEqual(systemInvocations, [["--permission", "-e", ""]]);
  assert.deepEqual(invocation, {
    command: "/opt/node/bin/node",
    arguments_: nodeArguments,
  });
});

const write = async (root, path, content) => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const createArtifact = async (root, files = null) => {
  const candidateFiles = {
    "dist/worker-bundle/README.md": "deterministic worker bundle\n",
    "dist/worker-bundle/worker-main.js": "export {};\n",
    "dist/worker-bundle/metafile.json": "{}\n",
    "dist/runtime/runtime-contract.json": `${JSON.stringify(createManagementRuntimeContract())}\n`,
    "dist/runtime/wrangler.jsonc":
      '{"main":"src/worker-main.ts","workers_dev":false,"preview_urls":false}\n',
    ...(files ?? {
      "dist/index.js": "export {};\n",
      "dist/sandbox-main.js":
        'const digest = process.argv[3]; process.stdout.write(`${JSON.stringify({schema_version:"workos-management-sandbox-self-test-v1",artifact_sha256:digest,components:{resolver:"configured",transport:"read_only",rpc:"authenticated"}})}\\n`);\n',
    }),
  };
  const records = [];
  for (const [path, content] of Object.entries(candidateFiles)) {
    await write(root, `apps/workos-management/${path}`, content);
    records.push({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  const framed = records
    .map(
      (file) =>
        `${String(file.path.length)}:${file.path}${String(file.sha256.length)}:${file.sha256}`,
    )
    .join("");
  const artifact = {
    schemaVersion: 2,
    artifact: "workos-management",
    deploymentPolicy: "service-binding-only",
    ...(records.some(({ path }) => path === "dist/sandbox-main.js")
      ? { entrypoint: "dist/sandbox-main.js" }
      : {}),
    runtimeEntrypoint: "dist/worker-bundle/worker-main.js",
    runtimeContract: "dist/runtime/runtime-contract.json",
    files: records,
    artifactSha256: sha256(framed),
  };
  await write(
    root,
    "apps/workos-management/dist/candidate-artifact.json",
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
};

const passingCommand = async ({ command, arguments_, id }) => ({
  id,
  command: [command, ...arguments_].join(" "),
  exit_code: 0,
  duration_ms: 1,
  stdout: { bytes: 0, sha256: EMPTY_SHA256 },
  stderr: { bytes: 0, sha256: EMPTY_SHA256 },
});

const fixedDate = () => new Date("2026-08-18T12:00:00.000Z");

test("worktree evidence excludes only evidence and local secret paths while including .env.example", async () => {
  const root = await temporaryRoot();
  await write(root, "source.txt", "source-a");
  await write(root, ".env", "SECRET=one");
  await write(root, "nested/.env.local", "SECRET=two");
  await write(root, ".env.example", "EXAMPLE=one");
  await write(root, ".ohmyhost/session.json", "session-one");
  await write(root, "docs/plan/evidence/legacy/phase1/old/result.json", "evidence-one");
  await write(root, ".ohmyhost/credentials/store.json", "credential-one");

  const initial = await createWorktreeDigest(root, [".ohmyhost/credentials"]);
  await write(root, ".env", "SECRET=changed");
  await write(root, "nested/.env.local", "SECRET=changed");
  await write(root, ".ohmyhost/session.json", "session-changed");
  await write(root, "docs/plan/evidence/legacy/phase1/old/result.json", "evidence-changed");
  await write(root, ".ohmyhost/credentials/store.json", "credential-changed");
  assert.equal(await createWorktreeDigest(root, [".ohmyhost/credentials"]), initial);

  await write(root, ".env.example", "EXAMPLE=changed");
  assert.notEqual(await createWorktreeDigest(root, [".ohmyhost/credentials"]), initial);
  await assert.rejects(createWorktreeDigest(root, ["scripts"]), /INVALID_CREDENTIAL_STORE_PATH/u);
});

test("candidate validation binds the exact nonproduction artifact file set and digest", async () => {
  const root = await temporaryRoot();
  const expected = await createArtifact(root, {
    "dist/index.js": "export {};\n",
    "dist/index.js.map": "{}\n",
  });
  const validated = await validateCandidateArtifact(root);
  assert.equal(validated.artifact_sha256, expected.artifactSha256);
  assert.equal(validated.deployment_policy, "service-binding-only");
  assert.equal(validated.schema_version, 2);
  assert.equal(validated.runtime, "cloudflare-worker");
  assert.equal(validated.runtime_access, "service-binding-only");
  assert.equal(validated.runtime_entrypoint, "dist/worker-bundle/worker-main.js");
  assert.equal(validated.file_count, 7);

  await write(root, "apps/workos-management/dist/unrecorded.js", "export const leak = 1;\n");
  await assert.rejects(validateCandidateArtifact(root), /MANAGEMENT_ARTIFACT_FILE_SET_MISMATCH/u);
});

test("candidate validation requires a bounded digest-bound sandbox self-test", async () => {
  const root = await temporaryRoot();
  await createArtifact(root, {
    "dist/index.js": "export {};\n",
    "dist/sandbox-main.js": "export const sandboxMain = true;\n",
  });
  const artifact = await validateCandidateArtifact(root);
  assert.equal(artifact.launchable, false);
});

test("candidate self-test is denied network and filesystem mutation capability", async () => {
  const root = await temporaryRoot();
  await createArtifact(root, {
    "dist/index.js": "export {};\n",
    "dist/sandbox-main.js":
      'await fetch("https://example.com"); process.stdout.write("unreachable\\n");\n',
  });
  const artifact = await validateCandidateArtifact(root);
  assert.equal(artifact.launchable, false);
});

test("candidate self-test cannot bypass offline enforcement through Socket.prototype.connect", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const root = await temporaryRoot();
    await createArtifact(root, {
      "dist/index.js": "export {};\n",
      "dist/sandbox-main.js": `
        import net from "node:net";
        const digest = process.argv[3];
        const socket = new net.Socket();
        socket.once("error", () => process.exit(7));
        socket.connect(${address.port}, "127.0.0.1", () => {
          socket.destroy();
          process.stdout.write(JSON.stringify({schema_version:"workos-management-sandbox-self-test-v1",artifact_sha256:digest,components:{resolver:"configured",transport:"read_only",rpc:"authenticated"}}));
        });
      `,
    });

    const artifact = await validateCandidateArtifact(root);
    assert.equal(artifact.launchable, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("candidate self-test cannot bypass offline enforcement through http2.connect", async () => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const root = await temporaryRoot();
    await createArtifact(root, {
      "dist/index.js": "export {};\n",
      "dist/sandbox-main.js": `
        import http2 from "node:http2";
        const digest = process.argv[3];
        const session = http2.connect("http://127.0.0.1:${address.port}");
        session.once("error", () => process.exit(7));
        session.once("connect", () => {
          session.close();
          process.stdout.write(JSON.stringify({schema_version:"workos-management-sandbox-self-test-v1",artifact_sha256:digest,components:{resolver:"configured",transport:"read_only",rpc:"authenticated"}}));
        });
      `,
    });

    const artifact = await validateCandidateArtifact(root);
    assert.equal(artifact.launchable, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("evidence payload and summary hashes are independently verifiable", async () => {
  const root = await temporaryRoot();
  const execution = await writeEvidence({
    root,
    runId: "01K00000000000000000000000",
    filename: "result.json",
    result: {
      schema_version: "phase1-runner-result-v1",
      scope: "test",
      runner_state: "PASS",
    },
    payloads: [{ filename: "payload.json", content: { safe: true } }],
  });
  const verified = await verifyEvidenceFile(execution.outputPath);
  assert.equal(verified.runner_state, "PASS");
  assert.match(verified.evidence_manifest_sha256, /^[a-f0-9]{64}$/u);

  await writeFile(join(execution.directory, "payload.json"), "tampered\n");
  await assert.rejects(verifyEvidenceFile(execution.outputPath), /EVIDENCE_ARTIFACT_MISMATCH/u);
});

test("evidence discovery never follows a symlinked summary", async () => {
  const root = await temporaryRoot();
  await write(root, "outside.json", "{}\n");
  await mkdir(join(root, "docs/plan/evidence/legacy/phase1/run"), { recursive: true });
  await symlink(
    join(root, "outside.json"),
    join(root, "docs/plan/evidence/legacy/phase1/run/auth-preflight.json"),
  );

  assert.equal(await findNewestEvidence(root, "auth-preflight.json"), null);
});

test("explicit evidence verification rejects a symlinked summary", async () => {
  const root = await temporaryRoot();
  const evidence = await writeEvidence({
    root,
    runId: "01K0000000000000000000000F",
    filename: "result.json",
    result: {
      schema_version: "phase1-runner-result-v1",
      scope: "test",
      runner_state: "PASS",
    },
  });
  const linkedDirectory = join(root, "linked");
  await mkdir(linkedDirectory, { recursive: true });
  await symlink(evidence.outputPath, join(linkedDirectory, "result.json"));
  await writeFile(
    join(linkedDirectory, "manifest.sha256"),
    await readFile(join(evidence.directory, "manifest.sha256")),
  );

  await assert.rejects(
    verifyEvidenceFile(join(linkedDirectory, "result.json")),
    /INVALID_EVIDENCE_FILE/u,
  );
});

test("the post-implementation red runner reports unavailable history without a false red or green claim", async () => {
  const root = await temporaryRoot();
  await write(root, "source.txt", "implemented\n");
  const execution = await runP1aRed({
    root,
    now: fixedDate,
    runId: "01K00000000000000000000001",
  });

  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.reason_code, "HISTORICAL_EVIDENCE_UNAVAILABLE");
  assert.equal(execution.result.sanitized_metrics.tests_executed, 0);
  assert.equal(execution.result.sanitized_metrics.expected_failures_claimed, 0);
  assert.equal(execution.result.sanitized_metrics.passing_implementation_claimed, false);
  assert.deepEqual(execution.result.evidence_artifacts, []);
});

test("P1A records every local check, the candidate digest, and no backend or gate decision", async () => {
  const root = await temporaryRoot();
  const artifact = await createArtifact(root);
  await write(root, "source.txt", "source\n");
  const execution = await runP1a({
    root,
    commandRunner: passingCommand,
    now: fixedDate,
    runId: "01K00000000000000000000002",
  });

  assert.equal(execution.result.runner_state, "PASS");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(
    execution.result.sanitized_metrics.management_artifact_sha256,
    artifact.artifactSha256,
  );
  assert.equal(execution.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(execution.result.sanitized_metrics.gate_closures, []);
  assert.equal(execution.result.sanitized_metrics.completed_check_count, P1A_CHECKS.length + 1);
  assert.equal(execution.result.sanitized_metrics.required_check_count, P1A_CHECKS.length + 1);
  assert.equal(execution.result.checks.length, P1A_CHECKS.length + 1);
  assert.deepEqual(
    execution.result.checks
      .filter(({ id }) => id !== "management_candidate_artifact")
      .map(({ id }) => id),
    P1A_CHECKS.map(({ id }) => id),
  );
  await verifyEvidenceFile(execution.outputPath);
});

test("P1A stops at the first failed local check and never reports local readiness", async () => {
  const root = await temporaryRoot();
  await createArtifact(root);
  const execution = await runP1a({
    root,
    commandRunner: async (specification) => {
      const result = await passingCommand(specification);
      return specification.id === "sdk_ts_drift" ? { ...result, exit_code: 1 } : result;
    },
    now: fixedDate,
    runId: "01K00000000000000000000003",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "CHECK_FAILED_SDK_TS_DRIFT");
  assert.equal(
    execution.result.sanitized_metrics.completed_check_count,
    P1A_CHECKS.findIndex(({ id }) => id === "sdk_ts_drift") + 2,
  );
});

test("P1A does not accept a library-only management artifact as the retained workload", async () => {
  const root = await temporaryRoot();
  await createArtifact(root, { "dist/index.js": "export {};\n" });
  const execution = await runP1a({
    root,
    commandRunner: passingCommand,
    now: fixedDate,
    runId: "01K0000000000000000000000C",
  });

  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE");
});

const evidenceRecord = (overrides = {}) => ({
  schema_version: "phase1-runner-result-v1",
  scope: "phase1_p1a_local",
  runner_state: "PASS",
  foundation_outcome: "BLOCKED",
  candidate_outcome: "UNDECIDED",
  run_id: "01K00000000000000000000004",
  worktree_digest: "a".repeat(64),
  sanitized_metrics: { backend_decision: null, gate_closures: [] },
  ...overrides,
});

const p1bRecord = (overrides = {}) => ({
  ...evidenceRecord({
    scope: "phase1_p1b_provider",
    runner_state: "BLOCKED_PREREQUISITE",
    sanitized_metrics: {
      backend_decision: null,
      gate_closures: [],
      provider_verified: false,
    },
  }),
  ...overrides,
});

test("phase1 verify preserves P1A as blocked and undecided when provider evidence is absent", async () => {
  const root = await temporaryRoot();
  const p1aPath = join(root, "input-p1a.json");
  await writeFile(p1aPath, "{}\n");
  const p1a = evidenceRecord();
  const execution = await runPhase1Verify({
    root,
    p1a: p1aPath,
    evidenceReader: async () => p1a,
    worktreeDigest: async () => p1a.worktree_digest,
    now: fixedDate,
    runId: "01K00000000000000000000005",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.sanitized_metrics.p1a_is_p1b, false);
});

test("phase1 verify rejects P1A state escalation, blocked-name decisions, and P1A reuse as P1B", async () => {
  const cases = [
    {
      name: "p1a local failure",
      records: [
        evidenceRecord({
          runner_state: "FAIL",
          reason_code: "MANAGEMENT_ARTIFACT_NOT_LAUNCHABLE",
        }),
      ],
      reason: "P1A_LOCAL_FAILED",
      checkId: "p1a_local_evidence",
      unmetPrerequisites: ["P1A_LOCAL_EVIDENCE", "P1B_PROVIDER_EVIDENCE"],
    },
    {
      name: "p1a escalation",
      records: [
        evidenceRecord({
          foundation_outcome: "READY",
          candidate_outcome: "FGA_ELIGIBLE",
          sanitized_metrics: { backend_decision: "fga", gate_closures: ["GATE-P01"] },
        }),
      ],
      reason: "P1A_STATE_ESCALATION_REJECTED",
    },
    {
      name: "blocked names decision",
      records: [
        evidenceRecord(),
        evidenceRecord({
          scope: "phase1_auth_preflight_names",
          runner_state: "BLOCKED_PREREQUISITE",
          foundation_outcome: "READY",
          candidate_outcome: "LOCAL_GRANTS_REQUIRED",
        }),
      ],
      reason: "BLOCKED_NAMES_BACKEND_DECISION_REJECTED",
      names: true,
    },
    {
      name: "p1a reused as p1b",
      records: [evidenceRecord(), evidenceRecord()],
      reason: "P1A_CANNOT_SATISFY_P1B",
      p1b: true,
    },
  ];

  for (const scenario of cases) {
    const root = await temporaryRoot();
    const p1aPath = join(root, `${scenario.name}-p1a.json`);
    const namesPath = join(root, `${scenario.name}-names.json`);
    const p1bPath = join(root, `${scenario.name}-p1b.json`);
    await Promise.all([
      writeFile(p1aPath, "{}\n"),
      writeFile(namesPath, "{}\n"),
      writeFile(p1bPath, "{}\n"),
    ]);
    let index = 0;
    const execution = await runPhase1Verify({
      root,
      p1a: p1aPath,
      names: scenario.names ? namesPath : null,
      p1b: scenario.p1b ? p1bPath : null,
      evidenceReader: async () => scenario.records[index++],
      worktreeDigest: async () => "a".repeat(64),
      now: fixedDate,
      runId: `01K0000000000000000000000${6 + index}`,
    });
    assert.equal(execution.result.runner_state, "FAIL", scenario.name);
    assert.equal(execution.result.reason_code, scenario.reason, scenario.name);
    assert.equal(execution.result.candidate_outcome, "UNDECIDED", scenario.name);
    if (scenario.checkId !== undefined) {
      assert.equal(execution.result.checks.at(-1)?.id, scenario.checkId, scenario.name);
    }
    if (scenario.unmetPrerequisites !== undefined) {
      assert.deepEqual(
        execution.result.unmet_prerequisites,
        scenario.unmetPrerequisites,
        scenario.name,
      );
    }
  }
});

test("phase1 verify preserves a verified blocked P1B outcome without converting it to failure", async () => {
  const root = await temporaryRoot();
  const p1aPath = join(root, "blocked-p1a.json");
  const p1bPath = join(root, "blocked-p1b.json");
  await Promise.all([writeFile(p1aPath, "{}\n"), writeFile(p1bPath, "{}\n")]);
  const records = [evidenceRecord(), p1bRecord()];
  let index = 0;
  const execution = await runPhase1Verify({
    root,
    p1a: p1aPath,
    p1b: p1bPath,
    evidenceReader: async () => records[index++],
    worktreeDigest: async () => "a".repeat(64),
    now: fixedDate,
    runId: "01K0000000000000000000000A",
  });

  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.reason_code, "P1B_EVIDENCE_BLOCKED");
});

test("phase1 verify rejects self-asserted provider-verified P1B records", async () => {
  const root = await temporaryRoot();
  const p1aPath = join(root, "ready-p1a.json");
  const p1bPath = join(root, "ready-p1b.json");
  await Promise.all([writeFile(p1aPath, "{}\n"), writeFile(p1bPath, "{}\n")]);
  const records = [
    evidenceRecord(),
    p1bRecord({
      runner_state: "PASS",
      foundation_outcome: "READY",
      candidate_outcome: "FGA_ELIGIBLE",
      sanitized_metrics: {
        backend_decision: "workos_fga",
        gate_closures: [],
        provider_verified: true,
      },
    }),
  ];
  let index = 0;
  const execution = await runPhase1Verify({
    root,
    p1a: p1aPath,
    p1b: p1bPath,
    evidenceReader: async () => records[index++],
    worktreeDigest: async () => "a".repeat(64),
    now: fixedDate,
    runId: "01K0000000000000000000000B",
  });

  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.reason_code, "ATTESTED_P1B_EVIDENCE_UNAVAILABLE");
  assert.equal(execution.result.sanitized_metrics.backend_decision, null);
});

test("command evidence stores only bounded hashes rather than captured output", async () => {
  const root = await temporaryRoot();
  await createArtifact(root);
  const sensitiveMarker = "provider-value-must-not-be-recorded";
  const execution = await runP1a({
    root,
    commandRunner: async (specification) => ({
      ...(await passingCommand(specification)),
      raw_stdout: sensitiveMarker,
      raw_stderr: sensitiveMarker,
    }),
    now: fixedDate,
    runId: "01K00000000000000000000009",
  });
  const checks = await readFile(join(execution.directory, "checks.json"), "utf8");
  assert.doesNotMatch(checks, new RegExp(sensitiveMarker, "u"));
  assert.match(checks, new RegExp(createHash("sha256").digest("hex"), "u"));
});

test("Git evidence keeps its frozen environment allowlist while Node coverage receives a mutable per-spawn copy", async () => {
  const root = await temporaryRoot(),
    privateRoot = await temporaryRoot();
  await write(root, "source.txt", "qualified source");
  const bin = join(privateRoot, "bin"),
    coverage = join(privateRoot, "coverage"),
    observed = join(privateRoot, "environment.json");
  await mkdir(bin, { mode: 0o700 });
  await mkdir(coverage, { mode: 0o700 });
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(observed)},JSON.stringify({keys:Object.keys(process.env).sort(),sentinel:process.env.TASK_PRIVATE_SENTINEL!==undefined}));\nprocess.stdout.write('source.txt\\0');\n`,
    { mode: 0o700 },
  );
  const module = new URL("../scripts/phase1-evidence-core.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import {createWorktreeDigest} from ${JSON.stringify(module)}; process.stdout.write(await createWorktreeDigest(${JSON.stringify(root)}));`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: bin + ":" + process.env.PATH,
        NODE_V8_COVERAGE: coverage,
        TASK_PRIVATE_SENTINEL: "must-not-forward",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.match(child.stdout, /^[a-f0-9]{64}$/u);
  const actual = JSON.parse(await readFile(observed, "utf8"));
  assert.equal(actual.sentinel, false);
  // macOS inserts its own encoding marker when launching Node; it is not an ambient field forwarded by runGit.
  assert.deepEqual(
    actual.keys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
    ["LC_ALL", "NODE_V8_COVERAGE", "PATH"],
  );
});
