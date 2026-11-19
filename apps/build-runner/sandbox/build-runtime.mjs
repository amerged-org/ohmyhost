import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { parse as parseJavaScript } from "acorn";
import { parse as parseApplicationJavaScript, parseExpression } from "@babel/parser";
import { initSync, parse as parseModuleSpecifiers } from "es-module-lexer";
import { parseBrowserPolicy } from "../../../packages/contracts/src/browser-capabilities.ts";
import { managedCustomerAuthAdmissionIssue } from "../../../packages/contracts/src/customer-auth-admission.ts";
import { isCustomerEgressOrigin } from "../../../packages/contracts/src/egress-origin.ts";
import {
  frameworkVersionMinimum,
  frameworkVersionVerdict,
  isAdmittedFrameworkBuildScript,
  nextBuildArguments,
  parseStableVersion,
  PINNED_BUN_VERSION,
} from "../../../packages/contracts/src/framework-build-script.mjs";

initSync();

const FRAMEWORK_PLAN_SCHEMA_VERSION = "ohmyhost.framework-plan/v5";
const MAXIMUM_NEXT_WRANGLER_SOURCE_MAP_BYTES = 24 * 1024 * 1024;
const MAXIMUM_NEXT_WRANGLER_METAFILE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_MIGRATION_FILES = 128;
const MAXIMUM_MIGRATION_FILE_BYTES = 256 * 1024;
const MAXIMUM_MIGRATION_TOTAL_BYTES = 2 * 1024 * 1024;
const BUILD_FAILURE_SCHEMA_VERSION = "ohmyhost.build-failure/v1";
const BUILD_FAILURE_READ_BYTES = 64 * 1024;
const BUILD_FAILURE_MAXIMUM_CHARACTERS = 16384;
const BUILD_FAILURE_MAXIMUM_LINES = 200;
const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ESCAPE = String.fromCodePoint(0x1b);
const BELL = String.fromCodePoint(0x07);
// OSC (title/hyperlink) sequences, CSI colour/cursor sequences and two-byte escapes.
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)|${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}[@-Z\\\\-_]`,
  "gu",
);
// Every C0/C1 control character except the tab and newline that structure the excerpt.
const CONTROL_CHARACTER_PATTERN = /(?![\t\n])\p{Cc}/gu;
const YARN_MINIMUM_MAJOR = 3;
const PACKAGE_MANAGER_DECLARATION =
  /^(bun|npm|pnpm|yarn)@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;
const PACKAGE_MANAGER_CONTRACTS = Object.freeze({
  bun: Object.freeze({
    lockfiles: Object.freeze(["bun.lock", "bun.lockb"]),
    installCommand: "bun install --frozen-lockfile --ignore-scripts",
    buildCommand: "bun run build",
  }),
  npm: Object.freeze({
    lockfiles: Object.freeze(["package-lock.json"]),
    installCommand: "npm ci --ignore-scripts",
    buildCommand: "npm run build",
  }),
  pnpm: Object.freeze({
    lockfiles: Object.freeze(["pnpm-lock.yaml"]),
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
  }),
  yarn: Object.freeze({
    lockfiles: Object.freeze(["yarn.lock"]),
    installCommand: "yarn install --immutable --mode=skip-build",
    buildCommand: "yarn run build",
  }),
});
const ALL_LOCKFILES = Object.freeze(
  Object.values(PACKAGE_MANAGER_CONTRACTS).flatMap(({ lockfiles }) => lockfiles),
);
// The planned framework packages of each adapter whose installed versions the floors govern.
const INSTALLED_FRAMEWORK_PACKAGES = Object.freeze({
  astro: Object.freeze(["astro"]),
  nextjs: Object.freeze(["next"]),
  "vite-static": Object.freeze(["vite"]),
  "tanstack-start": Object.freeze(["@tanstack/react-start", "vite"]),
});
const RESERVED_BUILD_PATHS = Object.freeze([
  ".ohmyhost",
  ".open-next",
  ".ohmyhost-next-wrangler.jsonc",
  ".ohmyhost-open-next.config.ts",
  ".ohmyhost-tanstack-wrangler.jsonc",
  ".ohmyhost-astro-wrangler.jsonc",
  ".ohmyhost-vite-companion.jsonc",
  ".ohmyhost-vite-entry.ts",
  ".ohmyhost-functions-wrangler.jsonc",
  ".ohmyhost-functions-entry.ts",
  ".ohmyhost-next-metafile.json",
  ".ohmyhost-next-worker.js.gz",
  ".ohmyhost-resolved-dependencies.json",
  ".ohmyhost-worker",
]);
const TANSTACK_PLATFORM_CONFIG_NAME = ".ohmyhost-tanstack-wrangler.jsonc";
const FUNCTIONS_PLATFORM_CONFIG_NAME = ".ohmyhost-functions-wrangler.jsonc";
const FUNCTIONS_PLATFORM_ENTRY_NAME = ".ohmyhost-functions-entry.ts";
const FUNCTIONS_OUTPUT_DIRECTORY = ".ohmyhost/functions";
const FUNCTIONS_WORKER_MODULE = "ohmyhost-worker.js";
const WORKER_MODULE_SOURCE = "src/ohmyhost/worker.ts";
const WORKER_MODULE_BYTE_LIMIT = 5_242_880;
const CRON_PATTERN =
  /^(?:\*\/(?:[5-9]|[1-5][0-9])|[0-9]|[1-5][0-9]) (?:\*|[0-9]|1[0-9]|2[0-3]) (?:\*|[1-9]|[12][0-9]|3[01]) (?:\*|[1-9]|1[0-2]) (?:\*|[0-6])$/u;
const OPEN_NEXT_PLATFORM_CONFIG_NAME = ".ohmyhost-open-next.config.ts";
const OPEN_NEXT_PLATFORM_IMPORT =
  "/opt/ohmyhost-platform/lib/node_modules/@opennextjs/cloudflare/dist/api/index.js";
const OPEN_NEXT_PLATFORM_PACKAGE_ROOT = path.dirname(
  path.dirname(path.dirname(OPEN_NEXT_PLATFORM_IMPORT)),
);
const NEXT_CACHE_ASSET_DIRECTORY = "cdn-cgi/_next_cache";
const DEFAULT_SSG_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAXIMUM_SSG_CACHE_BYTES = 64 * 1024 * 1024;
const NEXT_SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts"];
const NEXT_REVALIDATION_UNSUPPORTED =
  "Next.js on-demand or time-based revalidation is not supported by this read-only hosting cache. Import functions from next/cache by name and leave out revalidateTag, revalidatePath, updateTag, unstable_expireTag, unstable_expirePath and unstable_cache, remove res.revalidate and fetch next.revalidate values other than 0 or false, then commit, push and deploy the new commit.";
const NEXT_PRERENDER_REVALIDATION_UNSUPPORTED =
  "Next.js time-based revalidation of prerendered pages and route handlers is not supported by this read-only hosting cache. Keep build-time static pages or ordinary request-time rendering: remove revalidate values other than 0 or false from route segment config, getStaticProps and fetch next options, then commit, push and deploy the new commit.";
// Every built-in cacheLife profile revalidates, so a "use cache" value prerendered into a static
// shell gives its route a finite revalidate time that this cache never honours.
const NEXT_SHELL_REVALIDATION_UNSUPPORTED =
  'Next.js time-based revalidation of prerendered pages and route handlers is not supported by this read-only hosting cache: a revalidate setting or a "use cache" value in a Cache Components static shell would stay frozen until the next deployment. Call cached functions inside a Suspense boundary after reading request data (for example await connection()), give build-time values cacheLife({ revalidate: Infinity, expire: Infinity }), or remove the revalidation, then commit, push and deploy the new commit.';
const NEXT_BLOCKING_PRERENDER_UNSUPPORTED =
  "Next.js Cache Components pages that are prerendered while a visitor waits are not supported by this hosting: Workers stop such a request and later requests for the same page. Give each dynamic page a static shell by reading params inside a Suspense boundary, without ensureStatic and without a root layout inside a dynamic segment; with partialPrefetching: true, also remove generateStaticParams from dynamic pages, then commit, push and deploy the new commit.";
// The next/cache exports a build may import or re-export: they configure "use cache", opt out of
// caching, place rendering (io, navigation, prefetch) or refresh a client router (refresh), and none
// of them refreshes a deployment. Every other export revalidates or needs a writable cache.
const NEXT_CACHE_IMPORTS = new Set([
  "cacheLife",
  "cacheTag",
  "io",
  "navigation",
  "prefetch",
  "refresh",
  "unstable_cacheLife",
  "unstable_cacheTag",
  "unstable_noStore",
]);
// Next.js inflates the cache data of a resumed shell up to five times this limit, and workerd
// inflates at most 128 MiB at once; Next.js reads the value as bytes or with a binary unit.
const NEXT_POSTPONED_STATE_LIMIT = "25 MB";
const NEXT_POSTPONED_STATE_LIMIT_BYTES = 25 * 1024 * 1024;
const TANSTACK_DEPLOY_REDIRECT_PATH = ".wrangler/deploy/config.json";
const TANSTACK_DEPLOY_REDIRECT_TARGET = "../../dist/server/wrangler.json";
const TANSTACK_GENERATED_CONFIG_KEYS = Object.freeze(
  [
    "configPath",
    "userConfigPath",
    "topLevelName",
    "definedEnvironments",
    "compatibility_date",
    "compatibility_flags",
    "jsx_factory",
    "jsx_fragment",
    "rules",
    "name",
    "main",
    "triggers",
    "assets",
    "vars",
    "durable_objects",
    "workflows",
    "migrations",
    "exports",
    "kv_namespaces",
    "cloudchamber",
    "send_email",
    "queues",
    "connect",
    "r2_buckets",
    "d1_databases",
    "vectorize",
    "ai_search_namespaces",
    "ai_search",
    "agent_memory",
    "hyperdrive",
    "services",
    "analytics_engine_datasets",
    "dispatch_namespaces",
    "mtls_certificates",
    "pipelines",
    "secrets_store_secrets",
    "artifacts",
    "unsafe_hello_world",
    "flagship",
    "worker_loaders",
    "ratelimits",
    "vpc_services",
    "vpc_networks",
    "logfwdr",
    "python_modules",
    "dev",
    "no_bundle",
  ].sort(),
);
const TANSTACK_EMPTY_GENERATED_CAPABILITY_FIELDS = Object.freeze([
  "triggers",
  "vars",
  "durable_objects",
  "workflows",
  "migrations",
  "exports",
  "kv_namespaces",
  "cloudchamber",
  "send_email",
  "queues",
  "connect",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "worker_loaders",
  "ratelimits",
  "vpc_services",
  "vpc_networks",
  "logfwdr",
  "python_modules",
]);
const TANSTACK_EMPTY_ARRAY_FIELDS = new Set([
  "workflows",
  "migrations",
  "kv_namespaces",
  "send_email",
  "connect",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "worker_loaders",
  "ratelimits",
  "vpc_services",
  "vpc_networks",
]);
const TANSTACK_GENERATED_DEV_DEFAULT_KEYS = Object.freeze([
  "enable_containers",
  "generate_types",
  "ip",
  "local_protocol",
  "upstream_protocol",
]);
const CREDENTIAL_SCAN_SCHEMA = "ohmyhost.credential-scan/v1";
const CREDENTIAL_SCAN_RULES = Object.freeze([
  "build-environment-allowlist",
  "operation-scoped-input-output",
  "reserved-platform-build-paths",
]);

// A build-output limit the customer can fix is reported as one fixed line with this prefix; the
// agent copies only such lines of root's packaging output into the customer's build log.
export const PACKAGING_LINE_PREFIX = "ohmyho.st packaging: ";
const STATIC_FILE_LIMITS = "25 MiB and 1,000 files in total";

/** A build-output limit the customer broke; its message names only their own output. */
export class PackagingLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackagingLimitError";
  }
}

/** The customer-safe packaging line of a recognized failure, without customer source or errors. */
export function packagingFailureLine(error) {
  if (error instanceof PackagingLimitError) return `${PACKAGING_LINE_PREFIX}${error.message}`;
  const messages = {
    "TanStack Worker output is invalid":
      "the TanStack Worker output is invalid or incompatible; check the TanStack and Cloudflare Vite build configuration and deploy again",
    "generated Worker config capability is invalid":
      "the TanStack Worker output declares an unsupported Cloudflare capability; remove it from the build configuration and deploy again",
    "generated Worker config metadata is invalid":
      "the TanStack Worker output has unsupported generated metadata; check the Cloudflare Vite build configuration and deploy again",
    "TanStack Worker source maps are unsupported":
      "the TanStack Worker output contains source maps; set environments.ssr.build.sourcemap to false in the Vite configuration and deploy again",
    "compiled output contains a non-root framework asset prefix":
      "compiled framework assets use a non-root prefix; configure the framework asset base as '/' and deploy again",
  };
  const message =
    error instanceof Error && Object.hasOwn(messages, error.message)
      ? messages[error.message]
      : undefined;
  return message === undefined ? null : `${PACKAGING_LINE_PREFIX}${message}`;
}

/** A refused installed framework version; its message is the complete customer-safe line. */
export class FrameworkVersionRefusal extends Error {
  constructor(line) {
    super(line);
    this.name = "FrameworkVersionRefusal";
  }
}

const USER_BUILD_SCRIPT = `#!/bin/bash
set -euo pipefail
cd "$1"
read -r package_manager package_manager_version < <(node /opt/ohmyho/build-runtime.mjs read-package-manager /tmp/ohmyho/package-manager.json)
# Yarn 2 and later install node_modules instead of Plug'n'Play; the other managers ignore this.
export YARN_NODE_LINKER=node-modules
# Copy pnpm store imports; links created by customer code still fail the packaging checks.
# Earlier pnpm needs the generic CLI override; pnpm 12.0 also needs the environment setting.
case "$package_manager:$INSTALL_COMMAND" in
  'bun:bun install --frozen-lockfile --ignore-scripts') /opt/ohmyhost-platform/bin/bun install --frozen-lockfile --ignore-scripts ;;
  'npm:npm ci --ignore-scripts') npm exec --yes --ignore-scripts --package="npm@$package_manager_version" -- npm ci --ignore-scripts ;;
  'pnpm:pnpm install --frozen-lockfile --ignore-scripts') pnpm_config_package_import_method=copy /opt/ohmyhost-platform/bin/corepack "pnpm@$package_manager_version" install --frozen-lockfile --ignore-scripts --config.package-import-method=copy ;;
  'yarn:yarn install --immutable --mode=skip-build') /opt/ohmyhost-platform/bin/corepack "yarn@$package_manager_version" install --immutable --mode=skip-build ;;
  *) exit 64 ;;
esac
if test "$FRAMEWORK_RUNTIME" != "functions"; then
  build_arguments=()
  if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = "nextjs:edge"; then
    export NEXT_PRIVATE_STANDALONE=true
  fi
  # The installed framework versions pass the shared security floors before any customer code runs;
  # a refusal writes its one line to stderr, which the customer's log keeps.
  framework_build_argument="$(node /opt/ohmyho/build-runtime.mjs framework-build-argument)"
  if test -n "$framework_build_argument"; then build_arguments=("$framework_build_argument"); fi
  if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = "astro:edge"; then
    export CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$(pwd)/.ohmyhost-astro-wrangler.jsonc"
  fi
  if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = "tanstack-start:edge"; then
    export CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$(pwd)/.ohmyhost-tanstack-wrangler.jsonc"
  fi
  case "$package_manager:$BUILD_COMMAND" in
    'bun:bun run build') /opt/ohmyhost-platform/bin/bun run build "\${build_arguments[@]}" ;;
    'npm:npm run build') npm exec --yes --ignore-scripts --package="npm@$package_manager_version" -- npm run build -- "\${build_arguments[@]}" ;;
    'pnpm:pnpm run build') /opt/ohmyhost-platform/bin/corepack "pnpm@$package_manager_version" run build "\${build_arguments[@]}" ;;
    'yarn:yarn run build') /opt/ohmyhost-platform/bin/corepack "yarn@$package_manager_version" run build "\${build_arguments[@]}" ;;
    *) exit 64 ;;
  esac
  if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = "nextjs:edge"; then
    node /opt/ohmyho/build-runtime.mjs next-cache-validate
    node /opt/ohmyho/build-runtime.mjs next-platform-config .ohmyhost-next-wrangler.jsonc
    node /opt/ohmyho/build-runtime.mjs next-open-next-config .ohmyhost-open-next.config.ts
    /opt/ohmyhost-platform/bin/opennextjs-cloudflare build --skipNextBuild --config=.ohmyhost-next-wrangler.jsonc --openNextConfigPath=.ohmyhost-open-next.config.ts
    node /opt/ohmyho/build-runtime.mjs next-cache-populate
  fi
  if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = "vite-static:edge"; then
    node /opt/ohmyho/build-runtime.mjs vite-companion-config .ohmyhost-vite-companion.jsonc
    WRANGLER_SEND_METRICS=false /opt/ohmyhost-platform/bin/wrangler deploy --dry-run --outdir .ohmyhost/vite-companion --config .ohmyhost-vite-companion.jsonc
    node /opt/ohmyho/build-runtime.mjs finalize-vite-companion
    rm .ohmyhost-vite-companion.jsonc .ohmyhost-vite-entry.ts
  fi
  if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = "nextjs:edge"; then
    WRANGLER_SEND_METRICS=false /opt/ohmyhost-platform/bin/wrangler deploy --dry-run --outdir .ohmyhost-worker --metafile .ohmyhost-next-metafile.json --config .ohmyhost-next-wrangler.jsonc
    node /opt/ohmyho/build-runtime.mjs cleanup-next-platform-config "$(pwd)"
    test ! -e .ohmyhost-next-worker.js.gz
    gzip -n -c .ohmyhost-worker/worker.js > .ohmyhost-next-worker.js.gz
    test "$(stat -c %s .ohmyhost-next-worker.js.gz)" -le 10485760 || { echo 'ohmyho.st packaging: the Next.js Worker is more than 10485760 bytes gzip-compressed; it may be at most 10485760 bytes'; exit 1; }
  fi
fi
if test "$FRAMEWORK_RUNTIME" = "functions" || { test -n "$FUNCTIONS_REQUIREMENT_JSON" && test "$FRAMEWORK_ADAPTER" != "vite-static"; }; then
  node /opt/ohmyho/build-runtime.mjs functions-config .ohmyhost-functions-wrangler.jsonc
  WRANGLER_SEND_METRICS=false /opt/ohmyhost-platform/bin/wrangler deploy --dry-run --outdir .ohmyhost/functions --config .ohmyhost-functions-wrangler.jsonc
  node /opt/ohmyho/build-runtime.mjs finalize-functions
  rm .ohmyhost-functions-wrangler.jsonc .ohmyhost-functions-entry.ts
fi
test ! -e .ohmyhost-resolved-dependencies.json
node /opt/ohmyho/build-runtime.mjs dependency-inventory .ohmyhost-resolved-dependencies.json
`;

const ROOT_PACKAGE_SCRIPT = `#!/bin/bash
set -euo pipefail
cd "$(cat /tmp/ohmyho/application-root)"
if test "$FRAMEWORK_ADAPTER:$FRAMEWORK_RUNTIME" = 'nextjs:edge'; then
  node /opt/ohmyho/build-runtime.mjs validate-next-metafile .ohmyhost-next-metafile.json
  rm .ohmyhost-next-metafile.json
