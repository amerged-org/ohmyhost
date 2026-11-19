/* global structuredClone */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { testPostgresEnvironment } from "../scripts/test-postgres-path.mjs";
import { parseSysvSegmentIds } from "../scripts/test-shards.mjs";

import {
  assertGlobalCoverage,
  describeFiles,
  partitionFiles,
  validateReports,
  workerLimit,
} from "../scripts/vitest-shards.mjs";

const root = "/checkout";
const file = (name, state = "pass") => ({
  filepath: `${root}/${name}`,
  projectName: "",
  pool: "forks",
  type: "suite",
  mode: "run",
  result: { state },
  tasks: [{ id: name, type: "test", name: "checks behavior", mode: "run", result: { state } }],
});

test(
  "SIGTERM lets an active PostgreSQL test finish afterAll before exiting red",
  { timeout: 30_000 },
  async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const environment = testPostgresEnvironment();
    const pgCtl = path.join(environment.OHMYHOST_TEST_POSTGRES_BIN, "pg_ctl");
    const segments = () => parseSysvSegmentIds(execFileSync("ipcs", ["-m"], { encoding: "utf8" }));
    const before = segments();
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await mkdir(path.join(root, ".ohmyhost"), { recursive: true });
    const directory = await mkdtemp(path.join(root, ".ohmyhost", "vitest-shards-abort-"));
    const relative = path.relative(root, directory).split(path.sep).join("/");
    const data = path.join(directory, "data");
    let child;
    try {
      await writeFile(path.join(directory, "source.ts"), "export function answer(){return 42};\n");
      await writeFile(
        path.join(directory, "pg.test.ts"),
        `
import{afterAll,beforeAll,expect,test}from'vitest';
import{execFile}from'node:child_process';import{promisify}from'node:util';import{writeFile}from'node:fs/promises';
import{answer}from'./source';
const run=promisify(execFile);let started=false;
beforeAll(async()=>{
 await run('initdb',['-D',${JSON.stringify(data)},'-A','trust','-U','postgres']);
 await run('pg_ctl',['-D',${JSON.stringify(data)},'-l',${JSON.stringify(path.join(directory, "postgres.log"))},'-o',${JSON.stringify(`-F -p ${port} -h 127.0.0.1 -k ''`)},'-w','start']);started=true;
},10000);
afterAll(async()=>{if(started)await run('pg_ctl',['-D',${JSON.stringify(data)},'-m','fast','-w','stop']);await writeFile(${JSON.stringify(path.join(directory, "closed"))},'closed');},10000);
test('query completes and cleanup survives cancellation',async()=>{
 console.log('shard-pg-abort-ready');
 await run('psql',['-h','127.0.0.1','-p',${JSON.stringify(String(port))},'-U','postgres','-d','postgres','-c','SELECT pg_sleep(1)']);
 expect(answer()).toBe(42);
});
`,
      );
      const config = path.join(directory, "config.mjs");
      await writeFile(
        config,
        `export default {test:{include:[${JSON.stringify(`${relative}/pg.test.ts`)}],coverage:{provider:'v8',include:[${JSON.stringify(`${relative}/source.ts`)}],exclude:[],thresholds:{functions:100}}}};\n`,
      );
      const inventory = {
        files: [{ path: `${relative}/pg.test.ts` }],
        coverageFiles: [`${relative}/source.ts`],
        shards: [{ index: 1, files: [`${relative}/pg.test.ts`] }],
      };
      const program = `import{executeShard}from${JSON.stringify(pathToFileURL(path.join(root, "scripts/vitest-shards.mjs")).href)};await executeShard(${JSON.stringify({ inventory, shard: 1, output: path.join(directory, "output"), root, config })});`;
      child = spawn(process.execPath, ["--input-type=module", "-e", program], {
        cwd: root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let sent = false;
      let during;
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!sent && output.includes("shard-pg-abort-ready")) {
          sent = true;
          during = segments();
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert(sent, output);
      assert.equal(exitCode, 1, output);
      assert.equal(
        await readFile(path.join(directory, "closed"), "utf8").catch(() => output),
        "closed",
      );
      assert.throws(
        () => execFileSync(pgCtl, ["-D", data, "status"], { stdio: "pipe" }),
        (error) => error.status === 3,
      );
      const after = segments();
      assert.deepEqual(
        [...after].filter((id) => !before.has(id)),
        [],
      );
      const probe = createServer();
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
      process.stdout.write(
        `PostgreSQL abort proof: ${JSON.stringify({ exitCode, signalSent: sent, portReleased: true, beforeIds: [...before], duringIds: [...during], afterIds: [...after] })}\n`,
      );
    } finally {
      child?.kill("SIGKILL");
      try {
        execFileSync(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe" });
      } catch {
        /* The expected path already stopped this exact temporary cluster. */
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function fixture() {
  const files = [file("a.test.ts"), file("b.test.ts")];
  const inventory = {
    schemaVersion: 1,
    vitestVersion: "4.1.12",
    root,
    identity: { commit: "a".repeat(40), sourceDigest: "b".repeat(64) },
    files: describeFiles(files, root),
    coverageFiles: ["src/a.ts"],
    shards: partitionFiles(describeFiles(files, root), 2),
  };
  const reports = inventory.shards.map((shard) => {
    const selected = files.filter((entry) =>
      shard.files.includes(entry.filepath.slice(root.length + 1)),
    );
    return {
      evidence: {
        schemaVersion: 1,
        inventoryDigest: "c".repeat(64),
        identity: inventory.identity,
        root,
        vitestVersion: "4.1.12",
        shard: shard.index,
        status: "passed",
        exitCode: 0,
      },
      blob: [
        "4.1.12",
        selected,
        [],
        {
          "/checkout/src/a.ts": {
            path: "/checkout/src/a.ts",
            statementMap: {},
            fnMap: {},
            branchMap: {},
            s: {},
            f: {},
            b: {},
          },
        },
        1,
        {},
      ],
    };
  });
  return { inventory, reports, inventoryDigest: "c".repeat(64) };
}

test("inventory identifies a real failed collection module without logging its error payload", async (context) => {
  const repository = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(repository, ".ohmyhost"), { recursive: true });
  const directory = await mkdtemp(path.join(repository, ".ohmyhost", "inventory-diagnostic-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const relative = path.relative(repository, directory).split(path.sep).join("/");
  const marker = "synthetic-collection-payload-never-print";
  await writeFile(path.join(directory, "source.ts"), "export const answer = () => 42;\n");
  await writeFile(
    path.join(directory, "broken.test.ts"),
    `import { test } from 'vitest'; throw new Error(${JSON.stringify(marker)}); test('unreachable', () => {});\n`,
  );
  const config = path.join(directory, "config.mjs");
  await writeFile(
    config,
    `export default {test:{include:[${JSON.stringify(`${relative}/broken.test.ts`)}],coverage:{provider:'v8',include:[${JSON.stringify(`${relative}/source.ts`)}],exclude:[],thresholds:{functions:100}}}};\n`,
  );
  const program = `import {createInventory} from ${JSON.stringify(pathToFileURL(path.join(repository, "scripts/vitest-shards.mjs")).href)};try{await createInventory(${JSON.stringify({ root: repository, output: path.join(directory, "inventory.json"), shards: 1, config })});}catch{process.exitCode=1;}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    cwd: repository,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 1);
  const line = output
    .split("\n")
    .find((value) => value.startsWith("Inventory collection diagnostics: "));
  assert.ok(line, "A failed collection must expose bounded module/category diagnostics");
  const diagnostics = JSON.parse(line.slice("Inventory collection diagnostics: ".length));
  assert.equal(diagnostics.specifications, 1);
  assert.equal(diagnostics.modules, 1);
  assert.equal(diagnostics.failedModuleCount, 1);
  assert.equal(diagnostics.failedModules[0].path, `${relative}/broken.test.ts`);
  assert.equal(diagnostics.failedModules[0].errorNames[0], "Error");
  assert.ok(!output.includes(marker), "Raw collection error payloads must remain private");
  await assert.rejects(readFile(path.join(directory, "inventory.json")), { code: "ENOENT" });
});

test("deterministic shards are a complete nonempty disjoint partition", () => {
  const files = ["c.test.ts", "a.test.ts", "b.test.ts"].map((name) => ({ path: name }));
  assert.deepEqual(partitionFiles(files, 2), partitionFiles([...files].reverse(), 2));
  assert.deepEqual(
    partitionFiles(files, 2)
      .flatMap((shard) => shard.files)
      .sort(),
    files.map((entry) => entry.path).sort(),
  );
  for (const count of [0, 1.5, 4, NaN]) assert.throws(() => partitionFiles(files, count));
  assert.throws(() => partitionFiles([...files, files[0]], 2));
});

test("files without a timing weigh as much as the median known timing", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => ({ path: `${name}.test.ts` }));
  const timings = { "a.test.ts": 10, "b.test.ts": 30, "c.test.ts": 20, "stale.test.ts": 9999 };
  const shards = partitionFiles(files, 2, timings);
  // d and e are unknown: they count 20 ms each (median of 10, 20, 30), not 1 ms.
  assert.deepEqual(
    shards.map(({ files: assigned, estimatedDurationMs }) => [assigned, estimatedDurationMs]),
    [
      [["b.test.ts", "e.test.ts"], 50],
      [["a.test.ts", "c.test.ts", "d.test.ts"], 50],
    ],
  );
  assert.deepEqual(partitionFiles([...files].reverse(), 2, timings), shards);
  // Without any known timing every file keeps the neutral 1 ms weight.
  assert.deepEqual(
    partitionFiles(files, 2).map((shard) => shard.estimatedDurationMs),
    [3, 2],
  );
});

test("only the inventory stage collects in parallel, capped at four workers", () => {
  assert.deepEqual(
    [1, 2, 4, 18].map((available) => workerLimit("inventory", available)),
    [1, 2, 4, 4],
  );
  for (const stage of ["run", "merge"]) assert.equal(workerLimit(stage, 18), 1);
});

test("merge requires every shard exactly once with the expected full test inventory", () => {
  const value = fixture();
  assert.equal(validateReports(value).tests, 2);
  for (const alter of [
    (v) => v.reports.pop(),
    (v) => v.reports.push(v.reports[0]),
    (v) => {
      v.reports[1].evidence.shard = 1;
    },
    (v) => {
      v.reports[0].evidence.status = "failed";
    },
    (v) => {
      v.reports[0].evidence.exitCode = 1;
    },
    (v) => {
      v.reports[0].evidence.identity.commit = "d".repeat(40);
    },
    (v) => {
      v.reports[0].evidence.inventoryDigest = "e".repeat(64);
    },
    (v) => {
      v.reports[0].evidence.root = "/other";
    },
    (v) => {
      v.reports[0].blob[0] = "4.0.0";
    },
    (v) => {
      v.reports[0].blob[2].push({ message: "unhandled rejection" });
    },
    (v) => {
      v.reports[0].blob[3] = null;
    },
    (v) => {
      delete v.inventory.coverageFiles;
    },
    (v) => {
      v.reports[0].blob[3]["/checkout/src/b.ts"] = v.reports[0].blob[3]["/checkout/src/a.ts"];
    },
    (v) => {
      delete v.reports[0].blob[3]["/checkout/src/a.ts"].fnMap;
    },
    (v) => {
      v.reports[0].blob[3]["/checkout/src/a.ts"].path = "/checkout/src/b.ts";
    },
    (v) => {
      v.reports[0].blob[3]["/checkout/src/a.ts"].fnMap = { 0: {} };
    },
    (v) => {
      v.reports[0].blob[3]["/checkout/src/a.ts"].fnMap = { 0: {} };
      v.reports[0].blob[3]["/checkout/src/a.ts"].f = { 0: -1 };
    },
    (v) => {
      v.reports[0].blob[1][0].tasks = [];
    },
    (v) => {
      v.reports[0].blob[1][0].tasks.push(v.reports[0].blob[1][0].tasks[0]);
    },
    (v) => {
      v.reports[0].blob[1][0].tasks[0].name = "another test";
    },
    (v) => {
      v.reports[0].blob[1][0].tasks[0].result.state = "fail";
    },
    (v) => {
      v.reports[0].blob[1][0].result.state = "fail";
    },
    (v) => {
      v.reports[0].blob[1][0].tasks[0].mode = "skip";
    },
    (v) => {
      v.reports[0].blob[1].push(v.reports[1].blob[1][0]);
    },
  ]) {
    const candidate = structuredClone(value);
    // Reports must not share their identity object with the inventory under test.
    candidate.reports = structuredClone(candidate.reports);
    alter(candidate);
    assert.throws(() => validateReports(candidate));
  }
});

test("global coverage requires nonempty exact function totals, not rounded percentage", () => {
  assert.doesNotThrow(() =>
    assertGlobalCoverage({
      total: { functions: { total: 40, covered: 40, skipped: 0, pct: 100 } },
    }),
  );
  for (const functions of [
    { total: 100001, covered: 100000, skipped: 0, pct: 100 },
    { total: 0, covered: 0, skipped: 0, pct: 100 },
    { total: 40, covered: 40, skipped: 1, pct: 100 },
    { total: 40, covered: 39, skipped: 0, pct: 97.5 },
  ])
    assert.throws(() => assertGlobalCoverage({ total: { functions } }));
});

test("real V8 blobs merge complementary coverage and reject an uncovered function", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".ohmyhost"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".ohmyhost", "vitest-shards-test-"));
  const relative = path.relative(root, directory).split(path.sep).join("/");
  const tool = pathToFileURL(path.join(root, "scripts/vitest-shards.mjs")).href;
  try {
    await writeFile(
      path.join(directory, "source.ts"),
      "export function one(){return 1}; export function two(){return 2};\n",
    );
    for (const [name, number] of [
      ["one", 1],
      ["two", 2],
    ]) {
      await writeFile(
        path.join(directory, `${name}.test.ts`),
        `import {test,expect,describe} from 'vitest';import {${name}} from './source';test('${name}',()=>expect(${name}()).toBe(${number})); describe.skip('not scheduled',()=>test('not run',()=>{throw new Error('must not execute')}));\n`,
      );
    }
    const config = path.join(directory, "config.mjs");
    await writeFile(
      config,
      `export default {test:{include:[${JSON.stringify(`${relative}/*.test.ts`)}],coverage:{provider:'v8',include:[${JSON.stringify(`${relative}/source.ts`)}],exclude:[],thresholds:{functions:100}}}};\n`,
    );
    // Each execution happens in a real child process. The test harness only
    // records a successful receipt after that process has exited successfully.
    const proof = path.join(directory, "proof.mjs");
    await writeFile(
      proof,
      `
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{execFileSync}from'node:child_process';
import{createHash}from'node:crypto';
import path from'node:path';
import process from'node:process';
import{createInventory,mergeShards}from${JSON.stringify(tool)};
const root=${JSON.stringify(root)},config=${JSON.stringify(config)},directory=${JSON.stringify(directory)};
const output=path.join(directory,process.argv[2]);await mkdir(output);
const inventoryFile=path.join(output,'inventory.json');
const inventory=await createInventory({root,output:inventoryFile,shards:2,config});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventoryDigest=digest(await readFile(inventoryFile));
for(const shard of [1,2]){
 const shardOutput=path.join(output,'shard-'+shard);await mkdir(shardOutput);
 const program='import{executeShard}from'+JSON.stringify(${JSON.stringify(tool)})+';await executeShard('+JSON.stringify({inventory,shard,output:shardOutput,root,config})+');';
 execFileSync(process.execPath,['--input-type=module','-e',program],{cwd:root,stdio:'pipe'});
 const blob=await readFile(path.join(shardOutput,'blob.json'));
 await writeFile(path.join(shardOutput,'evidence.json'),JSON.stringify({schemaVersion:1,vitestVersion:'4.1.12',root,identity:inventory.identity,inventoryDigest,shard,exitCode:0,status:'passed',blobDigest:digest(blob)}));
}
await mergeShards({inventoryFile,input:output,output:path.join(output,'merged'),root,config});
`,
    );
    execFileSync(process.execPath, [proof, "covered"], {
      cwd: root,
      stdio: "pipe",
      timeout: 60_000,
    });
    const summary = JSON.parse(
      await readFile(path.join(directory, "covered/merged/summary.json"), "utf8"),
    );
    assert.equal(summary.tests, 4);
    assert.equal(summary.functions.covered, 2);
    assert.equal(summary.functions.total, 2);
    await writeFile(
      path.join(directory, "source.ts"),
      "export function one(){return 1}; export function two(){return 2}; export function uncovered(){return 3};\n",
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [proof, "uncovered"], {
          cwd: root,
          stdio: "pipe",
          timeout: 60_000,
        }),
      (error) =>
        error.status === 1 &&
        error.stderr
          .toString()
          .includes("Coverage for functions (66.66%) does not meet global threshold (100%)"),
    );
    await assert.rejects(readFile(path.join(directory, "uncovered/merged/summary.json")), {
      code: "ENOENT",
    });
    const setup = path.join(directory, "setup.mjs");
    await writeFile(setup, "export default ()=>()=>{throw new Error('failed global teardown')};\n");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace(
        "coverage:",
        `globalSetup:[${JSON.stringify(setup)}],coverage:`,
      ),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [proof, "teardown"], {
          cwd: root,
          stdio: "pipe",
          timeout: 60_000,
        }),
      (error) => error.status === 1 && error.stderr.toString().includes("Vitest cleanup failed"),
    );
    await assert.rejects(readFile(path.join(directory, "teardown/inventory.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
