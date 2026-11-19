/* global Headers, Response, process, structuredClone */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { inspect } from "node:util";
import {
  assertForwardProgress,
  describePrivateApproval,
  PRIVATE_WORKER_PROFILES,
  PROTECTED_CONTROL,
  privateWorkerBindingInventory,
  validateCreationProgress,
  validatePrivateWorkerConfiguration,
  validatePreviewRuntimeConfiguration,
  closedTransition,
  verifyExactVersionBindings,
} from "../scripts/release-private-worker.mjs";
import {
  createWorkerPresenceObserver,
  classifyWorkerAbsence,
  observeWorkerCommand,
  WorkerAbsentError,
  WorkerPresenceUnavailableError,
  workerVersionsArguments,
} from "../scripts/release-worker-presence.mjs";
import {
  executeReleaseTrain,
  manifestDigest,
  observeReleaseIngress,
  prepareReleaseTrain,
  releaseApprovalDigest,
  runReleaseCommand,
  validateTrainManifest,
  validateCreationProfileCorrespondence,
  verifyCompletedStep,
} from "../scripts/release-pipeline.mjs";
import { canonical, sha256 } from "../scripts/control-d1-codec.mjs";
import {
  parseJsonc,
  renderWranglerConfiguration,
  workerReleaseIdentity,
} from "../scripts/platform-release.mjs";
import { releaseHash } from "../scripts/release-rehearsal-artifacts.mjs";
import { rehearseRelease } from "../scripts/release-rehearse.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);
const ACCOUNT = "00000000000000000000000000000001";
const TOKEN = "wrangler-login-token-never-retained";
const ZONE = "c".repeat(32);
const POLICY = "9".repeat(64);
// The credit-service binds the environment's Core, so every creation train carries the Core Worker step first.
const CORE = {
  development: "ohmyho-control-store-poc-private-fullstack",
  production: "ohmyho-control-store-production",
};
const CORE_DATABASE = "55555555-5555-4555-8555-555555555555";
// The Core schema head the fixture source pins; the provider's Core schema receipt names the same head.
const CORE_PIN = {
  layout: "shared-core-v1",
  revision: SHA,
  migrations: [{ name: "0690_project_handle_releases.sql", sha256: "b".repeat(64) }],
};
const CREATION = {
  development: { credit_service: "11111111-1111-4111-8111-111111111111" },
  production: { credit_service: "33333333-3333-4333-8333-333333333333" },
};
// The closed profile: the hourly usage run and the daily log rotation, the Core entrypoint, both provider collectors
// and the two EU R2 buckets, per environment.
const CRONS = ["0 0 * * *", "27,57 * * * *"];
const PROVIDERS = {
  development: {
    neon: "ohmyho-neon-management-poc-private-fullstack",
    r2: "ohmyho-r2-management-poc-private-fullstack",
  },
  production: {
    neon: "ohmyho-neon-management-production",
    r2: "ohmyho-r2-management-production",
  },
};
const SERVICES = (environment) => [
  { binding: "CREDIT_RUNTIME", service: CORE[environment], entrypoint: "CreditRuntime" },
  {
    binding: "NEON_USAGE",
    service: PROVIDERS[environment].neon,
    entrypoint: "NeonUsageService",
  },
  { binding: "R2_USAGE", service: PROVIDERS[environment].r2, entrypoint: "R2ManagementService" },
];
const BUCKETS = (environment) => [
  { binding: "USAGE_LOGS", bucket_name: `ohmyho-usage-${environment}`, jurisdiction: "eu" },
  { binding: "CREDIT_LOG", bucket_name: `ohmyho-credit-log-${environment}`, jurisdiction: "eu" },
];
const creditServiceConfiguration = (environment) =>
  `${JSON.stringify(
    {
      name: NAME(environment, "credit_service"),
      main: "src/worker-main.ts",
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: true, head_sampling_rate: 1 },
      vars: { CREDIT_ENVIRONMENT: environment },
      triggers: { crons: CRONS },
      account_id: ACCOUNT,
      services: SERVICES(environment),
      r2_buckets: BUCKETS(environment),
    },
    null,
    2,
  )}\n`;
const CONTROL = {
  development: PROTECTED_CONTROL.development.name,
  production: PROTECTED_CONTROL.production.name,
};
const NAME = (environment, profile) => PRIVATE_WORKER_PROFILES[environment][profile].name;
const readState = async (path) => JSON.parse(await readFile(path, "utf8"));

/** A deterministic Cloudflare account: the Wrangler CLI and the REST API share one state. */
function createProvider() {
  const provider = {
    workers: new Map(),
    log: [],
    counts: { deployCommands: 0, deploys: 0, secretUploads: 0, puts: 0 },
    secretPaths: [],
    domains: [],
    routes: [],
    appliesCrons: true,
    deployFaults: new Map(),
    putFaults: new Set(),
    strandedPuts: new Set(),
  };
  const pending = new Map();
  const pendingSchedules = new Map();
  const listFaults = [];
  let sequence = 0;
  const versionId = () => `${String(++sequence).padStart(8, "0")}-2222-4333-8444-555555555555`;
  provider.worker = (overrides = {}) => {
    const id = versionId();
    return {
      versions: [{ id, annotations: {}, resources: { bindings: [] } }],
      deployment: [{ version_id: id, percentage: 100 }],
      crons: [],
      subdomain: { enabled: false, previews_enabled: false },
      ...overrides,
    };
  };
  for (const environment of ["development", "production"]) {
    provider.workers.set(CONTROL[environment], provider.worker({ crons: ["*/5 * * * *"] }));
    provider.domains.push({
      id: `domain-${environment}`,
      hostname: `${environment}.control.example.test`,
      service: CONTROL[environment],
      environment: "production",
      zone_id: ZONE,
    });
    provider.routes.push({
      id: (environment === "development" ? "1" : "2").repeat(32),
      pattern: `${environment}.api.example.test/*`,
      script: CONTROL[environment],
    });
  }
  for (const name of Object.values(CORE)) provider.workers.set(name, provider.worker());
  provider.workers.set("ohmyho-other-production", provider.worker({ crons: ["0 * * * *"] }));
  provider.domains.push({
    id: "domain-other",
    hostname: "other.example.test",
    service: "ohmyho-other-production",
    environment: "production",
    zone_id: ZONE,
  });
  provider.routes.push({
    id: "3".repeat(32),
    pattern: "other.example.test/*",
    script: "ohmyho-other-production",
  });

  provider.failList = (name, nth) => listFaults.push({ name, nth, seen: 0 });
  provider.land = (name) => {
    pending.get(name)();
    pending.delete(name);
  };
  provider.landSchedule = (name) => {
    pendingSchedules.get(name)();
    pendingSchedules.delete(name);
  };
  provider.foreign = (name, { split = false } = {}) => {
    const worker = provider.workers.get(name);
    const id = versionId();
    worker.versions.push({
      id,
      annotations: {
        "workers/tag": "foreign",
        "workers/message": "deployed by another administrator",
      },
      resources: worker.versions[0].resources,
    });
    worker.deployment = split
      ? [
          { version_id: worker.versions[0].id, percentage: 50 },
          { version_id: id, percentage: 50 },
        ]
      : [{ version_id: id, percentage: 100 }];
  };
  provider.snapshot = (name) => structuredClone(provider.workers.get(name));
  provider.restore = (name, snapshot) => provider.workers.set(name, structuredClone(snapshot));

  const stage = async (args) => {
    const flag = (name) => args[args.indexOf(name) + 1];
    const name = flag("--name");
    const config = JSON.parse(await readFile(flag("--config"), "utf8"));
    const secretsPath = args.includes("--secrets-file") ? flag("--secrets-file") : null;
    let secretNames = [];
    if (secretsPath !== null) {
      provider.secretPaths.push(secretsPath);
      assert.equal((await stat(secretsPath)).mode & 0o077, 0);
      secretNames = Object.keys(JSON.parse(await readFile(secretsPath, "utf8")));
    }
    const bindings = [
      ...Object.entries(config.vars ?? {}).map(([key, value]) =>
        typeof value === "string"
          ? { name: key, type: "plain_text", text: value }
          : { name: key, type: "json", json: value },
      ),
      ...(config.services ?? []).map(({ binding, service, entrypoint }) => ({
        name: binding,
        type: "service",
        service,
        environment: "production",
        ...(entrypoint === undefined ? {} : { entrypoint }),
      })),
      ...(config.r2_buckets ?? []).map(({ binding, bucket_name, jurisdiction }) => ({
        name: binding,
        type: "r2_bucket",
        bucket_name,
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
      })),
      ...secretNames.map((secret) => ({ name: secret, type: "secret_text" })),
    ];
    const annotations = { "workers/tag": flag("--tag"), "workers/message": flag("--message") };
    return () => {
      provider.counts.deploys += 1;
      if (secretNames.length > 0) provider.counts.secretUploads += 1;
      const id = versionId();
      provider.workers.set(name, {
        versions: [{ id, annotations, resources: { bindings } }],
        deployment: [{ version_id: id, percentage: 100 }],
        crons: provider.appliesCrons ? [...(config.triggers?.crons ?? [])] : [],
        subdomain: {
          enabled: config.workers_dev === true,
          previews_enabled: config.preview_urls === true,
        },
      });
    };
  };

  provider.run = async (command, args, options = {}) => {
    provider.log.push(`${command} ${args.join(" ")}`);
    if (command === "pnpm") return "built";
    if (command === "git") {
      if (args[0] === "merge-base") {
        if (!provider.acceptAncestor) throw new Error("unrelated source");
        return "";
      }
      assert.equal(args[0], "status");
      return "";
    }
    assert.equal(command, "wrangler");
    if (args[0] === "d1")
      return JSON.stringify([
        {
          success: true,
          results: [
            {
              command_id: "control-d1.schema:v1",
              name: "control-d1.schema",
              digest: sha256(Buffer.from(canonical(CORE_PIN))),
              result: JSON.stringify({ schemaSha256: "e".repeat(64) }),
            },
          ],
        },
      ]);
    if (args.includes("--dry-run")) {
      assert.equal(options.localOnly, true);
      const rendered = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      const output = args[args.indexOf("--outdir") + 1];
      await mkdir(output, { mode: 0o700, recursive: true });
      const entry = join(output, "worker.js");
      await writeFile(entry, `export default {}; // ${rendered.name}\n`);
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({ outputs: { [entry]: { entryPoint: rendered.main } } }),
      );
      return "dry run";
    }
    if (args[0] === "auth") return JSON.stringify({ type: "oauth", token: TOKEN });
    const name = args[args.indexOf("--name") + 1];
    const worker = provider.workers.get(name);
    if (args[0] === "versions" && args[1] === "list") {
      for (const fault of listFaults) {
        if (fault.name !== name) continue;
        fault.seen += 1;
        if (fault.seen === fault.nth) throw new Error("network connection lost");
      }
      if (worker === undefined)
        throw new WorkerAbsentError({ accountId: ACCOUNT, workerName: name });
      return JSON.stringify(worker.versions.map(({ id, annotations }) => ({ id, annotations })));
    }
    if (args[0] === "versions" && args[1] === "view") {
      const version = worker?.versions.find(({ id }) => id === args[2]);
      if (version === undefined) throw new Error("unknown version");
      return JSON.stringify(version);
    }
    if (args[0] === "deployments" && args[1] === "status") {
      if (worker === undefined) throw new Error("unknown worker");
      return JSON.stringify({ versions: worker.deployment });
    }
    if (args[0] === "deploy") {
      provider.counts.deployCommands += 1;
      const apply = await stage(args);
      const fault = provider.deployFaults.get(name);
      provider.deployFaults.delete(name);
      if (fault === "stranded") {
        pending.set(name, apply);
        throw new Error("socket closed before the response");
      }
      apply();
      if (fault === "applied-lost") throw new Error("response lost after the upload");
      return "created and deployed";
    }
    throw new Error(`unexpected provider command ${command} ${args.join(" ")}`);
  };

  provider.fetch = async (url, init = {}) => {
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
    const method = init.method ?? "GET";
    const { pathname } = new URL(url);
    const ok = (result, extra = {}) =>
      Response.json({ success: true, errors: [], messages: [], result, ...extra });
    const missing = () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10007, message: "workers.api.error.script_not_found" }],
          messages: [],
          result: null,
        },
        { status: 404 },
      );
    const pages = { result_info: { total_pages: 1 } };
    if (pathname === `/client/v4/accounts/${ACCOUNT}/workers/domains`)
      return ok(provider.domains, pages);
    if (pathname === "/client/v4/zones")
      return ok([{ id: ZONE, name: "example.test", account: { id: ACCOUNT } }], pages);
    if (pathname === `/client/v4/zones/${ZONE}/workers/routes`) return ok(provider.routes, pages);
    const serviceMatch =
      /^\/client\/v4\/accounts\/([a-f0-9]{32})\/workers\/services\/([^/]+)(\/environments\/production\/routes)?$/u.exec(
        pathname,
      );
    if (serviceMatch !== null) {
      assert.equal(serviceMatch[1], ACCOUNT);
      const name = decodeURIComponent(serviceMatch[2]);
      if (!provider.workers.has(name)) return missing();
      if (serviceMatch[3] === undefined)
        return ok({
          id: name,
          default_environment: { environment: "production", script: { id: name } },
        });
      assert.equal(new URL(url).searchParams.get("show_zonename"), "true");
      return ok(
        provider.routes
          .filter((route) => route.script === name)
          .map((route) => ({
            ...route,
            zone_name: "example.test",
          })),
      );
    }
    const match =
      /^\/client\/v4\/accounts\/([a-f0-9]{32})\/workers\/scripts\/([^/]+)\/(versions|subdomain|schedules)$/u.exec(
        pathname,
      );
    assert.ok(match !== null && match[1] === ACCOUNT, pathname);
    const name = decodeURIComponent(match[2]);
    const worker = provider.workers.get(name);
    if (worker === undefined) return missing();
    if (match[3] === "versions") return ok({ items: worker.versions.map(({ id }) => ({ id })) });
    if (match[3] === "subdomain") return ok(worker.subdomain);
    if (method === "PUT") {
      provider.counts.puts += 1;
      provider.log.push(`PUT ${name} ${init.body}`);
      const apply = () => (worker.crons = JSON.parse(init.body).map(({ cron }) => cron));
      if (provider.strandedPuts.delete(name)) {
        pendingSchedules.set(name, apply);
        throw new Error("schedule request still has an unknown outcome");
      }
      apply();
      if (provider.putFaults.delete(name)) throw new Error("socket closed before the response");
    }
    return ok({ schedules: worker.crons.map((cron) => ({ cron })) });
  };
  return provider;
}

