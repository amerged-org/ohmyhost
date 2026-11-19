/* global process */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseWranglerDeployOutput } from "./prepare-workos-management-deployment.mjs";

const parseArguments = (arguments_) => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  let wranglerOutput = null;
  let deploymentContract = null;
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const value = normalized[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--wrangler-output") wranglerOutput = resolve(value);
    else if (argument === "--deployment-contract") deploymentContract = resolve(value);
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  if (wranglerOutput === null || deploymentContract === null) {
    throw new Error("INVALID_ARGUMENTS");
  }
  return { wranglerOutput, deploymentContract };
};

try {
  const paths = parseArguments(process.argv.slice(2));
  const [serialized, contractSource] = await Promise.all([
    readFile(paths.wranglerOutput, "utf8"),
    readFile(paths.deploymentContract, "utf8"),
  ]);
  const receipt = parseWranglerDeployOutput(serialized, JSON.parse(contractSource));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
  process.stderr.write(
    `${JSON.stringify({ reason_code: "WORKOS_MANAGEMENT_VERSION_RECEIPT_INVALID" })}\n`,
  );
  process.exitCode = 1;
}
