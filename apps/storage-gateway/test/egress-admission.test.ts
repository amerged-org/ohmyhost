import { createPinnedStorageGatewayOrigin, parseUlid } from "@ohmyhost/platform";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

// ---------------------------------------------------------------------------------------------
// Admission: the egress policy Worker reaches StorageEgressEntrypoint over its own private
// binding, and a deployment reaches the default export over its service binding. Everything here
// is decided before the Core capability is called, or by its first answer (the key lookup).
// ---------------------------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});

const id = (value: number) => parseUlid(String(value).padStart(26, "0"));
const storageKey = "s".repeat(43);
const projectHeader = "x-ohmyhost-egress-project-id";
const stageHeader = "x-ohmyhost-gateway-stage";
const egressMarker = { caller: "wfp-egress-policy" } as const;
const gatewayUrl =
  "https://ohmyho-storage-gateway-poc-private-fullstack.your-omh-account.workers.dev";
const keyOf = (letter: string) => letter.repeat(43);
const bindings = {
  STORAGE_SCOPE_LOG_LIMITER: { limit: async () => ({ success: true }) },
  RUNTIME_CONFIGURATION_STATE: "configured",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_R2_API_TOKEN: "x".repeat(43),
  CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "b".repeat(32),
} as const;

interface Spec {
  readonly path: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: BodyInit | null;
}

/** A Core capability that answers every command with `answer`, or fails the row when it is called at all. */
function core(answer?: (command: string) => unknown) {
  const stats = { calls: 0 };
  const capability = new Proxy(
    {},
    {
      get: (_target, command) => async () => {
        stats.calls++;
        if (answer === undefined || typeof command !== "string")
          throw new Error("the Core must not be called");
        return answer(command);
      },
    },
  );
  return { stats, env: { ...bindings, STORAGE_GATEWAY_RUNTIME: capability } };
}

async function forwardedEntrypoint(env: object, fixedRole = false) {
  const { createStorageGatewayEntrypoint } = await import("../src/worker-main.js");
  const { createStorageEgressEntrypoint, createStorageGatewayRelayEntrypoint } = await import(
    "../src/egress-entrypoint.js"
  );
  const create = fixedRole ? createStorageGatewayRelayEntrypoint : createStorageEgressEntrypoint;
  const Entrypoint = create(createStorageGatewayEntrypoint());
  return (options: { readonly props?: unknown; readonly env?: object } = {}) =>
    new Entrypoint(
      { props: "props" in options ? options.props : egressMarker } as never,
      (options.env ?? env) as never,
    );
}

function specFor(
  path: string,
  input: {
    readonly project: string;
    readonly key: string;
    readonly body: Record<string, unknown>;
    readonly idempotencyKey?: string;
  },
): Spec {
  return {
    path,
    method: "POST",
    headers: [
      [projectHeader, input.project],
      ["authorization", `Bearer ${input.key}`],
      ["content-type", "application/json"],
      ...(input.idempotencyKey === undefined
        ? []
        : ([["idempotency-key", input.idempotencyKey]] as const)),
    ],
    body: JSON.stringify(input.body),
  };
}

function build(spec: Spec, origin: string = gatewayUrl): Request {
  return new Request(`${origin}${spec.path}`, {
    method: spec.method,
    headers: spec.headers.map(([name, value]): [string, string] => [name, value]),
    ...(spec.body === null ? {} : { body: spec.body }),
  });
}

const uploadBody = (projectId: string, environmentId: string, objectKey: string) => ({
  projectId,
  environmentId,
  objectKey,
  contentType: "application/octet-stream",
  contentLength: 3,
});

const events = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

// The service binding of a deployment shares admission and serving with the forwarded path. The
// tests that pin it call the entrypoint as a deployment does: the scope is the props the
// binding was made with, no egress stamp is sent, and no rule of the forwarded path may apply.
const legacyScope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  dataEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
} as const;

async function legacyEntrypoint(env: object) {
  const { createStorageGatewayEntrypoint } = await import("../src/worker-main.js");
  const entrypoint = createStorageGatewayEntrypoint();
  // The deployed binding carries the project's gateway limit; these cases test what follows it.
  const limited = { GATEWAY_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...env };
  return (call: Spec | Request, options: { readonly props?: unknown } = {}) =>
    entrypoint.fetch(call instanceof Request ? call : build(call), limited, {
      props: "props" in options ? options.props : legacyScope,
    });
}

