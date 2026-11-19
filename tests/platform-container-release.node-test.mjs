/* global Request, Response, structuredClone */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  releaseWorker,
  renderWranglerConfiguration,
  verifyWorkerReleaseReceipt,
} from "../scripts/platform-release.mjs";
import {
  completeContainerRelease,
  prepareContainerRelease,
  imageRecipe,
  validateLocalContainerImage,
  captureLocalContainerImageIdentity,
  verifyRegistryImageIdentity,
  verifyContainerReleaseReceipt,
} from "../scripts/platform-container-release.mjs";
import { rehearseWorker } from "../scripts/release-rehearsal-artifacts.mjs";
import {
  nativeFrameworkCommands,
  writeFrameworkConfiguration,
} from "../apps/preview-runtime/container/drivers.mjs";

const SHA = "a".repeat(40);
const ACCOUNT = "b".repeat(32);
const VERSION = "11111111-2222-4333-8444-555555555555";
const APP = "22222222-2222-4333-8444-555555555555";
const ROLLOUT = "33333333-2222-4333-8444-555555555555";
const BASELINE = "55555555-2222-4333-8444-555555555555";
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value) => new Response(JSON.stringify(value));

test("the checked-in Preview image has a complete pinned release recipe", async (context) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "ohmyhost-preview-recipe-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const imagePath = "apps/preview-runtime/container/Dockerfile";
  const egressOriginPath = "packages/contracts/src/egress-origin.ts";
  const inputPaths = [
    "apps/build-runner/sandbox/build-runtime.mjs",
    ...[
      "source-write.c",
      "drivers.mjs",
      "protocol.mjs",
      "bindings-worker.mjs",
      "native-loader.mjs",
      "prepare.mjs",
      "serve.mjs",
    ].map((name) => `apps/preview-runtime/container/${name}`),
    ...[
      "react-vite",
      "vanilla-vite",
      "tanstack-start",
      "next-edge",
      "next-native-auth",
      "next-app-mail",
    ].flatMap((fixture) =>
      ["package.json", "pnpm-lock.yaml"].map(
        (name) => `apps/preview-runtime/container/framework-dependency-seed/${fixture}/${name}`,
      ),
    ),
    ...["package.json", "package-lock.json"].map(
      (name) => `apps/preview-runtime/container/framework-dependency-seed/astro-edge/${name}`,
    ),
    "packages/contracts/src/framework-build-script.mjs",
    "packages/contracts/src/browser-capabilities.ts",
    "packages/contracts/src/customer-auth-admission.ts",
    egressOriginPath,
    "packages/customer-runtime/src/preview-transport.ts",
  ].sort();
  const dockerfile = await readFile(join(root, imagePath), "utf8");
  const expected = {
    dockerfile: imagePath,
    context: "",
    dockerfileSha256: createHash("sha256").update(dockerfile).digest("hex"),
    args: {},
    inputs: await Promise.all(
      inputPaths.map(async (path) => ({
        path,
        sha256: createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      })),
    ),
  };
  for (const [environment, expectedName] of [
    ["development", "ohmyho-live-preview-poc-private-fullstack"],
    ["production", "ohmyho-live-preview-production"],
  ]) {
    const configuration = await renderWranglerConfiguration({
      expectedName,
      sourcePath: join(root, `apps/preview-runtime/wrangler.${environment}.jsonc`),
      outputPath: join(temporary, `${environment}.json`),
    });
    assert.deepEqual(await imageRecipe(configuration.containers[0], root), expected);
  }
  const dockerignore = await readFile(join(root, `${imagePath}.dockerignore`), "utf8");
  assert.ok(dockerignore.split("\n").includes(`!${egressOriginPath}`));
  const nodeBase =
    "node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d";
  const sandboxImage =
    "docker.io/cloudflare/sandbox:1.0.1@sha256:e796e813de8213fb062bba279ddeddbf61277389a2cc7b3e4620075a9188843b";
  assert.deepEqual(
    dockerfile.split("\n").filter((line) => line.startsWith("FROM ")),
    [
      `FROM --platform=linux/amd64 ${nodeBase} AS source-helper`,
      `FROM --platform=linux/amd64 ${nodeBase} AS framework-seed`,
      `FROM --platform=linux/amd64 ${sandboxImage} AS sandbox-shim`,
      `FROM --platform=linux/amd64 ${nodeBase}`,
    ],
  );
  assert.ok(
    dockerfile.includes(
      "COPY --from=sandbox-shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim\n",
    ),
  );
  assert.ok(dockerfile.includes("COPY --from=source-helper /tmp/preview-source /usr/local/bin/\n"));
  assert.equal(dockerfile.includes("preview-confine"), false);

  // Cloudflare's Worker ingress reaches the container network interface, not loopback.
  for (const [name, version, executable] of [
    ["vite", "8.3.4", "bin/vite.js"],
    ["next", "16.4.5", "dist/bin/next"],
    ["astro", "7.4.0", "astro.js"],
    ["@astrojs/cloudflare", "14.4.0", null],
    ["@tanstack/react-start", "1.168.60", null],
  ]) {
    const directory = join(temporary, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version,
        ...(name === "astro" ? { bin: { astro: "astro.js" } } : {}),
      }),
    );
    if (executable) {
      const file = join(directory, executable);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "");
    }
  }
  const config = {
    loaderPath: "/runtime/loader.mjs",
    configPath: "/runtime/application.jsonc",
    bindingConfigPath: "/runtime/bindings.jsonc",
  };
  const endpoint = (command) => {
    const flag = ["--ip", "--hostname", "--host"].find((value) => command.args.includes(value));
    return [
      command.args[command.args.indexOf(flag) + 1],
      command.args[command.args.indexOf("--port") + 1],
    ];
  };
  for (const [adapter, runtime] of [
    ["vite-static", "static"],
    ["vite-static", "edge"],
    ["tanstack-start", "edge"],
    ["nextjs", "edge"],
    ["astro", "edge"],
    ["functions", "functions"],
  ]) {
    const commands = nativeFrameworkCommands(
      {
        adapter,
        runtime,
        previewOrigin: "https://preview.example",
        runtimeVariables: {},
        capabilityBindings: { database: true, auth: false },
      },
      temporary,
      config,
    );
    assert.deepEqual(endpoint(commands.application), ["0.0.0.0", "3001"]);
    if (commands.companion) assert.deepEqual(endpoint(commands.companion), ["0.0.0.0", "3003"]);
    if (commands.bindings) assert.deepEqual(endpoint(commands.bindings), ["127.0.0.1", "3002"]);
  }

  // Astro's edge entry receives the Worker-selected public origin and browser headers.
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ name: "astro-test", type: "module" }),
  );
  const astroPackage = join(temporary, "node_modules/@astrojs/cloudflare");
  await writeFile(
    join(astroPackage, "package.json"),
    JSON.stringify({
      name: "@astrojs/cloudflare",
      version: "14.4.0",
      type: "module",
      exports: { ".": "./index.mjs", "./entrypoints/server": "./server.mjs" },
    }),
  );
  await writeFile(join(astroPackage, "index.mjs"), "export default function cloudflare() {}\n");
  await writeFile(
    join(astroPackage, "server.mjs"),
    `export const fixtureExport = 'preserved';
     export default {async fetch(request) {
       const origin = request.headers.get('origin');
       const ok = origin === new URL(request.url).origin;
       return Response.json({url: request.url, origin, referer: request.headers.get('referer'), forwarded: request.headers.get('forwarded'), forwardedHost: request.headers.get('x-forwarded-host'), forwardedProto: request.headers.get('x-forwarded-proto'), marker: request.headers.get('x-ohmyhost-preview-original-origin'), safe: request.headers.get('x-customer-header'), body: await request.text()}, {status: ok ? 200 : 403});
     }};\n`,
  );
  const vitePlugin = join(temporary, "node_modules/@cloudflare/vite-plugin");
  await mkdir(vitePlugin, { recursive: true });
  await writeFile(
    join(vitePlugin, "package.json"),
    JSON.stringify({ name: "@cloudflare/vite-plugin", type: "module", exports: "./index.mjs" }),
  );
  await writeFile(join(vitePlugin, "index.mjs"), "export function cloudflare() {}\n");
  const astroConfig = writeFrameworkConfiguration(
    {
      sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      applicationRoot: ".",
      adapter: "astro",
      runtime: "edge",
      previewOrigin: "https://preview.example",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      capabilityBindings: { database: true, auth: false },
      environment: {},
      runtimeVariables: {},
    },
    temporary,
    { runtimeConfigRoot: join(temporary, "runtime"), repositoryRoot: temporary },
  );
  const astroMain = JSON.parse(await readFile(astroConfig.configPath, "utf8")).main;
  const astro = await import(pathToFileURL(astroMain).href);
  assert.equal(astro.fixtureExport, "preserved");
  const browserOrigin = "https://preview.example";
  const browserReferer = "https://preview.example/editor";
  const request = (originalOrigin, originalReferer, transportOrigin = browserOrigin) => {
    const headers = {
      origin: transportOrigin,
      referer: "http://preview.example/editor",
      "x-forwarded-host": "other.example",
      "x-forwarded-proto": "http",
      forwarded: "host=other.example;proto=http",
      "x-customer-header": "kept",
    };
    if (originalOrigin !== null)
      headers["x-ohmyhost-preview-original-origin"] =
        Buffer.from(originalOrigin).toString("base64");
    if (originalReferer !== null)
      headers["x-ohmyhost-preview-original-referer"] =
        Buffer.from(originalReferer).toString("base64");
    return new Request("http://preview.example/api/notes?view=1", {
      method: "POST",
      headers,
      body: "synthetic",
    });
  };
  const response = await astro.default.fetch(request(browserOrigin, browserReferer));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://preview.example/api/notes?view=1",
    origin: browserOrigin,
    referer: browserReferer,
    forwarded: null,
    forwardedHost: null,
    forwardedProto: null,
    marker: null,
    safe: "kept",
    body: "synthetic",
  });
  const rewritten = await astro.default.fetch(
    request(browserOrigin, browserReferer, "http://preview.example"),
  );
  assert.equal(rewritten.status, 200);
  assert.equal((await rewritten.json()).origin, browserOrigin);
  const foreign = await astro.default.fetch(request("https://other.example", browserReferer));
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).origin, "https://other.example");
  const absent = await astro.default.fetch(request(null, null));
  assert.equal(absent.status, 403);
  assert.deepEqual(await absent.json(), {
    url: "https://preview.example/api/notes?view=1",
    origin: null,
    referer: null,
    forwarded: null,
    forwardedHost: null,
    forwardedProto: null,
    marker: null,
    safe: "kept",
    body: "synthetic",
  });

  // OpenNext's async Node fallback invokes Wrangler without a configPath.
  const nextApplication = join(temporary, "next-fallback");
  await mkdir(nextApplication);
  await writeFile(join(nextApplication, "package.json"), JSON.stringify({ name: "next-fallback" }));
  const selected = {
    OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    OHMYHOST_MAIL_GATEWAY_URL: "https://preview-mail.invalid",
    OHMYHOST_MAIL_KEY: "a".repeat(43),
    CUSTOMER_VALUE: "customer-selected",
  };
  const nextConfig = writeFrameworkConfiguration(
    {
      sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      applicationRoot: ".",
      adapter: "nextjs",
      runtime: "edge",
      previewOrigin: "https://preview.example",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      capabilityBindings: { database: false, auth: false },
      environment: { CUSTOMER_VALUE: "old", OHMYHOST_MAIL_KEY: "untrusted" },
      runtimeVariables: selected,
    },
    nextApplication,
    { runtimeConfigRoot: join(temporary, "next-runtime"), repositoryRoot: nextApplication },
  );
  assert.deepEqual(JSON.parse(await readFile(nextConfig.configPath, "utf8")).vars, selected);
  const require = createRequire(join(root, "apps/build-runner/package.json"));
  assert.equal(require("wrangler/package.json").version, "4.125.0");
  const { getPlatformProxy } = require("wrangler");
  const previousCwd = process.cwd();
  const previousCfFetch = process.env.CLOUDFLARE_CF_FETCH_ENABLED;
  let proxy;
  try {
    process.chdir(nextApplication);
    process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
    proxy = await getPlatformProxy({ envFiles: [], persist: false, remoteBindings: false });
    for (const [name, value] of Object.entries(selected)) assert.equal(proxy.env[name], value);
  } finally {
    try {
      await proxy?.dispose();
    } finally {
      process.chdir(previousCwd);
      if (previousCfFetch === undefined) delete process.env.CLOUDFLARE_CF_FETCH_ENABLED;
      else process.env.CLOUDFLARE_CF_FETCH_ENABLED = previousCfFetch;
    }
  }

  const unsupported = join(temporary, "Dockerfile");
  await writeFile(
    unsupported,
    `FROM scratch\nCOPY --from=${sandboxImage} /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim\n`,
  );
  await assert.rejects(
    imageRecipe({ image: unsupported, image_build_context: temporary }, temporary),
    /Container image recipe cannot pin a Dockerfile context input form/u,
  );
});

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-container-release-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  await mkdir(root);
  const imageReceiptPath = join(directory, "images.json");
  await mkdir(join(root, "sandbox"));
  // The copied policy is an image input: its bytes, not only the Dockerfile, name the image.
  await writeFile(join(root, "sandbox/policy.mjs"), "export const floor = '16.3.8';\n");
  await writeFile(
    join(root, "sandbox/Dockerfile"),
    "FROM scratch\nCOPY sandbox/policy.mjs /opt/policy.mjs\n",
  );
  await writeFile(join(root, "worker.mjs"), "export default {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ohmyhost/example" }));
  const configuration = {
    name: "ohmyho-example-poc-private-fullstack",
    account_id: ACCOUNT,
    main: "worker.mjs",
    workers_dev: false,
    preview_urls: false,
    durable_objects: { bindings: [{ name: "BUILD", class_name: "BuildSandbox" }] },
    containers: [
      {
        name: "ohmyho-sandbox",
        class_name: "BuildSandbox",
        image: "./sandbox/Dockerfile",
        image_build_context: ".",
        instance_type: "standard-3",
        max_instances: 10,
        constraints: { regions: ["ENAM", "WNAM"] },
        rollout_active_grace_period: 900,
      },
    ],
  };
  const configPath = join(root, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify(configuration));
  const app = {
    id: APP,
    account_id: ACCOUNT,
    name: "ohmyho-sandbox",
    version: 1,
    configuration: {
      image: `registry.cloudflare.com/${ACCOUNT}/older@sha256:${"c".repeat(64)}`,
      vcpu: 2,
      memory_mib: 8192,
      memory: "8GiB",
      disk: { size_mb: 16000, size: "16GB" },
      network: { assign_ipv4: "none" },
      command: [],
      entrypoint: [],
      runtime: "linux",
      observability: { logs: { enabled: false } },
    },
    observability: { logs: { enabled: true }, target_instance_percentage: 100 },
    scheduling_policy: "default",
    max_instances: 10,
    durable_objects: { namespace_id: "d".repeat(32) },
    constraints: { regions: ["ENAM", "WNAM"], tier: 1 },
    rollout_active_grace_period: 900,
  };
  const baseline = {
    id: BASELINE,
    description: "Previously accepted rollout",
    status: "completed",
    current_version: 0,
    target_version: 1,
    target_configuration: {
      image: app.configuration.image,
      vcpu: 2,
      memory_mib: 8192,
      memory: "8GiB",
      disk: { size_mb: 16000, size: "16GB" },
    },
    steps: [10, 100].map((percentage) => ({ status: "completed", step_size: { percentage } })),
    progress: { total_steps: 2, current_step: 2, total_instances: 2, updated_instances: 2 },
  };
  const state = {
    app,
    baseline,
    history: [baseline],
    calls: [],
    requests: [],
    images: new Map(),
    publishedImages: new Map(),
    version: null,
    legacyUploaded: false,
    deployed: false,
    rollout: null,
    rejectRollout: false,
    incomplete: false,
    wrongReadback: false,
    advanceVersionOnPost: false,
    timeoutAfterAccept: false,
    sourceSha: SHA,
    failedAuth: false,
  };
  const response = (result) => json({ success: true, result });
  const run = async (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return root;
      if (key === "rev-parse --is-bare-repository") return "false";
      if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main";
      if (key.startsWith("status ")) return "";
      if (key === "remote get-url --push origin" || key === "remote get-url origin")
        return "https://github.com/amerged-org/ohmyhost.git";
      if (key.startsWith("ls-remote ")) return `${SHA}\trefs/heads/main`;
      if (key.startsWith("rev-parse ")) return SHA;
    }
    if (command === "pnpm") return "built";
    if (command === "gh")
      return JSON.stringify([
        { databaseId: 42, headSha: SHA, status: "completed", conclusion: "success" },
      ]);
    if (command === "docker" && args[0] === "build") {
      assert.ok(args.includes("linux/amd64"));
      assert.ok(args.includes(`org.opencontainers.image.revision=${SHA}`));
      state.labels = Object.fromEntries(
        args.flatMap((v, i) => (v === "--label" ? [args[i + 1].split(/=(.*)/su).slice(0, 2)] : [])),
      );
      return "built";
    }
    if (args[0] === "auth") {
      if (state.failedAuth) throw new Error("secret-credential-never-print");
      return JSON.stringify({ type: "api_token", token: "secret-credential-never-print" });
    }
    if (args[0] === "containers" && args[1] === "registries")
      return JSON.stringify({ password: "secret-registry-password" });
    if (args[0] === "containers" && args[1] === "push") {
      const config = JSON.stringify({
        architecture: "amd64",
        os: "linux",
        config: {
          Labels: { ...state.labels, "org.opencontainers.image.revision": state.sourceSha },
        },
      });
      const manifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          digest: digest(config),
          size: Buffer.byteLength(config),
          mediaType: "application/vnd.oci.image.config.v1+json",
        },
        layers: [],
      });
      state.images.set(args[2], { manifest, config });
      state.publishedImages.set(digest(manifest), { manifest, config });
      return "pushed";
    }
    if (args[0] === "versions" && args[1] === "list")
      return JSON.stringify(state.version && !state.legacyUploaded ? [state.version] : []);
    if (args[0] === "deploy" || (args[0] === "versions" && args[1] === "upload")) {
      // Observed 2026-09-29: the legacy PUT acknowledges a new version, but deployable=true
      // omits it and the Versions deployment remains old. Existing Workers must use Versions.
      state.legacyUploaded = args[0] === "deploy";
      state.deployed = false;
      if (!state.legacyUploaded) assert.equal(args.includes("--containers-rollout"), false);
      const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      assert.ok(config.containers.every((c) => /@sha256:[a-f0-9]{64}$/u.test(c.image)));
      state.version = {
        id: VERSION,
        annotations: {
          "workers/tag": args[args.indexOf("--tag") + 1],
          "workers/message": args[args.indexOf("--message") + 1],
        },
        resources: {
          bindings: [
            {
              type: "durable_object_namespace",
              name: "BUILD",
              class_name: "BuildSandbox",
              namespace_id: "d".repeat(32),
            },
          ],
        },
      };
      return state.legacyUploaded ? `Current Version ID: ${VERSION}` : "Worker version uploaded";
    }
    if (args[0] === "versions" && args[1] === "view") return JSON.stringify(state.version);
    if (args[0] === "versions" && args[1] === "deploy") {
      assert.equal(args[2], `${VERSION}@100%`);
      assert.ok(args.includes("--yes"));
      state.deployed = true;
      return "Worker version deployed";
    }
    if (args[0] === "deployments")
      return JSON.stringify({
        versions: state.deployed ? [{ version_id: VERSION, percentage: 100 }] : [],
      });
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  };
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    state.requests.push({ path, method: options.method ?? "GET", body: options.body });
    if (parsed.hostname === "registry.cloudflare.com") {
      const match = path.match(/\/manifests\/(.+)$/u);
      if (match) {
        const imageName = path.slice(`/v2/${ACCOUNT}/`.length).split("/manifests/")[0];
        const found =
          state.images.get(`${imageName}:${match[1]}`) ?? state.publishedImages.get(match[1]);
        return found
          ? new Response(found.manifest, {
              headers: { "Docker-Content-Digest": digest(found.manifest) },
            })
          : new Response("missing", { status: 404 });
      }
      const found = [...state.publishedImages.values()].find((v) =>
        path.endsWith(digest(v.config)),
      );
      if (found) return new Response(found.config);
    }
    if (path.endsWith("/containers/me"))
      return response({
        external_account_id: ACCOUNT,
        legacy_identity: { account_id: ACCOUNT },
      });
    if (path.endsWith("/settings"))
      return response({
        bindings: [
          {
            type: "durable_object_namespace",
            class_name: "BuildSandbox",
            namespace_id: "d".repeat(32),
          },
        ],
      });
    if (path.endsWith("/containers/applications"))
      return response(
        (state.apps ?? [state.app]).filter((app) => app.name === parsed.searchParams.get("name")),
      );
    if (path.endsWith(`/applications/${APP}/rollouts`)) {
      if (options.method === "POST") {
        assert.equal(state.deployed, true, "the exact Worker must be active before image rollout");
        if (state.rejectRollout)
          return new Response(JSON.stringify({ success: false }), { status: 400 });
        const body = JSON.parse(options.body);
        assert.deepEqual(
          body.target_configuration,
          { ...state.baseline.target_configuration, image: body.target_configuration.image },
          "only replace image in the provider-accepted target, never copy GET defaults",
        );
        assert.equal(body.kind, "full_auto");
        assert.equal(body.strategy, "rolling");
        assert.deepEqual(
          body.steps.map((s) => s.step_size.percentage),
          [10, 100],
        );
        state.rollout = {
          ...body,
          id: ROLLOUT,
          status: "progressing",
          current_version: 1,
          current_configuration: structuredClone(state.baseline.target_configuration),
          target_version: 2,
          steps: body.steps.map((s) => ({ ...s, status: "progressing" })),
          progress: { total_steps: 2, current_step: 0, total_instances: 2, updated_instances: 0 },
          health: { errors: [], instances: { active: 0, healthy: 2, failed: 0 } },
        };
        state.baseline.status = "replaced";
        if (state.advanceVersionOnPost) {
          state.app.configuration = {
            ...state.app.configuration,
            ...structuredClone(body.target_configuration),
          };
          state.app.version = 2;
        }
        if (state.timeoutAfterAccept) throw new Error("Response timed out after acceptance");
        return response(state.rollout);
      }
      return response([...(state.rollout ? [state.rollout] : []), ...state.history]);
    }
    if (path.endsWith(`/rollouts/${ROLLOUT}`)) {
      if (!state.incomplete) {
        state.rollout.status = "completed";
        state.rollout.steps.forEach((s) => {
          s.status = "completed";
        });
        state.rollout.progress.updated_instances = state.rollout.progress.total_instances;
        if (!state.wrongReadback) {
          state.app.configuration = {
            ...state.app.configuration,
            ...structuredClone(state.rollout.target_configuration),
          };
          state.app.version = 2;
        }
      }
      return response(state.rollout);
    }
    if (path.endsWith(`/applications/${APP}`)) return response(state.app);
    throw new Error(`Unexpected request ${options.method} ${url}`);
  };
  const release = () =>
    releaseWorker({
      configPath,
      cwd: root,
      run,
      wrangler: "wrangler",
      fetch,
      env: {},
      containerWait: async () => {},
      containerAttempts: 2,
      containerImages: imageReceiptPath,
    });
  return { state, release, configuration, configPath, root, run, fetch, imageReceiptPath };
}

