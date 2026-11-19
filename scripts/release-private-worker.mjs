/* global AbortSignal */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseJsonc,
  parseObject,
  readDeployment,
  workerReleaseIdentity,
} from "./platform-release.mjs";
import { validateWorkerRehearsal } from "./release-rehearsal-artifacts.mjs";
import { observeWorkerCommand, readBearerToken } from "./release-worker-presence.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { isControlCoreStep } from "./control-core-train.mjs";

/**
 * Creation of a selected private credit-service or connection-broker Worker. The checked-in profile map is the only
 * authority for its name, config, capabilities, schedules and service and bucket targets; nothing in a
 * manifest can widen it. Ordinary Worker updates stay in platform-release.mjs.
 */
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
// Preserve the exact old provenance of already approved creations without accepting other drift.
const matchesReleaseMessage = (actual, expected) =>
  actual === expected ||
  (typeof expected === "string" &&
    expected.startsWith("source ") &&
    actual === expected.replace(/^source /u, "origin/main "));
const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,99}$/u;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, allowed, required) =>
  object(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const by = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const byName = by("name");
const byBinding = by("binding");

export const PRIVATE_WORKER_PROFILES = Object.freeze({
  development: Object.freeze({
    connection_broker: Object.freeze({
      name: "ohmyho-connection-broker-development",
      config: "apps/connection-broker/wrangler.bootstrap.development.jsonc",
    }),
    credit_service: Object.freeze({
      name: "ohmyho-credit-service-poc-private-fullstack",
      config: "apps/credit-service/wrangler.development.jsonc",
    }),
  }),
  production: Object.freeze({
    connection_broker: Object.freeze({
      name: "ohmyho-connection-broker-production",
      config: "apps/connection-broker/wrangler.bootstrap.production.jsonc",
    }),
    credit_service: Object.freeze({
      name: "ohmyho-credit-service-production",
      config: "apps/credit-service/wrangler.production.jsonc",
    }),
  }),
});

const PROVIDER_USAGE = Object.freeze({
  development: Object.freeze([
    Object.freeze({
      binding: "NEON_USAGE",
      service: "ohmyho-neon-management-poc-private-fullstack",
      entrypoint: "NeonUsageService",
    }),
    Object.freeze({
      binding: "R2_USAGE",
      service: "ohmyho-r2-management-poc-private-fullstack",
      entrypoint: "R2ManagementService",
    }),
  ]),
  production: Object.freeze([
    Object.freeze({
      binding: "NEON_USAGE",
      service: "ohmyho-neon-management-production",
      entrypoint: "NeonUsageService",
    }),
    Object.freeze({
      binding: "R2_USAGE",
      service: "ohmyho-r2-management-production",
      entrypoint: "R2ManagementService",
    }),
  ]),
});

// Capabilities per profile. The credit-service owns no secret. It reaches the
// Core only through the environment's `CreditRuntime` entrypoint, the two provider collectors through
// their named entrypoints and two EU R2 buckets (the Logpush usage logs and the rotated credit log).
// Its crons are the usage passes at minutes 27 and 57 and the daily log rotation, kept sorted like the provider's list.
// Names and entrypoints stay literal and exact for each environment.
const CONTRACTS = Object.freeze({
  connection_broker: Object.freeze({
    crons: Object.freeze(["*/5 * * * *"]),
    services: (environment) => [
      {
        binding: "CONNECTION_CORE",
        service: CONTROL_CORE_WORKER_PROFILES[environment],
        entrypoint: "ConnectionBrokerRuntime",
      },
      {
        binding: "CONNECTION_AUTHORITY",
        service: PROTECTED_CONTROL[environment].name,
        entrypoint: "ConnectionAuthorityService",
      },
      {
        binding: "CONNECTION_MAINTENANCE",
        service: CONTROL_CORE_WORKER_PROFILES[environment],
        entrypoint: "ConnectionBrokerMaintenanceRuntime",
      },
    ],
    buckets: () => [],
  }),
  credit_service: Object.freeze({
    crons: Object.freeze(["0 0 * * *", "27,57 * * * *"]),
    services: (environment) => [
      {
        binding: "CREDIT_RUNTIME",
        service: CONTROL_CORE_WORKER_PROFILES[environment],
        entrypoint: "CreditRuntime",
      },
      ...PROVIDER_USAGE[environment],
    ],
    buckets: (environment) => [
      { binding: "USAGE_LOGS", bucket_name: `ohmyho-usage-${environment}`, jurisdiction: "eu" },
      {
        binding: "CREDIT_LOG",
        bucket_name: `ohmyho-credit-log-${environment}`,
        jurisdiction: "eu",
      },
    ],
  }),
});

const PROFILE_NAMES = Object.freeze(Object.keys(CONTRACTS));

/** The environment's Control Worker is observed as protected whenever a creation is present. */
export const PROTECTED_CONTROL = Object.freeze({
  development: Object.freeze({
    name: "ohmyho-control-api-poc-private-fullstack",
    config: "apps/control-api/wrangler.jsonc",
  }),
  production: Object.freeze({
    name: "ohmyho-control-api-production",
    config: "apps/control-api/wrangler.production.jsonc",
  }),
});

export const isPrivateWorkerStep = (step) =>
  step?.kind === "worker" && step.action === "create_private";

/** These regional runtimes use normal release receipts and the same private creation transition as Core. */
export const isNativeRegionalWorkerStep = (step) =>
  step?.kind === "worker" &&
  /^ohmyho-native-auth-(?:development|production)-(?:us|eu)$/u.test(step.workerName ?? "");

export const PREVIEW_RUNTIME_PROFILES = Object.freeze({
  development: Object.freeze({
    name: "ohmyho-live-preview-poc-private-fullstack",
    config: "apps/preview-runtime/wrangler.development.jsonc",
    cron: "*/1 * * * *",
    suffix: "preview.dev.omh.st",
  }),
  production: Object.freeze({
    name: "ohmyho-live-preview-production",
    config: "apps/preview-runtime/wrangler.production.jsonc",
    cron: "*/1 * * * *",
    suffix: "preview.omh.st",
  }),
});
/** Only these two exact names can take the Preview absent-to-private transition. */
export const isPreviewRuntimeWorkerStep = (step) =>
  step?.kind === "worker" &&
  Object.values(PREVIEW_RUNTIME_PROFILES).some((profile) => profile.name === step.workerName);
export function validatePreviewRuntimeStep(step, environment) {
  const profile = PREVIEW_RUNTIME_PROFILES[environment];
  if (
    !profile ||
    step.workerName !== profile.name ||
    step.config !== profile.config ||
    step.action !== undefined ||
    !isAbsolute(step.containerImages ?? "")
  )
    throw new Error("Preview Runtime step is outside its closed profile");
  return profile;
}
/** Exact preview services and data resources; no route or unrelated binding may be introduced. */
export function validatePreviewRuntimeConfiguration({
  environment,
  configuration,
  repositoryRoot,
}) {
  const profile = PREVIEW_RUNTIME_PROFILES[environment],
    c = configuration,
    refuse = () => {
      throw new Error("Preview Runtime configuration is outside its closed capability profile");
    };
  const suffix = environment === "development" ? "poc-private-fullstack" : "production";
  const expectedServices = [
    ["PREVIEW_AUTHORITY", `ohmyho-control-store-${suffix}`, "ProjectPreviewRuntime"],
    ["PREVIEW_USAGE_REPORTER", `ohmyho-control-store-${suffix}`, "PreviewUsageReporterRuntime"],
    ["PREVIEW_SOURCE", `ohmyho-source-fetcher-${suffix}`, "SourceFetcherService"],
    [
      "PREVIEW_RUNTIME_SECRETS",
      `ohmyho-runtime-secret-delivery-${suffix}`,
      "RuntimeSecretDeliveryPreview",
    ],
    ...["us", "eu"].flatMap((region) => [
      [
        `DATABASE_PREVIEW_${region.toUpperCase()}`,
        `ohmyho-project-database-${environment}-${region}`,
        "ProjectDatabasePreview",
      ],
      [
        `NATIVE_PREVIEW_${region.toUpperCase()}`,
        `ohmyho-native-auth-${environment}-${region}`,
        "NativeProductPreviewService",
      ],
    ]),
    [
      "PREVIEW_NATIVE_PREPARATION",
      `ohmyho-neon-management-${suffix}`,
      "PreviewNativePreparationService",
    ],
  ].map(([binding, service, entrypoint]) => ({ binding, service, entrypoint }));
  const exact = (a, b) =>
    Array.isArray(a) && isDeepStrictEqual([...a].sort(byBinding), [...b].sort(byBinding));
  const allowed = [
    "$schema",
    "name",
    "account_id",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "vars",
    "secrets",
    "services",
    "r2_buckets",
    "durable_objects",
    "migrations",
    "containers",
    "triggers",
    "observability",
  ];
  if (
    !profile ||
    !within(c, allowed) ||
    c.name !== profile.name ||
    !ACCOUNT.test(c.account_id ?? "") ||
    typeof c.main !== "string" ||
    !c.main ||
    c.compatibility_date !== "2026-11-11" ||
    !isDeepStrictEqual(c.compatibility_flags, ["nodejs_compat"]) ||
    c.workers_dev !== false ||
    c.preview_urls !== false ||
    !isDeepStrictEqual(c.vars, {
      PREVIEW_HOST_SUFFIX: profile.suffix,
      CLOUDFLARE_ACCOUNT_ID: c.account_id,
      PREVIEW_CONTAINER_APPLICATION_NAME: profile.name,
    }) ||
    !isDeepStrictEqual(c.secrets, { required: ["CLOUDFLARE_PREVIEW_USAGE_TOKEN"] }) ||
    !isDeepStrictEqual(c.triggers, { crons: [profile.cron] }) ||
    !exact(c.services, expectedServices) ||
    !exact(c.r2_buckets, [
      { binding: "BACKUP_BUCKET", bucket_name: `ohmyho-live-preview-backups-${environment}` },
    ]) ||
    !isDeepStrictEqual(c.durable_objects, {
      bindings: [{ name: "PREVIEW_CONTAINERS", class_name: "PreviewSandbox" }],
    }) ||
    !isDeepStrictEqual(c.migrations, [{ tag: "v1", new_sqlite_classes: ["PreviewSandbox"] }]) ||
    !Array.isArray(c.containers) ||
    c.containers.length !== 1
  )
    refuse();
  const container = c.containers[0];
  if (
    !fields(
      container,
      ["name", "class_name", "scheduling_policy", "images"],
      ["name", "class_name", "scheduling_policy", "images"],
    ) ||
    container.name !== profile.name ||
    container.class_name !== "PreviewSandbox" ||
    container.scheduling_policy !== "durable_object" ||
    !fields(container.images, ["preview"], ["preview"]) ||
    !fields(
      container.images.preview,
      ["dockerfile", "build_context"],
      ["dockerfile", "build_context"],
    )
  )
    refuse();
  const image = container.images.preview;
  const expectedMain =
    repositoryRoot === undefined
      ? "src/worker-main.ts"
      : resolve(repositoryRoot, "apps/preview-runtime/src/worker-main.ts");
  if (c.main !== expectedMain) refuse();
  const expectedDockerfile =
    repositoryRoot === undefined
      ? "./container/Dockerfile"
      : resolve(repositoryRoot, "apps/preview-runtime/container/Dockerfile");
  const expectedContext = repositoryRoot === undefined ? "../.." : resolve(repositoryRoot);
  if (image.dockerfile !== expectedDockerfile || image.build_context !== expectedContext) refuse();
  if (
    c.observability !== undefined &&
    (!within(c.observability, ["enabled", "head_sampling_rate"]) ||
      typeof c.observability.enabled !== "boolean" ||
      typeof c.observability.head_sampling_rate !== "number" ||
      c.observability.head_sampling_rate < 0 ||
      c.observability.head_sampling_rate > 1)
  )
    refuse();
  return profile;
}
/** Preview's exact providers must precede it; its consumers must follow it. */
export function validatePreviewRuntimeTrain(manifest, ancestors) {
  const previews = manifest.steps.filter(isPreviewRuntimeWorkerStep);
  if (previews.length === 0) return;
  if (previews.length !== 1) throw new Error("Preview Runtime must appear exactly once");
  const preview = previews[0],
    env = manifest.environment,
    suffix = env === "development" ? "poc-private-fullstack" : "production";
  validatePreviewRuntimeStep(preview, env);
  const byName = new Map(
    manifest.steps.filter((s) => s.kind === "worker").map((s) => [s.workerName, s]),
  );
  const providers = [
    `ohmyho-control-store-${suffix}`,
    `ohmyho-source-fetcher-${suffix}`,
    `ohmyho-runtime-secret-delivery-${suffix}`,
    `ohmyho-neon-management-${suffix}`,
    ...["us", "eu"].flatMap((region) => [
      `ohmyho-project-database-${env}-${region}`,
      `ohmyho-native-auth-${env}-${region}`,
    ]),
  ];
  const consumers = [`ohmyho-control-api-${suffix}`, `ohmyho-gateway-${suffix}`];
  if (
    providers.some(
      (name) => !byName.has(name) || !ancestors.get(preview.id).has(byName.get(name).id),
    ) ||
    consumers.some(
      (name) => !byName.has(name) || !ancestors.get(byName.get(name).id).has(preview.id),
    )
  )
    throw new Error(
      "Preview Runtime requires Core and providers before it, then Control and Gateway",
    );
}

export function privateWorkerDefinition({ environment, profile }) {
  if (
    !Object.hasOwn(PRIVATE_WORKER_PROFILES, environment) ||
    !Object.hasOwn(PRIVATE_WORKER_PROFILES[environment], profile)
  )
    throw new Error("Private Worker profile is not part of the closed profile map");
  return Object.freeze({
    ...PRIVATE_WORKER_PROFILES[environment][profile],
    ...CONTRACTS[profile],
    profile,
    environment,
  });
}

/** Rehearsal has no environment of its own, so the step's profile, name and config select it. */
export function resolvePrivateWorkerProfile(step) {
  for (const environment of Object.keys(PRIVATE_WORKER_PROFILES)) {
    if (!Object.hasOwn(PRIVATE_WORKER_PROFILES[environment], step.profile)) continue;
    const definition = privateWorkerDefinition({ environment, profile: step.profile });
    if (definition.name === step.workerName && definition.config === step.config) return definition;
  }
  throw new Error("Private Worker step is outside the closed profile map");
}

export function validatePrivateWorkerStep(step, environment) {
  const definition = privateWorkerDefinition({ environment, profile: step.profile });
  if (
    step.action !== "create_private" ||
    !UUID.test(step.creationId ?? "") ||
    step.workerName !== definition.name ||
    step.config !== definition.config ||
    Object.hasOwn(step, "containerImages") ||
    Object.hasOwn(step, "secretsFile")
  )
    throw new Error("Private Worker creation step is outside its closed profile");
  return definition;
}

/**
 * A creation train creates each selected closed profile at most once, after the environment's Core step.
 */
export function validatePrivateWorkerTrain(manifest, ancestors) {
  const created = manifest.steps.filter(isPrivateWorkerStep);
  const reference = manifest.developmentReference;
  const preview = manifest.steps.some(isPreviewRuntimeWorkerStep);
  if (created.length === 0 && !preview) {
    if (reference !== undefined)
      throw new Error("A Development creation reference needs a creation");
    return;
  }
  const core = manifest.steps.find(isControlCoreStep);
  if (
    created.length > 0 &&
    (created.some(
      ({ profile }) => !Object.hasOwn(PRIVATE_WORKER_PROFILES[manifest.environment], profile),
    ) ||
      new Set(created.map(({ profile }) => profile)).size !== created.length ||
      new Set(created.map(({ creationId }) => creationId)).size !== created.length ||
      core === undefined ||
      created.some(({ id }) => !ancestors.get(id).has(core.id)))
  )
    throw new Error(
      "Private Worker creation requires unique selected closed profiles after the Core",
    );
  if (
    (manifest.environment === "production") !== (reference !== undefined) ||
    (reference !== undefined &&
      (!fields(reference, ["manifest", "state"], ["manifest", "state"]) ||
        !isAbsolute(reference.manifest) ||
        !isAbsolute(reference.state)))
  )
    throw new Error(
      "Production creation requires a private completed Development creation reference",
    );
}

const CONFIG_KEYS = Object.freeze([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "observability",
  "vars",
  "triggers",
  "account_id",
  "placement",
  "limits",
  "services",
  "r2_buckets",
  "version_metadata",
]);
const jsonValue = (value) =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (value !== null &&
    typeof value === "object" &&
    isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value));
