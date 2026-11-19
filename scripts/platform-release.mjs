#!/usr/bin/env node

/* global AbortSignal, process, setTimeout, structuredClone */

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  completeContainerRelease,
  prepareContainerRelease,
  verifyContainerReleaseReceipt,
  setContainerReleaseImage,
} from "./platform-container-release.mjs";
import {
  releaseHash,
  requirePrivateReleaseDirectory,
  validateWorkerRehearsal,
} from "./release-rehearsal-artifacts.mjs";
import {
  prepareClientPrerequisite,
  verifyClientRegistryArtifacts,
} from "./release-client-artifacts.mjs";
import {
  migrationSnapshot,
  requireSchemaHeadForPin,
  SCHEMA_RECEIPTS_SQL,
} from "./control-d1-target.mjs";
import { providerReader, requirePolicyTrain } from "./release-policy-cohort.mjs";
import { classifyWorkerAbsence, isWorkerAbsentError } from "./release-worker-presence.mjs";
import {
  assertControlCoreStandaloneLaunchPolicy,
  assertControlCoreWorkerConfiguration,
  controlCoreWorkerConfiguration,
} from "./control-core-worker-profile.mjs";
import {
  assertControlCoreResourceIdentity,
  controlCoreEnvironment,
  controlCoreTemplatePath,
  isControlCoreWorker,
  resolveCoreDatabaseVariable,
} from "./control-core-train.mjs";

const execFileAsync = promisify(execFile);
export const CI_REPOSITORY = "amerged-org/ohmyhost";
const EXPECTED_ORIGIN = `https://github.com/${CI_REPOSITORY}.git`;
const CI_WORKFLOW = "ci.yml";
const CI_RUN_FIELDS = "databaseId,headSha,status,conclusion";
const PREVIOUS_CLIENT_CI_JOBS = [
  "Scan source for secrets",
  "Audit and check source contracts",
  "Build workspace and inventory tests",
  "Typecheck and verify production boundaries",
  "Verify Node and packaged-client tests",
  ...Array.from({ length: 6 }, (_, index) => `Vitest shard ${index + 1}/6`),
  "Merge complete reports and enforce coverage",
  "Verify complete release gate",
].sort();
const WORKER_NAME =
  /^(?:(?:ohmyho|ohmyhost)-[a-z0-9-]+-(?:poc-private-fullstack|production)|ohmyho-(?:project-database|native-auth)-(?:development|production)-(?:us|eu)|ohmyho-connection-broker-development)$/u;
