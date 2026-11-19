import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { WorkosDeviceFlowClient } from "@ohmyhost/workos-auth-contracts/device-flow";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { GeneratedSdkLocalMcpClient } from "../../mcp/src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../../mcp/src/local-server.js";
import { ProductCli } from "../../product-cli/src/cli.js";
import { GeneratedSdkProductApi } from "../../product-cli/src/product-api.js";
import { clientsFixture } from "./helpers/d1-clients-fixture.js";

// The Worker host binds env through its constructor; the Core's private entrypoints run unchanged in process.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, environment: unknown) {
      this.env = environment;
    }
  },
}));

let control: TestControl;
let f: Awaited<ReturnType<typeof clientsFixture>>;
let token: string;
beforeAll(async () => {
  control = await createTestControl();
  f = await clientsFixture(control);
  token = await f.token();
}, 60_000);
afterAll(async () => control.dispose());

it("serves the released CLI and its generated SDK from the real Control API over the Core: credits, budget, notes, keys, billing, database and feedback", async () => {
  const organizationId = f.project.organizationId,
    projectId = f.project.projectId,
    api = new GeneratedSdkProductApi(f.origin, token, f.fetchApi),
    cli = new ProductCli({
      commandPrefix: "OHMYHOST_ENVIRONMENT=development ohmyhost",
      credentialStore: () => ({
        read: async () => ({
          accessToken: token,
          refreshToken: "unused",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
        replace: async () => undefined,
        clear: async () => undefined,
      }),
      deviceFlow: {} as WorkosDeviceFlowClient,
      deviceAuthorizationPresenter: { present: async () => undefined },
      productApi: (accessToken) => new GeneratedSdkProductApi(f.origin, accessToken, f.fetchApi),
      accountProfile: async (accessToken) =>
        await new GeneratedSdkProductApi(f.origin, accessToken, f.fetchApi).getAccountProfile(),
      projectLinkStore: { save: async () => undefined },
      productApiOrigin: f.origin,
      tokenRevoker: { revoke: async () => undefined },
      tokenRefresher: {
        refresh: async () => {
          throw new Error("Unexpected refresh");
        },
      },
      now: () => new Date("2026-10-29T12:00:00.000Z"),
      waitUntil: async () => undefined,
      lifecycleTimeoutMs: 10000,
      createCorrelationId: () => "clients-test",
      diagnosticSink: { record: () => undefined },
      readSecretValue: async () => {
        throw new Error("No secret input");
      },
    }),
    run = async (...argv: string[]) => {
      const result = await cli.run([...argv, "--json"]);
      expect(result.exitCode, result.stdout).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

  // Credits and budget through the CLI commands, which validate each answer with the runtime contract.
  expect((await run("credits", "balance", "--organization", organizationId))["credits"]).toEqual({
    organization_id: organizationId,
    unit: "microcredits",
    as_of: expect.any(String),
    available_micros: "200000000",
    reserved_micros: "0",
    grace_started_at: null,
    grace_expires_at: null,
  });
  expect(await run("credits", "account", "--organization", organizationId)).toMatchObject({
    account: { plan: "free", monthly_micros: "200000000" },
  });
  expect(await run("credits", "usage", "--organization", organizationId)).toMatchObject({
    usage: { organization_id: organizationId, projects: [], days: [] },
  });
  expect(
    await run(
      ...["budget", "set", "--project", projectId, "--credits", "100.25"],
      ...["--idempotency-key", "cli-budget"],
    ),
  ).toMatchObject({ budget: { amount_micros: "100250000", mode: "continue" } });
  expect(await run("budget", "get", "--project", projectId)).toMatchObject({
    budget: { project_id: projectId, amount_micros: "100250000" },
  });
  expect(await api.getOrganizationCredits(organizationId)).toMatchObject({
    organization_id: organizationId,
  });
  expect(await api.getOrganizationAccount(organizationId)).toMatchObject({ plan: "free" });
  expect(await api.getOrganizationCreditUsage(organizationId)).toMatchObject({
    organization_id: organizationId,
    projects: [],
    days: [],
  });
  expect(await api.getProjectCreditBudget(projectId)).toMatchObject({ mode: "continue" });
  expect(
    await api.setProjectCreditBudget({
      projectId,
      amountMicros: "0",
      mode: "stop",
      idempotencyKey: "sdk-budget",
    }),
  ).toMatchObject({ amount_micros: "0", mode: "stop" });

  // The shared project context and its notes.
  const context = await api.getProjectContext(projectId);
  expect(context).toMatchObject({ project_id: projectId, notes: { version: 0 } });
  expect(
    await api.setProjectNotes({
      projectId,
      markdown: "- ship the release",
      expectedVersion: context.notes.version,
      idempotencyKey: "sdk-notes",
    }),
  ).toMatchObject({ version: 1 });
  expect((await api.getProjectContext(projectId)).notes).toMatchObject({
    version: 1,
    markdown: "- ship the release",
  });

  // User API keys live with the WorkOS provider; the Control API validates every answer.
  const created = await api.createUserApiKey({
    organizationId,
    name: "ci",
    idempotencyKey: "sdk-key",
  });
  expect(created).toMatchObject({ replayed: false, key: { name: "ci" } });
  expect((await api.listUserApiKeys({ organizationId })).data).toHaveLength(1);
  await api.revokeUserApiKey({ organizationId, keyId: created.key.id });
  expect((await api.listUserApiKeys({ organizationId })).data).toEqual([]);

  // Billing sessions come from the billing Worker (Stripe).
  const checkout = await api.createBillingCheckout({
    organizationId,
    offer: "topup",
    packs: 2,
    idempotencyKey: "sdk-checkout",
  });
  expect(checkout).toMatchObject({ state: "open", packs: 2 });
  expect(
    await api.getBillingCheckout({ organizationId, checkoutId: checkout.checkout_id }),
  ).toMatchObject({ state: "complete", payment_confirmed: true });
  expect(await api.getBillingRecharge(organizationId)).toMatchObject({ enabled: false });
  expect(
    await api.configureBillingRecharge({
      organizationId,
      enabled: true,
      monthlyLimitMinor: 5000,
      consent: "off_session_v1",
      revision: 0,
      idempotencyKey: "sdk-recharge",
    }),
  ).toMatchObject({ enabled: true, status: "on" });
  expect(await api.createBillingPortal(organizationId)).toMatchObject({
    url: expect.stringContaining("billing.stripe.com") as unknown as string,
  });

  // The managed database: the observed state and one bounded write through the PGCF management Worker.
  expect(await api.getDatabaseCompute({ projectId, environment: "dev" })).toMatchObject({
    project_id: projectId,
    environment: "dev",
  });
  expect(
    await api.writeProjectDatabase({
      projectId,
      environment: "dev",
      statement: "INSERT INTO visits(n) VALUES ($1)",
      parameters: [1],
      idempotencyKey: "sdk-write",
    }),
  ).toMatchObject({ state: "succeeded", command: "INSERT", affected_rows: 1 });
  expect(f.databaseWrites).toHaveLength(1);

  // Support feedback is stored in the Core and read back by its receipt.
  const receipt = await api.submitFeedback({
    report: {
      organization_id: organizationId,
      kind: "bug",
      title: "Budget rounding",
      description: "Expected 100.25 credits, saw 100.2.",
    },
    idempotencyKey: "sdk-feedback",
  });
  expect(receipt).toMatchObject({ organization_id: organizationId });
  expect(await api.getFeedback(receipt.id)).toMatchObject({ id: receipt.id, status: "received" });
}, 60_000);

it("serves the local MCP tools from the same real Control API over the Core", async () => {
  const organizationId = f.project.organizationId,
    projectId = f.project.projectId,
    mcp = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () => new GeneratedSdkLocalMcpClient(f.origin, token, f.fetchApi),
    });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
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
        ),
        text = await response.text(),
        message = JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? text,
        ) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(message.result.isError, text).not.toBe(true);
      return JSON.parse(message.result.content[0]?.text ?? "null") as Record<string, unknown>;
    };

    expect(
      await call("organization_account_get", { organization_id: organizationId }),
    ).toMatchObject({ plan: "free", monthly_micros: "200000000" });
    expect(
      await call("organization_credits_get", { organization_id: organizationId }),
    ).toMatchObject({
      available_micros: "200000000",
      reserved_micros: "0",
      grace_started_at: null,
    });
    expect(await call("organization_usage_get", { organization_id: organizationId })).toMatchObject(
      { organization_id: organizationId, projects: [], days: [] },
    );
    expect(
      await call("project_budget_set", {
        project_id: projectId,
        amount_micros: "5000000",
        mode: "stop",
        idempotency_key: "mcp-budget",
      }),
    ).toMatchObject({ amount_micros: "5000000", mode: "stop" });
    expect(await call("project_budget_get", { project_id: projectId })).toMatchObject({
      amount_micros: "5000000",
    });
    expect(await call("project_context_get", { project_id: projectId })).toMatchObject({
      project_id: projectId,
    });
    expect(
      await call("project_notes_set", {
        project_id: projectId,
        markdown: "- reviewed by the agent",
        expected_version: 1,
        idempotency_key: "mcp-notes",
      }),
    ).toMatchObject({ version: 2 });

    const key = await new GeneratedSdkProductApi(f.origin, token, f.fetchApi).createUserApiKey({
      organizationId,
      name: "mcp-key",
      idempotencyKey: "mcp-key",
    });
    expect(await call("tokens_list", { organization_id: organizationId })).toMatchObject({
      data: [{ id: key.key.id }],
    });
    expect(
      await call("token_revoke", {
        organization_id: organizationId,
        key_id: key.key.id,
        confirmed: true,
      }),
    ).toEqual({ revoked: true, key_id: key.key.id });

    const checkout = await call("billing_checkout_create", {
      organization_id: organizationId,
      offer: "paid",
      idempotency_key: "mcp-checkout",
    });
    expect(checkout).toMatchObject({ offer: "paid", state: "open" });
    expect(
      await call("billing_checkout_get", {
        organization_id: organizationId,
        checkout_id: checkout["checkout_id"],
      }),
    ).toMatchObject({ state: "complete" });
    expect(await call("billing_recharge_get", { organization_id: organizationId })).toMatchObject({
      portal_available: true,
    });
    expect(
      await call("billing_recharge_configure", {
        organization_id: organizationId,
        enabled: false,
        monthly_limit_minor: 1000,
        consent: null,
        revision: 1,
        idempotency_key: "mcp-recharge",
      }),
    ).toMatchObject({ enabled: false, revision: 2 });
    expect(await call("billing_portal_create", { organization_id: organizationId })).toMatchObject({
      organization_id: organizationId,
    });

    expect(
      await call("database_compute_get", { project_id: projectId, environment: "dev" }),
    ).toMatchObject({ project_id: projectId, environment: "dev" });
    expect(
      await call("database_write", {
        project_id: projectId,
        environment: "dev",
        statement: "UPDATE visits SET n = n + 1",
        idempotency_key: "mcp-write",
        confirmed: true,
      }),
    ).toMatchObject({ state: "succeeded", command: "UPDATE" });
    expect(f.databaseWrites).toHaveLength(2);

    const receipt = await call("feedback_submit", {
      organization_id: organizationId,
      kind: "feature_request",
      title: "Export budgets",
      description: "Please export budgets as CSV.",
      idempotency_key: "mcp-feedback",
    });
    expect(await call("feedback_status", { feedback_id: receipt["id"] })).toMatchObject({
      id: receipt["id"],
      status: "received",
    });
  } finally {
    await mcp.close();
  }
}, 60_000);
