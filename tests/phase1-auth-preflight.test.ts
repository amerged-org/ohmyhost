import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repositoryRoot, "scripts/phase1-auth-preflight-names.mjs");
const requiredNames = [
  "WORKOS_AUTHKIT_CLIENT_ID",
  "WORKOS_AUTHKIT_DOMAIN",
  "WORKOS_CONNECT_APPLICATION_ID",
  "WORKOS_CONNECT_CLIENT_ID",
  "WORKOS_CONNECT_CLIENT_SECRET_REF",
  "WORKOS_MANAGEMENT_API_KEY_REF",
  "WORKOS_WEBHOOK_SECRET_REF",
] as const;
const configuredAliases = [
  "WORKOS_CLIENT_ID",
  "WORKOS_AUTHKIT_DOMAIN",
  "WORKOS_CONNECT_APPLICATION_ID",
  "WORKOS_CONNECT_CLIENT_ID",
  "WORKOS_CONNECT_CLIENT_SECRET",
  "WORKOS_API_KEY",
  "WORKOS_WEBHOOK_SECRET",
] as const;
const temporaryDirectories: string[] = [];

type PreflightResult = {
  schema_version: string;
  scope: string;
  runner_state: "PASS" | "BLOCKED_PREREQUISITE" | "FAIL";
  foundation_outcome: "READY" | "BLOCKED";
  candidate_outcome: "FGA_ELIGIBLE" | "LOCAL_GRANTS_REQUIRED" | "UNDECIDED";
  reason_code: string;
  command: string;
  git_commit: string | null;
  run_id: string;
  worktree_digest: string;
  dirty: boolean;
  started_at: string;
  finished_at: string;
  checks: Array<{
    id: string;
    state: string;
    duration_ms: number;
    evidence_ref: string;
  }>;
  sanitized_metrics: {
    inventory_schema_version: string;
    configuration_names: Array<{ name: string; present: boolean }>;
    present_count: number;
    required_count: number;
  };
  unmet_prerequisites: string[];
  evidence_artifacts: unknown[];
  evidence_manifest_sha256: string;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const createTemporaryDirectory = async () => {
  const path = await mkdtemp(join(tmpdir(), "ohmyhost-phase1-preflight-"));
  temporaryDirectories.push(path);
  return path;
};

const runPreflight = async ({
  environmentNames = [],
  envFile,
}: {
  environmentNames?: readonly string[];
  envFile?: string;
}) => {
  const root = await createTemporaryDirectory();
  const output = join(root, "evidence", "auth-preflight-names.json");
  const arguments_ = [runnerPath, "--root", root, "--output", output];

  if (envFile !== undefined) {
    const envFilePath = join(root, ".env.local");
    await writeFile(envFilePath, envFile, "utf8");
    arguments_.push("--env-file", envFilePath);
  }

  const environment: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
  };
  for (const name of environmentNames) {
    environment[name] = "must-not-appear-in-output";
  }

  const execution = spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  const result = JSON.parse(await readFile(output, "utf8")) as PreflightResult;

  return { execution, result, serialized: JSON.stringify(result) };
};

test("an absent environment file reports every required name as an unmet prerequisite", async () => {
  const { execution, result } = await runPreflight({});

  assert.equal(execution.status, 2);
  assert.equal(execution.stderr, "");
  assert.equal(result.runner_state, "BLOCKED_PREREQUISITE");
  assert.equal(result.foundation_outcome, "BLOCKED");
  assert.equal(result.candidate_outcome, "UNDECIDED");
  assert.deepEqual(result.unmet_prerequisites, requiredNames);
  assert.deepEqual(
    result.sanitized_metrics.configuration_names,
    requiredNames.map((name) => ({ name, present: false })),
  );
});

test("a partial inventory reports only missing names and never exposes values", async () => {
  const secretValues = [
    "authkit-client-secret-material",
    "domain-secret-material",
    "broad-key-secret-material",
    "webhook-secret-material",
  ];
  const envFile = [
    `WORKOS_CLIENT_ID=${secretValues[0]}`,
    `WORKOS_AUTHKIT_DOMAIN=${secretValues[1]}`,
    `WORKOS_API_KEY=${secretValues[2]}`,
    `WORKOS_WEBHOOK_SECRET=${secretValues[3]}`,
  ].join("\n");
  const { execution, result, serialized } = await runPreflight({ envFile });

  assert.equal(execution.status, 2);
  assert.deepEqual(result.unmet_prerequisites, [
    "WORKOS_CONNECT_APPLICATION_ID",
    "WORKOS_CONNECT_CLIENT_ID",
    "WORKOS_CONNECT_CLIENT_SECRET_REF",
  ]);
  for (const value of [...secretValues, "forbidden-broad-key-value"]) {
    assert.doesNotMatch(serialized, new RegExp(value, "u"));
    assert.doesNotMatch(execution.stdout, new RegExp(value, "u"));
    assert.doesNotMatch(execution.stderr, new RegExp(value, "u"));
  }
  assert.doesNotMatch(serialized, /WORKOS_API_KEY/u);
});

test("name presence alone passes the inventory without deciding the authorization backend", async () => {
  const envFile = configuredAliases.map((name) => `${name}=`).join("\n");
  const { execution, result } = await runPreflight({ envFile });

  assert.equal(execution.status, 0);
  assert.equal(result.runner_state, "PASS");
  assert.equal(result.foundation_outcome, "BLOCKED");
  assert.equal(result.candidate_outcome, "UNDECIDED");
  assert.equal(result.reason_code, "CONFIGURATION_NAMES_PRESENT");
  assert.deepEqual(result.unmet_prerequisites, []);
  assert.equal(result.run_id.length, 26);
  assert.match(result.run_id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.match(result.worktree_digest, /^[a-f0-9]{64}$/u);
  assert.equal(result.git_commit, null);
  assert.equal(result.dirty, true);
  assert.deepEqual(result.evidence_artifacts, []);
  assert.match(result.evidence_manifest_sha256, /^[a-f0-9]{64}$/u);
});

test("process environment aliases are merged without reading the broad API key value", async () => {
  const { execution, result, serialized } = await runPreflight({
    environmentNames: configuredAliases,
  });

  assert.equal(execution.status, 0);
  assert.equal(result.sanitized_metrics.present_count, requiredNames.length);
  assert.doesNotMatch(serialized, /must-not-appear-in-output|forbidden-broad-key-value/u);
  assert.doesNotMatch(serialized, /WORKOS_API_KEY/u);
});

test("role-specific reference aliases remain accepted", async () => {
  const { execution, result } = await runPreflight({ environmentNames: requiredNames });

  assert.equal(execution.status, 0);
  assert.equal(result.runner_state, "PASS");
  assert.deepEqual(
    result.sanitized_metrics.configuration_names,
    requiredNames.map((name) => ({ name, present: true })),
  );
});

test("the preflight has no network implementation surface", async () => {
  const source = await readFile(runnerPath, "utf8");

  assert.doesNotMatch(source, /node:(?:http|https|http2|net|tls|dns)/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /process\.env\s*\[\s*["']WORKOS_API_KEY["']\s*\]/u);
});

test("the output directory may be created by the runner", async () => {
  const root = await createTemporaryDirectory();
  const output = join(root, "nested", "evidence", "auth-preflight-names.json");
  await mkdir(root, { recursive: true });

  const execution = spawnSync(process.execPath, [runnerPath, "--root", root, "--output", output], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] },
  });

  assert.equal(execution.status, 2);
  const result = JSON.parse(await readFile(output, "utf8")) as PreflightResult;
  assert.equal(result.runner_state, "BLOCKED_PREREQUISITE");
});