test("container release builds once, preserves observability/settings, and verifies the digest and rollout", async (context) => {
  const { state, release } = await fixture(context);
  const result = await release();
  assert.equal(result.deploymentVerified, true);
  assert.equal(result.containers[0].rolloutId, ROLLOUT);
  assert.match(result.containers[0].image, /@sha256:[a-f0-9]{64}$/u);
  assert.equal(state.rollout.description, `source ${SHA}; image ${result.containers[0].image}`);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
  assert.deepEqual(state.app.observability, {
    logs: { enabled: true },
    target_instance_percentage: 100,
  });
  assert.equal(state.app.rollout_active_grace_period, 900);
  assert.ok(state.requests.every((r) => r.method !== "PATCH"));
  const repeated = await release();
  assert.equal(repeated.uploaded, false);
  assert.deepEqual(repeated.containers, result.containers);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
  assert.equal(state.requests.filter((r) => r.method === "POST").length, 1);
  // The former provenance remains a valid exact receipt and must be resumed, never duplicated.
  state.rollout.description = `origin/main ${SHA}; image ${result.containers[0].image}`;
  assert.deepEqual((await release()).containers, result.containers);
  assert.equal(state.requests.filter((r) => r.method === "POST").length, 1);
  // Coexisting old and new matches are ambiguous, even if both have the approved image.
  state.history.push({
    ...structuredClone(state.rollout),
    id: ROLLOUT.replace(/^3/u, "4"),
    description: `source ${SHA}; image ${result.containers[0].image}`,
  });
  await assert.rejects(release(), /ambiguous matching rollouts/u);
});

