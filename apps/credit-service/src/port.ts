/*
 * Every seam of the credit service as a type. The Core is reached only through `CreditRuntimePort` (the
 * W33 contract, mirrored exactly) plus `CreditRuntimeAdditions`; the usage collectors only through
 * `PgcfUsagePort` and `R2UsagePort`; the two R2 buckets through the narrow bucket ports. Tests implement these
 * ports in memory, production binds the real service bindings and R2 buckets.
 */

/** Micro-credits; 1 credit is 1_000_000. */
export type Micros = number;

export type UsageSource = "wfp" | "pgcf" | "r2" | "resources";

export interface UsageLine {
  projectId: string;
  environmentId: string | null;
  resourceKind?: "native_auth_database";
  meter: string;
  quantity: string;
  unit: string;
  rateCardId: string;
  chargeMicros: Micros;
}

export interface LogRow {
  seq: number;
  key: string;
  at: string;
  organizationId: string;
  kind: string;
  deltaMicros: Micros;
  balanceMicros: Micros;
  detail: unknown;
}

export interface ResolvedScript {
  scriptName: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
}

/**
 * The usage of an organization in a window: the whole of it, or one part of it when the window is split. A whole
 * window sends neither `part` nor `split`, exactly as before parts existed; a part sends `split: true` and its number
 * (0 to 255). A window is booked in one layout only: the Core refuses a posting of the other layout than the one
 * already booked and names the booked one in its answer.
 */
export interface UsagePosting {
  organizationId: string;
  source: UsageSource;
  window: string;
  part?: number;
  split?: true;
  lines: UsageLine[];
}

/** The Core entrypoint `CreditRuntime` of the W33 contract. Timestamps are `Date.toISOString()` strings. */
export interface CreditRuntimePort {
  /**
   * Posts one posting of a window once. The log row is filed under the START of the window (`at` = `window`), the time
   * the usage happened; its `seq` is the order of posting, so `seq` order is not `at` order (a late window of yesterday
   * gets a higher `seq` than a window of today that was posted earlier). The Core refuses more than 2000 lines.
   */
  postUsage(
    i: UsagePosting,
  ): Promise<{ posted: boolean; balanceMicros: Micros; layout?: "whole" | "split" }>;
  /**
   * Keeps a posting that could not be booked, with its lines, and returns how many attempts it has failed and whether
   * it is dead (at `limit` attempts, at once when the Core finds the lines unbookable or `immediate`, and when the
   * organization has a dead posting for the source). A dead posting no longer holds the cursor; the replay books it.
   * A posting that is booked already (`settled: "booked"`) or belongs to a layout the window is not booked in
   * (`settled: "superseded"`) is not kept.
   */
  recordUsageFailure(
    i: UsagePosting & { reason: string; limit: number; immediate: boolean },
  ): Promise<{ attempts: number; dead: boolean; settled?: "booked" | "superseded" }>;
  /**
   * Books the kept postings that reached `minAttempts`, filed at the Core's clock: at most `limit` (more while many are
   * due), failing ones waiting longer each time; `remaining` is how many kept postings are still at or beyond that limit.
   */
  replayUsageFailures(i: {
    minAttempts: number;
    limit: number;
  }): Promise<{ replayed: number; remaining: number }>;
  readCursor(source: string): Promise<string | null>;
  advanceCursor(i: { source: string; through: string }): Promise<void>;
  resolveScripts(i: { scriptNames: string[] }): Promise<ResolvedScript[]>;
  readRates(i: { at: string }): Promise<{ rateCardId: string; rates: unknown }[]>;
  readLogPage(i: {
    beforeAt: string;
    afterSeq: number;
    limit: number;
  }): Promise<{ rows: LogRow[]; lastSeq: number }>;
  /**
   * Deletes the rows with `seq <= seq` AND `at < beforeAt`, the two bounds the rotation read them by. Both are needed:
   * a window of today that was posted before a late window of yesterday has the lower `seq` and must stay.
   */
  deleteLogThrough(i: { seq: number; beforeAt: string }): Promise<{ deleted: number }>;
  cursorsThrough(): Promise<{ source: string; through: string }[]>;
  /**
   * EVERY row of the organization that is still in the Core, oldest posting first: today's rows and any older row
   * that has not been rotated yet, whatever its `at`. Despite the name there is no day filter; the usage report merges
   * these rows by key with the rotated shards and must never miss a row that is in neither place.
   */
  readLogsToday(i: { organizationId: string }): Promise<LogRow[]>;
}

/*
 * ADDITIONAL CORE METHODS NEEDED (exact semantics in apps/credit-service/CORE-ADDENDUM.md). The contract's
 * CreditRuntime cannot attribute PGCF databases, R2 buckets or resources to an organization, project and
 * environment; these three reads are the whole gap.
 */
