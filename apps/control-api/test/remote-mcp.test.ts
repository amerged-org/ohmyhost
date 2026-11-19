import { remoteMcpToolDefinitions } from "@ohmyhost/sdk-ts";
import {
  sharedMailMcpCases,
  sharedMailReadTools,
  sharedMailWriteTools,
  sharedMailTestReply,
} from "./helpers/w25-client-consent.js";
import { webcrypto, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { PROBLEM_POLICY } from "@ohmyhost/contracts/problem-policy";
import {
  assertDatabaseExecutionUsagePage,
  assertDatabaseScheduleRunPage,
  assertDatabaseSchedulePage,
  assertDatabaseWebhookDeliveryPage,
  assertDatabaseWebhookPage,
} from "@ohmyhost/contracts/database-events";
import { parseUlid } from "@ohmyhost/platform";
import { listOhmyhostSkillResources } from "@ohmyhost/agent-skills";
import type { McpDelegationStore, McpPortalHandoff, McpDelegationGrant } from "@ohmyhost/database";
import { createRemoteOhmyhostMcpHandler } from "../src/remote-mcp.js";
import {
  ANONYMOUS_SECRET_SCRIPT,
  ANONYMOUS_SECRET_SCRIPT_HASH,
  createMcpPortalAccess,
  handleMcpPortalRequest,
  renderMcpPortalPage,
} from "../src/remote-mcp-access.js";
import { PORTAL_CSS, PORTAL_CSS_HASH } from "../src/generated-portal-assets.js";
import { renderStandalonePage, standalonePageCsp } from "../src/standalone-page.js";
import {
  WEBSITE_HEADER_HTML,
  WEBSITE_HEADER_CSS,
  WEBSITE_HEADER_CSS_HASH,
} from "../src/website-brand.js";
import type { VerifiedWorkosConnectPrincipal } from "../src/workos-authenticator.js";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
import { createRemoteMcpComposition } from "../src/remote-mcp-composition.js";
import type { RemoteMcpPersistence } from "../src/remote-mcp-persistence.js";
import type { AuthorizationPort } from "@ohmyhost/platform";

const origin = "https://app.ohmyho.st",
  org = parseUlid("01M21T9VB6J0P0QWQJ4J3086ZH"),
  project = parseUlid("01M21T9VB6J0P0QWQJ4J3086ZJ"),
  deployment = parseUlid("01M21T9VB6J0P0QWQJ4J3086ZK"),
  environment = parseUlid("01M21T9VB6J0P0QWQJ4J3086ZM"),
  sourceConnection = parseUlid("01M21T9VB6J0P0QWQJ4J3086ZN"),
  reconciliation = parseUlid("01M21T9VB6J0P0QWQJ4J3086ZP"),
  commit = "a".repeat(40),
  now = "2026-10-06T12:00:00.000Z";
const principal: VerifiedWorkosConnectPrincipal = {
  actorId: "user:user_test",
  credentialId: "workos_connect:client_test:consent_test",
  authorizationPrincipal: { kind: "user", subjectId: "user:user_test" },
  organizationIds: [org],
  authorizationScopeConstraint: [],
  connectUser: {
    issuer: "https://issuer.example",
    audience: [`${origin}/mcp`],
    clientId: "client_test",
    userId: "user_test",
    consentId: "consent_test",
    workosOrganizationId: "org_test",
    tokenId: null,
    tokenExpiresAt: 2_000_000_000,
  },
};
const browser: AuthenticatedPrincipal = {
  actorId: principal.actorId,
  credentialId: "workos_session:session_test",
  authorizationPrincipal: principal.authorizationPrincipal,
  organizationIds: [org],
  session: {
    sessionId: "session_test",
    userId: "user_test",
    organizationId: "org_test",
    tokenExpiresAt: 2_000_000_000,
  },
};

function testStore() {
  const records = new Map<string, McpPortalHandoff>();
  const nativeAttempts = new Map<
    string,
    { attemptId: string; valueSha256: string; state: "pending" | "retryable" | "succeeded" }
  >();
  const revocations: Array<{ userId: string; clientId: string; consentHash: string }> = [];
  let permitted = true;
  let disconnectPending = false;
  const grant: McpDelegationGrant = {
    userId: "user_test",
    clientId: "client_test",
    consentHash: "a".repeat(64),
    organizationId: org,
    grantId: "00000000-0000-0000-0000-000000000001",
    projectId: project,
    allowPublish: false,
    createdAt: now,
    revokedAt: null,
  };
  const store: McpDelegationStore = {
    async ensureConnectionProof() {
      return permitted ? grant : null;
    },
    async insertHandoff(input) {
      records.set(input.requestHash, input);
    },
    async findHandoff(hash) {
      return records.get(hash) ?? null;
    },
    async readNativeProviderHandoffState(input) {
      const item = records.get(input.requestHash);
      if (
        !permitted ||
        !item?.secretTarget?.nativeProvider ||
        item.userId !== input.userId ||
        item.organizationId !== input.organizationId
      )
        return null;
      if (item.outcome === "declined") return "declined";
      return nativeAttempts.get(input.requestHash)?.state ?? "retryable";
    },
    async claimNativeProviderHandoff(input) {
      const item = records.get(input.requestHash),
        prior = nativeAttempts.get(input.requestHash);
      if (
        !permitted ||
        !item?.secretTarget?.nativeProvider ||
        item.outcome === "declined" ||
        item.userId !== input.userId ||
        item.organizationId !== input.organizationId ||
        (prior && (prior.state !== "retryable" || prior.valueSha256 !== input.valueSha256))
      )
        return null;
      nativeAttempts.set(input.requestHash, {
        attemptId: input.attemptId,
        valueSha256: input.valueSha256,
        state: "pending",
      });
      const claimed = {
        ...item,
        consumedAt: item.consumedAt ?? now,
        outcome: "secret_submitted" as const,
      };
      records.set(input.requestHash, claimed);
      return claimed;
    },
    async completeNativeProviderHandoff(input) {
      const attempt = nativeAttempts.get(input.requestHash),
        item = records.get(input.requestHash);
      if (
        !attempt ||
        attempt.attemptId !== input.attemptId ||
        attempt.state !== "pending" ||
        !item ||
        item.organizationId !== input.organizationId
      )
        return false;
      nativeAttempts.set(input.requestHash, {
        ...attempt,
        state: input.succeeded ? "succeeded" : "retryable",
      });
      if (!input.succeeded) records.set(input.requestHash, { ...item, outcome: "secret_failed" });
      return true;
    },
    async consumeHandoff(input) {
      const item = records.get(input.requestHash);
      if (
        !item ||
        (item.consumedAt &&
          (input.approve ||
            !item.secretTarget?.nativeProvider ||
            nativeAttempts.get(input.requestHash)?.state !== "retryable")) ||
        item.userId !== input.userId ||
        item.organizationId !== input.organizationId
      )
        return null;
      const approved = {
        ...item,
        projectIds: input.selectedProjectIds ?? item.projectIds,
        consumedAt: input.now,
        outcome: input.approve
          ? item.kind === "secret"
            ? ("secret_failed" as const)
            : ("github_started" as const)
          : ("declined" as const),
      };
      records.set(item.requestHash, approved);
      return approved;
    },
    async completeSecret(hash, succeeded) {
      const item = records.get(hash);
      // A consumed plain link is recorded as failed; only a stored write moves it to submitted.
      if (item && succeeded) records.set(hash, { ...item, outcome: "secret_submitted" });
    },
    async completeGithub(hash, succeeded) {
      const item = records.get(hash);
      if (item && !succeeded) records.set(hash, { ...item, outcome: "github_failed" });
    },
    async revoke(identity) {
      revocations.push(identity);
      permitted = false;
      return { state: disconnectPending ? "pending" : "revoked" };
    },
  };
  return {
    store,
    records,
    revocations,
    setDisconnectPending: (value: boolean) => {
      disconnectPending = value;
    },
  };
}
function makeAccess(store: McpDelegationStore, clock = () => new Date(now)) {
  return createMcpPortalAccess({
    origin,
    store,
    crypto: webcrypto as Crypto,
    now: clock,
    authorize: async (p, _resource, action) => ({
      grantId: "00000000-0000-0000-0000-000000000001",
      clientId: p.connectUser.clientId,
      consentHash: createHash("sha256").update(p.connectUser.consentId).digest("hex"),
      action,
    }),
  });
}
function request(method: string, params?: unknown, token: string | null = "good-token") {
  return new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}
interface RpcResponse {
  error?: { code: number; message: string };
  result: {
    instructions: string;
    resources: unknown[];
    contents: Array<{ text: string }>;
    tools: Array<{
      name: string;
      title: string;
      inputSchema: unknown;
      description: string;
      annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
      };
    }>;
    content: Array<{ text: string }>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  };
}
async function rpc(response: Response | null): Promise<RpcResponse> {
  if (!response) throw new Error("Expected MCP response");
  const bytes = await response.text();
  const raw = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? bytes
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : bytes;
  return JSON.parse(raw ?? "{}");
}
/**
 * docs.ohmyho.st is Mintlify over this bundled contract: it names each untagged operation's API
 * reference page after its summary (prepareStringToBeValidFilename in @mintlify/common 1.0.1222).
 */
async function readApiReferences(): Promise<ReadonlyMap<string, string>> {
  const contract = JSON.parse(
    await readFile(
      new URL("../../../packages/contracts/generated/openapi.json", import.meta.url),
      "utf8",
    ),
  ) as { paths: Record<string, Record<string, { operationId?: unknown; summary?: unknown }>> };
  const operations = Object.values(contract.paths).flatMap((item) => Object.values(item));
  const references = new Map<string, string>();
  for (const operation of operations)
    if (typeof operation.operationId === "string" && typeof operation.summary === "string")
      references.set(
        operation.operationId,
        `https://docs.ohmyho.st/api-reference/${operation.summary
          .replaceAll(" ", "-")
          .replace(/\{.*?\}/gu, "-")
          .replace(/^-/u, "")
          .replace(/-$/u, "")
          .replace(/[{}(),.'\n/]/gu, "")
          .replaceAll("--", "-")
          .toLowerCase()}`,
      );
  // A tag would move every page into a folder, and a repeated name gets a numeric suffix.
  expect(operations.filter((operation) => "tags" in operation)).toEqual([]);
  expect(new Set(references.values()).size).toBe(references.size);
  return references;
}

