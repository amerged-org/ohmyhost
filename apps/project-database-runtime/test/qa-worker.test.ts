import { describe, expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import type { PreviewRuntimeRecord } from "@ohmyhost/contracts/previews";

vi.mock("cloudflare:workers", () => ({
  // Test-only constructors preserve the runtime-owned context boundary.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  RpcTarget: class {},
  WorkerEntrypoint: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

import { DatabaseLanePool } from "../src/connection-pool.js";
import {
  ProjectDatabaseEnvironment,
  ProjectDatabaseQa,
  ProjectDatabasePreview,
  type ProjectDatabaseBindings,
} from "../src/worker-service.js";

const id = (number: number) => String(number).padStart(26, "0");
const fixtures = [
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
];

describe("QA database Worker", () => {
  it("selects the real registered scope and fences query and transaction outcomes against current authority", async () => {
    const db = await startTestPostgres();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pools: DatabaseLanePool[] = [];
    try {
      const connectionString = db.pool.options.connectionString;
      if (typeof connectionString !== "string") throw new Error("local database missing");
      const local = new URL(connectionString);
      const sslMode = local.searchParams.get("sslmode");
      const useTls = sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
      if (!local.password) local.password = "local-test-password";
      local.searchParams.set("sslmode", "require");
      for (const size of [1, 2, 2]) {
        const pool = new DatabaseLanePool(local.href, size);
        if (local.port) pool.options.port = Number(local.port);
        if (!useTls) pool.options.ssl = false;
        pools.push(pool);
      }
      const [query, transaction, auth] = pools;
      if (!query || !transaction || !auth) throw new Error("local pools missing");
      const manifest = {
        platform: "development",
        projects: fixtures.map((fixture, index) => ({
          fixture,
          organizationId: id(1),
          projectId: id(10 + index),
          environmentId: id(20 + index),
          physicalEnvironmentId: id(30 + index),
          registrationVersion: 1,
          region: "eu" as const,
          handle: `qa-${index}`,
          origin: `https://dev-qa-${index}.dev.check.omh.st`,
          principalId: "qa-operator",
          devAccessEpoch: 1,
        })),
      };
      const scope = manifest.projects[0];
      if (!scope) throw new Error("QA scope missing");
      const registration = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        physicalEnvironmentId: scope.physicalEnvironmentId,
        region: scope.region,
        operationId: id(50),
        registrationVersion: scope.registrationVersion,
        provider: "pgcf" as const,
        providerProjectId: "p1234567890123456789",
        databaseId: "d1234567890123456789",
        originHost: "database.example.com",
        originDatabase: "d1234567890123456789",
        originUser: `ohmyho_rw_${scope.physicalEnvironmentId.toLowerCase()}`,
        authorizedEnvironmentIds: [scope.environmentId],
        connectionString: `postgres://ohmyho_rw_${scope.physicalEnvironmentId.toLowerCase()}:fixture-password@database.example.com/d1234567890123456789`,
      };
      const { connectionString: _credential, ...metadata } = registration;
      void _credential;
      const receipt = { ...metadata, status: "active" as const };
      const storage = {
        value: undefined as unknown,
        async get<T>() {
          return this.value as T | undefined;
        },
        async put(_key: string, value: unknown) {
          this.value = structuredClone(value);
        },
      };
      const names: string[] = [];
      let accessChecks = 0;
      let failAt = 0;
      const env: ProjectDatabaseBindings = {
        DATABASE_REGION: "eu",
        DATABASE_REGISTRY_KEY: btoa("k".repeat(32)),
        QA_DATABASE_PLATFORM: "development",
        QA_DATABASE_MANIFEST: JSON.stringify(manifest),
        DATABASE_ENVIRONMENTS: {
          jurisdiction(region) {
            expect(region).toBe("eu");
            return this;
          },
          getByName(name, options) {
            expect(options).toEqual({ locationHint: "weur" });
            names.push(name);
            return object;
          },
        },
        OHMYHOST_MAIL_GATEWAY: { fetch: async () => new Response(null, { status: 202 }) },
        QA_DATABASE_AUTHORITY: {
          readApiProjectDataChangeState: async (input) => {
            expect(input).toEqual({
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              principalId: scope.principalId,
            });
            return {
              assignments: {
                dataMode: "isolated",
                dev: {
                  environment: "dev",
                  environmentId: scope.environmentId,
                  dataEnvironmentId: scope.physicalEnvironmentId,
                },
                prod: { environment: "prod", environmentId: id(40), dataEnvironmentId: id(41) },
              },
              registrationGenerations: [
                { dataEnvironmentId: scope.physicalEnvironmentId, registrationVersion: 1 },
              ],
            };
          },
          readRuntimeBinding: async (input) => {
            expect(input).toEqual({
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            });
            return receipt;
          },
        },
        QA_DEV_ACCESS: {
          authorizeDevAccessSession: async (input) => {
            expect(input).toEqual({
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              handle: scope.handle,
              origin: scope.origin,
              principalId: scope.principalId,
              devAccessEpoch: scope.devAccessEpoch,
            });
            accessChecks += 1;
            return accessChecks !== failAt;
          },
        },
        QA_CREDIT: {
          read: async (raw) => {
            const input = raw as {
              organizationId: string;
              projectId: string;
              environmentId: string;
              now: string;
            };
            return {
              organizationId: input.organizationId,
              projectId: input.projectId,
              environmentId: input.environmentId,
              allowed: true,
              paidAllowed: true,
              reason: null,
              checkedAt: input.now,
              expiresAt: new Date(Date.parse(input.now) + 60_000).toISOString(),
            };
          },
        },
      };
      const object = new ProjectDatabaseEnvironment({ storage }, env);
      await object.register(registration);
      // The test substitutes only local PostgreSQL transport; the registry and Worker code are real.
      Object.assign(object, { pools: { query, transaction, auth } });
      const worker = new ProjectDatabaseQa({ props: {} }, env);
      const statement = (text: string) => ({ text, values: [] });
      const execute = (operation: "query" | "transaction", input: unknown) =>
        worker.execute({ platform: "development", scope, operation, input });
      await expect(
        execute("query", statement("CREATE TEMP TABLE qa_boundary_notes(id integer)")),
      ).resolves.toMatchObject({ command: "CREATE" });
      await expect(
        execute("query", statement("INSERT INTO qa_boundary_notes VALUES (1)")),
      ).resolves.toMatchObject({ command: "INSERT" });
      expect(() =>
        worker.execute({
          platform: "development",
          scope: { ...scope, projectId: id(99) },
          operation: "query",
          input: statement("SELECT 1"),
        }),
      ).toThrow();

      // A grant change after SQL but before COMMIT must roll back.
      accessChecks = 0;
      failAt = 3;
      await expect(
        execute("query", statement("INSERT INTO qa_boundary_notes VALUES (2)")),
      ).rejects.toThrow("project_database_transaction_failed");
      accessChecks = 0;
      failAt = 0;
      await expect(
        execute("query", statement("SELECT id FROM qa_boundary_notes ORDER BY id")),
      ).resolves.toMatchObject({ rows: [{ id: 1 }] });

      // A failed check after COMMIT hides the result, while reconciliation observes the committed row.
      accessChecks = 0;
      failAt = 4;
      await expect(
        execute("query", statement("INSERT INTO qa_boundary_notes VALUES (3)")),
      ).rejects.toThrow("project_database_transaction_failed");
      accessChecks = 0;
      failAt = 0;
      await expect(
        execute("transaction", [
          statement("INSERT INTO qa_boundary_notes VALUES (4)"),
          statement("SELECT id FROM qa_boundary_notes ORDER BY id"),
        ]),
      ).resolves.toMatchObject([
        { command: "INSERT" },
        { rows: [{ id: 1 }, { id: 3 }, { id: 4 }] },
      ]);
      expect(new Set(names)).toEqual(
        new Set([`${scope.organizationId}:${scope.projectId}:${scope.physicalEnvironmentId}`]),
      );
      expect(JSON.stringify(logged.mock.calls)).not.toContain("fixture-password");

      // The product entrypoint selects this same real registry through Core's current preview
      // decision, with no fixture manifest or customer-selected physical scope in the request.
      const fence = { previewId: id(60), runtimeGeneration: 1, tokenGeneration: 1 };
      const preview = {
        ...fence,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        dataEnvironmentId: scope.physicalEnvironmentId,
        region: "eu",
        authGeneration: 1,
        assignmentVersion: 1,
        billingEpochId: id(61),
        ownershipVersion: 1,
        lifecycleVersion: 1,
        retirement: "none",
        state: "ready",
      } as unknown as PreviewRuntimeRecord;
      let productChecks = 0,
        denyAt = 0,
        revoked = false;
      Object.assign(env, {
        PROJECT_PREVIEW_AUTHORITY: {
          authorizeDatabase: async (requested: unknown) => {
            expect(requested).toEqual(fence);
            productChecks += 1;
            return revoked || productChecks === denyAt ? null : { preview, binding: receipt };
          },
        },
      });
      const product = new ProjectDatabasePreview({ props: {} }, env);
      const productExecute = (operation: "query" | "transaction", input: unknown) =>
        product.execute({ fence, operation, input });
      await expect(
        productExecute("query", statement("SELECT 7 AS product")),
      ).resolves.toMatchObject({ rows: [{ product: 7 }] });
      productChecks = 0;
      denyAt = 4;
      await expect(
        productExecute("query", statement("INSERT INTO qa_boundary_notes VALUES (7)")),
      ).rejects.toThrow();
      productChecks = 0;
      denyAt = 0;
      await expect(
        productExecute("query", statement("SELECT id FROM qa_boundary_notes WHERE id=7")),
      ).resolves.toMatchObject({ rows: [] });
      productChecks = 0;
      denyAt = 4;
      await expect(
        productExecute("transaction", [statement("INSERT INTO qa_boundary_notes VALUES (5)")]),
      ).rejects.toThrow();
      productChecks = 0;
      denyAt = 0;
      await expect(
        productExecute("query", statement("SELECT id FROM qa_boundary_notes WHERE id=5")),
      ).resolves.toMatchObject({ rows: [] });
      productChecks = 0;
      denyAt = 5;
      await expect(
        productExecute("transaction", [statement("INSERT INTO qa_boundary_notes VALUES (6)")]),
      ).resolves.toEqual({ type: "ohmyhost.database-error/v1", sqlstate: "08007" });
      productChecks = 0;
      denyAt = 0;
      const held = await product.open({ fence });
      await expect(held.query(statement("SELECT 8 AS held"))).resolves.toMatchObject({
        rows: [{ held: 8 }],
      });
      revoked = true;
      await expect(held.query(statement("SELECT 9"))).rejects.toThrow();
      await held.close();
      revoked = false;
      const rls = await product.openRls({ fence, identity: null });
      await expect(rls.query(statement("SELECT 10 AS rls"))).resolves.toMatchObject({
        rows: [{ rls: 10 }],
      });
      revoked = true;
      await expect(rls.commit()).resolves.toEqual({
        type: "ohmyhost.database-rls-error/v1",
        code: "database_rls_transaction_failed",
      });
      await rls.close();
    } finally {
      await Promise.allSettled(pools.map((pool) => pool.invalidate()));
      await db.stop();
      logged.mockRestore();
    }
  }, 60_000);
});
