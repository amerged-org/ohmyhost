/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  EVIDENCE_SCHEMA_VERSION,
  verifyEvidenceFile,
  writeEvidence,
} from "../scripts/phase1-evidence-core.mjs";
import {
  runAttestedCredentialStorePlatforms,
  runCredentialStorePlatforms,
} from "../scripts/phase1-credential-store-platforms.mjs";
import {
  evaluateNativeCredentialRoundTrip,
  parseCredentialStorePlatformProofArguments,
  runCredentialStorePlatformProof,
  stageEvidenceDirectory,
} from "../scripts/phase1-credential-store-platform-proof.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repositoryRoot, "scripts/phase1-credential-store-platforms.mjs");
const roots = [];
const platforms = ["darwin", "linux", "win32"];
const backends = {
  darwin: "keychain",
  linux: "secret_service",
  win32: "credential_manager",
};
const requiredChecks = ["create", "read", "rotate", "delete", "security"];
const fixedNow = () => new Date("2026-08-18T12:00:00.000Z");
const proofCredentials = [
  {
    accessToken: "honeytoken-first-access",
    refreshToken: "honeytoken-first-refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  {
    accessToken: "honeytoken-second-access",
    refreshToken: "honeytoken-second-refresh",
    expiresAt: "2099-01-02T00:00:00.000Z",
  },
];

test("platform proof CLI accepts pnpm's explicit argument separator", () => {
  const parsed = parseCredentialStorePlatformProofArguments(
    ["--", "--stage-output", "native-proof/darwin"],
    repositoryRoot,
  );

  assert.equal(parsed.root, repositoryRoot);
  assert.equal(parsed.stageOutput, join(repositoryRoot, "native-proof", "darwin"));
});

const initializeTrustedRepository = async (root) => {
  // Mirrors the real repository, where staged proof output is ignored and the worktree stays
  // clean: writeEvidence stages into docs/plan/evidence/legacy/phase1 exactly as production does
  // into the ignored native-proof directory.
  await writeFile(
    join(root, ".gitignore"),
    ".agent-state/\n.tools/\ndocs/plan/evidence/legacy/phase1/\n",
    "utf8",
  );
  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Native Proof Test"],
    ["config", "user.email", "native-proof@example.invalid"],
    ["add", ".gitignore"],
    ["commit", "--quiet", "-m", "test baseline"],
  ]) {
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(revision.status, 0, revision.stderr);
  return revision.stdout.trim();
};

test("native round-trip evaluator proves create, read, rotate, delete, and cleanup", async () => {
  let current;
  const calls = [];
  const store = {
    replace: async (credential) => {
      calls.push("replace");
      current = credential;
    },
    read: async () => {
      calls.push("read");
      return current;
    },
    clear: async () => {
      calls.push("clear");
      current = undefined;
    },
  };
  const first = {
    accessToken: "honeytoken-first-access",
    refreshToken: "honeytoken-first-refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const second = {
    accessToken: "honeytoken-second-access",
    refreshToken: "honeytoken-second-refresh",
    expiresAt: "2099-01-02T00:00:00.000Z",
  };

  assert.deepEqual(await evaluateNativeCredentialRoundTrip(store, first, second), {
    create: true,
    read: true,
    rotate: true,
    delete: true,
    security: true,
  });
  assert.deepEqual(calls, ["clear", "replace", "read", "replace", "read", "clear", "read"]);
});

test("native round-trip verifies the selected backend before deleting the proof entries", async () => {
  let current;
  const calls = [];
  const store = {
    replace: async (credential) => {
      calls.push("replace");
      current = credential;
    },
    read: async () => {
      calls.push("read");
      return current;
    },
    clear: async () => {
      calls.push("clear");
      current = undefined;
    },
  };

  await evaluateNativeCredentialRoundTrip(
    store,
    proofCredentials[0],
    proofCredentials[1],
    async () => {
      calls.push("verify-backend");
      assert.deepEqual(current, proofCredentials[1]);
    },
  );

  assert.deepEqual(calls, [
    "clear",
    "replace",
    "read",
    "replace",
    "read",
    "verify-backend",
    "clear",
    "read",
  ]);
});

