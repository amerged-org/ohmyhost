/* global process */

import { constants as fsConstants } from "node:fs";
import { Buffer } from "node:buffer";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  createManagementRuntimeContract,
  isManagementRuntimeContract,
} from "../apps/workos-management/scripts/runtime-contract.mjs";
import { sha256, validateCandidateArtifact } from "./phase1-evidence-core.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const WORKOS_APPLICATION_ID = /^connect_app_[0-9A-HJKMNP-TV-Z]{26}$/u;
const WORKOS_CLIENT_ID = /^client_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SOURCE = "apps/workos-management/dist/worker-bundle/worker-main.js";

const invalid = () => new Error("INVALID_WORKOS_MANAGEMENT_DEPLOYMENT");
const invalidReceipt = () => new Error("INVALID_WORKOS_MANAGEMENT_VERSION_RECEIPT");

const canonicalTimestamp = (value) => {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

export const parseWranglerDeployOutput = (serialized, contract) => {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > 65_536 ||
    serialized.includes("\0") ||
    contract?.schemaVersion !== 3 ||
    !WORKER_NAME.test(contract.controlRuntimeWorkerName ?? "") ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      contract.controlRuntimeWorkerVersionId ?? "",
    ) ||
    contract.controlRuntimeEntrypoint !== "WorkosRuntime" ||
    !["development", "production"].includes(contract.deployment) ||
    !WORKER_NAME.test(contract?.workerName ?? "") ||
    !/^[a-f0-9]{64}$/u.test(contract?.artifactSha256 ?? "") ||
    contract?.versionTag !== contract?.artifactSha256 ||
    contract?.wranglerVersion !== "4.125.0" ||
    contract?.uploadMode !== "deploy-no-bundle"
  ) {
    throw invalidReceipt();
  }
  const lines = serialized.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > 32) throw invalidReceipt();
  let session = null;
  let deployment = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw invalidReceipt();
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidReceipt();
    }
    if (entry.type === "command-failed") throw invalidReceipt();
    if (entry.type === "wrangler-session") {
      if (session !== null) throw invalidReceipt();
      session = entry;
    } else if (entry.type === "worker-deploy") {
      if (deployment !== null) throw invalidReceipt();
      deployment = entry;
    } else {
      throw invalidReceipt();
    }
  }
  if (
    session?.version !== 1 ||
    session?.wrangler_version !== contract.wranglerVersion ||
    !canonicalTimestamp(session?.timestamp) ||
    deployment?.version !== 1 ||
    deployment?.worker_name !== contract.workerName ||
    deployment?.worker_tag !== contract.versionTag ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(deployment?.version_id ?? "") ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(deployment?.deployment_id ?? "") ||
    deployment?.worker_name_overridden !== false ||
    (deployment?.preview_url !== undefined && deployment.preview_url !== null) ||
    (deployment?.preview_alias_url !== undefined && deployment.preview_alias_url !== null) ||
    !canonicalTimestamp(deployment?.timestamp) ||
    Date.parse(session.timestamp) > Date.parse(deployment.timestamp)
  ) {
    throw invalidReceipt();
  }
  return {
    schemaVersion: 3,
    workerName: contract.workerName,
    artifactSha256: contract.artifactSha256,
    versionTag: contract.versionTag,
    cloudflareDeploymentId: deployment.deployment_id,
    cloudflareWorkerVersionId: deployment.version_id,
    deployedAt: deployment.timestamp,
    deployment: contract.deployment,
    controlRuntimeWorkerName: contract.controlRuntimeWorkerName,
    controlRuntimeWorkerVersionId: contract.controlRuntimeWorkerVersionId,
    controlRuntimeEntrypoint: "WorkosRuntime",
  };
};

/**
 * Actual CF settings/100%-deployment plus an actual private profile call. A matching configuration alone is
 * never convergence. Callers collect these raw provider documents and the redacted localhost remote-binding
 * probe receipt; this function neither opens a provider connection nor grants release authority.
 */
