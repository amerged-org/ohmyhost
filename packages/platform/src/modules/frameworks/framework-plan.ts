import {
  normalizeApplicationRoot,
  type ApplicationRoot,
} from "@ohmyhost/contracts/application-root";
import type { OhmyhostConfig } from "@ohmyhost/contracts";
import { isCustomerEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import {
  FrameworkConversionDiagnosticError,
  resolvePackageManager,
  managedCustomerAuthAdmissionIssue,
  type LockfileName,
} from "@ohmyhost/contracts/framework-admission";
import { PINNED_BUN_VERSION } from "@ohmyhost/contracts/framework-build-script";
import {
  frameworkSourceFindings,
  parsePackageManifest,
  WORKER_MODULE_PATH as SOURCE_WORKER_MODULE_PATH,
  type FrameworkSourceLockfile,
  type FrameworkSourceRuleInput,
  type PackageManifest,
} from "@ohmyhost/contracts/framework-source-rules";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { normalizeCrons } from "@ohmyhost/contracts/functions";

import { isRecordedBetterAuthVersion } from "../customer-auth/customer-auth.js";
import type {
  AiRequirement,
  FrameworkLockfileLoader,
  FrameworkPlan,
  FunctionsRequirement,
} from "../../ports/framework.js";

/** The customer Worker module that receives scheduled runs outside the Vite companion. */
export const WORKER_MODULE_PATH = SOURCE_WORKER_MODULE_PATH;

/** The parsed package.json, or the typed refusal of a file that is not one JSON object. */
export function requirePackageManifest(value: unknown): PackageManifest {
  const manifest = parsePackageManifest(value);
  if (manifest === null) {
    throw new FrameworkConversionDiagnosticError({
      code: "package_manifest_invalid",
      path: "package.json",
    });
  }
  return manifest;
}

/**
 * Throws the first finding of the shared source rules as its typed diagnostic, so every adapter
 * refuses a customer source with the finding `ohmyhost init` lists first.
 */
export function assertFrameworkSource(input: FrameworkSourceRuleInput): void {
  const [finding] = frameworkSourceFindings(input).findings;
  if (finding !== undefined) throw new FrameworkConversionDiagnosticError(finding);
}

/** The lockfile an adapter's optional loader reads; null without a loader or without text. */
export async function loadFrameworkLockfile(
  loader: FrameworkLockfileLoader | undefined,
  name: LockfileName,
): Promise<FrameworkSourceLockfile | null> {
  if (loader === undefined) return null;
  const text: unknown = await loader(name);
  if (text === undefined) return null;
  if (typeof text !== "string") throw new TypeError("Framework lockfile loader returned no text");
  return Object.freeze({ name, text });
}

export const FRAMEWORK_PLAN_SCHEMA_VERSION = "ohmyhost.framework-plan/v5" as const;

export type StaticFrameworkAdapter = "astro" | "ohmyhost-config" | "tanstack-start" | "vite-static";
export type ProductionStaticFrameworkAdapter = Exclude<StaticFrameworkAdapter, "ohmyhost-config">;

export interface StaticFrameworkPlan extends FrameworkPlan {
  readonly buildCommand: string;
  readonly outputDirectory: string;
  readonly adapter: StaticFrameworkAdapter;
  readonly runtime: "static";
}

export interface ProductionStaticFrameworkPlan extends StaticFrameworkPlan {
  readonly adapter: ProductionStaticFrameworkAdapter;
}

export interface AstroEdgeFrameworkPlan extends FrameworkPlan {
  readonly adapter: "astro";
  readonly runtime: "edge";
  readonly buildCommand: string;
  readonly outputDirectory: "dist/client";
  readonly serverOutputDirectory: "dist/server";
  readonly serverEntryPoint: "dist/server/entry.mjs";
  readonly serverConfigPath: "dist/server/wrangler.json";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
}

export interface TanStackEdgeFrameworkPlan extends FrameworkPlan {
  readonly buildCommand: string;
  readonly adapter: "tanstack-start";
  readonly runtime: "edge";
  readonly outputDirectory: "dist/client";
  readonly serverOutputDirectory: "dist/server";
  readonly serverEntryPoint: "dist/server/index.js";
  readonly serverConfigPath: "dist/server/wrangler.json";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
}

export interface ViteCompanionFrameworkPlan extends FrameworkPlan {
  readonly buildCommand: string;
  readonly adapter: "vite-static";
  readonly runtime: "edge";
  readonly outputDirectory: "dist";
  readonly serverOutputDirectory: ".ohmyhost/vite-companion";
  readonly serverEntryPoint: ".ohmyhost/vite-companion/worker.js";
  readonly serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
}

export interface NextJsEdgeFrameworkPlan extends FrameworkPlan {
  readonly buildCommand: string;
  readonly adapter: "nextjs";
  readonly runtime: "edge";
  readonly outputDirectory: ".open-next/assets";
  readonly ssgCacheMaxBytes?: number;
  readonly nextRevalidatePath?: true;
  readonly serverOutputDirectory: ".ohmyhost-worker";
  readonly serverEntryPoint: ".ohmyhost-worker/worker.js";
  readonly serverConfigPath: "wrangler.jsonc";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
}

/** A customer Worker module (src/ohmyhost/worker.ts) hosted without a framework build. */
export interface FunctionsFrameworkPlan extends FrameworkPlan {
  readonly adapter: "functions";
  readonly runtime: "functions";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
}

export type ProductionFrameworkPlan =
  | AstroEdgeFrameworkPlan
  | ProductionStaticFrameworkPlan
  | ViteCompanionFrameworkPlan
  | TanStackEdgeFrameworkPlan
  | NextJsEdgeFrameworkPlan
  | FunctionsFrameworkPlan;
// A static plan has no Worker to receive the AI key, so its exact key set refuses `ai`.
const STATIC_PLAN_KEYS = [
  "adapter",
  "applicationRoot",
  "auth",
  "buildCommand",
  "database",
  "installCommand",
  "mail",
  "outputDirectory",
  "runtime",
  "runtimePolicy",
  "schemaVersion",
  "storage",
].sort();
const EDGE_PLAN_KEYS = [
  ...STATIC_PLAN_KEYS,
  "serverOutputDirectory",
  "serverEntryPoint",
  "serverConfigPath",
  "compatibilityDate",
  "compatibilityFlags",
].sort();
const FUNCTIONS_PLAN_KEYS = [
  "adapter",
  "applicationRoot",
  "auth",
  "compatibilityDate",
  "compatibilityFlags",
  "database",
  "installCommand",
  "mail",
  "runtime",
  "runtimePolicy",
  "schemaVersion",
  "storage",
].sort();
const OPTIONAL_PLAN_KEYS = ["ai", "browser", "functions"] as const;
const FUNCTIONS_PLAN_COMPATIBILITY_DATE = "2025-01-01";

const PACKAGE_MANAGER_COMMANDS = Object.freeze(
  [
    { packageManager: `bun@${PINNED_BUN_VERSION}`, files: ["bun.lock"] },
    { packageManager: "npm@1.0.0", files: ["package-lock.json"] },
    { packageManager: "pnpm@1.0.0", files: ["pnpm-lock.yaml"] },
    { packageManager: "yarn@4.9.4", files: ["yarn.lock"] },
  ].map((input) => resolvePackageManager(input)),
);

export function parseStaticFrameworkPlan(value: unknown): StaticFrameworkPlan {
  if (!isRecord(value) || !hasExactKeys(value, STATIC_PLAN_KEYS)) invalidStaticPlan();
  let applicationRoot: ApplicationRoot;
  let runtimePolicy: FrameworkPlan["runtimePolicy"];
  let database: FrameworkPlan["database"];
  let auth: FrameworkPlan["auth"];
  let mail: FrameworkPlan["mail"];
  let storage: FrameworkPlan["storage"];
  let commands: FrameworkBuildCommands;
  try {
    applicationRoot = normalizeApplicationRoot(value["applicationRoot"]);
    runtimePolicy = parseRuntimePolicy(value["runtimePolicy"]);
    database = parseDatabaseRequirement(value["database"]);
    auth = parseCustomerAuthRequirement(value["auth"]);
    mail = parseMailRequirement(value["mail"]);
    storage = parseStorageRequirement(value["storage"]);
    commands = parseFrameworkBuildCommands(value["installCommand"], value["buildCommand"]);
  } catch {
    invalidStaticPlan();
  }
  if (auth.provider === "better-auth" && database.enabled !== true) invalidStaticPlan();
  if (managedCustomerAuthAdmissionIssue({ auth, database, mail }) !== null) invalidStaticPlan();
  if (storage.enabled) invalidStaticPlan();
  if (
    value["adapter"] === "astro" &&
    (database.enabled || mail.enabled || auth.provider === "better-auth")
  )
    invalidStaticPlan();
  if (
    value["schemaVersion"] !== FRAMEWORK_PLAN_SCHEMA_VERSION ||
    (value["adapter"] !== "astro" &&
      value["adapter"] !== "ohmyhost-config" &&
      value["adapter"] !== "vite-static" &&
      value["adapter"] !== "tanstack-start") ||
    value["runtime"] !== "static" ||
    !nonEmptyString(value["outputDirectory"]) ||
    ((value["adapter"] === "vite-static" || value["adapter"] === "astro") &&
      value["outputDirectory"] !== "dist") ||
    (value["adapter"] === "tanstack-start" && value["outputDirectory"] !== "dist/client")
  ) {
    invalidStaticPlan();
  }
  return Object.freeze({
    schemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
    applicationRoot,
    adapter: value["adapter"],
    runtime: "static",
    installCommand: commands.installCommand,
    buildCommand: commands.buildCommand,
    outputDirectory: value["outputDirectory"],
    runtimePolicy,
    database,
    auth,
    mail,
    storage,
  });
}

export function parseProductionStaticFrameworkPlan(value: unknown): ProductionStaticFrameworkPlan {
  const plan = parseStaticFrameworkPlan(value);
  const adapter = plan.adapter;
  if (adapter === "ohmyhost-config") invalidStaticPlan();
  return Object.freeze({ ...plan, adapter });
}

export function parseNewProductionFrameworkPlan(value: unknown): ProductionFrameworkPlan {
  if (!isRecord(value)) invalidFrameworkPlan();
  if (value["runtime"] === "static") {
    try {
      return parseProductionStaticFrameworkPlan(value);
    } catch {
      invalidFrameworkPlan();
    }
  }
  if (value["runtime"] === "functions") return parseCurrentFunctionsPlan(value);
  const edgeKeys =
    value["adapter"] === "nextjs"
      ? [
          ...EDGE_PLAN_KEYS,
          ...(Object.hasOwn(value, "ssgCacheMaxBytes") ? ["ssgCacheMaxBytes"] : []),
          ...(Object.hasOwn(value, "nextRevalidatePath") ? ["nextRevalidatePath"] : []),
        ].sort()
      : EDGE_PLAN_KEYS;
  if (!hasKeysWithOptional(value, edgeKeys, OPTIONAL_PLAN_KEYS)) invalidFrameworkPlan();
  let applicationRoot: ApplicationRoot;
  let runtimePolicy: FrameworkPlan["runtimePolicy"];
  let database: FrameworkPlan["database"];
  let auth: FrameworkPlan["auth"];
  let mail: FrameworkPlan["mail"];
  let storage: FrameworkPlan["storage"];
  try {
    applicationRoot = normalizeApplicationRoot(value["applicationRoot"]);
    runtimePolicy = parseRuntimePolicy(value["runtimePolicy"]);
    database = parseDatabaseRequirement(value["database"]);
    auth = parseCustomerAuthRequirement(value["auth"]);
    mail = parseMailRequirement(value["mail"]);
    storage = parseStorageRequirement(value["storage"]);
  } catch {
    invalidFrameworkPlan();
  }
  if (auth.provider === "better-auth" && database.enabled !== true) invalidFrameworkPlan();
  if (managedCustomerAuthAdmissionIssue({ auth, database, mail }) !== null) invalidFrameworkPlan();
  return parseCurrentEdgePlan(value, applicationRoot, runtimePolicy, database, auth, mail, storage);
}

export function databaseRequirementFromConfig(config: OhmyhostConfig): FrameworkPlan["database"] {
  if (config.database?.enabled !== true) return Object.freeze({ enabled: false as const });
  if (config.database.migrations === undefined) invalidFrameworkPlan();
  return Object.freeze({ enabled: true as const, migrations: config.database.migrations });
}

export function mailRequirementFromConfig(config: OhmyhostConfig): FrameworkPlan["mail"] {
  return Object.freeze({ enabled: config.mail?.enabled === true });
}

export function storageRequirementFromConfig(config: OhmyhostConfig): FrameworkPlan["storage"] {
  if (config.storage === undefined) return Object.freeze({ enabled: false as const });
  return Object.freeze({
    enabled: true as const,
    provider: config.storage.provider,
    jurisdiction: config.storage.jurisdiction,
    public: config.storage.public,
  });
}

/** Declared crons, present only when at least one schedule exists. */
export function functionsRequirementFromConfig(
  config: OhmyhostConfig,
): FunctionsRequirement | undefined {
  const crons = config.functions?.crons;
  if (crons === undefined || crons.length === 0) return undefined;
  return Object.freeze({ crons: Object.freeze([...crons]) });
}

/** Declared AI gateway access, present only when `ai.enabled` is true; the jurisdiction has no default. */
export function aiRequirementFromConfig(config: OhmyhostConfig): FrameworkPlan["ai"] {
  if (config.ai?.enabled !== true) return undefined;
  if (config.ai.jurisdiction === undefined) invalidFrameworkPlan();
  return Object.freeze({ enabled: true as const, jurisdiction: config.ai.jurisdiction });
}

export function browserRequirementFromConfig(config: OhmyhostConfig): FrameworkPlan["browser"] {
  return config.browser?.enabled === true ? Object.freeze({ enabled: true as const }) : undefined;
}

/** The install command of a functions plan must be one of the supported package managers. */
function parseFrameworkInstallCommand(installCommand: unknown): string {
  const commands = PACKAGE_MANAGER_COMMANDS.find(
    (candidate) => candidate.installCommand === installCommand,
  );
  if (commands === undefined) invalidFrameworkPlan();
  return commands.installCommand;
}

function parseCurrentFunctionsPlan(value: Record<string, unknown>): FunctionsFrameworkPlan {
  if (
    !hasKeysWithOptional(value, FUNCTIONS_PLAN_KEYS, OPTIONAL_PLAN_KEYS) ||
    value["schemaVersion"] !== FRAMEWORK_PLAN_SCHEMA_VERSION ||
    value["adapter"] !== "functions" ||
    !validCompatibility(value) ||
    value["compatibilityDate"] < FUNCTIONS_PLAN_COMPATIBILITY_DATE
  ) {
    invalidFrameworkPlan();
  }
  let applicationRoot: ApplicationRoot;
  let runtimePolicy: FrameworkPlan["runtimePolicy"];
  let database: FrameworkPlan["database"];
  let auth: FrameworkPlan["auth"];
  let mail: FrameworkPlan["mail"];
  let storage: FrameworkPlan["storage"];
  try {
    applicationRoot = normalizeApplicationRoot(value["applicationRoot"]);
    runtimePolicy = parseRuntimePolicy(value["runtimePolicy"]);
    database = parseDatabaseRequirement(value["database"]);
    auth = parseCustomerAuthRequirement(value["auth"]);
    mail = parseMailRequirement(value["mail"]);
    storage = parseStorageRequirement(value["storage"]);
  } catch {
    invalidFrameworkPlan();
  }
  if (
    auth.provider === "better-auth" &&
    (database.enabled !== true || auth.deployment !== "companion")
  )
    invalidFrameworkPlan();
  if (managedCustomerAuthAdmissionIssue({ auth, database, mail }) !== null) invalidFrameworkPlan();
  const functions = Object.hasOwn(value, "functions")
    ? parseFunctionsRequirement(value["functions"])
    : undefined;
  const ai = Object.hasOwn(value, "ai") ? parseAiRequirement(value["ai"]) : undefined;
  const browser = Object.hasOwn(value, "browser")
    ? parseBrowserRequirement(value["browser"])
    : undefined;
  return Object.freeze({
    schemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
    applicationRoot,
    adapter: "functions",
    runtime: "functions",
    installCommand: parseFrameworkInstallCommand(value["installCommand"]),
    compatibilityDate: value["compatibilityDate"],
    compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
    runtimePolicy,
    database,
    auth,
    mail,
    storage,
    ...(functions === undefined ? {} : { functions }),
    ...(ai === undefined ? {} : { ai }),
    ...(browser === undefined ? {} : { browser }),
  });
}

export function serializeNewProductionFrameworkPlanPreimage(value: unknown): string {
  const plan = parseNewProductionFrameworkPlan(value);
  if (plan.runtime === "static") {
    return JSON.stringify({
      schemaVersion: plan.schemaVersion,
      applicationRoot: plan.applicationRoot,
      adapter: plan.adapter,
      runtime: plan.runtime,
      installCommand: plan.installCommand,
      buildCommand: plan.buildCommand,
      outputDirectory: plan.outputDirectory,
      runtimePolicy: plan.runtimePolicy,
      database: plan.database,
      auth: plan.auth,
      mail: plan.mail,
      storage: plan.storage,
    });
  }
  if (plan.runtime === "functions") {
    return JSON.stringify({
      schemaVersion: plan.schemaVersion,
      applicationRoot: plan.applicationRoot,
      adapter: plan.adapter,
      runtime: plan.runtime,
      installCommand: plan.installCommand,
      compatibilityDate: plan.compatibilityDate,
      compatibilityFlags: plan.compatibilityFlags,
      runtimePolicy: plan.runtimePolicy,
      database: plan.database,
      auth: plan.auth,
      mail: plan.mail,
      storage: plan.storage,
      ...(plan.functions === undefined ? {} : { functions: plan.functions }),
      ...(plan.ai === undefined ? {} : { ai: plan.ai }),
      ...(plan.browser === undefined ? {} : { browser: plan.browser }),
    });
  }
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    applicationRoot: plan.applicationRoot,
    adapter: plan.adapter,
    runtime: plan.runtime,
    installCommand: plan.installCommand,
    buildCommand: plan.buildCommand,
    outputDirectory: plan.outputDirectory,
    serverOutputDirectory: plan.serverOutputDirectory,
    serverEntryPoint: plan.serverEntryPoint,
    serverConfigPath: plan.serverConfigPath,
    compatibilityDate: plan.compatibilityDate,
    compatibilityFlags: plan.compatibilityFlags,
    ...(plan.adapter === "nextjs" && plan.ssgCacheMaxBytes !== undefined
      ? { ssgCacheMaxBytes: plan.ssgCacheMaxBytes }
      : {}),
    ...(plan.adapter === "nextjs" && plan.nextRevalidatePath === true
      ? { nextRevalidatePath: true }
      : {}),
    runtimePolicy: plan.runtimePolicy,
    database: plan.database,
    auth: plan.auth,
    mail: plan.mail,
    storage: plan.storage,
    ...(plan.functions === undefined ? {} : { functions: plan.functions }),
    ...(plan.ai === undefined ? {} : { ai: plan.ai }),
    ...(plan.browser === undefined ? {} : { browser: plan.browser }),
  });
}

