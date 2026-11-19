/* global AbortSignal, Response */
// Wiring proof for the private gateway forward (W26, task A6) on real workerd:
//
//   customer Worker --global fetch--> egress policy Worker --service binding--> gateway Worker
//
// The customer is an ordinary module Worker whose outboundService is the REAL egress policy Worker,
// bundled from apps/wfp-dispatch/src/outbound-main.ts and bound exactly as
// apps/wfp-dispatch/wrangler.outbound.jsonc binds it (vars, service names and scoped entrypoints). The
// egress Worker's own outboundService is a sink that records every public fetch it makes, so "no
// public fallback" is observed, not assumed; its positive control is an allow-listed ordinary origin.
// The storage callee is the shipped StorageGatewayRelayEntrypoint class (the factory of
// apps/storage-gateway/src/egress-entrypoint.ts) around a recording port in place of the gateway
// runtime, and MailEgressEntrypoint uses its shipped guard with a recording serve port; both use their
// real configurations. A Node-side service binding is the event bus every Worker reports to, so the
// ordering of what happened (a body read, a cancel, an abort) is observed from outside.
//
// This proves wiring only: real Headers, Request and Response objects, a named entrypoint reached
// with its fixed caller role, bodies and streams crossing the hop, and failures staying private. It
// cannot reproduce Cloudflare's 2026-10 inheritance of the customer's egress interception (workerd
// has none), the gateway runtime behind the entrypoint (DV4 on Development), or a binding to a
// missing entrypoint: workerd refuses to start such a configuration, while Cloudflare uploads it and
// throws at call time (docs/plan/evidence/W26/20261022-gate0-development.json, G0-7). The throwing
// gateway and the absent binding below reach the same catch that call-time throw would.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const FORGED_PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const DATA_ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROJECT_HEADER = "x-ohmyhost-egress-project-id";
const EGRESS_HEADER_PREFIX = "x-ohmyhost-egress-";
const OUTCOME_HEADER = "x-ohmyhost-egress-outcome";
const STAGE_HEADER = "x-ohmyhost-gateway-stage";
const CALLER_PROPS = { caller: "wfp-egress-policy" };
/** Planted in headers, bodies and queries: no log line and no refusal may repeat it. */
const CANARY = "canary-secret-7f3a91";
/** What a failing gateway says about itself: neither a log line nor the customer may see it. */
const ERROR_CANARY = "gateway-private-detail-91c2d4";

const ORDINARY_ORIGIN = "https://api.example.test";
const UNLISTED_ORIGIN = "https://unlisted.example.test";
/** Gateway-shaped names that are not the gateway bound to this egress Worker. */
const UNBOUND_STORAGE_ORIGIN = "https://ohmyho-storage-gateway-other.your-omh-account.workers.dev";
const UNLISTED_STORAGE_ORIGIN =
  "https://ohmyho-storage-gateway-unlisted.your-omh-account.workers.dev";

const STORAGE_ROUTES = [
  "/v1/uploads",
  "/v1/uploads/complete",
  "/v1/downloads",
  "/v1/deletions",
  "/v1/downloads/batch",
  "/v1/deletions/batch",
];
const MIB = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const UPLOAD_CHUNKS = 64; // 4 MiB request body
const DOWNLOAD_CHUNKS = 128; // 8 MiB response body
const RENDEZVOUS_MILLISECONDS = 15_000;

const BASE_HEADERS = [
  ["authorization", `Bearer ${CANARY}`],
  ["content-type", "application/json"],
  ["idempotency-key", "wiring-1"],
  ["x-customer-trace", "kept"],
];
const JSON_BODY = JSON.stringify({ project_id: PROJECT, note: CANARY });

// ---------------------------------------------------------------------------------------------
// The Workers. Each source is a plain module; the Node side only provides the bus.
// ---------------------------------------------------------------------------------------------
const BUS_HELPERS = `
const post = (env, event) =>
  env.BUS.fetch("http://bus/event", { method: "POST", body: JSON.stringify(event) });
const rendezvous = async (env, filter, from) => {
  const answer = await env.BUS.fetch("http://bus/wait", {
    method: "POST",
    body: JSON.stringify({ filter, from, timeoutMs: ${RENDEZVOUS_MILLISECONDS} }),
  });
  return (await answer.json()).met;
};
const chunk = (index) => new Uint8Array(${CHUNK_BYTES}).fill(index % 251);
const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const streamResponse = (env, request, scenario) => {
  request.signal.addEventListener("abort", () => {
    post(env, { name: "signal_aborted", scenario }).catch(() => undefined);
  });
  let produced = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (produced === ${DOWNLOAD_CHUNKS}) return controller.close();
      await post(env, { name: "produced", index: produced });
      controller.enqueue(chunk(produced++));
    },
  }, { highWaterMark: 0 }));
};
`;

