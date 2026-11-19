import { describe, expect, it, vi } from "vitest";

import {
  createWorkosWebhookIngress,
  type WorkosWebhookAuthStateProjection,
  type WorkosWebhookInboxRecord,
  type WorkosWebhookInboxRecorder,
} from "../src/index.js";

const NOW = new Date("2026-08-18T10:00:00.000Z");
const SIGNATURE_TIMESTAMP = NOW.getTime();
const SECRET = "fixture-webhook-secret";
const INBOX_EVENT_ID = "01K30MG1000000000000000000" as WorkosWebhookInboxRecord["inboxEventId"];

const encode = (value: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
};

const sign = async (rawBody: Uint8Array, secret = SECRET, at = SIGNATURE_TIMESTAMP) => {
  const prefix = encode(`${String(at)}.`);
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  message.set(prefix);
  message.set(rawBody, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(message)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const organizationEvent = (overrides: Readonly<Record<string, unknown>> = {}) =>
  JSON.stringify({
    id: "event_01K30WORKOS",
    event: "organization.updated",
    created_at: "2026-08-18T09:59:59.000Z",
    data: { id: "org_01K30WORKOS", name: "must-not-be-persisted" },
    ...overrides,
  });

const membershipEvent = (event = "organization_membership.created") =>
  JSON.stringify({
    id: "event_01K30MEMBERSHIP",
    event,
    created_at: "2026-08-18T09:59:59.000Z",
    data: {
      id: "om_01K30WORKOS",
      organization_id: "org_01K30WORKOS",
      user_id: "user_01K30WORKOS",
      role: { slug: "admin" },
    },
  });

const requestFor = async (
  rawBody: Uint8Array,
  options: {
    readonly secret?: string;
    readonly timestamp?: number;
    readonly signature?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) => {
  const timestamp = options.timestamp ?? SIGNATURE_TIMESTAMP;
  const signature = options.signature ?? (await sign(rawBody, options.secret ?? SECRET, timestamp));
  return new Request("https://ingress.test/webhooks/workos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "workos-signature": `t=${String(timestamp)},v1=${signature}`,
      ...options.headers,
    },
    body: Uint8Array.from(rawBody).buffer,
  });
};

const harness = (recordResult: "created" | "existing" = "created") => {
  const records: WorkosWebhookInboxRecord[] = [];
  const authStateProjections: (WorkosWebhookAuthStateProjection | undefined)[] = [];
  const recorder: WorkosWebhookInboxRecorder = {
    record: vi.fn(async (input, authStateProjection) => {
      records.push(input);
      authStateProjections.push(authStateProjection);
      return recordResult;
    }),
  };
  const secretResolver = { resolve: vi.fn(async () => SECRET) };
  const app = createWorkosWebhookIngress({
    secretReference: {
      kind: "secret-reference",
      provider: "workos",
      purpose: "webhook-verification",
      reference: "infisical://phase1/workos-webhook-secret",
    },
    secretResolver,
    inbox: recorder,
    eventIds: { next: vi.fn(() => INBOX_EVENT_ID) },
    clock: { now: vi.fn(() => new Date(NOW)) },
    maximumBodyBytes: 4_096,
    signatureToleranceMs: 300_000,
    maximumAttempts: 5,
  });
  return { app, authStateProjections, recorder, records, secretResolver };
};

describe("WorkOS webhook ingress", () => {
  it.each([
    ["secret reference", { secretReference: { reference: "" } }],
    ["body limit", { maximumBodyBytes: 0 }],
    ["signature tolerance", { signatureToleranceMs: -1 }],
    ["maximum attempts", { maximumAttempts: 0 }],
  ])("rejects an invalid %s at composition time", (_name, override) => {
    const dependencies = dependenciesForHarness();
    expect(() =>
      createWorkosWebhookIngress({
        ...dependencies,
        ...override,
        secretReference: {
          ...dependencies.secretReference,
          ...("secretReference" in override ? override.secretReference : {}),
        },
      } as never),
    ).toThrow();
  });

  it("verifies the exact raw bytes and commits only a minimized organization trigger", async () => {
    const { app, recorder, records } = harness();
    const rawBody = encode(`${organizationEvent()}\n`);

    const response = await app.fetch(await requestFor(rawBody));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: false });
    expect(recorder.record).toHaveBeenCalledOnce();
    expect(records).toEqual([
      expect.objectContaining({
        inboxEventId: INBOX_EVENT_ID,
        externalEventId: "event_01K30WORKOS",
        eventType: "organization.updated",
        receivedAt: NOW.toISOString(),
        signatureTimestamp: NOW.toISOString(),
        maxAttempts: 5,
        payload: {
          schemaVersion: "workos.organization-trigger.v1",
          workosOrganizationId: "org_01K30WORKOS",
        },
      }),
    ]);
    expect(records[0]?.bodyDigest).toHaveLength(32);
    expect(JSON.stringify(records[0]?.payload)).not.toContain("must-not-be-persisted");
  });

  it("records a signed future timestamp exactly at the tolerance", async () => {
    const { app, records } = harness();
    const timestamp = SIGNATURE_TIMESTAMP + 300_000;

    const response = await app.fetch(await requestFor(encode(organizationEvent()), { timestamp }));

    expect(response.status).toBe(200);
    expect(records).toEqual([
      expect.objectContaining({ signatureTimestamp: new Date(timestamp).toISOString() }),
    ]);
  });

  it("persists only membership identity fields and accepts exact provider retries idempotently", async () => {
    const { app, records } = harness("existing");
    const response = await app.fetch(await requestFor(encode(membershipEvent())));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: true });
    expect(records[0]?.payload).toEqual({
      schemaVersion: "workos.organization-trigger.v1",
      workosOrganizationId: "org_01K30WORKOS",
    });
    expect(JSON.stringify(records[0]?.payload)).not.toContain("user_01K30WORKOS");
    expect(JSON.stringify(records[0]?.payload)).not.toContain("om_01K30WORKOS");
  });

  it.each(["organization_membership.updated", "organization_membership.deleted"])(
    "opens an ordered barrier for %s without trusting role or status",
    async (event) => {
      const { app, authStateProjections, records } = harness();
      const response = await app.fetch(await requestFor(encode(membershipEvent(event))));

      expect(response.status).toBe(200);
      expect(records[0]?.payload).toEqual({
        schemaVersion: "workos.organization-trigger.v1",
        workosOrganizationId: "org_01K30WORKOS",
      });
      expect(authStateProjections).toEqual([
        {
          kind: "membership-barrier",
          workosOrganizationId: "org_01K30WORKOS",
          workosUserId: "user_01K30WORKOS",
          sourceEventId: "event_01K30MEMBERSHIP",
          eventCreatedAt: "2026-08-18T09:59:59.000Z",
        },
      ]);
      expect(JSON.stringify(authStateProjections)).not.toMatch(/admin|status/u);
    },
  );

  it("projects organization deletion while retaining the existing management trigger", async () => {
    const { app, authStateProjections, records } = harness();
    const response = await app.fetch(
      await requestFor(
        encode(organizationEvent({ event: "organization.deleted", data: { id: "org_deleted" } })),
      ),
    );

    expect(response.status).toBe(200);
    expect(records[0]?.payload).toEqual({
      schemaVersion: "workos.organization-trigger.v1",
      workosOrganizationId: "org_deleted",
    });
    expect(authStateProjections).toEqual([
      {
        kind: "organization-revocation",
        workosOrganizationId: "org_deleted",
        sourceEventId: "event_01K30WORKOS",
        effectiveAt: "2026-08-18T09:59:59.000Z",
      },
    ]);
  });

  it.each([true, false])(
    "minimizes session revocation with organization identity present=%s",
    async (withOrganization) => {
      const { app, authStateProjections, records } = harness();
      const response = await app.fetch(
        await requestFor(
          encode(
            organizationEvent({
              event: "session.revoked",
              data: {
                id: "session_01K30WORKOS",
                user_id: "user_01K30WORKOS",
                ...(withOrganization ? { organization_id: "org_01K30WORKOS" } : {}),
                ip_address: "must-not-be-persisted",
              },
            }),
          ),
        ),
      );

      expect(response.status).toBe(200);
      expect(records[0]?.payload).toEqual({ schemaVersion: "workos.authentication-state.v1" });
      expect(authStateProjections).toEqual([
        {
          kind: "session-revocation",
          sessionId: "session_01K30WORKOS",
          workosUserId: "user_01K30WORKOS",
          ...(withOrganization ? { workosOrganizationId: "org_01K30WORKOS" } : {}),
          sourceEventId: "event_01K30WORKOS",
          effectiveAt: "2026-08-18T09:59:59.000Z",
        },
      ]);
      expect(JSON.stringify(records[0]?.payload)).not.toContain("must-not-be-persisted");
    },
  );

  it("minimizes user deletion to an irreversible user revocation", async () => {
    const { app, authStateProjections, records } = harness();
    const response = await app.fetch(
      await requestFor(
        encode(
          organizationEvent({
            event: "user.deleted",
            data: { id: "user_deleted", email: "must-not-be-persisted@example.com" },
          }),
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(records[0]?.payload).toEqual({ schemaVersion: "workos.authentication-state.v1" });
    expect(authStateProjections).toEqual([
      {
        kind: "user-revocation",
        workosUserId: "user_deleted",
        sourceEventId: "event_01K30WORKOS",
        effectiveAt: "2026-08-18T09:59:59.000Z",
      },
    ]);
    expect(JSON.stringify(records[0]?.payload)).not.toContain("example.com");
  });

  it.each([
    [
      "missing signature",
      async () =>
        new Request("https://ingress.test/webhooks/workos", {
          method: "POST",
          body: organizationEvent(),
        }),
      401,
    ],
    [
      "wrong signature",
      async () => requestFor(encode(organizationEvent()), { signature: "a".repeat(64) }),
      401,
    ],
    [
      "stale replay",
      async () =>
        requestFor(encode(organizationEvent()), { timestamp: SIGNATURE_TIMESTAMP - 300_001 }),
      401,
    ],
    [
      "future replay",
      async () =>
        requestFor(encode(organizationEvent()), { timestamp: SIGNATURE_TIMESTAMP + 300_001 }),
      401,
    ],
    ["malformed JSON", async () => requestFor(encode("not-json")), 400],
    [
      "unsupported event",
      async () => requestFor(encode(organizationEvent({ event: "user.created" }))),
      422,
    ],
    [
      "invalid organization shape",
      async () => requestFor(encode(organizationEvent({ data: {} }))),
      422,
    ],
    [
      "session without user identity",
      async () =>
        requestFor(
          encode(
            organizationEvent({ event: "session.revoked", data: { id: "session_01K30WORKOS" } }),
          ),
        ),
      422,
    ],
    [
      "provider identity containing whitespace",
      async () => requestFor(encode(organizationEvent({ data: { id: "org invalid" } }))),
      422,
    ],
    [
      "blank provider event identity",
      async () => requestFor(encode(organizationEvent({ id: " " }))),
      422,
    ],
  ])("rejects %s without resolving persistence", async (_name, makeRequest, status) => {
    const { app, recorder } = harness();
    const response = await app.fetch(await makeRequest());
    expect(response.status).toBe(status);
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("rejects oversized declared and streamed bodies before secret resolution or persistence", async () => {
    const { app, recorder, secretResolver } = harness();
    const declared = await app.fetch(
      await requestFor(encode(organizationEvent()), { headers: { "content-length": "999999" } }),
    );
    expect(declared.status).toBe(413);

    const oversized = encode("x".repeat(4_097));
    const streamed = await app.fetch(await requestFor(oversized));
    expect(streamed.status).toBe(413);
    expect(secretResolver.resolve).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("rejects a malformed declared length and an absent body before persistence", async () => {
    const { app, recorder } = harness();
    const malformedLength = await app.fetch(
      await requestFor(encode(organizationEvent()), { headers: { "content-length": "nope" } }),
    );
    expect(malformedLength.status).toBe(400);

    const absentBody = await app.fetch(
      new Request("https://ingress.test/webhooks/workos", {
        method: "POST",
        headers: {
          "workos-signature": `t=${String(SIGNATURE_TIMESTAMP)},v1=${"a".repeat(64)}`,
        },
      }),
    );
    expect(absentBody.status).toBe(401);
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("fails closed when the injected secret resolver or durable inbox fails", async () => {
    const unresolved = harness();
    vi.mocked(unresolved.secretResolver.resolve).mockRejectedValueOnce(new Error("unavailable"));
    const unresolvedResponse = await unresolved.app.fetch(
      await requestFor(encode(organizationEvent())),
    );
    expect(unresolvedResponse.status).toBe(503);
    expect(unresolved.recorder.record).not.toHaveBeenCalled();

    const persistence = harness();
    vi.mocked(persistence.recorder.record).mockRejectedValueOnce(new Error("database unavailable"));
    const persistenceResponse = await persistence.app.fetch(
      await requestFor(encode(organizationEvent())),
    );
    expect(persistenceResponse.status).toBe(503);

    for (const additional of [
      undefined,
      [""],
      [SECRET, "another"],
      [new Uint8Array(2)],
      new Array(1),
    ]) {
      const malformed = dependenciesForHarness();
      Object.assign(malformed.secretResolver, { resolveAdditional: () => additional });
      const response = await createWorkosWebhookIngress(malformed).fetch(
        await requestFor(encode(organizationEvent())),
      );
      expect(response.status).toBe(503);
      expect(malformed.inbox.record).not.toHaveBeenCalled();
    }

    const delayed = dependenciesForHarness();
    delayed.secretResolver.resolve.mockImplementationOnce(async () => {
      delayed.clock.now.mockReturnValue(new Date(NOW.getTime() + 300_001));
      return SECRET;
    });
    const delayedResponse = await createWorkosWebhookIngress(delayed).fetch(
      await requestFor(encode(organizationEvent())),
    );
    expect(delayedResponse.status).toBe(401);
    expect(delayed.inbox.record).not.toHaveBeenCalled();
  });

  it("rejects an event identity collision and exposes no secret or internal failure text", async () => {
    const { app, recorder } = harness();
    vi.mocked(recorder.record).mockRejectedValueOnce(
      Object.assign(new Error("secret database detail"), {
        code: "webhook_event_identity_conflict",
      }),
    );
    const response = await app.fetch(await requestFor(encode(organizationEvent())));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("database detail");
  });

  it("does not expose another route or accept another method", async () => {
    const { app, recorder } = harness();
    expect((await app.fetch(new Request("https://ingress.test/"))).status).toBe(404);
    expect(
      (await app.fetch(new Request("https://ingress.test/webhooks/workos", { method: "GET" })))
        .status,
    ).toBe(404);
    expect(recorder.record).not.toHaveBeenCalled();
  });
});

const dependenciesForHarness = () => ({
  secretReference: {
    kind: "secret-reference" as const,
    provider: "workos" as const,
    purpose: "webhook-verification" as const,
    reference: "infisical://phase1/workos-webhook-secret",
  },
  secretResolver: { resolve: vi.fn(async () => SECRET) },
  inbox: { record: vi.fn(async () => "created" as const) },
  eventIds: { next: vi.fn(() => INBOX_EVENT_ID) },
  clock: { now: vi.fn(() => new Date(NOW)) },
  maximumBodyBytes: 4_096,
  signatureToleranceMs: 300_000,
  maximumAttempts: 5,
});
