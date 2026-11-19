import { describe, expect, it } from "vitest";

import { parseWorkosOrganizationTrigger } from "../../workos-management/src/index.js";
import { createWorkosWebhookIngress, type WorkosWebhookInboxRecord } from "../src/index.js";

const NOW = new Date("2026-08-18T10:00:00.000Z");
const SECRET = "integration-fixture-secret";

describe("WorkOS ingress to management trigger handoff", () => {
  it("turns a verified membership envelope into the exact management-consumable trigger", async () => {
    const persisted: WorkosWebhookInboxRecord[] = [];
    const app = createWorkosWebhookIngress({
      secretReference: {
        kind: "secret-reference",
        provider: "workos",
        purpose: "webhook-verification",
        reference: "fixture://workos-webhook-secret",
      },
      secretResolver: { resolve: async () => SECRET },
      inbox: {
        record: async (record) => {
          persisted.push(record);
          return "created";
        },
      },
      eventIds: {
        next: () => "01K30MG1000000000000000000" as WorkosWebhookInboxRecord["inboxEventId"],
      },
      clock: { now: () => new Date(NOW) },
      maximumBodyBytes: 4_096,
      signatureToleranceMs: 300_000,
      maximumAttempts: 5,
    });
    const rawBody = encode(
      JSON.stringify({
        id: "event_01K30MEMBERSHIP",
        event: "organization_membership.updated",
        created_at: "2026-08-18T09:59:59.000Z",
        data: {
          id: "membership_must_not_cross_boundary",
          organization_id: "org_01K30WORKOS",
          user_id: "user_must_not_cross_boundary",
          role: { slug: "admin" },
        },
      }),
    );
    const signature = await sign(rawBody);

    const response = await app.fetch(
      new Request("https://ingress.test/webhooks/workos", {
        method: "POST",
        headers: { "workos-signature": `t=${String(NOW.getTime())},v1=${signature}` },
        body: rawBody.buffer,
      }),
    );

    expect(response.status).toBe(200);
    expect(persisted).toHaveLength(1);
    const payload = persisted[0]?.payload;
    expect(payload).toEqual({
      schemaVersion: "workos.organization-trigger.v1",
      workosOrganizationId: "org_01K30WORKOS",
    });
    expect(parseWorkosOrganizationTrigger(payload ?? {})).toEqual(payload);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/organization_id|user_id|resource_id|created_at/u);
    expect(serialized).not.toContain("membership_must_not_cross_boundary");
    expect(serialized).not.toContain("user_must_not_cross_boundary");
  });
});

const encode = (value: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
};

const sign = async (rawBody: Uint8Array<ArrayBuffer>): Promise<string> => {
  const prefix = encode(`${String(NOW.getTime())}.`);
  const message = new Uint8Array(new ArrayBuffer(prefix.byteLength + rawBody.byteLength));
  message.set(prefix);
  message.set(rawBody, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
