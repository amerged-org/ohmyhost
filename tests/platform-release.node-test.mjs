/* global Headers, Response */
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { inspect, promisify } from "node:util";

import {
  inspectReleaseRepository,
  verifyPublicClientRelease,
  releaseWorker,
  readArtifactDigest,
  renderWranglerConfiguration,
  synchronizeCronTriggers,
  validateReleaseSecretsFile,
  verifyWorkerReleaseReceipt,
  verifyControlApiInvocationLogs,
  verifyDeclaredVersionBindings,
  verifyEgressObservability,
  workerReleaseIdentity,
} from "../scripts/platform-release.mjs";
import { WorkerAbsentError } from "../scripts/release-worker-presence.mjs";

const SHA = "a".repeat(40);
const previousCi = (databaseId = 7, headSha = SHA) => ({
  databaseId,
  headSha,
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
});

test("release secrets require a private regular file of valid names and values", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-release-secrets-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "secrets.json");
  const secrets = {
    EXAMPLE_SECRET: "private-test-value",
    DATABASE_REGISTRY_KEY: `${"A".repeat(43)}=`,
  };
  await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
  assert.deepEqual((await validateReleaseSecretsFile({ path: file })).names, [
    "DATABASE_REGISTRY_KEY",
    "EXAMPLE_SECRET",
  ]);
  for (const invalid of [
    { ...secrets, DATABASE_REGISTRY_KEY: "short" },
    { lowercase: "value" },
    { EXAMPLE_SECRET: "" },
    { EXAMPLE_SECRET: 7 },
    [],
  ]) {
    await writeFile(file, JSON.stringify(invalid), { mode: 0o600 });
    await assert.rejects(validateReleaseSecretsFile({ path: file }), /invalid|one JSON object/u);
  }
  await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
  const hardlink = join(directory, "second-link.json");
  await link(file, hardlink);
  await assert.rejects(validateReleaseSecretsFile({ path: file }));
  await rm(hardlink);
  const shortcut = join(directory, "shortcut.json");
  await symlink(file, shortcut);
  await assert.rejects(validateReleaseSecretsFile({ path: shortcut }));
  await chmod(file, 0o644);
  await assert.rejects(validateReleaseSecretsFile({ path: file }));
  if (process.platform !== "win32") {
    const fifo = join(directory, "pipe.json");
    await promisify(execFile)("mkfifo", [fifo]);
    await assert.rejects(validateReleaseSecretsFile({ path: fifo }));
  }
});

test("a release runs CI once for the released commit and refuses a commit that is not green", async () => {
  const { requireVerifiedCommit } = await import("../scripts/platform-release.mjs");
  const sha = "b".repeat(40);
  const calls = [];
  const runs = (entries) => async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "run" && args[1] === "list") return JSON.stringify(entries());
    return "";
  };

  // An existing green run is reused: no second dispatch for the other Workers of the same commit.
  await assert.strictEqual(
    await requireVerifiedCommit({
      sha,
      run: runs(() => [
        { databaseId: 7, headSha: sha, status: "completed", conclusion: "success" },
      ]),
    }),
    7,
  );
  assert.ok(!calls.some((entry) => entry.includes("workflow")));
  await assert.rejects(
    requireVerifiedCommit({
      sha,
      run: runs(() => [
        { databaseId: 8, headSha: sha, status: "completed", conclusion: "failure" },
      ]),
    }),
    /ended as failure/u,
  );

  // A commit without a run is dispatched once, watched, and only then released.
  let phase = 0;
  const dispatched = [];
  const dispatchRun = async (command, args) => {
    dispatched.push([command, ...args]);
    if (args[0] === "run" && args[1] === "list") {
      const entries = [
        [],
        [{ databaseId: 9, headSha: sha, status: "in_progress", conclusion: null }],
        [{ databaseId: 9, headSha: sha, status: "completed", conclusion: "success" }],
      ];
      return JSON.stringify(entries[Math.min(phase++, entries.length - 1)]);
    }
    return "";
  };
  assert.strictEqual(
    await requireVerifiedCommit({ sha, run: dispatchRun, wait: async () => undefined }),
    9,
  );
  assert.ok(dispatched.some((entry) => entry.join(" ").includes("workflow run ci.yml")));
  assert.ok(dispatched.some((entry) => entry.join(" ").includes("run watch 9")));

  phase = 0;
  dispatched.length = 0;
  assert.strictEqual(
    await requireVerifiedCommit({
      sha,
      ref: "feat/feedback-mail",
      run: dispatchRun,
      wait: async () => undefined,
    }),
    9,
  );
  assert.ok(dispatched.some((entry) => entry.join(" ").includes("--ref feat/feedback-mail")));

  // A watched run that ends red never reaches wrangler.
  let redPhase = 0;
  await assert.rejects(
    requireVerifiedCommit({
      sha,
      wait: async () => undefined,
      run: async (command, args) => {
        if (args[0] === "run" && args[1] === "list") {
          const entries = [
            [],
            [{ databaseId: 10, headSha: sha, status: "in_progress", conclusion: null }],
            [{ databaseId: 10, headSha: sha, status: "completed", conclusion: "cancelled" }],
          ];
          return JSON.stringify(entries[Math.min(redPhase++, entries.length - 1)]);
        }
        return "";
      },
    }),
    /is not green/u,
  );

  await assert.rejects(
    requireVerifiedCommit({ sha: "short", run: runs(() => []) }),
    /exact commit/u,
  );
});

test("a recorded CI run stays the evidence when a later run of the same commit is green too", async () => {
  const { requireVerifiedCommit } = await import("../scripts/platform-release.mjs");
  const sha = "c".repeat(40);
  const listing = (entries) => async (_command, args) =>
    args[0] === "run" && args[1] === "list" ? JSON.stringify(entries) : "";
  const green = (databaseId) => ({
    databaseId,
    headSha: sha,
    status: "completed",
    conclusion: "success",
  });
  // gh lists the newest run first: without a recorded run the newest green run answers.
  assert.strictEqual(
    await requireVerifiedCommit({ sha, run: listing([green(12), green(11)]) }),
    12,
  );
  assert.strictEqual(
    await requireVerifiedCommit({ sha, run: listing([green(12), green(11)]), preferredRunId: 11 }),
    11,
  );
  // A recorded run that is no longer green, or no longer listed, never hides the green one: the caller
  // compares the answer with its record and refuses the change.
  assert.strictEqual(
    await requireVerifiedCommit({
      sha,
      run: listing([green(12), { ...green(11), conclusion: "failure" }]),
      preferredRunId: 11,
    }),
    12,
  );
  assert.strictEqual(
    await requireVerifiedCommit({ sha, run: listing([green(12)]), preferredRunId: 11 }),
    12,
  );
});

