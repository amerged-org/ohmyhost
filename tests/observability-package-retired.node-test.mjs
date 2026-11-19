import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const RETIRED = "@ohmyhost/observability";

test("the unused telemetry package is gone and no workspace package still declares it", () => {
  assert.equal(existsSync(join(root, "packages/observability")), false);
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(root, group))) {
      const manifest = join(root, group, name, "package.json");
      if (!existsSync(manifest)) continue;
      assert.equal(readFileSync(manifest, "utf8").includes(RETIRED), false, `${group}/${name}`);
    }
  }
  assert.equal(readFileSync(join(root, "pnpm-lock.yaml"), "utf8").includes(RETIRED), false);
});
