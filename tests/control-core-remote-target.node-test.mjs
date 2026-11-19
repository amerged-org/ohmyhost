import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { controlCoreWorkerConfiguration } from "../scripts/control-core-worker-profile.mjs";
import { controlCoreDatabaseName } from "../scripts/prepare-control-core-deployment.mjs";
import { initializeUnservedTargetSchema } from "../scripts/control-d1-target.mjs";
import {
  openRemoteControlCoreTarget,
  controlCorePlatformProxy,
} from "../scripts/control-core-remote-target.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const accountId = "a".repeat(32),
  creationId = "12345678-1234-4234-8234-123456789abc";
const databaseId = "22222222-2222-4222-8222-222222222222";
test("actual locked Wrangler API constructs bindings without executing the declared Worker program (offline API qualification)", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "omh-core-wrangler-api-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const main = join(parent, "must-not-execute.mjs"),
    configPath = join(parent, "wrangler.jsonc");
  await writeFile(main, "throw new Error('Worker program must not execute');\n");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "core-api-offline-proof",
      main,
      compatibility_date: "2026-08-24",
      d1_databases: [
        { binding: "CONTROL_CORE", database_name: "offline-proof", database_id: databaseId },
      ],
    }),
  );
  const proxy = await controlCorePlatformProxy(repositoryRoot, {
    configPath,
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  t.after(() => proxy.dispose());
  await proxy.env.CONTROL_CORE.prepare("CREATE TABLE dependency_proof(value TEXT)").run();
  await proxy.env.CONTROL_CORE.prepare(
    "INSERT INTO dependency_proof VALUES('native D1 binding')",
  ).run();
  assert.deepEqual(await proxy.env.CONTROL_CORE.prepare("SELECT * FROM dependency_proof").first(), {
    value: "native D1 binding",
  });
});
async function rig(t) {
  const parent = await mkdtemp(join(tmpdir(), "omh-core-remote-proof-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const database = {
    uuid: databaseId,
    name: controlCoreDatabaseName("development", creationId),
    jurisdiction: "eu",
    read_replication: { mode: "disabled" },
  };
  const { configuration } = await controlCoreWorkerConfiguration({
    repositoryRoot,
    sourceCommit,
    environment: "development",
    accountId,
    databaseId,
    databaseName: database.name,
  });
  const contract = {
    schemaVersion: 1,
    kind: "omh.control-core.deployment/v1",
    repositoryRoot,
    sourceCommit,
    accountId,
    creationId,
    environment: "development",
    configuration,
  };
  const inspect = async () => ({ repositoryRoot, sha: sourceCommit });
  return { parent, contract, inspect, database };
}

test("local mechanism qualification: exact cross-channel committed challenge precedes target exposure; native D1 batches still roll back", async (t) => {
  const { parent, contract, inspect, database } = await rig(t);
  // Remote bootstrap owns the immutable commit pin. A worktree-initialized local target may
  // already contain uncommitted migrations and must correctly fail that attestation.
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script: "export default {fetch(){return new Response('unserved',{status:503})}}",
      d1Databases: { CONTROL_CORE: "remote-mechanism-proof" },
    }),
  );
  t.after(() => runtime.dispose());
  const local = { db: await runtime.getD1Database("CONTROL_CORE") };
  assert.equal(
    await local.db.prepare("SELECT name FROM sqlite_master WHERE name='core_layout'").first(),
    null,
  );
  let disposed = 0,
    queried = false;
  const request = async ({ method, path, body }) => {
    assert.ok(path.startsWith(`/accounts/${accountId}/d1/database/${databaseId}`));
    if (method === "GET") return { success: true, result: database };
    queried = true;
    assert.equal(body.sql, "SELECT name,digest,result FROM command_log WHERE command_id=?");
    return {
      success: true,
      result: [
        {
          success: true,
          ...(await local.db
            .prepare(body.sql)
            .bind(...body.params)
            .all()),
        },
      ],
    };
  };
  const getProxy = async (root, options) => {
    assert.equal(root, repositoryRoot);
    assert.deepEqual(
      { ...options, configPath: undefined },
      { configPath: undefined, envFiles: [], persist: false, remoteBindings: true },
    );
    const configuration = JSON.parse(await readFile(options.configPath, "utf8"));
    assert.deepEqual(configuration.d1_databases, [
      {
        binding: "CONTROL_CORE",
        database_name: database.name,
        database_id: databaseId,
        remote: true,
      },
    ]);
    assert.deepEqual(Object.keys(configuration).sort(), [
      "account_id",
      "compatibility_date",
      "d1_databases",
      "name",
    ]);
    return {
      env: { CONTROL_CORE: local.db },
      dispose: async () => {
        disposed++;
      },
    };
  };
  const target = await openRemoteControlCoreTarget(
    { contract, repositoryRoot, output: join(parent, "session") },
    { request, getProxy, inspect },
  );
  assert.equal(queried, true);
  assert.equal(target.proof.kind, "omh.control-core.remote-binding-proof/v1");
  assert.equal(target.proof.authorityActivation, "not-certified");
  const command = JSON.parse(
    await readFile(join(parent, "session", "remote-challenge.json"), "utf8"),
  );
  assert.equal(
    (
      await local.db
        .prepare("SELECT digest FROM command_log WHERE command_id=?")
        .bind(command.commandId)
        .first()
    ).digest,
    command.digest,
  );
  await assert.rejects(
    target.db.batch([
      target.db.prepare(
        "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES('rollback-proof','test','digest','{}',0)",
      ),
      target.db.prepare("INSERT INTO guard_fail(code) VALUES('precondition_changed')"),
    ]),
  );
  assert.equal(
    await target.db.prepare("SELECT 1 FROM command_log WHERE command_id='rollback-proof'").first(),
    null,
  );
  await target.dispose();
  assert.equal(disposed, 1);

  // Model the dangerous fallback: the binding reaches a different/local DB, while the provider path has no challenge.
  await assert.rejects(
    openRemoteControlCoreTarget(
      { contract, repositoryRoot, output: join(parent, "fallback") },
      {
        inspect,
        getProxy,
        request: async ({ method }) => ({
          success: true,
          result: method === "GET" ? database : [{ success: true, results: [] }],
        }),
      },
    ),
    /REMOTE_TARGET_UNVERIFIED/u,
  );
  assert.equal(disposed, 2);
  await assert.rejects(readFile(join(parent, "fallback", "remote-binding-proof.json")), {
    code: "ENOENT",
  });
  await local.db
    .prepare(
      "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'33333333-3333-4333-8333-333333333333','2026-10-29T01:00:00.000000Z',zeroblob(32),zeroblob(32))",
    )
    .run();
  await assert.rejects(
    openRemoteControlCoreTarget(
      { contract, repositoryRoot, output: join(parent, "activated") },
      { inspect, getProxy, request },
    ),
    /REMOTE_TARGET_UNVERIFIED/u,
  );
  assert.equal(disposed, 3);
  await assert.rejects(readFile(join(parent, "activated", "remote-challenge.json")), {
    code: "ENOENT",
  });
});