it("preserves legacy tool contracts while exposing the Master Tool Contract through authenticated named operations", async () => {
  const legacy = JSON.parse(
    await readFile(new URL("./fixtures/remote-mcp-legacy-20261116.json", import.meta.url), "utf8"),
  ) as RpcResponse["result"]["tools"];
  const calls: Array<{ request: Request; body: unknown; actor: string }> = [];
  let reply: unknown = { state: "succeeded", result: "observed" };
  let replyStatus = 200;
  let authenticationCalls = 0;
  let changeIdentityAfter = Infinity;
  let audience = principal.connectUser.audience;
  let revoked = false;
  const records: import("@ohmyhost/contracts/usage-log").UsageLogRecord[] = [];
  const handler = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access: makeAccess(testStore().store),
    authenticate: async () => {
      authenticationCalls += 1;
      return revoked
        ? null
        : authenticationCalls >= changeIdentityAfter
          ? { ...principal, actorId: "user:changed", credentialId: "changed-credential" }
          : { ...principal, connectUser: { ...principal.connectUser, audience } };
    },
    dispatch: async (req, identity) => {
      calls.push({
        request: req,
        body: req.body ? await req.clone().json() : null,
        actor: identity.actorId,
      });
      return Response.json(reply, { status: replyStatus });
    },
    usageLog: {
      report: (record) => records.push(record),
      environment: "development",
      version: null,
    },
  });
  try {
    const catalog = (await rpc(await handler.fetch(request("tools/list", undefined, null)))).result
      .tools;
    for (const audiences of [[], [`${origin}/mcp/chatgpt`], [`${origin}/mcp`, `${origin}/other`]]) {
      audience = audiences;
      const denied = await handler.fetch(
        request("tools/call", { name: "identity_get", arguments: {} }),
      );
      expect(denied?.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
    audience = principal.connectUser.audience;
    const names = new Set(legacy.map((tool) => tool.name));
    // Preserve the November inventory and pin the subsequent intentional contract changes.
    const descriptions: Record<string, string> = {
      connection_status:
        "Reports the status of a protected secret or GitHub link. An unused secret link is pending until it expires after one hour. For grouped secrets, read each name's saved, failed, or unconfirmed result. Request a fresh link for failed names and check configuration before retrying an unconfirmed name. For an individual plain secret, a consumed link reads secret_failed until the write is confirmed as secret_submitted. Recheck an in-flight result and confirm the name with secrets_list. Request a fresh link for an expired link or a lasting failure. For a Native Auth provider secret with state secret_uncertain, reopen the original link and enter the same value to retry the original request. Status exposes only names and outcomes.",
      connection_revoke:
        "Disconnects this client and consent across the account, including future workspaces. This revokes the connection for current and future work; ordinary token refresh does not restore it. A pending result means active work is draining; retry disconnect until it reports revoked. Once revoked, every other tool answers connection_revoked until the connector is removed and added again.",
      project_create:
        "Creates an application in the selected workspace. github selects an actual GitHub checkout; managed starts ohmyho.st versioning from a template after provisioning. Returns project_id and the queued operation id. An identical retry with the same idempotency key returns both original IDs. operation_get and source_get expose readiness. Source selection follows the checkout and user preference, independently of local or cloud execution.",
    };
    const expected = legacy.map((tool) => {
      const description = descriptions[tool.name];
      if (description) return { ...tool, description };
      if (
        tool.name !== "native_auth_provider_secret_input_request" &&
        tool.name !== "secret_input_request"
      )
        return tool;
      const schema = tool.inputSchema as {
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };
      if (tool.name === "native_auth_provider_secret_input_request") {
        return {
          ...tool,
          inputSchema: {
            ...schema,
            properties: {
              ...schema.properties,
              configuration_revision: {
                type: "integer",
                exclusiveMinimum: 0,
                maximum: 2_147_483_646,
              },
            },
          },
        };
      }
      // W53 adds grouped input while preserving the legacy single-name request.
      return {
        ...tool,
        description:
          "Creates one protected portal form for named secrets in one Dev or Prod environment. Use names to group up to ten distinct names in one call, or specify name for a legacy single-secret request. The link needs no sign-in, is valid for one hour, and is dead after the first save with valid values. The person can paste or generate a value in each field and use Copy if needed. Never put the value in chat or tool arguments; only configuration status returns through connection_status.",
        inputSchema: {
          ...schema,
          properties: {
            ...schema.properties,
            name: {
              ...schema.properties["name"],
              description: "Use for one secret, without names.",
            },
            names: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 10,
              description: "Use for one form with several fields, without name.",
            },
          },
          required: schema.required.filter((key) => key !== "name"),
        },
      };
    });
    expect(catalog.filter((tool) => names.has(tool.name))).toEqual(expected);
    expect(catalog.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "database_compute_get",
        "database_compute_set",
        "organization_credits_get",
        "organization_usage_get",
        "project_budget_get",
        "project_budget_set",
        "database_query",
        "database_write",
        "api_reference",
      ]),
    );
    expect(catalog).toHaveLength(156);
    const referenceDescription = catalog.find((tool) => tool.name === "api_reference")?.description;
    expect(referenceDescription).toContain("https://github.com/amerged-org/ohmyhost");
    expect(referenceDescription).toContain("https://github.com/amerged-org/cloudflare-postgres");
    for (const name of [
      "organization_account_get",
      "organization_credits_get",
      "organization_usage_get",
    ])
      expect(catalog.find((tool) => tool.name === name)?.annotations.readOnlyHint).toBe(true);
    const initialized = await rpc(
      await handler.fetch(
        request(
          "initialize",
          {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
          null,
        ),
      ),
    );
    expect(initialized.result.instructions).toContain(
      "Report Agent_Service=codex, Agent_Service=chatgpt, or Agent_Service=claude. Use Agent_Service=unknown",
    );
    expect(new Set(catalog.map((tool) => tool.title)).size).toBe(catalog.length);
    for (const name of ["database_webhook_create", "mail_webhook_set", "mail_webhook_rotate"])
      expect(catalog.some((tool) => tool.name === name)).toBe(false);
    expect(catalog.find((tool) => tool.name === "mail_message_get")?.description).toMatch(
      /untrusted.*(?:never|do not follow).*instructions/iu,
    );
    expect(calls).toEqual([]);

    const call = async (name: string, args: Record<string, unknown>) =>
      rpc(await handler.fetch(request("tools/call", { name, arguments: args })));
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      method: string;
      suffix: string;
    }> = [
      {
        name: "database_compute_get",
        args: { project_id: project, environment: "prod" },
        method: "GET",
        suffix: "/database/compute",
      },
      {
        name: "database_compute_set",
        args: {
          project_id: project,
          environment: "dev",
          memory_mib: 512,
          confirm: true,
          idempotency_key: "resize-once",
        },
        method: "POST",
        suffix: "/database/compute",
      },
      {
        name: "organization_credits_get",
        args: { organization_id: org },
        method: "GET",
        suffix: "/credits",
      },
      {
        name: "organization_usage_get",
        args: { organization_id: org },
        method: "GET",
        suffix: "/credit-usage",
      },
      {
        name: "project_budget_get",
        args: { project_id: project },
        method: "GET",
        suffix: "/credit-budget",
      },
      {
        name: "project_budget_set",
        args: {
          project_id: project,
          amount_micros: "1000000",
          mode: "stop",
          idempotency_key: "budget-once",
        },
        method: "PUT",
        suffix: "/credit-budget",
      },
      {
        name: "database_query",
        args: { project_id: project, environment: "dev", statement: "SELECT 1", parameters: [] },
        method: "POST",
        suffix: "/database/query",
      },
      {
        name: "database_write",
        args: {
          project_id: project,
          environment: "dev",
          statement: "UPDATE public.w51_fixture SET value = $1",
          parameters: [1],
          confirmed: true,
          idempotency_key: "write-once",
        },
        method: "POST",
        suffix: "/database/write",
      },
      {
        name: "database_schedule_set",
        args: {
          project_id: project,
          environment: "dev",
          name: "w51-fixture",
          every_seconds: 60,
          statements: ["SELECT 1"],
          confirmed: true,
        },
        method: "PUT",
        suffix: "/database/schedules/w51-fixture",
      },
      {
        name: "database_watch_create",
        args: {
          project_id: project,
          environment: "dev",
          table: "w51_fixture",
          columns: ["id"],
          confirmed: true,
          idempotency_key: "watch-once",
        },
        method: "POST",
        suffix: "/database/watches",
      },
      {
        name: "feedback_submit",
        args: {
          organization_id: org,
          kind: "issue",
          title: "W51 fixture",
          description: "Expected and observed fixture behavior.",
          idempotency_key: "feedback-once",
        },
        method: "POST",
        suffix: "/feedback",
      },
      {
        name: "mail_message_get",
        args: { project_id: project, environment_id: environment, message_id: deployment },
        method: "GET",
        suffix: `/mail/messages/${deployment}`,
      },
      {
        name: "delete_execute",
        args: {
          project_id: project,
          idempotency_key: "delete-fixture-once",
          if_match: '"project-fixture"',
          confirmation_token: "t".repeat(32),
        },
        method: "DELETE",
        suffix: `/projects/${project}`,
      },
      {
        name: "organization_account_get",
        args: { organization_id: org },
        method: "GET",
        suffix: "/account",
      },
    ];
    for (const testCase of cases) {
      const response = await call(testCase.name, testCase.args);
      expect(response.result?.isError, testCase.name).not.toBe(true);
      expect(JSON.parse(response.result.content[0]?.text ?? "null")).toEqual(reply);
      const observed = calls.at(-1);
      expect(observed?.request.method, testCase.name).toBe(testCase.method);
      expect(new URL(observed?.request.url ?? origin).pathname, testCase.name).toContain(
        testCase.suffix,
      );
      expect(observed?.actor).toBe(principal.actorId);
      expect(observed?.request.headers.has("authorization")).toBe(false);
      expect(observed?.request.headers.has("cookie")).toBe(false);
      if (testCase.args["idempotency_key"])
        expect(observed?.request.headers.get("idempotency-key")).toBe(
          testCase.args["idempotency_key"],
        );
    }
    const compute = calls.find(
      (entry) => entry.request.method === "POST" && entry.request.url.includes("/database/compute"),
    );
    expect(compute?.body).toEqual({ environment: "dev", memory_mib: 512, confirm: true });
    expect(
      calls.find((entry) => entry.request.url.includes("/database/write"))?.body,
    ).not.toHaveProperty("confirmed");
    const deletion = calls.find((entry) => entry.request.method === "DELETE");
    expect(deletion?.request.headers.get("if-match")).toBe('"project-fixture"');
    expect(deletion?.request.headers.get("x-confirmation-token")).toBe("t".repeat(32));

    const writeCase = cases.find((entry) => entry.name === "database_write");
    expect(writeCase).toBeDefined();
    const beforeInvalid = calls.length;
    const invalid = await call("database_write", { ...writeCase?.args, confirmed: false });
    expect(invalid.error?.code ?? invalid.result?.isError).toBeTruthy();
    const injected = await call("database_query", {
      ...cases[6]?.args,
      headers: { Authorization: "must-not-forward" },
    });
    expect(injected.error?.code ?? injected.result?.isError).toBeTruthy();
    expect(calls).toHaveLength(beforeInvalid);
    for (const invalidCase of [
      { name: "database_compute_set", args: { ...cases[1]?.args, profile: "standard" } },
      { name: "feedback_submit", args: { ...cases[10]?.args, environment_id: environment } },
      { name: "project_budget_set", args: { ...cases[5]?.args, idempotency_key: "bad\nkey" } },
      { name: "delete_execute", args: { ...cases[12]?.args, if_match: '"etag"\n' } },
      {
        name: "delete_execute",
        args: { ...cases[12]?.args, confirmation_token: `${"t".repeat(32)}\n` },
      },
    ]) {
      const rejected = await call(invalidCase.name, invalidCase.args);
      expect(rejected.error?.code ?? rejected.result?.isError, invalidCase.name).toBeTruthy();
      expect(JSON.stringify(rejected)).not.toContain("could not be confirmed");
    }
    expect(calls).toHaveLength(beforeInvalid);

    reply = { id: deployment, status: "running", result: null };
    replyStatus = 202;
    const accepted = await call("database_compute_set", cases[1]?.args ?? {});
    expect(JSON.parse(accepted.result.content[0]?.text ?? "null")).toMatchObject({
      status: "running",
    });
    reply = { state: "failed", error: { code: "database_write_outcome_unknown" } };
    replyStatus = 200;
    const failed = await call("database_write", writeCase?.args ?? {});
    expect(JSON.parse(failed.result.content[0]?.text ?? "null")).toEqual(reply);
    await call("database_write", writeCase?.args ?? {});
    expect(calls.at(-1)?.request.headers.get("idempotency-key")).toBe("write-once");
    for (const status of [403, 409, 412]) {
      replyStatus = status;
      reply = {
        code: status === 403 ? "forbidden" : "precondition_failed",
        detail: "private-provider-diagnostic",
      };
      const problem = await call("project_budget_set", cases[5]?.args ?? {});
      expect(problem.result.isError).toBe(true);
      expect(JSON.parse(problem.result.content[0]?.text ?? "null")).toMatchObject({ status });
      expect(JSON.stringify(problem)).not.toContain("private-provider-diagnostic");
    }
    const beforeIdentityChange = calls.length;
    changeIdentityAfter = authenticationCalls + 3;
    const changed = await call("database_query", cases[6]?.args ?? {});
    expect(changed.result.isError).toBe(true);
    expect(JSON.parse(changed.result.content[0]?.text ?? "null")).toMatchObject({
      code: "unauthenticated",
    });
    expect(calls).toHaveLength(beforeIdentityChange);
    changeIdentityAfter = Infinity;

    const beforeReference = calls.length;
    const reference = await call("api_reference", { query: "database", limit: 1 });
    const page = JSON.parse(reference.result.content[0]?.text ?? "null") as {
      master_tool_contract: { sha256: string };
      operations: unknown[];
      availability: string;
      next_cursor: string;
    };
    expect(page.operations).toHaveLength(1);
    expect(page.availability).toContain("https://github.com/amerged-org/ohmyhost");
    expect(page.availability).toContain("https://github.com/amerged-org/cloudflare-postgres");
    expect(page.next_cursor).toBeTruthy();
    expect(page.master_tool_contract.sha256).toBe(
      createHash("sha256")
        .update(
          await readFile(
            new URL("../../../packages/contracts/generated/openapi.json", import.meta.url),
          ),
        )
        .digest("hex"),
    );
    const next = await call("api_reference", {
      query: "database",
      cursor: page.next_cursor,
      limit: 1,
    });
    expect(JSON.parse(next.result.content[0]?.text ?? "null").operations).not.toEqual(
      page.operations,
    );
    for (const args of [
      { query: "credits", cursor: page.next_cursor },
      { cursor: "invalid" },
      { operation_id: "queryProjectDatabase", query: "database" },
      { query: "x".repeat(121) },
      { limit: 21 },
      { operation_id: "not-a-public-operation" },
      { method: "POST", url: "https://unexpected.example" },
    ]) {
      const rejected = await call("api_reference", args);
      expect(rejected.error?.code ?? rejected.result?.isError).toBeTruthy();
    }
    const { readApiReference } = await import("../src/remote-mcp-reference.js");
    const { remoteMcpOperations } = await import("@ohmyhost/sdk-ts");
    const providerReference = readApiReference({ operation_id: "updateNativeAuthProvider" })
      .operations[0];
    expect(providerReference).not.toHaveProperty("input_schema");
    expect(providerReference).toHaveProperty("rest_input_schema");
    expect(providerReference?.schema_note).toMatch(/tools\/list.*secret/iu);
    expect(
      readApiReference({ operation_id: "writeProjectDatabase" }).operations[0]?.input_schema,
    ).toMatchObject({
      properties: { confirmed: { const: true } },
    });
    for (const operation of remoteMcpOperations) {
      const detail = readApiReference({ operation_id: operation.operationId });
      expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBeLessThanOrEqual(
        32768,
      );
      expect(detail.operations[0]?.mcp.disposition).toBe(operation.disposition);
    }
    expect(calls).toHaveLength(beforeReference);
    revoked = true;
    const denied = await handler.fetch(
      request("tools/call", { name: "database_query", arguments: cases[6]?.args }),
    );
    expect(denied?.status).toBe(401);
    await denied?.text();
    expect(calls).toHaveLength(beforeReference);
    expect(
      records.some(
        (record) => record.operation === "database_write" && record.phase === "finished",
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(
      /SELECT 1|private-provider-diagnostic|must-not-forward|UPDATE public/u,
    );
  } finally {
    await handler.close();
  }
  const { createControlApi } = await import("../src/app.js");
  const { routeDependencies, ORGANIZATION_ID, PROJECT_ID } = await import(
    "./helpers/app-routes-fixture.js"
  );
  const restrictedIdentity = {
    ...principal,
    organizationIds: [ORGANIZATION_ID],
    authorizationScopeConstraint: ["projects:read"],
  };
  let authorizationChecks = 0;
  let forbiddenEffects = 0;
  const canonical = createControlApi(
    routeDependencies({
      remoteAuthorization: async () => true,
      authorization: {
        check: async () => {
          authorizationChecks += 1;
          return "allow";
        },
      },
      projectDatabaseWrite: async () => {
        forbiddenEffects += 1;
        throw new Error("A denied caller must not reach the database effect");
      },
      internalAuthentication: {
        resolve: async () => restrictedIdentity,
        revalidate: async () => restrictedIdentity,
      },
    }),
  );
  const guarded = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access: makeAccess(testStore().store),
    authenticate: async () => restrictedIdentity,
    dispatch: async (req) => canonical.fetch(req),
  });
  try {
    const forbidden = await rpc(
      await guarded.fetch(
        request("tools/call", {
          name: "database_write",
          arguments: {
            project_id: PROJECT_ID,
            environment: "dev",
            statement: "DELETE FROM public.w51_fixture",
            parameters: [],
            confirmed: true,
            idempotency_key: "restricted-caller",
          },
        }),
      ),
    );
    expect(forbidden.result.isError).toBe(true);
    // The canonical scope cap hides the resource before broader role checks or a database effect.
    expect(JSON.parse(forbidden.result.content[0]?.text ?? "null")).toMatchObject({
      code: "resource_not_found",
      status: 404,
    });
    expect(authorizationChecks).toBe(0);
    expect(forbiddenEffects).toBe(0);
  } finally {
    await guarded.close();
  }
});

