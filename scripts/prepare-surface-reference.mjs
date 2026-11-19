/* global console, process */
/**
 * Writes the complete list of customer surfaces into the get-started Skill, so an agent reading
 * Skills can discover every CLI command and MCP tool, not only the ones a guide happens to use.
 * Generated from the same sources the clients ship: CLI help usage and the MCP tool catalog.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRemoteMcpContract } from "./mcp-remote-projection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SURFACE_REFERENCE = join(root, "skills/ohmyhost-get-started/references/surfaces.md");

/** One sentence is enough for generated tools; their own MCP schemas carry the detail. */
function firstSentence(text) {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  const stop = trimmed.search(/\.\s|\.$/u);
  return stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
}

/** The remote surface comes from its own reviewed contract, never the local stdio catalog. */
export function readRemoteMcpSurface() {
  const source = readFileSync(join(root, "packages/contracts/generated/openapi.json"), "utf8");
  const projection = projectRemoteMcpContract(JSON.parse(source), source);
  const generated = new Map(projection.tools.map((tool) => [tool.name, tool]));
  const workflows = new Map(projection.workflowTools.map((tool) => [tool.name, tool]));
  const named = new Map();
  for (const operation of projection.operations)
    for (const name of operation.toolNames) {
      const tool = generated.get(name) ?? workflows.get(name);
      named.set(
        name,
        tool ?? {
          name,
          description:
            operation.disposition === "named"
              ? `Use tools/list for ${name}'s registered MCP description and exact input schema.`
              : `${operation.reason} Follow tools/list for this workflow's exact MCP arguments; never submit secret values in chat or tool arguments.`,
        },
      );
    }
  for (const tool of projection.workflowTools) named.set(tool.name, tool);
  return {
    tools: [...named.values()].sort((left, right) => left.name.localeCompare(right.name)),
    operations: projection.operations,
    contractSha256: projection.contractSha256,
  };
}

/** A remote catalog explains registered workflows without treating REST bodies as MCP inputs. */
export function renderRemoteMcpSnippet() {
  const remote = readRemoteMcpSurface();
  return [
    `Master Tool Contract SHA-256: \`${remote.contractSha256}\`. These are the shared remote server's named tools; discover the current host's exact input schema with \`tools/list\`. New definitions may still be undergoing host checks.`,
    "",
    "| Tool | Purpose |",
    "| --- | --- |",
    ...remote.tools.map((tool) => {
      const description = tool.inputSchema ? firstSentence(tool.description) : tool.description;
      const cell = description
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/\|/gu, "\\|")
        .replace(
          /[{}<>]/gu,
          (character) => ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;" })[character],
        );
      return `| \`${tool.name}\` | ${cell} |`;
    }),
    "",
  ].join("\n");
}

export function renderSurfaceReference() {
  const cli = readFileSync(join(root, "apps/product-cli/src/cli.ts"), "utf8");
  const helpBlock = cli.slice(cli.indexOf("const HELP_USAGE"), cli.indexOf("const HELP_COMMANDS"));
  const commands = [];
  for (const match of helpBlock.matchAll(
    /^ {2}"?([a-z][a-z0-9 -]*)"?:\s*\n?\s*"((?:[^"\\]|\\.)*)"/gmu,
  ))
    commands.push({ name: match[1], usage: JSON.parse(`"${match[2]}"`) });

  const tools = JSON.parse(
    readFileSync(join(root, "apps/public-site/src/generated-mcp-tools.json"), "utf8"),
  ).tools;
  const remote = readRemoteMcpSurface();

  /** An asterisk in a usage text (`data.*`) would otherwise pair up into emphasis when the Markdown is formatted. */
  const literal = (text) => text.replace(/\*/gu, "\\*");

  const lines = [
    "# Every command and tool",
    "",
    "The CLI, local stdio MCP and remote OAuth MCP have distinct surfaces, listed separately below.",
    "Discover the installed contract with `ohmyhost --help --json` or the connected server's",
    "`tools/list`, and follow its actual schema rather than guessing arguments. A name in this",
    "reference describes server support; a host may still be checking a new or changed tool.",
    "",
    "## CLI commands",
    "",
    ...commands.map((command) => `- \`ohmyhost ${command.name}\` — ${literal(command.usage)}`),
    "",
    "## Local MCP tools",
    "",
    ...tools.map((tool) => `- \`${tool.name}\` — ${literal(firstSentence(tool.description))}`),
    "",
    "## Remote MCP tools",
    "",
    "These named tools belong to the shared remote endpoint used by the OpenAI and Claude plugins.",
    "The Claude package's four focused workflows do not restrict this server catalog. Current",
    "account rights and credential restrictions are checked by the canonical API on every call.",
    "",
    ...remote.tools.map(
      (tool) =>
        `- \`${tool.name}\` — ${literal(tool.inputSchema ? firstSentence(tool.description) : tool.description)}`,
    ),
    "",
    "## Master Tool Contract and API reference",
    "",
    `Master Tool Contract SHA-256: \`${remote.contractSha256}\`.`,
    "",
    "The complete public OpenAPI contract is at <https://ohmyho.st/api> and mirrored per release.",
    "Its MCP metadata accounts for every API operation: a named tool, a protected handoff, an",
    "equivalent workflow or an explicit exception. The remote `api_reference` documentation tool",
    "returns bounded operation summaries/schemas, the contract hash, support status and links.",
    "It never executes an API call. Use only executable tools actually exposed by this host.",
    "",
    "Local filesystem helpers, password-file exports and raw credential delivery do not become",
    "remote capabilities because they appear in the full API. Use the documented supported path",
    "or explain the concrete limitation; never pass a password or token through a documentation tool.",
    "",
  ];
  return {
    text: lines.join("\n"),
    commands: commands.length,
    tools: tools.length,
    remoteTools: remote.tools.length,
  };
}

if (process.argv[1] && process.argv[1].endsWith("prepare-surface-reference.mjs")) {
  const { text, commands, tools, remoteTools } = renderSurfaceReference();
  writeFileSync(SURFACE_REFERENCE, text);
  console.log(
    `surfaces.md: ${commands} commands, ${tools} local tools, ${remoteTools} remote tools`,
  );
}
