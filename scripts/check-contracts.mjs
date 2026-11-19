/* global process */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-openapi-"));
const bundledContract = join(temporaryDirectory, "openapi.json");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const environment = {
  ...process.env,
  REDOCLY_SUPPRESS_UPDATE_NOTICE: "true",
  REDOCLY_TELEMETRY: "off",
};

try {
  const lint = spawnSync(
    pnpm,
    ["exec", "redocly", "lint", "ohmyhost@v1", "--config", "redocly.yaml"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  if (lint.status !== 0) {
    throw new Error(`OpenAPI lint failed:\n${lint.stderr || lint.stdout}`);
  }

  const bundle = spawnSync(
    pnpm,
    [
      "exec",
      "redocly",
      "bundle",
      "ohmyhost@v1",
      "--config",
      "redocly.yaml",
      "--output",
      bundledContract,
      "--ext",
      "json",
      "--component-renaming-conflicts-severity=error",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  if (bundle.status !== 0) {
    throw new Error(`OpenAPI bundle failed:\n${bundle.stderr || bundle.stdout}`);
  }

  const [actual, expected] = await Promise.all([
    readFile(bundledContract),
    readFile(join(projectRoot, "packages/contracts/generated/openapi.json")),
  ]);
  if (!actual.equals(expected)) {
    throw new Error(
      "OpenAPI generator input drifted; run pnpm contracts:bundle and commit the result",
    );
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
