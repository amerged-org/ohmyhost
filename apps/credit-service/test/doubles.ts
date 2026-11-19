import { gzipSync } from "node:zlib";
import { usageRateCard } from "@ohmyhost/platform/shared";
import type {
  CreditCore,
  CreditLogBucket,
  Dependencies,
  LogRow,
  PgcfUsagePort,
  PgcfUsageRollups,
  R2DailyUsage,
  R2UsagePort,
  ResolvedScript,
  StopBudgetProject,
  UsageLogsBucket,
  UsagePosting,
} from "../src/port.js";

/** `2026-10-30T09:20:00.000Z`: twenty minutes into an hour that follows eight complete ones of the day. */
export const NOW = Date.UTC(2026, 9, 30, 9, 20, 0);

/** A bucket with R2 semantics for what the service uses: listing by prefix, create-only puts, etags. */
export class MemoryBucket implements UsageLogsBucket, CreditLogBucket {
  public readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date; etag: string }>();
  public readonly puts: string[] = [];
  public failPut: ((key: string) => boolean) | undefined;
  public tamper: ((key: string, bytes: Uint8Array) => Uint8Array) | undefined;
  #etags = 0;

  public seed(key: string, bytes: Uint8Array | string, uploaded = new Date(NOW)): void {
    this.objects.set(key, {
      bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      uploaded,
      etag: `"${String(++this.#etags)}"`,
    });
  }

  public async list(options: { prefix: string; cursor?: string; limit: number }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = keys.slice(start, start + options.limit);
    const truncated = start + options.limit < keys.length;
    return {
      objects: page.map((key) => {
        const object = this.objects.get(key) as { bytes: Uint8Array; uploaded: Date };
        return { key, size: object.bytes.byteLength, uploaded: object.uploaded };
      }),
      truncated,
      ...(truncated ? { cursor: String(start + options.limit) } : {}),
    };
  }

  public async get(key: string) {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    const bytes = this.tamper === undefined ? object.bytes : this.tamper(key, object.bytes);
    return {
      size: bytes.byteLength,
      body: new Blob([bytes as BlobPart]).stream(),
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    };
  }

  public async put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch: "*" }; httpMetadata: { contentType: string } },
  ) {
    this.puts.push(key);
    if (this.failPut?.(key) === true) throw new Error("put failed");
    if (options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    this.seed(key, value);
    return { key };
  }
}

/** The stored shape of a published rate card row, as the Core's `readRates` returns it. */
export function storedRates(card: ReturnType<typeof usageRateCard>) {
  return card.rates.map((rate) => ({
    meter: rate.meter,
    unit: rate.unit,
    units_per_charge: rate.unitsPerCharge.toString(),
    provider_cost_micros: rate.providerCostPerCharge?.toString() ?? null,
    credit_micros: rate.creditsPerCharge.toString(),
  }));
}

const published = "2026-09-07T00:00:00.000Z";
/** Real WFP prices (`usage-2026-09-07-v1`), plus simple card rows of r2, pgcf and resources for the daily sources. */
export const RATE_CARDS = [
  { rateCardId: "usage-2026-09-07-v1", rates: storedRates(usageRateCard(published, published)) },
  {
    rateCardId: "pgcf-memory-2026-10-26-v1",
    rates: [
      {
        meter: "pgcf.memory.active",
        unit: "memory_mib_milliseconds",
        units_per_charge: "2304",
        provider_cost_micros: null,
        credit_micros: "25",
      },
    ],
  },
  {
    rateCardId: "r2-test-v1",
    rates: [
      ["r2.storage.standard", "byte_peak_day", "1000000000"],
      ["r2.class_a", "request", "1000"],
      ["r2.class_b", "request", "10000"],
    ].map(([meter, unit, units]) => ({
      meter,
      unit,
      units_per_charge: units,
      provider_cost_micros: null,
      credit_micros: "100",
    })),
  },
  {
    rateCardId: "resources-test-v1",
    rates: [
      ["wfp.script", "script_second"],
      ["domain.custom_hostname", "hostname_second"],
    ].map(([meter, unit]) => ({
      meter,
      unit,
      units_per_charge: "86400",
      provider_cost_micros: null,
      credit_micros: meter === "wfp.script" ? "1000" : "5000",
    })),
  },
];

export const OWNER = (name: string): ResolvedScript => ({
  scriptName: name,
  organizationId: "org_1",
  projectId: "prj_1",
  environmentId: "env_prod",
});

