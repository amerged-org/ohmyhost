import { ProductCli } from "../../product-cli/src/cli.js";
import { GeneratedSdkProductApi } from "../../product-cli/src/product-api.js";
import {
  parseOperation,
  parseSafeProblem,
  ResponseContractError,
} from "../../product-cli/src/runtime-contract.js";
import { GeneratedSdkLocalMcpClient } from "../../mcp/src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../../mcp/src/local-server.js";
import type { WorkosDeviceFlowClient } from "@ohmyhost/workos-auth-contracts/device-flow";
import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import { parseUlid, type Operation } from "@ohmyhost/platform";
import {
  DevShareRotationConflictError,
  PoweredByFlagIdempotencyConflictError,
  PoweredByFlagRequiredError,
  ProjectComputeChangeError,
} from "@ohmyhost/database";
import { describe, expect, it, vi } from "vitest";

import {
  ACTION_CONFIRMATION_TTL_SECONDS,
  DEPLOYMENT_PLAN_TTL_SECONDS,
  createControlApi,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableDevAccessTicketsPort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  createProjectDatabaseDiagnosticsPort,
  IdempotencyKeyReusedError,
  ProductSurfaceConflictError,
  SourceAdmissionPolicyInconsistentError,
  type ControlApiDependencies,
} from "../src/index.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const DEPLOYMENT_ID = parseUlid("00000000000000000000000003");
const OPERATION_ID = parseUlid("00000000000000000000000004");
const EVENT_ID = parseUlid("00000000000000000000000005");
const SOURCE_CONNECTION_ID = parseUlid("00000000000000000000000006");
const NOW = "2026-08-19T12:00:00.000Z";
const EXPIRES_10_MINUTES = "2026-08-19T12:10:00.000Z";
const EXPIRES_24_HOURS = "2026-08-20T12:00:00.000Z";
const STRONG_ETAG = `"sha256-${"a".repeat(64)}"`;

