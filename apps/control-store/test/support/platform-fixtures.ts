import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { bucketOf } from "../../src/router.js";
import { organizationIdWithShard, shardOf, type TestControl } from "./control-d1.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const NOW = "2026-10-28T10:00:00.000Z";
export const STORED_NOW = "2026-10-28T10:00:00.000000Z";

/** A valid ULID that is unique per (label, number); not time ordered, which no store logic depends on. */
export function ulidOf(label: string, number: number): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_007;
  let tail = "";
  let rest = hash * 10_000 + number;
  for (let position = 0; position < 25; position += 1) {
    tail = ALPHABET[rest % 32] + tail;
    rest = Math.floor(rest / 32);
  }
  return `0${tail}`;
}

export function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

export interface SeededProject {
  readonly organizationId: string;
  readonly projectId: string;
  readonly devEnvironmentId: string;
  readonly prodEnvironmentId: string;
  readonly billingEpochId: string;
  readonly handle: string;
  readonly shard: D1Database;
}

/** What the accepted-operation seeds need of a project: its ids and the one core database. */
export type ProjectScope = Pick<
  SeededProject,
  "organizationId" | "projectId" | "billingEpochId" | "shard"
>;

let counter = 100;

/**
 * An organization with one active project, an open billing epoch, a dev and a prod environment and their
 * secret delivery states (or only Prod with `prodOnly`), written as raw rows in the
 * lane-one tables, because those are the foreign-key targets of the platform tables.
 */
export async function seedProject(
  control: TestControl,
  options: { shard?: number; handle?: string; prodOnly?: boolean } = {},
): Promise<SeededProject> {
  counter += 1;
  const n = counter;
  const shardIndex = options.shard ?? 0;
  const organizationId = await organizationIdWithShard(
    Object.keys(control.shards).length,
    shardIndex,
    n * 7919,
  );
  const shard = shardOf(control, shardIndex);
  const projectId = ulidOf("project", n);
  const devEnvironmentId = ulidOf("dev", n);
  const prodEnvironmentId = ulidOf("prod", n);
  const billingEpochId = ulidOf("epoch", n);
  const handle = options.handle ?? `app-${n}`;
  await control.directory.batch([
    control.directory
      .prepare(
        "INSERT INTO org_directory(organization_id, workos_organization_id, bucket, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)",
      )
      .bind(organizationId, `org_fixture${n}`, await bucketOf(organizationId), STORED_NOW),
    control.directory
      .prepare(
        "INSERT INTO project_directory(project_id, organization_id, handle, state, created_at) VALUES (?1, ?2, ?3, 'active', ?4)",
      )
      .bind(projectId, organizationId, handle, STORED_NOW),
  ]);
  await shard.batch([
    shard
      .prepare(
        "INSERT INTO organizations(organization_id, workos_organization_id, state, mapping_revision, snapshot_sha256, snapshot_fetched_at, synchronized_at, created_at, updated_at, bucket) VALUES (?1, ?2, 'active', 1, ?3, ?4, ?4, ?4, ?4, ?5)",
      )
      .bind(
        organizationId,
        `org_fixture${n}`,
        bytes(32, 1),
        STORED_NOW,
        await bucketOf(organizationId),
      ),
    shard
      .prepare(
        "INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode, region, dev_access_mode, created_at, updated_at) VALUES (?1, ?2, ?1, 'Fixture', ?3, ?4, 'customer-chosen-v1', 0, 'active', 1, 'active', 1, ?5, 'shared', 'eu', 'protected', ?6, ?6)",
      )
      .bind(organizationId, projectId, ulidOf("event", n), handle, billingEpochId, STORED_NOW),
    shard
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:fixture')",
      )
      .bind(organizationId, billingEpochId, projectId, STORED_NOW),
    ...(options.prodOnly
      ? [["prod", prodEnvironmentId]]
      : [
          ["dev", devEnvironmentId],
          ["prod", prodEnvironmentId],
        ]
    ).map(([name, id]) =>
      shard
        .prepare(
          "INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '{}', 0, 1, ?5, ?5)",
        )
        .bind(organizationId, id, projectId, name, STORED_NOW),
    ),
    ...(options.prodOnly ? [prodEnvironmentId] : [devEnvironmentId, prodEnvironmentId]).map((id) =>
      shard
        .prepare(
          "INSERT INTO runtime_secret_delivery_states(organization_id, project_id, environment_id, desired_generation, applied_generation, applied_secret_names, applied_secret_count, next_release_sequence, applied_release_sequence, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '[]', 0, 1, 0, ?4, ?4)",
        )
        .bind(organizationId, projectId, id, STORED_NOW),
    ),
  ]);
  await admitConsentingUser(control, organizationId, "user_consent");
  return {
    organizationId,
    projectId,
    devEnvironmentId,
    prodEnvironmentId,
    billingEpochId,
    handle,
    shard,
  };
}

