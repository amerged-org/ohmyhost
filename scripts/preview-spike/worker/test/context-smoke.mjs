/* global console */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// A scratch build exercises Docker's actual context filter without pulling or running an image.
// All Docker mutations use one explicit local Unix-socket context and newly owned identities.
const context = execFileSync("docker", ["context", "show"], { encoding: "utf8" }).trim();
assert.match(context, /^[A-Za-z0-9_.-]{1,128}$/u);
const host = execFileSync(
  "docker",
  ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
).trim();
assert.ok(host.startsWith("unix://"), "only a local Docker socket is allowed");
const run = (args, options = {}) =>
  execFileSync("docker", ["--context", context, ...args], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
const directory = await mkdtemp(join(tmpdir(), "ohmyho-preview-context-"));
const tag = `ohmyho-preview-context-smoke:${randomUUID()}`;
let imageCreated = false;
let container;
try {
  await writeFile(join(directory, "Dockerfile"), "FROM scratch\nCOPY . /context/\n");
  await copyFile(
    fileURLToPath(new URL("../Dockerfile.dockerignore", import.meta.url)),
    join(directory, "Dockerfile.dockerignore"),
  );
  await writeFile(join(directory, "fixture-provenance.json"), "synthetic public manifest\n");
  for (const folder of [
    "fixtures/cloudflare-preview/example",
    "seed-fixtures/example",
    "container",
    "tooling",
  ]) {
    await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, folder, ".env.local"), "synthetic excluded canary\n");
  }
  await writeFile(join(directory, "fixtures/cloudflare-preview/example/source.mjs"), "public\n");
  await writeFile(join(directory, "seed-fixtures/example/package.json"), "{}\n");
  await writeFile(join(directory, "container/driver.mjs"), "public\n");
  await writeFile(join(directory, "tooling/package-lock.json"), "{}\n");
  await mkdir(join(directory, "seed-fixtures/example/node_modules"));
  await writeFile(join(directory, "seed-fixtures/example/node_modules/canary"), "excluded\n");
  await writeFile(join(directory, "unrelated-canary"), "excluded\n");
  // Public fake canary only; no actual environment or credential file is read.
  await writeFile(join(directory, ".env.local"), "public-exclusion-canary-not-a-secret\n");
  run(["build", "--network=none", "--pull=false", "--quiet", "--tag", tag, directory]);
  imageCreated = true;
  container = run(["create", "--network=none", tag, "/not-executed"], { encoding: "utf8" }).trim();
  assert.match(container, /^[a-f0-9]{64}$/u);
  const archive = run(["export", container]);
  const paths = execFileSync("tar", ["-tf", "-"], { input: archive, encoding: "utf8" }).split("\n");
  for (const path of [
    "fixture-provenance.json",
    "fixtures/cloudflare-preview/example/source.mjs",
    "seed-fixtures/example/package.json",
    "container/driver.mjs",
    "tooling/package-lock.json",
  ])
    assert.ok(paths.includes(`context/${path}`), `Docker must include ${path}`);
  assert.ok(
    !paths.some((path) => path.includes(".env.local")),
    "the fake environment canary must remain excluded",
  );
  assert.ok(
    !paths.some((path) => path.includes("node_modules") || path.includes("unrelated-canary")),
  );
  console.log("Docker context smoke passed: allowed inputs included and canaries excluded.");
} finally {
  if (container) run(["rm", container], { stdio: "ignore" });
  if (imageCreated) run(["image", "rm", tag], { stdio: "ignore" });
  await rm(directory, { recursive: true, force: true });
}
