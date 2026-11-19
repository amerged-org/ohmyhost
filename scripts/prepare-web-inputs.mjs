/* global process, console */
/**
 * Publishes what the website quotes into the website repository: the credit rate card generated
 * from docs/architecture/pricing-contract.md, the Skill pages, the MCP tool catalog, the published API contract and the
 * current client release. The website commits the result, so its build is deterministic and a
 * price change is reviewed as an ordinary diff.
 *
 *   node scripts/prepare-web-inputs.mjs <path-to-ohmyhost-web>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listOhmyhostSkillResources } from "../packages/agent-skills/dist/index.js";
import { DATABASE_SIZES } from "../packages/contracts/dist/database-sizes.js";
import { creditPricingRates, creditPricingTable } from "./credit-pricing-document.mjs";
import { requireCurrentReleaseInputs } from "./web-release-inputs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// resolve("") is the current directory, so the argument is checked before it is resolved.
if (!process.argv[2]) throw new Error("usage: prepare-web-inputs.mjs <path-to-ohmyhost-web>");
const destination = resolve(process.argv[2]);

const version = JSON.parse(
  readFileSync(join(root, "apps/product-cli/package.json"), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+$/u.test(version ?? "")) throw new Error("Invalid public client release");

const contractPath = join(root, "packages/contracts/generated/openapi.json");
requireCurrentReleaseInputs({ root, version, contractPath });
const openapiJson = JSON.parse(readFileSync(contractPath, "utf8"));
const openapiYaml = execFileSync(
  "pnpm",
  ["exec", "redocly", "bundle", contractPath, "--ext", "yaml"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const inputs = {
  platformCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  generatedAt: new Date().toISOString(),
  clientRelease: {
    version,
    manifestUrl: `https://ohmyho.st/releases/${version}/manifest.json`,
  },
  creditPricingTable: await creditPricingTable(root),
  // Retained platform content still resolves legacy meters; the current website must not quote them.
  creditRates: Object.fromEntries(
    Object.entries(await creditPricingRates(root)).filter(([meter]) => !meter.startsWith("neon.")),
  ),
  databaseSizes: DATABASE_SIZES,
  skills: listOhmyhostSkillResources().map((resource) => ({
    skillName: resource.skillName,
    relativePath: resource.relativePath,
    uri: resource.uri,
    description: resource.description,
    text: resource.text,
  })),
  mcpTools: JSON.parse(
    readFileSync(join(root, "apps/public-site/src/generated-mcp-tools.json"), "utf8"),
  ),
  openapiJson,
  openapiYaml: openapiYaml.slice(openapiYaml.indexOf("openapi:")),
};

const target = join(destination, "platform-inputs.json");
writeFileSync(target, `${JSON.stringify(inputs, null, 2)}\n`);
console.log(
  `platform-inputs.json: ${inputs.skills.length} Skill files, ${inputs.mcpTools.tools.length} tools, client ${version}`,
);
