import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedDevAccessProject } from "../../control-store/test/support/dev-access-fixture.js";
import { seedProductRuntimeFixture } from "../../control-store/test/support/product-runtime-fixture.js";
import { storedTimestamp } from "../../control-store/src/timestamps.js";
import { createD1ProjectApplication } from "../src/d1-project-application.js";
import { createD1GithubPushConsumer } from "../src/d1-github-auto-deploy.js";
import { GeneratedSdkProductApi } from "../../product-cli/src/product-api.js";
import { GeneratedSdkLocalMcpClient } from "../../mcp/src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../../mcp/src/local-server.js";
import {
  createD1ExtendedPorts,
  lazyPort,
  wakeOperationPublisher,
  type D1ExtendedBindings,
} from "../src/d1-extended-ports.js";

const PORTS = {
  publicEntry: "public_entry",
  credits: "public_credit",
  productSurface: "product_api",
  projectMailDomains: "mail_management",
  sharedMail: "shared_mail",
  githubSourceAuthorization: "github",
  githubOrganizationConnection: "github",
  devAccessTickets: "dev_access",
  devAccessManagement: "dev_access",
  functionRuns: "customer_reads",
  deploymentDiagnostics: "customer_reads",
  managedSources: "managed_source",
  providerReconciliation: "provider_reconciliation",
  cloudflareDomains: "cloudflare_domain_management",
  organizationMcpConnections: "organization_mcp_connections",
} as const;

