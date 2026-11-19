import { DatabaseLanePool } from "../../src/connection-pool.js";
import { databaseObjectName } from "../../src/registry.js";
import {
  ProjectDatabaseEnvironment as RuntimeEnvironment,
  ProjectDatabaseQa as RuntimeQa,
  type ProjectDatabaseBindings,
} from "../../src/worker-service.js";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface LocalBindings extends ProjectDatabaseBindings {
  readonly TEST_DATABASE_URI: string;
}

/** Only the local socket transport is substituted; the production registry, executor and RPC stay real. */
export class QaEnvironment extends RuntimeEnvironment {
  private readonly localPools: {
    query: DatabaseLanePool;
    transaction: DatabaseLanePool;
    auth: DatabaseLanePool;
  };
  public constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: LocalBindings) {
    super(ctx, env);
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
  public async prepare(input: unknown) {
    const receipt = await this.register(input);
    Object.assign(this, { pools: this.localPools });
    return receipt;
  }
  public async closeLocal() {
    await Promise.all(Object.values(this.localPools).map((pool) => pool.invalidate()));
  }
}
// Wrangler's base config names this class; Miniflare binds the explicit QaEnvironment below.
export { QaEnvironment as ProjectDatabaseEnvironment };

// Local workerd has no jurisdiction support; keep the real named-object selection while testing EU.
export class ProjectDatabaseQa extends RuntimeQa {
  public constructor(ctx: ConstructorParameters<typeof WorkerEntrypoint>[0], env: LocalBindings) {
    super(ctx, {
      ...env,
      DATABASE_ENVIRONMENTS: {
        jurisdiction(region: string) {
          if (region !== "eu") throw new Error("unexpected_region");
          return env.DATABASE_ENVIRONMENTS;
        },
      } as never,
    });
  }
}

export default {
  async fetch(request: Request, env: LocalBindings) {
    const input = (await request.json()) as Record<string, unknown>;
    const scope = {
      organizationId: String(input["organizationId"]),
      projectId: String(input["projectId"]),
      physicalEnvironmentId: String(input["physicalEnvironmentId"]),
      region: "eu" as const,
    };
    const object = env.DATABASE_ENVIRONMENTS.getByName(databaseObjectName(scope), {
      locationHint: "weur",
    }) as QaEnvironment;
    if (new URL(request.url).pathname === "/close") {
      await object.closeLocal();
      return new Response(null, { status: 204 });
    }
    return Response.json(await object.prepare(input));
  },
};
