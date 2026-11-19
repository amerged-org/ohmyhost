import {
  createClient,
  getCurrentIdentity,
  getAccountProfile,
  recordSignupSource,
  createOrganization,
  createBillingPortal,
  getBillingRecharge,
  configureBillingRecharge,
  getOrganizationAccount,
  listProjects,
  getProjectStatus,
  getProjectCreditBudget,
  setProjectCreditBudget,
  getProjectPoweredByFlag,
  setProjectPoweredByFlag,
  getOrganizationReferral,
  createProjectDevAccessTicket,
  revokeCurrentSession,
  createUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  type AccountProfile,
  type OrganizationAccount,
  type Project,
  type ProjectStatus,
  type ProjectCreditBudget,
  type PoweredByFlag,
} from "@ohmyhost/sdk-ts";
import {
  renderPortalPage,
  STRICT_TRANSPORT_SECURITY,
  PORTAL_PATHS,
  GITHUB_AUTHORIZED_PATH,
  GITHUB_AUTHORIZATION_PENDING_PATH,
  GITHUB_AUTHORIZATION_FAILED_PATH,
  type PortalView,
  type PortalPage,
} from "./portal-page.js";

const GITHUB_RESULT_PATHS: readonly string[] = [
  GITHUB_AUTHORIZED_PATH,
  GITHUB_AUTHORIZATION_PENDING_PATH,
  GITHUB_AUTHORIZATION_FAILED_PATH,
];

/** Why the callback refused, in the customer's terms and with the one step that resolves it. */
const GITHUB_FAILURES: Readonly<Record<string, { title: string; message: string }>> = {
  installation_access_required: {
    title: "Choose the GitHub account that owns this installation.",
    message:
      "Go back to your agent and start github connect again with a new idempotency key, then choose the account that owns this installation.",
  },
  account_admin_required: {
    title: "Connect with a GitHub account owner or organization administrator.",
    message:
      "Go back to your agent and start github connect again using the owner of the GitHub account or an organization administrator.",
  },
  // Also the answer for a browser that is not signed in as the person who started the request: it cannot tell
  // an unknown link from someone else's, and nothing is consumed.
  state_unknown: {
    title: "This link does not belong to an active request.",
    message:
      "Sign in to ohmyho.st as the person who started it, then open the same authorization link again. If the link is old, go back to your agent and start github connect again with a new idempotency key.",
  },
  repository_not_installed: {
    title: "The app cannot see this repository yet.",
    message:
      "Install the ohmyho.st app for this repository on GitHub, then open the same authorization link again. Go back to your agent when it is done.",
  },
  repository_access_required: {
    title: "Your GitHub account cannot read this repository.",
    message:
      "Get read access to it on GitHub, then open the same authorization link again. Go back to your agent when it is done.",
  },
  authorization_code_rejected: {
    title: "GitHub did not accept this confirmation.",
    message:
      "Open the same authorization link again to confirm once more, then go back to your agent.",
  },
  expired: {
    title: "This authorization has expired.",
    message: "Go back to your agent and ask for a fresh authorization link.",
  },
  session_inactive: {
    title: "Your ohmyho.st session ended.",
    message: "Sign in again in your agent, then ask it for a fresh authorization link.",
  },
  denied: {
    title: "You declined this authorization.",
    message: "Nothing was changed. Go back to your agent if you want to try again.",
  },
  code_spent: {
    title: "This authorization was already used.",
    message: "Go back to your agent and ask for a fresh authorization link.",
  },
  provider_unavailable: {
    title: "GitHub could not confirm this authorization.",
    message:
      "Open the same authorization link again in a moment, then go back to your agent. The link stays valid.",
  },
};