const within = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));

/**
 * Closed capability profile for one authored (or rehearsal-reused) configuration. Unknown keys are
 * refused rather than assumed harmless: any resource, route, binding or trigger not named here
 * would widen the Worker beyond this reviewed profile.
 */
export function validatePrivateWorkerConfiguration({
  environment,
  profile,
  configuration,
  rehearsed = false,
}) {
  const definition = privateWorkerDefinition({ environment, profile });
  const refuse = () => {
    throw new Error("Private Worker configuration is outside its closed capability profile");
  };
  const allowed = rehearsed ? [...CONFIG_KEYS, "no_bundle"] : CONFIG_KEYS;
  const c = configuration;
  if (
    !within(c, allowed) ||
    (Object.hasOwn(c, "no_bundle") && c.no_bundle !== true) ||
    c.name !== definition.name ||
    typeof c.main !== "string" ||
    c.main.length === 0 ||
    (c.$schema !== undefined && typeof c.$schema !== "string") ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(c.compatibility_date ?? "") ||
    c.workers_dev !== false ||
    c.preview_urls !== false ||
    !ACCOUNT.test(c.account_id ?? "")
  )
    refuse();
  const flags = c.compatibility_flags;
  if (
    flags !== undefined &&
    (!Array.isArray(flags) ||
      new Set(flags).size !== flags.length ||
      flags.some((flag) => !/^[a-z][a-z0-9_]*$/u.test(flag ?? "")))
  )
    refuse();
  const observability = c.observability;
  if (
    observability !== undefined &&
    (!within(observability, ["enabled", "head_sampling_rate", "logs"]) ||
      (observability.enabled !== undefined && typeof observability.enabled !== "boolean") ||
      (observability.head_sampling_rate !== undefined &&
        !(
          typeof observability.head_sampling_rate === "number" &&
          observability.head_sampling_rate >= 0 &&
          observability.head_sampling_rate <= 1
        )) ||
      (observability.logs !== undefined &&
        !within(observability.logs, [
          "enabled",
          "head_sampling_rate",
          "persist",
          "invocation_logs",
        ])))
  )
    refuse();
  if (
    c.placement !== undefined &&
    (!within(c.placement, ["region"]) ||
      !/^(?:aws|gcp|azure):[a-z0-9-]+$/u.test(c.placement.region))
  )
    refuse();
  if (
    c.limits !== undefined &&
    (!within(c.limits, ["cpu_ms"]) ||
      !Number.isInteger(c.limits.cpu_ms) ||
      c.limits.cpu_ms < 1 ||
      c.limits.cpu_ms > 300_000)
  )
    refuse();
  if (
    c.version_metadata !== undefined &&
    (!fields(c.version_metadata, ["binding"], ["binding"]) ||
      !BINDING_NAME.test(c.version_metadata.binding ?? ""))
  )
    refuse();
  if (
    profile === "connection_broker" &&
    (!within(
      c,
      rehearsed
        ? [
            "$schema",
            "name",
            "main",
            "compatibility_date",
            "compatibility_flags",
            "workers_dev",
            "preview_urls",
            "observability",
            "vars",
            "triggers",
            "account_id",
            "services",
            "r2_buckets",
            "no_bundle",
          ]
        : [
            "$schema",
            "name",
            "main",
            "compatibility_date",
            "compatibility_flags",
            "workers_dev",
            "preview_urls",
            "observability",
            "vars",
            "triggers",
            "account_id",
            "services",
            "r2_buckets",
          ],
    ) ||
      c.compatibility_date !== "2026-11-01" ||
      !isDeepStrictEqual(c.compatibility_flags, ["enable_request_signal"]) ||
      !isDeepStrictEqual(c.observability, { enabled: false }) ||
      !isDeepStrictEqual(c.vars, {
        PLATFORM_ENVIRONMENT: environment,
        MAKE_OAUTH_ENABLED: "true",
        MAKE_DISCOVERY_ENABLED: "true",
      }))
  )
    refuse();
  const services = definition.services(environment);
  const buckets = definition.buckets(environment);
  const reserved = [
    ...services.map(({ binding }) => binding),
    ...buckets.map(({ binding }) => binding),
    ...(c.version_metadata === undefined ? [] : [c.version_metadata.binding]),
  ];
  if (
    c.vars !== undefined &&
    (!object(c.vars) ||
      Object.entries(c.vars).some(
        ([name, value]) => !BINDING_NAME.test(name) || reserved.includes(name) || !jsonValue(value),
      ))
  )
    refuse();
  // Declared lists are compared as sets: the provider reports crons sorted and bindings by name.
  const exact = (declared, expected, order) =>
    Array.isArray(declared) &&
    declared.every(object) &&
    isDeepStrictEqual([...declared].sort(order), [...expected].sort(order));
  if (
    !fields(c.triggers, ["crons"], ["crons"]) ||
    !Array.isArray(c.triggers.crons) ||
    !isDeepStrictEqual([...c.triggers.crons].sort(), definition.crons)
  )
    refuse();
  if (!exact(c.services, services, byBinding) || !exact(c.r2_buckets, buckets, byBinding)) refuse();
  return definition;
}