// These Workers refuse to serve a version whose Cloudflare tag is not the digest of the
// artifact they were built from, so the release pins both from the build output.
const ARTIFACT_PINNED_WORKERS = Object.freeze({
  "ohmyhost-workos-management-poc-private-fullstack": Object.freeze({
    proof: "apps/workos-management/dist/candidate-artifact.json",
    variable: "MANAGEMENT_ARTIFACT_SHA256",
    package: "@ohmyhost/workos-management",
  }),
  "ohmyhost-workos-management-production": Object.freeze({
    proof: "apps/workos-management/dist/candidate-artifact.json",
    variable: "MANAGEMENT_ARTIFACT_SHA256",
    package: "@ohmyhost/workos-management",
  }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
// Five cron fields without control characters; the provider validates the expression itself.
const CRON = /^[^\s\p{Cc}]+(?: [^\s\p{Cc}]+){4}$/u;
const CREATION_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

/** Only the owner's main or short-lived type/topic branches may supply release source. */
export function releaseBranchFromRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/"))
    throw new Error("Release requires a named branch");
  const branch = ref.slice("refs/heads/".length);
  if (!/^(?:main|[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(branch))
    throw new Error("Release branch name is invalid");
  return branch;
}

function readRemoteBranch(line, branch) {
  const parts = clean(line).split(/\s+/u);
  if (
    parts.length !== 2 ||
    !/^[0-9a-f]{40}$/u.test(parts[0]) ||
    parts[1] !== `refs/heads/${branch}`
  )
    throw new Error("Remote release branch response is invalid");
  return parts[0];
}

export async function inspectReleaseRepository({ cwd = process.cwd(), run = runCommand } = {}) {
  const repositoryRoot = clean(await run("git", ["rev-parse", "--show-toplevel"], { cwd }));
  if (resolve(repositoryRoot) !== resolve(cwd)) {
    throw new Error("platform release must run from the repository root");
  }
  if (clean(await run("git", ["rev-parse", "--is-bare-repository"], { cwd })) !== "false") {
    throw new Error("platform release requires a non-bare repository");
  }
  const branch = releaseBranchFromRef(
    clean(await run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd })),
  );
  if ((await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd })).trim()) {
    throw new Error("platform release requires a clean worktree");
  }

  const pushUrl = clean(await run("git", ["remote", "get-url", "--push", "origin"], { cwd }));
  if (pushUrl !== EXPECTED_ORIGIN) throw new Error(`unexpected origin push URL: ${pushUrl}`);

  const fetchUrl = clean(await run("git", ["remote", "get-url", "origin"], { cwd }));
  if (fetchUrl !== EXPECTED_ORIGIN) throw new Error("unexpected origin fetch URL");

  const sha = clean(await run("git", ["rev-parse", "HEAD"], { cwd }));
  const trackingSha = clean(
    await run("git", ["rev-parse", `refs/remotes/origin/${branch}`], { cwd }),
  );
  const remoteLine = clean(
    await run("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd }),
  );
  const remoteSha = readRemoteBranch(remoteLine, branch);
  if (![sha, trackingSha, remoteSha].every((value) => value === sha)) {
    throw new Error("HEAD, local tracking branch and remote branch must be exact");
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("release SHA is invalid");
  if (branch !== "main") {
    const mainSha = clean(await run("git", ["rev-parse", "refs/remotes/origin/main"], { cwd }));
    const mainRemote = readRemoteBranch(
      await run("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], { cwd }),
      "main",
    );
    if (!/^[0-9a-f]{40}$/u.test(mainSha) || mainRemote !== mainSha)
      throw new Error("origin/main tracking branch is stale");
    await run("git", ["merge-base", "--is-ancestor", mainSha, sha], { cwd });
  }
  return Object.freeze({ repositoryRoot, sha, ...(branch === "main" ? {} : { branch }) });
}

export async function readArtifactDigest({ repositoryRoot, workerName, read = readFile }) {
  const pin = ARTIFACT_PINNED_WORKERS[workerName];
  if (pin === undefined) return null;
  const proof = JSON.parse(await read(join(repositoryRoot, pin.proof), "utf8"));
  const digest = proof?.artifactSha256;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${workerName} has no usable artifact digest; build it before releasing`);
  }
  return Object.freeze({ digest, variable: pin.variable, package: pin.package });
}

/**
 * The release copies this validated file into its private temporary directory. With a repository
 * root, the file's directory must also be private and outside the checkout, so no secret can sit in it.
 */
export async function validateReleaseSecretsFile({ path, repositoryRoot }) {
  if (typeof path !== "string" || path.length === 0)
    throw new Error("A private JSON secret file is required");
  if (repositoryRoot !== undefined)
    await requirePrivateReleaseDirectory(dirname(resolve(path)), repositoryRoot).catch(() => {
      throw new Error("Release secrets must be in a private directory outside the checkout");
    });
  const handle = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let contents;
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid()) ||
      details.size < 2 ||
      details.size > 64 * 1024
    )
      throw new Error("Secret file permissions or size are invalid");
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let values;
  try {
    values = JSON.parse(contents);
  } catch {
    throw new Error("Secret file must contain one JSON object");
  }
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).length < 1 ||
    Object.keys(values).length > 100 ||
    Object.entries(values).some(
      ([name, value]) =>
        !/^[A-Z][A-Z0-9_]{0,99}$/u.test(name) ||
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 5120 ||
        value.includes("\0"),
    )
  )
    throw new Error("Secret file keys or values are invalid");
  if (Object.hasOwn(values, "DATABASE_REGISTRY_KEY")) {
    const encoded = values.DATABASE_REGISTRY_KEY;
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded) || Buffer.from(encoded, "base64").byteLength !== 32)
      throw new Error("Database registry key is invalid");
  }
  return Object.freeze({ contents, names: Object.freeze(Object.keys(values).sort()) });
}

/**
 * The Core configuration is derived from the checked-in template and the step's exact D1 resource, never read
 * from a file that carries an id: the same closed profile the standalone packet compiler uses.
 */
async function renderControlCoreConfiguration({ expectedName, outputPath, sourcePath, core }) {
  const environment = controlCoreEnvironment(expectedName);
  if (
    environment === undefined ||
    resolve(sourcePath) !== controlCoreTemplatePath(core.repositoryRoot)
  )
    throw new Error("Core Worker configuration source is invalid");
  const { configuration } = await controlCoreWorkerConfiguration({
    repositoryRoot: core.repositoryRoot,
    sourceCommit: core.sourceCommit,
    environment,
    accountId: core.accountId,
    databaseId: core.databaseId,
    databaseName: core.databaseName,
    nativeAuthLaunchPolicy: core.nativeAuthLaunchPolicy,
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return Object.freeze(configuration);
}

export async function renderWranglerConfiguration({
  expectedName,
  outputPath,
  sourcePath,
  artifact = null,
  core,
  coreDatabaseId,
}) {
  if (core !== undefined)
    return renderControlCoreConfiguration({ expectedName, outputPath, sourcePath, core });
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error("Wrangler source config must be a regular file");

  const configuration = parseJsonc(await readFile(sourcePath, "utf8"));
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("Wrangler source config must be an object");
  }
  if (!WORKER_NAME.test(configuration.name) || configuration.name !== expectedName) {
    throw new Error("Wrangler worker name does not match the requested Dev/Prod worker");
  }
  if (typeof configuration.workers_dev !== "boolean" || configuration.preview_urls !== false) {
    throw new Error("platform Workers must declare workers.dev and disable preview URLs");
  }
  const serialized = JSON.stringify(configuration);
  if (serialized.includes("00000000000000000000000000000000") || /"disabled"/u.test(serialized)) {
    throw new Error("Wrangler source config contains a disabled placeholder");
  }
  if (typeof configuration.main !== "string" || configuration.main.length === 0) {
    throw new Error("Wrangler source config requires a main entrypoint");
  }

  const sourceDirectory = dirname(resolve(sourcePath));
  const rendered = structuredClone(configuration);
  if (artifact !== null) {
    // The digest belongs to the build, not to the operator's file, so a stale pin cannot
    // reach the provider and the Worker's own tag check cannot be left unsatisfied.
    if (!rendered.vars || typeof rendered.vars !== "object" || Array.isArray(rendered.vars)) {
      throw new Error("Wrangler source config requires vars for an artifact-pinned Worker");
    }
    rendered.vars[artifact.variable] = artifact.digest;
  }
  if (rendered.vars !== undefined)
    rendered.vars = resolveCoreDatabaseVariable(rendered.vars, coreDatabaseId);
  rendered.main = absoluteFrom(sourceDirectory, configuration.main);
  if (typeof rendered.tsconfig === "string")
    rendered.tsconfig = absoluteFrom(sourceDirectory, rendered.tsconfig);
  if (
    rendered.assets &&
    typeof rendered.assets === "object" &&
    typeof rendered.assets.directory === "string"
  ) {
    rendered.assets.directory = absoluteFrom(sourceDirectory, rendered.assets.directory);
  }
  // The rendered config lives in a temporary directory, so a local image build needs absolute paths.
  if (Array.isArray(rendered.containers)) {
    for (const sandbox of rendered.containers) {
      if (typeof sandbox.image === "string" && /^\.{0,2}\//u.test(sandbox.image))
        sandbox.image = absoluteFrom(sourceDirectory, sandbox.image);
      if (typeof sandbox.image_build_context === "string")
        sandbox.image_build_context = absoluteFrom(sourceDirectory, sandbox.image_build_context);
      if (sandbox.images !== undefined) {
        for (const image of Object.values(sandbox.images)) {
          if (typeof image.dockerfile === "string")
            image.dockerfile = absoluteFrom(sourceDirectory, image.dockerfile);
          if (typeof image.build_context === "string")
            image.build_context = absoluteFrom(sourceDirectory, image.build_context);
        }
      }
    }
  }
  await access(rendered.main, constants.R_OK);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return Object.freeze(rendered);
}

export async function verifyPublicClientRelease({
  assetsDirectory,
  version,
  sourceSha,
  publishedManifest,
  clientPrerequisite,
  repositoryRoot,
  run = runCommand,
  fetch = globalThis.fetch,
}) {
  if (
    typeof assetsDirectory !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(version) ||
    !/^[0-9a-f]{40}$/u.test(sourceSha)
  )
    throw new Error("Invalid public release identity");
  const directory = join(assetsDirectory, "releases", version);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const previousSource = manifest.source_commit !== sourceSha;
  const alreadyPublished = JSON.stringify(manifest) === JSON.stringify(publishedManifest);
  const recoverPrevious =
    clientPrerequisite !== undefined &&
    clientPrerequisite?.kind === "clients" &&
    clientPrerequisite.action === "verify" &&
    Object.hasOwn(clientPrerequisite, "sourceCommit") &&
    /^[a-f0-9]{40}$/u.test(clientPrerequisite.sourceCommit ?? "") &&
    clientPrerequisite.sourceCommit === manifest.source_commit &&
    clientPrerequisite.version === version;
  if (
    manifest.version !== version ||
    (manifest.source_repository !== undefined && manifest.source_repository !== CI_REPOSITORY) ||
    !/^[0-9a-f]{40}$/u.test(manifest.source_commit ?? "") ||
    (previousSource && !alreadyPublished && !recoverPrevious) ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== 5 ||
    manifest.contract?.file !== "openapi.json"
  )
    throw new Error("Invalid public release identity");
  const items = [...manifest.packages, manifest.contract];
  const expected = ["product-cli", "mcp", "sdk-ts", "customer-runtime", "customer-auth-better-auth"]
    .map((name) => `ohmyhost-${name}-${version}.tgz`)
    .concat("openapi.json")
    .sort();
  if (JSON.stringify(items.map((item) => item.file).sort()) !== JSON.stringify(expected))
    throw new Error("Invalid public release identity");
  for (const item of items) {
    if (
      item.url !== `https://ohmyho.st/releases/${version}/${item.file}` ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      !/^[0-9a-f]{64}$/u.test(item.sha256)
    )
      throw new Error("Invalid public asset integrity metadata");
    const bytes = await readFile(join(directory, item.file));
    if (
      bytes.length !== item.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== item.sha256
    )
      throw new Error("Public asset integrity differs from its manifest");
  }
  if (
    (await readFile(join(directory, "SHA256SUMS"), "utf8")) !==
    items.map((item) => `${item.sha256}  ${item.file}`).join("\n") + "\n"
  )
    throw new Error("Public asset integrity checksums differ");
  if (previousSource && !alreadyPublished) {
    const prepared = await prepareClientPrerequisite({
      step: clientPrerequisite,
      sha: sourceSha,
      repositoryRoot,
      run,
    });
    await requireVerifiedCommit({ sha: prepared.manifest.sourceCommit, run, existingOnly: true });
    const packages = [
      ["cli", "product-cli", "apps/product-cli"],
      ["mcp", "mcp", "apps/mcp"],
      ["sdk", "sdk-ts", "packages/sdk-ts"],
      ["runtime", "customer-runtime", "packages/customer-runtime"],
      ["auth", "customer-auth-better-auth", "packages/customer-auth-better-auth"],
    ];
    for (const [registryName, downloadName, packageDirectory] of packages) {
      const archive = prepared.manifest.packages.find(
        ({ name }) => name === `@amerged/ohmyhost-${registryName}`,
      );
      const downloads = manifest.packages.filter(
        ({ name }) => name === `@ohmyhost/${downloadName}`,
      );
      if (
        downloads.length !== 1 ||
        downloads[0].version !== version ||
        downloads[0].file !== `ohmyhost-${downloadName}-${version}.tgz` ||
        downloads[0].sha256 !== archive.sourceArchiveSha256
      )
        throw new Error(
          "Recovered public download differs from its published client source archive",
        );
      const sourcePackage = JSON.parse(
        await run(
          "git",
          ["show", `${prepared.manifest.sourceCommit}:${packageDirectory}/package.json`],
          { cwd: repositoryRoot, localOnly: true },
        ),
      );
      if (sourcePackage.version !== version)
        throw new Error("Recovered public client version differs from its source ancestor");
    }
    const contract = await run(
      "git",
      ["show", `${prepared.manifest.sourceCommit}:packages/contracts/generated/openapi.json`],
      { cwd: repositoryRoot, localOnly: true },
    );
    if (releaseHash(contract) !== manifest.contract.sha256)
      throw new Error("Recovered public contract differs from its source ancestor");
    await verifyClientRegistryArtifacts({ manifest: prepared.manifest, fetch });
  }
}

const RELEASED_COMMIT = /^(?:origin\/main|source) ([a-f0-9]{40});/u;
const PRODUCTION_SUFFIX = "-production";

/** The commit of the one version a Worker serves at 100%, or null when the provider cannot prove it. */
async function liveReleaseCommit({ read, accountId, workerName }) {
  const script = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  const deployments = (await read(`${script}/deployments`))?.deployments;
  const versions = Array.isArray(deployments) ? deployments[0]?.versions : undefined;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    !UUID.test(versions[0]?.version_id ?? "")
  )
    return null;
  const version = await read(`${script}/versions/${versions[0].version_id}`);
  const message = version?.annotations?.["workers/message"];
  const source =
    version?.id === versions[0].version_id && typeof message === "string"
      ? RELEASED_COMMIT.exec(message)
      : null;
  return source === null ? null : source[1];
}

