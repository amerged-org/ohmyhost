#!/usr/bin/env node
/* global AbortSignal, Blob, FormData, URL, URLSearchParams, console, fetch, process, setTimeout, structuredClone */
import { createHash } from "node:crypto";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonical } from "./control-d1-codec.mjs";
import { isManualCoreProfile, readEnvironmentProfiles } from "./control-core-manifest.mjs";
import {
  CONTROL_CORE_CONFIG,
  controlCoreEntrypoints,
  inspectControlCoreConsumer,
} from "./control-core-train.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { readProtected, writeProtected } from "./pgcf-maintenance.mjs";
import { requirePrivateReleaseDirectory } from "./release-rehearsal-artifacts.mjs";

/**
 * The technical write stop of the Control cutover, as one journaled operator tool.
 *
 * `stop` makes the public writers answer 503 Retry-After (the existing OMH_DATABASE_CUTOVER_MAINTENANCE variable of the
 * control API, shared gateway and connection broker), pauses the Queues the Control writers consume, removes the cron triggers of
 * every Control writer Worker and waits until nothing that writes is still running. `resume` restores exactly the
 * journaled state. The writers are read from the checked-in Worker profiles of the environment, never listed by hand.
 * Every mutation is journaled before it is sent and read back from the provider afterwards.
 */
const API = "https://api.cloudflare.com/client/v4";
const MAINTENANCE = "OMH_DATABASE_CUTOVER_MAINTENANCE";
const ACCOUNT = /^[a-f0-9]{32}$/u;
const PUBLIC_WRITER =
  /^apps\/(?:control-api\/wrangler(?:\.production)?|wfp-dispatch\/wrangler(?:\.production)?\.shared|connection-broker\/wrangler\.(?:development|production))\.jsonc$/u;
/** Workflow instances in these states execute steps; `waiting` instances only sleep and are reported, not awaited. */
const RUNNING = ["running", "queued", "waitingForPause"];
const usage =
  "usage: control-core-cutover snapshot|stop|resume|status --environment development|production --custody <private-directory> [--confirm production] [--probe <url>]... [--settle-seconds <n>] [--drain-timeout-seconds <n>]";
const fail = (code, detail) => {
  throw Object.assign(new Error(code), detail === undefined ? {} : { detail });
};
const sha = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const same = (a, b) => isDeepStrictEqual(a, b);
const names = (values) => [...new Set(values)].sort();
// These exact capabilities execute SELECTs transitively, including credit decisions and routing.
// New or broader Core capabilities remain writers until reviewed separately.
const CORE_READERS = new Set(["PreviewSourceRuntime", "PreviewDatabaseAuthorityRuntime"]);

/** The Control writers of one environment, read from its checked-in Worker profiles. */
export async function controlCoreWriters({ repositoryRoot, environment }) {
  if (!Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment)) fail("CUTOVER_ENVIRONMENT");
  const entrypoints = await controlCoreEntrypoints(repositoryRoot);
  const profiles = (await readEnvironmentProfiles({ repositoryRoot, environment })).filter(
    ({ config }) => config !== CONTROL_CORE_CONFIG && !isManualCoreProfile(config, environment),
  );
  const writers = profiles
    .map(({ config, configuration }) => ({
      config,
      scriptName: configuration.name,
      queues: names((configuration.queues?.consumers ?? []).map(({ queue }) => queue)),
      workflows: names((configuration.workflows ?? []).map(({ name }) => name)),
      // Read-only authority bindings do not write Core; cron and Queue drivers remain writers.
      writes:
        inspectControlCoreConsumer({ configuration, environment, entrypoints }).bindings.some(
          ({ entrypoint }) => !CORE_READERS.has(entrypoint),
        ) ||
        (configuration.triggers?.crons ?? []).length > 0 ||
        (configuration.queues?.consumers ?? []).length > 0,
    }))
    .filter(({ writes }) => writes);
  if (new Set(writers.map(({ scriptName }) => scriptName)).size !== writers.length)
    fail("CUTOVER_DUPLICATE_WRITER");
  return Object.freeze({
    environment,
    writers: writers.map(({ scriptName }) => scriptName).sort(),
    publicWriters: profiles
      .filter(({ config }) => PUBLIC_WRITER.test(config))
      .map(({ configuration }) => configuration.name)
      .sort(),
    queues: names(writers.flatMap(({ queues }) => queues)),
    workflows: names(writers.flatMap(({ workflows }) => workflows)),
  });
}

