/* global process */

import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EVIDENCE_SCHEMA_VERSION,
  createRunId,
  createWorktreeDigest,
  readGitState,
  writeEvidence,
} from "./phase1-evidence-core.mjs";

const SCOPE = "phase1_credential_store_platform";
const COMMAND = "pnpm phase1:credential-store-platform-proof";
const BACKENDS = Object.freeze({
  darwin: "keychain",
  linux: "secret_service",
  win32: "credential_manager",
});
const CHECK_IDS = Object.freeze(["create", "read", "rotate", "delete", "security"]);

const sameCredential = (actual, expected) =>
  actual?.accessToken === expected.accessToken &&
  actual?.refreshToken === expected.refreshToken &&
  actual?.expiresAt === expected.expiresAt;

export const evaluateNativeCredentialRoundTrip = async (
  store,
  first,
  second,
  verifyBackend = async () => undefined,
) => {
  await store.clear();
  await store.replace(first);
  if (!sameCredential(await store.read(), first)) {
    throw new Error("NATIVE_CREDENTIAL_STORE_CONTRACT_FAILED");
  }
  await store.replace(second);
  if (!sameCredential(await store.read(), second)) {
    throw new Error("NATIVE_CREDENTIAL_STORE_CONTRACT_FAILED");
  }
  await verifyBackend();
  await store.clear();
  if ((await store.read()) !== undefined) {
    throw new Error("NATIVE_CREDENTIAL_STORE_CONTRACT_FAILED");
  }
  return { create: true, read: true, rotate: true, delete: true, security: true };
};

const createCredential = (expiresAt) => ({
  accessToken: randomBytes(32).toString("base64url"),
  refreshToken: randomBytes(32).toString("base64url"),
  expiresAt,
});

const loadNativeStore = async (root, serviceName) => {
  const moduleUrl = pathToFileURL(resolve(root, "apps/product-cli/dist/credential-store.js"));
  const { CredentialStoreUnavailableError, NativeNapiKeyringCredentialStore } = await import(
    moduleUrl.href
  );
  return {
    store: new NativeNapiKeyringCredentialStore(undefined, serviceName),
    isUnavailableError: (error) => error instanceof CredentialStoreUnavailableError,
  };
};

