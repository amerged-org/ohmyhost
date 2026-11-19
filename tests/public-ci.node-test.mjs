import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("public pull requests use the complete read-only hosted verification workflow", () => {
  const ci = parse(read(".github/workflows/ci.yml"));
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(ci.on.push, { branches: ["main"] });
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.equal(Object.keys(ci.jobs).length, 8);
  assert.equal(ci.jobs.verify.needs.length, 7);
  for (const job of Object.values(ci.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.equal(job.permissions, undefined);
  }
  assert.doesNotMatch(
    read(".github/workflows/ci.yml"),
    /pull_request_target|secrets\.|macbook-ci/u,
  );
  assert.doesNotMatch(read(".github/actions/setup-workspace/action.yml"), /secrets\.|macbook-ci/u);
});
