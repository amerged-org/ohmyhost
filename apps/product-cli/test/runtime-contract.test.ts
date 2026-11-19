import { APPLICATION_ROOT_CONFORMANCE_CORPUS } from "@ohmyhost/contracts";
import { describe, expect, it } from "vitest";

import {
  parseGithubConnectionAuthorization,
  parseGithubOrganizationConnectionStatus,
  parseOrganizationMcpConnectionList,
  parseCloudflareDnsAuthorization,
  parseCloudflareDnsAuthorizationStatus,
  parseDeploymentPlan,
  parseDevAccessTicket,
  parseGuardedActionPlan,
  parseEnvironmentSecret,
  parseEnvironmentSecretDeletion,
  parseEnvironmentSecretPage,
  parseOperation,
  parseProjectCreateAccepted,
  parseOperationEvent,
  parseOrganizationCredits,
  parsePaidDomain,
  parseCurrentIdentity,
  parseProjectPage,
  parseProjectStatus,
  parseProjectSource,
  parseProjectSourceBinding,
  parseProviderReconciliationAttempt,
  parseSafeProblem,
  ResponseContractError,
} from "../src/runtime-contract.js";

const PROBLEM = {
  type: "https://api.ohmyho.st/problems/service-unavailable",
  title: "Service unavailable",
  status: 503,
  code: "service_unavailable",
  request_id: "request-a",
  retryable: false,
  suggested_action: "Visit attacker.example.",
};

const DEPLOYMENT_PLAN = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  project_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
  environment: "dev",
  commit_sha: "a".repeat(40),
  source_digest: `sha256:${"a".repeat(64)}`,
  build_plan_digest: `sha256:${"b".repeat(64)}`,
  application_root: "site",
  runtime: "cloudflare_workers_static_assets",
  route: "https://example.test/p/a",
  resource_effects: [],
  limits: [],
  estimated_cost: {
    amount_micros: "0",
    currency: "USD",
    rate_card_version: "v1",
    credit_micros: "0",
    credits: "0",
    provider_cost_micros: "0",
    reserved_seconds: "840",
    scope: "build_compute",
  },
  risks: [],
  destructive_effects: [],
  required_confirmations: [],
  created_at: "2026-08-18T00:00:00.000Z",
  expires_at: "2026-08-18T00:15:00.000Z",
} as const;