/** Customer code: every operation is one plain global fetch, exactly what the SDKs do. */
const CUSTOMER = `import { createPrivateStorageClient } from ${JSON.stringify(join(root, "packages/customer-runtime/src/storage.ts"))};
import { parseSharedGatewayReceipt } from ${JSON.stringify(join(root, "packages/platform/src/shared/shared-gateway.ts"))};
${BUS_HELPERS}
export default {
  async fetch(request, env) {
    const plan = await request.json();
    const headers = new Headers();
    for (const [name, value] of plan.headers ?? []) headers.append(name, value);
    const init = { method: plan.method ?? "POST", headers };
    if (plan.op === "sdk-pin") {
      const receipt = parseSharedGatewayReceipt({
        provider: "ohmyhost-shared-gateway", organizationId: ${JSON.stringify(ORGANIZATION)},
        projectId: ${JSON.stringify(PROJECT)}, environmentId: ${JSON.stringify(ENVIRONMENT)},
        environmentName: "dev", handle: "pin-proof", hostname: "pin-proof.check.omh.st",
        publicOrigin: "https://pin-proof.check.omh.st", targetDeploymentId: ${JSON.stringify(OTHER_PROJECT)},
        targetScriptName: ${JSON.stringify(`p-${PROJECT.toLowerCase()}-dev-${OTHER_PROJECT.toLowerCase()}`)},
        targetArtifactDigest: "sha256:" + "a".repeat(64), targetProviderTag: "wiring",
        egressPolicyDigest: "sha256:" + "b".repeat(64), egressAllowedOrigins: [plan.origin],
        candidateReceiptId: ${JSON.stringify(FORGED_PROJECT)}, revision: 1, predecessorRevision: null,
        operationId: ${JSON.stringify(DATA_ENVIRONMENT)}, active: true, observedAt: "2026-10-24T00:00:00.000Z",
      });
      let requested;
      const client = createPrivateStorageClient({
        endpoint: plan.origin, key: "s".repeat(43), projectId: ${JSON.stringify(PROJECT)},
        environmentId: ${JSON.stringify(ENVIRONMENT)}, capabilityFetch: (request) => fetch(request),
        fetch: (request) => {
          requested = request.url;
          const marked = new Headers(request.headers);
          marked.set("x-wiring-scenario", "sdk");
          return fetch(new Request(request, { headers: marked }));
        },
      });
      const capability = await client.createSignedRead("sdk.bin");
      return Response.json({ origin: receipt.egressAllowedOrigins[0], requested, capability });
    }
    if (plan.op === "call") {
      if (plan.body !== undefined) init.body = plan.body;
      const response = await fetch(plan.url, init);
      return Response.json({
        status: response.status,
        headers: [...response.headers],
        text: await response.text(),
      });
    }
    if (plan.op === "upload") {
      let index = 0;
      init.body = new ReadableStream(
        {
          async pull(controller) {
            await post(env, { name: "upload_pull", index });
            if (index === ${UPLOAD_CHUNKS}) controller.close();
            else controller.enqueue(chunk(index++));
          },
        },
        { highWaterMark: 0 },
      );
      const response = await fetch(plan.url, init);
      return Response.json({
        status: response.status,
        headers: [...response.headers],
        text: await response.text(),
      });
    }
    if (plan.op === "download") {
      init.body = JSON.stringify({ project_id: ${JSON.stringify(PROJECT)} });
      headers.set("content-type", "application/json");
      const response = await fetch(plan.url, init);
      const reader = response.body.getReader();
      const parts = [];
      let read = 0;
      while (read < plan.readBytes) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(next.value);
        read += next.value.byteLength;
      }
      await post(env, { name: "customer_cancelling", read });
      await reader.cancel("the customer stops reading");
      const received = new Uint8Array(read);
      let offset = 0;
      for (const part of parts) {
        received.set(part, offset);
        offset += part.byteLength;
      }
      return Response.json({ status: response.status, read, sha256: hex(await crypto.subtle.digest("SHA-256", received)) });
    }
    if (plan.op === "abort") {
      init.body = "{}";
      const controller = new AbortController();
      const pending = fetch(plan.url, { ...init, signal: controller.signal }).then(
        () => "completed",
        (error) => error.name,
      );
      const held = await rendezvous(env, { name: "held" }, plan.from);
      controller.abort();
      return Response.json({ held, outcome: await pending });
    }
    return new Response("unknown operation", { status: 400 });
  },
};`;

/**
 * The storage callee: the shipped entrypoint class around a recording port, plus the default
 * handler a public request would reach and nothing here may. Bundled like the egress Worker.
 */
const STORAGE_GATEWAY_ENTRY = `import { STORAGE_EGRESS_CALLER, createStorageEgressEntrypoint, createStorageGatewayRelayEntrypoint } from ${JSON.stringify(
  join(root, "apps/storage-gateway/src/egress-entrypoint.ts"),
)};
${BUS_HELPERS}
const port = {
  async fetchForwarded(request, env, caller) {
    const scenario = request.headers.get("x-wiring-scenario");
    await post(env, { name: "gateway_entered", scenario });
    if (scenario === "sdk") return Response.json({ state: "ready", capability: {
      operation: "GET", objectKey: "sdk.bin", url: "https://objects.example.test/sdk.bin",
      expiresAt: "2030-01-01T00:00:00.000Z", expectedContentLength: null, requiredHeaders: {},
    } });
    if (scenario === "throw") throw new Error(${JSON.stringify(ERROR_CANARY)});
    if (scenario === "redirect")
      return new Response("moved", {
        status: 302,
        headers: { location: ${JSON.stringify(`https://private.example.test/${CANARY}`)} },
      });
    if (scenario === "unauthorized")
      return Response.json(
        { code: "unauthorized" },
        { status: 401, headers: { ${JSON.stringify(STAGE_HEADER)}: "key_lookup" } },
      );
    if (scenario === "hold")
      request.signal.addEventListener("abort", () => {
        post(env, { name: "signal_aborted", scenario }).catch(() => undefined);
      });
    if (scenario === "hold") {
      await post(env, { name: "held" });
      await new Promise((resolve) => {
        request.signal.addEventListener("abort", resolve);
        setTimeout(resolve, ${RENDEZVOUS_MILLISECONDS});
      });
      return new Response("released");
    }
    if (scenario === "stream") return streamResponse(env, request, scenario);
    const body = await request.arrayBuffer();
    return Response.json(
      {
        caller,
        expectedCaller: STORAGE_EGRESS_CALLER,
        method: request.method,
        url: request.url,
        headers: [...request.headers],
        bytes: body.byteLength,
        sha256: hex(await crypto.subtle.digest("SHA-256", body)),
      },
      { status: 201, headers: { "x-upstream": "kept" } },
    );
  },
};

export const StorageEgressEntrypoint = createStorageEgressEntrypoint(port);
export const StorageGatewayRelayEntrypoint = createStorageGatewayRelayEntrypoint(port);

export default {
  async fetch(request, env) {
    await post(env, { name: "default_handler" });
    return new Response("default handler");
  },
};`;

/** The shipped Mail entrypoint guard around a recording serve port. */
const MAIL_GATEWAY = `import { createMailEntrypoint } from ${JSON.stringify(join(root, "apps/mail-gateway/src/mail-entrypoint.ts"))};
${BUS_HELPERS}
const serve = async (request, env, trustedProjectId, role) => {
    await post(env, { name: "mail_entered" });
    if (request.headers.get("x-wiring-scenario") === "stream")
      return streamResponse(env, request, "stream");
    return Response.json(
      {
        trustedProjectId,
        role,
        method: request.method,
        url: request.url,
        headers: [...request.headers],
        text: await request.text(),
      },
      { status: 202, headers: { "x-upstream": "kept" } },
    );
  };
