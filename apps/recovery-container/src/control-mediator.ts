import {
  createUlidFactory,
  parseNewProductionFrameworkPlan,
  type Clock,
  type UlidFactory,
} from "@ohmyhost/platform";
import {
  CONTROL_METHODS_BY_ACTION,
  CONTROL_TOKEN_PATTERN,
  MAX_CONTROL_REQUEST_BYTES,
  MAX_CONTROL_RESPONSE_BYTES,
  RECOVERY_CONTROL_HOST,
  RECOVERY_CONTROL_METHODS,
  RecoveryControlError,
  encodeControlResult,
  decodeControlResult,
  isUlid,
  isUuid,
  parseControlBody,
  type ControlAction,
  type ControlErrorCode,
  type RecoveryControlMethod,
  type WireArchive,
  type WireDatabaseReference,
  type WireFence,
  type WireInventory,
  type WireNativeAuthDatabase,
} from "@ohmyhost/project-recovery-worker/control-wire";

/**
 * The closed private store surface the Worker calls through a service binding. It is exactly the typed Q5-A
 * RecoveryPort (`executor`) plus the owner-side archive locator read for the download action. Nothing here accepts SQL,
 * a database URL or an arbitrary method name, and the Node container never sees this object.
 */
export interface RecoveryStorePort {
  readClaimState(input: unknown): Promise<unknown>;
  claim(input: unknown): Promise<unknown>;
  acquireFence(input: unknown): Promise<unknown>;
  renewFence(input: unknown): Promise<unknown>;
  releaseFence(input: unknown): Promise<unknown>;
  readScope(input: unknown): Promise<RecoveryScopeSnapshot | null>;
  authorizeNativeCapture?(input: unknown): Promise<unknown>;
  prepareArchive(input: unknown): Promise<unknown>;
  dispatchArchive?(input: unknown): Promise<unknown>;
  discardArchive(input: unknown): Promise<unknown>;
  finish(input: unknown): Promise<unknown>;
  readArchive(input: unknown): Promise<unknown>;
  readCleanupTarget?(input: unknown): Promise<unknown>;
  recordNativeExportRetired?(input: unknown): Promise<unknown>;
  readNativeRestorePinDeletionTarget?(input: unknown): Promise<unknown>;
  recordNativeRestorePinDeletionAbsent?(input: unknown): Promise<unknown>;
}

/**
 * The canonical complete recovery inventory of the store (`readRecoveryScope`): ONE consistent snapshot of the project,
 * canonical Prod and optional Dev with their newest assignment, active plan and placed database. The store already
 * refused every inconsistent shape (`recovery_inventory_invalid`, `recovery_database_not_ready`); this module only
 * adds the plan validation the store cannot do and the Node-side refusal of a historical Neon placement. The test
 * file proves structural identity with the store's own `RecoveryScope` type.
 */
export interface RecoveryScopeSnapshot {
  readonly dataMode: "shared" | "isolated";
  readonly ownershipVersion: number;
  readonly lifecycleVersion: number;
  readonly environments: readonly RecoveryScopeEnvironmentSnapshot[];
  readonly nativeAuthDatabase?: WireNativeAuthDatabase;
}
export interface RecoveryScopeEnvironmentSnapshot {
  readonly environmentId: string;
  readonly name: "dev" | "prod";
  readonly databaseEnvironmentId: string;
  readonly assignmentVersion: number;
  readonly headVersion: number;
  readonly activeDeploymentId: string | null;
  readonly activeRevisionId: string | null;
  readonly head: {
    readonly deploymentId: string;
    readonly revisionId: string;
    readonly frameworkPlan: Readonly<Record<string, unknown>>;
    readonly databaseEnabled: boolean;
  } | null;
  readonly database:
    | {
        readonly provider: "pgcf";
        readonly providerProjectId: string;
        readonly databaseId: string;
        readonly regionId: string;
        readonly postgresVersion: "18";
        readonly databaseName: string;
        readonly roleName: string;
        readonly databaseEnvironmentId: string;
        readonly targetVersion: number;
      }
    | {
        readonly provider: "neon";
        readonly providerProjectId: string;
        readonly branchId: string;
        readonly regionId: string;
        readonly postgresVersion: number;
        readonly databaseName: "neondb";
        readonly roleName: "neondb_owner";
        readonly databaseEnvironmentId: string;
      }
    | null;
}

