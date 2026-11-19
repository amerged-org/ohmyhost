import { createAstroFrameworkAdapter } from "@ohmyhost/adapter-astro";
import {
  createNextFrameworkAdapter,
  NextWorkersIncompatibleError,
  NextRuntimeSourceSyntaxError,
} from "@ohmyhost/adapter-next";
import { createFunctionsFrameworkAdapter } from "@ohmyhost/adapter-functions";
import { createTanStackFrameworkAdapter } from "@ohmyhost/adapter-tanstack";
import { createViteFrameworkAdapter } from "@ohmyhost/adapter-vite";
import {
  FrameworkAdmissionError,
  FrameworkConversionDiagnosticError,
  parseFrameworkConversionDiagnostic,
  type FrameworkConversionDiagnostic,
  parseOhmyhostConfigYaml,
  resolveFrameworkConfig,
  resolvePackageManager,
  rootFrameworkConversionDiagnostic,
  type ApplicationRoot,
  type OhmyhostConfig,
  type PackageManagerDescriptor,
} from "@ohmyhost/contracts";
import { classifyFrameworkFamily } from "@ohmyhost/contracts/framework-family";
import {
  databaseContractCodes,
  declaredDependencyNames,
  frameworkSourceFindings,
  isDatabaseContractModule,
  packageManagerDeclaration,
  parsePackageManifest,
  workerModuleFindings,
  type PackageManifest,
} from "@ohmyhost/contracts/framework-source-rules";
import {
  inspectReachableRuntimeSources,
  RuntimeSourceInspectionLimitError,
} from "./runtime-source-inspection.js";
import {
  serializeNewProductionFrameworkPlanPreimage,
  type FrameworkAdapter,
  type FrameworkLockfileLoader,
  type FrameworkPlan,
} from "@ohmyhost/platform";

const BLOCK_BYTES = 512;
const MAXIMUM_ENTRIES = 20_000;
const MAXIMUM_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_RUNTIME_SOURCE_FILES = 2_000;
const MAXIMUM_RUNTIME_SOURCE_BYTES = 256 * 1024;
const MAXIMUM_RUNTIME_SOURCE_TOTAL_BYTES = 8 * 1024 * 1024;
/** Bodies retained for the inspection, companion, worker, lockfile and tsconfig files. */
const RETAINED_ALWAYS_BYTES = 16 * 1024 * 1024;
/**
 * Source and JSON bodies of at most MAXIMUM_RUNTIME_SOURCE_BYTES retained for the traversal, shared
 * by every such file: the traversal's own file and byte limits apply only to the files it reaches.
 */
const RETAINED_SOURCE_BYTES = 32 * 1024 * 1024;
const LOCKFILE_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml"]);
const TSCONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
const SOURCE_PATH = /(?:\.[cm]?[jt]sx?|\.astro)$/u;
const VITE_COMPANION_SOURCE_PATH = "src/ohmyhost/companion.ts";
const WORKER_SOURCE_PATH = "src/ohmyhost/worker.ts";
const NEXT_RUNTIME_SOURCE_PATH =
  /(?:^|\/)(?:(?:(?:src\/)?(?:app|pages)\/)[\s\S]*|(?:src\/)?(?:middleware|proxy))\.(?:[cm]?[jt]sx?)$/u;
