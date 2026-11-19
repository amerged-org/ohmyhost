/* global process */
import { readFile, readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageFiles = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "LICENSE",
  "NOTICE",
];

/** Prepare a contained package from canonical Skill bytes, without invoking a client or provider. */
export async function prepareAgentPlugin({
  repository = repositoryRoot,
  destination = resolve(repository, "plugins/ohmyhost"),
  check = false,
} = {}) {
  const templateRoot = resolve(repository, "plugins/ohmyhost");
  const expected = new Map();
  for (const name of packageFiles) expected.set(name, await readFile(resolve(templateRoot, name)));
  validateManifests(expected);
  const skillsRoot = resolve(repository, "skills");
  const skillDirectories = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of skillDirectories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^ohmyhost-[a-z0-9-]+$/u.test(entry.name))
      throw new Error("Plugin Skills must be regular, named directories");
    const skillRoot = resolve(skillsRoot, entry.name);
    const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
    if (!skill.startsWith(`---\nname: ${entry.name}\n`) || !/^description: .+$/mu.test(skill))
      throw new Error("Plugin Skill metadata is invalid");
    for (const file of await regularFiles(skillRoot)) {
      if (/\.test\.(?:mjs|ts)$/u.test(file)) continue;
      if (
        /(?:^|\/)\.env(?:$|\.)|(?:^|\/)\.git(?:$|\/)|(?:^|\/)(?:id_rsa|id_ed25519)(?:$|\.)|\.(?:pem|key)$/u.test(
          file,
        )
      )
        throw new Error("Plugin Skill credential files are forbidden");
      expected.set(`skills/${entry.name}/${file}`, await readFile(resolve(skillRoot, file)));
    }
  }
  const existing = await regularFiles(destination, true);
  if (existing.some((name) => !expected.has(name)))
    throw new Error("Plugin package contains unexpected files; preserve and review them");
  if (check) {
    if (existing.length !== expected.size) throw new Error("Plugin package files are stale");
    for (const [name, bytes] of expected) {
      if (!bytes.equals(await readFile(resolve(destination, name))))
        throw new Error("Plugin package bytes are stale");
    }
  } else {
    for (const [name, bytes] of expected) {
      const path = resolve(destination, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  }
  return Object.freeze({ files: expected.size, destination: resolve(destination) });
}

function validateManifests(files) {
  for (const path of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const manifest = JSON.parse(files.get(path).toString("utf8"));
    const fields = ["name", "version", "description", "author", "homepage", "skills", "mcpServers"];
    if (path.startsWith(".claude-plugin/")) fields.push("displayName");
    if (
      Object.keys(manifest).sort().join(",") !== fields.sort().join(",") ||
      manifest.name !== "ohmyhost" ||
      manifest.skills !== "./skills/" ||
      manifest.mcpServers !== "./.mcp.json" ||
      manifest.apps !== undefined ||
      manifest.hooks !== undefined
    )
      throw new Error("Plugin manifest must reference its contained Skills and remote MCP only");
  }
  const config = JSON.parse(files.get(".mcp.json").toString("utf8"));
  const servers = config.mcpServers;
  const server = servers?.ohmyho;
  if (
    Object.keys(config).join(",") !== "mcpServers" ||
    !servers ||
    Object.keys(servers).join(",") !== "ohmyho" ||
    !server ||
    Object.keys(server).sort().join(",") !== "type,url" ||
    server.type !== "http" ||
    server.url !== "https://app.ohmyho.st/mcp"
  )
    throw new Error(
      "Plugin MCP configuration must be credential-free and use the product endpoint",
    );
}

async function regularFiles(root, missingIsEmpty = false) {
  const output = [];
  const visit = async (directory) => {
    const information = await lstat(directory);
    if (!information.isDirectory() || information.isSymbolicLink())
      throw new Error("Plugin package directories must not be symbolic links");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Plugin package symbolic links are forbidden");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(relative(root, path).split(sep).join("/"));
      else throw new Error("Plugin package special files are forbidden");
    }
  };
  try {
    await visit(root);
  } catch (error) {
    if (missingIsEmpty && error?.code === "ENOENT") return [];
    throw error;
  }
  return output.sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, output: { type: "string" } },
  });
  const result = await prepareAgentPlugin({ check: values.check, destination: values.output });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