describe("Control API product surface", () => {
  it("adds Dev through the scoped operation boundary and rejects invalid bodies or changed authority", async () => {
    const base = dependencies();
    const accepted = {
      status: 202 as const,
      location: `/v1/operations/${OPERATION_ID}`,
      body: { id: OPERATION_ID, state: "queued" as const, created_at: NOW, updated_at: NOW },
    };
    const add = vi.fn<
      NonNullable<ControlApiDependencies["persistence"]["addDevelopmentEnvironment"]>
    >(async () => accepted);
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        persistence: { ...base.persistence, addDevelopmentEnvironment: add },
      }),
    );
    const post = (target = app, body = "{}", key: string | null = "add-dev-1") =>
      target.request(`https://api.test/v1/projects/${PROJECT_ID}/environments/dev`, {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          ...(key === null ? {} : { "Idempotency-Key": key }),
        },
        body,
      });
    const response = await post();
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(accepted.location);
    await expect(response.json()).resolves.toEqual(accepted.body);
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:write" }),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        principalId: "user:user_1",
        idempotencyKey: "add-dev-1",
      }),
    );
    for (const body of ["{", "[]", '{"environment":"prod"}']) {
      const invalid = await post(app, body);
      expect(invalid.status).toBe(400);
    }
    expect((await post(app, "{}", null)).status).toBe(400);
    expect(add).toHaveBeenCalledOnce();

    const denied = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" },
        persistence: { ...base.persistence, addDevelopmentEnvironment: add },
      }),
    );
    expect((await post(denied)).status).toBe(404);
    expect(add).toHaveBeenCalledOnce();
    for (const code of ["scope_inactive", "operation_authorization_changed"]) {
      add.mockRejectedValueOnce(new Error(code));
      expect((await post()).status).toBe(404);
    }
    add.mockRejectedValueOnce(new Error("development_environment_exists"));
    const exists = await post();
    expect(exists.status).toBe(409);
    await expect(exists.json()).resolves.toMatchObject({ code: "development_environment_exists" });
    const unavailable = createControlApi(base);
    expect((await post(unavailable)).status).toBe(503);
  });

  it("does not serve commit-preview routes on the public API", async () => {
    const app = createControlApi(dependencies());
    const preview = "00000000000000000000000007";
    for (const [method, suffix] of [
      ["POST", "/previews"],
      ["GET", "/previews"],
      ["GET", `/previews/${preview}`],
      ["DELETE", `/previews/${preview}`],
      ["POST", `/previews/${preview}/migrations`],
    ]) {
      const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}${suffix}`, {
        method,
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  it("plans a data change through the owner boundary and rejects unknown change kinds", async () => {
    const plan = {
      action: "data_change",
      project_id: PROJECT_ID,
      change: "reset_dev",
      data_mode_before: "isolated",
      data_mode_after: "isolated",
      effects: ["Prod stays available."],
      destructive_effects: ["Dev data is removed."],
      redeploy_environments: ["dev"],
      risks: ["Export SQL before removing Dev data."],
      resource_etag: STRONG_ETAG,
      confirmation_token: "t".repeat(43),
      created_at: NOW,
      expires_at: EXPIRES_10_MINUTES,
    };
    const planDataChange = vi.fn(async () => ({ status: 200 as const, body: plan }));
    const app = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          planDataChange,
        },
      }),
    );
    const options = {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    };
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/data-changes:plan`,
      {
        ...options,
        body: JSON.stringify({ change: "reset_dev" }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(plan);
    expect(planDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, change: "reset_dev" }),
    );
    const invalid = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/data-changes:plan`,
      {
        ...options,
        body: JSON.stringify({ change: "reset_prod" }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(planDataChange).toHaveBeenCalledOnce();
  });

  it("executes one owner-only bounded Dev database query and hides foreign scope", async () => {
    const queryProject = vi.fn(async () => ({
      environment: "dev",
      rows: [{ visits: "1", email: "your-omh-account+maas-poc-20260904@gmail.com" }],
      rowCount: 1,
      truncated: false,
    }));
    const port = createProjectDatabaseDiagnosticsPort({ queryProject });
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({ authorization: { check: authorization }, projectDatabaseDiagnostics: port }),
    );
    const request = {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: "dev",
        statement: "SELECT count(*)::text visits, $1::text email FROM visits",
        parameters: ["your-omh-account+maas-poc-20260904@gmail.com"],
      }),
    };
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/query`,
      request,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      environment: "dev",
      rows: [{ visits: "1", email: "your-omh-account+maas-poc-20260904@gmail.com" }],
      row_count: 1,
      truncated: false,
    });
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:write" }),
    );
    expect(queryProject).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      statement: "SELECT count(*)::text visits, $1::text email FROM visits",
      parameters: ["your-omh-account+maas-poc-20260904@gmail.com"],
    });

    const denied = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" },
        projectDatabaseDiagnostics: port,
      }),
    );
    expect(
      (await denied.request(`https://api.test/v1/projects/${PROJECT_ID}/database/query`, request))
        .status,
    ).toBe(404);
    expect(queryProject).toHaveBeenCalledOnce();

    const invalid = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/database/query`, {
      ...request,
      body: JSON.stringify({
        environment: "dev",
        statement: "DELETE FROM visits",
        parameters: [],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(queryProject).toHaveBeenCalledOnce();
    queryProject.mockResolvedValueOnce({ status: "rejected" } as never);
    const rejected = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/query`,
      request,
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "invalid_request",
      detail: "The read-only diagnostic query could not be executed.",
    });
  });
  it("serves tenant-authorized normalized diagnostic JSON and SSE", async () => {
    const items = [
      {
        id: EVENT_ID,
        source: "runtime",
        code: "RUNTIME_FAILED",
        message: "CUSTOMER_RUNTIME_FAILED",
        occurred_at: NOW,
      },
      {
        id: parseUlid("00000000000000000000000006"),
        source: "build",
        code: "BUILD_FAILED",
        message: "CUSTOMER_BUILD_FAILED",
        excerpt:
          "src/main.ts(3,1): error TS2304: Cannot find name 'foo'.\nELIFECYCLE Command failed",
        excerpt_truncated: true,
        occurred_at: NOW,
      },
      {
        id: parseUlid("00000000000000000000000007"),
        source: "control",
        code: "DEPLOYMENT_FAILED",
        message: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
        occurred_at: NOW,
      },
      {
        id: parseUlid("00000000000000000000000008"),
        source: "function",
        code: "FUNCTION_FAILED",
        message: "CUSTOMER_FUNCTION_FAILED",
        occurred_at: NOW,
      },
    ] as const;
    const list = vi.fn().mockResolvedValue({ items, nextCursor: null });
    const app = createControlApi(dependencies({ deploymentDiagnostics: { list } }));
    const headers = { Authorization: "Bearer valid" };
    const json = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs`,
      { headers },
    );
    expect(json.status).toBe(200);
    await expect(json.json()).resolves.toEqual({ items });
    const sse = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs/events`,
      { headers },
    );
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const stream = await sse.text();
    for (const message of [
      "CUSTOMER_RUNTIME_FAILED",
      "CUSTOMER_BUILD_FAILED",
      "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
      "CUSTOMER_FUNCTION_FAILED",
      "ELIFECYCLE Command failed",
    ])
      expect(stream).toContain(message);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("ends a truncated deployment log stream with the cursor of its next page", async () => {
    const item = {
      id: parseUlid("00000000000000000000000007"),
      source: "control",
      code: "DEPLOYMENT_FAILED",
      message: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
      occurred_at: NOW,
    };
    const list = vi.fn().mockResolvedValue({ items: [item], nextCursor: "next-page-cursor" });
    const app = createControlApi(dependencies({ deploymentDiagnostics: { list } }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs/events`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(200);
    expect(
      (await response.text()).endsWith('event: next\ndata: {"next_cursor":"next-page-cursor"}\n\n'),
    ).toBe(true);
  });
  it("serves build excerpts only as the sanitized tail of a customer build failure", async () => {
    const build = {
      id: EVENT_ID,
      source: "build",
      code: "BUILD_FAILED",
      message: "CUSTOMER_BUILD_FAILED",
      excerpt: "npm ERR! missing script: build",
      excerpt_truncated: false,
      occurred_at: NOW,
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            ...build,
            source: "runtime",
            code: "RUNTIME_FAILED",
            message: "CUSTOMER_RUNTIME_FAILED",
          },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [{ ...build, excerpt: "\u001b[31mnpm ERR!\u001b[0m" }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [{ ...build, excerpt_truncated: "no" }], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...build, excerpt: "" }], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...build, excerpt: "trailing " }], nextCursor: null });
    const app = createControlApi(dependencies({ deploymentDiagnostics: { list } }));
    const headers = { Authorization: "Bearer valid" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request(
        `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs`,
        { headers },
      );
      expect(response.status, String(attempt)).toBe(503);
      expect(await response.text()).not.toContain("npm ERR!");
    }
  });
  it("hides deployment diagnostics when project authorization is denied", async () => {
    const list = vi.fn();
    const app = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" },
        deploymentDiagnostics: { list },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });
  it("rejects malformed diagnostic cursors and extra unsafe response fields", async () => {
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          id: EVENT_ID,
          source: "runtime",
          code: "RUNTIME_FAILED",
          message: "CUSTOMER_RUNTIME_FAILED",
          occurred_at: NOW,
          cookie: "secret",
        },
      ],
      nextCursor: null,
    });
    const app = createControlApi(dependencies({ deploymentDiagnostics: { list } }));
    const headers = { Authorization: "Bearer valid" };
    const malformed = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs?cursor=x&cursor=y`,
      { headers },
    );
    expect(malformed.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    const unsafe = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs`,
      { headers },
    );
    expect(unsafe.status).toBe(503);
    expect(JSON.stringify(await unsafe.json())).not.toContain("secret");
  });
  it("explains a failed health check through REST, the CLI and MCP, and its answer only to owners", async () => {
    const FAILED_AT = "2026-08-19T12:05:00.000Z";
    const failedEvent = { code: "RUNTIME_CANDIDATE_FAILED", message: "private provider detail" };
    const failed = {
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      state: "failed" as const,
      createdAt: NOW,
      updatedAt: FAILED_AT,
      failure: failedEvent,
      deploymentId: DEPLOYMENT_ID,
      events: [
        {
          eventId: EVENT_ID,
          type: "OperationQueued" as const,
          operationId: OPERATION_ID,
          projectId: PROJECT_ID,
          occurredAt: NOW,
        },
        {
          eventId: parseUlid("0000000000000000000000000B"),
          type: "OperationStarted" as const,
          operationId: OPERATION_ID,
          projectId: PROJECT_ID,
          occurredAt: NOW,
          idempotencyKey: "transition-1",
        },
        {
          eventId: parseUlid("0000000000000000000000000C"),
          type: "OperationFailed" as const,
          operationId: OPERATION_ID,
          projectId: PROJECT_ID,
          occurredAt: FAILED_AT,
          idempotencyKey: "transition-2",
          failure: failedEvent,
        },
      ],
    };
    // What the probe answered: a 500 with the application's own text, and a bodiless 307.
    const answered = {
      id: parseUlid("0000000000000000000000000D"),
      source: "runtime",
      code: "HEALTH_CHECK_FAILED",
      message: "CUSTOMER_HEALTH_CHECK_FAILED",
      route: "/",
      status_code: 500,
      excerpt: "Error: DATABASE_URL is not set\n    at fetch (worker.js:3:9)",
      excerpt_truncated: false,
      occurred_at: FAILED_AT,
    };
    const redirected = {
      id: parseUlid("0000000000000000000000000E"),
      source: "runtime",
      code: "HEALTH_CHECK_FAILED",
      message: "CUSTOMER_HEALTH_CHECK_FAILED",
      route: "/",
      status_code: 307,
      occurred_at: NOW,
    };
    const list = vi.fn().mockResolvedValue({ items: [answered, redirected], nextCursor: null });
    const base = dependencies({ deploymentDiagnostics: { list } });
    const app = createControlApi({
      ...base,
      persistence: { ...base.persistence, getOperation: async () => failed },
    });
    const headers = { Authorization: "Bearer valid" };
    const logsUrl = `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/logs`;

    const operation = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers,
    });
    const operationText = await operation.text();
    expect(operationText).not.toContain("private provider detail");
    const { suggested_action: action } = JSON.parse(operationText).error;
    expect(JSON.parse(operationText)).toMatchObject({
      state: "failed",
      deployment_id: DEPLOYMENT_ID,
      error: { code: "runtime_candidate_failed", retryable: false },
    });
    expect(action).toContain("ohmyhost deployment logs");
    expect(action).toContain("--deployment DEPLOYMENT_ULID --json");
    expect(action).not.toContain("--follow");
    expect(action).toContain("deployment_logs");
    expect(await (await app.request(logsUrl, { headers })).json()).toEqual({
      items: [answered, redirected],
    });
    const stream = await (await app.request(`${logsUrl}/events`, { headers })).text();
    expect(stream).toContain('"status_code":500');
    expect(stream).toContain("DATABASE_URL is not set");

    // A running application holds its secrets, so like its database only an owner reads its answer.
    const member = createControlApi({
      ...base,
      authorization: {
        check: async ({ action: requested }) => (requested === "projects:write" ? "deny" : "allow"),
      },
    });
    const unquoted = Object.fromEntries(
      Object.entries(answered).filter(([key]) => !key.startsWith("excerpt")),
    );
    expect(await (await member.request(logsUrl, { headers })).json()).toEqual({
      items: [unquoted, redirected],
    });
    expect(await (await member.request(`${logsUrl}/events`, { headers })).text()).not.toContain(
      "DATABASE_URL",
    );

    // Only a sanitized, bounded answer of a health check, and its HTTP status, may be served.
    for (const invalid of [
      { ...answered, excerpt: "\u001b[31mError: DATABASE_URL is not set\u001b[0m" },
      { ...answered, excerpt: `DATABASE_URL ${"x".repeat(4096)}` },
      { ...answered, status_code: 99 },
      { ...answered, status_code: "500" },
      { ...redirected, code: "RUNTIME_FAILED", message: "CUSTOMER_RUNTIME_FAILED" },
    ]) {
      list.mockResolvedValueOnce({ items: [invalid], nextCursor: null });
      const refused = await app.request(logsUrl, { headers });
      expect(refused.status, JSON.stringify(invalid)).toBe(503);
      expect(await refused.text()).not.toContain("DATABASE_URL");
    }

    // The CLI and MCP read the same through the generated SDK and their exact parsers.
    const fetchPublic: typeof globalThis.fetch = async (input, init) =>
      app.request(new Request(input, init));
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected login");
    };
    const api = new GeneratedSdkProductApi("https://api.test", "valid", fetchPublic);
    const printed: string[] = [];
    const cli = new ProductCli({
      apiToken: "valid",
      commandPrefix: "ohmyhost",
      credentialStore: () => ({ read: unused, replace: unused, clear: unused }),
      deviceFlow: {} as WorkosDeviceFlowClient,
      deviceAuthorizationPresenter: { present: unused },
      productApi: () => api,
      accountProfile: async () => await api.getAccountProfile(),
      projectLinkStore: { save: unused },
      productApiOrigin: "https://api.test",
      tokenRevoker: { revoke: unused },
      tokenRefresher: { refresh: unused },
      now: () => new Date(NOW),
      waitUntil: unused,
      lifecycleTimeoutMs: 1000,
      createCorrelationId: () => "health-diagnosis",
      diagnosticSink: { record: () => undefined },
      operationEventSink: { write: (line) => printed.push(line) },
      readSecretValue: unused,
    });
    const read = await cli.run(["operation", "get", OPERATION_ID, "--json"]);
    expect(JSON.parse(read.stdout).operation).toMatchObject({
      deployment_id: DEPLOYMENT_ID,
      error: { code: "runtime_candidate_failed", suggested_action: action },
    });
    const logs = await cli.run(
      `deployment logs --project ${PROJECT_ID} --deployment ${DEPLOYMENT_ID} --json`.split(" "),
    );
    expect(logs.exitCode).toBe(0);
    expect(printed.map((line) => JSON.parse(line))).toEqual([answered, redirected]);
    expect(() =>
      parseOperation({ ...JSON.parse(operationText), deployment_id: "not-a-deployment" }),
    ).toThrow(ResponseContractError);
    const mcp = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () =>
        new GeneratedSdkLocalMcpClient("https://api.test", "valid", fetchPublic),
    });
    try {
      // A failed operation is an MCP error result that still names its deployment.
      for (const [name, args, expected, failure] of [
        ["operation_get", { operation_id: OPERATION_ID }, { deployment_id: DEPLOYMENT_ID }, true],
        [
          "deployment_logs",
          { project_id: PROJECT_ID, deployment_id: DEPLOYMENT_ID },
          { items: [answered, redirected] },
          undefined,
        ],
      ] as const) {
        const response = await mcp.fetch(
          new Request("https://mcp.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          }),
        );
        const text = await response.text();
        const message = JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? text,
        );
        expect(message.result.isError).toBe(failure);
        expect(JSON.parse(message.result.content[0].text)).toMatchObject(expected);
      }
    } finally {
      await mcp.close();
    }
  });
  it("explains a failed database size change the same way through REST, the CLI and MCP without provider text", async () => {
    const FAILED_AT = "2026-08-19T12:20:00.000Z";
    const set = vi.fn(async () => ({
      status: 202 as const,
      body: { id: OPERATION_ID, state: "queued", created_at: NOW, updated_at: NOW },
      location: `/v1/operations/${OPERATION_ID}`,
    }));
    const failedComputeChange = (code: string) => {
      const failure = { code, message: "node pool eu-1 exhausted at provider.internal" };
      return {
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        state: "failed" as const,
        createdAt: NOW,
        updatedAt: FAILED_AT,
        failure,
        events: [
          {
            eventId: EVENT_ID,
            type: "OperationQueued" as const,
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: NOW,
          },
          {
            eventId: parseUlid("0000000000000000000000000B"),
            type: "OperationStarted" as const,
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: NOW,
            idempotencyKey: "transition-1",
          },
          {
            eventId: parseUlid("0000000000000000000000000C"),
            type: "OperationFailed" as const,
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: FAILED_AT,
            idempotencyKey: "transition-2",
            failure,
          },
        ],
      };
    };
    for (const code of ["DATABASE_COMPUTE_FAILED", "DATABASE_COMPUTE_PLAN_CHANGED"]) {
      const failed = failedComputeChange(code);
      const base = dependencies({ databaseCompute: { set } as never });
      const app = createControlApi({
        ...base,
        persistence: { ...base.persistence, getOperation: async () => failed },
      });
      const fetchPublic: typeof globalThis.fetch = async (input, init) =>
        app.request(new Request(input, init));
      const headers = { Authorization: "Bearer valid" };

      const operation = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
        headers,
      });
      const operationText = await operation.text();
      const restError = JSON.parse(operationText).error;
      expect(restError).toMatchObject({ retryable: false });

      const unused = async (): Promise<never> => {
        throw new Error("Unexpected login");
      };
      const api = new GeneratedSdkProductApi("https://api.test", "valid", fetchPublic);
      const cli = new ProductCli({
        apiToken: "valid",
        commandPrefix: "ohmyhost",
        credentialStore: () => ({ read: unused, replace: unused, clear: unused }),
        deviceFlow: {} as WorkosDeviceFlowClient,
        deviceAuthorizationPresenter: { present: unused },
        productApi: () => api,
        accountProfile: async () => await api.getAccountProfile(),
        projectLinkStore: { save: unused },
        productApiOrigin: "https://api.test",
        tokenRevoker: { revoke: unused },
        tokenRefresher: { refresh: unused },
        now: () => new Date(NOW),
        waitUntil: async () => undefined,
        lifecycleTimeoutMs: 1000,
        createCorrelationId: () => "compute-diagnosis",
        diagnosticSink: { record: () => undefined },
        operationEventSink: { write: () => undefined },
        readSecretValue: unused,
      });
      const waited = await cli.run(
        `database compute set --project ${PROJECT_ID} --environment dev --memory-mib 512 --idempotency-key k --yes --wait --json`.split(
          " ",
        ),
      );
      expect(waited.exitCode).toBe(10);
      const cliError = JSON.parse(waited.stdout).error;

      const mcp = createLocalOhmyhostMcpHandler({
        authenticatedClient: async () =>
          new GeneratedSdkLocalMcpClient("https://api.test", "valid", fetchPublic),
      });
      let mcpError: unknown;
      try {
        const response = await mcp.fetch(
          new Request("https://mcp.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "operation_get", arguments: { operation_id: OPERATION_ID } },
            }),
          }),
        );
        const text = await response.text();
        const message = JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? text,
        );
        expect(message.result.isError).toBe(true);
        mcpError = JSON.parse(message.result.content[0].text).error;
      } finally {
        await mcp.close();
      }

      for (const surface of [restError, cliError, mcpError]) {
        expect(surface).toMatchObject({
          code: code.toLowerCase(),
          message: publicOperationFailure(code).message,
          suggested_action: publicOperationFailure(code).suggested_action,
        });
      }
      expect(restError.message).toMatch(/no credits are charged/u);
      expect(restError.suggested_action).toMatch(/new idempotency key/u);
      for (const rendered of [operationText, waited.stdout, JSON.stringify(mcpError)]) {
        expect(rendered).not.toContain("node pool eu-1");
        expect(rendered).not.toContain("provider.internal");
      }
    }
  });

  it("keeps the unavailable dev access boundary fail-closed", async () => {
    await expect(createUnavailableDevAccessTicketsPort().issue({} as never)).rejects.toThrow(
      "unavailable",
    );
  });
  it("changes the database size through one confirmed write and answers a closed refusal", async () => {
    const set = vi.fn(async () => ({
      status: 202 as const,
      body: { id: OPERATION_ID, state: "queued", created_at: NOW, updated_at: NOW },
      location: `/v1/operations/${OPERATION_ID}`,
    }));
    const app = createControlApi(dependencies({ databaseCompute: { set } as never }));
    const post = (body: unknown, key = "size-1") =>
      app.request(`https://api.test/v1/projects/${PROJECT_ID}/database/compute`, {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });

    const accepted = await post({ environment: "prod", memory_mib: 512, confirm: true });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ id: OPERATION_ID, state: "queued" });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        environment: "prod",
        memoryMiB: 512,
        idempotencyKey: "size-1",
      }),
    );
    // An unconfirmed, ambiguous or unknown size never reaches the compute port.
    for (const body of [
      { environment: "prod", memory_mib: 512 },
      { environment: "prod", memory_mib: 512, profile: "standard", confirm: true },
      { environment: "prod", memory_mib: 300, confirm: true },
    ])
      expect((await post(body, "size-bad")).status).toBe(400);
    expect(set).toHaveBeenCalledTimes(1);

    set.mockRejectedValueOnce(new ProjectComputeChangeError("compute_paid_required"));
    const refused = await post({ environment: "dev", memory_mib: 1024, confirm: true }, "size-2");
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: "compute_paid_required" });
  });

  it("pins the public plan and confirmation TTLs", () => {
    expect(DEPLOYMENT_PLAN_TTL_SECONDS).toBe(86_400);
    expect(ACTION_CONFIRMATION_TTL_SECONDS).toBe(600);
  });
  it.each([
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/source:link`,
      "sources:link",
      { repository_owner: "sebmer-com", repository_name: "fixture" },
    ],
    ["GET", `/v1/projects/${PROJECT_ID}/source`, "sources:read", undefined],
    [
      "PUT",
      `/v1/projects/${PROJECT_ID}/source/auto-deploy`,
      "projects:write",
      { branch: "release/dev", enabled: true },
    ],
    ["GET", `/v1/projects/${PROJECT_ID}/source/auto-deploy`, "projects:read", undefined],
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/deployments:plan`,
      "deployments:plan",
      { commit_sha: "a".repeat(40) },
    ],
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/deployments`,
      "deployments:create",
      { plan_id: DEPLOYMENT_ID },
    ],
    ["GET", `/v1/projects/${PROJECT_ID}/deployments`, "deployments:read", undefined],
    [
      "GET",
      `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`,
      "deployments:read",
      undefined,
    ],
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback-plan`,
      "projects:rollback-plan",
      undefined,
    ],
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback`,
      "projects:rollback",
      undefined,
    ],
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote-plan`,
      "projects:promote-plan",
      undefined,
    ],
    [
      "POST",
      `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote`,
      "projects:promote",
      undefined,
    ],
    ["PUT", `/v1/projects/${PROJECT_ID}/handle`, "projects:write", { handle: "acme-shop" }],
    ["POST", `/v1/projects/${PROJECT_ID}:delete-plan`, "projects:delete-plan", undefined],
    ["DELETE", `/v1/projects/${PROJECT_ID}`, "projects:delete", undefined],
  ] as const)(
    "validates and authorizes %s %s before a stable fail-closed response",
    async (method, path, action, body) => {
      const authorization = vi.fn(async () => "allow" as const);
      const app = createControlApi(dependencies({ authorization: { check: authorization } }));
      const headers: Record<string, string> = { Authorization: "Bearer valid" };
      if (
        [
          "sources:link",
          "projects:write",
          "deployments:create",
          "projects:rollback",
          "projects:promote",
          "projects:delete",
        ].includes(action)
      ) {
        headers["Idempotency-Key"] = "same-request";
      }
      if (
        action === "projects:rollback" ||
        action === "projects:promote" ||
        action === "projects:delete"
      ) {
        headers["If-Match"] = '"7"';
        headers["X-Confirmation-Token"] = "x".repeat(32);
      }
      // A rename is guarded by the project's ETag, without a confirmation token.
      if (path.endsWith("/handle")) headers["If-Match"] = '"7"';
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const response = await app.request(`https://api.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      expect(response.status, await response.clone().text()).toBe(503);
      expect(await response.json()).toMatchObject({ code: "service_unavailable", retryable: true });
      expect(
        (authorization.mock.calls as unknown as readonly [Readonly<{ action: string }>][]).some(
          ([check]) => check.action === action,
        ),
      ).toBe(true);
    },
  );

  it("returns BOLA 404 and never calls the product port for a foreign project", async () => {
    const surface = { ...createUnavailableProductSurfacePort(), getSource: vi.fn() };
    const app = createControlApi(
      dependencies({ authorization: { check: async () => "deny" }, productSurface: surface }),
    );
    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/source`, {
      headers: { Authorization: "Bearer valid" },
    });
    expect(response.status).toBe(404);
    expect(surface.getSource).not.toHaveBeenCalled();
  });

  it("returns the indistinguishable 404 when a new delete key targets a tombstone", async () => {
    const deleteProject = vi.fn(async () => null);
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        productSurface: { ...createUnavailableProductSurfacePort(), deleteProject },
      }),
    );
    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer valid",
        "Idempotency-Key": "delete-after-tombstone",
        "If-Match": '"7"',
        "X-Confirmation-Token": "x".repeat(32),
      },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "resource_not_found", retryable: false });
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:delete" }),
    );
    expect(deleteProject).toHaveBeenCalledOnce();
  });

  it("hides cross-project rollback planning before resolving the selected deployment environment", async () => {
    const planRollback = vi.fn();
    const surface = { ...createUnavailableProductSurfacePort(), planRollback };
    const app = createControlApi(
      dependencies({ authorization: { check: async () => "deny" }, productSurface: surface }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback-plan`,
      { method: "POST", headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(404);
    expect(planRollback).not.toHaveBeenCalled();
  });

  it("rejects member writes and invalid mutation guards before the product port", async () => {
    const linkSource = vi.fn();
    const rollback = vi.fn();
    const surface = { ...createUnavailableProductSurfacePort(), linkSource, rollback };
    const memberApp = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "projects:read" ? "allow" : "deny"),
        },
        productSurface: surface,
      }),
    );
    const member = await memberApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/source:link`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "member-link",
        },
        body: JSON.stringify({
          repository_owner: "owner",
          repository_name: "repo",
        }),
      },
    );
    const ownerApp = createControlApi(dependencies({ productSurface: surface }));
    const invalidGuard = await ownerApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Idempotency-Key": "rollback-1",
          "If-Match": '"7"',
          "X-Confirmation-Token": "short",
        },
      },
    );
    expect(member.status).toBe(404);
    expect(invalidGuard.status).toBe(400);
    expect(linkSource).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("hides promotion from an unauthorized or foreign project before the product port", async () => {
    const planPromotion = vi.fn();
    const promote = vi.fn();
    const surface = { ...createUnavailableProductSurfacePort(), planPromotion, promote };
    const denied = createControlApi(
      dependencies({ authorization: { check: async () => "deny" }, productSurface: surface }),
    );
    const deniedResponse = await denied.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote-plan`,
      { method: "POST", headers: { Authorization: "Bearer valid" } },
    );
    const baseline = dependencies({ productSurface: surface });
    const foreign = createControlApi({
      ...baseline,
      persistence: {
        ...baseline.persistence,
        getProject: async () => null,
      },
    });
    const foreignResponse = await foreign.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Idempotency-Key": "promotion-foreign",
          "If-Match": STRONG_ETAG,
          "X-Confirmation-Token": "x".repeat(32),
        },
      },
    );
    expect(deniedResponse.status).toBe(404);
    expect(foreignResponse.status).toBe(404);
    expect(planPromotion).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it("rejects malformed promotion guards before authorization and persistence", async () => {
    const authorize = vi.fn(async () => "allow" as const);
    const promote = vi.fn();
    const app = createControlApi(
      dependencies({
        authorization: { check: authorize },
        productSurface: { ...createUnavailableProductSurfacePort(), promote },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Idempotency-Key": "promotion-invalid-guard",
          "If-Match": "x",
          "X-Confirmation-Token": "short",
        },
      },
    );
    expect(response.status).toBe(400);
    expect(promote).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:promote" }),
    );
  });

  it.each([
    "feature..one",
    "feature@{one",
    "feature one",
    "feature\\one",
    ".hidden",
    "release.lock",
    "trailing.",
    "a//b",
    "a~b",
    "a?b",
    "a[b",
  ])("rejects invalid Git branch syntax before auto-deploy mutation: %s", async (branch) => {
    const configureAutoDeploy = vi.fn();
    const app = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          configureAutoDeploy,
        },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/source/auto-deploy`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "invalid-branch",
        },
        body: JSON.stringify({ branch, enabled: true }),
      },
    );
    expect(response.status).toBe(400);
    expect(configureAutoDeploy).not.toHaveBeenCalled();
  });

  it("validates and returns the exact source auto-deploy projection", async () => {
    const body = {
      branch: "main",
      ref: "refs/heads/main",
      environment: "dev",
      enabled: true,
      generation: 2,
      grant_status: "active",
      updated_at: NOW,
    };
    const configureAutoDeploy = vi.fn().mockResolvedValue({ status: 200, body });
    const app = createControlApi(
      dependencies({
        productSurface: { ...createUnavailableProductSurfacePort(), configureAutoDeploy },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/source/auto-deploy`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "valid-auto-deploy",
        },
        body: JSON.stringify({ branch: "main", enabled: true }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
  });

  it("answers auto-deploy without a ready GitHub source as a non-retryable 409, never a 503", async () => {
    const app = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          configureAutoDeploy: async () => {
            throw new ProductSurfaceConflictError("auto_deploy_source_unavailable");
          },
        },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/source/auto-deploy`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "auto-deploy-without-source",
        },
        body: JSON.stringify({ branch: "main", enabled: true }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "auto_deploy_source_unavailable",
      retryable: false,
    });
  });

  it.each([
    "promotion_source_stale",
    "promotion_target_stale",
    "promotion_invalid_target",
  ] as const)("returns typed promotion conflict %s", async (reason) => {
    const app = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          promote: async () => {
            throw new ProductSurfaceConflictError(reason);
          },
        },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Idempotency-Key": `promotion-${reason}`,
          "If-Match": STRONG_ETAG,
          "X-Confirmation-Token": "x".repeat(32),
        },
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: reason, retryable: false });
  });

  it("returns only the exact guarded promotion plan and forwards its source identity", async () => {
    const body = {
      action: "promote",
      project_id: PROJECT_ID,
      source_deployment_id: DEPLOYMENT_ID,
      source_artifact_digest: `sha256:${"d".repeat(64)}`,
      source_environment: "dev",
      target_environment: "prod",
      resource_etag: STRONG_ETAG,
      effects: ["Activate the verified dev artifact in prod without rebuilding."],
      risks: ["Production requests use the promoted artifact after activation."],
      confirmation_token: "x".repeat(32),
      created_at: NOW,
      expires_at: EXPIRES_10_MINUTES,
    };
    const planPromotion = vi.fn(async () => ({ status: 200 as const, body }));
    const app = createControlApi(
      dependencies({
        productSurface: { ...createUnavailableProductSurfacePort(), planPromotion },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote-plan`,
      { method: "POST", headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(planPromotion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        sourceDeploymentId: DEPLOYMENT_ID,
        principalId: "user:user_1",
      }),
    );
  });

  it.each([
    [
      new ProductSurfaceConflictError("deployment_plan_expired"),
      "The deployment plan has expired.",
      "deployment_plan_expired",
    ],
    [
      new ProductSurfaceConflictError("deployment_plan_incompatible"),
      "The deployment plan must be regenerated before deployment.",
      "deployment_plan_incompatible",
    ],
    [
      new ProductSurfaceConflictError("confirmation_expired"),
      "The confirmation token has expired.",
      "confirmation_expired",
    ],
    [
      new ProductSurfaceConflictError("confirmation_invalid"),
      "The confirmation token does not match this action.",
      "confirmation_invalid",
    ],
    [
      new ProductSurfaceConflictError("etag_mismatch"),
      "The resource changed after the action was planned.",
      "etag_mismatch",
    ],
    [
      new ProductSurfaceConflictError("mail_domain_conflict"),
      "The project already has a different sender domain.",
      "mail_domain_conflict",
    ],
  ] as const)(
    "returns a redacted 409 for guarded action conflicts",
    async (failure, detail, code) => {
      const surface = {
        ...createUnavailableProductSurfacePort(),
        rollback: async () => {
          throw failure;
        },
      };
      const app = createControlApi(dependencies({ productSurface: surface }));
      const response = await app.request(
        `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Idempotency-Key": "rollback-conflict",
            "If-Match": '"7"',
            "X-Confirmation-Token": "x".repeat(32),
          },
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code, detail });
    },
  );

  it("returns the idempotency conflict contract for a changed payload", async () => {
    const surface = {
      ...createUnavailableProductSurfacePort(),
      configureAutoDeploy: async () => {
        throw new IdempotencyKeyReusedError();
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/source/auto-deploy`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "reused",
        },
        body: JSON.stringify({
          branch: "main",
          enabled: true,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "idempotency_key_reused" });
  });

  it("returns an agent-actionable conflict when the source cannot run on Workers", async () => {
    const surface = {
      ...createUnavailableProductSurfacePort(),
      planDeployment: async () => {
        throw new ProductSurfaceConflictError("workers_runtime_incompatible");
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: "https://docs.ohmyho.st/errors/workers-runtime-incompatible",
      title: "Workers runtime incompatible",
      code: "workers_runtime_incompatible",
      retryable: false,
      detail:
        "This application imports a native addon or a Node.js API that does not function on Workers.",
      suggested_action: expect.stringMatching(
        /native addon.*child_process.*Remove or replace.*save or push the corrected version.*plan its commit/u,
      ),
    });
  });

  it("returns an agent-actionable conflict when a mail project has no sender domain", async () => {
    const surface = {
      ...createUnavailableProductSurfacePort(),
      planDeployment: async () => {
        throw new ProductSurfaceConflictError("mail_domain_required");
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "mail_domain_required",
      retryable: false,
      detail:
        "This app declares mail, so it needs the project's own verified sender domain before planning.",
      suggested_action:
        "This app declares mail.enabled. Configure a sender with 'ohmyhost mail setup' or explicitly attach an authorized workspace sender using the project's Prod environment ID. Reuse first requires proof of the intended application hostname with the same registrable main domain; declare and verify that identity before mail-gated deployment. Then plan again.",
    });
  });

  it("preserves explicit and omitted deployment targets and reports a missing Dev", async () => {
    const targets: unknown[] = [];
    const body = {
      id: DEPLOYMENT_ID,
      project_id: PROJECT_ID,
      environment: "prod",
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"b".repeat(64)}`,
      build_plan_digest: `sha256:${"c".repeat(64)}`,
      application_root: "site",
      runtime: "cloudflare_workers_edge_ssr",
      route: "https://calm-panda-builds.dev.check.omh.st",
      resource_effects: [],
      limits: [],
      estimated_cost: {
        amount_micros: "0",
        currency: "USD",
        rate_card_version: "v1",
        credit_micros: "0",
        credits: "0",
        provider_cost_micros: "0",
        reserved_seconds: "840",
        scope: "build_compute",
      },
      risks: ["Dev and Prod share data; database migrations affect both environments."],
      destructive_effects: [],
      required_confirmations: [],
      created_at: NOW,
      expires_at: EXPIRES_24_HOURS,
    };
    const surface = {
      ...createUnavailableProductSurfacePort(),
      planDeployment: async (input: { readonly environment?: string }) => {
        targets.push(input.environment);
        if (input.environment === "dev")
          throw new ProductSurfaceConflictError("development_environment_missing");
        return { status: 200 as const, body };
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const plan = (body: unknown) =>
      app.request(`https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`, {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const prod = await plan({ commit_sha: "a".repeat(40), environment: "prod" });
    expect(prod.status).toBe(200);
    expect(await prod.json()).toMatchObject({ environment: "prod", risks: body.risks });
    const omitted = await plan({ commit_sha: "a".repeat(40) });
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).toMatchObject({ environment: "prod" });
    const refused = await plan({ commit_sha: "a".repeat(40), environment: "dev" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "development_environment_missing",
      retryable: false,
    });
    expect(targets).toEqual(["prod", undefined, "dev"]);
    expect((await plan({ commit_sha: "a".repeat(40), environment: "staging" })).status).toBe(400);
    expect(targets).toHaveLength(3);
  });

  it("returns an agent-actionable conflict when storage.jurisdiction differs from the recorded storage jurisdiction", async () => {
    const surface = {
      ...createUnavailableProductSurfacePort(),
      planDeployment: async () => {
        throw new ProductSurfaceConflictError("storage_jurisdiction_conflict");
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: "https://docs.ohmyho.st/errors/storage-jurisdiction-conflict",
      title: "Storage jurisdiction conflict",
      code: "storage_jurisdiction_conflict",
      retryable: false,
      detail: "storage.jurisdiction must match the project's recorded storage jurisdiction.",
      suggested_action: expect.stringMatching(
        /Storage jurisdiction.*project context.*storage\.jurisdiction.*recorded value \(us or eu\).*keep their jurisdiction.*unavailable.*rather than guessing.*Do not delete or recreate/u,
      ),
    });
  });

  it("returns an agent-actionable conflict while framework conversion remains incomplete", async () => {
    let diagnostic: unknown;
    const surface = {
      ...createUnavailableProductSurfacePort(),
      planDeployment: async () => {
        throw new ProductSurfaceConflictError("framework_conversion_required", diagnostic);
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "framework_conversion_required",
      retryable: false,
      detail: "Complete the declared framework adapter contract before planning this deployment.",
      suggested_action: expect.stringMatching(
        /detail.*names the file.*save or push the corrected version.*ohmyhost init --dry-run --json.*pending.*unchanged source cannot fix/u,
      ),
    });
    const plan = () =>
      app.request(`https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`, {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      });
    // Version, lockfile and repository configuration refusals name their file and the fix, and the
    // CLI and local MCP use that same catalog sentence as the next action.
    for (const [typed, expected] of [
      [
        {
          code: "framework_version_unsupported",
          path: "apps/web/package.json",
          package: "next",
          version: "^16.3.6",
          minimum: "16.4.1",
        },
        '"apps/web/package.json" declares next ^16.3.6, which ohmyho.st does not admit; use next 16.4.1 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.',
      ],
      [
        {
          code: "framework_version_unsupported",
          path: "apps/web/pnpm-lock.yaml",
          package: "@tanstack/react-start",
          version: "1.168.59",
          minimum: "1.168.60",
        },
        '"apps/web/pnpm-lock.yaml" resolves @tanstack/react-start 1.168.59, which ohmyho.st does not admit; use @tanstack/react-start 1.168.60 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.',
      ],
      [
        { code: "repository_configuration_invalid", path: "ohmyhost.yaml" },
        '"ohmyhost.yaml" does not match the ohmyho.st configuration schema. Run ohmyhost init --dry-run --json locally to see the exact field and fix, commit and push the change, then plan the new commit.',
      ],
    ] as const) {
      diagnostic = typed;
      const refused = await plan();
      expect(refused.status).toBe(409);
      const problem = await refused.json();
      expect(problem).toMatchObject({ code: "framework_conversion_required", detail: expected });
      expect(parseSafeProblem(problem).suggestedAction).toBe(expected);
    }

    const detail =
      'Invalid JavaScript or TypeScript in "packages/site/app/(public)/page.tsx". Fix the file, commit and push the change, then plan the new commit.';
    diagnostic = { code: "source_syntax_invalid", path: "packages/site/app/(public)/page.tsx" };
    const fetchPublic: typeof globalThis.fetch = async (input, init) =>
      app.request(new Request(input, init));
    const api = new GeneratedSdkProductApi("https://api.test", "valid", fetchPublic);
    await expect(
      api.planDeployment({ projectId: PROJECT_ID, commitSha: "a".repeat(40), environment: "dev" }),
    ).rejects.toMatchObject({ code: "framework_conversion_required", detail });
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected login or mutation");
    };
    const cli = new ProductCli({
      apiToken: "valid",
      commandPrefix: "ohmyhost",
      credentialStore: () => ({ read: unused, replace: unused, clear: unused }),
      deviceFlow: {} as WorkosDeviceFlowClient,
      deviceAuthorizationPresenter: { present: unused },
      productApi: () => api,
      accountProfile: async () => await api.getAccountProfile(),
      projectLinkStore: { save: unused },
      productApiOrigin: "https://api.test",
      tokenRevoker: { revoke: unused },
      tokenRefresher: { refresh: unused },
      now: () => new Date(NOW),
      waitUntil: unused,
      lifecycleTimeoutMs: 1000,
      createCorrelationId: () => "syntax-diagnostic",
      diagnosticSink: { record: () => undefined },
      readSecretValue: unused,
    });
    const cliResult = await cli.run([
      "plan",
      "--project",
      PROJECT_ID,
      "--commit",
      "a".repeat(40),
      "--json",
    ]);
    expect(cliResult.exitCode).toBe(7);
    expect(JSON.parse(cliResult.stdout).error).toMatchObject({
      code: "framework_conversion_required",
      suggested_action: detail,
    });
    const mcp = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () =>
        new GeneratedSdkLocalMcpClient("https://api.test", "valid", fetchPublic),
    });
    try {
      const response = await mcp.fetch(
        new Request("https://mcp.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "deployment_plan",
              arguments: { project_id: PROJECT_ID, commit_sha: "a".repeat(40) },
            },
          }),
        }),
      );
      const text = await response.text();
      const message = JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6) ?? text,
      );
      expect(message.result.isError).toBe(true);
      expect(JSON.parse(message.result.content[0].text).error.suggested_action).toBe(detail);
    } finally {
      await mcp.close();
    }
    const publicProblem = {
      type: "https://docs.ohmyho.st/errors/framework-conversion-required",
      title: "Framework conversion required",
      status: 409,
      code: "framework_conversion_required",
      request_id: "syntax-test",
      retryable: false,
      suggested_action: "untrusted server instruction",
    };
    for (const invalid of [
      null,
      {},
      "untrusted raw parser output",
      detail.replace("packages/site/app/(public)/page.tsx", "../secret.ts"),
      detail + " extra-private-text",
    ]) {
      expect(
        parseSafeProblem({
          ...publicProblem,
          ...(invalid === null || typeof invalid === "object" ? {} : { detail: invalid }),
        }).suggestedAction,
      ).not.toContain("secret");
    }
    const version = {
      code: "framework_version_unsupported",
      path: "package.json",
      package: "next",
      version: "16.4.0",
      minimum: "16.4.1",
    };
    for (const value of [
      null,
      [],
      {},
      { code: "other", path: "app/page.tsx" },
      { code: "source_syntax_invalid", path: "app/page.tsx", extra: "secret" },
      { code: "source_syntax_invalid", path: "https://private.invalid/a.ts" },
      { ...version, path: "../package.json" },
      { ...version, path: "apps/web/package-lock.yml" },
      { ...version, path: "secret.ts" },
      { ...version, package: "react" },
      { ...version, version: "16.4.0 && curl https://private.invalid" },
      { ...version, version: "latest" },
      { ...version, minimum: "16.4.1-canary.1" },
      { ...version, token: "secret" },
      { code: "repository_configuration_invalid", path: "apps/web/ohmyhost.yaml" },
      { code: "repository_configuration_invalid", path: "ohmyhost.yaml", package: "next" },
    ]) {
      diagnostic = value;
      const redacted = await plan();
      const text = await redacted.text();
      expect(JSON.parse(text).detail).toBe(
        "Complete the declared framework adapter contract before planning this deployment.",
      );
      expect(text).not.toMatch(/secret|private|curl|canary/u);
    }

    // Control refusing to second-guess SourceFetcher is a platform fault: 503 with a distinct
    // internal report, never the customer's file, version or a conversion instruction.
    const report = vi.fn();
    const inconsistent = createControlApi(
      dependencies({
        reporter: { report },
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          planDeployment: async () => {
            throw new SourceAdmissionPolicyInconsistentError();
          },
        },
      }),
    );
    const unavailable = await inconsistent.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );
    expect(unavailable.status).toBe(503);
    const outage = await unavailable.json();
    expect(outage).toMatchObject({
      code: "service_unavailable",
      retryable: true,
      detail: "The requested product operation is temporarily unavailable.",
    });
    expect(report).toHaveBeenCalledExactlyOnceWith({
      requestId: outage.request_id,
      code: "SOURCE_ADMISSION_POLICY_INCONSISTENT",
      route: "/v1/projects/{project_id}/deployments",
    });
  });

  it.each([
    {
      code: "native_domain_sync_pending" as const,
      detail:
        "A previous domain change still needs its Native Auth policy acknowledgement. For a pending custom-domain removal, retry that removal as a current owner. For a pending project-address change, submit a fresh address change as a current owner. Then create a new deletion plan.",
      action:
        /Paid domain removal.*new idempotency key.*project address change.*current owner.*deletion plan/u,
    },
    {
      code: "migration_filename_noncanonical" as const,
      detail:
        "Rename every PostgreSQL migration to YYYYMMDDHHMMSS_name.sql before planning this deployment.",
      action:
        /database\.migrations.*YYYYMMDDHHMMSS_name\.sql.*README\.md.*Save or push the corrected version.*Never rename a migration a deployment already applied/u,
    },
    {
      code: "repository_configuration_missing" as const,
      detail: "The Git repository root must contain ohmyhost.yaml.",
      action:
        /ohmyhost\.yaml at the Git repository root.*ohmyhost init --json.*applicationRoot.*Save or push the corrected version.*plan its commit/u,
    },
  ])("returns an actionable nonretryable conflict for $code", async ({ code, detail, action }) => {
    const surface = {
      ...createUnavailableProductSurfacePort(),
      planDeployment: async () => {
        throw new ProductSurfaceConflictError(code);
      },
    };
    const app = createControlApi(dependencies({ productSurface: surface }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );
    expect(response.status).toBe(409);
    const problem = await response.json();
    expect(problem).toMatchObject({
      code,
      retryable: false,
      detail,
      suggested_action: expect.stringMatching(action),
      request_id: response.headers.get("x-request-id"),
    });
    expect(parseSafeProblem(problem)).toMatchObject({
      code,
      retryable: false,
      suggestedAction: expect.stringMatching(action),
      requestId: response.headers.get("x-request-id"),
    });
  });

  it("passes an explicitly requested source binding through the use-case port", async () => {
    const getSource = vi.fn(async () => ({
      status: 200 as const,
      body: {
        provider: "github",
        source_connection_id: SOURCE_CONNECTION_ID,
        source_generation: 1,
        installation_id: "42",
        repository_full_name: "owner/repo",
        status: "ready",
        linked_at: NOW,
        updated_at: NOW,
      },
    }));
    const app = createControlApi(
      dependencies({ productSurface: { ...createUnavailableProductSurfacePort(), getSource } }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/source?include_binding=true`,
      {
        headers: { Authorization: "Bearer valid" },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source_connection_id: SOURCE_CONNECTION_ID,
      source_generation: 1,
      repository_full_name: "owner/repo",
      status: "ready",
    });
    expect(getSource).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        principalId: "user:user_1",
      }),
    );
  });

  it("returns the persistent Dev link only to the owner and accepts explicit public mode", async () => {
    const shareUrl = `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"B".repeat(43)}`;
    const ensure = vi.fn(async () => ({ mode: "protected" as const, shareUrl }));
    const setMode = vi.fn(async (_context, mode: "protected" | "public") => ({
      mode,
      shareUrl: mode === "public" ? null : shareUrl,
    }));
    const management = {
      ensure,
      setMode,
      rotate: vi.fn(async () => ({ mode: "protected" as const, shareUrl })),
      revoke: vi.fn(async () => ({ mode: "protected" as const, shareUrl: null })),
    };
    const app = createControlApi(dependencies({ devAccessManagement: management }));
    const link = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/dev-share-link`, {
      method: "POST",
      headers: { Authorization: "Bearer valid" },
    });
    expect(link.status).toBe(200);
    expect(link.headers.get("cache-control")).toBe("no-store");
    expect(await link.json()).toEqual({
      project_id: PROJECT_ID,
      mode: "protected",
      share_url: shareUrl,
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, principalId: "user:user_1" }),
    );
    const publicMode = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-access-mode`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Idempotency-Key": "mode-public-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "public" }),
      },
    );
    expect(publicMode.status).toBe(200);
    expect(await publicMode.json()).toEqual({
      project_id: PROJECT_ID,
      mode: "public",
      share_url: null,
    });
    expect(setMode).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
      "public",
      "mode-public-1",
    );
    const rotated = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-share-link:rotate`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "rotate-1" },
      },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    expect(management.rotate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
      "rotate-1",
    );
    management.rotate.mockRejectedValueOnce(new DevShareRotationConflictError());
    const staleReplay = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-share-link:rotate`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "older-rotation" },
      },
    );
    expect(staleReplay.status).toBe(409);
    expect(await staleReplay.json()).toMatchObject({ code: "idempotency_key_reused" });
    const revoked = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/dev-share-link`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "revoke-1" },
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      project_id: PROJECT_ID,
      mode: "protected",
      share_url: null,
    });
    expect(management.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
      "revoke-1",
    );
    const memberEnsure = vi.fn();
    const member = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "projects:dev-access" ? "deny" : "allow"),
        },
        devAccessManagement: { ...management, ensure: memberEnsure },
      }),
    );
    const denied = await member.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-share-link`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid" },
      },
    );
    expect(denied.status).toBe(404);
    expect(memberEnsure).not.toHaveBeenCalled();
  });

  it("reads and switches the owner's powered-by flag, hides it from others and keeps a Free domain's flag", async () => {
    let state: { enabled: boolean; enabledAt: string | null } = { enabled: false, enabledAt: null };
    const set = vi.fn(async ({ enabled }: { enabled: boolean }) => {
      state = enabled ? { enabled, enabledAt: NOW } : { enabled, enabledAt: null };
      return state;
    });
    const port = { get: vi.fn(async () => state), set };
    const app = createControlApi(dependencies({ poweredByFlag: port }));
    const url = `https://api.test/v1/projects/${PROJECT_ID}/powered-by-flag`;
    const put = (target: typeof app, body: unknown) =>
      target.request(url, {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Idempotency-Key": "flag-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const read = await app.request(url, { headers: { Authorization: "Bearer valid" } });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ project_id: PROJECT_ID, enabled: false, enabled_at: null });
    const on = await put(app, { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ project_id: PROJECT_ID, enabled: true, enabled_at: NOW });
    // The key and the request digest reach the port, which answers a retry from its record.
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        principalId: "user:user_1",
        idempotencyKey: "flag-1",
        canonicalRequestDigest: expect.any(Uint8Array),
        enabled: true,
      }),
    );
    for (const invalid of [{ enabled: "yes" }, { enabled: true, extra: 1 }, {}])
      expect((await put(app, invalid)).status).toBe(400);
    set.mockRejectedValueOnce(new PoweredByFlagRequiredError());
    const kept = await put(app, { enabled: false });
    expect(kept.status).toBe(409);
    expect(await kept.json()).toMatchObject({ code: "powered_by_flag_required" });
    set.mockRejectedValueOnce(new PoweredByFlagIdempotencyConflictError());
    const reused = await put(app, { enabled: false });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });

    // Members may read but not switch; a foreign project is hidden before the port.
    const memberSet = vi.fn();
    const member = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "projects:write" ? "deny" : "allow"),
        },
        poweredByFlag: { ...port, set: memberSet },
      }),
    );
    expect((await put(member, { enabled: false })).status).toBe(404);
    expect(memberSet).not.toHaveBeenCalled();
    const baseline = dependencies({ poweredByFlag: { get: vi.fn(), set: memberSet } });
    const foreign = createControlApi({
      ...baseline,
      persistence: { ...baseline.persistence, getProject: async () => null },
    });
    expect(
      (await foreign.request(url, { headers: { Authorization: "Bearer valid" } })).status,
    ).toBe(404);
    expect((await put(foreign, { enabled: true })).status).toBe(404);
    expect(memberSet).not.toHaveBeenCalled();

    // The CLI and MCP reach the same routes through the generated SDK and exact parsers.
    const fetchPublic: typeof globalThis.fetch = async (input, init) =>
      app.request(new Request(input, init));
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected login");
    };
    const api = new GeneratedSdkProductApi("https://api.test", "valid", fetchPublic);
    const cli = new ProductCli({
      apiToken: "valid",
      commandPrefix: "ohmyhost",
      credentialStore: () => ({ read: unused, replace: unused, clear: unused }),
      deviceFlow: {} as WorkosDeviceFlowClient,
      deviceAuthorizationPresenter: { present: unused },
      productApi: () => api,
      accountProfile: async () => await api.getAccountProfile(),
      projectLinkStore: { save: unused },
      productApiOrigin: "https://api.test",
      tokenRevoker: { revoke: unused },
      tokenRefresher: { refresh: unused },
      now: () => new Date(NOW),
      waitUntil: unused,
      lifecycleTimeoutMs: 1000,
      createCorrelationId: () => "powered-by-flag",
      diagnosticSink: { record: () => undefined },
      readSecretValue: unused,
    });
    const hidden = await cli.run(
      "project flag set --project PROJECT --enabled false --idempotency-key flag-cli --json"
        .replace("PROJECT", PROJECT_ID)
        .split(" "),
    );
    expect(hidden.exitCode).toBe(0);
    expect(JSON.parse(hidden.stdout)).toMatchObject({
      command: "project flag set",
      flag: { project_id: PROJECT_ID, enabled: false, enabled_at: null },
    });
    set.mockRejectedValueOnce(new PoweredByFlagRequiredError());
    const refused = await cli.run(
      "project flag set --project PROJECT --enabled false --idempotency-key flag-cli-2 --json"
        .replace("PROJECT", PROJECT_ID)
        .split(" "),
    );
    expect(JSON.parse(refused.stdout).error).toMatchObject({ code: "powered_by_flag_required" });
    const status = await cli.run(["project", "flag", "status", "--project", PROJECT_ID, "--json"]);
    expect(JSON.parse(status.stdout).flag).toEqual({
      project_id: PROJECT_ID,
      enabled: false,
      enabled_at: null,
    });
    const mcp = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () =>
        new GeneratedSdkLocalMcpClient("https://api.test", "valid", fetchPublic),
    });
    try {
      for (const [name, args, enabled] of [
        [
          "powered_by_flag_set",
          { project_id: PROJECT_ID, enabled: true, idempotency_key: "m1" },
          true,
        ],
        ["powered_by_flag_get", { project_id: PROJECT_ID }, true],
      ] as const) {
        const response = await mcp.fetch(
          new Request("https://mcp.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          }),
        );
        const text = await response.text();
        const message = JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? text,
        );
        expect(message.result.isError).not.toBe(true);
        expect(JSON.parse(message.result.content[0].text)).toMatchObject({ enabled });
      }
    } finally {
      await mcp.close();
    }
  });

  it("shares the workspace referral link with every member and hides other workspaces", async () => {
    const url = `https://api.test/v1/organizations/${ORGANIZATION_ID}/referral`;
    const referralUrl = `https://ohmyho.st/?r=ref-${ORGANIZATION_ID.toLowerCase()}`;
    const member = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "projects:read" ? "allow" : "deny"),
        },
      }),
    );
    const read = await member.request(url, { headers: { Authorization: "Bearer valid" } });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      organization_id: ORGANIZATION_ID,
      referral_url: referralUrl,
    });
    const foreign = await member.request(`https://api.test/v1/organizations/${EVENT_ID}/referral`, {
      headers: { Authorization: "Bearer valid" },
    });
    expect(foreign.status).toBe(404);
    expect(
      (await member.request(`${url}?extra=1`, { headers: { Authorization: "Bearer valid" } }))
        .status,
    ).toBe(400);
    // An oversized correlation header is named as such, not as a query-parameter refusal.
    const oversized = await member.request(url, {
      headers: { Authorization: "Bearer valid", "X-Request-Id": "r".repeat(129) },
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      code: "invalid_request",
      detail: "X-Request-Id is invalid.",
    });
    const denied = createControlApi(dependencies({ authorization: { check: async () => "deny" } }));
    expect((await denied.request(url, { headers: { Authorization: "Bearer valid" } })).status).toBe(
      404,
    );

    // The CLI and MCP read it through the generated SDK and the exact parser.
    const fetchPublic: typeof globalThis.fetch = async (input, init) =>
      member.request(new Request(input, init));
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected login");
    };
    const api = new GeneratedSdkProductApi("https://api.test", "valid", fetchPublic);
    const cli = new ProductCli({
      apiToken: "valid",
      commandPrefix: "ohmyhost",
      credentialStore: () => ({ read: unused, replace: unused, clear: unused }),
      deviceFlow: {} as WorkosDeviceFlowClient,
      deviceAuthorizationPresenter: { present: unused },
      productApi: () => api,
      accountProfile: async () => await api.getAccountProfile(),
      projectLinkStore: { save: unused },
      productApiOrigin: "https://api.test",
      tokenRevoker: { revoke: unused },
      tokenRefresher: { refresh: unused },
      now: () => new Date(NOW),
      waitUntil: unused,
      lifecycleTimeoutMs: 1000,
      createCorrelationId: () => "referral-link",
      diagnosticSink: { record: () => undefined },
      readSecretValue: unused,
    });
    const link = await cli.run(["referral", "link", "--organization", ORGANIZATION_ID, "--json"]);
    expect(link.exitCode).toBe(0);
    expect(JSON.parse(link.stdout).referral).toEqual({
      organization_id: ORGANIZATION_ID,
      referral_url: referralUrl,
    });
    const mcp = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () =>
        new GeneratedSdkLocalMcpClient("https://api.test", "valid", fetchPublic),
    });
    try {
      const response = await mcp.fetch(
        new Request("https://mcp.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "referral_link_get", arguments: { organization_id: ORGANIZATION_ID } },
          }),
        }),
      );
      const text = await response.text();
      const message = JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6) ?? text,
      );
      expect(JSON.parse(message.result.content[0].text)).toEqual({
        organization_id: ORGANIZATION_ID,
        referral_url: referralUrl,
      });
    } finally {
      await mcp.close();
    }
  });

  it("issues a dev access ticket without an Idempotency-Key, and a repeated request with the same key is not replayed", async () => {
    const issue = vi.fn(async () => ({
      ticketId: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: EVENT_ID,
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      redeemUrl: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
      expiresAt: EXPIRES_10_MINUTES,
    }));
    const app = createControlApi(
      dependencies({
        authorization: { check: async () => "allow" as const },
        devAccessTickets: { issue },
      }),
    );
    const url = `https://api.test/v1/projects/${PROJECT_ID}/dev-access-tickets`;

    const withoutKey = await app.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer valid" },
    });
    expect(withoutKey.status).toBe(201);
    const repeated = await app.request(url, {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "dev-ticket-key-0001" },
    });
    expect(repeated.status).toBe(201);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("issues one owner-only no-store dev access ticket with the exact gateway URL contract", async () => {
    const issue = vi.fn(async () => ({
      ticketId: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: EVENT_ID,
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      redeemUrl: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
      expiresAt: EXPIRES_10_MINUTES,
    }));
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({ authorization: { check: authorization }, devAccessTickets: { issue } }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-access-tickets`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "dev-ticket-key-0001" },
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({
      ticket_id: DEPLOYMENT_ID,
      project_id: PROJECT_ID,
      environment_id: EVENT_ID,
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      redeem_url: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
      expires_at: EXPIRES_10_MINUTES,
    });
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:dev-access" }),
    );
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, principalId: "user:user_1" }),
    );
  });

  it("hides dev access issuance from a member before creating credential material", async () => {
    const issue = vi.fn();
    const app = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "projects:dev-access" ? "deny" : "allow"),
        },
        devAccessTickets: { issue },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-access-tickets`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "dev-ticket-key-0001" },
      },
    );
    expect(response.status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
  });

  it("hides cross-tenant dev access issuance before creating credential material", async () => {
    const issue = vi.fn();
    const baseline = dependencies({ devAccessTickets: { issue } });
    const app = createControlApi({
      ...baseline,
      persistence: { ...baseline.persistence, getProject: async () => null },
    });
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-access-tickets`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "dev-ticket-key-0001" },
      },
    );
    expect(response.status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
  });

  it("reports dev access failures under a fixed route without credential material", async () => {
    const report = vi.fn();
    const app = createControlApi(
      dependencies({
        devAccessTickets: {
          issue: async () => {
            throw new Error(`ticket-${"A".repeat(43)}`);
          },
        },
        reporter: { report },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/dev-access-tickets`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "dev-ticket-key-0001" },
      },
    );
    expect(response.status).toBe(503);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/v1/projects/{project_id}/dev-access-tickets" }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("ticket-");
  });

  it("requires a strong ETag on deployment status responses", async () => {
    const body = {
      id: DEPLOYMENT_ID,
      project_id: PROJECT_ID,
      operation_id: OPERATION_ID,
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"c".repeat(64)}`,
      build_plan_digest: `sha256:${"d".repeat(64)}`,
      artifact_digest: `sha256:${"b".repeat(64)}`,
      status: "active",
      url: "https://dev-calm-panda-builds.dev.check.omh.st",
      created_at: NOW,
      updated_at: NOW,
    };
    const missingEtag = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getDeployment: async () => ({ status: 200, body }),
        },
      }),
    );
    const invalid = await missingEtag.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(invalid.status).toBe(503);

    const validEtag = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const validApp = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getDeployment: async () => ({ status: 200, body, etag: validEtag }),
        },
      }),
    );
    const valid = await validApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get("etag")).toBe(validEtag);
  });

  it("rejects deployment cursors that were not emitted by the ULID-backed projection", async () => {
    const listDeployments = vi.fn();
    const app = createControlApi(
      dependencies({
        productSurface: { ...createUnavailableProductSurfacePort(), listDeployments },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments?cursor=opaque_but_not_emitted`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(400);
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("returns reconciliation-required as an honest deployment status", async () => {
    const body = {
      id: DEPLOYMENT_ID,
      project_id: PROJECT_ID,
      operation_id: OPERATION_ID,
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"c".repeat(64)}`,
      build_plan_digest: `sha256:${"d".repeat(64)}`,
      status: "reconciliation_required",
      created_at: NOW,
      updated_at: NOW,
    };
    const app = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getDeployment: async () => ({ status: 200, body, etag: STRONG_ETAG }),
        },
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`,
      { headers: { Authorization: "Bearer valid" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "reconciliation_required" });
  });

  it("returns the exact read-only application root in deployment plan evidence", async () => {
    const body = {
      id: DEPLOYMENT_ID,
      project_id: PROJECT_ID,
      environment: "dev",
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"b".repeat(64)}`,
      build_plan_digest: `sha256:${"c".repeat(64)}`,
      application_root: "site",
      runtime: "cloudflare_workers_edge_ssr",
      route: "https://dev-calm-panda-builds.dev.check.omh.st",
      resource_effects: [],
      limits: [],
      estimated_cost: {
        amount_micros: "0",
        currency: "USD",
        rate_card_version: "v1",
        credit_micros: "0",
        credits: "0",
        provider_cost_micros: "0",
        reserved_seconds: "840",
        scope: "build_compute",
      },
      risks: [],
      destructive_effects: [],
      required_confirmations: [],
      created_at: NOW,
      expires_at: EXPIRES_24_HOURS,
    };
    const app = createControlApi(
      dependencies({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          planDeployment: async () => ({ status: 200, body }),
        },
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/deployments:plan`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: "a".repeat(40) }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  it.each(productResponseBoundaryCases())(
    "rejects malformed $name port results without exposing a partial body",
    async (testCase) => {
      const { method, path, methodName, result } = testCase;
      const headers = "headers" in testCase ? testCase.headers : undefined;
      const body = "body" in testCase ? testCase.body : undefined;
      const productSurface = {
        ...createUnavailableProductSurfacePort(),
        [methodName]: async () => result,
      };
      const app = createControlApi(dependencies({ productSurface }));
      const response = await app.request(`https://api.test${path}`, {
        method,
        headers: {
          Authorization: "Bearer valid",
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      expect(response.status, await response.clone().text()).toBe(503);
      const responseBody = await response.json();
      expect(responseBody).toMatchObject({ code: "service_unavailable", retryable: true });
      expect(JSON.stringify(responseBody)).not.toContain("port-secret");
    },
  );
  it("plans a deletion only at the exact project action, so another segment or a plain POST reaches no planner", async () => {
    const planDelete = vi.fn(async () => null);
    const app = createControlApi(
      dependencies({ productSurface: { ...createUnavailableProductSurfacePort(), planDelete } }),
    );
    for (const path of [`/v1/projects/${PROJECT_ID}`, `/v1/projects/${PROJECT_ID}:foo`]) {
      const response = await app.request(`https://api.test${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "plan-deletion" },
      });
      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ code: "resource_not_found" });
    }
    expect(planDelete).not.toHaveBeenCalled();
    // The exact colon route still reaches the planner once, so the guard refuses only the other paths.
    await app.request(`https://api.test/v1/projects/${PROJECT_ID}:delete-plan`, {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "plan-deletion" },
    });
    expect(planDelete).toHaveBeenCalledTimes(1);
  });
});

function productResponseBoundaryCases() {
  const operation = {
    status: 202 as const,
    body: {
      id: OPERATION_ID,
      state: "queued",
      created_at: NOW,
      updated_at: NOW,
      leaked: "port-secret",
    },
    location: `/v1/operations/${OPERATION_ID}`,
  };
  const deployment = {
    id: DEPLOYMENT_ID,
    project_id: PROJECT_ID,
    operation_id: OPERATION_ID,
    commit_sha: "a".repeat(40),
    source_digest: `sha256:${"b".repeat(64)}`,
    build_plan_digest: `sha256:${"c".repeat(64)}`,
    artifact_digest: `sha256:${"d".repeat(64)}`,
    status: "active",
    url: "https://dev-calm-panda-builds.dev.check.omh.st",
    created_at: NOW,
    updated_at: NOW,
  };
  const destructivePlan = {
    project_id: PROJECT_ID,
    resource_etag: STRONG_ETAG,
    effects: ["Effect"],
    risks: ["Risk"],
    confirmation_token: "x".repeat(32),
    created_at: NOW,
    expires_at: EXPIRES_10_MINUTES,
  };
  const deploymentPlan = {
    id: DEPLOYMENT_ID,
    project_id: PROJECT_ID,
    environment: "dev",
    commit_sha: "a".repeat(40),
    source_digest: `sha256:${"b".repeat(64)}`,
    build_plan_digest: `sha256:${"c".repeat(64)}`,
    application_root: "site",
    runtime: "cloudflare_workers_static_assets",
    route: "https://dev-calm-panda-builds.dev.check.omh.st",
    resource_effects: ["Effect"],
    limits: ["Limit"],
    estimated_cost: {
      amount_micros: "1",
      currency: "USD",
      rate_card_version: "sandbox-v1",
      credit_micros: "100",
      credits: "0.0001",
      provider_cost_micros: "1",
      reserved_seconds: "840",
      scope: "build_compute",
    },
    risks: ["Risk"],
    destructive_effects: [],
    required_confirmations: [],
    created_at: NOW,
    expires_at: EXPIRES_24_HOURS,
  };
  return [
    {
      name: "source read",
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/source`,
      methodName: "getSource",
      result: {
        status: 200,
        body: {
          provider: "github",
          source_connection_id: SOURCE_CONNECTION_ID,
          source_generation: 1,
          installation_id: "42",
          repository_full_name: "owner/repo",
          status: "ready",
          linked_at: NOW,
          updated_at: NOW,
          leaked: "port-secret",
        },
      },
    },
    {
      name: "deployment plan",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments:plan`,
      body: { commit_sha: "a".repeat(40) },
      methodName: "planDeployment",
      result: {
        status: 200,
        body: { ...deploymentPlan, leaked: "port-secret" },
      },
    },
    {
      name: "deployment create",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments`,
      headers: { "Idempotency-Key": "deploy-boundary" },
      body: { plan_id: DEPLOYMENT_ID },
      methodName: "createDeployment",
      result: operation,
    },
    {
      name: "deployment list",
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/deployments`,
      methodName: "listDeployments",
      result: { status: 200, body: { items: [deployment], leaked: "port-secret" } },
    },
    {
      name: "deployment get",
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`,
      methodName: "getDeployment",
      result: {
        status: 200,
        body: { ...deployment, leaked: "port-secret" },
        etag: STRONG_ETAG,
      },
    },
    {
      name: "rollback plan",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback-plan`,
      methodName: "planRollback",
      result: {
        status: 200,
        body: {
          ...destructivePlan,
          action: "rollback",
          target_deployment_id: DEPLOYMENT_ID,
          target_artifact_digest: `sha256:${"d".repeat(64)}`,
          leaked: "port-secret",
        },
      },
    },
    {
      name: "rollback",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback`,
      headers: {
        "Idempotency-Key": "rollback-boundary",
        "If-Match": '"7"',
        "X-Confirmation-Token": "x".repeat(32),
      },
      methodName: "rollback",
      result: operation,
    },
    {
      name: "promotion plan",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote-plan`,
      methodName: "planPromotion",
      result: {
        status: 200,
        body: {
          ...destructivePlan,
          action: "promote",
          source_deployment_id: DEPLOYMENT_ID,
          source_artifact_digest: `sha256:${"d".repeat(64)}`,
          source_environment: "dev",
          target_environment: "prod",
          leaked: "port-secret",
        },
      },
    },
    {
      name: "promotion",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote`,
      headers: {
        "Idempotency-Key": "promotion-boundary",
        "If-Match": STRONG_ETAG,
        "X-Confirmation-Token": "x".repeat(32),
      },
      methodName: "promote",
      result: operation,
    },
    {
      name: "delete plan",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}:delete-plan`,
      methodName: "planDelete",
      result: {
        status: 200,
        body: { ...destructivePlan, action: "delete", leaked: "port-secret" },
      },
    },
    {
      name: "delete",
      method: "DELETE",
      path: `/v1/projects/${PROJECT_ID}`,
      headers: {
        "Idempotency-Key": "delete-boundary",
        "If-Match": '"7"',
        "X-Confirmation-Token": "x".repeat(32),
      },
      methodName: "deleteProject",
      result: operation,
    },
    ...[
      ["invalid ULID", { ...deploymentPlan, id: "not-an-ulid" }],
      ["invalid timestamp", { ...deploymentPlan, created_at: "yesterday" }],
      ["invalid digest", { ...deploymentPlan, source_digest: "sha256:short" }],
      ["invalid application root", { ...deploymentPlan, application_root: "../site" }],
      ["invalid URL", { ...deploymentPlan, route: "http://unsafe.example" }],
      ["invalid TTL", { ...deploymentPlan, expires_at: EXPIRES_10_MINUTES }],
    ].map(([name, invalidBody]) => ({
      name: `deployment plan ${String(name)}`,
      method: "POST" as const,
      path: `/v1/projects/${PROJECT_ID}/deployments:plan`,
      body: { commit_sha: "a".repeat(40) },
      methodName: "planDeployment" as const,
      result: { status: 200 as const, body: invalidBody as Readonly<Record<string, unknown>> },
    })),
    {
      name: "deployment invalid status enum",
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`,
      methodName: "getDeployment",
      result: { status: 200, body: { ...deployment, status: "unknown" }, etag: STRONG_ETAG },
    },
    {
      name: "deployment page invalid cursor",
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/deployments`,
      methodName: "listDeployments",
      result: { status: 200, body: { items: [deployment], next_cursor: "bad cursor" } },
    },
    {
      name: "rollback plan missing target digest",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:rollback-plan`,
      methodName: "planRollback",
      result: {
        status: 200,
        body: { ...destructivePlan, action: "rollback", target_deployment_id: DEPLOYMENT_ID },
      },
    },
    {
      name: "promotion plan with invalid target environment",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}:promote-plan`,
      methodName: "planPromotion",
      result: {
        status: 200,
        body: {
          ...destructivePlan,
          action: "promote",
          source_deployment_id: DEPLOYMENT_ID,
          source_artifact_digest: `sha256:${"d".repeat(64)}`,
          source_environment: "dev",
          target_environment: "stage",
        },
      },
    },
    {
      name: "delete plan with rollback fields",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}:delete-plan`,
      methodName: "planDelete",
      result: {
        status: 200,
        body: { ...destructivePlan, action: "delete", target_deployment_id: DEPLOYMENT_ID },
      },
    },
  ] as const;
}

function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  const operation: Operation = {
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    state: "queued",
    createdAt: NOW,
    updatedAt: NOW,
    events: [
      {
        eventId: EVENT_ID,
        type: "OperationQueued",
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        occurredAt: NOW,
      },
    ],
  };
  return {
    authentication: {
      authenticate: async () => ({
        actorId: "user:user_1",
        credentialId: "workos_session:session_1",
        authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
        organizationIds: [ORGANIZATION_ID],
      }),
    },
    authorization: { check: async () => "allow" },
    persistence: {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      listProjects: async () => ({ projects: [], nextCursor: null }),
      takenProjectHandles: async () => new Set<string>(),
      createProject: async () => ({
        status: 202,
        location: `/v1/operations/${OPERATION_ID}`,
        body: {
          id: OPERATION_ID,
          state: "queued",
          created_at: NOW,
          updated_at: NOW,
          project_id: PROJECT_ID,
        },
      }),
      getProject: async (organizationId, projectId) => ({
        dataMode: "shared" as const,
        region: "us" as const,
        projectId,
        organizationId,
        name: "fixture",
        handle: "calm-otter-waves",
        createdAt: NOW,
      }),
      getOperation: async () => operation,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    devAccessTickets: overrides.devAccessTickets ?? {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    ...overrides,
  };
}