fi
export OHMYHOST_MIGRATION_SNAPSHOT_ROOT=/tmp/ohmyho/migration-snapshot
node /opt/ohmyho/build-runtime.mjs package .ohmyhost-next-worker.js.gz
test "$(stat -c %s /tmp/ohmyho/bundle/manifest.json)" -le 1048576 || { echo 'ohmyho.st packaging: the deployment manifest is more than 1048576 bytes; fewer static files and Worker modules keep it smaller'; exit 1; }
test "$(stat -c %s /tmp/ohmyho/bundle/sbom.cdx.json)" -le 4194304 || { echo 'ohmyho.st packaging: the dependency inventory (SBOM) is more than 4194304 bytes; fewer installed packages keep it smaller'; exit 1; }
`;

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function writeUserBuildScript(outputPath) {
  if (outputPath !== "/tmp/ohmyho/user-build.sh" || fs.existsSync(outputPath)) {
    throw new Error("user build script output is invalid");
  }
  fs.writeFileSync(outputPath, USER_BUILD_SCRIPT, { flag: "wx", mode: 0o555 });
}

export function writeRootPackageScript(outputPath) {
  if (outputPath !== "/tmp/ohmyho/root-package.sh" || fs.existsSync(outputPath)) {
    throw new Error("root package script output is invalid");
  }
  fs.writeFileSync(outputPath, ROOT_PACKAGE_SCRIPT, { flag: "wx", mode: 0o555 });
}

/** The customer-visible tail of a failed build: newest lines, terminal noise removed, bounded. */
export function createBuildFailureExcerpt(tail, logBytes) {
  if (
    !(tail instanceof Uint8Array) ||
    !Number.isSafeInteger(logBytes) ||
    logBytes < tail.byteLength
  ) {
    throw new TypeError("build log tail is invalid");
  }
  let truncated = logBytes > tail.byteLength;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(tail);
  if (truncated) text = text.replace(/^\uFFFD+/u, "");
  text = text.replace(TERMINAL_ESCAPE_PATTERN, "").replace(/\r\n/gu, "\n");
  let lines = text.split("\n").map((line) =>
    line
      .slice(line.lastIndexOf("\r") + 1)
      .replace(CONTROL_CHARACTER_PATTERN, "")
      .trimEnd(),
  );
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length > BUILD_FAILURE_MAXIMUM_LINES) {
    lines = lines.slice(-BUILD_FAILURE_MAXIMUM_LINES);
    truncated = true;
  }
  let excerpt = lines.join("\n");
  if (excerpt.length > BUILD_FAILURE_MAXIMUM_CHARACTERS) {
    excerpt = excerpt.slice(-BUILD_FAILURE_MAXIMUM_CHARACTERS);
    const newline = excerpt.indexOf("\n");
    if (newline !== -1) excerpt = excerpt.slice(newline + 1);
    excerpt = excerpt.replace(/^[\uDC00-\uDFFF]/u, "");
    truncated = true;
  }
  if (excerpt === "") throw new Error("build log has no printable output");
  return Object.freeze({ excerpt, truncated });
}

/** The `ohmyhost.build-failure/v1` document the agent reports for a failed build. */
export function readBuildFailureExcerpt({ logPath, operationId }) {
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("build failure excerpt requires the operation ID");
  }
  const descriptor = fs.openSync(logPath, "r");
  let tail;
  let logBytes;
  try {
    logBytes = fs.fstatSync(descriptor).size;
    const length = Math.min(logBytes, BUILD_FAILURE_READ_BYTES);
    tail = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(descriptor, tail, read, length - read, logBytes - length + read);
      if (count === 0) break;
      read += count;
    }
    if (read !== length) throw new Error("build log changed while reading");
  } finally {
    fs.closeSync(descriptor);
  }
  const bounded = createBuildFailureExcerpt(tail, logBytes);
  return Object.freeze({
    schemaVersion: BUILD_FAILURE_SCHEMA_VERSION,
    operationId,
    excerpt: bounded.excerpt,
    truncated: bounded.truncated,
    logBytes,
  });
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function validateApplicationRoot(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 64 ||
    !/^(?:\.|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.test(value)
  ) {
    throw new Error("application root is invalid");
  }
  const segments = value === "." ? [] : value.split("/");
  if (segments.length > 8 || segments.some((segment) => Buffer.byteLength(segment, "utf8") > 63)) {
    throw new Error("application root is invalid");
  }
  return value;
}

export function validateRuntimePolicyJson(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new Error("runtime policy is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("runtime policy is invalid");
  }
  if (
    !hasExactKeys(parsed, [
      ...(parsed.browser === undefined ? [] : ["browser"]),
      "egressAllowedOrigins",
      "healthCheckPath",
    ]) ||
    typeof parsed.healthCheckPath !== "string" ||
    parsed.healthCheckPath.length < 1 ||
    parsed.healthCheckPath.length > 256 ||
    !parsed.healthCheckPath.startsWith("/") ||
    parsed.healthCheckPath.startsWith("//") ||
    /[\\?#]/u.test(parsed.healthCheckPath) ||
    parsed.healthCheckPath.split("/").some((segment) => segment === "." || segment === "..") ||
    !Array.isArray(parsed.egressAllowedOrigins) ||
    parsed.egressAllowedOrigins.length > 16
  ) {
    throw new Error("runtime policy is invalid");
  }
  let previous = "";
  for (const origin of parsed.egressAllowedOrigins) {
    if (typeof origin !== "string" || origin <= previous)
      throw new Error("runtime policy is invalid");
    if (!isCustomerEgressOrigin(origin)) throw new Error("runtime policy is invalid");
    previous = origin;
  }
  const canonical = {
    healthCheckPath: parsed.healthCheckPath,
    egressAllowedOrigins: parsed.egressAllowedOrigins,
    ...(parsed.browser === undefined ? {} : { browser: parseBrowserPolicy(parsed.browser) }),
  };
  if (JSON.stringify(canonical) !== value) throw new Error("runtime policy is not canonical");
  return Object.freeze({
    healthCheckPath: canonical.healthCheckPath,
    egressAllowedOrigins: Object.freeze([...canonical.egressAllowedOrigins]),
    ...(canonical.browser === undefined ? {} : { browser: canonical.browser }),
  });
}

export function validateDatabaseRequirementJson(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new Error("database requirement is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("database requirement is invalid");
  }
  if (hasExactKeys(parsed, ["enabled"]) && parsed.enabled === false) {
    if (value !== '{"enabled":false}') throw new Error("database requirement is not canonical");
    return Object.freeze({ enabled: false });
  }
  if (
    !hasExactKeys(parsed, ["enabled", "migrations"]) ||
    parsed.enabled !== true ||
    typeof parsed.migrations !== "string" ||
    parsed.migrations.length === 0 ||
    parsed.migrations.length > 512 ||
    parsed.migrations.startsWith("/") ||
    /[\\:]/u.test(parsed.migrations) ||
    parsed.migrations.split("/").some((part) => part === "..")
  ) {
    throw new Error("database requirement is invalid");
  }
  const canonical = { enabled: true, migrations: parsed.migrations };
  if (JSON.stringify(canonical) !== value) throw new Error("database requirement is not canonical");
  return Object.freeze(canonical);
}

export function validateCustomerAuthRequirementJson(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2_048) {
    throw new Error("customer auth requirement is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("customer auth requirement is invalid");
  }
  if (hasExactKeys(parsed, ["provider"]) && parsed.provider === "none") {
    if (value !== '{"provider":"none"}') {
      throw new Error("customer auth requirement is not canonical");
    }
    return Object.freeze({ provider: "none" });
  }
  if (
    hasExactKeys(parsed, ["bindingName", "provider", "routePath"]) &&
    parsed.provider === "omh-native" &&
    parsed.routePath === "/api/auth/v1" &&
    parsed.bindingName === "OHMYHOST_AUTH"
  ) {
    const canonical = {
      provider: "omh-native",
      routePath: "/api/auth/v1",
      bindingName: "OHMYHOST_AUTH",
    };
    if (JSON.stringify(canonical) !== value) {
      throw new Error("customer auth requirement is not canonical");
    }
    return Object.freeze(canonical);
  }
  if (
    !hasExactKeys(parsed, [
      "authSecretName",
      "databaseBindingName",
      "databaseSchema",
      "deployment",
      "provider",
      "routePath",
      "version",
    ]) ||
    parsed.provider !== "better-auth" ||
    parsed.version !== "1.7.7" ||
    (parsed.deployment !== "embedded" && parsed.deployment !== "companion") ||
    parsed.routePath !== "/api/auth" ||
    parsed.databaseSchema !== "auth" ||
    parsed.databaseBindingName !== "OHMYHOST_DATABASE" ||
    parsed.authSecretName !== "BETTER_AUTH_SECRET"
  ) {
    throw new Error("customer auth requirement is invalid");
  }
  const canonical = {
    provider: "better-auth",
    version: "1.7.7",
    deployment: parsed.deployment,
    routePath: "/api/auth",
    databaseSchema: "auth",
    databaseBindingName: "OHMYHOST_DATABASE",
    authSecretName: "BETTER_AUTH_SECRET",
  };
  if (JSON.stringify(canonical) !== value) {
    throw new Error("customer auth requirement is not canonical");
  }
  return Object.freeze(canonical);
}

function validateMailRequirementJson(value) {
  if (value !== '{"enabled":false}' && value !== '{"enabled":true}') {
    throw new Error("mail requirement is invalid");
  }
  return Object.freeze({ enabled: value === '{"enabled":true}' });
}

export function validateStorageRequirementJson(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new Error("storage requirement is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("storage requirement is invalid");
  }
  if (hasExactKeys(parsed, ["enabled"]) && parsed.enabled === false) {
    if (value !== '{"enabled":false}') throw new Error("storage requirement is not canonical");
    return Object.freeze({ enabled: false });
  }
  if (
    !hasExactKeys(parsed, ["enabled", "jurisdiction", "provider", "public"]) ||
    parsed.enabled !== true ||
    parsed.provider !== "r2" ||
    (parsed.jurisdiction !== "eu" && parsed.jurisdiction !== "us") ||
    parsed.public !== false
  ) {
    throw new Error("storage requirement is invalid");
  }
  const canonical = {
    enabled: true,
    provider: "r2",
    jurisdiction: parsed.jurisdiction,
    public: false,
  };
  if (JSON.stringify(canonical) !== value) throw new Error("storage requirement is not canonical");
  return Object.freeze(canonical);
}

/** Declared crons of the Worker module: one to eight unique ascending five-field UTC schedules. */
export function validateFunctionsRequirementJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("functions requirement is invalid");
  }
  if (
    !hasExactKeys(parsed, ["crons"]) ||
    !Array.isArray(parsed.crons) ||
    parsed.crons.length < 1 ||
    parsed.crons.length > 8 ||
    JSON.stringify(parsed) !== value
  )
    throw new Error("functions requirement is invalid");
  let previous = "";
  for (const cron of parsed.crons) {
    if (typeof cron !== "string" || !CRON_PATTERN.test(cron) || cron <= previous) {
      throw new Error("functions requirement is invalid");
    }
    previous = cron;
  }
  return Object.freeze({ crons: Object.freeze([...parsed.crons]) });
}

function readFunctionsRequirement(env) {
  const value = env.FUNCTIONS_REQUIREMENT_JSON ?? "";
  return value === "" ? null : validateFunctionsRequirementJson(value);
}

export function resolveApplicationRoot(repositoryRootInput, applicationRootInput) {
  const applicationRoot = validateApplicationRoot(applicationRootInput);
  const repositoryRoot = fs.realpathSync(repositoryRootInput);
  const candidate = path.resolve(repositoryRoot, applicationRoot);
  const relative = path.relative(repositoryRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("application root escapes repository");
  }
  let current = repositoryRoot;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const status = fs.lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("application root ancestry is unsafe");
    }
  }
  if (fs.realpathSync(candidate) !== candidate) {
    throw new Error("application root is not canonical");
  }
  inspectPackageManager(candidate);
  return candidate;
}

export function inspectPackageManager(applicationRootInput, commands = undefined) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const packageJsonPath = path.join(applicationRoot, "package.json");
  assertRegularContainedFile(packageJsonPath, "application package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    throw new Error("application package manager is invalid");
  }
  const match = PACKAGE_MANAGER_DECLARATION.exec(packageJson.packageManager);
  if (match === null) throw new Error("application package manager is invalid");
  const manager = match[1];
  const version = match[2];
  if (manager === "bun" && version !== PINNED_BUN_VERSION)
    throw new Error(`application Bun version must be ${PINNED_BUN_VERSION}`);
  if (manager === "yarn" && Number(version.split(".")[0]) < YARN_MINIMUM_MAJOR)
    throw new Error("application Yarn version must be 3.0.0 or later");
  const contract = PACKAGE_MANAGER_CONTRACTS[manager];
  const lockfiles = ALL_LOCKFILES.filter((lockfile) =>
    fs.existsSync(path.join(applicationRoot, lockfile)),
  );
  if (lockfiles.length !== 1 || !contract.lockfiles.includes(lockfiles[0])) {
    throw new Error("application lockfile is invalid");
  }
  assertRegularContainedFile(path.join(applicationRoot, lockfiles[0]), "application lockfile");
  if (
    commands !== undefined &&
    (commands.installCommand !== contract.installCommand ||
      (commands.buildCommand !== contract.buildCommand && commands.buildCommand !== ""))
  ) {
    throw new Error("application build command is invalid");
  }
  for (const relative of RESERVED_BUILD_PATHS) {
    assertReservedBuildPathAbsent(path.join(applicationRoot, relative));
  }
  return Object.freeze({
    manager,
    version,
    lockfile: lockfiles[0],
    installCommand: contract.installCommand,
    buildCommand: commands?.buildCommand === "" ? "" : contract.buildCommand,
  });
}

export function writePackageManagerReceipt({
  applicationRoot,
  installCommand,
  buildCommand,
  outputPath,
  environment = undefined,
}) {
  if (fs.existsSync(outputPath)) throw new Error("package manager receipt output is invalid");
  const receipt = inspectPackageManager(applicationRoot, { installCommand, buildCommand });
  if (environment !== undefined && environment.FRAMEWORK_RUNTIME !== "functions") {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(applicationRoot, "package.json"), "utf8"),
    );
    const framework =
      environment.FRAMEWORK_ADAPTER === "vite-static" ? "vite" : environment.FRAMEWORK_ADAPTER;
    if (!isAdmittedFrameworkBuildScript(framework, packageJson.scripts?.build))
      throw new Error("application framework build script is invalid");
  }
  const tanstackEdge =
    environment !== undefined &&
    environment.FRAMEWORK_ADAPTER === "tanstack-start" &&
    environment.FRAMEWORK_RUNTIME === "edge";
  let tanstackConfigCreated = false;
  try {
    if (tanstackEdge) {
      createTanStackPlatformConfig({
        applicationRoot,
        outputPath: path.join(fs.realpathSync(applicationRoot), TANSTACK_PLATFORM_CONFIG_NAME),
        environment,
      });
      tanstackConfigCreated = true;
    }
    if (environment?.FRAMEWORK_ADAPTER === "astro" && environment.FRAMEWORK_RUNTIME === "edge") {
      createAstroPlatformConfig({ applicationRoot, environment });
    }
    fs.writeFileSync(outputPath, JSON.stringify(receipt), { flag: "wx", mode: 0o444 });
  } catch (error) {
    if (tanstackConfigCreated) {
      try {
        cleanupTanStackPlatformConfig({ applicationRoot });
      } catch {
        // Preserve the receipt failure; post-build cleanup handles the reserved input.
      }
    }
    throw error;
  }
  return receipt;
}

export function readPackageManagerReceipt(inputPath) {
  let value;
  try {
    const body = fs.readFileSync(inputPath);
    value = JSON.parse(body.toString("utf8"));
    if (Buffer.compare(body, Buffer.from(JSON.stringify(value))) !== 0) throw new Error();
  } catch {
    throw new Error("package manager receipt is invalid");
  }
  const contract = PACKAGE_MANAGER_CONTRACTS[value.manager];
  if (
    contract === undefined ||
    typeof value.version !== "string" ||
    !PACKAGE_MANAGER_DECLARATION.test(`${value.manager}@${value.version}`) ||
    (value.manager === "bun" && value.version !== PINNED_BUN_VERSION) ||
    (value.manager === "yarn" && Number(value.version.split(".")[0]) < YARN_MINIMUM_MAJOR) ||
    !contract.lockfiles.includes(value.lockfile) ||
    value.installCommand !== contract.installCommand ||
    (value.buildCommand !== contract.buildCommand && value.buildCommand !== "") ||
    !hasExactKeys(value, ["buildCommand", "installCommand", "lockfile", "manager", "version"])
  ) {
    throw new Error("package manager receipt is invalid");
  }
  return Object.freeze(value);
}

export function createViteCompanionConfig({
  applicationRoot: applicationRootInput,
  outputPath: outputPathInput,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const requestedOutputPath = path.resolve(outputPathInput);
  const outputPath = path.join(
    fs.realpathSync(path.dirname(requestedOutputPath)),
    path.basename(requestedOutputPath),
  );
  const env = environment;
  const sourceEntryPoint = resolveContained(applicationRoot, "src/ohmyhost/companion.ts");
  if (
    !validViteCompanionEnvironment(env) ||
    path.dirname(outputPath) !== applicationRoot ||
    fs.existsSync(outputPath)
  ) {
    throw new Error("Vite companion config input is invalid");
  }
  assertRegularContainedFile(sourceEntryPoint, "Vite companion source");
  const functions = readFunctionsRequirement(env);
  const platformEntry = path.join(applicationRoot, ".ohmyhost-vite-entry.ts");
  if (fs.existsSync(platformEntry)) throw new Error("Vite companion config input is invalid");
  fs.writeFileSync(platformEntry, vitePlatformEntry(functions !== null), {
    flag: "wx",
    mode: 0o400,
  });
  const config = Object.freeze({
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-vite-companion",
    main: ".ohmyhost-vite-entry.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: Object.freeze(["nodejs_compat"]),
  });
  fs.writeFileSync(outputPath, JSON.stringify(config), { flag: "wx", mode: 0o400 });
  return config;
}

// The companion serves the same-origin API; declared crons re-export its scheduled handler so the
// platform wrapper can invoke it. Acceptance repositories never resolve a private workspace package.
function vitePlatformEntry(scheduled) {
  const scheduledExport = scheduled
    ? `
  scheduled(controller, env, executionContext) {
    return companion.scheduled(controller, env, executionContext);
  },`
    : "";
  return `import companion from "./src/ohmyhost/companion.ts";
