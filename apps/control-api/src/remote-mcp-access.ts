import {
  parseUlid,
  createUlidFactory,
  type AuthorizationAction,
  type AuthorizationResource,
} from "@ohmyhost/platform";
import {
  connectGithubOrganization,
  createClient,
  getAccountProfile,
  getProject,
  putEnvironmentSecret,
  updateNativeAuthProvider,
} from "@ohmyhost/sdk-ts";
import type { AccountProfile } from "@ohmyhost/sdk-ts";
import { SECRET_VALUE_MAXIMUM_BYTES, isUserSecretName } from "@ohmyhost/contracts/secret-names";
import type {
  McpDelegationIdentity,
  McpDelegationStore,
  McpHandoffAuthority,
  McpPortalHandoff,
  McpSecretResult,
  McpSecretTarget,
} from "@ohmyhost/database";
import type { AuthenticatedPrincipal } from "./contracts.js";
import type { VerifiedWorkosConnectPrincipal } from "./workos-authenticator.js";
import { readBoundedText } from "./workos-session-status.js";
import { PORTAL_COPY_ICON, renderStandalonePage } from "./standalone-page.js";
import { mcpChatReturnUrl } from "./mcp-chat-return.js";
/** The largest provider configuration revision the control store holds; revisions start at 1. */
export const NATIVE_AUTH_CONFIGURATION_REVISION_MAX = 2_147_483_646;

export interface McpPortalAccessDependencies {
  readonly origin: string;
  readonly store: McpDelegationStore;
  readonly crypto: Crypto;
  readonly now: () => Date;
  readonly authorize: (
    principal: VerifiedWorkosConnectPrincipal,
    resource: AuthorizationResource,
    action: AuthorizationAction,
  ) => Promise<McpHandoffAuthority | null>;
}

export interface McpPortalLink {
  readonly request_id: string;
  readonly url: string;
  readonly expires_at: string;
}

