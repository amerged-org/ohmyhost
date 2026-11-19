/* global process */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  inspectReleaseRepository,
  releaseWorker,
  requireVerifiedCommit,
  renderWranglerConfiguration,
  readArtifactDigest,
  verifyWorkerReleaseReceipt,
  validateReleaseSecretsFile,
  corePinAt,
  requireCoreSchemaHead,
} from "./platform-release.mjs";
import { publishNpmClients } from "./publish-npm-clients.mjs";
import {
  CLIENT_PACKAGES as PACKAGES,
  prepareClientPrerequisite,
  verifyClientRegistryArtifacts,
} from "./release-client-artifacts.mjs";
import {
  assertPolicyStepConfigs,
  observePolicyCohort,
  providerReader,
  requirePolicyCohort,
} from "./release-policy-cohort.mjs";
import {
  readPrivateReleaseJson,
  releaseHash,
  requirePrivateReleaseDirectory,
  validateWorkerRehearsal,
} from "./release-rehearsal-artifacts.mjs";
import {
  assertForwardProgress,
  closedTransition,
  createPrivateWorker,
  creationBinding,
  describePrivateWorker,
  isNativeRegionalWorkerStep,
  isPreviewRuntimeWorkerStep,
  isAbsentEntry,
  isPrivateWorkerStep,
  validatePreviewRuntimeStep,
  validatePreviewRuntimeConfiguration,
  validatePreviewRuntimeTrain,
  privateWorkerEvidence,
  protectedControlIdentity,
  protectedControlName,
  requireInitialAbsence,
  validateCreationProgress,
  validatePrivateWorkerConfiguration,
  validatePrivateWorkerReceipt,
  validatePrivateWorkerStep,
  validatePrivateWorkerTrain,
  verifyPrivateWorkerReceipt,
} from "./release-private-worker.mjs";
import { classifyWorkerAbsence, createWorkerPresenceObserver } from "./release-worker-presence.mjs";
import {
  controlCoreEntrypoints,
  controlCoreRenderInput,
  coreDatabaseIdOf,
  inspectControlCoreConsumer,
  isControlCoreStep,
  isControlCoreWorker,
  requireControlCoreBeforeConsumers,
  requireAtomicDevGatewayChain,
  validateControlCoreStep,
} from "./control-core-train.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const STEP = /^[a-z][a-z0-9-]{0,63}$/u;
const WORKER =
  /^(?:(?:ohmyho|ohmyhost)-[a-z0-9-]+-(?:poc-private-fullstack|production)|ohmyho-(?:project-database|native-auth)-(?:development|production)-(?:us|eu)|ohmyho-connection-broker-development)$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, allowed, required) =>
  object(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
const repoPath = (value) =>
  typeof value === "string" &&
  !isAbsolute(value) &&
  value.length < 300 &&
  !value.split(/[\\/]/u).some((segment) => ["", ".", ".."].includes(segment));
const environmentOf = (name) =>
  /-production(?:-(?:us|eu))?$/u.test(name) ? "production" : "development";
export const manifestDigest = (manifest) => releaseHash(JSON.stringify(manifest));
export const releaseApprovalDigest = ({ manifest, preparationSha256 }) => {
  if (!HASH.test(preparationSha256 ?? "")) throw new Error("Release preparation digest is invalid");
  return releaseHash(
    JSON.stringify({ manifestSha256: manifestDigest(manifest), preparationSha256 }),
  );
};
const execFileAsync = promisify(execFile);
const STATE_FIELDS = Object.freeze([
  "schemaVersion",
  "manifestSha256",
  "sourceCommit",
  "environment",
  "preparationSha256",
  "approvalSha256",
  "status",
  "ciRun",
  "baseline",
  "after",
  "steps",
]);

export async function runReleaseCommand(command, args, options = {}) {
  const localEnv = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      ([name]) =>
        !/(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|DATABASE_DIRECT_URL|PRIVATE_KEY|ACCESS_KEY)/u.test(
          name,
        ),
    ),
  );
  const env = {
    ...(options.localOnly ? localEnv : (options.env ?? process.env)),
    WRANGLER_SEND_METRICS: "false",
  };
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // The one exception to erasure: a trusted caller that observes a Worker's versions gets a fixed
    // typed absence, classified from stderr here BEFORE it is erased, with no cause or output.
    const absent =
      options.observeWorker === undefined
        ? null
        : classifyWorkerAbsence({ command, args, context: options.observeWorker, error });
    if (absent !== null) throw absent;
    // Subprocess stderr/stdout and connection errors can contain credentials. Keep only a known code.
    const code = typeof error.code === "number" ? error.code : "unavailable";
    throw new Error(`Release command failed (${code})`);
  }
}

