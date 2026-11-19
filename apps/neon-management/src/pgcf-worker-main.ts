import { createD1PgcfEntitlementPersistence } from "./d1-pgcf-entitlements.js";
import { databaseSizeForClass } from "@ohmyhost/contracts/database-sizes";
import { computeState } from "./pgcf-runtime.js";
import {
  createD1PgcfComputePersistence,
  createD1ProjectDatabaseAccessManager,
  createD1ProjectDatabaseWritePersistence,
  readD1ProductDatabaseBindings,
  type D1ProductDatabaseBindings,
} from "./d1-product-database.js";
import type { DatabaseWriteConnection } from "./database-write.js";
import type { PgcfPostgresTarget } from "@ohmyhost/database";
import {
  readD1PgcfManagementBindings,
  createD1PgcfPersistence,
  type D1PgcfManagementBindings,
} from "./d1-pgcf-management.js";
import type { PgcfManagementDependencies } from "./pgcf-runtime.js";
import { readD1PgcfConfiguration, type D1PgcfConfiguration } from "./d1-bindings.js";
import { readPgcfRollups } from "./pgcf-rollups.js";
import { productionPgcfDataConnection, queryPgcfProject } from "./pgcf-data-operations.js";
import { createProjectDatabaseWriter } from "./database-write.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  SystemClock,
  SystemEntropy,
  createUlidFactory,
  parseUlid,
  type DatabaseMigrationClient,
  type DatabaseMigrationPreparedStatement,
} from "@ohmyhost/platform";
import {
  createProductionPgcfProvider,
  createProductionPgcfRuntime,
  pgcfManagementConnect,
} from "./provider-runtime.js";
import { createPgcfComputeChanges } from "./pgcf-compute.js";
import { createPgcfEntitlementReconciler } from "./pgcf-entitlements.js";
import {
  createPgcfDatabaseEvents,
  parseDatabaseEventRequest,
  sweepOrphanDatabaseWebhooks,
} from "./pgcf-database-events.js";
import {
  createPgcfDatabaseWatches,
  isDatabaseWatchOperation,
  parseDatabaseWatchRequest,
} from "./pgcf-database-watches.js";
import { createPgcfDatabaseTables, parseDatabaseTableCall } from "./pgcf-database-tables.js";
import { createPgcfScheduleStopper, parseStopSchedulesRequest } from "./pgcf-stop-schedules.js";
import {
  createPgcfWebhookSubscriptions,
  createWebhookLifecycleCipher,
  isDatabaseWebhookSubscriptionOperation,
  parseDatabaseWebhookSubscriptionRequest,
} from "./pgcf-webhook-subscriptions.js";

export type Bindings = D1PgcfConfiguration | D1PgcfManagementBindings | D1ProductDatabaseBindings;

type D1ManagementAction =
  | "placeProject"
  | "migrateProject"
  | "deleteProject"
  | "readRuntimeBinding"
  | "reauthorizeDataEnvironment";

function d1ManagementRuntime(
  raw: unknown,
  connect?: PgcfManagementDependencies["connect"],
  sleep?: PgcfManagementDependencies["sleep"],
) {
  const bindings = readD1PgcfManagementBindings(raw);
  return createProductionPgcfRuntime(
    bindings,
    {
      persistence: createD1PgcfPersistence(bindings.DATABASE_MANAGEMENT_RUNTIME),
      ...(sleep ? { sleep } : {}),
    },
    connect,
  );
}
function runD1Management(
  raw: unknown,
  action: D1ManagementAction,
  input: unknown,
  connect?: PgcfManagementDependencies["connect"],
  sleep?: PgcfManagementDependencies["sleep"],
) {
  return d1ManagementRuntime(raw, connect, sleep)[action](input);
}

function usageWindowInput(input: unknown): { from: string; to: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "from,to"
  )
    throw new TypeError("Invalid usage request");
  const { from, to } = input as Record<"from" | "to", unknown>;
  if (typeof from !== "string" || typeof to !== "string")
    throw new TypeError("Invalid usage request");
  return { from, to };
}

/**
 * The credit service's only Neon authority: the usage rollup and the budget sweep. The full
 * management entrypoint also serves database access, so the credit service binds this one.
 */
export class NeonUsageService extends WorkerEntrypoint<Bindings> {
  readonly #management: NeonManagementService;
  constructor(context: unknown, environment: Bindings) {
    super(context, environment);
    this.#management = new NeonManagementService(context, environment);
  }
  public async collectUsage(input: unknown) {
    return this.#management.collectUsage(input);
  }
  public async stopSchedules(input: unknown) {
    return this.#management.stopSchedules(input);
  }
}