test("release repository must be clean main at the exact origin/main SHA", async () => {
  const commands = [];
  const run = async (command, args) => {
    commands.push([command, ...args]);
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return "/repo\n";
    if (key === "rev-parse --is-bare-repository") return "false\n";
    if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
    if (key === "status --porcelain=v1 --untracked-files=all") return "";
    if (key === "rev-parse HEAD" || key === "rev-parse refs/remotes/origin/main") {
      return `${SHA}\n`;
    }
    if (key === "remote get-url --push origin" || key === "remote get-url origin") {
      return "https://github.com/amerged-org/ohmyhost.git\n";
    }
    if (key === "ls-remote --exit-code origin refs/heads/main") {
      return `${SHA}\trefs/heads/main\n`;
    }
    if (command === "gh" && args[0] === "run" && args[1] === "list") {
      return JSON.stringify([
        { databaseId: 42, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    }
    throw new Error(`unexpected command: ${command} ${key}`);
  };

  assert.deepEqual(await inspectReleaseRepository({ cwd: "/repo", run }), {
    repositoryRoot: "/repo",
    sha: SHA,
  });
  assert.ok(commands.some((entry) => entry.includes("ls-remote")));

  const dirtyRun = async (command, args) => {
    if (args[0] === "status") return " M PLAN.md\n";
    return run(command, args);
  };
  await assert.rejects(
    inspectReleaseRepository({ cwd: "/repo", run: dirtyRun }),
    /clean worktree/u,
  );
  for (const origin of [
    "https://github.com/sebmer-com/ohmyho.git",
    "https://github.com/aixyte/ohmyho.git",
    "https://github.com/amerged/unrelated.git",
  ]) {
    await assert.rejects(
      inspectReleaseRepository({
        cwd: "/repo",
        run: (command, args) =>
          args.join(" ") === "remote get-url --push origin"
            ? Promise.resolve(`${origin}\n`)
            : run(command, args),
      }),
      /unexpected origin push URL/u,
    );
  }
  await assert.rejects(
    inspectReleaseRepository({
      cwd: "/repo",
      run: (command, args) =>
        args.join(" ") === "remote get-url origin"
          ? Promise.resolve("https://github.com/other/repository.git")
          : run(command, args),
    }),
    /unexpected origin fetch URL/u,
  );

  const branch = "feat/feedback-mail";
  const branchRun = async (command, args) => {
    const key = args.join(" ");
    if (key === "symbolic-ref --quiet HEAD") return `refs/heads/${branch}\n`;
    if (key === "rev-parse refs/remotes/origin/feat/feedback-mail") return `${SHA}\n`;
    if (key === "ls-remote --exit-code origin refs/heads/feat/feedback-mail")
      return `${SHA}\trefs/heads/${branch}\n`;
    if (key === "remote get-url origin") return "https://github.com/amerged-org/ohmyhost.git\n";
    if (key === `merge-base --is-ancestor ${SHA} ${SHA}`) return "";
    return run(command, args);
  };
  assert.deepEqual(await inspectReleaseRepository({ cwd: "/repo", run: branchRun }), {
    repositoryRoot: "/repo",
    sha: SHA,
    branch,
  });
  for (const [intercept, replacement] of [
    ["symbolic-ref --quiet HEAD", "refs/heads/invalid/extra/slash"],
    ["remote get-url origin", "https://github.com/other/repository.git"],
    ["rev-parse refs/remotes/origin/feat/feedback-mail", "c".repeat(40)],
    [
      "ls-remote --exit-code origin refs/heads/feat/feedback-mail",
      `${"c".repeat(40)}\trefs/heads/${branch}`,
    ],
    ["ls-remote --exit-code origin refs/heads/feat/feedback-mail", `${SHA}\trefs/heads/feat/other`],
    ["ls-remote --exit-code origin refs/heads/main", `${"c".repeat(40)}\trefs/heads/main`],
  ])
    await assert.rejects(
      inspectReleaseRepository({
        cwd: "/repo",
        run: (command, args) =>
          args.join(" ") === intercept ? Promise.resolve(replacement) : branchRun(command, args),
      }),
    );
  await assert.rejects(
    inspectReleaseRepository({
      cwd: "/repo",
      run: (command, args) =>
        args[0] === "merge-base"
          ? Promise.reject(new Error("not ancestor"))
          : branchRun(command, args),
    }),
    /not ancestor/u,
  );
});

test("an artifact-pinned Worker releases under the digest it was built from", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-platform-release-artifact-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const worker = "ohmyhost-workos-management-production";
  const digest = "a".repeat(64);
  const proofPath = join(root, "apps", "workos-management", "dist", "candidate-artifact.json");
  await mkdir(join(root, "apps", "workos-management", "dist"), { recursive: true });
  await writeFile(proofPath, JSON.stringify({ artifactSha256: digest }));

  // The digest comes from the build output, never from the operator's file.
  const artifact = await readArtifactDigest({ repositoryRoot: root, workerName: worker });
  assert.deepEqual(artifact, {
    digest,
    variable: "MANAGEMENT_ARTIFACT_SHA256",
    package: "@ohmyhost/workos-management",
  });
  assert.equal(
    await readArtifactDigest({ repositoryRoot: root, workerName: "ohmyho-control-api-production" }),
    null,
  );

  const sourcePath = join(root, "private", "wrangler.jsonc");
  const outputPath = join(root, "output", "wrangler.json");
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private", "worker-main.js"), "export default {};\n");
  await writeFile(
    sourcePath,
    JSON.stringify({
      name: worker,
      main: "worker-main.js",
      workers_dev: false,
      preview_urls: false,
      // A stale pin from an earlier build must never reach the provider.
      vars: { MANAGEMENT_ARTIFACT_SHA256: "b".repeat(64), WORKOS_DEPLOYMENT: "production" },
    }),
    { encoding: "utf8", flag: "wx" },
  );

  const rendered = await renderWranglerConfiguration({
    expectedName: worker,
    outputPath,
    sourcePath,
    artifact,
  });
  assert.equal(rendered.vars.MANAGEMENT_ARTIFACT_SHA256, digest);
  assert.equal(rendered.vars.WORKOS_DEPLOYMENT, "production");
  assert.equal(
    JSON.parse(await readFile(outputPath, "utf8")).vars.MANAGEMENT_ARTIFACT_SHA256,
    digest,
  );

  // A build output without a usable digest refuses the release instead of shipping untagged.
  await writeFile(proofPath, JSON.stringify({ artifactSha256: "not-a-digest" }));
  await assert.rejects(
    readArtifactDigest({ repositoryRoot: root, workerName: worker }),
    /no usable artifact digest/u,
  );

  // An artifact-pinned Worker without vars cannot satisfy its own tag check.
  await writeFile(sourcePath, JSON.stringify({ ...rendered, main: "worker-main.js", vars: [] }));
  await assert.rejects(
    renderWranglerConfiguration({ expectedName: worker, outputPath, sourcePath, artifact }),
    /requires vars for an artifact-pinned Worker/u,
  );
});

test("environment keyring release declarations retain secret readers and the allocated dated writer", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-keyring-release-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configurations = [
    ["ohmyho-control-api-poc-private-fullstack", "apps/control-api/wrangler.jsonc"],
    ["ohmyho-control-api-production", "apps/control-api/wrangler.production.jsonc"],
    [
      "ohmyho-runtime-secret-delivery-poc-private-fullstack",
      "apps/runtime-secret-delivery/wrangler.development.jsonc",
    ],
    [
      "ohmyho-runtime-secret-delivery-production",
      "apps/runtime-secret-delivery/wrangler.production.jsonc",
    ],
  ];
  for (const [expectedName, relative] of configurations) {
    const rendered = await renderWranglerConfiguration({
      expectedName,
      sourcePath: fileURLToPath(new URL(`../${relative}`, import.meta.url)),
      outputPath: join(directory, `${expectedName}.json`),
    });
    assert.equal(rendered.vars.ENVIRONMENT_SECRET_KEY_VERSION, "20261106", expectedName);
    // An empty vars map would shadow the uploaded additional-reader secret.
    assert.equal(Object.hasOwn(rendered.vars, "ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON"), false);
    assert.equal(Object.hasOwn(rendered.vars, "ENVIRONMENT_SECRET_KEY_BASE64"), false);
    assert.deepEqual(rendered.secrets.required, [
      "ENVIRONMENT_SECRET_KEY_BASE64",
      "ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON",
    ]);
    assert.equal(rendered.name, expectedName);
  }
});

test("webhook profile rendering requires preserved private verifier policies without inline defaults", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-webhook-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [expectedName, file] of [
    ["ohmyho-workos-webhook-poc-private-fullstack", "wrangler.jsonc"],
    ["ohmyho-webhook-ingress-production", "wrangler.production.jsonc"],
  ]) {
    const rendered = await renderWranglerConfiguration({
      expectedName,
      sourcePath: fileURLToPath(new URL(`../apps/webhook-ingress/${file}`, import.meta.url)),
      outputPath: join(directory, `${expectedName}.json`),
    });
    assert.deepEqual(rendered.secrets.required, [
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON",
      "WORKOS_WEBHOOK_SECRET",
      "WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_WEBHOOK_SECRET",
    ]);
    assert.deepEqual(Object.keys(rendered.vars).sort(), ["STRIPE_ACCOUNT_ID", "STRIPE_MODE"]);
    assert.equal(rendered.name, expectedName);
  }
});

