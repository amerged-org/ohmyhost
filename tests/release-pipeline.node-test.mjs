/* global structuredClone */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  executeReleaseTrain,
  manifestDigest,
  releaseApprovalDigest,
  validateTrainManifest,
} from "../scripts/release-pipeline.mjs";
import { CLIENT_PACKAGES } from "../scripts/release-client-artifacts.mjs";
import {
  fingerprintAt,
  POLICY_SOURCES,
  PolicyCohortError,
} from "../scripts/release-policy-cohort.mjs";

const SHA = "a".repeat(40);
const ACCOUNT = "b".repeat(32);
const configSha256 = "c".repeat(64);
const first = "ohmyho-control-api-poc-private-fullstack";
const second = "ohmyho-source-fetcher-poc-private-fullstack";
const manifest = (
  steps = [
    {
      id: "control",
      kind: "worker",
      config: "apps/control-api/wrangler.jsonc",
      configSha256,
      workerName: first,
      dependsOn: [],
    },
    {
      id: "source",
      kind: "worker",
      config: "apps/source-fetcher/wrangler.development.jsonc",
      configSha256,
      workerName: second,
      dependsOn: ["control"],
    },
  ],
) => ({
  schemaVersion: 1,
  sourceCommit: SHA,
  environment: "development",
  accountId: ACCOUNT,
  rehearsal: "/private/rehearsal.json",
  steps,
});
const snapshot = {
  domains: [],
  routes: [],
  workers: [
    { workerName: first, subdomain: { enabled: false, previews_enabled: false }, crons: [] },
    { workerName: second, subdomain: { enabled: false, previews_enabled: false }, crons: [] },
  ],
};
const receipt = (workerName) => ({
  deploymentVerified: true,
  sha: SHA,
  workerName,
  uploaded: true,
  versionId: "12345678-1234-4234-8234-123456789012",
  cronTriggers: "unchanged",
  tag: `release-${SHA.slice(0, 12)}-${"c".repeat(12)}`,
  message: `origin/main ${SHA}; config ${"c".repeat(64)}`,
});
const POLICY = "9".repeat(64);
// Both environments' live policy consumers, each at the release policy unless named as lagging.
const cohort = (lagging = [], policySha256 = POLICY) => ({
  policySha256,
  consumers: [
    ["development", "poc-private-fullstack", ".development", "wrangler.jsonc"],
    ["production", "production", ".production", "wrangler.production.jsonc"],
  ].flatMap(([environment, suffix, configSuffix, control]) => {
    const builder = `ohmyho-build-runner-${suffix}`;
    const build = `apps/build-runner/wrangler${configSuffix}.jsonc`;
    const worker = (name, config) => ({ name, workerName: name, config });
    const container = (name) => ({ name, workerName: builder, config: build });
    return [
      worker(builder, build),
      container(`ohmyho-build-sandbox-${suffix}`),
      container(`ohmyho-build-sandbox-${suffix}-eu`),
      worker(
        `ohmyho-source-fetcher-${suffix}`,
        `apps/source-fetcher/wrangler${configSuffix}.jsonc`,
      ),
      worker(`ohmyho-control-api-${suffix}`, `apps/control-api/${control}`),
    ].map((consumer) => ({
      ...consumer,
      environment,
      target: policySha256,
      live: lagging.includes(consumer.name) ? "8".repeat(64) : policySha256,
    }));
  }),
});

