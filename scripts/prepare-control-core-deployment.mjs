import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { workerReleaseIdentity } from "./platform-release.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";
import { requirePrivateReleaseDirectory } from "./release-rehearsal-artifacts.mjs";
import {
  CONTROL_CORE_WORKER_PROFILES as profiles,
  controlCoreWorkerConfiguration,
  assertControlCoreWorkerConfiguration,
} from "./control-core-worker-profile.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const FORMAT = "omh.control-core.deployment/v1";
const fail = () => {
  throw new Error("CONTROL_CORE_DEPLOYMENT_UNVERIFIED");
};
const timestamp = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** A persisted creation identity gives an unknown creation outcome an exact name to observe, never a blind retry. */
export function controlCoreDatabaseName(environment, creationId) {
  if (!Object.hasOwn(profiles, environment) || !UUID.test(creationId ?? "")) fail();
  return `ohmyho-control-core-${environment}-${creationId}`;
}

function resourceOf(observation, environment, creationId, accountId) {
  const db = observation?.database;
  const fixedName = db?.name === `ohmyho-control-core-${environment}`;
  const createdName = controlCoreDatabaseName(environment, creationId);
  if (
    !ACCOUNT.test(accountId ?? "") ||
    observation?.accountId !== accountId ||
    !timestamp(observation.observedAt) ||
    !UUID.test(db?.uuid ?? "") ||
    (!fixedName && db.name !== createdName) ||
    db.jurisdiction !== "eu" ||
    db.read_replication?.mode !== "disabled"
  )
    fail();
  return db;
}

/** Local preparation only. No Cloudflare mutation, SQL, credential, consumer binding or authority activation. */
export async function prepareControlCoreDeployment(
  input,
  { inspect = inspectRehearsalRepository } = {},
) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !==
      "accountId,creationId,environment,output,repositoryRoot,resourceObservation"
  )
    fail();
  const { environment, creationId, accountId } = input;
  const resource = resourceOf(input.resourceObservation, environment, creationId, accountId);
  const source = await inspect({ cwd: resolve(input.repositoryRoot) });
  if (
    !REVISION.test(source.sha ?? "") ||
    resolve(source.repositoryRoot) !== resolve(input.repositoryRoot)
  )
    fail();
  const output = resolve(input.output);
  await requirePrivateReleaseDirectory(resolve(output, ".."), source.repositoryRoot);
  const { configuration, sourceTemplateSha256 } = await controlCoreWorkerConfiguration({
    repositoryRoot: source.repositoryRoot,
    sourceCommit: source.sha,
    environment,
    accountId,
    databaseId: resource.uuid,
    databaseName: resource.name,
  });
  const contract = {
    schemaVersion: 1,
    kind: FORMAT,
    sourceCommit: source.sha,
    sourceTemplateSha256,
    repositoryRoot: source.repositoryRoot,
    environment,
    creationId,
    accountId,
    configuration,
    resourceObservedAt: input.resourceObservation.observedAt,
  };
  await mkdir(output, { mode: 0o700 });
  // A failed partial preparation stays separate and cannot be overwritten into a different identity.
  for (const [name, value] of [
    ["wrangler.jsonc", configuration],
    ["deployment-contract.json", contract],
    ["package.json", { name: "@ohmyhost/control-store", private: true }],
  ])
    await writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  return contract;
}