interface LegacyParts {
  readonly authorization?: string;
  readonly contentType?: string;
}

function legacySpec(path: string, body: BodyInit | null, parts: LegacyParts = {}): Spec {
  return {
    path,
    method: "POST",
    headers: [
      ["authorization", parts.authorization ?? `Bearer ${keyOf("k")}`],
      ["content-type", parts.contentType ?? "application/json"],
      ["idempotency-key", "legacy-upload"],
    ],
    body,
  };
}

/** An upload the runtime takes as far as the key lookup. */
const soundUploadBody = JSON.stringify(
  uploadBody(legacyScope.projectId, legacyScope.environmentId, "fresh.bin"),
);
const soundUpload = (parts: LegacyParts = {}) => legacySpec("/v1/uploads", soundUploadBody, parts);

/** A JSON object of exactly `bytes` bytes that names the legacy scope, filled up with ASCII. */
function sized(bytes: number): string {
  const ids = { projectId: legacyScope.projectId, environmentId: legacyScope.environmentId };
  const bare = JSON.stringify({ ...ids, padding: "" }).length;
  const body = JSON.stringify({ ...ids, padding: "x".repeat(bytes - bare) });
  expect(new TextEncoder().encode(body).byteLength).toBe(bytes);
  return body;
}

it("names a failed key lookup on the forwarded path and never on a deployment's own binding", async () => {
  const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const wire = core((command) => {
    expect(command).toBe("authenticateStorageGateway");
    return null;
  });
  const entry = (await forwardedEntrypoint(wire.env))();
  const spec = specFor("/v1/uploads", {
    project: projectId,
    key: keyOf("z"),
    idempotencyKey: "unknown-key",
    body: uploadBody(projectId, environmentId, "fresh.bin"),
  });
  const forwarded = await entry.fetch(build(spec));
  expect(forwarded.status).toBe(401);
  expect(forwarded.headers.get(stageHeader)).toBe("key_lookup");
  await expect(forwarded.json()).resolves.toEqual({ code: "unauthorized" });
  const legacy = await (await legacyEntrypoint(wire.env))(build(spec));
  expect(legacy.status).toBe(401);
  expect(legacy.headers.get(stageHeader)).toBeNull();
  expect(wire.stats.calls).toBe(2);
});

