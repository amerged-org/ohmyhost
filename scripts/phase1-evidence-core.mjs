import { isManagementRuntimeContract } from "../apps/workos-management/scripts/runtime-contract.mjs";
/* global Buffer, clearTimeout, process, setTimeout */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = "phase1-runner-result-v1";
export const EVIDENCE_INVENTORY_SCHEMA_VERSION = "phase1-evidence-inventory-v1";
export const EMPTY_SHA256 = createHash("sha256").digest("hex");

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EVIDENCE_DIRECTORY = "docs/plan/evidence/legacy/phase1";
const OFFLINE_SELF_TEST_GUARD = fileURLToPath(
  new globalThis.URL("./phase1-offline-self-test-guard.mjs", import.meta.url),
);

export const findNewestEvidence = async (root, filename) => {
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/u.test(filename)) {
    throw new Error("INVALID_EVIDENCE_FILENAME");
  }
  const directory = join(root, EVIDENCE_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, filename);
    try {
      const metadata = await lstat(path);
      if (metadata.isFile()) candidates.push({ path, modified: metadata.mtimeMs });
    } catch (error) {
      if (
        !(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
  candidates.sort(
    (left, right) => right.modified - left.modified || right.path.localeCompare(left.path),
  );
  return candidates[0]?.path ?? null;
};

export const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const encodeBase32 = (value, length) => {
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
};

export const createRunId = (now = Date.now(), entropy = randomBytes(10)) =>
  `${encodeBase32(BigInt(now), 10)}${encodeBase32(BigInt(`0x${entropy.toString("hex")}`), 16)}`;

const normalizeRelativePath = (path) => path.split(sep).join("/");

const isSecretOrEvidencePath = (path, credentialStorePaths) => {
  if (path === ".env.example") return false;
  const basename = path.split("/").at(-1) ?? path;
  if (basename === ".env" || basename === ".env.local" || /^\.env\..*\.local$/u.test(basename)) {
    return true;
  }
  if (path === ".ohmyhost" || path.startsWith(".ohmyhost/")) return true;
  if (path === EVIDENCE_DIRECTORY || path.startsWith(`${EVIDENCE_DIRECTORY}/`)) return true;
  return credentialStorePaths.some(
    (credentialPath) => path === credentialPath || path.startsWith(`${credentialPath}/`),
  );
};

const gitEnvironment = Object.freeze({
  LC_ALL: "C",
  PATH: process.env["PATH"] ?? "",
});

const runGit = async (root, arguments_) => {
  const child = spawn("git", arguments_, {
    cwd: root,
    // Node may inject its coverage transport into the per-spawn options. Preserve the frozen allowlist,
    // but give child_process its own mutable copy rather than an ambient environment.
    env: { ...gitEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const status = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", resolveStatus);
  });
  return {
    status,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
};

const listFallbackFiles = async (root, credentialStorePaths, directory = root) => {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = normalizeRelativePath(relative(root, absolutePath));
    if (entry.name === ".git" || isSecretOrEvidencePath(relativePath, credentialStorePaths)) {
      continue;
    }
    if (entry.isDirectory()) {
      paths.push(...(await listFallbackFiles(root, credentialStorePaths, absolutePath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(relativePath);
    }
  }
  return paths;
};

const listWorktreeFiles = async (root, credentialStorePaths) => {
  const result = await runGit(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (result.status !== 0) return listFallbackFiles(root, credentialStorePaths);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !isSecretOrEvidencePath(path, credentialStorePaths));
};

const appendLengthPrefixed = (hash, value) => {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${bytes.length}:`, "utf8");
  hash.update(bytes);
};

export const createWorktreeDigest = async (root, credentialStorePaths = []) => {
  const normalizedCredentialPaths = credentialStorePaths.map((path) =>
    normalizeRelativePath(isAbsolute(path) ? relative(root, path) : path),
  );
  if (
    normalizedCredentialPaths.some((path) => path !== ".ohmyhost" && !path.startsWith(".ohmyhost/"))
  ) {
    throw new Error("INVALID_CREDENTIAL_STORE_PATH");
  }
  const paths = [...new Set(await listWorktreeFiles(root, normalizedCredentialPaths))].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolutePath = join(root, path);
    const metadata = await lstat(absolutePath);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath), "utf8")
      : await readFile(absolutePath);
    appendLengthPrefixed(hash, path);
    appendLengthPrefixed(hash, sha256(content));
  }
  return hash.digest("hex");
};

export const readGitState = async (root) => {
  const commit = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    gitCommit: commit.status === 0 ? commit.stdout.toString("utf8").trim() || null : null,
    dirty: status.status !== 0 || status.stdout.length > 0,
  };
};

export const writeAtomic = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
};

const createSafeCommandEnvironment = () => {
  const environment = {};
  for (const name of [
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment["CI"] = "true";
  environment["REDOCLY_SUPPRESS_UPDATE_NOTICE"] = "true";
  environment["REDOCLY_TELEMETRY"] = "off";
  return environment;
};

export const executeHashedCommand = async ({ command, arguments_, cwd, id }) => {
  const startedAt = Date.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const child = spawn(command, arguments_, {
    cwd,
    env: createSafeCommandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdoutHash.update(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk) => {
    stderrHash.update(chunk);
    stderrBytes += chunk.length;
  });
  const exitCode = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveStatus(status ?? 1));
  });
  return {
    id,
    command: [command, ...arguments_].join(" "),
    exit_code: exitCode,
    duration_ms: Math.max(0, Date.now() - startedAt),
    stdout: { bytes: stdoutBytes, sha256: stdoutHash.digest("hex") },
    stderr: { bytes: stderrBytes, sha256: stderrHash.digest("hex") },
  };
};

const artifactFrame = (files) =>
  files
    .map(
      (file) =>
        `${String(file.path.length)}:${file.path}${String(file.sha256.length)}:${file.sha256}`,
    )
    .join("");

const firstRegularFile = async (paths) => {
  for (const path of paths) {
    try {
      if ((await lstat(path)).isFile()) return path;
    } catch (error) {
      if (
        !(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
  return null;
};

const createOfflineSandboxInvocation = async (nodeArguments) => {
  if (process.platform === "darwin") {
    const sandboxExec = await firstRegularFile(["/usr/bin/sandbox-exec"]);
    if (sandboxExec === null) return null;
    return {
      command: sandboxExec,
      arguments_: [
        "-p",
        "(version 1)(allow default)(deny network*)",
        process.execPath,
        ...nodeArguments,
      ],
    };
  }
  if (process.platform === "linux") {
    const bubblewrap = await firstRegularFile(["/usr/bin/bwrap", "/bin/bwrap"]);
    if (bubblewrap !== null) {
      return {
        command: bubblewrap,
        arguments_: [
          "--unshare-net",
          "--die-with-parent",
          "--new-session",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          process.execPath,
          ...nodeArguments,
        ],
      };
    }
    const unshare = await firstRegularFile(["/usr/bin/unshare", "/bin/unshare"]);
    if (unshare !== null) {
      return {
        command: unshare,
        arguments_: [
          "--user",
          "--map-root-user",
          "--net",
          "--fork",
          "--kill-child",
          process.execPath,
          ...nodeArguments,
        ],
      };
    }
  }
  return null;
};

const probeOfflineSandboxInvocation = async (invocation) => {
  const child = spawn(invocation.command, invocation.arguments_, {
    env: { LC_ALL: "C", PATH: process.env["PATH"] ?? "" },
    stdio: "ignore",
  });
  return await new Promise((resolveStatus) => {
    const timeout = setTimeout(() => child.kill(), 2000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolveStatus(false);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveStatus(code === 0);
    });
  });
};

export const resolveOfflineSandboxInvocation = async (
  nodeArguments,
  {
    createSystemInvocation = createOfflineSandboxInvocation,
    probeInvocation = probeOfflineSandboxInvocation,
    nodeExecutable = process.execPath,
  } = {},
) => {
  const probe = await createSystemInvocation(["--permission", "-e", ""]);
  if (probe !== null && (await probeInvocation(probe))) {
    const invocation = await createSystemInvocation(nodeArguments);
    if (invocation !== null) return invocation;
  }
  return { command: nodeExecutable, arguments_: nodeArguments };
};

const verifySandboxEntrypoint = async (root, entrypoint, artifactSha256) => {
  if (entrypoint !== "dist/sandbox-main.js") return false;
  const applicationRoot = await realpath(join(root, "apps/workos-management"));
  const offlineGuard = await realpath(OFFLINE_SELF_TEST_GUARD);
  const nodeArguments = [
    "--permission",
    `--allow-fs-read=${applicationRoot}`,
    `--allow-fs-read=${offlineGuard}`,
    "--import",
    offlineGuard,
    join(applicationRoot, entrypoint),
    "--self-test",
    artifactSha256,
  ];
  const sandbox = await resolveOfflineSandboxInvocation(nodeArguments);
  const child = spawn(sandbox.command, sandbox.arguments_, {
    cwd: join(root, "apps/workos-management"),
    env: { LC_ALL: "C", PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  const collect = (target) => (chunk) => {
    bytes += chunk.length;
    if (bytes > 4096) child.kill();
    else target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const status = await new Promise((resolveStatus) => {
    const timeout = setTimeout(() => child.kill(), 2000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolveStatus(null);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveStatus(code);
    });
  });
  if (status !== 0 || bytes > 4096 || Buffer.concat(stderr).length !== 0) return false;
  try {
    const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    return (
      JSON.stringify(Object.keys(result).sort()) ===
        JSON.stringify(["artifact_sha256", "components", "schema_version"]) &&
      result.schema_version === "workos-management-sandbox-self-test-v1" &&
      result.artifact_sha256 === artifactSha256 &&
      JSON.stringify(result.components) ===
        JSON.stringify({ resolver: "configured", transport: "read_only", rpc: "authenticated" })
    );
  } catch {
    return false;
  }
};

export const validateCandidateArtifact = async (root) => {
  const artifactPath = join(root, "apps/workos-management/dist/candidate-artifact.json");
  const artifactMetadata = await lstat(artifactPath);
  if (!artifactMetadata.isFile()) throw new Error("INVALID_MANAGEMENT_ARTIFACT");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  if (
    artifact?.schemaVersion !== 2 ||
    artifact?.artifact !== "workos-management" ||
    artifact?.deploymentPolicy !== "service-binding-only" ||
    (artifact?.entrypoint !== undefined && artifact.entrypoint !== "dist/sandbox-main.js") ||
    artifact?.runtimeEntrypoint !== "dist/worker-bundle/worker-main.js" ||
    artifact?.runtimeContract !== "dist/runtime/runtime-contract.json" ||
    !Array.isArray(artifact?.files) ||
    artifact.files.length === 0
  ) {
    throw new Error("INVALID_MANAGEMENT_ARTIFACT");
  }
  const expectedPaths = [];
  const distRoot = join(root, "apps/workos-management/dist");
  const collectPaths = async (directory, prefix = "dist") => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (prefix === "dist" && entry.name === "candidate-artifact.json") continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collectPaths(join(directory, entry.name), path);
      else if (entry.isFile()) expectedPaths.push(path);
      else throw new Error("INVALID_MANAGEMENT_ARTIFACT_FILE");
    }
  };
  await collectPaths(distRoot);
  const normalizedFiles = [];
  const seen = new Set();
  for (const file of artifact.files) {
    if (
      typeof file?.path !== "string" ||
      !file.path.startsWith("dist/") ||
      file.path.includes("..") ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    ) {
      throw new Error("INVALID_MANAGEMENT_ARTIFACT_FILE");
    }
    seen.add(file.path);
    const content = await readFile(join(root, "apps/workos-management", file.path));
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new Error("MANAGEMENT_ARTIFACT_FILE_MISMATCH");
    }
    normalizedFiles.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  normalizedFiles.sort((left, right) => left.path.localeCompare(right.path));
  if (
    JSON.stringify(expectedPaths.sort((left, right) => left.localeCompare(right))) !==
    JSON.stringify(normalizedFiles.map(({ path }) => path))
  ) {
    throw new Error("MANAGEMENT_ARTIFACT_FILE_SET_MISMATCH");
  }
  const digest = sha256(artifactFrame(normalizedFiles));
  if (artifact.artifactSha256 !== digest) throw new Error("MANAGEMENT_ARTIFACT_DIGEST_MISMATCH");
  const runtimeContract = JSON.parse(
    await readFile(join(root, "apps/workos-management", artifact.runtimeContract), "utf8"),
  );
  if (!isManagementRuntimeContract(runtimeContract)) {
    throw new Error("INVALID_MANAGEMENT_RUNTIME_CONTRACT");
  }
  const launchable = await verifySandboxEntrypoint(root, artifact.entrypoint, digest);
  return {
    schema_version: 2,
    artifact: artifact.artifact,
    deployment_policy: artifact.deploymentPolicy,
    runtime: runtimeContract.runtime,
    runtime_entrypoint: artifact.runtimeEntrypoint,
    runtime_access: runtimeContract.access,
    launchable,
    artifact_sha256: digest,
    file_count: normalizedFiles.length,
    files: normalizedFiles,
  };
};

const createManifestDigest = (artifacts) => {
  const hash = createHash("sha256");
  for (const artifact of [...artifacts].sort((a, b) =>
    a.relative_path.localeCompare(b.relative_path),
  )) {
    appendLengthPrefixed(hash, artifact.relative_path);
    appendLengthPrefixed(hash, String(artifact.bytes));
    appendLengthPrefixed(hash, artifact.sha256);
  }
  return hash.digest("hex");
};

export const writeEvidence = async ({ root, runId, filename, result, payloads = [] }) => {
  const directory = join(root, EVIDENCE_DIRECTORY, runId);
  await mkdir(directory, { recursive: true });
  const artifacts = [];
  for (const payload of [...payloads].sort((a, b) => a.filename.localeCompare(b.filename))) {
    if (payload.filename === filename || payload.filename === "manifest.sha256") {
      throw new Error("RECURSIVE_EVIDENCE_PAYLOAD");
    }
    const serialized =
      typeof payload.content === "string"
        ? payload.content
        : `${JSON.stringify(payload.content, null, 2)}\n`;
    await writeAtomic(join(directory, payload.filename), serialized);
    artifacts.push({
      relative_path: payload.filename,
      sha256: sha256(serialized),
      bytes: Buffer.byteLength(serialized),
    });
  }
  const evidenceManifestSha256 = createManifestDigest(artifacts);
  const summary = {
    ...result,
    evidence_artifacts: artifacts,
    evidence_manifest_sha256: evidenceManifestSha256,
  };
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  await writeAtomic(join(directory, filename), serialized);
  await writeAtomic(
    join(directory, "manifest.sha256"),
    `${sha256(serialized)}  ${filename}\n${evidenceManifestSha256}  evidence_manifest\n`,
  );
  return { directory, outputPath: join(directory, filename), result: summary, serialized };
};

export const verifyEvidenceFile = async (path) => {
  const summaryMetadata = await lstat(path);
  if (!summaryMetadata.isFile()) throw new Error("INVALID_EVIDENCE_FILE");
  const serialized = await readFile(path, "utf8");
  const record = JSON.parse(serialized);
  if (record?.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error("INVALID_EVIDENCE_SCHEMA");
  }
  const artifacts = [];
  for (const artifact of record.evidence_artifacts ?? []) {
    if (
      typeof artifact?.relative_path !== "string" ||
      artifact.relative_path.includes("..") ||
      isAbsolute(artifact.relative_path) ||
      artifact.relative_path === "manifest.sha256" ||
      artifact.relative_path === path.split(sep).at(-1)
    ) {
      throw new Error("INVALID_EVIDENCE_ARTIFACT");
    }
    const artifactPath = join(dirname(path), artifact.relative_path);
    const artifactMetadata = await lstat(artifactPath);
    if (!artifactMetadata.isFile()) throw new Error("INVALID_EVIDENCE_ARTIFACT");
    const content = await readFile(artifactPath);
    if (content.byteLength !== artifact.bytes || sha256(content) !== artifact.sha256) {
      throw new Error("EVIDENCE_ARTIFACT_MISMATCH");
    }
    artifacts.push(artifact);
  }
  if (createManifestDigest(artifacts) !== record.evidence_manifest_sha256) {
    throw new Error("EVIDENCE_MANIFEST_MISMATCH");
  }
  const manifestPath = join(dirname(path), "manifest.sha256");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile()) throw new Error("INVALID_EVIDENCE_MANIFEST");
  const manifest = await readFile(manifestPath, "utf8");
  const expectedManifest = `${sha256(serialized)}  ${path.split(sep).at(-1)}\n${record.evidence_manifest_sha256}  evidence_manifest\n`;
  if (manifest !== expectedManifest) throw new Error("EVIDENCE_SUMMARY_MISMATCH");
  return record;
};

export const resolveEvidenceOutput = (root, runId, output) =>
  output === undefined ? join(root, EVIDENCE_DIRECTORY, runId) : resolve(root, output);

export const parseCommonArguments = (arguments_) => {
  const options = { root: process.cwd(), credentialStorePaths: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  return { ...options, root: resolve(options.root) };
};