export interface RecoveryControlDependencies {
  readonly store: RecoveryStorePort;
  readonly restore?: NativeRestoreDependencies;
}

export interface NativeRestoreDependencies {
  readonly store: {
    readClaim(input: unknown): Promise<unknown>;
    readInput(input: unknown): Promise<unknown>;
    reservePin(input: unknown): Promise<unknown>;
    recordPin(input: unknown): Promise<unknown>;
    recordPinAbsent(input: unknown): Promise<unknown>;
    beginRestore(input: unknown): Promise<unknown>;
    assertImportAllowed(input: unknown): Promise<unknown>;
    isAcknowledged(input: unknown): Promise<unknown>;
    acknowledge(input: unknown): Promise<unknown>;
    isRealmImported(input: unknown): Promise<unknown>;
    markRealmImported(input: unknown): Promise<unknown>;
    markImported(input: unknown): Promise<unknown>;
    finish(input: unknown): Promise<unknown>;
    readPinReconciliation(input: unknown): Promise<unknown>;
    completePinReconciliation(input: unknown): Promise<unknown>;
  };
  readonly admin: (region: "us-dev" | "eu-dev") => {
    applyRealmPolicy(input: unknown): Promise<unknown>;
    sanitizeRestore(input: unknown): Promise<unknown>;
  };
  readonly preparation: (region: "us-dev" | "eu-dev") => {
    prepare(input: unknown): Promise<unknown>;
  };
}

/** What the sandbox object passes to the egress proxy for ONE job (never the token itself, only its digest). */
export interface RecoveryControlGrant {
  readonly containerId: string;
  readonly action: ControlAction;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly claimId?: string;
  readonly exportId?: string;
  readonly restoreId?: string;
  readonly principalId?: string;
  readonly delegation?: unknown;
  readonly tokenSha256: string;
  readonly expiresAtMs: number;
}

/** Structural form of the Container class outbound handler context. */
export interface OutboundContext {
  readonly containerId: string;
  readonly className: string;
  readonly params?: unknown;
}