async function fixture(context, value = manifest()) {
  const directory = await mkdtemp(join(tmpdir(), "omh-train-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const calls = [];
  const options = {
    manifest: value,
    statePath,
    approval: releaseApprovalDigest({ manifest: value, preparationSha256: "d".repeat(64) }),
    environment: "development",
    cwd: "/repo",
    inspectRepository: async () => ({ repositoryRoot: "/repo", sha: SHA }),
    verifyCommit: async () => {
      calls.push("ci");
      return 42;
    },
    prepare: async () => ({ fingerprint: "d".repeat(64) }),
    observeIngress: async () => snapshot,
    observePolicy: async () => cohort(),
    verifyCompleted: async () => {
      calls.push("readback");
    },
    release: async ({ expectedName }) => {
      calls.push(expectedName);
      return receipt(expectedName);
    },
  };
  return { options, calls, statePath };
}

test("train validates ordered dependencies, worker identity, source and exact approval scope before any side effects", async (context) => {
  for (const change of [
    { sourceCommit: "short" },
    { environment: "staging" },
    { arbitraryCommand: "deploy" },
    { steps: [manifest().steps[1], manifest().steps[0]] },
    { steps: [manifest().steps[0], { ...manifest().steps[1], id: "control" }] },
    { steps: [{ ...manifest().steps[0], workerName: "ohmyho-control-api-production" }] },
    { steps: [{ ...manifest().steps[0], config: "../outside/wrangler.jsonc" }] },
    {
      steps: [
        {
          ...manifest().steps[0],
          action: "create_private",
          profile: "wfp_egress",
          creationId: "12345678-1234-4234-8234-123456789012",
        },
      ],
    },
  ])
    assert.throws(() => validateTrainManifest({ ...manifest(), ...change }));
  const { options, calls } = await fixture(context);
  await assert.rejects(executeReleaseTrain({ ...options, approval: "e".repeat(64) }), /approval/u);
  await assert.rejects(executeReleaseTrain({ ...options, environment: "production" }), /scope/u);
  assert.deepEqual(calls, []);

  // Regression group 3 (W15 policy cohort). A SourceFetcher-only train cannot ship while the
  // BuildRunner and its images still enforce other policy bytes; nothing is released.
  const builder = "ohmyho-build-runner-poc-private-fullstack";
  const images = [
    "ohmyho-build-sandbox-poc-private-fullstack",
    "ohmyho-build-sandbox-poc-private-fullstack-eu",
  ];
  const sourceOnly = await fixture(context, manifest([{ ...manifest().steps[1], dependsOn: [] }]));
  await assert.rejects(
    executeReleaseTrain({
      ...sourceOnly.options,
      observePolicy: async () => cohort([builder, ...images, second]),
    }),
    (error) =>
      error instanceof PolicyCohortError &&
      error.message ===
        `Release policy cohort refused: development consumers ${builder}, ${images.join(", ")} differ from the release policy; add Worker steps for ${builder} to this train`,
  );
  assert.deepEqual(sourceOnly.calls, ["ci"]);

  // Revisions with identical policy bytes share one fingerprint, so they need no release; a train
  // without a consumer step is unaffected until a consumer of its environment differs.
  const tree = (paths, mode = "100644") =>
    paths.map((path) => `${mode} blob ${"0".repeat(40)}\t${path}\0`).join("");
  const at = (sha, text, listed = tree(POLICY_SOURCES)) =>
    fingerprintAt({
      sha,
      repositoryRoot: "/repo",
      run: async (command, args, options) => {
        assert.equal(command, "git");
        assert.equal(options.localOnly, true);
        if (args[0] === "ls-tree") return listed;
        const path = args[1].slice(41);
        assert.ok(POLICY_SOURCES.includes(path));
        return typeof text === "function" ? text(path) : text;
      },
    });
  const target = await at(SHA, "floor 16.3.8");
  assert.equal(await at("1".repeat(40), "floor 16.3.8"), target);
  assert.notEqual(await at("1".repeat(40), "floor 16.3.6"), target);
  // Framework-family decisions and every independent egress declaration guard are admission
  // policy. A change confined to any one of them must require the complete consumer cohort.
  for (const changed of [
    "packages/contracts/src/framework-family.ts",
    "packages/contracts/src/index.ts",
    "packages/platform/src/modules/frameworks/framework-plan.ts",
    "apps/build-runner/sandbox/build-runtime.mjs",
  ])
    assert.notEqual(
      await at("1".repeat(40), (path) =>
        path === changed ? "changed admission guard" : "floor 16.3.8",
      ),
      target,
      changed,
    );
  // A missing or linked policy source refuses instead of fingerprinting fewer bytes.
  for (const listed of [tree(POLICY_SOURCES.slice(1)), tree(POLICY_SOURCES, "120000")])
    await assert.rejects(at(SHA, "floor 16.3.8", listed), /regular file/u);
  const billingStep = {
    ...manifest().steps[0],
    id: "billing",
    config: "apps/billing/wrangler.jsonc",
    workerName: "ohmyho-billing-poc-private-fullstack",
  };
  const billing = await fixture(context, manifest([billingStep]));
  await executeReleaseTrain({ ...billing.options, observePolicy: async () => cohort([], target) });
  assert.deepEqual(billing.calls, ["ci", billingStep.workerName]);
  const drifted = await fixture(context, manifest([billingStep]));
  await assert.rejects(
    executeReleaseTrain({ ...drifted.options, observePolicy: async () => cohort([first]) }),
    {
      message: `Release policy cohort refused: development consumers ${first} differ from the release policy; add Worker steps for ${first} to this train`,
    },
  );
  assert.deepEqual(drifted.calls, ["ci"]);

  // Production follows Development: the complete production cohort is refused while a Development
  // consumer lags, and the same train proceeds once Development is at the release policy.
  const production = {
    ...manifest(
      [
        ["builder", "build-runner", [], { containerImages: "/private/images.json" }],
        ["source", "source-fetcher", ["builder"], {}],
        ["control", "control-api", ["source"], {}],
      ].map(([id, app, dependsOn, extra]) => ({
        id,
        kind: "worker",
        config: `apps/${app}/wrangler.production.jsonc`,
        configSha256,
        workerName: `ohmyho-${app}-production`,
        dependsOn,
        ...extra,
      })),
    ),
    environment: "production",
  };
  const productionConsumers = [
    "ohmyho-build-runner-production",
    "ohmyho-build-sandbox-production",
    "ohmyho-build-sandbox-production-eu",
    "ohmyho-control-api-production",
    "ohmyho-source-fetcher-production",
  ];
  const prod = await fixture(context, production);
  const run = (observePolicy) =>
    executeReleaseTrain({ ...prod.options, environment: "production", observePolicy });
  await assert.rejects(
    run(async () => cohort([...productionConsumers, second])),
    {
      message: `Release policy cohort refused: development consumers ${second} differ from the release policy; release ${second} in development first`,
    },
  );
  assert.deepEqual(prod.calls, ["ci"]);
  let observed = 0;
  const released = await run(async () => cohort(++observed === 1 ? productionConsumers : []));
  assert.deepEqual(prod.calls, [
    "ci",
    "ci",
    "ohmyho-build-runner-production",
    "ohmyho-source-fetcher-production",
    "ohmyho-control-api-production",
  ]);
  assert.equal(released.policySha256, POLICY);
  assert.deepEqual(released.policyConsumers, productionConsumers);
});

test("a verified ancestor client cohort keeps its original receipt source while current Workers retain HEAD", async (context) => {
  const sourceCommit = "f".repeat(40);
  const client = {
    id: "clients",
    kind: "clients",
    action: "verify",
    directory: "/private/published-clients",
    version: "0.1.29",
    manifestSha256: "c".repeat(64),
    sourceCommit,
    dependsOn: [],
  };
  const workerName = "ohmyho-public-production";
  const value = {
    ...manifest([
      client,
      { ...manifest().steps[0], id: "public-entry", workerName, dependsOn: [client.id] },
    ]),
    environment: "production",
  };
  validateTrainManifest(value);
  for (const change of [{ action: "publish" }, { sourceCommit: null }, { sourceCommit: "short" }])
    assert.throws(() => validateTrainManifest(manifest([{ ...client, ...change }])));
  const { options, statePath, calls } = await fixture(context, value);
  const repositoryRoot = join(dirname(statePath), "repo");
  const assetsDirectory = join(repositoryRoot, "public");
  await mkdir(join(repositoryRoot, "apps/product-cli"), { recursive: true });
  await mkdir(join(assetsDirectory, "releases", client.version), { recursive: true });
  await writeFile(
    join(repositoryRoot, "apps/product-cli/package.json"),
    JSON.stringify({ version: client.version }),
  );
  await writeFile(
    join(assetsDirectory, "releases", client.version, "manifest.json"),
    JSON.stringify({ source_commit: sourceCommit }),
  );
  Object.assign(options, {
    environment: "production",
    inspectRepository: async () => ({ repositoryRoot, sha: SHA }),
    prepare: async () => ({
      fingerprint: "d".repeat(64),
      workers: {
        "public-entry": {
          configuration: {
            workers_dev: false,
            preview_urls: false,
            assets: { directory: assetsDirectory },
          },
        },
      },
    }),
    observeIngress: async () => ({
      domains: [],
      routes: [],
      workers: [{ workerName, subdomain: { enabled: false, previews_enabled: false }, crons: [] }],
    }),
    release: async ({ expectedName, clientPrerequisite }) => {
      assert.deepEqual(clientPrerequisite, client);
      calls.push(expectedName);
      return receipt(expectedName);
    },
  });
  const run = async (command, args) => {
    assert.equal(command, "gh");
    assert.equal(args[0], "run");
    const evidence = {
      databaseId: 7,
      headSha: sourceCommit,
      status: "completed",
      conclusion: "success",
      jobs: [
        "Scan source for secrets",
        "Audit and check source contracts",
        "Build workspace and inventory tests",
        "Typecheck and verify production boundaries",
        "Verify Node and packaged-client tests",
        ...Array.from({ length: 6 }, (_, index) => `Vitest shard ${index + 1}/6`),
        "Merge complete reports and enforce coverage",
        "Verify complete release gate",
      ].map((name) => ({ name, status: "completed", conclusion: "success" })),
    };
    return JSON.stringify(args[1] === "list" ? [evidence] : evidence);
  };
  const prerequisites = async () => ({
    sourceCommit,
    version: client.version,
    verified: [...CLIENT_PACKAGES].sort(),
  });
  await executeReleaseTrain({ ...options, run, prerequisites });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.steps.clients.receipt.sourceCommit, sourceCommit);
  assert.equal(state.steps["public-entry"].receipt.sha, SHA);
  await executeReleaseTrain({ ...options, run, prerequisites });
  assert.equal(calls.filter((entry) => entry === workerName).length, 1);
  await assert.rejects(
    executeReleaseTrain({ ...options, run: async () => "[]", prerequisites }),
    /existing successful exact-commit CI/u,
  );
  state.steps.clients.receipt.sourceCommit = SHA;
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(executeReleaseTrain({ ...options, run, prerequisites }), /receipt/u);
});

test("a state file this run does not own is never rewritten as interrupted", async (context) => {
  const { options, statePath } = await fixture(context);
  await executeReleaseTrain(options);
  const completed = await readFile(statePath);
  // A different manifest on the completed state is refused, and the file keeps its exact bytes.
  const other = manifest([{ ...manifest().steps[1], dependsOn: [] }]);
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      manifest: other,
      approval: releaseApprovalDigest({ manifest: other, preparationSha256: "d".repeat(64) }),
    }),
    /Release state manifest or source differs/u,
  );
  assert.deepEqual(await readFile(statePath), completed);
  // A completed train whose read-only re-verification fails keeps its completed status.
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      verifyCommit: async () => {
        throw new Error("CI moved");
      },
    }),
    /CI moved/u,
  );
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "completed");
});

