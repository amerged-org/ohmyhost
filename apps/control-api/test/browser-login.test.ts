import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { createGrowthReporter, reportBrowserGrowth } from "../src/growth-events.js";
import { handleBrowserLogin } from "../src/browser-login.js";
import { openBrowserSession, closeBrowserSession } from "../src/browser-session.js";
import { PORTAL_CLIENT_RELEASE, PORTAL_SCRIPT } from "../src/generated-portal-assets.js";
import { portalPrompt, renderPortalPage } from "../src/portal-page.js";
import { redirectToPortalLogin } from "../src/portal-login-resume.js";
const origin = "https://app.ohmyho.st",
  org = "01M21T9VB6J0P0QWQJ4J3086ZH",
  project = "01M21T9VB6J0P0QWQJ4J3086ZJ",
  password = "test-only-portal-password-32-characters";
class LoginTransport {
  calls: Request[] = [];
  tokenStatus = 200;
  identityStatus = 200;
  refreshes = 0;
  created = 0;
  source: string | null = null;
  utm: Record<string, string> | undefined;
  hasOrg = true;
  // Replaces the listed workspaces, in the order given, and the initial workspace the profile reports.
  listedOrganizations: Array<{ id: string; name: string; workos_id: string }> | null = null;
  initialWorkspaceId: string | null = org;
  refreshedOrganizations: string[] = [];
  createStatus = 201;
  multipleOrgs = false;
  profileFailure = 0;
  accountDenied = false;
  prodUrl: string | null = "https://test-otter-builds.check.omh.st";
  lifecycle = "active";
  devAccessMode: "protected" | "public" = "protected";
  portalUrl = "https://billing.stripe.com/p/session/test-only";
  portalAvailable = false;
  plan = "paid";
  rechargeEnabled = false;
  userKeys: Array<{
    id: string;
    organization_id: string;
    name: string;
    obfuscated_value: string;
    permissions: string[];
    expires_at: null;
    created_at: string;
    last_used_at: null;
  }> = [];
  keyRequests = new Set<string>();
  keyNames = new Map<string, string>();
  loseNextKeyResponse = false;
  keyValue = "sk_portal_test_only_secret_123456789";
  flag = { project_id: project, enabled: false, enabled_at: null as string | null };
  flagRequired = false;
  paidUntil: string | null = null;
  budgetStatus = 200;
  devAccessStatus = 200;
  flagStatus = 200;
  budget = {
    project_id: project,
    amount_micros: null as string | null,
    mode: "continue" as "continue" | "stop",
    used_micros: "123400000",
    reserved_micros: "1000000",
    period_start: "2026-09-01T00:00:00.000Z",
    period_end: "2026-10-01T00:00:00.000Z",
    as_of: "2026-09-13T12:00:00.000Z",
  };
  profile() {
    return {
      user_id: "user_example",
      name: "Test User",
      email: "test@example.invalid",
      email_verified: true,
      signup_source: this.source,
      attributed_at: this.source ? "2026-09-13T12:00:00.000Z" : null,
      initial_workspace_id: this.hasOrg ? this.initialWorkspaceId : null,
      organization_ids: this.hasOrg ? [org] : [],
      organizations:
        this.listedOrganizations ??
        (this.hasOrg
          ? [
              { id: org, name: "My workspace", workos_id: "org_example" },
              ...(this.multipleOrgs
                ? [{ id: "01M21T9VB6J0P0QWQJ4J3086ZM", name: "Team", workos_id: "org_team" }]
                : []),
            ]
          : []),
    };
  }
  async fetch(request: Request) {
    this.calls.push(request);
    const url = new URL(request.url);
    if (url.origin === "https://api.workos.com") {
      const body = (await request.json()) as Record<string, string>;
      expect(body["client_id"]).toBe("client_test");
      expect(body).not.toHaveProperty("client_secret");
      if (body["grant_type"] === "authorization_code")
        expect(body["code_verifier"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      else {
        expect(body["grant_type"]).toBe("refresh_token");
        this.refreshes++;
        this.refreshedOrganizations.push(body["organization_id"] ?? "");
      }
      return Response.json(
        { access_token: "test-access-token", refresh_token: "test-refresh-token" },
        { status: this.tokenStatus },
      );
    }
    expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
    if (url.pathname === `/v1/organizations/${org}/user-api-keys`) {
      if (request.method === "GET")
        return Response.json({ data: this.userKeys, next_cursor: null });
      const body = (await request.json()) as { name: string };
      const key = request.headers.get("idempotency-key") ?? "";
      const replayed = this.keyRequests.has(key);
      // WorkOS answers a reused Idempotency-Key that names a different token with 409.
      if (replayed && this.keyNames.get(key) !== body.name)
        return Response.json({ status: 409, code: "idempotency_key_reused" }, { status: 409 });
      this.keyRequests.add(key);
      this.keyNames.set(key, body.name);
      if (!replayed)
        this.userKeys.push({
          id: "api_key_owned",
          organization_id: org,
          name: body.name,
          obfuscated_value: "sk_…6789",
          permissions: ["projects:read"],
          expires_at: null,
          created_at: "2026-09-14T00:00:00.000Z",
          last_used_at: null,
        });
      if (this.loseNextKeyResponse) {
        this.loseNextKeyResponse = false;
        return Response.json({ status: 503 }, { status: 503 });
      }
      return Response.json({
        request_id: project,
        replayed,
        key: this.userKeys[0],
        value: replayed ? null : this.keyValue,
      });
    }
    if (url.pathname.startsWith(`/v1/organizations/${org}/user-api-keys/`)) {
      const id = url.pathname.split("/").at(-1);
      if (id !== "api_key_owned") return Response.json({ status: 404 }, { status: 404 });
      this.userKeys = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me")
      return Response.json(
        {
          actor_id: "user:user_example",
          organization_ids: this.hasOrg ? [org] : [],
          email: "user@example.test",
          organizations: this.hasOrg ? [{ id: org, name: "Workspace" }] : [],
        },
        { status: this.identityStatus },
      );
    if (url.pathname === "/v1/me/signup-source") {
      const body = (await request.json()) as {
        source: string | null;
        utm?: Record<string, string>;
      };
      this.source ??= body.source;
      this.utm ??= body.utm;
      return Response.json(this.profile());
    }
    if (url.pathname === "/v1/me/profile") {
      if (this.profileFailure) {
        const status = this.profileFailure;
        this.profileFailure = 0;
        return Response.json({ status }, { status });
      }
      return Response.json(this.profile());
    }
    if (url.pathname === "/v1/organizations") {
      this.created++;
      if (this.createStatus !== 201)
        return Response.json({ status: this.createStatus }, { status: this.createStatus });
      this.hasOrg = true;
      return Response.json({ id: org, name: "My workspace" }, { status: 201 });
    }
    if (url.pathname.endsWith("/account") && this.accountDenied)
      return Response.json({ status: 403 }, { status: 403 });
    if (url.pathname.endsWith("/account"))
      return Response.json({
        organization_id: org,
        name: "My workspace",
        workos_organization_id: "org_example",
        plan: this.plan,
        plan_source: this.plan === "paid" ? "granted" : "free",
        paid_until: this.paidUntil,
        available_micros: "1234500000",
        monthly_micros: "200000000",
        one_time_micros: "1034500000",
        reserved_micros: "12000000",
        next_expiry: "2026-10-01T00:00:00.000Z",
        as_of: "2026-09-13T12:00:00.000Z",
      });
    if (url.pathname === "/v1/projects")
      return Response.json({
        items: [
          {
            id: project,
            organization_id: org,
            name: "Test application",
            handle: "test-otter-builds",
            data_mode: "isolated",
            created_at: "2026-09-13T12:00:00.000Z",
          },
        ],
        next_cursor: null,
      });
    if (url.pathname.endsWith("/status"))
      return Response.json({
        project_id: project,
        handle: "test-otter-builds",
        lifecycle: this.lifecycle,
        dev_access_mode: this.devAccessMode,
        source: null,
        default_environment: null,
        head_deployment: { status: "active" },
        dev_url: "https://dev-test-otter-builds.check.omh.st",
        prod_url: this.prodUrl,
        latest_operation: { state: "succeeded" },
        cleanup_state: "not_started",
      });
    if (url.pathname.endsWith("/referral"))
      return Response.json({
        organization_id: org,
        referral_url: `https://ohmyho.st/?r=ref-${org.toLowerCase()}`,
      });
    if (url.pathname.endsWith("/powered-by-flag")) {
      if (request.method === "PUT" && this.flagStatus !== 200)
        return Response.json({ status: this.flagStatus }, { status: this.flagStatus });
      if (request.method === "PUT") {
        if (this.flagRequired)
          return Response.json({ status: 409, code: "powered_by_flag_required" }, { status: 409 });
        const { enabled } = (await request.json()) as { enabled: boolean };
        this.flag = {
          project_id: project,
          enabled,
          enabled_at: enabled ? "2026-09-13T12:00:00.000Z" : null,
        };
      }
      return Response.json(this.flag);
    }
    if (url.pathname.endsWith("/credit-budget")) {
      if (request.method === "PUT" && this.budgetStatus !== 200)
        return Response.json({ status: this.budgetStatus }, { status: this.budgetStatus });
      if (request.method === "PUT") {
        const value = await request.json();
        Object.assign(this.budget, value);
      }
      return Response.json(this.budget);
    }
    if (url.pathname.endsWith("/dev-access-tickets") && this.devAccessStatus !== 200)
      return Response.json({ status: this.devAccessStatus }, { status: this.devAccessStatus });
    if (url.pathname.endsWith("/dev-access-tickets"))
      return Response.json({
        redeem_url: "https://dev-test-otter-builds.check.omh.st/.ohmyhost/access?ticket=test",
        expires_at: "2026-09-13T12:05:00.000Z",
      });
    if (url.pathname.endsWith("/billing/recharge"))
      return Response.json({
        organization_id: org,
        portal_available: this.portalAvailable,
        enabled: this.rechargeEnabled,
        revision: 0,
        status: this.rechargeEnabled ? "on" : "off",
        monthly_limit_minor: 10000,
        spent_minor: 0,
        currency: "usd",
        amount_minor: 900,
        credits: 1000,
        threshold_credits: 100,
        setup_url: null,
        invoice_url: null,
        billing_issue: null,
      });
    if (url.pathname.endsWith("/billing/portal"))
      return Response.json({
        organization_id: org,
        url: this.portalUrl,
        created_at: "2026-09-13T12:00:00.000Z",
      });
    if (url.pathname === "/v1/session:revoke") return Response.json({ status: "revoked" });
    throw Error("Unexpected test route " + url.pathname);
  }
}
function config(transport: LoginTransport) {
  return {
    origin,
    clientId: "client_test",
    sessionPassword: password,
    billingEnabled: true,
    crypto: webcrypto as unknown as Crypto,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    providerFetch: transport.fetch.bind(transport),
    apiFetch: transport.fetch.bind(transport),
  };
}
async function login(d: ReturnType<typeof config>, query = "r=hostmebaby", resumeCookie = "") {
  const start = await handleBrowserLogin(
    new Request(origin + "/login/start?" + query, {
      method: "POST",
      headers: { origin, cookie: resumeCookie },
    }),
    d,
  );
  expect(start?.status).toBe(303);
  const target = new URL(start?.headers.get("location") ?? "");
  expect(target.searchParams.get("code_challenge_method")).toBe("S256");
  const pending = start?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const callback = await handleBrowserLogin(
    new Request(
      origin + "/login/callback?code=test-code&state=" + target.searchParams.get("state"),
      { headers: { cookie: [pending, resumeCookie].filter(Boolean).join("; ") } },
    ),
    d,
  );
  const cookie =
    callback?.headers
      .getSetCookie()
      .find((x) => x.startsWith("__Host-omh-session="))
      ?.split(";")[0] ?? "";
  return { callback, cookie, pending, target };
}
it("returns a repeated callback to login only with an existing session and no pending cookie", async () => {
  const transport = new LoginTransport();
  const d = config(transport);
  const { callback, cookie, pending, target } = await login(d, "view=profile");
  expect(callback?.status).toBe(303);
  expect(callback?.headers.get("location")).toBe("/profile");
  expect(cookie).toMatch(/^__Host-omh-session=/u);

  const callbackUrl = new URL("/login/callback", origin);
  callbackUrl.searchParams.set("code", "test-code");
  const state = target.searchParams.get("state") ?? "";
  callbackUrl.searchParams.set("state", state);
  const callsAfterLogin = transport.calls.length;
  const replay = await handleBrowserLogin(new Request(callbackUrl, { headers: { cookie } }), d);
  expect(replay?.status).toBe(303);
  expect(replay?.headers.get("location")).toBe("/login");
  expect(replay?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(
    replay?.headers.getSetCookie().some((value) => value.startsWith("__Host-omh-session=")),
  ).toBe(false);

  const url = callbackUrl.href;
  const otherState = (state.startsWith("a") ? "b" : "a") + state.slice(1);
  for (const request of [
    new Request(url),
    new Request(url, { headers: { cookie: cookie + "tampered" } }),
    new Request(url, { method: "HEAD", headers: { cookie } }),
    new Request(url + "&state=" + state, { headers: { cookie } }),
    new Request(origin + "/login/callback?code=test-code&state=short", { headers: { cookie } }),
    new Request(origin + "/login/callback?code=bad+code&state=" + state, { headers: { cookie } }),
    new Request(url, { headers: { cookie: cookie + "; __Host-omh-login=invalid" } }),
    new Request(origin + "/login/callback?code=test-code&state=" + otherState, {
      headers: { cookie: cookie + "; " + pending },
    }),
  ]) {
    const rejected = await handleBrowserLogin(request, d);
    expect(rejected?.status).toBe(400);
    expect(rejected?.headers.get("location")).toBeNull();
  }
  expect(transport.calls).toHaveLength(callsAfterLogin);
  const signedIn = await handleBrowserLogin(
    new Request(origin + "/login", { headers: { cookie } }),
    d,
  );
  expect(signedIn?.headers.get("location")).toBe("/");
});

it("resumes a protected form after login using only the browser's sealed link", async () => {
  const d = config(new LoginTransport());
  const handoff = "a".repeat(43);
  const paths = [
    `/connections/authorize?request=${handoff}`,
    `/connections/complete?result=${handoff}`,
    `/mcp/github?request=${handoff}&return_url=https%3A%2F%2Fchatgpt.com%2F`,
    `/mcp/secrets?request=${handoff}`,
  ];
  for (const path of paths) {
    const saved = await redirectToPortalLogin(new URL(path, origin), password, d.now().getTime());
    expect(saved?.status).toBe(303);
    expect(saved?.headers.get("cache-control")).toBe("no-store");
    expect(saved?.headers.get("referrer-policy")).toBe("no-referrer");
    const location = saved?.headers.get("location") ?? "";
    const query = new URL(location, origin).search.slice(1);
    const setCookie = saved?.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Secure; HttpOnly; SameSite=Lax; Max-Age=600");
    expect(location + setCookie).not.toContain(handoff);
    const cookie = setCookie.split(";")[0] ?? "";
    const missing = await handleBrowserLogin(new Request(origin + location), d);
    expect(missing?.status).toBe(410);
    const entry = await handleBrowserLogin(
      new Request(origin + location, { headers: { cookie } }),
      d,
    );
    expect(await entry?.text()).toContain(`action="/login/start?${query}"`);
    const { callback, target } = await login(d, query, cookie);
    expect(target.href).not.toContain(query);
    expect(target.href).not.toContain(handoff);
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get("location")).toBe(path);
    expect(callback?.headers.getSetCookie()).toContain(
      "__Host-omh-login-resume=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  }
  const now = d.now().getTime();
  for (const path of [
    "/login/callback?code=provider-code&state=provider-state",
    `/connections/authorize?request=${handoff}&next=https://example.invalid/`,
    `/mcp/secrets?request=${handoff}&request=${handoff}`,
  ])
    expect(await redirectToPortalLogin(new URL(path, origin), password, now)).toBeNull();
  const expired = await redirectToPortalLogin(
    new URL(paths[0] ?? "", origin),
    password,
    now - 600000,
  );
  const expiredEntry = await handleBrowserLogin(
    new Request(origin + expired?.headers.get("location"), {
      headers: { cookie: expired?.headers.get("set-cookie")?.split(";")[0] ?? "" },
    }),
    d,
  );
  expect(expiredEntry?.status).toBe(410);
  expect((await login(d, "view=tokens")).callback?.headers.get("location")).toBe("/tokens");
});
async function post(
  d: ReturnType<typeof config>,
  cookie: string,
  path: string,
  fields: Record<string, string>,
) {
  const session = await openBrowserSession(cookie, password, origin, d.now().getTime());
  return handleBrowserLogin(
    new Request(origin + path, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: session?.csrf ?? "", ...fields }),
    }),
    d,
  );
}
it("reports the GitHub authorization outcome to a signed-out browser without asking it to sign in", async () => {
  // The customer arrives here from GitHub in the middle of an agent flow. A login card would be
  // the wrong answer: they have a terminal to go back to, not a portal to browse.
  const d = config(new LoginTransport());
  const pages = {
    "/github/authorized": "GitHub is connected.",
    "/github/authorization-pending": "Still confirming.",
    "/github/authorization-failed?reason=repository_not_installed":
      "The app cannot see this repository yet.",
    "/github/authorization-failed?reason=provider_unavailable":
      "GitHub could not confirm this authorization.",
    "/github/authorization-failed?reason=installation_access_required":
      "Choose the GitHub account that owns this installation.",
    "/github/authorization-failed?reason=account_admin_required":
      "Connect with a GitHub account owner or organization administrator.",
    "/github/authorization-failed?reason=state_unknown":
      "This link does not belong to an active request.",
    "/github/authorization-failed": "This authorization is no longer valid.",
  };
  for (const [path, headline] of Object.entries(pages)) {
    const page = await handleBrowserLogin(new Request(origin + path), d);
    const body = (await page?.text()) ?? "";
    expect({ path, status: page?.status }).toEqual({ path, status: 200 });
    expect(body).toContain(headline);
    expect(body).toContain('class="fbrandrow"');
    expect(page?.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(body).not.toContain("/login/start");
    expect(body).not.toContain("Copy prompt");
    // The outcome is the whole page. A marketing hero, a sign-in link or workspace actions here
    // read as "you are not done yet" to a customer who is done.
    expect(body).not.toContain("Your apps.");
    expect(body).not.toContain(">Log in<");
    expect(body).not.toContain('<div class="portal-actions">');
    expect(body).not.toContain("Your workspace");
    expect(body).toMatch(/go back to your agent/iu);
  }
});

it("keeps its own origin on every page that submits a form back to the portal", async () => {
  // A page served with no-referrer makes the browser send Origin: null on its own form
  // submission, and the portal then refuses its own request as coming from somewhere else.
  const t = new LoginTransport();
  const d = config(t);
  const { cookie } = await login(d);
  for (const path of ["/", "/profile", "/billing", "/tokens"]) {
    const page = await handleBrowserLogin(new Request(origin + path, { headers: { cookie } }), d);
    expect(page?.status).toBe(200);
    expect({ path, policy: page?.headers.get("referrer-policy") }).toEqual({
      path,
      policy: "same-origin",
    });
  }
});

it("keeps usage beside each project and opens only an observed production deployment", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  const overview = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  const body = (await overview?.text()) ?? "";
  expect(body).not.toContain('href="/usage"');
  expect(body).toContain(`data-dialog-target="usage-${project}"`);
  expect(body).toContain(`id="usage-${project}" aria-labelledby="usage-title-${project}"`);
  expect(body).toContain("Want to know anything? Ask your agent.");
  expect(body).toContain("123.4 <small>credits</small>");
  expect(body).toContain("Stop at limit");
  expect(body).toContain("Keep running");
  expect(body).toContain("Monthly limits use UTC calendar months.");
  expect(body).toContain("Deployed · Live");
  expect(body).toContain(
    `href="${new URL(t.prodUrl ?? "").href}" target="_blank" rel="noopener noreferrer"`,
  );
  expect(body).not.toContain("Open app ↗");
  expect(body).toContain('action="/dev-access"');
  for (const [lifecycle, prodUrl, label] of [
    ["active", null, "Not deployed"],
    ["active", "https://username:password@example.invalid", "Not deployed"],
    ["deleting", t.prodUrl, "Deleting"],
    ["deleted", t.prodUrl, "Deleted"],
  ] as const) {
    t.lifecycle = lifecycle;
    t.prodUrl = prodUrl;
    const page = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
    const html = (await page?.text()) ?? "";
    expect(html).toContain(`class="account-badge">${label}</span>`);
    expect(html).toContain('type="button" disabled aria-label="Production app is not available"');
    expect(html).not.toContain('class="project-icon-button project-live-link" href=');
  }
  t.accountDenied = true;
  const member = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  const memberHtml = (await member?.text()) ?? "";
  expect(memberHtml).toContain("Usage and monthly limits are available to the workspace owner.");
  expect(memberHtml).not.toContain('action="/budget"');
  expect(memberHtml).not.toContain('action="/flag"');
});

it("keeps the other projects on Projects and Usage while one project is deleting", async () => {
  const t = new LoginTransport(),
    deleting = "01M21T9VB6J0P0QWQJ4J3086ZK",
    base = config(t),
    d = {
      ...base,
      apiFetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/projects")
          return Response.json({
            items: [
              {
                id: project,
                organization_id: org,
                name: "Test application",
                handle: "test-otter-builds",
                data_mode: "isolated",
                created_at: "2026-09-13T12:00:00.000Z",
              },
              {
                id: deleting,
                organization_id: org,
                name: "Old application",
                handle: "old-application",
                data_mode: "isolated",
                created_at: "2026-09-13T12:00:00.000Z",
              },
            ],
            next_cursor: null,
          });
        if (url.pathname === `/v1/projects/${deleting}/status`)
          return Response.json({
            project_id: deleting,
            handle: "old-application",
            lifecycle: "deleting",
            dev_access_mode: "protected",
            source: null,
            default_environment: null,
            head_deployment: { status: "active" },
            dev_url: "https://dev-old-application.check.omh.st",
            prod_url: null,
            latest_operation: { state: "succeeded" },
            cleanup_state: "not_started",
          });
        // The powered-by-flag read covers only active projects, so the deleting project answers 404.
        if (url.pathname === `/v1/projects/${deleting}/powered-by-flag`)
          return Response.json({ status: 404 }, { status: 404 });
        return t.fetch(request);
      },
    };
  const { cookie } = await login(d);
  const overview = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  const html = (await overview?.text()) ?? "";
  expect(overview?.status).toBe(200);
  expect(html).toContain("Old application");
  expect(html).toContain('class="account-badge">Deleting</span>');
  expect(html).toContain(`id="flag-${project}"`);
  expect(html).not.toContain(`id="flag-${deleting}"`);
  const usage = await handleBrowserLogin(
    new Request(origin + "/usage", { headers: { cookie, accept: "text/markdown" } }),
    d,
  );
  expect(usage?.status).toBe(200);
  const markdown = (await usage?.text()) ?? "";
  expect(markdown).toContain("Status: deleting");
  expect(markdown).toContain("Used: 123.4 credits; limit: none; mode: continue");
});

it("lets the owner show the powered-by flag and explains why a Free domain keeps it", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  const card = async () =>
    (await (
      await handleBrowserLogin(
        new Request(origin + "/?cursor=next-page", { headers: { cookie } }),
        d,
      )
    )?.text()) ?? "";
  expect(await card()).toContain("Show ohmyho.st flag</button>");
  // The account menu ends with the workspace's referral link as a one-click copy chip.
  expect(await card()).toContain(
    `<input type="hidden" id="referral-link" value="https://ohmyho.st/?r=ref-${org.toLowerCase()}"><button type="button" class="referral-chip" data-copy-target="referral-link" data-copy-feedback="icon"`,
  );
  expect(await card()).toContain("<span>Refer and earn</span>");
  expect(await card()).toContain("adds 250 credits");
  const shown = await post(d, cookie, "/flag", {
    project,
    cursor: "next-page",
    enabled: "true",
    request_key: "portal-flag",
  });
  expect(shown?.headers.get("location")).toBe("/?cursor=next-page#flag-" + project);
  expect(t.flag.enabled).toBe(true);
  expect(await card()).toContain("Hide ohmyho.st flag</button>");
  t.flagRequired = true;
  const kept = await post(d, cookie, "/flag", { project, enabled: "false", request_key: "k2" });
  expect(kept?.status).toBe(409);
  expect(await kept?.text()).toContain("The flag keeps your domain online.");
  expect(t.flag.enabled).toBe(true);
  expect(
    (await post(d, cookie, "/flag", { project, enabled: "maybe", request_key: "k3" }))?.status,
  ).toBe(400);
});