export default {
  fetch(request, env, executionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return companion.fetch(request, env, executionContext);
    return env.ASSETS.fetch(request);
  },${scheduledExport}
};
`;
}

// The customer module exports `default { fetch?, scheduled? }`. Wrangler decides the bundle format
// from the entry's default export, so the platform entry re-exports that default: a module with
// only named exports fails the bundle here instead of becoming a service-worker script whose
// default import the runtime wrapper cannot resolve.
function functionsPlatformEntry() {
  return `import worker from "./${WORKER_MODULE_SOURCE}";\nexport default worker;\n`;
}

/** Wrangler input that bundles the customer's Worker module for the functions runtime or declared crons. */
export function createFunctionsWorkerConfig({
  applicationRoot: applicationRootInput,
  outputPath: outputPathInput,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const requestedOutputPath = path.resolve(outputPathInput);
  const outputPath = path.join(
    fs.realpathSync(path.dirname(requestedOutputPath)),
    path.basename(requestedOutputPath),
  );
  const env = environment;
  const platformEntry = path.join(applicationRoot, FUNCTIONS_PLATFORM_ENTRY_NAME);
  if (
    path.dirname(outputPath) !== applicationRoot ||
    path.basename(outputPath) !== FUNCTIONS_PLATFORM_CONFIG_NAME ||
    fs.existsSync(outputPath) ||
    fs.existsSync(platformEntry) ||
    fs.existsSync(path.join(applicationRoot, FUNCTIONS_OUTPUT_DIRECTORY))
  ) {
    throw new Error("functions config input is invalid");
  }
  assertFunctionsWorkerRequested(env);
  const workerSource = resolveContained(applicationRoot, WORKER_MODULE_SOURCE);
  if (!fs.existsSync(workerSource)) throw new Error("Worker module source is missing");
  assertRegularContainedFile(workerSource, "Worker module source");
  fs.writeFileSync(platformEntry, functionsPlatformEntry(), { flag: "wx", mode: 0o400 });
  const config = Object.freeze({
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-functions",
    main: FUNCTIONS_PLATFORM_ENTRY_NAME,
    compatibility_date: env.COMPATIBILITY_DATE,
    compatibility_flags: Object.freeze(["nodejs_compat"]),
  });
  fs.writeFileSync(outputPath, JSON.stringify(config), { flag: "wx", mode: 0o400 });
  return config;
}

export function finalizeFunctionsWorkerOutput({
  applicationRoot: applicationRootInput,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  assertFunctionsWorkerRequested(environment);
  return finalizeWranglerDryRunOutput(
    resolveContained(applicationRoot, FUNCTIONS_OUTPUT_DIRECTORY),
    environment.COMPATIBILITY_DATE,
    "functions",
  );
}

function assertFunctionsWorkerRequested(env) {
  const functions = readFunctionsRequirement(env);
  if (env.FRAMEWORK_RUNTIME === "functions") {
    if (!validFunctionsRuntimeEnvironment(env))
      throw new Error("functions framework plan is invalid");
    return functions;
  }
  if (
    functions === null ||
    env.FRAMEWORK_RUNTIME !== "edge" ||
    (env.FRAMEWORK_ADAPTER !== "astro" &&
      env.FRAMEWORK_ADAPTER !== "nextjs" &&
      env.FRAMEWORK_ADAPTER !== "tanstack-start") ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(env.COMPATIBILITY_DATE ?? "") ||
    env.COMPATIBILITY_FLAGS !== "nodejs_compat"
  ) {
    throw new Error("functions framework plan is invalid");
  }
  return functions;
}

function validFunctionsRuntimeEnvironment(env) {
  return (
    env.FRAMEWORK_ADAPTER === "functions" &&
    env.FRAMEWORK_RUNTIME === "functions" &&
    (env.BUILD_COMMAND ?? "") === "" &&
    (env.BUILD_OUTPUT_DIRECTORY ?? "") === "" &&
    env.SERVER_OUTPUT_DIRECTORY === FUNCTIONS_OUTPUT_DIRECTORY &&
    env.SERVER_ENTRYPOINT === `${FUNCTIONS_OUTPUT_DIRECTORY}/worker.js` &&
    env.SERVER_CONFIG_PATH === `${FUNCTIONS_OUTPUT_DIRECTORY}/wrangler.jsonc` &&
    env.COMPATIBILITY_DATE === "2025-01-01" &&
    env.COMPATIBILITY_FLAGS === "nodejs_compat"
  );
}

/** Reduces a Wrangler dry-run directory to worker.js plus the platform-owned wrangler.jsonc. */
function finalizeWranglerDryRunOutput(serverRoot, compatibilityDate, kind) {
  const files = walk(serverRoot);
  const moduleFiles = files.filter((file) => /\.(?:m?js|wasm)$/u.test(file));
  const mapFiles = files.filter((file) => file.endsWith(".js.map"));
  const readmeFiles = files.filter((file) => path.basename(file) === "README.md");
  if (
    moduleFiles.length === 0 ||
    mapFiles.length !== 1 ||
    readmeFiles.length !== 1 ||
    files.some((file) => fs.lstatSync(file).isSymbolicLink())
  ) {
    throw new Error(`${kind} dry-run output is invalid`);
  }
  const mainPath =
    moduleFiles.find((file) => path.basename(file) === "worker.js") ??
    moduleFiles.find((file) =>
      /^\.ohmyhost-(?:vite|functions)-entry\.js$/u.test(path.basename(file)),
    ) ??
    (moduleFiles.length === 1 ? moduleFiles[0] : undefined);
  if (mainPath === undefined) throw new Error(`${kind} dry-run output is invalid`);
  readWorkerModules(serverRoot, moduleFiles, mainPath, kind, true);
  if (
    files.some(
      (file) =>
        !moduleFiles.includes(file) && !mapFiles.includes(file) && !readmeFiles.includes(file),
    )
  ) {
    throw new Error(`${kind} dry-run output is invalid`);
  }
  const sourceMapPath = mapFiles[0];
  const main = fs.readFileSync(mainPath);
  const readme = fs.readFileSync(readmeFiles[0]);
  const sourceMapBytes = fs.statSync(sourceMapPath).size;
  if (
    !main.length ||
    main.length > WORKER_MODULE_BYTE_LIMIT ||
    !readme.length ||
    readme.length > 4_096 ||
    sourceMapBytes < 1 ||
    sourceMapBytes > 8_388_608
  ) {
    throw new Error(`${kind} dry-run output is invalid`);
  }
  fs.unlinkSync(readmeFiles[0]);
  fs.unlinkSync(sourceMapPath);
  if (mainPath !== path.join(serverRoot, "worker.js")) {
    if (moduleFiles.length === 1) fs.renameSync(mainPath, path.join(serverRoot, "worker.js"));
    else
      fs.writeFileSync(
        path.join(serverRoot, "worker.js"),
        `export { default } from ${JSON.stringify(`./${safeRelative(serverRoot, mainPath)}`)};\n`,
        { flag: "wx" },
      );
  }
  fs.writeFileSync(
    path.join(serverRoot, "wrangler.jsonc"),
    JSON.stringify({
      main: "worker.js",
      compatibility_date: compatibilityDate,
      compatibility_flags: ["nodejs_compat"],
    }),
    { flag: "wx", mode: 0o400 },
  );
  return Object.freeze({ moduleBytes: main.length, readmeBytes: readme.length, sourceMapBytes });
}

/** Reads the finalized Worker module of a dry-run directory after checking its exact inventory. */
function readFinalizedWorkerModule(applicationRoot, serverDirectory, compatibilityDate, kind) {
  const serverRoot = resolveContained(applicationRoot, serverDirectory);
  const entrypoint = resolveContained(applicationRoot, `${serverDirectory}/worker.js`);
  const configPath = resolveContained(applicationRoot, `${serverDirectory}/wrangler.jsonc`);
  const serverFiles = walk(serverRoot);
  if (
    serverFiles.some((file) => file !== configPath && !/\.(?:m?js|wasm)$/u.test(file)) ||
    !serverFiles.includes(entrypoint)
  ) {
    throw new Error(`${kind} dry-run output is invalid`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (
    !hasExactKeys(config, ["compatibility_date", "compatibility_flags", "main"]) ||
    config.main !== "worker.js" ||
    config.compatibility_date !== compatibilityDate ||
    JSON.stringify(config.compatibility_flags) !== '["nodejs_compat"]'
  ) {
    throw new Error(`${kind} output config is invalid`);
  }
  return readWorkerModules(
    serverRoot,
    serverFiles.filter((file) => file !== configPath),
    entrypoint,
    kind,
    true,
  );
}

/** The verified compiled modules of one Worker; no source evaluation or native payload is allowed. */
function readWorkerModules(
  serverRoot,
  files,
  entrypoint,
  kind,
  reachableOnly = false,
  maximumMainBytes = WORKER_MODULE_BYTE_LIMIT,
) {
  if (files.length === 0 || files.length > 1000 || !files.includes(entrypoint))
    throw new Error(`${kind} dry-run output is invalid`);
  let total = 0;
  const modules = files.map((file) => {
    const relative = customerFileRelative(serverRoot, file, "worker/");
    if (relative.length > 248 || !/^[A-Za-z0-9._/-]+\.(?:m?js|wasm)$/u.test(relative))
      throw new Error(`${kind} dry-run output is invalid`);
    const body = fs.readFileSync(file);
    const maximum = file === entrypoint ? maximumMainBytes : WORKER_MODULE_BYTE_LIMIT;
    if (body.length > maximum)
      throw new PackagingLimitError(
        `the ${kind} Worker module${files.length === 1 ? "" : ` ${relative}`} is ${String(body.length)} bytes; a Worker module may be at most ${String(maximum)} bytes`,
      );
    total += body.length;
    if (total > Math.max(10_485_760, maximumMainBytes))
      throw new PackagingLimitError(
        `the ${kind} Worker modules exceed ${String(Math.max(10_485_760, maximumMainBytes))} bytes together`,
      );
    if (!body.length || (relative.endsWith(".wasm") && !globalThis.WebAssembly.validate(body)))
      throw new Error(`${kind} module is invalid`);
    return {
      path: relative,
      body,
      contentType: relative.endsWith(".wasm")
        ? "application/wasm"
        : "application/javascript+module",
    };
  });
  const main = safeRelative(serverRoot, entrypoint);
  if (reachableOnly) {
    const byPath = new Map(modules.map((module) => [module.path, module]));
    const visited = new Set();
    const pending = [main];
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      const module = byPath.get(name);
      if (module === undefined) throw new Error(`${kind} dry-run output is invalid`);
      visited.add(name);
      if (module.contentType === "application/wasm") continue;
      for (const token of parseModuleSpecifiers(module.body.toString("utf8"))[0]) {
        if (token.n?.startsWith("./") || token.n?.startsWith("../")) {
          const imported = path.posix.normalize(path.posix.join(path.posix.dirname(name), token.n));
          if (!byPath.has(imported)) throw new Error(`${kind} dry-run output is invalid`);
          pending.push(imported);
        }
      }
    }
    if (visited.size !== modules.length) throw new Error(`${kind} dry-run output is invalid`);
  }
  return { main, modules };
}

function copyWorkerModules(
  inventory,
  bundleRoot,
  framework,
  mainModule = "index.js",
  namespace = "",
) {
  const prefixed = (modulePath) => `${namespace}${modulePath}`;
  const multiple = inventory.modules.length > 1;
  const wrapper = multiple && namespace !== "";
  const targets = new Map(
    inventory.modules.map((module) => [
      module.path,
      module.path === inventory.main && !wrapper ? mainModule : prefixed(module.path),
    ]),
  );
  const copied = inventory.modules.map((module) => {
    const target = targets.get(module.path);
    if (target === "ohmyhost-entry.mjs") throw new Error("reserved Worker module collision");
    let body = module.body;
    if (module.contentType === "application/javascript+module") {
      assertRootOriginFrameworkAsset(framework, target, body, "worker-module");
      const source = body.toString("utf8");
      const edits = parseModuleSpecifiers(source)[0].flatMap((token) => {
        if (!token.n?.startsWith("./") && !token.n?.startsWith("../")) return [];
        const imported = targets.get(
          path.posix.normalize(path.posix.join(path.posix.dirname(module.path), token.n)),
        );
        if (imported === undefined) return [];
        const relative = path.posix.relative(path.posix.dirname(target), imported);
        const specifier = relative.startsWith(".") ? relative : `./${relative}`;
        return specifier === token.n
          ? []
          : [
              {
                start: token.s,
                end: token.e,
                text: token.d < 0 ? specifier : JSON.stringify(specifier),
              },
            ];
      });
      let rewritten = source;
      for (const edit of edits.sort((left, right) => right.start - left.start))
        rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
      body = Buffer.from(rewritten);
      assertRootOriginFrameworkAsset(framework, target, body, "worker-module");
    }
    const destination = path.join(bundleRoot, "worker", target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body, { flag: "wx" });
    return {
      path: target,
      contentType: module.contentType,
      digest: digest(body),
      size: body.length,
    };
  });
  if (wrapper && prefixed(inventory.main) !== mainModule) {
    const body = Buffer.from(
      `export { default } from ${JSON.stringify(`./${prefixed(inventory.main)}`)};\n`,
    );
    fs.writeFileSync(path.join(bundleRoot, "worker", mainModule), body, { flag: "wx" });
    copied.push({
      path: mainModule,
      contentType: "application/javascript+module",
      digest: digest(body),
      size: body.length,
    });
  }
  return copied.sort((left, right) => compareCodePoints(left.path, right.path));
}

/** Preserve the non-code files Next traced for its runtime entries in Workerd's read-only VFS. */
function readNextTracedRuntimeModules(applicationRoot, executableModules) {
  const traceRoot = resolveContained(applicationRoot, ".next/server");
  const traces = walk(traceRoot).filter((file) => file.endsWith(".nft.json"));
  if (traces.length === 0 || traces.length > 1000) {
    throw new Error("Next.js runtime trace inventory is invalid");
  }
  const files = new Map();
  let traceBytes = 0;
  let moduleBytes = executableModules.reduce((total, module) => total + module.body.length, 0);
  let compressedBytes = executableModules.reduce(
    (total, module) => total + zlib.gzipSync(module.body).length,
    0,
  );
  const executablePaths = new Set(executableModules.map((module) => module.path));
  for (const trace of traces) {
    const size = fs.statSync(trace).size;
    traceBytes += size;
    if (size === 0 || traceBytes > MAXIMUM_NEXT_WRANGLER_METAFILE_BYTES) {
      throw new Error("Next.js runtime trace evidence exceeds limit");
    }
    let evidence;
    try {
      evidence = JSON.parse(fs.readFileSync(trace, "utf8"));
    } catch {
      throw new Error("Next.js runtime trace is invalid");
    }
    if (
      !hasExactKeys(evidence, ["files", "version"]) ||
      evidence.version !== 1 ||
      !Array.isArray(evidence.files) ||
      evidence.files.length > 10_000
    ) {
      throw new Error("Next.js runtime trace is invalid");
    }
    for (const input of evidence.files) {
      if (
        typeof input !== "string" ||
        input.length === 0 ||
        input.length > 4096 ||
        input.includes("\\") ||
        path.isAbsolute(input)
      ) {
        throw new Error("Next.js runtime trace path is invalid");
      }
      const relative = path.relative(applicationRoot, path.resolve(path.dirname(trace), input));
      if (
        relative.length === 0 ||
        path.isAbsolute(relative) ||
        relative.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new Error("Next.js runtime trace path is invalid");
      }
      if (/\.node$/iu.test(relative)) {
        throw new Error("Next.js runtime trace contains a native addon");
      }
      // Executable code and WASM already have their own verified bundler inventory.
      if (/\.(?:[cm]?js|wasm)$/iu.test(relative) || files.has(relative)) continue;
      if (relative.length > 248 || !/^[A-Za-z0-9._@/+-]+$/u.test(relative)) {
        throw new Error("Next.js runtime trace data path is invalid");
      }
      if (executablePaths.has(relative)) {
        throw new Error("Next.js runtime trace module collision");
      }
      const candidate = path.join(applicationRoot, relative);
      if (relative.startsWith("node_modules/") && fs.lstatSync(candidate).isSymbolicLink()) {
        // NFT records pnpm's package-directory links as well as files. Bundling resolves these;
        // they add no VFS bytes. Never follow a link to a file or outside this installed tree.
        const target = fs.realpathSync(candidate);
        const targetRelative = path.relative(applicationRoot, target);
        if (
          targetRelative.startsWith("node_modules/") &&
          !targetRelative.split(path.sep).includes("..") &&
          fs.statSync(target).isDirectory()
        ) {
          continue;
        }
      }
      const file = resolveContained(applicationRoot, relative);
      if (fs.lstatSync(file).isDirectory()) continue;
      // The upload's metadata part is named exactly so; a data file may not take that name.
      if (relative.split("/").at(-1).toLowerCase() === "metadata") {
        throw new PackagingLimitError("the Next.js runtime trace includes a reserved file name");
      }
      assertRegularContainedFile(file, "Next.js runtime trace file");
      if (fs.statSync(file).size > WORKER_MODULE_BYTE_LIMIT) {
        throw new PackagingLimitError(
          `the Next.js runtime file ${relative} exceeds ${String(WORKER_MODULE_BYTE_LIMIT)} bytes`,
        );
      }
      const body = fs.readFileSync(file);
      moduleBytes += body.length;
      if (moduleBytes > 15_728_640) {
        throw new PackagingLimitError("the Next.js Worker modules exceed 15728640 bytes together");
      }
      compressedBytes += zlib.gzipSync(body).length;
      files.set(relative, { path: relative, body, contentType: "application/octet-stream" });
      if (files.size + executableModules.length > 1000) {
        throw new PackagingLimitError("the Next.js Worker has more than 1000 modules");
      }
    }
  }
  if (compressedBytes > 10_485_760) {
    throw new PackagingLimitError(
      "the Next.js Worker modules exceed 10485760 gzip-compressed bytes together",
    );
  }
  return [...files.values()];
}

/** Adds the bundled Worker module of declared crons beside an edge framework's own modules. */
function attachFunctionsWorkerModule(applicationRoot, bundleRoot, env, functions, modules) {
  if (functions === null) {
    if (fs.existsSync(path.join(applicationRoot, FUNCTIONS_OUTPUT_DIRECTORY))) {
      throw new Error("unexpected functions build output");
    }
    return modules;
  }
  const inventory = readFinalizedWorkerModule(
    applicationRoot,
    FUNCTIONS_OUTPUT_DIRECTORY,
    env.COMPATIBILITY_DATE,
    "functions",
  );
  if (modules.some(({ path: modulePath }) => modulePath === FUNCTIONS_WORKER_MODULE)) {
    throw new Error("reserved Worker module collision");
  }
  return [
    ...modules,
    ...copyWorkerModules(
      inventory,
      bundleRoot,
      env.FRAMEWORK_ADAPTER,
      FUNCTIONS_WORKER_MODULE,
      "ohmyhost-functions/",
    ),
  ].sort((left, right) => compareCodePoints(left.path, right.path));
}

export function createNextPlatformConfig({
  applicationRoot: applicationRootInput,
  outputPath: outputPathInput,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const requestedOutputPath = path.resolve(outputPathInput);
  const outputPath = path.join(
    fs.realpathSync(path.dirname(requestedOutputPath)),
    path.basename(requestedOutputPath),
  );
  const env = environment;
  if (
    path.dirname(outputPath) !== applicationRoot ||
    path.basename(outputPath) !== ".ohmyhost-next-wrangler.jsonc" ||
    fs.existsSync(outputPath) ||
    env.FRAMEWORK_ADAPTER !== "nextjs" ||
    env.FRAMEWORK_RUNTIME !== "edge" ||
    env.BUILD_OUTPUT_DIRECTORY !== ".open-next/assets" ||
    env.SERVER_OUTPUT_DIRECTORY !== ".ohmyhost-worker" ||
    env.SERVER_ENTRYPOINT !== ".ohmyhost-worker/worker.js" ||
    env.COMPATIBILITY_FLAGS !== "nodejs_compat" ||
    typeof env.COMPATIBILITY_DATE !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(env.COMPATIBILITY_DATE)
  ) {
    throw new Error("Next.js platform config input is invalid");
  }
  const config = Object.freeze({
    name: "ohmyhost-platform-next-build",
    main: ".open-next/worker.js",
    compatibility_date: env.COMPATIBILITY_DATE,
    compatibility_flags: Object.freeze(["nodejs_compat"]),
    keep_names: false,
    assets: Object.freeze({
      directory: ".open-next/assets",
      binding: "ASSETS",
      run_worker_first: true,
    }),
  });
  fs.writeFileSync(outputPath, JSON.stringify(config), { flag: "wx", mode: 0o400 });
  return config;
}

/**
 * Checks the installed version of every planned framework package against the shared security
 * floors after the frozen install and returns the build arguments: Next.js 16 and later build
 * with `--webpack`, Next.js 15 rejects that flag.
 */
export function readFrameworkBuildArguments({
  applicationRoot: applicationRootInput,
  environment,
}) {
  const adapter = environment?.FRAMEWORK_ADAPTER;
  if (
    !Object.hasOwn(INSTALLED_FRAMEWORK_PACKAGES, adapter) ||
    (adapter === "nextjs"
      ? environment.FRAMEWORK_RUNTIME !== "edge"
      : environment.FRAMEWORK_RUNTIME !== "static" && environment.FRAMEWORK_RUNTIME !== "edge")
  ) {
    throw new Error("framework plan is invalid");
  }
  const applicationRoot = fs.realpathSync(applicationRootInput);
  let buildArguments = Object.freeze([]);
  const packages =
    adapter === "astro" && environment.FRAMEWORK_RUNTIME === "edge"
      ? [...INSTALLED_FRAMEWORK_PACKAGES.astro, "@astrojs/cloudflare"]
      : INSTALLED_FRAMEWORK_PACKAGES[adapter];
  for (const packageName of packages) {
    const version = readInstalledFrameworkVersion(applicationRoot, packageName);
    if (packageName === "next") {
      if (nextPathRevalidationEnabled(environment) && version !== "16.4.5")
        throw new FrameworkVersionRefusal(
          "ohmyho.st build: build.next_revalidate_path currently requires Next.js 16.4.5; pin next to 16.4.5 or disable this option, update the lockfile, then commit and deploy the new commit.",
        );
      buildArguments = nextBuildArguments(version);
    }
  }
  return buildArguments;
}

/** Bounded JSON whose real path stays inside the application, as pnpm's package links do. */
function readApplicationJson(applicationRoot, relative) {
  const file = fs.realpathSync(path.join(applicationRoot, relative));
  const contained = path.relative(applicationRoot, file);
  const status = fs.statSync(file);
  if (
    contained.startsWith("..") ||
    path.isAbsolute(contained) ||
    !status.isFile() ||
    status.size < 1 ||
    status.size > 64 * 1024
  ) {
    throw new Error("application JSON is invalid");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The admitted installed version of one framework package. */
function readInstalledFrameworkVersion(applicationRoot, packageName) {
  const metadataPath = `node_modules/${packageName}/package.json`;
  let metadata;
  try {
    metadata = readApplicationJson(applicationRoot, metadataPath);
  } catch {
    throw new FrameworkVersionRefusal(
      `ohmyho.st build: the frozen install left no readable ${metadataPath}; declare ${packageName} in package.json, commit the lockfile, then plan the new commit.`,
    );
  }
  const version = metadata?.name === packageName ? metadata.version : undefined;
  if (frameworkVersionVerdict(packageName, version) === "admitted") return version;
  throw refuseInstalledFrameworkVersion(applicationRoot, packageName, version);
}

/** The platform line applies when the exact declaration proves planning admitted the version. */
function refuseInstalledFrameworkVersion(applicationRoot, packageName, installedVersion) {
  const version = parseStableVersion(installedVersion) === null ? null : installedVersion;
  if (version !== null && declaredFrameworkVersion(applicationRoot, packageName) === version) {
    return new FrameworkVersionRefusal(
      `ohmyho.st platform: the build image refused ${packageName} ${version}, which planning admitted. The platform admission policy is inconsistent; report the operation ID and plan the same commit again later.`,
    );
  }
  return new FrameworkVersionRefusal(
    `ohmyho.st build: installed ${version === null ? packageName : `${packageName} ${version}`} is not admitted; use ${packageName} ${frameworkVersionMinimum(packageName, installedVersion)} or a later stable release in package.json and the lockfile, commit and push the change, then plan the new commit.`,
  );
}

/** The first package.json declaration of a package, in the order the framework adapters read it. */
function declaredFrameworkVersion(applicationRoot, packageName) {
  let packageJson;
  try {
    packageJson = readApplicationJson(applicationRoot, "package.json");
  } catch {
    // An unreadable declaration proves nothing about planning; the refusal stays the customer's.
    return null;
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies = packageJson?.[field];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies))
      continue;
    const declared = Object.hasOwn(dependencies, packageName) ? dependencies[packageName] : null;
    if (typeof declared === "string" && declared.length > 0) return declared;
  }
  return null;
}

export function createOpenNextPlatformConfig({
  applicationRoot: applicationRootInput,
  outputPath: outputPathInput,
  environment,
  platformPackageRoot = OPEN_NEXT_PLATFORM_PACKAGE_ROOT,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const requestedOutputPath = path.resolve(outputPathInput);
  const outputPath = path.join(
    fs.realpathSync(path.dirname(requestedOutputPath)),
    path.basename(requestedOutputPath),
  );
  if (
    !validNextEdgeEnvironment(environment) ||
    path.dirname(outputPath) !== applicationRoot ||
    path.basename(outputPath) !== OPEN_NEXT_PLATFORM_CONFIG_NAME
  ) {
    throw new Error("OpenNext platform config input is invalid");
  }
  assertContainedPathAbsent(outputPath, "OpenNext platform config input is invalid");
  const writable = nextPathRevalidationEnabled(environment);
  const required = readNextServerFiles(applicationRoot);
  const cacheComponents = required.config.cacheComponents === true;
  if (cacheComponents) limitNextPostponedState(applicationRoot, required.relativeAppDir ?? "");
  // The Static Assets cache holds only build-time entries: a request-time "use cache" entry is a
  // silent miss and is never stored. Next.js may still let concurrent identical calls in one isolate
  // share a single computation, whose result depends only on the call's arguments. Cache
  // interception would answer a Cache Components shell without resuming its dynamic parts.
  fs.writeFileSync(
    outputPath,
    writable
      ? `import { defineCloudflareConfig, getCloudflareContext } from ${JSON.stringify(`${platformPackageRoot}/dist/api/index.js`)};
