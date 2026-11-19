import { DurableObject } from "cloudflare:workers";
import { DatabaseLanePool, pooledClientDependencies } from "../../src/connection-pool.js";
import {
  connectBoundedProjectDatabase,
  connectRlsProjectDatabase,
  createProjectDatabaseService,
} from "../../src/service.js";
import {
  ProjectDatabaseConnection,
  ProjectDatabaseRlsConnection,
  ProjectDatabaseEnvironment as RuntimeDatabaseEnvironment,
} from "../../src/worker-service.js";

/** Local transport acceptance only: PostgreSQL test TLS is tested separately with a generated CA. */
export class ProjectDatabaseEnvironment extends DurableObject<{ TEST_DATABASE_URI: string }> {
  private readonly pool = new DatabaseLanePool(this.env.TEST_DATABASE_URI, 2);
  private readonly dependencies = pooledClientDependencies(this.pool);
  public constructor(
    ctx: ConstructorParameters<typeof DurableObject>[0],
    env: { TEST_DATABASE_URI: string },
  ) {
    super(ctx, env);
    this.pool.options.port = Number(new URL(env.TEST_DATABASE_URI).port);
    this.pool.options.ssl = false;
  }
  public query() {
    return createProjectDatabaseService(this.env.TEST_DATABASE_URI, this.dependencies).query({
      text: "SELECT pg_backend_pid() AS pid",
      values: [],
    });
  }
  public async open() {
    return new ProjectDatabaseConnection(
      await connectBoundedProjectDatabase(this.env.TEST_DATABASE_URI, this.dependencies, 999),
      async () => undefined,
      () => undefined,
    );
  }
  public async openRls(identity: unknown) {
    return new ProjectDatabaseRlsConnection(
      await connectRlsProjectDatabase(
        this.env.TEST_DATABASE_URI,
        this.dependencies,
        999,
        identity,
        async () => undefined,
      ),
      () => undefined,
    );
  }
  public close() {
    return this.pool.invalidate();
  }
}
/** The production registry and RPC target run unchanged against real local PostgreSQL sockets. */
export class ScopedDatabaseEnvironment extends RuntimeDatabaseEnvironment {
  private readonly localPools: {
    query: DatabaseLanePool;
    transaction: DatabaseLanePool;
    auth: DatabaseLanePool;
  };
  public constructor(
    ctx: ConstructorParameters<typeof DurableObject>[0],
    env: { TEST_DATABASE_URI: string },
  ) {
    super(ctx, {
      DATABASE_REGION: "us",
      DATABASE_REGISTRY_KEY: btoa("k".repeat(32)),
      DATABASE_ENVIRONMENTS: {} as never,
      OHMYHOST_MAIL_GATEWAY: { fetch: async () => new Response(null, { status: 202 }) },
    });
    this.localPools = {
      query: new DatabaseLanePool(env.TEST_DATABASE_URI, 1),
      transaction: new DatabaseLanePool(env.TEST_DATABASE_URI, 2),
      auth: new DatabaseLanePool(env.TEST_DATABASE_URI, 2),
    };
    for (const pool of Object.values(this.localPools)) {
      pool.options.port = Number(new URL(env.TEST_DATABASE_URI).port);
      pool.options.ssl = false;
    }
  }
  public async transition() {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const devId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const prodId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const dataId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
    const physical = {
      organizationId,
      projectId,
      physicalEnvironmentId: dataId,
      region: "us" as const,
    };
    const devScope = { ...physical, environmentId: devId, registrationVersion: 1 };
    const prodScope = { ...devScope, environmentId: prodId };
    const registration = {
      ...physical,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      registrationVersion: 1,
      providerProjectId: "local-scope-project",
      branchId: "br-local-scope",
      originHost: "ep-test-pooler.us-east-1.aws.neon.tech",
      originDatabase: "neondb",
      originUser: `ohmyho_rw_${dataId.toLowerCase()}`,
      authorizedEnvironmentIds: [devId, prodId],
      pooledConnectionString: `postgresql://ohmyho_rw_${dataId.toLowerCase()}:local-test-password@ep-test-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
    };
    await this.register(registration);
    // Only transport changes for the local provider adapter; every pool contains real pg clients.
    Object.assign(this, {
      pools: this.localPools,
      poolConnectionString: registration.pooledConnectionString,
    });
    using dev = await this.open(devScope);
    using prod = await this.open(prodScope);
    try {
      await dev.query({ text: "BEGIN", values: [] });
      await prod.query({ text: "BEGIN", values: [] });
      await prod.query({ text: "CREATE TEMP TABLE runtime_prod_survives(answer int)", values: [] });
      await prod.query({ text: "INSERT INTO runtime_prod_survives VALUES(42)", values: [] });
      await this.register({
        ...registration,
        registrationVersion: 2,
        authorizedEnvironmentIds: [prodId],
      });
      const devDenied = await dev.query({ text: "SELECT 1", values: [] }).then(
        () => false,
        () => true,
      );
      const prodResult = (await prod.query({
        text: "SELECT answer FROM runtime_prod_survives",
        values: [],
      })) as { rows: unknown[] };
      await prod.query({ text: "COMMIT", values: [] });
      await this.register({ ...registration, registrationVersion: 3 });
      const staleDevDenied = await this.query(devScope, { text: "SELECT 1", values: [] }).then(
        () => false,
        () => true,
      );
      const devResult = await this.query(
        { ...devScope, registrationVersion: 3 },
        { text: "SELECT 43 AS answer", values: [] },
      );
      if (!("rows" in devResult)) throw new Error("Local Dev scope returned a database error");
      return { devDenied, staleDevDenied, prodRows: prodResult.rows, devRows: devResult.rows };
    } finally {
      await dev.close();
      await prod.close();
      await this.revoke({
        ...physical,
        operationId: registration.operationId,
        registrationVersion: 4,
      });
    }
  }
}
export default {
  async fetch(
    request: Request,
    env: {
      DATABASE_ENVIRONMENTS: { getByName(name: string): ProjectDatabaseEnvironment };
      SCOPE_ENVIRONMENTS: { getByName(name: string): ScopedDatabaseEnvironment };
    },
  ) {
    const object = env.DATABASE_ENVIRONMENTS.getByName("local-socket-proof");
    try {
      const path = new URL(request.url).pathname;
      if (path === "/data-transition")
        return Response.json(
          await env.SCOPE_ENVIRONMENTS.getByName("scoped-socket-proof").transition(),
        );
      if (path === "/close") {
        await object.close();
        return new Response(null, { status: 204 });
      }
      if (path === "/transaction") {
        using connection = await object.open();
        await connection.query({ text: "BEGIN", values: [] });
        const result = await connection.query({ text: "SELECT 42 AS answer", values: [] });
        await connection.query({ text: "ROLLBACK", values: [] });
        await connection.close();
        return Response.json(result);
      }
      if (path === "/rls") {
        using connection = await object.openRls({ subject: "alice", claims: { team: "green" } });
        const result = await connection.query({
          text: "SELECT current_setting('ohmyhost.request_claims')::jsonb AS claims",
          values: [],
        });
        const commit = await connection.commit();
        await connection.close();
        return Response.json({ result, commit });
      }
      if (path === "/rls-invalid") {
        using connection = await object.openRls(null);
        const result = await connection.query({ text: "COMMIT", values: [] });
        const commit = await connection.commit();
        await connection.close();
        return Response.json({ result, commit });
      }
      return Response.json(await object.query());
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown" },
        { status: 500 },
      );
    }
  },
};
