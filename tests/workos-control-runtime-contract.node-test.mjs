/* global Request, Response, structuredClone */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
  createManagementRuntimeContract,
  isManagementRuntimeContract,
} from "../apps/workos-management/scripts/runtime-contract.mjs";
import probe from "../.github/scripts/phase1-workos-capability-probe.mjs";
import {
  parseWranglerDeployOutput,
  prepareWorkosManagementDeployment,
  verifyWorkosManagementD1Convergence,
} from "../scripts/prepare-workos-management-deployment.mjs";

const root = resolve(import.meta.dirname, "..");
const directories = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
const input = (output) => ({
  repositoryRoot: root,
  output,
  workerName: "ohmyhost-workos-d1-development",
  authkitDomain: "https://sandbox.authkit.app",
  connectApplicationId: "connect_app_00000000000000000000000003",
  connectClientId: "client_00000000000000000000000027",
  deployment: "development",
  controlRuntimeWorkerVersionId: ids.core,
});
const ids = {
  version: "11111111-1111-4111-8111-111111111111",
  deployment: "22222222-2222-4222-8222-222222222222",
  core: "44444444-4444-4444-8444-444444444444",
};
const deployLog = (contract) =>
  [
    {
      type: "wrangler-session",
      version: 1,
      wrangler_version: contract.wranglerVersion,
      timestamp: "2026-10-28T10:00:00.000Z",
    },
    {
      type: "worker-deploy",
      version: 1,
      worker_name: contract.workerName,
      worker_tag: contract.versionTag,
      version_id: ids.version,
      deployment_id: ids.deployment,
      worker_name_overridden: false,
      timestamp: "2026-10-28T10:00:01.000Z",
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");

async function prepared() {
  const parent = await mkdtemp(join(tmpdir(), "omh-workos-d1-contract-"));
  directories.push(parent);
  const output = join(parent, "prepared");
  await prepareWorkosManagementDeployment(input(output));
  return {
    output,
    configuration: JSON.parse(await readFile(join(output, "wrangler.jsonc"), "utf8")),
    contract: JSON.parse(await readFile(join(output, "deployment-contract.json"), "utf8")),
  };
}

test("the runtime contract is one closed Core service-binding capability", () => {
  const current = createManagementRuntimeContract();
  assert.equal(isManagementRuntimeContract(current), true);
  assert.equal(current.schemaVersion, 3);
  assert.equal(current.serviceBinding.entrypoint, "WorkosRuntime");
  assert.deepEqual(current.forbiddenBindingTypes, ["d1"]);
  for (const value of [null, {}, { ...current, unknown: true }, { ...current, schemaVersion: 2 }])
    assert.equal(isManagementRuntimeContract(value), false);
  for (const mutate of [
    (value) => (value.serviceBinding.entrypoint = "ControlRuntime"),
    (value) => (value.forbiddenBindingTypes = []),
    (value) => value.requiredBindings.push("UNLISTED_BINDING"),
  ]) {
    const changed = structuredClone(current);
    mutate(changed);
    assert.equal(isManagementRuntimeContract(changed), false);
  }
});

test("D1 preparation requires the qualified capability and the environment's Core binding and parses exact deployment versions", async () => {
  const { configuration, contract, output } = await prepared();
  assert.equal(configuration.vars.WORKOS_DEPLOYMENT, "development");
  assert.deepEqual(configuration.services, [
    {
      binding: "CONTROL_RUNTIME",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "WorkosRuntime",
    },
  ]);
  assert.equal(configuration.d1_databases, undefined);
  assert.equal(configuration.workers_dev, false);
  assert.equal(configuration.preview_urls, false);
  assert.equal(contract.schemaVersion, 3);
  assert.equal(contract.requiredFunctionalProbe, "workos-control-profile/v3");
  assert.deepEqual(contract.forbiddenRuntimeBindingTypes, ["d1"]);
  const receipt = parseWranglerDeployOutput(deployLog(contract), contract);
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.controlRuntimeEntrypoint, "WorkosRuntime");
  assert.equal(receipt.cloudflareWorkerVersionId, ids.version);
  for (const changed of [
    { ...contract, controlRuntimeEntrypoint: "ControlRuntime" },
    { ...contract, controlRuntimeWorkerName: "https://bad.invalid" },
    { ...contract, deployment: "other" },
  ])
    assert.throws(() => parseWranglerDeployOutput(deployLog(contract), changed));
  const parent = await mkdtemp(join(tmpdir(), "omh-workos-cli-contract-"));
  directories.push(parent);
  const cliOutput = join(parent, "cli-d1");
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/prepare-workos-management-deployment.mjs",
      "--root",
      root,
      "--output",
      cliOutput,
      "--worker-name",
      "ohmyhost-workos-d1-cli",
      "--authkit-domain",
      "https://sandbox.authkit.app",
      "--connect-application-id",
      input(cliOutput).connectApplicationId,
      "--connect-client-id",
      input(cliOutput).connectClientId,
      "--control-runtime-version",
      ids.core,
      "--deployment",
      "development",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ...(process.env.NODE_V8_COVERAGE === undefined
          ? {}
          : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }),
      },
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.deepEqual(Object.keys(JSON.parse(cli.stdout)), ["artifact_sha256"]);
  assert.equal(
    JSON.parse(await readFile(join(cliOutput, "deployment-contract.json"), "utf8"))
      .controlRuntimeWorkerVersionId,
    ids.core,
  );
  for (const extra of [
    { deployment: "other" },
    { deployment: undefined },
    { controlRuntimeWorkerVersionId: "bad" },
    { controlRuntimeWorkerName: "core" },
  ])
    await assert.rejects(() =>
      prepareWorkosManagementDeployment({
        ...input(join(parent, `invalid-${Math.random()}`)),
        ...extra,
      }),
    );
  await assert.rejects(() => prepareWorkosManagementDeployment(input(output)));
});

