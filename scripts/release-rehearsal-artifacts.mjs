/* global process, structuredClone */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildWorkerPackages,
  parseJsonc,
  readArtifactDigest,
  renderWranglerConfiguration,
  validateReleaseSecretsFile,
} from "./platform-release.mjs";
import {
  captureLocalContainerImageIdentity,
  imageRecipe,
  containerBuildInput,
  validateLocalContainerImage,
} from "./platform-container-release.mjs";
import { controlCoreRenderInput, isControlCoreStep } from "./control-core-train.mjs";
import {
  isPrivateWorkerStep,
  privateWorkerEvidence,
  resolvePrivateWorkerProfile,
  validatePrivateWorkerConfiguration,
  validatePrivateWorkerEvidence,
} from "./release-private-worker.mjs";

export const releaseHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));

export async function readPrivateReleaseJson(
  path,
  { optional = false, maxBytes = 1024 * 1024 } = {},
) {
  let handle;
  try {
    handle = await open(
      resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw new Error("Private release file cannot be opened safely");
  }
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid()) ||
      details.size < 2 ||
      details.size > maxBytes
    )
      throw new Error("Private release file permissions or size are invalid");
    const contents = await handle.readFile("utf8");
    try {
      return { contents, value: JSON.parse(contents) };
    } catch {
      throw new Error("Private release file JSON is invalid");
    }
  } finally {
    await handle.close();
  }
}

export async function requirePrivateReleaseDirectory(path, repositoryRoot) {
  const [root, directory] = await Promise.all([realpath(repositoryRoot), realpath(path)]);
  const offset = relative(root, directory);
  if (!(offset === ".." || offset.startsWith("../") || isAbsolute(offset)))
    throw new Error("Release artifacts and state must live outside the checkout");
  const details = await stat(directory);
  if (
    !details.isDirectory() ||
    (details.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && details.uid !== process.getuid())
  )
    throw new Error("Release directory must be private and owned by the operator");
  return directory;
}

async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error("Rehearsal artifacts must not contain symbolic links");
    const name = prefix + entry.name;
    if (entry.isDirectory())
      result.push(...(await listFiles(join(directory, entry.name), `${name}/`)));
    else if (entry.isFile()) result.push(name);
    else throw new Error("Rehearsal artifact is not a regular file");
  }
  return result.sort();
}

async function readArtifactBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1)
      throw new Error("Release asset must be one regular, unlinked source file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assetInventory(directory) {
  const records = [];
  for (const path of await listFiles(directory)) {
    const bytes = await readArtifactBytes(join(directory, path));
    records.push({ path, bytes: bytes.length, sha256: releaseHash(bytes) });
  }
  return records;
}

async function containedAssetDirectory(configuration, repositoryRoot) {
  const [root, source] = await Promise.all([
    realpath(repositoryRoot),
    realpath(configuration.assets.directory),
  ]);
  const offset = relative(root, source);
  if (
    offset === "" ||
    offset === ".." ||
    offset.startsWith("../") ||
    isAbsolute(offset) ||
    !(await stat(source)).isDirectory()
  )
    throw new Error("Release assets must be a regular directory inside the source checkout");
  return source;
}

async function snapshotAssets({ configuration, repositoryRoot, directory }) {
  if (configuration.assets === undefined) return null;
  const sourceDirectory = await containedAssetDirectory(configuration, repositoryRoot);
  const snapshot = join(await realpath(directory), "assets");
  await mkdir(snapshot, { recursive: true, mode: 0o700 });
  if ((await requirePrivateReleaseDirectory(snapshot, repositoryRoot)) !== snapshot)
    throw new Error("Retained release assets must not redirect their directory");
  await listFiles(snapshot);
  const files = await assetInventory(sourceDirectory);
  for (const record of files) {
    const bytes = await readArtifactBytes(join(sourceDirectory, record.path));
    if (bytes.length !== record.bytes || releaseHash(bytes) !== record.sha256)
      throw new Error("Release source assets changed while snapshotting");
    const destination = join(snapshot, record.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const retained = await readArtifactBytes(destination);
      if (retained.length !== record.bytes || releaseHash(retained) !== record.sha256)
        throw new Error("Retained release asset differs from the source snapshot");
    }
  }
  if (
    JSON.stringify(await assetInventory(sourceDirectory)) !== JSON.stringify(files) ||
    JSON.stringify(await assetInventory(snapshot)) !== JSON.stringify(files)
  )
    throw new Error("Release asset inventory changed while snapshotting");
  return { sourceDirectory, directory: snapshot, files };
}

