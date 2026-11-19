import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { configureFactsSql } from "../../src/catalog/mail/management.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { cfFixture, seedWorkspaceDomain, type CfFixture } from "../support/cf-mail-fixture.js";
import { fundOrganization } from "../support/mail-events-fixture.js";
import { seedProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const sha = (character: string) => character.repeat(64);
const DAY = 24 * 60 * 60 * 1000;
/** A request time `days` from now, in the ISO form the mail commands accept. */
const isoAt = (days: number) => new Date(Date.now() + days * DAY).toISOString();
/** A stored instant `days` from now. */
const storedAt = (days: number) => storedTimestamp(isoAt(days));

/** A sender row of the owner with an explicit configured time and provider state; sender rows are immutable. */
async function seedSender(owner: CfFixture, domain: string, configuredAt: string, sending: string) {
  const domainId = newUlid();
  await owner.db
    .prepare(
      `INSERT INTO workspace_mail_domains(domain_id, organization_id, domain, registrable_domain, custody_organization_id, custody_project_id, custody_environment_id, status, sending_status, records, dns_receipts, configured_at)
       VALUES (?1, ?2, ?3, 'example.com', ?2, ?4, ?5, 'active', ?6, '[]', '{}', ?7)`,
    )
    .bind(
      domainId,
      owner.organizationId,
      domain,
      owner.projectId,
      owner.project.prodEnvironmentId,
      sending,
      configuredAt,
    )
    .run();
  return domainId;
}

describe("workspace sender names are exclusive only once provider verified", () => {
  it("frees an unverified reservation after seven days, while a fresh one still holds the name", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      now = new Date().toISOString(),
      owner = await seedProject(control),
      rival = await seedProject(control),
      latecomer = await seedProject(control),
      freshId = newUlid(),
      agedId = newUlid(),
      fresh = `fresh-${freshId.slice(-10).toLowerCase()}.example.com`,
      aged = `aged-${agedId.slice(-10).toLowerCase()}.example.com`;
    for (const organizationId of [
      owner.organizationId,
      rival.organizationId,
      latecomer.organizationId,
    ])
      await fundOrganization(control, organizationId, now);
    await db
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
      )
      .bind(storedTimestamp(now))
      .run();
    const create = (
      organizationId: string,
      id: string,
      domain: string,
      key: string,
      when: string,
    ) =>
      store.sharedMail.createDomain({
        organizationId,
        idempotencyKey: key,
        principalId: "user:fixture",
        requestSha256: sha("a"),
        now: when,
        domainId: id,
        domain,
      });

    // A fresh, unverified reservation holds the name against another organization.
    await create(owner.organizationId, freshId, fresh, "owner-fresh", now);
    await expect(
      create(rival.organizationId, newUlid(), fresh, "rival-fresh", now),
    ).rejects.toThrow("mail_domain_conflict");

    // The owner's reservation of the other name was requested eight days ago: it no longer holds the name.
    await create(owner.organizationId, agedId, aged, "owner-aged", isoAt(-8));
    const rivalId = newUlid();
    await expect(create(rival.organizationId, rivalId, aged, "rival-aged", now)).resolves.toEqual({
      domainId: rivalId,
      response: null,
    });

    // Once verified, the name is exclusive: no other organization can register it, and the rival's unverified sender
    // can not become provider verified while the owner's stands.
    await db
      .prepare("UPDATE workspace_mail_domains SET sending_status='ready' WHERE domain_id=?1")
      .bind(agedId)
      .run();
    await expect(
      create(latecomer.organizationId, newUlid(), aged, "latecomer", now),
    ).rejects.toThrow("mail_domain_conflict");
    await expect(
      db
        .prepare("UPDATE workspace_mail_domains SET sending_status='ready' WHERE domain_id=?1")
        .bind(rivalId)
        .run(),
    ).rejects.toThrow();
  });
});