export function validateTrainManifest(manifest) {
  if (
    !fields(
      manifest,
      [
        "schemaVersion",
        "sourceCommit",
        "environment",
        "accountId",
        "steps",
        "rehearsal",
        "developmentReference",
      ],
      ["schemaVersion", "sourceCommit", "environment", "accountId", "steps"],
    ) ||
    manifest.schemaVersion !== 1 ||
    !COMMIT.test(manifest.sourceCommit ?? "") ||
    !["development", "production"].includes(manifest.environment) ||
    !/^[a-f0-9]{32}$/u.test(manifest.accountId ?? "") ||
    !Array.isArray(manifest.steps) ||
    manifest.steps.length < 1 ||
    manifest.steps.length > 100 ||
    (manifest.rehearsal !== undefined && !isAbsolute(manifest.rehearsal))
  )
    throw new Error("Release manifest identity or scope is invalid");
  const known = new Map();
  const workers = new Set();
  const prerequisites = new Set();
  let hasWorker = false;
  for (const step of manifest.steps) {
    const common = ["id", "kind", "dependsOn"];
    const extras =
      step?.kind === "worker"
        ? [
            "config",
            "configSha256",
            "workerName",
            "secretsFile",
            "containerImages",
            "action",
            "creationId",
            "profile",
            "core",
            "nativeAuthLaunchPolicy",
          ]
        : step?.kind === "clients"
          ? ["action", "directory", "version", "manifestSha256", "sourceCommit"]
          : [];
    const required =
      step?.kind === "worker"
        ? ["config", "configSha256", "workerName"]
        : step?.kind === "clients"
          ? ["action", "directory", "version", "manifestSha256"]
          : ["invalid"];
    if (
      !fields(step, [...common, ...extras], [...common, ...required]) ||
      !STEP.test(step.id ?? "") ||
      known.has(step.id) ||
      !Array.isArray(step.dependsOn) ||
      new Set(step.dependsOn).size !== step.dependsOn.length ||
      step.dependsOn.some((id) => !known.has(id))
    )
      throw new Error("Release dependency order or step identity is invalid");
    const ancestors = new Set(step.dependsOn.flatMap((id) => [id, ...known.get(id)]));
    if (step.kind === "worker") {
      hasWorker = true;
      if (
        !repoPath(step.config) ||
        !/\.jsonc?$/u.test(step.config) ||
        !HASH.test(step.configSha256 ?? "") ||
        !WORKER.test(step.workerName ?? "") ||
        workers.has(step.workerName) ||
        environmentOf(step.workerName) !== manifest.environment ||
        (step.secretsFile !== undefined && !isAbsolute(step.secretsFile)) ||
        (step.containerImages !== undefined && !isAbsolute(step.containerImages)) ||
        [...prerequisites].some((id) => !ancestors.has(id))
      )
        throw new Error(
          "Release Worker scope, configuration or prerequisite dependency is invalid",
        );
      // The Core step names its exact D1 resource; no other step may.
      validateControlCoreStep(step, manifest.environment);
      if (isNativeRegionalWorkerStep(step)) {
        const expected = `apps/native-auth-runtime/wrangler.${manifest.environment}.${step.workerName.slice(-2)}.jsonc`;
        if (step.config !== expected || step.action !== undefined)
          throw new Error("Native regional Worker scope or configuration is invalid");
      }
      if (
        (step.workerName.startsWith("ohmyho-live-preview-") ||
          step.config.startsWith("apps/preview-runtime/")) &&
        !isPreviewRuntimeWorkerStep(step)
      )
        throw new Error("Preview Runtime identity is outside the closed profile");
      if (isPreviewRuntimeWorkerStep(step)) validatePreviewRuntimeStep(step, manifest.environment);
      // Creation fields are all-or-none, never on ordinary updates, and bound to the profile map.
      const creation = ["action", "creationId", "profile"].filter((key) =>
        Object.hasOwn(step, key),
      );
      if (creation.length !== 0) {
        if (creation.length !== 3)
          throw new Error("Private Worker creation fields must be declared together");
        validatePrivateWorkerStep(step, manifest.environment);
      }
      workers.add(step.workerName);
    } else {
      if (hasWorker) throw new Error("Client prerequisites must precede dependent Workers");
      prerequisites.add(step.id);
      if (
        !["publish", "verify"].includes(step.action) ||
        !isAbsolute(step.directory) ||
        !/^0\.1\.\d+$/u.test(step.version ?? "") ||
        !HASH.test(step.manifestSha256 ?? "") ||
        (Object.hasOwn(step, "sourceCommit") &&
          (step.action !== "verify" || !COMMIT.test(step.sourceCommit)))
      )
        throw new Error("Client release prerequisite is invalid");
    }
    known.set(step.id, ancestors);
  }
  if (hasWorker && manifest.rehearsal === undefined)
    throw new Error("Worker release trains require an exact local rehearsal receipt");
  validatePrivateWorkerTrain(manifest, known);
  validatePreviewRuntimeTrain(manifest, known);
  return manifest;
}