export function verifyWorkosManagementD1Convergence(actual, contract, deploymentReceipt) {
  const failed = () => new Error("WORKOS_MANAGEMENT_CONVERGENCE_UNVERIFIED");
  const capability = createManagementRuntimeContract();
  if (
    contract?.schemaVersion !== 3 ||
    contract.controlRuntimeEntrypoint !== "WorkosRuntime" ||
    !WORKER_NAME.test(contract.controlRuntimeWorkerName ?? "") ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      contract.controlRuntimeWorkerVersionId ?? "",
    ) ||
    !["development", "production"].includes(contract.deployment) ||
    !/^[a-f0-9]{64}$/u.test(contract.artifactSha256 ?? "") ||
    contract.versionTag !== contract.artifactSha256 ||
    !WORKER_NAME.test(contract.workerName ?? "") ||
    deploymentReceipt?.schemaVersion !== 3 ||
    deploymentReceipt.workerName !== contract.workerName ||
    deploymentReceipt.artifactSha256 !== contract.artifactSha256 ||
    deploymentReceipt.controlRuntimeWorkerName !== contract.controlRuntimeWorkerName ||
    deploymentReceipt.controlRuntimeWorkerVersionId !== contract.controlRuntimeWorkerVersionId ||
    deploymentReceipt.deployment !== contract.deployment ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      deploymentReceipt.cloudflareWorkerVersionId ?? "",
    ) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
      deploymentReceipt.cloudflareDeploymentId ?? "",
    ) ||
    !canonicalTimestamp(deploymentReceipt.deployedAt) ||
    !canonicalTimestamp(actual?.observedAt) ||
    actual.workerName !== contract.workerName ||
    actual.deployment?.id !== deploymentReceipt.cloudflareDeploymentId ||
    !Array.isArray(actual.deployment?.versions) ||
    actual.deployment.versions.length !== 1 ||
    actual.deployment.versions[0].version_id !== deploymentReceipt.cloudflareWorkerVersionId ||
    actual.deployment.versions[0].percentage !== 100 ||
    actual.controlWorkerName !== contract.controlRuntimeWorkerName ||
    !Array.isArray(actual.controlDeployment?.versions) ||
    actual.controlDeployment.versions.length !== 1 ||
    actual.controlDeployment.versions[0].version_id !== contract.controlRuntimeWorkerVersionId ||
    actual.controlDeployment.versions[0].percentage !== 100 ||
    actual.subdomain?.enabled !== false ||
    actual.subdomain?.previews_enabled !== false ||
    !Array.isArray(actual.routes) ||
    actual.routes.length !== 0 ||
    !Array.isArray(actual.customDomains) ||
    actual.customDomains.length !== 0 ||
    actual.settings?.compatibility_date !== "2026-08-19" ||
    !Array.isArray(actual.settings.compatibility_flags) ||
    !actual.settings.compatibility_flags.includes("nodejs_compat") ||
    !Array.isArray(actual.settings.bindings)
  )
    throw failed();
  const bindings = new Map();
  for (const binding of actual.settings.bindings) {
    if (
      typeof binding?.name !== "string" ||
      bindings.has(binding.name) ||
      capability.forbiddenBindings.includes(binding.name) ||
      capability.forbiddenBindingTypes.includes(binding.type) ||
      capability.forbiddenBindingPatterns.some((pattern) =>
        new RegExp(pattern, "u").test(binding.name),
      )
    )
      throw failed();
    bindings.set(binding.name, binding);
  }
  if (bindings.get("CF_VERSION_METADATA")?.type !== "version_metadata") throw failed();
  const service = bindings.get("CONTROL_RUNTIME");
  if (
    service?.type !== "service" ||
    service.service !== contract.controlRuntimeWorkerName ||
    service.entrypoint !== "WorkosRuntime" ||
    (service.environment !== undefined && service.environment !== "production")
  )
    throw failed();
  const expectedKeys = [
    "MANAGEMENT_ARTIFACT_SHA256",
    "WORKOS_AUTHKIT_DOMAIN",
    "WORKOS_CONNECT_APPLICATION_ID",
    "WORKOS_CONNECT_CLIENT_ID",
    "WORKOS_DEPLOYMENT",
  ];
  // This consumer has one closed capability. Unknown aliases could otherwise retain an outbound
  // database credential even when their names do not match the historical configuration.
  const allowedNames = new Set([
    ...expectedKeys,
    "CF_VERSION_METADATA",
    "CONTROL_RUNTIME",
    "WORKOS_CONNECT_CLIENT_SECRET",
    "WORKOS_MANAGEMENT_CREDENTIAL",
  ]);
  if (
    bindings.size !== allowedNames.size ||
    [...bindings.keys()].some((name) => !allowedNames.has(name))
  )
    throw failed();
  if (
    !contract.expectedVars ||
    Object.keys(contract.expectedVars).sort().join(",") !== expectedKeys.sort().join(",") ||
    contract.expectedVars.WORKOS_DEPLOYMENT !== contract.deployment ||
    contract.expectedVars.MANAGEMENT_ARTIFACT_SHA256 !== contract.artifactSha256
  )
    throw failed();
  for (const [name, value] of Object.entries(contract.expectedVars))
    if (
      typeof value !== "string" ||
      bindings.get(name)?.type !== "plain_text" ||
      bindings.get(name).text !== value
    )
      throw failed();
  for (const name of ["WORKOS_CONNECT_CLIENT_SECRET", "WORKOS_MANAGEMENT_CREDENTIAL"])
    if (bindings.get(name)?.type !== "secret_text") throw failed();
  const proof = actual.probe;
  if (
    proof?.schemaVersion !== 3 ||
    proof.kind !== "workos-control-profile/v3" ||
    proof.state !== "verified" ||
    proof.artifactSha256 !== contract.artifactSha256 ||
    proof.versionTag !== contract.versionTag ||
    proof.cloudflareWorkerVersionId !== deploymentReceipt.cloudflareWorkerVersionId ||
    proof.deployment !== contract.deployment ||
    !canonicalTimestamp(proof.observedAt) ||
    Date.parse(proof.observedAt) < Date.parse(deploymentReceipt.deployedAt) ||
    Date.parse(proof.observedAt) > Date.parse(actual.observedAt)
  )
    throw failed();
  return {
    schemaVersion: 3,
    workerName: contract.workerName,
    cloudflareWorkerVersionId: deploymentReceipt.cloudflareWorkerVersionId,
    artifactSha256: contract.artifactSha256,
    controlRuntimeWorkerName: contract.controlRuntimeWorkerName,
    controlRuntimeWorkerVersionId: contract.controlRuntimeWorkerVersionId,
    controlRuntimeEntrypoint: "WorkosRuntime",
    deployment: contract.deployment,
    verifiedAt: actual.observedAt,
  };
}