test("a completed train whose step readback fails is not persisted as running or interrupted", async (context) => {
  const { options, statePath } = await fixture(context);
  await executeReleaseTrain(options);
  const completed = await readFile(statePath);
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      verifyCompleted: async () => {
        throw new Error("readback changed");
      },
    }),
    /readback changed/u,
  );
  assert.deepEqual(await readFile(statePath), completed);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "completed");
});

test("interruption leaves durable running state and resumption reuses exact completion without duplicate deployment", async (context) => {
  const { options, calls, statePath } = await fixture(context);
  let interrupted = true;
  const release = async ({ expectedName }) => {
    calls.push(expectedName);
    if (expectedName === second && interrupted) throw new Error("simulated lost response");
    return receipt(expectedName);
  };
  await assert.rejects(executeReleaseTrain({ ...options, release }), /Release step/u);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.steps.control.status, "completed");
  assert.equal(state.steps.source.status, "running");
  assert.equal(state.status, "interrupted");
  interrupted = false;
  await executeReleaseTrain({ ...options, release });
  assert.equal(calls.filter((value) => value === first).length, 1);
  assert.equal(calls.filter((value) => value === second).length, 2);
  assert.equal(calls.filter((value) => value === "readback").length, 1);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "completed");
  await executeReleaseTrain({ ...options, release });
  assert.equal(calls.filter((value) => value === first).length, 1);
  assert.equal(calls.filter((value) => value === second).length, 2);
});