const GITHUB_PAX_COMMENT_BYTES = 52;
const INSPECTION_FILES = new Set([
  "ohmyhost.yaml",
  "package.json",
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "open-next.config.js",
  "open-next.config.mjs",
  "open-next.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "wrangler.jsonc",
]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const PACKAGE_MANIFEST = "package.json";
const REPOSITORY_CONFIGURATION_INVALID = Object.freeze({
  code: "repository_configuration_invalid",
  path: "ohmyhost.yaml",
} as const);

export class ViteArchiveInspectionError extends Error {
  public constructor() {
    super("Vite archive inspection failed");
    this.name = "ViteArchiveInspectionError";
  }
}

export class RepositoryConfigurationMissingError extends Error {
  public readonly code = "repository_configuration_missing";
  public constructor() {
    super("The Git repository root must contain ohmyhost.yaml");
    this.name = "RepositoryConfigurationMissingError";
  }
}

export class MigrationFilenameNoncanonicalError extends Error {
  public readonly code = "migration_filename_noncanonical" as const;
  public readonly paths: readonly string[];

  public constructor(paths: readonly string[]) {
    super("PostgreSQL migration filenames are noncanonical");
    this.name = "MigrationFilenameNoncanonicalError";
    if (
      paths.length === 0 ||
      paths.some((path) => typeof path !== "string" || path.length === 0 || path.length > 1_024)
    ) {
      throw new TypeError("Migration filename evidence is invalid");
    }
    this.paths = Object.freeze([...paths].sort());
  }
}

type SourceFrameworkAdapter = "astro" | "functions" | "nextjs" | "tanstack-start" | "vite-static";
type FrameworkConversionRequirement =
  | "astro-adapter"
  | "functions-adapter"
  | "nextjs-adapter"
  | "tanstack-adapter"
  | "vite-adapter";

/**
 * The source does not meet the repository contract `ohmyhost init` checks; the diagnostic names the
 * file from the repository root. The adapter is null when the source is refused before a framework
 * is selected (ohmyhost.yaml, the application root, package.json or its framework family). Such a
 * refusal always carries its diagnostic, because no adapter requirement names the fix.
 */
export class FrameworkConversionRequiredError extends Error {
  public readonly code = "framework_conversion_required" as const;
  public readonly requirement: FrameworkConversionRequirement | null;

  public readonly diagnostic: FrameworkConversionDiagnostic | null;

  public constructor(
    public readonly adapter: SourceFrameworkAdapter | null,
    diagnostic?: unknown,
  ) {
    super("Source framework conversion is incomplete");
    this.name = "FrameworkConversionRequiredError";
    this.requirement = adapter === null ? null : frameworkRequirement(adapter);
    this.diagnostic = parseFrameworkConversionDiagnostic(diagnostic);
    if (adapter === null && this.diagnostic === null)
      throw new TypeError("A refusal before framework selection requires its diagnostic");
  }
}

/** The refusal of a rule over the application, naming its file from the repository root. */
function applicationRefusal(
  adapter: SourceFrameworkAdapter | null,
  diagnostic: unknown,
  root: ApplicationRoot,
): FrameworkConversionRequiredError {
  return new FrameworkConversionRequiredError(
    adapter,
    rootFrameworkConversionDiagnostic(diagnostic, root),
  );
}

function frameworkRequirement(adapter: SourceFrameworkAdapter): FrameworkConversionRequirement {
  if (adapter === "astro") return "astro-adapter";
  if (adapter === "nextjs") return "nextjs-adapter";
  if (adapter === "tanstack-start") return "tanstack-adapter";
  if (adapter === "functions") return "functions-adapter";
  return "vite-adapter";
}

function fail(): never {
  throw new ViteArchiveInspectionError();
}

function ascii(bytes: Uint8Array): string {
  if (bytes.some((byte) => byte > 0x7f)) fail();
  const zero = bytes.indexOf(0);
  return String.fromCharCode(...bytes.subarray(0, zero === -1 ? bytes.length : zero));
}

function pathField(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  if (zero !== -1 && bytes.subarray(zero).some((byte) => byte !== 0)) fail();
  return ascii(bytes);
}

function octal(bytes: Uint8Array): number {
  const value = ascii(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) fail();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail();
  return parsed;
}

function safePath(value: string): readonly string[] {
  if (value === "" || value.startsWith("/") || value.includes("\\") || /\p{Cc}/u.test(value))
    fail();
  const parts = value.replace(/\/$/u, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail();
  }
  return parts;
}

function validateGithubPaxComment(content: Uint8Array): void {
  if (content.byteLength !== GITHUB_PAX_COMMENT_BYTES) fail();
  let value: string;
  try {
    value = UTF8.decode(content);
  } catch {
    fail();
  }
  if (!/^52 comment=[0-9a-f]{40}\n$/u.test(value)) fail();
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? fail());
  }
  return sum;
}

/** UTF-8 text, or null for bytes that are not UTF-8; the rule that reads the file refuses them. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The inflated tar read forward once. It never holds the whole archive: a body is copied only
 * when a later rule can read it, and every other body is skipped.
 */
interface InflatedTar {
  /** Exactly `length` bytes, or null when the stream ends first. */
  read(length: number): Promise<Uint8Array | null>;
  /** Skips `length` bytes; false when the stream ends first. */
  skip(length: number): Promise<boolean>;
  /** Whether the rest of the stream is zero bytes. */
  restIsZero(): Promise<boolean>;
}

