import { createHash } from "node:crypto";
import {
  syncWorkspaceMailCapabilities,
  type WorkspaceMailCapabilityPersistence,
} from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import { createResendProvider, ResendRequestError } from "@ohmyhost/provider-resend";
import type { MailProjectDeletionPersistence } from "./d1-deletion-persistence.js";
import { findCreatedDomain, revokeUnrecordedSendingKeys } from "./resend-keys.js";
export async function deleteResendMailProject(
  input: {
    persistence: MailProjectDeletionPersistence;
    capabilityPersistence: WorkspaceMailCapabilityPersistence;
    apiKey: string;
    fetch?: typeof globalThis.fetch;
    dns: { deleteMailRecords(input: unknown): Promise<unknown> };
    now: () => Date;
  },
  raw: unknown,
) {
  if (typeof raw !== "object" || raw === null) throw new TypeError("Invalid mail deletion");
  const r = raw as Record<string, unknown>;
  const organizationId = parseUlid(String(r["organizationId"])),
    projectId = parseUlid(String(r["projectId"])),
    operationId = parseUlid(String(r["operationId"]));
  const persistence = input.persistence,
    prepared = await persistence.prepare({ organizationId, projectId, operationId }),
    inventory = new Set(prepared.inventory),
    legacy = prepared.legacy,
    retained = prepared.retained,
    rows = prepared.domains;
  const inventoried = (provider: string, kind: string, locator: string) =>
    inventory.has(createHash("sha256").update(`${provider}\0${kind}\0${locator}`).digest("hex"));
  const provider = createResendProvider({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const cleanup: {
    provider: string;
    resourceKind: string;
    locator: string;
    outcome: "removed" | "not_found";
  }[] = [];
  for (const row of retained)
    await syncWorkspaceMailCapabilities({
      persistence: input.capabilityPersistence,
      provider,
      organizationId,
      domainId: row.domain_id,
      leaseToken: operationId,
      now: input.now,
    });
  for (const row of rows) {
    if (row.sending_key_claimed_at && !row.sending_key_id)
      await revokeUnrecordedSendingKeys(provider, row.domain_id);
    if (row.sending_key_id) {
      let removed = true;
      try {
        await provider.deleteApiKey(row.sending_key_id);
      } catch (error) {
        if (error instanceof ResendRequestError && error.status === 404) removed = false;
        else throw error;
      }
      cleanup.push({
        provider: "resend",
        resourceKind: "mail-api-key",
        locator: row.sending_key_id,
        outcome: removed ? "removed" : "not_found",
      });
    }
    const dns = await input.dns.deleteMailRecords({
      organizationId,
      projectId,
      operationId,
      domainId: row.domain_id,
    });
    if (
      typeof dns !== "object" ||
      dns === null ||
      !("recordIds" in dns) ||
      !Array.isArray(dns.recordIds) ||
      dns.recordIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id))
    )
      throw new Error("Mail DNS cleanup unverified");
    // Every owned record is removed; evidence names only records the frozen inventory listed, so
    // a receipt saved after the snapshot (a DNS publication racing the deletion) is not extra.
    for (const id of dns.recordIds)
      if (inventoried("cloudflare", "mail-dns-record", `${row.domain_id}/${String(id)}`))
        cleanup.push({
          provider: "cloudflare",
          resourceKind: "mail-dns-record",
          locator: `${row.domain_id}/${String(id)}`,
          outcome: "not_found",
        });
    // A creation that stored its preflight but no provider id may still have succeeded. A completed
    // retirement already confirmed it gone; otherwise it counts as absent only once found and removed.
    let providerDomainId = row.provider_domain_id;
    if (
      !providerDomainId &&
      row.provider_claimed_at &&
      row.provider_preflight_at &&
      !row.retirement_completed
    ) {
      providerDomainId = await findCreatedDomain(provider, row.domain, row.provider_preflight_at);
      if (!providerDomainId) throw new Error("Mail domain deletion unverified");
      await persistence.recordFound(row.domain_id, providerDomainId);
    }
    if (providerDomainId) {
      let found = true;
      try {
        const domain = await provider.getDomain(providerDomainId);
        if (domain.domain !== row.domain) throw new Error("Mail deletion receipt mismatch");
      } catch (error) {
        if (error instanceof ResendRequestError && error.status === 404) found = false;
        else throw error;
      }
      if (found) {
        await provider.deleteDomain(providerDomainId);
        let absent = false;
        try {
          await provider.getDomain(providerDomainId);
        } catch (error) {
          if (error instanceof ResendRequestError && error.status === 404) absent = true;
          else throw error;
        }
        if (!absent) throw new Error("Mail domain deletion unverified");
      }
      // A domain found after the snapshot is receipted on its row, but is not evidence for an
      // inventory that never listed it, also when a retry of this operation now sees its receipt.
      if (inventoried("resend", "mail-domain", providerDomainId))
        cleanup.push({
          provider: "resend",
          resourceKind: "mail-domain",
          locator: providerDomainId,
          outcome: found ? "removed" : "not_found",
        });
    }
    await persistence.finish(row.domain_id, input.now);
  }
  return { status: "deleted", projectId, resourcesAbsent: true, cleanup: [...legacy, ...cleanup] };
}
