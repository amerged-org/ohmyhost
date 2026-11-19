/* global AbortSignal */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyRegistryRecord } from "./publish-npm-clients.mjs";

export const CLIENT_PACKAGES = ["cli", "mcp", "sdk", "runtime", "auth"].map(
  (name) => `@amerged/ohmyhost-${name}`,
);
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fields = (value, allowed, required) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));

/** A previous client cohort is immutable and can only be verified from a source ancestor. */
export async function prepareClientPrerequisite({ step, sha, repositoryRoot, run }) {
  if (
    !fields(
      step,
      [
        "id",
        "kind",
        "dependsOn",
        "action",
        "directory",
        "version",
        "manifestSha256",
        "sourceCommit",
      ],
      ["kind", "action", "directory", "version", "manifestSha256"],
    ) ||
    step.kind !== "clients" ||
    !["publish", "verify"].includes(step.action) ||
    !isAbsolute(step.directory ?? "") ||
    !/^0\.1\.\d+$/u.test(step.version ?? "") ||
    !HASH.test(step.manifestSha256 ?? "") ||
    !COMMIT.test(sha ?? "") ||
    (Object.hasOwn(step, "sourceCommit") &&
      (step.action !== "verify" || !COMMIT.test(step.sourceCommit)))
  )
    throw new Error("Client release prerequisite scope is invalid");
  const sourceCommit = step.sourceCommit ?? sha;
  if (sourceCommit !== sha) {
    if (typeof repositoryRoot !== "string" || typeof run !== "function")
      throw new Error("Previous client source requires the current repository ancestry");
    try {
      await run("git", ["merge-base", "--is-ancestor", sourceCommit, sha], {
        cwd: repositoryRoot,
        localOnly: true,
      });
    } catch {
      throw new Error("Previous client source is not an ancestor of the released revision");
    }
  }
  const bytes = await readFile(join(step.directory, "manifest.json"));
  const digest = hash(bytes);
  if (digest !== step.manifestSha256) throw new Error("Prepared client manifest digest changed");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.sourceCommit !== sourceCommit ||
    manifest.version !== step.version ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== CLIENT_PACKAGES.length ||
    !isDeepStrictEqual(
      manifest.packages.map(({ name }) => name).sort(),
      [...CLIENT_PACKAGES].sort(),
    )
  )
    throw new Error("Prepared client release source or package set differs");
  for (const record of manifest.packages) {
    if (
      !fields(
        record,
        ["name", "version", "file", "bytes", "sha256", "integrity", "files", "sourceArchiveSha256"],
        ["name", "version", "file", "sha256", "integrity"],
      ) ||
      record.version !== step.version ||
      record.file !== `amerged-${record.name.slice("@amerged/".length)}-${step.version}.tgz` ||
      !HASH.test(record.sha256 ?? "") ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(record.integrity ?? "") ||
      (sourceCommit !== sha && !HASH.test(record.sourceArchiveSha256 ?? ""))
    )
      throw new Error("Prepared client archive metadata is invalid");
    const archive = await readFile(join(step.directory, record.file));
    if (
      hash(archive) !== record.sha256 ||
      `sha512-${createHash("sha512").update(archive).digest("base64")}` !== record.integrity
    )
      throw new Error("Prepared client archive bytes changed");
  }
  return { digest, manifest };
}

/** Verification never publishes: both registry metadata and all five downloaded bytes must match. */
export async function verifyClientRegistryArtifacts({ manifest, fetch = globalThis.fetch }) {
  for (const record of manifest.packages) {
    const response = await fetch(
      `https://registry.npmjs.org/${record.name.replace("/", "%2F")}/${manifest.version}`,
      { redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error("Client registry record is unavailable");
    const archiveUrl = verifyRegistryRecord(await response.json(), record);
    const archive = await fetch(archiveUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!archive.ok || hash(new Uint8Array(await archive.arrayBuffer())) !== record.sha256)
      throw new Error("Client registry archive bytes differ");
  }
}
