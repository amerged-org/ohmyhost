/* global Buffer, Response */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";

import {
  prepareMcpRepository,
  renderMcpReadme,
  renderRegistryWorkflow,
} from "../scripts/prepare-mcp-repository.mjs";
import {
  copyClientSourceFiles,
  copyClientWorkspaceSource,
  publicPackageMetadata,
  readBundledLicenseNotices,
  requireReleaseSource,
} from "../scripts/prepare-npm-client-release.mjs";
import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const harnessSetup = await readFile(
  join(repositoryRoot, "skills/ohmyhost-get-started/references/harness-setup.md"),
  "utf8",
);
const catalog = JSON.parse(
  await readFile(join(repositoryRoot, "apps/public-site/src/generated-mcp-tools.json"), "utf8"),
);
const SOURCE = "e3068bd04a2f752770f0f29a88f902b97e4b451c";
const TARBALL = "https://registry.npmjs.org/@amerged/ohmyhost-mcp/-/ohmyhost-mcp-0.1.21.tgz";
const roots = [];
const env = { ...process.env, COPYFILE_DISABLE: "1" };

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

const PACKAGE_FILES = {
  "package.json": JSON.stringify({
    name: "@amerged/ohmyhost-mcp",
    version: "0.1.21",
    license: "Apache-2.0",
  }),
  LICENSE: "Apache License 2.0\n",
  NOTICE: "ohmyho.st client software\n",
  "README.md": "# @amerged/ohmyhost-mcp\n",
  "THIRD_PARTY_NOTICES.md": "# Bundled third-party notices\n",
  "dist/stdio-main.js": "console.log('bundle');\n",
  "dist/chunk-TEST.js": "export {};\n",
  "src/apps/mcp/package.json": JSON.stringify({
    name: "@ohmyhost/mcp",
    version: "0.1.21",
    license: "Apache-2.0",
  }),
  "src/apps/product-cli/package.json": JSON.stringify({
    name: "@ohmyhost/product-cli",
    version: "0.1.21",
    license: "Apache-2.0",
  }),
  "src/packages/contracts/package.json": JSON.stringify({
    name: "@ohmyhost/contracts",
    version: "0.0.0",
    license: "Apache-2.0",
  }),
  "src/packages/sdk-ts/package.json": JSON.stringify({
    name: "@ohmyhost/sdk-ts",
    version: "0.1.21",
    license: "Apache-2.0",
  }),
  "src/packages/workos-auth-contracts/package.json": JSON.stringify({
    name: "@ohmyhost/workos-auth-contracts",
    version: "0.0.0",
    license: "Apache-2.0",
  }),
  "src/packages/agent-skills/package.json": JSON.stringify({
    name: "@ohmyhost/agent-skills",
    version: "0.0.0",
    license: "Apache-2.0",
  }),
  "src/apps/mcp/src/index.ts": "export const server = 1;\n",
  "src/packages/agent-skills/src/index.ts": "export const skills = [];\n",
  "src/packages/contracts/src/openapi.json": "{}\n",
  "src/packages/contracts/src/framework-build-script.mjs": "export const supported = true;\n",
  "src/packages/contracts/src/framework-build-script.d.mts":
    "export declare const supported: boolean;\n",
};

// The exact member list of the published 0.1.39 package under src/packages/postgres-bridge.
const BRIDGE_FILES = {
  LICENSE: "Apache License 2.0\n",
  NOTICE:
    "PostgreSQL WebSocket bridge adapted from cloudflare-postgres packages/cli. Upstream license: Apache-2.0.\n",
  "package.json": JSON.stringify({
    name: "@ohmyhost/postgres-bridge",
    version: "0.0.0",
    private: true,
    license: "Apache-2.0",
  }),
  "src/auth.ts": "export const AUTH_BYTES = 64 * 1024;\n",
  "src/bridge.ts": "export const startBridge = () => undefined;\n",
  "src/index.ts": 'export { startBridge } from "./bridge.js";\n',
  "src/options.ts": "export const validateOptions = () => undefined;\n",
};
const PACKAGE_FILES_WITH_BRIDGE = {
  ...PACKAGE_FILES,
  ...Object.fromEntries(
    Object.entries(BRIDGE_FILES).map(([file, text]) => [
      `src/packages/postgres-bridge/${file}`,
      text,
    ]),
  ),
};

async function makeTarball(parent, files) {
  const directory = join(parent, `pack-${Math.random().toString(16).slice(2)}`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, "package", path)), { recursive: true });
    await writeFile(join(directory, "package", path), text);
  }
  const archive = join(directory, "package.tgz");
  execFileSync("tar", ["-czf", archive, "-C", directory, "package"], { env });
  return readFile(archive);
}