import staticAssets from ${JSON.stringify(`${platformPackageRoot}/dist/api/overrides/incremental-cache/static-assets-incremental-cache.js`)};
import { createWritableNextCaches } from ${JSON.stringify(fileURLToPath(new URL("./next-writable-cache.mjs", import.meta.url)))};
const { incrementalCache, tagCache } = createWritableNextCaches({ getContext: getCloudflareContext, staticAssets });
export default defineCloudflareConfig({ incrementalCache, tagCache, enableCacheInterception: false });
`
      : `import { defineCloudflareConfig } from ${JSON.stringify(`${platformPackageRoot}/dist/api/index.js`)};
import staticAssetsIncrementalCache from ${JSON.stringify(`${platformPackageRoot}/dist/api/overrides/incremental-cache/static-assets-incremental-cache.js`)};
const incrementalCache = {
  name: staticAssetsIncrementalCache.name,
  get: (key, cacheType) => (cacheType === "composable" ? Promise.resolve(null) : staticAssetsIncrementalCache.get(key, cacheType)),
  set: (key, value, cacheType) => (cacheType === "composable" ? Promise.resolve() : staticAssetsIncrementalCache.set(key, value, cacheType)),
  delete: (key) => staticAssetsIncrementalCache.delete(key),
};
export default defineCloudflareConfig({ incrementalCache, enableCacheInterception: ${String(!cacheComponents)} });
`,
    { flag: "wx", mode: 0o400 },
  );
  assertRegularContainedFile(outputPath, "OpenNext platform config");
  if ((fs.statSync(outputPath).mode & 0o777) !== 0o400)
    throw new Error("OpenNext platform config input is invalid");
  return outputPath;
}

/**
 * Bytes as Next.js reads experimental.maxPostponedStateSize: unset is 100 MB, a number counts
 * bytes, and a string is a decimal with a binary kb to pb unit or else its leading integer.
 */
function nextSizeLimitBytes(value) {
  if (!value) return 100 * 1024 * 1024;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const sized = /^([-+]?\d+(?:\.\d+)?) *(kb|mb|gb|tb|pb)$/iu.exec(value);
  if (sized === null) return Number.parseInt(value, 10);
  const unit = 1024 ** (["kb", "mb", "gb", "tb", "pb"].indexOf(sized[2].toLowerCase()) + 1);
  return Math.floor(unit * Number.parseFloat(sized[1]));
}

/** Caps the postponed state limit OpenNext bundles at 25 MB and keeps a smaller valid limit. */
function limitNextPostponedState(applicationRoot, relativeAppDir) {
  if (
    typeof relativeAppDir !== "string" ||
    path.posix.isAbsolute(relativeAppDir) ||
    relativeAppDir.split(/[/\\]/u).includes("..")
  )
    throw new Error("Next.js cache metadata is invalid");
  // OpenNext bundles the build's copy as its adapter configuration and the standalone copy as the
  // configuration Next.js reads; both are checked before either changes.
  const copies = [
    ".next/required-server-files.json",
    path.posix.join(".next/standalone", relativeAppDir, ".next/required-server-files.json"),
  ].map((relative) => {
    const serverFiles = readNextServerFiles(applicationRoot, relative);
    const experimental = serverFiles.config.experimental ?? {};
    if (typeof experimental !== "object" || Array.isArray(experimental))
      throw new Error("Next.js cache metadata is invalid");
    const bytes = nextSizeLimitBytes(experimental.maxPostponedStateSize);
    if (Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= NEXT_POSTPONED_STATE_LIMIT_BYTES)
      return null;
    serverFiles.config.experimental = {
      ...experimental,
      maxPostponedStateSize: NEXT_POSTPONED_STATE_LIMIT,
    };
    return [resolveContained(applicationRoot, relative), JSON.stringify(serverFiles)];
  });
  for (const [file, serverFiles] of copies.filter(Boolean)) fs.writeFileSync(file, serverFiles);
}

function readNextCacheJson(applicationRoot, relative) {
  const file = resolveContained(applicationRoot, relative);
  assertRegularContainedFile(file, "Next.js cache metadata");
  const size = fs.statSync(file).size;
  if (size < 1 || size > MAXIMUM_NEXT_WRANGLER_METAFILE_BYTES)
    throw new Error("Next.js cache metadata exceeds limit");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Next.js cache metadata is invalid");
  }
}

function nextSourceConfiguration(applicationRoot, required) {
  const completed = new Map();
  const active = new Set();
  let totalBytes = 0;
  const property = (node, name) =>
    node?.properties?.find((entry) => (entry.key?.name ?? entry.key?.value) === name)?.value;
  const contained = (origin, value) => {
    const relative = path.relative(applicationRoot, path.resolve(origin, value));
    if (relative === "") return ".";
    resolveContained(applicationRoot, relative);
    return relative;
  };
  const load = (relative) => {
    const file = resolveContained(applicationRoot, relative);
    if (active.has(file)) throw new Error("Next.js source configuration ancestry contains a cycle");
    if (completed.has(file)) return completed.get(file);
    if (active.size >= 16 || completed.size >= 32)
      throw new Error("Next.js source configuration ancestry exceeds limit");
    assertRegularContainedFile(file, "Next.js source configuration");
    const size = fs.statSync(file).size;
    totalBytes += size;
    if (size > 256 * 1024 || totalBytes > 1024 * 1024)
      throw new Error("Next.js source configuration exceeds limit");
    active.add(file);
    const tree = parseExpression(fs.readFileSync(file, "utf8"));
    let result = {};
    const extension = property(tree, "extends");
    for (const parent of extension?.type === "ArrayExpression"
      ? extension.elements
      : extension
        ? [extension]
        : []) {
      if (typeof parent?.value !== "string")
        throw new Error("Next.js source configuration is invalid");
      let parentRelative;
      if (parent.value.startsWith(".")) {
        parentRelative = contained(path.dirname(file), parent.value);
        if (!fs.existsSync(resolveContained(applicationRoot, parentRelative)))
          parentRelative += ".json";
      } else {
        const resolved = createRequire(file).resolve(parent.value);
        parentRelative = contained(applicationRoot, resolved);
      }
      result = { ...result, ...load(parentRelative) };
    }
    const options = property(tree, "compilerOptions");
    const baseUrl = property(options, "baseUrl");
    if (baseUrl !== undefined) {
      if (typeof baseUrl.value !== "string")
        throw new Error("Next.js source configuration is invalid");
      result.baseUrl = contained(path.dirname(file), baseUrl.value);
    }
    const paths = property(options, "paths");
    if (paths !== undefined) {
      result.paths = [];
      result.pathsOrigin = contained(applicationRoot, path.dirname(file));
      for (const entry of paths.properties ?? []) {
        const name = entry.key?.name ?? entry.key?.value;
        if (typeof name !== "string") throw new Error("Next.js source configuration is invalid");
        for (const target of entry.value?.elements ?? []) {
          if (typeof target?.value !== "string")
            throw new Error("Next.js source configuration is invalid");
          result.paths.push({ name, target: target.value });
        }
      }
    }
    active.delete(file);
    completed.set(file, result);
    return result;
  };
  const selected = required.config.typescript?.tsconfigPath ?? "tsconfig.json";
  const configName = fs.existsSync(resolveContained(applicationRoot, selected))
    ? selected
    : "jsconfig.json";
  if (!fs.existsSync(resolveContained(applicationRoot, configName)))
    return { aliases: [], baseUrl: undefined };
  const result = load(configName);
  return {
    aliases: (result.paths ?? []).map(({ name, target }) => ({
      name,
      target: contained(applicationRoot, path.join(result.baseUrl ?? result.pathsOrigin, target)),
    })),
    baseUrl: result.baseUrl,
  };
}

/** Only Next fetch options and known Pages response bindings request runtime revalidation. */
function assertNextRequestCacheUsage(tree, pagesApiEntry) {
  const responseTypes = new Set();
  const handlerTypes = new Set();
  const nextNamespaces = new Set();
  const declarations = new Map();
  let defaultExport;
  const functions = new Set();
  const key = (node) => node?.name ?? node?.value;
  for (const statement of tree.program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === "next") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") nextNamespaces.add(specifier.local.name);
        if (key(specifier.imported) === "NextApiResponse") responseTypes.add(specifier.local.name);
        if (key(specifier.imported) === "NextApiHandler") handlerTypes.add(specifier.local.name);
      }
    }
    const declaration = statement.declaration ?? statement;
    if (statement.type === "ExportDefaultDeclaration") defaultExport = declaration;
    if (declaration.type === "FunctionDeclaration")
      declarations.set(declaration.id?.name, declaration);
    if (declaration.type === "VariableDeclaration")
      for (const entry of declaration.declarations) declarations.set(entry.id.name, entry.init);
  }
  const typeName = (node) => node?.typeAnnotation?.typeAnnotation?.typeName;
  const hasType = (node, names, qualified) => {
    const name = typeName(node);
    return (
      names.has(name?.name) ||
      (name?.type === "TSQualifiedName" &&
        nextNamespaces.has(name.left?.name) &&
        name.right?.name === qualified)
    );
  };
  if (pagesApiEntry && defaultExport)
    functions.add(
      defaultExport.type === "Identifier" ? declarations.get(defaultExport.name) : defaultExport,
    );
  const lookup = (scope, name) => {
    for (let current = scope; current !== undefined; current = current.parent)
      if (current.bindings.has(name)) return current.bindings.get(name);
    return undefined;
  };
  const resolve = (node, scope, seen = new Set()) => {
    if (node?.type === "Identifier") {
      const binding = lookup(scope, node.name);
      if (binding === undefined)
        return { node, scope, kind: node.name === "fetch" ? "fetch" : undefined };
      if (seen.has(binding)) return {};
      seen.add(binding);
      return binding.kind ? binding : resolve(binding.init, binding.scope, seen);
    }
    if (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node?.type))
      return resolve(node.expression, scope, seen);
    if (node?.type === "MemberExpression") {
      const propertyName = node.computed ? node.property?.value : key(node.property);
      if (
        node.object?.name === "globalThis" &&
        lookup(scope, "globalThis") === undefined &&
        propertyName === "fetch"
      )
        return { kind: "fetch" };
      if (propertyName === "revalidate" && resolve(node.object, scope, seen).kind === "response")
        return { kind: "invalidator" };
    }
    return { node, scope };
  };
  const objectProperty = (node, scope, name) => {
    const value = resolve(node, scope);
    for (const entry of (value.node?.type === "ObjectExpression"
      ? value.node.properties
      : []
    ).toReversed()) {
      if (entry.type === "SpreadElement") {
        const property = objectProperty(entry.argument, value.scope, name);
        if (property) return property;
      } else if ((entry.computed ? entry.key?.value : key(entry.key)) === name)
        return { node: entry.value, scope: value.scope };
    }
    return undefined;
  };
  const bind = (scope, pattern, init, kind) => {
    if (pattern?.type === "Identifier") scope.bindings.set(pattern.name, { init, scope, kind });
    else if (pattern?.type === "AssignmentPattern") bind(scope, pattern.left, pattern.right, kind);
    else if (pattern?.type === "RestElement") bind(scope, pattern.argument, undefined, kind);
    else if (pattern?.type === "ObjectPattern")
      for (const entry of pattern.properties) {
        if (entry.type === "RestElement") bind(scope, entry.argument);
        else
          bind(
            scope,
            entry.value,
            init
              ? {
                  type: "MemberExpression",
                  object: init,
                  property: entry.key,
                  computed: entry.computed,
                }
              : undefined,
            kind === "response" && key(entry.key) === "revalidate" ? "invalidator" : undefined,
          );
      }
    else if (pattern?.type === "ArrayPattern")
      for (const entry of pattern.elements) bind(scope, entry);
  };
  const visit = (node, parent) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    const isFunction =
      /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod)$/u.test(
        node.type,
      );
    let scope = parent;
    if (node.type === "Program" || node.type === "BlockStatement" || isFunction) {
      scope = { bindings: new Map(), parent };
      for (const [index, parameter] of (node.params ?? []).entries())
        bind(
          scope,
          parameter,
          undefined,
          hasType(parameter, responseTypes, "NextApiResponse") ||
            (functions.has(node) && index === 1)
            ? "response"
            : undefined,
        );
      for (const statement of Array.isArray(node.body) ? node.body : []) {
        const declaration = statement.declaration ?? statement;
        if (declaration.type === "ImportDeclaration")
          for (const specifier of declaration.specifiers) bind(scope, specifier.local);
        else if (declaration.type === "VariableDeclaration")
          for (const entry of declaration.declarations) {
            bind(scope, entry.id, entry.init);
            if (hasType(entry.id, handlerTypes, "NextApiHandler")) functions.add(entry.init);
          }
        else if (declaration.id?.type === "Identifier") bind(scope, declaration.id);
      }
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = resolve(node.callee, scope);
      if (callee.kind === "invalidator")
        throw new PackagingLimitError(NEXT_REVALIDATION_UNSUPPORTED);
      if (callee.kind === "fetch") {
        const next = objectProperty(node.arguments[1], scope, "next");
        const revalidate = next && objectProperty(next.node, next.scope, "revalidate");
        if (revalidate) {
          const value = resolve(revalidate.node, revalidate.scope).node;
          if (
            !(value?.type === "BooleanLiteral" && value.value === false) &&
            !(value?.type === "NumericLiteral" && value.value === 0)
          )
            throw new PackagingLimitError(NEXT_REVALIDATION_UNSUPPORTED);
        }
      }
    }
    for (const child of Object.values(node))
      if (child !== null && typeof child === "object") visit(child, scope);
  };
  visit(tree.program, undefined);
}

/** The built server files; OpenNext bundles their config as the Worker's Next.js configuration. */
function readNextServerFiles(applicationRoot, relative = ".next/required-server-files.json") {
  const required = readNextCacheJson(applicationRoot, relative);
  if (
    typeof required?.config !== "object" ||
    required.config === null ||
    Array.isArray(required.config)
  )
    throw new Error("Next.js cache metadata is invalid");
  return required;
}

/** Inspect the built route contract and reachable application source without executing it. */
function nextPathRevalidationEnabled(environment) {
  const value = environment?.NEXT_REVALIDATE_PATH;
  if (value !== undefined && value !== "" && value !== "1")
    throw new Error("Next.js cache mode is invalid");
  return value === "1";
}

export function validateNextCacheSupport({
  applicationRoot: applicationRootInput,
  environment = process.env,
}) {
  const writable = nextPathRevalidationEnabled(environment);
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const manifest = readNextCacheJson(applicationRoot, ".next/prerender-manifest.json");
  const required = readNextServerFiles(applicationRoot);
  if (
    manifest?.version !== 4 ||
    typeof manifest.routes !== "object" ||
    manifest.routes === null ||
    Array.isArray(manifest.routes) ||
    typeof manifest.dynamicRoutes !== "object" ||
    manifest.dynamicRoutes === null ||
    Array.isArray(manifest.dynamicRoutes)
  )
    throw new Error("Next.js cache metadata is invalid");
  const routes = [...Object.values(manifest.routes), ...Object.values(manifest.dynamicRoutes)];
  if (routes.length > 2000) throw new Error("Next.js cache route inventory exceeds limit");
  if (routes.some((route) => route === null || typeof route !== "object"))
    throw new Error("Next.js cache metadata is invalid");
  const cacheComponents = required.config.cacheComponents === true;
  // Only a Cache Components build receives the platform configuration that resumes partially
  // prerendered shells; Next.js 16.3 sets experimental.ppr for such a build itself.
  if (
    !cacheComponents &&
    (required.config.experimental?.ppr === true ||
      routes.some(
        (route) => route.renderingMode === "PARTIALLY_STATIC" || route.experimentalPPR === true,
      ))
  )
    throw new Error("Next.js partial prerendering requires Cache Components");
  // Workers stop a Cache Components page that Next.js prerenders while the visitor waits, and later
  // requests for that page wait on it. Next.js does so for new params of an open page without a
  // static shell and, with Partial Prefetching, when a prefetch completes the shell of an open page
  // with generated params for new params.
  if (
    cacheComponents &&
    Object.values(manifest.dynamicRoutes).some((route) => {
      if (route.renderingMode !== "PARTIALLY_STATIC" || route.fallback === false) return false;
      const generated = route.remainingPrerenderableParams ?? [];
      return (
        typeof route.fallback !== "string" ||
        (Boolean(required.config.partialPrefetching) &&
          !(Array.isArray(generated) && generated.length === 0))
      );
    })
  )
    throw new PackagingLimitError(NEXT_BLOCKING_PRERENDER_UNSUPPORTED);
  // Next.js writes a revalidate or expire time only when prerendered output must be refreshed.
  if (
    routes.some((route) =>
      [
        route.initialRevalidateSeconds,
        route.initialExpireSeconds,
        route.fallbackRevalidate,
        route.fallbackExpire,
      ].some((seconds) => seconds !== undefined && seconds !== false),
    )
  )
    throw new PackagingLimitError(
      cacheComponents
        ? NEXT_SHELL_REVALIDATION_UNSUPPORTED
        : NEXT_PRERENDER_REVALIDATION_UNSUPPORTED,
    );

  const { aliases, baseUrl } = nextSourceConfiguration(applicationRoot, required);
  const pending = [];
  for (const directory of ["app", "src/app", "pages", "src/pages"]) {
    const sourceRoot = resolveContained(applicationRoot, directory);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const file of walk(sourceRoot)) {
      const extension = path.extname(file);
      if (
        !NEXT_SOURCE_EXTENSIONS.includes(extension) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
      )
        continue;
      const stem = path.basename(file, extension);
      if (
        directory.endsWith("pages") ||
        /^(?:page|layout|route|template|loading|error|global-error|not-found|default|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)$/u.test(
          stem,
        )
      )
        pending.push(file);
    }
  }
  for (const prefix of ["", "src/"])
    for (const stem of ["middleware", "proxy"]) {
      for (const extension of NEXT_SOURCE_EXTENSIONS) {
        const candidate = resolveContained(applicationRoot, `${prefix}${stem}${extension}`);
        if (fs.existsSync(candidate)) pending.push(candidate);
      }
    }
  const visited = new Set();
  let sourceBytes = 0;
  const resolveSource = (relative) => {
    const requested = resolveContained(applicationRoot, relative);
    const extension = path.extname(requested);
    const candidates = [
      requested,
      ...NEXT_SOURCE_EXTENSIONS.map((suffix) => requested + suffix),
      ...NEXT_SOURCE_EXTENSIONS.map((suffix) => path.join(requested, `index${suffix}`)),
      ...(/\.[cm]?js$/u.test(extension)
        ? NEXT_SOURCE_EXTENSIONS.map((suffix) => requested.slice(0, -extension.length) + suffix)
        : []),
    ];
    return candidates.find(
      (candidate) =>
        NEXT_SOURCE_EXTENSIONS.includes(path.extname(candidate)) &&
        fs.existsSync(candidate) &&
        fs.lstatSync(candidate).isFile(),
    );
  };
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (visited.size > 2000) throw new Error("Next.js source inventory exceeds limit");
    assertRegularContainedFile(file, "Next.js application source");
    const size = fs.statSync(file).size;
    sourceBytes += size;
    if (size > 256 * 1024 || sourceBytes > 8 * 1024 * 1024)
      throw new Error("Next.js source inventory exceeds limit");
    const tree = parseApplicationJavaScript(fs.readFileSync(file, "utf8"), {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      createImportExpressions: true,
      attachComment: false,
      allowUndeclaredExports: true,
    });
    assertNextRequestCacheUsage(
      tree,
      /^(?:src\/)?pages\/api\//u.test(
        path.relative(applicationRoot, file).split(path.sep).join("/"),
      ),
    );
    const nodes = [tree];
    while (nodes.length > 0) {
      const node = nodes.pop();
      if (node === null || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        nodes.push(...node);
        continue;
      }
      // A "use cache" directive needs no check: its build-time values are prerendered output the
      // route check judges, and the platform cache never stores a request-time entry.
      let module;
      if (
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
          node.type,
        ) &&
        node.importKind !== "type" &&
        node.exportKind !== "type"
      )
        module = node.source?.value;
      else if (node.type === "ImportExpression") module = node.source?.value;
      else if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "require"
      )
        module = node.arguments?.[0]?.value;
      if (typeof module === "string") {
        if (
          (module === "next/cache" || module === "next/cache.js") &&
          !(
            ["ImportDeclaration", "ExportNamedDeclaration"].includes(node.type) &&
            node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.importKind === "type" ||
                specifier.exportKind === "type" ||
                (specifier.type === "ImportSpecifier" &&
                  (NEXT_CACHE_IMPORTS.has(specifier.imported?.name ?? specifier.imported?.value) ||
                    (writable &&
                      (specifier.imported?.name ?? specifier.imported?.value) ===
                        "revalidatePath"))) ||
                (specifier.type === "ExportSpecifier" &&
                  (NEXT_CACHE_IMPORTS.has(specifier.local?.name ?? specifier.local?.value) ||
                    (writable &&
                      (specifier.local?.name ?? specifier.local?.value) === "revalidatePath"))),
            )
          )
        )
          throw new PackagingLimitError(NEXT_REVALIDATION_UNSUPPORTED);
        const relative = module.startsWith(".")
          ? path.relative(applicationRoot, path.resolve(path.dirname(file), module))
          : null;
        const resolved =
          relative === null
            ? (aliases
                .flatMap(({ name, target }) => {
                  const [prefix, suffix = ""] = name.split("*");
                  if (
                    !module.startsWith(prefix) ||
                    !module.endsWith(suffix) ||
                    (!name.includes("*") && module !== name)
                  )
                    return [];
                  const value = name.includes("*")
                    ? module.slice(prefix.length, module.length - suffix.length)
                    : "";
                  return [resolveSource(target.replace("*", value))];
                })
                .find(Boolean) ??
              (baseUrl === undefined ? undefined : resolveSource(path.join(baseUrl, module))))
            : resolveSource(relative);
        if (resolved !== undefined && resolved !== null) pending.push(resolved);
      }
      for (const value of Object.values(node))
        if (value !== null && typeof value === "object") nodes.push(value);
    }
  }
  return Object.freeze({ routes: routes.length, sourceFiles: visited.size });
}

/** The broker supplies a normalized capacity; an omitted optional choice uses 32 MiB. */
function nextSsgCacheMaxBytes(environment) {
  const value = environment.SSG_CACHE_MAX_BYTES;
  if (value === undefined) return DEFAULT_SSG_CACHE_MAX_BYTES;
  const bytes = Number(value);
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1024 * 1024 ||
    bytes > MAXIMUM_SSG_CACHE_BYTES ||
    bytes % (1024 * 1024) !== 0
  )
    throw new Error("Next.js private cache limit is invalid");
  return bytes;
}

function assertNextSsgCacheSize(bytes, maximumBytes) {
  if (bytes > maximumBytes)
    throw new PackagingLimitError(
      `the Next.js build-time cache is ${String(bytes)} bytes; its selected limit is ${String(maximumBytes)} bytes. Increase build.ssg_cache_max_mib up to 64, or reduce the generated cache, then commit, push and deploy the new commit`,
    );
}

/** Validate private build-time cache bytes before the official population helper copies them. */
export function validateNextStaticCache({
  applicationRoot: applicationRootInput,
  environment = process.env,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const maximumBytes = nextSsgCacheMaxBytes(environment);
  const cacheRoot = resolveContained(applicationRoot, ".open-next/cache");
  const files = walk(cacheRoot);
  if (files.length > 1000)
    throw new PackagingLimitError(
      "the Next.js build-time cache has more than 1,000 files; reduce its build output",
    );
  let totalBytes = 0;
  return files.map((file) => {
    // Route cache files are named <buildId>/route-cache/<kind>/<sha256>/$<page>.cache.
    const cachePath = path.relative(cacheRoot, file).split(path.sep).join("/");
    if (ustarPathFields(`assets/${NEXT_CACHE_ASSET_DIRECTORY}/${cachePath}`) === null) {
      const page = [...(/\/\$(.*)\.cache$/su.exec(cachePath)?.[1] ?? "")].slice(0, 200).join("");
      const subject =
        page === "" || /\p{Cc}/u.test(page) ? "a prerendered page" : `the prerendered page ${page}`;
      throw new PackagingLimitError(
        `${subject} has a URL path too long for the deployment archive; shorten the URL or render the page on request instead of prerendering it, then commit, push and deploy the new commit`,
      );
    }
    const relative = safeRelative(cacheRoot, file);
    if (!/^(?:[A-Za-z0-9._~-]+\/.+\.cache|__fetch\/[A-Za-z0-9._~-]+\/.+)$/u.test(relative))
      throw new Error("Next.js cache path is invalid");
    const size = fs.statSync(file).size;
    totalBytes += size;
    if (size > 10_485_760)
      throw new PackagingLimitError(
        "a Next.js build-time cache file exceeds the existing 10 MiB file limit; reduce its build output",
      );
    assertNextSsgCacheSize(totalBytes, maximumBytes);
    const body = fs.readFileSync(file);
    const value = JSON.parse(body.toString("utf8"));
    if (relative.startsWith("__fetch/")) {
      if (value?.revalidate !== false && value?.revalidate !== 4294967294)
        throw new PackagingLimitError(NEXT_REVALIDATION_UNSUPPORTED);
    } else if (!["app", "page", "route", "redirect"].includes(value?.type))
      throw new Error("Next.js cache entry is invalid");
    return Object.freeze({ path: relative, size, digest: digest(body) });
  });
}

/** Populate only the official immutable Static Assets cache; never invoke a provider or proxy. */
export async function populateNextStaticCache({
  applicationRoot: applicationRootInput,
  platformPackageRoot = OPEN_NEXT_PLATFORM_PACKAGE_ROOT,
  environment = process.env,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  validateNextCacheSupport({ applicationRoot, environment });
  const inventory = validateNextStaticCache({ applicationRoot, environment });
  const outputDir = resolveContained(applicationRoot, ".open-next");
  const destination = resolveContained(
    applicationRoot,
    `.open-next/assets/${NEXT_CACHE_ASSET_DIRECTORY}`,
  );
  assertContainedPathAbsent(destination, "Next.js private cache asset path is reserved");
  const toolRoot = fs.realpathSync(platformPackageRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf8"));
  if (metadata?.name !== "@opennextjs/cloudflare" || metadata.version !== "1.20.9")
    throw new Error("Next.js platform cache tool is not pinned");
  const { defineCloudflareConfig } = await import(
    pathToFileURL(path.join(toolRoot, "dist/api/index.js")).href
  );
  const { default: incrementalCache } = await import(
    pathToFileURL(
      path.join(
        toolRoot,
        "dist/api/overrides/incremental-cache/static-assets-incremental-cache.js",
      ),
    ).href
  );
  const { populateCache } = await import(
    pathToFileURL(path.join(toolRoot, "dist/cli/commands/populate-cache.js")).href
  );
  // Population selects the cache by its name and ignores cache interception.
  const config = defineCloudflareConfig({ incrementalCache });
  await populateCache({ outputDir }, config, {}, { target: "local" }, {});
  const copied = walk(destination);
  if (copied.length !== inventory.length)
    throw new Error("Next.js populated cache inventory differs");
  for (const entry of inventory) {
    const file = resolveContained(
      applicationRoot,
      `.open-next/assets/${NEXT_CACHE_ASSET_DIRECTORY}/${entry.path}`,
    );
    assertRegularContainedFile(file, "Next.js populated cache");
    if (fs.statSync(file).size !== entry.size || digest(fs.readFileSync(file)) !== entry.digest)
      throw new Error("Next.js populated cache bytes differ");
  }
  return Object.freeze({ files: inventory.length });
}

export function cleanupOpenNextPlatformConfig({ applicationRoot: applicationRootInput }) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  let removed = false;
  for (const name of [".ohmyhost-next-wrangler.jsonc", OPEN_NEXT_PLATFORM_CONFIG_NAME]) {
    const input = path.join(applicationRoot, name);
    try {
      const status = fs.lstatSync(input);
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) throw new Error();
      fs.unlinkSync(input);
      removed = true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error("OpenNext platform config cleanup is unsafe");
    }
  }
  return removed;
}

function validNextEdgeEnvironment(environment) {
  return (
    environment?.FRAMEWORK_ADAPTER === "nextjs" &&
    environment.FRAMEWORK_RUNTIME === "edge" &&
    environment.BUILD_OUTPUT_DIRECTORY === ".open-next/assets" &&
    environment.SERVER_OUTPUT_DIRECTORY === ".ohmyhost-worker" &&
    environment.SERVER_ENTRYPOINT === ".ohmyhost-worker/worker.js" &&
    environment.COMPATIBILITY_FLAGS === "nodejs_compat" &&
    typeof environment.COMPATIBILITY_DATE === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(environment.COMPATIBILITY_DATE)
  );
}

function validTanStackEdgeEnvironment(env) {
  return (
    env?.FRAMEWORK_ADAPTER === "tanstack-start" &&
    env.FRAMEWORK_RUNTIME === "edge" &&
    env.BUILD_OUTPUT_DIRECTORY === "dist/client" &&
    env.SERVER_OUTPUT_DIRECTORY === "dist/server" &&
    env.SERVER_ENTRYPOINT === "dist/server/index.js" &&
    env.SERVER_CONFIG_PATH === "dist/server/wrangler.json" &&
    typeof env.COMPATIBILITY_DATE === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(env.COMPATIBILITY_DATE) &&
    env.COMPATIBILITY_FLAGS === "nodejs_compat"
  );
}

export function createTanStackPlatformConfig({
  applicationRoot: applicationRootInput,
  outputPath: outputPathInput,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const requestedOutputPath = path.resolve(outputPathInput);
  let outputPath;
  try {
    outputPath = path.join(
      fs.realpathSync(path.dirname(requestedOutputPath)),
      path.basename(requestedOutputPath),
    );
  } catch {
    throw new Error("TanStack platform config input is invalid");
  }
  if (
    !validTanStackEdgeEnvironment(environment) ||
    path.dirname(outputPath) !== applicationRoot ||
    path.basename(outputPath) !== TANSTACK_PLATFORM_CONFIG_NAME
  ) {
    throw new Error("TanStack platform config input is invalid");
  }
  assertContainedPathAbsent(outputPath, "TanStack platform config input is invalid");
  const config = Object.freeze({
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-platform-tanstack-build",
    main: "@tanstack/react-start/server-entry",
    compatibility_date: environment.COMPATIBILITY_DATE,
    compatibility_flags: Object.freeze(["nodejs_compat"]),
  });
  fs.writeFileSync(outputPath, JSON.stringify(config), { flag: "wx", mode: 0o400 });
  assertRegularContainedFile(outputPath, "TanStack platform config");
  if ((fs.statSync(outputPath).mode & 0o777) !== 0o400) {
    throw new Error("TanStack platform config input is invalid");
  }
  return config;
}

export function cleanupTanStackPlatformConfig({ applicationRoot: applicationRootInput }) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const configPath = path.join(applicationRoot, TANSTACK_PLATFORM_CONFIG_NAME);
  let status;
  try {
    status = fs.lstatSync(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("TanStack platform config cleanup is unsafe");
  }
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new Error("TanStack platform config cleanup is unsafe");
  }
  fs.unlinkSync(configPath);
  return true;
}

function readTanStackJson(file, label) {
  assertRegularContainedFile(file, label);
  const status = fs.statSync(file);
  if (status.size < 1 || status.size > 64 * 1024)
    throw new Error("TanStack Worker output is invalid");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("TanStack Worker output is invalid");
  }
}

function isEmptyTanStackCapability(field, value) {
  if (value === null) return true;
  if (TANSTACK_EMPTY_ARRAY_FIELDS.has(field)) return Array.isArray(value) && value.length === 0;
  if (field === "vars" || field === "exports" || field === "cloudchamber" || field === "triggers") {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    );
  }
  if (field === "durable_objects" || field === "logfwdr") {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      hasExactKeys(value, ["bindings"]) &&
      Array.isArray(value.bindings) &&
      value.bindings.length === 0
    );
  }
  if (field === "queues") {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      hasExactKeys(value, ["consumers", "producers"]) &&
      Array.isArray(value.consumers) &&
      value.consumers.length === 0 &&
      Array.isArray(value.producers) &&
      value.producers.length === 0
    );
  }
  if (field === "python_modules") {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      hasExactKeys(value, ["exclude"]) &&
      JSON.stringify(value.exclude) === '["**/*.pyc"]'
    );
  }
  return false;
}

function hasTanStackGeneratedDevDefaults(value) {
  return (
    hasExactKeys(value, TANSTACK_GENERATED_DEV_DEFAULT_KEYS) &&
    value.enable_containers === true &&
    value.generate_types === false &&
    value.ip === "localhost" &&
    value.local_protocol === "http" &&
    value.upstream_protocol === "http"
  );
}

export function validateTanStackBuildOutput({
  applicationRoot: applicationRootInput,
  environment,
}) {
  let applicationRoot;
  try {
    applicationRoot = fs.realpathSync(applicationRootInput);
    if (!validTanStackEdgeEnvironment(environment)) throw new Error();
    const assetRoot = resolveContained(applicationRoot, environment.BUILD_OUTPUT_DIRECTORY);
    const serverRoot = resolveContained(applicationRoot, environment.SERVER_OUTPUT_DIRECTORY);
    const entrypoint = resolveContained(applicationRoot, environment.SERVER_ENTRYPOINT);
    const generatedConfigPath = resolveContained(applicationRoot, environment.SERVER_CONFIG_PATH);
    const deployRoot = resolveContained(applicationRoot, ".wrangler/deploy");
    const redirectPath = resolveContained(applicationRoot, TANSTACK_DEPLOY_REDIRECT_PATH);
    assertRegularContainedFile(generatedConfigPath, "generated Worker config");
    const deployFiles = walk(deployRoot).map((file) => safeRelative(deployRoot, file));
    if (JSON.stringify(deployFiles) !== '["config.json"]') throw new Error();
    const redirectBody = fs.readFileSync(redirectPath);
    const redirect = readTanStackJson(redirectPath, "TanStack Worker redirect");
    if (
      Buffer.compare(redirectBody, Buffer.from(JSON.stringify(redirect))) !== 0 ||
      !hasExactKeys(redirect, ["auxiliaryWorkers", "configPath"]) ||
      !Array.isArray(redirect.auxiliaryWorkers) ||
      redirect.auxiliaryWorkers.length !== 0 ||
      redirect.configPath !== TANSTACK_DEPLOY_REDIRECT_TARGET ||
      path.resolve(deployRoot, redirect.configPath) !== generatedConfigPath
    ) {
      throw new Error();
    }
    const generated = readTanStackJson(generatedConfigPath, "generated Worker config");
    if (generated.upload_source_maps === true)
      throw new Error("TanStack Worker source maps are unsupported");
    if (
      !hasExactKeys(generated, TANSTACK_GENERATED_CONFIG_KEYS) &&
      !(
        hasExactKeys(generated, [...TANSTACK_GENERATED_CONFIG_KEYS, "k2"].sort()) &&
        Array.isArray(generated.k2) &&
        generated.k2.length === 0
      )
    )
      throw new Error();
    if (
      generated.main !== "index.js" ||
      generated.no_bundle !== true ||
      generated.compatibility_date !== environment.COMPATIBILITY_DATE ||
      JSON.stringify(generated.compatibility_flags) !== '["nodejs_compat"]' ||
      !hasExactKeys(generated.assets, ["directory"]) ||
      generated.assets.directory !== "../client" ||
      path.resolve(serverRoot, generated.assets.directory) !== assetRoot ||
      path.resolve(serverRoot, generated.main) !== entrypoint ||
      JSON.stringify(generated.rules) !== '[{"type":"ESModule","globs":["**/*.js","**/*.mjs"]}]'
    ) {
      throw new Error();
    }
    if (
      !Array.isArray(generated.definedEnvironments) ||
      generated.definedEnvironments.length !== 0 ||
      !hasTanStackGeneratedDevDefaults(generated.dev)
    ) {
      throw new Error("generated Worker config metadata is invalid");
    }
    for (const field of TANSTACK_EMPTY_GENERATED_CAPABILITY_FIELDS) {
      if (!isEmptyTanStackCapability(field, generated[field]))
        throw new Error("generated Worker config capability is invalid");
    }
    const serverFiles = walk(serverRoot);
    if (serverFiles.some((file) => /\.map$/u.test(file))) {
      throw new Error("TanStack Worker source maps are unsupported");
    }
    if (
      serverFiles.some((file) => /\.(?:py|pyc)$/u.test(file)) ||
      serverFiles.includes(path.join(serverRoot, "server.js")) ||
      !serverFiles.includes(entrypoint)
    ) {
      throw new Error();
    }
    const moduleFiles = serverFiles.filter((file) => file.endsWith(".js"));
    if (!moduleFiles.length || moduleFiles.length > 1000) throw new Error();
    return Object.freeze({ assetRoot, serverRoot, entrypoint, generatedConfigPath, redirectPath });
  } catch (error) {
    if (
      error?.message === "TanStack Worker output is invalid" ||
      error?.message === "generated Worker config capability is invalid" ||
      error?.message === "generated Worker config metadata is invalid" ||
      error?.message === "TanStack Worker source maps are unsupported" ||
      error?.message === "generated Worker config is unsafe" ||
      error?.message === "TanStack Worker redirect is unsafe"
    ) {
      throw error;
    }
    throw new Error("TanStack Worker output is invalid");
  }
}

export function finalizeViteCompanionOutput({
  applicationRoot: applicationRootInput,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const env = environment;
  if (!validViteCompanionEnvironment(env)) {
    throw new Error("Vite companion dry-run output is invalid");
  }
  return finalizeWranglerDryRunOutput(
    resolveContained(applicationRoot, env.SERVER_OUTPUT_DIRECTORY),
    "2025-01-01",
    "Vite companion",
  );
}

function validViteCompanionEnvironment(env) {
  return (
    env.FRAMEWORK_ADAPTER === "vite-static" &&
    env.FRAMEWORK_RUNTIME === "edge" &&
    env.BUILD_OUTPUT_DIRECTORY === "dist" &&
    env.SERVER_OUTPUT_DIRECTORY === ".ohmyhost/vite-companion" &&
    env.SERVER_ENTRYPOINT === ".ohmyhost/vite-companion/worker.js" &&
    env.SERVER_CONFIG_PATH === ".ohmyhost/vite-companion/wrangler.jsonc" &&
    env.COMPATIBILITY_DATE === "2025-01-01" &&
    env.COMPATIBILITY_FLAGS === "nodejs_compat"
  );
}

export function validateSourceArchiveBytes(archive) {
  if (!(archive instanceof Uint8Array)) throw new Error("archive input is invalid");
  let body;
  try {
    body = zlib.gunzipSync(archive, { maxOutputLength: 536_870_913 });
  } catch {
    throw new Error("archive compression is invalid or exceeds limits");
  }
  const field = (block, start, length) =>
    block
      .subarray(start, start + length)
      .toString("ascii")
      .replace(/\0.*$/u, "");
  const octal = (block, start, length) => {
    const value = field(block, start, length).trim();
    if (!/^[0-7]+$/u.test(value)) throw new Error("archive numeric field is invalid");
    return Number.parseInt(value, 8);
  };
  const roots = new Set();
  let entries = 0;
  let totalBytes = 0;
  let offset = 0;
  let ended = false;
  let githubPaxCommentSeen = false;
  while (offset + 512 <= body.length) {
    const block = body.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (
        offset + 1024 > body.length ||
        !body.subarray(offset, offset + 1024).every((byte) => byte === 0)
      ) {
        throw new Error("archive terminator is invalid");
      }
      ended = true;
      break;
    }
    entries += 1;
    if (entries > 100_000) throw new Error("archive entry limit exceeded");
    const storedChecksum = octal(block, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : block[index];
    }
    if (storedChecksum !== actualChecksum) throw new Error("archive checksum is invalid");
    const size = octal(block, 124, 12);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > body.length) {
      throw new Error("archive entry is truncated");
    }
    const type = String.fromCharCode(block[156] || 0);
    const name = field(block, 0, 100);
    const prefix = field(block, 345, 155);
    if (type === "g") {
      const content = body.subarray(offset + 512, offset + 512 + size);
      if (
        githubPaxCommentSeen ||
        entries !== 1 ||
        roots.size !== 0 ||
        prefix !== "" ||
        name !== "pax_global_header" ||
        content.byteLength !== 52 ||
        !/^52 comment=[0-9a-f]{40}\n$/u.test(content.toString("utf8"))
      ) {
        throw new Error("archive global header is invalid");
      }
      githubPaxCommentSeen = true;
      offset = next;
      continue;
    }
    if (type !== "\0" && type !== "0" && type !== "5") {
      throw new Error("archive links and special files are forbidden");
    }
    const archiveEntryPath = (prefix ? `${prefix}/${name}` : name).replace(/\/$/u, "");
    if (!archiveEntryPath || archiveEntryPath.startsWith("/") || archiveEntryPath.includes("\\")) {
      throw new Error("archive path is unsafe");
    }
    const parts = archiveEntryPath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("archive path is unsafe");
    }
    roots.add(parts[0]);
    if (type !== "5") totalBytes += size;
    if (totalBytes > 536_870_912) throw new Error("archive byte limit exceeded");
    offset = next;
  }
  if (!ended || entries === 0 || roots.size !== 1) {
    throw new Error("archive must contain one top-level directory");
  }
  return Object.freeze({ root: [...roots][0], entries, totalBytes });
}

export function validateSourceArchive(archivePath) {
  return validateSourceArchiveBytes(fs.readFileSync(archivePath));
}

function resolveContained(applicationRoot, value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    throw new Error("application path must be relative");
  }
  const candidate = path.resolve(applicationRoot, value);
  const relative = path.relative(applicationRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("application path escapes root");
  }
  let current = applicationRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("application path ancestry is unsafe");
    }
  }
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync(candidate);
    const realRelative = path.relative(applicationRoot, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error("application path resolves outside root");
    }
  }
  return candidate;
}

function safeRelative(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    throw new Error("unsafe output path");
  }
  if (
    !relative ||
    relative.length > 248 ||
    relative.includes("?") ||
    relative.includes("#") ||
    [...relative].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    }) ||
    decoded.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("unsafe output path");
  }
  return relative;
}

/**
 * The archive-safe relative path of a customer's file. A name the platform cannot serve or archive is
 * a packaging limit that names the file, so the customer can rename it; the internal guard still applies.
 */
function customerFileRelative(root, file, archiveFolder) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const shown = [...relative]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint > 31 && codePoint !== 127;
    })
    .slice(0, 200)
    .join("");
  let safe;
  try {
    safe = safeRelative(root, file);
  } catch {
    throw new PackagingLimitError(
      `/${shown} cannot be packaged: a file name may be at most 248 characters, may not contain a question mark, hash sign or control character, and each percent sign must start a two-digit escape such as %25; rename the file, then commit, push and deploy the new commit`,
    );
  }
  if (ustarPathFields(`${archiveFolder}${safe}`) === null) {
    throw new PackagingLimitError(
      `/${shown} cannot be packaged: its path is too long for the deployment archive, which allows 100 bytes for each part of a name and 255 bytes for the whole path; shorten the file name or its folders, then commit, push and deploy the new commit`,
    );
  }
  return safe;
}

function walk(root) {
  if (!fs.statSync(root).isDirectory()) throw new Error("build output directory is missing");
  const files = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodePoints(left.name, right.name))) {
      const full = path.join(directory, entry.name);
      const status = fs.lstatSync(full);
      if (
        status.isSymbolicLink() ||
        (!status.isDirectory() && !status.isFile()) ||
        (status.isFile() && status.nlink !== 1)
      ) {
        throw new Error("unsafe build output");
      }
      if (status.isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(root);
  return files;
}

function digest(body) {
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}

function assertRegularContainedFile(file, label) {
  const status = fs.lstatSync(file);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new Error(`${label} is unsafe`);
  }
}

function assertReservedBuildPathAbsent(file) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("reserved platform build path already exists");
}

function assertContainedPathAbsent(file, label) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(label);
  }
  throw new Error(label);
}

export function validateNextWorkerConfig({
  applicationRoot: applicationRootInput,
  configPath: configPathInput,
  environment: env,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const configPath = resolveContained(applicationRoot, configPathInput);
  assertRegularContainedFile(configPath, "Next.js Worker config");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/,\s*([}\]])/gu, "$1"));
  } catch {
    throw new Error("Next.js Worker config must be comment-free JSONC");
  }
  const keys = [
    "$schema",
    "assets",
    "compatibility_date",
    "compatibility_flags",
    "main",
    "name",
  ].sort();
  if (!hasExactKeys(config, keys)) {
    throw new Error("Next.js Worker config shape is invalid");
  }
  if (
    config.$schema !== "./node_modules/wrangler/config-schema.json" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(config.name) ||
    config.main !== ".open-next/worker.js" ||
    config.compatibility_date !== env.COMPATIBILITY_DATE ||
    JSON.stringify(config.compatibility_flags) !== '["nodejs_compat"]'
  ) {
    throw new Error("Next.js Worker config identity is invalid");
  }
  if (
    !hasExactKeys(config.assets, ["binding", "directory", "run_worker_first"]) ||
    config.assets.directory !== ".open-next/assets" ||
    config.assets.binding !== "ASSETS" ||
    config.assets.run_worker_first !== true
  ) {
    throw new Error("Next.js Worker asset config is invalid");
  }
  return Object.freeze(config);
}

export function validateNextWorkerMetafile({
  applicationRoot: applicationRootInput,
  metafilePath: metafilePathInput,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const metafilePath = resolveContained(applicationRoot, metafilePathInput);
  assertRegularContainedFile(metafilePath, "Next.js Worker metafile");
  const status = fs.statSync(metafilePath);
  if (status.size === 0 || status.size > MAXIMUM_NEXT_WRANGLER_METAFILE_BYTES) {
    throw new Error("Next.js Worker metafile is invalid");
  }
  let metafile;
  try {
    metafile = JSON.parse(fs.readFileSync(metafilePath, "utf8"));
  } catch {
    throw new Error("Next.js Worker metafile is invalid");
  }
  if (!hasExactKeys(metafile, ["inputs", "outputs"])) {
    throw new Error("Next.js Worker metafile is invalid");
  }
  const inputs = metafile.inputs;
  const outputs = metafile.outputs;
  if (
    inputs === null ||
    typeof inputs !== "object" ||
    Array.isArray(inputs) ||
    outputs === null ||
    typeof outputs !== "object" ||
    Array.isArray(outputs) ||
    Object.keys(inputs).length === 0 ||
    Object.keys(inputs).length > 20_000 ||
    Object.keys(outputs).length === 0 ||
    Object.keys(outputs).length > 32
  ) {
    throw new Error("Next.js Worker metafile is invalid");
  }
  let nativeAddonFound = false;
  for (const [inputPath, input] of Object.entries(inputs)) {
    validateMetafilePath(inputPath);
    if (/\.node$/u.test(inputPath)) nativeAddonFound = true;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Next.js Worker metafile is invalid");
    }
    validateMetafileImports(input.imports);
    if (input.imports.some((entry) => /\.node$/u.test(entry.path))) nativeAddonFound = true;
  }
  for (const [outputPath, output] of Object.entries(outputs)) {
    validateMetafilePath(outputPath);
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
      throw new Error("Next.js Worker metafile is invalid");
    }
    validateMetafileImports(output.imports);
    if (output.imports.some((entry) => /\.node$/u.test(entry.path))) nativeAddonFound = true;
  }
  if (nativeAddonFound)
    throw new Error("Next.js build bundles a native addon that does not function on Workers");
  return Object.freeze({
    inputCount: Object.keys(inputs).length,
    outputCount: Object.keys(outputs).length,
  });
}

function validateMetafilePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0") ||
    value.includes("\\")
  ) {
    throw new Error("Next.js Worker metafile is invalid");
  }
}

function validateMetafileImports(value) {
  if (!Array.isArray(value) || value.length > 20_000) {
    throw new Error("Next.js Worker metafile is invalid");
  }
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 1_024 ||
      typeof entry.kind !== "string" ||
      entry.kind.length === 0 ||
      entry.kind.length > 64 ||
      (entry.external !== undefined && typeof entry.external !== "boolean")
    ) {
      throw new Error("Next.js Worker metafile is invalid");
    }
  }
}

export function copyBuildOutputFile(root, file, destination) {
  const relative = safeRelative(root, file);
  const target = path.join(destination, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The file is opened without following a link and copied from that descriptor, so a path that
  // was swapped for a link after walk() cannot redirect the copy to another file.
  let source;
  try {
    source = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error("unsafe build output");
  }
  try {
    const status = fs.fstatSync(source);
    if (!status.isFile() || status.nlink !== 1) throw new Error("unsafe build output");
    const output = fs.openSync(target, "wx", status.mode & 0o777);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const count = fs.readSync(source, buffer, 0, buffer.length, null);
        if (count === 0) break;
        fs.writeSync(output, buffer, 0, count);
      }
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(source);
  }
  return relative;
}

function readDatabaseMigrations(migrationRoot, destination) {
  const files = walk(migrationRoot);
  if (files.length === 0 || files.length > MAXIMUM_MIGRATION_FILES) {
    throw new Error("database migration inventory is invalid");
  }
  let totalBytes = 0;
  const migrations = files.map((file) => {
    const relative = customerFileRelative(migrationRoot, file, "migrations/");
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/u.test(relative)) {
      throw new Error("database migration path is invalid");
    }
    const body = fs.readFileSync(file);
    totalBytes += body.byteLength;
    if (
      body.byteLength === 0 ||
      body.byteLength > MAXIMUM_MIGRATION_FILE_BYTES ||
      totalBytes > MAXIMUM_MIGRATION_TOTAL_BYTES ||
      (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) ||
      body.includes(0)
    ) {
      throw new Error("database migration content is invalid");
    }
    let sql;
    try {
      sql = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new Error("database migration content is invalid");
    }
    if (sql.includes("\r")) throw new Error("database migration content is not canonical");
    if (destination !== undefined) copyBuildOutputFile(migrationRoot, file, destination);
    return Object.freeze({ path: relative, digest: digest(body), size: body.byteLength });
  });
  return Object.freeze(migrations);
}

export function snapshotDatabaseMigrations({
  applicationRoot: applicationRootInput,
  databaseRequirementJson,
  snapshotRoot,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const database = validateDatabaseRequirementJson(databaseRequirementJson);
  if (!database.enabled) return Object.freeze({ database, migrations: Object.freeze([]) });
  if (fs.existsSync(snapshotRoot)) throw new Error("database migration snapshot already exists");
  const migrationRoot = resolveContained(applicationRoot, database.migrations);
  fs.mkdirSync(snapshotRoot, { recursive: false, mode: 0o700 });
  const migrations = readDatabaseMigrations(migrationRoot, snapshotRoot);
  for (const file of walk(snapshotRoot)) fs.chmodSync(file, 0o400);
  const directories = [snapshotRoot];
  for (const file of walk(snapshotRoot)) {
    let directory = path.dirname(file);
    while (directory !== snapshotRoot) {
      directories.push(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of new Set(directories)) fs.chmodSync(directory, 0o500);
  return Object.freeze({ database, migrations });
}

function packageDatabaseMigrations(applicationRoot, bundleRoot, database, migrationSnapshotRoot) {
  if (!database.enabled) return null;
  const migrationRoot =
    migrationSnapshotRoot === undefined
      ? resolveContained(applicationRoot, database.migrations)
      : fs.realpathSync(migrationSnapshotRoot);
  return readDatabaseMigrations(migrationRoot, path.join(bundleRoot, "migrations"));
}

export function createDependencyInventory({ applicationRoot: applicationRootInput, outputPath }) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const requestedOutput = path.resolve(outputPath);
  const resolvedOutput = path.join(
    fs.realpathSync(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  if (
    path.dirname(resolvedOutput) !== applicationRoot ||
    path.basename(resolvedOutput) !== ".ohmyhost-resolved-dependencies.json" ||
    fs.existsSync(resolvedOutput)
  ) {
    throw new Error("dependency inventory output is invalid");
  }
  const nodeModules = path.join(applicationRoot, "node_modules");
  const components = new Map();
  if (fs.existsSync(nodeModules)) {
    const pending = [nodeModules];
    let visited = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      visited += 1;
      if (visited > 100_000) throw new Error("dependency inventory exceeds limit");
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          pending.push(full);
          continue;
        }
        if (!entry.isFile() || entry.name !== "package.json") continue;
        const status = fs.lstatSync(full);
        if (status.size < 2 || status.size > 1_048_576) {
          throw new Error("dependency package metadata is invalid");
        }
        let packageJson;
        try {
          packageJson = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          throw new Error("dependency package metadata is invalid");
        }
        if (
          typeof packageJson.name !== "string" ||
          packageJson.name.length < 1 ||
          packageJson.name.length > 214 ||
          typeof packageJson.version !== "string" ||
          !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u.test(
            packageJson.version,
          )
        ) {
          continue;
        }
        components.set(`${packageJson.name}\0${packageJson.version}`, {
          name: packageJson.name,
          version: packageJson.version,
        });
        if (components.size > 20_000) throw new Error("dependency inventory exceeds limit");
      }
    }
  }
  const inventory = Object.freeze({
    schemaVersion: "ohmyhost.dependencies/v1",
    components: Object.freeze(
      [...components.values()].sort((left, right) =>
        compareCodePoints(`${left.name}\0${left.version}`, `${right.name}\0${right.version}`),
      ),
    ),
  });
  fs.writeFileSync(resolvedOutput, JSON.stringify(inventory), { flag: "wx", mode: 0o400 });
  return inventory;
}

function createCycloneDxSbom(applicationRoot, dependencyEvidencePath, operationId) {
  const packageJsonPath = resolveContained(applicationRoot, "package.json");
  assertRegularContainedFile(packageJsonPath, "application package.json");
  assertRegularContainedFile(dependencyEvidencePath, "dependency evidence");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const evidence = JSON.parse(fs.readFileSync(dependencyEvidencePath, "utf8"));
  const components = new Map();
  const purlName = (name) =>
    name.startsWith("@")
      ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
      : encodeURIComponent(name);
  const visit = (name, node) => {
    if (!node || typeof node !== "object") return;
    const version = typeof node.version === "string" ? node.version : "";
    if (name && version) {
      const purl = `pkg:npm/${purlName(name)}@${encodeURIComponent(version)}`;
      components.set(`${name}@${version}`, {
        type: "library",
        name,
        version,
        purl,
        "bom-ref": purl,
      });
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const children = node[field];
      if (children && typeof children === "object") {
        for (const [childName, child] of Object.entries(children)) visit(childName, child);
      }
    }
  };
  if (
    evidence?.schemaVersion === "ohmyhost.dependencies/v1" &&
    Array.isArray(evidence.components) &&
    hasExactKeys(evidence, ["components", "schemaVersion"])
  ) {
    for (const component of evidence.components) {
      if (
        !hasExactKeys(component, ["name", "version"]) ||
        typeof component.name !== "string" ||
        typeof component.version !== "string"
      ) {
        throw new Error("dependency evidence is invalid");
      }
      visit(component.name, component);
    }
  } else {
    for (const root of Array.isArray(evidence) ? evidence : [evidence]) visit(undefined, root);
  }
  const uuidBytes = crypto.createHash("sha256").update(operationId).digest().subarray(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 15) | 80;
  uuidBytes[8] = (uuidBytes[8] & 63) | 128;
  const uuidHex = uuidBytes.toString("hex");
  const uuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
  return Buffer.from(
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: `urn:uuid:${uuid}`,
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: packageJson.name || "web-application",
          version: String(packageJson.version || "0.0.0"),
        },
      },
      components: [...components.values()].sort((left, right) =>
        compareCodePoints(left["bom-ref"], right["bom-ref"]),
      ),
    })}\n`,
  );
}