/**
 * A Worker created standalone lands only where train order would put it: every Core it binds is
 * already live at this commit, and a production Worker's Development twin is too. Nothing is read
 * for a Worker with neither, so ordinary creation keeps its existing provider calls.
 */
export async function requireCreationOrder({
  configuration,
  workerName,
  accountId,
  sha,
  run,
  wrangler,
  fetch,
}) {
  const cores = [
    ...new Set(
      (configuration.services ?? []).map((service) => service.service).filter(isControlCoreWorker),
    ),
  ];
  const nativeProduction = /^ohmyho-native-auth-production-(us|eu)$/u.exec(workerName);
  const twin = nativeProduction
    ? `ohmyho-native-auth-development-${nativeProduction[1]}`
    : workerName.endsWith(PRODUCTION_SUFFIX)
      ? `${workerName.slice(0, -PRODUCTION_SUFFIX.length)}-poc-private-fullstack`
      : null;
  if (cores.length === 0 && twin === null) return;
  if (!ACCOUNT_ID.test(accountId ?? ""))
    throw new Error("Worker creation requires one Cloudflare account");
  const read = await providerReader({ run, wrangler, fetch, label: "creation order" });
  // Missing, unreadable and split deployments are all unproven; each refuses with the same sentence.
  const liveAt = async (name) =>
    (await liveReleaseCommit({ read, accountId, workerName: name }).catch(() => null)) === sha;
  for (const core of cores)
    if (!(await liveAt(core)))
      throw new Error("Control Core must be live at this commit before its consumers are created");
  if (twin !== null && !(await liveAt(twin)))
    throw new Error("Development twin must be live at this commit before production is created");
}

const CUSTOM_DOMAIN_HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** The hostnames a configuration declares as custom domains. */
function customDomainHosts(configuration) {
  return (Array.isArray(configuration.routes) ? configuration.routes : [])
    .filter((route) => route?.custom_domain === true)
    .map((route) => route.pattern);
}

/**
 * A standalone creation accepts only custom domain routes on plain hostnames. Wrangler's
 * non-interactive deploy takes over any other route, and any existing custom domain or DNS record.
 */
function requireCreatableRoutes(configuration) {
  const routes = configuration.routes ?? [];
  if (
    configuration.route !== undefined ||
    !Array.isArray(routes) ||
    routes.some(
      (route) =>
        route?.custom_domain !== true ||
        typeof route.pattern !== "string" ||
        !CUSTOM_DOMAIN_HOSTNAME.test(route.pattern),
    )
  )
    throw new Error("An unattended creation accepts only custom domain routes");
}

/**
 * Each declared custom domain hostname must be free: no custom domain row and no DNS record. The
 * deploy would otherwise re-point it silently. The token needs Zone:Read and DNS:Read for the zone.
 */