it("preserves old usage links and returns budget changes to the same project modal", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  const oldLink = await handleBrowserLogin(
    new Request(origin + "/usage?cursor=next-page", { headers: { cookie } }),
    d,
  );
  expect(oldLink?.status).toBe(303);
  expect(oldLink?.headers.get("location")).toBe("/?cursor=next-page");
  for (const path of ["/usage", "/usage.md"]) {
    const markdown = await handleBrowserLogin(
      new Request(origin + path, { headers: { cookie, accept: "text/markdown" } }),
      d,
    );
    expect(markdown?.status).toBe(200);
    expect(await markdown?.text()).toContain("Used: 123.4 credits; limit: none; mode: continue");
  }
  const saved = await post(d, cookie, "/budget", {
    project,
    cursor: "next-page",
    limit: "90.5",
    mode: "stop",
    request_key: "modal-budget",
  });
  expect(saved?.headers.get("location")).toBe("/?cursor=next-page#usage-" + project);
  const returned = await handleBrowserLogin(
    new Request(origin + "/?cursor=next-page", { headers: { cookie } }),
    d,
  );
  const body = (await returned?.text()) ?? "";
  expect(body).toContain('name="cursor" value="next-page"');
  expect(body).toContain('placeholder="No limit" value="90.5"');
  expect(body).toContain('<option value="stop" selected>');
});