export function packageBuildArtifact({
  applicationRoot: applicationRootInput,
  bundleRoot,
  dependencyEvidencePath: dependencyEvidencePathInput,
  packageManagerReceiptPath,
  compressedWorkerPath,
  migrationSnapshotRoot,
  environment,
}) {
  const applicationRoot = fs.realpathSync(applicationRootInput);
  const env = environment;
  const writableNextCache = nextPathRevalidationEnabled(env);
  if (writableNextCache && (env.FRAMEWORK_ADAPTER !== "nextjs" || env.FRAMEWORK_RUNTIME !== "edge"))
    throw new Error("Next.js cache mode is invalid");
  const database = validateDatabaseRequirementJson(env.DATABASE_REQUIREMENT_JSON);
  const auth = validateCustomerAuthRequirementJson(env.AUTH_REQUIREMENT_JSON);
  const mail = validateMailRequirementJson(env.MAIL_REQUIREMENT_JSON);
  const mailIssue = managedCustomerAuthAdmissionIssue({ auth, database, mail });
  if (mailIssue !== null) {
    throw Object.assign(new Error(mailIssue.message), { code: mailIssue.code });
  }
  const buildProjectName = buildProjectNameFromBuildId(env.BUILD_ID);
  const functionsRuntime = env.FRAMEWORK_RUNTIME === "functions";
  if (functionsRuntime && !validFunctionsRuntimeEnvironment(env)) {
    throw new Error("functions framework plan is invalid");
  }
  const assetRoot = functionsRuntime
    ? null
    : resolveContained(applicationRoot, env.BUILD_OUTPUT_DIRECTORY);
  const dependencyEvidencePath = resolveContained(applicationRoot, dependencyEvidencePathInput);
  const packageManager = readPackageManagerReceipt(packageManagerReceiptPath);
  const currentPackageManager = readBuildPackageManagerEvidence(applicationRoot, env);
  if (JSON.stringify(packageManager) !== JSON.stringify(currentPackageManager)) {
    throw new Error("build lifecycle package manager evidence changed");
  }
  const configurationDigest = readRepositoryConfigurationDigest(
    applicationRoot,
    env.APPLICATION_ROOT,
  );
  const allAssetFiles = assetRoot === null ? [] : walk(assetRoot);
  for (const file of allAssetFiles) customerFileRelative(assetRoot, file, "assets/");
  const assetIgnore = allAssetFiles.find(
    (file) => safeRelative(assetRoot, file) === ".assetsignore",
  );
  if (
    (env.FRAMEWORK_ADAPTER === "astro" || env.FRAMEWORK_ADAPTER === "tanstack-start") &&
    env.FRAMEWORK_RUNTIME === "edge"
  ) {
    if (
      env.SERVER_OUTPUT_DIRECTORY !== "dist/server" ||
      env.SERVER_ENTRYPOINT !==
        (env.FRAMEWORK_ADAPTER === "astro" ? "dist/server/entry.mjs" : "dist/server/index.js") ||
      env.SERVER_CONFIG_PATH !== "dist/server/wrangler.json" ||
      env.COMPATIBILITY_FLAGS !== "nodejs_compat"
    ) {
      throw new Error("edge framework plan is invalid");
    }
    if (
      assetIgnore === undefined ||
      fs.readFileSync(assetIgnore, "utf8") !== "wrangler.json\n.dev.vars\n"
    ) {
      throw new Error("generated asset exclusion evidence is invalid");
    }
  } else if (assetIgnore !== undefined) {
    throw new Error("unexpected static asset control file");
  }
  const assetFiles = allAssetFiles.filter((file) => file !== assetIgnore);
  if (
    env.FRAMEWORK_ADAPTER === "astro" &&
    assetFiles.some((file) =>
      /(?:\.map$|(?:^|\/)(?:wrangler\.jsonc?|entry\.mjs|\.dev\.vars)$)/u.test(file),
    )
  )
    throw new Error("Astro public assets contain server configuration or source maps");
  const ssgCacheMaxBytes =
    env.FRAMEWORK_ADAPTER === "nextjs" && env.FRAMEWORK_RUNTIME === "edge"
      ? nextSsgCacheMaxBytes(env)
      : null;
  if (functionsRuntime && assetFiles.length !== 0) throw new Error("invalid asset inventory");
  if (!functionsRuntime && assetFiles.length === 0) {
    throw new PackagingLimitError(
      `${env.BUILD_OUTPUT_DIRECTORY} has no static files; the build must write its output there`,
    );
  }
  if (assetFiles.length > 1000) {
    throw new PackagingLimitError(
      ssgCacheMaxBytes === null
        ? `${env.BUILD_OUTPUT_DIRECTORY} has ${String(assetFiles.length)} static files; at most 1,000 are allowed (each at most 10485760 bytes, 25 MiB in total)`
        : `${env.BUILD_OUTPUT_DIRECTORY} has ${String(assetFiles.length)} public and private cache files; at most 1,000 are allowed together (each at most 10485760 bytes)`,
    );
  }
  let assetBytes = 0;
  let ssgCacheBytes = 0;
  const assets = assetFiles
    .map((file) => {
      const body = fs.readFileSync(file);
      if (body.length > 10_485_760) {
        throw new PackagingLimitError(
          `/${safeRelative(assetRoot, file)} is ${String(body.length)} bytes; each static file may be at most 10485760 bytes (${STATIC_FILE_LIMITS})`,
        );
      }
      const relative = safeRelative(assetRoot, file);
      if (ssgCacheMaxBytes !== null && relative.startsWith(`${NEXT_CACHE_ASSET_DIRECTORY}/`)) {
        ssgCacheBytes += body.length;
        assertNextSsgCacheSize(ssgCacheBytes, ssgCacheMaxBytes);
      } else assetBytes += body.length;
      if (assetBytes > 26_214_400) {
        throw new PackagingLimitError(
          `the static files in ${env.BUILD_OUTPUT_DIRECTORY} exceed 26214400 bytes together; each static file may be at most 10485760 bytes (${STATIC_FILE_LIMITS})`,
        );
      }
      copyBuildOutputFile(assetRoot, file, path.join(bundleRoot, "assets"));
      assertRootOriginFrameworkAsset(env.FRAMEWORK_ADAPTER, relative, body);
      return { path: `/${relative}`, digest: digest(body), size: body.length };
    })
    .sort((left, right) => compareCodePoints(left.path, right.path));
  if (env.FRAMEWORK_RUNTIME === "static" && !assets.some((asset) => asset.path === "/index.html")) {
    throw new PackagingLimitError(
      `${env.BUILD_OUTPUT_DIRECTORY} has no index.html; a static site serves index.html from the top of its build output`,
    );
  }
  const requestedFunctions = readFunctionsRequirement(env);
  let verifiedFunctions = null;
  let runtime = null;
  let modules = [];
  if (functionsRuntime) {
    const inventory = readFinalizedWorkerModule(
      applicationRoot,
      env.SERVER_OUTPUT_DIRECTORY,
      "2025-01-01",
      "functions",
    );
    modules = copyWorkerModules(inventory, bundleRoot, env.FRAMEWORK_ADAPTER);
    verifiedFunctions = requestedFunctions;
    runtime = {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "functions-v1",
    };
  } else if (env.FRAMEWORK_ADAPTER === "vite-static" && env.FRAMEWORK_RUNTIME === "edge") {
    if (!validViteCompanionEnvironment(env)) {
      throw new Error("Vite companion framework plan is invalid");
    }
    const inventory = readFinalizedWorkerModule(
      applicationRoot,
      env.SERVER_OUTPUT_DIRECTORY,
      "2025-01-01",
      "Vite companion",
    );
    modules = copyWorkerModules(inventory, bundleRoot, env.FRAMEWORK_ADAPTER);
    verifiedFunctions = requestedFunctions;
    runtime = {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "vite-api-companion-v1",
    };
  } else if (env.FRAMEWORK_ADAPTER === "astro" && env.FRAMEWORK_RUNTIME === "edge") {
    const { serverRoot, entrypoint } = validateAstroBuildOutput({
      applicationRoot,
      environment: env,
    });
    const moduleFiles = walk(serverRoot).filter((file) => /\.(?:m?js|wasm)$/u.test(file));
    modules = copyWorkerModules(
      readWorkerModules(serverRoot, moduleFiles, entrypoint, "Astro"),
      bundleRoot,
      env.FRAMEWORK_ADAPTER,
    );
    modules = attachFunctionsWorkerModule(
      applicationRoot,
      bundleRoot,
      env,
      requestedFunctions,
      modules,
    );
    verifiedFunctions = requestedFunctions;
    runtime = {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: env.COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "astro-edge-wrapper-v1",
    };
  } else if (env.FRAMEWORK_ADAPTER === "tanstack-start" && env.FRAMEWORK_RUNTIME === "edge") {
    const tanstackOutput = validateTanStackBuildOutput({
      applicationRoot,
      environment: env,
    });
    const { serverRoot, entrypoint } = tanstackOutput;
    const serverFiles = walk(serverRoot);
    const moduleFiles = serverFiles.filter((file) => /\.(?:m?js|wasm)$/u.test(file));
    modules = copyWorkerModules(
      readWorkerModules(serverRoot, moduleFiles, entrypoint, "TanStack"),
      bundleRoot,
      env.FRAMEWORK_ADAPTER,
    );
    modules = attachFunctionsWorkerModule(
      applicationRoot,
      bundleRoot,
      env,
      requestedFunctions,
      modules,
    );
    verifiedFunctions = requestedFunctions;
    runtime = {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: env.COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "tanstack-edge-wrapper-v1",
    };
    cleanupTanStackPlatformConfig({ applicationRoot });
  } else if (env.FRAMEWORK_ADAPTER === "nextjs" && env.FRAMEWORK_RUNTIME === "edge") {
    if (
      env.SERVER_OUTPUT_DIRECTORY !== ".ohmyhost-worker" ||
      env.SERVER_ENTRYPOINT !== ".ohmyhost-worker/worker.js" ||
      env.SERVER_CONFIG_PATH !== "wrangler.jsonc" ||
      env.COMPATIBILITY_FLAGS !== "nodejs_compat"
    ) {
      throw new Error("Next.js framework plan is invalid");
    }
    const serverRoot = resolveContained(applicationRoot, env.SERVER_OUTPUT_DIRECTORY);
    const entrypoint = resolveContained(applicationRoot, env.SERVER_ENTRYPOINT);
    const serverFiles = walk(serverRoot);
    const relativeServerFiles = serverFiles.map((file) => safeRelative(serverRoot, file));
    if (
      JSON.stringify(
        relativeServerFiles.filter(
          (name) => !/\.(?:mjs|wasm)$/u.test(name) && name !== "worker.js",
        ),
      ) !== '["README.md","worker.js.map"]' ||
      relativeServerFiles.length > 1000 ||
      !serverFiles.includes(entrypoint)
    ) {
      throw new Error("Next.js Wrangler dry-run output is invalid");
    }
    const main = fs.readFileSync(entrypoint);
    const readmeSize = fs.statSync(path.join(serverRoot, "README.md")).size;
    const sourceMapSize = fs.statSync(path.join(serverRoot, "worker.js.map")).size;
    if (
      readmeSize < 1 ||
      readmeSize > 4096 ||
      sourceMapSize < 1 ||
      sourceMapSize > MAXIMUM_NEXT_WRANGLER_SOURCE_MAP_BYTES
    ) {
      throw new Error("Next.js Wrangler evidence exceeds limit");
    }
    const compressedPath = resolveContained(applicationRoot, compressedWorkerPath);
    assertRegularContainedFile(compressedPath, "compressed Worker evidence");
    const compressed = fs.readFileSync(compressedPath);
    if (main.length > 15_728_640 || compressed.length > 10_485_760) {
      throw new PackagingLimitError(
        `the Next.js Worker is ${String(main.length)} bytes, ${String(compressed.length)} gzip-compressed; it may be at most 15728640 bytes, 10485760 gzip-compressed`,
      );
    }
    if (!main.length || !compressed.length) throw new Error("Next.js Worker module is empty");
    const moduleFiles = serverFiles.filter((file) => /\.(?:m?js|wasm)$/u.test(file));
    const inventory = readWorkerModules(
      serverRoot,
      moduleFiles,
      entrypoint,
      "Next.js",
      false,
      15_728_640,
    );
    inventory.modules.push(...readNextTracedRuntimeModules(applicationRoot, inventory.modules));
    modules = copyWorkerModules(inventory, bundleRoot, env.FRAMEWORK_ADAPTER);
    modules = attachFunctionsWorkerModule(
      applicationRoot,
      bundleRoot,
      env,
      requestedFunctions,
      modules,
    );
    verifiedFunctions = requestedFunctions;
    runtime = {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: env.COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "nextjs-opennext-wrapper-v1",
      ssgCacheMaxBytes,
      ...(writableNextCache ? { nextRevalidatePath: true } : {}),
    };
    fs.unlinkSync(compressedPath);
  } else if (
    env.SERVER_OUTPUT_DIRECTORY ||
    env.SERVER_ENTRYPOINT ||
    env.SERVER_CONFIG_PATH ||
    env.COMPATIBILITY_DATE ||
    env.COMPATIBILITY_FLAGS
  ) {
    throw new Error("static build received edge configuration");
  }
  const dependencyInventorySha256 = digest(fs.readFileSync(dependencyEvidencePath)).slice(
    "sha256:".length,
  );
  const sbom = createCycloneDxSbom(applicationRoot, dependencyEvidencePath, env.OPERATION_ID);
  fs.writeFileSync(path.join(bundleRoot, "sbom.cdx.json"), sbom);
  fs.unlinkSync(dependencyEvidencePath);
  const applicationRootEvidence = validateApplicationRoot(env.APPLICATION_ROOT);
  const runtimePolicy = validateRuntimePolicyJson(env.RUNTIME_POLICY_JSON);
  const storage = validateStorageRequirementJson(env.STORAGE_REQUIREMENT_JSON);
  if (runtime === null && requestedFunctions !== null) {
    throw new Error("static build received functions requirement");
  }
  if (auth.provider === "better-auth" && !database.enabled) {
    throw new Error("customer auth database requirement is invalid");
  }
  if (runtime === null && storage.enabled) {
    throw new Error("static storage requirement is invalid");
  }
  const migrations = packageDatabaseMigrations(
    applicationRoot,
    bundleRoot,
    database,
    migrationSnapshotRoot,
  );
  const packagedFiles = walk(bundleRoot).map((file) => ({
    path: safeRelative(bundleRoot, file),
    body: fs.readFileSync(file),
  }));
  const credentialScan = scanCredentialFreeBuildOutput(
    packagedFiles.map(({ path: filePath }) => filePath),
  );
  const buildOutputSha256 = digest(
    Buffer.from(
      JSON.stringify(
        packagedFiles.map(({ path: filePath, body }) => ({
          path: filePath,
          sha256: digest(body).slice("sha256:".length),
          size: body.byteLength,
        })),
      ),
    ),
  ).slice("sha256:".length);
  const lifecycleEvidence = Object.freeze({
    configurationDigest,
    frozenInstall: Object.freeze({
      packageManager: packageManager.manager,
      packageManagerVersion: packageManager.version,
      lockfile: packageManager.lockfile,
      lockfileSha256: digest(
        fs.readFileSync(path.join(applicationRoot, packageManager.lockfile)),
      ).slice("sha256:".length),
      installCommandSha256: digest(Buffer.from(packageManager.installCommand)).slice(
        "sha256:".length,
      ),
      dependencyInventorySha256,
    }),
    frameworkBuild: Object.freeze({
      framework: env.FRAMEWORK_ADAPTER === "vite-static" ? "vite" : env.FRAMEWORK_ADAPTER,
      runtime: env.FRAMEWORK_RUNTIME,
      buildCommandSha256: digest(Buffer.from(packageManager.buildCommand)).slice("sha256:".length),
      frameworkPlanSha256: env.BUILD_PLAN_SHA256,
      buildOutputSha256,
    }),
    buildSandbox: Object.freeze({
      buildId: env.BUILD_ID,
      projectName: buildProjectName,
      buildInputFingerprint: String(env.BUILD_INPUT_FINGERPRINT).replace(/^sha256:/u, ""),
      sourceArchiveSha256: env.EXPECTED_SOURCE_SHA256,
      terminalStatus: "SUCCEEDED",
    }),
    credentialScan,
  });
  const digestPreimage =
    runtime === null
      ? {
          applicationRoot: applicationRootEvidence,
          frameworkPlanSchemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
          runtimePolicy,
          database,
          auth,
          storage,
          ...(verifiedFunctions === null ? {} : { functions: verifiedFunctions }),
          ...(migrations === null ? {} : { migrations }),
          assets,
        }
      : {
          applicationRoot: applicationRootEvidence,
          frameworkPlanSchemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
          runtimePolicy,
          database,
          auth,
          storage,
          ...(verifiedFunctions === null ? {} : { functions: verifiedFunctions }),
          ...(migrations === null ? {} : { migrations }),
          runtime,
          assets,
          modules,
        };
  const manifest = {
    schemaVersion: "ohmyhost.artifact/v3",
    projectId: env.PROJECT_ID,
    environmentId: env.ENVIRONMENT_ID,
    deploymentId: env.DEPLOYMENT_ID,
    operationId: env.OPERATION_ID,
    buildId: env.BUILD_ID,
    sourceCommit: env.SOURCE_COMMIT_SHA,
    sourceDigest: `sha256:${env.EXPECTED_SOURCE_SHA256}`,
    buildPlanDigest: `sha256:${env.BUILD_PLAN_SHA256}`,
    applicationRoot: applicationRootEvidence,
    frameworkPlanSchemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
    runtimePolicy,
    database,
    auth,
    storage,
    lifecycleEvidence,
    ...(verifiedFunctions === null ? {} : { functions: verifiedFunctions }),
    ...(migrations === null ? {} : { migrations }),
    artifactDigest: digest(Buffer.from(JSON.stringify(digestPreimage))),
    sbom: { path: "sbom.cdx.json", digest: digest(sbom) },
    assets,
    ...(runtime === null ? {} : { runtime, modules }),
  };
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify(manifest));
  return Object.freeze(manifest);
}

