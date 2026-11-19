/** Cloudflare's billing usage includes the micro-VM; guest CPU counters do not.
 * Its 64-hex instance ID is the Durable Object actor ID:
 * https://developers.cloudflare.com/api/resources/containers/
 * These are revisable observations, not final invoices. */
const QUERY = `query PreviewUsage($account: String, $start: Time, $end: Time, $instance: String, $application: String, $runLabel: String) {
  viewer { accounts(filter: {accountTag: $account}) {
    containersUsageAdaptiveGroups(limit: 5, filter: {datetime_geq: $start, datetime_leq: $end, instanceId: $instance, applicationId: $application, labels_has: $runLabel}) {
      dimensions { instanceId applicationId preview: label(name: "preview") runtime: label(name: "runtime") run: label(name: "run") }
      sum { cpuTimeSec }
    }
  } }
}`;

export interface PreviewUsageProviderConfig {
  readonly accountId: string;
  readonly token: string;
  readonly applicationId: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly now?: () => Date;
}
export interface PreviewApplicationLookup {
  readonly accountId: string;
  readonly token: string;
  readonly applicationName: string;
  readonly expectedApplicationId?: string;
  readonly fetch: (request: Request) => Promise<Response>;
}
export interface PreviewUsageRun {
  readonly previewId: string;
  readonly runtimeGeneration: number;
  readonly intervalId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly closedAt: string;
}
export type PreviewUsageObservation =
  | { readonly status: "pending" }
  | {
      readonly status: "observed";
      readonly cpuMilliseconds: number;
      readonly observedAt: string;
      readonly providerFactId: string;
    };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw new Error("preview_usage_provider_unavailable");
}
const APPLICATION_ID =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u;
/** Containers REST uses 32 hex digits; its GraphQL dataset uses UUID form. */
function telemetryApplicationId(applicationId: string): string {
  return applicationId.replace(
    /^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/u,
    "$1-$2-$3-$4-$5",
  );
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        return invalid();
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
}

/** Resolve the one exact DO-scheduled application without an administrative credential.
 * https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/list/ */
export async function resolvePreviewApplication(config: PreviewApplicationLookup): Promise<string> {
  if (
    !/^[a-f0-9]{32}$/u.test(config.accountId) ||
    !config.token ||
    !/^[a-z0-9-]{1,128}$/u.test(config.applicationName)
  )
    return invalid();
  const matches: string[] = [];
  let page: string | undefined;
  for (let count = 0; count < 10; count++) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/containers/applications`,
    );
    url.searchParams.set("name", config.applicationName);
    url.searchParams.set("per_page", "100");
    if (page) url.searchParams.set("page_token", page);
    const response = await config
      .fetch(
        new Request(url, {
          headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        }),
      )
      .catch(invalid);
    if (!response.ok) return invalid();
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 1024 * 1024) return invalid();
    const value = await boundedJson(response, 1024 * 1024);
    if (!object(value) || value["success"] !== true || !Array.isArray(value["result"]))
      return invalid();
    for (const raw of value["result"]) {
      if (!object(raw) || raw["name"] !== config.applicationName) continue;
      const durable = raw["durable_objects"];
      if (
        raw["account_id"] !== config.accountId ||
        raw["scheduling_policy"] !== "durable_object" ||
        typeof raw["id"] !== "string" ||
        !APPLICATION_ID.test(raw["id"]) ||
        !object(durable) ||
        typeof durable["namespace_id"] !== "string" ||
        !/^[a-f0-9]{32}$/u.test(durable["namespace_id"])
      )
        return invalid();
      matches.push(raw["id"]);
    }
    const info = value["result_info"];
    const next = object(info) ? info["next_page_token"] : undefined;
    if (next === undefined || next === null || next === "") {
      if (
        matches.length !== 1 ||
        (config.expectedApplicationId && config.expectedApplicationId !== matches[0])
      )
        return invalid();
      return matches[0] as string;
    }
    if (typeof next !== "string" || next.length > 2048 || next === page) return invalid();
    page = next;
  }
  return invalid();
}

export async function observePreviewUsage(
  config: PreviewUsageProviderConfig,
  run: PreviewUsageRun,
): Promise<PreviewUsageObservation> {
  if (
    !/^[a-f0-9]{32}$/u.test(config.accountId) ||
    !config.token ||
    !APPLICATION_ID.test(config.applicationId) ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(run.previewId) ||
    !Number.isSafeInteger(run.runtimeGeneration) ||
    run.runtimeGeneration < 1 ||
    !/^[A-Za-z0-9:_-]{1,64}$/u.test(run.intervalId) ||
    !/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/u.test(run.instanceId)
  )
    return invalid();
  const start = Date.parse(run.startedAt),
    end = Date.parse(run.closedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return invalid();
  const applicationId = telemetryApplicationId(config.applicationId);
  const response = await config
    .fetch(
      new Request("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          query: QUERY,
          variables: {
            account: config.accountId,
            start: new Date(start - 86_400_000).toISOString(),
            end: new Date(end + 86_400_000).toISOString(),
            instance: run.instanceId,
            application: applicationId,
            runLabel: `run=${run.intervalId}`,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      }),
    )
    .catch(invalid);
  if (!response.ok) return invalid();
  const value = await boundedJson(response, 256 * 1024);
  if (!object(value) || (value["errors"] !== null && value["errors"] !== undefined))
    return invalid();
  const data = value["data"];
  if (
    !object(data) ||
    !object(data["viewer"]) ||
    !Array.isArray(data["viewer"]["accounts"]) ||
    data["viewer"]["accounts"].length !== 1
  )
    return invalid();
  const account = data["viewer"]["accounts"][0];
  if (!object(account) || !Array.isArray(account["containersUsageAdaptiveGroups"]))
    return invalid();
  const rows: unknown[] = account["containersUsageAdaptiveGroups"];
  if (rows.length === 0) return { status: "pending" };
  if (rows.length !== 1 || !object(rows[0])) return invalid();
  const dimensions = rows[0]["dimensions"],
    sum = rows[0]["sum"];
  if (
    !object(dimensions) ||
    dimensions["instanceId"] !== run.instanceId ||
    typeof dimensions["applicationId"] !== "string" ||
    !APPLICATION_ID.test(dimensions["applicationId"]) ||
    telemetryApplicationId(dimensions["applicationId"]) !== applicationId ||
    dimensions["preview"] !== run.previewId ||
    dimensions["runtime"] !== String(run.runtimeGeneration) ||
    dimensions["run"] !== run.intervalId ||
    !object(sum) ||
    typeof sum["cpuTimeSec"] !== "number" ||
    !Number.isFinite(sum["cpuTimeSec"]) ||
    sum["cpuTimeSec"] < 0
  )
    return invalid();
  const cpuMilliseconds = Math.ceil(sum["cpuTimeSec"] * 1000);
  if (!Number.isSafeInteger(cpuMilliseconds)) return invalid();
  const observedAt = (config.now?.() ?? new Date()).toISOString();
  const fact = new TextEncoder().encode(
    JSON.stringify([
      "cloudflare.containers-usage/v1",
      config.accountId,
      config.applicationId,
      run.instanceId,
      run.previewId,
      run.runtimeGeneration,
      run.intervalId,
      cpuMilliseconds,
      observedAt,
    ]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fact));
  const providerFactId = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { status: "observed", cpuMilliseconds, observedAt, providerFactId };
}
