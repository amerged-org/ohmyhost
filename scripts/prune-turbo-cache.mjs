#!/usr/bin/env node
// Keeps the Turbo cache to the entries the latest build used. Turbo never evicts a local entry, so a
// cache restored from the previous commit and saved again would keep every output it ever stored.
// Usage: TURBO_RUN_SUMMARY=true turbo run build && node scripts/prune-turbo-cache.mjs [turbo-directory]
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HASH = /^[0-9a-f]{16}$/u;
// One entry is three files named after the task hash.
const ENTRY = /^([0-9a-f]{16})(?:\.tar\.zst|-meta\.json|-manifest\.json)$/u;

/** The task hashes of every run summary; a summary lists cache hits and misses alike. */
export async function usedTaskHashes(runsDirectory) {
  const hashes = new Set();
  for (const name of (await readdir(runsDirectory)).filter((file) => file.endsWith(".json"))) {
    const summary = JSON.parse(await readFile(join(runsDirectory, name), "utf8"));
    for (const task of summary.tasks ?? []) if (HASH.test(task.hash)) hashes.add(task.hash);
  }
  return hashes;
}

/** Removes the entries no task of the latest run used; files that are not entries stay. */
export async function pruneTurboCache(turboDirectory) {
  const used = await usedTaskHashes(join(turboDirectory, "runs"));
  const cacheDirectory = join(turboDirectory, "cache");
  const entries = (await readdir(cacheDirectory)).filter((name) => ENTRY.test(name));
  // Without a single entry of a used task the layout is not the one this tool understands.
  if (!entries.some((name) => used.has(ENTRY.exec(name)[1])))
    throw new Error("no cache entry belongs to a task of the latest run");
  const stale = entries.filter((name) => !used.has(ENTRY.exec(name)[1]));
  await Promise.all(stale.map((name) => rm(join(cacheDirectory, name))));
  return { kept: entries.length - stale.length, removed: stale.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { kept, removed } = await pruneTurboCache(process.argv[2] ?? ".turbo");
    process.stdout.write(
      `Turbo cache keeps ${kept} files of the latest build, drops ${removed}.\n`,
    );
  } catch (error) {
    // Pruning only saves cache space; it must never turn a green build red.
    process.stdout.write(`::warning::The Turbo cache is saved unpruned: ${error.message}\n`);
  }
}
