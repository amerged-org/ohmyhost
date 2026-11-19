import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { creditPricingRates } from "../scripts/credit-pricing-document.mjs";

test("website inputs are written only into a named website clone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-web-inputs-"));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../scripts/prepare-web-inputs.mjs")],
      { cwd: directory, encoding: "utf8", timeout: 120_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: prepare-web-inputs\.mjs <path-to-ohmyhost-web>/u);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy content keeps canonical rates while the website exports only current PGCF database prices", async (context) => {
  const root = resolve(import.meta.dirname, "..");
  // The release manifest is written by public-clients:prepare into a gitignored directory. A checkout without the
  // released client gets a manifest for this HEAD for the length of the check, and never overwrites a real one.
  const version = JSON.parse(
    await readFile(join(root, "apps/product-cli/package.json"), "utf8"),
  ).version;
  const releaseDirectory = join(root, "apps/public-site/public/releases", version);
  const manifest = join(releaseDirectory, "manifest.json");
  if (!existsSync(manifest)) {
    const created = !existsSync(releaseDirectory);
    await mkdir(releaseDirectory, { recursive: true });
    await writeFile(
      manifest,
      JSON.stringify({
        version,
        source_commit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      }),
    );
    context.after(() =>
      created
        ? rm(releaseDirectory, { recursive: true, force: true })
        : rm(manifest, { force: true }),
    );
  }
  const rates = await creditPricingRates(root);
  assert.ok(
    rates["neon.storage.root"],
    "legacy content still resolves its canonical storage meter",
  );
  assert.ok(
    rates["pgcf.memory.active"],
    "the canonical contract also contains current PGCF pricing",
  );
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-web-current-prices-"));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(root, "scripts/prepare-web-inputs.mjs"), directory],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const inputs = JSON.parse(await readFile(join(directory, "platform-inputs.json"), "utf8"));
    assert.deepEqual(inputs.creditRates["pgcf.memory.active"], rates["pgcf.memory.active"]);
    assert.equal(
      Object.keys(inputs.creditRates).some((meter) => meter.startsWith("neon.")),
      false,
    );
    assert.match(inputs.creditPricingTable, /pgcf\.memory\.active/u);
    assert.doesNotMatch(inputs.creditPricingTable, /neon\./u);
    assert.deepEqual(
      Object.keys(inputs.creditRates).sort(),
      Object.keys(rates)
        .filter((meter) => !meter.startsWith("neon."))
        .sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
