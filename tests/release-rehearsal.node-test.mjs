/* global Response, TextEncoder, process */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  rehearseWorker,
  releaseHash,
  validateWorkerRehearsal,
  readPrivateReleaseJson,
} from "../scripts/release-rehearsal-artifacts.mjs";
import {
  inspectRehearsalRepository,
  parseRehearsalArguments,
  rehearseRelease,
} from "../scripts/release-rehearse.mjs";
import { parseTrainArguments, trainFailureMessage } from "../scripts/release-train.mjs";
import {
  releaseWorker,
  verifyWorkerReleaseReceipt,
  workerReleaseIdentity,
} from "../scripts/platform-release.mjs";
import { imageRecipe } from "../scripts/platform-container-release.mjs";
import {
  executePrerequisite,
  executeReleaseTrain,
  observeReleaseIngress,
  runReleaseCommand,
  prepareReleaseTrain,
  releaseApprovalDigest,
  manifestDigest,
} from "../scripts/release-pipeline.mjs";
import {
  observePolicyCohort,
  POLICY_SOURCES,
  PolicyCohortError,
  requirePolicyCohort,
} from "../scripts/release-policy-cohort.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);
const ACCOUNT = "b".repeat(32);
const NAME = "ohmyho-example-poc-private-fullstack";
const VERSION = "11111111-2222-4333-8444-555555555555";

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "omh-rehearsal-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repositoryRoot = join(directory, "repo");
  const artifactsDirectory = join(directory, "artifacts");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(artifactsDirectory, { mode: 0o700 });
  const config = {
    name: NAME,
    account_id: ACCOUNT,
    main: "worker.mjs",
    workers_dev: false,
    preview_urls: false,
  };
  await writeFile(join(repositoryRoot, "worker.mjs"), "export default {};\n");
  await writeFile(
    join(repositoryRoot, "package.json"),
    JSON.stringify({ name: "@ohmyhost/example" }),
  );
  const expectedBundle = { value: "export default {}; // actual immutable rehearsal output\n" };
  const configPath = join(repositoryRoot, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify(config));
  const step = {
    id: "example",
    kind: "worker",
    config: "wrangler.jsonc",
    workerName: NAME,
    configSha256: releaseHash(await readFile(configPath)),
    dependsOn: [],
  };
  const calls = [];
  let version = null;
  let deployed = false;
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === "git") {
      if (args.join(" ") === "rev-parse --show-toplevel") return repositoryRoot;
      if (args.join(" ") === "rev-parse --is-bare-repository") return "false";
      if (args.join(" ") === "symbolic-ref --quiet HEAD") return "refs/heads/main";
      if (args[0] === "status") return "";
      if (args[0] === "remote") return "https://github.com/amerged-org/ohmyhost.git";
      if (args[0] === "ls-remote") return `${SHA}\trefs/heads/main`;
      if (args[0] === "rev-parse") return SHA;
    }
    if (command === "pnpm") return "built";
    if (command === "gh")
      return JSON.stringify([
        { databaseId: 42, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    if (command === "wrangler" && args.includes("--dry-run")) {
      assert.equal(options.localOnly, true);
      const rendered = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      assert.equal(rendered.containers, undefined);
      assert.equal(rendered.build, undefined);
      const output = args[args.indexOf("--outdir") + 1];
      await mkdir(output, { mode: 0o700, recursive: true });
      const entry = join(output, "worker.js");
      await writeFile(entry, "export default {}; // actual immutable rehearsal output\n");
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({ outputs: { [entry]: { entryPoint: rendered.main } } }),
      );
      return "dry run";
    }
    if (args[0] === "versions" && args[1] === "list")
      return JSON.stringify(version === null ? [] : [version]);
    if (args[0] === "versions" && args[1] === "upload") {
      const rendered = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      assert.equal(rendered.no_bundle, true);
      assert.equal(rendered.build, undefined);
      assert.equal(rendered.main, join(artifactsDirectory, "example/bundle/worker.js"));
      assert.equal(await readFile(rendered.main, "utf8"), expectedBundle.value);
      version = {
        id: VERSION,
        annotations: {
          "workers/tag": args[args.indexOf("--tag") + 1],
          "workers/message": args[args.indexOf("--message") + 1],
        },
        resources: {
          bindings: [
            ...(rendered.artifacts ?? []).map(({ binding, namespace }) => ({
              name: binding,
              type: "artifacts",
              namespace,
            })),
            ...(rendered.services ?? []).map(({ binding, ...service }) => ({
              name: binding,
              type: "service",
              ...service,
            })),
          ],
        },
      };
      return "uploaded exact rehearsal";
    }
    if (args[0] === "versions" && args[1] === "view") return JSON.stringify(version);
    if (args[0] === "versions" && args[1] === "deploy") {
      deployed = true;
      return "deployed";
    }
    if (args[0] === "deployments")
      return JSON.stringify({
        versions: deployed ? [{ version_id: VERSION, percentage: 100 }] : [],
      });
    if (args[0] === "auth" && args[1] === "token")
      return JSON.stringify({ type: "oauth", token: "private-fixture-token" });
    throw new Error(`Unexpected ${command} ${args.join(" ")}`);
  };
  const manifest = {
    schemaVersion: 1,
    sourceCommit: SHA,
    environment: "development",
    accountId: ACCOUNT,
    rehearsal: join(directory, "rehearsal.json"),
    steps: [step],
  };
  return {
    directory,
    repositoryRoot,
    artifactsDirectory,
    step,
    run,
    calls,
    manifest,
    configPath,
    config,
    expectedBundle,
  };
}

test("the real rehearsal orchestration creates a durable bundle with no CI/provider commands and train uploads those bytes without rebuilding", async (context) => {
  const f = await fixture(context);
  f.config.artifacts = [
    { binding: "ARTIFACTS_US", namespace: "ohmyhost-development-us" },
    { binding: "ARTIFACTS_EU", namespace: "ohmyhost-development-eu" },
  ];
  await writeFile(f.configPath, JSON.stringify(f.config));
  f.step.configSha256 = releaseHash(await readFile(f.configPath));
  const result = await rehearseRelease({
    manifest: f.manifest,
    outputPath: f.manifest.rehearsal,
    artifactsDirectory: f.artifactsDirectory,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
  });
  assert.equal(result.providerMutations, 0);
  assert.ok(
    f.calls.every(
      ([command, ...args]) =>
        command !== "gh" &&
        !args.includes("auth") &&
        !args.includes("push") &&
        !args.includes("ls-remote"),
    ),
  );
  assert.equal(f.calls.filter(([command]) => command === "pnpm").length, 1);
  const prepared = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  await rehearseRelease({
    manifest: f.manifest,
    outputPath: f.manifest.rehearsal,
    artifactsDirectory: f.artifactsDirectory,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
  });
  assert.equal(
    f.calls.filter(([command]) => command === "pnpm").length,
    1,
    "completed rehearsal is reused",
  );
  const receipt = await releaseWorker({
    configPath: f.configPath,
    expectedName: NAME,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
    env: {},
    rehearsal: prepared.workers.example.proof,
  });
  assert.equal(
    f.calls.filter(([command]) => command === "pnpm").length,
    1,
    "release consumes the prebuilt bundle",
  );
  await verifyWorkerReleaseReceipt({
    receipt,
    configuration: prepared.workers.example.configuration,
    configPath: f.configPath,
    repositoryRoot: f.repositoryRoot,
    sourceSha: SHA,
    rehearsal: prepared.workers.example.proof,
    run: f.run,
    wrangler: "wrangler",
    env: {},
  });
  assert.equal(f.calls.filter(([, arg, sub]) => arg === "versions" && sub === "deploy").length, 1);
  // Wrangler 4.145's actual upload/download protocol uses type=artifacts and namespace.
  // A valid tag and 100% deployment do not prove that either regional Git binding is correct.
  for (const mutate of ["foreign-namespace", "missing", "duplicate", "wrong-type"]) {
    await assert.rejects(
      verifyWorkerReleaseReceipt({
        receipt,
        configuration: prepared.workers.example.configuration,
        configPath: f.configPath,
        repositoryRoot: f.repositoryRoot,
        sourceSha: SHA,
        rehearsal: prepared.workers.example.proof,
        run: async (command, args, options) => {
          const output = await f.run(command, args, options);
          if (args[0] !== "versions" || args[1] !== "view") return output;
          const value = JSON.parse(output);
          const bindings = value.resources.bindings;
          if (mutate === "foreign-namespace") bindings[1].namespace = "ohmyhost-production-eu";
          if (mutate === "missing") bindings.pop();
          if (mutate === "duplicate") bindings.push({ ...bindings[0] });
          if (mutate === "wrong-type") bindings[0].type = "plain_text";
          return JSON.stringify(value);
        },
        wrangler: "wrangler",
        env: {},
      }),
      /binding.*(?:missing|ambiguous|drifted)/u,
    );
  }
  assert.equal(f.calls.filter(([, arg, sub]) => arg === "versions" && sub === "deploy").length, 1);
  await assert.rejects(
    verifyWorkerReleaseReceipt({
      receipt: { ...receipt, tag: "tampered" },
      configuration: prepared.workers.example.configuration,
      configPath: f.configPath,
      repositoryRoot: f.repositoryRoot,
      sourceSha: SHA,
      rehearsal: prepared.workers.example.proof,
      run: f.run,
      wrangler: "wrangler",
      env: {},
    }),
    /source and configuration/u,
  );
  const proof = prepared.workers.example.proof;
  await writeFile(join(proof.directory, "bundle/worker.js"), "tampered\n");
  const previousUploads = f.calls.filter(
    ([, arg, sub]) => arg === "versions" && sub === "upload",
  ).length;
  await assert.rejects(
    releaseWorker({
      configPath: f.configPath,
      cwd: f.repositoryRoot,
      run: f.run,
      wrangler: "wrangler",
      env: {},
      rehearsal: proof,
    }),
    /bytes changed/u,
  );
  assert.equal(
    f.calls.filter(([, arg, sub]) => arg === "versions" && sub === "upload").length,
    previousUploads,
  );
});