async function fixtureRepository(directory) {
  const repositoryRoot = join(directory, "repo");
  const configs = [
    ...Object.values(PRIVATE_WORKER_PROFILES.development),
    ...Object.values(PRIVATE_WORKER_PROFILES.production),
  ].map(({ config }) => config);
  // The authored profiles are copied byte for byte; only the runtime package is a fixture. The credit-service app is
  // built by its own lane: until its configurations are checked in, the closed profile itself stands in for them.
  for (const config of [
    ...configs,
    PROTECTED_CONTROL.development.config,
    PROTECTED_CONTROL.production.config,
  ]) {
    await mkdir(dirname(join(repositoryRoot, config)), { recursive: true });
    if (existsSync(join(ROOT, config)))
      await copyFile(join(ROOT, config), join(repositoryRoot, config));
    else
      await writeFile(
        join(repositoryRoot, config),
        creditServiceConfiguration(/wrangler\.(development|production)\.jsonc$/u.exec(config)[1]),
      );
  }
  await mkdir(join(repositoryRoot, "apps/control-store/src"), { recursive: true });
  await copyFile(
    join(ROOT, "apps/control-store/wrangler.jsonc"),
    join(repositoryRoot, "apps/control-store/wrangler.jsonc"),
  );
  await writeFile(
    join(repositoryRoot, "apps/control-store/package.json"),
    JSON.stringify({ name: "@ohmyhost/control-store" }),
  );
  await writeFile(
    join(repositoryRoot, "apps/control-store/src/worker-main.ts"),
    "export class CreditRuntime extends WorkerEntrypoint {}\nexport class ConnectionBrokerRuntime extends WorkerEntrypoint {}\nexport class ConnectionBrokerMaintenanceRuntime extends WorkerEntrypoint {}\n",
  );
  await mkdir(join(repositoryRoot, "apps/credit-service/src"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "apps/credit-service/package.json"),
    JSON.stringify({ name: "@ohmyhost/credit-service" }),
  );
  await writeFile(
    join(repositoryRoot, "apps/credit-service/src/worker-main.ts"),
    "export default {};\n",
  );
  await mkdir(join(repositoryRoot, "apps/connection-broker/src"), { recursive: true });
  await copyFile(
    join(ROOT, "apps/connection-broker/package.json"),
    join(repositoryRoot, "apps/connection-broker/package.json"),
  );
  await copyFile(
    join(ROOT, "apps/connection-broker/src/worker-main.ts"),
    join(repositoryRoot, "apps/connection-broker/src/worker-main.ts"),
  );
  return repositoryRoot;
}

const coreReceipt = (workerName, sha = SHA) => ({
  deploymentVerified: true,
  sha,
  workerName,
  uploaded: true,
  versionId: "66666666-6666-4666-8666-666666666666",
  cronTriggers: "preserved",
  tag: `release-${sha.slice(0, 12)}-core`,
  message: `origin/main ${sha}; config core`,
});