it("adds only a coarse browser region to new-project prompts and never infers the agent location", async () => {
  const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  for (const [cf, headers, expected] of [
    [{ country: "DE", continent: "EU" }, navigation, "EU"],
    [{ country: "GB", continent: "EU" }, navigation, "EU"],
    [{ country: "CY", continent: "AS" }, navigation, "EU"],
    [{ country: "US", continent: "NA" }, navigation, "US"],
    [{ country: "JP", continent: "AS" }, navigation, "US"],
    [{ country: "XX", continent: "EU" }, navigation, null],
    [{ country: "T1", continent: "EU" }, navigation, null],
    [{ country: "DE" }, navigation, null],
    [undefined, { ...navigation, "cf-ipcountry": "DE" }, null],
    [{ country: "DE", continent: "EU" }, { "cf-ipcountry": "DE" }, null],
  ] as const) {
    const request = new Request(origin + "/", { headers });
    Object.defineProperty(request, "cf", { value: cf });
    const page = renderPortalPage({ request, origin });
    const html = await page.text();
    expect(html).toContain(
      expected
        ? `For a new project, use ${expected} based on this browser's region unless I specify another region.`
        : "For a new project, ask me once whether to use EU or US unless I already specified a region.",
    );
    expect(html).toContain("Keep existing projects in their current region.");
    expect(page.headers.get("cache-control")).toBe("no-store");
  }
  const request = new Request(origin + "/", { headers: navigation });
  Object.defineProperty(request, "cf", { value: { country: "NL", continent: "EU" } });
  const emptyWorkspace = renderPortalPage({
    request,
    origin,
    signedIn: true,
    profile: new LoginTransport().profile(),
    organizationId: org,
    projects: [],
  });
  expect(await emptyWorkspace.text()).toContain("For a new project, use EU based on this browser");
});