test("service caller props are read from the exact version before activation and on completed replay", async (context) => {
  const f = await fixture(context);
  const props = {
    caller: "wfp-egress-policy",
    scope: { permissions: ["read", "write"], project: "one" },
  };
  f.config.services = [
    { binding: "GATEWAY", service: "private-gateway", entrypoint: "Gateway", props },
  ];
  await writeFile(f.configPath, JSON.stringify(f.config));
  f.step.configSha256 = releaseHash(await readFile(f.configPath));
  await rehearseRelease({
    manifest: f.manifest,
    outputPath: f.manifest.rehearsal,
    artifactsDirectory: f.artifactsDirectory,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
  });
  const prepared = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  let mutation;
  const run = async (command, args, options) => {
    const output = await f.run(command, args, options);
    if (args[0] !== "versions" || args[1] !== "view") return output;
    const version = JSON.parse(output);
    mutation?.(version.resources.bindings);
    return JSON.stringify(version);
  };
  const release = () =>
    releaseWorker({
      configPath: f.configPath,
      cwd: f.repositoryRoot,
      run,
      wrangler: "wrangler",
      env: {},
      rehearsal: prepared.workers.example.proof,
    });
  const mutations = [
    (bindings) => {
      delete bindings[0].props;
    },
    (bindings) => {
      bindings[0].props.caller = "another-caller";
    },
    (bindings) => {
      bindings[0].props.scope.project = "another-project";
    },
    (bindings) => {
      bindings[0].props.scope.permissions.reverse();
    },
    (bindings) => {
      bindings[0].props.extra = true;
    },
    (bindings) => {
      bindings[0].props = JSON.stringify(props);
    },
    (bindings) => {
      bindings.push({ ...bindings[0], type: "json" });
    },
  ];
  for (mutation of mutations) await assert.rejects(release(), /binding.*(?:drifted|ambiguous)/u);
  assert.equal(
    f.calls.filter(([, action, sub]) => action === "versions" && sub === "deploy").length,
    0,
  );
  // JSON object order has no authority; nested values and array order do.
  mutation = (bindings) => {
    bindings[0].props = {
      scope: { project: "one", permissions: ["read", "write"] },
      caller: "wfp-egress-policy",
    };
  };
  const receipt = await release();
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      configuration: prepared.workers.example.configuration,
      configPath: f.configPath,
      repositoryRoot: f.repositoryRoot,
      sourceSha: SHA,
      rehearsal: prepared.workers.example.proof,
      run,
      wrangler: "wrangler",
      env: {},
    });
  await verify();
  for (mutation of mutations) await assert.rejects(verify(), /binding.*(?:drifted|ambiguous)/u);
  assert.equal(
    f.calls.filter(([, action, sub]) => action === "versions" && sub === "upload").length,
    1,
  );
  assert.equal(
    f.calls.filter(([, action, sub]) => action === "versions" && sub === "deploy").length,
    1,
  );
});

