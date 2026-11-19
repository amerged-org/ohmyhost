import mcpPackage from "../package.json" with { type: "json" };
import { afterAll, describe, expect, it } from "vitest";

import { listOhmyhostSkillResources } from "@ohmyhost/agent-skills";

import { ohmyhostMcpHandler } from "../src/index.js";
import { createLocalOhmyhostMcpHandler } from "../src/local-server.js";
import { createOhmyhostMcpWorker } from "../src/worker-main.js";

const environment = {
  MCP_ALLOWED_HOST: "mcp.ohmyho.st",
  MCP_ALLOWED_ORIGIN_HOST: "app.ohmyho.st",
};

afterAll(async () => {
  await ohmyhostMcpHandler.close();
});

describe("ohmyhost MCP skill resources", () => {
  it("discovers and reads the same guidance beside product tools before authentication", async () => {
    let authenticationCalls = 0;
    const local = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () => {
        authenticationCalls += 1;
        throw new Error("Customer has not logged in");
      },
    });
    try {
      const initialized = (await readMcpResponse(
        await requestMcp(
          "initialize",
          {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "version-acceptance", version: "1" },
          },
          local,
        ),
      )) as { result: { instructions: string } };
      expect(initialized).toMatchObject({
        result: {
          serverInfo: { version: mcpPackage.version },
          instructions: expect.stringMatching(
            /skill:\/\/ohmyhost\/ohmyhost-get-started\/SKILL\.md.*identity_get.*support.*feedback_submit.*feedback_status.*https:\/\/docs\.ohmyho\.st\/support/su,
          ),
        },
      });
      // Clients can truncate initialize guidance: the account/binding decision must arrive
      // before onboarding or any authenticated call, even beside a remote connector.
      const earlyGuidance = initialized.result.instructions.slice(0, 512);
      expect(earlyGuidance).toMatch(/existing app.*reachable workspace.*saved project binding/u);
      expect(earlyGuidance).toMatch(
        /matching local CLI\/MCP profile.*unless the user chooses remote/u,
      );
      expect(earlyGuidance).toMatch(/Remote tool availability alone never selects remote/u);
      expect(earlyGuidance).toMatch(/private token source.*verify its identity and workspace/u);
      expect(earlyGuidance).toMatch(/identity\/workspace mismatches, stop the access-link loop/u);
      expect(earlyGuidance).toMatch(
        /access gap, not deleted credentials.*unrelated Review\/demo account/u,
      );
      expect(initialized.result.instructions.indexOf("Read the resource skill://")).toBeGreaterThan(
        earlyGuidance.length,
      );
      expect(earlyGuidance).toContain("or change the saved source.");
      const listing = (await readMcpResponse(
        await requestMcp("resources/list", undefined, local),
      )) as { result?: { resources?: Array<{ uri: string }> } };
      expect(listing.result?.resources?.map(({ uri }) => uri)).toEqual(
        listOhmyhostSkillResources().map(({ uri }) => uri),
      );
      for (const resource of listOhmyhostSkillResources()) {
        expect(
          await readMcpResponse(await requestMcp("resources/read", { uri: resource.uri }, local)),
        ).toMatchObject({
          result: {
            contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
          },
        });
      }
      expect(await readMcpResponse(await requestMcp("tools/list", undefined, local))).toMatchObject(
        {
          result: {
            tools: expect.arrayContaining([expect.objectContaining({ name: "database_query" })]),
          },
        },
      );
      expect(authenticationCalls).toBe(0);
    } finally {
      await local.close();
    }
  });

  it("lists every packaged skill resource through the real MCP handler", async () => {
    const response = await requestMcp("resources/list");
    expect(response.status).toBe(200);
    const body = (await readMcpResponse(response)) as {
      result?: { resources?: Array<{ uri?: string; mimeType?: string }> };
    };
    expect(body.result?.resources).toEqual(
      listOhmyhostSkillResources().map((resource) => ({
        uri: resource.uri,
        name: `${resource.skillName}:${resource.relativePath}`,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    );
  });

  it("reads exact skill bytes and rejects an unknown resource", async () => {
    const [resource] = listOhmyhostSkillResources();
    if (!resource) throw new Error("Expected one packaged skill resource");
    const response = await requestMcp("resources/read", { uri: resource.uri });
    const body = (await readMcpResponse(response)) as {
      result?: { contents?: Array<{ uri?: string; text?: string }> };
    };
    expect(body.result?.contents).toEqual([
      { uri: resource.uri, mimeType: resource.mimeType, text: resource.text },
    ]);

    const unknown = await requestMcp("resources/read", {
      uri: "skill://ohmyhost/unknown/SKILL.md",
    });
    expect(unknown.status).toBe(200);
    expect(await readMcpResponse(unknown)).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("keeps the hosted HTTP surface resource-only", async () => {
    const response = await requestMcp("tools/list");
    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("enforces the exact public path, Host, and browser Origin before MCP", async () => {
    const worker = createOhmyhostMcpWorker();
    expect(
      (await worker.fetch(new Request("https://mcp.ohmyho.st/unknown"), environment)).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          new Request("https://foreign.example/mcp", {
            method: "POST",
            headers: { host: "foreign.example" },
          }),
          environment,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request("https://mcp.ohmyho.st/mcp", {
            method: "POST",
            headers: { origin: "https://evil.example" },
          }),
          environment,
        )
      ).status,
    ).toBe(403);
    const health = await worker.fetch(new Request("https://mcp.ohmyho.st/health"), environment);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "healthy",
      resources: "available",
    });
  });
});

function requestMcp(
  method: string,
  params?: Record<string, unknown>,
  handler = ohmyhostMcpHandler,
) {
  return handler.fetch(
    new Request("https://mcp.ohmyho.st/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    }),
  );
}

async function readMcpResponse(response: Response) {
  const text = await response.text();
  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
    return JSON.parse(text) as unknown;
  }
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (!data) throw new Error("MCP SSE response did not contain a data event");
  return JSON.parse(data) as unknown;
}
