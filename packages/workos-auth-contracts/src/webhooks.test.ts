import { describe, expect, it } from "vitest";

import { isAcceptedWorkosWebhookSearch, verifyAndParseWorkosWebhook } from "./index.js";

const sign = async (secret: string, value: string): Promise<string> => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("WorkOS raw webhook contract", () => {
  it("verifies a real HMAC over the timestamp-prefixed exact raw bytes", async () => {
    const rawBody = JSON.stringify({
      id: "event_1",
      event: "organization.updated",
      created_at: "2026-08-18T10:00:00Z",
      data: { id: "org_1" },
    });
    const secret = "webhook-secret";
    const signature = await sign(secret, `1787047200000.${rawBody}`);
    const envelope = await verifyAndParseWorkosWebhook({
      rawBody: new TextEncoder().encode(rawBody),
      signatureHeader: `t=1787047200000,v1=${signature}`,
      secret,
      now: new Date("2026-08-18T10:00:00Z"),
      toleranceMs: 300_000,
      maximumBodyBytes: 4_096,
    });

    expect(envelope.id).toBe("event_1");
    const successor = "replacement-webhook-secret";
    const common = {
      rawBody: new TextEncoder().encode(rawBody),
      secret: successor,
      additionalSecrets: [secret],
      now: new Date("2026-08-18T10:00:00Z"),
      toleranceMs: 300_000,
      maximumBodyBytes: 4_096,
    };
    expect(
      (
        await verifyAndParseWorkosWebhook({
          ...common,
          signatureHeader: `t=1787047200000,v1=${signature}`,
        })
      ).id,
    ).toBe("event_1");
    const currentSignature = await sign(successor, `1787047200000.${rawBody}`);
    expect(
      await verifyAndParseWorkosWebhook({
        ...common,
        signatureHeader: `t=1787047200000,v1=${signature},v1=${currentSignature}`,
      }),
    ).toEqual(envelope);
    expect(
      await verifyAndParseWorkosWebhook({
        ...common,
        additionalSecrets: [],
        signatureHeader: `t=1787047200000,v1=${currentSignature}`,
      }),
    ).toEqual(envelope);
    expect(
      await verifyAndParseWorkosWebhook({
        ...common,
        additionalSecrets: [successor],
        signatureHeader: `t=1787047200000,v1=${currentSignature}`,
      }),
    ).toEqual(envelope);
    const callerOwnedBytes = new TextEncoder().encode(rawBody);
    const pending = verifyAndParseWorkosWebhook({
      ...common,
      rawBody: callerOwnedBytes,
      signatureHeader: `t=1787047200000,v1=${currentSignature}`,
    });
    callerOwnedBytes.set(new TextEncoder().encode(rawBody.replace("event_1", "event_2")));
    expect((await pending).id).toBe("event_1");
  });

  it("fails closed for stale or cryptographically invalid signatures", async () => {
    await expect(
      verifyAndParseWorkosWebhook({
        rawBody: new Uint8Array(),
        signatureHeader: "t=1,v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        secret: "secret",
        now: new Date("2026-08-18T10:00:00Z"),
        toleranceMs: 300_000,
        maximumBodyBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "webhook_timestamp_outside_tolerance" });

    const body = new TextEncoder().encode(
      JSON.stringify({
        id: "event_1",
        event: "organization.updated",
        created_at: "2026-08-18T10:00:00Z",
        data: {},
      }),
    );
    await expect(
      verifyAndParseWorkosWebhook({
        rawBody: body,
        signatureHeader:
          "t=1787047200000,v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        secret: "wrong-secret",
        now: new Date("2026-08-18T10:00:00Z"),
        toleranceMs: 300_000,
        maximumBodyBytes: 4_096,
      }),
    ).rejects.toMatchObject({ code: "invalid_webhook_signature" });
    const validExtra = "legacy-webhook-secret";
    const extraSignature = await sign(
      validExtra,
      `1787047200000.${new TextDecoder().decode(body)}`,
    );
    const overlap = {
      rawBody: body,
      signatureHeader: `t=1787047200000,v1=${extraSignature}`,
      secret: "replacement-webhook-secret",
      additionalSecrets: [validExtra],
      now: new Date("2026-08-18T10:00:00Z"),
      toleranceMs: 300_000,
      maximumBodyBytes: 4_096,
    };
    await expect(
      verifyAndParseWorkosWebhook({ ...overlap, additionalSecrets: ["wrong-old-secret"] }),
    ).rejects.toMatchObject({ code: "invalid_webhook_signature" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...overlap,
        rawBody: new TextEncoder().encode(`${new TextDecoder().decode(body)} `),
      }),
    ).rejects.toMatchObject({ code: "invalid_webhook_signature" });
    await expect(
      verifyAndParseWorkosWebhook({ ...overlap, now: new Date("2026-08-18T10:05:00.001Z") }),
    ).rejects.toMatchObject({ code: "webhook_timestamp_outside_tolerance" });
  });

  it("rejects missing and malformed headers, invalid clocks, future timestamps, bodies, and limits", async () => {
    const now = new Date("2026-08-18T10:00:00Z");
    const base = {
      rawBody: new TextEncoder().encode("{}"),
      secret: "secret",
      now,
      toleranceMs: 300_000,
      maximumBodyBytes: 100,
    };

    await expect(
      verifyAndParseWorkosWebhook({ ...base, signatureHeader: "" }),
    ).rejects.toMatchObject({ code: "invalid_signature_header" });
    await expect(
      verifyAndParseWorkosWebhook({ ...base, secret: "", signatureHeader: "" }),
    ).rejects.toMatchObject({ code: "invalid_webhook_secret" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        secret: "",
        additionalSecrets: ["valid-extra"],
        signatureHeader: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_webhook_secret" });
    await expect(
      verifyAndParseWorkosWebhook({ ...base, additionalSecrets: [""], signatureHeader: "" }),
    ).rejects.toMatchObject({ code: "invalid_webhook_secret" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        additionalSecrets: new Array<string>(1),
        signatureHeader: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_webhook_secret" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        additionalSecrets: ["one", "two"],
        signatureHeader: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_webhook_secret" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        additionalSecrets: null as unknown as readonly string[],
        signatureHeader: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_webhook_secret" });
    await expect(
      verifyAndParseWorkosWebhook({ ...base, signatureHeader: "t=nope,v1=short" }),
    ).rejects.toMatchObject({ code: "invalid_signature_header" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        signatureHeader: "t=1,v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: "invalid_clock" });
    const future = now.getTime() + 300_001;
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        signatureHeader: `t=${future},v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      }),
    ).rejects.toMatchObject({ code: "webhook_timestamp_outside_tolerance" });
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        signatureHeader:
          "t=1787047200000,v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        maximumBodyBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "webhook_body_too_large" });

    const invalidJson = "not-json";
    const signature = await sign(base.secret, `1787047200000.${invalidJson}`);
    await expect(
      verifyAndParseWorkosWebhook({
        ...base,
        rawBody: new TextEncoder().encode(invalidJson),
        signatureHeader: `t=1787047200000,v1=${signature}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_json" });
  });
});

describe("WorkOS webhook query contract", () => {
  it("accepts the empty query and exactly one lowercase 32-hex rotation marker", () => {
    expect(isAcceptedWorkosWebhookSearch("")).toBe(true);
    expect(isAcceptedWorkosWebhookSearch("?omh_rotation=0123456789abcdef0123456789abcdef")).toBe(
      true,
    );
  });

  it("refuses every other query, marker shape or extra parameter", () => {
    for (const search of [
      "?",
      "?omh_rotation=0123",
      "?omh_rotation=0123456789ABCDEF0123456789abcdef",
      "?omh_rotation=0123456789abcdef0123456789abcdef0",
      "?omh_rotation=0123456789abcdef0123456789abcdef&retry=1",
      "?retry=1&omh_rotation=0123456789abcdef0123456789abcdef",
      "omh_rotation=0123456789abcdef0123456789abcdef",
      "?other=0123456789abcdef0123456789abcdef",
    ]) {
      expect(isAcceptedWorkosWebhookSearch(search), search).toBe(false);
    }
  });
});
