import { describe, it, expect } from "vitest";
import {
  createClient,
  downloadManagedMailAttachment,
  executeManagedMail,
  type ManagedMailCommand,
} from "../src/index.js";
import { assertManagedMailResponse } from "../src/managed-mail-response.js";
const scope = {
    projectId: "01H00000000000000000000601",
    environmentId: "01H00000000000000000000602",
  },
  messageId = "01H00000000000000000000603";
const domain = {
  domain_id: messageId,
  domain: "mail.example.com",
  environment_id: scope.environmentId,
  sending: "ready",
  receiving: "pending",
  status: "ready",
  configured_at: "2026-09-22T00:00:00.000Z",
  observed_at: null,
  dns_records: [
    {
      type: "MX",
      name: "mail.example.com",
      value: "inbound.resend.com",
      purpose: "Receiving",
      status: "pending",
      priority: 10,
    },
  ],
  webhook: { url: "https://app.example.com/mail", verified: true },
  next_check_after_seconds: 60,
  dns: { status: "configured", records: [] },
};
const content = {
  id: messageId,
  domain: "mail.example.com",
  received_at: "2026-09-22T00:00:00.000Z",
  expires_at: "2026-09-25T00:00:00.000Z",
  from: "sender@example.com",
  to: ["bookings@mail.example.com"],
  subject: "Booking",
  text: "Reply",
  html: null,
  message_id: "<r@example.com>",
  attachments: [
    {
      id: "attachment-1",
      filename: null,
      content_type: "application/pdf",
      download_path: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/mail/messages/${messageId}/attachments/attachment-1`,
    },
  ],
};
describe("managed mail SDK", () => {
  it("streams attachment bytes through the generated operation and bounds JSON expiry responses", async () => {
    let pulls = 0;
    let cancels = 0;
    let request: Request | undefined;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel() {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const client = createClient({
      baseUrl: "https://app.ohmyho.st",
      fetch: async (value) => {
        request = new Request(value);
        return new Response(source, { headers: { "content-type": "application/octet-stream" } });
      },
    });
    const input = { ...scope, messageId, attachmentId: "attachment-1" };
    const result = await downloadManagedMailAttachment(client, input);
    expect(pulls).toBe(0);
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe(
      `https://app.ohmyho.st/v1/projects/${scope.projectId}/environments/${scope.environmentId}/mail/messages/${messageId}/attachments/attachment-1`,
    );
    expect(result.status).toBe("download");
    if (result.status !== "download") throw new Error("Missing attachment");
    expect(result.body).toBe(source);
    expect(result.response.body).toBe(source);
    const reader = result.body.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([4, 5, 6]) });
    await reader.cancel();
    expect(cancels).toBe(1);
    const expired = createClient({
      baseUrl: "https://app.ohmyho.st",
      fetch: async () => Response.json({ status: "expired" }),
    });
    expect(await downloadManagedMailAttachment(expired, input)).toEqual({ status: "expired" });
    for (const response of [
      Response.json({ status: "expired", private: "detail" }),
      Response.json({ status: "a".repeat(1024) }),
      new Response("private invalid JSON", { headers: { "content-type": "application/json" } }),
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "2048" },
      }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private response body error"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      new Response(null),
      new Response("<html>private upstream fallback</html>", {
        headers: { "content-type": "text/html" },
      }),
      new Response(new Uint8Array([1])),
    ]) {
      await expect(
        downloadManagedMailAttachment(
          createClient({ baseUrl: "https://app.ohmyho.st", fetch: async () => response }),
          input,
        ),
      ).rejects.toThrow("Mail attachment response contract invalid");
    }
    await expect(
      downloadManagedMailAttachment(expired, { ...input, attachmentId: "../private" }),
    ).rejects.toThrow("Mail attachment response contract invalid");
    const abort = new AbortController();
    const signalled = createClient({
      baseUrl: "https://app.ohmyho.st",
      fetch: async (value) => {
        request = new Request(value);
        return new Response(new Uint8Array([1]), {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });
    await downloadManagedMailAttachment(signalled, { ...input, signal: abort.signal });
    abort.abort();
    expect(request?.signal.aborted).toBe(true);
  });

  it("uses generated scoped REST operations for every CLI/MCP action", async () => {
    const cases: [ManagedMailCommand, unknown, string][] = [
      [
        {
          ...scope,
          action: "configure",
          domain: "mail.example.com",
          sending: true,
          receiving: false,
          idempotencyKey: "setup",
        },
        domain,
        "PUT",
      ],
      [{ ...scope, action: "status" }, domain, "GET"],
      [
        {
          ...scope,
          action: "webhook_set",
          url: "https://app.example.com/mail",
          idempotencyKey: "hook",
        },
        {
          url: "https://app.example.com/mail",
          signing_secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
          status: "verification_required",
        },
        "PUT",
      ],
      [
        { ...scope, action: "webhook_rotate", idempotencyKey: "rotate" },
        {
          url: "https://app.example.com/mail",
          signing_secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
          status: "verification_required",
        },
        "POST",
      ],
      [{ ...scope, action: "webhook_verify", idempotencyKey: "verify" }, domain, "POST"],
      [
        { ...scope, action: "webhook_disable", idempotencyKey: "disable" },
        { status: "disabled" },
        "DELETE",
      ],
      [
        { ...scope, action: "domain_delete", idempotencyKey: "retire" },
        {
          status: "deleted",
          domain: "mail.example.com",
          dns_records: [
            {
              type: "TXT",
              name: "resend._domainkey.mail.example.com",
              value: "p=key",
              purpose: "DKIM",
              status: "verified",
            },
          ],
        },
        "DELETE",
      ],
      [
        { ...scope, action: "messages_list", after: messageId },
        {
          items: [
            {
              message_id: messageId,
              received_at: content.received_at,
              state: "pending",
              attempts: 1,
            },
          ],
        },
        "GET",
      ],
      [{ ...scope, action: "message_get", messageId }, content, "GET"],
      [
        { ...scope, action: "message_retry", messageId, idempotencyKey: "retry" },
        { attempted: true, delivered: false },
        "POST",
      ],
    ];
    for (const [command, body, method] of cases) {
      let captured: Request | undefined;
      const client = createClient({
        baseUrl: "https://app.ohmyho.st",
        fetch: async (request) => {
          captured = new Request(request);
          return Response.json(body);
        },
      });
      expect(await executeManagedMail(client, command)).toEqual(body);
      expect(captured?.method).toBe(method);
      expect(captured?.url).toContain(
        `/projects/${scope.projectId}/environments/${scope.environmentId}/`,
      );
      if ("idempotencyKey" in command)
        expect(captured?.headers.get("idempotency-key")).toBe(command.idempotencyKey);
    }
  });
  it("refuses a mail domain that does not send before any request, since the contract accepts only sending", async () => {
    let requests = 0;
    const client = createClient({
      baseUrl: "https://app.ohmyho.st",
      fetch: async () => {
        requests += 1;
        return Response.json({});
      },
    });
    await expect(
      executeManagedMail(client, {
        ...scope,
        action: "configure",
        domain: "mail.example.com",
        sending: false,
        receiving: false,
        idempotencyKey: "receive-only",
      }),
    ).rejects.toThrow("sending must be true");
    expect(requests).toBe(0);
  });

  it("accepts a rotated signing secret only as the verification-required answer over https", () => {
    const rotate = { ...scope, action: "webhook_rotate", idempotencyKey: "rotate" } as const;
    const answer = {
      url: "https://app.example.com/mail",
      signing_secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
      status: "verification_required",
    };
    expect(() => assertManagedMailResponse(answer, rotate)).not.toThrow();
    expect(() =>
      assertManagedMailResponse({ ...answer, url: "http://app.example.com/mail" }, rotate),
    ).toThrow();
    expect(() => assertManagedMailResponse({ ...answer, status: "disabled" }, rotate)).toThrow();
    expect(() =>
      assertManagedMailResponse({ ...answer, signing_secret: "not-a-secret" }, rotate),
    ).toThrow();
    expect(() =>
      assertManagedMailResponse({ ...answer, api_key: "never-expose" }, rotate),
    ).toThrow();
  });

  it("rejects extra credentials, foreign scope and foreign attachment links", () => {
    expect(() =>
      assertManagedMailResponse(
        { ...domain, api_key: "never-expose" },
        { ...scope, action: "status" },
      ),
    ).toThrow("Mail response contract invalid");
    expect(() =>
      assertManagedMailResponse(
        { ...domain, environment_id: messageId },
        { ...scope, action: "status" },
      ),
    ).toThrow();
    expect(() =>
      assertManagedMailResponse(
        {
          ...content,
          attachments: [
            { ...content.attachments[0], download_path: "https://provider.example/secret" },
          ],
        },
        { ...scope, action: "message_get", messageId },
      ),
    ).toThrow();
    expect(() =>
      assertManagedMailResponse(
        { ...content, to: ["other@foreign.example"] },
        { ...scope, action: "message_get", messageId },
      ),
    ).toThrow();
    expect(() =>
      assertManagedMailResponse(
        { ...content, expires_at: "2026-09-26T00:00:00.000Z" },
        { ...scope, action: "message_get", messageId },
      ),
    ).toThrow();
    expect(() =>
      assertManagedMailResponse(
        { status: "expired" },
        { ...scope, action: "message_get", messageId },
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedMailResponse({ ...domain, domain_id: "bad" }, { ...scope, action: "status" }),
    ).toThrow();
    expect(() =>
      assertManagedMailResponse(
        { ...domain, configured_at: "bad" },
        { ...scope, action: "status" },
      ),
    ).toThrow();
    expect(() => assertManagedMailResponse(null, { ...scope, action: "status" })).toThrow();
  });
});