async function inflate(archive: Uint8Array): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  try {
    const owned = new Uint8Array(new ArrayBuffer(archive.byteLength));
    owned.set(archive);
    const body = new Response(owned.buffer).body;
    if (body === null) fail();
    return body.pipeThrough(new DecompressionStream("gzip")).getReader();
  } catch {
    fail();
  }
}

function inflatedTar(reader: ReadableStreamDefaultReader<Uint8Array>): InflatedTar {
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let done = false;
  let total = 0;
  async function next(): Promise<boolean> {
    while (offset >= chunk.byteLength) {
      if (done) return false;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        fail();
      }
      if (result.done) {
        done = true;
        return false;
      }
      total += result.value.byteLength;
      if (total > MAXIMUM_UNCOMPRESSED_BYTES) fail();
      chunk = result.value;
      offset = 0;
    }
    return true;
  }
  return {
    async read(length) {
      const output = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        if (!(await next())) return null;
        const count = Math.min(length - filled, chunk.byteLength - offset);
        output.set(chunk.subarray(offset, offset + count), filled);
        offset += count;
        filled += count;
      }
      return output;
    },
    async skip(length) {
      let remaining = length;
      while (remaining > 0) {
        if (!(await next())) return false;
        const count = Math.min(remaining, chunk.byteLength - offset);
        offset += count;
        remaining -= count;
      }
      return true;
    },
    async restIsZero() {
      while (await next()) {
        if (chunk.subarray(offset).some((byte) => byte !== 0)) return false;
        offset = chunk.byteLength;
      }
      return true;
    },
  };
}

/** A regular file body of `size` bytes, followed by its block padding. */
async function fileBody(tar: InflatedTar, size: number): Promise<Uint8Array> {
  const padded = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
  const content = await tar.read(size);
  if (content === null || !(await tar.skip(padded - size))) fail();
  return content;
}

async function readTar(
  archive: Uint8Array,
  retainAll = false,
): Promise<
  Readonly<{
    files: readonly string[];
    directories: ReadonlySet<string>;
    /** The decoded inspection files; null where the bytes are not UTF-8. */
    inspection: ReadonlyMap<string, string | null>;
    /** Null for every file whose body no rule reads. */
    bodies: ReadonlyMap<string, Uint8Array | null>;
    executables: ReadonlySet<string>;
    /** Whether a Next.js runtime-source file exceeds the Next.js limits. */
    runtimeSourceOverflow: boolean;
    configuration: string | null;
  }>
