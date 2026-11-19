import { isWorkerPostgresDatabaseError, type PgcfPostgresTarget } from "@ohmyhost/database";
import { RpcTarget, WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import {
  connectBoundedProjectDatabase,
  connectRlsProjectDatabase,
  createProjectDatabaseService,
  executeQaDatabase,
  executePreviewDatabase,
  ProjectDatabaseOutcomeUnknownError,
  ProjectDatabaseBusyError,
  ProjectDatabaseInputError,
  ProjectDatabaseResultError,
  ProjectDatabaseRlsError,
  type BoundedProjectDatabaseConnection,
  type ProjectDatabaseClient,
  type ProjectDatabaseServiceDependencies,
  type RlsProjectDatabaseConnection,
} from "./service.js";
import {
  createProjectDatabaseHttpWorker,
  type ProjectDatabaseHttpBindings,
} from "./http-worker.js";
import { DatabaseLanePool, pooledClientDependencies } from "./connection-pool.js";
import {
  createDatabaseRegistry,
  databaseObjectName,
  databaseRegistryKeyRing,
  readDatabaseBindingScope,
  readDatabasePhysicalScope,
  pgcfTarget,
  type DatabaseBindingScope,
  type DatabasePhysicalScope,
  type DatabaseRegion,
  type DatabaseRegistrationReceipt,
} from "./registry.js";
import {
  authorizeQaDatabase,
  qaDatabaseDeadline,
  readQaDatabaseCall,
  type QaDatabaseBindings,
} from "./qa-database.js";
import {
  authorizePreviewDatabase,
  readPreviewDatabaseCall,
  readPreviewDatabaseFence,
  type ProjectPreviewDatabaseBindings,
} from "./preview-database.js";

interface DatabaseObjectNamespace {
  jurisdiction(region: DatabaseRegion): DatabaseObjectNamespace;
  getByName(name: string, options: { locationHint: "enam" | "weur" }): ProjectDatabaseEnvironment;
}
export interface ProjectDatabaseBindings
  extends QaDatabaseBindings,
    ProjectPreviewDatabaseBindings {
  readonly DATABASE_ENVIRONMENTS: DatabaseObjectNamespace;
  readonly DATABASE_REGION: DatabaseRegion;
  readonly DATABASE_REGISTRY_KEY: string;
  readonly DATABASE_REGISTRY_KEY_VERSION?: string;
  readonly DATABASE_REGISTRY_KEY_PREVIOUS?: string;
  readonly DATABASE_REGISTRY_KEY_PREVIOUS_VERSION?: string;
  readonly OHMYHOST_MAIL_GATEWAY: ProjectDatabaseHttpBindings["OHMYHOST_MAIL_GATEWAY"];
}

/** Private Development QA capability; no customer Worker binds this entrypoint. */
export class ProjectDatabaseQa extends WorkerEntrypoint<ProjectDatabaseBindings> {
  public execute(input: unknown) {
    const { scope } = readQaDatabaseCall(input, this.env);
    return databaseObject(this.env, scope).executeQa(input);
  }
}

/** Private product preview capability; the guest cannot supply its own database scope. */
export class ProjectDatabasePreview extends WorkerEntrypoint<ProjectDatabaseBindings> {
  private async target(input: unknown) {
    if (!isRecord(input)) throw new Error("project_database_unavailable");
    const fence = readPreviewDatabaseFence(input["fence"]);
    const authorized = await authorizePreviewDatabase(this.env, fence, (scope) =>
      databaseObject(this.env, scope).inspect(previewPhysicalScope(scope)),
    );
    return databaseObject(this.env, authorized.scope);
  }
  public async open(input: unknown) {
    return (await this.target(input)).openPreview(input, false);
  }
  public async openRls(input: unknown) {
    return (await this.target(input)).openPreview(input, true);
  }
  public async execute(input: unknown) {
    const call = readPreviewDatabaseCall(input);
    const authorized = await authorizePreviewDatabase(this.env, call.fence, (scope) =>
      databaseObject(this.env, scope).inspect({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        physicalEnvironmentId: scope.physicalEnvironmentId,
        region: scope.region,
      }),
    );
    return databaseObject(this.env, authorized.scope).executePreview(input);
  }
}

/** This entrypoint alone is bound into untrusted customer applications. */
export class ProjectDatabaseService extends WorkerEntrypoint<
  ProjectDatabaseBindings,
  DatabaseBindingScope
> {
  public fetch(request: Request) {
    const scope = readDatabaseBindingScope(this.ctx.props, this.env.DATABASE_REGION);
    return databaseObject(this.env, scope).authenticate(scope, request);
  }
  public query(input: unknown) {
    const scope = readDatabaseBindingScope(this.ctx.props, this.env.DATABASE_REGION);
    return databaseObject(this.env, scope).query(scope, input);
  }
  public transaction(input: unknown) {
    const scope = readDatabaseBindingScope(this.ctx.props, this.env.DATABASE_REGION);
    return databaseObject(this.env, scope).transaction(scope, input);
  }
  public open() {
    const scope = readDatabaseBindingScope(this.ctx.props, this.env.DATABASE_REGION);
    return databaseObject(this.env, scope).open(scope);
  }
  public openRls(identity: unknown) {
    const scope = readDatabaseBindingScope(this.ctx.props, this.env.DATABASE_REGION);
    return databaseObject(this.env, scope).openRls(scope, identity);
  }
}

/** A separate service binding exclusively for trusted provider-management code. */
export class ProjectDatabaseAdmin extends WorkerEntrypoint<ProjectDatabaseBindings> {
  public register(input: unknown) {
    return databaseObject(this.env, adminScope(input, this.env)).register(input);
  }
  public rebind(input: unknown) {
    if (!isRecord(input) || !isRecord(input["registration"]))
      throw new Error("project_database_unavailable");
    return databaseObject(this.env, adminScope(input["registration"], this.env)).rebind(input);
  }
  public revoke(input: unknown) {
    return databaseObject(this.env, adminScope(input, this.env)).revoke(input);
  }
  public inspect(input: unknown) {
    return databaseObject(
      this.env,
      readDatabasePhysicalScope(input, this.env.DATABASE_REGION),
    ).inspect(input);
  }
}

export class ProjectDatabaseEnvironment extends DurableObject<ProjectDatabaseBindings> {
  private readonly registry = createDatabaseRegistry({
    region: this.env.DATABASE_REGION,
    keyRing: databaseRegistryKeyRing(this.env),
    storage: this.ctx.storage,
    invalidate: (next, credentialsChanged) => this.invalidate(next, credentialsChanged),
  });
  private pools:
    | { query: DatabaseLanePool; transaction: DatabaseLanePool; auth: DatabaseLanePool }
    | undefined;
  private readonly connections = new Map<
    ProjectDatabaseConnection | ProjectDatabaseRlsConnection,
    string
  >();
  private readonly clients = new Map<
    ProjectDatabaseClient,
    { environmentId: string; terminate: () => Promise<void> }
  >();
  private poolConnectionString: string | undefined;
  private poolTarget: PgcfPostgresTarget | undefined;
  private epoch = 0;

  public register(input: unknown) {
    return this.registry.register(input);
  }
  public rebind(input: unknown) {
    return this.registry.rebind(input);
  }
  public revoke(input: unknown) {
    return this.registry.revoke(input);
  }
  public inspect(input: unknown) {
    return this.registry.inspect(input);
  }
  public executeQa(input: unknown) {
    return executeRpc("transaction", async () => {
      const { scope, operation, input: statement } = readQaDatabaseCall(input, this.env);
      const physical = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        physicalEnvironmentId: scope.physicalEnvironmentId,
        region: scope.region,
      };
      const bindingScope = readDatabaseBindingScope(
        {
          ...physical,
          environmentId: scope.environmentId,
          registrationVersion: scope.registrationVersion,
        },
        this.env.DATABASE_REGION,
      );
      const authorize = () =>
        authorizeQaDatabase(this.env, scope, () => this.registry.inspect(physical));
      const deadline = qaDatabaseDeadline();
      await deadline.run(authorize);
      const resources = await deadline.run(() => this.resources(bindingScope));
      const result = await executeQaDatabase(
        resources.uri,
        this.dependencies(resources.pools.transaction, bindingScope),
        operation,
        statement,
        authorize,
        deadline,
      );
      // Once COMMIT has been sent, a failed post-check suppresses the result. The caller must
      // regard any lost reply as unknown and never automatically replay a possible write.
      await deadline.run(authorize);
      return result;
    });
  }
  public executePreview(input: unknown) {
    return executeRpc("transaction", async () => {
      const call = readPreviewDatabaseCall(input);
      const inspect = (scope: DatabaseBindingScope) =>
        this.registry.inspect({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          physicalEnvironmentId: scope.physicalEnvironmentId,
          region: scope.region,
        });
      const deadline = qaDatabaseDeadline();
      const initial = await deadline.run(() =>
        authorizePreviewDatabase(this.env, call.fence, inspect),
      );
      const authorize = async () => {
        await authorizePreviewDatabase(this.env, call.fence, inspect, initial);
      };
      const resources = await deadline.run(() => this.resources(initial.scope));
      const result = await executePreviewDatabase(
        resources.uri,
        this.dependencies(resources.pools.transaction, initial.scope),
        call.operation,
        call.input,
        authorize,
        deadline,
      );
      try {
        await deadline.run(authorize);
      } catch {
        // SQL may already have committed; revocation cannot turn it into a safe retry.
        throw new ProjectDatabaseOutcomeUnknownError();
      }
      return result;
    });
  }
  public openPreview(input: unknown, rls: true): Promise<ProjectDatabaseRlsConnection>;
  public openPreview(input: unknown, rls: false): Promise<ProjectDatabaseConnection>;
  public openPreview(input: unknown, rls: boolean) {
    return executeRpc("open", async () => {
      if (
        !isRecord(input) ||
        Object.keys(input).sort().join(",") !== (rls ? "fence,identity" : "fence")
      )
        throw new Error("project_database_unavailable");
      const fence = readPreviewDatabaseFence(input["fence"]);
      const inspect = (scope: DatabaseBindingScope) =>
        this.registry.inspect(previewPhysicalScope(scope));
      const initial = await authorizePreviewDatabase(this.env, fence, inspect);
      const authorize = async () => {
        await authorizePreviewDatabase(this.env, fence, inspect, initial);
      };
      const scope = initial.scope;
      const resources = await this.resources(scope);
      if (rls) {
        const connection = await connectRlsProjectDatabase(
          resources.uri,
          this.dependencies(resources.pools.transaction, scope),
          slotKey(scope.physicalEnvironmentId),
          input["identity"],
          authorize,
        );
        const target: ProjectDatabaseRlsConnection = new ProjectDatabaseRlsConnection(
          connection,
          () => this.connections.delete(target),
          authorize,
        );
        this.connections.set(target, scope.environmentId);
        return target;
      }
      const connection = await connectBoundedProjectDatabase(
        resources.uri,
        this.dependencies(resources.pools.transaction, scope),
        slotKey(scope.physicalEnvironmentId),
        () => Date.now(),
        authorize,
      );
      try {
        await authorize();
      } catch (error) {
        await connection.abort();
        throw error;
      }
      const target: ProjectDatabaseConnection = new ProjectDatabaseConnection(
        connection,
        authorize,
        () => this.connections.delete(target),
        true,
      );
      this.connections.set(target, scope.environmentId);
      return target;
    });
  }
  public query(scope: DatabaseBindingScope, input: unknown) {
    return executeRpc("query", async () => {
      const resources = await this.resources(scope);
      return createProjectDatabaseService(
        resources.uri,
        this.dependencies(resources.pools.query, scope),
      ).query(input);
    });
  }
  public transaction(scope: DatabaseBindingScope, input: unknown) {
    return executeRpc("transaction", async () => {
      const resources = await this.resources(scope);
      return createProjectDatabaseService(
        resources.uri,
        this.dependencies(resources.pools.transaction, scope),
      ).transaction(input);
    });
  }
  public open(scope: DatabaseBindingScope) {
    return executeRpc("open", async () => {
      const resources = await this.resources(scope);
      const connection = await connectBoundedProjectDatabase(
        resources.uri,
        this.dependencies(resources.pools.transaction, scope),
        slotKey(scope.physicalEnvironmentId),
      );
      try {
        await this.registry.authorize(scope);
      } catch (error) {
        await connection.close();
        throw error;
      }
      const target: ProjectDatabaseConnection = new ProjectDatabaseConnection(
        connection,
        () => this.registry.authorize(scope),
        () => this.connections.delete(target),
      );
      this.connections.set(target, scope.environmentId);
      return target;
    });
  }
  public openRls(scope: DatabaseBindingScope, identity: unknown) {
    return executeRpc("open", async () => {
      const resources = await this.resources(scope);
      const connection = await connectRlsProjectDatabase(
        resources.uri,
        this.dependencies(resources.pools.transaction, scope),
        slotKey(scope.physicalEnvironmentId),
        identity,
        () => this.registry.authorize(scope),
      );
      const target: ProjectDatabaseRlsConnection = new ProjectDatabaseRlsConnection(
        connection,
        () => this.connections.delete(target),
      );
      this.connections.set(target, scope.environmentId);
      return target;
    });
  }
  public async authenticate(scope: DatabaseBindingScope, request: Request): Promise<Response> {
    try {
      const resources = await this.resources(scope);
      await this.registry.authorize(scope);
      return await createProjectDatabaseHttpWorker({ sharedPool: resources.pools.auth }).fetch(
        request,
        {
          DATABASE_CONNECTION_STRING: resources.uri,
          PROJECT_ID: scope.projectId,
          OHMYHOST_MAIL_GATEWAY: this.env.OHMYHOST_MAIL_GATEWAY,
        },
      );
    } catch {
      return Response.json(
        { error: "service_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  }
  private async resources(scope: DatabaseBindingScope) {
    const epoch = this.epoch;
    const { uri, receipt } = await this.registry.authorizeConnection(scope);
    if (epoch !== this.epoch) throw new Error("project_database_unavailable");
    const target = receipt.provider === "pgcf" ? pgcfTarget(receipt) : undefined;
    this.pools ??= {
      query: new DatabaseLanePool(uri, 1, target),
      transaction: new DatabaseLanePool(uri, 2, target),
      auth: new DatabaseLanePool(uri, 2, target),
    };
    this.poolConnectionString = uri;
    this.poolTarget = target;
    // A scope change replaces the auth lane; a paused request must keep the invalidated old lane.
    return { uri, pools: Object.freeze({ ...this.pools }) };
  }
  private dependencies(
    pool: DatabaseLanePool,
    scope: DatabaseBindingScope,
  ): ProjectDatabaseServiceDependencies {
    const adapter = pooledClientDependencies(pool);
    const clients = this.clients;
    const registry = this.registry;
    return {
      createClient(configuration) {
        const client = adapter.createClient(configuration);
        let connected = false;
        let revoked = false;
        const terminate = async () => {
          revoked = true;
          // A queued lease must fail after acquisition; it may never dispatch application SQL.
          if (!connected) return;
          try {
            await (client.terminate ? client.terminate() : client.end());
          } finally {
            clients.delete(target);
          }
        };
        const target: ProjectDatabaseClient = {
          async connect() {
            try {
              await client.connect();
              connected = true;
              if (revoked) throw new Error("project_database_unavailable");
              await registry.authorize(scope);
              if (revoked) throw new Error("project_database_unavailable");
            } catch (error) {
              await terminate();
              clients.delete(target);
              throw error;
            }
          },
          on: (event, listener) => client.on?.(event, listener),
          async query(input) {
            if (revoked) throw new Error("project_database_unavailable");
            const result = await client.query(input);
            if (revoked) throw new Error("project_database_unavailable");
            return result;
          },
          terminate,
          async end() {
            try {
              if (revoked) await terminate();
              else await client.end();
            } finally {
              clients.delete(target);
            }
          },
        };
        clients.set(target, { environmentId: scope.environmentId, terminate });
        return target;
      },
    };
  }
  private async invalidate(
    next: DatabaseRegistrationReceipt,
    credentialsChanged: boolean,
  ): Promise<void> {
    this.epoch += 1;
    const pools = this.pools;
    const lost = (environmentId: string) =>
      credentialsChanged || !next.authorizedEnvironmentIds.includes(environmentId);
    const closures = [
      ...[...this.clients.values()]
        .filter((client) => lost(client.environmentId))
        .map((client) => client.terminate()),
      ...[...this.connections.entries()]
        .filter(([, environmentId]) => lost(environmentId))
        .map(([connection]) => connection.abort()),
    ];
    if (pools) {
      if (credentialsChanged) {
        this.pools = undefined;
        this.poolConnectionString = undefined;
        this.poolTarget = undefined;
        closures.push(
          pools.query.invalidate(),
          pools.transaction.invalidate(),
          pools.auth.invalidate(),
        );
      } else {
        // Better Auth owns raw pg leases; reset its lane while preserving scoped Prod transactions.
        closures.push(pools.auth.invalidate());
        pools.auth = new DatabaseLanePool(this.poolConnectionString as string, 2, this.poolTarget);
      }
    }
    await Promise.all(closures);
  }
}

export class ProjectDatabaseConnection extends RpcTarget {
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private idleTimer: ReturnType<typeof setTimeout>;
  private closed = false;
  private activeCalls = 0;
  public constructor(
    private readonly connection: BoundedProjectDatabaseConnection,
    private readonly authorize: () => Promise<unknown>,
    private readonly released: () => unknown,
    private readonly recheckResult = false,
  ) {
    super();
    this.lifetimeTimer = setTimeout(() => {
      void this.expire().catch(ignoreClosedConnection);
    }, 30_000);
    this.idleTimer = setTimeout(() => {
      void this.expire().catch(ignoreClosedConnection);
    }, 5_000);
  }
  public query(input: unknown) {
    return executeRpc("connection_query", async () => {
      if (this.closed) throw new Error("project_database_connection_closed");
      try {
        await this.authorize();
      } catch (error) {
        await this.expire();
        throw error;
      }
      this.activeCalls += 1;
      clearTimeout(this.idleTimer);
      try {
        const result = await this.connection.query(input);
        if (this.recheckResult) {
          try {
            await this.authorize();
          } catch {
            await this.expire();
            throw new ProjectDatabaseOutcomeUnknownError();
          }
        }
        return result;
      } finally {
        this.activeCalls -= 1;
        // Only the last finishing query arms the idle timer, so an earlier one can never expire the session.
        if (!this.closed && this.activeCalls === 0) {
          clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => {
            void this.expire().catch(ignoreClosedConnection);
          }, 5_000);
        }
      }
    });
  }
  private expire() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearTimeout(this.lifetimeTimer);
    clearTimeout(this.idleTimer);
    this.released();
    return this.connection.abort();
  }
  public abort() {
    return executeRpc("connection_close", () => this.expire());
  }
  public close() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearTimeout(this.lifetimeTimer);
    clearTimeout(this.idleTimer);
    this.released();
    return executeRpc("connection_close", () => this.connection.close());
  }
  public [Symbol.dispose]() {
    void this.expire().catch(ignoreClosedConnection);
  }
}

/** Only the service can commit this transaction; dispose and expiry always abort it. */
export class ProjectDatabaseRlsConnection extends RpcTarget {
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private idleTimer: ReturnType<typeof setTimeout>;
  private closed = false;
  private activeCalls = 0;
  private failureCode: ProjectDatabaseRlsError["code"] = "database_rls_transaction_failed";
  public constructor(
    private readonly connection: RlsProjectDatabaseConnection,
    private readonly released: () => unknown,
    private readonly recheckResult?: () => Promise<unknown>,
  ) {
    super();
    this.lifetimeTimer = setTimeout(() => {
      void this.abort().catch(ignoreClosedConnection);
    }, 30_000);
    this.idleTimer = this.#startIdleTimer();
  }
  #startIdleTimer() {
    return setTimeout(() => {
      void this.abort().catch(ignoreClosedConnection);
    }, 5_000);
  }
  #finish() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetimeTimer);
    clearTimeout(this.idleTimer);
    this.released();
  }
  public query(input: unknown) {
    return executeRpc("rls_query", async () => {
      if (this.closed) throw new ProjectDatabaseRlsError(this.failureCode);
      this.activeCalls += 1;
      clearTimeout(this.idleTimer);
      try {
        const result = await this.connection.query(input);
        await this.recheckResult?.();
        return result;
      } catch (error) {
        await this.abort();
        throw error;
      } finally {
        this.activeCalls -= 1;
        if (!this.closed && this.activeCalls === 0) this.idleTimer = this.#startIdleTimer();
      }
    });
  }
  public commit() {
    return executeRpc("rls_commit", async () => {
      if (this.closed) throw new ProjectDatabaseRlsError(this.failureCode);
      this.activeCalls += 1;
      clearTimeout(this.idleTimer);
      try {
        await this.connection.commit();
        try {
          await this.recheckResult?.();
        } catch {
          throw new ProjectDatabaseRlsError("database_transaction_outcome_unknown");
        }
        return Object.freeze({ type: "ohmyhost.database-rls-commit/v1" as const });
      } catch (error) {
        if (error instanceof ProjectDatabaseRlsError) this.failureCode = error.code;
        throw error;
      } finally {
        this.activeCalls -= 1;
        this.#finish();
      }
    });
  }
  public close() {
    if (this.closed) return Promise.resolve();
    this.#finish();
    return executeRpc("connection_close", () => this.connection.close());
  }
  public abort() {
    if (this.closed) return Promise.resolve();
    this.#finish();
    return this.connection.abort();
  }
  public [Symbol.dispose]() {
    void this.abort().catch(ignoreClosedConnection);
  }
}

