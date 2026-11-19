const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const MAXIMUM_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const ID_PATTERN = /^[0-9a-f]{32}$/u;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const SCRIPT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface CloudflareWorkerRouteTarget {
  readonly hostname: string;
  readonly scriptName: string;
}

export interface CloudflareWorkerRouteReceipt extends CloudflareWorkerRouteTarget {
  readonly routeId: string;
  readonly pattern: string;
  readonly observedAt: Date;
}

export type CloudflareWorkerRouteObservation =
  | Readonly<{ state: "absent"; pattern: string }>
  | Readonly<{ state: "found" } & CloudflareWorkerRouteReceipt>;

export class CloudflareWorkerRouteInputError extends Error {
  public readonly code = "cloudflare_worker_route_input_invalid" as const;

  public constructor() {
    super("Cloudflare Worker route input is invalid");
    this.name = "CloudflareWorkerRouteInputError";
  }
}

export class CloudflareWorkerRouteContractError extends Error {
  public readonly code = "cloudflare_worker_route_contract_invalid" as const;

  public constructor() {
    super("Cloudflare Worker route response is invalid");
    this.name = "CloudflareWorkerRouteContractError";
  }
}

export class CloudflareWorkerRouteRejectedError extends Error {
  public readonly code = "cloudflare_worker_route_request_rejected" as const;

  public constructor() {
    super("Cloudflare Worker route request was rejected");
    this.name = "CloudflareWorkerRouteRejectedError";
  }
}

export class CloudflareWorkerRouteUncertainError extends Error {
  public readonly code = "cloudflare_worker_route_result_uncertain" as const;

  public constructor() {
    super("Cloudflare Worker route result is uncertain");
    this.name = "CloudflareWorkerRouteUncertainError";
  }
}

export class CloudflareWorkerRouteConflictError extends Error {
  public readonly code = "cloudflare_worker_route_conflict" as const;

  public constructor() {
    super("Cloudflare Worker route conflicts with the requested script");
    this.name = "CloudflareWorkerRouteConflictError";
  }
}

export class CloudflareWorkerRouteReceiptMismatchError extends Error {
  public readonly code = "cloudflare_worker_route_receipt_mismatch" as const;

  public constructor() {
    super("Cloudflare Worker route receipt does not match provider state");
    this.name = "CloudflareWorkerRouteReceiptMismatchError";
  }
}

