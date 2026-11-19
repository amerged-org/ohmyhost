/* global process */

import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDirectory = join(projectRoot, "packages/sdk-ts/src/generated");
const firstTemporaryDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-sdk-drift-"));
const secondTemporaryDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-sdk-drift-"));
const node = process.execPath;

const readTree = async (root) => {
  const files = new Map();
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.set(relative(root, path), await readFile(path));
      }
    }
  };
  await visit(root);
  return files;
};

const assertSameTree = (actual, expected, message) => {
  const actualNames = [...actual.keys()];
  const expectedNames = [...expected.keys()];
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index]) ||
    actualNames.some((name) => !actual.get(name)?.equals(expected.get(name)))
  ) {
    throw new Error(message);
  }
};

const generate = (temporaryDirectory) => {
  const result = spawnSync(
    node,
    ["scripts/generate-sdk-ts.mjs", "--temporary-output", temporaryDirectory],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error(`TypeScript SDK generation failed:\n${result.stderr || result.stdout}`);
  }
};

try {
  generate(firstTemporaryDirectory);
  const [committed, firstGeneration] = await Promise.all([
    readTree(generatedDirectory),
    readTree(firstTemporaryDirectory),
  ]);
  assertSameTree(
    committed,
    firstGeneration,
    "Generated TypeScript SDK drifted; run pnpm sdk-ts:generate and commit the result",
  );

  generate(secondTemporaryDirectory);
  const secondGeneration = await readTree(secondTemporaryDirectory);
  assertSameTree(
    firstGeneration,
    secondGeneration,
    "TypeScript SDK generation is not reproducible across consecutive runs",
  );
} finally {
  await Promise.all([
    rm(firstTemporaryDirectory, { force: true, recursive: true }),
    rm(secondTemporaryDirectory, { force: true, recursive: true }),
  ]);
}
