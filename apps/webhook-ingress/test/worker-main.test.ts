import { describe, expect, it, vi } from "vitest";

import type { Clock, WorkosWebhookEventIdSource } from "../src/index.js";
import {
  createSystemWebhookClock,
  createSystemWebhookEventIds,
  createWorkosWebhookWorkerEntrypoint,
  type WorkosWebhookWorkerRawBindings,
} from "../src/worker-main.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const SECRET = "whsec_sandbox_fixture";
const GITHUB_SECRET = "github_webhook_sandbox_fixture";
const EXTRA_SECRET = "workos_webhook_replacement_fixture";
const EXTRA_GITHUB_SECRET = "github_webhook_replacement_fixture";
const EXTRA_EXPIRES_AT = new Date(NOW.getTime() + 60_000).toISOString();
const extra = (secret: string, expiresAt = EXTRA_EXPIRES_AT) =>
  JSON.stringify([{ secret, expiresAt }]);
const INBOX_EVENT_ID = "01K30MG1000000000000000000" as ReturnType<
  WorkosWebhookEventIdSource["next"]
>;

const runtimeFixture = () => ({
  recordWorkosWebhook: vi.fn<(input: unknown) => Promise<string>>(async () => "created"),
  recordGithubWebhook: vi.fn<(input: unknown) => Promise<string>>(async () => "created"),
  recordStripeWebhook: vi.fn<(input: unknown) => Promise<string>>(async () => "created"),
});

const bindings = (
  runtime: unknown = runtimeFixture(),
): WorkosWebhookWorkerRawBindings & Record<string, unknown> => ({
  CONTROL_RUNTIME: runtime,
  GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
  WORKOS_WEBHOOK_SECRET: SECRET,
});

const encode = (value: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
};

const signedRequest = async (
  secret = SECRET,
  url = "https://workos-webhook.internal/webhooks/workos",
): Promise<Request> => {
  const rawBody = encode(
    JSON.stringify({
      id: "event_sandbox",
      event: "organization.updated",
      created_at: "2026-08-19T11:59:59.000Z",
      data: { id: "org_sandbox", name: "must-not-be-persisted" },
    }),
  );
  const timestamp = NOW.getTime();
  const prefix = encode(`${String(timestamp)}.`);
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
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "workos-signature": `t=${String(timestamp)},v1=${signature}`,
    },
    body: rawBody,
  });
};

const signedGithubRequest = async (secret = GITHUB_SECRET, paddingBytes = 0): Promise<Request> => {
  const rawBody = encode(
    JSON.stringify({
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      deleted: false,
      installation: { id: 154436098 },
      repository: { id: 1339976528, full_name: "aixyte/ohmyho.st" },
      // A push lists up to 2,048 commits with their changed paths, so a large push is far above 1 MiB.
      commits: paddingBytes > 0 ? [{ message: "x".repeat(paddingBytes) }] : [],
    }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://webhook-ingress.internal/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "123e4567-e89b-42d3-a456-426614174000",
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: rawBody,
  });
};

const configured = (): WorkosWebhookWorkerRawBindings => ({
  ...bindings(),
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_ACCOUNT_ID: "acct_fixture",
  STRIPE_MODE: "test",
  RESEND_WEBHOOK_SECRET: "whsec_fixture",
  RESEND_INGRESS_RUNTIME: { readReceipt: async () => null, ingest: async () => undefined },
});

const worker = createWorkosWebhookWorkerEntrypoint({
  clockFactory: (): Clock => ({ now: () => new Date(NOW) }),
  eventIdsFactory: (): WorkosWebhookEventIdSource => ({ next: () => INBOX_EVENT_ID }),
});