it("serves real HTTP MCP discovery and every chat operation through authenticated canonical REST without tokens or local filesystem paths", async () => {
  const fixture = testStore(),
    access = makeAccess(fixture.store),
    calls: Array<{ request: Request; principal: VerifiedWorkosConnectPrincipal; body: unknown }> =
      [];
  let lateAuthentication: number | null = null;
  let binaryFile = false;
  let unexpectedSubscriptionSecret = false;
  let alteredUploadResult:
    | "malformed"
    | "path"
    | "sha256"
    | "byte_length"
    | "executable"
    | "operation_id"
    | null = null;
  const currentIdentity = {
    actor_id: principal.actorId,
    email: "test@example.invalid",
    organization_ids: [org],
    organizations: [{ id: org, name: "My workspace" }],
  };
  const sourceText = "Grüße 🙂\nconst answer = 42;\n";
  const sourceBytes = Buffer.from(sourceText);
  const sourceManifest = {
    path: "src/App.tsx",
    sha256: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
    byte_length: sourceBytes.length,
    executable: true,
  };
  const uploadReceipt = {
    operation_id: deployment,
    state: "staging",
    expected_source_generation: 1,
    expected_commit_sha: commit,
    commit_sha: null,
    expires_at: "2026-10-06T12:15:00.000Z",
  };
  const uploadOperation = { id: deployment, state: "queued", created_at: now, updated_at: now };
  const createdProject = { ...uploadOperation, project_id: project };
  const reconciliationReceipt = {
    reconciliation_id: reconciliation,
    operation_id: deployment,
    state: "pending",
  };
  // Database answers reproduce the real REST shapes (packages/contracts/src/database-events.ts);
  // each one is checked by its assertion so a fixture cannot drift from the contract.
  const databaseWebhookId = "whk_abcdefghijklmnopqrst";
  const databaseWebhook = {
    id: databaseWebhookId,
    environment: "prod",
    url: "https://hooks.example.com/ohmyhost",
    event_types: ["database.ready"],
    header_names: ["x-signature"],
    created_at: now,
  };
  const databaseWebhookPage = { items: [databaseWebhook] };
  assertDatabaseWebhookPage(databaseWebhookPage);
  const databaseDelivery = {
    id: "dlv_0123456789abcdef0123",
    event_id: "evt_0123456789abcdef0123",
    event_type: "database.ready",
    webhook_id: databaseWebhookId,
    state: "delivered",
    attempts: 1,
    created_at: now,
    next_attempt_at: null,
    delivered_at: now,
    last_status: 200,
    last_error: null,
  };
  const databaseDeliveryPage = { items: [databaseDelivery], next_cursor: null };
  assertDatabaseWebhookDeliveryPage(databaseDeliveryPage);
  const databaseSchedule = {
    name: "nightly_rollup",
    environment: "prod",
    cron: "0 3 * * *",
    every_seconds: null,
    statements: ["select 1"],
    timeout_ms: 10_000,
    enabled: true,
    next_run_at: now,
    created_at: now,
  };
  const databaseSchedulePage = { items: [databaseSchedule] };
  assertDatabaseSchedulePage(databaseSchedulePage);
  const databaseRunPage = {
    items: [
      {
        id: 7,
        schedule: "nightly_rollup",
        scheduled_at: now,
        started_at: now,
        finished_at: now,
        outcome: "succeeded",
        sqlstate: null,
        attempts: 1,
        manual: false,
      },
    ],
  };
  assertDatabaseScheduleRunPage(databaseRunPage);
  const databaseUsagePage = {
    items: [
      {
        start: "2026-10-30T00:00:00.000Z",
        end: "2026-10-31T00:00:00.000Z",
        final: true,
        metrics: {
          schedule_runs_succeeded: 1,
          schedule_runs_failed: 0,
          schedule_runs_timed_out: 0,
          schedule_runs_outcome_unknown: 0,
          schedule_runs_rejected: 0,
          schedule_runs_skipped: 0,
          events_emitted: 2,
          event_bytes: 512,
          webhook_attempts: 1,
          webhook_deliveries_delivered: 1,
          webhook_deliveries_dead_lettered: 0,
        },
      },
    ],
    next_cursor: null,
  };
  assertDatabaseExecutionUsagePage(databaseUsagePage);
  const databaseAnswers = new Map<string, unknown>([
    [`/v1/projects/${project}/database/webhooks`, databaseWebhookPage],
    [`/v1/projects/${project}/database/webhook-deliveries`, databaseDeliveryPage],
    [`/v1/projects/${project}/database/schedules`, databaseSchedulePage],
    [`/v1/projects/${project}/database/schedules/nightly_rollup/runs`, databaseRunPage],
    [`/v1/projects/${project}/database/execution-usage`, databaseUsagePage],
  ]);
  let failureStatus = 0,
    authenticateCalls = 0,
    authUnavailable = false,
    disconnected = false,
    failureBody: Readonly<Record<string, unknown>> = {
      code: "version_conflict",
      detail: "provider-token-must-never-leak",
      retryable: false,
    };
  const handler = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access,
    authenticate: async (token) => {
      authenticateCalls++;
      if (authUnavailable) throw new Error("provider-token-must-never-leak");
      if (lateAuthentication !== null && lateAuthentication-- <= 0) return null;
      return token === "good-token"
        ? disconnected
          ? { ...principal, connectionDisconnected: true }
          : principal
        : null;
    },
    dispatch: async (apiRequest, identity) => {
      const apiBody: unknown = apiRequest.body ? await apiRequest.clone().json() : undefined;
      calls.push({
        request: apiRequest,
        principal: identity,
        body: apiBody,
      });
      if (failureStatus) return Response.json(failureBody, { status: failureStatus });
      const url = new URL(apiRequest.url);
      if (url.pathname === `/v1/organizations/${org}/connections/begin`)
        return Response.json(
          {
            request_id: "a".repeat(64),
            url: `${origin}/connections/authorize?request=${"b".repeat(43)}`,
            expires_at: "2030-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      if (url.pathname === `/v1/organizations/${org}/connections`)
        return Response.json({ connections: [] });
      if (url.pathname.includes(`/connections/requests/`))
        return Response.json({ state: "pending", expires_at: "2030-01-01T00:00:00Z" });
      if (url.pathname === `/v1/organizations/${org}/connections/${deployment}/imports`)
        return Response.json(
          {
            id: deployment,
            grant_id: deployment,
            project_id: project,
            environment_id: environment,
            provider_organization_id: 1,
            team_id: 2,
            connection_id: 3,
          },
          { status: 201 },
        );
      if (url.pathname.endsWith("/catalog") && url.pathname.includes("/connections/"))
        return Response.json({ organizations: [], teams: [], connections: [] });
      if (
        url.pathname === `/v1/organizations/${org}/connections/${deployment}` &&
        apiRequest.method === "DELETE"
      )
        return Response.json({ state: "disconnected" });
      if (
        url.pathname.endsWith("/auth/users/00000000-0000-4000-8000-000000000001") &&
        apiRequest.method === "DELETE"
      )
        return new Response(null, { status: 204 });
      const sharedMail = sharedMailTestReply(apiRequest, {
        organization: org,
        project,
        environment,
      });
      if (sharedMail) return sharedMail;
      if (url.pathname === "/v1/projects" && apiRequest.method === "POST")
        return Response.json(createdProject, { status: 202 });
      if (url.pathname === "/v1/me") return Response.json(currentIdentity);
      if (url.pathname === `/v1/operations/${deployment}` && apiRequest.method === "GET")
        return Response.json(uploadOperation);
      if (url.pathname === `/v1/operations/${deployment}:reconcile` && apiRequest.method === "POST")
        return Response.json(reconciliationReceipt, { status: 202 });
      if (url.pathname === `/v1/projects/${project}/source/uploads/${deployment}/files`) {
        const blob = apiBody as { path: string; content_base64: string; executable: boolean };
        const bytes = Buffer.from(blob.content_base64, "base64");
        const manifest = {
          path: blob.path,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          byte_length: bytes.length,
          executable: blob.executable,
        };
        return Response.json(
          alteredUploadResult === "malformed"
            ? { secret_value: "private-provider-result" }
            : {
                ...manifest,
                ...(alteredUploadResult === "path" ? { path: "src/Another.tsx" } : {}),
                ...(alteredUploadResult === "sha256" ? { sha256: `sha256:${"a".repeat(64)}` } : {}),
                ...(alteredUploadResult === "byte_length" ? { byte_length: bytes.length + 1 } : {}),
                ...(alteredUploadResult === "executable" ? { executable: !blob.executable } : {}),
              },
        );
      }
      if (url.pathname === `/v1/projects/${project}/source/uploads/${deployment}`)
        return Response.json(
          alteredUploadResult === "malformed"
            ? { secret_value: "private-provider-result" }
            : {
                ...uploadReceipt,
                ...(alteredUploadResult === "operation_id" ? { operation_id: project } : {}),
              },
        );
      if (
        url.pathname === `/v1/projects/${project}/source/uploads` ||
        url.pathname === `/v1/projects/${project}/source/uploads/${deployment}:commit` ||
        url.pathname === `/v1/projects/${project}/source:switch`
      )
        return Response.json(uploadOperation, { status: 202 });
      if (url.pathname.endsWith("/source/files")) {
        const bytes = binaryFile ? Buffer.from([255, 0, 1]) : Buffer.from(sourceText);
        return Response.json({
          commit_sha: commit,
          file: {
            path: "src/App.tsx",
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            byte_length: bytes.length,
            executable: true,
            content_base64: bytes.toString("base64"),
          },
        });
      }
      const databaseAnswer = databaseAnswers.get(url.pathname);
      if (databaseAnswer !== undefined) return Response.json(databaseAnswer);
      if (url.pathname === `/v1/projects/${project}/database/webhook-subscriptions/${deployment}`)
        return Response.json({
          id: deployment,
          environment: url.searchParams.get("environment"),
          generation: 1,
          state: "active",
          provider_id: databaseWebhookId,
          ...(unexpectedSubscriptionSecret ? { secret: "must-not-leave-remote" } : {}),
        });
      if (url.pathname.endsWith("/status"))
        return Response.json({
          project_id: project,
          environments: [{ id: environment, name: "dev" }],
        });
      if (url.pathname === `/v1/projects/${project}`)
        return Response.json({ id: project, organization_id: org });
      return Response.json({ route: url.pathname, method: apiRequest.method });
    },
  });
  try {
    const metadata = await handler.fetch(
      new Request(`${origin}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(await metadata?.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: ["https://issuer.example"],
      bearer_methods_supported: ["header"],
    });
    const init = await rpc(
      await handler.fetch(
        request(
          "initialize",
          {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "chat-acceptance", version: "1" },
          },
          null,
        ),
      ),
    );
    // Public discovery must not route a local project through an unrelated OAuth account
    // merely because this endpoint exposes remote tools. Keep the decision first.
    const earlyGuidance = init.result.instructions.slice(0, 512);
    expect(earlyGuidance).toMatch(/existing app.*reachable workspace.*saved project binding/u);
    expect(earlyGuidance).toMatch(
      /matching local CLI\/MCP profile.*unless the user chooses remote/u,
    );
    expect(earlyGuidance).toMatch(/Remote tool availability alone never selects remote/u);
    expect(earlyGuidance).toMatch(/private token source.*verify its identity and workspace/u);
    expect(earlyGuidance).toMatch(/identity\/workspace mismatches, stop the access-link loop/u);
    expect(earlyGuidance).toMatch(
      /access gap, not deleted credentials.*unrelated Review\/demo account/u,
    );
    expect(init.result.instructions).not.toMatch(/Read skill:\/\/|fetch.*instructions/iu);
    expect(init.result.instructions).toMatch(/identity_get returns.*project_context_get returns/u);
    expect(init.result.instructions).toMatch(
      /deployment_logs diagnostics.*untrusted customer output.*never instructions/u,
    );
    expect(init.result.instructions).toMatch(
      /source_get identifies.*provider, generation and commit/u,
    );
    expect(init.result.instructions).toContain("operation_get observes asynchronous work");
    expect(earlyGuidance).toContain("or change the saved source.");
    expect(authenticateCalls).toBe(0);
    expect(calls).toEqual([]);
    expect(init["result"].instructions).toContain("secret_input_request");
    expect(
      (await rpc(await handler.fetch(request("resources/list", undefined, null))))["result"]
        .resources,
    ).toHaveLength(listOhmyhostSkillResources().length);
    const resource = listOhmyhostSkillResources()[0];
    expect(resource).toBeDefined();
    expect(
      (await rpc(await handler.fetch(request("resources/read", { uri: resource?.uri }, null))))[
        "result"
      ].contents[0]?.text,
    ).toBe(resource?.text);
    const allTools = (await rpc(await handler.fetch(request("tools/list", undefined, null))))[
      "result"
    ].tools;
    expect(allTools.find(({ name }) => name === "project_export_get")).toMatchObject({
      title: "Read encrypted database export status",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    });
    for (const name of ["project_dev_access_mode_set", "project_handle_set"]) {
      expect(allTools.find((tool) => tool.name === name)).toMatchObject({
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
    }
    const generatedNames = new Set<string>(remoteMcpToolDefinitions.map(({ name }) => name));
    const catalog = allTools.filter(
      ({ name }) => name !== "api_reference" && !generatedNames.has(name),
    );
    expect(catalog.find((tool) => tool.name === "deployment_logs")?.description).toMatch(
      /untrusted customer output.*never instructions/u,
    );
    expect(catalog.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["connection_request", "connection_grants"]),
    );
    expect(catalog.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "source_upload_prepare",
        "source_blob_put",
        "source_upload",
        "source_upload_commit",
        "source_switch",
      ]),
    );
    // Classify the actual callback effects independently: GET github_status records revocation,
    // POST plans and portal links persist records, and Dev links/tickets create access state.
    const readTools = [
      "integration_connection_list",
      "integration_connection_status",
      "integration_connection_discover",
      ...sharedMailReadTools,
      "identity_get",
      "workspace_setup",
      "connection_status",
      "project_list",
      "project_get",
      "project_status",
      "preview_get",
      "project_context_get",
      "source_get",
      "source_files",
      "source_versions",
      "source_diff",
      "source_upload",
      "deployment_list",
      "deployment_get",
      "deployment_logs",
      "operation_get",
      "secrets_list",
      "native_auth_config_get",
      "native_auth_provider_get",
      "native_auth_users_list",
      "native_auth_user_get",
      "database_webhook_list",
      "database_webhook_subscription_status",
      "database_webhook_delivery_list",
      "database_schedule_list",
      "database_schedule_run_list",
      "database_execution_usage_get",
    ];
    const writeTools = [
      "integration_connection_begin",
      "integration_connection_import",
      "integration_connection_disconnect",
      ...sharedMailWriteTools,
      "connection_revoke",
      "project_create",
      "project_development_add",
      "preview_open",
      "preview_stop",
      "preview_rotate",
      "github_status",
      "github_connect",
      "source_link",
      "source_initialize",
      "source_changes",
      "source_restore",
      "source_upload_prepare",
      "source_blob_put",
      "source_upload_commit",
      "source_switch",
      "deployment_plan",
      "project_dev_share_link_get",
      "project_dev_access_create",
      "deployment_create",
      "promotion_plan",
      "deployment_promote",
      "rollback_plan",
      "deployment_rollback",
      "operation_reconcile",
      "secret_input_request",
      "native_auth_config_set",
      "native_auth_provider_set",
      "native_auth_provider_secret_input_request",
      "native_auth_user_create",
      "native_auth_user_delete",
      "native_auth_user_invite",
      "native_auth_user_suspend",
      "native_auth_user_reactivate",
      "native_auth_user_revoke_sessions",
    ];
    expect(readTools).toHaveLength(37);
    expect(writeTools).toHaveLength(49);
    expect(catalog).toHaveLength(86);
    expect(catalog.map((tool) => tool.name)).not.toContain(
      "database_webhook_subscription_activate",
    );
    expect(catalog.map((tool) => tool.name)).not.toContain(
      "database_webhook_subscription_deactivate",
    );
    expect(catalog.map((tool) => tool.name).sort()).toEqual([...readTools, ...writeTools].sort());
    expect(new Set(catalog.map((tool) => tool.title)).size).toBe(catalog.length);
    const apiReferences = await readApiReferences();
    for (const descriptor of catalog) {
      expect(descriptor.name.length).toBeLessThanOrEqual(64);
      expect(descriptor.title).toMatch(/^[A-Z][A-Za-z ]{2,79}$/u);
      expect(descriptor.description).not.toMatch(
        /Read skill:\/\/|then call|do not present|Continue with the user's app|Never ask the user/iu,
      );
      // A description links only to a contract operation's API reference, as its final sentence.
      const reference = / API reference: (\S+)\.$/u.exec(descriptor.description);
      if (reference !== null)
        expect([...apiReferences.values()], `${descriptor.name} links ${reference[1]}`).toContain(
          reference[1],
        );
      expect(descriptor.description.slice(0, reference?.index)).not.toMatch(/https?:|www\./iu);
      expect(descriptor.annotations).toMatchObject({
        title: descriptor.title,
        readOnlyHint: readTools.includes(descriptor.name),
        destructiveHint: writeTools.includes(descriptor.name),
      });
      expect(descriptor).toMatchObject({
        securitySchemes: [
          { type: "oauth2", scopes: ["openid", "profile", "email", "offline_access"] },
        ],
        _meta: {
          securitySchemes: [
            { type: "oauth2", scopes: ["openid", "profile", "email", "offline_access"] },
          ],
        },
        annotations: { openWorldHint: expect.any(Boolean) },
      });
    }
    expect(catalog.find((tool) => tool.name === "source_files")).toMatchObject({
      annotations: { openWorldHint: false },
    });
    expect(
      catalog.find((tool) => tool.name === "application_domain_identity_verify"),
    ).toMatchObject({
      annotations: { openWorldHint: true },
    });
    expect(catalog.find((tool) => tool.name === "deployment_promote")).toMatchObject({
      annotations: { openWorldHint: true },
    });
    for (const name of ["native_auth_user_create", "native_auth_user_invite"])
      expect(catalog.find((tool) => tool.name === name)).toMatchObject({
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
    for (const name of ["github_connect", "secret_input_request"])
      expect(catalog.find((tool) => tool.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      });
    for (const name of ["deployment_plan", "promotion_plan", "rollback_plan"])
      expect(catalog.find((tool) => tool.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      });
    expect(catalog.find((tool) => tool.name === "project_dev_access_create")).toMatchObject({
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    for (const name of [
      "connection_revoke",
      "source_changes",
      "source_restore",
      "source_upload_commit",
      "source_switch",
      "deployment_create",
      "deployment_promote",
      "deployment_rollback",
      "operation_reconcile",
    ])
      expect(catalog.find((tool) => tool.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      });
    for (const name of [
      "project_create",
      "project_development_add",
      "source_initialize",
      "source_upload_prepare",
      "source_blob_put",
      "project_dev_share_link_get",
    ])
      expect(catalog.find((tool) => tool.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      });
    for (const name of [
      "source_changes",
      "source_initialize",
      "source_upload_prepare",
      "source_blob_put",
      "source_upload",
      "source_upload_commit",
      "source_switch",
      "secret_input_request",
    ])
      expect(catalog.find((tool) => tool.name === name)).toMatchObject({
        annotations: { openWorldHint: false },
      });
    expect(catalog.find((tool) => tool.name === "source_upload")).toMatchObject({
      title: "Get source upload status",
      description: expect.stringMatching(
        /^Get the current status of a prepared source-file upload\./u,
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });
    expect(catalog.find((tool) => tool.name === "github_status")).toMatchObject({
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(catalog.find((tool) => tool.name === "source_link")).toMatchObject({
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
    expect(catalog.find((tool) => tool.name === "operation_reconcile")).toMatchObject({
      title: "Reconcile operation",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        required: expect.arrayContaining(["operation_id", "confirmed", "idempotency_key"]),
        additionalProperties: false,
        properties: {
          operation_id: { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
          confirmed: { type: "boolean", const: true },
          idempotency_key: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    });
    expect(catalog.find((tool) => tool.name === "secret_input_request")?.description).toMatch(
      /protected portal form.*needs no sign-in.*valid for one hour.*dead after the first save.*generate a value.*Never put the value in chat or tool arguments.*only configuration status/u,
    );
    expect(catalog.find((tool) => tool.name === "source_switch")?.description).toMatch(
      /user's explicit source-switch request.*original GitHub connection\/generation.*earlier generation-bound plans\/events are fenced/u,
    );
    expect(catalog.find((tool) => tool.name === "project_dev_access_create")?.description).toMatch(
      /issuing a new ticket revokes its unused predecessor/u,
    );
    // Claude directory review asked these two tools to reference the REST operation they call.
    for (const [name, operationId] of [
      ["source_files", "listManagedSourceFiles"],
      ["source_blob_put", "putManagedSourceBlob"],
    ] as const) {
      const sentence = `. API reference: ${String(apiReferences.get(operationId))}.`;
      expect(
        catalog.find((tool) => tool.name === name)?.description.slice(-sentence.length),
        name,
      ).toBe(sentence);
    }
    expect(JSON.stringify(catalog)).not.toMatch(
      /working_directory|password_file|secret_value|profile_name/u,
    );
    expect(authenticateCalls).toBe(0);
    const handoff = await access.startGithub(principal, org, "catalog-status");
    // Each database read: the exact route, method, query and the answer the tool must return.
    // Non-default values prove each argument is forwarded; the default rows prove `dev`.
    const databasePath = `/v1/projects/${project}/database`;
    const usageWindow = { from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };
    const databaseReads = [
      {
        name: "database_webhook_list",
        arguments: { project_id: project, environment: "prod" },
        pathname: `${databasePath}/webhooks`,
        query: { environment: "prod" },
        answer: databaseWebhookPage,
      },
      {
        name: "database_schedule_list",
        arguments: { project_id: project, environment: "prod" },
        pathname: `${databasePath}/schedules`,
        query: { environment: "prod" },
        answer: databaseSchedulePage,
      },
      {
        name: "database_schedule_list",
        arguments: { project_id: project },
        pathname: `${databasePath}/schedules`,
        query: { environment: "dev" },
        answer: databaseSchedulePage,
      },
      {
        name: "database_webhook_delivery_list",
        arguments: {
          project_id: project,
          environment: "prod",
          webhook_id: databaseWebhookId,
          limit: 10,
          cursor: "cursor-page-2",
        },
        pathname: `${databasePath}/webhook-deliveries`,
        query: {
          environment: "prod",
          webhook_id: databaseWebhookId,
          limit: "10",
          cursor: "cursor-page-2",
        },
        answer: databaseDeliveryPage,
      },
      {
        name: "database_webhook_delivery_list",
        arguments: { project_id: project },
        pathname: `${databasePath}/webhook-deliveries`,
        query: { environment: "dev", limit: "50" },
        answer: databaseDeliveryPage,
      },
      {
        name: "database_schedule_run_list",
        arguments: { project_id: project, environment: "prod", name: "nightly_rollup", limit: 5 },
        pathname: `${databasePath}/schedules/nightly_rollup/runs`,
        query: { environment: "prod", limit: "5" },
        answer: databaseRunPage,
      },
      {
        name: "database_execution_usage_get",
        arguments: {
          project_id: project,
          environment: "prod",
          ...usageWindow,
          granularity: "day",
          limit: 10,
          cursor: "cursor-usage-2",
        },
        pathname: `${databasePath}/execution-usage`,
        query: {
          environment: "prod",
          ...usageWindow,
          granularity: "day",
          limit: "10",
          cursor: "cursor-usage-2",
        },
        answer: databaseUsagePage,
      },
      {
        name: "database_execution_usage_get",
        arguments: { project_id: project, ...usageWindow, granularity: "hour" },
        pathname: `${databasePath}/execution-usage`,
        query: { environment: "dev", ...usageWindow, granularity: "hour", limit: "50" },
        answer: databaseUsagePage,
      },
    ];
    const cases: Record<string, Record<string, unknown>> = {
      ...sharedMailMcpCases({ organization: org, project, environment }),
      integration_connection_begin: {
        organization_id: org,
        project_id: project,
        environment_id: environment,
        idempotency_key: "one",
      },
      integration_connection_list: { organization_id: org },
      integration_connection_status: { organization_id: org, request_id: "a".repeat(64) },
      integration_connection_discover: {
        organization_id: org,
        project_id: project,
        environment_id: environment,
        grant_id: deployment,
        provider_organization_id: 1,
        team_id: 2,
      },
      integration_connection_import: {
        organization_id: org,
        grant_id: deployment,
        project_id: project,
        environment_id: environment,
        provider_organization_id: 1,
        team_id: 2,
        connection_id: 3,
        idempotency_key: "import",
      },
      integration_connection_disconnect: {
        organization_id: org,
        grant_id: deployment,
        idempotency_key: "disconnect",
        confirmed: true,
      },
      identity_get: {},
      workspace_setup: {},
      connection_status: { request_id: handoff.request_id },
      project_list: { limit: 3 },
      project_create: {
        organization_id: org,
        name: "Chat application",
        region: "eu",
        include_development_environment: false,
        idempotency_key: "create-one",
      },
      project_development_add: { project_id: project, idempotency_key: "add-dev" },
      database_webhook_subscription_status: { project_id: project, subscription_id: deployment },
      project_get: { project_id: project },
      project_status: { project_id: project },
      preview_get: { project_id: project, environment: "prod" },
      preview_open: { project_id: project, environment: "prod" },
      preview_stop: { project_id: project, environment: "prod", idempotency_key: "preview-stop" },
      preview_rotate: {
        project_id: project,
        environment: "prod",
        idempotency_key: "preview-rotate",
      },
      project_context_get: { project_id: project },
      source_get: { project_id: project },
      github_status: { organization_id: org },
      github_connect: { organization_id: org, idempotency_key: "github-connect" },
      source_link: {
        project_id: project,
        repository_owner: "owner",
        repository_name: "application",
        idempotency_key: "link-github",
      },
      source_initialize: {
        project_id: project,
        expected_source_generation: 0,
        idempotency_key: "initialize-one",
      },
      source_files: { project_id: project, commit_sha: commit, path: "src/App.tsx" },
      source_versions: { project_id: project, limit: 3, before_commit_sha: commit },
      source_diff: { project_id: project, from_commit_sha: commit, to_commit_sha: "b".repeat(40) },
      source_changes: {
        project_id: project,
        expected_source_generation: 1,
        expected_commit_sha: commit,
        message: "Update homepage",
        changes: [{ path: "src/App.tsx", content_base64: "b2s=" }],
        idempotency_key: "commit-one",
      },
      source_restore: {
        project_id: project,
        expected_source_generation: 1,
        expected_commit_sha: commit,
        message: "Restore homepage",
        restore_commit_sha: "b".repeat(40),
        idempotency_key: "restore-one",
      },
      source_upload_prepare: {
        project_id: project,
        mode: "commit",
        expected_source_generation: 1,
        expected_source_connection_id: sourceConnection,
        expected_commit_sha: commit,
        message: "Upload current application",
        idempotency_key: "upload-prepare-one",
      },
      source_blob_put: {
        project_id: project,
        operation_id: deployment,
        path: sourceManifest.path,
        content_text: sourceText,
        executable: true,
        idempotency_key: "upload-text-one",
      },
      source_upload: { project_id: project, operation_id: deployment },
      source_upload_commit: {
        project_id: project,
        operation_id: deployment,
        expected_source_generation: 1,
        files: [sourceManifest],
        idempotency_key: "upload-commit-one",
      },
      source_switch: {
        project_id: project,
        upload_operation_id: deployment,
        expected_source_connection_id: sourceConnection,
        expected_source_generation: 1,
        files: [sourceManifest],
        idempotency_key: "upload-switch-one",
      },
      deployment_plan: { project_id: project, commit_sha: commit },
      project_dev_share_link_get: { project_id: project },
      project_dev_access_create: { project_id: project },
      deployment_create: { project_id: project, plan_id: deployment, idempotency_key: "build-one" },
      deployment_list: { project_id: project, limit: 5 },
      deployment_get: { project_id: project, deployment_id: deployment },
      deployment_logs: { project_id: project, deployment_id: deployment, limit: 5 },
      operation_get: { operation_id: deployment },
      operation_reconcile: {
        operation_id: deployment,
        confirmed: true,
        idempotency_key: "reconcile-original-one",
      },
      promotion_plan: { project_id: project, source_deployment_id: deployment },
      deployment_promote: {
        project_id: project,
        source_deployment_id: deployment,
        if_match: "current",
        confirmation_token: "confirmed",
        idempotency_key: "publish-one",
      },
      rollback_plan: { project_id: project, deployment_id: deployment },
      deployment_rollback: {
        project_id: project,
        deployment_id: deployment,
        if_match: "current",
        confirmation_token: "confirmed",
        idempotency_key: "rollback-one",
      },
      secret_input_request: { project_id: project, name: "PAYMENT_KEY" },
      secrets_list: { project_id: project, environment_id: environment },
      native_auth_config_get: { project_id: project, environment_id: environment },
      native_auth_config_set: {
        project_id: project,
        environment_id: environment,
        configuration_revision: 1,
        enabled: false,
        signup_policy: "open",
        application_name: "App",
        idempotency_key: "auth-config",
      },
      native_auth_provider_get: {
        project_id: project,
        environment_id: environment,
        provider: "google",
      },
      native_auth_provider_set: {
        project_id: project,
        environment_id: environment,
        provider: "google",
        configuration_revision: 1,
        enabled: false,
        idempotency_key: "provider-config",
      },
      native_auth_provider_secret_input_request: {
        project_id: project,
        environment_id: environment,
        provider: "google",
        configuration_revision: 1,
        enabled: false,
      },
      native_auth_users_list: { project_id: project, environment_id: environment },
      native_auth_user_create: {
        project_id: project,
        environment_id: environment,
        email: "user@example.test",
        idempotency_key: "invite-user",
      },
      native_auth_user_get: {
        project_id: project,
        environment_id: environment,
        user_id: "00000000-0000-4000-8000-000000000001",
      },
      native_auth_user_delete: {
        project_id: project,
        environment_id: environment,
        user_id: "00000000-0000-4000-8000-000000000001",
        idempotency_key: "delete-user",
      },
      native_auth_user_invite: {
        project_id: project,
        environment_id: environment,
        user_id: "00000000-0000-4000-8000-000000000001",
        idempotency_key: "invite-again",
      },
      native_auth_user_suspend: {
        project_id: project,
        environment_id: environment,
        user_id: "00000000-0000-4000-8000-000000000001",
        idempotency_key: "suspend",
      },
      native_auth_user_reactivate: {
        project_id: project,
        environment_id: environment,
        user_id: "00000000-0000-4000-8000-000000000001",
        idempotency_key: "reactivate",
      },
      native_auth_user_revoke_sessions: {
        project_id: project,
        environment_id: environment,
        user_id: "00000000-0000-4000-8000-000000000001",
        idempotency_key: "revoke",
      },
      connection_revoke: {},
    };
    expect(catalog.map((item) => item.name).sort()).toEqual(
      [...new Set([...Object.keys(cases), ...databaseReads.map((read) => read.name)])].sort(),
    );
    const rejectedProviderSecret = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "native_auth_provider_set",
          arguments: {
            ...cases["native_auth_provider_set"],
            clientSecret: "must-not-be-a-tool-argument",
          },
        }),
      ),
    );
    expect(rejectedProviderSecret.result.isError).toBe(true);
    expect(JSON.stringify(rejectedProviderSecret)).not.toContain("must-not-be-a-tool-argument");
    for (const [name, args] of Object.entries(cases)) {
      const reply = await rpc(
        await handler.fetch(request("tools/call", { name, arguments: args })),
      );
      expect(reply["result"], name).toBeDefined();
      expect(reply["result"].isError, name).not.toBe(true);
      if (name === "identity_get")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(currentIdentity);
      if (name === "project_create")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(createdProject);
      if (name === "source_blob_put")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(sourceManifest);
      if (name === "source_upload")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(uploadReceipt);
      if (["source_upload_prepare", "source_upload_commit", "source_switch"].includes(name))
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(uploadOperation);
      if (name === "operation_get")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(uploadOperation);
      if (name === "operation_reconcile")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toEqual(reconciliationReceipt);
      if (name === "deployment_logs")
        expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toMatchObject({
          untrusted_customer_output: true,
        });
    }
    expect(
      calls.find(
        (call) =>
          new URL(call.request.url).pathname === "/v1/projects" && call.request.method === "POST",
      )?.body,
    ).toMatchObject({ include_development_environment: false });
    const addDev = calls.find(
      (call) => new URL(call.request.url).pathname === `/v1/projects/${project}/environments/dev`,
    );
    expect(addDev?.request.headers.get("idempotency-key")).toBe("add-dev");
    expect(addDev?.body).toEqual({});
    expect(
      calls.find(
        (call) => new URL(call.request.url).pathname === `/v1/projects/${project}/deployments:plan`,
      )?.body,
    ).toEqual({ commit_sha: commit });
    const subscriptionCalls = calls.filter((call) =>
      new URL(call.request.url).pathname.includes("/database/webhook-subscriptions/"),
    );
    expect(subscriptionCalls.map((call) => call.request.method)).toEqual(["GET"]);
    unexpectedSubscriptionSecret = true;
    const unsafeStatus = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "database_webhook_subscription_status",
          arguments: { project_id: project, subscription_id: deployment },
        }),
      ),
    );
    expect(unsafeStatus.result.isError).toBe(true);
    expect(JSON.stringify(unsafeStatus)).not.toContain("must-not-leave-remote");
    unexpectedSubscriptionSecret = false;
    for (const read of databaseReads) {
      const before = calls.length;
      const reply = await rpc(
        await handler.fetch(request("tools/call", { name: read.name, arguments: read.arguments })),
      );
      expect(reply.result.isError, read.name).not.toBe(true);
      expect(JSON.parse(reply.result.content[0]?.text ?? "{}"), read.name).toEqual(read.answer);
      const made = calls.slice(before);
      expect(
        made.map((call) => call.request.method),
        read.name,
      ).toEqual(["GET"]);
      const sent = new URL(made[0]?.request.url ?? origin);
      expect(sent.pathname, read.name).toBe(read.pathname);
      expect(Object.fromEntries(sent.searchParams), read.name).toEqual(read.query);
    }
    for (const invalid of [
      {
        name: "database_schedule_run_list",
        arguments: { project_id: project, name: "../status" },
      },
      {
        name: "database_webhook_delivery_list",
        arguments: { project_id: project, webhook_id: "whk_x" },
      },
      {
        name: "database_webhook_delivery_list",
        arguments: { project_id: project, webhook_id: `${databaseWebhookId}&environment=prod` },
      },
      { name: "database_webhook_delivery_list", arguments: { project_id: project, limit: 101 } },
      { name: "database_webhook_list", arguments: { project_id: project, environment: "staging" } },
      {
        name: "database_schedule_run_list",
        arguments: { project_id: project, name: "nightly_rollup", limit: 0 },
      },
      {
        name: "database_schedule_run_list",
        arguments: { project_id: project, name: "nightly_rollup", limit: 51 },
      },
      {
        name: "database_execution_usage_get",
        arguments: {
          project_id: project,
          from: "2026-10-30T00:00:00Z",
          to: usageWindow.to,
          granularity: "hour",
        },
      },
      {
        name: "database_execution_usage_get",
        arguments: { project_id: project, ...usageWindow, granularity: "week" },
      },
      {
        name: "database_execution_usage_get",
        arguments: { project_id: project, ...usageWindow, granularity: "hour", limit: 101 },
      },
    ]) {
      const before = calls.length;
      const rejected = await rpc(
        await handler.fetch(
          request("tools/call", { name: invalid.name, arguments: invalid.arguments }),
        ),
      );
      expect(rejected.result.isError, invalid.name).toBe(true);
      expect(calls, invalid.name).toHaveLength(before);
    }
    const reconciliationRequest = calls.filter(
      (call) => new URL(call.request.url).pathname === `/v1/operations/${deployment}:reconcile`,
    );
    expect(reconciliationRequest).toHaveLength(1);
    expect(reconciliationRequest[0]?.request.url).toBe(
      `${origin}/v1/operations/${deployment}:reconcile`,
    );
    expect(reconciliationRequest[0]?.request.method).toBe("POST");
    expect(reconciliationRequest[0]?.request.headers.get("Idempotency-Key")).toBe(
      "reconcile-original-one",
    );
    expect(reconciliationRequest[0]?.request.body).toBeNull();
    expect(reconciliationRequest[0]?.body).toBeUndefined();
    for (const arguments_ of [
      { operation_id: deployment, idempotency_key: "missing-confirmation" },
      { ...cases["operation_reconcile"], confirmed: false },
      { ...cases["operation_reconcile"], confirmed: "true" },
      { confirmed: true, idempotency_key: "missing-operation" },
      { ...cases["operation_reconcile"], operation_id: "not-an-operation" },
      { operation_id: deployment, confirmed: true },
      { ...cases["operation_reconcile"], idempotency_key: "" },
      { ...cases["operation_reconcile"], idempotency_key: " ".repeat(3) },
      { ...cases["operation_reconcile"], idempotency_key: "x".repeat(129) },
      { ...cases["operation_reconcile"], idempotency_key: "reconcile\u0000original" },
      { ...cases["operation_reconcile"], project_id: project },
    ]) {
      const before = calls.length;
      const rejected = await rpc(
        await handler.fetch(
          request("tools/call", { name: "operation_reconcile", arguments: arguments_ }),
        ),
      );
      expect(rejected.result.isError).toBe(true);
      const rejectionText = rejected.result.content[0]?.text ?? "";
      if (rejectionText.startsWith("{"))
        expect(JSON.parse(rejectionText)).toMatchObject({ code: "invalid_request" });
      else expect(rejectionText).toContain("Input validation error");
      expect(calls).toHaveLength(before);
    }
    const uploadRequests = [
      {
        name: "source_upload_prepare",
        method: "POST",
        suffix: "/source/uploads",
        key: "upload-prepare-one",
        body: {
          mode: "commit",
          expected_source_generation: 1,
          expected_source_connection_id: sourceConnection,
          expected_commit_sha: commit,
          message: "Upload current application",
        },
      },
      {
        name: "source_blob_put",
        method: "PUT",
        suffix: `/source/uploads/${deployment}/files`,
        key: "upload-text-one",
        body: {
          path: sourceManifest.path,
          content_base64: sourceBytes.toString("base64"),
          sha256: sourceManifest.sha256,
          executable: true,
        },
      },
      {
        name: "source_upload",
        method: "GET",
        suffix: `/source/uploads/${deployment}`,
        key: null,
        body: undefined,
      },
      {
        name: "source_upload_commit",
        method: "POST",
        suffix: `/source/uploads/${deployment}:commit`,
        key: "upload-commit-one",
        body: { expected_source_generation: 1, files: [sourceManifest] },
      },
      {
        name: "source_switch",
        method: "POST",
        suffix: "/source:switch",
        key: "upload-switch-one",
        body: {
          upload_operation_id: deployment,
          expected_source_connection_id: sourceConnection,
          expected_source_generation: 1,
          files: [sourceManifest],
        },
      },
    ];
    for (const expected of uploadRequests) {
      const observed = calls.find(
        (call) => call.request.url === `${origin}/v1/projects/${project}${expected.suffix}`,
      );
      expect(observed, expected.name).toBeDefined();
      expect(observed?.request.method, expected.name).toBe(expected.method);
      expect(observed?.request.headers.get("idempotency-key"), expected.name).toBe(expected.key);
      expect(observed?.body, expected.name).toEqual(expected.body);
    }
    expect(calls.length).toBeGreaterThan(20);
    for (const call of calls) {
      expect(new URL(call.request.url).pathname).toMatch(/^\/v1\//u);
      expect(call.request.headers.has("authorization")).toBe(false);
      expect(call.request.headers.has("cookie")).toBe(false);
      expect(call.principal).toBe(principal);
    }
    const defaultSourceRequest = calls.find(
      (call) => new URL(call.request.url).pathname === `/v1/projects/${project}/source`,
    );
    expect(defaultSourceRequest?.request.url).toBe(`${origin}/v1/projects/${project}/source`);
    const binding = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_get",
          arguments: { project_id: project, include_binding: true },
        }),
      ),
    );
    expect(binding.result.isError).not.toBe(true);
    expect(calls.at(-1)?.request.url).toBe(
      `${origin}/v1/projects/${project}/source?include_binding=true`,
    );
    const beforeWrongFlag = calls.length;
    const wrongFlag = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_get",
          arguments: { project_id: project, include_binding: "true" },
        }),
      ),
    );
    expect(wrongFlag.result.isError).toBe(true);
    expect(calls).toHaveLength(beforeWrongFlag);
    expect(calls.find((call) => call.request.url.endsWith("/source/changes"))?.body).toMatchObject({
      changes: [{ path: "src/App.tsx", content_base64: "b2s=", executable: false }],
    });
    const textRead = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_files",
          arguments: { project_id: project, path: "src/App.tsx" },
        }),
      ),
    );
    expect(JSON.parse(textRead.result.content[0]?.text ?? "{}")).toMatchObject({
      commit_sha: commit,
      file: { content_text: sourceText, encoding: "utf8", executable: true },
    });
    expect(calls.at(-1)?.request.url).not.toContain("format=");
    const textArgs = {
      project_id: project,
      expected_source_generation: 1,
      expected_commit_sha: commit,
      message: "UTF8 source",
      changes: [{ path: "src/App.tsx", content_text: sourceText, executable: true }],
      idempotency_key: "utf8-edit",
    };
    const textWrite = await rpc(
      await handler.fetch(request("tools/call", { name: "source_changes", arguments: textArgs })),
    );
    expect(textWrite.result.isError).not.toBe(true);
    expect(calls.at(-1)?.body).toMatchObject({
      changes: [
        {
          path: "src/App.tsx",
          content_base64: Buffer.from(sourceText).toString("base64"),
          executable: true,
        },
      ],
    });
    expect(JSON.stringify(calls.at(-1)?.body)).not.toContain("content_text");
    const beforeInvalid = calls.length;
    const ambiguous = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_changes",
          arguments: {
            ...textArgs,
            changes: [{ path: "src/App.tsx", content_text: sourceText, content_base64: "YQ==" }],
          },
        }),
      ),
    );
    expect(ambiguous.result.isError).toBe(true);
    expect(JSON.parse(ambiguous.result.content[0]?.text ?? "{}")).toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toHaveLength(beforeInvalid);
    const explicitBase64 = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_files",
          arguments: { project_id: project, path: "src/App.tsx", format: "base64" },
        }),
      ),
    );
    expect(JSON.parse(explicitBase64.result.content[0]?.text ?? "{}")).toMatchObject({
      file: { content_base64: Buffer.from(sourceText).toString("base64") },
    });
    binaryFile = true;
    const binaryRead = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_files",
          arguments: { project_id: project, path: "src/App.tsx" },
        }),
      ),
    );
    expect(JSON.parse(binaryRead.result.content[0]?.text ?? "{}")).toMatchObject({
      file: {
        content_base64: "/wAB",
        encoding: "base64",
        guidance: expect.stringContaining("Binary"),
      },
    });
    binaryFile = false;
    const blobCoordinates = {
      project_id: project,
      operation_id: deployment,
      path: "public/icon.bin",
      idempotency_key: "upload-binary",
    };
    const binaryBytes = Buffer.from([255, 0, 1]);
    const binaryUpload = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_blob_put",
          arguments: { ...blobCoordinates, content_base64: binaryBytes.toString("base64") },
        }),
      ),
    );
    expect(binaryUpload.result.isError).not.toBe(true);
    expect(JSON.parse(binaryUpload.result.content[0]?.text ?? "{}")).toEqual({
      path: blobCoordinates.path,
      sha256: `sha256:${createHash("sha256").update(binaryBytes).digest("hex")}`,
      byte_length: binaryBytes.length,
      executable: false,
    });
    expect(calls.at(-1)?.body).toEqual({
      path: blobCoordinates.path,
      content_base64: "/wAB",
      sha256: `sha256:${createHash("sha256").update(binaryBytes).digest("hex")}`,
      executable: false,
    });
    const emptyUpload = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "source_blob_put",
          arguments: { ...blobCoordinates, content_text: "", idempotency_key: "upload-empty" },
        }),
      ),
    );
    expect(emptyUpload.result.isError).not.toBe(true);
    expect(JSON.parse(emptyUpload.result.content[0]?.text ?? "{}")).toEqual({
      path: blobCoordinates.path,
      sha256: `sha256:${createHash("sha256").update("").digest("hex")}`,
      byte_length: 0,
      executable: false,
    });
    for (const mode of ["initialize", "commit", "switch"] as const) {
      const prepared = await rpc(
        await handler.fetch(
          request("tools/call", {
            name: "source_upload_prepare",
            arguments: {
              ...cases["source_upload_prepare"],
              mode,
              expected_commit_sha: mode === "commit" ? commit : null,
              expected_source_connection_id: mode === "initialize" ? null : sourceConnection,
              expected_source_generation: mode === "initialize" ? 0 : 1,
              idempotency_key: `upload-prepare-${mode}`,
            },
          }),
        ),
      );
      expect(prepared.result.isError, mode).not.toBe(true);
      expect(calls.at(-1)?.body).toMatchObject({
        mode,
        expected_commit_sha: mode === "commit" ? commit : null,
        expected_source_connection_id: mode === "initialize" ? null : sourceConnection,
      });
    }
    const invalidBlobs: Array<Record<string, unknown>> = [
      { content_text: "x", content_base64: "eA==" },
      {},
      { content_base64: null },
      { content_base64: "YR==" },
      { content_base64: "eA===" },
      { content_text: "\ud800" },
      { content_text: "a".repeat(2 * 1024 * 1024 + 1) },
      { content_text: "é".repeat(1024 * 1024 + 1) },
      { content_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
      { content_text: "x", path: "../private" },
      { content_text: "x", path: ".env" },
      { content_text: "x", path: "/tmp/private" },
      { content_text: "x", directory: "/tmp/private" },
      { content_text: "x", sha256: sourceManifest.sha256 },
    ];
    const invalidRequests: Array<{ name: string; arguments: Record<string, unknown> }> =
      invalidBlobs.map((invalid) => ({
        name: "source_blob_put",
        arguments: { ...blobCoordinates, ...invalid },
      }));
    for (const invalid of [
      { mode: "initialize", expected_commit_sha: null },
      { mode: "switch" },
      { expected_source_connection_id: null },
      { expected_source_generation: 2147483647 },
    ])
      invalidRequests.push({
        name: "source_upload_prepare",
        arguments: { ...cases["source_upload_prepare"], ...invalid },
      });
    for (const files of [
      [sourceManifest, sourceManifest],
      [{ ...sourceManifest, sha256: "sha256:invalid" }],
      [{ ...sourceManifest, byte_length: 2 * 1024 * 1024 + 1 }],
      Array.from({ length: 5 }, (_, index) => ({
        ...sourceManifest,
        path: `public/large-${index}.bin`,
        byte_length: 2 * 1024 * 1024,
      })),
      Array.from({ length: 2001 }, (_, index) => ({
        ...sourceManifest,
        path: `src/file-${index}.ts`,
      })),
    ])
      for (const name of ["source_upload_commit", "source_switch"])
        invalidRequests.push({ name, arguments: { ...cases[name], files } });
    for (const invalid of invalidRequests) {
      const before = calls.length;
      const rejected = await rpc(
        await handler.fetch(
          request("tools/call", { name: invalid.name, arguments: invalid.arguments }),
        ),
      );
      expect(rejected.result.isError, invalid.name).toBe(true);
      const rejectionText = rejected.result.content[0]?.text ?? "";
      if (rejectionText.startsWith("{"))
        expect(JSON.parse(rejectionText), invalid.name).toMatchObject({ code: "invalid_request" });
      else expect(rejectionText, invalid.name).toContain("Input validation error");
      expect(calls, invalid.name).toHaveLength(before);
      expect(JSON.stringify(rejected)).not.toContain("/tmp/private");
    }
    for (const { name, alteration } of [
      { name: "source_upload", alteration: "malformed" },
      { name: "source_blob_put", alteration: "malformed" },
      { name: "source_upload", alteration: "operation_id" },
      { name: "source_blob_put", alteration: "path" },
      { name: "source_blob_put", alteration: "sha256" },
      { name: "source_blob_put", alteration: "byte_length" },
      { name: "source_blob_put", alteration: "executable" },
    ] as const) {
      alteredUploadResult = alteration;
      const rejectedResult = await rpc(
        await handler.fetch(request("tools/call", { name, arguments: cases[name] })),
      );
      expect(rejectedResult.result.isError, `${name}:${alteration}`).toBe(true);
      expect(
        JSON.parse(rejectedResult.result.content[0]?.text ?? "{}"),
        `${name}:${alteration}`,
      ).toMatchObject({ code: "service_unavailable" });
      expect(JSON.stringify(rejectedResult)).not.toContain("private-provider-result");
      expect(JSON.stringify(rejectedResult)).not.toContain("src/Another.tsx");
    }
    alteredUploadResult = null;
    expect(
      calls.find((call) => call.request.url.endsWith(":promote"))?.request.headers.get("if-match"),
    ).toBe("current");
    failureStatus = 409;
    const failure = await rpc(
      await handler.fetch(
        request("tools/call", { name: "source_get", arguments: { project_id: project } }),
      ),
    );
    expect(failure["result"].isError).toBe(true);
    expect(JSON.stringify(failure)).toContain("version_conflict");
    expect(JSON.stringify(failure)).not.toContain("provider-token");
    failureBody = {
      code: "reconciliation_exhausted",
      detail: "provider-token-must-never-leak",
      retryable: false,
    };
    const exhausted = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "operation_reconcile",
          arguments: cases["operation_reconcile"],
        }),
      ),
    );
    expect(exhausted.result.isError).toBe(true);
    expect(JSON.parse(exhausted.result.content[0]?.text ?? "{}")).toEqual({
      code: "reconciliation_exhausted",
      status: 409,
      retryable: false,
    });
    expect(JSON.stringify(exhausted)).not.toContain("provider-token");
    // A conversion refusal reaches the chat only as the catalog sentence the shared catalog
    // re-renders; any other upstream detail is dropped and the policy action stands in.
    const conversion =
      '"apps/web/package.json" declares next 16.4.0, which ohmyho.st does not admit; use next 16.4.1 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.';
    const policyAction = PROBLEM_POLICY.framework_conversion_required.restAction;
    for (const [detail, expected] of [
      [conversion, { message: conversion, suggested_action: conversion }],
      ["provider-token-must-never-leak", { suggested_action: policyAction }],
      [`${conversion} provider-token-must-never-leak`, { suggested_action: policyAction }],
      [conversion.replace("apps/web", "../provider-token"), { suggested_action: policyAction }],
      [{ provider: "provider-token-must-never-leak" }, { suggested_action: policyAction }],
    ] as const) {
      failureBody = { code: "framework_conversion_required", detail, retryable: false };
      const refused = await rpc(
        await handler.fetch(
          request("tools/call", {
            name: "deployment_plan",
            arguments: { project_id: project, commit_sha: commit },
          }),
        ),
      );
      expect(refused.result.isError).toBe(true);
      expect(JSON.parse(refused.result.content[0]?.text ?? "{}")).toEqual({
        code: "framework_conversion_required",
        status: 409,
        retryable: false,
        ...expected,
      });
      expect(JSON.stringify(refused)).not.toContain("provider-token");
    }
    disconnected = true;
    const blockedAfterDisconnect = await rpc(
      await handler.fetch(request("tools/call", { name: "project_list", arguments: {} })),
    );
    expect(blockedAfterDisconnect.result.isError).toBe(true);
    const revoked = JSON.parse(blockedAfterDisconnect.result.content[0]?.text ?? "{}");
    expect(revoked.code).toBe("connection_revoked");
    // A revoked connector needs reconnecting; a workspace-membership instruction would send the agent elsewhere.
    expect(revoked.suggested_action).toMatch(/remove.*add/iu);
    expect(revoked.suggested_action).not.toMatch(/workspace/iu);
    // The canonical policy names the recovery, so REST, the SDK and this tool give the same text.
    expect(revoked.suggested_action).toBe(PROBLEM_POLICY.connection_revoked.action);
    fixture.setDisconnectPending(true);
    const pendingDisconnect = await rpc(
      await handler.fetch(request("tools/call", { name: "connection_revoke", arguments: {} })),
    );
    expect(pendingDisconnect.result.isError).not.toBe(true);
    expect(JSON.parse(pendingDisconnect.result.content[0]?.text ?? "{}")).toMatchObject({
      state: "pending",
    });
    fixture.setDisconnectPending(false);
    const retryDisconnect = await rpc(
      await handler.fetch(request("tools/call", { name: "connection_revoke", arguments: {} })),
    );
    expect(retryDisconnect.result.isError).not.toBe(true);
    disconnected = false;
    // A 403 returns the canonical recovery action; upstream detail never reaches the chat.
    const forbiddenAction = PROBLEM_POLICY.forbidden.restAction;
    failureStatus = 403;
    failureBody = {
      code: "forbidden",
      detail: "provider-token-must-never-leak",
      retryable: false,
    };
    const forbidden = await rpc(
      await handler.fetch(
        request("tools/call", { name: "project_get", arguments: { project_id: project } }),
      ),
    );
    expect(forbidden.result.isError).toBe(true);
    expect(JSON.parse(forbidden.result.content[0]?.text ?? "{}")).toEqual({
      code: "forbidden",
      status: 403,
      retryable: false,
      suggested_action: forbiddenAction,
    });
    expect(JSON.stringify(forbidden)).not.toContain("provider-token");
    failureStatus = 0;
    // The portal refuses an environment the project does not have; the same next step applies.
    const portalDenied = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "secret_input_request",
          arguments: { project_id: project, environment: "prod", name: "PAYMENT_KEY" },
        }),
      ),
    );
    expect(portalDenied.result.isError).toBe(true);
    expect(JSON.parse(portalDenied.result.content[0]?.text ?? "{}")).toEqual({
      code: "forbidden",
      message: "This request is unavailable to the connected account.",
      suggested_action: forbiddenAction,
    });
    lateAuthentication = 1;
    const runtimeChallenge = await rpc(
      await handler.fetch(request("tools/call", { name: "identity_get", arguments: {} })),
    );
    expect(runtimeChallenge["result"]).toMatchObject({
      _meta: {
        "mcp/www_authenticate": [
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        ],
      },
    });
    lateAuthentication = null;
    expect(
      (
        await handler.fetch(request("tools/call", { name: "identity_get", arguments: {} }, null))
      )?.headers.get("www-authenticate"),
    ).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(
      (
        await handler.fetch(
          request("tools/call", { name: "identity_get", arguments: {} }, "invalid-token"),
        )
      )?.status,
    ).toBe(401);
    authUnavailable = true;
    expect(
      (await handler.fetch(request("tools/call", { name: "identity_get", arguments: {} })))?.status,
    ).toBe(503);
    expect(
      (
        await handler.fetch(
          new Request(`${origin}/mcp`, {
            method: "POST",
            headers: { origin: "https://evil.example" },
          }),
        )
      )?.status,
    ).toBe(403);
    expect((await handler.fetch(new Request("https://foreign.example/mcp")))?.status).toBe(403);
    expect(
      (await handler.fetch(new Request(`${origin}/mcp`, { method: "POST", body: "[{}]" })))?.status,
    ).toBe(400);
    expect(await handler.fetch(new Request(`${origin}/unrelated`))).toBeNull();
  } finally {
    await handler.close();
  }
});

it("binds one-use portal consent and write-only secrets to the verified browser user, client, consent and CSRF", async () => {
  const fixture = testStore(),
    access = makeAccess(fixture.store);
  let browserIdentity: AuthenticatedPrincipal | null = browser;
  let failSecret = false,
    failGithub = false;
  const profileUserId = "user_test";
  let projectName = "Chat application";
  const emptyProjects = false;
  const secretCalls: Array<{ request: Request; body: unknown; identity: AuthenticatedPrincipal }> =
    [];
  const secretResponse = async (apiRequest: Request, identity: AuthenticatedPrincipal) => {
    secretCalls.push({ request: apiRequest, identity, body: await apiRequest.json() });
    return Response.json(
      failSecret ? { detail: "private-provider-error" } : { name: "PAYMENT_KEY", revision: 1 },
      { status: failSecret ? 503 : 200 },
    );
  };
  const dependencies = {
    access,
    projects: { getCustomerProject: async () => ({ name: projectName }) },
    dispatchHandoff: (apiRequest: Request, handoff: McpPortalHandoff) =>
      secretResponse(apiRequest, {
        actorId: `user:${handoff.userId}`,
        credentialId: `handoff:${handoff.requestHash}`,
        authorizationPrincipal: { kind: "user", subjectId: `user:${handoff.userId}` },
        organizationIds: [org],
        handoffDelegation: handoff.authority,
      }),
    withHandoff: (
      principal: AuthenticatedPrincipal,
      authority: NonNullable<McpPortalHandoff["authority"]>,
    ) => ({ ...principal, handoffDelegation: authority }),
    authenticateBrowser: async () =>
      browserIdentity ? { principal: browserIdentity, csrf: "browser-csrf" } : null,
    dispatch: async (apiRequest: Request, identity: AuthenticatedPrincipal) => {
      if (apiRequest.method === "GET") {
        if (new URL(apiRequest.url).pathname === "/v1/me/profile")
          return Response.json({
            user_id: profileUserId,
            name: "Test User",
            email: "test@example.invalid",
            email_verified: true,
            organizations: [{ id: org, workos_id: "org_test", name: "My workspace" }],
            organization_ids: [org],
            signup_source: null,
            attributed_at: null,
            initial_workspace_id: org,
          });
        if (new URL(apiRequest.url).pathname === "/v1/projects")
          return Response.json({
            items: emptyProjects
              ? []
              : [{ id: project, name: "Chat application", organization_id: org }],
            next_cursor: null,
          });
        return Response.json({ id: project, name: projectName, organization_id: org });
      }
      if (new URL(apiRequest.url).pathname.endsWith("/github:connect")) {
        expect(identity.session?.userId).toBe("user_test");
        expect(identity.handoffDelegation?.action).toBe("sources:link");
        expect(apiRequest.headers.get("idempotency-key")).toBe("github-portal");
        return Response.json(
          failGithub
            ? { code: "service_unavailable" }
            : {
                status: "pending",
                authorization_url: "https://github.com/login/oauth/authorize?state=test-one-use",
              },
          { status: failGithub ? 503 : 201 },
        );
      }
      return secretResponse(apiRequest, identity);
    },
  };
  const submit = (
    url: string,
    extra: Record<string, string> = {},
    headers: Record<string, string> = {
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
  ) =>
    new Request(new URL(url).origin + new URL(url).pathname, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        csrf: "browser-csrf",
        request: new URL(url).searchParams.get("request") ?? "",
        approve: "yes",
        ...extra,
      }),
    });
  const anonymousSubmit = (url: string, value: string, extra: Record<string, string> = {}) => {
    const target = new URL(url);
    return new Request(`${target.origin}${target.pathname}`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: target.searchParams.get("request") ?? "",
        value,
        ...extra,
      }),
    });
  };
  const checks: Array<{ resource: unknown; action: string }> = [];
  const denied = createMcpPortalAccess({
    origin,
    store: fixture.store,
    crypto: webcrypto as Crypto,
    now: () => new Date(now),
    authorize: async (_principal, resource, action) => {
      checks.push({ resource, action });
      return null;
    },
  });
  await expect(
    denied.startSecret(principal, org, {
      projectId: project,
      environmentId: environment,
      environment: "dev",
      name: "PAYMENT_KEY",
    }),
  ).rejects.toThrow("unavailable");
  await expect(denied.startGithub(principal, org, "github-portal")).rejects.toThrow("unavailable");
  expect(checks).toEqual([
    {
      resource: {
        kind: "project",
        organizationId: org,
        projectId: project,
        environmentId: environment,
      },
      action: "secrets:write",
    },
    { resource: { kind: "organization", organizationId: org }, action: "sources:link" },
  ]);
  const mismatchedProof = createMcpPortalAccess({
    origin,
    store: fixture.store,
    crypto: webcrypto as Crypto,
    now: () => new Date(now),
    authorize: async (_p, _resource, action) => ({
      grantId: "00000000-0000-0000-0000-000000000001",
      clientId: "another-client",
      consentHash: "a".repeat(64),
      action,
    }),
  });
  await expect(mismatchedProof.startGithub(principal, org, "github-portal")).rejects.toThrow(
    "unavailable",
  );
  const secret = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  browserIdentity = null;
  // A plain secret link is served without any sign-in state.
  const anonymous = await handleMcpPortalRequest(new Request(secret.url), dependencies);
  const anonymousHtml = await anonymous?.text();
  expect(anonymous?.status).toBe(200);
  expect(anonymousHtml).toContain('name="value"');
  expect(anonymousHtml).toContain('maxlength="5120"');
  expect(anonymousHtml).toMatch(/<input data-secret-input[^>]*autofocus/u);
  expect(anonymousHtml).toContain(">Generate token</button>");
  expect(anonymousHtml).toContain("Generate and copy a random value.");
  expect(anonymousHtml).not.toContain('class="mcp-identity"');
  expect(anonymousHtml).not.toContain('name="csrf"');
  // strict-origin keeps the real Origin on the POST and never sends the token URL as Referer.
  expect(anonymous?.headers.get("referrer-policy")).toBe("strict-origin");
  expect(anonymous?.headers.get("cache-control")).toBe("no-store");
  // Generator and eye controls start hidden so the form also works without scripts.
  expect(anonymousHtml).toMatch(/<button[^>]*data-generate-value[^>]*hidden>/u);
  expect(anonymousHtml).toMatch(
    /<button[^>]*data-reveal-value[^>]*aria-pressed="false"[^>]*hidden>/u,
  );
  expect(anonymousHtml).toContain('aria-label="Copy value for PAYMENT_KEY"');
  expect(anonymousHtml).toContain('aria-label="Show value"');
  expect(anonymousHtml?.match(/<script[\s>]/gu)).toHaveLength(1);
  const inlineScript = /<script>([\s\S]*?)<\/script>/u.exec(anonymousHtml ?? "")?.[1] ?? "";
  expect(inlineScript).toBe(ANONYMOUS_SECRET_SCRIPT);
  const anonymousCsp = anonymous?.headers.get("content-security-policy") ?? "";
  // The header hash is recomputed from the rendered script text, so the page and CSP cannot drift.
  const renderedHash = `sha256-${createHash("sha256").update(inlineScript).digest("base64")}`;
  expect(renderedHash).toBe(ANONYMOUS_SECRET_SCRIPT_HASH);
  expect(anonymousCsp).toContain(`script-src '${renderedHash}';`);
  expect(anonymousCsp).toContain("default-src 'none'");
  expect(fixture.records.get(secret.request_id)?.consumedAt).toBeNull();
  expect(await access.status(principal, secret.request_id)).toMatchObject({ state: "pending" });
  browserIdentity = browser;
  const head = await handleMcpPortalRequest(
    new Request(secret.url, { method: "HEAD" }),
    dependencies,
  );
  expect(head?.status).toBe(200);
  expect(head?.body).toBeNull();
  expect(fixture.records.get(secret.request_id)?.consumedAt).toBeNull();
  const escaped = renderMcpPortalPage(
    "<script>title</script>",
    "Account <changed>",
    403,
    "",
    false,
    true,
  );
  const escapedHtml = await escaped.text();
  expect(escapedHtml).toContain("&lt;script&gt;title&lt;/script&gt;");
  expect(escapedHtml).toContain("Account &lt;changed&gt;");
  expect(escapedHtml).not.toContain("<script");
  expect(PORTAL_CSS_HASH).toBe(
    `sha256-${createHash("sha256").update(PORTAL_CSS).digest("base64")}`,
  );
  expect(escaped.headers.get("content-security-policy")).toContain(
    `style-src '${PORTAL_CSS_HASH}'`,
  );
  expect(escaped.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  const emptyPage = renderStandalonePage({
    title: "Done",
    message: "Complete",
    status: 200,
    body: "",
    referrerPolicy: "no-referrer",
  });
  expect(await emptyPage.text()).not.toContain("Back to your workspace");
  expect(emptyPage.headers.get("content-security-policy")).toBe(standalonePageCsp());
  expect(escapedHtml).toContain("Back to your workspace");

  const websiteHeader = (
    await readFile(new URL("./fixtures/website-header.html", import.meta.url), "utf8")
  ).trim();
  expect(WEBSITE_HEADER_HTML).toBe(websiteHeader);
  expect(escapedHtml).toContain(websiteHeader);
  expect(escapedHtml).toContain(`<style>${WEBSITE_HEADER_CSS}</style>`);
  expect(WEBSITE_HEADER_CSS_HASH).toBe(
    `sha256-${createHash("sha256").update(WEBSITE_HEADER_CSS).digest("base64")}`,
  );
  expect(escaped.headers.get("content-security-policy")).toContain(`'${WEBSITE_HEADER_CSS_HASH}'`);

  expect(() =>
    renderMcpPortalPage("Unavailable", "", 403, "", false, true, null, "https://evil.example"),
  ).toThrow("Invalid form redirect origin");
  const chatPrincipal = {
    ...principal,
    connectUser: {
      ...principal.connectUser,
      clientId: "https://chatgpt.com/oauth/test-client/client.json",
    },
  };
  const returnLink = await access.startSecret(chatPrincipal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
    nativeProvider: { provider: "google", configurationRevision: 3, enabled: true },
  });
  const currentChat = "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555";
  for (const key of ["return_url", "redirectUrl"]) {
    const valid = new URL(returnLink.url);
    valid.searchParams.set(key, currentChat);
    const validPage = await handleMcpPortalRequest(new Request(valid), dependencies);
    expect(validPage?.status).toBe(200);
    expect(await validPage?.text()).toContain(`name="return_url" value="${currentChat}"`);
    for (const invalid of [
      "https://evil.example/",
      `${currentChat}?token=private`,
      `${currentChat}#private`,
    ]) {
      const target = new URL(returnLink.url);
      target.searchParams.set(key, invalid);
      expect((await handleMcpPortalRequest(new Request(target), dependencies))?.status).toBe(400);
    }
    valid.searchParams.append(key, currentChat);
    expect((await handleMcpPortalRequest(new Request(valid), dependencies))?.status).toBe(400);
  }
  const ambiguous = new URL(returnLink.url);
  ambiguous.searchParams.set("return_url", currentChat);
  ambiguous.searchParams.set(
    "redirectUrl",
    "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  expect((await handleMcpPortalRequest(new Request(ambiguous), dependencies))?.status).toBe(400);
  const returnRequest = new URL(returnLink.url).searchParams.get("request");
  if (!returnRequest) throw new Error("Return-link request missing");
  const duplicateForm = new URLSearchParams({
    csrf: "browser-csrf",
    request: returnRequest,
    approve: "yes",
    value: "x",
  });
  duplicateForm.append("return_url", currentChat);
  duplicateForm.append("return_url", currentChat);
  expect(
    (
      await handleMcpPortalRequest(
        new Request(new URL(returnLink.url).origin + new URL(returnLink.url).pathname, {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: duplicateForm,
        }),
        dependencies,
      )
    )?.status,
  ).toBe(400);
  expect(fixture.records.get(returnLink.request_id)?.consumedAt).toBeNull();
  // The signed-in provider form enforces the 5 KiB limit before it consumes the one-use link.
  expect(
    await (await handleMcpPortalRequest(new Request(returnLink.url), dependencies))?.text(),
  ).toContain('maxlength="5120"');
  const oversizedProvider = await handleMcpPortalRequest(
    submit(returnLink.url, { value: "x".repeat(6_000) }),
    dependencies,
  );
  expect(oversizedProvider?.status).toBe(400);
  expect(await oversizedProvider?.text()).toContain("Use between 1 and 5120 bytes.");
  expect(secretCalls).toHaveLength(0);
  expect(fixture.records.get(returnLink.request_id)?.consumedAt).toBeNull();
  projectName = '<script>alert("project")</script>';
  const unsafeProject = await handleMcpPortalRequest(new Request(secret.url), dependencies);
  const projectHtml = await unsafeProject?.text();
  expect(projectHtml).toContain("&lt;script&gt;alert(&quot;project&quot;)&lt;/script&gt;");
  expect(projectHtml).not.toContain('<script>alert("project")');
  projectName = "Chat application";
  const form = await handleMcpPortalRequest(new Request(secret.url), dependencies);
  expect(form?.headers.get("content-security-policy")).toContain("form-action 'self';");
  const github = await access.startGithub(principal, org, "github-portal");
  browserIdentity = null;
  const anonymousGithub = await handleMcpPortalRequest(new Request(github.url), dependencies);
  expect(anonymousGithub?.status).toBe(401);
  expect(await anonymousGithub?.text()).toContain('href="/login">Sign in to ohmyho.st</a>');
  const readPortal = vi.spyOn(access, "readPortal");
  const resumeAfterLogin = vi.fn(async () => Response.redirect(`${origin}/login`, 303));
  const resumed = await handleMcpPortalRequest(new Request(github.url), {
    ...dependencies,
    resumeAfterLogin,
  });
  expect(resumed?.status).toBe(303);
  expect(resumed?.headers.get("location")).toBe(`${origin}/login`);
  expect(readPortal).not.toHaveBeenCalled();
  expect(fixture.records.get(github.request_id)?.consumedAt).toBeNull();
  readPortal.mockRestore();
  browserIdentity = browser;
  const chatGithub = await access.startGithub(chatPrincipal, org, "github-portal");
  const githubReturn = new URL(chatGithub.url);
  githubReturn.searchParams.set("redirectUrl", currentChat);
  const githubReturnPage = await handleMcpPortalRequest(new Request(githubReturn), dependencies);
  expect(githubReturnPage?.status).toBe(200);
  expect(await githubReturnPage?.text()).toContain(`name="return_url" value="${currentChat}"`);
  githubReturn.searchParams.set("redirectUrl", "https://evil.example/");
  expect((await handleMcpPortalRequest(new Request(githubReturn), dependencies))?.status).toBe(400);
  expect(fixture.records.get(chatGithub.request_id)?.consumedAt).toBeNull();
  const githubPage = await handleMcpPortalRequest(new Request(github.url), dependencies);
  expect(githubPage?.status).toBe(200);
  expect(githubPage?.headers.get("content-security-policy")).toContain(
    "form-action 'self' https://github.com;",
  );
  expect(githubPage?.headers.get("content-security-policy")).not.toContain("script-src");
  expect(await githubPage?.text()).not.toContain("<script");
  expect(Date.parse(secret.expires_at) - Date.parse(now)).toBe(3_600_000);
  expect(Date.parse(github.expires_at) - Date.parse(now)).toBe(600_000);
  const tenMinutesLater = makeAccess(fixture.store, () => new Date(Date.parse(now) + 600_000));
  expect(
    await tenMinutesLater.readPortal(
      new URL(github.url).searchParams.get("request") ?? "",
      browser,
    ),
  ).toBeNull();
  const secretToken = new URL(secret.url).searchParams.get("request") ?? "";
  expect(await tenMinutesLater.readAnonymousSecret(secretToken)).not.toBeNull();
  const anHourLater = makeAccess(fixture.store, () => new Date(Date.parse(now) + 3_600_000));
  expect(await anHourLater.readAnonymousSecret(secretToken)).toBeNull();
  expect(await anHourLater.staleAnonymousSecret(secretToken)).toBe(true);
  // The signed-in portal selected another workspace: the link stays unused and its page offers the switch back.
  const elsewhere = await access.startGithub(principal, org, "github-portal");
  const elsewhereRequest = new URL(elsewhere.url).searchParams.get("request") ?? "";
  browserIdentity = { ...browser, organizationIds: [parseUlid("01M21T9VB6J0P0QWQJ4J3086ZR")] };
  const switchPage = await handleMcpPortalRequest(new Request(elsewhere.url), dependencies);
  const switchHtml = (await switchPage?.text()) ?? "";
  expect(switchPage?.status).toBe(200);
  expect(switchHtml).toContain('action="/workspace"');
  expect(switchHtml).toContain(`name="organization" value="${org}"`);
  expect(switchHtml).toContain(`name="return" value="/mcp/github?request=${elsewhereRequest}"`);
  expect(switchHtml).toContain("My workspace");
  expect(fixture.records.get(elsewhere.request_id)?.consumedAt).toBeNull();
  browserIdentity = browser;
  const githubRedirect = await handleMcpPortalRequest(submit(github.url), dependencies);
  expect(githubRedirect?.status).toBe(303);
  expect(githubRedirect?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(githubRedirect?.headers.get("location")).toBe(
    "https://github.com/login/oauth/authorize?state=test-one-use",
  );
  expect(await access.status(principal, github.request_id)).toMatchObject({
    state: "github_started",
  });
  const githubFailed = await access.startGithub(principal, org, "github-portal");
  failGithub = true;
  expect((await handleMcpPortalRequest(submit(githubFailed.url), dependencies))?.status).toBe(503);
  expect(await access.status(principal, githubFailed.request_id)).toMatchObject({
    state: "github_failed",
  });
  expect(await form?.text()).toContain('type="password"');
  expect(
    (await handleMcpPortalRequest(anonymousSubmit(secret.url, "private-user-secret"), dependencies))
      ?.status,
  ).toBe(200);
  expect(secretCalls).toHaveLength(1);
  expect(secretCalls[0]?.body).toEqual({ value: "private-user-secret" });
  expect(secretCalls[0]?.request.headers.has("authorization")).toBe(false);
  expect(secretCalls[0]?.identity.handoffDelegation).toEqual(
    fixture.records.get(secret.request_id)?.authority,
  );
  expect(secretCalls[0]?.identity.handoffDelegation?.action).toBe("secrets:write");
  const status = await access.status(principal, secret.request_id);
  expect(status).toMatchObject({ state: "secret_submitted" });
  expect(JSON.stringify(status)).not.toContain("private-user-secret");
  failSecret = true;
  const second = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  const failure = await handleMcpPortalRequest(
    anonymousSubmit(second.url, "second-private-value"),
    dependencies,
  );
  expect(failure?.status).toBe(503);
  expect(await failure?.text()).not.toContain("private-provider-error");
  expect(await access.status(principal, second.request_id)).toMatchObject({
    state: "secret_failed",
  });
  expect(
    (await handleMcpPortalRequest(anonymousSubmit(secret.url, "again"), dependencies))?.status,
  ).toBe(404);
  expect(
    await handleMcpPortalRequest(new Request(`${origin}/mcp/access`), dependencies),
  ).toBeNull();
  failSecret = false;
  const cap = { actions: ["secrets:write"] as const, organizationIds: [org] };
  const restrictedAccess = createMcpPortalAccess({
    origin,
    store: fixture.store,
    crypto: webcrypto as Crypto,
    now: () => new Date(now),
    authorize: async (p, _resource, action) => ({
      grantId: "00000000-0000-0000-0000-000000000001",
      clientId: p.connectUser.clientId,
      consentHash: createHash("sha256").update(p.connectUser.consentId).digest("hex"),
      action,
      authorizationRestriction: cap,
    }),
  });
  const restricted = await restrictedAccess.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  expect(fixture.records.get(restricted.request_id)?.authority?.authorizationRestriction).toEqual(
    cap,
  );
  expect(
    (
      await handleMcpPortalRequest(anonymousSubmit(restricted.url, "restricted"), {
        ...dependencies,
        access: restrictedAccess,
      })
    )?.status,
  ).toBe(200);
  expect(secretCalls.at(-1)?.identity.handoffDelegation?.authorizationRestriction).toEqual(cap);
  const protectedLink = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  expect(
    (
      await handleMcpPortalRequest(
        submit(
          protectedLink.url,
          { value: "x" },
          {
            origin: "https://attacker.invalid",
            "content-type": "application/x-www-form-urlencoded",
          },
        ),
        dependencies,
      )
    )?.status,
  ).toBe(403);
  for (const headers of [
    { "content-type": "application/x-www-form-urlencoded" },
    { origin: "null", "content-type": "application/x-www-form-urlencoded" },
    { origin, "content-type": "text/plain" },
  ] as Record<string, string>[]) {
    expect(
      (
        await handleMcpPortalRequest(
          submit(protectedLink.url, { value: "x" }, headers),
          dependencies,
        )
      )?.status,
    ).toBe(403);
    expect(fixture.records.get(protectedLink.request_id)?.consumedAt).toBeNull();
  }
  // The anonymous link accepts no CSRF or other fields: only the link and one value.
  expect(
    (
      await handleMcpPortalRequest(
        anonymousSubmit(protectedLink.url, "x", { csrf: "wrong" }),
        dependencies,
      )
    )?.status,
  ).toBe(400);
  expect(await access.status(principal, protectedLink.request_id)).toMatchObject({
    state: "pending",
  });
  await expect(
    access.status(
      { ...principal, connectUser: { ...principal.connectUser, clientId: "other-client" } },
      protectedLink.request_id,
    ),
  ).rejects.toThrow("unavailable");
  if (!browser.session) throw new Error("Browser session fixture missing");
  // The link is a bearer capability: the signed-in identity is not consulted for a plain secret.
  browserIdentity = { ...browser, session: { ...browser.session, userId: "different-user" } };
  expect((await handleMcpPortalRequest(new Request(protectedLink.url), dependencies))?.status).toBe(
    200,
  );
  browserIdentity = { ...browser, organizationIds: [] };
  expect((await handleMcpPortalRequest(new Request(protectedLink.url), dependencies))?.status).toBe(
    200,
  );
  browserIdentity = browser;
  const providerSecret = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
    nativeProvider: {
      provider: "google",
      configurationRevision: 3,
      enabled: true,
      clientId: "oauth-client",
    },
  });
  const providerForm = await handleMcpPortalRequest(new Request(providerSecret.url), dependencies);
  const providerHtml = await providerForm?.text();
  expect(providerHtml).toContain("Set a provider secret.");
  expect(providerHtml).toContain("oauth-client");
  expect(providerHtml).toContain("Configuration revision");
  const providerResult = await handleMcpPortalRequest(
    submit(providerSecret.url, { value: "private-oauth-value" }),
    dependencies,
  );
  expect(providerResult?.status).toBe(200);
  expect(await providerResult?.text()).not.toContain("private-oauth-value");
  expect(secretCalls.at(-1)?.request.url).toContain(
    `/environments/${environment}/auth/providers/google`,
  );
  expect(secretCalls.at(-1)?.body).toEqual({
    configurationRevision: 3,
    enabled: true,
    clientId: "oauth-client",
    clientSecret: "private-oauth-value",
  });
  expect(secretCalls.at(-1)?.identity.handoffDelegation?.action).toBe("auth:manage");
  expect(JSON.stringify(await access.status(principal, providerSecret.request_id))).not.toContain(
    "private-oauth-value",
  );
  // Cancelling the provider form is a decline the agent can report, not a lost link (forbidden).
  const cancelledSecret = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
    nativeProvider: {
      provider: "google",
      configurationRevision: 3,
      enabled: true,
      clientId: "oauth-client",
    },
  });
  await handleMcpPortalRequest(new Request(cancelledSecret.url), dependencies);
  const cancelled = await handleMcpPortalRequest(
    submit(cancelledSecret.url, { approve: "no" }),
    dependencies,
  );
  expect(await cancelled?.text()).toContain("Access declined.");
  expect(await access.status(principal, cancelledSecret.request_id)).toMatchObject({
    state: "declined",
  });
  await expect(
    access.startSecret(principal, org, {
      projectId: project,
      environmentId: environment,
      environment: "dev",
      name: "PAYMENT_KEY",
      nativeProvider: { provider: "google", configurationRevision: 3, enabled: true },
    }),
  ).rejects.toThrow("unavailable");
  const retryLink = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "NATIVE_AUTH_GITHUB_CLIENT_SECRET",
    nativeProvider: {
      provider: "github",
      configurationRevision: 4,
      enabled: true,
      clientId: "github-client",
    },
  });
  failSecret = true;
  const uncertain = await handleMcpPortalRequest(
    submit(retryLink.url, { value: "same-secret" }),
    dependencies,
  );
  expect(uncertain?.status).toBe(503);
  expect(await uncertain?.text()).toContain("Reopen this same link");
  expect(await access.status(principal, retryLink.request_id)).toMatchObject({
    state: "secret_uncertain",
  });
  expect(JSON.stringify(await access.status(principal, retryLink.request_id))).not.toContain(
    createHash("sha256").update("same-secret").digest("hex"),
  );
  const originalKey = secretCalls.at(-1)?.request.headers.get("idempotency-key");
  failSecret = false;
  const callsBeforeMismatch = secretCalls.length;
  const mismatch = await handleMcpPortalRequest(
    submit(retryLink.url, { value: "different-secret" }),
    dependencies,
  );
  expect(mismatch?.status).toBe(409);
  expect(await mismatch?.text()).not.toContain("different-secret");
  expect(secretCalls).toHaveLength(callsBeforeMismatch);
  expect(secretCalls.at(-1)?.request.headers.get("idempotency-key")).toBe(originalKey);
  expect(
    (await handleMcpPortalRequest(submit(retryLink.url, { value: "same-secret" }), dependencies))
      ?.status,
  ).toBe(200);
  expect(secretCalls.at(-1)?.request.headers.get("idempotency-key")).toBe(originalKey);
  expect(await access.status(principal, retryLink.request_id)).toMatchObject({
    state: "secret_submitted",
  });
  expect((await handleMcpPortalRequest(new Request(retryLink.url), dependencies))?.status).toBe(
    404,
  );
  for (const started of [false, true]) {
    const cancelled = await access.startSecret(principal, org, {
      projectId: project,
      environmentId: environment,
      environment: "dev",
      name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
      nativeProvider: { provider: "google", configurationRevision: 3, enabled: true },
    });
    if (started) {
      failSecret = true;
      expect(
        (
          await handleMcpPortalRequest(
            submit(cancelled.url, { value: "cancel-retry-secret" }),
            dependencies,
          )
        )?.status,
      ).toBe(503);
      failSecret = false;
    }
    const callsBeforeCancel = secretCalls.length;
    const cancelledResponse = await handleMcpPortalRequest(
      submit(cancelled.url, { approve: "no" }),
      dependencies,
    );
    expect(cancelledResponse?.status).toBe(200);
    expect(await cancelledResponse?.text()).toContain("Access declined.");
    expect(fixture.records.get(cancelled.request_id)?.outcome).toBe("declined");
    expect((await handleMcpPortalRequest(new Request(cancelled.url), dependencies))?.status).toBe(
      404,
    );
    expect(
      (
        await handleMcpPortalRequest(
          submit(cancelled.url, { value: "cancel-retry-secret" }),
          dependencies,
        )
      )?.status,
    ).toBe(404);
    expect(secretCalls).toHaveLength(callsBeforeCancel);
  }
  await access.revoke({ ...principal, organizationIds: [] });
  expect(fixture.revocations).toEqual([
    {
      userId: principal.connectUser.userId,
      clientId: principal.connectUser.clientId,
      consentHash: createHash("sha256").update(principal.connectUser.consentId).digest("hex"),
    },
  ]);
  expect(
    (await handleMcpPortalRequest(anonymousSubmit(protectedLink.url, "x"), dependencies))?.status,
  ).toBe(409);
  expect(secretCalls).toHaveLength(7);
  await expect(
    access.startSecret({ ...principal, organizationIds: [] }, org, {
      projectId: project,
      environmentId: environment,
      environment: "dev",
      name: "PAYMENT_KEY",
    }),
  ).rejects.toThrow("unavailable");
});