test("Egress train completion and completed resume require live native script observability settings", async (context) => {
  const f = await fixture(context);
  const name = "ohmyho-wfp-egress-poc-private-fullstack";
  f.config.name = name;
  f.step.workerName = name;
  f.config.observability = {
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false },
    traces: { enabled: false },
  };
  // Actual Cloudflare script-settings response, including explicit provider defaults.
  const native = {
    ...f.config.observability,
    redact_query_string: false,
    traces: { enabled: false, persist: true, head_sampling_rate: 1 },
  };
  await writeFile(f.configPath, JSON.stringify(f.config));
  f.step.configSha256 = releaseHash(await readFile(f.configPath));
  await rehearseRelease({
    manifest: f.manifest,
    outputPath: f.manifest.rehearsal,
    artifactsDirectory: f.artifactsDirectory,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
  });
  const prepared = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  const requests = [];
  let readback;
  let denyCredential = false;
  const run = async (command, args, options) => {
    if (denyCredential && args[0] === "auth")
      throw new Error("credential output must remain private");
    return f.run(command, args, options);
  };
  const fetch = async (url, init) => {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${name}/script-settings`,
    );
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, "Bearer private-fixture-token");
    requests.push(url);
    return readback();
  };
  const options = {
    manifest: f.manifest,
    environment: "development",
    statePath: join(f.directory, "egress-state.json"),
    cwd: f.repositoryRoot,
    run,
    wrangler: "wrangler",
    env: {},
    fetch,
    approval: releaseApprovalDigest({
      manifest: f.manifest,
      preparationSha256: prepared.fingerprint,
    }),
    observeIngress: async () => ({
      domains: [],
      routes: [],
      workers: [
        { workerName: name, subdomain: { enabled: false, previews_enabled: false }, crons: [] },
      ],
    }),
    observePolicy: async () => ({
      policySha256: "9".repeat(64),
      consumers: [
        {
          environment: "development",
          name: "ohmyho-source-fetcher-poc-private-fullstack",
          workerName: "ohmyho-source-fetcher-poc-private-fullstack",
          config: "apps/source-fetcher/wrangler.development.jsonc",
          target: "9".repeat(64),
          live: "9".repeat(64),
        },
      ],
    }),
  };
  const response = (observability) =>
    Response.json({ success: true, errors: [], result: { observability } });
  const failures = [
    () => response(undefined),
    () => response(null),
    () => response([]),
    () => response({ ...native, logs: { ...native.logs, persist: false } }),
    () => response({ ...native, logs: { ...native.logs, invocation_logs: true } }),
    () => response({ ...native, logs: { ...native.logs, invocation_logs: "false" } }),
    () => response({ ...native, traces: { ...native.traces, enabled: true } }),
    () => response({ ...native, head_sampling_rate: 0.1 }),
    () => response({ ...native, traces: { enabled: false } }),
    () => response({ ...native, unexpected: true }),
    () => new Response("denied", { status: 403 }),
    () => new Response("malformed", { status: 200 }),
    () => {
      throw new Error("network output must remain private");
    },
  ];
  for (readback of failures)
    await assert.rejects(executeReleaseTrain(options), /incomplete; resume its original state/u);
  assert.equal(
    JSON.parse(await readFile(options.statePath, "utf8")).steps.example.status,
    "running",
  );
  readback = () => response(native);
  await executeReleaseTrain(options);
  const deployedCalls = f.calls.filter(
    ([, action, sub]) => action === "versions" && ["upload", "deploy"].includes(sub),
  ).length;
  for (readback of failures) await assert.rejects(executeReleaseTrain(options), /observability/u);
  denyCredential = true;
  await assert.rejects(executeReleaseTrain(options), /credential is unavailable/u);
  denyCredential = false;
  readback = () => response(native);
  await executeReleaseTrain(options);
  assert.ok(requests.length >= failures.length * 2 + 2);
  assert.equal(
    f.calls.filter(([, action, sub]) => action === "versions" && ["upload", "deploy"].includes(sub))
      .length,
    deployedCalls,
  );
});

test("rehearsal rejects invalid config/source, secret permissions, symlink artifacts and changed recipe metadata", async (context) => {
  const f = await fixture(context);
  await assert.rejects(
    rehearseRelease({
      manifest: { ...f.manifest, sourceCommit: "b".repeat(40) },
      outputPath: f.manifest.rehearsal,
      artifactsDirectory: f.artifactsDirectory,
      cwd: f.repositoryRoot,
      run: f.run,
    }),
    /source/u,
  );
  await assert.rejects(
    rehearseWorker({
      step: { ...f.step, configSha256: "f".repeat(64) },
      repositoryRoot: f.repositoryRoot,
      sha: SHA,
      directory: join(f.artifactsDirectory, "bad"),
      run: f.run,
    }),
    /digest/u,
  );
  const secretsFile = join(f.directory, "secrets.json");
  await writeFile(secretsFile, JSON.stringify({ PRIVATE_VALUE: "secret-never-in-proof" }), {
    mode: 0o644,
  });
  await assert.rejects(
    rehearseWorker({
      step: { ...f.step, secretsFile },
      repositoryRoot: f.repositoryRoot,
      sha: SHA,
      directory: join(f.artifactsDirectory, "example"),
      run: f.run,
    }),
    /permissions/u,
  );
  await chmod(secretsFile, 0o600);
  const proof = await rehearseWorker({
    step: { ...f.step, secretsFile },
    repositoryRoot: f.repositoryRoot,
    sha: SHA,
    directory: join(f.artifactsDirectory, "example"),
    run: f.run,
    wrangler: "wrangler",
  });
  assert.ok(!JSON.stringify(proof).includes("secret-never"));
  assert.ok(!JSON.stringify(proof).includes(releaseHash("secret-never-in-proof")));
  await assert.rejects(
    validateWorkerRehearsal({
      proof: { ...proof, sourceCommit: "b".repeat(40) },
      repositoryRoot: f.repositoryRoot,
      sha: SHA,
      workerName: NAME,
      configPath: f.configPath,
      run: f.run,
    }),
    /provenance/u,
  );
  await symlink(join(f.directory, "secrets.json"), join(proof.directory, "bundle/secret.json"));
  await assert.rejects(
    validateWorkerRehearsal({
      proof,
      repositoryRoot: f.repositoryRoot,
      sha: SHA,
      workerName: NAME,
      configPath: f.configPath,
      run: f.run,
    }),
    /symbolic/u,
  );
  await assert.rejects(readPrivateReleaseJson(secretsFile, { maxBytes: 2 }), /size/u);

  // Regression group 3 (W15): every context file a Dockerfile copies is part of the image recipe.
  // Changed copied bytes rename the image; a form that could read unpinned bytes refuses the
  // recipe instead of being skipped.
  const buildContext = join(f.repositoryRoot, "image");
  await mkdir(join(buildContext, "dist"), { recursive: true });
  await writeFile(join(buildContext, "policy.mjs"), "export const floor = '16.3.8';\n");
  await writeFile(join(buildContext, "dist/agent.cjs"), "agent\n");
  await writeFile(join(f.repositoryRoot, "outside.mjs"), "outside\n");
  await symlink(join(buildContext, "policy.mjs"), join(buildContext, "linked.mjs"));
  const recipe = async (dockerfile) => {
    await writeFile(join(buildContext, "Dockerfile"), dockerfile);
    return imageRecipe(
      { image: join(buildContext, "Dockerfile"), image_build_context: buildContext },
      f.repositoryRoot,
    );
  };
  const supported = await recipe(
    "FROM node AS build\nCOPY --from=build /usr/local/bin/node /usr/local/bin/node\n" +
      "# a regular comment\nCOPY --chown=1:1 --chmod=644 policy.mjs \\\n" +
      "# a comment inside the continuation\n  dist/agent.cjs /opt/\n",
  );
  assert.deepEqual(
    supported.inputs.map(({ path }) => path),
    ["image/dist/agent.cjs", "image/policy.mjs"],
  );
  // As in BuildKit, a continuation line keeps its indentation, which separates its first source
  // from the source before the backslash instead of joining both into one name.
  assert.deepEqual(
    (await recipe("FROM scratch\nCOPY policy.mjs\\\n  dist/agent.cjs /opt/\n")).inputs.map(
      ({ path }) => path,
    ),
    ["image/dist/agent.cjs", "image/policy.mjs"],
  );
  const key = async () =>
    releaseHash(JSON.stringify(await recipe("FROM scratch\nCOPY policy.mjs /opt/\n")));
  const approvedKey = await key();
  await writeFile(join(buildContext, "policy.mjs"), "export const floor = '16.3.9';\n");
  assert.notEqual(await key(), approvedKey);
  for (const dockerfile of [
    "FROM scratch\nADD policy.mjs /opt/\n",
    "FROM scratch\nCOPY *.mjs /opt/\n",
    "FROM scratch\nCOPY dist /opt/dist\n",
    "FROM scratch\nCOPY https://example.test/policy.mjs /opt/\n",
    "FROM scratch\nCOPY <<EOF /opt/policy.mjs\nexport {};\nEOF\n",
    'FROM scratch\nCOPY ["policy.mjs", "/opt/"]\n',
    "FROM scratch\nRUN --mount=type=bind,source=policy.mjs,target=/policy.mjs true\n",
    "FROM scratch\nCOPY ../outside.mjs /opt/\n",
    "FROM scratch\nCOPY /policy.mjs /opt/\n",
    "FROM scratch\nCOPY linked.mjs /opt/\n",
    "FROM scratch\nCOPY missing.mjs /opt/\n",
    "FROM scratch\nCOPY $SOURCE /opt/\n",
    "FROM scratch\nCOPY --from=builder /usr/local/bin/node /node\n",
    "FROM scratch\nCOPY --parents policy.mjs /opt/\n",
    "# escape=`\nFROM scratch\nCOPY policy.mjs /opt/\n",
    "\uFEFF# syntax=docker/dockerfile:1\nFROM scratch\nCOPY policy.mjs /opt/\n",
    "FROM scratch\nONBUILD COPY policy.mjs /opt/\n",
  ])
    await assert.rejects(
      recipe(dockerfile),
      /^Error: Container image (?:recipe cannot pin|input)/u,
    );
  // The recovery image's real Dockerfile pins its built agent, and refuses before it is built;
  // its ignore file only selects context files and is not a recipe input.
  const recovery = join(f.repositoryRoot, "recovery");
  await mkdir(join(recovery, "container"), { recursive: true });
  for (const path of ["container/Dockerfile", ".dockerignore"])
    await writeFile(
      join(recovery, path),
      await readFile(join(ROOT, "apps/project-recovery-worker", path)),
    );
  const recoveryRecipe = () =>
    imageRecipe(
      { image: join(recovery, "container/Dockerfile"), image_build_context: recovery },
      f.repositoryRoot,
    );
  await assert.rejects(recoveryRecipe(), /Container image input is missing/u);
  await mkdir(join(recovery, "dist/container"), { recursive: true });
  await writeFile(join(recovery, "dist/container/agent.cjs"), "built agent\n");
  assert.deepEqual(
    (await recoveryRecipe()).inputs.map(({ path }) => path),
    ["recovery/dist/container/agent.cjs"],
  );
  // The build sandbox's runtime owns its egress declaration guard. It and every contract file
  // copied into the image are policy sources, so their bytes require a complete release cohort.
  const copied = (
    await imageRecipe(
      { image: join(ROOT, "apps/build-runner/sandbox/Dockerfile"), image_build_context: ROOT },
      ROOT,
    )
  ).inputs.map(({ path }) => path);
  assert.ok(copied.includes("apps/build-runner/sandbox/build-runtime.mjs"));
  assert.ok(copied.includes(POLICY_SOURCES[0]));
  for (const path of copied.filter(
    (path) =>
      path.startsWith("packages/") || path === "apps/build-runner/sandbox/build-runtime.mjs",
  ))
    assert.ok(POLICY_SOURCES.includes(path), path);
});