/** The Core's `CreditRuntime` plus the three additional reads, in memory, with the idempotency of the real keys. */
export class MemoryCore implements CreditCore {
  public readonly cursors = new Map<string, string>();
  public readonly rows: LogRow[] = [];
  public readonly calls: string[] = [];
  public scripts = new Map<string, ResolvedScript>();
  public rates: { rateCardId: string; rates: unknown }[] = RATE_CARDS;
  public pgcfOwners = new Map<
    string,
    | { databaseId: string; organizationId: string; projectId: string; environmentId: string }
    | {
        databaseId: string;
        organizationId: string;
        projectId: string;
        resourceKind: "native_auth_database";
      }
  >();
  /** A database that stops serving: it resolves only for hours that start before this instant. */
  public pgcfServingUntil = new Map<string, string>();
  public nativeCreateHold: string | null = null;
  public buckets: {
    bucketName: string;
    jurisdiction: "eu" | "us";
    organizationId: string;
    projectId: string;
    environmentId: string;
  }[] = [];
  public resources: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    scripts: number;
    hostnames: number;
  }[] = [];
  public stopBudgetProjects: StopBudgetProject[] = [];
  public failOn: ((method: string, input: unknown) => boolean) | undefined;
  public pageCap = Number.MAX_SAFE_INTEGER;
  #seq = 0;

  public constructor(private readonly now: () => number) {}

  #enter(method: string, input?: unknown): void {
    this.calls.push(method);
    if (this.failOn?.(method, input) === true) throw this.errorFor(method);
  }

  public addRow(organizationId: string, at: string, kind = "grant", key?: string): LogRow {
    const row: LogRow = {
      seq: ++this.#seq,
      key: key ?? `${kind}:${String(this.#seq)}`,
      at,
      organizationId,
      kind,
      deltaMicros: 5,
      balanceMicros: 100,
      detail: { n: this.#seq },
    };
    this.rows.push(row);
    return row;
  }

  /** Every posting the Core received, with its line count and the fields it sent, in call order. */
  public readonly postings: {
    key: string;
    organizationId: string;
    part: number;
    lines: number;
    sent: string[];
  }[] = [];
  /** The failures the Core keeps for postings that did not go through, by credit_log key. */
  public readonly failures = new Map<
    string,
    { posting: UsagePosting; attempts: number; reason: string }
  >();
  /** What a failing call throws; the Core's validation errors are a `TypeError`. */
  public errorFor: (method: string) => Error = (method) => new Error(`${method} failed`);

  #base(i: UsagePosting): string {
    return `usage:${i.source}:${i.organizationId}:${i.window}`;
  }

  #key(i: UsagePosting): string {
    const part = i.part ?? 0;
    return `${this.#base(i)}${part > 0 ? `:p${String(part)}` : ""}`;
  }

  /**
   * The Core's `postUsage`: a posting of more than 2000 lines is refused by its input contract, and a window is
   * booked in one layout only: a posting of the other layout books nothing and names the booked one.
   */
  public async postUsage(i: UsagePosting & { replay?: boolean }) {
    this.#enter("postUsage", i);
    if (i.lines.length > 2000) throw new Error("postUsage refused: more than 2000 lines");
    const key = this.#key(i);
    this.postings.push({
      key,
      organizationId: i.organizationId,
      part: i.part ?? 0,
      lines: i.lines.length,
      sent: Object.keys(i).sort(),
    });
    const base = this.#base(i);
    const booked = this.rows.find((row) => row.key === base || row.key.startsWith(`${base}:`));
    const layout = i.split === true ? "split" : "whole";
    if (booked !== undefined) {
      const bookedLayout =
        (booked.detail as { split?: boolean }).split === true ? "split" : "whole";
      if (bookedLayout !== layout) {
        this.failures.delete(key);
        return { posted: false, balanceMicros: 0, layout: bookedLayout } as const;
      }
    }
    this.failures.delete(key);
    if (this.rows.some((row) => row.key === key)) return { posted: false, balanceMicros: 0 };
    const charge = i.lines.reduce((sum, line) => sum + line.chargeMicros, 0);
    // filed under the window start, like the Core: the rows' seq order is the order of posting, not of `at`;
    // a replay is filed at the Core's clock, because the day of its window may be rotated already
    const row = this.addRow(
      i.organizationId,
      i.replay === true ? new Date(this.now()).toISOString() : i.window,
      "usage",
      key,
    );
    row.deltaMicros = -charge;
    row.detail = {
      source: i.source,
      window: i.window,
      ...(i.split === true ? { split: true, part: i.part ?? 0 } : {}),
      lines: i.lines,
    };
    return { posted: true, balanceMicros: 1_000_000 - charge };
  }

  public async recordUsageFailure(
    i: UsagePosting & { reason: string; limit: number; immediate: boolean },
  ) {
    this.#enter("recordUsageFailure", i);
    const key = this.#key(i);
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    const organizationDead = [...this.failures].some(
      ([other, failure]) =>
        other !== key &&
        failure.posting.organizationId === i.organizationId &&
        failure.posting.source === i.source &&
        failure.attempts >= i.limit,
    );
    const dead = i.immediate || organizationDead || attempts >= i.limit;
    const stored = dead ? Math.max(attempts, i.limit) : attempts;
    this.failures.set(key, { posting: i, attempts: stored, reason: i.reason });
    return { attempts: stored, dead };
  }

  public async replayUsageFailures(i: { minAttempts: number; limit: number }) {
    this.#enter("replayUsageFailures", i);
    const due = [...this.failures].filter(([, failure]) => failure.attempts >= i.minAttempts);
    let replayed = 0;
    for (const [key, failure] of due.slice(0, i.limit)) {
      try {
        await this.postUsage({ ...failure.posting, replay: true });
        replayed++;
      } catch (error) {
        failure.attempts++;
        failure.reason = error instanceof Error ? error.message : "unknown";
        this.failures.set(key, failure);
      }
    }
    return {
      replayed,
      remaining: [...this.failures.values()].filter((failure) => failure.attempts >= i.minAttempts)
        .length,
    };
  }

  public async readCursor(source: string) {
    this.#enter("readCursor", source);
    return this.cursors.get(source) ?? null;
  }

  public async advanceCursor(i: { source: string; through: string }) {
    this.#enter("advanceCursor", i);
    const current = this.cursors.get(i.source);
    if (current === undefined || current < i.through) this.cursors.set(i.source, i.through);
  }

  public async resolveScripts(i: { scriptNames: string[] }) {
    this.#enter("resolveScripts", i);
    return i.scriptNames.flatMap((name) => this.scripts.get(name) ?? []);
  }

  public async readRates(i: { at: string }) {
    this.#enter("readRates", i);
    return this.rates;
  }

  public async readLogPage(i: { beforeAt: string; afterSeq: number; limit: number }) {
    this.#enter("readLogPage", i);
    const rows = this.rows
      .filter((row) => row.at < i.beforeAt && row.seq > i.afterSeq)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, Math.min(i.limit, this.pageCap));
    return { rows, lastSeq: rows.at(-1)?.seq ?? i.afterSeq };
  }

  public async deleteLogThrough(i: { seq: number; beforeAt: string }) {
    this.#enter("deleteLogThrough", i);
    const keep = this.rows.filter((row) => row.seq > i.seq || row.at >= i.beforeAt);
    const deleted = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return { deleted };
  }

  public async cursorsThrough() {
    this.#enter("cursorsThrough");
    return [...this.cursors].map(([source, through]) => ({ source, through }));
  }

  public async readLogsToday(i: { organizationId: string }) {
    this.#enter("readLogsToday", i);
    return this.rows.filter((row) => row.organizationId === i.organizationId);
  }

  public async resolvePgcfDatabases(i: { databaseIds: string[]; at: string }) {
    this.#enter("resolvePgcfDatabases", i);
    return i.databaseIds.flatMap((id) =>
      i.at < (this.pgcfServingUntil.get(id) ?? "9999") ? (this.pgcfOwners.get(id) ?? []) : [],
    );
  }
  public async readPendingNativeDatabaseCreates(i: { from: string; to: string }) {
    this.#enter("readPendingNativeDatabaseCreates", i);
    return {
      holdFrom:
        this.nativeCreateHold === null || this.nativeCreateHold >= i.to
          ? null
          : this.nativeCreateHold < i.from
            ? i.from
            : this.nativeCreateHold,
    };
  }

  public async listR2Buckets(i: { day: string; after: string | null; limit: number }) {
    this.#enter("listR2Buckets", i);
    const start = i.after === null ? 0 : Number(i.after);
    const page = this.buckets.slice(start, start + i.limit);
    return {
      buckets: page,
      next: start + i.limit < this.buckets.length ? String(start + i.limit) : null,
    };
  }

  public async readResources(i: { day: string; after: string | null; limit: number }) {
    this.#enter("readResources", i);
    const start = i.after === null ? 0 : Number(i.after);
    const page = this.resources.slice(start, start + i.limit);
    return {
      rows: page,
      next: start + i.limit < this.resources.length ? String(start + i.limit) : null,
    };
  }

  public async listStopBudgetProjects() {
    this.#enter("listStopBudgetProjects");
    return this.stopBudgetProjects.map((project) => ({ ...project }));
  }

  public creditDeniedProjects: StopBudgetProject[] = [];

  public async listCreditDeniedProjects() {
    this.#enter("listCreditDeniedProjects");
    return this.creditDeniedProjects.map((project) => ({ ...project }));
  }
}