it("serves a plain secret link without sign-in, saves it once with the visitor address, and refuses unknown, expired, oversized or over-budget use", async () => {
  const fixture = testStore(),
    access = makeAccess(fixture.store);
  const saved: Array<{ value: string; authority: unknown }> = [];
  const visitors: Array<string | null> = [];
  const dependencies = {
    access,
    withHandoff: (
      principal: AuthenticatedPrincipal,
      authority: NonNullable<McpPortalHandoff["authority"]>,
    ) => ({ ...principal, handoffDelegation: authority }),
    authenticateBrowser: async () => null,
    projects: { getCustomerProject: async () => ({ name: "Chat application" }) },
    dispatch: async () => {
      throw new Error("A plain secret link never uses the signed-in dispatch");
    },
    dispatchHandoff: async (apiRequest: Request, handoff: McpPortalHandoff) => {
      const body = (await apiRequest.json()) as { value: string };
      saved.push({ value: body.value, authority: handoff.authority });
      visitors.push(apiRequest.headers.get("cf-connecting-ip"));
      return Response.json({ name: "PAYMENT_KEY", revision: 1 });
    },
  };
  const secret = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  const postValue = (value: string, visitor?: string) => {
    const target = new URL(secret.url);
    return new Request(`${origin}/mcp/secrets`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        ...(visitor === undefined ? {} : { "cf-connecting-ip": visitor }),
      },
      body: new URLSearchParams({
        request: target.searchParams.get("request") ?? "",
        value,
      }),
    });
  };
  const limited = await handleMcpPortalRequest(new Request(secret.url), {
    ...dependencies,
    limiter: { limit: async () => ({ success: false }) },
  });
  expect(limited?.status).toBe(429);
  // A project that no longer resolves answers unavailable, and the unused link keeps its one save.
  const unknown = await handleMcpPortalRequest(new Request(secret.url), {
    ...dependencies,
    projects: { getCustomerProject: async () => null },
  });
  expect(unknown?.status).toBe(404);
  expect(await unknown?.text()).toContain("Application unavailable.");
  expect(fixture.records.get(secret.request_id)?.consumedAt).toBeNull();
  const page = await handleMcpPortalRequest(new Request(secret.url), dependencies);
  const html = await page?.text();
  expect(page?.status).toBe(200);
  expect(html).toContain("Chat application");
  expect(html).toContain("PAYMENT_KEY");
  expect(html).not.toContain('class="mcp-identity"');
  expect(html).not.toContain('name="csrf"');
  const tooLarge = await handleMcpPortalRequest(postValue("v".repeat(5121)), dependencies);
  expect(tooLarge?.status).toBe(400);
  expect(fixture.records.get(secret.request_id)?.consumedAt).toBeNull();
  const accepted = await handleMcpPortalRequest(
    postValue("first-private-value", "203.0.113.7"),
    dependencies,
  );
  expect(accepted?.status).toBe(200);
  expect(await accepted?.text()).not.toContain("first-private-value");
  expect(saved).toEqual([
    {
      value: "first-private-value",
      authority: fixture.records.get(secret.request_id)?.authority,
    },
  ]);
  expect(visitors).toEqual(["203.0.113.7"]);
  expect((await handleMcpPortalRequest(postValue("again"), dependencies))?.status).toBe(404);
  expect((await handleMcpPortalRequest(new Request(secret.url), dependencies))?.status).toBe(404);
  const expired = makeAccess(fixture.store, () => new Date(Date.parse(now) + 3_600_000));
  const fresh = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  const late = await handleMcpPortalRequest(new Request(fresh.url), {
    ...dependencies,
    access: expired,
  });
  expect(late?.status).toBe(404);
  expect(await late?.text()).toContain("Ask your agent for a fresh link.");
  expect(saved).toHaveLength(1);
});

