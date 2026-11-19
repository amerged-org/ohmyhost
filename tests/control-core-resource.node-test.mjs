import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import {
  controlCoreDatabaseName,
  prepareControlCoreDeployment,
} from "../scripts/prepare-control-core-deployment.mjs";
import { controlCoreWorkerConfiguration } from "../scripts/control-core-worker-profile.mjs";
import {
  controlCoreCloudflareClient,
  ensureControlCoreResource,
  assertControlCoreResource,
} from "../scripts/control-core-resource.mjs";

const accountId = "a".repeat(32),
  creationId = "12345678-1234-4234-8234-123456789abc";
const databaseId = "22222222-2222-4222-8222-222222222222";
test("the two fixed EU resources reuse exact private Core profiles without widening resource identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omh-core-fixed-us-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url)),
    sourceCommit = "b".repeat(40);
  for (const environment of ["development", "production"]) {
    const database = {
      uuid: databaseId,
      name: `ohmyho-control-core-${environment}`,
      jurisdiction: "eu",
      read_replication: { mode: "disabled" },
    };
    assert.equal(
      assertControlCoreResource(database, { environment, creationId, databaseId }),
      database,
    );
    const { configuration } = await controlCoreWorkerConfiguration({
      repositoryRoot,
      sourceCommit,
      environment,
      accountId,
      databaseId,
      databaseName: database.name,
    });
    assert.equal(configuration.d1_databases[0].database_id, databaseId);
    assert.equal(configuration.d1_databases[0].database_name, database.name);
    const prepared = await prepareControlCoreDeployment(
      {
        accountId,
        creationId,
        environment,
        output: join(root, environment),
        repositoryRoot,
        resourceObservation: { accountId, observedAt: "2026-10-29T10:00:00.000Z", database },
      },
      { inspect: async () => ({ repositoryRoot, sha: sourceCommit }) },
    );
    assert.deepEqual(prepared.configuration, configuration);
    for (const changed of [
      { uuid: "33333333-3333-4333-8333-333333333333" },
      { jurisdiction: "us" },
      { name: `ohmyho-control-core-${environment}-foreign` },
      { read_replication: { mode: "auto" } },
    ])
      assert.throws(
        () =>
          assertControlCoreResource(
            { ...database, ...changed },
            { environment, creationId, databaseId },
          ),
        /UNVERIFIED/u,
      );
  }
});
async function rig(t) {
  const root = await mkdtemp(join(tmpdir(), "omh-core-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    operator = join(root, "operator");
  await mkdir(source, { mode: 0o700 });
  await mkdir(operator, { mode: 0o700 });
  const input = {
    accountId,
    creationId,
    environment: "development",
    repositoryRoot: source,
    output: join(operator, `${accountId}-${controlCoreDatabaseName("development", creationId)}`),
  };
  const inspect = async () => ({ repositoryRoot: source, sha: "b".repeat(40) });
  const database = {
    uuid: databaseId,
    name: controlCoreDatabaseName(input.environment, creationId),
    jurisdiction: "eu",
    read_replication: { mode: "disabled" },
  };
  return { input, inspect, database };
}
test("one persisted creation dispatch survives a lost reply; repeat observes the exact original resource and never creates again", async (t) => {
  const { input, inspect, database } = await rig(t);
  let created = false,
    posts = 0;
  const request = async ({ method, path, body }) => {
    if (method === "POST") {
      posts += 1;
      assert.deepEqual(body, {
        name: database.name,
        jurisdiction: "eu",
        read_replication: { mode: "disabled" },
      });
      assert.equal(
        JSON.parse(await readFile(join(input.output, "create-dispatched.json"), "utf8")).creationId,
        creationId,
      );
      created = true;
      throw new Error("lost provider response");
    }
    return { success: true, result: path.includes("?") ? (created ? [database] : []) : database };
  };
  await assert.rejects(
    ensureControlCoreResource(input, { request, inspect }),
    /lost provider response/u,
  );
  const recovered = await ensureControlCoreResource(input, { request, inspect });
  assert.equal(recovered.state, "resource-observed");
  assert.equal(recovered.observation.database.uuid, databaseId);
  assert.equal(
    (await ensureControlCoreResource(input, { request, inspect })).state,
    "resource-observed",
  );
  assert.equal(posts, 1);
  for (const name of ["resource-intent.json", "create-dispatched.json", "resource-receipt.json"])
    assert.equal((await stat(join(input.output, name))).mode & 0o077, 0);
});
test("unobserved dispatch stays unknown and concurrent callers cannot send a second creation", async (t) => {
  const { input, inspect, database } = await rig(t);
  let posts = 0;
  const request = async ({ method }) => {
    if (method === "POST") {
      posts += 1;
      throw new Error("uncertain");
    }
    return { success: true, result: [] };
  };
  const outcomes = await Promise.allSettled([
    ensureControlCoreResource(input, { request, inspect }),
    ensureControlCoreResource(input, { request, inspect }),
  ]);
  assert.equal(posts, 1);
  const winner = outcomes.filter(
    (x) => x.status === "rejected" && x.reason?.message === "uncertain",
  );
  assert.equal(winner.length, 1);
  const loser = outcomes.find((x) => x !== winner[0]);
  assert.ok(loser);
  if (loser.status === "fulfilled") assert.equal(loser.value.state, "outcome-unknown");
  else {
    assert.ok(loser.reason instanceof SyntaxError);
    assert.match(loser.reason.stack, /at JSON\.parse/u);
    assert.match(loser.reason.stack, /at existingJson/u);
  }
  assert.equal(
    (await ensureControlCoreResource(input, { request, inspect })).state,
    "outcome-unknown",
  );
  assert.equal(posts, 1);
  await assert.rejects(
    ensureControlCoreResource({ ...input, environment: "production" }, { request, inspect }),
    /UNVERIFIED/u,
  );
  const badReplica = { ...database, read_replication: { mode: "auto" } };
  await assert.rejects(
    ensureControlCoreResource(input, {
      inspect,
      request: async ({ path }) => ({
        success: true,
        result: path.includes("?") ? [badReplica] : badReplica,
      }),
    }),
    /UNVERIFIED/u,
  );
});
test("a successful creation is independently observed and an unrelated existing name has no creation custody", async (t) => {
  const { input, inspect, database } = await rig(t);
  let exists = false;
  const request = async ({ method, path }) => {
    if (method === "POST") {
      exists = true;
      return { success: true, result: database };
    }
    return { success: true, result: path.includes("?") ? (exists ? [database] : []) : database };
  };
  assert.equal(
    (await ensureControlCoreResource(input, { request, inspect })).state,
    "resource-observed",
  );
  await assert.rejects(
    ensureControlCoreResource(
      { ...input, output: join(input.output, "..", "foreign") },
      { request, inspect },
    ),
    /UNVERIFIED/u,
  );
});
test("the real operator HTTP client uses fixed Cloudflare origin, one request, no redirects or credential-bearing errors", async () => {
  let calls = 0;
  const client = controlCoreCloudflareClient({
    token: "operator-test-token",
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, "Bearer operator-test-token");
      return { ok: true, json: async () => ({ success: true, result: [] }) };
    },
  });
  assert.deepEqual(await client({ method: "GET", path: `/accounts/${accountId}/d1/database` }), {
    success: true,
    result: [],
  });
  await assert.rejects(client({ method: "GET", path: "/other" }), /UNVERIFIED/u);
  assert.equal(calls, 1);
  const denied = controlCoreCloudflareClient({
    token: "operator-test-token",
    fetch: async () => ({
      ok: false,
      json: async () => ({ success: false, errors: ["operator-test-token"] }),
    }),
  });
  await assert.rejects(denied({ method: "GET", path: `/accounts/${accountId}/d1/database` }), {
    message: "CONTROL_CORE_PROVIDER_UNAVAILABLE",
  });
  assert.throws(() => controlCoreCloudflareClient({ token: "" }), /CREDENTIAL_REQUIRED/u);
});