async function validateAssetSnapshot({ assets, configuration, repositoryRoot, directory }) {
  if (configuration.assets === undefined) {
    if (assets !== null) throw new Error("Worker rehearsal has unexpected assets");
    return;
  }
  if (
    !own(assets, ["sourceDirectory", "directory", "files"]) ||
    !isAbsolute(assets.sourceDirectory ?? "") ||
    !isAbsolute(assets.directory ?? "") ||
    !Array.isArray(assets.files) ||
    assets.files.some(
      (record) =>
        !own(record, ["path", "bytes", "sha256"]) ||
        typeof record.path !== "string" ||
        isAbsolute(record.path) ||
        record.path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 0 ||
        !HASH.test(record.sha256 ?? ""),
    )
  )
    throw new Error("Worker rehearsal asset metadata is invalid");
  const source = await containedAssetDirectory(configuration, repositoryRoot);
  const snapshot = await requirePrivateReleaseDirectory(assets.directory, repositoryRoot);
  if (
    assets.sourceDirectory !== source ||
    snapshot !== join(await realpath(directory), "assets") ||
    assets.directory !== snapshot ||
    JSON.stringify(await assetInventory(source)) !== JSON.stringify(assets.files) ||
    JSON.stringify(await assetInventory(snapshot)) !== JSON.stringify(assets.files)
  )
    throw new Error("Worker rehearsal source or retained asset inventory changed");
}

