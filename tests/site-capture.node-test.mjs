/* global process, Buffer, URL */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PLAYWRIGHT_VERSION,
  evidenceFileName,
  evidenceTargets,
  manifestEntry,
  parseArguments,
  pngSize,
  resolvePlaywright,
} from "../scripts/site-capture.mjs";

test("evidence targets crop competitor pricing tables and capture own pages whole", () => {
  const targets = evidenceTargets("http://127.0.0.1:8787/");
  const competitors = targets.filter((target) => target.crop);
  assert.equal(competitors.length, 6);
  assert.deepEqual(
    competitors.map((target) => target.host),
    ["vercel.com", "supabase.com", "resend.com", "railway.com", "render.com", "fly.io"],
  );
  const own = targets.filter((target) => !target.crop);
  assert.ok(own.every((target) => target.url.startsWith("http://127.0.0.1:8787/")));
  assert.equal(own[0].slug, "home");
  assert.equal(
    own.find((target) => target.url.endsWith("/pricing/breakdown")).slug,
    "pricing-breakdown",
  );
  assert.equal(
    evidenceFileName("Before", competitors[0], "table", "png"),
    "before--vercel.com--pricing--1440x900@2--table.png",
  );
});

test("manifest entries carry the byte count and SHA-256 and Playwright resolves only the pinned version", () => {
  const entry = manifestEntry(Buffer.from("evidence"), { url: "https://example.test" });
  assert.equal(entry.bytes, 8);
  assert.equal(entry.sha256, "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e");
  assert.equal(entry.url, "https://example.test");
  const home = mkdtempSync(join(tmpdir(), "site-capture-"));
  try {
    for (const [hash, version] of [
      ["stale", "1.50.0"],
      ["pinned", PLAYWRIGHT_VERSION],
    ]) {
      const directory = join(home, ".npm", "_npx", hash, "node_modules", "playwright");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
    }
    assert.equal(
      resolvePlaywright({ home, override: undefined }),
      join(home, ".npm", "_npx", "pinned", "node_modules", "playwright"),
    );
    assert.throws(
      () => resolvePlaywright({ home, version: "9.9.9", override: undefined }),
      /Playwright 9\.9\.9 not found/u,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000004b00000027608060000", "hex");
  assert.deepEqual(pngSize(png), { width: 1200, height: 630 });
  assert.throws(() => pngSize(Buffer.from("not a png")), /Not a PNG/u);
  assert.deepEqual(parseArguments(["evidence", "--label", "before", "--out", "x"]), {
    command: "evidence",
    options: { label: "before", out: "x" },
  });
  assert.throws(() => parseArguments(["evidence", "--label"]), /Invalid option/u);
});

test("the CLI fails closed on an unknown command or a missing Playwright and writes nothing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "site-capture-cli-"));
  try {
    const script = new URL("../scripts/site-capture.mjs", import.meta.url).pathname;
    const unknown = spawnSync(process.execPath, [script, "shots"], { cwd, encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command: shots/u);
    const unbuilt = spawnSync(process.execPath, [script, "og", "--playwright", join(cwd, "nope")], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(unbuilt.status, 1);
    const missing = spawnSync(
      process.execPath,
      [script, "evidence", "--label", "before", "--out", "out", "--playwright", join(cwd, "nope")],
      { cwd, encoding: "utf8" },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Playwright .* not found/u);
    assert.equal(existsSync(join(cwd, "out")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
