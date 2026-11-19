/* global structuredClone, Response */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  CONTROL_CORE_WORKER_PROFILES,
  controlCoreWorkerConfiguration,
} from "../scripts/control-core-worker-profile.mjs";
import {
  CONTROL_CORE_CONFIG,
  controlCoreEntrypoints,
  inspectControlCoreConsumer,
  requireControlCoreBeforeConsumers,
  requireAtomicDevGatewayChain,
} from "../scripts/control-core-train.mjs";
import {
  manifestDigest,
  prepareReleaseTrain,
  validateTrainManifest,
} from "../scripts/release-pipeline.mjs";
import { releaseHash } from "../scripts/release-rehearsal-artifacts.mjs";
import { canonical, sha256 } from "../scripts/control-d1-codec.mjs";
import { parseJsonc } from "../scripts/platform-release.mjs";
import {
  policyConsumers,
  requirePolicyCohort,
  requirePolicyTrain,
  PolicyCohortError,
} from "../scripts/release-policy-cohort.mjs";
import {
  releaseWorker,
  renderWranglerConfiguration,
  verifyWorkerReleaseReceipt,
  workerReleaseIdentity,
} from "../scripts/platform-release.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);
const ACCOUNT = "b".repeat(32);
const DATABASE = "22222222-2222-4222-8222-222222222222";
const DEV_CORE = "ohmyho-control-store-poc-private-fullstack";
const PROD_CORE = "ohmyho-control-store-production";
const DEV_CONSUMER = "ohmyho-billing-poc-private-fullstack";
const productionReference = (environment) =>
  environment === "production"
    ? { developmentReference: { manifest: "/private/dev.json", state: "/private/dev-state.json" } }
    : {};
const core = (environment = "development") => ({
  databaseId: DATABASE,
  databaseName: `ohmyho-control-core-${environment}`,
});
const coreStep = {
  id: "core",
  kind: "worker",
  config: CONTROL_CORE_CONFIG,
  configSha256: "c".repeat(64),
  workerName: DEV_CORE,
  dependsOn: [],
  core: core(),
};
// The Core schema head this source pins, and the receipt the provider reports for the Core database.
const corePin = {
  layout: "shared-core-v1",
  revision: SHA,
  migrations: [{ name: "0690_project_handle_releases.sql", sha256: "b".repeat(64) }],
};
const reportedHead = async (_command, args) => {
  if (args[0] !== "d1") throw new Error(`unexpected ${args.join(" ")}`);
  return JSON.stringify([
    {
      success: true,
      results: [
        {
          command_id: "control-d1.schema:v1",
          name: "control-d1.schema",
          digest: sha256(Buffer.from(canonical(corePin))),
          result: JSON.stringify({ schemaSha256: "e".repeat(64) }),
        },
      ],
    },
  ]);
};
const consumerStep = (extra = {}) => ({
  id: "billing",
  kind: "worker",
  config: "apps/billing/wrangler.jsonc",
  configSha256: "d".repeat(64),
  workerName: DEV_CONSUMER,
  dependsOn: ["core"],
  ...extra,
});
const train = (steps) => ({
  schemaVersion: 1,
  sourceCommit: SHA,
  environment: "development",
  accountId: ACCOUNT,
  rehearsal: "/private/rehearsal.json",
  steps,
});

test("a train names the Core step's exact D1 resource and admits nothing wider", () => {
  validateTrainManifest(train([coreStep, consumerStep()]));
  for (const change of [
    { config: "apps/control-store/other.jsonc" },
    { core: undefined },
    { core: { ...core(), extra: true } },
    { core: { ...core(), databaseId: "not-a-uuid" } },
    { core: core("production") },
    { core: { ...core(), databaseName: "ohmyho-control-core-development-foreign" } },
    { secretsFile: "/private/secrets.json" },
    { containerImages: "/private/images.json" },
    { workerName: PROD_CORE },
  ])
    assert.throws(
      () => validateTrainManifest(train([{ ...coreStep, ...change }, consumerStep()])),
      undefined,
      JSON.stringify(Object.keys(change)),
    );
  // The retained UUID-suffixed resource name stays valid; no other Worker may carry a resource.
  validateTrainManifest(
    train([
      {
        ...coreStep,
        core: { ...core(), databaseName: `ohmyho-control-core-development-${DATABASE}` },
      },
    ]),
  );
  assert.throws(() => validateTrainManifest(train([coreStep, consumerStep({ core: core() })])));
  // A step names no Control database host or role: the Control is the Core.
  assert.throws(() =>
    validateTrainManifest(
      train([coreStep, consumerStep({ expectedControlHost: "db.example.test" })]),
    ),
  );
});

test("regional Native Workers join their own Core train and absent profiles can be excluded explicitly", async () => {
  const { buildCoreTrainManifest, readEnvironmentProfiles } = await import(
    "../scripts/control-core-manifest.mjs"
  );
  for (const environment of ["development", "production"]) {
    const base = {
      repositoryRoot: SOURCE,
      environment,
      accountId: ACCOUNT,
      sourceCommit: SHA,
      core: core(environment),
      rehearsal: "/private/rehearsal.json",
      imagesDirectory: "/private/images",
      ...productionReference(environment),
    };
    const profiles = await readEnvironmentProfiles({ repositoryRoot: SOURCE, environment });
    assert.ok(
      profiles.every(({ configuration }) => !configuration.name.includes("preview-runtime")),
    );
    const native = profiles.filter(({ configuration }) =>
      /^ohmyho-native-auth-(?:development|production)-(?:us|eu)$/u.test(configuration.name),
    );
    assert.deepEqual(
      native.map(({ configuration }) => configuration.name).sort(),
      ["eu", "us"].map((region) => `ohmyho-native-auth-${environment}-${region}`).sort(),
    );
    const manifest = await buildCoreTrainManifest({ ...base, workerExists: async () => true });
    const indexOf = (name) => manifest.steps.findIndex((step) => step.workerName === name);
    const suffix = environment === "development" ? "poc-private-fullstack" : "production";
    const mail = `ohmyho-mail-gateway-${suffix}`;
    const neon = `ohmyho-neon-management-${suffix}`;
    const control = `ohmyho-control-api-${suffix}`;
    const preview = manifest.steps.find(
      (step) => step.workerName === `ohmyho-live-preview-${suffix}`,
    );
    const gateway = manifest.steps.find((step) => step.workerName === `ohmyho-gateway-${suffix}`);
    assert.ok(preview && gateway);
    assert.ok(indexOf(preview.workerName) < indexOf(control));
    assert.ok(indexOf(control) < indexOf(gateway.workerName));
    for (const { configuration } of native) {
      assert.deepEqual(
        configuration.services.filter(({ binding }) => binding === "NATIVE_AUTH_PROVIDER_SECRETS"),
        [
          {
            binding: "NATIVE_AUTH_PROVIDER_SECRETS",
            service: control,
            entrypoint: "NativeAuthProviderSecretService",
          },
        ],
      );
      assert.equal(configuration.workers_dev, false);
      assert.equal(configuration.preview_urls, false);
      assert.deepEqual(configuration.routes ?? [], []);
      assert.deepEqual(configuration.triggers?.crons ?? [], []);
      const authority = configuration.services.find(
        ({ binding }) => binding === "NATIVE_AUTH_AUTHORITY",
      );
      const sender = configuration.services.find(({ binding }) => binding === "NATIVE_AUTH_MAIL");
      assert.equal(authority.service, CONTROL_CORE_WORKER_PROFILES[environment]);
      assert.equal(authority.entrypoint, "NativeAuthRuntime");
      assert.equal(sender.service, mail);
      assert.equal(sender.entrypoint, "NativeAuthMailService");
      assert.ok(indexOf(CONTROL_CORE_WORKER_PROFILES[environment]) < indexOf(mail));
      assert.ok(indexOf(mail) < indexOf(configuration.name));
      assert.ok(indexOf(configuration.name) < indexOf(neon));
      assert.ok(indexOf(configuration.name) < indexOf(control));
      assert.ok(
        manifest.steps[indexOf(configuration.name)].dependsOn.includes(
          manifest.steps[indexOf(mail)].id,
        ),
      );
      assert.ok(
        manifest.steps[indexOf(neon)].dependsOn.includes(
          manifest.steps[indexOf(configuration.name)].id,
        ),
      );
      assert.ok(
        manifest.steps[indexOf(control)].dependsOn.includes(
          manifest.steps[indexOf(configuration.name)].id,
        ),
      );
    }

    assert.equal(manifest.steps[0].nativeAuthLaunchPolicy, undefined);
    const policy = { mode: "password-general-availability" };
    const selected = await buildCoreTrainManifest({
      ...base,
      workerExists: async () => true,
      nativeAuthLaunchPolicy: policy,
      previewSecretsFile: "/private/preview-secrets.json",
    });
    assert.deepEqual(selected.steps[0].nativeAuthLaunchPolicy, policy);
    assert.deepEqual(
      selected.developmentReference,
      productionReference(environment).developmentReference,
    );
    assert.equal(
      selected.steps.find((step) => step.workerName === preview.workerName).secretsFile,
      "/private/preview-secrets.json",
    );
    assert.ok(
      selected.steps
        .filter((step) => step.workerName !== preview.workerName)
        .every((step) => step.secretsFile === undefined),
    );
    await assert.rejects(
      buildCoreTrainManifest({
        ...base,
        workerExists: async () => true,
        previewSecretsFile: "relative/secrets.json",
      }),
      /absolute private file path/u,
    );

    for (const { configuration } of native) {
      const step = manifest.steps.find((candidate) => candidate.workerName === configuration.name);
      assert.ok(step, configuration.name);
      assert.ok(step.dependsOn.includes("core"), configuration.name);
      assert.ok(
        configuration.services
          .filter(({ service }) => service.includes("control-store"))
          .every(({ service }) => service === CONTROL_CORE_WORKER_PROFILES[environment]),
      );
    }
    const nativeStep = manifest.steps.find(
      (step) => step.workerName === `ohmyho-native-auth-${environment}-eu`,
    );
    assert.ok(nativeStep);
    assert.throws(
      () =>
        validateTrainManifest({
          ...manifest,
          steps: manifest.steps.map((step) =>
            step === nativeStep
              ? { ...step, config: "apps/native-auth-runtime/wrangler.jsonc" }
              : step,
          ),
        }),
      /Native regional Worker scope/u,
    );
    for (const workerName of [
      `ohmyho-native-auth-${environment}-ap`,
      `ohmyhost-native-auth-${environment}-eu`,
      `ohmyho-native-auth-${environment}-eu-extra`,
    ])
      assert.throws(
        () =>
          validateTrainManifest({
            ...manifest,
            steps: manifest.steps.map((step) =>
              step === nativeStep ? { ...step, workerName } : step,
            ),
          }),
        /Worker scope/u,
      );
    const excluded = native[0];
    assert.ok(excluded);
    await assert.rejects(
      buildCoreTrainManifest({
        ...base,
        exclude: [excluded.config],
        workerExists: async () => true,
      }),
      /exists live/u,
    );
    await assert.rejects(
      buildCoreTrainManifest({
        ...base,
        exclude: [excluded.config],
        workerExists: async (name) => name !== excluded.configuration.name,
      }),
      /Preview Runtime cohort cannot exclude/u,
    );
    const absent = await buildCoreTrainManifest({
      ...base,
      developmentReference: undefined,
      exclude: [excluded.config, `apps/preview-runtime/wrangler.${environment}.jsonc`],
      workerExists: async (name) =>
        ![excluded.configuration.name, preview.workerName].includes(name),
    });
    assert.equal(
      absent.steps.some((step) => step.workerName === excluded.configuration.name),
      false,
    );
    assert.equal(
      absent.steps.some((step) => step.workerName === preview.workerName),
      false,
    );
    await assert.rejects(
      buildCoreTrainManifest({
        ...base,
        exclude: [`apps/preview-runtime/wrangler.${environment}.jsonc`],
        previewSecretsFile: "/private/preview-secrets.json",
        workerExists: async (name) => name !== preview.workerName,
      }),
      /secret input requires its included profile/u,
    );
    assert.throws(() =>
      validateTrainManifest({
        ...manifest,
        environment: environment === "development" ? "production" : "development",
      }),
    );
  }
});