export function createCloudflareWorkerRouteProvider(dependencies: {
  readonly zoneId: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}) {
  validateDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date());
  const baseUrl = `${API_ORIGIN}/zones/${dependencies.zoneId}/workers/routes`;
  const request = (url: string, init: RequestInit): Promise<Response> =>
    Reflect.apply(dependencies.fetch, globalThis, [
      url,
      {
        ...init,
        headers: { authorization: `Bearer ${dependencies.apiToken}`, ...init.headers },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      },
    ]);

  async function observeRoute(
    target: CloudflareWorkerRouteTarget,
  ): Promise<CloudflareWorkerRouteObservation> {
    validateTarget(target);
    let response: Response;
    try {
      response = await request(baseUrl, { method: "GET" });
    } catch {
      throw new CloudflareWorkerRouteUncertainError();
    }
    if (response.status >= 400 && response.status < 500) {
      await discardBody(response);
      throw new CloudflareWorkerRouteRejectedError();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new CloudflareWorkerRouteUncertainError();
    }
    const result = await readSuccessfulEnvelope(response);
    if (!Array.isArray(result)) throw new CloudflareWorkerRouteContractError();
    const pattern = routePattern(target.hostname);
    const matches = result.map(parseRoute).filter((route) => route.pattern === pattern);
    if (matches.length === 0) return Object.freeze({ state: "absent" as const, pattern });
    if (matches.length !== 1) throw new CloudflareWorkerRouteConflictError();
    const match = matches[0];
    if (match === undefined) throw new CloudflareWorkerRouteContractError();
    if (match.scriptName !== target.scriptName) throw new CloudflareWorkerRouteConflictError();
    return Object.freeze({
      state: "found" as const,
      routeId: match.routeId,
      ...target,
      pattern,
      observedAt: canonicalNow(now),
    });
  }

  async function observePlatformWildcardRoute(input: {
    readonly pattern: "*.check.omh.st/*" | "*.dev.check.omh.st/*";
    readonly scriptName: "ohmyho-gateway-production" | "ohmyho-gateway-poc-private-fullstack";
  }): Promise<CloudflareWorkerRouteReceipt> {
    if (
      (input.pattern === "*.check.omh.st/*" && input.scriptName !== "ohmyho-gateway-production") ||
      (input.pattern === "*.dev.check.omh.st/*" &&
        input.scriptName !== "ohmyho-gateway-poc-private-fullstack")
    )
      throw new CloudflareWorkerRouteInputError();
    let response: Response;
    try {
      response = await request(baseUrl, { method: "GET" });
    } catch {
      throw new CloudflareWorkerRouteUncertainError();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new CloudflareWorkerRouteUncertainError();
    }
    const routes = await readSuccessfulEnvelope(response);
    if (!Array.isArray(routes)) throw new CloudflareWorkerRouteContractError();
    const matches = routes.map(parseRoute).filter((route) => route.pattern === input.pattern);
    if (matches.length !== 1 || matches[0]?.scriptName !== input.scriptName)
      throw new CloudflareWorkerRouteConflictError();
    return Object.freeze({
      routeId: matches[0].routeId,
      pattern: input.pattern,
      hostname: input.pattern.slice(2, -2),
      scriptName: input.scriptName,
      observedAt: canonicalNow(now),
    });
  }

  async function replacePlatformWildcardRoute(input: {
    readonly routeId: string;
    readonly pattern: "*.check.omh.st/*" | "*.dev.check.omh.st/*";
    readonly expectedScript: string;
    readonly scriptName: string;
    readonly forceWrite?: boolean;
  }): Promise<
    Readonly<{
      outcome: "updated" | "existing" | "recovered";
      receipt: CloudflareWorkerRouteReceipt;
    }>
  > {
    const sharedScript =
      input.pattern === "*.check.omh.st/*"
        ? "ohmyho-gateway-production"
        : input.pattern === "*.dev.check.omh.st/*"
          ? "ohmyho-gateway-poc-private-fullstack"
          : null;
    if (
      !ID_PATTERN.test(input.routeId) ||
      sharedScript === null ||
      !(
        (input.expectedScript === "ohmyho-public-production" &&
          input.scriptName === sharedScript) ||
        (input.expectedScript === sharedScript && input.scriptName === "ohmyho-public-production")
      ) ||
      (input.forceWrite !== undefined && input.forceWrite !== true) ||
      (input.forceWrite === true && input.scriptName !== "ohmyho-public-production")
    )
      throw new CloudflareWorkerRouteInputError();
    const exactUrl = `${baseUrl}/${input.routeId}`;
    const before = await readExactRoute(request, exactUrl);
    if (before === null || before.routeId !== input.routeId || before.pattern !== input.pattern)
      throw new CloudflareWorkerRouteReceiptMismatchError();
    if (before.scriptName === input.scriptName && !input.forceWrite)
      return Object.freeze({ outcome: "existing" as const, receipt: wildcardReceipt(before, now) });
    if (
      before.scriptName !== input.expectedScript &&
      !(input.forceWrite && before.scriptName === input.scriptName)
    )
      throw new CloudflareWorkerRouteConflictError();

    let returned: ParsedRoute | null = null;
    let rejected = false;
    let invalidResponse = false;
    try {
      const response = await request(exactUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: input.pattern, script: input.scriptName }),
      });
      if (response.status >= 400 && response.status < 500) {
        rejected = true;
        await discardBody(response);
      } else if (!response.ok) {
        await discardBody(response);
      } else {
        returned = parseRoute(await readSuccessfulEnvelope(response));
        invalidResponse =
          returned.routeId !== input.routeId ||
          returned.pattern !== input.pattern ||
          returned.scriptName !== input.scriptName;
      }
    } catch {
      // Exact-ID readback below is the only recovery after an ambiguous write.
    }
    const after = await readExactRoute(request, exactUrl);
    if (after === null || after.routeId !== input.routeId || after.pattern !== input.pattern)
      throw new CloudflareWorkerRouteReceiptMismatchError();
    if (after.scriptName === input.scriptName)
      return Object.freeze({
        outcome:
          returned === null || invalidResponse ? ("recovered" as const) : ("updated" as const),
        receipt: wildcardReceipt(after, now),
      });
    if (invalidResponse) throw new CloudflareWorkerRouteContractError();
    if (after.scriptName !== input.expectedScript) throw new CloudflareWorkerRouteConflictError();
    if (rejected) throw new CloudflareWorkerRouteRejectedError();
    throw new CloudflareWorkerRouteUncertainError();
  }

  async function createRoute(target: CloudflareWorkerRouteTarget): Promise<
    Readonly<{
      outcome: "created" | "existing" | "recovered";
      receipt: CloudflareWorkerRouteReceipt;
    }>
  > {
    validateTarget(target);
    const before = await observeRoute(target);
    if (before.state === "found") {
      return Object.freeze({ outcome: "existing" as const, receipt: withoutState(before) });
    }
    const pattern = routePattern(target.hostname);
    let created: ParsedRoute | null = null;
    let rejected = false;
    let conflicted = false;
    try {
      const response = await request(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern, script: target.scriptName }),
      });
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        if (response.status === 409) conflicted = true;
        else rejected = true;
      } else {
        created = parseRoute(await readSuccessfulEnvelope(response));
      }
    } catch {
      // The exact route readback below is the only recovery after an ambiguous mutation.
    }
    if (rejected) throw new CloudflareWorkerRouteRejectedError();

    try {
      const observed = await observeRoute(target);
      if (observed.state === "found") {
        const receipt = withoutState(observed);
        if (
          created !== null &&
          (created.routeId !== receipt.routeId ||
            created.pattern !== receipt.pattern ||
            created.scriptName !== receipt.scriptName)
        ) {
          throw new CloudflareWorkerRouteUncertainError();
        }
        return Object.freeze({
          outcome: created === null ? ("recovered" as const) : ("created" as const),
          receipt,
        });
      }
    } catch {
      // The public error stays redacted and does not expose provider response details.
    }
    if (conflicted) throw new CloudflareWorkerRouteRejectedError();
    throw new CloudflareWorkerRouteUncertainError();
  }

  /**
   * Moves the receipt's exact route ID from its receipt script to another script in place, so the
   * host never loses its route; any other pattern or script on that ID is refused.
   */
  async function retargetRoute(
    expected: CloudflareWorkerRouteReceipt,
    scriptName: string,
  ): Promise<
    Readonly<{
      outcome: "updated" | "existing" | "recovered";
      receipt: CloudflareWorkerRouteReceipt;
    }>
  > {
    validateReceipt(expected);
    validateTarget({ hostname: expected.hostname, scriptName });
    const exactUrl = `${baseUrl}/${expected.routeId}`;
    const moved = (route: ParsedRoute) =>
      Object.freeze({
        routeId: route.routeId,
        hostname: expected.hostname,
        scriptName,
        pattern: expected.pattern,
        observedAt: canonicalNow(now),
      });
    const before = await readExactRoute(request, exactUrl);
    if (
      before === null ||
      before.routeId !== expected.routeId ||
      before.pattern !== expected.pattern
    )
      throw new CloudflareWorkerRouteReceiptMismatchError();
    if (before.scriptName === scriptName)
      return Object.freeze({ outcome: "existing" as const, receipt: moved(before) });
    if (before.scriptName !== expected.scriptName) throw new CloudflareWorkerRouteConflictError();

    let rejected = false;
    let confirmed = false;
    try {
      const response = await request(exactUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: expected.pattern, script: scriptName }),
      });
      if (response.status >= 400 && response.status < 500) {
        rejected = true;
        await discardBody(response);
      } else if (!response.ok) {
        await discardBody(response);
      } else {
        const returned = parseRoute(await readSuccessfulEnvelope(response));
        confirmed =
          returned.routeId === expected.routeId &&
          returned.pattern === expected.pattern &&
          returned.scriptName === scriptName;
      }
    } catch {
      // Exact-ID readback below is the only recovery after an ambiguous write.
    }
    const after = await readExactRoute(request, exactUrl);
    if (after === null || after.routeId !== expected.routeId || after.pattern !== expected.pattern)
      throw new CloudflareWorkerRouteReceiptMismatchError();
    if (after.scriptName === scriptName)
      return Object.freeze({
        outcome: confirmed ? ("updated" as const) : ("recovered" as const),
        receipt: moved(after),
      });
    if (after.scriptName !== expected.scriptName) throw new CloudflareWorkerRouteConflictError();
    if (rejected) throw new CloudflareWorkerRouteRejectedError();
    throw new CloudflareWorkerRouteUncertainError();
  }

  async function deleteRoute(expected: CloudflareWorkerRouteReceipt): Promise<
    Readonly<{
      outcome: "deleted" | "absent";
      routeId: string;
      pattern: string;
      observedAt: Date;
    }>
  > {
    validateReceipt(expected);
    const exactUrl = `${baseUrl}/${expected.routeId}`;
    const before = await readExactRoute(request, exactUrl);
    if (before === null) return absenceReceipt(expected, "absent", canonicalNow(now));
    if (
      before.routeId !== expected.routeId ||
      before.pattern !== expected.pattern ||
      before.scriptName !== expected.scriptName
    ) {
      throw new CloudflareWorkerRouteReceiptMismatchError();
    }

    let rejected = false;
    try {
      const response = await request(exactUrl, { method: "DELETE" });
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        rejected = true;
      } else {
        const result = await readSuccessfulEnvelope(response);
        if (!isRecord(result) || result["id"] !== expected.routeId) {
          throw new CloudflareWorkerRouteContractError();
        }
      }
    } catch {
      // The exact route readback below is the only recovery after an ambiguous mutation.
    }

    try {
      const observed = await readExactRoute(request, exactUrl);
      if (observed === null) return absenceReceipt(expected, "deleted", canonicalNow(now));
    } catch {
      // The public error stays redacted and does not expose provider response details.
    }
    if (rejected) throw new CloudflareWorkerRouteRejectedError();
    throw new CloudflareWorkerRouteUncertainError();
  }

  return Object.freeze({
    observeRoute,
    observePlatformWildcardRoute,
    replacePlatformWildcardRoute,
    createRoute,
    retargetRoute,
    deleteRoute,
  });
}