test("local command env cannot reintroduce credentials and CLI arguments require explicit scoped approval", async (context) => {
  const output = await runReleaseCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({token:process.env.CLOUDFLARE_API_TOKEN,metrics:process.env.WRANGLER_SEND_METRICS}))",
    ],
    {
      localOnly: true,
      env: { CLOUDFLARE_API_TOKEN: "must-be-removed", WRANGLER_SEND_METRICS: "true" },
    },
  );
  assert.deepEqual(JSON.parse(output), { metrics: "false" });
  await assert.rejects(
    runReleaseCommand(process.execPath, [
      "-e",
      "process.stderr.write('password-never-return');process.exit(3)",
    ]),
    (error) => !error.message.includes("password") && error.message.includes("3"),
  );
  assert.throws(() => parseRehearsalArguments(["--manifest", "x", "--out", "y"]));
  assert.throws(() => parseTrainArguments(["--manifest", "x", "--environment", "production"]));
  assert.throws(() =>
    parseTrainArguments(["--manifest", "x", "--print-approval", "--approval", "x"]),
  );
  assert.deepEqual(parseTrainArguments(["--manifest", "x", "--print-approval"]), {
    "--manifest": "x",
    printApproval: true,
  });
  const calls = [];
  await assert.rejects(
    inspectRehearsalRepository({
      cwd: "/repo",
      run: async (command, args) => {
        calls.push([command, ...args]);
        return "dirty";
      },
    }),
  );
  assert.ok(!calls.some(([, ...args]) => args.includes("ls-remote")));
  let ref = "refs/heads/feat/feedback-mail";
  const localRun = async (command, args) => {
    calls.push([command, ...args]);
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return "/repo";
    if (key === "status --porcelain=v1 --untracked-files=all") return "";
    if (key === "symbolic-ref --quiet HEAD") {
      if (ref === null) throw new Error("detached");
      return ref;
    }
    if (key === "remote get-url origin" || key === "remote get-url --push origin")
      return "https://github.com/amerged-org/ohmyhost.git";
    if (key === "rev-parse HEAD") return SHA;
    throw new Error(`Unexpected command ${command} ${key}`);
  };
  assert.deepEqual(await inspectRehearsalRepository({ cwd: "/repo", run: localRun }), {
    repositoryRoot: "/repo",
    sha: SHA,
  });
  for (ref of ["refs/heads/invalid", "refs/heads/feat/nested/topic", null])
    await assert.rejects(inspectRehearsalRepository({ cwd: "/repo", run: localRun }));
  assert.ok(!calls.some(([, ...args]) => args.includes("ls-remote")));
  // The train CLI prints only the fixed cohort sentence; other errors never reach the output.
  const generic = trainFailureMessage(new Error("password-never-return"));
  assert.ok(!generic.includes("password") && generic.startsWith("Release train is incomplete"));
  const refusal = new PolicyCohortError("missing", "production", [
    { name: "ohmyho-build-sandbox-production", workerName: "ohmyho-build-runner-production" },
  ]);
  assert.equal(trainFailureMessage(refusal), refusal.message);
  assert.throws(
    () => new PolicyCohortError("missing", "production", [{ name: "token=secret value" }]),
    /refusal is invalid/u,
  );
  // Standalone platform:release has no rehearsal, approval or cohort check, so it refuses a
  // policy consumer before CI, builds or provider calls.
  const f = await fixture(context);
  const commands = [];
  await assert.rejects(
    releaseWorker({
      configPath: f.configPath,
      expectedName: "ohmyho-source-fetcher-production",
      cwd: f.repositoryRoot,
      run: async (command, args, options) => {
        commands.push(command);
        return f.run(command, args, options);
      },
      wrangler: "wrangler",
      env: {},
    }),
    /only through release:train/u,
  );
  assert.ok(commands.length > 0 && commands.every((command) => command === "git"));
});