> {
  const tar = inflatedTar(await inflate(archive));
  const paths = new Set<string>();
  const files: string[] = [];
  const directories = new Set<string>();
  const inspection = new Map<string, string | null>();
  const bodies = new Map<string, Uint8Array | null>();
  const executables = new Set<string>();
  let root: string | undefined;
  let entries = 0;
  let ended = false;
  let githubPaxCommentSeen = false;
  let runtimeSourceFiles = 0;
  let runtimeSourceBytes = 0;
  // The Next.js limits are decided once the adapter is known; until then they only mark the archive.
  let runtimeSourceOverflow = false;
  let sourceBytes = 0;
  let alwaysBytes = 0;
  for (;;) {
    const header = await tar.read(BLOCK_BYTES);
    if (header === null) break;
    if (header.every((byte) => byte === 0)) {
      const second = await tar.read(BLOCK_BYTES);
      if (second === null || !second.every((byte) => byte === 0)) fail();
      if (!(await tar.restIsZero())) fail();
      ended = true;
      break;
    }
    entries += 1;
    if (entries > MAXIMUM_ENTRIES) fail();
    if (ascii(header.subarray(257, 263)) !== "ustar" || ascii(header.subarray(263, 265)) !== "00") {
      fail();
    }
    const storedChecksum = octal(header.subarray(148, 156));
    if (storedChecksum !== checksum(header)) fail();
    const name = pathField(header.subarray(0, 100));
    const prefix = pathField(header.subarray(345, 500));
    const fullPath = prefix === "" ? name : `${prefix}/${name}`;
    const type = header[156] ?? fail();
    const size = octal(header.subarray(124, 136));
    if (type === 103) {
      if (
        githubPaxCommentSeen ||
        entries !== 1 ||
        root !== undefined ||
        prefix !== "" ||
        name !== "pax_global_header" ||
        size !== GITHUB_PAX_COMMENT_BYTES
      )
        fail();
      validateGithubPaxComment(await fileBody(tar, size));
      githubPaxCommentSeen = true;
      continue;
    }
    if (type !== 0 && type !== 48 && type !== 53) fail();
    const parts = safePath(fullPath);
    root ??= parts[0];
    if (parts[0] !== root) fail();
    const normalizedPath = parts.join("/");
    if (paths.has(normalizedPath)) fail();
    paths.add(normalizedPath);
    if (parts.length === 1 && type !== 53) fail();
    if (type === 53 && size !== 0) fail();
    if (type !== 53 && size > MAXIMUM_FILE_BYTES) fail();
    const relative = parts.slice(1).join("/");
    if (retainAll && parts.slice(1).some((part) => part.toLowerCase() === ".git")) fail();
    if (type === 53) {
      if (relative !== "") directories.add(relative);
      continue;
    }
    files.push(relative);
    if (retainAll && (octal(header.subarray(100, 108)) & 0o111) !== 0) executables.add(relative);
    const leaf = parts.at(-1) ?? fail();
    const inspectRuntimeSource = NEXT_RUNTIME_SOURCE_PATH.test(relative);
    let withinRuntimeSourceLimits = false;
    if (inspectRuntimeSource) {
      runtimeSourceFiles += 1;
      runtimeSourceBytes += size;
      withinRuntimeSourceLimits =
        runtimeSourceFiles <= MAXIMUM_RUNTIME_SOURCE_FILES &&
        size <= MAXIMUM_RUNTIME_SOURCE_BYTES &&
        runtimeSourceBytes <= MAXIMUM_RUNTIME_SOURCE_TOTAL_BYTES;
      if (!withinRuntimeSourceLimits) runtimeSourceOverflow = true;
    }
    const always =
      INSPECTION_FILES.has(leaf) ||
      relative === VITE_COMPANION_SOURCE_PATH ||
      relative === WORKER_SOURCE_PATH ||
      LOCKFILE_NAMES.has(leaf) ||
      TSCONFIG_NAMES.has(leaf);
    let retain = retainAll;
    if (retainAll) {
      // The total inflated size and individual file size are already bounded above.
    } else if (always) {
      alwaysBytes += size;
      if (alwaysBytes > RETAINED_ALWAYS_BYTES) fail();
      retain = true;
    } else if (withinRuntimeSourceLimits) {
      retain = true;
    } else if (
      (SOURCE_PATH.test(relative) || relative.endsWith(".json")) &&
      size <= MAXIMUM_RUNTIME_SOURCE_BYTES &&
      sourceBytes + size <= RETAINED_SOURCE_BYTES
    ) {
      sourceBytes += size;
      retain = true;
    }
    if (!retain) {
      const padded = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
      if (!(await tar.skip(padded))) fail();
      bodies.set(relative, null);
      continue;
    }
    const content = await fileBody(tar, size);
    bodies.set(relative, content);
    if (
      INSPECTION_FILES.has(leaf) ||
      relative === VITE_COMPANION_SOURCE_PATH ||
      relative === WORKER_SOURCE_PATH ||
      inspectRuntimeSource
    ) {
      inspection.set(relative, utf8Text(content));
    }
  }
  if (!ended) fail();
  const configuration = inspection.get("ohmyhost.yaml");
  if (configuration === undefined && !retainAll) throw new RepositoryConfigurationMissingError();
  return Object.freeze({
    files: Object.freeze(files),
    directories,
    inspection,
    bodies,
    executables,
    runtimeSourceOverflow,
    configuration: configuration ?? null,
  });
}

/** Fully validated regular-file snapshot for preview synchronization; no links or traversal. */
export async function readPreviewArchive(
  archive: Uint8Array,
): Promise<ReadonlyMap<string, { readonly bytes: Uint8Array; readonly executable: boolean }>> {
  const parsed = await readTar(archive, true);
  const files = new Map<string, { readonly bytes: Uint8Array; readonly executable: boolean }>();
  for (const [path, body] of parsed.bodies) {
    if (body === null) fail();
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (parsed.bodies.has(parts.slice(0, i).join("/"))) fail();
    }
    if (parsed.directories.has(path)) fail();
    files.set(path, { bytes: body, executable: parsed.executables.has(path) });
  }
  return files;
}