/** The sorted, exact, unique-name set of bindings one version of this profile must carry. */
export function privateWorkerBindingInventory({ environment, profile, configuration }) {
  const definition = privateWorkerDefinition({ environment, profile });
  const inventory = [];
  for (const [name, value] of Object.entries(configuration.vars ?? {}))
    inventory.push(
      typeof value === "string"
        ? { name, type: "plain_text", text: value }
        : { name, type: "json", json: value },
    );
  if (configuration.version_metadata !== undefined)
    inventory.push({ name: configuration.version_metadata.binding, type: "version_metadata" });
  for (const service of definition.services(environment))
    inventory.push({
      name: service.binding,
      type: "service",
      service: service.service,
      entrypoint: service.entrypoint ?? "default",
    });
  for (const bucket of definition.buckets(environment))
    inventory.push({
      name: bucket.binding,
      type: "r2_bucket",
      bucket_name: bucket.bucket_name,
      jurisdiction: bucket.jurisdiction,
    });
  inventory.sort(byName);
  if (new Set(inventory.map(({ name }) => name)).size !== inventory.length)
    throw new Error("Private Worker binding names are not unique");
  return inventory;
}

const BINDING_KEYS = Object.freeze({
  plain_text: ["name", "type", "text"],
  json: ["name", "type", "json"],
  secret_text: ["name", "type"],
  version_metadata: ["name", "type"],
  service: ["name", "type", "service", "environment", "entrypoint"],
  r2_bucket: ["name", "type", "bucket_name", "jurisdiction"],
});