test("an existing container Worker uses Versions upload and deploy when legacy deploy is not deployable", async (context) => {
  const { state, release } = await fixture(context);
  const result = await release();
  assert.equal(result.deploymentVerified, true);
  const calls = state.calls.filter(([command]) => command === "wrangler");
  assert.equal(
    calls.some(([, command]) => command === "deploy"),
    false,
  );
  const upload = calls.findIndex(
    ([, command, action]) => command === "versions" && action === "upload",
  );
  const deploy = calls.findIndex(
    ([, command, action]) => command === "versions" && action === "deploy",
  );
  assert.ok(upload >= 0 && deploy > upload);
  assert.equal(calls[upload].includes("--containers-rollout"), false);
  assert.equal(state.legacyUploaded, false);
  assert.equal(result.containers[0].rolloutId, ROLLOUT);
});

test("a matched Worker retry repairs the container rollout after provider rejection", async (context) => {
  const { state, release } = await fixture(context);
  state.rejectRollout = true;
  await assert.rejects(release(), /Container.*400/u);
  assert.ok(state.version, "the observed incident leaves the Worker active");
  state.rejectRollout = false;
  const result = await release();
  assert.equal(result.uploaded, false);
  assert.equal(result.containers.length, 1);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
});

test("incomplete rollout and wrong application digest cannot satisfy a matched Worker release", async (context) => {
  const { state, release } = await fixture(context);
  state.incomplete = true;
  await assert.rejects(release(), /not complete/u);
  await assert.rejects(release(), /not complete/u);
  assert.equal(
    state.requests.filter((r) => r.method === "POST").length,
    1,
    "resume the existing rollout",
  );
  state.incomplete = false;
  state.wrongReadback = true;
  await assert.rejects(release(), /readback/u);
});

