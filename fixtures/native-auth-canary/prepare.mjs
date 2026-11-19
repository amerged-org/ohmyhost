/* global process */
// Prepare a separate customer source directory using the exact local public runtime package.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { packageCustomerClient } from "../../scripts/package-customer-client.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const output = args.shift();
if (!output || args.some((arg) => !["--google", "--github"].includes(arg))) {
  throw new Error(
    "usage: node fixtures/native-auth-canary/prepare.mjs <new-output-directory> [--google] [--github]",
  );
}
const destination = resolve(output);
await mkdir(destination); // Refuse to overwrite an existing customer directory.
const temporary = await mkdtemp(join(tmpdir(), "native-auth-package-"));
try {
  await cp(join(here, "src"), join(destination, "src"), { recursive: true });
  await cp(join(here, "package.json"), join(destination, "package.json"));
  await cp(join(here, "ohmyhost.yaml"), join(destination, "ohmyhost.yaml"));
  await mkdir(join(destination, "vendor"));
  const tarball = await packageCustomerClient("runtime", temporary);
  await cp(tarball, join(destination, "vendor/customer-runtime.tgz"));
  await run("pnpm", ["install", "--ignore-scripts"], { cwd: destination });
  const bundle = await build({
    entryPoints: [join(destination, "src/browser.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  const script = bundle.outputFiles[0].text;
  await writeFile(
    join(destination, "src/browser-bundle.ts"),
    `export const browserScript = ${JSON.stringify(script)};\nexport const providers = ${JSON.stringify({ google: args.includes("--google"), github: args.includes("--github") })};\n`,
  );
  // Dependency installation is reproducible from the copied tarball and generated lockfile.
  await rm(join(destination, "node_modules"), { recursive: true, force: true });
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: destination });
  await build({
    entryPoints: [join(destination, "src/ohmyhost/worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  await run(
    process.execPath,
    [
      join(here, "../../node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--lib",
      "es2022,dom",
      "--skipLibCheck",
      join(destination, "src/browser.ts"),
      join(destination, "src/ohmyhost/worker.ts"),
    ],
    { cwd: destination },
  );
  const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
  if (manifest.dependencies["@ohmyhost/customer-runtime"] !== "file:vendor/customer-runtime.tgz")
    throw new Error("unexpected package reference");
  process.stdout.write(`Prepared and bundled ${destination}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
