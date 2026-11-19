/* global Response, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout */
import { QA_FIXTURES, validateQaManifest } from "./config.mjs";
import { decodeValue, encodeValue } from "./wire.mjs";

const MAX_BODY = 2 * 1024 * 1024;
const MAX_BODY_CHUNKS = 1024;
const BODY_DEADLINE_MS = 15_000;
const OPERATION_DEADLINE_MS = 35_000;
const headers = { "cache-control": "no-store", "content-type": "application/json" };
const failure = (status) =>
  Response.json({ error: "qa_capability_unavailable" }, { status, headers });
const unknownOutcome = () =>
  Response.json(
    { error: "qa_database_outcome_unknown", outcome: "unknown", retryable: false },
    { status: 409, headers },
  );

function queryShape(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "text,values" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    new TextEncoder().encode(value.text).byteLength <= 65_536 &&
    Array.isArray(value.values) &&
    value.values.length <= 100
  );
}

async function bodyText(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  let stopped = false;
  let rejectRead;
  const interrupted = new Promise((_, reject) => {
    rejectRead = reject;
  });
  const stop = () => {
    stopped = true;
    rejectRead(new Error("invalid_body"));
  };
  const timer = setTimeout(stop, BODY_DEADLINE_MS);
  request.signal?.addEventListener("abort", stop, { once: true });
  if (request.signal?.aborted) stop();
  try {
    return await Promise.race([
      (async () => {
        const chunks = [];
        let size = 0;
        let count = 0;
        while (true) {
          if (stopped) throw new Error("invalid_body");
          const part = await reader.read();
          if (stopped) throw new Error("invalid_body");
          if (part.done) break;
          if (++count > MAX_BODY_CHUNKS) throw new Error("invalid_body");
          size += part.value.byteLength;
          if (size > MAX_BODY) throw new Error("invalid_body");
          if (part.value.byteLength) chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      })(),
      interrupted,
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", stop);
    // The untrusted stream's cancel hook may never settle. Cancellation and lock release
    // must not delay the rejection or leave the losing read loop consuming more chunks.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function admitted(env, scope, now) {
  const instant = now();
  if (!Number.isFinite(instant)) throw new Error("invalid_clock");
  // Scope is from a trusted DO-selected manifest, never from the container request.
  const authorized = await env.QA_DEV_ACCESS.authorizeDevAccessSession({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    handle: scope.handle,
    origin: scope.origin,
    principalId: scope.principalId,
    devAccessEpoch: scope.devAccessEpoch,
  });
  if (authorized !== true) return false;
  const credit = await env.QA_CREDIT.read({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    now: new Date(instant).toISOString(),
  });
  if (
    credit === null ||
    typeof credit !== "object" ||
    Array.isArray(credit) ||
    credit.organizationId !== scope.organizationId ||
    credit.projectId !== scope.projectId ||
    credit.environmentId !== scope.environmentId ||
    typeof credit.allowed !== "boolean" ||
    typeof credit.paidAllowed !== "boolean" ||
    typeof credit.checkedAt !== "string" ||
    typeof credit.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(credit.checkedAt)) ||
    !Number.isFinite(Date.parse(credit.expiresAt)) ||
    Date.parse(credit.checkedAt) > now() ||
    Date.parse(credit.expiresAt) <= now()
  )
    throw new Error("credit_invalid");
  return credit.allowed && credit.paidAllowed && credit.reason === null;
}

function operationDeadline(milliseconds) {
  const at = Date.now() + milliseconds;
  return async (work) => {
    const remaining = at - Date.now();
    if (remaining <= 0) throw new Error("qa_operation_timeout");
    let timer;
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("qa_operation_timeout")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Called by an outbound Worker whose immutable ctx.props.fixture comes from the sandbox DO.
 * This deliberately exposes only the two methods the seven fixtures use; it is not a product API.
 */
export async function handleDatabaseRequest(
  request,
  env,
  props,
  now = () => Date.now(),
  budgetMs = OPERATION_DEADLINE_MS,
) {
  const url = new URL(request.url);
  if (
    url.origin !== "http://preview.capabilities" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/database/query", "/database/transaction"].includes(url.pathname) ||
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    props === null ||
    typeof props !== "object" ||
    Array.isArray(props) ||
    Object.keys(props).join(",") !== "fixture" ||
    !QA_FIXTURES.includes(props.fixture)
  )
    return failure(404);
  let scope;
  let executor;
  try {
    if (typeof env.SPIKE_QA_MANIFEST !== "string" || env.SPIKE_QA_MANIFEST.length > 16_384)
      return failure(503);
    const manifest = validateQaManifest(JSON.parse(env.SPIKE_QA_MANIFEST));
    const index = QA_FIXTURES.indexOf(props.fixture);
    scope = manifest.projects[index];
    // The private executor validates the same trusted manifest and selects its registered
    // physical database inside the operation; static customer bindings are never used here.
    executor = env.QA_SCOPED_DATABASE;
    if (typeof executor?.execute !== "function" || !env.QA_DEV_ACCESS || !env.QA_CREDIT)
      return failure(503);
  } catch {
    return failure(503);
  }
  let input;
  try {
    input = decodeValue(await bodyText(request));
  } catch {
    return failure(400);
  }
  if (
    url.pathname === "/database/query"
      ? !queryShape(input)
      : !Array.isArray(input) || input.length < 1 || input.length > 25 || !input.every(queryShape)
  )
    return failure(400);
  let dispatched = false;
  const run = operationDeadline(budgetMs);
  try {
    if (!(await run(() => admitted(env, scope, now)))) return failure(403);
    if (request.signal?.aborted) return failure(400);
    dispatched = true;
    const result = await run(() =>
      executor.execute({
        platform: "development",
        scope,
        operation: url.pathname === "/database/query" ? "query" : "transaction",
        input,
      }),
    );
    // No retry or rollback follows dispatch: even a lost RPC reply may follow a commit.
    // The executor must also fence live scope/authority inside its actual operation.
    if (!(await run(() => admitted(env, scope, now)))) return unknownOutcome();
    return new Response(encodeValue(result ?? null), { headers });
  } catch {
    return dispatched ? unknownOutcome() : failure(503);
  }
}