test("foreign source image, account, namespace, or changed settings stop release", async (context) => {
  for (const mutate of [
    (s) => {
      s.sourceSha = "f".repeat(40);
    },
    (s) => {
      s.app.durable_objects.namespace_id = "f".repeat(32);
    },
    (s) => {
      s.app.max_instances = 11;
    },
    (s) => {
      s.app.rollout_active_grace_period = 0;
    },
    (s) => {
      s.app.constraints.regions = ["APAC"];
    },
    (s) => {
      s.app.account_id = "foreign-account";
    },
  ]) {
    const { state, release } = await fixture(context);
    mutate(state);
    await assert.rejects(release(), /Container|container/u);
    assert.equal(state.version, null);
    assert.equal(state.requests.filter((r) => r.method === "POST").length, 0);
  }
});

test("container authentication errors cannot expose credentials", async (context) => {
  const { state, release } = await fixture(context);
  state.failedAuth = true;
  const error = await release().catch((value) => value);
  assert.match(error.message, /credential/u);
  assert.equal(String(error.stack).includes("secret-credential-never-print"), false);
});

test("expanded instance resources and legacy-only observability preserve the live provider contract", async (context) => {
  const { state, release } = await fixture(context);
  delete state.app.observability;
  delete state.app.configuration.instance_type;
  Object.assign(state.app.configuration, {
    vcpu: 2,
    memory_mib: 8192,
    disk: { size_mb: 16000, size: "16GB" },
    observability: { logs: { enabled: true } },
  });
  state.baseline.target_configuration.observability = { logs: { enabled: true } };
  await release();
  assert.deepEqual(state.app.configuration.observability, { logs: { enabled: true } });
  assert.deepEqual(state.app.configuration.disk, { size_mb: 16000, size: "16GB" });
});

test("accepted targets preserve writable settings and omit derived GET defaults", async (context) => {
  const { state, release } = await fixture(context);
  state.baseline.target_configuration.command = ["node", "custom.js"];
  state.app.configuration.command = ["node", "custom.js"];
  await release();
  assert.deepEqual(state.rollout.target_configuration.command, ["node", "custom.js"]);
  for (const key of ["network", "entrypoint", "runtime", "observability"])
    assert.equal(Object.hasOwn(state.rollout.target_configuration, key), false);
});

test("missing, ambiguous or mismatched accepted baselines cannot start a rollout", async (context) => {
  for (const mutate of [
    (state) => {
      state.history = [];
    },
    (state) => {
      state.history.push({
        ...structuredClone(state.baseline),
        id: "66666666-2222-4333-8444-555555555555",
      });
    },
    (state) => {
      state.baseline.target_configuration.image = `registry.cloudflare.com/${ACCOUNT}/wrong@sha256:${"f".repeat(64)}`;
    },
    (state) => {
      state.baseline.target_configuration.vcpu = 1;
    },
    (state) => {
      state.baseline.target_configuration.instance_type = "standard-3";
      state.baseline.target_configuration.vcpu = 1;
    },
    (state) => {
      state.baseline.target_configuration.memory = "7GiB";
    },
  ]) {
    const { state, release } = await fixture(context);
    mutate(state);
    await assert.rejects(release(), /Container.*baseline|Container.*configuration/u);
    assert.equal(state.requests.filter((request) => request.method === "POST").length, 0);
  }
});

test("an accepted rollout resumes after timeout with advanced app version and replaced predecessor", async (context) => {
  const { state, release } = await fixture(context);
  state.advanceVersionOnPost = true;
  state.timeoutAfterAccept = true;
  state.incomplete = true;
  await assert.rejects(release(), /Container provider request is unavailable/u);
  assert.equal(state.app.version, 2);
  assert.equal(state.baseline.status, "replaced");
  assert.equal(state.rollout.status, "progressing");
  state.timeoutAfterAccept = false;
  await assert.rejects(release(), /not complete/u);
  state.incomplete = false;
  assert.equal((await release()).containers[0].rolloutId, ROLLOUT);
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(
    state.calls.filter(([, command, action]) => command === "versions" && action === "upload")
      .length,
    1,
  );
});

test("a changed own rollout target cannot be adopted on retry", async (context) => {
  const { state, release } = await fixture(context);
  state.incomplete = true;
  await assert.rejects(release(), /not complete/u);
  state.rollout.target_configuration.memory = "7GiB";
  await assert.rejects(release(), /Container.*target/u);
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 1);
});

test("a completed own rollout cannot justify added writable settings on retry", async (context) => {
  for (const change of [
    { environment_variables: [{ name: "UNREVIEWED", value: "changed" }] },
    { network: { assign_ipv4: "static" } },
  ]) {
    const { state, release } = await fixture(context);
    await release();
    assert.equal(state.rollout.status, "completed");
    assert.equal(state.baseline.status, "replaced");
    assert.equal(state.app.version, state.rollout.target_version);
    Object.assign(state.rollout.target_configuration, structuredClone(change));
    Object.assign(state.app.configuration, structuredClone(change));
    await assert.rejects(release(), /Container own rollout target/u);
    assert.equal(state.requests.filter((request) => request.method === "POST").length, 1);
  }
});

test("completed rollout health errors or failed instances cannot approve Development", async (context) => {
  for (const health of [
    { errors: ["image start failed"], instances: { active: 0, healthy: 2, failed: 0 } },
    { errors: [], instances: { active: 0, healthy: 1, failed: 1 } },
  ]) {
    const { state, release, imageReceiptPath } = await fixture(context);
    state.incomplete = true;
    await assert.rejects(release(), /not complete/u);
    state.rollout.health = health;
    state.incomplete = false;
    await assert.rejects(release(), /Container rollout health readback/u);
    await assert.rejects(readFile(`${imageReceiptPath}.development`, "utf8"));
    assert.equal(state.requests.filter((request) => request.method === "POST").length, 1);
  }
});

test("a provider-completed zero-instance rollout remains valid", async (context) => {
  const { state, release } = await fixture(context);
  state.incomplete = true;
  await assert.rejects(release(), /not complete/u);
  state.rollout.progress.total_instances = 0;
  state.rollout.progress.updated_instances = 0;
  state.rollout.health.instances = { active: 0, healthy: 0, failed: 0 };
  state.incomplete = false;
  assert.equal((await release()).containers[0].rolloutId, ROLLOUT);
});

test("regional retry verifies the completed region and resumes the advanced in-progress region", async (context) => {
  const { state, release, configuration } = await fixture(context);
  await release();
  const euId = "77777777-2222-4333-8444-555555555555";
  const euRolloutId = "88888888-2222-4333-8444-555555555555";
  const us = {
    app: structuredClone(state.app),
    rollout: structuredClone(state.rollout),
    history: structuredClone(state.history),
  };
  const eu = structuredClone(us);
  eu.app.id = euId;
  eu.app.name = "ohmyho-sandbox-eu";
  eu.app.durable_objects.namespace_id = "e".repeat(32);
  eu.app.constraints = { jurisdiction: "eu" };
  eu.rollout.id = euRolloutId;
  eu.rollout.status = "progressing";
  eu.rollout.steps.forEach((step) => {
    step.status = "progressing";
  });
  eu.rollout.progress.updated_instances = 0;
  const states = new Map([
    [APP, us],
    [euId, eu],
  ]);
  let euReads = 0;
  const result = await completeContainerRelease({
    release: {
      production: true,
      sha: SHA,
      configuration: {
        name: "ohmyho-example-production",
        durable_objects: {
          bindings: [{ class_name: "BuildSandbox" }, { class_name: "BuildSandboxEu" }],
        },
      },
      targets: [...states.values()].map(({ app }, index) => ({
        container: {
          ...configuration.containers[0],
          name: app.name,
          class_name: index === 0 ? "BuildSandbox" : "BuildSandboxEu",
          constraints: app.constraints,
        },
        applicationId: app.id,
        accountIdentity: ACCOUNT,
        namespaceId: app.durable_objects.namespace_id,
        observability: app.observability,
        image: app.configuration.image,
      })),
      request: async (path, method = "GET") => {
        assert.equal(method, "GET", "a retry must not create another regional rollout");
        const id = path.split("/")[3];
        const current = states.get(id);
        assert.ok(current);
        if (path.endsWith("/rollouts")) return [current.rollout, ...current.history];
        if (path.includes("/rollouts/")) {
          if (id === euId && ++euReads === 2) {
            current.rollout.status = "completed";
            current.rollout.steps.forEach((step) => {
              step.status = "completed";
            });
            current.rollout.progress.updated_instances = 2;
          }
          return current.rollout;
        }
        return current.app;
      },
    },
    version: {
      resources: {
        bindings: [
          {
            type: "durable_object_namespace",
            class_name: "BuildSandbox",
            namespace_id: "d".repeat(32),
          },
          {
            type: "durable_object_namespace",
            class_name: "BuildSandboxEu",
            namespace_id: "e".repeat(32),
          },
        ],
      },
    },
    wait: async () => {},
    attempts: 2,
  });
  assert.deepEqual(
    result.map((entry) => entry.rolloutId),
    [ROLLOUT, euRolloutId],
  );
  assert.equal(euReads, 2);
});

