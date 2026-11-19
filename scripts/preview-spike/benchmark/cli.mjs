#!/usr/bin/env node
/* global process */
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createJournal, recoverJournal } from "./journal.mjs";
import { runBenchmark } from "./runner.mjs";
import { evaluate, validateConfig } from "./statistics.mjs";

async function main(args) {
  if (["report", "report-observations"].includes(args[0]) && args.length === 2) {
    const recovered = await recoverJournal(args[1]);
    const report = evaluate(recovered.events);
    if (recovered.incompleteTail) {
      report.integrity = false;
      report.observationsComplete = false;
      report.frameworkTargets = "failed";
      for (const state of Object.values(report.states)) {
        state.latencyTargetMet = false;
        state.acceptance = false;
      }
    }
    report.reportScope =
      args[0] === "report" ? "product-acceptance" : "framework-target-observations";
    report.journalIncompleteTail = recovered.incompleteTail;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.frameworkTargets === "failed") return 1;
    if (args[0] === "report-observations") return report.frameworkTargets === "passed" ? 0 : 2;
    return report.overallAcceptance === "passed" ? 0 : 2;
  }
  if (args[0] !== "run" || args.length !== 4) throw new Error("usage_invalid");
  const config = JSON.parse(await readFile(args[1], "utf8"));
  validateConfig(config);
  // The caller selects a reviewed, local provider adapter. It is not a server-supplied URL.
  const adapterModule = await import(pathToFileURL(await realpath(args[2])).href);
  if (typeof adapterModule.createAdapter !== "function") throw new Error("adapter_invalid");
  const journal = await createJournal(args[3]);
  let adapter, resourceJournal;
  try {
    resourceJournal = await createJournal(`${args[3]}.resources.private.jsonl`);
    adapter = await adapterModule.createAdapter(config, { resourceJournal });
    const result = await runBenchmark({ adapter, journal, config });
    process.stdout.write(
      result.completed
        ? "Benchmark observations recorded.\n"
        : "Benchmark interrupted; reconcile the journal.\n",
    );
    return result.completed ? 0 : 1;
  } finally {
    // Local browser/process cleanup only; provider mutations after an uncertain outcome are forbidden.
    try {
      if (adapter && typeof adapter.closeLocal === "function") await adapter.closeLocal();
    } finally {
      try {
        if (resourceJournal) await resourceJournal.close();
      } finally {
        await journal.close();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Benchmark stopped; retain and inspect the private journal before retrying.\n",
    );
    process.exitCode = 1;
  }
}
