import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";

import { ohmyhostMcpHandler } from "./index.js";

interface McpEnvironment {
  readonly MCP_ALLOWED_HOST: string;
  readonly MCP_ALLOWED_ORIGIN_HOST: string;
}

export function createOhmyhostMcpWorker() {
  return {
    async fetch(request: Request, environment: McpEnvironment): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json(
          { status: "healthy", resources: "available" },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (url.pathname !== "/mcp") {
        return new Response("Not Found", {
          status: 404,
          headers: { "cache-control": "no-store" },
        });
      }
      const rejected =
        hostHeaderValidationResponse(request, [environment.MCP_ALLOWED_HOST]) ??
        originValidationResponse(request, [environment.MCP_ALLOWED_ORIGIN_HOST]);
      return rejected ?? ohmyhostMcpHandler.fetch(request);
    },
  };
}

export default createOhmyhostMcpWorker();
