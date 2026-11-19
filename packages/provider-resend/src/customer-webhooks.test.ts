import { describe, it, expect } from "vitest";
import {
  mailWebhookSecret,
  mailWebhookHeaders,
  validateMailWebhookUrl,
  isPublicMailAddress,
  requirePublicMailWebhook,
} from "./customer-webhooks.js";
import { verifyResendWebhook } from "./webhooks.js";
describe("customer webhook boundary", () => {
  it("scopes signatures to the domain and validates the complete signed body", async () => {
    const secret = mailWebhookSecret(
        Buffer.alloc(32, 1).toString("base64"),
        "01H00000000000000000000601",
      ),
      now = new Date();
    const signed = mailWebhookHeaders("{}", "evt_1", secret, now),
      headers = new Headers();
    for (const name of ["id", "timestamp", "signature"])
      headers.set(`svix-${name}`, signed[`webhook-${name}`] ?? "");
    expect(await verifyResendWebhook("{}", headers, secret, now)).toBe("evt_1");
    await expect(
      verifyResendWebhook(
        "{}",
        headers,
        mailWebhookSecret(Buffer.alloc(32, 1).toString("base64"), "01H00000000000000000000602"),
        now,
      ),
    ).rejects.toThrow();
    expect(() => mailWebhookSecret("invalid", "invalid")).toThrow();
  });
  it("rejects local and credential-bearing destinations including encoded IP forms", () => {
    for (const url of [
      "http://example.com",
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://[::1]/",
      "https://foo.local/",
      "https://user:secret@example.com/",
      "https://example.com:8443/",
    ])
      expect(() => validateMailWebhookUrl(url)).toThrow();
    expect(validateMailWebhookUrl("https://app.example.com/api/mail").hostname).toBe(
      "app.example.com",
    );
    for (const address of [
      "127.0.0.1",
      "10.1.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "172.16.0.1",
      "100.64.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "2001:db8::1",
    ])
      expect(isPublicMailAddress(address)).toBe(false);
    expect(isPublicMailAddress("1.1.1.1")).toBe(true);
    expect(isPublicMailAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("requires all resolved addresses to be public and fails closed on DNS errors", async () => {
    const resolver = { v4: async () => ["1.1.1.1"], v6: async () => [] };
    expect(
      (await requirePublicMailWebhook("https://example.com", resolver as never)).hostname,
    ).toBe("example.com");
    await expect(
      requirePublicMailWebhook("https://example.com", {
        ...resolver,
        v4: async () => ["1.1.1.1", "10.0.0.1"],
      } as never),
    ).rejects.toThrow();
    await expect(
      requirePublicMailWebhook("https://example.com", {
        ...resolver,
        v4: async () => {
          throw Error("DNS down");
        },
      } as never),
    ).rejects.toThrow();
  });
});

describe("customer webhook generations", () => {
  const root = Buffer.alloc(32, 1).toString("base64");
  const domain = "01H00000000000000000000602";
  it("derives a new signing secret for each generation and keeps generation zero on the original derivation", () => {
    expect(mailWebhookSecret(root, domain, 0)).toBe(mailWebhookSecret(root, domain));
    expect(mailWebhookSecret(root, domain, 1)).not.toBe(mailWebhookSecret(root, domain, 0));
    expect(mailWebhookSecret(root, domain, 2)).not.toBe(mailWebhookSecret(root, domain, 1));
    expect(() => mailWebhookSecret(root, domain, -1)).toThrow();
    expect(() => mailWebhookSecret(root, domain, 2147483648)).toThrow();
  });
});
