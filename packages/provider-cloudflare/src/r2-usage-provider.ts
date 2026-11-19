export interface R2UsageBucket {
  readonly bucketName: string;
  readonly jurisdiction: "eu" | "us";
}

export interface R2UsageInput extends R2UsageBucket {
  readonly from: string;
  readonly to: string;
  readonly signal?: AbortSignal;
}

export interface R2UsageBatchInput {
  readonly buckets: readonly R2UsageBucket[];
  readonly from: string;
  readonly to: string;
  readonly signal?: AbortSignal;
}

export interface R2UsageRecord {
  readonly meter: "r2.storage.observed" | "r2.class_a" | "r2.class_b";
  readonly unit: "byte_peak_day" | "request";
  readonly from: string;
  readonly to: string;
  readonly quantity: string;
  readonly exact: boolean;
}

export interface R2UsageBucketResult extends R2UsageBucket {
  /** Empty means no matching provider rows, never proven zero usage. */
  readonly records: R2UsageRecord[];
}

/** Conservative intersection of both datasets' verified account settings and our local bounds. */
export interface R2UsageLimits {
  readonly maxPageSize: number;
  readonly maxDurationSeconds: number;
}

export class R2UsageCapacityError extends Error {
  readonly code = "r2_usage_capacity";
  constructor(readonly reason: "body_limit" | "row_limit" | "time_window") {
    super(
      reason === "body_limit" ? "R2 usage response is too large" : "R2 usage capacity exceeded",
    );
    this.name = "R2UsageCapacityError";
  }
}

export class R2UsageRateLimitError extends Error {
  readonly code = "r2_usage_rate_limited";
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super("R2 usage rate limited");
    this.name = "R2UsageRateLimitError";
  }
}

const MAX_BYTES = 4 * 1024 * 1024;
const LOCAL_LIMITS: R2UsageLimits = { maxPageSize: 10000, maxDurationSeconds: 3 * 86400 };
const BUCKET = /^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}-[0-7][0-9a-hjkmnp-tv-z]{25}$/u;

/**
 * One account, one bounded request, no retries. The collector owns durable account pacing,
 * capability freshness and splitting a capacity failure; default local limits imply no verified
 * account entitlement. Values are variables; only validated integer arity/limits enter query text.
 */