function parseCurrentEdgePlan(
  value: Record<string, unknown>,
  applicationRoot: ApplicationRoot,
  runtimePolicy: FrameworkPlan["runtimePolicy"],
  database: FrameworkPlan["database"],
  auth: FrameworkPlan["auth"],
  mail: FrameworkPlan["mail"],
  storage: FrameworkPlan["storage"],
):
  | AstroEdgeFrameworkPlan
  | ViteCompanionFrameworkPlan
  | TanStackEdgeFrameworkPlan
  | NextJsEdgeFrameworkPlan {
  if (
    value["schemaVersion"] !== FRAMEWORK_PLAN_SCHEMA_VERSION ||
    value["runtime"] !== "edge" ||
    !validCompatibility(value)
  ) {
    invalidFrameworkPlan();
  }
  const commands = parseFrameworkBuildCommands(value["installCommand"], value["buildCommand"]);
  const functions = Object.hasOwn(value, "functions")
    ? parseFunctionsRequirement(value["functions"])
    : undefined;
  const ai = Object.hasOwn(value, "ai") ? parseAiRequirement(value["ai"]) : undefined;
  const browser = Object.hasOwn(value, "browser")
    ? parseBrowserRequirement(value["browser"])
    : undefined;
  if (value["adapter"] === "vite-static") {
    assertViteCompanionShape(value, auth);
    return Object.freeze({
      schemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
      applicationRoot,
      adapter: "vite-static",
      runtime: "edge",
      installCommand: commands.installCommand,
      buildCommand: commands.buildCommand,
      outputDirectory: "dist",
      serverOutputDirectory: ".ohmyhost/vite-companion",
      serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
      serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
      compatibilityDate: value["compatibilityDate"],
      compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
      runtimePolicy,
      database,
      auth,
      mail,
      storage,
      ...(functions === undefined ? {} : { functions }),
      ...(ai === undefined ? {} : { ai }),
      ...(browser === undefined ? {} : { browser }),
    });
  }
  if (value["adapter"] === "astro") {
    if (
      value["compatibilityDate"] < "2026-10-12" ||
      value["outputDirectory"] !== "dist/client" ||
      value["serverOutputDirectory"] !== "dist/server" ||
      value["serverEntryPoint"] !== "dist/server/entry.mjs" ||
      value["serverConfigPath"] !== "dist/server/wrangler.json"
    )
      invalidFrameworkPlan();
    return Object.freeze({
      schemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
      applicationRoot,
      adapter: "astro",
      runtime: "edge",
      installCommand: commands.installCommand,
      buildCommand: commands.buildCommand,
      outputDirectory: "dist/client",
      serverOutputDirectory: "dist/server",
      serverEntryPoint: "dist/server/entry.mjs",
      serverConfigPath: "dist/server/wrangler.json",
      compatibilityDate: value["compatibilityDate"],
      compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
      runtimePolicy,
      database,
      auth,
      mail,
      storage,
      ...(functions === undefined ? {} : { functions }),
      ...(ai === undefined ? {} : { ai }),
      ...(browser === undefined ? {} : { browser }),
    });
  }
  if (value["adapter"] === "tanstack-start") {
    assertTanStackEdgeShape(value);
    return Object.freeze({
      schemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
      applicationRoot,
      adapter: "tanstack-start",
      runtime: "edge",
      installCommand: commands.installCommand,
      buildCommand: commands.buildCommand,
      outputDirectory: "dist/client",
      serverOutputDirectory: "dist/server",
      serverEntryPoint: "dist/server/index.js",
      serverConfigPath: "dist/server/wrangler.json",
      compatibilityDate: value["compatibilityDate"],
      compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
      runtimePolicy,
      database,
      auth,
      mail,
      storage,
      ...(functions === undefined ? {} : { functions }),
      ...(ai === undefined ? {} : { ai }),
      ...(browser === undefined ? {} : { browser }),
    });
  }
  assertNextEdgeShape(value);
  if (Object.hasOwn(value, "nextRevalidatePath") && value["nextRevalidatePath"] !== true)
    invalidFrameworkPlan();
  if (
    Object.hasOwn(value, "ssgCacheMaxBytes") &&
    (!Number.isSafeInteger(value["ssgCacheMaxBytes"]) ||
      Number(value["ssgCacheMaxBytes"]) < 1024 * 1024 ||
      Number(value["ssgCacheMaxBytes"]) > 64 * 1024 * 1024 ||
      Number(value["ssgCacheMaxBytes"]) % (1024 * 1024) !== 0)
  )
    invalidFrameworkPlan();
  return Object.freeze({
    schemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
    applicationRoot,
    adapter: "nextjs",
    runtime: "edge",
    installCommand: commands.installCommand,
    buildCommand: commands.buildCommand,
    outputDirectory: ".open-next/assets",
    ...(Object.hasOwn(value, "ssgCacheMaxBytes")
      ? { ssgCacheMaxBytes: Number(value["ssgCacheMaxBytes"]) }
      : {}),
    ...(value["nextRevalidatePath"] === true ? { nextRevalidatePath: true as const } : {}),
    serverOutputDirectory: ".ohmyhost-worker",
    serverEntryPoint: ".ohmyhost-worker/worker.js",
    serverConfigPath: "wrangler.jsonc",
    compatibilityDate: value["compatibilityDate"],
    compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
    runtimePolicy,
    database,
    auth,
    mail,
    storage,
    ...(functions === undefined ? {} : { functions }),
    ...(ai === undefined ? {} : { ai }),
    ...(browser === undefined ? {} : { browser }),
  });
}