test("a resumed train asks for the CI run it recorded, so a later green run of the commit is not changed evidence", async (context) => {
  const { options } = await fixture(context);
  const asked = [];
  const verifyCommit = async (request) => {
    asked.push({ run: request.preferredRunId ?? null, ref: request.ref });
    return 42;
  };
  const branch = {
    inspectRepository: async () => ({
      repositoryRoot: "/repo",
      sha: SHA,
      branch: "feat/feedback-mail",
    }),
  };
  await executeReleaseTrain({ ...options, ...branch, verifyCommit });
  await executeReleaseTrain({ ...options, ...branch, verifyCommit });
  assert.deepEqual(asked, [
    { run: null, ref: "feat/feedback-mail" },
    { run: 42, ref: "feat/feedback-mail" },
  ]);
  // The recorded run is still compared with the answer: another run is refused as changed evidence.
  await assert.rejects(
    executeReleaseTrain({ ...options, verifyCommit: async () => 43 }),
    /CI evidence changed/u,
  );
});

test("a missing green gate, fabricated success or drift never becomes a completed train", async (context) => {
  const { options, calls, statePath } = await fixture(context);
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      verifyCommit: async () => {
        throw new Error("red CI");
      },
    }),
    /red CI/u,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      release: async () => ({ ...receipt(first), deploymentVerified: false }),
    }),
    /receipt/u,
  );
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "interrupted");
  let observations = 0;
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      observeIngress: async () =>
        ++observations === 1 ? snapshot : { ...snapshot, domains: [{ hostname: "missing.test" }] },
    }),
    /ingress|schedule/u,
  );
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "interrupted");

  // Regression group 3: a consumer still behind the release policy after its own step keeps the
  // train incomplete; resume observes again and re-reads completed steps instead of trusting them.
  const lagging = await fixture(context);
  await assert.rejects(
    executeReleaseTrain({ ...lagging.options, observePolicy: async () => cohort([second]) }),
    {
      message: `Release policy cohort incomplete: development consumers ${second} still differ from the release policy after the steps; resume the original private state after readback`,
    },
  );
  const interrupted = JSON.parse(await readFile(lagging.statePath, "utf8"));
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(
    Object.values(interrupted.steps).map(({ status }) => status),
    ["completed", "completed"],
  );
  await executeReleaseTrain(lagging.options);
  assert.equal(JSON.parse(await readFile(lagging.statePath, "utf8")).status, "completed");
  assert.deepEqual(lagging.calls, ["ci", first, second, "ci", "readback", "readback"]);
});

