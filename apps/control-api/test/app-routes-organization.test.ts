import { describe, expect, it, vi } from "vitest";

import { BillingServiceError, type BillingManagementPort } from "../src/billing.js";
import { createControlApi, IdempotencyKeyReusedError } from "../src/index.js";
import type { ControlApiDependencies } from "../src/index.js";
import type { OrganizationMcpConnectionsPort } from "../src/organization-mcp-connections.js";
import {
  GithubConnectionRequiredError,
  GithubConnectionStateUnknownError,
  type GithubOrganizationConnectionPort,
} from "../src/github-organization-connection.js";
import {
  GithubAuthorizationCodeRejectedError,
  GithubAuthorizationRejectedError,
  GithubRepositoryAccessRequiredError,
  GithubRepositoryNotInstalledError,
  type GithubSourceAuthorizationPort,
} from "../src/github-source-authorization.js";
import {
  API,
  BEARER,
  FOREIGN_ORGANIZATION_ID,
  JSON_BEARER,
  NOW,
  ORGANIZATION_ID,
  PRINCIPAL,
  creditAccountBody,
  creditBalanceBody,
  creditUsageBody,
  recordingReporter,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const RECHARGE = {
  organization_id: ORGANIZATION_ID,
  portal_available: false,
  enabled: false,
  revision: 0,
  status: "off",
  monthly_limit_minor: 1000,
  spent_minor: 0,
  currency: "usd",
  amount_minor: 900,
  credits: 1000,
  threshold_credits: 100,
  setup_url: null,
  invoice_url: null,
  billing_issue: null,
} as const;
const CHECKOUT = {
  organization_id: ORGANIZATION_ID,
  checkout_id: "0000000000000000000000000C",
} as const;
const CHECKOUT_ID = "0000000000000000000000000C";

function billingPort(overrides: Partial<BillingManagementPort> = {}): BillingManagementPort {
  return {
    getRecharge: vi.fn(async () => RECHARGE as never),
    configureRecharge: vi.fn(async () => RECHARGE as never),
    createCheckout: vi.fn(async () => CHECKOUT as never),
    getCheckout: vi.fn(async () => CHECKOUT as never),
    createPortal: vi.fn(async () => ({ url: "https://billing.stripe.com/p/session/x" }) as never),
    ...overrides,
  };
}

describe("organization billing routes", () => {
  const base = `${API}/v1/organizations/${ORGANIZATION_ID}/billing`;
  const rechargeBody = {
    enabled: true,
    revision: 3,
    monthly_limit_minor: 5000,
    consent: "off_session_v1",
  };

  it("serves nothing when billing is not composed", async () => {
    const app = createControlApi(routeDependencies());
    for (const [method, path] of [
      ["POST", "checkouts"],
      ["GET", `checkouts/${CHECKOUT_ID}`],
      ["POST", "portal"],
      ["GET", "recharge"],
      ["PUT", "recharge"],
    ]) {
      const response = await app.request(`${base}/${path}`, { method, headers: BEARER });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("reads auto-recharge and a checkout status for the organization owner", async () => {
    const billing = billingPort();
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(routeDependencies({ billing, authorization: { check } }));

    const recharge = await app.request(`${base}/recharge`, { headers: BEARER });
    expect(recharge.status).toBe(200);
    expect(recharge.headers.get("Cache-Control")).toBe("no-store");
    expect(await recharge.json()).toEqual(RECHARGE);
    expect(billing.getRecharge).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    expect(check).toHaveBeenCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "billing:manage",
    });

    const status = await app.request(`${base}/checkouts/${CHECKOUT_ID}`, { headers: BEARER });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(CHECKOUT);
    expect(billing.getCheckout).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      checkoutId: CHECKOUT_ID,
    });
    const invalid = await app.request(`${base}/checkouts/not-a-ulid`, { headers: BEARER });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ detail: "Supply the original checkout ID." });
  });

  it("configures auto-recharge only from the exact documented fields", async () => {
    const billing = billingPort();
    const app = createControlApi(routeDependencies({ billing }));
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      app.request(`${base}/recharge`, {
        method: "PUT",
        headers: { ...JSON_BEARER, "Idempotency-Key": "recharge-1", ...headers },
        body: JSON.stringify(body),
      });

    const accepted = await put(rechargeBody);
    expect(accepted.status).toBe(200);
    expect(billing.configureRecharge).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      actorId: "user:user_1",
      idempotencyKey: "recharge-1",
      enabled: true,
      monthlyLimitMinor: 5000,
      revision: 3,
      consent: "off_session_v1",
    });
    expect(
      (await put({ ...rechargeBody, enabled: false, consent: null })).status,
      "disabling carries a null consent",
    ).toBe(200);

    for (const [name, invalid, headers] of [
      ["missing key", rechargeBody, { "Idempotency-Key": "" }],
      ["consent without enabling", { ...rechargeBody, enabled: false }, {}],
      ["enabling without consent", { ...rechargeBody, consent: null }, {}],
      ["limit below minimum", { ...rechargeBody, monthly_limit_minor: 999 }, {}],
      ["limit above maximum", { ...rechargeBody, monthly_limit_minor: 100001 }, {}],
      ["fractional limit", { ...rechargeBody, monthly_limit_minor: 1000.5 }, {}],
      ["negative revision", { ...rechargeBody, revision: -1 }, {}],
      ["extra field", { ...rechargeBody, currency: "usd" }, {}],
      ["non-boolean flag", { ...rechargeBody, enabled: "yes" }, {}],
    ] as const) {
      const response = await put(invalid, { ...headers });
      expect(response.status, name).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    const notJson = await app.request(`${base}/recharge`, {
      method: "PUT",
      headers: { ...BEARER, "Idempotency-Key": "k", "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(notJson.status).toBe(400);
    expect(billing.configureRecharge).toHaveBeenCalledTimes(2);
  });

  it("opens the billing portal only for an empty request", async () => {
    const billing = billingPort();
    const app = createControlApi(routeDependencies({ billing }));
    const post = (body: unknown) =>
      app.request(`${base}/portal`, {
        method: "POST",
        headers: JSON_BEARER,
        body: JSON.stringify(body),
      });

    const opened = await post({});
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ url: "https://billing.stripe.com/p/session/x" });
    expect(billing.createPortal).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    const refused = await post({ return_url: "https://attacker.example" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      detail: expect.stringContaining("server-selected"),
    });
    expect(billing.createPortal).toHaveBeenCalledOnce();
  });

  it("creates a checkout from the offer and pack count and nothing else", async () => {
    const billing = billingPort();
    const app = createControlApi(routeDependencies({ billing }));
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      app.request(`${base}/checkouts`, {
        method: "POST",
        headers: { ...JSON_BEARER, "Idempotency-Key": "checkout-1", ...headers },
        body: JSON.stringify(body),
      });

    const created = await post({ offer: "topup", packs: 3 });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(CHECKOUT);
    expect(billing.createCheckout).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      actorId: "user:user_1",
      idempotencyKey: "checkout-1",
      offer: "topup",
      packs: 3,
    });
    expect((await post({ offer: "paid", packs: 1 })).status).toBe(201);

    for (const [name, invalid, headers] of [
      ["missing key", { offer: "topup", packs: 1 }, { "Idempotency-Key": "" }],
      ["unknown offer", { offer: "enterprise", packs: 1 }, {}],
      ["no packs", { offer: "topup", packs: 0 }, {}],
      ["too many packs", { offer: "topup", packs: 101 }, {}],
      ["fractional packs", { offer: "topup", packs: 1.5 }, {}],
      ["string packs", { offer: "topup", packs: "2" }, {}],
      ["several Paid packs", { offer: "paid", packs: 2 }, {}],
      ["extra field", { offer: "topup", packs: 1, price_id: "price_x" }, {}],
    ] as const) {
      const response = await post(invalid, { ...headers });
      expect(response.status, name).toBe(400);
    }
    expect(billing.createCheckout).toHaveBeenCalledTimes(2);
  });

  it("maps billing service outcomes without exposing provider detail", async () => {
    const outcomes: unknown[] = [
      new BillingServiceError(409, "paid_plan_required"),
      new BillingServiceError(404),
      new BillingServiceError(409),
      new BillingServiceError(400),
      new BillingServiceError(503),
      new Error("stripe-private-canary"),
    ];
    const fail = async () => {
      throw outcomes.shift();
    };
    const billing = billingPort({
      getRecharge: fail as never,
      createCheckout: fail as never,
    });
    const app = createControlApi(routeDependencies({ billing }));
    const recharge = () => app.request(`${base}/recharge`, { headers: BEARER });
    const checkout = () =>
      app.request(`${base}/checkouts`, {
        method: "POST",
        headers: { ...JSON_BEARER, "Idempotency-Key": "k" },
        body: JSON.stringify({ offer: "topup", packs: 1 }),
      });

    const paidRequired = await recharge();
    expect(paidRequired.status).toBe(402);
    expect(await paidRequired.json()).toMatchObject({ code: "paid_plan_required" });
    expect((await recharge()).status).toBe(404);
    const rechargeConflict = await recharge();
    expect(rechargeConflict.status).toBe(409);
    // a refused Stripe call answers 409 and is not retryable: the same request gets the same refusal
    expect(await rechargeConflict.json()).toMatchObject({
      code: "billing_recharge_conflict",
      retryable: false,
    });
    outcomes.unshift(new BillingServiceError(409));
    const purchaseConflict = await checkout();
    expect(purchaseConflict.status).toBe(409);
    expect(await purchaseConflict.json()).toMatchObject({
      code: "billing_purchase_conflict",
      retryable: false,
    });
    const invalid = await checkout();
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
    const unavailable = await checkout();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ retryable: true });
    const unexpected = await recharge();
    const text = await unexpected.text();
    expect(unexpected.status).toBe(503);
    expect(text).not.toContain("stripe-private-canary");
  });

  it("applies authentication, scope, rate limit and permission checks before the port", async () => {
    const billing = billingPort();
    const open = (overrides: Partial<ControlApiDependencies> = {}) =>
      createControlApi(routeDependencies({ billing, ...overrides }));
    const get = (app: ReturnType<typeof createControlApi>, path = `${base}/recharge`) =>
      app.request(path, { headers: BEARER });

    const anonymous = await open().request(`${base}/recharge`);
    expect(anonymous.status).toBe(401);
    const down = await get(
      open({
        authentication: {
          authenticate: async () => {
            throw new Error("identity provider offline");
          },
        },
      }),
    );
    expect(down.status).toBe(503);
    expect((await get(open(), `${base}/recharge?x=1`)).status).toBe(400);
    const badRequestId = await open().request(`${base}/recharge`, {
      headers: { ...BEARER, "X-Request-Id": "r".repeat(129) },
    });
    expect(badRequestId.status).toBe(400);
    expect((await get(open(), `${API}/v1/organizations/not-a-ulid/billing/recharge`)).status).toBe(
      400,
    );
    expect(
      (await get(open(), `${API}/v1/organizations/${FOREIGN_ORGANIZATION_ID}/billing/recharge`))
        .status,
    ).toBe(404);
    const limited = await get(
      open({
        rateLimits: {
          consume: async ({ dimension }) =>
            dimension === "organization"
              ? { allowed: false, retryAfterSeconds: 12 }
              : { allowed: true },
        },
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("12");
    const throttled = await get(
      open({ rateLimits: { consume: async () => ({ allowed: false, retryAfterSeconds: 1 }) } }),
    );
    expect(throttled.status).toBe(429);
    expect((await get(open({ authorization: { check: async () => "deny" } }))).status).toBe(404);
    const outage = await get(
      open({
        authorization: {
          check: async () => {
            throw new Error("authorization offline");
          },
        },
      }),
    );
    expect(outage.status).toBe(503);
    expect(billing.getRecharge).not.toHaveBeenCalled();
  });
});

describe("organization credit reports", () => {
  const report = (
    credits: Partial<NonNullable<ControlApiDependencies["credits"]>>,
    overrides: Partial<ControlApiDependencies> = {},
  ) =>
    createControlApi(
      routeDependencies({
        credits: credits as NonNullable<ControlApiDependencies["credits"]>,
        ...overrides,
      }),
    );
  const get = (app: ReturnType<typeof createControlApi>, path: string, headers = {}) =>
    app.request(`${API}/v1/organizations/${ORGANIZATION_ID}/${path}`, {
      headers: { ...BEARER, ...headers },
    });

  it("serves the balance, the account and the recent usage with their validated bodies", async () => {
    const credits = {
      readOrganization: vi.fn(async () => creditBalanceBody() as never),
      readAccount: vi.fn(async () => creditAccountBody() as never),
      readUsage: vi.fn(async () => creditUsageBody() as never),
    };
    const check = vi.fn(async () => "allow" as const);
    const app = report(credits, { authorization: { check } });

    const balance = await get(app, "credits");
    expect(balance.status, await balance.clone().text()).toBe(200);
    expect(balance.headers.get("Cache-Control")).toBe("no-store");
    expect(await balance.json()).toEqual(creditBalanceBody());
    expect(credits.readOrganization).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(check).toHaveBeenCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "credits:read",
    });

    const account = await get(app, "account");
    expect(account.status).toBe(200);
    expect(await account.json()).toEqual(creditAccountBody());
    expect(credits.readAccount).toHaveBeenCalledWith(ORGANIZATION_ID);

    const usage = await get(app, "credit-usage");
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual(creditUsageBody());
    expect(credits.readUsage).toHaveBeenCalledWith(ORGANIZATION_ID);
  });

  it("accepts a seven-day grace window and refuses any other duration", async () => {
    const grace = {
      ...creditBalanceBody(),
      grace_started_at: "2026-09-01T00:00:00.000Z",
      grace_expires_at: "2026-09-08T00:00:00.000Z",
    };
    const ok = await get(report({ readOrganization: async () => grace as never }), "credits");
    expect(ok.status).toBe(200);
    const bad = await get(
      report({
        readOrganization: async () =>
          ({ ...grace, grace_expires_at: "2026-09-09T00:00:00.000Z" }) as never,
      }),
      "credits",
    );
    expect(bad.status).toBe(503);
  });

  it("fails closed on a balance that violates the credit contract", async () => {
    const { reports, reporter } = recordingReporter();
    for (const broken of [
      { ...creditBalanceBody(), unit: "credits" },
      // what the credit was spent on is read from credit-usage, never from the balance
      { ...creditBalanceBody(), active_meters: ["builds.compute"] },
      { ...creditBalanceBody(), rate_cards: [] },
      { ...creditBalanceBody(), available_micros: "-1" },
      { ...creditBalanceBody(), as_of: "yesterday" },
      { ...creditBalanceBody(), extra: true },
      { ...creditBalanceBody(), organization_id: "invalid" },
      { ...creditBalanceBody(), grace_started_at: NOW },
      "not an object",
    ]) {
      const response = await get(
        report({ readOrganization: async () => broken as never }, { reporter }),
        "credits",
      );
      expect(response.status, JSON.stringify(broken)).toBe(503);
      expect(await response.json()).toMatchObject({ code: "service_unavailable", retryable: true });
    }
    expect(reports).toEqual([]);
  });

  it("fails closed on malformed usage and account reports and on a missing credit store", async () => {
    const usage = await get(
      report({ readUsage: async () => ({ ...creditUsageBody(), period: "2026-13" }) as never }),
      "credit-usage",
    );
    expect(usage.status).toBe(503);
    const account = await get(
      report({ readAccount: async () => ({ ...creditAccountBody(), plan: "gold" }) as never }),
      "account",
    );
    expect(account.status).toBe(503);
    const store = createControlApi(routeDependencies());
    const missing = await get(store, "credits");
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      detail: "Credit report is temporarily unavailable.",
    });
    const thrown = await get(
      report({
        readOrganization: async () => {
          throw new Error("d1-private-canary");
        },
      }),
      "credits",
    );
    const text = await thrown.text();
    expect(thrown.status).toBe(503);
    expect(text).not.toContain("d1-private-canary");
  });

  it("validates the report queries: none of the reports takes a query parameter", async () => {
    const readUsage = vi.fn(async () => creditUsageBody() as never);
    const app = report({ readUsage, readOrganization: async () => creditBalanceBody() as never });
    for (const path of [
      "credit-usage?month=2026-09",
      "credit-usage?cursor=0000000000000000000000000A",
      "credit-usage?limit=5",
      "credits?month=2026-09",
      "account?x=1",
    ]) {
      const response = await get(app, path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    for (const path of ["credits", "credit-usage", "account"]) {
      const response = await get(app, path, { "X-Request-Id": "r".repeat(129) });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_request",
        detail: "X-Request-Id is invalid.",
      });
    }
    expect(readUsage).not.toHaveBeenCalled();
    const badOrganization = await app.request(`${API}/v1/organizations/nope/credits`, {
      headers: BEARER,
    });
    expect(badOrganization.status).toBe(400);
  });

  it("hides foreign organizations and denied or unreachable permission decisions", async () => {
    const credits = { readOrganization: vi.fn(async () => creditBalanceBody() as never) };
    const foreign = await createControlApi(
      routeDependencies({ credits: credits as never }),
    ).request(`${API}/v1/organizations/${FOREIGN_ORGANIZATION_ID}/credits`, { headers: BEARER });
    expect(foreign.status).toBe(404);
    expect(
      (await get(report(credits, { authorization: { check: async () => "deny" } }), "credits"))
        .status,
    ).toBe(404);
    const outage = await get(
      report(credits, {
        authorization: {
          check: async () => {
            throw new Error("authorization offline");
          },
        },
      }),
      "credits",
    );
    expect(outage.status).toBe(503);
    const limited = await get(
      report(credits, {
        rateLimits: {
          consume: async ({ dimension }) =>
            dimension === "organization"
              ? { allowed: false, retryAfterSeconds: 4 }
              : { allowed: true },
        },
      }),
      "credits",
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("4");
    const anonymous = await report(credits).request(
      `${API}/v1/organizations/${ORGANIZATION_ID}/credits`,
    );
    expect(anonymous.status).toBe(401);
    const throttled = await get(
      report(credits, {
        rateLimits: { consume: async () => ({ allowed: false, retryAfterSeconds: 1 }) },
      }),
      "credits",
    );
    expect(throttled.status).toBe(429);
    expect(credits.readOrganization).not.toHaveBeenCalled();
  });
});