export async function prepareReleaseTrain({
  manifest,
  repositoryRoot,
  run = runReleaseCommand,
  evidenceOnly = false,
  readCorePin = corePinAt,
  wrangler = process.env.WRANGLER_BIN ?? "/opt/homebrew/bin/wrangler",
  // The steps whose Core schema head must be checked; undefined checks every Core step.
  coreHeadStepIds,
}) {
  await assertPolicyStepConfigs({ manifest });
  let rehearsed = null;
  if (manifest.rehearsal !== undefined) {
    rehearsed = await readPrivateReleaseJson(manifest.rehearsal);
    if (
      !fields(
        rehearsed.value,
        ["schemaVersion", "sourceCommit", "manifestSha256", "workers"],
        ["schemaVersion", "sourceCommit", "manifestSha256", "workers"],
      ) ||
      rehearsed.value.schemaVersion !== 1 ||
      rehearsed.value.sourceCommit !== manifest.sourceCommit ||
      rehearsed.value.manifestSha256 !== manifestDigest(manifest) ||
      !object(rehearsed.value.workers)
    )
      throw new Error("Release rehearsal manifest or source differs");
  }
  const workers = {};
  const fingerprint = [];
  const consumerStepIds = [];
  const coreDatabaseId = coreDatabaseIdOf(manifest);
  for (const step of manifest.steps) {
    if (step.kind === "worker") {
      const configPath = resolve(repositoryRoot, step.config);
      const offset = relative(await realpath(repositoryRoot), await realpath(configPath));
      if (offset.startsWith("../") || isAbsolute(offset))
        throw new Error("Release config leaves the repository");
      if (releaseHash(await readFile(configPath)) !== step.configSha256)
        throw new Error("Release source configuration digest differs");
      const creating = isPrivateWorkerStep(step);
      if (creating) validatePrivateWorkerStep(step, manifest.environment);
      // Evidence-only preparation (a completed Development creation) never reads secret files.
      if (step.secretsFile !== undefined && !evidenceOnly)
        await validateReleaseSecretsFile({ path: step.secretsFile });
      const temporary = join(
        dirname(manifest.rehearsal ?? configPath),
        `.render-${step.id}-${randomUUID()}.json`,
      );
      const artifact = await readArtifactDigest({ repositoryRoot, workerName: step.workerName });
      let configuration;
      const core = isControlCoreStep(step)
        ? controlCoreRenderInput({
            step,
            accountId: manifest.accountId,
            sourceCommit: manifest.sourceCommit,
            repositoryRoot,
          })
        : undefined;
      try {
        configuration = await renderWranglerConfiguration({
          expectedName: step.workerName,
          outputPath: temporary,
          sourcePath: configPath,
          artifact,
          core,
          coreDatabaseId,
        });
        // A Core is prepared only over the schema head its source commit pins; the rendered config names the database.
        if (
          core !== undefined &&
          !evidenceOnly &&
          (coreHeadStepIds === undefined || coreHeadStepIds.includes(step.id))
        )
          await requireCoreSchemaHead({
            configPath: temporary,
            sourceCommit: manifest.sourceCommit,
            repositoryRoot,
            run,
            wrangler,
            readCorePin,
          });
      } finally {
        await rm(temporary, { force: true });
      }
      // A Core consumer binds only its own environment's Core and is released after it.
      if (core === undefined) {
        const bindsCore = (configuration.services ?? []).some(({ service }) =>
          isControlCoreWorker(service),
        );
        const consumer = inspectControlCoreConsumer({
          configuration,
          environment: manifest.environment,
          entrypoints: bindsCore ? await controlCoreEntrypoints(repositoryRoot) : undefined,
          coreDatabaseId,
        });
        if (consumer.mode === "d1") consumerStepIds.push(step.id);
      }
      if (creating)
        validatePrivateWorkerConfiguration({
          environment: manifest.environment,
          profile: step.profile,
          configuration,
        });
      if (isPreviewRuntimeWorkerStep(step))
        validatePreviewRuntimeConfiguration({
          environment: manifest.environment,
          configuration,
          repositoryRoot,
        });
      if (configuration.account_id !== manifest.accountId)
        throw new Error("Release Worker belongs to another Cloudflare account");
      if (configuration.containers !== undefined && step.containerImages === undefined)
        throw new Error("Container release requires a retained image receipt path");
      const proof = rehearsed?.value.workers[step.id];
      if (rehearsed !== null && proof === undefined)
        throw new Error("Release rehearsal omits a Worker");
      if (creating && proof === undefined)
        throw new Error("Private Worker creation requires an exact local rehearsal");
      const evidence = creating ? privateWorkerEvidence({ step }) : undefined;
      let reused;
      if (proof !== undefined)
        reused = await validateWorkerRehearsal({
          proof,
          repositoryRoot,
          sha: manifest.sourceCommit,
          workerName: step.workerName,
          configPath,
          run,
          configuration,
          ...(creating ? { privateWorker: evidence } : {}),
        });
      const described = creating
        ? describePrivateWorker({
            step,
            environment: manifest.environment,
            sourceCommit: manifest.sourceCommit,
            configuration,
            reused,
            proof,
          })
        : undefined;
      workers[step.id] = {
        configuration,
        proof,
        ...(described === undefined ? {} : { private: described }),
      };
      fingerprint.push({
        id: step.id,
        configurationSha256: releaseHash(JSON.stringify(configuration)),
        ...(proof === undefined ? {} : { proofSha256: releaseHash(JSON.stringify(proof)) }),
        ...(described === undefined
          ? {}
          : {
              private: {
                profile: step.profile,
                creationId: step.creationId,
                bindingsSha256: described.bindingsSha256,
              },
            }),
      });
    } else {
      const prepared = await prepareClientPrerequisite({
        step,
        sha: manifest.sourceCommit,
        repositoryRoot,
        run,
      });
      fingerprint.push({ id: step.id, sha256: prepared.digest });
    }
  }
  requireControlCoreBeforeConsumers({ manifest, consumerStepIds });
  requireAtomicDevGatewayChain({ manifest, workers });
  if (
    rehearsed !== null &&
    Object.keys(rehearsed.value.workers).length !== Object.keys(workers).length
  )
    throw new Error("Release rehearsal includes a different Worker set");
  let protectedControl;
  let development;
  if (manifest.steps.some(isPrivateWorkerStep)) {
    // The environment's Control Worker is observed as protected; its source bytes are approved.
    protectedControl = await protectedControlIdentity({
      environment: manifest.environment,
      repositoryRoot,
      accountId: manifest.accountId,
    });
    fingerprint.push({
      id: "protected-control",
      workerName: protectedControl.workerName,
      configSha256: protectedControl.configSha256,
    });
  }
  if (manifest.developmentReference !== undefined) {
    development = await prepareDevelopmentReference({ manifest, repositoryRoot, run });
    fingerprint.push({ id: "development-creation", ...development.evidence });
  }
  return {
    fingerprint: releaseHash(JSON.stringify(fingerprint)),
    workers,
    ...(protectedControl === undefined ? {} : { protectedControl }),
    ...(development === undefined ? {} : { development }),
  };
}

/**
 * Production creation is bound to a private, completed Development train: its secret-free manifest
 * and state bytes are hashed into the approval and its evidence is validated with the same helpers.
 * Only Broker-only creation may use an older ancestral bootstrap; live readback happens later.
 */
/** Production may cite only completed Development creation of the same selected profiles. */
export function validateCreationProfileCorrespondence(development, production) {
  const profiles = (manifest) =>
    manifest.steps
      .filter(isPrivateWorkerStep)
      .map(({ profile }) => profile)
      .sort();
  if (!isDeepStrictEqual(profiles(development), profiles(production)))
    throw new Error("Development creation profiles differ from Production");
}

