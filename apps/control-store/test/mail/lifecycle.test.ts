import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createControlStore, type ControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { fundOrganization, publishMailPricing } from "../support/mail-events-fixture.js";
import {
  mailScopeOf,
  rowOf,
  seedLegacyMailDomain,
  sha,
  stored,
} from "../support/mail-lifecycle-fixture.js";
import { losingWriteResponses, seedProject } from "../support/platform-fixtures.js";

let control: TestControl, store: ControlStore;
const now = new Date().toISOString();
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  await publishMailPricing(control);
});
afterAll(async () => control.dispose());

const domainRow = (domainId: string) =>
  rowOf(control, "SELECT * FROM resend_mail_domains WHERE domain_id=?", domainId);

describe("legacy mail resource", () => {
  it("is configured, driven through the provider phases and read back through every view", async () => {
    const project = await seedProject(control),
      scope = mailScopeOf(project),
      { organizationId } = project,
      domainId = newUlid(),
      domain = `legacy-${domainId.slice(-10).toLowerCase()}.example.com`,
      configure = (overrides: Record<string, unknown> = {}) =>
        store.mailManagement.configure({
          ...scope,
          domainId,
          domain,
          sending: true,
          receiving: false,
          webhookUrl: null,
          now,
          ...overrides,
        });

    // an organization without Paid access cannot configure, and requirePaid says why
    await expect(store.mailManagement.requirePaid({ organizationId, now })).rejects.toThrow(
      "paid_plan_required",
    );
    await expect(configure()).rejects.toThrow("paid_plan_required");
    await fundOrganization(control, organizationId, now);
    await store.mailManagement.requirePaid({ organizationId, now });

    // configure writes the original resource; the mirror trigger adds the workspace sender and legacy binding
    expect(await configure()).toMatchObject({
      domain_id: domainId,
      domain,
      sending: 1,
      receiving: 0,
    });
    expect(
      await rowOf(
        control,
        "SELECT w.status,w.legacy_domain_id,b.legacy,b.state FROM workspace_mail_domains w JOIN project_mail_domain_bindings b ON b.mail_domain_id=w.domain_id WHERE w.domain_id=?",
        domainId,
      ),
    ).toEqual({ status: "active", legacy_domain_id: domainId, legacy: 1, state: "active" });
    expect(
      await store.mailManagement.readDomain({ organizationId, projectId: scope.projectId }),
    ).toMatchObject({ domain_id: domainId, domain, sending: 1 });

    // provider phases: each claim is taken once, then answers false
    const change = (action: string, extra: Record<string, unknown> = {}, clocked = true) =>
      store.mailManagement.change({
        change: { action, domainId, ...extra },
        ...(clocked ? { now } : {}),
      });
    expect(await change("claimCreation")).toBe(true);
    expect(await change("claimCreation")).toBe(false);
    expect(await change("recordPreflight")).toBe(true);
    const providerId = `provider_${domainId}`;
    expect(
      await store.mailManagement.change({
        change: {
          action: "saveObservation",
          value: {
            domainId,
            providerId,
            sendingStatus: "ready",
            receivingStatus: "pending",
            records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1" }],
          },
        },
        now,
      }),
    ).toBe(true);
    expect(await change("claimKey")).toBe(true);
    expect(
      await store.mailManagement.change({
        change: {
          action: "saveKey",
          value: {
            domainId,
            providerDomainId: providerId,
            keyId: `key_${domainId}`,
            ciphertext: "ab".repeat(48),
            nonce: "cd".repeat(12),
            valueSha256: "ef".repeat(32),
            keyVersion: 1,
          },
        },
      }),
    ).toBe(true);
    expect(await change("claimVerification")).toBe(true);
    expect(await domainRow(domainId)).toMatchObject({
      provider_domain_id: providerId,
      sending_status: "ready",
      sending_key_id: `key_${domainId}`,
      provider_claimed_at: stored(now),
      verify_requested_at: stored(now),
    });

    // configure again is the original upsert: same row, receiving switched on, key custody returned as hex
    expect(
      await configure({
        domainId: newUlid(),
        receiving: true,
        webhookUrl: "https://receiver.example.com/mail",
      }),
    ).toMatchObject({
      domain_id: domainId,
      receiving: 1,
      webhook_url: "https://receiver.example.com/mail",
      sending_key_ciphertext: "ab".repeat(48),
      sending_key_nonce: "cd".repeat(12),
      sending_key_sha256: "ef".repeat(32),
    });
    await change("disableReceiving", {}, false);
    const url = "https://receiver.example.com/hook";
    expect(await change("prepareWebhook", { url }, false)).toBe(true);
    expect(await change("verifyWebhook", { url })).toBe(true);
    expect(await domainRow(domainId)).toMatchObject({
      receiving: 1,
      receiving_status: "pending",
      webhook_url: url,
    });
    await expect(change("verifyWebhook", { url: "https://other.example.com" })).rejects.toThrow(
      "mail_webhook_changed",
    );

    // The signing generation advances with each new URL and each rotation; a same-URL replay keeps it, and a rotation
    // ends the verification so the receiver must confirm the new secret.
    const generationOf = async () => (await domainRow(domainId))?.["webhook_secret_generation"];
    const generation = await generationOf();
    expect(await change("prepareWebhook", { url }, false)).toBe(true);
    expect(await generationOf()).toBe(generation);
    expect(
      await change("prepareWebhook", { url: "https://receiver.example.com/next" }, false),
    ).toBe(true);
    expect(await generationOf()).toBe(Number(generation) + 1);
    expect(await change("rotateWebhookSecret", {}, false)).toBe(true);
    expect(await generationOf()).toBe(Number(generation) + 2);
    expect(await domainRow(domainId)).toMatchObject({ receiving: 0, webhook_verified_at: null });
    expect(await change("prepareWebhook", { url }, false)).toBe(true);
    expect(await change("verifyWebhook", { url })).toBe(true);

    // receiving admission reads Paid, grace, budget and the activated price; it changes nothing
    const admit = () => store.mailManagement.admitReceiving({ ...scope, now });
    await admit();
    await admit();
    await control.core
      .prepare("UPDATE credit_account SET paid_until=NULL WHERE organization_id=?")
      .bind(organizationId)
      .run();
    await expect(admit()).rejects.toThrow("paid_plan_required");
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until='2099-01-01T00:00:00.000000Z' WHERE organization_id=?",
      )
      .bind(organizationId)
      .run();

    // the read views
    expect(await store.mailManagement.readCustody({ organizationId, domainId })).toMatchObject({
      domain,
      provider_domain_id: providerId,
    });
    expect(
      await store.mailManagement.readLegacy({ organizationId, domainId, status: "active" }),
    ).toMatchObject({ domain_id: domainId });
    expect(
      await store.mailManagement.readLegacy({ organizationId, domainId, status: "retiring" }),
    ).toBeNull();
    expect(await store.mailManagement.readWorkspaceStatus({ domainId })).toBe("active");
    expect(await store.mailManagement.readWorkspaceStatus({ domainId: newUlid() })).toBeNull();
    const owner = { organizationId, domainId, projectId: scope.projectId };
    expect(
      await store.mailManagement.isReceivingOwner({ ...owner, environmentId: scope.environmentId }),
    ).toBe(true);
    expect(
      await store.mailManagement.isReceivingOwner({
        ...owner,
        environmentId: project.devEnvironmentId,
      }),
    ).toBe(false);
    expect(await store.mailManagement.hasLiveName({ domain })).toBe(true);
    expect(await store.mailManagement.hasLiveName({ domain: "absent.example.com" })).toBe(false);
  });

  it("retires in one command, and retires a workspace-retiring legacy resource", async () => {
    // one-command retirement: the command receipt names the retired resource, a replay answers it again
    const first = await seedProject(control),
      scope = mailScopeOf(first),
      { domainId } = await seedLegacyMailDomain(control, first),
      key = "retire-1";
    await expect(
      store.mailManagement.retire({ ...scope, idempotencyKey: key, now }),
    ).rejects.toThrow("mail_operation_pending");
    await store.mailCommands.begin({ ...scope, idempotencyKey: key, requestSha256: sha("a"), now });
    const retired = await store.mailManagement.retire({ ...scope, idempotencyKey: key, now });
    expect(retired).toMatchObject({ domain_id: domainId, sending: 0, deleted_at: stored(now) });
    expect(await store.mailManagement.retire({ ...scope, idempotencyKey: key, now })).toEqual(
      retired,
    );
    // a new key finds the retired resource whose cleanup was never completed and binds to it
    await store.mailCommands.begin({
      ...scope,
      idempotencyKey: "retire-2",
      requestSha256: sha("b"),
      now,
    });
    expect(
      await store.mailManagement.retire({ ...scope, idempotencyKey: "retire-2", now }),
    ).toMatchObject({ domain_id: domainId, deleted_at: stored(now) });
    expect(
      await rowOf(
        control,
        "SELECT w.status,b.state,c.domain_id FROM workspace_mail_domains w JOIN project_mail_domain_bindings b ON b.mail_domain_id=w.domain_id JOIN resend_mail_commands c ON c.project_id=b.project_id WHERE w.domain_id=?",
        domainId,
      ),
    ).toEqual({ status: "retiring", state: "detached", domain_id: domainId });
    expect(
      await store.mailManagement.change({ change: { action: "finishRetirement", domainId }, now }),
    ).toBe(true);
    expect(
      await rowOf(
        control,
        "SELECT status,retired_at FROM workspace_mail_domains WHERE domain_id=?",
        domainId,
      ),
    ).toEqual({ status: "retired", retired_at: stored(now) });

    // workspace-led retirement of a legacy resource: detach, begin, release the legacy resource, finish
    const second = await seedProject(control),
      legacy = await seedLegacyMailDomain(control, second),
      organizationId = second.organizationId;
    await control.core
      .prepare(
        "UPDATE project_mail_domain_bindings SET state='detached',sending=0 WHERE project_id=?",
      )
      .bind(second.projectId)
      .run();
    await store.mailWorkspace.beginRetirement({
      organizationId,
      domainId: legacy.domainId,
      expectedRevision: 1,
      now,
    });
    // the answer carries the cleanup facts as they were before the release
    expect(
      await store.mailManagement.retireLegacy({ organizationId, domainId: legacy.domainId, now }),
    ).toMatchObject({ domain_id: legacy.domainId, deleted_at: null });
    expect(
      await rowOf(
        control,
        "SELECT deleted_at FROM resend_mail_domains WHERE domain_id=?",
        legacy.domainId,
      ),
    ).toEqual({ deleted_at: stored(now) });
    await store.mailWorkspace.finishRetirement({ organizationId, domainId: legacy.domainId, now });
    expect(
      await rowOf(
        control,
        "SELECT status,revision FROM workspace_mail_domains WHERE domain_id=?",
        legacy.domainId,
      ),
    ).toEqual({ status: "retired", revision: 2 });
  });
});

