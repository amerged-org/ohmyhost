#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import process from "node:process";

export const REQUIRED_CI_JOBS = Object.freeze([
  "secret-scan",
  "static",
  "build",
  "boundaries",
  "node-tests",
  "vitest",
  "coverage",
]);

/** A skipped matrix or missing merge result can never approve the whole workflow. */
export function requireSuccessfulCiJobs(results) {
  if (
    results === null ||
    typeof results !== "object" ||
    Array.isArray(results) ||
    Object.keys(results).length !== REQUIRED_CI_JOBS.length ||
    REQUIRED_CI_JOBS.some((name) => !Object.hasOwn(results, name))
  ) {
    throw new Error("CI gate requires every declared verification job result");
  }
  for (const name of REQUIRED_CI_JOBS) {
    const job = results[name];
    if (job === null || typeof job !== "object" || Array.isArray(job) || job.result !== "success") {
      throw new Error(`CI verification job ${name} did not succeed`);
    }
  }
  return Object.freeze({ verified: true, jobs: REQUIRED_CI_JOBS.length });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = process.env.CI_JOB_RESULTS;
    if (typeof input !== "string" || input.length === 0 || input.length > 65_536)
      throw new Error("CI job results are missing or exceed the input limit");
    process.stdout.write(`${JSON.stringify(requireSuccessfulCiJobs(JSON.parse(input)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
