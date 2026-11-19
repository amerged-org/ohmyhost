import { createHash } from "node:crypto";

import { newUlid } from "../../src/catalog/common.js";
import { createRateCardAuthority } from "./rate-cards.js";
import type { D1Database } from "../../src/d1-types.js";
import { runGrantCredit, setPaid } from "../../src/catalog/credit/index.js";
import type { createControlStore } from "../../src/store.js";
import { storedTimestamp } from "../../src/timestamps.js";
import type { TestControl } from "./control-d1.js";
import { seedProject, type SeededProject } from "./platform-fixtures.js";

export type MailStore = ReturnType<typeof createControlStore>;

export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const iso = (offsetMilliseconds = 0) =>
  new Date(Date.now() + offsetMilliseconds).toISOString();

export async function insertRow(db: D1Database, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await db
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(row))
    .run();
}

/** The shared Resend rate card and both mail meters, published once per control database. */
export async function publishMailPricing(control: TestControl, at = "2026-10-01T00:00:00.000Z") {
  const authority = createRateCardAuthority({ list: async () => [control.core] });
  await authority.publishResendMailUsageRateCard({ publishedAt: at, effectiveFrom: at });
  for (const meter of ["mail.sent", "mail.received"])
    await authority.activateUsageMeter({
      meter,
      rateCardId: "resend-2026-09-22-v1",
      startsAt: at,
      now: at,
    });
}

/** Paid access (until 2099) plus `credits` one-time credits on top of the allowance, written through the credit core. */
export async function fundOrganization(
  control: TestControl,
  organizationId: string,
  now = iso(),
  credits = 1000,
) {
  await control.core.batch(
    setPaid(control.core, {
      organizationId,
      paidUntil: "2099-01-01T00:00:00.000Z",
      source: "manual",
      now,
    }).statements,
  );
  await runGrantCredit(control.core, {
    organizationId,
    key: `topup:mail_fixture_${newUlid()}`,
    kind: "onetime",
    amountMicros: credits * 1_000_000,
    now,
  });
}

export interface MailRig {
  readonly project: SeededProject;
  readonly scope: { organizationId: string; projectId: string; environmentId: string };
  readonly domainId: string;
  readonly domain: string;
  readonly providerDomainId: string;
  readonly now: string;
}

/**
 * An organization with one ready legacy Resend domain (sending and verified receiving; its active workspace
 * resource and legacy sender binding are mirrored by the insert), the gateway key and the reputation state a send needs.
 */
export async function seedMailRig(
  control: TestControl,
  options: { receiving?: boolean } = {},
): Promise<MailRig> {
  const project = await seedProject(control),
    db = control.core,
    now = iso(),
    stored = storedTimestamp(now),
    domainId = newUlid(),
    domain = `mail-${domainId.slice(-10).toLowerCase()}.example.com`,
    providerDomainId = `provider_${domainId}`,
    receiving = options.receiving ?? true,
    scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
    };
  await insertRow(db, "resend_mail_domains", {
    domain_id: domainId,
    organization_id: scope.organizationId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
    domain,
    provider_domain_id: providerDomainId,
    sending_key_id: `key_${domainId}`,
    sending_key_ciphertext: new Uint8Array(32).fill(1),
    sending_key_nonce: new Uint8Array(12).fill(2),
    sending_key_sha256: new Uint8Array(32).fill(3),
    sending_key_version: 1,
    sending: 1,
    receiving: receiving ? 1 : 0,
    sending_status: "ready",
    receiving_status: receiving ? "ready" : "disabled",
    webhook_url: receiving ? "https://receiver.example.com/mail" : null,
    webhook_verified_at: receiving ? stored : null,
    configured_at: stored,
  });
  // The insert mirrors itself into the active workspace resource and the legacy sender binding.
  await db
    .prepare(
      "UPDATE workspace_mail_domains SET registrable_domain='example.com',sending_status='ready' WHERE domain_id=?",
    )
    .bind(domainId)
    .run();
  await insertRow(db, "mail_gateway_keys", {
    organization_id: scope.organizationId,
    project_id: scope.projectId,
    key_version: 1,
    key_sha256: Uint8Array.from(Buffer.from(sha(newUlid()), "hex")),
    created_at: stored,
  });
  await insertRow(db, "mail_reputation_states", {
    organization_id: scope.organizationId,
    project_id: scope.projectId,
    state: "active",
    warmup_started_at: stored,
    version: 1,
    updated_at: stored,
  });
  return { project, scope, domainId, domain, providerDomainId, now };
}
