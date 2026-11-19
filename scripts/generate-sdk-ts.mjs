/* global process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { projectRemoteMcpContract, renderRemoteMcpModule } from "./mcp-remote-projection.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const temporaryOutput = await parseTemporaryOutput(process.argv.slice(2));
const temporaryConfigDirectory =
  temporaryOutput === undefined ? undefined : await mkdtemp(join(tmpdir(), "ohmyhost-sdk-config-"));
const configPath =
  temporaryConfigDirectory === undefined
    ? "hey-api.config.ts"
    : join(temporaryConfigDirectory, "hey-api.config.ts");
const formatterIgnorePath =
  temporaryConfigDirectory === undefined
    ? join(projectRoot, ".prettierignore")
    : join(temporaryConfigDirectory, ".prettierignore");

try {
  if (temporaryOutput !== undefined) {
    const sourceConfigModule = JSON.stringify(
      pathToFileURL(join(projectRoot, "hey-api.config.ts")).href,
    );
    const contractInput = JSON.stringify(
      join(projectRoot, "packages/contracts/generated/openapi.json"),
    );
    await writeFile(
      configPath,
      [
        `import { createSdkConfig } from ${sourceConfigModule};`,
        `export default createSdkConfig(${JSON.stringify(temporaryOutput)}, ${contractInput});`,
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "wx" },
    );
    // A guarded temporary output may sit under an ignored repository scratch root.
    // It still needs the exact normal formatting before deterministic comparison.
    await writeFile(formatterIgnorePath, "", { encoding: "utf8", flag: "wx" });
  }

  const result = spawnSync(pnpm, ["exec", "openapi-ts", "--file", configPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`TypeScript SDK generation failed:\n${result.stderr || result.stdout}`);
  }

  process.stdout.write(result.stdout);
  const outputDirectory = temporaryOutput ?? join(projectRoot, "packages/sdk-ts/src/generated");
  const contractSource = await readFile(
    join(projectRoot, "packages/contracts/generated/openapi.json"),
    "utf8",
  );
  const document = JSON.parse(contractSource);
  const sdkPackage = JSON.parse(
    await readFile(join(projectRoot, "packages/sdk-ts/package.json"), "utf8"),
  );
  const remoteContract = projectRemoteMcpContract(document, contractSource);
  await writeFile(
    join(outputDirectory, "mcp-remote.gen.ts"),
    renderRemoteMcpModule(
      remoteContract,
      await readFile(join(outputDirectory, "sdk.gen.ts"), "utf8"),
      sdkPackage.version,
    ),
    "utf8",
  );
  // The standalone SDK embeds only this exact canonical, dependency-free response codec.
  // Emit into both normal and temporary output so the existing drift check owns its bytes.
  const canonicalCodec = await readFile(
    join(projectRoot, "packages/contracts/src/shared-mail.ts"),
    "utf8",
  );
  const codecReferences = ts.preProcessFile(canonicalCodec, true, true);
  if (
    codecReferences.importedFiles.length > 0 ||
    codecReferences.referencedFiles.length > 0 ||
    codecReferences.typeReferenceDirectives.length > 0 ||
    codecReferences.libReferenceDirectives.length > 0
  )
    throw new Error("The standalone SDK response codec must have no external references");
  const codecHash = createHash("sha256").update(canonicalCodec).digest("hex");
  await writeFile(
    join(
      temporaryOutput ?? join(projectRoot, "packages/sdk-ts/src/generated"),
      "shared-mail-response.ts",
    ),
    `// Generated from packages/contracts/src/shared-mail.ts by scripts/generate-sdk-ts.mjs.\n// Canonical SHA-256: ${codecHash}\n${canonicalCodec}`,
    "utf8",
  );
  const prettier = spawnSync(
    pnpm,
    [
      "exec",
      "prettier",
      "--write",
      "--config",
      join(projectRoot, ".prettierrc.json"),
      "--ignore-path",
      formatterIgnorePath,
      temporaryOutput ?? join(projectRoot, "packages/sdk-ts/src/generated"),
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (prettier.status !== 0) {
    throw new Error(`TypeScript SDK formatting failed:\n${prettier.stderr || prettier.stdout}`);
  }
  process.stdout.write(prettier.stdout);
} finally {
  if (temporaryConfigDirectory !== undefined) {
    await rm(temporaryConfigDirectory, { force: true, recursive: true });
  }
}

async function parseTemporaryOutput(args) {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length !== 2 || args[0] !== "--temporary-output") {
    throw new TypeError(
      "Usage: generate-sdk-ts.mjs [--temporary-output <existing temp directory>]",
    );
  }

  const candidate = args[1];
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError("Temporary SDK output must be an absolute path");
  }

  const [temporaryRoot, output] = await Promise.all([
    realpath(tmpdir()),
    realpath(resolve(candidate)),
  ]);
  const pathFromTemporaryRoot = relative(temporaryRoot, output);
  if (
    pathFromTemporaryRoot === "" ||
    pathFromTemporaryRoot === ".." ||
    pathFromTemporaryRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromTemporaryRoot)
  ) {
    throw new TypeError(
      "Temporary SDK output must be an existing directory below the OS temp root",
    );
  }
  if (!basename(output).startsWith("ohmyhost-sdk-drift-") || (await readdir(output)).length !== 0) {
    throw new TypeError("Temporary SDK output must be a new, empty ohmyhost drift directory");
  }
  return output;
}
