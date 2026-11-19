/* global process */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCustomerClient } from "./package-customer-client.mjs";
import {
  CI_REPOSITORY,
  inspectReleaseRepository,
  requireVerifiedCommit,
} from "./platform-release.mjs";
import {
  comparePublicChannels,
  observePublicChannels,
  requireCurrentChannels,
} from "./check-public-channels.mjs";

/**
 * A public client release is bound to the CI run that verified its exact source commit: the manifest records both,
 * so the bytes that customers install trace to a green build of that commit, not to one workstation's checkout.
 */
export async function verifiedReleaseSource({ sha, run }) {
  const ciRunId = await requireVerifiedCommit({ sha, run });
  return { source_repository: CI_REPOSITORY, source_commit: sha, ci_run_id: ciRunId };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const repository = await inspectReleaseRepository({ cwd: root });
  const packages = [
    ["cli", "apps/product-cli"],
    ["mcp", "apps/mcp"],
    ["sdk", "packages/sdk-ts"],
    ["runtime", "packages/customer-runtime"],
    ["auth", "packages/customer-auth-better-auth"],
  ];
  const manifests = await Promise.all(
    packages.map(async ([kind, directory]) => ({
      kind,
      ...JSON.parse(await readFile(join(root, directory, "package.json"), "utf8")),
    })),
  );
  const version = manifests[0].version;
  if (
    !/^\d+\.\d+\.\d+$/u.test(version) ||
    manifests.some((manifest) => manifest.version !== version)
  )
    throw new Error("Public client versions must identify one release");
  const published = await globalThis.fetch(`https://ohmyho.st/releases/${version}/manifest.json`, {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(15000),
  });
  await published.body?.cancel();
  if (published.status !== 404)
    throw new Error(
      "Release version is already published or its absence cannot be verified; choose a new version after checking the public manifest",
    );
  // A newer client release starts only once every public channel carries the live one.
  requireCurrentChannels(comparePublicChannels(await observePublicChannels()), version);
  // Nothing is packaged for a source that CI has not verified green.
  const source = await verifiedReleaseSource({ sha: repository.sha });
  const parent = resolve(root, "apps/public-site/public/releases");
  const destination = join(parent, version);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".preparing-"));
  try {
    const artifacts = [];
    for (const manifest of manifests) {
      const path = await packageCustomerClient(manifest.kind, staging);
      const bytes = await readFile(path);
      artifacts.push({
        name: manifest.name,
        version,
        file: basename(path),
        url: `https://ohmyho.st/releases/${version}/${basename(path)}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const contractBytes = await readFile(join(root, "packages/contracts/generated/openapi.json"));
    const contract = {
      file: "openapi.json",
      url: `https://ohmyho.st/releases/${version}/openapi.json`,
      bytes: contractBytes.length,
      sha256: createHash("sha256").update(contractBytes).digest("hex"),
    };
    await writeFile(join(staging, contract.file), contractBytes);
    // The catalog the released clients ship: the baseline the website and docs catalogs are checked against.
    await writeFile(
      join(staging, "mcp-tools.json"),
      await readFile(join(root, "apps/public-site/src/generated-mcp-tools.json")),
    );
    const release = { version, ...source, packages: artifacts, contract };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(release, null, 2)}\n`);
    await writeFile(
      join(staging, "SHA256SUMS"),
      `${[...artifacts, contract].map((artifact) => `${artifact.sha256}  ${artifact.file}`).join("\n")}\n`,
    );
    // A published version is immutable. A later release must choose a new version.
    await rename(staging, destination);
    // Published bytes are immutable; superseded versions are not kept in the served asset set.
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== version && /^\d+\.\d+\.\d+$/u.test(entry.name)) {
        await rm(join(parent, entry.name), { recursive: true });
      }
    }
    process.stdout.write(
      `${JSON.stringify({ version, sourceCommit: repository.sha, destination, artifacts: artifacts.length })}\n`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
