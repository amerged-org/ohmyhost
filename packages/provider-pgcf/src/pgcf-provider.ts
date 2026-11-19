/** Narrow consumer of PGCF Management API 1.7; no node/admin API or implicit provider fallback. */
export const PGCF_CONTRACT_VERSION = "1.7.0";
const PROJECT = /^prj_[a-z0-9]{20}$/u;
const DATABASE = /^[a-z][a-z0-9]{19}$/u;
const OPERATION = /^op_[a-z0-9]{20}$/u;
const ROLE = /^[a-z][a-z0-9_]{0,62}$/u;
const REGION = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/u;
const SIZE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u;
const WEBHOOK = /^whk_[a-z0-9]{20}$/u;
const DELIVERY = /^dlv_[0-9a-f]{20}$/u;
const EVENT = /^(?:evt_[0-9a-f]{20}|[a-z][a-z0-9]{19}:[1-9][0-9]{0,15}:[1-9][0-9]{0,15})$/u;
const SCHEDULE = /^[a-z][a-z0-9_-]{0,62}$/u;
const EVENT_TYPE = /^(?:\*|[a-z][a-z_]*\.(?:\*|[a-z][a-z0-9_]*))$/u;
/** Data deliveries name one concrete topic; the wildcard is only a subscription. */
const DATA_EVENT_TYPE = /^data\.[a-z][a-z0-9_]{0,47}$/u;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;
const SECRET = /^[\x21-\x7e]{16,512}$/u;
const CONFLICT_REASON = /^[a-z][a-z_]{0,47}$/u;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_USAGE_SPAN_MS = 31 * DAY_MS;
const MAX_LIST_LIMIT = 100;
const MAX_WEBHOOK_URL_LENGTH = 2048;
/** Stored URLs are normalized and percent-encoded, up to nine times the raw length. */
const MAX_STORED_WEBHOOK_URL_LENGTH = 32_768;

export const WEBHOOK_EVENT_TYPES = [
  "database.created",
  "database.ready",
  "database.woke",
  "database.slept",
  "database.suspended",
  "database.resized",
  "database.deleted",
  "operation.succeeded",
  "operation.failed",
  "webhook.test",
] as const;
export const DELIVERY_STATES = ["pending", "delivered", "dead_lettered"] as const;
export const DELIVERY_ERRORS = ["timeout", "network", "http", "expired", "permanent"] as const;
export const TEST_ERRORS = ["timeout", "network", "http"] as const;
export const SCHEDULE_OUTCOMES = [
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
  "rejected",
  "skipped_capacity",
  "skipped_suspended",
  "skipped_deleted",
  "skipped_missed",
] as const;
export const EXECUTION_METRICS = [
  "schedule_runs_succeeded",
  "schedule_runs_failed",
  "schedule_runs_timed_out",
  "schedule_runs_outcome_unknown",
  "schedule_runs_rejected",
  "schedule_runs_skipped",
  "events_emitted",
  "event_bytes",
  "webhook_attempts",
  "webhook_deliveries_delivered",
  "webhook_deliveries_dead_lettered",
] as const;

export interface PgcfResources {
  readonly memoryMiB: number;
  readonly cpuMillicores: number;
  readonly storageMiB: number;
}
export interface PgcfDatabase {
  readonly id: string;
  readonly projectId: string;
  readonly regionId: string;
  readonly name: string;
  readonly sizeClassId: string;
  readonly resources: PgcfResources;
  readonly desiredState: "running" | "suspended" | "deleted";
  readonly suspensionReason?: "manual" | "idle" | null;
  readonly observedState:
    | "pending"
    | "provisioning"
    | "hibernated"
    | "ready"
    | "error"
    | "deleting"
    | "deleted";
  readonly generation: number;
  readonly observedGeneration: number;
  readonly sleepAfterSeconds: number | null;
  readonly storageResidency?: "local" | "archiving" | "archived" | "restoring";
  readonly storageOperationId?: string | null;
}
export interface PgcfOperation {
  readonly id: string;
  readonly projectId: string;
  readonly databaseId: string;
  readonly generation: number;
  readonly kind: string;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly errorCode: string | null;
}
export interface PgcfMutationReceipt {
  readonly database: PgcfDatabase;
  readonly operation: PgcfOperation;
}

/** Contextual validation of a parsed resume receipt, including the provider's two-stage cold
 * activation. Historical same-key receipts remain readable; readiness is judged separately. */
