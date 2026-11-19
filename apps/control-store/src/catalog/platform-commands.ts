import {
  claimCloudflareProjectDomainsOperation,
  markCloudflareProjectDomainsDeletedForDeletion,
  putCloudflareProjectDomainReceipt,
  putCloudflareProjectDomains,
  readCloudflareProjectDomainDeletionState,
  readCloudflareProjectDomainReceipts,
  readCloudflareProjectDomains,
  readCloudflareProjectDomainsByIdempotency,
  readCloudflareProjectDomainsForOperation,
} from "./domains-mail/cloudflare-project-domains.js";
import { settleDomainReservations } from "./domains-mail/domain-claims.js";
import {
  authorizeProviderEnvironmentSecret,
  ensureEnvironmentSecret,
  listEnvironmentSecrets,
  mutateEnvironmentSecret,
  readApiEnvironmentSecrets,
  mutateApiEnvironmentSecret,
  putEnvironmentSecret,
} from "./secrets/environment-secrets.js";
import type { PlatformContext } from "./platform-support.js";

/**
 * How the store binds a command to its context. The store passes its bucket fence and route refresh here, so
 * platform commands run through the same router wrapper as every spine command.
 */
export type BindCommand = <Result>(
  command: (context: PlatformContext, input: unknown) => Promise<Result>,
) => (input: unknown) => Promise<Result>;

/**
 * Typed commands of contexts H to L. Nothing here accepts SQL.
 *
 * `secrets` and `domains` are ordinary authority: each names the organization (and project) it works on.
 * `maintenance` holds the global sweep of the domain reservation saga, which scans the whole directory for
 * expired reservations; it belongs to the scheduler and is reached only through `MaintenanceRuntime`.
 */
export function createPlatformCommands(bind: BindCommand) {
  return Object.freeze({
    secrets: Object.freeze({
      readApiEnvironmentSecrets: bind(readApiEnvironmentSecrets),
      mutateApiEnvironmentSecret: bind(mutateApiEnvironmentSecret),
      putEnvironmentSecret: bind(putEnvironmentSecret),
      ensureEnvironmentSecret: bind(ensureEnvironmentSecret),
      mutateEnvironmentSecret: bind(mutateEnvironmentSecret),
      listEnvironmentSecrets: bind(listEnvironmentSecrets),
      authorizeProviderEnvironmentSecret: bind(authorizeProviderEnvironmentSecret),
    }),
    domains: Object.freeze({
      claimCloudflareProjectDomainsOperation: bind(claimCloudflareProjectDomainsOperation),
      putCloudflareProjectDomains: bind(putCloudflareProjectDomains),
      readCloudflareProjectDomains: bind(readCloudflareProjectDomains),
      readCloudflareProjectDomainsForOperation: bind(readCloudflareProjectDomainsForOperation),
      readCloudflareProjectDomainsByIdempotency: bind(readCloudflareProjectDomainsByIdempotency),
      putCloudflareProjectDomainReceipt: bind(putCloudflareProjectDomainReceipt),
      readCloudflareProjectDomainReceipts: bind(readCloudflareProjectDomainReceipts),
      readCloudflareProjectDomainDeletionState: bind(readCloudflareProjectDomainDeletionState),
      markCloudflareProjectDomainsDeletedForDeletion: bind(
        markCloudflareProjectDomainsDeletedForDeletion,
      ),
    }),
    maintenance: Object.freeze({
      settleDomainReservations: bind(settleDomainReservations),
    }),
  });
}