/**
 * The cron lists the checked-in profiles of one environment declare, by Worker name: what a Worker that the release
 * train creates after the snapshot (the credit service) must carry once it exists.
 */
export async function declaredCrons({ repositoryRoot, environment }) {
  const declared = {};
  for (const { config, configuration } of await readEnvironmentProfiles({
    repositoryRoot,
    environment,
  })) {
    if (isManualCoreProfile(config, environment)) continue;
    if (Object.hasOwn(declared, configuration.name)) fail("CUTOVER_DUPLICATE_WRITER");
    declared[configuration.name] = names(configuration.triggers?.crons ?? []);
  }
  return declared;
}

/**
 * The instant the technical write stop completed, from the journal in the private custody directory: the one fact the
 * credit cutover needs from it. Refuses a missing, foreign or unfinished journal with a fixed code.
 */
export async function readStopTime({ custody, environment, repositoryRoot }) {
  if (!Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment)) fail("CUTOVER_ENVIRONMENT");
  const directory = await requirePrivateReleaseDirectory(resolve(custody), repositoryRoot).catch(
    () => fail("CUTOVER_CUSTODY"),
  );
  const journal = await readProtected(
    join(directory, `control-core-cutover-${environment}.json`),
    true,
  ).catch(() => fail("CUTOVER_JOURNAL_UNREADABLE"));
  const stoppedAt = journal?.stop?.stoppedAt;
  if (
    journal?.schemaVersion !== "omh.control-core-cutover/v1" ||
    journal.environment !== environment ||
    typeof stoppedAt !== "string" ||
    Number.isNaN(Date.parse(stoppedAt)) ||
    new Date(stoppedAt).toISOString() !== stoppedAt
  )
    fail("CUTOVER_STOP_NOT_RECORDED");
  return stoppedAt;
}