function readRepositoryConfigurationDigest(applicationRoot, applicationRootValue) {
  const selectedRoot = validateApplicationRoot(applicationRootValue);
  const repositoryRoot =
    selectedRoot === "."
      ? applicationRoot
      : selectedRoot.split("/").reduce((current) => path.dirname(current), applicationRoot);
  const configurationPath = path.join(repositoryRoot, "ohmyhost.yaml");
  assertRegularContainedFile(configurationPath, "repository configuration");
  const status = fs.statSync(configurationPath);
  if (status.size < 1 || status.size > 64 * 1024) {
    throw new Error("repository configuration is invalid");
  }
  return digest(fs.readFileSync(configurationPath)).slice("sha256:".length);
}

function buildProjectNameFromBuildId(value) {
  if (typeof value !== "string") throw new Error("build identity is invalid");
  const separator = value.indexOf(":");
  const projectName = value.slice(0, separator);
  const opaqueBuildId = value.slice(separator + 1);
  if (
    separator < 1 ||
    separator !== value.lastIndexOf(":") ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{1,149}$/u.test(projectName) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(opaqueBuildId)
  ) {
    throw new Error("build identity is invalid");
  }
  return projectName;
}

function readBuildPackageManagerEvidence(applicationRoot, environment) {
  const packageJsonPath = path.join(applicationRoot, "package.json");
  assertRegularContainedFile(packageJsonPath, "application package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const match = PACKAGE_MANAGER_DECLARATION.exec(packageJson.packageManager);
  const contract = match === null ? undefined : PACKAGE_MANAGER_CONTRACTS[match[1]];
  const lockfiles = ALL_LOCKFILES.filter((lockfile) =>
    fs.existsSync(path.join(applicationRoot, lockfile)),
  );
  if (
    match === null ||
    contract === undefined ||
    lockfiles.length !== 1 ||
    !contract.lockfiles.includes(lockfiles[0]) ||
    environment.INSTALL_COMMAND !== contract.installCommand ||
    environment.BUILD_COMMAND !==
      (environment.FRAMEWORK_RUNTIME === "functions" ? "" : contract.buildCommand) ||
    !/^[0-9a-f]{64}$/u.test(String(environment.BUILD_PLAN_SHA256)) ||
    !/^[0-9a-f]{64}$/u.test(String(environment.EXPECTED_SOURCE_SHA256)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(environment.BUILD_INPUT_FINGERPRINT))
  ) {
    throw new Error("build lifecycle package manager evidence is invalid");
  }
  assertRegularContainedFile(path.join(applicationRoot, lockfiles[0]), "application lockfile");
  return Object.freeze({
    manager: match[1],
    version: match[2],
    lockfile: lockfiles[0],
    installCommand: contract.installCommand,
    buildCommand: environment.BUILD_COMMAND,
  });
}

function scanCredentialFreeBuildOutput(paths) {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((filePath) => {
      if (typeof filePath !== "string" || /[\0\r\n]/u.test(filePath)) return true;
      if (filePath === "sbom.cdx.json") return false;
      const segments = filePath.split("/");
      return (
        !["assets", "migrations", "worker"].includes(segments[0]) ||
        segments.length < 2 ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
      );
    })
  ) {
    throw new Error("build output custody evidence is invalid");
  }
  return Object.freeze({
    scannerSha256: digest(Buffer.from(CREDENTIAL_SCAN_SCHEMA)).slice("sha256:".length),
    rulesSha256: digest(Buffer.from(JSON.stringify(CREDENTIAL_SCAN_RULES))).slice("sha256:".length),
    findingsCount: 0,
  });
}

