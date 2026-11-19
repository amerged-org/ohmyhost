import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import {
  assertSharedBindingsPreserved,
  assertSpikeImage,
  assertZonePreflight,
  baseline,
  createRoute,
  expectedWorkerDeployment,
  isOverlappingRoute,
  nativeScope,
  provider,
  runCommand,
  validateOwnedResources,
  validateScopeManifest,
  verifyControlTarget,
  upload,
  safeDiagnostic,
} from "./deployment.mjs";

const id = "00000000000000000000000000000001";
const zone = "0000000000000000000000000000000b";
const execFileAsync = promisify(execFile);

test("provider baseline fails closed on account, zone, certificates and overlapping routes", () => {
  const input = {
    account: { id },
    zone: { id: zone, name: "omh.st", account: { id } },
    certificates: [
      {
        status: "active",
        hosts: ["*.preview.dev.omh.st"],
        certificates: [{ status: "active", expires_on: "2030-01-01T00:00:00Z" }],
      },
    ],
    routes: [{ id: "123", pattern: "*.other.dev.omh.st/*", script: "another" }],
    dns: [],
    now: Date.parse("2026-11-15T00:00:00Z"),
  };
  assert.doesNotThrow(() => assertZonePreflight(input));
  assert.equal(isOverlappingRoute("*.dev.omh.st/*"), true);
  assert.equal(isOverlappingRoute("https://control.preview.dev.omh.st/*"), true);
  assert.equal(isOverlappingRoute("*.other.dev.omh.st/*"), false);
  assert.throws(() => assertZonePreflight({ ...input, routes: [{ pattern: "*.dev.omh.st/*" }] }));
  assert.throws(() =>
    assertZonePreflight({ ...input, zone: { ...input.zone, account: { id: "0" } } }),
  );
  assert.throws(() => assertZonePreflight({ ...input, dns: [{ name: "*.preview.dev.omh.st" }] }));
  assert.throws(() => assertZonePreflight({ ...input, certificates: [] }));
});

test("shared deployments retain every existing non-QA binding and secret", () => {
  const before = [
    { name: "SECRET", type: "secret_text" },
    { name: "SERVICE", type: "service", service: "target", entrypoint: "Thing" },
    { name: "FLAG", type: "plain_text", text: "old" },
  ];
  const after = [...before, { name: "QA_NEW", type: "service", service: "qa" }];
  assert.doesNotThrow(() => assertSharedBindingsPreserved(before, after, []));
  assert.throws(() =>
    assertSharedBindingsPreserved(
      before,
      after.filter((x) => x.name !== "SECRET"),
      [],
    ),
  );
  assert.throws(() =>
    assertSharedBindingsPreserved(
      before,
      after.map((x) => (x.name === "SERVICE" ? { ...x, service: "other" } : x)),
      [],
    ),
  );
  assert.doesNotThrow(() =>
    assertSharedBindingsPreserved(
      before,
      after.map((x) => (x.name === "FLAG" ? { ...x, text: "new" } : x)),
      ["FLAG"],
    ),
  );
});

test("SDK 1.0 image readback and live QA fixture identity are strictly scoped", () => {
  const image = `registry.cloudflare.com/${id}/spike@sha256:${"a".repeat(64)}`;
  const version = {
    resources: {
      script_runtime: {
        containers: [
          {
            name: "ohmyho-preview-spike-development",
            class_name: "PreviewSpike",
            images: { fixture: image },
          },
        ],
      },
    },
  };
  assert.equal(assertSpikeImage(version), image);
  assert.throws(() =>
    assertSpikeImage({
      resources: {
        script_runtime: {
          containers: [
            {
              ...version.resources.script_runtime.containers[0],
              images: { fixture: "registry.example/test:latest" },
            },
          ],
        },
      },
    }),
  );
  assert.throws(() => validateScopeManifest({ platform: "production", projects: [] }));
});

