/* global AbortSignal */
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";

/**
 * Worker absence is a typed, sanitized fact, never an inference from a failed command. This module
 * imports neither the pipeline nor the platform release, so both can consume it without a cycle.
 */
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const WORKER_NAME =
  /^(?:(?:ohmyho|ohmyhost)-[a-z0-9-]+-(?:poc-private-fullstack|production)|ohmyho-(?:project-database|native-auth)-(?:development|production)-(?:us|eu)|ohmyho-connection-broker-development)$/u;
const MISSING_WORKER = "This Worker does not exist on your account. [code: 10007]";
const MISSING_CODE = 10007;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
// Any other failure family on the same stream makes the diagnostic mixed, so it is not absence.
const FOREIGN_FAILURE =
  /authenticat|authoriz|forbidden|permission|api token|log ?in|timed? ?out|econn|enotfound|etimedout|eai_again|network|fetch failed|rate limit|too many requests/iu;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export class WorkerAbsentError extends Error {
  constructor({ accountId, workerName }) {
    super("Worker is confirmed absent from the account");
    this.name = "WorkerAbsentError";
    this.accountId = accountId;
    this.workerName = workerName;
  }
}

export class WorkerPresenceUnavailableError extends Error {
  constructor() {
    super("Worker presence cannot be confirmed");
    this.name = "WorkerPresenceUnavailableError";
  }
}

/** The one canonical versions-list observation, rendered with the exact Worker and config. */
export const workerVersionsArguments = ({ workerName, configPath }) => [
  "versions",
  "list",
  "--json",
  "--name",
  workerName,
  "--config",
  configPath,
];

const validScope = (context) =>
  context !== null &&
  typeof context === "object" &&
  WORKER_NAME.test(context.workerName ?? "") &&
  (context.accountId === undefined ||
    context.accountId === null ||
    ACCOUNT_ID.test(context.accountId));

/**
 * Examines a failed subprocess BEFORE its stderr is erased. Only the exact scoped versions-list
 * command, a numeric non-zero exit, and one unmixed provider missing-Worker diagnostic qualify.
 * It returns a fixed WorkerAbsentError (no cause, stdout or stderr) or null for anything else.
 */
export function classifyWorkerAbsence({ command, args, context, error }) {
  try {
    if (typeof command !== "string" || command.length === 0 || !validScope(context)) return null;
    const { workerName } = context;
    if (
      !Array.isArray(args) ||
      args.length !== 7 ||
      !isDeepStrictEqual(args.slice(0, 5), ["versions", "list", "--json", "--name", workerName]) ||
      args[5] !== "--config" ||
      typeof args[6] !== "string" ||
      args[6].length === 0
    )
      return null;
    if (
      error === null ||
      typeof error !== "object" ||
      typeof error.stderr !== "string" ||
      error.stderr.length > MAX_DIAGNOSTIC_BYTES ||
      error.killed === true ||
      (error.signal !== undefined && error.signal !== null) ||
      (error.code !== undefined && !(Number.isInteger(error.code) && error.code > 0))
    )
      return null;
    // A real creation observation has a checked account and must report that exact API request.
    // The legacy ordinary-release direct runner may supply only the standalone diagnostic without
    // an account; it does not confer creation authority on the closed profile.
    if (ACCOUNT_ID.test(context.accountId ?? "")) {
      const expected = `/accounts/${context.accountId}/workers/scripts/${workerName}/versions`;
      const paths = [...error.stderr.matchAll(/\/accounts\/[^\s)]+/gu)].map(([path]) => path);
      if (
        !Number.isInteger(error.code) ||
        error.code <= 0 ||
        paths.length !== 1 ||
        ![expected, `${expected}?deployable=true`].includes(paths[0])
      )
        return null;
    }
    const lines = error.stderr.split(/\r?\n/u);
    const codes = [...error.stderr.matchAll(/\[code: (\d+)\]/gu)].map((match) => Number(match[1]));
    if (
      lines.filter((line) => line.includes(MISSING_WORKER)).length !== 1 ||
      codes.length !== 1 ||
      codes[0] !== MISSING_CODE ||
      (error.stderr.match(/\[ERROR\]/gu) ?? []).length > 1 ||
      lines.some((line) => !line.includes(MISSING_WORKER) && FOREIGN_FAILURE.test(line))
    )
      return null;
    return new WorkerAbsentError({ accountId: context.accountId ?? null, workerName });
  } catch {
    return null;
  }
}