it("rejects every malformed or unmarked call before the Core is called", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const wire = core();
    const entry = await forwardedEntrypoint(wire.env);
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const secret = keyOf("k");
    const upload = specFor("/v1/uploads", {
      project: projectId,
      key: secret,
      idempotencyKey: "upload-1",
      body: uploadBody(projectId, environmentId, "canary-object.bin"),
    });
    const deletion = specFor("/v1/deletions", {
      project: projectId,
      key: secret,
      body: { projectId, environmentId, objectKey: "canary-object.bin" },
    });
    const without = (spec: Spec, name: string) =>
      spec.headers.filter(([header]) => header !== name);
    const withHeader = (spec: Spec, name: string, value: string): Spec => ({
      ...spec,
      headers: [...without(spec, name), [name, value]],
    });
    const withBody = (body: string | Uint8Array<ArrayBuffer> | Record<string, unknown>): Spec => ({
      ...upload,
      body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const mismatch = {
      event: "storage_egress_scope_rejected",
      reason: "project_mismatch",
      projectId,
    };
    const rejection = (
      label: string,
      spec: Spec,
      status: number,
      code: string,
      extra: { readonly event?: Record<string, unknown> } = {},
    ) => ({ label, spec, status, code, ...extra });
    const invalid = "storage_gateway_input_invalid";
    const variants = [
      rejection("GET", { ...upload, method: "GET", body: null }, 404, "resource_not_found"),
      rejection("unknown route", { ...upload, path: "/v1/unknown" }, 404, "resource_not_found"),
      rejection("query string", { ...upload, path: "/v1/uploads?x=1" }, 404, "resource_not_found"),
      rejection(
        "no header",
        { ...upload, headers: without(upload, projectHeader) },
        401,
        "unauthorized",
      ),
      rejection("empty header", withHeader(upload, projectHeader, ""), 401, "unauthorized"),
      rejection(
        "lower-case header",
        withHeader(upload, projectHeader, projectId.toLowerCase()),
        401,
        "unauthorized",
      ),
      rejection(
        "non-canonical header",
        withHeader(upload, projectHeader, `8${projectId.slice(1)}`),
        401,
        "unauthorized",
      ),
      rejection(
        "duplicated header",
        { ...upload, headers: [...upload.headers, [projectHeader, projectId]] },
        401,
        "unauthorized",
      ),
      rejection(
        "no bearer",
        { ...upload, headers: without(upload, "authorization") },
        400,
        "invalid_request",
      ),
      rejection(
        "other scheme",
        withHeader(upload, "authorization", `Basic ${secret}`),
        400,
        "invalid_request",
      ),
      rejection(
        "wrong media type",
        withHeader(upload, "content-type", "text/plain"),
        400,
        "invalid_request",
      ),
      rejection(
        "8 KiB and one byte",
        withBody({ projectId, environmentId, padding: "x".repeat(8192) }),
        413,
        "payload_too_large",
      ),
      rejection(
        "4 MiB and one byte on a batch route",
        { ...withBody(new Uint8Array(4 * 1024 * 1024 + 1)), path: "/v1/downloads/batch" },
        413,
        "payload_too_large",
      ),
      rejection("malformed JSON", withBody("{"), 400, "invalid_request"),
      rejection("JSON array", withBody("[]"), 400, "invalid_request"),
      rejection("JSON scalar", withBody('"text"'), 400, "invalid_request"),
      rejection("invalid UTF-8", withBody(new Uint8Array([0xff, 0xfe])), 400, "invalid_request"),
      rejection(
        "other project in the body",
        withBody(uploadBody("01ARZ3NDEKTSV4RRFFQ69G5FAX", environmentId, "x.bin")),
        401,
        "unauthorized",
        { event: mismatch },
      ),
      rejection("no project in the body", withBody({ environmentId }), 401, "unauthorized", {
        event: mismatch,
      }),
      rejection("no environment", withBody({ projectId }), 400, "invalid_request"),
      rejection(
        "lower-case environment",
        withBody(uploadBody(projectId, environmentId.toLowerCase(), "x.bin")),
        400,
        "invalid_request",
      ),
      rejection(
        "numeric environment",
        withBody({ projectId, environmentId: 7 }),
        400,
        "invalid_request",
      ),
      rejection(
        "key of 42 characters",
        withHeader(upload, "authorization", `Bearer ${secret.slice(1)}`),
        400,
        "invalid_request",
      ),
      rejection(
        "key with a forbidden character",
        withHeader(upload, "authorization", `Bearer ${secret.slice(1)}!`),
        400,
        "invalid_request",
      ),
      // These reach the runtime, which refuses them in its own words before any Core command.
      rejection(
        "upload without Idempotency-Key",
        { ...upload, headers: without(upload, "idempotency-key") },
        400,
        invalid,
      ),
      rejection("delete without Idempotency-Key", deletion, 400, invalid),
      rejection(
        "unexpected body field",
        withBody({ ...uploadBody(projectId, environmentId, "x.bin"), extra: 1 }),
        400,
        invalid,
      ),
    ];
    const expected: Record<string, unknown>[] = [];
    for (const props of [
      undefined,
      null,
      {},
      { caller: "other" },
      { ...egressMarker, extra: true },
      [egressMarker],
    ]) {
      const response = await entry({ props }).fetch(build(upload));
      expect([props, response.status]).toEqual([props, 401]);
      expect(response.headers.get(stageHeader)).toBeNull();
      await expect(response.json()).resolves.toEqual({ code: "unauthorized" });
      expected.push({ event: "storage_egress_scope_rejected", reason: "marker_missing" });
    }
    for (const { label, spec, status, code, event } of variants) {
      const result = await entry().fetch(build(spec));
      expect([label, result.status, result.headers.get(stageHeader)]).toEqual([
        label,
        status,
        null,
      ]);
      await expect(result.json()).resolves.toEqual({ code });
      if (event !== undefined) expected.push(event);
    }
    expect(events(warn)).toEqual(expected);
    expect(wire.stats.calls).toBe(0);
    // The default export keeps its props contract: a forged header without props is refused.
    const { default: worker, StorageEgressEntrypoint } = await import("../src/worker-main.js");
    const legacy = await worker.fetch(build(upload), wire.env, { props: {} });
    expect(legacy.status).toBe(401);
    expect(legacy.headers.get(stageHeader)).toBeNull();
    // The production export is the same class: an unmarked caller is stopped before the Core.
    const production = new StorageEgressEntrypoint({ props: {} } as never, wire.env);
    expect((await production.fetch(build(upload))).status).toBe(401);
    expect(wire.stats.calls).toBe(0);
    // Neither the key nor any part of a body reaches the logs.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("canary-object");
  } finally {
    warn.mockRestore();
  }
});