function wildcardReceipt(route: ParsedRoute, now: () => Date): CloudflareWorkerRouteReceipt {
  if (
    (route.pattern !== "*.check.omh.st/*" && route.pattern !== "*.dev.check.omh.st/*") ||
    route.scriptName === null
  )
    throw new CloudflareWorkerRouteContractError();
  return Object.freeze({
    routeId: route.routeId,
    pattern: route.pattern,
    hostname: route.pattern.slice(2, -2),
    scriptName: route.scriptName,
    observedAt: canonicalNow(now),
  });
}

interface ParsedRoute {
  readonly routeId: string;
  readonly pattern: string;
  readonly scriptName: string | null;
}

function parseRoute(value: unknown): ParsedRoute {
  const route = record(value);
  if (
    !ID_PATTERN.test(String(route["id"])) ||
    typeof route["pattern"] !== "string" ||
    route["pattern"].length === 0 ||
    (typeof route["script"] !== "string" && route["script"] !== null)
  ) {
    throw new CloudflareWorkerRouteContractError();
  }
  return Object.freeze({
    routeId: String(route["id"]),
    pattern: route["pattern"],
    scriptName: route["script"],
  });
}

async function readExactRoute(
  request: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
): Promise<ParsedRoute | null> {
  let response: Response;
  try {
    response = await request(url, { method: "GET" });
  } catch {
    throw new CloudflareWorkerRouteUncertainError();
  }
  if (response.status === 404) {
    const envelope = record(await readJson(response));
    if (
      envelope["success"] !== false ||
      !Array.isArray(envelope["errors"]) ||
      envelope["errors"].length === 0 ||
      !envelope["errors"].every(
        (error) => isRecord(error) && Number.isSafeInteger(error["code"]),
      ) ||
      !Array.isArray(envelope["messages"]) ||
      envelope["result"] !== null
    ) {
      throw new CloudflareWorkerRouteContractError();
    }
    return null;
  }
  if (response.status >= 400 && response.status < 500) {
    await discardBody(response);
    throw new CloudflareWorkerRouteRejectedError();
  }
  if (!response.ok) {
    await discardBody(response);
    throw new CloudflareWorkerRouteUncertainError();
  }
  return parseRoute(await readSuccessfulEnvelope(response));
}

