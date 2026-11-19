import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createPolicyOutboundWorker, type WfpOutboundEnvironment } from "../src/outbound.js";
import outboundWorker from "../src/outbound-main.js";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const MAIL_GATEWAY_ORIGIN = "https://ohmyho-mail-gateway-production.your-omh-account.workers.dev";
const STORAGE_GATEWAY_ORIGIN =
  "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev";
const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const DATA_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PINNED_STORAGE_GATEWAY_ORIGIN = `https://s1-${ORGANIZATION_ID.toLowerCase()}.${ENVIRONMENT_ID.toLowerCase()}-${DATA_ENVIRONMENT_ID.toLowerCase()}.${new URL(STORAGE_GATEWAY_ORIGIN).hostname}`;
const DEV_MAIL_GATEWAY_ORIGIN =
  "https://ohmyho-mail-gateway-poc-private-fullstack.your-omh-account.workers.dev";
const DEV_STORAGE_GATEWAY_ORIGIN =
  "https://ohmyho-storage-gateway-poc-private-fullstack.your-omh-account.workers.dev";
const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
const PROJECT_HEADER = "x-ohmyhost-egress-project-id";
const EGRESS_HEADER_PREFIX = "x-ohmyhost-egress-";
/** Planted in paths, queries, headers, bodies and errors: it must never leave through a log or a refusal. */
const CANARY = "canary-secret-7f3a91";
const STORAGE_ROUTES = [
  "/v1/uploads",
  "/v1/uploads/complete",
  "/v1/downloads",
  "/v1/deletions",
  "/v1/downloads/batch",
  "/v1/deletions/batch",
] as const;
const BROWSER_ORIGINS = ["https://browser.ohmyho.st", "https://browser.dev.ohmyho.st"] as const;
const STREAM_CHUNK_BYTES = 64 * 1024;
const STREAM_CHUNKS = 64;
const CONSOLE_METHODS = ["debug", "error", "info", "log", "warn"] as const;
/**
 * The relay's own faults, the only refusals it logs. not_enabled and route_denied are the caller's
 * doing, answer through their code and header alone and leave no line: this Worker is shared by
 * every tenant and persists every line, so a tenant must not be able to write them. Workers Logs
 * stores the method and URL of the request next to each line, so a request reaches one of these
 * outcomes only after the route check has passed (see the off-route rows).
 */
const FAULT_OUTCOMES: readonly string[] = [
  "binding_missing",
  "limiter_unavailable",
  "transport_error",
  "redirect_refused",
];
const DEFAULT_ALLOW = [MAIL_GATEWAY_ORIGIN, STORAGE_GATEWAY_ORIGIN, "https://api.example.test"];

type Gateway = "storage" | "mail";
type Transport = Gateway | "network";
type Answer = "ok" | "not-modified" | "redirect" | "redirect-close-fails" | "reject" | "throw";
type HeaderEntries = readonly (readonly [string, string])[];

interface Call {
  readonly url: string;
  readonly method?: string;
  readonly headers?: HeaderEntries;
  readonly body?: "json" | "stream" | "none";
  /** Replaces Request.url: a real Request refuses credentials, the policy still has to. */
  readonly requestUrl?: string;
  readonly project?: string;
  readonly allow?: readonly string[];
  readonly env?: Readonly<Record<string, unknown>>;
  readonly answer?: Answer;
}

type Expectation =
  | { readonly reaches: Transport }
  /** A customer origin that cannot be reached keeps its plain-text 502, which names the origin only. */
  | { readonly unreachable: string }
  | {
      readonly gateway: Gateway;
      readonly status: 403 | 503;
      readonly code: string;
      readonly outcome: string;
      /** The private binding was called and failed; otherwise no transport is touched at all. */
      readonly reached?: Gateway;
    };

type Step = readonly [Call, Expectation];

interface Received {
  readonly bytes: number;
  readonly sha256: string;
}

interface Delivery {
  readonly transport: Transport;
  readonly url: string;
  readonly method: string;
  readonly redirect: string;
  readonly headers: HeaderEntries;
  readonly bodyUsed: boolean;
  readonly produced: number;
  received: Received | null;
}

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const chunk = (index: number): Uint8Array => new Uint8Array(STREAM_CHUNK_BYTES).fill(index % 251);

const byName = (left: readonly [string, string], right: readonly [string, string]): number =>
  left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;

/** A 4 MiB body that produces a chunk only when somebody reads one. */
function streamedBody() {
  const digest = createHash("sha256");
  for (let index = 0; index < STREAM_CHUNKS; index++) digest.update(chunk(index));
  const progress = { produced: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (progress.produced === STREAM_CHUNKS) controller.close();
        else controller.enqueue(chunk(progress.produced++));
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    produced: () => progress.produced,
    sent: { bytes: STREAM_CHUNK_BYTES * STREAM_CHUNKS, sha256: digest.digest("hex") },
  };
}

/** What a transport double learns by reading the body it was handed. */
async function receive(request: Request): Promise<Received> {
  const digest = createHash("sha256");
  let bytes = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      digest.update(next.value);
      bytes += next.value.byteLength;
    }
  }
  return { bytes, sha256: digest.digest("hex") };
}

function build(call: Call) {
  const method = call.method ?? "POST";
  const kind = call.body ?? (method === "GET" ? "none" : "json");
  const headers = new Headers({
    authorization: `Bearer ${CANARY}`,
    "content-type": "application/json",
    "idempotency-key": "same-request",
  });
  for (const [name, value] of call.headers ?? []) headers.append(name, value);
  let body: BodyInit | null = null;
  let sent: Received = { bytes: 0, sha256: sha256("") };
  let produced = () => 0;
  if (kind === "json") {
    body = JSON.stringify({ note: CANARY });
    sent = { bytes: Buffer.byteLength(body), sha256: sha256(body) };
  } else if (kind === "stream") {
    const streamed = streamedBody();
    body = streamed.stream;
    sent = streamed.sent;
    produced = streamed.produced;
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers, body };
  if (kind === "stream") init.duplex = "half";
  const request = new Request(call.url, init);
  if (call.requestUrl !== undefined)
    Object.defineProperty(request, "url", { value: call.requestUrl });
  return { request, headers: [...request.headers] as HeaderEntries, sent, produced };
}

