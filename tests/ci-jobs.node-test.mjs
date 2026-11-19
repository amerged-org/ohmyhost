import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import test from "node:test";
import { readFileSync } from "node:fs";

import { REQUIRED_CI_JOBS, requireSuccessfulCiJobs } from "../scripts/check-ci-jobs.mjs";

const successful = () =>
  Object.fromEntries(REQUIRED_CI_JOBS.map((name) => [name, { result: "success", outputs: {} }]));
const script = fileURLToPath(new URL("../scripts/check-ci-jobs.mjs", import.meta.url));

test("the complete CI gate requires successful matrix, merge and independent checks", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const nodeJob = workflow.match(/^ {2}node-tests:\n([\s\S]*?)^ {2}vitest:/mu)?.[1];
  assert.equal(typeof nodeJob, "string");
  assert.match(
    nodeJob,
    /pnpm --dir fixtures\/next-edge --ignore-workspace install --frozen-lockfile --ignore-scripts/u,
  );
  assert(nodeJob.indexOf("fixtures/next-edge") < nodeJob.indexOf("pnpm test:node"));
  assert.deepEqual(requireSuccessfulCiJobs(successful()), { verified: true, jobs: 7 });
  for (const name of REQUIRED_CI_JOBS) {
    for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
      const jobs = successful();
      jobs[name].result = result;
      assert.throws(() => requireSuccessfulCiJobs(jobs), /did not succeed/u);
    }
  }
});

test("the gate refuses omitted, extra and malformed verification results", () => {
  const missing = successful();
  delete missing.coverage;
  const extra = { ...successful(), undeclared: { result: "success" } };
  for (const input of [null, [], {}, missing, extra])
    assert.throws(() => requireSuccessfulCiJobs(input), /requires every/u);
  for (const job of [null, [], "success", {}])
    assert.throws(
      () => requireSuccessfulCiJobs({ ...successful(), vitest: job }),
      /did not succeed/u,
    );
});

test("the actual gate command exits unsuccessfully for a deliberately red shard result", () => {
  const invoke = (input) =>
    execFileSync(process.execPath, [script], {
      env: { ...process.env, CI_JOB_RESULTS: input },
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.deepEqual(JSON.parse(invoke(JSON.stringify(successful()))), { verified: true, jobs: 7 });
  const red = successful();
  red.vitest.result = "failure";
  for (const input of [JSON.stringify(red), "{", "", " ".repeat(65_537)])
    assert.throws(
      () => invoke(input),
      (error) => error.status === 1,
    );
});