describe("the legacy configure fact `occupied` follows the same rule", () => {
  it("counts a verified or fresh sender of another organization, never an aged unverified one", async () => {
    const owner = await cfFixture(control);
    const rival = await cfFixture(control);
    const facts = async (domain: string) => {
      const row = await rival.db
        .prepare(configureFactsSql())
        .bind(
          rival.organizationId,
          rival.projectId,
          rival.project.prodEnvironmentId,
          0,
          domain,
          storedAt(-7),
        )
        .first<{ fingerprint: string }>();
      return (JSON.parse(row?.fingerprint ?? "{}") as { occupied: number }).occupied;
    };
    const aged = `aged-${newUlid().toLowerCase()}.example.com`;
    const fresh = `fresh-${newUlid().toLowerCase()}.example.com`;
    const verified = `verified-${newUlid().toLowerCase()}.example.com`;
    await seedSender(owner, aged, storedAt(-8), "pending");
    await seedSender(owner, fresh, storedAt(0), "pending");
    await seedSender(owner, verified, storedAt(-30), "ready");

    expect(await facts(aged)).toBe(0);
    expect(await facts(fresh)).toBe(1);
    expect(await facts(verified)).toBe(1);
  });
});

describe("a provider observation that verifies a name another organization holds", () => {
  it("retires the later sender as taken and answers the observation false, not with a constraint failure", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      now = new Date().toISOString(),
      holder = await cfFixture(control),
      later = await cfFixture(control),
      contendedDomain = `contended-${newUlid().toLowerCase()}.example.com`,
      freeDomain = `free-${newUlid().toLowerCase()}.example.com`;
    // The holder's name is verified; the later organization's unverified sender of that name is not yet.
    await seedSender(holder, contendedDomain, storedAt(-40), "ready");
    const contendedId = await seedSender(later, contendedDomain, storedAt(0), "pending");
    const freeId = await seedSender(later, freeDomain, storedAt(0), "pending");
    const observe = (
      domainId: string,
      organizationId: string,
      sendingStatus: "ready" | "pending",
    ) =>
      store.mailWorkspace.change({
        organizationId,
        domainId,
        now,
        change: {
          action: "observe",
          providerDomainId: `provider_${domainId}`,
          records: [],
          sendingStatus,
        },
      });

    // The holder verifies the name first; the later organization's sender of the same name is then taken.
    await expect(
      db
        .prepare("SELECT status FROM workspace_mail_domains WHERE domain_id=?1")
        .bind(contendedId)
        .first(),
    ).resolves.toEqual({ status: "active" });
    await expect(observe(contendedId, later.organizationId, "ready")).resolves.toBe(false);
    expect(
      await db
        .prepare(
          "SELECT status, retired_at IS NOT NULL AS retired FROM workspace_mail_domains WHERE domain_id=?1",
        )
        .bind(contendedId)
        .first(),
    ).toEqual({ status: "retired", retired: 1 });

    // A name no one else holds is verified as before.
    await expect(observe(freeId, later.organizationId, "ready")).resolves.toBe(true);
    expect(
      await db
        .prepare("SELECT status FROM workspace_mail_domains WHERE domain_id=?1")
        .bind(freeId)
        .first(),
    ).toEqual({ status: "active" });
  });
});

describe("the legacy mirror refuses a name that a suspended sender holds", () => {
  it("aborts a legacy insert of a suspended name of another organization, and no other name", async () => {
    const suspendedOwner = await cfFixture(control);
    const legacyRival = await cfFixture(control);
    const { domainId, domain } = await seedWorkspaceDomain(suspendedOwner);
    await suspendedOwner.db
      .prepare(
        `UPDATE workspace_mail_domains SET status='retired', reputation_state='suspended', reputation_suspended_at=?2,
          reputation_suspension_reason='complaint_rate', reputation_triggering_event_id=?3, reputation_version=reputation_version+1
          WHERE domain_id=?1`,
      )
      .bind(domainId, storedAt(0), randomUUID())
      .run();
    const insertLegacy = (name: string) =>
      legacyRival.db
        .prepare(
          "INSERT INTO resend_mail_domains(domain_id, organization_id, project_id, environment_id, domain, provider_domain_id, records, dns_receipts, configured_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', '{}', ?7)",
        )
        .bind(
          newUlid(),
          legacyRival.organizationId,
          legacyRival.projectId,
          legacyRival.project.prodEnvironmentId,
          name,
          `provider-${name}`,
          storedAt(0),
        )
        .run();
    await expect(insertLegacy(domain)).rejects.toThrow("mail_domain_conflict");
    await expect(
      insertLegacy(`free-${newUlid().toLowerCase()}.example.com`),
    ).resolves.toBeDefined();
  });
});