export const runCredentialStorePlatformProof = async ({
  root,
  credentialStorePaths = [],
  now = () => new Date(),
  runId = createRunId(),
  platform = process.platform,
  loadStore = loadNativeStore,
  verifyBackend = undefined,
  createCredentials = () => [
    createCredential("2099-01-01T00:00:00.000Z"),
    createCredential("2099-01-02T00:00:00.000Z"),
  ],
}) => {
  const startedAt = now();
  const nativeBackend = BACKENDS[platform];
  let runnerState = "BLOCKED_PREREQUISITE";
  let reasonCode = "NATIVE_PLATFORM_UNSUPPORTED";
  let unmetPrerequisites = ["supported_native_platform"];
  let checks = Object.fromEntries(CHECK_IDS.map((id) => [id, false]));
  let store;
  let isUnavailableError = () => false;
  let cleanupFailed = false;
  let backendVerified = false;
  const [first, second] = createCredentials();

  if (nativeBackend !== undefined) {
    try {
      const loaded = await loadStore(root, `ohmyhost-proof-${runId}`);
      store = loaded.store;
      isUnavailableError = loaded.isUnavailableError;
      const backendVerifier = verifyBackend ?? (async () => undefined);
      checks = await evaluateNativeCredentialRoundTrip(store, first, second, backendVerifier);
      backendVerified = true;
      runnerState = "PASS";
      reasonCode = "NATIVE_CREDENTIAL_STORE_PASSED";
      unmetPrerequisites = [];
    } catch (error) {
      if (error instanceof Error && error.message === "NATIVE_CREDENTIAL_STORE_CONTRACT_FAILED") {
        runnerState = "FAIL";
        reasonCode = error.message;
        unmetPrerequisites = [];
      } else if (isUnavailableError(error)) {
        runnerState = "BLOCKED_PREREQUISITE";
        reasonCode = "NATIVE_SERVICE_UNAVAILABLE";
        unmetPrerequisites = ["native_credential_service"];
      } else {
        runnerState = "FAIL";
        reasonCode = "NATIVE_CREDENTIAL_STORE_PROOF_FAILED";
        unmetPrerequisites = [];
      }
    } finally {
      if (store !== undefined) {
        try {
          await store.clear();
        } catch {
          cleanupFailed = true;
        }
      }
    }
  }

  if (cleanupFailed) {
    runnerState = "FAIL";
    reasonCode = "NATIVE_CREDENTIAL_STORE_CLEANUP_FAILED";
    unmetPrerequisites = [];
    checks = { ...checks, delete: false, security: false };
  }

  const gitState = await readGitState(root);
  const sanitizedProof = {
    platform,
    native_backend: nativeBackend ?? "unsupported",
    backend_verified: backendVerified,
    real_native: runnerState === "PASS",
    checks,
    provider_calls: 0,
  };
  const result = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: SCOPE,
    runner_state: runnerState,
    foundation_outcome: "BLOCKED",
    candidate_outcome: "UNDECIDED",
    reason_code: reasonCode,
    command: COMMAND,
    git_commit: gitState.gitCommit,
    run_id: runId,
    worktree_digest: await createWorktreeDigest(root, credentialStorePaths),
    dirty: gitState.dirty,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    checks: CHECK_IDS.map((id) => ({
      id,
      state: checks[id]
        ? "PASS"
        : runnerState === "BLOCKED_PREREQUISITE"
          ? "BLOCKED_PREREQUISITE"
          : "FAIL",
      duration_ms: 0,
      evidence_ref: "native-proof.json",
    })),
    sanitized_metrics: {
      platform,
      native_backend: nativeBackend ?? "unsupported",
      real_native: runnerState === "PASS",
      backend_verified: backendVerified,
      provider_calls: 0,
      gate_closures: [],
      backend_decision: null,
    },
    unmet_prerequisites: unmetPrerequisites,
  };
  const serializedSafeData = JSON.stringify({ result, sanitizedProof });
  for (const secret of [
    first.accessToken,
    first.refreshToken,
    second.accessToken,
    second.refreshToken,
  ]) {
    if (serializedSafeData.includes(secret)) throw new Error("NATIVE_EVIDENCE_SECRET_LEAK");
  }
  return writeEvidence({
    root,
    runId,
    filename: `credential-store-platform-${platform}.json`,
    result,
    payloads: [{ filename: "native-proof.json", content: sanitizedProof }],
  });
};

export const stageEvidenceDirectory = async (root, outputPath, stageOutput) => {
  const relativeStage = relative(root, stageOutput).split("\\").join("/");
  if (!relativeStage.startsWith("native-proof/") || relativeStage.includes("../")) {
    throw new Error("INVALID_STAGE_OUTPUT");
  }
  try {
    const metadata = await lstat(stageOutput);
    if (!metadata.isDirectory() || (await readdir(stageOutput)).length !== 0) {
      throw new Error("INVALID_STAGE_OUTPUT");
    }
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
    await mkdir(stageOutput, { recursive: true, mode: 0o700 });
  }
  for (const name of await readdir(dirname(outputPath))) {
    const source = resolve(dirname(outputPath), name);
    if (!(await lstat(source)).isFile()) throw new Error("INVALID_EVIDENCE_OUTPUT");
    await copyFile(source, resolve(stageOutput, name), fsConstants.COPYFILE_EXCL);
  }
};

export const parseCredentialStorePlatformProofArguments = (
  arguments_,
  rootDirectory = process.cwd(),
) => {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const options = { root: rootDirectory, credentialStorePaths: [], stageOutput: undefined };
  for (let index = 0; index < normalizedArguments.length; index += 1) {
    const argument = normalizedArguments[index];
    const value = normalizedArguments[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else if (argument === "--stage-output") options.stageOutput = value;
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  const root = resolve(options.root);
  return {
    ...options,
    root,
    stageOutput: options.stageOutput === undefined ? undefined : resolve(root, options.stageOutput),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCredentialStorePlatformProofArguments(process.argv.slice(2));
    const execution = await runCredentialStorePlatformProof(options);
    if (options.stageOutput !== undefined) {
      await stageEvidenceDirectory(options.root, execution.outputPath, options.stageOutput);
    }
    process.stdout.write(execution.serialized);
    process.exitCode =
      execution.result.runner_state === "PASS"
        ? 0
        : execution.result.runner_state === "BLOCKED_PREREQUISITE"
          ? 2
          : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "CREDENTIAL_STORE_PLATFORM_PROOF_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
