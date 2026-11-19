import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { claimProductProviderMutation } from "../../control-store/src/catalog/provisioning/provider-claim.js";
import { failProductDeployment } from "../../control-store/src/catalog/provisioning/deployment-failure.js";
import { createControlApi, createUnavailableProductSurfacePort } from "../src/index.js";
import { createD1ProductOperationReader } from "../src/d1-product-operation.js";
import { createD1ProductSurfaceDataPort } from "../src/d1-product-surface.js";
import { productStatusResult } from "../src/product-surface.js";
import { PRINCIPAL, routeDependencies } from "./helpers/app-routes-fixture.js";

it("serves a real failed migration through operation GET, SSE and project status without exposing SQL", async () => {
  const c = await createTestControl();
  try {
    const migration = await workflowFixture(c);
    const context = { directory: c.core, router: new SharedCoreRouter(c.core) };
    await claimProductProviderMutation(context, migration.input);
    expect(
      await failProductDeployment(context, {
        workflowId: migration.input.logicalWorkflowId,
        organizationId: migration.input.organizationId,
        projectId: migration.input.projectId,
        environmentId: migration.input.environmentId,
        operationId: migration.input.operationId,
        outboxEventId: migration.input.eventId,
        startedOperationEventId: newUlid(),
        operationEventId: newUlid(),
        auditEventId: newUlid(),
        actorId: "deployment-workflow",
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: {
          reason: "execution_failed",
          path: "db/20261028110000_expand.sql",
          statementIndex: 2,
          sqlstate: "42P01",
        },
        failedAt: new Date().toISOString(),
      }),
    ).toBe("failed");
    const organizationId = parseUlid(migration.input.organizationId),
      projectId = parseUlid(migration.input.projectId),
      base = routeDependencies(),
      principal = { ...PRINCIPAL, organizationIds: [organizationId] },
      reader = createD1ProductOperationReader(migration.store.productApi),
      statusData = createD1ProductSurfaceDataPort(migration.store.productApi),
      statusPort = {
        ...createUnavailableProductSurfacePort(),
        getProjectStatus: async (scope: Parameters<typeof productStatusResult>[0]) => {
          const facts = await statusData.readProjectStatus(scope);
          return facts === null ? null : productStatusResult(scope, facts);
        },
      },
      dependencies = {
        ...base,
        authentication: { authenticate: async () => principal },
        persistence: {
          ...base.persistence,
          getOperation: reader,
          getProject: async (org: string, id: string) =>
            org === organizationId && id === projectId
              ? {
                  organizationId,
                  projectId,
                  name: "Fixture",
                  handle: migration.p.projectHandle,
                  dataMode: "shared" as const,
                  region: "eu" as const,
                  createdAt: "2026-10-28T10:00:00.000Z",
                }
              : null,
        },
        productSurface: statusPort,
      },
      app = createControlApi(dependencies),
      headers = { Authorization: "Bearer valid" },
      operationUrl = `https://api.test/v1/operations/${migration.input.operationId}`;
    const response = await app.request(operationUrl, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      error: { migration: { reason: "execution_failed", statement_index: 2, sqlstate: "42P01" } },
    });
    const stream = await app.request(`${operationUrl}/events`, { headers });
    expect(stream.status).toBe(200);
    const streamBody = await stream.text();
    expect(streamBody).toContain('"statement_index":2');
    expect(streamBody).not.toContain("secret SQL");
    const status = await app.request(`https://api.test/v1/projects/${projectId}/status`, {
      headers,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      latest_operation: { error: { migration: { statement_index: 2, sqlstate: "42P01" } } },
    });
    const malicious = createControlApi({
      ...dependencies,
      productSurface: {
        ...statusPort,
        getProjectStatus: async (scope) => {
          const result = await statusPort.getProjectStatus(scope);
          if (result === null) return null;
          const body = structuredClone(result.body) as Record<string, unknown>,
            latest = body["latest_operation"] as Record<string, unknown>,
            error = latest["error"] as Record<string, unknown>;
          error["migration"] = { ...(error["migration"] as object), sql: "secret SQL" };
          return { ...result, body };
        },
      },
    });
    const rejected = await malicious.request(`https://api.test/v1/projects/${projectId}/status`, {
      headers,
    });
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).not.toContain("secret SQL");
  } finally {
    await c.dispose();
  }
}, 60_000);