it("names the signed-in user, workspace and project in every copied prompt, in HTML and Markdown alike", async () => {
  const d = config(new LoginTransport());
  const { cookie } = await login(d);
  const promptsIn = (html: string): string[] =>
    [
      ...html.matchAll(/<textarea id="(?:agent-prompt|project-[^"]+)"[^>]*>([^<]*)<\/textarea>/gu),
    ].map(([, text]) =>
      (text ?? "")
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    );
  const account = `Use my ohmyho.st account user user_example in organization "My workspace" (${org}).`;
  const html =
    (await (
      await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d)
    )?.text()) ?? "";
  const markdown =
    (await (
      await handleBrowserLogin(new Request(origin + "/index.md", { headers: { cookie } }), d)
    )?.text()) ?? "";
  const prompts = promptsIn(html);
  // One project prompt and the prompt that deploys another app, both for exactly this account.
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain(account);
    expect(prompt).toContain("These IDs are context, not credentials");
    // A client that predates saved logins ignores profile_name, so the prompt requires this one.
    expect(prompt).toContain(`Choosing the login needs ohmyhost ${PORTAL_CLIENT_RELEASE} or newer`);
    expect(prompt).toContain(`ohmyhost login --organization ${org} --user user_example --json`);
    expect(prompt).toContain("With remote MCP, confirm this account with identity_get");
    expect(prompt).toContain("current workspace membership and role");
    expect(prompt).toContain("With the CLI or local MCP");
    expect(markdown).toContain(prompt);
  }
  expect(prompts[0]).toContain(`read project context for project "Test application" (${project})`);
  expect(prompts[1]).toContain("build and deploy my application");
  expect(prompts[1]).toContain("Keep the project's saved source choice");
  expect(prompts[1]).toContain(
    "offer direct deployment with ohmyho.st versioning or GitHub setup once",
  );
  expect(prompts[1]).toContain(
    "In a new chat without a workspace, start with ohmyho.st versioning",
  );

  const empty = renderPortalPage({
    request: new Request(origin + "/"),
    origin,
    signedIn: true,
    profile: new LoginTransport().profile(),
    organizationId: org,
    projects: [],
  });
  const emptyPrompts = promptsIn(await empty.text());
  expect(emptyPrompts).toHaveLength(1);
  expect(emptyPrompts[0]).toContain(account);
  const emptyMarkdown = await renderPortalPage({
    request: new Request(origin + "/index.md"),
    origin,
    signedIn: true,
    profile: new LoginTransport().profile(),
    organizationId: org,
    projects: [],
  }).text();
  expect(emptyMarkdown).toContain(emptyPrompts[0] ?? "missing");

  // Without a browser account the prompt names no identifier and asks the agent to verify one.
  const anonymous = promptsIn(
    await renderPortalPage({ request: new Request(origin + "/"), origin }).text(),
  );
  expect(anonymous).toHaveLength(1);
  expect(anonymous[0]).toContain(
    "After signing in, use the user and organization that identity_get over remote MCP or whoami over the CLI or local MCP reports; never guess an account, organization or project ID.",
  );
  expect(anonymous[0]).not.toMatch(/user_|01M/u);
  const noOrganization = promptsIn(
    await renderPortalPage({
      request: new Request(origin + "/"),
      origin,
      signedIn: true,
      profile: { ...new LoginTransport().profile(), organizations: [] },
      organizationId: null,
      projects: [],
    }).text(),
  );
  expect(noOrganization).toHaveLength(1);
  expect(noOrganization[0]).toContain("account user user_example; it has no organization yet");
  expect(noOrganization[0]).toContain("With remote MCP, confirm this account with identity_get");
  expect(noOrganization[0]).toContain("use workspace_setup");
  expect(noOrganization[0]).toContain("With the CLI or local MCP");
});