async function requireFreeCustomDomains({ configuration, accountId, run, wrangler, fetch }) {
  requireCreatableRoutes(configuration);
  const hosts = customDomainHosts(configuration);
  if (hosts.length === 0) return;
  if (!ACCOUNT_ID.test(accountId ?? ""))
    throw new Error("Worker creation requires one Cloudflare account");
  const read = await providerReader({ run, wrangler, fetch, label: "custom domain" });
  const zones = await read(`/zones?account.id=${accountId}`, { paginated: true });
  for (const host of hosts) {
    const attached = await read(
      `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`,
      { paginated: true },
    );
    // The longest zone that the host equals or ends with owns its DNS records.
    const zone = zones
      .filter(({ name }) => host === name || host.endsWith(`.${name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (zone === undefined || !ACCOUNT_ID.test(zone.id ?? ""))
      throw new Error("Custom domain zone is not in this account");
    const records = await read(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`, {
      paginated: true,
    });
    if (attached.length !== 0 || records.length !== 0)
      throw new Error(
        "Custom domain hostname is already in use; the unattended deploy would overwrite it",
      );
  }
}

/** After the deploy, and on every replay, each declared custom domain must be served by this Worker in production. */
async function requireAttachedCustomDomains({
  configuration,
  workerName,
  accountId,
  run,
  wrangler,
  fetch,
}) {
  const hosts = customDomainHosts(configuration);
  if (hosts.length === 0) return;
  if (!ACCOUNT_ID.test(accountId ?? ""))
    throw new Error("Worker release requires one Cloudflare account");
  const read = await providerReader({ run, wrangler, fetch, label: "custom domain" });
  for (const host of hosts) {
    const rows = await read(
      `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`,
      { paginated: true },
    );
    if (
      rows.length !== 1 ||
      rows[0]?.hostname !== host ||
      rows[0]?.service !== workerName ||
      rows[0]?.environment !== "production"
    )
      throw new Error("Custom domain is not attached to this Worker");
  }
}

export async function releaseWorker({
  configPath,
  cwd = process.cwd(),
  expectedName,
  secretsFile,
  run = runCommand,
  wrangler = process.env.WRANGLER_BIN ?? "/opt/homebrew/bin/wrangler",
  fetch = globalThis.fetch,
  env = process.env,
  containerWait,
  containerAttempts,
  containerImages,
  allowContainerBootstrap = false,
  rehearsal,
  clientPrerequisite,
  core,
  coreDatabaseId,
  readCorePin = corePinAt,
}) {
  if (!configPath) throw new Error("--config is required");
  const parsed = parseJsonc(await readFile(configPath, "utf8"));
  const workerName = expectedName ?? parsed?.name;
  if (typeof workerName !== "string") throw new Error("Wrangler config requires a worker name");
  const coreWorker = isControlCoreWorker(workerName);
  const nativeWorker = /^ohmyho-native-auth-(?:development|production)-(?:us|eu)$/u.test(
    workerName,
  );
  const nativeAtomicMode = nativeWorker
    ? parsed?.vars?.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE
    : undefined;
  const sharedGateway = [
    "ohmyho-gateway-poc-private-fullstack",
    "ohmyho-gateway-production",
  ].includes(workerName);
  const devAtomicMode = sharedGateway ? parsed?.vars?.DEV_AUTH_ATOMIC_MODE : undefined;
  if (devAtomicMode !== undefined && devAtomicMode !== "v1")
    throw new Error("Gateway Dev atomic mode is invalid");
  if (devAtomicMode === "v1" && rehearsal === undefined)
    throw new Error(
      "Gateway Dev atomic mode requires a validated Core-first and Control-first train rehearsal",
    );
  if (nativeAtomicMode !== undefined && nativeAtomicMode !== "v1")
    throw new Error("Native atomic snapshot mode is invalid");
  if (nativeAtomicMode === "v1" && rehearsal === undefined)
    throw new Error("Native atomic snapshot mode requires a validated Core-first train rehearsal");
  if (allowContainerBootstrap && rehearsal === undefined)
    throw new Error("Preview Container bootstrap requires an approved train rehearsal");
  if (coreWorker && rehearsal === undefined)
    assertControlCoreStandaloneLaunchPolicy(
      core === undefined
        ? parsed?.vars?.CONTROL_NATIVE_AUTH_LAUNCH_POLICY
        : JSON.stringify(
            core.nativeAuthLaunchPolicy === undefined
              ? { mode: "disabled" }
              : core.nativeAuthLaunchPolicy,
          ),
    );
  const repository = await inspectReleaseRepository({ cwd, run });
  if (coreWorker && secretsFile !== undefined)
    throw new Error("Core Worker release permits no secret binding");
  // A train names the Core resource of its step; the standalone packet path carries it in its own file.
  if (core !== undefined && !coreWorker)
    throw new Error("Only the Core Worker has a Core resource");
  // Only a train carries a rehearsal, an approval and the policy cohort check.
  if (rehearsal === undefined) await requirePolicyTrain({ workerName });
  const protectedSecrets =
    secretsFile === undefined
      ? null
      : await validateReleaseSecretsFile({
          path: secretsFile,
          repositoryRoot: repository.repositoryRoot,
        });
  await requireVerifiedCommit({ sha: repository.sha, ref: repository.branch, run });
  const pinned = ARTIFACT_PINNED_WORKERS[workerName] ?? null;
  if (rehearsal === undefined)
    await buildWorkerPackages({
      configPath,
      repositoryRoot: repository.repositoryRoot,
      ...(coreWorker
        ? { packageName: "@ohmyhost/control-store" }
        : pinned === null
          ? {}
          : { packageName: pinned.package }),
      run,
    });

  const releaseDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-platform-release-"));
  const renderedPath = join(releaseDirectory, "wrangler.json");
  const secretUploadPath =
    protectedSecrets === null ? null : join(releaseDirectory, "secrets.json");
  try {
    if (secretUploadPath !== null)
      await writeFile(secretUploadPath, protectedSecrets.contents, { mode: 0o600, flag: "wx" });
    const artifact = await readArtifactDigest({
      repositoryRoot: repository.repositoryRoot,
      workerName,
    });
    let configuration = await renderWranglerConfiguration({
      expectedName: workerName,
      outputPath: renderedPath,
      sourcePath: configPath,
      artifact,
      core,
      coreDatabaseId,
    });
    await assertControlCoreWorkerConfiguration({
      configuration,
      repositoryRoot: repository.repositoryRoot,
      sourceCommit: repository.sha,
      standalone: rehearsal === undefined,
    });
    if (rehearsal !== undefined)
      configuration = await validateWorkerRehearsal({
        proof: rehearsal,
        repositoryRoot: repository.repositoryRoot,
        sha: repository.sha,
        workerName,
        configPath,
        run,
        configuration,
      });
    if (rehearsal !== undefined)
      await writeFile(renderedPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    if (workerName === "ohmyho-public-production") {
      const clientManifest = JSON.parse(
        await readFile(join(repository.repositoryRoot, "apps/product-cli/package.json"), "utf8"),
      );
      const localManifest = JSON.parse(
        await readFile(
          join(configuration.assets.directory, "releases", clientManifest.version, "manifest.json"),
          "utf8",
        ),
      );
      const publishedManifest =
        localManifest.source_commit === repository.sha || clientPrerequisite !== undefined
          ? undefined
          : JSON.parse(
              await run("curl", [
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "15",
                "--max-filesize",
                "65536",
                `https://ohmyho.st/releases/${clientManifest.version}/manifest.json`,
              ]),
            );
      await verifyPublicClientRelease({
        assetsDirectory: configuration.assets?.directory,
        version: clientManifest.version,
        sourceSha: repository.sha,
        publishedManifest,
        clientPrerequisite,
        repositoryRoot: repository.repositoryRoot,
        run,
        fetch,
      });
    }
    // Declared crons are checked before anything reaches the provider.
    const cronTarget = declaredCronTriggers(configuration, env);
    const containerRelease = await prepareContainerRelease({
      configuration,
      repositoryRoot: repository.repositoryRoot,
      sha: repository.sha,
      run,
      wrangler,
      fetch,
      env,
      configPath: renderedPath,
      imageReceiptPath: containerImages,
      rehearsedImages: rehearsal?.images,
      allowContainerBootstrap,
    });
    if (containerRelease !== null) configuration = containerRelease.configuration;
    // Artifact-pinned Workers retain their self-check tag; proof bytes enter the exact message.
    const { tag, message } = workerReleaseIdentity({
      sha: repository.sha,
      configuration,
      artifact,
      rehearsal,
    });
    const common = ["--name", workerName, "--config", renderedPath];
    const observedAccount = [configuration.account_id, env.CLOUDFLARE_ACCOUNT_ID].find((value) =>
      ACCOUNT_ID.test(value ?? ""),
    );
    // The D1 resource is read from the provider by its exact UUID before anything is uploaded.
    if (core !== undefined)
      assertControlCoreResourceIdentity(
        await (
          await providerReader({ run, wrangler, fetch, label: "Core resource" })
        )(`/accounts/${core.accountId}/d1/database/${core.databaseId}`),
        {
          environment: controlCoreEnvironment(workerName),
          databaseId: core.databaseId,
          databaseName: core.databaseName,
        },
      );
    let versions = await readVersions({
      common,
      run,
      wrangler,
      allowMissingWorker: true,
      scope: { accountId: observedAccount ?? null, workerName },
    });
    // A standalone release may only create the Core; once it exists it ships with its cohort in a train.
    if (rehearsal === undefined && coreWorker && versions !== null)
      throw new Error(
        "Policy consumer Workers release only through release:train with an approved rehearsal",
      );
    // The Core schema must already be at the head this source commit pins: upgrade first, then release.
    if (core !== undefined)
      await requireCoreSchemaHead({
        configPath: renderedPath,
        sourceCommit: repository.sha,
        repositoryRoot: repository.repositoryRoot,
        run,
        wrangler,
        readCorePin,
      });
    if (versions === null) {
      await requireCreationOrder({
        configuration,
        workerName,
        accountId: observedAccount,
        sha: repository.sha,
        run,
        wrangler,
        fetch,
      });
      await requireFreeCustomDomains({
        configuration,
        accountId: observedAccount,
        run,
        wrangler,
        fetch,
      });
    }
    let matches = matchingVersions(versions ?? [], tag, message);
    if (protectedSecrets !== null && matches.length !== 0)
      throw new Error(
        "Secret-bearing release already has a matching version; inspect it before replay",
      );
    let uploaded = false;
    if (matches.length === 0) {
      // Only confirmed initial absence requires deploy. With Containers, Wrangler's deploy uses
      // the legacy PUT, whose acknowledged version can be absent from the deployable Versions API.
      // Existing Workers use Versions; immutable images and their rollouts are managed separately.
      const deploys = versions === null;
      await run(
        wrangler,
        [
          ...(deploys ? ["deploy"] : ["versions", "upload"]),
          ...(deploys &&
          containerRelease !== null &&
          !containerRelease.targets.some((target) => target.bootstrap)
            ? ["--containers-rollout", "none"]
            : []),
          "--tag",
          tag,
          "--message",
          message,
          ...(secretUploadPath === null ? [] : ["--secrets-file", secretUploadPath]),
          ...common,
        ],
        { cwd: tmpdir() },
      );
      uploaded = true;
      versions = await readVersions({ common, run, wrangler });
      matches = matchingVersions(versions, tag, message);
    }
    // Wrangler can retry a slow upload itself and leave two identical versions (observed 2026-09-23,
    // Dev wfp-management 48e48050/11fde47a). A resumed release finds them without uploading again, so
    // the newest matching version is taken on either path; equal or unreadable timestamps still refuse.
    if (matches.length > 1) matches = [newestVersion(matches)];
    if (matches.length !== 1 || !UUID.test(matches[0].id)) {
      throw new Error("provider did not return one exact release version");
    }
    const versionId = matches[0].id;
    const view = parseObject(
      await run(wrangler, ["versions", "view", versionId, "--json", ...common], { cwd: tmpdir() }),
      "version readback",
    );
    if (view.id !== versionId)
      throw new Error("version readback did not match the uploaded version");
    // Service props and D1 IDs confer authority; an upload receipt cannot prove those capabilities.
    verifyDeclaredVersionBindings(
      {
        services: configuration.services,
        d1_databases: configuration.d1_databases,
        ...(coreWorker || devAtomicMode === "v1"
          ? { vars: configuration.vars }
          : nativeAtomicMode === "v1"
            ? { vars: { NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE: "v1" } }
            : {}),
      },
      view.resources?.bindings ?? [],
    );

    let deployment = await readDeployment({ common, run, wrangler });
    if (!isExactDeployment(deployment, versionId)) {
      await run(
        wrangler,
        ["versions", "deploy", `${versionId}@100%`, "--yes", "--message", message, ...common],
        { cwd: tmpdir() },
      );
      deployment = await readDeployment({ common, run, wrangler });
    }
    if (!isExactDeployment(deployment, versionId)) {
      throw new Error("deployment readback is not the exact release version at 100%");
    }
    await verifyEgressObservability({ configuration, run, wrangler, fetch, env });
    await verifyControlApiInvocationLogs({ configuration, run, wrangler, fetch, env });
    await requireAttachedCustomDomains({
      configuration,
      workerName,
      accountId: observedAccount,
      run,
      wrangler,
      fetch,
    });
    const containers = await completeContainerRelease({
      release: containerRelease,
      version: view,
      wait: containerWait,
      attempts: containerAttempts,
    });
    const cronTriggers = await synchronizeCronTriggers({
      target: cronTarget,
      workerName,
      run,
      wrangler,
      fetch,
    });
    return Object.freeze({
      cronTriggers,
      ...(containerRelease === null ? {} : { containers }),
      deploymentVerified: true,
      sha: repository.sha,
      uploaded,
      versionId,
      workerName,
      tag,
      message,
    });
  } finally {
    await rm(releaseDirectory, { recursive: true, force: true });
  }
}

/**
 * Wrangler bundles whatever `dist` the Worker's workspace dependencies currently have. A release
 * therefore builds the Worker's package graph first and refuses to continue when that build
 * changes tracked files: generated output belongs in the released commit, not in the deploy.
 */
/**
 * CI runs only for a commit that is actually released, and every Worker of that commit
 * shares the one verified run. A red or missing run stops the deployment.
 */
export async function requireVerifiedCommit({
  sha,
  ref = "main",
  run = runCommand,
  repository = CI_REPOSITORY,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 20,
  existingOnly = false,
  preferredRunId,
}) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("A release requires the exact commit SHA");
  releaseBranchFromRef(`refs/heads/${ref}`);
  const list = async () => {
    const value = JSON.parse(
      await run("gh", [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        CI_WORKFLOW,
        "--commit",
        sha,
        "--limit",
        "40",
        "--json",
        CI_RUN_FIELDS,
      ]),
    );
    if (!Array.isArray(value)) throw new Error("GitHub returned an unexpected workflow run list");
    return value.filter(
      (entry) => entry !== null && typeof entry === "object" && entry.headSha === sha,
    );
  };
  const existing = await list();
  // A train records the run it released on; a later green run of the same commit must not replace that evidence.
  const succeeded =
    existing.find(
      (entry) => entry.conclusion === "success" && entry.databaseId === preferredRunId,
    ) ?? existing.find((entry) => entry.conclusion === "success");
  if (succeeded) {
    if (existingOnly) {
      if (
        succeeded.status !== "completed" ||
        !Number.isSafeInteger(succeeded.databaseId) ||
        succeeded.databaseId < 1
      )
        throw new Error("Previous client CI identity is invalid");
      const evidence = JSON.parse(
        await run("gh", [
          "run",
          "view",
          String(succeeded.databaseId),
          "--repo",
          repository,
          "--json",
          "databaseId,headSha,status,conclusion,jobs",
        ]),
      );
      if (
        evidence.databaseId !== succeeded.databaseId ||
        evidence.headSha !== sha ||
        evidence.status !== "completed" ||
        evidence.conclusion !== "success" ||
        !Array.isArray(evidence.jobs) ||
        !isDeepStrictEqual(evidence.jobs.map(({ name }) => name).sort(), PREVIOUS_CLIENT_CI_JOBS) ||
        evidence.jobs.some(
          ({ status, conclusion }) => status !== "completed" || conclusion !== "success",
        )
      )
        throw new Error(
          "Previous client source requires the complete successful exact-commit CI gate",
        );
    }
    return succeeded.databaseId;
  }
  const completed = existing.find((entry) => entry.status === "completed");
  if (completed)
    throw new Error(
      `CI run ${completed.databaseId} for ${sha} ended as ${completed.conclusion}; fix it and verify the commit before releasing`,
    );
  if (existingOnly)
    throw new Error("Previous client source requires an existing successful exact-commit CI run");
  let started = existing.find((entry) => entry.status !== "completed");
  if (!started) {
    await run("gh", ["workflow", "run", CI_WORKFLOW, "--repo", repository, "--ref", ref]);
    for (let attempt = 0; attempt < attempts && started === undefined; attempt += 1) {
      await wait(3_000);
      started = (await list()).find((entry) => entry.status !== "completed");
    }
    if (!started) throw new Error(`CI did not start a verification run for ${sha}`);
  }
  await run("gh", [
    "run",
    "watch",
    String(started.databaseId),
    "--repo",
    repository,
    "--exit-status",
    "--interval",
    "20",
  ]);
  const observed = (await list()).find((entry) => entry.databaseId === started.databaseId);
  if (observed?.conclusion !== "success")
    throw new Error(`CI run ${started.databaseId} for ${sha} is not green; the release is refused`);
  return started.databaseId;
}

export async function buildWorkerPackages({
  configPath,
  repositoryRoot,
  packageName = null,
  run = runCommand,
}) {
  // A Worker whose deploy configuration lives outside the repository names its package here.
  const name =
    packageName ??
    JSON.parse(await readFile(join(dirname(configPath), "package.json"), "utf8")).name;
  if (typeof name !== "string" || !/^@ohmyhost\/[a-z0-9-]+$/u.test(name)) {
    throw new Error("Worker package.json requires an @ohmyhost workspace name");
  }
  const manifest = { name };
  await run("pnpm", ["--filter", `${manifest.name}...`, "build"], { cwd: repositoryRoot });
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
  });
  if (status.trim() !== "") {
    throw new Error("platform release build changed tracked files; commit the generated output");
  }
  return manifest.name;
}

