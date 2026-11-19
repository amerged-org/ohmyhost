import { expect, it, vi } from "vitest";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { closeBrowserSession, openBrowserSession } from "../src/browser-session.js";
import { connect, remoteMcpFixture } from "./helpers/d1-remote-mcp-fixture.js";

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

it("carries a restricted secret handoff through the real Worker and fences disconnect at Core mutation", async () => {
  const control = await createTestControl();
  try {
    const refreshes: unknown[] = [];
    let rejectRefresh = false;
    const f = await remoteMcpFixture(control, async (request) => {
      const form = (await request.json()) as Record<string, unknown>;
      refreshes.push(form);
      if (rejectRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: await f.sessionToken(),
        refresh_token: "refresh-rotated",
      });
    });
    const password = "portal-session-password-0123456789abcdef",
      csrf = "c".repeat(43);
    let revokeAtMutation = false;
    let reachedMutationAfterRevoke = false;
    const boundCore = f.bindings.CONTROL_RUNTIME;
    if (typeof boundCore !== "object" || boundCore === null)
      throw new Error("Core fixture missing");
    const core = new Proxy(boundCore, {
      get(target, property, receiver) {
        const method: unknown = Reflect.get(target, property, receiver);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          if (property === "mutateApiEnvironmentSecret" && revokeAtMutation) {
            await f.persistence.store.revoke(
              { userId: f.userId, clientId: connect.clientId, consentHash: f.identity.consentHash },
              new Date().toISOString(),
            );
            reachedMutationAfterRevoke = true;
          }
          return Reflect.apply(method, target, args);
        };
      },
    });
    const bindings = {
      ...f.bindings,
      CONTROL_RUNTIME: core,
      PRODUCT_API_RUNTIME: f.store.productApi,
      SOURCE_INSPECTOR: {},
      BROWSER_LOGIN_ENABLED: "true",
      PORTAL_SESSION_PASSWORD: password,
      ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x63).toString("base64"),
      ENVIRONMENT_SECRET_KEY_VERSION: "1",
    };
    const fetch = (request: Request) =>
      f.worker.fetch(request, bindings as never, { waitUntil: () => undefined });
    for (const [route, method] of [
      ["/mcp/chatgpt", "POST"],
      ["/.well-known/oauth-protected-resource/mcp/chatgpt", "GET"],
    ] as const) {
      const retired = await fetch(new Request(`${connect.origin}${route}`, { method }));
      expect(retired.status).toBe(404);
    }
    const metadata = await fetch(
      new Request(`${connect.origin}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${connect.origin}/mcp` });
    const token = await f.connectToken({
      ohmyhost_authorization: {
        actions: ["projects:read", "secrets:write"],
        organizationIds: [f.project.organizationId],
        projectIds: [f.project.projectId],
      },
    });
    const tool = async (name: string) => {
      const response = await fetch(
        new Request(`${connect.origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "secret_input_request",
              arguments: { project_id: f.project.projectId, environment: "dev", name },
            },
          }),
        }),
      );
      const text = await response.text();
      const json = JSON.parse(
        response.headers.get("content-type")?.startsWith("text/event-stream")
          ? (text
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6) ?? "{}")
          : text,
      ) as {
        result: { content: { text: string }[]; isError?: boolean };
      };
      expect(json.result.isError === true, text).toBe(false);
      return JSON.parse(json.result.content[0]?.text ?? "{}") as { url: string };
    };
    const cookie =
      (
        await closeBrowserSession(
          {
            accessToken: await f.sessionToken(),
            refreshToken: "refresh-token",
            csrf,
            origin: connect.origin,
            createdAt: Date.now() - 1000,
            organizationId: null,
          },
          password,
        )
      ).split(";")[0] ?? "";
    // A plain secret link is its own capability: no browser session or CSRF field is involved.
    const submit = (url: string) =>
      fetch(
        new Request(url.split("?")[0] ?? url, {
          method: "POST",
          headers: {
            origin: connect.origin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            request: new URL(url).searchParams.get("request") ?? "",
            value: "fixture-private-value",
          }),
        }),
      );
    expect((await fetch(new Request(`${connect.origin}/mcp/access`))).status).toBe(404);
    const first = await tool("PORTAL_ACCEPTED");
    expect((await fetch(new Request(first.url))).status).toBe(200);
    // GitHub and provider-secret links keep the signed-in portal, so the browser session stays reached.
    expect((await fetch(new Request(`${connect.origin}/mcp/github?request=unsigned`))).status).toBe(
      401,
    );
    expect((await fetch(new Request(first.url, { headers: { cookie } }))).status).toBe(200);
    // The access token in the cookie expired an hour ago while the WorkOS session lives. The signed-in portal renews
    // it from the refresh token instead of asking the user to sign in again, and sets the renewed cookie. No handoff
    // is named here, so the answer is the portal's own fresh-link page, reached only after the session is accepted.
    const expiredCookie =
      (
        await closeBrowserSession(
          {
            accessToken: await f.sessionToken(3600),
            refreshToken: "refresh-token",
            csrf,
            origin: connect.origin,
            createdAt: Date.now() - 1000,
            organizationId: null,
          },
          password,
        )
      ).split(";")[0] ?? "";
    const renewed = await fetch(
      new Request(`${connect.origin}/mcp/secrets`, { headers: { cookie: expiredCookie } }),
    );
    expect(renewed.status).toBe(404);
    expect(
      renewed.headers.getSetCookie().some((value) => value.startsWith("__Host-omh-session=")),
    ).toBe(true);
    expect(refreshes).toEqual([
      expect.objectContaining({ grant_type: "refresh_token", refresh_token: "refresh-token" }),
    ]);
    // A refresh that WorkOS rejects answers the sign-in page and sets no cookie: a parallel request may already have
    // stored the rotated session, and a clear sent now could erase it.
    rejectRefresh = true;
    const rejected = await fetch(
      new Request(`${connect.origin}/mcp/secrets`, { headers: { cookie: expiredCookie } }),
    );
    expect(rejected.status).toBe(401);
    expect(rejected.headers.getSetCookie()).toEqual([]);
    const accepted = await submit(first.url);
    expect(accepted.status, await accepted.text()).toBe(200);
    expect(
      await control.core
        .prepare(
          "SELECT name FROM environment_secrets WHERE project_id=? AND name='PORTAL_ACCEPTED'",
        )
        .bind(f.project.projectId)
        .first(),
    ).not.toBeNull();
    const second = await tool("PORTAL_REVOKED");
    revokeAtMutation = true;
    const denied = await submit(second.url);
    expect(reachedMutationAfterRevoke).toBe(true);
    expect(denied.status).not.toBe(200);
    expect(
      await control.core
        .prepare(
          "SELECT name FROM environment_secrets WHERE project_id=? AND name='PORTAL_REVOKED'",
        )
        .bind(f.project.projectId)
        .first(),
    ).toBeNull();
  } finally {
    await control.dispose();
  }
}, 120000);

it("keeps the portal session through a WorkOS outage, and keeps the rotated refresh token of a renewal the portal refuses", async () => {
  const control = await createTestControl();
  try {
    const password = "portal-session-password-0123456789abcdef",
      csrf = "c".repeat(43),
      refreshes: Record<string, unknown>[] = [];
    let answer: "outage" | "refused" = "outage";
    const f = await remoteMcpFixture(control, async (request) => {
      refreshes.push((await request.json()) as Record<string, unknown>);
      if (answer === "outage") return new Response("unavailable", { status: 503 });
      return Response.json({
        access_token: await f.sessionToken(3600),
        refresh_token: "refresh-rotated",
      });
    });
    const expiredCookie =
      (
        await closeBrowserSession(
          {
            accessToken: await f.sessionToken(3600),
            refreshToken: "refresh-token",
            csrf,
            origin: connect.origin,
            createdAt: Date.now() - 1000,
            organizationId: null,
          },
          password,
        )
      ).split(";")[0] ?? "";
    const bindings = {
      ...f.bindings,
      PRODUCT_API_RUNTIME: f.store.productApi,
      SOURCE_INSPECTOR: {},
      BROWSER_LOGIN_ENABLED: "true",
      PORTAL_SESSION_PASSWORD: password,
      ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x63).toString("base64"),
      ENVIRONMENT_SECRET_KEY_VERSION: "1",
    };
    const fetch = (request: Request) =>
      f.worker.fetch(request, bindings as never, { waitUntil: () => undefined });
    const portal = (cookie: string) =>
      fetch(new Request(`${connect.origin}/mcp/secrets`, { headers: { cookie } }));

    // A WorkOS outage fails the request with 503 and leaves the sealed session as it was.
    const outage = await portal(expiredCookie);
    expect(refreshes).toEqual([
      expect.objectContaining({ grant_type: "refresh_token", refresh_token: "refresh-token" }),
    ]);
    expect(outage.status).toBe(503);
    expect(outage.headers.getSetCookie()).toEqual([]);

    // A renewed token the portal does not accept answers 401 and still sets the renewed cookie: WorkOS issued the new
    // refresh token once, so the next request must use it.
    answer = "refused";
    const refused = await portal(expiredCookie);
    expect(refused.status).toBe(401);
    const [renewedCookie] = refused.headers.getSetCookie();
    expect(renewedCookie?.startsWith("__Host-omh-session=")).toBe(true);
    const renewed = await openBrowserSession(
      renewedCookie?.split(";")[0] ?? "",
      password,
      connect.origin,
      Date.now(),
    );
    expect(renewed).toMatchObject({ refreshToken: "refresh-rotated", csrf });
    await portal(renewedCookie?.split(";")[0] ?? "");
    expect(refreshes.at(-1)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-rotated",
    });
  } finally {
    await control.dispose();
  }
}, 120000);

it("limits a connected mail-domain mutation to its selected sender and current owner", async () => {
  const control = await createTestControl();
  try {
    const f = await remoteMcpFixture(control),
      domainId = await f.seedMailDomain("mail.example.com"),
      foreignDomain = await f.seedMailDomain("other.example.com"),
      ownerLossDomain = await f.seedMailDomain("owner-loss.example.com");
    const { SharedMailRuntime } = await import("../../control-store/src/worker-main.js");
    const provider = vi.fn(
      async () =>
        await f.store.sharedMail.readDomain({ organizationId: f.organizationId, domainId }),
    );
    const bindings = {
      ...f.bindings,
      PRODUCT_API_RUNTIME: f.store.productApi,
      SOURCE_INSPECTOR: {},
      SHARED_MAIL_RUNTIME: new SharedMailRuntime({} as never, control.bindings as never),
      MAIL_DOMAIN_OBSERVER: {
        ensureWorkspaceMailDomain: async () => ({}),
        syncWorkspaceMailDomain: async () => ({}),
        retireWorkspaceMailDomain: provider,
      },
    };
    const token = await f.connectToken({
      ohmyhost_authorization: {
        actions: ["mail-domains:admin"],
        organizationIds: [f.organizationId],
        mailDomainIds: [domainId, ownerLossDomain],
      },
    });
    const tool = async (selected: string, key: string) => {
      const response = await f.worker.fetch(
        new Request(`${connect.origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "workspace_mail_domain_retire",
              arguments: {
                organization_id: f.organizationId,
                mail_domain_id: selected,
                expected_revision: 1,
                idempotency_key: key,
                confirmed: true,
              },
            },
          }),
        }),
        bindings as never,
        { waitUntil: () => undefined },
      );
      const text = await response.text();
      return JSON.parse(
        response.headers.get("content-type")?.startsWith("text/event-stream")
          ? (text
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6) ?? "{}")
          : text,
      ) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };
    };
    const denied = await tool(foreignDomain, "foreign");
    expect(denied.result?.isError === true || denied.error !== undefined).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    const accepted = await tool(domainId, "allowed");
    expect(accepted.error).toBeUndefined();
    expect(accepted.result).toBeDefined();
    expect(accepted.result?.isError, JSON.stringify(accepted)).not.toBe(true);
    expect(provider).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: f.organizationId,
        mailDomainId: domainId,
        delegation: expect.objectContaining({
          action: "mail-domains:admin",
          clientId: connect.clientId,
        }),
      }),
    );
    await control.core
      .prepare(
        "UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1 AND workos_user_id=?2",
      )
      .bind(f.organizationId, f.userId)
      .run();
    const afterLoss = await tool(ownerLossDomain, "after-owner-loss");
    expect(afterLoss.result?.isError === true || afterLoss.error !== undefined).toBe(true);
    expect(provider).toHaveBeenCalledOnce();
    expect(
      await control.core
        .prepare("SELECT status FROM workspace_mail_domains WHERE domain_id=?1")
        .bind(ownerLossDomain)
        .first(),
    ).toEqual({ status: "active" });
  } finally {
    await control.dispose();
  }
}, 120000);