test("native round-trip evaluator rejects a mismatched credential read", async () => {
  const store = {
    replace: async () => undefined,
    read: async () => ({
      accessToken: "wrong",
      refreshToken: "wrong",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    clear: async () => undefined,
  };

  await assert.rejects(
    evaluateNativeCredentialRoundTrip(
      store,
      { accessToken: "a", refreshToken: "b", expiresAt: "2099-01-01T00:00:00.000Z" },
      { accessToken: "c", refreshToken: "d", expiresAt: "2099-01-02T00:00:00.000Z" },
    ),
    /NATIVE_CREDENTIAL_STORE_CONTRACT_FAILED/u,
  );
});

test("platform proof uses a run-specific service, cleans up, and emits no credentials", async () => {
  const root = await temporaryRoot();
  let current;
  let clearCalls = 0;
  let observedService;
  const execution = await runCredentialStorePlatformProof({
    root,
    platform: "darwin",
    runId: "01K00000000000000000000020",
    now: fixedNow,
    createCredentials: () => proofCredentials,
    loadStore: async (_root, serviceName) => {
      observedService = serviceName;
      return {
        store: {
          replace: async (credential) => {
            current = credential;
          },
          read: async () => current,
          clear: async () => {
            clearCalls += 1;
            current = undefined;
          },
        },
        isUnavailableError: () => false,
      };
    },
  });

  assert.equal(execution.result.runner_state, "PASS");
  assert.equal(observedService, "ohmyhost-proof-01K00000000000000000000020");
  assert.equal(clearCalls, 3);
  const evidence = await readFile(execution.outputPath, "utf8");
  const payload = await readFile(join(dirname(execution.outputPath), "native-proof.json"), "utf8");
  const stageOutput = join(root, "native-proof", "darwin");
  await stageEvidenceDirectory(root, execution.outputPath, stageOutput);
  assert.deepEqual((await readdir(stageOutput)).sort(), [
    "credential-store-platform-darwin.json",
    "manifest.sha256",
    "native-proof.json",
  ]);
  for (const credential of proofCredentials) {
    assert.equal(evidence.includes(credential.accessToken), false);
    assert.equal(evidence.includes(credential.refreshToken), false);
    assert.equal(payload.includes(credential.accessToken), false);
    assert.equal(payload.includes(credential.refreshToken), false);
  }
});

test("platform proof distinguishes native unavailability from an unexpected implementation failure", async () => {
  class NativeUnavailable extends Error {}
  const cases = [
    {
      runId: "01K00000000000000000000021",
      error: new NativeUnavailable("native secret detail"),
      isUnavailableError: (error) => error instanceof NativeUnavailable,
      runnerState: "BLOCKED_PREREQUISITE",
      reasonCode: "NATIVE_SERVICE_UNAVAILABLE",
    },
    {
      runId: "01K00000000000000000000022",
      error: new TypeError("programming detail"),
      isUnavailableError: () => false,
      runnerState: "FAIL",
      reasonCode: "NATIVE_CREDENTIAL_STORE_PROOF_FAILED",
    },
  ];
  for (const testCase of cases) {
    const root = await temporaryRoot();
    let clearCalls = 0;
    const execution = await runCredentialStorePlatformProof({
      root,
      platform: "darwin",
      runId: testCase.runId,
      now: fixedNow,
      createCredentials: () => proofCredentials,
      loadStore: async () => ({
        store: {
          clear: async () => {
            clearCalls += 1;
            if (clearCalls === 1) throw testCase.error;
          },
        },
        isUnavailableError: testCase.isUnavailableError,
      }),
    });
    assert.equal(execution.result.runner_state, testCase.runnerState);
    assert.equal(execution.result.reason_code, testCase.reasonCode);
    assert.equal(execution.serialized.includes(testCase.error.message), false);
  }
});

test("platform proof reports final cleanup failure as FAIL", async () => {
  const root = await temporaryRoot();
  let current;
  let clearCalls = 0;
  const execution = await runCredentialStorePlatformProof({
    root,
    platform: "darwin",
    runId: "01K00000000000000000000023",
    now: fixedNow,
    createCredentials: () => proofCredentials,
    loadStore: async () => ({
      store: {
        replace: async (credential) => {
          current = credential;
        },
        read: async () => current,
        clear: async () => {
          clearCalls += 1;
          current = undefined;
          if (clearCalls === 3) throw new Error("cleanup secret detail");
        },
      },
      isUnavailableError: () => false,
    }),
  });

  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "NATIVE_CREDENTIAL_STORE_CLEANUP_FAILED");
  assert.equal(execution.result.sanitized_metrics.real_native, false);
  assert.equal(execution.serialized.includes("cleanup secret detail"), false);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-credential-platforms-"));
  roots.push(root);
  return root;
};

const createChild = async ({
  root,
  platform,
  runnerState = "PASS",
  backend = backends[platform],
  realNative = runnerState === "PASS",
  failedCheck = null,
  finishedAt = "2026-08-18T11:00:00.000Z",
  gitCommit = null,
  dirty = true,
  runId = `01K0000000000000000000000${platforms.indexOf(platform)}`,
}) =>
  writeEvidence({
    root,
    runId,
    filename: `credential-store-platform-${platform}.json`,
    result: {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      scope: "phase1_credential_store_platform",
      runner_state: runnerState,
      foundation_outcome: "BLOCKED",
      candidate_outcome: "UNDECIDED",
      reason_code:
        runnerState === "PASS" ? "NATIVE_CREDENTIAL_STORE_PASSED" : "NATIVE_SERVICE_UNAVAILABLE",
      command: `platform-proof-${platform}`,
      git_commit: gitCommit,
      run_id: runId,
      worktree_digest: "a".repeat(64),
      dirty,
      started_at: "2026-08-18T10:00:00.000Z",
      finished_at: finishedAt,
      checks: requiredChecks.map((id) => ({
        id,
        state:
          runnerState === "PASS" ? (failedCheck === id ? "FAIL" : "PASS") : "BLOCKED_PREREQUISITE",
        duration_ms: 1,
        evidence_ref: "native-proof.json",
      })),
      sanitized_metrics: {
        platform,
        real_native: realNative,
        native_backend: backend,
        backend_verified: runnerState === "PASS",
        provider_calls: 0,
        gate_closures: [],
        backend_decision: null,
      },
      unmet_prerequisites: runnerState === "PASS" ? [] : ["NATIVE_SERVICE_UNAVAILABLE"],
    },
    payloads: [
      { filename: "native-proof.json", content: { platform, passed: runnerState === "PASS" } },
    ],
  });

const createAllChildren = async (root) => {
  const records = {};
  for (const platform of platforms) {
    records[platform] = await createChild({ root, platform });
  }
  return records;
};

test("missing platform evidence blocks without running native operations", async () => {
  const root = await temporaryRoot();
  const execution = await runCredentialStorePlatforms({
    root,
    now: fixedNow,
    runId: "01K00000000000000000000010",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.deepEqual(execution.result.unmet_prerequisites, ["darwin", "linux", "win32"]);
  assert.equal(execution.result.sanitized_metrics.native_operations, 0);
  assert.equal(execution.result.sanitized_metrics.provider_calls, 0);
});

test("self-asserted native PASS artifacts remain blocked without platform attestation", async () => {
  const root = await temporaryRoot();
  await createAllChildren(root);
  const execution = await runCredentialStorePlatforms({
    root,
    now: fixedNow,
    runId: "01K00000000000000000000011",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.foundation_outcome, "BLOCKED");
  assert.equal(execution.result.candidate_outcome, "UNDECIDED");
  assert.equal(execution.result.reason_code, "ATTESTED_NATIVE_PLATFORM_EVIDENCE_UNAVAILABLE");
  assert.deepEqual(execution.result.unmet_prerequisites, ["native_platform_attestation"]);
  assert.deepEqual(Object.keys(execution.result.sanitized_metrics.platform_evidence), platforms);
  for (const platform of platforms) {
    const record = execution.result.sanitized_metrics.platform_evidence[platform];
    assert.equal(record.real_native, true);
    assert.equal(record.native_backend, backends[platform]);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(execution.result.sanitized_metrics.backend_decision, null);
  assert.deepEqual(execution.result.sanitized_metrics.gate_closures, []);
  await verifyEvidenceFile(execution.outputPath);
});

test("a PATH-injected fake verifier cannot produce attested aggregate evidence", async () => {
  const root = await temporaryRoot();
  const sourceDigest = await initializeTrustedRepository(root);
  const records = {};
  for (const platform of platforms) {
    records[platform] = await createChild({
      root,
      platform,
      gitCommit: sourceDigest,
      dirty: false,
    });
  }
  const fakeBin = await temporaryRoot();
  const invocationMarker = join(fakeBin, "gh-invoked");
  const fakeGh = join(root, ".tools/gh_2.97.0_linux_amd64/bin/gh");
  await mkdir(dirname(fakeGh), { recursive: true });
  await writeFile(
    fakeGh,
    `#!/bin/sh\nprintf 'verified\\n' >> '${invocationMarker}'\nexit 0\n`,
    "utf8",
  );
  await chmod(fakeGh, 0o700);
  const environmentNames = [
    "PATH",
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_REPOSITORY",
    "GITHUB_SHA",
    "GITHUB_REF",
  ];
  const previousEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  try {
    process.env["PATH"] = `${fakeBin}:${process.env["PATH"] ?? ""}`;
    process.env["GITHUB_ACTIONS"] = "true";
    process.env["RUNNER_ENVIRONMENT"] = "github-hosted";
    process.env["GITHUB_REPOSITORY"] = "example/ohmyhost";
    process.env["GITHUB_SHA"] = sourceDigest;
    process.env["GITHUB_REF"] = "refs/heads/main";
    await assert.rejects(
      runAttestedCredentialStorePlatforms({
        root,
        platformEvidence: Object.fromEntries(
          platforms.map((platform) => [platform, records[platform].outputPath]),
        ),
        repository: "example/ohmyhost",
        signerWorkflow: "example/ohmyhost/.github/workflows/phase1-native-keyring.yml",
        sourceDigest,
        sourceRef: "refs/heads/main",
        now: fixedNow,
        runId: "01K00000000000000000000014",
      }),
      /ATTESTATION_VERIFIER_INVALID/u,
    );
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }

  await assert.rejects(readFile(invocationMarker, "utf8"), /ENOENT/u);
});

test("explicit evidence paths work and a blocked native service remains blocked", async () => {
  const root = await temporaryRoot();
  const records = await createAllChildren(root);
  records.linux = await createChild({
    root,
    platform: "linux",
    runnerState: "BLOCKED_PREREQUISITE",
    runId: "01K00000000000000000000012",
  });
  const execution = await runCredentialStorePlatforms({
    root,
    platformEvidence: Object.fromEntries(
      platforms.map((platform) => [platform, records[platform].outputPath]),
    ),
    now: fixedNow,
    runId: "01K00000000000000000000013",
  });
  assert.equal(execution.result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(execution.result.reason_code, "NATIVE_PLATFORM_PREREQUISITE_BLOCKED");
  assert.deepEqual(execution.result.unmet_prerequisites, ["linux"]);
});

test("POSIX fallback, failed security checks, and invalid chronology fail closed", async () => {
  const cases = [
    {
      name: "POSIX fallback",
      overrides: { platform: "darwin", backend: "owner_only_file", realNative: false },
      reason: "INVALID_NATIVE_PLATFORM_EVIDENCE",
    },
    {
      name: "failed security",
      overrides: { platform: "linux", failedCheck: "security" },
      reason: "NATIVE_PLATFORM_CHECK_FAILED",
    },
    {
      name: "future evidence",
      overrides: { platform: "win32", finishedAt: "2026-08-18T13:00:00.000Z" },
      reason: "INVALID_NATIVE_PLATFORM_CHRONOLOGY",
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const root = await temporaryRoot();
    const records = await createAllChildren(root);
    records[testCase.overrides.platform] = await createChild({
      root,
      ...testCase.overrides,
      runId: `01K0000000000000000000002${index}`,
    });
    const execution = await runCredentialStorePlatforms({
      root,
      platformEvidence: Object.fromEntries(
        platforms.map((platform) => [platform, records[platform].outputPath]),
      ),
      now: fixedNow,
      runId: `01K0000000000000000000003${index}`,
    });
    assert.equal(execution.result.runner_state, "FAIL", testCase.name);
    assert.equal(execution.result.reason_code, testCase.reason, testCase.name);
  }
});

test("tampered child evidence fails aggregate verification", async () => {
  const root = await temporaryRoot();
  const records = await createAllChildren(root);
  await writeFile(records.darwin.outputPath, "{}\n", "utf8");
  const execution = await runCredentialStorePlatforms({
    root,
    platformEvidence: Object.fromEntries(
      platforms.map((platform) => [platform, records[platform].outputPath]),
    ),
    now: fixedNow,
    runId: "01K00000000000000000000040",
  });
  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "NATIVE_PLATFORM_EVIDENCE_INVALID");
});

test("direct CLI without arguments exits two and never performs native work", async () => {
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
  assert.equal(result.sanitized_metrics.native_operations, 0);
});
