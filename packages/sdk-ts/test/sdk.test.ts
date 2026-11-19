import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createClient,
  createDeployment,
  createProject,
  deleteProject,
  getDeployment,
  getOperation,
  getProject,
  getProjectStatus,
  getProjectSource,
  linkProjectSource,
  listAuditEvents,
  listDeployments,
  listProjects,
  planDeployment,
  planDeploymentRollback,
  planDeploymentPromotion,
  planProjectDeletion,
  reconcileOperation,
  promoteDeployment,
  rollbackDeployment,
  streamOperationEvents,
  type Deployment,
  type DeploymentPlan,
  type GuardedActionPlan,
  type GetDeploymentResponse,
  type Operation,
  type PlanDeploymentResponse,
  type PlanProjectDeletionResponse,
  type ProblemDetails,
  type ProviderReconciliationAttempt,
  type ReconcileOperationResponse,
  type Project,
  type ProjectPage,
  type ProjectStatus,
  type ListProjectsResponse,
  type GetProjectStatusResponse,
} from "../src/index.js";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

describe("generated SDK contract", () => {
  it("exports every Phase 1 operation and the isolated client factory", () => {
    expect([
      createClient,
      createProject,
      getOperation,
      getProject,
      listProjects,
      getProjectStatus,
      listAuditEvents,
      streamOperationEvents,
    ]).toEqual([
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ]);

    expectTypeOf<ListProjectsResponse>().toEqualTypeOf<ProjectPage>();
    expectTypeOf<GetProjectStatusResponse>().toEqualTypeOf<ProjectStatus>();

    expectTypeOf<Parameters<typeof getOperation>[0]>().toMatchTypeOf<{
      operation_id: string;
    }>();
  });

  it("exports the complete Phase 2 source and deployment boundary", () => {
    expect([
      linkProjectSource,
      getProjectSource,
      planDeployment,
      createDeployment,
      listDeployments,
      getDeployment,
      planDeploymentRollback,
      rollbackDeployment,
      planDeploymentPromotion,
      promoteDeployment,
      planProjectDeletion,
      deleteProject,
      reconcileOperation,
    ]).toEqual(new Array(13).fill(expect.any(Function)));

    expectTypeOf<PlanDeploymentResponse>().toEqualTypeOf<DeploymentPlan>();
    const applicationRoot: DeploymentPlan["application_root"] = "site";
    expect(applicationRoot).toBe("site");
    expectTypeOf<GetDeploymentResponse>().toEqualTypeOf<Deployment>();
    const reconciliationStatus: Deployment["status"] = "reconciliation_required";
    expect(reconciliationStatus).toBe("reconciliation_required");
    expectTypeOf<PlanProjectDeletionResponse>().toEqualTypeOf<GuardedActionPlan>();
    expectTypeOf<ReconcileOperationResponse>().toEqualTypeOf<ProviderReconciliationAttempt>();
    expectTypeOf<Parameters<typeof rollbackDeployment>[0]>().toMatchTypeOf<{
      "Idempotency-Key": string;
      "If-Match": string;
      "X-Confirmation-Token": string;
      project_id: string;
      target_deployment_id: string;
    }>();
    expectTypeOf<Parameters<typeof promoteDeployment>[0]>().toMatchTypeOf<{
      "Idempotency-Key": string;
      "If-Match": string;
      "X-Confirmation-Token": string;
      project_id: string;
      source_deployment_id: string;
    }>();
  });

  it("uses the configured base URL and bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://control.example.test/v1/projects/project-1");
      expect(request.headers.get("authorization")).toBe("Bearer access-token");
      return new Response(
        JSON.stringify({
          id: "project-1",
          organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          name: "alpha",
          handle: "calm-otter-waves",
          created_at: "2026-08-18T00:00:00Z",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    });
    const client = createClient({
      auth: "access-token",
      baseUrl: "https://control.example.test",
      fetch,
      throwOnError: true,
    });

    const project = await getProject({ project_id: "project-1" }, { client });
    expectTypeOf(project).toEqualTypeOf<Project>();
    expect(project).toEqual({
      created_at: "2026-08-18T00:00:00Z",
      id: "project-1",
      name: "alpha",
      handle: "calm-otter-waves",
      organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const auditFetch = vi.fn(async (auditInput: RequestInfo | URL) => {
      expect(auditInput).toBeInstanceOf(Request);
      return Response.json({ items: [] });
    });
    const auditClient = createClient({
      baseUrl: "https://control.example.test",
      fetch: auditFetch,
    });
    await listAuditEvents(
      { organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      { client: auditClient },
    );
    const request = auditFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).searchParams.get("organization_id")).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });

  it("throws the typed problem response on an API error", async () => {
    const problem: ProblemDetails = {
      code: "resource_not_found",
      request_id: "request-1",
      retryable: false,
      status: 404,
      suggested_action: "Check the resource identifier.",
      title: "Not Found",
      type: "https://api.ohmyho.st/problems/resource-not-found",
    };
    const client = createClient({
      baseUrl: "https://control.example.test",
      fetch: async () =>
        new Response(JSON.stringify(problem), {
          headers: { "Content-Type": "application/problem+json" },
          status: 404,
        }),
      throwOnError: true,
    });

    await expect(getProject({ project_id: "missing" }, { client })).rejects.toEqual(problem);
  });

  it("types every problem code already emitted by the Control API", () => {
    const problems: readonly ProblemDetails[] = [
      {
        code: "project_handle_unavailable",
        request_id: "request-handle",
        retryable: true,
        status: 503,
        suggested_action: "Retry project creation with the same idempotency key.",
        title: "Project handle unavailable",
        type: "https://api.ohmyho.st/problems/project-handle-unavailable",
      },
      {
        code: "project_identity_unavailable",
        request_id: "request-identity",
        retryable: true,
        status: 503,
        suggested_action: "Retry project creation with the same idempotency key.",
        title: "Project identity unavailable",
        type: "https://api.ohmyho.st/problems/project-identity-unavailable",
      },
      {
        code: "environment_secret_mutation_blocked",
        request_id: "request-secret",
        retryable: true,
        status: 409,
        suggested_action:
          "Wait for the active deployment or rollback to finish, then retry unchanged.",
        title: "Environment secret mutation blocked",
        type: "https://api.ohmyho.st/problems/environment-secret-mutation-blocked",
      },
    ];

    expect(problems.map(({ code }) => code)).toEqual([
      "project_handle_unavailable",
      "project_identity_unavailable",
      "environment_secret_mutation_blocked",
    ]);
  });
});

describe("ESM boundaries", () => {
  it("uses explicit .js extensions for every relative source import", async () => {
    const sourceDirectory = join(packageDirectory, "src");
    const files: Array<string> = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (extname(entry.name) === ".ts") {
          files.push(path);
        }
      }
    };
    await visit(sourceDirectory);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const specifiers = [...source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)].map(
        (match) => match[1],
      );
      expect(specifiers, file).not.toContain(undefined);
      for (const specifier of specifiers) {
        expect(specifier, file).toMatch(/\.js$/);
      }
    }
  });
});

const assertMutationContract = async (): Promise<void> => {
  const operation: Operation = await createProject(
    {
      "Idempotency-Key": "idempotency-key",
      createProjectRequest: {
        name: "alpha",
        organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    },
    { client: createClient({ baseUrl: "https://control.example.test" }) },
  );
  expectTypeOf(operation).toEqualTypeOf<Operation>();
};

void assertMutationContract;
