/* global Buffer, process */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REQUIRED_CONFIGURATION_NAMES = Object.freeze({
  WORKOS_AUTHKIT_CLIENT_ID: Object.freeze(["WORKOS_AUTHKIT_CLIENT_ID", "WORKOS_CLIENT_ID"]),
  WORKOS_AUTHKIT_DOMAIN: Object.freeze(["WORKOS_AUTHKIT_DOMAIN"]),
  WORKOS_CONNECT_APPLICATION_ID: Object.freeze(["WORKOS_CONNECT_APPLICATION_ID"]),
  WORKOS_CONNECT_CLIENT_ID: Object.freeze(["WORKOS_CONNECT_CLIENT_ID"]),
  WORKOS_CONNECT_CLIENT_SECRET_REF: Object.freeze([
    "WORKOS_CONNECT_CLIENT_SECRET_REF",
    "WORKOS_CONNECT_CLIENT_SECRET",
  ]),
  WORKOS_MANAGEMENT_API_KEY_REF: Object.freeze(["WORKOS_MANAGEMENT_API_KEY_REF", "WORKOS_API_KEY"]),
  WORKOS_WEBHOOK_SECRET_REF: Object.freeze(["WORKOS_WEBHOOK_SECRET_REF", "WORKOS_WEBHOOK_SECRET"]),
});

const SCHEMA_VERSION = "phase1-runner-result-v1";
const INVENTORY_SCHEMA_VERSION = "phase1-auth-name-inventory-v1";
const SCOPE = "phase1_auth_preflight_names";
const COMMAND = "pnpm phase1:auth-preflight:names";
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EVIDENCE_DIRECTORY = "docs/plan/evidence/legacy/phase1";

const gitEnvironment = {
  LC_ALL: "C",
  PATH: process.env["PATH"] ?? "",
};

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const encodeBase32 = (value, length) => {
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
};

export const createRunId = (now = Date.now(), entropy = randomBytes(10)) => {
  const timestamp = encodeBase32(BigInt(now), 10);
  const randomness = encodeBase32(BigInt(`0x${entropy.toString("hex")}`), 16);
  return `${timestamp}${randomness}`;
};

const normalizeEnvironmentName = (candidate) => {
  const normalized = candidate.trim().replace(/^export\s+/u, "");
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized) ? normalized : null;
};

export const readEnvironmentNames = async (path) => {
  const names = new Set();
  let candidate = "";
  let beforeValue = true;

  try {
    for await (const chunk of createReadStream(path)) {
      for (const byte of chunk) {
        if (byte === 10) {
          candidate = "";
          beforeValue = true;
          continue;
        }
        if (!beforeValue) {
          continue;
        }
        if (byte === 61) {
          const name = normalizeEnvironmentName(candidate);
          if (name !== null) {
            names.add(name);
          }
          candidate = "";
          beforeValue = false;
          continue;
        }
        if (byte !== 13) {
          candidate += String.fromCharCode(byte);
        }
      }
    }
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return names;
    }
    throw error;
  }

  return names;
};

const git = (root, arguments_) =>
  spawnSync("git", arguments_, {
    cwd: root,
    encoding: "buffer",
    env: { ...gitEnvironment, GIT_CEILING_DIRECTORIES: dirname(root) },
  });

const normalizeRelativePath = (path) => path.split(sep).join("/");

const isExcludedPath = (path) => {
  if (path === ".env" || path === ".env.local" || /^\.env\..*\.local$/u.test(path)) {
    return true;
  }
  return (
    path === ".ohmyhost" ||
    path.startsWith(".ohmyhost/") ||
    path.startsWith(`${EVIDENCE_DIRECTORY}/`)
  );
};

