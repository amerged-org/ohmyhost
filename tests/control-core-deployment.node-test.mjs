/* global structuredClone */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";
import {
  buildWorkerPackages,
  renderWranglerConfiguration,
  releaseWorker,
  workerReleaseIdentity,
} from "../scripts/platform-release.mjs";
import {
  controlCoreDatabaseName,
  prepareControlCoreDeployment,
  verifyControlCoreDeployment,
} from "../scripts/prepare-control-core-deployment.mjs";

const accountId = "a".repeat(32),
  sourceCommit = "b".repeat(40);
const creationId = "12345678-1234-4234-8234-123456789abc";
const databaseId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-10-29T01:00:00.000Z";
const clone = (value) => structuredClone(value);
async function fixture(context, environment = "development") {
  const root = await mkdtemp(join(tmpdir(), "omh-core-deployment-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "source"),
    parent = join(root, "operator");
  await mkdir(join(repositoryRoot, "apps/control-store/src"), { recursive: true, mode: 0o700 });
  await mkdir(parent, { mode: 0o700 });
  const template = join(repositoryRoot, "apps/control-store/wrangler.jsonc");
  await writeFile(
    template,
    await readFile(new URL("../apps/control-store/wrangler.jsonc", import.meta.url)),
  );
  await writeFile(
    join(repositoryRoot, "apps/control-store/src/worker-main.ts"),
    "export default {};\n",
  );
  const input = {
    repositoryRoot,
    output: join(parent, "prepared"),
    environment,
    creationId,
    accountId,
    resourceObservation: {
      accountId,
      observedAt,
      database: {
        uuid: databaseId,
        name: controlCoreDatabaseName(environment, creationId),
        jurisdiction: "eu",
        read_replication: { mode: "disabled" },
      },
    },
  };
  const inspect = async ({ cwd }) => {
    assert.equal(cwd, repositoryRoot);
    return { repositoryRoot, sha: sourceCommit };
  };
  return { input, inspect, template, parent };
}

test("Core preparation binds the observed primary-only EU resource and writes only a new private deployment packet", async (context) => {
  for (const environment of ["development", "production"]) {
    const { input, inspect } = await fixture(context, environment);
    const contract = await prepareControlCoreDeployment(input, { inspect });
    const config = JSON.parse(await readFile(join(input.output, "wrangler.jsonc"), "utf8"));
    assert.deepEqual(config, contract.configuration);
    assert.deepEqual(
      await renderWranglerConfiguration({
        expectedName: config.name,
        sourcePath: join(input.output, "wrangler.jsonc"),
        outputPath: join(input.output, "rendered.json"),
      }),
      config,
    );
    const commands = [];
    assert.equal(
      await buildWorkerPackages({
        configPath: join(input.output, "wrangler.jsonc"),
        repositoryRoot: input.repositoryRoot,
        run: async (command, args) => {
          commands.push([command, ...args]);
          return "";
        },
      }),
      "@ohmyhost/control-store",
    );
    assert.deepEqual(commands[0], ["pnpm", "--filter", "@ohmyhost/control-store...", "build"]);
    assert.equal(contract.sourceCommit, sourceCommit);
    assert.match(contract.sourceTemplateSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      config.name,
      environment === "development"
        ? "ohmyho-control-store-poc-private-fullstack"
        : "ohmyho-control-store-production",
    );
    assert.deepEqual(config.vars, {
      CONTROL_CORE_DATABASE_ID: databaseId,
      CONTROL_PLATFORM_ENVIRONMENT: environment,
      CONTROL_CORE_RELEASE_SOURCE: sourceCommit,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"disabled"}',
    });
    assert.equal(config.d1_databases[0].database_id, databaseId);
    assert.equal(config.d1_databases[0].database_name, input.resourceObservation.database.name);
    assert.deepEqual(config.triggers, { crons: [] });
    assert.deepEqual(config.routes, []);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.services, undefined);
    assert.equal((await stat(input.output)).mode & 0o077, 0);
    for (const name of ["wrangler.jsonc", "deployment-contract.json", "package.json"])
      assert.equal((await stat(join(input.output, name))).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await readFile(join(input.output, "package.json"), "utf8")), {
      name: "@ohmyhost/control-store",
      private: true,
    });
    await assert.rejects(prepareControlCoreDeployment(input, { inspect }), /EEXIST/u);
    assert.equal(
      await readFile(join(input.output, "deployment-contract.json"), "utf8"),
      JSON.stringify(contract, null, 2) + "\n",
    );
  }
});

