/* global process */

import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_SOURCE = ".github/scripts/phase1-workos-capability-probe.mjs";
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const assertEmptyExternalDirectory = async (repositoryRoot, output) => {
  const relativeOutput = relative(repositoryRoot, output).split("\\").join("/");
  if (relativeOutput === "" || (!relativeOutput.startsWith("../") && !isAbsolute(relativeOutput))) {
    throw new Error("INVALID_CAPABILITY_PROBE_OUTPUT");
  }
  try {
    const metadata = await lstat(output);
    if (!metadata.isDirectory() || (await readdir(output)).length !== 0) {
      throw new Error("INVALID_CAPABILITY_PROBE_OUTPUT");
    }
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
    await mkdir(output, { recursive: true, mode: 0o700 });
  }
};

export const prepareWorkosCapabilityProbe = async ({ repositoryRoot, output, service }) => {
  const root = resolve(repositoryRoot);
  const target = resolve(output);
  if (!SERVICE_NAME.test(service)) throw new Error("INVALID_WORKOS_MANAGEMENT_SERVICE");
  await assertEmptyExternalDirectory(root, target);
  const sourceName = "phase1-workos-capability-probe.mjs";
  await copyFile(join(root, PROBE_SOURCE), join(target, sourceName), fsConstants.COPYFILE_EXCL);
  const configuration = {
    name: "ohmyhost-workos-capability-probe",
    main: sourceName,
    compatibility_date: "2026-08-19",
    workers_dev: false,
    preview_urls: false,
    services: [
      {
        binding: "WORKOS_MANAGEMENT",
        service,
        remote: true,
      },
    ],
  };
  await writeFile(join(target, "wrangler.jsonc"), `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
};

const parseArguments = (arguments_) => {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const options = { repositoryRoot: process.cwd(), output: null, service: null };
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const value = normalized[index + 1];
    if (value === undefined) throw new Error("INVALID_ARGUMENTS");
    if (argument === "--root") options.repositoryRoot = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--service") options.service = value;
    else throw new Error("INVALID_ARGUMENTS");
    index += 1;
  }
  if (options.output === null || options.service === null) throw new Error("INVALID_ARGUMENTS");
  return options;
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await prepareWorkosCapabilityProbe(parseArguments(process.argv.slice(2)));
  } catch {
    process.stderr.write(
      `${JSON.stringify({ reason_code: "CAPABILITY_PROBE_PREPARATION_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}