/**
 * Admits `user:<workosUser>` as an active owner of the organization, as the consenting principal of a grant needs to be
 * (a grant reaches DNS only while its principal holds project write authority). Idempotent.
 */
export async function admitConsentingUser(
  control: TestControl,
  organizationId: string,
  workosUser: string,
) {
  const db = control.core;
  await db.batch([
    db
      .prepare(
        "UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1 AND beta_admitted_at IS NULL",
      )
      .bind(organizationId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO organization_memberships(organization_id, workos_user_id, role, state, mapping_revision, snapshot_sha256, effective_at, trigger_event_id) SELECT ?1, ?2, 'admin', 'active', 1, ?3, ?4, 'evt' WHERE NOT EXISTS(SELECT 1 FROM organization_memberships WHERE organization_id=?1 AND workos_user_id=?2)",
      )
      .bind(organizationId, workosUser, bytes(32, 7), STORED_NOW),
    db
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id, grant_id, project_id, environment_id, principal_kind, principal_id, role, created_at) SELECT ?1, ?2, NULL, NULL, 'user', ?3, 'owner', ?4 WHERE NOT EXISTS(SELECT 1 FROM local_authorization_grants WHERE organization_id=?1 AND principal_id=?3 AND role='owner' AND project_id IS NULL AND environment_id IS NULL)",
      )
      .bind(
        organizationId,
        grantIdFor(organizationId, workosUser),
        `user:${workosUser}`,
        STORED_NOW,
      ),
  ]);
}

/** A deterministic ULID for the authority grant of one organization and user. */
function grantIdFor(organizationId: string, workosUser: string): string {
  return ulidOf(`grant-${organizationId}-${workosUser}`, 1);
}

/** Marks the project as no longer active for new writes (frozen ownership). */
export async function freezeOwnership(project: SeededProject): Promise<void> {
  await project.shard
    .prepare(
      "UPDATE projects SET owner_state = 'security_frozen' WHERE organization_id = ? AND project_id = ?",
    )
    .bind(project.organizationId, project.projectId)
    .run();
}

/**
 * Interleaving at the D1 boundary: `hook` runs once, right before the first write batch reaches the database, i.e.
 * after the command read its snapshot and finished its directory work but before its shard write commits.
 */
export function beforeFirstWrite(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true;
  const wrap = (
    inner: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement & { inner: D1PreparedStatement; sql: string } => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: (...args: []) => inner.first(...args),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as unknown as { inner: D1PreparedStatement; sql: string }[];
      if (
        pending &&
        wrapped.some((statement) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(statement.sql))
      ) {
        pending = false;
        await hook();
      }
      return db.batch(wrapped.map((statement) => statement.inner));
    },
  };
}

/**
 * Failure injection at the D1 boundary: the Nth write batch commits, then its response is lost, `times`
 * times. Read-only batches (the command's snapshot reads) pass untouched.
 */
export function losingWriteResponses(db: D1Database, times: number): D1Database {
  let remaining = times;
  const wrap = (
    inner: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement & { inner: D1PreparedStatement; sql: string } => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: (...args: []) => inner.first(...args),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as unknown as { inner: D1PreparedStatement; sql: string }[];
      const results = await db.batch(wrapped.map((statement) => statement.inner));
      if (
        remaining > 0 &&
        wrapped.some((statement) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(statement.sql))
      ) {
        remaining -= 1;
        throw new Error("Network connection lost");
      }
      return results;
    },
  };
}