async function prepareDevelopmentReference({ manifest, repositoryRoot, run }) {
  const reference = manifest.developmentReference;
  if ((await realpath(reference.manifest)) === (await realpath(reference.state)))
    throw new Error("Development reference manifest and state must be distinct files");
  const [manifestFile, stateFile] = await Promise.all([
    stat(reference.manifest),
    stat(reference.state),
  ]);
  if (manifestFile.dev === stateFile.dev && manifestFile.ino === stateFile.ino)
    throw new Error("Development reference manifest and state cannot be filesystem aliases");
  const retainedManifest = await readPrivateReleaseJson(reference.manifest);
  const retainedState = await readPrivateReleaseJson(reference.state, {
    maxBytes: 4 * 1024 * 1024,
  });
  const developmentManifest = validateTrainManifest(retainedManifest.value);
  const state = retainedState.value;
  const created = developmentManifest.steps.filter(isPrivateWorkerStep);
  const developmentPreview = developmentManifest.steps.filter(isPreviewRuntimeWorkerStep);
  const productionPreview = manifest.steps.some(isPreviewRuntimeWorkerStep);
  const productionCreated = manifest.steps.filter(isPrivateWorkerStep);
  if (productionCreated.length > 0)
    validateCreationProfileCorrespondence(developmentManifest, manifest);
  const olderBrokerBootstrap = developmentManifest.sourceCommit !== manifest.sourceCommit;
  if (olderBrokerBootstrap) {
    if (
      created.length !== 1 ||
      created[0].profile !== "connection_broker" ||
      productionCreated.length !== 1 ||
      productionCreated[0].profile !== "connection_broker" ||
      developmentPreview.length !== 0 ||
      productionPreview
    )
      throw new Error("Development creation reference is stale, foreign or reused");
    try {
      await run(
        "git",
        ["merge-base", "--is-ancestor", developmentManifest.sourceCommit, manifest.sourceCommit],
        {
          cwd: repositoryRoot,
          localOnly: true,
        },
      );
    } catch {
      throw new Error("Development Broker bootstrap source is not an ancestor");
    }
  }
  if (
    developmentManifest.environment !== "development" ||
    developmentManifest.accountId !== manifest.accountId ||
    (created.length === 0 && developmentPreview.length === 0) ||
    (productionPreview && developmentPreview.length !== 1) ||
    productionCreated.some(
      (step) => !created.some((development) => development.profile === step.profile),
    ) ||
    created.some(({ creationId }) =>
      manifest.steps.some((candidate) => candidate.creationId === creationId),
    )
  )
    throw new Error("Development creation reference is stale, foreign or reused");
  if (
    !fields(state, STATE_FIELDS, STATE_FIELDS) ||
    state.schemaVersion !== 1 ||
    state.manifestSha256 !== manifestDigest(developmentManifest) ||
    state.sourceCommit !== developmentManifest.sourceCommit ||
    state.environment !== "development" ||
    state.status !== "completed" ||
    !HASH.test(state.preparationSha256 ?? "") ||
    state.approvalSha256 !==
      releaseApprovalDigest({
        manifest: developmentManifest,
        preparationSha256: state.preparationSha256,
      }) ||
    !object(state.after) ||
    !Number.isSafeInteger(state.ciRun) ||
    state.ciRun < 1 ||
    !object(state.steps) ||
    Object.keys(state.steps).length !== developmentManifest.steps.length
  )
    throw new Error("Development creation state is not a completed train of its manifest");
  for (const step of developmentManifest.steps) {
    const prior = state.steps[step.id];
    if (
      !fields(prior, ["status", "receipt"], ["status", "receipt"]) ||
      prior.status !== "completed"
    )
      throw new Error("Development creation step is not completed");
    validateReceipt(prior.receipt, step, developmentManifest.sourceCommit);
  }
  if (
    !closedTransition({
      baseline: state.baseline,
      observation: state.after,
      manifest: developmentManifest,
      steps: state.steps,
    })
  )
    throw new Error("Development creation retained protected ingress or schedules are invalid");
  const prepared = await prepareReleaseTrain({
    manifest: developmentManifest,
    repositoryRoot,
    run,
    evidenceOnly: true,
  });
  if (prepared.fingerprint !== state.preparationSha256)
    throw new Error("Development creation preparation differs from its completed train");
  return {
    manifest: developmentManifest,
    state,
    prepared,
    evidence: {
      manifestSha256: releaseHash(retainedManifest.contents),
      stateSha256: releaseHash(retainedState.contents),
      preparationSha256: state.preparationSha256,
    },
  };
}