async function sha256(value: string | Uint8Array, crypto: SubtleCrypto): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const digest = await crypto.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspectFrameworkArchive(
  archive: Uint8Array,
  crypto: SubtleCrypto = globalThis.crypto.subtle,
): Promise<
  Readonly<{
    frameworkPlan: FrameworkPlan;
    buildPlanSha256: string;
    companionSource?:
      | Readonly<{
          schemaVersion: "ohmyhost.vite-api-companion/v1";
          path: typeof VITE_COMPANION_SOURCE_PATH;
          byteLength: number;
          sha256: string;
        }>
      | Readonly<{
          schemaVersion: "ohmyhost.worker-module/v1";
          path: typeof WORKER_SOURCE_PATH;
          byteLength: number;
          sha256: string;
        }>;
  }>
> {
  try {
    const parsed = await readTar(archive);
    const repositoryConfig = parseRepositoryConfig(parsed.configuration);
    const application = applicationSnapshot(parsed, repositoryConfig.applicationRoot);
    if (repositoryConfig.database?.enabled === true)
      assertCanonicalMigrationFilenames(application.files, repositoryConfig.database.migrations);
    const applicationFiles = applicationInspection(parsed.inspection, application.root);
    const adapter = selectAdapter({
      configuration: repositoryConfig,
      application,
      files: applicationFiles,
      bodies: parsed.bodies,
    });
    const detection = await adapter.detect(application);
    if (detection.confidenceBasisPoints !== 10_000) fail();
    // The Next.js runtime-source limits bind only a Next.js application, once it is detected.
    if (parsed.runtimeSourceOverflow && detection.adapter === "nextjs")
      throw new FrameworkConversionRequiredError("nextjs");
    let frameworkPlan: FrameworkPlan;
    try {
      frameworkPlan = await adapter.plan({
        repositoryConfig,
        repositoryConfigEvidence: Object.freeze({
          scope: "repository",
          path: "ohmyhost.yaml",
          reason: "authoritative repository configuration",
        }),
        application,
        detection,
      });
    } catch (error) {
      throw planRefusal(error, sourceFrameworkAdapter(detection.adapter), application.root);
    }
    const planAdapter = sourceFrameworkAdapter(frameworkPlan.adapter);
    try {
      const reachable = inspectReachableRuntimeSources(frameworkPlan, parsed.bodies);
      for (const [path, source] of reachable.sources) applicationFiles.set(path, source);
      if (reachable.socketPath !== null)
        throw applicationRefusal(
          planAdapter,
          { code: "database_driver_unsupported", path: reachable.socketPath },
          application.root,
        );
      // A customer Worker opens no raw TCP socket: only fetch() passes the egress policy. The
      // parsed specifiers decide, whatever the configuration, before anything is built.
      if (reachable.socketPrimitivePath !== null)
        throw applicationRefusal(
          planAdapter,
          { code: "socket_primitive_unsupported", path: reachable.socketPrimitivePath },
          application.root,
        );
    } catch (error) {
      if (error instanceof FrameworkConversionDiagnosticError)
        throw applicationRefusal(planAdapter, error.diagnostic, application.root);
      if (error instanceof RuntimeSourceInspectionLimitError)
        throw new FrameworkConversionRequiredError(planAdapter);
      if (error instanceof NextRuntimeSourceSyntaxError)
        throw applicationRefusal(
          planAdapter,
          { code: "source_syntax_invalid", path: error.path },
          application.root,
        );
      throw error;
    }
    assertWorkerModuleHandlers(frameworkPlan, applicationFiles);
    assertDatabaseContract(repositoryConfig, applicationFiles, frameworkPlan);
    const companionSource = await workerSourceEvidence(frameworkPlan, applicationFiles, crypto);
    return Object.freeze({
      frameworkPlan,
      buildPlanSha256: await sha256(
        serializeNewProductionFrameworkPlanPreimage(frameworkPlan),
        crypto,
      ),
      ...(companionSource === null ? {} : { companionSource }),
    });
  } catch (error) {
    if (
      error instanceof RepositoryConfigurationMissingError ||
      error instanceof ViteArchiveInspectionError ||
      error instanceof FrameworkConversionRequiredError ||
      error instanceof MigrationFilenameNoncanonicalError ||
      error instanceof NextWorkersIncompatibleError
    ) {
      throw error;
    }
    throw new ViteArchiveInspectionError();
  }
}