// Worker modules may import compiled chunks relatively; mask only lexically valid ESM specifiers.
function maskRelativeEsmModuleSpecifiers(source, marker) {
  let imports;
  try {
    [imports] = parseModuleSpecifiers(source);
  } catch {
    return source;
  }
  const relativeSpecifier = new RegExp(`^\\.\\.?/(?:[A-Za-z0-9._~-]+/)*${marker}/`, "u");
  const ranges = [];
  for (const token of imports) {
    if (
      token.n === undefined ||
      !relativeSpecifier.test(token.n) ||
      token.s < 0 ||
      token.e < token.s ||
      token.e > source.length
    ) {
      continue;
    }
    ranges.push([token.s, token.e]);
  }
  let masked = "";
  let offset = 0;
  for (const [start, end] of ranges) {
    masked += source.slice(offset, start);
    masked += source.slice(start, end).replace(/[^\r\n]/gu, " ");
    offset = end;
  }
  return ranges.length === 0 ? source : masked + source.slice(offset);
}

const GENERATED_ASSET_SEGMENT = '(?!(?:\\.|\\.\\.)(?:/|"|$))[A-Za-z0-9._~-]+';
const GENERATED_ASSET_PATH = `assets/${GENERATED_ASSET_SEGMENT}(?:/${GENERATED_ASSET_SEGMENT})*`;
const VITE_MAP_DEPS_DEFINITION = /\b(?:const|let|var)\s+__vite__mapDeps\s*=/gu;
const VITE_MAP_DEPS_TABLE = new RegExp(
  `^const __vite__mapDeps=\\(i,m=__vite__mapDeps,d=\\(m\\.f\\|\\|\\(m\\.f=\\[(?<entries>"${GENERATED_ASSET_PATH}"(?:,"${GENERATED_ASSET_PATH}")*)\\]\\)\\)\\)=>i\\.map\\(i=>d\\[i\\]\\);`,
  "gu",
);
const GENERATED_SOURCE_REGION_LINE = new RegExp(`^//#region src/${GENERATED_ASSET_PATH}\\r?$`, "u");
const RETURNED_HTML_IMAGE =
  /<img\s+src="(https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/(?:[A-Za-z0-9._~-]+\/)*assets\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\.(?:png|jpe?g|gif|webp|svg))"(?=[\s/>])/giu;