test("ingress observations are GET-only, paginated and normalized; incomplete reads fail closed", async () => {
  const requests = [];
  const manifest = { steps: [{ kind: "worker", workerName: NAME }], accountId: ACCOUNT };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, undefined);
    const { pathname } = new URL(url);
    if (pathname.startsWith("/client/v4/zones/") && pathname.endsWith("/workers/routes"))
      return new Response("zone route permission denied", { status: 403 });
    const result = url.includes("/subdomain")
      ? { enabled: false, previews_enabled: false }
      : url.includes("/schedules")
        ? { schedules: [{ cron: "0 * * * *" }] }
        : url.includes("/workers/domains")
          ? [
              {
                id: "d".repeat(32),
                hostname: "example.test",
                service: NAME,
                environment: "production",
                zone_id: "e".repeat(32),
              },
            ]
          : url.includes("/environments/production/routes")
            ? [
                {
                  id: "a".repeat(32),
                  pattern: "example.test/*",
                  zone_name: "example.test",
                  script: NAME,
                },
              ]
            : pathname.endsWith(`/workers/services/${NAME}`)
              ? {
                  id: NAME,
                  default_environment: { environment: "production", script: { id: NAME } },
                }
              : [{ id: "e".repeat(32), name: "example.test", account: { id: ACCOUNT } }];
    return new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }));
  };
  const observation = await observeReleaseIngress({
    manifest,
    run: async () => JSON.stringify({ type: "api_token", token: "private-token" }),
    wrangler: "wrangler",
    fetch,
  });
  assert.equal(observation.routes.length, 1);
  assert.deepEqual(observation.workers[0].crons, ["0 * * * *"]);
  assert.ok(!JSON.stringify(observation).includes("private-token"));
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ url }) => !new URL(url).pathname.startsWith("/client/v4/zones/")));
  assert.ok(
    requests.some(({ url }) => url.includes("/environments/production/routes?show_zonename=true")),
  );
  const readIngress = (reader) =>
    observeReleaseIngress({
      manifest,
      run: async () => JSON.stringify({ type: "api_token", token: "private-token" }),
      wrangler: "wrangler",
      fetch: reader,
    });
  const changedResponse = (matches, change) => async (url, options) => {
    const response = await fetch(url, options);
    if (!matches(new URL(url))) return response;
    const value = await response.json();
    change(value);
    return Response.json(value);
  };
  const routePath = (url) => url.pathname.endsWith("/environments/production/routes");
  const servicePath = (url) => url.pathname.endsWith(`/workers/services/${NAME}`);
  const zonesPath = (url) => url.pathname === "/client/v4/zones";
  for (const [matches, change, expected] of [
    [
      routePath,
      (body) => {
        body.result = {};
      },
      /complete list/u,
    ],
    [
      routePath,
      (body) => {
        body.result = [null];
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].script = "foreign-worker";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].id = "invalid";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].pattern = "";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].pattern = "example.test/\n*";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].zone_name = "unknown.test";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].zone_id = "f".repeat(32);
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].environment = "staging";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result[0].service = "foreign-worker";
      },
      /route identity/u,
    ],
    [
      routePath,
      (body) => {
        body.result.push(body.result[0]);
      },
      /route identity/u,
    ],
    [
      servicePath,
      (body) => {
        body.result.id = "foreign-worker";
      },
      /service environment/u,
    ],
    [
      servicePath,
      (body) => {
        body.result.default_environment.environment = "development";
      },
      /service environment/u,
    ],
    [
      servicePath,
      (body) => {
        body.result.default_environment.script.id = "foreign-worker";
      },
      /service environment/u,
    ],
    [
      zonesPath,
      (body) => {
        body.result[0].account.id = "f".repeat(32);
      },
      /zone identity/u,
    ],
    [
      zonesPath,
      (body) => {
        delete body.result[0].account;
      },
      /zone identity/u,
    ],
    [
      zonesPath,
      (body) => {
        body.result[0].name = "invalid..test";
      },
      /zone identity/u,
    ],
    [
      zonesPath,
      (body) => {
        body.result.push(body.result[0]);
      },
      /zone identity/u,
    ],
    [
      zonesPath,
      (body) => {
        body.result.push({ ...body.result[0], id: "f".repeat(32) });
      },
      /zone identity/u,
    ],
  ])
    await assert.rejects(readIngress(changedResponse(matches, change)), expected);
  for (const info of [
    { total_pages: 2 },
    { total_pages: 0 },
    { total_pages: "1" },
    { total_count: 2 },
    { count: 0 },
    { page: 2 },
    { per_page: 0 },
    { per_page: 1 },
    { cursor: "next" },
    { cursors: { after: "next" } },
    { next_page: 2 },
    [],
  ])
    await assert.rejects(
      readIngress(
        changedResponse(routePath, (body) => {
          body.result_info = info;
        }),
      ),
      /complete list/u,
    );
  for (const status of [403, 500])
    await assert.rejects(
      readIngress(async (url, options) =>
        routePath(new URL(url))
          ? new Response("route read denied", { status })
          : fetch(url, options),
      ),
      /readback failed/u,
    );
  await assert.rejects(
    readIngress(async (url, options) => {
      if (routePath(new URL(url))) throw new Error("network unavailable");
      return fetch(url, options);
    }),
    /readback request is unavailable/u,
  );
  // The actual route API is unpaginated; absent metadata and explicit complete counts are valid.
  for (const info of [
    undefined,
    null,
    { count: 1, total_count: 1, total_pages: 1, page: 1, per_page: 100 },
  ]) {
    const observed = await readIngress(
      changedResponse(routePath, (body) => {
        body.result_info = info;
      }),
    );
    assert.deepEqual(observed, observation);
  }
  // Preserve every verified account zone page and every owned route, including a second zone.
  const paged = await readIngress(async (url, options) => {
    const parsed = new URL(url);
    if (zonesPath(parsed))
      return Response.json({
        success: true,
        result: [
          parsed.searchParams.get("page") === "1"
            ? { id: "e".repeat(32), name: "example.test", account: { id: ACCOUNT } }
            : { id: "f".repeat(32), name: "second.test", account: { id: ACCOUNT } },
        ],
        result_info: { total_pages: 2 },
      });
    if (routePath(parsed))
      return Response.json({
        success: true,
        result: [
          {
            id: "a".repeat(32),
            pattern: "example.test/*",
            zone_name: "example.test",
            script: NAME,
          },
          { id: "b".repeat(32), pattern: "second.test/*", zone_name: "second.test", script: NAME },
        ],
      });
    return fetch(url, options);
  });
  assert.deepEqual(paged.routes, [
    { zoneId: "e".repeat(32), id: "a".repeat(32), pattern: "example.test/*", script: NAME },
    { zoneId: "f".repeat(32), id: "b".repeat(32), pattern: "second.test/*", script: NAME },
  ]);
  const removed = await readIngress(
    changedResponse(routePath, (body) => {
      body.result = [];
    }),
  );
  assert.notDeepEqual(removed.routes, observation.routes);
  assert.notDeepEqual(paged.routes, observation.routes);
  await assert.rejects(
    observeReleaseIngress({
      manifest,
      run: async () => JSON.stringify({ type: "api_token", token: "private-token" }),
      wrangler: "wrangler",
      fetch: async () => new Response("bad", { status: 403 }),
    }),
    /readback/u,
  );

  // Regression group 3 (W15): the policy cohort uses the same GET-only readback and Wrangler
  // token. A consumer's policy is the fingerprint at the commit that a Worker's single 100%
  // version or an application's completed rollout to its live version names, so another revision
  // with identical bytes matches; split, foreign or unprovable state is unknown.
  const live = "00000000000000000000000000000001";
  const [target, same, old, gone] = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  const policy = new Map([
    [target, "floor 16.3.8"],
    [same, "floor 16.3.8"],
    [old, "floor 16.3.8"],
  ]);
  const cohortRun = async (command, args, options) => {
    if (command === "wrangler") return JSON.stringify({ type: "oauth", token: "private-token" });
    assert.equal(command, "git");
    assert.equal(options.localOnly, true);
    const sha = args[0] === "ls-tree" ? args[3].slice(0, 40) : args[1].slice(0, 40);
    if (!policy.has(sha)) throw new Error("Release command failed (128)");
    // The old commit differs only in the framework family that the shared rules import.
    if (args[1] === `${old}:packages/contracts/src/framework-family.ts`) return "family 1";
    return args[0] === "ls-tree"
      ? POLICY_SOURCES.map((path) => `100644 blob ${"0".repeat(40)}\t${path}\0`).join("")
      : policy.get(sha);
  };
  const workers = new Map([
    ["ohmyho-build-runner-production", `source ${same}; config ${"c".repeat(64)}`],
    ["ohmyho-source-fetcher-production", `origin/main ${old}; config ${"c".repeat(64)}`],
    ["ohmyho-control-api-production", `origin/main ${target}; artifact ${"c".repeat(64)}`],
    // The shared Core bundles the admission modules; the Development Core does not exist yet and is no consumer.
    ["ohmyho-control-store-production", `origin/main ${old}; config ${"c".repeat(64)}`],
    ["ohmyho-build-runner-poc-private-fullstack", "split"],
    ["ohmyho-source-fetcher-poc-private-fullstack", "edited in the dashboard"],
    ["ohmyho-control-api-poc-private-fullstack", `origin/main ${gone}; config ${"c".repeat(64)}`],
  ]);
  const image = `registry.cloudflare.com/${live}/ohmyho-release-${"e".repeat(16)}@sha256:${"d".repeat(64)}`;
  // Each application runs version 2; only its completed rollout to that version names the source.
  const applications = [
    ["ohmyho-build-sandbox-production", same, image],
    ["ohmyho-build-sandbox-production-eu", old, image],
    // An image changed outside the release tools no longer matches its rollout.
    ["ohmyho-build-sandbox-poc-private-fullstack", target, "docker.io/library/node:24"],
    ["ohmyho-build-sandbox-poc-private-fullstack-eu", target, image],
  ].map(([name, sha, current], index) => ({
    id: `${index}0000000-2222-4333-8444-555555555555`,
    name,
    version: 2,
    configuration: { image: current },
    rollouts: [
      { status: "completed", target_version: 1, description: `origin/main ${old}; image ${image}` },
      { status: "completed", target_version: 2, description: `source ${sha}; image ${image}` },
    ],
  }));
  const cohortRequests = [];
  const cohortFetch = async (url, options) => {
    cohortRequests.push(url);
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, "error");
    const { pathname, searchParams } = new URL(url);
    const presence = /\/workers\/scripts\/([^/]+)\/versions$/u.exec(pathname);
    if (presence !== null)
      return presence[1] === "ohmyho-control-store-poc-private-fullstack"
        ? new Response(JSON.stringify({ success: false, errors: [{ code: 10007 }] }), {
            status: 404,
          })
        : new Response(JSON.stringify({ success: true, result: { items: [{ id: VERSION }] } }));
    const script = /\/workers\/scripts\/([^/]+)\/(?:deployments|versions\/([^/]+))$/u.exec(
      pathname,
    );
    const message = workers.get(script?.[1]);
    const application = applications.find(
      ({ id, name }) =>
        name === searchParams.get("name") ||
        pathname.endsWith(`/${id}`) ||
        pathname.endsWith(`/${id}/rollouts`),
    );
    const result =
      script === null
        ? pathname.endsWith("/rollouts")
          ? application.rollouts
          : searchParams.has("name")
            ? [application]
            : application
        : script[2] !== undefined
          ? { id: script[2], annotations: { "workers/message": message } }
          : {
              deployments: [
                {
                  versions:
                    message === "split"
                      ? [
                          { version_id: VERSION, percentage: 90 },
                          { version_id: "22222222-2222-4333-8444-555555555555", percentage: 10 },
                        ]
                      : [{ version_id: VERSION, percentage: 100 }],
                },
              ],
            };
    return new Response(JSON.stringify({ success: true, result }));
  };
  const production = {
    environment: "production",
    sourceCommit: target,
    accountId: live,
    steps: [],
  };
  const cohortObservation = await observePolicyCohort({
    manifest: production,
    repositoryRoot: ROOT,
    run: cohortRun,
    wrangler: "wrangler",
    fetch: cohortFetch,
  });
  assert.ok(!JSON.stringify(cohortObservation).includes("private-token"));
  assert.ok(
    cohortRequests.every((url) =>
      url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${live}/`),
    ),
  );
  assert.deepEqual(
    cohortObservation.consumers.map(({ name, live: value, target: wanted }) => [
      name,
      value === wanted ? "at policy" : value === "unknown" ? "unknown" : "differs",
    ]),
    [
      ["ohmyho-build-runner-production", "at policy"],
      ["ohmyho-build-sandbox-production", "at policy"],
      ["ohmyho-build-sandbox-production-eu", "differs"],
      ["ohmyho-source-fetcher-production", "differs"],
      ["ohmyho-control-api-production", "at policy"],
      ["ohmyho-control-store-production", "differs"],
      ["ohmyho-build-runner-poc-private-fullstack", "unknown"],
      ["ohmyho-build-sandbox-poc-private-fullstack", "unknown"],
      ["ohmyho-build-sandbox-poc-private-fullstack-eu", "at policy"],
      ["ohmyho-source-fetcher-poc-private-fullstack", "unknown"],
      ["ohmyho-control-api-poc-private-fullstack", "unknown"],
    ],
  );
  workers.set("ohmyho-build-runner-production", `sourcex ${same}; config ${"c".repeat(64)}`);
  const unknownSource = await observePolicyCohort({
    manifest: production,
    repositoryRoot: ROOT,
    run: cohortRun,
    wrangler: "wrangler",
    fetch: cohortFetch,
  });
  assert.equal(
    unknownSource.consumers.find(({ name }) => name === "ohmyho-build-runner-production").live,
    "unknown",
  );
  workers.set("ohmyho-build-runner-production", `source ${same}; config ${"c".repeat(64)}`);
  // LIST can lag a completed rollout: identity comes from its unique name/UUID pair, while
  // version and image must come from the authoritative GET for that very application.
  const selected = applications[1];
  const appPath = `/client/v4/accounts/${live}/containers/applications/${selected.id}`;
  const fresh = { ...selected, version: 10, configuration: { image } };
  const completed = [
    {
      status: "completed",
      target_version: 10,
      description: `origin/main ${target}; image ${image}`,
    },
  ];
  const observeContainer = async ({ current = fresh, rollouts = completed, failure } = {}) => {
    const requested = [];
    const observation = await observePolicyCohort({
      manifest: production,
      repositoryRoot: ROOT,
      run: cohortRun,
      wrangler: "wrangler",
      fetch: async (url, options) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get("name") === selected.name) {
          requested.push("list");
          return Response.json({
            success: true,
            result: [
              { ...selected, version: 9, configuration: { image: "registry.example.test/old:9" } },
            ],
          });
        }
        if (parsed.pathname === appPath) {
          requested.push("get");
          if (failure === "throw") throw new Error("private-provider-detail");
          if (failure === "status") return new Response("private-provider-detail", { status: 503 });
          if (failure === "json") return new Response("private-provider-detail");
          return Response.json({ success: true, result: current });
        }
        if (parsed.pathname === `${appPath}/rollouts`) {
          requested.push("rollouts");
          return Response.json({ success: true, result: rollouts });
        }
        return cohortFetch(url, options);
      },
    });
    return {
      observation,
      requested,
      consumer: observation.consumers.find(({ name }) => name === selected.name),
    };
  };
  const freshObservation = await observeContainer();
  assert.equal(freshObservation.consumer.live, freshObservation.consumer.target);
  assert.deepEqual(freshObservation.requested, ["list", "get", "rollouts"]);
  for (const current of [
    null,
    [],
    { ...fresh, id: applications[0].id },
    { ...fresh, name: applications[0].name },
    ...[0, -1, 10.5, "10", Number.MAX_SAFE_INTEGER + 1].map((version) => ({ ...fresh, version })),
    { ...fresh, configuration: null },
    ...[null, 1, "", "bad image"].map((image) => ({ ...fresh, configuration: { image } })),
  ]) {
    const invalid = await observeContainer({ current });
    assert.equal(invalid.consumer.live, "unknown");
    assert.deepEqual(
      invalid.requested,
      ["list", "get"],
      "invalid GET never falls back to LIST or reads rollouts",
    );
  }
  for (const failure of ["throw", "status", "json"])
    await assert.rejects(
      observeContainer({ failure }),
      (error) =>
        /policy cohort readback/u.test(error.message) &&
        !error.message.includes("private-provider-detail"),
    );
  for (const rollouts of [
    [{ ...completed[0], status: "progressing" }],
    [{ ...completed[0], target_version: 9 }],
    [{ ...completed[0], description: `origin/main ${target}; image registry.example.test/old:9` }],
    [{ ...completed[0], description: `sourcex ${target}; image ${image}` }],
    [{ ...completed[0], description: "dashboard edit" }],
    [completed[0], completed[0]],
  ])
    assert.equal((await observeContainer({ rollouts })).consumer.live, "unknown");
  assert.throws(
    () =>
      requirePolicyCohort({
        manifest: {
          ...production,
          steps: ["build-runner", "source-fetcher", "control-api"].map((app) => ({
            kind: "worker",
            workerName: `ohmyho-${app}-production`,
            config: `apps/${app}/wrangler.production.jsonc`,
          })),
        },
        observation: cohortObservation,
        phase: "before",
      }),
    (error) =>
      error instanceof PolicyCohortError &&
      error.message ===
        "Release policy cohort refused: development consumers ohmyho-build-runner-poc-private-fullstack, ohmyho-build-sandbox-poc-private-fullstack, ohmyho-control-api-poc-private-fullstack, ohmyho-source-fetcher-poc-private-fullstack differ from the release policy; release ohmyho-build-runner-poc-private-fullstack, ohmyho-control-api-poc-private-fullstack, ohmyho-source-fetcher-poc-private-fullstack in development first",
  );
  const brokenLogin = async (command, args, options) =>
    command === "wrangler" ? "not json private-token" : cohortRun(command, args, options);
  for (const [run, fetch, pattern] of [
    [cohortRun, async () => new Response("bad", { status: 403 }), /policy cohort readback failed/u],
    [brokenLogin, cohortFetch, /policy cohort readback credential/u],
  ])
    await assert.rejects(
      observePolicyCohort({
        manifest: production,
        repositoryRoot: ROOT,
        run,
        wrangler: "wrangler",
        fetch,
      }),
      (error) => pattern.test(error.message) && !error.message.includes("private-token"),
    );
});

test("client prerequisite accepts canonical prepared metadata and verifies all five registry tarball bytes", async (context) => {
  const f = await fixture(context);
  const directory = join(f.directory, "npm");
  await mkdir(directory, { mode: 0o700 });
  const bytes = new TextEncoder().encode("prepared archive bytes");
  const version = "0.1.28";
  const packages = [];
  for (const suffix of ["cli", "mcp", "sdk", "runtime", "auth"]) {
    const file = `amerged-ohmyhost-${suffix}-${version}.tgz`;
    await writeFile(join(directory, file), bytes);
    packages.push({
      name: `@amerged/ohmyhost-${suffix}`,
      version,
      file,
      sha256: releaseHash(bytes),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      files: ["package.json"],
      sourceArchiveSha256: "d".repeat(64),
    });
  }
  const prepared = JSON.stringify({ sourceCommit: SHA, version, packages });
  await writeFile(join(directory, "manifest.json"), prepared);
  const step = {
    kind: "clients",
    action: "verify",
    directory,
    version,
    manifestSha256: releaseHash(prepared),
  };
  let reads = 0;
  const fetch = async (url) => {
    reads += 1;
    const record = packages.find((record) => url.includes(record.name.replace("/", "%2F")));
    return record
      ? new Response(
          JSON.stringify({
            name: record.name,
            version,
            license: "Apache-2.0",
            dist: {
              integrity: record.integrity,
              tarball: `https://registry.npmjs.org/archive/${record.file}`,
            },
          }),
        )
      : new Response(bytes);
  };
  const result = await executePrerequisite({
    step,
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    env: {},
    fetch,
  });
  assert.equal(result.verified.length, 5);
  assert.equal(reads, 10);
  await assert.rejects(
    executePrerequisite({
      step,
      manifest: f.manifest,
      repositoryRoot: f.repositoryRoot,
      env: {},
      fetch: async () => new Response("missing", { status: 404 }),
    }),
    /unavailable/u,
  );
  const malicious = JSON.stringify({
    sourceCommit: SHA,
    version,
    packages: [{ ...packages[0], file: "../secret" }, ...packages.slice(1)],
  });
  await writeFile(join(directory, "manifest.json"), malicious);
  await assert.rejects(
    executePrerequisite({
      step: { ...step, manifestSha256: releaseHash(malicious) },
      manifest: f.manifest,
      repositoryRoot: f.repositoryRoot,
      env: {},
      fetch,
    }),
    /metadata/u,
  );
});