export const isWorkerAbsentError = (error, context) =>
  error instanceof WorkerAbsentError &&
  context !== null &&
  typeof context === "object" &&
  error.workerName === context.workerName &&
  error.accountId === (context.accountId ?? null);

/** Present or absent from the canonical versions-list command; everything else is an error. */
export async function observeWorkerCommand({ run, wrangler, accountId, workerName, configPath }) {
  if (!ACCOUNT_ID.test(accountId ?? "") || !WORKER_NAME.test(workerName ?? ""))
    throw new WorkerPresenceUnavailableError();
  const context = { accountId, workerName };
  const args = workerVersionsArguments({ workerName, configPath });
  let output;
  try {
    output = await run(wrangler, args, { cwd: tmpdir(), observeWorker: context });
  } catch (error) {
    // The train adapter throws the typed error; a direct runner leaves the raw diagnostic.
    if (
      isWorkerAbsentError(error, context) ||
      classifyWorkerAbsence({ command: wrangler, args, context, error }) !== null
    )
      return Object.freeze({ kind: "absent", accountId, workerName });
    throw new WorkerPresenceUnavailableError();
  }
  let versions;
  try {
    versions = JSON.parse(output);
  } catch {
    throw new WorkerPresenceUnavailableError();
  }
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    versions.some(
      (version) => version === null || typeof version !== "object" || Array.isArray(version),
    )
  )
    throw new WorkerPresenceUnavailableError();
  return Object.freeze({ kind: "present", accountId, workerName, versions });
}

/** Wrangler's own login token; failures are fixed sentences because the output can hold it. */
export async function readBearerToken({ run, wrangler, label }) {
  let credential;
  try {
    credential = JSON.parse(await run(wrangler, ["auth", "token", "--json"]));
  } catch {
    throw new Error(`${label} credential is unavailable`);
  }
  if (
    !["api_token", "oauth"].includes(credential?.type) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  )
    throw new Error(`${label} credential is invalid`);
  return credential.token;
}

/**
 * Classifies a structured provider response before any generic failure erasure: only the
 * missing-Worker 404 with exactly that one error code is absence, only a non-empty listing is
 * presence, and authentication, other 404s, malformed bodies and empty lists are unavailable.
 */
export function classifyWorkerEndpointResponse({ status, value, accountId, workerName }) {
  if (
    status === 404 &&
    value?.success === false &&
    Array.isArray(value.errors) &&
    value.errors.length === 1 &&
    value.errors[0]?.code === MISSING_CODE
  )
    return Object.freeze({ kind: "absent", accountId, workerName });
  if (status >= 200 && status < 300 && value?.success === true) {
    const items = Array.isArray(value.result) ? value.result : value.result?.items;
    if (Array.isArray(items) && items.length > 0)
      return Object.freeze({ kind: "present", accountId, workerName });
  }
  throw new WorkerPresenceUnavailableError();
}

/** A GET-only observer of the exact scoped Workers versions endpoint; the token stays here. */
export function workerPresenceObserver({ token, fetch = globalThis.fetch }) {
  if (typeof token !== "string" || token.length === 0) throw new WorkerPresenceUnavailableError();
  return async ({ accountId, workerName }) => {
    if (!ACCOUNT_ID.test(accountId ?? "") || !WORKER_NAME.test(workerName ?? ""))
      throw new WorkerPresenceUnavailableError();
    let response;
    try {
      response = await fetch(
        `${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/versions`,
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new WorkerPresenceUnavailableError();
    }
    const value = await response.json().catch(() => null);
    return classifyWorkerEndpointResponse({
      status: response.status,
      value,
      accountId,
      workerName,
    });
  };
}

/** The same observer with Wrangler's own login, which is what a release train reads with. */
export async function createWorkerPresenceObserver({ run, wrangler, fetch = globalThis.fetch }) {
  let token;
  try {
    token = await readBearerToken({ run, wrangler, label: "Worker presence" });
  } catch {
    throw new WorkerPresenceUnavailableError();
  }
  return workerPresenceObserver({ token, fetch });
}
