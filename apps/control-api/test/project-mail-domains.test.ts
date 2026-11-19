import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createControlApi,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
  type ProjectMailDomainsPort,
} from "../src/index.js";
import { createManagedMailPort, ManagedMailPortError } from "../src/managed-mail.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const EVENT_ID = parseUlid("00000000000000000000000003");
const NOW = "2026-08-22T10:00:00.000Z";
describe("Control API project mail domains", () => {
  it("keeps the unavailable adapter fail-closed", async () => {
    await expect(createUnavailableProjectMailDomainsPort().get({} as never)).rejects.toThrow(
      "unavailable",
    );
  });

  it("refuses a mail domain that does not send before the managed mail port, since configuration needs sending", async () => {
    const configureMailDomain = vi.fn(async () => ({ status: "pending" }));
    const app = createControlApi(dependencies({ managedMail: { configureMailDomain } as never }));
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/00000000000000000000000004/mail-domain`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "receive-only",
        },
        body: JSON.stringify({ domain: "mail.example.com", sending: false, receiving: false }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request", retryable: false });
    expect(configureMailDomain).not.toHaveBeenCalled();
  });

  it("answers an environment mail key the mail runtime cannot store as a 400, not a retryable 503", async () => {
    // The mail runtime refuses a key outside A-Za-z0-9._:- with this message; a retry with the same key cannot succeed.
    const refused = async () => {
      throw new TypeError("Invalid mail idempotency key");
    };
    const app = createControlApi(
      dependencies({
        managedMail: createManagedMailPort(
          {
            configureMailDomain: refused,
            readMailDomain: refused,
            prepareMailWebhook: refused,
            verifyMailWebhook: refused,
            rotateMailWebhook: refused,
            disableMailReceiving: refused,
            deleteMailDomain: refused,
          },
          {
            listMailMessages: refused,
            getMailMessage: refused,
            getMailAttachment: refused,
            retryMailMessage: refused,
          },
        ),
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/00000000000000000000000004/mail-domain`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "a/b",
        },
        body: JSON.stringify({ domain: "mail.example.com", sending: true, receiving: false }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_request",
      retryable: false,
      detail: expect.stringContaining("Idempotency-Key"),
    });
  });

  it("answers an attachment over the download limit as a 413 payload_too_large problem", async () => {
    const app = createControlApi(
      dependencies({
        managedMail: {
          getMailAttachment: async () => {
            throw new ManagedMailPortError(
              413,
              "payload_too_large",
              "This mail attachment exceeds the 50 MiB download limit.",
            );
          },
        } as never,
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/00000000000000000000000004/mail/messages/00000000000000000000000005/attachments/file-1`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large", retryable: false });
  });
});

function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  const projectMailDomains: ProjectMailDomainsPort = createUnavailableProjectMailDomainsPort();
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
      getOperation: async () => null,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains,
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
    requestId: () => "req_mail_domain",
    ...overrides,
  };
}

it("authorizes every managed mail route against the concrete environment before private services", async () => {
  const environmentId = parseUlid("00000000000000000000000004"),
    messageId = "00000000000000000000000005";
  const calls: { method: string; input: unknown }[] = [];
  const invoke = (method: string, result: unknown) => async (input: unknown) => {
    calls.push({ method, input });
    return result;
  };
  const port = {
    configureMailDomain: invoke("configure", { status: "pending" }),
    readMailDomain: invoke("status", { status: "pending" }),
    prepareMailWebhook: invoke("prepare", { status: "verification_required" }),
    verifyMailWebhook: invoke("verify", { status: "pending" }),
    rotateMailWebhook: invoke("rotate", { status: "verification_required" }),
    disableMailReceiving: invoke("disable", { status: "disabled" }),
    deleteMailDomain: invoke("delete", { status: "deleted" }),
    listMailMessages: invoke("list", []),
    getMailMessage: invoke("get", { status: "expired" }),
    getMailAttachment: invoke("attachment", new Response("file")),
    retryMailMessage: invoke("retry", { attempted: false }),
  };
  const authorization = vi.fn(async () => "allow" as const);
  const app = createControlApi(
    dependencies({ managedMail: port, authorization: { check: authorization } }),
  );
  const root = `https://api.test/v1/projects/${PROJECT_ID}/environments/${environmentId}`;
  for (const [method, path, body] of [
    ["PUT", "/mail-domain", { domain: "mail.example.com", sending: true, receiving: false }],
    ["GET", "/mail-domain", null],
    ["PUT", "/mail-webhook", { url: "https://app.example.com/mail" }],
    ["POST", "/mail-webhook/verify", null],
    ["POST", "/mail-webhook:rotate", null],
    ["DELETE", "/mail-webhook", null],
    ["DELETE", "/mail-domain", null],
    ["GET", "/mail/messages", null],
    ["GET", `/mail/messages/${messageId}`, null],
    ["GET", `/mail/messages/${messageId}/attachments/file-1`, null],
    ["POST", `/mail/messages/${messageId}/retry`, null],
  ] as const) {
    const response = await app.request(root + path, {
      method,
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "mail-request",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(200);
    expect(calls.at(-1)?.input).toMatchObject({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId,
    });
  }
  expect(authorization).toHaveBeenCalledWith(
    expect.objectContaining({ resource: expect.objectContaining({ environmentId }) }),
  );
  expect(calls.find((call) => call.method === "delete")?.input).toMatchObject({
    idempotencyKey: "mail-request",
  });
  expect(calls.find((call) => call.method === "rotate")?.input).toMatchObject({
    idempotencyKey: "mail-request",
    projectId: PROJECT_ID,
    environmentId,
  });
  const count = calls.length;
  const denied = createControlApi(
    dependencies({ managedMail: port, authorization: { check: async () => "deny" } }),
  );
  expect(
    (
      await denied.request(`${root}/mail/messages/${messageId}`, {
        headers: { Authorization: "Bearer valid" },
      })
    ).status,
  ).toBe(404);
  expect(calls).toHaveLength(count);
  const invalid = await app.request(`${root}/mail-domain`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer valid",
      "Content-Type": "application/json",
      "Idempotency-Key": "bad",
    },
    body: JSON.stringify({
      domain: "mail.example.com",
      sending: true,
      receiving: false,
      provider_key: "not-accepted",
    }),
  });
  expect(invalid.status).toBe(400);
  expect(calls).toHaveLength(count);
});