/**
 * A schema-invalid ohmyhost.yaml, or one whose bytes are not UTF-8, is the customer's to fix;
 * `ohmyhost init` names the field.
 */
function parseRepositoryConfig(source: string | null): OhmyhostConfig {
  if (source !== null) {
    try {
      return parseOhmyhostConfigYaml(source);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new FrameworkConversionRequiredError(null, REPOSITORY_CONFIGURATION_INVALID);
}

/**
 * The customer refusal of an adapter: a TypeError that is typed when the catalog names the fix and
 * otherwise answers with the generic sentence. Any other error keeps its own classification.
 */
function planRefusal(
  error: unknown,
  adapter: SourceFrameworkAdapter,
  root: ApplicationRoot,
): unknown {
  if (!(error instanceof TypeError)) return error;
  return applicationRefusal(
    adapter,
    error instanceof NextRuntimeSourceSyntaxError
      ? { code: "source_syntax_invalid", path: error.path }
      : error instanceof FrameworkConversionDiagnosticError
        ? error.diagnostic
        : null,
    root,
  );
}

/**
 * The two database clients that cannot work are visible in the source. Every customer passes plan
 * time, so naming them here reaches the ones who never run init.
 */
function assertDatabaseContract(
  repositoryConfig: { readonly database?: { readonly enabled: boolean } },
  applicationFiles: ReadonlyMap<string, string | null>,
  frameworkPlan: FrameworkPlan,
): void {
  if (repositoryConfig.database?.enabled !== true) return;
  for (const [path, source] of applicationFiles) {
    // Bytes that are not UTF-8 cannot be scanned; the walk already refused every reachable one.
    if (source === null || !isDatabaseContractModule(path)) continue;
    const [code] = databaseContractCodes(source);
    if (code !== undefined)
      throw applicationRefusal(
        sourceFrameworkAdapter(frameworkPlan.adapter),
        { code, path },
        frameworkPlan.applicationRoot,
      );
  }
}

/**
 * Declared crons need a scheduled handler in the Worker module that receives them: the Vite
 * companion for Vite applications, src/ohmyhost/worker.ts otherwise. The functions runtime
 * also needs a fetch handler because the module is the whole Worker.
 */
function assertWorkerModuleHandlers(
  frameworkPlan: FrameworkPlan,
  applicationFiles: ReadonlyMap<string, string | null>,
): void {
  const scheduled = frameworkPlan.functions !== undefined;
  if (frameworkPlan.runtime !== "functions" && !scheduled) return;
  const path =
    frameworkPlan.adapter === "vite-static" ? VITE_COMPANION_SOURCE_PATH : WORKER_SOURCE_PATH;
  // The shared rules refuse a missing module before planning; the walk decodes every present one.
  const [finding] = workerModuleFindings({
    path,
    source: applicationFiles.get(path) ?? fail(),
    fetch: frameworkPlan.runtime === "functions",
    scheduled,
  });
  if (finding !== undefined)
    throw applicationRefusal(
      sourceFrameworkAdapter(frameworkPlan.adapter),
      finding,
      frameworkPlan.applicationRoot,
    );
}

function assertCanonicalMigrationFilenames(
  files: readonly string[],
  migrations: string | undefined,
): void {
  if (migrations === undefined) return;
  const prefix = `${migrations}/`;
  const invalid = files
    .filter((path) => path.startsWith(prefix))
    .filter(
      (path) =>
        !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/u.test(
          path.slice(prefix.length),
        ),
    );
  if (invalid.length > 0) throw new MigrationFilenameNoncanonicalError(invalid);
}

function sourceFrameworkAdapter(value: string): SourceFrameworkAdapter {
  if (
    value === "functions" ||
    value === "nextjs" ||
    value === "astro" ||
    value === "tanstack-start" ||
    value === "vite-static"
  )
    return value;
  fail();
}

type ApplicationSnapshot = Readonly<{ root: ApplicationRoot; files: readonly string[] }>;

function applicationSnapshot(
  parsed: Readonly<{ files: readonly string[]; directories: ReadonlySet<string> }>,
  root: ApplicationRoot,
): ApplicationSnapshot {
  const prefix = root === "." ? "" : `${root}/`;
  const files = parsed.files
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length));
  // A configured directory that is missing or empty is the customer's to fix; neither GitHub nor
  // the managed export lists files without their directory.
  if (files.length === 0)
    throw new FrameworkConversionRequiredError(null, {
      code: "application_root_missing",
      path: "ohmyhost.yaml",
    });
  if ((root !== "." && !parsed.directories.has(root)) || files.some((path) => path === "")) fail();
  return Object.freeze({ root, files: Object.freeze(files) });
}