function parseFunctionsRequirement(value: unknown): FunctionsRequirement {
  if (!isRecord(value) || !hasExactKeys(value, ["crons"]) || !Array.isArray(value["crons"])) {
    invalidFrameworkPlan();
  }
  let crons: readonly string[];
  try {
    crons = normalizeCrons(value["crons"]);
  } catch {
    invalidFrameworkPlan();
  }
  if (JSON.stringify(crons) !== JSON.stringify(value["crons"])) invalidFrameworkPlan();
  return Object.freeze({ crons });
}

function parseBrowserRequirement(value: unknown): Readonly<{ enabled: true }> {
  if (!isRecord(value) || !hasExactKeys(value, ["enabled"]) || value["enabled"] !== true)
    invalidFrameworkPlan();
  return Object.freeze({ enabled: true });
}

function parseAiRequirement(value: unknown): AiRequirement {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["enabled", "jurisdiction"]) ||
    value["enabled"] !== true ||
    (value["jurisdiction"] !== "eu" && value["jurisdiction"] !== "any")
  ) {
    invalidFrameworkPlan();
  }
  return Object.freeze({ enabled: true as const, jurisdiction: value["jurisdiction"] });
}

function assertViteCompanionShape(
  value: Record<string, unknown>,
  auth: FrameworkPlan["auth"],
): void {
  if (
    value["outputDirectory"] !== "dist" ||
    value["serverOutputDirectory"] !== ".ohmyhost/vite-companion" ||
    value["serverEntryPoint"] !== ".ohmyhost/vite-companion/worker.js" ||
    value["serverConfigPath"] !== ".ohmyhost/vite-companion/wrangler.jsonc" ||
    (value["compatibilityDate"] as string) < "2025-01-01" ||
    (auth.provider === "better-auth" && auth.deployment !== "companion")
  ) {
    invalidFrameworkPlan();
  }
}

