/* global console */
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FIXTURE_NAMES } from "./provenance.mjs";
import { HMR_OVERLAY_FIXTURES, hmrOverlaySha256 } from "./container/hmr-probe.mjs";

// A pinned Git archive, not the local checkout, is the only fixture input to Docker.
// The builder never receives .env.local, worktree credentials, or unrelated project files.
const commit = "67c2c0cc04c4a257dcb82b062b61b30ae6c250fd";
const root = dirname(fileURLToPath(import.meta.url));

// Never seed from arbitrary files: these exact public inputs are extracted from the
// pinned archive. The separate directory keeps source-only edits out of the seed key.
export async function prepareSeedFixtures(fixtureRoot, seedRoot) {
  for (const fixture of FIXTURE_NAMES) {
    const source = join(fixtureRoot, fixture);
    const destination = join(seedRoot, fixture);
    await mkdir(destination, { recursive: true });
    const lock = fixture === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml";
    for (const file of ["package.json", lock]) {
      const from = join(source, file);
      if (!(await lstat(from)).isFile()) throw new Error("fixture_seed_file_invalid");
      await copyFile(from, join(destination, file));
    }
  }
}

export async function initializeBuildContext(target) {
  let existing;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const markerPath = join(target, ".preview-spike-context");
  if (existing) {
    if (!existing.isDirectory()) throw new Error("unexpected_build_context");
    let markerStatus;
    try {
      markerStatus = await lstat(markerPath);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("unexpected_build_context");
      throw error;
    }
    if (!markerStatus.isFile()) throw new Error("unexpected_build_context");
    const marker = await readFile(markerPath, "utf8");
    if (marker !== "preview-spike-generated-context\n") throw new Error("unexpected_build_context");
    await rm(target, { recursive: true });
  }
  await mkdir(target);
  await writeFile(markerPath, "preview-spike-generated-context\n", { flag: "wx" });
}

export async function prepareContext(fixtureRevision = commit) {
  if (!/^[a-f0-9]{40}$/u.test(fixtureRevision)) throw new Error("fixture_revision_invalid");
  const target = join(root, "build-context");
  await initializeBuildContext(target);
  await mkdir(join(target, "container"), { recursive: true });
  const archive = spawnSync(
    "git",
    ["archive", "--format=tar", fixtureRevision, "fixtures/cloudflare-preview"],
    { cwd: resolve(root, "../../.."), maxBuffer: 30 * 1024 * 1024 },
  );
  if (archive.status !== 0) throw new Error("fixture_archive_failed");
  const extract = spawnSync("tar", ["-xf", "-", "-C", target], { input: archive.stdout });
  if (extract.status !== 0) throw new Error("fixture_extract_failed");
  async function treeHash(directory) {
    const hash = createHash("sha256");
    async function visit(path, prefix = "") {
      for (const name of (await readdir(path)).sort()) {
        const file = join(path, name),
          relative = prefix ? `${prefix}/${name}` : name;
        const status = await lstat(file);
        if (status.isDirectory()) await visit(file, relative);
        else if (status.isFile()) {
          const bytes = await readFile(file);
          hash.update(JSON.stringify([relative, Boolean(status.mode & 0o111), bytes.length]));
          hash.update("\0");
          hash.update(bytes);
          hash.update("\0");
        } else throw new Error("fixture_file_invalid");
      }
    }
    await visit(directory);
    return hash.digest("hex");
  }
  const fixtureTrees = {};
  for (const fixture of FIXTURE_NAMES)
    fixtureTrees[fixture] = await treeHash(join(target, "fixtures/cloudflare-preview", fixture));
  await prepareSeedFixtures(
    join(target, "fixtures/cloudflare-preview"),
    join(target, "seed-fixtures"),
  );
  await writeFile(
    join(target, "fixture-provenance.json"),
    `${JSON.stringify(
      {
        fixtureSourceRevision: fixtureRevision,
        fixtureArchiveSha256: createHash("sha256").update(archive.stdout).digest("hex"),
        fixtureTrees,
        hmrOverlays: Object.fromEntries(
          HMR_OVERLAY_FIXTURES.map((name) => [name, hmrOverlaySha256(name)]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  for (const file of ["driver.mjs", "write-file.c", "next-request-hook.mjs", "hmr-probe.mjs"])
    await copyFile(join(root, "container", file), join(target, "container", file));
  await copyFile(
    join(root, "container", "bindings-worker.mjs"),
    join(target, "container", "bindings-worker.mjs"),
  );
  await mkdir(join(target, "container", "capabilities"), { recursive: true });
  for (const file of ["guest-binding.mjs", "transport.mjs", "wire.mjs"])
    await copyFile(
      join(root, "..", "capabilities", file),
      join(target, "container", "capabilities", file),
    );
  await mkdir(join(target, "tooling"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"])
    await copyFile(join(root, file), join(target, "tooling", file));
  await writeFile(join(target, "fixture-commit.txt"), `${fixtureRevision}\n`);
  console.log(`Prepared public fixture context from ${fixtureRevision}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareContext();