export class NeonManagementService extends WorkerEntrypoint<Bindings> {
  readonly #managementConnect: PgcfManagementDependencies["connect"] | undefined;
  readonly #managementSleep: PgcfManagementDependencies["sleep"] | undefined;
  readonly #productConnect:
    | ((uri: string, target: PgcfPostgresTarget) => Promise<DatabaseWriteConnection>)
    | undefined;
  constructor(
    context: unknown,
    environment: Bindings,
    managementConnect?: PgcfManagementDependencies["connect"],
    productConnect?: (uri: string, target: PgcfPostgresTarget) => Promise<DatabaseWriteConnection>,
    managementSleep?: PgcfManagementDependencies["sleep"],
  ) {
    super(context, environment);
    this.#managementConnect = managementConnect;
    this.#productConnect = productConnect;
    this.#managementSleep = managementSleep;
  }
  /** Final hourly memory rollups of one hour-aligned window; it reads the provider only and keeps nothing. */
  public async collectUsage(input: unknown) {
    const { from, to } = usageWindowInput(input);
    const bindings = readD1PgcfConfiguration(this.env);
    return readPgcfRollups({
      provider: createProductionPgcfProvider(bindings),
      providerProjectId: bindings.PGCF_APPS_PROJECT_ID,
      from,
      to,
      now: new Date(),
      budgetMs: 40_000,
    });
  }
  /** One database event operation (webhooks, deliveries, schedules, usage, watches) of one project environment. */
  public async databaseEvents(input: unknown) {
    if (isDatabaseWatchOperation(input))
      return this.#databaseWatches().run(parseDatabaseWatchRequest(input));
    if (isDatabaseWebhookSubscriptionOperation(input)) {
      const request = parseDatabaseWebhookSubscriptionRequest(input);
      return this.#webhookSubscriptions().run(request);
    }
    const request = parseDatabaseEventRequest(input);
    return this.#databaseEvents().run(request);
  }
  /** Creates one table of a project environment's database as the migration role; table watches attach to it. */
  public async createDatabaseTable(input: unknown) {
    return this.#databaseTables().run(parseDatabaseTableCall(input));
  }
  /** Disables the enabled schedules of a project's runtime role in dev and prod (the budget sweep of the credit service). */
  public async stopSchedules(input: unknown) {
    const scope = parseStopSchedulesRequest(input);
    return createPgcfScheduleStopper(this.#databaseEvents())(scope);
  }
  #databaseEvents() {
    const bindings = readD1ProductDatabaseBindings(this.env);
    return createPgcfDatabaseEvents({
      readScope: (scope) => bindings.DATABASE_PRODUCT_RUNTIME.readProductComputeScope(scope),
      provider: createProductionPgcfProvider(bindings),
    });
  }

