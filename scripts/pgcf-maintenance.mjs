#!/usr/bin/env node
/* global AbortSignal, fetch, process, structuredClone */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Official API: PATCH queue settings (not consumer removal), GET/PUT Worker cron schedules.
// https://developers.cloudflare.com/api/resources/queues/methods/edit/
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/
const API = "https://api.cloudflare.com/client/v4";
const HEX = /^[a-f0-9]{32}$/u;
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const CRON = /^[0-9*/?,LW#-]+(?: +[0-9A-Za-z*/?,LW#-]+){4}$/u;
const phases = ["snapshotted", "pause_pending", "paused", "resume_pending", "resumed"];
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const sorted = (values) => [...values].sort();
const fail = (message) => {
  throw new Error(message);
};

export function parseMaintenanceManifest(value) {
  if (
    !exact(value, ["schemaVersion", "cutoverId", "accountId", "workers", "queues"]) ||
    value.schemaVersion !== "omh.pgcf-maintenance/v1" ||
    !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.cutoverId ?? "") ||
    !HEX.test(value.accountId ?? "") ||
    !Array.isArray(value.workers) ||
    !Array.isArray(value.queues) ||
    value.workers.length > 64 ||
    value.queues.length > 64 ||
    value.workers.length + value.queues.length === 0
  )
    fail("Maintenance manifest is invalid");
  for (const worker of value.workers)
    if (!exact(worker, ["scriptName"]) || !NAME.test(worker.scriptName ?? ""))
      fail("Maintenance Worker identity is invalid");
  for (const queue of value.queues)
    if (
      !exact(queue, ["queueId", "queueName", "consumerIds"]) ||
      !HEX.test(queue.queueId ?? "") ||
      !NAME.test(queue.queueName ?? "") ||
      !Array.isArray(queue.consumerIds) ||
      queue.consumerIds.length > 16 ||
      queue.consumerIds.some((id) => !HEX.test(id)) ||
      new Set(queue.consumerIds).size !== queue.consumerIds.length
    )
      fail("Maintenance Queue identity is invalid");
  if (
    new Set(value.workers.map((w) => w.scriptName)).size !== value.workers.length ||
    new Set(value.queues.map((q) => q.queueId)).size !== value.queues.length
  )
    fail("Maintenance targets are duplicated");
  return structuredClone(value);
}

