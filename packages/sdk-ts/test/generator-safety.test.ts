import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

describe("SDK generator output safety", () => {
  it("keeps normal generation fixed to the package-owned generated directory", async () => {
    const config = await readFile(join(projectRoot, "hey-api.config.ts"), "utf8");

    expect(config).toContain('createSdkConfig("packages/sdk-ts/src/generated")');
    expect(config).not.toContain("OHMYHOST_SDK_TS_OUTPUT");
  });

  it("rejects a drift output directory outside the OS temp root before invoking the generator", async () => {
    // Give the child its own OS temp root. The otherwise eligible output is a sibling, so this
    // proves containment regardless of the checkout location or the credential guard's fake home.
    const temporaryRoot = await mkdtemp(join(tmpdir(), "ohmyhost-sdk-root-"));
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-sdk-drift-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-sdk-ts.mjs", "--temporary-output", directory],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Temporary SDK output must be an existing directory below the OS temp root",
      );
    } finally {
      await Promise.all(
        [directory, temporaryRoot].map((path) => rm(path, { force: true, recursive: true })),
      );
    }
  });

  it("rejects a non-empty drift directory before clean generation can remove its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-sdk-drift-"));
    const sentinel = join(directory, "do-not-delete.txt");
    await writeFile(sentinel, "preserve", "utf8");

    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-sdk-ts.mjs", "--temporary-output", directory],
        { cwd: projectRoot, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("new, empty ohmyhost drift directory");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // Leave time for setup and cleanup around the subprocess's existing 30-second deadline.
  it("routes drift generation through the guarded temporary-output interface", async () => {
    const driftScript = await readFile(join(projectRoot, "scripts/check-sdk-ts-drift.mjs"), "utf8");

    expect(driftScript).toContain('mkdtemp(join(tmpdir(), "ohmyhost-sdk-drift-")');
    expect(driftScript).toContain('"--temporary-output", temporaryDirectory');
    expect(driftScript).toContain("firstTemporaryDirectory");
    expect(driftScript).toContain("secondTemporaryDirectory");
    expect(driftScript).not.toContain("OHMYHOST_SDK_TS_OUTPUT");
    const scratchRoot = join(projectRoot, "docs/plan/tmp");
    await mkdir(scratchRoot, { recursive: true });
    const directory = await mkdtemp(join(scratchRoot, "sdk-output-check-"));
    try {
      const result = spawnSync(process.execPath, ["scripts/check-sdk-ts-drift.mjs"], {
        cwd: projectRoot,
        env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 40_000);
});