/**
 * Exact source, configuration and validated executable/asset bytes share one replay identity. A
 * private Worker creation appends its manifest-bound creation ID to the message only; the tag keeps
 * its bounded form (or the artifact self-check digest) and ordinary identities are unchanged.
 */
export function workerReleaseIdentity({
  sha,
  configuration,
  artifact = null,
  rehearsal,
  creationId,
}) {
  if (creationId !== undefined && !CREATION_ID.test(creationId))
    throw new Error("Worker creation identity is invalid");
  const configurationSha = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  const proofSha = rehearsal === undefined ? null : releaseHash(JSON.stringify(rehearsal));
  const tag =
    artifact === null
      ? `release-${sha.slice(0, 12)}-${configurationSha.slice(0, 12)}${proofSha === null ? "" : `-${proofSha.slice(0, 12)}`}`
      : artifact.digest;
  const message =
    (artifact === null
      ? `source ${sha}; config ${configurationSha}`
      : `source ${sha}; artifact ${artifact.digest}`) +
    (proofSha === null ? "" : `; rehearsal ${proofSha}`) +
    (creationId === undefined ? "" : `; creation ${creationId}`);
  return { tag, message };
}

/** Resume reads an already completed release; it never invokes an upload, deployment or rollout. */
export async function verifyWorkerReleaseReceipt({
  receipt,
  configuration,
  configPath,
  repositoryRoot,
  sourceSha,
  rehearsal,
  run = runCommand,
  wrangler = process.env.WRANGLER_BIN ?? "/opt/homebrew/bin/wrangler",
  fetch = globalThis.fetch,
  env = process.env,
}) {
  await assertControlCoreWorkerConfiguration({
    configuration,
    repositoryRoot,
    sourceCommit: sourceSha,
  });
  if (
    receipt?.deploymentVerified !== true ||
    !UUID.test(receipt.versionId ?? "") ||
    receipt.workerName !== configuration.name ||
    !/^[a-f0-9]{40}$/u.test(sourceSha ?? "") ||
    receipt.sha !== sourceSha ||
    typeof receipt.tag !== "string" ||
    typeof receipt.message !== "string"
  )
    throw new Error("Completed Worker release receipt is invalid");
  const artifact = await readArtifactDigest({ repositoryRoot, workerName: configuration.name });
  let deployedConfiguration =
    rehearsal === undefined
      ? structuredClone(configuration)
      : await validateWorkerRehearsal({
          proof: rehearsal,
          repositoryRoot,
          sha: sourceSha,
          workerName: configuration.name,
          configPath,
          run,
          configuration,
        });
  if (Array.isArray(deployedConfiguration.containers)) {
    if (receipt.containers?.length !== deployedConfiguration.containers.length)
      throw new Error("Completed Container receipt count differs");
    deployedConfiguration.containers.forEach((container, index) => {
      setContainerReleaseImage(container, receipt.containers[index].image);
    });
  }
  const { tag, message } = workerReleaseIdentity({
    sha: sourceSha,
    configuration: deployedConfiguration,
    artifact,
    rehearsal,
  });
  const legacyMessage = message.replace(/^source /u, "origin/main ");
  if (receipt.tag !== tag || (receipt.message !== message && receipt.message !== legacyMessage))
    throw new Error("Completed Worker receipt is not the exact current source and configuration");
  const common = ["--name", receipt.workerName];
  const version = parseObject(
    await run(wrangler, ["versions", "view", receipt.versionId, "--json", ...common], {
      cwd: tmpdir(),
    }),
    "version readback",
  );
  if (
    version.id !== receipt.versionId ||
    version.annotations?.["workers/tag"] !== receipt.tag ||
    version.annotations?.["workers/message"] !== receipt.message ||
    !isExactDeployment(await readDeployment({ common, run, wrangler }), receipt.versionId)
  )
    throw new Error("Completed Worker version or deployment drifted");
  verifyDeclaredVersionBindings(deployedConfiguration, version.resources?.bindings ?? []);
  await verifyEgressObservability({ configuration, run, wrangler, fetch, env });
  await verifyControlApiInvocationLogs({ configuration, run, wrangler, fetch, env });
  await verifyContainerReleaseReceipt({
    configuration,
    receipt,
    version,
    run,
    wrangler,
    fetch,
    env,
    configPath,
    repositoryRoot,
    rehearsedImages: rehearsal?.images,
  });
  return true;
}