it("builds each Core port on first use, names the binding a call lacks and runs real calls through the store", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      { project, principalId } = await seedDevAccessProject(control),
      clock = { now: () => new Date("2026-10-29T10:00:00.000Z") },
      ids = { next: () => parseUlid(newUlid()) },
      build = (bindings: D1ExtendedBindings) =>
        createD1ExtendedPorts({
          bindings,
          publicOrigin: "https://dev.app.ohmyho.st",
          clock,
          ids,
        }),
      woken: string[] = [],
      bindings = {
        CONTROL_RUNTIME: {
          ...store.customerReads,
          authorizeOrganizationAction: store.projects.authorizeOrganizationAction,
          listOrganizationMcpConnections: store.identity.listOrganizationMcpConnections,
          revokeOrganizationMcpConnection: store.identity.revokeOrganizationMcpConnection,
        },
        PUBLIC_ENTRY_RUNTIME: store.publicEntry,
        PUBLIC_ENTRY_RETENTION_RUNTIME: store.publicEntryRetention,
        CUSTOMER_FEEDBACK_RUNTIME: store.customerFeedback,
        PUBLIC_CREDIT_RUNTIME: store.publicCredits,
        CREDIT_SERVICE: { readUsage: async () => [] },
        PRODUCT_API_RUNTIME: store.productApi,
        MANAGED_SOURCE_RUNTIME: store.managedSource,
        DEV_ACCESS_RUNTIME: store.devAccess,
        MAIL_MANAGEMENT_RUNTIME: store.mailManagement,
        SHARED_MAIL_RUNTIME: store.sharedMail,
        GITHUB_RUNTIME: store.github,
        MAIL_DOMAIN_OBSERVER: {
          ensureWorkspaceMailDomain: async () => ({}),
          syncWorkspaceMailDomain: async () => ({}),
          retireWorkspaceMailDomain: async () => ({}),
        },
        SOURCE_INSPECTOR: { managedGit: async () => ({}), managedBlob: async () => ({}) },
        MANAGED_ARTIFACTS_NAMESPACE_US: "artifacts-us",
        MANAGED_ARTIFACTS_NAMESPACE_EU: "artifacts-eu",
        OPERATION_PUBLISHER: { wake: async () => void woken.push("wake") },
        AUTH_STATUS: { fetch: async () => Response.json({}) },
        ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x43).toString("base64"),
        ENVIRONMENT_SECRET_KEY_VERSION: "1",
        PROVIDER_RECONCILIATION: { reconcile: async () => ({}) },
        CLOUDFLARE_DOMAIN_MANAGEMENT: Object.fromEntries(
          [
            "beginAuthorization",
            "getStatus",
            "configureDomains",
            "completeAuthorization",
            "planPaidDomain",
            "applyPaidDomain",
            "getPaidDomain",
            "deletePaidDomain",
          ].map((method) => [method, async () => ({})]),
        ),
      } as unknown as D1ExtendedBindings;

    // Without a binding every port is still constructible; the call that needs the binding names it.
    const bare = build({});
    expect(bare.persistence).toEqual({});
    for (const [port, binding] of Object.entries(PORTS))
      expect(() => Reflect.get(bare[port as keyof typeof PORTS], "anything"), port).toThrow(
        `${binding}_binding_required`,
      );
    expect(() =>
      Reflect.get(build({ GITHUB_RUNTIME: store.github }).githubSourceAuthorization, "x"),
    ).toThrow("github_binding_required");

    // With the Core bindings every port builds, and calls reach the store.
    const ports = build(bindings);
    for (const port of Object.keys(PORTS))
      expect(() => Reflect.get(ports[port as keyof typeof PORTS], "anything"), port).not.toThrow();
    expect(Object.keys(ports.persistence).sort()).toEqual(
      expect.arrayContaining(["getOperation", "submitFeedback", "readFeedbackStatus"]),
    );
    expect(await ports.credits.readAccount(project.organizationId)).toMatchObject({
      organization_id: project.organizationId,
      plan: "free",
    });
    expect(await ports.credits.readUsage(project.organizationId)).toMatchObject({
      organization_id: project.organizationId,
      projects: [],
      days: [],
    });
    // The usage report alone needs the credit service; the other credit reads work without it.
    const withoutService = build({ PUBLIC_CREDIT_RUNTIME: store.publicCredits });
    await expect(withoutService.credits.readUsage(project.organizationId)).rejects.toThrow(
      "credit_service_binding_required",
    );
    expect(await withoutService.credits.readAccount(project.organizationId)).toMatchObject({
      plan: "free",
    });
    expect(
      await ports.functionRuns.list({
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        principalId,
        requestId: "req_ports",
        environmentId: parseUlid(project.devEnvironmentId),
        limit: 5,
      }),
    ).toEqual({ items: [] });
    expect(
      await ports.deploymentDiagnostics.list({
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        principalId,
        requestId: "req_ports",
        deploymentId: parseUlid(newUlid()),
        limit: 5,
      }),
    ).toEqual({ items: [], nextCursor: null });
    expect(await ports.githubOrganizationConnection.status(project.organizationId)).toEqual({
      status: "not_connected",
      connection: null,
    });
    // The workspace MCP port reads the Core's consents; the Core's own list and revoke commands serve it.
    expect(
      await ports.organizationMcpConnections.list({ organizationId: project.organizationId }),
    ).toEqual({ connections: [] });
    expect(
      (
        await ports.devAccessTickets.issue({
          organizationId: parseUlid(project.organizationId),
          projectId: parseUlid(project.projectId),
          principalId,
          requestId: "req_ports",
        })
      ).redeemUrl,
    ).toContain("/.ohmyhost/dev-access/redeem?stage=dev&ticket=");

    // A port is built once and kept.
    let built = 0;
    const once = lazyPort(() => ((built += 1), { answer: 42 }));
    expect([once.answer, once.answer, built]).toEqual([42, 42, 1]);

    // The publisher is woken as a method of its binding; a Worker without it fails the wake, not the build.
    await wakeOperationPublisher(bindings)();
    expect(woken).toEqual(["wake"]);
    await expect(wakeOperationPublisher({})()).rejects.toThrow(
      "operation_publisher_binding_required",
    );
  } finally {
    await control.dispose();
  }
});

