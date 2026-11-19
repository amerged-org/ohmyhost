import { createHmac } from "node:crypto";
import { it, expect } from "vitest";
import { verifyMailWebhook } from "./mail-webhook.js";
it("verifies raw customer-webhook bodies and rejects tampering and expired signatures", async () => {
  const now = new Date("2026-09-22T00:00:00Z"),
    key = Buffer.alloc(32, 2),
    body = '{"type":"email.received"}',
    timestamp = String(now.getTime() / 1000),
    id = "01H00000000000000000000601";
  const headers = new Headers({
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
  });
  expect(
    await verifyMailWebhook({ body, headers, secret: `whsec_${key.toString("base64")}`, now }),
  ).toBe(id);
  await expect(
    verifyMailWebhook({
      body: body + " ",
      headers,
      secret: `whsec_${key.toString("base64")}`,
      now,
    }),
  ).rejects.toThrow();
  await expect(
    verifyMailWebhook({
      body,
      headers,
      secret: `whsec_${key.toString("base64")}`,
      now: new Date(now.getTime() + 301000),
    }),
  ).rejects.toThrow();
});