function databaseObject(
  env: ProjectDatabaseBindings,
  scope: DatabasePhysicalScope,
): ProjectDatabaseEnvironment {
  return env.DATABASE_ENVIRONMENTS.jurisdiction(scope.region).getByName(databaseObjectName(scope), {
    locationHint: scope.region === "eu" ? "weur" : "enam",
  });
}
function previewPhysicalScope(scope: DatabaseBindingScope): DatabasePhysicalScope {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    physicalEnvironmentId: scope.physicalEnvironmentId,
    region: scope.region,
  };
}
function adminScope(input: unknown, env: ProjectDatabaseBindings): DatabasePhysicalScope {
  if (!isRecord(input)) throw new Error("project_database_unavailable");
  return readDatabasePhysicalScope(
    {
      organizationId: input["organizationId"],
      projectId: input["projectId"],
      physicalEnvironmentId: input["physicalEnvironmentId"],
      region: input["region"],
    },
    env.DATABASE_REGION,
  );
}
function slotKey(environmentId: string): number {
  let hash = 0;
  for (const character of environmentId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return hash;
}

interface StatementFailure {
  readonly type: "ohmyhost.database-error/v1";
  readonly sqlstate: string;
}

interface RlsFailure {
  readonly type: "ohmyhost.database-rls-error/v1";
  readonly code: ProjectDatabaseRlsError["code"];
}

/**
 * A closed, non-sensitive category for failures that carry no SQLSTATE; the error message itself is
 * never logged. It separates an endpoint that did not become reachable in time from a full lane.
 */
export function databaseFailureReason(
  error: unknown,
): "connect_timeout" | "busy" | "connection_terminated" | "limit" | null {
  if (error instanceof ProjectDatabaseBusyError) return "busy";
  // Rows, bytes, parameters, statements and refused statement forms fail alike on every retry.
  if (error instanceof ProjectDatabaseInputError || error instanceof ProjectDatabaseResultError)
    return "limit";
  if (!(error instanceof Error) || isWorkerPostgresDatabaseError(error)) return null;
  if (
    error.message === "Connection terminated due to connection timeout" ||
    error.message === "timeout exceeded when trying to connect"
  )
    return "connect_timeout";
  if (error.message === "Connection terminated unexpectedly") return "connection_terminated";
  return null;
}

function executeRpc<Result>(
  operation: "rls_query" | "rls_commit",
  work: () => Promise<Result>,
): Promise<Result | StatementFailure | RlsFailure>;
function executeRpc<Result>(
  operation: "query" | "transaction" | "connection_query",
  work: () => Promise<Result>,
): Promise<Result | StatementFailure>;
function executeRpc<Result>(
  operation: "open" | "connection_close",
  work: () => Promise<Result>,
): Promise<Result>;
async function executeRpc<Result>(
  operation:
    | "query"
    | "transaction"
    | "open"
    | "connection_query"
    | "connection_close"
    | "rls_query"
    | "rls_commit",
  work: () => Promise<Result>,
) {
  try {
    return await work();
  } catch (error) {
    const diagnostic: Record<string, string> = {
      event: `project_database_${operation}_failed`,
    };
    const reason = databaseFailureReason(error);
    if (reason !== null) diagnostic["reason"] = reason;
    if (isRecord(error)) {
      const code = error["code"];
      const constraint = error["constraint"];
      if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) diagnostic["code"] = code;
      if (typeof constraint === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(constraint)) {
        diagnostic["constraint"] = constraint;
      }
    }
    console.error(JSON.stringify(diagnostic));
    if (error instanceof ProjectDatabaseRlsError)
      return Object.freeze({ type: "ohmyhost.database-rls-error/v1" as const, code: error.code });
    const statement =
      operation === "query" ||
      operation === "transaction" ||
      operation === "connection_query" ||
      operation === "rls_query";
    if (
      statement &&
      isWorkerPostgresDatabaseError(error) &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/u.test(error.code)
    )
      return Object.freeze({ type: "ohmyhost.database-error/v1" as const, sqlstate: error.code });
    // A deterministic limit answers PostgreSQL's program_limit_exceeded, which the client
    // reports as a non-retryable CustomerDatabaseError instead of database_unavailable.
    if (statement && reason === "limit")
      return Object.freeze({ type: "ohmyhost.database-error/v1" as const, sqlstate: "54000" });
    throw new Error(`project_database_${operation}_failed`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ignoreClosedConnection(): undefined {
  return undefined;
}
