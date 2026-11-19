import { expect, it, vi } from "vitest";
import { minimizeResendObservation } from "../src/resend-observation.js";
const now = "2026-10-29T00:00:00.000Z",
  messageId = "01H00000000000000000000601",
  requestId = "01H00000000000000000000602",
  projectId = "01H00000000000000000000603";
function event(type: string, data: Record<string, unknown>) {
  return {
    eventId: "evt_original",
    type,
    createdAt: now,
    data,
    now,
    digest: new Uint8Array(32).fill(0x47),
    nextMessageId: vi.fn(() => messageId),
  };
}
it("keeps original receiving identity/time and only unique lower-case recipient domains, with no body or address in the closed observation", () => {
  const input = event("email.received", {
      email_id: "provider_original",
      created_at: "2026-10-28T23:59:59.123456Z",
      to: [
        "Private Name <first@EXAMPLE.com>",
        "second@example.com",
        "third@other.example",
        "invalid",
        5,
      ],
      subject: "private subject",
      text: "private body",
      html: "private html",
      from: "sender@secret.example",
    }),
    result = minimizeResendObservation(input),
    wire = JSON.stringify(result);
  expect(result.received).toEqual({
    recipientDomains: ["example.com", "other.example"],
    receivedAt: "2026-10-28T23:59:59.123Z",
    messageId,
  });
  expect(input.nextMessageId).toHaveBeenCalledTimes(1);
  expect(result.digest).toBe("47".repeat(32));
  for (const value of [
    "private subject",
    "private body",
    "private html",
    "first@",
    "sender@",
    "Private Name",
  ])
    expect(wire).not.toContain(value);
  const many = event("email.received", {
    email_id: "provider_original",
    to: Array.from({ length: 101 }, (_, i) => `local@domain${i}.example`),
  });
  expect(minimizeResendObservation(many).received).toBeNull();
  expect(many.nextMessageId).not.toHaveBeenCalled();
  const invalid = event("email.received", {
    email_id: "provider_original",
    created_at: "invalid",
    to: ["local@example.com"],
  });
  expect(minimizeResendObservation(invalid).received).toEqual({
    recipientDomains: ["example.com"],
    receivedAt: null,
    messageId: null,
  });
  expect(invalid.nextMessageId).not.toHaveBeenCalled();
});
it("retains the original signed-domain classification, including disabled capability versus verification and deferred invalid owned facts", () => {
  const data = {
    id: "domain_provider",
    name: "Mail.Example.com",
    capabilities: { sending: "disabled", receiving: "enabled" },
    status: "verified",
    records: [
      { record: "DKIM", status: "verified" },
      { record: "SPF", status: "verified" },
      { record: "Receiving MX", status: "failed" },
    ],
  };
  expect(minimizeResendObservation(event("domain.updated", data)).domain).toEqual({
    providerDomainId: "domain_provider",
    domain: "Mail.Example.com",
    valid: true,
    sending: "pending",
    receiving: "failed",
    workspaceSending: "ready",
  });
  expect(
    minimizeResendObservation(
      event("domain.updated", { ...data, capabilities: { sending: "enabled" }, status: "failed" }),
    ).domain,
  ).toMatchObject({ sending: "ready", receiving: "pending", workspaceSending: "failed" });
  expect(
    minimizeResendObservation(event("domain.updated", { ...data, records: [] })).domain,
  ).toMatchObject({ sending: "pending", workspaceSending: "pending" });
  expect(
    minimizeResendObservation(event("domain.updated", { ...data, records: null })).domain,
  ).toMatchObject({ valid: false });
  const withoutCapabilities = { ...data };
  Reflect.deleteProperty(withoutCapabilities, "capabilities");
  expect(minimizeResendObservation(event("domain.updated", withoutCapabilities)).domain).toEqual({
    providerDomainId: "domain_provider",
    domain: "Mail.Example.com",
    valid: true,
    sending: null,
    receiving: null,
    workspaceSending: "ready",
  });
  expect(minimizeResendObservation(event("domain.deleted", data)).domain).toMatchObject({
    sending: "failed",
    receiving: "failed",
    workspaceSending: "failed",
  });
  expect(minimizeResendObservation(event("email.sent", data)).domain).toBeNull();
});
it("keeps original owned tags/permanent-bounce facts without forwarding arbitrary provider payloads or drawing receiving ids", () => {
  const input = event("email.bounced", {
      email_id: "provider_original",
      tags: {
        request_id: requestId,
        project_id: projectId,
        notice_id: "private@address.example",
        arbitrary: "private tag",
      },
      bounce: { type: "Permanent", message: "private diagnostic" },
      to: ["private@address.example"],
      subject: "private",
    }),
    result = minimizeResendObservation(input);
  expect(result.delivery).toEqual({
    requestId,
    projectId,
    permanentBounce: true,
  });
  expect(result.received).toBeNull();
  expect(input.nextMessageId).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private");
  expect(minimizeResendObservation({ ...input, createdAt: "invalid" }).occurredAt).toBeNull();
});
