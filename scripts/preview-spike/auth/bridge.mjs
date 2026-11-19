/* global Headers, Request, Response, TextEncoder, URL, setTimeout, clearTimeout */
import { encodeValue } from "../capabilities/wire.mjs";
import { validateQaManifest } from "../capabilities/config.mjs";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const PREVIEW_ID = /^[a-f0-9]{32}$/u;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u;
const scopeKeys = [
  "platform",
  "fixture",
  "organizationId",
  "projectId",
  "environmentId",
  "region",
  "handle",
  "devOrigin",
  "principalId",
  "devAccessEpoch",
  "previewId",
  "previewOrigin",
  "authGeneration",
].sort();
const authorityKeys = [
  "platform",
  "organizationId",
  "projectId",
  "environmentId",
  "region",
  "previewId",
  "previewOrigin",
  "authGeneration",
  "devAccessEpoch",
  "revocationEpoch",
  "configurationRevision",
  "enabled",
  "sourceCapable",
  "paidAllowed",
  "runtimeAllowed",
].sort();
const publicRoutes = Object.freeze({
  GET: new Set(["/api/auth/v1/get-session", "/api/auth/v1/verify-email"]),
  POST: new Set([
    "/api/auth/v1/sign-up/email",
    "/api/auth/v1/sign-in/email",
    "/api/auth/v1/sign-out",
  ]),
});
const responseHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const fail = (status = 503) =>
  Response.json({ error: "qa_auth_unavailable" }, { status, headers: responseHeaders });
const unknownOutcome = () =>
  Response.json(
    { error: "qa_auth_outcome_unknown", outcome: "unknown", retryable: false },
    { status: 409, headers: responseHeaders },
  );
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys.join(",");
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

/** Immutable trusted DO props; no project, generation or origin comes from guest input. */
export function readQaAuthScope(value) {
  if (
    !exact(value, scopeKeys) ||
    value.platform !== "development" ||
    value.fixture !== "next-native-auth" ||
    value.region !== "eu" ||
    ![value.organizationId, value.projectId, value.environmentId].every(
      (x) => typeof x === "string" && ULID.test(x),
    ) ||
    typeof value.handle !== "string" ||
    value.handle.length > 59 ||
    !HANDLE.test(value.handle) ||
    value.devOrigin !== `https://dev-${value.handle}.dev.check.omh.st` ||
    typeof value.principalId !== "string" ||
    value.principalId.length < 1 ||
    value.principalId.length > 256 ||
    value.principalId !== value.principalId.trim() ||
    [...value.principalId].some(
      (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
    ) ||
    !positive(value.devAccessEpoch) ||
    typeof value.previewId !== "string" ||
    !PREVIEW_ID.test(value.previewId) ||
    typeof value.previewOrigin !== "string" ||
    !new RegExp(`^https://${value.previewId}-[a-f0-9]{24}\\.preview\\.dev\\.omh\\.st$`, "u").test(
      value.previewOrigin,
    ) ||
    !positive(value.authGeneration)
  )
    throw new Error("qa_auth_scope_invalid");
  return Object.freeze(Object.fromEntries(scopeKeys.map((key) => [key, value[key]])));
}

async function admission(env, scope, now) {
  const instant = now();
  if (
    !Number.isFinite(instant) ||
    typeof env.SPIKE_QA_MANIFEST !== "string" ||
    env.SPIKE_QA_MANIFEST.length > 16_384
  )
    throw new Error("qa_auth_unavailable");
  const manifest = validateQaManifest(JSON.parse(env.SPIKE_QA_MANIFEST));
  const qa = manifest.projects.find((item) => item.fixture === "next-native-auth");
  if (
    !qa ||
    qa.organizationId !== scope.organizationId ||
    qa.projectId !== scope.projectId ||
    qa.environmentId !== scope.environmentId ||
    qa.region !== scope.region ||
    qa.handle !== scope.handle ||
    qa.origin !== scope.devOrigin ||
    qa.principalId !== scope.principalId ||
    qa.devAccessEpoch !== scope.devAccessEpoch
  )
    throw new Error("qa_auth_unavailable");
  // This private authority does not exist on main yet. It must resolve a current, independently
  // managed preview Auth generation; an old commit-scoped authority is not a substitute.
  if (typeof env.QA_STABLE_PREVIEW_AUTHORITY?.resolve !== "function")
    throw new Error("qa_auth_unavailable");
  const identity = { previewId: scope.previewId, authGeneration: scope.authGeneration };
  const authority = await env.QA_STABLE_PREVIEW_AUTHORITY.resolve(identity);
  if (
    !exact(authority, authorityKeys) ||
    authority.platform !== "development" ||
    authority.organizationId !== scope.organizationId ||
    authority.projectId !== scope.projectId ||
    authority.environmentId !== scope.environmentId ||
    authority.region !== scope.region ||
    authority.previewId !== scope.previewId ||
    authority.previewOrigin !== scope.previewOrigin ||
    authority.authGeneration !== scope.authGeneration ||
    authority.devAccessEpoch !== scope.devAccessEpoch ||
    !positive(authority.revocationEpoch) ||
    !positive(authority.configurationRevision) ||
    authority.enabled !== true ||
    authority.sourceCapable !== true ||
    authority.paidAllowed !== true ||
    authority.runtimeAllowed !== true
  )
    throw new Error("qa_auth_unavailable");
  const authorized = await env.QA_DEV_ACCESS.authorizeDevAccessSession({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    handle: scope.handle,
    origin: scope.devOrigin,
    principalId: scope.principalId,
    devAccessEpoch: scope.devAccessEpoch,
  });
  if (authorized !== true) throw new Error("qa_auth_unavailable");
  const credit = await env.QA_CREDIT.read({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    now: new Date(instant).toISOString(),
  });
  const checked = Date.parse(credit?.checkedAt ?? ""),
    expires = Date.parse(credit?.expiresAt ?? "");
  if (
    !credit ||
    typeof credit !== "object" ||
    Array.isArray(credit) ||
    credit.organizationId !== scope.organizationId ||
    credit.projectId !== scope.projectId ||
    credit.environmentId !== scope.environmentId ||
    credit.allowed !== true ||
    credit.paidAllowed !== true ||
    credit.reason !== null ||
    !Number.isFinite(checked) ||
    !Number.isFinite(expires) ||
    checked > now() ||
    expires <= now()
  )
    throw new Error("qa_auth_unavailable");
  return {
    revocationEpoch: authority.revocationEpoch,
    configurationRevision: authority.configurationRevision,
  };
}

function sameAuthority(before, after) {
  return (
    before.revocationEpoch === after.revocationEpoch &&
    before.configurationRevision === after.configurationRevision
  );
}

async function readBoundedBody(request, limit) {
  if (request.signal?.aborted) throw new Error("qa_auth_aborted");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      (async () => {
        const chunks = [];
        let size = 0;
        let chunkCount = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (++chunkCount > 1024) throw new Error("qa_auth_body_invalid");
          size += part.value.byteLength;
          if (size > limit) throw new Error("qa_auth_body_invalid");
          if (part.value.byteLength) chunks.push(part.value);
        }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("qa_auth_body_deadline")), 15_000);
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error("qa_auth_aborted"));
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) request.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function sanitizePublicRequest(request) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      /^(?:x-ohmyhost-|x-forwarded-|cf-|forwarded$|host$|x-real-ip$|authorization$|content-length$)/iu.test(
        name,
      )
    )
      headers.delete(name);
  }
  const body = await readBoundedBody(request, 65_536);
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    ...(body.length ? { body } : {}),
  });
}

