#!/usr/bin/env node
/* global console, fetch, process */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTROL_CORE_CONFIG,
  controlCoreEntrypoints,
  inspectControlCoreConsumer,
} from "./control-core-train.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { observeFixedCore } from "./control-core-operator.mjs";
import { parseJsonc } from "./platform-release.mjs";
import { validateTrainManifest } from "./release-pipeline.mjs";
import { assertPolicyStepConfigs } from "./release-policy-cohort.mjs";
import { PREVIEW_RUNTIME_PROFILES, PRIVATE_WORKER_PROFILES } from "./release-private-worker.mjs";
import {
  readPrivateReleaseJson,
  releaseHash,
  requirePrivateReleaseDirectory,
} from "./release-rehearsal-artifacts.mjs";
import { workerPresenceObserver } from "./release-worker-presence.mjs";

const SUFFIX = { development: "-poc-private-fullstack", production: "-production" };
const ACCOUNT = /^[a-f0-9]{32}$/u;
// This bounded PGCF-only entrypoint is an intentionally separate manual release of the
// same Worker, not an additional consumer in the full Native-capable Production train.
const PGCF_PRODUCTION_CONFIG = "apps/neon-management/wrangler.pgcf.production.jsonc";
const FULL_PRODUCTION_CONFIG = "apps/neon-management/wrangler.production.jsonc";
const DOMAIN_KEYRING_PRODUCTION_CONFIG =
  "apps/cloudflare-domain-management/wrangler.keyring.production.jsonc";