describe("organization GitHub connection routes", () => {
  const connection = {
    connection_id: "0000000000000000000000000D",
    organization_id: ORGANIZATION_ID,
    installation_id: "12345",
    account_id: "678",
    account_login: "example",
    account_type: "Organization",
    github_user_id: "9",
    github_user_login: "owner",
    connected_at: NOW,
    revoked_at: null,
    settings_url: "https://github.com/settings/installations/12345",
  } as const;
  const base = `${API}/v1/organizations/${ORGANIZATION_ID}/github`;
  const port = (overrides: Partial<GithubOrganizationConnectionPort> = {}) =>
    ({
      status: vi.fn(async () => ({ status: "connected", connection })),
      begin: vi.fn(async () => ({
        authorization_id: "0000000000000000000000000E",
        status: "pending",
        last_failure: null,
        authorization_url: "https://github.com/login/oauth/authorize?state=opaque",
        expires_at: NOW,
        connection: null,
      })),
      callback: vi.fn(async () => null),
      link: vi.fn(),
      ...overrides,
    }) as unknown as GithubOrganizationConnectionPort;
  const connect = (
    app: ReturnType<typeof createControlApi>,
    body: unknown = {},
    headers: Record<string, string> = {},
    path = `${base}:connect`,
  ) =>
    app.request(path, {
      method: "POST",
      headers: { ...JSON_BEARER, "Idempotency-Key": "github-1", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("reports the connection and starts one authorization with the revalidated principal", async () => {
    const github = port();
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      routeDependencies({ githubOrganizationConnection: github, authorization: { check } }),
    );

    const status = await app.request(base, { headers: BEARER });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "connected", connection });
    expect(github.status).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "sources:read",
    });

    const started = await connect(app);
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ status: "pending" });
    expect(github.begin).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      principal: PRINCIPAL,
      idempotencyKey: "github-1",
    });
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "sources:link",
    });
  });

  it("disconnects the workspace connection for an Owner only and reports it revoked", async () => {
    const revoked = { status: "revoked", connection: { ...connection, revoked_at: NOW } };
    const github = port({ disconnect: vi.fn(async () => revoked) as never });
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      routeDependencies({ githubOrganizationConnection: github, authorization: { check } }),
    );

    const response = await app.request(base, { method: "DELETE", headers: BEARER });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(revoked);
    expect(github.disconnect).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      principal: PRINCIPAL,
    });
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "sources:link",
    });

    const denied = createControlApi(
      routeDependencies({
        githubOrganizationConnection: github,
        authorization: { check: async () => "deny" as const },
      }),
    );
    expect((await denied.request(base, { method: "DELETE", headers: BEARER })).status).toBe(404);
    expect(github.disconnect).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without the connection port and refuses malformed requests", async () => {
    const missing = await createControlApi(routeDependencies()).request(base, { headers: BEARER });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      detail: "GitHub connection is unavailable.",
      retryable: true,
    });

    const github = port();
    const app = createControlApi(routeDependencies({ githubOrganizationConnection: github }));
    for (const [body, headers, path] of [
      [{}, { "Idempotency-Key": "" }, undefined],
      [{ extra: true }, {}, undefined],
      ["{", {}, undefined],
      [{}, { "Content-Type": "text/plain" }, undefined],
      [{}, {}, `${base}:connect?x=1`],
      [{}, { "X-Request-Id": "r".repeat(129) }, undefined],
      [{}, {}, `${API}/v1/organizations/nope/github:connect`],
    ] as const) {
      const response = await connect(app, body, { ...headers }, path);
      expect(response.status, JSON.stringify([body, headers, path])).toBe(400);
    }
    expect(github.begin).not.toHaveBeenCalled();
  });

  it("applies authentication, scope, limits and permission before and around the port", async () => {
    const github = port();
    const open = (overrides: Partial<ControlApiDependencies> = {}) =>
      createControlApi(routeDependencies({ githubOrganizationConnection: github, ...overrides }));
    expect((await open().request(base)).status).toBe(401);
    expect(
      (
        await open({
          authentication: {
            authenticate: async () => {
              throw new Error("identity provider offline");
            },
          },
        }).request(base, { headers: BEARER })
      ).status,
    ).toBe(503);
    expect(
      (
        await open().request(`${API}/v1/organizations/${FOREIGN_ORGANIZATION_ID}/github`, {
          headers: BEARER,
        })
      ).status,
    ).toBe(404);
    const limited = await open({
      rateLimits: {
        consume: async ({ dimension }) =>
          dimension === "organization"
            ? { allowed: false, retryAfterSeconds: 6 }
            : { allowed: true },
      },
    }).request(base, { headers: BEARER });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("6");
    expect(
      (
        await open({
          rateLimits: { consume: async () => ({ allowed: false, retryAfterSeconds: 1 }) },
        }).request(base, { headers: BEARER })
      ).status,
    ).toBe(429);
    expect(
      (
        await open({ authorization: { check: async () => "deny" } }).request(base, {
          headers: BEARER,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await open({
          authorization: {
            check: async () => {
              throw new Error("authorization offline");
            },
          },
        }).request(base, { headers: BEARER })
      ).status,
    ).toBe(503);
    let calls = 0;
    const expiring = open({
      authentication: { authenticate: async () => (++calls === 1 ? PRINCIPAL : null) },
    });
    expect((await connect(expiring)).status).toBe(401);
    let flaky = 0;
    const failing = open({
      authentication: {
        authenticate: async () => {
          if (++flaky > 1) throw new Error("identity provider offline");
          return PRINCIPAL;
        },
      },
    });
    expect((await connect(failing)).status).toBe(503);
    expect(github.begin).not.toHaveBeenCalled();
    expect(github.status).not.toHaveBeenCalled();
  });

  it("maps connection failures to their documented answers", async () => {
    const { reports, reporter } = recordingReporter();
    const errors: unknown[] = [
      new IdempotencyKeyReusedError(),
      new GithubAuthorizationRejectedError(),
      new GithubConnectionRequiredError("github_connection_revoked"),
      new Error("github-private-canary"),
    ];
    const github = port({
      begin: (async () => {
        throw errors.shift();
      }) as never,
    });
    const app = createControlApi(
      routeDependencies({ githubOrganizationConnection: github, reporter }),
    );

    const reused = await connect(app);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });
    const rejected = await connect(app);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "forbidden" });
    const revoked = await connect(app);
    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toMatchObject({ code: "github_connection_revoked" });
    const failed = await connect(app);
    const text = await failed.text();
    expect(failed.status).toBe(503);
    expect(text).not.toContain("github-private-canary");
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "GITHUB_CONNECTION_UNAVAILABLE",
        route: "/v1/organizations/{organization_id}/github",
      },
    ]);
  });
});

