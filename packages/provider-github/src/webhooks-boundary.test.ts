import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("GitHub webhook package boundary", () => {
  it("exports a dedicated webhook graph without App JWT, token, or archive imports", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      exports: Record<string, { source: string }>;
    };
    expect(manifest.exports["./webhooks"]?.source).toBe("./src/webhooks.ts");

    const source = await readFile(resolve(packageRoot, "src/webhooks.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\/(?:app-jwt|installation-token|archive|index)\.js"/u);
  });
});