const GRANT_KEYS = [
  "action",
  "claimId",
  "exportId",
  "restoreId",
  "principalId",
  "delegation",
  "containerId",
  "expiresAtMs",
  "operationId",
  "organizationId",
  "projectId",
  "tokenSha256",
];

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Worker mints one token per container start; the Node side keeps it only in its process environment. */
export function mintControlToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function parseGrant(value: unknown): RecoveryControlGrant | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  const expected = GRANT_KEYS.filter(
    (key) =>
      (key !== "claimId" || record["action"] === "run" || record["action"] === "restore") &&
      (key !== "exportId" || record["action"] === "purge") &&
      (key !== "restoreId" || record["action"] === "purge-restore-pin") &&
      (key !== "principalId" || record["action"] === "reconcile-restore-pin") &&
      (key !== "delegation" ||
        (record["action"] === "reconcile-restore-pin" && record["delegation"] !== undefined)),
  );
  if (keys.sort().join(",") !== expected.sort().join(",")) return null;
  const action = record["action"];
  if (
    action !== "run" &&
    action !== "download" &&
    action !== "purge" &&
    action !== "restore" &&
    action !== "purge-restore-pin" &&
    action !== "reconcile-restore-pin"
  )
    return null;
  if (
    typeof record["containerId"] !== "string" ||
    record["containerId"].length < 1 ||
    record["containerId"].length > 128 ||
    !isUlid(record["organizationId"]) ||
    !isUlid(record["projectId"]) ||
    !isUlid(record["operationId"]) ||
    ((action === "run" || action === "restore") && !isUuid(record["claimId"])) ||
    (action === "purge" && !isUlid(record["exportId"])) ||
    (action === "purge-restore-pin" && !isUlid(record["restoreId"])) ||
    (action === "reconcile-restore-pin" &&
      (typeof record["principalId"] !== "string" ||
        record["principalId"].length < 1 ||
        record["principalId"].length > 256)) ||
    typeof record["tokenSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record["tokenSha256"]) ||
    typeof record["expiresAtMs"] !== "number" ||
    !Number.isSafeInteger(record["expiresAtMs"])
  )
    return null;
  return {
    containerId: record["containerId"],
    action,
    organizationId: record["organizationId"] as string,
    projectId: record["projectId"] as string,
    operationId: record["operationId"] as string,
    ...(action === "run" || action === "restore" ? { claimId: record["claimId"] as string } : {}),
    ...(action === "purge" ? { exportId: record["exportId"] as string } : {}),
    ...(action === "purge-restore-pin" ? { restoreId: record["restoreId"] as string } : {}),
    ...(action === "reconcile-restore-pin"
      ? {
          principalId: record["principalId"] as string,
          ...(record["delegation"] === undefined ? {} : { delegation: record["delegation"] }),
        }
      : {}),
    tokenSha256: record["tokenSha256"],
    expiresAtMs: record["expiresAtMs"],
  };
}

function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

interface FailureMapping {
  readonly status: number;
  readonly code: ControlErrorCode;
}

const FAILURES: Readonly<Record<string, FailureMapping>> = {
  RecoveryFenceLostError: { status: 409, code: "recovery_fence_lost" },
  RecoverySourceBusyError: { status: 409, code: "recovery_source_busy" },
  ProjectRecoveryConflictError: { status: 409, code: "project_recovery_conflict" },
  RecoveryScopeUnavailableError: { status: 409, code: "recovery_scope_unavailable" },
  StoreOutcomeUnknownError: { status: 503, code: "control_outcome_unknown" },
  StoreBusyError: { status: 503, code: "control_outcome_unknown" },
};
/** The two plain `Error`s of the canonical inventory carry their code as the message (the original names). */
const INVENTORY_FAILURES: Readonly<Record<string, FailureMapping>> = {
  recovery_database_not_ready: { status: 409, code: "recovery_database_not_ready" },
  recovery_inventory_invalid: { status: 409, code: "recovery_inventory_invalid" },
  recovery_cleanup_scope_unavailable: { status: 409, code: "recovery_cleanup_scope_unavailable" },
};

/**
 * Maps whatever the store port threw (in-process, or after a Workers RPC hop, where only `name` and `message` are
 * reliable) to a closed wire code. Anything unknown is `control_unavailable`: nothing about it reaches the container.
 */
export function classifyStoreFailure(error: unknown): FailureMapping {
  if (error instanceof RecoveryControlError)
    return {
      status:
        error.code === "payload_too_large"
          ? 413
          : error.code === "recovery_database_not_ready" ||
              error.code === "recovery_inventory_invalid"
            ? 409
            : 400,
      code: error.code,
    };
  if (!(error instanceof Error)) return { status: 503, code: "control_unavailable" };
  return (
    FAILURES[error.name] ??
    INVENTORY_FAILURES[error.message] ?? {
      status: 503,
      code: "control_unavailable",
    }
  );
}