test("co-changing a valid rehearsal bundle and its receipt cannot reuse the previously reviewed approval", async (context) => {
  const f = await fixture(context);
  await rehearseRelease({
    manifest: f.manifest,
    outputPath: f.manifest.rehearsal,
    artifactsDirectory: f.artifactsDirectory,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
  });
  const prepared = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  const approval = releaseApprovalDigest({
    manifest: f.manifest,
    preparationSha256: prepared.fingerprint,
  });
  const retained = (await readPrivateReleaseJson(f.manifest.rehearsal)).value;
  const proof = retained.workers.example;
  const altered = "export default {}; // unreviewed changed bytes\n";
  await writeFile(join(proof.directory, "bundle", proof.entrypoint), altered);
  proof.bundles.find(({ path }) => path === proof.entrypoint).sha256 = releaseHash(altered);
  proof.bundles.find(({ path }) => path === proof.entrypoint).bytes = new TextEncoder().encode(
    altered,
  ).length;
  await writeFile(f.manifest.rehearsal, JSON.stringify(retained), { mode: 0o600 });
  const alteredPreparation = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  assert.notEqual(alteredPreparation.fingerprint, prepared.fingerprint);
  const callStart = f.calls.length;
  await assert.rejects(
    executeReleaseTrain({
      manifest: f.manifest,
      statePath: join(f.directory, "state.json"),
      environment: "development",
      approval,
      cwd: f.repositoryRoot,
      run: f.run,
      wrangler: "wrangler",
    }),
    /approval differs/u,
  );
  assert.ok(
    f.calls.slice(callStart).every(([command]) => ["git", "docker"].includes(command)),
    "CI and provider operations remain blocked",
  );
});