test("release rendering emits a normalized production config with an absolute entrypoint", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-platform-release-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "app", "wrangler.jsonc");
  const outputPath = join(root, "output", "wrangler.json");
  await mkdir(join(root, "app"));
  await writeFile(join(root, "app", "src-worker.ts"), "export default {};\n");
  await writeFile(
    sourcePath,
    `{
      // the checked-in config may contain comments
      "name": "ohmyho-example-poc-private-fullstack",
      "main": "src-worker.ts",
      "workers_dev": true,
      "preview_urls": false,
      "vars": { "RUNTIME_CONFIGURATION_STATE": "configured" },
    }\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const rendered = await renderWranglerConfiguration({
    expectedName: "ohmyho-example-poc-private-fullstack",
    outputPath,
    sourcePath,
  });

  assert.equal(rendered.name, "ohmyho-example-poc-private-fullstack");
  assert.equal(rendered.main, join(root, "app", "src-worker.ts"));
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), rendered);
  await writeFile(
    sourcePath,
    JSON.stringify({ ...rendered, name: "ohmyho-control-api-production" }),
  );
  const production = await renderWranglerConfiguration({
    expectedName: "ohmyho-control-api-production",
    outputPath,
    sourcePath,
  });
  assert.equal(production.name, "ohmyho-control-api-production");
  await assert.rejects(
    renderWranglerConfiguration({
      expectedName: "ohmyho-example-poc-private-fullstack",
      outputPath,
      sourcePath,
    }),
    /worker name/u,
  );
  await writeFile(sourcePath, JSON.stringify({ ...rendered, name: "unrelated-production" }));
  await assert.rejects(
    renderWranglerConfiguration({
      expectedName: "unrelated-production",
      outputPath,
      sourcePath,
    }),
    /worker name/u,
  );
  for (const [file, name] of [
    ["wrangler.jsonc", "ohmyho-billing-poc-private-fullstack"],
    ["wrangler.production.jsonc", "ohmyho-billing-production"],
  ]) {
    const billing = await renderWranglerConfiguration({
      expectedName: name,
      sourcePath: fileURLToPath(new URL(`../apps/billing/${file}`, import.meta.url)),
      outputPath,
    });
    assert.equal(billing.name, name);
    assert.equal(billing.workers_dev, false);
    assert.equal(billing.preview_urls, false);
    assert.deepEqual(billing.triggers.crons, []);
  }
  for (const environment of ["development", "production"]) {
    for (const region of ["us", "eu"]) {
      const name = `ohmyho-native-auth-${environment}-${region}`;
      const native = await renderWranglerConfiguration({
        expectedName: name,
        sourcePath: fileURLToPath(
          new URL(
            `../apps/native-auth-runtime/wrangler.${environment}.${region}.jsonc`,
            import.meta.url,
          ),
        ),
        outputPath,
      });
      assert.equal(native.name, name);
      assert.equal(native.vars.NATIVE_AUTH_REGION_ID, `${region}-dev`);
    }
  }
  for (const name of [
    "ohmyho-native-auth-production-ap",
    "ohmyho-native-auth-development-us-extra",
    "ohmyhost-native-auth-production-us",
    "ohmyho-native-auth-stage-us",
  ]) {
    await writeFile(sourcePath, JSON.stringify({ ...rendered, name }));
    await assert.rejects(
      renderWranglerConfiguration({ expectedName: name, outputPath, sourcePath }),
      /worker name/u,
    );
  }
  const developmentApi = await renderWranglerConfiguration({
    expectedName: "ohmyho-control-api-poc-private-fullstack",
    sourcePath: fileURLToPath(new URL("../apps/control-api/wrangler.jsonc", import.meta.url)),
    outputPath,
  });
  assert.deepEqual(
    developmentApi.services.find(({ binding }) => binding === "BILLING"),
    {
      binding: "BILLING",
      service: "ohmyho-billing-poc-private-fullstack",
    },
  );
  const ingress = await renderWranglerConfiguration({
    expectedName: "ohmyho-workos-webhook-poc-private-fullstack",
    sourcePath: fileURLToPath(new URL("../apps/webhook-ingress/wrangler.jsonc", import.meta.url)),
    outputPath,
  });
  assert.equal(ingress.vars.STRIPE_ACCOUNT_ID, "acct_00000W39Example2");
  assert.equal(ingress.vars.STRIPE_MODE, "test");
  const productionApi = await renderWranglerConfiguration({
    expectedName: "ohmyho-control-api-production",
    sourcePath: fileURLToPath(
      new URL("../apps/control-api/wrangler.production.jsonc", import.meta.url),
    ),
    outputPath,
  });
  assert.deepEqual(
    productionApi.services.find(({ binding }) => binding === "BILLING"),
    {
      binding: "BILLING",
      service: "ohmyho-billing-production",
    },
  );
  const productionIngress = await renderWranglerConfiguration({
    expectedName: "ohmyho-webhook-ingress-production",
    sourcePath: fileURLToPath(
      new URL("../apps/webhook-ingress/wrangler.production.jsonc", import.meta.url),
    ),
    outputPath,
  });
  assert.deepEqual(productionIngress.vars, {
    STRIPE_ACCOUNT_ID: "acct_00000W39Example6",
    STRIPE_MODE: "live",
  });
  for (const [file, name] of [
    ["wrangler.shared.jsonc", "ohmyho-gateway-poc-private-fullstack"],
    ["wrangler.production.shared.jsonc", "ohmyho-gateway-production"],
  ]) {
    const sharedGateway = await renderWranglerConfiguration({
      expectedName: name,
      sourcePath: fileURLToPath(new URL(`../apps/wfp-dispatch/${file}`, import.meta.url)),
      outputPath,
    });
    assert.equal(sharedGateway.routes, undefined);
    assert.equal(sharedGateway.workers_dev, false);
  }
  for (const environment of ["development", "production"])
    for (const region of ["us", "eu"]) {
      const regionalDatabase = await renderWranglerConfiguration({
        expectedName: `ohmyho-project-database-${environment}-${region}`,
        sourcePath: fileURLToPath(
          new URL(
            `../apps/project-database-runtime/wrangler.${environment}.${region}.jsonc`,
            import.meta.url,
          ),
        ),
        outputPath,
      });
      assert.equal(regionalDatabase.vars.DATABASE_REGION, region);
      // Redacted failure lines persist; invocation logs (request URLs) stay off.
      assert.equal(regionalDatabase.observability.logs.persist, true);
      assert.equal(regionalDatabase.observability.logs.invocation_logs, false);
      assert.equal(regionalDatabase.routes, undefined);
      assert.equal(regionalDatabase.workers_dev, false);
    }
  const publicSite = await renderWranglerConfiguration({
    expectedName: "ohmyho-public-production",
    sourcePath: fileURLToPath(new URL("../apps/public-site/wrangler.jsonc", import.meta.url)),
    outputPath,
  });
  assert.ok(publicSite.routes.some((route) => route.pattern === "check.omh.st"));
  assert.ok(publicSite.routes.some((route) => route.pattern === "dev.check.omh.st"));
  assert.ok(publicSite.routes.every((route) => !route.pattern.startsWith("*.")));
});

test("release uploads one exact version, deploys it, and verifies provider state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-platform-release-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "wrangler.jsonc");
  await writeFile(
    sourcePath,
    JSON.stringify({
      name: "ohmyho-example-poc-private-fullstack",
      main: "worker.mjs",
      workers_dev: false,
      preview_urls: false,
      vars: { RUNTIME_CONFIGURATION_STATE: "configured" },
    }),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ohmyhost/example" }));
  await writeFile(
    join(root, "worker.mjs"),
    "export default { fetch() { return new Response('ok'); } };\n",
  );
  // The secret lives in its own private directory: a file inside the checkout is refused.
  const secretDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-release-secret-dir-"));
  context.after(() => rm(secretDirectory, { recursive: true, force: true }));
  const secretSource = join(secretDirectory, "secrets.json");
  await writeFile(
    secretSource,
    JSON.stringify({ DATABASE_REGISTRY_KEY: Buffer.alloc(32, 1).toString("base64") }),
    { mode: 0o600 },
  );

  const calls = [];
  let copiedSecretPath;
  let uploaded = false;
  let deployed = false;
  let listingFailure;
  let retriedUpload = false;
  const version = {
    id: "11111111-2222-4333-8444-555555555555",
    annotations: {
      "workers/tag": `release-${SHA.slice(0, 12)}`,
      "workers/message": `origin/main ${SHA}`,
    },
  };
  let buildDirties = false;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "pnpm") {
      assert.deepEqual(args, ["--filter", "@ohmyhost/example...", "build"]);
      return "built\n";
    }
    if (command === "gh") {
      assert.deepEqual(args.slice(0, 2), ["run", "list"]);
      return JSON.stringify([
        { databaseId: 42, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    }
    if (command === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return `${root}\n`;
      if (key === "rev-parse --is-bare-repository") return "false\n";
      if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
      if (key === "status --porcelain=v1 --untracked-files=all") {
        // The status read right after the build must abort the release when the tree is dirty.
        const afterBuild = calls.at(-2)?.[0] === "pnpm";
        return afterBuild && buildDirties ? " M apps/example/src/generated.ts\n" : "";
      }
      if (key === "rev-parse HEAD" || key === "rev-parse refs/remotes/origin/main") {
        return `${SHA}\n`;
      }
      if (key === "remote get-url --push origin" || key === "remote get-url origin") {
        return "https://github.com/amerged-org/ohmyhost.git\n";
      }
      if (key === "ls-remote --exit-code origin refs/heads/main") {
        return `${SHA}\trefs/heads/main\n`;
      }
    }
    if (args[0] === "versions" && args[1] === "list") {
      if (listingFailure) throw listingFailure;
      if (!uploaded)
        throw Object.assign(new Error("Wrangler failed"), {
          stderr: "This Worker does not exist on your account. [code: 10007]",
        });
      return JSON.stringify(
        retriedUpload
          ? [
              {
                ...version,
                id: "99999999-2222-4333-8444-555555555555",
                metadata: { created_on: "2026-09-23T08:11:13.021Z" },
              },
              version,
            ]
          : [version],
      );
    }
    if (args[0] === "versions" && args[1] === "upload") {
      assert.ok(uploaded, "Wrangler cannot upload a version before the first deploy");
      assert.equal(args.includes("--containers-rollout"), false);
      version.annotations["workers/tag"] = args[args.indexOf("--tag") + 1];
      version.annotations["workers/message"] = args[args.indexOf("--message") + 1];
      uploaded = true;
      deployed = false;
      return "uploaded\n";
    }
    if (args[0] === "deploy") {
      assert.equal(uploaded, false, "direct deploy is only for confirmed initial absence");
      assert.equal(
        args.includes("--containers-rollout"),
        false,
        "no container rollout flag without containers",
      );
      copiedSecretPath = args[args.indexOf("--secrets-file") + 1];
      assert.notEqual(copiedSecretPath, secretSource);
      assert.deepEqual(JSON.parse(await readFile(copiedSecretPath, "utf8")), {
        DATABASE_REGISTRY_KEY: Buffer.alloc(32, 1).toString("base64"),
      });
      assert.equal((await stat(copiedSecretPath)).mode & 0o077, 0);
      version.annotations["workers/tag"] = args[args.indexOf("--tag") + 1];
      version.annotations["workers/message"] = args[args.indexOf("--message") + 1];
      uploaded = true;
      deployed = true;
      return "created and deployed\n";
    }
    if (args[0] === "versions" && args[1] === "view") {
      const configuration = JSON.parse(await readFile(sourcePath, "utf8"));
      return JSON.stringify({
        ...version,
        resources: {
          bindings: (configuration.services ?? []).map(({ binding, ...service }) => ({
            name: binding,
            type: "service",
            ...service,
          })),
        },
      });
    }
    if (args[0] === "deployments" && args[1] === "status") {
      return JSON.stringify({
        versions: deployed ? [{ version_id: version.id, percentage: 100 }] : [],
      });
    }
    if (args[0] === "versions" && args[1] === "deploy") {
      deployed = true;
      return "deployed\n";
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const result = await releaseWorker({
    configPath: sourcePath,
    cwd: root,
    run,
    wrangler: "wrangler",
    secretsFile: secretSource,
  });

  assert.deepEqual(result, {
    cronTriggers: "preserved",
    deploymentVerified: true,
    sha: SHA,
    uploaded: true,
    versionId: version.id,
    workerName: "ohmyho-example-poc-private-fullstack",
    tag: version.annotations["workers/tag"],
    message: version.annotations["workers/message"],
  });
  assert.ok(calls.some(([, ...args]) => args[0] === "deploy"));
  await assert.rejects(readFile(copiedSecretPath, "utf8"));
  assert.equal(calls.filter(([, ...args]) => args[1] === "upload").length, 0);
  // The Worker's workspace packages are built before the first Wrangler call.
  const firstBuild = calls.findIndex(([executable]) => executable === "pnpm");
  const firstWrangler = calls.findIndex(([executable]) => executable === "wrangler");
  assert.ok(firstBuild !== -1 && firstBuild < firstWrangler);
  buildDirties = true;
  await assert.rejects(
    releaseWorker({ configPath: sourcePath, cwd: root, run, wrangler: "wrangler" }),
    /build changed tracked files/u,
  );
  buildDirties = false;
  await assert.rejects(
    releaseWorker({
      configPath: sourcePath,
      cwd: root,
      run,
      wrangler: "wrangler",
      secretsFile: secretSource,
    }),
    /already has a matching version/u,
  );
  const unchanged = await releaseWorker({
    configPath: sourcePath,
    cwd: root,
    run,
    wrangler: "wrangler",
  });
  assert.equal(unchanged.uploaded, false);
  const previousTag = version.annotations["workers/tag"];
  const changedConfig = JSON.parse(await readFile(sourcePath, "utf8"));
  changedConfig.services = [
    {
      binding: "NEON_MANAGEMENT",
      service: "ohmyho-neon-management-poc-private-fullstack",
      entrypoint: "NeonManagementService",
    },
  ];
  await writeFile(sourcePath, JSON.stringify(changedConfig));
  const changed = await releaseWorker({
    configPath: sourcePath,
    cwd: root,
    run,
    wrangler: "wrangler",
  });
  assert.equal(
    changed.uploaded,
    true,
    "changed configuration must not adopt the previous SHA-only version",
  );
  assert.notEqual(version.annotations["workers/tag"], previousTag);
  assert.ok(calls.some(([, ...args]) => args[0] === "versions" && args[1] === "deploy"));
  const uploads = calls.filter(([, ...args]) => args[1] === "upload").length;
  for (const stderr of ["Authentication error [code: 10000]", "Network timeout"]) {
    listingFailure = Object.assign(new Error("Wrangler failed"), { stderr });
    await assert.rejects(
      releaseWorker({ configPath: sourcePath, cwd: root, run, wrangler: "wrangler" }),
      listingFailure,
    );
  }
  assert.equal(calls.filter(([, ...args]) => args[1] === "upload").length, uploads);
  listingFailure = undefined;

  // Wrangler retried a slow upload by itself: two identical versions; deploy the newest.
  retriedUpload = true;
  version.metadata = { created_on: "2026-09-23T08:12:24.168Z" };
  changedConfig.vars.RETRY = "1";
  await writeFile(sourcePath, JSON.stringify(changedConfig));
  const retried = await releaseWorker({
    configPath: sourcePath,
    cwd: root,
    run,
    wrangler: "wrangler",
  });
  assert.equal(retried.versionId, version.id);
  assert.equal(retried.deploymentVerified, true);
  version.metadata = { created_on: "2026-09-23T08:11:13.021Z" };
  changedConfig.vars.RETRY = "2";
  await writeFile(sourcePath, JSON.stringify(changedConfig));
  await assert.rejects(
    releaseWorker({ configPath: sourcePath, cwd: root, run, wrangler: "wrangler" }),
    /one exact release version/u,
  );
  // A resumed release whose config still matches finds two versions and takes the newest, without uploading again.
  retriedUpload = true;
  version.metadata = { created_on: "2026-09-23T08:12:24.168Z" };
  const uploadsBeforeResume = calls.filter(
    ([, ...args]) => args[0] === "versions" && args[1] === "upload",
  ).length;
  const resumed = await releaseWorker({
    configPath: sourcePath,
    cwd: root,
    run,
    wrangler: "wrangler",
  });
  assert.equal(resumed.versionId, version.id);
  assert.equal(
    calls.filter(([, ...args]) => args[0] === "versions" && args[1] === "upload").length,
    uploadsBeforeResume,
  );
  // A version upload must prove its D1 authority before deployment, even when every service is correct.
  retriedUpload = false;
  changedConfig.d1_databases = [
    { binding: "CONTROL_CORE", database_id: "12345678-1234-4234-8234-123456789abc" },
  ];
  await writeFile(sourcePath, JSON.stringify(changedConfig));
  const deploymentsBefore = calls.filter(([, ...args]) => args[1] === "deploy").length;
  await assert.rejects(
    releaseWorker({ configPath: sourcePath, cwd: root, run, wrangler: "wrangler" }),
    /binding is missing or ambiguous/u,
  );
  assert.equal(calls.filter(([, ...args]) => args[1] === "deploy").length, deploymentsBefore);
});

test("completed release replay verifies the exact declared D1 authority rather than only the Worker version", async () => {
  const databaseId = "12345678-1234-4234-8234-123456789abc";
  const configuration = {
    name: "ohmyho-d1-example-poc-private-fullstack",
    d1_databases: [{ binding: "CONTROL_CORE", database_id: databaseId }],
  };
  const identity = workerReleaseIdentity({ sha: SHA, configuration });
  const receipt = {
    deploymentVerified: true,
    versionId: "11111111-2222-4333-8444-555555555555",
    workerName: configuration.name,
    sha: SHA,
    ...identity,
  };
  let bindings = [{ name: "CONTROL_CORE", type: "d1", id: databaseId }];
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      configuration,
      repositoryRoot: "/unused-no-artifact-or-container",
      sourceSha: SHA,
      wrangler: "wrangler",
      run: async (_command, args) => {
        if (args[0] === "versions" && args[1] === "view")
          return JSON.stringify({
            id: receipt.versionId,
            annotations: { "workers/tag": identity.tag, "workers/message": receipt.message },
            resources: { bindings },
          });
        assert.deepEqual(args.slice(0, 2), ["deployments", "status"]);
        return JSON.stringify({ versions: [{ version_id: receipt.versionId, percentage: 100 }] });
      },
    });
  assert.equal(await verify(), true);
  receipt.message = identity.message.replace(/^source /u, "origin/main ");
  assert.equal(await verify(), true, "historical main provenance remains verifiable");
  receipt.message = identity.message.replace(/^source /u, "untrusted ");
  await assert.rejects(verify(), /not the exact current source/u);
  receipt.message = identity.message;
  for (const changed of [
    [],
    [{ name: "CONTROL_CORE", type: "d1", id: "87654321-4321-4321-8321-abcdefabcdef" }],
    [{ name: "CONTROL_CORE", type: "kv_namespace", id: databaseId }],
    [...bindings, ...bindings],
  ]) {
    bindings = changed;
    await assert.rejects(verify(), /Completed Worker .*binding/u);
  }
});

test("a release applies explicitly declared cron triggers to its own Worker and reads them back", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-platform-release-cron-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const account = "00000000000000000000000000000001";
  const worker = "ohmyho-ses-management-poc-private-fullstack";
  const neighbour = "ohmyho-mail-gateway-poc-private-fullstack";
  const sourcePath = join(root, "wrangler.jsonc");
  const configure = (extra) =>
    writeFile(
      sourcePath,
      JSON.stringify({
        name: worker,
        account_id: account,
        main: "worker.mjs",
        workers_dev: false,
        preview_urls: false,
        ...extra,
      }),
    );
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ohmyhost/example" }));
  await writeFile(join(root, "worker.mjs"), "export default {};\n");

  // Wrangler: the version and its 100% deployment; only schedules can still differ.
  const commands = [];
  const version = { id: "11111111-2222-4333-8444-555555555555", annotations: {} };
  let uploaded = false;
  let deployed = false;
  const run = async (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "pnpm") return "built\n";
    if (command === "gh")
      return JSON.stringify([
        { databaseId: 42, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    if (command === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return `${root}\n`;
      if (key === "rev-parse --is-bare-repository") return "false\n";
      if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
      if (key === "status --porcelain=v1 --untracked-files=all") return "";
      if (key === "rev-parse HEAD" || key === "rev-parse refs/remotes/origin/main")
        return `${SHA}\n`;
      if (key === "remote get-url --push origin" || key === "remote get-url origin")
        return "https://github.com/amerged-org/ohmyhost.git\n";
      if (key === "ls-remote --exit-code origin refs/heads/main")
        return `${SHA}\trefs/heads/main\n`;
    }
    if (args[0] === "versions" && args[1] === "list")
      return JSON.stringify(uploaded ? [version] : []);
    if (args[0] === "versions" && args[1] === "upload") {
      version.annotations = {
        "workers/tag": args[args.indexOf("--tag") + 1],
        "workers/message": args[args.indexOf("--message") + 1],
      };
      uploaded = true;
      deployed = false;
      return "uploaded\n";
    }
    if (args[0] === "versions" && args[1] === "view") return JSON.stringify(version);
    if (args[0] === "versions" && args[1] === "deploy") {
      deployed = true;
      return "deployed\n";
    }
    if (args[0] === "deployments")
      return JSON.stringify({
        versions: deployed ? [{ version_id: version.id, percentage: 100 }] : [],
      });
    if (args[0] === "auth" && args[1] === "token")
      return JSON.stringify({ type: "oauth", token: "wrangler-login-token" });
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  // Cloudflare's per-Worker schedules endpoint.
  const schedules = new Map([
    [worker, []],
    [neighbour, [{ cron: "* * * * *" }]],
  ]);
  const requests = [];
  let failing = false;
  let drifting = false;
  const fetch = async (url, init) => {
    const match =
      /^\/client\/v4\/accounts\/([a-f0-9]{32})\/workers\/scripts\/([^/]+)\/schedules$/u.exec(
        new URL(url).pathname,
      );
    assert.ok(match);
    assert.equal(match[1], account);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer wrangler-login-token");
    const script = decodeURIComponent(match[2]);
    requests.push(`${init.method} ${script}${init.body === undefined ? "" : ` ${init.body}`}`);
    if (failing)
      return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 });
    if (init.method === "PUT" && !drifting)
      schedules.set(
        script,
        JSON.parse(init.body).map(({ cron }) => ({ cron, created_on: "2026-09-24T10:29:35Z" })),
      );
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { schedules: schedules.get(script) ?? [] },
    });
  };
  const release = (env = {}) =>
    releaseWorker({ configPath: sourcePath, cwd: root, run, wrangler: "wrangler", fetch, env });
  const sinceLast = (list, count) => list.slice(count);

  // A failed schedule synchronization blocks completion although the version is live.
  await configure({ triggers: { crons: ["* * * * *"] } });
  failing = true;
  await assert.rejects(release(), /schedules request failed with status 403/u);
  assert.equal(deployed, true);
  failing = false;
  // The observed defect: the exact version is already active at 100% but its cron is missing.
  // The replay uploads and deploys nothing and repairs only the schedule.
  let commandCount = commands.length;
  let requestCount = requests.length;
  const repaired = await release();
  assert.equal(repaired.uploaded, false);
  assert.equal(repaired.cronTriggers, "updated");
  assert.ok(
    sinceLast(commands, commandCount).every(
      (command) => !/^wrangler (?:versions (?:upload|deploy)|deploy) /u.test(command),
    ),
  );
  assert.deepEqual(sinceLast(requests, requestCount), [
    `GET ${worker}`,
    `PUT ${worker} [{"cron":"* * * * *"}]`,
    `GET ${worker}`,
  ]);
  requestCount = requests.length;
  assert.equal((await release()).cronTriggers, "unchanged");
  assert.deepEqual(sinceLast(requests, requestCount), [`GET ${worker}`]);
  // A schedule that does not read back as declared blocks completion.
  schedules.set(worker, []);
  drifting = true;
  await assert.rejects(release(), /readback does not match the declared crons/u);
  drifting = false;

  // A config without the list leaves the schedules alone and reads no credential.
  schedules.set(worker, [{ cron: "*/5 * * * *" }]);
  await configure({});
  commandCount = commands.length;
  requestCount = requests.length;
  assert.equal((await release()).cronTriggers, "preserved");
  assert.equal(requests.length, requestCount);
  assert.ok(sinceLast(commands, commandCount).every((command) => !command.includes("auth token")));
  assert.deepEqual(schedules.get(worker), [{ cron: "*/5 * * * *" }]);
  // An explicitly empty list retires this Worker's schedules, and only this Worker's.
  await configure({ triggers: { crons: [] } });
  requestCount = requests.length;
  assert.equal((await release()).cronTriggers, "updated");
  assert.deepEqual(sinceLast(requests, requestCount), [
    `GET ${worker}`,
    `PUT ${worker} []`,
    `GET ${worker}`,
  ]);
  assert.deepEqual(schedules.get(worker), []);
  assert.deepEqual(schedules.get(neighbour), [{ cron: "* * * * *" }]);

  // Declared crons need one exact account: Wrangler's own variable may supply a missing one, but
  // a missing or conflicting account is refused before any Wrangler provider command or request.
  const providerCommands = () => commands.filter((command) => command.startsWith("wrangler "));
  const withoutAccount = JSON.parse(await readFile(sourcePath, "utf8"));
  delete withoutAccount.account_id;
  await writeFile(
    sourcePath,
    JSON.stringify({ ...withoutAccount, triggers: { crons: ["* * * * *"] } }),
  );
  let providerCount = providerCommands().length;
  requestCount = requests.length;
  await assert.rejects(release(), /one exact Cloudflare account_id/u);
  assert.equal(providerCommands().length, providerCount);
  assert.equal(requests.length, requestCount);
  assert.equal((await release({ CLOUDFLARE_ACCOUNT_ID: account })).cronTriggers, "updated");
  await configure({ triggers: { crons: ["* * * * *"] } });
  providerCount = providerCommands().length;
  requestCount = requests.length;
  await assert.rejects(
    release({ CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) }),
    /one exact Cloudflare account_id/u,
  );
  assert.equal(providerCommands().length, providerCount);
  assert.equal(requests.length, requestCount);
});

test("cron synchronization never surfaces Wrangler's credential output in an error", async () => {
  const token = "wrangler-login-token-value";
  const failedWithOutput = Object.assign(new Error("Command failed: wrangler auth token --json"), {
    stdout: JSON.stringify({ type: "oauth", token }),
  });
  let requests = 0;
  for (const run of [
    async () => token,
    async () => `${JSON.stringify({ type: "oauth", token })}\n${token}`,
    async () => {
      throw failedWithOutput;
    },
  ]) {
    const error = await synchronizeCronTriggers({
      target: { crons: ["* * * * *"], accountId: "e".repeat(32) },
      workerName: "ohmyho-example-poc-private-fullstack",
      run,
      wrangler: "wrangler",
      fetch: async () => {
        requests++;
        throw new Error("no request without a credential");
      },
    }).catch((caught) => caught);
    assert.equal(error.message, "Wrangler credential is unavailable");
    assert.equal(inspect(error, { depth: 10 }).includes(token), false);
  }
  assert.equal(requests, 0);
});

test("egress observability readback checks the Development v3 Worker like the PoC Worker", async () => {
  const account = "00000000000000000000000000000001";
  const declared = {
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, persist: true, invocation_logs: false },
    traces: { enabled: false },
  };
  // Cloudflare's script-settings readback, including the explicit provider defaults.
  const observed = {
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: false,
    logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false },
    traces: { enabled: false, persist: true, head_sampling_rate: 1 },
  };
  for (const name of [
    "ohmyho-wfp-egress-poc-private-fullstack",
    "ohmyho-wfp-egress-v3-poc-private-fullstack",
  ]) {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "auth" && args[1] === "token")
        return JSON.stringify({ type: "api_token", token: "egress-fixture-token" });
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const fetch = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.authorization, "Bearer egress-fixture-token");
      return Response.json({ success: true, errors: [], result: { observability: observed } });
    };
    await verifyEgressObservability({
      configuration: { name, account_id: account, observability: declared },
      run,
      wrangler: "wrangler",
      fetch,
      env: {},
    });
    assert.deepEqual(calls, [
      "wrangler auth token --json",
      `GET https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/script-settings`,
    ]);

    const invalid = { ...declared, traces: { enabled: true } };
    await assert.rejects(
      verifyEgressObservability({
        configuration: { name, account_id: account, observability: invalid },
        run,
        wrangler: "wrangler",
        fetch,
        env: {},
      }),
      /Egress observability declaration is invalid/u,
    );
    assert.equal(calls.length, 2);
  }
});

test("egress observability readback stays a no-op for names outside the three accepted egress Workers", async () => {
  for (const name of [
    "ohmyho-wfp-egress-v3-production",
    "ohmyho-wfp-egress-v2-poc-private-fullstack",
  ]) {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args].join(" "));
      throw new Error("no credential read");
    };
    const fetch = async (url) => {
      calls.push(url);
      throw new Error("no readback");
    };
    await verifyEgressObservability({
      configuration: { name },
      run,
      wrangler: "wrangler",
      fetch,
      env: {},
    });
    assert.deepEqual(calls, []);
  }
});

test("control API readback accepts only a live script whose invocation logs are off", async () => {
  const account = "00000000000000000000000000000001";
  const name = "ohmyho-control-api-production";
  const declared = {
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false },
  };
  const settings = (invocationLogs) => ({
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      redact_query_string: false,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        persist: true,
        invocation_logs: invocationLogs,
      },
      traces: { enabled: false, persist: true, head_sampling_rate: 1 },
    },
  });
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "auth" && args[1] === "token")
      return JSON.stringify({ type: "api_token", token: "control-api-fixture-token" });
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const readingLive = (invocationLogs) => async (url) => {
    calls.push(`GET ${url}`);
    return Response.json({ success: true, errors: [], result: settings(invocationLogs) });
  };
  await assert.rejects(
    verifyControlApiInvocationLogs({
      configuration: { name, account_id: account, observability: declared },
      run,
      wrangler: "wrangler",
      fetch: readingLive(true),
      env: {},
    }),
    /Control API invocation logs readback is missing, invalid or drifted/u,
  );
  await verifyControlApiInvocationLogs({
    configuration: { name, account_id: account, observability: declared },
    run,
    wrangler: "wrangler",
    fetch: readingLive(false),
    env: {},
  });
  assert.deepEqual(calls, [
    "wrangler auth token --json",
    `GET https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/script-settings`,
    "wrangler auth token --json",
    `GET https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/script-settings`,
  ]);
  // A declaration that enables invocation logs is never deployed, whatever the live script says.
  await assert.rejects(
    verifyControlApiInvocationLogs({
      configuration: {
        name,
        account_id: account,
        observability: { ...declared, logs: { ...declared.logs, invocation_logs: true } },
      },
      run,
      wrangler: "wrangler",
      fetch: readingLive(false),
      env: {},
    }),
    /Control API observability declaration keeps invocation logs/u,
  );
  // Other Workers are not Control API profiles and read nothing.
  const before = calls.length;
  await verifyControlApiInvocationLogs({
    configuration: { name: "ohmyho-webhook-ingress-production", observability: declared },
    run,
    wrangler: "wrangler",
    fetch: readingLive(true),
    env: {},
  });
  assert.equal(calls.length, before);
});

test("container release rendering preserves absolute Dockerfile and build context paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-platform-release-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "wrangler.jsonc");
  await mkdir(join(root, "sandbox"));
  await writeFile(join(root, "sandbox", "Dockerfile"), "FROM scratch\n");
  await writeFile(join(root, "worker.mjs"), "export default {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ohmyhost/example" }));
  await writeFile(
    sourcePath,
    JSON.stringify({
      name: "ohmyho-example-poc-private-fullstack",
      main: "worker.mjs",
      workers_dev: false,
      preview_urls: false,
      containers: [
        { class_name: "BuildSandbox", image: "./sandbox/Dockerfile", image_build_context: "." },
        { class_name: "Pinned", image: "registry.cloudflare.com/account/image@sha256:abc" },
      ],
    }),
  );

  const rendered = await renderWranglerConfiguration({
    expectedName: "ohmyho-example-poc-private-fullstack",
    outputPath: join(root, "output", "wrangler.json"),
    sourcePath,
  });
  assert.deepEqual(rendered.containers, [
    {
      class_name: "BuildSandbox",
      image: join(root, "sandbox", "Dockerfile"),
      image_build_context: root,
    },
    { class_name: "Pinned", image: "registry.cloudflare.com/account/image@sha256:abc" },
  ]);
});

test("public client release refuses missing, changed and foreign-source assets before publication", async (context) => {
  const assetsDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-release-assets-test-"));
  context.after(() => rm(assetsDirectory, { recursive: true, force: true }));
  const version = "0.1.1";
  const input = { assetsDirectory, version, sourceSha: SHA };
  await assert.rejects(verifyPublicClientRelease(input));
  const directory = join(assetsDirectory, "releases", version);
  await mkdir(directory, { recursive: true });
  const artifacts = [];
  for (const name of [
    "product-cli",
    "mcp",
    "sdk-ts",
    "customer-runtime",
    "customer-auth-better-auth",
  ]) {
    const bytes = `isolated test fixture for ${name}`;
    const file = `ohmyhost-${name}-${version}.tgz`;
    await writeFile(join(directory, file), bytes);
    artifacts.push({
      name: `@ohmyhost/${name}`,
      version,
      file,
      url: `https://ohmyho.st/releases/${version}/${file}`,
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const bytes = "{}";
  const contract = {
    file: "openapi.json",
    url: `https://ohmyho.st/releases/${version}/openapi.json`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(join(directory, "openapi.json"), bytes);
  const manifest = { version, source_commit: SHA, packages: artifacts, contract };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(directory, "SHA256SUMS"),
    [...artifacts, contract].map((item) => `${item.sha256}  ${item.file}`).join("\n") + "\n",
  );
  await verifyPublicClientRelease(input);
  await assert.rejects(
    verifyPublicClientRelease({ ...input, sourceSha: "b".repeat(40) }),
    /release identity/u,
  );
  await verifyPublicClientRelease({
    ...input,
    sourceSha: "b".repeat(40),
    publishedManifest: manifest,
  });
  await assert.rejects(
    verifyPublicClientRelease({
      ...input,
      sourceSha: "b".repeat(40),
      publishedManifest: { ...manifest, source_commit: "c".repeat(40) },
    }),
    /release identity/u,
  );
  const npmDirectory = join(assetsDirectory, "npm");
  await mkdir(npmDirectory);
  const names = ["cli", "mcp", "sdk", "runtime", "auth"];
  const archives = await Promise.all(
    names.map(async (name, index) => {
      const archive = Buffer.from(`published registry fixture ${name}`);
      const file = `amerged-ohmyhost-${name}-${version}.tgz`;
      await writeFile(join(npmDirectory, file), archive);
      return {
        name: `@amerged/ohmyhost-${name}`,
        version,
        file,
        sha256: createHash("sha256").update(archive).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
        sourceArchiveSha256: artifacts[index].sha256,
      };
    }),
  );
  const npmManifest = { sourceCommit: SHA, version, packages: archives };
  const npmManifestPath = join(npmDirectory, "manifest.json");
  const seal = async (value = npmManifest) => {
    const text = JSON.stringify(value);
    await writeFile(npmManifestPath, text);
    return createHash("sha256").update(text).digest("hex");
  };
  const clientPrerequisite = {
    id: "published-clients",
    kind: "clients",
    action: "verify",
    dependsOn: [],
    directory: npmDirectory,
    version,
    sourceCommit: SHA,
    manifestSha256: await seal(),
  };
  const commands = [];
  const downloads = [];
  const run = async (command, args) => {
    commands.push([command, ...args]);
    if (command === "git" && args[0] === "merge-base") return "";
    if (command === "git" && args[0] === "show")
      return args[1].endsWith("openapi.json") ? bytes : JSON.stringify({ version });
    if (command === "gh" && args[0] === "run" && args[1] === "list")
      return JSON.stringify([
        { databaseId: 7, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    if (command === "gh" && args[0] === "run" && args[1] === "view")
      return JSON.stringify(previousCi());
    throw new Error("Unexpected recovery command");
  };
  const fetch = async (url) => {
    downloads.push(url);
    const archive = archives.find((record) => url.endsWith(`/${record.file}`));
    if (archive) return new Response(await readFile(join(npmDirectory, archive.file)));
    const record = archives.find((item) => url.includes(item.name.replace("/", "%2F")));
    return new Response(
      JSON.stringify({
        name: record.name,
        version,
        license: "Apache-2.0",
        dist: { integrity: record.integrity, tarball: `https://registry.npmjs.org/${record.file}` },
      }),
    );
  };
  const recovered = {
    ...input,
    sourceSha: "b".repeat(40),
    clientPrerequisite,
    repositoryRoot: assetsDirectory,
    run,
    fetch,
  };
  await verifyPublicClientRelease(recovered);
  assert.equal(downloads.length, 10);
  assert.ok(commands.some((entry) => entry.includes("--is-ancestor")));
  assert.ok(!commands.some((entry) => entry.includes("workflow")));
  for (const change of [
    { action: "publish" },
    { sourceCommit: undefined },
    { sourceCommit: null },
    { sourceCommit: "c".repeat(40) },
    { version: "0.1.2" },
  ])
    await assert.rejects(
      verifyPublicClientRelease({
        ...recovered,
        clientPrerequisite: { ...clientPrerequisite, ...change },
      }),
      /release identity/u,
    );
  await assert.rejects(
    verifyPublicClientRelease({
      ...recovered,
      run: async (command, args) => {
        if (args[0] === "merge-base") throw new Error("not ancestor");
        return run(command, args);
      },
    }),
    /not an ancestor/u,
  );
  await assert.rejects(
    verifyPublicClientRelease({
      ...recovered,
      run: async (command, args) => (command === "gh" ? "[]" : run(command, args)),
    }),
    /existing successful exact-commit CI/u,
  );
  for (const change of [
    { headSha: "c".repeat(40) },
    { status: "in_progress" },
    { jobs: previousCi().jobs.slice(0, -1) },
    {
      jobs: previousCi().jobs.map((job, index) =>
        index === 0 ? { ...job, conclusion: "skipped" } : job,
      ),
    },
  ])
    await assert.rejects(
      verifyPublicClientRelease({
        ...recovered,
        run: async (command, args) =>
          command === "gh" && args[1] === "view"
            ? JSON.stringify({ ...previousCi(), ...change })
            : run(command, args),
      }),
      /complete successful exact-commit CI/u,
    );
  await assert.rejects(
    verifyPublicClientRelease({
      ...recovered,
      run: async (command, args) =>
        args[1]?.endsWith("openapi.json") ? "foreign contract" : run(command, args),
    }),
    /contract differs/u,
  );
  await assert.rejects(
    verifyPublicClientRelease({
      ...recovered,
      fetch: async () => new Response("unpublished", { status: 404 }),
    }),
    /registry record is unavailable/u,
  );
  await assert.rejects(
    verifyPublicClientRelease({
      ...recovered,
      fetch: async (url) => (url.endsWith(".tgz") ? new Response("foreign archive") : fetch(url)),
    }),
    /registry archive bytes differ/u,
  );
  for (const sourceArchiveSha256 of [undefined, archives[1].sourceArchiveSha256]) {
    const changed = {
      ...npmManifest,
      packages: [{ ...archives[0], sourceArchiveSha256 }, ...archives.slice(1)],
    };
    await assert.rejects(
      verifyPublicClientRelease({
        ...recovered,
        clientPrerequisite: { ...clientPrerequisite, manifestSha256: await seal(changed) },
      }),
      /archive metadata|source archive/u,
    );
  }
  await seal();
  await writeFile(join(directory, artifacts[0].file), "changed");
  await assert.rejects(verifyPublicClientRelease(input), /asset integrity/u);
});

const OTHER_SHA = "b".repeat(40);
const CORE = "ohmyho-control-store-poc-private-fullstack";
const DEVELOPMENT_TWIN = "ohmyho-example-poc-private-fullstack";
const ACCOUNT = "00000000000000000000000000000001";
const LIVE_VERSION = "11111111-2222-4333-8444-555555555555";

async function creationFixture(context, { name, services = [], routes }) {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-creation-order-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "wrangler.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      name,
      main: "worker.mjs",
      workers_dev: false,
      preview_urls: false,
      vars: { RUNTIME_CONFIGURATION_STATE: "configured" },
      services,
      ...(routes === undefined ? {} : { routes }),
    }),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ohmyhost/example" }));
  await writeFile(
    join(root, "worker.mjs"),
    "export default { fetch() { return new Response('ok'); } };\n",
  );
  return { root, configPath };
}