test("schema bootstrap refuses foreign or partial state without changing that state", async (t) => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script: "export default {fetch(){return new Response('unserved',{status:503})}}",
      d1Databases: { CONTROL_CORE: "foreign" },
    }),
  );
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("CONTROL_CORE");
  await db.prepare("CREATE TABLE foreign_history(id TEXT PRIMARY KEY)").run();
  await db.prepare("INSERT INTO foreign_history VALUES('preserve')").run();
  await assert.rejects(initializeUnservedTargetSchema(db, repositoryRoot), /TARGET_NOT_EMPTY/u);
  assert.deepEqual(await db.prepare("SELECT * FROM foreign_history").first(), { id: "preserve" });
  assert.equal(
    await db.prepare("SELECT name FROM sqlite_master WHERE name='core_layout'").first(),
    null,
  );
});

test("wrong source, account or database identity never opens a binding", async (t) => {
  const { parent, contract, inspect, database } = await rig(t);
  let proxyCalls = 0;
  const getProxy = async () => {
    proxyCalls++;
    throw new Error("must not open");
  };
  const request = async () => ({
    success: true,
    result: { ...database, uuid: "33333333-3333-4333-8333-333333333333" },
  });
  for (const changed of [
    { ...contract, sourceCommit: "f".repeat(40) },
    { ...contract, accountId: "f".repeat(32) },
    contract,
  ])
    await assert.rejects(
      openRemoteControlCoreTarget(
        { contract: changed, repositoryRoot, output: join(parent, "denied") },
        { inspect, request, getProxy },
      ),
      /UNVERIFIED/u,
    );
  assert.equal(proxyCalls, 0);
});

test("immutable source migration bytes survive a worktree edit while the remote binding opens", async (t) => {
  const { parent, database } = await rig(t),
    source = join(parent, "source");
  await mkdir(join(source, "apps/control-store/src"), { recursive: true, mode: 0o700 });
  await cp(
    join(repositoryRoot, "apps/control-store/migrations"),
    join(source, "apps/control-store/migrations"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "apps/control-store/wrangler.jsonc"),
    join(source, "apps/control-store/wrangler.jsonc"),
  );
  await writeFile(join(source, "apps/control-store/src/worker-main.ts"), "export default {};\n");
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Operator fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      { cwd: source, encoding: "utf8" },
    );
  git(["init", "--initial-branch=main", "--quiet"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "immutable fixture"]);
  const sourceCommit = git(["rev-parse", "HEAD"]).trim();
  const { configuration } = await controlCoreWorkerConfiguration({
    repositoryRoot: source,
    sourceCommit,
    environment: "development",
    accountId,
    databaseId,
    databaseName: database.name,
  });
  const contract = {
    schemaVersion: 1,
    kind: "omh.control-core.deployment/v1",
    repositoryRoot: source,
    sourceCommit,
    accountId,
    creationId,
    environment: "development",
    configuration,
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script: "export default {fetch(){return new Response('unserved',{status:503})}}",
      d1Databases: { CONTROL_CORE: "immutable-source" },
    }),
  );
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("CONTROL_CORE");
  const target = await openRemoteControlCoreTarget(
    { contract, repositoryRoot: source, output: join(parent, "immutable") },
    {
      inspect: async () => ({ repositoryRoot: source, sha: sourceCommit }),
      getProxy: async () => {
        const path = join(source, "apps/control-store/migrations/core/0001_core_layout.sql");
        await writeFile(
          path,
          (await readFile(path, "utf8")) + "\nCREATE TABLE injected_worktree(marker TEXT);\n",
        );
        return { env: { CONTROL_CORE: db }, dispose: async () => {} };
      },
      request: async ({ method, body }) => ({
        success: true,
        result:
          method === "GET"
            ? database
            : [
                {
                  success: true,
                  ...(await db
                    .prepare(body.sql)
                    .bind(...body.params)
                    .all()),
                },
              ],
      }),
    },
  );
  assert.equal(
    await target.db
      .prepare("SELECT name FROM sqlite_master WHERE name='injected_worktree'")
      .first(),
    null,
  );
  assert.equal(target.proof.sourceCommit, sourceCommit);
});