type Fixture = Awaited<ReturnType<typeof remoteMcpFixture>>;

/** A Connect token for one secret link: the agent may request it, and only the link's form sets the value. */
async function portalToken(f: Fixture) {
  return f.connectToken({
    ohmyhost_authorization: {
      actions: ["projects:read", "secrets:write"],
      organizationIds: [f.project.organizationId],
      projectIds: [f.project.projectId],
    },
  });
}

/**
 * The real Worker over the seeded Core. Only the Core binding is wrapped: it counts secret writes and gives a test two
 * hooks, the handoff read and the write itself. The portal, the consume and the secret PUT run unchanged.
 */
function anonymousLinks(f: Fixture) {
  const boundCore = f.bindings.CONTROL_RUNTIME;
  if (typeof boundCore !== "object" || boundCore === null) throw new Error("Core fixture missing");
  const hooks = {
    writes: 0,
    beforeHandoffRead: async (): Promise<void> => undefined,
    beforeWrite: async (input: unknown) => input,
  };
  const core = new Proxy(boundCore, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        if (property === "findMcpHandoff") await hooks.beforeHandoffRead();
        if (property === "mutateApiEnvironmentSecret") {
          hooks.writes += 1;
          args[0] = await hooks.beforeWrite(args[0]);
        }
        return Reflect.apply(method, target, args);
      };
    },
  });
  const bindings = {
    ...f.bindings,
    CONTROL_RUNTIME: core,
    PRODUCT_API_RUNTIME: f.store.productApi,
    SOURCE_INSPECTOR: {},
    BROWSER_LOGIN_ENABLED: "true",
    PORTAL_SESSION_PASSWORD: "portal-session-password-0123456789abcdef",
    ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x63).toString("base64"),
    ENVIRONMENT_SECRET_KEY_VERSION: "1",
  };
  const fetch = (request: Request) =>
    f.worker.fetch(request, bindings as never, { waitUntil: () => undefined });
  return {
    hooks,
    /** One signed MCP tool call; its result is what the agent reads, never a secret value. */
    async call<T>(
      token: string,
      name: string,
      args: Record<string, unknown>,
      expectError = false,
    ): Promise<T> {
      const response = await fetch(
        new Request(`${connect.origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
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
      const json = JSON.parse(
        response.headers.get("content-type")?.startsWith("text/event-stream")
          ? (text
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6) ?? "{}")
          : text,
      ) as { result: { content: { text: string }[]; isError?: boolean } };
      expect(json.result.isError === true, text).toBe(expectError);
      const payload = json.result.content[0]?.text ?? "{}";
      return (expectError ? payload : JSON.parse(payload)) as T;
    },
    /** The anonymous form POST as a browser sends it: same origin, form-encoded, no session or CSRF field. */
    submit(url: string, value: string | string[] = "fixture-private-value", extra = {}) {
      const body = new URLSearchParams({
        request: new URL(url).searchParams.get("request") ?? "",
        ...extra,
      });
      if (typeof value === "string") body.set("value", value);
      else value.forEach((entry, index) => body.set(`value_${index}`, entry));
      return fetch(
        new Request(url.split("?")[0] ?? url, {
          method: "POST",
          headers: {
            origin: connect.origin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        }),
      );
    },
    fetch,
  };
}

async function countSecrets(control: TestControl, projectId: string, name: string) {
  return control.core
    .prepare("SELECT COUNT(*) AS n FROM environment_secrets WHERE project_id=?1 AND name=?2")
    .bind(projectId, name)
    .first();
}

it("issues one link for three named fields and lets just one valid competing Save write", async () => {
  const control = await createTestControl();
  try {
    const f = await remoteMcpFixture(control),
      links = anonymousLinks(f),
      token = await portalToken(f);
    const target = { project_id: f.project.projectId, environment: "dev" };
    const maximum = Array.from({ length: 10 }, (_, index) => `PORTAL_LIMIT_${index}`);
    for (const invalid of [
      {},
      { names: [] },
      { names: [...maximum, "PORTAL_LIMIT_EXTRA"] },
      { names: ["PORTAL_DUPLICATE", "PORTAL_DUPLICATE"] },
      { names: ["DATABASE_URL"] },
      { names: ["PORTAL_GROUPED"], name: "PORTAL_LEGACY" },
    ]) {
      expect(
        await links.call<string>(token, "secret_input_request", { ...target, ...invalid }, true),
      ).toContain("validation");
    }
    const names = ["PORTAL_RACED_FIRST", "PORTAL_RACED_SECOND", "PORTAL_RACED_THIRD"];
    const values = ["fixture-first-value", "fixture-second-value", "fixture-third-value"];
    const link = await links.call<{ url: string; request_id: string }>(
      token,
      "secret_input_request",
      {
        ...target,
        names,
      },
    );
    const form = await links.fetch(new Request(link.url));
    const html = await form.text();
    expect(form.status).toBe(200);
    expect(html.match(/<input data-secret-input/gu)).toHaveLength(3);
    expect(html.match(/type="submit"/gu)).toHaveLength(1);
    names.forEach((name) => expect(html).toContain(name));
    expect((await links.submit(link.url, values.slice(1))).status).toBe(400);
    expect((await links.submit(link.url, values, { OVERWRITE_ME: "extra" })).status).toBe(400);
    expect(links.hooks.writes).toBe(0);
    // Both posts must read the unused link before either consumes it, so the D1 consume race is real, not sequential.
    let reads = 0,
      bothRead: () => void = () => undefined;
    const allRead = new Promise<void>((resolve) => {
      bothRead = () => resolve();
    });
    links.hooks.beforeHandoffRead = async () => {
      reads += 1;
      if (reads === 2) bothRead();
      await allRead;
    };
    const outcomes = await Promise.all([
      links.submit(link.url, values),
      links.submit(link.url, values),
    ]);
    const statuses = outcomes.map((response) => response.status).sort();
    expect(statuses[0]).toBe(200);
    expect([404, 409]).toContain(statuses[1]);
    expect(links.hooks.writes).toBe(3);
    for (const name of names) {
      expect(await countSecrets(control, f.project.projectId, name)).toEqual({ n: 1 });
    }
    const result = await links.call(token, "connection_status", { request_id: link.request_id });
    expect(result).toEqual({
      request_id: link.request_id,
      state: "secret_submitted",
      expires_at: expect.any(String),
      secrets: names.map((name) => ({ name, state: "saved" })),
    });
    values.forEach((value) => expect(JSON.stringify(result)).not.toContain(value));

    const maxLink = await links.call<{ url: string; request_id: string }>(
      token,
      "secret_input_request",
      { ...target, names: maximum },
    );
    const maxForm = await (await links.fetch(new Request(maxLink.url))).text();
    expect(maxForm.match(/<input data-secret-input/gu)).toHaveLength(10);
    // Ten values at the UTF-8 byte limit expand to about 150 KB on the wire.
    const maxValue = "€".repeat(1706) + "aa";
    expect(
      (
        await links.submit(
          maxLink.url,
          maximum.map(() => maxValue),
        )
      ).status,
    ).toBe(200);
    expect(
      await links.call(token, "connection_status", { request_id: maxLink.request_id }),
    ).toMatchObject({
      state: "secret_submitted",
      secrets: maximum.map((name) => ({ name, state: "saved" })),
    });

    const legacy = await links.call<{ url: string; request_id: string; expires_at: string }>(
      token,
      "secret_input_request",
      { ...target, name: "PORTAL_LEGACY" },
    );
    expect(legacy).toEqual({
      request_id: expect.any(String),
      url: expect.any(String),
      expires_at: expect.any(String),
    });
    const legacyHtml = await (await links.fetch(new Request(legacy.url))).text();
    expect(legacyHtml.match(/<input data-secret-input/gu)).toHaveLength(1);
    expect(legacyHtml).toContain("PORTAL_LEGACY");
    links.hooks.beforeWrite = async (input) => {
      expect(
        await links.call(token, "connection_status", { request_id: legacy.request_id }),
      ).toEqual({
        request_id: legacy.request_id,
        state: "secret_failed",
        expires_at: expect.any(String),
      });
      return input;
    };
    expect((await links.submit(legacy.url)).status).toBe(200);
    expect(await links.call(token, "connection_status", { request_id: legacy.request_id })).toEqual(
      {
        request_id: legacy.request_id,
        state: "secret_submitted",
        expires_at: expect.any(String),
      },
    );
  } finally {
    await control.dispose();
  }
}, 120000);

it("reports a partial save when Core fences a name outside the consumed handoff", async () => {
  const control = await createTestControl();
  try {
    const f = await remoteMcpFixture(control),
      links = anonymousLinks(f),
      token = await portalToken(f);
    const names = ["PORTAL_SAVED", "PORTAL_FAILED"];
    const link = await links.call<{ request_id: string; url: string }>(
      token,
      "secret_input_request",
      { project_id: f.project.projectId, environment: "dev", names },
    );
    links.hooks.beforeWrite = async (input) => {
      expect(input).toMatchObject({
        handoffDelegation: {
          secretSubmission: { requestHash: link.request_id, id: expect.any(String) },
        },
      });
      if (typeof input !== "object" || input === null) throw new TypeError("Missing write input");
      // Leave the actor and project authorization unchanged. Core must fence the substituted name.
      return links.hooks.writes === 2 ? { ...input, name: "PORTAL_UNLISTED" } : input;
    };
    const values = ["fixture-private-value", "fixture-private-value-2"];
    const refused = await links.submit(link.url, values);
    const refusedHtml = await refused.text();
    expect(refused.status).toBe(503);
    expect(refusedHtml).toContain("Some secrets could not be saved.");
    names.forEach((name) => expect(refusedHtml).toContain(name));
    expect(refusedHtml).not.toContain("fixture-private-value");
    expect(links.hooks.writes).toBe(2);
    expect((await links.fetch(new Request(link.url))).status).toBe(404);
    const result = await links.call(token, "connection_status", { request_id: link.request_id });
    expect(result).toEqual({
      request_id: link.request_id,
      state: "secret_failed",
      expires_at: expect.any(String),
      secrets: [
        { name: "PORTAL_SAVED", state: "saved" },
        { name: "PORTAL_FAILED", state: "unconfirmed" },
      ],
    });
    values.forEach((value) => expect(JSON.stringify(result)).not.toContain(value));
    expect(await countSecrets(control, f.project.projectId, "PORTAL_SAVED")).toEqual({ n: 1 });
    expect(await countSecrets(control, f.project.projectId, "PORTAL_FAILED")).toEqual({ n: 0 });
    expect(await countSecrets(control, f.project.projectId, "PORTAL_UNLISTED")).toEqual({ n: 0 });
  } finally {
    await control.dispose();
  }
}, 120000);

it("carries Connect and API-key origin through the real Control Worker and protected Make portal", async () => {
  const control = await createTestControl();
  try {
    const f = await remoteMcpFixture(control),
      password = "portal-session-password-0123456789abcdef",
      csrf = "c".repeat(43);
    const seen: unknown[] = [];
    const broker = {
      async providerReadiness() {
        return { state: "available" };
      },
      async catalogReadiness() {
        return { state: "available" };
      },
      async beginBrowser(actor: unknown) {
        seen.push(actor);
        return { url: `https://dev.connect.ohmyho.st/oauth/start?handoff=${"a".repeat(43)}` };
      },
      async complete(input: unknown) {
        seen.push(input);
        return {
          state: "active",
          grantId: f.project.projectId,
          organizationId: f.project.organizationId,
          projectId: f.project.projectId,
          environmentId: f.project.devEnvironmentId,
        };
      },
      async listConnectionCatalog() {
        return { organizations: [], teams: [], connections: [] };
      },
      async disconnectConnectionGrant() {
        return { state: "disconnected" };
      },
    };
    const originalAuth = f.bindings.AUTH_STATUS;
    const bindings = {
      ...f.bindings,
      SOURCE_INSPECTOR: {},
      BROWSER_LOGIN_ENABLED: "true",
      PORTAL_SESSION_PASSWORD: password,
      CONNECTION_CONTROL: f.store.connections,
      CONNECTION_BROKER: broker,
      AUTH_STATUS: {
        async fetch(req: Request) {
          if (new URL(req.url).pathname === "/api-key-validate")
            return Response.json(
              {
                key: {
                  id: "api_key_original",
                  userId: f.userId,
                  organizationId: f.workosOrganizationId,
                  permissions: ["integrations:read", "integrations:manage"],
                  expiresAt: null,
                },
              },
              { headers: { "cache-control": "no-store" } },
            );
          return originalAuth.fetch(req);
        },
      },
    };
    const fetch = (req: Request) =>
      f.worker.fetch(req, bindings as never, { waitUntil: () => undefined });
    const token = await f.connectToken({
      ohmyhost_authorization: {
        actions: ["integrations:manage"],
        organizationIds: [f.project.organizationId],
      },
    });
    const response = await fetch(
      new Request(`${connect.origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "integration_connection_begin",
            arguments: {
              organization_id: f.project.organizationId,
              project_id: f.project.projectId,
              environment_id: f.project.devEnvironmentId,
              idempotency_key: "connect-once",
            },
          },
        }),
      }),
    );
    const wire = await response.text(),
      message = JSON.parse(
        wire.includes("data: ")
          ? (wire
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6) ?? "{}")
          : wire,
      );
    expect(message.result?.isError, wire).not.toBe(true);
    const link = JSON.parse(message.result.content[0].text) as { url: string };
    const cookie =
      (
        await closeBrowserSession(
          {
            accessToken: await f.sessionToken(),
            refreshToken: "refresh-token",
            csrf,
            origin: connect.origin,
            createdAt: Date.now() - 1000,
            organizationId: null,
          },
          password,
        )
      ).split(";")[0] ?? "";
    expect((await fetch(new Request(link.url, { headers: { cookie } }))).status).toBe(200);
    const opaque = new URL(link.url).searchParams.get("request") ?? "";
    const form = (path: string, key: string, value: string) =>
      new Request(`${connect.origin}${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: connect.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf, [key]: value }),
      });
    const started = await fetch(form("/connections/authorize", "request", opaque));
    expect(started.status).toBe(200);
    expect(started.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await started.text()).toContain('http-equiv="refresh"');
    expect(seen[0]).toMatchObject({
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      environmentId: f.project.devEnvironmentId,
      principalId: `user:${f.userId}`,
      sessionId: "session_mcp",
      originatingDelegation: {
        clientId: connect.clientId,
        consentHash: f.identity.consentHash,
        action: "integrations:manage",
      },
    });
    expect((await fetch(form("/connections/complete", "result", "b".repeat(43)))).status).toBe(200);
    expect(seen[1]).toEqual({
      result: "b".repeat(43),
      principalId: `user:${f.userId}`,
      sessionId: "session_mcp",
    });
    const key = `sk_${"k".repeat(24)}`;
    const provider = await fetch(
      new Request(
        `${connect.origin}/v1/organizations/${f.project.organizationId}/connections/providers`,
        { headers: { authorization: `Bearer ${key}` } },
      ),
    );
    expect(provider.status).toBe(200);
    expect(await provider.json()).toMatchObject({ catalog_available: true });
    const begin = await fetch(
      new Request(
        `${connect.origin}/v1/organizations/${f.project.organizationId}/connections/begin`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "idempotency-key": "api-key-once",
          },
          body: JSON.stringify({
            provider: "make",
            project_id: f.project.projectId,
            environment_id: f.project.devEnvironmentId,
          }),
        },
      ),
    );
    expect(begin.status).toBe(201);
    const keyLink = (await begin.json()) as { url: string };
    const keyStarted = await fetch(
      form(
        "/connections/authorize",
        "request",
        new URL(keyLink.url).searchParams.get("request") ?? "",
      ),
    );
    expect(keyStarted.status).toBe(200);
    expect(keyStarted.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await keyStarted.text()).toContain('http-equiv="refresh"');
    expect(seen[2]).toMatchObject({
      principalId: `user:${f.userId}`,
      originatingCredential: {
        kind: "api_key",
        keyId: "api_key_original",
        userId: f.userId,
        workosOrganizationId: f.workosOrganizationId,
      },
    });
  } finally {
    await control.dispose();
  }
}, 120_000);
