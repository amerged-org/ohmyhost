import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { requireCurrentReleaseInputs } from "../scripts/web-release-inputs.mjs";

const VERSION = "0.1.0";

async function repository(context) {
  const root = await mkdtemp(join(tmpdir(), "web-release-inputs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const contract = '{"openapi":"3.1.0"}\n';
  await write(".gitignore", "/apps/public-site/public/releases/\n");
  await write("packages/contracts/generated/openapi.json", contract);
  await write("apps/mcp/package.json", JSON.stringify({ version: VERSION }));
  await write("apps/product-cli/package.json", JSON.stringify({ version: VERSION }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "release@example.test");
  git("config", "user.name", "Release");
  git("add", "-A");
  git("commit", "-q", "-m", "release");
  // The released client names the commit its contract was built from; the release manifest is gitignored.
  await write(
    `apps/public-site/public/releases/${VERSION}/manifest.json`,
    JSON.stringify({ version: VERSION, source_commit: git("rev-parse", "HEAD").trim() }),
  );
  return { root, write, git };
}

test("web inputs are published only when they match the released client contract and version, from a clean tree", async (context) => {
  const { root, write, git } = await repository(context);
  const contractPath = join(root, "packages/contracts/generated/openapi.json");
  const check = () => requireCurrentReleaseInputs({ root, version: VERSION, contractPath });
  check();

  await write("packages/contracts/generated/openapi.json", '{"openapi":"3.1.0","paths":{}}\n');
  git("commit", "-q", "-am", "unreleased operation");
  assert.throws(check, /contract differs/u);
  git("checkout", "-q", "HEAD~1", "--", "packages/contracts/generated/openapi.json");
  git("commit", "-q", "-am", "revert");
  check();

  await write("apps/mcp/package.json", JSON.stringify({ version: "0.1.1" }));
  git("commit", "-q", "-am", "newer mcp");
  assert.throws(check, /apps\/mcp\/package.json/u);
  git("checkout", "-q", "HEAD~1", "--", "apps/mcp/package.json");
  git("commit", "-q", "-am", "revert mcp");
  check();

  await write("apps/product-cli/src/stray.ts", "export {};\n");
  assert.throws(check, /clean/u);
});

test("the contract baseline is the one the release manifest's source commit carries, never a working-tree snapshot", async (context) => {
  const { root, write, git } = await repository(context);
  const contractPath = join(root, "packages/contracts/generated/openapi.json");
  const check = () => requireCurrentReleaseInputs({ root, version: VERSION, contractPath });
  const manifest = join(root, "apps/public-site/public/releases", VERSION, "manifest.json");
  await rm(manifest);
  assert.throws(check, /has no published manifest/u);
  await write(
    `apps/public-site/public/releases/${VERSION}/manifest.json`,
    JSON.stringify({ version: "0.1.1", source_commit: git("rev-parse", "HEAD").trim() }),
  );
  assert.throws(check, /manifest names another version/u);
  await write(
    `apps/public-site/public/releases/${VERSION}/manifest.json`,
    JSON.stringify({ version: VERSION, source_commit: "not-a-commit" }),
  );
  assert.throws(check, /names no source commit/u);
});