const assertExternalEmptyDirectory = async (repositoryRoot, output) => {
  const relativeOutput = relative(repositoryRoot, output).split("\\").join("/");
  if (relativeOutput === "" || (!relativeOutput.startsWith("../") && !isAbsolute(relativeOutput))) {
    throw invalid();
  }
  try {
    const metadata = await lstat(output);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await readdir(output)).length !== 0
    ) {
      throw invalid();
    }
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
    await mkdir(output, { recursive: true, mode: 0o700 });
  }
};

const normalizedAuthkitDomain = (value) => {
  let domain;
  try {
    domain = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    domain.protocol !== "https:" ||
    !domain.hostname.endsWith(".authkit.app") ||
    domain.username !== "" ||
    domain.password !== "" ||
    domain.pathname !== "/" ||
    domain.search !== "" ||
    domain.hash !== ""
  ) {
    throw invalid();
  }
  return domain.origin;
};

export const prepareWorkosManagementDeployment = async (input) => {
  const {
    repositoryRoot,
    output,
    workerName,
    authkitDomain,
    connectApplicationId,
    connectClientId,
    controlRuntimeWorkerVersionId,
    deployment,
  } = input;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "repositoryRoot",
          "output",
          "workerName",
          "authkitDomain",
          "connectApplicationId",
          "connectClientId",
          "controlRuntimeWorkerVersionId",
          "deployment",
        ].includes(key),
    )
  )
    throw invalid();
  const root = resolve(repositoryRoot);
  const target = resolve(output);
  if (
    !WORKER_NAME.test(workerName) ||
    !WORKOS_APPLICATION_ID.test(connectApplicationId) ||
    !WORKOS_CLIENT_ID.test(connectClientId)
  ) {
    throw invalid();
  }
  // The only Control authority is this environment's Core: its Worker name is fixed by the closed Core profile,
  // so no caller can name another target; only the observed deployed Core version is an input.
  if (
    !Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, deployment ?? "") ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(controlRuntimeWorkerVersionId ?? "")
  )
    throw invalid();
  const controlRuntimeWorkerName = CONTROL_CORE_WORKER_PROFILES[deployment];
  const normalizedDomain = normalizedAuthkitDomain(authkitDomain);
  await assertExternalEmptyDirectory(root, target);
  const artifact = await validateCandidateArtifact(root);
  if (!artifact.launchable) throw invalid();
  {
    const path = "dist/runtime/runtime-contract.json";
    const file = artifact.files.find((item) => item.path === path);
    const bytes = await readFile(join(root, "apps/workos-management", path));
    if (
      file === undefined ||
      sha256(bytes) !== file.sha256 ||
      !isManagementRuntimeContract(JSON.parse(bytes))
    )
      throw invalid();
  }
  const source = join(root, SOURCE);
  const expectedFile = artifact.files.find(
    (file) => file.path === "dist/worker-bundle/worker-main.js",
  );
  if (expectedFile === undefined || sha256(await readFile(source)) !== expectedFile.sha256) {
    throw invalid();
  }
  await copyFile(source, join(target, "worker-main.js"), fsConstants.COPYFILE_EXCL);
  const configuration = {
    name: workerName,
    main: "worker-main.js",
    compatibility_date: "2026-08-19",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    no_bundle: true,
    upload_source_maps: false,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    triggers: { crons: ["*/1 * * * *"] },
    vars: {
      MANAGEMENT_ARTIFACT_SHA256: artifact.artifact_sha256,
      WORKOS_AUTHKIT_DOMAIN: normalizedDomain,
      WORKOS_CONNECT_APPLICATION_ID: connectApplicationId,
      WORKOS_CONNECT_CLIENT_ID: connectClientId,
      WORKOS_DEPLOYMENT: deployment,
    },
    services: [
      {
        binding: "CONTROL_RUNTIME",
        service: controlRuntimeWorkerName,
        entrypoint: "WorkosRuntime",
      },
    ],
  };
  const runtimeContract = createManagementRuntimeContract();
  const contract = {
    schemaVersion: 3,
    workerName,
    artifactSha256: artifact.artifact_sha256,
    versionTag: artifact.artifact_sha256,
    wranglerVersion: "4.125.0",
    uploadMode: "deploy-no-bundle",
    deployment,
    controlRuntimeWorkerName,
    controlRuntimeWorkerVersionId,
    controlRuntimeEntrypoint: "WorkosRuntime",
    requiredSecretBindings: ["WORKOS_CONNECT_CLIENT_SECRET", "WORKOS_MANAGEMENT_CREDENTIAL"],
    expectedRuntimeBindings: ["CF_VERSION_METADATA", "CONTROL_RUNTIME"],
    scheduledTriggers: ["*/1 * * * *"],
    snapshotDeadlineMs: 20_000,
    expectedVars: { ...configuration.vars },
    forbiddenRuntimeBindings: runtimeContract.forbiddenBindings,
    forbiddenRuntimeBindingPatterns: runtimeContract.forbiddenBindingPatterns,
    forbiddenRuntimeBindingTypes: runtimeContract.forbiddenBindingTypes,
    requiredFunctionalProbe: "workos-control-profile/v3",
  };
  await Promise.all([
    writeFile(join(target, "wrangler.jsonc"), `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(join(target, "deployment-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  return { artifactSha256: artifact.artifact_sha256, output: target };
};

const parseArguments = (arguments_) => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const options = {
    repositoryRoot: process.cwd(),
    output: null,
    workerName: null,
    authkitDomain: null,
    connectApplicationId: null,
    connectClientId: null,
    controlRuntimeWorkerVersionId: null,
    deployment: null,
  };
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const value = normalized[index + 1];
    if (value === undefined) throw invalid();
    if (argument === "--root") options.repositoryRoot = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--worker-name") options.workerName = value;
    else if (argument === "--authkit-domain") options.authkitDomain = value;
    else if (argument === "--connect-application-id") options.connectApplicationId = value;
    else if (argument === "--connect-client-id") options.connectClientId = value;
    else if (argument === "--control-runtime-version")
      options.controlRuntimeWorkerVersionId = value;
    else if (argument === "--deployment") options.deployment = value;
    else throw invalid();
    index += 1;
  }
  if (Object.values(options).some((value) => value === null)) throw invalid();
  return options;
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const prepared = await prepareWorkosManagementDeployment(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ artifact_sha256: prepared.artifactSha256 })}\n`);
  } catch {
    process.stderr.write(
      `${JSON.stringify({ reason_code: "WORKOS_MANAGEMENT_DEPLOYMENT_PREPARATION_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}