function normalizeObservedBinding(binding) {
  const refuse = () => {
    throw new Error("Private Worker bindings differ from the closed inventory");
  };
  if (
    !object(binding) ||
    typeof binding.name !== "string" ||
    !Object.hasOwn(BINDING_KEYS, binding.type) ||
    Object.keys(binding).some((key) => !BINDING_KEYS[binding.type].includes(key))
  )
    refuse();
  const { name, type } = binding;
  if (type === "plain_text") {
    if (typeof binding.text !== "string") refuse();
    return { name, type, text: binding.text };
  }
  if (type === "json") {
    if (!Object.hasOwn(binding, "json")) refuse();
    return { name, type, json: binding.json };
  }
  if (type === "service") {
    // An omitted entrypoint and "default" are one provider identity; a named RPC entrypoint is not.
    if (
      typeof binding.service !== "string" ||
      (binding.environment !== undefined && binding.environment !== "production") ||
      ![
        undefined,
        null,
        "default",
        "NeonManagementService",
        "NeonUsageService",
        "R2ManagementService",
        "CreditRuntime",
        "ConnectionBrokerRuntime",
        "ConnectionBrokerMaintenanceRuntime",
        "ConnectionAuthorityService",
      ].includes(binding.entrypoint)
    )
      refuse();
    return { name, type, service: binding.service, entrypoint: binding.entrypoint ?? "default" };
  }
  if (type === "r2_bucket") {
    if (
      typeof binding.bucket_name !== "string" ||
      (binding.jurisdiction !== undefined && typeof binding.jurisdiction !== "string")
    )
      refuse();
    return { name, type, bucket_name: binding.bucket_name, jurisdiction: binding.jurisdiction };
  }
  return { name, type };
}

/** Names alone are not value proof; plain values and service identities are compared exactly. */
export function verifyExactVersionBindings({ inventory, bindings }) {
  if (!Array.isArray(bindings) || bindings.length !== inventory.length)
    throw new Error("Private Worker bindings differ from the closed inventory");
  const observed = bindings.map(normalizeObservedBinding).sort(byName);
  if (!isDeepStrictEqual(observed, inventory))
    throw new Error("Private Worker bindings differ from the closed inventory");
}

