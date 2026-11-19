import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createControlApi,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  createUnavailableProviderReconciliationPort,
  type ControlApiDependencies,
} from "../src/index.js";

const ORG_A = parseUlid("00000000000000000000000001");
const ORG_B = parseUlid("00000000000000000000000002");
const PROJECT = parseUlid("00000000000000000000000003");
const NEXT = parseUlid("00000000000000000000000004");
const NOW = "2026-08-24T12:00:00.000Z";

describe("customer project discovery", () => {
  it("lists only organizations authorized for project reads with an opaque ULID cursor", async () => {
    const listProjects = vi.fn(async () => ({
      projects: [
        {
          dataMode: "shared" as const,
          region: "eu" as const,
          projectId: PROJECT,
          organizationId: ORG_A,
          name: "alpha",
          handle: "calm-otter-waves",
          createdAt: NOW,
        },
      ],
      nextCursor: NEXT,
    }));
    const app = createControlApi(
      dependencies({
        authorization: {
          check: async ({ resource }) =>
            resource.kind === "organization" && resource.organizationId === ORG_A
              ? "allow"
              : "deny",
        },
        persistence: { ...basePersistence(), listProjects },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects?cursor=${PROJECT}&limit=1`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          data_mode: "shared" as const,
          region: "eu" as const,
          id: PROJECT,
          organization_id: ORG_A,
          name: "alpha",
          handle: "calm-otter-waves",
          created_at: NOW,
        },
      ],
      next_cursor: NEXT,
    });
    expect(listProjects).toHaveBeenCalledWith({
      organizationIds: [ORG_A],
      cursor: PROJECT,
      limit: 1,
    });
  });

  it("returns an indistinguishable 404 for a project status outside the caller scope", async () => {
    const getProjectStatus = vi.fn();
    const app = createControlApi(
      dependencies({
        persistence: basePersistence(),
        productSurface: { ...createUnavailableProductSurfacePort(), getProjectStatus },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects/${PROJECT}/status`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status).toBe(404);
    expect(getProjectStatus).not.toHaveBeenCalled();
  });

  it("returns the credential-free status projection for an authorized project", async () => {
    const status = {
      project_id: PROJECT,
      etag: `"sha256-${"a".repeat(64)}"`,
      handle: "calm-otter-waves",
      region: "eu",
      dev_access_mode: "protected",
      lifecycle: "active",
      source: null,
      default_environment: { id: PROJECT, name: "sandbox" },
      head_deployment: null,
      dev_url: null,
      prod_url: null,
      latest_operation: null,
      cleanup_state: "not_started",
    } as const;
    const app = createControlApi(
      dependencies({
        persistence: {
          ...basePersistence(),
          getProject: async () => ({
            dataMode: "shared" as const,
            region: "us" as const,
            projectId: PROJECT,
            organizationId: ORG_A,
            name: "alpha",
            handle: "calm-otter-waves",
            createdAt: NOW,
          }),
        },
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getProjectStatus: async () => ({ status: 200, body: status }),
        },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects/${PROJECT}/status`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it.each([
    ["missing address ETag", { etag: undefined }],
    ["weak address ETag", { etag: `W/"sha256-${"a".repeat(64)}"` }],
    ["swapped dev host", { dev_url: "https://calm-otter-waves.dev.check.omh.st" }],
    [
      "foreign prod host",
      { prod_url: "https://other-project-handle.your-omh-account.workers.dev" },
    ],
    ["path-bearing dev URL", { dev_url: "https://dev-calm-otter-waves.dev.check.omh.st/path" }],
    [
      "query-bearing prod URL",
      { prod_url: "https://calm-otter-waves.dev.check.omh.st?secret=value" },
    ],
  ])("fails closed for a %s in persisted status output", async (_label, invalid) => {
    const status = {
      project_id: PROJECT,
      etag: `"sha256-${"a".repeat(64)}"`,
      handle: "calm-otter-waves",
      region: "eu",
      dev_access_mode: "protected",
      lifecycle: "active",
      source: null,
      default_environment: { id: PROJECT, name: "dev" },
      head_deployment: null,
      dev_url: "https://dev-calm-otter-waves.dev.check.omh.st",
      prod_url: "https://calm-otter-waves.dev.check.omh.st",
      latest_operation: null,
      cleanup_state: "not_started",
      ...invalid,
    } as const;
    const app = createControlApi(
      dependencies({
        persistence: {
          ...basePersistence(),
          getProject: async () => ({
            dataMode: "shared" as const,
            region: "us" as const,
            projectId: PROJECT,
            organizationId: ORG_A,
            name: "alpha",
            handle: "calm-otter-waves",
            createdAt: NOW,
          }),
        },
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getProjectStatus: async () => ({ status: 200, body: status }),
        },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects/${PROJECT}/status`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  });
});

function basePersistence(): ControlApiDependencies["persistence"] {
  return {
    submitFeedback: async () => {
      throw new Error("Unused feedback fixture");
    },
    readFeedbackStatus: async () => {
      throw new Error("Unused feedback fixture");
    },
    takenProjectHandles: async () => new Set<string>(),
    createProject: async () => {
      throw new Error("unused");
    },
    listProjects: async () => ({ projects: [], nextCursor: null }),
    getProject: async () => null,
    getOperation: async () => null,
    readAuditEvents: async () => ({ events: [], nextCursor: null }),
  };
}

function dependencies(overrides: Partial<ControlApiDependencies>): ControlApiDependencies {
  return {
    authentication: {
      authenticate: async () => ({
        actorId: "user:user_1",
        credentialId: "workos_session:session_1",
        authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
        organizationIds: [ORG_A, ORG_B],
      }),
    },
    authorization: { check: async () => "allow" },
    persistence: basePersistence(),
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    devAccessTickets: overrides.devAccessTickets ?? {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => NEXT },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    ...overrides,
  };
}
