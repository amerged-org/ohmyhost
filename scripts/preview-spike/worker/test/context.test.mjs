import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { initializeBuildContext, prepareSeedFixtures } from "../prepare-context.mjs";
import { FIXTURE_NAMES } from "../provenance.mjs";

test("an unmarked existing build context is refused without adopting or deleting its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-context-owner-test-"));
  const target = join(directory, "build-context");
  const canary = join(target, "container", "synthetic-stale-input.mjs");
  try {
    await mkdir(join(target, "container"), { recursive: true });
    await writeFile(canary, "synthetic unowned canary\n");
    await assert.rejects(initializeBuildContext(target), /unexpected_build_context/u);
    assert.equal(await readFile(canary, "utf8"), "synthetic unowned canary\n");
    await assert.rejects(readFile(join(target, ".preview-spike-context")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only a marked directory is replaced; bad markers and linked targets are preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-context-marker-test-"));
  const target = join(directory, "build-context");
  const marker = ".preview-spike-context";
  try {
    await initializeBuildContext(target);
    assert.deepEqual(await readdir(target), [marker]);
    await mkdir(join(target, "container"));
    await writeFile(join(target, "container", "stale.mjs"), "synthetic stale file");
    await initializeBuildContext(target);
    assert.deepEqual(await readdir(target), [marker]);
    assert.equal(await readFile(join(target, marker), "utf8"), "preview-spike-generated-context\n");

    await writeFile(join(target, marker), "unexpected marker\n");
    await writeFile(join(target, "canary"), "synthetic unowned canary");
    await assert.rejects(initializeBuildContext(target), /unexpected_build_context/u);
    assert.equal(await readFile(join(target, "canary"), "utf8"), "synthetic unowned canary");

    const externalMarker = join(directory, "external-marker");
    await writeFile(externalMarker, "preview-spike-generated-context\n");
    await rm(join(target, marker));
    await symlink(externalMarker, join(target, marker));
    await assert.rejects(initializeBuildContext(target), /unexpected_build_context/u);
    assert.equal(await readFile(join(target, "canary"), "utf8"), "synthetic unowned canary");

    const linked = join(directory, "linked-context");
    await symlink(target, linked);
    await assert.rejects(initializeBuildContext(linked), /unexpected_build_context/u);
    assert.equal(await readFile(join(target, "canary"), "utf8"), "synthetic unowned canary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dependency seed copies only fixture manifests and locks, independently of source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-seed-test-"));
  const fixtures = join(directory, "fixtures");
  const first = join(directory, "seed-first");
  const second = join(directory, "seed-second");
  try {
    for (const fixture of FIXTURE_NAMES) {
      const root = join(fixtures, fixture);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "package.json"), `${fixture} package`);
      await writeFile(
        join(root, fixture === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml"),
        `${fixture} lock`,
      );
      await writeFile(join(root, "source.mjs"), "public source");
      await writeFile(join(root, ".env.local"), "synthetic excluded canary");
    }
    await prepareSeedFixtures(fixtures, first);
    await writeFile(join(fixtures, "astro-edge", "source.mjs"), "changed public source");
    await prepareSeedFixtures(fixtures, second);
    for (const fixture of FIXTURE_NAMES) {
      const names = (await readdir(join(first, fixture))).sort();
      assert.deepEqual(
        names,
        ["package.json", fixture === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml"].sort(),
      );
      for (const name of names)
        assert.deepEqual(
          await readFile(join(first, fixture, name)),
          await readFile(join(second, fixture, name)),
        );
    }

    await writeFile(join(fixtures, "astro-edge", "package-lock.json"), "updated lock");
    await prepareSeedFixtures(fixtures, second);
    assert.notDeepEqual(
      await readFile(join(first, "astro-edge", "package-lock.json")),
      await readFile(join(second, "astro-edge", "package-lock.json")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dependency seed refuses linked inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-seed-link-test-"));
  try {
    const first = FIXTURE_NAMES[0];
    await mkdir(join(directory, "fixtures", first), { recursive: true });
    await writeFile(join(directory, "canary"), "synthetic excluded canary");
    await symlink(join(directory, "canary"), join(directory, "fixtures", first, "package.json"));
    await assert.rejects(
      prepareSeedFixtures(join(directory, "fixtures"), join(directory, "seed")),
      /fixture_seed_file_invalid/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image seed precedes fixture source, metadata and helpers, and public images are pinned", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const seedInput = dockerfile.indexOf("COPY seed-fixtures/ /opt/fixtures/");
  const seed = dockerfile.indexOf("RUN set -eu; mkdir -p /opt/pnpm-store");
  assert.ok(seedInput >= 0 && seedInput < seed);
  for (const input of [
    "COPY --from=docker.io/cloudflare/sandbox:",
    "COPY --from=helper ",
    "COPY tooling/ /opt/preview-tooling/",
    "COPY fixtures/cloudflare-preview/",
    "COPY container/ /opt/preview-spike/",
    "COPY fixture-provenance.json ",
  ])
    assert.ok(dockerfile.indexOf(input) > seed, `${input} must follow the dependency seed`);
  assert.match(dockerfile, /cloudflare\/sandbox:1\.0\.1@sha256:[a-f0-9]{64}/u);
  assert.equal(
    (dockerfile.match(/node:24\.15\.0-bookworm-slim@sha256:[a-f0-9]{64}/gu) ?? []).length,
    2,
  );
});