function parseRuntimePolicy(value: unknown): FrameworkPlan["runtimePolicy"] {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ["egressAllowedOrigins", "healthCheckPath"]) &&
      !hasExactKeys(value, ["browser", "egressAllowedOrigins", "healthCheckPath"]))
  ) {
    invalidFrameworkPlan();
  }
  const healthCheckPath = value["healthCheckPath"];
  const egressAllowedOrigins = value["egressAllowedOrigins"];
  if (
    typeof healthCheckPath !== "string" ||
    healthCheckPath.length < 1 ||
    healthCheckPath.length > 256 ||
    !healthCheckPath.startsWith("/") ||
    healthCheckPath.startsWith("//") ||
    healthCheckPath.includes("\\") ||
    healthCheckPath.includes("?") ||
    healthCheckPath.includes("#") ||
    healthCheckPath.split("/").some((segment) => segment === "." || segment === "..") ||
    !Array.isArray(egressAllowedOrigins) ||
    egressAllowedOrigins.length > 16
  ) {
    invalidFrameworkPlan();
  }
  const origins: string[] = [];
  for (const origin of egressAllowedOrigins) {
    if (!isCustomerEgressOrigin(origin)) invalidFrameworkPlan();
    origins.push(origin);
  }
  for (let index = 1; index < origins.length; index += 1) {
    const previous = origins[index - 1];
    const current = origins[index];
    if (previous === undefined || current === undefined || previous >= current) {
      invalidFrameworkPlan();
    }
  }
  return Object.freeze({
    healthCheckPath,
    egressAllowedOrigins: Object.freeze(origins),
    ...(value["browser"] === undefined ? {} : { browser: parseBrowserPolicy(value["browser"]) }),
  });
}