export function createR2UsageProvider(dependencies: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly limits?: R2UsageLimits;
}) {
  if (
    !/^[0-9a-f]{32}$/u.test(dependencies.accountId) ||
    dependencies.apiToken.length < 20 ||
    /\s/u.test(dependencies.apiToken)
  )
    throw invalidInput();
  const limits = dependencies.limits ?? LOCAL_LIMITS;
  if (
    !Number.isSafeInteger(limits.maxPageSize) ||
    limits.maxPageSize < 1 ||
    limits.maxPageSize > 10000 ||
    !Number.isSafeInteger(limits.maxDurationSeconds) ||
    limits.maxDurationSeconds < 1 ||
    limits.maxDurationSeconds > 3 * 86400
  )
    throw invalidInput();
  // Snapshot the supplied settings: mutating a caller object cannot raise this instance's bounds.
  const pageSize = limits.maxPageSize;
  const durationSeconds = limits.maxDurationSeconds;
  const { accountId, apiToken, fetch } = dependencies;

  async function readUsageBatch(input: R2UsageBatchInput): Promise<R2UsageBucketResult[]> {
    const { from, to, results, names } = validateInput(input);
    if (to - from > durationSeconds * 1000) throw new R2UsageCapacityError("time_window");
    const signal =
      input.signal === undefined
        ? AbortSignal.timeout(15000)
        : AbortSignal.any([input.signal, AbortSignal.timeout(15000)]);
    if (signal.aborted) throw requestFailed();
    const variables: Record<string, string> = {
      account: accountId,
      from: input.from,
      to: input.to,
    };
    const declarations: string[] = [];
    const filters: string[] = [];
    let index = 0;
    for (const name of names.keys()) {
      const variable = names.size === 1 ? "bucket" : `bucket${String(index++)}`;
      variables[variable] = name;
      declarations.push(`$${variable}: string!`);
      filters.push(`{ bucketName: $${variable} }`);
    }
    const bucketFilter = names.size === 1 ? "bucketName: $bucket" : `OR: [${filters.join(", ")}]`;
    // The exact account schema/settings readback supports these equality/OR/AND predicates.
    // Keep parser checks too; account capability freshness and final live acceptance are external.
    const query = `query R2Usage($account: string!, ${declarations.join(", ")}, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    storage: r2StorageAdaptiveGroups(limit: ${String(pageSize)}, filter: { ${bucketFilter}, storageClass: "Standard", datetime_geq: $from, datetime_lt: $to }) {
      dimensions { bucketName date storageClass } max { payloadSize }
    }
    operations: r2OperationsAdaptiveGroups(limit: ${String(pageSize)}, filter: { ${bucketFilter}, storageClass: "Standard", datetime_geq: $from, datetime_lt: $to }) {
      dimensions { bucketName datetimeHour actionType actionStatus storageClass }
      sum { requests }
      confidence(level: 0.99) { sum { requests { estimate lower upper sampleSize } } }
    }
  } }
}`;
    const pending = Reflect.apply(fetch, globalThis, [
      "https://api.cloudflare.com/client/v4/graphql",
      {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
          "x-rate-limit-type": "account-based",
        },
        body: JSON.stringify({ query, variables }),
      },
    ]) as Promise<Response>;
    const response = await untilAbort(pending, signal, cancelResponse);
    if (!response.ok || !response.body) {
      cancelResponse(response);
      if (response.status === 429)
        throw new R2UsageRateLimitError(
          response.status,
          retryAfter(response.headers.get("retry-after")),
        );
      throw requestFailed();
    }
    const result = await readResponse(response, signal);
    const errors = result["errors"];
    if (
      errors !== null &&
      errors !== undefined &&
      (!Array.isArray(errors) || errors.length !== 0)
    ) {
      if (isRateLimit(errors))
        throw new R2UsageRateLimitError(
          response.status,
          retryAfter(response.headers.get("retry-after")),
        );
      throw invalidResponse();
    }
    const accounts = object(object(result["data"])["viewer"])["accounts"];
    if (!Array.isArray(accounts) || accounts.length !== 1) throw invalidResponse();
    const account = object(accounts[0]);
    const identities = new Set<string>();
    const rawIdentities = new Set<string>();
    for (const dataset of ["storage", "operations"] as const) {
      const rows = account[dataset];
      if (!Array.isArray(rows)) throw invalidResponse();
      // At the limit there is no completeness proof; never interpret a page as a complete capture.
      if (rows.length >= pageSize) throw new R2UsageCapacityError("row_limit");
      for (const raw of rows) {
        const row = object(raw),
          dimensions = object(row["dimensions"]);
        const target =
          typeof dimensions["bucketName"] === "string"
            ? names.get(dimensions["bucketName"])
            : undefined;
        if (target === undefined) throw invalidResponse();
        const rawIdentity = JSON.stringify([
          dataset,
          dimensions["bucketName"],
          dimensions["date"],
          dimensions["datetimeHour"],
          dimensions["storageClass"],
          dimensions["actionType"],
          dimensions["actionStatus"],
        ]);
        if (rawIdentities.has(rawIdentity)) throw invalidResponse();
        rawIdentities.add(rawIdentity);
        const record = parseRecord(row, dimensions, dataset, from, to);
        if (record === null) continue;
        const identity = `${String(dimensions["bucketName"])}/${record.meter}/${record.from}`;
        if (identities.has(identity)) throw invalidResponse();
        identities.add(identity);
        target.records.push(record);
      }
    }
    return results;
  }
  return {
    readUsageBatch,
    async readUsage(input: R2UsageInput): Promise<R2UsageRecord[]> {
      const results = await readUsageBatch({
        buckets: [input],
        from: input.from,
        to: input.to,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // Input validation guarantees one result, including a successful empty response.
      const result = results[0];
      if (result === undefined) throw invalidResponse();
      return result.records;
    },
  };
}

function validateInput(input: R2UsageBatchInput) {
  const from = Date.parse(input.from),
    to = Date.parse(input.to);
  if (
    !Array.isArray(input.buckets) ||
    input.buckets.length < 1 ||
    input.buckets.length > 25 ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from % 86400000 !== 0 ||
    to % 3600000 !== 0 ||
    to <= from ||
    to - from > 3 * 86400000 ||
    new Date(from).toISOString() !== input.from ||
    new Date(to).toISOString() !== input.to
  )
    throw invalidInput();
  const results: R2UsageBucketResult[] = [];
  const names = new Map<string, R2UsageBucketResult>();
  for (const bucket of input.buckets) {
    if (
      !BUCKET.test(bucket.bucketName) ||
      (bucket.jurisdiction !== "eu" && bucket.jurisdiction !== "us")
    )
      throw invalidInput();
    const name = `${bucket.jurisdiction}_${bucket.bucketName}`;
    if (names.has(name)) throw invalidInput();
    const result: R2UsageBucketResult = {
      bucketName: bucket.bucketName,
      jurisdiction: bucket.jurisdiction,
      records: [],
    };
    results.push(result);
    names.set(name, result);
  }
  return { from, to, results, names };
}

function parseRecord(
  row: Record<string, unknown>,
  dimensions: Record<string, unknown>,
  dataset: "storage" | "operations",
  from: number,
  to: number,
): R2UsageRecord | null {
  const start =
    dataset === "storage"
      ? Date.parse(`${String(dimensions["date"])}T00:00:00.000Z`)
      : Date.parse(String(dimensions["datetimeHour"]));
  const duration = dataset === "storage" ? 86400000 : 3600000;
  if (typeof dimensions["storageClass"] !== "string" || !Number.isFinite(start))
    throw invalidResponse();
  if (dataset === "storage") {
    const date = dimensions["date"];
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      new Date(start).toISOString().slice(0, 10) !== date
    )
      throw invalidResponse();
  } else {
    const hour = dimensions["datetimeHour"];
    if (
      typeof hour !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/u.test(hour) ||
      new Date(start).toISOString().replace(".000Z", "Z") !== hour.replace(".000Z", "Z") ||
      typeof dimensions["actionType"] !== "string" ||
      typeof dimensions["actionStatus"] !== "string"
    )
      throw invalidResponse();
  }
  // Validate every returned metric, including non-billable storage classes/actions: malformed
  // provider data cannot be hidden behind the accounting filter.
  const measuredQuantity =
    dataset === "storage"
      ? natural(object(row["max"])["payloadSize"])
      : natural(object(row["sum"])["requests"]);
  if (
    dataset === "storage" &&
    Number.isFinite(start) &&
    start >= from &&
    start < to &&
    start + duration > to
  )
    return null;
  if (!Number.isFinite(start) || start % duration !== 0 || start < from || start + duration > to)
    throw invalidResponse();
  if (dimensions["storageClass"] !== "Standard") return null;
  let meter: R2UsageRecord["meter"],
    quantity: string,
    exact = true;
  if (dataset === "storage") {
    meter = "r2.storage.observed";
    exact = false;
    quantity = measuredQuantity;
  } else {
    if (
      dimensions["actionStatus"] !== "success" ||
      !["PutObject", "GetObject"].includes(String(dimensions["actionType"]))
    )
      return null;
    meter = dimensions["actionType"] === "PutObject" ? "r2.class_a" : "r2.class_b";
    quantity = measuredQuantity;
    const confidence = object(object(object(row["confidence"])["sum"])["requests"]);
    const samples = natural(confidence["sampleSize"]);
    if (
      natural(confidence["estimate"]) !== quantity ||
      typeof confidence["lower"] !== "number" ||
      !Number.isFinite(confidence["lower"]) ||
      typeof confidence["upper"] !== "number" ||
      !Number.isFinite(confidence["upper"]) ||
      confidence["lower"] < 0 ||
      confidence["upper"] < confidence["lower"]
    )
      throw invalidResponse();
    exact =
      samples === quantity &&
      confidence["lower"] === Number(quantity) &&
      confidence["upper"] === Number(quantity);
  }
  return {
    meter,
    unit: dataset === "storage" ? "byte_peak_day" : "request",
    from: new Date(start).toISOString(),
    to: new Date(start + duration).toISOString(),
    quantity,
    exact,
  };
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = response.body;
  if (body === null) throw requestFailed();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await untilAbort(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new R2UsageCapacityError("body_limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    // A broken cancel promise must not extend the request deadline or mask the original result.
    void reader.cancel().catch(ignoreFailure);
    reader.releaseLock();
  }
  try {
    return object(JSON.parse(text));
  } catch {
    throw invalidResponse();
  }
}

/** Race transport and body operations too: an injected transport need not honor its signal. */
async function untilAbort<Value>(
  pending: Promise<Value>,
  signal: AbortSignal,
  late?: (value: Value) => void,
): Promise<Value> {
  if (signal.aborted) {
    void pending.then(late, ignoreFailure);
    throw requestFailed();
  }
  let aborted = false;
  let onAbort: () => void = ignoreFailure;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      aborted = true;
      reject(requestFailed());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([pending, stopped]);
    if (signal.aborted) {
      late?.(value);
      throw requestFailed();
    }
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (aborted && late !== undefined) void pending.then(late, ignoreFailure);
  }
}