/** A fake provider where `live` maps each Worker name to the commit it serves at 100%. */
function creationProvider(live, prefix = "origin/main") {
  const calls = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url) => {
    const path = new URL(url).pathname.replace(/^\/client\/v4/u, "");
    const match =
      /^\/accounts\/([a-f0-9]{32})\/workers\/scripts\/([^/]+)\/(deployments|versions\/[0-9a-f-]{36})$/u.exec(
        path,
      );
    calls.push(path);
    const name = match?.[2];
    if (match === null || !live.has(name) || match[1] !== ACCOUNT) return json({}, 404);
    if (match[3] === "deployments")
      return json({
        success: true,
        result: { deployments: [{ versions: [{ version_id: LIVE_VERSION, percentage: 100 }] }] },
      });
    return json({
      success: true,
      result: {
        id: LIVE_VERSION,
        annotations: {
          "workers/message": `${prefix} ${live.get(name)}; config ${"f".repeat(64)}`,
        },
      },
    });
  };
  return { calls, fetch };
}

/** Runs releaseWorker in a fake checkout; every Wrangler write is recorded and must be refused. */
function creationRun({ root, sha = SHA, deployFails = false }) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return `${root}\n`;
      if (key === "rev-parse --is-bare-repository") return "false\n";
      if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
      if (key === "status --porcelain=v1 --untracked-files=all") return "";
      if (key === "rev-parse HEAD" || key === "rev-parse refs/remotes/origin/main")
        return `${sha}\n`;
      if (key === "remote get-url --push origin" || key === "remote get-url origin")
        return "https://github.com/amerged-org/ohmyhost.git\n";
      if (key === "ls-remote --exit-code origin refs/heads/main")
        return `${sha}\trefs/heads/main\n`;
    }
    if (command === "gh")
      return JSON.stringify([
        { databaseId: 42, headSha: sha, status: "completed", conclusion: "success" },
      ]);
    if (command === "pnpm") return "built\n";
    if (command === "wrangler" && args[0] === "auth")
      return JSON.stringify({ type: "api_token", token: "fake-readback-token" });
    if (command === "wrangler" && args[0] === "versions" && args[1] === "list")
      throw new WorkerAbsentError({
        accountId: options.observeWorker.accountId,
        workerName: options.observeWorker.workerName,
      });
    if (command === "wrangler" && args[0] === "deploy" && deployFails)
      throw new Error("deploy reached");
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const writes = () =>
    calls.filter(
      ([command, ...args]) =>
        command === "wrangler" && (args.includes("deploy") || args.includes("upload")),
    );
  return { calls, run, writes };
}