/** The creation identity a rehearsal fixes for one private Worker. */
export function privateWorkerEvidence({ step }) {
  resolvePrivateWorkerProfile(step);
  return { profile: step.profile, creationId: step.creationId };
}

export function validatePrivateWorkerEvidence(value) {
  const keys = ["profile", "creationId"];
  if (
    !fields(value, keys, keys) ||
    !PROFILE_NAMES.includes(value.profile) ||
    !UUID.test(value.creationId ?? "")
  )
    throw new Error("Worker rehearsal private profile is invalid");
}

/** Everything the immutable preparation fixes about one creation, derived once. */
export function describePrivateWorker({
  step,
  environment,
  sourceCommit,
  configuration,
  reused,
  proof,
}) {
  validatePrivateWorkerStep(step, environment);
  validatePrivateWorkerConfiguration({ environment, profile: step.profile, configuration });
  validatePrivateWorkerConfiguration({
    environment,
    profile: step.profile,
    configuration: reused,
    rehearsed: true,
  });
  const evidence = privateWorkerEvidence({ step });
  const inventory = privateWorkerBindingInventory({
    environment,
    profile: step.profile,
    configuration: reused,
  });
  const { tag, message } = workerReleaseIdentity({
    sha: sourceCommit,
    configuration: reused,
    artifact: null,
    rehearsal: proof,
    creationId: step.creationId,
  });
  return Object.freeze({
    evidence,
    accountId: configuration.account_id,
    inventory,
    bindingsSha256: digest(JSON.stringify(inventory)),
    tag,
    message,
    configurationSha256: digest(JSON.stringify(configuration)),
    proofSha256: digest(JSON.stringify(proof)),
  });
}

export async function protectedControlIdentity({ environment, repositoryRoot, accountId }) {
  if (!Object.hasOwn(PROTECTED_CONTROL, environment))
    throw new Error("Protected Control environment is invalid");
  const control = PROTECTED_CONTROL[environment];
  const path = resolve(repositoryRoot, control.config);
  const offset = relative(await realpath(repositoryRoot), await realpath(path));
  if (offset.startsWith("../") || isAbsolute(offset))
    throw new Error("Protected Control configuration leaves the repository");
  const bytes = await readFile(path);
  let configuration;
  try {
    configuration = parseJsonc(bytes.toString("utf8"));
  } catch {
    throw new Error("Protected Control configuration is unavailable");
  }
  if (configuration?.name !== control.name || configuration.account_id !== accountId)
    throw new Error("Protected Control configuration differs from its canonical Worker");
  return Object.freeze({
    workerName: control.name,
    config: control.config,
    configSha256: digest(bytes),
  });
}

export const protectedControlName = (environment) => PROTECTED_CONTROL[environment].name;

// ---- Durable creation progress -------------------------------------------------------------

const PHASES = Object.freeze(["prepared", "creating", "activating"]);

/** The immutable facts every persisted progress record is bound to. */
export function creationBinding({ approvalSha256, sourceCommit, step, described }) {
  return {
    approvalSha256,
    accountId: described.accountId,
    workerName: step.workerName,
    profile: step.profile,
    creationId: step.creationId,
    sourceCommit,
    configurationSha256: described.configurationSha256,
    proofSha256: described.proofSha256,
    bindingsSha256: described.bindingsSha256,
    tag: described.tag,
    message: described.message,
  };
}

export function validateCreationProgress(progress, binding) {
  const base = Object.keys(binding);
  const dynamic = ["phase", "originalPresence", "uploadAttempted", "versionId", "cronAttempted"];
  if (
    !fields(
      progress,
      [...base, ...dynamic],
      [...base, "phase", "originalPresence", "uploadAttempted"],
    ) ||
    base.some((key) =>
      key === "message"
        ? !matchesReleaseMessage(progress[key], binding[key])
        : progress[key] !== binding[key],
    ) ||
    !PHASES.includes(progress.phase) ||
    !isDeepStrictEqual(progress.originalPresence, {
      kind: "absent",
      accountId: binding.accountId,
      workerName: binding.workerName,
    }) ||
    progress.uploadAttempted !== (progress.phase !== "prepared") ||
    (progress.phase === "activating") !== (progress.versionId !== undefined) ||
    (progress.phase === "activating"
      ? typeof progress.cronAttempted !== "boolean" ||
        (CONTRACTS[progress.profile].crons.length === 0 && progress.cronAttempted)
      : progress.cronAttempted !== undefined) ||
    (progress.versionId !== undefined && !UUID.test(progress.versionId))
  )
    throw new Error("Private Worker creation progress is invalid or differs from its approval");
}

/** Progress only moves forward and never rewrites the bound facts or the original absent baseline. */
export function assertForwardProgress(previous, next) {
  if (previous === undefined) return;
  const bound = (progress) =>
    Object.entries(progress).filter(
      ([key]) => !["phase", "uploadAttempted", "versionId", "cronAttempted"].includes(key),
    );
  if (
    PHASES.indexOf(next.phase) < PHASES.indexOf(previous.phase) ||
    !isDeepStrictEqual(bound(previous), bound(next)) ||
    (previous.cronAttempted === true && next.cronAttempted !== true) ||
    (previous.versionId !== undefined && previous.versionId !== next.versionId)
  )
    throw new Error("Private Worker creation progress cannot roll back or change");
}

const RECEIPT_FIELDS = Object.freeze([
  "bindingsSha256",
  "creationId",
  "cronTriggers",
  "crons",
  "deploymentVerified",
  "ingress",
  "message",
  "profile",
  "sha",
  "tag",
  "versionId",
  "workerName",
]);

export function validatePrivateWorkerReceipt(receipt, step, sha) {
  const definition = resolvePrivateWorkerProfile(step);
  if (
    !fields(receipt, RECEIPT_FIELDS, RECEIPT_FIELDS) ||
    receipt.creationId !== step.creationId ||
    receipt.profile !== step.profile ||
    receipt.workerName !== step.workerName ||
    receipt.sha !== sha ||
    receipt.deploymentVerified !== true ||
    !UUID.test(receipt.versionId ?? "") ||
    typeof receipt.tag !== "string" ||
    typeof receipt.message !== "string" ||
    !HASH.test(receipt.bindingsSha256 ?? "") ||
    !["unchanged", "updated"].includes(receipt.cronTriggers) ||
    !isDeepStrictEqual(receipt.crons, definition.crons) ||
    !isDeepStrictEqual(receipt.ingress, { workersDev: false, previewUrls: false })
  )
    throw new Error("Worker release receipt is invalid");
}

