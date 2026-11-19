import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const definitions = {
  publisher: { main: "src/publisher-main.ts" },
  consumer: { main: "src/consumer-main.ts" },
  workflow: { main: "src/workflow-main.ts" },
  "deployment-workflow": { main: "src/deployment-workflow-main.ts" },
};

export async function verifyBuiltBoundary(root = new URL("../", import.meta.url)) {
  for (const [name, definition] of Object.entries(definitions)) {
    const source = await readFile(new URL(`wrangler.${name}.jsonc`, root), "utf8");
    const config = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1"));
    if (
      config.main !== definition.main ||
      config.compatibility_date !== "2026-08-19" ||
      config.workers_dev !== false ||
      config.preview_urls !== false ||
      config.routes !== undefined ||
      config.vars?.RUNTIME_CONFIGURATION_STATE !== "disabled"
    ) {
      throw new Error(`Project provisioning ${name} public boundary is invalid`);
    }
    if (
      (name === "publisher" &&
        (config.queues?.producers?.length !== 1 || config.queues?.consumers !== undefined)) ||
      (name === "consumer" &&
        (config.queues?.consumers?.length !== 1 ||
          config.queues?.producers !== undefined ||
          config.workflows?.[0]?.script_name !== "ohmyhost-project-provisioning-workflow")) ||
      ((name === "workflow" || name === "deployment-workflow") && config.queues !== undefined)
    ) {
      throw new Error(`Project provisioning ${name} capability graph is invalid`);
    }

    const bundle = await readFile(new URL(`dist/${name}-bundle/${name}-main.js`, root), "utf8");
    for (const forbidden of [/dotenv/u, /WORKOS_/u, /(?:API|CLIENT)_KEY/u, /\bfetch\s*\(/u]) {
      if (forbidden.test(bundle)) {
        throw new Error(`Forbidden ${name} bundle primitive: ${forbidden}`);
      }
    }
    const metafile = JSON.parse(
      await readFile(new URL(`dist/${name}-bundle/metafile.json`, root), "utf8"),
    );
    const inputs = Object.keys(metafile.inputs ?? {});
    if (
      !inputs.some((input) => input.endsWith(definition.main.slice(4))) ||
      inputs.some((input) => /apps\/(?:control-api|product-cli|workos-management)/u.test(input))
    ) {
      throw new Error(`Project provisioning ${name} build graph is invalid`);
    }
    await verifyWorkspaceBuildInputs(root, name, inputs);
  }
}

/**
 * @param {URL} root
 * @param {string} bundleName
 * @param {string[]} inputs
 */
async function verifyWorkspaceBuildInputs(root, bundleName, inputs) {
  const packageRoots = new Map();
  for (const input of inputs) {
    const inputUrl = new URL(input, root);
    if (inputUrl.protocol !== "file:") continue;
    const inputPath = fileURLToPath(inputUrl);
    const marker = `${path.sep}dist${path.sep}`;
    const markerIndex = inputPath.lastIndexOf(marker);
    if (markerIndex === -1 || path.extname(inputPath) !== ".js") continue;

    const packageRoot = inputPath.slice(0, markerIndex);
    let isWorkspacePackage = packageRoots.get(packageRoot);
    if (isWorkspacePackage === undefined) {
      const packageJson = JSON.parse(
        await readFile(path.join(packageRoot, "package.json"), "utf8"),
      );
      isWorkspacePackage = String(packageJson.name ?? "").startsWith("@ohmyhost/");
      packageRoots.set(packageRoot, isWorkspacePackage);
    }
    if (!isWorkspacePackage) continue;

    const relativeOutput = inputPath.slice(markerIndex + marker.length);
    const sourcePath = path.join(packageRoot, "src", relativeOutput.replace(/\.js$/u, ".ts"));
    let outputStats;
    let sourceStats;
    try {
      [outputStats, sourceStats] = await Promise.all([stat(inputPath), stat(sourcePath)]);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(
          `Project provisioning ${bundleName} workspace dependency build is missing: ${input}`,
        );
      }
      throw error;
    }
    if (sourceStats.mtimeMs > outputStats.mtimeMs) {
      throw new Error(
        `Project provisioning ${bundleName} workspace dependency build is stale: ${input}`,
      );
    }
  }
}

/**
 * @param {unknown} error
 * @returns {error is Error & { code: string }}
 */
function isNodeError(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await verifyBuiltBoundary();
}