it("hands out an MCP configuration that keeps starting after the next client release", async () => {
  // A saved configuration that runs a versioned archive answers 404 once the next release
  // replaces that archive, so it runs the installed command and the CLI line installs both.
  // The installed command only starts once installed, so every MCP option says so first.
  const release = `https://ohmyho.st/releases/${PORTAL_CLIENT_RELEASE}`;
  const installFirst =
    "Install once with the CLI command, then add this to your agent's MCP configuration.";
  const unescape = (text: string) =>
    text
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  for (const [portal, environment, prefix] of [
    [origin, "production", ""],
    ["https://dev.app.ohmyho.st", "development", "OHMYHOST_ENVIRONMENT=development "],
  ] as const) {
    const pages = [
      renderPortalPage({ request: new Request(portal + "/"), origin: portal }),
      renderPortalPage({
        request: new Request(portal + "/"),
        origin: portal,
        signedIn: true,
        profile: new LoginTransport().profile(),
        organizationId: org,
        projects: [],
      }),
    ];
    const markdown = await renderPortalPage({
      request: new Request(portal + "/index.md"),
      origin: portal,
    }).text();
    const setups = [
      ...(await Promise.all(pages.map((page) => page.text()))).map((html) => ({
        hint: html.match(/<summary>MCP<\/summary>(.*?)<textarea id="mcp-config"/u)?.[1] ?? "",
        mcp: unescape(html.match(/<textarea id="mcp-config"[^>]*>([^<]*)<\/textarea>/u)?.[1] ?? ""),
        cli: unescape(
          html.match(/<textarea id="cli-command"[^>]*>([^<]*)<\/textarea>/u)?.[1] ?? "",
        ),
      })),
      {
        hint: markdown.match(/## MCP\n\n([\s\S]*?)```json/u)?.[1] ?? "",
        mcp: markdown.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "",
        cli: markdown.match(/```sh\n([\s\S]*?)\n```/u)?.[1] ?? "",
      },
    ];
    for (const { hint, mcp, cli } of setups) {
      expect(hint).toContain(installFirst);
      expect(mcp).not.toContain("/releases/");
      expect(JSON.parse(mcp)).toEqual({
        mcpServers: {
          ohmyho: { command: "ohmyhost-mcp", env: { OHMYHOST_ENVIRONMENT: environment } },
        },
      });
      expect(cli).toBe(
        `npm install --global ${release}/ohmyhost-product-cli-${PORTAL_CLIENT_RELEASE}.tgz ${release}/ohmyhost-mcp-${PORTAL_CLIENT_RELEASE}.tgz\n${prefix}ohmyhost login --json`,
      );
    }
  }
});

it("keeps the WorkOS session across pages and creates one initial workspace before handing projects to the agent", async () => {
  const t = new LoginTransport();
  t.hasOrg = false;
  const d = config(t);
  const startPage = await handleBrowserLogin(new Request(origin + "/login"), d);
  const startHtml = await startPage?.text();
  // Signup is open: /login is also the public signup page and must address a visitor without an account.
  expect(startHtml).toContain("Sign in or create your account.");
  expect(startHtml).toContain("Sign in, or create your account if you do not have one yet.");
  expect(startHtml).not.toContain("Welcome back.");
  const { callback, cookie } = await login(d);
  expect(callback?.status).toBe(303);
  expect(callback?.headers.get("location")).toBe("/");
  expect(cookie).not.toContain("test-access-token");
  expect(t.created).toBe(1);
  expect(t.refreshes).toBe(1);
  for (const path of ["/", "/profile", "/billing", "/usage.md", "/index.md", "/profile.md"]) {
    const page = await handleBrowserLogin(new Request(origin + path, { headers: { cookie } }), d);
    expect(page?.status).toBe(200);
    const text = await page?.text();
    expect(text).not.toMatch(/test-access-token|test-refresh-token|Using Windows|curl -fsSL/u);
    if (path === "/") {
      expect(text).toContain("Test application");
      expect(text).toContain("Account menu");
      expect(page?.headers.get("content-security-policy")).toContain(
        "https://dev-test-otter-builds.check.omh.st",
      );
      expect(text).not.toContain('class="portal-art"');
      expect(text).toContain(project);
      expect(text).toContain("user_example");
    }
    if (path === "/billing") {
      expect(text).toContain("Top-ups and other credits");
      expect(text).toContain("Granted");
      expect(text).not.toContain(">Reserved<");
      expect(text).not.toContain("Manage in Stripe");
    }
    if (path === "/profile") expect(text).toContain("hostmebaby");
  }
  // A time-bounded grant, like a flag referral month, names its end.
  t.paidUntil = "2026-10-25T10:00:00.000Z";
  const bounded = await handleBrowserLogin(
    new Request(origin + "/billing", { headers: { cookie } }),
    d,
  );
  expect(await bounded?.text()).toContain("Paid features are granted until Oct 25, 2026.");
  t.portalAvailable = true;
  const billingWithCustomer = await handleBrowserLogin(
    new Request(origin + "/billing", { headers: { cookie } }),
    d,
  );
  expect(billingWithCustomer?.status).toBe(200);
  expect(await billingWithCustomer?.text()).toContain("Manage in Stripe");
  // Without Paid, a kept recharge consent refills nothing, so the card must not say "On".
  t.plan = "free";
  t.rechargeEnabled = true;
  const pausedRecharge = await (
    await handleBrowserLogin(new Request(origin + "/billing", { headers: { cookie } }), d)
  )?.text();
  expect(pausedRecharge).toContain('Auto-recharge <span class="account-badge">Paused</span>');
  expect(pausedRecharge).toContain("Refills resume only with active Paid access.");
  t.plan = "paid";
  t.rechargeEnabled = false;
  await login(d, "r=other");
  expect(t.created).toBe(1);
  expect(t.source).toBe("hostmebaby");
  const open = new LoginTransport();
  open.hasOrg = false;
  const openConfig = config(open);
  const openLogin = await login(openConfig, "r=summer-campaign");
  expect(openLogin.callback?.status).toBe(303);
  expect(open.created).toBe(1);
  expect(open.source).toBe("summer-campaign");
  expect(open.calls.some((call) => new URL(call.url).pathname.startsWith("/v1/site/"))).toBe(false);
  // An r value outside the attribution pattern is no link: the visitor signs up like a direct
  // one, and nothing is frozen that a later workspace creation would refuse.
  for (const r of ["Launch.HN", "ProductHunt", "%01", "", "a".repeat(65)]) {
    const loginPage = await handleBrowserLogin(new Request(origin + "/login?r=" + r), d);
    expect({ r, status: loginPage?.status }).toEqual({ r, status: 200 });
    expect(await loginPage?.text()).toContain('<form action="/login/start" method="post">');
  }
  const [loose, direct] = [new LoginTransport(), new LoginTransport()];
  loose.hasOrg = direct.hasOrg = false;
  const looseConfig = config(loose);
  const looseLogin = await login(looseConfig, "r=Launch.HN");
  await login(config(direct), "");
  expect(looseLogin.callback?.status).toBe(303);
  expect(loose.calls.some((call) => new URL(call.url).pathname === "/v1/me/signup-source")).toBe(
    true,
  );
  expect(loose.source).toBeNull();
  const paths = (transport: LoginTransport) =>
    transport.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
  expect(paths(loose)).toEqual(paths(direct));
  expect(loose.created).toBe(direct.created);
  expect(direct.created).toBe(1);
  expect(
    (
      await handleBrowserLogin(
        new Request(origin + "/", { headers: { cookie: looseLogin.cookie } }),
        looseConfig,
      )
    )?.status,
  ).toBe(200);
  expect(
    (await handleBrowserLogin(new Request(origin + "/login", { headers: { cookie } }), d))?.status,
  ).toBe(303);
  expect(
    await (
      await handleBrowserLogin(
        new Request(origin + "/", { method: "HEAD", headers: { cookie } }),
        d,
      )
    )?.text(),
  ).toBe("");
});
it("keeps dynamic campaign parameters through account creation without letting tracking block login", async () => {
  const t = new LoginTransport();
  t.hasOrg = false;
  const d = config(t);
  const unattributed = new LoginTransport();
  const prior = config(unattributed);
  await login(prior, "");
  expect(unattributed.utm).toBeUndefined();
  await login(prior, "utm_=invalid&utm_oversize=" + "x".repeat(10000));
  expect(unattributed.utm).toBeUndefined();
  await login(prior, "utm_source=first-explicit-campaign");
  expect(unattributed.utm).toEqual({ utm_source: "first-explicit-campaign" });
  const parameters = new URLSearchParams({
    utm_source: "chatgpt.com",
    utm_campaign: "Launch / München 🚀",
    utm_new_partner: "unregistered-campaign",
  });
  parameters.append("utm_source", "external.example");
  const page = await handleBrowserLogin(new Request(origin + "/login?" + parameters), d);
  expect(page?.status).toBe(200);
  expect(t.calls).toEqual([]);
  const html = await page?.text();
  const action = html
    ?.match(/<form action="([^"]+)" method="post">/u)?.[1]
    ?.replaceAll("&amp;", "&");
  expect(action).toBeDefined();
  const query = new URL(action ?? "", origin).search;
  const result = await login(d, query.slice(1));
  expect(result.callback?.status).toBe(303);
  expect(t.created).toBe(1);
  expect(t.source).toBeNull();
  expect(t.utm).toEqual({
    utm_source: "external.example",
    utm_campaign: "Launch / München 🚀",
    utm_new_partner: "unregistered-campaign",
  });
  expect(result.pending.length).toBeLessThan(4096);
  const excessive = new URLSearchParams({
    utm_source: "chatgpt.com",
    utm_oversize: "x".repeat(10000),
  });
  for (let index = 0; index < 30; index++) excessive.set(`utm_extra_${index}`, "🚀".repeat(200));
  excessive.set("utm_", "invalid key");
  const bounded = new LoginTransport();
  bounded.hasOrg = false;
  const boundedLogin = await login(config(bounded), excessive.toString());
  expect(boundedLogin.callback?.status).toBe(303);
  expect(bounded.created).toBe(1);
  expect(bounded.utm?.["utm_source"]).toBe("chatgpt.com");
  expect(bounded.utm).not.toHaveProperty("utm_oversize");
  expect(bounded.utm).not.toHaveProperty("utm_");
  expect(new TextEncoder().encode(JSON.stringify(bounded.utm)).length).toBeLessThanOrEqual(1024);
});
it("says which part of a refused submission was wrong", async () => {
  const t = new LoginTransport();
  const d = config(t);
  const { cookie } = await login(d);
  const send = async (headers: Record<string, string>) =>
    (
      await handleBrowserLogin(
        new Request(origin + "/tokens", { method: "POST", headers: { cookie, ...headers } }),
        d,
      )
    )?.text();

  // One message for two unrelated causes tells the reader nothing about either.
  const foreignOrigin = await send({
    origin: "https://foreign.example",
    "content-type": "application/x-www-form-urlencoded",
  });
  const wrongType = await send({ origin, "content-type": "application/json" });
  expect(foreignOrigin).toMatch(/browser did not send this form from the portal/iu);
  expect(wrongType).toMatch(/must be submitted as a portal form/iu);
  expect(foreignOrigin).not.toEqual(wrongType);
});