export class FakeNeon implements PgcfUsagePort {
  public readonly requests: { from: string; to: string }[] = [];
  public readonly stopRequests: StopBudgetProject[] = [];
  public answer: (i: { from: string; to: string }) => unknown = (i) => ({
    from: i.from,
    to: i.to,
    rollups: [],
    pending: [],
    unbillableHours: 0,
  });
  public stopAnswer: (i: StopBudgetProject) => unknown = () => ({ stopped: 0 });
  public async collectUsage(i: { from: string; to: string }) {
    this.requests.push(i);
    return this.answer(i) as PgcfUsageRollups;
  }
  public async stopSchedules(i: StopBudgetProject) {
    this.stopRequests.push({ ...i });
    return this.stopAnswer(i) as { stopped: number };
  }
}

export class FakeR2 implements R2UsagePort {
  public readonly requests: {
    day: string;
    buckets: { bucketName: string; jurisdiction: string }[];
  }[] = [];
  public answer: (i: {
    day: string;
    buckets: { bucketName: string; jurisdiction: "eu" | "us" }[];
  }) => unknown = (i) => ({
    day: i.day,
    buckets: i.buckets.map((bucket) => ({
      ...bucket,
      storagePeakBytes: "0",
      classA: "0",
      classB: "0",
      inexactHours: 0,
    })),
  });
  public async collectUsage(i: {
    day: string;
    buckets: { bucketName: string; jurisdiction: "eu" | "us" }[];
  }) {
    this.requests.push(i);
    return this.answer(i) as R2DailyUsage;
  }
}

