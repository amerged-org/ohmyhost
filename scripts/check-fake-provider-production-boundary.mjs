/* global process */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const WORKSPACE_DIRECTORIES = ["apps", "packages"];
const LOCAL_ONLY_APP_NAMES = new Set(["@ohmyhost/cli"]);
const FORBIDDEN_PACKAGE_NAMES = new Set(["@ohmyhost/local-runner", "@ohmyhost/testkit"]);
const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const ARTIFACT_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".map", ".d.ts"];
const APP_AUXILIARY_BUILD_CONTRACTS = Object.freeze({
  "@ohmyhost/control-api": Object.freeze({
    "node ../../scripts/prepare-portal-assets.mjs": Object.freeze({
      kind: "reviewed-static-pages",
      path: "../../scripts/prepare-portal-assets.mjs",
      sha256: "54edea686a0b4ae5cdddbbf8e418f1151a356b62b6bb256574983e678b68380d",
    }),
  }),
  "@ohmyhost/public-site": Object.freeze({
    "node scripts/prepare-pages.mjs": Object.freeze({
      kind: "reviewed-static-pages",
      path: "scripts/prepare-pages.mjs",
      sha256: "993492ebaa68cfae748904240acf1462e406a2e8b232567139f9bdeda856eaaf",
    }),
  }),
  "@ohmyhost/project-provisioning-worker": Object.freeze({
    "node scripts/verify-built-boundary.mjs": Object.freeze({
      kind: "node-script",
      path: "scripts/verify-built-boundary.mjs",
    }),
    "pnpm types:check": Object.freeze({
      kind: "package-script",
      name: "types:check",
      value: "wrangler types --check --config wrangler.workflow.jsonc worker-configuration.d.ts",
    }),
  }),
  "@ohmyhost/wfp-dispatch": Object.freeze({
    "node scripts/clean-dist.mjs": Object.freeze({
      kind: "node-script",
      path: "scripts/clean-dist.mjs",
    }),
  }),
  "@ohmyhost/wfp-management": Object.freeze({
    "pnpm prepare:database": Object.freeze({
      kind: "package-script",
      name: "prepare:database",
      value: "node scripts/prepare-project-database-module.mjs",
    }),
  }),
  "@ohmyhost/workos-management": Object.freeze({
    "node scripts/emit-artifact-proof.mjs": Object.freeze({
      kind: "node-script",
      path: "scripts/emit-artifact-proof.mjs",
    }),
    "node scripts/finalize-worker-bundle.mjs": Object.freeze({
      kind: "node-script",
      path: "scripts/finalize-worker-bundle.mjs",
    }),
    "node scripts/prepare-worker-bundle.mjs": Object.freeze({
      kind: "node-script",
      path: "scripts/prepare-worker-bundle.mjs",
    }),
    "node scripts/verify-built-boundary.mjs": Object.freeze({
      kind: "node-script",
      path: "scripts/verify-built-boundary.mjs",
    }),
  }),
});
const FORBIDDEN_ARTIFACT_PATTERNS = [
  /@ohmyhost\/(?:local-runner|testkit)\b/u,
  /(?:^|[/\\])packages[/\\](?:local-runner|testkit)(?:[/\\]|$)/u,
  /\b(?:FakeProviderStore|FakeStaticHostingProvider)\b/u,
  /(?:fake-provider-store|fake-static-hosting-provider)(?:\.[cm]?[jt]s)?/u,
];

