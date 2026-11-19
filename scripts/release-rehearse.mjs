#!/usr/bin/env node
/* global process */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readPrivateReleaseJson,
  rehearseWorker,
  requirePrivateReleaseDirectory,
  validateWorkerRehearsal,
} from "./release-rehearsal-artifacts.mjs";
import { manifestDigest, runReleaseCommand, validateTrainManifest } from "./release-pipeline.mjs";
import { releaseBranchFromRef } from "./platform-release.mjs";
import {
  controlCoreRenderInput,
  coreDatabaseIdOf,
  isControlCoreStep,
} from "./control-core-train.mjs";

/** Git inspection is local: no ls-remote, GitHub CI, provider token lookup, push or rollout. */
export async function inspectRehearsalRepository({ cwd, run = runReleaseCommand }) {
  const root = (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).trim();
  if (
    resolve(root) !== resolve(cwd) ||
    (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd })).trim() !== ""
  )
    throw new Error("Rehearsal requires a clean repository root");
  releaseBranchFromRef((await run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd })).trim());
  for (const args of [
    ["remote", "get-url", "origin"],
    ["remote", "get-url", "--push", "origin"],
  ])
    if ((await run("git", args, { cwd })).trim() !== "https://github.com/amerged-org/ohmyhost.git")
      throw new Error("Rehearsal source origin differs");
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd })).trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Rehearsal source commit is invalid");
  return { repositoryRoot: root, sha };
}

export async function rehearseRelease({
  manifest,
  outputPath,
  artifactsDirectory,
  cwd = process.cwd(),
  run = runReleaseCommand,
  wrangler = process.env.WRANGLER_BIN ?? "/opt/homebrew/bin/wrangler",
  inspect = inspectRehearsalRepository,
  rehearse = rehearseWorker,
}) {
  validateTrainManifest(manifest);
  if (resolve(outputPath) !== manifest.rehearsal)
    throw new Error("Rehearsal output must be the manifest's exact retained receipt path");
  const repository = await inspect({ cwd, run });
  if (repository.sha !== manifest.sourceCommit)
    throw new Error("Rehearsal source differs from manifest");
  await requirePrivateReleaseDirectory(dirname(resolve(outputPath)), repository.repositoryRoot);
  await requirePrivateReleaseDirectory(artifactsDirectory, repository.repositoryRoot);
  const previous = await readPrivateReleaseJson(outputPath, { optional: true });
  const receipt = previous?.value ?? {
    schemaVersion: 1,
    sourceCommit: repository.sha,
    manifestSha256: manifestDigest(manifest),
    workers: {},
  };
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sourceCommit !== repository.sha ||
    receipt.manifestSha256 !== manifestDigest(manifest) ||
    receipt.workers === null ||
    typeof receipt.workers !== "object" ||
    Array.isArray(receipt.workers)
  )
    throw new Error("Existing rehearsal pins another source or manifest");
  const images = Object.assign({}, ...Object.values(receipt.workers).map((proof) => proof.images));
  for (const step of manifest.steps.filter(({ kind }) => kind === "worker")) {
    const proof = receipt.workers[step.id];
    if (proof !== undefined) {
      await validateWorkerRehearsal({
        proof,
        repositoryRoot: repository.repositoryRoot,
        sha: repository.sha,
        workerName: step.workerName,
        configPath: join(repository.repositoryRoot, step.config),
        run,
        coreDatabaseId: coreDatabaseIdOf(manifest),
        core: isControlCoreStep(step)
          ? controlCoreRenderInput({
              step,
              accountId: manifest.accountId,
              sourceCommit: repository.sha,
              repositoryRoot: repository.repositoryRoot,
            })
          : undefined,
      });
      continue;
    }
    const directory = join(resolve(artifactsDirectory), step.id);
    await mkdir(directory, { mode: 0o700, recursive: true });
    receipt.workers[step.id] = await rehearse({
      step,
      repositoryRoot: repository.repositoryRoot,
      sha: repository.sha,
      directory,
      run,
      wrangler,
      previousImages: images,
      accountId: manifest.accountId,
      coreDatabaseId: coreDatabaseIdOf(manifest),
    });
    Object.assign(images, receipt.workers[step.id].images);
    // The file contains only source/config/bundle/image identities, never secret values or hashes.
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  return {
    sourceCommit: repository.sha,
    manifestSha256: manifestDigest(manifest),
    workers: Object.keys(receipt.workers),
    providerMutations: 0,
    receiptPath: resolve(outputPath),
  };
}

export function parseRehearsalArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (
      !["--manifest", "--out", "--artifacts", "--wrangler"].includes(flag) ||
      !value ||
      Object.hasOwn(result, flag)
    )
      throw new Error(
        "usage: release:rehearse --manifest <private-json> --out <private-json> --artifacts <private-directory> [--wrangler <path>]",
      );
    result[flag] = value;
  }
  if (!result["--manifest"] || !result["--out"] || !result["--artifacts"])
    throw new Error("Rehearsal manifest, output and artifact directory are required");
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseRehearsalArguments(process.argv.slice(2));
    const { value: manifest } = await readPrivateReleaseJson(args["--manifest"]);
    const result = await rehearseRelease({
      manifest,
      outputPath: resolve(args["--out"]),
      artifactsDirectory: resolve(args["--artifacts"]),
      wrangler: args["--wrangler"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(
      "Release rehearsal failed; inspect the scoped local inputs and rerun the same rehearsal.\n",
    );
    process.exitCode = 1;
  }
}
