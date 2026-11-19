/* global URL, fetch */
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { configureFixture, proxyForVite } from "../container/driver.mjs";
import { installNextRequestOrigin } from "../container/next-request-hook.mjs";
import { encodeValue } from "../../capabilities/wire.mjs";

const fixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/cloudflare-preview/", import.meta.url),
);
const names = [
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
];

test("all public fixtures receive local database bindings and only selected public mail markers", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "preview-config-test-"));
  const variables = {
    OHMYHOST_MAIL_GATEWAY_URL: "https://qa-mail.invalid",
    OHMYHOST_MAIL_KEY: "public-marker",
    OHMYHOST_PROJECT_ID: "public-project",
    PREVIEW_MAIL_RECIPIENT: "qa@example.invalid",
    PREVIEW_ACCEPTANCE_KEY: "public-marker",
    SPIKE_CONTROL_TOKEN: "synthetic-must-not-enter-guest",
  };
  try {
    for (const fixture of names) {
      const directory = join(temporary, fixture);
      await cp(join(fixtureRoot, fixture), directory, { recursive: true });
      const environment = { ...variables, SPIKE_QA_FIXTURE: fixture };
      const selected = await configureFixture(
        directory,
        fixture,
        "fixture.preview.test",
        environment,
        "/synthetic/runtime",
      );
      const application = JSON.parse(await readFile(selected.configPath, "utf8"));
      const binding = JSON.parse(await readFile(selected.bindingsPath, "utf8"));
      assert.deepEqual(application.services[0], {
        binding: "OHMYHOST_DATABASE",
        service: "spike-bindings",
        entrypoint: "Database",
      });
      assert.equal(
        application.services.some((service) => service.binding === "OHMYHOST_AUTH"),
        fixture === "next-native-auth",
      );
      assert.equal(JSON.stringify(application).includes("synthetic-must-not-enter-guest"), false);
      assert.deepEqual(
        application.vars,
        fixture === "next-app-mail"
          ? Object.fromEntries(
              Object.entries(variables).filter(([key]) => key !== "SPIKE_CONTROL_TOKEN"),
            )
          : {},
      );
      assert.equal(binding.main, "/synthetic/runtime/bindings-worker.mjs");
      assert.equal(Boolean(binding.services), selected.staticVite);
      if (fixture.startsWith("next-")) {
        assert.deepEqual(
          JSON.parse(await readFile(join(directory, "wrangler.jsonc"), "utf8")),
          application,
        );
        await configureFixture(
          directory,
          fixture,
          "fixture.preview.test",
          environment,
          "/synthetic/runtime",
        );
        const source = await readFile(join(directory, "next.config.ts"), "utf8");
        assert.equal(source.split("initOpenNextCloudflareForDev({").length, 2);
        assert.ok(source.includes("allowedDevOrigins"));
      }
      if (fixture === "tanstack-start")
        assert.match(await readFile(join(directory, "vite.config.ts"), "utf8"), /configPath:/u);
      if (fixture === "astro-edge") {
        assert.match(await readFile(join(directory, "astro.config.mjs"), "utf8"), /configPath:/u);
        const handler = join(directory, "src/notes-handler.ts");
        const edited = `${await readFile(handler, "utf8")}\n// synthetic edit retained\n`;
        await writeFile(handler, edited);
        await configureFixture(
          directory,
          fixture,
          "fixture.preview.test",
          environment,
          "/synthetic/runtime",
        );
        assert.equal(await readFile(handler, "utf8"), edited);
      }
      const characterization = await configureFixture(directory, fixture, "fixture.preview.test");
      assert.equal(characterization.qa, false);
      assert.equal(characterization.multiWorker, false);
      assert.deepEqual(
        JSON.parse(await readFile(characterization.configPath, "utf8")).services,
        [],
      );
      await assert.rejects(
        configureFixture(directory, fixture, "fixture.preview.test", { SPIKE_QA_FIXTURE: "other" }),
        /preview_fixture_configuration_invalid/u,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Astro proxy validates the public Origin and translates loopback redirects and cookies", async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${upstream.address().port}/after?ok=1`,
      "set-cookie": ["synthetic=1; Domain=127.0.0.1; Path=/"],
      "x-observed-origin": request.headers.origin ?? "missing",
      "x-observed-forwarded": request.headers["x-forwarded-proto"] ?? "missing",
    });
    response.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const appPort = upstream.address().port;
  const proxy = proxyForVite("fixture.preview.test", { astro: true, appPort });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${proxy.address().port}/api/notes`;
  try {
    for (const origin of ["https://evil.test", `http://127.0.0.1:${appPort}`]) {
      const rejected = await fetch(url, {
        method: "POST",
        headers: { origin },
        redirect: "manual",
      });
      assert.equal(rejected.status, 403);
    }
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { origin: "https://fixture.preview.test", "x-forwarded-proto": "https" },
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://fixture.preview.test/after?ok=1");
    assert.equal(response.headers.get("set-cookie"), "synthetic=1; Path=/");
    assert.equal(response.headers.get("x-observed-origin"), "https://fixture.preview.test");
    assert.equal(response.headers.get("x-observed-forwarded"), "https");
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});

