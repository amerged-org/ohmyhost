import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { createManagementRuntimeContract } from "./runtime-contract.mjs";

const distributionRoot = new URL("../dist/", import.meta.url);
const bundleRoot = new URL("worker-bundle/", distributionRoot);
const runtimeRoot = new URL("runtime/", distributionRoot);

await rm(bundleRoot, { recursive: true, force: true });
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
await cp(new URL("../wrangler.jsonc", import.meta.url), new URL("wrangler.jsonc", runtimeRoot));
await writeFile(
  new URL("runtime-contract.json", runtimeRoot),
  `${JSON.stringify(createManagementRuntimeContract(), null, 2)}\n`,
  { mode: 0o600 },
);
