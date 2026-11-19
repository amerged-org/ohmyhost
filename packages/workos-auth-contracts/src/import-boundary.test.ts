import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("WorkOS pure-contract package boundary", () => {
  it("has no runtime dependencies, ambient credentials, or direct network calls", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: unknown;
    };
    const sources = await Promise.all(
      [
        "device-flow.ts",
        "management-rpc.ts",
        "organizations.ts",
        "parsing.ts",
        "session-status.ts",
        "tokens.ts",
        "webhooks.ts",
      ].map((name) => readFile(resolve(packageRoot, "src", name), "utf8")),
    );
    const source = sources.join("\n");

    expect(manifest.dependencies).toBeUndefined();
    expect(source).not.toMatch(/process\.env|node:(?:http|https|net|tls|dns)|\bfetch\s*\(/u);
    expect(source).not.toMatch(/WORKOS_(?:API_KEY|WEBHOOK_SECRET)/u);
  });
});
