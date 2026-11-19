import { createEnvironmentSecretCipher, parseUlid } from "@ohmyhost/platform";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { fundOrganization } from "./mail-events-fixture.js";
import type { TestControl } from "./control-d1.js";
import type { SeededProject } from "./platform-fixtures.js";

export const MAIL_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 0x63).toString("base64");

/**
 * One live legacy (project-owned) Resend mail domain written straight into the shared Core, with a really sealed
 * sending key. The mirror trigger of the schema creates the workspace row and the project binding, exactly as the
 * Core commands leave them. No PostgreSQL oracle is involved.
 */
export async function seedReadyMailDomain(
  control: TestControl,
  project: SeededProject,
  options: {
    receiving?: boolean;
    sendingStatus?: "ready" | "pending";
    domain?: (domainId: string) => string;
    now?: string;
  } = {},
) {
  const now = options.now ?? "2026-10-29T10:00:00.000Z",
    domainId = newUlid(),
    domain = options.domain?.(domainId) ?? `mail-${domainId.slice(-10).toLowerCase()}.example.com`,
    scope = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
      environmentId: parseUlid(project.prodEnvironmentId),
    },
    providerKey = `re_fixture_${domainId}`,
    sealed = await createEnvironmentSecretCipher({
      keyBase64: MAIL_KEY_ENCRYPTION_KEY,
      keyVersion: 1,
      crypto: globalThis.crypto,
    }).encrypt({ ...scope, name: "RESEND_DOMAIN_SEND_KEY", value: providerKey }),
    receiving = options.receiving ?? true,
    stored = storedTimestamp(now);
  await control.core
    .prepare(
      `INSERT INTO resend_mail_domains(domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,
        sending_key_id,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending,receiving,
        receiving_suspended,sending_status,receiving_status,webhook_url,webhook_verified_at,configured_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,0,?13,?14,?15,?16,?17)`,
    )
    .bind(
      domainId,
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      domain,
      `provider_${domainId}`,
      `key_${domainId}`,
      sealed.ciphertext,
      sealed.nonce,
      sealed.valueSha256,
      sealed.keyVersion,
      Number(receiving),
      options.sendingStatus ?? "ready",
      receiving ? "ready" : "disabled",
      receiving ? "https://receiver.example.com/mail" : null,
      receiving ? stored : null,
      stored,
    )
    .run();
  return { domainId, domain, providerKey, providerDomainId: `provider_${domainId}`, scope, now };
}

/** The shared Resend rate card and both mail meters, once per Core; and Paid access with credit for one organization. */
export { publishMailPricing as publishMailRates } from "./mail-events-fixture.js";
export const fundMail = (control: TestControl, organizationId: string) =>
  fundOrganization(control, organizationId, "2026-10-01T00:00:00.000Z");

/** A native workspace sender with no provider resource yet (no legacy project domain, no binding). */
export async function seedNativeWorkspaceDomain(
  control: TestControl,
  project: SeededProject,
  now = "2026-10-29T10:00:00.000Z",
) {
  const domainId = newUlid(),
    domain = `native-${domainId.slice(-10).toLowerCase()}.example.com`;
  await control.core
    .prepare(
      `INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,registrable_domain,custody_organization_id,
        custody_project_id,custody_environment_id,status,sending_status,configured_at)
       VALUES(?1,?2,?3,'example.com',?2,?4,?5,'active','pending',?6)`,
    )
    .bind(
      domainId,
      project.organizationId,
      domain,
      project.projectId,
      project.prodEnvironmentId,
      storedTimestamp(now),
    )
    .run();
  return { domainId, domain, organizationId: project.organizationId };
}

/**
 * A native sender (no legacy project domain) with a sealed key, bound to the project through a verified application
 * identity that expires at `identityExpiresAt`: the shape the scheduled identity revalidation selects.
 */
export async function seedBoundNativeSender(
  control: TestControl,
  project: SeededProject,
  identityExpiresAt: string,
  now = "2026-10-29T10:00:00.000Z",
) {
  const domainId = newUlid(),
    domain = `bound-${domainId.slice(-10).toLowerCase()}.example.com`,
    scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
    },
    sealed = await createEnvironmentSecretCipher({
      keyBase64: MAIL_KEY_ENCRYPTION_KEY,
      keyVersion: 1,
      crypto: globalThis.crypto,
    }).encrypt({ ...scope, name: "RESEND_DOMAIN_SEND_KEY", value: `re_bound_${domainId}` }),
    stored = storedTimestamp(now);
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'synthetic-mail-fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
      )
      .bind(stored),
    control.core
      .prepare(
        `INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,registrable_domain,custody_organization_id,
          custody_project_id,custody_environment_id,status,sending_status,configured_at,provider_domain_id,
          sending_key_id,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version)
         VALUES(?1,?2,?3,'example.com',?2,?4,?5,'active','ready',?6,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        domainId,
        scope.organizationId,
        domain,
        scope.projectId,
        scope.environmentId,
        stored,
        `provider_${domainId}`,
        `key_${domainId}`,
        sealed.ciphertext,
        sealed.nonce,
        sealed.valueSha256,
        sealed.keyVersion,
      ),
    control.core
      .prepare(
        `INSERT INTO project_application_domain_identities(project_id,organization_id,hostname,registrable_domain,revision,
          state,challenge_name,challenge_value,declared_at,verified_at,expires_at,idempotency_key_sha256,request_sha256,actor_id)
         VALUES(?1,?2,'app.example.com','example.com',1,'verified','_omh-project.app.example.com',?3,?4,?4,?5,?6,?7,'user:fixture')`,
      )
      .bind(
        scope.projectId,
        scope.organizationId,
        `omh-domain-v1=${"a".repeat(43)}`,
        stored,
        storedTimestamp(identityExpiresAt),
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      ),
    control.core
      .prepare(
        `INSERT INTO project_mail_domain_bindings(project_id,organization_id,environment_id,mail_domain_id,revision,state,
          sending,legacy,sender_addresses,default_from,application_identity_revision,configured_at,updated_at)
         VALUES(?1,?2,?3,?4,1,'active',1,0,?5,?6,1,?7,?7)`,
      )
      .bind(
        scope.projectId,
        scope.organizationId,
        scope.environmentId,
        domainId,
        JSON.stringify([`hello@${domain}`]),
        `hello@${domain}`,
        stored,
      ),
  ]);
  return { domainId, domain, scope, providerDomainId: `provider_${domainId}` };
}
