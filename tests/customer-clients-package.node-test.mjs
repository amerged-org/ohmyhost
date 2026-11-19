/* global process */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  archiveName,
  keyringShrinkwrap,
  packageCustomerClient,
} from "../scripts/package-customer-client.mjs";

const run = promisify(execFile);
// Node 24.6's bundled npm 11.5.1 crashes in Arborist's optional-peer graph. Use the exact
// repository-pinned installer without changing global npm or disabling peer validation.
const npmCli = fileURLToPath(new URL("../node_modules/npm/bin/npm-cli.js", import.meta.url));

test(
  "the packaged runtime alone installs with strict pnpm peers and imports Native Auth",
  { timeout: 120_000 },
  async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-runtime-pnpm-"));
    try {
      const archive = await packageCustomerClient("runtime", join(rootDirectory, "package"));
      for (const automaticPeers of [true, false]) {
        const directory = join(rootDirectory, String(automaticPeers));
        await mkdir(directory);
        const repository = JSON.parse(
          await readFile(new URL("../package.json", import.meta.url), "utf8"),
        );
        const manifest = {
          private: true,
          type: "module",
          packageManager: repository.packageManager,
          dependencies: { "@amerged/ohmyhost-runtime": `file:${archive}` },
        };
        await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
        await run(
          "pnpm",
          [
            "install",
            "--ignore-scripts",
            "--strict-peer-dependencies",
            `--config.auto-install-peers=${automaticPeers}`,
          ],
          { cwd: directory, timeout: 60_000 },
        );
        const installed = JSON.parse(
          await readFile(
            join(directory, "node_modules/@amerged/ohmyhost-runtime/package.json"),
            "utf8",
          ),
        );
        assert.deepEqual(installed.dependencies, { "better-auth": "1.7.7", kysely: "0.29.5" });
        assert.equal(installed.peerDependencies.kysely, "^0.29.5");
        assert.equal(installed.peerDependenciesMeta.kysely.optional, true);
        const tree = JSON.parse(
          (await run("pnpm", ["list", "kysely", "--depth", "100", "--json"], { cwd: directory }))
            .stdout,
        );
        const versions = new Set();
        const visit = (entry) => {
          for (const [name, dependency] of Object.entries(entry.dependencies ?? {})) {
            if (name === "kysely") versions.add(dependency.version);
            visit(dependency);
          }
        };
        tree.forEach(visit);
        assert.equal(versions.size, 1);
        const [version] = versions;
        assert.match(version, /^0\.29\./u);
        assert.ok(Number(version.split(".")[2]) >= 5);
        await run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import assert from "node:assert/strict";
import { createNativeAuthBrowser } from "@amerged/ohmyhost-runtime/auth-browser";
import { createNativeAuthServer, NativeAuthRequiredError } from "@amerged/ohmyhost-runtime/auth-server";
assert.equal(typeof createNativeAuthBrowser, "function");
assert.throws(createNativeAuthBrowser, /requires a browser/);
const server = createNativeAuthServer({ validateSession: async () => null });
const request = new Request("https://example.test/protected");
assert.equal(await server.getSession(request), null);
await assert.rejects(server.requireUser(request), NativeAuthRequiredError);`,
          ],
          { cwd: directory },
        );
        assert.deepEqual(
          JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
          manifest,
        );
      }
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "the delivered clients and customer runtime libraries install without a platform checkout",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-cli-acceptance-"));
    let child;
    let lines;
    const pending = new Map();
    try {
      const archive = await packageCustomerClient("cli", join(directory, "package"));
      const mcpArchive = await packageCustomerClient("mcp", join(directory, "package"));
      const sdkArchive = await packageCustomerClient("sdk", join(directory, "package"));
      const runtimeArchive = await packageCustomerClient("runtime", join(directory, "package"));
      const authArchive = await packageCustomerClient("auth", join(directory, "package"));
      const prefix = join(directory, "customer");
      const pinnedNpm = JSON.parse(
        await readFile(new URL("../node_modules/npm/package.json", import.meta.url), "utf8"),
      );
      const repository = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      );
      assert.equal(pinnedNpm.version, repository.devDependencies.npm);
      await run(
        process.execPath,
        [
          npmCli,
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org",
          "--fetch-retries=0",
          "--fetch-timeout=15000",
          "--prefix",
          prefix,
          archive,
          mcpArchive,
          sdkArchive,
          runtimeArchive,
          authArchive,
        ],
        // The cold registry install exceeded 30 seconds on CI run 36488212135.
        { cwd: directory, timeout: 120_000 },
      );
      const installed = join(prefix, "node_modules/@amerged/ohmyhost-cli");
      const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
      assert.deepEqual(Object.keys(manifest.dependencies), ["@napi-rs/keyring"]);
      const bin = join(installed, manifest.bin.ohmyhost);
      const version = await run(process.execPath, [bin, "--version"], { cwd: directory });
      assert.equal(JSON.parse(version.stdout).status, "succeeded");
      assert.equal(JSON.parse(version.stdout).cli_version, manifest.version);
      if (process.platform !== "win32") {
        const command = await run(join(prefix, "node_modules/.bin/ohmyhost"), ["--version"], {
          cwd: directory,
        });
        assert.equal(JSON.parse(command.stdout).status, "succeeded");
      }
      const help = await run(process.execPath, [bin, "--help"], { cwd: directory });
      assert.match(help.stdout, /deploy/);
      const commands = JSON.parse(help.stdout).commands.map((item) => item.command);
      assert.ok(commands.includes("export create"));
      assert.ok(
        ["token create", "token list", "token revoke"].every((command) =>
          commands.includes(command),
        ),
      );
      const projectHelp = await run(process.execPath, [bin, "project", "create", "--help"], {
        cwd: directory,
      });
      assert.deepEqual(JSON.parse(projectHelp.stdout).commands, [
        {
          command: "project create",
          usage:
            "ohmyhost project create --organization ULID --name NAME [--include-development-environment true|false] [--data-mode shared|isolated] [--dev-access-mode protected|public] [--region us|eu] --idempotency-key KEY --json (Dev defaults to included; add it later with project dev add. Data mode defaults to shared; later changes do not copy data. The region is chosen once: us defaults to US; eu selects EU database, new files and builds; the customer API cannot change region later)",
        },
      ]);
      const feedbackHelp = await run(process.execPath, [bin, "feedback", "submit", "--help"], {
        cwd: directory,
      });
      assert.match(feedbackHelp.stdout, /--description/u);
      const listing = await run("tar", ["-tzf", archive]);
      assert.ok(
        listing.stdout
          .trim()
          .split("\n")
          .every(
            (name) =>
              name === "package/package.json" ||
              name === "package/npm-shrinkwrap.json" ||
              name.startsWith("package/dist/"),
          ),
      );
      const mcp = join(prefix, "node_modules/@amerged/ohmyhost-mcp");
      const mcpManifest = JSON.parse(await readFile(join(mcp, "package.json"), "utf8"));
      assert.deepEqual(Object.keys(mcpManifest.dependencies), ["@napi-rs/keyring"]);
      assert.ok(!JSON.stringify(mcpManifest).includes("workspace:"));
      const mcpListing = await run("tar", ["-tzf", mcpArchive]);
      assert.ok(
        mcpListing.stdout
          .trim()
          .split("\n")
          .every(
            (name) =>
              name === "package/package.json" ||
              name === "package/npm-shrinkwrap.json" ||
              name.startsWith("package/dist/"),
          ),
      );
      child = spawn(process.execPath, [join(mcp, mcpManifest.bin["ohmyhost-mcp"])], {
        cwd: directory,
        env: { OHMYHOST_ENVIRONMENT: "production" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.resume();
      lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        const callback = pending.get(message.id);
        if (!callback) return;
        pending.delete(message.id);
        clearTimeout(callback.timer);
        if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
        else callback.resolve(message.result);
      });
      let sequence = 0;
      const request = (method, params) =>
        new Promise((resolveResult, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => reject(new Error("MCP package did not respond")), 5000);
          pending.set(id, { resolve: resolveResult, reject, timer });
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      const serverIdentity = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "standalone-customer", version: "1" },
      });
      assert.equal(
        serverIdentity.serverInfo.version,
        JSON.parse(
          await readFile(join(prefix, "node_modules/@amerged/ohmyhost-mcp/package.json"), "utf8"),
        ).version,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const tools = await request("tools/list", {});
      assert.match(
        tools.tools.find((tool) => tool.name === "organization_use").description,
        /OHMYHOST_ENVIRONMENT=production ohmyhost login --json/u,
      );
      assert.ok(
        ["organization_create", "organization_list", "organization_use"].every((name) =>
          tools.tools.some((tool) => tool.name === name),
        ),
      );
      assert.ok(tools.tools.some((tool) => tool.name === "feedback_submit"));
      assert.ok(tools.tools.some((tool) => tool.name === "project_export_create"));
      assert.ok(
        ["token_create", "tokens_list", "token_revoke"].every((name) =>
          tools.tools.some((tool) => tool.name === name),
        ),
      );
      const resources = await request("resources/list", {});
      assert.ok(resources.resources.length > 0);
      const skill = await request("resources/read", { uri: resources.resources[0].uri });
      assert.match(skill.contents[0].text, /ohmyhost/u);
      const sdkRoot = join(prefix, "node_modules/@amerged/ohmyhost-sdk");
      const sdkManifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
      assert.deepEqual(sdkManifest.exports, {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      });
      assert.ok(!JSON.stringify(sdkManifest).includes("workspace:"));
      const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
      assert.equal(typeof sdk.createClient, "function");
      assert.equal(typeof sdk.getCurrentIdentity, "function");
      assert.equal(typeof sdk.submitFeedback, "function");
      assert.equal(typeof sdk.createProjectExport, "function");
      const runtimeRoot = join(prefix, "node_modules/@amerged/ohmyhost-runtime");
      const authRoot = join(prefix, "node_modules/@amerged/ohmyhost-auth");
      const runtime = await import(pathToFileURL(join(runtimeRoot, "dist/index.js")).href);
      const auth = await import(pathToFileURL(join(authRoot, "dist/index.js")).href);
      assert.equal(typeof runtime.createTransactionalMailClient, "function");
      assert.equal(typeof auth.createCustomerAuthOptions, "function");
      const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
      assert.ok(runtimeManifest.exports["./database-kysely"]);
      assert.ok(runtimeManifest.exports["./database-rls"]);
      const rls = await import(pathToFileURL(join(runtimeRoot, "dist/database-rls.js")).href);
      assert.deepEqual(
        rls.normalizeRlsIdentity({ subject: "user_packaged", claims: { team: "one" } }),
        {
          sub: "user_packaged",
          role: "authenticated",
          team: "one",
        },
      );
      assert.equal(runtimeManifest.peerDependencies.kysely, "^0.29.5");
      assert.equal(runtimeManifest.peerDependenciesMeta.kysely.optional, true);
      for (const packageRoot of [runtimeRoot, authRoot]) {
        const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
        assert.ok(!JSON.stringify(manifest).includes("workspace:"));
        assert.ok(!Object.hasOwn(manifest.dependencies ?? {}, "@ohmyhost/platform"));
        for (const entrypoint of Object.values(manifest.exports)) {
          assert.equal(typeof entrypoint.types, "string");
          assert.equal(typeof entrypoint.import, "string");
          assert.equal(entrypoint.source, undefined);
        }
      }
      const consumer = join(prefix, "consumer.mts");
      await writeFile(
        consumer,
        `import { createClient, getCurrentIdentity, type CurrentIdentity } from "@amerged/ohmyhost-sdk";
import { createTransactionalMailClient } from "@amerged/ohmyhost-runtime/mail";
import { createPrivateDatabaseClient, type CustomerDatabaseBinding } from "@amerged/ohmyhost-runtime/database";
import { normalizeRlsIdentity } from "@amerged/ohmyhost-runtime/database-rls";
import { createMailGatewayEmailSender } from "@amerged/ohmyhost-auth";
const client = createClient({ baseUrl: "https://app.ohmyho.st" });
const identity: CurrentIdentity = { actor_id: "user:customer", organization_ids: [], email: "customer@example.test", organizations: [] };
const projectId: Parameters<typeof createMailGatewayEmailSender>[0]["projectId"] = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
void createTransactionalMailClient; void createMailGatewayEmailSender; void projectId;
async function scopedQuery(binding: CustomerDatabaseBinding) {
  return createPrivateDatabaseClient(binding).withRls({ subject: "user_packaged" }, async tx =>
    (await tx.query({text: "SELECT 1", values: []})).rows);
}
void scopedQuery; void normalizeRlsIdentity;
void identity; void getCurrentIdentity; void client;\n`,
      );
      const compiler = fileURLToPath(
        new URL("../node_modules/typescript/bin/tsc", import.meta.url),
      );
      await run(
        process.execPath,
        [
          compiler,
          "--strict",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--noEmit",
          "--types",
          "node",
          consumer,
        ],
        { cwd: prefix },
      );
    } finally {
      for (const callback of pending.values()) clearTimeout(callback.timer);
      child?.stdin.end();
      child?.kill();
      lines?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("website archives carry only the owned npm names, never the unclaimed @ohmyhost scope", () => {
  assert.equal(archiveName("cli"), "@amerged/ohmyhost-cli");
  for (const kind of ["cli", "mcp", "sdk", "runtime", "auth"]) {
    assert.match(archiveName(kind), /^@amerged\/ohmyhost-[a-z]+$/u);
  }
  assert.throws(() => archiveName("other"), /unknown client/u);
});

test("the native keyring a client ships is pinned to the lockfile's integrity hashes", async () => {
  const lock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const shrinkwrap = keyringShrinkwrap(lock, "1.3.0");
  const keyring = shrinkwrap.packages["node_modules/@napi-rs/keyring"];
  assert.equal(keyring.version, "1.3.0");
  assert.equal(
    keyring.integrity,
    lock.match(
      /"@napi-rs\/keyring@1\.3\.0":\n {4}resolution:\n {6}\{\n {8}integrity: (sha512-[^,\n]+)/u,
    )?.[1],
  );
  const platforms = Object.keys(shrinkwrap.packages).filter((path) =>
    path.startsWith("node_modules/@napi-rs/keyring-"),
  );
  assert.ok(platforms.length >= 2);
  for (const path of platforms) assert.match(shrinkwrap.packages[path].integrity, /^sha512-/u);
  // The platform constraints the lockfile records travel with each binary, so npm installs only the host's own.
  assert.deepEqual(shrinkwrap.packages["node_modules/@napi-rs/keyring-darwin-arm64"].os, [
    "darwin",
  ]);
  assert.deepEqual(shrinkwrap.packages["node_modules/@napi-rs/keyring-darwin-arm64"].cpu, [
    "arm64",
  ]);
  assert.deepEqual(shrinkwrap.packages["node_modules/@napi-rs/keyring-linux-x64-musl"].libc, [
    "musl",
  ]);
  assert.equal(keyring.os, undefined);
});

test(
  "packed client archives take the download names the public site serves",
  { timeout: 180_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-download-names-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const version = JSON.parse(
      await readFile(new URL("../apps/product-cli/package.json", import.meta.url), "utf8"),
    ).version;
    // The site serves a download only when its name is in this list (isClientDownload in customer-entry.ts).
    const entry = await readFile(
      new URL("../apps/public-site/src/customer-entry.ts", import.meta.url),
      "utf8",
    );
    const served = [
      ...entry.match(/const CLIENT_PACKAGES = \[([^\]]+)\]/u)[1].matchAll(/"([^"]+)"/gu),
    ].map(([, name]) => `ohmyhost-${name}-${version}.tgz`);
    assert.equal(served.length, 5);
    for (const kind of ["cli", "mcp"]) {
      const archive = await packageCustomerClient(kind, directory);
      assert.ok(served.includes(basename(archive)), basename(archive));
      const manifest = JSON.parse(
        (await run("tar", ["-xzOf", archive, "package/package.json"])).stdout,
      );
      assert.equal(manifest.name, archiveName(kind));
      // The shrinkwrap pins the keyring's platform packages, so npm reads it from the installed archive.
      const listing = (await run("tar", ["-tzf", archive])).stdout.trim().split("\n");
      assert.ok(listing.includes("package/npm-shrinkwrap.json"), listing.join(" "));
    }
  },
);

test("the OAuth client cohort uses a new shared release and matching public distribution path", async () => {
  const names = [
    "apps/product-cli",
    "apps/mcp",
    "packages/sdk-ts",
    "packages/customer-runtime",
    "packages/customer-auth-better-auth",
  ];
  const versions = await Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(new URL(`../${name}/package.json`, import.meta.url), "utf8"))
          .version,
    ),
  );
  assert.deepEqual(versions, Array(5).fill("0.1.70"));
  const [entry, release] = await Promise.all(
    ["customer-entry.ts", "generated-client-release.ts"].map((file) =>
      readFile(new URL(`../apps/public-site/src/${file}`, import.meta.url), "utf8"),
    ),
  );
  assert.ok(release.includes(`export const CLIENT_RELEASE = "${versions[0]}"`));
  assert.ok(entry.includes('import { CLIENT_RELEASE } from "./generated-client-release.js"'));
  assert.ok(entry.includes("export const RELEASE_PATH = `/releases/${CLIENT_RELEASE}`"));
});
