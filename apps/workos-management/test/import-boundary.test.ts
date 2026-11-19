import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

const collect = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(target)));
    else if (/\.(?:ts|mjs|json)$/u.test(entry.name)) files.push(target);
  }
  return files;
};

describe("WorkOS management source and launch boundary", () => {
  it("confines the only network primitive to the Worker entrypoint and has no local secret loader", async () => {
    const files = await collect(path.join(repositoryRoot, "apps/workos-management", "src"));
    const productionFiles = files.filter((file) => file.endsWith(".ts"));
    const source = (await Promise.all(productionFiles.map((file) => readFile(file, "utf8")))).join(
      "\n",
    );
    expect(source).not.toMatch(
      /process\.env|dotenv|@workos-inc\/|WORKOS_(?:API|MANAGEMENT)_KEY|console\.(?:log|error|warn)/u,
    );
    expect(source).not.toMatch(/apps\/(?:control-api|product-cli)/u);
    const directNetworkCalls = source.match(/globalThis\.fetch\s*\(/gu) ?? [];
    expect(directNetworkCalls).toHaveLength(1);
    const workerEntrypoint = await readFile(
      path.join(repositoryRoot, "apps/workos-management/src/worker-main.ts"),
      "utf8",
    );
    expect(workerEntrypoint).toContain("globalThis.fetch(request)");
  });

  it("is absent from Control API and Product CLI source and package launch graphs", async () => {
    const roots = ["apps/control-api", "apps/product-cli"];
    for (const root of roots) {
      const files = await collect(path.join(repositoryRoot, root));
      const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
      expect(source).not.toMatch(/@ohmyhost\/workos-management|apps\/workos-management/u);
    }
  });
});