export function isPgcfResumeReceipt(
  { database, operation }: PgcfMutationReceipt,
  expectedGeneration?: number,
): boolean {
  if (
    operation.databaseId !== database.id ||
    operation.projectId !== database.projectId ||
    !["database.resume", "database.archive", "database.rehydrate"].includes(operation.kind)
  )
    return false;
  if (
    expectedGeneration !== undefined &&
    (operation.kind === "database.archive"
      ? operation.generation !== expectedGeneration
      : operation.generation !== expectedGeneration &&
        operation.generation !== expectedGeneration + 1 &&
        !(
          operation.kind === "database.rehydrate" && operation.generation === expectedGeneration + 2
        ))
  )
    return false;
  const hasStorageOperation =
    typeof database.storageOperationId === "string" && OPERATION.test(database.storageOperationId);
  const linked = hasStorageOperation && database.storageOperationId === operation.id;
  const pending = operation.status === "pending" || operation.status === "running";
  if (operation.generation > database.generation) {
    if (
      expectedGeneration === undefined ||
      database.generation !== expectedGeneration ||
      operation.generation !== database.generation + 1
    )
      return false;
    return operation.kind === "database.rehydrate"
      ? (linked && pending && database.storageResidency === "restoring") ||
          (operation.status === "failed" &&
            hasStorageOperation &&
            ["archived", "restoring"].includes(database.storageResidency ?? ""))
      : operation.kind === "database.resume" &&
          pending &&
          database.desiredState === "suspended" &&
          database.storageResidency === "archiving" &&
          hasStorageOperation &&
          !linked;
  }
  if (operation.kind === "database.resume") return true;
  // A failed attempt remains observable after another request owns the next restore. It cannot
  // establish readiness, and keeping the old failure pending would strand its original action.
  if (
    operation.kind === "database.rehydrate" &&
    operation.status === "failed" &&
    hasStorageOperation &&
    ["archived", "restoring"].includes(database.storageResidency ?? "")
  )
    return true;
  if (
    operation.kind === "database.rehydrate" &&
    operation.status === "succeeded" &&
    linked &&
    database.storageResidency !== "local"
  )
    return false;
  const historical =
    (operation.status === "succeeded" || operation.status === "failed") &&
    database.generation > operation.generation;
  if (operation.kind === "database.rehydrate")
    return (
      historical ||
      (linked &&
        (operation.status === "succeeded"
          ? database.storageResidency === "local"
          : ["local", "archived", "restoring"].includes(database.storageResidency ?? "")))
    );
  // An archive parent keeps generation N while its accepted child may own the current storage
  // operation. The original expected generation and scoped resume response bind that parent.
  return (
    hasStorageOperation &&
    database.storageResidency !== undefined &&
    (linked || expectedGeneration !== undefined)
  );
}
export interface PgcfRole {
  readonly databaseId: string;
  readonly name: string;
  readonly owner: boolean;
  readonly passwordRevision: number;
  readonly validUntil: string | null;
  readonly connectionLimit: number | null;
  readonly memberOf: readonly string[];
  readonly bypassRls: boolean;
  readonly membershipOptions: { readonly inherit: boolean; readonly set: boolean };
}
export interface PgcfRoleCreate {
  readonly name: string;
  readonly valid_until?: string;
  readonly connection_limit?: number;
  readonly member_of?: readonly string[];
  readonly bypass_rls?: boolean;
  readonly membership_options?: { readonly inherit: boolean; readonly set: boolean };
}
export interface PgcfUsageRow {
  readonly databaseId: string;
  readonly projectId: string;
  readonly start: string;
  readonly end: string;
  readonly final: boolean;
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly gaps: readonly string[];
}
export type PgcfExecutionMetric = (typeof EXECUTION_METRICS)[number];
export interface PgcfExecutionUsageRow {
  readonly databaseId: string;
  readonly projectId: string;
  readonly start: string;
  readonly end: string;
  readonly final: boolean;
  readonly metrics: Readonly<Record<PgcfExecutionMetric, number>>;
}
export interface PgcfPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface PgcfWebhookInput {
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly databaseIds: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}
export interface PgcfWebhook {
  readonly id: string;
  readonly projectId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly databaseIds: readonly string[] | null;
  readonly headerNames: readonly string[];
  readonly createdAt: string;
}
/** The signing secret is returned by the creation answer only; callers must never log it. */
export interface PgcfWebhookCreated extends PgcfWebhook {
  readonly secret: string;
}
export interface PgcfWebhookDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: (typeof WEBHOOK_EVENT_TYPES)[number] | `data.${string}`;
  readonly webhookId: string;
  readonly state: (typeof DELIVERY_STATES)[number];
  readonly attempts: number;
  readonly createdAt: string;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly lastStatus: number | null;
  readonly lastError: (typeof DELIVERY_ERRORS)[number] | null;
}
export interface PgcfWebhookTestResult {
  readonly delivered: boolean;
  readonly status: number | null;
  readonly error: (typeof TEST_ERRORS)[number] | null;
  readonly durationMs: number;
}
export interface PgcfScheduleUpsert {
  readonly cron?: string;
  readonly everySeconds?: number;
  readonly statements: readonly string[];
  readonly role: string;
  readonly timeoutMs?: number;
  readonly enabled?: boolean;
}
export interface PgcfSchedule {
  readonly name: string;
  readonly cron: string | null;
  readonly everySeconds: number | null;
  readonly statements: readonly string[];
  readonly role: string;
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly createdAt: string;
}
export interface PgcfScheduleRun {
  readonly id: number;
  readonly schedule: string;
  readonly scheduledAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly outcome: (typeof SCHEDULE_OUTCOMES)[number];
  readonly sqlstate: string | null;
  readonly attempts: number;
  readonly manual: boolean;
}
export interface PgcfScheduleRunAccepted {
  readonly schedule: string;
  readonly state: "queued";
}

