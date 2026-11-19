import { createHash } from "node:crypto";
import { renderMakeConnectedPage } from "./make-connected-page.js";
import type { AuthenticatedPrincipal } from "./contracts.js";
import { renderStandalonePage, type StandalonePageOptions } from "./standalone-page.js";
import { readBoundedText } from "./workos-session-status.js";

export interface ConnectionPortalHandoff {
  readonly userId: string;
  readonly registration?: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly originatingDelegation?: unknown;
  readonly originatingCredential?: unknown;
}
export interface ConnectionConfirmationLookup {
  matchesConfirmation?(input: {
    result: string;
    principalId: string;
    sessionId: string;
    handoffHash: string;
  }): Promise<boolean>;
}
export interface ConnectionPortalDependencies {
  readonly confirmation?: ConnectionConfirmationLookup;
  readonly origin: string;
  readonly connectOrigin: string;
  readonly resumeAfterLogin?: (url: URL) => Promise<Response | null>;
  authenticate(
    request: Request,
  ): Promise<{ principal: AuthenticatedPrincipal; csrf: string; headers?: Headers } | null>;
  readHandoff(
    opaque: string,
    principal: AuthenticatedPrincipal,
  ): Promise<ConnectionPortalHandoff | null>;
  consumeHandoff(
    opaque: string,
    principal: AuthenticatedPrincipal,
  ): Promise<ConnectionPortalHandoff | null>;
  readiness(): Promise<boolean>;
  begin(
    input: ConnectionPortalHandoff & {
      principalId: string;
      sessionId: string;
      browserSession: NonNullable<AuthenticatedPrincipal["session"]>;
    },
  ): Promise<{ url: string }>;
  complete(input: { result: string; principalId: string; sessionId: string }): Promise<
    | {
        state: "active";
        grantId: string;
        organizationId: string;
        projectId?: string;
        environmentId?: string;
      }
    | { state: "denied" }
  >;
}
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const handoffCookieName = "__Host-omh-connection-handoff";
const saveSource = `function save() {
  document.getElementById("save-connection").requestSubmit();
}
if (document.prerendering) {
  document.addEventListener("prerenderingchange", save, { once: true });
} else {
  save();
}`;
const saveScript = {
  source: saveSource,
  hash: `sha256-${createHash("sha256").update(saveSource).digest("base64")}`,
};
function readIntentCookie(request: Request): string | undefined {
  let hash: string | undefined;
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const pair = item.trim();
    if (!pair.startsWith(handoffCookieName + "=")) continue;
    const value = pair.slice(handoffCookieName.length + 1);
    if (hash !== undefined || !/^[0-9a-f]{64}$/u.test(value)) return undefined;
    hash = value;
  }
  return hash;
}
const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
/** The opaque feature handoff and broker result are only consumed by same-origin CSRF-protected POSTs. */
export async function handleConnectionsPortalRequest(
  request: Request,
  dependencies: ConnectionPortalDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const authorize = url.pathname === "/connections/authorize";
  if (!authorize && url.pathname !== "/connections/complete") return null;
  const page = (
    title: string,
    message: string,
    status: number,
    body = "",
    options: Partial<Pick<StandalonePageOptions, "referrerPolicy" | "script" | "refreshUrl">> = {},
  ): Response =>
    renderStandalonePage({
      providerIcon: "make",
      title,
      message,
      status,
      body,
      head: request.method === "HEAD",
      development: dependencies.origin === "https://dev.app.ohmyho.st",
      referrerPolicy: "no-referrer",
      ...options,
    });
  const error = () =>
    page("Connection unavailable", "Ask for a new connection link and try again.", 404);
  if (url.origin !== dependencies.origin || !["GET", "HEAD", "POST"].includes(request.method))
    return error();
  const browser = await dependencies.authenticate(request);
  if (
    !browser?.principal.session ||
    browser.principal.actorId !== `user:${browser.principal.session.userId}`
  ) {
    if (request.method === "GET") {
      const resume = await dependencies.resumeAfterLogin?.(url);
      if (resume) return resume;
    }
    return page("Sign in to continue", "Open this link again after signing in.", 401);
  }
  const finish = (response: Response) => {
    browser.headers?.forEach((value, key) => response.headers.append(key, value));
    return response;
  };
  let form: URLSearchParams | null = null;
  if (request.method === "POST") {
    if (
      request.headers.get("origin") !== dependencies.origin ||
      request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded" ||
      url.search
    )
      return finish(error());
    try {
      form = new URLSearchParams(await readBoundedText(new Response(request.body), 2048));
    } catch {
      return finish(error());
    }
    if (form.getAll("csrf").length !== 1 || form.get("csrf") !== browser.csrf)
      return finish(error());
  }
  const name = authorize ? "request" : "result";
  const params = form ?? url.searchParams;
  if (
    params.getAll(name).length !== 1 ||
    [...params.keys()].some((key) => key !== name && key !== "csrf") ||
    !tokenPattern.test(params.get(name) ?? "")
  )
    return finish(error());
  const token = params.get(name) ?? "";
  try {
    if (!(await dependencies.readiness()))
      return finish(page("Connection unavailable", "This provider is not available yet.", 503));
    if (authorize) {
      const handoff = form
        ? await dependencies.consumeHandoff(token, browser.principal)
        : await dependencies.readHandoff(token, browser.principal);
      if (!handoff || handoff.userId !== browser.principal.session.userId) return finish(error());
      if (!form)
        return finish(
          page(
            "Connect Make",
            "Review the workspace, app, connection, Endpoint and scenario permissions requested on Make.",
            200,
            `<form method="post" action="/connections/authorize"><input type="hidden" name="csrf" value="${esc(browser.csrf)}"><input type="hidden" name="request" value="${esc(token)}"><button class="portal-button" type="submit">Connect Make</button></form>`,
            { referrerPolicy: "strict-origin" },
          ),
        );
      const result = await dependencies.begin({
        ...handoff,
        principalId: browser.principal.actorId,
        sessionId: browser.principal.session.sessionId,
        browserSession: browser.principal.session,
      });
      const target = new URL(result.url);
      const brokerHandoff = target.searchParams.get("handoff");
      if (
        target.origin !== dependencies.connectOrigin ||
        target.pathname !== "/oauth/start" ||
        target.username ||
        target.password ||
        target.hash ||
        target.searchParams.size !== 1 ||
        !brokerHandoff ||
        !tokenPattern.test(brokerHandoff)
      )
        return finish(error());
      const redirect = page(
        "Redirecting to Make",
        "Taking you to Make to authorize this connection.",
        200,
        `<p><a class="portal-button secondary" href="${esc(target.href)}" rel="noreferrer">Open Make</a></p>`,
        { refreshUrl: target.href },
      );
      const handoffHash = createHash("sha256").update(brokerHandoff).digest("hex");
      redirect.headers.append(
        "set-cookie",
        `${handoffCookieName}=${handoffHash}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1200`,
      );
      return finish(redirect);
    }
    const confirmation = {
      result: token,
      principalId: browser.principal.actorId,
      sessionId: browser.principal.session.sessionId,
    };
    if (!form) {
      const handoffHash = readIntentCookie(request);
      let mayAutoSave = false;
      if (
        request.method === "GET" &&
        handoffHash &&
        !/prefetch|prerender/iu.test(
          `${request.headers.get("purpose")} ${request.headers.get("sec-purpose")}`,
        )
      ) {
        try {
          mayAutoSave =
            (await dependencies.confirmation?.matchesConfirmation?.({
              ...confirmation,
              handoffHash,
            })) === true;
        } catch {
          // A rolling deployment can temporarily lack the read-only broker method.
        }
      }
      const saveButton = '<button class="portal-button" type="submit">Save connection</button>';
      return finish(
        page(
          mayAutoSave ? "Saving connection" : "Save connection",
          mayAutoSave
            ? "Saving your Make connection."
            : "Save your Make connection to continue with your agent.",
          200,
          `<form id="save-connection" method="post" action="/connections/complete"><input type="hidden" name="csrf" value="${esc(browser.csrf)}"><input type="hidden" name="result" value="${esc(token)}">${mayAutoSave ? `<noscript>${saveButton}</noscript>` : saveButton}</form>`,
          { referrerPolicy: "strict-origin", ...(mayAutoSave ? { script: saveScript } : {}) },
        ),
      );
    }
    const completed = await dependencies.complete(confirmation);
    if (completed.state !== "active") return finish(error());
    return finish(renderMakeConnectedPage(dependencies.origin === "https://dev.app.ohmyho.st"));
  } catch {
    return finish(error());
  }
}
