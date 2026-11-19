import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultOutput = path.join(repositoryRoot, "scripts/ci-test-durations.json");
const repository = "amerged-org/ohmyhost";
// Keep in step with the shard matrix in .github/workflows/ci.yml.
const shardCount = 6;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Reads shard-1..shard-N/evidence.json from a directory (a CI run's artifacts) and
// rejects anything that is not one complete, passed, single-commit shard set.
export async function readEvidence(input, count = shardCount) {
  const reports = [];
  for (let shard = 1; shard <= count; shard += 1) {
    const file = path.join(input, `shard-${shard}`, "evidence.json");
    const evidence = JSON.parse(await readFile(file, "utf8"));
    assert(evidence.shard === shard, `Evidence in shard-${shard} belongs to another shard`);
    reports.push(evidence);
  }
  return reports;
}

export function buildTimings(reports, count = shardCount) {
  assert(reports.length === count, "Missing or extra shard evidence");
  const [first] = reports;
  assert(
    typeof first.inventoryDigest === "string" && typeof first.identity?.commit === "string",
    "Evidence lacks the inventory digest or commit",
  );
  const timings = {};
  for (const evidence of reports) {
    assert(
      evidence.inventoryDigest === first.inventoryDigest &&
        evidence.identity?.commit === first.identity.commit,
      "Shards come from different inventories or commits",
    );
    assert(evidence.status === "passed", `Shard ${evidence.shard} did not pass`);
    assert(
      Array.isArray(evidence.perFile) && evidence.perFile.length > 0,
      `Shard ${evidence.shard} has no per-file durations`,
    );
    for (const { path: file, durationMs } of evidence.perFile) {
      assert(typeof file === "string" && file !== "", "Invalid test file path");
      assert(!(file in timings), `Duplicate test file ${file}`);
      assert(Number.isFinite(durationMs) && durationMs >= 0, `Invalid duration for ${file}`);
      timings[file] = Math.max(Math.round(durationMs), 1);
    }
  }
  return Object.fromEntries(
    Object.entries(timings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function compareTimings(timings, files) {
  const known = new Set(Object.keys(timings));
  const expected = new Set(files);
  return {
    missing: [...expected].filter((file) => !known.has(file)).sort(),
    stale: [...known].filter((file) => !expected.has(file)).sort(),
  };
}

function downloadRun(run, directory) {
  for (let shard = 1; shard <= shardCount; shard += 1)
    execFileSync(
      "gh",
      [
        "run",
        "download",
        run,
        "--repo",
        repository,
        "--name",
        `shard-${shard}`,
        "--dir",
        path.join(directory, `shard-${shard}`),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
}

async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      run: { type: "string" },
      input: { type: "string" },
      inventory: { type: "string" },
      output: { type: "string" },
      check: { type: "boolean" },
      strict: { type: "boolean" },
    },
    strict: true,
  });
  assert(Boolean(values.run) !== Boolean(values.input), "Pass exactly one of --run or --input");
  assert(!values.run || /^\d+$/.test(values.run), "--run expects a GitHub run ID");
  assert(!values.strict || values.check, "--strict requires --check");
  const output = path.resolve(values.output ?? defaultOutput);
  const scratch = values.run ? await mkdtemp(path.join(tmpdir(), "ci-durations-")) : undefined;
  try {
    if (scratch) downloadRun(values.run, scratch);
    const reports = await readEvidence(scratch ?? path.resolve(values.input));
    const timings = buildTimings(reports);
    if (!values.check) {
      await writeFile(output, json(timings));
      return `Wrote ${Object.keys(timings).length} timings from commit ${reports[0].identity.commit} to ${output}`;
    }
    const current = JSON.parse(await readFile(output, "utf8"));
    const files = values.inventory
      ? JSON.parse(await readFile(path.resolve(values.inventory), "utf8")).files.map(
          (file) => file.path,
        )
      : Object.keys(timings);
    const { missing, stale } = compareTimings(current, files);
    if (missing.length + stale.length > 0 && values.strict) process.exitCode = 1;
    return `${missing.length} test files lack a timing, ${stale.length} timings are stale in ${output}`;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2))
    .then((message) => process.stdout.write(`${message}\n`))
    .catch((error) => {
      process.stderr.write(`Test duration update failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