export const MailEgressEntrypoint = createMailEntrypoint(serve, "wfp-egress-policy");
export const DatabaseMailEntrypoint = createMailEntrypoint(serve, "project-database-runtime");
export default {
  async fetch(_request, env) {
    await post(env, { name: "default_handler" });
    return new Response("default handler");
  },
};`;

/** The egress Worker's own global fetch ends here, so a public fetch cannot go unnoticed. */
const SINK = `${BUS_HELPERS}
export default {
  async fetch(request, env) {
    await post(env, { name: "public_fetch", method: request.method, url: request.url });
    return new Response("sink", { headers: { "x-sink": "1" } });
  },
};`;

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------
async function readConfiguration(relativePath) {
  const source = await readFile(join(root, relativePath), "utf8");
  return JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
}

let bundledEgress;
/** The egress Worker as the build ships it: outbound-main.ts and its imports as one module. */
function bundleEgress() {
  bundledEgress ??= build({
    entryPoints: [join(root, "apps/wfp-dispatch/src/outbound-main.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["source"],
    target: "es2022",
    write: false,
  }).then((result) => result.outputFiles[0].text);
  return bundledEgress;
}

let bundledStorageGateway;
/** The storage callee, bundled with the shipped entrypoint factory; only workerd's own module stays out. */
function bundleStorageGateway() {
  bundledStorageGateway ??= build({
    stdin: { contents: STORAGE_GATEWAY_ENTRY, loader: "js", resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["source"],
    target: "es2022",
    external: ["cloudflare:*"],
    write: false,
  }).then((result) => result.outputFiles[0].text);
  return bundledStorageGateway;
}

/** Bundle the actual Runtime client and receipt parser into the customer, and Mail's real guard. */
async function bundleFixture(source, nodeCompat = false) {
  const result = await build({
    stdin: { contents: source, loader: "js", resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["source"],
    target: "es2022",
    external: ["cloudflare:*", ...(nodeCompat ? ["node:crypto"] : [])],
    write: false,
  });
  return result.outputFiles[0].text;
}

/** What every Worker reports to, in the order the Node process received it. */
function createBus() {
  const events = [];
  const waiters = new Set();
  const matches = (event, filter) =>
    Object.entries(filter).every(([key, value]) => event[key] === value);
  const waitFor = (filter, timeoutMs, from = 0) =>
    new Promise((resolve) => {
      if (events.slice(from).some((event) => matches(event, filter))) {
        resolve(true);
        return;
      }
      const waiter = {
        filter,
        from,
        settle(met) {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(met);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), timeoutMs);
      waiters.add(waiter);
    });
  return {
    events,
    waitFor,
    count: (name, from = 0) => events.slice(from).filter((event) => event.name === name).length,
    named: (name, from = 0) => events.slice(from).filter((event) => event.name === name),
    async handler(request) {
      const body = await request.json();
      if (new URL(request.url).pathname === "/event") {
        events.push(body);
        for (const waiter of [...waiters])
          if (events.length > waiter.from && matches(body, waiter.filter)) waiter.settle(true);
        return new Response(null, { status: 204 });
      }
      return Response.json({ met: await waitFor(body.filter, body.timeoutMs, body.from) });
    },
  };
}

/** Polls `check` until it returns something truthy, and fails the test after `timeoutMs`. */
async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) assert.fail(message);
    await delay(25);
  }
}

/**
 * One customer Worker behind one egress Worker wired from the real configuration. `withoutBinding`
 * leaves a service binding out of the egress Worker (the closest local stand-in for a binding whose
 * target cannot serve).
 */
async function startChain({
  withoutBinding,
  withoutLimiter = false,
  gatewayLimit,
  callerProps,
  mailCallerProps,
  storageEntrypoint,
  mailEntrypoint,
} = {}) {
  const egressConfig = await readConfiguration("apps/wfp-dispatch/wrangler.outbound.jsonc");
  const storageConfig = await readConfiguration("apps/storage-gateway/wrangler.development.jsonc");
  const mailConfig = await readConfiguration("apps/mail-gateway/wrangler.development.jsonc");
  assert.deepEqual(
    egressConfig.services.map(({ binding }) => binding).sort(),
    ["MAIL_GATEWAY", "STORAGE_GATEWAY"],
    "the ordinary gateway proof grants only the two intrinsic relay roles",
  );
  const storageBinding = egressConfig.services.find((entry) => entry.binding === "STORAGE_GATEWAY");
  const mailBinding = egressConfig.services.find((entry) => entry.binding === "MAIL_GATEWAY");
  assert.equal(
    storageBinding?.entrypoint,
    "StorageGatewayRelayEntrypoint",
    "the egress configuration binds Storage's intrinsic relay role",
  );
  assert.equal(storageBinding.props, undefined, "the intrinsic Storage role has no binding props");
  assert.equal(
    mailBinding?.entrypoint,
    "MailEgressEntrypoint",
    "the egress configuration binds Mail's named entrypoint",
  );
  assert.equal(mailBinding.props, undefined, "the intrinsic Mail role has no binding props");
  const origins = {
    storage: egressConfig.vars.STORAGE_GATEWAY_ORIGIN,
    mail: egressConfig.vars.MAIL_GATEWAY_ORIGIN,
  };
  origins.pinnedStorage = `https://s1-${ORGANIZATION.toLowerCase()}.${ENVIRONMENT.toLowerCase()}-${DATA_ENVIRONMENT.toLowerCase()}.${new URL(origins.storage).hostname}`;
  origins.malformedStorage = `https://extra.${new URL(origins.pinnedStorage).hostname}`;
  assert.ok(origins.storage && origins.mail, "the egress configuration names both gateway origins");
  // The public name of a Worker is its service name under the account's workers.dev subdomain.
  assert.ok(
    new URL(origins.storage).hostname.startsWith(`${storageBinding.service}.`),
    "STORAGE_GATEWAY_ORIGIN names the service STORAGE_GATEWAY binds",
  );
  assert.ok(
    new URL(origins.mail).hostname.startsWith(`${mailBinding.service}.`),
    "MAIL_GATEWAY_ORIGIN names the service MAIL_GATEWAY binds",
  );
  const serviceBindings = {};
  for (const service of egressConfig.services) {
    if (service.binding === withoutBinding) continue;
    serviceBindings[service.binding] =
      service.entrypoint === undefined && service.props === undefined
        ? service.service
        : {
            name: service.service,
            entrypoint:
              service.binding === "STORAGE_GATEWAY"
                ? (storageEntrypoint ?? service.entrypoint)
                : (mailEntrypoint ?? service.entrypoint),
            props:
              service.binding === "MAIL_GATEWAY"
                ? (mailCallerProps ?? service.props)
                : (callerProps ?? service.props),
          };
  }
  const bus = createBus();
  const logs = [];
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-gateway-forward-"));
  const modules = (name, contents) => [
    { type: "ESModule", path: join(directory, `${name}.mjs`), contents },
  ];
  const runtime = (configuration) => {
    assert.equal(typeof configuration.compatibility_date, "string", "a Worker pins its date");
    return {
      compatibilityDate: configuration.compatibility_date,
      compatibilityFlags: configuration.compatibility_flags ?? [],
    };
  };
  let mf;
  const dispose = async () => {
    try {
      await mf?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  let customer;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        rootPath: directory,
        cf: false,
        handleStructuredLogs: (log) => logs.push(log),
        workers: [
          {
            name: "customer",
            modules: modules("customer", await bundleFixture(CUSTOMER)),
            ...runtime(egressConfig),
            outboundService: egressConfig.name,
            serviceBindings: { BUS: bus.handler },
          },
          {
            name: egressConfig.name,
            modules: modules("egress", await bundleEgress()),
            ...runtime(egressConfig),
            outboundService: "sink",
            bindings: {
              ...egressConfig.vars,
              // The dispatcher passes this per invocation; the allow-list is what management would
              // derive for a project with both capabilities, in the strictly ascending order it needs.
              EGRESS_CONTEXT: {
                version: 1,
                projectId: PROJECT,
                allowedOrigins: [
                  origins.mail,
                  origins.storage,
                  origins.pinnedStorage,
                  origins.malformedStorage,
                  ORDINARY_ORIGIN,
                  UNBOUND_STORAGE_ORIGIN,
                ].sort(),
              },
            },
            serviceBindings,
          },
          {
            name: storageBinding.service,
            modules: modules("storage-gateway", await bundleStorageGateway()),
            ...runtime(storageConfig),
            ratelimits: Object.fromEntries(
              storageConfig.ratelimits
                .filter((limiter) => !withoutLimiter || limiter.name !== "GATEWAY_RATE_LIMITER")
                .map(({ name, ...limiter }) => [
                  name,
                  {
                    ...limiter,
                    ...(name === "GATEWAY_RATE_LIMITER" && gatewayLimit !== undefined
                      ? { simple: { ...limiter.simple, limit: gatewayLimit } }
                      : {}),
                  },
                ]),
            ),
            serviceBindings: { BUS: bus.handler },
          },
          {
            name: mailBinding.service,
            modules: modules(
              "mail-gateway",
              await bundleFixture(
                MAIL_GATEWAY,
                mailConfig.compatibility_flags?.includes("nodejs_compat"),
              ),
            ),
            ...runtime(mailConfig),
            serviceBindings: { BUS: bus.handler },
          },
          {
            name: "sink",
            modules: modules("sink", SINK),
            ...runtime(egressConfig),
            serviceBindings: { BUS: bus.handler },
          },
        ],
      }),
    );
    customer = await mf.getWorker("customer");
  } catch (error) {
    // The configuration is what failed; a runtime that never started has nothing more to say.
    await dispose().catch(() => undefined);
    throw error;
  }
  const expectedLines = [];
  return {
    bus,
    logs,
    origins,
    props: storageBinding.props,
    expectedLines,
    close: dispose,
    /** The customer performs `plan`; its answer is what the customer's code would have seen. */
    async run(plan) {
      const from = bus.events.length;
      const response = await customer.fetch("http://customer.test/run", {
        method: "POST",
        body: JSON.stringify({ ...plan, from }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      assert.equal(response.status, 200, `the customer Worker failed: ${text.slice(0, 400)}`);
      const answer = JSON.parse(text);
      return {
        ...answer,
        from,
        headers: Object.fromEntries(answer.headers ?? []),
      };
    },
    /** A plain fetch with the base customer headers, as the SDKs send them. */
    call(url, { method = "POST", headers = [], scenario = "echo", body = JSON_BODY } = {}) {
      return this.run({
        op: "call",
        url,
        method,
        headers: [...BASE_HEADERS, ["x-wiring-scenario", scenario], ...headers],
        ...(method === "GET" ? {} : { body }),
      });
    },
    /** The egress Worker's own failure lines, as workerd's console delivered them. */
    egressLines() {
      return logs
        .filter((log) => log.message.includes('"event":"egress_gateway_outcome"'))
        .map((log) => JSON.parse(log.message));
    },
    expectLine(gateway, outcome) {
      expectedLines.push({ event: "egress_gateway_outcome", gateway, outcome, projectId: PROJECT });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Assertions shared by the rows
// ---------------------------------------------------------------------------------------------
function digestOfPattern(byteLength) {
  const digest = createHash("sha256");
  for (let index = 0; index * CHUNK_BYTES < byteLength; index++)
    digest.update(
      Buffer.alloc(Math.min(CHUNK_BYTES, byteLength - index * CHUNK_BYTES), index % 251),
    );
  return digest.digest("hex");
}

function reportOf(answer) {
  const report = JSON.parse(answer.text);
  return { ...report, received: Object.fromEntries(report.headers ?? []) };
}

/**
 * The platform faults, the only refusals the relay logs. A denial is the caller's doing and leaves
 * no line. Workers Logs stores the method and URL of the request beside each line the relay writes;
 * the relay judges the route before the origin, so the request of a logged outcome is always a
 * fixed route without a query (the rows below send an off-route request to a decoy origin and to a
 * relay without its binding).
 */
const LOGGED_OUTCOMES = new Set([
  "binding_missing",
  "transport_error",
  "redirect_refused",
  "limiter_unavailable",
]);

/** The relay's own answer in the gateway's vocabulary; the customer sees it as JSON, never prose. */
function assertRefusal(chain, answer, { gateway, status, code, outcome }) {
  // Whatever else fails below, the relay logged a platform fault once and a denial not at all; the
  // audit row reads the same list.
  if (LOGGED_OUTCOMES.has(outcome)) chain.expectLine(gateway, outcome);
  assert.equal(answer.status, status);
  assert.equal(answer.text, JSON.stringify({ code }));
  for (const [name, value] of Object.entries({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    [OUTCOME_HEADER]: outcome,
  }))
    assert.equal(answer.headers[name], value, name);
  assert.equal(answer.headers.location, undefined);
  assert.ok(
    !JSON.stringify(answer).includes(CANARY),
    "the refusal repeats nothing the caller sent",
  );
  assert.ok(!JSON.stringify(answer).includes(ERROR_CANARY), "the refusal repeats no gateway text");
}

/** Nothing the relay refused or lost may ever have reached the public fetch or a gateway. */
function assertNothingElseReached(chain, from, { gateways = 0, mailGateways = 0 } = {}) {
  assert.equal(chain.bus.count("public_fetch", from), 0, "no public fetch");
  assert.equal(chain.bus.count("gateway_entered", from), gateways, "gateway entered");
  assert.equal(chain.bus.count("mail_entered", from), mailGateways, "mail gateway entered");
  assert.equal(chain.bus.count("default_handler", from), 0, "default handler reached");
}

// ---------------------------------------------------------------------------------------------
// Table: what a forged platform header looks like to the gateway after the hop
// ---------------------------------------------------------------------------------------------
const FORGERIES = [
  ["no platform header at all", []],
  ["another project's identifier", [[PROJECT_HEADER, OTHER_PROJECT]]],
  ["the name in capitals", [[PROJECT_HEADER.toUpperCase(), OTHER_PROJECT]]],
  [
    "the name twice in two spellings",
    [
      [PROJECT_HEADER, OTHER_PROJECT],
      ["X-OhMyHost-Egress-Project-Id", FORGED_PROJECT],
    ],
  ],
  ["an empty value", [[PROJECT_HEADER, ""]]],
  ["the dispatcher's own identifier in lower case", [[PROJECT_HEADER, PROJECT.toLowerCase()]]],
  [
    "other platform headers the caller invents",
    [
      [OUTCOME_HEADER, "forged"],
      [`${EGRESS_HEADER_PREFIX}caller`, "wfp-egress-policy"],
      [EGRESS_HEADER_PREFIX, "bare prefix"],
    ],
  ],
];

const FORGERY_ROWS = FORGERIES.map(([label, forged], index) => [
  `forged platform headers (${label}) arrive as the dispatcher's project, alone`,
  async (chain) => {
    const route = STORAGE_ROUTES[index % STORAGE_ROUTES.length];
    const answer = await chain.call(`${chain.origins.storage}${route}`, { headers: forged });
    assert.equal(answer.status, 201, answer.text);
    const report = reportOf(answer);
    const platform = report.headers.filter(([name]) => name.startsWith(EGRESS_HEADER_PREFIX));
    assert.deepEqual(
      platform,
      [[PROJECT_HEADER, PROJECT]],
      `${route}: ${JSON.stringify(platform)}`,
    );
    // Everything else of the caller's request arrives as sent, and the gateway's answer is untouched.
    assert.equal(report.method, "POST");
    assert.equal(report.url, `${chain.origins.storage}${route}`);
    assert.equal(report.received.authorization, `Bearer ${CANARY}`);
    assert.equal(report.received["idempotency-key"], "wiring-1");
    assert.equal(report.received["content-type"], "application/json");
    assert.equal(report.received["x-customer-trace"], "kept");
    assert.equal(report.bytes, Buffer.byteLength(JSON_BODY));
    assert.equal(report.sha256, createHash("sha256").update(JSON_BODY).digest("hex"));
    assert.equal(answer.headers["x-upstream"], "kept");
    assert.equal(answer.headers["content-type"], "application/json");
    assert.equal(answer.headers[OUTCOME_HEADER], undefined, "a gateway answer carries no outcome");
    assertNothingElseReached(chain, answer.from, { gateways: 1 });
  },
]);

// ---------------------------------------------------------------------------------------------
// Table: refusals the relay makes itself. None of them may leave through the public fetch.
// ---------------------------------------------------------------------------------------------
const REFUSAL_ROWS = [
  [
    "a gateway-shaped host the project did not enable is refused, not fetched",
    async (chain) => {
      const answer = await chain.call(`${UNLISTED_STORAGE_ORIGIN}/v1/uploads?token=${CANARY}`);
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 403,
        code: "gateway_not_enabled",
        outcome: "not_enabled",
      });
      assertNothingElseReached(chain, answer.from);
    },
  ],
  [
    // A closed route without a query: the canary rides in a header and the body (chain.call sends
    // both), because a logged outcome must belong to a request that is a fixed route and nothing else.
    "an enabled gateway-shaped host that is not the bound gateway is refused, not fetched",
    async (chain) => {
      const answer = await chain.call(`${UNBOUND_STORAGE_ORIGIN}/v1/uploads`);
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 403,
        code: "gateway_route_denied",
        outcome: "route_denied",
      });
      assertNothingElseReached(chain, answer.from);
    },
  ],
  [
    "a request off the fixed routes to a gateway-shaped host that is not the bound gateway is route_denied and writes no line",
    async (chain) => {
      // Workers Logs would store this query beside an origin_unbound line, so the route comes first.
      const answer = await chain.call(`${UNBOUND_STORAGE_ORIGIN}/v1/uploads?token=${CANARY}`);
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 403,
        code: "gateway_route_denied",
        outcome: "route_denied",
      });
      assertNothingElseReached(chain, answer.from);
    },
  ],
  [
    "a route the gateway does not offer is refused before the gateway is called",
    async (chain) => {
      const answer = await chain.call(`${chain.origins.storage}/v1/uploads?token=${CANARY}`);
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 403,
        code: "gateway_route_denied",
        outcome: "route_denied",
      });
      assertNothingElseReached(chain, answer.from);
    },
  ],
  [
    "a refusal answers while the customer is still streaming its body",
    async (chain) => {
      const answer = await chain.run({
        op: "upload",
        url: `${chain.origins.storage}/v1/send`,
        headers: [["content-type", "application/octet-stream"]],
      });
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 403,
        code: "gateway_route_denied",
        outcome: "route_denied",
      });
      const pulls = chain.bus.count("upload_pull", answer.from);
      assert.ok(pulls < UPLOAD_CHUNKS / 8, `${pulls} of ${UPLOAD_CHUNKS} chunks were pulled`);
      assertNothingElseReached(chain, answer.from);
    },
  ],
];

