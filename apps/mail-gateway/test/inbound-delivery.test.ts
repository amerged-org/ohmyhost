import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createD1WorkspaceMailCapabilityPersistence } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import { mailWebhookSecret } from "@ohmyhost/provider-resend";
import { MailCapabilityRuntime, MailDeliveryRuntime } from "../../control-store/src/worker-main.js";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { storedTimestamp } from "../../control-store/src/timestamps.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { fundMail, seedReadyMailDomain } from "../../control-store/test/support/mail-domain.js";
import { createInboundMailDelivery } from "../src/inbound-delivery.js";
import { createD1InboundPersistence } from "../src/d1-inbound-persistence.js";
import { syncResendReceivingAdmission } from "../src/resend-admission.js";
import { createD1ReceivingAdmissionPersistence } from "../src/receiving-admission-persistence.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const TIME = "2026-10-29T10:00:00.000Z",
  HOUR = 3_600_000,
  signingKey = Buffer.alloc(32, 1).toString("base64");
let control: TestControl | undefined;
afterEach(async () => {
  await control?.dispose();
  control = undefined;
});

/** One ready receiving domain with one received, still pending message, written straight into the Core. */
async function rig() {
  control = await createTestControl();
  const project = await seedProject(control),
    domain = await seedReadyMailDomain(control, project),
    messageId = parseUlid(newUlid()),
    providerId = `provider_${messageId}`;
  await control.core
    .prepare(
      "INSERT INTO mail_received_messages(organization_id,message_id,provider_message_id,domain_id,project_id,environment_id,received_at,expires_at,state,attempts,next_attempt_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,?7)",
    )
    .bind(
      domain.scope.organizationId,
      messageId,
      providerId,
      domain.domainId,
      domain.scope.projectId,
      domain.scope.environmentId,
      storedTimestamp(TIME),
      storedTimestamp(new Date(Date.parse(TIME) + 72 * HOUR).toISOString()),
    )
    .run();
  const persistence = await createD1InboundPersistence(
    new MailDeliveryRuntime({} as never, control.bindings as never),
  );
  return {
    control,
    domain,
    messageId,
    providerId,
    persistence,
    scope: domain.scope,
    owned: { ...domain.scope, messageId },
    setReceiving: (receiving: boolean) =>
      control?.core
        .prepare("UPDATE resend_mail_domains SET receiving=?2 WHERE domain_id=?1")
        .bind(domain.domainId, Number(receiving))
        .run(),
  };
}

const attachmentInfo = (size: number) =>
  Response.json({
    id: "attachment-1",
    download_url: "https://inbound-cdn.resend.com/mail/attachment-1",
    content_type: "text/plain",
    filename: "note.txt",
    size,
    expires_at: new Date(Date.parse(TIME) + 72 * HOUR).toISOString(),
  });
const isProviderApi = (url: RequestInfo | URL) => String(url).startsWith("https://api.resend.com/");