function schedules(value) {
  if (!object(value) || !Array.isArray(value.schedules) || value.schedules.length > 64)
    fail("Cron snapshot is invalid");
  const result = value.schedules
    .map((schedule) => {
      if (
        !object(schedule) ||
        typeof schedule.cron !== "string" ||
        !CRON.test(schedule.cron) ||
        schedule.cron.length > 128 ||
        Object.keys(schedule).some((key) => !["cron", "created_on", "modified_on"].includes(key)) ||
        [schedule.created_on, schedule.modified_on].some(
          (time) =>
            time !== undefined && (typeof time !== "string" || !Number.isFinite(Date.parse(time))),
        )
      )
        fail("Cron schedule is invalid");
      return { ...schedule };
    })
    .sort((a, b) => a.cron.localeCompare(b.cron));
  if (new Set(result.map((x) => x.cron)).size !== result.length)
    fail("Cron schedules are duplicated");
  return result;
}
function queueSnapshot(value, target) {
  if (
    !object(value) ||
    value.queue_id !== target.queueId ||
    value.queue_name !== target.queueName ||
    !object(value.settings) ||
    (Object.hasOwn(value.settings, "delivery_paused") &&
      typeof value.settings.delivery_paused !== "boolean") ||
    Object.keys(value.settings).some(
      (k) => !["delivery_paused", "delivery_delay", "message_retention_period"].includes(k),
    ) ||
    Object.entries(value.settings).some(
      ([k, v]) => k !== "delivery_paused" && (!Number.isSafeInteger(v) || v < 0),
    ) ||
    !Array.isArray(value.consumers) ||
    value.consumers.length > 16 ||
    value.consumers_total_count !== value.consumers.length
  )
    fail("Queue snapshot is incomplete or differs from the approved target");
  const consumers = value.consumers
    .map((consumer) => {
      if (
        !object(consumer) ||
        !HEX.test(consumer.consumer_id ?? "") ||
        !["worker", "http_pull"].includes(consumer.type) ||
        (consumer.type === "worker" && !NAME.test(consumer.script_name ?? consumer.script ?? "")) ||
        (consumer.script !== undefined && !NAME.test(consumer.script)) ||
        (consumer.script_name !== undefined && !NAME.test(consumer.script_name)) ||
        (consumer.script !== undefined &&
          consumer.script_name !== undefined &&
          consumer.script !== consumer.script_name) ||
        Object.keys(consumer).some(
          (k) =>
            ![
              "consumer_id",
              "created_on",
              "dead_letter_queue",
              "queue_name",
              "script_name",
              "script",
              "settings",
              "type",
            ].includes(k),
        ) ||
        (consumer.queue_name !== undefined && consumer.queue_name !== target.queueName) ||
        (consumer.dead_letter_queue !== undefined &&
          consumer.dead_letter_queue !== "" &&
          !NAME.test(consumer.dead_letter_queue)) ||
        (consumer.created_on !== undefined && !Number.isFinite(Date.parse(consumer.created_on))) ||
        !object(consumer.settings) ||
        Object.entries(consumer.settings).some(
          ([k, v]) =>
            ![
              "batch_size",
              "max_concurrency",
              "max_retries",
              "max_wait_time_ms",
              "retry_delay",
              "visibility_timeout_ms",
            ].includes(k) ||
            (!(k === "max_concurrency" && v === null) && (!Number.isSafeInteger(v) || v < 0)),
        )
      )
        fail("Queue consumer snapshot is invalid");
      const { created_on: _created, script, ...stable } = consumer;
      void _created;
      // Queue GET and Wrangler use script; the generated API reference also names script_name.
      // Canonicalize aliases only when they identify the same Worker.
      return script === undefined ? stable : { ...stable, script_name: script };
    })
    .sort((a, b) => a.consumer_id.localeCompare(b.consumer_id));
  if (
    !isDeepStrictEqual(
      consumers.map((c) => c.consumer_id),
      sorted(target.consumerIds),
    )
  )
    fail("Queue consumers differ from the approved manifest");
  // delivery_paused is optional in Queue GET. The default/unpaused response omits it;
  // explicit non-boolean values remain invalid above. A resumed GET may omit false again.
  return {
    settings: { ...value.settings, delivery_paused: value.settings.delivery_paused ?? false },
    consumers,
  };
}
function cronConfiguration(snapshot) {
  return snapshot.map(({ cron }) => ({ cron }));
}
function desired(entry, action) {
  if (entry.kind === "worker") return action === "pause" ? [] : cronConfiguration(entry.original);
  return {
    ...entry.original,
    settings: {
      ...entry.original.settings,
      delivery_paused: action === "pause" ? true : entry.original.settings.delivery_paused,
    },
  };
}
function comparable(entry, current) {
  return entry.kind === "worker" ? cronConfiguration(current) : current;
}