/** Build with no provider operations. Images are Docker-only; Wrangler only bundles with --dry-run. */
export async function rehearseWorker({
  step,
  repositoryRoot,
  sha,
  directory,
  run,
  wrangler,
  previousImages = {},
  accountId,
  coreDatabaseId,
}) {
  const command = run;
  run = (name, args, options = {}) => command(name, args, { ...options, localOnly: true });
  if (!SHA.test(sha)) throw new Error("Rehearsal requires the exact source commit");
  const configPath = resolve(repositoryRoot, step.config);
  if (releaseHash(await readFile(configPath)) !== step.configSha256)
    throw new Error("Rehearsal source configuration digest differs");
  // A private Worker creation is checked against its closed capability profile, and its creation
  // identity is fixed, before anything is built or bundled.
  const creating = isPrivateWorkerStep(step);
  let privateWorker;
  if (creating) {
    validatePrivateWorkerConfiguration({
      environment: resolvePrivateWorkerProfile(step).environment,
      profile: step.profile,
      configuration: parseJsonc(await readFile(configPath, "utf8")),
    });
    privateWorker = privateWorkerEvidence({ step });
  }
  await buildWorkerPackages({ configPath, repositoryRoot, run });
  if (step.secretsFile !== undefined) await validateReleaseSecretsFile({ path: step.secretsFile });
  await mkdir(directory, { mode: 0o700, recursive: true });
  const artifact = await readArtifactDigest({ repositoryRoot, workerName: step.workerName });
  const configFile = join(directory, "wrangler.json");
  const configuration = await renderWranglerConfiguration({
    expectedName: step.workerName,
    outputPath: configFile,
    sourcePath: configPath,
    artifact,
    core: isControlCoreStep(step)
      ? controlCoreRenderInput({ step, accountId, sourceCommit: sha, repositoryRoot })
      : undefined,
    coreDatabaseId,
  });
  if (creating)
    validatePrivateWorkerConfiguration({
      environment: resolvePrivateWorkerProfile(step).environment,
      profile: step.profile,
      configuration,
    });
  const configurationSha256 = releaseHash(JSON.stringify(configuration));
  const images = {};
  for (const declared of configuration.containers ?? []) {
    const container = containerBuildInput(declared);
    const recipe = await imageRecipe(container, repositoryRoot);
    const key = releaseHash(JSON.stringify(recipe));
    if (images[key] !== undefined) continue;
    if (previousImages[key] !== undefined) {
      await validateLocalContainerImage({ image: previousImages[key], sha, recipe: key, run });
      images[key] = previousImages[key];
      continue;
    }
    const tag = `ohmyho-release-${key.slice(0, 16)}:${sha}`;
    const metadataPath = join(directory, `image-metadata-${key}.json`);
    const args = [
      "build",
      "--load",
      "--platform",
      "linux/amd64",
      "--provenance=false",
      "--metadata-file",
      metadataPath,
      "--label",
      `org.opencontainers.image.revision=${sha}`,
      "--label",
      "org.opencontainers.image.source=https://github.com/amerged-org/ohmyhost",
      "--label",
      `st.ohmyho.release.recipe=${key}`,
      "--file",
      container.image,
      "--tag",
      tag,
    ];
    for (const [name, value] of Object.entries(recipe.args))
      args.push("--build-arg", `${name}=${value}`);
    args.push(container.image_build_context ?? dirname(container.image));
    await run("docker", args, { cwd: repositoryRoot });
    let inspected;
    try {
      inspected = JSON.parse(await run("docker", ["image", "inspect", tag]));
    } catch {
      throw new Error("Rehearsal Docker image readback is invalid");
    }
    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      throw new Error("Rehearsal BuildKit image metadata is unavailable");
    }
    const image = captureLocalContainerImageIdentity({
      record: inspected?.[0],
      metadata,
      sha,
      recipe: key,
    });
    await validateLocalContainerImage({ image, sha, recipe: key, run });
    images[key] = image;
  }
  // Wrangler must not invoke its Container builder/publisher during the local bundle dry-run.
  const assets = await snapshotAssets({ configuration, repositoryRoot, directory });
  const localConfiguration = { ...configuration };
  if (assets !== null)
    localConfiguration.assets = { ...configuration.assets, directory: assets.directory };
  delete localConfiguration.containers;
  delete localConfiguration.build;
  await writeFile(configFile, `${JSON.stringify(localConfiguration, null, 2)}\n`, { mode: 0o600 });
  const output = join(directory, "bundle");
  await run(
    wrangler,
    [
      "deploy",
      "--dry-run",
      "--name",
      step.workerName,
      "--config",
      configFile,
      "--outdir",
      output,
      "--metafile",
      join(directory, "metafile.json"),
    ],
    { cwd: directory, localOnly: true },
  );
  const metadata = JSON.parse(await readFile(join(directory, "metafile.json"), "utf8"));
  const files = await listFiles(output);
  const entries = Object.entries(metadata.outputs ?? {}).filter(
    ([, record]) =>
      typeof record?.entryPoint === "string" &&
      resolve(directory, record.entryPoint) === configuration.main,
  );
  if (entries.length !== 1) throw new Error("Rehearsal bundle has no unique Worker entrypoint");
  const entryPath = resolve(directory, entries[0][0]);
  const entrypoint = relative(output, entryPath);
  if (!files.includes(entrypoint))
    throw new Error("Rehearsal entrypoint leaves the bundle directory");
  const bundles = [];
  for (const path of files) {
    const bytes = await readFile(join(output, path));
    bundles.push({ path, bytes: bytes.length, sha256: releaseHash(bytes) });
  }
  return {
    workerName: step.workerName,
    sourceCommit: sha,
    sourceConfigSha256: step.configSha256,
    configurationSha256,
    artifactDigest: artifact?.digest ?? null,
    directory: resolve(directory),
    entrypoint,
    bundles,
    images,
    assets,
    ...(privateWorker === undefined ? {} : { privateWorker }),
  };
}