// ---------------------------------------------------------------------------------------------
// Table: spellings of the bound origin and its routes, judged by workerd's own URL parser. A name
// that is not the bound gateway's origin or route is refused and never fetched publicly; a spelling
// that parses to the bound origin and a fixed route is forwarded as that route. (workerd drops
// userinfo and fragments before the outbound Worker runs, so those two cannot be spelled here.)
// ---------------------------------------------------------------------------------------------
const NOT_ENABLED = {
  gateway: "storage",
  status: 403,
  code: "gateway_not_enabled",
  outcome: "not_enabled",
};
const ROUTE_DENIED = {
  gateway: "storage",
  status: 403,
  code: "gateway_route_denied",
  outcome: "route_denied",
};
const SPELLINGS = [
  ["a trailing dot after the host", (host) => `https://${host}./v1/uploads`, "POST", NOT_ENABLED],
  [
    "a percent-encoded trailing dot",
    (host) => `https://${host}%2e/v1/uploads`,
    "POST",
    NOT_ENABLED,
  ],
  ["an explicit port", (host) => `https://${host}:8443/v1/uploads`, "POST", NOT_ENABLED],
  ["the plain http scheme", (host) => `http://${host}/v1/uploads`, "POST", NOT_ENABLED],
  ["a doubled slash", (host) => `https://${host}//v1/uploads`, "POST", ROUTE_DENIED],
  ["a trailing slash", (host) => `https://${host}/v1/uploads/`, "POST", ROUTE_DENIED],
  [
    "a percent-encoded letter in the path",
    (host) => `https://${host}/v1/%75ploads`,
    "POST",
    ROUTE_DENIED,
  ],
  ["a path parameter", (host) => `https://${host}/v1/uploads;x`, "POST", ROUTE_DENIED],
  ["the method GET", (host) => `https://${host}/v1/uploads`, "GET", ROUTE_DENIED],
  ["capitals in the host", (host) => `https://${host.toUpperCase()}/v1/uploads`, "POST", null],
  ["the explicit default port", (host) => `https://${host}:443/v1/uploads`, "POST", null],
  ["a dot segment in the path", (host) => `https://${host}/v1/./uploads`, "POST", null],
];