test("Next request origin patch stays inside the disposable workspace and is repeatable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-next-origin-test-"));
  try {
    const app = join(directory, "app");
    const serverDir = join(app, "node_modules/next/dist/server");
    const server = join(serverDir, "next-server.js");
    await mkdir(serverDir, { recursive: true });
    await writeFile(
      server,
      `module.exports.default=class { attachRequestMeta(request) { request[Symbol.for('NextInternalRequestMeta')]={initURL:'http://127.0.0.1:3001/',initProtocol:'http'}; return 1; } };`,
    );
    await installNextRequestOrigin(app, "https://fixture.preview.test");
    await installNextRequestOrigin(app, "https://fixture.preview.test");
    const source = await readFile(server, "utf8");
    assert.equal(source.split("preview-spike-next-origin-hook").length, 2);
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const Next=require(${JSON.stringify(server)}).default;const request={url:'http://127.0.0.1:3001/api/notes?x=1'};new Next().attachRequestMeta(request);process.stdout.write(JSON.stringify(request[Symbol.for('NextInternalRequestMeta')]));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      initURL: "https://fixture.preview.test/api/notes?x=1",
      initProtocol: "https",
    });
    const external = join(directory, "external.js");
    await writeFile(external, "attachRequestMeta");
    await rm(server);
    await symlink(external, server);
    await assert.rejects(
      installNextRequestOrigin(app, "https://fixture.preview.test"),
      /preview_next_runtime_invalid/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real workerd RPC binds database and auth through synthetic outbound only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-bindings-test-"));
  let runtime;
  try {
    await mkdir(join(directory, "capabilities"));
    await cp(
      fileURLToPath(new URL("../container/bindings-worker.mjs", import.meta.url)),
      join(directory, "bindings-worker.mjs"),
    );
    for (const file of ["guest-binding.mjs", "transport.mjs", "wire.mjs"])
      await cp(
        fileURLToPath(new URL(`../../capabilities/${file}`, import.meta.url)),
        join(directory, "capabilities", file),
      );
    const result = await build({
      entryPoints: [join(directory, "bindings-worker.mjs")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
    });
    const database = encodeValue({ command: "SELECT", rowCount: 1, rows: [{ ok: true }] });
    const transaction = encodeValue([{ command: "INSERT", rowCount: 1, rows: [] }]);
    const session = encodeValue({
      user: { id: "qa-user", email: "qa@example.invalid" },
      session: { id: "qa-session", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "guest",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: "guest.mjs",
                contents: `export default { async fetch(request, env) { const db=await env.DB.query({text:'SELECT 1',values:[]}); const tx=await env.DB.transaction([{text:'INSERT',values:[]}]); const auth=await env.AUTH.validateSession({cookie:new URL(request.url).searchParams.get('cookie')}); return Response.json({db,tx,auth}); } };`,
              },
            ],
            serviceBindings: {
              DB: { name: "bindings", entrypoint: "Database" },
              AUTH: { name: "bindings", entrypoint: "Auth" },
            },
          },
          {
            name: "bindings",
            compatibilityDate: "2026-08-24",
            modules: [
              { type: "ESModule", path: "bindings.mjs", contents: result.outputFiles[0].text },
            ],
            outboundService: "synthetic",
          },
          {
            name: "synthetic",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: "synthetic.mjs",
                contents: `export default { async fetch(request) { const url=new URL(request.url); if(url.hostname!=='preview.capabilities'||request.method!=='POST') return new Response(null,{status:403}); if(url.pathname==='/database/query') return new Response(${JSON.stringify(database)}); if(url.pathname==='/database/transaction') return new Response(${JSON.stringify(transaction)}); if(url.pathname==='/native-auth/session' && request.headers.get('cookie')==='qa=1' && (await request.text())==='') return new Response(${JSON.stringify(session)}); return new Response(null,{status:403}); } };`,
              },
            ],
          },
        ],
      }),
    );
    const response = await runtime.dispatchFetch("http://fixture.preview.test/?cookie=qa%3D1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      db: { command: "SELECT", rowCount: 1, rows: [{ ok: true }] },
      tx: [{ command: "INSERT", rowCount: 1, rows: [] }],
      auth: {
        user: { id: "qa-user", email: "qa@example.invalid" },
        session: { id: "qa-session", expiresAt: "2099-01-01T00:00:00.000Z" },
      },
    });
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