it("runs the public preview lifecycle through real Core, generated clients and local MCP, then accepts a verified GitHub push", async () => {
  const control = await createTestControl();
  let handler: ReturnType<typeof createLocalOhmyhostMcpHandler> | undefined;
  try {
    const p = await seedProductRuntimeFixture(control),
      db = control.core,
      store = createControlStore(control.bindings),
      connection = newUlid(),
      grant = newUlid(),
      principalId = "user:user_consent",
      clock = { now: () => new Date() },
      ids = { next: () => parseUlid(newUlid()) },
      now = storedTimestamp(clock.now().toISOString());
    await db.batch([
      db
        .prepare(
          "INSERT INTO credit_account(organization_id,monthly_micros,monthly_ends_at,onetime_micros,reserved_micros,overrun_micros,paid_until,paid_source,updated_at) VALUES(?1,100000000,'2099-01-01T00:00:00.000000Z',0,0,0,'2099-01-01T00:00:00.000000Z','manual',?2)",
        )
        .bind(p.organizationId, now),
      db
        .prepare(
          "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','123',?5)",
        )
        .bind(p.organizationId, connection, p.projectId, p.billingEpochId, now),
      db
        .prepare(
          "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','456','123','owner','repo','contents:read',?6)",
        )
        .bind(p.organizationId, grant, p.projectId, p.billingEpochId, connection, now),
      db
        .prepare(
          "UPDATE project_source_bindings SET source_connection_id=?3,provider='github',generation=2,commit_sha=NULL,updated_at=?4 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, p.projectId, connection, now),
    ]);
    let head = "a".repeat(40);
    const source = {
      resolvePreviewGithubHead: vi.fn(async () => ({ defaultBranch: "refs/heads/main", head })),
    };
    const execution = {
      fence: vi.fn(async (input: unknown) => {
        void input;
      }),
      wake: vi.fn(async () => {}),
      sourceChanged: vi.fn(async () => {}),
    };
    const extended = createD1ExtendedPorts({
      bindings: {
        PREVIEW_API_RUNTIME: store.previews,
        PREVIEW_EXECUTION: execution,
        SOURCE_INSPECTOR: source,
        ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x43).toString("base64"),
        ENVIRONMENT_SECRET_KEY_VERSION: "1",
      } as never,
      publicOrigin: "https://dev.app.ohmyho.st",
      clock,
      ids,
    });
    const app = createD1ProjectApplication({
      runtime: store.projects as never,
      authentication: {
        authenticate: async (token) =>
          token === "local-fixture"
            ? {
                actorId: principalId,
                credentialId: "local:preview-test",
                authorizationPrincipal: { kind: "user", subjectId: principalId },
                organizationIds: [parseUlid(p.organizationId)],
              }
            : null,
      },
      platform: "development",
      clock,
      ids,
      applicationId: "preview-clients-integration",
      rateLimits: { consume: async () => ({ allowed: true }) },
      reporter: { report: () => {} },
      extended: { previews: extended.previews },
    });
    const transport = vi.fn<typeof globalThis.fetch>(async (request, init) =>
      app.fetch(new Request(request, init)),
    );
    const cli = new GeneratedSdkProductApi("https://local.test", "local-fixture", transport);
    const local = new GeneratedSdkLocalMcpClient("https://local.test", "local-fixture", transport);
    const mcp = createLocalOhmyhostMcpHandler({ authenticatedClient: async () => local });
    handler = mcp;
    const tool = async (action: string, extra: Record<string, unknown> = {}) => {
      const response = await mcp.fetch(
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
              name: `preview_${action}`,
              arguments: { project_id: p.projectId, environment: "prod", ...extra },
            },
          }),
        }),
      );
      const text = await response.text();
      const serialized = response.headers.get("content-type")?.startsWith("text/event-stream")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : text;
      if (!serialized) throw new Error("MCP response missing");
      return JSON.parse(serialized) as {
        result: {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          content?: { text?: string }[];
        };
      };
    };
    const opened = await tool("open");
    expect(opened.result.isError).not.toBe(true);
    const initial = await cli.preview("get", { projectId: p.projectId, environment: "prod" });
    expect(initial.source).toMatchObject({ sequence: 1, commit_sha: head });
    expect((await tool("get")).result.isError).not.toBe(true);
    expect(execution.wake).toHaveBeenCalledWith(
      expect.objectContaining({ publicOrigin: initial.url }),
    );
    expect(execution.sourceChanged).toHaveBeenCalledWith({ previewId: initial.id, sequence: 1 });
    const beforeInvalid = transport.mock.calls.length;
    for (const client of [cli, local])
      for (const action of ["stop", "rotate"] as const)
        await expect(
          client.preview(action, { projectId: p.projectId, environment: "prod" }),
        ).rejects.toThrow("Preview idempotency key is required");
    expect(transport).toHaveBeenCalledTimes(beforeInvalid);
    expect((await tool("rotate", { idempotency_key: "mcp-rotation" })).result.isError).not.toBe(
      true,
    );
    const rotated = await cli.preview("get", { projectId: p.projectId, environment: "prod" });
    expect(rotated.url).not.toBe(initial.url);
    expect((await tool("stop", { idempotency_key: "mcp-stop" })).result.isError).not.toBe(true);
    expect((await cli.preview("open", { projectId: p.projectId, environment: "prod" })).url).toBe(
      rotated.url,
    );
    expect(
      (
        await cli.preview("stop", {
          projectId: p.projectId,
          environment: "prod",
          idempotencyKey: "cli-stop",
        })
      ).url,
    ).toBe(rotated.url);
    const cliRotated = await cli.preview("rotate", {
      projectId: p.projectId,
      environment: "prod",
      idempotencyKey: "cli-rotate",
    });
    expect(cliRotated.url).not.toBe(rotated.url);
    await expect(
      local.preview("get", { projectId: newUlid(), environment: "prod" }),
    ).rejects.toMatchObject({ status: 404 });
    const beforeMalformed = transport.mock.calls.length;
    expect((await tool("stop", { idempotency_key: "" })).result.isError).toBe(true);
    expect(transport).toHaveBeenCalledTimes(beforeMalformed);

    head = "b".repeat(40);
    const eventId = newUlid();
    await store.ingress.recordGithubWebhook({
      inboxEventId: eventId,
      externalEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      eventType: "push",
      payload: {
        schemaVersion: "github.push.v1",
        installationId: 456,
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/main",
        beforeCommitSha: "a".repeat(40),
        commitSha: head,
        deleted: false,
      },
      bodyDigest: "02".repeat(32),
      receivedAt: clock.now().toISOString(),
      maxAttempts: 3,
    });
    const consumer = createD1GithubPushConsumer({
      bindings: {
        GITHUB_RUNTIME: store.github,
        CONTROL_RUNTIME: store.operations,
        CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        PRODUCT_API_RUNTIME: store.productApi as never,
        PREVIEW_API_RUNTIME: store.previews as never,
        PREVIEW_EXECUTION: execution,
        SOURCE_INSPECTOR: source,
      },
      surface: {} as never,
      clock,
      ids,
    });
    expect(await consumer.pollOne()).toMatchObject({ status: "ignored" });
    expect(
      (await cli.preview("get", { projectId: p.projectId, environment: "prod" })).source,
    ).toMatchObject({ sequence: 2, commit_sha: head });
    expect(execution.sourceChanged).toHaveBeenLastCalledWith({
      previewId: initial.id,
      sequence: 2,
    });
    expect(
      await db
        .prepare("SELECT state FROM webhook_inbox WHERE inbox_event_id=?1")
        .bind(eventId)
        .first(),
    ).toEqual({ state: "acknowledged" });
    expect(
      execution.fence.mock.calls.map(([fence]) => (fence as { reason: string }).reason),
    ).toEqual(["rotate", "destroy", "destroy", "rotate"]);
  } finally {
    await handler?.close();
    await control.dispose();
  }
});
