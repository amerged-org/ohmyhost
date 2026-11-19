import type { WorkosDeviceFlowClient } from "@ohmyhost/workos-auth-contracts/device-flow";
import { describe, expect, it, vi } from "vitest";

import { PROBLEM_POLICY } from "@ohmyhost/contracts/problem-policy";
import type { Deployment } from "@ohmyhost/sdk-ts";

import { createBoundedFetch } from "../src/composition.js";
import { ProductCli, PsqlUnavailableError, readPrivateWebhookCreateRequest } from "../src/cli.js";
import { ResponseContractError, parseProjectStatus } from "../src/runtime-contract.js";
import { GeneratedSdkProductApi, type ProductApi } from "../src/product-api.js";
import type { ProjectLinkMetadata } from "../src/project-link-store.js";

const OPERATION = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  state: "queued" as const,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:00:00.000Z",
};
const TERMINAL = { ...OPERATION, state: "succeeded" as const };
const PROJECT_ID = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const GITHUB_CONNECTION = {
  connection_id: PROJECT_ID,
  organization_id: "00000000000000000000000001",
  installation_id: "42",
  account_id: "7",
  account_login: "owner",
  account_type: "User" as const,
  github_user_id: "7",
  github_user_login: "owner",
  connected_at: OPERATION.created_at,
  revoked_at: null,
  settings_url: "https://github.com/settings/installations/42",
};
const GITHUB_AUTHORIZATION = {
  authorization_id: PROJECT_ID,
  status: "pending" as const,
  last_failure: null,
  authorization_url: "https://github.com/apps/ohmyhost/installations/new?state=opaque-state",
  expires_at: "2026-08-18T00:30:00.000Z",
  connection: null,
};
const DEPLOYMENT_ROUTE = "https://dev-calm-panda-builds.dev.check.omh.st";
const PLAN = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
  project_id: PROJECT_ID,
  environment: "dev" as "dev" | "prod",
  commit_sha: "a".repeat(40),
  source_digest: `sha256:${"a".repeat(64)}`,
  build_plan_digest: `sha256:${"b".repeat(64)}`,
  application_root: "site",
  runtime: "cloudflare_workers_static_assets" as const,
  route: DEPLOYMENT_ROUTE,
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
    scope: "build_compute" as const,
  },
  risks: [],
  destructive_effects: [],
  required_confirmations: [],
  created_at: "2026-08-18T00:00:00.000Z",
  expires_at: "2026-08-18T00:15:00.000Z",
};
const ACTION_PLAN = {
  action: "rollback" as const,
  project_id: PLAN.project_id,
  target_deployment_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
  target_artifact_digest: `sha256:${"d".repeat(64)}`,
  resource_etag: '"etag-a"',
  effects: [],
  risks: [],
  confirmation_token: "confirmation-a",
  created_at: "2026-08-18T00:00:00.000Z",
  expires_at: "2026-08-18T00:10:00.000Z",
};
const TARGET_DEPLOYMENT_ID = "01K2F3G4H5J6K7M8N9P0QRSTVY";
const PROMOTION_PLAN = {
  action: "promote" as const,
  project_id: PLAN.project_id,
  source_deployment_id: TARGET_DEPLOYMENT_ID,
  source_artifact_digest: `sha256:${"e".repeat(64)}`,
  source_environment: "dev" as const,
  target_environment: "prod" as const,
  resource_etag: '"sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
  effects: ["Activate the verified dev artifact in prod without rebuilding."],
  risks: ["Production traffic changes after activation."],
  confirmation_token: "promotion-confirmation-token-1234567890",
  created_at: "2026-08-18T00:00:00.000Z",
  expires_at: "2026-08-18T00:10:00.000Z",
};
const ENVIRONMENT_ID = "01K2F3G4H5J6K7M8N9P0QRSTVZ";
const SECRET = {
  name: "API_KEY",
  revision: 1,
  key_version: 1,
  created_at: "2026-08-18T00:00:00.000Z",
  updated_at: "2026-08-18T00:00:00.000Z",
  desired_generation: 1,
  applied_generation: 1,
  delivery_state: "ready" as const,
  runtime_provider: "wfp" as const,
  applied_secret_count: 1,
  last_error: null,
};
const MAIL_DOMAIN = {
  domain: "mail.example.com",
  status: "configured" as const,
  configured_at: "2026-08-18T00:00:00.000Z",
};
const AUTO_DEPLOY = {
  branch: "main",
  ref: "refs/heads/main",
  environment: "dev" as const,
  enabled: true,
  generation: 1,
  grant_status: "active" as const,
  updated_at: "2026-08-18T00:00:00.000Z",
};
const CLOUDFLARE_AUTHORIZATION = {
  authorization_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
  authorization_url:
    "https://dash.cloudflare.com/oauth2/auth?client_id=client-a&state=opaque-state",
  expires_at: "2026-08-18T00:10:00.000Z",
};
const CLOUDFLARE_DNS_STATUS = {
  status: "authorized" as const,
  zone: "aixyte.com" as const,
  scopes: ["dns.write", "zone.read"] as Array<"dns.write" | "zone.read">,
  expires_at: "2026-08-18T01:00:00.000Z",
};

const paidDomain = (status: "active" | "deleted") => ({
  status,
  hostname: "poc.tenant-fixture.com",
  environment: "prod" as const,
  cname_target: "customers.omh.st" as const,
  custom_hostname_status: "active",
  suspension_reason: null,
  ssl_status: "active",
  validation_records: [
    {
      type: "CNAME" as const,
      name: "poc.tenant-fixture.com",
      content: "customers.omh.st",
      purpose: "traffic" as const,
    },
  ],
  url: status === "active" ? "https://poc.tenant-fixture.com" : null,
});

const FUNCTION_RUN = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  deployment_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
  cron: "*/5 * * * *",
  scheduled_at: "2026-09-15T14:30:00.000Z",
  state: "succeeded" as const,
  attempt: 1,
  status_code: 204,
  started_at: "2026-09-15T14:30:32.306Z",
  finished_at: "2026-09-15T14:30:34.262Z",
};

const DATABASE_PASSWORD = "7".repeat(64);
const DATABASE_ACCESS = Object.freeze({
  provider: "pgcf" as const,
  transport: "wss" as const,
  websocket_url: "wss://pgcf.example.test/",
  access_id: "01M2K0000000000000000000A1",
  environment: "dev" as const,
  mode: "read" as const,
  role_name: "ohmyho_da_01m2k0000000000000000000d1_a1b2c3d4",
  host: "pgcf.example.test",
  database: "dbkx3m9q2w7e5r1t8y4u",
  label: "laptop",
  state: "active" as const,
  issued_at: "2026-09-15T10:00:00.000Z",
  expires_at: "2026-09-15T10:30:00.000Z",
  revoked_at: null,
  revocation_reason: null,
});
const DATABASE_CONNECTION_URI = `postgresql://${DATABASE_ACCESS.role_name}:${DATABASE_PASSWORD}@${DATABASE_ACCESS.host}/${DATABASE_ACCESS.database}?sslmode=require`;
const DATABASE_CREDENTIAL = Object.freeze({
  ...DATABASE_ACCESS,
  connection_uri: DATABASE_CONNECTION_URI,
  psql_command:
    "ohmyhost database psql --project 01M0SZNNXKDDT39A6DYVXASY65 --environment dev --mode read",
});