export async function verifyProductionFakeProviderBoundary({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  resolveTypescriptFiles = resolveProductionTypescriptFiles,
} = {}) {
  const workspacePackages = await readWorkspacePackages(root);
  const appPackages = [...workspacePackages.values()]
    .filter((entry) => entry.kind === "apps")
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const app of appPackages) assertDeploymentIdentity(app, root);
  const productionApps = appPackages.filter(
    (entry) => entry.manifest.ohmyhost?.deployment === "production",
  );
  const localOnlyApps = appPackages.filter(
    (entry) => entry.manifest.ohmyhost?.deployment === "local-only",
  );
  if (productionApps.length === 0) {
    throw new Error("Fake-provider boundary found no production app manifests");
  }

  let resolvedFiles = 0;
  let artifactFiles = 0;
  let bundleMetafiles = 0;
  for (const app of productionApps) {
    const contract = await readProductionBuildContract(app, root);
    assertManifestClosure(app, workspacePackages);
    const files = await resolveTypescriptFiles({
      appName: app.name,
      appRoot: app.root,
      root,
      typescriptProject: contract.typescriptProject,
    });
    if (!Array.isArray(files)) {
      throw new TypeError(`TypeScript graph resolver returned invalid evidence for ${app.name}`);
    }
    if (files.length === 0) {
      throw new Error(`Production TypeScript graph is empty for ${app.name}`);
    }
    assertResolvedEntrypoints(app, contract, files, root);
    for (const file of files) {
      assertAllowedResolvedFile(app.name, file, root);
      resolvedFiles += 1;
    }
    const evidence = await inspectBuildEvidence(app, contract, root);
    artifactFiles += evidence.artifactFiles;
    bundleMetafiles += evidence.bundleMetafiles;
  }

  return Object.freeze({
    productionApps: Object.freeze(productionApps.map((entry) => entry.name)),
    localOnlyApps: Object.freeze(localOnlyApps.map((entry) => entry.name)),
    resolvedFiles,
    artifactFiles,
    bundleMetafiles,
  });
}

async function readWorkspacePackages(root) {
  const workspacePackages = new Map();
  for (const kind of WORKSPACE_DIRECTORIES) {
    const directory = join(root, kind);
    for (const entry of await readDirectoryOrEmpty(directory)) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(directory, entry.name);
      const manifestPath = join(packageRoot, "package.json");
      const manifestSource = await readOptionalText(manifestPath);
      if (manifestSource === undefined) continue;
      const manifest = parseJson(
        manifestSource,
        `Invalid package manifest: ${relative(root, manifestPath)}`,
      );
      if (typeof manifest?.name !== "string" || manifest.name.trim() === "") {
        throw new Error(`Workspace package name is missing: ${relative(root, manifestPath)}`);
      }
      if (workspacePackages.has(manifest.name)) {
        throw new Error(`Duplicate workspace package name: ${manifest.name}`);
      }
      workspacePackages.set(
        manifest.name,
        Object.freeze({ name: manifest.name, root: packageRoot, kind, manifest }),
      );
    }
  }
  return workspacePackages;
}

function assertDeploymentIdentity(app, root) {
  const deployment = app.manifest.ohmyhost?.deployment;
  const hasLocalOnlyName = LOCAL_ONLY_APP_NAMES.has(app.name);
  const hasLocalOnlyPath = normalizePath(relative(root, app.root)) === "apps/cli";
  if (hasLocalOnlyName !== hasLocalOnlyPath || (deployment === "local-only") !== hasLocalOnlyName) {
    throw new Error(
      "The local-only exception must be the exact apps/cli and @ohmyhost/cli package pair",
    );
  }
  if (deployment !== "local-only" && deployment !== "production") {
    throw new Error(`App ${app.name} must declare ohmyhost.deployment as production or local-only`);
  }
}