test("a newly approved bundle at the same retained path cannot replay the old Worker version", async (context) => {
  const f = await fixture(context);
  await rehearseRelease({
    manifest: f.manifest,
    outputPath: f.manifest.rehearsal,
    artifactsDirectory: f.artifactsDirectory,
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
  });
  const first = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  const observeIngress = async () => ({
    domains: [],
    routes: [],
    workers: [
      { workerName: NAME, subdomain: { enabled: false, previews_enabled: false }, crons: [] },
    ],
  });
  const policySha256 = "9".repeat(64);
  const options = {
    manifest: f.manifest,
    environment: "development",
    cwd: f.repositoryRoot,
    run: f.run,
    wrangler: "wrangler",
    env: {},
    observeIngress,
    // Every policy consumer is at the release policy, so this unrelated Worker is unaffected.
    observePolicy: async () => ({
      policySha256,
      consumers: [
        {
          environment: "development",
          name: "ohmyho-source-fetcher-poc-private-fullstack",
          workerName: "ohmyho-source-fetcher-poc-private-fullstack",
          config: "apps/source-fetcher/wrangler.development.jsonc",
          target: policySha256,
          live: policySha256,
        },
      ],
    }),
  };
  await executeReleaseTrain({
    ...options,
    statePath: join(f.directory, "first-train.json"),
    approval: releaseApprovalDigest({ manifest: f.manifest, preparationSha256: first.fingerprint }),
  });
  const previous = JSON.parse(await readFile(join(f.directory, "first-train.json"), "utf8")).steps
    .example.receipt;
  const retained = (await readPrivateReleaseJson(f.manifest.rehearsal)).value;
  const proof = retained.workers.example;
  const changed = "export default {}; // same path with separately approved new executable bytes\n";
  f.expectedBundle.value = changed;
  await writeFile(join(proof.directory, "bundle", proof.entrypoint), changed);
  const record = proof.bundles.find(({ path }) => path === proof.entrypoint);
  record.sha256 = releaseHash(changed);
  record.bytes = new TextEncoder().encode(changed).length;
  await writeFile(f.manifest.rehearsal, JSON.stringify(retained), { mode: 0o600 });
  const second = await prepareReleaseTrain({
    manifest: f.manifest,
    repositoryRoot: f.repositoryRoot,
    run: f.run,
  });
  await executeReleaseTrain({
    ...options,
    statePath: join(f.directory, "second-train.json"),
    approval: releaseApprovalDigest({
      manifest: f.manifest,
      preparationSha256: second.fingerprint,
    }),
  });
  const latest = JSON.parse(await readFile(join(f.directory, "second-train.json"), "utf8")).steps
    .example.receipt;
  assert.equal(
    f.calls.filter(([, action, sub]) => action === "versions" && sub === "upload").length,
    2,
  );
  assert.notEqual(previous.tag, latest.tag);
  assert.notEqual(previous.message, latest.message);
  await assert.rejects(
    verifyWorkerReleaseReceipt({
      receipt: previous,
      configuration: second.workers.example.configuration,
      rehearsal: second.workers.example.proof,
      sourceSha: SHA,
      configPath: f.configPath,
      repositoryRoot: f.repositoryRoot,
      run: f.run,
      wrangler: "wrangler",
      env: {},
    }),
    /exact current source and configuration/u,
  );
});