test("a standalone creation waits until its Core and Development twin are live at this commit", async (context) => {
  const services = [{ binding: "AI_RUNTIME", service: CORE, entrypoint: "AiGatewayRuntime" }];
  for (const [name, live, pattern] of [
    [DEVELOPMENT_TWIN, new Map([[CORE, OTHER_SHA]]), /Control Core must be live/u],
    [DEVELOPMENT_TWIN, new Map(), /Control Core must be live/u],
    ["ohmyho-example-production", new Map(), /Development twin must be live/u],
    [
      "ohmyho-example-production",
      new Map([[DEVELOPMENT_TWIN, OTHER_SHA]]),
      /Development twin must be live/u,
    ],
  ]) {
    const fixture = await creationFixture(context, {
      name,
      services: name === DEVELOPMENT_TWIN ? services : [],
    });
    const provider = creationProvider(live);
    const fake = creationRun({ root: fixture.root });
    await assert.rejects(
      releaseWorker({
        configPath: fixture.configPath,
        cwd: fixture.root,
        run: fake.run,
        wrangler: "wrangler",
        fetch: provider.fetch,
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      }),
      pattern,
    );
    assert.deepEqual(fake.writes(), [], `${name} must refuse before any Wrangler write`);
  }

  // The same creation proceeds once the Core is live at this commit: the first write is the deploy.
  const fixture = await creationFixture(context, { name: DEVELOPMENT_TWIN, services });
  const provider = creationProvider(new Map([[CORE, SHA]]));
  const fake = creationRun({ root: fixture.root, deployFails: true });
  await assert.rejects(
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: fake.run,
      wrangler: "wrangler",
      fetch: provider.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    }),
    /deploy reached/u,
  );
  assert.equal(fake.writes().length, 1);
  assert.ok(provider.calls.some((path) => path.endsWith(`/workers/scripts/${CORE}/deployments`)));
  const branchProvider = creationProvider(new Map([[CORE, SHA]]), "source");
  const branchRelease = creationRun({ root: fixture.root, deployFails: true });
  await assert.rejects(
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: branchRelease.run,
      wrangler: "wrangler",
      fetch: branchProvider.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    }),
    /deploy reached/u,
  );
  assert.equal(branchRelease.writes().length, 1);
  const forged = creationProvider(new Map([[CORE, SHA]]), "unknown");
  const denied = creationRun({ root: fixture.root });
  await assert.rejects(
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: denied.run,
      wrangler: "wrangler",
      fetch: forged.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    }),
    /Control Core must be live/u,
  );
  assert.deepEqual(denied.writes(), []);
});

