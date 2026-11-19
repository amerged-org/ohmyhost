/* global process, structuredClone */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CI_REPOSITORY } from "./platform-release.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapping = {
  "product-cli": ["cli", "apps/product-cli"],
  mcp: ["mcp", "apps/mcp"],
  "sdk-ts": ["sdk", "packages/sdk-ts"],
  "customer-runtime": ["runtime", "packages/customer-runtime"],
  "customer-auth-better-auth": ["auth", "packages/customer-auth-better-auth"],
};
const CLIENT_SOURCE_WORKSPACES = new Set([
  ...Object.values(mapping).map((entry) => entry[1]),
  "packages/contracts",
  "packages/workos-auth-contracts",
  "packages/agent-skills",
  "packages/postgres-bridge",
]);
const digest = (data) => createHash("sha256").update(data).digest("hex");

export function publicPackageMetadata(source, suffix) {
  const metadata = structuredClone(source);
  metadata.name = `@amerged/ohmyhost-${suffix}`;
  delete metadata.private;
  metadata.license = "Apache-2.0";
  metadata.homepage = "https://docs.ohmyho.st/";
  metadata.bugs = { url: "https://docs.ohmyho.st/support" };
  // The MCP Registry verifies ownership of the package by this name.
  if (suffix === "mcp") metadata.mcpName = "io.github.amerged-org/ohmyhost-mcp";
  if (suffix === "mcp")
    metadata.repository = {
      type: "git",
      url: "git+https://github.com/amerged-org/ohmyhost-mcp.git",
    };
  metadata.description = `ohmyho.st ${suffix} client`;
  metadata.publishConfig = { access: "public", registry: "https://registry.npmjs.org/" };
  metadata.files = ["dist", "src", "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md"];
  return metadata;
}