/** The three places a request can end up, each recording what it was handed. */
function createRig() {
  const state = {
    answer: "ok" as Answer,
    produced: () => 0,
    deliveries: [] as Delivery[],
    admitted: [] as string[],
    response: null as Response | null,
    cancels: 0,
  };
  const redirected = (closeFails: boolean) =>
    new Response(
      new ReadableStream({
        cancel() {
          state.cancels++;
          return closeFails
            ? Promise.reject(new Error(`private close failure ${CANARY}`))
            : undefined;
        },
      }),
      { status: 302, headers: { location: `https://private.example.test/${CANARY}` } },
    );
  const answer = async (transport: Transport, request: Request, delivery: Delivery) => {
    delivery.received = await receive(request);
    switch (state.answer) {
      case "reject":
        throw new Error(`private transport failure ${CANARY}`);
      case "not-modified":
        state.response = new Response(null, { status: 304, headers: { etag: '"v1"' } });
        break;
      case "redirect":
      case "redirect-close-fails":
        state.response = redirected(state.answer === "redirect-close-fails");
        break;
      default:
        state.response = Response.json(
          { upstream: transport },
          { status: 202, headers: { "x-upstream": "kept" } },
        );
    }
    return state.response;
  };
  const via =
    (transport: Transport) =>
    (input: Request | string | URL): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input);
      const delivery: Delivery = {
        transport,
        url: request.url,
        method: request.method,
        redirect: request.redirect,
        headers: [...request.headers] as HeaderEntries,
        bodyUsed: request.bodyUsed,
        produced: state.produced(),
        received: null,
      };
      state.deliveries.push(delivery);
      if (state.answer === "throw") throw new Error(`private transport failure ${CANARY}`);
      return answer(transport, request, delivery);
    };
  // On a Workers RPC binding every property of a method, `bind` included, names another remote
  // method (docs/development.md): only a direct call on the binding itself reaches the gateway.
  const binding = (transport: Gateway) => ({
    fetch: new Proxy(via(transport), {
      get: (_target, property) => {
        throw new Error(`env.${transport}.fetch.${String(property)} names another remote method`);
      },
    }),
  });
  return {
    state,
    network: via("network"),
    mail: binding("mail"),
    storage: {
      ...binding("storage"),
      permit: new Proxy(
        async (projectId: string) => {
          state.admitted.push(projectId);
          return true;
        },
        {
          get: (_target, property) => {
            throw new Error(`permit.${String(property)} names another remote method`);
          },
        },
      ),
    },
  };
}

type Rig = ReturnType<typeof createRig>;

function environmentFor(call: Call, rig: Rig): WfpOutboundEnvironment {
  return {
    EGRESS_CONTEXT: {
      version: 1,
      projectId: call.project ?? PROJECT_ID,
      allowedOrigins: [...(call.allow ?? DEFAULT_ALLOW)].sort(),
    },
    MAIL_GATEWAY_ORIGIN,
    STORAGE_GATEWAY_ORIGIN,
    MAIL_GATEWAY: rig.mail,
    STORAGE_GATEWAY: rig.storage,
    ...call.env,
  } as WfpOutboundEnvironment;
}

/** The caller's headers minus every platform header, plus the stamp both gateways read. */
function expectedHeaders(
  transport: Transport,
  sent: HeaderEntries,
  project: string,
): HeaderEntries {
  if (transport === "network") return sent;
  const kept = sent.filter(([name]) => !name.startsWith(EGRESS_HEADER_PREFIX));
  return ([...kept, [PROJECT_HEADER, project] as const] as (readonly [string, string])[]).sort(
    byName,
  );
}

