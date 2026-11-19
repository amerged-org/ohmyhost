import { afterAll, beforeAll, expect, it } from "vitest";
import {
  classifyCustomerMailDomain,
  validateMailSenderSettings,
  createEnvironmentSecretCipher,
  parseUlid,
} from "@ohmyhost/platform";
import { createD1ResendSendPersistence } from "../../../mail-gateway/src/d1-resend-send-persistence.js";
import { createResendMailSender } from "../../../mail-gateway/src/resend-send.js";
import { MAIL_FIXTURE_CIPHER, hash } from "./mail-fixture.js";
import { fundOrganization, publishMailPricing } from "../support/mail-events-fixture.js";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { senderOf } from "../../src/catalog/mail/auth.js";
import {
  receivedIngressReads,
  receivedIngressStep,
  type ReceivingDomainFacts,
} from "../../src/catalog/mail/received-ingress-step.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  cfFixture,
  declareIdentity,
  hex,
  seedWorkspaceDomain,
} from "../support/cf-mail-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control.dispose());

it("classifies reserved platform names by canonical hostname while preserving customer domains and external Reply-To", () => {
  for (const domain of [
    "ohmyho.st",
    "OHMYHO.ST.",
    "mail.ohmyho.st",
    "omh.st",
    "x.check.omh.st",
    "dev.poc.aixyte.com",
    "DEEP.DEV.POC.AIXYTE.COM.",
  ])
    expect(() => classifyCustomerMailDomain(domain), domain).toThrow(
      "A customer mail domain is required",
    );
  for (const domain of [
    "poc.aixyte.com",
    "notohmyho.st",
    "omh.st.example.com",
    "amerged.com",
    "mail.amerged.com",
  ])
    expect(classifyCustomerMailDomain(domain).hostname).toBe(domain);
  expect(
    validateMailSenderSettings({
      domain: "amerged.com",
      senderAddresses: ["hello@amerged.com"],
      defaultFrom: "hello@amerged.com",
      defaultReplyTo: "someone@ohmyho.st",
    }).defaultReplyTo,
  ).toBe("someone@ohmyho.st");
});

