#!/usr/bin/env node
/* global process, setTimeout */
/**
 * Publishes the five prepared @amerged/ohmyhost-* archives to npm. It publishes only after the
 * exact CI run of the release's source commit is green, only a version the registry definitely
 * lacks (404), and reads every published record back: name, version, licence, integrity and the
 * downloaded tarball bytes. The token comes from .env.local into this process only; npm reads it
 * from its environment through a private npmrc placeholder, so it is never written to disk or put
 * into an argument. A re-run resumes from published.json and never publishes a version twice.
 *
 *   node scripts/publish-npm-clients.mjs <prepared-npm-directory>
 */
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parseEnv, promisify } from "node:util";

import { requireVerifiedCommit } from "./platform-release.mjs";

const REGISTRY = "https://registry.npmjs.org";
const PUBLISHER = "amerged";
const PACKAGES = ["cli", "mcp", "sdk", "runtime", "auth"].map((x) => `@amerged/ohmyhost-${x}`);
const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const recordUrl = (name, version) => `${REGISTRY}/${name.replace("/", "%2F")}/${version}`;

async function runCommand(command, args, { cwd, env }) {
  const { stdout } = await execFileAsync(command, args, { cwd, env, encoding: "utf8" });
  return stdout;
}

export function readPublishToken(envText) {
  const token = parseEnv(envText).NPM_PUBLISH_TOKEN;
  if (!token) throw new Error("NPM_PUBLISH_TOKEN is missing from .env.local");
  if (!/^[\x21-\x7e]+$/u.test(token))
    throw new Error("NPM_PUBLISH_TOKEN must be a single printable line");
  return token;
}

export function decidePublishAction(status, { submitted = false } = {}) {
  if (status === 200) return "verify";
  if (status === 404) return submitted ? "wait" : "publish";
  throw new Error(`Registry answered ${status}; publish only after a definite 404`);
}

export function verifyRegistryRecord(metadata, record) {
  const differing = [
    metadata?.name !== record.name && "name",
    metadata?.version !== record.version && "version",
    metadata?.license !== "Apache-2.0" && "license",
    metadata?.dist?.integrity !== record.integrity && "integrity",
  ].filter(Boolean);
  let tarball = null;
  try {
    tarball = new URL(metadata?.dist?.tarball);
  } catch {
    differing.push("tarball");
  }
  if (tarball && (tarball.protocol !== "https:" || tarball.origin !== REGISTRY))
    differing.push("tarball");
  if (differing.length > 0)
    throw new Error(
      `Registry ${record.name}@${record.version} differs from the prepared archive (${differing.join(", ")}); a published version is never overwritten`,
    );
  return tarball.href;
}

export async function publishNpmClients({
  directory,
  token,
  fetch = globalThis.fetch,
  run = runCommand,
  verifyCommit = (sha) => requireVerifiedCommit({ sha }),
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  attempts = 10,
  now = () => new Date(),
}) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const records = manifest.packages ?? [];
  const version = records[0]?.version;
  if (
    !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit ?? "") ||
    records.length !== PACKAGES.length ||
    PACKAGES.some((name) => !records.some((record) => record.name === name)) ||
    records.some((record) => record.version !== version || record.version !== manifest.version)
  )
    throw new Error("The prepared manifest must name the five packages at one version and commit");
  for (const record of records) {
    const bytes = await readFile(join(directory, record.file));
    if (sha256(bytes) !== record.sha256 || integrityOf(bytes) !== record.integrity)
      throw new Error(`Prepared archive ${record.file} changed after preparation`);
  }
  const ciRun = await verifyCommit(manifest.sourceCommit);

  const ledgerPath = join(directory, "published.json");
  const ledger = existsSync(ledgerPath)
    ? JSON.parse(await readFile(ledgerPath, "utf8"))
    : { version, sourceCommit: manifest.sourceCommit, ciRun, packages: [] };
  if (ledger.version !== version || ledger.sourceCommit !== manifest.sourceCommit)
    throw new Error(`published.json belongs to ${ledger.version}@${ledger.sourceCommit}`);
  ledger.ciRun = ciRun;
  const saveState = async (record, fields) => {
    ledger.packages = ledger.packages.filter((item) => item.name !== record.name);
    ledger.packages.push({
      name: record.name,
      version,
      ...fields,
      observedAt: now().toISOString(),
    });
    ledger.packages.sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  };
  const redact = (text) =>
    String(text ?? "")
      .replaceAll(token, "[redacted]")
      .slice(0, 400);
  const readRecord = async (record) => {
    const response = await fetch(recordUrl(record.name, version), { redirect: "error" });
    return { status: response.status, metadata: response.ok ? await response.json() : null };
  };
  const verify = async (record, metadata) => {
    const tarball = verifyRegistryRecord(metadata, record);
    const response = await fetch(tarball, { redirect: "error" });
    const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    if (!bytes || sha256(bytes) !== record.sha256)
      throw new Error(
        `Registry bytes of ${record.name}@${version} differ from the prepared archive`,
      );
    await saveState(record, {
      state: "verified",
      integrity: record.integrity,
      sha256: record.sha256,
      tarball,
    });
  };

  const privateDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-npm-publish-"));
  try {
    const npmrc = join(privateDirectory, "npmrc");
    await writeFile(
      npmrc,
      `//registry.npmjs.org/:_authToken=\${NPM_PUBLISH_TOKEN}\nregistry=${REGISTRY}/\n`,
      { mode: 0o600 },
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^npm_config_/iu.test(key) && !["NODE_AUTH_TOKEN", "NPM_TOKEN"].includes(key),
      ),
    );
    Object.assign(env, { NPM_CONFIG_USERCONFIG: npmrc, NPM_PUBLISH_TOKEN: token });
    const npm = (args) => run("npm", args, { cwd: privateDirectory, env });
    const publisher = (await npm(["whoami", "--registry", `${REGISTRY}/`])).trim();
    if (publisher !== PUBLISHER)
      throw new Error(`npm publishes as ${publisher}; expected ${PUBLISHER}`);

    const pending = [];
    for (const record of records) {
      const submitted = ledger.packages.some(
        (item) => item.name === record.name && item.state === "submitted",
      );
      let { status, metadata } = await readRecord(record);
      if (decidePublishAction(status, { submitted }) === "publish") {
        try {
          await npm([
            "publish",
            resolve(directory, record.file),
            "--access",
            "public",
            "--ignore-scripts",
            "--registry",
            `${REGISTRY}/`,
          ]);
        } catch (error) {
          ({ status, metadata } = await readRecord(record));
          if (status !== 200)
            throw new Error(
              `npm publish of ${record.name}@${version} failed and the registry has no record: ${redact(error?.stderr ?? error?.message)}`,
            );
        }
        if (status !== 200) await saveState(record, { state: "submitted" });
      }
      for (let attempt = 0; status !== 200 && attempt < attempts; attempt += 1) {
        await wait(3_000);
        ({ status, metadata } = await readRecord(record));
      }
      if (status === 200) await verify(record, metadata);
      else pending.push(record.name);
    }
    return {
      version,
      sourceCommit: manifest.sourceCommit,
      ciRun,
      verified: ledger.packages.filter((item) => item.state === "verified").map(({ name }) => name),
      pending,
    };
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3)
    throw new Error("usage: publish-npm-clients.mjs <prepared-npm-directory>");
  const result = await publishNpmClients({
    directory: resolve(process.argv[2]),
    token: readPublishToken(await readFile(join(root, ".env.local"), "utf8")),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.pending.length > 0) {
    process.stderr.write("Registry propagation is pending; run the same command again.\n");
    process.exitCode = 2;
  }
}
