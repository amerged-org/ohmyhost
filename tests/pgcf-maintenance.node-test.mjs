/* global Response, structuredClone */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeMaintenance,
  maintenanceCloudflareClient,
  parseMaintenanceManifest,
  runMaintenanceCli,
} from "../scripts/pgcf-maintenance.mjs";

const accountId = "a".repeat(32),
  queueId = "b".repeat(32),
  consumerId = "c".repeat(32),
  alreadyPausedId = "d".repeat(32);
const token = "fixture-private-token-must-never-be-rendered";
const manifest = {
  schemaVersion: "omh.pgcf-maintenance/v1",
  cutoverId: "cutover-20261026",
  accountId,
  workers: [{ scriptName: "ohmyho-functions-production" }],
  queues: [
    { queueId, queueName: "ohmyho-operations-production", consumerIds: [consumerId] },
    { queueId: alreadyPausedId, queueName: "ohmyho-paused-production", consumerIds: [] },
  ],
};
const environment = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token };
function provider() {
  const originalSchedules = [
    { cron: "* * * * *", created_on: "2026-09-01T00:00:00Z", modified_on: "2026-09-01T00:00:00Z" },
  ];
  const queue = {
    queue_id: queueId,
    queue_name: manifest.queues[0].queueName,
    settings: { delivery_delay: 4, message_retention_period: 345600 },
    consumers_total_count: 1,
    consumers: [
      {
        consumer_id: consumerId,
        script: "ohmyho-consumer-production",
        type: "worker",
        settings: {
          batch_size: 10,
          max_concurrency: null,
          max_retries: 5,
          max_wait_time_ms: 1000,
          retry_delay: 60,
        },
      },
    ],
  };
  const queues = new Map([
    [queueId, structuredClone(queue)],
    [
      alreadyPausedId,
      {
        queue_id: alreadyPausedId,
        queue_name: manifest.queues[1].queueName,
        settings: { delivery_paused: true, message_retention_period: 604800 },
        consumers_total_count: 0,
        consumers: [],
      },
    ],
  ]);
  const state = {
    schedules: structuredClone(originalSchedules),
    queues,
    requests: [],
    mutations: [],
    drop: false,
    ignore: false,
    fail: false,
    wrongAccount: false,
  };
  state.fetcher = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error");
    assert.ok(String(url).startsWith(`https://api.cloudflare.com/client/v4/accounts/${accountId}`));
    const path = String(url).slice(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}`.length,
    );
    state.requests.push({ method: init.method, path });
    if (state.fail) throw new Error(`${token} private-provider-error`);
    let result;
    if (path === "") result = { id: state.wrongAccount ? "e".repeat(32) : accountId };
    else if (path === `/workers/scripts/${manifest.workers[0].scriptName}/schedules`) {
      if (init.method === "PUT") {
        const body = JSON.parse(init.body);
        state.mutations.push({ method: "PUT", body });
        if (!state.ignore) state.schedules = structuredClone(body);
      } else assert.equal(init.method, "GET");
      result = { schedules: state.schedules };
    } else {
      const queue = state.queues.get(path.slice("/queues/".length));
      assert.ok(queue);
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body), ["settings"]);
        state.mutations.push({ method: "PATCH", body });
        if (!state.ignore) queue.settings = body.settings;
      } else assert.equal(init.method, "GET");
      result = queue;
    }
    if (state.drop && ["PATCH", "PUT"].includes(init.method)) {
      state.drop = false;
      throw new Error(`${token} lost acknowledgement`);
    }
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  return state;
}

// One bounded operating scenario: no live provider or shared credentials are used.
test("maintenance preserves approved cron/consumer state, survives uncertain writes, and resumes once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-maintenance-test-"));
  try {
    const manifestPath = join(directory, "manifest.json"),
      journalPath = join(directory, "journal.json");
    const bytes = JSON.stringify(manifest),
      digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(manifestPath, bytes, { mode: 0o600 });
    const state = provider();
    const run = (action, overrides = {}) =>
      runMaintenanceCli(
        [action, "--manifest", manifestPath, "--journal", journalPath, "--approval-sha256", digest],
        { environment, fetcher: state.fetcher, ...overrides },
      );
    await t.test(
      "snapshot is private and contains exact cron settings and queue identities",
      async () => {
        await assert.rejects(run("pause"), /snapshot is required/);
        assert.equal(state.mutations.length, 0);
        assert.deepEqual(await run("snapshot"), { phase: "snapshotted", resources: 3 });
        const saved = JSON.parse(await readFile(journalPath, "utf8"));
        assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
        assert.equal(saved.entries[0].original[0].cron, "* * * * *");
        assert.deepEqual(saved.entries[1].original.settings, {
          delivery_paused: false,
          delivery_delay: 4,
          message_retention_period: 345600,
        });
        assert.equal(saved.entries[1].original.consumers[0].consumer_id, consumerId);
        assert.equal(
          saved.entries[1].original.consumers[0].script_name,
          "ohmyho-consumer-production",
        );
        assert.equal(JSON.stringify(saved).includes(token), false);
      },
    );
    await t.test(
      "an applied write with a lost response is observed rather than replayed",
      async () => {
        state.drop = true;
        await assert.rejects(
          run("pause"),
          (error) => !String(error).includes(token) && /outcome is unavailable/.test(String(error)),
        );
        const saved = JSON.parse(await readFile(journalPath, "utf8"));
        assert.equal(saved.phase, "pausing");
        assert.equal(saved.entries[1].phase, "pause_pending");
        assert.equal(state.queues.get(queueId).settings.delivery_paused, true);
        assert.deepEqual(await run("pause"), { phase: "paused", resources: 3 });
        assert.equal(state.mutations.filter((item) => item.method === "PATCH").length, 1);
        assert.deepEqual(state.schedules, []);
        const count = state.mutations.length;
        await run("pause");
        assert.equal(state.mutations.length, count);
      },
    );
    await t.test(
      "unexpected changes are not overwritten; exact originals restore once",
      async () => {
        state.schedules = [{ cron: "*/5 * * * *" }];
        const count = state.mutations.length;
        await assert.rejects(run("resume"), /changed outside/);
        assert.equal(state.mutations.length, count);
        state.schedules = [];
        assert.deepEqual(await run("resume"), { phase: "resumed", resources: 3 });
        assert.deepEqual(state.schedules, [{ cron: "* * * * *" }]);
        assert.deepEqual(state.queues.get(queueId).settings, {
          delivery_paused: false,
          delivery_delay: 4,
          message_retention_period: 345600,
        });
        assert.equal(state.queues.get(alreadyPausedId).settings.delivery_paused, true);
        assert.equal(state.mutations.filter((item) => item.method === "PATCH").length, 2);
        const final = state.mutations.length;
        await run("resume");
        assert.equal(state.mutations.length, final);
        await assert.rejects(run("pause"), /cannot be paused again/);
      },
    );
    await t.test(
      "scope, file, credentials and account mismatches fail before mutation",
      async () => {
        assert.throws(
          () =>
            parseMaintenanceManifest({
              ...manifest,
              queues: [{ ...manifest.queues[0], queueId: "../foreign" }],
            }),
          /identity/,
        );
        const requests = state.requests.length;
        await assert.rejects(
          run("resume", { environment: { ...environment, CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) } }),
          /account scope/,
        );
        assert.equal(state.requests.length, requests);
        await mkdir(`${journalPath}.lock`);
        await assert.rejects(run("resume"), /locked/);
        await rm(`${journalPath}.lock`, { recursive: true });
        await chmod(journalPath, 0o644);
        await assert.rejects(run("resume"), /cannot be read safely/);
        await chmod(journalPath, 0o600);
        const symlinkPath = join(directory, "linked.json");
        await symlink(manifestPath, symlinkPath);
        await assert.rejects(
          runMaintenanceCli(
            [
              "snapshot",
              "--manifest",
              symlinkPath,
              "--journal",
              journalPath,
              "--approval-sha256",
              digest,
            ],
            { environment, fetcher: state.fetcher },
          ),
          /cannot be read safely/,
        );
        state.wrongAccount = true;
        await assert.rejects(run("resume"), /account readback/);
        state.wrongAccount = false;
        const client = maintenanceCloudflareClient({
          accountId,
          environment,
          fetcher: state.fetcher,
        });
        await assert.rejects(client("DELETE", `/queues/${queueId}`), /outside scope/);
        await assert.rejects(client("PATCH", `/queues/${queueId}/purge`, {}), /outside scope/);
      },
    );
    await t.test(
      "readback failure, consumer drift and a changed approval preserve the journal",
      async () => {
        const isolated = provider();
        let saved = null;
        const execute = (action, overrides = {}) =>
          executeMaintenance({
            action,
            manifest,
            manifestSha256: digest,
            client: maintenanceCloudflareClient({
              accountId,
              environment,
              fetcher: isolated.fetcher,
            }),
            load: async () => structuredClone(saved),
            save: async (value) => {
              saved = structuredClone(value);
            },
            ...overrides,
          });
        isolated.queues.get(queueId).consumers[0].consumer_id = "e".repeat(32);
        await assert.rejects(execute("snapshot"), /consumers differ/);
        assert.equal(saved, null);
        isolated.queues.get(queueId).consumers[0].consumer_id = consumerId;
        isolated.queues.get(queueId).settings.delivery_paused = "false";
        await assert.rejects(execute("snapshot"), /snapshot is incomplete/);
        assert.equal(saved, null);
        isolated.queues.get(queueId).settings.delivery_paused = null;
        await assert.rejects(execute("snapshot"), /snapshot is incomplete/);
        assert.equal(saved, null);
        delete isolated.queues.get(queueId).settings.delivery_paused;
        isolated.queues.get(queueId).consumers[0].script_name = "conflicting-worker";
        await assert.rejects(execute("snapshot"), /consumer snapshot is invalid/);
        assert.equal(saved, null);
        delete isolated.queues.get(queueId).consumers[0].script_name;
        await execute("snapshot");
        isolated.ignore = true;
        await assert.rejects(execute("pause"), /readback has not converged/);
        assert.equal(saved.entries[1].phase, "pause_pending");
        isolated.ignore = false;
        await execute("pause");
        await assert.rejects(
          execute("resume", { manifestSha256: "f".repeat(64) }),
          /differs from the approved/,
        );
        assert.equal(saved.phase, "paused");
        isolated.fail = true;
        await assert.rejects(
          execute("resume"),
          (error) => !String(error).includes(token) && /outcome is unavailable/.test(String(error)),
        );
        assert.ok(
          isolated.requests.every((request) => !["DELETE", "POST"].includes(request.method)),
        );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
