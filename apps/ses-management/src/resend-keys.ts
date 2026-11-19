import { createResendProvider, ResendRequestError } from "@ohmyhost/provider-resend";

/** One-time Resend tokens cannot be recovered after an uncertain creation. Revoke only our
 * deterministic key name before allowing a replacement, never an unrelated team key. */
export async function revokeUnrecordedSendingKeys(
  provider: ReturnType<typeof createResendProvider>,
  domainId: string,
) {
  const name = `ohmyho:${domainId}`;
  let after: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await provider.listApiKeys(after);
    for (const key of page.items) {
      if (seen.has(key.id)) throw new Error("mail_key_inventory_invalid");
      seen.add(key.id);
      if (key.name === name) {
        try {
          await provider.deleteApiKey(key.id);
        } catch (error) {
          if (!(error instanceof ResendRequestError && error.status === 404)) throw error;
        }
      }
    }
    if (!page.hasMore) return;
    const last = page.items.at(-1);
    if (!last) throw new Error("mail_key_inventory_invalid");
    after = last.id;
  }
  throw new Error("mail_key_inventory_incomplete");
}

/** Reads the bounded key inventory back: true while a key of this row's name or id remains. */
export async function hasSendingKey(
  provider: ReturnType<typeof createResendProvider>,
  domainId: string,
  keyId: string | null,
) {
  const name = `ohmyho:${domainId}`;
  let after: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await provider.listApiKeys(after);
    if (page.items.some((key) => key.name === name || key.id === keyId)) return true;
    if (!page.hasMore) return false;
    const last = page.items.at(-1);
    if (!last) throw new Error("mail_key_inventory_invalid");
    after = last.id;
  }
  throw new Error("mail_key_inventory_incomplete");
}

/**
 * An unrecorded creation whose preflight was stored may exist at the provider even after its own
 * request timed out. Its domain is the one of that name created from the preflight on; without
 * such a domain the outcome stays unknown, so callers keep the cleanup unverified.
 */
export async function findCreatedDomain(
  provider: ReturnType<typeof createResendProvider>,
  name: string,
  preflightAt: Date,
) {
  let after: string | undefined,
    found: { id: string; createdAt: string } | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await provider.listDomains(after);
    for (const item of page.items)
      if (item.domain === name) {
        if (found) throw new Error("mail_provider_domain_inventory_conflict");
        found = item;
      }
    if (!page.hasMore)
      return found && Date.parse(found.createdAt) >= preflightAt.getTime() - 60000
        ? found.id
        : null;
    const last = page.items.at(-1);
    if (!last) throw new Error("mail_provider_domain_inventory_incomplete");
    after = last.id;
  }
  throw new Error("mail_provider_domain_inventory_incomplete");
}