const SPELLING_ROWS = SPELLINGS.map(([label, spell, method, refusal]) => [
  refusal === null
    ? `${label} is still the bound gateway's /v1/uploads and is forwarded as such`
    : `${label} is refused with ${refusal.code} and never fetched publicly`,
  async (chain) => {
    const answer = await chain.call(spell(new URL(chain.origins.storage).hostname), { method });
    if (refusal !== null) {
      assertRefusal(chain, answer, refusal);
      assertNothingElseReached(chain, answer.from);
      return;
    }
    assert.equal(answer.status, 201, answer.text);
    const report = reportOf(answer);
    assert.equal(report.url, `${chain.origins.storage}/v1/uploads`);
    assert.deepEqual(
      report.headers.filter(([name]) => name.startsWith(EGRESS_HEADER_PREFIX)),
      [[PROJECT_HEADER, PROJECT]],
    );
    assertNothingElseReached(chain, answer.from, { gateways: 1 });
  },
]);

// ---------------------------------------------------------------------------------------------
// Table: one row per property of the hop
// ---------------------------------------------------------------------------------------------
const ROWS = [
  [
    "control: only an allow-listed ordinary origin reaches the public fetch the sink records",
    async (chain) => {
      const allowed = await chain.call(`${ORDINARY_ORIGIN}/v1/ping`, { method: "GET" });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.text, "sink");
      assert.equal(allowed.headers["x-sink"], "1");
      assert.deepEqual(
        chain.bus.named("public_fetch", allowed.from).map((event) => [event.method, event.url]),
        [["GET", `${ORDINARY_ORIGIN}/v1/ping`]],
      );
      const unlisted = await chain.call(`${UNLISTED_ORIGIN}/`, { method: "GET" });
      assert.equal(unlisted.status, 403);
      assert.match(unlisted.text, /^Egress denied: /u);
      assert.equal(unlisted.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(chain.bus.count("public_fetch", unlisted.from), 0);
    },
  ],
  [
    "U6: a DNS-bounded Storage pin passes the real Runtime client and receipt parser and reaches the private binding",
    async (chain) => {
      const host = new URL(chain.origins.pinnedStorage).hostname;
      assert.ok(host.length <= 253);
      assert.ok(host.split(".").every((label) => label.length <= 63));
      const answer = await chain.run({ op: "sdk-pin", origin: chain.origins.pinnedStorage });
      assert.equal(answer.origin, chain.origins.pinnedStorage);
      assert.equal(answer.requested, chain.origins.pinnedStorage + "/v1/downloads");
      assert.equal(answer.capability.objectKey, "sdk.bin");
      assertNothingElseReached(chain, answer.from, { gateways: 1 });
      const malformed = await chain.call(chain.origins.malformedStorage + "/v1/uploads");
      assertRefusal(chain, malformed, ROUTE_DENIED);
      assertNothingElseReached(chain, malformed.from);
    },
  ],
  ...FORGERY_ROWS,
  [
    "the shipped Storage relay class carries its intrinsic role without binding props; the default handler is never reached",
    async (chain) => {
      assert.equal(chain.props, undefined, "the configuration needs no unreadable provider props");
      const answer = await chain.call(`${chain.origins.storage}/v1/uploads`);
      const report = reportOf(answer);
      assert.deepEqual(
        report.caller,
        CALLER_PROPS,
        "the intrinsic role the shipped class supplies",
      );
      assert.deepEqual(
        report.caller,
        { caller: report.expectedCaller },
        "the gateway's own marker",
      );
      assert.equal(chain.bus.count("gateway_entered", answer.from), 1);
      assert.equal(chain.bus.count("default_handler", answer.from), 0);
    },
  ],
  [
    "the storage entrypoint RPC shares native admission across mail and storage and fails closed before either gateway",
    async () => {
      const limited = await startChain({ gatewayLimit: 3 });
      try {
        const mail = await limited.call(`${limited.origins.mail}/v1/send`);
        assert.equal(mail.status, 202, mail.text);
        const attachment = await limited.call(`${limited.origins.mail}/v1/attachments/download`);
        assert.equal(attachment.status, 202, attachment.text);
        const storage = await limited.call(`${limited.origins.storage}/v1/uploads`);
        assert.equal(storage.status, 201, storage.text);
        // Any second admission on either Mail route or Storage would refuse the third control.
        for (const gateway of ["mail", "storage"]) {
          const path = gateway === "mail" ? "/v1/send" : "/v1/uploads";
          const denied = await limited.call(limited.origins[gateway] + path);
          assertRefusal(limited, denied, {
            gateway,
            status: 429,
            code: "gateway_rate_limited",
            outcome: "rate_limited",
          });
          assert.equal(denied.headers["retry-after"], "60");
          assertNothingElseReached(limited, denied.from);
        }
        await auditLogs(limited);
      } finally {
        await limited.close();
      }
      for (const options of [
        { storageEntrypoint: "StorageEgressEntrypoint" },
        { storageEntrypoint: "StorageEgressEntrypoint", callerProps: { caller: "other" } },
        {
          storageEntrypoint: "StorageEgressEntrypoint",
          callerProps: { ...CALLER_PROPS, extra: true },
        },
        { withoutLimiter: true },
      ]) {
        const unavailable = await startChain(options);
        try {
          for (const gateway of ["mail", "storage"]) {
            const path = gateway === "mail" ? "/v1/send" : "/v1/uploads";
            const denied = await unavailable.call(unavailable.origins[gateway] + path);
            assertRefusal(unavailable, denied, {
              gateway,
              status: 503,
              code: `${gateway}_gateway_unavailable`,
              outcome: "limiter_unavailable",
            });
            assertNothingElseReached(unavailable, denied.from);
          }
          await auditLogs(unavailable);
        } finally {
          await unavailable.close();
        }
      }
    },
  ],
  [
    "a gateway answer reaches the customer exactly as built, stage header included",
    async (chain) => {
      const answer = await chain.call(`${chain.origins.storage}/v1/downloads`, {
        scenario: "unauthorized",
      });
      assert.equal(answer.status, 401);
      assert.equal(answer.text, JSON.stringify({ code: "unauthorized" }));
      assert.equal(answer.headers["content-type"], "application/json");
      assert.equal(answer.headers[STAGE_HEADER], "key_lookup");
      assert.equal(answer.headers[OUTCOME_HEADER], undefined, "the relay added nothing");
      assertNothingElseReached(chain, answer.from, { gateways: 1 });
    },
  ],
  [
    "mail and attachment download reach the real named guard with only the dispatcher-set project",
    async (chain) => {
      for (const path of ["/v1/send", "/v1/attachments/download"]) {
        const answer = await chain.call(`${chain.origins.mail}${path}`, {
          headers: [
            [PROJECT_HEADER, FORGED_PROJECT],
            [`${EGRESS_HEADER_PREFIX}caller`, "wfp-egress-policy"],
          ],
        });
        assert.equal(answer.status, 202, answer.text);
        const report = reportOf(answer);
        assert.deepEqual(
          report.headers.filter(([name]) => name.startsWith(EGRESS_HEADER_PREFIX)),
          [[PROJECT_HEADER, PROJECT]],
        );
        assert.equal(report.trustedProjectId, PROJECT);
        assert.equal(report.role, "wfp-egress-policy");
        assert.equal(report.url, `${chain.origins.mail}${path}`);
        assert.equal(report.received.authorization, `Bearer ${CANARY}`);
        assert.equal(report.received["x-customer-trace"], "kept");
        assert.equal(report.text, JSON_BODY);
        assert.equal(answer.headers["x-upstream"], "kept");
        assert.equal(chain.bus.count("mail_entered", answer.from), 1);
        assert.equal(chain.bus.count("public_fetch", answer.from), 0);
        assert.equal(chain.bus.count("gateway_entered", answer.from), 0);
      }
      const foreign = await chain.call(`${chain.origins.mail}/v1/attachments/download`, {
        body: JSON.stringify({ project_id: OTHER_PROJECT }),
      });
      assert.equal(foreign.status, 401);
      assertNothingElseReached(chain, foreign.from);
      // Binding the wrong scoped class cannot gain attachment authority through forged props.
      const wrong = await startChain({
        mailEntrypoint: "DatabaseMailEntrypoint",
        mailCallerProps: CALLER_PROPS,
      });
      try {
        const rejected = await wrong.call(wrong.origins.mail + "/v1/attachments/download");
        assert.equal(rejected.status, 404);
        assertNothingElseReached(wrong, rejected.from);
        const send = await wrong.call(wrong.origins.mail + "/v1/send");
        assert.equal(send.status, 202, send.text);
        assert.equal(reportOf(send).role, "project-database-runtime");
        assertNothingElseReached(wrong, send.from, { mailGateways: 1 });
        await auditLogs(wrong);
      } finally {
        await wrong.close();
      }
    },
  ],
  ...REFUSAL_ROWS,
  ...SPELLING_ROWS,
  [
    "a 4 MiB request body arrives intact and the relay does not read it",
    async (chain) => {
      const answer = await chain.run({
        op: "upload",
        url: `${chain.origins.storage}/v1/uploads`,
        headers: [
          ["authorization", `Bearer ${CANARY}`],
          ["content-type", "application/octet-stream"],
          ["x-wiring-scenario", "echo"],
        ],
      });
      assert.equal(answer.status, 201, answer.text);
      const report = reportOf({ text: answer.text });
      assert.equal(report.bytes, UPLOAD_CHUNKS * CHUNK_BYTES);
      assert.equal(report.sha256, digestOfPattern(UPLOAD_CHUNKS * CHUNK_BYTES));
      // The gateway is called with the body still in the customer's hands: the customer's stream was
      // asked for at most a bounded read-ahead by then, not for the 4 MiB a buffering relay reads first.
      const events = chain.bus.events.slice(answer.from);
      const entered = events.findIndex((event) => event.name === "gateway_entered");
      assert.notEqual(entered, -1, "the gateway was entered");
      const pulled = events
        .slice(0, entered)
        .filter((event) => event.name === "upload_pull").length;
      assert.ok(
        pulled < UPLOAD_CHUNKS / 8,
        `${pulled} of ${UPLOAD_CHUNKS} chunks before the gateway`,
      );
      assertNothingElseReached(chain, answer.from, { gateways: 1 });
    },
  ],
  // G0-4 locally: the gateway configurations carry enable_request_signal and the egress ones do not.
  // If the next two rows ever fail on a newer workerd, the flag belongs in both egress configurations
  // (the pin in apps/wfp-dispatch/test/outbound.test.ts expects none today) and these rows must be
  // run again.
  [
    "an 8 MiB response streams through unbuffered and a consumer cancel reaches the gateway request",
    async (chain) => {
      for (const [origin, path, expected] of [
        [chain.origins.storage, "/v1/downloads", { gateways: 1 }],
        [chain.origins.mail, "/v1/attachments/download", { mailGateways: 1 }],
      ]) {
        const answer = await chain.run({
          op: "download",
          url: `${origin}${path}`,
          headers: [["x-wiring-scenario", "stream"]],
          readBytes: MIB,
        });
        assert.equal(answer.status, 200);
        assert.ok(answer.read >= MIB, `${answer.read} bytes read`);
        assert.equal(answer.sha256, digestOfPattern(answer.read), "the first MiB arrives intact");
        // The customer had its first MiB while the gateway had produced a small part of the 8 MiB.
        const events = chain.bus.events.slice(answer.from);
        const cancelling = events.findIndex((event) => event.name === "customer_cancelling");
        const produced = events
          .slice(0, cancelling)
          .filter((event) => event.name === "produced").length;
        assert.ok(
          produced >= MIB / CHUNK_BYTES && produced < DOWNLOAD_CHUNKS / 2,
          `${produced} of ${DOWNLOAD_CHUNKS} chunks were produced before the customer stopped`,
        );
        // The cancel travels back through both hops as one abort of the gateway's request signal.
        assert.ok(
          await chain.bus.waitFor(
            { name: "signal_aborted", scenario: "stream" },
            15_000,
            answer.from,
          ),
          `${origin}${path}: the gateway request was never aborted`,
        );
        await delay(250);
        assert.equal(chain.bus.count("signal_aborted", answer.from), 1);
        assert.ok(chain.bus.count("produced", answer.from) < DOWNLOAD_CHUNKS);
        assertNothingElseReached(chain, answer.from, expected);
      }
    },
  ],
  [
    "an aborted fetch reaches the gateway request signal once",
    async (chain) => {
      const answer = await chain.run({
        op: "abort",
        url: `${chain.origins.storage}/v1/uploads`,
        headers: [["x-wiring-scenario", "hold"]],
      });
      assert.deepEqual([answer.held, answer.outcome], [true, "AbortError"]);
      assert.ok(
        await chain.bus.waitFor({ name: "signal_aborted", scenario: "hold" }, 15_000, answer.from),
        "the gateway request was never aborted",
      );
      await delay(250);
      assert.equal(chain.bus.count("signal_aborted", answer.from), 1);
      assertNothingElseReached(chain, answer.from, { gateways: 1 });
    },
  ],
  [
    "a gateway that throws becomes a JSON 503, never a public fetch, and its text stays private",
    async (chain) => {
      const answer = await chain.call(`${chain.origins.storage}/v1/uploads`, { scenario: "throw" });
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 503,
        code: "storage_gateway_unavailable",
        outcome: "transport_error",
      });
      assertNothingElseReached(chain, answer.from, { gateways: 1 });
    },
  ],
  [
    "a gateway redirect is refused, not followed, and its target stays private",
    async (chain) => {
      const answer = await chain.call(`${chain.origins.storage}/v1/uploads`, {
        scenario: "redirect",
      });
      assertRefusal(chain, answer, {
        gateway: "storage",
        status: 503,
        code: "storage_gateway_unavailable",
        outcome: "redirect_refused",
      });
      assert.ok(!JSON.stringify(answer).includes("private.example.test"));
      assertNothingElseReached(chain, answer.from, { gateways: 1 });
    },
  ],
  [
    "a relay whose storage binding cannot serve answers a JSON 503 and never fetches publicly",
    async () => {
      const absent = await startChain({ withoutBinding: "STORAGE_GATEWAY" });
      try {
        const answer = await absent.call(`${absent.origins.storage}/v1/uploads`);
        assertRefusal(absent, answer, {
          gateway: "storage",
          status: 503,
          code: "storage_gateway_unavailable",
          outcome: "limiter_unavailable",
        });
        assertNothingElseReached(absent, answer.from);
        // The route is judged before the binding: a query on the same call is route_denied, no line.
        const offRoute = await absent.call(`${absent.origins.storage}/v1/uploads?token=${CANARY}`);
        assertRefusal(absent, offRoute, {
          gateway: "storage",
          status: 403,
          code: "gateway_route_denied",
          outcome: "route_denied",
        });
        assertNothingElseReached(absent, offRoute.from);
        await auditLogs(absent);
      } finally {
        await absent.close();
      }
    },
  ],
  [
    "audit: the whole run made one public fetch, reached no default handler and logged only fixed-field lines",
    async (chain) => {
      assert.deepEqual(
        chain.bus.named("public_fetch").map((event) => event.url),
        [`${ORDINARY_ORIGIN}/v1/ping`],
        "the control's request is the only public fetch of the run",
      );
      assert.equal(chain.bus.count("default_handler"), 0);
      await auditLogs(chain);
    },
  ],
];