it("shows the anonymous secret form again for a value the server rejects, so the link can be retried", async () => {
  const fixture = testStore(),
    access = makeAccess(fixture.store);
  const saved: string[] = [];
  const dependencies = {
    access,
    withHandoff: (
      principal: AuthenticatedPrincipal,
      authority: NonNullable<McpPortalHandoff["authority"]>,
    ) => ({ ...principal, handoffDelegation: authority }),
    authenticateBrowser: async () => null,
    projects: { getCustomerProject: async () => ({ name: "Chat application" }) },
    dispatch: async () => {
      throw new Error("A plain secret link never uses the signed-in dispatch");
    },
    dispatchHandoff: async (apiRequest: Request) => {
      const body = (await apiRequest.json()) as { value: string };
      saved.push(body.value);
      return Response.json({ name: "PAYMENT_KEY", revision: 1 });
    },
  };
  const secret = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  const token = new URL(secret.url).searchParams.get("request") ?? "";
  const post = (value: string) =>
    new Request(`${origin}/mcp/secrets`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: token, value }),
    });
  // 2561 UTF-16 units fit maxlength, but 5122 UTF-8 bytes exceed the 5120-byte server limit.
  const rejected = await handleMcpPortalRequest(post("é".repeat(2561)), dependencies);
  const rejectedHtml = await rejected?.text();
  expect(rejected?.status).toBe(400);
  expect(rejectedHtml).toContain("Use between 1 and 5120 bytes.");
  expect(rejectedHtml).toContain('name="value"');
  expect(rejectedHtml).toContain(`name="request" value="${token}"`);
  expect(rejectedHtml).toContain("Chat application");
  expect(rejectedHtml?.match(/<script>/gu)).toHaveLength(1);
  expect(rejected?.headers.get("content-security-policy")).toContain(
    `script-src '${ANONYMOUS_SECRET_SCRIPT_HASH}';`,
  );
  expect(rejected?.headers.get("referrer-policy")).toBe("strict-origin");
  expect(fixture.records.get(secret.request_id)?.consumedAt).toBeNull();
  expect(saved).toEqual([]);
  const accepted = await handleMcpPortalRequest(post("retried-private-value"), dependencies);
  expect(accepted?.status).toBe(200);
  expect(saved).toEqual(["retried-private-value"]);
});

