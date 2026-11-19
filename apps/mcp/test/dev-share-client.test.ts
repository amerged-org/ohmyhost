import { describe, expect, it } from "vitest";

import { GeneratedSdkLocalMcpClient } from "../src/local-client.js";

const PROJECT_ID = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const shared = {
  project_id: PROJECT_ID,
  mode: "protected",
  share_url: `https://dev-calm-otter-runs.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
};

describe("MCP Dev sharing client", () => {
  it("routes Dev share and access-mode calls and validates each returned state", async () => {
    const calls: { method: string; path: string; key: string | null; body?: unknown }[] = [];
    let reply: unknown = shared;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get("idempotency-key"),
        ...(text === "" ? {} : { body: JSON.parse(text) as unknown }),
      });
      return Response.json(reply);
    };
    const client = new GeneratedSdkLocalMcpClient("https://control.example.test", "token", fetch);

    await expect(client.ensureDevShareLink(PROJECT_ID)).resolves.toEqual(shared);
    await expect(
      client.rotateDevShareLink({ projectId: PROJECT_ID, idempotencyKey: "rotate-1" }),
    ).resolves.toEqual(shared);
    await expect(
      client.revokeDevShareLink({ projectId: PROJECT_ID, idempotencyKey: "revoke-1" }),
    ).resolves.toEqual(shared);
    reply = { project_id: PROJECT_ID, mode: "public", share_url: null };
    await expect(
      client.setDevAccessMode({ projectId: PROJECT_ID, mode: "public", idempotencyKey: "mode-1" }),
    ).resolves.toEqual(reply);
    expect(calls.map(({ method, path, key }) => `${method} ${path} ${String(key)}`)).toEqual([
      `POST /v1/projects/${PROJECT_ID}/dev-share-link null`,
      `POST /v1/projects/${PROJECT_ID}/dev-share-link:rotate rotate-1`,
      `DELETE /v1/projects/${PROJECT_ID}/dev-share-link revoke-1`,
      `PUT /v1/projects/${PROJECT_ID}/dev-access-mode mode-1`,
    ]);
    expect(calls[3]?.body).toEqual({ mode: "public" });
    // A share link answered for another project is refused.
    reply = { ...shared, project_id: "01K2F3G4H5J6K7M8N9P0QRSTVX" };
    await expect(client.ensureDevShareLink(PROJECT_ID)).rejects.toThrow(
      "Unexpected Dev share project",
    );
  });
});