test("source, manifest and immutable preparation cannot change on resume; private state never stores secret errors", async (context) => {
  const { options, statePath } = await fixture(context);
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      release: async () => {
        throw new Error("sensitive-password-do-not-retain");
      },
    }),
  );
  assert.ok(!(await readFile(statePath, "utf8")).includes("sensitive-password"));
  await assert.rejects(
    executeReleaseTrain({ ...options, prepare: async () => ({ fingerprint: "f".repeat(64) }) }),
    /preparation/u,
  );
  const changed = manifest([{ ...manifest().steps[0], configSha256: "f".repeat(64) }]);
  await assert.rejects(
    executeReleaseTrain({ ...options, manifest: changed, approval: manifestDigest(changed) }),
    /manifest/u,
  );
  await assert.rejects(
    executeReleaseTrain({
      ...options,
      inspectRepository: async () => ({ repositoryRoot: "/repo", sha: "b".repeat(40) }),
    }),
    /source/u,
  );
});

test("state rejects concurrent ownership and tampered successful receipts", async (context) => {
  const { options, statePath } = await fixture(context);
  await writeFile(`${statePath}.lock`, "held", { mode: 0o600 });
  await assert.rejects(executeReleaseTrain(options), /lock/u);
  await rm(`${statePath}.lock`);
  await executeReleaseTrain(options);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.steps.control.receipt.sha = "b".repeat(40);
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(executeReleaseTrain(options), /receipt/u);
});

test("a declared cron removal or workers.dev change refuses before any deployment operation", async (context) => {
  const { options, calls, statePath } = await fixture(context);
  for (const configuration of [
    { workers_dev: true, preview_urls: false },
    { workers_dev: false, preview_urls: false, triggers: { crons: ["0 * * * *"] } },
  ]) {
    await assert.rejects(
      executeReleaseTrain({
        ...options,
        prepare: async () => ({
          fingerprint: "d".repeat(64),
          workers: { control: { configuration } },
        }),
      }),
      /would change.*ingress or schedules/u,
    );
    assert.ok(!calls.includes(first));
    await rm(statePath, { force: true });
  }
});

