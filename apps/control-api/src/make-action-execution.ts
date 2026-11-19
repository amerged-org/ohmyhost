import { readBoundedText } from "./workos-session-status.js";

type ShellMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type BoundMakeAction =
  | { kind: "endpoint"; appName: string; appVersion: number; endpointName: string }
  | { kind: "scenario"; scenarioId: number; method: ShellMethod; pathPrefix: string };

export interface MakeActionBinding {
  binding_id: string;
  execution_key: string;
}

export interface MakeActionExecution {
  state:
    | "completed"
    | "already_completed"
    | "denied"
    | "reconnect_required"
    | "conflict"
    | "uncertain"
    | "running";
  output?: unknown;
}

export interface MakeActionBroker {
  executeMakeAction(input: {
    key: string;
    idempotencyKey: string;
    input: Record<string, unknown>;
  }): Promise<MakeActionExecution>;
}

const keyPattern =
  /^Bearer (omh_make_v1\.[0-7][0-9A-HJKMNP-TV-Z]{25}\.[0-7][0-9A-HJKMNP-TV-Z]{25}\.[A-Za-z0-9_-]{43})$/u;
const idempotencyPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const maxBytes = 128 * 1024;

function result(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMakeAction(value: unknown): BoundMakeAction | null {
  if (!isJsonObject(value)) return null;
  const positive = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  const name = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(candidate);
  const method = value["method"];
  const path = value["path_prefix"];
  if (
    value["kind"] === "scenario" &&
    Object.keys(value).length === 4 &&
    positive(value["scenario_id"]) &&
    (method === "GET" ||
      method === "POST" ||
      method === "PUT" ||
      method === "PATCH" ||
      method === "DELETE") &&
    typeof path === "string" &&
    path.length <= 2048 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[?#\\\p{Cc}]/u.test(path) &&
    !/%(?:2f|2e|5c|25|3f|23)/iu.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  )
    return { kind: "scenario", scenarioId: value["scenario_id"], method, pathPrefix: path };
  if (
    value["kind"] === "endpoint" &&
    Object.keys(value).length === 4 &&
    name(value["app_name"]) &&
    positive(value["app_version"]) &&
    name(value["endpoint_name"]) &&
    value["endpoint_name"].replace(/[-_]/gu, "").toLowerCase() !== "arbitrarycall"
  )
    return {
      kind: "endpoint",
      appName: value["app_name"],
      appVersion: value["app_version"],
      endpointName: value["endpoint_name"],
    };
  return null;
}

/** Public HTTPS transport for an action capability, without a human session or app-wide token. */
export async function handleMakeActionExecution(
  request: Request,
  broker: Partial<MakeActionBroker> | undefined,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).search !== "")
    return result({ state: "invalid_request" }, 400);
  const key = keyPattern.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key) return result({ state: "denied" }, 403);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (
    !idempotencyKey ||
    !idempotencyPattern.test(idempotencyKey) ||
    request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
    request.headers.has("content-encoding")
  )
    return result({ state: "invalid_request" }, 400);
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedText(new Response(request.body), maxBytes));
  } catch {
    return result({ state: "invalid_request" }, 400);
  }
  if (
    !isJsonObject(payload) ||
    Object.keys(payload).length !== 1 ||
    !isJsonObject(payload["input"])
  )
    return result({ state: "invalid_request" }, 400);
  if (!broker?.executeMakeAction) return result({ state: "unavailable" }, 503);

  try {
    const response = await broker.executeMakeAction({
      key,
      idempotencyKey,
      input: payload["input"],
    });
    switch (response.state) {
      case "completed":
      case "already_completed":
        return result(response, 200);
      case "running":
      case "conflict":
        return result({ state: response.state }, 409);
      case "denied":
      case "reconnect_required":
        return result({ state: response.state }, 403);
      case "uncertain":
        return result({ state: "uncertain" }, 502);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "connection_reconnect_required")
      return result({ state: "reconnect_required" }, 403);
  }
  return result({ state: "unavailable" }, 503);
}