/** All credentials enter from the process environment; provider response bodies never become errors. */
export function maintenanceCloudflareClient({
  accountId,
  environment = process.env,
  fetcher = fetch,
}) {
  if (
    !HEX.test(accountId) ||
    environment.CLOUDFLARE_ACCOUNT_ID !== accountId ||
    typeof environment.CLOUDFLARE_API_TOKEN !== "string" ||
    !environment.CLOUDFLARE_API_TOKEN.trim()
  )
    fail("Maintenance credentials or account scope are unavailable");
  const token = environment.CLOUDFLARE_API_TOKEN;
  return async (method, path, body) => {
    if (
      !(
        (method === "GET" && path === "") ||
        (["GET", "PUT"].includes(method) &&
          /^\/workers\/scripts\/[a-z0-9][a-z0-9_-]{0,62}\/schedules$/u.test(path)) ||
        (["GET", "PATCH"].includes(method) && /^\/queues\/[a-f0-9]{32}$/u.test(path))
      )
    )
      fail("Maintenance API operation is outside scope");
    let response, value;
    try {
      response = await fetcher(`${API}/accounts/${accountId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (Number(response.headers.get("content-length")) > 262144) fail("bounded");
      const text = await response.text();
      if (text.length > 262144) fail("bounded");
      value = JSON.parse(text);
    } catch {
      fail("Cloudflare maintenance request outcome is unavailable; journal retained");
    }
    if (!response.ok || value?.success !== true)
      fail(`Cloudflare maintenance request failed (${response.status}); journal retained`);
    return value.result;
  };
}
async function observe(client, entry) {
  if (entry.kind === "worker")
    return schedules(await client("GET", `/workers/scripts/${entry.target.scriptName}/schedules`));
  return queueSnapshot(await client("GET", `/queues/${entry.target.queueId}`), entry.target);
}
function validateJournal(journal, manifest, digest) {
  if (
    !exact(journal, [
      "schemaVersion",
      "manifestSha256",
      "cutoverId",
      "accountId",
      "phase",
      "entries",
    ]) ||
    journal.schemaVersion !== "omh.pgcf-maintenance-journal/v1" ||
    journal.manifestSha256 !== digest ||
    journal.cutoverId !== manifest.cutoverId ||
    journal.accountId !== manifest.accountId ||
    !["snapshotted", "pausing", "paused", "resuming", "resumed"].includes(journal.phase) ||
    !Array.isArray(journal.entries)
  )
    fail("Maintenance journal differs from the approved manifest");
  const targets = [
    ...manifest.workers.map((target) => ({ kind: "worker", target })),
    ...manifest.queues.map((target) => ({ kind: "queue", target })),
  ];
  if (targets.length !== journal.entries.length) fail("Maintenance journal target count differs");
  for (const [i, entry] of journal.entries.entries()) {
    if (
      !exact(entry, ["kind", "target", "original", "phase"]) ||
      !isDeepStrictEqual({ kind: entry.kind, target: entry.target }, targets[i]) ||
      !phases.includes(entry.phase)
    )
      fail("Maintenance journal entry is invalid");
    if (entry.kind === "worker") schedules({ schedules: entry.original });
    else
      queueSnapshot(
        {
          queue_id: entry.target.queueId,
          queue_name: entry.target.queueName,
          ...entry.original,
          consumers_total_count: entry.original?.consumers?.length,
        },
        entry.target,
      );
  }
}

/** Snapshot first; journal every attempt before mutation; reconcile by GET before any retry. */
export async function executeMaintenance({ action, manifest, manifestSha256, client, load, save }) {
  manifest = parseMaintenanceManifest(manifest);
  if (
    !["snapshot", "pause", "resume"].includes(action) ||
    !/^[a-f0-9]{64}$/u.test(manifestSha256 ?? "")
  )
    fail("Maintenance invocation is invalid");
  const account = await client("GET", "");
  if (account?.id !== manifest.accountId)
    fail("Cloudflare account readback differs from the manifest");
  let journal = await load();
  if (journal !== null) validateJournal(journal, manifest, manifestSha256);
  if (action === "snapshot") {
    if (journal !== null) return { phase: journal.phase, resources: journal.entries.length };
    const entries = [];
    for (const entry of [
      ...manifest.workers.map((target) => ({ kind: "worker", target })),
      ...manifest.queues.map((target) => ({ kind: "queue", target })),
    ])
      entries.push({ ...entry, original: await observe(client, entry), phase: "snapshotted" });
    journal = {
      schemaVersion: "omh.pgcf-maintenance-journal/v1",
      manifestSha256,
      cutoverId: manifest.cutoverId,
      accountId: manifest.accountId,
      phase: "snapshotted",
      entries,
    };
    await save(journal);
    return { phase: journal.phase, resources: entries.length };
  }
  if (journal === null) fail("Maintenance snapshot is required before changing delivery");
  if (action === "pause" && ["resuming", "resumed"].includes(journal.phase))
    fail("Resumed maintenance cannot be paused again");
  const completed = action === "pause" ? "paused" : "resumed";
  const finalReplay = journal.phase === completed;
  if (!finalReplay) {
    journal.phase = action === "pause" ? "pausing" : "resuming";
    await save(journal);
  }
  // Stop queue delivery before cron removal. Restore cron producers before queue consumers.
  const entries = action === "pause" ? [...journal.entries].reverse() : journal.entries;
  for (const entry of entries) {
    const current = comparable(entry, await observe(client, entry)),
      wanted = desired(entry, action),
      original = desired(entry, "resume"),
      paused = desired(entry, "pause");
    if (!isDeepStrictEqual(current, wanted)) {
      if (
        finalReplay ||
        entry.phase === completed ||
        (!isDeepStrictEqual(current, original) && !isDeepStrictEqual(current, paused))
      )
        fail("Maintenance target changed outside the saved operation");
      entry.phase = action === "pause" ? "pause_pending" : "resume_pending";
      await save(journal);
      if (entry.kind === "worker")
        await client("PUT", `/workers/scripts/${entry.target.scriptName}/schedules`, wanted);
      else await client("PATCH", `/queues/${entry.target.queueId}`, { settings: wanted.settings });
      if (!isDeepStrictEqual(comparable(entry, await observe(client, entry)), wanted))
        fail("Maintenance API readback has not converged; journal retained");
    }
    if (!finalReplay) {
      entry.phase = completed;
      await save(journal);
    }
  }
  if (!finalReplay) {
    journal.phase = completed;
    await save(journal);
  }
  return { phase: journal.phase, resources: journal.entries.length };
}

export async function readProtected(path, missing = false, raw = false) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1048576)
      fail("Maintenance file must be a private regular file");
    const text = await handle.readFile("utf8");
    return raw ? text : JSON.parse(text);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw new Error("Maintenance file cannot be read safely");
  } finally {
    await handle?.close();
  }
}
export async function writeProtected(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function runMaintenanceCli(argv, { environment = process.env, fetcher = fetch } = {}) {
  if (
    argv.length !== 7 ||
    !["snapshot", "pause", "resume"].includes(argv[0]) ||
    argv[1] !== "--manifest" ||
    argv[3] !== "--journal" ||
    argv[5] !== "--approval-sha256" ||
    !isAbsolute(argv[2]) ||
    !isAbsolute(argv[4]) ||
    resolve(argv[2]) === resolve(argv[4])
  )
    fail(
      "Usage: pgcf-maintenance snapshot|pause|resume --manifest PATH --journal PATH --approval-sha256 SHA256",
    );
  const [action, , manifestPath, , journalPath, , approval] = argv;
  // Read approved bytes without echoing their content; a changed manifest cannot reuse the journal.
  const bytes = await readProtected(manifestPath, false, true);
  const manifest = parseMaintenanceManifest(JSON.parse(bytes));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== approval) fail("Maintenance manifest does not match its approval digest");
  const lock = `${journalPath}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    fail("Maintenance journal is locked; reconcile the existing run first");
  }
  try {
    return await executeMaintenance({
      action,
      manifest,
      manifestSha256: digest,
      client: maintenanceCloudflareClient({ accountId: manifest.accountId, environment, fetcher }),
      load: () => readProtected(journalPath, true),
      save: (value) => writeProtected(journalPath, value),
    });
  } finally {
    await rmdir(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMaintenanceCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write(
        "PGCF maintenance did not complete; inspect the protected journal and reconcile before retrying.\n",
      );
      process.exitCode = 1;
    },
  );
}