it("dispatches a consumed plain secret handoff only as its exact secret PUT under the stored authority", async () => {
  const fixture = testStore(),
    access = makeAccess(fixture.store);
  const reached: Array<{ method: string; path: string; principal: AuthenticatedPrincipal | null }> =
    [];
  const composition = createRemoteMcpComposition({
    persistence: { store: fixture.store } as unknown as RemoteMcpPersistence,
    clock: { now: () => new Date(now) },
    origin,
    issuer: "https://issuer.example",
    jwks: { load: async () => ({}) },
    authentication: { authenticate: async () => null },
    authorization: { check: async () => "allow" } as unknown as AuthorizationPort,
    resolveOrganization: async () => null,
    dispatch: async (request) => {
      reached.push({
        method: request.method,
        path: new URL(request.url).pathname,
        principal: await composition.internalAuthentication.resolve(request),
      });
      return Response.json({ ok: true });
    },
  });
  const link = await access.startSecret(principal, org, {
    projectId: project,
    environmentId: environment,
    environment: "dev",
    name: "PAYMENT_KEY",
  });
  const handoff = await access.readAnonymousSecret(
    new URL(link.url).searchParams.get("request") ?? "",
  );
  if (!handoff) throw new Error("Anonymous link missing");
  const consumed = await access.approveAnonymousSecret(handoff);
  if (!consumed) throw new Error("Anonymous link was not approved");
  const secretPath = `/v1/projects/${project}/environments/${environment}/secrets/PAYMENT_KEY`;
  const request = (method: string, path: string) =>
    new Request(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ value: "x" }) } : {}),
    });
  for (const [method, path] of [
    ["GET", "/v1/me"],
    ["PUT", `/v1/projects/${project}/environments/${environment}/secrets/OTHER`],
    ["DELETE", secretPath],
    ["PUT", `${secretPath}?probe=1`],
  ] as const)
    expect((await composition.dispatchHandoff(request(method, path), consumed)).status).toBe(403);
  expect(reached).toEqual([]);
  expect((await composition.dispatchHandoff(request("PUT", secretPath), consumed)).status).toBe(
    200,
  );
  const [call] = reached;
  expect(reached).toHaveLength(1);
  expect(call).toMatchObject({ method: "PUT", path: secretPath });
  expect(call?.principal).toMatchObject({
    actorId: `user:${principal.connectUser.userId}`,
    credentialId: `handoff:${consumed.requestHash}`,
    authorizationScopeConstraint: ["secrets:write"],
    handoffDelegation: consumed.authority,
  });
  expect(call?.principal?.connectUser).toBeUndefined();
  if (!call?.principal) throw new Error("Handoff principal was not resolved");
  expect(await composition.internalAuthentication.revalidate(call.principal)).toBe(call.principal);
});