function parseDatabaseRequirement(value: unknown): FrameworkPlan["database"] {
  if (!isRecord(value)) invalidFrameworkPlan();
  if (value["enabled"] === false && hasExactKeys(value, ["enabled"])) {
    return Object.freeze({ enabled: false as const });
  }
  if (
    value["enabled"] !== true ||
    !hasExactKeys(value, ["enabled", "migrations"]) ||
    typeof value["migrations"] !== "string" ||
    value["migrations"].length === 0 ||
    value["migrations"].length > 512 ||
    value["migrations"].startsWith("/") ||
    value["migrations"].includes("\\") ||
    value["migrations"].includes(":") ||
    value["migrations"].split("/").some((part) => part === "..")
  ) {
    invalidFrameworkPlan();
  }
  return Object.freeze({ enabled: true as const, migrations: value["migrations"] });
}

function parseCustomerAuthRequirement(value: unknown): FrameworkPlan["auth"] {
  if (!isRecord(value)) invalidFrameworkPlan();
  if (value["provider"] === "none" && hasExactKeys(value, ["provider"])) {
    return Object.freeze({ provider: "none" as const });
  }
  if (
    value["provider"] === "omh-native" &&
    hasExactKeys(value, ["bindingName", "provider", "routePath"]) &&
    value["routePath"] === "/api/auth/v1" &&
    value["bindingName"] === "OHMYHOST_AUTH"
  ) {
    return Object.freeze({
      provider: "omh-native" as const,
      routePath: "/api/auth/v1" as const,
      bindingName: "OHMYHOST_AUTH" as const,
    });
  }
  if (
    !hasExactKeys(value, [
      "authSecretName",
      "databaseBindingName",
      "databaseSchema",
      "deployment",
      "provider",
      "routePath",
      "version",
    ]) ||
    value["provider"] !== "better-auth" ||
    !isRecordedBetterAuthVersion(value["version"]) ||
    (value["deployment"] !== "embedded" && value["deployment"] !== "companion") ||
    value["routePath"] !== "/api/auth" ||
    value["databaseSchema"] !== "auth" ||
    value["databaseBindingName"] !== "OHMYHOST_DATABASE" ||
    value["authSecretName"] !== "BETTER_AUTH_SECRET"
  ) {
    invalidFrameworkPlan();
  }
  return Object.freeze({
    provider: "better-auth" as const,
    version: value["version"],
    deployment: value["deployment"],
    routePath: "/api/auth" as const,
    databaseSchema: "auth" as const,
    databaseBindingName: "OHMYHOST_DATABASE" as const,
    authSecretName: "BETTER_AUTH_SECRET" as const,
  });
}