async function harness(context) {
  const directory = await mkdtemp(join(tmpdir(), "omh-private-worker-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["state", "artifacts-development", "artifacts-production"])
    await mkdir(join(directory, name), { mode: 0o700 });
  const repositoryRoot = await fixtureRepository(directory);
  const provider = createProvider();
  const manifestFor = async (environment, extra = {}) => {
    const profiles = PRIVATE_WORKER_PROFILES[environment];
    const creation = async (id, profile, dependsOn, more = {}) => ({
      id,
      kind: "worker",
      action: "create_private",
      profile,
      creationId: CREATION[environment][profile],
      config: profiles[profile].config,
      configSha256: releaseHash(await readFile(join(repositoryRoot, profiles[profile].config))),
      workerName: profiles[profile].name,
      dependsOn,
      ...more,
    });
    return {
      schemaVersion: 1,
      sourceCommit: SHA,
      environment,
      accountId: ACCOUNT,
      rehearsal: join(directory, "state", `rehearsal-${environment}.json`),
      steps: [
        {
          id: "core",
          kind: "worker",
          config: "apps/control-store/wrangler.jsonc",
          configSha256: releaseHash(
            await readFile(join(repositoryRoot, "apps/control-store/wrangler.jsonc")),
          ),
          workerName: CORE[environment],
          dependsOn: [],
          core: { databaseName: `ohmyho-control-core-${environment}`, databaseId: CORE_DATABASE },
        },
        await creation("credit-service", "credit_service", ["core"]),
      ],
      ...extra,
    };
  };
  const rehearse = (manifest) =>
    rehearseRelease({
      manifest,
      outputPath: manifest.rehearsal,
      artifactsDirectory: join(directory, `artifacts-${manifest.environment}`),
      cwd: repositoryRoot,
      run: provider.run,
      wrangler: "wrangler",
      inspect: async () => ({ repositoryRoot, sha: manifest.sourceCommit }),
    });
  const prepare = (manifest) =>
    prepareReleaseTrain({
      manifest,
      repositoryRoot,
      run: provider.run,
      wrangler: "wrangler",
      readCorePin: async () => CORE_PIN,
    });
  const approve = async (manifest) => {
    const prepared = await prepare(manifest);
    return {
      prepared,
      approval: releaseApprovalDigest({ manifest, preparationSha256: prepared.fingerprint }),
    };
  };
  const train = async (manifest, statePath, overrides = {}) => {
    const { approval } = await approve(manifest);
    return executeReleaseTrain({
      manifest,
      statePath,
      approval,
      environment: manifest.environment,
      cwd: repositoryRoot,
      run: provider.run,
      wrangler: "wrangler",
      env: {},
      fetch: provider.fetch,
      inspectRepository: async () => ({ repositoryRoot, sha: manifest.sourceCommit }),
      verifyCommit: async () => 42,
      observePolicy: async () => ({ policySha256: POLICY, consumers: [] }),
      // The Core release itself is qualified in the Core train tests; here it is an already released neighbour.
      release: async ({ expectedName }) => coreReceipt(expectedName, manifest.sourceCommit),
      verifyCompleted: async (context) =>
        context.step.id === "core" ? undefined : verifyCompletedStep(context),
      prepare: (args) =>
        prepareReleaseTrain({ ...args, wrangler: "wrangler", readCorePin: async () => CORE_PIN }),
      ...overrides,
    });
  };
  return { directory, repositoryRoot, provider, manifestFor, rehearse, prepare, approve, train };
}

test("the real subprocess adapter, authored profiles and preparation admit only a confirmed, closed private creation", async (context) => {
  const h = await harness(context);
  const creditName = NAME("development", "credit_service");
  const foreignName = NAME("production", "credit_service");

  // 1. The actual runReleaseCommand classifies a local fake executable BEFORE erasing stderr.
  const fake = join(h.directory, "fake-wrangler");
  await writeFile(
    fake,
    "#!/usr/bin/env node\nconst { code, stdout, stderr } = JSON.parse(process.env.FAKE_RESULT);\nprocess.stdout.write(stdout);\nprocess.stderr.write(stderr);\nprocess.exitCode = code;\n",
  );
  await chmod(fake, 0o755);
  const configPath = join(h.directory, "wrangler.json");
  const banner = " ⛅️ wrangler 4.145.0\n\n";
  const missing = `${banner}✘ [ERROR] A request to the Cloudflare API (/accounts/${ACCOUNT}/workers/scripts/${creditName}/versions) failed.\n\n  This Worker does not exist on your account. [code: 10007]\n`;
  const leak = "secret-token-value";
  const results = {
    absent: { code: 1, stdout: "", stderr: missing },
    authentication: {
      code: 1,
      stdout: "",
      stderr: `✘ [ERROR] Authentication error [code: 10000] ${leak}\n`,
    },
    genericNotFound: {
      code: 1,
      stdout: "",
      stderr: `✘ [ERROR] Not Found [code: 7003] ${leak}\n`,
    },
    mixedCodes: {
      code: 1,
      stdout: "",
      stderr: `${missing}✘ [ERROR] Authentication error [code: 10000]\n`,
    },
    mixedFailure: { code: 1, stdout: "", stderr: `${missing}fetch failed ${leak}\n` },
    foreignAccount: { code: 1, stdout: "", stderr: missing.replace(ACCOUNT, "f".repeat(32)) },
    foreignWorker: { code: 1, stdout: "", stderr: missing.replace(creditName, foreignName) },
    network: { code: 1, stdout: "", stderr: `fetch failed: ECONNREFUSED ${leak}\n` },
    timeout: { code: 1, stdout: "", stderr: `✘ [ERROR] The request timed out ${leak}\n` },
    silentFailure: { code: 1, stdout: "", stderr: "" },
    succeededWithDiagnostic: { code: 0, stdout: "", stderr: missing },
    malformed: { code: 0, stdout: `not json ${leak}`, stderr: "" },
    empty: { code: 0, stdout: "[]", stderr: "" },
  };
  const adapter = (result) => (command, args, options) =>
    runReleaseCommand(command, args, {
      ...options,
      env: { ...process.env, FAKE_RESULT: JSON.stringify(result) },
    });
  const observe = (result, name = creditName) =>
    observeWorkerCommand({
      run: adapter(result),
      wrangler: fake,
      accountId: ACCOUNT,
      workerName: name,
      configPath,
    });
  assert.deepEqual(await observe(results.absent), {
    kind: "absent",
    accountId: ACCOUNT,
    workerName: creditName,
  });
  const present = await observe({
    code: 0,
    stdout: JSON.stringify([{ id: "11111111-2222-4333-8444-555555555555" }]),
    stderr: "",
  });
  assert.equal(present.kind, "present");
  for (const [label, result] of Object.entries(results).filter(([label]) => label !== "absent"))
    await assert.rejects(
      observe(result),
      (error) =>
        error instanceof WorkerPresenceUnavailableError &&
        error.message === "Worker presence cannot be confirmed" &&
        !inspect(error, { depth: 10 }).includes(leak),
      label,
    );
  const probeEnv = (result) => ({ ...process.env, FAKE_RESULT: JSON.stringify(result) });
  const absent = await runReleaseCommand(
    fake,
    workerVersionsArguments({ workerName: creditName, configPath }),
    {
      env: probeEnv(results.absent),
      observeWorker: { accountId: ACCOUNT, workerName: creditName },
    },
  ).catch((error) => error);
  assert.ok(absent instanceof WorkerAbsentError);
  assert.deepEqual(Object.keys(absent).sort(), ["accountId", "name", "workerName"]);
  assert.equal(absent.cause, undefined);
  assert.ok(!inspect(absent, { depth: 10 }).includes("Cloudflare API"));
  // Only the exact scoped versions-list observation can become absence; anything else keeps the
  // generic erased failure, as does the same command outside an observation context.
  for (const [args, observeWorker] of [
    [
      ["deployments", "status", "--json", "--name", creditName, "--config", configPath],
      { accountId: ACCOUNT, workerName: creditName },
    ],
    [
      workerVersionsArguments({ workerName: creditName, configPath }),
      { accountId: ACCOUNT, workerName: foreignName },
    ],
    [workerVersionsArguments({ workerName: creditName, configPath }), undefined],
    [
      [...workerVersionsArguments({ workerName: creditName, configPath }), "--unexpected"],
      { accountId: ACCOUNT, workerName: creditName },
    ],
  ]) {
    const outcome = await runReleaseCommand(fake, args, {
      env: probeEnv(results.absent),
      observeWorker,
    }).catch((error) => error);
    assert.ok(!(outcome instanceof WorkerAbsentError));
    assert.equal(outcome.message, "Release command failed (1)");
  }

  // 2. A provider-body observer classifies the structured response before generic erasure.
  const body =
    (value, status = 200) =>
    () =>
      Promise.resolve(new Response(JSON.stringify(value), { status }));
  const probe = async (respond) =>
    (
      await createWorkerPresenceObserver({
        run: async () => JSON.stringify({ type: "api_token", token: TOKEN }),
        wrangler: "wrangler",
        fetch: respond,
      })
    )({ accountId: ACCOUNT, workerName: creditName });
  const missingBody = {
    success: false,
    errors: [{ code: 10007, message: "workers.api.error.script_not_found" }],
  };
  assert.equal((await probe(body(missingBody, 404))).kind, "absent");
  const regionalObserver = await createWorkerPresenceObserver({
    run: async () => JSON.stringify({ type: "api_token", token: TOKEN }),
    wrangler: "wrangler",
    fetch: body(missingBody, 404),
  });
  for (const environment of ["development", "production"]) {
    for (const region of ["us", "eu"]) {
      const workerName = `ohmyho-native-auth-${environment}-${region}`;
      assert.deepEqual(await regionalObserver({ accountId: ACCOUNT, workerName }), {
        kind: "absent",
        accountId: ACCOUNT,
        workerName,
      });
    }
  }
  for (const workerName of [
    "ohmyho-native-auth-production-ap",
    "ohmyhost-native-auth-production-us",
    "ohmyho-native-auth-production-eu-extra",
  ])
    await assert.rejects(
      regionalObserver({ accountId: ACCOUNT, workerName }),
      WorkerPresenceUnavailableError,
    );
  assert.equal(
    (await probe(body({ success: true, result: { items: [{ id: "x" }] } }))).kind,
    "present",
  );
  for (const respond of [
    body({ success: false, errors: [{ code: 7003 }] }, 404),
    body({ success: false, errors: [{ code: 10000 }] }, 403),
    body({ success: false, errors: [{ code: 10007 }, { code: 10000 }] }, 404),
    body(missingBody, 403),
    body({ success: true, result: { items: [] } }),
    body({ success: true, result: [] }),
    () => Promise.resolve(new Response("not json", { status: 404 })),
    () => Promise.reject(new Error(`socket hang up ${leak}`)),
  ])
    await assert.rejects(probe(respond), WorkerPresenceUnavailableError);
  await assert.rejects(
    createWorkerPresenceObserver({
      run: async () => `not a credential ${leak}`,
      wrangler: "wrangler",
      fetch: body(missingBody, 404),
    }),
    WorkerPresenceUnavailableError,
  );

  // 3. The real authored configs ARE the closed profiles; every widening is refused.
  const authored = {};
  for (const environment of ["development", "production"]) {
    const profile = "credit_service";
    const authoredPath = join(ROOT, PRIVATE_WORKER_PROFILES[environment][profile].config);
    const configuration = parseJsonc(
      existsSync(authoredPath)
        ? await readFile(authoredPath, "utf8")
        : creditServiceConfiguration(environment),
    );
    authored[environment] = configuration;
    validatePrivateWorkerConfiguration({ environment, profile, configuration });
    assert.equal(configuration.name, NAME(environment, profile));
    assert.equal(configuration.account_id, ACCOUNT);
    assert.equal(configuration.workers_dev, false);
    assert.equal(configuration.preview_urls, false);
    assert.equal(configuration.routes, undefined);
    assert.deepEqual([...configuration.triggers.crons].sort(), CRONS);
    // The inventory is the authored variables plus the exact Core, collector and bucket capabilities.
    const inventory = privateWorkerBindingInventory({ environment, profile, configuration });
    assert.deepEqual(
      inventory.filter(({ type }) => type === "service"),
      SERVICES(environment)
        .map(({ binding, service, entrypoint }) => ({
          name: binding,
          type: "service",
          service,
          entrypoint,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    );
    assert.deepEqual(
      inventory.filter(({ type }) => type === "r2_bucket"),
      BUCKETS(environment)
        .map(({ binding, ...bucket }) => ({ name: binding, type: "r2_bucket", ...bucket }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    );
    assert.deepEqual(
      inventory.filter(({ type }) => type === "plain_text" || type === "json"),
      Object.entries(configuration.vars)
        .map(([name, value]) =>
          typeof value === "string"
            ? { name, type: "plain_text", text: value }
            : { name, type: "json", json: value },
        )
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    );
    // Declaration order is free: the provider lists crons sorted and bindings by name.
    const shuffled = structuredClone(configuration);
    shuffled.triggers.crons.reverse();
    shuffled.services.reverse();
    shuffled.r2_buckets.reverse();
    validatePrivateWorkerConfiguration({ environment, profile, configuration: shuffled });
  }
  const bucket = (c, binding) => c.r2_buckets.find((entry) => entry.binding === binding);
  const service = (c, binding) => c.services.find((entry) => entry.binding === binding);
  const widenings = [
    (c) => (c.routes = [{ pattern: "credit.example.test/*", zone_name: "example.test" }]),
    (c) => (c.route = "credit.example.test/*"),
    (c) => (c.workers_dev = true),
    (c) => (c.preview_urls = true),
    (c) => (c.kv_namespaces = [{ binding: "CACHE", id: "a".repeat(32) }]),
    (c) => (c.durable_objects = { bindings: [{ name: "LOCK", class_name: "Lock" }] }),
    (c) => (c.migrations = [{ tag: "v1", new_classes: ["Lock"] }]),
    (c) => (c.queues = { consumers: [{ queue: "work" }] }),
    (c) => (c.ai = { binding: "AI" }),
    (c) => (c.d1_databases = [{ binding: "DB", database_id: "x" }]),
    (c) => (c.containers = [{ class_name: "Box", image: "./Dockerfile" }]),
    (c) => (c.assets = { directory: "public" }),
    (c) => (c.unsafe = { bindings: [] }),
    // Exactly the usage passes and the daily log rotation; the retired minute-7 usage run is refused.
    (c) => (c.triggers.crons = ["7 * * * *", "0 0 * * *"]),
    (c) => (c.triggers.crons = ["27,57 * * * *"]),
    (c) => (c.triggers.crons = ["0 0 * * *"]),
    (c) => (c.triggers.crons = ["* * * * *"]),
    (c) => (c.triggers.crons = ["27,57 * * * *", "0 0 * * *", "* * * * *"]),
    (c) => (c.triggers.crons = ["27,57 * * * *", "27,57 * * * *"]),
    (c) => (c.triggers.crons = []),
    (c) => delete c.triggers,
    // Exactly the two EU buckets, by name and jurisdiction.
    (c) => c.r2_buckets.push({ binding: "ARCHIVE", bucket_name: "archive", jurisdiction: "eu" }),
    (c) => delete c.r2_buckets,
    (c) => c.r2_buckets.pop(),
    (c) => (bucket(c, "USAGE_LOGS").bucket_name = "ohmyho-usage-production"),
    (c) => (bucket(c, "CREDIT_LOG").bucket_name = bucket(c, "USAGE_LOGS").bucket_name),
    (c) => delete bucket(c, "CREDIT_LOG").jurisdiction,
    (c) => (bucket(c, "CREDIT_LOG").jurisdiction = "us"),
    (c) => (bucket(c, "USAGE_LOGS").binding = "USAGE"),
    // The Core binding of this environment and its entrypoint are the whole profile.
    (c) => delete c.services,
    (c) => (service(c, "CREDIT_RUNTIME").service = CORE.production),
    (c) => (service(c, "CREDIT_RUNTIME").entrypoint = "ControlRuntime"),
    (c) => delete service(c, "CREDIT_RUNTIME").entrypoint,
    (c) => (service(c, "CREDIT_RUNTIME").binding = "CONTROL_RUNTIME"),
    (c) => c.services.push({ binding: "OTHER", service: CORE.development }),
    (c) => c.services.pop(),
    (c) => (service(c, "NEON_USAGE").service = PROVIDERS.production.neon),
    (c) => (service(c, "NEON_USAGE").entrypoint = "default"),
    (c) => (service(c, "NEON_USAGE").entrypoint = "R2ManagementService"),
    (c) => (service(c, "R2_USAGE").entrypoint = "default"),
    (c) => (c.vars.CREDIT_RUNTIME = "shadow"),
    (c) => (c.vars.NEON_USAGE = "shadow"),
    (c) => (c.vars.R2_USAGE = "shadow"),
    (c) => (c.vars.USAGE_LOGS = "shadow"),
    (c) => (c.vars.CREDIT_LOG = "shadow"),
    (c) => delete c.account_id,
    (c) => (c.name = NAME("production", "credit_service")),
    (c) => (c.placement = { region: "aws:eu-central-1", mode: "smart" }),
    (c) => (c.observability = { enabled: true, traces: { enabled: true } }),
  ];
  for (const mutate of widenings) {
    const configuration = structuredClone(authored.development);
    mutate(configuration);
    assert.throws(
      () =>
        validatePrivateWorkerConfiguration({
          environment: "development",
          profile: "credit_service",
          configuration,
        }),
      /closed capability profile/u,
      mutate.toString(),
    );
  }
  // The other environment's twin never validates as this environment's profile.
  assert.throws(
    () =>
      validatePrivateWorkerConfiguration({
        environment: "development",
        profile: "credit_service",
        configuration: authored.production,
      }),
    /closed capability profile/u,
  );
  const reused = { ...structuredClone(authored.development), no_bundle: true };
  validatePrivateWorkerConfiguration({
    environment: "development",
    profile: "credit_service",
    configuration: reused,
    rehearsed: true,
  });
  assert.throws(() =>
    validatePrivateWorkerConfiguration({
      environment: "development",
      profile: "credit_service",
      configuration: reused,
    }),
  );

  // Exact bindings: names alone are never value proof, and nothing extra is tolerated.
  const inventory = privateWorkerBindingInventory({
    environment: "development",
    profile: "credit_service",
    configuration: authored.development,
  });
  // The provider reports a service binding with its environment and a bucket with its jurisdiction.
  const reported = inventory.map((binding) =>
    binding.type === "service" ? { ...binding, environment: "production" } : { ...binding },
  );
  const reportedBinding = (name) => reported.find((binding) => binding.name === name);
  const variable = reported.find(({ type }) => type === "plain_text");
  verifyExactVersionBindings({ inventory, bindings: reported });
  verifyExactVersionBindings({ inventory, bindings: [...reported].reverse() });
  const without = (name) => reported.filter((binding) => binding.name !== name);
  const changed = (name, change) =>
    reported.map((binding) => (binding.name === name ? { ...binding, ...change } : binding));
  for (const bindings of [
    reported.slice(1),
    [
      ...reported,
      { name: "ARCHIVE", type: "r2_bucket", bucket_name: "archive", jurisdiction: "eu" },
    ],
    [...reported, { name: "EXTRA_SECRET", type: "secret_text" }],
    [...reported, reported[0]],
    [...reported, { name: "EXTRA", type: "mystery" }],
    changed(variable.name, { text: `${variable.text}-changed` }),
    changed(variable.name, { unexpected: true }),
    changed("CREDIT_RUNTIME", { entrypoint: "ControlRuntime" }),
    changed("CREDIT_RUNTIME", { entrypoint: "default" }),
    changed("CREDIT_RUNTIME", { service: CORE.production }),
    changed("CREDIT_RUNTIME", { environment: "staging" }),
    changed("NEON_USAGE", { entrypoint: "UnknownCollector" }),
    changed("NEON_USAGE", { entrypoint: "NeonManagementService" }),
    changed("NEON_USAGE", { entrypoint: "R2ManagementService" }),
    changed("NEON_USAGE", { service: PROVIDERS.production.neon }),
    changed("R2_USAGE", { entrypoint: "default" }),
    changed("USAGE_LOGS", { bucket_name: "ohmyho-usage-production" }),
    changed("CREDIT_LOG", { bucket_name: "ohmyho-credit-log-production" }),
    changed("CREDIT_LOG", { jurisdiction: "us" }),
    changed("CREDIT_LOG", { jurisdiction: undefined }),
    changed("CREDIT_LOG", { type: "d1" }),
    [...without("CREDIT_LOG"), { name: "CREDIT_LOG", type: "r2_bucket" }],
    [...without("USAGE_LOGS"), { ...reportedBinding("CREDIT_LOG"), name: "USAGE_LOGS" }],
  ])
    assert.throws(() => verifyExactVersionBindings({ inventory, bindings }), /closed inventory/u);

  // Ordinary identities are unchanged; a creation appends its ID to the message only.
  const plain = workerReleaseIdentity({ sha: SHA, configuration: { a: 1 }, rehearsal: undefined });
  const created = workerReleaseIdentity({
    sha: SHA,
    configuration: { a: 1 },
    rehearsal: undefined,
    creationId: CREATION.development.credit_service,
  });
  assert.equal(created.tag, plain.tag);
  assert.equal(
    created.message,
    `${plain.message}; creation ${CREATION.development.credit_service}`,
  );
  assert.equal(
    workerReleaseIdentity({
      sha: SHA,
      configuration: {},
      artifact: { digest: "d".repeat(64) },
      rehearsal: undefined,
      creationId: CREATION.development.credit_service,
    }).tag,
    "d".repeat(64),
  );
  assert.throws(
    () => workerReleaseIdentity({ sha: SHA, configuration: {}, creationId: "not-a-uuid" }),
    /creation identity/u,
  );

  // 4. The manifest can only select the checked-in profile, after the Core, over shared prerequisites.
  const manifest = await h.manifestFor("development");
  validateTrainManifest(manifest);
  const ordinary = {
    id: "plain",
    kind: "worker",
    config: "apps/billing/wrangler.jsonc",
    configSha256: "c".repeat(64),
    workerName: "ohmyho-billing-poc-private-fullstack",
    dependsOn: ["credit-service"],
  };
  validateTrainManifest({ ...manifest, steps: [...manifest.steps, ordinary] });
  const refusals = [
    // The creation is exactly the closed profile once, after the Core.
    (m) => (m.steps[1].dependsOn = []),
    (m) =>
      m.steps.push({ ...m.steps[1], id: "second", creationId: CREATION.production.credit_service }),
    (m) => m.steps.push({ ...m.steps[1], id: "same", dependsOn: ["credit-service"] }),
    (m) => (m.steps[1].profile = "metering_executor"),
    (m) => delete m.steps[1].profile,
    // The credit-service holds no secret: no creation step may declare a secret file.
    (m) => (m.steps[1].secretsFile = "/private/secrets.json"),
    (m) => delete m.steps[1].creationId,
    (m) => (m.steps[1].creationId = "not-a-uuid"),
    (m) => (m.steps[1].workerName = "ohmyho-credit-service-other-poc-private-fullstack"),
    (m) => (m.steps[1].workerName = NAME("production", "credit_service")),
    (m) => (m.steps[1].config = "apps/credit-service/wrangler.jsonc"),
    (m) => (m.steps[1].containerImages = "/private/images.json"),
    // The creation needs the Core step before it.
    (m) => {
      m.steps = m.steps.slice(1);
      m.steps[0].dependsOn = [];
    },
    (m) => {
      m.developmentReference = { manifest: "/private/dev.json", state: "/private/state.json" };
    },
    (m) => m.steps.push({ ...ordinary, profile: "credit_service" }),
    (m) => m.steps.push({ ...ordinary, action: "create_private" }),
  ];
  for (const refuse of refusals) {
    const candidate = structuredClone(manifest);
    refuse(candidate);
    assert.throws(() => validateTrainManifest(candidate), undefined, refuse.toString());
  }
  // A development reference without any creation is refused; no creation at all is an ordinary train.
  const ordinaryTrain = structuredClone(manifest);
  ordinaryTrain.steps.splice(1, 1);
  validateTrainManifest(ordinaryTrain);
  assert.throws(
    () =>
      validateTrainManifest({
        ...ordinaryTrain,
        developmentReference: { manifest: "/private/dev.json", state: "/private/state.json" },
      }),
    /needs a creation/u,
  );
  const production = await h.manifestFor("production");
  assert.throws(() => validateTrainManifest(production), /Development creation/u);
  assert.throws(() =>
    validateTrainManifest({
      ...production,
      developmentReference: { manifest: "relative.json", state: "/private/state.json" },
    }),
  );
  validateTrainManifest({
    ...production,
    developmentReference: { manifest: "/private/dev.json", state: "/private/state.json" },
  });

  // 5. Rehearsal is provider-free and fixes only the creation identity.
  const logStart = h.provider.log.length;
  await h.rehearse(manifest);
  assert.ok(
    h.provider.log
      .slice(logStart)
      .every((entry) => /^(?:pnpm|git) /u.test(entry) || entry.includes("--dry-run")),
  );
  assert.deepEqual(h.provider.counts, { deployCommands: 0, deploys: 0, secretUploads: 0, puts: 0 });
  const retained = await readState(manifest.rehearsal);
  assert.deepEqual(retained.workers["credit-service"].privateWorker, {
    profile: "credit_service",
    creationId: CREATION.development.credit_service,
  });

  // Preparation binds the Control source bytes and shows the whole creation scope.
  const { prepared, approval } = await h.approve(manifest);
  // The credit-service reaches Control only through the Core of its own environment.
  assert.deepEqual(
    prepared.workers["credit-service"].configuration.services.find(
      ({ binding }) => binding === "CREDIT_RUNTIME",
    ),
    SERVICES("development")[0],
  );
  const controlPath = join(h.repositoryRoot, PROTECTED_CONTROL.development.config);
  assert.deepEqual(prepared.protectedControl, {
    workerName: CONTROL.development,
    config: PROTECTED_CONTROL.development.config,
    configSha256: releaseHash(await readFile(controlPath)),
  });
  const scope = describePrivateApproval({ manifest, prepared });
  assert.equal(scope.protectedControl.workerName, CONTROL.development);
  assert.deepEqual(
    scope.creations.map(({ creationId, profile, cron, services, r2Buckets }) => ({
      creationId,
      profile,
      cron,
      services,
      r2Buckets,
    })),
    [
      {
        creationId: CREATION.development.credit_service,
        profile: "credit_service",
        cron: CRONS,
        services: SERVICES("development").map(({ binding, service, entrypoint }) => ({
          binding,
          target: service,
          entrypoint,
        })),
        r2Buckets: [
          { binding: "USAGE_LOGS", bucket: "ohmyho-usage-development", jurisdiction: "eu" },
          { binding: "CREDIT_LOG", bucket: "ohmyho-credit-log-development", jurisdiction: "eu" },
        ],
      },
    ],
  );
  const authoredControl = await readFile(controlPath);
  await writeFile(controlPath, Buffer.concat([authoredControl, Buffer.from("\n")]));
  assert.notEqual((await h.approve(manifest)).approval, approval);
  await writeFile(controlPath, authoredControl);
  assert.equal((await h.approve(manifest)).approval, approval);

  // A changed or missing proof identity refuses.
  const retainedText = await readFile(manifest.rehearsal, "utf8");
  for (const mutate of [
    (value) => delete value.workers["credit-service"].privateWorker,
    (value) => {
      value.workers["credit-service"].privateWorker.extra = true;
    },
    (value) => {
      value.workers["credit-service"].privateWorker.profile = "metering_executor";
    },
  ]) {
    const tampered = JSON.parse(retainedText);
    mutate(tampered);
    await writeFile(manifest.rehearsal, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(h.approve(manifest), /private profile (?:differs|is invalid)/u);
  }
  await writeFile(manifest.rehearsal, retainedText, { mode: 0o600 });
  await h.approve(manifest);

  // A widened authored config is refused before anything is built, bundled or prepared.
  const creditConfig = join(
    h.repositoryRoot,
    PRIVATE_WORKER_PROFILES.development.credit_service.config,
  );
  const authoredText = await readFile(creditConfig, "utf8");
  assert.ok(authoredText.includes('"vars": {'));
  await writeFile(
    creditConfig,
    authoredText.replace(
      '"vars": {',
      `"kv_namespaces": [{ "binding": "CACHE", "id": "${"a".repeat(32)}" }], "vars": {`,
    ),
  );
  const widened = await h.manifestFor("development", {
    rehearsal: join(h.directory, "state", "rehearsal-widened.json"),
  });
  const mark = h.provider.log.length;
  await assert.rejects(h.rehearse(widened), /closed capability profile/u);
  await assert.rejects(
    h.prepare({ ...widened, rehearsal: undefined }),
    /closed capability profile/u,
  );
  // The Core step before it is built; nothing of the widened credit-service is.
  assert.ok(!h.provider.log.slice(mark).some((entry) => /credit-service/u.test(entry)));
  await writeFile(creditConfig, authoredText);

  // 6. Presence is observed, never inferred: unavailable and malformed answers are errors.
  const reader = (bundle = manifest) =>
    observeReleaseIngress({
      manifest: bundle,
      run: h.provider.run,
      wrangler: "wrangler",
      fetch: h.provider.fetch,
    });
  const observed = await reader();
  assert.deepEqual(
    observed.workers.map(({ workerName, presence }) => [workerName, presence?.kind ?? "present"]),
    [
      [CONTROL.development, "present"],
      [CORE.development, "present"],
      [creditName, "absent"],
    ],
  );
  assert.deepEqual(
    observed.domains.map(({ service }) => service),
    [CONTROL.development],
  );
  assert.deepEqual(
    observed.routes.map(({ script }) => script),
    [CONTROL.development],
  );
  h.provider.workers.set(creditName, h.provider.worker({ subdomain: {} }));
  await assert.rejects(reader(), /ingress or schedules are invalid/u);
  h.provider.workers.delete(creditName);
  const control = h.provider.snapshot(CONTROL.development);
  h.provider.workers.delete(CONTROL.development);
  await assert.rejects(reader(), /readback failed/u);
  h.provider.restore(CONTROL.development, control);
  // An absent creation is not safe when an authoritative inventory retains its ingress.
  for (const kind of ["route", "domain"]) {
    const rows = kind === "route" ? h.provider.routes : h.provider.domains;
    rows.push(
      kind === "route"
        ? { id: "4".repeat(32), pattern: "orphan.example.test/*", script: creditName }
        : {
            id: "5".repeat(32),
            hostname: "orphan.example.test",
            service: creditName,
            environment: "production",
            zone_id: ZONE,
          },
    );
    await assert.rejects(reader(), /absent private Worker retains ingress/u);
    await assert.rejects(
      h.train(manifest, join(h.directory, "state", `orphan-${kind}.json`)),
      /absent private Worker retains ingress/u,
    );
    rows.pop();
    assert.deepEqual(h.provider.counts, {
      deployCommands: 0,
      deploys: 0,
      secretUploads: 0,
      puts: 0,
    });
  }
  const creationFetch = h.provider.fetch;
  h.provider.fetch = async (url, options) =>
    new URL(url).pathname === `/client/v4/zones/${ZONE}/workers/routes`
      ? new Response("zone route permission denied", { status: 403 })
      : creationFetch(url, options);
  await assert.rejects(reader(), /readback failed/u);
  await assert.rejects(
    h.train(manifest, join(h.directory, "state", "creation-route-denied.json")),
    /readback failed/u,
  );
  h.provider.fetch = creationFetch;
  assert.deepEqual(h.provider.counts, { deployCommands: 0, deploys: 0, secretUploads: 0, puts: 0 });

  // Durable progress only moves forward and never changes the facts it is bound to.
  const progress = {
    approvalSha256: approval,
    phase: "creating",
    uploadAttempted: true,
    originalPresence: { kind: "absent", accountId: ACCOUNT, workerName: creditName },
  };
  assertForwardProgress(undefined, progress);
  assertForwardProgress(progress, {
    ...progress,
    phase: "activating",
    versionId: "11111111-2222-4333-8444-555555555555",
  });
  for (const next of [
    { ...progress, phase: "prepared", uploadAttempted: false },
    { ...progress, approvalSha256: "e".repeat(64) },
  ])
    assert.throws(() => assertForwardProgress(progress, next), /roll back or change/u);
  const attemptedSchedule = {
    ...progress,
    phase: "activating",
    versionId: "11111111-2222-4333-8444-555555555555",
    cronAttempted: true,
  };
  assert.throws(
    () => assertForwardProgress(attemptedSchedule, { ...attemptedSchedule, cronAttempted: false }),
    /roll back or change/u,
  );
});

test("a real train persists creation intent, recovers ambiguous outcomes by readback and leaves Control and neighbours untouched", async (context) => {
  const h = await harness(context);
  const { provider } = h;
  const credit = NAME("development", "credit_service");
  const manifest = await h.manifestFor("development");
  await h.rehearse(manifest);
  const statePath = join(h.directory, "state", "development-train.json");
  const incomplete = (id) => new RegExp(`Release step ${id} is incomplete`, "u");
  const untouchedControl = structuredClone(provider.workers.get(CONTROL.development));
  const untouchedNeighbour = structuredClone(provider.workers.get("ohmyho-other-production"));
  const untouchedIngress = structuredClone([provider.domains, provider.routes]);
  const counts = () => ({ ...provider.counts });

  // Crash after the "prepared" checkpoint: nothing was uploaded and the original absence is kept.
  provider.failList(credit, 2);
  await assert.rejects(h.train(manifest, statePath), incomplete("credit-service"));
  let state = await readState(statePath);
  assert.equal(state.status, "interrupted");
  assert.equal(state.steps.core.status, "completed");
  assert.equal(state.steps["credit-service"].status, "running");
  assert.equal(state.steps["credit-service"].creation.phase, "prepared");
  assert.equal(state.steps["credit-service"].creation.uploadAttempted, false);
  assert.deepEqual(
    state.baseline.workers.map(({ workerName, presence }) => [workerName, presence?.kind]),
    [
      [CONTROL.development, undefined],
      [CORE.development, undefined],
      [credit, "absent"],
    ],
  );
  assert.deepEqual(provider.counts, { deployCommands: 0, deploys: 0, secretUploads: 0, puts: 0 });
  assert.equal(provider.workers.has(credit), false);

  // Strict progress: unknown fields, changed bindings and impossible phases never resume.
  const prepared = await readFile(statePath, "utf8");
  const candidate = JSON.parse(prepared).steps["credit-service"].creation;
  const progressBinding = Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) =>
        !["phase", "originalPresence", "uploadAttempted", "versionId", "cronAttempted"].includes(
          key,
        ),
    ),
  );
  const legacyProgress = {
    ...candidate,
    message: candidate.message.replace(/^source /u, "origin/main "),
  };
  assert.doesNotThrow(() => validateCreationProgress(legacyProgress, progressBinding));
  assert.throws(
    () =>
      validateCreationProgress(
        { ...legacyProgress, message: `${legacyProgress.message}-altered` },
        progressBinding,
      ),
    /differs from its approval/u,
  );
  for (const mutate of [
    (value) => (value.steps["credit-service"].creation.extra = true),
    (value) => (value.steps["credit-service"].creation.tag = "release-other"),
    (value) => (value.steps["credit-service"].creation.uploadAttempted = true),
    (value) => (value.steps["credit-service"].creation.cronAttempted = false),
    (value) =>
      (value.steps["credit-service"].creation.versionId = "11111111-2222-4333-8444-555555555555"),
    (value) => (value.steps["credit-service"].creation.originalPresence.kind = "present"),
    (value) => (value.steps.core.creation = value.steps["credit-service"].creation),
  ]) {
    const tampered = JSON.parse(prepared);
    mutate(tampered);
    await writeFile(statePath, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(
      h.train(manifest, statePath),
      /creation progress is invalid|Release step state is invalid/u,
    );
    assert.deepEqual(provider.counts, { deployCommands: 0, deploys: 0, secretUploads: 0, puts: 0 });
  }
  await writeFile(statePath, prepared, { mode: 0o600 });

  // The intent is persisted before the creation command. The upload is lost in flight, so a
  // missing Worker proves nothing: the step stays interrupted and never uploads twice.
  provider.deployFaults.set(credit, "stranded");
  await assert.rejects(h.train(manifest, statePath), incomplete("credit-service"));
  state = await readState(statePath);
  assert.equal(state.steps["credit-service"].creation.phase, "creating");
  assert.equal(state.steps["credit-service"].creation.uploadAttempted, true);
  assert.equal(provider.counts.deployCommands, 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(h.train(manifest, statePath), incomplete("credit-service"));
    assert.equal((await readState(statePath)).steps["credit-service"].creation.phase, "creating");
    assert.equal(provider.counts.deployCommands, 1);
  }

  // The lost upsert reaches the provider later, and its initial deploy leaves the schedule empty. Foreign,
  // split and drifted states are refused without repair; only the exact owned sole 100% version is adopted,
  // with no second upload.
  provider.appliesCrons = false;
  provider.land(credit);
  assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 0 });
  const owned = provider.snapshot(credit);
  const bindings = () => provider.workers.get(credit).versions[0].resources.bindings;
  const binding = (name) => bindings().find((entry) => entry.name === name);
  for (const corrupt of [
    () => bindings().push({ name: "ARCHIVE", type: "r2_bucket", bucket_name: "archive" }),
    () => (binding("CREDIT_LOG").bucket_name = "ohmyho-credit-log-production"),
    () => delete binding("USAGE_LOGS").jurisdiction,
    () => (binding("CREDIT_RUNTIME").entrypoint = "ControlRuntime"),
    () => (binding("CREDIT_ENVIRONMENT").text = "production"),
    () => bindings().pop(),
    () => provider.foreign(credit),
    () => provider.foreign(credit, { split: true }),
  ]) {
    corrupt();
    await assert.rejects(h.train(manifest, statePath), incomplete("credit-service"));
    provider.restore(credit, owned);
    assert.equal((await readState(statePath)).steps["credit-service"].creation.phase, "creating");
    assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 0 });
  }

  // The adopted version has no schedule, so one PUT is sent whose response is lost after it was applied.
  provider.putFaults.add(credit);
  await assert.rejects(h.train(manifest, statePath), incomplete("credit-service"));
  state = await readState(statePath);
  assert.equal(state.steps["credit-service"].creation.phase, "activating");
  assert.equal(state.steps["credit-service"].creation.cronAttempted, true);
  assert.deepEqual(provider.workers.get(credit).crons, CRONS);
  assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 1 });

  // Concurrent resumers cannot take over the state.
  await writeFile(`${statePath}.lock`, "held", { mode: 0o600 });
  await assert.rejects(h.train(manifest, statePath), /lock/u);
  await rm(`${statePath}.lock`);
  assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 1 });

  // Resume reads the schedule first: it is already exact, so there is no second PUT.
  const result = await h.train(manifest, statePath);
  assert.deepEqual(result.completed, ["core", "credit-service"]);
  assert.equal(result.ingressAndSchedulesPreserved, true);
  assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 1 });
  state = await readState(statePath);
  assert.equal(state.status, "completed");
  assert.deepEqual(provider.workers.get(credit).crons, CRONS);
  const step = state.steps["credit-service"];
  assert.equal(step.receipt.cronTriggers, "unchanged");
  assert.deepEqual(step.receipt.crons, CRONS);
  assert.equal(step.creation, undefined);
  assert.match(step.receipt.tag, /^release-a{12}-[a-f0-9]{12}-[a-f0-9]{12}$/u);
  assert.ok(step.receipt.message.includes(`source ${SHA}; config `));
  assert.ok(step.receipt.message.endsWith(`; creation ${CREATION.development.credit_service}`));
  // The original absent baseline is retained; Control is protected although it is not a step.
  assert.deepEqual(
    state.baseline.workers.map(({ workerName, presence }) => [workerName, presence?.kind]),
    [
      [CONTROL.development, undefined],
      [CORE.development, undefined],
      [credit, "absent"],
    ],
  );
  assert.deepEqual(
    state.after.workers.map(({ workerName, presence }) => [workerName, presence?.kind]),
    [
      [CONTROL.development, undefined],
      [CORE.development, undefined],
      [credit, undefined],
    ],
  );
  assert.deepEqual(provider.workers.get(CONTROL.development), untouchedControl);
  assert.deepEqual(provider.workers.get("ohmyho-other-production"), untouchedNeighbour);
  assert.deepEqual([provider.domains, provider.routes], untouchedIngress);
  // The credit-service carries no secret: nothing was uploaded to it.
  assert.equal(provider.secretPaths.length, 0);

  // Completed replay is read-only, and every drift or widening is refused without repair.
  const replayStart = provider.log.length;
  await h.train(manifest, statePath);
  assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 1 });
  const legacyState = structuredClone(state);
  const legacyMessage = step.receipt.message.replace(/^source /u, "origin/main ");
  legacyState.steps["credit-service"].receipt.message = legacyMessage;
  const annotations = provider.workers.get(credit).versions[0].annotations;
  const currentMessage = annotations["workers/message"];
  annotations["workers/message"] = legacyMessage;
  await writeFile(statePath, JSON.stringify(legacyState), { mode: 0o600 });
  await h.train(manifest, statePath);
  assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 1 });
  annotations["workers/message"] = currentMessage;
  await assert.rejects(h.train(manifest, statePath), /Private Worker active version is not owned/u);
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  assert.ok(
    provider.log
      .slice(replayStart)
      .every((entry) =>
        /^wrangler (?:auth token|versions (?:list|view)|deployments status|d1 execute CONTROL_CORE --remote) /u.test(
          entry,
        ),
      ),
  );
  const intact = {
    credit: provider.snapshot(credit),
    control: provider.snapshot(CONTROL.development),
  };
  const drifts = [
    [() => (provider.workers.get(credit).crons = []), /ingress or schedules/u],
    [() => provider.workers.get(credit).crons.pop(), /ingress or schedules/u],
    [() => provider.workers.get(credit).crons.push("0 * * * *"), /ingress or schedules/u],
    [() => (provider.workers.get(CONTROL.development).crons = []), /ingress or schedules/u],
    [() => (provider.workers.get(credit).subdomain.enabled = true), /ingress or schedules/u],
    [() => provider.routes.splice(0, 1), /ingress or schedules/u],
    [
      () =>
        provider.routes.push({ id: "4".repeat(32), pattern: "x.example.test/*", script: credit }),
      /ingress or schedules/u,
    ],
    [
      () =>
        provider.domains.push({
          id: "domain-x",
          hostname: "x.example.test",
          service: credit,
          environment: "production",
          zone_id: ZONE,
        }),
      /ingress or schedules/u,
    ],
    [
      () =>
        provider.workers
          .get(credit)
          .versions[0].resources.bindings.push({ name: "EXTRA", type: "secret_text" }),
      /closed inventory/u,
    ],
    [
      () =>
        (provider.workers
          .get(credit)
          .versions[0].resources.bindings.find(({ name }) => name === "USAGE_LOGS").bucket_name =
          "ohmyho-usage-production"),
      /closed inventory/u,
    ],
    [() => provider.foreign(credit), /not owned/u],
    [() => provider.foreign(credit, { split: true }), /sole 100%/u],
  ];
  for (const [corrupt, pattern] of drifts) {
    corrupt();
    await assert.rejects(h.train(manifest, statePath), pattern);
    provider.restore(credit, intact.credit);
    provider.restore(CONTROL.development, intact.control);
    provider.routes.splice(0, provider.routes.length, ...structuredClone(untouchedIngress[1]));
    provider.domains.splice(0, provider.domains.length, ...structuredClone(untouchedIngress[0]));
    assert.deepEqual(counts(), { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 1 });
  }
  await h.train(manifest, statePath);

  // A schedule PUT with an unknown outcome may still be in flight. Even if GET still returns [],
  // no second PUT is permitted; later exact readback completes the original operation.
  const delayed = await harness(context);
  const delayedManifest = await delayed.manifestFor("development");
  await delayed.rehearse(delayedManifest);
  delayed.provider.appliesCrons = false;
  delayed.provider.strandedPuts.add(credit);
  const delayedState = join(delayed.directory, "state", "delayed-schedule.json");
  await assert.rejects(delayed.train(delayedManifest, delayedState), incomplete("credit-service"));
  assert.equal(
    (await readState(delayedState)).steps["credit-service"].creation.cronAttempted,
    true,
  );
  const delayedCounts = { ...delayed.provider.counts };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      delayed.train(delayedManifest, delayedState),
      incomplete("credit-service"),
    );
    assert.deepEqual(delayed.provider.counts, delayedCounts);
  }
  delayed.provider.landSchedule(credit);
  await delayed.train(delayedManifest, delayedState);
  assert.deepEqual(delayed.provider.counts, delayedCounts);
});