function githubResultPage(url: URL, page: (options: Partial<PortalPage>) => Response): Response {
  if (url.pathname === GITHUB_AUTHORIZED_PATH)
    return page({
      notice: true,
      title: "GitHub is connected.",
      message: "Go back to your agent and confirm the verification there.",
    });
  if (url.pathname === GITHUB_AUTHORIZATION_PENDING_PATH)
    return page({
      notice: true,
      title: "Still confirming.",
      message: "Go back to your agent and confirm the verification there.",
    });
  const failure = GITHUB_FAILURES[url.searchParams.get("reason") ?? ""] ?? {
    title: "This authorization is no longer valid.",
    message: "Go back to your agent and ask for a fresh authorization link.",
  };
  return page({ notice: true, ...failure });
}
import {
  openBrowserSession,
  closeBrowserSession,
  CLEAR_PORTAL_SESSION,
  exchangeWorkosToken,
  randomToken,
  type BrowserSession,
} from "./browser-session.js";
import { readBoundedText } from "./workos-session-status.js";
import { signupUtm } from "./signup-utm.js";
import { CLEAR_PORTAL_RESUME, PORTAL_RESUME_ID, readPortalResume } from "./portal-login-resume.js";
interface BrowserLoginDependencies {
  origin: string;
  billingEnabled: boolean;
  clientId: string;
  sessionPassword: string;
  crypto: Crypto;
  now: () => Date;
  providerFetch: (request: Request) => Promise<Response>;
  apiFetch: (request: Request) => Promise<Response>;
  reportGrowth?: (event: BrowserGrowthHint) => void;
}
export interface BrowserGrowthHint {
  name: "login_started" | "callback_received" | "login_failed" | "portal_login_succeeded";
  flowId: string | null;
  accountId?: string;
  organizationId?: string;
  errorClass?: "login_context_missing" | "login_state_mismatch" | "unknown";
}
const COOKIE = "__Host-omh-login";
const LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
/** The one attribution pattern organization creation accepts for signup_source. */
const SIGNUP_SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** The only return a workspace switch may name: the signed-in secret or GitHub link of the same app. */
const MCP_LINK_RETURN = /^\/mcp\/(?:secrets|github)\?request=[A-Za-z0-9_-]{43}$/u;
const CLEAR_COOKIE = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** WorkOS browser credentials stay in an encrypted HttpOnly cookie; all resources use REST SDK. */
export async function handleBrowserLogin(
  request: Request,
  d: BrowserLoginDependencies,
): Promise<Response | null> {
  const report = (event: BrowserGrowthHint) => {
    try {
      d.reportGrowth?.(event);
    } catch {
      /* Telemetry cannot affect login. */
    }
  };
  let callbackFlow: string | null = null;
  const url = new URL(request.url);
  if (!PORTAL_PATHS.includes(url.pathname)) return null;
  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "strict-transport-security": STRICT_TRANSPORT_SECURITY,
  });
  const finish = (response: Response) => {
    for (const [name, value] of responseHeaders)
      if (name !== "set-cookie") response.headers.set(name, value);
    for (const cookie of responseHeaders.getSetCookie())
      response.headers.append("set-cookie", cookie);
    return response;
  };
  const page = (options: Partial<PortalPage> = {}) =>
    finish(
      renderPortalPage({ request, origin: d.origin, billingEnabled: d.billingEnabled, ...options }),
    );
  const redirect = (path: string) =>
    finish(
      new Response(null, {
        status: 303,
        headers: { location: path, "referrer-policy": "no-referrer" },
      }),
    );
  // The API limits requests per visitor address; the portal's own calls carry its visitor's.
  const visitor = request.headers.get("cf-connecting-ip");
  const sdk = (accessToken: string) =>
    createClient({
      baseUrl: d.origin,
      auth: accessToken,
      throwOnError: true,
      fetch: (input, init) => {
        const apiRequest = new Request(input, init);
        if (visitor !== null) apiRequest.headers.set("cf-connecting-ip", visitor);
        return d.apiFetch(apiRequest);
      },
    });
  const token = (body: Record<string, string>, prior?: BrowserSession) =>
    exchangeWorkosToken(d, body, prior);
  if (url.origin !== d.origin)
    return page({
      status: 404,
      title: "Page unavailable.",
      message: "Use the official login address.",
    });
  if (!/^client_[A-Za-z0-9]+$/u.test(d.clientId) || d.sessionPassword.length < 32)
    return page({
      status: 503,
      title: "Sign-in unavailable.",
      message: "Please try again shortly.",
    });
  // Where the GitHub callback lands. The customer is mid-flow in their agent, so these pages say
  // what happened and what to do, and never ask for a browser sign-in.
  if (GITHUB_RESULT_PATHS.includes(url.pathname)) return githubResultPage(url, page);
  const source = signupSource(url);
  const callback = url.pathname === "/login/callback";
  const resumeId = url.searchParams.get("resume");
  if (!callback && source === null)
    return page({
      status: 400,
      title: "Invalid link.",
      message: "Open the login page and try again.",
    });
  const resumeUnavailable = () =>
    page({
      notice: true,
      status: 410,
      title: "Link unavailable.",
      message: "Open the original link again or ask your agent for a fresh link.",
    });
  const resumeDestination = (id: string) =>
    readPortalResume(
      request.headers.get("cookie"),
      d.sessionPassword,
      d.origin,
      d.now().getTime(),
      id,
    );
  // Keep old bookmarks, but the HTML controls now live beside each project. Markdown remains
  // available to existing agents and does not require a browser dialog.
  if (
    url.pathname === "/usage" &&
    ["GET", "HEAD"].includes(request.method) &&
    !request.headers.get("accept")?.includes("text/markdown")
  )
    return redirect("/" + url.search);
  if (url.pathname === "/login/start") {
    if (request.method !== "POST" || request.headers.get("origin") !== d.origin)
      return page({
        status: request.method === "POST" ? 403 : 405,
        title: "Login request rejected.",
        message: "Start from the login page.",
      });
    if (resumeId !== null && !(await resumeDestination(resumeId))) return resumeUnavailable();
    const state = randomToken(d.crypto),
      verifier = randomToken(d.crypto),
      flowId = d.crypto.randomUUID();
    report({ name: "login_started", flowId });
    const challenge = Buffer.from(
      await d.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
    const utm = signupUtm(url.searchParams);
    const pending = Buffer.from(
      JSON.stringify({
        state,
        verifier,
        flowId,
        source: source ?? "",
        ...(Object.keys(utm).length === 0 ? {} : { utm }),
        view: url.searchParams.get("view") ?? "connect",
        organization: url.searchParams.get("organization") ?? "",
        ...(resumeId === null ? {} : { resumeId }),
        createdAt: d.now().getTime(),
      }),
    ).toString("base64url");
    responseHeaders.append(
      "set-cookie",
      `${COOKIE}=${pending}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    const destination = new URL("https://api.workos.com/user_management/authorize");
    for (const [key, value] of Object.entries({
      client_id: d.clientId,
      provider: "authkit",
      response_type: "code",
      redirect_uri: d.origin + "/login/callback",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      destination.searchParams.set(key, value);
    return redirect(destination.href);
  }
  let session: BrowserSession | null = null;
  let profile: AccountProfile;
  // Set once the customer is signed in; a failure after that keeps the signed-in shell.
  let accountFailure: ((options: Partial<PortalPage>) => Response) | null = null;
  try {
    if (callback) {
      responseHeaders.append("set-cookie", CLEAR_COOKIE);
      const cookie = request.headers.get("cookie");
      const now = d.now().getTime();
      const pendingCookies = (cookie ?? "")
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item.startsWith(`${COOKIE}=`));
      const pending = readPendingLogin(pendingCookies, now);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const validCallback =
        request.method === "GET" &&
        url.searchParams.size === 2 &&
        code !== null &&
        /^[!-~]{1,2048}$/u.test(code) &&
        state !== null &&
        LOGIN_TOKEN_PATTERN.test(state);
      // A repeat delivery after sign-in can return to the ordinary session path without a grant exchange.
      if (
        validCallback &&
        pendingCookies.length === 0 &&
        (await openBrowserSession(cookie, d.sessionPassword, d.origin, now))
      )
        return redirect("/login");
      callbackFlow = pending?.flowId ?? null;
      report({ name: "callback_received", flowId: callbackFlow });
      if (!validCallback || !pending || state !== pending.state) {
        report({
          name: "login_failed",
          flowId: callbackFlow,
          errorClass: pending ? "login_state_mismatch" : "login_context_missing",
        });
        return page({
          status: 400,
          title: "Login could not be completed.",
          message: "The login expired or belongs to another browser. Start again.",
        });
      }
      session = await token({
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
      });
      const client = sdk(session.accessToken);
      const identity = await getCurrentIdentity({}, { client });
      if (!/^user:user_[A-Za-z0-9_]+$/u.test(identity.actor_id)) throw Error("Invalid identity");
      profile = await recordSignupSource(
        {
          source: pending.source || null,
          ...(pending.utm === undefined ? {} : { utm: pending.utm }),
        },
        { client },
      );
      if (!profile.organizations.length && profile.email_verified) {
        try {
          await createOrganization(
            {
              "Idempotency-Key": "initial-workspace:" + profile.user_id,
              createOrganizationRequest: {
                name: "My workspace",
                // Signup is open; a visit without an r parameter is attributed as direct.
                ...(profile.signup_source === null ? {} : { signup_source: profile.signup_source }),
              },
            },
            { client },
          );
          profile = await getAccountProfile({ client });
        } catch (error) {
          // The replayed first-workspace request is refused once that workspace or its membership is gone.
          // Sign the user in without a workspace; a retryable 503 would repeat the same refused request.
          if (statusOf(error) !== 403 && statusOf(error) !== 409) throw error;
        }
      }
      const selected =
        profile.organizations.find((x) => x.id === pending.organization) ??
        (!pending.organization ? profile.organizations[0] : undefined);
      if (pending.organization && !selected) {
        report({ name: "login_failed", flowId: callbackFlow, errorClass: "unknown" });
        return page({
          status: 403,
          title: "Access unavailable.",
          message: "That workspace is not available to this account.",
        });
      }
      if (selected) {
        session = await token(
          {
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            organization_id: selected.workos_id,
          },
          session,
        );
        session.organizationId = selected.id;
        await getCurrentIdentity({}, { client: sdk(session.accessToken) });
      }
      responseHeaders.append("set-cookie", await closeBrowserSession(session, d.sessionPassword));
      report({
        name: "portal_login_succeeded",
        flowId: callbackFlow,
        accountId: profile.user_id,
        ...(selected ? { organizationId: selected.id } : {}),
      });
      if (pending.resumeId) {
        const destination = await resumeDestination(pending.resumeId);
        if (!destination) return resumeUnavailable();
        responseHeaders.append("set-cookie", CLEAR_PORTAL_RESUME);
        return redirect(destination);
      }
      return redirect(pending.view === "connect" ? "/" : `/${pending.view}`);
    }
    if (
      url.pathname === "/login" &&
      resumeId !== null &&
      ["GET", "HEAD"].includes(request.method)
    ) {
      if (!(await resumeDestination(resumeId))) return resumeUnavailable();
      return page({ login: true, resumeId });
    }
    session = await openBrowserSession(
      request.headers.get("cookie"),
      d.sessionPassword,
      d.origin,
      d.now().getTime(),
    );
    if (!session) {
      if (request.method === "HEAD" || request.method === "GET")
        return page({
          login: true,
          source: source ?? "",
          view: url.pathname.startsWith("/billing")
            ? "billing"
            : url.pathname.startsWith("/usage")
              ? "usage"
              : url.pathname.startsWith("/profile")
                ? "profile"
                : url.pathname.startsWith("/tokens")
                  ? "tokens"
                  : "connect",
        });
      return page({
        status: 401,
        title: "Please sign in.",
        message: "Sign in to continue.",
        login: true,
      });
    }
    try {
      profile = await getAccountProfile({ client: sdk(session.accessToken) });
    } catch (error) {
      if (statusOf(error) !== 401) throw error;
      session = await token(
        { grant_type: "refresh_token", refresh_token: session.refreshToken },
        session,
      );
      profile = await getAccountProfile({ client: sdk(session.accessToken) });
      responseHeaders.append("set-cookie", await closeBrowserSession(session, d.sessionPassword));
    }
    // A session signed in before any workspace existed adopts a workspace created since, as the workspace switch
    // does, instead of showing the no-workspace prompt until the customer signs in again. It takes the workspace
    // the first sign-in created, else the oldest membership: workspace ids are time-ordered ULIDs, and the listing
    // order is not a rule to rely on.
    if (!session.organizationId && profile.organizations.length > 0) {
      const adopted =
        profile.organizations.find((x) => x.id === profile.initial_workspace_id) ??
        profile.organizations.reduce((oldest, x) => (x.id < oldest.id ? x : oldest));
      // A refused adoption keeps the signed-in session: the sign-in is not cleared and the page is not redirected,
      // so the next page adopts again instead of looping through /login.
      let refreshed: BrowserSession | null = null;
      try {
        refreshed = await token(
          {
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            organization_id: adopted.workos_id,
          },
          session,
        );
      } catch {
        // The adoption is refused for now; the session stays as it is.
      }
      if (refreshed) {
        try {
          await getCurrentIdentity({}, { client: sdk(refreshed.accessToken) });
          refreshed.organizationId = adopted.id;
        } catch {
          // The rotated tokens are current even when the workspace cannot be confirmed yet: keep them without one.
        }
        session = refreshed;
        responseHeaders.append("set-cookie", await closeBrowserSession(session, d.sessionPassword));
      }
    }
    let organization = profile.organizations.find((x) => x.id === session?.organizationId);
    if (!organization && session.organizationId) {
      responseHeaders.append("set-cookie", CLEAR_PORTAL_SESSION);
      return redirect("/login");
    }
    const client = sdk(session.accessToken);
    const view: PortalView = url.pathname.startsWith("/profile")
      ? "profile"
      : url.pathname.startsWith("/billing")
        ? "billing"
        : url.pathname.startsWith("/usage")
          ? "usage"
          : url.pathname.startsWith("/tokens")
            ? "tokens"
            : "connect";
    const csrf = session.csrf;
    accountFailure = (options) =>
      page({
        signedIn: true,
        profile,
        view,
        csrf,
        organizationId: organization?.id ?? null,
        ...options,
      });
    if (request.method === "POST") {
      // Two unrelated causes deserve two answers; one shared sentence told the reader nothing.
      if (request.headers.get("origin") !== d.origin)
        return accountFailure({
          status: 403,
          title: "Request rejected.",
          message:
            "Your browser did not send this form from the portal. Reload this page and try again.",
        });
      if (
        request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded"
      )
        return accountFailure({
          status: 403,
          title: "Request rejected.",
          message: "This change must be submitted as a portal form.",
        });
      const form = new URLSearchParams(await readBoundedText(new Response(request.body), 8192));
      if (form.getAll("csrf").length !== 1 || form.get("csrf") !== session.csrf)
        return accountFailure({
          status: 403,
          title: "Request expired.",
          message: "Reload the page and try again.",
        });
      if (url.pathname === "/logout") {
        await revokeCurrentSession(
          { "Idempotency-Key": "portal-logout:" + session.csrf },
          { client },
        );
        responseHeaders.append("set-cookie", CLEAR_PORTAL_SESSION);
        return redirect("/login");
      }
      if (url.pathname === "/tokens" || url.pathname === "/tokens/revoke") {
        const csrf = session.csrf;
        const tokenPage = (options: Partial<PortalPage> = {}) =>
          page({
            signedIn: true,
            profile,
            view: "tokens",
            csrf,
            organizationId: organization?.id ?? null,
            ...options,
          });
        if (!organization)
          return tokenPage({ status: 403, message: "Select a workspace before managing tokens." });
        if (
          form.getAll("organization").length !== 1 ||
          form.get("organization") !== organization.id
        )
          return tokenPage({
            status: 409,
            message: "Your workspace changed. Reload this page before managing tokens.",
          });
        if (url.pathname === "/tokens" && request.headers.get("accept")?.includes("text/markdown"))
          return tokenPage({
            status: 406,
            message:
              "Create tokens in the browser or use the token API so the one-time value can be delivered.",
          });
        let tokenDraft: PortalPage["tokenDraft"];
        try {
          if (url.pathname === "/tokens/revoke") {
            const keyId = form.get("key_id") ?? "";
            if (form.getAll("key_id").length !== 1 || !/^api_key_[A-Za-z0-9_]{1,120}$/u.test(keyId))
              return tokenPage({ status: 400, message: "Select a token from your workspace." });
            await revokeUserApiKey({ organization_id: organization.id, key_id: keyId }, { client });
            return redirect("/tokens");
          }
          const name = form.get("name")?.trim() ?? "",
            requestKey = form.get("request_key") ?? "";
          if (
            form.getAll("name").length !== 1 ||
            !name ||
            name.length > 64 ||
            /\p{Cc}/u.test(name) ||
            form.getAll("request_key").length !== 1 ||
            !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestKey)
          )
            return tokenPage({
              status: 400,
              message: "Enter a token name of 1–64 characters and retry from this page.",
            });
          tokenDraft = { name, requestKey };
          const createdKey = await createUserApiKey(
            { organization_id: organization.id, name, "Idempotency-Key": requestKey },
            { client },
          );
          // Do not make another fallible API call after receiving this one-time secret.
          return tokenPage({ createdKey });
        } catch (error) {
          const status = statusOf(error);
          // A 409 on creation means this form's key already names another token. Resubmitting that key can
          // never succeed, so the form gets a fresh key for the changed name.
          if (status === 409 && tokenDraft)
            return tokenPage({
              tokenDraft: { name: tokenDraft.name, requestKey: d.crypto.randomUUID() },
              status: 409,
              message:
                "This form was already used for another token name. Enter that name to check the earlier attempt. To create this name as a new token, submit again; an earlier attempt may already have created a token.",
            });
          return tokenPage({
            ...(tokenDraft ? { tokenDraft } : {}),
            status: status === 403 || status === 404 || status === 409 ? status : 503,
            message:
              status === 403 || status === 404
                ? "This token is not available to your account in this workspace."
                : "Token management could not be completed. Retry the original request; do not create a replacement after an uncertain result.",
          });
        }
      }
      if (url.pathname === "/workspace") {
        organization = profile.organizations.find((x) => x.id === form.get("organization"));
        if (!organization)
          return accountFailure({
            status: 403,
            title: "Access unavailable.",
            message: "Select one of your workspaces.",
          });
        // A switch made from a signed-in MCP link returns to that link; any other return is refused before the session changes.
        const back = form.get("return");
        if (form.getAll("return").length > 1 || (back !== null && !MCP_LINK_RETURN.test(back)))
          return page({
            status: 400,
            title: "Request unavailable.",
            message: "Ask your agent for a fresh link.",
          });
        session = await token(
          {
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            organization_id: organization.workos_id,
          },
          session,
        );
        session.organizationId = organization.id;
        await getCurrentIdentity({}, { client: sdk(session.accessToken) });
        responseHeaders.append("set-cookie", await closeBrowserSession(session, d.sessionPassword));
        return redirect(back ?? "/");
      }
      if (url.pathname === "/billing/recharge") {
        if (!organization || !d.billingEnabled)
          return accountFailure({
            status: 409,
            title: "Billing is unavailable.",
            message: "Please try again later.",
          });
        const enabled = form.get("enabled") === "true",
          limit = Number(form.get("monthly_limit_minor")),
          revision = Number(form.get("revision"));
        if (
          form.getAll("enabled").length !== 1 ||
          !["true", "false"].includes(form.get("enabled") ?? "") ||
          (enabled && form.get("consent") !== "off_session_v1") ||
          !Number.isSafeInteger(limit) ||
          limit < 1000 ||
          limit > 100000 ||
          !Number.isSafeInteger(revision) ||
          revision < 0
        )
          return accountFailure({
            status: 400,
            title: "Confirm auto-recharge.",
            message: "Choose a monthly limit and confirm permission to charge your saved card.",
          });
        const result = await configureBillingRecharge(
          {
            organization_id: organization.id,
            "Idempotency-Key": "portal-recharge:" + session.csrf + ":" + String(revision),
            enabled,
            monthly_limit_minor: limit,
            consent: enabled ? "off_session_v1" : null,
            revision,
          },
          { client },
        );
        if (result.setup_url) {
          const target = new URL(result.setup_url);
          if (target.origin !== "https://checkout.stripe.com" || target.username || target.password)
            throw Error("Invalid Stripe destination");
          return redirect(target.href);
        }
        return redirect("/billing");
      }
      if (url.pathname === "/billing/stripe") {
        if (!organization || !d.billingEnabled)
          return accountFailure({
            status: 409,
            title: "Stripe billing is unavailable.",
            message: "Your existing credits and access are unchanged.",
          });
        const portal = await createBillingPortal(
          { organization_id: organization.id, body: {} },
          { client },
        );
        const target = new URL(portal.url);
        if (
          portal.organization_id !== organization.id ||
          target.origin !== "https://billing.stripe.com" ||
          !target.pathname.startsWith("/p/") ||
          target.username ||
          target.password
        )
          throw Error("Invalid Stripe destination");
        return redirect(target.href);
      }
      if (
        url.pathname === "/budget" ||
        url.pathname === "/dev-access" ||
        url.pathname === "/flag"
      ) {
        const projectId = form.get("project") ?? "";
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(projectId) || !organization)
          return accountFailure({
            status: 400,
            title: "Invalid project.",
            message: "Choose a project from your workspace.",
          });
        if (url.pathname === "/flag") {
          const enabled = form.get("enabled"),
            cursor = form.get("cursor") ?? "";
          if (
            (enabled !== "true" && enabled !== "false") ||
            form.getAll("cursor").length > 1 ||
            (cursor !== "" && !/^[^\p{Cc}]{1,4096}$/u.test(cursor))
          )
            return accountFailure({
              status: 400,
              title: "Invalid flag change.",
              message: "Use the displayed flag button.",
            });
          try {
            await setProjectPoweredByFlag(
              {
                project_id: projectId,
                "Idempotency-Key": form.get("request_key") ?? "",
                setPoweredByFlagRequest: { enabled: enabled === "true" },
              },
              { client },
            );
          } catch (error) {
            const refused = statusOf(error);
            if (refused === null || refused === 401) throw error;
            if (refused !== 409)
              return accountFailure({
                status: refused,
                title: "The flag could not be changed.",
                message: "Reload this page and try again.",
              });
            return accountFailure({
              status: 409,
              title: "The flag keeps your domain online.",
              message:
                "This Free workspace's own domain is served because the project shows the flag. Remove the domain or buy Paid, then hide the flag.",
            });
          }
          return redirect(
            "/" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "") + "#flag-" + projectId,
          );
        }
        const status = await getProjectStatus({ project_id: projectId }, { client });
        if (url.pathname === "/dev-access") {
          if (status.dev_access_mode === "public") {
            if (!status.dev_url) throw Error("Invalid Dev destination");
            const target = new URL(status.dev_url);
            if (
              target.origin !== status.dev_url ||
              target.protocol !== "https:" ||
              target.username ||
              target.password ||
              !/^dev-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.(?:dev\.)?check\.omh\.st$/u.test(target.hostname)
            )
              throw Error("Invalid Dev destination");
            return redirect(`${target.origin}/`);
          }
          let ticket: Awaited<ReturnType<typeof createProjectDevAccessTicket>>;
          try {
            ticket = await createProjectDevAccessTicket({ project_id: projectId }, { client });
          } catch (error) {
            const refused = statusOf(error);
            if (refused !== 400 && refused !== 409) throw error;
            return accountFailure({
              status: refused,
              title: "Dev access is not ready.",
              message:
                "Reload this page and check the project status with your agent before opening Dev again.",
            });
          }
          const target = new URL(ticket.redeem_url);
          if (
            !status.dev_url ||
            target.origin !== new URL(status.dev_url).origin ||
            target.protocol !== "https:" ||
            target.username ||
            target.password
          )
            throw Error("Invalid Dev destination");
          return redirect(target.href);
        }
        const raw = form.get("limit")?.trim() ?? "",
          mode = form.get("mode"),
          cursor = form.get("cursor") ?? "";
        if (
          form.getAll("cursor").length > 1 ||
          (cursor !== "" && !/^[^\p{Cc}]{1,4096}$/u.test(cursor)) ||
          (mode !== "stop" && mode !== "continue") ||
          (raw !== "" && !/^\d{1,12}(?:\.\d{1,6})?$/u.test(raw))
        )
          return accountFailure({
            status: 400,
            title: "Check the limit.",
            message: "Use a positive credit amount or leave it empty.",
          });
        const parts = raw.split(".");
        const micros =
          raw === ""
            ? null
            : BigInt(parts[0] ?? "0") * 1000000n + BigInt((parts[1] ?? "").padEnd(6, "0"));
        const amount = micros === null ? null : micros.toString();
        const limitRefused = {
          status: 400 as const,
          title: "Check the limit.",
          message: "Use a smaller credit amount or leave it empty.",
        };
        // The budget API stores whole micros as safe integers; a larger limit can never be saved.
        if (micros !== null && micros > BigInt(Number.MAX_SAFE_INTEGER))
          return accountFailure(limitRefused);
        try {
          await setProjectCreditBudget(
            {
              project_id: projectId,
              "Idempotency-Key": form.get("request_key") ?? "",
              setProjectCreditBudgetRequest: {
                amount_micros: amount,
                mode: amount === null ? "continue" : mode,
              },
            },
            { client },
          );
        } catch (error) {
          if (statusOf(error) !== 400) throw error;
          return accountFailure(limitRefused);
        }
        await getProjectCreditBudget({ project_id: projectId }, { client });
        return redirect(
          "/" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "") + "#usage-" + projectId,
        );
      }
      return accountFailure({
        status: 405,
        title: "Action unavailable.",
        message: "Use the displayed portal actions.",
      });
    }
    if (!["GET", "HEAD"].includes(request.method))
      return accountFailure({
        status: 405,
        title: "Method unavailable.",
        message: "Open the portal in your browser.",
      });
    if (url.pathname === "/login") return redirect("/");
    // Every member may share the workspace's referral link from the account menu.
    const referralUrl = organization
      ? (await getOrganizationReferral({ organization_id: organization.id }, { client }))
          .referral_url
      : null;
    if (view === "tokens") {
      const userKeys = organization
        ? await listUserApiKeys(
            {
              organization_id: organization.id,
              ...(url.searchParams.get("cursor")
                ? { after: url.searchParams.get("cursor") ?? "" }
                : {}),
            },
            { client },
          )
        : undefined;
      return page({
        view,
        signedIn: true,
        profile,
        csrf: session.csrf,
        organizationId: organization?.id ?? null,
        referralUrl,
        ...(userKeys ? { userKeys } : {}),
      });
    }
    let account: OrganizationAccount | null = null,
      accountDenied = false;
    // Only the pages that show the plan, credit or budgets read the account; Profile and Email do not need it.
    if (organization && (view === "billing" || view === "connect" || view === "usage")) {
      try {
        account = await getOrganizationAccount({ organization_id: organization.id }, { client });
      } catch (error) {
        if (statusOf(error) === 404 || statusOf(error) === 403) accountDenied = true;
        else throw error;
      }
    }
    const recharge =
      organization && account && view === "billing" && d.billingEnabled
        ? await getBillingRecharge({ organization_id: organization.id }, { client })
        : null;
    const projects: Array<{
      project: Project;
      status: ProjectStatus;
      budget: ProjectCreditBudget | null;
      flag: PoweredByFlag | null;
    }> = [];
    if (organization && (view === "connect" || view === "usage")) {
      const listed = await listProjects(
        {
          limit: 20,
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor") ?? "" }
            : {}),
        },
        { client },
      );
      for (let i = 0; i < listed.items.length; i += 4) {
        const batch = await Promise.all(
          listed.items
            .slice(i, i + 4)
            .filter((p) => p.organization_id === organization?.id)
            .map(async (project) => {
              const status = await getProjectStatus({ project_id: project.id }, { client });
              // Only an active project has a budget and a powered-by flag; the flag read answers 404 for a deleting one.
              const active = !accountDenied && status.lifecycle === "active";
              return {
                project,
                status,
                budget: active
                  ? await getProjectCreditBudget({ project_id: project.id }, { client })
                  : null,
                flag: active
                  ? await getProjectPoweredByFlag({ project_id: project.id }, { client })
                  : null,
              };
            }),
        );
        projects.push(...batch);
      }
      return page({
        view,
        signedIn: true,
        source: profile.signup_source ?? "",
        profile,
        account,
        accountDenied,
        projects,
        csrf: session.csrf,
        organizationId: organization.id,
        referralUrl,
        nextCursor: listed.next_cursor ?? null,
      });
    }
    return page({
      view,
      signedIn: true,
      source: profile.signup_source ?? "",
      profile,
      account,
      accountDenied,
      recharge,
      projects,
      csrf: session.csrf,
      organizationId: organization?.id ?? null,
      referralUrl,
    });
  } catch (error) {
    if (callback) report({ name: "login_failed", flowId: callbackFlow, errorClass: "unknown" });
    const status = statusOf(error);
    if (status === 401) {
      responseHeaders.append("set-cookie", CLEAR_PORTAL_SESSION);
      return redirect("/login");
    }
    return (accountFailure ?? page)({
      status: 503,
      title: "Temporarily unavailable.",
      message: "Please retry the same request or ask your agent to check the latest state.",
    });
  }
}
function statusOf(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}
function signupSource(url: URL): string | null {
  const allowed = [
    "r",
    "view",
    "organization",
    "cursor",
    ...(["/login", "/login/start"].includes(url.pathname) ? ["resume"] : []),
  ];
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.includes(key) && !key.toLowerCase().startsWith("utm_"),
    ) ||
    allowed.some((key) => url.searchParams.getAll(key).length > 1) ||
    (url.searchParams.has("resume") &&
      !PORTAL_RESUME_ID.test(url.searchParams.get("resume") ?? "")) ||
    (url.searchParams.has("view") &&
      !["billing", "usage", "profile", "tokens"].includes(url.searchParams.get("view") ?? "")) ||
    (url.searchParams.has("organization") &&
      !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(url.searchParams.get("organization") ?? ""))
  )
    return null;
  // Signup never needs a link: an r value outside the attribution pattern counts as no link, so
  // nothing is frozen that organization creation would later refuse.
  const source = url.searchParams.get("r");
  return source !== null && SIGNUP_SOURCE.test(source) ? source : "";
}
function readPendingLogin(
  values: string[],
  now: number,
): {
  state: string;
  verifier: string;
  flowId?: string;
  source: string;
  utm?: Record<string, string>;
  view: PortalView;
  organization: string;
  resumeId?: string;
} | null {
  try {
    const [encoded] = values;
    if (values.length !== 1 || encoded === undefined || encoded.length > 4096) return null;
    const value: unknown = JSON.parse(
      Buffer.from(encoded.slice(COOKIE.length + 1), "base64url").toString("utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      ![
        "createdAt,flowId,organization,source,state,verifier,view",
        "createdAt,flowId,organization,source,state,utm,verifier,view",
        "createdAt,organization,source,state,verifier,view",
        "createdAt,organization,source,state,utm,verifier,view",
      ].includes(
        Object.keys(value)
          .filter((key) => key !== "resumeId")
          .sort()
          .join(","),
      )
    )
      return null;
    const {
      state,
      verifier,
      source,
      createdAt,
      view: pendingView,
      organization,
      utm,
      flowId,
      resumeId,
    } = value as Record<string, unknown>;
    // A sign-in started before these pages were retired can still finish on Projects.
    const view = pendingView === "mail" || pendingView === "connections" ? "connect" : pendingView;
    if (
      typeof view !== "string" ||
      !["connect", "billing", "usage", "profile", "tokens"].includes(view) ||
      typeof organization !== "string" ||
      (organization !== "" && !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(organization)) ||
      (resumeId !== undefined &&
        (typeof resumeId !== "string" || !PORTAL_RESUME_ID.test(resumeId))) ||
      typeof state !== "string" ||
      typeof verifier !== "string" ||
      typeof source !== "string" ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      createdAt > now ||
      now - createdAt >= 600000 ||
      ![state, verifier].every((token) => LOGIN_TOKEN_PATTERN.test(token)) ||
      (source !== "" && !SIGNUP_SOURCE.test(source))
    )
      return null;
    // A bad optional campaign snapshot is discarded; it cannot invalidate valid state/PKCE.
    let campaign: Record<string, string> | undefined;
    if (utm !== undefined) {
      const entries = new URLSearchParams();
      if (utm !== null && typeof utm === "object" && !Array.isArray(utm))
        for (const [key, item] of Object.entries(utm))
          if (typeof item === "string") entries.append(key, item);
      const accepted = signupUtm(entries);
      if (Object.keys(accepted).length !== 0) campaign = accepted;
    }
    return {
      state,
      verifier,
      source,
      ...(typeof flowId === "string" && /^[0-9a-f-]{36}$/u.test(flowId) ? { flowId } : {}),
      view: view as PortalView,
      organization,
      ...(resumeId === undefined ? {} : { resumeId }),
      ...(campaign === undefined ? {} : { utm: campaign }),
    };
  } catch {
    return null;
  }
}