test("Core preparation refuses wrong authority, ambiguous location/replicas and widened source templates before creating a packet", async (context) => {
  const { input, inspect, template, parent } = await fixture(context);
  for (const mutate of [
    (v) => {
      v.environment = "staging";
    },
    (v) => {
      v.creationId = "invalid";
    },
    (v) => {
      v.accountId = "f".repeat(32);
    },
    (v) => {
      v.resourceObservation.database.uuid = "not-a-uuid";
    },
    (v) => {
      v.resourceObservation.database.name = "an-existing-unrelated-database";
    },
    (v) => {
      v.resourceObservation.database.jurisdiction = "us";
    },
    (v) => {
      v.resourceObservation.database.read_replication.mode = "auto";
    },
    (v) => {
      delete v.resourceObservation.database.read_replication;
    },
    (v) => {
      v.resourceObservation.observedAt = "unknown";
    },
    (v) => {
      v.credential = "must-never-be-accepted";
    },
  ]) {
    const changed = clone(input);
    mutate(changed);
    await assert.rejects(prepareControlCoreDeployment(changed, { inspect }), /UNVERIFIED/u);
  }
  await assert.rejects(stat(input.output), /ENOENT/u);
  const original = await readFile(template, "utf8");
  await writeFile(
    template,
    original.replace(
      '"observability": { "enabled": false },',
      '"observability": { "enabled": false }, "services": [{"binding":"FOREIGN","service":"foreign"}],',
    ),
  );
  await assert.rejects(prepareControlCoreDeployment(input, { inspect }), /UNVERIFIED/u);
  await writeFile(template, original);
  await assert.rejects(
    prepareControlCoreDeployment(input, {
      inspect: async () => ({ repositoryRoot: input.repositoryRoot, sha: "foreign" }),
    }),
    /UNVERIFIED/u,
  );
  await assert.rejects(
    prepareControlCoreDeployment(
      { ...input, output: join(input.repositoryRoot, "inside") },
      { inspect },
    ),
    /outside the checkout/u,
  );
  const contract = await prepareControlCoreDeployment(input, { inspect });
  const configPath = join(input.output, "wrangler.jsonc");
  await writeFile(
    join(input.output, "package.json"),
    JSON.stringify({ name: "@ohmyhost/billing" }),
  );
  await writeFile(join(parent, "untracked-worker.ts"), "export default {};\n");
  let providerCalls = 0;
  const run = async (command, args) => {
    if (command === "pnpm") {
      assert.deepEqual(args, ["--filter", "@ohmyhost/control-store...", "build"]);
      return "built";
    }
    if (command === "gh")
      return JSON.stringify([
        { databaseId: 42, headSha: sourceCommit, status: "completed", conclusion: "success" },
      ]);
    if (command === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return input.repositoryRoot;
      if (key === "rev-parse --is-bare-repository") return "false";
      if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main";
      if (key === "status --porcelain=v1 --untracked-files=all") return "";
      if (key === "rev-parse HEAD" || key === "rev-parse refs/remotes/origin/main")
        return sourceCommit;
      if (key === "remote get-url --push origin" || key === "remote get-url origin")
        return "https://github.com/amerged-org/ohmyhost.git";
      if (key === "ls-remote --exit-code origin refs/heads/main")
        return sourceCommit + "\trefs/heads/main";
    }
    providerCalls++;
    throw new Error("Provider must not see this packet");
  };
  for (const mutate of [
    (v) => {
      v.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY = '{"mode":"password-general-availability"}';
    },
    (v) => {
      v.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY = JSON.stringify({
        mode: "allowlist",
        projects: [
          { organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
        ],
      });
    },
    (v) => {
      v.main = join(parent, "untracked-worker.ts");
    },
    (v) => {
      v.vars.CONTROL_CORE_RELEASE_SOURCE = "f".repeat(40);
    },
  ]) {
    const changed = clone(contract.configuration);
    mutate(changed);
    await writeFile(configPath, JSON.stringify(changed));
    await assert.rejects(
      releaseWorker({
        configPath,
        cwd: input.repositoryRoot,
        run,
        wrangler: "provider-must-not-run",
      }),
      /UNVERIFIED/u,
    );
  }
  assert.equal(providerCalls, 0);
});

test("Core convergence requires the exact private version and resource with no legacy credential and certifies no authority activation", async (context) => {
  const { input, inspect, parent } = await fixture(context);
  const contract = await prepareControlCoreDeployment(input, { inspect });
  const configuration = contract.configuration;
  const identity = workerReleaseIdentity({ sha: sourceCommit, configuration });
  const receipt = {
    deploymentVerified: true,
    sha: sourceCommit,
    workerName: configuration.name,
    versionId,
    ...identity,
  };
  const actual = {
    accountId,
    observedAt,
    workerName: configuration.name,
    resourceObservation: input.resourceObservation,
    version: {
      id: versionId,
      annotations: { "workers/tag": identity.tag, "workers/message": identity.message },
      resources: {
        bindings: [
          { name: "CONTROL_CORE", type: "d1", id: databaseId },
          { name: "CF_VERSION_METADATA", type: "version_metadata" },
          ...Object.entries(configuration.vars).map(([name, text]) => ({
            name,
            type: "plain_text",
            text,
          })),
        ],
      },
    },
    deployment: { versions: [{ version_id: versionId, percentage: 100 }] },
    subdomain: { enabled: false, previews_enabled: false },
    routes: [],
    customDomains: [],
    schedules: [],
    settings: {
      compatibility_date: configuration.compatibility_date,
      compatibility_flags: configuration.compatibility_flags,
    },
  };
  assert.equal(
    (
      await verifyControlCoreDeployment(actual, contract, receipt, {
        repositoryRoot: input.repositoryRoot,
        inspect,
      })
    ).authorityActivation,
    "not-certified",
  );
  const legacyMessage = identity.message.replace(/^source /u, "origin/main ");
  const legacyActual = clone(actual);
  legacyActual.version.annotations["workers/message"] = legacyMessage;
  assert.equal(
    (
      await verifyControlCoreDeployment(
        legacyActual,
        contract,
        { ...receipt, message: legacyMessage },
        {
          repositoryRoot: input.repositoryRoot,
          inspect,
        },
      )
    ).authorityActivation,
    "not-certified",
  );
  await assert.rejects(
    () =>
      verifyControlCoreDeployment(
        actual,
        contract,
        { ...receipt, message: legacyMessage },
        {
          repositoryRoot: input.repositoryRoot,
          inspect,
        },
      ),
    /UNVERIFIED/u,
  );
  const foreignContract = clone(contract);
  foreignContract.configuration.d1_databases[0].binding = "ANOTHER_AUTHORITY";
  const foreignIdentity = workerReleaseIdentity({
    sha: sourceCommit,
    configuration: foreignContract.configuration,
  });
  const foreignVersion = clone(actual);
  foreignVersion.version.annotations = {
    "workers/tag": foreignIdentity.tag,
    "workers/message": foreignIdentity.message,
  };
  await assert.rejects(
    () =>
      verifyControlCoreDeployment(
        foreignVersion,
        foreignContract,
        {
          ...receipt,
          ...foreignIdentity,
        },
        { repositoryRoot: input.repositoryRoot, inspect },
      ),
    /UNVERIFIED/u,
  );
  for (const mutate of [
    (v) => {
      v.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY = '{"mode":"password-general-availability"}';
    },
    (v) => {
      v.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY = JSON.stringify({
        mode: "allowlist",
        projects: [
          { organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
        ],
      });
    },
    (v) => {
      v.main = join(parent, "another-untracked-worker.ts");
    },
    (v) => {
      v.compatibility_date = "2020-01-01";
    },
    (v) => {
      v.services = [{ binding: "FOREIGN", service: "foreign" }];
    },
  ]) {
    const changed = clone(contract);
    mutate(changed.configuration);
    const identity = workerReleaseIdentity({
      sha: sourceCommit,
      configuration: changed.configuration,
    });
    const version = clone(actual);
    version.version.annotations = {
      "workers/tag": identity.tag,
      "workers/message": identity.message,
    };
    await assert.rejects(
      verifyControlCoreDeployment(
        version,
        changed,
        { ...receipt, ...identity },
        { repositoryRoot: input.repositoryRoot, inspect },
      ),
      /UNVERIFIED/u,
    );
  }
  for (const mutate of [
    (v) => {
      v.accountId = "f".repeat(32);
    },
    (v) => {
      v.resourceObservation.database.uuid = versionId;
    },
    (v) => {
      v.version.resources.bindings[0].id = versionId;
    },
    (v) => {
      v.version.resources.bindings[0].type = "kv_namespace";
    },
    (v) => {
      v.version.resources.bindings[2].text = versionId;
    },
    (v) => {
      v.version.resources.bindings.push({ name: "EXTRA_SECRET", type: "secret_text" });
    },
    (v) => {
      v.version.resources.bindings[3] = clone(v.version.resources.bindings[2]);
    },
    (v) => {
      v.deployment.versions[0].percentage = 50;
    },
    (v) => {
      v.version.annotations["workers/tag"] = "stale";
    },
    (v) => {
      v.subdomain.enabled = true;
    },
    (v) => {
      v.routes = [{ pattern: "public.example/*" }];
    },
    (v) => {
      v.customDomains = [{ hostname: "public.example" }];
    },
    (v) => {
      v.schedules = [{ cron: "* * * * *" }];
    },
    (v) => {
      v.settings.compatibility_flags = [];
    },
    (v) => {
      v.resourceObservation.observedAt = "2026-10-28T01:00:00.000Z";
    },
    (v) => {
      v.resourceObservation.observedAt = "2026-10-30T01:00:00.000Z";
    },
    (v) => {
      v.observedAt = "2026-10-28T01:00:00.000Z";
    },
  ]) {
    const changed = clone(actual);
    mutate(changed);
    await assert.rejects(
      () =>
        verifyControlCoreDeployment(changed, contract, receipt, {
          repositoryRoot: input.repositoryRoot,
          inspect,
        }),
      /UNVERIFIED/u,
    );
  }
});