it("isolates dice, reveal, and explicit clipboard actions to each anonymous secret field", async () => {
  type FakeControl = {
    hidden: boolean;
    disabled: boolean;
    type: string;
    value: string;
    textContent: string;
    attributes: Map<string, string>;
    listeners: Map<string, () => void | Promise<void>>;
    setAttribute(name: string, value: string): void;
    hasAttribute(name: string): boolean;
    addEventListener(event: string, listener: () => void | Promise<void>): void;
  };
  const control = (type = ""): FakeControl => ({
    hidden: true,
    disabled: true,
    type,
    value: "",
    textContent: "",
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    addEventListener(event, listener) {
      this.listeners.set(event, listener);
    },
  });
  const createField = () => ({
    "[data-secret-input]": control("password"),
    "[data-generate-value]": control(),
    "[data-copy-value]": control(),
    "[data-reveal-value]": control(),
    "[data-copy-status]": control(),
  });
  const field = createField();
  const other = createField();
  const single = createField();
  single["[data-generate-value]"].setAttribute("data-copy-generated", "");
  const input = field["[data-secret-input]"];
  const dice = field["[data-generate-value]"];
  const copy = field["[data-copy-value]"];
  const reveal = field["[data-reveal-value]"];
  const status = field["[data-copy-status]"];
  const copied: string[] = [];
  let clipboardDenied = false;
  const navigator = {
    clipboard: {
      async writeText(value: string) {
        if (clipboardDenied) throw new Error("Clipboard denied");
        copied.push(value);
      },
    },
  };
  const document = {
    querySelectorAll(selector: string) {
      expect(selector).toBe("[data-secret-field]");
      return [field, other, single].map((row) => ({
        querySelector: (control: keyof typeof row) => row[control],
      }));
    },
  };
  // The page runs this exact text as a classic script; the stub stands in for the browser DOM only.
  new Function("document", "crypto", "btoa", "navigator", ANONYMOUS_SECRET_SCRIPT)(
    document,
    webcrypto,
    btoa,
    navigator,
  );
  expect(dice.hidden).toBe(false);
  expect(copy.hidden).toBe(false);
  expect(copy.disabled).toBe(true);
  expect(reveal.hidden).toBe(false);
  reveal.listeners.get("click")?.();
  expect(input.type).toBe("text");
  expect(reveal.attributes.get("aria-pressed")).toBe("true");
  expect(reveal.attributes.get("aria-label")).toBe("Hide value");
  reveal.listeners.get("click")?.();
  expect(input.type).toBe("password");
  expect(reveal.attributes.get("aria-pressed")).toBe("false");
  expect(reveal.attributes.get("aria-label")).toBe("Show value");
  dice.listeners.get("click")?.();
  const first = input.value;
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(Buffer.from(first, "base64url")).toHaveLength(32);
  expect(input.type).toBe("text");
  expect(reveal.attributes.get("aria-pressed")).toBe("true");
  expect(copy.disabled).toBe(false);
  expect(copied).toEqual([]);
  expect(other["[data-secret-input]"].value).toBe("");
  other["[data-generate-value]"].listeners.get("click")?.();
  await copy.listeners.get("click")?.();
  await other["[data-copy-value]"].listeners.get("click")?.();
  expect(copied).toEqual([first, other["[data-secret-input]"].value]);
  expect(copied[1]).not.toBe(first);
  expect(status.textContent).toBe("Copied.");
  clipboardDenied = true;
  await copy.listeners.get("click")?.();
  expect(status.textContent).toBe("Could not copy. Show the value to copy it manually.");
  dice.listeners.get("click")?.();
  expect(input.value).not.toBe(first);
  expect(status.textContent).toBe("");

  const generateSingle = single["[data-generate-value]"].listeners.get("click");
  await generateSingle?.();
  expect(single["[data-secret-input]"].value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(single["[data-copy-status]"].textContent).toBe(
    "Could not copy. Show the value to copy it manually.",
  );
  clipboardDenied = false;
  await generateSingle?.();
  const generated = single["[data-secret-input]"].value;
  expect(copied.at(-1)).toBe(generated);
  expect(single["[data-copy-status]"].textContent).toBe("Copied.");

  const secretForm = renderMcpPortalPage(
    "Set an application secret.",
    "Enter this value here so it stays out of your chat.",
    200,
    "<form></form>",
    false,
    false,
    null,
    null,
    "strict-origin",
    true,
  );
  const secretHtml = await secretForm.text();
  const secretCsp = secretForm.headers.get("content-security-policy") ?? "";
  expect(secretHtml.match(/<script>/gu)).toHaveLength(1);
  expect(secretCsp).toContain(`script-src '${ANONYMOUS_SECRET_SCRIPT_HASH}';`);

  const signedIn = renderMcpPortalPage("Connect GitHub.", "", 200, "<form></form>");
  expect(await signedIn.text()).not.toContain("<script");
  expect(signedIn.headers.get("content-security-policy")).not.toContain("script-src");
  const failure = renderMcpPortalPage("Unavailable", "", 404);
  expect(await failure.text()).not.toContain("<script");
  expect(failure.headers.get("content-security-policy")).toContain("default-src 'none';");
  expect(failure.headers.get("content-security-policy")).not.toContain("script-src");
});

it("refuses a provider configuration revision the control store cannot hold, before any handoff", async () => {
  // Revision 0 and 2147483647 pass the tool schema but fail the control store's range, which surfaced as a
  // retryable service failure. The tool must refuse them itself, before it creates a portal form.
  const fixture = testStore(),
    access = makeAccess(fixture.store);
  const handler = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access,
    authenticate: async (token) => (token === "good-token" ? principal : null),
    dispatch: async () => Response.json({ status: 404 }, { status: 404 }),
  });
  for (const configuration_revision of [0, 2_147_483_647]) {
    const response = await rpc(
      await handler.fetch(
        request("tools/call", {
          name: "native_auth_provider_secret_input_request",
          arguments: {
            project_id: project,
            environment_id: environment,
            provider: "google",
            configuration_revision,
            enabled: false,
          },
        }),
      ),
    );
    expect(response.result.isError).toBe(true);
    // The MCP schema refuses the value and names the field; no portal form is created.
    expect(response.result.content[0]?.text).toMatch(
      /Input validation error.*configuration_revision/u,
    );
  }
  expect(fixture.records.size).toBe(0);
});