describe("workspace mail sender", () => {
  it("is driven through the provider phases, its receipts and its retirement", async () => {
    const project = await seedProject(control),
      { organizationId } = project,
      domainId = newUlid(),
      domain = `shared-${domainId.slice(-10).toLowerCase()}.example.com`,
      request = (key: string) => ({
        organizationId,
        idempotencyKey: key,
        principalId: "user:fixture",
        requestSha256: sha("a"),
        now,
      }),
      receipt = (operation: string, key: string, requestSha256 = sha("a")) => ({
        organizationId,
        domainId,
        idempotencyKey: key,
        principalId: "user:fixture",
        operation,
        requestSha256,
      }),
      change = (action: string, extra: Record<string, unknown> = {}, clocked = true) =>
        store.mailWorkspace.change({
          organizationId,
          domainId,
          change: { action, ...extra },
          ...(clocked ? { now } : {}),
        });
    await fundOrganization(control, organizationId, now);
    await store.sharedMail.createDomain({ ...request("create-1"), domainId, domain });

    // the accepted create receipt is readable by its exact request only
    expect(await store.mailCommands.readWorkspace(receipt("create", "create-1"))).toBeNull();
    await expect(
      store.mailCommands.readWorkspace(receipt("create", "create-1", sha("b"))),
    ).rejects.toThrow("mail_scope_unavailable");

    // provider phases on the workspace sender
    expect(await change("claimCreation")).toBe(true);
    expect(await change("claimCreation")).toBe(false);
    expect(await change("recordPreflight")).toBe(true);
    expect(
      await change("observe", {
        providerDomainId: `provider_${domainId}`,
        records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1" }],
        sendingStatus: "ready",
      }),
    ).toBe(true);
    expect(await change("claimKey")).toBe(true);
    expect(
      await change(
        "saveKey",
        {
          keyId: `key_${domainId}`,
          ciphertext: "ab".repeat(34),
          nonce: "cd".repeat(12),
          valueSha256: "ef".repeat(32),
          keyVersion: 1,
        },
        false,
      ),
    ).toBe(true);
    const leaseToken = newUlid();
    expect(await change("claimDns", { leaseToken })).toBe(true);
    expect(await change("claimDns", { leaseToken: newUlid() })).toBe(false);
    expect(await change("releaseDns", { leaseToken }, false)).toBe(true);
    expect(await change("claimVerification")).toBe(true);
    expect(await store.mailWorkspace.readResource({ organizationId, domainId })).toMatchObject({
      provider_domain_id: `provider_${domainId}`,
      sending_key_id: `key_${domainId}`,
    });
    expect(await store.mailWorkspace.readView({ organizationId, domainId })).toMatchObject({
      sending: "ready",
    });
    // a sender that does not exist answers the phase without writing
    expect(
      await store.mailWorkspace.change({
        organizationId,
        domainId: newUlid(),
        change: { action: "claimKey" },
        now,
      }),
    ).toBe(false);

    // retirement: the retire receipt is claimed once, the sender retires only at its revision
    await store.sharedMail.beginRetire({ ...request("retire-1"), domainId, expectedRevision: 1 });
    const claim = () =>
      store.mailCommands.claimWorkspaceRetirement({
        organizationId,
        idempotencyKey: "retire-1",
        now,
      });
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    await expect(
      store.mailWorkspace.beginRetirement({ organizationId, domainId, expectedRevision: 9, now }),
    ).rejects.toThrow("mail_resource_revision_conflict");
    expect(
      await store.mailWorkspace.beginRetirement({
        organizationId,
        domainId,
        expectedRevision: 1,
        now,
      }),
    ).toMatchObject({ domain_id: domainId, status: "active" });
    expect(
      await rowOf(control, "SELECT status FROM workspace_mail_domains WHERE domain_id=?", domainId),
    ).toEqual({
      status: "retiring",
    });
    await store.mailWorkspace.finishRetirement({ organizationId, domainId, now });
    expect(
      await rowOf(
        control,
        "SELECT status,revision,sending_status FROM workspace_mail_domains WHERE domain_id=?",
        domainId,
      ),
    ).toEqual({ status: "retired", revision: 2, sending_status: "disabled" });
  });
});

