/* global AbortController, AbortSignal, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout */
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";

const LABELS = new Set([
  "cf-account",
  "cf-zone",
  "cf-routes",
  "cf-deployments",
  "cf-version",
  "cf-container",
  "control-status",
  "control-lease",
]);
const NETWORK = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
export class ReadOnlyFailure extends Error {
  constructor(reason, status = null) {
    super("read_only_get_unverified");
    this.reason = reason;
    this.status = status;
  }
}
const network = (error) => NETWORK.has(error?.code) || NETWORK.has(error?.cause?.code);

async function abortable(operation, signal) {
  if (signal.aborted) throw new ReadOnlyFailure("aborted");
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(new ReadOnlyFailure("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([interrupted, operation()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** A diagnostic may finish later, but it cannot extend the operation or expose its error. */
export async function observeReadOnly(
  event,
  { observe, signal, deadlineAt, now = () => performance.now() },
) {
  const audit = Promise.resolve().then(() => observe(event));
  void audit.catch(() => {});
  const stopped = () =>
    signal?.aborted ? "caller-aborted" : now() >= deadlineAt ? "deadline" : null;
  const initial = stopped();
  if (initial) throw new ReadOnlyFailure(initial, event.status ?? null);
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(
    () => {
      expired = true;
      controller.abort();
    },
    Math.max(1, Math.ceil(deadlineAt - now())),
  );
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    await abortable(() => audit, combined);
  } catch {
    throw new ReadOnlyFailure(
      stopped() ?? (expired ? "deadline" : "observation-unverified"),
      event.status ?? null,
    );
  } finally {
    clearTimeout(timer);
  }
  const final = stopped();
  if (final) throw new ReadOnlyFailure(final, event.status ?? null);
}

async function json(response, maxBytes) {
  try {
    if (!response.body?.getReader) {
      const value = await response.json(); // Test/connector-compatible response; native fetch uses the bounded stream below.
      const encoded = JSON.stringify(value);
      if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxBytes)
        throw new Error();
      return value;
    }
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new ReadOnlyFailure("malformed-json");
        parts.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ReadOnlyFailure) throw error;
    // Known network/abort errors retain their category for the outer retry decision, not their text.
    if (network(error) || error?.name === "AbortError" || error?.name === "TimeoutError")
      throw error;
    throw new ReadOnlyFailure("malformed-json");
  }
}

/** Idempotent reads only. A failed validation, authorization or mutation is never retried here. */
export async function readOnlyJson(
  url,
  {
    label,
    fetcher = globalThis.fetch,
    headers,
    method = "GET",
    body,
    signal,
    deadlineAt,
    now = () => performance.now(),
    pause = wait,
    observe = () => {},
    attemptTimeoutMs = 15000,
    backoffMs = 250,
    maxAttempts = 3,
    maxBytes = 1048576,
  } = {},
) {
  const started = now();
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new ReadOnlyFailure("unsafe-input");
  }
  deadlineAt ??= started + attemptTimeoutMs * maxAttempts + 2000;
  if (
    !LABELS.has(label) ||
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    method !== "GET" ||
    body !== undefined ||
    typeof fetcher !== "function" ||
    !Number.isFinite(deadlineAt) ||
    !Number.isSafeInteger(attemptTimeoutMs) ||
    attemptTimeoutMs < 1 ||
    attemptTimeoutMs > 15000 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 3 ||
    !Number.isSafeInteger(backoffMs) ||
    backoffMs < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new ReadOnlyFailure("unsafe-input");
  const emit = (attempt, outcome, reason, status, attemptStarted) =>
    observeReadOnly(
      {
        event: "readonly-request",
        label,
        attempt,
        outcome,
        reason,
        status,
        elapsedMs: Math.max(0, now() - attemptStarted),
        operationElapsedMs: Math.max(0, now() - started),
      },
      { observe, signal, deadlineAt, now },
    );
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStarted = now(),
      remaining = deadlineAt - attemptStarted;
    if (signal?.aborted || remaining <= 0) {
      const reason = signal?.aborted ? "caller-aborted" : "deadline";
      await emit(attempt - 1, "fatal", reason, null, attemptStarted);
      throw new ReadOnlyFailure(reason);
    }
    const controller = new AbortController();
    let timedOut = false,
      status = null,
      retryAfter = 0,
      reason,
      value;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(attemptTimeoutMs, remaining),
    );
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      value = await abortable(async () => {
        const response = await fetcher(url, {
          method: "GET",
          headers,
          redirect: "error",
          signal: combined,
        });
        const responseStatus = response.status;
        if (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599)
          throw new ReadOnlyFailure("malformed-response");
        status = responseStatus;
        if (status === 429 || status >= 500) {
          const retry = response.headers?.get?.("retry-after");
          if (typeof retry === "string" && /^[0-9]+(?:\.[0-9]+)?$/u.test(retry))
            retryAfter = Number(retry) * 1000;
          else if (typeof retry === "string" && Number.isFinite(Date.parse(retry)))
            retryAfter = Math.max(0, Date.parse(retry) - Date.now());
          void response.body?.cancel()?.catch(() => {});
          throw new ReadOnlyFailure("http-transient", status);
        }
        if (!response.ok) throw new ReadOnlyFailure("http-rejected", status);
        return json(response, maxBytes);
      }, combined);
    } catch (error) {
      reason = signal?.aborted
        ? "caller-aborted"
        : now() >= deadlineAt
          ? "deadline"
          : timedOut
            ? "attempt-timeout"
            : error instanceof ReadOnlyFailure
              ? error.reason
              : network(error)
                ? "network-transient"
                : "transport-unverified";
    } finally {
      clearTimeout(timer);
    }
    if (!reason) {
      if (signal?.aborted || now() >= deadlineAt) {
        const stopped = signal?.aborted ? "caller-aborted" : "deadline";
        await emit(attempt, "fatal", stopped, status, attemptStarted);
        throw new ReadOnlyFailure(stopped, status);
      }
      await emit(attempt, "ok", "confirmed", status, attemptStarted);
      if (signal?.aborted || now() >= deadlineAt) {
        const stopped = signal?.aborted ? "caller-aborted" : "deadline";
        await emit(attempt, "fatal", stopped, status, attemptStarted);
        throw new ReadOnlyFailure(stopped, status);
      }
      return value;
    }
    const retry =
      ["http-transient", "attempt-timeout", "network-transient"].includes(reason) &&
      attempt < maxAttempts;
    await emit(attempt, retry ? "retry" : "fatal", reason, status, attemptStarted);
    if (!retry) throw new ReadOnlyFailure(reason, status);
    const delay = Math.max(retryAfter, Math.min(1000, backoffMs * 2 ** (attempt - 1)));
    const budget = deadlineAt - now();
    if (budget <= 0) {
      await emit(attempt, "fatal", "deadline", status, attemptStarted);
      throw new ReadOnlyFailure("deadline", status);
    }
    try {
      await pause(Math.min(delay, budget), undefined, { signal });
    } catch {
      const stopped = signal?.aborted ? "caller-aborted" : "pause-unverified";
      await emit(attempt, "fatal", stopped, status, attemptStarted);
      throw new ReadOnlyFailure(stopped, status);
    }
    if (delay >= budget) {
      await emit(attempt, "fatal", "deadline", status, attemptStarted);
      throw new ReadOnlyFailure("deadline", status);
    }
  }
  throw new ReadOnlyFailure("exhausted");
}
