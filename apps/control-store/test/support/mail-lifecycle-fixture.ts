import { newUlid } from "../../src/catalog/common.js";
import type { ControlStore } from "../../src/store.js";
import { storedTimestamp } from "../../src/timestamps.js";
import type { TestControl } from "./control-d1.js";
import { fundOrganization } from "./mail-events-fixture.js";
import type { SeededProject } from "./platform-fixtures.js";

export const sha = (character: string) => character.repeat(64);

/** The Mail scope of a seeded project: its production environment. */
export const mailScopeOf = (project: SeededProject) => ({
  organizationId: project.organizationId,
  projectId: project.projectId,
  environmentId: project.prodEnvironmentId,
});

export const stored = (instant: string) => storedTimestamp(instant);

/** The first row of a query against the core database, for asserting persisted state. */
export const rowOf = (control: TestControl, sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

/**
 * A live legacy Resend domain of the project's production environment. The trigger `mirror_legacy_workspace_mail`
 * writes the matching workspace sender and the legacy project binding; they are never inserted by hand.
 */
export async function seedLegacyMailDomain(control: TestControl, project: SeededProject) {
  const domainId = newUlid(),
    domain = `legacy-${domainId.slice(-10).toLowerCase()}.example.com`;
  await control.core
    .prepare(
      "INSERT INTO resend_mail_domains(domain_id,organization_id,project_id,environment_id,domain,configured_at) VALUES(?1,?2,?3,?4,?5,?6)",
    )
    .bind(
      domainId,
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      domain,
      storedTimestamp(new Date().toISOString()),
    )
    .run();
  return { domainId, domain };
}

/**
 * A funded organization's workspace sender created through the store, made ready the way the provider phases leave
 * it, and bound to the project behind a verified same-domain proof that expires `proofLifetimeMs` from now.
 */
export async function seedSharedMailBinding(
  control: TestControl,
  store: ControlStore,
  project: SeededProject,
  proofLifetimeMs = 86_400_000,
) {
  const now = new Date().toISOString(),
    { organizationId, projectId } = project,
    domainId = newUlid(),
    domain = `shared-${domainId.slice(-10).toLowerCase()}.example.com`,
    request = (key: string) => ({
      organizationId,
      idempotencyKey: key,
      principalId: "user:fixture",
      requestSha256: sha("a"),
      now,
    });
  await fundOrganization(control, organizationId, now);
  await control.core
    .prepare(
      "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
    )
    .bind(storedTimestamp(now))
    .run();
  await store.sharedMail.createDomain({ ...request("create"), domainId, domain });
  await control.core
    .prepare(
      "UPDATE workspace_mail_domains SET sending_status='ready',provider_domain_id=?3,sending_key_id=?4,sending_key_ciphertext=zeroblob(32),sending_key_nonce=zeroblob(12),sending_key_sha256=zeroblob(32),sending_key_version=1 WHERE organization_id=?1 AND domain_id=?2",
    )
    .bind(organizationId, domainId, `provider_${domainId}`, `key_${domainId}`)
    .run();
  await control.core
    .prepare(
      "INSERT INTO project_application_domain_identities(project_id,organization_id,hostname,registrable_domain,revision,state,challenge_name,challenge_value,declared_at,verified_at,expires_at,idempotency_key_sha256,request_sha256,actor_id) VALUES(?1,?2,'app.example.com','example.com',1,'verified','_omh-project.app.example.com',?3,?4,?4,?5,zeroblob(32),zeroblob(32),'user:fixture')",
    )
    .bind(
      projectId,
      organizationId,
      "a".repeat(43),
      storedTimestamp(now),
      storedTimestamp(new Date(Date.parse(now) + proofLifetimeMs).toISOString()),
    )
    .run();
  await store.sharedMail.bindProject({
    ...request("bind"),
    ...mailScopeOf(project),
    domainId,
    sending: true,
    senderAddresses: [`hello@${domain}`],
    defaultFrom: `hello@${domain}`,
    defaultReplyTo: null,
  });
  return { domainId, domain, now };
}