it("rejects forged, expired, cross-origin and invalid sessions and preserves access during transient upstream failure", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const canonicalEntry = await handleBrowserLogin(new Request(origin + "/login"), d);
  expect(canonicalEntry?.status).toBe(200);
  expect(await canonicalEntry?.text()).toContain('<form action="/login/start" method="post">');
  const directStart = await handleBrowserLogin(new Request(origin + "/login/start"), d);
  expect(directStart?.status).toBe(405);
  expect(await directStart?.text()).toContain("Start from the login page.");
  expect(t.calls).toHaveLength(0);
  const { cookie, pending, target } = await login(d);
  expect(
    (
      await handleBrowserLogin(
        new Request(origin + "/login/start", {
          method: "POST",
          headers: { origin: "https://foreign.example" },
        }),
        d,
      )
    )?.status,
  ).toBe(403);
  // The pending cookie is readable and writable by its browser, so the callback checks the
  // attribution it carries against the same pattern as the r parameter.
  const forged = JSON.parse(
    Buffer.from(pending.slice("__Host-omh-login=".length), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const forgedPending =
    "__Host-omh-login=" +
    Buffer.from(JSON.stringify({ ...forged, source: "Launch.HN" })).toString("base64url");
  expect(
    (
      await handleBrowserLogin(
        new Request(origin + "/login/callback?code=x&state=" + target.searchParams.get("state"), {
          headers: { cookie: forgedPending },
        }),
        d,
      )
    )?.status,
  ).toBe(400);
  for (const query of [
    "code=x&state=foreign",
    `code=x&state=${target.searchParams.get("state")}&state=duplicate`,
  ])
    expect(
      (
        await handleBrowserLogin(
          new Request(origin + "/login/callback?" + query, { headers: { cookie: pending } }),
          d,
        )
      )?.status,
    ).toBe(400);
  expect(
    await openBrowserSession(cookie + "tamper", password, origin, d.now().getTime()),
  ).toBeNull();
  expect(
    await openBrowserSession(cookie, password, "https://dev.app.ohmyho.st", d.now().getTime()),
  ).toBeNull();
  expect(
    await openBrowserSession(cookie, password, origin, d.now().getTime() + 604800000),
  ).toBeNull();
  expect(
    (
      await handleBrowserLogin(
        new Request(origin + "/budget", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
          body: "csrf=wrong&project=" + project,
        }),
        d,
      )
    )?.status,
  ).toBe(403);
  expect(
    (await post(d, cookie, "/workspace", { organization: "01M21T9VB6J0P0QWQJ4J3086ZK" }))?.status,
  ).toBe(403);
  t.profileFailure = 503;
  const temporary = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(temporary?.status).toBe(503);
  expect(temporary?.headers.getSetCookie()).toEqual([]);
  t.profileFailure = 401;
  const renewed = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(renewed?.status).toBe(200);
  expect(renewed?.headers.getSetCookie().some((x) => x.startsWith("__Host-omh-session="))).toBe(
    true,
  );
  t.profileFailure = 401;
  t.tokenStatus = 401;
  const expired = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(expired?.status).toBe(303);
  expect(expired?.headers.get("location")).toBe("/login");
  expect((await handleBrowserLogin(new Request(origin + "/login?r=x&r=y"), d))?.status).toBe(400);
});
it("uses the SDK for budget changes, private Dev links, Stripe handoffs and session revocation", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  t.multipleOrgs = true;
  const before = t.calls.length;
  const overview = await handleBrowserLogin(
    new Request(origin + "/", { headers: { cookie, "cf-connecting-ip": "203.0.113.7" } }),
    d,
  );
  expect(await overview?.text()).toContain(">Team</option>");
  // The portal's own API calls count against the visitor's address, not one bucket shared by
  // every portal visitor.
  const apiCalls = t.calls.slice(before).filter((call) => new URL(call.url).origin === origin);
  expect(apiCalls.length).toBeGreaterThan(3);
  expect(apiCalls.map((call) => call.headers.get("cf-connecting-ip"))).toEqual(
    apiCalls.map(() => "203.0.113.7"),
  );
  const budget = await post(d, cookie, "/budget", {
    project,
    limit: "75.5",
    mode: "stop",
    request_key: "budget-request",
  });
  expect(budget?.status).toBe(303);
  expect(budget?.headers.get("location")).toBe("/#usage-" + project);
  expect(t.budget.amount_micros).toBe("75500000");
  expect(t.budget.mode).toBe("stop");
  await post(d, cookie, "/budget", {
    project,
    limit: "",
    mode: "stop",
    request_key: "clear-budget",
  });
  expect(t.budget.amount_micros).toBeNull();
  expect(t.budget.mode).toBe("continue");
  expect(
    (await post(d, cookie, "/budget", { project, limit: "-5", mode: "stop", request_key: "bad" }))
      ?.status,
  ).toBe(400);
  const dev = await post(d, cookie, "/dev-access", { project });
  expect(dev?.headers.get("location")).toContain(
    "https://dev-test-otter-builds.check.omh.st/.ohmyhost/access",
  );
  const ticketRequests = t.calls.filter((call) =>
    new URL(call.url).pathname.endsWith("/dev-access-tickets"),
  ).length;
  t.devAccessMode = "public";
  const publicDev = await post(d, cookie, "/dev-access", { project });
  expect(publicDev?.headers.get("location")).toBe("https://dev-test-otter-builds.check.omh.st/");
  expect(
    t.calls.filter((call) => new URL(call.url).pathname.endsWith("/dev-access-tickets")),
  ).toHaveLength(ticketRequests);
  expect(
    (
      await post(d, cookie, "/billing/recharge", {
        enabled: "true",
        monthly_limit_minor: "10000",
        revision: "0",
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await post(d, cookie, "/billing/recharge", {
        enabled: "true",
        monthly_limit_minor: "10000",
        revision: "0",
        consent: "off_session_v1",
      })
    )?.headers.get("location"),
  ).toBe("/billing");
  const rechargeRequest = t.calls
    .filter((r) => r.url.endsWith("/billing/recharge") && r.method === "PUT")
    .at(-1);
  expect(await rechargeRequest?.clone().json()).toMatchObject({
    enabled: true,
    monthly_limit_minor: 10000,
    consent: "off_session_v1",
    revision: 0,
  });
  const billing = await post(d, cookie, "/billing/stripe", {});
  expect(billing?.status).toBe(303);
  expect(billing?.headers.get("location")).toBe(t.portalUrl);
  t.portalUrl = "https://foreign.example/p/session/x";
  expect((await post(d, cookie, "/billing/stripe", {}))?.status).toBe(503);
  expect((await post({ ...d, billingEnabled: false }, cookie, "/billing/stripe", {}))?.status).toBe(
    409,
  );
  const logout = await post(d, cookie, "/logout", {});
  expect(logout?.headers.getSetCookie()).toContain(
    "__Host-omh-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  expect(t.calls.some((r) => r.url.endsWith("/v1/session:revoke"))).toBe(true);
  const session = await openBrowserSession(cookie, password, origin, d.now().getTime());
  expect(session).not.toBeNull();
  if (!session) throw Error("Missing test session");
  await expect(
    closeBrowserSession({ ...session, accessToken: "x".repeat(7000) }, password),
  ).rejects.toThrow("capacity");
});

it("manages own permanent API tokens through the authenticated SDK and reveals the secret only on first creation", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const { cookie, callback } = await login(d, "view=tokens&r=hostmebaby");
  expect(callback?.headers.get("location")).toBe("/tokens");
  const read = (path = "/tokens") =>
    handleBrowserLogin(new Request(origin + path, { headers: { cookie } }), d);
  const initial = await read();
  expect(initial?.status).toBe(200);
  expect(await initial?.text()).toContain("API Tokens");
  const fields = { name: "My automation", request_key: "portal-create-1", organization: org };
  expect((await post(d, cookie, "/tokens", { ...fields, csrf: "forged" }))?.status).toBe(403);
  expect(t.keyRequests.size).toBe(0);
  expect(
    (await post(d, cookie, "/tokens", { ...fields, organization: "01M21T9VB6J0P0QWQJ4J3086ZM" }))
      ?.status,
  ).toBe(409);
  const session = await openBrowserSession(cookie, password, origin, d.now().getTime());
  const markdownCreate = await handleBrowserLogin(
    new Request(origin + "/tokens", {
      method: "POST",
      headers: {
        origin,
        cookie,
        accept: "text/markdown",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ...fields, csrf: session?.csrf ?? "" }),
    }),
    d,
  );
  expect(markdownCreate?.status).toBe(406);
  expect(t.keyRequests.size).toBe(0);
  const created = await post(d, cookie, "/tokens", fields);
  expect(created?.status).toBe(200);
  expect(created?.headers.get("cache-control")).toBe("no-store");
  expect(created?.headers.get("referrer-policy")).toBe("same-origin");
  const body = await created?.text();
  expect(body).toContain(t.keyValue);
  expect(body).toContain('class="fbrandrow"');
  expect(body).toContain('id="created-token"');
  expect(body).toContain("Never expires");
  expect(body).not.toMatch(/test-access-token|test-refresh-token/u);
  const repeated = await post(d, cookie, "/tokens", fields);
  expect(await repeated?.text()).not.toContain(t.keyValue);
  expect(t.userKeys).toHaveLength(1);
  for (const path of ["/tokens", "/tokens.md"]) {
    const page = await read(path),
      text = await page?.text();
    expect(text).toContain("My automation");
    expect(text).not.toContain(t.keyValue);
  }
  expect(
    (await post(d, cookie, "/tokens/revoke", { key_id: "api_key_foreign", organization: org }))
      ?.status,
  ).toBe(404);
  expect(t.userKeys).toHaveLength(1);
  expect(
    (
      await post(d, cookie, "/tokens/revoke", { key_id: "api_key_owned", organization: org })
    )?.headers.get("location"),
  ).toBe("/tokens");
  expect(t.userKeys).toHaveLength(0);
  t.loseNextKeyResponse = true;
  const uncertain = await post(d, cookie, "/tokens", {
    ...fields,
    request_key: "original-uncertain-request",
  });
  expect(uncertain?.status).toBe(503);
  const retryHtml = await uncertain?.text();
  expect(retryHtml).toContain('value="My automation"');
  const retryKey = retryHtml?.match(/name="request_key" value="([^"]+)"/u)?.[1];
  expect(retryKey).toBe("original-uncertain-request");
  const observed = await post(d, cookie, "/tokens", { ...fields, request_key: retryKey ?? "" });
  const observedBody = await observed?.text();
  expect(observedBody).toContain("Token already created");
  expect(observedBody).toContain('class="fbrandrow"');
  expect(t.userKeys).toHaveLength(1);
  expect(t.keyRequests.size).toBe(2);
  const anonymous = await handleBrowserLogin(new Request(origin + "/tokens"), d);
  expect(await anonymous?.text()).toContain("Sign in or create your account.");
});

