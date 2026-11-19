import { createHash } from "node:crypto";

import { parseUlid, type Operation } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";
import { GeneratedSdkLocalMcpClient } from "../../mcp/src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../../mcp/src/local-server.js";
import { parseSafeProblem, parseOperation } from "../../product-cli/src/runtime-contract.js";
import { renderProjectContext } from "../src/project-context.js";

import {
  createControlApi,
  createProviderReconciliationPort,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
} from "../src/index.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const OPERATION_ID = parseUlid("00000000000000000000000003");
const EVENT_ID = parseUlid("00000000000000000000000004");
const ATTEMPT_ID = parseUlid("00000000000000000000000005");
const NOW = "2026-08-21T12:00:00.000Z";
const AUTHORIZATION_HEADER = ["Bearer", "test"].join(" ");

describe("Control API provider reconciliation", () => {
  it("reports deployment mail waiting through API and MCP without changing operation history", async () => {
    const base = dependencies();
    const queued = await base.persistence.getOperation(ORGANIZATION_ID, OPERATION_ID);
    if (!queued) throw new Error("Missing operation fixture");
    const running = {
      ...queued,
      state: "running" as const,
      events: [
        ...queued.events,
        {
          type: "OperationStarted" as const,
          idempotencyKey: "progress-start",
          eventId: ATTEMPT_ID,
          operationId: OPERATION_ID,
          projectId: PROJECT_ID,
          occurredAt: NOW,
        },
      ],
      deploymentObservation: {
        buildCompletedAt: NOW,
        deploymentId: EVENT_ID,
        projectId: PROJECT_ID,
        phase: "publishing" as const,
        mailRequired: true,
      },
    };
    let mailReady = false;
    let invalidMail = false;
    let allowed = true;
    const app = createControlApi(
      dependencies({
        persistence: {
          ...base.persistence,
          getOperation: async (organization, id) =>
            organization === ORGANIZATION_ID && id === OPERATION_ID ? running : null,
        },
        authorization: { check: async () => (allowed ? "allow" : "deny") },
        projectMailDomains: {
          configure: base.projectMailDomains.configure,
          get: async (scope) => {
            expect(scope.organizationId).toBe(ORGANIZATION_ID);
            expect(scope.projectId).toBe(PROJECT_ID);
            return {
              domain: invalidMail ? "https://invalid.example.com" : "mail.example.com",
              status: mailReady ? "ready" : "verification_pending",
              configuredAt: NOW,
              observedAt: NOW,
              verificationIssue: null,
              sending: "pending" as const,
              nextCheckAfterSeconds: 60 as const,
              dnsRecords: [
                {
                  type: "TXT" as const,
                  name: "send.mail.example.com",
                  value: "v=spf1",
                  status: "pending",
                },
              ],
            };
          },
        },
      }),
    );
    const fetch: typeof globalThis.fetch = async (input, init) =>
      app.request(new Request(input, init));
    const mcp = new GeneratedSdkLocalMcpClient("https://api.test", "test", fetch);
    const pending = await mcp.getOperation(OPERATION_ID);
    expect(pending).toMatchObject({
      state: "running",
      created_at: NOW,
      updated_at: NOW,
      progress: {
        phase: "waiting_for_mail",
        build_completed_at: NOW,
        project_id: PROJECT_ID,
        deployment_id: EVENT_ID,
        suggested_action: expect.stringContaining("DNS records shown here"),
        mail: {
          domain: "mail.example.com",
          sending: "pending",
          next_check_after_seconds: 60,
          dns_records: [
            { type: "TXT", name: "send.mail.example.com", value: "v=spf1", status: "pending" },
          ],
        },
        next_poll_after_seconds: 60,
      },
    });
    for (const progress of [
      { ...pending.progress, phase: "made_up" },
      { ...pending.progress, suggested_action: "Visit secret.internal" },
      { ...pending.progress, next_poll_after_seconds: 0 },
    ])
      expect(() => parseOperation({ ...pending, progress })).toThrow();
    expect(() => parseOperation({ ...pending, state: "succeeded" })).toThrow();
    invalidMail = true;
    const malformed = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: AUTHORIZATION_HEADER },
    });
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toMatchObject({
      progress: { phase: "mail_status_unavailable" },
    });
    invalidMail = false;
    mailReady = true;
    expect(await mcp.getOperation(OPERATION_ID)).toMatchObject({
      progress: { phase: "publishing" },
    });
    allowed = false;
    const denied = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: AUTHORIZATION_HEADER },
    });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("mail.example.com");
  });

  it("returns current recovery guidance through operation reads, project status and MCP without changing history", async () => {
    const base = dependencies();
    const operation = await base.persistence.getOperation(ORGANIZATION_ID, OPERATION_ID);
    if (!operation) throw new Error("Missing operation fixture");
    let observation:
      | { state: "required" | "pending"; attempt_id: string | null; observed_at: string }
      | undefined = {
      state: "required",
      attempt_id: null,
      observed_at: NOW,
    };
    let allowed = true;
    let latest: Record<string, unknown> | null = null;
    let environments = [
      { id: EVENT_ID, name: "dev" },
      { id: ATTEMPT_ID, name: "prod" },
    ];
    const status = () => ({
      project_id: PROJECT_ID,
      etag: `"sha256-${"a".repeat(64)}"`,
      handle: "calm-otter-waves",
      region: "us",
      dev_access_mode: "protected",
      lifecycle: "active",
      source: null,
      default_environment: null,
      environments,
      head_deployment: null,
      dev_url: null,
      prod_url: null,
      latest_operation: latest,
      cleanup_state: "not_started",
    });
    const app = createControlApi(
      dependencies({
        authorization: { check: async () => (allowed ? "allow" : "deny") },
        persistence: {
          ...base.persistence,
          getOperation: async (organization, id) =>
            organization === ORGANIZATION_ID && id === OPERATION_ID
              ? {
                  ...operation,
                  ...(observation === undefined ? {} : { reconciliation: observation }),
                }
              : null,
        },
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getProjectStatus: async () => ({ status: 200, body: status() }),
        },
      }),
    );
    const fetch: typeof globalThis.fetch = async (input, init) =>
      app.request(new Request(input, init));
    const mcp = new GeneratedSdkLocalMcpClient("https://api.test", "test", fetch);
    const required = await mcp.getOperation(OPERATION_ID);
    expect(required).toMatchObject({
      id: OPERATION_ID,
      state: "queued",
      created_at: NOW,
      updated_at: NOW,
      reconciliation: {
        state: "required",
        attempt_id: null,
        observed_at: NOW,
        suggested_action: expect.stringContaining("Do not submit another deployment"),
      },
    });
    expect(required).not.toHaveProperty("error");
    latest = { ...required };
    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/status`, {
      headers: { Authorization: AUTHORIZATION_HEADER },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).latest_operation).toEqual(required);
    expect((await mcp.getProjectStatus(PROJECT_ID)).environments).toEqual(environments);
    const project = await base.persistence.getProject(ORGANIZATION_ID, PROJECT_ID);
    if (!project) throw new Error("Missing project fixture");
    const context = renderProjectContext({
      project,
      generatedAt: NOW,
      status: status(),
      notes: { version: 0, markdown: "", updatedAt: null },
      mail: null,
      domain: "unavailable",
      creditAccess: "not_authorized",
    });
    expect(context.markdown).toContain("Reconciliation: required");
    expect(context.markdown).toContain("Do not submit another deployment");
    expect(context.markdown).toContain(`Environment prod: ${ATTEMPT_ID}`);
    const validEnvironments = environments;
    environments = [
      { id: EVENT_ID, name: "dev" },
      { id: EVENT_ID, name: "prod" },
    ];
    expect(
      (
        await app.request(`https://api.test/v1/projects/${PROJECT_ID}/status`, {
          headers: { Authorization: AUTHORIZATION_HEADER },
        })
      ).status,
    ).toBe(503);
    environments = validEnvironments;
    observation = { state: "pending", attempt_id: ATTEMPT_ID, observed_at: NOW };
    expect(await mcp.getOperation(OPERATION_ID)).toMatchObject({
      reconciliation: {
        state: "pending",
        attempt_id: ATTEMPT_ID,
        suggested_action: expect.stringContaining("after 60 seconds"),
      },
    });
    observation = undefined;
    expect(await mcp.getOperation(OPERATION_ID)).not.toHaveProperty("reconciliation");
    expect(
      (
        await app.request(`https://api.test/v1/operations/${EVENT_ID}`, {
          headers: { Authorization: AUTHORIZATION_HEADER },
        })
      ).status,
    ).toBe(404);
    allowed = false;
    const denied = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: AUTHORIZATION_HEADER },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).not.toHaveProperty("reconciliation");
  });

  it("answers an operation with no pending recovery as a non-retryable 409, not a retryable outage", async () => {
    const reconcile = vi.fn(async () => ({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "unmatched" as const,
    }));
    const app = createControlApi(
      dependencies({ providerReconciliation: createProviderReconciliationPort({ reconcile }) }),
    );

    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}:reconcile`, {
      method: "POST",
      headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "unmatched-recovery" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "reconciliation_not_pending",
      retryable: false,
    });
  });

  it("fails closed when the private reconciliation capability is unavailable", async () => {
    await expect(
      createUnavailableProviderReconciliationPort().reconcile(reconciliationInput()),
    ).rejects.toThrow("Provider reconciliation is unavailable");
  });

  it("authorizes an owner and starts one provider-neutral idempotent attempt", async () => {
    const reconcile = vi.fn(async () => ({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "pending" as const,
    }));
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        providerReconciliation: { reconcile },
      }),
    );

    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}:reconcile`, {
      method: "POST",
      headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "reconcile-attempt-1" },
    });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(response.headers.get("location")).toBe(`/v1/operations/${OPERATION_ID}`);
    expect(await response.json()).toEqual({
      reconciliation_id: ATTEMPT_ID,
      operation_id: OPERATION_ID,
      state: "pending",
    });
    expect(reconcile).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      operationId: OPERATION_ID,
      principalId: "user:user_1",
      idempotencySha256: expectedDigest("reconcile-attempt-1"),
    });
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "operations:reconcile" }),
    );
  });

  it("hides an owner-only attempt from members and rejects mutation ambiguity", async () => {
    const reconcile = vi.fn();
    const member = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "operations:read" ? "allow" : "deny"),
        },
        providerReconciliation: { reconcile },
      }),
    );
    const denied = await member.request(
      `https://api.test/v1/operations/${OPERATION_ID}:reconcile`,
      {
        method: "POST",
        headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "member-attempt" },
      },
    );
    const owner = createControlApi(dependencies({ providerReconciliation: { reconcile } }));
    const missingKey = await owner.request(
      `https://api.test/v1/operations/${OPERATION_ID}:reconcile`,
      { method: "POST", headers: { Authorization: AUTHORIZATION_HEADER } },
    );
    const unexpectedBody = await owner.request(
      `https://api.test/v1/operations/${OPERATION_ID}:reconcile`,
      {
        method: "POST",
        headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "body-attempt" },
        body: "{}",
      },
    );
    const unexpectedQuery = await owner.request(
      `https://api.test/v1/operations/${OPERATION_ID}:reconcile?provider=cloudflare`,
      {
        method: "POST",
        headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "query-attempt" },
      },
    );

    expect(denied.status).toBe(404);
    expect(missingKey.status).toBe(400);
    expect(unexpectedBody.status).toBe(400);
    expect(unexpectedQuery.status).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("validates and redacts the private Service Binding boundary", async () => {
    const secret = "provider-secret-canary";
    const binding = { reconcile: vi.fn() };
    const port = createProviderReconciliationPort(binding);
    binding.reconcile.mockResolvedValueOnce({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "completed",
    });
    await expect(port.reconcile(reconciliationInput())).resolves.toEqual({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "completed",
    });
    expect(binding.reconcile).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      operationId: OPERATION_ID,
      actorId: "user:user_1",
      idempotencySha256: expectedDigest("reconcile-attempt-1"),
    });

    binding.reconcile.mockResolvedValueOnce({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "pending",
      providerTag: secret,
    });
    await expect(port.reconcile(reconciliationInput())).rejects.toThrow(
      "Provider reconciliation is unavailable",
    );
    binding.reconcile.mockRejectedValueOnce(new Error(secret));
    await expect(port.reconcile(reconciliationInput())).rejects.not.toThrow(secret);

    binding.reconcile.mockResolvedValue({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "exhausted",
    });
    const app = createControlApi(dependencies({ providerReconciliation: port }));
    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}:reconcile`, {
      method: "POST",
      headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "exhausted-recovery" },
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "reconciliation_exhausted", retryable: false });
    const policy = parseSafeProblem(body);
    expect(policy.suggestedAction).toContain("Stop retries");
    expect(policy.suggestedAction).toContain("feedback");
    const client = new GeneratedSdkLocalMcpClient("https://api.test", "test", async (input, init) =>
      app.request(new Request(input, init)),
    );
    const handler = createLocalOhmyhostMcpHandler({ authenticatedClient: async () => client });
    const mcpResponse = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "operation_reconcile",
            arguments: {
              operation_id: OPERATION_ID,
              idempotency_key: "exhausted-recovery",
              confirmed: true,
            },
          },
        }),
      }),
    );
    const text = await mcpResponse.text();
    const serialized = mcpResponse.headers.get("content-type")?.startsWith("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
      : text;
    if (!serialized) throw new Error("Expected MCP error response");
    const mcp = JSON.parse(serialized);
    expect(mcp.result.isError).toBe(true);
    expect(JSON.parse(mcp.result.content[0].text).error).toMatchObject({
      code: "reconciliation_exhausted",
      retryable: false,
      suggested_action: policy.suggestedAction,
    });
    binding.reconcile.mockResolvedValueOnce({
      attemptId: ATTEMPT_ID,
      operationId: EVENT_ID,
      state: "exhausted",
    });
    await expect(port.reconcile(reconciliationInput())).rejects.toThrow(
      "Provider reconciliation is unavailable",
    );
  });
  it("answers a plain POST to the operation as not found and starts no provider reconciliation", async () => {
    const reconcile = vi.fn(async () => ({
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      state: "pending" as const,
    }));
    const app = createControlApi(dependencies({ providerReconciliation: { reconcile } }));

    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      method: "POST",
      headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "plain-operation-post" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "resource_not_found" });
    expect(reconcile).not.toHaveBeenCalled();
    // The exact colon route still starts its attempt, so the guard refuses only the plain path.
    const exact = await app.request(`https://api.test/v1/operations/${OPERATION_ID}:reconcile`, {
      method: "POST",
      headers: { Authorization: AUTHORIZATION_HEADER, "Idempotency-Key": "plain-operation-post" },
    });
    expect(exact.status).toBe(202);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

function reconciliationInput() {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    operationId: OPERATION_ID,
    principalId: "user:user_1",
    idempotencySha256: expectedDigest("reconcile-attempt-1"),
  } as const;
}

function expectedDigest(idempotencyKey: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      `v1\nPOST\n/v1/operations/{operation_id}:reconcile\n${ORGANIZATION_ID}\nuser:user_1\n${idempotencyKey}`,
    )
    .digest("hex")}`;
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
      createProject: async () => {
        throw new Error("unused");
      },
      getProject: async (organizationId, projectId) => ({
        dataMode: "shared" as const,
        region: "us" as const,
        organizationId,
        projectId,
        name: "fixture",
        handle: "calm-otter-waves",
        createdAt: NOW,
      }),
      getOperation: async () => operation,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: {
      reconcile: async () => {
        throw new Error("unavailable");
      },
    },
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
    requestId: () => "req_reconciliation",
    ...overrides,
  };
}
