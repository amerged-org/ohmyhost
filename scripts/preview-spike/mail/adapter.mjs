/* global AbortController, Headers, Request, Response, TextDecoder, TextEncoder, URL, crypto, setTimeout, clearTimeout */

// Deliberately public markers; neither value authorizes a send at the private boundary.
export const GUEST_ACCEPTANCE = "qa-mail-fixture-marker-not-a-secret";
export const GUEST_MAIL_KEY = "Q".repeat(43);
const SESSION = /^[a-f0-9]{32}$/u;
const MESSAGE = /^[A-Za-z0-9-]{1,80}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u;
const COMMON = { "cache-control": "no-store", "content-type": "application/json" };
const fail = (status) =>
  Response.json({ code: "mail_gateway_unavailable" }, { status, headers: COMMON });
const unknown = () =>
  Response.json({ code: "qa_mail_outcome_unknown" }, { status: 409, headers: COMMON });

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function parseScope(raw) {
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("qa_scope_unavailable");
  const value = JSON.parse(raw);
  if (
    !exact(value, [
      "platform",
      "fixture",
      "organizationId",
      "projectId",
      "environmentId",
      "handle",
      "origin",
      "principalId",
      "devAccessEpoch",
      "recipient",
    ]) ||
    value.platform !== "development" ||
    value.fixture !== "next-app-mail" ||
    ![value.organizationId, value.projectId, value.environmentId].every(
      (item) => typeof item === "string" && ULID.test(item),
    ) ||
    typeof value.handle !== "string" ||
    value.handle.length > 59 ||
    !HANDLE.test(value.handle) ||
    value.origin !== `https://dev-${value.handle}.dev.check.omh.st` ||
    typeof value.principalId !== "string" ||
    value.principalId.length < 1 ||
    value.principalId.length > 256 ||
    value.principalId !== value.principalId.trim() ||
    [...value.principalId].some(
      (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
    ) ||
    !Number.isSafeInteger(value.devAccessEpoch) ||
    value.devAccessEpoch < 1 ||
    value.devAccessEpoch > 2_147_483_647 ||
    typeof value.recipient !== "string" ||
    value.recipient.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/u.test(value.recipient)
  )
    throw new Error("qa_scope_unavailable");
  return value;
}

async function bounded(work, timeout = 5_000) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("qa_timeout")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function bytesOf(message, maximum = 2048) {
  const reader = message.body?.getReader();
  if (!reader) throw new Error("qa_body_invalid");
  const chunks = [];
  let size = 0;
  let count = 0;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("qa_body_timeout")), 5_000);
  });
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error("qa_aborted"));
    if (message.signal?.aborted) onAbort();
    else message.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout, aborted]);
      if (part.done) break;
      if (++count > 1024) throw new Error("qa_body_invalid");
      size += part.value.byteLength;
      if (size > maximum) throw new Error("qa_body_invalid");
      if (part.value.byteLength > 0) chunks.push(part.value);
    }
  } finally {
    clearTimeout(timer);
    message.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* A pending canceled read may retain the lock briefly. */
    }
  }
  const result = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.byteLength;
  }
  return result;
}

