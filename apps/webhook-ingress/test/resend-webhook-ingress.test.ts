import { createHmac } from "node:crypto";

import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import { createResendIngress, type ResendIngressPersistence } from "../src/resend-ingress.js";

const KEY = Buffer.from("resend-ingress-fixture-key-0001");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = new Date("2026-10-29T12:00:00.000Z");
const MESSAGE_ID = "01K30MG1000000000000000000";
const body = JSON.stringify({
  type: "email.received",
  created_at: NOW.toISOString(),
  data: { email_id: "email_ingress", to: ["support@example.com"], subject: "must-not-cross" },
});

const request = (
  options: { payload?: string; contentType?: string; signature?: string } = {},
): Request => {
  const payload = options.payload ?? body,
    timestamp = String(NOW.getTime() / 1000),
    signature =
      options.signature ??
      `v1,${createHmac("sha256", KEY).update(`msg_ingress.${timestamp}.${payload}`).digest("base64")}`;
  return new Request("https://ingress.test/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "svix-id": "msg_ingress",
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body: payload,
  });
};

const ingress = (ingest: ResendIngressPersistence["ingest"]) =>
  createResendIngress({
    persistence: { ingest },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => parseUlid(MESSAGE_ID) },
    secret: SECRET,
  });

describe("Resend webhook ingress", () => {
  it("hands the verified event, its body digest and a lazy message identity to persistence", async () => {
    const ingest = vi.fn<ResendIngressPersistence["ingest"]>().mockResolvedValue(undefined);

    const response = await ingress(ingest).fetch(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ingest).toHaveBeenCalledOnce();
    const event = ingest.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      eventId: "msg_ingress",
      type: "email.received",
      createdAt: NOW.toISOString(),
      now: NOW.toISOString(),
    });
    expect(Buffer.from(event?.digest ?? []).toString("hex")).toHaveLength(64);
    expect(event?.nextMessageId()).toBe(MESSAGE_ID);
  });

  it.each([
    ["a non-JSON content type", { contentType: "text/plain" }, 400],
    ["a wrong signature", { signature: "v1,AAAA" }, 400],
    ["a body without an event type", { payload: "{}" }, 400],
    ["an oversized body", { payload: "x".repeat(262145) }, 413],
  ])("rejects %s before persistence", async (_name, options, status) => {
    const ingest = vi.fn<ResendIngressPersistence["ingest"]>();

    const response = await ingress(ingest).fetch(request(options));

    expect(response.status).toBe(status);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests and answers 503 so Resend retries a persistence failure", async () => {
    const failing = vi.fn<ResendIngressPersistence["ingest"]>().mockRejectedValue(new Error("x"));

    const get = await ingress(failing).fetch(
      new Request("https://ingress.test/webhooks/resend", { method: "GET" }),
    );
    const failed = await ingress(failing).fetch(request());

    expect(get.status).toBe(400);
    expect(failed.status).toBe(503);
  });
});
