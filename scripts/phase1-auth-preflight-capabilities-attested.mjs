/* global process */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { runAttestedCapabilityPreflight } from "./phase1-auth-preflight-capabilities.mjs";
import { runAttestedCapabilityPreflight } from "./phase1-auth-preflight-capabilities.mjs";

export const capabilityAttestationExitCode = (runnerState) =>
  runnerState === "PASS" ? 0 : runnerState === "BLOCKED_PREREQUISITE" ? 2 : 1;

const parseArguments = (arguments_) => {
  const options = {
    root: process.cwd(),
    p1a: null,
    producer: null,
    credentialStorePaths: [],
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.root = value;
    else if (argument === "--p1a") options.p1a = value;
    else if (argument === "--producer") options.producer = value;
    else if (argument === "--repository") options.repository = value;
    else if (argument === "--signer-workflow") options.signerWorkflow = value;
    else if (argument === "--source-digest") options.sourceDigest = value;
    else if (argument === "--source-ref") options.sourceRef = value;
    else if (argument === "--credential-store-path") options.credentialStorePaths.push(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  const root = resolve(options.root);
  return {
    ...options,
    root,
    p1a: options.p1a === null ? null : resolve(root, options.p1a),
    producer: options.producer === null ? null : resolve(root, options.producer),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const execution = await runAttestedCapabilityPreflight(parseArguments(process.argv.slice(2)));
    process.stdout.write(execution.serialized);
    process.exitCode = capabilityAttestationExitCode(execution.result.runner_state);
  } catch {
    process.stderr.write(
      `${JSON.stringify({
        runner_state: "FAIL",
        foundation_outcome: "BLOCKED",
        candidate_outcome: "UNDECIDED",
        reason_code: "ATTESTED_CAPABILITY_RUNNER_FAILURE",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
