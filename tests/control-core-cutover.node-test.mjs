/* global Response, URL, structuredClone */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  controlCoreWriters,
  declaredCrons,
  parseCutoverArguments,
  runCutover,
} from "../scripts/control-core-cutover.mjs";

const accountId = "a".repeat(32);
const token = "fixture-token-must-never-be-rendered";
const env = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token };
const VARIABLE = "OMH_DATABASE_CUTOVER_MAINTENANCE";
const origin = "https://control.example.test";
const CREDIT_SERVICE = "ohmyho-credit-service-poc-private-fullstack";
const repositoryRoot = new URL("..", import.meta.url).pathname;
// The credit-service app is built by its own lane; its writer expectations apply once its configurations are checked in.
const CREDIT_SERVICE_PRESENT = existsSync(
  join(repositoryRoot, "apps/credit-service/wrangler.development.jsonc"),
);

/** The Cloudflare API of one environment, in memory. Real tool logic runs against it; only the HTTP transport is fake. */
function provider(scope) {
  let time = Date.parse("2026-10-29T12:00:00.000Z");
  const hex = (n) => String(n).padStart(32, "0");
  const state = {
    workers: Object.fromEntries(
      scope.writers.map((name) => [
        name,
        {
          crons: name.includes("neon-management")
            ? []
            : name === CREDIT_SERVICE
              ? ["0 0 * * *", "27,57 * * * *"]
              : ["* * * * *", "17 * * * *"],
        },
      ]),
    ),
    public: Object.fromEntries(
      scope.publicWriters.map((name, index) => [
        name,
        {
          version: `v${index}-0`,
          bindings: [
            { type: "secret_text", name: "CONTROL_DATABASE_URL" },
            {
              type: "service",
              name: "CORE",
              service: "core",
              entrypoint: "X",
              environment: "production",
            },
            { type: "plain_text", name: "CONTROL_API_PUBLIC_ORIGIN", text: origin },
            ...(index === 0 ? [{ type: "plain_text", name: VARIABLE, text: "off" }] : []),
          ],
        },
      ]),
    ),
    queues: scope.queues.map((name, index) => ({
      id: hex(index + 1),
      name,
      settings: {
        delivery_delay: 0,
        delivery_paused: index === 1,
        message_retention_period: 86400,
      },
      consumers: [
        {
          consumer_id: `c${index}`,
          type: "worker",
          script: scope.writers[index],
          dead_letter_queue: "dlq",
          settings: { batch_size: 10, max_retries: 3 },
        },
      ],
      metricsReads: 0,
    })),
    inFlightUntilRead: 0,
    running: 0,
    sleeping: 2,
    losePut: null,
    requests: [],
  };
  const reply = (result, info) =>
    new Response(
      JSON.stringify({ success: true, result, ...(info ? { result_info: info } : {}) }),
      {
        status: 200,
      },
    );
  const missing = () =>
    new Response(JSON.stringify({ success: false, errors: [] }), { status: 404 });
  state.fetcher = async (input, init) => {
    const url = new URL(input);
    if (url.origin === origin) {
      const writer = state.public[scope.publicWriters[0]];
      const on = writer.bindings.some((b) => b.name === VARIABLE && b.text === "on");
      return new Response(on ? "Temporarily unavailable" : "ok", {
        status: on ? 503 : 200,
        headers: on ? { "retry-after": "60" } : {},
      });
    }
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    const path = url.pathname.slice(`/client/v4/accounts/${accountId}`.length);
    state.requests.push(`${init.method} ${path}`);
    if (path === "") return reply({ id: accountId });
    let match = /^\/workers\/scripts\/([^/]+)\/schedules$/u.exec(path);
    if (match) {
      const worker = state.workers[match[1]];
      if (!worker) return missing();
      if (init.method === "PUT") {
        worker.crons = JSON.parse(init.body).map(({ cron }) => cron);
        if (state.losePut === match[1]) {
          state.losePut = null;
          throw new Error(`${token} lost acknowledgement`);
        }
      }
      return reply({ schedules: worker.crons.map((cron) => ({ cron, created_on: "x" })) });
    }
    match = /^\/workers\/scripts\/([^/]+)\/(settings|deployments)$/u.exec(path);
    if (match) {
      const writer = state.public[match[1]];
      if (match[2] === "deployments")
        return reply({
          deployments: [{ versions: [{ version_id: writer.version, percentage: 100 }] }],
        });
      if (init.method === "PATCH") {
        // Settings replace the binding list; a secret listed without its text keeps its value.
        writer.bindings = JSON.parse(await init.body.get("settings").text()).bindings;
        writer.version = `${writer.version.split("-")[0]}-${Number(writer.version.split("-")[1]) + 1}`;
      }
      return reply({ bindings: structuredClone(writer.bindings) });
    }
    if (path === "/queues")
      return reply(
        state.queues.map((q) => ({ queue_id: q.id, queue_name: q.name })),
        { page: 1 },
      );
    match = /^\/queues\/([a-f0-9]{32})(\/metrics)?$/u.exec(path);
    if (match) {
      const queue = state.queues.find((q) => q.id === match[1]);
      if (match[2]) {
        queue.metricsReads += 1;
        const held = queue.metricsReads <= state.inFlightUntilRead;
        return reply({
          backlog_count: held ? 2 : 0,
          oldest_message_timestamp_ms: held ? time - 60_000 : 0,
        });
      }
      if (init.method === "PATCH") queue.settings = JSON.parse(init.body).settings;
      return reply({
        queue_id: queue.id,
        queue_name: queue.name,
        settings: queue.settings,
        consumers: queue.consumers,
      });
    }
    match = /^\/workflows\/([^/]+)\/instances$/u.exec(path);
    if (match) {
      const status = url.searchParams.get("status");
      return reply([], {
        total_count:
          status === "running" ? state.running : status === "waiting" ? state.sleeping : 0,
      });
    }
    throw new Error(`unexpected request ${init.method} ${path}`);
  };
  state.sleep = async (ms) => {
    time += ms;
  };
  state.clock = () => new Date(time);
  return state;
}

