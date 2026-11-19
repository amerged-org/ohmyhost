import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("keeps the MCP Worker's invocation logs off, because Workers Logs would keep each request URL", async () => {
  const text = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(
    text.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"),
  ) as Record<string, unknown>;

  expect(config["name"]).toBe("ohmyho-sandbox-mcp");
  expect(config["observability"]).toMatchObject({
    enabled: true,
    logs: { enabled: true, persist: true, invocation_logs: false },
  });
});
