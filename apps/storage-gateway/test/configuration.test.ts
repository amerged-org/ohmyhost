import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("storage gateway configuration", () => {
  it("keeps preview disabled and parent token outside every config", async () => {
    // Every profile is private; platform service bindings are the only gateway ingress.
    for (const [name, listener, observed] of [
      ["wrangler.jsonc", false, false],
      ["wrangler.development.jsonc", false, false],
      ["wrangler.production.jsonc", false, true],
    ] as const) {
      const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
      const config = JSON.parse(
        source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"),
      );
      expect(config).toMatchObject({
        workers_dev: listener,
        preview_urls: false,
        observability: { enabled: observed },
      });
      expect(config).not.toHaveProperty("routes");
      expect(source).not.toContain('CLOUDFLARE_R2_API_TOKEN":');
      expect(source).not.toContain('CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID":');
    }
  });
});
