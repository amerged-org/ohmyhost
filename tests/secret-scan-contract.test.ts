import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const readText = (path: string) =>
  readFile(new globalThis.URL(`../${path}`, import.meta.url), "utf8");

test("public CI scans the exported source with a redacted, isolated Gitleaks container", async () => {
  const [workflow, config] = await Promise.all([
    readText(".github/workflows/ci.yml"),
    readText(".gitleaks.toml"),
  ]);
  assert.match(workflow, /^ {2}secret-scan:/mu);
  assert.match(workflow, /ghcr\.io\/gitleaks\/gitleaks@sha256:[a-f0-9]{64}/u);
  assert.match(workflow, /docker\s+run\s+--rm\s+--network\s+none/u);
  assert.match(workflow, /-v "\$GITHUB_WORKSPACE:\/repo:ro"/u);
  assert.match(workflow, /dir \/repo/u);
  assert.match(workflow, /--redact=100\b/u);
  assert.match(workflow, /--ignore-gitleaks-allow\b/u);
  assert.match(workflow, /--max-archive-depth=2\b/u);
  assert.match(config, /^useDefault = true$/mu);
  const exceptions = config.trim().split("[[allowlists]]").slice(1);
  assert.ok(exceptions.length);
  for (const entry of exceptions) {
    assert.match(entry, /^condition = "AND"$/mu);
    assert.match(entry, /^targetRules = \["[a-z0-9-]+"\]$/mu);
    assert.match(entry, /^regexTarget = "match"$/mu);
    const path = entry.match(/^paths = \[("(?:[^"\\]|\\.)+")\]$/mu)?.[1];
    const match = entry.match(/^regexes = \[("(?:[^"\\]|\\.)+")\]$/mu)?.[1];
    assert.ok(path && match);
    assert.match(JSON.parse(path), /^\(\?:\^\|\/\)[a-zA-Z0-9_./\\-]+\$$/u);
    assert.match(JSON.parse(match), /^\^(?:\\x[a-f0-9]{2})+\$$/u);
  }
});
