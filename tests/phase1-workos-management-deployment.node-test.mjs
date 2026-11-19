import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";

import { createManagementRuntimeContract } from "../apps/workos-management/scripts/runtime-contract.mjs";
import { validateCandidateArtifact } from "../scripts/phase1-evidence-core.mjs";
import {
  parseWranglerDeployOutput,
  prepareWorkosManagementDeployment,
} from "../scripts/prepare-workos-management-deployment.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CORE_VERSION = "33333333-3333-4333-8333-333333333333";
const CORE_WORKER = "ohmyho-control-store-poc-private-fullstack";
// The only Control authority of the Worker is the environment's Core, bound through one service binding.
const receiptContract = {
  schemaVersion: 3,
  workerName: "ohmyhost-workos-management-sandbox",
  artifactSha256: "a".repeat(64),
  versionTag: "a".repeat(64),
  wranglerVersion: "4.125.0",
  uploadMode: "deploy-no-bundle",
  deployment: "development",
  controlRuntimeWorkerName: CORE_WORKER,
  controlRuntimeWorkerVersionId: CORE_VERSION,
  controlRuntimeEntrypoint: "WorkosRuntime",
};
const validInput = (output) => ({
  deployment: "development",
  controlRuntimeWorkerVersionId: CORE_VERSION,
  repositoryRoot,
  output,
  workerName: "ohmyhost-workos-management-sandbox",
  authkitDomain: "https://sandbox.authkit.app",
  connectApplicationId: "connect_app_00000000000000000000000003",
  connectClientId: "client_00000000000000000000000027",
});

test("deployment preparation binds the exact candidate bundle, version tag, and non-secret resources", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-workos-deployment-"));
  roots.push(parent);
  const output = join(parent, "deployment");
  const artifact = await validateCandidateArtifact(repositoryRoot);

  const prepared = await prepareWorkosManagementDeployment(validInput(output));
  assert.equal(prepared.artifactSha256, artifact.artifact_sha256);

  const configuration = JSON.parse(await readFile(join(output, "wrangler.jsonc"), "utf8"));
  assert.deepEqual(configuration, {
    name: "ohmyhost-workos-management-sandbox",
    main: "worker-main.js",
    compatibility_date: "2026-08-19",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    no_bundle: true,
    upload_source_maps: false,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    triggers: { crons: ["*/1 * * * *"] },
    vars: {
      MANAGEMENT_ARTIFACT_SHA256: artifact.artifact_sha256,
      WORKOS_AUTHKIT_DOMAIN: "https://sandbox.authkit.app",
      WORKOS_CONNECT_APPLICATION_ID: "connect_app_00000000000000000000000003",
      WORKOS_CONNECT_CLIENT_ID: "client_00000000000000000000000027",
      WORKOS_DEPLOYMENT: "development",
    },
    services: [{ binding: "CONTROL_RUNTIME", service: CORE_WORKER, entrypoint: "WorkosRuntime" }],
  });
  const contract = JSON.parse(await readFile(join(output, "deployment-contract.json"), "utf8"));
  const runtime = createManagementRuntimeContract();
  assert.deepEqual(contract, {
    ...receiptContract,
    artifactSha256: artifact.artifact_sha256,
    versionTag: artifact.artifact_sha256,
    requiredSecretBindings: ["WORKOS_CONNECT_CLIENT_SECRET", "WORKOS_MANAGEMENT_CREDENTIAL"],
    expectedRuntimeBindings: ["CF_VERSION_METADATA", "CONTROL_RUNTIME"],
    scheduledTriggers: ["*/1 * * * *"],
    snapshotDeadlineMs: 20_000,
    expectedVars: configuration.vars,
    forbiddenRuntimeBindings: runtime.forbiddenBindings,
    forbiddenRuntimeBindingPatterns: runtime.forbiddenBindingPatterns,
    forbiddenRuntimeBindingTypes: runtime.forbiddenBindingTypes,
    requiredFunctionalProbe: "workos-control-profile/v3",
  });
  assert.equal(
    await readFile(join(output, "worker-main.js"), "utf8"),
    await readFile(
      join(repositoryRoot, "apps/workos-management/dist/worker-bundle/worker-main.js"),
      "utf8",
    ),
  );
  const serialized = `${await readFile(join(output, "wrangler.jsonc"), "utf8")}${await readFile(
    join(output, "deployment-contract.json"),
    "utf8",
  )}`;
  assert.doesNotMatch(serialized, /WORKOS_(?:API|MANAGEMENT)_KEY|sk_[A-Za-z0-9]/u);

  const dryRun = spawnSync(
    "pnpm",
    [
      "--filter",
      "@ohmyhost/control-api",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      join(output, "wrangler.jsonc"),
      "--no-bundle",
      "--tag",
      artifact.artifact_sha256,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /wrangler 4\.125\.0/u);
  assert.match(dryRun.stdout, /CF_VERSION_METADATA/u);
  assert.match(dryRun.stdout, /CONTROL_RUNTIME/u);
  assert.doesNotMatch(dryRun.stdout, /D1 Database/u);
  assert.match(dryRun.stdout, /MANAGEMENT_ARTIFACT_SHA256/u);
  assert.doesNotMatch(
    `${dryRun.stdout}${dryRun.stderr}`,
    /WORKOS_CONNECT_CLIENT_SECRET|WORKOS_MANAGEMENT_CREDENTIAL|sk_[A-Za-z0-9]/u,
  );
});

