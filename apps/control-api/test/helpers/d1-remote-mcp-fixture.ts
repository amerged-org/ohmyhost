import { createHash } from "node:crypto";
import { parseUlid } from "@ohmyhost/platform";
import { newUlid } from "../../../control-store/src/catalog/common.js";
import { createControlStore } from "../../../control-store/src/store.js";
import type { TestControl } from "../../../control-store/test/support/control-d1.js";
import { seedProject } from "../../../control-store/test/support/platform-fixtures.js";
import { createD1RemoteMcpPersistence } from "../../src/d1-remote-mcp-persistence.js";
import type { D1RemoteMcpRuntime } from "../../src/d1-remote-mcp-persistence.js";

type Entrypoint = new (context: unknown, environment: unknown) => object;
const encode = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

export const connect = {
  issuer: "https://connect.example.test",
  origin: "https://dev.app.ohmyho.st",
  clientId: "client_chat",
  consentId: "app_consent_connected",
};

/**
 * A seeded organization whose member is connected through signed Connect and WorkOS session tokens. Only the
 * provider boundaries are fakes (discovery and signing keys, the auth-status binding); the Core is the real D1.
 * The caller mocks `cloudflare:workers`, so the Core's private entrypoints are constructed in process.
 */
export async function remoteMcpFixture(
  control: TestControl,
  /** The WorkOS user-management token endpoint, answered only when a test exercises a session refresh. */
  authenticate: (request: Request) => Promise<Response> = async () => {
    throw new Error("Unexpected WorkOS authenticate request");
  },
) {
  const entry = await import("../../../control-store/src/worker-main.js"),
    { createControlApiWorkerEntrypoint } = await import("../../src/worker-main.js"),
    construct = <T>(runtime: unknown) => new (runtime as Entrypoint)({}, control.bindings) as T,
    project = await seedProject(control),
    userId = "user_mcpnative",
    workosJwksUrl = "https://api.workos.com/sso/jwks/client_host",
    workosIssuer = "https://api.workos.com/user_management/client_host",
    workosOrganizationId = String(
      (
        await control.core
          .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
          .bind(project.organizationId)
          .first<{ workos_organization_id: string }>()
      )?.workos_organization_id,
    );
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE organizations SET beta_admitted_at='2026-10-28T10:00:00.000000Z' WHERE organization_id=?",
      )
      .bind(project.organizationId),
    control.core
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'owner','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','event_mcp')",
      )
      .bind(project.organizationId, userId),
    // The member's own authority, which every delegated Connect grant is intersected with.
    control.core
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner','2026-10-28T10:00:00.000000Z')",
      )
      .bind(project.organizationId, newUlid(), `user:${userId}`),
  ]);

  const keys = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair,
    jwks = {
      keys: [
        {
          ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
          kid: "connect-test",
          alg: "RS256",
          use: "sig",
        },
      ],
    },
    header = encode(JSON.stringify({ alg: "RS256", kid: "connect-test", typ: "JWT" })),
    sign = async (claims: Record<string, unknown>) => {
      const body = encode(JSON.stringify(claims));
      return `${header}.${body}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${body}`))))}`;
    },
    seconds = () => Math.floor(Date.now() / 1000),
    /** A Connect user token for the connected chat client. */
    connectToken = (extra: Record<string, unknown> = {}) =>
      sign({
        iss: connect.issuer,
        aud: `${connect.origin}/mcp`,
        sub: userId,
        client_id: connect.clientId,
        sid: connect.consentId,
        scope: "openid",
        iat: seconds(),
        exp: seconds() + 300,
        ...extra,
      }),
    /** The interactive WorkOS session token that a portal cookie carries, issued `age` seconds ago. */
    sessionToken = (age = 0) =>
      sign({
        iss: workosIssuer,
        sub: userId,
        client_id: "client_host",
        org_id: workosOrganizationId,
        sid: "session_mcp",
        iat: seconds() - age,
        exp: seconds() - age + 300,
      }),
    bindings = {
      CONTROL_API_PUBLIC_ORIGIN: connect.origin,
      CONTROL_RUNTIME: construct(entry.ControlRuntime),
      ACCOUNT_METADATA_RUNTIME: construct(entry.AccountMetadataRuntime),
      // The auth-status Service Binding: session liveness, the provider profile and the identity directory.
      AUTH_STATUS: {
        fetch: async (request: Request) => {
          const headers = { "cache-control": "no-store" };
          if (request.url.endsWith("/session-status"))
            return Response.json({ active: true }, { headers });
          if (request.url.endsWith("/user-profile"))
            return Response.json(
              {
                user_id: userId,
                name: "MCP user",
                email: "mcp@example.invalid",
                email_verified: true,
                workos_organization_ids: [workosOrganizationId],
              },
              { headers },
            );
          return Response.json(
            {
              user_id: userId,
              email: "mcp@example.invalid",
              organizations: [{ workos_id: workosOrganizationId, name: "Chat workspace" }],
            },
            { headers },
          );
        },
      },
      CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      OPERATION_PUBLISHER: { wake: async () => undefined },
      WORKOS_JWKS_URL: workosJwksUrl,
      WORKOS_ISSUER: workosIssuer,
      WORKOS_CLIENT_ID: "client_host",
      WORKOS_AUDIENCE: "client_host",
      WORKOS_CONNECT_ISSUER: connect.issuer,
      WORKOS_CONNECT_JWKS_URL: `${connect.issuer}/oauth2/jwks`,
    },
    worker = createControlApiWorkerEntrypoint({
      // The provider boundary: Connect discovery and its signing keys.
      fetcher: async (request) => {
        if (request.url.endsWith("oauth-authorization-server"))
          return Response.json({ issuer: connect.issuer });
        if (request.url.endsWith("openid-configuration"))
          return Response.json({
            issuer: connect.issuer,
            jwks_uri: `${connect.issuer}/oauth2/jwks`,
          });
        if (request.url.endsWith("oauth2/jwks") || request.url === workosJwksUrl)
          return Response.json(jwks);
        if (request.url === "https://api.workos.com/user_management/authenticate")
          return authenticate(request);
        throw new Error("Unexpected discovery request");
      },
    }),
    runtime = bindings.CONTROL_RUNTIME as unknown as D1RemoteMcpRuntime,
    identity = {
      organizationId: project.organizationId,
      userId,
      clientId: connect.clientId,
      consentHash: createHash("sha256").update(connect.consentId).digest("hex"),
    };

  /** One workspace sender domain written the way the Core leaves an active one. */
  async function seedMailDomain(domain = "mail.example.com") {
    const domainId = newUlid();
    await control.core
      .prepare(
        "INSERT INTO workspace_mail_domains(organization_id, domain_id, domain, registrable_domain, custody_organization_id, custody_project_id, custody_environment_id, status, configured_at) VALUES (?1, ?2, ?3, 'example.com', ?1, ?4, ?5, 'active', '2026-10-28T09:00:00.000000Z')",
      )
      .bind(project.organizationId, domainId, domain, project.projectId, project.prodEnvironmentId)
      .run();
    return domainId;
  }

  return {
    project,
    userId,
    identity,
    jwks,
    keys,
    workosIssuer,
    workosOrganizationId,
    sign,
    connectToken,
    sessionToken,
    bindings,
    worker,
    runtime,
    persistence: createD1RemoteMcpPersistence(runtime),
    store: createControlStore(control.bindings),
    organizationId: parseUlid(project.organizationId),
    seedMailDomain,
  };
}