it("rejects malformed pins and a body environment outside its pin before the Core is called", async () => {
  const wire = core();
  const entry = (await forwardedEntrypoint(wire.env, true))();
  const origin = createPinnedStorageGatewayOrigin(gatewayUrl, {
    organizationId: id(1),
    environmentId: id(11),
    dataEnvironmentId: id(11),
  });
  const spec = specFor("/v1/uploads", {
    project: id(10),
    key: storageKey,
    idempotencyKey: "forged-pin",
    body: uploadBody(id(10), id(12), "forged.bin"),
  });
  for (const target of [
    origin,
    origin.replace("s1-", "s2-"),
    `https://bad.${new URL(origin).hostname}`,
    "https://files.example.test",
  ]) {
    const refused = await entry.fetch(build(spec, target));
    expect([target, refused.status, refused.headers.get(stageHeader)]).toEqual([target, 401, null]);
    await expect(refused.json()).resolves.toEqual({ code: "unauthorized" });
  }
  expect(wire.stats.calls).toBe(0);
});

it("stops waiting for a body that never completes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wire = core();
  const entry = (await forwardedEntrypoint(wire.env))();
  const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const stalled = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });
  const pending = entry.fetch(
    new Request(`${gatewayUrl}/v1/uploads`, {
      method: "POST",
      headers: [
        [projectHeader, projectId],
        ["authorization", `Bearer ${keyOf("k")}`],
        ["content-type", "application/json"],
      ],
      body: stalled,
      duplex: "half",
    } as RequestInit),
  );
  // A flag, not a race: a promise derived from `pending` settles a turn after it, so a race
  // against a plain value would answer "waiting" even for a deadline shorter than five seconds.
  let settled = false;
  const settle = () => {
    settled = true;
  };
  void pending.then(settle, settle);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  const response = await pending;
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ code: "invalid_request" });
  expect(wire.stats.calls).toBe(0);
});

it("leaves the service binding of a deployment reading its props only after bearer, media type and body", async () => {
  const wire = core();
  const legacy = await legacyEntrypoint(wire.env);
  const refusals = [
    ["other scheme", soundUpload({ authorization: `Basic ${keyOf("k")}` }), 400, "invalid_request"],
    ["wrong media type", soundUpload({ contentType: "text/plain" }), 400, "invalid_request"],
    ["malformed JSON", legacySpec("/v1/uploads", "{"), 400, "invalid_request"],
    ["JSON array", legacySpec("/v1/uploads", "[]"), 400, "invalid_request"],
    [
      "8 KiB and one byte",
      legacySpec("/v1/uploads", sized(8 * 1024 + 1)),
      413,
      "payload_too_large",
    ],
  ] as const;
  for (const props of [undefined, {}]) {
    for (const [label, spec, status, code] of refusals) {
      const response = await legacy(spec, { props });
      expect([label, props, response.status]).toEqual([label, props, status]);
      await expect(response.json()).resolves.toEqual({ code });
    }
    // Only a call that got through all of them is refused for its props.
    const unscoped = await legacy(soundUpload(), { props });
    expect([props, unscoped.status]).toEqual([props, 401]);
    await expect(unscoped.json()).resolves.toEqual({ code: "unauthorized" });
    expect(unscoped.headers.get(stageHeader)).toBeNull();
  }
  expect(wire.stats.calls).toBe(0);
});

it("leaves the shape of the bearer of a deployment's service binding to the runtime", async () => {
  const wire = core();
  const legacy = await legacyEntrypoint(wire.env);
  const key = keyOf("k");
  const malformed = [
    ["42 characters", key.slice(1)],
    ["44 characters", `${key}k`],
    ["a forbidden character", `${key.slice(1)}!`],
  ] as const;
  for (const [label, bearer] of malformed) {
    // Admission lets it through; the runtime refuses it, in its own words, before the Core.
    const response = await legacy(soundUpload({ authorization: `Bearer ${bearer}` }));
    expect([label, response.status]).toEqual([label, 400]);
    await expect(response.json()).resolves.toEqual({ code: "storage_gateway_input_invalid" });
  }
  expect(wire.stats.calls).toBe(0);
  // The same call with a sound key goes on to the key lookup, which this Core then fails.
  const lookup = await legacy(soundUpload());
  expect(lookup.status).toBe(503);
  await expect(lookup.json()).resolves.toEqual({ code: "storage_gateway_unavailable" });
  expect(wire.stats.calls).toBe(1);
});