const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function registry(bytes, overrides = {}) {
  const metadata = {
    name: "@amerged/ohmyhost-mcp",
    version: "0.1.21",
    license: "Apache-2.0",
    dist: { integrity: integrityOf(bytes), tarball: TARBALL },
    ...overrides.metadata,
  };
  const latest = { ...metadata, ...overrides.latest };
  return async (url) => {
    const href = String(url);
    if (href === "https://registry.npmjs.org/@amerged%2Fohmyhost-mcp/0.1.21")
      return Response.json(metadata);
    if (href === "https://registry.npmjs.org/@amerged%2Fohmyhost-mcp/latest")
      return Response.json(latest);
    if (href === metadata.dist.tarball) {
      if (overrides.tarballFails) throw new Error("tarball must not be downloaded");
      return new Response(overrides.served ?? bytes);
    }
    return new Response("", { status: 404 });
  };
}

async function makeClone(
  parent,
  { origin = "https://github.com/amerged-org/ohmyhost-mcp.git", release } = {},
) {
  const clone = join(parent, `clone-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(clone, "src/apps/mcp"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: clone, env, encoding: "utf8" });
  git("init", "--quiet");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  // Temporary fixtures own no background Git work that could race their teardown.
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  git("config", "core.fsmonitor", "false");
  git("config", "user.name", "Mirror Test");
  git("config", "user.email", "mirror@example.com");
  git("remote", "add", "origin", origin);
  await writeFile(join(clone, "src/apps/mcp/removed.ts"), "export {};\n");
  await writeFile(join(clone, ".gitattributes"), "* text=auto\n");
  await writeFile(
    join(clone, "release.json"),
    `${JSON.stringify(release ?? { version: "0.1.20", npm: { integrity: "sha512-old" } })}\n`,
  );
  git("add", "-A");
  git("commit", "--quiet", "-m", "Mirror 0.1.20");
  return { clone, git };
}

async function listTree(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTree(path, base)));
    else files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort();
}

test("the MCP mirror equals the registry tarball with a generated README and release stamp", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-mcp-mirror-test-"));
  roots.push(parent);
  const bytes = await makeTarball(parent, PACKAGE_FILES);
  const { clone, git } = await makeClone(parent);
  const input = {
    clone,
    version: "0.1.21",
    sourceCommit: SOURCE,
    harnessSetup,
    catalog,
    fetch: registry(bytes),
    now: () => new Date("2026-09-26T10:00:00.000Z"),
  };

  const result = await prepareMcpRepository(input);
  assert.deepEqual(result, {
    clone,
    version: "0.1.21",
    sourceCommit: SOURCE,
    integrity: integrityOf(bytes),
    sha256: sha256(bytes),
    mirrored: 15,
    omitted: 3,
    changed: true,
  });
  assert.deepEqual(await listTree(clone), [
    ".gitattributes",
    ".github/workflows/publish-registry.yml",
    "LICENSE",
    "NOTICE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "release.json",
    "server.json",
    "src/apps/mcp/package.json",
    "src/apps/mcp/src/index.ts",
    "src/apps/product-cli/package.json",
    "src/packages/agent-skills/package.json",
    "src/packages/agent-skills/src/index.ts",
    "src/packages/contracts/package.json",
    "src/packages/contracts/src/framework-build-script.d.mts",
    "src/packages/contracts/src/framework-build-script.mjs",
    "src/packages/contracts/src/openapi.json",
    "src/packages/sdk-ts/package.json",
    "src/packages/workos-auth-contracts/package.json",
  ]);
  for (const path of [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "src/apps/mcp/package.json",
    "src/apps/mcp/src/index.ts",
    "src/apps/product-cli/package.json",
    "src/packages/agent-skills/package.json",
    "src/packages/agent-skills/src/index.ts",
    "src/packages/contracts/package.json",
    "src/packages/contracts/src/framework-build-script.d.mts",
    "src/packages/contracts/src/framework-build-script.mjs",
    "src/packages/contracts/src/openapi.json",
    "src/packages/sdk-ts/package.json",
    "src/packages/workos-auth-contracts/package.json",
  ])
    assert.equal(await readFile(join(clone, path), "utf8"), PACKAGE_FILES[path], path);
  assert.equal(await readFile(join(clone, ".gitattributes"), "utf8"), "* text=auto\n");

  const readme = await readFile(join(clone, "README.md"), "utf8");
  assert.equal(readme, renderMcpReadme({ version: "0.1.21", harnessSetup, catalog }));
  assert.match(readme, /Version 0\.1\.21/u);
  assert.match(readme, /npm install --global @amerged\/ohmyhost-cli @amerged\/ohmyhost-mcp/u);
  assert.match(readme, /^## Tools$/mu);
  for (const tool of catalog.tools) assert.match(readme, new RegExp(`^- \`${tool.name}\`: `, "mu"));
  assert.equal(
    readme.split("\n").filter((line) => line.startsWith("- `")).length >= catalog.tools.length,
    true,
  );
  for (const line of harnessSetup.split("\n").filter((row) => row.startsWith("|")))
    assert.ok(readme.includes(line), line);
  assert.ok(
    readme.includes(
      /Authenticate one of two ways:[^\n]*?Login and token lifetimes are separate\./u.exec(
        harnessSetup,
      )[0],
    ),
  );
  for (const link of [
    "https://docs.ohmyho.st/agents/mcp",
    "https://docs.ohmyho.st/support",
    "https://ohmyho.st/skills/ohmyhost-get-started/SKILL.md",
    "https://ohmyho.st/.well-known/agent-skills/index.json",
    "https://ohmyho.st/mcp-tools.json",
    "https://ohmyho.st/client-release.json",
  ])
    assert.ok(readme.includes(`(${link})`), link);

  const npmReadme = "# @amerged/ohmyhost-mcp\n";
  assert.deepEqual(JSON.parse(await readFile(join(clone, "release.json"), "utf8")), {
    version: "0.1.21",
    sourceCommit: SOURCE,
    npm: {
      name: "@amerged/ohmyhost-mcp",
      version: "0.1.21",
      integrity: integrityOf(bytes),
      sha256: sha256(bytes),
      tarball: TARBALL,
    },
    omitted: {
      "README.md": sha256(npmReadme),
      "dist/chunk-TEST.js": sha256(PACKAGE_FILES["dist/chunk-TEST.js"]),
      "dist/stdio-main.js": sha256(PACKAGE_FILES["dist/stdio-main.js"]),
    },
    generatedAt: "2026-09-26T10:00:00.000Z",
  });

  const server = JSON.parse(await readFile(join(clone, "server.json"), "utf8"));
  assert.deepEqual(server, {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.amerged-org/ohmyhost-mcp",
    title: "ohmyho.st",
    description: server.description,
    repository: { url: "https://github.com/amerged-org/ohmyhost-mcp", source: "github" },
    websiteUrl: "https://docs.ohmyho.st/agents/mcp",
    version: "0.1.21",
    packages: [
      {
        registryType: "npm",
        identifier: "@amerged/ohmyhost-mcp",
        version: "0.1.21",
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: "OHMYHOST_ENVIRONMENT",
            description: "Platform to use: production (default) or development.",
            isRequired: false,
            format: "string",
            default: "production",
          },
          {
            name: "OHMYHOST_TOKEN",
            description:
              "Optional user API token; without it the server uses the login saved by ohmyhost login.",
            isRequired: false,
            format: "string",
            isSecret: true,
          },
        ],
      },
    ],
  });
  assert.ok(server.description.length >= 1 && server.description.length <= 100);
  const workflow = await readFile(join(clone, ".github/workflows/publish-registry.yml"), "utf8");
  assert.equal(workflow, renderRegistryWorkflow());
  // The registry learns the repository from GitHub's OIDC token: no stored secret, a pinned publisher.
  assert.match(workflow, /^permissions:\n {2}contents: read\n {2}id-token: write$/mu);
  assert.match(workflow, /^ {6}- run: \.\/mcp-publisher login github-oidc$/mu);
  assert.match(workflow, /\| sha256sum --check --strict -$/mu);
  assert.doesNotMatch(workflow, /secrets\.|GITHUB_TOKEN|releases\/latest/u);
  assert.equal(
    JSON.parse(await readFile(join(clone, "package.json"), "utf8")).name,
    server.packages[0].identifier,
  );
  git("add", "-A");
  git("commit", "--quiet", "-m", "Mirror 0.1.21");
  const again = await prepareMcpRepository({
    ...input,
    tarball: bytes,
    fetch: registry(bytes, { tarballFails: true }),
    npmRecord: { integrity: integrityOf(bytes), sha256: sha256(bytes) },
    now: () => new Date("2026-09-27T10:00:00.000Z"),
  });
  assert.equal(again.changed, false);
  assert.equal(git("status", "--porcelain"), "");

  // The 0.1.39 tarball ships the postgres-bridge workspace (LICENSE, NOTICE, package.json, flat
  // src/*.ts) that the 0.1.38 shape above lacks; both shapes mirror byte for byte.
  const bridge = await makeTarball(parent, PACKAGE_FILES_WITH_BRIDGE);
  const second = await makeClone(parent);
  const withBridge = await prepareMcpRepository({
    ...input,
    clone: second.clone,
    fetch: registry(bridge),
  });
  assert.equal(withBridge.mirrored, 22);
  const bridgePaths = Object.keys(BRIDGE_FILES).map(
    (file) => `src/packages/postgres-bridge/${file}`,
  );
  const mirroredTree = await listTree(second.clone);
  for (const path of bridgePaths) {
    assert.ok(mirroredTree.includes(path), path);
    assert.equal(await readFile(join(second.clone, path), "utf8"), PACKAGE_FILES_WITH_BRIDGE[path]);
  }
  assert.match(
    await readFile(join(second.clone, "README.md"), "utf8"),
    /`packages\/postgres-bridge` with its own `LICENSE` and `NOTICE`/u,
  );
  assert.doesNotMatch(await readFile(join(clone, "README.md"), "utf8"), /postgres-bridge/u);
});