it("rejects reserved workspace, legacy and application identity creation before storing any effects", async () => {
  const store = createControlStore(control.bindings),
    f = await cfFixture(control),
    now = new Date().toISOString();
  const shared = {
    organizationId: f.organizationId,
    idempotencyKey: "reserved-test",
    principalId: f.principalId,
    requestSha256: "a".repeat(64),
    now,
    domainId: newUlid(),
    domain: "mail.ohmyho.st",
  };
  await expect(store.sharedMail.createDomain(shared)).rejects.toThrow(
    "A customer mail domain is required",
  );
  await expect(
    store.mailManagement.configure({
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.project.prodEnvironmentId,
      domainId: newUlid(),
      domain: "mail.omh.st",
      sending: true,
      receiving: false,
      webhookUrl: null,
      now,
    }),
  ).rejects.toThrow("A customer mail domain is required");
  await expect(
    declareIdentity(store, f, { hostname: "native-auth-dev.canary.ohmyho.st" }),
  ).rejects.toThrow("A customer mail domain is required");
  expect(
    await control.core
      .prepare("SELECT COUNT(*) n FROM workspace_mail_domains WHERE organization_id=?")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await control.core
      .prepare("SELECT COUNT(*) n FROM project_application_domain_identities WHERE project_id=?")
      .bind(f.projectId)
      .first(),
  ).toEqual({ n: 0 });
  // Simulate a resource accepted by the old code: consent and DNS provisioning must be fenced,
  // while reading its state remains available for explicit recovery.
  const pending = await seedWorkspaceDomain(f, {
    domain: "mail.native-auth-dev.canary.ohmyho.st",
    provisioned: true,
  });
  for (const action of [
    "claimCreation",
    "recordPreflight",
    "claimKey",
    "recoverKey",
    "claimVerification",
  ] as const) {
    await expect(
      store.mailWorkspace.change({
        organizationId: f.organizationId,
        domainId: pending.domainId,
        change: { action },
        now,
      }),
    ).rejects.toThrow("mail_scope_unavailable");
  }
  // An older legacy row likewise cannot acquire a new provider mutation permit.
  const legacy = await cfFixture(control),
    legacyId = newUlid();
  await control.core
    .prepare(
      "INSERT INTO resend_mail_domains(organization_id,domain_id,project_id,environment_id,domain,sending,receiving,receiving_suspended,configured_at) VALUES(?,?,?,?,?,1,0,0,?)",
    )
    .bind(
      legacy.organizationId,
      legacyId,
      legacy.projectId,
      legacy.project.prodEnvironmentId,
      "old.omh.st",
      storedTimestamp(now),
    )
    .run();
  for (const action of [
    "claimCreation",
    "recordPreflight",
    "claimKey",
    "claimVerification",
  ] as const) {
    await expect(
      store.mailManagement.change({ change: { action, domainId: legacyId }, now }),
    ).rejects.toThrow("mail_scope_unavailable");
  }
  expect(
    await store.mailManagement.change({
      change: { action: "recordFound", domainId: legacyId, providerDomainId: "found_existing" },
    }),
  ).toBe(true);
  // Old inbound records may still be inspected, but no new inbound handoff or webhook attempt is admitted.
  const storedNow = storedTimestamp(now),
    messageId = newUlid();
  await control.core
    .prepare(
      "UPDATE resend_mail_domains SET receiving=1,receiving_status='ready',webhook_url='https://example.com/mail',webhook_verified_at=? WHERE domain_id=?",
    )
    .bind(storedNow, legacyId)
    .run();
  const ingress = {
    messageId,
    providerMessageId: "historical_reserved_inbound",
    recipientDomains: ["old.omh.st"],
    receivedAt: storedNow,
    observedAt: storedNow,
  };
  const reads = await control.core.batch(receivedIngressReads(control.core, ingress));
  expect(
    receivedIngressStep(
      control.core,
      ingress,
      reads[0]?.results as unknown as ReceivingDomainFacts[],
      undefined,
    ).concerned,
  ).toBe(false);
  await control.core
    .prepare(
      "INSERT INTO mail_received_messages(message_id,provider_message_id,domain_id,organization_id,project_id,environment_id,received_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      messageId,
      ingress.providerMessageId,
      legacyId,
      legacy.organizationId,
      legacy.projectId,
      legacy.project.prodEnvironmentId,
      storedNow,
      storedTimestamp(new Date(Date.parse(now) + 72 * 3600000).toISOString()),
      storedNow,
    )
    .run();
  const received = {
    organizationId: legacy.organizationId,
    projectId: legacy.projectId,
    environmentId: legacy.project.prodEnvironmentId,
    messageId,
    now,
  };
  expect(await store.mailDelivery.claim(received)).toBeNull();
  expect(
    (await store.mailDelivery.due({ now })).some((entry) => entry.messageId === messageId),
  ).toBe(false);
  expect(await store.mailDelivery.read(received)).toMatchObject({
    domain: "old.omh.st",
    message_id: messageId,
  });
  expect(
    await store.mailWorkspace.readResource({
      organizationId: f.organizationId,
      domainId: pending.domainId,
    }),
  ).toMatchObject({ domain: pending.domain });
  const issue = {
    organizationId: f.organizationId,
    purpose: "workspace_mail" as const,
    resourceId: pending.domainId,
    principalId: f.principalId,
    delegation: null,
    authorizationId: newUlid(),
    resourceRevision: 1,
    zoneName: "ohmyho.st",
    idempotencyKeySha256: hex(1),
    requestSha256: hex(2),
    stateSha256: hex(3),
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + 600000).toISOString(),
  };
  await expect(store.cfScopedDns.issue(issue)).rejects.toThrow(
    "A customer mail domain is required",
  );
  const retiring = await seedWorkspaceDomain(f, {
    domain: `retiring-${newUlid().toLowerCase()}.omh.st`,
    status: "retiring",
  });
  await expect(
    store.cfScopedDns.issue({
      ...issue,
      resourceId: retiring.domainId,
      zoneName: "omh.st",
      authorizationId: newUlid(),
      idempotencyKeySha256: hex(4),
    }),
  ).rejects.toThrow("A customer mail domain is required");
  await expect(
    store.cfMailDns.workspace({ organizationId: f.organizationId, mailDomainId: pending.domainId }),
  ).rejects.toThrow("A customer mail domain is required");
  expect(
    await store.sharedMail.readDomain({
      organizationId: f.organizationId,
      domainId: pending.domainId,
    }),
  ).toMatchObject({ domain: pending.domain });
  expect(
    await control.core
      .prepare("SELECT COUNT(*) n FROM scoped_customer_dns_authorizations WHERE organization_id=?")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 0 });
  // Retained pre-policy consent must not become a fresh DNS use after the code changes.
  const retiringIssue = {
    ...issue,
    resourceId: retiring.domainId,
    zoneName: "omh.st",
    authorizationId: newUlid(),
    idempotencyKeySha256: hex(5),
  };
  for (const prior of [issue, retiringIssue]) {
    await control.core
      .prepare(
        "INSERT INTO scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision,principal_id,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,unhex(?),unhex(?),unhex(?),?,?)",
      )
      .bind(
        prior.authorizationId,
        prior.organizationId,
        prior.purpose,
        prior.resourceId,
        prior.resourceRevision,
        prior.principalId,
        prior.zoneName,
        prior.stateSha256,
        prior.idempotencyKeySha256,
        prior.requestSha256,
        storedTimestamp(prior.issuedAt),
        storedTimestamp(prior.expiresAt),
      )
      .run();
    await expect(
      store.cfScopedDns.consume({
        authorizationId: prior.authorizationId,
        stateSha256: prior.stateSha256,
        principalId: prior.principalId,
        now,
      }),
    ).rejects.toThrow("A customer mail domain is required");
    expect(
      await store.cfScopedDns.readAuthorization({ authorizationId: prior.authorizationId }),
    ).toMatchObject({ authorizationId: prior.authorizationId });
    expect(
      await control.core
        .prepare(
          "SELECT consumed_at FROM scoped_customer_dns_authorizations WHERE authorization_id=?",
        )
        .bind(prior.authorizationId)
        .first(),
    ).toEqual({ consumed_at: null });
  }
  // Model an older completed callback as retained history, then exercise the current use gate.
  await control.core
    .prepare("UPDATE scoped_customer_dns_authorizations SET consumed_at=? WHERE authorization_id=?")
    .bind(storedNow, issue.authorizationId)
    .run();
  await store.cfScopedDns.saveGrant({
    ...issue,
    accessCiphertext: "ab".repeat(24),
    accessNonce: "cd".repeat(12),
    refreshCiphertext: "ef".repeat(24),
    refreshNonce: "12".repeat(12),
    keyVersion: 1,
    accessExpiresAt: new Date(Date.parse(now) + 3600000).toISOString(),
    zoneId: "1".repeat(32),
    accountId: "2".repeat(32),
    connectedAt: now,
  });
  const use = {
    organizationId: f.organizationId,
    purpose: "workspace_mail" as const,
    resourceId: pending.domainId,
    leaseToken: crypto.randomUUID(),
  };
  await expect(store.cfScopedDns.claimUse({ ...use, now, cleanup: false })).rejects.toThrow(
    "A customer mail domain is required",
  );
  expect(
    await control.core
      .prepare("SELECT COUNT(*) n FROM scoped_dns_provider_uses WHERE organization_id=?")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 0 });
  expect(await store.cfScopedDns.claimUse({ ...use, now, cleanup: true })).toMatchObject({
    leaseToken: use.leaseToken,
  });
  await store.cfScopedDns.releaseUse(use);
  expect(await declareIdentity(store, f, { hostname: "www.example.com" })).toMatchObject({
    state: "pending",
  });
});