function json(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function digest(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readMailKey(env) {
  // The fixed-scope custody service returns only this key, and is never exposed to the guest.
  // Read on each operation so revocation, key changes and custody failures take effect.
  return bounded(() => env.QA_MAIL_KEY_CUSTODY.read());
}
function validSecrets(env, mailKey) {
  return (
    typeof mailKey === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(mailKey) &&
    mailKey !== GUEST_MAIL_KEY &&
    typeof env.QA_MAIL_OPERATOR_TOKEN === "string" &&
    env.QA_MAIL_OPERATOR_TOKEN.length >= 32 &&
    env.QA_MAIL_OPERATOR_TOKEN.length <= 1024 &&
    env.QA_MAIL_OPERATOR_TOKEN !== GUEST_ACCEPTANCE &&
    env.QA_MAIL_OPERATOR_TOKEN !== GUEST_MAIL_KEY &&
    env.QA_MAIL_OPERATOR_TOKEN !== mailKey
  );
}
async function permitFingerprint(env, scope, mailKey) {
  if (!validSecrets(env, mailKey)) throw new Error("qa_scope_unavailable");
  const [keyHash, operatorHash] = await Promise.all([
    digest(mailKey),
    digest(env.QA_MAIL_OPERATOR_TOKEN),
  ]);
  return digest(JSON.stringify([scope, keyHash, operatorHash]));
}
async function operatorAuthorized(header, secret) {
  if (
    typeof header !== "string" ||
    !header.startsWith("Bearer ") ||
    header.length > 1031 ||
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 1024
  )
    return false;
  const [left, right] = await Promise.all([digest(header.slice(7)), digest(secret)]);
  let delta = 0;
  for (let i = 0; i < left.length; i++) delta |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return delta === 0;
}

// The spike supplies only this read-only entrypoint, never its namespace or lifecycle authority.
async function readMailSession(env, sessionId, clock) {
  if (typeof sessionId !== "string" || !SESSION.test(sessionId)) return null;
  const state = await bounded(() => env.QA_SPIKE_MAIL_AUTHORITY.readMailSession({ sessionId }));
  const current = clock();
  return exact(state, ["sessionId", "generation", "expiresAt"]) &&
    state.sessionId === sessionId &&
    Number.isSafeInteger(state.generation) &&
    state.generation > 0 &&
    Number.isSafeInteger(state.expiresAt) &&
    Number.isFinite(current) &&
    state.expiresAt > current
    ? state
    : null;
}

async function active(env, sessionId, generation, clock) {
  if (!Number.isSafeInteger(generation) || generation < 1) return false;
  return (await readMailSession(env, sessionId, clock))?.generation === generation;
}

async function authorizedScope(env, scope, clock, mailKey) {
  if (!validSecrets(env, mailKey)) return false;
  const current = clock();
  if (!Number.isFinite(current)) return false;
  const access = await bounded(() =>
    env.QA_DEV_ACCESS.authorizeDevAccessSession({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      handle: scope.handle,
      origin: scope.origin,
      principalId: scope.principalId,
      devAccessEpoch: scope.devAccessEpoch,
    }),
  );
  if (access !== true) return false;
  const credit = await bounded(() =>
    env.QA_CREDIT.read({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      now: new Date(current).toISOString(),
    }),
  );
  if (
    credit?.organizationId !== scope.organizationId ||
    credit?.projectId !== scope.projectId ||
    credit?.environmentId !== scope.environmentId ||
    credit.allowed !== true ||
    credit.paidAllowed !== true ||
    credit.reason !== null ||
    typeof credit.checkedAt !== "string" ||
    typeof credit.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(credit.checkedAt)) ||
    !Number.isFinite(Date.parse(credit.expiresAt)) ||
    Date.parse(credit.checkedAt) > clock() ||
    Date.parse(credit.expiresAt) <= clock()
  )
    return false;
  const keySha256 = await digest(mailKey);
  const mail = await bounded(() =>
    env.QA_MAIL_AUTHORITY.authorizeKey({ projectId: scope.projectId, keySha256 }),
  );
  return (
    mail?.organizationId === scope.organizationId &&
    mail?.projectId === scope.projectId &&
    mail?.environmentId === scope.environmentId &&
    typeof mail.domain === "string" &&
    mail.domain.length > 0
  );
}

/** Only non-secret fixture markers and the authorized QA scope leave this private service. */
export async function guestMailConfiguration(env, clock = () => Date.now()) {
  try {
    const scope = parseScope(env.QA_MAIL_SCOPE);
    const mailKey = await readMailKey(env);
    if (!(await authorizedScope(env, scope, clock, mailKey))) return null;
    return {
      OHMYHOST_MAIL_GATEWAY_URL: "https://qa-mail.invalid",
      OHMYHOST_MAIL_KEY: GUEST_MAIL_KEY,
      OHMYHOST_PROJECT_ID: scope.projectId,
      PREVIEW_ACCEPTANCE_KEY: GUEST_ACCEPTANCE,
      PREVIEW_MAIL_RECIPIENT: scope.recipient,
    };
  } catch {
    return null;
  }
}

/** Called only on the private service by the authenticated control-domain route. */
export async function armMailPermit(request, env, sessionId, clock = () => Date.now()) {
  try {
    const url = new URL(request.url);
    if (
      !SESSION.test(sessionId) ||
      url.origin !== "https://control.preview.dev.omh.st" ||
      url.pathname !== `/__spike/sessions/${sessionId}/mail-permit` ||
      url.search ||
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
      !(await operatorAuthorized(request.headers.get("authorization"), env.QA_MAIL_OPERATOR_TOKEN))
    )
      return fail(403);
    const input = json(await bytesOf(request));
    if (!exact(input, ["id"]) || typeof input.id !== "string" || !MESSAGE.test(input.id))
      return fail(400);
    const scope = parseScope(env.QA_MAIL_SCOPE);
    const state = await readMailSession(env, sessionId, clock);
    if (!state) return fail(403);
    const mailKey = await readMailKey(env);
    if (!(await authorizedScope(env, scope, clock, mailKey))) return fail(403);
    const scopeHash = await permitFingerprint(env, scope, mailKey);
    const ok = await bounded(() =>
      env.QA_MAIL_PERMITS.getByName(sessionId).arm({
        sessionId,
        generation: state.generation,
        id: input.id,
        scopeHash,
      }),
    );
    return ok === true
      ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
      : fail(409);
  } catch {
    return fail(503);
  }
}

/** Private-service check: binds the current secret and complete recipient scope to the permit. */
export async function peekMailPermit(input, env) {
  try {
    if (
      !exact(input, ["sessionId", "generation", "id"]) ||
      typeof input.sessionId !== "string" ||
      !SESSION.test(input.sessionId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      typeof input.id !== "string" ||
      !MESSAGE.test(input.id)
    )
      return false;
    const scope = parseScope(env.QA_MAIL_SCOPE);
    const mailKey = await readMailKey(env);
    const scopeHash = await permitFingerprint(env, scope, mailKey);
    return (
      (await bounded(() =>
        env.QA_MAIL_PERMITS.getByName(input.sessionId).peek({ ...input, scopeHash }),
      )) === true
    );
  } catch {
    return false;
  }
}

/** The caller is the trusted spike control route; no key, hash or recipient is returned. */
export async function readMailPermitStatus(input, env) {
  if (
    !exact(input, ["sessionId"]) ||
    typeof input.sessionId !== "string" ||
    !SESSION.test(input.sessionId)
  )
    throw new Error("qa_mail_status_unavailable");
  try {
    const value = await bounded(() => env.QA_MAIL_PERMITS.getByName(input.sessionId).status());
    if (value === null) return null;
    if (
      !exact(value, ["id", "generation", "state", "attempts", "expiresAt"]) ||
      typeof value.id !== "string" ||
      !MESSAGE.test(value.id) ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      !["ready", "in_flight", "accepted", "unknown", "exhausted", "expired"].includes(
        value.state,
      ) ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts < 0 ||
      value.attempts > 2 ||
      !Number.isSafeInteger(value.expiresAt)
    )
      throw new Error("qa_mail_status_unavailable");
    return value;
  } catch {
    throw new Error("qa_mail_status_unavailable");
  }
}

/** Invoked by the trusted spike lifecycle for this exact retired session generation. */
export async function cleanupMailPermit(input, env) {
  if (
    !exact(input, ["sessionId", "generation"]) ||
    typeof input.sessionId !== "string" ||
    !SESSION.test(input.sessionId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0
  )
    throw new Error("qa_mail_cleanup_unavailable");
  try {
    const deleted = await bounded(() =>
      env.QA_MAIL_PERMITS.getByName(input.sessionId).cleanup(input),
    );
    if (deleted !== true && deleted !== false) throw new Error("qa_mail_cleanup_unavailable");
    return { deleted };
  } catch {
    throw new Error("qa_mail_cleanup_unavailable");
  }
}

/** Called for every QA preview request after the router has verified the signed session hostname. */
export async function gateMailIngress(request, env, sessionId, clock = () => Date.now()) {
  try {
    const url = new URL(request.url);
    const safeNextChunk =
      (request.method === "GET" || request.method === "HEAD") &&
      /^\/_next\/static\/chunks\/(?:[A-Za-z0-9._~-]|%40|%5[bBdD])+\.js$/u.test(url.pathname);
    if (
      !SESSION.test(sessionId) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.pathname.includes("%") && !safeNextChunk) ||
      (url.pathname.startsWith("/api/") && !["/api/mail", "/api/notes"].includes(url.pathname)) ||
      !["GET", "HEAD", "POST", "DELETE"].includes(request.method) ||
      (["POST", "DELETE"].includes(request.method) &&
        !["/api/mail", "/api/notes"].includes(url.pathname))
    )
      return { response: fail(404) };
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (url.pathname !== "/api/mail") return { request: new Request(request, { headers }) };
    if (
      request.method !== "POST" ||
      url.search ||
      request.headers.get("origin") !== url.origin ||
      request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
    )
      return { response: fail(403) };
    const body = await bytesOf(request);
    const input = json(body);
    if (!exact(input, ["id"]) || typeof input.id !== "string" || !MESSAGE.test(input.id))
      return { response: fail(400) };
    const state = await readMailSession(env, sessionId, clock);
    if (
      !state ||
      (await bounded(() =>
        env.QA_MAIL_PRIVATE.peek({ sessionId, generation: state.generation, id: input.id }),
      )) !== true
    )
      return { response: fail(403) };
    headers.set("authorization", `Bearer ${GUEST_ACCEPTANCE}`);
    headers.delete("content-length");
    return {
      request: new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: request.signal,
        redirect: "manual",
      }),
    };
  } catch {
    return { response: fail(503) };
  }
}