function failure(code: ControlErrorCode, status: number): Response {
  return new Response(JSON.stringify({ code }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function boundedText(request: Request): Promise<string> {
  const stated = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(stated) || stated > MAX_CONTROL_REQUEST_BYTES)
    throw new RecoveryControlError("payload_too_large");
  if (request.body === null) throw new RecoveryControlError("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_CONTROL_REQUEST_BYTES) {
        await reader.cancel();
        throw new RecoveryControlError("payload_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RecoveryControlError("invalid_request");
  }
}

/**
 * The wire inventory of one canonical store snapshot. The framework plan is validated here with the platform parser
 * (the store only proves a JSON object); a plan whose database requirement disagrees with the stored flag, or a
 * historical Neon placement (never an active capture source), is refused instead of being captured as nothing.
 */
export function recoveryInventoryOf(scope: RecoveryScopeSnapshot): WireInventory {
  const prod = scope.environments.at(-1),
    dev = scope.environments.length === 2 ? scope.environments[0] : undefined;
  if (
    scope.environments.length < 1 ||
    scope.environments.length > 2 ||
    prod?.name !== "prod" ||
    (scope.environments.length === 2 && dev?.name !== "dev")
  )
    throw new RecoveryControlError("recovery_inventory_invalid");
  const entry = (environment: RecoveryScopeEnvironmentSnapshot) => {
    if (environment.head !== null) {
      let enabled: boolean;
      try {
        enabled = parseNewProductionFrameworkPlan(environment.head.frameworkPlan).database.enabled;
      } catch {
        throw new RecoveryControlError("recovery_inventory_invalid");
      }
      if (enabled !== environment.head.databaseEnabled)
        throw new RecoveryControlError("recovery_inventory_invalid");
    }
    const database = environment.database;
    if (database?.provider === "neon")
      throw new RecoveryControlError("recovery_database_not_ready");
    return {
      environmentId: environment.environmentId,
      name: environment.name,
      databaseEnvironmentId: environment.databaseEnvironmentId,
      database:
        database === null
          ? null
          : ({
              provider: "pgcf",
              providerProjectId: database.providerProjectId,
              databaseId: database.databaseId,
              regionId: database.regionId,
              postgresVersion: database.postgresVersion,
              databaseName: database.databaseName,
              roleName: database.roleName,
              databaseEnvironmentId: database.databaseEnvironmentId,
              targetVersion: database.targetVersion,
            } satisfies WireDatabaseReference),
    };
  };
  return {
    dataMode: scope.dataMode,
    ownershipVersion: scope.ownershipVersion,
    lifecycleVersion: scope.lifecycleVersion,
    environments: dev === undefined ? [entry(prod)] : [entry(dev), entry(prod)],
    ...(scope.nativeAuthDatabase === undefined
      ? {}
      : { nativeAuthDatabase: scope.nativeAuthDatabase }),
  };
}

/** The inventory the capture needs: one canonical store snapshot, validated and mapped. `null`: not an active project. */
export async function readRecoveryInventory(
  dependencies: RecoveryControlDependencies,
  input: { organizationId: string; projectId: string },
): Promise<WireInventory | null> {
  // Only the exact scope crosses to the store, whatever else the caller holds.
  const scope = await dependencies.store.readScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  return scope === null ? null : recoveryInventoryOf(scope);
}

export interface RecoveryControlHandlerOptions<Env> {
  /** The private bindings of the Worker environment; absent bindings fail closed (`control_unavailable`). */
  readonly dependencies: (env: Env) => RecoveryControlDependencies | undefined;
  readonly clock?: Clock;
  readonly ids?: Pick<UlidFactory, "next">;
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

/**
 * The Container outbound handler for the one virtual hostname. The job scope, claim and container identity come from
 * the grant the sandbox object attached (`ctx.params`), never from the request; the presented bearer must hash to the
 * grant's digest and be unexpired. The body can only carry the method's own closed fields.
 *
 * Trusted time is taken twice: before the request body is read (the early refusal) and again after the bounded body
 * was read and parsed, immediately before the store executes, so a slow body can never carry an instant (or a token)
 * across its expiry. With `clock: "execution"` the store decides at the SQL clock of its own shard database and guards
 * its write batch against that clock when it executes (this instant is not trusted). Event ids are
 * minted here per request; a repeat after a lost response is recognised by the store through the claim, holder and
 * epoch, archive and terminal outcome it already recorded, never by these ids.
 */
export function createRecoveryControlHandler<Env>(options: RecoveryControlHandlerOptions<Env>) {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const ids =
    options.ids ??
    createUlidFactory({
      clock,
      entropy: { fill: (target: Uint8Array) => void crypto.getRandomValues(target) },
    });
  return async (request: Request, env: Env, context: OutboundContext): Promise<Response> => {
    const url = new URL(request.url);
    const method = url.pathname.startsWith("/v1/") ? url.pathname.slice(4) : "";
    if (
      request.method !== "POST" ||
      url.hostname !== RECOVERY_CONTROL_HOST ||
      url.search !== "" ||
      !(RECOVERY_CONTROL_METHODS as readonly string[]).includes(method)
    )
      return failure("not_found", 404);
    const grant = parseGrant(context.params);
    if (grant === null || grant.containerId !== context.containerId)
      return failure("forbidden", 403);
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!CONTROL_TOKEN_PATTERN.test(token) || !sameText(await sha256Hex(token), grant.tokenSha256))
      return failure("unauthorized", 401);
    if (clock.now().getTime() >= grant.expiresAtMs) return failure("token_expired", 401);
    const action = grant.action;
    if (!(CONTROL_METHODS_BY_ACTION[action] as readonly string[]).includes(method))
      return failure("forbidden", 403);
    const name = method as RecoveryControlMethod;
    try {
      const raw = await boundedText(request);
      let body: Record<string, unknown>;
      try {
        body = parseControlBody(name, JSON.parse(raw));
      } catch (error) {
        if (error instanceof RecoveryControlError) throw error;
        throw new RecoveryControlError("invalid_request");
      }
      const dependencies = options.dependencies(env);
      if (dependencies === undefined) return failure("control_unavailable", 503);
      // The trusted instant of THIS command: after the body, immediately before the store runs.
      const executed = clock.now();
      if (executed.getTime() >= grant.expiresAtMs) return failure("token_expired", 401);
      const result = await execute(dependencies, grant, name, body, executed.toISOString(), ids);
      const text = encodeControlResult(result);
      if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_RESPONSE_BYTES)
        return failure("control_unavailable", 502);
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (error) {
      const mapped = classifyStoreFailure(error);
      console.warn(
        JSON.stringify({ event: "recovery_control_refused", method, code: mapped.code }),
      );
      return failure(mapped.code, mapped.status);
    }
  };
}

async function execute(
  dependencies: RecoveryControlDependencies,
  grant: RecoveryControlGrant,
  method: RecoveryControlMethod,
  body: Record<string, unknown>,
  now: string,
  ids: Pick<UlidFactory, "next">,
): Promise<unknown> {
  const scope = {
    organizationId: grant.organizationId,
    projectId: grant.projectId,
    operationId: grant.operationId,
  };
  // Every time-dependent decision of the store runs at its own execution clock, never at a stale instant.
  const clockAuthority = { clock: "execution" } as const;
  const job = () => ({
    ...scope,
    claimId: grant.claimId,
    occurredAt: now,
    operationEventId: ids.next(),
    auditEventId: ids.next(),
    ...clockAuthority,
  });
  const { store } = dependencies;
  if (grant.action === "reconcile-restore-pin") {
    if (!dependencies.restore || !grant.principalId) throw new Error("native_restore_unavailable");
    const scope = {
      organizationId: grant.organizationId,
      projectId: grant.projectId,
      restoreId: grant.operationId,
      principalId: grant.principalId,
      ...(grant.delegation === undefined ? {} : { delegation: grant.delegation }),
    };
    if (method === "readPinReconciliation")
      return dependencies.restore.store.readPinReconciliation(scope);
    if (method === "completePinReconciliation")
      return dependencies.restore.store.completePinReconciliation({
        ...scope,
        outcome: body["outcome"],
      });
    throw new Error("native_restore_unavailable");
  }
  if (grant.action === "restore") return executeRestore(dependencies, grant, method, body);
  switch (method) {
    case "readClaimState":
      return store.readClaimState(scope);
    case "claim": {
      const { epoch, holderId } = body as { epoch?: number; holderId?: string };
      return store.claim({
        ...job(),
        ...(holderId === undefined ? {} : { holderId }),
        // A denied claim ends the job in the same batch (and releases the holder's fence, when it names one).
        denial: {
          ...(epoch === undefined ? {} : { epoch }),
          operationEventId: ids.next(),
          auditEventId: ids.next(),
        },
      });
    }
    case "acquireFence":
      return store.acquireFence({
        ...scope,
        claimId: grant.claimId,
        now,
        ...clockAuthority,
        ...body,
      });
    case "renewFence":
      return store.renewFence({ ...scope, now, ...clockAuthority, ...body });
    case "releaseFence":
      return store.releaseFence({ ...scope, now, ...clockAuthority, ...body });
    case "readInventory":
      return readRecoveryInventory(dependencies, {
        organizationId: grant.organizationId,
        projectId: grant.projectId,
      });
    case "authorizeNativeCapture":
      if (!store.authorizeNativeCapture) throw new Error("recovery_control_unavailable");
      return store.authorizeNativeCapture({ ...job(), fence: body["fence"] as WireFence });
    case "prepareArchive":
      return store.prepareArchive({
        ...job(),
        archive: body["archive"] as WireArchive,
        fence: body["fence"] as WireFence,
      });
    case "dispatchArchive":
      if (!store.dispatchArchive) throw new Error("recovery_control_unavailable");
      return store.dispatchArchive({
        ...job(),
        archive: body["archive"] as WireArchive,
        fence: body["fence"] as WireFence,
      });
    case "discardArchive":
      return store.discardArchive({
        ...job(),
        archive: body["archive"] as WireArchive,
        fence: body["fence"] as WireFence,
      });
    case "finish":
      return store.finish({ ...job(), ...body });
    case "readArchive":
      return store.readArchive({ ...scope, now, ...clockAuthority });
    case "readCleanupTarget":
      if (store.readCleanupTarget === undefined || grant.exportId === undefined)
        throw new Error("recovery_cleanup_scope_unavailable");
      return store.readCleanupTarget({ ...scope, exportId: grant.exportId });
    case "recordNativeExportRetired":
      if (!store.recordNativeExportRetired || !grant.exportId)
        throw new Error("recovery_cleanup_scope_unavailable");
      return store.recordNativeExportRetired({
        ...scope,
        exportId: grant.exportId,
        outcome: body["outcome"],
      });
    case "readRestorePinDeletionTarget":
      if (store.readNativeRestorePinDeletionTarget === undefined || grant.restoreId === undefined)
        throw new Error("recovery_cleanup_scope_unavailable");
      return store.readNativeRestorePinDeletionTarget({ ...scope, restoreId: grant.restoreId });
    case "recordRestorePinDeletionAbsent":
      if (store.recordNativeRestorePinDeletionAbsent === undefined || grant.restoreId === undefined)
        throw new Error("recovery_cleanup_scope_unavailable");
      return store.recordNativeRestorePinDeletionAbsent({ ...scope, restoreId: grant.restoreId });
    default:
      throw new Error("recovery_control_unavailable");
  }
}

async function executeRestore(
  dependencies: RecoveryControlDependencies,
  grant: RecoveryControlGrant,
  method: RecoveryControlMethod,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!dependencies.restore || !grant.claimId) throw new Error("native_restore_unavailable");
  const service = dependencies.restore,
    scope = {
      organizationId: grant.organizationId,
      projectId: grant.projectId,
      restoreId: grant.operationId,
      claimId: grant.claimId,
    };
  const claim = async () =>
    decodeControlResult(
      "readRestoreClaim",
      encodeControlResult(await service.store.readClaim(scope)),
    ) as import("@ohmyhost/project-recovery-worker/control-wire").NativeRestoreClaim;
  if (method === "readRestoreClaim") return service.store.readClaim(scope);
  if (method === "readRestoreInput") return service.store.readInput(scope);
  if (method === "reserveRestorePin") return service.store.reservePin(scope);
  if (method === "recordRestorePin") return service.store.recordPin(scope);
  if (method === "recordRestorePinAbsent") return service.store.recordPinAbsent(scope);
  if (method === "beginRestore") return service.store.beginRestore(scope);
  if (method === "assertRestoreImportAllowed") return service.store.assertImportAllowed(scope);
  if (method === "markRestoreImported") return service.store.markImported(scope);
  if (method === "completeRestore") {
    const result = await service.store.finish(scope);
    if (
      typeof result !== "object" ||
      result === null ||
      Reflect.get(result, "status") !== "complete"
    )
      throw new Error("native_restore_unavailable");
    return { status: "ok" };
  }
  const current = await claim();
  if (current.completed) throw new Error("native_restore_unavailable");
  const environmentId = String(body["environmentId"]),
    realm = current.realms.find((r) => r.environmentId === environmentId);
  if (!realm) throw new Error("native_restore_unavailable");
  const requested = { ...scope, environmentId };
  if (method === "isRestoreRealmImported") return service.store.isRealmImported(requested);
  if (method === "markRestoreRealmImported") return service.store.markRealmImported(requested);
  if (method === "isRestoreAcknowledged")
    return service.store.isAcknowledged({ ...requested, kind: body["kind"] });
  if (method === "acknowledgeRestore") {
    if (
      body["revocationEpoch"] !== realm.revocationEpoch ||
      body["configurationRevision"] !== realm.configurationRevision
    )
      throw new Error("native_restore_unavailable");
    const result = await service.store.acknowledge({ ...requested, ...body });
    if (
      typeof result !== "object" ||
      result === null ||
      Reflect.get(result, "acknowledged") !== true
    )
      throw new Error("native_restore_unavailable");
    return { status: "ok" };
  }
  const regional = current.target.regionId;
  if (regional !== "us-dev" && regional !== "eu-dev") throw new Error("native_restore_unavailable");
  const privateScope = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId,
    restoreId: scope.restoreId,
    claimId: scope.claimId,
  };
  if (method === "applyRestoreOffline") {
    if (
      body["revocationEpoch"] !== realm.revocationEpoch ||
      body["configurationRevision"] !== realm.configurationRevision ||
      body["canonicalOrigin"] !== realm.canonicalOrigin
    )
      throw new Error("native_restore_unavailable");
    const result = await service.admin(regional).applyRealmPolicy({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId,
      enabled: false,
      canonicalOrigin: realm.canonicalOrigin,
      revocationEpoch: realm.revocationEpoch,
      configurationRevision: realm.configurationRevision,
    });
    if (
      typeof result !== "object" ||
      result === null ||
      Reflect.get(result, "outcome") !== "applied"
    )
      throw new Error("native_restore_unavailable");
    await claim();
    return { status: "ok" };
  }
  if (method === "revalidateRestore") {
    const result = await service.preparation(regional).prepare(privateScope);
    if (
      typeof result !== "object" ||
      result === null ||
      Reflect.get(result, "status") !== "verified"
    )
      throw new Error("native_restore_unavailable");
    await claim();
    return { status: "ok" };
  }
  if (method === "sanitizeRestore") {
    const result = await service.admin(regional).sanitizeRestore(privateScope);
    if (
      typeof result !== "object" ||
      result === null ||
      Reflect.get(result, "status") !== "sanitized" ||
      Reflect.get(result, "revocationEpoch") !== realm.revocationEpoch ||
      Reflect.get(result, "configurationRevision") !== realm.configurationRevision
    )
      throw new Error("native_restore_unavailable");
    await claim();
    return result;
  }
  throw new Error("native_restore_unavailable");
}
