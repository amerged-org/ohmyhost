import { describe, expect, it } from "vitest";
import {
  parseProductCliCommand,
  InvalidCommandError,
  recognizedCommandLabel,
} from "../src/command.js";
import { createServer } from "node:http";
import { once } from "node:events";
import type { WorkosDeviceFlowClient } from "@ohmyhost/workos-auth-contracts/device-flow";
import { ProductCli } from "../src/cli.js";
import { GeneratedSdkProductApi } from "../src/product-api.js";
import { GeneratedSdkLocalMcpClient } from "../../mcp/src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../../mcp/src/local-server.js";
import { createOperationDataChangeResult } from "@ohmyhost/contracts/operation-data-change-result";
import { parseWithLinkedProject } from "../src/composition.js";

const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const etag = `"sha256-${"a".repeat(64)}"`;
const confirmation = "c".repeat(43);
const kinds = [
  "isolate_prod_keeps_data",
  "isolate_dev_keeps_data",
  "share_prod_keeps_data",
  "reset_dev",
] as const;
const operation = {
  id: projectId,
  state: "queued" as const,
  created_at: "2026-09-28T12:00:00.000Z",
  updated_at: "2026-09-28T12:00:00.000Z",
};
const plan = (change: (typeof kinds)[number]) => ({
  action: "data_change" as const,
  project_id: projectId,
  change,
  data_mode_before: change.startsWith("isolate_") ? "shared" : "isolated",
  data_mode_after: change === "share_prod_keeps_data" ? "shared" : "isolated",
  effects: ["Prod keeps the selected data."],
  destructive_effects: [],
  redeploy_environments: [change === "isolate_dev_keeps_data" ? "prod" : "dev"],
  risks: [],
  resource_etag: etag,
  confirmation_token: confirmation,
  created_at: operation.created_at,
  expires_at: "2026-09-28T12:10:00.000Z",
});