test("convergence requires an actual redacted profile call plus private exact-version CF settings and refuses metadata-only or direct database authority", async () => {
  const { contract } = await prepared(),
    receipt = parseWranglerDeployOutput(deployLog(contract), contract);
  const request = {
    userId: "user_probe_owner",
    sessionId: "session_probe_owner",
    artifactSha256: contract.artifactSha256,
    versionId: ids.version,
    deployment: "development",
  };
  let calls = 0;
  const profile = {
    user_id: request.userId,
    workos_organization_ids: ["org_owned"],
    name: "Private owner",
    email: "private@example.test",
    email_verified: true,
  };
  const headers = {
    "content-type": "application/json",
    "x-ohmyhost-management-artifact-sha256": contract.artifactSha256,
    "x-ohmyhost-cloudflare-version-id": ids.version,
    "x-ohmyhost-cloudflare-version-tag": contract.artifactSha256,
    "x-ohmyhost-workos-deployment": "development",
  };
  const transport = {
    fetch: async (message) => {
      calls++;
      assert.equal(message.url, "https://workos-management.internal/user-profile");
      assert.deepEqual(await message.json(), {
        userId: request.userId,
        sessionId: request.sessionId,
      });
      return Response.json(profile, { headers });
    },
  };
  const response = await probe.fetch(
    new Request("http://127.0.0.1/control-probe", {
      method: "POST",
      body: JSON.stringify(request),
    }),
    { WORKOS_MANAGEMENT: transport },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const proof = await response.json();
  assert.equal(proof.state, "verified");
  assert.equal(proof.kind, "workos-control-profile/v3");
  for (const privateValue of [request.userId, profile.email, profile.name, "org_owned"])
    assert.ok(!JSON.stringify(proof).includes(privateValue));
  const actual = {
    workerName: contract.workerName,
    observedAt: new Date(Date.now() + 1000).toISOString(),
    deployment: { id: ids.deployment, versions: [{ version_id: ids.version, percentage: 100 }] },
    controlWorkerName: contract.controlRuntimeWorkerName,
    controlDeployment: { versions: [{ version_id: ids.core, percentage: 100 }] },
    subdomain: { enabled: false, previews_enabled: false },
    routes: [],
    customDomains: [],
    settings: {
      compatibility_date: "2026-08-19",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { name: "CF_VERSION_METADATA", type: "version_metadata" },
        {
          name: "CONTROL_RUNTIME",
          type: "service",
          service: contract.controlRuntimeWorkerName,
          entrypoint: "WorkosRuntime",
        },
        ...Object.entries(contract.expectedVars).map(([name, text]) => ({
          name,
          text,
          type: "plain_text",
        })),
        ...contract.requiredSecretBindings.map((name) => ({ name, type: "secret_text" })),
      ],
    },
    probe: proof,
  };
  assert.equal(
    verifyWorkosManagementD1Convergence(actual, contract, receipt).cloudflareWorkerVersionId,
    ids.version,
  );
  const failures = [
    (value) => delete value.probe,
    (value) => (value.probe.state = "configuration_only"),
    (value) => (value.probe.kind = "workos-control-profile/v2"),
    (value) => (value.probe.observedAt = "2026-10-28T09:00:00.000Z"),
    (value) =>
      (value.deployment.versions = [
        { version_id: ids.version, percentage: 50 },
        { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
      ]),
    (value) => value.settings.bindings.push({ name: "UNLISTED_SECRET_ALIAS", type: "secret_text" }),
    (value) =>
      value.settings.bindings.push({
        name: "CONTROL_STORAGE_PROVIDER",
        type: "plain_text",
        text: "d1",
      }),
    (value) => value.settings.bindings.push({ name: "ANY_DATABASE", type: "d1", id: "raw" }),
    (value) =>
      value.settings.bindings.push({ name: "CONTROL_SHARD_0000", type: "plain_text", text: "raw" }),
    (value) =>
      value.settings.bindings.push({ name: "CONTROL_RUNTIME", type: "service", service: "other" }),
    (value) =>
      (value.settings.bindings.find((x) => x.name === "CONTROL_RUNTIME").entrypoint =
        "ControlRuntime"),
    (value) =>
      (value.settings.bindings.find((x) => x.name === "CONTROL_RUNTIME").environment = "other"),
    (value) =>
      (value.settings.bindings = value.settings.bindings.filter(
        (x) => x.name !== "WORKOS_MANAGEMENT_CREDENTIAL",
      )),
    (value) =>
      (value.controlDeployment.versions = [
        { version_id: ids.core, percentage: 50 },
        { version_id: ids.version, percentage: 50 },
      ]),
    (value) => (value.subdomain.enabled = true),
    (value) => (value.routes = [{ pattern: "public.example/*" }]),
    (value) => (value.customDomains = [{ hostname: "public.example" }]),
  ];
  for (const mutate of failures) {
    const changed = structuredClone(actual);
    mutate(changed);
    assert.throws(
      () => verifyWorkosManagementD1Convergence(changed, contract, receipt),
      /CONVERGENCE_UNVERIFIED/u,
    );
  }
  for (const body of [{}, { ...profile, user_id: "user_wrong" }]) {
    const failed = await probe.fetch(
      new Request("http://127.0.0.1/control-probe", {
        method: "POST",
        body: JSON.stringify(request),
      }),
      { WORKOS_MANAGEMENT: { fetch: async () => Response.json(body, { headers }) } },
    );
    assert.equal(failed.status, 503);
  }
  const staleVersion = await probe.fetch(
    new Request("http://127.0.0.1/control-probe", {
      method: "POST",
      body: JSON.stringify(request),
    }),
    {
      WORKOS_MANAGEMENT: {
        fetch: async () =>
          Response.json(profile, {
            headers: {
              ...headers,
              "x-ohmyhost-cloudflare-version-id": "33333333-3333-4333-8333-333333333333",
            },
          }),
      },
    },
  );
  assert.equal(staleVersion.status, 503);
  assert.equal(
    (
      await probe.fetch(
        new Request("http://127.0.0.1/control-probe", { method: "POST", body: "{}" }),
        {},
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await probe.fetch(
        new Request("http://127.0.0.1/control-probe", {
          method: "POST",
          body: JSON.stringify(request),
        }),
        {},
      )
    ).status,
    503,
  );
});