function safePublicResponse(response, scope, body) {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location !== null && new URL(location, scope.previewOrigin).origin !== scope.previewOrigin)
    throw new Error("qa_auth_unavailable");
  if (headers.has("set-cookie")) {
    const cookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : typeof headers.getAll === "function"
          ? headers.getAll("set-cookie")
          : null;
    if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > 8)
      throw new Error("qa_auth_unavailable");
    const prefix = `__Host-omh_native_preview_${scope.previewId}.`;
    for (const cookie of cookies) {
      if (
        [...cookie].some((character) => {
          const code = character.codePointAt(0);
          return (code < 32 && code !== 9) || code > 126;
        })
      )
        throw new Error("qa_auth_unavailable");
      const parts = cookie.split(";").map((part) => part.trim());
      const equals = parts[0].indexOf("=");
      const name = parts[0].slice(0, equals);
      const attributes = parts.slice(1).map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part.trim().toLowerCase(), null]
          : [
              part.slice(0, separator).trim().toLowerCase(),
              part
                .slice(separator + 1)
                .trim()
                .toLowerCase(),
            ];
      });
      const names = attributes.map(([attribute]) => attribute);
      const attribute = (wanted) => attributes.find(([key]) => key === wanted)?.[1];
      if (
        equals < 1 ||
        !name.startsWith(prefix) ||
        !/^[A-Za-z0-9_.-]+$/u.test(name) ||
        names.some((item) => !/^[a-z0-9-]+$/u.test(item)) ||
        new Set(names).size !== names.length ||
        !names.includes("secure") ||
        attribute("secure") !== null ||
        attribute("path") !== "/" ||
        names.includes("domain") ||
        (name.endsWith(".session_token") &&
          (!names.includes("httponly") ||
            attribute("httponly") !== null ||
            !["lax", "strict"].includes(attribute("samesite"))))
      )
        throw new Error("qa_auth_unavailable");
    }
  }
  for (const [name, value] of Object.entries(responseHeaders)) headers.set(name, value);
  headers.delete("content-length");
  return new Response(body.length ? body : null, { status: response.status, headers });
}