describe("organization MCP connection routes", () => {
  const base = `${API}/v1/organizations/${ORGANIZATION_ID}/mcp-connections`;
  const CONNECTION = "0f1e2d3c-4b5a-4968-8777-665544332211";
  const listed = {
    connections: [
      {
        connection_id: CONNECTION,
        client_id: "client_one",
        user_id: "user_member",
        connected_at: NOW,
      },
    ],
  };
  const port = (overrides: Partial<OrganizationMcpConnectionsPort> = {}) =>
    ({
      list: vi.fn(async () => listed),
      revoke: vi.fn(async () => ({ state: "pending" as const })),
      ...overrides,
    }) as unknown as OrganizationMcpConnectionsPort;

  it("lists the workspace connections and disconnects one for Owners only", async () => {
    const connections = port();
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      routeDependencies({ organizationMcpConnections: connections, authorization: { check } }),
    );

    const list = await app.request(base, { headers: BEARER });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(listed);
    expect(connections.list).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "sources:link",
    });

    const revoked = await app.request(`${base}/${CONNECTION}`, {
      method: "DELETE",
      headers: BEARER,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ state: "pending" });
    expect(connections.revoke).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION,
    });

    const malformed = await app.request(`${base}/not-a-connection`, {
      method: "DELETE",
      headers: BEARER,
    });
    expect(malformed.status).toBe(404);
    expect(connections.revoke).toHaveBeenCalledTimes(1);

    const unknown = createControlApi(
      routeDependencies({
        organizationMcpConnections: port({ revoke: vi.fn(async () => null) }),
      }),
    );
    expect(
      (await unknown.request(`${base}/${CONNECTION}`, { method: "DELETE", headers: BEARER }))
        .status,
    ).toBe(404);

    const denied = createControlApi(
      routeDependencies({
        organizationMcpConnections: connections,
        authorization: { check: async () => "deny" as const },
      }),
    );
    expect((await denied.request(base, { headers: BEARER })).status).toBe(404);
    expect(
      (await denied.request(`${base}/${CONNECTION}`, { method: "DELETE", headers: BEARER })).status,
    ).toBe(404);
    expect(connections.list).toHaveBeenCalledTimes(1);
    expect(connections.revoke).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without the port and refuses foreign workspaces", async () => {
    const missing = await createControlApi(routeDependencies()).request(base, { headers: BEARER });
    expect(missing.status).toBe(503);
    const connections = port();
    const app = createControlApi(routeDependencies({ organizationMcpConnections: connections }));
    const foreign = await app.request(
      `${API}/v1/organizations/${FOREIGN_ORGANIZATION_ID}/mcp-connections`,
      { headers: BEARER },
    );
    expect(foreign.status).toBe(404);
    expect(connections.list).not.toHaveBeenCalled();
  });
});