test("asset snapshots bind source and retained bytes to approval and only retained assets can upload", async (context) => {
  for (const mutate of [
    "source-change",
    "snapshot-change",
    "source-add",
    "snapshot-delete",
    "snapshot-symlink",
  ]) {
    const f = await fixture(context);
    const sourceAssets = join(f.repositoryRoot, "public");
    await mkdir(sourceAssets);
    await writeFile(join(sourceAssets, "index.html"), "approved asset bytes\n");
    f.config.assets = { directory: "public", binding: "ASSETS" };
    f.config.build = { command: "must-not-run-during-rehearsal-or-upload" };
    await writeFile(f.configPath, JSON.stringify(f.config));
    f.step.configSha256 = releaseHash(await readFile(f.configPath));
    await rehearseRelease({
      manifest: f.manifest,
      outputPath: f.manifest.rehearsal,
      artifactsDirectory: f.artifactsDirectory,
      cwd: f.repositoryRoot,
      run: f.run,
      wrangler: "wrangler",
    });
    const prepared = await prepareReleaseTrain({
      manifest: f.manifest,
      repositoryRoot: f.repositoryRoot,
      run: f.run,
    });
    const proof = prepared.workers.example.proof;
    const validated = await validateWorkerRehearsal({
      proof,
      configuration: prepared.workers.example.configuration,
      repositoryRoot: f.repositoryRoot,
      sha: SHA,
      workerName: NAME,
      configPath: f.configPath,
      run: f.run,
    });
    assert.equal(validated.assets.directory, proof.assets.directory);
    assert.notEqual(validated.assets.directory, sourceAssets);
    assert.equal(
      await readFile(join(proof.assets.directory, "index.html"), "utf8"),
      "approved asset bytes\n",
    );
    const upload = f.run;
    await releaseWorker({
      configPath: f.configPath,
      cwd: f.repositoryRoot,
      run: async (command, args, options) => {
        if (args[0] === "versions" && args[1] === "upload") {
          const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
          assert.equal(config.assets.directory, proof.assets.directory);
        }
        return upload(command, args, options);
      },
      wrangler: "wrangler",
      env: {},
      rehearsal: proof,
    });
    if (mutate === "source-change")
      await writeFile(join(sourceAssets, "index.html"), "unapproved source asset\n");
    if (mutate === "snapshot-change")
      await writeFile(join(proof.assets.directory, "index.html"), "unapproved retained asset\n");
    if (mutate === "source-add")
      await writeFile(join(sourceAssets, "extra.txt"), "unapproved new file\n");
    if (mutate === "snapshot-delete") await rm(join(proof.assets.directory, "index.html"));
    if (mutate === "snapshot-symlink")
      await symlink(join(sourceAssets, "index.html"), join(proof.assets.directory, "linked.html"));
    const previousUploads = f.calls.filter(
      ([, action, sub]) => action === "versions" && sub === "upload",
    ).length;
    await assert.rejects(
      releaseWorker({
        configPath: f.configPath,
        cwd: f.repositoryRoot,
        run: f.run,
        wrangler: "wrangler",
        env: {},
        rehearsal: proof,
      }),
      /asset inventory|symbolic/u,
    );
    assert.equal(
      f.calls.filter(([, action, sub]) => action === "versions" && sub === "upload").length,
      previousUploads,
    );
  }
});

test("artifact-pinned Worker tags remain their self-check digest while rehearsal identity changes the exact version message", () => {
  const artifact = { digest: "d".repeat(64) };
  const first = workerReleaseIdentity({
    sha: SHA,
    configuration: {},
    artifact,
    rehearsal: { bundles: [{ sha256: "e".repeat(64) }], assets: null },
  });
  const second = workerReleaseIdentity({
    sha: SHA,
    configuration: {},
    artifact,
    rehearsal: { bundles: [{ sha256: "f".repeat(64) }], assets: null },
  });
  assert.equal(first.tag, artifact.digest);
  assert.equal(second.tag, artifact.digest);
  assert.notEqual(first.message, second.message);
});

test("rehearsal captures typed Docker and BuildKit identities into the approved proof for either local image store", async (context) => {
  for (const kind of ["config", "manifest"]) {
    const f = await fixture(context);
    await writeFile(join(f.repositoryRoot, "policy.mjs"), "export const floor = '16.3.8';\n");
    await writeFile(join(f.repositoryRoot, "Dockerfile"), "FROM scratch\nCOPY policy.mjs /opt/\n");
    f.config.containers = [
      {
        name: "ohmyho-local-sandbox",
        class_name: "BuildSandbox",
        image: "./Dockerfile",
        image_build_context: ".",
      },
    ];
    f.step.containerImages = join(f.directory, "images.json");
    await writeFile(f.configPath, JSON.stringify(f.config));
    f.step.configSha256 = releaseHash(await readFile(f.configPath));
    let record;
    const run = async (command, args, options) => {
      if (command === "docker" && args[0] === "build") {
        assert.equal(options.localOnly, true);
        assert.ok(args.includes("--metadata-file"));
        const labels = Object.fromEntries(
          args.flatMap((value, index) =>
            value === "--label" ? [args[index + 1].split(/=(.*)/su).slice(0, 2)] : [],
          ),
        );
        const configDigest = `sha256:${releaseHash(JSON.stringify({ labels }))}`;
        const manifestDigest = `sha256:${releaseHash(JSON.stringify({ configDigest, layers: [] }))}`;
        const descriptor = {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: 2955,
          annotations: { "config.digest": configDigest },
        };
        record = {
          Id: kind === "manifest" ? manifestDigest : configDigest,
          Os: "linux",
          Architecture: "amd64",
          Config: { Labels: labels },
          ...(kind === "manifest" ? { Descriptor: descriptor } : {}),
        };
        await writeFile(
          args[args.indexOf("--metadata-file") + 1],
          JSON.stringify({
            "containerimage.digest": manifestDigest,
            "containerimage.config.digest": configDigest,
            "containerimage.descriptor": descriptor,
          }),
          { mode: 0o600 },
        );
        return "built";
      }
      if (command === "docker" && args[0] === "image") return JSON.stringify([record]);
      return f.run(command, args, options);
    };
    await rehearseRelease({
      manifest: f.manifest,
      outputPath: f.manifest.rehearsal,
      artifactsDirectory: f.artifactsDirectory,
      cwd: f.repositoryRoot,
      run,
      wrangler: "wrangler",
    });
    const prepared = await prepareReleaseTrain({
      manifest: f.manifest,
      repositoryRoot: f.repositoryRoot,
      run,
    });
    const proof = prepared.workers.example.proof;
    const image = Object.values(proof.images)[0];
    assert.equal(image.imageIdKind, kind);
    assert.notEqual(image.manifestDigest, image.configDigest);
    assert.equal(image.imageId, kind === "manifest" ? image.manifestDigest : image.configDigest);
    const original = releaseApprovalDigest({
      manifest: f.manifest,
      preparationSha256: prepared.fingerprint,
    });
    // A copied image input changed after rehearsal names another recipe: no approval covers it.
    await writeFile(join(f.repositoryRoot, "policy.mjs"), "export const floor = '16.3.9';\n");
    await assert.rejects(
      prepareReleaseTrain({ manifest: f.manifest, repositoryRoot: f.repositoryRoot, run }),
      /image receipt is invalid/u,
    );
    await writeFile(join(f.repositoryRoot, "policy.mjs"), "export const floor = '16.3.8';\n");
    const restored = await prepareReleaseTrain({
      manifest: f.manifest,
      repositoryRoot: f.repositoryRoot,
      run,
    });
    assert.equal(
      releaseApprovalDigest({ manifest: f.manifest, preparationSha256: restored.fingerprint }),
      original,
    );
    image.configDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(
      f.manifest.rehearsal,
      JSON.stringify({
        schemaVersion: 1,
        sourceCommit: SHA,
        manifestSha256: manifestDigest(f.manifest),
        workers: { example: proof },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      prepareReleaseTrain({ manifest: f.manifest, repositoryRoot: f.repositoryRoot, run }),
      /typed|descriptors|identity/u,
    );
    assert.equal(original.length, 64);
  }
});