test("US and EU reuse one source-pinned image across Development and Production", async (context) => {
  const { state, configuration, configPath, root, run, fetch, imageReceiptPath } =
    await fixture(context);
  // Two applications can bind the same DO class in this focused image-preparation fixture.
  const eu = structuredClone(configuration.containers[0]);
  eu.name = "ohmyho-sandbox-eu";
  eu.constraints = { jurisdiction: "eu" };
  configuration.containers.push(eu);
  state.apps = [
    state.app,
    {
      ...structuredClone(state.app),
      id: "44444444-2222-4333-8444-555555555555",
      name: eu.name,
      constraints: eu.constraints,
    },
  ];
  for (const container of configuration.containers) {
    container.image = join(root, "sandbox/Dockerfile");
    container.image_build_context = root;
  }
  const prepare = () =>
    prepareContainerRelease({
      configuration,
      repositoryRoot: root,
      sha: SHA,
      run,
      wrangler: "wrangler",
      fetch,
      env: {},
      configPath,
      imageReceiptPath,
    });
  const dev = await prepare();
  assert.equal(dev.targets[0].image, dev.targets[1].image);
  configuration.name = "ohmyho-example-production";
  configuration.containers.forEach((container, index) => {
    container.name += "-production";
    state.apps[index].name = container.name;
  });
  await assert.rejects(prepare(), /Development-verified/u);
  const receipt = await readFile(imageReceiptPath, "utf8");
  await writeFile(
    `${imageReceiptPath}.development`,
    JSON.stringify({
      schemaVersion: 1,
      sourceCommit: SHA,
      receiptSha256: createHash("sha256").update(receipt).digest("hex"),
      workerName: "ohmyho-example-poc-private-fullstack",
      containers: dev.targets.map((target) => ({
        applicationId: target.applicationId,
        image: target.image,
        rolloutId: ROLLOUT,
      })),
    }),
    { mode: 0o600 },
  );
  const prod = await prepare();
  assert.equal(prod.targets[0].image, dev.targets[0].image);
  assert.equal(prod.targets[1].image, dev.targets[0].image);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
  assert.equal(
    state.calls.filter(([, arg, next]) => arg === "containers" && next === "push").length,
    1,
  );
  // W15: a policy change that leaves the Dockerfile untouched must still rename the image, so the
  // Development receipt for the old bytes can never approve the new image in Production.
  const key = async () =>
    createHash("sha256")
      .update(JSON.stringify(await imageRecipe(configuration.containers[0], root)))
      .digest("hex");
  const approvedKey = await key();
  assert.ok(prod.targets[0].image.includes(`/ohmyho-release-${approvedKey.slice(0, 16)}@sha256:`));
  await writeFile(join(root, "sandbox/policy.mjs"), "export const floor = '16.3.9';\n");
  const changedKey = await key();
  assert.notEqual(changedKey.slice(0, 16), approvedKey.slice(0, 16));
  await assert.rejects(prepare(), /does not pin the exact build recipe/u);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
  assert.equal(
    state.calls.filter(([, arg, next]) => arg === "containers" && next === "push").length,
    1,
  );
});

test("tag removal or repointing cannot change the Development-approved image on retry or Production", async (context) => {
  const { state, release, configuration, configPath, imageReceiptPath } = await fixture(context);
  const dev = await release();
  const approvedImage = dev.containers[0].image;
  const pinned = await readFile(imageReceiptPath, "utf8");
  const tag = [...state.images.keys()][0];
  const original = state.images.get(tag);
  const otherConfig = JSON.stringify({
    ...JSON.parse(original.config),
    created: "another build of the same commit",
  });
  const otherManifest = JSON.stringify({
    ...JSON.parse(original.manifest),
    config: {
      ...JSON.parse(original.manifest).config,
      digest: digest(otherConfig),
      size: Buffer.byteLength(otherConfig),
    },
  });
  state.images.set(tag, { manifest: otherManifest, config: otherConfig });
  state.publishedImages.set(digest(otherManifest), state.images.get(tag));
  assert.equal((await release()).containers[0].image, approvedImage);
  state.images.delete(tag);
  assert.equal((await release()).containers[0].image, approvedImage);
  configuration.name = "ohmyho-example-production";
  await writeFile(configPath, JSON.stringify(configuration));
  assert.equal((await release()).containers[0].image, approvedImage);
  assert.equal(await readFile(imageReceiptPath, "utf8"), pinned);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
  state.publishedImages.delete(digest(original.manifest));
  await assert.rejects(release(), /pinned image is unavailable/u);
  assert.equal(state.calls.filter(([cmd, arg]) => cmd === "docker" && arg === "build").length, 1);
});

test("Production cannot create an image receipt or accept an unverified Development attempt", async (context) => {
  const { state, release, configuration, configPath, imageReceiptPath } = await fixture(context);
  configuration.name = "ohmyho-example-production";
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(release(), /Development-verified/u);
  assert.equal(
    state.calls.some(([cmd]) => cmd === "docker"),
    false,
  );
  configuration.name = "ohmyho-example-poc-private-fullstack";
  await writeFile(configPath, JSON.stringify(configuration));
  state.rejectRollout = true;
  await assert.rejects(release(), /400/u);
  assert.ok(await readFile(imageReceiptPath, "utf8"));
  await assert.rejects(readFile(`${imageReceiptPath}.development`, "utf8"));
  configuration.name = "ohmyho-example-production";
  await writeFile(configPath, JSON.stringify(configuration));
  await assert.rejects(release(), /Development-verified/u);
});

test("a Development approval refuses a lost image pin before another build or Worker publication", async (context) => {
  const { state, release, imageReceiptPath } = await fixture(context);
  await release();
  await rm(imageReceiptPath);
  const calls = state.calls.length;
  await assert.rejects(release(), /approval does not match/u);
  assert.equal(
    state.calls.slice(calls).some(([cmd]) => cmd === "docker"),
    false,
  );
  assert.equal(
    state.calls.slice(calls).some(([, command]) => command === "deploy"),
    false,
  );
});

test("container preparation uploads the rehearsed immutable local image without a second build and refuses foreign local provenance", async (context) => {
  const f = await fixture(context);
  const rendered = await renderWranglerConfiguration({
    expectedName: f.configuration.name,
    outputPath: join(f.root, "rendered.json"),
    sourcePath: f.configPath,
  });
  const recipe = createHash("sha256")
    .update(JSON.stringify(await imageRecipe(rendered.containers[0], f.root)))
    .digest("hex");
  f.state.labels = {
    "org.opencontainers.image.revision": SHA,
    "org.opencontainers.image.source": "https://github.com/amerged-org/ohmyhost",
    "st.ohmyho.release.recipe": recipe,
  };
  const imageConfig = JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: { Labels: f.state.labels },
  });
  const imageId = digest(imageConfig);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      digest: imageId,
      size: Buffer.byteLength(imageConfig),
      mediaType: "application/vnd.oci.image.config.v1+json",
    },
    layers: [],
  });
  const proof = {
    imageId,
    recipeSha256: recipe,
    imageIdKind: "config",
    configDigest: imageId,
    manifestDigest: digest(manifest),
  };
  const run = async (command, args) => {
    if (command === "docker" && args[0] === "image")
      return JSON.stringify([
        { Id: imageId, Os: "linux", Architecture: "amd64", Config: { Labels: f.state.labels } },
      ]);
    if (command === "docker" && args[0] === "tag") {
      f.state.calls.push([command, ...args]);
      assert.equal(args[1], imageId);
      return "retagged immutable image";
    }
    return f.run(command, args);
  };
  const release = await prepareContainerRelease({
    configuration: rendered,
    repositoryRoot: f.root,
    sha: SHA,
    run,
    wrangler: "wrangler",
    fetch: f.fetch,
    env: {},
    configPath: f.configPath,
    imageReceiptPath: f.imageReceiptPath,
    rehearsedImages: { [recipe]: proof },
  });
  assert.ok(release.targets[0].image.includes("@sha256:"));
  assert.equal(
    f.state.calls.filter(([command, arg]) => command === "docker" && arg === "build").length,
    0,
  );
  assert.equal(
    f.state.calls.filter(([command, arg]) => command === "docker" && arg === "tag").length,
    1,
  );
  assert.equal(
    f.state.calls.filter(([, command, sub]) => command === "containers" && sub === "push").length,
    1,
  );
  await assert.rejects(
    validateLocalContainerImage({
      image: { ...proof, imageId: `sha256:${"f".repeat(64)}` },
      sha: SHA,
      recipe,
      run,
    }),
    /differs|invalid/u,
  );
  await assert.rejects(
    validateLocalContainerImage({ image: proof, sha: "f".repeat(40), recipe, run }),
    /differs/u,
  );
  await assert.rejects(
    validateLocalContainerImage({ image: proof, sha: SHA, recipe: "f".repeat(64), run }),
    /invalid/u,
  );
});