describe("GET /v1/github/oauth/callback", () => {
  const CALLBACK = `${API}/v1/github/oauth/callback`;
  const SIGNED_IN = "user:user_signed_in";
  // The browser behind a provider callback is identified by its portal session alone.
  const callbackDependencies = (overrides: Partial<ControlApiDependencies> = {}) =>
    routeDependencies({ portalSessionPrincipal: async () => SIGNED_IN, ...overrides });
  const view = (
    status: "pending" | "authorizing" | "connected" | "failed" | "expired",
    lastFailure: string | null = null,
  ) =>
    ({
      authorization_id: "0000000000000000000000000E",
      status,
      last_failure: lastFailure,
      authorization_url: null,
      expires_at: NOW,
      connection: null,
    }) as never;
  const sourceView = (
    status: "pending" | "authorizing" | "authorized" | "failed" | "expired",
    lastFailure: string | null = null,
  ) =>
    ({
      authorization_id: "0000000000000000000000000E",
      status,
      last_failure: lastFailure,
      authorization_url: null,
      installation_url: null,
      expires_at: NOW,
      operation_id: null,
      installation_id: null,
      repository_id: null,
      repository_owner: "example",
      repository_name: "app",
    }) as never;
  const organizationPort = (callback: GithubOrganizationConnectionPort["callback"]) =>
    ({ callback }) as unknown as GithubOrganizationConnectionPort;
  const sourcePort = (callback: GithubSourceAuthorizationPort["callback"]) =>
    ({ callback }) as unknown as GithubSourceAuthorizationPort;
  const call = (
    app: ReturnType<typeof createControlApi>,
    query: string,
    headers: Record<string, string> = {},
  ) => app.request(`${CALLBACK}?${query}`, { headers });

  it("is unavailable without any GitHub authorization port", async () => {
    const response = await call(createControlApi(callbackDependencies()), "state=s&code=c");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      detail: "GitHub authorization is unavailable.",
      retryable: true,
    });
  });

  it.each([
    ["an unknown parameter", "state=s&code=c&extra=1"],
    ["a repeated parameter", "state=s&state=t&code=c"],
    ["a foreign issuer", "state=s&code=c&iss=https://evil.example"],
    ["a missing state", "code=c"],
    ["a malformed installation id", "state=s&installation_id=0&setup_action=install"],
    ["an unknown setup action", "state=s&installation_id=1&setup_action=remove"],
    ["a code together with an error", "state=s&code=c&error=access_denied"],
    ["neither code, error nor installation", "state=s"],
  ])("rejects a callback with %s before any port is called", async (_name, query) => {
    const callback = vi.fn(async () => view("connected"));
    const app = createControlApi(
      callbackDependencies({ githubOrganizationConnection: organizationPort(callback) }),
    );
    const response = await call(app, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      detail: "GitHub authorization callback is invalid.",
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("completes an organization authorization and sends the browser to the matching page", async () => {
    const results: unknown[] = [
      { view: view("connected"), redirect: null },
      { view: view("pending"), redirect: null },
      { view: view("authorizing"), redirect: null },
      { view: view("failed", "denied"), redirect: null },
      { view: view("failed"), redirect: null },
      { view: view("pending"), redirect: "/github/continue?step=2" },
    ];
    const callback = vi.fn(async () => results.shift() as never);
    const app = createControlApi(
      callbackDependencies({ githubOrganizationConnection: organizationPort(callback) }),
    );
    const locations: (string | null)[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await call(app, "state=opaque&code=authcode");
      expect(response.status).toBe(303);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      locations.push(response.headers.get("Location"));
    }
    expect(locations).toEqual([
      "/github/authorized",
      "/github/authorization-pending",
      "/github/authorization-pending",
      "/github/authorization-failed?reason=denied",
      "/github/authorization-failed?reason=code_spent",
      "/github/continue?step=2",
    ]);
    expect(callback).toHaveBeenNthCalledWith(1, {
      state: "opaque",
      signedInPrincipalId: SIGNED_IN,
      code: "authcode",
    });
  });

  it("forwards installation, setup and denial parameters to the organization flow", async () => {
    const callback = vi.fn(async () => ({ view: view("pending"), redirect: null }));
    const app = createControlApi(
      callbackDependencies({ githubOrganizationConnection: organizationPort(callback) }),
    );
    await call(app, "state=opaque&installation_id=4242&setup_action=update");
    expect(callback).toHaveBeenLastCalledWith({
      state: "opaque",
      signedInPrincipalId: SIGNED_IN,
      installationId: "4242",
      setupAction: "update",
    });
    await call(app, "state=opaque&setup_action=request");
    expect(callback).toHaveBeenLastCalledWith({
      state: "opaque",
      signedInPrincipalId: SIGNED_IN,
      setupAction: "request",
    });
    await call(app, "state=opaque&error=access_denied&error_description=nope");
    expect(callback).toHaveBeenLastCalledWith({
      state: "opaque",
      signedInPrincipalId: SIGNED_IN,
      denied: true,
    });
  });

  it("answers an unknown connection state with 403 JSON or a browser redirect", async () => {
    const app = createControlApi(
      callbackDependencies({ githubOrganizationConnection: organizationPort(async () => null) }),
    );
    const json = await call(app, "state=unknown&code=c");
    expect(json.status).toBe(403);
    expect(await json.json()).toMatchObject({
      code: "forbidden",
      detail: "GitHub connection state is unknown. Start github connect again.",
    });
    const browser = await call(app, "state=unknown&code=c", { Accept: "text/html,*/*" });
    expect(browser.status).toBe(303);
    expect(browser.headers.get("Location")).toBe(
      "/github/authorization-failed?reason=state_unknown",
    );

    // A browser without the portal session of any user is answered the same way and no port is asked.
    const organization = vi.fn(async () => ({ view: view("connected"), redirect: null }));
    const signedOut = createControlApi(
      callbackDependencies({
        portalSessionPrincipal: async () => null,
        githubOrganizationConnection: organizationPort(organization),
      }),
    );
    const stranger = await call(signedOut, "state=opaque&code=c", { Accept: "text/html" });
    expect(stranger.headers.get("Location")).toBe(
      "/github/authorization-failed?reason=state_unknown",
    );
    expect(organization).not.toHaveBeenCalled();
    // Without a composed portal session reader the route is unavailable instead of open.
    const unreadable = createControlApi(
      routeDependencies({ githubOrganizationConnection: organizationPort(organization) }),
    );
    expect((await call(unreadable, "state=opaque&code=c")).status).toBe(503);
    expect(organization).not.toHaveBeenCalled();
  });

  it("completes a repository authorization, sending denial when no code arrived", async () => {
    const results: unknown[] = [
      sourceView("authorized"),
      sourceView("pending"),
      sourceView("authorizing"),
      sourceView("failed", "repository_not_installed"),
      sourceView("expired"),
    ];
    const callback = vi.fn(async () => results.shift() as never);
    const app = createControlApi(
      callbackDependencies({ githubSourceAuthorization: sourcePort(callback) }),
    );
    const locations: (string | null)[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await call(app, "state=opaque&code=authcode");
      expect(response.status).toBe(303);
      locations.push(response.headers.get("Location"));
    }
    expect(locations).toEqual([
      "/github/authorized",
      "/github/authorization-pending",
      "/github/authorization-pending",
      "/github/authorization-failed?reason=repository_not_installed",
      "/github/authorization-failed?reason=code_spent",
    ]);
    expect(callback).toHaveBeenNthCalledWith(1, {
      state: "opaque",
      signedInPrincipalId: SIGNED_IN,
      code: "authcode",
    });
    results.push(sourceView("failed", "denied"));
    await call(app, "state=opaque&error=access_denied");
    expect(callback).toHaveBeenLastCalledWith({
      state: "opaque",
      signedInPrincipalId: SIGNED_IN,
      denied: true,
    });
  });

  it("falls back to the repository flow when the organization flow does not know the state", async () => {
    const organization = vi.fn(async () => null);
    const source = vi.fn(async () => sourceView("authorized"));
    const app = createControlApi(
      callbackDependencies({
        githubOrganizationConnection: organizationPort(organization),
        githubSourceAuthorization: sourcePort(source),
      }),
    );
    const response = await call(app, "state=opaque&code=authcode");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/github/authorized");
    expect(organization).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown state", new GithubConnectionStateUnknownError(), 403, "forbidden", "state_unknown"],
    [
      "repository not installed",
      new GithubRepositoryNotInstalledError(),
      403,
      "forbidden",
      "repository_not_installed",
    ],
    [
      "repository access required",
      new GithubRepositoryAccessRequiredError(),
      403,
      "forbidden",
      "repository_access_required",
    ],
    [
      "rejected code",
      new GithubAuthorizationCodeRejectedError(),
      409,
      "confirmation_invalid",
      "authorization_code_rejected",
    ],
    [
      "expired authorization",
      new GithubAuthorizationRejectedError("expired"),
      409,
      "confirmation_invalid",
      "expired",
    ],
    [
      "inactive session",
      new GithubAuthorizationRejectedError("session_inactive"),
      409,
      "confirmation_invalid",
      "session_inactive",
    ],
    [
      "declined authorization",
      new GithubAuthorizationRejectedError("denied"),
      409,
      "confirmation_invalid",
      "denied",
    ],
    [
      "spent code",
      new GithubAuthorizationRejectedError("code_spent"),
      409,
      "confirmation_invalid",
      "code_spent",
    ],
    [
      "provider outage",
      new Error("github-private-canary"),
      503,
      "service_unavailable",
      "provider_unavailable",
    ],
  ])(
    "maps %s to a problem document and a browser failure page",
    async (_name, error, status, code, reason) => {
      const { reports, reporter } = recordingReporter();
      const app = createControlApi(
        callbackDependencies({
          reporter,
          githubSourceAuthorization: sourcePort(async () => {
            throw error;
          }),
        }),
      );

      const json = await call(app, "state=opaque&code=authcode");
      const text = await json.text();
      expect(json.status).toBe(status);
      expect(JSON.parse(text)).toMatchObject({ code });
      expect(text).not.toContain("github-private-canary");
      const browser = await call(app, "state=opaque&code=authcode", { Accept: "text/html" });
      expect(browser.status).toBe(303);
      expect(browser.headers.get("Location")).toBe(`/github/authorization-failed?reason=${reason}`);
      expect(reports.map((entry) => entry.code)).toEqual(
        reason === "provider_unavailable"
          ? ["GITHUB_OAUTH_CALLBACK_FAILED", "GITHUB_OAUTH_CALLBACK_FAILED"]
          : [],
      );
    },
  );

  it("explains each terminal authorization ending in its own words", async () => {
    const details = new Map<string, string>();
    for (const reason of ["expired", "session_inactive", "denied", "code_spent"] as const) {
      const app = createControlApi(
        callbackDependencies({
          githubSourceAuthorization: sourcePort(async () => {
            throw new GithubAuthorizationRejectedError(reason);
          }),
        }),
      );
      const body = await (await call(app, "state=opaque&code=authcode")).json();
      details.set(reason, body.detail);
    }
    expect(new Set(details.values()).size).toBe(4);
  });
});
