#!/usr/bin/env node
/* global process */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeReleaseTrain,
  prepareReleaseTrain,
  releaseApprovalDigest,
  runReleaseCommand,
  validateTrainManifest,
} from "./release-pipeline.mjs";
import { describePrivateApproval } from "./release-private-worker.mjs";
import { fingerprintAt, PolicyCohortError } from "./release-policy-cohort.mjs";
import { readPrivateReleaseJson } from "./release-rehearsal-artifacts.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";

export function parseTrainArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--print-approval") {
      if (result.printApproval) throw new Error("Duplicate release approval option");
      result.printApproval = true;
      continue;
    }
    const value = argv[++index];
    if (
      !["--manifest", "--state", "--environment", "--approval", "--wrangler"].includes(flag) ||
      !value ||
      Object.hasOwn(result, flag)
    )
      throw new Error(
        "usage: release:train --manifest <private-json> [--print-approval | --state <private-json> --environment development|production --approval <validated-approval-sha256>] [--wrangler <path>]",
      );
    result[flag] = value;
  }
  if (
    !result["--manifest"] ||
    (!result.printApproval &&
      (!result["--state"] || !result["--environment"] || !result["--approval"]))
  )
    throw new Error(
      "Release train requires a manifest and exact state, environment and approval scope",
    );
  if (
    result.printApproval &&
    ["--state", "--environment", "--approval"].some((flag) => result[flag])
  )
    throw new Error("Print-approval mode does not execute a release");
  return result;
}

/**
 * Only the fixed cohort sentence (Worker/application names and an environment) is printable;
 * any other error can carry subprocess or provider text and stays generic.
 */
export function trainFailureMessage(error) {
  return error instanceof PolicyCohortError
    ? error.message
    : "Release train is incomplete; resume the original private state after verifying its source, approval scope and provider readback.";
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseTrainArguments(process.argv.slice(2));
    const { value: manifest } = await readPrivateReleaseJson(args["--manifest"]);
    validateTrainManifest(manifest);
    let reviewed;
    if (args.printApproval) {
      const repository = await inspectRehearsalRepository({ cwd: process.cwd() });
      if (repository.sha !== manifest.sourceCommit)
        throw new Error("Approval source differs from manifest");
      const prepared = await prepareReleaseTrain({
        manifest,
        repositoryRoot: repository.repositoryRoot,
      });
      // A private Worker creation shows its creation ID and profile, new crons, service targets and
      // entrypoints, R2 buckets, secret NAMES and the protected Control Worker the approval covers.
      const privateWorkers = describePrivateApproval({ manifest, prepared });
      reviewed = {
        preparationSha256: prepared.fingerprint,
        approval: releaseApprovalDigest({ manifest, preparationSha256: prepared.fingerprint }),
        // Shown for the operator; the source commit the approval binds fixes these policy bytes.
        policySha256: await fingerprintAt({
          sha: manifest.sourceCommit,
          repositoryRoot: repository.repositoryRoot,
          run: runReleaseCommand,
        }),
        ...(privateWorkers === undefined ? {} : { privateWorkers }),
      };
    }
    const result = args.printApproval
      ? {
          sourceCommit: manifest.sourceCommit,
          environment: manifest.environment,
          ...reviewed,
          steps: manifest.steps.map(
            ({
              id,
              kind,
              action,
              workerName,
              dependsOn,
              creationId,
              profile,
              core,
              nativeAuthLaunchPolicy,
            }) => ({
              id,
              kind,
              action,
              workerName,
              dependsOn,
              ...(creationId === undefined ? {} : { creationId, profile }),
              ...(core === undefined
                ? {}
                : {
                    coreDatabase: core.databaseName,
                    nativeAuthLaunchPolicy: nativeAuthLaunchPolicy ?? { mode: "disabled" },
                  }),
            }),
          ),
        }
      : await executeReleaseTrain({
          manifest,
          statePath: resolve(args["--state"]),
          environment: args["--environment"],
          approval: args["--approval"],
          wrangler: args["--wrangler"],
        });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${trainFailureMessage(error)}\n`);
    process.exitCode = 1;
  }
}