test("the MCP mirror refuses a foreign or dirty clone, an older version, a closure leak and bytes the registry did not publish", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-mcp-mirror-refusal-"));
  roots.push(parent);
  const bytes = await makeTarball(parent, PACKAGE_FILES);
  const base = { version: "0.1.21", sourceCommit: SOURCE, harnessSetup, catalog };
  const refuses = async (label, setup, pattern) => {
    const { clone, git } = await makeClone(parent, setup.clone);
    await setup.before?.(clone, git);
    const before = await listTree(clone);
    const status = git("status", "--porcelain");
    await assert.rejects(
      prepareMcpRepository({ ...base, clone, fetch: registry(bytes), ...setup.input }),
      pattern,
      label,
    );
    assert.deepEqual(await listTree(clone), before, label);
    assert.equal(git("status", "--porcelain"), status, label);
  };

  await refuses(
    "foreign origin",
    { clone: { origin: "https://github.com/amerged-org/ohmyhost-web.git" } },
    /Not a clone of amerged-org\/ohmyhost-mcp/u,
  );
  await refuses(
    "other branch",
    { before: (_clone, git) => git("checkout", "--quiet", "-b", "other") },
    /on main/u,
  );
  await refuses(
    "untracked file",
    { before: (clone) => writeFile(join(clone, "notes.txt"), "draft\n") },
    /uncommitted changes/u,
  );
  await refuses(
    "newer mirror",
    { clone: { release: { version: "0.1.22", npm: { integrity: "sha512-newer" } } } },
    /already mirrors 0\.1\.22, newer than 0\.1\.21/u,
  );
  await refuses(
    "same version, other tarball",
    { clone: { release: { version: "0.1.21", npm: { integrity: "sha512-other" } } } },
    /different tarball for 0\.1\.21/u,
  );
  await refuses(
    "npm latest moved on",
    { input: { fetch: registry(bytes, { latest: { version: "0.1.22" } }) } },
    /npm latest is 0\.1\.22/u,
  );
  await refuses(
    "bytes differ",
    { input: { fetch: registry(bytes, { served: Buffer.from("other bytes") }) } },
    /differs from the registry record/u,
  );
  await refuses(
    "foreign tarball origin",
    {
      input: {
        fetch: registry(bytes, {
          metadata: {
            dist: { integrity: integrityOf(bytes), tarball: "https://example.com/mcp.tgz" },
          },
        }),
      },
    },
    /registry\.npmjs\.org/u,
  );
  await refuses(
    "prepared manifest differs",
    { input: { npmRecord: { integrity: integrityOf(bytes), sha256: "0".repeat(64) } } },
    /prepared npm manifest/u,
  );
  const leaking = await makeTarball(parent, {
    ...PACKAGE_FILES,
    "src/apps/mcp/src/worker-main.ts": "export default {};\n",
  });
  await refuses(
    "hosted worker in the package",
    { input: { fetch: registry(leaking) } },
    /outside the public MCP closure: src\/apps\/mcp\/src\/worker-main\.ts/u,
  );
  const testSource = await makeTarball(parent, {
    ...PACKAGE_FILES,
    "src/packages/contracts/src/framework-build-script.node-test.mjs": "export {};\n",
  });
  await refuses(
    "test code in the package",
    { input: { fetch: registry(testSource) } },
    /outside the public MCP closure: src\/packages\/contracts\/src\/framework-build-script\.node-test\.mjs/u,
  );
  const platform = await makeTarball(parent, {
    ...PACKAGE_FILES,
    "src/apps/control-api/src/app.ts": "export {};\n",
  });
  await refuses(
    "platform source in the package",
    { input: { fetch: registry(platform) } },
    /outside the public MCP closure: src\/apps\/control-api\/src\/app\.ts/u,
  );
  const missingMetadata = { ...PACKAGE_FILES };
  delete missingMetadata["src/apps/product-cli/package.json"];
  const incomplete = await makeTarball(parent, missingMetadata);
  await refuses(
    "missing source workspace metadata",
    { input: { fetch: registry(incomplete) } },
    /lacks public workspace metadata: src\/apps\/product-cli\/package\.json/u,
  );
  const privateLicense = await makeTarball(parent, {
    ...PACKAGE_FILES,
    "src/apps/mcp/package.json": JSON.stringify({
      name: "@ohmyhost/mcp",
      version: "0.1.21",
      license: "UNLICENSED",
    }),
  });
  await refuses(
    "a private license on public source metadata",
    { input: { fetch: registry(privateLicense) } },
    /Unexpected public workspace source package: src\/apps\/mcp\/package\.json/u,
  );
  // The bridge allowance covers exactly its published members, not any other path near it.
  for (const [label, extra, leak] of [
    ["unowned bridge config", { "tsconfig.json": "{}\n" }, "tsconfig.json"],
    ["nested bridge source", { "src/nested/deep.ts": "export {};\n" }, "src/nested/deep.ts"],
    ["bridge test", { "src/bridge.test.ts": "export {};\n" }, "src/bridge.test.ts"],
    ["bridge worker entry", { "src/worker-main.ts": "export {};\n" }, "src/worker-main.ts"],
    ["bridge credential file", { ".env": "TOKEN=x\n" }, ".env"],
  ]) {
    const leaking = await makeTarball(parent, {
      ...PACKAGE_FILES_WITH_BRIDGE,
      ...Object.fromEntries(
        Object.entries(extra).map(([file, text]) => [`src/packages/postgres-bridge/${file}`, text]),
      ),
    });
    await refuses(
      label,
      { input: { fetch: registry(leaking) } },
      new RegExp(
        `outside the public MCP closure: src/packages/postgres-bridge/${leak.replaceAll(".", "\\.")}`,
        "u",
      ),
    );
  }
  const foreignNotice = await makeTarball(parent, {
    ...PACKAGE_FILES_WITH_BRIDGE,
    "src/packages/sdk-ts/NOTICE": "not owned by the SDK\n",
  });
  await refuses(
    "NOTICE owned by another workspace",
    { input: { fetch: registry(foreignNotice) } },
    /outside the public MCP closure: src\/packages\/sdk-ts\/NOTICE/u,
  );
  const noNotice = { ...PACKAGE_FILES_WITH_BRIDGE };
  delete noNotice["src/packages/postgres-bridge/NOTICE"];
  await refuses(
    "bridge without its NOTICE",
    { input: { fetch: registry(await makeTarball(parent, noNotice)) } },
    /incomplete packages\/postgres-bridge closure; it lacks NOTICE/u,
  );
  await refuses(
    "bridge under another name",
    {
      input: {
        fetch: registry(
          await makeTarball(parent, {
            ...PACKAGE_FILES_WITH_BRIDGE,
            "src/packages/postgres-bridge/package.json": JSON.stringify({
              name: "@ohmyhost/control-api",
              license: "Apache-2.0",
            }),
          }),
        ),
      },
    },
    /Unexpected public workspace source package: src\/packages\/postgres-bridge\/package\.json/u,
  );
  const stray = await makeTarball(parent, { ...PACKAGE_FILES, "extra/notes.txt": "x\n" });
  await refuses(
    "unexpected top-level entry",
    { input: { fetch: registry(stray) } },
    /Unexpected archive path: extra/u,
  );
  await refuses(
    "harness reference reworded",
    { input: { harnessSetup: "# Connect the local product MCP\n" } },
    /harness table and authentication sentence/u,
  );
});