// ---- Closed absent-to-declared ingress transition ------------------------------------------

export const isAbsentEntry = (entry, accountId) =>
  fields(
    entry?.presence,
    ["kind", "accountId", "workerName"],
    ["kind", "accountId", "workerName"],
  ) &&
  entry?.presence?.kind === "absent" &&
  entry.presence.accountId === accountId &&
  entry.presence.workerName === entry.workerName &&
  Object.keys(entry).length === 2;

/** A first attempt only starts from confirmed absence; any preexisting Worker is a collision. */
export function requireInitialAbsence({ observation, manifest }) {
  for (const step of manifest.steps.filter(isPrivateWorkerStep))
    if (
      !isAbsentEntry(
        observation.workers.find(({ workerName }) => workerName === step.workerName),
        manifest.accountId,
      )
    )
      throw new Error("Private Worker creation collides with an existing Worker");
}

/**
 * Every protected Worker, domain and route must equal the original baseline. Only the creation
 * entry may differ, from absent to its declared private shape, and only under durable progress
 * (or a completed step) that proves this train started the creation.
 */
export function closedTransition({ baseline, observation, manifest, steps }) {
  const names = (value) => value.workers.map(({ workerName }) => workerName);
  if (
    !object(baseline) ||
    !object(observation) ||
    !Array.isArray(baseline.workers) ||
    !Array.isArray(observation.workers) ||
    !Array.isArray(baseline.domains) ||
    !Array.isArray(baseline.routes) ||
    !isDeepStrictEqual(baseline.domains, observation.domains) ||
    !isDeepStrictEqual(baseline.routes, observation.routes) ||
    !isDeepStrictEqual(names(baseline), names(observation))
  )
    return false;
  const created = new Map(
    manifest.steps.filter(isPrivateWorkerStep).map((step) => [step.workerName, step]),
  );
  const previews = new Map(
    manifest.steps.filter(isPreviewRuntimeWorkerStep).map((step) => [step.workerName, step]),
  );
  const cores = new Map(
    manifest.steps
      .filter((step) => isControlCoreStep(step) || isNativeRegionalWorkerStep(step))
      .map((step) => [step.workerName, step]),
  );
  return baseline.workers.every((original, index) => {
    const live = observation.workers[index];
    const preview = previews.get(original.workerName);
    if (preview !== undefined) {
      if (!isAbsentEntry(original, manifest.accountId)) return isDeepStrictEqual(original, live);
      const status = steps[preview.id]?.status;
      if (isAbsentEntry(live, manifest.accountId)) return status !== "completed";
      const target = [PREVIEW_RUNTIME_PROFILES[manifest.environment].cron];
      return (
        ["running", "completed"].includes(status) &&
        Object.keys(live).length === 3 &&
        live.subdomain?.enabled === false &&
        live.subdomain.previews_enabled === false &&
        (isDeepStrictEqual(live.crons, target) ||
          (status === "running" && isDeepStrictEqual(live.crons, [])))
      );
    }
    const core = cores.get(original.workerName);
    if (core !== undefined) {
      // A Core that existed at the baseline is an ordinary neighbour. One that did not may appear, private and
      // without ingress or schedules, only once this train's own Core step started or finished.
      if (!isAbsentEntry(original, manifest.accountId)) return isDeepStrictEqual(original, live);
      const status = steps[core.id]?.status;
      if (isAbsentEntry(live, manifest.accountId)) return status !== "completed";
      return (
        ["running", "completed"].includes(status) &&
        Object.keys(live).length === 3 &&
        live.subdomain?.enabled === false &&
        live.subdomain.previews_enabled === false &&
        isDeepStrictEqual(live.crons, [])
      );
    }
    const step = created.get(original.workerName);
    if (step === undefined) return isDeepStrictEqual(original, live);
    if (!isAbsentEntry(original, manifest.accountId)) return false;
    const state = steps[step.id];
    if (isAbsentEntry(live, manifest.accountId)) return state?.status !== "completed";
    const definition = resolvePrivateWorkerProfile(step);
    const completed = state?.status === "completed";
    const progressed = completed || ["creating", "activating"].includes(state?.creation?.phase);
    const permitted =
      !completed && definition.crons.length > 0 ? [[], definition.crons] : [definition.crons];
    return (
      progressed &&
      Object.keys(live).length === 3 &&
      live.subdomain?.enabled === false &&
      live.subdomain.previews_enabled === false &&
      permitted.some((crons) => isDeepStrictEqual(live.crons, crons))
    );
  });
}

// ---- Provider readback and creation --------------------------------------------------------

