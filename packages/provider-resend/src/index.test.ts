import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createResendProvider,
  ResendRequestError,
  verifyResendWebhook,
  parseResendDomain,
} from "./index.js";
const id = "37e4414c-5e25-4dbc-a071-43552a4bd53b";
const rawAttachment = {
  id: "attachment-1",
  download_url: "https://inbound-cdn.resend.com/mail/attachment-1",
  content_type: "text/plain",
  filename: "note.txt",
  size: 5,
  expires_at: "2026-10-25T00:00:00.000Z",
};
describe("Resend boundary", () => {
  it("allows a validated sender display name without changing the address boundary", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createResendProvider({
      apiKey: "re_test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ id });
      },
    });
    const mail = {
      from: "no-reply@ohmyho.st",
      to: "guest@example.net",
      subject: "Hello",
      text: "Hello",
      idempotencyKey: "test-1",
    };
    await provider.send({ ...mail, fromName: "Seb from ohmyho.st" });
    await provider.send(mail);
    expect(bodies.map((body) => body["from"])).toEqual([
      "Seb from ohmyho.st <no-reply@ohmyho.st>",
      "no-reply@ohmyho.st",
    ]);
    for (const fromName of ["Seb\r\nBcc: bad@example.net", "<fake>", '"Seb"', ""]) {
      await expect(provider.send({ ...mail, fromName })).rejects.toThrow(TypeError);
    }
    expect(bodies).toHaveLength(2);
  });
  it("keeps domain, inbound, attachment, key and webhook calls at the fixed provider origin", async () => {
    const calls: Request[] = [];
    const rawDomain = {
      id,
      name: "mail.customer.example",
      status: "verified",
      capabilities: { sending: "enabled", receiving: "enabled" },
      records: [
        {
          record: "DKIM",
          type: "TXT",
          name: "resend._domainkey",
          value: "p=test",
          status: "verified",
        },
      ],
    };
    const provider = createResendProvider({
      apiKey: "re_admin",
      fetch: async (url, init) => {
        const request = new Request(url, init);
        calls.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/domains" && request.method === "POST") return Response.json(rawDomain);
        if (path === `/domains/${id}` && request.method === "GET") return Response.json(rawDomain);
        if (path === `/domains/${id}` && request.method === "PATCH") return Response.json({ id });
        if (path === `/domains/${id}/verify`) return Response.json({ id });
        if (path === `/domains/${id}` && request.method === "DELETE")
          return Response.json({ id, deleted: true });
        if (path === "/api-keys" && request.method === "GET")
          return Response.json({
            object: "list",
            has_more: false,
            data: [{ id, name: "ohmyho:domain" }],
          });
        if (path === `/emails/receiving/${id}`)
          return Response.json({
            id,
            from: "guest@example.net",
            to: ["bookings@mail.customer.example"],
            subject: "Reply",
            text: "Hello",
            html: null,
            message_id: "<mail@example.net>",
            attachments: [{ id: "attachment-1", filename: null, content_type: "text/plain" }],
          });
        if (path === `/emails/receiving/${id}/attachments/attachment-1`)
          return Response.json(rawAttachment);
        if (path === "/webhooks" && request.method === "POST")
          return Response.json({ id, signing_secret: "whsec_test" });
        if (path === "/emails" && request.method === "POST") return Response.json({ id });
        throw new Error("Unexpected Resend path");
      },
    });
    expect(
      await provider.createDomain({
        domain: "mail.customer.example",
        sending: true,
        receiving: true,
      }),
    ).toMatchObject({ id, domain: "mail.customer.example" });
    expect((await provider.getDomain(id)).domain).toBe("mail.customer.example");
    await provider.updateDomain(id, { sending: true, receiving: false });
    await provider.verifyDomain(id);
    await provider.deleteDomain(id);
    expect(await provider.listApiKeys()).toEqual({
      items: [{ id, name: "ohmyho:domain" }],
      hasMore: false,
    });
    expect(await provider.getReceived(id)).toMatchObject({
      from: "guest@example.net",
      to: ["bookings@mail.customer.example"],
      attachments: [{ id: "attachment-1", filename: null }],
    });
    expect(await provider.getAttachment(id, "attachment-1")).toEqual({
      downloadUrl: "https://inbound-cdn.resend.com/mail/attachment-1",
      contentType: "text/plain",
      filename: "note.txt",
      size: 5,
      expiresAt: "2026-10-25T00:00:00.000Z",
    });
    expect(
      await provider.createWebhook("https://app.ohmyho.st/webhooks/resend", ["email.received"]),
    ).toEqual({ id, signingSecret: "whsec_test" });
    await provider.send({
      from: "bookings@mail.customer.example",
      to: "guest@example.net",
      subject: "Booking",
      text: "Confirmed",
      idempotencyKey: "request-1",
      tags: { project_id: "owned" },
    });
    expect(await calls.at(-1)?.json()).toMatchObject({
      tags: [{ name: "project_id", value: "owned" }],
    });
    expect(
      calls.every(
        (request) =>
          new URL(request.url).origin === "https://api.resend.com" && request.redirect === "manual",
      ),
    ).toBe(true);
  });
  it("validates attachment size and expiry without applying the gateway's byte ceiling", async () => {
    const attachment = (fields: Readonly<Record<string, unknown>>) =>
      createResendProvider({
        apiKey: "re_admin",
        fetch: async () => Response.json({ ...rawAttachment, ...fields }),
      }).getAttachment(id, "attachment-1");
    for (const size of [0, 50 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER])
      expect(await attachment({ size })).toMatchObject({ size });
    for (const expiresAt of ["2026-10-25T00:00:00Z", "2026-10-25T02:00:00+02:00"])
      expect(await attachment({ expires_at: expiresAt })).toMatchObject({ expiresAt });
    for (const fields of [
      { size: undefined },
      { size: null },
      { size: "5" },
      { size: -1 },
      { size: 0.5 },
      { size: Number.MAX_SAFE_INTEGER + 1 },
      { expires_at: undefined },
      { expires_at: null },
      { expires_at: 1792886400000 },
      { expires_at: "private provider metadata" },
      { expires_at: "2026-10-25" },
      { expires_at: "2026-02-30T00:00:00Z" },
      { expires_at: "2026-10-25T24:00:00Z" },
    ]) {
      await expect(attachment(fields)).rejects.toMatchObject({
        name: "ResendRequestError",
        code: "resend_request_failed",
        message: "Resend request failed",
        status: 200,
        uncertain: true,
      });
    }
  });
  it("preserves provider domain creation time for uncertain-create reconciliation", async () => {
    const provider = createResendProvider({
      apiKey: "re_admin",
      fetch: async () =>
        Response.json({
          object: "list",
          has_more: false,
          data: [{ id, name: "mail.customer.example", created_at: "2026-09-22 10:00:00.000+00" }],
        }),
    });
    expect(await provider.listDomains()).toEqual({
      items: [{ id, domain: "mail.customer.example", createdAt: "2026-09-22T10:00:00.000Z" }],
      hasMore: false,
    });
  });
  it("creates a sending-only API key scoped to the verified domain and revokes it", async () => {
    const calls: Request[] = [];
    const provider = createResendProvider({
      apiKey: "re_admin",
      fetch: async (url, init) => {
        const request = new Request(url, init);
        calls.push(request);
        return request.method === "POST"
          ? Response.json({ id, token: "re_scoped" })
          : Response.json({ id, deleted: true });
      },
    });
    expect(await provider.createDomainSendingKey({ domainId: id, name: "ohmyho:tenant" })).toEqual({
      id,
      token: "re_scoped",
    });
    expect(calls[0]?.url).toBe("https://api.resend.com/api-keys");
    expect(await calls[0]?.json()).toEqual({
      name: "ohmyho:tenant",
      permission: "sending_access",
      domain_id: id,
    });
    await provider.deleteApiKey(id);
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe(`https://api.resend.com/api-keys/${id}`);
  });
  it("reads only provider webhook metadata needed for safe setup", async () => {
    const provider = createResendProvider({
      apiKey: "re_admin",
      fetch: async () =>
        Response.json({
          object: "list",
          has_more: false,
          data: [
            {
              id,
              endpoint: "https://app.ohmyho.st/webhooks/resend",
              status: "enabled",
              events: ["email.received"],
            },
          ],
        }),
    });
    expect(await provider.listWebhooks()).toEqual({
      items: [
        {
          id,
          endpoint: "https://app.ohmyho.st/webhooks/resend",
          status: "enabled",
          events: ["email.received"],
        },
      ],
      hasMore: false,
    });
  });
  it("sends only to the fixed provider origin and preserves idempotency", async () => {
    const calls: Request[] = [];
    const provider = createResendProvider({
      apiKey: "re_test",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({ id });
      },
    });
    expect(
      await provider.send({
        from: "bookings@mail.example.com",
        to: "guest@example.net",
        subject: "Booking",
        text: "Confirmed",
        html: "<p>Confirmed</p>",
        idempotencyKey: "project:request",
      }),
    ).toEqual({ messageId: id });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("project:request");
    // Workers reject redirect "error" before sending (observed 2026-09-23 Dev mail setup).
    expect(calls[0]?.redirect).toBe("manual");
  });
  it("redacts provider errors and distinguishes definite rejection from uncertain failures", async () => {
    for (const status of [400, 401, 429, 500]) {
      const provider = createResendProvider({
        apiKey: "re_test",
        fetch: async () => Response.json({ message: "private data" }, { status }),
      });
      try {
        await provider.send({
          from: "a@example.com",
          to: "b@example.com",
          subject: "s",
          text: "t",
          idempotencyKey: "k",
        });
        throw Error("missing error");
      } catch (error) {
        expect(error).toBeInstanceOf(ResendRequestError);
        expect(String(error)).not.toContain("private data");
        expect((error as ResendRequestError).uncertain).toBe(status >= 500);
      }
    }
  });
  it("classifies only the observed domain-limit refusal of a domain creation", async () => {
    // Exact provider response of Resend log aa13cf65 (2026-09-24, notify.maasstudio.aixyte.com).
    const limit = {
      name: "validation_error",
      message: "You have reached the domain limit of your plan. Upgrade to add more.",
      statusCode: 403,
    };
    const create = async (body: unknown) => {
      const provider = createResendProvider({
        apiKey: "re_test",
        fetch: async () => Response.json(body, { status: 403 }),
      });
      return provider
        .createDomain({ domain: "mail.customer.example", sending: true, receiving: false })
        .then(() => Error("missing error"))
        .catch((error: unknown) => error as ResendRequestError);
    };
    const refused = await create(limit);
    expect(refused).toMatchObject({ status: 403, uncertain: false, reason: "domain_limit" });
    expect(String(refused)).not.toContain("Upgrade");
    // A different 403, e.g. a domain registered elsewhere, is not a capacity limit.
    const registered = await create({
      name: "validation_error",
      message: "The `mail.customer.example` domain has been registered already.",
      statusCode: 403,
    });
    expect(registered).toMatchObject({ status: 403, uncertain: false, reason: undefined });
  });
  it("normalizes only records within the owned domain and carries MX priority", () => {
    const raw = {
      id,
      name: "mail.example.com",
      status: "pending",
      capabilities: { sending: "enabled", receiving: "enabled" },
      records: [
        {
          record: "Receiving MX",
          type: "MX",
          name: "@",
          value: "inbound.resend.com",
          priority: 10,
          status: "pending",
          ttl: "Auto",
        },
      ],
    };
    expect(parseResendDomain(raw).records[0]).toMatchObject({
      name: "mail.example.com",
      priority: 10,
      purpose: "Receiving MX",
    });
    expect(() =>
      parseResendDomain({ ...raw, records: [{ ...raw.records[0], name: "evil.net." }] }),
    ).toThrow();
  });
  it("completes Resend's zone-relative names without duplicating mail-domain labels", () => {
    const name = "resend-acceptance.dev.ohmyho.st";
    const raw = {
      id,
      name,
      status: "not_started",
      capabilities: { sending: "enabled", receiving: "enabled" },
      records: [
        {
          record: "DKIM",
          type: "TXT",
          name: "resend._domainkey.resend-acceptance.dev",
          value: "p=test",
          status: "not_started",
        },
        {
          record: "SPF",
          type: "MX",
          name: "send.resend-acceptance.dev",
          value: "feedback-smtp.us-east-1.amazonses.com",
          priority: 10,
          status: "not_started",
        },
        {
          record: "SPF",
          type: "TXT",
          name: "send.resend-acceptance.dev",
          value: "v=spf1 include:amazonses.com ~all",
          status: "not_started",
        },
        {
          record: "SPF",
          type: "CNAME",
          name: "rsend.resend-acceptance.dev",
          value: "example.resend.com",
          status: "not_started",
        },
        {
          record: "Receiving",
          type: "MX",
          name: "resend-acceptance.dev",
          value: "inbound-smtp.us-east-1.amazonaws.com",
          priority: 10,
          status: "pending",
        },
      ],
    };
    expect(parseResendDomain(raw).records.map((record) => record.name)).toEqual([
      `resend._domainkey.${name}`,
      `send.${name}`,
      `send.${name}`,
      `rsend.${name}`,
      name,
    ]);
  });
  it("verifies the raw signed body with a bounded timestamp and rotated signatures", async () => {
    const secret = Buffer.alloc(32, 7),
      now = new Date("2026-09-22T00:00:00Z"),
      ts = String(now.getTime() / 1000),
      event = "msg_123",
      body = '{"type":"email.received"}';
    const signature = createHmac("sha256", secret)
      .update(`${event}.${ts}.${body}`)
      .digest("base64");
    const headers = new Headers({
      "svix-id": event,
      "svix-timestamp": ts,
      "svix-signature": `v1,invalid v1,${signature}`,
    });
    expect(
      await verifyResendWebhook(body, headers, `whsec_${secret.toString("base64")}`, now),
    ).toBe(event);
    await expect(
      verifyResendWebhook(body + " ", headers, `whsec_${secret.toString("base64")}`, now),
    ).rejects.toThrow();
    await expect(
      verifyResendWebhook(
        body,
        headers,
        `whsec_${secret.toString("base64")}`,
        new Date(now.getTime() + 301000),
      ),
    ).rejects.toThrow();
  });
});