/** Only closed categories escape the adapter; response bodies can contain credentials. */
export class PgcfProviderError extends Error {
  constructor(
    readonly code:
      | "input"
      | "transport"
      | "timeout"
      | "contract"
      | "rejected"
      | "redirect"
      | "oversize",
    readonly status: number | null = null,
    readonly outcomeUnknown = false,
    /** A closed reason from a 409 body, such as `generation_changed` or `idempotency_in_progress`. */
    readonly conflictReason?: string,
  ) {
    super(`PGCF provider ${code}`);
    this.name = "PgcfProviderError";
  }
}
export interface PgcfProviderOptions {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly caller?: string;
  readonly audit?: (event: PgcfProviderAuditEvent) => void;
}
export interface PgcfProviderAuditEvent {
  readonly provider: "pgcf";
  readonly transport: "management";
  readonly host: string;
  readonly databaseId: string | null;
  readonly caller: string;
  readonly outcome: "started" | "succeeded" | "failed" | "blocked";
}
export class PgcfProjectProvider {
  readonly projectId: string;
  #origin: string;
  #key: string;
  #fetch: typeof globalThis.fetch;
  #timeout: number;
  #audit: PgcfProviderOptions["audit"];
  #caller: string;
  constructor(options: PgcfProviderOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new PgcfProviderError("input");
    }
    if (
      base.protocol !== "https:" ||
      base.pathname !== "/" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !HOST.test(base.hostname) ||
      base.port ||
      !PROJECT.test(options.projectId) ||
      !/^[\x21-\x7e]{16,512}$/u.test(options.apiKey)
    )
      throw new PgcfProviderError("input");
    this.projectId = options.projectId;
    this.#origin = base.origin;
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMs ?? 30_000;
    this.#audit = options.audit;
    this.#caller = options.caller ?? "database-management";
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(this.#caller) ||
      (this.#audit !== undefined && typeof this.#audit !== "function")
    )
      throw new PgcfProviderError("input");
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 120_000)
      throw new PgcfProviderError("input");
  }
  async readDatabase(databaseId: string, signal?: AbortSignal): Promise<PgcfDatabase> {
    return this.database(
      await this.request(
        `/v1/databases/${identifier(databaseId, DATABASE)}`,
        "GET",
        [200],
        undefined,
        undefined,
        signal,
      ),
      databaseId,
    );
  }
  async readOperation(operationId: string, signal?: AbortSignal): Promise<PgcfOperation> {
    const operation = this.operation(
      await this.request(
        `/v1/operations/${identifier(operationId, OPERATION)}`,
        "GET",
        [200],
        undefined,
        undefined,
        signal,
      ),
    );
    if (operation.id !== operationId) throw new PgcfProviderError("contract");
    return operation;
  }
  async createDatabase(input: {
    name: string;
    regionId: string;
    sizeClassId: string;
    idempotencyKey: string;
  }): Promise<PgcfMutationReceipt> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(input.name))
      throw new PgcfProviderError("input");
    const result = this.mutation(
      await this.request(
        "/v1/databases",
        "POST",
        [202],
        {
          project_id: this.projectId,
          name: input.name,
          region_id: identifier(input.regionId, REGION),
          size_class_id: identifier(input.sizeClassId, SIZE),
        },
        input.idempotencyKey,
      ),
    );
    if (
      result.database.name !== input.name ||
      result.database.regionId !== input.regionId ||
      result.database.sizeClassId !== input.sizeClassId ||
      result.operation.kind !== "database.create"
    )
      throw new PgcfProviderError("contract", 202, true);
    return result;
  }
  async changeDatabase(
    databaseId: string,
    action: "resize" | "suspend" | "resume" | "delete",
    idempotencyKey: string,
    sizeClassId?: string,
    expectedGeneration?: number,
    signal?: AbortSignal,
  ): Promise<PgcfMutationReceipt> {
    identifier(databaseId, DATABASE);
    if (!["resize", "suspend", "resume", "delete"].includes(action))
      throw new PgcfProviderError("input");
    if (
      expectedGeneration !== undefined &&
      (!Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration < 1 ||
        !["suspend", "resume"].includes(action))
    )
      throw new PgcfProviderError("input");
    const body =
      action === "resize"
        ? { size_class_id: identifier(sizeClassId, SIZE) }
        : expectedGeneration === undefined
          ? undefined
          : { expected_generation: expectedGeneration };
    const result = this.mutation(
      await this.request(
        `/v1/databases/${databaseId}${action === "suspend" || action === "resume" ? `/${action}` : ""}`,
        action === "resize" ? "PATCH" : action === "delete" ? "DELETE" : "POST",
        [202],
        body,
        idempotencyKey,
        signal,
      ),
      databaseId,
      action === "resume" ? { expectedGeneration } : undefined,
    );
    if (
      action !== "resume" &&
      expectedGeneration !== undefined &&
      result.operation.generation !== expectedGeneration &&
      result.operation.generation !== expectedGeneration + 1
    )
      throw new PgcfProviderError("contract", 202, true);
    if (action !== "resume" && result.operation.kind !== `database.${action}`)
      throw new PgcfProviderError("contract", 202, true);
    return result;
  }
  /** PGCF creates a role synchronously: a 201 answer (replays included) carries the Role and no operation. */
  async createRole(
    databaseId: string,
    role: PgcfRoleCreate,
    idempotencyKey: string,
  ): Promise<PgcfRole> {
    identifier(databaseId, DATABASE);
    identifier(role.name, ROLE);
    if (
      Object.keys(role).some(
        (key) =>
          ![
            "name",
            "valid_until",
            "connection_limit",
            "member_of",
            "membership_options",
            "bypass_rls",
          ].includes(key),
      ) ||
      (role.bypass_rls !== undefined && typeof role.bypass_rls !== "boolean")
    )
      throw new PgcfProviderError("input");
    if (
      role.name === "app" ||
      role.name.startsWith("pg_") ||
      ["postgres", "none", "public"].includes(role.name) ||
      (role.connection_limit !== undefined &&
        (!Number.isSafeInteger(role.connection_limit) ||
          role.connection_limit < 1 ||
          role.connection_limit > 10_000)) ||
      (role.valid_until !== undefined && !validTime(role.valid_until)) ||
      (role.member_of !== undefined &&
        (role.member_of.length > 8 ||
          new Set(role.member_of).size !== role.member_of.length ||
          role.member_of.some(
            (member) =>
              !ROLE.test(member) ||
              member === "app" ||
              member === role.name ||
              member.startsWith("pg_"),
          )))
    )
      throw new PgcfProviderError("input");
    if (
      role.membership_options !== undefined &&
      (!role.member_of?.length ||
        typeof role.membership_options.inherit !== "boolean" ||
        typeof role.membership_options.set !== "boolean" ||
        Object.keys(role.membership_options).sort().join(",") !== "inherit,set")
    )
      throw new PgcfProviderError("input");
    return parseRole(
      object(
        await this.request(
          `/v1/databases/${databaseId}/roles`,
          "POST",
          [201],
          role,
          idempotencyKey,
        ),
      ),
      databaseId,
    );
  }
  async deleteRole(
    databaseId: string,
    roleName: string,
    idempotencyKey: string,
  ): Promise<PgcfMutationReceipt> {
    return this.mutation(
      await this.request(
        `/v1/databases/${identifier(databaseId, DATABASE)}/roles/${identifier(roleName, ROLE)}`,
        "DELETE",
        [202],
        undefined,
        idempotencyKey,
      ),
      databaseId,
    );
  }
  async readRoles(databaseId: string): Promise<readonly PgcfRole[]> {
    const value = object(
      await this.request(`/v1/databases/${identifier(databaseId, DATABASE)}/roles`, "GET", [200]),
    );
    if (!Array.isArray(value["data"]) || value["next_cursor"] !== null)
      throw new PgcfProviderError("contract");
    return value["data"].map((role) => parseRole(role, databaseId));
  }
  /** The URI is consumed inside the trusted boundary; serializing the handle reveals nothing. */
  async readConnection(databaseId: string, roleName: string): Promise<PgcfConnectionHandle> {
    const value = object(
      await this.request(
        `/v1/databases/${identifier(databaseId, DATABASE)}/roles/${identifier(roleName, ROLE)}/connection-uri`,
        "GET",
        [200],
      ),
    );
    if (
      value["database_id"] !== databaseId ||
      value["database"] !== databaseId ||
      value["role"] !== roleName ||
      value["includes_password"] !== true ||
      typeof value["uri"] !== "string" ||
      typeof value["host"] !== "string" ||
      !HOST.test(value["host"])
    )
      throw new PgcfProviderError("contract");
    let uri: URL;
    try {
      uri = new URL(value["uri"]);
    } catch {
      throw new PgcfProviderError("contract");
    }
    if (
      !["postgres:", "postgresql:"].includes(uri.protocol) ||
      uri.hostname !== value["host"] ||
      (uri.port !== "" && uri.port !== "5432") ||
      decodeURIComponent(uri.username) !== roleName ||
      !uri.password ||
      uri.pathname !== `/${databaseId}` ||
      uri.hash ||
      [...uri.searchParams].some(
        ([key, val]) => key !== "sslmode" || !["require", "verify-full"].includes(val),
      )
    )
      throw new PgcfProviderError("contract");
    return new PgcfConnectionHandle(value["uri"], value["host"], databaseId, roleName);
  }
  async readUsage(input: {
    from: string;
    to: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{ rows: readonly PgcfUsageRow[]; nextCursor: string | null }> {
    const window = usageWindow(input.from, input.to, HOUR_MS);
    if (input.cursor !== undefined && input.cursor.length > 128)
      throw new PgcfProviderError("input");
    const query = new URLSearchParams({
      project_id: this.projectId,
      from: input.from,
      to: input.to,
      granularity: "hour",
      limit: "100",
    });
    if (input.cursor !== undefined) query.set("cursor", input.cursor);
    const value = object(
      await this.request(`/v1/usage?${query}`, "GET", [200], undefined, undefined, input.signal),
    );
    if (
      !Array.isArray(value["data"]) ||
      value["data"].length > 100 ||
      (value["next_cursor"] !== null && typeof value["next_cursor"] !== "string")
    )
      throw new PgcfProviderError("contract");
    return {
      rows: value["data"].map((row) => parseUsage(row, this.projectId, window)),
      nextCursor: value["next_cursor"] as string | null,
    };
  }
  /** Executions of one database (or of the project) per hour or day; the rows are never the usage of other tenants. */
  async readExecutionUsage(input: {
    scope: { readonly databaseId: string } | { readonly projectId: string };
    from: string;
    to: string;
    granularity: "hour" | "day";
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{ rows: readonly PgcfExecutionUsageRow[]; nextCursor: string | null }> {
    const unit = input.granularity === "hour" ? HOUR_MS : DAY_MS;
    const window = usageWindow(input.from, input.to, unit);
    const query = new URLSearchParams({
      from: input.from,
      to: input.to,
      granularity: input.granularity,
      limit: String(boundedLimit(input.limit, 100)),
    });
    let databaseId: string | undefined;
    if ("databaseId" in input.scope) {
      databaseId = identifier(input.scope.databaseId, DATABASE);
      query.set("database_id", databaseId);
    } else {
      if (input.scope.projectId !== this.projectId) throw new PgcfProviderError("input");
      query.set("project_id", this.projectId);
    }
    if (input.cursor !== undefined) {
      if (
        input.cursor.length < 1 ||
        input.cursor.length > 128 ||
        (databaseId !== undefined && !input.cursor.startsWith(`${databaseId}|`))
      )
        throw new PgcfProviderError("input");
      query.set("cursor", input.cursor);
    }
    const value = object(
      await this.request(
        `/v1/execution-usage?${query}`,
        "GET",
        [200],
        undefined,
        undefined,
        input.signal,
      ),
    );
    const data = listData(value, input.limit);
    const cursor = value["next_cursor"];
    if (cursor !== null && (typeof cursor !== "string" || cursor.length > 128))
      throw new PgcfProviderError("contract");
    return {
      rows: data.map((row) => parseExecutionUsage(row, this.projectId, databaseId, window, unit)),
      nextCursor: cursor,
    };
  }
  /**
   * Webhooks of the project; the signing secret is never listed. A webhook the strict parser rejects fails the
   * whole page, unless the caller asks to skip it: the page then lists the others and counts the rejected ones in
   * `skipped`, so a cleanup is not held up by a webhook it could not delete safely anyway.
   */
  async listWebhooks(input: {
    limit: number;
    cursor?: string;
    skipUnparseable?: boolean;
  }): Promise<PgcfPage<PgcfWebhook> & { readonly skipped?: number }> {
    const page = await this.request(`/v1/webhooks${listQuery(input.limit, input.cursor)}`, "GET", [
      200,
    ]);
    const parsed = listPage(page, input.limit);
    const items: PgcfWebhook[] = [];
    let skipped = 0;
    for (const item of parsed.data) {
      try {
        items.push(this.webhook(item));
      } catch (error) {
        if (input.skipUnparseable !== true || !(error instanceof PgcfProviderError)) throw error;
        skipped += 1;
      }
    }
    return { items, nextCursor: parsed.nextCursor, ...(skipped > 0 ? { skipped } : {}) };
  }
  /** Creates a webhook for the given databases; the answer is the only one that carries `secret`. */
  async createWebhook(
    input: PgcfWebhookInput,
    options: { readonly key: string },
  ): Promise<PgcfWebhookCreated> {
    if (
      input.eventTypes.length < 1 ||
      input.eventTypes.length > 16 ||
      input.eventTypes.some((type) => type.length > 64 || !EVENT_TYPE.test(type)) ||
      input.databaseIds.length < 1 ||
      input.databaseIds.length > 100 ||
      input.databaseIds.some((id) => !DATABASE.test(id)) ||
      (input.headers !== undefined && !validHeaders(input.headers)) ||
      // PGCF stores the normalized URL; refuse what it would store above its own limit.
      !isHttpsUrl(input.url, MAX_WEBHOOK_URL_LENGTH) ||
      new URL(input.url).toString().length > MAX_WEBHOOK_URL_LENGTH
    )
      throw new PgcfProviderError("input");
    return this.request(
      "/v1/webhooks",
      "POST",
      [201],
      {
        url: input.url,
        event_types: input.eventTypes,
        database_ids: input.databaseIds,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      },
      options.key,
      undefined,
      (raw) => {
        const created = object(raw);
        const secret = created["secret"];
        if (typeof secret !== "string" || !SECRET.test(secret))
          throw new PgcfProviderError("contract");
        return { ...this.webhook(created), secret };
      },
    );
  }
  async getWebhook(webhookId: string): Promise<PgcfWebhook> {
    const webhook = this.webhook(
      await this.request(`/v1/webhooks/${identifier(webhookId, WEBHOOK)}`, "GET", [200]),
    );
    if (webhook.id !== webhookId) throw new PgcfProviderError("contract");
    return webhook;
  }
  /** Deletes one webhook under the caller's Idempotency-Key: PGCF replays the same key and refuses another request. */
  async deleteWebhook(webhookId: string, options: { readonly key: string }): Promise<void> {
    await this.request(
      `/v1/webhooks/${identifier(webhookId, WEBHOOK)}`,
      "DELETE",
      [204],
      undefined,
      options.key,
    );
  }
  /** Sends one `webhook.test` event now under the caller's key; PGCF answers 429 within five seconds of the previous test. */
  async testWebhook(
    webhookId: string,
    options: { readonly key: string },
  ): Promise<PgcfWebhookTestResult> {
    return this.request(
      `/v1/webhooks/${identifier(webhookId, WEBHOOK)}/test`,
      "POST",
      [200],
      undefined,
      options.key,
      undefined,
      (raw) => {
        const value = object(raw);
        if (
          typeof value["delivered"] !== "boolean" ||
          (value["status"] !== null && !isStatusCode(value["status"])) ||
          !oneOf(TEST_ERRORS, value["error"], true) ||
          value["delivered"] !== (value["error"] === null) ||
          whole(value["duration_ms"], 0) < 0
        )
          throw new PgcfProviderError("contract");
        return {
          delivered: value["delivered"],
          status: value["status"] as number | null,
          error: value["error"] as (typeof TEST_ERRORS)[number] | null,
          durationMs: value["duration_ms"] as number,
        };
      },
    );
  }
  async listWebhookDeliveries(
    databaseId: string,
    input: { limit: number; cursor?: string },
  ): Promise<PgcfPage<PgcfWebhookDelivery>> {
    const page = await this.request(
      `/v1/databases/${identifier(databaseId, DATABASE)}/webhook-deliveries${listQuery(input.limit, input.cursor)}`,
      "GET",
      [200],
    );
    const parsed = listPage(page, input.limit);
    return {
      items: parsed.data.map((item) => parseDelivery(item)),
      nextCursor: parsed.nextCursor,
    };
  }
  async replayWebhookDelivery(
    databaseId: string,
    deliveryId: string,
    options: { readonly key: string },
  ): Promise<{ readonly deliveryId: string; readonly state: "pending" }> {
    return this.request(
      `/v1/databases/${identifier(databaseId, DATABASE)}/webhook-deliveries/${identifier(deliveryId, DELIVERY)}/replay`,
      "POST",
      [202],
      undefined,
      options.key,
      undefined,
      (raw) => {
        const value = object(raw);
        if (value["delivery_id"] !== deliveryId || value["state"] !== "pending")
          throw new PgcfProviderError("contract");
        return { deliveryId, state: "pending" as const };
      },
    );
  }
  /** Creates (201) or replaces (200) a schedule; the statements run as `role` on the database. */
  async putSchedule(
    databaseId: string,
    name: string,
    body: PgcfScheduleUpsert,
  ): Promise<PgcfSchedule> {
    return this.request(
      `/v1/databases/${identifier(databaseId, DATABASE)}/schedules/${identifier(name, SCHEDULE)}`,
      "PUT",
      [200, 201],
      scheduleBody(body),
      "omh-put-schedule",
      undefined,
      (raw) => parseSchedule(raw, name),
    );
  }
  async getSchedule(databaseId: string, name: string): Promise<PgcfSchedule> {
    return parseSchedule(
      await this.request(
        `/v1/databases/${identifier(databaseId, DATABASE)}/schedules/${identifier(name, SCHEDULE)}`,
        "GET",
        [200],
      ),
      name,
    );
  }
  /** PGCF keeps at most 20 schedules per database and has no cursor for them. */
  async listSchedules(databaseId: string): Promise<readonly PgcfSchedule[]> {
    const page = listPage(
      await this.request(`/v1/databases/${identifier(databaseId, DATABASE)}/schedules`, "GET", [
        200,
      ]),
      MAX_LIST_LIMIT,
    );
    if (page.nextCursor !== null) throw new PgcfProviderError("contract");
    return page.data.map((item) => parseSchedule(item, scheduleNameOf(item)));
  }
  async deleteSchedule(databaseId: string, name: string): Promise<void> {
    await this.request(
      `/v1/databases/${identifier(databaseId, DATABASE)}/schedules/${identifier(name, SCHEDULE)}`,
      "DELETE",
      [204],
      undefined,
      "omh-delete-schedule",
    );
  }
  /** The last 50 runs are kept; `limit` selects the newest. */
  async listScheduleRuns(
    databaseId: string,
    name: string,
    limit: number,
  ): Promise<readonly PgcfScheduleRun[]> {
    const page = listPage(
      await this.request(
        `/v1/databases/${identifier(databaseId, DATABASE)}/schedules/${identifier(name, SCHEDULE)}/runs?limit=${boundedLimit(limit, 50)}`,
        "GET",
        [200],
      ),
      limit,
    );
    if (page.nextCursor !== null) throw new PgcfProviderError("contract");
    return page.data.map((item) => parseRun(item, name));
  }
  async runScheduleNow(
    databaseId: string,
    name: string,
    options: { readonly key: string },
  ): Promise<PgcfScheduleRunAccepted> {
    return this.request(
      `/v1/databases/${identifier(databaseId, DATABASE)}/schedules/${identifier(name, SCHEDULE)}/run`,
      "POST",
      [202],
      undefined,
      options.key,
      undefined,
      (raw) => {
        const value = object(raw);
        if (value["schedule"] !== name || value["state"] !== "queued")
          throw new PgcfProviderError("contract");
        return { schedule: name, state: "queued" as const };
      },
    );
  }
  private webhook(raw: unknown): PgcfWebhook {
    const value = object(raw);
    const url = value["url"];
    const databaseIds = value["database_ids"];
    if (
      value["project_id"] !== this.projectId ||
      typeof url !== "string" ||
      !isHttpsUrl(url, MAX_STORED_WEBHOOK_URL_LENGTH) ||
      !Array.isArray(value["event_types"]) ||
      value["event_types"].length > 16 ||
      value["event_types"].some(
        (type) => typeof type !== "string" || type.length > 64 || !EVENT_TYPE.test(type),
      ) ||
      !(
        databaseIds === null ||
        (Array.isArray(databaseIds) &&
          databaseIds.length <= 100 &&
          databaseIds.every((id) => typeof id === "string" && DATABASE.test(id)))
      ) ||
      !Array.isArray(value["header_names"]) ||
      value["header_names"].some((name) => typeof name !== "string" || !HEADER_NAME.test(name))
    )
      throw new PgcfProviderError("contract");
    return {
      id: contractIdentifier(value["id"], WEBHOOK),
      projectId: this.projectId,
      url,
      eventTypes: value["event_types"] as string[],
      databaseIds: databaseIds as string[] | null,
      headerNames: value["header_names"] as string[],
      createdAt: timeOf(value["created_at"]),
    };
  }
  private database(raw: unknown, expectedId?: string): PgcfDatabase {
    const value = object(raw),
      resources = object(value["resources"]);
    const id = contractIdentifier(value["id"], DATABASE);
    if (
      value["project_id"] !== this.projectId ||
      (expectedId !== undefined && id !== expectedId) ||
      !["running", "suspended", "deleted"].includes(String(value["desired_state"])) ||
      !["pending", "provisioning", "hibernated", "ready", "error", "deleting", "deleted"].includes(
        String(value["observed_state"]),
      ) ||
      typeof value["name"] !== "string" ||
      (value["storage_residency"] !== undefined &&
        (typeof value["storage_residency"] !== "string" ||
          !["local", "archiving", "archived", "restoring"].includes(value["storage_residency"]))) ||
      (value["suspension_reason"] !== undefined &&
        value["suspension_reason"] !== null &&
        !["manual", "idle"].includes(String(value["suspension_reason"])))
    )
      throw new PgcfProviderError("contract");
    const storageMiB =
      "storage_mib" in resources
        ? whole(resources["storage_mib"], 500)
        : whole(resources["storage_gib"], 1) * 1024;
    if ("storage_mib" in resources === "storage_gib" in resources || storageMiB > 67108864)
      throw new PgcfProviderError("contract");
    return {
      id,
      projectId: this.projectId,
      regionId: contractIdentifier(value["region_id"], REGION),
      name: value["name"],
      sizeClassId: contractIdentifier(value["size_class_id"], SIZE),
      resources: {
        memoryMiB: whole(resources["memory_mib"], 256),
        cpuMillicores: whole(resources["cpu_millicores"], 100),
        storageMiB,
      },
      desiredState: value["desired_state"] as PgcfDatabase["desiredState"],
      ...(value["suspension_reason"] === undefined
        ? {}
        : {
            suspensionReason: value["suspension_reason"] as "manual" | "idle" | null,
          }),
      observedState: value["observed_state"] as PgcfDatabase["observedState"],
      generation: whole(value["generation"], 1),
      observedGeneration: whole(value["observed_generation"], 0),
      ...(value["storage_residency"] === undefined
        ? {}
        : {
            storageResidency: value["storage_residency"] as NonNullable<
              PgcfDatabase["storageResidency"]
            >,
          }),
      ...(value["storage_operation_id"] === undefined
        ? {}
        : {
            storageOperationId:
              value["storage_operation_id"] === null
                ? null
                : contractIdentifier(value["storage_operation_id"], OPERATION),
          }),
      sleepAfterSeconds:
        value["effective_sleep_after_seconds"] === null
          ? null
          : whole(value["effective_sleep_after_seconds"], 60),
    };
  }
  private operation(raw: unknown): PgcfOperation {
    const value = object(raw);
    if (
      value["project_id"] !== this.projectId ||
      !["pending", "running", "succeeded", "failed"].includes(String(value["status"])) ||
      typeof value["kind"] !== "string" ||
      !/^database\.(?:create|restore|delete|resize|suspend|resume|hibernate|wake|archive|rehydrate|role\.(?:create|delete))$/u.test(
        value["kind"],
      )
    )
      throw new PgcfProviderError("contract");
    return {
      id: contractIdentifier(value["id"], OPERATION),
      projectId: this.projectId,
      databaseId: contractIdentifier(value["database_id"], DATABASE),
      generation: whole(value["generation"], 1),
      kind: value["kind"],
      status: value["status"] as PgcfOperation["status"],
      errorCode:
        value["error"] === null
          ? null
          : contractIdentifier(object(value["error"])["code"], /^[a-z][a-z0-9_]{0,63}$/u),
    };
  }
  /**
   * A mutation answer after 202 is dispatched work: any contract error in it leaves the outcome
   * unknown, so the caller must not treat the request as refused.
   */
  private mutation(
    raw: unknown,
    expectedId?: string,
    resume?: { expectedGeneration: number | undefined },
  ): PgcfMutationReceipt {
    try {
      const value = object(raw),
        database = this.database(value["database"], expectedId),
        operation = this.operation(value["operation"]);
      if (
        operation.databaseId !== database.id ||
        (resume
          ? !isPgcfResumeReceipt({ database, operation }, resume.expectedGeneration)
          : operation.generation > database.generation ||
            ["database.archive", "database.rehydrate"].includes(operation.kind))
      )
        throw new PgcfProviderError("contract");
      return { database, operation };
    } catch (error) {
      if (error instanceof PgcfProviderError && error.code === "contract")
        throw new PgcfProviderError("contract", 202, true);
      throw error;
    }
  }
  /**
   * `parse` turns the 2xx JSON answer into the result. A contract error it throws is raised with the
   * response status, and a mutation's contract error is an uncertain outcome: the write was accepted.
   */
  private async request<T = unknown>(
    path: string,
    method: string,
    statuses: readonly number[],
    body?: unknown,
    key?: string,
    outerSignal?: AbortSignal,
    parse?: (value: unknown) => T,
  ): Promise<T> {
    const mutation = method !== "GET";
    if (mutation && (typeof key !== "string" || !/^[\x21-\x7e]{1,200}$/u.test(key)))
      throw new PgcfProviderError("input");
    const audit = (outcome: PgcfProviderAuditEvent["outcome"]) => {
      try {
        this.#audit?.({
          provider: "pgcf",
          transport: "management",
          host: new URL(this.#origin).hostname,
          databaseId: path.match(/^\/v1\/databases\/([a-z][a-z0-9]{19})(?:\/|$)/u)?.[1] ?? null,
          caller: this.#caller,
          outcome,
        });
      } catch {
        /* Observability cannot turn a committed request into a retryable error. */
      }
    };
    const controller = new AbortController();
    const signal = outerSignal
      ? AbortSignal.any([outerSignal, controller.signal])
      : controller.signal;
    let rejectAbort: ((reason: PgcfProviderError) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort?.(new PgcfProviderError("timeout", null, mutation));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PgcfProviderError("timeout", null, mutation));
      }, this.#timeout);
    });
    const exchange = async (): Promise<T> => {
      let response: Response;
      if (signal.aborted) throw new PgcfProviderError("timeout", null, mutation);
      audit("started");
      try {
        response = await Reflect.apply(this.#fetch, globalThis, [
          this.#origin + path,
          {
            method,
            redirect: "manual",
            signal,
            headers: {
              Authorization: `Bearer ${this.#key}`,
              Accept: "application/json",
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
              ...(key === undefined ? {} : { "Idempotency-Key": key }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        ]);
      } catch {
        throw new PgcfProviderError("transport", null, mutation);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new PgcfProviderError("redirect", response.status, mutation);
      }
      if (!statuses.includes(response.status)) {
        const reason = response.status === 409 ? await conflictReasonOf(response) : undefined;
        if (response.status !== 409) await response.body?.cancel();
        throw new PgcfProviderError(
          "rejected",
          response.status,
          mutation && response.status >= 500,
          reason,
        );
      }
      if (response.status === 204) {
        await response.body?.cancel();
        return undefined as T;
      }
      if (!response.body) throw new PgcfProviderError("contract", response.status, mutation);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new PgcfProviderError("oversize", response.status, mutation);
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new PgcfProviderError("contract", response.status, mutation);
      }
      if (parse === undefined) return value as T;
      try {
        return parse(value);
      } catch (error) {
        if (error instanceof PgcfProviderError && error.code === "contract")
          throw new PgcfProviderError("contract", response.status, mutation);
        throw error;
      }
    };
    try {
      const result = await Promise.race([exchange(), deadline, aborted]);
      audit("succeeded");
      return result;
    } catch (error) {
      audit(error instanceof PgcfProviderError && error.code === "redirect" ? "blocked" : "failed");
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
export class PgcfConnectionHandle {
  #uri: string;
  constructor(
    uri: string,
    readonly host: string,
    readonly databaseId: string,
    readonly role: string,
  ) {
    this.#uri = uri;
  }
  async consume<T>(consumer: (uri: string) => Promise<T>): Promise<T> {
    return consumer(this.#uri);
  }
  toJSON(): { redacted: true } {
    return { redacted: true };
  }
  toString(): string {
    return "[REDACTED PGCF CONNECTION]";
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PgcfProviderError("contract");
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new PgcfProviderError("input");
  return value;
}
function contractIdentifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new PgcfProviderError("contract");
  return value;
}
function whole(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new PgcfProviderError("contract");
  return value;
}
function validTime(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value)
  );
}
function timeOf(value: unknown): string {
  if (typeof value !== "string" || !validTime(value)) throw new PgcfProviderError("contract");
  return value;
}
function nullableTimeOf(value: unknown): string | null {
  return value === null ? null : timeOf(value);
}
function oneOf<T extends string>(values: readonly T[], value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "string" && values.includes(value as T));
}
function isStatusCode(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}
/** PGCF checks the raw input against 2048 characters but stores the normalized URL, which can be longer. */
function isHttpsUrl(value: string, maxLength: number): boolean {
  if (value.length > maxLength) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
function validHeaders(headers: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(headers);
  return (
    entries.length <= 8 &&
    new Set(entries.map(([name]) => name.toLowerCase())).size === entries.length &&
    entries.every(
      ([name, value]) =>
        HEADER_NAME.test(name) &&
        value.length >= 1 &&
        value.length <= 512 &&
        HEADER_VALUE.test(value),
    )
  );
}
function boundedLimit(limit: number, max: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
    throw new PgcfProviderError("input");
  return limit;
}
function listQuery(limit: number, cursor: string | undefined): string {
  boundedLimit(limit, MAX_LIST_LIMIT);
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) {
    if (cursor.length < 1 || cursor.length > 256) throw new PgcfProviderError("input");
    query.set("cursor", cursor);
  }
  return `?${query}`;
}
function listData(value: Record<string, unknown>, limit: number): readonly unknown[] {
  if (!Array.isArray(value["data"]) || value["data"].length > limit)
    throw new PgcfProviderError("contract");
  return value["data"];
}
/** A page of a PGCF list envelope; the cursor is opaque and bounded. */
function listPage(
  raw: unknown,
  limit: number,
): { readonly data: readonly unknown[]; readonly nextCursor: string | null } {
  const value = object(raw);
  const data = listData(value, limit);
  const cursor = value["next_cursor"];
  if (cursor !== null && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 256))
    throw new PgcfProviderError("contract");
  return { data, nextCursor: cursor };
}
function usageWindow(
  from: string,
  to: string,
  unit: number,
): { readonly start: number; readonly end: number } {
  const start = Date.parse(from),
    end = Date.parse(to);
  if (
    !validTime(from) ||
    !validTime(to) ||
    start % unit !== 0 ||
    end % unit !== 0 ||
    end <= start ||
    end - start > MAX_USAGE_SPAN_MS
  )
    throw new PgcfProviderError("input");
  return { start, end };
}
/** Start and end of a usage row must lie in the requested window and span exactly one unit. */
function usageTimes(
  value: Record<string, unknown>,
  window: { readonly start: number; readonly end: number },
  unit: number,
): { readonly start: string; readonly end: string } {
  const start = timeOf(value["start"]),
    end = timeOf(value["end"]);
  if (
    Date.parse(start) < window.start ||
    Date.parse(end) > window.end ||
    Date.parse(start) % unit !== 0 ||
    Date.parse(end) - Date.parse(start) !== unit
  )
    throw new PgcfProviderError("contract");
  return { start, end };
}
function parseRole(raw: unknown, databaseId: string): PgcfRole {
  const value = object(raw);
  if (
    value["database_id"] !== databaseId ||
    typeof value["owner"] !== "boolean" ||
    typeof value["bypass_rls"] !== "boolean" ||
    !Array.isArray(value["member_of"]) ||
    value["member_of"].some((name) => typeof name !== "string" || !ROLE.test(name)) ||
    (value["valid_until"] !== null &&
      (typeof value["valid_until"] !== "string" || !validTime(value["valid_until"])))
  )
    throw new PgcfProviderError("contract");
  const options =
    value["membership_options"] === undefined
      ? { inherit: true, set: true }
      : object(value["membership_options"]);
  if (
    typeof options["inherit"] !== "boolean" ||
    typeof options["set"] !== "boolean" ||
    Object.keys(options).sort().join(",") !== "inherit,set"
  )
    throw new PgcfProviderError("contract");
  return {
    databaseId,
    name: contractIdentifier(value["name"], ROLE),
    owner: value["owner"],
    passwordRevision: whole(value["password_revision"], 1),
    validUntil: value["valid_until"] as string | null,
    connectionLimit:
      value["connection_limit"] === null ? null : whole(value["connection_limit"], 1),
    memberOf: value["member_of"] as string[],
    bypassRls: value["bypass_rls"],
    membershipOptions: { inherit: options["inherit"], set: options["set"] },
  };
}
function parseUsage(
  raw: unknown,
  projectId: string,
  window: { readonly start: number; readonly end: number },
): PgcfUsageRow {
  const value = object(raw),
    metrics = object(value["metrics"]);
  if (
    value["project_id"] !== projectId ||
    !Array.isArray(value["gaps"]) ||
    value["gaps"].some((gap) => typeof gap !== "string" || !/^[a-z_]{1,64}$/u.test(gap)) ||
    typeof value["final"] !== "boolean" ||
    Object.values(metrics).some(
      (amount) =>
        amount !== null &&
        (typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          amount > Number.MAX_SAFE_INTEGER),
    )
  )
    throw new PgcfProviderError("contract");
  const times = usageTimes(value, window, HOUR_MS);
  return {
    databaseId: contractIdentifier(value["database_id"], DATABASE),
    projectId,
    start: times.start,
    end: times.end,
    final: value["final"],
    metrics: metrics as Record<string, number | null>,
    gaps: value["gaps"] as string[],
  };
}
function parseExecutionUsage(
  raw: unknown,
  projectId: string,
  databaseId: string | undefined,
  window: { readonly start: number; readonly end: number },
  unit: number,
): PgcfExecutionUsageRow {
  const value = object(raw),
    metrics = object(value["metrics"]);
  const rowDatabase = contractIdentifier(value["database_id"], DATABASE);
  if (
    value["project_id"] !== projectId ||
    (databaseId !== undefined && rowDatabase !== databaseId) ||
    typeof value["final"] !== "boolean" ||
    Object.keys(metrics).sort().join(",") !== [...EXECUTION_METRICS].sort().join(",")
  )
    throw new PgcfProviderError("contract");
  const times = usageTimes(value, window, unit);
  const counts = Object.fromEntries(
    EXECUTION_METRICS.map((name) => [name, whole(metrics[name], 0)]),
  ) as Record<PgcfExecutionMetric, number>;
  return {
    databaseId: rowDatabase,
    projectId,
    start: times.start,
    end: times.end,
    final: value["final"],
    metrics: counts,
  };
}
function parseDelivery(raw: unknown): PgcfWebhookDelivery {
  const value = object(raw);
  if (
    (!oneOf(WEBHOOK_EVENT_TYPES, value["event_type"]) &&
      !(typeof value["event_type"] === "string" && DATA_EVENT_TYPE.test(value["event_type"]))) ||
    !oneOf(DELIVERY_STATES, value["state"]) ||
    !oneOf(DELIVERY_ERRORS, value["last_error"], true) ||
    (value["last_status"] !== null && !isStatusCode(value["last_status"]))
  )
    throw new PgcfProviderError("contract");
  return {
    id: contractIdentifier(value["id"], DELIVERY),
    eventId: contractIdentifier(value["event_id"], EVENT),
    eventType: value["event_type"] as PgcfWebhookDelivery["eventType"],
    webhookId: contractIdentifier(value["webhook_id"], WEBHOOK),
    state: value["state"] as (typeof DELIVERY_STATES)[number],
    attempts: whole(value["attempts"], 0),
    createdAt: timeOf(value["created_at"]),
    nextAttemptAt: nullableTimeOf(value["next_attempt_at"]),
    deliveredAt: nullableTimeOf(value["delivered_at"]),
    lastStatus: value["last_status"] as number | null,
    lastError: value["last_error"] as (typeof DELIVERY_ERRORS)[number] | null,
  };
}
function scheduleBody(body: PgcfScheduleUpsert): Record<string, unknown> {
  const bytes = new TextEncoder();
  if (
    (body.cron !== undefined) === (body.everySeconds !== undefined) ||
    (body.cron !== undefined && (body.cron.length < 9 || body.cron.length > 120)) ||
    (body.everySeconds !== undefined &&
      (!Number.isSafeInteger(body.everySeconds) ||
        body.everySeconds < 60 ||
        body.everySeconds > 2_678_400)) ||
    !Array.isArray(body.statements) ||
    body.statements.length < 1 ||
    body.statements.length > 20 ||
    body.statements.some(
      (statement) => statement.trim().length === 0 || bytes.encode(statement).length > 16 * 1024,
    ) ||
    bytes.encode(body.statements.join("")).length > 64 * 1024 ||
    !ROLE.test(body.role) ||
    (body.timeoutMs !== undefined &&
      (!Number.isSafeInteger(body.timeoutMs) ||
        body.timeoutMs < 1_000 ||
        body.timeoutMs > 900_000)) ||
    (body.enabled !== undefined && typeof body.enabled !== "boolean")
  )
    throw new PgcfProviderError("input");
  return {
    ...(body.cron === undefined ? {} : { cron: body.cron }),
    ...(body.everySeconds === undefined ? {} : { every_seconds: body.everySeconds }),
    statements: body.statements,
    role: body.role,
    ...(body.timeoutMs === undefined ? {} : { timeout_ms: body.timeoutMs }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
  };
}
function scheduleNameOf(raw: unknown): string {
  return contractIdentifier(object(raw)["name"], SCHEDULE);
}
function parseSchedule(raw: unknown, name: string): PgcfSchedule {
  const value = object(raw);
  const cron = value["cron"],
    everySeconds = value["every_seconds"],
    statements = value["statements"];
  if (
    value["name"] !== name ||
    (cron !== null && (typeof cron !== "string" || cron.length < 9 || cron.length > 120)) ||
    (cron === null) === (everySeconds === null) ||
    (everySeconds !== null && whole(everySeconds, 60) > 2_678_400) ||
    !Array.isArray(statements) ||
    statements.length > 20 ||
    statements.some((statement) => typeof statement !== "string") ||
    typeof value["enabled"] !== "boolean"
  )
    throw new PgcfProviderError("contract");
  return {
    name,
    cron: cron as string | null,
    everySeconds: everySeconds as number | null,
    statements: statements as string[],
    role: contractIdentifier(value["role"], ROLE),
    timeoutMs: whole(value["timeout_ms"], 1),
    enabled: value["enabled"],
    nextRunAt: nullableTimeOf(value["next_run_at"]),
    createdAt: timeOf(value["created_at"]),
  };
}
function parseRun(raw: unknown, name: string): PgcfScheduleRun {
  const value = object(raw);
  if (
    value["schedule"] !== name ||
    !oneOf(SCHEDULE_OUTCOMES, value["outcome"]) ||
    typeof value["manual"] !== "boolean" ||
    (value["sqlstate"] !== null && typeof value["sqlstate"] !== "string")
  )
    throw new PgcfProviderError("contract");
  return {
    id: whole(value["id"], 0),
    schedule: name,
    scheduledAt: timeOf(value["scheduled_at"]),
    startedAt: nullableTimeOf(value["started_at"]),
    finishedAt: timeOf(value["finished_at"]),
    outcome: value["outcome"] as (typeof SCHEDULE_OUTCOMES)[number],
    sqlstate: value["sqlstate"] as string | null,
    attempts: whole(value["attempts"], 0),
    manual: value["manual"],
  };
}

/** Only a bounded, whitelisted reason escapes a 409; never provider error text or identifiers. */
async function conflictReasonOf(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 4096) {
        try {
          await reader.cancel();
        } catch {
          // The oversized body is already refused; a failing cancel changes nothing.
        }
        return undefined;
      }
      text += decoder.decode(item.value, { stream: true });
    }
    text += decoder.decode();
    const error = field(JSON.parse(text), "error");
    const code = field(error, "code");
    if (code === "idempotency_conflict" || code === "idempotency_in_progress") return code;
    const reason = field(field(error, "details"), "reason");
    return code === "conflict" && typeof reason === "string" && CONFLICT_REASON.test(reason)
      ? reason
      : undefined;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