async function runRelayRow(steps: readonly Step[]): Promise<void> {
  const consoles = CONSOLE_METHODS.map(
    (method) => [method, vi.spyOn(console, method).mockImplementation(() => undefined)] as const,
  );
  const rig = createRig();
  const worker = createPolicyOutboundWorker({ fetch: rig.network });
  const expectedLines: unknown[] = [];
  try {
    for (const [call, expectation] of steps) {
      const project = call.project ?? PROJECT_ID;
      const sent = build(call);
      rig.state.answer = call.answer ?? "ok";
      rig.state.produced = sent.produced;
      rig.state.deliveries.length = 0;
      rig.state.response = null;
      rig.state.cancels = 0;
      rig.state.admitted.length = 0;
      const environment = environmentFor(call, rig);
      const response = await worker.fetch(sent.request, environment);
      // Nothing may edit the caller's own request: its headers are immutable on workerd.
      expect([...sent.request.headers]).toEqual(sent.headers);
      if ("reaches" in expectation) {
        if (environment.STORAGE_GATEWAY === rig.storage)
          expect(rig.state.admitted).toEqual(expectation.reaches === "network" ? [] : [project]);
        expect(rig.state.deliveries.map((delivery) => delivery.transport)).toEqual([
          expectation.reaches,
        ]);
        expect(rig.state.deliveries[0]).toEqual({
          transport: expectation.reaches,
          url: sent.request.url,
          method: call.method ?? "POST",
          redirect: "manual",
          headers: expectedHeaders(expectation.reaches, sent.headers, project),
          bodyUsed: false,
          produced: expect.any(Number),
          received: sent.sent,
        });
        // The body is handed on unread: at most a bounded read-ahead of 64 KiB chunks was pulled.
        expect(rig.state.deliveries[0]?.produced).toBeLessThan(STREAM_CHUNKS / 8);
        expect(response).toBe(rig.state.response);
        continue;
      }
      if ("unreachable" in expectation) {
        expect(rig.state.deliveries.map((delivery) => delivery.transport)).toEqual(["network"]);
        expect(response.status).toBe(502);
        expect(Object.fromEntries(response.headers)).toEqual({
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        expect(await response.text()).toBe(
          `Egress upstream unavailable: ${expectation.unreachable} could not be reached. Retrying may help.`,
        );
        continue;
      }
      expect(rig.state.deliveries.map((delivery) => delivery.transport)).toEqual(
        expectation.reached === undefined ? [] : [expectation.reached],
      );
      expect(response.status).toBe(expectation.status);
      expect(Object.fromEntries(response.headers)).toEqual({
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "content-type": "application/json",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-ohmyhost-egress-outcome": expectation.outcome,
      });
      const text = await response.text();
      expect(text).toBe(JSON.stringify({ code: expectation.code }));
      expect(text + JSON.stringify([...response.headers])).not.toContain(CANARY);
      expect(rig.state.cancels).toBe(call.answer?.startsWith("redirect") ? 1 : 0);
      if (FAULT_OUTCOMES.includes(expectation.outcome))
        expectedLines.push({
          event: "egress_gateway_outcome",
          gateway: expectation.gateway,
          outcome: expectation.outcome,
          projectId: project,
        });
    }
    // Fault-only, fixed fields: one warn line per platform fault, none for the two refusals a
    // caller causes itself, nothing for a success and never any other console output.
    const output = consoles.flatMap(([method, spy]) =>
      spy.mock.calls.map((args) => [method, ...args] as const),
    );
    expect(output.map(([method]) => method)).toEqual(expectedLines.map(() => "warn"));
    expect(output.map((entry) => entry.length)).toEqual(expectedLines.map(() => 2));
    expect(output.map(([, line]) => JSON.parse(String(line)))).toEqual(expectedLines);
    expect(JSON.stringify(output)).not.toContain(CANARY);
  } finally {
    for (const [, spy] of consoles) spy.mockRestore();
  }
}

type CallOptions = Omit<Call, "url">;
const storage = (path: string, options: CallOptions = {}): Call => ({
  url: `${STORAGE_GATEWAY_ORIGIN}${path}`,
  ...options,
});
const mail = (path: string, options: CallOptions = {}): Call => ({
  url: `${MAIL_GATEWAY_ORIGIN}${path}`,
  ...options,
});
const external = (url: string, options: CallOptions = {}): Call => ({ url, ...options });

const reaches = (transport: Transport): Expectation => ({ reaches: transport });
const unreachable = (origin: string): Expectation => ({ unreachable: origin });
const refused = (
  gateway: Gateway,
  status: 403 | 503,
  code: string,
  outcome: string,
  reached?: Gateway,
): Expectation =>
  reached === undefined
    ? { gateway, status, code, outcome }
    : { gateway, status, code, outcome, reached };
const notEnabled = (gateway: Gateway) =>
  refused(gateway, 403, "gateway_not_enabled", "not_enabled");
const routeDenied = (gateway: Gateway) =>
  refused(gateway, 403, "gateway_route_denied", "route_denied");
const unbound = (gateway: Gateway) =>
  refused(gateway, 503, `${gateway}_gateway_unavailable`, "origin_unbound");
const noBinding = (gateway: Gateway) =>
  refused(gateway, 503, `${gateway}_gateway_unavailable`, "binding_missing");
const failed = (gateway: Gateway, outcome: "transport_error" | "redirect_refused") =>
  refused(gateway, 503, `${gateway}_gateway_unavailable`, outcome, gateway);

type Row = [string, ...Step[]];

/** Method, path and body kind of storage requests that are not one of the six routes. */
const DENIED_STORAGE_REQUESTS: readonly (readonly [string, string, "json" | "none"])[] = [
  ["GET", "/v1/uploads", "none"],
  ["PUT", "/v1/uploads", "json"],
  ["POST", "/", "json"],
  ["POST", "/v1/unknown", "json"],
  ["POST", `/v1/uploads/${CANARY}`, "json"],
  ["POST", "//v1/uploads", "json"],
  ["POST", "/v1/uploads/", "json"],
  ["POST", "/v1/uploads/complete/", "json"],
  ["POST", "/v1/Uploads", "json"],
  ["POST", "/v1/%75ploads", "json"],
  ["POST", "/v1/uploads%2fcomplete", "json"],
  ["POST", "/v1/uploads;x=1", "json"],
  ["POST", `/v1/uploads?token=${CANARY}`, "json"],
  ["POST", "/v1/uploads?x=1", "json"],
  ["POST", "/v1/uploads#h", "json"],
  ["POST", "/v1/send", "json"],
];

/** What a storage origin variable may wrongly hold, with a description of each. */
const WRONG_STORAGE_ORIGIN_VALUES: readonly (readonly [string, unknown])[] = [
  ["unset", undefined],
  ["not an origin", "not an origin"],
  ["plain http", "http://ohmyho-storage-gateway-production.your-omh-account.workers.dev"],
  ["not a string", 42],
  ["another origin", "https://other.example.test"],
];

/**
 * Requests to a decoy gateway-shaped origin that miss the fixed routes, with the canary where a
 * caller can put text. Workers Logs stores the method and URL of the request next to every line the
 * relay writes, so each of them must be refused as route_denied, which writes no line, even though
 * the origin is not the bound one: no query, credential or fragment of a caller can reach a stored
 * line. Credentials replace Request.url, because a real Request refuses them.
 */
const OFF_ROUTE_REQUESTS: readonly (readonly [string, Call])[] = [
  ["a query string", { url: `${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads?leak=${CANARY}` }],
  ["an unknown path", { url: `${DEV_STORAGE_GATEWAY_ORIGIN}/v1/unknown/${CANARY}` }],
  ["the method GET", { url: `${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads`, method: "GET" }],
  ["a fragment", { url: `${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads#${CANARY}` }],
  [
    "credentials",
    {
      url: `${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads`,
      requestUrl: `${DEV_STORAGE_GATEWAY_ORIGIN.replace("https://", `https://user:${CANARY}@`)}/v1/uploads`,
    },
  ],
];

const RELAY_ROWS: readonly Row[] = [
  ...STORAGE_ROUTES.map(
    (path): Row => [
      `pinned storage POST ${path} preserves its origin and receives the trusted project`,
      [
        external(`${PINNED_STORAGE_GATEWAY_ORIGIN}${path}`, {
          allow: [PINNED_STORAGE_GATEWAY_ORIGIN],
        }),
        reaches("storage"),
      ],
    ],
  ),
  ...[
    `https://extra.${new URL(PINNED_STORAGE_GATEWAY_ORIGIN).hostname}`,
    `https://s1-bad.bad.${new URL(STORAGE_GATEWAY_ORIGIN).hostname}`,
    PINNED_STORAGE_GATEWAY_ORIGIN.replace("s1-", "s2-"),
    PINNED_STORAGE_GATEWAY_ORIGIN.replace(
      new URL(STORAGE_GATEWAY_ORIGIN).hostname,
      new URL(DEV_STORAGE_GATEWAY_ORIGIN).hostname,
    ),
  ].map(
    (origin): Row => [
      `an allowed malformed or foreign pinned storage origin stays private: ${origin}`,
      [external(`${origin}/v1/uploads`, { allow: [origin] }), routeDenied("storage")],
    ],
  ),
  [
    "a valid pin absent from the exact allowlist is not enabled",
    [external(`${PINNED_STORAGE_GATEWAY_ORIGIN}/v1/uploads`), notEnabled("storage")],
  ],
  // The six fixed storage routes reach the private entrypoint, with the project stamped on.
  ...STORAGE_ROUTES.map(
    (path): Row => [
      `storage POST ${path} reaches the entrypoint`,
      [storage(path), reaches("storage")],
    ],
  ),
  // A caller can neither forge nor duplicate nor blank the project the entrypoint reads.
  [
    "a forged project header of another project is replaced",
    [storage("/v1/uploads", { headers: [[PROJECT_HEADER, OTHER_PROJECT_ID]] }), reaches("storage")],
  ],
  [
    "a forged project header in mixed case is replaced",
    [
      storage("/v1/downloads", { headers: [["X-OhMyHost-Egress-Project-Id", OTHER_PROJECT_ID]] }),
      reaches("storage"),
    ],
  ],
  [
    "a project header duplicated under two spellings becomes one",
    [
      storage("/v1/deletions", {
        headers: [
          [PROJECT_HEADER, OTHER_PROJECT_ID],
          ["X-OHMYHOST-EGRESS-PROJECT-ID", PROJECT_ID],
        ],
      }),
      reaches("storage"),
    ],
  ],
  [
    "an empty project header is replaced",
    [storage("/v1/uploads/complete", { headers: [[PROJECT_HEADER, ""]] }), reaches("storage")],
  ],
  [
    "every other platform header of the caller is removed",
    [
      storage("/v1/uploads", {
        headers: [
          ["x-ohmyhost-egress-outcome", "not_enabled"],
          ["x-ohmyhost-egress-extra", "1"],
        ],
      }),
      reaches("storage"),
    ],
  ],
  [
    "the development storage gateway of a project follows the same family",
    [
      external(`${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads`, {
        allow: [DEV_STORAGE_GATEWAY_ORIGIN],
        env: { STORAGE_GATEWAY_ORIGIN: DEV_STORAGE_GATEWAY_ORIGIN },
      }),
      reaches("storage"),
    ],
  ],
  // Both fixed mail routes receive only the dispatcher-set project header.
  [
    "mail POST /v1/send receives the trusted project over forged platform headers",
    [
      mail("/v1/send", {
        headers: [
          [PROJECT_HEADER, OTHER_PROJECT_ID],
          ["x-ohmyhost-egress-anything", "1"],
        ],
      }),
      reaches("mail"),
    ],
  ],
  [
    "mail attachment download POST receives the same trusted project",
    [
      mail("/v1/attachments/download", {
        headers: [
          [PROJECT_HEADER, OTHER_PROJECT_ID],
          ["x-ohmyhost-egress-extra", "forged"],
        ],
      }),
      reaches("mail"),
    ],
  ],
  [
    "mail attachment GET is denied",
    [mail("/v1/attachments/download", { method: "GET" }), routeDenied("mail")],
  ],
  [
    "mail attachment query is denied",
    [mail(`/v1/attachments/download?secret=${CANARY}`), routeDenied("mail")],
  ],
  [
    "mail attachment redirect is refused",
    [mail("/v1/attachments/download", { answer: "redirect" }), failed("mail", "redirect_refused")],
  ],
  [
    "mail uses storage admission without storage HTTP configuration",
    [
      mail("/v1/send", {
        env: { STORAGE_GATEWAY_ORIGIN: undefined, STORAGE_GATEWAY: { permit: async () => true } },
      }),
      reaches("mail"),
    ],
  ],
  [
    "storage works without any mail configuration",
    [
      storage("/v1/uploads", { env: { MAIL_GATEWAY_ORIGIN: undefined, MAIL_GATEWAY: undefined } }),
      reaches("storage"),
    ],
  ],
  // Whatever the gateway answers is returned as it is, and a 304 is no redirect.
  [
    "a storage 304 passes through",
    [storage("/v1/downloads", { answer: "not-modified" }), reaches("storage")],
  ],
  ["a mail 304 passes through", [mail("/v1/send", { answer: "not-modified" }), reaches("mail")]],
  // Bodies are never read, cloned or buffered, and exactly one Request is built per branch.
  [
    "a 4 MiB storage body arrives intact and unread",
    [storage("/v1/uploads", { body: "stream" }), reaches("storage")],
  ],
  [
    "a 4 MiB body to a customer origin arrives intact and unread",
    [external("https://api.example.test/v1/import", { body: "stream" }), reaches("network")],
  ],
  // Host spelling and the default port do not change which origin is meant.
  [
    "an upper-case host is the same origin",
    [
      external(`HTTPS://OHMYHO-STORAGE-GATEWAY-PRODUCTION.your-omh-account.WORKERS.DEV/v1/uploads`),
      reaches("storage"),
    ],
  ],
  [
    "the default port is the same origin",
    [external(`${STORAGE_GATEWAY_ORIGIN}:443/v1/uploads`), reaches("storage")],
  ],
  [
    "dot segments are resolved before the route is judged and forwarded as resolved",
    [storage("/v1/deletions/../uploads"), reaches("storage")],
  ],
  // Routes: one method, one exact path, nothing else.
  ...DENIED_STORAGE_REQUESTS.map(
    ([method, path, body]): Row => [
      `storage ${method} ${path} is denied`,
      [storage(path, { method, body }), routeDenied("storage")],
    ],
  ),
  [
    "storage with credentials in the URL is denied",
    [
      storage("/v1/uploads", {
        requestUrl:
          "https://user:pw@ohmyho-storage-gateway-production.your-omh-account.workers.dev/v1/uploads",
      }),
      routeDenied("storage"),
    ],
  ],
  ["mail GET /v1/send is denied", [mail("/v1/send", { method: "GET" }), routeDenied("mail")]],
  ["mail /v1/send with a query is denied", [mail(`/v1/send?other=${CANARY}`), routeDenied("mail")]],
  ["mail /other is denied", [mail("/other"), routeDenied("mail")]],
  ["mail has no storage route", [mail("/v1/uploads"), routeDenied("mail")]],
  // The route is judged right after the capability and before the origin and the binding, so a
  // request that is not a fixed route is route_denied (no line) whatever else is wrong.
  ...OFF_ROUTE_REQUESTS.map(
    ([what, call]): Row => [
      `a decoy gateway-shaped storage origin with ${what} is route_denied, not origin_unbound`,
      [{ ...call, allow: [DEV_STORAGE_GATEWAY_ORIGIN] }, routeDenied("storage")],
    ],
  ),
  [
    "a decoy gateway-shaped mail origin with a query string is route_denied, not origin_unbound",
    [
      external(`${DEV_MAIL_GATEWAY_ORIGIN}/v1/send?leak=${CANARY}`, {
        allow: [DEV_MAIL_GATEWAY_ORIGIN],
      }),
      routeDenied("mail"),
    ],
  ],
  [
    "an unset storage origin variable with a query string is route_denied, not origin_unbound",
    [
      storage(`/v1/uploads?leak=${CANARY}`, { env: { STORAGE_GATEWAY_ORIGIN: undefined } }),
      routeDenied("storage"),
    ],
  ],
  [
    "a missing storage binding with an unknown path is route_denied, not binding_missing",
    [
      storage(`/v1/unknown/${CANARY}`, { env: { STORAGE_GATEWAY: undefined } }),
      routeDenied("storage"),
    ],
  ],
  [
    "a storage binding without fetch and a query string is route_denied, not binding_missing",
    [
      storage(`/v1/uploads?leak=${CANARY}`, { env: { STORAGE_GATEWAY: {} } }),
      routeDenied("storage"),
    ],
  ],
  [
    "a missing mail binding with the method GET is route_denied, not binding_missing",
    [mail("/v1/send", { method: "GET", env: { MAIL_GATEWAY: undefined } }), routeDenied("mail")],
  ],
  // A gateway that is down answers in the gateway's own vocabulary and never falls back.
  [
    "a storage binding that rejects",
    [storage("/v1/uploads", { answer: "reject" }), failed("storage", "transport_error")],
  ],
  [
    "a storage binding that throws",
    [storage("/v1/uploads", { answer: "throw" }), failed("storage", "transport_error")],
  ],
  [
    "a mail binding that rejects",
    [mail("/v1/send", { answer: "reject" }), failed("mail", "transport_error")],
  ],
  [
    "a mail binding that throws",
    [mail("/v1/send", { answer: "throw" }), failed("mail", "transport_error")],
  ],
  [
    "a storage redirect is cancelled and refused",
    [storage("/v1/downloads", { answer: "redirect" }), failed("storage", "redirect_refused")],
  ],
  [
    "a mail redirect is cancelled and refused",
    [mail("/v1/send", { answer: "redirect" }), failed("mail", "redirect_refused")],
  ],
  [
    "a redirect whose body cannot be cancelled is still refused",
    [
      storage("/v1/deletions", { answer: "redirect-close-fails" }),
      failed("storage", "redirect_refused"),
    ],
  ],
  [
    "a storage binding that is missing",
    [
      storage("/v1/uploads", { env: { STORAGE_GATEWAY: undefined } }),
      refused("storage", 503, "storage_gateway_unavailable", "limiter_unavailable"),
    ],
  ],
  [
    "a storage binding without fetch",
    [
      storage("/v1/uploads", { env: { STORAGE_GATEWAY: { permit: async () => true } } }),
      noBinding("storage"),
    ],
  ],
  [
    "a mail binding that is missing",
    [mail("/v1/send", { env: { MAIL_GATEWAY: undefined } }), noBinding("mail")],
  ],
  // A project that did not get the capability is told so, in the gateway's vocabulary.
  [
    "storage origin not in the project's allow-list",
    [storage("/v1/uploads", { allow: [] }), notEnabled("storage")],
  ],
  [
    "mail origin not in the project's allow-list",
    [mail("/v1/send", { allow: [] }), notEnabled("mail")],
  ],
  [
    "a route is not judged before the capability",
    [storage("/v1/unknown", { method: "GET", allow: [] }), notEnabled("storage")],
  ],
  [
    "the plain-http gateway origin is not enabled",
    [
      external(`http://ohmyho-storage-gateway-production.your-omh-account.workers.dev/v1/uploads`),
      notEnabled("storage"),
    ],
  ],
  [
    "another environment's gateway is not enabled",
    [external(`${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads`), notEnabled("storage")],
  ],
  // The gateway family never reaches a public fetch, whatever is wrong with the configuration.
  [
    "another namespace's gateway that is allowed is not the bound one",
    [
      external(`${DEV_STORAGE_GATEWAY_ORIGIN}/v1/uploads`, { allow: [DEV_STORAGE_GATEWAY_ORIGIN] }),
      routeDenied("storage"),
    ],
  ],
  [
    "another subdomain's gateway that is allowed is not the bound one",
    [
      external("https://ohmyho-storage-gateway-production.other.workers.dev/v1/uploads", {
        allow: ["https://ohmyho-storage-gateway-production.other.workers.dev"],
      }),
      routeDenied("storage"),
    ],
  ],
  // A grant with a trailing dot or a port is no canonical origin, so the grant is the bound origin itself.
  [
    "a trailing dot is not the bound origin",
    [
      external(`${STORAGE_GATEWAY_ORIGIN}./v1/uploads`, { allow: [STORAGE_GATEWAY_ORIGIN] }),
      refused("storage", 403, "gateway_not_enabled", "not_enabled"),
    ],
  ],
  [
    "another port is not the bound origin",
    [
      external(`${STORAGE_GATEWAY_ORIGIN}:8443/v1/uploads`, { allow: [STORAGE_GATEWAY_ORIGIN] }),
      refused("storage", 403, "gateway_not_enabled", "not_enabled"),
    ],
  ],
  ...WRONG_STORAGE_ORIGIN_VALUES.map(
    ([label, value]): Row => [
      `a storage origin variable that is ${label}`,
      [storage("/v1/uploads", { env: { STORAGE_GATEWAY_ORIGIN: value } }), unbound("storage")],
    ],
  ),
  [
    "a mail origin variable that is unset",
    [mail("/v1/send", { env: { MAIL_GATEWAY_ORIGIN: undefined } }), unbound("mail")],
  ],
  [
    "a mail origin variable that names another origin",
    [
      mail("/v1/send", { env: { MAIL_GATEWAY_ORIGIN: STORAGE_GATEWAY_ORIGIN } }),
      routeDenied("mail"),
    ],
  ],
  // Everything that is not one of the two gateways keeps its behaviour.
  [
    "an unrelated allowed origin needs no gateway configuration",
    [
      external("https://api.example.test/v1/messages?limit=1", {
        method: "GET",
        env: {
          MAIL_GATEWAY_ORIGIN: undefined,
          MAIL_GATEWAY: undefined,
          STORAGE_GATEWAY_ORIGIN: undefined,
          STORAGE_GATEWAY: undefined,
        },
      }),
      reaches("network"),
    ],
  ],
  [
    "an invalid mail origin variable no longer stops unrelated egress",
    [
      external("https://api.example.test/v1/messages", { env: { MAIL_GATEWAY_ORIGIN: "nope" } }),
      reaches("network"),
    ],
  ],
  [
    "the signed R2 origin is an ordinary allowed origin",
    [
      external(
        "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com/bucket/object?X-Amz-Signature=abc",
        {
          method: "PUT",
          allow: ["https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com"],
        },
      ),
      reaches("network"),
    ],
  ],
  [
    "a customer origin that cannot be reached keeps its plain-text answer",
    [
      external("https://api.example.test/v1/messages", { answer: "reject" }),
      unreachable("https://api.example.test"),
    ],
  ],
  [
    "a customer origin whose transport throws keeps its plain-text answer",
    [
      external("https://api.example.test/v1/messages", { answer: "throw" }),
      unreachable("https://api.example.test"),
    ],
  ],
  [
    "a lookalike under another domain is an ordinary customer origin",
    [
      external(`${STORAGE_GATEWAY_ORIGIN}.evil.example/v1/uploads`, {
        allow: [`${STORAGE_GATEWAY_ORIGIN}.evil.example`],
      }),
      reaches("network"),
    ],
  ],
  [
    "a lookalike with a prefix is an ordinary customer origin",
    [
      external(
        "https://evil-ohmyho-storage-gateway-production.your-omh-account.workers.dev/v1/uploads",
        {
          allow: ["https://evil-ohmyho-storage-gateway-production.your-omh-account.workers.dev"],
        },
      ),
      reaches("network"),
    ],
  ],
  // One Worker instance serves every project: no invocation sees another's identity.
  [
    "two projects on one Worker never share a project",
    [storage("/v1/uploads", { project: PROJECT_ID }), reaches("storage")],
    [storage("/v1/uploads", { project: OTHER_PROJECT_ID }), reaches("storage")],
    [storage("/v1/other", { project: PROJECT_ID }), routeDenied("storage")],
    [mail("/v1/other", { project: OTHER_PROJECT_ID }), routeDenied("mail")],
    [storage("/v1/uploads", { project: PROJECT_ID, allow: [] }), notEnabled("storage")],
  ],
];

interface WranglerConfig {
  readonly name?: string;
  readonly main?: string;
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly routes?: unknown;
  readonly compatibility_flags?: unknown;
  readonly vars?: Readonly<Record<string, string>>;
  readonly services?: readonly unknown[];
  readonly dispatch_namespaces?: readonly unknown[];
  readonly observability?: unknown;
}

/** The same reading as the release tooling: whole-line comments and trailing commas are allowed. */
const stripJsonc = (source: string): string =>
  source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1");

async function readWranglerConfig(path: string): Promise<WranglerConfig> {
  return JSON.parse(stripJsonc(await readFile(path, "utf8"))) as WranglerConfig;
}

/** The names a module exports by declaration or in an `export { ... }` list, renames resolved. */
function exportedNames(source: string): string[] {
  const names = [
    ...source.matchAll(/\bexport\s+(?:abstract\s+)?(?:class|const|function)\s+(\w+)/gu),
  ];
  const lists = [...source.matchAll(/\bexport\s*\{([^}]*)\}/gu)];
  return [
    ...names.map((match) => match[1] ?? ""),
    ...lists.flatMap((match) =>
      (match[1] ?? "").split(",").map(
        (entry) =>
          entry
            .trim()
            .split(/\s+as\s+/u)
            .at(-1) ?? "",
      ),
    ),
  ];
}

/** Every Worker configuration under apps/ that binds the storage gateway's egress entrypoint. */
async function configurationsBindingTheEgressEntrypoint(): Promise<string[]> {
  const found: string[] = [];
  for (const app of await readdir(resolve(REPOSITORY, "apps"), { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    for (const file of await readdir(resolve(REPOSITORY, "apps", app.name))) {
      if (!/^wrangler(?:\.[\w-]+)*\.jsonc?$/u.test(file)) continue;
      const source = stripJsonc(
        await readFile(resolve(REPOSITORY, "apps", app.name, file), "utf8"),
      );
      if (/"entrypoint"\s*:\s*"Storage(?:Egress|GatewayRelay)Entrypoint"/u.test(source))
        found.push(`apps/${app.name}/${file}`);
    }
  }
  return found.sort();
}

describe("WFP policy outbound Worker", () => {
  it.each([
    [
      "wrangler.outbound.jsonc",
      "poc-private-fullstack",
      "wrangler.development.jsonc",
      "ohmyho-wfp-egress-v3-poc-private-fullstack",
    ],
    [
      "wrangler.production.outbound.jsonc",
      "production",
      "wrangler.production.jsonc",
      "ohmyho-wfp-egress-production",
    ],
  ])(
    "keeps %s private, bound to its matching gateways and logging failures only",
    async (filename, namespace, managementFilename, retainedOutboundService) => {
      const config = await readWranglerConfig(resolve(import.meta.dirname, "..", filename));
      expect(config).toMatchObject({
        name: retainedOutboundService,
        main: "src/outbound-main.ts",
        workers_dev: false,
        preview_urls: false,
      });
      const sharedSource = await readFile(
        resolve(
          import.meta.dirname,
          "..",
          namespace === "production" ? "wrangler.production.shared.jsonc" : "wrangler.shared.jsonc",
        ),
        "utf8",
      );
      const shared = JSON.parse(sharedSource.replace(/,\s*([}\]])/gu, "$1"));
      // Auth keeps each environment's existing external target; it does not deploy this profile.
      expect(shared.dispatch_namespaces).toEqual([
        {
          binding: "DISPATCHER",
          namespace: `ohmyho-${namespace}`,
          outbound: { service: retainedOutboundService, parameters: ["EGRESS_CONTEXT"] },
        },
      ]);
      const scheduler = await readWranglerConfig(
        resolve(REPOSITORY, "apps", "functions-scheduler", managementFilename),
      );
      expect(scheduler.dispatch_namespaces).toEqual([
        {
          binding: "CUSTOMER_DISPATCH",
          namespace: `ohmyho-${namespace}`,
          outbound: { service: retainedOutboundService, parameters: ["EGRESS_CONTEXT"] },
        },
      ]);
      expect(config.routes).toBeUndefined();
      expect(config.compatibility_flags).toBeUndefined();
      expect(config.services).toEqual([
        {
          binding: "MAIL_GATEWAY",
          service: `ohmyho-mail-gateway-${namespace}`,
          entrypoint: "MailEgressEntrypoint",
        },
        {
          binding: "STORAGE_GATEWAY",
          service: `ohmyho-storage-gateway-${namespace}`,
          entrypoint: "StorageGatewayRelayEntrypoint",
        },
      ]);
      // The origins are the ones wfp-management derives (apps/wfp-management/src/bindings.ts) from its
      // own dispatch namespace and workers.dev subdomain: a typo here would silently disable the relay.
      const management = await readWranglerConfig(
        resolve(REPOSITORY, "apps", "wfp-management", managementFilename),
      );
      expect(management.vars?.["WFP_DISPATCH_NAMESPACE"]).toBe(`ohmyho-${namespace}`);
      const subdomain = management.vars?.["WFP_WORKERS_DEV_SUBDOMAIN"];
      expect(config.vars).toEqual({
        MAIL_GATEWAY_ORIGIN: `https://ohmyho-mail-gateway-${namespace}.${subdomain}.workers.dev`,
        STORAGE_GATEWAY_ORIGIN: `https://ohmyho-storage-gateway-${namespace}.${subdomain}.workers.dev`,
      });
      // Only failure lines are persisted: invocation logs and traces would retain the URL of every
      // customer fetch. Workers Logs adds the method and URL of the request to each stored line as
      // well, which is why the relay judges the route before the origin (see the off-route rows).
      expect(config.observability).toEqual({
        enabled: true,
        head_sampling_rate: 1,
        logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false },
        traces: { enabled: false },
      });
      // Only the two egress Workers and the trusted preview secret-delivery profiles may bind it.
      expect(await configurationsBindingTheEgressEntrypoint()).toEqual([
        "apps/runtime-secret-delivery/wrangler.development.jsonc",
        "apps/runtime-secret-delivery/wrangler.production.jsonc",
        "apps/wfp-dispatch/wrangler.outbound.jsonc",
        "apps/wfp-dispatch/wrangler.production.outbound.jsonc",
      ]);
      expect(
        exportedNames(
          await readFile(resolve(REPOSITORY, "apps/storage-gateway/src/worker-main.ts"), "utf8"),
        ),
      ).toContain("StorageEgressEntrypoint");
      expect(
        exportedNames(
          await readFile(resolve(REPOSITORY, "apps/storage-gateway/src/worker-main.ts"), "utf8"),
        ),
      ).toContain("StorageGatewayRelayEntrypoint");
    },
  );

  it("blocks retired Neon hosts despite historical grants without logging the request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("ok"));
    const audit = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const worker = createPolicyOutboundWorker({ fetch });
      for (const host of [
        "neon.tech",
        "console.neon.tech",
        "ep-old.us-east-2.aws.neon.tech",
        "neon.com",
        "api.neon.com",
        "NEON.TECH.",
      ]) {
        const url = new URL(`https://${host}/sql?password=private-canary`);
        // A trailing-dot host cannot be a grant, so its grant is the canonical origin; retirement decides on the host.
        const grant = `https://${host.toLowerCase().replace(/\.+$/u, "")}`;
        const response = await worker.fetch(new Request(url), {
          EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [grant] },
          MAIL_GATEWAY_ORIGIN,
        });
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("Egress denied: this database provider is unavailable.");
      }
      expect(fetch).not.toHaveBeenCalled();
      // The refusal is the 403 alone: a log line would carry the customer's request URL.
      expect(audit).not.toHaveBeenCalled();
      for (const origin of [
        "https://api.example.test",
        "https://neon.tech.impostor.test",
        "https://notneon.com",
        "https://neon.com.example.test",
      ]) {
        expect(
          (
            await worker.fetch(new Request(`${origin}/allowed`), {
              EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [origin] },
              MAIL_GATEWAY_ORIGIN,
            })
          ).status,
        ).toBe(200);
      }
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(
        (
          await worker.fetch(new Request("https://api.example.test/"), {
            EGRESS_CONTEXT: {
              version: 1,
              projectId: PROJECT_ID,
              allowedOrigins: ["https://another.example.test"],
            },
            MAIL_GATEWAY_ORIGIN,
          })
        ).status,
      ).toBe(403);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      audit.mockRestore();
    }
  });

  it("blocks every HTTPS egress request without forwarding or leaking its target", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const secretTarget = "https://private.example.test/token?secret=canary";
    const response = await outboundWorker.fetch(new Request(secretTarget), {
      EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [] },
    });

    expect(response.status).toBe(403);
    // Only the origin is named, never the path or query that may carry a secret.
    expect(await response.text()).toBe(
      "Egress denied: https://private.example.test is not listed in runtime.egress.allow in ohmyhost.yaml. Add that exact HTTPS origin, commit and deploy; a retry fails again.",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify([...response.headers])).not.toContain(secretTarget);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it("forwards only an exact allowed HTTPS origin with redirects disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe("https://api.example.test/v1/messages?limit=1");
      expect(request.redirect).toBe("manual");
      // No shared cache partition: a tenant's cacheable response is never served to another tenant.
      expect(request.cache).toBe("no-store");
      return new Response("ok", { status: 200, headers: { "x-upstream": "kept" } });
    });
    const response = await createPolicyOutboundWorker({ fetch }).fetch(
      new Request("https://api.example.test/v1/messages?limit=1", {
        headers: { authorization: "Bearer runtime-secret" },
      }),
      {
        MAIL_GATEWAY_ORIGIN,
        EGRESS_CONTEXT: {
          version: 1,
          projectId: PROJECT_ID,
          allowedOrigins: ["https://api.example.test"],
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-upstream")).toBe("kept");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("passes a conditional request's 304 through with its validator", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.headers.get("if-none-match")).toBe('"v1"');
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    });
    const response = await createPolicyOutboundWorker({ fetch }).fetch(
      new Request("https://api.example.test/v1/items", { headers: { "if-none-match": '"v1"' } }),
      {
        MAIL_GATEWAY_ORIGIN,
        EGRESS_CONTEXT: {
          version: 1,
          projectId: PROJECT_ID,
          allowedOrigins: ["https://api.example.test"],
        },
      },
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"v1"');
  });

  it("does not follow or expose an allowed upstream redirect", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => {
      const stream = new ReadableStream({ cancel });
      return new Response(stream, {
        status: 302,
        headers: { location: "https://private.example.test/token?secret=canary" },
      });
    });
    const response = await createPolicyOutboundWorker({ fetch }).fetch(
      new Request("https://api.example.test/redirect"),
      {
        MAIL_GATEWAY_ORIGIN,
        EGRESS_CONTEXT: {
          version: 1,
          projectId: PROJECT_ID,
          allowedOrigins: ["https://api.example.test"],
        },
      },
    );

    expect(response.status).toBe(502);
    // The redirect target is named only by its origin: its path and query stay private.
    expect(await response.text()).toBe(
      "Egress upstream unavailable: https://api.example.test answered 302 redirecting to https://private.example.test; ohmyho.st follows no redirect. Call the final URL directly and list its origin in runtime.egress.allow.",
    );
    expect(JSON.stringify([...response.headers])).not.toContain("private.example.test");
    expect(cancel).toHaveBeenCalledOnce();
    // A missing or relative Location names no other origin.
    for (const [status, headers] of [
      [307, { location: "/token?secret=canary" }],
      [301, {}],
    ] as const) {
      fetch.mockResolvedValueOnce(new Response(null, { status, headers }));
      const redirect = await createPolicyOutboundWorker({ fetch }).fetch(
        new Request("https://api.example.test/redirect"),
        {
          MAIL_GATEWAY_ORIGIN,
          EGRESS_CONTEXT: {
            version: 1,
            projectId: PROJECT_ID,
            allowedOrigins: ["https://api.example.test"],
          },
        },
      );
      expect([redirect.status, await redirect.text()]).toEqual([
        502,
        `Egress upstream unavailable: https://api.example.test answered ${status}; ohmyho.st follows no redirect. Call the final URL directly and list its origin in runtime.egress.allow.`,
      ]);
    }
  });

  it("keeps an upstream redirect private even when cancelling its body fails", async () => {
    const requests: string[] = [];
    let cancellations = 0;
    const transport = {
      async fetch(input: string | URL | Request): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request.url);
        expect(request.redirect).toBe("manual");
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations++;
              return Promise.reject(new Error("private-upstream-close-failure"));
            },
          }),
          {
            status: 302,
            headers: { location: "https://private.example.test/token?secret=canary" },
          },
        );
      },
    };
    const response = await createPolicyOutboundWorker({
      fetch: transport.fetch.bind(transport),
    }).fetch(new Request("https://api.example.test/redirect"), {
      MAIL_GATEWAY_ORIGIN,
      EGRESS_CONTEXT: {
        version: 1,
        projectId: PROJECT_ID,
        allowedOrigins: ["https://api.example.test"],
      },
    });
    expect(requests).toEqual(["https://api.example.test/redirect"]);
    expect(cancellations).toBe(1);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Egress upstream unavailable: https://api.example.test answered 302 redirecting to https://private.example.test; ohmyho.st follows no redirect. Call the final URL directly and list its origin in runtime.egress.allow.",
    );
    expect(response.headers.get("location")).toBeNull();
    expect(JSON.stringify([...response.headers])).not.toContain("private-upstream");
  });

  it.each(BROWSER_ORIGINS)(
    "ends a slow upload to %s at the 30-second client deadline, on this Worker's own clock",
    async (origin) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let forwarded: Request | undefined;
        // Like the runtime's fetch: it settles only when its signal aborts, however slowly the body arrives.
        const fetch = vi.fn<typeof globalThis.fetch>(
          (input) =>
            new Promise((_, reject) => {
              forwarded = input as Request;
              forwarded.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        );
        const upload = new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"html":"')),
        });
        const answer = createPolicyOutboundWorker({ fetch }).fetch(
          new Request(`${origin}/v1/pdf`, {
            method: "POST",
            body: upload,
            duplex: "half",
          } as RequestInit),
          { EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [origin] } },
        );
        await vi.advanceTimersByTimeAsync(29_999);
        expect(forwarded?.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const response = await answer;
        expect(response.status).toBe(504);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ error: { code: "browser_timeout" } });
        expect(forwarded?.signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("leaves a prompt Browser answer and every other origin without an outbound deadline", async () => {
    // This Worker does not depend on the platform package: its copies of the gateway's origins and
    // fixed deadline must keep matching the source that defines them.
    const platform = await readFile(
      resolve(REPOSITORY, "packages/platform/src/shared/browser-gateway.ts"),
      "utf8",
    );
    expect(platform).toContain("BROWSER_MAX_MS = 30_000;");
    for (const [name, origin] of [
      ["PRODUCTION", BROWSER_ORIGINS[0]],
      ["DEVELOPMENT", BROWSER_ORIGINS[1]],
    ])
      expect(platform).toContain(`BROWSER_GATEWAY_ORIGIN_${name} = "${origin}";`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        signals.push((input as Request).signal);
        return new Response("ok");
      });
      for (const origin of [BROWSER_ORIGINS[0], "https://api.example.test"]) {
        const response = await createPolicyOutboundWorker({ fetch }).fetch(
          new Request(`${origin}/v1/pdf`, { method: "POST", body: "{}" }),
          { EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [origin] } },
        );
        expect(response.status).toBe(200);
      }
      // The answered Browser call leaves no timer behind; the other origin never had one.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies a sibling origin before forwarding", async () => {
    const fetch = vi.fn();
    const response = await createPolicyOutboundWorker({ fetch }).fetch(
      new Request("https://sub.api.example.test/v1/messages"),
      {
        EGRESS_CONTEXT: {
          version: 1,
          projectId: PROJECT_ID,
          allowedOrigins: ["https://api.example.test"],
        },
      },
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(RELAY_ROWS)(
    "relays the platform gateways privately on fixed routes and fails closed: %s",
    async (_name, ...steps) => {
      await runRelayRow(steps);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { version: 2, projectId: PROJECT_ID },
    { version: 1, projectId: "not-a-project", allowedOrigins: [] },
    { version: 1, projectId: PROJECT_ID },
    { version: 1, projectId: PROJECT_ID, allowedOrigins: ["http://api.example.test"] },
    { version: 1, projectId: PROJECT_ID, allowedOrigins: ["https://127.0.0.1"] },
    { version: 1, projectId: PROJECT_ID, allowedOrigins: ["https://intranet"] },
    { version: 1, projectId: PROJECT_ID, allowedOrigins: ["https://api.example.test:8443"] },
    { version: 1, projectId: PROJECT_ID, allowedOrigins: ["https://my_api.example.test"] },
    {
      version: 1,
      projectId: PROJECT_ID,
      allowedOrigins: ["https://b.example.test", "https://a.example.test"],
    },
  ])("fails closed for malformed dispatch context %#", async (EGRESS_CONTEXT) => {
    const response = await createPolicyOutboundWorker({ fetch: vi.fn() }).fetch(
      new Request("https://example.test"),
      { EGRESS_CONTEXT },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Egress policy unavailable");
  });
});

describe("project gateway admission", () => {
  it("limits both gateways together through the storage RPC before touching a body or gateway", async () => {
    // Native bindings belong to the standard storage Worker, not the dispatch outbound Worker.
    for (const [egressFile, storageFile, namespace] of [
      ["wrangler.outbound.jsonc", "wrangler.development.jsonc", "2101"],
      ["wrangler.production.outbound.jsonc", "wrangler.production.jsonc", "2102"],
    ] as const) {
      const egress = await readWranglerConfig(resolve(REPOSITORY, "apps/wfp-dispatch", egressFile));
      const storage = await readWranglerConfig(
        resolve(REPOSITORY, "apps/storage-gateway", storageFile),
      );
      expect(egress).not.toHaveProperty("ratelimits");
      expect(storage).toHaveProperty("ratelimits", [
        {
          name: "GATEWAY_RATE_LIMITER",
          namespace_id: namespace,
          simple: { limit: 1200, period: 60 },
        },
        {
          name: "STORAGE_SCOPE_LOG_LIMITER",
          namespace_id: namespace === "2101" ? "2103" : "2104",
          simple: { limit: 1, period: 60 },
        },
      ]);
    }
    const calls: string[] = [];
    const fetch = vi.fn(async () => new Response("ok"));
    const permit = vi.fn(async (projectId: string) => {
      calls.push(projectId);
      return calls.filter((seen) => seen === projectId).length <= 2;
    });
    const env = {
      EGRESS_CONTEXT: {
        version: 1,
        projectId: PROJECT_ID,
        allowedOrigins: [...DEFAULT_ALLOW].sort(),
      },
      MAIL_GATEWAY_ORIGIN,
      STORAGE_GATEWAY_ORIGIN,
      MAIL_GATEWAY: { fetch },
      STORAGE_GATEWAY: { fetch, permit },
    };
    const worker = createPolicyOutboundWorker();
    for (const origin of [MAIL_GATEWAY_ORIGIN, STORAGE_GATEWAY_ORIGIN]) {
      const path = origin === MAIL_GATEWAY_ORIGIN ? "/v1/send" : "/v1/uploads";
      expect((await worker.fetch(new Request(origin + path, { method: "POST" }), env)).status).toBe(
        200,
      );
    }
    let read = false;
    const body = new ReadableStream(
      {
        pull() {
          read = true;
        },
      },
      { highWaterMark: 0 },
    );
    const limited = await worker.fetch(
      new Request(STORAGE_GATEWAY_ORIGIN + "/v1/uploads", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
      env,
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: "gateway_rate_limited" });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("x-ohmyhost-egress-outcome")).toBe("rate_limited");
    expect(read).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    const other = {
      ...env,
      EGRESS_CONTEXT: { ...env.EGRESS_CONTEXT, projectId: OTHER_PROJECT_ID },
    };
    expect(
      (await worker.fetch(new Request(MAIL_GATEWAY_ORIGIN + "/v1/send", { method: "POST" }), other))
        .status,
    ).toBe(200);
    expect(calls).toEqual([PROJECT_ID, PROJECT_ID, PROJECT_ID, OTHER_PROJECT_ID]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const storage of [
        undefined,
        { fetch },
        { fetch, permit: true },
        {
          fetch,
          permit: async () => {
            throw new Error(CANARY);
          },
        },
        { fetch, permit: async () => ({ success: true }) },
        { fetch, permit: async () => undefined },
      ]) {
        for (const origin of [MAIL_GATEWAY_ORIGIN, STORAGE_GATEWAY_ORIGIN]) {
          const gateway = origin === MAIL_GATEWAY_ORIGIN ? "mail" : "storage";
          // Keep a fetch method on the storage route: missing admission RPC always fails closed.
          const envWithFailure = {
            ...env,
            STORAGE_GATEWAY: storage ?? { fetch },
          } as unknown as WfpOutboundEnvironment;
          const path = gateway === "mail" ? "/v1/send" : "/v1/uploads";
          const request = new Request(origin + path, {
            method: "POST",
            body: new ReadableStream(
              {
                pull() {
                  read = true;
                },
              },
              { highWaterMark: 0 },
            ),
            duplex: "half",
          } as RequestInit);
          const answer = await worker.fetch(request, envWithFailure);
          expect(answer.status).toBe(503);
          expect(await answer.json()).toEqual({ code: `${gateway}_gateway_unavailable` });
          expect(answer.headers.get("x-ohmyhost-egress-outcome")).toBe("limiter_unavailable");
          expect(request.bodyUsed).toBe(false);
          expect(read).toBe(false);
        }
      }
      const missing = await worker.fetch(
        new Request(MAIL_GATEWAY_ORIGIN + "/v1/send", { method: "POST" }),
        { ...env, STORAGE_GATEWAY: undefined },
      );
      expect(missing.status).toBe(503);
      expect(missing.headers.get("x-ohmyhost-egress-outcome")).toBe("limiter_unavailable");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(permit).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });
});
