/* global process */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isBuiltin } from "node:module";
import { build } from "esbuild";
import { verifyProductCliBoundary } from "./check-product-cli-boundary.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = {
  cli: "apps/product-cli",
  mcp: "apps/mcp",
  sdk: "packages/sdk-ts",
  runtime: "packages/customer-runtime",
  auth: "packages/customer-auth-better-auth",
};

/**
 * The shrinkwrap that makes npm install the native keyring and its platform packages at the integrity hashes the
 * lockfile records, so a registry or mirror cannot substitute other native code at install time.
 */
export function keyringShrinkwrap(lock, version) {
  const packages = {};
  const pattern =
    /^ {2}"?(@napi-rs\/keyring(?:-[a-z0-9-]+)?)@(\d+\.\d+\.\d+)"?:\n {4}resolution:\n {6}\{\n {8}integrity: (sha512-[A-Za-z0-9+/=]+),?\n/gmu;
  for (const match of lock.matchAll(pattern)) {
    const [, name, found, integrity] = match;
    if (found !== version) continue;
    // A platform package carries the host constraints its lockfile entry records, so npm installs only its own binary.
    const end = lock.indexOf("\n\n", match.index);
    const entry = lock.slice(match.index, end === -1 ? undefined : end);
    const constraints = Object.fromEntries(
      ["os", "cpu", "libc"].flatMap((field) => {
        const values = new RegExp(`^ {4}${field}: \\[([^\\]]+)\\]$`, "mu").exec(entry);
        return values === null ? [] : [[field, values[1].split(",").map((value) => value.trim())]];
      }),
    );
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`,
      integrity,
      ...(name === "@napi-rs/keyring" ? {} : { optional: true, ...constraints }),
    };
  }
  if (!packages["node_modules/@napi-rs/keyring"])
    throw new Error(`The lockfile records no integrity for @napi-rs/keyring@${version}`);
  return {
    name: "ohmyhost-client",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { dependencies: { "@napi-rs/keyring": version } }, ...packages },
  };
}

/** The package name a website archive installs as: the owned public scope, never the unclaimed @ohmyhost scope. */
export function archiveName(kind) {
  if (!["cli", "mcp", "sdk", "runtime", "auth"].includes(kind))
    throw new Error(`unknown client ${kind}`);
  return `@amerged/ohmyhost-${kind}`;
}

export async function packageCustomerClient(kind, outputDirectory) {
  if (!Object.hasOwn(directories, kind)) throw new Error("unknown customer package");
  const directory = directories[kind];
  const library = kind !== "cli" && kind !== "mcp";
  const entries = kind === "cli" ? ["bin", "index", "credential-store"] : ["stdio-main", "index"];
  const source = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
  if (
    library &&
    Object.values(source.dependencies ?? {}).some((version) => version.startsWith("workspace:"))
  ) {
    throw new Error("Customer library depends on an unpublished workspace package");
  }
  const cli = JSON.parse(await readFile(join(root, "apps/product-cli/package.json"), "utf8"));
  await mkdir(outputDirectory, { recursive: true });
  await run("pnpm", ["--filter", `${source.name}...`, "build"], { cwd: root });
  if (!library) verifyProductCliBoundary({ repositoryRoot: root });
  const stage = await mkdtemp(join(tmpdir(), `ohmyhost-${kind}-bundle-`));
  try {
    if (library) {
      await cp(join(root, directory, "dist"), join(stage, "dist"), { recursive: true });
    } else {
      const bundle = await build({
        absWorkingDir: root,
        entryPoints: Object.fromEntries(
          entries.map((name) => [name, `${directory}/dist/${name}.js`]),
        ),
        outdir: join(stage, "dist"),
        bundle: true,
        splitting: true,
        platform: "node",
        format: "esm",
        target: "node22",
        external: ["@napi-rs/keyring"],
        define: {
          "process.env.WS_NO_BUFFER_UTIL": '"1"',
          "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
        },
        banner: {
          js: 'import { createRequire as __ohmyhostCreateRequire } from "node:module"; const require = __ohmyhostCreateRequire(import.meta.url);',
        },
        logLevel: "silent",
        metafile: true,
      });
      for (const file of Object.keys(bundle.metafile.inputs)) {
        if (
          /^(?:apps|packages)\//u.test(file) &&
          !/^(?:apps\/(?:mcp|product-cli)|packages\/(?:agent-skills|contracts|sdk-ts|workos-auth-contracts|postgres-bridge))\//u.test(
            file,
          )
        ) {
          throw new Error(`Customer bundle includes a non-client workspace: ${file}`);
        }
      }
      for (const output of Object.values(bundle.metafile.outputs)) {
        if (
          output.imports.some(
            (item) => item.external && item.path !== "@napi-rs/keyring" && !isBuiltin(item.path),
          )
        ) {
          throw new Error("Customer bundle has an undeclared runtime dependency");
        }
      }
    }
    if (!library) {
      await mkdir(join(stage, "dist/licenses"), { recursive: true });
      await cp(
        join(root, "packages/postgres-bridge/LICENSE"),
        join(stage, "dist/licenses/pgcf-bridge-LICENSE"),
      );
      await cp(
        join(root, "packages/postgres-bridge/NOTICE"),
        join(stage, "dist/licenses/pgcf-bridge-NOTICE"),
      );
    }
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify(
        {
          name: archiveName(kind),
          version: source.version,
          private: true,
          type: "module",
          engines: { node: ">=22" },
          files: ["dist", ...(library ? [] : ["npm-shrinkwrap.json"])],
          bin: source.bin,
          exports: library
            ? Object.fromEntries(
                Object.entries(source.exports).map(([name, target]) => [
                  name,
                  { types: target.types, import: target.import },
                ]),
              )
            : kind === "cli"
              ? { ".": "./dist/index.js", "./credential-store": "./dist/credential-store.js" }
              : { ".": "./dist/index.js" },
          dependencies: library
            ? source.dependencies
            : { "@napi-rs/keyring": cli.dependencies["@napi-rs/keyring"] },
          ...(library && source.peerDependencies
            ? { peerDependencies: source.peerDependencies }
            : {}),
          ...(library && source.peerDependenciesMeta
            ? { peerDependenciesMeta: source.peerDependenciesMeta }
            : {}),
        },
        null,
        2,
      ),
    );
    if (!library)
      await writeFile(
        join(stage, "npm-shrinkwrap.json"),
        `${JSON.stringify(keyringShrinkwrap(await readFile(join(root, "pnpm-lock.yaml"), "utf8"), cli.dependencies["@napi-rs/keyring"]), null, 2)}\n`,
      );
    const result = await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", resolve(outputDirectory)],
      { cwd: stage },
    );
    // npm names the tarball after the scoped package; the public site serves the download name of the client.
    const packed = resolve(outputDirectory, JSON.parse(result.stdout)[0].filename);
    const named = resolve(outputDirectory, `ohmyhost-${basename(directory)}-${source.version}.tgz`);
    await rename(packed, named);
    return named;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4)
    throw new Error("usage: package-customer-client <cli|mcp|sdk|runtime|auth> <output-directory>");
  process.stdout.write(
    `${await packageCustomerClient(process.argv[2], resolve(process.argv[3]))}\n`,
  );
}