function applicationInspection(
  inspection: ReadonlyMap<string, string | null>,
  root: ApplicationRoot,
): Map<string, string | null> {
  const prefix = root === "." ? "" : `${root}/`;
  const application = new Map<string, string | null>();
  for (const [path, content] of inspection) {
    if (path.startsWith(prefix)) application.set(path.slice(prefix.length), content);
  }
  return application;
}

export async function inspectViteArchive(
  archive: Uint8Array,
  crypto: SubtleCrypto = globalThis.crypto.subtle,
): ReturnType<typeof inspectFrameworkArchive> {
  const inspection = await inspectFrameworkArchive(archive, crypto);
  if (inspection.frameworkPlan.adapter !== "vite-static") fail();
  return inspection;
}

async function workerSourceEvidence(
  plan: FrameworkPlan,
  applicationFiles: ReadonlyMap<string, string | null>,
  crypto: SubtleCrypto,
) {
  if (plan.runtime === "functions") {
    const source = applicationFiles.get(WORKER_SOURCE_PATH) ?? fail();
    const bytes = new TextEncoder().encode(source);
    return Object.freeze({
      schemaVersion: "ohmyhost.worker-module/v1" as const,
      path: WORKER_SOURCE_PATH,
      byteLength: bytes.byteLength,
      sha256: await sha256(bytes, crypto),
    });
  }
  if (plan.adapter !== "vite-static" || plan.runtime !== "edge") return null;
  const source = applicationFiles.get(VITE_COMPANION_SOURCE_PATH) ?? fail();
  const bytes = new TextEncoder().encode(source);
  return Object.freeze({
    schemaVersion: "ohmyhost.vite-api-companion/v1" as const,
    path: VITE_COMPANION_SOURCE_PATH,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes, crypto),
  });
}

/** The archive inputs an adapter is selected and built from. */
interface AdapterSelection {
  readonly configuration: OhmyhostConfig;
  readonly application: ApplicationSnapshot;
  /** The application's inspection files; null where the bytes are not UTF-8. */
  readonly files: ReadonlyMap<string, string | null>;
  readonly bodies: ReadonlyMap<string, Uint8Array | null>;
}

interface AdapterSource extends AdapterSelection {
  readonly manifest: PackageManifest;
  readonly packageManager: PackageManagerDescriptor;
}

/**
 * Selects and builds the adapter in the order `ohmyhost init` judges the same source: package.json,
 * its framework family, the package manager, then the framework config. The first refusal answers
 * with its diagnostic, never as an outage.
 */
function selectAdapter(selection: AdapterSelection): FrameworkAdapter {
  const { application } = selection;
  const manifest = parsePackageManifest(selection.files.get(PACKAGE_MANIFEST));
  if (manifest === null)
    throw applicationRefusal(
      null,
      { code: "package_manifest_invalid", path: PACKAGE_MANIFEST },
      application.root,
    );
  const adapter = selectedFramework(selection, manifest);
  try {
    const packageManager = resolvePackageManager({
      packageManager: packageManagerDeclaration(manifest),
      files: application.files,
    });
    return createAdapter(adapter, { ...selection, manifest, packageManager });
  } catch (error) {
    if (error instanceof FrameworkAdmissionError)
      throw applicationRefusal(adapter, error.diagnostic, application.root);
    throw error;
  }
}

/** runtime.mode functions selects the functions runtime; otherwise exactly one framework family. */
function selectedFramework(
  selection: AdapterSelection,
  manifest: PackageManifest,
): SourceFrameworkAdapter {
  if (selection.configuration.runtime.mode === "functions") return "functions";
  const family = classifyFrameworkFamily(declaredDependencyNames(manifest));
  if (family === "vite") return "vite-static";
  if (family === "astro" || family === "nextjs" || family === "tanstack-start") return family;
  throw applicationRefusal(
    null,
    {
      code: family === "ambiguous" ? "framework_ambiguous" : "framework_unsupported",
      path: PACKAGE_MANIFEST,
    },
    selection.application.root,
  );
}