const createCli = (
  overrides: {
    api?: Partial<ProductApi>;
    writeEvent?: (value: string) => void;
    readSecretValue?: (signal: AbortSignal) => Promise<string>;
    spawnPsql?: NonNullable<ConstructorParameters<typeof ProductCli>[0]["spawnPsql"]>;
    /** Carries the SDK requests that use their own bounded fetch, such as the psql cleanup revoke. */
    revocationFetch?: typeof globalThis.fetch;
    credentialExpiresAt?: string;
    tokenRefresher?: ConstructorParameters<typeof ProductCli>[0]["tokenRefresher"];
  } = {},
) => {
  const links: ProjectLinkMetadata[] = [];
  const api: ProductApi = {
    createProjectExportDownloadLink: async () => {
      throw new Error("Unused export link fixture");
    },
    planProjectDataChange: async () => {
      throw new Error("Unused data change fixture");
    },
    createProjectDataChange: async () => {
      throw new Error("Unused data change fixture");
    },
    getAccountProfile: async () => {
      throw new Error("Unexpected account profile read");
    },
    getBillingRecharge: async () => {
      throw new Error("Unused recharge fixture");
    },
    configureBillingRecharge: async () => {
      throw new Error("Unused recharge fixture");
    },
    changeDatabaseCompute: async () => {
      throw new Error("Unexpected compute mutation");
    },
    createProjectDatabaseAccess: async () => {
      throw new Error("Unexpected database access issuance");
    },
    listProjectDatabaseAccess: async () => {
      throw new Error("Unexpected database access listing");
    },
    revokeProjectDatabaseAccess: async () => {
      throw new Error("Unexpected database access revocation");
    },
    createProjectDatabaseWatch: async () => {
      throw new Error("Unexpected database watch creation");
    },
    listProjectDatabaseWatches: async () => {
      throw new Error("Unexpected database watch listing");
    },
    deleteProjectDatabaseWatch: async () => {
      throw new Error("Unexpected database watch deletion");
    },
    createProjectDatabaseTable: async () => {
      throw new Error("Unexpected database table creation");
    },
    createProjectDatabaseWebhook: async () => {
      throw new Error("Unexpected database webhook creation");
    },
    getDatabaseWebhookSubscription: async () => {
      throw new Error("Unexpected subscription read");
    },
    activateDatabaseWebhookSubscription: async () => {
      throw new Error("Unexpected subscription activation");
    },
    deactivateDatabaseWebhookSubscription: async () => {
      throw new Error("Unexpected subscription deactivation");
    },
    listProjectDatabaseWebhooks: async () => {
      throw new Error("Unexpected database webhook listing");
    },
    getProjectDatabaseWebhook: async () => {
      throw new Error("Unexpected database webhook read");
    },
    deleteProjectDatabaseWebhook: async () => {
      throw new Error("Unexpected database webhook deletion");
    },
    testProjectDatabaseWebhook: async () => {
      throw new Error("Unexpected database webhook test");
    },
    listProjectDatabaseWebhookDeliveries: async () => {
      throw new Error("Unexpected database webhook delivery listing");
    },
    replayProjectDatabaseWebhookDelivery: async () => {
      throw new Error("Unexpected database webhook delivery replay");
    },
    setProjectDatabaseSchedule: async () => {
      throw new Error("Unexpected database schedule set");
    },
    listProjectDatabaseSchedules: async () => {
      throw new Error("Unexpected database schedule listing");
    },
    getProjectDatabaseSchedule: async () => {
      throw new Error("Unexpected database schedule read");
    },
    deleteProjectDatabaseSchedule: async () => {
      throw new Error("Unexpected database schedule deletion");
    },
    listProjectDatabaseScheduleRuns: async () => {
      throw new Error("Unexpected database schedule run listing");
    },
    runProjectDatabaseSchedule: async () => {
      throw new Error("Unexpected database schedule run");
    },
    getProjectDatabaseExecutionUsage: async () => {
      throw new Error("Unexpected database execution usage read");
    },
    getDatabaseCompute: async () => {
      throw new Error("Unused compute fixture");
    },
    getProjectContext: async () => {
      throw new Error("Unused project context fixture");
    },
    setProjectNotes: async () => {
      throw new Error("Unused project notes fixture");
    },
    createUserApiKey: async () => {
      throw new Error("Unused token fixture");
    },
    listUserApiKeys: async () => {
      throw new Error("Unused token fixture");
    },
    revokeUserApiKey: async () => {
      throw new Error("Unused token fixture");
    },
    createProjectExport: async () => {
      throw new Error("Unused export fixture");
    },
    getProjectExport: async () => {
      throw new Error("Unused export fixture");
    },
    submitFeedback: async () => {
      throw new Error("Unused feedback fixture");
    },
    getFeedback: async () => {
      throw new Error("Unused feedback fixture");
    },
    createBillingCheckout: async () => {
      throw new Error("Unused billing fixture");
    },
    getBillingCheckout: async () => {
      throw new Error("Unused billing fixture");
    },
    createBillingPortal: async () => {
      throw new Error("Unused billing fixture");
    },
    getOrganizationCreditUsage: async () => {
      throw new Error("Unused usage fixture");
    },
    getOrganizationAccount: async () => {
      throw new Error("Account adapter not selected by this fixture");
    },
    getOrganizationCredits: async () => {
      throw new Error("Unused credit fixture");
    },
    getProjectCreditBudget: async () => {
      throw new Error("Unused credit fixture");
    },
    setProjectCreditBudget: async () => {
      throw new Error("Unused credit fixture");
    },
    createOrganization: async ({ name }) => ({ id: "00000000000000000000000001", name }),
    getCurrentIdentity: vi.fn(async () => ({
      actor_id: "user:user-a",
      email: "owner@example.test",
      organization_ids: ["00000000000000000000000001"],
      organizations: [{ id: "00000000000000000000000001", name: "Workspace" }],
    })),
    checkProjectHandle: vi.fn(async () => ({
      handle: "quiet-otter-waves",
      available: true,
      alternatives: [],
    })),
    changeProjectHandle: vi.fn(async () => OPERATION),
    listProjects: vi.fn(async () => ({ items: [] })),
    getProjectStatus: vi.fn(async () => ({
      project_id: PROJECT_ID,
      handle: "calm-otter-waves",
      region: "eu" as const,
      dev_access_mode: "protected" as const,
      lifecycle: "active" as const,
      source: {
        provider: "github" as const,
        installation_id: "42",
        repository_full_name: "owner/repo",
        status: "ready" as const,
        linked_at: OPERATION.created_at,
        updated_at: OPERATION.updated_at,
      },
      default_environment: null,
      environments: [
        { id: ENVIRONMENT_ID, name: "dev" },
        { id: TARGET_DEPLOYMENT_ID, name: "prod" },
      ],
      head_deployment: null,
      dev_url: null,
      prod_url: null,
      latest_operation: null,
      cleanup_state: "not_started" as const,
      etag: `"sha256-${"a".repeat(64)}"`,
    })),
    writeProjectDatabase: async () => {
      throw new Error("Unused write fixture");
    },
    queryProjectDatabase: vi.fn(async () => ({
      environment: "dev" as const,
      rows: [{ visits: "1" }],
      row_count: 1,
      truncated: false,
    })),
    planPaidDomain: vi.fn(async () => ({
      status: "planned" as const,
      hostname: "poc.tenant-fixture.com",
      environment: "prod" as const,
      cname_target: "customers.omh.st" as const,
      effects: ["Create custom hostname."],
      risks: ["Traffic becomes public."],
    })),
    applyPaidDomain: vi.fn(async () => paidDomain("active")),
    getPaidDomain: vi.fn(async () => paidDomain("active")),
    deletePaidDomain: vi.fn(async () => paidDomain("deleted")),
    ensureDevShareLink: vi.fn(async () => ({
      project_id: PROJECT_ID,
      mode: "protected" as const,
      share_url: null,
    })),
    rotateDevShareLink: vi.fn(async () => ({
      project_id: PROJECT_ID,
      mode: "protected" as const,
      share_url: null,
    })),
    revokeDevShareLink: vi.fn(async () => ({
      project_id: PROJECT_ID,
      mode: "protected" as const,
      share_url: null,
    })),
    setDevAccessMode: vi.fn(async (_projectId, mode: "protected" | "public") => ({
      project_id: PROJECT_ID,
      mode,
      share_url: null,
    })),
    getOrganizationReferral: vi.fn(async (organizationId: string) => ({
      organization_id: organizationId,
      referral_url: `https://ohmyho.st/?r=ref-${organizationId.toLowerCase()}`,
    })),
    getPoweredByFlag: vi.fn(async () => ({
      project_id: PROJECT_ID,
      enabled: false,
      enabled_at: null,
    })),
    setPoweredByFlag: vi.fn(async (_projectId, enabled: boolean) => ({
      project_id: PROJECT_ID,
      enabled,
      enabled_at: enabled ? "2026-08-18T00:00:00.000Z" : null,
    })),
    createDevAccessTicket: vi.fn(async () => ({
      ticket_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      project_id: PROJECT_ID,
      environment_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      redeem_url: `https://dev-calm-otter-waves.dev.check.omh.st/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
      expires_at: "2026-08-18T00:10:00.000Z",
    })),
    createProject: vi.fn(async () => ({ ...OPERATION, project_id: PROJECT_ID })),
    addProjectDevelopmentEnvironment: vi.fn(async () => OPERATION),
    getOperation: vi.fn(async () => TERMINAL),
    reconcileOperation: vi.fn(async () => ({
      reconciliation_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      operation_id: OPERATION.id,
      state: "pending" as const,
    })),
    connectGithub: vi.fn(async () => GITHUB_AUTHORIZATION),
    getGithubConnection: vi.fn(async () => ({
      status: "connected" as const,
      connection: GITHUB_CONNECTION,
    })),
    disconnectGithub: vi.fn(async () => ({
      status: "revoked" as const,
      connection: { ...GITHUB_CONNECTION, revoked_at: OPERATION.created_at },
    })),
    listOrganizationMcpConnections: vi.fn(async () => ({ connections: [] })),
    revokeOrganizationMcpConnection: vi.fn(async () => ({ state: "revoked" as const })),
    linkSource: vi.fn(async () => OPERATION),
    configureAutoDeploy: vi.fn(async () => AUTO_DEPLOY),
    getAutoDeploy: vi.fn(async () => AUTO_DEPLOY),
    authorizeCloudflareDns: vi.fn(async () => CLOUDFLARE_AUTHORIZATION),
    getCloudflareDnsStatus: vi.fn(async () => CLOUDFLARE_DNS_STATUS),
    applyProjectDomains: vi.fn(async () => OPERATION),
    planDeployment: vi.fn(async () => PLAN),
    createDeployment: vi.fn(async () => OPERATION),
    getDeployment: vi.fn(async () => ({
      id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
      project_id: PROJECT_ID,
      operation_id: OPERATION.id,
      commit_sha: PLAN.commit_sha,
      source_digest: PLAN.source_digest,
      build_plan_digest: PLAN.build_plan_digest,
      status: "active" as const,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:01.000Z",
    })),
    streamOperationEvents: vi.fn(async () =>
      (async function* () {
        yield {
          event_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
          operation_id: OPERATION.id,
          project_id: PLAN.project_id,
          type: "OperationSucceeded" as const,
          occurred_at: "2026-08-18T00:00:01.000Z",
        };
      })(),
    ),
    listDeployments: async () => {
      throw new Error("Unused deployment list fixture");
    },
    getDeploymentLogs: vi.fn(async () => ({
      items: [
        {
          id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
          source: "runtime" as const,
          code: "RUNTIME_FAILED",
          message: "CUSTOMER_RUNTIME_FAILED",
        },
        {
          id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
          source: "build" as const,
          code: "BUILD_FAILED",
          message: "CUSTOMER_BUILD_FAILED",
        },
        {
          id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
          source: "control" as const,
          code: "DEPLOYMENT_FAILED",
          message: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
        },
        {
          id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
          source: "function" as const,
          code: "FUNCTION_FAILED",
          message: "CUSTOMER_FUNCTION_FAILED",
        },
      ].map((item) => ({ ...item, occurred_at: "2026-08-18T00:00:00.000Z" })),
    })),
    planRollback: vi.fn(async () => ACTION_PLAN),
    rollback: vi.fn(async () => OPERATION),
    planPromotion: vi.fn(async () => PROMOTION_PLAN),
    promote: vi.fn(async () => OPERATION),
    planDelete: vi.fn(async () => ({
      ...ACTION_PLAN,
      action: "delete" as const,
      target_deployment_id: undefined,
      target_artifact_digest: undefined,
    })),
    deleteProject: vi.fn(async () => OPERATION),
    listEnvironmentSecrets: vi.fn(async () => ({
      items: [SECRET],
      desired_generation: 1,
      applied_generation: 1,
      delivery_state: "ready" as const,
      runtime_provider: "wfp" as const,
      applied_secret_count: 1,
      last_error: null,
    })),
    listFunctionRuns: vi.fn(async () => ({ items: [FUNCTION_RUN] })),
    putEnvironmentSecret: vi.fn(async () => SECRET),
    deleteEnvironmentSecret: vi.fn(async () => ({
      name: SECRET.name,
      status: "deleted" as const,
      desired_generation: 2,
      applied_generation: 1,
      delivery_state: "pending" as const,
      runtime_provider: "wfp" as const,
      applied_secret_count: 1,
      last_error: null,
    })),
    managedMail: vi.fn(async () => ({ sending: "pending", receiving: "disabled" })),
    ...overrides.api,
  };
  const cli = new ProductCli({
    commandPrefix: "OHMYHOST_ENVIRONMENT=development ohmyhost",
    credentialStore: () => ({
      read: async () => ({
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: overrides.credentialExpiresAt ?? "2026-08-19T00:00:00.000Z",
      }),
      replace: async () => undefined,
      clear: async () => undefined,
    }),
    deviceFlow: {} as WorkosDeviceFlowClient,
    deviceAuthorizationPresenter: { present: async () => undefined },
    productApi: (accessToken, parentSignal) =>
      parentSignal === undefined || overrides.revocationFetch === undefined
        ? api
        : new GeneratedSdkProductApi(
            "https://control.example.test",
            accessToken,
            createBoundedFetch(overrides.revocationFetch, parentSignal, 1_000, 100_000),
          ),
    accountProfile: async () => await api.getAccountProfile(),
    projectLinkStore: {
      save: async (metadata) => {
        links.push(metadata);
      },
    },
    productApiOrigin: "https://control.example.test",
    tokenRevoker: { revoke: async () => undefined },
    tokenRefresher: overrides.tokenRefresher ?? {
      refresh: async () => {
        throw new Error("not expected");
      },
    },
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    waitUntil: async () => undefined,
    lifecycleTimeoutMs: 1_000,
    createCorrelationId: () => "correlation-a",
    diagnosticSink: { record: () => undefined },
    operationEventSink: { write: overrides.writeEvent ?? (() => undefined) },
    readSecretValue: overrides.readSecretValue ?? (async () => "postgres://private"),
    ...(overrides.spawnPsql === undefined ? {} : { spawnPsql: overrides.spawnPsql }),
  });
  return { cli, api, links };
};

describe("WP-30 product commands", () => {
  it("lists project deployments, including rolled-back ones, and reads a deployment by id", async () => {
    const rolledBack: Deployment = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
      project_id: PROJECT_ID,
      operation_id: OPERATION.id,
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"b".repeat(64)}`,
      build_plan_digest: `sha256:${"c".repeat(64)}`,
      status: "rolled_back",
      created_at: OPERATION.created_at,
      updated_at: OPERATION.updated_at,
    };
    const active: Deployment = {
      ...rolledBack,
      id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
      status: "active",
    };
    const { cli, api } = createCli({
      api: {
        listDeployments: vi.fn(async () => ({ items: [active, rolledBack], next_cursor: "C2" })),
        getDeployment: vi.fn(async () => rolledBack),
      },
    });

    const listed = await cli.run(["deployment", "list", "--project", PROJECT_ID, "--limit", "2"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      command: "deployment list",
      items: [
        { id: active.id, status: "active" },
        { id: rolledBack.id, status: "rolled_back" },
      ],
      next_cursor: "C2",
    });
    expect(api.listDeployments).toHaveBeenCalledWith({ projectId: PROJECT_ID, limit: 2 });

    const read = await cli.run([
      "deployment",
      "get",
      "--project",
      PROJECT_ID,
      "--deployment",
      rolledBack.id,
    ]);
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      command: "deployment get",
      deployment: { id: rolledBack.id, status: "rolled_back" },
    });
    expect(api.getDeployment).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      deploymentId: rolledBack.id,
    });
  });

  it("returns the next page cursor of deployment logs and reads an older page with --cursor", async () => {
    const getDeploymentLogs = vi.fn(async () => ({ items: [], next_cursor: "C1" }));
    const { cli } = createCli({ api: { getDeploymentLogs } });
    const first = await cli.run([
      "deployment",
      "logs",
      "--project",
      PROJECT_ID,
      "--deployment",
      OPERATION.id,
    ]);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      command: "deployment logs",
      next_cursor: "C1",
    });
    const older = await cli.run([
      "deployment",
      "logs",
      "--project",
      PROJECT_ID,
      "--deployment",
      OPERATION.id,
      "--cursor",
      "C1",
    ]);
    expect(older.exitCode).toBe(0);
    expect(getDeploymentLogs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "C1" }));
  });

  it("reports a local file error as local state, not as an outdated client", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied, open '/tmp/psql-state'"), {
      code: "EACCES",
      errno: -13,
      syscall: "open",
    });
    const { cli } = createCli({
      api: { createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL) },
      spawnPsql: async () => {
        throw denied;
      },
    });
    const result = await cli.run([
      "database",
      "psql",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--mode",
      "write",
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "local_state_unavailable" },
    });
  });

  it("refuses a deployment record that carries a field the contract does not define", async () => {
    const record = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
      project_id: PROJECT_ID,
      operation_id: OPERATION.id,
      commit_sha: "a".repeat(40),
      source_digest: `sha256:${"b".repeat(64)}`,
      build_plan_digest: `sha256:${"c".repeat(64)}`,
      status: "active" as const,
      created_at: OPERATION.created_at,
      updated_at: OPERATION.updated_at,
      internal_note: "not part of the contract",
    };
    const { cli } = createCli({
      api: {
        listDeployments: vi.fn(async () => ({ items: [record], next_cursor: null })),
        getDeployment: vi.fn(async () => record),
      },
    });
    for (const argv of [
      ["deployment", "list", "--project", PROJECT_ID, "--json"],
      ["deployment", "get", "--project", PROJECT_ID, "--deployment", record.id, "--json"],
    ]) {
      const result = await cli.run(argv);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: "response_contract_invalid" },
      });
    }
  });

  it("reports only a failed local file as local state, never a network error", async () => {
    const reportsLocalState = async (failure: Error) => {
      const { cli } = createCli({
        api: { createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL) },
        spawnPsql: async () => {
          throw failure;
        },
      });
      const result = await cli.run([
        "database",
        "psql",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--mode",
        "write",
      ]);
      return (
        (JSON.parse(result.stdout) as { error?: { code?: string } }).error?.code ===
        "local_state_unavailable"
      );
    };
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EADDRINUSE"]) {
      expect(await reportsLocalState(Object.assign(new Error(code), { code }))).toBe(false);
    }
    // ENOENT describes local state only when it names the path that is missing.
    expect(await reportsLocalState(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))).toBe(
      false,
    );
    expect(
      await reportsLocalState(
        Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/tmp/psql-state" }),
      ),
    ).toBe(true);
  });

  it("streams normalized deployment diagnostics through the SDK", async () => {
    const writes: string[] = [];
    const { cli, api } = createCli({ writeEvent: (value) => writes.push(value) });
    const result = await cli.run([
      "deployment",
      "logs",
      "--project",
      PROJECT_ID,
      "--deployment",
      TARGET_DEPLOYMENT_ID,
    ]);
    expect(result.exitCode).toBe(0);
    expect(api.getDeploymentLogs).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      deploymentId: TARGET_DEPLOYMENT_ID,
      limit: 100,
    });
    for (const message of [
      "CUSTOMER_RUNTIME_FAILED",
      "CUSTOMER_BUILD_FAILED",
      "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
      "CUSTOMER_FUNCTION_FAILED",
    ])
      expect(writes.join("")).toContain(message);
  });
  it("answers a missing deployment or operation at once instead of retrying its stream", async () => {
    // An unknown, foreign or deployment ULID made the SSE client retry a 404 forever, silently.
    const notFound = {
      type: "https://docs.ohmyho.st/errors/resource-not-found",
      title: "Resource not found",
      status: 404,
      code: "resource_not_found",
      request_id: "request-missing",
      retryable: false,
      suggested_action: "Resource not found.",
    };
    const { cli, api } = createCli({
      api: {
        getOperation: vi.fn(async () => {
          throw notFound;
        }),
        getDeploymentLogs: vi.fn(async () => {
          throw notFound;
        }),
      },
    });
    for (const argv of [
      ["logs", OPERATION.id, "--follow", "--json"],
      [
        "deployment",
        "logs",
        "--project",
        PROJECT_ID,
        "--deployment",
        TARGET_DEPLOYMENT_ID,
        "--json",
      ],
    ]) {
      const result = await cli.run(argv);
      expect(result.exitCode).toBe(7);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "error",
        error: { code: "resource_not_found", request_id: "request-missing" },
      });
    }
    expect(api.streamOperationEvents).not.toHaveBeenCalled();
  });

  it("resumes an operation stream after its last event and never calls a running operation completed", async () => {
    const started = {
      event_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
      operation_id: OPERATION.id,
      project_id: PLAN.project_id,
      type: "OperationStarted" as const,
      occurred_at: "2026-08-18T00:00:01.000Z",
    };
    const running = { ...OPERATION, state: "running" as const };
    // The server closes the stream silently, for example when an interactive sign-in expires.
    const streamOperationEvents = vi.fn(async () =>
      (async function* () {
        yield started;
      })(),
    );
    const writes: string[] = [];
    const { cli, api } = createCli({
      api: { getOperation: vi.fn(async () => running), streamOperationEvents },
      writeEvent: (value) => writes.push(value),
    });

    const ended = await cli.run(["logs", OPERATION.id, "--follow", "--json"]);

    expect(ended.exitCode).toBe(8);
    expect(JSON.parse(ended.stdout)).toEqual({
      version: 1,
      command: "logs",
      status: "error",
      operation_id: OPERATION.id,
      error: {
        code: "operation_stream_ended",
        retryable: true,
        suggested_action: `The event stream ended before operation ${OPERATION.id} finished, and it is still running; nothing was cancelled. Poll 'ohmyhost operation get ${OPERATION.id} --json' about every 60 seconds until it is succeeded, failed or cancelled.`,
      },
    });
    // One stream and three bounded reconnects, each resuming after the last delivered event.
    expect(streamOperationEvents).toHaveBeenCalledTimes(4);
    expect(streamOperationEvents).toHaveBeenNthCalledWith(1, OPERATION.id, expect.any(AbortSignal));
    expect(streamOperationEvents).toHaveBeenLastCalledWith(
      OPERATION.id,
      expect.any(AbortSignal),
      started.event_id,
    );
    expect(writes).toHaveLength(4);

    // An operation that finished while its stream was closed answers with its own state.
    const failed = {
      ...OPERATION,
      state: "failed" as const,
      error: {
        code: "operation_failed" as const,
        message: "The operation failed.",
        retryable: false as const,
        suggested_action: "Read the deployment logs.",
      },
    };
    vi.mocked(api.getOperation).mockResolvedValueOnce(running).mockResolvedValueOnce(failed);
    const finished = await cli.run(["logs", OPERATION.id, "--follow", "--json"]);
    expect(finished.exitCode).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({
      command: "logs",
      status: "completed",
      event_count: 1,
      operation: { id: OPERATION.id, state: "failed" },
    });
  });

  it("returns the new project id of an accepted project create, so a retry can be matched to it", async () => {
    const { cli } = createCli({
      api: { createProject: vi.fn(async () => ({ ...OPERATION, project_id: PROJECT_ID })) },
    });
    const result = await cli.run([
      "project",
      "create",
      "--organization",
      "00000000000000000000000001",
      "--name",
      "alpha",
      "--idempotency-key",
      "create-alpha",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "project create",
      status: "accepted",
      project_id: PROJECT_ID,
      operation: { id: OPERATION.id },
    });
  });

  it("creates a project in the chosen hosting region through the SDK boundary", async () => {
    const { cli, api } = createCli();
    const result = await cli.run([
      "project",
      "create",
      "--organization",
      "00000000000000000000000001",
      "--name",
      "alpha",
      "--region",
      "eu",
      "--include-development-environment",
      "false",
      "--idempotency-key",
      "create-eu",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "project create",
      status: "accepted",
    });
    expect(api.createProject).toHaveBeenCalledWith({
      organizationId: "00000000000000000000000001",
      name: "alpha",
      region: "eu",
      includeDevelopmentEnvironment: false,
      idempotencyKey: "create-eu",
    });
    const add = vi.fn(async () => OPERATION);
    const next = createCli({ api: { addProjectDevelopmentEnvironment: add } });
    const added = await next.cli.run([
      "project",
      "dev",
      "add",
      "--project",
      PROJECT_ID,
      "--idempotency-key",
      "add-dev",
      "--json",
    ]);
    expect(JSON.parse(added.stdout)).toMatchObject({
      command: "project dev add",
      status: "accepted",
      operation: { id: OPERATION.id },
    });
    expect(add).toHaveBeenCalledWith({ projectId: PROJECT_ID, idempotencyKey: "add-dev" });
    const rejected = await cli.run([
      "project",
      "create",
      "--organization",
      "00000000000000000000000001",
      "--name",
      "alpha",
      "--include-development-environment",
      "maybe",
      "--idempotency-key",
      "bad",
      "--json",
    ]);
    expect(rejected.exitCode).not.toBe(0);
    expect(api.createProject).toHaveBeenCalledTimes(1);
  });

  it("accepts a rename and returns the operation that moves the address", async () => {
    const { cli, api } = createCli({ api: { changeProjectHandle: vi.fn(async () => OPERATION) } });

    const result = await cli.run([
      "project",
      "handle",
      "set",
      "--project",
      PROJECT_ID,
      "--handle",
      "acme-shop",
      "--if-match",
      '"7"',
      "--idempotency-key",
      "rename-a",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "project handle set",
      status: "accepted",
      operation: { id: OPERATION.id, state: "queued" },
    });
    expect(api.changeProjectHandle).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      handle: "acme-shop",
      ifMatch: '"7"',
      idempotencyKey: "rename-a",
    });
  });

  it("reports a taken project handle with free alternatives", async () => {
    const { cli, api } = createCli({
      api: {
        checkProjectHandle: vi.fn(async () => ({
          handle: "calm-otter-waves",
          available: false,
          reason: "taken" as const,
          alternatives: ["calm-otter-waves-2", "calm-otter-waves-3"],
        })),
      },
    });

    const result = await cli.run([
      "project",
      "handle",
      "check",
      "--handle",
      "calm-otter-waves",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "project handle check",
      status: "succeeded",
      handle: {
        handle: "calm-otter-waves",
        available: false,
        reason: "taken",
        alternatives: ["calm-otter-waves-2", "calm-otter-waves-3"],
      },
    });
    expect(api.checkProjectHandle).toHaveBeenCalledWith({ handle: "calm-otter-waves" });
  });

  it("lists customer projects and reads complete project status through the SDK boundary", async () => {
    const { cli, api } = createCli({
      api: {
        listProjects: vi.fn(async () => ({
          items: [
            {
              id: PROJECT_ID,
              organization_id: "00000000000000000000000001",
              name: "alpha",
              handle: "calm-otter-waves",
              data_mode: "shared" as const,
              region: "eu" as const,
              created_at: "2026-08-18T00:00:00.000Z",
            },
          ],
        })),
      },
    });

    const list = await cli.run(["project", "list", "--limit", "25", "--json"]);
    const status = await cli.run(["project", "status", "--project", PROJECT_ID, "--json"]);

    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      command: "project list",
      status: "succeeded",
      projects: {
        items: [{ id: PROJECT_ID, name: "alpha", handle: "calm-otter-waves", region: "eu" }],
      },
    });
    expect(api.listProjects).toHaveBeenCalledWith({ limit: 25 });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "project status",
      status: "succeeded",
      project: {
        project_id: PROJECT_ID,
        handle: "calm-otter-waves",
        region: "eu",
        lifecycle: "active",
        dev_url: null,
        prod_url: null,
      },
    });
    expect(api.getProjectStatus).toHaveBeenCalledWith(PROJECT_ID);
    expect(JSON.parse(status.stdout).project.environments).toEqual([
      { id: ENVIRONMENT_ID, name: "dev" },
      { id: TARGET_DEPLOYMENT_ID, name: "prod" },
    ]);
    expect(() =>
      parseProjectStatus({
        ...JSON.parse(status.stdout).project,
        environments: [
          { id: ENVIRONMENT_ID, name: "dev" },
          { id: ENVIRONMENT_ID, name: "prod" },
        ],
      }),
    ).toThrow();
  });

  it("queries the Dev database through the generated SDK and rejects write statements locally", async () => {
    const { cli, api } = createCli();
    const result = await cli.run([
      "database",
      "query",
      "--environment",
      "dev",
      "--project",
      PROJECT_ID,
      "--statement",
      "SELECT count(*)::text visits FROM visits WHERE email=$1",
      "--parameters-json",
      '["your-omh-account+maas-poc-20260904@gmail.com"]',
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "database query",
      status: "succeeded",
      result: {
        environment: "dev",
        rows: [{ visits: "1" }],
        row_count: 1,
        truncated: false,
      },
    });
    expect(api.queryProjectDatabase).toHaveBeenCalledWith({
      environment: "dev",
      projectId: PROJECT_ID,
      statement: "SELECT count(*)::text visits FROM visits WHERE email=$1",
      parameters: ["your-omh-account+maas-poc-20260904@gmail.com"],
    });

    const rejected = await cli.run([
      "database",
      "query",
      "--environment",
      "dev",
      "--project",
      PROJECT_ID,
      "--statement",
      "DELETE FROM visits",
      "--json",
    ]);
    expect(rejected.exitCode).not.toBe(0);
    expect(api.queryProjectDatabase).toHaveBeenCalledOnce();
  });

  it("runs the complete Paid domain plan, apply, status and delete lifecycle", async () => {
    const { cli, api } = createCli();
    const plan = await cli.run([
      "domain",
      "paid",
      "plan",
      "--project",
      PROJECT_ID,
      "--hostname",
      "poc.tenant-fixture.com",
      "--json",
    ]);
    const apply = await cli.run([
      "domain",
      "paid",
      "apply",
      "--project",
      PROJECT_ID,
      "--hostname",
      "poc.tenant-fixture.com",
      "--idempotency-key",
      "paid-apply-1",
      "--yes",
      "--json",
    ]);
    const status = await cli.run(["domain", "paid", "status", "--project", PROJECT_ID, "--json"]);
    const deleted = await cli.run([
      "domain",
      "paid",
      "delete",
      "--project",
      PROJECT_ID,
      "--hostname",
      "poc.tenant-fixture.com",
      "--idempotency-key",
      "paid-delete-1",
      "--yes",
      "--json",
    ]);
    expect([plan, apply, status, deleted].map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0]);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      command: "domain paid plan",
      plan: { hostname: "poc.tenant-fixture.com", cname_target: "customers.omh.st" },
    });
    expect(JSON.parse(apply.stdout)).toMatchObject({
      command: "domain paid apply",
      status: "active",
    });
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "domain paid status",
      status: "active",
    });
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      command: "domain paid delete",
      status: "deleted",
    });
    expect(api.applyPaidDomain).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      hostname: "poc.tenant-fixture.com",
      idempotencyKey: "paid-apply-1",
    });
  });

  it("starts an explicitly acknowledged provider reconciliation attempt", async () => {
    const { cli, api } = createCli();
    const result = await cli.run([
      "operation",
      "reconcile",
      OPERATION.id,
      "--idempotency-key",
      "reconcile-a",
      "--yes",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(api.reconcileOperation).toHaveBeenCalledWith({
      operationId: OPERATION.id,
      idempotencyKey: "reconcile-a",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      command: "operation reconcile",
      status: "accepted",
      reconciliation: { operation_id: OPERATION.id, state: "pending" },
    });
  });

  it("passes the idempotency key of a retried database event to the API, and none when the flag is absent", async () => {
    const { cli, api } = createCli({
      api: {
        deleteProjectDatabaseWebhook: vi.fn(async () => ({
          id: "whk_abcdefghijklmnopqrst",
          deleted: true as const,
        })),
        runProjectDatabaseSchedule: vi.fn(async () => ({
          schedule: "nightly",
          state: "queued" as const,
        })),
      },
    });
    const deleted = await cli.run([
      "database",
      "webhook",
      "delete",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--webhook",
      "whk_abcdefghijklmnopqrst",
      "--idempotency-key",
      "delete-key-1",
      "--yes",
      "--json",
    ]);
    expect(deleted.exitCode).toBe(0);
    expect(api.deleteProjectDatabaseWebhook).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      environment: "dev",
      webhookId: "whk_abcdefghijklmnopqrst",
      idempotencyKey: "delete-key-1",
    });
    const run = await cli.run([
      "database",
      "schedule",
      "run",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--name",
      "nightly",
      "--yes",
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const runInput = vi.mocked(api.runProjectDatabaseSchedule).mock.calls.at(-1)?.[0];
    expect(runInput).toEqual({ projectId: PROJECT_ID, environment: "dev", name: "nightly" });
    expect(runInput).not.toHaveProperty("idempotencyKey");
  });

  it("creates one no-store dev access URL through the generated customer API", async () => {
    const { cli, api } = createCli();
    const result = await cli.run([
      "project",
      "dev-access",
      "create",
      "--project",
      PROJECT_ID,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "project dev-access create",
      status: "succeeded",
      ticket: {
        project_id: PROJECT_ID,
        origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      },
    });
    expect(api.createDevAccessTicket).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("selects the environment for preview commands and forwards the retry key", async () => {
    const preview = vi.fn(async () => ({
      id: PROJECT_ID,
      project_id: PROJECT_ID,
      environment: "prod" as const,
      status: "sleeping" as const,
      url: `https://${"a".repeat(52)}.preview.dev.omh.st`,
      source: null,
    }));
    const { cli } = createCli({ api: { preview } });
    const opened = await cli.run([
      "project",
      "preview",
      "open",
      "--project",
      PROJECT_ID,
      "--environment",
      "prod",
      "--json",
    ]);
    expect(opened.exitCode).toBe(0);
    expect(preview).toHaveBeenLastCalledWith("open", {
      projectId: PROJECT_ID,
      environment: "prod",
    });
    const rotated = await cli.run([
      "project",
      "preview",
      "rotate",
      "--project",
      PROJECT_ID,
      "--environment",
      "prod",
      "--idempotency-key",
      "one",
      "--yes",
      "--json",
    ]);
    expect(rotated.exitCode).toBe(0);
    expect(preview).toHaveBeenLastCalledWith("rotate", {
      projectId: PROJECT_ID,
      environment: "prod",
      idempotencyKey: "one",
    });
  });

  it("gets, rotates, revokes and changes the Dev share mode through the generated API", async () => {
    const { cli, api } = createCli();
    const link = await cli.run(["project", "dev-share", "link", "--project", PROJECT_ID, "--json"]);
    expect(link.exitCode).toBe(0);
    expect(JSON.parse(link.stdout)).toMatchObject({
      command: "project dev-share link",
      state: { mode: "protected" },
    });
    expect(api.ensureDevShareLink).toHaveBeenCalledWith(PROJECT_ID);
    const mode = await cli.run([
      "project",
      "dev-access",
      "mode",
      "--project",
      PROJECT_ID,
      "--mode",
      "public",
      "--idempotency-key",
      "mode-1",
      "--yes",
      "--json",
    ]);
    expect(mode.exitCode).toBe(0);
    expect(api.setDevAccessMode).toHaveBeenCalledWith(PROJECT_ID, "public", "mode-1");
    const rotate = await cli.run([
      "project",
      "dev-share",
      "rotate",
      "--project",
      PROJECT_ID,
      "--idempotency-key",
      "rotate-1",
      "--yes",
      "--json",
    ]);
    expect(rotate.exitCode).toBe(0);
    expect(api.rotateDevShareLink).toHaveBeenCalledWith(PROJECT_ID, "rotate-1");
    const revoke = await cli.run([
      "project",
      "dev-share",
      "revoke",
      "--project",
      PROJECT_ID,
      "--idempotency-key",
      "revoke-1",
      "--yes",
      "--json",
    ]);
    expect(revoke.exitCode).toBe(0);
    expect(api.revokeDevShareLink).toHaveBeenCalledWith(PROJECT_ID, "revoke-1");
  });

  it("links through the API and stores only non-secret project metadata", async () => {
    const { cli, api, links } = createCli();
    const result = await cli.run([
      "link",
      "--project",
      PLAN.project_id,
      "--repository-owner",
      "owner",
      "--repository-name",
      "repo",
      "--idempotency-key",
      "link-a",
    ]);
    expect(result.exitCode).toBe(0);
    expect(api.linkSource).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "link-a" }),
    );
    expect(api.getOperation).toHaveBeenCalledWith(OPERATION.id);
    // The link records the organization the API authorized, so another account's link of the
    // same checkout is never used for this one.
    expect(api.getCurrentIdentity).toHaveBeenCalled();
    expect(links).toEqual([
      {
        version: 2,
        api_origin: "https://control.example.test",
        organization_id: "00000000000000000000000001",
        project_id: PLAN.project_id,
        installation_id: "42",
        repository_full_name: "owner/repo",
      },
    ]);
    expect(JSON.stringify(links)).not.toContain("access-a");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "completed",
      organization_id: "00000000000000000000000001",
    });
  });

  it("connects GitHub once, exposes workspace status and keeps failed handoffs scoped to that workspace", async () => {
    const { cli, api, links } = createCli();
    const argv = [
      "github",
      "connect",
      "--organization",
      GITHUB_CONNECTION.organization_id,
      "--idempotency-key",
      "github-a",
      "--json",
    ];
    const handoff = await cli.run(argv);
    expect(handoff.exitCode).toBe(0);
    expect(JSON.parse(handoff.stdout)).toMatchObject({
      status: "pending",
      authorization: GITHUB_AUTHORIZATION,
    });
    expect(api.connectGithub).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: GITHUB_CONNECTION.organization_id,
        idempotencyKey: "github-a",
      }),
    );
    expect(links).toEqual([]);
    expect(api.getOperation).not.toHaveBeenCalled();
    const status = await cli.run([
      "github",
      "status",
      "--organization",
      GITHUB_CONNECTION.organization_id,
    ]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      status: "connected",
      github: { connection: GITHUB_CONNECTION },
    });
    const missing = createCli({
      api: { getGithubConnection: async () => ({ status: "not_connected", connection: null }) },
    });
    expect(JSON.parse((await missing.cli.run(["whoami"])).stdout).next_action).toContain(
      "github connect --organization " + GITHUB_CONNECTION.organization_id,
    );
    for (const state of ["connected", "authorizing", "failed", "expired"] as const) {
      const next = createCli({
        api: {
          connectGithub: async () => ({
            ...GITHUB_AUTHORIZATION,
            status: state,
            authorization_url: null,
            connection: state === "connected" ? GITHUB_CONNECTION : null,
            last_failure: state === "expired" ? "expired" : null,
          }),
        },
      });
      expect(JSON.parse((await next.cli.run(argv)).stdout)).toMatchObject({ status: state });
    }
  });

  it("disconnects the workspace GitHub connection only with --yes and never with a key", async () => {
    const { cli, api } = createCli();
    const argv = [
      "github",
      "disconnect",
      "--organization",
      GITHUB_CONNECTION.organization_id,
      "--json",
    ];
    // Revoking the connection stops auto-deploy and linked sources, so it needs --yes first.
    expect((await cli.run(argv)).exitCode).toBe(2);
    expect(api.disconnectGithub).not.toHaveBeenCalled();
    const done = await cli.run([...argv, "--yes"]);
    expect(done.exitCode).toBe(0);
    expect(api.disconnectGithub).toHaveBeenCalledWith(GITHUB_CONNECTION.organization_id);
    expect(JSON.parse(done.stdout)).toMatchObject({
      command: "github disconnect",
      status: "revoked",
      github: { status: "revoked" },
      next_action: expect.stringContaining("github connect --organization"),
    });
    // The route reads no idempotency key, so a key is refused rather than ignored.
    expect((await cli.run([...argv, "--yes", "--idempotency-key", "github-off"])).exitCode).toBe(2);
    expect(api.disconnectGithub).toHaveBeenCalledTimes(1);
  });

  it("lists workspace MCP clients and revokes one only with --yes, never with a key", async () => {
    const connectionId = "7f3d2c1e-8a4b-4c5d-9e6f-1a2b3c4d5e6f";
    const connection = {
      connection_id: connectionId,
      client_id: "https://mcp.example.test/client",
      user_id: "user-a",
      connected_at: OPERATION.created_at,
    };
    const { cli, api } = createCli();
    vi.mocked(api.listOrganizationMcpConnections).mockResolvedValueOnce({
      connections: [connection],
    });
    const listed = await cli.run([
      "organization",
      "mcp-connections",
      "list",
      "--organization",
      GITHUB_CONNECTION.organization_id,
      "--json",
    ]);
    expect(listed.exitCode).toBe(0);
    expect(api.listOrganizationMcpConnections).toHaveBeenCalledWith(
      GITHUB_CONNECTION.organization_id,
    );
    expect(JSON.parse(listed.stdout)).toMatchObject({
      command: "organization mcp-connections list",
      status: "listed",
      connections: [connection],
    });
    // Listing is read-only, so --yes is refused rather than ignored.
    expect(
      (
        await cli.run([
          "organization",
          "mcp-connections",
          "list",
          "--organization",
          GITHUB_CONNECTION.organization_id,
          "--yes",
          "--json",
        ])
      ).exitCode,
    ).toBe(2);
    const revoke = [
      "organization",
      "mcp-connections",
      "revoke",
      "--organization",
      GITHUB_CONNECTION.organization_id,
      "--connection",
      connectionId,
      "--json",
    ];
    // Disconnecting a client is destructive and needs --yes; a malformed connection is refused.
    expect((await cli.run(revoke)).exitCode).toBe(2);
    expect(api.revokeOrganizationMcpConnection).not.toHaveBeenCalled();
    expect(
      (
        await cli.run([
          "organization",
          "mcp-connections",
          "revoke",
          "--organization",
          GITHUB_CONNECTION.organization_id,
          "--connection",
          "not-a-connection",
          "--yes",
          "--json",
        ])
      ).exitCode,
    ).toBe(2);
    expect(api.revokeOrganizationMcpConnection).not.toHaveBeenCalled();
    const done = await cli.run([...revoke, "--yes"]);
    expect(done.exitCode).toBe(0);
    expect(api.revokeOrganizationMcpConnection).toHaveBeenCalledWith({
      organizationId: GITHUB_CONNECTION.organization_id,
      connectionId,
    });
    expect(JSON.parse(done.stdout)).toMatchObject({
      command: "organization mcp-connections revoke",
      status: "revoked",
    });
    // A pending answer tells the owner to repeat the same command until it is revoked.
    const draining = createCli({
      api: {
        revokeOrganizationMcpConnection: async () => ({ state: "pending" as const }),
      },
    });
    const pending = await draining.cli.run([...revoke, "--yes"]);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      status: "pending",
      next_action: expect.stringContaining("Repeat"),
    });
    // The route reads no idempotency key, so a key is refused rather than ignored.
    expect((await cli.run([...revoke, "--yes", "--idempotency-key", "mcp-off"])).exitCode).toBe(2);
    expect(api.revokeOrganizationMcpConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses a GitHub disconnect answer that still reports the connection as connected", async () => {
    const { cli } = createCli({
      api: {
        disconnectGithub: async () => ({
          status: "connected" as const,
          connection: GITHUB_CONNECTION,
        }),
      },
    });
    const result = await cli.run([
      "github",
      "disconnect",
      "--organization",
      GITHUB_CONNECTION.organization_id,
      "--yes",
      "--json",
    ]);
    // A disconnect that is still connected must not be reported as done.
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "response_contract_invalid" },
    });
  });

  it("accepts every hex UUID the public contract names as an MCP connection id", async () => {
    // Version 0 and variant 1 are not RFC 4122 UUIDs, but the contract's format names any hex UUID.
    const connectionId = "7f3d2c1e-8a4b-0c5d-1e6f-1a2b3c4d5e6f";
    const { cli, api } = createCli();
    const result = await cli.run([
      "organization",
      "mcp-connections",
      "revoke",
      "--organization",
      GITHUB_CONNECTION.organization_id,
      "--connection",
      connectionId,
      "--yes",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(api.revokeOrganizationMcpConnection).toHaveBeenCalledWith({
      organizationId: GITHUB_CONNECTION.organization_id,
      connectionId,
    });
  });

  it("reports auto-deploy as not configured instead of a missing resource", async () => {
    const { cli, api } = createCli();
    vi.mocked(api.getAutoDeploy).mockResolvedValueOnce({
      branch: null,
      ref: null,
      environment: "dev",
      enabled: false,
      generation: 0,
      grant_status: null,
      updated_at: null,
    });
    const result = await cli.run(["source", "auto-deploy", "status", "--project", PROJECT_ID]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "source auto-deploy status",
      status: "not_configured",
      auto_deploy: { enabled: false, generation: 0 },
    });
  });

  it("configures and reads push-to-dev through the generated SDK boundary", async () => {
    const { cli, api } = createCli();
    const configured = await cli.run([
      "source",
      "auto-deploy",
      "set",
      "--project",
      PROJECT_ID,
      "--branch",
      "main",
      "--enabled",
      "true",
      "--idempotency-key",
      "push-a",
    ]);
    const status = await cli.run(["source", "auto-deploy", "status", "--project", PROJECT_ID]);
    const disabled = await cli.run([
      "source",
      "auto-deploy",
      "set",
      "--project",
      PROJECT_ID,
      "--branch",
      "main",
      "--enabled",
      "false",
      "--idempotency-key",
      "push-disable",
    ]);
    expect(configured.exitCode).toBe(0);
    expect(status.exitCode).toBe(0);
    expect(disabled.exitCode).toBe(0);
    expect(api.configureAutoDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        branch: "main",
        enabled: true,
        idempotencyKey: "push-a",
      }),
    );
    expect(api.getAutoDeploy).toHaveBeenCalledWith(PROJECT_ID);
    expect(api.configureAutoDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        idempotencyKey: "push-disable",
      }),
    );
    expect(JSON.parse(configured.stdout)).toMatchObject({
      command: "source auto-deploy set",
      status: "configured",
      auto_deploy: { ref: "refs/heads/main", environment: "dev" },
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "does not persist link metadata when the operation ends %s",
    async (state) => {
      const { cli, links } = createCli({
        api: {
          getOperation: vi.fn(async () => ({
            ...TERMINAL,
            state,
            ...(state === "failed"
              ? {
                  error: {
                    code: "build_not_started" as const,
                    message: "provider detail",
                    retryable: false as const,
                    suggested_action: "unsafe provider detail",
                  },
                }
              : {}),
          })),
        },
      });
      const result = await cli.run([
        "link",
        "--project",
        PLAN.project_id,
        "--repository-owner",
        "owner",
        "--repository-name",
        "repo",
        "--idempotency-key",
        "link-a",
      ]);

      expect(result.exitCode).toBe(10);
      expect(links).toEqual([]);
      expect(result.stdout).not.toContain("provider detail");
      expect(JSON.parse(result.stdout)).toMatchObject({
        operation_id: TERMINAL.id,
        error:
          state === "failed"
            ? {
                code: "build_not_started",
                message: "The deployment ended without starting a build.",
                retryable: false,
                suggested_action: expect.stringContaining("new idempotency key"),
              }
            : { code: "operation_not_succeeded" },
      });
    },
  );

  it("does not persist link metadata when operation polling times out", async () => {
    const getOperation = vi.fn(async () => OPERATION);
    const { cli, links } = createCli({ api: { getOperation } });
    const result = await cli.run([
      "link",
      "--project",
      PLAN.project_id,
      "--repository-owner",
      "owner",
      "--repository-name",
      "repo",
      "--idempotency-key",
      "link-a",
    ]);

    expect(result.exitCode).toBe(8);
    expect(getOperation).toHaveBeenCalledTimes(120);
    expect(links).toEqual([]);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "operation_wait_timeout",
      retryable: true,
      suggested_action: `The operation is still running; this command stopped waiting after about 2 minutes and cancelled nothing. Poll 'ohmyhost operation get ${OPERATION.id} --json' about every 60 seconds until it is succeeded, failed or cancelled. Do not submit the same change again; a new key starts a second operation.`,
    });
  });

  it("stops waiting when the original operation needs reconciliation and preserves its identity", async () => {
    const reconciliation = {
      state: "required" as const,
      attempt_id: null,
      observed_at: OPERATION.updated_at,
      suggested_action:
        "Confirm reconciliation of this same operation with POST /v1/operations/{operation_id}:reconcile; preserve its existing build, data and resources. Do not submit another deployment or data change.",
    };
    const getOperation = vi.fn(async () => ({
      ...OPERATION,
      state: "running" as const,
      reconciliation,
    }));
    const { cli, api } = createCli({ api: { getOperation } });
    const result = await cli.run([
      "deploy",
      "--project",
      PLAN.project_id,
      "--plan-id",
      PLAN.id,
      "--idempotency-key",
      "deploy-reconcile",
      "--yes",
      "--wait",
      "--json",
    ]);
    expect(result.exitCode).toBe(10);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation_id: OPERATION.id,
      error: { code: "operation_reconciliation_required", retryable: false },
    });
    expect(getOperation).toHaveBeenCalledOnce();
    expect(api.createDeployment).toHaveBeenCalledOnce();
    const read = await cli.run(["operation", "get", OPERATION.id, "--json"]);
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout).operation.reconciliation).toEqual(reconciliation);
  });

  it("attaches the Dev access note as a conditional instruction to a deploy named by plan id", async () => {
    const succeeded = { ...OPERATION, state: "succeeded" as const, deployment_id: PLAN.id };
    const { cli } = createCli({ api: { getOperation: vi.fn(async () => succeeded) } });
    const result = await cli.run([
      "deploy",
      "--project",
      PLAN.project_id,
      "--plan-id",
      PLAN.id,
      "--idempotency-key",
      "deploy-prod",
      "--yes",
      "--wait",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    // The CLI cannot read the environment of a plan ID, so the note says what to check if this was a Dev deployment.
    expect(JSON.parse(result.stdout)).toMatchObject({
      notes: [expect.stringMatching(/If this is a Dev deployment.*dev-share link/u)],
    });
  });

  it("plans and deploys with bounded operation polling", async () => {
    const { cli, api } = createCli();
    const planned = await cli.run([
      "plan",
      "--project",
      PLAN.project_id,
      "--commit",
      PLAN.commit_sha,
    ]);
    expect(planned.exitCode).toBe(0);
    expect(api.planDeployment).toHaveBeenCalledWith(
      expect.not.objectContaining({ environment: expect.anything() }),
    );
    expect(JSON.parse(planned.stdout)).toMatchObject({
      command: "plan",
      status: "planned",
      plan: { route: DEPLOYMENT_ROUTE },
      notes: [
        expect.stringMatching(/updates Dev only.*--environment prod.*deployment promote plan/u),
      ],
    });
    const result = await cli.run([
      "deploy",
      "--project",
      PLAN.project_id,
      "--plan-id",
      PLAN.id,
      "--idempotency-key",
      "deploy-a",
      "--yes",
      "--wait",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(api.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PLAN.project_id,
        planId: PLAN.id,
        idempotencyKey: "deploy-a",
      }),
    );
    expect(api.getOperation).toHaveBeenCalledOnce();
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      command: "deploy",
      status: "completed",
      operation: { state: "succeeded" },
    });
    // A --plan-id deploy names no environment the CLI can read, so it gets the conditional Dev access note.
    expect((JSON.parse(result.stdout) as { notes?: string[] }).notes).toEqual([
      expect.stringMatching(/If this is a Dev deployment/u),
    ]);
  });

  it("plans and deploys one commit straight into Prod and refuses ambiguous deploy targets", async () => {
    const { cli, api } = createCli();
    vi.mocked(api.planDeployment).mockResolvedValueOnce({ ...PLAN, environment: "prod" });
    const result = await cli.run([
      "deploy",
      "--project",
      PLAN.project_id,
      "--commit",
      PLAN.commit_sha,
      "--environment",
      "prod",
      "--idempotency-key",
      "deploy-prod",
      "--yes",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(api.planDeployment).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      commitSha: PLAN.commit_sha,
      environment: "prod",
    });
    expect(api.createDeployment).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      planId: PLAN.id,
      idempotencyKey: "deploy-prod",
    });
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({ command: "deploy", plan: { environment: "prod" } });
    // Dev access notes do not apply to a Prod deployment.
    expect(body["notes"]).toBeUndefined();
    const planned = await cli.run([
      "plan",
      "--project",
      PLAN.project_id,
      "--commit",
      PLAN.commit_sha,
      "--environment",
      "prod",
    ]);
    expect(planned.exitCode).toBe(0);
    expect(api.planDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({ environment: "prod" }),
    );
    for (const argv of [
      ["deploy", "--project", PLAN.project_id, "--idempotency-key", "k", "--yes"],
      [
        "deploy",
        "--project",
        PLAN.project_id,
        "--plan-id",
        PLAN.id,
        "--commit",
        PLAN.commit_sha,
        "--idempotency-key",
        "k",
        "--yes",
      ],
      [
        "deploy",
        "--project",
        PLAN.project_id,
        "--plan-id",
        PLAN.id,
        "--environment",
        "prod",
        "--idempotency-key",
        "k",
        "--yes",
      ],
      ["plan", "--project", PLAN.project_id, "--commit", PLAN.commit_sha, "--environment", "qa"],
    ])
      expect((await cli.run(argv)).exitCode).not.toBe(0);
    expect(api.createDeployment).toHaveBeenCalledOnce();
  });

  it("never tells a rerun of deploy --commit to build the same commit with a new key", async () => {
    // A lost answer or a --wait timeout reruns the same key; that re-plans and the server refuses
    // the new plan under the old key. A new key would start a second build of the same commit.
    const { cli, api } = createCli();
    vi.mocked(api.createDeployment).mockRejectedValueOnce({
      type: "https://docs.ohmyho.st/errors/idempotency-key-reused",
      title: "Idempotency key reused",
      status: 409,
      code: "idempotency_key_reused",
      request_id: "request-reused",
      detail: "The original plan and request key identify the accepted deployment.",
      retryable: false,
      suggested_action: "Use a new idempotency key for a different request.",
    });

    const result = await cli.run([
      "deploy",
      "--project",
      PLAN.project_id,
      "--commit",
      PLAN.commit_sha,
      "--idempotency-key",
      "deploy-again",
      "--yes",
      "--json",
    ]);

    expect(result.exitCode).toBe(7);
    const error = (JSON.parse(result.stdout) as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({
      code: "idempotency_key_reused",
      retryable: false,
      request_id: "request-reused",
      message: "The original plan and request key identify the accepted deployment.",
      suggested_action: `This key already started a deployment from an earlier run of this command; a new key would build the same commit again. Run 'ohmyhost project status --project ${PLAN.project_id} --json' and follow latest_operation with 'ohmyhost operation get OPERATION_ULID --json'.`,
    });
    expect(String(error["suggested_action"])).not.toContain("new idempotency key");
  });

  it("links each server problem to its documentation page", async () => {
    const { cli, api } = createCli();
    vi.mocked(api.planDeployment).mockRejectedValueOnce({
      type: "https://docs.ohmyho.st/errors/shared-data-requires-promotion",
      title: "Shared data requires promotion",
      status: 409,
      code: "shared_data_requires_promotion",
      request_id: "req-docs-url",
      retryable: false,
      suggested_action: "Deploy to Dev, then promote.",
    });
    const result = await cli.run([
      "plan",
      "--project",
      PLAN.project_id,
      "--commit",
      PLAN.commit_sha,
      "--environment",
      "prod",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "shared_data_requires_promotion",
        request_id: "req-docs-url",
        docs_url: "https://docs.ohmyho.st/errors/shared-data-requires-promotion",
      },
    });
  });

  it("writes each validated log event before requesting the next SSE event", async () => {
    const writes: string[] = [];
    let allowTerminal: (() => void) | undefined;
    const terminalGate = new Promise<void>((resolve) => {
      allowTerminal = resolve;
    });
    const streamOperationEvents = vi.fn(async () =>
      (async function* () {
        yield {
          event_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
          operation_id: OPERATION.id,
          project_id: PLAN.project_id,
          type: "OperationStarted" as const,
          occurred_at: "2026-08-18T00:00:01.000Z",
        };
        await terminalGate;
        yield {
          event_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
          operation_id: OPERATION.id,
          project_id: PLAN.project_id,
          type: "OperationSucceeded" as const,
          occurred_at: "2026-08-18T00:00:02.000Z",
        };
      })(),
    );
    const { cli, api } = createCli({
      api: { streamOperationEvents },
      writeEvent: (value) => writes.push(value),
    });
    const pending = cli.run(["logs", OPERATION.id, "--follow", "--json"]);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({ type: "OperationStarted" });
    allowTerminal?.();
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(api.streamOperationEvents).toHaveBeenCalledWith(OPERATION.id, expect.any(AbortSignal));
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1] ?? "")).toMatchObject({ type: "OperationSucceeded" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      command: "logs",
      status: "completed",
      event_count: 2,
    });
  });

  it("passes plan-bound ETag and confirmation token unchanged for rollback and delete", async () => {
    const { cli, api } = createCli();
    expect(
      (
        await cli.run([
          "rollback",
          "plan",
          "--project",
          PLAN.project_id,
          "--deployment",
          TARGET_DEPLOYMENT_ID,
        ])
      ).exitCode,
    ).toBe(0);
    expect((await cli.run(["delete", "plan", "--project", PLAN.project_id])).exitCode).toBe(0);
    const common = [
      "--project",
      PLAN.project_id,
      "--if-match",
      ACTION_PLAN.resource_etag,
      "--confirmation-token",
      ACTION_PLAN.confirmation_token,
      "--idempotency-key",
    ];
    await cli.run([
      "rollback",
      "--deployment",
      TARGET_DEPLOYMENT_ID,
      ...common,
      "rollback-a",
      "--yes",
    ]);
    await cli.run(["delete", ...common, "delete-a", "--yes"]);
    expect(api.rollback).toHaveBeenCalledWith(
      expect.objectContaining({
        ifMatch: ACTION_PLAN.resource_etag,
        confirmationToken: ACTION_PLAN.confirmation_token,
      }),
    );
    expect(api.planRollback).toHaveBeenCalledOnce();
    expect(api.planDelete).toHaveBeenCalledOnce();
    expect(api.deleteProject).toHaveBeenCalledWith(
      expect.objectContaining({
        ifMatch: ACTION_PLAN.resource_etag,
        confirmationToken: ACTION_PLAN.confirmation_token,
      }),
    );
  });

  it("plans and promotes the exact dev deployment through the generated API and waiter", async () => {
    const { cli, api } = createCli();
    const plan = await cli.run([
      "deployment",
      "promote",
      "plan",
      "--project",
      PLAN.project_id,
      "--deployment",
      TARGET_DEPLOYMENT_ID,
    ]);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      command: "deployment promote plan",
      status: "planned",
      plan: PROMOTION_PLAN,
    });

    const promoted = await cli.run([
      "deployment",
      "promote",
      "--project",
      PLAN.project_id,
      "--deployment",
      TARGET_DEPLOYMENT_ID,
      "--if-match",
      PROMOTION_PLAN.resource_etag,
      "--confirmation-token",
      PROMOTION_PLAN.confirmation_token,
      "--idempotency-key",
      "promote-a",
      "--yes",
      "--wait",
    ]);

    expect(api.planPromotion).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDeploymentId: TARGET_DEPLOYMENT_ID }),
    );
    expect(api.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDeploymentId: TARGET_DEPLOYMENT_ID,
        ifMatch: PROMOTION_PLAN.resource_etag,
        confirmationToken: PROMOTION_PLAN.confirmation_token,
      }),
    );
    expect(JSON.parse(promoted.stdout)).toMatchObject({
      command: "deployment promote",
      status: "completed",
      operation: { state: "succeeded" },
    });
  });

  it("lists only validated environment-secret metadata", async () => {
    const { cli, api } = createCli();

    const result = await cli.run([
      "secret",
      "list",
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(api.listEnvironmentSecrets).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      environmentId: ENVIRONMENT_ID,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "secret list",
      status: "listed",
      secrets: [SECRET],
    });
  });

  it("reads the recent billed usage of an organization and refuses a month or a cursor", async () => {
    const usage = {
      organization_id: "00000000000000000000000001",
      as_of: "2026-10-30T10:00:00.000Z",
      unit: "microcredits" as const,
      period: "2026-10",
      from: "2026-10-17T00:00:00.000Z",
      projects: [{ project_id: PLAN.project_id, used_micros: "42" }],
      days: [
        {
          day: "2026-10-30",
          projects: [
            {
              project_id: PLAN.project_id,
              meters: [
                {
                  environment_id: null,
                  meter: "wfp.requests",
                  unit: "request",
                  rate_card_id: "usage-2026-10-v1",
                  quantity: "1500",
                  charged_micros: "42",
                },
              ],
            },
          ],
        },
      ],
    };
    const getOrganizationCreditUsage = vi.fn(async () => usage);
    const { cli } = createCli({ api: { getOrganizationCreditUsage } });

    const result = await cli.run([
      "credits",
      "usage",
      "--organization",
      "00000000000000000000000001",
      "--json",
    ]);

    expect(result.exitCode, result.stdout).toBe(0);
    expect(getOrganizationCreditUsage).toHaveBeenCalledWith("00000000000000000000000001");
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "credits usage",
      status: "succeeded",
      usage,
    });
    expect(
      (
        await cli.run([
          "credits",
          "usage",
          "--organization",
          "00000000000000000000000001",
          "--month",
          "2026-10",
          "--json",
        ])
      ).exitCode,
    ).not.toBe(0);
    expect(getOrganizationCreditUsage).toHaveBeenCalledOnce();
  });

  it("lists validated scheduled function runs with a bounded limit", async () => {
    const { cli, api } = createCli();

    const result = await cli.run([
      "function",
      "runs",
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(api.listFunctionRuns).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      environmentId: ENVIRONMENT_ID,
      limit: 50,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "function runs",
      status: "listed",
      runs: [FUNCTION_RUN],
    });

    const limited = await cli.run([
      "function",
      "runs",
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--limit",
      "3",
      "--json",
    ]);
    expect(limited.exitCode).toBe(0);
    expect(api.listFunctionRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 3 }));

    for (const limit of ["0", "101", "abc"]) {
      const invalid = await cli.run([
        "function",
        "runs",
        "--project",
        PLAN.project_id,
        "--environment",
        ENVIRONMENT_ID,
        "--limit",
        limit,
        "--json",
      ]);
      expect(invalid.exitCode).not.toBe(0);
    }
    expect(api.listFunctionRuns).toHaveBeenCalledTimes(2);

    vi.mocked(api.listFunctionRuns).mockResolvedValueOnce({
      items: [{ ...FUNCTION_RUN, state: "exploded" as never }],
    });
    const drifted = await cli.run([
      "function",
      "runs",
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--json",
    ]);
    expect(drifted.exitCode).not.toBe(0);
    expect(drifted.stdout).not.toContain("exploded");
  });

  it("refuses an unreadable or non-DML statement file before any API call", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-statement-"));
    try {
      const commented = join(directory, "commented.sql");
      await writeFile(commented, "-- note\nupdate items set name = $1 where id = $2;\n");
      const { cli, api } = createCli();
      const writeProjectDatabase = vi.spyOn(api, "writeProjectDatabase");
      for (const path of [join(directory, "missing.sql"), commented, directory]) {
        const result = await cli.run([
          "database",
          "write",
          "--project",
          PROJECT_ID,
          "--environment",
          "dev",
          "--statement-file",
          path,
          "--idempotency-key",
          "write-a",
          "--yes",
          "--json",
        ]);
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stdout)).toEqual({
          version: 1,
          command: "database write",
          status: "error",
          error: {
            code: "statement_file_invalid",
            retryable: false,
            suggested_action:
              "Put one INSERT, UPDATE or DELETE statement that starts with that keyword (no leading comment or WITH), UTF-8, at most 64 KiB, in the file named by --statement-file, then rerun with the same --idempotency-key.",
          },
        });
      }
      expect(writeProjectDatabase).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads a Native provider secret from stdin and keeps it out of output", async () => {
    let secret = "private-provider-secret";
    const readSecretValue = vi.fn(async () => secret);
    const nativeAuth = vi.fn(async () => ({ provider: "google", secretPresent: true }));
    const { cli } = createCli({ readSecretValue, api: { nativeAuth } });
    const command = [
      "auth",
      "provider",
      "set",
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--provider",
      "google",
      "--revision",
      "2",
      "--enabled",
      "true",
      "--idempotency-key",
      "native-key",
      "--stdin",
      "--json",
    ];
    for (secret of ["private-provider-secret", "x".repeat(5_120), "é".repeat(2_560)]) {
      nativeAuth.mockClear();
      const result = await cli.run(command);
      expect(result.exitCode).toBe(0);
      expect(nativeAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "provider_set",
          clientSecret: secret,
          configurationRevision: 2,
        }),
      );
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    for (secret of ["x".repeat(5_121), `${"é".repeat(2_560)}x`]) {
      nativeAuth.mockClear();
      const result = await cli.run(command);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: "secret_input_invalid", retryable: false },
      });
      expect(nativeAuth).not.toHaveBeenCalled();
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  });

  it("reads a secret value only from stdin and never returns it", async () => {
    const readSecretValue = vi.fn(async () => "postgres://private");
    const { cli, api } = createCli({ readSecretValue });

    const result = await cli.run([
      "secret",
      "set",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-set-a",
      "--stdin",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(readSecretValue).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(api.putEnvironmentSecret).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      environmentId: ENVIRONMENT_ID,
      name: SECRET.name,
      value: "postgres://private",
      idempotencyKey: "secret-set-a",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "secret set",
      status: "stored",
      secret: SECRET,
    });
    expect(result.stdout + result.stderr).not.toContain("postgres://private");
  });

  it("waits for the desired runtime-secret generation without rereading stdin", async () => {
    const readSecretValue = vi.fn(async () => "postgres://private");
    const { cli, api } = createCli({ readSecretValue });
    vi.mocked(api.putEnvironmentSecret).mockResolvedValueOnce({
      ...SECRET,
      desired_generation: 2,
      applied_generation: 1,
      delivery_state: "pending",
    });
    vi.mocked(api.listEnvironmentSecrets)
      .mockResolvedValueOnce({
        items: [
          {
            ...SECRET,
            desired_generation: 2,
            applied_generation: 1,
            delivery_state: "pending",
          },
        ],
        desired_generation: 2,
        applied_generation: 1,
        delivery_state: "pending",
        runtime_provider: "wfp",
        applied_secret_count: 1,
        last_error: null,
      })
      .mockResolvedValueOnce({
        // The platform secret sorts first; the response must still describe the secret just set.
        items: [
          {
            ...SECRET,
            name: "BETTER_AUTH_SECRET",
            revision: 7,
            desired_generation: 2,
            applied_generation: 2,
          },
          { ...SECRET, desired_generation: 2, applied_generation: 2 },
        ],
        desired_generation: 2,
        applied_generation: 2,
        delivery_state: "ready",
        runtime_provider: "wfp",
        applied_secret_count: 2,
        last_error: null,
      });

    const result = await cli.run([
      "secret",
      "set",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-set-wait-a",
      "--stdin",
      "--wait",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(readSecretValue).toHaveBeenCalledOnce();
    expect(api.listEnvironmentSecrets).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      secret: {
        name: SECRET.name,
        revision: SECRET.revision,
        desired_generation: 2,
        applied_generation: 2,
        delivery_state: "ready",
      },
    });
    expect(result.stdout).not.toContain("BETTER_AUTH_SECRET");
  });

  it("returns at once when no deployment exists yet to deliver a secret to", async () => {
    // secret_set_command always adds --wait; before the first deployment it timed out every time.
    const notDeployed = {
      desired_generation: 1,
      applied_generation: 0,
      delivery_state: "not_deployed" as const,
      runtime_provider: null,
      applied_secret_count: 0,
      last_error: null,
    };
    const { cli, api } = createCli({ readSecretValue: async () => "private" });
    vi.mocked(api.putEnvironmentSecret).mockResolvedValueOnce({ ...SECRET, ...notDeployed });
    vi.mocked(api.listEnvironmentSecrets).mockResolvedValueOnce({
      items: [{ ...SECRET, ...notDeployed }],
      ...notDeployed,
    });
    const argv = [
      "secret",
      "set",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-before-deploy",
      "--stdin",
      "--wait",
      "--json",
    ];

    const stored = await cli.run(argv);

    expect(stored.exitCode).toBe(0);
    expect(api.listEnvironmentSecrets).toHaveBeenCalledOnce();
    expect(JSON.parse(stored.stdout)).toMatchObject({
      status: "stored",
      secret: { name: SECRET.name, delivery_state: "not_deployed" },
    });

    // A deployed environment whose delivery never finishes stops waiting and says what to read.
    const pending = { ...notDeployed, applied_generation: 0, delivery_state: "pending" as const };
    vi.mocked(api.putEnvironmentSecret).mockResolvedValueOnce({ ...SECRET, ...pending });
    vi.mocked(api.listEnvironmentSecrets).mockResolvedValue({
      items: [{ ...SECRET, ...pending }],
      ...pending,
    });
    const waited = await cli.run(argv);
    expect(waited.exitCode).toBe(8);
    expect(JSON.parse(waited.stdout).error).toEqual({
      code: "secret_delivery_wait_timeout",
      retryable: true,
      suggested_action: `The secret is saved, but it had not reached the running app after about 2 minutes. Read 'ohmyhost secret list --project ${PLAN.project_id} --environment ${ENVIRONMENT_ID} --json': pending means delivery is still under way, and not_deployed means it arrives with the first deployment. Do not set the value again.`,
    });
  });

  it("fails closed when runtime-secret delivery reports a redacted provider error", async () => {
    const { cli, api } = createCli({ readSecretValue: async () => "private" });
    vi.mocked(api.putEnvironmentSecret).mockResolvedValueOnce({
      ...SECRET,
      desired_generation: 2,
      applied_generation: 1,
      delivery_state: "pending",
    });
    vi.mocked(api.listEnvironmentSecrets).mockResolvedValueOnce({
      items: [],
      desired_generation: 2,
      applied_generation: 1,
      delivery_state: "failed",
      runtime_provider: "wfp",
      applied_secret_count: 1,
      last_error: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN",
    });

    const result = await cli.run([
      "secret",
      "set",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-set-failed-a",
      "--stdin",
      "--wait",
      "--json",
    ]);

    expect(result.exitCode).toBe(10);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "secret set",
      status: "error",
      error: {
        code: "secret_delivery_failed",
        retryable: true,
        suggested_action: `The secret is saved, but delivering it to the running app failed (last_error in 'ohmyhost secret list --project ${PLAN.project_id} --environment ${ENVIRONMENT_ID} --json'). Do not set the value again: ohmyho.st retries delivery automatically, and the next deployment of this environment also delivers it. Read secret list again in a few minutes; if delivery_state stays failed, report last_error with feedback submit (kind bug, error code secret_delivery_failed).`,
      },
    });
    expect(result.stdout).not.toContain("WFP_RUNTIME_SECRET_RESULT_UNCERTAIN");
  });

  it("rejects empty secret input before calling the API", async () => {
    const { cli, api } = createCli({ readSecretValue: async () => "" });

    const result = await cli.run([
      "secret",
      "set",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-empty-a",
      "--stdin",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "secret set",
      status: "error",
      error: { code: "secret_input_invalid", retryable: false },
    });
    expect(api.putEnvironmentSecret).not.toHaveBeenCalled();
  });

  it("rejects runtime secret input above the WFP 5 KiB limit before calling the API", async () => {
    const { cli, api } = createCli({ readSecretValue: async () => "x".repeat(5_121) });

    const result = await cli.run([
      "secret",
      "set",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-oversized-a",
      "--stdin",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(api.putEnvironmentSecret).not.toHaveBeenCalled();
  });

  it("deletes an environment secret idempotently without reading stdin", async () => {
    const readSecretValue = vi.fn(async () => "must-not-be-read");
    const { cli, api } = createCli({ readSecretValue });

    const result = await cli.run([
      "secret",
      "delete",
      SECRET.name,
      "--project",
      PLAN.project_id,
      "--environment",
      ENVIRONMENT_ID,
      "--idempotency-key",
      "secret-delete-a",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(readSecretValue).not.toHaveBeenCalled();
    expect(api.deleteEnvironmentSecret).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      environmentId: ENVIRONMENT_ID,
      name: SECRET.name,
      idempotencyKey: "secret-delete-a",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "secret delete",
      status: "deleted",
      secret: {
        name: SECRET.name,
        desired_generation: 2,
        applied_generation: 1,
        delivery_state: "pending",
        runtime_provider: "wfp",
        applied_secret_count: 1,
        last_error: null,
      },
    });
  });

  it("configures and reads mail readiness in an explicit environment through the public API", async () => {
    const environmentId = "01H00000000000000000000602",
      domain = { domain: MAIL_DOMAIN.domain, sending: "pending", receiving: "disabled" };
    const managedMail = vi.fn(async () => domain),
      { cli } = createCli({ api: { managedMail } });
    const configured = await cli.run([
      "mail",
      "domain",
      "set",
      "--project",
      PLAN.project_id,
      "--environment",
      environmentId,
      "--domain",
      MAIL_DOMAIN.domain,
      "--sending",
      "true",
      "--receiving",
      "false",
      "--idempotency-key",
      "mail-domain-a",
      "--json",
    ]);
    expect(configured.exitCode).toBe(0);
    expect(managedMail).toHaveBeenCalledWith({
      action: "configure",
      projectId: PLAN.project_id,
      environmentId,
      domain: MAIL_DOMAIN.domain,
      sending: true,
      receiving: false,
      idempotencyKey: "mail-domain-a",
    });
    expect(JSON.parse(configured.stdout)).toMatchObject({
      command: "mail domain set",
      mail: domain,
    });
    const status = await cli.run([
      "mail",
      "domain",
      "status",
      "--project",
      PLAN.project_id,
      "--environment",
      environmentId,
      "--json",
    ]);
    expect(status.exitCode).toBe(0);
    expect(managedMail).toHaveBeenLastCalledWith({
      action: "status",
      projectId: PLAN.project_id,
      environmentId,
    });
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "mail domain status",
      mail: domain,
    });
    const retire = [
      "mail",
      "domain",
      "delete",
      "--project",
      PLAN.project_id,
      "--environment",
      environmentId,
      "--idempotency-key",
      "mail-retire-a",
      "--json",
    ];
    // Retiring the mail domain is destructive and needs explicit confirmation.
    const calls = managedMail.mock.calls.length;
    expect((await cli.run(retire)).exitCode).not.toBe(0);
    expect(managedMail).toHaveBeenCalledTimes(calls);
    expect((await cli.run([...retire, "--yes"])).exitCode).toBe(0);
    expect(managedMail).toHaveBeenLastCalledWith({
      action: "domain_delete",
      projectId: PLAN.project_id,
      environmentId,
      idempotencyKey: "mail-retire-a",
    });
  });

  it("refuses a mail setup or domain set that does not send before any request, since the managed domain always sends", async () => {
    const environmentId = "01H00000000000000000000602";
    const managedMail = vi.fn(async () => ({ sending: "pending", receiving: "disabled" }));
    const { cli } = createCli({ api: { managedMail } });
    for (const command of [
      ["mail", "setup"],
      ["mail", "domain", "set"],
    ]) {
      const refused = await cli.run([
        ...command,
        "--project",
        PLAN.project_id,
        "--environment",
        environmentId,
        "--domain",
        MAIL_DOMAIN.domain,
        "--sending",
        "false",
        "--receiving",
        "false",
        "--idempotency-key",
        "mail-receive-only",
        "--json",
      ]);
      expect(refused.exitCode, command.join(" ")).toBe(2);
    }
    expect(managedMail).not.toHaveBeenCalled();
  });

  it("rotates the Prod mail webhook secret only with --yes and a key, and shows the secret once", async () => {
    const environmentId = "01H00000000000000000000602";
    const rotated = {
      url: "https://app.example.com/mail",
      signing_secret: `whsec_${"A".repeat(43)}=`,
      status: "verification_required",
    };
    const managedMail = vi.fn(async () => rotated);
    const { cli } = createCli({ api: { managedMail } });
    const argv = [
      "mail",
      "webhook",
      "rotate",
      "--project",
      PLAN.project_id,
      "--environment",
      environmentId,
      "--idempotency-key",
      "mail-rotate-a",
      "--json",
    ];
    // Rotation ends receiving and stops the current secret at once, so --yes is required.
    expect((await cli.run(argv)).exitCode).toBe(2);
    expect(managedMail).not.toHaveBeenCalled();
    const done = await cli.run([...argv, "--yes"]);
    expect(done.exitCode).toBe(0);
    expect(managedMail).toHaveBeenCalledWith({
      action: "webhook_rotate",
      projectId: PLAN.project_id,
      environmentId,
      idempotencyKey: "mail-rotate-a",
    });
    expect(JSON.parse(done.stdout)).toMatchObject({
      command: "mail webhook rotate",
      mail: rotated,
    });
    // The route needs its key, so a rotation without one is refused.
    const keyless = argv.slice(0, argv.indexOf("--idempotency-key"));
    expect((await cli.run([...keyless, "--yes", "--json"])).exitCode).toBe(2);
    // Rotation takes only its project, environment, key and --yes: a stray option is refused, not dropped.
    for (const stray of [
      ["--url", "https://app.example.com/mail"],
      ["--domain", MAIL_DOMAIN.domain],
    ])
      expect((await cli.run([...argv, ...stray, "--yes"])).exitCode).toBe(2);
    expect(managedMail).toHaveBeenCalledTimes(1);
    // Setting the endpoint still refuses --yes: only rotation and retirement are confirmed this way.
    expect(
      (
        await cli.run([
          "mail",
          "webhook",
          "set",
          "--project",
          PLAN.project_id,
          "--environment",
          environmentId,
          "--url",
          "https://app.example.com/mail",
          "--idempotency-key",
          "mail-set-a",
          "--yes",
          "--json",
        ])
      ).exitCode,
    ).toBe(2);
    expect(managedMail).toHaveBeenCalledTimes(1);
  });

  it("authorizes, reads, and applies Cloudflare project domains with the existing waiter", async () => {
    const { cli, api } = createCli();
    const authorization = await cli.run([
      "domain",
      "cloudflare",
      "authorize",
      "--project",
      PLAN.project_id,
      "--zone",
      "aixyte.com",
      "--idempotency-key",
      "cloudflare-auth-a",
      "--json",
    ]);
    const status = await cli.run([
      "domain",
      "cloudflare",
      "status",
      "--project",
      PLAN.project_id,
      "--json",
    ]);
    const applied = await cli.run([
      "domain",
      "cloudflare",
      "apply",
      "--project",
      PLAN.project_id,
      "--idempotency-key",
      "domains-apply-a",
      "--yes",
      "--wait",
      "--json",
    ]);

    expect(api.authorizeCloudflareDns).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      zone: "aixyte.com",
      idempotencyKey: "cloudflare-auth-a",
    });
    expect(api.getCloudflareDnsStatus).toHaveBeenCalledWith(PLAN.project_id);
    expect(api.applyProjectDomains).toHaveBeenCalledWith({
      projectId: PLAN.project_id,
      idempotencyKey: "domains-apply-a",
    });
    expect(api.getOperation).toHaveBeenCalledWith(OPERATION.id);
    expect(JSON.parse(authorization.stdout)).toEqual({
      version: 1,
      command: "domain cloudflare authorize",
      status: "authorization_required",
      authorization: CLOUDFLARE_AUTHORIZATION,
    });
    expect(JSON.parse(status.stdout)).toEqual({
      version: 1,
      command: "domain cloudflare status",
      status: "authorized",
      cloudflare_dns: CLOUDFLARE_DNS_STATUS,
    });
    expect(JSON.parse(applied.stdout)).toEqual({
      version: 1,
      command: "domain cloudflare apply",
      status: "completed",
      operation: TERMINAL,
    });
  });

  it("rejects a non-canonical sender domain before authentication or API access", async () => {
    const { cli, api } = createCli();
    const result = await cli.run([
      "mail",
      "domain",
      "set",
      "--project",
      PLAN.project_id,
      "--domain",
      "Mail.Example.COM",
      "--idempotency-key",
      "mail-domain-a",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(api.managedMail).not.toHaveBeenCalled();
  });

  it("prints one database credential exactly once and lists only its metadata later", async () => {
    const { cli, api } = createCli({
      api: {
        createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL),
        listProjectDatabaseAccess: vi.fn(async () => ({ items: [DATABASE_ACCESS] })),
        revokeProjectDatabaseAccess: vi.fn(async () => ({
          ...DATABASE_ACCESS,
          state: "revoked" as const,
          revoked_at: DATABASE_ACCESS.expires_at,
          revocation_reason: "principal" as const,
        })),
      },
    });

    const created = await cli.run([
      "database",
      "access",
      "create",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--ttl",
      "30m",
      "--label",
      "laptop",
      "--yes",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      version: 1,
      command: "database access create",
      status: "succeeded",
      access: DATABASE_CREDENTIAL,
    });
    expect(api.createProjectDatabaseAccess).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      environment: "dev",
      mode: "read",
      ttlSeconds: 1_800,
      label: "laptop",
    });

    const listed = await cli.run([
      "database",
      "access",
      "list",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--json",
    ]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).not.toContain("connection_uri");
    expect(JSON.parse(listed.stdout)).toMatchObject({ access: [DATABASE_ACCESS] });

    const revoked = await cli.run([
      "database",
      "access",
      "revoke",
      "--project",
      PROJECT_ID,
      "--access",
      DATABASE_ACCESS.access_id,
      "--yes",
      "--json",
    ]);
    expect(revoked.exitCode).toBe(0);
    expect(JSON.parse(revoked.stdout)).toMatchObject({
      command: "database access revoke",
      access: { state: "revoked", revocation_reason: "principal" },
    });
  });

  it("answers a timed out database access create without telling the caller to reuse a key", async () => {
    const { cli } = createCli({
      api: {
        createProjectDatabaseAccess: async () => {
          throw new DOMException("The request timed out.", "TimeoutError");
        },
      },
    });

    const result = await cli.run([
      "database",
      "access",
      "create",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--yes",
      "--json",
    ]);

    expect(result.exitCode).toBe(8);
    const document = JSON.parse(result.stdout) as {
      error: { code: string; suggested_action: string };
    };
    expect(document.error.code).toBe("request_timeout");
    expect(document.error.suggested_action).toContain("check its current state first");
    expect(document.error.suggested_action).not.toContain("--idempotency-key");
  });

  it("answers a keyless webhook replay that timed out, was cancelled or answered out of contract by checking its state first", async () => {
    const actionOf = (stdout: string) =>
      (JSON.parse(stdout) as { error: { suggested_action: string } }).error.suggested_action;
    const replay = [
      "database",
      "webhook",
      "replay",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--delivery",
      "dlv_0123456789abcdef0123",
      "--yes",
      "--json",
    ];
    const { cli } = createCli({
      api: {
        replayProjectDatabaseWebhookDelivery: async () => {
          throw new DOMException("The request timed out.", "TimeoutError");
        },
      },
    });

    const timedOut = await cli.run(replay);
    expect(timedOut.exitCode).toBe(8);
    expect(actionOf(timedOut.stdout)).toContain("check its current state first");
    expect(actionOf(timedOut.stdout)).not.toContain("run the same command again");
    expect(actionOf(timedOut.stdout)).not.toContain("--idempotency-key");

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await cli.run(replay, aborted.signal);
    expect(cancelled.exitCode).toBe(130);
    expect(JSON.parse(cancelled.stdout)).toMatchObject({
      error: { code: "command_cancelled" },
    });
    expect(actionOf(cancelled.stdout)).toContain("check its current state first");
    expect(actionOf(cancelled.stdout)).not.toContain("--idempotency-key");

    const { cli: outOfContract } = createCli({
      api: {
        replayProjectDatabaseWebhookDelivery: async () => {
          throw new ResponseContractError();
        },
      },
    });
    const invalid = await outOfContract.run(replay);
    expect(invalid.exitCode).toBe(7);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: { code: "response_contract_invalid" },
    });
    expect(actionOf(invalid.stdout)).toContain("check its current state first");
    expect(actionOf(invalid.stdout)).not.toContain("--idempotency-key");
  });

  it("names the same-key retry after a token refresh timeout only for a keyed command", async () => {
    const actionOf = (stdout: string) =>
      (JSON.parse(stdout) as { error: { suggested_action: string } }).error.suggested_action;
    const { cli } = createCli({
      credentialExpiresAt: "2026-08-17T23:59:00.000Z",
      tokenRefresher: {
        refresh: async () => {
          throw new DOMException("The request timed out.", "TimeoutError");
        },
      },
    });

    const keyed = await cli.run([
      "project",
      "create",
      "--organization",
      PROJECT_ID,
      "--name",
      "Keyed",
      "--idempotency-key",
      "project-a",
      "--json",
    ]);
    expect(keyed.exitCode).toBe(8);
    expect(JSON.parse(keyed.stdout)).toMatchObject({
      error: { code: "request_timeout", retryable: true },
    });
    expect(actionOf(keyed.stdout)).toContain("--idempotency-key");

    const keyless = await cli.run([
      "database",
      "webhook",
      "list",
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(keyless.exitCode).toBe(8);
    expect(JSON.parse(keyless.stdout)).toMatchObject({
      error: { code: "request_timeout", retryable: true },
    });
    expect(actionOf(keyless.stdout)).not.toContain("--idempotency-key");
  });

  it("creates, lists and deletes database watches; create prints the event type to subscribe to and needs --yes", async () => {
    const WATCH = {
      id: "pgcf_watch_0a1b2c3d",
      environment: "prod" as const,
      schema: "public",
      table: "orders",
      columns: ["id", "total"],
      operations: ["insert", "update", "delete"] as const,
      topic: "orders",
      event_type: "data.orders" as const,
    };
    const { cli, api } = createCli({
      api: {
        createProjectDatabaseWatch: vi.fn(async () => WATCH),
        listProjectDatabaseWatches: vi.fn(async () => ({ items: [WATCH] })),
        deleteProjectDatabaseWatch: vi.fn(async () => ({ id: WATCH.id, deleted: true as const })),
      },
    });

    const created = await cli.run([
      "database",
      "watch",
      "create",
      "--project",
      PROJECT_ID,
      "--environment",
      "prod",
      "--table",
      "orders",
      "--columns",
      "id,total",
      "--idempotency-key",
      "watch-a",
      "--yes",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const body = JSON.parse(created.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      command: "database watch create",
      status: "succeeded",
      watch: WATCH,
    });
    expect(String(body["next_action"])).toContain(
      `database webhook create --project ${PROJECT_ID} --environment prod`,
    );
    expect(String(body["next_action"])).toContain("--event-types data.orders");
    expect(api.createProjectDatabaseWatch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      environment: "prod",
      idempotencyKey: "watch-a",
      request: {
        schema: "public",
        table: "orders",
        columns: ["id", "total"],
        operations: ["insert", "update", "delete"],
      },
    });

    const listed = await cli.run(["database", "watch", "list", "--project", PROJECT_ID, "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual({
      version: 1,
      command: "database watch list",
      status: "succeeded",
      watch: [WATCH],
    });
    expect(api.listProjectDatabaseWatches).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      environment: "dev",
    });

    const listedProd = await cli.run([
      "database",
      "watch",
      "list",
      "--project",
      PROJECT_ID,
      "--environment",
      "prod",
      "--json",
    ]);
    expect(listedProd.exitCode).toBe(0);
    expect(api.listProjectDatabaseWatches).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      environment: "prod",
    });

    const deleted = await cli.run([
      "database",
      "watch",
      "delete",
      "--project",
      PROJECT_ID,
      "--environment",
      "prod",
      "--watch",
      WATCH.id,
      "--idempotency-key",
      "watch-b",
      "--yes",
      "--json",
    ]);
    expect(JSON.parse(deleted.stdout)).toEqual({
      version: 1,
      command: "database watch delete",
      status: "succeeded",
      deleted: { id: WATCH.id, deleted: true },
    });
    expect(api.deleteProjectDatabaseWatch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      environment: "prod",
      idempotencyKey: "watch-b",
      watchId: WATCH.id,
    });

    const unconfirmed = await cli.run([
      "database",
      "watch",
      "create",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--table",
      "orders",
      "--columns",
      "id",
      "--idempotency-key",
      "watch-c",
      "--json",
    ]);
    expect(unconfirmed.exitCode).toBe(2);
    expect(JSON.parse(unconfirmed.stdout)).toMatchObject({ error: { code: "invalid_command" } });
    expect(JSON.parse(unconfirmed.stdout).error.suggested_action).toContain(
      "ohmyhost database watch create",
    );
    expect(api.createProjectDatabaseWatch).toHaveBeenCalledTimes(1);
  });

  it("creates a table once from a columns file, and refuses a bad columns file before any request", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const TABLE = {
      environment: "dev",
      schema: "public",
      table: "orders",
      columns: [
        { name: "id", type: "bigint", nullable: false, identity: true, default: null },
        { name: "status", type: "text", nullable: false, identity: false, default: null },
      ],
      primary_key: ["id"],
      created: true,
    } as const;
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-table-"));
    try {
      const columnsFile = join(directory, "columns.json");
      await writeFile(
        columnsFile,
        JSON.stringify([
          { name: "id", type: "bigint", identity: true },
          { name: "status", type: "text", nullable: false },
        ]),
      );
      const { cli, api } = createCli({
        api: { createProjectDatabaseTable: vi.fn(async () => ({ table: TABLE })) },
      });

      const created = await cli.run([
        "database",
        "table",
        "create",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--table",
        "orders",
        "--columns-file",
        columnsFile,
        "--primary-key",
        "id",
        "--idempotency-key",
        "table-a",
        "--yes",
        "--json",
      ]);
      expect(created.exitCode).toBe(0);
      expect(JSON.parse(created.stdout)).toEqual({
        version: 1,
        command: "database table create",
        status: "succeeded",
        table: TABLE,
      });
      expect(api.createProjectDatabaseTable).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
        idempotencyKey: "table-a",
        request: {
          table: "orders",
          columns: [
            { name: "id", type: "bigint", nullable: false, identity: true },
            { name: "status", type: "text", nullable: false, identity: false },
          ],
          primaryKey: ["id"],
        },
      });

      // Each file is refused before any request, and the answer never echoes its content.
      const refusals: Record<string, string> = {
        "not-json.json": "[",
        "object.json": '{"name": "id"}',
        "binary.json": "\u0000\u0001",
        "unknown-type.json": '[{"name": "id", "type": "varchar"}]',
        "bad-name.json": '[{"name": "Order Id", "type": "text"}]',
        "duplicate.json": '[{"name": "id", "type": "text"}, {"name": "id", "type": "text"}]',
        "identity-text.json": '[{"name": "id", "type": "text", "identity": true}]',
        "default-mismatch.json": '[{"name": "id", "type": "text", "default": "now"}]',
        "empty.json": "[]",
        "oversize.json": `[${'{"name": "id", "type": "text"},'.repeat(3000)}{"name": "x", "type": "text"}]`,
      };
      for (const [name, body] of Object.entries(refusals)) {
        await writeFile(join(directory, name), body);
        const refused = await cli.run([
          "database",
          "table",
          "create",
          "--project",
          PROJECT_ID,
          "--environment",
          "dev",
          "--table",
          "orders",
          "--columns-file",
          join(directory, name),
          "--idempotency-key",
          `table-${name}`,
          "--yes",
          "--json",
        ]);
        expect(refused.exitCode, name).toBe(2);
        expect(JSON.parse(refused.stdout), name).toMatchObject({
          error: { code: "columns_file_invalid", retryable: false },
        });
        expect(refused.stdout, name).not.toContain("Order Id");
      }
      const missing = await cli.run([
        "database",
        "table",
        "create",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--table",
        "orders",
        "--columns-file",
        join(directory, "missing.json"),
        "--idempotency-key",
        "table-missing",
        "--yes",
        "--json",
      ]);
      expect(missing.exitCode).toBe(2);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        error: { code: "columns_file_invalid" },
      });
      const unknownPrimaryKey = await cli.run([
        "database",
        "table",
        "create",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--table",
        "orders",
        "--columns-file",
        columnsFile,
        "--primary-key",
        "absent",
        "--idempotency-key",
        "table-key",
        "--yes",
        "--json",
      ]);
      expect(unknownPrimaryKey.exitCode).toBe(2);
      expect(JSON.parse(unknownPrimaryKey.stdout)).toMatchObject({
        error: { code: "columns_file_invalid" },
      });
      expect(api.createProjectDatabaseTable).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a refused watch as its policy code with the fixed action and no retry", async () => {
    const action = PROBLEM_POLICY.database_watch_column_unavailable.action;
    const { cli } = createCli({
      api: {
        createProjectDatabaseWatch: vi.fn(() =>
          Promise.reject({
            type: "https://docs.ohmyho.st/errors/database-watch-column-unavailable",
            title: PROBLEM_POLICY.database_watch_column_unavailable.title,
            status: 409,
            code: "database_watch_column_unavailable",
            request_id: "request-watch",
            detail: "A listed column does not exist in the table.",
            retryable: false,
            suggested_action: action,
          }),
        ),
      },
    });

    const result = await cli.run([
      "database",
      "watch",
      "create",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--table",
      "orders",
      "--columns",
      "missing",
      "--idempotency-key",
      "watch-d",
      "--yes",
      "--json",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "database_watch_column_unavailable",
        retryable: false,
        suggested_action: action,
      },
    });
  });

  it("creates a webhook once with its secret, reads it back without the secret, and changes it only with --yes", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const WEBHOOK = {
      id: "whk_abcdefghijklmnopqrst",
      environment: "dev" as const,
      url: "https://hooks.example.com/pg",
      event_types: ["database.ready" as const],
      header_names: ["x-tenant"],
      created_at: "2026-10-31T10:00:00.000Z",
    };
    const DELIVERY_ID = "dlv_0123456789abcdef0123";
    const { readFile, stat, symlink } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-webhook-"));
    try {
      const headersFile = join(directory, "headers.json");
      await writeFile(headersFile, JSON.stringify({ "x-tenant": "alpha" }), { mode: 0o600 });
      const privateRequest = {
        url: WEBHOOK.url,
        eventTypes: ["database.ready" as const],
      };
      await expect(
        readPrivateWebhookCreateRequest({ ...privateRequest, headersFile: null }),
      ).resolves.toEqual({ url: WEBHOOK.url, event_types: ["database.ready"], headers: {} });
      await expect(
        readPrivateWebhookCreateRequest({ ...privateRequest, headersFile }),
      ).resolves.toEqual({
        url: WEBHOOK.url,
        event_types: ["database.ready"],
        headers: { "x-tenant": "alpha" },
      });
      const arrayFile = join(directory, "array.json");
      await writeFile(arrayFile, "[1, 2]");
      const { cli, api } = createCli({
        api: {
          createProjectDatabaseWebhook: vi.fn(async () => ({
            ...WEBHOOK,
            secret: "whsec_fixture",
          })),
          listProjectDatabaseWebhooks: vi.fn(async () => ({ items: [WEBHOOK] })),
          getProjectDatabaseWebhook: vi.fn(async () => WEBHOOK),
          deleteProjectDatabaseWebhook: vi.fn(async () => ({
            id: WEBHOOK.id,
            deleted: true as const,
          })),
          testProjectDatabaseWebhook: vi.fn(async () => ({
            delivered: true,
            status: 204,
            error: null,
            duration_ms: 42,
          })),
          listProjectDatabaseWebhookDeliveries: vi.fn(async () => ({
            items: [],
            next_cursor: "next-a",
          })),
          replayProjectDatabaseWebhookDelivery: vi.fn(async () => ({
            delivery_id: DELIVERY_ID,
            state: "pending" as const,
          })),
          getDatabaseWebhookSubscription: vi.fn(async () => ({
            id: PROJECT_ID,
            environment: "dev" as const,
            state: "active" as const,
            generation: 1,
            provider_id: WEBHOOK.id,
          })),
          activateDatabaseWebhookSubscription: vi.fn(async () => ({
            id: PROJECT_ID,
            environment: "dev" as const,
            state: "active" as const,
            generation: 1,
            provider_id: WEBHOOK.id,
            secret: "whsec_fixture_secret",
          })),
          deactivateDatabaseWebhookSubscription: vi.fn(async () => ({
            id: PROJECT_ID,
            environment: "dev" as const,
            state: "inactive" as const,
            generation: 1,
            provider_id: WEBHOOK.id,
          })),
        },
      });

      const created = await cli.run([
        "database",
        "webhook",
        "create",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--url",
        WEBHOOK.url,
        "--event-types",
        "database.ready",
        "--headers-file",
        headersFile,
        "--idempotency-key",
        "hook-a",
        "--yes",
        "--json",
      ]);
      expect(created.exitCode).toBe(0);
      expect(JSON.parse(created.stdout)).toEqual({
        version: 1,
        command: "database webhook create",
        status: "succeeded",
        webhook: { ...WEBHOOK, secret: "whsec_fixture" },
      });
      expect(api.createProjectDatabaseWebhook).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
        idempotencyKey: "hook-a",
        url: WEBHOOK.url,
        eventTypes: ["database.ready"],
        headers: { "x-tenant": "alpha" },
      });
      const scope = ["database", "webhook", "subscription"];
      const secretFile = join(directory, "subscription.secret");
      const identity = [
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--subscription",
        PROJECT_ID,
      ];
      const activated = await cli.run([
        ...scope,
        "activate",
        ...identity,
        "--generation",
        "1",
        "--url",
        WEBHOOK.url,
        "--event-types",
        "database.ready",
        "--headers-file",
        headersFile,
        "--out",
        secretFile,
        "--idempotency-key",
        "subscription-a",
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(activated.stdout)).toMatchObject({
        status: "succeeded",
        subscription: { generation: 1 },
        secret_file: secretFile,
      });
      expect(activated.stdout).not.toContain("whsec_fixture_secret");
      expect(await readFile(secretFile, "utf8")).toBe("whsec_fixture_secret");
      expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
      expect(api.activateDatabaseWebhookSubscription).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
        subscriptionId: PROJECT_ID,
        generation: 1,
        idempotencyKey: "subscription-a",
        request: {
          url: WEBHOOK.url,
          event_types: ["database.ready"],
          headers: { "x-tenant": "alpha" },
        },
      });
      const status = await cli.run([...scope, "status", ...identity, "--json"]);
      expect(JSON.parse(status.stdout)).toMatchObject({
        subscription: { state: "active", generation: 1 },
      });
      const inactive = await cli.run([
        ...scope,
        "deactivate",
        ...identity,
        "--generation",
        "1",
        "--idempotency-key",
        "subscription-off",
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(inactive.stdout)).toMatchObject({ subscription: { state: "inactive" } });
      expect(api.deactivateDatabaseWebhookSubscription).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
        subscriptionId: PROJECT_ID,
        generation: 1,
        idempotencyKey: "subscription-off",
      });
      for (const overrides of [
        ["--generation", "0", "--event-types", "database.ready"],
        ["--generation", "1", "--event-types", "database.ready,database.ready"],
      ]) {
        const invalid = await cli.run([
          ...scope,
          "activate",
          ...identity,
          ...overrides,
          "--url",
          WEBHOOK.url,
          "--out",
          join(directory, "invalid.secret"),
          "--idempotency-key",
          "invalid",
          "--yes",
          "--json",
        ]);
        expect(invalid.exitCode).not.toBe(0);
      }
      const linked = join(directory, "linked.secret");
      await symlink(secretFile, linked);
      for (const unsafe of [secretFile, linked]) {
        const refused = await cli.run([
          ...scope,
          "activate",
          ...identity,
          "--generation",
          "1",
          "--url",
          WEBHOOK.url,
          "--event-types",
          "database.ready",
          "--out",
          unsafe,
          "--idempotency-key",
          "subscription-a",
          "--yes",
          "--json",
        ]);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stdout).not.toContain("whsec_fixture_secret");
      }
      expect(api.activateDatabaseWebhookSubscription).toHaveBeenCalledTimes(1);

      const invalidHeaders = await cli.run([
        "database",
        "webhook",
        "create",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--url",
        WEBHOOK.url,
        "--event-types",
        "database.ready",
        "--headers-file",
        arrayFile,
        "--idempotency-key",
        "hook-b",
        "--yes",
        "--json",
      ]);
      expect(invalidHeaders.exitCode).toBe(2);
      expect(JSON.parse(invalidHeaders.stdout)).toMatchObject({
        error: { code: "headers_file_invalid" },
      });
      expect(api.createProjectDatabaseWebhook).toHaveBeenCalledTimes(1);

      // The file limit is 8 KiB. Whitespace pads a valid object past it, because a single header
      // value is already capped at 512 characters: 8,193 bytes, malformed JSON, non-UTF-8 bytes and
      // a missing file are refused before any create request; exactly 8,192 bytes is accepted.
      const paddedHeaders = (bytes: number) =>
        JSON.stringify({ "x-tenant": "alpha" }).padEnd(bytes, " ");
      const oversizeFile = join(directory, "oversize.json");
      await writeFile(oversizeFile, paddedHeaders(8_193));
      const boundaryFile = join(directory, "boundary.json");
      await writeFile(boundaryFile, paddedHeaders(8_192));
      const malformedFile = join(directory, "malformed.json");
      await writeFile(malformedFile, '{"x-tenant": ');
      const binaryFile = join(directory, "binary.json");
      await writeFile(binaryFile, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
      for (const [index, path] of [
        oversizeFile,
        malformedFile,
        binaryFile,
        join(directory, "missing.json"),
      ].entries()) {
        const refused = await cli.run([
          "database",
          "webhook",
          "create",
          "--project",
          PROJECT_ID,
          "--environment",
          "dev",
          "--url",
          WEBHOOK.url,
          "--event-types",
          "database.ready",
          "--headers-file",
          path,
          "--idempotency-key",
          `hook-refused-${index}`,
          "--yes",
          "--json",
        ]);
        expect(refused.exitCode).toBe(2);
        expect(JSON.parse(refused.stdout)).toMatchObject({
          error: { code: "headers_file_invalid" },
        });
      }
      expect(api.createProjectDatabaseWebhook).toHaveBeenCalledTimes(1);
      const boundary = await cli.run([
        "database",
        "webhook",
        "create",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--url",
        WEBHOOK.url,
        "--event-types",
        "database.ready",
        "--headers-file",
        boundaryFile,
        "--idempotency-key",
        "hook-boundary",
        "--yes",
        "--json",
      ]);
      expect(boundary.exitCode).toBe(0);
      expect(api.createProjectDatabaseWebhook).toHaveBeenCalledTimes(2);

      const listed = await cli.run([
        "database",
        "webhook",
        "list",
        "--project",
        PROJECT_ID,
        "--json",
      ]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).not.toContain("whsec_fixture");
      expect(JSON.parse(listed.stdout)).toMatchObject({
        command: "database webhook list",
        webhook: [WEBHOOK],
      });
      expect(api.listProjectDatabaseWebhooks).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
      });

      const fetched = await cli.run([
        "database",
        "webhook",
        "get",
        "--project",
        PROJECT_ID,
        "--webhook",
        WEBHOOK.id,
        "--json",
      ]);
      expect(JSON.parse(fetched.stdout)).toMatchObject({
        command: "database webhook get",
        webhook: WEBHOOK,
      });

      const refusedDelete = await cli.run([
        "database",
        "webhook",
        "delete",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--webhook",
        WEBHOOK.id,
        "--json",
      ]);
      expect(refusedDelete.exitCode).toBe(2);
      expect(api.deleteProjectDatabaseWebhook).not.toHaveBeenCalled();

      const deleted = await cli.run([
        "database",
        "webhook",
        "delete",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--webhook",
        WEBHOOK.id,
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        command: "database webhook delete",
        deleted: { id: WEBHOOK.id, deleted: true },
      });

      const tested = await cli.run([
        "database",
        "webhook",
        "test",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--webhook",
        WEBHOOK.id,
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(tested.stdout)).toMatchObject({
        command: "database webhook test",
        result: { delivered: true, status: 204 },
      });

      const deliveries = await cli.run([
        "database",
        "webhook",
        "deliveries",
        "--project",
        PROJECT_ID,
        "--webhook",
        WEBHOOK.id,
        "--limit",
        "5",
        "--cursor",
        "cursor-a",
        "--json",
      ]);
      expect(JSON.parse(deliveries.stdout)).toMatchObject({
        command: "database webhook deliveries",
        delivery: [],
        next_cursor: "next-a",
      });
      expect(api.listProjectDatabaseWebhookDeliveries).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
        webhookId: WEBHOOK.id,
        limit: 5,
        cursor: "cursor-a",
      });

      const replayed = await cli.run([
        "database",
        "webhook",
        "replay",
        "--project",
        PROJECT_ID,
        "--environment",
        "dev",
        "--delivery",
        DELIVERY_ID,
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        command: "database webhook replay",
        replay: { delivery_id: DELIVERY_ID, state: "pending" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sets a schedule from a statements file, reads and runs it, and reads execution usage only with --yes for changes", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const SCHEDULE = {
      name: "tick",
      environment: "dev" as const,
      cron: null,
      every_seconds: 60,
      statements: ["UPDATE ticks SET n = n + 1"],
      timeout_ms: 10_000,
      enabled: true,
      next_run_at: "2026-10-31T10:01:00.000Z",
      created_at: "2026-10-31T10:00:00.000Z",
    };
    const RUN = {
      id: 7,
      schedule: "tick",
      scheduled_at: "2026-10-31T10:01:00.000Z",
      started_at: "2026-10-31T10:01:00.100Z",
      finished_at: "2026-10-31T10:01:00.150Z",
      outcome: "succeeded" as const,
      sqlstate: null,
      attempts: 1,
      manual: false,
    };
    const USAGE_ROW = {
      start: "2026-10-30T00:00:00.000Z",
      end: "2026-10-30T01:00:00.000Z",
      final: true,
      metrics: {
        schedule_runs_succeeded: 60,
        schedule_runs_failed: 0,
        schedule_runs_timed_out: 0,
        schedule_runs_outcome_unknown: 0,
        schedule_runs_rejected: 0,
        schedule_runs_skipped: 0,
        events_emitted: 0,
        event_bytes: 0,
        webhook_attempts: 0,
        webhook_deliveries_delivered: 0,
        webhook_deliveries_dead_lettered: 0,
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-schedule-"));
    try {
      const statementsFile = join(directory, "statements.json");
      await writeFile(statementsFile, JSON.stringify(SCHEDULE.statements));
      const TWO_STATEMENTS = ["UPDATE ticks SET n = n + 1", "DELETE FROM ticks WHERE n > 100"];
      const twoStatementsFile = join(directory, "two-statements.json");
      await writeFile(twoStatementsFile, JSON.stringify(TWO_STATEMENTS));
      const blankFile = join(directory, "blank.json");
      await writeFile(blankFile, JSON.stringify(["   "]));
      const malformedFile = join(directory, "malformed.json");
      await writeFile(malformedFile, "[");
      const emptyArrayFile = join(directory, "empty-array.json");
      await writeFile(emptyArrayFile, "[]");
      const objectFile = join(directory, "object.json");
      await writeFile(objectFile, "{}");
      const numberFile = join(directory, "number.json");
      await writeFile(numberFile, "[1]");
      const tooManyFile = join(directory, "too-many.json");
      await writeFile(tooManyFile, JSON.stringify(Array.from({ length: 21 }, () => "SELECT 1")));
      const nulFile = join(directory, "nul.json");
      await writeFile(nulFile, JSON.stringify(["SELECT 1\u0000"]));
      const longStatementFile = join(directory, "long-statement.json");
      await writeFile(longStatementFile, JSON.stringify(["x".repeat(17_000)]));
      const oversizeFile = join(directory, "oversize.json");
      await writeFile(
        oversizeFile,
        JSON.stringify(["UPDATE ticks SET n = n + 1"]).padEnd(65_537, " "),
      );
      const { cli, api } = createCli({
        api: {
          setProjectDatabaseSchedule: vi.fn(async () => SCHEDULE),
          listProjectDatabaseSchedules: vi.fn(async () => ({ items: [SCHEDULE] })),
          getProjectDatabaseSchedule: vi.fn(async () => SCHEDULE),
          deleteProjectDatabaseSchedule: vi.fn(async () => ({
            name: "tick",
            deleted: true as const,
          })),
          listProjectDatabaseScheduleRuns: vi.fn(async () => ({ items: [RUN] })),
          runProjectDatabaseSchedule: vi.fn(async () => ({
            schedule: "tick",
            state: "queued" as const,
          })),
          getProjectDatabaseExecutionUsage: vi.fn(async () => ({
            items: [USAGE_ROW],
            next_cursor: null,
          })),
        },
      });
      const setArguments = (path: string, cadence: readonly string[] = ["--every-seconds", "60"]) =>
        [
          "database",
          "schedule",
          "set",
          "--project",
          PROJECT_ID,
          "--environment",
          "dev",
          "--name",
          "tick",
          ...cadence,
          "--statements-file",
          path,
          "--yes",
          "--json",
        ] as const;

      for (const path of [
        blankFile,
        malformedFile,
        emptyArrayFile,
        objectFile,
        numberFile,
        tooManyFile,
        nulFile,
        longStatementFile,
        oversizeFile,
        join(directory, "missing.json"),
      ]) {
        const refused = await cli.run([...setArguments(path)]);
        expect(refused.exitCode).toBe(2);
        expect(JSON.parse(refused.stdout)).toMatchObject({
          error: { code: "statements_file_invalid" },
        });
      }
      const badCadence = await cli.run([...setArguments(statementsFile, ["--cron", "* *"])]);
      expect(badCadence.exitCode).toBe(2);
      expect(JSON.parse(badCadence.stdout)).toMatchObject({
        error: { code: "schedule_invalid" },
      });
      expect(api.setProjectDatabaseSchedule).not.toHaveBeenCalled();

      const refusedSet = await cli.run([
        "database",
        "schedule",
        "set",
        "--project",
        PROJECT_ID,
        "--name",
        "tick",
        "--every-seconds",
        "60",
        "--statements-file",
        statementsFile,
        "--json",
      ]);
      expect(refusedSet.exitCode).toBe(2);
      expect(api.setProjectDatabaseSchedule).not.toHaveBeenCalled();

      const set = await cli.run([...setArguments(statementsFile)]);
      expect(set.exitCode).toBe(0);
      expect(JSON.parse(set.stdout)).toEqual({
        version: 1,
        command: "database schedule set",
        status: "succeeded",
        schedule: SCHEDULE,
      });
      expect(api.setProjectDatabaseSchedule).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
        name: "tick",
        request: {
          cron: null,
          every_seconds: 60,
          statements: SCHEDULE.statements,
          timeout_ms: 10_000,
          enabled: true,
        },
      });

      const customSet = await cli.run([
        "database",
        "schedule",
        "set",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--cron",
        "*/5 * * * *",
        "--statements-file",
        twoStatementsFile,
        "--timeout-ms",
        "5000",
        "--enabled",
        "false",
        "--yes",
        "--json",
      ]);
      expect(customSet.exitCode).toBe(0);
      expect(api.setProjectDatabaseSchedule).toHaveBeenLastCalledWith({
        projectId: PROJECT_ID,
        environment: "prod",
        name: "nightly_cleanup",
        request: {
          cron: "*/5 * * * *",
          every_seconds: null,
          statements: TWO_STATEMENTS,
          timeout_ms: 5000,
          enabled: false,
        },
      });

      const listed = await cli.run([
        "database",
        "schedule",
        "list",
        "--project",
        PROJECT_ID,
        "--json",
      ]);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        command: "database schedule list",
        schedule: [SCHEDULE],
      });
      expect(api.listProjectDatabaseSchedules).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "dev",
      });

      const fetched = await cli.run([
        "database",
        "schedule",
        "get",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--json",
      ]);
      expect(JSON.parse(fetched.stdout)).toMatchObject({
        command: "database schedule get",
        schedule: SCHEDULE,
      });
      expect(api.getProjectDatabaseSchedule).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "prod",
        name: "nightly_cleanup",
      });

      const runs = await cli.run([
        "database",
        "schedule",
        "runs",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--limit",
        "5",
        "--json",
      ]);
      expect(JSON.parse(runs.stdout)).toMatchObject({
        command: "database schedule runs",
        schedule_run: [RUN],
      });
      expect(api.listProjectDatabaseScheduleRuns).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "prod",
        name: "nightly_cleanup",
        limit: 5,
      });

      const refusedRun = await cli.run([
        "database",
        "schedule",
        "run",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--json",
      ]);
      expect(refusedRun.exitCode).toBe(2);
      expect(api.runProjectDatabaseSchedule).not.toHaveBeenCalled();

      const ran = await cli.run([
        "database",
        "schedule",
        "run",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(ran.stdout)).toMatchObject({
        command: "database schedule run",
        run: { schedule: "tick", state: "queued" },
      });
      expect(api.runProjectDatabaseSchedule).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "prod",
        name: "nightly_cleanup",
      });

      const deleted = await cli.run([
        "database",
        "schedule",
        "delete",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--yes",
        "--json",
      ]);
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        command: "database schedule delete",
        deleted: { name: "tick", deleted: true },
      });
      expect(api.deleteProjectDatabaseSchedule).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "prod",
        name: "nightly_cleanup",
      });

      const usage = await cli.run([
        "database",
        "executions",
        "--project",
        PROJECT_ID,
        "--environment",
        "prod",
        "--from",
        USAGE_ROW.start,
        "--to",
        "2026-10-31T00:00:00.000Z",
        "--granularity",
        "day",
        "--limit",
        "10",
        "--cursor",
        "abc|1",
        "--json",
      ]);
      expect(usage.exitCode).toBe(0);
      expect(JSON.parse(usage.stdout)).toEqual({
        version: 1,
        command: "database executions",
        status: "succeeded",
        usage: [USAGE_ROW],
        next_cursor: null,
      });
      expect(api.getProjectDatabaseExecutionUsage).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        environment: "prod",
        from: USAGE_ROW.start,
        to: "2026-10-31T00:00:00.000Z",
        granularity: "day",
        limit: 10,
        cursor: "abc|1",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revokes the temporary psql credential on the wire after the process was interrupted", async () => {
    const controller = new AbortController();
    const sent: string[] = [];
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("{}", { headers: { "content-type": "application/json" }, status: 500 });
    }) as typeof globalThis.fetch;
    const { cli } = createCli({
      api: { createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL) },
      revocationFetch: recordingFetch,
      spawnPsql: async () => {
        // The process signal is aborted by Ctrl-C or SIGTERM while psql runs.
        controller.abort(new DOMException("Cancelled", "AbortError"));
        throw new DOMException("Cancelled", "AbortError");
      },
    });

    const result = await cli.run(
      ["database", "psql", "--project", PROJECT_ID, "--environment", "dev", "--mode", "write"],
      controller.signal,
    );

    expect(result.exitCode).toBe(130);
    expect(sent).toEqual([
      `DELETE /v1/projects/${PROJECT_ID}/database/access/${DATABASE_ACCESS.access_id}`,
    ]);
  });

  it("runs local psql with the password in its environment and always revokes afterwards", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const { cli, api } = createCli({
      api: {
        createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL),
        revokeProjectDatabaseAccess: vi.fn(async () => ({
          ...DATABASE_ACCESS,
          state: "revoked" as const,
          revoked_at: DATABASE_ACCESS.expires_at,
          revocation_reason: "principal" as const,
        })),
      },
      spawnPsql: async (input) => {
        const { signal, ...recorded } = input;
        void signal;
        spawned.push(recorded);
        return 0;
      },
    });

    const result = await cli.run([
      "database",
      "psql",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
      "--mode",
      "write",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(DATABASE_PASSWORD);
    expect(result.stdout).not.toContain("connection_uri");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "database psql",
      status: "succeeded",
      exit_code: 0,
      access: { access_id: DATABASE_ACCESS.access_id, role_name: DATABASE_ACCESS.role_name },
    });
    expect(spawned).toEqual([
      {
        host: DATABASE_ACCESS.host,
        user: DATABASE_ACCESS.role_name,
        password: DATABASE_PASSWORD,
        websocketUrl: DATABASE_ACCESS.websocket_url,
        database: DATABASE_ACCESS.database,
        mode: "read",
      },
    ]);
    expect(api.createProjectDatabaseAccess).toHaveBeenCalledWith(
      expect.objectContaining({ label: "psql", mode: "write" }),
    );
    expect(api.revokeProjectDatabaseAccess).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      accessId: DATABASE_ACCESS.access_id,
    });
  });

  it("revokes the credential and reports a missing psql or a failed session", async () => {
    const failing = createCli({
      api: {
        createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL),
        revokeProjectDatabaseAccess: vi.fn(async () => ({
          ...DATABASE_ACCESS,
          state: "revoked" as const,
          revoked_at: DATABASE_ACCESS.expires_at,
          revocation_reason: "principal" as const,
        })),
      },
      spawnPsql: async () => {
        throw new PsqlUnavailableError();
      },
    });
    const missing = await failing.cli.run([
      "database",
      "psql",
      "--project",
      PROJECT_ID,
      "--environment",
      "dev",
    ]);
    expect(missing.exitCode).toBe(9);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      command: "database psql",
      error: { code: "psql_unavailable", retryable: false },
    });
    expect(failing.api.revokeProjectDatabaseAccess).toHaveBeenCalledTimes(1);

    const exiting = createCli({
      api: {
        createProjectDatabaseAccess: vi.fn(async () => DATABASE_CREDENTIAL),
        revokeProjectDatabaseAccess: vi.fn(async () => {
          throw new Error("revocation unavailable");
        }),
      },
      spawnPsql: async () => 3,
    });
    const failed = await exiting.cli.run([
      "database",
      "psql",
      "--project",
      PROJECT_ID,
      "--environment",
      "prod",
    ]);
    expect(failed.exitCode).toBe(3);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      command: "database psql",
      status: "error",
      error: { code: "psql_failed" },
    });
  });
});