export function copyClientSourceFiles(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory())
      copyClientSourceFiles(join(source, entry.name), join(destination, entry.name));
    else if (
      entry.isFile() &&
      /\.(?:ts|mts|mjs|json)$/u.test(entry.name) &&
      !/\.(?:node-)?test\./u.test(entry.name) &&
      entry.name !== "worker-main.ts"
    )
      cpSync(join(source, entry.name), join(destination, entry.name));
  }
}
/** Keep repository-relative imports and each workspace's own package metadata intact. */
export function copyClientWorkspaceSource(repository, workspace, destination) {
  if (!CLIENT_SOURCE_WORKSPACES.has(workspace))
    throw new Error("Workspace is outside the public client source closure");
  const target = join(destination, workspace);
  copyClientSourceFiles(join(repository, workspace, "src"), join(target, "src"));
  if (workspace === "packages/postgres-bridge")
    for (const file of ["LICENSE", "NOTICE"])
      cpSync(join(repository, workspace, file), join(target, file));
  const metadata = JSON.parse(readFileSync(join(repository, workspace, "package.json"), "utf8"));
  metadata.license = "Apache-2.0";
  writeFileSync(join(target, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
}

/** Preserve upstream files or the two explicitly reviewed, hash-pinned notice sources. */
export function readBundledLicenseNotices(name, item, repository = root) {
  const files = readdirSync(item.directory).filter((file) =>
    /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/iu.test(file),
  );
  if (files.length === 0) {
    const metadata = item.metadata;
    if (
      name === "diff3" &&
      metadata.name === name &&
      metadata.version === "0.0.3" &&
      metadata.license === "MIT" &&
      metadata.author === "Tyler Wanek" &&
      metadata.repository?.type === "git" &&
      metadata.repository.url === "git+https://github.com/axosoft/diff3.git"
    ) {
      // This exact release embeds the complete upstream licences in both source headers.
      const sources = [
        ["diff3.js", "a2cf76d0acfaae0e098434307a1180d24ebf86451b70cbfc81704df55c54896f"],
        ["onp.js", "6970cf6907e5f3e62a95cf6942eb4199858ce9d42af866e064901f6183319a70"],
      ];
      const notices = [];
      for (const [file, expected] of sources) {
        const path = join(item.directory, file);
        if (!existsSync(path) || digest(readFileSync(path)) !== expected)
          throw new Error(`Missing bundled licence: ${name}`);
        const source = readFileSync(path, "utf8");
        const header =
          file === "diff3.js"
            ? /^(?:\/\/[^\n]*\n)+/u.exec(source)?.[0]
            : /^\/\*[\s\S]*?\*\//u.exec(source)?.[0];
        notices.push(`### ${file} upstream embedded licence\n\n${header}\n`);
      }
      return notices.join("\n");
    }
    const source = join(item.directory, "lib/index.js");
    // clean-git-ref 2.0.1 omits licence files in both npm and its declared release commit.
    // Its pinned package/source declares Apache-2.0; no upstream licence file is invented.
    if (
      name !== "clean-git-ref" ||
      metadata.name !== name ||
      metadata.version !== "2.0.1" ||
      metadata.license !== "Apache-2.0" ||
      metadata.author !== "Eli White <github@eli-white.com>" ||
      metadata.repository?.type !== "git" ||
      metadata.repository.url !== "https://github.com/TheSavior/clean-git-ref.git" ||
      !existsSync(source) ||
      digest(readFileSync(source)) !==
        "2cc0dedd73dce9009c145c9797418a4a14effa9f53fa757401ab6cf295f36167"
    )
      throw new Error(`Missing bundled licence: ${name}`);
    const apache = readFileSync(join(repository, "licenses/CLIENTS-APACHE-2.0.txt"));
    if (digest(apache) !== "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30")
      throw new Error("Canonical Apache licence differs");
    return (
      "### Reviewed upstream Apache-2.0 declaration\n\n" +
      "Author declared by clean-git-ref 2.0.1: Eli White <github@eli-white.com>.\n" +
      "Source: https://github.com/TheSavior/clean-git-ref/tree/bf3c8afc8032bcdc6a53634c18b601dc6df478fb\n" +
      "Pinned npm integrity: sha512-bLSptAy2P0s6hU4PzuIMKmMJJSE6gLXGH1cntDu7bWJUksvuM+7ReOK61mozULErYvP6a15rnYl0zFDef+pyPw==\n\n" +
      "No upstream LICENSE or NOTICE file is present in that release. " +
      "The package declares Apache-2.0; the canonical licence text follows.\n\n" +
      apache.toString("utf8")
    );
  }
  return files
    .map((file) => `### ${file}\n\n${readFileSync(join(item.directory, file), "utf8")}\n`)
    .join("\n");
}

/**
 * Client packages are built only from the released commit: HEAD must be the manifest's source commit and the tree
 * clean, apart from the paths the caller names (the release output directory).
 */
export function requireReleaseSource({ root, sourceCommit, allowedPaths = [] }) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["rev-parse", "HEAD"]).trim() !== sourceCommit)
    throw new Error("Client source HEAD differs from the release manifest source commit");
  const stray = git(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !allowedPaths.some(
          (path) => line.slice(3) === path || line.slice(3).startsWith(`${path}/`),
        ),
    );
  if (stray.length > 0)
    throw new Error("Client source tree is not clean; commit or remove its changes first");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const version = JSON.parse(readFileSync(join(root, "apps/product-cli/package.json"))).version;
  const release = join(root, "apps/public-site/public/releases", version);
  const manifest = JSON.parse(readFileSync(join(release, "manifest.json")));
  if (manifest.source_repository !== CI_REPOSITORY)
    throw new Error("Client source repository differs from the release manifest");
  const output = resolve(process.argv[2] ?? `docs/plan/tmp/npm-${version}`);
  requireReleaseSource({
    root,
    sourceCommit: manifest.source_commit,
    allowedPaths: [relative(root, output)],
  });
  mkdirSync(output, { recursive: true });
  const records = [];
  for (const artifact of manifest.packages) {
    const [suffix, workspace] = mapping[artifact.name.split("/")[1]] ?? [];
    if (!suffix || artifact.version !== version) throw new Error("Unexpected release package");
    const archive = join(release, artifact.file);
    if (digest(readFileSync(archive)) !== artifact.sha256)
      throw new Error("Release archive differs");
    const stage = join(output, suffix);
    if (existsSync(stage))
      throw new Error("Output already exists; preserve earlier package attempts");
    mkdirSync(stage);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    if (entries.some((entry) => !entry.startsWith("package/") || entry.split("/").includes("..")))
      throw new Error("Unexpected archive path");
    execFileSync("tar", ["-xzf", archive, "-C", stage]);
    const directory = join(stage, "package");
    const metadata = publicPackageMetadata(
      JSON.parse(readFileSync(join(directory, "package.json"))),
      suffix,
    );
    cpSync(join(root, "licenses/CLIENTS-APACHE-2.0.txt"), join(directory, "LICENSE"));
    writeFileSync(
      join(directory, "NOTICE"),
      "ohmyho.st client software\nCopyright 2026 Amerged B.V.\n\nApache-2.0 applies to the client code supplied by Amerged. Third-party code retains its original licences and notices. The private hosting platform and its services are not included.\n",
    );
    writeFileSync(
      join(directory, "README.md"),
      `${suffix === "mcp" ? `# ${metadata.name}\n\nLocal MCP server of ohmyho.st, version ${version}. Sign-in and setting secrets need the CLI too:\n\n\`\`\`sh\nnpm install --global @amerged/ohmyhost-cli @amerged/ohmyhost-mcp\nohmyhost login --json\n\`\`\`\n\nRegister \`ohmyhost-mcp\` with your agent: https://docs.ohmyho.st/agents/mcp\n\n` : `# ${metadata.name}\n\nohmyho.st ${suffix} client, version ${version}.\n\n\`\`\`sh\nnpm install ${suffix === "cli" ? "--global " : ""}${metadata.name}\n\`\`\`\n\n`}Documentation: https://docs.ohmyho.st/\n\nClient source is included under src/. Apache-2.0 applies to Amerged client code; see LICENSE, NOTICE and THIRD_PARTY_NOTICES.md. The hosted platform is not included.\n`,
    );
    const workspaces = [workspace];
    if (suffix === "cli" || suffix === "mcp")
      workspaces.push(
        "packages/contracts",
        "packages/sdk-ts",
        "packages/workos-auth-contracts",
        "packages/postgres-bridge",
      );
    if (suffix === "mcp") workspaces.push("apps/product-cli", "packages/agent-skills");
    for (const source of workspaces)
      copyClientWorkspaceSource(root, source, join(directory, "src"));
    const dependencies = new Map();
    for (const file of readdirSync(join(directory, "dist")).filter((file) =>
      file.endsWith(".js"),
    )) {
      const body = readFileSync(join(directory, "dist", file), "utf8");
      for (const match of body.matchAll(/^\/\/ (node_modules\/[^\n]+)/gmu)) {
        let parent = dirname(join(root, match[1]));
        while (parent !== root) {
          const path = join(parent, "package.json");
          if (existsSync(path)) {
            const item = JSON.parse(readFileSync(path));
            if (item.name) {
              dependencies.set(item.name, { directory: parent, metadata: item });
              break;
            }
          }
          parent = dirname(parent);
        }
        if (parent === root) throw new Error("Bundled third-party source lacks package metadata");
      }
    }
    const notices = [
      "# Bundled third-party notices\n\nThese components retain their original licences.\n",
    ];
    for (const [name, item] of [...dependencies.entries()].sort()) {
      notices.push(`## ${name} ${item.metadata.version}\n`);
      notices.push(readBundledLicenseNotices(name, item));
    }
    writeFileSync(join(directory, "THIRD_PARTY_NOTICES.md"), notices.join("\n"));
    writeFileSync(join(directory, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
        cwd: directory,
        encoding: "utf8",
      }),
    )[0];
    records.push({
      name: metadata.name,
      version,
      file: packed.filename,
      sha256: digest(readFileSync(join(output, packed.filename))),
      integrity: packed.integrity,
      files: packed.files.map((file) => file.path),
      sourceArchiveSha256: artifact.sha256,
    });
  }
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        version,
        sourceRepository: manifest.source_repository,
        sourceCommit: manifest.source_commit,
        packages: records,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(JSON.stringify({ version, packages: records.length, output }) + "\n");
}