/** Provider metadata proves only the resource and private binding, never an imported/activated financial authority. */
export async function verifyControlCoreDeployment(
  actual,
  contract,
  receipt,
  { repositoryRoot, inspect = inspectRehearsalRepository } = {},
) {
  if (
    contract?.schemaVersion !== 1 ||
    contract.kind !== FORMAT ||
    !REVISION.test(contract.sourceCommit ?? "") ||
    !Object.hasOwn(profiles, contract.environment) ||
    !timestamp(actual?.observedAt) ||
    actual.accountId !== contract.accountId ||
    actual.workerName !== profiles[contract.environment]
  )
    fail();
  if (typeof repositoryRoot !== "string") fail();
  const source = await inspect({ cwd: resolve(repositoryRoot) });
  if (
    source.sha !== contract.sourceCommit ||
    source.repositoryRoot !== contract.repositoryRoot ||
    resolve(source.repositoryRoot) !== resolve(repositoryRoot)
  )
    fail();
  const configuration = contract.configuration;
  await assertControlCoreWorkerConfiguration({
    configuration,
    repositoryRoot: source.repositoryRoot,
    sourceCommit: source.sha,
    standalone: true,
  });
  const resource = resourceOf(
    actual.resourceObservation,
    contract.environment,
    contract.creationId,
    contract.accountId,
  );
  const expected = await controlCoreWorkerConfiguration({
    repositoryRoot: source.repositoryRoot,
    sourceCommit: source.sha,
    environment: contract.environment,
    accountId: contract.accountId,
    databaseId: resource.uuid,
    databaseName: resource.name,
  });
  if (
    expected.sourceTemplateSha256 !== contract.sourceTemplateSha256 ||
    !timestamp(contract.resourceObservedAt) ||
    Date.parse(actual.resourceObservation.observedAt) < Date.parse(contract.resourceObservedAt) ||
    Date.parse(actual.resourceObservation.observedAt) > Date.parse(actual.observedAt)
  )
    fail();
  const identity = workerReleaseIdentity({ sha: contract.sourceCommit, configuration });
  if (
    configuration?.name !== profiles[contract.environment] ||
    configuration.account_id !== contract.accountId ||
    configuration.d1_databases?.length !== 1 ||
    configuration.d1_databases[0].binding !== "CONTROL_CORE" ||
    configuration.d1_databases[0].database_id !== resource.uuid ||
    configuration.d1_databases[0].database_name !== resource.name ||
    !isDeepStrictEqual(configuration.vars, {
      CONTROL_CORE_DATABASE_ID: resource.uuid,
      CONTROL_PLATFORM_ENVIRONMENT: contract.environment,
      CONTROL_CORE_RELEASE_SOURCE: source.sha,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"disabled"}',
    }) ||
    receipt?.deploymentVerified !== true ||
    receipt.sha !== contract.sourceCommit ||
    receipt.workerName !== configuration.name ||
    !UUID.test(receipt.versionId ?? "") ||
    receipt.tag !== identity.tag ||
    ![identity.message, identity.message.replace(/^source /u, "origin/main ")].includes(
      receipt.message,
    ) ||
    actual.version?.id !== receipt.versionId ||
    actual.version.annotations?.["workers/tag"] !== identity.tag ||
    actual.version.annotations?.["workers/message"] !== receipt.message ||
    !isDeepStrictEqual(actual.deployment?.versions, [
      { version_id: receipt.versionId, percentage: 100 },
    ]) ||
    actual.subdomain?.enabled !== false ||
    actual.subdomain.previews_enabled !== false ||
    !isDeepStrictEqual(actual.routes, []) ||
    !isDeepStrictEqual(actual.customDomains, []) ||
    !isDeepStrictEqual(actual.schedules, []) ||
    actual.settings?.compatibility_date !== configuration.compatibility_date ||
    !isDeepStrictEqual(actual.settings.compatibility_flags, configuration.compatibility_flags)
  )
    fail();
  const bindings = actual.version.resources?.bindings;
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 6 ||
    new Set(bindings.map((b) => b?.name)).size !== 6
  )
    fail();
  const byName = new Map(bindings.map((b) => [b.name, b]));
  if (
    byName.get("CONTROL_CORE")?.type !== "d1" ||
    byName.get("CONTROL_CORE").id !== resource.uuid ||
    byName.get("CF_VERSION_METADATA")?.type !== "version_metadata"
  )
    fail();
  for (const [name, value] of Object.entries(configuration.vars))
    if (byName.get(name)?.type !== "plain_text" || byName.get(name).text !== value) fail();
  return {
    schemaVersion: 1,
    kind: "omh.control-core.binding-proof/v1",
    state: "resource-and-binding-verified",
    sourceCommit: contract.sourceCommit,
    accountId: contract.accountId,
    environment: contract.environment,
    workerName: configuration.name,
    versionId: receipt.versionId,
    databaseId: resource.uuid,
    verifiedAt: actual.observedAt,
    authorityActivation: "not-certified",
  };
}
