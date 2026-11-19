import { isManagementRuntimeContract } from "./runtime-contract.mjs";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";

const root = new URL("../dist/", import.meta.url);
const forbiddenEverywhere = [
  /dotenv/u,
  /WORKOS_(?:API|MANAGEMENT)_KEY/u,
  /@workos-inc\//u,
  /apps\/(?:control-api|product-cli)/u,
  /(?:^|[/\\])(?:test|fixtures?)(?:[/\\]|$)/u,
  /node:child_process/u,
];
const forbiddenCompiledSource = [/process\.env/u, /console\.(?:log|error|warn)/u];

const inspect = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) await inspect(target);
    else if (/\.(?:js|map)$/u.test(entry.name)) {
      const source = await readFile(target, "utf8");
      const patterns = target.pathname.includes("/worker-bundle/")
        ? forbiddenEverywhere
        : [...forbiddenEverywhere, ...forbiddenCompiledSource];
      for (const pattern of patterns) {
        if (pattern.test(source))
          throw new Error(`Forbidden built management boundary: ${pattern}`);
      }
    }
  }
};

await inspect(root);

const runtimeContract = JSON.parse(
  await readFile(new URL("runtime/runtime-contract.json", root), "utf8"),
);
if (!isManagementRuntimeContract(runtimeContract)) {
  throw new Error("Invalid built management runtime contract");
}

const wranglerSource = await readFile(new URL("runtime/wrangler.jsonc", root), "utf8");
const wrangler = JSON.parse(wranglerSource.replace(/,\s*([}\]])/gu, "$1"));
if (
  wrangler?.main !== "src/worker-main.ts" ||
  wrangler?.workers_dev !== false ||
  wrangler?.preview_urls !== false ||
  wrangler?.version_metadata?.binding !== "CF_VERSION_METADATA" ||
  JSON.stringify(wrangler?.triggers?.crons) !== JSON.stringify(["*/1 * * * *"]) ||
  wrangler?.routes !== undefined
) {
  throw new Error("WorkOS management Worker must remain private");
}