test("completed train container readback uses only reads and refuses a changed digest, target or health", async (context) => {
  const f = await fixture(context);
  const receipt = await f.release();
  const rendered = await renderWranglerConfiguration({
    expectedName: f.configuration.name,
    outputPath: join(f.root, "verify-config.json"),
    sourcePath: f.configPath,
  });
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      sourceSha: SHA,
      configuration: rendered,
      configPath: f.configPath,
      repositoryRoot: f.root,
      run: f.run,
      wrangler: "wrangler",
      fetch: f.fetch,
      env: {},
    });
  const startCalls = f.state.calls.length;
  const startRequests = f.state.requests.length;
  await verify();
  const description = f.state.rollout.description;
  f.state.rollout.description = `origin/main ${SHA}; image ${receipt.containers[0].image}`;
  await verify();
  f.state.rollout.description = description;
  assert.ok(f.state.requests.slice(startRequests).every(({ method }) => method === "GET"));
  assert.ok(
    f.state.calls
      .slice(startCalls)
      .every(
        ([, command, sub]) => !["upload", "deploy", "push"].includes(sub) && command !== "deploy",
      ),
  );
  f.state.rollout.health.instances.failed = 1;
  await assert.rejects(verify(), /health drifted/u);
  f.state.rollout.health.instances.failed = 0;
  f.state.rollout.target_configuration.command = ["unexpected"];
  await assert.rejects(verify(), /image-only/u);
  delete f.state.rollout.target_configuration.command;
  f.state.version.annotations["workers/message"] = "origin/main old-source";
  await assert.rejects(verify(), /drifted/u);
  assert.equal(f.state.requests.filter(({ method }) => method === "POST").length, 1);
});

test("rehearsal distinguishes classic config IDs and containerd manifest IDs with independently matching BuildKit metadata", async () => {
  const recipe = "e".repeat(64);
  const configDigest = `sha256:${"c".repeat(64)}`;
  const manifestDigest = `sha256:${"d".repeat(64)}`;
  const descriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: manifestDigest,
    size: 2955,
    annotations: { "config.digest": configDigest },
  };
  const metadata = {
    "containerimage.config.digest": configDigest,
    "containerimage.digest": manifestDigest,
    "containerimage.descriptor": descriptor,
  };
  const common = {
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "org.opencontainers.image.revision": SHA,
        "org.opencontainers.image.source": "https://github.com/amerged-org/ohmyhost",
        "st.ohmyho.release.recipe": recipe,
      },
    },
  };
  for (const kind of ["config", "manifest"]) {
    const record = {
      ...common,
      Id: kind === "config" ? configDigest : manifestDigest,
      ...(kind === "config" ? {} : { Descriptor: descriptor }),
    };
    const image = captureLocalContainerImageIdentity({ record, metadata, sha: SHA, recipe });
    assert.deepEqual(
      captureLocalContainerImageIdentity({
        record,
        metadata: {
          "containerimage.digest": manifestDigest,
          "containerimage.descriptor": { ...descriptor, annotations: {} },
        },
        sha: SHA,
        recipe,
      }),
      image,
    );
    assert.equal(image.imageIdKind, kind);
    assert.equal(image.configDigest, configDigest);
    assert.equal(image.manifestDigest, manifestDigest);
    await validateLocalContainerImage({
      image,
      sha: SHA,
      recipe,
      run: async () => JSON.stringify([record]),
    });
    verifyRegistryImageIdentity({ manifestDigest, configDigest, expectedImage: image });
    for (const changed of [
      { ...image, imageIdKind: kind === "config" ? "manifest" : "config" },
      { ...image, configDigest: manifestDigest, manifestDigest: configDigest },
      { ...image, configDigest: undefined },
      { ...image, manifestDigest: undefined },
    ])
      await assert.rejects(
        validateLocalContainerImage({
          image: changed,
          sha: SHA,
          recipe,
          run: async () => JSON.stringify([record]),
        }),
      );
    assert.throws(() =>
      verifyRegistryImageIdentity({
        manifestDigest: configDigest,
        configDigest: manifestDigest,
        expectedImage: image,
      }),
    );
    const transportedManifest = () =>
      verifyRegistryImageIdentity({
        manifestDigest: `sha256:${"f".repeat(64)}`,
        configDigest,
        expectedImage: image,
      });
    if (kind === "manifest") assert.throws(transportedManifest);
    else transportedManifest();
    assert.throws(() =>
      verifyRegistryImageIdentity({
        manifestDigest: "not-a-digest",
        configDigest,
        expectedImage: image,
      }),
    );
    assert.throws(() =>
      verifyRegistryImageIdentity({
        manifestDigest,
        configDigest: `sha256:${"f".repeat(64)}`,
        expectedImage: image,
      }),
    );
  }
  for (const wrong of [
    { "containerimage.config.digest": configDigest },
    { ...metadata, "containerimage.digest": configDigest },
    { ...metadata, "containerimage.descriptor": { ...descriptor, digest: configDigest } },
    {
      ...metadata,
      "containerimage.descriptor": {
        ...descriptor,
        mediaType: "application/vnd.oci.image.index.v1+json",
      },
    },
    { ...metadata, "containerimage.config.digest": `sha256:${"f".repeat(64)}` },
    {
      ...metadata,
      "containerimage.descriptor": {
        ...descriptor,
        annotations: { "config.digest": manifestDigest },
      },
    },
    {
      ...metadata,
      "containerimage.descriptor": {
        ...descriptor,
        platform: { os: "linux", architecture: "arm64" },
      },
    },
  ])
    assert.throws(() =>
      captureLocalContainerImageIdentity({
        record: { ...common, Id: manifestDigest, Descriptor: descriptor },
        metadata: wrong,
        sha: SHA,
        recipe,
      }),
    );
  for (const wrong of [
    undefined,
    { ...descriptor, digest: configDigest },
    { ...descriptor, annotations: {} },
    { ...descriptor, mediaType: "application/vnd.oci.image.index.v1+json" },
  ]) {
    assert.throws(() =>
      captureLocalContainerImageIdentity({
        record: { ...common, Id: manifestDigest, Descriptor: wrong },
        metadata,
        sha: SHA,
        recipe,
      }),
    );
  }
});

