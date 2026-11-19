/* global Buffer, Response */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  parseCapabilityProducerArguments,
  runCapabilityProducer,
} from "../scripts/phase1-auth-preflight-capability-producer.mjs";

const roots = [];
const fixedNow = () => new Date("2026-08-19T12:20:00.000Z");
const observations = [
  { id: "authkit_oidc_metadata", available: true, statusCode: 200 },
  { id: "connect_applications_read", available: true, count: 1, statusCode: 200 },
  {
    id: "connect_client_secrets_metadata_read",
    available: true,
    count: 1,
    statusCode: 200,
  },
  { id: "fga_resources_read", available: false, count: 0, statusCode: 403 },
  { id: "memberships_read", available: true, count: 1, statusCode: 200 },
  { id: "m2m_token_flow", available: true, statusCode: 200 },
  { id: "organizations_read", available: true, count: 1, statusCode: 200 },
  { id: "webhook_endpoints_read", available: true, count: 1, statusCode: 200 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const write = async (root, path, content) => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const createArtifact = async (root) => {
  const sources = {
    "dist/index.js": "export {};\n",
    "dist/worker-bundle/README.md": "deterministic worker bundle\n",
    "dist/worker-bundle/worker-main.js": "export {};\n",
    "dist/worker-bundle/metafile.json": "{}\n",
    "dist/runtime/runtime-contract.json": `${JSON.stringify(createManagementRuntimeContract())}\n`,
    "dist/runtime/wrangler.jsonc":
      '{"main":"src/worker-main.ts","workers_dev":false,"preview_urls":false}\n',
    "dist/sandbox-main.js":
      'const digest = process.argv[3]; process.stdout.write(`${JSON.stringify({schema_version:"workos-management-sandbox-self-test-v1",artifact_sha256:digest,components:{resolver:"configured",transport:"read_only",rpc:"authenticated"}})}\\n`);\n',
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
  const artifactSha256 = sha256(frame);
  await write(
    root,
    "apps/workos-management/dist/candidate-artifact.json",
    `${JSON.stringify({
      schemaVersion: 2,
      artifact: "workos-management",
      deploymentPolicy: "service-binding-only",
      entrypoint: "dist/sandbox-main.js",
      runtimeEntrypoint: "dist/worker-bundle/worker-main.js",
      runtimeContract: "dist/runtime/runtime-contract.json",
      files: records,
      artifactSha256,
    })}\n`,
  );
  return artifactSha256;
};

const commitFixture = async (root) => {
  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Capability Producer Test"],
    ["config", "user.email", "capability-producer@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-capability-producer-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "ohmyhost-capability-evidence-"));
  roots.push(root, evidenceRoot);
  const artifactSha256 = await createArtifact(root);
  const gitCommit = await commitFixture(root);
  const worktreeDigest = await createWorktreeDigest(root);
  const p1a = await writeEvidence({
    root: evidenceRoot,
    runId: "01M00000000000000000000001",
    filename: "p1a-local.json",
    result: {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      scope: "phase1_p1a_local",
      runner_state: "PASS",
      foundation_outcome: "BLOCKED",
      candidate_outcome: "UNDECIDED",
      reason_code: "P1A_LOCAL_VERIFICATION_PASSED",
      command: "pnpm phase1:p1a",
      git_commit: gitCommit,
      run_id: "01M00000000000000000000001",
      worktree_digest: worktreeDigest,
      dirty: false,
      started_at: "2026-08-19T12:00:00.000Z",
      finished_at: "2026-08-19T12:10:00.000Z",
      checks: [],
      sanitized_metrics: {
        provider_calls: 0,
        provider_credentials_resolved: 0,
        management_artifact_sha256: artifactSha256,
        gate_closures: [],
        backend_decision: null,
      },
      unmet_prerequisites: ["P1B_PROVIDER_MEASUREMENT"],
    },
  });
  return { root, artifactSha256, gitCommit, worktreeDigest, p1a };
};

const workerVersionId = "095f00a7-23a7-43b7-a227-e4c97cab5f22";

const probeResponse = (artifactSha256, extra = {}, headers = {}) =>
  new Response(
    JSON.stringify({
      method: "capabilities.probe_read_only",
      requestId: "capability-producer",
      ok: true,
      result: { observations },
      ...extra,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ohmyhost-management-artifact-sha256": artifactSha256,
        "x-ohmyhost-cloudflare-version-id": workerVersionId,
        "x-ohmyhost-cloudflare-version-tag": artifactSha256,
        ...headers,
      },
    },
  );

test("capability producer binds a clean P1A artifact to one loopback private-worker probe", async () => {
  const { root, artifactSha256, gitCommit, worktreeDigest, p1a } = await fixture();
  const calls = [];
  const execution = await runCapabilityProducer({
    root,
    p1a: p1a.outputPath,
    endpoint: "http://127.0.0.1:8787/probe",
    now: fixedNow,
    runId: "01M00000000000000000000002",
    probe: async (input) => {
      calls.push(input);
      return probeResponse(artifactSha256);
    },
  });

  assert.equal(execution.result.runner_state, "PASS");
  assert.equal(execution.result.reason_code, "CAPABILITY_MEASUREMENT_PASSED");
  assert.equal(execution.result.git_commit, gitCommit);
  assert.equal(execution.result.worktree_digest, worktreeDigest);
  assert.equal(execution.result.dirty, false);
  assert.equal(execution.result.sanitized_metrics.provider_calls, 8);
  assert.equal(execution.result.sanitized_metrics.provider_credentials_resolved, 2);
  assert.equal(execution.result.sanitized_metrics.observations.length, 8);
  assert.equal(execution.result.sanitized_metrics.management_artifact_sha256, artifactSha256);
  assert.equal(execution.result.sanitized_metrics.cloudflare_worker_version_id, workerVersionId);
  assert.equal(
    execution.result.sanitized_metrics.subordinate_evidence.sha256,
    sha256(p1a.serialized),
  );
  assert.deepEqual(calls, [
    {
      endpoint: "http://127.0.0.1:8787/probe",
      requestId: "capability-producer",
      timeoutMs: 10_000,
      maximumBytes: 65_536,
    },
  ]);
  await verifyEvidenceFile(execution.outputPath);
});

test("capability producer measures through its bounded loopback HTTP transport", async () => {
  const { root, artifactSha256, p1a } = await fixture();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    const body = JSON.stringify({
      method: "capabilities.probe_read_only",
      requestId: "capability-producer",
      ok: true,
      result: { observations },
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "x-ohmyhost-management-artifact-sha256": artifactSha256,
      "x-ohmyhost-cloudflare-version-id": workerVersionId,
      "x-ohmyhost-cloudflare-version-tag": artifactSha256,
    });
    response.end(body);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const execution = await runCapabilityProducer({
      root,
      p1a: p1a.outputPath,
      endpoint: `http://127.0.0.1:${address.port}/probe`,
      now: fixedNow,
      runId: "01M00000000000000000000003",
    });
    assert.equal(execution.result.runner_state, "PASS");
    assert.deepEqual(requests, [{ method: "POST", url: "/probe" }]);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  }
});

test("capability producer rejects remote endpoints and remote artifact or response spoofing", async () => {
  assert.throws(
    () =>
      parseCapabilityProducerArguments([
        "--endpoint",
        "https://attacker.example/probe",
        "--p1a",
        "proof/p1a-local.json",
      ]),
    /INVALID_CAPABILITY_PRODUCER_ENDPOINT/u,
  );
  assert.throws(
    () =>
      parseCapabilityProducerArguments([
        "--endpoint",
        "http://localhost:8787/probe",
        "--p1a",
        "proof/p1a-local.json",
      ]),
    /INVALID_CAPABILITY_PRODUCER_ENDPOINT/u,
  );

  const { root, artifactSha256, p1a } = await fixture();
  for (const response of [
    probeResponse("f".repeat(64)),
    probeResponse(artifactSha256, { secret: "must-not-persist" }),
    probeResponse(artifactSha256, {}, { "x-ohmyhost-cloudflare-version-id": "spoofed" }),
    probeResponse(artifactSha256, {}, { "x-ohmyhost-cloudflare-version-tag": "f".repeat(64) }),
  ]) {
    const execution = await runCapabilityProducer({
      root,
      p1a: p1a.outputPath,
      endpoint: "http://127.0.0.1:8787/probe",
      now: fixedNow,
      runId: `01M0000000000000000000000${roots.length}`,
      probe: async () => response,
    });
    assert.equal(execution.result.runner_state, "FAIL");
    assert.equal(
      (await readFile(execution.outputPath, "utf8")).includes("must-not-persist"),
      false,
    );
  }
});

test("capability producer refuses dirty or mismatched source state before provider access", async () => {
  const { root, artifactSha256, p1a } = await fixture();
  await write(root, "untracked.txt", "dirty\n");
  let calls = 0;
  const execution = await runCapabilityProducer({
    root,
    p1a: p1a.outputPath,
    endpoint: "http://127.0.0.1:8787/probe",
    now: fixedNow,
    runId: "01M00000000000000000000009",
    probe: async () => {
      calls += 1;
      return probeResponse(artifactSha256);
    },
  });

  assert.equal(execution.result.runner_state, "FAIL");
  assert.equal(execution.result.reason_code, "CAPABILITY_PRODUCER_WORKTREE_MISMATCH");
  assert.equal(calls, 0);
});
