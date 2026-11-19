import { makeZoneOrigin, readBounded } from "./make-catalog.js";

interface MakeContext {
  zone: string;
  accessToken: string;
  teamId: number;
  authorizeDispatch?: () => Promise<boolean>;
}
export interface MakeEndpointExecutionRequest extends MakeContext {
  connectionId: number;
  appName: string;
  appVersion: number;
  endpointName: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
}
export interface MakeScenarioExecutionRequest extends MakeContext {
  scenarioId: number;
  connectionId: number;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathPrefix: string;
  inputs: Record<string, unknown>;
}
export type MakeExecutionResult =
  | { ok: true; output: unknown }
  | { ok: false; kind: "denied" | "uncertain" };
const denied: MakeExecutionResult = { ok: false, kind: "denied" };
const uncertain: MakeExecutionResult = { ok: false, kind: "uncertain" };
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const name = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);

async function get(request: MakeContext, path: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(`${makeZoneOrigin(request.zone)}/api/v2${path}`, {
    headers: { authorization: `Bearer ${request.accessToken}`, accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  return readBounded(response);
}
async function dispatch(
  request: MakeContext,
  path: string,
  body: unknown,
  fetcher: typeof fetch,
): Promise<MakeExecutionResult> {
  if (request.authorizeDispatch && !(await request.authorizeDispatch())) return denied;
  try {
    const response = await fetcher(`${makeZoneOrigin(request.zone)}/api/v2${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    // Authentication and explicit input/permission rejections are definitive. Server errors,
    // redirects and unreadable success bodies may occur after the action was dispatched.
    if ([400, 401, 403, 404, 405, 422].includes(response.status)) return denied;
    if (!response.ok) return uncertain;
    return { ok: true, output: await readBounded(response, 1024 * 1024) };
  } catch {
    return uncertain;
  }
}
function contextValid(request: MakeContext): boolean {
  if (!id(request.teamId) || !request.accessToken) return false;
  try {
    makeZoneOrigin(request.zone);
    return true;
  } catch {
    return false;
  }
}
export async function executeMakeEndpoint(
  request: MakeEndpointExecutionRequest,
  fetcher: typeof fetch = fetch,
): Promise<MakeExecutionResult> {
  if (
    !contextValid(request) ||
    !id(request.connectionId) ||
    !id(request.appVersion) ||
    !name(request.appName) ||
    !name(request.endpointName) ||
    request.endpointName.replace(/[-_]/gu, "").toLowerCase() === "arbitrarycall" ||
    !record(request.input) ||
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length < 1 ||
    request.idempotencyKey.length > 256
  )
    return denied;
  try {
    const body = await get(request, `/imt/endpoints-usable?teamId=${request.teamId}`, fetcher);
    if (!record(body) || !Array.isArray(body["packages"])) return denied;
    const usable = body["packages"].some(
      (pkg: unknown) =>
        record(pkg) &&
        pkg["name"] === request.appName &&
        Array.isArray(pkg["versions"]) &&
        pkg["versions"].some(
          (version: unknown) =>
            record(version) &&
            version["version"] === request.appVersion &&
            Array.isArray(version["endpoints"]) &&
            version["endpoints"].some(
              (endpoint: unknown) =>
                record(endpoint) &&
                endpoint["name"] === request.endpointName &&
                endpoint["private"] === false &&
                (!record(endpoint["annotations"]) ||
                  endpoint["annotations"]["arbitraryCallHint"] !== true) &&
                Array.isArray(endpoint["credentialsAvailable"]) &&
                endpoint["credentialsAvailable"].some(
                  (credential: unknown) =>
                    record(credential) && credential["id"] === request.connectionId,
                ),
            ),
        ),
    );
    if (!usable) return denied;
  } catch {
    return denied;
  }
  return dispatch(
    request,
    "/endpoints/execute",
    {
      appName: request.appName,
      appVersion: request.appVersion,
      endpointName: request.endpointName,
      teamId: request.teamId,
      connectionId: request.connectionId,
      input: request.input,
      confidential: true,
      idempotencyKey: request.idempotencyKey,
    },
    fetcher,
  );
}

/** Reject encodings that can alter the authorized segment boundary on another decode. */
function safePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.includes("//") ||
    /[?#\\\p{Cc}\p{White_Space}]/u.test(value) ||
    /%(?:2f|2e|5c|25|3f|23)/iu.test(value)
  )
    return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      !/[?#\\\p{Cc}]/u.test(decoded) &&
      !decoded.split("/").some((segment) => segment === "." || segment === "..")
    );
  } catch {
    return false;
  }
}
function safeHeaders(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const forbidden =
    /^(?:authorization|proxy-authorization|host|cookie|set-cookie|x-api-key|api-key|x-http-method-override|x-http-method|x-method-override)$/iu;
  if (Array.isArray(value))
    return value.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry["name"] === "string" &&
        /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(entry["name"]) &&
        !forbidden.test(entry["name"]) &&
        typeof entry["value"] === "string" &&
        !/[\r\n]/u.test(entry["value"]),
    );
  if (record(value))
    return Object.entries(value).every(
      ([key, item]) =>
        /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(key) &&
        !forbidden.test(key) &&
        typeof item === "string" &&
        !/[\r\n]/u.test(item),
    );
  return false;
}
function shellBlueprint(value: unknown, connectionId: number): boolean {
  if (!record(value)) return false;
  let blueprint: unknown = record(value["response"])
    ? value["response"]["blueprint"]
    : value["blueprint"];
  if (typeof blueprint === "string") {
    try {
      blueprint = JSON.parse(blueprint) as unknown;
    } catch {
      return false;
    }
  }
  if (!record(blueprint) || !Array.isArray(blueprint["flow"]) || blueprint["flow"].length !== 3)
    return false;
  const [start, middle, end] = blueprint["flow"] as unknown[];
  if (
    !record(start) ||
    !record(middle) ||
    !record(end) ||
    !id(start["id"]) ||
    !id(middle["id"]) ||
    !id(end["id"]) ||
    new Set([start["id"], middle["id"], end["id"]]).size !== 3 ||
    start["module"] !== "scenario-service:StartSubscenario" ||
    end["module"] !== "scenario-service:ReturnData" ||
    typeof middle["module"] !== "string" ||
    !/^(?!http:|builtin:|util:|gateway:|scenario-service:|communityApp-)[A-Za-z0-9_#-]+:(?:action)?make(?:an)?ApiCall$/iu.test(
      middle["module"],
    ) ||
    !record(start["parameters"]) ||
    Object.keys(start["parameters"]).length !== 0 ||
    !record(start["mapper"]) ||
    Object.keys(start["mapper"]).length !== 0 ||
    !record(end["parameters"]) ||
    Object.keys(end["parameters"]).length !== 0 ||
    !record(middle["parameters"]) ||
    Object.keys(middle["parameters"]).some((key) => key !== "__IMTCONN__") ||
    middle["parameters"]["__IMTCONN__"] !== connectionId ||
    !record(middle["mapper"]) ||
    !record(end["mapper"])
  )
    return false;
  if (
    [start, middle, end].some(
      (module) =>
        (module["filter"] !== undefined && module["filter"] !== null) ||
        module["onerror"] !== undefined ||
        module["routes"] !== undefined,
    )
  )
    return false;
  const startId = start["id"];
  const expected: Record<string, string> = {
    url: `{{${startId}.path}}`,
    method: `{{${startId}.method}}`,
    headers: `{{${startId}.header}}`,
    qs: `{{${startId}.qs}}`,
    body: `{{${startId}.body}}`,
  };
  const mapper = middle["mapper"];
  if (
    mapper["url"] !== expected["url"] ||
    mapper["method"] !== expected["method"] ||
    Object.entries(mapper).some(
      ([key, mapping]) => expected[key] === undefined || mapping !== expected[key],
    )
  )
    return false;
  return (
    Object.keys(end["mapper"]).length === 1 && end["mapper"]["data"] === `{{${middle["id"]}.body}}`
  );
}

export async function runMakeScenario(
  request: MakeScenarioExecutionRequest,
  fetcher: typeof fetch = fetch,
): Promise<MakeExecutionResult> {
  if (
    !contextValid(request) ||
    !id(request.scenarioId) ||
    !id(request.connectionId) ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
    !record(request.inputs) ||
    request.inputs["method"] !== request.method ||
    !safePath(request.pathPrefix) ||
    !safePath(request.inputs["path"]) ||
    !safeHeaders(request.inputs["header"])
  )
    return denied;
  const prefix = decodeURIComponent(request.pathPrefix).replace(/\/+$/gu, "");
  const path = decodeURIComponent(request.inputs["path"]).replace(/\/+$/gu, "");
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return denied;
  if (
    Object.keys(request.inputs).some(
      (key) => !["path", "method", "header", "qs", "body"].includes(key),
    )
  )
    return denied;
  try {
    const detail = await get(request, `/scenarios/${request.scenarioId}`, fetcher);
    if (
      !record(detail) ||
      !record(detail["scenario"]) ||
      detail["scenario"]["id"] !== request.scenarioId ||
      detail["scenario"]["teamId"] !== request.teamId ||
      detail["scenario"]["isActive"] !== true ||
      !record(detail["scenario"]["scheduling"]) ||
      detail["scenario"]["scheduling"]["type"] !== "on-demand"
    )
      return denied;
    const blueprint = await get(request, `/scenarios/${request.scenarioId}/blueprint`, fetcher);
    if (!shellBlueprint(blueprint, request.connectionId)) return denied;
    const spec = await get(request, `/scenarios/${request.scenarioId}/interface`, fetcher);
    if (!record(spec) || !record(spec["interface"]) || !Array.isArray(spec["interface"]["input"]))
      return denied;
    const fields = spec["interface"]["input"];
    if (
      fields.some(
        (field: unknown) =>
          !record(field) ||
          typeof field["name"] !== "string" ||
          (field["required"] !== undefined && typeof field["required"] !== "boolean"),
      )
    )
      return denied;
    if (
      Object.keys(request.inputs).some(
        (key) => !fields.some((field: Record<string, unknown>) => field["name"] === key),
      ) ||
      fields.some(
        (field: Record<string, unknown>) =>
          field["required"] === true && !Object.hasOwn(request.inputs, field["name"] as string),
      )
    )
      return denied;
  } catch {
    return denied;
  }
  const outcome = await dispatch(
    request,
    `/scenarios/${request.scenarioId}/run`,
    { data: request.inputs, responsive: true },
    fetcher,
  );
  if (!outcome.ok) return outcome;
  if (!record(outcome.output) || typeof outcome.output["executionId"] !== "string")
    return uncertain;
  const status = outcome.output["status"];
  // An execution ID alone only acknowledges the run. Errors can follow partial effects.
  if (![1, 2, "1", "2"].includes(status as string | number)) return uncertain;
  return outcome;
}