it("leaves a deployment's service binding taking exactly application/json to the body", async () => {
  const wire = core();
  const legacy = await legacyEntrypoint(wire.env);
  for (const contentType of [
    "text/plain",
    "text/json",
    "application/jsonp",
    "application/vnd.api+json",
  ]) {
    const response = await legacy(soundUpload({ contentType }));
    expect([contentType, response.status]).toEqual([contentType, 400]);
    await expect(response.json()).resolves.toEqual({ code: "invalid_request" });
  }
  expect(wire.stats.calls).toBe(0);
  // Parameters do not make another media type: both calls reach the key lookup.
  for (const contentType of ["application/json", "application/json; charset=utf-8"]) {
    const response = await legacy(soundUpload({ contentType }));
    expect([contentType, response.status]).toEqual([contentType, 503]);
  }
  expect(wire.stats.calls).toBe(2);
});

it("leaves a deployment's service binding bounded at 8 KiB and its batch calls at 4 MiB", async () => {
  const wire = core();
  const legacy = await legacyEntrypoint(wire.env);
  const limits = [
    ["/v1/uploads", 8 * 1024],
    ["/v1/uploads/complete", 8 * 1024],
    ["/v1/downloads", 8 * 1024],
    ["/v1/deletions", 8 * 1024],
    ["/v1/downloads/batch", 4 * 1024 * 1024],
    ["/v1/deletions/batch", 4 * 1024 * 1024],
  ] as const;
  for (const [path, limit] of limits) {
    // A body of exactly the limit is read whole and handed to the runtime, which refuses the
    // padding; one byte more is refused before the runtime exists.
    const read = await legacy(legacySpec(path, sized(limit)));
    expect([path, limit, read.status]).toEqual([path, limit, 400]);
    await expect(read.json()).resolves.toEqual({ code: "storage_gateway_input_invalid" });
    const refused = await legacy(legacySpec(path, sized(limit + 1)));
    expect([path, limit, refused.status]).toEqual([path, limit, 413]);
    await expect(refused.json()).resolves.toEqual({ code: "payload_too_large" });
  }
  expect(wire.stats.calls).toBe(0);
});

it("leaves a deployment's service binding without a deadline for a slow body", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wire = core();
  const legacy = await legacyEntrypoint(wire.env);
  // A minute: far beyond the five seconds that bound a forwarded body, however they are set.
  const arrival = 60_000;
  const slow = new ReadableStream<Uint8Array>({
    pull: (controller) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(soundUploadBody));
          controller.close();
          resolve();
        }, arrival);
      }),
  });
  const pending = legacy(
    new Request(`${gatewayUrl}/v1/uploads`, {
      method: "POST",
      headers: soundUpload().headers.map(([name, value]): [string, string] => [name, value]),
      body: slow,
      duplex: "half",
    } as RequestInit),
  );
  let settled = false;
  const settle = () => {
    settled = true;
  };
  void pending.then(settle, settle);
  await vi.advanceTimersByTimeAsync(arrival - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const response = await pending;
  // Served: it went on to the key lookup, which this Core then fails.
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ code: "storage_gateway_unavailable" });
  expect(wire.stats.calls).toBe(1);
});