export async function validateWorkerRehearsal({
  proof,
  repositoryRoot,
  sha,
  workerName,
  configPath,
  run,
  configuration,
  privateWorker,
  core,
  coreDatabaseId,
}) {
  if (
    !own(proof, [
      "workerName",
      "sourceCommit",
      "sourceConfigSha256",
      "configurationSha256",
      "artifactDigest",
      "directory",
      "entrypoint",
      "bundles",
      "images",
      "assets",
      "privateWorker",
    ]) ||
    proof.workerName !== workerName ||
    proof.sourceCommit !== sha ||
    !HASH.test(proof.sourceConfigSha256 ?? "") ||
    !HASH.test(proof.configurationSha256 ?? "") ||
    !isAbsolute(proof.directory ?? "") ||
    !object(proof.images)
  )
    throw new Error("Worker rehearsal provenance is invalid");
  // Only a creation step carries its profile evidence (profile and creation id); the train
  // passes the expected evidence, so a proof can neither gain nor lose it silently.
  if (proof.privateWorker !== undefined) validatePrivateWorkerEvidence(proof.privateWorker);
  if (privateWorker !== undefined && !isDeepStrictEqual(proof.privateWorker, privateWorker))
    throw new Error("Worker rehearsal private profile differs");
  await requirePrivateReleaseDirectory(proof.directory, repositoryRoot);
  if (releaseHash(await readFile(configPath)) !== proof.sourceConfigSha256)
    throw new Error("Worker rehearsal source configuration changed");
  if (configuration === undefined) {
    const artifact = await readArtifactDigest({ repositoryRoot, workerName });
    if ((artifact?.digest ?? null) !== proof.artifactDigest)
      throw new Error("Worker rehearsal artifact pin changed");
    const rendered = join(proof.directory, "verify-wrangler.json");
    configuration = await renderWranglerConfiguration({
      expectedName: workerName,
      sourcePath: configPath,
      outputPath: rendered,
      artifact,
      core,
      coreDatabaseId,
    });
  }
  if (releaseHash(JSON.stringify(configuration)) !== proof.configurationSha256)
    throw new Error("Worker rehearsal rendered configuration changed");
  const output = join(proof.directory, "bundle");
  const files = await listFiles(output);
  if (
    !Array.isArray(proof.bundles) ||
    proof.bundles.length === 0 ||
    JSON.stringify(files) !== JSON.stringify(proof.bundles.map((record) => record.path)) ||
    !files.includes(proof.entrypoint)
  )
    throw new Error("Worker rehearsal bundle inventory changed");
  for (const record of proof.bundles) {
    if (
      !own(record, ["path", "bytes", "sha256"]) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      !HASH.test(record.sha256 ?? "")
    )
      throw new Error("Worker rehearsal bundle metadata is invalid");
    const bytes = await readFile(join(output, record.path));
    if (bytes.length !== record.bytes || releaseHash(bytes) !== record.sha256)
      throw new Error("Worker rehearsal bundle bytes changed");
  }
  const recipes = new Set();
  for (const container of configuration.containers ?? []) {
    const key = releaseHash(JSON.stringify(await imageRecipe(container, repositoryRoot)));
    recipes.add(key);
    const image = proof.images[key];
    if (
      !own(image, ["imageId", "recipeSha256", "imageIdKind", "manifestDigest", "configDigest"]) ||
      !IMAGE.test(image.imageId ?? "")
    )
      throw new Error("Worker rehearsal image receipt is invalid");
    await validateLocalContainerImage({ image, sha, recipe: key, run });
  }
  if (Object.keys(proof.images).length !== recipes.size)
    throw new Error("Worker rehearsal image recipe set changed");
  await validateAssetSnapshot({
    assets: proof.assets,
    configuration,
    repositoryRoot,
    directory: proof.directory,
  });
  const reused = {
    ...structuredClone(configuration),
    main: join(output, proof.entrypoint),
    no_bundle: true,
  };
  if (proof.assets !== null) reused.assets.directory = proof.assets.directory;
  delete reused.build;
  return reused;
}