function cancelResponse(response: Response): void {
  if (response.body !== null) void response.body.cancel().catch(ignoreFailure);
}
function ignoreFailure(): void {
  /* Rejected cleanup contains no outcome evidence. */
}
function requestFailed(): Error {
  return new Error("R2 usage request failed");
}
function invalidInput(): TypeError {
  return new TypeError("R2 usage input is invalid");
}
function invalidResponse(): TypeError {
  return new TypeError("R2 usage response is invalid");
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function natural(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalidResponse();
  return value.toString();
}
function retryAfter(value: string | null): number | null {
  if (value === null || value.length > 128) return null;
  if (/^(0|[1-9][0-9]*)$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= 2147483647 ? seconds : null;
  }
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)
  )
    return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.ceil((time - Date.now()) / 1000));
  return seconds <= 2147483647 ? seconds : null;
}
function isRateLimit(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  for (const error of errors) {
    if (typeof error !== "object" || error === null) continue;
    const fields = error as Record<string, unknown>;
    if (
      typeof fields["message"] === "string" &&
      /rate limit(?:er)?|budget exceeded|too many requests/iu.test(fields["message"])
    )
      return true;
    const extensions = fields["extensions"];
    if (
      typeof extensions === "object" &&
      extensions !== null &&
      "code" in extensions &&
      typeof extensions.code === "string" &&
      /^(?:too_many_requests|rate_limited|rate_limit_exceeded)$/iu.test(extensions.code)
    )
      return true;
  }
  return false;
}