describe("private WorkOS webhook Worker composition", () => {
  it("admits a signed GitHub push above 1 MiB, as a large push always is", async () => {
    const runtime = runtimeFixture();

    const response = await worker.fetch(
      await signedGithubRequest(GITHUB_SECRET, 3 * 1024 * 1024),
      bindings(runtime),
    );

    expect(response.status).toBe(202);
    expect(runtime.recordGithubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: "123e4567-e89b-42d3-a456-426614174000" }),
    );
  });

  it("composes an exact signed GitHub push into the Core ingress capability", async () => {
    const runtime = runtimeFixture();

    const response = await worker.fetch(await signedGithubRequest(), bindings(runtime));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: false });
    expect(runtime.recordGithubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxEventId: INBOX_EVENT_ID,
        externalEventId: "123e4567-e89b-42d3-a456-426614174000",
        eventType: "push",
        payload: {
          schemaVersion: "github.push.v1",
          installationId: 154436098,
          repositoryId: 1339976528,
          repositoryFullName: "aixyte/ohmyho.st",
          ref: "refs/heads/main",
          beforeCommitSha: "a".repeat(40),
          commitSha: "b".repeat(40),
          deleted: false,
        },
      }),
    );
    expect(runtime.recordWorkosWebhook).not.toHaveBeenCalled();
    runtime.recordGithubWebhook.mockClear();
    const request = await signedGithubRequest(EXTRA_GITHUB_SECRET);
    const rawBody = await request.clone().text();
    const parse = vi.spyOn(JSON, "parse");
    try {
      const rollover = {
        ...bindings(runtime),
        GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_GITHUB_SECRET),
        WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: "invalid-other-purpose-json",
      };
      expect((await worker.fetch(request, rollover)).status).toBe(202);
      expect(runtime.recordGithubWebhook).toHaveBeenCalledOnce();
      expect(parse.mock.calls.filter(([text]) => text === rawBody)).toHaveLength(1);
      expect(rollover.GITHUB_WEBHOOK_SECRET).toBe(GITHUB_SECRET);
      expect((await worker.fetch(await signedGithubRequest(), rollover)).status).toBe(202);
    } finally {
      parse.mockRestore();
    }
    runtime.recordGithubWebhook.mockClear();
    expect(
      (
        await worker.fetch(await signedGithubRequest(EXTRA_GITHUB_SECRET), {
          ...bindings(runtime),
          GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_GITHUB_SECRET, NOW.toISOString()),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(await signedGithubRequest(EXTRA_GITHUB_SECRET), {
          ...bindings(runtime),
          WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_GITHUB_SECRET),
        })
      ).status,
    ).toBe(401);
    expect(runtime.recordGithubWebhook).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(await signedGithubRequest(), {
          ...bindings(runtime),
          GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_GITHUB_SECRET, NOW.toISOString()),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await worker.fetch(await signedGithubRequest(), {
          ...bindings(runtime),
          GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: "[]",
        })
      ).status,
    ).toBe(202);
  });

  it("accepts only the scoped WorkOS rotation marker and still verifies the signature", async () => {
    const runtime = runtimeFixture();
    const marker = "omh_rotation=0123456789abcdef0123456789abcdef";
    const url = `https://workos-webhook.internal/webhooks/workos?${marker}`;
    expect((await worker.fetch(await signedRequest(SECRET, url), bindings(runtime))).status).toBe(
      200,
    );
    expect(runtime.recordWorkosWebhook).toHaveBeenCalledOnce();
    expect((await worker.fetch(await signedRequest("wrong", url), bindings(runtime))).status).toBe(
      401,
    );
    for (const query of [`${marker}&other=1`, `${marker}&${marker}`, "omh_rotation=bad"]) {
      expect(
        (
          await worker.fetch(
            await signedRequest(SECRET, `https://workos-webhook.internal/webhooks/workos?${query}`),
            bindings(runtime),
          )
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await worker.fetch(
          new Request(`https://workos-webhook.internal/webhooks/github?${marker}`, {
            method: "POST",
          }),
          bindings(runtime),
        )
      ).status,
    ).toBe(404);
    expect(runtime.recordWorkosWebhook).toHaveBeenCalledOnce();
  });

  it("composes the signed internal route into the Core ingress capability", async () => {
    const runtime = runtimeFixture();

    const response = await worker.fetch(await signedRequest(), bindings(runtime));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: false });
    expect(runtime.recordWorkosWebhook).toHaveBeenCalledOnce();
    expect(runtime.recordWorkosWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxEventId: INBOX_EVENT_ID,
        externalEventId: "event_sandbox",
        eventType: "organization.updated",
        payload: {
          schemaVersion: "workos.organization-trigger.v1",
          workosOrganizationId: "org_sandbox",
        },
      }),
    );
    runtime.recordWorkosWebhook.mockClear();
    const request = await signedRequest(EXTRA_SECRET);
    const rawBody = await request.clone().text();
    const parse = vi.spyOn(JSON, "parse");
    try {
      const rollover = {
        ...bindings(runtime),
        WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET),
        GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: "invalid-other-purpose-json",
      };
      expect((await worker.fetch(request, rollover)).status).toBe(200);
      expect(runtime.recordWorkosWebhook).toHaveBeenCalledOnce();
      expect(parse.mock.calls.filter(([text]) => text === rawBody)).toHaveLength(1);
      expect(rollover.WORKOS_WEBHOOK_SECRET).toBe(SECRET);
      expect((await worker.fetch(await signedRequest(), rollover)).status).toBe(200);
    } finally {
      parse.mockRestore();
    }
    runtime.recordWorkosWebhook.mockClear();
    expect(
      (
        await worker.fetch(await signedRequest(EXTRA_SECRET), {
          ...bindings(runtime),
          WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET, NOW.toISOString()),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(await signedRequest(EXTRA_SECRET), {
          ...bindings(runtime),
          GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET),
        })
      ).status,
    ).toBe(401);
    expect(runtime.recordWorkosWebhook).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(await signedRequest(), {
          ...bindings(runtime),
          WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET, NOW.toISOString()),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(await signedRequest(), {
          ...bindings(runtime),
          WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: "[]",
        })
      ).status,
    ).toBe(200);
    runtime.recordWorkosWebhook.mockClear();
    const invalidClock = createWorkosWebhookWorkerEntrypoint({
      clockFactory: () => ({ now: () => new Date(Number.NaN) }),
      eventIdsFactory: () => ({ next: () => INBOX_EVENT_ID }),
    });
    expect(
      (
        await invalidClock.fetch(await signedRequest(EXTRA_SECRET), {
          ...bindings(runtime),
          WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET),
        })
      ).status,
    ).toBe(503);
    expect(runtime.recordWorkosWebhook).not.toHaveBeenCalled();
  });

  it.each([
    ["missing webhook secret", { WORKOS_WEBHOOK_SECRET: undefined }],
    ["blank webhook secret", { WORKOS_WEBHOOK_SECRET: "   " }],
    ["missing Core ingress capability", { CONTROL_RUNTIME: undefined }],
    ["Core database binding held by ingress", { CONTROL_CORE: {} }],
    ["malformed additional JSON", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: "{" }],
    ["non-array additional keys", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: "{}" }],
    ["non-text additional JSON", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: 1 }],
    ["oversized additional JSON", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: " ".repeat(4097) }],
    ["null additional entry", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: "[null]" }],
    ["array additional entry", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: "[[]]" }],
    [
      "non-text additional secret",
      {
        WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: JSON.stringify([
          { secret: 123, expiresAt: EXTRA_EXPIRES_AT },
        ]),
      },
    ],
    [
      "missing additional expiry",
      { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: JSON.stringify([{ secret: EXTRA_SECRET }]) },
    ],
    ["blank additional secret", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(" ") }],
    ["duplicate current key", { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(SECRET) }],
    [
      "non-UTC expiry",
      { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET, "2026-08-19T12:01:00+01:00") },
    ],
    [
      "impossible UTC date",
      { WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: extra(EXTRA_SECRET, "2026-02-30T12:01:00.000Z") },
    ],
    [
      "unbounded extra pool",
      {
        WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: JSON.stringify([
          { secret: EXTRA_SECRET, expiresAt: EXTRA_EXPIRES_AT },
          { secret: EXTRA_GITHUB_SECRET, expiresAt: EXTRA_EXPIRES_AT },
        ]),
      },
    ],
    [
      "unrecognized key field",
      {
        WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: JSON.stringify([
          { secret: EXTRA_SECRET, expiresAt: EXTRA_EXPIRES_AT, provider: "workos" },
        ]),
      },
    ],
  ])("fails closed for %s without recording", async (_name, override) => {
    const runtime = runtimeFixture();

    const response = await worker.fetch(await signedRequest(), {
      ...bindings(runtime),
      ...override,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "webhook_ingress_unavailable" });
    expect(runtime.recordWorkosWebhook).not.toHaveBeenCalled();
  });

  it.each([
    ["Stripe without a webhook secret", "stripe", { STRIPE_WEBHOOK_SECRET: undefined }],
    ["Stripe with a malformed webhook secret", "stripe", { STRIPE_WEBHOOK_SECRET: "sk_live_x" }],
    ["Stripe without an account", "stripe", { STRIPE_ACCOUNT_ID: undefined }],
    ["Stripe with an unknown mode", "stripe", { STRIPE_MODE: "staging" }],
    ["Resend without a webhook secret", "resend", { RESEND_WEBHOOK_SECRET: undefined }],
    ["Resend without its Core capability", "resend", { RESEND_INGRESS_RUNTIME: undefined }],
  ])("fails closed for %s", async (_name, provider, override) => {
    const response = await worker.fetch(
      new Request(`https://webhook-ingress.internal/webhooks/${provider}`, { method: "POST" }),
      { ...configured(), ...override },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "webhook_ingress_unavailable" });
  });

  it.each([
    ["stripe", 400],
    ["resend", 400],
  ])("hands a configured %s request to its signature verification", async (provider, status) => {
    const response = await worker.fetch(
      new Request(`https://webhook-ingress.internal/webhooks/${provider}`, { method: "POST" }),
      configured(),
    );

    expect(response.status).toBe(status);
  });

  it.each([
    "https://workos-webhook.internal/webhooks/workos/extra",
    "https://workos-webhook.internal/webhooks/workos?preview=true",
  ])("serves no route outside the exact internal webhook path: %s", async (url) => {
    const runtime = runtimeFixture();

    const response = await worker.fetch(new Request(url, { method: "POST" }), bindings(runtime));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runtime.recordWorkosWebhook).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods before reading any binding", async () => {
    const runtime = runtimeFixture();

    const response = await worker.fetch(
      new Request("https://workos-webhook.internal/webhooks/workos", { method: "GET" }),
      bindings(runtime),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runtime.recordWorkosWebhook).not.toHaveBeenCalled();
  });

  it("redacts Core failures and emits no secret-bearing log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const runtime = runtimeFixture();
      runtime.recordWorkosWebhook.mockRejectedValue(new Error(`Core failed with ${SECRET}`));

      const response = await worker.fetch(await signedRequest(), bindings(runtime));
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(body).toBe('{"error":"webhook_inbox_unavailable"}');
      expect(body).not.toContain(SECRET);
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("uses the system clock and entropy for production ULIDs", () => {
    const clock = createSystemWebhookClock();
    const first = createSystemWebhookEventIds(clock).next();

    expect(clock.now()).toBeInstanceOf(Date);
    expect(first).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
  });
});