test("production creation requires the verified same-source Development creation, then creates its own once", async (context) => {
  const h = await harness(context);
  const { provider } = h;
  const names = {
    developmentCredit: NAME("development", "credit_service"),
    credit: NAME("production", "credit_service"),
  };

  // Development first: the initial deploy already applies both crons.
  const developmentManifest = await h.manifestFor("development");
  await h.rehearse(developmentManifest);
  const developmentManifestPath = join(h.directory, "state", "development-manifest.json");
  await writeFile(developmentManifestPath, JSON.stringify(developmentManifest), { mode: 0o600 });
  const developmentState = join(h.directory, "state", "development-train.json");
  await h.train(developmentManifest, developmentState);
  assert.deepEqual(provider.counts, { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 0 });
  assert.deepEqual([...provider.workers.get(names.developmentCredit).crons].sort(), CRONS);

  // Without a reference, a Production creation is not a valid manifest at all.
  const unreferenced = await h.manifestFor("production");
  assert.throws(() => validateTrainManifest(unreferenced), /Development creation/u);
  const productionManifest = await h.manifestFor("production", {
    developmentReference: { manifest: developmentManifestPath, state: developmentState },
  });
  await h.rehearse(productionManifest);
  const productionState = join(h.directory, "state", "production-train.json");
  const developmentSnapshot = {
    credit: provider.snapshot(names.developmentCredit),
    control: provider.snapshot(CONTROL.development),
  };
  const noProductionMutation = () => {
    assert.deepEqual(provider.counts, { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 0 });
    assert.equal(provider.workers.has(names.credit), false);
  };

  // Distinct paths cannot disguise the same file as a reference or overwrite its completed state.
  const stateAlias = join(h.directory, "state", "development-state-alias.json");
  await link(developmentState, stateAlias);
  await assert.rejects(
    executeReleaseTrain({
      manifest: productionManifest,
      statePath: stateAlias,
      approval: "d".repeat(64),
      environment: "production",
    }),
    /alias/u,
  );
  await rm(stateAlias);
  const manifestAlias = join(h.directory, "state", "development-manifest-alias.json");
  await link(developmentManifestPath, manifestAlias);
  const aliasedReference = {
    ...productionManifest,
    developmentReference: { manifest: developmentManifestPath, state: manifestAlias },
  };
  const rehearsal = await readFile(productionManifest.rehearsal);
  await writeFile(
    productionManifest.rehearsal,
    JSON.stringify({ ...JSON.parse(rehearsal), manifestSha256: manifestDigest(aliasedReference) }),
  );
  try {
    await assert.rejects(h.prepare(aliasedReference), /filesystem aliases/u);
  } finally {
    await rm(manifestAlias);
    await writeFile(productionManifest.rehearsal, rehearsal);
  }
  noProductionMutation();

  // A live Development creation that drifted, is foreign, widened or has public ingress is refused
  // before any Production mutation, whatever its local "completed" state says.
  const restoreDevelopment = () => {
    provider.restore(names.developmentCredit, developmentSnapshot.credit);
    provider.restore(CONTROL.development, developmentSnapshot.control);
    provider.routes.splice(3);
  };
  for (const [corrupt, pattern] of [
    [
      () => (provider.workers.get(CONTROL.development).crons = []),
      /protected ingress or schedules/u,
    ],
    [() => (provider.workers.get(names.developmentCredit).crons = []), /schedules drifted/u],
    [() => provider.workers.get(names.developmentCredit).crons.pop(), /schedules drifted/u],
    [() => provider.foreign(names.developmentCredit), /not owned/u],
    [
      () =>
        provider.workers
          .get(names.developmentCredit)
          .versions[0].resources.bindings.push({ name: "ARCHIVE", type: "r2_bucket" }),
      /closed inventory/u,
    ],
    [
      () =>
        provider.routes.push({
          id: "4".repeat(32),
          pattern: "x.example.test/*",
          script: names.developmentCredit,
        }),
      /public ingress/u,
    ],
  ]) {
    corrupt();
    await assert.rejects(h.train(productionManifest, productionState), pattern);
    noProductionMutation();
    restoreDevelopment();
  }

  // A stale, foreign, reused or tampered local reference never reaches the provider.
  const referenced = async (path, mutate, pattern, statePath = productionState) => {
    const original = await readFile(path, "utf8");
    const changed = JSON.parse(original);
    mutate(changed);
    await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
    try {
      await assert.rejects(h.train(productionManifest, statePath), pattern);
    } finally {
      await writeFile(path, original, { mode: 0o600 });
    }
  };
  await referenced(
    developmentManifestPath,
    (value) => (value.sourceCommit = "b".repeat(40)),
    /stale, foreign or reused/u,
  );
  await referenced(
    developmentManifestPath,
    (value) => (value.steps[1].creationId = CREATION.production.credit_service),
    /stale, foreign or reused/u,
  );
  for (const mutate of [
    (value) => (value.manifestSha256 = "e".repeat(64)),
    (value) => (value.status = "interrupted"),
    (value) => (value.approvalSha256 = "e".repeat(64)),
    (value) => (value.sourceCommit = "b".repeat(40)),
    (value) => delete value.steps["credit-service"],
  ])
    await referenced(developmentState, mutate, /not a completed train|stale, foreign or reused/u);
  noProductionMutation();
  // A receipt naming another version passes every local check; only the live readback refuses it.
  // It changes the approved evidence, so it runs against its own fresh state.
  await referenced(
    developmentState,
    (value) =>
      (value.steps["credit-service"].receipt.versionId = "55555555-2222-4333-8444-555555555555"),
    /version or deployment drifted/u,
    join(h.directory, "state", "tampered-receipt-train.json"),
  );
  noProductionMutation();

  // A preexisting Production Worker is a collision, never adopted because it looks identical.
  provider.workers.set(names.credit, provider.worker());
  await assert.rejects(
    h.train(productionManifest, join(h.directory, "state", "collision-train.json")),
    /collides with an existing Worker/u,
  );
  await assert.rejects(h.train(productionManifest, productionState), /ingress or schedules/u);
  provider.workers.delete(names.credit);
  assert.deepEqual(provider.counts, { deployCommands: 1, deploys: 1, secretUploads: 0, puts: 0 });

  // With the Development creation live and exact, Production creates its own once and nothing else.
  const control = structuredClone(provider.workers.get(CONTROL.production));
  const result = await h.train(productionManifest, productionState);
  assert.deepEqual(result.completed, ["core", "credit-service"]);
  assert.deepEqual(provider.counts, { deployCommands: 2, deploys: 2, secretUploads: 0, puts: 0 });
  assert.deepEqual([...provider.workers.get(names.credit).crons].sort(), CRONS);
  assert.deepEqual(provider.workers.get(CONTROL.production), control);
  const state = await readState(productionState);
  const developed = await readState(developmentState);
  const receipt = state.steps["credit-service"].receipt;
  assert.equal(receipt.workerName, names.credit);
  assert.ok(receipt.message.endsWith(`; creation ${CREATION.production.credit_service}`));
  assert.notEqual(receipt.tag, developed.steps["credit-service"].receipt.tag);
  assert.notEqual(receipt.versionId, developed.steps["credit-service"].receipt.versionId);
  assert.equal(receipt.cronTriggers, "unchanged");
  assert.deepEqual(
    state.baseline.workers.map(({ workerName, presence }) => [workerName, presence?.kind]),
    [
      [CONTROL.production, undefined],
      [CORE.production, undefined],
      [names.credit, "absent"],
    ],
  );

  // Completed Production replay is read-only and re-proves the Development creation live.
  const replayStart = provider.log.length;
  await h.train(productionManifest, productionState);
  assert.deepEqual(provider.counts, { deployCommands: 2, deploys: 2, secretUploads: 0, puts: 0 });
  const replay = provider.log.slice(replayStart);
  assert.ok(
    replay.every((entry) =>
      /^wrangler (?:auth token|versions (?:list|view)|deployments status|d1 execute CONTROL_CORE --remote) /u.test(
        entry,
      ),
    ),
  );
  assert.ok(replay.some((entry) => entry.includes(`--name ${names.developmentCredit} `)));
  // Even a completed Production train refuses a Development creation whose retained evidence changed.
  await referenced(
    developmentState,
    (value) => (value.steps["credit-service"].receipt.crons = []),
    /receipt is invalid/u,
  );
  assert.deepEqual(provider.counts, { deployCommands: 2, deploys: 2, secretUploads: 0, puts: 0 });
});

