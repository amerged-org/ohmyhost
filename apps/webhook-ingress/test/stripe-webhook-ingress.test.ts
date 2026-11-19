import { createHmac } from "node:crypto";

import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import { createStripeWebhookIngress } from "../src/index.js";
import type { StripeWebhookInboxRecorder } from "../src/stripe-app.js";

const SECRET = "whsec_stripe_ingress_fixture";
const NOW = new Date("2026-10-29T12:00:00.000Z");
const INBOX_EVENT_ID = parseUlid("01K30MG1000000000000000000");
const body = JSON.stringify({
  id: "evt_stripe_ingress",
  type: "invoice.paid",
  livemode: false,
  account: "acct_ingress",
  data: { object: { id: "in_ingress", customer: "must-not-be-persisted" } },
});

const request = (payload = body, headers: Record<string, string> | undefined = undefined) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request("https://ingress.test/webhooks/stripe", {
    method: "POST",
    headers: headers ?? {
      "stripe-signature": `t=${timestamp},v1=${createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex")}`,
    },
    body: payload,
  });
};

const ingress = (record: StripeWebhookInboxRecorder["record"]) =>
  createStripeWebhookIngress({
    inbox: { record },
    configuration: { accountId: "acct_ingress", mode: "test" },
    secret: SECRET,
    clock: { now: () => new Date(NOW) },
    ids: { next: () => INBOX_EVENT_ID },
  });

describe("Stripe webhook ingress", () => {
  it("records only the minimized signed event identity and reports provider replays", async () => {
    const record = vi.fn<StripeWebhookInboxRecorder["record"]>().mockResolvedValue("existing");

    const response = await ingress(record).fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: true });
    expect(record).toHaveBeenCalledExactlyOnceWith({
      inboxEventId: INBOX_EVENT_ID,
      event: {
        id: "evt_stripe_ingress",
        type: "invoice.paid",
        objectId: "in_ingress",
        accountId: "acct_ingress",
        mode: "test",
      },
      receivedAt: NOW.toISOString(),
    });
  });

  it.each([
    ["a missing signature", () => request(body, {}), 400],
    ["a wrong signature", () => request(body, { "stripe-signature": "t=1,v1=00" }), 400],
    ["an oversized body", () => request("x".repeat(256 * 1024 + 1)), 413],
    [
      "another path",
      () => new Request("https://ingress.test/webhooks/stripe/extra", { method: "POST", body }),
      404,
    ],
  ])("rejects %s before recording", async (_name, makeRequest, status) => {
    const record = vi.fn<StripeWebhookInboxRecorder["record"]>();

    const response = await ingress(record).fetch(makeRequest());

    expect(response.status).toBe(status);
    expect(record).not.toHaveBeenCalled();
  });

  it("maps an identity conflict to 409 and any other inbox failure to a redacted 503", async () => {
    const conflict = vi
      .fn<StripeWebhookInboxRecorder["record"]>()
      .mockRejectedValue(new Error("stripe_inbox_identity_conflict"));
    const failure = vi
      .fn<StripeWebhookInboxRecorder["record"]>()
      .mockRejectedValue(new Error(`inbox failed with ${SECRET}`));

    const conflicted = await ingress(conflict).fetch(request());
    const failed = await ingress(failure).fetch(request());

    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toEqual({ error: "stripe_inbox_identity_conflict" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('{"error":"webhook_inbox_unavailable"}');
  });
});