const DOMAIN_FULL_PRODUCTION_CONFIG = "apps/cloudflare-domain-management/wrangler.production.jsonc";
// W44 bootstrap profiles are selected only by the explicit staged activation train.
// Inventory still exposes them; an ordinary full train uses each final profile once.
const CONNECTION_BOOTSTRAP_CONFIGS = new Set([
  "apps/control-api/wrangler.observer.development.jsonc",
  "apps/control-api/wrangler.observer.production.jsonc",
  "apps/connection-broker/wrangler.bootstrap.development.jsonc",
  "apps/connection-broker/wrangler.bootstrap.production.jsonc",
]);
export function isManualCoreProfile(config, environment) {
  return (
    CONNECTION_BOOTSTRAP_CONFIGS.has(config) ||
    (environment === "production" &&
      [PGCF_PRODUCTION_CONFIG, DOMAIN_KEYRING_PRODUCTION_CONFIG].includes(config))
  );
}
const stepId = (config) =>
  config
    .replace(/^apps\//u, "")
    .replace(/\.jsonc$/u, "")
    .replace(/wrangler\.?/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

/** Every checked-in Worker profile of one environment (by name suffix), in a stable order. */
export async function readEnvironmentProfiles({ repositoryRoot, environment }) {
  if (!Object.hasOwn(SUFFIX, environment)) throw new Error("Core manifest scope is invalid");
  const root = resolve(repositoryRoot);
  const profiles = [];
  for (const app of (await readdir(join(root, "apps"))).sort())
    for (const file of (await readdir(join(root, "apps", app)).catch(() => [])).sort()) {
      if (!/^wrangler.*\.jsonc$/u.test(file)) continue;
      const config = `apps/${app}/${file}`;
      const bytes = await readFile(join(root, config));
      const configuration = parseJsonc(bytes.toString("utf8"));
      if (
        typeof configuration?.name === "string" &&
        (configuration.name.endsWith(SUFFIX[environment]) ||
          configuration.name === `ohmyho-connection-broker-${environment}` ||
          new RegExp(
            `^ohmyho-(?:native-auth|project-database)-${environment}-(?:us|eu)$`,
            "u",
          ).test(configuration.name))
      )
        profiles.push({ config, bytes, configuration });
    }
  return profiles;
}

/** `workerExists` for a manifest from the provider: confirmed present or confirmed absent, anything else throws. */
export function providerWorkerExists({ accountId, token, fetcher = fetch }) {
  const observe = workerPresenceObserver({ token, fetch: fetcher });
  return async (workerName) => (await observe({ accountId, workerName })).kind === "present";
}

/**
 * The ordered release-train manifest of one environment's cutover: the Core Worker first, then every checked-in
 * Worker profile of that environment that serves the D1 Control, each after the Core and after every other train
 * Worker it calls through a service binding. Nothing here is secret: the Core resource comes from the operator's
 * provider observation and is written only into the private manifest the caller names.
 *
 * The bounded PGCF and Domain-keyring Production profiles stay discoverable for inventory, but are
 * excluded from this full train and refused through both `also` and `exclude`; each has its own manual release path.
 *
 * A Worker of the closed private-creation profile map (the credit service) is an ordinary update step when it exists
 * live and a `create_private` step with a fresh creation id when it does not: `workerExists(workerName)` answers from the
 * provider, and a manifest is never built on a guess. A Production creation names the completed same-source Development
 * train as `developmentReference` (`{manifest, state}`, absolute private paths).
 *
 * `exclude` leaves a D1 consumer out of the manifest, and only while its Worker is absent live: such a Worker is created
 * once outside the train and ships with the train from the next release on. Every `also` and `exclude` entry must be a
 * checked-in profile of this environment.
 */
export async function buildCoreTrainManifest({
  repositoryRoot,
  environment,
  accountId,
  sourceCommit,
  core,
  rehearsal,
  imagesDirectory,
  also = [],
  exclude = [],
  workerExists,
  developmentReference,
  nativeAuthLaunchPolicy,
  previewSecretsFile,
}) {
  const root = resolve(repositoryRoot);
  const coreName = CONTROL_CORE_WORKER_PROFILES[environment];
  if (coreName === undefined || !ACCOUNT.test(accountId ?? ""))
    throw new Error("Core manifest scope is invalid");
  if (rehearsal === undefined) throw new Error("Core manifest needs its rehearsal receipt");
  const entrypoints = await controlCoreEntrypoints(root);
  const environmentProfiles = await readEnvironmentProfiles({ repositoryRoot: root, environment });
  if (exclude.includes(CONTROL_CORE_CONFIG))
    throw new Error("The Core cannot be excluded from its train");
  const configs = new Set(environmentProfiles.map(({ config }) => config));
  if ([...also, ...exclude].some((config) => CONNECTION_BOOTSTRAP_CONFIGS.has(config)))
    throw new Error("Connection bootstrap profiles require the explicit staged activation train");
  if (environment === "production" && configs.has(PGCF_PRODUCTION_CONFIG)) {
    const bounded = environmentProfiles.find(({ config }) => config === PGCF_PRODUCTION_CONFIG);
    const full = environmentProfiles.find(({ config }) => config === FULL_PRODUCTION_CONFIG);
    const expectedName = "ohmyho-neon-management-production";
    if (
      bounded.configuration.name !== expectedName ||
      bounded.configuration.main !== "src/pgcf-worker-main.ts" ||
      !ACCOUNT.test(bounded.configuration.account_id ?? "") ||
      full?.configuration.name !== expectedName ||
      full.configuration.main !== "src/worker-main.ts" ||
      full.configuration.account_id !== bounded.configuration.account_id ||
      !full.configuration.services?.some(
        (service) => service.binding === "NATIVE_AUTH_RESOURCE_RUNTIME",
      )
    )
      throw new Error("The bounded PGCF and full Production Worker profiles do not match");
    if ([...also, ...exclude].includes(PGCF_PRODUCTION_CONFIG))
      throw new Error(
        "The bounded PGCF profile is a separate manual release, not a full train step",
      );
  }
  if (environment === "production" && configs.has(DOMAIN_KEYRING_PRODUCTION_CONFIG)) {
    const bounded = environmentProfiles.find(
      ({ config }) => config === DOMAIN_KEYRING_PRODUCTION_CONFIG,
    ).configuration;
    const full = environmentProfiles.find(
      ({ config }) => config === DOMAIN_FULL_PRODUCTION_CONFIG,
    )?.configuration;
    const native = ["NATIVE_AUTH_ADMIN_US", "NATIVE_AUTH_ADMIN_EU"];
    const existing = [
      "APPLICATION_IDENTITY_RUNTIME",
      "DEV_ACCESS",
      "GENERAL_CF_RUNTIME",
      "MAIL_DNS_RUNTIME",
      "RUNTIME_PROBES",
      "SCOPED_DNS_RUNTIME",
    ];
    const serviceFacts = (services) =>
      JSON.stringify(
        services
          .map((service) =>
            Object.fromEntries(Object.entries(service).sort(([a], [b]) => a.localeCompare(b))),
          )
          .sort((a, b) => a.binding.localeCompare(b.binding)),
      );
    if (
      bounded.name !== "ohmyho-cloudflare-domain-management-production" ||
      bounded.main !== "src/production-keyring-worker.ts" ||
      !ACCOUNT.test(bounded.account_id ?? "") ||
      full?.name !== bounded.name ||
      full.main !== "src/worker-main.ts" ||
      full.account_id !== bounded.account_id ||
      !Array.isArray(bounded.services) ||
      bounded.services.length !== existing.length ||
      !existing.every(
        (binding) =>
          bounded.services.filter((service) => service?.binding === binding).length === 1,
      ) ||
      !Array.isArray(full.services) ||
      full.services.length !== existing.length + native.length ||
      !native.every(
        (binding) => full.services.filter((service) => service?.binding === binding).length === 1,
      ) ||
      serviceFacts(bounded.services) !==
        serviceFacts(full.services.filter(({ binding }) => !native.includes(binding)))
    )
      throw new Error(
        "The bounded Domain keyring and full Production Worker profiles do not match",
      );
    if ([...also, ...exclude].includes(DOMAIN_KEYRING_PRODUCTION_CONFIG))
      throw new Error(
        "The bounded Domain keyring profile is a separate manual release, not a full train step",
      );
  }
  for (const config of [...also, ...exclude])
    if (!configs.has(config))
      throw new Error(`Unknown Worker configuration for this environment: ${config}`);
  if (exclude.some((config) => also.includes(config)))
    throw new Error("A Worker cannot be both included and excluded");
  const profileOf = (entry) =>
    Object.entries(PRIVATE_WORKER_PROFILES[environment]).find(
      ([, { name, config }]) => name === entry.configuration.name && config === entry.config,
    )?.[0];
  const excluded = new Set();
  for (const config of exclude) {
    const entry = environmentProfiles.find((profile) => profile.config === config);
    const mode = inspectControlCoreConsumer({
      configuration: entry.configuration,
      environment,
      entrypoints,
    }).mode;
    if (mode !== "d1") throw new Error("Only Core consumers can be excluded");
    if (profileOf(entry) !== undefined)
      throw new Error("A private creation profile cannot be excluded");
    const { name } = entry.configuration;
    if (typeof workerExists !== "function")
      throw new Error(`Core manifest needs the live presence of ${name}`);
    if (await workerExists(name))
      throw new Error(`${name} exists live: release it in the train instead of excluding it`);
    excluded.add(config);
  }
  const found = [];
  for (const entry of environmentProfiles) {
    if (
      entry.config === CONTROL_CORE_CONFIG ||
      isManualCoreProfile(entry.config, environment) ||
      excluded.has(entry.config)
    )
      continue;
    const mode = inspectControlCoreConsumer({
      configuration: entry.configuration,
      environment,
      entrypoints,
    }).mode;
    if (mode === "d1" || profileOf(entry) !== undefined || also.includes(entry.config))
      found.push(entry);
  }
  const previewProfile = PREVIEW_RUNTIME_PROFILES[environment],
    preview = found.find((entry) => entry.configuration.name === previewProfile.name),
    required = new Map();
  if (previewSecretsFile !== undefined && (!preview || !isAbsolute(previewSecretsFile)))
    throw new Error(
      "Preview Runtime secret input requires its included profile and an absolute private file path",
    );
  if (preview) {
    if (!isAbsolute(requireImagesDirectory(imagesDirectory)))
      throw new Error("Preview Runtime needs an absolute image receipts directory");
    const suffix = environment === "development" ? "poc-private-fullstack" : "production";
    const providers = [
      coreName,
      `ohmyho-source-fetcher-${suffix}`,
      `ohmyho-runtime-secret-delivery-${suffix}`,
      `ohmyho-neon-management-${suffix}`,
      ...["us", "eu"].flatMap((region) => [
        `ohmyho-project-database-${environment}-${region}`,
        `ohmyho-native-auth-${environment}-${region}`,
      ]),
    ];
    const control = `ohmyho-control-api-${suffix}`,
      gateway = `ohmyho-gateway-${suffix}`;
    // This closed cohort is mandatory even when Gateway has no direct Core binding.
    for (const name of [...providers, control, gateway]) {
      if (name === coreName || found.some((entry) => entry.configuration.name === name)) continue;
      const entry = environmentProfiles.find((candidate) => candidate.configuration.name === name);
      if (entry && excluded.has(entry.config))
        throw new Error("Preview Runtime cohort cannot exclude one of its providers or consumers");
      if (!entry) throw new Error("Preview Runtime cohort is missing a checked-in profile");
      found.push(entry);
    }
    required.set(preview.configuration.name, providers);
    required.set(control, [preview.configuration.name]);
    required.set(gateway, [preview.configuration.name, control]);
  }
  const creations = new Map();
  for (const entry of found) {
    const profile = profileOf(entry);
    if (profile === undefined) continue;
    if (typeof workerExists !== "function")
      throw new Error(`Core manifest needs the live presence of ${entry.configuration.name}`);
    if (!(await workerExists(entry.configuration.name)))
      creations.set(entry.configuration.name, { profile, creationId: randomUUID() });
  }
  const names = new Map(found.map((entry) => [entry.configuration.name, entry]));
  const wanted = (entry) =>
    [
      ...(entry.configuration.services ?? []).map(({ service }) => service),
      ...(entry.configuration.dispatch_namespaces ?? []).map(({ outbound }) => outbound?.service),
    ].filter((service) => names.has(service) && service !== entry.configuration.name);
  const mandatory = (entry) => required.get(entry.configuration.name) ?? [];
  const steps = [
    {
      id: "core",
      kind: "worker",
      config: CONTROL_CORE_CONFIG,
      configSha256: releaseHash(await readFile(join(root, CONTROL_CORE_CONFIG))),
      workerName: coreName,
      dependsOn: [],
      core: { databaseName: core.databaseName, databaseId: core.databaseId },
      ...(nativeAuthLaunchPolicy === undefined ? {} : { nativeAuthLaunchPolicy }),
    },
  ];
  const ids = new Map([[coreName, "core"]]);
  const pending = [...found];
  while (pending.length > 0) {
    // Existing service cycles can use already-live targets, but cannot bypass Preview's
    // provider/consumer order. Prefer callees and then Native within the eligible steps.
    const eligible = (entry) => mandatory(entry).every((service) => ids.has(service));
    const ready = pending.findIndex(
      (entry) => eligible(entry) && wanted(entry).every((service) => ids.has(service)),
    );
    const nativeCycle = pending.findIndex(
      (entry) =>
        eligible(entry) &&
        /^ohmyho-native-auth-(?:development|production)-(?:us|eu)$/u.test(entry.configuration.name),
    );
    const next = ready >= 0 ? ready : nativeCycle >= 0 ? nativeCycle : pending.findIndex(eligible);
    if (next < 0) throw new Error("Preview Runtime cohort release order cannot be satisfied");
    const entry = pending.splice(next, 1)[0];
    const id = stepId(entry.config);
    ids.set(entry.configuration.name, id);
    steps.push({
      id,
      kind: "worker",
      config: entry.config,
      configSha256: releaseHash(entry.bytes),
      workerName: entry.configuration.name,
      dependsOn: [
        ...new Set([
          "core",
          ...mandatory(entry).map((service) => ids.get(service)),
          ...wanted(entry)
            .map((service) => ids.get(service))
            .filter(Boolean),
        ]),
      ],
      ...(entry.configuration.containers === undefined
        ? {}
        : { containerImages: join(requireImagesDirectory(imagesDirectory), `${id}.json`) }),
      ...(entry === preview && previewSecretsFile !== undefined
        ? { secretsFile: previewSecretsFile }
        : {}),
      ...(creations.has(entry.configuration.name)
        ? { action: "create_private", ...creations.get(entry.configuration.name) }
        : {}),
    });
  }
  const manifest = {
    schemaVersion: 1,
    sourceCommit,
    environment,
    accountId,
    rehearsal,
    ...(developmentReference === undefined ? {} : { developmentReference }),
    steps,
  };
  validateTrainManifest(manifest);
  await assertPolicyStepConfigs({ manifest, repositoryRoot: root });
  return manifest;
}

/** A Worker with containers is planned only with the directory of its built images. */
function requireImagesDirectory(imagesDirectory) {
  if (imagesDirectory === undefined)
    throw new Error("A Worker with containers needs the --images directory");
  return imagesDirectory;
}

const MANIFEST_FLAGS = new Set([
  "--environment",
  "--output",
  "--rehearsal",
  "--images",
  "--also",
  "--exclude",
  "--development-manifest",
  "--development-state",
  "--native-auth-launch-policy",
  "--preview-secrets",
]);
const MANIFEST_USAGE =
  "Usage: control-core-manifest.mjs --environment <name> --output <file> --rehearsal <file> [--images <dir>] [--also <configs>] [--exclude <configs>] [--development-manifest <file> --development-state <file>] [--native-auth-launch-policy <private-json>] [--preview-secrets <private-file>]";

/** The command-line flags as a map: pairs of a known flag and its value, no flag twice, no value that is a flag. */
export function parseManifestArguments(argv) {
  if (argv.length % 2 !== 0) throw new Error(MANIFEST_USAGE);
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!MANIFEST_FLAGS.has(flag) || flags.has(flag) || value.startsWith("--"))
      throw new Error(MANIFEST_USAGE);
    flags.set(flag, value);
  }
  if (!flags.has("--output") || !flags.has("--rehearsal")) throw new Error(MANIFEST_USAGE);
  return flags;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const flags = parseManifestArguments(process.argv.slice(2));
    const environment = flags.get("--environment");
    const output = resolve(flags.get("--output"));
    const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    await requirePrivateReleaseDirectory(resolve(output, ".."), repositoryRoot);
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const exclude = (flags.get("--exclude") ?? "").split(",").filter(Boolean);
    const resource = await observeFixedCore({ accountId, environment });
    const reference = ["--development-manifest", "--development-state"].map((flag) =>
      flags.get(flag) === undefined ? undefined : resolve(flags.get(flag)),
    );
    if (reference.filter(Boolean).length === 1)
      throw new Error("--development-manifest and --development-state go together");
    const manifest = await buildCoreTrainManifest({
      repositoryRoot,
      environment,
      accountId,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      core: { databaseName: resource.databaseName, databaseId: resource.databaseId },
      rehearsal: resolve(flags.get("--rehearsal")),
      imagesDirectory:
        flags.get("--images") === undefined ? undefined : resolve(flags.get("--images")),
      also: (flags.get("--also") ?? "").split(",").filter(Boolean),
      exclude,
      ...(flags.get("--preview-secrets") === undefined
        ? {}
        : { previewSecretsFile: resolve(flags.get("--preview-secrets")) }),
      ...(flags.get("--native-auth-launch-policy") === undefined
        ? {}
        : {
            nativeAuthLaunchPolicy: (
              await readPrivateReleaseJson(resolve(flags.get("--native-auth-launch-policy")))
            ).value,
          }),
      workerExists: providerWorkerExists({ accountId, token: process.env.CLOUDFLARE_API_TOKEN }),
      ...(reference[0] === undefined
        ? {}
        : { developmentReference: { manifest: reference[0], state: reference[1] } }),
    });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({
        output: basename(output),
        steps: manifest.steps.map(({ id, dependsOn }) => `${id}<-${dependsOn.join("+") || "-"}`),
        creates: manifest.steps
          .filter(({ action }) => action === "create_private")
          .map(({ id }) => id),
        excluded: exclude,
      }),
    );
  } catch (error) {
    console.error(String(error?.message ?? "Core manifest command failed").slice(0, 200));
    process.exitCode = 1;
  }
}
