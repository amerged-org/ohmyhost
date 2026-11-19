/* global AbortSignal, fetch, process */
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPrivate, writeExclusive } from "./control-d1-artifacts.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";
import { requirePrivateReleaseDirectory } from "./release-rehearsal-artifacts.mjs";
import { controlCoreDatabaseName } from "./prepare-control-core-deployment.mjs";
import {
  assertControlCoreResourceIdentity,
  fixedControlCoreDatabaseName,
} from "./control-core-train.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const fail = (code = "CONTROL_CORE_RESOURCE_UNVERIFIED") => {
  throw new Error(code);
};

/** Operator-only credentials stay in memory. This client never follows redirects, retries or logs provider bodies. */
export function controlCoreCloudflareClient({
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetch: fetcher = fetch,
} = {}) {
  if (typeof token !== "string" || token.length === 0) fail("CONTROL_CORE_CREDENTIAL_REQUIRED");
  return async ({ method, path, body }) => {
    if (!/^\/accounts\/[a-f0-9]{32}\/d1\/database(?:[/?]|$)/u.test(path)) fail();
    let response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const envelope = await response.json();
      if (!response.ok || envelope?.success !== true) fail();
      return envelope;
    } catch {
      fail("CONTROL_CORE_PROVIDER_UNAVAILABLE");
    }
  };
}

export function assertControlCoreResource(database, { environment, creationId, databaseId }) {
  const fixedName = `ohmyho-control-core-${environment}`;
  try {
    return assertControlCoreResourceIdentity(database, {
      environment,
      databaseId,
      databaseName:
        database?.name === fixedName ? fixedName : controlCoreDatabaseName(environment, creationId),
    });
  } catch {
    return fail();
  }
}

/** Observes the one resource by exact name: the fixed name when no creation identity is given. */
export async function observeControlCoreResource({ accountId, environment, creationId }, request) {
  if (!ACCOUNT.test(accountId ?? "")) fail();
  const name =
    creationId === undefined
      ? fixedControlCoreDatabaseName(environment)
      : controlCoreDatabaseName(environment, creationId);
  const matches = [];
  for (let page = 1; ; page += 1) {
    const envelope = await request({
      method: "GET",
      path: `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&page=${page}&per_page=100`,
    });
    if (!Array.isArray(envelope.result)) fail();
    matches.push(...envelope.result.filter((database) => database?.name === name));
    if (matches.length > 1) fail();
    if (envelope.result.length < 100) break;
  }
  if (matches.length === 0) return null;
  const id = matches[0].uuid;
  if (!UUID.test(id ?? "")) fail();
  const detail = await request({ method: "GET", path: `/accounts/${accountId}/d1/database/${id}` });
  return assertControlCoreResource(detail.result, { environment, creationId, databaseId: id });
}

async function existingJson(path) {
  try {
    return JSON.parse((await readPrivate(path)).toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Persist intent and a one-shot dispatch marker BEFORE creation. An uncertain outcome is observation-only forever. */
export async function ensureControlCoreResource(
  input,
  { request = controlCoreCloudflareClient(), inspect = inspectRehearsalRepository } = {},
) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !==
      "accountId,creationId,environment,output,repositoryRoot" ||
    !ACCOUNT.test(input.accountId ?? "")
  )
    fail();
  const source = await inspect({ cwd: resolve(input.repositoryRoot) });
  if (
    !/^[a-f0-9]{40}$/u.test(source.sha ?? "") ||
    resolve(source.repositoryRoot) !== resolve(input.repositoryRoot)
  )
    fail();
  const intent = {
    schemaVersion: 1,
    kind: "omh.control-core.resource-intent/v1",
    accountId: input.accountId,
    creationId: input.creationId,
    environment: input.environment,
    databaseName: controlCoreDatabaseName(input.environment, input.creationId),
    sourceCommit: source.sha,
    repositoryRoot: source.repositoryRoot,
  };
  const output = resolve(input.output);
  // One configured private custody parent has exactly one directory per account/creation identity.
  // A new session/output label cannot fork the same identity's dispatch marker.
  if (basename(output) !== `${input.accountId}-${intent.databaseName}`) fail();
  await requirePrivateReleaseDirectory(resolve(output, ".."), source.repositoryRoot);
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await requirePrivateReleaseDirectory(output, source.repositoryRoot);
  try {
    await writeExclusive(join(output, "resource-intent.json"), JSON.stringify(intent) + "\n");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!isDeepStrictEqual(await existingJson(join(output, "resource-intent.json")), intent))
      fail();
  }
  let database = await observeControlCoreResource(input, request);
  if (
    database !== null &&
    !isDeepStrictEqual(await existingJson(join(output, "create-dispatched.json")), intent)
  )
    fail();
  if (database === null) {
    try {
      await writeExclusive(join(output, "create-dispatched.json"), JSON.stringify(intent) + "\n");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!isDeepStrictEqual(await existingJson(join(output, "create-dispatched.json")), intent))
        fail();
      return { state: "outcome-unknown", intent };
    }
    // No catch-and-retry: losing this response leaves the original marker for exact-name reconciliation.
    const response = await request({
      method: "POST",
      path: `/accounts/${input.accountId}/d1/database`,
      body: {
        name: intent.databaseName,
        jurisdiction: "eu",
        read_replication: { mode: "disabled" },
      },
    });
    const created = assertControlCoreResource(response.result, input);
    database = await observeControlCoreResource(input, request);
    if (database === null || database.uuid !== created.uuid) fail();
  }
  const observation = {
    accountId: input.accountId,
    observedAt: new Date().toISOString(),
    database,
  };
  const receipt = { ...intent, databaseId: database.uuid };
  try {
    await writeExclusive(join(output, "resource-receipt.json"), JSON.stringify(receipt) + "\n");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!isDeepStrictEqual(await existingJson(join(output, "resource-receipt.json")), receipt))
      fail();
  }
  return { state: "resource-observed", intent, observation };
}
