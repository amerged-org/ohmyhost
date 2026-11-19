import {
  syncWorkspaceMailCapabilities,
  type WorkspaceMailCapabilityPersistence,
} from "@ohmyhost/database";
import type { WorkspaceMailManagementPersistence } from "./d1-workspace-persistence.js";
import { createEnvironmentSecretCipher, type UlidFactory } from "@ohmyhost/platform";
import {
  createResendProvider,
  ResendRequestError,
  type ResendDomain,
} from "@ohmyhost/provider-resend";
import { findCreatedDomain, hasSendingKey, revokeUnrecordedSendingKeys } from "./resend-keys.js";

export interface WorkspaceProviderRow {
  domain_id: string;
  organization_id: string;
  domain: string;
  legacy_domain_id: string | null;
  status: "active" | "retiring" | "retired";
  revision: string;
  custody_organization_id: string;
  custody_project_id: string;
  custody_environment_id: string;
  provider_domain_id: string | null;
  provider_claimed_at: Date | null;
  provider_preflight_at: Date | null;
  verify_requested_at: Date | null;
  sending_key_id: string | null;
  sending_key_claimed_at: Date | null;
  records: unknown[];
}

/** Native workspace resources never need a customer project to hold provider authority. */
export function createWorkspaceMailManagement(input: {
  persistence: WorkspaceMailManagementPersistence;
  capabilityPersistence: WorkspaceMailCapabilityPersistence;
  apiKey: string;
  sendingKeyEncryptionKey: string;
  ids: UlidFactory;
  now: () => Date;
  fetch?: typeof globalThis.fetch;
  dns: {
    ensureWorkspaceMailRecords(input: unknown): Promise<unknown>;
    retireWorkspaceMailRecords(input: unknown): Promise<unknown>;
  };
  legacy: {
    syncWorkspaceResource(input: { organizationId: string; domainId: string }): Promise<unknown>;
    reconcileWorkspaceResource(input: {
      organizationId: string;
      domainId: string;
    }): Promise<unknown>;
    retireWorkspaceResource(input: { organizationId: string; domainId: string }): Promise<unknown>;
  };
}) {
  const provider = createResendProvider({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const cipher = createEnvironmentSecretCipher({
    keyBase64: input.sendingKeyEncryptionKey,
    keyVersion: 1,
    crypto: globalThis.crypto,
  });
  const persistence = input.persistence,
    now = () => input.now().toISOString();
  const load = (scope: { organizationId: string; domainId: string }) => persistence.load(scope),
    view = (scope: { organizationId: string; domainId: string }) => persistence.view(scope);
  async function observe(row: WorkspaceProviderRow, domain: ResendDomain) {
    if (domain.domain !== row.domain) throw new Error("mail_domain_receipt_mismatch");
    const records = domain.records.filter(
      (record) => !record.purpose.toLowerCase().startsWith("receiving"),
    );
    const sending =
      domain.status === "verified" &&
      records.length &&
      records.every((record) => record.status === "verified")
        ? "ready"
        : records.some((record) => record.status === "failed")
          ? "failed"
          : "pending";
    if (
      !(await persistence.change(
        { organizationId: row.organization_id, domainId: row.domain_id },
        {
          action: "observe",
          providerDomainId: domain.id,
          records: domain.records,
          sendingStatus: sending,
        },
        now,
      ))
    )
      throw new Error("mail_scope_unavailable");
    return sending;
  }
  async function ensureDns(row: WorkspaceProviderRow) {
    const leaseToken = input.ids.next();
    const scope = { organizationId: row.organization_id, domainId: row.domain_id };
    if (!(await persistence.change(scope, { action: "claimDns", leaseToken }, now)))
      throw new Error("mail_operation_pending");
    const result = await input.dns.ensureWorkspaceMailRecords({
      organizationId: row.organization_id,
      mailDomainId: row.domain_id,
    });
    if (typeof result !== "object" || result === null || !("status" in result))
      throw new Error("mail_dns_receipt_changed");
    if (result.status === "conflict")
      throw new Error(
        "code" in result && typeof result.code === "string"
          ? result.code
          : "mail_dns_receipt_changed",
      );
    if (result.status !== "configured" && result.status !== "action_required")
      throw new Error("mail_dns_receipt_changed");
    await persistence.change(scope, { action: "releaseDns", leaseToken }, now);
  }
  async function ensureKey(row: WorkspaceProviderRow, domain: ResendDomain) {
    if (row.sending_key_id || domain.status !== "verified") return;
    if (row.sending_key_claimed_at) {
      if (input.now().getTime() - row.sending_key_claimed_at.getTime() < 300_000)
        throw new Error("mail_sending_key_creation_unresolved");
      if (
        !(await persistence.change(
          { organizationId: row.organization_id, domainId: row.domain_id },
          { action: "recoverKey" },
          now,
        ))
      )
        throw new Error("mail_sending_key_creation_unresolved");
      await revokeUnrecordedSendingKeys(provider, row.domain_id);
    } else {
      if (
        !(await persistence.change(
          { organizationId: row.organization_id, domainId: row.domain_id },
          { action: "claimKey" },
          now,
        ))
      )
        throw new Error("mail_sending_key_creation_unresolved");
    }
    let key: { id: string; token: string };
    try {
      key = await provider.createDomainSendingKey({
        domainId: domain.id,
        name: `ohmyho:${row.domain_id}`,
      });
    } catch (error) {
      if (error instanceof ResendRequestError && !error.uncertain)
        await persistence.change(
          { organizationId: row.organization_id, domainId: row.domain_id },
          { action: "clearKey" },
          now,
        );
      throw error;
    }
    const encrypted = await cipher.encrypt({
      organizationId: row.custody_organization_id,
      projectId: row.custody_project_id,
      environmentId: row.custody_environment_id,
      name: "RESEND_DOMAIN_SEND_KEY",
      value: key.token,
    });
    if (
      !(await persistence.change(
        { organizationId: row.organization_id, domainId: row.domain_id },
        { action: "saveKey", keyId: key.id, ...encrypted },
        now,
      ))
    )
      throw new Error("mail_sending_key_creation_unresolved");
  }
  async function createProviderDomain(row: WorkspaceProviderRow) {
    if (row.provider_claimed_at) {
      if (input.now().getTime() - row.provider_claimed_at.getTime() < 120_000)
        throw new Error("mail_domain_creation_unresolved");
      if (row.provider_preflight_at) {
        const found = await findCreatedDomain(provider, row.domain, row.provider_preflight_at);
        if (!found) throw new Error("mail_domain_creation_unresolved");
        return provider.getDomain(found);
      }
      await persistence.change(
        { organizationId: row.organization_id, domainId: row.domain_id },
        { action: "resetCreation" },
        now,
      );
    }
    if (
      !(await persistence.change(
        { organizationId: row.organization_id, domainId: row.domain_id },
        { action: "claimCreation" },
        now,
      ))
    )
      throw new Error("mail_domain_creation_unresolved");
    // Inventory before a persisted preflight prevents adopting a customer's unrelated domain.
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await provider.listDomains(after);
      if (page.items.some((candidate) => candidate.domain === row.domain)) {
        await persistence.change(
          { organizationId: row.organization_id, domainId: row.domain_id },
          { action: "releaseUnpreparedCreation" },
          now,
        );
        throw new Error("mail_domain_conflict");
      }
      if (!page.hasMore) break;
      after = page.items.at(-1)?.id;
      if (!after || pageNumber === 19) throw new Error("mail_provider_domain_inventory_incomplete");
    }
    if (
      !(await persistence.change(
        { organizationId: row.organization_id, domainId: row.domain_id },
        { action: "recordPreflight" },
        now,
      ))
    )
      throw new Error("mail_scope_unavailable");
    try {
      return await provider.createDomain({ domain: row.domain, sending: true, receiving: false });
    } catch (error) {
      if (error instanceof ResendRequestError && !error.uncertain)
        await persistence.change(
          { organizationId: row.organization_id, domainId: row.domain_id },
          { action: "clearCreation" },
          now,
        );
      if (error instanceof ResendRequestError && error.reason === "domain_limit")
        throw new Error("mail_provider_capacity_reached");
      throw error;
    }
  }
  return {
    async sync(scope: { organizationId: string; domainId: string }) {
      const row = await load(scope);
      if (row.status !== "active") throw new Error("mail_scope_unavailable");
      if (row.legacy_domain_id) await input.legacy.syncWorkspaceResource(scope);
      else {
        await syncWorkspaceMailCapabilities({
          ...scope,
          persistence: input.capabilityPersistence,
          provider,
          leaseToken: input.ids.next(),
          now: input.now,
        });
        if (row.provider_domain_id)
          await observe(row, await provider.getDomain(row.provider_domain_id));
      }
      return view(scope);
    },
    async ensure(scope: { organizationId: string; domainId: string }) {
      await persistence.requirePaid(scope.organizationId, now);
      const row = await load(scope);
      if (row.status !== "active") throw new Error("mail_scope_unavailable");
      if (row.legacy_domain_id) {
        await input.legacy.reconcileWorkspaceResource(scope);
        const current = await view(scope);
        if (current.sending !== "ready") await ensureDns(row);
        return view(scope);
      }
      const domain = row.provider_domain_id
        ? await provider.getDomain(row.provider_domain_id)
        : await createProviderDomain(row);
      const sending = await observe(row, domain);
      await ensureDns(row);
      if (sending !== "ready") {
        if (
          await persistence.change(
            { organizationId: row.organization_id, domainId: row.domain_id },
            { action: "claimVerification" },
            now,
          )
        ) {
          try {
            await provider.verifyDomain(domain.id);
          } catch (error) {
            // A definite refusal started no verification, so its claim must not hold the next attempt back.
            if (error instanceof ResendRequestError && !error.uncertain)
              await persistence.change(
                {
                  organizationId: row.organization_id,
                  domainId: row.domain_id,
                },
                { action: "clearVerification", providerDomainId: domain.id },
                now,
              );
            throw error;
          }
        }
      } else {
        await ensureKey(await load(scope), domain);
        await syncWorkspaceMailCapabilities({
          ...scope,
          persistence: input.capabilityPersistence,
          provider,
          leaseToken: input.ids.next(),
          now: input.now,
        });
      }
      return view(scope);
    },
    async retire(scope: { organizationId: string; domainId: string; expectedRevision: number }) {
      const row = await persistence.beginRetirement(scope, input.now);
      if (row.status === "retired") return view(scope);
      // Local admission is closed before exact owned-record cleanup. A missing grant or an
      // uncertain DNS deletion keeps this same resource retiring for an authorized retry.
      const dnsCleanup = await input.dns.retireWorkspaceMailRecords({
        organizationId: row.organization_id,
        mailDomainId: row.domain_id,
      });
      if (typeof dnsCleanup !== "object" || dnsCleanup === null || !("status" in dnsCleanup))
        throw new Error("mail_retirement_unverified");
      if (dnsCleanup.status === "conflict")
        throw new Error(
          "code" in dnsCleanup && typeof dnsCleanup.code === "string"
            ? dnsCleanup.code
            : "mail_dns_receipt_changed",
        );
      if (
        dnsCleanup.status !== "deleted" ||
        !("recordIds" in dnsCleanup) ||
        !Array.isArray(dnsCleanup.recordIds) ||
        dnsCleanup.recordIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id))
      )
        throw new Error("mail_retirement_unverified");
      if (row.legacy_domain_id) await input.legacy.retireWorkspaceResource(scope);
      else {
        if (row.sending_key_id)
          try {
            await provider.deleteApiKey(row.sending_key_id);
          } catch (error) {
            if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
          }
        if (row.sending_key_id || row.sending_key_claimed_at) {
          await revokeUnrecordedSendingKeys(provider, row.domain_id);
          if (await hasSendingKey(provider, row.domain_id, row.sending_key_id))
            throw new Error("mail_retirement_unverified");
        }
        let id = row.provider_domain_id;
        if (!id && row.provider_preflight_at) {
          id = await findCreatedDomain(provider, row.domain, row.provider_preflight_at);
          if (!id) throw new Error("mail_retirement_unverified");
          await persistence.change(
            { organizationId: row.organization_id, domainId: row.domain_id },
            { action: "recordFound", providerDomainId: id },
            now,
          );
        }
        if (id) {
          try {
            const current = await provider.getDomain(id);
            if (current.domain !== row.domain) throw new Error("mail_retirement_unverified");
            await provider.deleteDomain(id);
          } catch (error) {
            if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
          }
          try {
            await provider.getDomain(id);
            throw new Error("mail_retirement_unverified");
          } catch (error) {
            if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
          }
        }
      }
      await persistence.finishRetirement(scope, now);
      return view(scope);
    },
  };
}
