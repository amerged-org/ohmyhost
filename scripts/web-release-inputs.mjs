import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The website publishes its contract, catalog and Skills only when they are the released client's: the contract
 * equals the one committed at the source commit that the client release names, both client packages carry its
 * version, and the tree is clean, so an unreleased operation or an uncommitted edit cannot ship under a released version.
 */
export function requireCurrentReleaseInputs({ root, version, contractPath }) {
  const manifestPath = join(root, "apps/public-site/public/releases", version, "manifest.json");
  if (!existsSync(manifestPath))
    throw new Error(`Client release ${version} has no published manifest; prepare it first`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version)
    throw new Error(`Client release manifest names another version than ${version}`);
  if (!/^[0-9a-f]{40}$/u.test(manifest.source_commit ?? ""))
    throw new Error(`Client release ${version} manifest names no source commit`);
  const released = execFileSync(
    "git",
    ["show", `${manifest.source_commit}:packages/contracts/generated/openapi.json`],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  if (!readFileSync(contractPath).equals(released))
    throw new Error(
      "The contract differs from the released client contract; publish only the release",
    );
  for (const path of ["apps/mcp/package.json", "apps/product-cli/package.json"]) {
    if (JSON.parse(readFileSync(join(root, path), "utf8")).version !== version)
      throw new Error(`${path} is not at client release ${version}`);
  }
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.trim() !== "")
    throw new Error("Web inputs require a clean worktree; commit the platform changes first");
}