test("the npm packages name support, retain their mirror and require reviewed bundled licence notices", async () => {
  const workspace = { name: "@ohmyhost/mcp", version: "0.1.22", private: true, type: "module" };
  const mcp = publicPackageMetadata(workspace, "mcp");
  assert.deepEqual(mcp, {
    name: "@amerged/ohmyhost-mcp",
    version: "0.1.22",
    type: "module",
    license: "Apache-2.0",
    homepage: "https://docs.ohmyho.st/",
    bugs: { url: "https://docs.ohmyho.st/support" },
    mcpName: "io.github.amerged-org/ohmyhost-mcp",
    repository: { type: "git", url: "git+https://github.com/amerged-org/ohmyhost-mcp.git" },
    description: "ohmyho.st mcp client",
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    files: ["dist", "src", "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md"],
  });
  assert.equal(workspace.private, true, "the workspace manifest is not modified");
  assert.equal("mcpName" in publicPackageMetadata({ name: "@ohmyhost/sdk-ts" }, "sdk"), false);
  for (const suffix of ["cli", "sdk", "runtime", "auth"]) {
    const metadata = publicPackageMetadata({ name: `@ohmyhost/${suffix}`, private: true }, suffix);
    assert.equal(metadata.name, `@amerged/ohmyhost-${suffix}`);
    assert.equal("private" in metadata, false);
    assert.deepEqual(metadata.bugs, { url: "https://docs.ohmyho.st/support" });
    assert.equal("repository" in metadata, false, suffix);
  }

  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-bundled-notices-"));
  roots.push(parent);
  const directory = join(parent, "clean-git-ref");
  await mkdir(join(directory, "lib"), { recursive: true });
  const cliRequire = createRequire(join(repositoryRoot, "apps/product-cli/package.json"));
  const gitRequire = createRequire(cliRequire.resolve("isomorphic-git"));
  const actualSource = await readFile(gitRequire.resolve("clean-git-ref"));
  await writeFile(join(directory, "lib/index.js"), actualSource);
  const upstream = {
    name: "clean-git-ref",
    version: "2.0.1",
    license: "Apache-2.0",
    author: "Eli White <github@eli-white.com>",
    repository: { type: "git", url: "https://github.com/TheSavior/clean-git-ref.git" },
  };
  const item = { directory, metadata: upstream };
  const notices = readBundledLicenseNotices("clean-git-ref", item);
  assert.ok(notices.includes("Eli White <github@eli-white.com>"));
  assert.ok(notices.includes("bf3c8afc8032bcdc6a53634c18b601dc6df478fb"));
  assert.ok(notices.includes("No upstream LICENSE or NOTICE file"));
  assert.ok(
    notices.endsWith(
      await readFile(join(repositoryRoot, "licenses/CLIENTS-APACHE-2.0.txt"), "utf8"),
    ),
  );
  assert.equal(/Copyright.*Eli White/u.test(notices), false, "no invented copyright year or line");
  for (const [field, value] of [
    ["name", "other-package"],
    ["version", "2.0.2"],
    ["license", "MIT"],
    ["author", "Other Author"],
    ["repository", { type: "git", url: "https://example.com/other.git" }],
  ])
    assert.throws(
      () =>
        readBundledLicenseNotices("clean-git-ref", {
          directory,
          metadata: { ...upstream, [field]: value },
        }),
      /Missing bundled licence/u,
      field,
    );
  assert.throws(
    () => readBundledLicenseNotices("another-package", item),
    /Missing bundled licence/u,
  );
  await writeFile(join(directory, "lib/index.js"), "changed source\n");
  assert.throws(() => readBundledLicenseNotices("clean-git-ref", item), /Missing bundled licence/u);
  await writeFile(join(directory, "lib/index.js"), actualSource);
  const wrongRepository = join(parent, "wrong-repository");
  await mkdir(join(wrongRepository, "licenses"), { recursive: true });
  await writeFile(join(wrongRepository, "licenses/CLIENTS-APACHE-2.0.txt"), "different licence\n");
  assert.throws(
    () => readBundledLicenseNotices("clean-git-ref", item, wrongRepository),
    /Canonical Apache licence differs/u,
  );
  await writeFile(join(directory, "LICENSE"), "Existing upstream licence bytes\n");
  assert.equal(
    readBundledLicenseNotices("another-package", { directory, metadata: { version: "1" } }),
    "### LICENSE\n\nExisting upstream licence bytes\n\n",
  );

  const diff3Directory = join(parent, "diff3");
  await mkdir(diff3Directory);
  const diff3Source = dirname(gitRequire.resolve("diff3"));
  const diff3Metadata = JSON.parse(await readFile(join(diff3Source, "package.json"), "utf8"));
  const headers = [];
  const originalSources = new Map();
  for (const file of ["diff3.js", "onp.js"]) {
    const bytes = await readFile(join(diff3Source, file));
    await writeFile(join(diff3Directory, file), bytes);
    originalSources.set(file, bytes);
    const source = bytes.toString("utf8");
    const header =
      file === "diff3.js"
        ? /^(?:\/\/[^\n]*\n)+/u.exec(source)[0]
        : /^\/\*[\s\S]*?\*\//u.exec(source)[0];
    headers.push(`### ${file} upstream embedded licence\n\n${header}\n`);
  }
  const diff3 = { directory: diff3Directory, metadata: diff3Metadata };
  const diff3Notices = readBundledLicenseNotices("diff3", diff3);
  assert.equal(diff3Notices, headers.join("\n"));
  for (const original of [
    "Copyright (c) 2006, 2008 Tony Garnock-Jones",
    "Copyright (c) 2006, 2008 LShift Ltd.",
    "Copyright (c) 2013 Tatsuhiko Kubo",
    "Permission is hereby granted, free of charge",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    "SOFTWARE.",
  ])
    assert.ok(diff3Notices.includes(original), original);
  for (const file of ["diff3.js", "onp.js"]) {
    await writeFile(join(diff3Directory, file), "changed embedded licence\n");
    assert.throws(
      () => readBundledLicenseNotices("diff3", diff3),
      /Missing bundled licence/u,
      file,
    );
    await writeFile(join(diff3Directory, file), originalSources.get(file));
  }
  for (const [field, value] of [
    ["version", "0.0.4"],
    ["license", "Apache-2.0"],
    ["author", "Other Author"],
    ["repository", { type: "git", url: "https://example.com/" }],
  ])
    assert.throws(
      () =>
        readBundledLicenseNotices("diff3", {
          directory: diff3Directory,
          metadata: { ...diff3Metadata, [field]: value },
        }),
      /Missing bundled licence/u,
      field,
    );
  assert.throws(
    () => readBundledLicenseNotices("another-package", diff3),
    /Missing bundled licence/u,
  );
});