function parseMailRequirement(value: unknown): FrameworkPlan["mail"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["enabled"]) ||
    typeof value["enabled"] !== "boolean"
  ) {
    invalidFrameworkPlan();
  }
  return Object.freeze({ enabled: value["enabled"] });
}

function parseStorageRequirement(value: unknown): FrameworkPlan["storage"] {
  if (!isRecord(value)) invalidFrameworkPlan();
  if (value["enabled"] === false && hasExactKeys(value, ["enabled"])) {
    return Object.freeze({ enabled: false as const });
  }
  if (
    value["enabled"] !== true ||
    !hasExactKeys(value, ["enabled", "jurisdiction", "provider", "public"]) ||
    value["provider"] !== "r2" ||
    (value["jurisdiction"] !== "eu" && value["jurisdiction"] !== "us") ||
    value["public"] !== false
  ) {
    invalidFrameworkPlan();
  }
  return Object.freeze({
    enabled: true as const,
    provider: "r2" as const,
    jurisdiction: value["jurisdiction"],
    public: false as const,
  });
}

function assertTanStackEdgeShape(value: Record<string, unknown>): void {
  if (
    value["outputDirectory"] !== "dist/client" ||
    value["serverOutputDirectory"] !== "dist/server" ||
    value["serverEntryPoint"] !== "dist/server/index.js" ||
    value["serverConfigPath"] !== "dist/server/wrangler.json" ||
    (value["compatibilityDate"] as string) < "2025-04-01"
  ) {
    invalidFrameworkPlan();
  }
}

