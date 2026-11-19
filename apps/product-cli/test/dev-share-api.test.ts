import { describe, expect, it } from "vitest";

import { GeneratedSdkProductApi } from "../src/product-api.js";

const PROJECT_ID = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const state = {
  project_id: PROJECT_ID,
  mode: "protected",
  share_url: `https://dev-calm-otter-runs.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
};

describe("generated SDK Dev sharing calls", () => {
  it("uses generated preview routes with the selected environment and rejects a foreign response", async () => {
    const calls: string[] = [];
    let project = PROJECT_ID;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(
        `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} ${request.headers.get("idempotency-key") ?? "-"}`,
      );
      return Response.json({
        id: PROJECT_ID,
        project_id: project,
        environment: "prod",
        status: "sleeping",
        url: `https://${"a".repeat(52)}.preview.dev.omh.st`,
        source: null,
      });
    };
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    for (const action of ["get", "open", "stop", "rotate"] as const)
      await api.preview(action, {
        projectId: PROJECT_ID,
        environment: "prod",
        ...(action === "stop" || action === "rotate" ? { idempotencyKey: "one" } : {}),
      });
    expect(calls).toEqual([
      `GET /v1/projects/${PROJECT_ID}/preview?environment=prod -`,
      `POST /v1/projects/${PROJECT_ID}/preview?environment=prod -`,
      `DELETE /v1/projects/${PROJECT_ID}/preview?environment=prod one`,
      `POST /v1/projects/${PROJECT_ID}/preview/token?environment=prod one`,
    ]);
    project = "01K2F3G4H5J6K7M8N9P0QRSTVX";
    await expect(
      api.preview("get", { projectId: PROJECT_ID, environment: "prod" }),
    ).rejects.toThrow("Invalid preview response");
  });

  it("sends each Dev share and access-mode request to its own route with its idempotency key", async () => {
    const calls: { method: string; path: string; key: string | null; body?: unknown }[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get("idempotency-key"),
        ...(text === "" ? {} : { body: JSON.parse(text) as unknown }),
      });
      return Response.json(state);
    };
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(api.ensureDevShareLink(PROJECT_ID)).resolves.toEqual(state);
    await expect(api.rotateDevShareLink(PROJECT_ID, "rotate-1")).resolves.toEqual(state);
    await expect(api.revokeDevShareLink(PROJECT_ID, "revoke-1")).resolves.toEqual(state);
    await expect(api.setDevAccessMode(PROJECT_ID, "public", "mode-1")).resolves.toEqual(state);
    expect(calls).toEqual([
      { method: "POST", path: `/v1/projects/${PROJECT_ID}/dev-share-link`, key: null },
      {
        method: "POST",
        path: `/v1/projects/${PROJECT_ID}/dev-share-link:rotate`,
        key: "rotate-1",
      },
      { method: "DELETE", path: `/v1/projects/${PROJECT_ID}/dev-share-link`, key: "revoke-1" },
      {
        method: "PUT",
        path: `/v1/projects/${PROJECT_ID}/dev-access-mode`,
        key: "mode-1",
        body: { mode: "public" },
      },
    ]);
  });
});