function fakeInventory() {
  const account = "00000000000000000000000000000001";
  const zone = "0000000000000000000000000000000b";
  const bucket = {
    name: "ohmyho-preview-spike-backups-development",
    creation_date: "2026-11-15T06:00:00.000Z",
    location: "WEUR",
    jurisdiction: "default",
  };
  const dns = {
    id: "1".repeat(32),
    name: "*.preview.dev.omh.st",
    type: "A",
    content: "192.0.2.1",
    proxied: true,
    ttl: 1,
    created_on: "2026-11-15T06:00:00.000Z",
    comment: "QA",
  };
  const route = {
    id: "2".repeat(32),
    pattern: "*.preview.dev.omh.st/*",
    script: "ohmyho-preview-spike-development",
  };
  const versionId = "9d84ff2b-a73a-4ab5-a467-f72de7837190",
    deploymentId = "3".repeat(32);
  const writes = [],
    requests = [],
    routes = [];
  const read = async (path, options = {}) => {
    requests.push(path);
    if (options.method === "POST") {
      writes.push(options.body);
      routes.push(route);
      return { result: route };
    }
    if (path === `/accounts/${account}`) return { result: { id: account } };
    if (path === `/zones/${zone}`)
      return { result: { id: zone, name: "omh.st", account: { id: account } } };
    if (path.startsWith(`/zones/${zone}/ssl/certificate_packs`)) {
      if (!path.includes("per_page=50"))
        throw new Error("certificate page size exceeds provider limit");
      return {
        result: [
          {
            status: "active",
            hosts: [dns.name],
            certificates: [{ status: "active", expires_on: "2030-01-01T00:00:00Z" }],
          },
        ],
        result_info: { page: 1, total_pages: 1 },
      };
    }
    if (path === `/zones/${zone}/workers/routes`) return { result: routes };
    if (path.startsWith(`/zones/${zone}/dns_records?`))
      return { result: [dns], result_info: { page: 1, total_pages: 1 } };
    if (path === `/zones/${zone}/dns_records/${dns.id}`) return { result: dns };
    if (path === `/accounts/${account}/r2/buckets/${bucket.name}`) return { result: bucket };
    if (path === `/accounts/${account}/r2/buckets`)
      return { result: { buckets: [] }, result_info: { cursor: "next" } };
    if (path === `/accounts/${account}/r2/buckets?cursor=next`)
      return { result: { buckets: [bucket] }, result_info: {} };
    if (path.startsWith(`/accounts/${account}/containers/applications?name=`))
      return { result: [], result_info: {} };
    if (path.endsWith(`/versions/${versionId}`))
      return {
        result: {
          id: versionId,
          annotations: { "workers/message": `source ${"a".repeat(40)}; config test` },
          resources: { bindings: [] },
        },
      };
    if (path.endsWith("/deployments")) {
      if (/preview-spike-(?:auth|mail)-development/u.test(path)) return null;
      return {
        result: {
          deployments: [
            { id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] },
          ],
        },
      };
    }
    throw new Error("unplanned simulated call");
  };
  return {
    account,
    zone,
    bucket,
    dns,
    route,
    versionId,
    deploymentId,
    writes,
    requests,
    routes,
    read,
  };
}

test("simulated provider verifies owned resources and paginates before an exact route write", async () => {
  const fixture = fakeInventory(),
    { account, zone, bucket, dns, versionId, deploymentId } = fixture;
  const records = [];
  for (const [kind, name, resource, request] of [
    [
      "bucket",
      bucket.name,
      bucket,
      { name: bucket.name, locationHint: "weur", storageClass: "Standard" },
    ],
    [
      "dns",
      dns.name,
      dns,
      {
        type: "A",
        name: dns.name,
        content: dns.content,
        proxied: true,
        ttl: 1,
        comment: dns.comment,
      },
    ],
  ]) {
    const base = {
      schemaVersion: 1,
      accountId: account,
      zoneId: zone,
      kind,
      name,
      at: "2026-11-15T06:00:00.000Z",
    };
    const operationId = "9d84ff2b-a73a-4ab5-a467-f72de7837190";
    records.push(
      { ...base, phase: "baseline", present: false },
      { ...base, phase: "intent", operationId, request },
      { ...base, phase: "created", operationId, resource },
      { ...base, phase: "verified", operationId, resource },
    );
  }
  const owned = validateOwnedResources(records);
  assert.throws(() => validateOwnedResources(records.slice(1)));
  // During the initial baseline all three new Workers must be absent.
  const readBeforeSpike = async (path, options) =>
    path.includes("/workers/scripts/ohmyho-preview-spike-development/")
      ? null
      : fixture.read(path, options);
  const ancestry = [];
  const source = "b".repeat(40);
  const check = async (command, args) => {
    ancestry.push({ command, args });
    return "";
  };
  const snapshot = await baseline(readBeforeSpike, owned, {
    sha: source,
    root: "/synthetic",
    run: check,
  });
  assert.equal(ancestry.length, 5);
  assert.ok(
    ancestry.every(
      (item) =>
        item.command === "git" &&
        item.args[0] === "merge-base" &&
        item.args[2] === "a".repeat(40) &&
        item.args[3] === source,
    ),
  );
  await assert.rejects(
    baseline(readBeforeSpike, owned, {
      sha: source,
      root: "/synthetic",
      run: async () => {
        throw new Error("not ancestor");
      },
    }),
  );
  assert.equal(snapshot.owned.dns.id, dns.id);
  assert.ok(fixture.requests.includes(`/accounts/${account}/r2/buckets?cursor=next`));
  assert.equal(fixture.writes.length, 0);
  const route = await createRoute(fixture.read, { owned }, { versionId, deploymentId });
  assert.equal(route.routeId, fixture.route.id);
  const prior = expectedWorkerDeployment(
    [
      { state: "verified", result: { worker: fixture.route.script, versionId, deploymentId } },
      { state: "verified", result: { worker: fixture.route.script, routeId: route.routeId } },
    ],
    {},
    fixture.route.script,
  );
  assert.deepEqual(prior, { versionId, deploymentId });
  const recordsForControl = [
    {
      state: "verified",
      step: "spike",
      result: { worker: fixture.route.script, versionId, deploymentId },
    },
    {
      state: "verified",
      step: "route",
      result: { worker: fixture.route.script, pattern: route.pattern, routeId: route.routeId },
    },
  ];
  await verifyControlTarget(fixture.read, recordsForControl);
  fixture.routes[0] = { ...fixture.route, script: "foreign-worker" };
  await assert.rejects(verifyControlTarget(fixture.read, recordsForControl));
  fixture.routes[0] = fixture.route;
  await assert.rejects(
    verifyControlTarget(fixture.read, [
      {
        ...recordsForControl[0],
        result: {
          ...recordsForControl[0].result,
          versionId: "c8db4d7f-38e7-4339-af33-a2e2fedfc767",
        },
      },
      recordsForControl[1],
    ]),
  );
  assert.deepEqual(fixture.writes, [
    { pattern: fixture.route.pattern, script: fixture.route.script },
  ]);
  await assert.rejects(createRoute(fixture.read, { owned }, { versionId, deploymentId }));
  assert.equal(fixture.writes.length, 1);
});