/** Called only by the private service; props originate in the sandbox DO's registered intercept. */
export async function handleMailOutbound(request, env, props, clock = () => Date.now()) {
  try {
    const url = new URL(request.url);
    if (
      !exact(props, ["sessionId", "generation"]) ||
      !SESSION.test(props.sessionId) ||
      !Number.isSafeInteger(props.generation) ||
      props.generation < 1 ||
      url.origin !== "https://qa-mail.invalid" ||
      url.username ||
      url.password ||
      url.pathname !== "/v1/send" ||
      url.search ||
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
      request.headers.get("authorization") !== `Bearer ${GUEST_MAIL_KEY}`
    )
      return fail(403);
    const messageId = request.headers.get("idempotency-key");
    if (typeof messageId !== "string" || !MESSAGE.test(messageId)) return fail(403);
    const scope = parseScope(env.QA_MAIL_SCOPE);
    const body = json(await bytesOf(request));
    if (
      !exact(body, ["project_id", "to", "subject", "text"]) ||
      body.project_id !== scope.projectId ||
      body.to !== scope.recipient ||
      body.subject !== `Preview acceptance ${messageId}` ||
      body.text !== `Preview acceptance ${messageId}`
    )
      return fail(403);
    if (!(await active(env, props.sessionId, props.generation, clock))) return fail(403);
    const mailKey = await readMailKey(env);
    if (!(await authorizedScope(env, scope, clock, mailKey))) return fail(403);
    if (request.signal.aborted) return fail(503);
    const scopeHash = await permitFingerprint(env, scope, mailKey);
    const input = {
      sessionId: props.sessionId,
      generation: props.generation,
      id: messageId,
      scopeHash,
    };
    if (
      (await bounded(() => env.QA_MAIL_PERMITS.getByName(props.sessionId).consume(input))) !== true
    )
      return fail(403);
    let current;
    let currentMailKey;
    try {
      currentMailKey = await readMailKey(env);
      current =
        (await permitFingerprint(env, scope, currentMailKey)) === scopeHash &&
        (await active(env, props.sessionId, props.generation, clock)) &&
        (await authorizedScope(env, scope, clock, currentMailKey));
    } catch {
      await bounded(() =>
        env.QA_MAIL_PERMITS.getByName(props.sessionId).complete(input, "not_sent"),
      );
      return fail(503);
    }
    if (!current || request.signal.aborted) {
      await bounded(() =>
        env.QA_MAIL_PERMITS.getByName(props.sessionId).complete(input, "not_sent"),
      );
      return fail(current ? 503 : 403);
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    let timer;
    let value;
    let dispatched = false;
    try {
      if (request.signal.aborted) throw new Error("qa_aborted");
      timer = setTimeout(() => abort.abort(), 8_000);
      const response = await bounded(() => {
        dispatched = true;
        return env.MAIL_GATEWAY.fetch(
          new Request("https://mail-gateway.internal/v1/send", {
            method: "POST",
            headers: {
              authorization: `Bearer ${currentMailKey}`,
              "content-type": "application/json",
              "idempotency-key": messageId,
              "x-ohmyhost-egress-project-id": scope.projectId,
            },
            body: JSON.stringify(body),
            signal: abort.signal,
            redirect: "manual",
          }),
        );
      }, 8_000);
      if (
        request.signal.aborted ||
        abort.signal.aborted ||
        response.status !== 202 ||
        response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
      )
        throw new Error("qa_outcome_unknown");
      value = json(await bytesOf(response, 32_768));
      if (
        !(
          (value?.state === "accepted" &&
            exact(value, ["state", "request_id", "message_id"]) &&
            typeof value.message_id === "string" &&
            /^[A-Za-z0-9._-]{1,256}$/u.test(value.message_id) &&
            typeof value.request_id === "string" &&
            ULID.test(value.request_id)) ||
          (value?.state === "uncertain" &&
            exact(value, ["state", "request_id"]) &&
            typeof value.request_id === "string" &&
            ULID.test(value.request_id))
        )
      )
        throw new Error("qa_outcome_unknown");
      if (request.signal.aborted || abort.signal.aborted) throw new Error("qa_outcome_unknown");
      const completed = await bounded(() =>
        env.QA_MAIL_PERMITS.getByName(props.sessionId).complete(
          input,
          value.state === "accepted" ? "accepted" : "unknown",
        ),
      );
      if (completed !== true) throw new Error("qa_outcome_unknown");
      return Response.json(value, { status: 202, headers: COMMON });
    } catch {
      try {
        await bounded(() =>
          env.QA_MAIL_PERMITS.getByName(props.sessionId).complete(
            input,
            dispatched ? "unknown" : "not_sent",
          ),
        );
      } catch {
        // An unacknowledged completion leaves the in-flight permit locked.
      }
      return dispatched ? unknown() : fail(503);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  } catch {
    return fail(503);
  }
}