export interface World {
  readonly core: MemoryCore;
  readonly usageLogs: MemoryBucket;
  readonly creditLog: MemoryBucket;
  readonly neon: FakeNeon;
  readonly r2: FakeR2;
  readonly events: Record<string, unknown>[];
  readonly clock: { now: number };
  readonly deps: Dependencies;
}

export function world(now = NOW): World {
  const clock = { now };
  const core = new MemoryCore(() => clock.now);
  const usageLogs = new MemoryBucket();
  const creditLog = new MemoryBucket();
  const neon = new FakeNeon();
  const r2 = new FakeR2();
  const events: Record<string, unknown>[] = [];
  return {
    core,
    usageLogs,
    creditLog,
    neon,
    r2,
    events,
    clock,
    deps: {
      core,
      usageLogs,
      creditLog,
      neon,
      r2,
      namespace: "ohmyho-test",
      now: () => clock.now,
      log: (event) => events.push({ ...event }),
    },
  };
}

export const SCRIPT_A = `p-${"a".repeat(26)}-prod-${"1".repeat(26)}`;
export const SCRIPT_B = `p-${"b".repeat(26)}-dev-${"2".repeat(26)}`;
export const SCRIPT_C = `p-${"c".repeat(26)}-prod-${"3".repeat(26)}`;

export interface TestEvent {
  script?: string;
  type?: string;
  outcome?: string;
  cpu?: number;
  namespace?: string;
}
export function logLine(event: TestEvent = {}): string {
  return JSON.stringify({
    CPUTimeMs: event.cpu ?? 3,
    DispatchNamespace: event.namespace ?? "ohmyho-test",
    Entrypoint: null,
    EventTimestampMs: NOW - 3_600_000,
    EventType: event.type ?? "fetch",
    Outcome: event.outcome ?? "ok",
    ScriptName: event.script ?? SCRIPT_A,
    ScriptVersion: { ID: "11111111-1111-4111-8111-111111111111" },
    WallTimeMs: 7,
  });
}
export const logObject = (events: TestEvent[]): Uint8Array =>
  gzipSync(events.map((event) => logLine(event)).join("\n") + "\n");

/**
 * `usage/20261030/20261030T081500Z_20261030T081530Z_aaaa.log.gz` for the batch starting at 08:15:00 UTC of
 * 2026-10-30; `folder` is the `YYYYMMDD` folder the object sits in.
 */
export function objectKey(
  hour: number,
  minute: number,
  second: number,
  id: string,
  folder = "20261030",
): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/gu, "");
  const start = Date.UTC(2026, 9, 30, hour, minute, second);
  return `usage/${folder}/${stamp(start)}_${stamp(start + 30_000)}_${id}.log.gz`;
}