it("creates SQL exports through stdin and polls the original export without exposing its password", async () => {
  const password = "test-pass-1234";
  let limited = false;
  const status = {
    id: OPERATION.id,
    project_id: PROJECT_ID,
    state: "queued" as const,
    requested_at: OPERATION.created_at,
    next_request_at: "2026-08-19T00:00:00.000Z",
    next_poll_after_seconds: 5 as const,
    error: null,
    archive: null,
  };
  const { cli } = createCli({
    readSecretValue: async () => password,
    api: {
      async createProjectExport(input) {
        expect(input).toEqual({ projectId: PROJECT_ID, idempotencyKey: "export-1", password });
        if (limited)
          throw {
            type: "https://ohmyho.st/problems/rate_limited",
            title: "Rate limited",
            status: 429,
            code: "rate_limited",
            request_id: "p29-export-limit",
            retryable: true,
            suggested_action: "Retry later",
            retry_after_seconds: 86400,
          };
        return OPERATION;
      },
      async getProjectExport(input) {
        expect(input).toEqual({ projectId: PROJECT_ID, exportId: OPERATION.id });
        return status;
      },
    },
  });
  const created = await cli.run([
    "export",
    "create",
    "--project",
    PROJECT_ID,
    "--idempotency-key",
    "export-1",
    "--stdin",
    "--json",
  ]);
  expect(created.exitCode).toBe(0);
  expect(created.stdout).not.toContain(password);
  expect(JSON.parse(created.stdout)).toMatchObject({
    command: "export create",
    operation: OPERATION,
  });
  limited = true;
  const limit = await cli.run([
    "export",
    "create",
    "--project",
    PROJECT_ID,
    "--idempotency-key",
    "export-1",
    "--stdin",
    "--json",
  ]);
  expect(JSON.parse(limit.stdout)).toMatchObject({
    error: { code: "rate_limited", retry_after_seconds: 86400 },
  });
  const read = await cli.run(["export", "get", OPERATION.id, "--project", PROJECT_ID, "--json"]);
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout)).toMatchObject({ command: "export get", export: status });
  expect(
    (
      await cli.run([
        "export",
        "create",
        "--project",
        PROJECT_ID,
        "--idempotency-key",
        "export-1",
        "--password",
        password,
      ])
    ).exitCode,
  ).toBe(2);
  // A ZIP password has its own limit, which the secret set text would misstate.
  const long = createCli({ readSecretValue: async () => "p".repeat(2_000) });
  const refused = await long.cli.run([
    "export",
    "create",
    "--project",
    PROJECT_ID,
    "--idempotency-key",
    "export-long",
    "--stdin",
    "--json",
  ]);
  expect(refused.exitCode).toBe(2);
  expect(JSON.parse(refused.stdout).error).toEqual({
    code: "secret_input_invalid",
    retryable: false,
    suggested_action:
      "Pipe the ZIP password through standard input: at least 12 characters, non-blank UTF-8 of at most 1024 bytes. A final line break becomes part of the password.",
  });
  // A password below the creation minimum is refused as invalid secret input.
  const shortPassword = createCli({
    readSecretValue: async () => "test-pass-1",
    api: {
      async createProjectExport() {
        throw new Error("a short export password reached the API");
      },
    },
  });
  const short = await shortPassword.cli.run([
    "export",
    "create",
    "--project",
    PROJECT_ID,
    "--idempotency-key",
    "export-short",
    "--stdin",
    "--json",
  ]);
  expect(short.exitCode).toBe(2);
  expect(JSON.parse(short.stdout).error.code).toBe("secret_input_invalid");
});

