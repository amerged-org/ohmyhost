/* global URL */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { execPath } from "node:process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { testPostgresEnvironment } from "../scripts/test-postgres-path.mjs";
import {
  capture,
  openCapture,
  targetPin,
  buildPlan,
  openLocalTarget,
  importPlan,
  compareRecords,
  runCli,
} from "../scripts/control-d1-migration.mjs";
import {
  canonical,
  captureExpression,
  columnKind,
  frameRow,
  integerText,
  seal,
  sha256,
  tableProof,
  unseal,
} from "../scripts/control-d1-codec.mjs";
import { appendJournal } from "../scripts/control-d1-artifacts.mjs";
import { splitSql } from "../scripts/control-d1-target.mjs";

const require = createRequire(new URL("../packages/database/package.json", import.meta.url));
const { Client } = require("pg");
const executeFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const id = (value) => String(value).padStart(26, "0");
const at = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000001Z`;
let directory, client, environment, pin, key, image, plan, dataDirectory;
const path = (name) => join(directory, name);

before(async () => {
  environment = testPostgresEnvironment();
  directory = await mkdtemp(join(tmpdir(), "omh-control-d1-migration-"));
  await chmod(directory, 0o700);
  dataDirectory = path("pg");
  const server = createServer();
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const port = server.address().port;
  await new Promise((ready) => server.close(ready));
  await executeFile("initdb", ["-D", dataDirectory, "-A", "trust", "-U", "postgres"], {
    env: environment,
  });
  await executeFile(
    "pg_ctl",
    [
      "-D",
      dataDirectory,
      "-l",
      path("pg.log"),
      "-o",
      `-F -p ${port} -h 127.0.0.1 -k ''`,
      "-w",
      "start",
    ],
    { env: environment },
  );
  client = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await client.connect();
  environment = {
    ...environment,
    PGHOST: "127.0.0.1",
    PGPORT: String(port),
    PGUSER: "postgres",
    PGDATABASE: "postgres",
  };
  await fixture(client);
  pin = await targetPin(repositoryRoot);
  key = randomBytes(32);
});
after(async () => {
  await client?.end();
  if (dataDirectory)
    await executeFile("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "-w", "stop"], {
      env: environment,
    }).catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(pg) {
  await pg.query("CREATE SEQUENCE fixture_notice_seq AS bigint");
  await pg.query(
    "CREATE SEQUENCE fixture_unstarted_seq AS bigint START WITH 17 INCREMENT BY 3 CACHE 2",
  );
  const definitions = {
    workos_organization_mappings:
      "organization_id text,workos_organization_id text,state text,mapping_revision integer,snapshot_sha256 bytea,snapshot_fetched_at timestamptz,synchronized_at timestamptz,updated_at timestamptz,beta_admitted_at timestamptz",
    organization_memberships:
      "organization_id text,workos_user_id text,role text,state text,mapping_revision integer,snapshot_sha256 bytea,effective_at timestamptz,revoked_at timestamptz,trigger_event_id text",
    local_authorization_grants:
      "organization_id text,grant_id text,project_id text,environment_id text,principal_kind text,principal_id text,role text,ownership_version integer,billing_epoch_id text,created_at timestamptz,revoked_at timestamptz",
    workos_terminal_revocations:
      "kind text,resource_id text,workos_user_id text,workos_organization_id text,source_event_id text,effective_at timestamptz",
    workos_membership_sync_barriers:
      "workos_organization_id text,workos_user_id text,source_event_id text,event_created_at timestamptz,reconciled_at timestamptz",
    projects:
      "project_id text,created_organization_id text,name text,created_event_id text,created_at timestamptz,lifecycle_state text,lifecycle_version integer,handle text,handle_version text,handle_attempt integer,data_mode text,region text,dev_access_mode text",
    project_ownerships:
      "project_id text,organization_id text,state text,ownership_version integer,active_billing_epoch_id text,updated_at timestamptz",
    billing_epochs:
      "organization_id text,billing_epoch_id text,project_id text,started_at timestamptz,ended_at timestamptz,created_by_principal_id text",
    project_transfer_intents:
      "transfer_id text,project_id text,source_organization_id text,target_organization_id text,state text,expected_ownership_version integer,completed_at timestamptz",
    audit_events:
      "organization_id text,audit_event_id text,project_id text,operation_id text,event_type text,actor_type text,actor_id text,payload jsonb,occurred_at timestamptz,billing_epoch_id text",
    environments:
      "organization_id text,environment_id text,project_id text,name text,desired_state jsonb,active_deployment_id text,active_revision_id text,head_version integer,dev_access_epoch bigint,created_at timestamptz,updated_at timestamptz",
    project_data_environments:
      "organization_id text,project_id text,data_environment_id text,created_at timestamptz",
    environment_data_assignments:
      "organization_id text,environment_id text,assignment_version bigint,project_id text,data_environment_id text,assigned_at timestamptz,operation_id text",
    environment_secrets:
      "organization_id text,project_id text,environment_id text,name text,ciphertext bytea,nonce bytea,value_sha256 bytea,key_version integer,revision bigint,created_at timestamptz,updated_at timestamptz",
    opaque_history:
      "amount bigint,adjustment bigint,beyond_sum numeric,payload text,json_document jsonb,bytes bytea,empty_bytes bytea,nullable text,happened_at timestamptz,forever_at timestamptz,never_at timestamptz,bounds integer[],floating double precision,ancient_at timestamptz",
    fixture_notice: "notice_id bigint DEFAULT nextval('fixture_notice_seq'),body text",
    fixture_notice_cursor: "after_id bigint",
  };
  for (const [name, columns] of Object.entries(definitions))
    await pg.query(`CREATE TABLE ${name}(${columns})`);
  await pg.query("ALTER SEQUENCE fixture_notice_seq OWNED BY fixture_notice.notice_id");
  await pg.query("SELECT setval('fixture_notice_seq',9007199254740993,true)");
  await pg.query("INSERT INTO fixture_notice_cursor VALUES(9007199254740993)");
  for (const [organization, external] of [
    [id(1), "org_one"],
    [id(2), "org_two"],
    [id(90), "org_three"],
  ]) {
    await pg.query(
      "INSERT INTO workos_organization_mappings VALUES($1,$2,'active',7,$3,$4,$4,$4,$4)",
      [organization, external, Buffer.alloc(32, 0xab), at(1)],
    );
    await pg.query(
      "INSERT INTO organization_memberships VALUES($1,'user_one','owner','active',7,$2,$3,NULL,'evt_membership')",
      [organization, Buffer.alloc(32, 0xab), at(1)],
    );
  }
  await pg.query(
    "INSERT INTO local_authorization_grants VALUES($1,$2,NULL,NULL,'user','user:user_one','owner',NULL,NULL,$3,NULL)",
    [id(1), id(9), at(1)],
  );
  await pg.query(
    "INSERT INTO workos_terminal_revocations VALUES('session','session_one','user_one','org_one','evt_revoked',$1)",
    [at(2)],
  );
  await pg.query(
    "INSERT INTO workos_membership_sync_barriers VALUES('org_one','user_one','evt_barrier',$1,NULL),('org_pending','user_later','evt_pending',$1,NULL)",
    [at(2)],
  );
  await pg.query(
    "INSERT INTO projects VALUES($1,$2,'fixture',$3,$4,'active',1,'converter-fixture','customer-chosen-v1',0,'shared','us','protected')",
    [id(3), id(1), id(4), at(1)],
  );
  await pg.query("INSERT INTO project_ownerships VALUES($1,$2,'active',5,$3,$4)", [
    id(3),
    id(1),
    id(13),
    at(3),
  ]);
  for (const [org, epoch, start, end] of [
    [id(1), id(11), at(1), at(2)],
    [id(2), id(12), at(2), at(3)],
    [id(1), id(13), at(3), null],
  ])
    await pg.query("INSERT INTO billing_epochs VALUES($1,$2,$3,$4,$5,'user:user_one')", [
      org,
      epoch,
      id(3),
      start,
      end,
    ]);
  for (const [transfer, from, to, version, completed] of [
    [id(21), id(1), id(2), 2, at(2)],
    [id(22), id(2), id(1), 4, at(3)],
  ]) {
    await pg.query("INSERT INTO project_transfer_intents VALUES($1,$2,$3,$4,'completed',$5,$6)", [
      transfer,
      id(3),
      from,
      to,
      version,
      completed,
    ]);
    await pg.query(
      "INSERT INTO audit_events VALUES($1,$2,$3,NULL,'ProjectOwnershipTransferred','principal','user:user_one',$4::jsonb,$5,$6)",
      [
        from,
        id(Number(transfer) + 100),
        id(3),
        JSON.stringify({ transferId: transfer }),
        completed,
        from === id(1) ? id(11) : id(12),
      ],
    );
  }
  // The original accepts equal transition clocks; random/reverse epoch IDs do not express ownership order.
  await pg.query(
    "INSERT INTO projects VALUES($1,$2,'same-clock',$3,$4,'deleting',3,'same-clock-project','customer-chosen-v1',0,'shared','us','protected')",
    [id(80), id(1), id(81), at(4)],
  );
  await pg.query("INSERT INTO project_ownerships VALUES($1,$2,'active',7,$3,$4)", [
    id(80),
    id(1),
    id(86),
    at(4),
  ]);
  for (const [organization, epoch, ended] of [
    [id(1), id(89), at(4)],
    [id(2), id(88), at(4)],
    [id(90), id(87), at(4)],
    [id(1), id(86), null],
  ])
    await pg.query("INSERT INTO billing_epochs VALUES($1,$2,$3,$4,$5,'user:user_one')", [
      organization,
      epoch,
      id(80),
      at(4),
      ended,
    ]);
  for (const [transfer, from, to, version, epoch] of [
    [id(82), id(1), id(2), 2, id(89)],
    [id(83), id(2), id(90), 4, id(88)],
    [id(84), id(90), id(1), 6, id(87)],
  ]) {
    await pg.query("INSERT INTO project_transfer_intents VALUES($1,$2,$3,$4,'completed',$5,$6)", [
      transfer,
      id(80),
      from,
      to,
      version,
      at(4),
    ]);
    await pg.query(
      "INSERT INTO audit_events VALUES($1,$2,$3,NULL,'ProjectOwnershipTransferred','principal','user:user_one',$4::jsonb,$5,$6)",
      [
        from,
        id(Number(transfer) + 100),
        id(80),
        JSON.stringify({ transferId: transfer }),
        at(4),
        epoch,
      ],
    );
  }
  await pg.query(
    "INSERT INTO environments VALUES($1,$2,$3,'dev','{}',NULL,NULL,0,9007199254740993,$4,$4)",
    [id(1), id(31), id(3), at(1)],
  );
  await pg.query("INSERT INTO project_data_environments VALUES($1,$2,$3,$4)", [
    id(1),
    id(3),
    id(31),
    at(1),
  ]);
  await pg.query("INSERT INTO project_data_environments VALUES($1,$2,$3,$4)", [
    id(2),
    id(3),
    id(31),
    at(2),
  ]);
  await pg.query("INSERT INTO environment_data_assignments VALUES($1,$2,1,$3,$2,$4,NULL)", [
    id(1),
    id(31),
    id(3),
    at(1),
  ]);
  await pg.query(
    "INSERT INTO environment_secrets VALUES($1,$2,$3,'SECRET',$4,$5,$6,1,9007199254740993,$7,$7)",
    [
      id(1),
      id(3),
      id(31),
      Buffer.from([0, 255, ...Array(16).fill(17)]),
      Buffer.alloc(12, 3),
      Buffer.alloc(32, 4),
      at(1),
    ],
  );
  await pg.query(
    `INSERT INTO opaque_history VALUES(9223372036854775807,-9223372036854775808,18446744073709551614,$1,'{"big":9007199254740993}',decode('00ff1f','hex'),decode('','hex'),NULL,$2,'infinity','-infinity','[0:2]={1,2,3}','Infinity','0001-01-01 BC')`,
    [' {"preserve": "\\u00e9", "note":"a\u001fb"} ', "2026-10-01T00:00:00.123456Z"],
  );
  await pg.query("INSERT INTO opaque_history SELECT * FROM opaque_history");
  await pg.query("CREATE VIEW fixture_view AS SELECT payload FROM opaque_history");
}

const doCapture = (output, overrides = {}) =>
  capture({
    client,
    expectedSource: { role: "postgres", database: "postgres" },
    output,
    key,
    targetPin: pin,
    chunkRows: 1,
    dump: async ({ snapshot, schema }) =>
      (
        await executeFile(
          "pg_dump",
          ["--format=custom", `--snapshot=${snapshot}`, `--schema=${schema}`],
          { env: environment, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    ...overrides,
  });

/** Real CLI child + descriptor3 pipe + hash-pinned module + actual isolated PG18, no credential discovery. */
async function operatorCli(command, configPath) {
  const child = spawn(
    execPath,
    [
      join(repositoryRoot, "scripts/control-d1-migration.mjs"),
      command,
      "--config",
      configPath,
      "--key-fd",
      "3",
    ],
    {
      cwd: repositoryRoot,
      env: { PATH: environment.PATH },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  child.stdio[3].end(key);
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (error += chunk));
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  return {
    code,
    result: output === "" ? null : JSON.parse(output),
    error: error === "" ? null : JSON.parse(error),
  };
}

/** Only the transport fails; every read/write batch still executes on the actual D1 engine. */
function networkFault(target, options) {
  const descriptions = new WeakMap();
  let committed = false;
  let replies = options.loseReply ? 1 : 0;
  let readbacks = options.loseReadback ? 1 : 0;
  let contextCommitted = false;
  let contextReplies = options.loseContextReply ? 1 : 0;
  let contextReadbacks = options.loseContextReadback ? 1 : 0;
  const wrap = (statement, sql) => {
    const wrapped = {
      bind: (...parameters) => wrap(statement.bind(...parameters), sql),
      first: async (...parameters) => {
        if (
          contextCommitted &&
          contextReadbacks > 0 &&
          sql.includes("FROM core_historical_import WHERE singleton=1")
        ) {
          contextReadbacks -= 1;
          throw new Error("context readback unavailable");
        }
        if (
          committed &&
          readbacks > 0 &&
          sql === "SELECT name,digest,result FROM command_log WHERE command_id=?"
        ) {
          readbacks -= 1;
          throw new Error("readback unavailable");
        }
        return statement.first(...parameters);
      },
      all: (...parameters) => statement.all(...parameters),
      run: (...parameters) => statement.run(...parameters),
    };
    descriptions.set(wrapped, {
      statement,
      write: /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql),
      importReceipt: sql.includes(
        "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES (?,'control-d1.import'",
      ),
      contextInsert: sql.startsWith("INSERT INTO core_historical_import"),
    });
    return wrapped;
  };
  return {
    prepare: (sql) => {
      if (options.metrics && sql.startsWith("PRAGMA table_xinfo"))
        options.metrics.schemas.set(sql, (options.metrics.schemas.get(sql) ?? 0) + 1);
      return wrap(target.prepare(sql), sql);
    },
    batch: async (statements) => {
      const described = statements.map((statement) => descriptions.get(statement));
      const writing = described.some((item) => item.write);
      const dataCommit = described.some((item) => item.importReceipt);
      const contextCommit = described.some((item) => item.contextInsert);
      if (options.metrics) options.metrics.batches.push({ writing, statements: statements.length });
      if (dataCommit && options.beforeWrite) throw new Error("connection lost before write");
      const result = await target.batch(described.map((item) => item.statement));
      if (contextCommit && contextReplies > 0) {
        contextReplies -= 1;
        contextCommitted = true;
        throw new Error("context reply lost");
      }
      if (dataCommit && replies > 0) {
        replies -= 1;
        committed = true;
        throw new Error("commit reply lost");
      }
      return result;
    },
  };
}

test("exact typed/encrypted capture preserves int8, raw bytes/text, infinity, array bounds and duplicate multiplicity", async () => {
  assert.equal(integerText("9223372036854775807"), "9223372036854775807");
  assert.equal(integerText("-9223372036854775808"), "-9223372036854775808");
  for (const value of ["9223372036854775808", 5, "1.0", "01"])
    assert.throws(() => integerText(value), /CONTROL_D1_INTEGER/u);
  for (const type of [
    "bigint",
    "integer[]",
    "numeric(30,0)",
    "double precision",
    "bytea",
    "timestamp with time zone",
    "text",
  ])
    assert.equal(typeof columnKind(type), "string");
  const columns = [
    { name: "one", pgType: "text", kind: "text" },
    { name: "two", pgType: "text", kind: "text" },
  ];
  assert.notEqual(
    sha256(frameRow(columns, ["a\u001fb", "c"])),
    sha256(frameRow(columns, ["a", "b\u001fc"])),
  );
  assert.notEqual(
    tableProof(columns, [[null, ""]]).sha256,
    tableProof(columns, [["", null]]).sha256,
  );
  assert.notEqual(
    tableProof(columns, [["a", "b"]]).sha256,
    tableProof(columns, [
      ["a", "b"],
      ["a", "b"],
    ]).sha256,
  );
  for (const invalid of [[1, null], ["a"]])
    assert.throws(() => frameRow(columns, invalid), /CONTROL_D1_ROW/u);
  assert.throws(() => frameRow([{ name: "a", pgType: "bytea", kind: "bytea" }], ["z"]), /BYTEA/u);
  const sealed = seal(key, "capture", "chunk", Buffer.from("private"));
  assert.equal(unseal(key, "capture", "chunk", sealed).toString(), "private");
  for (const [otherKey, captureId, name, data] of [
    [key, "wrong", "chunk", sealed],
    [key, "capture", "chunk", Buffer.from("bad")],
    [randomBytes(32), "capture", "chunk", sealed],
  ])
    assert.throws(() => unseal(otherKey, captureId, name, data), /CIPHER/u);
  assert.throws(() => seal(Buffer.alloc(1), "x", "y", Buffer.alloc(0)), /KEY/u);
  assert.throws(() => unseal(Buffer.alloc(1), "x", "y", Buffer.alloc(0)), /KEY/u);
  assert.equal(captureExpression({ name: 'a"b', kind: "text" }), '"a""b"::text');
  assert.equal(
    splitSql(
      "-- comment\nCREATE TABLE x(v TEXT); CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 'a;b'='a;b' THEN 1 END; END; /* ok */",
    ).length,
    2,
  );
  await doCapture(path("capture"));
  await assert.rejects(doCapture(path("capture")), /EEXIST/u);
  image = await openCapture({ directory: path("capture"), key });
  const facts = image.rows.get("opaque_history");
  assert.equal(facts.length, 2);
  assert.equal(facts[0].amount, "9223372036854775807");
  assert.equal(facts[0].adjustment, "-9223372036854775808");
  assert.equal(facts[0].beyond_sum, "18446744073709551614");
  assert.equal(facts[0].bytes, "00ff1f");
  assert.equal(facts[0].empty_bytes, "");
  assert.equal(facts[0].happened_at, "2026-10-01T00:00:00.123456Z");
  assert.equal(facts[0].forever_at, "+infinity");
  assert.equal(facts[0].never_at, "-infinity");
  assert.match(facts[0].ancient_at, /^postgres:.* BC$/u);
  assert.equal(facts[0].bounds, "[0:2]={1,2,3}");
  assert.equal(facts[0].json_document, '{"big": 9007199254740993}');
  assert.equal(facts[0].payload, ' {"preserve": "\\u00e9", "note":"a\u001fb"} ');
  assert.equal(image.recoveryBytes.subarray(0, 5).toString(), "PGDMP");
  const counter = image.manifest.sequences.find(
    (sequence) => sequence.name === "fixture_notice_seq",
  );
  assert.equal(counter.state.last_value, "9007199254740993");
  assert.equal(counter.state.is_called, true);
  assert.equal(counter.owned_table, "fixture_notice");
  assert.equal(counter.owned_column, "notice_id");
  assert.deepEqual(image.rows.get("fixture_notice"), []);
  assert.equal(image.rows.get("fixture_notice_cursor")[0].after_id, "9007199254740993");
  const unused = image.manifest.sequences.find(
    (sequence) => sequence.name === "fixture_unstarted_seq",
  );
  assert.equal(unused.state.last_value, "17");
  assert.equal(unused.state.is_called, false);
  assert.equal(unused.increment_by, "3");
  assert.equal(
    (await client.query("SELECT nextval('fixture_notice_seq')::text value")).rows[0].value,
    "9007199254740994",
  );
  assert.equal(
    (await client.query("SELECT nextval('fixture_unstarted_seq')::text value")).rows[0].value,
    "17",
  );
  await assert.rejects(
    doCapture(path("bad-identity"), { expectedSource: { role: "other", database: "postgres" } }),
    /SOURCE_IDENTITY/u,
  );
  await assert.rejects(
    doCapture(path("bad-dump"), { dump: async () => Buffer.from("not dump") }),
    /DUMP_FORMAT/u,
  );
  const modulePath = path("operator-fixture.mjs");
  const moduleBody = `import{createRequire}from'node:module';import{execFile}from'node:child_process';import{promisify}from'node:util';
