import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { ensureAccount } from "../../src/catalog/credit/index.js";
import { createControlStore } from "../../src/store.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  fundOrganization,
  iso,
  publishMailPricing,
  seedMailRig,
  sha,
  type MailStore,
} from "../support/mail-events-fixture.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";

let control: TestControl, store: MailStore;
beforeEach(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  await publishMailPricing(control);
}, 120_000);
afterEach(async () => control?.dispose());

const first = (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

describe("receiving admission", () => {
  it("lists live receivers, changes the local flags phase by phase and reads the monthly decision", async () => {
    const rig = await seedMailRig(control);
    await fundOrganization(control, rig.scope.organizationId, rig.now);
    expect(await store.mailDelivery.listAdmission({})).toContainEqual(
      expect.objectContaining({
        domain_id: rig.domainId,
        sending: true,
        receiving_suspended: false,
      }),
    );
    const flags = () =>
      first(
        "SELECT receiving_suspended,receiving_status,last_entitlement_check_at FROM resend_mail_domains WHERE domain_id=?",
        rig.domainId,
      );
    await store.mailDelivery.changeAdmission({ domainId: rig.domainId, phase: "suspend" });
    expect(await flags()).toMatchObject({ receiving_suspended: 1 });
    await store.mailDelivery.changeAdmission({ domainId: rig.domainId, phase: "resume" });
    expect(await flags()).toMatchObject({ receiving_suspended: 0 });
    await store.mailDelivery.changeAdmission({ domainId: rig.domainId, phase: "disable" });
    expect(await flags()).toMatchObject({ receiving_status: "disabled" });
    await store.mailDelivery.changeAdmission({
      domainId: rig.domainId,
      phase: "observed",
      now: rig.now,
      ready: true,
    });
    expect(await flags()).toMatchObject({ receiving_status: "ready" });
    await store.mailDelivery.changeAdmission({
      domainId: rig.domainId,
      phase: "checked",
      now: rig.now,
    });
    expect(await flags()).toMatchObject({ last_entitlement_check_at: storedTimestamp(rig.now) });
    await expect(
      store.mailDelivery.changeAdmission({ domainId: rig.domainId, phase: "observed" }),
    ).rejects.toThrow("Invalid admission clock");
    expect(
      await store.mailDelivery.readAdmission({
        ...rig.scope,
        now: rig.now,
      }),
    ).toEqual({ allowed: true, paidAllowed: true });
  });
});

describe("credit warnings", () => {
  /** The organization of a rig, beta admitted and exhausted since `exhaustedAt` with its month running to 2099. */
  async function exhausted(exhaustedAt: string) {
    const rig = await seedMailRig(control),
      organizationId = rig.scope.organizationId;
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=? WHERE organization_id=?")
      .bind(storedTimestamp(iso(-86_400_000)), organizationId)
      .run();
    await control.core.batch(
      ensureAccount(control.core, { organizationId, now: iso() }).statements,
    );
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_micros=0,onetime_micros=0,monthly_ends_at='2099-01-01T00:00:00.000000Z',exhausted_at=? WHERE organization_id=?",
      )
      .bind(storedTimestamp(exhaustedAt), organizationId)
      .run();
    return organizationId;
  }
  const account = (organizationId: string) =>
    first(
      "SELECT exhausted_at,warned_for_exhausted_at,warning_next_attempt_at FROM credit_account WHERE organization_id=?",
      organizationId,
    );

  it("leases a due exhaustion once, retries a period that reached nobody and warns once per episode", async () => {
    const exhaustedAt = iso(-3_600_000),
      now = iso(),
      organizationId = await exhausted(exhaustedAt);
    const [period] = await store.mailWarnings.claimPeriods({ now });
    expect(period).toEqual({
      organizationId,
      exhaustedAt,
      leaseUntil: expect.stringMatching(/Z$/u),
    });
    const lease = period?.leaseUntil ?? "";
    expect(Date.parse(lease) - Date.parse(now)).toBe(900_000);
    // the lease holds the period for every other run
    expect(await store.mailWarnings.claimPeriods({ now: iso(60_000) })).toEqual([]);
    const finish = (delivered: boolean, at: string, leaseUntil = lease) =>
      store.mailWarnings.finishPeriod({
        organizationId,
        exhaustedAt,
        leaseUntil,
        now: at,
        delivered,
      });
    // only the holder of the lease finishes it
    expect(await finish(true, now, iso(-1))).toBe(false);
    expect(await account(organizationId)).toMatchObject({ warned_for_exhausted_at: null });
    // a warning that reached nobody is tried again after five minutes
    const failedAt = iso(120_000);
    expect(await finish(false, failedAt)).toBe(true);
    expect(await store.mailWarnings.claimPeriods({ now: iso(240_000) })).toEqual([]);
    const [retry] = await store.mailWarnings.claimPeriods({ now: iso(7 * 60_000) });
    expect(retry).toMatchObject({ organizationId, exhaustedAt });
    // a delivered warning marks the episode and ends the claims
    expect(await finish(true, iso(8 * 60_000), retry?.leaseUntil ?? "")).toBe(true);
    expect(await account(organizationId)).toEqual({
      exhausted_at: storedTimestamp(exhaustedAt),
      warned_for_exhausted_at: storedTimestamp(exhaustedAt),
      warning_next_attempt_at: null,
    });
    expect(await store.mailWarnings.claimPeriods({ now: iso(3_600_000) })).toEqual([]);
    // a top-up and a later exhaustion are a new episode that warns again
    const again = iso(7_200_000);
    await control.core
      .prepare("UPDATE credit_account SET exhausted_at=? WHERE organization_id=?")
      .bind(storedTimestamp(again), organizationId)
      .run();
    expect(await store.mailWarnings.claimPeriods({ now: iso(7_300_000) })).toMatchObject([
      { organizationId, exhaustedAt: again },
    ]);
  });

  it("resolves the recipients of the exact exhaustion episode of an active beta organization only", async () => {
    const exhaustedAt = iso(-3_600_000),
      organizationId = await exhausted(exhaustedAt),
      workos = (
        await first(
          "SELECT workos_organization_id w FROM organizations WHERE organization_id=?",
          organizationId,
        )
      )?.["w"];
    expect(await store.identity.readCreditWarningScope({ organizationId, exhaustedAt })).toBe(
      workos,
    );
    expect(
      await store.identity.readCreditWarningScope({ organizationId, exhaustedAt: iso(-1000) }),
    ).toBeNull();
  });

  it("claims nothing for a renewed month, an organization outside the beta or a credit that is not exhausted", async () => {
    const organizationId = await exhausted(iso(-3_600_000));
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_ends_at='2000-01-01T00:00:00.000000Z' WHERE organization_id=?",
      )
      .bind(organizationId)
      .run();
    expect(await store.mailWarnings.claimPeriods({ now: iso() })).toEqual([]);
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_ends_at='2099-01-01T00:00:00.000000Z' WHERE organization_id=?",
      )
      .bind(organizationId)
      .run();
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=NULL WHERE organization_id=?")
      .bind(organizationId)
      .run();
    expect(await store.mailWarnings.claimPeriods({ now: iso() })).toEqual([]);
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=? WHERE organization_id=?")
      .bind(storedTimestamp(iso(-1000)), organizationId)
      .run();
    await control.core
      .prepare("UPDATE credit_account SET exhausted_at=NULL WHERE organization_id=?")
      .bind(organizationId)
      .run();
    expect(await store.mailWarnings.claimPeriods({ now: iso() })).toEqual([]);
  });

  it("gives two concurrent runs one lease and reports a lost reply as an unknown outcome", async () => {
    const organizationId = await exhausted(iso(-3_600_000)),
      now = iso();
    const claimed = await Promise.all([
      store.mailWarnings.claimPeriods({ now }),
      store.mailWarnings.claimPeriods({ now }),
    ]);
    expect(claimed.flat()).toHaveLength(1);
    const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    await control.core
      .prepare("UPDATE credit_account SET warning_next_attempt_at=NULL WHERE organization_id=?")
      .bind(organizationId)
      .run();
    await expect(lossy.mailWarnings.claimPeriods({ now: iso(1000) })).rejects.toThrow(
      "mail.claimWarningPeriods: store_outcome_unknown",
    );
  });
});

