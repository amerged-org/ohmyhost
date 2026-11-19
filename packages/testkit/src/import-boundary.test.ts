import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

async function productionSources(): Promise<readonly string[]> {
  return Promise.all(
    [
      "index.ts",
      "framework/config-framework-adapter.ts",
      "provider/fake-provider-store.ts",
      "provider/fake-static-hosting-provider.ts",
    ].map(async (path) => readFile(join(SOURCE_DIRECTORY, path), "utf8")),
  );
}

describe("testkit import boundary", () => {
  it("does not import forbidden runtime layers, provider SDKs, or environment access", async () => {
    const source = (await productionSources()).join("\n");

    expect(source).not.toMatch(/@ohmyhost\/database|\bpg\b|hono|cloudflare|aws-sdk|process\.env/iu);
    expect(relative(process.cwd(), SOURCE_DIRECTORY)).toMatch(/(?:packages\/testkit\/)?src$/u);
  });
});