it("bounds rejected scope logs without touching authorization or the Core", async () => {
  const { createStorageGatewayEntrypoint } = await import("../src/worker-main.js");
  const runtimeFactory = vi.fn(() => {
    throw new Error("must not reach a runtime");
  });
  const entry = createStorageGatewayEntrypoint({ runtimeFactory });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const a = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const b = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const seen = new Set<string>();
  const keys: string[] = [];
  const env = {
    STORAGE_SCOPE_LOG_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        const success = !seen.has(key);
        seen.add(key);
        return { success };
      },
    },
  };
  const request = (project: string) =>
    new Request(`${gatewayUrl}/v1/uploads`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + "k".repeat(43),
        "content-type": "application/json",
        "x-ohmyhost-egress-project-id": project,
        "idempotency-key": "scope-log-probe",
      },
      body: JSON.stringify({
        projectId: project === a ? b : a,
        environmentId: a,
        objectKey: "probe",
        contentType: "text/plain",
        contentLength: 1,
      }),
    });
  try {
    for (const project of [a, a, b]) {
      const answer = await entry.fetchForwarded(request(project), env, {
        caller: "wfp-egress-policy",
      });
      expect(answer.status).toBe(401);
    }
    expect(keys).toEqual([a, a, b]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const unavailable of [
      undefined,
      null,
      {},
      { STORAGE_SCOPE_LOG_LIMITER: {} },
      {
        STORAGE_SCOPE_LOG_LIMITER: {
          limit: async () => {
            throw new Error("private");
          },
        },
      },
    ]) {
      expect(
        (await entry.fetchForwarded(request(a), unavailable, { caller: "wfp-egress-policy" }))
          .status,
      ).toBe(401);
    }
    for (let i = 0; i < 2; i++)
      expect((await entry.fetchForwarded(request(a), env, null)).status).toBe(401);
    expect(keys.slice(-2)).toEqual(["unmarked", "unmarked"]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("k".repeat(43));
  } finally {
    warn.mockRestore();
  }
});

it("admits gateway RPC calls only for the exact egress marker and project without touching the Core", async () => {
  const wire = core();
  const createEntry = await forwardedEntrypoint(wire.env);
  const calls: string[] = [];
  const limiter = {
    limit: vi.fn(async ({ key }: { key: string }) => {
      calls.push(key);
      return { success: calls.length === 1 };
    }),
  };
  // No Core or provider configuration is needed to perform admission.
  const env = { GATEWAY_RATE_LIMITER: limiter };
  const entry = createEntry({ env });
  expect(await entry.permit(id(10))).toBe(true);
  expect(await entry.permit(id(10))).toBe(false);
  expect(calls).toEqual([id(10), id(10)]);
  for (const props of [
    undefined,
    null,
    {},
    { caller: "other" },
    { ...egressMarker, extra: true },
    [egressMarker],
  ]) {
    await expect(createEntry({ props, env }).permit(id(10))).rejects.toThrow();
  }
  for (const project of [
    null,
    {},
    "",
    "not-a-project",
    "81ARZ3NDEKTSV4RRFFQ69G5FAV",
    "01arz3ndektsv4rrffq69g5fav",
  ]) {
    await expect(entry.permit(project as string)).rejects.toThrow();
  }
  expect(limiter.limit).toHaveBeenCalledTimes(2);
  for (const badEnv of [
    {},
    { GATEWAY_RATE_LIMITER: {} },
    { GATEWAY_RATE_LIMITER: { limit: async () => ({}) } },
    { GATEWAY_RATE_LIMITER: { limit: async () => ({ success: 1 }) } },
    {
      GATEWAY_RATE_LIMITER: {
        limit: async () => {
          throw new Error("private limiter detail");
        },
      },
    },
  ]) {
    await expect(createEntry({ env: badEnv }).permit(id(10))).rejects.toThrow();
  }
  // The normal gateway inventory accepts its native binding as well.
  const { requireStorageGatewayBindings } = await import("../src/bindings.js");
  expect(requireStorageGatewayBindings({ ...bindings, ...env })).toEqual({ ...bindings, ...env });
  const { createStorageGatewayEntrypoint } = await import("../src/worker-main.js");
  const { createStorageGatewayRelayEntrypoint } = await import("../src/egress-entrypoint.js");
  const Relay = createStorageGatewayRelayEntrypoint(createStorageGatewayEntrypoint());
  const fixedLimiter = { limit: vi.fn(async () => ({ success: true })) };
  const relay = new Relay(
    {
      get props() {
        throw new Error("fixed-role relay must not inspect props");
      },
    } as never,
    { ...wire.env, GATEWAY_RATE_LIMITER: fixedLimiter } as never,
  );
  expect(await relay.permit(id(10))).toBe(true);
  expect(fixedLimiter.limit).toHaveBeenCalledExactlyOnceWith({ key: id(10) });
  const mismatch = await relay.fetch(
    build(
      specFor("/v1/uploads", {
        project: id(10),
        key: storageKey,
        body: uploadBody(id(20), id(11), "forged.bin"),
      }),
    ),
  );
  expect(mismatch.status).toBe(401);
  expect(wire.stats.calls).toBe(0);
});