describe("mail management command receipts", () => {
  it("begins, replays, resumes after the lease, completes and keeps a lost reply unknown", async () => {
    const project = await seedProject(control),
      later = new Date(Date.parse(now) + 180_000).toISOString(),
      key = (idempotencyKey = "cmd-1") => ({ ...mailScopeOf(project), idempotencyKey }),
      begin = (extra: Record<string, unknown> = {}) =>
        store.mailCommands.begin({ ...key(), requestSha256: sha("a"), now, ...extra }),
      resume = () => store.mailCommands.resume({ ...key(), now: later });

    expect(await store.mailCommands.read(key())).toBeNull();
    expect(await begin()).toEqual({ created: true, response: null });
    expect(await begin()).toEqual({ created: false, response: null });
    await expect(begin({ requestSha256: sha("b") })).rejects.toThrow("idempotency_key_reused");
    // the 120 s lease keeps a second runner out until it expires
    expect(await store.mailCommands.resume({ ...key(), now })).toBe(false);
    expect(await resume()).toBe(true);
    expect(await resume()).toBe(false);

    // the provider result is stored once, never with a webhook signing secret
    const complete = (response: Record<string, unknown>) =>
      store.mailCommands.complete({ ...key(), response, now });
    await expect(complete({ signing_secret: "whsec_x" })).rejects.toThrow("Invalid mail input");
    await complete({ status: "ok" });
    expect(await store.mailCommands.read(key())).toEqual({
      requestSha256: sha("a"),
      response: { status: "ok" },
    });
    expect(await begin()).toEqual({ created: false, response: { status: "ok" } });
    expect(await resume()).toBe(false);

    // a lost reply is never replayed blindly: the caller learns the outcome is unknown, the row is committed
    const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    await expect(
      lossy.mailCommands.begin({ ...key("cmd-lost"), requestSha256: sha("a"), now }),
    ).rejects.toThrow("store_outcome_unknown");
    expect(await store.mailCommands.read(key("cmd-lost"))).toEqual({
      requestSha256: sha("a"),
      response: null,
    });
  });
});