test("the broker bootstrap profile is exact and may be selected without recreating credit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "omh-broker-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const environment of ["development", "production"]) {
    const name = `ohmyho-connection-broker-${environment}`;
    const config = `apps/connection-broker/wrangler.bootstrap.${environment}.jsonc`;
    const configuration = parseJsonc(await readFile(join(ROOT, config), "utf8"));
    assert.equal(configuration.name, name);
    validatePrivateWorkerConfiguration({
      environment,
      profile: "connection_broker",
      configuration,
    });
    const outputPath = join(directory, `${environment}-rendered.json`);
    const rendered = await renderWranglerConfiguration({
      expectedName: name,
      sourcePath: join(ROOT, config),
      outputPath,
    });
    validatePrivateWorkerConfiguration({
      environment,
      profile: "connection_broker",
      configuration: rendered,
    });
    validatePrivateWorkerConfiguration({
      environment,
      profile: "connection_broker",
      configuration: { ...rendered, main: join(directory, "bundle", "worker.js"), no_bundle: true },
      rehearsed: true,
    });
    const args = workerVersionsArguments({ workerName: name, configPath: outputPath });
    const missing = {
      code: 1,
      stderr: `GET /accounts/${ACCOUNT}/workers/scripts/${name}/versions\nThis Worker does not exist on your account. [code: 10007]`,
    };
    assert.ok(
      classifyWorkerAbsence({
        command: "wrangler",
        args,
        context: { accountId: ACCOUNT, workerName: name },
        error: missing,
      }) instanceof WorkerAbsentError,
    );
    assert.equal(
      classifyWorkerAbsence({
        command: "wrangler",
        args,
        context: { accountId: ACCOUNT, workerName: `${name}-other` },
        error: missing,
      }),
      null,
    );
    const changed = [
      (c) => (c.vars.MAKE_OAUTH_ENABLED = "false"),
      (c) => (c.vars.EXTRA = "value"),
      (c) => (c.observability.enabled = true),
      (c) => c.services.pop(),
      (c) =>
        (c.services[0].service =
          CORE[environment === "development" ? "production" : "development"]),
      (c) => c.r2_buckets.push({ binding: "EXTRA", bucket_name: "extra" }),
      (c) => (c.routes = [{ pattern: "example.test", custom_domain: true }]),
      (c) => (c.secrets = { required: ["MAKE_CLIENT_SECRET"] }),
      (c) => (c.triggers.crons = []),
    ];
    for (const mutate of changed) {
      const candidate = structuredClone(configuration);
      mutate(candidate);
      assert.throws(() =>
        validatePrivateWorkerConfiguration({
          environment,
          profile: "connection_broker",
          configuration: candidate,
        }),
      );
    }
    const manifest = {
      schemaVersion: 1,
      sourceCommit: SHA,
      environment,
      accountId: ACCOUNT,
      rehearsal: join(directory, "rehearsal.json"),
      ...(environment === "production"
        ? {
            developmentReference: {
              manifest: "/private/dev-manifest.json",
              state: "/private/dev-state.json",
            },
          }
        : {}),
      steps: [
        {
          id: "core",
          kind: "worker",
          config: "apps/control-store/wrangler.jsonc",
          configSha256: "a".repeat(64),
          workerName: CORE[environment],
          dependsOn: [],
          core: { databaseName: `ohmyho-control-core-${environment}`, databaseId: CORE_DATABASE },
        },
        {
          id: "broker",
          kind: "worker",
          action: "create_private",
          profile: "connection_broker",
          creationId:
            environment === "development"
              ? "11111111-1111-4111-8111-111111111111"
              : "33333333-3333-4333-8333-333333333333",
          config,
          configSha256: "b".repeat(64),
          workerName: name,
          dependsOn: ["core"],
        },
      ],
    };
    validateTrainManifest(manifest);
    const wrongDev = {
      ...manifest,
      environment: "development",
      steps: [{ kind: "worker", action: "create_private", profile: "credit_service" }],
    };
    assert.throws(() => validateCreationProfileCorrespondence(wrongDev, manifest), /profile/u);
    assert.doesNotThrow(() =>
      validateCreationProfileCorrespondence(
        {
          ...wrongDev,
          steps: [{ kind: "worker", action: "create_private", profile: "connection_broker" }],
        },
        manifest,
      ),
    );
    const duplicate = structuredClone(manifest);
    duplicate.steps.push({
      ...duplicate.steps[1],
      id: "duplicate",
      creationId: "44444444-4444-4444-8444-444444444444",
    });
    assert.throws(() => validateTrainManifest(duplicate));
  }
  const h = await harness(context);
  const manifest = await h.manifestFor("development");
  const profile = PRIVATE_WORKER_PROFILES.development.connection_broker;
  manifest.steps[1] = {
    ...manifest.steps[1],
    id: "broker",
    profile: "connection_broker",
    workerName: profile.name,
    config: profile.config,
    configSha256: releaseHash(await readFile(join(h.repositoryRoot, profile.config))),
    creationId: "77777777-7777-4777-8777-777777777777",
  };
  const originalControl = h.provider.snapshot(CONTROL.development);
  await h.rehearse(manifest);
  const devState = join(h.directory, "state", "broker-train.json");
  const devManifestPath = join(h.directory, "state", "broker-manifest.json");
  await writeFile(devManifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await h.train(manifest, devState);
  assert.equal(h.provider.workers.has(NAME("development", "credit_service")), false);
  assert.deepEqual(h.provider.snapshot(CONTROL.development), originalControl);
  const created = h.provider.workers.get(profile.name);
  assert.deepEqual(created.crons, ["*/5 * * * *"]);
  assert.deepEqual(created.subdomain, { enabled: false, previews_enabled: false });
  assert.equal(h.provider.counts.secretUploads, 0);
  const production = await h.manifestFor("production", {
    developmentReference: { manifest: devManifestPath, state: devState },
  });
  const productionProfile = PRIVATE_WORKER_PROFILES.production.connection_broker;
  production.steps[1] = {
    ...production.steps[1],
    id: "broker",
    profile: "connection_broker",
    workerName: productionProfile.name,
    config: productionProfile.config,
    configSha256: releaseHash(await readFile(join(h.repositoryRoot, productionProfile.config))),
    creationId: "88888888-8888-4888-8888-888888888888",
  };
  const productionControl = h.provider.snapshot(CONTROL.production);
  await h.rehearse(production);
  // Dev is fully activated before Prod starts. Its immutable bootstrap version
  // remains provenance, while the current version is the same-source ordinary release.
  const activatedId = "99999999-9999-4999-8999-999999999999";
  const configurationHash = "c".repeat(64),
    rehearsalHash = "d".repeat(64);
  const activated = {
    id: activatedId,
    annotations: {
      "workers/tag": `release-${SHA.slice(0, 12)}-${configurationHash.slice(0, 12)}-${rehearsalHash.slice(0, 12)}`,
      "workers/message": `source ${SHA}; config ${configurationHash}; rehearsal ${rehearsalHash}`,
    },
    resources: {
      bindings: [
        ...structuredClone(created.versions[0].resources.bindings),
        ...["MAKE_CLIENT_ID", "MAKE_CLIENT_SECRET", "GRANT_KEY"].map((name) => ({
          name,
          type: "secret_text",
        })),
      ],
    },
  };
  created.versions.push(activated);
  created.deployment = [{ version_id: activatedId, percentage: 100 }];
  const callbackDomain = {
    id: "broker-domain",
    hostname: "dev.connect.ohmyho.st",
    service: profile.name,
    environment: "production",
    zone_id: ZONE,
  };
  h.provider.domains.push(callbackDomain);
  const prodState = join(h.directory, "state", "broker-production-train.json");
  const beforeProduction = structuredClone(h.provider.counts);
  const validMessage = activated.annotations["workers/message"];
  activated.annotations["workers/message"] = validMessage.replace(SHA, "f".repeat(40));
  await assert.rejects(h.train(production, prodState));
  activated.annotations["workers/message"] = validMessage;
  activated.resources.bindings.push({ name: "EXTRA_SECRET", type: "secret_text" });
  await assert.rejects(h.train(production, prodState));
  activated.resources.bindings.pop();
  created.deployment = [
    { version_id: activatedId, percentage: 50 },
    { version_id: created.versions[0].id, percentage: 50 },
  ];
  await assert.rejects(h.train(production, prodState));
  created.deployment = [{ version_id: activatedId, percentage: 100 }];
  const originalTag = created.versions[0].annotations["workers/tag"];
  created.versions[0].annotations["workers/tag"] = "foreign";
  await assert.rejects(h.train(production, prodState));
  created.versions[0].annotations["workers/tag"] = originalTag;
  callbackDomain.hostname = "foreign.example.test";
  await assert.rejects(h.train(production, prodState));
  callbackDomain.hostname = "dev.connect.ohmyho.st";
  assert.deepEqual(h.provider.counts, beforeProduction);
  await h.train(production, prodState);
  assert.deepEqual(h.provider.snapshot(CONTROL.production), productionControl);
  assert.deepEqual(h.provider.workers.get(productionProfile.name).crons, ["*/5 * * * *"]);
  assert.equal(h.provider.workers.has(NAME("production", "credit_service")), false);
  assert.equal(h.provider.counts.secretUploads, 0);

  // The original completed Broker bootstrap stays immutable while the current
  // Development Broker and Production source advance to a verified descendant.
  h.provider.workers.delete(productionProfile.name);
  const descendant = "b".repeat(40);
  const advanced = structuredClone(production);
  advanced.sourceCommit = descendant;
  advanced.rehearsal = join(h.directory, "state", "broker-descendant-rehearsal.json");
  await h.rehearse(advanced);
  activated.annotations["workers/message"] = validMessage.replace(SHA, descendant);
  activated.annotations["workers/tag"] =
    `release-${descendant.slice(0, 12)}-${configurationHash.slice(0, 12)}-${rehearsalHash.slice(0, 12)}`;
  const advancedState = join(h.directory, "state", "broker-descendant-production.json");
  const countsBeforeDescendant = structuredClone(h.provider.counts);
  await assert.rejects(h.train(advanced, advancedState), /ancestor|stale, foreign or reused/u);
  h.provider.acceptAncestor = true;
  const checkedCi = [];
  const verifyCommit = async (args) => {
    checkedCi.push(args);
    if (args.sha === SHA && args.existingOnly) throw new Error("original CI unavailable");
    return 42;
  };
  await assert.rejects(
    h.train(advanced, advancedState, { verifyCommit }),
    /original CI unavailable/u,
  );
  assert.ok(checkedCi.some((args) => args.sha === SHA && args.existingOnly === true));
  await assert.rejects(
    h.train(advanced, advancedState, {
      verifyCommit: async (args) => (args.sha === SHA ? 41 : 42),
    }),
    /bootstrap CI evidence changed/u,
  );
  const descendantMessage = activated.annotations["workers/message"];
  activated.annotations["workers/message"] = validMessage;
  await assert.rejects(h.train(advanced, advancedState));
  activated.annotations["workers/message"] = descendantMessage;
  activated.resources.bindings.push({ name: "EXTRA_SECRET", type: "secret_text" });
  await assert.rejects(h.train(advanced, advancedState));
  activated.resources.bindings.pop();
  const bootstrapConfig = join(h.repositoryRoot, profile.config);
  const bootstrapBytes = await readFile(bootstrapConfig);
  await writeFile(bootstrapConfig, `${bootstrapBytes}\n`);
  try {
    await assert.rejects(h.train(advanced, advancedState), /configuration digest differs/u);
  } finally {
    await writeFile(bootstrapConfig, bootstrapBytes);
  }
  assert.deepEqual(h.provider.counts, countsBeforeDescendant);
  const verified = [];
  await h.train(advanced, advancedState, {
    verifyCommit: async (args) => {
      verified.push(args);
      return 42;
    },
  });
  assert.ok(verified.some((args) => args.sha === SHA && args.existingOnly === true));
  assert.ok(verified.some((args) => args.sha === descendant));
});