/**
 * The egress Worker logged exactly the platform faults the rows saw, in fixed fields only. Local
 * workerd attaches no request metadata to its console output, so this reads the lines the Worker
 * writes itself; the method and URL that Workers Logs stores beside them are the V15 read-back.
 */
async function auditLogs(chain) {
  await eventually(
    () => chain.egressLines().length >= chain.expectedLines.length,
    15_000,
    `expected ${chain.expectedLines.length} egress lines, saw ${chain.egressLines().length}`,
  );
  await delay(250);
  assert.deepEqual(chain.egressLines(), chain.expectedLines);
  for (const line of chain.egressLines())
    assert.deepEqual(Object.keys(line).sort(), ["event", "gateway", "outcome", "projectId"]);
  const everything = JSON.stringify(chain.logs);
  assert.ok(!everything.includes(CANARY), "no log line repeats what the caller sent");
  assert.ok(!everything.includes(ERROR_CANARY), "no log line repeats what the gateway said");
}

test(
  "the egress policy Worker relays the platform gateways over real workerd bindings and never falls back to a public fetch",
  { timeout: 300_000 },
  async (t) => {
    const chain = await startChain();
    t.after(() => chain.close());
    for (const [name, row] of ROWS) await t.test(name, () => row(chain));
  },
);