/** Provider API boundary: fixed paths, no redirects, no provider body in any error. */
export function cloudflareClient({ accountId, token, fetcher = fetch }) {
  if (!ACCOUNT.test(accountId ?? "") || typeof token !== "string" || token.trim() === "")
    fail("CUTOVER_CREDENTIALS");
  const scoped = [
    ["GET", /^$/u],
    ["GET", /^\/workers\/scripts\/[a-z0-9][a-z0-9_-]{0,62}\/(?:schedules|settings|deployments)$/u],
    ["GET", /^\/workers\/scripts\/[a-z0-9][a-z0-9_-]{0,62}\/subdomain$/u],
    ["GET", /^\/workers\/domains$/u],
    ["PUT", /^\/workers\/scripts\/[a-z0-9][a-z0-9_-]{0,62}\/schedules$/u],
    ["PATCH", /^\/workers\/scripts\/[a-z0-9][a-z0-9_-]{0,62}\/settings$/u],
    ["GET", /^\/queues$/u],
    ["GET", /^\/queues\/[a-f0-9]{32}(?:\/metrics)?$/u],
    ["PATCH", /^\/queues\/[a-f0-9]{32}$/u],
    ["GET", /^\/workflows\/[a-z0-9][a-z0-9_-]{0,62}\/instances$/u],
  ];
  return async function request(method, path, { query, body, form } = {}) {
    if (!scoped.some(([verb, pattern]) => verb === method && pattern.test(path)))
      fail("CUTOVER_API_SCOPE");
    const search = query === undefined ? "" : `?${new URLSearchParams(query)}`;
    let response, envelope;
    try {
      response = await fetcher(`${API}/accounts/${accountId}${path}${search}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(form === undefined ? { "content-type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(form !== undefined
          ? { body: form }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
      });
      envelope = await response.json();
    } catch {
      fail("CUTOVER_API_UNAVAILABLE");
    }
    if (!response.ok || envelope?.success !== true)
      throw Object.assign(new Error("CUTOVER_API_REFUSED"), { status: response.status });
    return envelope;
  };
}

const absent = (error) => error?.message === "CUTOVER_API_REFUSED" && error.status === 404;

async function observeWorker(request, name) {
  try {
    const { result } = await request("GET", `/workers/scripts/${name}/schedules`);
    return { crons: names((result?.schedules ?? []).map(({ cron }) => cron)) };
  } catch (error) {
    if (absent(error)) return { absent: true };
    throw error;
  }
}

const queueSettings = (settings) => ({
  delivery_delay: settings?.delivery_delay ?? 0,
  delivery_paused: settings?.delivery_paused ?? false,
  message_retention_period: settings?.message_retention_period ?? 0,
});

async function queueIds(request, queues) {
  const ids = new Map();
  for (let page = 1; ; page += 1) {
    const { result } = await request("GET", "/queues", {
      query: { page: String(page), per_page: "100" },
    });
    for (const queue of result)
      if (queues.includes(queue.queue_name)) ids.set(queue.queue_name, queue.queue_id);
    if (result.length < 100) break;
  }
  const missing = queues.filter((name) => !ids.has(name));
  if (missing.length > 0) fail("CUTOVER_QUEUE_MISSING", missing);
  return ids;
}

async function observeQueue(request, id) {
  const { result } = await request("GET", `/queues/${id}`);
  return {
    id,
    settings: queueSettings(result.settings),
    consumers: (result.consumers ?? [])
      .map((consumer) => ({
        id: consumer.consumer_id,
        type: consumer.type,
        script: consumer.script ?? consumer.script_name ?? null,
        deadLetter: consumer.dead_letter_queue ?? null,
        settings: consumer.settings ?? {},
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

/** The maintenance variable and a digest of every other binding (secrets by name only), plus the live version. */
async function observePublicWriter(request, name) {
  const [{ result: settings }, { result: deployments }] = await Promise.all([
    request("GET", `/workers/scripts/${name}/settings`),
    request("GET", `/workers/scripts/${name}/deployments`),
  ]);
  const variable = settings.bindings.filter((binding) => binding.name === MAINTENANCE);
  if (
    variable.length > 1 ||
    variable.some(
      (binding) => binding.type !== "plain_text" || !["on", "off"].includes(binding.text),
    )
  )
    fail("CUTOVER_MAINTENANCE_VARIABLE", name);
  const live = deployments.deployments?.[0]?.versions ?? [];
  if (live.length !== 1 || live[0].percentage !== 100) fail("CUTOVER_GRADUAL_DEPLOYMENT", name);
  const others = settings.bindings.filter((binding) => binding.name !== MAINTENANCE);
  const origin = others.find(
    (binding) => binding.type === "plain_text" && binding.name === "CONTROL_API_PUBLIC_ORIGIN",
  )?.text;
  return {
    maintenance: variable[0]?.text ?? null,
    bindingsSha256: sha(others),
    versionId: live[0].version_id,
    bindings: others,
    ...(origin === undefined ? {} : { origin }),
  };
}

async function setMaintenance(request, name, value) {
  const before = await observePublicWriter(request, name);
  const bindings = [
    ...before.bindings,
    ...(value === null ? [] : [{ type: "plain_text", name: MAINTENANCE, text: value }]),
  ];
  const form = new FormData();
  form.set("settings", new Blob([JSON.stringify({ bindings })], { type: "application/json" }));
  await request("PATCH", `/workers/scripts/${name}/settings`, { form });
  const after = await observePublicWriter(request, name);
  if (after.maintenance !== value || after.bindingsSha256 !== before.bindingsSha256)
    fail("CUTOVER_READBACK", name);
  return after.versionId;
}

/** The non-secret, comparable provider state of everything the stop touches. */
async function observeState(request, scope, queueIdByName) {
  const [workers, queues, writers] = await Promise.all([
    Promise.all(scope.writers.map((name) => observeWorker(request, name))),
    Promise.all(scope.queues.map((name) => observeQueue(request, queueIdByName.get(name)))),
    Promise.all(scope.publicWriters.map((name) => observePublicWriter(request, name))),
  ]);
  return {
    workers: Object.fromEntries(scope.writers.map((name, index) => [name, workers[index]])),
    queues: Object.fromEntries(scope.queues.map((name, index) => [name, queues[index]])),
    publicWriters: Object.fromEntries(
      scope.publicWriters.map((name, index) => [
        name,
        { maintenance: writers[index].maintenance, bindingsSha256: writers[index].bindingsSha256 },
      ]),
    ),
    versions: Object.fromEntries(
      scope.publicWriters.map((name, index) => [name, writers[index].versionId]),
    ),
    origins: names(writers.map(({ origin }) => origin).filter(Boolean)),
  };
}

const comparable = ({ workers, queues, publicWriters }) => ({ workers, queues, publicWriters });
/**
 * Paths (names only) where two states differ. Released public writers compare only "not in maintenance". A Worker the
 * snapshot found absent may since have been created by the train: it then carries exactly the schedules its profile
 * declares (`declared`, name to cron list), and nothing else about it is tolerated.
 */
export function diffState(expected, actual, released = [], declared = {}) {
  const left = structuredClone(comparable(expected)),
    right = structuredClone(comparable(actual));
  for (const [name, crons] of Object.entries(declared))
    if (left.workers[name]?.absent === true && same(right.workers[name], { crons }))
      right.workers[name] = left.workers[name];
  for (const name of released) {
    for (const side of [left, right]) {
      const writer = side.publicWriters[name];
      if (writer !== undefined) {
        writer.maintenance = writer.maintenance === "on" ? "on" : "lifted";
        delete writer.bindingsSha256;
      }
    }
  }
  const paths = [];
  const walk = (a, b, path) => {
    if (
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a)
    ) {
      for (const key of names([...Object.keys(a), ...Object.keys(b)]))
        walk(a[key], b[key], `${path}.${key}`);
    } else if (!same(a, b)) paths.push(path.slice(1));
  };
  walk(left, right, "");
  return paths;
}

const mapValues = (object, map) =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, map(value)]));
/** The state a completed stop leaves behind, derived from the snapshot. */
const stoppedState = (snapshot) => ({
  workers: mapValues(snapshot.workers, (worker) =>
    worker.crons?.length > 0 ? { crons: [] } : worker,
  ),
  queues: mapValues(snapshot.queues, (queue) => ({
    ...queue,
    settings: { ...queue.settings, delivery_paused: true },
  })),
  publicWriters: mapValues(snapshot.publicWriters, (writer) => ({ ...writer, maintenance: "on" })),
});

/** Each step moves one resource between the snapshot value and its stopped value; anything else is a foreign change. */
function stepsFor(scope, snapshot, ids) {
  return {
    maintenance: scope.publicWriters.map((name) => ({
      key: `maintenance:${name}`,
      name,
      read: async (request) => (await observePublicWriter(request, name)).maintenance,
      value: (action) => (action === "stop" ? "on" : snapshot.publicWriters[name].maintenance),
      write: async (request, value, journal) => {
        journal.versions[name] = await setMaintenance(request, name, value);
      },
    })),
    queues: scope.queues.map((name) => ({
      key: `queue:${name}`,
      name,
      read: async (request) => (await observeQueue(request, ids.get(name))).settings,
      value: (action) => ({
        ...snapshot.queues[name].settings,
        delivery_paused: action === "stop" ? true : snapshot.queues[name].settings.delivery_paused,
      }),
      write: async (request, value) => {
        await request("PATCH", `/queues/${ids.get(name)}`, { body: { settings: value } });
      },
    })),
    workers: scope.writers
      .filter((name) => (snapshot.workers[name].crons ?? []).length > 0)
      .map((name) => ({
        key: `cron:${name}`,
        name,
        read: async (request) => (await observeWorker(request, name)).crons,
        value: (action) => (action === "stop" ? [] : snapshot.workers[name].crons),
        write: async (request, value) => {
          await request("PUT", `/workers/scripts/${name}/schedules`, {
            body: value.map((cron) => ({ cron })),
          });
        },
      })),
  };
}

async function probe(fetcher, url) {
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return { status: response.status, retryAfter: response.headers.get("retry-after") };
  } catch {
    return { status: 0, retryAfter: null };
  }
}

/** Runs the four subcommands. Everything external enters through `dependencies` so a test can sit at the provider boundary. */
export async function runCutover(
  {
    command,
    environment,
    custody,
    confirm,
    probes = [],
    settleSeconds = 20,
    drainTimeoutSeconds = 120,
  },
  {
    repositoryRoot = fileURLToPath(new URL("..", import.meta.url)),
    env = process.env,
    fetcher = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    clock = () => new Date(),
  } = {},
) {
  if (
    !["snapshot", "stop", "resume", "status"].includes(command) ||
    !Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment) ||
    typeof custody !== "string" ||
    (environment === "production"
      ? confirm !== "production"
      : confirm !== undefined && confirm !== environment)
  )
    fail("CUTOVER_USAGE");
  const request = cloudflareClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    fetcher,
  });
  const directory = await requirePrivateReleaseDirectory(resolve(custody), repositoryRoot).catch(
    () => fail("CUTOVER_CUSTODY"),
  );
  const path = join(directory, `control-core-cutover-${environment}.json`);
  try {
    await mkdir(`${path}.lock`, { mode: 0o700 });
  } catch {
    fail("CUTOVER_JOURNAL_LOCKED");
  }
  const stamp = () => clock().toISOString();
  try {
    if ((await request("GET", "")).result?.id !== env.CLOUDFLARE_ACCOUNT_ID)
      fail("CUTOVER_ACCOUNT");
    const scope = await controlCoreWriters({ repositoryRoot, environment });
    const ids = await queueIds(request, scope.queues);
    let journal = await readProtected(path, true);
    const save = () => writeProtected(path, journal);
    if (
      journal !== null &&
      (journal.environment !== environment || journal.accountId !== env.CLOUDFLARE_ACCOUNT_ID)
    )
      fail("CUTOVER_JOURNAL_SCOPE");

    if (command === "snapshot") {
      if (journal !== null && journal.phase === "resumed")
        await rename(path, `${path}.${journal.resume.resumedAt.replace(/[-:.]/gu, "")}`);
      else if (journal !== null && journal.phase !== "snapshotted")
        fail("CUTOVER_JOURNAL_ACTIVE", journal.phase);
      const state = await observeState(request, scope, ids);
      const { versions, origins, ...snapshot } = state;
      journal = {
        schemaVersion: "omh.control-core-cutover/v1",
        environment,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        phase: "snapshotted",
        snapshotAt: stamp(),
        scope,
        snapshot,
        origins,
        versions,
        steps: {},
      };
      await save();
      return {
        phase: journal.phase,
        environment,
        snapshotAt: journal.snapshotAt,
        writers: scope.writers.length,
        withCrons: Object.values(snapshot.workers).filter(({ crons }) => crons?.length > 0).length,
        queues: Object.keys(snapshot.queues),
        maintenance: Object.fromEntries(
          Object.entries(snapshot.publicWriters).map(([name, { maintenance }]) => [
            name,
            maintenance,
          ]),
        ),
        workflows: scope.workflows,
      };
    }
    if (journal === null) fail("CUTOVER_SNAPSHOT_REQUIRED");
    if (!same(journal.scope, scope)) fail("CUTOVER_SCOPE_CHANGED");
    const snapshot = journal.snapshot;
    const steps = stepsFor(scope, snapshot, ids);

    // One batch: classify each resource by readback, journal the sends, send them together, read every one back.
    const batch = async (action, list) => {
      const send = [];
      await Promise.all(
        list.map(async (step) => {
          const current = await step.read(request);
          const wanted = step.value(action);
          const other = step.value(action === "stop" ? "resume" : "stop");
          if (same(current, wanted)) return;
          if (same(current, other)) send.push(step);
          else if (action === "resume" && step.key.startsWith("maintenance:") && current !== "on")
            journal.released[step.name] = true;
          else fail("CUTOVER_CHANGED_OUTSIDE", step.name);
        }),
      );
      for (const step of send) journal.steps[step.key] = `${action}_pending`;
      if (send.length > 0) await save();
      await Promise.all(
        send.map(async (step) => {
          await step.write(request, step.value(action), journal);
          if (!same(await step.read(request), step.value(action)))
            fail("CUTOVER_READBACK", step.name);
          journal.steps[step.key] = action === "stop" ? "stopped" : "resumed";
        }),
      );
      if (send.length > 0) await save();
      return send.length;
    };
    const current = () => observeState(request, scope, ids);

    // The profiles' schedules are what a Worker created since the snapshot must carry; it needs no restore.
    const declared = await declaredCrons({ repositoryRoot, environment });
    const createdSince = (state) =>
      Object.keys(snapshot.workers).filter(
        (name) => snapshot.workers[name].absent === true && state.workers[name]?.absent !== true,
      );

    if (command === "status") {
      const state = await current();
      return {
        phase: journal.phase,
        environment,
        matchesSnapshot: diffState(snapshot, state, [], declared).length === 0,
        diff: diffState(snapshot, state, Object.keys(journal.released ?? {}), declared),
        createdSinceSnapshot: createdSince(state),
        paused: Object.entries(state.queues)
          .filter(([, { settings }]) => settings.delivery_paused)
          .map(([name]) => name),
        maintenance: Object.fromEntries(
          Object.entries(state.publicWriters).map(([name, { maintenance }]) => [name, maintenance]),
        ),
        cronsRemaining: Object.entries(state.workers)
          .filter(([, { crons }]) => crons?.length > 0)
          .map(([name]) => name),
      };
    }

    if (command === "stop") {
      if (["stopped", "resuming", "resumed"].includes(journal.phase))
        fail("CUTOVER_STOP_ALREADY_DONE", journal.phase);
      if (journal.phase === "snapshotted") {
        const drift = diffState(snapshot, await current());
        if (drift.length > 0) fail("CUTOVER_SNAPSHOT_DRIFT", drift);
        Object.assign(journal, {
          phase: "stopping",
          stop: { startedAt: stamp() },
          released: {},
          steps: {},
        });
        await save();
      }
      const timings = {};
      const phaseTime = async (label, work) => {
        const from = clock().getTime();
        const value = await work();
        timings[label] = clock().getTime() - from;
        return value;
      };
      await phaseTime("maintenanceMs", () => batch("stop", steps.maintenance));
      await phaseTime("queuesMs", () => batch("stop", steps.queues));
      if (journal.stop.queuesPausedAt === undefined) {
        journal.stop.queuesPausedAt = stamp();
        await save();
      }
      const queuesPausedAt = Date.parse(journal.stop.queuesPausedAt);
      await phaseTime("cronsMs", () => batch("stop", steps.workers));
      const probed = [];
      for (const url of names([
        ...journal.origins.map((origin) => new URL("/", origin).href),
        ...probes,
      ])) {
        let result;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          result = await probe(fetcher, url);
          if (result.status === 503 && result.retryAfter !== null) break;
          await sleep(5000);
        }
        if (result.status !== 503 || result.retryAfter === null)
          fail("CUTOVER_PUBLIC_NOT_503", new URL(url).host);
        probed.push({ host: new URL(url).host, ...result });
      }
      await phaseTime("settleMs", () => sleep(settleSeconds * 1000));
      // The settle wait bounds handlers that started before the pause. Queue metrics expose the backlog only, so a backlog older than
      // the pause may hold an unacknowledged message and is awaited; one newer than the pause was never delivered.
      // A Workflow step is running while an instance is running, queued or waiting to pause.
      const deadline = clock().getTime() + drainTimeoutSeconds * 1000;
      let backlog, workflows;
      await phaseTime("drainMs", async () => {
        for (;;) {
          backlog = await Promise.all(
            scope.queues.map(async (name) => {
              const { result } = await request("GET", `/queues/${ids.get(name)}/metrics`);
              const held =
                result.backlog_count > 0 && result.oldest_message_timestamp_ms < queuesPausedAt;
              return { queue: name, backlog: result.backlog_count, inFlightPossible: held };
            }),
          );
          workflows = await Promise.all(
            scope.workflows.map(async (name) => {
              const count = async (status) => {
                try {
                  const { result_info: info } = await request(
                    "GET",
                    `/workflows/${name}/instances`,
                    {
                      query: { status, per_page: "1" },
                    },
                  );
                  return info?.total_count ?? 0;
                } catch (error) {
                  if (absent(error)) return 0;
                  throw error;
                }
              };
              const active = (await Promise.all(RUNNING.map(count))).reduce((a, b) => a + b, 0);
              return { workflow: name, active, sleeping: await count("waiting") };
            }),
          );
          if (!backlog.some((q) => q.inFlightPossible) && !workflows.some((w) => w.active > 0))
            break;
          if (clock().getTime() >= deadline)
            fail("CUTOVER_NOT_DRAINED", {
              queues: backlog.filter((q) => q.inFlightPossible).map((q) => q.queue),
              workflows: workflows.filter((w) => w.active > 0).map((w) => w.workflow),
            });
          await sleep(5000);
        }
      });
      const final = diffState(stoppedState(snapshot), await current());
      if (final.length > 0) fail("CUTOVER_READBACK", final);
      journal.phase = "stopped";
      journal.stop = {
        ...journal.stop,
        stoppedAt: stamp(),
        elapsedMs: clock().getTime() - Date.parse(journal.stop.startedAt),
      };
      await save();
      return {
        phase: journal.phase,
        environment,
        startedAt: journal.stop.startedAt,
        stoppedAt: journal.stop.stoppedAt,
        queuesPausedAt: journal.stop.queuesPausedAt,
        timings,
        cronsRemoved: steps.workers.length,
        queuesPaused: scope.queues,
        publicWriters: Object.keys(snapshot.publicWriters),
        probes: probed,
        backlog,
        workflows,
      };
    }

    // resume
    if (["snapshotted", "resumed"].includes(journal.phase))
      fail(journal.phase === "resumed" ? "CUTOVER_RESUME_ALREADY_DONE" : "CUTOVER_NOTHING_STOPPED");
    if (journal.phase !== "resuming") {
      Object.assign(journal, { phase: "resuming", resume: { startedAt: stamp() }, steps: {} });
      await save();
    }
    journal.released ??= {};
    // A writer a release redeployed since the stop is no longer our version: only "not in maintenance" is compared for it.
    const live = await current();
    for (const name of scope.publicWriters)
      if (live.versions[name] !== journal.versions[name]) journal.released[name] = true;
    // Producers first, consumers next, public ingress last.
    await batch("resume", steps.workers);
    await batch("resume", steps.queues);
    await batch("resume", steps.maintenance);
    const resumed = await current();
    const diff = diffState(snapshot, resumed, Object.keys(journal.released), declared);
    if (diff.length > 0) fail("CUTOVER_RESUME_DIFF", diff);
    const lifted = [];
    for (const url of names([
      ...journal.origins.map((origin) => new URL("/", origin).href),
      ...probes,
    ])) {
      let result;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        result = await probe(fetcher, url);
        if (result.status !== 503 && result.status !== 0) break;
        await sleep(5000);
      }
      if (result.status === 503 || result.status === 0)
        fail("CUTOVER_PUBLIC_STILL_503", new URL(url).host);
      lifted.push({ host: new URL(url).host, status: result.status });
    }
    journal.phase = "resumed";
    journal.resume = {
      ...journal.resume,
      resumedAt: stamp(),
      elapsedMs: clock().getTime() - Date.parse(journal.resume.startedAt),
    };
    await save();
    return {
      phase: journal.phase,
      environment,
      startedAt: journal.resume.startedAt,
      resumedAt: journal.resume.resumedAt,
      elapsedMs: journal.resume.elapsedMs,
      diff,
      releasedSinceStop: Object.keys(journal.released),
      createdSinceStop: createdSince(resumed),
      probes: lifted,
    };
  } finally {
    await rmdir(`${path}.lock`);
  }
}

export function parseCutoverArguments(argv) {
  const [command, ...rest] = argv;
  const options = { probes: [] };
  const flags = {
    "--environment": "environment",
    "--custody": "custody",
    "--confirm": "confirm",
    "--probe": "probes",
    "--settle-seconds": "settleSeconds",
    "--drain-timeout-seconds": "drainTimeoutSeconds",
  };
  for (let index = 0; index < rest.length; index += 2) {
    const key = flags[rest[index]];
    const value = rest[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      (key !== "probes" && key in options && options[key] !== undefined)
    )
      fail("CUTOVER_USAGE");
    if (key === "probes") options.probes.push(value);
    else options[key] = key.endsWith("Seconds") ? Number(value) : value;
  }
  if (
    [options.settleSeconds, options.drainTimeoutSeconds].some(
      (value) => value !== undefined && !(Number.isFinite(value) && value >= 0),
    )
  )
    fail("CUTOVER_USAGE");
  return { command, ...options };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(await runCutover(parseCutoverArguments(process.argv.slice(2)))));
  } catch (error) {
    // Provider bodies and credentials never reach the output: only fixed codes and resource names.
    const code = /^CUTOVER_[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "CUTOVER_FAILED";
    console.error(
      JSON.stringify({
        code,
        ...(error?.detail === undefined ? {} : { detail: error.detail }),
        ...(code === "CUTOVER_FAILED" ? { usage } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
