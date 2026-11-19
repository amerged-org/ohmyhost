/* global process, console */
/**
 * Every technical surface a customer agent can use must be explained where an LLM reads:
 * the Skills in this repository and the customer documentation. This reports what is missing,
 * so documentation is extended rather than surfaces quietly shipping undocumented.
 *
 * Usage: node scripts/check-surface-documentation.mjs [path/to/docs-clone]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRemoteMcpSurface } from "./prepare-surface-reference.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads every file under a directory whose name matches, as one lowercase haystack. */
function textUnder(directory, matches) {
  let text = "";
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (matches(entry)) text += readFileSync(path, "utf8").toLowerCase();
    }
  };
  walk(directory);
  return text;
}

export function auditSurfaceDocumentation(docsRoot) {
  const skillText = textUnder(join(root, "skills"), (name) => name.endsWith(".md"));
  // docs.ohmyho.st serves the synchronized Skill markdown next to its own pages, so both count.
  const docsText = docsRoot
    ? textUnder(docsRoot, (name) => name.endsWith(".mdx") || name.endsWith(".md"))
    : "";

  const mcpTools = JSON.parse(
    readFileSync(join(root, "apps/public-site/src/generated-mcp-tools.json"), "utf8"),
  ).tools.map((tool) => tool.name);
  const remoteMcpTools = readRemoteMcpSurface().tools.map((tool) => tool.name);

  const contract = JSON.parse(
    readFileSync(join(root, "packages/contracts/generated/openapi.json"), "utf8"),
  );
  const restOperations = Object.values(contract.paths).flatMap((path) =>
    Object.values(path)
      .filter((method) => typeof method === "object" && method !== null && "operationId" in method)
      .map((method) => method.operationId),
  );

  const cli = readFileSync(join(root, "apps/product-cli/src/cli.ts"), "utf8");
  const helpBlock = cli.slice(cli.indexOf("const HELP_USAGE"), cli.indexOf("const HELP_COMMANDS"));
  const cliCommands = [...helpBlock.matchAll(/^\s{2}"?([a-z][a-z0-9 -]*)"?:/gmu)].map(
    (match) => match[1],
  );

  const report = [];
  // Skills and guides speak CLI commands and MCP tools; the REST contract documents itself, so an
  // operation counts as documented when the published snapshot the docs render still contains it.
  for (const [kind, names] of [
    ["MCP tool", mcpTools],
    ["Remote MCP tool", remoteMcpTools],
    ["CLI command", cliCommands],
  ]) {
    for (const name of names) {
      const needle = kind === "CLI command" ? `ohmyhost ${name}` : name;
      const inSkills = skillText.includes(needle.toLowerCase());
      const inDocs = docsRoot ? docsText.includes(needle.toLowerCase()) : true;
      if (!inSkills || !inDocs) report.push({ kind, name, skills: inSkills, docs: inDocs });
    }
  }
  if (docsRoot) {
    const published = JSON.parse(readFileSync(join(docsRoot, "openapi.json"), "utf8"));
    const documented = new Set(
      Object.values(published.paths).flatMap((path) =>
        Object.values(path)
          .filter(
            (method) => typeof method === "object" && method !== null && "operationId" in method,
          )
          .map((method) => method.operationId),
      ),
    );
    for (const name of restOperations)
      if (!documented.has(name))
        report.push({ kind: "REST operation", name, skills: true, docs: false });
  }

  const counts = {
    mcpTools: mcpTools.length,
    remoteMcpTools: remoteMcpTools.length,
    restOperations: restOperations.length,
    cliCommands: cliCommands.length,
    missing: report.length,
  };
  return { ...counts, report };
}

if (process.argv[1] && process.argv[1].endsWith("check-surface-documentation.mjs")) {
  const result = auditSurfaceDocumentation(process.argv[2] ? resolve(process.argv[2]) : null);
  console.log(JSON.stringify(result, null, 2));
  if (result.report.length > 0) process.exitCode = 1;
}