async function httpFixture() {
  const calls: {
    path: string;
    method: string | undefined;
    body: unknown;
    authorization: string | undefined;
    etag: string | undefined;
    confirmation: string | undefined;
    key: string | undefined;
  }[] = [];
  let badPlan = false;
  let change: (typeof kinds)[number] = "reset_dev";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const parsed = body ? JSON.parse(body) : null;
    const path = request.url ?? "/";
    calls.push({
      path,
      method: request.method,
      body: parsed,
      authorization: request.headers.authorization,
      etag: request.headers["if-match"] as string | undefined,
      confirmation: request.headers["x-confirmation-token"] as string | undefined,
      key: request.headers["idempotency-key"] as string | undefined,
    });
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/data-changes:plan"))
      response.end(
        JSON.stringify(badPlan ? { ...plan(parsed.change), invented: true } : plan(parsed.change)),
      );
    else if (path.endsWith("/data-changes")) {
      change = parsed.change;
      response.statusCode = 202;
      response.end(JSON.stringify(operation));
    } else if (path.startsWith("/v1/operations/"))
      response.end(
        JSON.stringify({
          ...operation,
          state: "succeeded",
          result: createOperationDataChangeResult({
            operationId: operation.id,
            change,
            data_mode: plan(change).data_mode_after as "shared" | "isolated",
            redeploy_environments: plan(change).redeploy_environments as ("dev" | "prod")[],
            deleted_database: false,
            deleted_files: 0,
          }),
        }),
      );
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local HTTP address missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    badPlan: () => {
      badPlan = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function mcpRequest(
  handler: { fetch(request: Request): Promise<Response> },
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
  );
  const text = await response.text();
  const body = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  if (!body) throw new Error("MCP response missing");
  return JSON.parse(body) as {
    result?: {
      tools?: { name: string; description?: string; annotations?: Record<string, unknown> }[];
      content?: { text?: string }[];
      isError?: boolean;
    };
  };
}

describe("project data change client surfaces", () => {
  it("accepts the four planned changes and requires explicit confirmation and every execution guard", async () => {
    for (const change of kinds) {
      const plan = [
        "project",
        "data",
        "plan",
        "--project",
        projectId,
        "--change",
        change,
        "--json",
      ];
      const execute = [
        "project",
        "data",
        "change",
        "--project",
        projectId,
        "--change",
        change,
        "--if-match",
        etag,
        "--confirmation-token",
        confirmation,
        "--idempotency-key",
        "data-change-1",
        "--yes",
        "--wait",
        "--json",
      ];
      expect(parseProductCliCommand(plan)).toMatchObject({
        kind: "project-data-plan",
        projectId,
        change,
      });
      expect(parseProductCliCommand(execute)).toMatchObject({
        kind: "project-data-change",
        projectId,
        change,
        ifMatch: etag,
        confirmationToken: confirmation,
        idempotencyKey: "data-change-1",
        wait: true,
      });
      expect(
        parseProductCliCommand(
          execute.map((value) => (value === "data-change-1" ? "k".repeat(128) : value)),
        ),
      ).toMatchObject({ idempotencyKey: "k".repeat(128) });
      expect(() =>
        parseProductCliCommand(
          execute.map((value) => (value === "data-change-1" ? "k".repeat(129) : value)),
        ),
      ).toThrow(InvalidCommandError);
      expect(recognizedCommandLabel(plan)).toBe("project data plan");
      expect(recognizedCommandLabel(execute)).toBe("project data change");
      expect(parseProductCliCommand(["project", "data", "change", "--help", "--json"])).toEqual({
        kind: "help",
        topic: "project data change",
      });
      for (const flag of ["--yes", "--if-match", "--confirmation-token", "--idempotency-key"]) {
        const removed = [...execute];
        removed.splice(removed.indexOf(flag), flag === "--yes" ? 1 : 2);
        expect(() => parseProductCliCommand(removed)).toThrow(InvalidCommandError);
      }
      expect(() => parseProductCliCommand([...plan, "--yes"])).toThrow(InvalidCommandError);
      expect(() => parseProductCliCommand([...plan, "--wait"])).toThrow(InvalidCommandError);
      expect(() =>
        parseProductCliCommand(
          plan.map((value) => (value === change ? "copy_dev_to_prod" : value)),
        ),
      ).toThrow(InvalidCommandError);
      expect(
        (
          await parseWithLinkedProject(
            plan.filter((value, index) => value !== "--project" && plan[index - 1] !== "--project"),
            async () => ({ outcome: "linked", projectId, organizationId: projectId }),
          )
        ).command,
      ).toMatchObject({ kind: "project-data-plan", projectId, change });
    }
    expect(() =>
      parseProductCliCommand([
        "project",
        "create",
        "--organization",
        projectId,
        "--name",
        "Guard",
        "--idempotency-key",
        "k".repeat(129),
        "--json",
      ]),
    ).toThrow(InvalidCommandError);
  });
  it("uses only generated SDK requests and keeps the plan guards, replay key and waited result through CLI", async () => {
    const fixture = await httpFixture();
    const api = new GeneratedSdkProductApi(fixture.origin, "client-user-token", fetch);
    const mcp = new GeneratedSdkLocalMcpClient(fixture.origin, "client-user-token", fetch);
    const unexpected = async (): Promise<never> => {
      throw new Error("Unselected authentication dependency");
    };
    const cli = new ProductCli({
      commandPrefix: "ohmyhost",
      apiToken: "client-user-token",
      credentialStore: () => ({ read: unexpected, replace: unexpected, clear: unexpected }),
      deviceFlow: {} as WorkosDeviceFlowClient,
      deviceAuthorizationPresenter: { present: unexpected },
      productApi: () => api,
      accountProfile: unexpected,
      projectLinkStore: { save: unexpected },
      productApiOrigin: fixture.origin,
      tokenRevoker: { revoke: unexpected },
      tokenRefresher: { refresh: unexpected },
      now: () => new Date(operation.created_at),
      waitUntil: async () => undefined,
      lifecycleTimeoutMs: 1000,
      createCorrelationId: () => "data-test",
      diagnosticSink: { record: () => undefined },
      readSecretValue: unexpected,
    });
    try {
      for (const client of [api, mcp]) {
        expect(await client.planProjectDataChange({ projectId, change: "reset_dev" })).toEqual(
          plan("reset_dev"),
        );
        expect(
          await client.createProjectDataChange({
            projectId,
            change: "reset_dev",
            ifMatch: etag,
            confirmationToken: confirmation,
            idempotencyKey: "same-data-key",
          }),
        ).toMatchObject(operation);
        expect(fixture.calls.at(-1)).toMatchObject({
          method: "POST",
          path: `/v1/projects/${projectId}/data-changes`,
          body: { change: "reset_dev" },
          etag,
          confirmation,
          key: "same-data-key",
          authorization: "Bearer client-user-token",
        });
      }
      for (const change of kinds) {
        const planned = await cli.run([
          "project",
          "data",
          "plan",
          "--project",
          projectId,
          "--change",
          change,
          "--json",
        ]);
        expect(planned.exitCode).toBe(0);
        expect(JSON.parse(planned.stdout)).toMatchObject({
          command: "project data plan",
          status: "planned",
          plan: plan(change),
        });
        const args = [
          "project",
          "data",
          "change",
          "--project",
          projectId,
          "--change",
          change,
          "--if-match",
          etag,
          "--confirmation-token",
          confirmation,
          "--idempotency-key",
          "same-data-key",
          "--yes",
          "--json",
        ];
        const accepted = await cli.run(args);
        expect(accepted.exitCode).toBe(0);
        expect(JSON.parse(accepted.stdout)).toMatchObject({ status: "accepted", operation });
        const completed = await cli.run([...args, "--wait"]);
        expect(completed.exitCode).toBe(0);
        expect(JSON.parse(completed.stdout)).toMatchObject({
          command: "project data change",
          status: "completed",
          operation: {
            id: operation.id,
            state: "succeeded",
            result: {
              schemaVersion: "ohmyhost.operation-data-change-result/v1",
              operationId: operation.id,
              change,
              data_mode: plan(change).data_mode_after,
              deleted_database: false,
              deleted_files: 0,
            },
          },
        });
        expect(fixture.calls.at(-2)).toMatchObject({
          key: "same-data-key",
          etag,
          confirmation,
          body: { change },
        });
        expect(fixture.calls.at(-1)).toMatchObject({
          method: "GET",
          path: `/v1/operations/${operation.id}`,
        });
      }
      fixture.badPlan();
      await expect(
        mcp.planProjectDataChange({ projectId, change: "reset_dev" }),
      ).rejects.toMatchObject({ name: "ResponseContractError" });
      const invalid = await cli.run([
        "project",
        "data",
        "plan",
        "--project",
        projectId,
        "--change",
        "reset_dev",
        "--json",
      ]);
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        error: { code: "response_contract_invalid", retryable: false },
      });
      expect(fixture.calls.at(-1)?.path).toBe(`/v1/projects/${projectId}/data-changes:plan`);
    } finally {
      await fixture.close();
    }
  });
  it("advertises mutating MCP plans and confirmed destructive changes and preserves every guard at the SDK boundary", async () => {
    const fixture = await httpFixture();
    const client = new GeneratedSdkLocalMcpClient(fixture.origin, "client-user-token", fetch);
    const handler = createLocalOhmyhostMcpHandler({ authenticatedClient: async () => client });
    try {
      const catalog = await mcpRequest(handler, "tools/list");
      expect(
        catalog.result?.tools?.find((tool) => tool.name === "project_data_plan")?.annotations,
      ).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(
        catalog.result?.tools?.find((tool) => tool.name === "project_data_change")?.annotations,
      ).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      for (const change of kinds) {
        const planned = await mcpRequest(handler, "tools/call", {
          name: "project_data_plan",
          arguments: { project_id: projectId, change },
        });
        expect(planned.result?.isError).not.toBe(true);
        expect(JSON.parse(planned.result?.content?.[0]?.text ?? "null")).toEqual(plan(change));
        const args = {
          project_id: projectId,
          change,
          if_match: etag,
          confirmation_token: confirmation,
          idempotency_key: "mcp-data-key",
        };
        const before = fixture.calls.length;
        const tooLong = await mcpRequest(handler, "tools/call", {
          name: "project_data_change",
          arguments: { ...args, idempotency_key: "k".repeat(129), confirmed: true },
        });
        expect(tooLong.result?.isError).toBe(true);
        expect(fixture.calls).toHaveLength(before);
        expect(
          (
            await mcpRequest(handler, "tools/call", {
              name: "project_data_change",
              arguments: args,
            })
          ).result?.isError,
        ).toBe(true);
        expect(fixture.calls).toHaveLength(before);
        const changed = await mcpRequest(handler, "tools/call", {
          name: "project_data_change",
          arguments: { ...args, confirmed: true },
        });
        expect(changed.result?.isError).not.toBe(true);
        expect(JSON.parse(changed.result?.content?.[0]?.text ?? "null")).toEqual(operation);
        expect(fixture.calls.at(-1)).toMatchObject({
          path: `/v1/projects/${projectId}/data-changes`,
          method: "POST",
          body: { change },
          etag,
          confirmation,
          key: "mcp-data-key",
        });
      }
    } finally {
      await handler.close();
      await fixture.close();
    }
  });
});
