/* global process */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stageEvidenceDirectory } from "./phase1-credential-store-platform-proof.mjs";
import { runAttestedCredentialStorePlatforms } from "./phase1-credential-store-platforms.mjs";

const PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);

const parseArguments = (arguments_) => {
  const options = { root: process.cwd(), platformEvidence: {}, stageOutput: undefined };
  for (let index = 0; index < arguments_.length; index += 2) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--repository") options.repository = value;
    else if (argument === "--signer-workflow") options.signerWorkflow = value;
    else if (argument === "--source-digest") options.sourceDigest = value;
    else if (argument === "--source-ref") options.sourceRef = value;
    else if (argument === "--stage-output") options.stageOutput = value;
    else if (PLATFORMS.some((platform) => argument === `--${platform}`)) {
      options.platformEvidence[argument.slice(2)] = value;
    } else throw new Error("INVALID_ARGUMENTS");
  }
  const root = resolve(options.root);
  return {
    ...options,
    root,
    stageOutput: options.stageOutput === undefined ? undefined : resolve(root, options.stageOutput),
    platformEvidence: Object.fromEntries(
      Object.entries(options.platformEvidence).map(([platform, path]) => [
        platform,
        resolve(root, path),
      ]),
    ),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const execution = await runAttestedCredentialStorePlatforms(options);
    if (options.stageOutput !== undefined) {
      await stageEvidenceDirectory(options.root, execution.outputPath, options.stageOutput);
    }
    process.stdout.write(execution.serialized);
    process.exitCode = execution.result.runner_state === "PASS" ? 0 : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ runner_state: "FAIL", reason_code: "ATTESTED_NATIVE_PLATFORM_RUNNER_FAILURE" })}\n`,
    );
    process.exitCode = 1;
  }
}