test("the Core binding follows the environment and only the observed Core version can be named", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-workos-deployment-core-"));
  roots.push(parent);
  const output = join(parent, "production");
  await prepareWorkosManagementDeployment({
    ...validInput(output),
    deployment: "production",
    workerName: "ohmyhost-workos-management-production",
  });
  const configuration = JSON.parse(await readFile(join(output, "wrangler.jsonc"), "utf8"));
  assert.deepEqual(configuration.services, [
    {
      binding: "CONTROL_RUNTIME",
      service: "ohmyho-control-store-production",
      entrypoint: "WorkosRuntime",
    },
  ]);
  for (const extra of [
    { deployment: undefined },
    { deployment: "staging" },
    { controlRuntimeWorkerVersionId: undefined },
    { controlRuntimeWorkerVersionId: "not-a-uuid" },
    { controlRuntimeWorkerName: "another-core" },
  ])
    await assert.rejects(
      prepareWorkosManagementDeployment({
        ...validInput(join(parent, `invalid-${Math.random()}`)),
        ...extra,
      }),
      /INVALID_WORKOS_MANAGEMENT_DEPLOYMENT/u,
    );
});

test("deployment preparation rejects in-repository output, unsafe domains and unknown inputs", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-workos-deployment-invalid-"));
  roots.push(parent);
  const invalidInputs = [
    { output: join(repositoryRoot, "deployment-output") },
    { output: join(parent, "unknown"), unknownOption: "value" },
    { output: join(parent, "host"), authkitDomain: "https://attacker.example" },
    { output: join(parent, "path"), authkitDomain: "https://sandbox.authkit.app/path" },
    { output: join(parent, "worker"), workerName: "../../worker" },
    { output: join(parent, "client"), connectClientId: "client with spaces" },
  ];
  for (const overrides of invalidInputs) {
    await assert.rejects(
      prepareWorkosManagementDeployment({ ...validInput(overrides.output), ...overrides }),
      /INVALID_WORKOS_MANAGEMENT_DEPLOYMENT/u,
    );
  }
});

