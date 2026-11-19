#!/usr/bin/env node
import { Buffer } from "node:buffer";
import process from "node:process";

import { inspectInventory, inspectManifest, parseManifestJsonc, planCleanup } from "./operator.mjs";

const LIMIT = 8 * 1024 * 1024;
const allowedErrors = new Set([
  "invalid_input",
  "manifest_mismatch",
  "scope_mismatch",
  "incomplete_inventory",
  "stale_inventory",
  "ambiguous_inventory",
  "invalid_chronology",
  "invalid_create_timeline",
  "stale_baseline",
  "baseline_not_empty",
  "creation_receipt_incomplete",
  "identity_changed",
]);

async function main() {
  if (
    process.argv.length !== 3 ||
    !["manifest", "preflight", "cleanup-plan"].includes(process.argv[2])
  )
    throw new Error("invalid_input");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > LIMIT) throw new Error("invalid_input");
    chunks.push(chunk);
  }
  let input;
  try {
    const source = Buffer.concat(chunks).toString("utf8");
    input = process.argv[2] === "manifest" ? parseManifestJsonc(source) : JSON.parse(source);
  } catch {
    throw new Error("invalid_input");
  }
  const result =
    process.argv[2] === "manifest"
      ? inspectManifest(input)
      : process.argv[2] === "preflight"
        ? inspectInventory(input)
        : planCleanup(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = allowedErrors.has(error?.message) ? error.message : "invalid_input";
  process.stderr.write(`operator: ${code}\n`);
  process.exitCode = 1;
});