test("the technical write stop snapshots, stops, drains and restores exactly", async (t) => {
  const scope = await controlCoreWriters({ repositoryRoot, environment: "development" });
  await t.test("the writers come from the checked-in profiles", async () => {
    for (const name of [
      "ohmyho-control-api-poc-private-fullstack",
      "ohmyho-billing-poc-private-fullstack",
      ...(CREDIT_SERVICE_PRESENT ? [CREDIT_SERVICE] : []),
      "ohmyhost-workos-management-poc-private-fullstack",
      "ohmyho-project-provisioning-consumer-poc-private-fullstack",
      "ohmyho-live-preview-poc-private-fullstack",
      "ohmyho-project-database-development-eu",
    ])
      assert.ok(scope.writers.includes(name), name);
    for (const name of [
      "ohmyho-build-runner-poc-private-fullstack",
      "ohmyho-source-fetcher-poc-private-fullstack",
      "ohmyho-control-store-poc-private-fullstack",
      "ohmyho-project-database-development-us",
    ])
      assert.ok(!scope.writers.includes(name), name);
    assert.equal(new Set(scope.writers).size, scope.writers.length);
    const production = await controlCoreWriters({ repositoryRoot, environment: "production" });
    for (const name of [
      "ohmyho-source-fetcher-production",
      "ohmyho-project-database-production-us",
      "ohmyho-project-database-production-eu",
    ])
      assert.ok(!production.writers.includes(name), name);
    assert.ok(production.writers.includes("ohmyho-live-preview-production"));
    assert.deepEqual(scope.publicWriters, [
      "ohmyho-connection-broker-development",
      "ohmyho-control-api-poc-private-fullstack",
      "ohmyho-gateway-poc-private-fullstack",
    ]);
    assert.deepEqual(scope.queues, [
      "ohmyho-diagnostics-poc-private-fullstack",
      "ohmyho-growth-development",
      "ohmyho-growth-development-dlq",
      "ohmyho-project-provisioning-poc-private-fullstack",
    ]);
    assert.equal(new Set(production.writers).size, production.writers.length);
    assert.ok(production.publicWriters.includes("ohmyho-connection-broker-production"));
    assert.ok(
      Object.hasOwn(
        await declaredCrons({ repositoryRoot, environment: "production" }),
        "ohmyho-connection-broker-production",
      ),
    );
    assert.equal(scope.workflows.length, 3);
    assert.throws(() => parseCutoverArguments(["stop", "--environment"]), /CUTOVER_USAGE/u);
  });

  const custody = await mkdtemp(join(tmpdir(), "control-core-cutover-"));
  await chmod(custody, 0o700);
  try {
    const world = provider(scope);
    const original = structuredClone({
      workers: world.workers,
      queues: world.queues.map((q) => q.settings),
      bindings: Object.values(world.public).map((w) => w.bindings),
    });
    const run = (command, extra = {}, environment = "development") =>
      runCutover(
        { command, environment, custody, settleSeconds: 20, drainTimeoutSeconds: 120, ...extra },
        { repositoryRoot, env, fetcher: world.fetcher, sleep: world.sleep, clock: world.clock },
      );

    await t.test("production needs its own confirmation before any provider call", async () => {
      await assert.rejects(run("snapshot", {}, "production"), /CUTOVER_USAGE/u);
      await assert.rejects(run("stop", { confirm: "development" }, "production"), /CUTOVER_USAGE/u);
      assert.equal(world.requests.length, 0);
    });

    await t.test(
      "stop needs a snapshot; the snapshot is a private non-secret journal",
      async () => {
        await assert.rejects(run("stop"), /CUTOVER_SNAPSHOT_REQUIRED/u);
        const receipt = await run("snapshot");
        assert.equal(receipt.phase, "snapshotted");
        assert.equal(receipt.withCrons, scope.writers.length - 1);
        assert.deepEqual(Object.values(receipt.maintenance).sort(), [null, null, "off"]);
        const path = join(custody, "control-core-cutover-development.json");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const text = await readFile(path, "utf8");
        assert.ok(!text.includes(token) && !text.includes("CONTROL_DATABASE_URL"));
        assert.ok(text.includes(origin));
        // The credit-service's hourly usage run and daily log rotation are journaled to be stopped and restored.
        if (CREDIT_SERVICE_PRESENT)
          assert.deepEqual(JSON.parse(text).snapshot.workers[CREDIT_SERVICE].crons, [
            "0 0 * * *",
            "27,57 * * * *",
          ]);
      },
    );

    await t.test(
      "a lost acknowledgement leaves a retained journal that the rerun reconciles",
      async () => {
        world.losePut = "ohmyho-r2-management-poc-private-fullstack";
        world.inFlightUntilRead = 3;
        await assert.rejects(run("stop"), /CUTOVER_API_UNAVAILABLE/u);
        assert.equal(
          JSON.parse(await readFile(join(custody, "control-core-cutover-development.json"), "utf8"))
            .phase,
          "stopping",
        );
        const receipt = await run("stop");
        assert.equal(receipt.phase, "stopped");
        assert.equal(receipt.cronsRemoved, scope.writers.length - 1);
        assert.deepEqual(
          receipt.probes.map(({ status, retryAfter }) => [status, retryAfter]),
          [[503, "60"]],
        );
        // The in-flight backlog was awaited: the rerun polled until the older messages were gone.
        assert.ok(receipt.timings.drainMs >= 10_000, "the drain waited for the held backlog");
        assert.deepEqual(
          receipt.workflows.map(({ active }) => active),
          [0, 0, 0],
        );
        assert.equal(receipt.workflows[0].sleeping, 2);
        assert.ok(Object.values(world.workers).every((w) => w.crons.length === 0));
        if (CREDIT_SERVICE_PRESENT) assert.equal(world.workers[CREDIT_SERVICE].crons.length, 0);
        assert.ok(world.queues.every((q) => q.settings.delivery_paused));
        for (const writer of Object.values(world.public)) {
          assert.ok(writer.bindings.some((b) => b.name === VARIABLE && b.text === "on"));
          // The PATCH kept every other binding, and a secret still has no value in the binding list.
          assert.ok(writer.bindings.some((b) => b.type === "secret_text" && b.text === undefined));
          assert.equal(writer.bindings.filter((b) => b.name === VARIABLE).length, 1);
        }
        await assert.rejects(run("stop"), /CUTOVER_STOP_ALREADY_DONE/u);
        const status = await run("status");
        assert.equal(status.matchesSnapshot, false);
        assert.deepEqual(status.cronsRemaining, []);
      },
    );

    await t.test(
      "a stop that does not drain is refused, retained and can always be undone",
      async () => {
        const stuckWorld = provider(scope);
        stuckWorld.inFlightUntilRead = 1_000;
        const stuckCustody = await mkdtemp(join(tmpdir(), "control-core-cutover-stuck-"));
        await chmod(stuckCustody, 0o700);
        const stuck = (command) =>
          runCutover(
            {
              command,
              environment: "development",
              custody: stuckCustody,
              drainTimeoutSeconds: 30,
              settleSeconds: 0,
            },
            {
              repositoryRoot,
              env,
              fetcher: stuckWorld.fetcher,
              sleep: stuckWorld.sleep,
              clock: stuckWorld.clock,
            },
          );
        try {
          await stuck("snapshot");
          await assert.rejects(stuck("stop"), /CUTOVER_NOT_DRAINED/u);
          assert.equal((await stuck("status")).phase, "stopping");
          assert.deepEqual((await stuck("resume")).diff, []);
          assert.ok(Object.values(stuckWorld.workers).some((w) => w.crons.length > 0));
        } finally {
          await rm(stuckCustody, { recursive: true, force: true });
        }
      },
    );

    await t.test("resume restores the snapshot exactly, ingress last", async () => {
      const receipt = await run("resume");
      assert.equal(receipt.phase, "resumed");
      assert.deepEqual(receipt.diff, []);
      assert.deepEqual(
        receipt.probes.map(({ status }) => status),
        [200],
      );
      assert.deepEqual(world.workers, original.workers);
      if (CREDIT_SERVICE_PRESENT)
        assert.deepEqual(world.workers[CREDIT_SERVICE].crons, ["0 0 * * *", "27,57 * * * *"]);
      assert.deepEqual(
        world.queues.map((q) => q.settings),
        original.queues,
      );
      // The variable is removed again where it did not exist and restored to "off" where it did.
      assert.deepEqual(
        Object.values(world.public).map((w) => w.bindings),
        original.bindings,
      );
      const status = await run("status");
      assert.equal(status.matchesSnapshot, true);
      assert.deepEqual(status.diff, []);
      await assert.rejects(run("resume"), /CUTOVER_RESUME_ALREADY_DONE/u);
    });

    await t.test(
      "a release that replaced a public writer during the stop is accepted at resume",
      async () => {
        await run("snapshot");
        await run("stop", { settleSeconds: 0 });
        // The train redeploys the public writer: a new version without the maintenance variable.
        const writer = world.public[scope.publicWriters[0]];
        writer.bindings = writer.bindings.filter((b) => b.name !== VARIABLE && b.name !== "CORE");
        writer.version = "released";
        const receipt = await run("resume");
        assert.deepEqual(receipt.releasedSinceStop, [scope.publicWriters[0]]);
        assert.deepEqual(receipt.diff, []);
        assert.deepEqual(world.workers, original.workers);
      },
    );
  } finally {
    await rm(custody, { recursive: true, force: true });
  }
});