/** Opaque links carry no provider token, credential, secret value or browser CSRF state. */
export function createMcpPortalAccess(dependencies: McpPortalAccessDependencies) {
  const { origin, store, crypto, now, authorize } = dependencies;
  const attemptIds = createUlidFactory({
    clock: { now },
    entropy: {
      fill: (bytes) => {
        crypto.getRandomValues(bytes);
      },
    },
  });
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw new TypeError("MCP portal origin must be an HTTPS origin");
  async function identity(principal: VerifiedWorkosConnectPrincipal, organizationId: string) {
    if (!principal.organizationIds.some((id) => id === organizationId))
      throw new McpPortalAccessDenied();
    return {
      userId: principal.connectUser.userId,
      clientId: principal.connectUser.clientId,
      consentHash: await digest(principal.connectUser.consentId),
      organizationId,
    } satisfies McpDelegationIdentity;
  }
  async function digest(value: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function start(
    principal: VerifiedWorkosConnectPrincipal,
    organizationId: string,
    secretTarget: McpSecretTarget | null,
    githubTarget: { idempotencyKey: string } | null = null,
  ): Promise<McpPortalLink> {
    const selected = await identity(principal, organizationId);
    if (
      secretTarget &&
      (!isUserSecretName(secretTarget.name) ||
        !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(secretTarget.environmentId) ||
        (secretTarget.nativeProvider !== undefined &&
          (secretTarget.name !==
            `NATIVE_AUTH_${secretTarget.nativeProvider.provider.toUpperCase()}_CLIENT_SECRET` ||
            !["google", "github"].includes(secretTarget.nativeProvider.provider) ||
            !Number.isSafeInteger(secretTarget.nativeProvider.configurationRevision) ||
            secretTarget.nativeProvider.configurationRevision < 1 ||
            secretTarget.nativeProvider.configurationRevision >
              NATIVE_AUTH_CONFIGURATION_REVISION_MAX ||
            typeof secretTarget.nativeProvider.enabled !== "boolean" ||
            (secretTarget.nativeProvider.clientId !== undefined &&
              (secretTarget.nativeProvider.clientId.length === 0 ||
                secretTarget.nativeProvider.clientId.length > 1024)))))
    )
      throw new McpPortalAccessDenied();
    const action = secretTarget
      ? secretTarget.nativeProvider
        ? "auth:manage"
        : "secrets:write"
      : "sources:link";
    const resource: AuthorizationResource = secretTarget
      ? {
          kind: "project",
          organizationId: parseUlid(organizationId),
          projectId: parseUlid(secretTarget.projectId),
          environmentId: parseUlid(secretTarget.environmentId),
        }
      : { kind: "organization", organizationId: parseUlid(organizationId) };
    const authority = await authorize(principal, resource, action);
    if (
      !authority ||
      authority.action !== action ||
      authority.clientId !== selected.clientId ||
      authority.consentHash !== selected.consentHash
    )
      throw new McpPortalAccessDenied();
    const opaque = encodeToken(crypto.getRandomValues(new Uint8Array(32)));
    const createdAt = now().toISOString();
    // A plain secret link is the capability itself, so it lives for one hour; provider and GitHub links keep ten minutes.
    const lifetime = secretTarget && !secretTarget.nativeProvider ? 3_600_000 : 600_000;
    const expiresAt = new Date(Date.parse(createdAt) + lifetime).toISOString();
    const requestHash = await digest(opaque);
    await store.insertHandoff({
      ...selected,
      requestHash,
      authority,
      kind: secretTarget ? "secret" : "github",
      projectIds: secretTarget ? [secretTarget.projectId] : [],
      allowCreate: false,
      allowPublish: false,
      secretTarget,
      ...(githubTarget === null ? {} : { githubTarget }),
      createdAt,
      expiresAt,
      consumedAt: null,
      outcome: null,
    });
    const url = new URL(secretTarget ? "/mcp/secrets" : "/mcp/github", origin);
    url.searchParams.set("request", opaque);
    return { request_id: requestHash, url: url.href, expires_at: expiresAt };
  }
  /** A plain (non-provider) secret handoff, whatever its state; only the anonymous link path reads it. */
  async function plainSecretHandoff(opaque: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(opaque)) return null;
    const request = await store.findHandoff(await digest(opaque));
    return request?.kind === "secret" &&
      request.secretTarget &&
      !request.secretTarget.nativeProvider
      ? request
      : null;
  }
  async function readOwnedHandoff(opaque: string, principal: AuthenticatedPrincipal) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(opaque)) return null;
    const request = await store.findHandoff(await digest(opaque));
    return request && browserMatches(principal, request) ? request : null;
  }
  return {
    origin,
    identity,
    async readPortalContext(opaque: string, principal: AuthenticatedPrincipal) {
      const request = await readOwnedHandoff(opaque, principal);
      return request ? { kind: request.kind, clientId: request.clientId } : null;
    },
    /** Plain secret link that is still usable without a sign-in (unused and unexpired). */
    async readAnonymousSecret(opaque: string) {
      const request = await plainSecretHandoff(opaque);
      return request !== null &&
        request.consumedAt === null &&
        Date.parse(request.expiresAt) > now().getTime()
        ? request
        : null;
    },
    /** A plain secret link that was used or expired; anonymous visitors get the fresh-link page for it. */
    async staleAnonymousSecret(opaque: string) {
      const request = await plainSecretHandoff(opaque);
      return (
        request !== null &&
        (request.consumedAt !== null || Date.parse(request.expiresAt) <= now().getTime())
      );
    },
    /** The link is the capability: the same ensured connection proof and one-use consume as the signed-in path. */
    async approveAnonymousSecret(request: McpPortalHandoff) {
      if (!request.secretTarget || request.secretTarget.nativeProvider) return null;
      if (
        !(await store.ensureConnectionProof(
          request,
          request.secretTarget.projectId,
          now().toISOString(),
        ))
      )
        return null;
      return store.consumeHandoff({
        requestHash: request.requestHash,
        userId: request.userId,
        organizationId: request.organizationId,
        now: now().toISOString(),
        approve: true,
        publish: false,
        ...(request.secretTarget.names ? { submissionId: attemptIds.next() } : {}),
      });
    },
    async startSecret(
      principal: VerifiedWorkosConnectPrincipal,
      organizationId: string,
      target: McpSecretTarget,
    ) {
      return start(principal, organizationId, target);
    },
    async startGithub(
      principal: VerifiedWorkosConnectPrincipal,
      organizationId: string,
      idempotencyKey: string,
    ) {
      if (
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 128 ||
        /\p{Cc}/u.test(idempotencyKey)
      )
        throw new TypeError("Invalid request identity");
      return start(principal, organizationId, null, { idempotencyKey });
    },
    async status(principal: VerifiedWorkosConnectPrincipal, requestHash: string) {
      if (!/^[a-f0-9]{64}$/u.test(requestHash)) throw new TypeError("Invalid request identity");
      const request = await store.findHandoff(requestHash);
      if (!request) throw new McpPortalAccessDenied();
      const selected = await identity(principal, request.organizationId);
      if (!sameIdentity(selected, request)) throw new McpPortalAccessDenied();
      if (request.secretTarget?.nativeProvider) {
        const state = await store.readNativeProviderHandoffState({
          organizationId: request.organizationId,
          userId: request.userId,
          requestHash,
        });
        if (state === null) throw new McpPortalAccessDenied();
        return {
          request_id: requestHash,
          state:
            state === "succeeded"
              ? "secret_submitted"
              : state === "retryable"
                ? request.consumedAt === null
                  ? "pending"
                  : "secret_uncertain"
                : state,
          expires_at: request.expiresAt,
        };
      }
      if (request.secretTarget?.names && request.consumedAt !== null) {
        const { names, results } = request.secretTarget;
        const expired = Date.parse(request.expiresAt) <= now().getTime();
        return {
          request_id: requestHash,
          state: results ? request.outcome : expired ? "secret_uncertain" : "pending",
          expires_at: request.expiresAt,
          ...(results || expired
            ? {
                secrets: names.map((name, index) => ({
                  name,
                  state: results?.[index] ?? "unconfirmed",
                })),
              }
            : {}),
        };
      }
      return {
        request_id: requestHash,
        state:
          request.outcome ??
          (Date.parse(request.expiresAt) <= now().getTime() ? "expired" : "pending"),
        expires_at: request.expiresAt,
      };
    },
    async readPortal(opaque: string, principal: AuthenticatedPrincipal) {
      const request = await readOwnedHandoff(opaque, principal);
      if (request?.secretTarget?.nativeProvider) {
        const state = await store.readNativeProviderHandoffState({
          organizationId: request.organizationId,
          userId: request.userId,
          requestHash: request.requestHash,
        });
        return state === "retryable" ? request : null;
      }
      if (
        !request ||
        request.consumedAt !== null ||
        Date.parse(request.expiresAt) <= now().getTime() ||
        !browserMatches(principal, request)
      )
        return null;
      return request;
    },
    /** A link of this user for a workspace the signed-in portal has not selected. Reading it consumes nothing. */
    async readWorkspaceSwitch(opaque: string, principal: AuthenticatedPrincipal) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(opaque)) return null;
      const request = await store.findHandoff(await digest(opaque));
      if (
        request === null ||
        principal.session?.userId !== request.userId ||
        principal.authorizationPrincipal.kind !== "user" ||
        principal.authorizationPrincipal.subjectId !== `user:${request.userId}` ||
        principal.organizationIds.some((id) => id === request.organizationId)
      )
        return null;
      if (request.secretTarget?.nativeProvider) {
        const state = await store.readNativeProviderHandoffState({
          organizationId: request.organizationId,
          userId: request.userId,
          requestHash: request.requestHash,
        });
        return state === "retryable" ? request : null;
      }
      return request.consumedAt === null && Date.parse(request.expiresAt) > now().getTime()
        ? request
        : null;
    },
    async approvePortal(
      request: McpPortalHandoff,
      principal: AuthenticatedPrincipal,
      approve: boolean,
      secretValue?: string,
    ) {
      if (!browserMatches(principal, request)) return null;
      if (
        approve &&
        !(await store.ensureConnectionProof(
          request,
          request.secretTarget?.projectId ?? null,
          now().toISOString(),
        ))
      )
        return null;
      if (request.secretTarget?.nativeProvider && approve) {
        if (secretValue === undefined || secretValue.length === 0) return null;
        const attemptId = attemptIds.next();
        const claimed = await store.claimNativeProviderHandoff({
          organizationId: request.organizationId,
          userId: request.userId,
          requestHash: request.requestHash,
          attemptId,
          valueSha256: await digest(secretValue),
        });
        if (claimed === null) return null;
        if (
          claimed.requestHash !== request.requestHash ||
          !sameIdentity(claimed, request) ||
          claimed.kind !== "secret" ||
          JSON.stringify(claimed.secretTarget) !== JSON.stringify(request.secretTarget) ||
          JSON.stringify(claimed.authority) !== JSON.stringify(request.authority)
        )
          throw new Error("native_handoff_unavailable");
        return { ...claimed, nativeAttemptId: attemptId };
      }
      return store.consumeHandoff({
        requestHash: request.requestHash,
        userId: request.userId,
        organizationId: request.organizationId,
        now: now().toISOString(),
        approve,
        publish: false,
      });
    },
    async completeSecret(
      requestHash: string,
      outcome: Parameters<McpDelegationStore["completeSecret"]>[1],
    ) {
      await store.completeSecret(requestHash, outcome);
    },
    async completeNativeProvider(input: {
      organizationId: string;
      requestHash: string;
      attemptId: string;
      succeeded: boolean;
    }) {
      return store.completeNativeProviderHandoff(input);
    },
    async completeGithub(requestHash: string, succeeded: boolean) {
      await store.completeGithub(requestHash, succeeded);
    },
    async revoke(principal: VerifiedWorkosConnectPrincipal) {
      return store.revoke(
        {
          userId: principal.connectUser.userId,
          clientId: principal.connectUser.clientId,
          consentHash: await digest(principal.connectUser.consentId),
        },
        now().toISOString(),
      );
    },
  };
}