async function readSuccessfulEnvelope(response: Response): Promise<unknown> {
  const envelope = record(await readJson(response));
  if (
    response.status !== 200 ||
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"]) ||
    !("result" in envelope)
  ) {
    throw new CloudflareWorkerRouteContractError();
  }
  return envelope["result"];
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw new CloudflareWorkerRouteContractError();
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAXIMUM_RESPONSE_BYTES) throw new CloudflareWorkerRouteContractError();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new CloudflareWorkerRouteContractError();
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redacted provider result is unchanged when cancellation fails.
  }
}

function routePattern(hostname: string): string {
  return `${hostname}/*`;
}

function withoutState(
  value: Readonly<{ state: "found" } & CloudflareWorkerRouteReceipt>,
): CloudflareWorkerRouteReceipt {
  return Object.freeze({
    routeId: value.routeId,
    hostname: value.hostname,
    scriptName: value.scriptName,
    pattern: value.pattern,
    observedAt: value.observedAt,
  });
}

function absenceReceipt(
  expected: CloudflareWorkerRouteReceipt,
  outcome: "deleted" | "absent",
  observedAt: Date,
) {
  return Object.freeze({
    outcome,
    routeId: expected.routeId,
    pattern: expected.pattern,
    observedAt,
  });
}

function validateDependencies(value: unknown): asserts value is {
  zoneId: string;
  apiToken: string;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
} {
  if (
    !isRecord(value) ||
    typeof value["zoneId"] !== "string" ||
    !ID_PATTERN.test(value["zoneId"]) ||
    typeof value["apiToken"] !== "string" ||
    value["apiToken"].length < 20 ||
    typeof value["fetch"] !== "function" ||
    (value["now"] !== undefined && typeof value["now"] !== "function")
  ) {
    throw new CloudflareWorkerRouteInputError();
  }
}

function validateTarget(value: CloudflareWorkerRouteTarget): void {
  if (
    !isRecord(value) ||
    typeof value["hostname"] !== "string" ||
    !DOMAIN_PATTERN.test(value["hostname"]) ||
    typeof value["scriptName"] !== "string" ||
    !SCRIPT_NAME_PATTERN.test(value["scriptName"])
  ) {
    throw new CloudflareWorkerRouteInputError();
  }
}

function validateReceipt(value: CloudflareWorkerRouteReceipt): void {
  validateTarget(value);
  if (
    !ID_PATTERN.test(value.routeId) ||
    value.pattern !== routePattern(value.hostname) ||
    !(value.observedAt instanceof Date) ||
    !Number.isFinite(value.observedAt.getTime())
  ) {
    throw new CloudflareWorkerRouteInputError();
  }
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CloudflareWorkerRouteContractError();
  }
  return new Date(value.getTime());
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CloudflareWorkerRouteContractError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