test("the first Preview Worker is limited to its exact private Container, bindings and one-minute cron", async () => {
  for (const environment of ["development", "production"]) {
    const configuration = parseJsonc(
      await readFile(join(ROOT, `apps/preview-runtime/wrangler.${environment}.jsonc`), "utf8"),
    );
    const definition = validatePreviewRuntimeConfiguration({ environment, configuration });
    assert.equal(definition.name, configuration.name);
    for (const mutate of [
      (c) => {
        c.routes = [{ pattern: "preview.example/*" }];
      },
      (c) => {
        c.triggers.crons = ["*/2 * * * *"];
      },
      (c) => {
        c.services[0].entrypoint = "ControlRuntime";
      },
      (c) => {
        c.r2_buckets[0].bucket_name = "other";
      },
      (c) => {
        c.durable_objects.bindings[0].class_name = "Other";
      },
      (c) => {
        c.containers[0].images.other = { dockerfile: "x", build_context: "." };
      },
      (c) => {
        c.vars.PREVIEW_CONTAINER_APPLICATION_NAME = "unexpected";
      },
    ]) {
      const changed = structuredClone(configuration);
      mutate(changed);
      assert.throws(
        () => validatePreviewRuntimeConfiguration({ environment, configuration: changed }),
        /closed capability profile/u,
      );
    }
    const manifest = {
      accountId: ACCOUNT,
      environment,
      steps: [{ kind: "worker", workerName: definition.name, config: definition.config }],
    };
    const absent = {
      workerName: definition.name,
      presence: { kind: "absent", accountId: ACCOUNT, workerName: definition.name },
    };
    const live = {
      workerName: definition.name,
      subdomain: { enabled: false, previews_enabled: false },
      crons: [definition.cron],
    };
    const baseline = { workers: [absent], domains: [], routes: [] };
    assert.equal(
      closedTransition({
        baseline,
        observation: { ...baseline, workers: [live] },
        manifest,
        steps: {},
      }),
      false,
    );
    manifest.steps[0].id = "preview";
    assert.equal(
      closedTransition({
        baseline,
        observation: { ...baseline, workers: [live] },
        manifest,
        steps: { preview: { status: "running" } },
      }),
      true,
    );
    assert.equal(
      closedTransition({
        baseline,
        observation: { ...baseline, workers: [{ ...live, crons: [] }] },
        manifest,
        steps: { preview: { status: "completed" } },
      }),
      false,
    );
  }
});