test("concurrent resumers cannot reclaim a presumed stale lock or remove a new owner's lock", async (context) => {
  const { options, calls, statePath } = await fixture(context);
  const lock = JSON.stringify({
    pid: 2147483647,
    manifestSha256: manifestDigest(options.manifest),
  });
  await writeFile(`${statePath}.lock`, lock, { mode: 0o600 });
  const attempts = await Promise.allSettled([
    executeReleaseTrain(options),
    executeReleaseTrain(options),
  ]);
  assert.ok(
    attempts.every(
      (attempt) => attempt.status === "rejected" && /lock/u.test(attempt.reason.message),
    ),
  );
  assert.equal(await readFile(`${statePath}.lock`, "utf8"), lock);
  assert.deepEqual(calls, []);
});

test("Preview creation requires its exact provider chain and bootstraps only a typed-absent Worker", async (context) => {
  const coreName = "ohmyho-control-store-poc-private-fullstack",
    previewName = "ohmyho-live-preview-poc-private-fullstack";
  const worker = (id, workerName, config, dependsOn = []) => ({
    id,
    kind: "worker",
    workerName,
    config,
    configSha256,
    dependsOn,
  });
  const providers = [
    worker("core", coreName, "apps/control-store/wrangler.jsonc"),
    worker("source", second, "apps/source-fetcher/wrangler.development.jsonc", ["core"]),
    worker(
      "secrets",
      "ohmyho-runtime-secret-delivery-poc-private-fullstack",
      "apps/runtime-secret-delivery/wrangler.development.jsonc",
      ["core"],
    ),
    worker(
      "neon",
      "ohmyho-neon-management-poc-private-fullstack",
      "apps/neon-management/wrangler.development.jsonc",
      ["core"],
    ),
    ...["us", "eu"].flatMap((region) => [
      worker(
        `database-${region}`,
        `ohmyho-project-database-development-${region}`,
        `apps/project-database-runtime/wrangler.development.${region}.jsonc`,
        ["core"],
      ),
      worker(
        `native-${region}`,
        `ohmyho-native-auth-development-${region}`,
        `apps/native-auth-runtime/wrangler.development.${region}.jsonc`,
        ["core"],
      ),
    ]),
  ];
  providers[0].core = {
    databaseId: "55555555-5555-4555-8555-555555555555",
    databaseName: "ohmyho-control-core-development",
  };
  const preview = {
    ...worker(
      "preview",
      previewName,
      "apps/preview-runtime/wrangler.development.jsonc",
      providers.map((x) => x.id),
    ),
    containerImages: "/private/images.json",
    secretsFile: "/private/secrets.json",
  };
  const control = worker("control", first, "apps/control-api/wrangler.jsonc", ["preview"]),
    gateway = worker(
      "gateway",
      "ohmyho-gateway-poc-private-fullstack",
      "apps/wfp-dispatch/wrangler.shared.jsonc",
      ["control"],
    );
  const value = manifest([...providers, preview, control, gateway]);
  assert.equal(validateTrainManifest(value), value);
  const missing = structuredClone(value);
  missing.steps.find((x) => x.id === "preview").dependsOn = ["core"];
  assert.throws(() => validateTrainManifest(missing), /Core and providers/u);
  const wrong = structuredClone(value);
  wrong.steps.find((x) => x.id === "preview").config =
    "apps/preview-runtime/wrangler.production.jsonc";
  assert.throws(() => validateTrainManifest(wrong), /closed profile/u);
  const impostor = structuredClone(value);
  impostor.steps.find((x) => x.id === "preview").workerName =
    "ohmyho-live-preview-impostor-poc-private-fullstack";
  assert.throws(() => validateTrainManifest(impostor), /closed profile/u);
  const production = { ...structuredClone(value), environment: "production" };
  for (const step of production.steps) {
    step.workerName = step.workerName
      .replace("poc-private-fullstack", "production")
      .replace("-development-", "-production-");
    step.config = step.config
      .replace(".development.", ".production.")
      .replace(".development.jsonc", ".production.jsonc");
    if (step.id === "control") step.config = "apps/control-api/wrangler.production.jsonc";
    if (step.id === "gateway") step.config = "apps/wfp-dispatch/wrangler.production.shared.jsonc";
    if (step.id === "core") step.core.databaseName = "ohmyho-control-core-production";
  }
  assert.throws(() => validateTrainManifest(production), /Development creation reference/u);
  production.developmentReference = {
    manifest: "/private/dev-manifest.json",
    state: "/private/dev-state.json",
  };
  assert.equal(validateTrainManifest(production), production);
  const f = await fixture(context, value),
    calls = [];
  const live = new Map(
    value.steps.map((step) => [
      step.workerName,
      {
        workerName: step.workerName,
        subdomain: { enabled: false, previews_enabled: false },
        crons: [],
      },
    ]),
  );
  live.set(previewName, {
    workerName: previewName,
    presence: { kind: "absent", accountId: ACCOUNT, workerName: previewName },
  });
  const observation = () => ({ domains: [], routes: [], workers: [...live.values()] });
  f.options.observeIngress = async () => observation();
  f.options.release = async (input) => {
    calls.push({ name: input.expectedName, bootstrap: input.allowContainerBootstrap });
    if (input.expectedName === previewName) {
      live.set(previewName, {
        workerName: previewName,
        subdomain: { enabled: false, previews_enabled: false },
        crons: ["*/1 * * * *"],
      });
      return {
        ...receipt(previewName),
        containers: [
          {
            applicationId: "a".repeat(32),
            image: `registry.cloudflare.com/${ACCOUNT}/ohmyho-release-${"c".repeat(16)}@sha256:${"d".repeat(64)}`,
            imageBinding: "preview",
            workerVersionId: receipt(previewName).versionId,
            policy: "durable_object",
          },
        ],
      };
    }
    return receipt(input.expectedName);
  };
  await executeReleaseTrain(f.options);
  assert.equal(calls.find((x) => x.name === previewName).bootstrap, true);
  assert.ok(calls.filter((x) => x.name !== previewName).every((x) => x.bootstrap === undefined));

  const existing = await fixture(context, value),
    existingCalls = [];
  const present = new Map(
    value.steps.map((step) => [
      step.workerName,
      {
        workerName: step.workerName,
        subdomain: { enabled: false, previews_enabled: false },
        crons: step.workerName === previewName ? ["*/1 * * * *"] : [],
      },
    ]),
  );
  existing.options.observeIngress = async () => ({
    domains: [],
    routes: [],
    workers: [...present.values()],
  });
  existing.options.release = async (input) => {
    existingCalls.push(input);
    return input.expectedName === previewName
      ? {
          ...receipt(previewName),
          containers: [
            {
              applicationId: "a".repeat(32),
              image: `registry.cloudflare.com/${ACCOUNT}/ohmyho-release-${"c".repeat(16)}@sha256:${"d".repeat(64)}`,
              imageBinding: "preview",
              workerVersionId: receipt(previewName).versionId,
              policy: "durable_object",
            },
          ],
        }
      : receipt(input.expectedName);
  };
  await executeReleaseTrain(existing.options);
  assert.equal(
    existingCalls.find((x) => x.expectedName === previewName).allowContainerBootstrap,
    undefined,
  );

  const vanished = await fixture(context, value);
  let observations = 0,
    attempted = false;
  vanished.options.observeIngress = async () => {
    observations++;
    const copy = new Map(present);
    if (observations > 1)
      copy.set(previewName, {
        workerName: previewName,
        presence: { kind: "absent", accountId: ACCOUNT, workerName: previewName },
      });
    return { domains: [], routes: [], workers: [...copy.values()] };
  };
  vanished.options.release = async (input) => {
    if (input.expectedName === previewName) {
      attempted = true;
      assert.equal(input.allowContainerBootstrap, undefined);
      return {
        ...receipt(previewName),
        containers: [
          {
            applicationId: "a".repeat(32),
            image: `registry.cloudflare.com/${ACCOUNT}/ohmyho-release-${"c".repeat(16)}@sha256:${"d".repeat(64)}`,
            imageBinding: "preview",
            workerVersionId: receipt(previewName).versionId,
            policy: "durable_object",
          },
        ],
      };
    }
    return receipt(input.expectedName);
  };
  await assert.rejects(executeReleaseTrain(vanished.options), /ingress or schedules drifted/u);
  assert.equal(attempted, true);
});
