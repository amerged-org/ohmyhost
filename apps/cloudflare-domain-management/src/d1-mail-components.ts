import { classifyMailDomain, type SystemClock, type createUlidFactory } from "@ohmyhost/platform";
import {
  parseScopedDnsDelegation,
  parseLegacyProductionScopedDnsDelegation,
} from "./scoped-dns-authorization.js";
import type { CloudflareCustomerDnsProvider } from "@ohmyhost/provider-cloudflare";
import {
  createD1ScopedDnsAuthorizationRuntime,
  type ScopedDnsAuthorizationRuntime,
} from "./d1-scoped-dns-authorization.js";
import { createD1ScopedDnsPersistence } from "./d1-scoped-dns-persistence.js";
import { createD1ApplicationIdentityPersistence } from "./d1-application-identity.js";
import { createD1MailDnsPersistence } from "./d1-mail-dns-persistence.js";
import {
  createApplicationDomainIdentityRuntime,
  observeApplicationIdentityTxt,
} from "./application-domain-identity.js";
import { createResendDns } from "./resend-dns.js";
import { openDeletionDnsAccess, type createCloudflareProjectDeletion } from "./project-deletion.js";
import type { CustomerDomainDns } from "./paid-domains.js";
import type { createCloudflareDomainSecrets } from "./secrets.js";
import type { CloudflareCustomerOAuthProvider } from "./runtime.js";

/** The exact Mail subset of D1CloudflareCompositionContext; the general runtime owns all other fields and ports. */
export interface D1MailCompositionContext {
  readonly identityPolicy?: Parameters<
    typeof createApplicationDomainIdentityRuntime
  >[0]["identityPolicy"];
  readonly parseDelegation?: typeof parseScopedDnsDelegation;
  bindings: {
    readonly SCOPED_DNS_RUNTIME: unknown;
    readonly APPLICATION_IDENTITY_RUNTIME: unknown;
    readonly MAIL_DNS_RUNTIME: unknown;
  };
  clock: SystemClock;
  ids: ReturnType<typeof createUlidFactory>;
  secrets: ReturnType<typeof createCloudflareDomainSecrets>;
  oauth: CloudflareCustomerOAuthProvider;
  providerForUse(beforeRequest: () => Promise<void>): CloudflareCustomerDnsProvider;
  customerDns: CustomerDomainDns;
  deletionDependencies: Parameters<typeof createCloudflareProjectDeletion>[0];
}
export async function createD1MailComponents(context: D1MailCompositionContext): Promise<{
  scopedDns: ScopedDnsAuthorizationRuntime;
  identities: ReturnType<typeof createApplicationDomainIdentityRuntime>;
  resendDns: ReturnType<typeof createResendDns>;
}> {
  const [scoped, identity, mail] = await Promise.all([
    createD1ScopedDnsPersistence(context.bindings.SCOPED_DNS_RUNTIME, context.parseDelegation),
    createD1ApplicationIdentityPersistence(context.bindings.APPLICATION_IDENTITY_RUNTIME),
    createD1MailDnsPersistence(context.bindings.MAIL_DNS_RUNTIME),
  ]);
  const scopedDns = await createD1ScopedDnsAuthorizationRuntime({
    persistence: scoped,
    ...(context.parseDelegation === undefined ? {} : { parseDelegation: context.parseDelegation }),
    clock: context.clock,
    ids: context.ids,
    ...context.secrets,
    oauth: context.oauth,
    providerForUse: (beforeRequest) => context.providerForUse(beforeRequest),
  });
  const identities = createApplicationDomainIdentityRuntime({
    persistence: identity,
    ...(context.identityPolicy === undefined ? {} : { identityPolicy: context.identityPolicy }),
    ...(context.parseDelegation === undefined ? {} : { parseDelegation: context.parseDelegation }),
    clock: context.clock,
    observeTxt: (name, value) =>
      observeApplicationIdentityTxt(
        (request, init) => globalThis.fetch(request, init),
        name,
        value,
      ),
    ensureChallenge: (scope) => scopedDns.ensureApplicationIdentityChallenge(scope),
  });
  const resendDns = createResendDns({
    persistence: mail,
    clock: context.clock,
    dns: context.customerDns,
    workspaceDns: scopedDns,
    deletionAccess: (scope) => openDeletionDnsAccess(context.deletionDependencies, scope),
  });
  return { scopedDns, identities, resendDns };
}

/** Closed legacy adapters preserve the old Production classifier and delegation vocabulary. */
export function createLegacyProductionD1MailComponents(context: D1MailCompositionContext) {
  return createD1MailComponents({
    ...context,
    identityPolicy: { classify: classifyMailDomain },
    parseDelegation: parseLegacyProductionScopedDnsDelegation,
  });
}