describe("signed Resend events", () => {
  const event = (overrides: Record<string, unknown>) => ({
    eventId: `evt_${newUlid()}`,
    type: "email.delivered",
    occurredAt: iso(),
    providerMessageId: null,
    digest: sha(newUlid()),
    now: iso(),
    domain: null,
    delivery: null,
    received: null,
    ...overrides,
  });

  it("applies a domain observation once, replays the receipt and refuses a different payload under the same id", async () => {
    const rig = await seedMailRig(control),
      pending = {
        providerDomainId: rig.providerDomainId,
        domain: rig.domain,
        valid: true,
        sending: "pending",
        receiving: "pending",
        workspaceSending: "pending",
      },
      observed = event({ type: "domain.updated", domain: pending });
    await store.mailIngress.ingest(observed);
    expect(
      await first(
        "SELECT sending_status,receiving_status FROM resend_mail_domains WHERE domain_id=?",
        rig.domainId,
      ),
    ).toEqual({
      sending_status: "pending",
      receiving_status: "pending",
    });
    expect(await store.mailIngress.readReceipt({ eventId: observed.eventId })).toEqual({
      eventId: observed.eventId,
      digest: observed.digest,
    });
    const noCapabilities = event({
      type: "domain.updated",
      domain: { ...pending, sending: null, receiving: null, workspaceSending: "ready" },
    });
    await store.mailIngress.ingest(noCapabilities);
    expect(
      await first(
        "SELECT sending_status,receiving_status FROM resend_mail_domains WHERE domain_id=?",
        rig.domainId,
      ),
    ).toEqual({ sending_status: "ready", receiving_status: "pending" });
    expect(await store.mailIngress.readReceipt({ eventId: noCapabilities.eventId })).not.toBeNull();
    expect(await store.mailIngress.readReceipt({ eventId: "evt_unknown" })).toBeNull();
    await store.mailIngress.ingest(observed);
    await expect(store.mailIngress.ingest({ ...observed, digest: sha("other") })).rejects.toThrow(
      "Resend event identity conflict",
    );
    await store.mailIngress.ingest(
      event({
        type: "domain.deleted",
        domain: { ...pending, sending: "ready" },
      }),
    );
    expect(
      await first("SELECT sending_status FROM resend_mail_domains WHERE domain_id=?", rig.domainId),
    ).toEqual({
      sending_status: "failed",
    });
    const unrelated = event({
      type: "domain.updated",
      domain: {
        ...pending,
        providerDomainId: "provider_foreign",
        domain: "foreign.example.net",
      },
    });
    await store.mailIngress.ingest(unrelated);
    expect(await store.mailIngress.readReceipt({ eventId: unrelated.eventId })).toBeNull();
  });

  it("completes a started send on delivery and suspends the reputation on a permanent bounce", async () => {
    const rig = await seedMailRig(control);
    await fundOrganization(control, rig.scope.organizationId, rig.now);
    const requestId = newUlid(),
      claim = {
        ...rig.scope,
        provider: "resend" as const,
        requestId,
        idempotencyKey: "send-1",
        requestSha256: sha("request"),
        recipientSha256: sha("recipient"),
        contentSha256: sha("content"),
        sender: {},
        requestedAt: rig.now,
        paidAt: rig.now,
      };
    expect(await store.mailSend.claim(claim)).toMatchObject({ outcome: "claimed" });
    expect(
      await store.mailSend.authorize({
        ...rig.scope,
        requestId,
        idempotencyKey: "send-1",
        now: rig.now,
      }),
    ).toBe(true);
    const delivery = {
      requestId,
      projectId: rig.scope.projectId,
      permanentBounce: false,
    };
    const delivered = event({
      providerMessageId: "msg_send_1",
      delivery,
      now: iso(1000),
      occurredAt: iso(500),
    });
    await store.mailIngress.ingest(delivered);
    // A stored event without its receipt (the receipt is the last statement of the batch) is verified, not duplicated.
    await control.core
      .prepare("DELETE FROM resend_event_receipts WHERE event_id=?")
      .bind(delivered.eventId)
      .run();
    await store.mailIngress.ingest(delivered);
    expect(
      await first("SELECT count(*) n FROM mail_send_events WHERE request_id=?", requestId),
    ).toEqual({ n: 1 });
    expect(
      await first(
        "SELECT state,provider_message_id FROM mail_send_requests WHERE request_id=?",
        requestId,
      ),
    ).toEqual({
      state: "accepted",
      provider_message_id: "msg_send_1",
    });
    expect(
      await first("SELECT outcome FROM mail_send_outcomes WHERE request_id=?", requestId),
    ).toEqual({
      outcome: "delivered",
    });
    await store.mailIngress.ingest(
      event({
        type: "email.bounced",
        providerMessageId: "msg_send_1",
        delivery: { ...delivery, permanentBounce: true },
        now: iso(2000),
        occurredAt: iso(1500),
      }),
    );
    expect(
      await first("SELECT outcome FROM mail_send_outcomes WHERE request_id=?", requestId),
    ).toEqual({
      outcome: "bounced",
    });
    expect(
      await first(
        "SELECT state,suspension_reason FROM mail_reputation_states WHERE organization_id=? AND project_id=?",
        rig.scope.organizationId,
        rig.scope.projectId,
      ),
    ).toEqual({ state: "suspended", suspension_reason: "bounce_rate" });
    expect(
      await first(
        "SELECT reputation_state FROM workspace_mail_domains WHERE domain_id=?",
        rig.domainId,
      ),
    ).toEqual({
      reputation_state: "suspended",
    });
    await store.mailIngress.ingest(
      event({
        type: "email.complained",
        providerMessageId: "msg_send_1",
        delivery: { ...delivery },
        now: iso(3000),
        occurredAt: iso(2500),
      }),
    );
    expect(
      await first("SELECT outcome FROM mail_send_outcomes WHERE request_id=?", requestId),
    ).toEqual({
      outcome: "complained",
    });
  });

  it("stores a received message once per provider id, ignores foreign recipients and bills it", async () => {
    const rig = await seedMailRig(control);
    await fundOrganization(control, rig.scope.organizationId, rig.now);
    const messageId = newUlid(),
      received = event({
        type: "email.received",
        providerMessageId: "recv_1",
        received: { recipientDomains: [rig.domain], receivedAt: iso(-1000), messageId },
      });
    await store.mailIngress.ingest(received);
    expect(
      await first(
        "SELECT state,domain_id FROM mail_received_messages WHERE message_id=?",
        messageId,
      ),
    ).toEqual({
      state: "pending",
      domain_id: rig.domainId,
    });
    const duplicate = event({
      type: "email.received",
      providerMessageId: "recv_1",
      received: { recipientDomains: [rig.domain], receivedAt: iso(-1000), messageId: newUlid() },
    });
    await store.mailIngress.ingest(duplicate);
    expect(await first("SELECT count(*) n FROM mail_received_messages")).toEqual({ n: 1 });
    const foreign = event({
      type: "email.received",
      providerMessageId: "recv_foreign",
      received: {
        recipientDomains: ["nobody.example.net"],
        receivedAt: iso(-1000),
        messageId: newUlid(),
      },
    });
    await store.mailIngress.ingest(foreign);
    expect(await store.mailIngress.readReceipt({ eventId: foreign.eventId })).toBeNull();
    expect(await store.mailDelivery.unbilled({})).toEqual([messageId]);
    await store.mailDelivery.bill({ messageId, now: iso() });
    expect(await store.mailDelivery.unbilled({})).toEqual([]);
    expect(
      await first("SELECT count(*) n FROM credit_log WHERE key=?", `mailrecv:${messageId}`),
    ).toEqual({
      n: 1,
    });
  });

  it("refuses a received message until the domain's sending records are verified, then stores it", async () => {
    const rig = await seedMailRig(control);
    await fundOrganization(control, rig.scope.organizationId, rig.now);
    await control.core
      .prepare(
        "UPDATE resend_mail_domains SET sending_status='pending',receiving_status='pending' WHERE domain_id=?",
      )
      .bind(rig.domainId)
      .run();
    const received = (providerMessageId: string, messageId: string) =>
      event({
        type: "email.received",
        providerMessageId,
        received: { recipientDomains: [rig.domain], receivedAt: iso(-1000), messageId },
      });
    await store.mailIngress.ingest(received("recv_unverified", newUlid()));
    expect(await first("SELECT count(*) n FROM mail_received_messages")).toEqual({ n: 0 });
    expect(await store.mailDelivery.unbilled({})).toEqual([]);
    await control.core
      .prepare("UPDATE resend_mail_domains SET sending_status='ready' WHERE domain_id=?")
      .bind(rig.domainId)
      .run();
    const messageId = newUlid();
    await store.mailIngress.ingest(received("recv_verified", messageId));
    expect(await store.mailDelivery.unbilled({})).toEqual([messageId]);
  });

  it("reports a lost reply of the receipt batch as an unknown outcome", async () => {
    const rig = await seedMailRig(control),
      lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }),
      observed = event({
        type: "domain.updated",
        domain: {
          providerDomainId: rig.providerDomainId,
          domain: rig.domain,
          valid: true,
          sending: "ready",
          receiving: "ready",
          workspaceSending: "ready",
        },
      });
    await expect(lossy.mailIngress.ingest(observed)).rejects.toThrow(
      "mail.ingestResend: store_outcome_unknown",
    );
    expect(await store.mailIngress.readReceipt({ eventId: observed.eventId })).not.toBeNull();
  });
});