test("a Worker the train creates after the snapshot is accepted with exactly its declared schedules, and no other difference is", async () => {
  const scope = await controlCoreWriters({ repositoryRoot, environment: "development" });
  const R2 = "ohmyho-r2-management-poc-private-fullstack";
  const NEON = "ohmyho-neon-management-poc-private-fullstack";
  const METERING = "ohmyho-metering-poc-private-fullstack";
  // The Metering Workers are no writers: a stale schedule of one is never read, compared or restored.
  assert.ok(scope.writers.includes(CREDIT_SERVICE) && scope.writers.includes(R2));
  assert.ok(scope.writers.every((name) => !name.includes("metering")));
  const declared = await declaredCrons({ repositoryRoot, environment: "development" });
  assert.deepEqual(declared[CREDIT_SERVICE], ["0 0 * * *", "27,57 * * * *"]);
  assert.deepEqual(declared[R2], []);

  const directories = [];
  const rollout = async (arrange) => {
    const world = provider(scope);
    // The state before the rollout: the credit service does not exist yet, r2-management still has its retired hourly
    // schedule (the checked-in profile no longer declares one) and a Metering Worker would still carry its own.
    Reflect.deleteProperty(world.workers, CREDIT_SERVICE);
    world.workers[R2] = { crons: ["15 * * * *"] };
    world.workers[METERING] = { crons: ["* * * * *"] };
    arrange?.(world);
    const custody = await mkdtemp(join(tmpdir(), "control-core-cutover-created-"));
    directories.push(custody);
    await chmod(custody, 0o700);
    const run = (command, extra = {}) =>
      runCutover(
        { command, environment: "development", custody, settleSeconds: 0, ...extra },
        { repositoryRoot, env, fetcher: world.fetcher, sleep: world.sleep, clock: world.clock },
      );
    return { world, run, journal: join(custody, "control-core-cutover-development.json") };
  };
  /** What the release train leaves behind: the credit service created with its profile's schedules. */
  const created = (crons = ["27,57 * * * *", "0 0 * * *"]) => {
    return (world) => (world.workers[CREDIT_SERVICE] = { crons });
  };
  const detailOf = async (promise) => {
    const error = await promise.then(
      () => assert.fail("expected a refusal"),
      (reason) => reason,
    );
    return [error.message, error.detail];
  };

  try {
    const stable = await rollout();
    await stable.run("snapshot");
    assert.deepEqual(
      JSON.parse(await readFile(stable.journal, "utf8")).snapshot.workers[CREDIT_SERVICE],
      {
        absent: true,
      },
    );
    await stable.run("stop");
    created()(stable.world);
    // Before the resume the stopped writers differ, but the new Worker is not among the differences.
    const midway = await stable.run("status");
    assert.ok(midway.diff.length > 0);
    assert.ok(midway.diff.every((path) => !path.includes(CREDIT_SERVICE)));
    assert.deepEqual(midway.createdSinceSnapshot, [CREDIT_SERVICE]);
    const receipt = await stable.run("resume");
    assert.deepEqual(receipt.diff, []);
    assert.deepEqual(receipt.createdSinceStop, [CREDIT_SERVICE]);
    // The stale hourly schedule of r2-management is the snapshot's and is restored; removing it is the later runbook step.
    assert.deepEqual(stable.world.workers[R2].crons, ["15 * * * *"]);
    assert.deepEqual(stable.world.workers[CREDIT_SERVICE].crons, ["27,57 * * * *", "0 0 * * *"]);
    assert.deepEqual(stable.world.workers[METERING].crons, ["* * * * *"]);
    assert.ok(stable.world.requests.every((request) => !request.includes("metering")));
    const after = await stable.run("status");
    assert.deepEqual([after.diff, after.matchesSnapshot], [[], true]);

    // Not created (an aborted train) is not a difference either.
    const aborted = await rollout();
    await aborted.run("snapshot");
    await aborted.run("stop");
    const rolledBack = await aborted.run("resume");
    assert.deepEqual([rolledBack.diff, rolledBack.createdSinceStop], [[], []]);

    // Every other difference still stops the resume and names its path.
    for (const [label, schedules] of [
      ["no schedule", []],
      ["one of two", ["27,57 * * * *"]],
      ["an undeclared schedule", ["27,57 * * * *", "0 0 * * *", "* * * * *"]],
    ]) {
      const other = await rollout();
      await other.run("snapshot");
      await other.run("stop");
      created(schedules)(other.world);
      assert.deepEqual(
        await detailOf(other.run("resume")),
        [
          "CUTOVER_RESUME_DIFF",
          [`workers.${CREDIT_SERVICE}.absent`, `workers.${CREDIT_SERVICE}.crons`],
        ],
        label,
      );
      assert.equal(JSON.parse(await readFile(other.journal, "utf8")).phase, "resuming");
    }
    // A Worker that existed at the snapshot and is gone, or changed, at the resume is no creation.
    const lost = await rollout();
    await lost.run("snapshot");
    await lost.run("stop");
    created()(lost.world);
    Reflect.deleteProperty(lost.world.workers, NEON);
    const [code, detail] = await detailOf(lost.run("resume"));
    assert.equal(code, "CUTOVER_RESUME_DIFF");
    assert.ok(detail.includes(`workers.${NEON}.absent`));
    // A Worker that appears between snapshot and stop is drift, not a creation by the train.
    const early = await rollout();
    await early.run("snapshot");
    created()(early.world);
    assert.equal((await detailOf(early.run("stop")))[0], "CUTOVER_SNAPSHOT_DRIFT");
  } finally {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  }
});