const{Client}=createRequire(${JSON.stringify(join(repositoryRoot, "packages/database/package.json"))})('pg');const run=promisify(execFile);
export async function resolveSource(source){const client=new Client({host:source.host,port:source.port,user:source.role,database:source.database,connectionTimeoutMillis:3000});await client.connect();return{client,dump:async({snapshot,schema})=>(await run(${JSON.stringify(join(environment.OHMYHOST_TEST_POSTGRES_BIN, "pg_dump"))},['--format=custom','--snapshot='+snapshot,'--schema='+schema],{env:{PGHOST:source.host,PGPORT:String(source.port),PGUSER:source.role,PGDATABASE:source.database},encoding:'buffer',maxBuffer:16777216})).stdout,close:()=>client.end()}}`;
  await writeFile(modulePath, moduleBody, { mode: 0o600 });
  const loaderConfig = {
    repositoryRoot,
    captureDirectory: path("cli-capture"),
    source: {
      host: "127.0.0.1",
      port: Number(environment.PGPORT),
      role: "postgres",
      database: "postgres",
      schema: "public",
      environment: "development",
    },
    operatorModule: modulePath,
    operatorSha256: sha256(Buffer.from(moduleBody)),
  };
  const loaderPath = path("loader-config.json");
  await writeFile(loaderPath, canonical(loaderConfig), { mode: 0o600 });
  const captured = await operatorCli("capture", loaderPath);
  assert.equal(captured.code, 0);
  assert.equal(captured.result.qualificationOnly, true);
  const loaded = await openCapture({ directory: loaderConfig.captureDirectory, key });
  await writeFile(
    loaderPath,
    canonical({ ...loaderConfig, sourceSchemaSha256: loaded.manifest.sourceSchemaSha256 }),
  );
  const reported = await operatorCli("status", loaderPath);
  assert.equal(reported.code, 2);
  assert.equal(reported.result.verdict, "INCOMPLETE");
  assert.deepEqual(reported.result.unhandledSequences, [
    "fixture_notice_seq",
    "fixture_unstarted_seq",
  ]);
  await writeFile(loaderPath, canonical({ ...loaderConfig, operatorSha256: "00".repeat(32) }));
  const refused = await operatorCli("capture", loaderPath);
  assert.equal(refused.code, 1);
  assert.equal(refused.error.code, "CONTROL_D1_OPERATOR_PIN");
  await writeFile(
    loaderPath,
    canonical({ ...loaderConfig, captureDirectory: path("same-process-capture") }),
  );
  await runCli(["capture", "--config", loaderPath, "--key-fd", "3"], {
    readKey: () => Buffer.from(key),
  });
  const changedModule =
    "export async function resolveSource(){throw new Error('CONTROL_D1_FIXTURE_NEW_MODULE')}";
  await writeFile(modulePath, changedModule);
  await writeFile(
    loaderPath,
    canonical({
      ...loaderConfig,
      captureDirectory: path("changed-module-capture"),
      operatorSha256: sha256(Buffer.from(changedModule)),
    }),
  );
  await assert.rejects(
    runCli(["capture", "--config", loaderPath, "--key-fd", "3"], {
      readKey: () => Buffer.from(key),
    }),
    /CONTROL_D1_FIXTURE_NEW_MODULE/u,
  );
  const snapshot = (await client.query("SELECT current_setting('transaction_isolation') AS mode"))
    .rows[0];
  assert.equal(snapshot.mode, "read committed");
});

test("real PG18 image imports identity, A→B→A epochs and unchanged secret AAD into two real D1 targets", async () => {
  plan = buildPlan(image, pin, { role: "postgres", database: "postgres" });
  assert.equal(plan.verdict, "INCOMPLETE");
  // This reduced codec/history fixture has no operation spine: its project audit rows remain evidence-only.
  assert.deepEqual(plan.gaps, [
    { group: "independent-audit-facts-v1", code: "PARENT_MAPPER_UNQUALIFIED" },
  ]);
  assert.deepEqual(plan.unhandled, [
    "audit_events",
    "fixture_notice",
    "fixture_notice_cursor",
    "opaque_history",
  ]);
  assert.deepEqual(plan.unhandledSequences, ["fixture_notice_seq", "fixture_unstarted_seq"]);
  assert.deepEqual(plan.unhandledViews, ["fixture_view"]);
  const local = await openLocalTarget({ repositoryRoot });
  const restored = await openLocalTarget({ repositoryRoot });
  try {
    for (const [target, targetId] of [
      [local, "first"],
      [restored, "restored"],
    ]) {
      const result = await importPlan({
        db: target.db,
        plan,
        targetId,
        key,
        journal: path(`${targetId}.journal`),
        batchRows: 1000,
        currentPin: pin,
      });
      assert.equal(result.verdict, "INCOMPLETE");
      assert.deepEqual(await compareRecords(target.db, plan.records), []);
      const epochs = (
        await target.db
          .prepare(
            "SELECT organization_id,billing_epoch_id,started_at,ended_at FROM billing_epochs WHERE project_id='00000000000000000000000003' ORDER BY started_at",
          )
          .all()
      ).results;
      assert.equal(epochs.length, 3);
      assert.equal(epochs[0].organization_id, id(1));
      assert.equal(epochs[1].organization_id, id(2));
      assert.equal(epochs[2].organization_id, id(1));
      assert.equal(
        (
          await target.db
            .prepare(
              "SELECT count(*) n FROM projects WHERE project_id='00000000000000000000000003' AND owner_state <> 'transferred'",
            )
            .first()
        ).n,
        1,
      );
      assert.equal(
        (
          await target.db
            .prepare(
              "SELECT count(*) n FROM project_scope_history WHERE project_id='00000000000000000000000003'",
            )
            .first()
        ).n,
        1,
      );
      assert.equal(
        (
          await target.db
            .prepare("SELECT CAST(revision AS TEXT) revision FROM environment_secrets")
            .first()
        ).revision,
        "9007199254740993",
      );
      assert.equal(
        (
          await target.db
            .prepare("SELECT lower(hex(ciphertext)) value FROM environment_secrets")
            .first()
        ).value,
        image.rows.get("environment_secrets")[0].ciphertext,
      );
      const equal = await target.db
        .prepare(
          "SELECT organization_id,ownership_version,active_billing_epoch_id,lifecycle_state,lifecycle_version FROM projects WHERE project_id=? AND owner_state<>'transferred'",
        )
        .bind(id(80))
        .first();
      assert.deepEqual(equal, {
        organization_id: id(1),
        ownership_version: 7,
        active_billing_epoch_id: id(86),
        lifecycle_state: "deleting",
        lifecycle_version: 3,
      });
      const equalEpochs = (
        await target.db
          .prepare(
            "SELECT billing_epoch_id FROM billing_epochs WHERE project_id=? ORDER BY billing_epoch_id",
          )
          .bind(id(80))
          .all()
      ).results;
      assert.deepEqual(
        equalEpochs.map((row) => row.billing_epoch_id),
        [id(86), id(87), id(88), id(89)],
      );
      const equalHistory = await target.db
        .prepare(
          "SELECT active_billing_epoch_id,returned_to_billing_epoch_id,ownership_version FROM project_scope_history WHERE project_id=?",
        )
        .bind(id(80))
        .first();
      assert.deepEqual(equalHistory, {
        active_billing_epoch_id: id(89),
        returned_to_billing_epoch_id: id(86),
        ownership_version: 2,
      });
      const replay = await importPlan({
        db: target.db,
        plan,
        targetId,
        key,
        journal: path(`${targetId}.journal`),
        batchRows: 1000,
        currentPin: pin,
      });
      assert.equal(
        replay.applied.every((chunk) => chunk.replayed),
        true,
      );
      await assert.rejects(
        target.db.prepare("DELETE FROM project_scope_history").run(),
        /never deleted/u,
      );
    }
    const one = await local.db.prepare("SELECT * FROM project_scope_history").all();
    const two = await restored.db.prepare("SELECT * FROM project_scope_history").all();
    assert.deepEqual(one.results, two.results);
  } finally {
    await local.dispose();
    await restored.dispose();
  }
});

test("lost commit replies reconcile exact receipts; conflicts, corruption, drift and unmapped authority never activate", async () => {
  const local = await openLocalTarget({ repositoryRoot });
  const invalid = await openLocalTarget({ repositoryRoot });
  const unknown = await openLocalTarget({ repositoryRoot });
  try {
    await assert.rejects(
      importPlan({
        db: local.db,
        plan: { ...plan, format: "omh.control-d1.plan/v1" },
        targetId: "old-format",
        key,
        journal: path("old-format.journal"),
        currentPin: pin,
      }),
      /PLAN_FORMAT/u,
    );
    await assert.rejects(
      importPlan({
        db: local.db,
        plan: { ...plan, format: "omh.control-d1.plan/v2" },
        targetId: "old-group-protocol",
        key,
        journal: path("old-group-protocol.journal"),
        currentPin: pin,
      }),
      /PLAN_FORMAT/u,
    );
    await assert.rejects(
      importPlan({
        db: local.db,
        plan,
        targetId: "bad-temporal",
        key,
        journal: path("bad-temporal.journal"),
        currentPin: pin,
        temporalTables: ["organizations"],
      }),
      /CONTEXT_TABLES/u,
    );
    const contextUnknown = networkFault(local.db, {
      loseContextReply: true,
      loseContextReadback: true,
    });
    await assert.rejects(
      importPlan({
        db: contextUnknown,
        plan,
        targetId: "context-unknown",
        key,
        journal: path("context-unknown.journal"),
        currentPin: pin,
      }),
      /IMPORT_CONTEXT_UNKNOWN/u,
    );
    assert.equal((await local.db.prepare("SELECT count(*) n FROM organizations").first()).n, 0);
    const unknownDb = networkFault(unknown.db, { loseReply: true, loseReadback: true });
    await assert.rejects(
      importPlan({
        db: unknownDb,
        plan,
        targetId: "unknown",
        key,
        journal: path("unknown.journal"),
        batchRows: 1000,
        currentPin: pin,
      }),
      /IMPORT_UNCONFIRMED/u,
    );
    const reconciled = await importPlan({
      db: unknown.db,
      plan,
      targetId: "unknown",
      key,
      journal: path("unknown.journal"),
      batchRows: 1000,
      currentPin: pin,
    });
    assert.equal(reconciled.applied[0].replayed, true);
    await assert.rejects(
      importPlan({
        db: unknown.db,
        plan: { ...plan, digest: "ab".repeat(32) },
        targetId: "conflicting-context",
        key,
        journal: path("conflicting-context.journal"),
        currentPin: pin,
      }),
      /IMPORT_CONTEXT_CONFLICT/u,
    );
    const metrics = { schemas: new Map(), batches: [] };
    const db = networkFault(local.db, { loseReply: true, metrics });
    await importPlan({
      db,
      plan,
      targetId: "lost",
      key,
      journal: path("lost.journal"),
      batchRows: 1000,
      currentPin: pin,
    });
    assert.deepEqual(await compareRecords(local.db, plan.records), []);
    assert.equal(
      [...metrics.schemas.values()].every((count) => count === 1),
      true,
    );
    assert.equal(
      metrics.batches.some((batch) => !batch.writing && batch.statements > 1),
      true,
    );
    assert.equal(
      metrics.batches.filter((batch) => !batch.writing).length < plan.records.length,
      true,
    );
    assert.equal(
      (
        await local.db
          .prepare("SELECT count(*) n FROM command_log WHERE name='control-d1.import'")
          .first()
      ).n,
      1,
    );
    const wrongPlan = {
      ...plan,
      records: plan.records.map((record) =>
        record.table === "environment_secrets"
          ? { ...record, row: { ...record.row, ciphertext: "00".repeat(18) } }
          : record,
      ),
    };
    await assert.rejects(
      importPlan({
        db: local.db,
        plan: wrongPlan,
        targetId: "lost",
        key,
        journal: path("lost.journal"),
        batchRows: 1000,
        currentPin: pin,
      }),
      /REPLAY_CONFLICT/u,
    );
    const failedDb = networkFault(invalid.db, { beforeWrite: true });
    const duplicate = { ...plan, records: [...plan.records, plan.records[0]] };
    await assert.rejects(
      importPlan({
        db: invalid.db,
        plan: duplicate,
        targetId: "duplicate",
        key,
        journal: path("duplicate.journal"),
        batchRows: 1000,
        currentPin: pin,
      }),
      /IMPORT_UNCONFIRMED/u,
    );
    assert.equal((await invalid.db.prepare("SELECT count(*) n FROM organizations").first()).n, 0);
    await assert.rejects(
      importPlan({
        db: failedDb,
        plan,
        targetId: "before",
        key,
        journal: path("before.journal"),
        currentPin: pin,
      }),
      /IMPORT_UNCONFIRMED/u,
    );
    assert.equal((await invalid.db.prepare("SELECT count(*) n FROM organizations").first()).n, 0);
    await importPlan({
      db: invalid.db,
      plan,
      targetId: "before",
      key,
      journal: path("before.journal"),
      currentPin: pin,
    });
    await local.db.prepare("CREATE TABLE drift(v TEXT)").run();
    await assert.rejects(
      importPlan({
        db: local.db,
        plan,
        targetId: "lost",
        key,
        journal: path("lost.journal"),
        currentPin: pin,
      }),
      /TARGET_SCHEMA_DRIFT/u,
    );
    await assert.rejects(
      importPlan({
        db: invalid.db,
        plan,
        targetId: "other",
        key,
        journal: path("other.journal"),
        currentPin: { ...pin, revision: "other" },
      }),
      /TARGET_PIN/u,
    );
    const missing = { ...image, rows: new Map(image.rows) };
    missing.rows.delete("project_ownerships");
    assert.equal(
      buildPlan(missing, pin, { role: "postgres", database: "postgres" }).gaps[0].code,
      "SOURCE_TABLE_REQUIRED",
    );
    const noHistory = { ...image, rows: new Map(image.rows) };
    noHistory.rows.set("project_transfer_intents", []);
    assert.equal(
      buildPlan(noHistory, pin, { role: "postgres", database: "postgres" }).gaps[0].code,
      "CONTROL_D1_HISTORY_EVIDENCE_REQUIRED",
    );
    assert.throws(
      () => buildPlan(image, pin, { role: "other", database: "postgres" }),
      /SOURCE_PIN/u,
    );
    const changedSchema = {
      ...image,
      manifest: {
        ...image.manifest,
        tables: image.manifest.tables.map((table) =>
          table.name === "environment_secrets"
            ? { ...table, columns: [...table.columns, { name: "new_authority" }] }
            : table,
        ),
      },
    };
    assert.equal(
      buildPlan(changedSchema, pin, { role: "postgres", database: "postgres" }).gaps[0].code,
      "CONTROL_D1_SOURCE_SCHEMA_UNMAPPED",
    );
    const chunkPath = path(`capture/${image.manifest.tables[0].chunks[0].file}`);
    const original = await readFile(chunkPath);
    await writeFile(chunkPath, Buffer.from("corrupt"));
    await assert.rejects(openCapture({ directory: path("capture"), key }), /CHUNK_DIGEST/u);
    await writeFile(chunkPath, original);
    await chmod(chunkPath, 0o644);
    await assert.rejects(openCapture({ directory: path("capture"), key }), /FILE_PERMISSIONS/u);
    await chmod(chunkPath, 0o600);
    await appendJournal(path("tampered.journal"), key, { phase: "first" });
    await writeFile(path("tampered.journal"), '{"event":{},"previous":"wrong","mac":"wrong"}\n');
    await assert.rejects(
      appendJournal(path("tampered.journal"), key, { phase: "second" }),
      /JOURNAL/u,
    );
    await assert.rejects(runCli(["promote"]), /COMMAND/u);
    const configPath = path("config.json");
    await writeFile(
      configPath,
      canonical({
        repositoryRoot,
        captureDirectory: path("capture"),
        sourceSchemaSha256: image.manifest.sourceSchemaSha256,
        source: { role: "postgres", database: "postgres" },
      }),
      { mode: 0o600 },
    );
    const summary = await runCli(["plan", "--config", configPath, "--key-fd", "3"], {
      readKey: () => Buffer.from(key),
    });
    assert.equal(summary.verdict, "INCOMPLETE");
    assert.equal(Object.hasOwn(summary, "records") && typeof summary.records === "number", true);
    assert.equal(Object.hasOwn(summary, "payload"), false);
    await assert.rejects(runCli(["plan", "--config", configPath, "--key-fd", "0"]), /KEY_FD/u);
    await mkdir(path("journal-directory"), { mode: 0o700 });
    const persistent = {
      repositoryRoot,
      captureDirectory: path("capture"),
      sourceSchemaSha256: image.manifest.sourceSchemaSha256,
      source: { role: "postgres", database: "postgres" },
      localTargetDirectory: path("cli-target"),
      journalDirectory: path("journal-directory"),
      targetId: "cli",
    };
    await writeFile(configPath, canonical(persistent));
    const invoke = (command) =>
      runCli([command, "--config", configPath, "--key-fd", "3"], {
        readKey: () => Buffer.from(key),
      });
    assert.equal((await invoke("import-local")).verdict, "INCOMPLETE");
    assert.equal(
      (await invoke("resume")).applied.every((chunk) => chunk.replayed),
      true,
    );
    assert.equal((await invoke("compare")).compared, true);
    assert.equal((await invoke("status")).verdict, "INCOMPLETE");
    await chmod(persistent.localTargetDirectory, 0o755);
    await assert.rejects(invoke("import-local"), /TARGET_PERMISSIONS/u);
    await chmod(persistent.localTargetDirectory, 0o700);
    // The checkout directory is named by the clone (a worktree is legitimate); the repository is identified by its manifest.
    assert.equal(
      JSON.parse(await readFile(join(resolve(repositoryRoot), "package.json"), "utf8")).name,
      "ohmyhost",
    );
  } finally {
    await local.dispose();
    await invalid.dispose();
    await unknown.dispose();
  }
});