async function acquireStateLock(path, manifest) {
  const contents = `${JSON.stringify({ pid: process.pid, manifestSha256: manifestDigest(manifest) })}\n`;
  let handle;
  try {
    handle = await open(
      `${path}.lock`,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error("Release state lock cannot be acquired");
    // Never read/compare/unlink a presumed stale owner: two resumers could delete a new lock.
    // A hard-kill recovery must remove the audited old lock with every runner stopped first.
    throw new Error(
      "Release state lock already exists; stop every runner before audited lock recovery",
    );
  }
  await handle.writeFile(contents);
  await handle.sync();
  return async () => {
    await handle.close();
    await rm(`${path}.lock`, { force: true });
  };
}

async function persistState(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validateReceipt(receipt, step, sha) {
  const sourceCommit = step.kind === "clients" ? (step.sourceCommit ?? sha) : sha;
  if (
    !object(receipt) ||
    (receipt.sourceCommit !== undefined && receipt.sourceCommit !== sourceCommit)
  )
    throw new Error("Release step receipt source is invalid");
  if (isPrivateWorkerStep(step)) {
    validatePrivateWorkerReceipt(receipt, step, sha);
  } else if (step.kind === "worker") {
    if (
      !fields(
        receipt,
        [
          "cronTriggers",
          "containers",
          "deploymentVerified",
          "sha",
          "uploaded",
          "versionId",
          "workerName",
          "tag",
          "message",
        ],
        ["deploymentVerified", "sha", "versionId", "workerName", "cronTriggers", "tag", "message"],
      ) ||
      receipt.deploymentVerified !== true ||
      receipt.sha !== sha ||
      receipt.workerName !== step.workerName ||
      !UUID.test(receipt.versionId ?? "") ||
      !["preserved", "updated", "unchanged"].includes(receipt.cronTriggers) ||
      (receipt.containers !== undefined &&
        (!Array.isArray(receipt.containers) ||
          receipt.containers.some(
            (container) =>
              !(container?.policy === "durable_object"
                ? fields(
                    container,
                    ["applicationId", "image", "imageBinding", "workerVersionId", "policy"],
                    ["applicationId", "image", "imageBinding", "workerVersionId", "policy"],
                  ) &&
                  /^[a-z][a-z0-9_-]{0,31}$/u.test(container.imageBinding ?? "") &&
                  container.workerVersionId === receipt.versionId
                : fields(
                    container,
                    ["applicationId", "image", "rolloutId"],
                    ["applicationId", "image", "rolloutId"],
                  ) && UUID.test(container.rolloutId ?? "")) ||
              !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.test(
                container.applicationId ?? "",
              ) ||
              !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/ohmyho-release-[a-f0-9]{16}@sha256:[a-f0-9]{64}$/u.test(
                container.image ?? "",
              ),
          )))
    )
      throw new Error("Worker release receipt is invalid");
    if (
      isPreviewRuntimeWorkerStep(step) &&
      (!Array.isArray(receipt.containers) ||
        receipt.containers.length !== 1 ||
        receipt.containers[0].policy !== "durable_object" ||
        receipt.containers[0].imageBinding !== "preview" ||
        receipt.containers[0].workerVersionId !== receipt.versionId)
    )
      throw new Error("Preview Runtime requires its exact named-container receipt");
  } else if (
    !fields(
      receipt,
      ["sourceCommit", "version", "verified"],
      ["sourceCommit", "version", "verified"],
    ) ||
    receipt.sourceCommit !== sourceCommit ||
    receipt.version !== step.version ||
    !Array.isArray(receipt.verified) ||
    !isDeepStrictEqual([...receipt.verified].sort(), [...PACKAGES].sort())
  )
    throw new Error("Client release receipt is invalid");
}

/** The ids of the steps a train still has to release; a completed train has none. */
function unfinishedStepIds(manifest, state) {
  if (state?.status === "completed") return [];
  return manifest.steps
    .filter(({ id }) => state?.steps?.[id]?.status !== "completed")
    .map(({ id }) => id);
}

export async function executeReleaseTrain({
  manifest,
  statePath,
  approval,
  environment,
  cwd = process.cwd(),
  run = runReleaseCommand,
  wrangler = process.env.WRANGLER_BIN ?? "/opt/homebrew/bin/wrangler",
  env = process.env,
  inspectRepository = inspectReleaseRepository,
  verifyCommit = requireVerifiedCommit,
  prepare = prepareReleaseTrain,
  observeIngress = observeReleaseIngress,
  observePolicy = observePolicyCohort,
  release = releaseWorker,
  verifyCompleted = verifyCompletedStep,
  prerequisites = executePrerequisite,
  fetch = globalThis.fetch,
  createPrivate = createPrivateWorker,
  verifyDevelopment = verifyDevelopmentCreation,
}) {
  validateTrainManifest(manifest);
  if (
    manifest.developmentReference !== undefined &&
    [manifest.developmentReference.manifest, manifest.developmentReference.state].some(
      (path) => resolve(path) === resolve(statePath),
    )
  )
    throw new Error("Production release state cannot alias its Development reference");
  if (manifest.developmentReference !== undefined) {
    const target = await stat(statePath).catch(() => null);
    if (target !== null) {
      const files = await Promise.all(
        Object.values(manifest.developmentReference).map((path) => stat(path)),
      );
      if (files.some((file) => file.dev === target.dev && file.ino === target.ino))
        throw new Error("Production release state cannot alias its Development reference");
    }
  }

  if (!HASH.test(approval ?? ""))
    throw new Error("Release approval must name the exact manifest and preparation digest");
  if (environment !== manifest.environment)
    throw new Error("Release environment scope differs from approval");
  const repository = await inspectRepository({ cwd, run });
  if (repository.sha !== manifest.sourceCommit)
    throw new Error("Release source differs from the manifest");
  // The production implementation also requires private state outside the clean source checkout.
  if (inspectRepository === inspectReleaseRepository)
    await requirePrivateReleaseDirectory(dirname(resolve(statePath)), repository.repositoryRoot);
  const unlock = await acquireStateLock(resolve(statePath), manifest);
  let state;
  // Only a state this run created, or one it has validated against this manifest, is ours to rewrite.
  let owned = false;
  // A state validated as completed is never moved to running or interrupted again by this run.
  let wasCompleted = false;
  try {
    // A completed train is only re-verified, and a completed step is never re-released: only the unfinished Core
    // steps of a resumed train are checked against the live Core schema head.
    const priorState = await readPrivateReleaseJson(statePath, {
      optional: true,
      maxBytes: 4 * 1024 * 1024,
    });
    const prepared = await prepare({
      manifest,
      repositoryRoot: repository.repositoryRoot,
      run,
      coreHeadStepIds: unfinishedStepIds(manifest, priorState?.value),
    });
    const approvalSha256 = releaseApprovalDigest({
      manifest,
      preparationSha256: prepared.fingerprint,
    });
    if (approval !== approvalSha256)
      throw new Error("Release approval differs from the exact validated manifest and preparation");
    const existing = await readPrivateReleaseJson(statePath, {
      optional: true,
      maxBytes: 4 * 1024 * 1024,
    });
    owned = existing === null || existing === undefined;
    state = existing?.value ?? {
      schemaVersion: 1,
      manifestSha256: manifestDigest(manifest),
      sourceCommit: repository.sha,
      environment,
      preparationSha256: prepared.fingerprint,
      approvalSha256,
      status: "pending",
      ciRun: null,
      baseline: null,
      after: null,
      steps: {},
    };
    if (
      !fields(state, STATE_FIELDS, STATE_FIELDS) ||
      state.schemaVersion !== 1 ||
      state.manifestSha256 !== manifestDigest(manifest) ||
      state.sourceCommit !== repository.sha ||
      state.environment !== environment ||
      !object(state.steps) ||
      Object.keys(state.steps).some((id) => !manifest.steps.some((step) => step.id === id))
    )
      throw new Error("Release state manifest or source differs");
    if (state.preparationSha256 !== prepared.fingerprint)
      throw new Error("Release immutable preparation changed on resume");
    if (state.approvalSha256 !== approvalSha256)
      throw new Error("Release immutable approval changed on resume");
    owned = true;
    wasCompleted = state.status === "completed";
    for (const step of manifest.steps) {
      const prior = state.steps[step.id];
      if (
        prior !== undefined &&
        (!fields(prior, ["status", "receipt", "creation"], ["status"]) ||
          !["running", "completed"].includes(prior.status) ||
          // Durable creation progress belongs only to a running creation step.
          (prior.creation !== undefined &&
            (!isPrivateWorkerStep(step) || prior.status !== "running")))
      )
        throw new Error("Release step state is invalid");
      if (prior?.creation !== undefined)
        validateCreationProgress(
          prior.creation,
          creationBinding({
            approvalSha256,
            sourceCommit: repository.sha,
            step,
            described: prepared.workers[step.id].private,
          }),
        );
      if (prior?.status === "completed") validateReceipt(prior.receipt, step, repository.sha);
    }
    // This reuses the exact existing CI run/watch; no provider read or write precedes its green gate.
    const ciRun = await verifyCommit({
      sha: repository.sha,
      ...(repository.branch === undefined ? {} : { ref: repository.branch }),
      run,
      preferredRunId: state.ciRun ?? undefined,
    });
    if (
      !Number.isSafeInteger(ciRun) ||
      ciRun < 1 ||
      (state.ciRun !== null && state.ciRun !== ciRun)
    )
      throw new Error("Release CI evidence changed or is invalid");
    state.ciRun = ciRun;
    if (
      prepared.development !== undefined &&
      prepared.development.manifest.sourceCommit !== repository.sha
    ) {
      const originalRun = await verifyCommit({
        sha: prepared.development.manifest.sourceCommit,
        run,
        existingOnly: true,
        preferredRunId: prepared.development.state.ciRun,
      });
      if (originalRun !== prepared.development.state.ciRun)
        throw new Error("Development Broker bootstrap CI evidence changed");
    }
    for (const step of manifest.steps.filter(
      ({ kind, sourceCommit }) => kind === "clients" && sourceCommit !== undefined,
    ))
      if (step.sourceCommit !== repository.sha)
        await requireVerifiedCommit({ sha: step.sourceCommit, run, existingOnly: true });
    const context = {
      manifest,
      repositoryRoot: repository.repositoryRoot,
      prepared,
      run,
      wrangler,
      env,
      fetch,
      prerequisites,
    };
    const before = await observeIngress(context);
    // Refuse a known schedule/ingress change before the existing Worker release can apply it.
    // A post-release comparison alone would report damage after a cron list was emptied.
    // A creation step has no live Worker yet: its closed transition is checked below instead.
    for (const step of manifest.steps.filter(
      (candidate) => candidate.kind === "worker" && !isPrivateWorkerStep(candidate),
    )) {
      const configuration = prepared.workers?.[step.id]?.configuration;
      if (configuration === undefined) continue;
      const live = before.workers.find(({ workerName }) => workerName === step.workerName);
      const declared = configuration.triggers?.crons;
      if (
        isNativeRegionalWorkerStep(step) &&
        (configuration.workers_dev !== false ||
          configuration.preview_urls !== false ||
          (declared !== undefined && (!Array.isArray(declared) || declared.length !== 0)) ||
          configuration.route !== undefined ||
          (configuration.routes !== undefined &&
            (!Array.isArray(configuration.routes) || configuration.routes.length !== 0)))
      )
        throw new Error("Native regional Worker must have no ingress or schedules");
      if (
        isPreviewRuntimeWorkerStep(step) &&
        (configuration.workers_dev !== false ||
          configuration.preview_urls !== false ||
          !isDeepStrictEqual(declared, ["*/1 * * * *"]) ||
          configuration.route !== undefined ||
          (configuration.routes !== undefined &&
            (!Array.isArray(configuration.routes) || configuration.routes.length !== 0)))
      )
        throw new Error("Preview Runtime must retain its private one-minute schedule");
      // A Core Worker that does not exist yet has no ingress or schedules to protect; its creation is the step.
      if (
        live?.presence?.kind === "absent" &&
        (isControlCoreStep(step) ||
          isNativeRegionalWorkerStep(step) ||
          isPreviewRuntimeWorkerStep(step))
      )
        continue;
      if (
        live === undefined ||
        configuration.workers_dev !== live.subdomain.enabled ||
        configuration.preview_urls !== live.subdomain.previews_enabled ||
        (declared !== undefined && !isDeepStrictEqual([...declared].sort(), live.crons))
      )
        throw new Error("Release configuration would change existing ingress or schedules");
    }
    // Without a creation the baseline must stay exactly equal; with one, only the creation entries
    // may move from their original absence to the declared private target, under durable progress.
    const unchanged = (observation) =>
      manifest.steps.some(
        (step) =>
          isPrivateWorkerStep(step) ||
          isControlCoreStep(step) ||
          isNativeRegionalWorkerStep(step) ||
          isPreviewRuntimeWorkerStep(step),
      )
        ? closedTransition({ baseline: state.baseline, observation, manifest, steps: state.steps })
        : isDeepStrictEqual(state.baseline, observation);
    if (state.baseline === null) {
      requireInitialAbsence({ observation: before, manifest });
      state.baseline = before;
    } else if (!unchanged(before)) {
      throw new Error("Release ingress or schedules changed before resume");
    }
    // Live policy values change by design, so they are observed again on every run and resume.
    requirePolicyCohort({ manifest, observation: await observePolicy(context), phase: "before" });
    // Production creation proves the completed Development creation live before any mutation.
    if (prepared.development !== undefined) await verifyDevelopment(context);
    if (!wasCompleted) {
      state.status = "running";
      await persistState(statePath, state);
    }
    for (const step of manifest.steps) {
      if (step.dependsOn.some((id) => state.steps[id]?.status !== "completed"))
        throw new Error("Release dependency is incomplete");
      const prior = state.steps[step.id];
      if (prior?.status === "completed") {
        await verifyCompleted({ ...context, step, receipt: prior.receipt });
        continue;
      }
      // Durable creation progress survives a restart: a resume never starts from a blank step.
      state.steps[step.id] = {
        status: "running",
        ...(prior?.creation === undefined ? {} : { creation: prior.creation }),
      };
      await persistState(statePath, state);
      let receipt;
      try {
        let clientPrerequisite;
        if (step.kind === "worker" && step.workerName === "ohmyho-public-production") {
          const version = JSON.parse(
            await readFile(
              join(repository.repositoryRoot, "apps/product-cli/package.json"),
              "utf8",
            ),
          ).version;
          const proof = prepared.workers?.[step.id]?.proof;
          const assets =
            proof?.assets?.directory ?? prepared.workers?.[step.id]?.configuration.assets.directory;
          const sourceCommit = JSON.parse(
            await readFile(join(assets, "releases", version, "manifest.json"), "utf8"),
          ).source_commit;
          const candidates = manifest.steps.filter(
            (candidate) =>
              candidate.kind === "clients" &&
              candidate.action === "verify" &&
              candidate.sourceCommit === sourceCommit &&
              candidate.version === version &&
              state.steps[candidate.id]?.status === "completed",
          );
          if (candidates.length > 1)
            throw new Error("Public client recovery prerequisite is ambiguous");
          [clientPrerequisite] = candidates;
        }
        if (isPrivateWorkerStep(step))
          receipt = await createPrivate({
            step,
            environment,
            accountId: manifest.accountId,
            sourceCommit: repository.sha,
            approvalSha256,
            repositoryRoot: repository.repositoryRoot,
            configPath: resolve(repository.repositoryRoot, step.config),
            prepared: prepared.workers[step.id],
            progress: state.steps[step.id].creation,
            // Persisted through the same fsync/rename path, and never moved backwards.
            checkpoint: async (next) => {
              assertForwardProgress(state.steps[step.id].creation, next);
              state.steps[step.id] = { status: "running", creation: next };
              await persistState(statePath, state);
            },
            run,
            wrangler,
            fetch,
          });
        else {
          const bootstrapPreview =
            isPreviewRuntimeWorkerStep(step) &&
            isAbsentEntry(
              state.baseline.workers.find(({ workerName }) => workerName === step.workerName),
              manifest.accountId,
            ) &&
            (prior === undefined || prior.status === "running");
          if (bootstrapPreview && step.secretsFile === undefined)
            throw new Error("First Preview Runtime creation requires its exact secret input");
          receipt =
            step.kind === "worker"
              ? await release({
                  configPath: resolve(repository.repositoryRoot, step.config),
                  cwd: repository.repositoryRoot,
                  expectedName: step.workerName,
                  run,
                  wrangler,
                  fetch,
                  env,
                  secretsFile: step.secretsFile,
                  containerImages: step.containerImages,
                  ...(bootstrapPreview ? { allowContainerBootstrap: true } : {}),
                  rehearsal: prepared.workers?.[step.id]?.proof,
                  clientPrerequisite,
                  coreDatabaseId: coreDatabaseIdOf(manifest),
                  core: isControlCoreStep(step)
                    ? controlCoreRenderInput({
                        step,
                        accountId: manifest.accountId,
                        sourceCommit: repository.sha,
                        repositoryRoot: repository.repositoryRoot,
                      })
                    : undefined,
                })
              : await prerequisites({ ...context, step });
        }
      } catch {
        throw new Error(
          `Release step ${step.id} is incomplete; resume its original state after readback`,
        );
      }
      validateReceipt(receipt, step, repository.sha);
      state.steps[step.id] = { status: "completed", receipt };
      await persistState(statePath, state);
    }
    const after = await observeIngress(context);
    if (!unchanged(after)) throw new Error("Release ingress or schedules drifted");
    const cohort = requirePolicyCohort({
      manifest,
      observation: await observePolicy(context),
      phase: "after",
    });
    state.after = after;
    state.status = "completed";
    await persistState(statePath, state);
    return {
      sourceCommit: repository.sha,
      environment,
      ciRun,
      completed: manifest.steps.map(({ id }) => id),
      ingressAndSchedulesPreserved: true,
      policySha256: cohort.policySha256,
      policyConsumers: cohort.consumers,
    };
  } catch (error) {
    // A completed train stays completed when only its read-only re-verification fails.
    if (state !== undefined && owned && !wasCompleted) {
      state.status = "interrupted";
      await persistState(statePath, state);
    }
    throw error;
  } finally {
    await unlock();
  }
}

export async function observeReleaseIngress({
  manifest,
  run = runReleaseCommand,
  wrangler,
  fetch = globalThis.fetch,
}) {
  if (!manifest.steps.some(({ kind }) => kind === "worker"))
    return { domains: [], routes: [], workers: [] };
  const request = await providerReader({ run, wrangler, fetch, label: "ingress" });
  const created = manifest.steps.filter(isPrivateWorkerStep);
  // The Core Worker may not exist yet: the train creates it with its first step, so its absence is a typed fact too.
  const creatable = [
    ...created,
    ...manifest.steps.filter(
      (step) =>
        isControlCoreStep(step) ||
        isNativeRegionalWorkerStep(step) ||
        isPreviewRuntimeWorkerStep(step),
    ),
  ];
  // The environment's Control Worker is protected whenever a creation is present, deployed or not.
  const names = [
    ...new Set([
      ...manifest.steps.filter(({ kind }) => kind === "worker").map(({ workerName }) => workerName),
      ...(created.length === 0 ? [] : [protectedControlName(manifest.environment)]),
    ]),
  ].sort();
  // Presence of a creation is its own typed, scoped observation: absence is never inferred from
  // a failed ingress read, and an unavailable answer is an error.
  const observePresence =
    creatable.length === 0 ? null : await createWorkerPresenceObserver({ run, wrangler, fetch });
  const account = `/accounts/${manifest.accountId}`;
  const domains = (await request(`${account}/workers/domains`, { paginated: true }))
    .filter((row) => names.includes(row.service))
    .map(({ id, hostname, service, environment, zone_id }) => ({
      id,
      hostname,
      service,
      environment,
      zone_id,
    }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  const zones = await request(`/zones?account.id=${manifest.accountId}`, { paginated: true });
  const zoneIds = new Set();
  const zonesByName = new Map();
  for (const zone of zones) {
    if (
      !/^[a-f0-9]{32}$/u.test(zone?.id ?? "") ||
      zone?.account?.id !== manifest.accountId ||
      typeof zone.name !== "string" ||
      zone.name.length > 253 ||
      zone.name
        .split(".")
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      zoneIds.has(zone.id) ||
      zonesByName.has(zone.name)
    )
      throw new Error("Release zone identity is invalid or ambiguous");
    zoneIds.add(zone.id);
    zonesByName.set(zone.name, zone.id);
  }
  const routes = [];
  const routeIds = new Set();
  const addRoute = (route, zoneId, workerName) => {
    if (
      !object(route) ||
      !/^[a-f0-9]{32}$/u.test(route.id ?? "") ||
      typeof route.pattern !== "string" ||
      route.pattern.length === 0 ||
      route.pattern.length > 8192 ||
      route.pattern.trim() !== route.pattern ||
      /\p{Cc}/u.test(route.pattern) ||
      route.script !== workerName ||
      !zoneIds.has(zoneId) ||
      (route.zone_id !== undefined && route.zone_id !== zoneId) ||
      (route.environment !== undefined && route.environment !== "production") ||
      (route.service !== undefined && route.service !== workerName) ||
      routeIds.has(`${zoneId}:${route.id}`)
    )
      throw new Error("Release Worker route identity is invalid or ambiguous");
    routeIds.add(`${zoneId}:${route.id}`);
    routes.push({ zoneId, id: route.id, pattern: route.pattern, script: workerName });
  };
  // Explicit private creations retain the original zone-wide orphan-reference proof for their
  // entire train, including resume/after. A missing service cannot prove an empty route list.
  if (creatable.length > 0) {
    for (const zone of zones)
      for (const route of await request(`/zones/${zone.id}/workers/routes`, { paginated: true }))
        if (creatable.some(({ workerName }) => workerName === route?.script))
          addRoute(route, zone.id, route.script);
  }
  const workers = [];
  for (const workerName of names) {
    if (creatable.some((step) => step.workerName === workerName)) {
      const presence = await observePresence({ accountId: manifest.accountId, workerName });
      if (presence.kind === "absent") {
        if (
          domains.some((domain) => domain.service === workerName) ||
          routes.some((route) => route.script === workerName)
        )
          throw new Error("Release absent private Worker retains ingress references");
        workers.push({ workerName, presence });
        continue;
      }
    }
    if (!created.some((step) => step.workerName === workerName)) {
      const servicePrefix = `${account}/workers/services/${workerName}`;
      const service = await request(servicePrefix);
      // OMH Dev and Prod are distinct Worker names, each using Cloudflare's production service
      // environment. Confirm that alias rather than confusing it with the OMH environment.
      if (
        service?.id !== workerName ||
        service?.default_environment?.environment !== "production" ||
        service?.default_environment?.script?.id !== workerName
      )
        throw new Error("Release Worker service environment identity differs");
      const assigned = await request(
        `${servicePrefix}/environments/production/routes?show_zonename=true`,
        {
          completeList: true,
        },
      );
      for (const route of assigned) addRoute(route, zonesByName.get(route?.zone_name), workerName);
    }
    const prefix = `${account}/workers/scripts/${workerName}`;
    const subdomain = await request(`${prefix}/subdomain`);
    const schedules = await request(`${prefix}/schedules`);
    if (
      typeof subdomain?.enabled !== "boolean" ||
      typeof subdomain?.previews_enabled !== "boolean" ||
      !Array.isArray(schedules?.schedules) ||
      schedules.schedules.some((row) => typeof row.cron !== "string")
    )
      throw new Error("Release Worker ingress or schedules are invalid");
    workers.push({
      workerName,
      subdomain: { enabled: subdomain.enabled, previews_enabled: subdomain.previews_enabled },
      crons: schedules.schedules.map(({ cron }) => cron).sort(),
    });
  }
  routes.sort((a, b) => `${a.zoneId}:${a.id}`.localeCompare(`${b.zoneId}:${b.id}`));
  return { domains, routes, workers };
}

/**
 * Read-only: the Development creation named by a Production creation must still be provable.
 * Only the Broker may have completed ordinary activation at the exact Production source, with
 * exact secret names/bindings and the reviewed callback hostname.
 * Historical creation provenance, private subdomains and schedules are still read back.
 */
export async function verifyDevelopmentCreation({
  manifest: productionManifest,
  prepared,
  repositoryRoot,
  run,
  wrangler,
  fetch,
}) {
  const { manifest, state, prepared: preparation } = prepared.development;
  const created = manifest.steps.filter(isPrivateWorkerStep);
  const activated = new Set();
  for (const step of created) {
    const result = await verifyPrivateWorkerReceipt({
      receipt: state.steps[step.id].receipt,
      step,
      environment: manifest.environment,
      accountId: manifest.accountId,
      sourceCommit: manifest.sourceCommit,
      repositoryRoot,
      configPath: resolve(repositoryRoot, step.config),
      prepared: preparation.workers[step.id],
      run,
      wrangler,
      fetch,
      allowDevelopmentBrokerActivation: step.profile === "connection_broker",
      ...(step.profile === "connection_broker"
        ? { activatedSourceCommit: productionManifest.sourceCommit }
        : {}),
    });
    if (result.activated) activated.add(step.workerName);
  }
  const previews = manifest.steps.filter(isPreviewRuntimeWorkerStep);
  for (const step of previews)
    await verifyCompletedStep({
      manifest,
      step,
      receipt: state.steps[step.id].receipt,
      prepared: preparation,
      repositoryRoot,
      run,
      wrangler,
      fetch,
      env: process.env,
    });
  const names = [...created, ...previews].map(({ workerName }) => workerName);
  const live = await observeReleaseIngress({ manifest, run, wrangler, fetch });
  for (const name of activated) {
    const domains = live.domains.filter(({ service }) => service === name);
    if (
      domains.length !== 1 ||
      domains[0].hostname !== "dev.connect.ohmyho.st" ||
      domains[0].environment !== "production" ||
      !/^[a-f0-9]{32}$/u.test(domains[0].zone_id ?? "")
    )
      throw new Error(
        "Development Broker activation requires its exact reviewed callback hostname",
      );
  }
  if (
    live.domains.some(({ service }) => names.includes(service) && !activated.has(service)) ||
    live.routes.some(({ script }) => names.includes(script))
  )
    throw new Error("Development creation has public ingress");
  // Only the reviewed activated Broker domain may differ from the private creation baseline.
  const baselineComparable = {
    ...live,
    domains: live.domains.filter(({ service }) => !activated.has(service)),
  };
  if (
    !closedTransition({
      baseline: state.baseline,
      observation: baselineComparable,
      manifest,
      steps: state.steps,
    })
  )
    throw new Error("Development creation protected ingress or schedules drifted");
}

export async function executePrerequisite({
  step,
  manifest,
  repositoryRoot,
  run,
  env,
  verifyOnly = false,
  fetch = globalThis.fetch,
}) {
  const prepared = await prepareClientPrerequisite({
    step,
    sha: manifest.sourceCommit,
    repositoryRoot,
    run,
  });
  if (prepared.manifest.sourceCommit !== manifest.sourceCommit)
    await requireVerifiedCommit({ sha: prepared.manifest.sourceCommit, run, existingOnly: true });
  if (!verifyOnly && step.action === "publish") {
    const token = env.NPM_PUBLISH_TOKEN;
    if (typeof token !== "string" || !/^[\x21-\x7e]+$/u.test(token))
      throw new Error("Client publish credential is unavailable");
    const result = await publishNpmClients({
      directory: step.directory,
      token,
      fetch,
      run,
      verifyCommit: (sha) => requireVerifiedCommit({ sha, run }),
    });
    if (result.pending.length !== 0 || result.verified.length !== PACKAGES.length)
      throw new Error("Client registry propagation is incomplete");
  }
  await verifyClientRegistryArtifacts({ manifest: prepared.manifest, fetch });
  return {
    sourceCommit: prepared.manifest.sourceCommit,
    version: step.version,
    verified: [...PACKAGES].sort(),
  };
}

export async function verifyCompletedStep(context) {
  const { step, receipt, prepared, repositoryRoot, run, wrangler, env } = context;
  if (step.kind !== "worker") {
    const observed = await (context.prerequisites ?? executePrerequisite)({
      ...context,
      verifyOnly: true,
    });
    if (!isDeepStrictEqual(receipt, observed))
      throw new Error("Completed release prerequisite drifted");
    return;
  }
  if (isPrivateWorkerStep(step)) {
    // Completed replay is read-only: it never uploads, deploys or changes a schedule.
    await verifyPrivateWorkerReceipt({
      receipt,
      step,
      environment: context.manifest.environment,
      accountId: context.manifest.accountId,
      sourceCommit: context.manifest.sourceCommit,
      repositoryRoot,
      configPath: resolve(repositoryRoot, step.config),
      prepared: prepared.workers[step.id],
      run,
      wrangler,
      fetch: context.fetch,
    });
    return;
  }
  const configuration = prepared.workers[step.id].configuration;
  await verifyWorkerReleaseReceipt({
    receipt,
    configuration,
    configPath: resolve(repositoryRoot, step.config),
    repositoryRoot,
    run,
    wrangler,
    fetch: context.fetch,
    env,
    sourceSha: context.manifest.sourceCommit,
    rehearsal: prepared.workers[step.id].proof,
  });
}