  #webhookSubscriptions() {
    const bindings = readD1ProductDatabaseBindings(this.env),
      key = bindings["DATABASE_WEBHOOK_SECRET_KEY_BASE64"],
      version = bindings["DATABASE_WEBHOOK_SECRET_KEY_VERSION"],
      additional = bindings["DATABASE_WEBHOOK_SECRET_ADDITIONAL_KEYS_JSON"];
    if (
      typeof key !== "string" ||
      typeof version !== "string" ||
      (additional !== undefined && typeof additional !== "string")
    )
      throw new Error("Webhook secret custody is unavailable");
    for (const method of [
      "beginWebhookActivation",
      "finishWebhookActivation",
      "abortWebhookActivation",
      "beginWebhookDeactivation",
      "finishWebhookDeactivation",
      "readWebhookSubscription",
    ] as const)
      if (typeof bindings.DATABASE_PRODUCT_RUNTIME[method] !== "function")
        throw new Error("Webhook lifecycle is unavailable");
    const custody = createWebhookLifecycleCipher({
      keyBase64: key,
      keyVersion: Number(version),
      ...(additional === undefined ? {} : { additionalKeysJson: additional }),
    });
    return createPgcfWebhookSubscriptions({
      readScope: (scope) => bindings.DATABASE_PRODUCT_RUNTIME.readProductComputeScope(scope),
      provider: createProductionPgcfProvider(bindings),
      runtime: bindings.DATABASE_PRODUCT_RUNTIME,
      ...custody,
      now: () => new Date(),
    });
  }

  #databaseWatches() {
    const bindings = readD1ProductDatabaseBindings(this.env);
    return createPgcfDatabaseWatches({
      readScope: (scope) => bindings.DATABASE_PRODUCT_RUNTIME.readProductComputeScope(scope),
      provider: createProductionPgcfProvider(bindings),
      connect: this.#managementConnect ?? pgcfManagementConnect(),
    });
  }

  #databaseTables() {
    const bindings = readD1ProductDatabaseBindings(this.env);
    return createPgcfDatabaseTables({
      readScope: (scope) => bindings.DATABASE_PRODUCT_RUNTIME.readProductComputeScope(scope),
      provider: createProductionPgcfProvider(bindings),
      connect: this.#managementConnect ?? pgcfManagementConnect(),
    });
  }

  public async changeCompute(input: unknown) {
    return this.#d1Compute().accept(input);
  }
  public async runComputeChange(input: unknown) {
    return this.#d1Compute().run(input);
  }
  public async placeProject(input: unknown) {
    return runD1Management(
      this.env,
      "placeProject",
      input,
      this.#managementConnect,
      this.#managementSleep,
    );
  }
  public async migrateProject(input: unknown) {
    return runD1Management(
      this.env,
      "migrateProject",
      input,
      this.#managementConnect,
      this.#managementSleep,
    );
  }
  public async deleteProject(input: unknown) {
    return runD1Management(
      this.env,
      "deleteProject",
      input,
      this.#managementConnect,
      this.#managementSleep,
    );
  }
  public async readRuntimeBinding(input: unknown) {
    return runD1Management(this.env, "readRuntimeBinding", input, this.#managementConnect);
  }
  public async reauthorizeDataEnvironment(input: unknown) {
    return runD1Management(this.env, "reauthorizeDataEnvironment", input, this.#managementConnect);
  }
  public async revokeDataChangeAccess(input: unknown) {
    return this.#d1Access().revokeDataChangeAccess(input);
  }

  public async readCompute(input: unknown) {
    const bindings = readD1ProductDatabaseBindings(this.env);
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new TypeError("Invalid compute request");
    const value = input as Record<string, unknown>,
      organizationId = parseUlid(String(value["organizationId"])),
      projectId = parseUlid(String(value["projectId"]));
    if (
      Object.keys(value).sort().join(",") !== "environment,organizationId,projectId" ||
      (value["environment"] !== "dev" && value["environment"] !== "prod")
    )
      throw new TypeError("Invalid compute request");
    const scope = await bindings.DATABASE_PRODUCT_RUNTIME.readProductComputeScope({
        organizationId,
        projectId,
        environment: value["environment"],
      }),
      target = scope.target,
      provider = createProductionPgcfProvider(bindings);
    // An environment without a database yet is absent, not a fault (the caller owns the project).
    if (target === null) return null;
    if (target.provider !== "pgcf" || target.providerProjectId !== provider.projectId)
      throw new Error("Database compute scope unavailable");
    const database = await provider.readDatabase(target.databaseId),
      size = databaseSizeForClass(database.sizeClassId);
    return {
      project_id: projectId,
      environment: value["environment"],
      data_mode: scope.dataMode,
      observed_at: new Date().toISOString(),
      database: {
        provider: "pgcf" as const,
        size_class_id: database.sizeClassId,
        memory_mib: database.resources.memoryMiB,
        cpu_millicores: database.resources.cpuMillicores,
        storage_mib: database.resources.storageMiB,
        max_connections: size.maxConnections,
        suspend_timeout_seconds: database.sleepAfterSeconds ?? -1,
        state: computeState(database),
        pending_state: database.observedGeneration === database.generation ? null : "provisioning",
        disabled: database.desiredState === "suspended" && database.suspensionReason !== "idle",
        region: database.regionId === "us-dev" ? "us" : "eu",
      },
    };
  }

  public async writeProject(input: unknown) {
    const bindings = readD1ProductDatabaseBindings(this.env),
      clock = new SystemClock();
    return createProjectDatabaseWriter({
      persistence: createD1ProjectDatabaseWritePersistence(bindings.DATABASE_PRODUCT_RUNTIME),
      clock,
      ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
      pgcfProvider: createProductionPgcfProvider(bindings),
      connect: async (uri, target) => {
        if (this.#productConnect) return this.#productConnect(uri, target);
        const connection = await productionPgcfDataConnection(uri, target);
        return {
          close: connection.close,
          client: connection.client as unknown as DatabaseWriteConnection["client"],
        };
      },
    })(input);
  }
  #d1Compute() {
    const bindings = readD1PgcfManagementBindings(this.env),
      product = readD1ProductDatabaseBindings(this.env),
      clock = new SystemClock();
    return createPgcfComputeChanges({
      persistence: createD1PgcfComputePersistence(
        product.DATABASE_PRODUCT_RUNTIME,
        bindings.DATABASE_MANAGEMENT_RUNTIME,
        clock,
      ),
      provider: createProductionPgcfProvider(bindings),
      clock,
      ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
    });
  }
  #d1Access() {
    return createProductionD1DatabaseAccess(this.env, this.#managementConnect);
  }

  public async queryProject(input: unknown) {
    const bindings = readD1ProductDatabaseBindings(this.env);
    return queryPgcfProject(
      {
        readTarget: (scope) => bindings.DATABASE_PRODUCT_RUNTIME.readProductDiagnosticTarget(scope),
        provider: createProductionPgcfProvider(bindings),
        connect: async (uri, target) => {
          if (!this.#productConnect) return productionPgcfDataConnection(uri, target);
          const connection = await this.#productConnect(uri, target);
          return {
            close: connection.close,
            client: {
              query: (
                query: string | { text: string; values: unknown[]; queryMode: "extended" },
                values?: unknown[],
              ) =>
                typeof query === "string" && values !== undefined
                  ? connection.client.query({ text: query, values, queryMode: "extended" })
                  : connection.client.query(query),
            },
          };
        },
      },
      input,
    );
  }
  public async maintainDatabaseProducts() {
    return maintainProductionD1DatabaseProducts(this.env, new Date(), this.#managementConnect);
  }

  public async issueDatabaseAccess(input: unknown) {
    return this.#d1Access().issue(input);
  }
  public async revokeDatabaseAccess(input: unknown) {
    return this.#d1Access().revoke(input);
  }
}

export function createProductionD1DatabaseAccess(
  raw: unknown,
  connectOverride?: PgcfManagementDependencies["connect"],
) {
  const bindings = readD1ProductDatabaseBindings(raw),
    clock = new SystemClock(),
    entropy = new SystemEntropy();
  return createD1ProjectDatabaseAccessManager({
    runtime: bindings.DATABASE_PRODUCT_RUNTIME,
    provider: createProductionPgcfProvider(bindings),
    clock,
    entropy,
    ids: createUlidFactory({ clock, entropy }),
    connect: async (uri, target) => {
      const connection: {
        readonly client: DatabaseMigrationClient;
        readonly close: () => Promise<void>;
      } = connectOverride
        ? await connectOverride(uri, target)
        : await productionPgcfDataConnection(uri, target);
      return {
        close: connection.close,
        client: {
          query: (text: string | DatabaseMigrationPreparedStatement, values?: readonly unknown[]) =>
            connection.client.query(text, values ? [...values] : []),
        },
      };
    },
  });
}
export async function maintainProductionD1DatabaseProducts(
  raw: unknown,
  at: Date,
  connectOverride?: PgcfManagementDependencies["connect"],
  expireWrites = true,
) {
  const bindings = readD1ProductDatabaseBindings(raw),
    clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() }),
    runtime = bindings.DATABASE_PRODUCT_RUNTIME;
  const expiredWrites = expireWrites
    ? await runtime.expireProductDatabaseWrites({
        now: clock.now().toISOString(),
        passId: ids.next(),
      })
    : 0;
  const entitlements = await createPgcfEntitlementReconciler({
    persistence: createD1PgcfEntitlementPersistence(runtime),
    provider: createProductionPgcfProvider(bindings),
    clock,
    ids,
  }).reconcile();
  const access = await createProductionD1DatabaseAccess(raw, connectOverride).sweep(at);
  // Bounded per pass: the webhook cap is shared by every customer, so the backlog of earlier deletions drains over passes.
  const webhooks = await sweepOrphanDatabaseWebhooks(createProductionPgcfProvider(bindings), {
    maxDeletes: ORPHAN_WEBHOOK_DELETES_PER_PASS,
  });
  return { expiredWrites, entitlements, access, webhooks };
}

const ORPHAN_WEBHOOK_DELETES_PER_PASS = 50;

export default class NeonManagementWorker extends WorkerEntrypoint<Bindings> {
  public async scheduled(controller: { scheduledTime: number }) {
    const at = new Date(controller.scheduledTime),
      products = await maintainProductionD1DatabaseProducts(this.env, at, undefined, false);
    console.log(
      JSON.stringify({ event: "database_compute_entitlements", ...products.entitlements }),
    );
    console.log(JSON.stringify({ event: "database_access_sweep", ...products.access }));
    console.log(JSON.stringify({ event: "database_webhook_orphan_sweep", ...products.webhooks }));
    if (products.entitlements.failed > 0)
      throw new Error("Database compute maintenance is incomplete");
  }

  public async fetch() {
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  }
}
