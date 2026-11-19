import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createGithubWebhookIngress,
  type GithubWebhookInboxRecord,
  type GithubWebhookInboxRecorder,
  type GithubWebhookSecretReference,
} from "../src/index.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const SECRET_TEXT = "fixture-github-webhook-secret";
const SECRET = new TextEncoder().encode(SECRET_TEXT);
const DELIVERY_ID = "123e4567-e89b-42d3-a456-426614174000";
const BEFORE_SHA = "1111111111111111111111111111111111111111";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const INBOX_EVENT_ID = "01K34BWZG00000000000000000" as GithubWebhookInboxRecord["inboxEventId"];

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function pushPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    installation: { id: 123 },
    repository: { id: 987_654, full_name: "acme/widget" },
    ref: "refs/heads/main",
    deleted: false,
    before: BEFORE_SHA,
    after: SHA,
    sender: { login: "must-not-be-stored", token: "ghp_must-not-be-stored" },
    pusher: { email: "private@example.test" },
    ...overrides,
  });
}

function signature(body: Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function requestFor(
  body: Uint8Array,
  overrides: {
    readonly deliveryId?: string;
    readonly eventName?: string;
    readonly signature?: string;
    readonly contentLength?: string | null;
    readonly contentEncoding?: string;
    readonly signal?: AbortSignal;
  } = {},
): Request {
  const headers = new Headers({
    "content-length": overrides.contentLength ?? String(body.byteLength),
    "content-type": "application/json",
    "x-github-delivery": overrides.deliveryId ?? DELIVERY_ID,
    "x-github-event": overrides.eventName ?? "push",
    "x-hub-signature-256": overrides.signature ?? signature(body),
  });
  if (overrides.contentLength === null) headers.delete("content-length");
  if (overrides.contentEncoding !== undefined) {
    headers.set("content-encoding", overrides.contentEncoding);
  }
  return new Request("https://ingress.test/webhooks/github", {
    method: "POST",
    headers,
    body: Uint8Array.from(body).buffer,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
}

function harness(result: "created" | "existing" = "created") {
  const records: GithubWebhookInboxRecord[] = [];
  const inbox: GithubWebhookInboxRecorder = {
    record: vi.fn(async (input) => {
      records.push(input);
      return result;
    }),
  };
  const secretResolver = {
    resolve: vi.fn(async (reference: GithubWebhookSecretReference, signal: AbortSignal) => {
      void reference;
      void signal;
      return Uint8Array.from(SECRET);
    }),
  };
  const app = createGithubWebhookIngress({
    secretReference: {
      kind: "secret-reference",
      provider: "github",
      purpose: "webhook-verification",
      reference: "infisical://phase1/github-webhook-secret",
    },
    secretResolver,
    inbox,
    eventIds: { next: vi.fn(() => INBOX_EVENT_ID) },
    clock: { now: vi.fn(() => new Date(NOW)) },
    maximumBodyBytes: 4_096,
    maximumAttempts: 5,
    externalOperationTimeoutMs: 9_000,
  });
  return { app, inbox, records, secretResolver };
}

describe("GitHub webhook ingress", () => {
  it.each([
    ["secret reference", { secretReference: { reference: "" } }],
    ["body limit", { maximumBodyBytes: 0 }],
    ["maximum attempts", { maximumAttempts: 0 }],
    ["external operation timeout", { externalOperationTimeoutMs: 0 }],
    ["fractional external operation timeout", { externalOperationTimeoutMs: 1.5 }],
    ["external operation timeout ceiling", { externalOperationTimeoutMs: 10_000 }],
  ])("rejects an invalid %s at composition time", (_name, override) => {
    const dependencies = dependenciesForHarness();
    expect(() =>
      createGithubWebhookIngress({
        ...dependencies,
        ...override,
        secretReference: {
          ...dependencies.secretReference,
          ...("secretReference" in override ? override.secretReference : {}),
        },
      } as never),
    ).toThrow();
  });

  it("verifies exact raw bytes and records only the minimized push trigger", async () => {
    const { app, records, inbox } = harness();
    const body = encode(`${pushPayload()}\n`);
    const response = await app.fetch(requestFor(body));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: false });
    expect(inbox.record).toHaveBeenCalledOnce();
    expect(records).toEqual([
      expect.objectContaining({
        inboxEventId: INBOX_EVENT_ID,
        externalEventId: DELIVERY_ID,
        eventType: "push",
        receivedAt: NOW.toISOString(),
        maxAttempts: 5,
        payload: {
          schemaVersion: "github.push.v1",
          installationId: 123,
          repositoryId: 987_654,
          repositoryFullName: "acme/widget",
          ref: "refs/heads/main",
          beforeCommitSha: BEFORE_SHA,
          commitSha: SHA,
          deleted: false,
        },
      }),
    ]);
    expect(Array.from(records[0]?.bodyDigest ?? [])).toEqual(
      Array.from(createHash("sha256").update(body).digest()),
    );
    const stored = JSON.stringify(records[0]);
    expect(stored).not.toContain("must-not-be-stored");
    expect(stored).not.toContain("private@example.test");
    expect(stored).not.toContain("ghp_");
    expect(stored).not.toContain(signature(body));
    expect(stored).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(records[0]?.payload)).not.toContain(DELIVERY_ID);
    expect(records[0]?.payload).not.toHaveProperty("eventName");
  });

  it("records branch creation and deletion with explicit nullable commit identities", async () => {
    const creation = harness();
    const createdBody = encode(pushPayload({ before: "0".repeat(40) }));
    expect((await creation.app.fetch(requestFor(createdBody))).status).toBe(202);
    expect(creation.records[0]?.payload).toMatchObject({
      beforeCommitSha: null,
      commitSha: SHA,
      deleted: false,
    });

    const deletion = harness();
    const deletedBody = encode(
      pushPayload({ deleted: true, before: BEFORE_SHA, after: "0".repeat(40) }),
    );
    expect((await deletion.app.fetch(requestFor(deletedBody))).status).toBe(202);
    expect(deletion.records[0]?.payload).toMatchObject({
      beforeCommitSha: BEFORE_SHA,
      commitSha: null,
      deleted: true,
    });
  });

  it("returns 200 for an exact durable duplicate", async () => {
    const { app } = harness("existing");
    const response = await app.fetch(requestFor(encode(pushPayload())));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it("accepts a signed body without Content-Length and persists after streaming", async () => {
    const { app, records } = harness();
    const body = encode(pushPayload());
    const request = requestFor(body, { contentLength: null });
    const removeListener = vi.spyOn(request.signal, "removeEventListener");
    const response = await app.fetch(request);
    expect(response.status).toBe(202);
    expect(records).toHaveLength(1);
    expect(Array.from(records[0]?.bodyDigest ?? [])).toEqual(
      Array.from(createHash("sha256").update(body).digest()),
    );
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("records installation withdrawals by id only and ignores every other installation action", async () => {
    const deleted = harness();
    const removed = harness();
    const created = harness();
    const deletedBody = encode(
      JSON.stringify({
        action: "deleted",
        installation: { id: 123, account: { login: "private-owner" } },
        sender: { login: "must-not-be-stored" },
      }),
    );
    const accepted = await deleted.app.fetch(
      requestFor(deletedBody, { eventName: "installation" }),
    );
    expect(accepted.status).toBe(202);
    expect(deleted.records).toHaveLength(1);
    expect(deleted.records[0]).toMatchObject({
      eventType: "installation",
      externalEventId: DELIVERY_ID,
      payload: {
        schemaVersion: "github.installation.v1",
        action: "deleted",
        installationId: 123,
        removedRepositoryIds: [],
      },
    });
    expect(JSON.stringify(deleted.records[0]?.payload)).not.toContain("must-not-be-stored");

    const removedBody = encode(
      JSON.stringify({
        action: "removed",
        installation: { id: 123 },
        repositories_removed: [{ id: 77 }],
      }),
    );
    await removed.app.fetch(requestFor(removedBody, { eventName: "installation_repositories" }));
    expect(removed.records[0]).toMatchObject({
      eventType: "installation_repositories",
      payload: {
        schemaVersion: "github.installation.v1",
        action: "repositories_removed",
        installationId: 123,
        removedRepositoryIds: [77],
      },
    });

    const ignored = await created.app.fetch(
      requestFor(encode(JSON.stringify({ action: "created", installation: { id: 123 } })), {
        eventName: "installation",
      }),
    );
    expect(ignored.status).toBe(200);
    await expect(ignored.json()).resolves.toEqual({ accepted: true, ignored: true });
    expect(created.inbox.record).not.toHaveBeenCalled();
  });

  it("authenticates ping notifications and refuses unsigned installation events", async () => {
    for (const eventName of ["ping", "installation", "installation_repositories"]) {
      const valid = harness();
      const body = encode(eventName === "ping" ? "not-json-and-never-parsed" : "{}");
      if (eventName === "ping") {
        const accepted = await valid.app.fetch(requestFor(body, { eventName }));
        expect(accepted.status).toBe(200);
        await expect(accepted.json()).resolves.toEqual({ accepted: true, ignored: true });
        expect(valid.inbox.record).not.toHaveBeenCalled();
      }

      const invalid = harness();
      const rejected = await invalid.app.fetch(
        requestFor(body, { eventName, signature: `sha256=${"0".repeat(64)}` }),
      );
      expect(rejected.status).toBe(401);
      await expect(rejected.json()).resolves.toEqual({ error: "invalid_webhook_signature" });
      expect(invalid.inbox.record).not.toHaveBeenCalled();
    }
  });

  it("rejects other authenticated event types without persistence", async () => {
    const { app, inbox } = harness();
    const body = encode("authenticated-but-not-a-push-document");
    const response = await app.fetch(requestFor(body, { eventName: "issues" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_webhook_event" });
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("rejects a bad signature before attempting to parse malformed JSON", async () => {
    const { app, inbox } = harness();
    const response = await app.fetch(
      requestFor(encode("not-json"), { signature: `sha256=${"0".repeat(64)}` }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_webhook_signature" });
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("does not disclose event classification before signature authentication", async () => {
    const { app, inbox } = harness();
    const body = encode("not-json");
    const request = requestFor(body, { eventName: "issues" });
    request.headers.delete("x-hub-signature-256");
    const response = await app.fetch(request);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_webhook_signature" });
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it.each([
    ["missing delivery", { deliveryId: "" }, 400, "invalid_webhook_headers"],
    [
      "noncanonical delivery",
      { deliveryId: DELIVERY_ID.toUpperCase() },
      400,
      "invalid_webhook_headers",
    ],
    ["malformed event", { eventName: "push request" }, 400, "invalid_webhook_headers"],
    ["long event", { eventName: `p${"u".repeat(64)}` }, 400, "invalid_webhook_headers"],
    ["malformed length", { contentLength: "unknown" }, 400, "invalid_content_length"],
    ["negative length", { contentLength: "-1" }, 400, "invalid_content_length"],
    ["unsafe length", { contentLength: "999999999999999999999" }, 400, "invalid_content_length"],
    ["oversized declared body", { contentLength: "4097" }, 413, "webhook_body_too_large"],
    ["compressed body", { contentEncoding: "gzip" }, 415, "unsupported_content_encoding"],
  ])("rejects %s with a stable closed response", async (_name, overrides, status, code) => {
    const { app, inbox, secretResolver } = harness();
    const response = await app.fetch(requestFor(encode(pushPayload()), overrides));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
    expect(inbox.record).not.toHaveBeenCalled();
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });

  it("enforces the streamed cap and exact declared byte length", async () => {
    const streamed = harness();
    const tooLarge = encode("x".repeat(4_097));
    const oversized = await streamed.app.fetch(requestFor(tooLarge, { contentLength: null }));
    expect(oversized.status).toBe(413);
    expect(streamed.secretResolver.resolve).not.toHaveBeenCalled();

    const mismatch = harness();
    const body = encode(pushPayload());
    const truncated = await mismatch.app.fetch(
      requestFor(body, { contentLength: String(body.byteLength - 1) }),
    );
    expect(truncated.status).toBe(400);
    await expect(truncated.json()).resolves.toEqual({ error: "invalid_content_length" });
  });

  it("keeps two concurrent 25 MiB pushes apart, each digested as it was sent", async () => {
    const limit = 25 * 1024 * 1024;
    const recorded: GithubWebhookInboxRecord[] = [];
    const app = createGithubWebhookIngress({
      ...dependenciesForHarness(),
      inbox: {
        record: vi.fn(async (record: GithubWebhookInboxRecord) => {
          recorded.push(record);
          return "created" as const;
        }),
      },
      maximumBodyBytes: limit,
    });
    const bodies = new Map<string, Uint8Array>([
      [
        "123e4567-e89b-42d3-a456-426614174001",
        encode(pushPayload({ commits: [{ message: "a".repeat(limit - 2_048) }] })),
      ],
      [
        "123e4567-e89b-42d3-a456-426614174002",
        encode(pushPayload({ commits: [{ message: "b".repeat(limit - 2_048) }] })),
      ],
    ]);
    const responses = await Promise.all(
      [...bodies].map(([deliveryId, body]) => app.fetch(requestFor(body, { deliveryId }))),
    );
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(recorded).toHaveLength(2);
    for (const record of recorded) {
      const sent = bodies.get(record.externalEventId);
      if (sent === undefined) throw new Error("unexpected delivery");
      expect(Buffer.from(record.bodyDigest).toString("hex")).toBe(
        createHash("sha256").update(sent).digest("hex"),
      );
    }

    // A stream shorter than its declared length is refused, never returned with unfilled bytes.
    const short = encode(pushPayload());
    const shortStream = await app.fetch(
      requestFor(short, { contentLength: String(short.byteLength + 1) }),
    );
    expect(shortStream.status).toBe(400);
    await expect(shortStream.json()).resolves.toEqual({ error: "invalid_content_length" });
  }, 30_000);

  it("accepts explicit identity encoding and rejects malformed authenticated push payloads", async () => {
    const valid = harness();
    expect(
      (await valid.app.fetch(requestFor(encode(pushPayload()), { contentEncoding: "IDENTITY" })))
        .status,
    ).toBe(202);

    const malformed = harness();
    const response = await malformed.app.fetch(requestFor(encode("not-json")));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_webhook_payload" });
    expect(malformed.inbox.record).not.toHaveBeenCalled();
  });

  it("fails closed on an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { app, secretResolver } = harness();
    const response = await app.fetch(
      requestFor(encode(pushPayload()), { signal: controller.signal }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "webhook_request_aborted" });
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });

  it("cancels an in-flight body stream when the request is aborted", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
    });
    const request = new Request("https://ingress.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-length": "1",
        "x-github-delivery": DELIVERY_ID,
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const { app, secretResolver } = harness();
    const pending = app.fetch(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "webhook_request_aborted" });
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });

  it("cancels a never-ending body stream at the route-wide deadline", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      let markPullStarted: (() => void) | undefined;
      const pullStarted = new Promise<void>((resolve) => {
        markPullStarted = resolve;
      });
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        pull: () => {
          markPullStarted?.();
          return new Promise(() => undefined);
        },
        cancel,
      });
      const request = new Request("https://ingress.test/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-delivery": DELIVERY_ID,
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const removeListener = vi.spyOn(request.signal, "removeEventListener");
      const dependencies = dependenciesForHarness();
      dependencies.externalOperationTimeoutMs = 25;
      const app = createGithubWebhookIngress(dependencies);
      const pending = app.fetch(request);
      await pullStarted;
      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "webhook_ingress_timeout" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(dependencies.secretResolver.resolve).not.toHaveBeenCalled();
      expect(dependencies.inbox.record).not.toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("sanitizes secret-resolution, clock, inbox, and identity-conflict failures", async () => {
    const body = encode(pushPayload());

    const secret = harness();
    vi.mocked(secret.secretResolver.resolve).mockRejectedValueOnce(
      new Error(`resolver exposed ${SECRET_TEXT}`),
    );
    await expectClosedFailure(secret.app, requestFor(body), 503, "webhook_secret_unavailable");

    const invalidSecret = harness();
    vi.mocked(invalidSecret.secretResolver.resolve).mockResolvedValueOnce("raw-secret" as never);
    await expectClosedFailure(
      invalidSecret.app,
      requestFor(body),
      503,
      "webhook_secret_unavailable",
    );

    for (const additional of [
      undefined,
      [new Uint8Array()],
      [SECRET, SECRET],
      [SECRET_TEXT],
      new Array(1),
    ]) {
      const malformed = dependenciesForHarness();
      Object.assign(malformed.secretResolver, { resolveAdditional: () => additional });
      await expectClosedFailure(
        createGithubWebhookIngress(malformed),
        requestFor(body),
        503,
        "webhook_secret_unavailable",
      );
      expect(malformed.inbox.record).not.toHaveBeenCalled();
    }

    const clockDependencies = dependenciesForHarness();
    clockDependencies.clock.now.mockReturnValueOnce(new Date(Number.NaN));
    const invalidClockApp = createGithubWebhookIngress(clockDependencies);
    await expectClosedFailure(
      invalidClockApp,
      requestFor(body),
      503,
      "webhook_ingress_unavailable",
    );

    const inbox = harness();
    vi.mocked(inbox.inbox.record).mockRejectedValueOnce(
      new Error(`database exposed ${SECRET_TEXT}`),
    );
    await expectClosedFailure(inbox.app, requestFor(body), 503, "webhook_inbox_unavailable");

    const conflict = harness();
    vi.mocked(conflict.inbox.record).mockRejectedValueOnce(
      Object.assign(new Error(`conflict exposed ${SECRET_TEXT}`), {
        code: "webhook_event_identity_conflict",
      }),
    );
    await expectClosedFailure(
      conflict.app,
      requestFor(body),
      409,
      "webhook_event_identity_conflict",
    );
  });

  it("aborts a timed-out secret resolution and ignores its late success", async () => {
    vi.useFakeTimers();
    try {
      const dependencies = dependenciesForHarness();
      dependencies.externalOperationTimeoutMs = 25;
      let signal: AbortSignal | undefined;
      let resolveLate: ((value: Uint8Array<ArrayBuffer>) => void) | undefined;
      dependencies.secretResolver.resolve.mockImplementationOnce((_reference, operationSignal) => {
        signal = operationSignal;
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      });
      const app = createGithubWebhookIngress(dependencies);
      const pending = app.fetch(requestFor(encode(pushPayload())));
      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "webhook_secret_unavailable" });
      expect(signal?.aborted).toBe(true);
      resolveLate?.(Uint8Array.from(SECRET));
      await vi.runAllTimersAsync();
      expect(dependencies.inbox.record).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a timed-out inbox write and never turns a late commit into a 2xx", async () => {
    vi.useFakeTimers();
    try {
      const dependencies = dependenciesForHarness();
      dependencies.externalOperationTimeoutMs = 25;
      let signal: AbortSignal | undefined;
      let resolveLate: ((value: "created") => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      dependencies.inbox.record.mockImplementationOnce((_record, operationSignal) => {
        signal = operationSignal;
        markStarted?.();
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      });
      const app = createGithubWebhookIngress(dependencies);
      const pending = app.fetch(requestFor(encode(pushPayload())));
      await started;
      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "webhook_inbox_unavailable" });
      expect(signal?.aborted).toBe(true);
      resolveLate?.("created");
      await vi.runAllTimersAsync();
      expect(response.status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the shared deadline timer after a successful response", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const dependencies = dependenciesForHarness();
      let resolverSignal: AbortSignal | undefined;
      let inboxSignal: AbortSignal | undefined;
      dependencies.secretResolver.resolve.mockImplementationOnce(async (_reference, signal) => {
        resolverSignal = signal;
        return Uint8Array.from(SECRET);
      });
      dependencies.inbox.record.mockImplementationOnce(async (_record, signal) => {
        inboxSignal = signal;
        return "created";
      });
      const app = createGithubWebhookIngress(dependencies);
      const response = await app.fetch(requestFor(encode(pushPayload())));
      expect(response.status).toBe(202);
      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(resolverSignal?.aborted).toBe(false);
      expect(inboxSignal).toBe(resolverSignal);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not expose another route or method", async () => {
    const { app, inbox } = harness();
    expect((await app.fetch(new Request("https://ingress.test/"))).status).toBe(404);
    expect(
      (await app.fetch(new Request("https://ingress.test/webhooks/github", { method: "GET" })))
        .status,
    ).toBe(404);
    expect(inbox.record).not.toHaveBeenCalled();
  });
});

async function expectClosedFailure(
  app: ReturnType<typeof createGithubWebhookIngress>,
  request: Request,
  status: number,
  code: string,
): Promise<void> {
  const response = await app.fetch(request);
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: code });
  expect(text).not.toContain(SECRET_TEXT);
  expect(text).not.toContain("exposed");
}

function dependenciesForHarness() {
  return {
    secretReference: {
      kind: "secret-reference" as const,
      provider: "github" as const,
      purpose: "webhook-verification" as const,
      reference: "infisical://phase1/github-webhook-secret",
    },
    secretResolver: {
      resolve: vi.fn(async (reference: GithubWebhookSecretReference, signal: AbortSignal) => {
        void reference;
        void signal;
        return Uint8Array.from(SECRET);
      }),
    },
    inbox: {
      record: vi.fn(async (record: GithubWebhookInboxRecord, signal: AbortSignal) => {
        void record;
        void signal;
        return "created" as const;
      }),
    },
    eventIds: { next: vi.fn(() => INBOX_EVENT_ID) },
    clock: { now: vi.fn(() => new Date(NOW)) },
    maximumBodyBytes: 4_096,
    maximumAttempts: 5,
    externalOperationTimeoutMs: 9_000,
  };
}