function safeSession(value, now) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    !value.user ||
    !value.session ||
    typeof value.user.id !== "string" ||
    value.user.id.length < 1 ||
    value.user.id.length > 256 ||
    typeof value.user.email !== "string" ||
    value.user.email.length < 1 ||
    value.user.email.length > 320 ||
    typeof value.session.id !== "string" ||
    value.session.id.length < 1 ||
    value.session.id.length > 256 ||
    typeof value.session.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.session.expiresAt)) ||
    Date.parse(value.session.expiresAt) <= now()
  )
    throw new Error("qa_auth_unavailable");
  return {
    user: { id: value.user.id, email: value.user.email },
    session: { id: value.session.id, expiresAt: value.session.expiresAt },
  };
}

/** Browser route: invoke only from trusted preview ingress, before forwarding to the guest. */
export async function handleQaAuthPublic(
  request,
  env,
  trustedScope,
  client,
  now = () => Date.now(),
) {
  let scope;
  try {
    scope = readQaAuthScope(trustedScope);
  } catch {
    return fail();
  }
  const url = new URL(request.url);
  if (
    url.origin !== scope.previewOrigin ||
    !publicRoutes[request.method]?.has(url.pathname) ||
    (request.method === "POST" && request.headers.get("origin") !== scope.previewOrigin) ||
    (request.headers.has("origin") && request.headers.get("origin") !== scope.previewOrigin) ||
    !client ||
    typeof client.clientAddress !== "string" ||
    !/^[a-f0-9:.]{2,64}$/iu.test(client.clientAddress)
  )
    return fail(404);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d{1,8}$/u.test(length) || Number(length) > 65_536)) return fail(413);
  let dispatched = false;
  try {
    const before = await admission(env, scope, now);
    if (typeof env.QA_NATIVE_STABLE_PREVIEW?.fetchStablePreview !== "function") return fail();
    const sanitized = await sanitizePublicRequest(request);
    if (request.signal.aborted) throw new Error("qa_auth_aborted");
    dispatched = true;
    const response = await env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview(
      sanitized,
      { previewId: scope.previewId, authGeneration: scope.authGeneration },
      { clientAddress: client.clientAddress },
    );
    if (!(response instanceof Response) || response.status >= 500) return unknownOutcome();
    // Read the bounded response before the second authority check: no later stream can
    // deliver additional bytes after the check has completed.
    const body = await readBoundedBody(response, 65_536);
    const after = await admission(env, scope, now);
    if (request.signal.aborted || !sameAuthority(before, after)) return unknownOutcome();
    return safePublicResponse(response, scope, body);
  } catch {
    // A post-check, response validation failure or lost reply cannot undo an Auth mutation.
    return dispatched ? unknownOutcome() : fail();
  }
}

/** Guest outbound session validation. The URL selects a method, never a realm or preview. */
export async function handleQaAuthSession(request, env, trustedScope, now = () => Date.now()) {
  let scope;
  try {
    scope = readQaAuthScope(trustedScope);
  } catch {
    return fail();
  }
  const url = new URL(request.url);
  const cookie = request.headers.get("cookie") ?? "";
  if (
    url.origin !== "http://preview.capabilities" ||
    url.pathname !== "/native-auth/session" ||
    url.search ||
    url.hash ||
    request.method !== "POST" ||
    cookie.length > 16_384 ||
    new TextEncoder().encode(cookie).byteLength > 16_384
  )
    return fail(404);
  try {
    await readBoundedBody(request, 0);
  } catch {
    return fail(404);
  }
  let dispatched = false;
  try {
    const before = await admission(env, scope, now);
    if (typeof env.QA_NATIVE_STABLE_PREVIEW?.validateStablePreviewSession !== "function")
      return fail();
    if (request.signal.aborted) throw new Error("qa_auth_aborted");
    dispatched = true;
    const session = safeSession(
      await env.QA_NATIVE_STABLE_PREVIEW.validateStablePreviewSession(
        { previewId: scope.previewId, authGeneration: scope.authGeneration },
        cookie,
      ),
      now,
    );
    const after = await admission(env, scope, now);
    if (request.signal.aborted || !sameAuthority(before, after)) return unknownOutcome();
    return new Response(encodeValue(session), {
      headers: { ...responseHeaders, "content-type": "application/json" },
    });
  } catch {
    return dispatched ? unknownOutcome() : fail();
  }
}
