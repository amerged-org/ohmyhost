import { normalizeNativeAuthLaunchPolicy } from "./control-core-native-auth-policy.mjs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";

/**
 * What the release train knows about the shared Core Worker and the Workers that consume it, in one place:
 * the checked-in template every Core step renders from, the exact resource identity a step carries, and the
 * service bindings that make a Worker a Core consumer. Pure checks only; provider reads stay in the release
 * steps that use them.
 */
export const CONTROL_CORE_CONFIG = "apps/control-store/wrangler.jsonc";
/**
 * A consumer that must know the Core's database id declares this variable with the placeholder in its
 * checked-in profile, because a resource id is never checked in. The train resolves it from the Core step.
 */
export const CORE_DATABASE_VARIABLE = "CONTROL_CORE_DATABASE_ID";
export const CORE_DATABASE_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const DIRECT_AUTHORITY_BINDING = /^(?:CONTROL_CORE|CONTROL_GLOBAL|CONTROL_SHARD_\d{4})$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const fail = (message) => {
  throw new Error(message);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Exact provider metadata of one Core resource, shared by every path that proves it: the UUID (when the
 * caller pins it) and name, EU jurisdiction (Control metadata lives in the EU, for the fixed names and the
 * retained UUID-suffixed names alike) and read replication disabled. Anything else is not the Core and fails closed with a fixed code.
 */
export function assertControlCoreResourceIdentity(database, { databaseId, databaseName }) {
  if (
    !UUID.test(database?.uuid ?? "") ||
    (databaseId !== undefined && database.uuid !== databaseId) ||
    database.name !== databaseName ||
    database.jurisdiction !== "eu" ||
    database.read_replication?.mode !== "disabled"
  )
    fail("CONTROL_CORE_RESOURCE_UNVERIFIED");
  return database;
}

/** The fixed resource name of one environment (`creationId` is only for the retained UUID-suffixed resources). */
export function fixedControlCoreDatabaseName(environment) {
  if (!Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment))
    fail("Core environment is invalid");
  return `ohmyho-control-core-${environment}`;
}

/** The Core database id the manifest's one Core step names, or undefined for a train without a Core. */
export const coreDatabaseIdOf = (manifest) =>
  manifest.steps.find(isControlCoreStep)?.core?.databaseId;

/** Replaces the placeholder variable with the Core step's id; an unresolved placeholder never reaches a provider. */
export function resolveCoreDatabaseVariable(vars, coreDatabaseId) {
  if (vars?.[CORE_DATABASE_VARIABLE] !== CORE_DATABASE_PLACEHOLDER) return vars;
  if (!UUID.test(coreDatabaseId ?? ""))
    fail("The Core database id placeholder has no Core step to resolve it");
  return { ...vars, [CORE_DATABASE_VARIABLE]: coreDatabaseId };
}

export const isControlCoreWorker = (workerName) =>
  Object.values(CONTROL_CORE_WORKER_PROFILES).includes(workerName);
export const isControlCoreStep = (step) =>
  step?.kind === "worker" && isControlCoreWorker(step.workerName);
const environmentOfCore = (workerName) =>
  Object.keys(CONTROL_CORE_WORKER_PROFILES).find(
    (environment) => CONTROL_CORE_WORKER_PROFILES[environment] === workerName,
  );

/**
 * A Core step names its exact D1 resource, because the checked-in template never carries an id. Only the
 * fixed `ohmyho-control-core-<environment>` name or its retained UUID-suffixed form is accepted, and only
 * the template itself, with no secret, Control identity, container or creation field.
 */