describe("Product CLI response boundary", () => {
  it("bounds the user id of each workspace MCP connection to 256 characters", () => {
    const answer = (userId: string) => ({
      connections: [
        {
          connection_id: "7f3d2c1e-8a4b-4c5d-9e6f-1a2b3c4d5e6f",
          client_id: "https://mcp.example.test/client",
          user_id: userId,
          connected_at: "2026-08-18T00:00:00.000Z",
        },
      ],
    });
    expect(parseOrganizationMcpConnectionList(answer("u".repeat(256))).connections).toHaveLength(1);
    expect(() => parseOrganizationMcpConnectionList(answer(""))).toThrow(
      "The server response does not match the public contract.",
    );
    expect(() => parseOrganizationMcpConnectionList(answer("u".repeat(257)))).toThrow(
      "The server response does not match the public contract.",
    );
  });

  it("accepts a declared domain awaiting deployment only without serving or DNS receipts", () => {
    const waiting = {
      status: "awaiting_deployment",
      suspension_reason: null,
      hostname: "site.customer.example",
      environment: "prod",
      cname_target: "customers.ohmyho.st",
      custom_hostname_status: null,
      ssl_status: null,
      validation_records: [],
      url: null,
    };
    expect(parsePaidDomain(waiting)).toEqual(waiting);
    for (const invalid of [
      { hostname: null },
      { custom_hostname_status: "pending" },
      { ssl_status: "active" },
      { url: "https://site.customer.example" },
      {
        validation_records: [
          {
            type: "CNAME",
            name: waiting.hostname,
            content: waiting.cname_target,
            purpose: "traffic",
          },
        ],
      },
    ]) {
      expect(() => parsePaidDomain({ ...waiting, ...invalid })).toThrow(ResponseContractError);
    }
  });

  it("validates the organization GitHub handoff, account-specific settings and terminal state", () => {
    const connection = {
      connection_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      organization_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      installation_id: "42",
      account_id: "7",
      account_login: "owner",
      account_type: "User",
      github_user_id: "7",
      github_user_login: "owner",
      connected_at: "2026-08-18T00:00:00.000Z",
      revoked_at: null,
      settings_url: "https://github.com/settings/installations/42",
    };
    const authorization = {
      authorization_id: connection.connection_id,
      status: "pending",
      last_failure: null,
      authorization_url: "https://github.com/apps/ohmyhost/installations/new?state=bound",
      expires_at: "2026-08-18T00:30:00.000Z",
      connection: null,
    };
    expect(parseGithubConnectionAuthorization(authorization)).toEqual(authorization);
    const oauth = new URL("https://github.com/login/oauth/authorize");
    oauth.search = new URLSearchParams({
      client_id: "Iv23liExample",
      redirect_uri: "https://app.ohmyho.st/v1/github/oauth/callback",
      state: "bound-state",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    expect(
      parseGithubConnectionAuthorization({ ...authorization, authorization_url: oauth.href }),
    ).toMatchObject({ status: "pending" });
    oauth.searchParams.set("redirect_uri", "https://attacker.example/v1/github/oauth/callback");
    expect(() =>
      parseGithubConnectionAuthorization({ ...authorization, authorization_url: oauth.href }),
    ).toThrow(ResponseContractError);

    expect(
      parseGithubConnectionAuthorization({
        ...authorization,
        authorization_id: null,
        expires_at: null,
        authorization_url: null,
        status: "connected",
        connection,
      }),
    ).toMatchObject({ status: "connected" });
    expect(
      parseGithubOrganizationConnectionStatus({ status: "connected", connection }),
    ).toMatchObject({ connection });
    expect(
      parseGithubOrganizationConnectionStatus({
        status: "revoked",
        connection: {
          ...connection,
          account_type: "Organization",
          revoked_at: connection.connected_at,
          settings_url: "https://github.com/organizations/owner/settings/installations/42",
        },
      }),
    ).toMatchObject({ status: "revoked" });
    for (const authorization_url of [
      "https://evil.example/installations/new?state=bound",
      "https://github.com/apps/ohmyhost/installations/new",
      "https://github.com/apps/ohmyhost/installations/new?state=bound&token=secret",
      "https://github.com/login/oauth/authorize?state=bound",
    ])
      expect(() =>
        parseGithubConnectionAuthorization({ ...authorization, authorization_url }),
      ).toThrow(ResponseContractError);
    for (const invalid of [
      { ...authorization, authorization_id: null },
      { ...authorization, expires_at: "invalid" },
      { ...authorization, status: "connected" },
      { ...authorization, connection },
      { ...authorization, last_failure: "unknown" },
    ])
      expect(() => parseGithubConnectionAuthorization(invalid)).toThrow(ResponseContractError);
    for (const invalid of [
      { status: "not_connected", connection },
      { status: "connected", connection: { ...connection, revoked_at: connection.connected_at } },
      {
        status: "connected",
        connection: { ...connection, settings_url: "https://github.com/settings/installations/43" },
      },
    ])
      expect(() => parseGithubOrganizationConnectionStatus(invalid)).toThrow(ResponseContractError);
  });

  it("accepts dev-access credentials only on the exact custom project origin", () => {
    const ticket = {
      ticket_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      project_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      environment_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      redeem_url: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
      expires_at: "2026-08-18T00:10:00.000Z",
    };
    expect(parseDevAccessTicket(ticket)).toEqual(ticket);
    expect(() =>
      parseDevAccessTicket({
        ...ticket,
        origin: "https://dev-calm-otter-waves.your-omh-account.workers.dev",
        redeem_url: ticket.redeem_url.replace(
          "dev-calm-otter-waves.dev.check.omh.st",
          "dev-calm-otter-waves.your-omh-account.workers.dev",
        ),
      }),
    ).toThrow(ResponseContractError);
  });

  it("accepts only exact credential-free Cloudflare DNS projections", () => {
    const authorization = {
      authorization_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      authorization_url:
        "https://dash.cloudflare.com/oauth2/auth?client_id=client-a&state=opaque-state",
      expires_at: "2026-08-18T00:10:00.000Z",
    };
    const status = {
      status: "authorized",
      zone: "aixyte.com",
      scopes: ["dns.write", "zone.read"],
      expires_at: "2026-08-18T01:00:00.000Z",
    };

    expect(parseCloudflareDnsAuthorization(authorization)).toEqual(authorization);
    expect(parseCloudflareDnsAuthorizationStatus(status)).toEqual(status);
    expect(() =>
      parseCloudflareDnsAuthorization({ ...authorization, access_token: "secret" }),
    ).toThrow(ResponseContractError);
    expect(() =>
      parseCloudflareDnsAuthorization({
        ...authorization,
        authorization_url: "https://attacker.example/oauth2/auth?client_id=x&state=y",
      }),
    ).toThrow(ResponseContractError);
    expect(() =>
      parseCloudflareDnsAuthorizationStatus({ ...status, scopes: ["dns.write"] }),
    ).toThrow(ResponseContractError);
    expect(
      parseCloudflareDnsAuthorizationStatus({
        status: "not_authorized",
        zone: null,
        scopes: [],
        expires_at: null,
      }),
    ).toEqual({
      status: "not_authorized",
      zone: null,
      scopes: [],
      expires_at: null,
    });
    expect(() =>
      parseCloudflareDnsAuthorizationStatus({
        status: "not_authorized",
        zone: "aixyte.com",
        scopes: [],
        expires_at: null,
      }),
    ).toThrow(ResponseContractError);
    expect(() => parseCloudflareDnsAuthorizationStatus({ ...status, zone: null })).toThrow(
      ResponseContractError,
    );
    // The consenting owner lost write authority: the zone is named, and no scope or expiry stays usable.
    expect(
      parseCloudflareDnsAuthorizationStatus({
        status: "reauthorization_required",
        zone: "aixyte.com",
        scopes: [],
        expires_at: null,
      }),
    ).toEqual({
      status: "reauthorization_required",
      zone: "aixyte.com",
      scopes: [],
      expires_at: null,
    });
    expect(() =>
      parseCloudflareDnsAuthorizationStatus({
        status: "reauthorization_required",
        zone: "aixyte.com",
        scopes: ["dns.write", "zone.read"],
        expires_at: null,
      }),
    ).toThrow(ResponseContractError);
  });

  it("requires an exact bounded project handle in project discovery", () => {
    const project = {
      data_mode: "shared" as const,
      region: "eu" as const,
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      organization_id: "00000000000000000000000001",
      name: "alpha",
      handle: "calm-otter-waves",
      created_at: "2026-08-18T00:00:00.000Z",
    } as const;

    expect(parseProjectPage({ items: [project] })).toEqual({ items: [project] });
    expect(() => parseProjectPage({ items: [{ ...project, region: "apac" }] })).toThrow(
      ResponseContractError,
    );
    const missingRegion: Record<string, unknown> = { ...project };
    expect(Reflect.deleteProperty(missingRegion, "region")).toBe(true);
    expect(() => parseProjectPage({ items: [missingRegion] })).toThrow(ResponseContractError);
    expect(parseProjectPage({ items: [{ ...project, handle: "abc" }] })).toEqual({
      items: [{ ...project, handle: "abc" }],
    });
    expect(() => parseProjectPage({ items: [{ ...project, handle: "invalid--handle" }] })).toThrow(
      ResponseContractError,
    );
    const missingHandle: Record<string, unknown> = { ...project };
    expect(Reflect.deleteProperty(missingHandle, "handle")).toBe(true);
    expect(() => parseProjectPage({ items: [missingHandle] })).toThrow(ResponseContractError);
    expect(() =>
      parseProjectPage({ items: [{ ...project, provider_handle: "provider-secret" }] }),
    ).toThrow(ResponseContractError);
  });

  it("accepts only the credit balance, never the meters or prices behind it", () => {
    const balance = {
      organization_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      unit: "microcredits",
      as_of: "2026-10-31T10:00:00.000Z",
      available_micros: "200000000",
      reserved_micros: "0",
      grace_started_at: null,
      grace_expires_at: null,
    };
    expect(parseOrganizationCredits(balance)).toEqual(balance);
    expect(
      parseOrganizationCredits({
        ...balance,
        grace_started_at: "2026-10-31T00:00:00.000Z",
        grace_expires_at: "2026-11-07T00:00:00.000Z",
      }),
    ).toMatchObject({ grace_expires_at: "2026-11-07T00:00:00.000Z" });
    for (const broken of [
      { ...balance, active_meters: ["builds.compute"] },
      { ...balance, rate_cards: [] },
      { ...balance, unit: "credits" },
      { ...balance, available_micros: "-1" },
      { ...balance, grace_started_at: "2026-10-31T00:00:00.000Z" },
    ])
      expect(() => parseOrganizationCredits(broken), JSON.stringify(broken)).toThrow(
        ResponseContractError,
      );
  });

  it("accepts only an exact current-identity response", () => {
    const identity = {
      actor_id: "user:user_01M0SZNP9RJAZ7M0C4TMJC80P2",
      email: "owner@example.test",
      organization_ids: ["00000000000000000000000001"],
      organizations: [{ id: "00000000000000000000000001", name: "Current workspace" }],
    };

    expect(parseCurrentIdentity(identity)).toEqual(identity);
    for (const name of [
      "Team 👩‍💻",
      "Team\u200bName",
      "Team\u2028Name",
      "Team\u2029Name",
      "Team\u0085Name",
      "a".repeat(128),
    ]) {
      const named = { ...identity, organizations: [{ id: identity.organization_ids[0], name }] };
      expect(parseCurrentIdentity(named)).toEqual(named);
    }
    expect(parseCurrentIdentity({ ...identity, email: null })).toEqual({
      ...identity,
      email: null,
    });
    expect(parseCurrentIdentity({ ...identity, organization_ids: [], organizations: [] })).toEqual({
      ...identity,
      organization_ids: [],
      organizations: [],
    });
    for (const invalid of [
      { actor_id: identity.actor_id, organization_ids: identity.organization_ids },
      { ...identity, email: undefined },
      { ...identity, email: "invalid" },
      { ...identity, email: `${"a".repeat(244)}@example.test` },
      { ...identity, email: "owner\u001b@example.test" },
      { ...identity, email: "owner\u200b@example.test" },
      { ...identity, organizations: undefined },
      { ...identity, organizations: [] },
      { ...identity, organizations: [{ id: identity.organization_ids[0], name: "" }] },
      { ...identity, organizations: [{ id: identity.organization_ids[0], name: " Leading" }] },
      { ...identity, organizations: [{ id: identity.organization_ids[0], name: "a".repeat(129) }] },
      { ...identity, organizations: [{ id: identity.organization_ids[0], name: "bad\u001bname" }] },
      { ...identity, organizations: [{ id: identity.organization_ids[0], name: "bad\u007fname" }] },
      { ...identity, organizations: [{ id: "00000000000000000000000002", name: "Other" }] },
      { ...identity, organizations: [{ ...identity.organizations[0], workos_id: "org_hidden" }] },
      {
        ...identity,
        organization_ids: [...identity.organization_ids, "00000000000000000000000002"],
        organizations: [
          { id: "00000000000000000000000002", name: "Other" },
          ...identity.organizations,
        ],
      },
    ]) {
      expect(() => parseCurrentIdentity(invalid)).toThrow(ResponseContractError);
    }
    expect(() => parseCurrentIdentity({ ...identity, provider_user_id: "secret" })).toThrow(
      ResponseContractError,
    );
    expect(() => parseCurrentIdentity({ ...identity, organization_ids: ["invalid"] })).toThrow(
      ResponseContractError,
    );
    expect(() =>
      parseCurrentIdentity({
        ...identity,
        organization_ids: [...identity.organization_ids, ...identity.organization_ids],
      }),
    ).toThrow(ResponseContractError);
  });

  it("accepts complete project status while rejecting source and deployment drift", () => {
    const status = {
      project_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      handle: "calm-otter-waves",
      region: "us",
      dev_access_mode: "protected",
      lifecycle: "active",
      source: {
        provider: "github",
        installation_id: "154436098",
        repository_full_name: "aixyte/maasstudio",
        status: "ready",
        linked_at: "2026-08-18T00:00:00.000Z",
        updated_at: "2026-08-18T00:00:01.000Z",
      },
      default_environment: { id: "01K2F3G4H5J6K7M8N9P0QRSTVX", name: "sandbox" },
      head_deployment: {
        id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
        project_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        operation_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
        commit_sha: "a".repeat(40),
        source_digest: `sha256:${"b".repeat(64)}`,
        build_plan_digest: `sha256:${"c".repeat(64)}`,
        artifact_digest: `sha256:${"d".repeat(64)}`,
        status: "active",
        url: "https://example.test/deployment",
        created_at: "2026-08-18T00:00:02.000Z",
        updated_at: "2026-08-18T00:00:03.000Z",
      },
      dev_url: "https://dev-calm-otter-waves.dev.check.omh.st",
      prod_url: "https://calm-otter-waves.dev.check.omh.st",
      latest_operation: {
        id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
        state: "succeeded",
        created_at: "2026-08-18T00:00:02.000Z",
        updated_at: "2026-08-18T00:00:03.000Z",
      },
      cleanup_state: "not_started",
      etag: `"sha256-${"a".repeat(64)}"`,
    } as const;

    expect(parseProjectStatus(status)).toEqual(status);
    const customDomains = ["awaiting_deployment", "pending", "active", "deleting"].map((state) => ({
      hostname: "app.example.com",
      environment: "prod",
      state,
    }));
    expect(
      parseProjectStatus({ ...status, dev_url: null, custom_domains: customDomains }),
    ).toMatchObject({ dev_url: null, custom_domains: customDomains });
    expect(() =>
      parseProjectStatus({ ...status, custom_domains: Array(65).fill(customDomains[0]) }),
    ).toThrow(ResponseContractError);
    for (const invalid of [
      { hostname: "https://example.com", environment: "prod", state: "active" },
      { hostname: "app.example.com", environment: "dev", state: "active" },
      { hostname: "app.example.com", environment: "prod", state: "unexpected" },
      { hostname: "app.example.com", environment: "prod", state: "active", extra: true },
    ])
      expect(() => parseProjectStatus({ ...status, custom_domains: [invalid] })).toThrow(
        ResponseContractError,
      );
    const binding = {
      ...status.source,
      source_connection_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      source_generation: 1,
    };
    expect(() => parseProjectSource(status.source)).not.toThrow();
    expect(() => parseProjectSourceBinding(binding)).not.toThrow();
    expect(() => parseProjectSource(binding)).toThrow(ResponseContractError);
    expect(() => parseProjectSourceBinding(status.source)).toThrow(ResponseContractError);
    for (const invalid of [
      { source_connection_id: undefined },
      { source_connection_id: "invalid" },
      { source_generation: undefined },
      { source_generation: 0 },
      { source_generation: null },
      { provider_debug: "secret" },
    ])
      expect(() => parseProjectSourceBinding({ ...binding, ...invalid })).toThrow(
        ResponseContractError,
      );
    for (const handle of ["abc", "abcd"])
      expect(
        parseProjectStatus({
          ...status,
          handle,
          head_deployment: null,
          dev_url: null,
          prod_url: null,
        }),
      ).toMatchObject({ handle });
    expect(() => parseProjectStatus({ ...status, etag: undefined })).toThrow(ResponseContractError);
    expect(() => parseProjectStatus({ ...status, etag: 'W/"weak"' })).toThrow(
      ResponseContractError,
    );
    expect(() =>
      parseProjectStatus({ ...status, source: { ...status.source, provider_debug: "secret" } }),
    ).toThrow(ResponseContractError);
    expect(() =>
      parseProjectStatus({
        ...status,
        head_deployment: { ...status.head_deployment, url: "http://example.test" },
      }),
    ).toThrow(ResponseContractError);
    for (const invalid of [
      { region: "apac" },
      { region: undefined },
      { dev_url: "https://calm-otter-waves.dev.check.omh.st" },
      { prod_url: "https://dev-calm-otter-waves.dev.check.omh.st" },
      { dev_url: "https://dev-other-project-handle.dev.check.omh.st" },
      { prod_url: "https://calm-otter-waves.dev.check.omh.st/path" },
      { dev_url: "https://dev-calm-otter-waves.dev.check.omh.st?secret=value" },
      { prod_url: "https://calm-otter-waves.dev.check.omh.st#fragment" },
    ]) {
      expect(() => parseProjectStatus({ ...status, ...invalid })).toThrow(ResponseContractError);
    }
  });

  it("rejects provider debug fields from WP-30 plan and event outputs", () => {
    const deploymentPlan = DEPLOYMENT_PLAN;
    expect(parseDeploymentPlan(deploymentPlan)).toEqual(deploymentPlan);
    expect(
      parseDeploymentPlan({ ...deploymentPlan, runtime: "cloudflare_workers_edge_ssr" }),
    ).toMatchObject({ runtime: "cloudflare_workers_edge_ssr" });
    expect(() => parseDeploymentPlan({ ...deploymentPlan, runtime: "unknown" })).toThrow(
      ResponseContractError,
    );
    expect(() => parseDeploymentPlan({ ...deploymentPlan, application_root: "../site" })).toThrow(
      ResponseContractError,
    );
    expect(() =>
      parseDeploymentPlan({ ...deploymentPlan, application_root: "a/b/c/d/e/f/g/h/i" }),
    ).toThrow(ResponseContractError);
    expect(() => parseDeploymentPlan({ ...deploymentPlan, provider_debug: "secret" })).toThrow(
      ResponseContractError,
    );
    const actionPlan = {
      action: "delete",
      project_id: deploymentPlan.project_id,
      resource_etag: '"etag"',
      effects: [],
      risks: [],
      confirmation_token: "confirmation",
      created_at: deploymentPlan.created_at,
      expires_at: "2026-08-18T00:10:00.000Z",
    };
    expect(parseGuardedActionPlan(actionPlan)).toEqual(actionPlan);
    const promotionPlan = {
      ...actionPlan,
      action: "promote",
      source_deployment_id: deploymentPlan.id,
      source_artifact_digest: `sha256:${"e".repeat(64)}`,
      source_environment: "dev",
      target_environment: "prod",
    };
    expect(parseGuardedActionPlan(promotionPlan)).toEqual(promotionPlan);
    expect(() => parseGuardedActionPlan({ ...promotionPlan, target_environment: "stage" })).toThrow(
      ResponseContractError,
    );
    expect(() => parseGuardedActionPlan({ ...actionPlan, target_artifact_digest: "bad" })).toThrow(
      ResponseContractError,
    );
    const event = {
      event_id: deploymentPlan.id,
      operation_id: deploymentPlan.project_id,
      project_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
      type: "OperationSucceeded",
      occurred_at: deploymentPlan.created_at,
    };
    expect(parseOperationEvent(event)).toEqual(event);
    expect(() => parseOperationEvent({ ...event, provider_debug: "secret" })).toThrow(
      ResponseContractError,
    );
  });

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)(
    "accepts deployment plan application root: $name",
    ({ value }) => {
      expect(parseDeploymentPlan({ ...DEPLOYMENT_PLAN, application_root: value })).toMatchObject({
        application_root: value,
      });
    },
  );

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)(
    "rejects deployment plan application root: $name",
    ({ value }) => {
      expect(() => parseDeploymentPlan({ ...DEPLOYMENT_PLAN, application_root: value })).toThrow(
        ResponseContractError,
      );
    },
  );

  it("preserves bounded server request IDs and rejects control characters", () => {
    expect(parseSafeProblem(PROBLEM)).toMatchObject({ requestId: "request-a" });
    for (const request_id of ["req\nforged", "req\u001b[31m", "req\u007f", "x".repeat(129)]) {
      expect(() => parseSafeProblem({ ...PROBLEM, request_id })).toThrow(ResponseContractError);
    }
  });

  it("keeps the server's bounded field-specific detail as an error message", () => {
    expect(
      parseSafeProblem({
        ...PROBLEM,
        code: "invalid_request",
        status: 400,
        detail: "The receiving webhook must verify the signed test before receiving is enabled.",
      }),
    ).toMatchObject({
      message: "The receiving webhook must verify the signed test before receiving is enabled.",
    });
  });

  it("maps an exact allowlisted problem to repository-owned recovery text", () => {
    expect(
      parseSafeProblem({
        ...PROBLEM,
        code: "rate_limited",
        status: 429,
        retry_after_seconds: 86400,
      }),
    ).toMatchObject({
      retryAfterSeconds: 86400,
      suggestedAction: expect.stringContaining("Retry after 86400 seconds."),
    });
    expect(() =>
      parseSafeProblem({ ...PROBLEM, code: "rate_limited", status: 429, retry_after_seconds: -1 }),
    ).toThrow(ResponseContractError);
    expect(parseSafeProblem(PROBLEM)).toEqual({
      requestId: "request-a",
      code: "service_unavailable",
      retryable: true,
      suggestedAction: expect.stringContaining("same idempotency key"),
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/workers-runtime-incompatible",
        title: "Workers runtime incompatible",
        status: 409,
        code: "workers_runtime_incompatible",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "workers_runtime_incompatible",
      retryable: false,
      suggestedAction: expect.stringContaining(
        "Remove or replace that import, save or push the corrected version, then plan its commit.",
      ),
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/mail-domain-required",
        title: "Mail domain required",
        status: 409,
        code: "mail_domain_required",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "mail_domain_required",
      retryable: false,
      suggestedAction:
        "This app declares mail.enabled. Configure a sender with 'ohmyhost mail setup' or explicitly attach an authorized workspace sender using the project's Prod environment ID. Reuse first requires proof of the intended application hostname with the same registrable main domain; declare and verify that identity before mail-gated deployment. Then plan again.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/storage-jurisdiction-conflict",
        title: "Storage jurisdiction conflict",
        status: 409,
        code: "storage_jurisdiction_conflict",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "storage_jurisdiction_conflict",
      retryable: false,
      suggestedAction:
        "Read 'Storage jurisdiction' in 'ohmyhost project context --project ULID --json' and set storage.jurisdiction in ohmyhost.yaml to that recorded value (us or eu). Existing R2 buckets and reservations keep their jurisdiction after a project-region migration; only new storage without a recorded bucket uses the project region. If context reports unavailable, report the request ID through feedback rather than guessing. Save or push the corrected version and plan its commit; for promotion, deploy it to Dev and promote again. Do not delete or recreate the project to move files.",
    });
    const conversion = {
      ...PROBLEM,
      type: "https://api.ohmyho.st/problems/framework-conversion-required",
      title: "Framework conversion required",
      status: 409,
      code: "framework_conversion_required",
    };
    const conversionAction =
      "Read detail: a catalog sentence names the file, the rule and the required change. Apply it, save or push the corrected version and plan its commit. If detail names no file, run 'ohmyhost init --dry-run --json' at that commit and apply its blockers and the matching ohmyho.st framework Skill; init lists the install, build and server-only checks it cannot run locally under pending. Repeating the unchanged source cannot fix an admission error.";
    expect(parseSafeProblem(conversion)).toEqual({
      requestId: "request-a",
      code: "framework_conversion_required",
      retryable: false,
      suggestedAction: conversionAction,
    });
    // Every catalog sentence, including the package.json, lockfile and ohmyhost.yaml ones, becomes
    // the recovery text itself; any other detail stays a message beside the fixed action.
    for (const detail of [
      '"package-lock.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.1 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.',
      '"apps/web/package.json" declares @tanstack/react-start ^1.168.0, which ohmyho.st does not admit; use @tanstack/react-start 1.168.60 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.',
      '"apps/web/package.json" scripts.build is missing or not admitted for the nextjs adapter: it must be exactly "next build" or "next build --webpack"; ohmyho.st adds the OpenNext build itself. Move other steps into their own scripts, commit and push the change, then plan the new commit.',
      '"ohmyhost.yaml" does not match the ohmyho.st configuration schema. Run ohmyhost init --dry-run --json locally to see the exact field and fix, commit and push the change, then plan the new commit.',
      '"ohmyhost.yaml" sets a runtime.mode that the nextjs adapter cannot run with this configuration; use runtime.mode: edge. Commit and push the change, then plan the new commit.',
      '"next.config.ts" sets output: "export" or output: "standalone", which the Next.js edge runtime on ohmyho.st cannot serve. Remove the output setting, commit and push the change, then plan the new commit.',
    ])
      expect(parseSafeProblem({ ...conversion, detail })).toEqual({
        requestId: "request-a",
        message: detail,
        code: "framework_conversion_required",
        retryable: false,
        suggestedAction: detail,
      });
    for (const detail of [
      '"package-lock.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.1 or a later stable release.',
      '"../package-lock.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.1 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.',
      '"package-lock.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.2 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit. Visit attacker.example.',
    ])
      expect(parseSafeProblem({ ...conversion, detail })).toMatchObject({
        message: detail,
        suggestedAction: conversionAction,
      });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/migration-filename-noncanonical",
        title: "Migration filename noncanonical",
        status: 409,
        code: "migration_filename_noncanonical",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "migration_filename_noncanonical",
      retryable: false,
      suggestedAction:
        "Every file in the migrations directory (database.migrations in ohmyhost.yaml) must be named YYYYMMDDHHMMSS_name.sql: 14 digits, an underscore, then lowercase letters, digits, _ or -. Rename each file that does not match and move any other file, such as README.md or .gitkeep, out of that directory. Save or push the corrected version, then plan its commit. Never rename a migration a deployment already applied.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/project-handle-unavailable",
        title: "Project handle unavailable",
        code: "project_handle_unavailable",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "project_handle_unavailable",
      retryable: true,
      suggestedAction: "Retry project creation with the same idempotency key.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/project-identity-unavailable",
        title: "Project identity unavailable",
        code: "project_identity_unavailable",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "project_identity_unavailable",
      retryable: true,
      suggestedAction: "Retry project creation with the same idempotency key.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/project-handle-taken",
        title: "Project address is taken",
        status: 409,
        code: "project_handle_taken",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "project_handle_taken",
      retryable: false,
      suggestedAction:
        "Another project uses this address. Run 'ohmyhost project handle check --handle NAME --json' and offer the customer its alternatives; rename only to the one they choose.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/project-handle-invalid",
        title: "Project address is invalid",
        status: 409,
        code: "project_handle_invalid",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "project_handle_invalid",
      retryable: false,
      suggestedAction:
        "Choose one to five lowercase words of letters and digits, three to fifty-nine characters, avoiding reserved words.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/project-handle-unchanged",
        title: "Project address is unchanged",
        status: 409,
        code: "project_handle_unchanged",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "project_handle_unchanged",
      retryable: false,
      suggestedAction: "The project already answers on this address; no rename is needed.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/project-rename-blocked",
        title: "Project address change blocked",
        status: 409,
        code: "project_rename_blocked",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "project_rename_blocked",
      retryable: true,
      suggestedAction:
        "Read project status and finish or retry any pending Native Auth deployment or other operation. Once preparation is complete, read the project again and rename with its current ETag.",
    });
    expect(
      parseSafeProblem({
        ...PROBLEM,
        type: "https://api.ohmyho.st/problems/environment-secret-mutation-blocked",
        title: "Environment secret mutation blocked",
        status: 409,
        code: "environment_secret_mutation_blocked",
      }),
    ).toEqual({
      requestId: "request-a",
      code: "environment_secret_mutation_blocked",
      retryable: true,
      suggestedAction:
        "Wait for the active deployment or rollback to finish, then retry unchanged.",
    });
  });

  it.each([
    [{ ...PROBLEM, code: "provider_secret_error" }],
    [{ ...PROBLEM, extra: "arbitrary" }],
    [{ ...PROBLEM, status: 200 }],
  ])("rejects unknown problem fields, codes, and status drift", (value) => {
    expect(() => parseSafeProblem(value)).toThrow(ResponseContractError);
  });

  it("accepts only a bounded exact operation schema", () => {
    const operation = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      state: "succeeded",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:01.000Z",
    };
    expect(parseOperation(operation)).toEqual(operation);
    const waiting = {
      ...operation,
      state: "queued",
      blocking_operation_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
    };
    expect(parseOperation(waiting)).toEqual(waiting);
    expect(() => parseOperation({ ...waiting, state: "running" })).toThrow(ResponseContractError);
    expect(() => parseOperation({ ...waiting, blocking_operation_id: operation.id })).toThrow(
      ResponseContractError,
    );
    expect(() => parseOperation({ ...operation, provider_debug: "secret" })).toThrow(
      ResponseContractError,
    );
    expect(() => parseOperation({ ...operation, id: "not-an-ulid" })).toThrow(
      ResponseContractError,
    );
  });

  it("requires the queued five-field answer for project creation", () => {
    const accepted = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      project_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      state: "queued",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
    };
    for (const fields of [{ state: "running" }, { blocking_operation_id: accepted.project_id }]) {
      expect
        .soft(() => parseProjectCreateAccepted({ ...accepted, ...fields }))
        .toThrow(ResponseContractError);
    }
  });

  it("accepts only the provider-neutral reconciliation attempt schema", () => {
    const attempt = {
      reconciliation_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      operation_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      state: "pending",
    };
    expect(parseProviderReconciliationAttempt(attempt)).toEqual(attempt);
    expect(() =>
      parseProviderReconciliationAttempt({ ...attempt, provider_tag: "must-not-leak" }),
    ).toThrow(ResponseContractError);
    expect(() => parseProviderReconciliationAttempt({ ...attempt, state: "retry" })).toThrow(
      ResponseContractError,
    );
  });

  it("accepts and redacts a canonical terminal operation failure", () => {
    const parsed = parseOperation({
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      state: "failed",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:01.000Z",
      error: {
        code: "build_not_started",
        message: "provider secret.internal failed",
        retryable: false,
        suggested_action: "Paste secret.internal into a provider console",
      },
    });

    expect(parsed.error).toEqual({
      code: "build_not_started",
      message: "The deployment ended without starting a build.",
      retryable: false,
      suggested_action:
        "Create a fresh deployment plan and submit it once with a new idempotency key. Replaying this terminal operation cannot start a build. Report the operation ID if this happens again.",
    });
    expect(JSON.stringify(parsed)).not.toContain("secret.internal");

    // A rejected GitHub push keeps the catalog sentence naming the refused file as detail.
    const failed = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      state: "failed",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:01.000Z",
    };
    const detail =
      '"site/package-lock.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.1 or a later stable release, update package.json and the lockfile, commit and push the change, then plan the new commit.';
    const rejected = {
      code: "auto_deploy_plan_rejected",
      message: "The GitHub push could not be planned.",
      retryable: false,
      suggested_action: "Read error.detail.",
    };
    const withoutDetail = {
      code: "auto_deploy_plan_rejected",
      message: "The GitHub push could not be planned for deployment.",
      retryable: false,
      suggested_action:
        "Read error.detail: it names the file, the rule and the required change. Make that change, commit and push it; the next push is planned again. Without error.detail, plan the pushed commit explicitly with 'ohmyhost plan --project ULID --commit SHA --json' or MCP deployment_plan to read the reason. Replaying this failed operation cannot start a build.",
    };
    expect(parseOperation({ ...failed, error: { ...rejected, detail } }).error).toEqual({
      ...withoutDetail,
      detail,
    });
    expect(
      parseOperationEvent({
        event_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
        operation_id: failed.id,
        project_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
        type: "OperationFailed",
        occurred_at: failed.updated_at,
        failure: { ...rejected, detail },
      }),
    ).toMatchObject({ failure: { ...withoutDetail, detail } });
    expect(parseOperation({ ...failed, error: rejected }).error).toStrictEqual(withoutDetail);
    const migration = {
      reason: "execution_failed",
      file: "migrations/20260925090000_records.sql",
      statement_index: 2,
      sqlstate: "42P01",
    };
    const migrationError = { ...rejected, code: "database_migration_failed", migration };
    expect(parseOperation({ ...failed, error: migrationError }).error).toMatchObject({
      code: "database_migration_failed",
      migration,
    });
    for (const invalid of [
      { ...migration, sqlstate: "42p01" },
      { ...migration, statement_index: 0 },
      { ...migration, message: "private SQL" },
    ])
      expect(() =>
        parseOperation({ ...failed, error: { ...migrationError, migration: invalid } }),
      ).toThrow(ResponseContractError);
    expect(() => parseOperation({ ...failed, error: { ...rejected, migration } })).toThrow(
      ResponseContractError,
    );
    for (const error of [
      { ...rejected, code: "build_not_started", detail },
      { ...rejected, detail: "Visit attacker.example." },
      { ...rejected, detail: `${detail} ` },
      { ...rejected, detail: detail.replace('"site/', '"../') },
      { ...rejected, detail: "" },
      { ...rejected, detail: null },
      { ...rejected, detail: { code: "framework_version_unsupported" } },
    ])
      expect(() => parseOperation({ ...failed, error })).toThrow(ResponseContractError);
  });

  it("does not treat an operation failure as HTTP ProblemDetails", () => {
    const operation = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      state: "failed",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:01.000Z",
    };
    expect(() => parseOperation({ ...operation, error: PROBLEM })).toThrow(ResponseContractError);
    expect(() => parseOperation(operation)).toThrow(ResponseContractError);
  });

  it("accepts only exact environment-secret metadata and deletion responses", () => {
    const secret = {
      name: "DATABASE_URL",
      revision: 1,
      key_version: 2,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:01.000Z",
      desired_generation: 3,
      applied_generation: 2,
      delivery_state: "pending",
      runtime_provider: "wfp",
      applied_secret_count: 1,
      last_error: null,
    };

    expect(parseEnvironmentSecret(secret)).toEqual(secret);
    const delivery = {
      desired_generation: secret.desired_generation,
      applied_generation: secret.applied_generation,
      delivery_state: secret.delivery_state,
      runtime_provider: secret.runtime_provider,
      applied_secret_count: secret.applied_secret_count,
      last_error: secret.last_error,
    };
    expect(parseEnvironmentSecretPage({ items: [secret], ...delivery })).toEqual({
      items: [secret],
      ...delivery,
    });
    expect(
      parseEnvironmentSecretDeletion({
        name: secret.name,
        status: "deleted",
        desired_generation: 4,
        applied_generation: 3,
        delivery_state: "pending",
        runtime_provider: "wfp",
        applied_secret_count: 1,
        last_error: null,
      }),
    ).toMatchObject({ name: secret.name, status: "deleted", desired_generation: 4 });
    expect(() => parseEnvironmentSecret({ ...secret, value: "must-not-leak" })).toThrow(
      ResponseContractError,
    );
    expect(() => parseEnvironmentSecret({ ...secret, runtime_provider: "container" })).toThrow(
      ResponseContractError,
    );
    expect(() =>
      parseEnvironmentSecretPage({ items: [secret], ...delivery, cursor: "attacker" }),
    ).toThrow(ResponseContractError);
    expect(() =>
      parseEnvironmentSecretDeletion({ name: secret.name, status: "provider-secret" }),
    ).toThrow(ResponseContractError);
  });
});