export function verifyDeclaredVersionBindings(configuration, bindings) {
  if (!Array.isArray(bindings)) throw new Error("Completed Worker bindings are invalid");
  const named = (name, type) => {
    const matches = bindings.filter((binding) => binding?.name === name);
    if (matches.length !== 1 || matches[0].type !== type)
      throw new Error("Completed Worker declared binding is missing or ambiguous");
    return matches[0];
  };
  for (const [name, value] of Object.entries(configuration.vars ?? {})) {
    const observed = named(name, typeof value === "string" ? "plain_text" : "json");
    if (!isDeepStrictEqual(typeof value === "string" ? observed.text : observed.json, value))
      throw new Error("Completed Worker variable binding drifted");
  }
  for (const service of configuration.services ?? []) {
    const observed = named(service.binding, "service");
    if (
      observed.service !== service.service ||
      (observed.entrypoint ?? "default") !== (service.entrypoint ?? "default") ||
      (observed.environment ?? "production") !== (service.environment ?? "production") ||
      !isDeepStrictEqual(observed.props, service.props)
    )
      throw new Error("Completed Worker service binding drifted");
  }
  for (const declaration of configuration.durable_objects?.bindings ?? []) {
    const observed = named(declaration.name, "durable_object_namespace");
    if (
      observed.class_name !== declaration.class_name ||
      (declaration.script_name !== undefined && observed.script_name !== declaration.script_name)
    )
      throw new Error("Completed Worker Durable Object binding drifted");
  }
  for (const declaration of configuration.d1_databases ?? [])
    if (named(declaration.binding, "d1").id !== declaration.database_id)
      throw new Error("Completed Worker D1 binding drifted");
  for (const declaration of configuration.kv_namespaces ?? [])
    if (named(declaration.binding, "kv_namespace").namespace_id !== declaration.id)
      throw new Error("Completed Worker KV binding drifted");
  for (const declaration of configuration.r2_buckets ?? []) {
    const observed = named(declaration.binding, "r2_bucket");
    if (
      observed.bucket_name !== declaration.bucket_name ||
      (declaration.jurisdiction !== undefined && observed.jurisdiction !== declaration.jurisdiction)
    )
      throw new Error("Completed Worker R2 binding drifted");
  }
  for (const declaration of configuration.artifacts ?? []) {
    if (named(declaration.binding, "artifacts").namespace !== declaration.namespace)
      throw new Error("Completed Worker Artifacts binding drifted");
  }
}

