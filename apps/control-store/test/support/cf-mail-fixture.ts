import type { D1Database } from "../../src/d1-types.js";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import type { TestControl } from "./control-d1.js";
import { bytes, seedProject, STORED_NOW, type SeededProject } from "./platform-fixtures.js";
import { seedDeletionIntent, seedOperation } from "./accepted-operation.js";

/** The private Cloudflare domain-management Worker's side of Core: the three stores it binds. */
export type CfStore = ReturnType<typeof createControlStore>;

/** A 64-character lowercase hex digest filled with one byte, the wire form of the idempotency and request hashes. */
export const hex = (fill: number): string => fill.toString(16).padStart(2, "0").repeat(32);

/** `offsetMs` from `base`, as the millisecond ISO string the commands accept; the database clock is the real one. */
export const isoAt = (base: number, offsetMs: number): string =>
  new Date(base + offsetMs).toISOString();

/** The stored (microsecond) form of an instant. */
export const stored = (base: number, offsetMs: number): string =>
  `${isoAt(base, offsetMs).slice(0, 23)}000Z`;

let sequence = 0;
export const nextNumber = (): number => (sequence += 1);

export interface CfFixture {
  readonly project: SeededProject;
  readonly db: D1Database;
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly principalId: string;
}

/**
 * An organization admitted to the beta whose admin holds the organization-level owner grant: the exact original
 * authority the Cloudflare Worker's actor needs, on a project with an active billing epoch.
 */
export async function cfFixture(control: TestControl): Promise<CfFixture> {
  const project = await seedProject(control);
  const n = nextNumber();
  const userId = `user_cf${n}`;
  const principalId = `user:${userId}`;
  const db = project.shard;
  await db.batch([
    db
      .prepare("UPDATE organizations SET beta_admitted_at = ?2 WHERE organization_id = ?1")
      .bind(project.organizationId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO organization_memberships(organization_id, workos_user_id, role, state, mapping_revision, snapshot_sha256, effective_at, trigger_event_id) VALUES (?1, ?2, 'admin', 'active', 1, ?3, ?4, 'evt')",
      )
      .bind(project.organizationId, userId, bytes(32, 1), STORED_NOW),
    db
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id, grant_id, project_id, environment_id, principal_kind, principal_id, role, created_at) VALUES (?1, ?2, NULL, NULL, 'user', ?3, 'owner', ?4)",
      )
      .bind(project.organizationId, newUlid(), principalId, STORED_NOW),
  ]);
  return {
    project,
    db,
    organizationId: project.organizationId,
    projectId: project.projectId,
    userId,
    principalId,
  };
}

/** The terminal revocation of the actor's user: every authority predicate of the module stops holding. */
export async function revokeUser(f: CfFixture): Promise<void> {
  await f.db
    .prepare(
      "INSERT INTO revocations(kind, resource_id, source_event_id, effective_at) VALUES ('user', ?1, ?2, ?3)",
    )
    .bind(f.userId, newUlid(), STORED_NOW)
    .run();
}

/** A customer website hostname of the project (globally unique), the fact the application identity must agree with. */
export async function seedWebsite(f: CfFixture): Promise<string> {
  const hostname = `app${nextNumber()}.example.com`;
  await f.db
    .prepare(
      "INSERT INTO paid_project_domains(organization_id, project_id, hostname, gateway_script_name, state, configured_by_principal_id, apply_idempotency_sha256, apply_request_sha256, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'awaiting_deployment', ?4, ?5, ?5, ?6, ?6)",
    )
    .bind(f.organizationId, f.projectId, hostname, f.principalId, bytes(32, 7), STORED_NOW)
    .run();
  return hostname;
}

export interface WorkspaceDomain {
  readonly domainId: string;
  readonly domain: string;
}

/** A workspace mail domain of the organization, custodied by the fixture's project. Receipts default to an empty object. */
export async function seedWorkspaceDomain(
  f: CfFixture,
  options: {
    readonly domain?: string;
    readonly status?: "active" | "retiring";
    readonly receipts?: unknown;
    /** A provider domain and a capability lease that is current on the real clock. */
    readonly provisioned?: boolean;
  } = {},
): Promise<WorkspaceDomain> {
  const domainId = newUlid();
  const domain = options.domain ?? `m${nextNumber()}.example.com`;
  const now = Date.now();
  await f.db
    .prepare(
      "INSERT INTO workspace_mail_domains(domain_id, organization_id, domain, registrable_domain, custody_organization_id, custody_project_id, custody_environment_id, status, provider_domain_id, capabilities_lease_until, records, dns_receipts, configured_at) VALUES (?1, ?2, ?3, 'example.com', ?2, ?4, ?5, ?6, ?7, ?8, '[{\"name\":\"workspace\"}]', ?9, ?10)",
    )
    .bind(
      domainId,
      f.organizationId,
      domain,
      f.projectId,
      f.project.prodEnvironmentId,
      options.status ?? "active",
      options.provisioned === true ? `provider-${domainId}` : null,
      options.provisioned === true ? stored(now, 60_000) : null,
      JSON.stringify(options.receipts ?? {}),
      STORED_NOW,
    )
    .run();
  return { domainId, domain };
}