test("a production creation with its Development twin live at this commit reaches its deploy", async (context) => {
  const fixture = await creationFixture(context, { name: "ohmyho-example-production" });
  const provider = creationProvider(new Map([[DEVELOPMENT_TWIN, SHA]]));
  const fake = creationRun({ root: fixture.root, deployFails: true });
  await assert.rejects(
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: fake.run,
      wrangler: "wrangler",
      fetch: provider.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    }),
    /deploy reached/u,
  );
  assert.equal(fake.writes().length, 1);
});

test("Native regional creation requires the same-region Development twin at the exact commit", async (context) => {
  for (const region of ["us", "eu"]) {
    const name = `ohmyho-native-auth-production-${region}`;
    const twin = `ohmyho-native-auth-development-${region}`;
    const wrongTwin = `ohmyho-native-auth-development-${region === "us" ? "eu" : "us"}`;
    const fixture = await creationFixture(context, { name });
    for (const live of [new Map(), new Map([[wrongTwin, SHA]]), new Map([[twin, OTHER_SHA]])]) {
      const fake = creationRun({ root: fixture.root });
      const provider = creationProvider(live);
      await assert.rejects(
        releaseWorker({
          configPath: fixture.configPath,
          cwd: fixture.root,
          run: fake.run,
          wrangler: "wrangler",
          fetch: provider.fetch,
          env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
        }),
        /Development twin must be live/u,
      );
      assert.deepEqual(fake.writes(), []);
    }
    const fake = creationRun({ root: fixture.root, deployFails: true });
    const provider = creationProvider(new Map([[twin, SHA]]));
    await assert.rejects(
      releaseWorker({
        configPath: fixture.configPath,
        cwd: fixture.root,
        run: fake.run,
        wrangler: "wrangler",
        fetch: provider.fetch,
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      }),
      /deploy reached/u,
    );
    assert.equal(fake.writes().length, 1);
    assert.ok(provider.calls.some((path) => path.endsWith(`/workers/scripts/${twin}/deployments`)));
  }
});