export async function verifyEgressObservability({ configuration, run, wrangler, fetch, env }) {
  if (
    !/^ohmyho-wfp-egress-(?:poc-private-fullstack|production|v3-poc-private-fullstack)$/u.test(
      configuration.name,
    )
  )
    return;
  const declared = configuration.observability;
  if (
    declared?.enabled !== true ||
    declared.logs?.enabled !== true ||
    declared.logs.persist !== true ||
    declared.logs.invocation_logs !== false ||
    declared.traces?.enabled !== false
  )
    throw new Error("Egress observability declaration is invalid");
  // Wrangler's Observability schema defaults query redaction to false, trace persistence to
  // true and sampling to 1. Only the declaration receives defaults: live omissions still fail.
  const expected = {
    redact_query_string: false,
    head_sampling_rate: 1,
    ...declared,
    logs: { head_sampling_rate: 1, ...declared.logs },
    traces: { persist: true, head_sampling_rate: 1, ...declared.traces },
  };
  const observed = await readLiveObservability({
    configuration,
    run,
    wrangler,
    fetch,
    env,
    subject: "Egress observability",
  });
  if (!isDeepStrictEqual(observed, expected))
    throw new Error("Egress observability readback is missing, invalid or drifted");
}

/** The Control API serves OAuth codes and portal handoffs in its URLs, so its live script keeps invocation logs off. */
const CONTROL_API_WORKERS = new Set([
  "ohmyho-control-api-poc-private-fullstack",
  "ohmyho-control-api-production",
]);

/**
 * Reads the live Control API invocation logs setting back after the release. `versions deploy` applies the
 * declared observability block of an existing Worker; this proves that the live script kept the setting off.
 */
export async function verifyControlApiInvocationLogs({ configuration, run, wrangler, fetch, env }) {
  if (!CONTROL_API_WORKERS.has(configuration.name)) return;
  if (configuration.observability?.logs?.invocation_logs !== false)
    throw new Error("Control API observability declaration keeps invocation logs");
  const observed = await readLiveObservability({
    configuration,
    run,
    wrangler,
    fetch,
    env,
    subject: "Control API invocation logs",
  });
  if (observed?.logs?.invocation_logs !== false)
    throw new Error("Control API invocation logs readback is missing, invalid or drifted");
}

/** Reads a Worker's live script-settings observability with the scoped Wrangler credential; `subject` names the readback in its errors. */
async function readLiveObservability({ configuration, run, wrangler, fetch, env, subject }) {
  const accountId = configuration.account_id ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !ACCOUNT_ID.test(accountId ?? "") ||
    (configuration.account_id !== undefined &&
      env.CLOUDFLARE_ACCOUNT_ID !== undefined &&
      configuration.account_id !== env.CLOUDFLARE_ACCOUNT_ID)
  )
    throw new Error(`${subject} readback requires one exact Cloudflare account_id`);
  let credential;
  try {
    credential = parseObject(
      await run(wrangler, ["auth", "token", "--json"], { cwd: tmpdir() }),
      "Wrangler credential",
    );
  } catch {
    throw new Error("Wrangler credential is unavailable");
  }
  if (
    !["oauth", "api_token"].includes(credential.type) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  )
    throw new Error(`Wrangler credential cannot authorize ${subject} readback`);
  let response;
  let value;
  try {
    response = await fetch(
      `${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(configuration.name)}/script-settings`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${credential.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      },
    );
    value = await response.json();
  } catch {
    throw new Error(`${subject} readback is unavailable`);
  }
  if (!response.ok || value?.success !== true)
    throw new Error(`${subject} readback is missing, invalid or drifted`);
  return value.result?.observability;
}