it("signs an export download link through its own command and never reads one from the export", async () => {
  const link = {
    id: OPERATION.id,
    project_id: PROJECT_ID,
    download_url: "https://exports.example.test/signed-zip",
    download_expires_at: "2026-08-20T00:00:00.000Z",
  };
  const { cli } = createCli({
    api: {
      async createProjectExportDownloadLink(input) {
        expect(input).toEqual({ projectId: PROJECT_ID, exportId: OPERATION.id });
        return link;
      },
      async getProjectExport(input) {
        expect(input).toEqual({ projectId: PROJECT_ID, exportId: OPERATION.id });
        return {
          id: OPERATION.id,
          project_id: PROJECT_ID,
          state: "succeeded" as const,
          requested_at: OPERATION.created_at,
          next_request_at: "2026-08-19T00:00:00.000Z",
          next_poll_after_seconds: null,
          error: null,
          archive: {
            bytes: 1024,
            sha256: `sha256:${"a".repeat(64)}`,
            sql_files: ["dev.sql"],
            captured_at: OPERATION.created_at,
            expires_at: "2026-08-26T00:00:00.000Z",
            download_url: null,
            download_expires_at: null,
          },
        };
      },
    },
  });
  const read = await cli.run(["export", "get", OPERATION.id, "--project", PROJECT_ID, "--json"]);
  expect(read.exitCode).toBe(0);
  expect(read.stdout).not.toContain("exports.example.test");
  expect(JSON.parse(read.stdout).export.archive.download_url).toBeNull();
  const signed = await cli.run([
    "export",
    "download-link",
    OPERATION.id,
    "--project",
    PROJECT_ID,
    "--json",
  ]);
  expect(signed.exitCode).toBe(0);
  expect(JSON.parse(signed.stdout)).toMatchObject({
    command: "export download-link",
    status: "succeeded",
    download_link: link,
  });
  // The link is not idempotent, so a key the route cannot use is refused rather than ignored.
  const withKey = await cli.run([
    "export",
    "download-link",
    OPERATION.id,
    "--project",
    PROJECT_ID,
    "--idempotency-key",
    "export-link",
    "--json",
  ]);
  expect(withKey.exitCode).toBe(2);
});