async function readProductionBuildContract(app, root) {
  const contract = app.manifest.ohmyhost?.fakeProviderBoundary;
  assertExactObjectKeys(
    contract,
    ["artifactRoot", "bundles", "entrypoints", "typescriptProject"],
    `fake-provider boundary contract for ${app.name}`,
  );
  if (contract.typescriptProject !== "tsconfig.build.json") {
    throw new Error(
      `Production app ${app.name} must bind its TypeScript graph to tsconfig.build.json`,
    );
  }
  if (contract.artifactRoot !== "dist") {
    throw new Error(`Production app ${app.name} must bind its build evidence to dist`);
  }
  const entrypoints = assertUniqueRelativePaths(
    contract.entrypoints,
    "src",
    `${app.name} entrypoints`,
  );
  if (entrypoints.length === 0) {
    throw new Error(`Production app ${app.name} must declare at least one entrypoint`);
  }
  for (const entrypoint of entrypoints) {
    if (!entrypoint.endsWith(".ts") || entrypoint.endsWith(".test.ts")) {
      throw new Error(`Production app ${app.name} declares an invalid entrypoint: ${entrypoint}`);
    }
  }
  if (!Array.isArray(contract.bundles)) {
    throw new Error(`Production app ${app.name} bundles must be an array`);
  }
  const bundles = contract.bundles.map((bundle, index) => {
    assertExactObjectKeys(bundle, ["entrypoint", "metafile"], `${app.name} bundle ${index}`);
    const [entrypoint] = assertUniqueRelativePaths(
      [bundle.entrypoint],
      "src",
      `${app.name} bundle ${index} entrypoint`,
    );
    const [metafile] = assertUniqueRelativePaths(
      [bundle.metafile],
      "dist",
      `${app.name} bundle ${index} metafile`,
    );
    if (!entrypoints.includes(entrypoint)) {
      throw new Error(
        `Production app ${app.name} bundle entrypoint is not declared: ${entrypoint}`,
      );
    }
    if (!metafile.endsWith(".json")) {
      throw new Error(`Production app ${app.name} bundle metafile must be JSON: ${metafile}`);
    }
    return Object.freeze({ entrypoint, metafile });
  });
  if (new Set(bundles.map((bundle) => bundle.metafile)).size !== bundles.length) {
    throw new Error(`Production app ${app.name} declares duplicate bundle metafiles`);
  }

  const build = app.manifest.scripts?.build;
  if (typeof build !== "string") {
    throw new Error(`Production app ${app.name} build script is missing`);
  }
  const tscCommands = build.match(/(?:^|&&\s*)tsc --project tsconfig\.build\.json(?=\s*&&|$)/gu);
  if (tscCommands?.length !== 1) {
    throw new Error(`Production app ${app.name} build script is not bound to tsconfig.build.json`);
  }
  const tsconfig = await readJson(join(app.root, contract.typescriptProject), root);
  if (
    tsconfig.compilerOptions?.noEmit !== false ||
    tsconfig.compilerOptions?.outDir !== contract.artifactRoot ||
    tsconfig.compilerOptions?.rootDir !== "src"
  ) {
    throw new Error(`Production app ${app.name} TypeScript output is not bound to dist from src`);
  }
  await assertBuildSegments(app, build, bundles);
  return Object.freeze({
    artifactRoot: contract.artifactRoot,
    bundles: Object.freeze(bundles),
    entrypoints: Object.freeze(entrypoints),
    typescriptProject: contract.typescriptProject,
  });
}

