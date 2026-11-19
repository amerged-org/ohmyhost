import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { createLocalOhmyhostMcpHandler } from "../src/local-server.js";

it("publishes the tool catalog exactly as the local server lists its tools", async () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../public-site/src/generated-mcp-tools.json", import.meta.url),
      "utf8",
    ),
  ) as { transport: string; command: string; tools: unknown[] };
  const handler = createLocalOhmyhostMcpHandler({
    authenticatedClient: async () => {
      throw new Error("Catalog discovery requires no customer access");
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
          ?.slice("data: ".length)
      : text;
    const listed = JSON.parse(payload ?? "null") as {
      result?: {
        tools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
      };
    };
    // Both the first invitation and a resend can deliver an email that cannot be undone.
    for (const name of ["native_auth_user_create", "native_auth_user_invite"]) {
      expect(listed.result?.tools?.find((tool) => tool.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      });
    }
    expect(catalog.transport).toBe("stdio");
    expect(catalog.command).toBe("ohmyhost-mcp");
    expect(catalog.tools).toEqual(listed.result?.tools);
  } finally {
    await handler.close();
  }
});

it("describes schedule re-enabling with the local tool names it can call", async () => {
  const handler = createLocalOhmyhostMcpHandler({
    authenticatedClient: async () => {
      throw new Error("Catalog discovery requires no customer access");
    },
  });
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
        ?.slice("data: ".length)
    : text;
  const listed = JSON.parse(payload ?? "null") as {
    result?: { tools?: Array<{ name: string; description?: string }> };
  };
  const description = listed.result?.tools?.find(
    (tool) => tool.name === "database_schedule_set",
  )?.description;
  expect(description).toBeDefined();
  expect(description).not.toContain("--enabled");
  expect(description).not.toContain("schedule get");
  expect(description).toContain("database_schedule_list");
});

it("marks the local plan tools that persist a plan as not read-only", async () => {
  const handler = createLocalOhmyhostMcpHandler({
    authenticatedClient: async () => {
      throw new Error("Catalog discovery requires no customer access");
    },
  });
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
        ?.slice("data: ".length)
    : text;
  const listed = JSON.parse(payload ?? "null") as {
    result?: { tools?: Array<{ name: string; annotations?: Record<string, unknown> }> };
  };
  for (const name of ["deployment_plan", "promotion_plan", "rollback_plan", "delete_plan"]) {
    const tool = listed.result?.tools?.find((candidate) => candidate.name === name);
    expect(tool?.annotations?.["readOnlyHint"], name).toBe(false);
  }
});