test("initial and completed container readbacks compare both approved digest types for classic and containerd images", async (context) => {
  for (const kind of ["config", "manifest"]) {
    const f = await fixture(context);
    const rendered = await renderWranglerConfiguration({
      expectedName: f.configuration.name,
      outputPath: join(f.root, "typed.json"),
      sourcePath: f.configPath,
    });
    const recipe = createHash("sha256")
      .update(JSON.stringify(await imageRecipe(rendered.containers[0], f.root)))
      .digest("hex");
    f.state.labels = {
      "org.opencontainers.image.revision": SHA,
      "org.opencontainers.image.source": "https://github.com/amerged-org/ohmyhost",
      "st.ohmyho.release.recipe": recipe,
    };
    const config = JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { Labels: f.state.labels },
    });
    const configDigest = digest(config);
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: configDigest,
        size: Buffer.byteLength(config),
        mediaType: "application/vnd.oci.image.config.v1+json",
      },
      layers: [],
    });
    const manifestDigest = digest(manifest);
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: manifestDigest,
      size: Buffer.byteLength(manifest),
      annotations: { "config.digest": configDigest },
    };
    const record = {
      Id: kind === "manifest" ? manifestDigest : configDigest,
      Os: "linux",
      Architecture: "amd64",
      Config: { Labels: f.state.labels },
      ...(kind === "manifest" ? { Descriptor: descriptor } : {}),
    };
    const proof = captureLocalContainerImageIdentity({
      record,
      metadata: {
        "containerimage.config.digest": configDigest,
        "containerimage.digest": manifestDigest,
        "containerimage.descriptor": descriptor,
      },
      sha: SHA,
      recipe,
    });
    const run = async (command, args) => {
      if (command === "docker" && args[0] === "image") return JSON.stringify([record]);
      if (command === "docker" && args[0] === "tag") {
        assert.equal(args[1], proof.imageId);
        f.state.calls.push([command, ...args]);
        return "tagged";
      }
      return f.run(command, args);
    };
    const options = {
      configuration: rendered,
      repositoryRoot: f.root,
      sha: SHA,
      run,
      wrangler: "wrangler",
      fetch: f.fetch,
      env: {},
      configPath: f.configPath,
      imageReceiptPath: f.imageReceiptPath,
      rehearsedImages: { [recipe]: proof },
    };
    const release = await prepareContainerRelease(options);
    assert.ok(release.targets[0].image.endsWith(manifestDigest));
    f.state.deployed = true;
    const version = {
      resources: {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "BUILD",
            class_name: "BuildSandbox",
            namespace_id: "d".repeat(32),
          },
        ],
      },
    };
    const containers = await completeContainerRelease({
      release,
      version,
      attempts: 2,
      wait: async () => {},
    });
    const readback = {
      configuration: rendered,
      receipt: { sha: SHA, containers },
      version,
      repositoryRoot: f.root,
      run,
      wrangler: "wrangler",
      fetch: f.fetch,
      env: {},
      configPath: f.configPath,
      rehearsedImages: { [recipe]: proof },
    };
    const requestStart = f.state.requests.length;
    await verifyContainerReleaseReceipt(readback);
    assert.ok(f.state.requests.slice(requestStart).every(({ method }) => method === "GET"));
    const wrongDigest = `sha256:${"f".repeat(64)}`;
    const wrongManifest = {
      ...proof,
      manifestDigest: wrongDigest,
      ...(kind === "manifest" ? { imageId: wrongDigest } : {}),
    };
    const wrongConfig = {
      ...proof,
      configDigest: wrongDigest,
      ...(kind === "config" ? { imageId: wrongDigest } : {}),
    };
    const changedExport = () =>
      verifyContainerReleaseReceipt({ ...readback, rehearsedImages: { [recipe]: wrongManifest } });
    if (kind === "manifest")
      await assert.rejects(changedExport(), /registry manifest\/config differs/u);
    else await changedExport();
    await assert.rejects(
      verifyContainerReleaseReceipt({ ...readback, rehearsedImages: { [recipe]: wrongConfig } }),
      /registry manifest\/config differs/u,
    );
    await assert.rejects(
      verifyContainerReleaseReceipt({ ...readback, rehearsedImages: {} }),
      /omits/u,
    );
    await assert.rejects(prepareContainerRelease({ ...options, rehearsedImages: {} }), /no typed/u);
    assert.equal(
      f.state.calls.filter(([command, arg]) => command === "docker" && arg === "build").length,
      0,
    );
    assert.equal(
      f.state.calls.filter(([, command, sub]) => command === "containers" && sub === "push").length,
      1,
    );
  }
});

test("classic export/push conversion keeps the approved config and pins transport bytes without relaxing modern identity", async (context) => {
  for (const kind of ["config", "manifest"]) {
    const f = await fixture(context);
    const configuration = await renderWranglerConfiguration({
      expectedName: f.configuration.name,
      outputPath: join(f.root, "classic-export.json"),
      sourcePath: f.configPath,
    });
    const recipe = createHash("sha256")
      .update(JSON.stringify(await imageRecipe(configuration.containers[0], f.root)))
      .digest("hex");
    f.state.labels = {
      "org.opencontainers.image.revision": SHA,
      "org.opencontainers.image.source": "https://github.com/amerged-org/ohmyhost",
      "st.ohmyho.release.recipe": recipe,
    };
    const config = JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { Labels: f.state.labels },
    });
    const configDigest = digest(config);
    const manifestObject = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: configDigest,
        size: Buffer.byteLength(config),
        mediaType: "application/vnd.oci.image.config.v1+json",
      },
      layers: [],
    };
    const exported = JSON.stringify(manifestObject);
    const manifestDigest = digest(exported);
    const transport = JSON.stringify({
      ...manifestObject,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        ...manifestObject.config,
        mediaType: "application/vnd.docker.container.image.v1+json",
      },
    });
    const transportedDigest = digest(transport);
    assert.notEqual(transportedDigest, manifestDigest);
    const descriptor = {
      mediaType: manifestObject.mediaType,
      digest: manifestDigest,
      size: Buffer.byteLength(exported),
      annotations: { "config.digest": configDigest },
    };
    const record = {
      Id: kind === "config" ? configDigest : manifestDigest,
      Os: "linux",
      Architecture: "amd64",
      Config: { Labels: f.state.labels },
      ...(kind === "manifest" ? { Descriptor: descriptor } : {}),
    };
    const proof = captureLocalContainerImageIdentity({
      record,
      metadata: {
        "containerimage.digest": manifestDigest,
        "containerimage.descriptor": descriptor,
      },
      sha: SHA,
      recipe,
    });
    const run = async (command, args) => {
      if (command === "docker" && args[0] === "image") return JSON.stringify([record]);
      if (command === "docker" && args[0] === "tag") return "tagged immutable ID";
      const result = await f.run(command, args);
      if (args[0] === "containers" && args[1] === "push") {
        f.state.images.set(args[2], { config, manifest: transport });
        f.state.publishedImages.set(transportedDigest, { config, manifest: transport });
      }
      return result;
    };
    const options = {
      configuration,
      repositoryRoot: f.root,
      sha: SHA,
      run,
      wrangler: "wrangler",
      fetch: f.fetch,
      env: {},
      configPath: f.configPath,
      imageReceiptPath: f.imageReceiptPath,
      rehearsedImages: { [recipe]: proof },
    };
    if (kind === "manifest") {
      await assert.rejects(prepareContainerRelease(options), /registry manifest\/config differs/u);
      assert.equal(f.state.rollout, null);
      continue;
    }
    const release = await prepareContainerRelease(options);
    assert.ok(release.targets[0].image.endsWith(transportedDigest));
    assert.ok(
      JSON.parse(await readFile(f.imageReceiptPath, "utf8")).images[recipe].endsWith(
        transportedDigest,
      ),
    );
    f.state.deployed = true;
    const version = {
      resources: {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "BUILD",
            class_name: "BuildSandbox",
            namespace_id: "d".repeat(32),
          },
        ],
      },
    };
    const containers = await completeContainerRelease({
      release,
      version,
      wait: async () => {},
      attempts: 2,
    });
    await verifyContainerReleaseReceipt({ ...options, receipt: { sha: SHA, containers }, version });
    const repointedTransport = JSON.stringify({
      ...JSON.parse(transport),
      annotations: { observation: "same config, changed pinned manifest" },
    });
    f.state.publishedImages.set(transportedDigest, { config, manifest: repointedTransport });
    await assert.rejects(
      verifyContainerReleaseReceipt({ ...options, receipt: { sha: SHA, containers }, version }),
      /registry image differs/u,
    );
    f.state.publishedImages.set(transportedDigest, { config, manifest: transport });
    const otherConfig = JSON.stringify({
      ...JSON.parse(config),
      created: "unapproved configuration",
    });
    const otherManifest = JSON.stringify({
      ...JSON.parse(transport),
      config: {
        ...manifestObject.config,
        digest: digest(otherConfig),
        size: Buffer.byteLength(otherConfig),
      },
    });
    f.state.publishedImages.set(transportedDigest, {
      config: otherConfig,
      manifest: otherManifest,
    });
    await assert.rejects(
      verifyContainerReleaseReceipt({ ...options, receipt: { sha: SHA, containers }, version }),
      /registry manifest\/config differs/u,
    );
    assert.equal(f.state.requests.filter(({ method }) => method === "POST").length, 1);
  }
});