it("refuses existing reserved senders and uncertain retries before provider I/O", async () => {
  const base = {
    domain_id: "domain",
    domain: "mail.ohmyho.st",
    ciphertext: "00",
    nonce: "00",
    valueSha256: "00",
    keyVersion: 1,
    reputationState: "active",
    registrableDomain: "ohmyho.st",
    applicationHostname: "app.ohmyho.st",
  };
  for (const legacy of [0, 1])
    expect(() => senderOf({ ...base, legacy })).toThrow("mail_scope_unavailable");
  const f = await cfFixture(control),
    now = new Date().toISOString(),
    storedNow = storedTimestamp(now),
    domainId = newUlid(),
    domain = `retained-${domainId.toLowerCase()}.omh.st`,
    scope = {
      organizationId: parseUlid(f.organizationId),
      projectId: parseUlid(f.projectId),
      environmentId: parseUlid(f.project.prodEnvironmentId),
    };
  await publishMailPricing(control);
  await fundOrganization(control, f.organizationId, now);
  const sealed = await createEnvironmentSecretCipher({
    keyBase64: MAIL_FIXTURE_CIPHER,
    keyVersion: 1,
    crypto: globalThis.crypto,
  }).encrypt({ ...scope, name: "RESEND_DOMAIN_SEND_KEY", value: "re_retained_reserved_key" });
  await control.core
    .prepare(
      "INSERT INTO resend_mail_domains(organization_id,domain_id,project_id,environment_id,domain,provider_domain_id,sending_key_id,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending,receiving,receiving_suspended,sending_status,configured_at) VALUES(?,?,?,?,?,'retained_provider','retained_key',?,?,?,1,1,0,0,'ready',?)",
    )
    .bind(
      f.organizationId,
      domainId,
      f.projectId,
      scope.environmentId,
      domain,
      sealed.ciphertext,
      sealed.nonce,
      sealed.valueSha256,
      storedNow,
    )
    .run();
  const store = createControlStore(control.bindings),
    originalId = newUlid(),
    request = {
      projectId: f.projectId,
      idempotencyKey: "retained-reserved",
      to: "recipient@example.net",
      subject: "subject",
      text: "body",
    },
    inputHash = hash(
      JSON.stringify({
        from: null,
        replyTo: null,
        to: request.to,
        subject: request.subject,
        text: request.text,
        html: null,
      }),
    );
  await control.core
    .prepare(
      "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,request_input_sha256,state,requested_at,updated_at,provider_started_at,mail_provider,mail_domain_id,mail_binding_revision,effective_from,effective_reply_to) VALUES(?,?,?,?,unhex(?),unhex(?),unhex(?),unhex(?),'uncertain',?,?,?,'resend',?,1,?,NULL)",
    )
    .bind(
      originalId,
      f.organizationId,
      f.projectId,
      hash(`${scope.environmentId}:${request.idempotencyKey}`),
      inputHash,
      hash(request.to),
      hash(JSON.stringify({ subject: request.subject, text: request.text, html: null })),
      inputHash,
      storedNow,
      storedNow,
      storedNow,
      domainId,
      `no-reply@${domain}`,
    )
    .run();
  await expect(
    store.mailSend.claim({
      ...scope,
      provider: "resend",
      requestId: newUlid(),
      idempotencyKey: "reserved-new-legacy",
      requestSha256: inputHash,
      recipientSha256: hash(request.to),
      contentSha256: hash(
        JSON.stringify({ subject: request.subject, text: request.text, html: null }),
      ),
      paidAt: now,
      requestedAt: now,
    }),
  ).rejects.toMatchObject({ code: "mail_send_scope_unavailable" });
  const persistence = await createD1ResendSendPersistence(store.mailSend);
  let providerCalls = 0,
    custodyReads = 0;
  const sender = createResendMailSender({
    persistence: {
      ...persistence,
      readKey: (supplier) => {
        custodyReads++;
        return persistence.readKey(supplier);
      },
    },
    sendingKeyEncryptionKey: MAIL_FIXTURE_CIPHER,
    ids: { next: () => parseUlid(newUlid()) },
    now: () => new Date(now),
    fetch: async () => {
      providerCalls++;
      throw new Error("reserved sender reached provider");
    },
  });
  // An already-authorized private realm still traverses actual Core replay/key custody before Resend.
  await expect(sender.send(request, { ...scope, domain })).rejects.toThrow(
    "mail_scope_unavailable",
  );
  expect(custodyReads).toBe(1);
  expect(providerCalls).toBe(0);
  expect(
    await control.core
      .prepare("SELECT state,provider_message_id FROM mail_send_requests WHERE request_id=?")
      .bind(originalId)
      .first(),
  ).toEqual({ state: "uncertain", provider_message_id: null });
  expect(
    await control.core
      .prepare("SELECT COUNT(*) n FROM mail_send_requests WHERE organization_id=?")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await control.core
      .prepare("SELECT COUNT(*) n FROM credit_log WHERE organization_id=? AND key LIKE 'mail:%'")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 0 });
});