export function validateControlCoreStep(step, environment) {
  if (!isControlCoreWorker(step.workerName)) {
    if (step.core !== undefined || step.nativeAuthLaunchPolicy !== undefined)
      fail("Only the Core Worker step names a Core resource or Native Auth launch policy");
    return;
  }
  normalizeNativeAuthLaunchPolicy(step.nativeAuthLaunchPolicy);
  const name = step.core?.databaseName;
  const base = `ohmyho-control-core-${environment}`;
  if (
    CONTROL_CORE_WORKER_PROFILES[environment] !== step.workerName ||
    step.config !== CONTROL_CORE_CONFIG ||
    !object(step.core) ||
    Object.keys(step.core).sort().join(",") !== "databaseId,databaseName" ||
    !UUID.test(step.core.databaseId ?? "") ||
    typeof name !== "string" ||
    (name !== base && !(name.startsWith(`${base}-`) && UUID.test(name.slice(base.length + 1)))) ||
    step.secretsFile !== undefined ||
    step.containerImages !== undefined ||
    step.action !== undefined
  )
    fail("Core Worker step scope or resource identity is invalid");
}

/** The input `renderWranglerConfiguration` needs to build the Core configuration of one step. */
export function controlCoreRenderInput({ step, accountId, sourceCommit, repositoryRoot }) {
  if (
    !isControlCoreStep(step) ||
    !ACCOUNT.test(accountId ?? "") ||
    !COMMIT.test(sourceCommit ?? "")
  )
    fail("Core Worker render input is invalid");
  return Object.freeze({
    accountId,
    sourceCommit,
    repositoryRoot: resolve(repositoryRoot),
    databaseId: step.core.databaseId,
    databaseName: step.core.databaseName,
    nativeAuthLaunchPolicy: normalizeNativeAuthLaunchPolicy(step.nativeAuthLaunchPolicy),
  });
}

export const controlCoreTemplatePath = (repositoryRoot) =>
  join(resolve(repositoryRoot), CONTROL_CORE_CONFIG);
export const controlCoreEnvironment = environmentOfCore;

/** Entrypoint classes the Core Worker exports at the checked-out source; a consumer may bind only these. */
export async function controlCoreEntrypoints(repositoryRoot) {
  const source = await readFile(
    join(resolve(repositoryRoot), "apps/control-store/src/worker-main.ts"),
    "utf8",
  );
  return new Set(
    [...source.matchAll(/^export class (\w+) extends WorkerEntrypoint\b/gmu)].map(
      (match) => match[1],
    ),
  );
}

/**
 * Classifies a rendered Worker configuration as a Core consumer (`mode: "d1"`: it binds the Core Worker) or not
 * (`mode: "none"`), and refuses every foreign form of a consumer: a binding to the other environment's Core or to
 * an entrypoint the Core does not export, duplicate binding names, a Core database id that differs from the
 * train's, and a direct authority D1 binding beside the Core service.
 */
export function inspectControlCoreConsumer({
  configuration,
  environment,
  entrypoints,
  coreDatabaseId,
}) {
  const target = CONTROL_CORE_WORKER_PROFILES[environment];
  if (target === undefined) fail("Core consumer environment is invalid");
  const services = (configuration.services ?? []).filter(({ service }) =>
    isControlCoreWorker(service),
  );
  if (services.length === 0) return Object.freeze({ mode: "none", bindings: Object.freeze([]) });
  if (
    services.some(
      ({ service, entrypoint }) => service !== target || !entrypoints?.has(entrypoint ?? ""),
    ) ||
    new Set(services.map(({ binding }) => binding)).size !== services.length ||
    (coreDatabaseId !== undefined &&
      configuration.vars?.[CORE_DATABASE_VARIABLE] !== undefined &&
      configuration.vars[CORE_DATABASE_VARIABLE] !== coreDatabaseId) ||
    (configuration.d1_databases ?? []).some(({ binding }) => DIRECT_AUTHORITY_BINDING.test(binding))
  )
    fail("A Core consumer must bind only its own environment's Core Worker");
  return Object.freeze({
    mode: "d1",
    bindings: Object.freeze(services.map(({ binding, entrypoint }) => ({ binding, entrypoint }))),
  });
}