it("answers a plain secret with its own outcome when the completion record cannot be written", async () => {
  // Saving never depends on the completion record, and a failed save still renders its page when that record
  // is unavailable, instead of throwing out of the handler.
  const fixture = testStore();
  let completionFails = false;
  const store = {
    ...fixture.store,
    completeSecret: async (hash: string, succeeded: boolean) => {
      if (completionFails) throw new Error("control store unavailable");
      return fixture.store.completeSecret(hash, succeeded);
    },
  };
  const access = makeAccess(store);
  let putFails = false;
  const dependencies = {
    access,
    withHandoff: (
      principal: AuthenticatedPrincipal,
      authority: NonNullable<McpPortalHandoff["authority"]>,
    ) => ({
      ...principal,
      handoffDelegation: authority,
    }),
    authenticateBrowser: async () => null,
    projects: { getCustomerProject: async () => ({ name: "Chat application" }) },
    dispatch: async () => {
      throw new Error("A plain secret link never uses the signed-in dispatch");
    },
    dispatchHandoff: async () =>
      putFails
        ? Response.json({ detail: "private-provider-error" }, { status: 503 })
        : Response.json({ name: "PAYMENT_KEY", revision: 1 }),
  };
  const startLink = () =>
    access.startSecret(principal, org, {
      projectId: project,
      environmentId: environment,
      environment: "dev",
      name: "PAYMENT_KEY",
    });
  const submit = async (link: { url: string }, value: string) =>
    handleMcpPortalRequest(
      new Request(`${origin}/mcp/secrets`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          request: new URL(link.url).searchParams.get("request") ?? "",
          value,
        }),
      }),
      dependencies,
    );
  completionFails = true;
  const saved = await submit(await startLink(), "saved-value");
  expect(saved?.status).toBe(200);
  expect(await saved?.text()).toContain("Secret saved.");
  putFails = true;
  const refused = await submit(await startLink(), "refused-value");
  expect(refused?.status).toBe(503);
  expect(await refused?.text()).toContain("Secret could not be confirmed.");
});

it("answers a provider secret with the confirmation page when its completion record throws, saved or refused", async () => {
  // The provider update is the outcome; a completion record that throws must not escape the signed-in portal.
  const fixture = testStore();
  let completionFails = false;
  const store: McpDelegationStore = {
    ...fixture.store,
    completeNativeProviderHandoff: async (input) => {
      if (completionFails) throw new Error("control store unavailable");
      return fixture.store.completeNativeProviderHandoff(input);
    },
  };
  const access = makeAccess(store);
  let putFails = false;
  const dependencies = {
    access,
    projects: { getCustomerProject: async () => ({ name: "Chat application" }) },
    withHandoff: (
      signedIn: AuthenticatedPrincipal,
      authority: NonNullable<McpPortalHandoff["authority"]>,
    ) => ({ ...signedIn, handoffDelegation: authority }),
    authenticateBrowser: async () => ({ principal: browser, csrf: "browser-csrf" }),
    dispatchHandoff: async () => {
      throw new Error("A signed-in provider update never uses the anonymous handoff dispatch");
    },
    dispatch: async (apiRequest: Request) => {
      if (apiRequest.method === "GET") {
        if (new URL(apiRequest.url).pathname === "/v1/me/profile")
          return Response.json({
            user_id: "user_test",
            name: "Test User",
            email: "test@example.invalid",
            email_verified: true,
            organizations: [{ id: org, workos_id: "org_test", name: "My workspace" }],
            organization_ids: [org],
            signup_source: null,
            attributed_at: null,
            initial_workspace_id: org,
          });
        return Response.json({ id: project, name: "Chat application", organization_id: org });
      }
      return putFails
        ? Response.json({ code: "service_unavailable" }, { status: 503 })
        : Response.json({ status: "saved" });
    },
  };
  const startProvider = () =>
    access.startSecret(principal, org, {
      projectId: project,
      environmentId: environment,
      environment: "dev",
      name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
      nativeProvider: {
        provider: "google",
        configurationRevision: 3,
        enabled: true,
        clientId: "oauth-client",
      },
    });
  const submit = (url: string, value: string) =>
    new Request(`${origin}/mcp/secrets`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: "browser-csrf",
        request: new URL(url).searchParams.get("request") ?? "",
        approve: "yes",
        value,
      }),
    });
  completionFails = true;
  const saved = await handleMcpPortalRequest(
    submit((await startProvider()).url, "saved-oauth-value"),
    dependencies,
  );
  expect(saved?.status).toBe(503);
  expect(await saved?.text()).toContain("Secret update needs confirmation.");
  putFails = true;
  const refused = await handleMcpPortalRequest(
    submit((await startProvider()).url, "refused-oauth-value"),
    dependencies,
  );
  expect(refused?.status).toBe(503);
  expect(await refused?.text()).toContain("Secret update needs confirmation.");
});

it("answers a refused GitHub connection with its refusal page when the completion record throws", async () => {
  // The signed-in GitHub handoff keeps its refusal page when the failure cannot be recorded.
  const fixture = testStore();
  const store: McpDelegationStore = {
    ...fixture.store,
    completeGithub: async () => {
      throw new Error("control store unavailable");
    },
  };
  const access = makeAccess(store);
  const dependencies = {
    access,
    projects: { getCustomerProject: async () => ({ name: "Chat application" }) },
    withHandoff: (
      signedIn: AuthenticatedPrincipal,
      authority: NonNullable<McpPortalHandoff["authority"]>,
    ) => ({ ...signedIn, handoffDelegation: authority }),
    authenticateBrowser: async () => ({ principal: browser, csrf: "browser-csrf" }),
    dispatchHandoff: async () => {
      throw new Error("A signed-in GitHub connection never uses the anonymous handoff dispatch");
    },
    dispatch: async (apiRequest: Request) => {
      if (new URL(apiRequest.url).pathname.endsWith("/github:connect"))
        return Response.json({ code: "service_unavailable" }, { status: 503 });
      return Response.json({
        user_id: "user_test",
        name: "Test User",
        email: "test@example.invalid",
        email_verified: true,
        organizations: [{ id: org, workos_id: "org_test", name: "My workspace" }],
        organization_ids: [org],
        signup_source: null,
        attributed_at: null,
        initial_workspace_id: org,
      });
    },
  };
  const github = await access.startGithub(principal, org, "github-portal");
  const refused = await handleMcpPortalRequest(
    new Request(`${origin}/mcp/github`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: "browser-csrf",
        request: new URL(github.url).searchParams.get("request") ?? "",
        approve: "yes",
      }),
    }),
    dependencies,
  );
  expect(refused?.status).toBe(503);
  expect(await refused?.text()).toContain("GitHub connection could not be confirmed.");
});

it("records one authenticated MCP invocation even without REST and never exposes arguments", async () => {
  const records: import("@ohmyhost/contracts/usage-log").UsageLogRecord[] = [];
  const handler = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access: makeAccess(testStore().store),
    authenticate: async () => principal,
    dispatch: async () => {
      throw new Error("unexpected REST");
    },
    usageLog: {
      report: (record) => records.push(record),
      environment: "development",
      version: null,
    },
  });
  try {
    const response = await handler.fetch(
      request("tools/call", { name: "workspace_setup", arguments: {} }),
    );
    expect(response?.status).toBe(200);
    await response?.text();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      operation: "workspace_setup",
      transport: "remote_mcp",
      account_id: "user_test",
      phase: "started",
    });
    expect(records[1]).toMatchObject({
      operation: "workspace_setup",
      outcome: "succeeded",
      phase: "finished",
    });
    expect(records[0]?.invocation_id).toBe(records[1]?.invocation_id);
    expect(JSON.stringify(records)).not.toContain("good-token");
  } finally {
    await handler.close();
  }
});

it("links the internally dispatched REST invocation to its authenticated MCP parent", async () => {
  const { createControlApi } = await import("../src/app.js");
  const { routeDependencies, ORGANIZATION_ID, PROJECT_ID } = await import(
    "./helpers/app-routes-fixture.js"
  );
  const records: import("@ohmyhost/contracts/usage-log").UsageLogRecord[] = [];
  const usageLog = {
    report: (record: import("@ohmyhost/contracts/usage-log").UsageLogRecord) =>
      records.push(record),
    environment: "development" as const,
    version: null,
  };
  const identity = {
    ...principal,
    organizationIds: [ORGANIZATION_ID],
    authorizationScopeConstraint: ["projects:read"],
  };
  const app = createControlApi(
    routeDependencies({
      usageLog,
      remoteAuthorization: async () => true,
      internalAuthentication: { resolve: async () => identity, revalidate: async () => identity },
    }),
  );
  const handler = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access: makeAccess(testStore().store),
    authenticate: async () => identity,
    dispatch: async (req) => app.fetch(req),
    usageLog,
  });
  try {
    const response = await handler.fetch(
      request("tools/call", { name: "project_get", arguments: { project_id: PROJECT_ID } }),
    );
    await response?.text();
    expect(records).toHaveLength(4);
    const mcp = records.find((r) => r.transport === "remote_mcp" && r.phase === "finished");
    const rest = records.find((r) => r.transport === "rest" && r.phase === "finished");
    expect(rest).toMatchObject({
      operation: "getProject",
      parent_invocation_id: mcp?.invocation_id,
      organization_id: ORGANIZATION_ID,
      project_id: PROJECT_ID,
    });
    expect(mcp).toMatchObject({
      organization_id: ORGANIZATION_ID,
      project_id: PROJECT_ID,
      outcome: "succeeded",
    });
  } finally {
    await handler.close();
  }
});

it("dispatches integration discovery through the authenticated REST SDK with the same principal", async () => {
  let observed: Request | undefined;
  const fixture = testStore();
  const composition = createRemoteMcpComposition({
    persistence: {
      store: fixture.store,
      grantRevision: async () => "4",
    } as unknown as RemoteMcpPersistence,
    clock: { now: () => new Date(now) },
    origin,
    issuer: "https://issuer.example",
    jwks: { load: async () => ({}) },
    authentication: { authenticate: async () => null },
    authorization: { check: async () => "allow" } as unknown as AuthorizationPort,
    resolveOrganization: async () => org,
    dispatch: async () => Response.json({ ok: true }),
  });
  const acting = { ...principal, authorizationScopeConstraint: ["integrations:manage" as const] };
  expect(await composition.remoteIntegrationDelegation(acting, org)).toMatchObject({
    grantId: "00000000-0000-0000-0000-000000000001",
    clientId: "client_test",
    grantRevision: 4,
    authorizationRestriction: { actions: ["integrations:manage"] },
  });
  expect(
    await composition.remoteIntegrationDelegation(
      { ...acting, authorizationRestriction: { organizationIds: [project] } },
      org,
    ),
  ).toBeNull();
  const handler = createRemoteOhmyhostMcpHandler({
    endpoint: `${origin}/mcp`,
    authorizationServers: ["https://issuer.example"],
    access: makeAccess(testStore().store),
    authenticate: async () => principal,
    dispatch: async (req, actor) => {
      observed = req;
      expect(actor).toBe(principal);
      return Response.json({ organizations: [], teams: [], connections: [] });
    },
  });
  try {
    const response = await handler.fetch(
      request("tools/call", {
        name: "integration_connection_discover",
        arguments: {
          organization_id: org,
          project_id: project,
          environment_id: environment,
          grant_id: deployment,
          provider_organization_id: 1,
          team_id: 2,
        },
      }),
    );
    const body = await rpc(response);
    expect(body.result.isError).not.toBe(true);
    if (!observed) throw new Error("Missing dispatched request");
    expect(new URL(observed.url).pathname).toBe(
      `/v1/organizations/${org}/connections/${deployment}/catalog`,
    );
    expect(new URL(observed.url).searchParams.get("team_id")).toBe("2");
  } finally {
    await handler.close();
  }
});
