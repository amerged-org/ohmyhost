import type { MailManagementJobPersistence } from "./d1-job-persistence.js";
import {
  syncWorkspaceMailCapabilities,
  type WorkspaceMailCapabilityPersistence,
  type MailScope,
  type ResendMailDomainRow,
} from "@ohmyhost/database";
import type { ResendManagementPersistence } from "./d1-resend-persistence.js";
import { createEnvironmentSecretCipher, parseUlid, type UlidFactory } from "@ohmyhost/platform";
import {
  createResendProvider,
  ResendRequestError,
  mailWebhookSecret,
  mailWebhookHeaders,
  requirePublicMailWebhook,
  validateMailWebhookUrl,
  type ResendDomain,
} from "@ohmyhost/provider-resend";
import { findCreatedDomain, hasSendingKey, revokeUnrecordedSendingKeys } from "./resend-keys.js";
export interface ResendDomainConfiguration extends MailScope {
  domain: string;
  sending: boolean;
  receiving: boolean;
  idempotencyKey: string;
  principalId: string;
}
export function createResendMailManagement(input: {
  persistence: ResendManagementPersistence;
  capabilityPersistence: WorkspaceMailCapabilityPersistence;
  apiKey: string;
  signingKey: string;
  sendingKeyEncryptionKey: string;
  ids: UlidFactory;
  now: () => Date;
  dns: { ensureMailRecords(input: unknown): Promise<unknown> };
  fetch?: typeof globalThis.fetch;
  publicTarget?: typeof requirePublicMailWebhook;
}) {
  const provider = createResendProvider({
    apiKey: input.apiKey,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const sendingKeyCipher = createEnvironmentSecretCipher({
    keyBase64: input.sendingKeyEncryptionKey,
    keyVersion: 1,
    crypto: globalThis.crypto,
  });
  const persistence = input.persistence,
    now = () => input.now().toISOString();
  const load = (scope: MailScope) => persistence.read(scope),
    loadReceiving = (scope: MailScope) => persistence.read(scope, true),
    reload = (row: ResendMailDomainRow) =>
      persistence.custody({ organizationId: row.organization_id, domainId: row.domain_id });
  async function requireReceivingOwner(scope: MailScope, row: ResendMailDomainRow) {
    if (!(await persistence.receivingOwner(scope, row.domain_id)))
      throw new Error("mail_scope_unavailable");
  }
  async function syncProvider(
    row: ResendMailDomainRow,
    fallback: { sending: boolean; receiving: boolean },
  ) {
    if (!row.provider_domain_id) return;
    const shared = await persistence.workspaceStatus(row.domain_id);
    if (shared !== null) {
      if (shared !== "active") throw new Error("mail_scope_unavailable");
      await syncWorkspaceMailCapabilities({
        persistence: input.capabilityPersistence,
        provider,
        organizationId: row.organization_id,
        domainId: row.domain_id,
        leaseToken: input.ids.next(),
        now: input.now,
      });
    } else await provider.updateDomain(row.provider_domain_id, fallback);
  }
  async function findProviderDomain(name: string) {
    let after: string | undefined,
      found: { id: string; domain: string; createdAt: string } | null = null;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await provider.listDomains(after);
      for (const item of page.items)
        if (item.domain === name) {
          if (found) throw new Error("mail_provider_domain_inventory_conflict");
          found = item;
        }
      if (!page.hasMore) return found;
      const last = page.items.at(-1);
      if (!last) throw new Error("mail_provider_domain_inventory_incomplete");
      after = last.id;
    }
    throw new Error("mail_provider_domain_inventory_incomplete");
  }
  async function observe(row: ResendMailDomainRow | null, manageLegacyDns = true) {
    if (!row) throw new Error("mail_scope_unavailable");
    let domain: ResendDomain;
    if (!row.provider_domain_id) {
      if (row.provider_claimed_at) {
        if (!row.provider_preflight_at) {
          if (input.now().getTime() - row.provider_claimed_at.getTime() < 120000)
            throw new Error("mail_domain_creation_unresolved");
          const existing = await findProviderDomain(row.domain);
          await persistence.change(
            {
              action: "resetUnpreparedCreation",
              domainId: row.domain_id,
              expectedClaimedAt: row.provider_claimed_at,
            },
            now,
          );
          if (existing) throw new Error("mail_domain_conflict");
          return observe(await reload(row), manageLegacyDns);
        }
        const candidate = await findProviderDomain(row.domain);
        if (
          !candidate ||
          Date.parse(candidate.createdAt) < row.provider_preflight_at.getTime() - 60000
        )
          throw new Error("mail_domain_creation_unresolved");
        domain = await provider.getDomain(candidate.id);
      } else {
        if (!(await persistence.change({ action: "claimCreation", domainId: row.domain_id }, now)))
          throw new Error("mail_domain_creation_unresolved");
        try {
          if (await findProviderDomain(row.domain)) throw new Error("mail_domain_conflict");
          await persistence.change({ action: "recordPreflight", domainId: row.domain_id }, now);
        } catch (error) {
          await persistence.change({ action: "clearCreation", domainId: row.domain_id }, now);
          throw error;
        }
        try {
          domain = await provider.createDomain({
            domain: row.domain,
            sending: row.sending,
            receiving: row.receiving,
          });
        } catch (error) {
          if (error instanceof ResendRequestError && !error.uncertain)
            await persistence.change({ action: "clearCreation", domainId: row.domain_id }, now);
          // The platform's provider account is full: nothing was created, and the same stored
          // setup resumes on a later reconciliation once capacity exists.
          if (error instanceof ResendRequestError && error.reason === "domain_limit")
            throw new Error("mail_provider_capacity_reached");
          throw error;
        }
      }
    } else domain = await provider.getDomain(row.provider_domain_id);
    if (domain.domain !== row.domain) throw new Error("mail_domain_receipt_mismatch");
    await save(row, domain);
    const dns = manageLegacyDns
      ? await input.dns.ensureMailRecords({
          organizationId: row.organization_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          domainId: row.domain_id,
        })
      : undefined;
    if (
      ["not_started", "failed"].includes(domain.status) &&
      (await persistence.change({ action: "claimVerification", domainId: row.domain_id }, now))
    ) {
      try {
        await provider.verifyDomain(domain.id);
      } catch (error) {
        if (error instanceof ResendRequestError && !error.uncertain)
          await persistence.change(
            { action: "clearVerification", domainId: row.domain_id, providerDomainId: domain.id },
            now,
          );
        throw error;
      }
    }
    await ensureSendingKey(row, domain);
    return {
      ...view(await reload(row)),
      ...(dns === undefined ? {} : { dns }),
    };
  }
  async function ensureSendingKey(row: ResendMailDomainRow, domain: ResendDomain) {
    const observed = await reload(row);
    const shared = (await persistence.workspaceStatus(row.domain_id)) === "active";
    if (
      !observed ||
      (!observed.sending && !shared) ||
      observed.sending_status !== "ready" ||
      domain.status !== "verified" ||
      observed.sending_key_id
    )
      return;
    if (observed.sending_key_claimed_at) {
      const recoveryAt = now();
      const claimed = await persistence.change(
        { action: "recoverKey", domainId: row.domain_id },
        () => recoveryAt,
      );
      if (!claimed) throw new Error("mail_sending_key_creation_unresolved");
      await revokeUnrecordedSendingKeys(provider, row.domain_id);
      await persistence.change(
        { action: "releaseKeyRecovery", domainId: row.domain_id, expectedClaimedAt: recoveryAt },
        now,
      );
    }
    if (!(await persistence.change({ action: "claimKey", domainId: row.domain_id }, now)))
      throw new Error("mail_sending_key_creation_unresolved");
    let created: { id: string; token: string };
    try {
      created = await provider.createDomainSendingKey({
        domainId: domain.id,
        name: `ohmyho:${row.domain_id}`,
      });
    } catch (error) {
      if (error instanceof ResendRequestError && !error.uncertain)
        await persistence.change({ action: "clearKey", domainId: row.domain_id }, now);
      throw error;
    }
    const encrypted = await sendingKeyCipher.encrypt({
      organizationId: row.organization_id,
      projectId: row.project_id,
      environmentId: row.environment_id,
      name: "RESEND_DOMAIN_SEND_KEY",
      value: created.token,
    });
    await persistence.change(
      {
        action: "saveKey",
        value: {
          domainId: parseUlid(row.domain_id),
          providerDomainId: domain.id,
          keyId: created.id,
          ...encrypted,
        },
      },
      now,
    );
  }
  async function save(row: ResendMailDomainRow, domain: ResendDomain) {
    const shared = (await persistence.workspaceStatus(row.domain_id)) === "active";
    const ready = (purpose: "sending" | "receiving") => {
      // Workspace resources retain their verification state while individual senders are off.
      // Admission still requires a current enabled project binding and its application proof.
      const workspaceSender = purpose === "sending" && shared;
      const enabled =
        purpose === "sending"
          ? row.sending || workspaceSender
          : row.receiving && !row.receiving_suspended;
      if (!enabled) return "disabled";
      if (!workspaceSender && !(purpose === "sending" ? domain.sending : domain.receiving))
        return "pending";
      const records = domain.records.filter((r) =>
        purpose === "receiving"
          ? r.purpose.toLowerCase().startsWith("receiving")
          : !r.purpose.toLowerCase().startsWith("receiving"),
      );
      if (
        records.length &&
        records.every((r) => r.status === "verified") &&
        (!workspaceSender || domain.status === "verified")
      )
        return "ready";
      return records.some((r) => r.status === "failed") ? "failed" : "pending";
    };
    await persistence.change(
      {
        action: "saveObservation",
        value: {
          domainId: row.domain_id,
          providerId: domain.id,
          sendingStatus: ready("sending"),
          receivingStatus: ready("receiving"),
          records: domain.records,
        },
      },
      now,
    );
  }
  async function cleanupRetired(row: ResendMailDomainRow) {
    // Every sending key of this row carries its deterministic name; success means none remains.
    if (row.sending_key_id || row.sending_key_claimed_at) {
      if (row.sending_key_id)
        try {
          await provider.deleteApiKey(row.sending_key_id);
        } catch (error) {
          if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
        }
      await revokeUnrecordedSendingKeys(provider, row.domain_id);
      if (await hasSendingKey(provider, row.domain_id, row.sending_key_id))
        throw new Error("mail_retirement_unverified");
    }
    let providerDomainId = row.provider_domain_id;
    if (!providerDomainId && row.provider_claimed_at && row.provider_preflight_at) {
      // No new setup of this name may start until this retirement completes, so a domain created
      // from this row's preflight is this row's. Its absence is not proof: the timed-out creation
      // may still have succeeded, so the retirement stays pending until the domain is found.
      if (await persistence.liveName(row.domain)) throw new Error("mail_retirement_unverified");
      providerDomainId = await findCreatedDomain(provider, row.domain, row.provider_preflight_at);
      if (!providerDomainId) throw new Error("mail_retirement_unverified");
      await persistence.change(
        { action: "recordFound", domainId: row.domain_id, providerDomainId },
        now,
      );
    }
    if (providerDomainId) {
      let present = true;
      try {
        const domain = await provider.getDomain(providerDomainId);
        if (domain.domain !== row.domain) throw new Error("mail_retirement_unverified");
        await provider.deleteDomain(providerDomainId);
      } catch (error) {
        if (error instanceof ResendRequestError && error.status === 404) present = false;
        else throw error;
      }
      if (present) {
        try {
          await provider.getDomain(providerDomainId);
          throw new Error("mail_retirement_unverified");
        } catch (error) {
          if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
        }
      }
    }
    return {
      status: "deleted" as const,
      domain: row.domain,
      dns_records: row.records,
    };
  }
  return {
    async syncWorkspaceResource(scope: { organizationId: string; domainId: string }) {
      const row = await persistence.legacy(scope, "active");
      if (!row) throw new Error("mail_scope_unavailable");
      await syncProvider(row, { sending: row.sending, receiving: row.receiving });
      if (row.provider_domain_id) {
        const custody = await reload(row);
        if (!custody) throw new Error("mail_scope_unavailable");
        await save(custody, await provider.getDomain(row.provider_domain_id));
      }
    },
    async reconcileWorkspaceResource(scope: { organizationId: string; domainId: string }) {
      const row = await persistence.legacy(scope, "active");
      if (!row) throw new Error("mail_scope_unavailable");
      await syncProvider(row, { sending: row.sending, receiving: row.receiving });
      return observe(await reload(row), false);
    },
    async retireWorkspaceResource(scope: { organizationId: string; domainId: string }) {
      const result = await persistence.retireLegacy(scope, now);
      return cleanupRetired(result);
    },
    async reconcile(scope: MailScope) {
      await persistence.requirePaid(scope.organizationId, now);
      const projected = (await loadReceiving(scope)) ?? (await load(scope));
      if (!projected) throw new Error("mail_scope_unavailable");
      const custody = await reload(projected);
      const observed = await observe(custody, projected.project_id === custody?.project_id);
      return {
        ...view((await loadReceiving(scope)) ?? (await load(scope))),
        ...(observed.dns === undefined ? {} : { dns: observed.dns }),
      };
    },
    async configure(scope: ResendDomainConfiguration) {
      if (scope.receiving) await persistence.receivingAdmission(scope, now);
      const previous = (await loadReceiving(scope)) ?? (await load(scope));
      if (scope.receiving && !previous?.webhook_verified_at)
        throw new Error("mail_webhook_required");
      const row = await persistence.configure(
        () => ({
          ...scope,
          domainId: previous ? parseUlid(previous.domain_id) : input.ids.next(),
          webhookUrl: previous?.webhook_url ?? null,
        }),
        now,
      );
      if (row.provider_domain_id)
        await syncProvider(row, { sending: row.sending, receiving: row.receiving });
      const observed = await observe(await reload(row));
      return {
        ...view((await loadReceiving(scope)) ?? (await load(scope))),
        ...(observed.dns === undefined ? {} : { dns: observed.dns }),
      };
    },
    async get(scope: MailScope) {
      const row = await load(scope);
      if (!row) return null;
      if (!row.provider_domain_id) return view(row);
      const custody = await reload(row);
      if (!custody) return view(row);
      const domain = await provider.getDomain(row.provider_domain_id);
      if (domain.domain !== row.domain) throw new Error("mail_domain_receipt_mismatch");
      // Reading the domain never creates or revokes sending keys: the configure, reconcile and ensure paths own key custody.
      await save(custody, domain);
      return view(await load(scope));
    },
    async prepareWebhook(scope: MailScope & { url: string }) {
      validateMailWebhookUrl(scope.url);
      const row = await loadReceiving(scope);
      if (!row) throw new Error("mail_scope_unavailable");
      await requireReceivingOwner(scope, row);
      // Fence delivery locally before changing the provider or endpoint.
      await persistence.change(
        { action: "prepareWebhook", domainId: row.domain_id, url: scope.url },
        now,
      );
      if (row.provider_domain_id)
        await syncProvider(row, { sending: row.sending, receiving: false });
      const current = (await loadReceiving(scope)) ?? row;
      return {
        url: scope.url,
        signing_secret: mailWebhookSecret(
          input.signingKey,
          row.domain_id,
          current.webhook_secret_generation,
        ),
        status: "verification_required",
      };
    },
    async rotateWebhook(scope: MailScope) {
      const row = await loadReceiving(scope);
      if (!row) throw new Error("mail_scope_unavailable");
      await requireReceivingOwner(scope, row);
      if (!row.webhook_url) throw new Error("mail_webhook_required");
      await persistence.change({ action: "rotateWebhookSecret", domainId: row.domain_id }, now);
      const current = await loadReceiving(scope);
      if (!current) throw new Error("mail_scope_unavailable");
      return {
        url: current.webhook_url,
        signing_secret: mailWebhookSecret(
          input.signingKey,
          row.domain_id,
          current.webhook_secret_generation,
        ),
        status: "verification_required",
      };
    },
    async verifyWebhook(scope: MailScope) {
      const row = await loadReceiving(scope);
      if (!row) throw new Error("mail_scope_unavailable");
      await requireReceivingOwner(scope, row);
      if (!row.webhook_url) throw new Error("mail_webhook_required");
      await persistence.receivingAdmission(scope, now);
      const url = await (input.publicTarget ?? requirePublicMailWebhook)(row.webhook_url),
        id = input.ids.next();
      const body = JSON.stringify({
        id,
        type: "email.webhook_test",
        project_id: scope.projectId,
        environment_id: scope.environmentId,
        data: {},
      });
      const response = await (input.fetch ?? globalThis.fetch)(url.href, {
        method: "POST",
        redirect: "manual",
        body,
        headers: mailWebhookHeaders(
          body,
          id,
          mailWebhookSecret(input.signingKey, row.domain_id, row.webhook_secret_generation),
          input.now(),
        ),
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("mail_webhook_verification_failed");
      await persistence.change(
        { action: "verifyWebhook", domainId: row.domain_id, url: row.webhook_url },
        now,
      );
      if (row.provider_domain_id)
        await syncProvider(row, { sending: row.sending, receiving: true });
      const observed = await observe(await reload(row));
      return {
        ...view(await loadReceiving(scope)),
        ...(observed.dns === undefined ? {} : { dns: observed.dns }),
      };
    },
    /**
     * Retires the project's mail domain while the project stays active. Control closes every
     * admission first; the provider key and domain are then removed and their absence read back.
     * Only the recorded provider domain, or an unrecorded creation from this row's own preflight
     * window that no live row claims, is ever deleted. DNS is left unchanged and reported.
     */
    async retire(scope: MailScope & { idempotencyKey: string }) {
      const row = await persistence.retire(scope, now);
      const result = await cleanupRetired(row);
      await persistence.change({ action: "finishRetirement", domainId: row.domain_id }, now);
      return result;
    },
    async disableReceiving(scope: MailScope) {
      const row = await loadReceiving(scope);
      if (!row) throw new Error("mail_scope_unavailable");
      await requireReceivingOwner(scope, row);
      await persistence.change({ action: "disableReceiving", domainId: row.domain_id }, now);
      if (row.provider_domain_id)
        await syncProvider(row, { sending: row.sending, receiving: false });
      return { status: "disabled" };
    },
  };
}
function view(row: ResendMailDomainRow | null) {
  if (!row) throw new Error("mail_scope_unavailable");
  const sending =
    row.sending_status === "ready" && !row.sending_key_id ? "pending" : row.sending_status;
  return {
    domain_id: row.domain_id,
    domain: row.domain,
    environment_id: row.environment_id,
    sending,
    receiving: row.receiving_status,
    status:
      (row.sending && sending === "ready") || (row.receiving && row.receiving_status === "ready")
        ? "ready"
        : "verification_pending",
    configured_at: row.configured_at.toISOString(),
    observed_at: row.observed_at?.toISOString() ?? null,
    dns_records: row.records,
    webhook: row.webhook_url
      ? { url: row.webhook_url, verified: row.webhook_verified_at !== null }
      : null,
    next_check_after_seconds:
      (!row.sending || sending === "ready") && (!row.receiving || row.receiving_status === "ready")
        ? null
        : 60,
  };
}
export async function reconcilePendingResendDomains(
  persistence: MailManagementJobPersistence,
  ensure: (scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  }) => Promise<unknown>,
  now: () => Date,
) {
  const result = await persistence.listPendingLegacy();
  let reconciled = 0,
    failed = 0;
  for (const row of result) {
    try {
      const instant = now().toISOString();
      if (!(await persistence.claimLegacy(row.domain_id, instant))) continue;
      await ensure({
        organizationId: row.organization_id,
        projectId: row.project_id,
        environmentId: row.environment_id,
      });
      reconciled++;
    } catch {
      failed++;
    }
  }
  return { reconciled, failed };
}