export type McpPortalAccess = ReturnType<typeof createMcpPortalAccess>;
export class McpPortalAccessDenied extends Error {
  constructor() {
    super("This request is unavailable to the connected account.");
  }
}

export interface McpBrowserIdentity {
  readonly principal: AuthenticatedPrincipal;
  readonly csrf: string;
  readonly headers?: Headers;
}

/** No signed-in identity, but the portal session changed: the 401 page carries these cookie changes. */
export interface McpBrowserSignedOut {
  readonly headers: Headers;
}

export interface McpPortalRequestDependencies {
  readonly access: McpPortalAccess;
  /** Dispatches the one PUT of a consumed plain secret link under its handoff authority only. */
  readonly dispatchHandoff: (request: Request, handoff: McpPortalHandoff) => Promise<Response>;
  /** Reads a plain secret link's project name without the user-authenticated SDK. */
  readonly projects?: {
    getCustomerProject(input: {
      readonly organizationId: string;
      readonly projectId: string;
    }): Promise<{ readonly name: string } | null>;
  };
  /** Per-link request budget; an exhausted key answers 429. */
  readonly limiter?: {
    limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
  readonly resumeAfterLogin?: (url: URL) => Promise<Response | null>;
  /** Opens/revalidates the existing encrypted portal session; never a Connect token. */
  readonly authenticateBrowser: (
    request: Request,
  ) => Promise<McpBrowserIdentity | McpBrowserSignedOut | null>;
  readonly dispatch: (request: Request, principal: AuthenticatedPrincipal) => Promise<Response>;
  readonly withHandoff: (
    principal: AuthenticatedPrincipal,
    authority: McpHandoffAuthority,
  ) => AuthenticatedPrincipal;
}

/** Same-origin, CSRF-protected portal consent and write-only secret entry. */
export async function handleMcpPortalRequest(
  request: Request,
  dependencies: McpPortalRequestDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!["/mcp/secrets", "/mcp/github"].includes(url.pathname)) return null;
  const origin = dependencies.access.origin;
  let pageReturnUrl: string | null = null;
  const page = (
    title: string,
    message: string,
    status: number,
    body = "",
    head = false,
    formRedirectOrigin: string | null = null,
  ) =>
    renderMcpPortalPage(
      title,
      message,
      status,
      body,
      head || request.method === "HEAD",
      new URL(origin).hostname === "dev.app.ohmyho.st",
      pageReturnUrl,
      formRedirectOrigin,
    );
  if (url.origin !== origin || !["GET", "HEAD", "POST"].includes(request.method))
    return page("Ask your agent for a fresh link.", "Link unavailable.", 404);
  if (
    request.method === "POST" &&
    (request.headers.get("origin") !== origin ||
      request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded")
  )
    return page("Ask your agent for a fresh link.", "Your choice was not confirmed.", 403);
  if (url.pathname === "/mcp/secrets") {
    // A plain secret link is its own capability: it is served before any sign-in state is read.
    const parsed = request.method === "POST" ? await readAnonymousForm(request) : url.searchParams;
    const opaque = parsed?.getAll("request").length === 1 ? (parsed.get("request") ?? "") : "";
    const handoff = await dependencies.access.readAnonymousSecret(opaque);
    if (handoff === null && (await dependencies.access.staleAnonymousSecret(opaque)))
      return page("Ask your agent for a fresh link.", "Link unavailable.", 404);
    if (handoff !== null) {
      const anonymousPage = (
        title: string,
        message: string,
        status: number,
        body = "",
        secretEntry = false,
      ) =>
        renderMcpPortalPage(
          title,
          message,
          status,
          body,
          request.method === "HEAD",
          new URL(origin).hostname === "dev.app.ohmyho.st",
          null,
          null,
          "strict-origin",
          secretEntry,
        );
      if (
        dependencies.limiter &&
        !(await dependencies.limiter.limit({ key: `remote-mcp:link:${handoff.requestHash}` }))
          .success
      )
        return anonymousPage("Too many requests.", "Wait a minute and open this link again.", 429);
      const target = handoff.secretTarget;
      if (!target) throw new Error("Missing validated secret target");
      const single = target.names === undefined;
      const fields = (target.names ?? [target.name]).map((name, index) => ({
        name,
        index,
        key: target.names ? `value_${index}` : "value",
      }));
      // One form serves the first page and a rejected value, so the same link can be retried.
      const secretEntryPage = async (status: number, title: string, message: string) => {
        const projectName =
          (
            await dependencies.projects?.getCustomerProject({
              organizationId: handoff.organizationId,
              projectId: target.projectId,
            })
          )?.name ?? null;
        if (projectName === null)
          return anonymousPage(
            "Application unavailable.",
            "Ask your agent to check access and request a fresh link.",
            404,
          );
        const context = single
          ? `<p><strong>${escape(projectName)}</strong> · ${escape(target.environment)}</p>`
          : `<p>Application: <strong>${escape(projectName)}</strong></p><p>Environment: <strong>${escape(target.environment)}</strong></p>`;
        return anonymousPage(
          title,
          message,
          status,
          `<form action="/mcp/secrets" method="post"><input type="hidden" name="request" value="${escape(opaque)}"><div class="mcp-permissions">${context}</div>${fields.map((field) => renderSecretField(field, single && status === 200, single)).join("")}${single ? "" : '<p class="mcp-note">Your agent receives only the configuration status.</p>'}<div class="mcp-actions"><button class="portal-button" type="submit">Save ${fields.length === 1 ? "secret" : "secrets"}</button></div></form><p class="mcp-footnote">This link can be used once and expires in one hour.</p>`,
          true,
        );
      };
      if (request.method !== "POST")
        return secretEntryPage(
          200,
          fields.length === 1 ? "Set an application secret." : "Set application secrets.",
          single
            ? "Enter a value or generate a token."
            : "Enter values here to keep them out of your chat.",
        );
      if (
        parsed === null ||
        parsed.size !== fields.length + 1 ||
        fields.some(({ key }) => parsed.getAll(key).length !== 1)
      )
        return secretEntryPage(400, "Check the form.", "Enter one value for each named field.");
      const entries = fields.map((field) => ({ ...field, value: parsed.get(field.key) ?? "" }));
      const encoder = new TextEncoder();
      if (
        entries.some(
          ({ value }) =>
            value.length === 0 || encoder.encode(value).byteLength > SECRET_VALUE_MAXIMUM_BYTES,
        )
      )
        return secretEntryPage(
          400,
          "Check the values.",
          `Use between 1 and ${SECRET_VALUE_MAXIMUM_BYTES} bytes.`,
        );
      const consumed = await dependencies.access.approveAnonymousSecret(handoff);
      if (!consumed?.authority)
        return anonymousPage("Link unavailable.", "Ask your agent for a fresh link.", 409);
      let writeStatus = 0;
      const client = createClient({
        baseUrl: origin,
        throwOnError: true,
        fetch: async (input, init) => {
          const apiRequest = new Request(input, init),
            visitor = request.headers.get("cf-connecting-ip");
          if (visitor) apiRequest.headers.set("cf-connecting-ip", visitor);
          const response = await dependencies.dispatchHandoff(apiRequest, consumed);
          writeStatus = response.status;
          return response;
        },
      });
      if (target.names) {
        const submissionId = consumed.secretTarget?.submissionId;
        if (!submissionId)
          return anonymousPage("Link unavailable.", "Ask your agent for a fresh link.", 409);
        const results: McpSecretResult[] = [];
        for (const { name, index, value } of entries) {
          writeStatus = 0;
          const result = await putEnvironmentSecret(
            {
              project_id: target.projectId,
              environment_id: target.environmentId,
              secret_name: name,
              "Idempotency-Key": `mcp-secret:${consumed.requestHash}:${index}`,
              putEnvironmentSecretRequest: { value },
            },
            { client, throwOnError: false },
          );
          results.push(
            result ? "saved" : writeStatus >= 400 && writeStatus < 500 ? "failed" : "unconfirmed",
          );
        }
        await dependencies.access.completeSecret(consumed.requestHash, { submissionId, results });
        const saved = results.every((result) => result === "saved");
        const labels = { saved: "Saved", failed: "Not saved", unconfirmed: "Unconfirmed" };
        const rows = entries
          .map(
            ({ name, index }) =>
              `<li><strong>${escape(name)}</strong> … ${labels[results[index] ?? "unconfirmed"]}</li>`,
          )
          .join("");
        return anonymousPage(
          saved ? "Secrets saved." : "Some secrets could not be saved.",
          saved
            ? "Return to your agent."
            : "Ask your agent to check the status and request a fresh link for any outstanding values.",
          saved ? 200 : 503,
          `<ul class="mcp-permissions">${rows}</ul>`,
        );
      }
      try {
        await putEnvironmentSecret(
          {
            project_id: target.projectId,
            environment_id: target.environmentId,
            secret_name: target.name,
            "Idempotency-Key": `mcp-secret:${consumed.requestHash}`,
            putEnvironmentSecretRequest: { value: entries[0]?.value ?? "" },
          },
          { client },
        );
      } catch {
        try {
          await dependencies.access.completeSecret(consumed.requestHash, false);
        } catch {
          /* The 503 page must render even when the completion record is unavailable. */
        }
        return anonymousPage(
          "Secret could not be confirmed.",
          "Ask your agent to check the configuration status and request a fresh link if needed.",
          503,
        );
      }
      // The stored write is recorded outside the failure path, so a failed record never marks a saved secret failed.
      try {
        await dependencies.access.completeSecret(consumed.requestHash, true);
      } catch {
        /* The secret is saved; its status keeps the consumed link's failed outcome until the record lands. */
      }
      return anonymousPage(
        "Secret saved.",
        "Return to your agent. The secret value is never sent to the chat.",
        200,
      );
    }
  }
  const browser = await dependencies.authenticateBrowser(request);
  if (browser === null || !("csrf" in browser)) {
    if (browser === null && request.method === "GET") {
      const resume = await dependencies.resumeAfterLogin?.(url);
      if (resume) return resume;
    }
    const signedOut = page(
      "Sign in to continue.",
      "After signing in, open this link again.",
      401,
      '<div class="mcp-actions"><a class="portal-button" href="/login">Sign in to ohmyho.st</a></div>',
    );
    for (const [name, value] of browser?.headers ?? []) signedOut.headers.append(name, value);
    return signedOut;
  }
  const finish = (response: Response) => {
    for (const [name, value] of browser.headers ?? []) response.headers.append(name, value);
    return response;
  };
  let form: URLSearchParams | null = null;
  if (request.method === "POST") {
    try {
      form = new URLSearchParams(await readBoundedText(new Response(request.body), 200_000));
    } catch {
      return finish(page("Ask your agent for a fresh link.", "Request unavailable.", 400));
    }
    if (
      form.getAll("csrf").length !== 1 ||
      form.get("csrf") !== browser.csrf ||
      form.getAll("request").length !== 1 ||
      form.getAll("approve").length !== 1 ||
      !["yes", "no"].includes(form.get("approve") ?? "")
    )
      return finish(page("Ask your agent for a fresh link.", "Request unavailable.", 403));
  }
  const opaque = form?.get("request") ?? url.searchParams.get("request") ?? "";
  const pending = await dependencies.access.readPortal(opaque, browser.principal);
  const context =
    pending ?? (await dependencies.access.readPortalContext(opaque, browser.principal));
  const matchesPath =
    context !== null &&
    ({ grant: "", secret: "/mcp/secrets", github: "/mcp/github" } as const)[context.kind] ===
      url.pathname;
  let returnUrl: string | null = null;
  if (matchesPath) {
    try {
      if (form && form.getAll("return_url").length > 1)
        throw new TypeError("Duplicate return destination");
      if (
        url.searchParams.getAll("return_url").length > 1 ||
        url.searchParams.getAll("redirectUrl").length > 1
      )
        throw new TypeError("Duplicate return destination");
      const candidates = [
        form?.get("return_url"),
        url.searchParams.get("return_url"),
        url.searchParams.get("redirectUrl"),
      ].filter((value): value is string => value !== null && value !== undefined);
      if (new Set(candidates).size > 1) throw new TypeError("Ambiguous return destination");
      returnUrl = mcpChatReturnUrl(context.clientId, candidates[0]);
      pageReturnUrl = candidates.length === 0 ? null : returnUrl;
    } catch {
      return finish(page("Ask your agent for a fresh link.", "Return link unavailable.", 400));
    }
  }
  let dispatchPrincipal = browser.principal;
  const client = createClient({
    baseUrl: origin,
    throwOnError: true,
    fetch: (input, init) => {
      const apiRequest = new Request(input, init),
        visitor = request.headers.get("cf-connecting-ip");
      if (visitor) apiRequest.headers.set("cf-connecting-ip", visitor);
      return dependencies.dispatch(apiRequest, dispatchPrincipal);
    },
  });
  if (!pending || !matchesPath) {
    // The signed-in portal selected another workspace than this link's. The link is not consumed here;
    // its page offers the switch, and the switch returns to this same link.
    const switchable =
      pending === null && context === null
        ? await dependencies.access.readWorkspaceSwitch(opaque, browser.principal)
        : null;
    let workspace: { id: string; name: string } | undefined;
    if (
      switchable !== null &&
      ({ secret: "/mcp/secrets", github: "/mcp/github" } as const)[switchable.kind] === url.pathname
    ) {
      try {
        workspace = (await getAccountProfile({ client })).organizations.find(
          (item) => item.id === switchable.organizationId,
        );
      } catch {
        workspace = undefined;
      }
    }
    if (switchable === null || workspace === undefined)
      return finish(page("Ask your agent for a fresh link.", "Link unavailable.", 404));
    const back = `${url.pathname}?request=${encodeURIComponent(opaque)}`;
    return finish(
      page(
        "Switch workspace to continue.",
        `Your portal shows a different workspace. This link belongs to ${workspace.name}.`,
        200,
        `<form action="/workspace" method="post"><input type="hidden" name="csrf" value="${escape(browser.csrf)}"><input type="hidden" name="organization" value="${escape(workspace.id)}"><input type="hidden" name="return" value="${escape(back)}"><div class="mcp-actions"><button class="portal-button" type="submit">Switch to ${escape(workspace.name)}</button></div></form><p class="mcp-footnote">The link stays valid until it is used or expires.</p>`,
      ),
    );
  }
  const choices = new Map<string, string>();
  let profile: AccountProfile;
  try {
    profile = await getAccountProfile({ client });
    if (profile.user_id !== pending.userId) throw new Error("Account scope changed");
    for (const projectId of pending.projectIds) {
      if (choices.has(projectId)) continue;
      const project = await getProject({ project_id: projectId }, { client });
      if (project.organization_id !== pending.organizationId)
        throw new Error("Project scope changed");
      choices.set(projectId, project.name);
    }
  } catch {
    return finish(
      page(
        "Application unavailable.",
        "Ask your agent to check access and request a fresh link.",
        404,
      ),
    );
  }
  if (!form) {
    const workspace = profile.organizations.find((item) => item.id === pending.organizationId);
    const identity = `<div class="mcp-identity"><div><span>Account</span><strong>${escape(profile.email)}</strong></div><div><span>Workspace</span><strong>${escape(workspace?.name ?? "Your workspace")}</strong></div></div>`;
    const details = `<details class="mcp-details"><summary>Connection details</summary><div><span>Account ID</span><code>${escape(pending.userId)}</code></div><div><span>Client</span><code>${escape(pending.clientId)}</code></div><div><span>Link expires</span><code>${escape(pending.expiresAt)}</code></div></details>`;
    const hidden = `<input type="hidden" name="csrf" value="${escape(browser.csrf)}"><input type="hidden" name="request" value="${escape(opaque)}">${returnUrl === null ? "" : `<input type="hidden" name="return_url" value="${escape(returnUrl)}">`}`;
    const provider = pending.secretTarget?.nativeProvider;
    const providerDetails =
      provider === undefined
        ? ""
        : `<p>Provider: <strong>${escape(provider.provider)}</strong></p><p>After saving: <strong>${provider.enabled ? "enabled" : "disabled"}</strong></p><p>Configuration revision: <strong>${provider.configurationRevision}</strong></p>${provider.clientId === undefined ? "" : `<p>Client ID: <strong>${escape(provider.clientId)}</strong></p>`}`;
    const controls =
      pending.kind === "secret"
        ? `<div class="mcp-permissions"><p>Application: <strong>${escape(choices.get(pending.secretTarget?.projectId ?? "") ?? "")}</strong></p><p>Environment: <strong>${escape(pending.secretTarget?.environment ?? "")}</strong></p>${providerDetails}</div><label class="mcp-secret">${escape(pending.secretTarget?.name ?? "")}<input type="password" name="value" required maxlength="${SECRET_VALUE_MAXIMUM_BYTES}" autocomplete="new-password"></label><p class="mcp-note">Your agent receives only the configuration status.</p>`
        : '<p class="mcp-note">Continue to GitHub to choose which repositories this workspace can use.</p>';
    return finish(
      page(
        pending.kind === "secret"
          ? provider
            ? "Set a provider secret."
            : "Set an application secret."
          : "Connect GitHub.",
        pending.kind === "secret"
          ? "Enter this value here so it stays out of your chat."
          : "Authorize your repositories directly with GitHub.",
        200,
        `${identity}<form action="${url.pathname}" method="post">${hidden}${controls}<div class="mcp-actions"><button class="portal-button" type="submit" name="approve" value="yes">${pending.kind === "secret" ? "Save secret" : "Continue to GitHub"}</button><button class="portal-button secondary" type="submit" name="approve" value="no" formnovalidate>Cancel</button></div></form>${details}<p class="mcp-footnote">This link can be used once and expires shortly.</p>`,
        request.method === "HEAD",
        pending.kind === "github" ? "https://github.com" : null,
      ),
    );
  }
  const approve = form.get("approve") === "yes";
  const value = form.get("value");
  if (
    pending.kind === "secret" &&
    approve &&
    (form.getAll("value").length !== 1 ||
      value === null ||
      value.length === 0 ||
      new TextEncoder().encode(value).byteLength > SECRET_VALUE_MAXIMUM_BYTES)
  )
    return finish(
      page("Secret was not saved.", `Use between 1 and ${SECRET_VALUE_MAXIMUM_BYTES} bytes.`, 400),
    );
  const consumed = await dependencies.access.approvePortal(
    pending,
    browser.principal,
    approve,
    value ?? undefined,
  );
  if (!consumed) return finish(page("Ask your agent for a fresh link.", "Link unavailable.", 409));
  if (!approve) return finish(page("Access declined.", "Return to your agent.", 200));
  if (!consumed.authority)
    return finish(page("Link unavailable.", "Ask your agent for a fresh link.", 409));
  dispatchPrincipal = dependencies.withHandoff(browser.principal, consumed.authority);
  if (pending.kind === "github") {
    try {
      if (!pending.githubTarget) throw new Error("Missing GitHub target");
      const authorization = await connectGithubOrganization(
        {
          organization_id: pending.organizationId,
          "Idempotency-Key": pending.githubTarget.idempotencyKey,
          connectGithubOrganizationRequest: {},
        },
        { client },
      );
      if (authorization.status === "connected")
        return finish(page("GitHub is connected.", "Return to your chat to continue.", 200));
      if (!authorization.authorization_url) throw new Error("GitHub authorization is unavailable");
      const target = new URL(authorization.authorization_url);
      if (
        target.origin !== "https://github.com" ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error("Invalid GitHub authorization destination");
      return finish(
        new Response(null, {
          status: 303,
          headers: {
            location: target.href,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        }),
      );
    } catch {
      try {
        await dependencies.access.completeGithub(pending.requestHash, false);
      } catch {
        /* The 503 page must render even when the completion record is unavailable. */
      }
      return finish(
        page(
          "GitHub connection could not be confirmed.",
          "Ask your agent to check github_status before requesting a fresh link.",
          503,
        ),
      );
    }
  }
  if (pending.kind === "secret") {
    const target = pending.secretTarget;
    if (!target || value === null) throw new Error("Missing validated secret target");
    const nativeAttemptId = "nativeAttemptId" in consumed ? consumed.nativeAttemptId : undefined;
    if (target.nativeProvider && typeof nativeAttemptId !== "string")
      throw new Error("native_handoff_unavailable");
    try {
      if (target.nativeProvider) {
        await updateNativeAuthProvider(
          {
            project_id: target.projectId,
            environment_id: target.environmentId,
            provider: target.nativeProvider.provider,
            "Idempotency-Key": `mcp-secret:${pending.requestHash}`,
            nativeAuthProviderUpdateWritable: {
              configurationRevision: target.nativeProvider.configurationRevision,
              enabled: target.nativeProvider.enabled,
              ...(target.nativeProvider.clientId === undefined
                ? {}
                : { clientId: target.nativeProvider.clientId }),
              clientSecret: value,
            },
          },
          { client },
        );
      } else {
        await putEnvironmentSecret(
          {
            project_id: target.projectId,
            environment_id: target.environmentId,
            secret_name: target.name,
            "Idempotency-Key": `mcp-secret:${pending.requestHash}`,
            putEnvironmentSecretRequest: { value },
          },
          { client },
        );
      }
      if (target.nativeProvider && nativeAttemptId) {
        const completed = await dependencies.access.completeNativeProvider({
          organizationId: pending.organizationId,
          requestHash: pending.requestHash,
          attemptId: nativeAttemptId,
          succeeded: true,
        });
        if (!completed) throw new Error("native_handoff_unavailable");
      }
    } catch (error) {
      if (target.nativeProvider && nativeAttemptId) {
        try {
          await dependencies.access.completeNativeProvider({
            organizationId: pending.organizationId,
            requestHash: pending.requestHash,
            attemptId: nativeAttemptId,
            succeeded: false,
          });
        } catch {
          /* Leave the lease to expire; never expose private errors. */
        }
        if (
          typeof error === "object" &&
          error !== null &&
          Reflect.get(error, "code") === "idempotency_key_reused"
        ) {
          return finish(
            page(
              "Secret does not match the original request.",
              "Reopen this same link and enter the original secret. No new provider update was made.",
              409,
              `<div class="mcp-actions"><a class="portal-button" href="/mcp/secrets?request=${escape(opaque)}">Retry this request</a></div>`,
            ),
          );
        }
        return finish(
          page(
            "Secret update needs confirmation.",
            "The result is uncertain. Ask your agent to check the request status. Reopen this same link if a retry is needed and enter the same secret; the original request identity will be retained. If it is still processing, wait a minute.",
            503,
            `<div class="mcp-actions"><a class="portal-button" href="/mcp/secrets?request=${escape(opaque)}">Retry this request</a></div>`,
          ),
        );
      }
      try {
        await dependencies.access.completeSecret(pending.requestHash, false);
      } catch {
        /* The 503 page must render even when the completion record is unavailable. */
      }
      return finish(
        page(
          "Secret could not be confirmed.",
          "Ask your agent to check the configuration status and request a fresh link if needed.",
          503,
        ),
      );
    }
    // A plain write is recorded as stored outside the failure path, so a failed record never marks it failed.
    if (!target.nativeProvider) {
      try {
        await dependencies.access.completeSecret(pending.requestHash, true);
      } catch {
        /* The secret is saved; its status keeps the consumed link's failed outcome until the record lands. */
      }
    }
    return finish(
      page(
        "Secret saved.",
        "Return to your agent. The secret value is never sent to the chat.",
        200,
      ),
    );
  }
  return finish(page("Link unavailable.", "Ask your agent for a fresh link.", 404));
}

/** Reads a POST form from a copy, so the signed-in flow still receives the untouched body. */
async function readAnonymousForm(request: Request): Promise<URLSearchParams | null> {
  try {
    return new URLSearchParams(await readBoundedText(new Response(request.clone().body), 200_000));
  } catch {
    return null;
  }
}
function browserMatches(principal: AuthenticatedPrincipal, request: McpPortalHandoff) {
  return (
    principal.session?.userId === request.userId &&
    principal.authorizationPrincipal.kind === "user" &&
    principal.authorizationPrincipal.subjectId === `user:${request.userId}` &&
    principal.organizationIds.some((id) => id === request.organizationId)
  );
}
function sameIdentity(left: McpDelegationIdentity, right: McpDelegationIdentity) {
  return (
    left.userId === right.userId &&
    left.clientId === right.clientId &&
    left.consentHash === right.consentHash &&
    left.organizationId === right.organizationId
  );
}
function encodeToken(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
const DICE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.4" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor"/></svg>';
const EYE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="mcp-slash" d="m4 4 16 16"/></svg>';
function renderSecretField(
  { name, index, key }: { name: string; index: number; key: string },
  autofocus: boolean,
  single: boolean,
) {
  const id = `mcp-secret-${index}`;
  const label = escape(name);
  const dice = `<button class="mcp-icon-button" type="button" data-generate-value aria-label="Generate a random value for ${label}" title="Generate value" hidden>${DICE_ICON}</button>`;
  return `<div class="mcp-secret${single ? " mcp-secret-single" : ""}" data-secret-field>
    <label for="${id}">${label}</label>
    ${single ? '<button class="mcp-secret-generate" type="button" data-generate-value data-copy-generated aria-label="Generate token and copy it" title="Generate and copy a random value." hidden>Generate token</button>' : ""}
    <div class="mcp-secret-row">
      <input data-secret-input id="${id}" type="password" name="${key}" required maxlength="${SECRET_VALUE_MAXIMUM_BYTES}" autocomplete="new-password"${single ? ' autocapitalize="off" spellcheck="false"' : ""}${autofocus ? " autofocus" : ""}>
      ${single ? "" : dice}
      <button class="mcp-icon-button" type="button" data-copy-value aria-label="Copy value for ${label}" title="Copy value" disabled hidden>${PORTAL_COPY_ICON}</button>
      <button class="mcp-icon-button mcp-reveal" type="button" data-reveal-value aria-label="Show value" aria-pressed="false" title="Show or hide value" hidden>${EYE_ICON}</button>
    </div>
    <div class="mcp-copy-status" data-copy-status role="status"></div>
  </div>`;
}
/** Progressive enhancement for the anonymous secret form: the buttons stay hidden without this script. */
export const ANONYMOUS_SECRET_SCRIPT = `// Random values are generated in the browser.
for (const field of document.querySelectorAll("[data-secret-field]")) {
  const input = field.querySelector("[data-secret-input]");
  const generate = field.querySelector("[data-generate-value]");
  const copy = field.querySelector("[data-copy-value]");
  const reveal = field.querySelector("[data-reveal-value]");
  const status = field.querySelector("[data-copy-status]");
  generate.hidden = false;
  copy.hidden = false;
  reveal.hidden = false;
  const updateCopy = () => {
    copy.disabled = input.value.length === 0;
    status.textContent = "";
  };
  input.addEventListener("input", updateCopy);
  updateCopy();
  const setReveal = (shown) => {
    input.type = shown ? "text" : "password";
    reveal.setAttribute("aria-pressed", String(shown));
    reveal.setAttribute("aria-label", shown ? "Hide value" : "Show value");
  };
  const copyValue = async (value) => {
    let message = "Copied.";
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      message = "Could not copy. Show the value to copy it manually.";
    }
    if (input.value === value) status.textContent = message;
  };
  generate.addEventListener("click", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const encoded = btoa(String.fromCharCode(...bytes));
    input.value = encoded.replaceAll("+", "-").replaceAll("/", "_").split("=")[0];
    setReveal(true);
    updateCopy();
    if (generate.hasAttribute("data-copy-generated")) await copyValue(input.value);
  });
  copy.addEventListener("click", async () => {
    if (input.value) await copyValue(input.value);
  });
  reveal.addEventListener("click", () => setReveal(input.type === "password"));
}
`;
/** Pinned to ANONYMOUS_SECRET_SCRIPT; a test recomputes it from the rendered page so the two cannot drift. */
export const ANONYMOUS_SECRET_SCRIPT_HASH = "sha256-UdY7SbooOrWjH31wcWe5BpfSMISdum5bDlBosQ67JLM=";
/** MCP-specific adapter keeps existing callers explicit about their policy. */
export function renderMcpPortalPage(
  title: string,
  message: string,
  status: number,
  body = "",
  head = false,
  development = false,
  agentReturnUrl: string | null = null,
  formRedirectOrigin: string | null = null,
  referrerPolicy: "same-origin" | "no-referrer" | "strict-origin" = "same-origin",
  secretEntry = false,
) {
  return renderStandalonePage({
    title,
    message,
    status,
    body: body || undefined,
    head,
    development,
    agentReturnUrl,
    formRedirectOrigin,
    referrerPolicy,
    helpLink: true,
    ...(secretEntry
      ? { script: { source: ANONYMOUS_SECRET_SCRIPT, hash: ANONYMOUS_SECRET_SCRIPT_HASH } }
      : {}),
  });
}
