/* global console, Request */
import { format } from "prettier";
import { writeFile } from "node:fs/promises";
import { createLocalOhmyhostMcpHandler } from "../apps/mcp/dist/local-server.js";
const handler = createLocalOhmyhostMcpHandler({
  authenticatedClient: async () => {
    throw new Error("Documentation discovery requires no customer access");
  },
});
try {
  const response = await handler.fetch(
    new Request("https://mcp.ohmyho.st/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  const result = JSON.parse(payload ?? "null");
  if (!response.ok || !Array.isArray(result.result?.tools) || result.result.tools.length === 0)
    throw Error("MCP discovery failed");
  const output =
    JSON.stringify(
      { transport: "stdio", command: "ohmyhost-mcp", tools: result.result.tools },
      null,
      2,
    ) + "\n";
  await writeFile(
    "apps/public-site/src/generated-mcp-tools.json",
    await format(output, { parser: "json", printWidth: 100 }),
  );
  console.log(JSON.stringify({ tools: result.result.tools.length }));
} finally {
  await handler.close();
}