async function assertBuildSegments(app, build, bundles) {
  if (/[;\r\n|`<>#$()]/u.test(build) || /(^|[^&])&($|[^&])/u.test(build) || build.includes("\\")) {
    throw new Error(`Production app ${app.name} build script contains unsafe shell syntax`);
  }
  const segments = build.split("&&").map((segment) => segment.trim());
  const bundlerSegments = [];
  for (const segment of segments) {
    if (segment === "tsc --project tsconfig.build.json") continue;
    if (await isAllowedAuxiliaryBuildSegment(app, segment)) continue;
    if (/^(?:esbuild|wrangler deploy)\s/u.test(segment)) {
      bundlerSegments.push(segment);
      continue;
    }
    throw new Error(
      `Production app ${app.name} build script has an uninspected command: ${segment}`,
    );
  }

  const commandMetafiles = [];
  for (const segment of bundlerSegments) {
    const metafiles = readCommandOptions(segment, "metafile");
    if (metafiles.length !== 1) {
      throw new Error(`Production app ${app.name} bundler command requires exactly one --metafile`);
    }
    commandMetafiles.push(metafiles[0]);
    const outdirs = readCommandOptions(segment, "outdir");
    const outfiles = readCommandOptions(segment, "outfile");
    const outputs = [...outdirs, ...outfiles];
    if (outputs.length !== 1) {
      throw new Error(`Production app ${app.name} bundler command requires exactly one output`);
    }
    const [output] = outputs;
    if (output !== "dist" && !output.startsWith("dist/")) {
      throw new Error(`Production app ${app.name} bundler output escapes dist: ${output}`);
    }
    if (segment.startsWith("esbuild ")) {
      if ((segment.match(/(?:^|\s)--bundle(?=\s|$)/gu) ?? []).length !== 1) {
        throw new Error(`Production app ${app.name} esbuild command requires exactly one --bundle`);
      }
    } else if (
      outdirs.length !== 1 ||
      outfiles.length !== 0 ||
      readCommandOptions(segment, "config").length !== 1 ||
      (segment.match(/(?:^|\s)--dry-run(?=\s|$)/gu) ?? []).length !== 1
    ) {
      throw new Error(`Production app ${app.name} Wrangler command contract is invalid`);
    }
  }
  const declaredMetafiles = bundles.map((bundle) => bundle.metafile).sort();
  if (JSON.stringify(commandMetafiles.sort()) !== JSON.stringify(declaredMetafiles)) {
    throw new Error(`Production app ${app.name} bundler command has no exact declared metafile`);
  }

  for (const bundle of bundles) {
    const segment = bundlerSegments.find(
      (candidate) => readCommandOption(candidate, "metafile") === bundle.metafile,
    );
    if (segment === undefined) {
      throw new Error(`Production app ${app.name} bundle command is missing: ${bundle.metafile}`);
    }
    if (/(?:^|\s)esbuild(?:\s|$)/u.test(segment)) {
      if (!segment.split(/\s+/u).includes(bundle.entrypoint)) {
        throw new Error(
          `Production app ${app.name} esbuild entrypoint is not bound to its metafile`,
        );
      }
      continue;
    }
    const config = readCommandOption(segment, "config");
    if (config === undefined) {
      throw new Error(`Production app ${app.name} Wrangler bundle config is missing`);
    }
    const wranglerSource = await readFile(join(app.root, config), "utf8");
    const mainMatches = [...wranglerSource.matchAll(/"main"\s*:\s*"([^"]+)"/gu)];
    if (mainMatches.length !== 1 || mainMatches[0]?.[1] !== bundle.entrypoint) {
      throw new Error(
        `Production app ${app.name} Wrangler entrypoint is not bound to its metafile`,
      );
    }
  }
}

async function isAllowedAuxiliaryBuildSegment(app, segment) {
  const contract = APP_AUXILIARY_BUILD_CONTRACTS[app.name]?.[segment];
  if (contract === undefined) return false;
  if (contract.kind === "package-script") {
    return app.manifest.scripts?.[contract.name] === contract.value;
  }
  const source = await readFile(join(app.root, contract.path), "utf8");
  if (contract.kind === "reviewed-static-pages") {
    if (
      createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex") !== contract.sha256
    )
      throw new Error(`Production app ${app.name} reviewed page generator differs`);
    return true;
  }
  const forbidden = [
    /@ohmyhost\/(?:local-runner|testkit)\b/u,
    /(?:from\s+|import\s*\()["'](?:node:)?child_process["']/u,
    /(?:from\s+|import\s*\()["'](?:esbuild|wrangler)["']/u,
    /\b(?:exec|execFile|fork|spawn)\s*\(/u,
    /\b(?:FakeProviderStore|FakeStaticHostingProvider)\b/u,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error(`Production app ${app.name} auxiliary build script is not inspection-only`);
  }
  return true;
}

function readCommandOption(segment, name) {
  return readCommandOptions(segment, name)[0];
}

function readCommandOptions(segment, name) {
  return [...segment.matchAll(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)([^\\s]+)`, "gu"))]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
}

function assertManifestClosure(app, workspacePackages) {
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const dependency of Object.keys(readDependencyField(app.manifest, field))) {
      if (FORBIDDEN_PACKAGE_NAMES.has(dependency)) {
        throw new Error(
          `Production app ${app.name} declares forbidden ${field} package ${dependency}`,
        );
      }
    }
  }
  const visited = new Set();
  const visit = (entry, path) => {
    if (visited.has(entry.name)) return;
    visited.add(entry.name);
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(readDependencyField(entry.manifest, field)).sort()) {
        if (FORBIDDEN_PACKAGE_NAMES.has(dependency)) {
          throw new Error(
            `Production app ${app.name} reaches forbidden workspace package through ${[
              ...path,
              dependency,
            ].join(" -> ")}`,
          );
        }
        const workspaceDependency = workspacePackages.get(dependency);
        if (workspaceDependency !== undefined) visit(workspaceDependency, [...path, dependency]);
      }
    }
  };
  visit(app, [app.name]);
}