async function providerClient({ run, wrangler, fetch }) {
  const token = await readBearerToken({ run, wrangler, label: "Private Worker provider" });
  return async (method, path, body) => {
    let response;
    try {
      response = await fetch(`${CLOUDFLARE_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("Private Worker provider request is unavailable");
    }
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.success !== true || value.result === undefined)
      throw new Error("Private Worker provider request failed");
    return value.result;
  };
}

const scriptPath = (accountId, workerName) =>
  `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;

async function readSchedules(request, accountId, workerName) {
  const result = await request("GET", `${scriptPath(accountId, workerName)}/schedules`);
  if (
    !Array.isArray(result?.schedules) ||
    result.schedules.some((schedule) => typeof schedule?.cron !== "string")
  )
    throw new Error("Private Worker schedules are invalid");
  return result.schedules.map(({ cron }) => cron).sort();
}

async function requirePrivateSubdomain(request, accountId, workerName) {
  const subdomain = await request("GET", `${scriptPath(accountId, workerName)}/subdomain`);
  if (subdomain?.enabled !== false || subdomain.previews_enabled !== false)
    throw new Error("Private Worker ingress is not private");
}

/** The sole currently active version must carry this creation's tag, message and exact bindings. */
async function readOwnedActiveVersion({ common, run, wrangler, tag, message, inventory }) {
  const deployment = await readDeployment({ common, run, wrangler });
  const active = deployment.versions;
  if (
    !Array.isArray(active) ||
    active.length !== 1 ||
    active[0]?.percentage !== 100 ||
    !UUID.test(active[0]?.version_id ?? "")
  )
    throw new Error("Private Worker deployment is not one sole 100% version");
  const versionId = active[0].version_id;
  const view = parseObject(
    await run(wrangler, ["versions", "view", versionId, "--json", ...common], { cwd: tmpdir() }),
    "version readback",
  );
  if (
    view.id !== versionId ||
    view.annotations?.["workers/tag"] !== tag ||
    view.annotations?.["workers/message"] !== message
  )
    throw new Error("Private Worker active version is not owned by this creation");
  verifyExactVersionBindings({ inventory, bindings: view.resources?.bindings });
  return versionId;
}

async function readOwnedWorker({ run, wrangler, accountId, step, renderedPath, described }) {
  const presence = await observeWorkerCommand({
    run,
    wrangler,
    accountId,
    workerName: step.workerName,
    configPath: renderedPath,
  });
  // A missing response alone never proves an earlier creation did not reach the provider.
  if (presence.kind !== "present")
    throw new Error("Private Worker creation outcome is unresolved; the Worker is not observable");
  return readOwnedActiveVersion({
    common: ["--name", step.workerName, "--config", renderedPath],
    run,
    wrangler,
    tag: described.tag,
    message: described.message,
    inventory: described.inventory,
  });
}

async function preparedContext({
  step,
  environment,
  sourceCommit,
  repositoryRoot,
  configPath,
  prepared,
  run,
}) {
  const definition = validatePrivateWorkerStep(step, environment);
  const described = prepared?.private;
  if (described === undefined || prepared.proof === undefined)
    throw new Error("Private Worker creation requires its prepared closed profile and rehearsal");
  const reused = await validateWorkerRehearsal({
    proof: prepared.proof,
    repositoryRoot,
    sha: sourceCommit,
    workerName: step.workerName,
    configPath,
    run,
    configuration: prepared.configuration,
    privateWorker: described.evidence,
  });
  const current = describePrivateWorker({
    step,
    environment,
    sourceCommit,
    configuration: prepared.configuration,
    reused,
    proof: prepared.proof,
  });
  if (!isDeepStrictEqual(current, described))
    throw new Error("Private Worker preparation changed before use");
  return { definition, described, reused };
}

/**
 * Creates one private Worker, or resumes exactly that creation. Durable progress is persisted through
 * `checkpoint` BEFORE the creation command runs. After that point an ambiguous result never permits
 * another upload: only readback of this creation's sole active 100% version may
 * adopt it, and anything unresolved stays interrupted without repair.
 */
export async function createPrivateWorker({
  step,
  environment,
  accountId,
  sourceCommit,
  approvalSha256,
  repositoryRoot,
  configPath,
  prepared,
  progress: durable,
  checkpoint,
  run,
  wrangler,
  fetch = globalThis.fetch,
}) {
  if (typeof checkpoint !== "function")
    throw new Error("Private Worker creation requires durable progress");
  const {
    definition,
    described: currentDescription,
    reused,
  } = await preparedContext({
    step,
    environment,
    sourceCommit,
    repositoryRoot,
    configPath,
    prepared,
    run,
  });
  if (currentDescription.accountId !== accountId)
    throw new Error("Private Worker belongs to another Cloudflare account");
  const binding = creationBinding({
    approvalSha256,
    sourceCommit,
    step,
    described: currentDescription,
  });
  let progress = durable;
  if (progress !== undefined) validateCreationProgress(progress, binding);
  const described =
    progress === undefined
      ? currentDescription
      : { ...currentDescription, message: progress.message };
  const persist = async (next) => {
    await checkpoint(next);
    progress = next;
  };
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-private-worker-"));
  try {
    const renderedPath = join(directory, "wrangler.json");
    await writeFile(renderedPath, `${JSON.stringify(reused, null, 2)}\n`, { mode: 0o600 });
    const common = ["--name", step.workerName, "--config", renderedPath];
    const adopt = () =>
      readOwnedWorker({ run, wrangler, accountId, step, renderedPath, described });
    const requireAbsent = async () => {
      const presence = await observeWorkerCommand({
        run,
        wrangler,
        accountId,
        workerName: step.workerName,
        configPath: renderedPath,
      });
      if (presence.kind !== "absent")
        throw new Error("Private Worker creation collides with an existing Worker");
    };

    if (progress === undefined) {
      await requireAbsent();
      await persist({
        ...binding,
        phase: "prepared",
        originalPresence: { kind: "absent", accountId, workerName: step.workerName },
        uploadAttempted: false,
      });
    }
    if (progress.phase === "prepared") {
      // Confirmed absence is rechecked immediately before the intent that permits the upload.
      await requireAbsent();
      await persist({ ...progress, phase: "creating", uploadAttempted: true });
      try {
        await run(
          wrangler,
          ["deploy", "--tag", described.tag, "--message", described.message, ...common],
          { cwd: tmpdir() },
        );
      } catch {
        // The outcome is unknown: only the readback below may decide, never another upload.
      }
    }
    const versionId = await adopt();
    if (progress.phase === "creating")
      await persist({ ...progress, phase: "activating", versionId, cronAttempted: false });
    else if (progress.versionId !== versionId)
      throw new Error("Private Worker active version differs from its durable progress");

    const request = await providerClient({ run, wrangler, fetch });
    let crons = await readSchedules(request, accountId, step.workerName);
    let cronTriggers = "unchanged";
    if (!isDeepStrictEqual(crons, definition.crons)) {
      // Only a scheduled profile's own empty schedule may be set, once, to its exact target.
      if (definition.crons.length === 0 || crons.length !== 0)
        throw new Error("Private Worker schedules differ from its closed profile");
      if (progress.cronAttempted)
        throw new Error("Private Worker schedule outcome is unresolved; only readback may resume");
      if ((await adopt()) !== progress.versionId)
        throw new Error("Private Worker active version changed before its schedule");
      // Like creation, an unknown PUT outcome cannot authorize another mutation. Persist intent
      // first; a resume reads the exact target or remains interrupted for reviewed recovery.
      await persist({ ...progress, cronAttempted: true });
      await request(
        "PUT",
        `${scriptPath(accountId, step.workerName)}/schedules`,
        definition.crons.map((cron) => ({ cron })),
      );
      crons = await readSchedules(request, accountId, step.workerName);
      if (!isDeepStrictEqual(crons, definition.crons))
        throw new Error("Private Worker schedule readback differs from its closed profile");
      cronTriggers = "updated";
    }
    await requirePrivateSubdomain(request, accountId, step.workerName);
    return Object.freeze({
      creationId: step.creationId,
      profile: step.profile,
      workerName: step.workerName,
      sha: sourceCommit,
      versionId: progress.versionId,
      tag: described.tag,
      message: described.message,
      deploymentVerified: true,
      cronTriggers,
      crons: [...definition.crons],
      ingress: { workersDev: false, previewUrls: false },
      bindingsSha256: described.bindingsSha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Completed replay is read-only: it re-derives the identity and rejects any drift. */
export async function verifyPrivateWorkerReceipt({
  receipt,
  step,
  environment,
  accountId,
  sourceCommit,
  repositoryRoot,
  configPath,
  prepared,
  run,
  wrangler,
  fetch = globalThis.fetch,
  allowDevelopmentBrokerActivation = false,
  activatedSourceCommit = sourceCommit,
}) {
  if (
    !/^[a-f0-9]{40}$/u.test(activatedSourceCommit ?? "") ||
    (activatedSourceCommit !== sourceCommit && !allowDevelopmentBrokerActivation) ||
    (allowDevelopmentBrokerActivation &&
      (environment !== "development" || step.profile !== "connection_broker"))
  )
    throw new Error("Only the Development Broker can supersede its bootstrap creation");
  validatePrivateWorkerReceipt(receipt, step, sourceCommit);
  const { definition, described, reused } = await preparedContext({
    step,
    environment,
    sourceCommit,
    repositoryRoot,
    configPath,
    prepared,
    run,
  });
  if (
    described.accountId !== accountId ||
    receipt.tag !== described.tag ||
    !matchesReleaseMessage(receipt.message, described.message) ||
    receipt.bindingsSha256 !== described.bindingsSha256
  )
    throw new Error("Completed Private Worker receipt is not the exact current creation");
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-private-worker-"));
  let activated = false;
  try {
    const renderedPath = join(directory, "wrangler.json");
    await writeFile(renderedPath, `${JSON.stringify(reused, null, 2)}\n`, { mode: 0o600 });
    if (allowDevelopmentBrokerActivation) {
      const common = ["--name", step.workerName, "--config", renderedPath];
      // Keep exact immutable creation provenance even after ordinary activation.
      const original = parseObject(
        await run(wrangler, ["versions", "view", receipt.versionId, "--json", ...common], {
          cwd: tmpdir(),
        }),
        "bootstrap version readback",
      );
      if (
        original.id !== receipt.versionId ||
        original.annotations?.["workers/tag"] !== receipt.tag ||
        original.annotations?.["workers/message"] !== receipt.message
      )
        throw new Error("Development Broker bootstrap provenance drifted");
      verifyExactVersionBindings({
        inventory: described.inventory,
        bindings: original.resources?.bindings,
      });
      const deployment = await readDeployment({ common, run, wrangler });
      const active = deployment.versions;
      if (
        !Array.isArray(active) ||
        active.length !== 1 ||
        active[0]?.percentage !== 100 ||
        !UUID.test(active[0]?.version_id ?? "")
      )
        throw new Error("Development Broker is not one sole 100% version");
      const versionId = active[0].version_id;
      if (versionId === receipt.versionId && activatedSourceCommit !== sourceCommit)
        throw new Error("Development Broker descendant has not been activated");
      if (versionId !== receipt.versionId) {
        const current = parseObject(
          await run(wrangler, ["versions", "view", versionId, "--json", ...common], {
            cwd: tmpdir(),
          }),
          "activated Broker version readback",
        );
        const message = current.annotations?.["workers/message"];
        const match =
          typeof message === "string"
            ? /^source ([a-f0-9]{40}); config ([a-f0-9]{64}); rehearsal ([a-f0-9]{64})$/u.exec(
                message,
              )
            : null;
        if (
          current.id !== versionId ||
          match === null ||
          match[1] !== activatedSourceCommit ||
          current.annotations?.["workers/tag"] !==
            `release-${activatedSourceCommit.slice(0, 12)}-${match[2].slice(0, 12)}-${match[3].slice(0, 12)}`
        )
          throw new Error(
            "Development Broker activation is not the same-source ordinary train release",
          );
        const inventory = [
          ...described.inventory,
          ...["MAKE_CLIENT_ID", "MAKE_CLIENT_SECRET", "GRANT_KEY"].map((name) => ({
            name,
            type: "secret_text",
          })),
        ].sort(byName);
        verifyExactVersionBindings({ inventory, bindings: current.resources?.bindings });
        activated = true;
      }
    } else {
      const versionId = await readOwnedWorker({
        run,
        wrangler,
        accountId,
        step,
        renderedPath,
        described: { ...described, message: receipt.message },
      });
      if (versionId !== receipt.versionId)
        throw new Error("Completed Private Worker version or deployment drifted");
    }
    const request = await providerClient({ run, wrangler, fetch });
    if (
      !isDeepStrictEqual(await readSchedules(request, accountId, step.workerName), definition.crons)
    )
      throw new Error("Completed Private Worker schedules drifted");
    await requirePrivateSubdomain(request, accountId, step.workerName);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return allowDevelopmentBrokerActivation ? { activated } : true;
}

/** The approval-scope facts the operator reviews before any creation (printed, never secret). */
export function describePrivateApproval({ manifest, prepared }) {
  const created = manifest.steps.filter(isPrivateWorkerStep);
  if (created.length === 0) return undefined;
  return {
    protectedControl: prepared.protectedControl,
    ...(prepared.development === undefined
      ? {}
      : { developmentCreation: prepared.development.evidence }),
    creations: created.map((step) => {
      const definition = resolvePrivateWorkerProfile(step);
      const { bindingsSha256 } = prepared.workers[step.id].private;
      return {
        stepId: step.id,
        creationId: step.creationId,
        profile: step.profile,
        workerName: step.workerName,
        cron: [...definition.crons],
        services: definition
          .services(definition.environment)
          .map(({ binding, service, entrypoint }) => ({
            binding,
            target: service,
            entrypoint,
          })),
        r2Buckets: definition
          .buckets(definition.environment)
          .map(({ binding, bucket_name, jurisdiction }) => ({
            binding,
            bucket: bucket_name,
            jurisdiction,
          })),
        bindingsSha256,
      };
    }),
  };
}