const listFallbackFiles = async (root, directory = root) => {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = normalizeRelativePath(relative(root, absolutePath));
    if (isExcludedPath(relativePath) || entry.name === ".git") {
      continue;
    }
    if (entry.isDirectory()) {
      paths.push(...(await listFallbackFiles(root, absolutePath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(relativePath);
    }
  }
  return paths;
};

const listWorktreeFiles = async (root) => {
  const result = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) {
    return listFallbackFiles(root);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !isExcludedPath(path));
};

const hashWorktreeFile = async (root, path) => {
  const absolutePath = join(root, path);
  const metadata = await lstat(absolutePath);
  const content = metadata.isSymbolicLink()
    ? Buffer.from(await readlink(absolutePath), "utf8")
    : await readFile(absolutePath);
  return sha256(content);
};

const appendLengthPrefixed = (hash, value) => {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${bytes.length}:`, "utf8");
  hash.update(bytes);
};

export const createWorktreeDigest = async (root) => {
  const paths = [...new Set(await listWorktreeFiles(root))].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const fileHash = await hashWorktreeFile(root, path);
    appendLengthPrefixed(hash, path);
    appendLengthPrefixed(hash, fileHash);
  }
  return hash.digest("hex");
};

const readGitState = (root) => {
  const commitResult = git(root, ["rev-parse", "--verify", "HEAD"]);
  const gitCommit =
    commitResult.status === 0 ? commitResult.stdout.toString("utf8").trim() || null : null;
  const statusResult = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirty = statusResult.status !== 0 || statusResult.stdout.length > 0;
  return { dirty, gitCommit };
};

const parseArguments = (arguments_) => {
  const options = { envFile: null, output: null, root: process.cwd() };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (!["--env-file", "--output", "--root"].includes(argument) || value === undefined) {
      throw new Error("INVALID_ARGUMENTS");
    }
    if (argument === "--env-file") options.envFile = value;
    if (argument === "--output") options.output = value;
    if (argument === "--root") options.root = value;
    index += 1;
  }
  return options;
};

const writeAtomic = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
};

export const runNamePreflight = async ({ envFile, output, root }) => {
  const startedAt = new Date();
  const runId = createRunId();
  const absoluteRoot = resolve(root);
  const gitState = readGitState(absoluteRoot);
  const outputPath =
    output === null
      ? join(
          absoluteRoot,
          EVIDENCE_DIRECTORY,
          gitState.gitCommit ?? runId,
          "auth-preflight-names.json",
        )
      : isAbsolute(output)
        ? output
        : resolve(absoluteRoot, output);
  const inventoryStartedAt = performance.now();
  const fileNames = await readEnvironmentNames(
    envFile === null
      ? join(absoluteRoot, ".env.local")
      : isAbsolute(envFile)
        ? envFile
        : resolve(absoluteRoot, envFile),
  );
  const processNames = new Set(Object.keys(process.env));
  const configurationNames = Object.entries(REQUIRED_CONFIGURATION_NAMES).map(
    ([name, acceptedNames]) => ({
      name,
      present: acceptedNames.some(
        (acceptedName) => fileNames.has(acceptedName) || processNames.has(acceptedName),
      ),
    }),
  );
  const unmetPrerequisites = configurationNames
    .filter(({ present }) => !present)
    .map(({ name }) => name);
  const runnerState = unmetPrerequisites.length === 0 ? "PASS" : "BLOCKED_PREREQUISITE";
  const result = {
    schema_version: SCHEMA_VERSION,
    scope: SCOPE,
    runner_state: runnerState,
    foundation_outcome: "BLOCKED",
    candidate_outcome: "UNDECIDED",
    reason_code:
      runnerState === "PASS" ? "CONFIGURATION_NAMES_PRESENT" : "CONFIGURATION_NAMES_MISSING",
    command: COMMAND,
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: await createWorktreeDigest(absoluteRoot),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    checks: [
      {
        id: "required_configuration_names",
        state: runnerState,
        duration_ms: Math.max(0, Math.round(performance.now() - inventoryStartedAt)),
        evidence_ref: "auth-preflight-names.json#/sanitized_metrics/configuration_names",
      },
    ],
    sanitized_metrics: {
      inventory_schema_version: INVENTORY_SCHEMA_VERSION,
      configuration_names: configurationNames,
      present_count: configurationNames.length - unmetPrerequisites.length,
      required_count: configurationNames.length,
    },
    unmet_prerequisites: unmetPrerequisites,
    evidence_artifacts: [],
    evidence_manifest_sha256: EMPTY_SHA256,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  await writeAtomic(outputPath, serialized);
  await writeAtomic(
    join(dirname(outputPath), "manifest.sha256"),
    `${sha256(serialized)}  ${outputPath.split(sep).at(-1)}\n${EMPTY_SHA256}  evidence_manifest\n`,
  );
  return { outputPath, result, serialized };
};

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { result, serialized } = await runNamePreflight(options);
    process.stdout.write(serialized);
    process.exitCode = result.runner_state === "PASS" ? 0 : 2;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "PREFLIGHT_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
