/* global console */
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { listOhmyhostSkillResources } from "../packages/agent-skills/dist/index.js";
import { creditPricingTable } from "./credit-pricing-document.mjs";
import { installSdkSnippet } from "./mintlify-install-snippets.mjs";
import { PROBLEM_POLICY } from "../apps/product-cli/dist/runtime-contract.js";
import { renderRemoteMcpSnippet } from "./prepare-surface-reference.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? "docs/plan/tmp/v97-website/mintlify");
// Read the existing documentation snapshot first. Never regenerate editorial MDX from platform TS.
const configuration = JSON.parse(await readFile(resolve(destination, "docs.json"), "utf8"));
if (configuration.name !== "ohmyho.st") throw Error("Select the existing ohmyho.st Docs snapshot");
const version = JSON.parse(
  await readFile(resolve(root, "apps/product-cli/package.json"), "utf8"),
).version;
if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) throw Error("Invalid public release");
const release = `https://ohmyho.st/releases/${version}`;
const publishedContract = await readFile(
  resolve(root, `apps/public-site/public/releases/${version}/openapi.json`),
  "utf8",
);
const currentContract = await readFile(
  resolve(root, "packages/contracts/generated/openapi.json"),
  "utf8",
);
if (JSON.stringify(JSON.parse(publishedContract)) !== JSON.stringify(JSON.parse(currentContract)))
  throw Error("Prepare the public client release before publishing its API/Skills snapshot");
const files = [];
async function put(path, content) {
  await mkdir(dirname(resolve(destination, path)), { recursive: true });
  await writeFile(resolve(destination, path), content);
  files.push({ path, sha256: createHash("sha256").update(content).digest("hex") });
}
await put("snippets/credit-pricing-table.mdx", (await creditPricingTable(root)) + "\n");
// Every problem the API returns links to errors/<slug>; publish exactly those pages (D312).
const problems = Object.entries(PROBLEM_POLICY).sort(([left], [right]) => (left < right ? -1 : 1));
const problemTitle = (code) => code.charAt(0).toUpperCase() + code.slice(1).replaceAll("_", " ");
for (const [code, policy] of problems)
  await put(
    `errors/${code.replaceAll("_", "-")}.mdx`,
    `---\ntitle: "${problemTitle(code)}"\ndescription: "What the \`${code}\` error means and what to do next."\n---\n\n` +
      `The API, CLI and MCP return \`${code}\` with HTTP ${String(policy.status)}. ` +
      `${policy.retryable ? "Repeating the same request, with the same idempotency key, after a wait can succeed." : "Repeating the same request unchanged does not help."}\n\n` +
      `## What to do\n\n${policy.action}\n\n` +
      "If the steps above do not resolve it, [report it](/feedback) with the `request_id` from the error.\n",
  );
await put(
  "snippets/error-codes.mdx",
  [
    "| Code | HTTP | Retry |",
    "| --- | --- | --- |",
    ...problems.map(
      ([code, policy]) =>
        `| [\`${code}\`](/errors/${code.replaceAll("_", "-")}) | ${String(policy.status)} | ${policy.retryable ? "Yes" : "No"} |`,
    ),
  ].join("\n") + "\n",
);
for (const resource of listOhmyhostSkillResources())
  await put(`skills/${resource.skillName}/${resource.relativePath}`, resource.text);
await put("openapi.yaml", await readFile(resolve(root, "packages/contracts/openapi.yaml")));
await put("openapi.json", publishedContract);
const tools = JSON.parse(
  await readFile(resolve(root, "apps/public-site/src/generated-mcp-tools.json"), "utf8"),
);
await put("mcp-tools.json", `${JSON.stringify(tools, null, 2)}\n`);
await put(
  "mcp.json",
  `${JSON.stringify({ mcpServers: { ohmyho: { command: "ohmyhost-mcp", env: { OHMYHOST_ENVIRONMENT: "production" } } } }, null, 2)}\n`,
);
await put(
  "snippets/install-clients.mdx",
  `\nRequires Node.js 22 or newer.\n\n\`\`\`sh\nnpm install --global ${release}/ohmyhost-product-cli-${version}.tgz ${release}/ohmyhost-mcp-${version}.tgz\nexport OHMYHOST_ENVIRONMENT=production\nohmyhost login --json\nohmyhost whoami --json\n\`\`\`\n\nThe same release is on npm as \`@amerged/ohmyhost-cli\` and \`@amerged/ohmyhost-mcp\`. Both sources install the \`ohmyhost\` and \`ohmyhost-mcp\` commands, so keep one source per computer and upgrade from the one already installed (\`npm ls --global\` names it). To switch, first remove the other pair: \`npm uninstall --global @ohmyhost/product-cli @ohmyhost/mcp\` for the archives, \`npm uninstall --global @amerged/ohmyhost-cli @amerged/ohmyhost-mcp\` for npm.\n\n[Release manifest and checksums](${release}/manifest.json) · [Current release](https://ohmyho.st/client-release.json)\n`,
);
await put("snippets/install-sdk.mdx", installSdkSnippet(version));
await put(
  "snippets/skill-catalog.mdx",
  listOhmyhostSkillResources()
    .filter((r) => r.relativePath === "SKILL.md")
    .map(
      (r) =>
        `- [${r.skillName}](https://ohmyho.st/skills/${r.skillName}/SKILL.md) — ${r.description}`,
    )
    .join("\n") + "\n",
);
await put(
  "snippets/mcp-tools.mdx",
  [
    "| Tool | Required arguments | Action |",
    "| --- | --- | --- |",
    ...tools.tools.map(
      (tool) =>
        `| \`${tool.name}\` | ${(tool.inputSchema.required ?? []).map((name) => `\`${name}\``).join(", ") || "None"} | ${tool.annotations?.readOnlyHint === true ? "Read" : "Change or prepare a change"} |`,
    ),
  ].join("\n") + "\n",
);
await put("snippets/remote-mcp-tools.mdx", renderRemoteMcpSnippet());
for (const [target, source] of [
  ["logo/light.svg", "omega-dark.svg"],
  ["logo/dark.svg", "omega-light.svg"],
  ["favicon.svg", "favicon.svg"],
  ["favicon.ico", "favicon.ico"],
  ["apple-touch-icon.png", "apple-touch-icon.png"],
])
  await put(target, await readFile(resolve(root, "brand/assets", source)));
// These exact former generated overrides masked Mintlify's current complete indices.
// Preserve an unknown/custom authored file rather than silently replacing it.
const previous = await readFile(resolve(destination, "generated-content.json"), "utf8")
  .then(JSON.parse)
  .catch(() => null);
for (const path of ["llms.txt", "llms-full.txt"]) {
  const old = previous?.files?.find((file) => file.path === path);
  if (!old) continue;
  const bytes = await readFile(resolve(destination, path)).catch(() => null);
  if (bytes && createHash("sha256").update(bytes).digest("hex") === old.sha256)
    await unlink(resolve(destination, path));
  else if (bytes)
    throw Error(`Review the custom ${path} before restoring Mintlify's generated index`);
}
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
await writeFile(
  resolve(destination, "generated-content.json"),
  JSON.stringify(
    {
      source_commit: source,
      source_dirty:
        execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
          .length > 0,
      release: version,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    destination: relative(root, destination),
    release: version,
    generated_files: files.length,
    editorial: "preserved",
  }),
);