test("the Core configuration is the closed profile of the step's resource, never a file that carries an id", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "omh-core-train-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    accountId: ACCOUNT,
    sourceCommit: SHA,
    repositoryRoot: SOURCE,
    ...core(),
  };
  const rendered = await renderWranglerConfiguration({
    expectedName: DEV_CORE,
    outputPath: join(directory, "wrangler.json"),
    sourcePath: join(SOURCE, CONTROL_CORE_CONFIG),
    core: input,
  });
  const expected = await controlCoreWorkerConfiguration({
    repositoryRoot: SOURCE,
    sourceCommit: SHA,
    environment: "development",
    accountId: ACCOUNT,
    databaseId: DATABASE,
    databaseName: "ohmyho-control-core-development",
  });
  assert.deepEqual(rendered, expected.configuration);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "wrangler.json"), "utf8")), rendered);
  assert.equal(rendered.workers_dev, false);
  assert.deepEqual(rendered.routes, []);
  // Another file, the other environment's Worker or a foreign template never renders as the Core.
  await assert.rejects(
    renderWranglerConfiguration({
      expectedName: DEV_CORE,
      outputPath: join(directory, "other.json"),
      sourcePath: join(SOURCE, "apps/billing/wrangler.jsonc"),
      core: input,
    }),
    /source is invalid/u,
  );
  await assert.rejects(
    renderWranglerConfiguration({
      expectedName: PROD_CORE,
      outputPath: join(directory, "production.json"),
      sourcePath: join(SOURCE, CONTROL_CORE_CONFIG),
      core: input,
    }),
    /UNVERIFIED/u,
  );
  // Every binding a consumer may name is an entrypoint the Core actually exports.
  const entrypoints = await controlCoreEntrypoints(SOURCE);
  for (const name of [
    "ControlRuntime",
    "AccountMetadataRuntime",
    "BillingRuntime",
    "WorkosRuntime",
  ])
    assert.ok(entrypoints.has(name), name);
  assert.ok(!entrypoints.has("default"));
});

test("a Core consumer binds only its own environment's Core, and the Core is released first", () => {
  const entrypoints = new Set(["BillingRuntime", "ControlRuntime"]);
  const service = (extra = {}) => ({
    binding: "CONTROL_RUNTIME",
    service: DEV_CORE,
    entrypoint: "BillingRuntime",
    ...extra,
  });
  const consumer = (extra = {}) => ({ services: [service()], ...extra });
  const inspect = (configuration, environment = "development", coreDatabaseId = undefined) =>
    inspectControlCoreConsumer({ configuration, environment, entrypoints, coreDatabaseId });
  assert.equal(inspect({ vars: { OTHER: "x" } }).mode, "none");
  assert.deepEqual(inspect(consumer()), {
    mode: "d1",
    bindings: [{ binding: "CONTROL_RUNTIME", entrypoint: "BillingRuntime" }],
  });
  for (const foreign of [
    consumer({ services: [service({ service: PROD_CORE })] }),
    consumer({ services: [service({ entrypoint: "UnknownRuntime" })] }),
    consumer({ services: [service({ entrypoint: undefined })] }),
    consumer({ services: [service(), service({ entrypoint: "ControlRuntime" })] }),
    consumer({ d1_databases: [{ binding: "CONTROL_CORE", database_id: DATABASE }] }),
    consumer({ vars: { CONTROL_CORE_DATABASE_ID: "33333333-3333-4333-8333-333333333333" } }),
  ])
    assert.throws(
      () => inspect(foreign, "development", DATABASE),
      /Core consumer/u,
      JSON.stringify(foreign),
    );
  // The Production Core is the only target in Production; Development consumers cannot bind it.
  assert.throws(() => inspect(consumer(), "production"), /Core consumer/u);

  const manifest = train([coreStep, consumerStep()]);
  requireControlCoreBeforeConsumers({ manifest, consumerStepIds: ["billing"] });
  requireControlCoreBeforeConsumers({ manifest, consumerStepIds: [] });
  assert.throws(
    () =>
      requireControlCoreBeforeConsumers({
        manifest: train([coreStep, consumerStep({ dependsOn: [] })]),
        consumerStepIds: ["billing"],
      }),
    /must depend on the Core/u,
  );
  assert.throws(
    () =>
      requireControlCoreBeforeConsumers({
        manifest: train([consumerStep({ dependsOn: [] })]),
        consumerStepIds: ["billing"],
      }),
    /exactly one Core/u,
  );
});

test("preparing a train refuses a Core consumer that is unordered or binds another environment's Core", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omh-core-train-repo-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, body] of [
    [
      "apps/control-store/src/worker-main.ts",
      "export class BillingRuntime extends WorkerEntrypoint {}\n",
    ],
    ["apps/control-store/package.json", JSON.stringify({ name: "@ohmyhost/control-store" })],
    ["apps/billing/worker.mjs", "export default {};\n"],
    ["apps/billing/package.json", JSON.stringify({ name: "@ohmyhost/billing" })],
  ]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  const template = await readFile(join(SOURCE, CONTROL_CORE_CONFIG));
  await writeFile(join(root, CONTROL_CORE_CONFIG), template);
  const consumer = {
    name: DEV_CONSUMER,
    account_id: ACCOUNT,
    main: "worker.mjs",
    workers_dev: false,
    preview_urls: false,
    services: [{ binding: "CONTROL_RUNTIME", service: DEV_CORE, entrypoint: "BillingRuntime" }],
  };
  const write = async (configuration) => {
    const bytes = JSON.stringify(configuration);
    await writeFile(join(root, "apps/billing/wrangler.jsonc"), bytes);
    return releaseHash(bytes);
  };
  const prepare = async (
    configuration,
    extra = {},
    coreStepOverride = coreStep,
    readCorePin = async () => corePin,
  ) => {
    const consumerHash = await write(configuration);
    return prepareReleaseTrain({
      run: reportedHead,
      readCorePin,
      manifest: {
        schemaVersion: 1,
        sourceCommit: SHA,
        environment: "development",
        accountId: ACCOUNT,
        steps: [
          { ...coreStepOverride, configSha256: releaseHash(template) },
          consumerStep({ configSha256: consumerHash, ...extra }),
        ],
      },
      repositoryRoot: root,
    });
  };
  const prepared = await prepare(consumer);
  assert.equal(prepared.workers.core.configuration.name, DEV_CORE);
  assert.equal(prepared.workers.core.configuration.d1_databases[0].database_id, DATABASE);
  assert.deepEqual(prepared.workers.billing.configuration.services, consumer.services);
  // The approved fingerprint changes with the resource the Core is bound to.
  const other = await prepare(
    consumer,
    {},
    {
      ...coreStep,
      core: { ...core(), databaseId: "33333333-3333-4333-8333-333333333333" },
    },
  );
  assert.notEqual(other.fingerprint, prepared.fingerprint);
  // A Core step whose schema head is not the one its source pins is never prepared for release.
  await assert.rejects(
    prepare(consumer, {}, coreStep, async () => ({ ...corePin, revision: "c".repeat(40) })),
    /TARGET_UNATTESTED/u,
  );
  await assert.rejects(prepare(consumer, { dependsOn: [] }), /must depend on the Core/u);
  await assert.rejects(
    prepare({
      ...consumer,
      services: [{ ...consumer.services[0], service: "ohmyho-control-store-production" }],
    }),
    /Core consumer/u,
  );
  // A Worker that binds no Core needs no Core in its train.
  const independent = structuredClone(consumer);
  delete independent.services;
  const hash = await write(independent);
  const unbound = await prepareReleaseTrain({
    manifest: {
      schemaVersion: 1,
      sourceCommit: SHA,
      environment: "development",
      accountId: ACCOUNT,
      steps: [consumerStep({ configSha256: hash, dependsOn: [] })],
    },
    repositoryRoot: root,
  });
  assert.equal(unbound.workers.billing.configuration.services, undefined);
});

