import { describe, expect, it, vi } from "vitest";

import { GeneratedSdkProductApi } from "../src/product-api.js";

const OPERATION_BODY = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  state: "queued" as const,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:00:00.000Z",
};

describe("generated SDK product API", () => {
  it("passes Native origin and application path configuration through the generated API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(await request.json()).toEqual({
        configurationRevision: 5,
        enabled: true,
        signupPolicy: "open",
        applicationName: "App",
        canonicalOrigin: null,
        allowedRedirectPaths: ["/", "/reset", "/invite"],
        resetPasswordPath: "/reset",
        invitationPath: "/invite",
      });
      return Response.json({
        enabled: true,
        configurationRevision: 6,
        revocationEpoch: 2,
        signupPolicy: "open",
        applicationName: "App",
        canonicalOrigin: "https://app.example",
        allowedRedirectPaths: ["/", "/reset", "/invite"],
        resetPasswordPath: "/reset",
        invitationPath: "/invite",
        readiness: { paid: true, sender: true, origin: true, storage: true },
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(
      api.nativeAuth({
        action: "config_set",
        projectId: "p",
        environmentId: "e",
        idempotencyKey: "k",
        configurationRevision: 5,
        enabled: true,
        signupPolicy: "open",
        applicationName: "App",
        canonicalOrigin: null,
        allowedRedirectPaths: ["/", "/reset", "/invite"],
        resetPasswordPath: "/reset",
        invitationPath: "/invite",
      }),
    ).resolves.toMatchObject({ revocationEpoch: 2 });
  });
  it("writes provider credentials through the generated scoped API and never echoes an unexpected secret", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe(
        "/v1/projects/project/environments/dev/auth/providers/google",
      );
      expect(request.headers.get("idempotency-key")).toBe("key");
      expect(await request.json()).toEqual({
        configurationRevision: 3,
        enabled: true,
        clientId: "client",
        clientSecret: "private",
      });
      return Response.json({
        provider: "google",
        enabled: true,
        configured: true,
        clientId: "client",
        secretPresent: true,
        callbackUrl: null,
        scopes: [],
        lastSuccessfulFlowAt: null,
        clientSecret: "private",
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    const result = await api.nativeAuth({
      action: "provider_set",
      projectId: "project",
      environmentId: "dev",
      provider: "google",
      configurationRevision: 3,
      enabled: true,
      clientId: "client",
      clientSecret: "private",
      idempotencyKey: "key",
    });
    expect(result).toMatchObject({ secretPresent: true });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("connects and observes workspace GitHub through authenticated generated SDK requests", async () => {
    const organizationId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      if (request.method === "POST") {
        expect(new URL(request.url).pathname).toBe(
          `/v1/organizations/${organizationId}/github:connect`,
        );
        expect(request.headers.get("idempotency-key")).toBe("connect-a");
        expect(await request.json()).toEqual({});
        return Response.json(
          {
            authorization_id: organizationId,
            status: "pending",
            last_failure: null,
            authorization_url: "https://github.com/apps/ohmyhost/installations/new?state=bound",
            expires_at: "2026-08-18T00:30:00.000Z",
            connection: null,
          },
          { status: 201 },
        );
      }
      expect(new URL(request.url).pathname).toBe(`/v1/organizations/${organizationId}/github`);
      return Response.json({ status: "not_connected", connection: null });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(
      api.connectGithub({ organizationId, idempotencyKey: "connect-a" }),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(api.getGithubConnection(organizationId)).resolves.toEqual({
      status: "not_connected",
      connection: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("disconnects workspace GitHub through the generated DELETE without an Idempotency-Key", async () => {
    const organizationId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).pathname).toBe(`/v1/organizations/${organizationId}/github`);
      expect(request.headers.get("idempotency-key")).toBeNull();
      return Response.json({ status: "not_connected", connection: null });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(api.disconnectGithub(organizationId)).resolves.toEqual({
      status: "not_connected",
      connection: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lists and revokes workspace MCP connections through the generated SDK", async () => {
    const organizationId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const connectionId = "7f3d2c1e-8a4b-4c5d-9e6f-1a2b3c4d5e6f";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      expect(request.headers.get("idempotency-key")).toBeNull();
      if (request.method === "DELETE") {
        expect(new URL(request.url).pathname).toBe(
          `/v1/organizations/${organizationId}/mcp-connections/${connectionId}`,
        );
        return Response.json({ state: "revoked" });
      }
      expect(new URL(request.url).pathname).toBe(
        `/v1/organizations/${organizationId}/mcp-connections`,
      );
      return Response.json({ connections: [] });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(api.listOrganizationMcpConnections(organizationId)).resolves.toEqual({
      connections: [],
    });
    await expect(
      api.revokeOrganizationMcpConnection({ organizationId, connectionId }),
    ).resolves.toEqual({ state: "revoked" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("configures and reads source auto-deploy through generated SDK requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe(
        "/v1/projects/01K2F3G4H5J6K7M8N9P0QRSTVW/source/auto-deploy",
      );
      if (request.method === "PUT") {
        expect(request.headers.get("idempotency-key")).toBe("auto-a");
        await expect(request.json()).resolves.toEqual({ branch: "main", enabled: true });
      }
      return Response.json({
        branch: "main",
        ref: "refs/heads/main",
        environment: "dev",
        enabled: true,
        generation: 1,
        grant_status: "active",
        updated_at: "2026-08-18T00:00:00.000Z",
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(
      api.configureAutoDeploy({
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        branch: "main",
        enabled: true,
        idempotencyKey: "auto-a",
      }),
    ).resolves.toMatchObject({ ref: "refs/heads/main" });
    await expect(api.getAutoDeploy("01K2F3G4H5J6K7M8N9P0QRSTVW")).resolves.toMatchObject({
      environment: "dev",
    });
  });
  it("sends the Dev access ticket and the database credential without an Idempotency-Key, which those routes ignore", async () => {
    const keys: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      keys.push(request.headers.get("idempotency-key"));
      if (new URL(request.url).pathname.endsWith("/dev-access-tickets"))
        return Response.json(
          {
            ticket_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
            project_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
            environment_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
            origin: "https://dev-calm-otter-waves.dev.check.omh.st",
            redeem_url: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
            expires_at: "2026-08-18T00:10:00.000Z",
          },
          { status: 201 },
        );
      return Response.json({ id: "x" }, { status: 201 });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await api.createDevAccessTicket("01K2F3G4H5J6K7M8N9P0QRSTVW");
    await api
      .createProjectDatabaseAccess({
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        environment: "dev",
        mode: "read",
        ttlSeconds: 3600,
        label: null,
      })
      .catch(() => undefined);
    expect(keys).toEqual([null, null]);
  });

  it("creates a dev access ticket through the generated owner-only endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        "/v1/projects/01K2F3G4H5J6K7M8N9P0QRSTVW/dev-access-tickets",
      );
      return Response.json(
        {
          ticket_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
          project_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
          environment_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
          origin: "https://dev-calm-otter-waves.dev.check.omh.st",
          redeem_url: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
          expires_at: "2026-08-18T00:10:00.000Z",
        },
        { status: 201 },
      );
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(api.createDevAccessTicket("01K2F3G4H5J6K7M8N9P0QRSTVW")).resolves.toMatchObject({
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
    });
  });

  it("sends a confirmed database size change with its idempotency key through the generated endpoint", async () => {
    const projectId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const bodies: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer access-c");
      expect(new URL(request.url).pathname).toBe(`/v1/projects/${projectId}/database/compute`);
      expect(request.headers.get("idempotency-key")).toBe(`size-${String(bodies.length + 1)}`);
      bodies.push(await request.json());
      return Response.json(OPERATION_BODY, { status: 202 });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-c", fetch);

    await api.changeDatabaseCompute({
      projectId,
      environment: "prod",
      memoryMiB: 1024,
      idempotencyKey: "size-1",
    });
    await api.changeDatabaseCompute({
      projectId,
      environment: "dev",
      profile: "performance",
      idempotencyKey: "size-2",
    });
    expect(bodies).toEqual([
      { environment: "prod", memory_mib: 1024, confirm: true },
      { environment: "dev", profile: "performance", confirm: true },
    ]);
  });

  it("asks the generated handle-availability endpoint for a candidate address", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer access-h");
      expect(new URL(request.url).pathname).toBe("/v1/project-handles/acme-shop");
      return Response.json({
        handle: "acme-shop",
        available: false,
        reason: "taken",
        alternatives: ["acme-shop-2"],
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-h", fetch);

    await expect(api.checkProjectHandle({ handle: "acme-shop" })).resolves.toEqual({
      handle: "acme-shop",
      available: false,
      reason: "taken",
      alternatives: ["acme-shop-2"],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a rename through the generated handle endpoint with both guard headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/v1/projects/01K2F3G4H5J6K7M8N9P0QRSTVW/handle");
      expect(request.headers.get("if-match")).toBe('"7"');
      expect(request.headers.get("idempotency-key")).toBe("rename-a");
      await expect(request.json()).resolves.toEqual({ handle: "acme-shop" });
      return Response.json(OPERATION_BODY, { status: 202 });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-r", fetch);

    await expect(
      api.changeProjectHandle({
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        handle: "acme-shop",
        ifMatch: '"7"',
        idempotencyKey: "rename-a",
      }),
    ).resolves.toMatchObject({ id: OPERATION_BODY.id, state: "queued" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the generated authenticated SDK for current identity discovery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://control.example.test/v1/me");
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      return new Response(
        JSON.stringify({
          actor_id: "user:user-a",
          email: "owner@example.test",
          organization_ids: ["00000000000000000000000001"],
          organizations: [{ id: "00000000000000000000000001", name: "Workspace" }],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(api.getCurrentIdentity()).resolves.toEqual({
      actor_id: "user:user-a",
      email: "owner@example.test",
      organization_ids: ["00000000000000000000000001"],
      organizations: [{ id: "00000000000000000000000001", name: "Workspace" }],
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the generated owner-only operation reconciliation request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/operations/operation-a:reconcile");
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      expect(request.headers.get("idempotency-key")).toBe("reconcile-a");
      expect(await request.text()).toBe("");
      return Response.json(
        {
          reconciliation_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
          operation_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
          state: "pending",
        },
        { status: 202 },
      );
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.reconcileOperation({ operationId: "operation-a", idempotencyKey: "reconcile-a" }),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("opens operation logs through the generated SSE surface", async () => {
    const resumedAfter: Array<string | null> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/operations/operation-a/events");
      expect(request.headers.get("accept")).toBe("text/event-stream");
      resumedAfter.push(request.headers.get("last-event-id"));
      if (request.headers.get("last-event-id") === "event-refused")
        return new Response(null, { status: 404 });
      return new Response('data: {"type":"OperationSucceeded"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    const controller = new AbortController();
    const stream = await api.streamOperationEvents("operation-a", controller.signal);
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { type: "OperationSucceeded" },
    });
    // A resumed stream names its last event, and a refused one ends after a single attempt instead
    // of being retried without end.
    const resumed = await api.streamOperationEvents("operation-a", controller.signal, "event-a");
    await expect(resumed[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: false });
    const refused = await api.streamOperationEvents(
      "operation-a",
      controller.signal,
      "event-refused",
    );
    await expect(refused[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(resumedAfter).toEqual([null, "event-a", "event-refused"]);
    controller.abort();
  });

  it("returns all four closed diagnostic sources through the generated SDK", async () => {
    const items = [
      ["build", "BUILD_FAILED", "CUSTOMER_BUILD_FAILED"],
      ["control", "DEPLOYMENT_FAILED", "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR"],
      ["runtime", "RUNTIME_FAILED", "CUSTOMER_RUNTIME_FAILED"],
      ["function", "FUNCTION_FAILED", "CUSTOMER_FUNCTION_FAILED"],
    ].map(([source, code, message], index) => ({
      id: `01K2F3G4H5J6K7M8N9P0QRSTV${String.fromCharCode(87 + index)}`,
      source,
      code,
      message,
      occurred_at: "2026-08-18T00:00:00.000Z",
    }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe(
        "/v1/projects/project-a/deployments/deployment-a/logs",
      );
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      return Response.json({ items });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(
      api.getDeploymentLogs({ projectId: "project-a", deploymentId: "deployment-a", limit: 100 }),
    ).resolves.toMatchObject({
      items: items.map((item) => expect.objectContaining({ source: item.source, code: item.code })),
    });
  });

  it("lists project deployments through the generated SDK with cursor and limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(url.pathname).toBe("/v1/projects/project-a/deployments");
      expect(url.searchParams.get("cursor")).toBe("cursor-a");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      return Response.json({ items: [], next_cursor: null });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await expect(
      api.listDeployments({ projectId: "project-a", cursor: "cursor-a", limit: 2 }),
    ).resolves.toEqual({ items: [], next_cursor: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("routes every WP-30 product operation through generated SDK request builders", async () => {
    const calls: Array<{ method: string; path: string; headers: Headers; body?: unknown }> = [];
    const operation = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      state: "queued",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
    };
    const destructivePlan = {
      action: "delete",
      project_id: "project-a",
      resource_etag: '"etag-a"',
      effects: [],
      risks: [],
      confirmation_token: "confirmation-a",
      created_at: "2026-08-18T00:00:00.000Z",
      expires_at: "2026-08-18T00:10:00.000Z",
    };
    const deploymentPlan = {
      id: "plan-a",
      project_id: "project-a",
      environment: "dev",
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"a".repeat(64)}`,
      build_plan_digest: `sha256:${"b".repeat(64)}`,
      application_root: "site",
      runtime: "cloudflare_workers_static_assets",
      route: "https://example.test",
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
      created_at: "2026-08-18T00:00:00.000Z",
      expires_at: "2026-08-18T00:15:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const text =
        request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        ...(text === "" ? {} : { body: JSON.parse(text) }),
      });
      const path = new URL(request.url).pathname;
      const data = path.endsWith(":delete-plan")
        ? destructivePlan
        : path.endsWith(":promote-plan")
          ? {
              ...destructivePlan,
              action: "promote",
              source_deployment_id: "deployment-a",
              source_artifact_digest: `sha256:${"d".repeat(64)}`,
              source_environment: "dev",
              target_environment: "prod",
            }
          : path.endsWith(":rollback-plan")
            ? { ...destructivePlan, action: "rollback", target_deployment_id: "deployment-a" }
            : path.endsWith("deployments:plan")
              ? deploymentPlan
              : path.endsWith("/database/query")
                ? { environment: "dev", rows: [{ visits: "1" }], row_count: 1, truncated: false }
                : operation;
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
        status:
          path.includes(":plan") ||
          path.endsWith(":delete-plan") ||
          path.endsWith(":rollback-plan") ||
          path.endsWith("/database/query")
            ? 200
            : 202,
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await api.linkSource({
      projectId: "project-a",
      repositoryOwner: "owner",
      repositoryName: "repo",
      idempotencyKey: "link-a",
    });
    await api.planDeployment({
      projectId: "project-a",
      commitSha: "a".repeat(40),
      environment: "prod",
    });
    await api.createDeployment({
      projectId: "project-a",
      planId: "plan-a",
      idempotencyKey: "deploy-a",
    });
    await api.queryProjectDatabase({
      environment: "dev",
      projectId: "project-a",
      statement: "SELECT count(*)::text visits FROM visits",
      parameters: [],
    });
    await api.planRollback({ projectId: "project-a", deploymentId: "deployment-a" });
    await api.rollback({
      projectId: "project-a",
      deploymentId: "deployment-a",
      ifMatch: '"etag-a"',
      confirmationToken: "confirmation-a",
      idempotencyKey: "rollback-a",
    });
    await api.planPromotion({ projectId: "project-a", sourceDeploymentId: "deployment-a" });
    await api.promote({
      projectId: "project-a",
      sourceDeploymentId: "deployment-a",
      ifMatch: '"etag-a"',
      confirmationToken: "confirmation-a",
      idempotencyKey: "promote-a",
    });
    await api.planDelete("project-a");
    await api.deleteProject({
      projectId: "project-a",
      ifMatch: '"etag-a"',
      confirmationToken: "confirmation-a",
      idempotencyKey: "delete-a",
    });
    await api.planDeployment({ projectId: "project-a", commitSha: "b".repeat(40) });

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/projects/project-a/source:link",
      "POST /v1/projects/project-a/deployments:plan",
      "POST /v1/projects/project-a/deployments",
      "POST /v1/projects/project-a/database/query",
      "POST /v1/projects/project-a/deployments/deployment-a:rollback-plan",
      "POST /v1/projects/project-a/deployments/deployment-a:rollback",
      "POST /v1/projects/project-a/deployments/deployment-a:promote-plan",
      "POST /v1/projects/project-a/deployments/deployment-a:promote",
      "POST /v1/projects/project-a:delete-plan",
      "DELETE /v1/projects/project-a",
      "POST /v1/projects/project-a/deployments:plan",
    ]);
    expect(calls.at(-1)?.body).toEqual({ commit_sha: "b".repeat(40) });
    expect(calls[5]?.headers.get("if-match")).toBe('"etag-a"');
    expect(calls[5]?.headers.get("x-confirmation-token")).toBe("confirmation-a");
    expect(calls[7]?.headers.get("if-match")).toBe('"etag-a"');
    expect(calls[7]?.headers.get("x-confirmation-token")).toBe("confirmation-a");
    expect(calls[9]?.headers.get("idempotency-key")).toBe("delete-a");
  });

  it("uses the generated authenticated SDK for operation reads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://control.example.test/v1/operations/operation-a");
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      return new Response(
        JSON.stringify({
          id: "operation-a",
          state: "succeeded",
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
          result: {
            schemaVersion: "ohmyhost.operation-deployment-result/v2",
            deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(api.getOperation("operation-a")).resolves.toMatchObject({
      id: "operation-a",
      state: "succeeded",
      result: {
        schemaVersion: "ohmyhost.operation-deployment-result/v2",
        deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the generated authenticated SDK for project creation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer access-a");
      if (request.url.endsWith("/environments/dev")) {
        expect(request.url).toBe(
          "https://control.example.test/v1/projects/01K2F3G4H5J6K7M8N9P0QRSTVW/environments/dev",
        );
        expect(request.headers.get("idempotency-key")).toBe("add-dev");
        await expect(request.json()).resolves.toEqual({});
      } else {
        expect(request.url).toBe("https://control.example.test/v1/projects");
        expect(request.headers.get("idempotency-key")).toBe("create-a");
        await expect(request.json()).resolves.toEqual({
          organization_id: "organization-a",
          name: "alpha",
          region: "eu",
          include_development_environment: false,
        });
      }
      return new Response(
        JSON.stringify({
          id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
          state: "queued",
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        }),
        { headers: { "content-type": "application/json" }, status: 202 },
      );
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.createProject({
        organizationId: "organization-a",
        name: "alpha",
        region: "eu",
        includeDevelopmentEnvironment: false,
        idempotencyKey: "create-a",
      }),
    ).resolves.toMatchObject({ state: "queued" });
    await expect(
      api.addProjectDevelopmentEnvironment({
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        idempotencyKey: "add-dev",
      }),
    ).resolves.toMatchObject({ state: "queued" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("routes scheduled function runs through the generated SDK builder with its limit", async () => {
    const run = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      deployment_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      cron: "*/5 * * * *",
      scheduled_at: "2026-09-15T14:30:00.000Z",
      state: "succeeded",
      attempt: 1,
      status_code: 204,
      started_at: "2026-09-15T14:30:32.306Z",
      finished_at: "2026-09-15T14:30:34.262Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/v1/projects/project-a/environments/environment-a/function-runs");
      expect(url.searchParams.get("limit")).toBe("7");
      return new Response(JSON.stringify({ items: [run] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.listFunctionRuns({ projectId: "project-a", environmentId: "environment-a", limit: 7 }),
    ).resolves.toEqual({ items: [run] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("routes environment-secret metadata and mutations through generated SDK builders", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> =
      [];
    const secret = {
      name: "API_KEY",
      revision: 1,
      key_version: 1,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const text = request.method === "PUT" ? await request.text() : "";
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        ...(text === "" ? {} : { body: JSON.parse(text) }),
        ...(request.headers.get("idempotency-key") === null
          ? {}
          : { idempotencyKey: request.headers.get("idempotency-key") ?? undefined }),
      });
      const responseBody =
        request.method === "GET"
          ? { items: [secret] }
          : request.method === "DELETE"
            ? { name: secret.name, status: "deleted" }
            : secret;
      return new Response(JSON.stringify(responseBody), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await api.listEnvironmentSecrets({ projectId: "project-a", environmentId: "environment-a" });
    await api.putEnvironmentSecret({
      projectId: "project-a",
      environmentId: "environment-a",
      name: secret.name,
      value: "postgres://private",
      idempotencyKey: "secret-set-a",
    });
    await api.deleteEnvironmentSecret({
      projectId: "project-a",
      environmentId: "environment-a",
      name: secret.name,
      idempotencyKey: "secret-delete-a",
    });

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/v1/projects/project-a/environments/environment-a/secrets",
      },
      {
        method: "PUT",
        path: "/v1/projects/project-a/environments/environment-a/secrets/API_KEY",
        body: { value: "postgres://private" },
        idempotencyKey: "secret-set-a",
      },
      {
        method: "DELETE",
        path: "/v1/projects/project-a/environments/environment-a/secrets/API_KEY",
        idempotencyKey: "secret-delete-a",
      },
    ]);
  });

  it("routes sender-domain configuration and status through generated SDK builders", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> =
      [];
    const environmentId = "01H00000000000000000000602";
    const mailDomain = {
      domain_id: "01H00000000000000000000603",
      environment_id: environmentId,
      sending: "pending",
      receiving: "disabled",
      observed_at: null,
      dns_records: [],
      webhook: null,
      next_check_after_seconds: 60,
      domain: "mail.example.com",
      status: "verification_pending" as const,
      configured_at: "2026-08-22T10:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const text = request.method === "PUT" ? await request.text() : "";
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        ...(text === "" ? {} : { body: JSON.parse(text) }),
        ...(request.headers.get("idempotency-key") === null
          ? {}
          : { idempotencyKey: request.headers.get("idempotency-key") ?? undefined }),
      });
      return Response.json(mailDomain);
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    await api.managedMail({
      action: "configure",
      environmentId,
      sending: true,
      receiving: false,
      projectId: "project-a",
      domain: mailDomain.domain,
      idempotencyKey: "mail-domain-a",
    });
    await api.managedMail({ action: "status", projectId: "project-a", environmentId });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: `/v1/projects/project-a/environments/${environmentId}/mail-domain`,
        body: { domain: mailDomain.domain, sending: true, receiving: false },
        idempotencyKey: "mail-domain-a",
      },
      { method: "GET", path: `/v1/projects/project-a/environments/${environmentId}/mail-domain` },
    ]);
  });

  it("routes Free and Paid domain lifecycles through generated SDK builders", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body: string;
      idempotencyKey: string | null;
    }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = await request.text();
      calls.push({
        method: request.method,
        path,
        body,
        idempotencyKey: request.headers.get("idempotency-key"),
      });
      if (path.endsWith("/cloudflare-dns/authorization")) {
        return Response.json(
          {
            authorization_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
            authorization_url:
              "https://dash.cloudflare.com/oauth2/auth?client_id=client-a&state=opaque-state",
            expires_at: "2026-08-18T00:10:00.000Z",
          },
          { status: 201 },
        );
      }
      if (path.endsWith("/cloudflare-dns")) {
        return Response.json({
          status: "authorized",
          zone: "aixyte.com",
          scopes: ["dns.write", "zone.read"],
          expires_at: "2026-08-18T01:00:00.000Z",
        });
      }
      if (path.endsWith("/paid-domain:plan")) {
        return Response.json({
          status: "planned",
          hostname: "poc.tenant-fixture.com",
          environment: "prod",
          cname_target: "customers.omh.st",
          effects: ["Create custom hostname."],
          risks: ["Traffic becomes public."],
        });
      }
      if (path.endsWith("/paid-domain")) {
        return Response.json({
          status: request.method === "DELETE" ? "deleted" : "active",
          hostname: "poc.tenant-fixture.com",
          environment: "prod",
          cname_target: "customers.omh.st",
          custom_hostname_status: "active",
          suspension_reason: null,
          ssl_status: "active",
          validation_records: [],
          url: request.method === "DELETE" ? null : "https://poc.tenant-fixture.com",
        });
      }
      return Response.json(
        {
          id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
          state: "queued",
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        },
        { status: 202 },
      );
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await api.authorizeCloudflareDns({
      projectId: "project-a",
      zone: "aixyte.com",
      idempotencyKey: "cloudflare-auth-a",
    });
    await api.getCloudflareDnsStatus("project-a");
    await api.applyProjectDomains({ projectId: "project-a", idempotencyKey: "domains-apply-a" });
    await api.planPaidDomain({ projectId: "project-a", hostname: "poc.tenant-fixture.com" });
    await api.applyPaidDomain({
      projectId: "project-a",
      hostname: "poc.tenant-fixture.com",
      idempotencyKey: "paid-apply-a",
    });
    await api.getPaidDomain("project-a");
    await api.deletePaidDomain({
      projectId: "project-a",
      hostname: "poc.tenant-fixture.com",
      idempotencyKey: "paid-delete-a",
    });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/projects/project-a/cloudflare-dns/authorization",
        body: JSON.stringify({ zone: "aixyte.com" }),
        idempotencyKey: "cloudflare-auth-a",
      },
      {
        method: "GET",
        path: "/v1/projects/project-a/cloudflare-dns",
        body: "",
        idempotencyKey: null,
      },
      {
        method: "PUT",
        path: "/v1/projects/project-a/domains",
        body: "",
        idempotencyKey: "domains-apply-a",
      },
      {
        method: "POST",
        path: "/v1/projects/project-a/paid-domain:plan",
        body: JSON.stringify({ hostname: "poc.tenant-fixture.com" }),
        idempotencyKey: null,
      },
      {
        method: "PUT",
        path: "/v1/projects/project-a/paid-domain",
        body: JSON.stringify({ hostname: "poc.tenant-fixture.com" }),
        idempotencyKey: "paid-apply-a",
      },
      {
        method: "GET",
        path: "/v1/projects/project-a/paid-domain",
        body: "",
        idempotencyKey: null,
      },
      {
        method: "DELETE",
        path: "/v1/projects/project-a/paid-domain",
        body: JSON.stringify({ hostname: "poc.tenant-fixture.com" }),
        idempotencyKey: "paid-delete-a",
      },
    ]);
  });
  it("issues, lists and revokes one project database credential through the generated SDK", async () => {
    const project = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const accessId = "01H00000000000000000000005";
    const role = "ohmyho_da_01h00000000000000000000006_07070707";
    const host = "pgcf.example.test";
    const database = "dbkx3m9q2w7e5r1t8y4u";
    const uri = `postgres://${role}:${"3f".repeat(32)}@${host}/${database}?sslmode=require`;
    const access = {
      provider: "pgcf",
      transport: "wss",
      websocket_url: `wss://${host}/`,
      access_id: accessId,
      environment: "dev",
      mode: "read",
      role_name: role,
      host,
      database,
      label: "psql",
      state: "active",
      issued_at: "2026-09-15T12:00:00.000Z",
      expires_at: "2026-09-15T13:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    };
    const credential = {
      ...access,
      connection_uri: uri,
      psql_command: `ohmyhost database psql --project ${project} --environment dev --mode read`,
    };
    const calls: { method: string; path: string; query: string; body: string }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: await request.text(),
      });
      if (request.method === "POST") return Response.json(credential, { status: 201 });
      if (request.method === "DELETE")
        return Response.json({
          ...access,
          state: "revoked",
          revoked_at: "2026-09-15T12:30:00.000Z",
          revocation_reason: "principal",
        });
      return Response.json({ items: [access] });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    // The credential exists only in this response; the CLI returns it unchanged and stores nothing.
    await expect(
      api.createProjectDatabaseAccess({
        projectId: project,
        environment: "dev",
        mode: "read",
        ttlSeconds: 3600,
        label: "psql",
      }),
    ).resolves.toEqual(credential);
    await expect(
      api.listProjectDatabaseAccess({ projectId: project, environment: "dev" }),
    ).resolves.toEqual({ items: [access] });
    await expect(api.listProjectDatabaseAccess({ projectId: project })).resolves.toEqual({
      items: [access],
    });
    await expect(
      api.revokeProjectDatabaseAccess({ projectId: project, accessId }),
    ).resolves.toMatchObject({ state: "revoked", revocation_reason: "principal" });

    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/projects/${project}/database/access`,
        query: "",
        body: JSON.stringify({
          environment: "dev",
          mode: "read",
          ttl_seconds: 3600,
          label: "psql",
        }),
      },
      {
        method: "GET",
        path: `/v1/projects/${project}/database/access`,
        query: "?environment=dev",
        body: "",
      },
      { method: "GET", path: `/v1/projects/${project}/database/access`, query: "", body: "" },
      {
        method: "DELETE",
        path: `/v1/projects/${project}/database/access/${accessId}`,
        query: "",
        body: "",
      },
    ]);
  });

  it("refuses a database access answer the public contract does not accept", async () => {
    const project = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const accessId = "01H00000000000000000000005";
    const role = "ohmyho_da_01h00000000000000000000006_07070707";
    const host = "pgcf.example.test";
    const database = "dbkx3m9q2w7e5r1t8y4u";
    const uri = `postgres://${role}:${"3f".repeat(32)}@${host}/${database}?sslmode=require`;
    const access = {
      provider: "pgcf",
      transport: "wss",
      websocket_url: `wss://${host}/`,
      access_id: accessId,
      environment: "dev",
      mode: "read",
      role_name: role,
      host,
      database,
      label: "psql",
      state: "active",
      issued_at: "2026-09-15T12:00:00.000Z",
      expires_at: "2026-09-15T13:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    };
    const answer = (request: Request) => {
      if (request.method === "POST")
        // A psql command that embeds the URI instead of the secret-free helper would leak the credential.
        return Response.json(
          { ...access, connection_uri: uri, psql_command: `psql '${uri}'` },
          { status: 201 },
        );
      if (request.method === "DELETE")
        return Response.json({ ...access, state: "dropped", revoked_at: null });
      return Response.json({ items: [{ ...access, role_name: "neondb_owner" }] });
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
      answer(new Request(input, init)),
    );
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.createProjectDatabaseAccess({
        projectId: project,
        environment: "dev",
        mode: "read",
        ttlSeconds: 3600,
        label: "psql",
      }),
    ).rejects.toThrow(TypeError);
    await expect(api.listProjectDatabaseAccess({ projectId: project })).rejects.toThrow(TypeError);
    await expect(api.revokeProjectDatabaseAccess({ projectId: project, accessId })).rejects.toThrow(
      TypeError,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("generated SDK database webhook API", () => {
  const project = "01K2F3G4H5J6K7M8N9P0QRSTVW";
  const webhook = "whk_abcdefghijklmnopqrst";
  const delivery = "dlv_0123456789abcdef0123";
  const row = {
    id: webhook,
    environment: "dev" as const,
    url: "https://hooks.example.com/pg",
    event_types: ["database.ready" as const],
    header_names: ["x-tenant"],
    created_at: "2026-10-31T10:00:00.000Z",
  };
  const deliveryRow = {
    id: delivery,
    event_id: "evt_0123456789abcdef0123",
    event_type: "database.ready" as const,
    webhook_id: webhook,
    state: "dead_lettered" as const,
    attempts: 3,
    created_at: "2026-10-31T10:00:00.000Z",
    next_attempt_at: null,
    delivered_at: null,
    last_status: 500,
    last_error: "http" as const,
  };

  it("sends webhook requests through the generated SDK and returns the secret only from create", async () => {
    const calls: {
      method: string;
      path: string;
      query: string;
      key: string | null;
      body: string;
    }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        key: request.headers.get("idempotency-key"),
        body: await request.text(),
      });
      if (url.pathname.includes("/webhook-subscriptions/")) {
        const subscription = {
          id: project,
          environment: url.searchParams.get("environment"),
          generation: 1,
          state: request.method === "DELETE" ? "inactive" : "active",
          provider_id: webhook,
        };
        return Response.json({
          ...subscription,
          ...(request.method === "PUT" ? { secret: "whsec_fixture_secret" } : {}),
        });
      }
      if (url.pathname.endsWith("/webhook-deliveries") && request.method === "GET")
        return Response.json({ items: [deliveryRow], next_cursor: "next-a" });
      if (url.pathname.endsWith(`/${delivery}/replay`))
        return Response.json({ delivery_id: delivery, state: "pending" }, { status: 202 });
      if (url.pathname.endsWith("/test"))
        return Response.json({ delivered: true, status: 204, error: null, duration_ms: 42 });
      if (request.method === "POST")
        return Response.json(
          { ...row, environment: "prod", secret: "whsec_fixture" },
          { status: 201 },
        );
      if (request.method === "DELETE") return Response.json({ id: webhook, deleted: true });
      if (url.pathname.endsWith(`/${webhook}`)) return Response.json(row);
      return Response.json({ items: [row] });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.createProjectDatabaseWebhook({
        projectId: project,
        environment: "prod",
        idempotencyKey: "hook-a",
        url: row.url,
        eventTypes: ["database.ready"],
        headers: { "x-tenant": "alpha" },
      }),
    ).resolves.toEqual({ ...row, environment: "prod", secret: "whsec_fixture" });
    await expect(
      api.listProjectDatabaseWebhooks({ projectId: project, environment: "dev" }),
    ).resolves.toEqual({ items: [row] });
    await expect(
      api.getProjectDatabaseWebhook({ projectId: project, environment: "dev", webhookId: webhook }),
    ).resolves.toEqual(row);
    await expect(
      api.deleteProjectDatabaseWebhook({
        projectId: project,
        environment: "prod",
        webhookId: webhook,
        idempotencyKey: "delete-a",
      }),
    ).resolves.toEqual({ id: webhook, deleted: true });
    await expect(
      api.testProjectDatabaseWebhook({
        projectId: project,
        environment: "dev",
        webhookId: webhook,
      }),
    ).resolves.toEqual({ delivered: true, status: 204, error: null, duration_ms: 42 });
    await expect(
      api.listProjectDatabaseWebhookDeliveries({
        projectId: project,
        environment: "dev",
        webhookId: webhook,
        limit: 5,
        cursor: "cursor-a",
      }),
    ).resolves.toEqual({ items: [deliveryRow], next_cursor: "next-a" });
    await expect(
      api.replayProjectDatabaseWebhookDelivery({
        projectId: project,
        environment: "dev",
        deliveryId: delivery,
        idempotencyKey: "replay-a",
      }),
    ).resolves.toEqual({ delivery_id: delivery, state: "pending" });
    const subscriptionScope = {
      projectId: project,
      environment: "dev" as const,
      subscriptionId: project,
    };
    const request = {
      url: row.url,
      event_types: ["database.ready" as const],
      headers: { "x-tenant": "alpha" },
    };
    await expect(
      api.activateDatabaseWebhookSubscription({
        ...subscriptionScope,
        generation: 1,
        idempotencyKey: "sub-a",
        request,
      }),
    ).resolves.toMatchObject({ secret: "whsec_fixture_secret", state: "active" });
    await expect(api.getDatabaseWebhookSubscription(subscriptionScope)).resolves.toMatchObject({
      id: project,
      state: "active",
    });
    await expect(
      api.deactivateDatabaseWebhookSubscription({
        ...subscriptionScope,
        generation: 1,
        idempotencyKey: "sub-off",
      }),
    ).resolves.toMatchObject({ state: "inactive" });

    const base = `/v1/projects/${project}/database`;
    expect(calls).toEqual([
      {
        method: "POST",
        path: `${base}/webhooks`,
        query: "?environment=prod",
        key: "hook-a",
        body: JSON.stringify({
          url: row.url,
          event_types: ["database.ready"],
          headers: { "x-tenant": "alpha" },
        }),
      },
      {
        method: "GET",
        path: `${base}/webhooks`,
        query: "?environment=dev",
        key: null,
        body: "",
      },
      {
        method: "GET",
        path: `${base}/webhooks/${webhook}`,
        query: "?environment=dev",
        key: null,
        body: "",
      },
      {
        method: "DELETE",
        path: `${base}/webhooks/${webhook}`,
        query: "?environment=prod",
        key: "delete-a",
        body: "",
      },
      {
        method: "POST",
        path: `${base}/webhooks/${webhook}/test`,
        query: "?environment=dev",
        key: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        body: "",
      },
      {
        method: "GET",
        path: `${base}/webhook-deliveries`,
        query: `?environment=dev&webhook_id=${webhook}&limit=5&cursor=cursor-a`,
        key: null,
        body: "",
      },
      {
        method: "POST",
        path: `${base}/webhook-deliveries/${delivery}/replay`,
        query: "?environment=dev",
        key: "replay-a",
        body: "",
      },
      {
        method: "PUT",
        path: `${base}/webhook-subscriptions/${project}/activations/1`,
        query: "?environment=dev",
        key: "sub-a",
        body: JSON.stringify(request),
      },
      {
        method: "GET",
        path: `${base}/webhook-subscriptions/${project}`,
        query: "?environment=dev",
        key: null,
        body: "",
      },
      {
        method: "DELETE",
        path: `${base}/webhook-subscriptions/${project}/activations/1`,
        query: "?environment=dev",
        key: "sub-off",
        body: "",
      },
    ]);
  });

  it("refuses webhook answers that name another environment, webhook or delivery", async () => {
    const otherWebhook = "whk_zyxwvutsrqponmlkjihg";
    const otherDelivery = "dlv_fedcba9876543210fedc";
    const answers: Response[] = [];
    const answer = (body: unknown, status = 200) => answers.push(Response.json(body, { status }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error("Unexpected webhook request");
      return next;
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    answer({ ...row, secret: "whsec_fixture" }, 201);
    await expect(
      api.createProjectDatabaseWebhook({
        projectId: project,
        environment: "prod",
        idempotencyKey: "hook-a",
        url: row.url,
        eventTypes: ["database.ready"],
        headers: {},
      }),
    ).rejects.toThrow(TypeError);
    answer({ items: [{ ...row, environment: "prod" }] });
    await expect(
      api.listProjectDatabaseWebhooks({ projectId: project, environment: "dev" }),
    ).rejects.toThrow(TypeError);
    answer({ ...row, id: otherWebhook });
    await expect(
      api.getProjectDatabaseWebhook({ projectId: project, environment: "dev", webhookId: webhook }),
    ).rejects.toThrow(TypeError);
    answer({ ...row, environment: "prod" });
    await expect(
      api.getProjectDatabaseWebhook({ projectId: project, environment: "dev", webhookId: webhook }),
    ).rejects.toThrow(TypeError);
    answer({ id: otherWebhook, deleted: true });
    await expect(
      api.deleteProjectDatabaseWebhook({
        projectId: project,
        environment: "dev",
        webhookId: webhook,
      }),
    ).rejects.toThrow(TypeError);
    answer({ items: [{ ...deliveryRow, webhook_id: otherWebhook }], next_cursor: null });
    await expect(
      api.listProjectDatabaseWebhookDeliveries({
        projectId: project,
        environment: "dev",
        webhookId: webhook,
      }),
    ).rejects.toThrow(TypeError);
    answer({ delivery_id: otherDelivery, state: "pending" }, 202);
    await expect(
      api.replayProjectDatabaseWebhookDelivery({
        projectId: project,
        environment: "dev",
        deliveryId: delivery,
      }),
    ).rejects.toThrow(TypeError);
    const subscriptionScope = {
      projectId: project,
      environment: "dev" as const,
      subscriptionId: project,
    };
    const subscription = {
      id: project,
      environment: "dev",
      generation: 1,
      state: "active",
      provider_id: webhook,
    };
    answer({ ...subscription, environment: "prod" });
    await expect(api.getDatabaseWebhookSubscription(subscriptionScope)).rejects.toThrow(TypeError);
    answer({ ...subscription, secret: "unexpected-secret" });
    await expect(api.getDatabaseWebhookSubscription(subscriptionScope)).rejects.toThrow(TypeError);
    answer({ ...subscription, generation: 2, secret: "whsec_fixture_secret" });
    await expect(
      api.activateDatabaseWebhookSubscription({
        ...subscriptionScope,
        generation: 1,
        idempotencyKey: "sub-a",
        request: { url: row.url, event_types: ["database.ready"], headers: {} },
      }),
    ).rejects.toThrow(TypeError);
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("rejects a webhook list whose items carry the signing secret", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ items: [{ ...row, secret: "whsec_fixture" }] }),
    );
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.listProjectDatabaseWebhooks({ projectId: project, environment: "dev" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("generated SDK database schedule API", () => {
  const project = "01K2F3G4H5J6K7M8N9P0QRSTVW";
  const schedule = {
    name: "tick",
    environment: "dev" as const,
    cron: null,
    every_seconds: 60,
    statements: ["UPDATE ticks SET n = n + 1"],
    timeout_ms: 10_000,
    enabled: true,
    next_run_at: "2026-10-31T10:01:00.000Z",
    created_at: "2026-10-31T10:00:00.000Z",
  };
  const run = {
    id: 7,
    schedule: "tick",
    scheduled_at: "2026-10-31T10:01:00.000Z",
    started_at: "2026-10-31T10:01:00.100Z",
    finished_at: "2026-10-31T10:01:00.150Z",
    outcome: "succeeded" as const,
    sqlstate: null,
    attempts: 1,
    manual: false,
  };
  const usageRow = {
    start: "2026-10-30T00:00:00.000Z",
    end: "2026-10-30T01:00:00.000Z",
    final: true,
    metrics: {
      schedule_runs_succeeded: 60,
      schedule_runs_failed: 0,
      schedule_runs_timed_out: 0,
      schedule_runs_outcome_unknown: 0,
      schedule_runs_rejected: 0,
      schedule_runs_skipped: 0,
      events_emitted: 0,
      event_bytes: 0,
      webhook_attempts: 0,
      webhook_deliveries_delivered: 0,
      webhook_deliveries_dead_lettered: 0,
    },
  };
  const request = {
    cron: null,
    every_seconds: 60,
    statements: ["UPDATE ticks SET n = n + 1"],
    timeout_ms: 10_000,
    enabled: true,
  };

  it("sends schedule requests through the generated SDK with every field the caller set", async () => {
    const name = "nightly_cleanup";
    const statements = ["UPDATE ticks SET n = n + 1", "DELETE FROM ticks WHERE n > 100"];
    const answered = {
      ...schedule,
      name,
      environment: "prod" as const,
      statements,
      timeout_ms: 5_000,
      enabled: false,
    };
    const calls: {
      method: string;
      path: string;
      params: Record<string, string>;
      body: string;
    }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const sent = new Request(input, init);
      const url = new URL(sent.url);
      calls.push({
        method: sent.method,
        path: url.pathname,
        params: Object.fromEntries(url.searchParams),
        body: await sent.text(),
      });
      if (url.pathname.endsWith("/execution-usage"))
        return Response.json({ items: [usageRow], next_cursor: "next-a" });
      if (url.pathname.endsWith("/runs"))
        return Response.json({ items: [{ ...run, schedule: name }] });
      if (url.pathname.endsWith("/run"))
        return Response.json({ schedule: name, state: "queued" }, { status: 202 });
      if (url.pathname.endsWith("/schedules") && sent.method === "GET")
        return Response.json({ items: [answered] });
      if (sent.method === "DELETE") return Response.json({ name, deleted: true });
      return Response.json(answered);
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.setProjectDatabaseSchedule({
        projectId: project,
        environment: "prod",
        name,
        request: {
          cron: null,
          every_seconds: 60,
          statements,
          timeout_ms: 5_000,
          enabled: false,
        },
      }),
    ).resolves.toEqual(answered);
    await expect(
      api.listProjectDatabaseSchedules({ projectId: project, environment: "prod" }),
    ).resolves.toEqual({ items: [answered] });
    await expect(
      api.getProjectDatabaseSchedule({ projectId: project, environment: "prod", name }),
    ).resolves.toEqual(answered);
    await expect(
      api.listProjectDatabaseScheduleRuns({
        projectId: project,
        environment: "prod",
        name,
        limit: 5,
      }),
    ).resolves.toEqual({ items: [{ ...run, schedule: name }] });
    await expect(
      api.runProjectDatabaseSchedule({ projectId: project, environment: "prod", name }),
    ).resolves.toEqual({ schedule: name, state: "queued" });
    await expect(
      api.deleteProjectDatabaseSchedule({ projectId: project, environment: "prod", name }),
    ).resolves.toEqual({ name, deleted: true });
    await expect(
      api.getProjectDatabaseExecutionUsage({
        projectId: project,
        environment: "prod",
        from: usageRow.start,
        to: "2026-10-30T02:00:00.000Z",
        granularity: "hour",
        limit: 10,
        cursor: "cursor-a",
      }),
    ).resolves.toEqual({ items: [usageRow], next_cursor: "next-a" });

    const base = `/v1/projects/${project}/database`;
    expect(calls).toEqual([
      {
        method: "PUT",
        path: `${base}/schedules/${name}`,
        params: { environment: "prod" },
        body: JSON.stringify({
          every_seconds: 60,
          statements,
          timeout_ms: 5_000,
          enabled: false,
          confirm: true,
        }),
      },
      { method: "GET", path: `${base}/schedules`, params: { environment: "prod" }, body: "" },
      {
        method: "GET",
        path: `${base}/schedules/${name}`,
        params: { environment: "prod" },
        body: "",
      },
      {
        method: "GET",
        path: `${base}/schedules/${name}/runs`,
        params: { environment: "prod", limit: "5" },
        body: "",
      },
      {
        method: "POST",
        path: `${base}/schedules/${name}/run`,
        params: { environment: "prod" },
        body: "",
      },
      {
        method: "DELETE",
        path: `${base}/schedules/${name}`,
        params: { environment: "prod" },
        body: "",
      },
      {
        method: "GET",
        path: `${base}/execution-usage`,
        params: {
          environment: "prod",
          from: usageRow.start,
          to: "2026-10-30T02:00:00.000Z",
          granularity: "hour",
          limit: "10",
          cursor: "cursor-a",
        },
        body: "",
      },
    ]);
  });

  it("sends a cron schedule without an interval field", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const sent = new Request(input, init);
      expect(await sent.text()).toBe(
        JSON.stringify({
          cron: "*/5 * * * *",
          statements: request.statements,
          timeout_ms: 10_000,
          enabled: true,
          confirm: true,
        }),
      );
      return Response.json({ ...schedule, cron: "*/5 * * * *", every_seconds: null });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.setProjectDatabaseSchedule({
        projectId: project,
        environment: "dev",
        name: "tick",
        request: { ...request, cron: "*/5 * * * *", every_seconds: null },
      }),
    ).resolves.toMatchObject({ cron: "*/5 * * * *", every_seconds: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses schedule and usage answers that name another scope or have a malformed shape", async () => {
    const answers: Response[] = [];
    const answer = (body: unknown, status = 200) => answers.push(Response.json(body, { status }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error("Unexpected schedule request");
      return next;
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    const usageRequest = {
      projectId: project,
      environment: "dev" as const,
      from: usageRow.start,
      to: "2026-10-30T02:00:00.000Z",
      granularity: "hour" as const,
    };

    answer({ ...schedule, name: "other" });
    await expect(
      api.setProjectDatabaseSchedule({
        projectId: project,
        environment: "dev",
        name: "tick",
        request,
      }),
    ).rejects.toThrow(TypeError);
    answer({ ...schedule, environment: "prod" });
    await expect(
      api.setProjectDatabaseSchedule({
        projectId: project,
        environment: "dev",
        name: "tick",
        request,
      }),
    ).rejects.toThrow(TypeError);
    answer({ ...schedule, extra: true });
    await expect(
      api.setProjectDatabaseSchedule({
        projectId: project,
        environment: "dev",
        name: "tick",
        request,
      }),
    ).rejects.toThrow(TypeError);
    answer({ items: [{ ...schedule, environment: "prod" }] });
    await expect(
      api.listProjectDatabaseSchedules({ projectId: project, environment: "dev" }),
    ).rejects.toThrow(TypeError);
    answer({ items: "not-a-list" });
    await expect(
      api.listProjectDatabaseSchedules({ projectId: project, environment: "dev" }),
    ).rejects.toThrow(TypeError);
    answer({ ...schedule, environment: "prod" });
    await expect(
      api.getProjectDatabaseSchedule({ projectId: project, environment: "dev", name: "tick" }),
    ).rejects.toThrow(TypeError);
    answer({ ...schedule, name: "other" });
    await expect(
      api.getProjectDatabaseSchedule({ projectId: project, environment: "dev", name: "tick" }),
    ).rejects.toThrow(TypeError);
    answer({ name: "other", deleted: true });
    await expect(
      api.deleteProjectDatabaseSchedule({ projectId: project, environment: "dev", name: "tick" }),
    ).rejects.toThrow(TypeError);
    answer({ items: [{ ...run, schedule: "other" }] });
    await expect(
      api.listProjectDatabaseScheduleRuns({ projectId: project, environment: "dev", name: "tick" }),
    ).rejects.toThrow(TypeError);
    answer({ schedule: "other", state: "queued" }, 202);
    await expect(
      api.runProjectDatabaseSchedule({ projectId: project, environment: "dev", name: "tick" }),
    ).rejects.toThrow(TypeError);
    answer({
      items: [{ ...usageRow, metrics: { ...usageRow.metrics, webhook_attempts: -1 } }],
      next_cursor: null,
    });
    await expect(api.getProjectDatabaseExecutionUsage(usageRequest)).rejects.toThrow(TypeError);
    answer({
      items: [{ ...usageRow, metrics: { ...usageRow.metrics, schedule_runs_failed: null } }],
      next_cursor: null,
    });
    await expect(api.getProjectDatabaseExecutionUsage(usageRequest)).rejects.toThrow(TypeError);
    answer({ items: "not-a-list", next_cursor: null });
    await expect(api.getProjectDatabaseExecutionUsage(usageRequest)).rejects.toThrow(TypeError);
    expect(fetch).toHaveBeenCalledTimes(13);
  });
});

describe("generated SDK database table API", () => {
  const project = "01K2F3G4H5J6K7M8N9P0QRSTVW";
  const table = {
    environment: "dev" as const,
    schema: "public",
    table: "orders",
    columns: [
      { name: "id", type: "bigint", nullable: false, identity: true, default: null },
      { name: "placed_at", type: "timestamptz", nullable: true, identity: false, default: "now" },
    ],
    primary_key: ["id"],
    created: true,
  };
  const request = {
    table: "orders",
    columns: [
      { name: "id", type: "bigint" as const, nullable: false, identity: true },
      {
        name: "placed_at",
        type: "timestamptz" as const,
        nullable: true,
        identity: false,
        default: "now" as const,
      },
    ],
    primaryKey: ["id"],
  };

  it("sends the table create with the key and the scope and answers the created table", async () => {
    const calls: { path: string; key: string | null; body: unknown }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const received = new Request(input, init);
      calls.push({
        path: new URL(received.url).pathname,
        key: received.headers.get("idempotency-key"),
        body: JSON.parse(await received.text()) as unknown,
      });
      return Response.json({ table }, { status: 201 });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.createProjectDatabaseTable({
        projectId: project,
        environment: "dev",
        idempotencyKey: "table-a",
        request,
      }),
    ).resolves.toEqual({ table });
    expect(calls).toEqual([
      {
        path: `/v1/projects/${project}/database/tables`,
        key: "table-a",
        body: {
          environment: "dev",
          table: "orders",
          columns: request.columns,
          primary_key: ["id"],
        },
      },
    ]);
  });

  it("omits primary_key when none is named and refuses answers with another scope or shape", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const received = new Request(input, init);
      const body = JSON.parse(await received.text()) as { primary_key?: unknown };
      expect(body).not.toHaveProperty("primary_key");
      return Response.json({ table: { ...table, environment: "prod", primary_key: [] } });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);
    const create = {
      projectId: project,
      environment: "dev" as const,
      idempotencyKey: "table-b",
      request: { ...request, primaryKey: [] },
    };
    await expect(api.createProjectDatabaseTable(create)).rejects.toThrow(
      "Table response scope mismatch",
    );

    const extra = new GeneratedSdkProductApi(
      "https://control.example.test",
      "access-a",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ table: { ...table, extra: true } }, { status: 201 }),
      ),
    );
    await expect(extra.createProjectDatabaseTable({ ...create, request })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("generated SDK database watch API", () => {
  const project = "01K2F3G4H5J6K7M8N9P0QRSTVW";
  const watch = "pgcf_watch_0a1b2c3d";
  const row = {
    id: watch,
    environment: "dev" as const,
    schema: "public",
    table: "orders",
    columns: ["id", "total"],
    operations: ["insert", "update", "delete"] as const,
    topic: "orders",
    event_type: "data.orders" as const,
  };
  const request = {
    schema: "public",
    table: "orders",
    columns: ["id", "total"],
    operations: ["insert", "update", "delete"] as const,
  };

  it("sends watch create, list and delete through the generated SDK with the key and the scope", async () => {
    const calls: {
      method: string;
      path: string;
      query: string;
      key: string | null;
      body: string;
    }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const received = new Request(input, init);
      const url = new URL(received.url);
      calls.push({
        method: received.method,
        path: url.pathname,
        query: url.search,
        key: received.headers.get("idempotency-key"),
        body: await received.text(),
      });
      if (received.method === "POST") return Response.json(row, { status: 201 });
      if (received.method === "DELETE") return Response.json({ id: watch, deleted: true });
      return Response.json({ items: [row] });
    });
    const api = new GeneratedSdkProductApi("https://control.example.test", "access-a", fetch);

    await expect(
      api.createProjectDatabaseWatch({
        projectId: project,
        environment: "dev",
        idempotencyKey: "watch-a",
        request,
      }),
    ).resolves.toEqual(row);
    await expect(
      api.listProjectDatabaseWatches({ projectId: project, environment: "dev" }),
    ).resolves.toEqual({ items: [row] });
    await expect(
      api.deleteProjectDatabaseWatch({
        projectId: project,
        environment: "prod",
        idempotencyKey: "watch-b",
        watchId: watch,
      }),
    ).resolves.toEqual({ id: watch, deleted: true });

    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/projects/${project}/database/watches`,
        query: "",
        key: "watch-a",
        body: JSON.stringify({ environment: "dev", ...request }),
      },
      {
        method: "GET",
        path: `/v1/projects/${project}/database/watches`,
        query: "?environment=dev",
        key: null,
        body: "",
      },
      {
        method: "DELETE",
        path: `/v1/projects/${project}/database/watches/${watch}`,
        query: "?environment=prod",
        key: "watch-b",
        body: "",
      },
    ]);
  });

  it("refuses watch answers that name another environment, table, schema or id, or carry an extra key", async () => {
    const answer = (body: unknown) =>
      new GeneratedSdkProductApi(
        "https://control.example.test",
        "access-a",
        vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status: 201 })),
      );
    const create = (api: GeneratedSdkProductApi) =>
      api.createProjectDatabaseWatch({
        projectId: project,
        environment: "dev",
        idempotencyKey: "watch-a",
        request,
      });
    await expect(create(answer({ ...row, environment: "prod" }))).rejects.toThrow(
      "Watch response scope mismatch",
    );
    await expect(
      create(
        answer({
          ...row,
          table: "invoices",
          topic: "invoices",
          event_type: "data.invoices",
        }),
      ),
    ).rejects.toThrow("Watch response scope mismatch");
    await expect(create(answer({ ...row, schema: "sales" }))).rejects.toThrow(
      "Watch response scope mismatch",
    );
    await expect(create(answer({ ...row, secret: "whsec_fixture" }))).rejects.toThrow(TypeError);

    const deleted = new GeneratedSdkProductApi(
      "https://control.example.test",
      "access-a",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ id: "pgcf_watch_ffffffff", deleted: true }),
      ),
    );
    await expect(
      deleted.deleteProjectDatabaseWatch({
        projectId: project,
        environment: "dev",
        idempotencyKey: "watch-b",
        watchId: watch,
      }),
    ).rejects.toThrow("Watch response scope mismatch");
  });

  it("refuses list answers that name another environment or carry an extra key on an item", async () => {
    const list = (body: unknown) =>
      new GeneratedSdkProductApi(
        "https://control.example.test",
        "access-a",
        vi.fn<typeof globalThis.fetch>(async () => Response.json(body)),
      ).listProjectDatabaseWatches({ projectId: project, environment: "dev" });
    await expect(list({ items: [{ ...row, environment: "prod" }] })).rejects.toThrow(
      "Watch response scope mismatch",
    );
    await expect(list({ items: [{ ...row, secret: "whsec_fixture" }] })).rejects.toThrow(TypeError);
  });
});

it("uses the generated SDK for protected connection consent and rejects a forged handoff URL", async () => {
  const org = "01K00000000000000000000001",
    project = "01K00000000000000000000002",
    environment = "01K00000000000000000000003";
  let forged = true;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(`https://dev.app.ohmyho.st/v1/organizations/${org}/connections/begin`);
    expect(request.headers.get("authorization")).toBe("Bearer saved-session");
    expect(await request.json()).toEqual({
      provider: "make",
      project_id: project,
      environment_id: environment,
    });
    return Response.json(
      {
        request_id: "a".repeat(64),
        url: forged
          ? "https://attacker.example/"
          : `https://dev.app.ohmyho.st/connections/authorize?request=${"b".repeat(43)}`,
        expires_at: "2030-01-01T00:00:00Z",
      },
      { status: 201 },
    );
  });
  const api = new GeneratedSdkProductApi("https://dev.app.ohmyho.st", "saved-session", fetch);
  await expect(
    api.connection({
      kind: "connection-begin",
      organizationId: org,
      projectId: project,
      environmentId: environment,
      idempotencyKey: "one",
      credentialStore: "native",
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  forged = false;
  await expect(
    api.connection({
      kind: "connection-begin",
      organizationId: org,
      projectId: project,
      environmentId: environment,
      idempotencyKey: "one",
      credentialStore: "native",
    }),
  ).resolves.toMatchObject({ request_id: "a".repeat(64) });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("uses workspace-scoped Make consent, listing and explicit project import", async () => {
  const org = "01K00000000000000000000001",
    project = "01K00000000000000000000002",
    environment = "01K00000000000000000000003";
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: request.body ? await request.json() : null });
    if (request.url.endsWith("/begin"))
      return Response.json(
        {
          request_id: "a".repeat(64),
          url: `https://dev.app.ohmyho.st/connections/authorize?request=${"b".repeat(43)}`,
          expires_at: "2030-01-01T00:00:00Z",
        },
        { status: 201 },
      );
    if (request.method === "GET") return Response.json({ connections: [] });
    return Response.json(
      {
        id: project,
        grant_id: project,
        project_id: project,
        environment_id: environment,
        provider_organization_id: 1,
        team_id: 2,
        connection_id: 3,
      },
      { status: 201 },
    );
  });
  const api = new GeneratedSdkProductApi("https://dev.app.ohmyho.st", "saved-session", fetch);
  await api.connection({
    kind: "connection-begin",
    organizationId: org,
    idempotencyKey: "one",
    credentialStore: "native",
  });
  await api.connection({ kind: "connection-list", organizationId: org, credentialStore: "native" });
  await api.connection({
    kind: "connection-import",
    organizationId: org,
    grantId: project,
    projectId: project,
    environmentId: environment,
    providerOrganizationId: 1,
    teamId: 2,
    connectionId: 3,
    idempotencyKey: "two",
    credentialStore: "native",
  });
  expect(requests[0]?.body).toEqual({ provider: "make" });
  expect(requests[1]?.url).toContain("?scope=workspace");
  expect(requests[2]).toEqual({
    url: `https://dev.app.ohmyho.st/v1/organizations/${org}/connections/${project}/imports`,
    body: {
      project_id: project,
      environment_id: environment,
      provider_organization_id: 1,
      team_id: 2,
      connection_id: 3,
    },
  });
});