const CUSTOM_HOST = "ai.example.test";
const CUSTOM_ZONE = {
  id: "0123456789abcdef0123456789abcdef",
  name: "example.test",
  account: { id: ACCOUNT },
};

/** A fake provider for the custom-domain reads; each test mutates `state` between releases. */
function domainProvider(state) {
  const calls = [];
  const page = (rows) =>
    new Response(
      JSON.stringify({
        success: true,
        result: rows,
        result_info: {
          page: 1,
          per_page: 100,
          count: rows.length,
          total_count: rows.length,
          total_pages: rows.length === 0 ? 0 : 1,
        },
      }),
    );
  const fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/client\/v4/u, "");
    calls.push(path);
    if (path === `/accounts/${ACCOUNT}/workers/domains`)
      return page(
        state.domains.filter(({ hostname }) => hostname === searchParams.get("hostname")),
      );
    if (path === "/zones" && searchParams.get("account.id") === ACCOUNT) return page(state.zones);
    const records = /^\/zones\/([a-f0-9]{32})\/dns_records$/u.exec(path);
    if (records !== null)
      return page(state.records.filter(({ name }) => name === searchParams.get("name")));
    return new Response("{}", { status: 404 });
  };
  return { calls, fetch };
}

test("a creation that declares a custom domain refuses an occupied host, record or unknown zone before any write", async (context) => {
  const routes = [{ pattern: CUSTOM_HOST, custom_domain: true }];
  const occupied = {
    id: "a".repeat(32),
    hostname: CUSTOM_HOST,
    service: "other-worker",
    environment: "production",
  };
  const record = { id: "b".repeat(32), name: CUSTOM_HOST, type: "A" };
  for (const [state, pattern] of [
    [
      { domains: [occupied], zones: [CUSTOM_ZONE], records: [] },
      /Custom domain hostname is already in use/u,
    ],
    [
      { domains: [], zones: [CUSTOM_ZONE], records: [record] },
      /Custom domain hostname is already in use/u,
    ],
    [{ domains: [], zones: [], records: [] }, /Custom domain zone is not in this account/u],
  ]) {
    const fixture = await creationFixture(context, { name: DEVELOPMENT_TWIN, routes });
    const provider = domainProvider(state);
    const fake = creationRun({ root: fixture.root });
    await assert.rejects(
      releaseWorker({
        configPath: fixture.configPath,
        cwd: fixture.root,
        run: fake.run,
        wrangler: "wrangler",
        fetch: provider.fetch,
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      }),
      pattern,
    );
    assert.deepEqual(fake.writes(), [], "an occupied custom domain must refuse before any write");
  }

  const nonCustom = await creationFixture(context, {
    name: DEVELOPMENT_TWIN,
    routes: [{ pattern: "example.test/*" }],
  });
  const fake = creationRun({ root: nonCustom.root });
  await assert.rejects(
    releaseWorker({
      configPath: nonCustom.configPath,
      cwd: nonCustom.root,
      run: fake.run,
      wrangler: "wrangler",
      fetch: domainProvider({ domains: [], zones: [CUSTOM_ZONE], records: [] }).fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    }),
    /only custom domain routes/u,
  );
  assert.deepEqual(fake.writes(), []);

  // A free host in a resolvable zone reaches the deploy.
  const fixture = await creationFixture(context, { name: DEVELOPMENT_TWIN, routes });
  const provider = domainProvider({ domains: [], zones: [CUSTOM_ZONE], records: [] });
  const clean = creationRun({ root: fixture.root, deployFails: true });
  await assert.rejects(
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: clean.run,
      wrangler: "wrangler",
      fetch: provider.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    }),
    /deploy reached/u,
  );
  assert.equal(clean.writes().length, 1);
  assert.ok(provider.calls.includes(`/zones/${CUSTOM_ZONE.id}/dns_records`));
});

/** A creation run whose deploy records one live version and, when `domains.attach`, attaches the host. */
function statefulCreationRun({ root, domains }) {
  const base = creationRun({ root });
  const state = { version: undefined, deployed: false };
  const run = async (command, args, options) => {
    if (command === "wrangler" && args[0] === "deploy") {
      base.calls.push([command, ...args]);
      state.version = {
        id: LIVE_VERSION,
        annotations: {
          "workers/tag": args[args.indexOf("--tag") + 1],
          "workers/message": args[args.indexOf("--message") + 1],
        },
      };
      state.deployed = true;
      if (domains.attach)
        domains.domains = [
          {
            id: "c".repeat(32),
            hostname: CUSTOM_HOST,
            service: DEVELOPMENT_TWIN,
            environment: "production",
          },
        ];
      return "created and deployed\n";
    }
    if (command === "wrangler" && args[0] === "versions" && args[1] === "list") {
      base.calls.push([command, ...args]);
      if (state.version === undefined)
        throw new WorkerAbsentError({
          accountId: options.observeWorker.accountId,
          workerName: options.observeWorker.workerName,
        });
      return JSON.stringify([state.version]);
    }
    if (command === "wrangler" && args[0] === "versions" && args[1] === "view") {
      base.calls.push([command, ...args]);
      return JSON.stringify({ ...state.version, resources: { bindings: [] } });
    }
    if (command === "wrangler" && args[0] === "deployments") {
      base.calls.push([command, ...args]);
      return JSON.stringify({
        versions: state.deployed ? [{ version_id: LIVE_VERSION, percentage: 100 }] : [],
      });
    }
    return base.run(command, args, options);
  };
  return { run, writes: base.writes };
}