test("the Core is a policy consumer of both environments and may be created, never re-released, outside a train", async () => {
  const names = async (environment) =>
    (await policyConsumers({ environment, accountId: ACCOUNT })).map(({ workerName, config }) => [
      workerName,
      config,
    ]);
  assert.deepEqual((await names("development")).at(-1), [DEV_CORE, CONTROL_CORE_CONFIG]);
  assert.deepEqual((await names("production")).at(-1), [PROD_CORE, CONTROL_CORE_CONFIG]);
  for (const environment of ["development", "production"])
    assert.deepEqual((await names(environment)).map(([, config]) => config.split("/")[1]).sort(), [
      "build-runner",
      "control-api",
      "control-store",
      "source-fetcher",
    ]);
  // The standalone refusal is not decided here: only the release itself knows whether the Core exists.
  await requirePolicyTrain({ workerName: DEV_CORE });
  await assert.rejects(
    requirePolicyTrain({ workerName: "ohmyho-control-api-production" }),
    /only through release:train/u,
  );
  const observation = (live) => ({
    policySha256: "9".repeat(64),
    consumers: [
      {
        environment: "development",
        workerName: DEV_CORE,
        name: DEV_CORE,
        config: CONTROL_CORE_CONFIG,
        target: "9".repeat(64),
        live,
      },
    ],
  });
  const lagging = observation("8".repeat(64));
  assert.throws(
    () =>
      requirePolicyCohort({
        manifest: train([consumerStep({ dependsOn: [] })]),
        observation: lagging,
        phase: "before",
      }),
    (error) =>
      error instanceof PolicyCohortError &&
      error.message.includes(`add Worker steps for ${DEV_CORE}`),
  );
  requirePolicyCohort({ manifest: train([coreStep]), observation: lagging, phase: "before" });
  requirePolicyCohort({
    manifest: train([coreStep]),
    observation: observation("9".repeat(64)),
    phase: "after",
  });
});