function readDependencyField(manifest, field) {
  const value = manifest?.[field];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function resolveProductionTypescriptFiles({ appName, appRoot, root, typescriptProject }) {
  const tsconfig = join(appRoot, typescriptProject);
  try {
    const { stdout } = await executeFile(
      "pnpm",
      ["exec", "tsc", "--project", tsconfig, "--listFilesOnly"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Unable to resolve the production TypeScript graph for ${appName}`, {
      cause: error,
    });
  }
}

function assertResolvedEntrypoints(app, contract, files, root) {
  const resolvedFiles = new Set(files.map((file) => normalizePath(resolve(root, file))));
  for (const entrypoint of contract.entrypoints) {
    if (!resolvedFiles.has(normalizePath(resolve(app.root, entrypoint)))) {
      throw new Error(
        `Production app ${app.name} entrypoint is absent from its TypeScript graph: ${entrypoint}`,
      );
    }
  }
}

function assertAllowedResolvedFile(appName, file, root) {
  if (typeof file !== "string" || file.trim() === "") {
    throw new TypeError(`Invalid resolved TypeScript file for ${appName}`);
  }
  const normalized = normalizePath(resolve(root, file));
  if (
    /\/packages\/(?:local-runner|testkit)(?:\/|$)/u.test(normalized) ||
    /\/(?:fake-provider-store|fake-static-hosting-provider)\.[cm]?[jt]s$/u.test(normalized)
  ) {
    throw new Error(
      `Production app ${appName} resolved TypeScript graph contains forbidden file ${normalizePath(
        relative(root, normalized),
      )}`,
    );
  }
}

async function inspectBuildEvidence(app, contract, root) {
  const dist = join(app.root, contract.artifactRoot);
  const entries = await readDirectoryOrEmpty(dist);
  if (entries.length === 0) {
    throw new Error(`Production build evidence is missing for ${app.name}`);
  }
  const files = await listArtifactFiles(dist);
  if (files.length === 0) {
    throw new Error(`Production build evidence contains no inspectable files for ${app.name}`);
  }
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN_ARTIFACT_PATTERNS) {
      const match = source.match(pattern);
      if (match !== null) {
        throw new Error(
          `Production app ${app.name} built artifact ${normalizePath(
            relative(root, file),
          )} contains forbidden ${match[0]}`,
        );
      }
    }
  }
  for (const entrypoint of contract.entrypoints) {
    const emitted = join(dist, entrypoint.replace(/^src\//u, "").replace(/\.ts$/u, ".js"));
    if ((await readOptionalText(emitted)) === undefined) {
      throw new Error(`Production app ${app.name} emitted entrypoint is missing: ${entrypoint}`);
    }
  }
  for (const bundle of contract.bundles) {
    const metafile = await readJson(join(app.root, bundle.metafile), root);
    const inputs = Object.keys(metafile.inputs ?? {}).map(normalizePath);
    const outputs = Object.keys(metafile.outputs ?? {}).map(normalizePath);
    if (
      !inputs.some(
        (input) => input === bundle.entrypoint || input.endsWith(`/${bundle.entrypoint}`),
      )
    ) {
      throw new Error(
        `Production app ${app.name} bundle metafile does not contain entrypoint ${bundle.entrypoint}`,
      );
    }
    if (outputs.length === 0 || outputs.some((output) => !output.startsWith("dist/"))) {
      throw new Error(`Production app ${app.name} bundle metafile has invalid outputs`);
    }
  }
  return Object.freeze({ artifactFiles: files.length, bundleMetafiles: contract.bundles.length });
}

async function listArtifactFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Production build evidence contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) files.push(...(await listArtifactFiles(path)));
    else if (entry.isFile() && ARTIFACT_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      files.push(path);
    }
  }
  return files.sort();
}

async function readDirectoryOrEmpty(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJson(path, root) {
  const source = await readOptionalText(path);
  if (source === undefined) {
    throw new Error(`Required boundary file is missing: ${normalizePath(relative(root, path))}`);
  }
  return parseJson(source, `Invalid boundary JSON: ${normalizePath(relative(root, path))}`);
}

function parseJson(source, message) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(`${label} has invalid fields`);
  }
}

function assertUniqueRelativePaths(value, requiredRoot, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const paths = value.map((path) => {
    if (
      typeof path !== "string" ||
      path === requiredRoot ||
      !path.startsWith(`${requiredRoot}/`) ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new Error(`${label} contains an unsafe path`);
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new Error(`${label} contains duplicate paths`);
  return paths;
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await verifyProductionFakeProviderBoundary();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Boundary verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