/**
 * `versions upload` and `versions deploy` never apply a Worker's cron triggers, so a Worker first
 * deployed without them kept an empty schedule although its released config declared one (both
 * ses-management Workers, found 2026-09-24). An explicitly declared `triggers.crons`, including an
 * empty list, is therefore applied to this Worker's schedules alone and read back; a config without
 * the list leaves the existing schedules untouched. The token of Wrangler's own login stays in
 * memory and is never printed.
 */
export function declaredCronTriggers(configuration, env) {
  const crons = configuration.triggers?.crons;
  if (crons === undefined) return null;
  if (
    !Array.isArray(crons) ||
    crons.some((cron) => typeof cron !== "string" || !CRON.test(cron)) ||
    new Set(crons).size !== crons.length
  )
    throw new Error("Wrangler triggers.crons must list distinct cron expressions");
  const configured = configuration.account_id;
  const overridden = env.CLOUDFLARE_ACCOUNT_ID;
  const accountId = configured ?? overridden;
  if (
    typeof accountId !== "string" ||
    !ACCOUNT_ID.test(accountId) ||
    (configured !== undefined && overridden !== undefined && configured !== overridden)
  )
    throw new Error("Cron trigger synchronization requires one exact Cloudflare account_id");
  return Object.freeze({ crons: Object.freeze([...crons]), accountId });
}

export async function synchronizeCronTriggers({ target, workerName, run, wrangler, fetch }) {
  if (target === null) return "preserved";
  const { crons, accountId } = target;
  let credential;
  try {
    credential = parseObject(
      await run(wrangler, ["auth", "token", "--json"], { cwd: tmpdir() }),
      "Wrangler credential",
    );
  } catch {
    // A failed command carries its stdout and a JSON parse message quotes its input; both can
    // hold the token, so neither error may reach the release output.
    throw new Error("Wrangler credential is unavailable");
  }
  if (
    (credential.type !== "oauth" && credential.type !== "api_token") ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  )
    throw new Error("Wrangler credential cannot authorize cron trigger synchronization");
  const url = `${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/schedules`;
  const schedules = async (method, body) => {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("Cron trigger schedules are unavailable");
    }
    const value = await response.json().catch(() => null);
    const current = value?.result?.schedules;
    if (
      !response.ok ||
      value?.success !== true ||
      !Array.isArray(current) ||
      current.some((schedule) => typeof schedule?.cron !== "string")
    )
      throw new Error(`Cron trigger schedules request failed with status ${response.status}`);
    return current.map((schedule) => schedule.cron).sort();
  };
  const declared = [...crons].sort();
  const matches = (current) =>
    current.length === declared.length && current.every((cron, index) => cron === declared[index]);
  if (matches(await schedules("GET"))) return "unchanged";
  await schedules(
    "PUT",
    crons.map((cron) => ({ cron })),
  );
  if (!matches(await schedules("GET")))
    throw new Error("Cron trigger readback does not match the declared crons");
  return "updated";
}

async function readVersions({ common, run, wrangler, allowMissingWorker = false, scope }) {
  const args = ["versions", "list", "--json", ...common];
  let output;
  try {
    output = await run(wrangler, args, {
      cwd: tmpdir(),
      ...(allowMissingWorker ? { observeWorker: scope } : {}),
    });
  } catch (error) {
    // Initial P28 billing release returned this exact provider absence, before any upload. The
    // train adapter classifies it before erasing stderr and throws the typed error; a direct
    // runner leaves the raw diagnostic, which the same scoped classifier accepts.
    if (
      allowMissingWorker &&
      (isWorkerAbsentError(error, scope) ||
        classifyWorkerAbsence({ command: wrangler, args, context: scope, error }) !== null)
    )
      return null;
    throw error;
  }
  const value = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("versions readback must be an array");
  return value;
}

export async function readDeployment({ common, run, wrangler }) {
  return parseObject(
    await run(wrangler, ["deployments", "status", "--json", ...common], { cwd: tmpdir() }),
    "deployment readback",
  );
}

function matchingVersions(versions, tag, message) {
  return versions.filter(
    (version) =>
      version?.annotations?.["workers/tag"] === tag &&
      version?.annotations?.["workers/message"] === message,
  );
}

/** The schema pin of the Core migrations at a source commit: the head a Core release must already be at. */
export async function corePinAt(repositoryRoot, sourceCommit) {
  return (await migrationSnapshot(repositoryRoot, sourceCommit)).pin;
}

/**
 * Reads the Core schema receipts through the rendered configuration, so the account and database id come
 * from the same config the release would upload with, and refuses any head other than the source's pin.
 */
export async function requireCoreSchemaHead({
  configPath,
  sourceCommit,
  repositoryRoot,
  run,
  wrangler,
  readCorePin = corePinAt,
}) {
  const pin = await readCorePin(repositoryRoot, sourceCommit);
  const output = JSON.parse(
    await run(
      wrangler,
      [
        "d1",
        "execute",
        "CONTROL_CORE",
        "--remote",
        "--config",
        configPath,
        "--json",
        "--command",
        SCHEMA_RECEIPTS_SQL,
      ],
      { cwd: tmpdir() },
    ),
  );
  const receipts = output?.[0]?.results;
  if (!Array.isArray(receipts)) throw new Error("Core schema receipts are unreadable");
  requireSchemaHeadForPin(receipts, pin);
}

function newestVersion(versions) {
  const created = versions.map((version) => Date.parse(version?.metadata?.created_on));
  if (created.some((time) => !Number.isFinite(time)) || new Set(created).size !== created.length)
    throw new Error("provider did not return one exact release version");
  return versions[created.indexOf(Math.max(...created))];
}

function isExactDeployment(value, versionId) {
  return (
    Array.isArray(value.versions) &&
    value.versions.length === 1 &&
    value.versions[0]?.version_id === versionId &&
    value.versions[0]?.percentage === 100
  );
}

export function parseObject(source, label) {
  const value = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function absoluteFrom(directory, value) {
  return isAbsolute(value) ? value : resolve(directory, value);
}

function clean(value) {
  return value.trim();
}

export function parseJsonc(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += "\n";
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
    } else output += character;
  }
  if (inString || blockComment) throw new TypeError("unterminated JSONC input");
  return JSON.parse(removeTrailingCommas(output));
}

function removeTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(source[lookahead] ?? "")) lookahead += 1;
      if (["}", "]"].includes(source[lookahead])) continue;
    }
    output += character;
  }
  return output;
}

async function runCommand(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--config", "--name", "--wrangler", "--secrets-file", "--container-images"].includes(
        flag,
      ) ||
      !value
    ) {
      throw new Error(
        "usage: platform-release --config <path> [--name <worker>] [--wrangler <path>] [--secrets-file <mode-600-json>] [--container-images <private-json-outside-checkout>]",
      );
    }
    result[flag.slice(2)] = value;
  }
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const result = await releaseWorker({
    configPath: resolve(options.config),
    expectedName: options.name,
    wrangler: options.wrangler,
    secretsFile: options["secrets-file"],
    containerImages: options["container-images"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