it("bounds attachment downloads and rechecks the 72-hour ownership deadline", async () => {
  const { persistence, owned, setReceiving } = await rig(),
    body = "customer private attachment";
  let pulls = 0,
    current = new Date(TIME),
    expireDuringFetch = false;
  const create = (options: Partial<Parameters<typeof createInboundMailDelivery>[0]>) =>
    createInboundMailDelivery({
      persistence,
      apiKey: "re_admin",
      signingKey,
      now: () => current,
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      ...options,
    });
  const service = create({
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (isProviderApi(url)) return attachmentInfo(body.length);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (expireDuringFetch) current = new Date(Date.parse(TIME) + 72 * HOUR);
      return new Response(
        new ReadableStream(
          {
            type: "bytes",
            pull(controller) {
              pulls++;
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  const attachmentId = { ...owned, attachmentId: "attachment-1" };
  const result = await service.attachment(attachmentId);
  expect(result).toBeInstanceOf(Response);
  expect(pulls).toBe(0);
  expect(await result?.text()).toBe(body);

  const oversized = await create({
    maximumAttachmentBytes: 5,
    fetch: async (url) => (isProviderApi(url) ? attachmentInfo(5) : new Response("six bytes")),
  }).attachment(attachmentId);
  await expect(oversized?.text()).rejects.toMatchObject({ code: "mail_attachment_too_large" });

  let bodyRead = false;
  await expect(
    create({
      maximumAttachmentBytes: 5,
      fetch: async (url) =>
        isProviderApi(url)
          ? attachmentInfo(5)
          : new Response(
              new ReadableStream(
                {
                  pull(controller) {
                    bodyRead = true;
                    controller.enqueue(new TextEncoder().encode("x"));
                    controller.close();
                  },
                },
                { highWaterMark: 0 },
              ),
              { headers: { "content-length": "6" } },
            ),
    }).attachment(attachmentId),
  ).rejects.toMatchObject({ code: "mail_attachment_too_large" });
  expect(bodyRead).toBe(false);

  // Real ownership revocation is observed before the next chunk can leave the gateway.
  let streamedBytes = 0,
    streamCancelled = 0;
  const ongoing = await create({
    fetch: async (url) =>
      isProviderApi(url)
        ? attachmentInfo(2 * 1024 * 1024)
        : new Response(
            new ReadableStream(
              {
                type: "bytes",
                pull(controller) {
                  streamedBytes += 64 * 1024;
                  controller.enqueue(new Uint8Array(64 * 1024));
                },
                cancel() {
                  streamCancelled++;
                },
              },
              { highWaterMark: 0 },
            ),
          ),
  }).attachment(attachmentId);
  const reader = ongoing?.body?.getReader();
  expect((await reader?.read())?.value?.byteLength).toBe(64 * 1024);
  await setReceiving(false);
  current = new Date(Date.parse(TIME) + 1001);
  await expect(reader?.read()).rejects.toThrow("Mail attachment unavailable");
  expect(streamedBytes).toBe(64 * 1024);
  expect(streamCancelled).toBe(1);
  expect(await service.attachment(attachmentId)).toBeNull();
  await setReceiving(true);
  current = new Date(Date.parse(TIME) + 71 * HOUR);
  expireDuringFetch = true;
  await expect(service.attachment(attachmentId)).rejects.toMatchObject({
    code: "mail_content_expired",
  });
  expect(() => create({ maximumAttachmentBytes: 0 })).toThrow("Invalid mail attachment limit");
}, 60_000);

it("delivers content with a stable signed event and shares the four-attempt limit", async () => {
  const { persistence, owned, scope, messageId, providerId, domain } = await rig();
  let current = new Date(TIME);
  const deliveries: Request[] = [],
    service = createInboundMailDelivery({
      persistence,
      apiKey: "re_test",
      signingKey,
      now: () => current,
      publicTarget: async (value) => new URL(value),
      fetch: async (url, init) => {
        if (isProviderApi(url))
          return Response.json({
            id: providerId,
            from: "guest@example.com",
            to: [`bookings@${domain.domain}`, "someone@external.example"],
            subject: "My booking",
            text: "Please confirm",
            html: null,
            message_id: "<original@example.com>",
            attachments: [
              { id: "attachment-1", filename: "booking.pdf", content_type: "application/pdf" },
            ],
          });
        deliveries.push(new Request(url, init));
        return new Response(null, { status: 500 });
      },
    });
  expect(await service.list(scope)).toMatchObject([
    { message_id: messageId, state: "pending", attempts: 0 },
  ]);
  expect((await service.content(owned))?.attachments).toEqual([
    {
      id: "attachment-1",
      filename: "booking.pdf",
      content_type: "application/pdf",
      download_path: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/mail/messages/${messageId}/attachments/attachment-1`,
    },
  ]);
  for (const hours of [0, 1, 24, 71]) {
    current = new Date(Date.parse(TIME) + hours * HOUR);
    await service.sync();
  }
  expect(deliveries).toHaveLength(4);
  const first = deliveries[0];
  if (!first) throw new Error("Missing delivery");
  expect(((await first.json()) as { data: { to: string[] } }).data.to).toEqual([
    `bookings@${domain.domain}`,
  ]);
  expect(deliveries.map((request) => request.headers.get("webhook-id"))).toEqual(
    Array(4).fill(messageId),
  );
  expect(
    deliveries.every(
      (request) => request.redirect === "manual" && request.headers.has("webhook-signature"),
    ),
  ).toBe(true);
  expect(await service.deliver({ ...owned, manual: true })).toEqual({ attempted: false });
  current = new Date(Date.parse(TIME) + 72 * HOUR);
  await expect(service.content(owned)).rejects.toMatchObject({ code: "mail_content_expired" });
  expect(await service.deliver(owned)).toEqual({ attempted: false });
  expect(deliveries).toHaveLength(4);
}, 60_000);

it("cannot retrieve foreign messages or deliver after disablement", async () => {
  const { persistence, owned, setReceiving } = await rig();
  let providerCalls = 0;
  const service = createInboundMailDelivery({
    persistence,
    apiKey: "re_test",
    signingKey,
    now: () => new Date(TIME),
    fetch: async () => {
      providerCalls++;
      throw new Error("must not fetch");
    },
  });
  expect(await service.content({ ...owned, projectId: parseUlid(newUlid()) })).toBeNull();
  await setReceiving(false);
  expect(await service.deliver(owned)).toEqual({ attempted: false });
  expect(providerCalls).toBe(0);
}, 60_000);

it("suspends unpaid receiving upstream and resumes the same domain after Paid access returns", async () => {
  const { control: core, domain, scope } = await rig(),
    patches: unknown[] = [];
  let serial = 500;
  const input = {
    persistence: await createD1ReceivingAdmissionPersistence(
      new MailDeliveryRuntime({} as never, core.bindings as never),
    ),
    capabilities: await createD1WorkspaceMailCapabilityPersistence(
      new MailCapabilityRuntime({} as never, core.bindings as never),
    ),
    apiKey: "re_admin",
    ids: { next: () => parseUlid(String(serial++).padStart(26, "0")) },
    now: () => new Date(TIME),
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      if (request.method === "PATCH") {
        patches.push(await request.json());
        return Response.json({ id: domain.providerDomainId });
      }
      return Response.json({
        id: domain.providerDomainId,
        name: domain.domain,
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
          {
            record: "Receiving MX",
            type: "MX",
            name: "@",
            value: "inbound-smtp.us-east-1.amazonaws.com",
            priority: 10,
            status: "verified",
          },
        ],
      });
    },
  };
  const state = async () =>
    core.core
      .prepare(
        "SELECT receiving_suspended s,receiving_status r FROM resend_mail_domains WHERE domain_id=?",
      )
      .bind(domain.domainId)
      .first<{ s: number; r: string }>();
  expect(await syncResendReceivingAdmission(input)).toEqual({
    checked: 1,
    suspended: 1,
    resumed: 0,
    failed: 0,
  });
  expect(patches[0]).toEqual({ capabilities: { sending: "enabled", receiving: "disabled" } });
  expect(await state()).toEqual({ s: 1, r: "disabled" });
  await fundMail(core, scope.organizationId);
  expect(await syncResendReceivingAdmission(input)).toEqual({
    checked: 1,
    suspended: 0,
    resumed: 1,
    failed: 0,
  });
  expect(patches[1]).toEqual({ capabilities: { sending: "enabled", receiving: "enabled" } });
  expect(await state()).toEqual({ s: 0, r: "ready" });
}, 60_000);

it("keeps one tenant's undeliverable mail from holding the due queue of every other tenant", async () => {
  control = await createTestControl();
  const blocked = await seedProject(control),
    healthy = await seedProject(control);
  const blockedDomain = await seedReadyMailDomain(control, blocked),
    healthyDomain = await seedReadyMailDomain(control, healthy);
  // The blocked tenant's webhook host no longer resolves, so every attempt fails before a customer request leaves.
  await control.core
    .prepare("UPDATE resend_mail_domains SET webhook_url=?2 WHERE domain_id=?1")
    .bind(blockedDomain.domainId, "https://gone.example.test/mail")
    .run();
  const persistence = await createD1InboundPersistence(
    new MailDeliveryRuntime({} as never, control.bindings as never),
  );
  const receive = async (
    domain: { domainId: string; scope: { organizationId: string } },
    scope: { projectId: string; prodEnvironmentId: string },
    receivedAt: string,
  ): Promise<string> => {
    const messageId = parseUlid(newUlid());
    await control?.core
      .prepare(
        "INSERT INTO mail_received_messages(organization_id,message_id,provider_message_id,domain_id,project_id,environment_id,received_at,expires_at,state,attempts,next_attempt_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,?7)",
      )
      .bind(
        domain.scope.organizationId,
        messageId,
        `provider_${messageId}`,
        domain.domainId,
        scope.projectId,
        scope.prodEnvironmentId,
        storedTimestamp(receivedAt),
        storedTimestamp(new Date(Date.parse(receivedAt) + 72 * HOUR).toISOString()),
      )
      .run();
    return messageId;
  };
  // Twenty older messages of the blocked tenant sit ahead of one newer message of the healthy tenant.
  for (let index = 0; index < 20; index++)
    await receive(
      blockedDomain,
      blocked,
      new Date(Date.parse(TIME) - (2 + index) * 60_000).toISOString(),
    );
  const healthyMessage = await receive(healthyDomain, healthy, TIME);

  const deliveries: Request[] = [];
  const service = createInboundMailDelivery({
    persistence,
    apiKey: "re_test",
    signingKey,
    now: () => new Date(TIME),
    publicTarget: async (value) => {
      if (new URL(value).hostname === "gone.example.test") throw new Error("dns_unresolvable");
      return new URL(value);
    },
    fetch: async (url, init) => {
      if (isProviderApi(url))
        return Response.json({
          id: `provider_${healthyMessage}`,
          from: "guest@example.com",
          to: [`bookings@${healthyDomain.domain}`],
          subject: "Booking",
          text: "Confirm",
          html: null,
          message_id: "<original@example.com>",
          attachments: [],
        });
      deliveries.push(new Request(url, init));
      return new Response(null, { status: 200 });
    },
  });
  await service.sync();
  await service.sync();

  expect(deliveries.map((request) => request.headers.get("webhook-id"))).toEqual([healthyMessage]);
  const stalled = await control.core
    .prepare(
      "SELECT count(*) AS total, sum(attempts) AS attempts, min(next_attempt_at) AS earliest FROM mail_received_messages WHERE organization_id=?1 AND state='pending'",
    )
    .bind(blocked.organizationId)
    .first<{ total: number; attempts: number; earliest: string }>();
  expect(stalled).toMatchObject({ total: 20, attempts: 0 });
  // The prerequisite failure defers each blocked message past this clock instead of leaving it at the head.
  expect(stalled?.earliest !== undefined && stalled.earliest > storedTimestamp(TIME)).toBe(true);
}, 60_000);

it("defers a crashed claim whose prerequisite fails, so it leaves the head of the due queue too", async () => {
  control = await createTestControl();
  const blocked = await seedProject(control);
  const blockedDomain = await seedReadyMailDomain(control, blocked);
  await control.core
    .prepare("UPDATE resend_mail_domains SET webhook_url=?2 WHERE domain_id=?1")
    .bind(blockedDomain.domainId, "https://gone.example.test/mail")
    .run();
  const persistence = await createD1InboundPersistence(
    new MailDeliveryRuntime({} as never, control.bindings as never),
  );
  // A first claim started two hours ago and crashed before its outcome was stored: its lease lapsed one minute ago.
  const messageId = parseUlid(newUlid());
  await control.core
    .prepare(
      "INSERT INTO mail_received_messages(organization_id,message_id,provider_message_id,domain_id,project_id,environment_id,received_at,expires_at,state,attempts,first_attempt_at,lease_until,next_attempt_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'delivering',1,?9,?10,?9)",
    )
    .bind(
      blockedDomain.scope.organizationId,
      messageId,
      `provider_${messageId}`,
      blockedDomain.domainId,
      blocked.projectId,
      blocked.prodEnvironmentId,
      storedTimestamp(new Date(Date.parse(TIME) - 3 * HOUR).toISOString()),
      storedTimestamp(new Date(Date.parse(TIME) + 69 * HOUR).toISOString()),
      storedTimestamp(new Date(Date.parse(TIME) - 2 * HOUR).toISOString()),
      storedTimestamp(new Date(Date.parse(TIME) - 60_000).toISOString()),
    )
    .run();
  const service = createInboundMailDelivery({
    persistence,
    apiKey: "re_test",
    signingKey,
    now: () => new Date(TIME),
    publicTarget: async () => {
      throw new Error("dns_unresolvable");
    },
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
  });
  await service.sync();
  const row = await control.core
    .prepare(
      "SELECT state, attempts, next_attempt_at FROM mail_received_messages WHERE message_id=?1",
    )
    .bind(messageId)
    .first<{ state: string; attempts: number; next_attempt_at: string }>();
  expect(row).toMatchObject({ state: "delivering", attempts: 1 });
  expect(row?.next_attempt_at !== undefined && row.next_attempt_at > storedTimestamp(TIME)).toBe(
    true,
  );
}, 60_000);

it("signs each delivery with the current webhook generation: rotation stops receiving until the new secret verifies, then only the new secret verifies", async () => {
  const { control: core, persistence, owned, domain } = await rig(),
    receiver = "https://receiver.example.com/mail",
    deliveries: Request[] = [];
  const service = createInboundMailDelivery({
    persistence,
    apiKey: "re_test",
    signingKey,
    now: () => new Date(TIME),
    publicTarget: async (value) => new URL(value),
    fetch: async (url, init) => {
      if (isProviderApi(url))
        return Response.json({
          id: `provider_${owned.messageId}`,
          from: "guest@example.com",
          to: [`bookings@${domain.domain}`],
          subject: "My booking",
          text: "Please confirm",
          html: null,
          message_id: "<original@example.com>",
          attachments: [],
        });
      deliveries.push(new Request(url, init));
      return new Response(null, { status: 500 });
    },
  });
  // A request verifies when its signature matches the receiver's secret, exactly as a customer endpoint computes it.
  const verifies = async (request: Request | undefined, secret: string) => {
    if (!request) return false;
    const id = request.headers.get("webhook-id"),
      timestamp = request.headers.get("webhook-timestamp"),
      body = await request.clone().text();
    return (
      request.headers.get("webhook-signature") ===
      "v1," +
        createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
          .update(`${id}.${timestamp}.${body}`)
          .digest("base64")
    );
  };
  const generation0 = mailWebhookSecret(signingKey, domain.domainId),
    generation1 = mailWebhookSecret(signingKey, domain.domainId, 1);
  await service.deliver({ ...owned, manual: true });
  expect(deliveries).toHaveLength(1);
  expect(await verifies(deliveries[0], generation0)).toBe(true);
  expect(await verifies(deliveries[0], generation1)).toBe(false);

  // The owner rotates the secret; receiving waits for the receiver to verify the new secret.
  const store = createControlStore(core.bindings);
  await store.mailManagement.change({
    change: { action: "rotateWebhookSecret", domainId: domain.domainId },
  });
  expect(await service.deliver({ ...owned, manual: true })).toEqual({ attempted: false });
  expect(deliveries).toHaveLength(1);
  await store.mailManagement.change({
    change: { action: "verifyWebhook", domainId: domain.domainId, url: receiver },
    now: new Date(TIME).toISOString(),
  });

  await service.deliver({ ...owned, manual: true });
  expect(deliveries).toHaveLength(2);
  expect(await verifies(deliveries[1], generation1)).toBe(true);
  expect(await verifies(deliveries[1], generation0)).toBe(false);
}, 60_000);
