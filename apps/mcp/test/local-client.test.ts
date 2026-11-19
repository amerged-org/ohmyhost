import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { ProfileRegistry } from "@ohmyhost/product-cli";
import { login, memoryProfiles } from "../../product-cli/test/memory-profiles.js";

import type {
  CurrentIdentity,
  DeleteEnvironmentSecretResult,
  Deployment,
  DeploymentPage,
  DeploymentPlan,
  GuardedActionPlan,
  EnvironmentSecretPage,
  Operation,
  OperationEvent,
  Project,
  ProjectPage,
  ProjectSource,
  ProjectStatus,
  ProviderReconciliationAttempt,
} from "@ohmyhost/sdk-ts";

import {
  GeneratedSdkLocalMcpClient,
  createAuthenticatedLocalMcpClient,
} from "../src/local-client.js";

async function authenticationHttpFixture() {
  const calls: { url: string; authorization: string | null; body: string }[] = [];
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {
      void chunk;
    }
    response.setHeader("content-type", "application/json");
    const jwt = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from('{"exp":4102444800}').toString("base64url")}.YQ`;
    response.end(
      JSON.stringify(
        request.url === "/user_management/authenticate"
          ? { access_token: jwt, refresh_token: "refreshed-user-token" }
          : identity,
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test HTTP address");
  return {
    calls,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect([
        "https://api.workos.com",
        "https://dev.app.ohmyho.st",
        "https://app.ohmyho.st",
      ]).toContain(url.origin);
      const body = request.method === "GET" ? "" : await request.clone().text();
      calls.push({ url: request.url, authorization: request.headers.get("authorization"), body });
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(body ? { body } : {}),
      });
    }) as typeof globalThis.fetch,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("GeneratedSdkLocalMcpClient", () => {
  it("uses an environment user key without native credentials and rejects malformed keys without leaking them", async () => {
    const fixture = await authenticationHttpFixture();
    const token = `sk_${"c".repeat(46)}`;
    const unusedProfiles: ProfileRegistry = {
      list: async () => {
        throw new Error("Unexpected saved-login read");
      },
      credential: () => {
        throw new Error("Unexpected native read");
      },
      legacy: () => {
        throw new Error("Unexpected legacy read");
      },
      save: async () => {
        throw new Error("Unexpected native replacement");
      },
      remove: async () => {
        throw new Error("Unexpected native deletion");
      },
    };
    try {
      const client = await createAuthenticatedLocalMcpClient(new AbortController().signal, {
        environment: { OHMYHOST_TOKEN: token },
        profiles: unusedProfiles,
        fetch: fixture.fetch,
      });
      expect(await client.getCurrentIdentity(new AbortController().signal)).toEqual({
        ...identity,
        context: { credential: "environment_token", profile: null },
      });
      expect(fixture.calls).toEqual([
        { url: "https://app.ohmyho.st/v1/me", authorization: `Bearer ${token}`, body: "" },
      ]);
      await expect(
        createAuthenticatedLocalMcpClient(new AbortController().signal, {
          environment: { OHMYHOST_TOKEN: "invalid-secret-value" },
          profiles: unusedProfiles,
          fetch: fixture.fetch,
        }),
      ).rejects.toMatchObject({
        name: "ProductApiAuthenticationError",
        code: "invalid_environment_token",
      });
      expect(fixture.calls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("uses the shared declared Dev and Prod API origins instead of the retired sandbox", async () => {
    const fixture = await authenticationHttpFixture();
    try {
      const credential = {
        accessToken: "customer-access",
        refreshToken: "customer-refresh",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      const customer = login("customer", "user_01M0CUSTOMER", identity.organization_ids[0] ?? null);
      for (const environment of ["development", "production"]) {
        const saved = await memoryProfiles([{ profile: customer, credential }]);
        const client = await createAuthenticatedLocalMcpClient(new AbortController().signal, {
          environment: { OHMYHOST_ENVIRONMENT: environment },
          fetch: fixture.fetch,
          profiles: saved.registry,
        });
        expect(await client.getCurrentIdentity(new AbortController().signal)).toEqual({
          ...identity,
          context: {
            credential: "profile",
            profile: {
              name: "customer",
              user_id: "user_01M0CUSTOMER",
              organization_id: identity.organization_ids[0],
              organization_name: "customer",
            },
          },
        });
        expect(saved.writes).toEqual([]);
      }
      expect(fixture.calls.map((call) => call.url)).toEqual([
        "https://dev.app.ohmyho.st/v1/me",
        "https://app.ohmyho.st/v1/me",
      ]);
      expect(fixture.calls.every((call) => call.authorization === "Bearer customer-access")).toBe(
        true,
      );
    } finally {
      await fixture.close();
    }
  });

  it("renews the selected native-session abstraction before the MCP product call", async () => {
    const fixture = await authenticationHttpFixture();
    const customer = login("customer", "user_01M0CUSTOMER", null);
    const saved = await memoryProfiles([
      {
        profile: customer,
        credential: {
          accessToken: "expired",
          refreshToken: "old-refresh",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    try {
      const client = await createAuthenticatedLocalMcpClient(new AbortController().signal, {
        environment: { OHMYHOST_ENVIRONMENT: "production" },
        profiles: saved.registry,
        fetch: fixture.fetch,
      });
      const stored = await saved.credential(customer);
      expect(stored?.refreshToken).toBe("refreshed-user-token");
      expect(await client.getCurrentIdentity(new AbortController().signal)).toMatchObject(identity);
      expect(fixture.calls).toHaveLength(2);
      const form = new URLSearchParams(fixture.calls[0]?.body);
      expect(form.get("client_id")).toBe("client_00000000000000000000000018");
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(fixture.calls[0]?.authorization).toBeNull();
      expect(fixture.calls[1]?.authorization).toBe(`Bearer ${String(stored?.accessToken)}`);
    } finally {
      await fixture.close();
    }
  });

  it("gives an explicit cold-start login handoff and rejects unknown profiles before credential access", async () => {
    const saved = await memoryProfiles();
    await expect(
      createAuthenticatedLocalMcpClient(new AbortController().signal, {
        environment: { OHMYHOST_ENVIRONMENT: "production" },
        profiles: saved.registry,
      }),
    ).rejects.toThrow("OHMYHOST_ENVIRONMENT=production ohmyhost login");
    await expect(
      createAuthenticatedLocalMcpClient(new AbortController().signal, {
        environment: { OHMYHOST_ENVIRONMENT: "https://attacker.example" },
        profiles: saved.registry,
      }),
    ).rejects.toThrow("invalid_environment");
    expect(saved.writes).toEqual([]);
  });

  it("disconnects workspace GitHub through the generated DELETE and refuses an answer that stays connected", async () => {
    const organizationId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
    const connection = {
      connection_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      organization_id: organizationId,
      installation_id: "42",
      account_id: "7",
      account_login: "owner",
      account_type: "User",
      github_user_id: "7",
      github_user_login: "owner",
      connected_at: "2026-08-18T00:00:00.000Z",
      revoked_at: null,
      settings_url: "https://github.com/settings/installations/42",
    };
    let reply: unknown = {
      status: "revoked",
      connection: { ...connection, revoked_at: "2026-08-19T00:00:00.000Z" },
    };
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(reply);
    });
    const client = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      fetch,
    );
    await expect(client.disconnectGithub(organizationId)).resolves.toMatchObject({
      status: "revoked",
    });
    expect(requests[0]?.method).toBe("DELETE");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      `/v1/organizations/${organizationId}/github`,
    );
    // An answer that still reports a live connection is not a disconnect and is refused.
    reply = { status: "connected", connection };
    await expect(client.disconnectGithub(organizationId)).rejects.toThrow(
      "The server response does not match the public contract.",
    );
  });

  it("maps a database table create to the generated REST SDK and refuses an answer for another table", async () => {
    const table = {
      environment: "dev" as const,
      schema: "public",
      table: "orders",
      columns: [{ name: "id", type: "bigint", nullable: false, identity: true, default: null }],
      primary_key: ["id"],
      created: true,
    };
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = (await request.clone().json()) as { table: string };
      return Response.json(
        { table: { ...table, table: body.table === "orders" ? "orders" : "other" } },
        { status: 201 },
      );
    });
    const client = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      fetch,
    );
    const create = {
      projectId: project.id,
      environment: "dev" as const,
      table: "orders",
      columns: [{ name: "id", type: "bigint" as const, identity: true }],
      idempotencyKey: "table-create-1",
    };
    await expect(client.createDatabaseTable(create)).resolves.toEqual({ table });
    expect(requests[0]?.headers.get("idempotency-key")).toBe("table-create-1");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      `/v1/projects/${project.id}/database/tables`,
    );
    expect(await requests[0]?.json()).toEqual({
      environment: "dev",
      table: "orders",
      columns: [{ name: "id", type: "bigint", identity: true }],
    });
    await expect(client.createDatabaseTable({ ...create, table: "invoices" })).rejects.toThrow(
      "Database event scope mismatch",
    );
  });

  it("maps database watch operations to the generated REST SDK with the key and the exact scope", async () => {
    const { client, requests } = databaseEventClient();
    const projectId = project.id;

    await expect(
      client.createDatabaseWatch({
        projectId,
        environment: "dev",
        table: "orders",
        columns: ["id", "total"],
        idempotencyKey: "watch-create-1",
      }),
    ).resolves.toEqual(databaseWatch);
    await expect(client.listDatabaseWatches({ projectId })).resolves.toEqual({
      items: [databaseWatch],
    });
    await expect(
      client.deleteDatabaseWatch({
        projectId,
        environment: "dev",
        watchId: databaseWatch.id,
        idempotencyKey: "watch-delete-1",
      }),
    ).resolves.toEqual({ id: databaseWatch.id, deleted: true });

    const base = `/v1/projects/${projectId}/database`;
    expect(
      requests.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname.replace(base, "")}${url.search}`;
      }),
    ).toEqual([
      "POST /watches",
      "GET /watches?environment=dev",
      `DELETE /watches/${databaseWatch.id}?environment=dev`,
    ]);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("watch-create-1");
    expect(requests[2]?.headers.get("idempotency-key")).toBe("watch-delete-1");
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer customer-access-token",
      ),
    ).toBe(true);
    // Optional fields the caller did not set are not sent, so the service applies its defaults.
    expect(await requests[0]?.json()).toEqual({
      environment: "dev",
      table: "orders",
      columns: ["id", "total"],
    });
  });

  it("forwards the optional schema and operations of a watch and refuses an answer that names another schema", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = (await request.clone().json()) as {
        schema?: string;
        operations?: string[];
      };
      return Response.json(
        {
          ...databaseWatch,
          schema: body.schema ?? "public",
          operations: body.operations ?? databaseWatch.operations,
        },
        { status: 201 },
      );
    });
    const client = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      fetch,
    );
    await expect(
      client.createDatabaseWatch({
        projectId: project.id,
        environment: "dev",
        schema: "sales",
        table: "orders",
        columns: ["id", "total"],
        operations: ["delete"],
        idempotencyKey: "watch-create-4",
      }),
    ).resolves.toMatchObject({ schema: "sales", operations: ["delete"] });
    expect(await requests[0]?.json()).toEqual({
      environment: "dev",
      schema: "sales",
      table: "orders",
      columns: ["id", "total"],
      operations: ["delete"],
    });
    await expect(
      databaseEventClient("schema").client.createDatabaseWatch({
        projectId: project.id,
        environment: "dev",
        table: "orders",
        columns: ["id"],
        idempotencyKey: "watch-create-5",
      }),
    ).rejects.toThrow("Database event scope mismatch");
  });

  it("refuses watch answers that name another environment, table or id", async () => {
    const create = {
      projectId: project.id,
      environment: "dev" as const,
      table: "orders",
      columns: ["id"],
      idempotencyKey: "watch-create-2",
    };
    await expect(
      databaseEventClient("environment").client.createDatabaseWatch(create),
    ).rejects.toThrow("Database event scope mismatch");
    await expect(databaseEventClient("table").client.createDatabaseWatch(create)).rejects.toThrow(
      "Database event scope mismatch",
    );
    await expect(
      databaseEventClient("environment").client.listDatabaseWatches({ projectId: project.id }),
    ).rejects.toThrow("Database event scope mismatch");
    await expect(
      databaseEventClient("identity").client.deleteDatabaseWatch({
        projectId: project.id,
        environment: "dev",
        watchId: databaseWatch.id,
        idempotencyKey: "watch-delete-2",
      }),
    ).rejects.toThrow("Database event scope mismatch");
  });

  it("sends the caller's idempotency key on each retried database event operation and a fresh key by default", async () => {
    const { client, requests } = databaseEventClient();
    const projectId = project.id;
    const webhookId = databaseWebhook.id;
    const deliveryId = databaseDelivery.id;
    const scheduleName = databaseSchedule.name;

    await client.deleteDatabaseWebhook({
      projectId,
      environment: "dev",
      webhookId,
      idempotencyKey: "delete-key-1",
    });
    await client.testDatabaseWebhook({ projectId, environment: "dev", webhookId });
    await client.replayDatabaseWebhookDelivery({
      projectId,
      environment: "dev",
      deliveryId,
      idempotencyKey: "replay-key-1",
    });
    await client.runDatabaseSchedule({ projectId, environment: "dev", name: scheduleName });
    expect(requests.map((request) => request.headers.get("idempotency-key"))).toEqual([
      "delete-key-1",
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      "replay-key-1",
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ]);
  });

  it("maps database webhook, schedule and usage operations to the generated REST SDK", async () => {
    const { client, requests } = databaseEventClient();
    const projectId = project.id;
    const webhookId = databaseWebhook.id;
    const deliveryId = databaseDelivery.id;
    const scheduleName = databaseSchedule.name;

    await expect(client.listDatabaseWebhooks({ projectId, environment: "dev" })).resolves.toEqual({
      items: [databaseWebhook],
    });
    await expect(
      client.createDatabaseWebhook({
        projectId,
        environment: "dev",
        url: databaseWebhook.url,
        eventTypes: ["database.woke"],
        headers: { "x-tenant": "acme" },
        idempotencyKey: "webhook-create-1",
      }),
    ).resolves.toEqual(databaseWebhookCreated);
    await expect(
      client.testDatabaseWebhook({ projectId, environment: "dev", webhookId }),
    ).resolves.toEqual(databaseWebhookTest);
    await expect(
      client.deleteDatabaseWebhook({ projectId, environment: "dev", webhookId }),
    ).resolves.toEqual({ id: webhookId, deleted: true });
    await expect(
      client.listDatabaseWebhookDeliveries({
        projectId,
        environment: "dev",
        webhookId,
        limit: 10,
        cursor: "cursor-1",
      }),
    ).resolves.toEqual({ items: [databaseDelivery], next_cursor: null });
    await expect(
      client.replayDatabaseWebhookDelivery({ projectId, environment: "dev", deliveryId }),
    ).resolves.toEqual({ delivery_id: deliveryId, state: "pending" });
    const subscription = { projectId, environment: "dev" as const, subscriptionId: operation.id };
    const { mkdtemp, readFile, writeFile, chmod, symlink, stat, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const outputDirectory = await mkdtemp(join(tmpdir(), "omh-mcp-webhook-"));
    const outputPath = join(outputDirectory, "subscription.secret");
    const headersFile = join(outputDirectory, "receiver-headers.json");
    const privateHeader = "Bearer private-fixture-header";
    await writeFile(headersFile, JSON.stringify({ authorization: privateHeader }), { mode: 0o600 });
    const activation = await client.activateDatabaseWebhookSubscription({
      ...subscription,
      generation: 1,
      idempotencyKey: "sub-a",
      outputPath,
      url: databaseWebhook.url,
      eventTypes: ["database.woke"],
      headersFile,
    });
    expect(activation).toMatchObject({ state: "active", secret_file: outputPath });
    expect(JSON.stringify(activation)).not.toContain("whsec_fixture_secret");
    expect(JSON.stringify(activation)).not.toContain(privateHeader);
    const sentActivation = requests.at(-1);
    await expect(sentActivation?.clone().json()).resolves.toMatchObject({
      headers: { authorization: privateHeader },
    });
    expect(await readFile(outputPath, "utf8")).toBe("whsec_fixture_secret");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    const requestsBeforeExisting = requests.length;
    await expect(
      client.activateDatabaseWebhookSubscription({
        ...subscription,
        generation: 1,
        idempotencyKey: "sub-a",
        outputPath,
        url: databaseWebhook.url,
        eventTypes: ["database.woke"],
        headersFile,
      }),
    ).rejects.toMatchObject({ code: "private_output_invalid" });
    expect(requests).toHaveLength(requestsBeforeExisting);
    expect(await readFile(outputPath, "utf8")).toBe("whsec_fixture_secret");
    const linkedHeaders = join(outputDirectory, "linked-headers.json");
    await symlink(headersFile, linkedHeaders);
    const publicHeaders = join(outputDirectory, "public-headers.json");
    await writeFile(publicHeaders, JSON.stringify({ authorization: privateHeader }), {
      mode: 0o600,
    });
    await chmod(publicHeaders, 0o644);
    for (const invalid of [
      "relative.json",
      join(outputDirectory, "missing.json"),
      linkedHeaders,
      publicHeaders,
    ]) {
      await expect(
        client.activateDatabaseWebhookSubscription({
          ...subscription,
          generation: 1,
          idempotencyKey: "sub-a",
          outputPath: join(outputDirectory, "unused.secret"),
          url: databaseWebhook.url,
          eventTypes: ["database.woke"],
          headersFile: invalid,
        }),
      ).rejects.toMatchObject({ code: "headers_file_invalid" });
      expect(requests).toHaveLength(requestsBeforeExisting);
    }
    await rm(outputDirectory, { recursive: true, force: true });
    await expect(client.getDatabaseWebhookSubscription(subscription)).resolves.toMatchObject({
      state: "active",
      id: operation.id,
    });
    await expect(
      client.deactivateDatabaseWebhookSubscription({
        ...subscription,
        generation: 1,
        idempotencyKey: "sub-off",
      }),
    ).resolves.toMatchObject({ state: "inactive" });
    await expect(client.listDatabaseSchedules({ projectId })).resolves.toEqual({
      items: [databaseSchedule],
    });
    await expect(
      client.setDatabaseSchedule({
        projectId,
        environment: "dev",
        name: scheduleName,
        everySeconds: 3600,
        statements: ["DELETE FROM sessions WHERE expires_at < now()"],
        enabled: true,
      }),
    ).resolves.toEqual(databaseSchedule);
    await expect(
      client.deleteDatabaseSchedule({ projectId, environment: "dev", name: scheduleName }),
    ).resolves.toEqual({ name: scheduleName, deleted: true });
    await expect(
      client.listDatabaseScheduleRuns({
        projectId,
        environment: "dev",
        name: scheduleName,
        limit: 5,
      }),
    ).resolves.toEqual({ items: [databaseRun] });
    await expect(
      client.runDatabaseSchedule({ projectId, environment: "dev", name: scheduleName }),
    ).resolves.toEqual({ schedule: scheduleName, state: "queued" });
    await expect(
      client.getDatabaseExecutionUsage({
        projectId,
        environment: "dev",
        from: "2026-10-31T10:00:00.000Z",
        to: "2026-10-31T12:00:00.000Z",
        granularity: "hour",
        limit: 2,
      }),
    ).resolves.toEqual({ items: [databaseUsageRow], next_cursor: null });

    const base = `/v1/projects/${projectId}/database`;
    expect(
      requests.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname.replace(base, "")}${url.search}`;
      }),
    ).toEqual([
      "GET /webhooks?environment=dev",
      "POST /webhooks?environment=dev",
      `POST /webhooks/${webhookId}/test?environment=dev`,
      `DELETE /webhooks/${webhookId}?environment=dev`,
      `GET /webhook-deliveries?environment=dev&webhook_id=${webhookId}&limit=10&cursor=cursor-1`,
      `POST /webhook-deliveries/${deliveryId}/replay?environment=dev`,
      `PUT /webhook-subscriptions/${operation.id}/activations/1?environment=dev`,
      `GET /webhook-subscriptions/${operation.id}?environment=dev`,
      `DELETE /webhook-subscriptions/${operation.id}/activations/1?environment=dev`,
      "GET /schedules?environment=dev",
      `PUT /schedules/${scheduleName}?environment=dev`,
      `DELETE /schedules/${scheduleName}?environment=dev`,
      `GET /schedules/${scheduleName}/runs?environment=dev&limit=5`,
      `POST /schedules/${scheduleName}/run?environment=dev`,
      "GET /execution-usage?environment=dev&from=2026-10-31T10%3A00%3A00.000Z&to=2026-10-31T12%3A00%3A00.000Z&granularity=hour&limit=2",
    ]);
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer customer-access-token",
      ),
    ).toBe(true);
    const create = requests[1];
    const set = requests[10];
    expect(create?.headers.get("idempotency-key")).toBe("webhook-create-1");
    await expect(create?.clone().json()).resolves.toEqual({
      url: databaseWebhook.url,
      event_types: ["database.woke"],
      headers: { "x-tenant": "acme" },
    });
    await expect(set?.clone().json()).resolves.toEqual({
      every_seconds: 3600,
      statements: ["DELETE FROM sessions WHERE expires_at < now()"],
      enabled: true,
      confirm: true,
    });
    // A page for another environment than the one asked for is refused, never shown as the answer.
    await expect(client.listDatabaseWebhooks({ projectId, environment: "prod" })).rejects.toThrow(
      "Database event scope mismatch",
    );
    // Each check refuses an answer whose environment, webhook, delivery or schedule is another one.
    const scopeDirectory = await mkdtemp(join(tmpdir(), "omh-mcp-scope-"));
    const scopeCases: Array<
      [DatabaseEventDrift, (client: GeneratedSdkLocalMcpClient) => Promise<unknown>]
    > = [
      ["environment", (c) => c.listDatabaseWebhooks({ projectId, environment: "dev" })],
      [
        "environment",
        (c) =>
          c.getDatabaseWebhookSubscription({
            projectId,
            environment: "dev",
            subscriptionId: operation.id,
          }),
      ],
      [
        "identity",
        (c) =>
          c.activateDatabaseWebhookSubscription({
            projectId,
            environment: "dev",
            subscriptionId: operation.id,
            generation: 1,
            idempotencyKey: "sub-a",
            outputPath: join(scopeDirectory, "scope.secret"),
            url: databaseWebhook.url,
            eventTypes: ["database.woke"],
          }),
      ],
      [
        "identity",
        (c) =>
          c.deactivateDatabaseWebhookSubscription({
            projectId,
            environment: "dev",
            subscriptionId: operation.id,
            generation: 1,
            idempotencyKey: "sub-b",
          }),
      ],
      [
        "schema",
        (c) =>
          c.createDatabaseWatch({
            projectId,
            environment: "dev",
            table: "orders",
            columns: ["id"],
            idempotencyKey: "watch-create-3",
          }),
      ],
      [
        "environment",
        (c) =>
          c.createDatabaseWebhook({
            projectId,
            environment: "dev",
            url: databaseWebhook.url,
            eventTypes: ["database.woke"],
            headers: {},
            idempotencyKey: "webhook-create-2",
          }),
      ],
      ["identity", (c) => c.deleteDatabaseWebhook({ projectId, environment: "dev", webhookId })],
      [
        "identity",
        (c) => c.listDatabaseWebhookDeliveries({ projectId, environment: "dev", webhookId }),
      ],
      [
        "identity",
        (c) => c.replayDatabaseWebhookDelivery({ projectId, environment: "dev", deliveryId }),
      ],
      ["environment", (c) => c.listDatabaseSchedules({ projectId, environment: "dev" })],
      [
        "environment",
        (c) =>
          c.setDatabaseSchedule({
            projectId,
            environment: "dev",
            name: scheduleName,
            everySeconds: 3600,
            statements: ["DELETE FROM sessions WHERE expires_at < now()"],
          }),
      ],
      [
        "identity",
        (c) =>
          c.setDatabaseSchedule({
            projectId,
            environment: "dev",
            name: scheduleName,
            everySeconds: 3600,
            statements: ["DELETE FROM sessions WHERE expires_at < now()"],
          }),
      ],
      [
        "identity",
        (c) => c.deleteDatabaseSchedule({ projectId, environment: "dev", name: scheduleName }),
      ],
      [
        "identity",
        (c) => c.listDatabaseScheduleRuns({ projectId, environment: "dev", name: scheduleName }),
      ],
      [
        "identity",
        (c) => c.runDatabaseSchedule({ projectId, environment: "dev", name: scheduleName }),
      ],
    ];
    for (const [drift, call] of scopeCases) {
      const drifted = databaseEventClient(drift);
      await expect(call(drifted.client)).rejects.toThrow("Database event scope mismatch");
    }
    await rm(scopeDirectory, { recursive: true, force: true });

    // Reads without an environment ask for dev, and optional paging reaches the URL.
    const defaults = databaseEventClient();
    await defaults.client.listDatabaseWebhooks({ projectId });
    await defaults.client.listDatabaseWebhookDeliveries({ projectId });
    await defaults.client.listDatabaseScheduleRuns({ projectId, name: scheduleName });
    await defaults.client.getDatabaseExecutionUsage({
      projectId,
      from: "2026-10-31T10:00:00.000Z",
      to: "2026-10-31T12:00:00.000Z",
      granularity: "hour",
      cursor: "usage-cursor-1",
    });
    expect(defaults.requests.map(routeOf)).toEqual([
      "GET /webhooks?environment=dev",
      "GET /webhook-deliveries?environment=dev",
      `GET /schedules/${scheduleName}/runs?environment=dev`,
      "GET /execution-usage?environment=dev&from=2026-10-31T10%3A00%3A00.000Z&to=2026-10-31T12%3A00%3A00.000Z&granularity=hour&cursor=usage-cursor-1",
    ]);

    // Cadence, timeout and enabled reach the schedule body; the answer names the cron cadence.
    const cronRequests: Request[] = [];
    const cronClient = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      async (input, init) => {
        cronRequests.push(new Request(input, init));
        return Response.json(databaseCronSchedule);
      },
    );
    await expect(
      cronClient.setDatabaseSchedule({
        projectId,
        environment: "dev",
        name: scheduleName,
        cron: "*/5 * * * *",
        statements: ["DELETE FROM sessions WHERE expires_at < now()"],
        timeoutMs: 5000,
        enabled: false,
      }),
    ).resolves.toEqual(databaseCronSchedule);
    await expect(cronRequests[0]?.clone().json()).resolves.toEqual({
      cron: "*/5 * * * *",
      statements: ["DELETE FROM sessions WHERE expires_at < now()"],
      timeout_ms: 5000,
      enabled: false,
      confirm: true,
    });
  });

  it("returns available operation events within ten seconds and never hides stream errors as empty logs", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const client = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(operationEvent)}\n\n`),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const pending = client.listOperationEvents(operation.id, caller.signal, 50);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(true);
      await expect(pending).resolves.toEqual([operationEvent]);
    } finally {
      caller.abort();
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
    let requests = 0;
    const failed = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      async () => {
        requests += 1;
        return new Response(null, { status: 503 });
      },
    );
    await expect(
      failed.listOperationEvents(operation.id, new AbortController().signal, 50),
    ).rejects.toThrow("Operation events unavailable");
    expect(requests).toBe(1);
  });

  it("maps every local MCP operation to the generated REST SDK with bearer auth", async () => {
    const requests: Request[] = [];
    const eventRequestController = new AbortController();
    const abortEventRequest = () => eventRequestController.abort("test cancellation");
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/events")) {
        abortEventRequest?.();
        return new Response(`data: ${JSON.stringify(operationEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(responseFor(request), {
        status:
          new URL(request.url).pathname === `/v1/projects/${project.id}/environments/dev`
            ? 202
            : 200,
      });
    });
    const client = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "customer-access-token",
      fetch,
    );

    // A client built on a bare key names that credential as its context, never a saved login.
    await expect(client.getCurrentIdentity(new AbortController().signal)).resolves.toEqual({
      ...identity,
      context: { credential: "environment_token", profile: null },
    });
    await expect(client.listProjects({ cursor: project.id, limit: 10 })).resolves.toEqual(
      projectPage,
    );
    await expect(
      client.createProject({
        organizationId: identity.organization_ids[0] ?? "missing",
        name: project.name,
        region: "eu",
        idempotencyKey: "create-project-1",
      }),
    ).resolves.toEqual(operation);
    await expect(
      client.addProjectDevelopmentEnvironment({
        projectId: project.id,
        idempotencyKey: "add-dev-1",
      }),
    ).resolves.toEqual(operation);
    await expect(client.checkProjectHandle({ handle: "acme-shop" })).resolves.toEqual(
      handleAvailability,
    );
    await expect(
      client.changeProjectHandle({
        projectId: project.id,
        handle: "acme-shop",
        ifMatch: '"7"',
        idempotencyKey: "rename-1",
      }),
    ).resolves.toEqual(operation);
    await expect(client.getProject(project.id)).resolves.toEqual(project);
    await expect(client.getProjectStatus(project.id)).resolves.toEqual(projectStatus);
    await expect(
      client.linkSource({
        projectId: project.id,
        repositoryOwner: "aixyte",
        repositoryName: "customer-canary",
        idempotencyKey: "source-link-1",
      }),
    ).resolves.toEqual(operation);
    await expect(
      client.connectGithub({
        organizationId: project.organization_id,
        idempotencyKey: "github-connect-1",
      }),
    ).resolves.toEqual(githubAuthorization);
    await expect(client.getGithubConnection(project.organization_id)).resolves.toEqual({
      status: "not_connected",
      connection: null,
    });
    await expect(client.getSource(project.id)).resolves.toEqual(source);
    await expect(
      client.planDeployment({
        projectId: project.id,
        commitSha: deployment.commit_sha,
        environment: "dev",
      }),
    ).resolves.toEqual(deploymentPlan);
    await expect(
      client.createDeployment({
        projectId: project.id,
        planId: deploymentPlan.id,
        idempotencyKey: "deployment-create-1",
      }),
    ).resolves.toEqual(operation);
    await expect(
      client.listDeployments({ projectId: project.id, cursor: "next", limit: 20 }),
    ).resolves.toEqual(deploymentPage);
    await expect(
      client.getDeployment({ projectId: project.id, deploymentId: deployment.id }),
    ).resolves.toEqual(deployment);
    await expect(client.getOperation(operation.id)).resolves.toEqual(operation);
    await expect(
      client.changeDatabaseCompute({
        projectId: project.id,
        environment: "prod",
        memoryMiB: 512,
        idempotencyKey: "compute-1",
      }),
    ).resolves.toEqual(operation);
    await expect(
      client.changeDatabaseCompute({
        projectId: project.id,
        environment: "dev",
        profile: "performance",
        idempotencyKey: "compute-2",
      }),
    ).resolves.toEqual(operation);
    await expect(
      client.reconcileOperation({
        operationId: operation.id,
        idempotencyKey: "reconcile-1",
      }),
    ).resolves.toEqual(reconciliation);
    await expect(
      client.managedMail({
        action: "configure",
        environmentId,
        sending: true,
        receiving: false,
        projectId: project.id,
        domain: mailDomain.domain,
        idempotencyKey: "mail-domain-1",
      }),
    ).resolves.toEqual(mailDomain);
    await expect(
      client.managedMail({ action: "status", projectId: project.id, environmentId }),
    ).resolves.toEqual(mailDomain);
    await expect(
      client.listEnvironmentSecrets({ projectId: project.id, environmentId: environmentId }),
    ).resolves.toEqual(secretPage);
    await expect(
      client.listFunctionRuns({ projectId: project.id, environmentId, limit: 5 }),
    ).resolves.toEqual(functionRunPage);
    await expect(
      client.getDeploymentLogs({
        projectId: project.id,
        deploymentId: deployment.id,
        limit: 20,
        cursor: "older-diagnostics",
      }),
    ).resolves.toEqual(diagnosticPage);
    expect(new URL(requests.at(-1)?.url ?? "https://x.test").searchParams.get("cursor")).toBe(
      "older-diagnostics",
    );
    await expect(
      client.deleteEnvironmentSecret({
        projectId: project.id,
        environmentId,
        name: "GEMINI_API_KEY",
        idempotencyKey: "secret-delete-1",
      }),
    ).resolves.toEqual(secretDelete);
    await expect(
      client.planRollback({ projectId: project.id, deploymentId: deployment.id }),
    ).resolves.toEqual(rollbackPlan);
    await expect(
      client.rollback({
        projectId: project.id,
        deploymentId: deployment.id,
        ifMatch: rollbackPlan.resource_etag,
        confirmationToken: rollbackPlan.confirmation_token,
        idempotencyKey: "rollback-1",
      }),
    ).resolves.toEqual(operation);
    await expect(
      client.createDatabaseAccess({
        projectId: project.id,
        environment: "dev",
        mode: "read",
        ttlSeconds: 1_800,
        label: "laptop",
      }),
    ).resolves.toEqual(databaseCredential);
    await expect(
      client.listDatabaseAccess({ projectId: project.id, environment: "dev" }),
    ).resolves.toEqual({ items: [databaseAccess] });
    await expect(
      client.revokeDatabaseAccess({ projectId: project.id, accessId: databaseAccess.access_id }),
    ).resolves.toEqual(revokedDatabaseAccess);
    await expect(client.planDelete(project.id)).resolves.toEqual(deletePlan);
    await expect(
      client.deleteProject({
        projectId: project.id,
        ifMatch: deletePlan.resource_etag,
        confirmationToken: deletePlan.confirmation_token,
        idempotencyKey: "delete-1",
      }),
    ).resolves.toEqual(operation);

    const events = await client.listOperationEvents(operation.id, eventRequestController.signal, 1);
    expect(events).toEqual([operationEvent]);
    expect(requests).toHaveLength(34);
    const accessRequests = requests.filter((request) =>
      new URL(request.url).pathname.includes("/database/access"),
    );
    expect(
      accessRequests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toEqual([
      `POST /v1/projects/${project.id}/database/access`,
      `GET /v1/projects/${project.id}/database/access`,
      `DELETE /v1/projects/${project.id}/database/access/${databaseAccess.access_id}`,
    ]);
    expect(
      new URL(accessRequests[1]?.url ?? "https://x.test").searchParams.get("environment"),
    ).toBe("dev");
    await expect(accessRequests[0]?.clone().json()).resolves.toEqual({
      environment: "dev",
      mode: "read",
      ttl_seconds: 1_800,
      label: "laptop",
    });
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer customer-access-token",
      ),
    ).toBe(true);
    expect(
      requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toContain(`GET /v1/projects/${project.id}/deployments/${deployment.id}`);
    const githubRequest = requests.find(
      (request) =>
        new URL(request.url).pathname ===
        `/v1/organizations/${project.organization_id}/github:connect`,
    );
    expect(githubRequest?.method).toBe("POST");
    expect(githubRequest?.headers.get("idempotency-key")).toBe("github-connect-1");
    await expect(githubRequest?.clone().json()).resolves.toEqual({});
    const computeRequests = requests.filter(
      (request) => new URL(request.url).pathname === `/v1/projects/${project.id}/database/compute`,
    );
    expect(computeRequests.map((request) => request.headers.get("idempotency-key"))).toEqual([
      "compute-1",
      "compute-2",
    ]);
    await expect(
      Promise.all(computeRequests.map((request) => request.clone().json())),
    ).resolves.toEqual([
      { environment: "prod", memory_mib: 512, confirm: true },
      { environment: "dev", profile: "performance", confirm: true },
    ]);
    const reconcileRequest = requests.find(
      (request) => new URL(request.url).pathname === `/v1/operations/${operation.id}:reconcile`,
    );
    expect(reconcileRequest).toMatchObject({ method: "POST" });
    expect(reconcileRequest?.headers.get("idempotency-key")).toBe("reconcile-1");
    const mailSetRequest = requests.find(
      (request) =>
        request.method === "PUT" &&
        new URL(request.url).pathname ===
          `/v1/projects/${project.id}/environments/${environmentId}/mail-domain`,
    );
    expect(mailSetRequest?.headers.get("idempotency-key")).toBe("mail-domain-1");
    const createProjectRequest = requests.find(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/v1/projects",
    );
    await expect(createProjectRequest?.clone().json()).resolves.toEqual({
      organization_id: identity.organization_ids[0],
      name: project.name,
      region: "eu",
    });
    const addDevRequest = requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname === `/v1/projects/${project.id}/environments/dev`,
    );
    expect(addDevRequest?.headers.get("idempotency-key")).toBe("add-dev-1");
    expect(addDevRequest?.headers.get("authorization")).toBe("Bearer customer-access-token");
    await expect(addDevRequest?.clone().json()).resolves.toEqual({});
    await expect(mailSetRequest?.clone().json()).resolves.toEqual({
      domain: mailDomain.domain,
      sending: true,
      receiving: false,
    });
  });
});

const githubAuthorization = {
  authorization_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  status: "pending",
  last_failure: null,
  authorization_url: "https://github.com/apps/ohmyhost/installations/new?state=bound",
  expires_at: "2026-08-18T00:30:00.000Z",
  connection: null,
};

const handleAvailability = {
  handle: "acme-shop",
  available: false,
  reason: "taken" as const,
  alternatives: ["acme-shop-2"],
};

function responseFor(request: Request): unknown {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/v1/me") return identity;
  if (path === `/v1/organizations/${project.organization_id}/github:connect`)
    return githubAuthorization;
  if (path === `/v1/organizations/${project.organization_id}/github`)
    return { status: "not_connected", connection: null };
  if (path === "/v1/project-handles/acme-shop") return handleAvailability;
  if (path === `/v1/projects/${project.id}/handle` && request.method === "PUT") return operation;
  if (path === "/v1/projects" && request.method === "GET") return projectPage;
  if (path === `/v1/projects/${project.id}` && request.method === "GET") return project;
  if (path === `/v1/projects/${project.id}/status`) return projectStatus;
  if (path === `/v1/projects/${project.id}/source` && request.method === "GET") return source;
  if (path.endsWith("/deployments:plan")) return deploymentPlan;
  if (path === `/v1/projects/${project.id}/deployments` && request.method === "GET") {
    return deploymentPage;
  }
  if (path === `/v1/projects/${project.id}/deployments/${deployment.id}`) return deployment;
  if (path === `/v1/operations/${operation.id}:reconcile`) return reconciliation;
  if (path === `/v1/operations/${operation.id}`) return operation;
  if (path === `/v1/projects/${project.id}/environments/${environmentId}/mail-domain`)
    return mailDomain;
  if (path.endsWith("/secrets") && request.method === "GET") return secretPage;
  if (path === `/v1/projects/${project.id}/deployments/${deployment.id}/logs`) {
    if (new URL(request.url).searchParams.get("limit") !== "20") throw new Error("limit missing");
    return diagnosticPage;
  }
  if (path.endsWith("/function-runs") && request.method === "GET") {
    if (new URL(request.url).searchParams.get("limit") !== "5") throw new Error("limit missing");
    return functionRunPage;
  }
  if (path.includes("/database/access")) {
    if (request.method === "POST") return databaseCredential;
    if (request.method === "DELETE") return revokedDatabaseAccess;
    return { items: [databaseAccess] };
  }
  if (path.endsWith("/secrets/GEMINI_API_KEY")) return secretDelete;
  if (path.endsWith(":rollback-plan")) return rollbackPlan;
  if (path.endsWith(":delete-plan")) return deletePlan;
  return operation;
}

const databaseAccess = {
  provider: "pgcf" as const,
  transport: "wss" as const,
  websocket_url: "wss://pgcf.example.test/",
  access_id: "01M2K0000000000000000000A1",
  environment: "dev" as const,
  mode: "read" as const,
  role_name: "ohmyho_da_01m2k0000000000000000000d1_a1b2c3d4",
  host: "pgcf.example.test",
  database: "dbkx3m9q2w7e5r1t8y4u",
  label: "laptop",
  state: "active" as const,
  issued_at: "2026-09-15T10:00:00.000Z",
  expires_at: "2026-09-15T10:30:00.000Z",
  revoked_at: null,
  revocation_reason: null,
};
const databaseConnectionUri = `postgresql://${databaseAccess.role_name}:${"4".repeat(64)}@${databaseAccess.host}/${databaseAccess.database}?sslmode=require`;
const databaseWatch = {
  id: "pgcf_watch_0a1b2c3d",
  environment: "dev" as const,
  schema: "public",
  table: "orders",
  columns: ["id", "total"],
  operations: ["insert", "update", "delete"] as const,
  topic: "orders",
  event_type: "data.orders" as const,
};
const foreignWatchId = "pgcf_watch_ffffffff";
const databaseWebhook = {
  id: "whk_0123456789abcdefghij",
  environment: "dev" as const,
  url: "https://receiver.customer.example/hooks",
  event_types: ["database.woke"],
  header_names: ["x-tenant"],
  created_at: "2026-10-31T10:00:00.000Z",
};
const databaseWebhookCreated = { ...databaseWebhook, secret: "whsec_fixture_secret" };
const databaseWebhookTest = { delivered: true, status: 200, error: null, duration_ms: 42 };
const databaseDelivery = {
  id: "dlv_0123456789abcdef0123",
  event_id: "evt_0123456789abcdef0123",
  event_type: "database.woke",
  webhook_id: databaseWebhook.id,
  state: "pending" as const,
  attempts: 1,
  created_at: "2026-10-31T10:00:00.000Z",
  next_attempt_at: null,
  delivered_at: null,
  last_status: null,
  last_error: null,
};
const databaseSchedule = {
  name: "nightly_cleanup",
  environment: "dev" as const,
  cron: null,
  every_seconds: 3600,
  statements: ["DELETE FROM sessions WHERE expires_at < now()"],
  timeout_ms: 10_000,
  enabled: true,
  next_run_at: "2026-10-31T11:00:00.000Z",
  created_at: "2026-10-31T10:00:00.000Z",
};
const databaseRun = {
  id: 7,
  schedule: databaseSchedule.name,
  scheduled_at: "2026-10-31T10:00:00.000Z",
  started_at: "2026-10-31T10:00:01.000Z",
  finished_at: "2026-10-31T10:00:02.000Z",
  outcome: "succeeded" as const,
  sqlstate: null,
  attempts: 1,
  manual: false,
};
const databaseUsageRow = {
  start: "2026-10-31T10:00:00.000Z",
  end: "2026-10-31T11:00:00.000Z",
  final: true,
  metrics: {
    schedule_runs_succeeded: 1,
    schedule_runs_failed: 0,
    schedule_runs_timed_out: 0,
    schedule_runs_outcome_unknown: 0,
    schedule_runs_rejected: 0,
    schedule_runs_skipped: 0,
    events_emitted: 1,
    event_bytes: 128,
    webhook_attempts: 1,
    webhook_deliveries_delivered: 1,
    webhook_deliveries_dead_lettered: 0,
  },
};

/**
 * Which scope field the fake answers for: "environment" answers prod for dev, "identity" answers
 * another webhook, delivery or schedule than the one asked for.
 */
type DatabaseEventDrift = "none" | "environment" | "identity" | "schema" | "table";
const foreignWebhookId = "whk_zyxwvutsrqponmlkjihg";
const foreignDeliveryId = "dlv_fedcba9876543210fedc";
const foreignScheduleName = "other_job";
const databaseCronSchedule = {
  ...databaseSchedule,
  cron: "*/5 * * * *",
  every_seconds: null,
  timeout_ms: 5000,
  enabled: false,
  next_run_at: null,
};

/** Answers the database event routes with the wire shape the REST contract documents. */
function databaseEventAnswer(
  method: string,
  path: string,
  drift: DatabaseEventDrift = "none",
): { status: number; value: unknown } {
  const environment = drift === "environment" ? "prod" : "dev";
  const identity = drift === "identity";
  const webhook = { ...databaseWebhook, environment };
  const delivery = identity
    ? { ...databaseDelivery, webhook_id: foreignWebhookId }
    : databaseDelivery;
  const schedule = {
    ...databaseSchedule,
    environment,
    name: identity ? foreignScheduleName : databaseSchedule.name,
  };
  const watch = {
    ...databaseWatch,
    environment,
    ...(drift === "table"
      ? { table: "invoices", topic: "invoices", event_type: "data.invoices" }
      : {}),
    ...(drift === "schema" ? { schema: "sales" } : {}),
  };
  if (path.includes("/database/webhook-subscriptions/")) {
    const subscription = {
      id: identity ? "01K2F3G4H5J6K7M8N9P0QRSTVX" : operation.id,
      environment,
      generation: 1,
      state: method === "DELETE" ? "inactive" : "active",
      provider_id: databaseWebhook.id,
    };
    return {
      status: 200,
      value: { ...subscription, ...(method === "PUT" ? { secret: "whsec_fixture_secret" } : {}) },
    };
  }
  if (path.endsWith("/database/watches"))
    return method === "POST"
      ? { status: 201, value: watch }
      : { status: 200, value: { items: [watch] } };
  if (path.includes("/database/watches/"))
    return {
      status: 200,
      value: { id: identity ? foreignWatchId : databaseWatch.id, deleted: true },
    };
  if (path.endsWith("/webhook-deliveries"))
    return { status: 200, value: { items: [delivery], next_cursor: null } };
  if (path.endsWith("/replay"))
    return {
      status: 202,
      value: { delivery_id: identity ? foreignDeliveryId : databaseDelivery.id, state: "pending" },
    };
  if (path.endsWith("/test")) return { status: 200, value: databaseWebhookTest };
  if (path.endsWith("/database/webhooks"))
    return method === "POST"
      ? { status: 201, value: { ...databaseWebhookCreated, environment } }
      : { status: 200, value: { items: [webhook] } };
  if (path.includes("/database/webhooks/"))
    return {
      status: 200,
      value: { id: identity ? foreignWebhookId : databaseWebhook.id, deleted: true },
    };
  if (path.endsWith("/runs"))
    return {
      status: 200,
      value: { items: [{ ...databaseRun, schedule: schedule.name }] },
    };
  if (path.endsWith("/run"))
    return { status: 202, value: { schedule: schedule.name, state: "queued" } };
  if (path.endsWith("/database/schedules")) return { status: 200, value: { items: [schedule] } };
  if (path.includes("/database/schedules/"))
    return method === "DELETE"
      ? { status: 200, value: { name: schedule.name, deleted: true } }
      : { status: 200, value: schedule };
  if (path.endsWith("/execution-usage"))
    return { status: 200, value: { items: [databaseUsageRow], next_cursor: null } };
  return { status: 404, value: {} };
}

/** A generated SDK client whose fake control plane answers the database event routes. */
function databaseEventClient(drift: DatabaseEventDrift = "none") {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const answer = databaseEventAnswer(request.method, new URL(request.url).pathname, drift);
    return Response.json(answer.value, { status: answer.status });
  });
  const client = new GeneratedSdkLocalMcpClient(
    "https://control.example.test",
    "customer-access-token",
    fetch,
  );
  return { client, requests };
}

/** The method, path and query of one recorded request, relative to the database routes. */
function routeOf(request: Request): string {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname.replace(/^\/v1\/projects\/[^/]+\/database/u, "")}${url.search}`;
}
const databaseCredential = {
  ...databaseAccess,
  connection_uri: databaseConnectionUri,
  psql_command:
    "ohmyhost database psql --project 01M0SZNNXKDDT39A6DYVXASY65 --environment dev --mode read",
};
const revokedDatabaseAccess = {
  ...databaseAccess,
  state: "revoked" as const,
  revoked_at: databaseAccess.expires_at,
  revocation_reason: "principal" as const,
};
const identity: CurrentIdentity = {
  actor_id: "user_01M0CUSTOMER",
  email: "customer@example.invalid",
  organization_ids: ["01M0SZNNXKDDT39A6DYVXASY65"],
  organizations: [{ id: "01M0SZNNXKDDT39A6DYVXASY65", name: "Customer workspace" }],
};
const project: Project = {
  id: "01M0PROJECT0000000000000000",
  organization_id: identity.organization_ids[0] ?? "missing",
  name: "customer-canary",
  handle: "calm-otter-waves",
  data_mode: "shared",
  region: "eu",
  created_at: "2026-08-24T10:00:00.000Z",
};
const projectPage: ProjectPage = { items: [project], next_cursor: null };
const projectStatus: ProjectStatus = {
  project_id: project.id,
  handle: "calm-otter-waves",
  region: "eu",
  dev_access_mode: "protected",
  lifecycle: "active",
  source: null,
  default_environment: null,
  head_deployment: null,
  dev_url: null,
  prod_url: null,
  latest_operation: null,
  cleanup_state: "not_started",
  etag: `"sha256-${"a".repeat(64)}"`,
};
const operation: Operation = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  state: "queued",
  created_at: "2026-08-24T10:00:00.000Z",
  updated_at: "2026-08-24T10:00:00.000Z",
};
const source: ProjectSource = {
  provider: "github",
  installation_id: "154436098",
  repository_full_name: "aixyte/customer-canary",
  status: "ready",
  linked_at: "2026-08-24T10:00:00.000Z",
  updated_at: "2026-08-24T10:00:00.000Z",
};
const deploymentPlan: DeploymentPlan = {
  id: "01M0PLAN0000000000000000000",
  project_id: project.id,
  environment: "dev",
  commit_sha: "a".repeat(40),
  source_digest: `sha256:${"1".repeat(64)}`,
  build_plan_digest: `sha256:${"2".repeat(64)}`,
  application_root: ".",
  runtime: "cloudflare_workers_static_assets",
  route: "https://canary.example.test",
  resource_effects: [],
  limits: [],
  estimated_cost: {
    amount_micros: "0",
    currency: "USD",
    rate_card_version: "test",
    credit_micros: "0",
    credits: "0",
    provider_cost_micros: "0",
    reserved_seconds: "840",
    scope: "build_compute",
  },
  risks: [],
  destructive_effects: [],
  required_confirmations: [],
  created_at: "2026-08-24T10:00:00.000Z",
  expires_at: "2026-08-24T10:15:00.000Z",
};
const deployment: Deployment = {
  id: "01M0DEPLOYMENT0000000000000",
  project_id: project.id,
  operation_id: operation.id,
  commit_sha: deploymentPlan.commit_sha,
  source_digest: deploymentPlan.source_digest,
  build_plan_digest: deploymentPlan.build_plan_digest,
  status: "active",
  url: deploymentPlan.route,
  created_at: "2026-08-24T10:00:00.000Z",
  updated_at: "2026-08-24T10:10:00.000Z",
};
const deploymentPage: DeploymentPage = { items: [deployment], next_cursor: null };
const environmentId = "01M0ENVIRONMENT00000000000";
const secretConvergence = {
  desired_generation: 3,
  applied_generation: 3,
  delivery_state: "ready" as const,
  runtime_provider: "wfp" as const,
  applied_secret_count: 1,
  last_error: null,
};
const diagnosticPage = {
  items: [
    {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
      source: "build",
      code: "BUILD_FAILED",
      message: "CUSTOMER_BUILD_FAILED",
      excerpt: "npm ERR! missing script: build",
      excerpt_truncated: false,
      occurred_at: "2026-09-15T14:30:00.000Z",
    },
  ],
};
const functionRunPage = {
  items: [
    {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      deployment_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      cron: "*/5 * * * *",
      scheduled_at: "2026-09-15T14:30:00.000Z",
      state: "succeeded",
      attempt: 1,
      status_code: 204,
      started_at: "2026-09-15T14:30:32.306Z",
      finished_at: "2026-09-15T14:30:34.262Z",
    },
  ],
};

const secretPage: EnvironmentSecretPage = {
  items: [
    {
      name: "GEMINI_API_KEY",
      revision: 2,
      key_version: 1,
      created_at: "2026-08-24T10:00:00.000Z",
      updated_at: "2026-08-24T10:05:00.000Z",
      ...secretConvergence,
    },
  ],
  ...secretConvergence,
};
const secretDelete: DeleteEnvironmentSecretResult = {
  name: "GEMINI_API_KEY",
  status: "deleted",
  desired_generation: 4,
  applied_generation: 4,
  delivery_state: "ready",
  runtime_provider: "wfp",
  applied_secret_count: 0,
  last_error: null,
};
const rollbackPlan: GuardedActionPlan = destructivePlan("rollback");
const deletePlan: GuardedActionPlan = destructivePlan("delete");
const operationEvent: OperationEvent = {
  event_id: "01M0EVENT000000000000000000",
  operation_id: operation.id,
  project_id: project.id,
  type: "OperationQueued",
  occurred_at: "2026-08-24T10:00:00.000Z",
};

const reconciliation: ProviderReconciliationAttempt = {
  reconciliation_id: "01M0RECONCILE00000000000000",
  operation_id: operation.id,
  state: "pending",
};

const mailDomain: import("@ohmyhost/sdk-ts").ManagedMailDomain = {
  domain_id: "01H0000000000000000000060A",
  environment_id: environmentId,
  domain: "mail.customer.example",
  status: "verification_pending",
  sending: "pending",
  receiving: "disabled",
  configured_at: "2026-08-24T10:00:00.000Z",
  observed_at: null,
  dns_records: [],
  webhook: null,
  next_check_after_seconds: 60,
};

function destructivePlan(action: "rollback" | "delete"): GuardedActionPlan {
  return {
    action,
    project_id: project.id,
    resource_etag: '"etag"',
    effects: [],
    risks: [],
    confirmation_token: `${action}-confirmation`,
    created_at: "2026-08-24T10:00:00.000Z",
    expires_at: "2026-08-24T10:05:00.000Z",
  };
}