it("returns a workspace switch made from a signed-in MCP link to that same link, and nowhere else", async () => {
  const t = new LoginTransport(),
    d = config(t),
    other = "01M21T9VB6J0P0QWQJ4J3086ZM",
    link = "/mcp/secrets?request=" + "a".repeat(43);
  const { cookie } = await login(d);
  t.multipleOrgs = true;
  // The login itself refreshes once for the selected workspace; a switch adds exactly one refresh.
  const signedIn = t.refreshes;
  const switched = await post(d, cookie, "/workspace", { organization: other, return: link });
  expect(switched?.status).toBe(303);
  expect(switched?.headers.get("location")).toBe(link);
  expect(t.refreshes).toBe(signedIn + 1);
  for (const invalid of [
    "https://evil.example/mcp/secrets?request=" + "a".repeat(43),
    "//evil.example/mcp/secrets?request=" + "a".repeat(43),
    "/usage?request=" + "a".repeat(43),
    "/mcp/secrets?request=" + "a".repeat(43) + "&redirectUrl=https://evil.example/",
  ]) {
    const refused = await post(d, cookie, "/workspace", { organization: other, return: invalid });
    expect(refused?.status, invalid).toBe(400);
  }
  expect(t.refreshes).toBe(signedIn + 1);
  expect(
    (await post(d, cookie, "/workspace", { organization: other }))?.headers.get("location"),
  ).toBe("/");
});

it("sends the same Strict-Transport-Security value on the portal pages as on the API", async () => {
  const origin = "https://app.ohmyho.st";
  const page = renderPortalPage({ request: new Request(origin + "/"), origin });
  expect(page.headers.get("strict-transport-security")).toBe(
    "max-age=63072000; includeSubDomains; preload",
  );
});

it("signs in a verified user whose first workspace creation is refused, and keeps a server failure retryable", async () => {
  // A deleted first workspace or a removed membership makes the replayed creation answer 403 on every
  // retry. The sign-in must still open a session; only an unknown failure keeps the retryable page.
  const t = new LoginTransport();
  t.hasOrg = false;
  t.createStatus = 403;
  const d = config(t);
  const refused = await login(d);
  expect(refused.callback?.status).toBe(303);
  expect(refused.callback?.headers.get("location")).toBe("/");
  expect(refused.cookie).toMatch(/^__Host-omh-session=/u);

  t.createStatus = 500;
  const failed = await login(d);
  expect(failed.callback?.status).toBe(503);
  expect(failed.cookie).toBe("");
});

it("gives a changed token name a fresh request key after the same key answered a different name", async () => {
  // The uncertain first answer keeps the form's key. Changing the name and resubmitting that key is
  // refused with 409 every time, so the form must not offer the old key again for the new name.
  const t = new LoginTransport();
  const d = config(t);
  const { cookie } = await login(d);
  const requestKey = "token-request-1";
  t.loseNextKeyResponse = true;
  const first = await post(d, cookie, "/tokens", {
    organization: org,
    name: "Automation A",
    request_key: requestKey,
  });
  expect(first?.status).toBe(503);
  const second = await post(d, cookie, "/tokens", {
    organization: org,
    name: "Automation B",
    request_key: requestKey,
  });
  const html = (await second?.text()) ?? "";
  expect(second?.status).toBe(409);
  expect(html).toMatch(/already used for another token name/u);
  expect(html).toContain('name="name" value="Automation B"');
  expect(html).not.toContain(`name="request_key" value="${requestKey}"`);
});

it("keeps the signed-in shell and the refusal text when a signed-in form is refused", async () => {
  // A signed-in customer who mistypes a budget keeps the account navigation and the reason, not the
  // anonymous sign-in layout with a Log in link.
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  const response = await post(d, cookie, "/budget", {
    project,
    limit: "abc",
    mode: "stop",
    request_key: "budget-invalid-limit",
  });
  const html = (await response?.text()) ?? "";
  expect(response?.status).toBe(400);
  expect(html).toContain("account-nav");
  expect(html).toContain("Check the limit.");
  expect(html).not.toContain(">Log in<");
  expect(t.budget.amount_micros).toBeNull();
});

it("refuses a monthly limit the budget API cannot store, and says so instead of a retryable failure", async () => {
  // 10,000,000,000 credits is 1e16 micros, above the largest integer the API stores. The portal must
  // answer with the limit message before it calls the API; a 400 from the API gets the same answer.
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  const tooLarge = await post(d, cookie, "/budget", {
    project,
    limit: "10000000000",
    mode: "stop",
    request_key: "budget-too-large",
  });
  expect(tooLarge?.status).toBe(400);
  expect(await tooLarge?.text()).toContain("Check the limit.");
  expect(t.budget.amount_micros).toBeNull();
  t.budgetStatus = 400;
  const refused = await post(d, cookie, "/budget", {
    project,
    limit: "10",
    mode: "stop",
    request_key: "budget-refused",
  });
  expect(refused?.status).toBe(400);
  expect(await refused?.text()).toContain("Check the limit.");
});

it("answers a refused Dev access or flag change with its own page, not the temporary failure page", async () => {
  const t = new LoginTransport(),
    d = config(t);
  const { cookie } = await login(d);
  t.devAccessStatus = 400;
  const dev = await post(d, cookie, "/dev-access", { project });
  expect(dev?.status).toBe(400);
  expect(await dev?.text()).toContain("Dev access is not ready.");
  t.flagStatus = 404;
  const flag = await post(d, cookie, "/flag", {
    project,
    enabled: "true",
    request_key: "flag-refused",
  });
  const flagHtml = (await flag?.text()) ?? "";
  expect(flag?.status).toBe(404);
  expect(flagHtml).toContain("Reload this page and try again.");
  expect(flagHtml).not.toContain("Please retry the same request");
});

it("adopts a workspace created after a session was signed in without one", async () => {
  // A verified user signed in while no workspace existed holds a session with no workspace. A workspace created
  // later must be adopted on the next page, not hidden behind a prompt that only a new sign-in clears.
  const t = new LoginTransport(),
    d = config(t);
  const cookie =
    (
      await closeBrowserSession(
        {
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          csrf: "A".repeat(43),
          createdAt: d.now().getTime(),
          origin,
          organizationId: null,
        },
        password,
      )
    ).split(";", 1)[0] ?? "";
  const page = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(page?.status).toBe(200);
  expect(await page?.text()).toContain("Test application");
  expect(
    page?.headers.getSetCookie().some((value) => value.startsWith("__Host-omh-session=")),
  ).toBe(true);
});