export interface CreditRuntimeAdditions {
  readPendingNativeDatabaseCreates(i: {
    from: string;
    to: string;
  }): Promise<{ holdFrom: string | null }>;
  resolvePgcfDatabases(i: { databaseIds: string[]; at: string }): Promise<
    (
      | { databaseId: string; organizationId: string; projectId: string; environmentId: string }
      | {
          databaseId: string;
          organizationId: string;
          projectId: string;
          resourceKind: "native_auth_database";
        }
    )[]
  >;
  listR2Buckets(i: { day: string; after: string | null; limit: number }): Promise<{
    buckets: {
      bucketName: string;
      jurisdiction: "eu" | "us";
      organizationId: string;
      projectId: string;
      environmentId: string;
    }[];
    next: string | null;
  }>;
  /** At most fifty projects whose `stop` budget is reached in the current month, in no particular order. */
  listStopBudgetProjects(): Promise<StopBudgetProject[]>;
  /** At most fifty projects of organizations past their credit grace with nothing left, in no particular order. */
  listCreditDeniedProjects(): Promise<StopBudgetProject[]>;
  readResources(i: { day: string; after: string | null; limit: number }): Promise<{
    rows: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      scripts: number;
      hostnames: number;
    }[];
    next: string | null;
  }>;
}

/** A project whose `stop` budget is reached in the current month: its schedules are disabled by the budget sweep. */
export interface StopBudgetProject {
  readonly organizationId: string;
  readonly projectId: string;
}

export type CreditCore = CreditRuntimePort & CreditRuntimeAdditions;

/**
 * `NeonUsageService` (apps/neon-management), bound as `NEON_USAGE`: final hourly PGCF memory rollups, and the
 * budget sweep that disables the enabled schedules of one project's PGCF databases (idempotent, returns the count).
 */
export interface PgcfHourlyRollup {
  readonly databaseId: string;
  readonly hourStart: string;
  readonly memoryMibMilliseconds: string;
}
/** A row the provider has not finalized yet. */
export interface PgcfPendingRow {
  readonly databaseId: string;
  readonly hourStart: string;
}
export interface PgcfUsageRollups {
  readonly from: string;
  readonly to: string;
  readonly rollups: readonly PgcfHourlyRollup[];
  readonly pending: readonly PgcfPendingRow[];
  readonly unbillableHours: number;
}
export interface PgcfUsagePort {
  collectUsage(i: { from: string; to: string }): Promise<PgcfUsageRollups>;
  stopSchedules(i: StopBudgetProject): Promise<{ stopped: number }>;
}

/** `R2ManagementService.collectUsage` (apps/r2-management): final daily usage of the named buckets. */
export interface R2BucketScope {
  readonly bucketName: string;
  readonly jurisdiction: "eu" | "us";
}
export interface R2BucketDailyUsage extends R2BucketScope {
  readonly storagePeakBytes: string;
  readonly classA: string;
  readonly classB: string;
  readonly inexactHours: number;
}
export interface R2DailyUsage {
  readonly day: string;
  readonly buckets: readonly R2BucketDailyUsage[];
}
export interface R2UsagePort {
  collectUsage(i: { day: string; buckets: R2BucketScope[] }): Promise<R2DailyUsage>;
}

/** The part of the Logpush bucket `USAGE_LOGS` this service reads. */
export interface UsageLogsBucket {
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: readonly { key: string; size: number; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array<ArrayBuffer>> } | null>;
}

/** The part of the rotation bucket `CREDIT_LOG` this service uses. `put` resolves to null when `onlyIf` refused. */
export interface CreditLogBucket {
  put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch: "*" }; httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface CreditServiceEnvironment {
  readonly CREDIT_ENVIRONMENT: "local" | "development" | "production";
  readonly WFP_USAGE_NAMESPACE: string;
  readonly USAGE_LOGS: UsageLogsBucket;
  readonly CREDIT_LOG: CreditLogBucket;
  readonly CREDIT_RUNTIME: CreditCore;
  readonly NEON_USAGE: PgcfUsagePort;
  readonly R2_USAGE: R2UsagePort;
}

/** Everything the passes need; `now` and `log` are injected so tests control the clock and read the events. */
export interface Dependencies {
  readonly core: CreditCore;
  readonly usageLogs: UsageLogsBucket;
  readonly creditLog: CreditLogBucket;
  readonly neon: PgcfUsagePort;
  readonly r2: R2UsagePort;
  readonly namespace: string;
  readonly now: () => number;
  readonly log: (event: Readonly<Record<string, unknown>>) => void;
}
