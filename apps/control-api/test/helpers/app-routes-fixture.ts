import { parseUlid } from "@ohmyhost/platform";

import {
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  createUnavailableProviderReconciliationPort,
  type AuthenticatedPrincipal,
  type ControlApiDependencies,
} from "../../src/index.js";

export const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
export const PROJECT_ID = parseUlid("00000000000000000000000002");
export const EVENT_ID = parseUlid("00000000000000000000000003");
export const OPERATION_ID = parseUlid("00000000000000000000000004");
export const ENVIRONMENT_ID = parseUlid("00000000000000000000000005");
export const FOREIGN_ORGANIZATION_ID = parseUlid("00000000000000000000000009");
export const NOW = "2026-09-10T10:00:00.000Z";
export const API = "https://api.test";
export const BEARER = { Authorization: "Bearer valid" } as const;
export const JSON_BEARER = { ...BEARER, "Content-Type": "application/json" } as const;

export const PRINCIPAL: AuthenticatedPrincipal = {
  actorId: "user:user_1",
  credentialId: "workos_session:session_1",
  authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
  organizationIds: [ORGANIZATION_ID],
};

export interface RecordedReport {
  readonly requestId: string;
  readonly code: string;
  readonly route: string;
}

/** The smallest complete dependency set; every route test overrides only the port it exercises. */
export function routeDependencies(
  overrides: Partial<ControlApiDependencies> = {},
): ControlApiDependencies {
  return {
    authentication: {
      authenticate: async (token) => (token === "valid" ? PRINCIPAL : null),
    },
    authorization: { check: async () => "allow" },
    persistence: {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      listProjects: async () => ({ projects: [], nextCursor: null }),
      takenProjectHandles: async () => new Set<string>(),
      createProject: async () => {
        throw new Error("Unused project creation fixture");
      },
      getProject: async (organizationId, projectId) =>
        organizationId === ORGANIZATION_ID && projectId === PROJECT_ID
          ? {
              projectId,
              organizationId,
              name: "Context",
              handle: "calm-otter-waves",
              dataMode: "shared" as const,
              region: "us" as const,
              createdAt: NOW,
            }
          : null,
      getOperation: async () => null,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    devAccessTickets: {
      issue: async () => {
        throw new Error("Unused dev access fixture");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_fixture",
    ...overrides,
  };
}

/** A reporter that keeps what the route reports so a test can assert the failure code. */
export function recordingReporter(): {
  readonly reports: RecordedReport[];
  readonly reporter: ControlApiDependencies["reporter"];
} {
  const reports: RecordedReport[] = [];
  return {
    reports,
    reporter: {
      report: (entry) => {
        reports.push(entry);
      },
    },
  };
}

export function creditBalanceBody(
  organizationId: string = ORGANIZATION_ID,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    unit: "microcredits",
    as_of: NOW,
    available_micros: "5000000",
    reserved_micros: "0",
    grace_started_at: null,
    grace_expires_at: null,
  };
}

export function creditUsageBody(
  organizationId: string = ORGANIZATION_ID,
  projectId: string = PROJECT_ID,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    as_of: NOW,
    unit: "microcredits",
    period: "2026-09",
    from: "2026-08-28T00:00:00.000Z",
    projects: [{ project_id: projectId, used_micros: "600" }],
    days: [
      {
        day: "2026-09-10",
        projects: [
          {
            project_id: projectId,
            meters: [
              {
                environment_id: null,
                meter: "builds.compute",
                unit: "second",
                rate_card_id: "usage-2026-09",
                quantity: "30",
                charged_micros: "600",
              },
            ],
          },
        ],
      },
    ],
  };
}

export function creditAccountBody(
  organizationId: string = ORGANIZATION_ID,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    name: "Context",
    workos_organization_id: "org_context",
    plan: "free",
    plan_source: "free",
    paid_until: null,
    available_micros: "5000000",
    monthly_micros: "5000000",
    one_time_micros: "0",
    reserved_micros: "0",
    next_expiry: null,
    as_of: NOW,
  };
}

export function creditBudgetBody(projectId: string = PROJECT_ID): Record<string, unknown> {
  return {
    project_id: projectId,
    amount_micros: "5000000",
    mode: "stop",
    used_micros: "600",
    reserved_micros: "250",
    period_start: "2026-09-01T00:00:00.000Z",
    period_end: "2026-10-01T00:00:00.000Z",
    as_of: NOW,
  };
}
