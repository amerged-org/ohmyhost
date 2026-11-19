import { CustomerRuntimeGatewayError } from "./errors.js";

const MAX_RESPONSE_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;

export interface GatewayConnection {
  /** Injected gateway origin for server code; never expose the runtime key to a browser. */
  readonly endpoint: string;
  /** Environment capability key from OHMYHOST_MAIL_KEY or OHMYHOST_STORAGE_KEY. */
  readonly key: string;
  /** Use (request) => fetch(request); an explicit transport remains available for tests. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Gateway header timeout: 100–30000 ms, default 10000 ms. */
  readonly timeoutMilliseconds?: number;
}

export interface ValidatedGatewayConnection {
  readonly endpoint: string;
  readonly key: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly timeoutMilliseconds: number;
}

export function validateGatewayConnection(value: GatewayConnection): ValidatedGatewayConnection {
  assertServerRuntime();
  let endpoint: URL | null = null;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    // Reported below with the option that failed.
  }
  if (
    endpoint === null ||
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    configurationInvalid(
      "endpoint is missing or not an https origin; OHMYHOST_MAIL_GATEWAY_URL and OHMYHOST_STORAGE_GATEWAY_URL exist only when ohmyhost.yaml enables that capability",
    );
  }
  if (typeof value.key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.key)) {
    configurationInvalid(
      "key is missing or not a runtime capability key; pass OHMYHOST_MAIL_KEY or OHMYHOST_STORAGE_KEY from the Worker env",
    );
  }
  if (typeof value.fetch !== "function") {
    configurationInvalid(
      "fetch is not a function; pass (request) => fetch(request) in server code",
    );
  }
  const timeoutMilliseconds = value.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 100 ||
    timeoutMilliseconds > 30_000
  ) {
    configurationInvalid("timeoutMilliseconds must be an integer from 100 to 30000");
  }
  return Object.freeze({
    endpoint: endpoint.href,
    key: value.key,
    fetch: value.fetch,
    timeoutMilliseconds,
  });
}

export async function postGatewayJson(
  connection: ValidatedGatewayConnection,
  path: string,
  body: Readonly<Record<string, unknown>>,
  maximumRequestBytes: number,
  idempotencyKey?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const serializedBody = JSON.stringify(body);
  if (new TextEncoder().encode(serializedBody).byteLength > maximumRequestBytes) {
    throw new CustomerRuntimeGatewayError("gateway_request_invalid", null, false);
  }
  const response = await fetchWithTimeout(
    connection.fetch,
    new Request(new URL(path, connection.endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.key}`,
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: serializedBody,
    }),
    connection.timeoutMilliseconds,
  );
  return Object.freeze({ status: response.status, body: await readBoundedJson(response) });
}

export async function fetchWithTimeout(
  fetch: (request: Request) => Promise<Response>,
  request: Request,
  timeoutMilliseconds: number,
): Promise<Response> {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await fetch(new Request(request, { signal }));
  } catch (error) {
    if (error instanceof CustomerRuntimeGatewayError) throw error;
    if (signal.aborted) {
      throw new CustomerRuntimeGatewayError("gateway_timeout", null, true);
    }
    throw new CustomerRuntimeGatewayError("gateway_unavailable", null, true);
  } finally {
    clearTimeout(timeout);
  }
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
  status: number | null = null,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidResponse(status);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidResponse(status);
  }
  return record;
}

export function invalidResponse(status: number | null = null): never {
  throw new CustomerRuntimeGatewayError("gateway_response_invalid", status, false);
}

/** A malformed platform ID is a configuration mistake, not a gateway answer. */
export function requireConfiguredUlid(
  value: unknown,
  option: "projectId" | "environmentId",
  variable: "OHMYHOST_PROJECT_ID" | "OHMYHOST_ENVIRONMENT_ID",
): string {
  if (typeof value !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) {
    configurationInvalid(`${option} is not a ULID; pass ${variable} from the Worker env`);
  }
  return value;
}

/** Names the failing option and how to supply it; never echoes the configured value. */
export function configurationInvalid(detail: string): never {
  throw new CustomerRuntimeGatewayError("gateway_configuration_invalid", null, false, detail);
}

function assertServerRuntime(): void {
  if (typeof window !== "undefined") {
    configurationInvalid("the client runs only in server code, never in a browser");
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    invalidResponse(response.status);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    invalidResponse(response.status);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new CustomerRuntimeGatewayError("gateway_unavailable", response.status, true);
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) invalidResponse(response.status);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalidResponse(response.status);
  }
}

/** Relay failures share one vocabulary across mail, storage and batch control responses. */
export function throwGatewayRelayError(status: number, body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const code = (body as Record<string, unknown>)["code"];
  if (
    (status === 403 && (code === "gateway_not_enabled" || code === "gateway_route_denied")) ||
    (status === 429 && code === "gateway_rate_limited") ||
    (status === 503 &&
      (code === "mail_gateway_unavailable" || code === "storage_gateway_unavailable"))
  ) {
    exactRecord(body, ["code"], status);
    if (code === "gateway_not_enabled") {
      throw new CustomerRuntimeGatewayError(
        code,
        status,
        false,
        "enable the required mail or storage capability in ohmyhost.yaml and redeploy",
      );
    }
    if (code === "gateway_route_denied") {
      throw new CustomerRuntimeGatewayError(
        code,
        status,
        false,
        "use the current runtime client's supported gateway routes through (request) => fetch(request)",
      );
    }
    if (code === "gateway_rate_limited") {
      throw new CustomerRuntimeGatewayError(
        code,
        status,
        true,
        "wait before repeating this request with the same idempotency keys",
      );
    }
    throw new CustomerRuntimeGatewayError("gateway_unavailable", status, true);
  }
}
