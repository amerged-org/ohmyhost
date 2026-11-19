import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createD1ReceivedBillingPersistence } from "../src/d1-received-billing-persistence.js";
import {
  createD1InboundPersistence,
  createD1DeliveryCommands,
  authorizeD1InboundKey,
} from "../src/d1-inbound-persistence.js";
const organizationId = parseUlid("01H00000000000000000000601"),
  projectId = parseUlid("01H00000000000000000000602"),
  environmentId = parseUlid("01H00000000000000000000603"),
  messageId = parseUlid("01H00000000000000000000604"),
  now = "2026-10-29T00:00:00.000Z",
  scope = { organizationId, projectId, environmentId },
  row = {
    message_id: messageId,
    provider_message_id: "opaque original ü" + "x".repeat(300),
    domain_id: messageId,
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environmentId,
    received_at: now,
    expires_at: "2026-11-01T00:00:00.000Z",
    state: "pending",
    attempts: 1,
    first_attempt_at: now,
    lease_until: null,
    next_attempt_at: "2026-10-29T01:00:00.000Z",
    last_http_status: null,
    billed_at: null,
    domain: "mail.example.net",
    webhook_url: "https://receiver.example.net/mail",
    webhook_secret_generation: 0,
  };
function binding() {
  return {
    authorizeKey: vi.fn(async () => ({ ...scope, domain: "mail.example.net" })),
    read: vi.fn(async (input: { messageId: string }) =>
      input.messageId === messageId ? row : null,
    ),
    claim: vi.fn(async () => row),
    complete: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      { message_id: messageId, received_at: now, state: "pending", attempts: 1 },
    ]),
    due: vi.fn(async () => [{ messageId, ...scope }]),
    defer: vi.fn(async () => undefined),
    expire: vi.fn(async () => undefined),
    acceptRetry: vi.fn(async () => ({
      created: false,
      response: ["original", { any: "JSON" }],
      claimedAttempt: 1,
    })),
    resumeRetry: vi.fn(async () => true),
    completeRetry: vi.fn(async () => undefined),
  };
}
it("retains all original full-row/date values and fixed local suppliers without passing message content or closures", async () => {
  const target = binding(),
    port = await createD1InboundPersistence(target),
    request = { ...scope, messageId, now },
    supplier = vi.fn(() => ({ ...request, subject: "stays local", body: "stays local" }));
  expect(await port.read(supplier)).toEqual({
    ...row,
    received_at: new Date(now),
    expires_at: new Date(row.expires_at),
    first_attempt_at: new Date(now),
    next_attempt_at: new Date(row.next_attempt_at),
  });
  expect(supplier).toHaveBeenCalledTimes(1);
  expect(target.read).toHaveBeenLastCalledWith(request);
  expect(
    (await port.claim(() => ({ ...request, manual: true, commandKey: "retry" })))?.first_attempt_at,
  ).toEqual(new Date(now));
  await port.complete(() => ({ messageId, attempt: 1, now, status: 200 }));
  expect(target.complete).toHaveBeenLastCalledWith({ messageId, attempt: 1, now, status: 200 });
  expect(await port.list(() => ({ ...scope, now, after: messageId }))).toEqual([
    { message_id: messageId, received_at: now, state: "pending", attempts: 1 },
  ]);
  expect(await port.due(() => now)).toEqual([{ messageId, ...scope }]);
  await port.expire(() => now);
  const commands = await createD1DeliveryCommands(target),
    accepted = { ...scope, key: "retry", now, digest: new Uint8Array(32).fill(0x47) };
  expect(await commands.accept(() => accepted)).toEqual({
    created: false,
    response: ["original", { any: "JSON" }],
    claimedAttempt: 1,
  });
  expect(target.acceptRetry).toHaveBeenLastCalledWith({
    ...scope,
    key: "retry",
    now,
    digest: "47".repeat(32),
  });
  expect(await commands.resume(() => accepted)).toBe(true);
  await commands.complete(() => ({ ...accepted, response: { attempted: true } }));
  expect(target.completeRetry).toHaveBeenLastCalledWith({
    ...scope,
    key: "retry",
    now,
    response: { attempted: true },
  });
  expect(
    await authorizeD1InboundKey(target, { projectId, keySha256: new Uint8Array(32).fill(0x47) }),
  ).toEqual({ ...scope, domain: "mail.example.net" });
  expect(target.authorizeKey).toHaveBeenLastCalledWith({
    projectId,
    keySha256: "47".repeat(32),
    receiving: true,
  });
  const zero = "00000000000000000000000000",
    retained = {
      ...target,
      read: async () => ({
        ...row,
        organization_id: zero,
        project_id: zero,
        environment_id: zero,
        message_id: zero,
      }),
    };
  await expect(createD1InboundPersistence(retained)).resolves.toBeDefined();
  await expect(createD1DeliveryCommands(retained)).resolves.toBeDefined();
  const billingTarget = {
      unbilled: vi.fn(async () => [messageId]),
      bill: vi.fn(async () => undefined),
    },
    billing = await createD1ReceivedBillingPersistence(billingTarget);
  expect(await billing.unbilled()).toEqual([messageId]);
  await billing.bill(() => ({
    messageId,
    valuationId: projectId,
    now,
    organizationId,
    amountMicros: "forbidden",
  }));
  expect(billingTarget.bill).toHaveBeenLastCalledWith({ messageId, now });
});
it("rejects malformed bindings and exact invalid replies, including a claimed attempt without its original first-attempt time", async () => {
  await expect(createD1InboundPersistence(null)).rejects.toThrow(
    "mail_delivery_core_binding_required",
  );
  await expect(createD1InboundPersistence({})).rejects.toThrow(
    "mail_delivery_core_binding_required",
  );
  await expect(createD1DeliveryCommands(null)).rejects.toThrow(
    "mail_delivery_core_binding_required",
  );
  await expect(createD1DeliveryCommands({})).rejects.toThrow("mail_delivery_core_binding_required");
  await expect(createD1ReceivedBillingPersistence({})).rejects.toThrow(
    "mail_received_billing_core_binding_required",
  );
  await expect(
    createD1ReceivedBillingPersistence({
      unbilled: async () => ({ ready: true }),
      bill: async () => undefined,
    }),
  ).rejects.toThrow("mail_received_billing_core_response_invalid");
  await expect(
    authorizeD1InboundKey(null, { projectId, keySha256: new Uint8Array(32) }),
  ).rejects.toThrow("mail_delivery_core_binding_required");
  await expect(
    createD1InboundPersistence({ ...binding(), read: async () => ({ ready: true }) }),
  ).rejects.toThrow("mail_delivery_core_response_invalid");
  await expect(createD1DeliveryCommands({ ...binding(), read: async () => row })).rejects.toThrow(
    "mail_delivery_core_response_invalid",
  );
  const target = binding(),
    port = await createD1InboundPersistence(target);
  target.authorizeKey.mockResolvedValueOnce(null as never);
  expect(
    await authorizeD1InboundKey(target, { projectId, keySha256: new Uint8Array(32) }),
  ).toBeNull();
  expect(await port.read(() => ({ ...scope, messageId: organizationId, now }))).toBeNull();
  target.claim.mockResolvedValueOnce(null as never);
  expect(await port.claim(() => ({ ...scope, messageId, now }))).toBeNull();
  target.claim.mockResolvedValueOnce({ ...row, first_attempt_at: null } as never);
  await expect(port.claim(() => ({ ...scope, messageId, now }))).rejects.toThrow(
    "mail_delivery_core_response_invalid",
  );
  target.list.mockResolvedValueOnce([{ ...row, unexpected: "refused" }] as never);
  await expect(port.list(() => ({ ...scope, now }))).rejects.toThrow(
    "mail_delivery_core_response_invalid",
  );
});
it("surfaces committed unknown errors and classifies unavailable RPC without reconstructing a claim", async () => {
  const target = binding(),
    port = await createD1InboundPersistence(target),
    request = { ...scope, messageId, now };
  target.claim.mockRejectedValueOnce(new Error("remote: store_outcome_unknown"));
  await expect(port.claim(() => request)).rejects.toMatchObject({ code: "store_outcome_unknown" });
  expect(target.claim).toHaveBeenCalledTimes(1);
  target.claim.mockRejectedValueOnce(new Error("missing remote method"));
  await expect(port.claim(() => request)).rejects.toThrow("mail_delivery_core_unavailable");
  const commands = await createD1DeliveryCommands(target);
  target.acceptRetry.mockRejectedValueOnce(new Error("remote: idempotency_key_reused"));
  await expect(
    commands.accept(() => ({ ...scope, key: "retry", digest: new Uint8Array(32), now })),
  ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  const billingTarget = {
      unbilled: async () => [],
      bill: vi.fn(async () => {
        throw new Error("remote: store_outcome_unknown");
      }),
    },
    billing = await createD1ReceivedBillingPersistence(billingTarget);
  await expect(
    billing.bill(() => ({ messageId, valuationId: projectId, now })),
  ).rejects.toMatchObject({ code: "store_outcome_unknown" });
  expect(billingTarget.bill).toHaveBeenCalledTimes(1);
});