test("a replay refuses a Worker whose declared custom domain is not attached to it", async (context) => {
  const fixture = await creationFixture(context, {
    name: DEVELOPMENT_TWIN,
    routes: [{ pattern: CUSTOM_HOST, custom_domain: true }],
  });
  const domains = { domains: [], zones: [CUSTOM_ZONE], records: [], attach: true };
  const provider = domainProvider(domains);
  const fake = statefulCreationRun({ root: fixture.root, domains });
  const release = () =>
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: fake.run,
      wrangler: "wrangler",
      fetch: provider.fetch,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    });
  assert.equal((await release()).uploaded, true);
  assert.equal(fake.writes().length, 1);

  // Detached, the replay has nothing to resume: it must refuse and must not deploy.
  domains.domains = [];
  await assert.rejects(release(), /Custom domain is not attached to this Worker/u);
  assert.equal(fake.writes().length, 1, "a detached custom domain replay must not deploy");

  domains.attach = false;
  domains.domains = [
    {
      id: "c".repeat(32),
      hostname: CUSTOM_HOST,
      service: DEVELOPMENT_TWIN,
      environment: "production",
    },
  ];
  assert.equal((await release()).uploaded, false);
});

test("a secrets file inside the checkout or outside a private directory is refused before any Wrangler write", async (context) => {
  const fixture = await creationFixture(context, { name: DEVELOPMENT_TWIN });
  const inside = join(fixture.root, "secrets.json");
  await writeFile(inside, JSON.stringify({ EXAMPLE_SECRET: "private-test-value" }), {
    mode: 0o600,
  });
  const fake = creationRun({ root: fixture.root });
  await assert.rejects(
    releaseWorker({
      configPath: fixture.configPath,
      cwd: fixture.root,
      run: fake.run,
      wrangler: "wrangler",
      secretsFile: inside,
    }),
    /outside the checkout/u,
  );
  assert.deepEqual(fake.writes(), []);

  const outside = await mkdtemp(join(tmpdir(), "ohmyhost-release-secret-mode-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const file = join(outside, "secrets.json");
  await writeFile(file, JSON.stringify({ EXAMPLE_SECRET: "private-test-value" }), { mode: 0o600 });
  const repositoryRoot = fixture.root;
  assert.equal(
    (await validateReleaseSecretsFile({ path: file, repositoryRoot })).names[0],
    "EXAMPLE_SECRET",
  );
  await chmod(outside, 0o755);
  await assert.rejects(
    validateReleaseSecretsFile({ path: file, repositoryRoot }),
    /private directory outside the checkout/u,
  );
});

test("Native atomic mode needs a rehearsed Core-first train and exact version binding", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "native-atomic-release-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "wrangler.json");
  let calls = 0;
  const run = async () => {
    calls++;
    throw new Error("repository inspection reached");
  };
  const fetch = async () => {
    calls++;
    throw new Error("provider called");
  };
  const configuration = {
    name: "ohmyho-native-auth-development-us",
    vars: { NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE: "v1" },
  };
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(
    releaseWorker({ configPath, run, fetch }),
    /requires a validated Core-first train/u,
  );
  assert.equal(calls, 0);
  configuration.vars.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE = "invalid";
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(releaseWorker({ configPath, run, fetch }), /mode is invalid/u);
  assert.equal(calls, 0);
  delete configuration.vars.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE;
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(releaseWorker({ configPath, run, fetch }), /repository inspection reached/u);
  assert.equal(calls, 1);
  const expected = { vars: { NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE: "v1" } };
  assert.doesNotThrow(() =>
    verifyDeclaredVersionBindings(expected, [
      { name: "NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE", type: "plain_text", text: "v1" },
    ]),
  );
  assert.throws(() => verifyDeclaredVersionBindings(expected, []));
  assert.throws(() =>
    verifyDeclaredVersionBindings(expected, [
      { name: "NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE", type: "plain_text", text: "invalid" },
    ]),
  );
  const nativeConfig = { ...configuration, ...expected };
  const identity = workerReleaseIdentity({ sha: SHA, configuration: nativeConfig });
  const receipt = {
    deploymentVerified: true,
    versionId: "11111111-2222-4333-8444-555555555555",
    workerName: nativeConfig.name,
    sha: SHA,
    ...identity,
  };
  let liveBindings = [{ name: "NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE", type: "plain_text", text: "v1" }];
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      configuration: nativeConfig,
      repositoryRoot: "/unused-no-artifact-or-container",
      sourceSha: SHA,
      wrangler: "wrangler",
      run: async (_command, args) =>
        args[0] === "versions"
          ? JSON.stringify({
              id: receipt.versionId,
              annotations: { "workers/tag": identity.tag, "workers/message": identity.message },
              resources: { bindings: liveBindings },
            })
          : JSON.stringify({ versions: [{ version_id: receipt.versionId, percentage: 100 }] }),
    });
  assert.equal(await verify(), true);
  liveBindings = [];
  await assert.rejects(verify(), /binding/u);
  liveBindings = [
    { name: "NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE", type: "plain_text", text: "invalid" },
  ];
  await assert.rejects(verify(), /drifted/u);
});

test("atomic shared Gateway standalone refuses before provider I/O and its vars are verified", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-gateway-release-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "wrangler.json");
  let calls = 0;
  const run = async () => {
      calls++;
      throw Error("repository inspection reached");
    },
    fetch = async () => {
      calls++;
      throw Error("provider called");
    };
  const configuration = {
    name: "ohmyho-gateway-poc-private-fullstack",
    vars: {
      DEV_AUTH_ATOMIC_MODE: "v1",
      NATIVE_GATEWAY_LATENCY_PROFILE: "c5-development-v1",
    },
  };
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(
    releaseWorker({ configPath, run, fetch }),
    /requires a validated Core-first and Control-first/u,
  );
  assert.equal(calls, 0);
  configuration.vars.DEV_AUTH_ATOMIC_MODE = "bad";
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(releaseWorker({ configPath, run, fetch }), /mode is invalid/u);
  assert.equal(calls, 0);
  delete configuration.vars.DEV_AUTH_ATOMIC_MODE;
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(releaseWorker({ configPath, run, fetch }), /repository inspection reached/u);
  assert.equal(calls, 1);
  const serviceDeclaration = {
    services: [
      {
        binding: "DEV_ACCESS",
        service: "ohmyho-control-api-poc-private-fullstack",
        entrypoint: "DevAccessService",
      },
    ],
  };
  const serviceBinding = {
    name: "DEV_ACCESS",
    type: "service",
    service: "ohmyho-control-api-poc-private-fullstack",
    entrypoint: "DevAccessService",
  };
  assert.doesNotThrow(() => verifyDeclaredVersionBindings(serviceDeclaration, [serviceBinding]));
  assert.doesNotThrow(() =>
    verifyDeclaredVersionBindings(serviceDeclaration, [
      { ...serviceBinding, environment: "production" },
    ]),
  );
  assert.throws(() =>
    verifyDeclaredVersionBindings(serviceDeclaration, [
      { ...serviceBinding, environment: "staging" },
    ]),
  );
  const vars = {
    DEV_AUTH_ATOMIC_MODE: "v1",
    NATIVE_GATEWAY_LATENCY_PROFILE: "c5-development-v1",
  };
  const bindings = Object.entries(vars).map(([name, text]) => ({ name, type: "plain_text", text }));
  assert.doesNotThrow(() => verifyDeclaredVersionBindings({ vars }, bindings));
  assert.throws(() => verifyDeclaredVersionBindings({ vars }, bindings.slice(1)));
  assert.throws(() =>
    verifyDeclaredVersionBindings(
      { vars },
      bindings.map((x) => (x.name === "DEV_AUTH_ATOMIC_MODE" ? { ...x, text: "bad" } : x)),
    ),
  );
  const replayConfig = { name: configuration.name, vars };
  const identity = workerReleaseIdentity({ sha: SHA, configuration: replayConfig });
  const receipt = {
    deploymentVerified: true,
    versionId: "11111111-2222-4333-8444-555555555555",
    workerName: replayConfig.name,
    sha: SHA,
    ...identity,
  };
  let liveBindings = bindings;
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      configuration: replayConfig,
      repositoryRoot: "/unused-no-artifact-or-container",
      sourceSha: SHA,
      wrangler: "wrangler",
      run: async (_command, args) =>
        args[0] === "versions"
          ? JSON.stringify({
              id: receipt.versionId,
              annotations: { "workers/tag": identity.tag, "workers/message": identity.message },
              resources: { bindings: liveBindings },
            })
          : JSON.stringify({ versions: [{ version_id: receipt.versionId, percentage: 100 }] }),
    });
  assert.equal(await verify(), true);
  liveBindings = bindings.filter((x) => x.name !== "DEV_AUTH_ATOMIC_MODE");
  await assert.rejects(verify(), /binding/u);
  liveBindings = bindings.map((x) =>
    x.name === "DEV_AUTH_ATOMIC_MODE" ? { ...x, text: "bad" } : x,
  );
  await assert.rejects(verify(), /drifted/u);
});

test("the public client release constant is derived from the product CLI version, never hand-typed", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const entry = await readFile(join(root, "apps/public-site/src/customer-entry.ts"), "utf8");
  assert.doesNotMatch(entry, /CLIENT_RELEASE = "/u);
  const derived = await readFile(
    join(root, "apps/public-site/src/generated-client-release.ts"),
    "utf8",
  );
  const version = derived.match(/CLIENT_RELEASE = "([^"]+)"/u)?.[1];
  const cli = JSON.parse(await readFile(join(root, "apps/product-cli/package.json"), "utf8"));
  assert.equal(version, cli.version);
  for (const directory of [
    "apps/mcp",
    "packages/sdk-ts",
    "packages/customer-runtime",
    "packages/customer-auth-better-auth",
  ])
    assert.equal(
      JSON.parse(await readFile(join(root, directory, "package.json"), "utf8")).version,
      version,
      directory,
    );
});