/** The active sending binding of the project to a workspace domain, over its verified application identity. */
export async function seedBinding(
  f: CfFixture,
  workspace: WorkspaceDomain,
  identityRevision: number,
): Promise<void> {
  const sender = `hello@${workspace.domain}`;
  await f.db.batch([
    f.db
      .prepare(
        "INSERT OR IGNORE INTO shared_mail_capabilities(capability, enabled, cohort_revision, activated_at) VALUES ('same-domain-sharing-v1', 1, 'fixture', ?1)",
      )
      .bind(STORED_NOW),
    f.db
      .prepare(
        "INSERT INTO project_mail_domain_bindings(project_id, organization_id, environment_id, mail_domain_id, state, sending, legacy, sender_addresses, default_from, application_identity_revision, configured_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', 1, 0, ?5, ?6, ?7, ?8, ?8)",
      )
      .bind(
        f.projectId,
        f.organizationId,
        f.project.prodEnvironmentId,
        workspace.domainId,
        JSON.stringify([sender]),
        sender,
        identityRevision,
        STORED_NOW,
      ),
  ]);
}

/** The retirement claim of a workspace domain: the live command lease the cleanup reads require. */
export async function seedRetirementClaim(f: CfFixture, domainId: string): Promise<void> {
  await f.db
    .prepare(
      "INSERT INTO workspace_mail_commands(organization_id, idempotency_key, domain_id, operation, principal_id, request_sha256, response, created_at, lease_until, claimed_attempt) VALUES (?1, ?2, ?3, 'retire', ?4, ?5, NULL, ?6, ?7, 1)",
    )
    .bind(
      f.organizationId,
      `retire-${domainId}`,
      domainId,
      f.principalId,
      bytes(32, 9),
      STORED_NOW,
      stored(Date.now(), 60_000),
    )
    .run();
}

/** The project's legacy prod resend domain; Core mirrors it into the workspace row and the legacy binding of the same id. */
export async function seedLegacyDomain(f: CfFixture, receipts: unknown = {}): Promise<string> {
  const domainId = newUlid();
  await f.db
    .prepare(
      'INSERT INTO resend_mail_domains(domain_id, organization_id, project_id, environment_id, domain, provider_domain_id, records, dns_receipts, configured_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \'[{"name":"legacy"}]\', ?7, ?8)',
    )
    .bind(
      domainId,
      f.organizationId,
      f.projectId,
      f.project.prodEnvironmentId,
      `legacy${nextNumber()}.example.com`,
      `provider-${domainId}`,
      JSON.stringify(receipts),
      STORED_NOW,
    )
    .run();
  return domainId;
}

/** A queued project deletion with its immutable intent: what the deletion requirements read joins. */
export async function seedProjectDeletion(f: CfFixture): Promise<string> {
  const operationId = await seedOperation(f.project, { state: "running" });
  await seedDeletionIntent(f.project, f.project.prodEnvironmentId, operationId);
  await f.db
    .prepare(
      "UPDATE projects SET lifecycle_state = 'deleting', lifecycle_version = lifecycle_version + 1 WHERE organization_id = ?1 AND project_id = ?2",
    )
    .bind(f.organizationId, f.projectId)
    .run();
  return operationId;
}

/** Declares a pending application identity for the fixture's project through the real command. */
export async function declareIdentity(
  store: CfStore,
  f: CfFixture,
  options: { readonly hostname?: string; readonly key?: number; readonly request?: number } = {},
) {
  const now = Date.now(),
    n = nextNumber();
  return store.cfApplicationIdentity.declare({
    organizationId: f.organizationId,
    projectId: f.projectId,
    actorId: f.principalId,
    idempotencyKeySha256: hex(options.key ?? 0x20 + n),
    requestSha256: hex(options.request ?? 0x40),
    delegation: null,
    hostname: options.hostname ?? "www.example.com",
    registrableDomain: "example.com",
    challengeValue: `omh-domain-v1=${"A".repeat(43)}`,
    declaredAt: isoAt(now, 0),
    expiresAt: isoAt(now, 3_600_000),
  });
}
