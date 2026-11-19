/* global AbortSignal, AbortController */
import { performance } from "node:perf_hooks";
import { observeReadOnly, readOnlyJson } from "./read-only-json.mjs";
const ACCOUNT = "00000000000000000000000000000001";
const ZONE = "0000000000000000000000000000000b";
const WORKER = "ohmyho-preview-spike-development";
const ROUTE = "*.preview.dev.omh.st/*";
const HOST = "*.preview.dev.omh.st";
const API = "https://api.cloudflare.com/client/v4";
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const RESOURCE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u;
const fail = () => {
  throw new Error("control_target_unverified");
};

// True if two '*' globs can match any common hostname.
function intersect(left, right) {
  const pending = [[0, 0]],
    seen = new Set();
  while (pending.length) {
    const [a, b] = pending.pop(),
      key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a === left.length && b === right.length) return true;
    if (left[a] === "*") pending.push([a + 1, b]);
    if (right[b] === "*") pending.push([a, b + 1]);
    if (a === left.length || b === right.length) continue;
    if (left[a] === "*" || right[b] === "*" || left[a] === right[b])
      pending.push([left[a] === "*" ? a : a + 1, right[b] === "*" ? b : b + 1]);
  }
  return false;
}

/** Unknown route syntax conservatively overlaps; never assume ownership of an unparsed route. */
export function isOverlappingRoute(pattern) {
  if (typeof pattern !== "string" || pattern.length > 512) return true;
  const clean = pattern.toLowerCase().replace(/^(?:https?:)?\/\//u, "");
  const slash = clean.indexOf("/");
  if (slash < 1 || !/^[a-z0-9.*-]+$/u.test(clean.slice(0, slash))) return true;
  return intersect(clean.slice(0, slash), HOST);
}

/**
 * Read-only control-plane sampling; call immediately before sending a bearer to the exact
 * HTTPS Development control origin and refuse redirects. This cannot atomically reserve a route
 * or deployment through the subsequent HTTP request.
 */
export async function assertControlTarget(input) {
  const observe = input?.observe ?? (() => {});
  const signal = input?.signal;
  let now = () => performance.now();
  let deadlineAt = now() + 47000;
  const group = new AbortController();
  let pending = [],
    readFailed = false;
  try {
    now = input?.now ?? now;
    deadlineAt = input?.deadlineAt ?? now() + 47000;
    const {
      accountId,
      zoneId,
      routeId,
      workerVersionId,
      deploymentId,
      token,
      fetcher = globalThis.fetch,
    } = input ?? {};
    if (
      accountId !== ACCOUNT ||
      zoneId !== ZONE ||
      !/^[a-f0-9]{32}$/u.test(routeId ?? "") ||
      !UUID.test(workerVersionId ?? "") ||
      (deploymentId !== undefined && !RESOURCE_ID.test(deploymentId)) ||
      typeof token !== "string" ||
      token.length === 0 ||
      /[\r\n]/u.test(token) ||
      typeof fetcher !== "function"
    )
      fail();
    const get = async (path, label) => {
      try {
        const value = await readOnlyJson(`${API}${path}`, {
          label,
          fetcher,
          observe,
          headers: { authorization: `Bearer ${token}` },
          deadlineAt,
          now,
          signal: signal ? AbortSignal.any([signal, group.signal]) : group.signal,
        });
        if (value?.success !== true || value.result === undefined) fail();
        return value.result;
      } catch (error) {
        readFailed = true;
        throw error;
      }
    };
    pending = [
      get(`/accounts/${ACCOUNT}`, "cf-account"),
      get(`/zones/${ZONE}`, "cf-zone"),
      get(`/zones/${ZONE}/workers/routes`, "cf-routes"),
      get(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/deployments`, "cf-deployments"),
    ];
    const [account, zone, routes, result] = await Promise.all(pending);
    if (
      account?.id !== ACCOUNT ||
      zone?.id !== ZONE ||
      zone?.name !== "omh.st" ||
      zone?.account?.id !== ACCOUNT ||
      !Array.isArray(routes) ||
      !Array.isArray(result?.deployments)
    )
      fail();
    const matches = routes.filter((entry) => isOverlappingRoute(entry?.pattern));
    const current = result.deployments[0],
      versions = current?.versions;
    if (
      matches.length !== 1 ||
      matches[0].id !== routeId ||
      matches[0].pattern !== ROUTE ||
      matches[0].script !== WORKER ||
      !RESOURCE_ID.test(current?.id ?? "") ||
      (deploymentId !== undefined && current.id !== deploymentId) ||
      !Array.isArray(versions) ||
      versions.length !== 1 ||
      versions[0]?.percentage !== 100 ||
      versions[0]?.version_id !== workerVersionId
    )
      fail();
    return true;
  } catch {
    group.abort();
    await Promise.allSettled(pending);
    try {
      await observeReadOnly(
        {
          event: "control-target-check",
          outcome: "unverified",
          reason: readFailed ? "read-failed" : "identity",
        },
        { observe, signal, deadlineAt, now },
      );
    } catch {
      // A failed or cancelled diagnostic cannot replace or extend this fixed failure.
    }
    // Provider errors and transport diagnostics can contain tokens; expose only a fixed sentence.
    fail();
  }
}