/**
 * Core before consumers: the environment's Core step must be a transitive dependency of every D1 consumer,
 * so no consumer version is uploaded or activated before the Core it calls is released from the same commit.
 */
export function requireControlCoreBeforeConsumers({ manifest, consumerStepIds }) {
  if (consumerStepIds.length === 0) return;
  const steps = new Map(manifest.steps.map((step) => [step.id, step]));
  const core = manifest.steps.filter(isControlCoreStep);
  if (core.length !== 1) fail("A D1 consumer train needs exactly one Core Worker step");
  const ancestors = (id, seen = new Set()) => {
    for (const dependency of steps.get(id)?.dependsOn ?? [])
      if (!seen.has(dependency)) {
        seen.add(dependency);
        ancestors(dependency, seen);
      }
    return seen;
  };
  for (const id of consumerStepIds)
    if (!ancestors(id).has(core[0].id)) fail("A D1 consumer must depend on the Core Worker step");
}

/** A v1 shared Gateway may activate only after its exact same-source Control and Core ancestors. */
export function requireAtomicDevGatewayChain({ manifest, workers }) {
  const targets = {
    development: {
      gateway: "ohmyho-gateway-poc-private-fullstack",
      control: "ohmyho-control-api-poc-private-fullstack",
    },
    production: { gateway: "ohmyho-gateway-production", control: "ohmyho-control-api-production" },
  };
  const target = targets[manifest.environment];
  if (!target) fail("Atomic Dev gateway environment is invalid");
  const steps = new Map(manifest.steps.map((step) => [step.id, step]));
  const ancestors = (id, seen = new Set()) => {
    for (const dependency of steps.get(id)?.dependsOn ?? [])
      if (!seen.has(dependency)) {
        seen.add(dependency);
        ancestors(dependency, seen);
      }
    return seen;
  };
  for (const step of manifest.steps) {
    if (
      step.kind !== "worker" ||
      ![targets.development.gateway, targets.production.gateway].includes(step.workerName)
    )
      continue;
    const configuration = workers[step.id]?.configuration;
    const mode = configuration?.vars?.DEV_AUTH_ATOMIC_MODE;
    if (mode === undefined) continue;
    if (
      mode !== "v1" ||
      step.workerName !== target.gateway ||
      configuration.name !== target.gateway
    )
      fail("Atomic Dev gateway profile is invalid");
    const controls = manifest.steps.filter(
      (candidate) => candidate.kind === "worker" && candidate.workerName === target.control,
    );
    const cores = manifest.steps.filter(isControlCoreStep);
    if (
      controls.length !== 1 ||
      cores.length !== 1 ||
      cores[0].workerName !== CONTROL_CORE_WORKER_PROFILES[manifest.environment] ||
      workers[controls[0].id]?.configuration?.name !== target.control ||
      !ancestors(step.id).has(controls[0].id) ||
      !ancestors(controls[0].id).has(cores[0].id)
    )
      fail("Atomic Dev gateway requires Core then Control ancestors");
    const gatewayBindings = (configuration.services ?? []).filter(
      (service) => service.binding === "DEV_ACCESS",
    );
    const controlBindings = (workers[controls[0].id]?.configuration?.services ?? []).filter(
      (service) => service.binding === "DEV_ACCESS_RUNTIME",
    );
    if (
      gatewayBindings.length !== 1 ||
      gatewayBindings[0].service !== target.control ||
      (gatewayBindings[0].environment !== undefined &&
        gatewayBindings[0].environment !== "production") ||
      gatewayBindings[0].entrypoint !== "DevAccessService" ||
      controlBindings.length !== 1 ||
      controlBindings[0].service !== CONTROL_CORE_WORKER_PROFILES[manifest.environment] ||
      (controlBindings[0].environment !== undefined &&
        controlBindings[0].environment !== "production") ||
      controlBindings[0].entrypoint !== "DevAccessRuntime"
    )
      fail("Atomic Dev gateway binding chain is invalid");
  }
}