function maskGeneratedViteMapDeps(source) {
  const definitions = [...source.matchAll(VITE_MAP_DEPS_DEFINITION)];
  if (definitions.length === 0) return source;
  const tables = [...source.matchAll(VITE_MAP_DEPS_TABLE)];
  if (definitions.length !== 1 || tables.length !== 1) return null;
  const [table] = tables;
  const masked = table[0].replace(new RegExp(GENERATED_ASSET_PATH, "gu"), (assetPath) =>
    " ".repeat(assetPath.length),
  );
  return source.slice(0, table.index) + masked + source.slice(table.index + table[0].length);
}

function maskTanStackWorkerMetadata(source) {
  const comments = [];
  let program;
  try {
    program = parseJavaScript(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: comments,
    });
  } catch {
    return null;
  }
  const ranges = [];
  for (const comment of comments) {
    if (comment.type !== "Line") continue;
    const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;
    if (
      comment.start === lineStart &&
      GENERATED_SOURCE_REGION_LINE.test(source.slice(comment.start, comment.end))
    ) {
      ranges.push([comment.start, comment.end]);
    }
  }
  // A complete HTML template directly returned by a function can contain an external content
  // image, including in an email or an HTTP page. It is not Vite's client asset base. Mask only
  // literal HTTPS image src values in that template; scripts, styles, other URLs, incomplete
  // templates and generated asset constants remain subject to the same asset-prefix check.
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    if (
      node.type === "ReturnStatement" &&
      node.argument?.type === "TemplateLiteral" &&
      node.argument.quasis[0]?.value.raw.startsWith("<!doctype html><html") &&
      node.argument.quasis.at(-1)?.value.raw.endsWith("</html>")
    ) {
      for (const quasi of node.argument.quasis) {
        for (const match of quasi.value.raw.matchAll(RETURNED_HTML_IMAGE)) {
          const url = match[1];
          const start = quasi.start + match.index + match[0].indexOf(url);
          ranges.push([start, start + url.length]);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") pending.push(value);
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);
  let masked = "";
  let offset = 0;
  for (const [start, end] of ranges) {
    masked += source.slice(offset, start);
    masked += source.slice(start, end).replace(/[^\r\n]/gu, " ");
    offset = end;
  }
  return ranges.length === 0 ? source : masked + source.slice(offset);
}

function assertRootOriginFrameworkAsset(adapter, relativePath, body, outputKind = "public-asset") {
  const marker = adapter === "nextjs" ? "_next" : adapter === "astro" ? "_astro" : "assets";
  const segments = relativePath.split("/");
  const markerIndex = segments.indexOf(marker);
  const text = body.toString("utf8");
  let contentToScan =
    adapter === "astro" && outputKind === "worker-module"
      ? maskAstroManifestAssetEntries(text)
      : text;
  const isJavaScript = outputKind === "worker-module" || /\.(?:m?js)$/u.test(relativePath);
  if (isJavaScript) {
    const maskedMapDeps = maskGeneratedViteMapDeps(contentToScan);
    if (maskedMapDeps === null || (marker !== "assets" && maskedMapDeps !== contentToScan))
      throw new Error("compiled output contains a non-root framework asset prefix");
    if (marker === "assets") contentToScan = maskedMapDeps;
    if (outputKind === "worker-module" && marker === "assets") {
      const maskedComments = maskTanStackWorkerMetadata(contentToScan);
      if (maskedComments === null)
        throw new Error("compiled output contains a non-root framework asset prefix");
      contentToScan = maskedComments;
      contentToScan = maskRelativeEsmModuleSpecifiers(contentToScan, marker);
    } else if (outputKind === "worker-module") {
      contentToScan = maskRelativeEsmModuleSpecifiers(contentToScan, marker);
    }
  } else if (outputKind === "worker-module") {
    contentToScan = maskRelativeEsmModuleSpecifiers(contentToScan, marker);
  }
  const nonRootReference = new RegExp(
    `(?:https?:)?//[^\\s"'<>]+/${marker}/|/(?:[A-Za-z0-9._~-]+/)+${marker}/|(?:^|[\\s"'(=:\\x60])(?:\\.\\.?/|[A-Za-z0-9._~-]+/)*${marker}/`,
    "u",
  );
  if (markerIndex > 0 || nonRootReference.test(contentToScan)) {
    throw new Error("compiled output contains a non-root framework asset prefix");
  }
}

function writeOctal(header, offset, length, value) {
  const encoded = Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
  encoded.copy(header, offset);
}

/** The USTAR prefix and name of an archive path, or null when the path cannot be represented. */
function ustarPathFields(relativePath) {
  const bytes = Buffer.byteLength(relativePath, "utf8");
  if (bytes > 255) return null;
  if (bytes <= 100) return { prefix: "", name: relativePath };
  const split = [...relativePath.matchAll(/\//gu)]
    .map((match) => match.index)
    .reverse()
    .find(
      (index) =>
        Buffer.byteLength(relativePath.slice(0, index), "utf8") <= 155 &&
        Buffer.byteLength(relativePath.slice(index + 1), "utf8") <= 100,
    );
  return split === undefined
    ? null
    : { prefix: relativePath.slice(0, split), name: relativePath.slice(split + 1) };
}

function ustarHeader(relativePath, size) {
  const fields = ustarPathFields(relativePath);
  if (fields === null) throw new Error("artifact archive path cannot fit USTAR fields");
  const { prefix, name } = fields;
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

export function createBuildArtifactArchive({ bundleRoot: bundleRootInput, outputPath }) {
  const bundleRoot = fs.realpathSync(bundleRootInput);
  const files = walk(bundleRoot)
    .map((file) => ({ file, relative: safeRelative(bundleRoot, file) }))
    .filter(
      ({ relative }) =>
        relative === "manifest.json" ||
        relative === "sbom.cdx.json" ||
        relative.startsWith("assets/") ||
        relative.startsWith("migrations/") ||
        relative.startsWith("worker/"),
    )
    .sort((left, right) => compareCodePoints(left.relative, right.relative));
  if (
    !files.some(({ relative }) => relative === "manifest.json") ||
    !files.some(({ relative }) => relative === "sbom.cdx.json")
  ) {
    throw new Error("artifact archive evidence is incomplete");
  }
  const chunks = [];
  for (const { file, relative } of files) {
    const body = fs.readFileSync(file);
    chunks.push(ustarHeader(relative, body.length), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const expandedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (expandedBytes > 67_108_864) {
    throw new PackagingLimitError(
      `the expanded deployment artifact is ${String(expandedBytes)} bytes; it may be at most 67108864 bytes (USTAR headers, padding and all artifact files together)`,
    );
  }
  const compressed = zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  if (compressed.length > 31_457_280) {
    throw new PackagingLimitError(
      `the compressed deployment artifact is ${String(compressed.length)} bytes; it may be at most 31457280 bytes (static files, Worker modules and migrations together)`,
    );
  }
  fs.writeFileSync(outputPath, compressed, { flag: "wx", mode: 0o600 });
  return Object.freeze({ outputPath, byteLength: compressed.length, sha256: digest(compressed) });
}

export async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "validate-root") {
    process.stdout.write(validateApplicationRoot(arguments_[0]));
    return;
  }
  if (command === "validate-archive") {
    validateSourceArchive(arguments_[0]);
    return;
  }
  if (command === "resolve-root") {
    process.stdout.write(resolveApplicationRoot(arguments_[0], arguments_[1]));
    return;
  }
  if (command === "validate-next-config") {
    validateNextWorkerConfig({
      applicationRoot: process.cwd(),
      configPath: arguments_[0],
      environment: process.env,
    });
    return;
  }
  if (command === "validate-next-metafile") {
    validateNextWorkerMetafile({
      applicationRoot: process.cwd(),
      metafilePath: arguments_[0],
    });
    return;
  }
  if (command === "vite-companion-config") {
    createViteCompanionConfig({
      applicationRoot: process.cwd(),
      outputPath: arguments_[0],
      environment: process.env,
    });
    return;
  }
  if (command === "next-platform-config") {
    createNextPlatformConfig({
      applicationRoot: process.cwd(),
      outputPath: arguments_[0],
      environment: process.env,
    });
    return;
  }
  if (command === "next-cache-validate") {
    validateNextCacheSupport({ applicationRoot: process.cwd() });
    return;
  }
  if (command === "next-cache-populate") {
    await populateNextStaticCache({ applicationRoot: process.cwd() });
    return;
  }
  if (command === "framework-build-argument") {
    process.stdout.write(
      readFrameworkBuildArguments({
        applicationRoot: process.cwd(),
        environment: process.env,
      }).join(""),
    );
    return;
  }
  if (command === "next-open-next-config") {
    createOpenNextPlatformConfig({
      applicationRoot: process.cwd(),
      outputPath: arguments_[0],
      environment: process.env,
    });
    return;
  }
  if (command === "cleanup-next-platform-config") {
    cleanupOpenNextPlatformConfig({ applicationRoot: arguments_[0] });
    return;
  }
  if (command === "cleanup-tanstack-platform-config") {
    cleanupTanStackPlatformConfig({ applicationRoot: arguments_[0] });
    return;
  }
  if (command === "write-package-manager") {
    writePackageManagerReceipt({
      applicationRoot: arguments_[0],
      installCommand: process.env.INSTALL_COMMAND,
      buildCommand: process.env.BUILD_COMMAND,
      outputPath: arguments_[1],
      environment: process.env,
    });
    return;
  }
  if (command === "read-package-manager") {
    const receipt = readPackageManagerReceipt(arguments_[0]);
    process.stdout.write(`${receipt.manager} ${receipt.version}\n`);
    return;
  }
  if (command === "dependency-inventory") {
    createDependencyInventory({ applicationRoot: process.cwd(), outputPath: arguments_[0] });
    return;
  }
  if (command === "finalize-vite-companion") {
    finalizeViteCompanionOutput({
      applicationRoot: process.cwd(),
      environment: process.env,
    });
    return;
  }
  if (command === "functions-config") {
    createFunctionsWorkerConfig({
      applicationRoot: process.cwd(),
      outputPath: arguments_[0],
      environment: process.env,
    });
    return;
  }
  if (command === "finalize-functions") {
    finalizeFunctionsWorkerOutput({
      applicationRoot: process.cwd(),
      environment: process.env,
    });
    return;
  }
  if (command === "snapshot-migrations") {
    snapshotDatabaseMigrations({
      applicationRoot: process.cwd(),
      databaseRequirementJson: process.env.DATABASE_REQUIREMENT_JSON,
      snapshotRoot: arguments_[0],
    });
    return;
  }
  if (command === "write-user-build-script") {
    writeUserBuildScript(arguments_[0]);
    return;
  }
  if (command === "write-root-package-script") {
    writeRootPackageScript(arguments_[0]);
    return;
  }
  if (command === "package") {
    packageBuildArtifact({
      applicationRoot: process.cwd(),
      bundleRoot: "/tmp/ohmyho/bundle",
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: "/tmp/ohmyho/package-manager.json",
      compressedWorkerPath: arguments_[0],
      ...(process.env.OHMYHOST_MIGRATION_SNAPSHOT_ROOT === undefined
        ? {}
        : { migrationSnapshotRoot: process.env.OHMYHOST_MIGRATION_SNAPSHOT_ROOT }),
      environment: process.env,
    });
    return;
  }
  if (command === "archive") {
    createBuildArtifactArchive({ bundleRoot: arguments_[0], outputPath: arguments_[1] });
    return;
  }
  throw new Error("build runtime command is invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const line =
      error instanceof FrameworkVersionRefusal ? error.message : packagingFailureLine(error);
    if (line === null) throw error;
    // The logs receive exactly this line, without a stack; stdout may carry a command's result.
    process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  }
}

/** Platform config consumed by the official Astro Cloudflare Vite integration. */
export function createAstroPlatformConfig({ applicationRoot: root, environment: env }) {
  const applicationRoot = fs.realpathSync(root);
  if (!validAstroEdgeEnvironment(env)) throw new Error("Astro framework plan is invalid");
  const output = path.join(applicationRoot, ".ohmyhost-astro-wrangler.jsonc");
  assertContainedPathAbsent(output, "Astro platform config input is invalid");
  const config = {
    name: "ohmyhost-platform-astro-build",
    main: "@astrojs/cloudflare/entrypoints/server",
    compatibility_date: env.COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
  };
  fs.writeFileSync(output, JSON.stringify(config), { flag: "wx", mode: 0o400 });
  return config;
}

function validAstroEdgeEnvironment(env) {
  return (
    env?.FRAMEWORK_ADAPTER === "astro" &&
    env.FRAMEWORK_RUNTIME === "edge" &&
    env.BUILD_OUTPUT_DIRECTORY === "dist/client" &&
    env.SERVER_OUTPUT_DIRECTORY === "dist/server" &&
    env.SERVER_ENTRYPOINT === "dist/server/entry.mjs" &&
    env.SERVER_CONFIG_PATH === "dist/server/wrangler.json" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(env.COMPATIBILITY_DATE ?? "") &&
    env.COMPATIBILITY_DATE >= "2026-10-12" &&
    env.COMPATIBILITY_FLAGS === "nodejs_compat"
  );
}

/** Validate the adapter artifact, refusing sessions, images and all foreign provider bindings. */
export function validateAstroBuildOutput({ applicationRoot: root, environment: env }) {
  const applicationRoot = fs.realpathSync(root);
  if (!validAstroEdgeEnvironment(env)) throw new Error("Astro framework plan is invalid");
  const serverRoot = resolveContained(applicationRoot, env.SERVER_OUTPUT_DIRECTORY);
  const assetRoot = resolveContained(applicationRoot, env.BUILD_OUTPUT_DIRECTORY);
  const entrypoint = resolveContained(applicationRoot, env.SERVER_ENTRYPOINT);
  const generated = readTanStackJson(
    resolveContained(applicationRoot, env.SERVER_CONFIG_PATH),
    "Astro Worker config",
  );
  const metadata = new Set([
    "configPath",
    "userConfigPath",
    "definedEnvironments",
    "topLevelName",
    "name",
    "dev",
    "compatibility_date",
    "compatibility_flags",
    "main",
    "jsx_factory",
    "jsx_fragment",
    "rules",
    "build",
    "no_bundle",
    "upload_source_maps",
    "assets",
    "observability",
    "define",
    "previews",
  ]);
  if (
    generated.main !== "entry.mjs" ||
    generated.no_bundle !== true ||
    generated.compatibility_date !== env.COMPATIBILITY_DATE ||
    JSON.stringify(generated.compatibility_flags) !== '["nodejs_compat"]' ||
    !hasExactKeys(generated.assets, ["binding", "directory"]) ||
    generated.assets.binding !== "ASSETS" ||
    generated.assets.directory !== "../client" ||
    !hasTanStackGeneratedDevDefaults(generated.dev) ||
    JSON.stringify(generated.rules) !== '[{"type":"ESModule","globs":["**/*.js","**/*.mjs"]}]' ||
    (generated.define !== undefined && JSON.stringify(generated.define) !== "{}") ||
    JSON.stringify(generated.previews) !== "{}"
  )
    throw new Error("Astro Worker output is invalid");
  if (
    generated.configPath !== path.join(applicationRoot, ".ohmyhost-astro-wrangler.jsonc") ||
    generated.userConfigPath !== generated.configPath ||
    JSON.stringify(generated.definedEnvironments) !== "[]"
  )
    throw new Error("Astro Worker config provenance is invalid");
  for (const [field, value] of Object.entries(generated)) {
    if (metadata.has(field)) continue;
    if (
      !(field === "k2" && Array.isArray(value) && value.length === 0) &&
      !(
        TANSTACK_EMPTY_GENERATED_CAPABILITY_FIELDS.includes(field) &&
        isEmptyTanStackCapability(field, value)
      )
    )
      throw new Error(
        `Astro Worker capability ${field} is not supported; disable sessions, provider images and additional Cloudflare resources`,
      );
  }
  const files = walk(serverRoot);
  if (
    !files.includes(entrypoint) ||
    files.some(
      (file) =>
        !/\.(?:m?js|wasm|m?js\.map)$/u.test(file) &&
        file !== path.join(serverRoot, "wrangler.json"),
    )
  )
    throw new Error("Astro Worker output is invalid");
  return { serverRoot, assetRoot, entrypoint };
}

/** Astro records relative client filenames as manifest data beside rooted public asset URLs. */
function maskAstroManifestAssetEntries(source) {
  let ast;
  try {
    ast = parseJavaScript(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    throw new Error("Astro compiled module is invalid");
  }
  const pending = [ast];
  const ranges = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "deserializeManifest" &&
      node.arguments.length === 1 &&
      node.arguments[0].type === "ObjectExpression"
    ) {
      const argument = node.arguments[0];
      let manifest;
      try {
        manifest = JSON.parse(source.slice(argument.start, argument.end));
      } catch {
        throw new Error("Astro compiled manifest is invalid");
      }
      if (
        manifest.adapterName !== "@astrojs/cloudflare" ||
        manifest.base !== "/" ||
        manifest.assetsDir !== "_astro" ||
        !Array.isArray(manifest.assets)
      )
        throw new Error("Astro compiled manifest has unsupported asset configuration");
      const entryModules = argument.properties.find(
        (property) => property.key?.value === "entryModules",
      )?.value;
      if (entryModules?.type !== "ObjectExpression")
        throw new Error("Astro compiled manifest is invalid");
      for (const property of entryModules.properties) {
        const value = property.value;
        if (
          value?.type !== "Literal" ||
          typeof value.value !== "string" ||
          !value.value.startsWith("_astro/")
        )
          continue;
        if (
          !/^_astro\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(value.value) ||
          !manifest.assets.includes(`/${value.value}`)
        )
          throw new Error("Astro client manifest asset is invalid");
        ranges.push([value.start, value.end]);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  let masked = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0]))
    masked = masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
  return masked;
}