test("provider adapter refuses foreign failures and never sends bearer tokens in URLs", async () => {
  const calls = [];
  const read = provider({
    token: "private-test-token",
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return {
        ok: false,
        status: 403,
        json: async () => ({ success: false, errors: [{ message: "secret diagnostic" }] }),
      };
    },
  });
  await assert.rejects(
    read("/accounts/test"),
    (error) => error.message === "cloudflare_request_failed",
  );
  assert.equal(calls[0].url.includes("private-test-token"), false);
  assert.equal(calls[0].headers.authorization, "Bearer private-test-token");
});

test("simulated Auth creation uploads the fixed private source and verifies exact active version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-deploy-test-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const name = "ohmyho-preview-spike-auth-development";
  const versionId = "9d84ff2b-a73a-4ab5-a467-f72de7837190",
    deploymentId = "3".repeat(32);
  let created = false,
    view,
    config,
    configFileMode;
  const commands = [];
  const run = async (command, args) => {
    commands.push({ command, args });
    if (command === "git" && args[0] === "rev-parse") return `${"a".repeat(40)}\n`;
    if (command === "git" && args[0] === "status") return "";
    if (args[0] === "deploy") {
      const path = args[args.indexOf("--config") + 1];
      configFileMode = (await stat(path)).mode & 0o777;
      config = JSON.parse(await readFile(path, "utf8"));
      const tag = args[args.indexOf("--tag") + 1],
        message = args[args.indexOf("--message") + 1];
      view = {
        id: versionId,
        annotations: { "workers/tag": tag, "workers/message": message },
        resources: {
          bindings: [
            ...config.services.map((item) => ({
              type: "service",
              name: item.binding,
              service: item.service,
              entrypoint: item.entrypoint,
            })),
            ...config.durable_objects.bindings.map((item) => ({
              type: "durable_object_namespace",
              name: item.name,
              class_name: item.class_name,
            })),
          ],
        },
      };
      created = true;
      return "";
    }
    if (args[0] === "versions" && args[1] === "list") return JSON.stringify([view]);
    throw new Error("unexpected command");
  };
  const read = async (path) => {
    if (path.endsWith("/deployments"))
      return created
        ? {
            result: {
              deployments: [
                { id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] },
              ],
            },
          }
        : null;
    if (path.endsWith(`/versions/${versionId}`)) return { result: view };
    throw new Error("unexpected provider request");
  };
  try {
    const result = await upload({
      stage: "auth",
      root,
      sha: "a".repeat(40),
      read,
      run,
      wrangler: "/fake/wrangler",
      env: {},
      directory,
    });
    assert.equal(result.worker, name);
    assert.equal(result.versionId, versionId);
    assert.equal(config.name, name);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.routes, undefined);
    assert.equal(configFileMode, 0o600);
    const wranglerCommands = commands.filter((item) => item.command === "/fake/wrangler");
    assert.equal(wranglerCommands[0].args[0], "deploy");
    assert.equal(wranglerCommands[0].args.includes("--secrets-file"), false);
    assert.equal(wranglerCommands.length, 2);
    const secondDirectory = await mkdtemp(join(tmpdir(), "qa-deploy-drift-test-"));
    try {
      let wrote = false;
      const driftRun = async (command, args) => {
        if (command === "git" && args[0] === "rev-parse") return `${"a".repeat(40)}\n`;
        if (command === "git" && args[0] === "status") return " M changed-source.mjs\n";
        wrote = true;
        return "";
      };
      await assert.rejects(
        upload({
          stage: "auth",
          root,
          sha: "a".repeat(40),
          read: async () => null,
          run: driftRun,
          wrangler: "/fake/wrangler",
          env: {},
          directory: secondDirectory,
        }),
      );
      assert.equal(wrote, false);
    } finally {
      await rm(secondDirectory, { recursive: true, force: true });
    }
    assert.equal(
      safeDiagnostic(new Error("provider private diagnostic")),
      "development_deployment_unverified",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wrangler preload excludes local dotenv files in direct and nested build processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-wrangler-guard-test-"));
  const guardPath = fileURLToPath(new URL("./wrangler-guard.mjs", import.meta.url));
  const emptyEnvFile = join(directory, "empty.env");
  const fakeDirectory = join(directory, "wrangler", "wrangler-dist");
  const fake = join(fakeDirectory, "cli.js");
  try {
    await mkdir(fakeDirectory, { recursive: true });
    await writeFile(emptyEnvFile, "", { mode: 0o600 });
    await writeFile(join(directory, ".env.local"), "SYNTHETIC_CANARY=should-not-load\n", {
      mode: 0o600,
    });
    await writeFile(
      fake,
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const pos = args.indexOf("--env-file");
const selected = pos < 0 ? ".env.local" : args[pos + 1];
process.stdout.write(JSON.stringify({ args, value: fs.readFileSync(selected, "utf8"), tokenPresent: !!process.env.CLOUDFLARE_API_TOKEN }));
`,
    );
    const options = { cwd: directory, token: "synthetic-token", emptyEnvFile, guardPath };
    const direct = JSON.parse(await runCommand(process.execPath, [fake, "--version"], options));
    assert.deepEqual(direct.args, ["--version", "--env-file", emptyEnvFile]);
    assert.equal(direct.value, "");
    assert.equal(direct.tokenPresent, true);
    const nestedProgram = `const { spawnSync } = require("node:child_process"); const child = spawnSync(process.execPath, [process.argv[1], "upload"], { encoding: "utf8" }); if (child.status !== 0) process.exit(1); process.stdout.write(child.stdout);`;
    const nested = JSON.parse(
      await runCommand(process.execPath, ["-e", nestedProgram, fake], options),
    );
    assert.deepEqual(nested.args, ["upload", "--env-file", emptyEnvFile]);
    assert.equal(nested.value, "");
    const provided = JSON.parse(
      await runCommand(process.execPath, [fake, "--env-file", emptyEnvFile, "upload"], options),
    );
    assert.deepEqual(provided.args, ["upload", "--env-file", emptyEnvFile]);
    const providedInline = JSON.parse(
      await runCommand(process.execPath, [fake, `--env-file=${emptyEnvFile}`, "upload"], options),
    );
    assert.deepEqual(providedInline.args, ["upload", "--env-file", emptyEnvFile]);
    const trailing = JSON.parse(
      await runCommand(process.execPath, [fake, "upload", "--", "literal"], options),
    );
    assert.deepEqual(trailing.args, ["upload", "--env-file", emptyEnvFile, "--", "literal"]);
    await assert.rejects(
      runCommand(
        process.execPath,
        [fake, "upload", "--env-file", emptyEnvFile, "--env-file", emptyEnvFile],
        options,
      ),
    );
    const nonempty = join(directory, "nonempty.env");
    await writeFile(nonempty, "SYNTHETIC_CANARY=do-not-load\n", { mode: 0o600 });
    await assert.rejects(
      runCommand(process.execPath, [fake, "upload"], { ...options, emptyEnvFile: nonempty }),
    );
    const publicFile = join(directory, "public.env");
    await writeFile(publicFile, "", { mode: 0o644 });
    await chmod(publicFile, 0o644);
    await assert.rejects(
      runCommand(process.execPath, [fake, "upload"], { ...options, emptyEnvFile: publicFile }),
    );
    await assert.rejects(
      runCommand(process.execPath, [fake, "--env-file", join(directory, ".env.local")], options),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real pinned Wrangler dry-runs do not load local dotenv files when the flag is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-real-wrangler-guard-test-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const guardPath = fileURLToPath(new URL("./wrangler-guard.mjs", import.meta.url));
  const emptyEnvFile = join(directory, "empty.env");
  const networkGuardPath = join(directory, "deny-network.mjs");
  const networkAttempt = join(directory, "network-attempted");
  const versions = [
    ["4.145.0", join(root, "apps/control-store/node_modules/.bin/wrangler")],
    ["4.158.0", join(root, "scripts/preview-spike/worker/node_modules/.bin/wrangler")],
  ];
  try {
    await writeFile(emptyEnvFile, "", { mode: 0o600 });
    await writeFile(
      networkGuardPath,
      `import net from 'node:net'; import { appendFileSync } from 'node:fs';
net.Socket.prototype.connect = function () { appendFileSync(${JSON.stringify(networkAttempt)}, 'blocked\\n'); throw new Error('network_blocked'); };
globalThis.fetch = async () => { appendFileSync(${JSON.stringify(networkAttempt)}, 'blocked\\n'); throw new Error('network_blocked'); };
`,
      { mode: 0o600 },
    );
    for (const [expected, binary] of versions) {
      const cwd = join(directory, expected);
      await mkdir(cwd);
      await writeFile(join(cwd, ".env.local"), "SYNTHETIC_CANARY=should-not-load\n", {
        mode: 0o600,
      });
      await writeFile(
        join(cwd, "index.mjs"),
        "export default { fetch() { return new Response('ok'); } };\n",
      );
      await writeFile(
        join(cwd, "verify-env.cjs"),
        "if (Object.hasOwn(process.env, 'SYNTHETIC_CANARY')) process.exit(42); require('node:fs').writeFileSync('env-guard-proof', 'empty');\n",
      );
      await writeFile(
        join(cwd, "wrangler.jsonc"),
        JSON.stringify({
          name: "qa-env-guard-test",
          main: "index.mjs",
          compatibility_date: "2026-08-24",
          build: { command: "node verify-env.cjs" },
          workers_dev: false,
          preview_urls: false,
        }),
      );
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        TMPDIR: cwd,
        LANG: "C",
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_API_TOKEN: "synthetic-token",
        OHMYHO_G1_EMPTY_ENV_FILE: emptyEnvFile,
        NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href} --import=${pathToFileURL(networkGuardPath).href}`,
      };
      const options = { cwd, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 };
      assert.equal((await execFileAsync(binary, ["--version"], options)).stdout.trim(), expected);
      await execFileAsync(
        binary,
        [
          "deploy",
          "--dry-run",
          "--outdir",
          join(cwd, "out"),
          "--config",
          join(cwd, "wrangler.jsonc"),
        ],
        options,
      );
      assert.equal(await readFile(join(cwd, "env-guard-proof"), "utf8"), "empty");
      const attempt = await readFile(networkAttempt, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (attempt !== null) assert.match(attempt, /^(?:blocked\n)+$/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native mail deployment accepts two to eight distinct scoped recipients", () => {
  const selected = {
    fixture: "next-native-auth",
    organizationId: "00000000000000000000000001",
    projectId: "00000000000000000000000002",
    environmentId: "00000000000000000000000003",
  };
  const manifest = { projects: [selected] };
  const recipients = Array.from({ length: 8 }, (_, index) => `qa-${index + 1}@example.test`);
  const build = (list) =>
    JSON.stringify({ platform: "development", ...selected, recipients: list });
  for (const length of [2, 8]) {
    const scope = build(recipients.slice(0, length));
    assert.equal(nativeScope(scope, manifest), scope);
  }
  for (const list of [
    [recipients[0]],
    [...recipients, "ninth@example.test"],
    [recipients[0], recipients[0]],
    [recipients[0], recipients[0].toUpperCase()],
    [recipients[0], "bad-address"],
  ])
    assert.throws(() => nativeScope(build(list), manifest));
  assert.throws(() =>
    nativeScope(JSON.stringify({ platform: "production", ...selected, recipients }), manifest),
  );
  assert.throws(() =>
    nativeScope(
      JSON.stringify({
        platform: "development",
        ...selected,
        projectId: "00000000000000000000000004",
        recipients,
      }),
      manifest,
    ),
  );
});