test("rehearsed Container release and completed GET-only replay preserve the original source configuration", async (context) => {
  const f = await fixture(context);
  let localImage;
  const run = async (command, args, options) => {
    if (command === "docker" && args[0] === "build") {
      await f.run(command, args, options);
      const config = JSON.stringify({
        architecture: "amd64",
        os: "linux",
        config: { Labels: f.state.labels },
      });
      const configDigest = digest(config);
      const manifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          digest: configDigest,
          size: Buffer.byteLength(config),
          mediaType: "application/vnd.oci.image.config.v1+json",
        },
        layers: [],
      });
      const descriptor = {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: digest(manifest),
        size: Buffer.byteLength(manifest),
        annotations: { "config.digest": configDigest },
      };
      localImage = {
        Id: descriptor.digest,
        Descriptor: descriptor,
        Os: "linux",
        Architecture: "amd64",
        Config: { Labels: f.state.labels },
      };
      await writeFile(
        args[args.indexOf("--metadata-file") + 1],
        JSON.stringify({
          "containerimage.digest": descriptor.digest,
          "containerimage.descriptor": { ...descriptor, annotations: {} },
        }),
        { mode: 0o600 },
      );
      return "local image built";
    }
    if (command === "docker" && args[0] === "image") return JSON.stringify([localImage]);
    if (command === "docker" && args[0] === "tag") {
      f.state.calls.push([command, ...args]);
      return "tagged exact local image";
    }
    if (args.includes("--dry-run")) {
      const configuration = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      const output = args[args.indexOf("--outdir") + 1];
      await mkdir(output, { recursive: true, mode: 0o700 });
      const entry = join(output, "worker.js");
      await writeFile(entry, "export default {};\n");
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({ outputs: { [entry]: { entryPoint: configuration.main } } }),
      );
      return "local worker bundled";
    }
    return f.run(command, args, options);
  };
  const proof = await rehearseWorker({
    step: {
      config: "wrangler.jsonc",
      configSha256: createHash("sha256")
        .update(await readFile(f.configPath))
        .digest("hex"),
      workerName: f.configuration.name,
    },
    repositoryRoot: f.root,
    sha: SHA,
    directory: join(f.root, "..", "rehearsal"),
    run,
    wrangler: "wrangler",
  });
  const configuration = await renderWranglerConfiguration({
    expectedName: f.configuration.name,
    sourcePath: f.configPath,
    outputPath: join(f.root, "source-rendered.json"),
  });
  const original = structuredClone(configuration);
  const receipt = await releaseWorker({
    configPath: f.configPath,
    expectedName: f.configuration.name,
    cwd: f.root,
    run,
    wrangler: "wrangler",
    fetch: f.fetch,
    env: {},
    containerImages: f.imageReceiptPath,
    rehearsal: proof,
    containerWait: async () => {},
    containerAttempts: 2,
  });
  const callsBefore = f.state.calls.length;
  const requestsBefore = f.state.requests.length;
  const verify = () =>
    verifyWorkerReleaseReceipt({
      receipt,
      configuration,
      rehearsal: proof,
      sourceSha: SHA,
      configPath: f.configPath,
      repositoryRoot: f.root,
      run,
      wrangler: "wrangler",
      fetch: f.fetch,
      env: {},
    });
  await verify();
  assert.deepEqual(configuration, original);
  await verify();
  assert.deepEqual(configuration, original);
  assert.ok(configuration.containers[0].image.endsWith("sandbox/Dockerfile"));
  assert.equal(configuration.containers[0].image_build_context, f.root);
  assert.ok(f.state.requests.slice(requestsBefore).every(({ method }) => method === "GET"));
  assert.ok(
    f.state.calls
      .slice(callsBefore)
      .every(
        ([, action, sub]) =>
          !["upload", "deploy", "push", "build"].includes(sub) &&
          !["deploy", "build"].includes(action),
      ),
  );
  assert.equal(
    f.state.calls.filter(([command, action]) => command === "docker" && action === "build").length,
    1,
  );
  assert.equal(
    f.state.calls.filter(([, action, sub]) => action === "versions" && sub === "upload").length,
    1,
  );
  assert.equal(f.state.requests.filter(({ method }) => method === "POST").length, 1);
});

test("Durable Object named images bind to the exact Worker version without a scheduled rollout", async (context) => {
  const f = await fixture(context);
  const declared = f.configuration.containers[0];
  declared.scheduling_policy = "durable_object";
  declared.images = {
    preview: { dockerfile: declared.image, build_context: declared.image_build_context },
  };
  delete declared.image;
  delete declared.image_build_context;
  delete declared.instance_type;
  delete declared.rollout_step_percentage;
  f.state.app.scheduling_policy = "durable_object";
  await writeFile(f.configPath, JSON.stringify(f.configuration));
  const outputPath = join(f.root, "rendered-named.json");
  const configuration = await renderWranglerConfiguration({
    sourcePath: f.configPath,
    expectedName: f.configuration.name,
    outputPath,
  });
  assert.equal(
    configuration.containers[0].images.preview.dockerfile,
    join(f.root, "sandbox/Dockerfile"),
  );
  const release = await prepareContainerRelease({
    configuration,
    repositoryRoot: f.root,
    sha: SHA,
    run: f.run,
    wrangler: "wrangler",
    fetch: f.fetch,
    env: {},
    configPath: outputPath,
    imageReceiptPath: f.imageReceiptPath,
  });
  const image = release.targets[0].image;
  assert.deepEqual(release.configuration.containers[0].images, { preview: { image } });
  assert.equal(release.configuration.containers[0].image, undefined);
  const version = {
    id: VERSION,
    resources: {
      bindings: [
        {
          type: "durable_object_namespace",
          name: "BUILD",
          class_name: "BuildSandbox",
          namespace_id: "d".repeat(32),
        },
      ],
      script_runtime: {
        containers: [
          { name: declared.name, class_name: declared.class_name, images: { preview: image } },
        ],
      },
    },
  };
  const containers = await completeContainerRelease({ release, version });
  assert.deepEqual(containers, [
    {
      applicationId: APP,
      image,
      imageBinding: "preview",
      workerVersionId: VERSION,
      policy: "durable_object",
    },
  ]);
  assert.equal(
    f.state.requests.some((request) => request.path.endsWith("/rollouts")),
    false,
  );
  await verifyContainerReleaseReceipt({
    configuration,
    receipt: { sha: SHA, containers },
    version,
    run: f.run,
    wrangler: "wrangler",
    fetch: f.fetch,
    env: {},
    configPath: outputPath,
    repositoryRoot: f.root,
  });
  version.resources.script_runtime.containers[0].images.preview = image.replace(
    /.$/u,
    image.endsWith("0") ? "1" : "0",
  );
  await assert.rejects(completeContainerRelease({ release, version }), /version-bound image/iu);
  await assert.rejects(
    verifyContainerReleaseReceipt({
      configuration,
      receipt: { sha: SHA, containers },
      version,
      run: f.run,
      wrangler: "wrangler",
      fetch: f.fetch,
      env: {},
      configPath: outputPath,
      repositoryRoot: f.root,
    }),
    /version-bound image/iu,
  );
});

test("the closed Preview bootstrap pins its image before creation and verifies the new namespace and application", async (context) => {
  const f = await fixture(context);
  f.configuration.name = "ohmyho-live-preview-poc-private-fullstack";
  const declared = f.configuration.containers[0];
  declared.name = f.configuration.name;
  declared.class_name = "PreviewSandbox";
  declared.scheduling_policy = "durable_object";
  declared.images = {
    preview: { dockerfile: declared.image, build_context: declared.image_build_context },
  };
  delete declared.image;
  delete declared.image_build_context;
  delete declared.instance_type;
  f.configuration.durable_objects.bindings = [
    { name: "PREVIEW_CONTAINERS", class_name: "PreviewSandbox" },
  ];
  await writeFile(f.configPath, JSON.stringify(f.configuration));
  const outputPath = join(f.root, "rendered-bootstrap.json");
  const configuration = await renderWranglerConfiguration({
    sourcePath: f.configPath,
    expectedName: f.configuration.name,
    outputPath,
  });
  const fetch = async (url, options) =>
    new URL(url).pathname.endsWith("/settings")
      ? new Response(JSON.stringify({ success: false, errors: [{ code: 10007 }] }), { status: 404 })
      : f.fetch(url, options);
  const input = {
    configuration,
    repositoryRoot: f.root,
    sha: SHA,
    run: f.run,
    wrangler: "wrangler",
    fetch,
    env: {},
    configPath: outputPath,
    imageReceiptPath: f.imageReceiptPath,
    allowContainerBootstrap: true,
  };
  const release = await prepareContainerRelease(input);
  assert.equal(release.targets[0].bootstrap, true);
  assert.equal(release.targets[0].namespaceId, null);
  assert.ok(JSON.parse(await readFile(f.imageReceiptPath, "utf8")).images);
  const image = release.targets[0].image;
  f.state.app.name = declared.name;
  f.state.app.scheduling_policy = "durable_object";
  const version = {
    id: VERSION,
    resources: {
      bindings: [
        {
          type: "durable_object_namespace",
          name: "PREVIEW_CONTAINERS",
          class_name: "PreviewSandbox",
          namespace_id: "d".repeat(32),
        },
      ],
      script_runtime: {
        containers: [
          { name: declared.name, class_name: declared.class_name, images: { preview: image } },
        ],
      },
    },
  };
  assert.equal((await completeContainerRelease({ release, version }))[0].applicationId, APP);
  const proofPath = `${f.imageReceiptPath}.development`;
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  const invalidProof = structuredClone(proof);
  invalidProof.containers[0].workerVersionId = "not-a-worker-version";
  await writeFile(proofPath, JSON.stringify(invalidProof));
  await assert.rejects(prepareContainerRelease(input), /Development approval/iu);
  await writeFile(proofPath, JSON.stringify(proof));
  await assert.rejects(prepareContainerRelease(input), /one existing application/iu);
  await assert.rejects(
    prepareContainerRelease({
      ...input,
      configuration: { ...configuration, name: "foreign-production" },
    }),
    /closed Preview profile/iu,
  );
});