function createAdapter(adapter: SourceFrameworkAdapter, source: AdapterSource): FrameworkAdapter {
  const { application, files, manifest } = source;
  const loadPackageJson = async () => manifest;
  if (adapter === "functions") {
    assertWorkerModulePresent(source);
    return createFunctionsFrameworkAdapter({ loadPackageJson });
  }
  const loadLockfile = lockfileLoader(source.bodies, application.root);
  if (adapter === "nextjs") {
    const nextConfigPath = resolveFrameworkConfig("next.config", application.files);
    resolveFrameworkConfig("open-next.config", application.files);
    const nextConfig = configText(adapter, source, nextConfigPath, "next.config.ts");
    return createNextFrameworkAdapter({
      loadPackageJson,
      async loadNextConfig() {
        return nextConfig;
      },
      async loadRuntimeSources(paths) {
        return paths.map((path) => {
          const text = files.get(path);
          // Bytes that are not UTF-8 are refused like invalid syntax, naming the file.
          if (text === null) throw new NextRuntimeSourceSyntaxError(path);
          return Object.freeze({ path, source: text ?? fail() });
        });
      },
      loadLockfile,
    });
  }
  if (adapter === "astro") {
    const astroConfig = configText(
      adapter,
      source,
      resolveFrameworkConfig("astro.config", application.files),
      "astro.config.mjs",
    );
    return createAstroFrameworkAdapter({
      loadPackageJson,
      loadLockfile,
      async loadAstroConfig() {
        return astroConfig;
      },
    });
  }
  const viteConfigPath = resolveFrameworkConfig("vite.config", application.files);
  if (adapter === "tanstack-start") {
    const viteConfig = configText(adapter, source, viteConfigPath, "vite.config.ts");
    return createTanStackFrameworkAdapter({
      loadPackageJson,
      async loadViteConfig() {
        return viteConfig;
      },
      loadLockfile,
    });
  }
  // A Vite application may omit its config.
  const viteConfig =
    viteConfigPath === null ? null : configText(adapter, source, viteConfigPath, "vite.config.ts");
  return createViteFrameworkAdapter({
    loadPackageJson,
    loadLockfile,
    ...(viteConfig === null
      ? {}
      : {
          async loadViteConfig() {
            return viteConfig;
          },
        }),
  });
}

/** The framework config text; a missing required config and bytes that are not UTF-8 are refused. */
function configText(
  adapter: SourceFrameworkAdapter,
  source: AdapterSelection,
  path: string | null,
  requiredPath: string,
): string {
  if (path === null)
    throw applicationRefusal(
      adapter,
      { code: "framework_config_required", path: requiredPath },
      source.application.root,
    );
  const text = source.files.get(path);
  if (text === null)
    throw applicationRefusal(
      adapter,
      { code: "source_syntax_invalid", path },
      source.application.root,
    );
  return text ?? fail();
}

/**
 * The functions adapter detects an application only by its Worker module. Without one, the shared
 * rules name the first refusal, which is worker_module_required unless an earlier rule fails.
 */
function assertWorkerModulePresent(source: AdapterSource): void {
  if (source.application.files.includes(WORKER_SOURCE_PATH)) return;
  const [finding] = frameworkSourceFindings({
    framework: "functions",
    files: source.application.files,
    configuration: source.configuration,
    manifest: source.manifest,
    packageManager: source.packageManager,
    lockfile: null,
    frameworkConfig: null,
  }).findings;
  throw applicationRefusal("functions", finding ?? null, source.application.root);
}

/**
 * Reads the application lockfile the version rules resolve framework versions from. Yarn and Bun
 * lockfiles are not resolved, and a lockfile whose bytes are not UTF-8 leaves the declaration to
 * decide; the archive bound already limits every file to 5 MiB.
 */
function lockfileLoader(
  bodies: ReadonlyMap<string, Uint8Array | null>,
  root: ApplicationRoot,
): FrameworkLockfileLoader {
  const prefix = root === "." ? "" : `${root}/`;
  return async (name) =>
    name === "package-lock.json" || name === "pnpm-lock.yaml"
      ? (utf8Text(bodies.get(`${prefix}${name}`) ?? fail()) ?? undefined)
      : undefined;
}
