import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { pruneTurboCache, usedTaskHashes } from "../scripts/prune-turbo-cache.mjs";

const script = fileURLToPath(new URL("../scripts/prune-turbo-cache.mjs", import.meta.url));
const entry = (hash) => [`${hash}.tar.zst`, `${hash}-meta.json`, `${hash}-manifest.json`];

/** A Turbo directory whose cache holds the given hashes and whose run summaries list the used ones. */
async function turboDirectory({ cached, summaries, others = [] }) {
  const directory = await mkdtemp(join(tmpdir(), "prune-turbo-"));
  await mkdir(join(directory, "cache"), { recursive: true });
  await mkdir(join(directory, "runs"), { recursive: true });
  for (const name of [...cached.flatMap(entry), ...others])
    await writeFile(join(directory, "cache", name), "x");
  for (const [index, hashes] of summaries.entries())
    await writeFile(
      join(directory, "runs", `run${index}.json`),
      JSON.stringify({ tasks: hashes.map((hash) => ({ hash })) }),
    );
  return directory;
}

const names = async (directory) => (await readdir(join(directory, "cache"))).sort();

test("only the entries that tasks of the latest run used stay in the cache", async () => {
  const directory = await turboDirectory({
    cached: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"],
    // A hit and a miss are both used; a summary file of another run adds its tasks.
    summaries: [["aaaaaaaaaaaaaaaa", "not-a-hash"], ["bbbbbbbbbbbbbbbb"]],
    others: ["notes.txt", "ddddddddddddddd.tar.zst"],
  });
  try {
    assert.deepEqual(
      await usedTaskHashes(join(directory, "runs")),
      new Set(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]),
    );
    assert.deepEqual(await pruneTurboCache(directory), { kept: 6, removed: 3 });
    // Files that do not look like one of Turbo's three entry files are never touched.
    assert.deepEqual(
      await names(directory),
      [
        ...entry("aaaaaaaaaaaaaaaa"),
        ...entry("bbbbbbbbbbbbbbbb"),
        "ddddddddddddddd.tar.zst",
        "notes.txt",
      ].sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cache that cannot be matched to the latest run is left as it is", async () => {
  const unmatched = await turboDirectory({
    cached: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    summaries: [["cccccccccccccccc"]],
  });
  const noSummary = await turboDirectory({ cached: ["aaaaaaaaaaaaaaaa"], summaries: [] });
  const broken = await turboDirectory({ cached: ["aaaaaaaaaaaaaaaa"], summaries: [[]] });
  await writeFile(join(broken, "runs", "run0.json"), "{ not json");
  const missing = await mkdtemp(join(tmpdir(), "prune-turbo-"));
  try {
    for (const directory of [unmatched, noSummary, broken])
      await assert.rejects(pruneTurboCache(directory));
    await assert.rejects(pruneTurboCache(missing), /ENOENT/u);
    assert.equal((await names(unmatched)).length, 6);
    assert.equal((await names(noSummary)).length, 3);
    assert.equal((await names(broken)).length, 3);
  } finally {
    await Promise.all(
      [unmatched, noSummary, broken, missing].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
});

test("the command prunes, and only warns, never fails, when it cannot", async () => {
  const usable = await turboDirectory({
    cached: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    summaries: [["aaaaaaaaaaaaaaaa"]],
  });
  const unusable = await turboDirectory({ cached: ["aaaaaaaaaaaaaaaa"], summaries: [] });
  const run = (directory) =>
    execFileSync(process.execPath, [script, directory], { encoding: "utf8" });
  try {
    assert.match(run(usable), /keeps 3 files of the latest build, drops 3\./u);
    assert.deepEqual(await names(usable), entry("aaaaaaaaaaaaaaaa").sort());
    assert.match(run(unusable), /^::warning::The Turbo cache is saved unpruned: /u);
    assert.equal((await names(unusable)).length, 3);
  } finally {
    await Promise.all(
      [usable, unusable].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});