test("a Core release proves its D1 resource first, creates standalone only and ships in a train once it exists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omh-core-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/control-store/src"), { recursive: true });
  await writeFile(
    join(root, "apps/control-store/package.json"),
    JSON.stringify({ name: "@ohmyhost/control-store" }),
  );
  await writeFile(join(root, "apps/control-store/src/worker-main.ts"), "export default {};\n");
  await writeFile(
    join(root, CONTROL_CORE_CONFIG),
    await readFile(join(SOURCE, CONTROL_CORE_CONFIG)),
  );
  const resource = {
    uuid: DATABASE,
    name: core().databaseName,
    jurisdiction: "eu",
    read_replication: { mode: "disabled" },
  };
  let provided = resource;
  const calls = [];
  let coreExists = true;
  const pinned = {
    layout: "shared-core-v1",
    revision: "a".repeat(40),
    migrations: [{ name: "0690_project_handle_releases.sql", sha256: "b".repeat(64) }],
  };
  const older = {
    layout: "shared-core-v1",
    revision: "c".repeat(40),
    migrations: [{ name: "0689_previous.sql", sha256: "d".repeat(64) }],
  };
  const run = async (command, args, options = {}) => {
    if (command === "wrangler" && args[0] === "d1") {
      // The receipt read names the account and database through the rendered configuration.
      assert.ok(args.includes("--config"), args.join(" "));
      return JSON.stringify([
        {
          success: true,
          results: [
            {
              command_id: "control-d1.schema:v1",
              name: "control-d1.schema",
              digest: sha256(Buffer.from(canonical(older))),
              result: JSON.stringify({ schemaSha256: "e".repeat(64) }),
            },
          ],
        },
      ]);
    }
    calls.push([command, ...args]);
    if (command === "wrangler" && args[0] === "auth")
      return JSON.stringify({ type: "api_token", token: "private" });
    if (command === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return `${root}\n`;
      if (key === "rev-parse --is-bare-repository") return "false\n";
      if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
      if (key === "status --porcelain=v1 --untracked-files=all") return "";
      if (key === "remote get-url --push origin" || key === "remote get-url origin")
        return "https://github.com/amerged-org/ohmyhost.git\n";
      if (key === "ls-remote --exit-code origin refs/heads/main")
        return `${SHA}\trefs/heads/main\n`;
      return `${SHA}\n`;
    }
    if (command === "gh")
      return JSON.stringify([
        { databaseId: 42, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    if (command === "pnpm") return "built\n";
    if (command === "wrangler" && args[0] === "versions" && args[1] === "list") {
      if (!coreExists)
        throw Object.assign(new Error("Wrangler failed"), {
          code: 1,
          stderr: `This Worker does not exist on your account. [code: 10007]\nGET /accounts/${options.observeWorker?.accountId}/workers/scripts/${DEV_CORE}/versions`,
        });
      return JSON.stringify([{ id: "x", annotations: {} }]);
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const fetch = async () => Response.json({ success: true, result: provided });
  const input = { accountId: ACCOUNT, sourceCommit: SHA, repositoryRoot: root, ...core() };
  const release = (extra = {}) =>
    releaseWorker({
      configPath: join(root, CONTROL_CORE_CONFIG),
      cwd: root,
      expectedName: DEV_CORE,
      run,
      wrangler: "wrangler",
      fetch,
      core: input,
      ...extra,
    });
  // A resource that is not exactly the named one stops the release before any Wrangler upload.
  for (const wrong of [
    { ...resource, uuid: "33333333-3333-4333-8333-333333333333" },
    { ...resource, jurisdiction: "us" },
    { ...resource, read_replication: { mode: "auto" } },
    { ...resource, name: "ohmyho-control-core-production" },
  ]) {
    provided = wrong;
    await assert.rejects(release({ rehearsal: undefined }), /UNVERIFIED/u);
  }
  assert.ok(!calls.some(([, ...args]) => args[0] === "versions" && args[1] === "upload"));
  // A Core that exists is released in a train with its cohort, not on its own.
  provided = resource;
  await assert.rejects(release(), /only through release:train/u);
  assert.ok(!calls.some(([, ...args]) => args[0] === "deploy"));
  // A Core whose schema head is not the one its source commit pins is never uploaded or deployed.
  coreExists = false;
  await assert.rejects(release({ readCorePin: async () => pinned }), /TARGET_UNATTESTED/u);
  assert.ok(!calls.some(([, ...args]) => args[0] === "versions" && args[1] === "upload"));
  assert.ok(!calls.some(([, ...args]) => args[0] === "deploy"));
  // The Core resource belongs to the Core alone.
  await assert.rejects(
    releaseWorker({
      configPath: join(root, CONTROL_CORE_CONFIG),
      cwd: root,
      expectedName: DEV_CONSUMER,
      run,
      wrangler: "wrangler",
      core: input,
    }),
    /Only the Core Worker/u,
  );
});

test("every checked-in Worker configuration either binds no Core or binds its own environment's Core", async () => {
  const entrypoints = await controlCoreEntrypoints(SOURCE);
  const apps = await readdir(join(SOURCE, "apps"));
  const seen = [];
  for (const app of apps)
    for (const file of await readdir(join(SOURCE, "apps", app)).catch(() => []))
      if (/^wrangler.*\.jsonc$/u.test(file)) {
        const configuration = parseJsonc(await readFile(join(SOURCE, "apps", app, file), "utf8"));
        if (typeof configuration?.name !== "string") continue;
        const environment = /-production(?:-(?:us|eu))?$/u.test(configuration.name)
          ? "production"
          : "development";
        const inspected = inspectControlCoreConsumer({ configuration, environment, entrypoints });
        seen.push([`apps/${app}/${file}`, inspected.mode]);
      }
  assert.ok(seen.length > 50, "the scan reads the checked-in Worker configurations");
  // The Core's own template is not a consumer: it binds its D1 database, not a Core service.
  assert.ok(seen.every(([, mode]) => ["none", "d1"].includes(mode)));
});

test("a D1 consumer's Core id comes from the Core step, never from a checked-in file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omh-core-consumer-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authored = `${JSON.stringify(
    {
      name: "ohmyho-example-poc-private-fullstack",
      main: "src/worker-main.ts",
      compatibility_date: "2026-10-01",
      workers_dev: false,
      preview_urls: false,
      account_id: "00000000000000000000000000000001",
      // The checked-in profile carries the placeholder; the train resolves the id from its Core step.
      vars: {
        CONTROL_CORE_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
      },
      services: [{ binding: "CONTROL_EXAMPLE", service: DEV_CORE, entrypoint: "ExampleRuntime" }],
    },
    null,
    2,
  )}\n`;
  for (const [path, body] of [
    [
      "apps/control-store/src/worker-main.ts",
      "export class ExampleRuntime extends WorkerEntrypoint {}\n",
    ],
    ["apps/control-store/package.json", JSON.stringify({ name: "@ohmyhost/control-store" })],
    ["apps/example/src/worker-main.ts", "export default {};\n"],
    ["apps/example/package.json", JSON.stringify({ name: "@ohmyhost/example" })],
    ["apps/example/wrangler.development.jsonc", authored],
  ]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  const template = await readFile(join(SOURCE, CONTROL_CORE_CONFIG));
  await writeFile(join(root, CONTROL_CORE_CONFIG), template);
  const consumer = {
    id: "example",
    kind: "worker",
    config: "apps/example/wrangler.development.jsonc",
    configSha256: releaseHash(authored),
    workerName: "ohmyho-example-poc-private-fullstack",
    dependsOn: ["core"],
  };
  const prepare = (steps) =>
    prepareReleaseTrain({
      run: reportedHead,
      readCorePin: async () => corePin,
      manifest: {
        schemaVersion: 1,
        sourceCommit: SHA,
        environment: "development",
        accountId: "00000000000000000000000000000001",
        steps,
      },
      repositoryRoot: root,
    });
  const core = { ...coreStep, configSha256: releaseHash(template) };
  const prepared = await prepare([core, consumer]);
  const rendered = prepared.workers.example.configuration;
  assert.equal(rendered.vars.CONTROL_CORE_DATABASE_ID, DATABASE);
  assert.deepEqual(rendered.services, [
    { binding: "CONTROL_EXAMPLE", service: DEV_CORE, entrypoint: "ExampleRuntime" },
  ]);
  assert.ok(!authored.includes(DATABASE));
  // Without a Core step in the train there is nothing to resolve the id and nothing to order the consumer after.
  await assert.rejects(prepare([{ ...consumer, dependsOn: [] }]), /no Core step to resolve/u);
  await assert.rejects(prepare([core, { ...consumer, dependsOn: [] }]), /must depend on the Core/u);
});

test("the cutover manifest is generated from the checked-in profiles: Core first, every D1 consumer after it, callees before callers where possible", async () => {
  const { validateTrainManifest } = await import("../scripts/release-pipeline.mjs");
  const { buildCoreTrainManifest } = await import("../scripts/control-core-manifest.mjs");
  for (const environment of ["development", "production"]) {
    const manifest = await buildCoreTrainManifest({
      repositoryRoot: SOURCE,
      environment,
      accountId: "00000000000000000000000000000001",
      sourceCommit: SHA,
      core: core(environment),
      rehearsal: "/private/rehearsal.json",
      imagesDirectory: "/private/images",
      ...productionReference(environment),
      also: [
        environment === "development"
          ? "apps/wfp-dispatch/wrangler.shared.jsonc"
          : "apps/wfp-dispatch/wrangler.production.shared.jsonc",
      ],
      workerExists: async () => true,
    });
    validateTrainManifest(manifest);
    const [first, ...consumers] = manifest.steps;
    const brokerName = `ohmyho-connection-broker-${environment}`;
    assert.deepEqual(
      manifest.steps.filter((step) => step.workerName === brokerName).map((step) => step.config),
      [`apps/connection-broker/wrangler.${environment}.jsonc`],
    );
    assert.equal(
      new Set(manifest.steps.map((step) => step.workerName)).size,
      manifest.steps.length,
    );
    assert.ok(
      manifest.steps.every((step) => !/wrangler\.(?:observer|bootstrap)\./u.test(step.config)),
    );
    assert.equal(first.id, "core");
    assert.equal(first.workerName, CONTROL_CORE_WORKER_PROFILES[environment]);
    assert.deepEqual(first.core, core(environment));
    assert.ok(consumers.length >= 15);
    const position = new Map(manifest.steps.map((step, index) => [step.id, index]));
    for (const step of consumers) {
      assert.equal(step.core, undefined);
      assert.ok(step.dependsOn.includes("core"));
      assert.ok(step.dependsOn.every((id) => position.get(id) < position.get(step.id)));
      assert.equal(
        step.configSha256,
        releaseHash(await readFile(join(SOURCE, step.config))),
        step.config,
      );
    }
    const gatewayName =
      environment === "development"
        ? "ohmyho-gateway-poc-private-fullstack"
        : "ohmyho-gateway-production";
    const controlName =
      environment === "development"
        ? "ohmyho-control-api-poc-private-fullstack"
        : "ohmyho-control-api-production";
    const gatewayStep = manifest.steps.find((step) => step.workerName === gatewayName),
      controlStep = manifest.steps.find((step) => step.workerName === controlName);
    assert.ok(gatewayStep && controlStep);
    const rendered = {};
    for (const step of [gatewayStep, controlStep])
      rendered[step.id] = {
        configuration: parseJsonc(await readFile(join(SOURCE, step.config), "utf8")),
      };
    assert.doesNotThrow(() => requireAtomicDevGatewayChain({ manifest, workers: rendered }));
    // The credit-service (once its app is checked in) and the Control API are both in the train, with the Core as their ancestor.
    for (const config of [
      ...(existsSync(join(SOURCE, `apps/credit-service/wrangler.${environment}.jsonc`))
        ? [`apps/credit-service/wrangler.${environment}.jsonc`]
        : []),
      environment === "development"
        ? "apps/control-api/wrangler.jsonc"
        : "apps/control-api/wrangler.production.jsonc",
    ])
      assert.ok(
        manifest.steps.some((step) => step.config === config),
        config,
      );
  }
});

test("the credit service is an ordinary step when its Worker exists and a closed private creation when it does not, after the Core and the collectors it binds", async () => {
  const { validateTrainManifest } = await import("../scripts/release-pipeline.mjs");
  const { buildCoreTrainManifest, providerWorkerExists } = await import(
    "../scripts/control-core-manifest.mjs"
  );
  const { PRIVATE_WORKER_PROFILES, privateWorkerDefinition } = await import(
    "../scripts/release-private-worker.mjs"
  );
  const { WorkerPresenceUnavailableError } = await import("../scripts/release-worker-presence.mjs");
  const base = (environment) => ({
    repositoryRoot: SOURCE,
    environment,
    accountId: "00000000000000000000000000000001",
    sourceCommit: SHA,
    core: core(environment),
    rehearsal: "/private/rehearsal.json",
    imagesDirectory: "/private/images",
    ...productionReference(environment),
  });
  for (const environment of ["development", "production"]) {
    const { name, config } = PRIVATE_WORKER_PROFILES[environment].credit_service;
    const asked = [];
    const absent = await buildCoreTrainManifest({
      ...base(environment),
      workerExists: async (workerName) => {
        asked.push(workerName);
        return false;
      },
      ...(environment === "production"
        ? {
            developmentReference: {
              manifest: "/private/dev.json",
              state: "/private/dev-state.json",
            },
          }
        : {}),
    });
    // Only the Worker of a closed creation profile is looked up; every other step stays an ordinary update.
    assert.deepEqual(asked, [name]);
    assert.equal(validateTrainManifest(absent), absent);
    const [creation, ...others] = absent.steps.filter(({ workerName }) => workerName === name);
    assert.equal(others.length, 0);
    assert.deepEqual(
      { ...creation, creationId: undefined, dependsOn: undefined, configSha256: undefined },
      {
        id: `credit-service-${environment}`,
        kind: "worker",
        config,
        configSha256: undefined,
        workerName: name,
        dependsOn: undefined,
        action: "create_private",
        creationId: undefined,
        profile: "credit_service",
      },
    );
    assert.match(creation.creationId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u);
    assert.equal(creation.configSha256, releaseHash(await readFile(join(SOURCE, config))));
    assert.equal(absent.steps.filter(({ action }) => action !== undefined).length, 1);
    assert.equal(privateWorkerDefinition({ environment, profile: "credit_service" }).name, name);

    // Order: the Core, then the two collectors it binds, then the credit service, all before the Control API.
    const position = new Map(absent.steps.map((step, index) => [step.id, index]));
    const named = (workerName) => absent.steps.find((step) => step.workerName === workerName);
    const collectors = ["neon-management", "r2-management"].map((app) =>
      absent.steps.find(({ config: path }) => path.startsWith(`apps/${app}/`)),
    );
    assert.ok(collectors.every(Boolean));
    assert.deepEqual(creation.dependsOn.sort(), ["core", ...collectors.map(({ id }) => id)].sort());
    const control = absent.steps.find(({ config: path }) => path.startsWith("apps/control-api/"));
    assert.ok(control.dependsOn.includes(creation.id));
    assert.ok(position.get(creation.id) < position.get(control.id));
    assert.ok(collectors.every(({ id }) => position.get(id) < position.get(creation.id)));
    assert.equal(position.get("core"), 0);

    // The Metering Workers are gone from the topology: no step, no policy consumer, no creation profile.
    assert.ok(
      absent.steps.every(
        ({ workerName, config: path }) => !/metering/u.test(`${workerName}${path}`),
      ),
    );
    assert.deepEqual(Object.keys(PRIVATE_WORKER_PROFILES[environment]).sort(), [
      "connection_broker",
      "credit_service",
    ]);
    assert.equal(named(CONTROL_CORE_WORKER_PROFILES[environment]).id, "core");

    // Credit is an ordinary update; the complete Preview cohort still pins Production to its Development train.
    const present = await buildCoreTrainManifest({
      ...base(environment),
      workerExists: async () => true,
    });
    const ordinary = present.steps.find(({ workerName }) => workerName === name);
    assert.deepEqual(Object.keys(ordinary).sort(), [
      "config",
      "configSha256",
      "dependsOn",
      "id",
      "kind",
      "workerName",
    ]);
    assert.deepEqual(
      present.steps.map(({ id }) => id),
      absent.steps.map(({ id }) => id),
    );
    validateTrainManifest(present);
    assert.deepEqual(
      present.developmentReference,
      productionReference(environment).developmentReference,
    );
  }
  // Production creates only with the completed Development train named, and never guesses presence.
  await assert.rejects(
    buildCoreTrainManifest({
      ...base("production"),
      developmentReference: undefined,
      workerExists: async () => false,
    }),
    /Development creation reference/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({
      ...base("development"),
      workerExists: async () => true,
      developmentReference: { manifest: "/private/dev.json", state: "/private/dev-state.json" },
    }),
    /Production creation requires/u,
  );
  await assert.rejects(buildCoreTrainManifest(base("development")), /needs the live presence/u);
  await assert.rejects(
    buildCoreTrainManifest({
      ...base("development"),
      workerExists: async () => {
        throw new WorkerPresenceUnavailableError();
      },
    }),
    /cannot be confirmed/u,
  );

  // The provider answer: the typed missing-Worker 404 is absence, a listing is presence, everything else throws.
  const answers = new Map();
  const exists = providerWorkerExists({
    accountId: ACCOUNT,
    token: "fixture-token",
    fetcher: async (url, init) => {
      assert.equal(init.headers.authorization, "Bearer fixture-token");
      assert.equal(init.redirect, "error");
      return answers.get(new URL(url).pathname.split("/")[7]);
    },
  });
  const worker = PRIVATE_WORKER_PROFILES.development.credit_service.name;
  answers.set(
    worker,
    Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 }),
  );
  assert.equal(await exists(worker), false);
  answers.set(worker, Response.json({ success: true, result: { items: [{ id: "v" }] } }));
  assert.equal(await exists(worker), true);
  for (const unavailable of [
    Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }),
    Response.json({ success: false, errors: [{ code: 7003 }] }, { status: 404 }),
    Response.json({ success: true, result: { items: [] } }),
  ]) {
    answers.set(worker, unavailable);
    await assert.rejects(exists(worker), WorkerPresenceUnavailableError);
  }
});

test("a train creates a Core that is still absent: absence is observed, and the Core may appear only under its own step", async () => {
  const { closedTransition } = await import("../scripts/release-private-worker.mjs");
  const { observeReleaseIngress } = await import("../scripts/release-pipeline.mjs");
  const manifest = train([coreStep, consumerStep()]);
  const absent = {
    workerName: DEV_CORE,
    presence: { kind: "absent", accountId: ACCOUNT, workerName: DEV_CORE },
  };
  const present = {
    workerName: DEV_CORE,
    subdomain: { enabled: false, previews_enabled: false },
    crons: [],
  };
  const neighbour = {
    workerName: DEV_CONSUMER,
    subdomain: { enabled: false, previews_enabled: false },
    crons: [],
  };
  const snapshot = (...workers) => ({ domains: [], routes: [], workers });
  for (const region of ["us", "eu"]) {
    const workerName = `ohmyho-native-auth-development-${region}`;
    const nativeStep = {
      ...consumerStep(),
      id: `native-${region}`,
      workerName,
      config: `apps/native-auth-runtime/wrangler.development.${region}.jsonc`,
    };
    const nativeManifest = train([coreStep, nativeStep]);
    const missing = { workerName, presence: { kind: "absent", accountId: ACCOUNT, workerName } };
    const created = {
      workerName,
      subdomain: { enabled: false, previews_enabled: false },
      crons: [],
    };
    const nativeCheck = (live, status) =>
      closedTransition({
        baseline: snapshot(present, missing),
        observation: snapshot(present, live),
        manifest: nativeManifest,
        steps: status ? { [nativeStep.id]: { status } } : {},
      });
    assert.equal(nativeCheck(missing, undefined), true);
    assert.equal(nativeCheck(created, undefined), false);
    assert.equal(nativeCheck(created, "running"), true);
    assert.equal(nativeCheck(created, "completed"), true);
    assert.equal(nativeCheck(missing, "completed"), false);
    assert.equal(
      nativeCheck(
        { ...created, subdomain: { enabled: true, previews_enabled: false } },
        "completed",
      ),
      false,
    );
    assert.equal(nativeCheck({ ...created, crons: ["* * * * *"] }, "completed"), false);
  }
  const check = (observation, status, baseline = snapshot(absent, neighbour)) =>
    closedTransition({
      baseline,
      observation,
      manifest,
      steps: status === undefined ? {} : { core: { status } },
    });
  assert.equal(check(snapshot(absent, neighbour)), true);
  assert.equal(
    check(snapshot(absent, neighbour), "completed"),
    false,
    "a completed Core step cannot leave the Core absent",
  );
  assert.equal(check(snapshot(present, neighbour), "completed"), true);
  assert.equal(
    check(snapshot(present, neighbour), "running"),
    true,
    "a crash after the upload resumes",
  );
  assert.equal(
    check(snapshot(present, neighbour)),
    false,
    "a Core nobody's step created is a collision",
  );
  assert.equal(check(snapshot(absent, { ...neighbour, crons: ["* * * * *"] })), false);
  assert.equal(
    check(snapshot({ ...present, crons: ["* * * * *"] }, neighbour), "completed"),
    false,
  );
  assert.equal(
    check(
      snapshot({ ...present, subdomain: { enabled: true, previews_enabled: false } }, neighbour),
      "completed",
    ),
    false,
  );
  // An existing Core is an ordinary neighbour that must not change.
  assert.equal(
    check(snapshot(present, neighbour), "completed", snapshot(present, neighbour)),
    true,
  );
  assert.equal(
    check(
      snapshot({ ...present, crons: ["* * * * *"] }, neighbour),
      "completed",
      snapshot(present, neighbour),
    ),
    false,
  );

  // The real observer reports a missing Core as typed absence instead of failing its readback.
  const requests = [];
  const observed = await observeReleaseIngress({
    manifest: { ...train([coreStep]), accountId: ACCOUNT },
    run: async (command, args) => {
      assert.equal(command, "wrangler");
      assert.deepEqual(args, ["auth", "token", "--json"]);
      return JSON.stringify({ type: "api_token", token: "private-token" });
    },
    wrangler: "wrangler",
    fetch: async (url) => {
      const { pathname } = new URL(url);
      requests.push(pathname);
      if (pathname.endsWith(`/workers/scripts/${DEV_CORE}/versions`))
        return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
      return Response.json({ success: true, result: [], result_info: { total_pages: 0 } });
    },
  });
  assert.deepEqual(observed, { domains: [], routes: [], workers: [absent] });
  assert.ok(!requests.some((path) => path.includes(`/workers/services/${DEV_CORE}`)));
  for (const region of ["us", "eu"]) {
    const workerName = `ohmyho-native-auth-development-${region}`;
    const nativeStep = {
      ...consumerStep(),
      id: `native-${region}`,
      workerName,
      config: `apps/native-auth-runtime/wrangler.development.${region}.jsonc`,
    };
    const result = await observeReleaseIngress({
      manifest: train([nativeStep]),
      run: async () => JSON.stringify({ type: "api_token", token: "private-token" }),
      wrangler: "wrangler",
      fetch: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith(`/workers/scripts/${workerName}/versions`))
          return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
        return Response.json({ success: true, result: [], result_info: { total_pages: 0 } });
      },
    });
    assert.deepEqual(result, {
      domains: [],
      routes: [],
      workers: [{ workerName, presence: { kind: "absent", accountId: ACCOUNT, workerName } }],
    });
  }
});

test("a whole train creates absent Core and Native Workers and records their private appearance", async (context) => {
  const { executeReleaseTrain, releaseApprovalDigest } = await import(
    "../scripts/release-pipeline.mjs"
  );
  const directory = await mkdtemp(join(tmpdir(), "omh-core-create-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const nativeName = "ohmyho-native-auth-development-eu";
  const nativeStep = {
    ...consumerStep(),
    id: "native-eu",
    workerName: nativeName,
    config: "apps/native-auth-runtime/wrangler.development.eu.jsonc",
  };
  const manifest = train([coreStep, nativeStep]);
  const absent = {
    workerName: DEV_CORE,
    presence: { kind: "absent", accountId: ACCOUNT, workerName: DEV_CORE },
  };
  const present = {
    workerName: DEV_CORE,
    subdomain: { enabled: false, previews_enabled: false },
    crons: [],
  };
  const nativeAbsent = {
    workerName: nativeName,
    presence: { kind: "absent", accountId: ACCOUNT, workerName: nativeName },
  };
  const nativePresent = {
    workerName: nativeName,
    subdomain: { enabled: false, previews_enabled: false },
    crons: [],
  };
  const observations = [
    { domains: [], routes: [], workers: [absent, nativeAbsent] },
    { domains: [], routes: [], workers: [present, nativePresent] },
  ];
  const calls = [];
  const result = await executeReleaseTrain({
    manifest,
    statePath: join(directory, "state.json"),
    approval: releaseApprovalDigest({ manifest, preparationSha256: "d".repeat(64) }),
    environment: "development",
    cwd: "/repo",
    inspectRepository: async () => ({ repositoryRoot: "/repo", sha: SHA }),
    verifyCommit: async () => 42,
    prepare: async () => ({
      fingerprint: "d".repeat(64),
      workers: {
        core: { configuration: { workers_dev: false, preview_urls: false } },
        "native-eu": { configuration: { workers_dev: false, preview_urls: false } },
      },
    }),
    observeIngress: async () => observations.shift(),
    observePolicy: async () => ({ policySha256: "9".repeat(64), consumers: [] }),
    release: async ({ expectedName }) => {
      calls.push(expectedName);
      return {
        deploymentVerified: true,
        sha: SHA,
        workerName: expectedName,
        uploaded: true,
        versionId: "12345678-1234-4234-8234-123456789012",
        cronTriggers: "preserved",
        tag: `release-${SHA.slice(0, 12)}-core`,
        message: `origin/main ${SHA}; config core`,
      };
    },
  });
  assert.deepEqual(calls, [DEV_CORE, nativeName]);
  assert.deepEqual(result.completed, ["core", "native-eu"]);
  assert.equal(result.ingressAndSchedulesPreserved, true);
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(state.status, "completed");
  assert.equal(state.baseline.workers[0].presence.kind, "absent");
  assert.equal(state.after.workers[0].presence, undefined);
  assert.equal(state.baseline.workers[1].presence.kind, "absent");
  assert.equal(state.after.workers[1].presence, undefined);
  let writes = 0;
  await assert.rejects(
    executeReleaseTrain({
      manifest,
      statePath: join(directory, "unsafe-state.json"),
      approval: releaseApprovalDigest({ manifest, preparationSha256: "d".repeat(64) }),
      environment: "development",
      cwd: "/repo",
      inspectRepository: async () => ({ repositoryRoot: "/repo", sha: SHA }),
      verifyCommit: async () => 42,
      prepare: async () => ({
        fingerprint: "d".repeat(64),
        workers: {
          core: { configuration: { workers_dev: false, preview_urls: false } },
          "native-eu": { configuration: { workers_dev: true, preview_urls: false } },
        },
      }),
      observeIngress: async () => ({ domains: [], routes: [], workers: [absent, nativeAbsent] }),
      observePolicy: async () => ({ policySha256: "9".repeat(64), consumers: [] }),
      release: async () => {
        writes++;
        throw new Error("unexpected upload");
      },
    }),
    /Native regional Worker must have no ingress or schedules/u,
  );
  assert.equal(writes, 0);
});

test("a policy consumer is released from its checked-in profile or a private .env derivation beside it, never another file", async () => {
  const { assertPolicyStepConfigs, releasesPolicyConfig, requirePolicyCohort } = await import(
    "../scripts/release-policy-cohort.mjs"
  );
  const policy = "apps/control-api/wrangler.jsonc";
  assert.equal(releasesPolicyConfig(policy, policy), true);
  assert.equal(
    releasesPolicyConfig("apps/control-api/.env.w01-d1.development.control-api.json", policy),
    true,
  );
  for (const other of [
    "apps/control-api/wrangler.production.jsonc",
    "apps/control-api/.env.json.bak",
    "apps/control-api/sub/.env.x.json",
    "apps/billing/.env.w01-d1.development.control-api.json",
    "../apps/control-api/.env.x.json",
  ])
    assert.equal(releasesPolicyConfig(other, policy), false, other);
  const step = (config, workerName = "ohmyho-control-api-poc-private-fullstack") => ({
    ...consumerStep(),
    workerName,
    config,
  });
  const manifest = (steps) => ({ ...train(steps), accountId: "00000000000000000000000000000001" });
  // The manifest-time check: the derivation passes, every other file for a policy consumer is refused before any provider read.
  await assertPolicyStepConfigs({
    manifest: manifest([
      coreStep,
      step("apps/control-api/.env.w01-d1.development.control-api.json"),
    ]),
  });
  await assert.rejects(
    assertPolicyStepConfigs({
      manifest: manifest([coreStep, step("apps/billing/wrangler.jsonc")]),
    }),
    /must release apps\/control-api\/wrangler\.jsonc/u,
  );
  await assert.rejects(
    assertPolicyStepConfigs({
      manifest: manifest([{ ...coreStep, config: "apps/control-store/other.jsonc" }]),
    }),
    /must release apps\/control-store\/wrangler\.jsonc/u,
  );
  // And the cohort rule accepts the derivation as the release of a lagging consumer.
  const lagging = {
    policySha256: "9".repeat(64),
    consumers: [
      {
        environment: "development",
        workerName: "ohmyho-control-api-poc-private-fullstack",
        name: "ohmyho-control-api-poc-private-fullstack",
        config: policy,
        target: "9".repeat(64),
        live: "unknown",
      },
    ],
  };
  requirePolicyCohort({
    manifest: manifest([step("apps/control-api/.env.w01-d1.development.control-api.json")]),
    observation: lagging,
    phase: "before",
  });
  assert.throws(
    () =>
      requirePolicyCohort({
        manifest: manifest([step("apps/billing/wrangler.jsonc")]),
        observation: lagging,
        phase: "before",
      }),
    /add Worker steps for ohmyho-control-api-poc-private-fullstack/u,
  );
});

test("a D1 consumer is excluded from the manifest only while its Worker is absent live, and every other step stays as it was", async () => {
  const { buildCoreTrainManifest } = await import("../scripts/control-core-manifest.mjs");
  const { PRIVATE_WORKER_PROFILES } = await import("../scripts/release-private-worker.mjs");
  const base = (environment) => ({
    repositoryRoot: SOURCE,
    environment,
    accountId: "00000000000000000000000000000001",
    sourceCommit: SHA,
    core: core(environment),
    rehearsal: "/private/rehearsal.json",
    imagesDirectory: "/private/images",
    ...productionReference(environment),
  });
  for (const environment of ["development", "production"]) {
    const config = `apps/ai-gateway/wrangler.${environment}.jsonc`;
    const name = `ohmyho-ai-gateway${environment === "development" ? "-poc-private-fullstack" : "-production"}`;
    const credit = PRIVATE_WORKER_PROFILES[environment].credit_service.name;
    const full = await buildCoreTrainManifest({
      ...base(environment),
      workerExists: async (workerName) => workerName !== name,
    });
    const asked = [];
    const excluded = await buildCoreTrainManifest({
      ...base(environment),
      exclude: [config],
      workerExists: async (workerName) => {
        asked.push(workerName);
        return workerName !== name;
      },
    });
    assert.equal(validateTrainManifest(excluded), excluded);
    assert.deepEqual(asked.sort(), [credit, name].sort());
    assert.ok(excluded.steps.every(({ workerName }) => workerName !== name));
    const step = full.steps.find((candidate) => candidate.config === config);
    assert.equal(step.id, `ai-gateway-${environment}`);
    assert.deepEqual(
      excluded.steps.map(({ id, dependsOn }) => ({ id, dependsOn })),
      full.steps
        .filter((candidate) => candidate !== step)
        .map(({ id, dependsOn }) => ({
          id,
          dependsOn: dependsOn.filter((dependency) => dependency !== step.id),
        })),
    );
    // Adding explicit non-consumers preserves the complete, environment-specific Core inventory.
    const also = ["build-runner", "source-fetcher", "wfp-management"].map(
      (app) => `apps/${app}/wrangler.${environment}.jsonc`,
    );
    const shaped = await buildCoreTrainManifest({
      ...base(environment),
      also,
      exclude: [config],
      workerExists: async (workerName) => workerName !== name,
    });
    assert.equal(validateTrainManifest(shaped), shaped);
    assert.deepEqual(
      shaped.steps.map((candidate) => candidate.config).sort(),
      [...new Set([...excluded.steps.map((candidate) => candidate.config), ...also])].sort(),
    );
    const databaseConfig = `apps/project-database-runtime/wrangler.${environment}.eu.jsonc`;
    const database = parseJsonc(await readFile(join(SOURCE, databaseConfig), "utf8"));
    const databaseBindsCore = database.services.some(
      ({ service }) => service === CONTROL_CORE_WORKER_PROFILES[environment],
    );
    assert.equal(
      shaped.steps.filter((candidate) => candidate.config === databaseConfig).length,
      databaseBindsCore ? 1 : 0,
    );
    assert.equal(
      shaped.steps.filter(
        (step) => step.config === `apps/growth-analytics/wrangler.${environment}.jsonc`,
      ).length,
      1,
    );
    for (const app of ["browser-gateway", "next-cache"])
      assert.equal(
        shaped.steps.filter(
          (candidate) => candidate.config === `apps/${app}/wrangler.${environment}.jsonc`,
        ).length,
        1,
      );
    assert.ok(shaped.steps.every(({ workerName }) => workerName !== name));
  }
});

test("the exclusion refuses a Worker that exists live, an unknown or foreign configuration, and any use that is not a first creation", async () => {
  const { buildCoreTrainManifest } = await import("../scripts/control-core-manifest.mjs");
  const { PRIVATE_WORKER_PROFILES } = await import("../scripts/release-private-worker.mjs");
  const base = {
    repositoryRoot: SOURCE,
    environment: "development",
    accountId: "00000000000000000000000000000001",
    sourceCommit: SHA,
    core: core("development"),
    rehearsal: "/private/rehearsal.json",
    imagesDirectory: "/private/images",
  };
  const ai = "apps/ai-gateway/wrangler.development.jsonc";
  const credit = PRIVATE_WORKER_PROFILES.development.credit_service.config;
  const absent = async () => false;
  await assert.rejects(
    buildCoreTrainManifest({ ...base, exclude: [ai], workerExists: async () => true }),
    /exists live: release it in the train/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({
      ...base,
      exclude: ["apps/nope/wrangler.jsonc"],
      workerExists: absent,
    }),
    /Unknown Worker configuration for this environment/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({
      ...base,
      also: ["apps/nope/wrangler.jsonc"],
      workerExists: absent,
    }),
    /Unknown Worker configuration for this environment/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({
      ...base,
      exclude: [CONTROL_CORE_CONFIG],
      workerExists: absent,
    }),
    /Core cannot be excluded/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({
      ...base,
      exclude: ["apps/build-runner/wrangler.development.jsonc"],
      workerExists: absent,
    }),
    /Only Core consumers can be excluded/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({ ...base, exclude: [credit], workerExists: absent }),
    /private creation profile cannot be excluded/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({ ...base, also: [ai], exclude: [ai], workerExists: absent }),
    /both included and excluded/u,
  );
  await assert.rejects(
    buildCoreTrainManifest({ ...base, exclude: [ai] }),
    /needs the live presence of ohmyho-ai-gateway-poc-private-fullstack/u,
  );
});

test("the manifest command takes only known flags, each once, each with a value that is not a flag", async () => {
  const { parseManifestArguments } = await import("../scripts/control-core-manifest.mjs");
  const flags = parseManifestArguments([
    "--environment",
    "production",
    "--output",
    "/private/manifest.json",
    "--rehearsal",
    "/private/rehearsal.json",
    "--images",
    "/private/images",
    "--also",
    "apps/build-runner/wrangler.production.jsonc",
    "--exclude",
    "apps/ai-gateway/wrangler.production.jsonc",
    "--development-manifest",
    "/private/dev.json",
    "--development-state",
    "/private/dev-state.json",
    "--native-auth-launch-policy",
    "/private/native-policy.json",
    "--preview-secrets",
    "/private/preview-secrets.json",
  ]);
  assert.equal(flags.get("--environment"), "production");
  assert.equal(flags.get("--exclude"), "apps/ai-gateway/wrangler.production.jsonc");
  assert.equal(flags.get("--native-auth-launch-policy"), "/private/native-policy.json");
  assert.equal(flags.get("--preview-secrets"), "/private/preview-secrets.json");
  assert.equal(flags.size, 10);
  for (const argv of [
    ["--environment", "production", "--outptu", "/private/manifest.json"],
    ["--environment"],
    ["--environment", "production", "--environment", "development"],
    ["--environment", "--output", "/private/manifest.json"],
    ["--exclude", "--also"],
    ["--environment", "production", "--output", "/private/manifest.json"],
    ["--environment", "production", "--rehearsal", "/private/rehearsal.json"],
  ])
    assert.throws(
      () => parseManifestArguments(argv),
      /Usage: control-core-manifest\.mjs/u,
      argv[0],
    );
});

test("the Core manifest needs its rehearsal receipt and, for a Worker with containers, the images directory", async () => {
  const { buildCoreTrainManifest } = await import("../scripts/control-core-manifest.mjs");
  const base = {
    repositoryRoot: SOURCE,
    environment: "production",
    accountId: ACCOUNT,
    sourceCommit: SHA,
    core: core("production"),
    ...productionReference("production"),
    rehearsal: "/private/rehearsal.json",
    imagesDirectory: "/private/images",
    also: ["apps/build-runner/wrangler.production.jsonc"],
    workerExists: async () => true,
  };
  const manifest = await buildCoreTrainManifest(base);
  assert.equal(manifest.rehearsal, "/private/rehearsal.json");
  assert.ok(manifest.steps.some((step) => step.containerImages?.startsWith("/private/images/")));
  await assert.rejects(buildCoreTrainManifest({ ...base, rehearsal: undefined }), /rehearsal/u);
  await assert.rejects(buildCoreTrainManifest({ ...base, imagesDirectory: undefined }), /images/u);
});

test("Core launch policy is closed, scoped, rendered and bound to a fresh approval", async (context) => {
  const org = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    project = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const allow = { mode: "allowlist", projects: [{ organizationId: org, projectId: project }] };
  const base = train([coreStep]);
  for (const policy of [allow, { mode: "disabled" }, { mode: "password-general-availability" }])
    validateTrainManifest(train([{ ...coreStep, nativeAuthLaunchPolicy: policy }]));
  for (const policy of [
    null,
    {},
    { mode: "password-general-availability", projects: [] },
    { mode: "allowlist", projects: [{ organizationId: org, projectId: "bad" }] },
    { mode: "allowlist", projects: [{ organizationId: [org], projectId: project }] },
    { mode: "allowlist", projects: [{ organizationId: org, projectId: [project] }] },
    { mode: "allowlist", projects: [{ organizationId: {}, projectId: project }] },
    { mode: "allowlist", projects: [{ organizationId: org, projectId: 123 }] },
    { mode: "allowlist", projects: [{ organizationId: org, projectId: project, extra: true }] },
  ])
    assert.throws(() =>
      validateTrainManifest(train([{ ...coreStep, nativeAuthLaunchPolicy: policy }])),
    );
  assert.throws(() =>
    validateTrainManifest(train([coreStep, consumerStep({ nativeAuthLaunchPolicy: allow })])),
  );
  const changed = train([{ ...coreStep, nativeAuthLaunchPolicy: allow }]);
  assert.notEqual(manifestDigest(base), manifestDigest(changed));
  assert.notEqual(
    manifestDigest(changed),
    manifestDigest(
      train([{ ...coreStep, nativeAuthLaunchPolicy: { mode: "password-general-availability" } }]),
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), "omh-native-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const render = (policy) =>
    renderWranglerConfiguration({
      expectedName: DEV_CORE,
      outputPath: join(directory, "wrangler.json"),
      sourcePath: join(SOURCE, CONTROL_CORE_CONFIG),
      core: {
        accountId: ACCOUNT,
        sourceCommit: SHA,
        repositoryRoot: SOURCE,
        ...core(),
        nativeAuthLaunchPolicy: policy,
      },
    });
  const denied = await render(undefined),
    allowed = await render(allow),
    ga = await render({ mode: "password-general-availability" });
  assert.equal(denied.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY, '{"mode":"disabled"}');
  assert.equal(allowed.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY, JSON.stringify(allow));
  assert.equal(
    ga.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY,
    '{"mode":"password-general-availability"}',
  );
  assert.deepEqual(allowed.d1_databases, denied.d1_databases);
  assert.deepEqual(allowed.routes, []);
  assert.deepEqual(allowed.triggers, { crons: [] });
  assert.notEqual(releaseHash(JSON.stringify(allowed)), releaseHash(JSON.stringify(ga)));
});

test("completed Core readback refuses missing or changed private launch policy", async () => {
  const { configuration } = await controlCoreWorkerConfiguration({
    repositoryRoot: SOURCE,
    sourceCommit: SHA,
    environment: "development",
    accountId: ACCOUNT,
    databaseId: DATABASE,
    databaseName: core().databaseName,
    nativeAuthLaunchPolicy: { mode: "password-general-availability" },
  });
  const identity = workerReleaseIdentity({ sha: SHA, configuration });
  const receipt = {
    deploymentVerified: true,
    versionId: "11111111-2222-4333-8444-555555555555",
    workerName: DEV_CORE,
    sha: SHA,
    ...identity,
  };
  let bindings = [
    { name: "CONTROL_CORE", type: "d1", id: DATABASE },
    ...Object.entries(configuration.vars).map(([name, text]) => ({
      name,
      type: "plain_text",
      text,
    })),
  ];
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      configuration,
      repositoryRoot: SOURCE,
      sourceSha: SHA,
      wrangler: "wrangler",
      run: async (_command, args) =>
        args[0] === "versions"
          ? JSON.stringify({
              id: receipt.versionId,
              annotations: { "workers/tag": identity.tag, "workers/message": identity.message },
              resources: { bindings },
            })
          : JSON.stringify({ versions: [{ version_id: receipt.versionId, percentage: 100 }] }),
    });
  assert.equal(await verify(), true);
  bindings = bindings.filter((binding) => binding.name !== "CONTROL_NATIVE_AUTH_LAUNCH_POLICY");
  await assert.rejects(verify(), /binding is missing or ambiguous/u);
  bindings.push({
    name: "CONTROL_NATIVE_AUTH_LAUNCH_POLICY",
    type: "plain_text",
    text: '{"mode":"disabled"}',
  });
  await assert.rejects(verify(), /variable binding drifted/u);
});

test("all checked-in Native profiles prepare only for their pinned Cloudflare account", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omh-native-account-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["apps/control-store/src", "apps/native-auth-runtime/src"])
    await mkdir(join(root, directory), { recursive: true });
  const coreTemplate = await readFile(join(SOURCE, CONTROL_CORE_CONFIG));
  await writeFile(join(root, CONTROL_CORE_CONFIG), coreTemplate);
  await writeFile(
    join(root, "apps/control-store/src/worker-main.ts"),
    await readFile(join(SOURCE, "apps/control-store/src/worker-main.ts")),
  );
  await writeFile(
    join(root, "apps/native-auth-runtime/src/worker-main.ts"),
    "export default {};\n",
  );
  const accountId = "00000000000000000000000000000001";
  for (const environment of ["development", "production"]) {
    for (const region of ["eu", "us"]) {
      const config = `apps/native-auth-runtime/wrangler.${environment}.${region}.jsonc`;
      const source = await readFile(join(SOURCE, config), "utf8");
      const name = `ohmyho-native-auth-${environment}-${region}`;
      const run = async (bytes) => {
        await writeFile(join(root, config), bytes);
        return prepareReleaseTrain({
          run: reportedHead,
          readCorePin: async () => corePin,
          repositoryRoot: root,
          manifest: {
            schemaVersion: 1,
            sourceCommit: SHA,
            environment,
            accountId,
            steps: [
              {
                ...coreStep,
                workerName: CONTROL_CORE_WORKER_PROFILES[environment],
                core: core(environment),
                configSha256: releaseHash(coreTemplate),
              },
              {
                id: "native",
                kind: "worker",
                config,
                configSha256: releaseHash(bytes),
                workerName: name,
                dependsOn: ["core"],
              },
            ],
          },
        });
      };
      const rendered = (await run(source)).workers.native.configuration;
      assert.equal(rendered.account_id, accountId);
      for (const account of [undefined, "00000000000000000000000000000000", "b".repeat(32)]) {
        const bad = parseJsonc(source);
        if (account === undefined) delete bad.account_id;
        else bad.account_id = account;
        await assert.rejects(
          run(JSON.stringify(bad)),
          /another Cloudflare account|disabled placeholder/u,
        );
      }
    }
  }
});

test("the bounded PGCF Production profile remains discoverable but only matching full Native profiles enter Core trains", async (context) => {
  const { buildCoreTrainManifest, readEnvironmentProfiles } = await import(
    "../scripts/control-core-manifest.mjs"
  );
  const { extractResources } = await import("../scripts/check-documentation.mjs");
  const root = await mkdtemp(join(tmpdir(), "omh-pgcf-train-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bounded = "apps/neon-management/wrangler.pgcf.production.jsonc";
  const full = "apps/neon-management/wrangler.production.jsonc";
  const profiles = await policyConsumers({
    environment: "production",
    repositoryRoot: SOURCE,
    accountId: ACCOUNT,
  });
  for (const file of new Set([
    CONTROL_CORE_CONFIG,
    bounded,
    full,
    ...profiles.map(({ config }) => config),
    "apps/control-store/src/worker-main.ts",
  ])) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), await readFile(join(SOURCE, file)));
  }
  const originalBounded = parseJsonc(await readFile(join(root, bounded), "utf8"));
  const originalFull = parseJsonc(await readFile(join(root, full), "utf8"));
  const base = {
    repositoryRoot: root,
    environment: "production",
    accountId: originalBounded.account_id,
    sourceCommit: SHA,
    core: core("production"),
    rehearsal: "/private/rehearsal.json",
    imagesDirectory: "/private/images",
    workerExists: async () => true,
  };
  const discovered = await readEnvironmentProfiles({
    repositoryRoot: root,
    environment: "production",
  });
  assert.deepEqual(
    discovered
      .filter(({ configuration }) => configuration.name === originalBounded.name)
      .map(({ config }) => config)
      .sort(),
    [bounded, full].sort(),
  );
  assert.ok(
    extractResources(root, [bounded, full]).some(
      (resource) =>
        resource.file === bounded &&
        resource.kind === "worker" &&
        resource.target === "src/pgcf-worker-main.ts",
    ),
  );
  const manifest = await buildCoreTrainManifest(base);
  assert.equal(validateTrainManifest(manifest), manifest);
  assert.deepEqual(
    manifest.steps
      .filter(({ workerName }) => workerName === originalBounded.name)
      .map(({ config }) => config),
    [full],
  );
  for (const flag of ["also", "exclude"])
    await assert.rejects(
      buildCoreTrainManifest({ ...base, [flag]: [bounded] }),
      /bounded PGCF profile is a separate manual release/u,
    );
  for (const [file, change] of [
    [bounded, { name: "ohmyho-foreign-production" }],
    [bounded, { main: "src/other-worker.ts" }],
    [bounded, { account_id: "invalid" }],
    [bounded, { account_id: "b".repeat(32) }],
    [full, { name: "ohmyho-foreign-production" }],
    [full, { main: "src/other-worker.ts" }],
    [full, { account_id: "b".repeat(32) }],
    [
      full,
      {
        services: originalFull.services.filter(
          ({ binding }) => binding !== "NATIVE_AUTH_RESOURCE_RUNTIME",
        ),
      },
    ],
  ]) {
    const original = file === bounded ? originalBounded : originalFull;
    await writeFile(join(root, file), JSON.stringify({ ...original, ...change }));
    await assert.rejects(
      buildCoreTrainManifest(base),
      /bounded PGCF and full Production Worker profiles do not match/u,
    );
    await writeFile(join(root, file), JSON.stringify(original));
  }
  await rm(join(root, full));
  await assert.rejects(
    buildCoreTrainManifest(base),
    /bounded PGCF and full Production Worker profiles do not match/u,
  );
  await writeFile(join(root, full), JSON.stringify(originalFull));
  // The exception is scoped to the declared bounded profile, never arbitrary duplicates.
  const extra = "apps/neon-management/wrangler.unrelated.production.jsonc";
  await writeFile(join(root, extra), JSON.stringify(originalFull));
  await assert.rejects(
    buildCoreTrainManifest(base),
    /Release Worker scope, configuration or prerequisite dependency is invalid/u,
  );
  await rm(join(root, extra));
  await rm(join(root, bounded));
  assert.deepEqual(
    (await buildCoreTrainManifest(base)).steps
      .filter(({ workerName }) => workerName === originalBounded.name)
      .map(({ config }) => config),
    [full],
  );
  assert.throws(
    () =>
      validateTrainManifest(
        train([
          coreStep,
          consumerStep(),
          consumerStep({ id: "duplicate-worker", config: "apps/billing/wrangler.other.jsonc" }),
        ]),
      ),
    /Release Worker scope, configuration or prerequisite dependency is invalid/u,
  );
});

test("the bounded Domain keyring profile cannot enter or replace the full Native Production train", async (context) => {
  const { buildCoreTrainManifest, readEnvironmentProfiles } = await import(
    "../scripts/control-core-manifest.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "omh-domain-keyring-train-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bounded = "apps/cloudflare-domain-management/wrangler.keyring.production.jsonc";
  const full = "apps/cloudflare-domain-management/wrangler.production.jsonc";
  const profiles = await policyConsumers({
    environment: "production",
    repositoryRoot: SOURCE,
    accountId: ACCOUNT,
  });
  for (const file of new Set([
    CONTROL_CORE_CONFIG,
    full,
    ...profiles.map(({ config }) => config),
    "apps/control-store/src/worker-main.ts",
  ])) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), await readFile(join(SOURCE, file)));
  }
  const originalFull = parseJsonc(await readFile(join(root, full), "utf8"));
  const nativeBindings = new Set(["NATIVE_AUTH_ADMIN_US", "NATIVE_AUTH_ADMIN_EU"]);
  const originalBounded = {
    ...originalFull,
    main: "src/production-keyring-worker.ts",
    services: originalFull.services.filter(({ binding }) => !nativeBindings.has(binding)),
  };
  await writeFile(join(root, bounded), JSON.stringify(originalBounded));
  const base = {
    repositoryRoot: root,
    environment: "production",
    accountId: originalFull.account_id,
    sourceCommit: SHA,
    core: core("production"),
    rehearsal: "/private/rehearsal.json",
    imagesDirectory: "/private/images",
    workerExists: async () => true,
  };
  const discovered = await readEnvironmentProfiles({
    repositoryRoot: root,
    environment: "production",
  });
  assert.deepEqual(
    discovered
      .filter(({ configuration }) => configuration.name === originalFull.name)
      .map(({ config }) => config)
      .sort(),
    [bounded, full].sort(),
  );
  const manifest = await buildCoreTrainManifest(base);
  assert.deepEqual(
    manifest.steps
      .filter(({ workerName }) => workerName === originalFull.name)
      .map(({ config }) => config),
    [full],
  );
  for (const flag of ["also", "exclude"])
    await assert.rejects(
      buildCoreTrainManifest({ ...base, [flag]: [bounded] }),
      /bounded Domain keyring profile is a separate manual release/u,
    );
  // The manual exception cannot grant Native authority or retarget another existing service.
  await writeFile(
    join(root, bounded),
    JSON.stringify({ ...originalBounded, services: originalFull.services }),
  );
  await assert.rejects(
    buildCoreTrainManifest(base),
    /bounded Domain keyring and full Production Worker profiles do not match/u,
  );
  await writeFile(
    join(root, bounded),
    JSON.stringify({
      ...originalBounded,
      services: originalBounded.services.map((service, index) =>
        index === 0 ? { ...service, service: "foreign-production" } : service,
      ),
    }),
  );
  await assert.rejects(
    buildCoreTrainManifest(base),
    /bounded Domain keyring and full Production Worker profiles do not match/u,
  );
  await writeFile(
    join(root, bounded),
    JSON.stringify({ ...originalBounded, main: "src/worker-main.ts" }),
  );
  await assert.rejects(
    buildCoreTrainManifest(base),
    /bounded Domain keyring and full Production Worker profiles do not match/u,
  );
  await writeFile(join(root, bounded), JSON.stringify(originalBounded));
  await writeFile(
    join(root, full),
    JSON.stringify({ ...originalFull, services: originalBounded.services }),
  );
  await assert.rejects(
    buildCoreTrainManifest(base),
    /bounded Domain keyring and full Production Worker profiles do not match/u,
  );
  await writeFile(join(root, full), JSON.stringify(originalFull));
  await writeFile(
    join(root, bounded),
    JSON.stringify({ ...originalBounded, account_id: "invalid" }),
  );
  await assert.rejects(
    buildCoreTrainManifest(base),
    /bounded Domain keyring and full Production Worker profiles do not match/u,
  );
  await writeFile(join(root, bounded), JSON.stringify(originalBounded));
  const duplicate = "apps/cloudflare-domain-management/wrangler.unrelated.production.jsonc";
  await writeFile(join(root, duplicate), JSON.stringify(originalFull));
  await assert.rejects(
    buildCoreTrainManifest(base),
    /Release Worker scope, configuration or prerequisite dependency is invalid/u,
  );
});

test("atomic Dev gateway requires its exact same-environment Core and Control ancestors and bindings", () => {
  const control = {
    id: "control",
    kind: "worker",
    workerName: "ohmyho-control-api-poc-private-fullstack",
    dependsOn: ["core"],
  };
  const gateway = {
    id: "gateway",
    kind: "worker",
    workerName: "ohmyho-gateway-poc-private-fullstack",
    dependsOn: ["control"],
  };
  const manifest = { environment: "development", steps: [coreStep, control, gateway] };
  const workers = {
    gateway: {
      configuration: {
        name: gateway.workerName,
        vars: { DEV_AUTH_ATOMIC_MODE: "v1" },
        services: [
          { binding: "DEV_ACCESS", service: control.workerName, entrypoint: "DevAccessService" },
        ],
      },
    },
    control: {
      configuration: {
        name: control.workerName,
        services: [
          { binding: "DEV_ACCESS_RUNTIME", service: DEV_CORE, entrypoint: "DevAccessRuntime" },
        ],
      },
    },
  };
  assert.doesNotThrow(() => requireAtomicDevGatewayChain({ manifest, workers }));
  const explicitDefault = structuredClone({ manifest, workers });
  explicitDefault.workers.gateway.configuration.services[0].environment = "production";
  explicitDefault.workers.control.configuration.services[0].environment = "production";
  assert.doesNotThrow(() => requireAtomicDevGatewayChain(explicitDefault));
  for (const change of [
    (x) => {
      x.manifest.steps[2].dependsOn = ["core"];
    },
    (x) => {
      x.manifest.steps[1].dependsOn = [];
    },
    (x) => {
      x.manifest.steps.splice(1, 1);
    },
    (x) => {
      x.workers.gateway.configuration.services[0].service = "ohmyho-control-api-production";
    },
    (x) => {
      x.workers.gateway.configuration.services[0].entrypoint = "Wrong";
    },
    (x) => {
      x.workers.gateway.configuration.services[0].environment = "staging";
    },
    (x) => {
      x.workers.control.configuration.services[0].environment = "staging";
    },
    (x) => {
      x.workers.control.configuration.services[0].service = PROD_CORE;
    },
    (x) => {
      x.manifest.steps[0].workerName = PROD_CORE;
    },
    (x) => {
      x.workers.control.configuration.services[0].entrypoint = "Wrong";
    },
    (x) => {
      x.workers.gateway.configuration.vars.DEV_AUTH_ATOMIC_MODE = "bad";
    },
    (x) => {
      x.manifest.environment = "production";
    },
  ]) {
    const value = structuredClone({ manifest, workers });
    change(value);
    assert.throws(() => requireAtomicDevGatewayChain(value));
  }
  const legacy = structuredClone({ manifest, workers });
  delete legacy.workers.gateway.configuration.vars.DEV_AUTH_ATOMIC_MODE;
  legacy.manifest.steps[2].dependsOn = [];
  assert.doesNotThrow(() => requireAtomicDevGatewayChain(legacy));
});

test("a completed Core train is re-verified without the live Core head, and a resume checks only its unfinished Core step", async (context) => {
  const { executeReleaseTrain, releaseApprovalDigest } = await import(
    "../scripts/release-pipeline.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "omh-core-reverify-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/control-store/src"), { recursive: true });
  await writeFile(
    join(root, "apps/control-store/src/worker-main.ts"),
    await readFile(join(SOURCE, "apps/control-store/src/worker-main.ts")),
  );
  const template = await readFile(join(SOURCE, CONTROL_CORE_CONFIG));
  await writeFile(join(root, CONTROL_CORE_CONFIG), template);
  const manifest = {
    ...train([{ ...coreStep, configSha256: releaseHash(template) }]),
  };
  // The Worker rehearsal proof is outside this test: preparation runs over the same Core step without it.
  const prepareCore = (args, pin) =>
    prepareReleaseTrain({
      ...args,
      manifest: { ...args.manifest, rehearsal: undefined },
      readCorePin: async () => pin,
    });
  // A provider whose Core schema receipt names the given pin: the live head, which a later Core upgrade moves.
  const headRun = (pin) => async (_command, args) => {
    if (args[0] !== "d1") throw new Error(`unexpected ${args.join(" ")}`);
    return JSON.stringify([
      {
        success: true,
        results: [
          {
            command_id: "control-d1.schema:v1",
            name: "control-d1.schema",
            digest: sha256(Buffer.from(canonical(pin))),
            result: JSON.stringify({ schemaSha256: "e".repeat(64) }),
          },
        ],
      },
    ]);
  };
  // The source commit pins corePin; a later upgrade moved the live head past it.
  const newer = {
    ...corePin,
    migrations: [
      ...corePin.migrations,
      { name: "0691_later_migration.sql", sha256: "d".repeat(64) },
    ],
  };
  const statePath = join(root, "state.json");
  const absent = {
    workerName: DEV_CORE,
    presence: { kind: "absent", accountId: ACCOUNT, workerName: DEV_CORE },
  };
  const present = {
    workerName: DEV_CORE,
    subdomain: { enabled: false, previews_enabled: false },
    crons: [],
  };
  const fingerprint = (
    await prepareCore({ manifest, repositoryRoot: root, run: headRun(corePin) }, corePin)
  ).fingerprint;
  const approval = releaseApprovalDigest({ manifest, preparationSha256: fingerprint });
  let observations = [];
  let releases = 0;
  let verified = 0;
  const execute = (head) =>
    executeReleaseTrain({
      manifest,
      statePath,
      approval,
      environment: "development",
      cwd: root,
      inspectRepository: async () => ({ repositoryRoot: root, sha: SHA }),
      verifyCommit: async () => 42,
      run: headRun(head),
      prepare: (args) => prepareCore(args, corePin),
      observeIngress: async () => observations.shift(),
      observePolicy: async () => ({ policySha256: "9".repeat(64), consumers: [] }),
      release: async ({ expectedName }) => {
        releases++;
        return {
          deploymentVerified: true,
          sha: SHA,
          workerName: expectedName,
          uploaded: true,
          versionId: "12345678-1234-4234-8234-123456789012",
          cronTriggers: "preserved",
          tag: `release-${SHA.slice(0, 12)}-core`,
          message: `origin/main ${SHA}; config core`,
        };
      },
      verifyCompleted: async () => {
        verified++;
      },
    });
  // A fresh train still refuses a live head that is not the one its source pins.
  await assert.rejects(execute(newer), /TARGET_UNATTESTED/u);
  await assert.rejects(readFile(statePath));
  assert.equal(releases, 0);
  observations = [
    { domains: [], routes: [], workers: [absent] },
    { domains: [], routes: [], workers: [present] },
  ];
  await execute(corePin);
  assert.equal(releases, 1);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "completed");
  // Re-verifying the completed train against the newer live head does not refuse.
  observations = [
    { domains: [], routes: [], workers: [present] },
    { domains: [], routes: [], workers: [present] },
  ];
  await execute(newer);
  assert.equal(verified, 1);
  assert.equal(releases, 1);
  // A resume of an interrupted train whose Core step is already completed does not refuse either.
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = "interrupted";
  await writeFile(statePath, JSON.stringify(state));
  observations = [
    { domains: [], routes: [], workers: [present] },
    { domains: [], routes: [], workers: [present] },
  ];
  await execute(newer);
  assert.equal(verified, 2);
  assert.equal(releases, 1);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "completed");
});