function assertNextEdgeShape(value: Record<string, unknown>): void {
  if (
    value["adapter"] !== "nextjs" ||
    value["outputDirectory"] !== ".open-next/assets" ||
    value["serverOutputDirectory"] !== ".ohmyhost-worker" ||
    value["serverEntryPoint"] !== ".ohmyhost-worker/worker.js" ||
    value["serverConfigPath"] !== "wrangler.jsonc" ||
    (value["compatibilityDate"] as string) < "2024-09-23"
  ) {
    invalidFrameworkPlan();
  }
}

interface FrameworkBuildCommands {
  readonly installCommand: string;
  readonly buildCommand: string;
}

function parseFrameworkBuildCommands(
  installCommand: unknown,
  buildCommand: unknown,
): FrameworkBuildCommands {
  const commands = PACKAGE_MANAGER_COMMANDS.find(
    (candidate) => candidate.installCommand === installCommand,
  );
  if (commands === undefined || commands.buildCommand !== buildCommand) invalidFrameworkPlan();
  return commands;
}

function validCompatibility(value: Record<string, unknown>): value is Record<string, unknown> & {
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
} {
  return (
    typeof value["compatibilityDate"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value["compatibilityDate"]) &&
    Array.isArray(value["compatibilityFlags"]) &&
    value["compatibilityFlags"].length === 1 &&
    value["compatibilityFlags"][0] === "nodejs_compat"
  );
}

function invalidStaticPlan(): never {
  throw new TypeError("Static framework plan is invalid");
}

function invalidFrameworkPlan(): never {
  throw new TypeError("Framework plan is invalid");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
