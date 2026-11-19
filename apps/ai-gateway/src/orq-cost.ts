import { isRecord, parseJson } from "./request.js";

/*
 * The orq cost of an answered call: orq records a cost per trace, and its telemetry query returns
 * it. The telemetry arrives after the answer, so the query is attempted several times. An absent or unreadable
 * value is `null`; any observed explicit zero stays zero unless a later positive cost arrives. The gateway decides
 * the route-specific unmeasured-cost policy. The worst case of all attempts stays well inside the 30 s background
 * budget of a Worker (see the budget test).
 */

export interface OrqFetch {
  (url: string, init: RequestInit): Promise<Response>;
}

export interface OrqEndpoint {
  readonly fetch: OrqFetch;
  readonly apiKey: string;
  readonly baseUrl: string;
}

export type Wait = (ms: number) => Promise<void>;

export const TRACE_COST_ATTEMPTS = 5;
export const TRACE_COST_RETRY_MS = 2_000;
export const TELEMETRY_TIMEOUT_MS = 3_000;
const DAY_MS = 86_400_000;
const NANO_USD_PER_USD = 1_000_000_000;
const COST_METRIC = "cost.total:sum";

/** The cost of one orq trace in nano-USD, or `null` when no attempt reads a value. */
export async function fetchTraceCostNanoUsd(
  orq: OrqEndpoint,
  traceId: string,
  wait: Wait,
): Promise<bigint | null> {
  let lastCost: bigint | null = null;
  for (let attempt = 1; attempt <= TRACE_COST_ATTEMPTS; attempt += 1) {
    const cost = await queryTraceCost(orq, traceId);
    if (cost !== null && cost > 0n) return cost;
    if (cost !== null) lastCost = cost;
    if (attempt < TRACE_COST_ATTEMPTS) await wait(TRACE_COST_RETRY_MS);
  }
  return lastCost;
}

async function queryTraceCost(orq: OrqEndpoint, traceId: string): Promise<bigint | null> {
  const now = Date.now();
  const query = {
    source: "TELEMETRY_SOURCE_TRACES",
    from: new Date(now - DAY_MS).toISOString(),
    to: new Date(now + DAY_MS).toISOString(),
    compute: [{ metric: "cost.total", op: "sum" }],
    filters: [{ field: "trace_id", op: "eq", values: [traceId] }],
    mode: "scalar",
  };
  try {
    const response = await orq.fetch(`${new URL(orq.baseUrl).origin}/v3/telemetry/query`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${orq.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return usdToNanoUsd(costUsdOf(parseJson(await response.text())));
  } catch {
    return null;
  }
}

/** The USD cost of the first scalar row, or `null` when it is absent, not a number or negative. */
function costUsdOf(parsed: unknown): number | null {
  const data = isRecord(parsed) ? parsed["data"] : undefined;
  const row = Array.isArray(data) ? data[0] : undefined;
  const metrics = isRecord(row) ? row["metrics"] : undefined;
  const value = isRecord(metrics) ? metrics[COST_METRIC] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Whole nano-USD: orq reports USD as a float, and the rounding removes its representation error. */
function usdToNanoUsd(usd: number | null): bigint | null {
  return usd === null ? null : BigInt(Math.round(usd * NANO_USD_PER_USD));
}