test("published client source preserves executable ESM helpers and their types without tests or worker entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-public-source-"));
  roots.push(root);
  const source = join(root, "source");
  const delivered = join(root, "delivered");
  const files = {
    "public.ts": 'import { value } from "./nested/helper.mjs"; console.log(value);\n',
    "nested/helper.mjs": "export const value = 24;\n",
    "nested/helper.d.mts": "export declare const value: number;\n",
    "nested/schema.json": "{}\n",
    "nested/helper.node-test.mjs": 'throw new Error("test must not ship");\n',
    "nested/helper.test.ts": 'throw new Error("test must not ship");\n',
    "worker-main.ts": 'throw new Error("private Worker must not ship");\n',
    ".env": "fixture-local-file=do-not-copy\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), contents);
  }
  copyClientSourceFiles(source, delivered);
  assert.deepEqual(await readdir(join(delivered, "nested")), [
    "helper.d.mts",
    "helper.mjs",
    "schema.json",
  ]);
  assert.deepEqual(await readdir(delivered), ["nested", "public.ts"]);
  assert.equal(
    execFileSync(process.execPath, [join(delivered, "public.ts")], { encoding: "utf8" }).trim(),
    "24",
  );

  const workspaces = [
    "apps/mcp",
    "apps/product-cli",
    "packages/contracts",
    "packages/workos-auth-contracts",
    "packages/agent-skills",
  ];
  const sourceVersions = {};
  for (const workspace of workspaces) {
    copyClientWorkspaceSource(repositoryRoot, workspace, delivered);
    const source = JSON.parse(
      await readFile(join(repositoryRoot, workspace, "package.json"), "utf8"),
    );
    const packaged = JSON.parse(await readFile(join(delivered, workspace, "package.json"), "utf8"));
    assert.deepEqual(packaged, { ...source, license: "Apache-2.0" });
    sourceVersions[workspace] = source.version;
  }
  const productCliRequire = createRequire(join(repositoryRoot, "apps/product-cli/package.json"));
  const sourceDependencies = new Map(
    ["ignore", "isomorphic-git"].map((name) => [name, productCliRequire.resolve(name)]),
  );
  const copiedWorkspace = await realpath(
    join(delivered, "apps/product-cli/src/source-workspace.ts"),
  );
  const copied = await build({
    absWorkingDir: repositoryRoot,
    stdin: {
      contents:
        'import { cliMetadataResult } from "./apps/product-cli/src/cli.ts";\n' +
        'import { createOhmyhostMcpServer } from "./apps/mcp/src/index.ts";\n' +
        'import { PINNED_BUN_VERSION } from "./packages/contracts/src/framework-build-script.ts";\n' +
        'console.log(JSON.stringify({ cli: JSON.parse(cliMetadataResult("version").stdout).cli_version, mcp: createOhmyhostMcpServer().info.version, bun: PINNED_BUN_VERSION }));\n',
      resolveDir: delivered,
      sourcefile: "copied-client-imports.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    metafile: true,
    banner: {
      js: 'import { createRequire as __ohmyhostCreateRequire } from "node:module"; const require = __ohmyhostCreateRequire(import.meta.url);',
    },
    logLevel: "silent",
    plugins: [
      {
        name: "copied-client-workspaces",
        setup(builder) {
          builder.onResolve({ filter: /^(?:ignore|isomorphic-git)$/ }, ({ path, importer }) => {
            if (importer !== copiedWorkspace) return;
            return { path: sourceDependencies.get(path) };
          });
          builder.onResolve({ filter: /^@ohmyhost\// }, ({ path }) => {
            const [name, ...subpath] = path.slice("@ohmyhost/".length).split("/");
            const workspace = workspaces.find((value) => value.endsWith("/" + name));
            assert.ok(workspace, path);
            return {
              path: join(delivered, workspace, "src", (subpath.join("/") || "index") + ".ts"),
            };
          });
          builder.onResolve({ filter: /^@modelcontextprotocol\/server$/ }, () => ({
            path: "mcp-server-fixture",
            namespace: "copied-client-fixture",
          }));
          builder.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({
            path: "native-keyring-fixture",
            namespace: "copied-client-fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "copied-client-fixture" }, ({ path }) => ({
            contents:
              path === "native-keyring-fixture"
                ? 'throw new Error("Credential access is outside the packaging fixture");\n'
                : "export class McpServer { constructor(info) { this.info = info; } registerResource() {} }\n" +
                  "export const createMcpHandler = () => () => undefined;\n",
            loader: "js",
          }));
        },
      },
    ],
  });
  const copiedInputs = new Set(
    Object.keys(copied.metafile.inputs).map((path) => resolve(repositoryRoot, path)),
  );
  for (const [name, dependency] of sourceDependencies)
    assert.ok(copiedInputs.has(dependency), `Copied source must bundle the real ${name} package`);
  const gitRequire = createRequire(sourceDependencies.get("isomorphic-git"));
  assert.ok(
    copiedInputs.has(gitRequire.resolve("ignore")),
    "Git's transitive ignore dependency must resolve beside the installed Git package",
  );
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: copied.outputFiles[0].text,
    }).trim(),
    JSON.stringify({
      cli: sourceVersions["apps/product-cli"],
      mcp: sourceVersions["apps/mcp"],
      bun: "1.2.22",
    }),
  );
  const privateWorkspace = join(root, "private-metadata");
  await mkdir(join(privateWorkspace, "apps/mcp/src"), { recursive: true });
  const privateManifest = { name: "@ohmyhost/mcp", version: "0.1.24", license: "UNLICENSED" };
  await writeFile(join(privateWorkspace, "apps/mcp/package.json"), JSON.stringify(privateManifest));
  copyClientWorkspaceSource(privateWorkspace, "apps/mcp", join(root, "licensed"));
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "licensed/apps/mcp/package.json"), "utf8")),
    { ...privateManifest, license: "Apache-2.0" },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(privateWorkspace, "apps/mcp/package.json"), "utf8")),
    privateManifest,
  );
  assert.throws(
    () => copyClientWorkspaceSource(repositoryRoot, "apps/control-api", delivered),
    /outside the public client source closure/u,
  );
});

test("client packages are built only from the released commit in a clean tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "npm-release-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "release@example.test");
  git("config", "user.name", "Release");
  await writeFile(join(root, "tracked.txt"), "released\n");
  git("add", "tracked.txt");
  git("commit", "-q", "-m", "release");
  const sha = git("rev-parse", "HEAD");
  requireReleaseSource({ root, sourceCommit: sha });
  await writeFile(join(root, "stray.txt"), "not released\n");
  assert.throws(() => requireReleaseSource({ root, sourceCommit: sha }), /not clean/u);
  requireReleaseSource({ root, sourceCommit: sha, allowedPaths: ["stray.txt"] });
  await rm(join(root, "stray.txt"));
  assert.throws(
    () => requireReleaseSource({ root, sourceCommit: "0".repeat(40) }),
    /source commit/u,
  );
});