it("adopts the initial workspace, else the oldest, whatever order the profile lists the workspaces in", async () => {
  // Workspace ids are ULIDs: the larger id is the later workspace. The listing order is not a rule to rely on.
  const t = new LoginTransport(),
    d = config(t);
  const newer = { id: "01M21T9VB6J0P0QWQJ4J3086ZM", name: "Team", workos_id: "org_team" },
    older = { id: org, name: "My workspace", workos_id: "org_example" };
  t.listedOrganizations = [newer, older];
  t.initialWorkspaceId = null;
  const cookie =
    (
      await closeBrowserSession(
        {
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          csrf: "A".repeat(43),
          createdAt: d.now().getTime(),
          origin,
          organizationId: null,
        },
        password,
      )
    ).split(";", 1)[0] ?? "";
  const sealedSession = async (response: Response | null) =>
    openBrowserSession(
      response?.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-omh-session="))
        ?.split(";", 1)[0] ?? null,
      password,
      origin,
      d.now().getTime(),
    );
  const oldest = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(await sealedSession(oldest)).toMatchObject({ organizationId: older.id });
  expect(t.refreshedOrganizations).toEqual([older.workos_id]);
  t.initialWorkspaceId = newer.id;
  const initial = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(await sealedSession(initial)).toMatchObject({ organizationId: newer.id });
  expect(t.refreshedOrganizations.at(-1)).toBe(newer.workos_id);
});

it("keeps a signed-in session without a workspace when adopting the first workspace fails", async () => {
  // A failed adoption neither clears the sign-in nor redirects back to /login, which would adopt again. Tokens that
  // were rotated before the workspace could be confirmed are kept, without a workspace.
  const t = new LoginTransport(),
    d = config(t);
  const cookie =
    (
      await closeBrowserSession(
        {
          accessToken: "test-access-token",
          refreshToken: "old-refresh-token",
          csrf: "A".repeat(43),
          createdAt: d.now().getTime(),
          origin,
          organizationId: null,
        },
        password,
      )
    ).split(";", 1)[0] ?? "";
  t.tokenStatus = 401;
  const refused = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  expect(refused?.status).toBe(200);
  expect(refused?.headers.get("location")).toBeNull();
  expect(refused?.headers.getSetCookie()).toEqual([]);
  expect(await refused?.text()).toContain("Your next app starts here.");
  t.tokenStatus = 200;
  t.identityStatus = 503;
  const unconfirmed = await handleBrowserLogin(
    new Request(origin + "/", { headers: { cookie } }),
    d,
  );
  expect(unconfirmed?.status).toBe(200);
  expect(unconfirmed?.headers.get("location")).toBeNull();
  expect(
    await openBrowserSession(
      unconfirmed?.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-omh-session="))
        ?.split(";", 1)[0] ?? null,
      password,
      origin,
      d.now().getTime(),
    ),
  ).toMatchObject({ organizationId: null, refreshToken: "test-refresh-token" });
});

it("tells an agent with no organization to call identity_get again, never to request project access", () => {
  const prompt = portalPrompt("", false, null, {
    userId: "user_fixture",
    organizationId: null,
  } as unknown as Parameters<typeof portalPrompt>[3]);
  expect(prompt).toContain("identity_get");
  expect(prompt).not.toContain("connection_request");
  expect(prompt).not.toContain("requesting project access");
});

it("records login outcomes without exposing OAuth secrets or changing signup", async () => {
  const events: Array<{ name: string; flowId: string | null }> = [];
  const d = {
    ...config(new LoginTransport()),
    reportGrowth: (event: { name: string; flowId: string | null }) => events.push(event),
  };
  const result = await login(d);
  expect(result.callback?.status).toBe(303);
  expect(events.map((event) => event.name)).toEqual([
    "login_started",
    "callback_received",
    "portal_login_succeeded",
  ]);
  expect(events[0]?.flowId).toBeTruthy();
  expect(events.every((event) => event.flowId === events[0]?.flowId)).toBe(true);
  expect(JSON.stringify(events)).not.toContain(result.target.searchParams.get("state"));
});

it("keeps login successful and records a gap when collection rejects", async () => {
  const tasks: Promise<unknown>[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const records: string[] = [];
  try {
    const report = createGrowthReporter(
      {
        collect: async () => {
          throw new Error("offline");
        },
      },
      { waitUntil: (task) => tasks.push(task) },
      "development",
      {
        record: async ({ outcome }) => {
          records.push(outcome);
        },
      },
    );
    const d = {
      ...config(new LoginTransport()),
      reportGrowth: (hint: Parameters<typeof reportBrowserGrowth>[1]) =>
        reportBrowserGrowth(report, hint),
    };
    const result = await login(d);
    await Promise.all(tasks);
    expect(result.callback?.status).toBe(303);
    expect(warning).toHaveBeenCalledWith("growth measurement gap: collection unavailable");
    expect(records.filter((record) => record === "offered")).toHaveLength(3);
    expect(records.filter((record) => record === "gap")).toHaveLength(3);
    const accepted: string[] = [];
    const limited = createGrowthReporter(
      {
        collect: async (event) => {
          accepted.push(event.event_name);
          return { accepted: true };
        },
      },
      { waitUntil: (task) => tasks.push(task) },
      "development",
      {
        record: async ({ outcome }) => {
          records.push(outcome);
        },
      },
    );
    for (let index = 0; index < 61; index++)
      limited({ event_name: "login_failed", outcome: "failed", transport: "portal" });
    limited({
      event_name: "product_call_succeeded",
      outcome: "succeeded",
      transport: "remote_mcp",
    });
    await Promise.all(tasks);
    expect(accepted.filter((name) => name === "login_failed")).toHaveLength(60);
    expect(accepted).toContain("product_call_succeeded");
    expect(records.filter((record) => record === "gap")).toHaveLength(4);
  } finally {
    warning.mockRestore();
  }
});

it("shows token copy success only after the clipboard accepts it and offers selection on failure", async () => {
  let click: () => Promise<void> = async () => {};
  let resolveWrite: () => void = () => {};
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
  );
  const field = { value: "example-only", focus: vi.fn(), select: vi.fn() };
  const label = { textContent: "Copy to clipboard" };
  const classes = new Set<string>();
  const button = {
    dataset: { copyTarget: "created-token" },
    querySelector: () => label,
    addEventListener: (_event: string, handler: () => Promise<void>) => {
      click = handler;
    },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
  };
  const timers: Array<() => void> = [];
  runInNewContext(PORTAL_SCRIPT, {
    location: { pathname: "/tokens", hash: "" },
    document: {
      querySelectorAll: (selector: string) => (selector === "[data-copy-target]" ? [button] : []),
      getElementById: (id: string) => (id === "created-token" ? field : null),
    },
    navigator: { clipboard: { writeText: write } },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    HTMLDialogElement: Date,
  });
  const pending = click();
  expect(label.textContent).toBe("Copy to clipboard");
  expect(classes.has("is-copied")).toBe(false);
  resolveWrite();
  await pending;
  expect(write).toHaveBeenCalledWith("example-only");
  expect(label.textContent).toBe("✓ Copied");
  expect(classes.has("is-copied")).toBe(true);
  const staleTimer = timers[0];
  const older = click();
  const resolveOlder = resolveWrite;
  expect(label.textContent).toBe("Copy to clipboard");
  const newer = click();
  const resolveNewer = resolveWrite;
  resolveOlder();
  await older;
  staleTimer?.();
  expect(label.textContent).toBe("Copy to clipboard");
  expect(classes.has("is-copied")).toBe(false);
  resolveNewer();
  await newer;
  expect(label.textContent).toBe("✓ Copied");
  timers.at(-1)?.();
  expect(label.textContent).toBe("Copy to clipboard");
  expect(classes.has("is-copied")).toBe(false);
  write.mockImplementationOnce(() => Promise.reject(new Error("denied")));
  await click();
  expect(label.textContent).toBe("Select and copy");
  expect(classes.has("is-copied")).toBe(false);
  expect(field.focus).toHaveBeenCalled();
  expect(field.select).toHaveBeenCalled();
});

it("keeps mail and connection management out of the signed-in portal", async () => {
  const t = new LoginTransport();
  const d = config(t);
  const { cookie } = await login(d);
  const projects = await handleBrowserLogin(new Request(origin + "/", { headers: { cookie } }), d);
  const html = await projects?.text();
  expect(html).toContain(">Projects</a>");
  expect(html).not.toContain('href="/mail"');
  expect(html).not.toContain('href="/connections"');
  for (const path of ["/mail", "/connections"]) {
    const request = new Request(origin + path, { headers: { cookie } });
    expect(await handleBrowserLogin(request, d)).toBeNull();
  }
  for (const path of ["/mail/binding", "/connections/begin", "/connections/import"]) {
    expect(await post(d, cookie, path, { organization: org })).toBeNull();
  }
});