test("deployment receipt binds Cloudflare deployment and version IDs to the candidate tag", () => {
  const contract = receiptContract;
  const receipt = parseWranglerDeployOutput(
    `${JSON.stringify({
      type: "wrangler-session",
      version: 1,
      wrangler_version: "4.125.0",
      timestamp: "2026-08-19T12:00:00.000Z",
    })}\n${JSON.stringify({
      type: "worker-deploy",
      version: 1,
      worker_name: contract.workerName,
      worker_tag: contract.versionTag,
      deployment_id: "195f00a7-23a7-43b7-a227-e4c97cab5f22",
      version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      preview_url: null,
      preview_alias_url: null,
      worker_name_overridden: false,
      timestamp: "2026-08-19T12:01:00.000Z",
    })}\n`,
    contract,
  );
  assert.deepEqual(receipt, {
    schemaVersion: 3,
    workerName: contract.workerName,
    artifactSha256: contract.artifactSha256,
    versionTag: contract.versionTag,
    cloudflareDeploymentId: "195f00a7-23a7-43b7-a227-e4c97cab5f22",
    cloudflareWorkerVersionId: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
    deployedAt: "2026-08-19T12:01:00.000Z",
    deployment: "development",
    controlRuntimeWorkerName: CORE_WORKER,
    controlRuntimeWorkerVersionId: CORE_VERSION,
    controlRuntimeEntrypoint: "WorkosRuntime",
  });
  // Only the current contract version is a receipt contract.
  assert.throws(
    () => parseWranglerDeployOutput("{}\n", { ...contract, schemaVersion: 2 }),
    /INVALID_WORKOS_MANAGEMENT_VERSION_RECEIPT/u,
  );
});

test("deployment receipt rejects failure, duplicate, worker, tag, and identity spoofing", () => {
  const contract = receiptContract;
  const valid = {
    type: "worker-deploy",
    version: 1,
    worker_name: contract.workerName,
    worker_tag: contract.versionTag,
    deployment_id: "195f00a7-23a7-43b7-a227-e4c97cab5f22",
    version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
    worker_name_overridden: false,
    timestamp: "2026-08-19T12:01:00.000Z",
  };
  for (const records of [
    [{ type: "command-failed", version: 1, timestamp: valid.timestamp }],
    [valid, valid],
    [{ ...valid, worker_name: "attacker-worker" }],
    [{ ...valid, worker_tag: "b".repeat(64) }],
    [{ ...valid, version_id: "spoofed" }],
    [{ ...valid, deployment_id: "spoofed" }],
    [{ ...valid, worker_name_overridden: true }],
  ]) {
    assert.throws(
      () =>
        parseWranglerDeployOutput(
          `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
          contract,
        ),
      /INVALID_WORKOS_MANAGEMENT_VERSION_RECEIPT/u,
    );
  }
});

test("version receipt CLI emits only the sanitized deployable identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-workos-version-receipt-"));
  roots.push(root);
  const contractPath = join(root, "deployment-contract.json");
  const outputPath = join(root, "wrangler.ndjson");
  await writeFile(contractPath, JSON.stringify(receiptContract));
  await writeFile(
    outputPath,
    `${JSON.stringify({
      type: "wrangler-session",
      version: 1,
      wrangler_version: "4.125.0",
      command_line_args: ["deploy"],
      log_file_path: "/private/path/that-must-not-survive.log",
      timestamp: "2026-08-19T12:00:00.000Z",
    })}\n${JSON.stringify({
      type: "worker-deploy",
      version: 1,
      worker_name: "ohmyhost-workos-management-sandbox",
      worker_tag: "a".repeat(64),
      deployment_id: "195f00a7-23a7-43b7-a227-e4c97cab5f22",
      version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      preview_url: null,
      preview_alias_url: null,
      worker_name_overridden: false,
      timestamp: "2026-08-19T12:01:00.000Z",
    })}\n`,
  );
  const execution = spawnSync(
    process.execPath,
    [
      "scripts/parse-workos-management-version-receipt.mjs",
      "--wrangler-output",
      outputPath,
      "--deployment-contract",
      contractPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(Object.keys(JSON.parse(execution.stdout)).sort(), [
    "artifactSha256",
    "cloudflareDeploymentId",
    "cloudflareWorkerVersionId",
    "controlRuntimeEntrypoint",
    "controlRuntimeWorkerName",
    "controlRuntimeWorkerVersionId",
    "deployedAt",
    "deployment",
    "schemaVersion",
    "versionTag",
    "workerName",
  ]);
  assert.doesNotMatch(execution.stdout, /\/private\/|log_file_path|command_line_args/u);
});
