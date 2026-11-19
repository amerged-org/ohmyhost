import { type RemoteMcpPersistence } from "./remote-mcp-persistence.js";
import {
  OperationAuthorizationConflictError,
  type McpDelegationIdentity,
} from "@ohmyhost/database";
import {
  parseUlid,
  restrictionAllows,
  intersectAuthorizationRestriction,
  type AuthorizationPort,
  type AuthorizationAction,
  type AuthorizationResource,
  type Clock,
} from "@ohmyhost/platform";
import {
  createWorkosConnectUserAuthenticator,
  type VerifiedWorkosConnectPrincipal,
} from "./workos-authenticator.js";
import type { AuthenticatedPrincipal, BearerAuthenticator } from "./contracts.js";
import type { McpPortalHandoff } from "@ohmyhost/database";
import { createMcpPortalAccess } from "./remote-mcp-access.js";
import { readBoundedText } from "./workos-session-status.js";

/** OAuth metadata comes from the configured AuthKit Connect issuer, never the login-token issuer. */
export async function discoverWorkosConnect(input: {
  readonly issuer: string;
  readonly jwksUrl?: string;
  readonly fetcher: (request: Request) => Promise<Response>;
}) {
  const issuer = new URL(input.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/" ||
    input.issuer.endsWith("/")
  )
    throw new TypeError("Invalid Connect issuer");
  const response = await input.fetcher(
    new Request(`${input.issuer}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    }),
  );
  if (!response.ok) throw new Error("Connect discovery unavailable");
  const raw: unknown = JSON.parse(await readBoundedText(response, 65536));
  if (!record(raw) || raw["issuer"] !== input.issuer)
    throw new TypeError("Connect discovery returned an invalid issuer");
  const oidc = await input.fetcher(
    new Request(`${input.issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    }),
  );
  if (!oidc.ok) throw new Error("Connect OIDC discovery unavailable");
  const configuration: unknown = JSON.parse(await readBoundedText(oidc, 65536));
  if (
    !record(configuration) ||
    configuration["issuer"] !== input.issuer ||
    typeof configuration["jwks_uri"] !== "string"
  )
    throw new TypeError("Connect OIDC discovery returned an invalid issuer");
  const jwks = new URL(configuration["jwks_uri"]);
  if (
    jwks.protocol !== "https:" ||
    jwks.username ||
    jwks.password ||
    jwks.search ||
    jwks.hash ||
    (input.jwksUrl !== undefined && input.jwksUrl !== jwks.href)
  )
    throw new TypeError("Connect JWKS does not match discovery");
  return { issuer: input.issuer, jwksUrl: jwks.href };
}

