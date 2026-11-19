/* global process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");

// This exact helper runs only local Git ignore checks and native file-ACL setup.
// Any source or emitted change needs review; other child-process imports stay forbidden.
const REVIEWED_TOKEN_FILE_HELPERS = new Map([
  [
    "apps/product-cli/src/user-token-file.ts",
    "b2d52f8add365319f799e53721af80d29afc97c9326f5676e5d30f7a32ca4372",
  ],
  [
    "apps/product-cli/dist/user-token-file.js",
    "46f4cbe6db0fd12f675ad5c69bb5cd31a2e3ac1ee3cf7777cd26359b187470f7",
  ],
]);

// This exact helper starts only the customer's own psql with a temporary database
// credential in its private environment. Any source or emitted change needs review.
const REVIEWED_PSQL_SESSION_HELPERS = new Map([
  [
    "apps/product-cli/src/psql-session.ts",
    "686702d3b9ad53b93a66065afb819c17691de5ed94ddb79ebe8441b32a444441",
  ],
  [
    "apps/product-cli/dist/psql-session.js",
    "715d2bb161c4b84503b6f77d1503e43c283cf611e265ebdf54af8c0448cc14c0",
  ],
]);

const reviewedChildProcessHelper = (root, file, source) => {
  const name = relative(root, file).split(sep).join("/");
  const pinned = REVIEWED_TOKEN_FILE_HELPERS.has(name)
    ? { expected: REVIEWED_TOKEN_FILE_HELPERS.get(name), label: "local credential-file helper" }
    : REVIEWED_PSQL_SESSION_HELPERS.has(name)
      ? { expected: REVIEWED_PSQL_SESSION_HELPERS.get(name), label: "local psql session helper" }
      : undefined;
  if (pinned === undefined) return false;
  const actual = createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
  if (actual !== pinned.expected) fail(`unreviewed ${pinned.label}: ${name}`);
  return true;
};

const FORBIDDEN_PACKAGE_PATTERNS = [
  /^@ohmyhost\/(?:database|local-runner|testkit|workos-token-verifier)$/u,
  /^@ohmyhost\/(?:control-api|orchestrator|webhook-ingress|workos-management)$/u,
  /^@ohmyhost\/(?:.*-)?providers?(?:-|$)/u,
  /^@workos-inc\//u,
  /^@infisical\/sdk/u,
  /^@aws-sdk\//u,
  /^@babel\//u,
  /^@google-cloud\/secret-manager$/u,
  /^@azure\/keyvault-secrets$/u,
  /^node-vault$/u,
  /^@hono(?:\/|$)/u,
  /^hono$/u,
  /^pg(?:-|$)/u,
  /^pg-native$/u,
  /^dotenv(?:-|$)/u,
  /^envalid$/u,
  /^env-var$/u,
  /^@t3-oss\/env-/u,
  /^(?:node:)?child_process$/u,
  /^cross-spawn$/u,
  /^execa$/u,
  /^shelljs$/u,
];

const ALLOWED_WORKOS_PUBLIC_IMPORTS = new Set([
  "@ohmyhost/workos-auth-contracts/user-api-keys",
  "@ohmyhost/workos-auth-contracts/device-flow",
  "@ohmyhost/workos-auth-contracts/parsing",
]);

const FORBIDDEN_PATH_PATTERN =
  /\/(?:packages\/(?:database|local-runner|testkit|workos-token-verifier|(?:[^/]*-)?providers?)(?:\/|$)|apps\/(?:control-api|orchestrator|workos-management|webhook-ingress)(?:\/|$))/u;

const LOGIN_FORBIDDEN_IDENTIFIERS = new Set([
  "authenticatedApi",
  "createProject",
  "GeneratedSdkProductApi",
  "getOperation",
  "productApi",
]);

export const verifyProductCliBoundary = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  runTypeScriptResolution = true,
} = {}) => {
  const source = verifyProductCliSourceBoundary({ repositoryRoot, runTypeScriptResolution });
  const build = verifyProductCliBuildEvidence({ repositoryRoot });
  return { source, build };
};

export const verifyProductCliSourceBoundary = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  runTypeScriptResolution = true,
} = {}) => {
  const root = resolve(repositoryRoot);
  const packages = readWorkspacePackages(root);
  const productPackage = packages.get("@ohmyhost/product-cli");
  if (productPackage === undefined) fail("missing @ohmyhost/product-cli workspace manifest");

  const manifestEvidence = verifyManifestGraph(productPackage, packages);
  const sourceEvidence = verifySourceGraph(root, productPackage, packages);
  const resolutionEvidence = runTypeScriptResolution
    ? verifyTypeScriptResolution(root)
    : { fileCount: 0, skipped: true };
  const loginEvidence = verifyLoginIsolation(join(productPackage.directory, "src", "cli.ts"));
  return {
    manifests: manifestEvidence,
    imports: sourceEvidence,
    typescriptResolution: resolutionEvidence,
    login: loginEvidence,
  };
};

export const verifyProductCliBuildEvidence = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) => {
  const root = resolve(repositoryRoot);
  const packages = readWorkspacePackages(root);
  const productPackage = packages.get("@ohmyhost/product-cli");
  if (productPackage === undefined) fail("missing @ohmyhost/product-cli workspace manifest");
  return verifyBuildGraph(root, productPackage, packages);
};

const readWorkspacePackages = (root) => {
  const result = new Map();
  for (const parent of ["apps", "packages"]) {
    const parentDirectory = join(root, parent);
    if (!existsSync(parentDirectory)) continue;
    for (const entry of readdirSync(parentDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parentDirectory, entry.name);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath, "workspace manifest");
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        fail(`workspace manifest has no package name: ${relative(root, manifestPath)}`);
      }
      result.set(manifest.name, { directory, manifest, manifestPath });
    }
  }
  return result;
};

const verifyManifestGraph = (entryPackage, packages) => {
  const visited = new Set();
  const queue = [entryPackage];
  let dependencyCount = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.manifest.name)) continue;
    visited.add(current.manifest.name);
    const dependencies = {
      ...asRecord(current.manifest.dependencies),
      ...asRecord(current.manifest.optionalDependencies),
    };
    for (const name of Object.keys(dependencies)) {
      dependencyCount += 1;
      assertAllowedSpecifier(name, `manifest ${current.manifest.name}`, {
        allowWorkosManifestRoot: true,
      });
      const workspaceDependency = packages.get(name);
      if (workspaceDependency !== undefined) queue.push(workspaceDependency);
    }
  }
  return { packageCount: visited.size, dependencyCount };
};

const verifySourceGraph = (root, entryPackage, packages) => {
  const entry = join(entryPackage.directory, "src", "bin.ts");
  if (!existsSync(entry)) fail("missing Product CLI source entry apps/product-cli/src/bin.ts");
  const visited = new Set();
  const queue = [entry];
  let importCount = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    assertAllowedPath(root, file, "source import graph");
    const source = readFileSync(file, "utf8");
    const localChildProcessHelper = reviewedChildProcessHelper(root, file, source);
    assertNoHelperProcessLoader(source, `source file ${relative(root, file)}`);
    for (const specifier of collectModuleSpecifiers(source)) {
      importCount += 1;
      if (!(localChildProcessHelper && specifier === "node:child_process"))
        assertAllowedSpecifier(specifier, `source import in ${relative(root, file)}`);
      const target = resolveSourceImport(file, specifier, packages);
      if (target !== undefined) queue.push(target);
    }
  }
  return { fileCount: visited.size, importCount };
};

const verifyTypeScriptResolution = (root) => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--project",
      join(root, "apps", "product-cli", "tsconfig.build.json"),
      "--listFilesOnly",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail("TypeScript resolution evidence could not be produced for Product CLI");
  }
  const files = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length === 0) fail("TypeScript resolution evidence was empty");
  for (const file of files) assertAllowedPath(root, file, "TypeScript resolution output");
  return { fileCount: files.length, skipped: false };
};

const verifyLoginIsolation = (cliPath) => {
  if (!existsSync(cliPath)) fail("missing Product CLI implementation for login isolation proof");
  const source = readFileSync(cliPath, "utf8");
  const methods = collectClassMethods(source, "ProductCli");
  const runMethod = methods.get("run");
  const login = methods.get("login");
  if (login === undefined || runMethod === undefined) {
    fail("ProductCli.run/login methods are required for login isolation proof");
  }
  const entryReachable = collectReachableMethods(methods, "run");
  const loginDispatcher = [...entryReachable].find((methodName) => {
    const body = methods.get(methodName);
    return (
      body !== undefined &&
      /command\.kind\s*===\s*["']login["'][\s\S]*?this\.login\s*\(/u.test(body)
    );
  });
  if (loginDispatcher === undefined) {
    fail("ProductCli.run graph does not dispatch login to the isolated login method");
  }

  const loginReachable = collectReachableMethods(methods, "login");
  for (const methodName of loginReachable) {
    const body = methods.get(methodName);
    if (body === undefined) continue;
    inspectLoginBody(body);
  }
  return {
    dispatchMethod: loginDispatcher,
    reachableMethods: [...loginReachable].sort(),
  };
};

const collectReachableMethods = (methods, entryMethod) => {
  const reachable = new Set([entryMethod]);
  const queue = [entryMethod];
  while (queue.length > 0) {
    const methodName = queue.shift();
    const body = methods.get(methodName);
    if (body === undefined) continue;
    for (const match of body.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/gu)) {
      const called = match[1];
      if (methods.has(called) && !reachable.has(called)) {
        reachable.add(called);
        queue.push(called);
      }
    }
  }
  return reachable;
};

const inspectLoginBody = (body) => {
  for (const identifier of LOGIN_FORBIDDEN_IDENTIFIERS) {
    const pattern = new RegExp(`\\b${identifier}\\b`, "u");
    if (pattern.test(body)) fail(`login reaches product mutation dependency '${identifier}'`);
  }
  const route = body.match(
    /["'`]([^"'`]*\/v1\/(?:projects|operations|audit)(?:\/|$)[^"'`]*)["'`]/u,
  )?.[1];
  if (route !== undefined) fail(`login embeds product-resource route '${route}'`);
};

const verifyBuildGraph = (root, entryPackage, packages) => {
  const entry = join(entryPackage.directory, "dist", "bin.js");
  if (!existsSync(entry)) fail("build evidence missing: apps/product-cli/dist/bin.js");
  const visited = new Set();
  const queue = [entry];
  let importCount = 0;
  let sourceMapCount = 0;
  let assetCount = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    assertAllowedPath(root, file, "emitted import graph");
    if (file.endsWith(".json")) {
      readJson(file, "emitted JSON asset");
      assetCount += 1;
      continue;
    }
    const emitted = readFileSync(file, "utf8");
    const localChildProcessHelper = reviewedChildProcessHelper(root, file, emitted);
    assertNoHelperProcessLoader(emitted, `emitted file ${relative(root, file)}`);
    const sourceMap = emitted.match(/\/\/# sourceMappingURL=([^\s]+)\s*$/u)?.[1];
    if (sourceMap === undefined) {
      fail(`build evidence missing source map reference: ${relative(root, file)}`);
    }
    verifySourceMap(root, file, sourceMap);
    sourceMapCount += 1;
    for (const specifier of collectModuleSpecifiers(emitted)) {
      importCount += 1;
      if (!(localChildProcessHelper && specifier === "node:child_process"))
        assertAllowedSpecifier(specifier, `emitted import in ${relative(root, file)}`);
      const target = resolveEmittedImport(file, specifier, packages);
      if (target !== undefined) queue.push(target);
    }
  }
  const metadataCount = verifyOptionalBundleMetadata(root, entryPackage, packages);
  const login = verifyLoginIsolation(join(entryPackage.directory, "dist", "cli.js"));
  return {
    fileCount: visited.size,
    importCount,
    sourceMapCount,
    assetCount,
    metadataCount,
    login,
  };
};

const verifySourceMap = (root, emittedPath, sourceMapReference) => {
  if (sourceMapReference.startsWith("data:")) {
    fail(`inline source maps are not retained build evidence: ${relative(root, emittedPath)}`);
  }
  const mapPath = resolve(dirname(emittedPath), sourceMapReference);
  if (!existsSync(mapPath)) fail(`build evidence missing source map: ${relative(root, mapPath)}`);
  const map = readJson(mapPath, "source map");
  if (map.version !== 3 || !Array.isArray(map.sources) || map.sources.length === 0) {
    fail(`invalid source map evidence: ${relative(root, mapPath)}`);
  }
  for (const source of map.sources) {
    if (typeof source !== "string" || source.length === 0) {
      fail(`invalid source path in source map: ${relative(root, mapPath)}`);
    }
    const sourcePath = resolve(
      dirname(mapPath),
      typeof map.sourceRoot === "string" ? map.sourceRoot : "",
      source,
    );
    if (!existsSync(sourcePath)) {
      fail(`source map references missing source: ${relative(root, sourcePath)}`);
    }
    assertAllowedPath(root, sourcePath, "source map");
  }
};

const verifyOptionalBundleMetadata = (root, entryPackage, packages) => {
  let count = 0;
  const reachablePackages = collectManifestPackages(entryPackage, packages);
  for (const packageEntry of reachablePackages) {
    const dist = join(packageEntry.directory, "dist");
    if (!existsSync(dist)) continue;
    for (const file of walkFiles(dist)) {
      if (!/(?:bundle|meta(?:file|data)?)[^/]*\.json$/iu.test(file)) continue;
      count += 1;
      const metadata = readJson(file, "bundle metadata");
      scanMetadata(metadata, relative(root, file));
    }
  }
  return count;
};

const collectManifestPackages = (entryPackage, packages) => {
  const result = [];
  const visited = new Set();
  const queue = [entryPackage];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.manifest.name)) continue;
    visited.add(current.manifest.name);
    result.push(current);
    const dependencies = {
      ...asRecord(current.manifest.dependencies),
      ...asRecord(current.manifest.optionalDependencies),
    };
    for (const name of Object.keys(dependencies)) {
      const dependency = packages.get(name);
      if (dependency !== undefined) queue.push(dependency);
    }
  }
  return result;
};

const scanMetadata = (value, context) => {
  if (typeof value === "string") {
    assertAllowedSpecifier(value, `bundle metadata ${context}`);
    assertNoHelperProcessLoader(value, `bundle metadata ${context}`);
    const normalized = value.replaceAll("\\", "/");
    if (FORBIDDEN_PATH_PATTERN.test(normalized.startsWith("/") ? normalized : `/${normalized}`)) {
      fail(`forbidden path in bundle metadata ${context}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanMetadata(item, context);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      scanMetadata(key, context);
      scanMetadata(item, context);
    }
  }
};

const collectModuleSpecifiers = (source) => {
  const result = new Set();
  for (const match of source.matchAll(
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gu,
  )) {
    result.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
    result.add(match[1]);
  }
  return [...result];
};

const collectClassMethods = (source, className) => {
  const classMatch = new RegExp(`\\bclass\\s+${className}\\b`, "u").exec(source);
  if (classMatch === null) return new Map();
  const classOpen = source.indexOf("{", classMatch.index + classMatch[0].length);
  if (classOpen < 0) return new Map();
  const classBody = extractBalancedBlock(source, classOpen);
  const methods = new Map();
  const methodPattern =
    /\b(?:(?:public|private|protected|static|readonly|override)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::[^={]+)?\s*\{/gu;
  const nonMethods = new Set(["catch", "for", "if", "switch", "while"]);
  for (const match of classBody.matchAll(methodPattern)) {
    if (nonMethods.has(match[1])) continue;
    const open = classOpen + match.index + match[0].lastIndexOf("{");
    methods.set(match[1], extractBalancedBlock(source, open));
  }
  return methods;
};

const extractBalancedBlock = (source, open) => {
  let depth = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  fail("unbalanced class or method body in Product CLI source");
};

const resolveSourceImport = (from, specifier, packages) => {
  if (specifier.startsWith(".")) {
    return resolveModuleFile(dirname(from), specifier, [".ts", ".tsx"]);
  }
  const parsed = parsePackageSpecifier(specifier);
  const targetPackage = packages.get(parsed.name);
  if (targetPackage === undefined) return undefined;
  return resolvePackageExport(targetPackage, parsed.subpath, "source");
};

const resolveEmittedImport = (from, specifier, packages) => {
  if (specifier.startsWith(".")) {
    return resolveModuleFile(dirname(from), specifier, [".js", ".mjs"]);
  }
  const parsed = parsePackageSpecifier(specifier);
  const targetPackage = packages.get(parsed.name);
  if (targetPackage === undefined) return undefined;
  return resolvePackageExport(targetPackage, parsed.subpath, "import");
};

const resolvePackageExport = (packageEntry, subpath, condition) => {
  const exports = packageEntry.manifest.exports;
  const key = subpath === "" ? "." : `./${subpath}`;
  const declaration = typeof exports === "object" && exports !== null ? exports[key] : undefined;
  const target = typeof declaration === "string" ? declaration : declaration?.[condition];
  if (typeof target !== "string") {
    fail(`workspace package ${packageEntry.manifest.name} has no ${condition} export for ${key}`);
  }
  const resolved = resolve(packageEntry.directory, target);
  if (!existsSync(resolved)) {
    fail(`${condition} export evidence is missing: ${resolved}`);
  }
  return resolved;
};

const resolveModuleFile = (directory, specifier, extensions) => {
  const raw = resolve(directory, specifier);
  const withoutJs = raw.replace(/\.(?:m?js)$/u, "");
  const candidates = [raw, ...extensions.map((extension) => `${withoutJs}${extension}`)];
  const target = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (target === undefined) fail(`could not resolve import '${specifier}' from ${directory}`);
  return target;
};

const parsePackageSpecifier = (specifier) => {
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return { name, subpath: segments.slice(specifier.startsWith("@") ? 2 : 1).join("/") };
};

const assertAllowedSpecifier = (specifier, context, { allowWorkosManifestRoot = false } = {}) => {
  if (typeof specifier !== "string") return;
  const parsed =
    specifier.startsWith(".") || specifier.startsWith("/")
      ? undefined
      : parsePackageSpecifier(specifier);
  if (
    parsed !== undefined &&
    FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(parsed.name))
  ) {
    fail(`forbidden dependency '${specifier}' in ${context}`);
  }
  if (
    (specifier === "@ohmyhost/workos-auth-contracts" ||
      specifier.startsWith("@ohmyhost/workos-auth-contracts/")) &&
    !(allowWorkosManifestRoot && specifier === "@ohmyhost/workos-auth-contracts") &&
    !ALLOWED_WORKOS_PUBLIC_IMPORTS.has(specifier)
  ) {
    fail(`Product CLI imports non-public WorkOS surface '${specifier}'`);
  }
};

const assertNoHelperProcessLoader = (source, context) => {
  const forbidden = source.match(
    /\b(?:createRequire|execFileSync?|execSync|fork|spawnSync?)\b|\brequire\s*\(\s*["'](?:node:)?child_process["']/u,
  )?.[0];
  if (forbidden !== undefined) {
    fail(`forbidden helper-process or runtime-loader primitive '${forbidden}' in ${context}`);
  }
};

const assertAllowedPath = (root, file, context) => {
  const normalized = resolve(file).split(sep).join("/");
  if (FORBIDDEN_PATH_PATTERN.test(normalized)) {
    fail(`forbidden path in ${context}: ${relative(root, file)}`);
  }
};

const asRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

const readJson = (path, kind) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid ${kind}: ${path}`, error);
  }
};

const walkFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const fail = (message, cause) => {
  throw new Error(`PRODUCT_CLI_BOUNDARY: ${message}`, cause === undefined ? undefined : { cause });
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const evidence = verifyProductCliBoundary();
    process.stdout.write(
      `PASS source/static verification: ${evidence.source.manifests.packageCount} manifests, ${evidence.source.imports.fileCount} source files, ${evidence.source.typescriptResolution.fileCount} TypeScript-resolved files; login reachable methods=${evidence.source.login.reachableMethods.join(",")}\n`,
    );
    process.stdout.write(
      `PASS build evidence: ${evidence.build.fileCount} emitted files, ${evidence.build.sourceMapCount} source maps, ${evidence.build.assetCount} JSON assets, ${evidence.build.metadataCount} optional bundle metadata files; login reachable methods=${evidence.build.login.reachableMethods.join(",")}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