/** Fresh identity and scoped client consent are intersected inside canonical REST authorization. */
export function createRemoteMcpComposition(input: {
  readonly persistence: RemoteMcpPersistence;
  readonly clock: Clock;
  readonly origin: string;
  readonly issuer: string;
  readonly jwks: { load(): Promise<unknown> };
  readonly authentication: BearerAuthenticator;
  readonly authorization: AuthorizationPort;
  readonly resolveOrganization: (workosId: string) => Promise<ReturnType<typeof parseUlid> | null>;
  readonly dispatch: (request: Request) => Promise<Response>;
}) {
  const persistence = input.persistence;
  const store = persistence.store;
  const access = createMcpPortalAccess({
    store,
    origin: input.origin,
    crypto: globalThis.crypto,
    now: () => input.clock.now(),
    authorize: async (principal, resource, action) => {
      if (
        !principal.organizationIds.includes(resource.organizationId) ||
        !restrictionAllows(principal.authorizationRestriction, resource, action) ||
        (principal.authorizationScopeConstraint !== undefined &&
          !principal.authorizationScopeConstraint.includes(action)) ||
        (await input.authorization.check({
          principal: principal.authorizationPrincipal,
          resource,
          action,
        })) !== "allow"
      )
        return null;
      const identity = await access.identity(principal, resource.organizationId);
      const grant = await store.ensureConnectionProof(
        identity,
        resource.kind === "project" ? resource.projectId : null,
        input.clock.now().toISOString(),
      );
      if (!grant) return null;
      return {
        grantId: grant.grantId,
        clientId: grant.clientId,
        consentHash: grant.consentHash,
        action,
        authorizationRestriction: intersectAuthorizationRestriction(
          principal.authorizationRestriction,
          principal.authorizationScopeConstraint,
        ),
      };
    },
  });
  const requests = new WeakMap<Request, AuthenticatedPrincipal>();
  const tokens = new WeakMap<AuthenticatedPrincipal, { token: string; connect: boolean }>();
  // A plain secret handoff principal has no token: revalidation re-reads its stored handoff instead.
  const handoffs = new WeakMap<AuthenticatedPrincipal, McpPortalHandoff>();
  const connect = createWorkosConnectUserAuthenticator({
    policy: { kind: "connect_user", issuer: input.issuer, audience: `${input.origin}/mcp` },
    verifier: { clock: input.clock, jwks: input.jwks },
    organizations: { resolve: input.resolveOrganization },
  });
  async function authenticate(token: string) {
    const principal = await connect.authenticate(token);
    if (!principal) return null;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(principal.connectUser.consentId),
    );
    const consentHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const membership = await persistence.authorizedMemberships({
      userId: principal.connectUser.userId,
      clientId: principal.connectUser.clientId,
      consentHash,
    });
    let organizationIds = membership.organizationIds.map((id) => parseUlid(id)).sort();
    const restriction = principal.authorizationRestriction;
    if (restriction?.organizationIds)
      organizationIds = organizationIds.filter((id) => restriction.organizationIds?.includes(id));
    // A cap limits its own resource family. Only prune identity workspaces when
    // the action ceiling leaves no unrestricted family or organization action.
    if (restriction?.actions) {
      const projectActions = restriction.actions.filter(
        (action) =>
          action.startsWith("projects:") ||
          action.startsWith("sources:") ||
          action.startsWith("deployments:") ||
          action.startsWith("operations:") ||
          action.startsWith("logs:") ||
          action.startsWith("secrets:"),
      );
      const mailActions = restriction.actions.filter((action) =>
        action.startsWith("mail-domains:"),
      );
      const otherActions = restriction.actions.filter(
        (action) => !projectActions.includes(action) && !mailActions.includes(action),
      );
      if (
        otherActions.length === 0 &&
        (projectActions.length === 0 || restriction.projectIds) &&
        (mailActions.length === 0 || restriction.mailDomainIds)
      ) {
        const projectOrganizations =
          projectActions.length && restriction.projectIds
            ? await Promise.all(
                restriction.projectIds.map((id) => persistence.projectOrganization(id, true)),
              )
            : [];
        const domainOrganizations =
          mailActions.length && restriction.mailDomainIds
            ? await Promise.all(
                restriction.mailDomainIds.map((id) => persistence.mailDomainOrganization(id)),
              )
            : [];
        organizationIds = organizationIds.filter(
          (id) => projectOrganizations.includes(id) || domainOrganizations.includes(id),
        );
      }
    }
    const selectedOrganizationId = principal.organizationIds[0];
    const verified = {
      ...principal,
      organizationIds,
      ...(membership.disconnected ? { connectionDisconnected: true } : {}),
      ...(selectedOrganizationId && organizationIds.includes(selectedOrganizationId)
        ? { selectedOrganizationId }
        : {}),
    };
    tokens.set(verified, { token, connect: true });
    return verified;
  }
  async function revalidate(principal: AuthenticatedPrincipal) {
    const handoff = handoffs.get(principal);
    if (handoff !== undefined) {
      const stored = await store.findHandoff(handoff.requestHash);
      return stored !== null &&
        stored.kind === "secret" &&
        stored.userId === handoff.userId &&
        stored.organizationId === handoff.organizationId &&
        JSON.stringify(stored.authority) === JSON.stringify(handoff.authority)
        ? principal
        : null;
    }
    const saved = tokens.get(principal);
    if (!saved) return null;
    const checked = saved.connect
      ? await authenticate(saved.token)
      : await input.authentication.authenticate(saved.token);
    if (
      !checked ||
      checked.actorId !== principal.actorId ||
      checked.credentialId !== principal.credentialId
    )
      return null;
    const fresh =
      principal.handoffDelegation === undefined
        ? checked
        : { ...checked, handoffDelegation: principal.handoffDelegation };
    tokens.set(fresh, saved);
    return fresh;
  }
  async function delegationIdentity(
    principal: AuthenticatedPrincipal,
    organizationId: string,
  ): Promise<McpDelegationIdentity | null> {
    if (!principal.connectUser) return null;
    return access.identity(principal as VerifiedWorkosConnectPrincipal, organizationId);
  }
  async function remoteAuthorization(
    principal: AuthenticatedPrincipal,
    resource: AuthorizationResource,
    action: AuthorizationAction,
  ) {
    if (!restrictionAllows(principal.authorizationRestriction, resource, action)) return false;
    const identity = await delegationIdentity(principal, resource.organizationId);
    if (!identity) return false;
    // The proof is a revocation fence; canonical authorization decides the action.
    return (
      (await store.ensureConnectionProof(
        identity,
        resource.kind === "project" ? resource.projectId : null,
        input.clock.now().toISOString(),
      )) !== null
    );
  }
  async function dispatch(request: Request, principal: AuthenticatedPrincipal) {
    const url = new URL(request.url);
    if (
      url.origin !== input.origin ||
      !url.pathname.startsWith("/v1/") ||
      request.headers.has("authorization") ||
      request.headers.has("cookie")
    )
      return denied();
    if (principal.connectUser) {
      const operation = /^\/v1\/operations\/([0-7][0-9A-HJKMNP-TV-Z]{25}):reconcile$/u.exec(
        url.pathname,
      )?.[1];
      if (operation && request.method === "POST") {
        // Recovery resumes the accepted command: caller-supplied project/environment labels
        // cannot downgrade its consent, and unrelated command kinds have no remote surface.
        const contexts = await persistence.recoveryContext(
          parseUlid(operation),
          principal.organizationIds,
        );
        const accepted = contexts[0];
        if (!accepted || contexts.length !== 1) return denied();
        // The lookup must resolve one accepted command. Canonical REST recovery
        // determines which command kinds are supported.
        if (accepted.event_type === null) return denied();
        if (accepted.state === "queued" || accepted.state === "running") {
          try {
            await persistence.authorizeExecution({
              organizationId: accepted.organization_id,
              projectId: accepted.project_id,
              operationId: operation,
            });
          } catch (error) {
            if (error instanceof OperationAuthorizationConflictError) return denied();
            throw error;
          }
        }
      }
    }
    requests.set(request, principal);
    let response: Response;
    try {
      response = await input.dispatch(request);
    } finally {
      requests.delete(request);
    }

    return response;
  }

  return {
    access,
    authenticate,
    withHandoff(
      principal: AuthenticatedPrincipal,
      authority: import("@ohmyhost/database").McpHandoffAuthority,
    ) {
      const saved = tokens.get(principal);
      if (!saved || saved.connect || !principal.session)
        throw new Error("Browser identity unavailable");
      const delegated = { ...principal, handoffDelegation: authority };
      tokens.set(delegated, saved);
      return delegated;
    },
    internalAuthentication: {
      resolve: async (request: Request) => requests.get(request) ?? null,
      revalidate,
    },
    remoteAuthorization,
    async remoteMailDomainDelegation(
      principal: AuthenticatedPrincipal,
      organizationId: string,
      mailDomainId: string,
    ) {
      if (
        !restrictionAllows(
          principal.authorizationRestriction,
          {
            kind: "mail_domain",
            organizationId: parseUlid(organizationId),
            mailDomainId: parseUlid(mailDomainId),
          },
          "mail-domains:admin",
        )
      )
        return null;
      const identity = await delegationIdentity(principal, organizationId);
      if (!identity) return null;
      const grant = await store.ensureConnectionProof(
        identity,
        null,
        input.clock.now().toISOString(),
      );
      if (!grant) return null;
      const revision = await persistence.grantRevision(grant.grantId);
      return revision === null
        ? null
        : {
            grantId: grant.grantId,
            clientId: grant.clientId,
            consentHash: grant.consentHash,
            grantRevision: Number(revision),
            authorizationRestriction: intersectAuthorizationRestriction(
              principal.authorizationRestriction,
              principal.authorizationScopeConstraint,
            ),
          };
    },
    async remoteIntegrationDelegation(principal: AuthenticatedPrincipal, organizationId: string) {
      if (
        !restrictionAllows(
          principal.authorizationRestriction,
          { kind: "organization", organizationId: parseUlid(organizationId) },
          "integrations:manage",
        )
      )
        return null;
      const identity = await delegationIdentity(principal, organizationId);
      if (!identity) return null;
      const grant = await store.ensureConnectionProof(
        identity,
        null,
        input.clock.now().toISOString(),
      );
      if (!grant) return null;
      const revision = await persistence.grantRevision(grant.grantId);
      return revision === null
        ? null
        : {
            grantId: grant.grantId,
            clientId: grant.clientId,
            consentHash: grant.consentHash,
            grantRevision: Number(revision),
            authorizationRestriction: intersectAuthorizationRestriction(
              principal.authorizationRestriction,
              principal.authorizationScopeConstraint,
            ),
          };
    },
    async remoteDelegation(principal: AuthenticatedPrincipal, projectId: string) {
      const organizationId = await persistence.projectOrganization(parseUlid(projectId), true);
      if (!organizationId) return null;
      const identity = await delegationIdentity(principal, organizationId);
      const grant = identity
        ? await store.ensureConnectionProof(identity, projectId, input.clock.now().toISOString())
        : null;
      if (!grant) return null;
      const revision = await persistence.grantRevision(grant.grantId);
      return revision !== null
        ? {
            grantId: grant.grantId,
            clientId: grant.clientId,
            consentHash: grant.consentHash,
            grantRevision: Number(revision),
            authorizationRestriction: intersectAuthorizationRestriction(
              principal.authorizationRestriction,
              principal.authorizationScopeConstraint,
            ),
          }
        : null;
    },
    /** Dispatch a PUT for one of the exact names authorized by the consumed plain secret link. */
    async dispatchHandoff(request: Request, handoff: McpPortalHandoff) {
      const target = handoff.secretTarget;
      const authority = handoff.authority;
      const url = new URL(request.url);
      if (
        handoff.kind !== "secret" ||
        !target ||
        target.nativeProvider ||
        (target.names && !target.submissionId) ||
        !authority ||
        authority.action !== "secrets:write" ||
        request.method !== "PUT" ||
        url.search !== "" ||
        !(target.names ?? [target.name]).some(
          (name) =>
            url.pathname ===
            `/v1/projects/${encodeURIComponent(target.projectId)}/environments/${encodeURIComponent(target.environmentId)}/secrets/${encodeURIComponent(name)}`,
        )
      )
        return denied();
      const principal: AuthenticatedPrincipal = {
        actorId: `user:${handoff.userId}`,
        credentialId: `handoff:${handoff.requestHash}`,
        authorizationPrincipal: { kind: "user", subjectId: `user:${handoff.userId}` },
        organizationIds: [parseUlid(handoff.organizationId)],
        selectedOrganizationId: parseUlid(handoff.organizationId),
        authorizationScopeConstraint: [authority.action],
        ...(authority.authorizationRestriction === undefined
          ? {}
          : { authorizationRestriction: authority.authorizationRestriction }),
        handoffDelegation: target.submissionId
          ? {
              ...authority,
              secretSubmission: { requestHash: handoff.requestHash, id: target.submissionId },
            }
          : authority,
      };
      handoffs.set(principal, handoff);
      return dispatch(request, principal);
    },
    async authenticateBrowser(token: string) {
      const principal = await input.authentication.authenticate(token);
      if (!principal?.session) return null;
      tokens.set(principal, { token, connect: false });
      return principal;
    },
    dispatch,
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function denied() {
  return Response.json(
    { code: "forbidden", status: 403 },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
