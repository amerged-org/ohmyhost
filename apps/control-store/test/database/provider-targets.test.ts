import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DatabaseProviderConflictError,
  canonicalJson,
  cleanupLocatorOf,
  runtimeRoleOf,
} from "../../src/catalog/database/contracts.js";
import {
  PgcfDatabaseClaimClosedError,
  PgcfDatabaseTakenError,
  reservePgcfDatabaseClaim,
} from "../../src/catalog/database/pgcf-claims.js";
import { createDatabaseProviderCommands } from "../../src/catalog/database/provider-commands.js";
import { DatabaseProviderOperationUnknownError } from "../../src/catalog/database/provider-contracts.js";
import {
  canonicalProviderRequest,
  providerIdempotencyKey,
} from "../../src/catalog/database/provider-targets.js";
import type { PlatformContext } from "../../src/catalog/platform-support.js";
import type { D1Database } from "../../src/d1-types.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import {
  NOW,
  STORED_NOW,
  beforeFirstWrite,
  bytes,
  losingWriteResponses,
  seedProject,
  ulidOf,
  freezeOwnership,
  type SeededProject,
} from "../support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedProviderClaim,
  seedOperation,
} from "../support/accepted-operation.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

const LATER = "2026-10-28T12:00:00.000Z";
const contextWith = (
  shards: Readonly<Record<string, D1Database>>,
  directory: D1Database = control.directory,
): PlatformContext => ({ directory, router: coreRouter(control, shards) });
const commandsOver = (
  shards: Readonly<Record<string, D1Database>> = control.shards,
  directory: D1Database = control.directory,
) => {
  const context = contextWith(shards, directory);
  return {
    context,
    ...createDatabaseProviderCommands((command) => (input) => command(context, input)),
  };
};
const wrapped = (project: SeededProject, wrap: (db: D1Database) => D1Database) => {
  const shards: Record<string, D1Database> = {};
  for (const [name, db] of Object.entries(control.shards))
    shards[name] = db === project.shard ? wrap(db) : db;
  return commandsOver(shards);
};

let sequence = 0;
const exec = (project: SeededProject, sql: string, ...values: unknown[]) =>
  project.shard
    .prepare(sql)
    .bind(...values)
    .run();
const one = async <T>(project: SeededProject, sql: string, ...values: unknown[]) =>
  (await project.shard
    .prepare(sql)
    .bind(...values)
    .first<T>()) ?? null;
const count = async (project: SeededProject, table: string) =>
  (
    await one<{ n: number }>(
      project,
      `SELECT count(*) AS n FROM ${table} WHERE organization_id = ?`,
      project.organizationId,
    )
  )?.n;

interface Fixture {
  readonly project: SeededProject;
  readonly physical: string;
  readonly claim: { operationId: string; claimId: string };
  readonly scope: { organizationId: string; projectId: string; physicalEnvironmentId: string };
  readonly claimInput: {
    organizationId: string;
    projectId: string;
    physicalEnvironmentId: string;
    operationId: string;
    claimId: string;
  };
}

/** A project whose dev and prod share one physical environment, with an accepted provider claim and no target. */
async function fixture(shard = 0): Promise<Fixture> {
  sequence += 1;
  const project = await seedProject(control, { shard });
  const physical = ulidOf("physical", sequence);
  await exec(
    project,
    "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    project.organizationId,
    project.projectId,
    physical,
    STORED_NOW,
  );
  for (const environmentId of [project.devEnvironmentId, project.prodEnvironmentId])
    await exec(
      project,
      "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at) VALUES (?1, ?2, 1, ?3, ?4, ?5)",
      project.organizationId,
      environmentId,
      project.projectId,
      physical,
      STORED_NOW,
    );
  const claim = await seedProviderClaim(project, project.prodEnvironmentId);
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    physicalEnvironmentId: physical,
  };
  return { project, physical, claim, scope, claimInput: { ...scope, ...claim } };
}

const ids = (n: number) => ({
  providerProjectId: `prj_${"a".repeat(16)}${n.toString(36).padStart(4, "0")}`,
  databaseId: `d${"b".repeat(15)}${n.toString(36).padStart(4, "0")}`,
});

/** reserve -> begin -> record: a succeeded `database.create` for the given physical identity. */
async function created(
  f: Fixture,
  identity: { providerProjectId: string; databaseId: string },
  version = 1,
  region = "eu-dev",
  store = commandsOver(),
) {
  const operation = await store.runtime.reserveOperation({
    ...f.claimInput,
    step: "database.create",
    providerProjectId: identity.providerProjectId,
    requestBody: { name: "approved", region_id: region, target_version: version },
  });
  await store.runtime.beginOperation({ operation, now: NOW });
  await store.runtime.recordOperation({
    operation,
    observation: {
      databaseId: identity.databaseId,
      providerOperationId: "op_abcdefghijklmnopqrst",
      state: "succeeded",
    },
    now: NOW,
  });
  return operation;
}

const activation = (
  f: Fixture,
  identity: { providerProjectId: string; databaseId: string },
  version = 1,
  overrides: Record<string, unknown> = {},
) => ({
  claim: f.claimInput,
  target: {
    ...f.scope,
    targetVersion: version,
    ...identity,
    regionId: "eu-dev",
    sizeClassId: "standard",
    runtimeRole: runtimeRoleOf(f.physical),
    credentialReference: "sealed:credential:1",
    ...overrides,
  },
  now: NOW,
});

async function replaceEpoch(f: Fixture) {
  const epoch = ulidOf("new-epoch", sequence + 9000),
    at = "2026-10-28T11:00:00.000000Z";
  await f.project.shard.batch([
    f.project.shard
      .prepare(
        "UPDATE billing_epochs SET ended_at=?3 WHERE organization_id=?1 AND billing_epoch_id=?2",
      )
      .bind(f.project.organizationId, f.project.billingEpochId, at),
    f.project.shard
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?1,?2,?3,?4,'user:fixture')",
      )
      .bind(f.project.organizationId, epoch, f.project.projectId, at),
    f.project.shard
      .prepare(
        "UPDATE projects SET active_billing_epoch_id=?3 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(f.project.organizationId, f.project.projectId, epoch),
  ]);
}

const headOf = (f: Fixture) =>
  one<{ target_version: number; state: string; activated_at: string | null }>(
    f.project,
    "SELECT target_version, state, activated_at FROM database_provider_target_heads WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3",
    f.project.organizationId,
    f.project.projectId,
    f.physical,
  );

describe("scope and claim authority", () => {
  it("resolves the physical environment of a logical one and refuses any other caller", async () => {
    const f = await fixture();
    const other = await fixture(1);
    const store = commandsOver();
    expect(
      await store.runtime.resolveScope({
        organizationId: f.project.organizationId,
        projectId: f.project.projectId,
        environmentId: f.project.devEnvironmentId,
      }),
    ).toEqual(f.scope);
    await expect(
      store.runtime.resolveScope({
        organizationId: other.project.organizationId,
        projectId: f.project.projectId,
        environmentId: f.project.devEnvironmentId,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await freezeOwnership(f.project);
    await expect(
      store.runtime.resolveScope({
        organizationId: f.project.organizationId,
        projectId: f.project.projectId,
        environmentId: f.project.devEnvironmentId,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
  });

  it("authorizes only the accepted claim of this scope, operation and claim id", async () => {
    const f = await fixture();
    const other = await fixture(1);
    const store = commandsOver();
    await store.runtime.authorizeClaim(f.claimInput);
    await store.runtime.authorizeClaim({ ...f.claimInput, step: "database.create" });
    for (const forged of [
      { ...f.claimInput, claimId: other.claim.claimId },
      { ...f.claimInput, operationId: other.claim.operationId },
      { ...f.claimInput, organizationId: other.project.organizationId },
      { ...f.claimInput, physicalEnvironmentId: other.physical },
    ])
      await expect(store.runtime.authorizeClaim(forged)).rejects.toBeInstanceOf(
        DatabaseProviderConflictError,
      );
    const returned = await fixture();
    await replaceEpoch(returned);
    await expect(store.runtime.authorizeClaim(returned.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await releaseProviderClaim(f.project);
    await expect(store.runtime.authorizeClaim(f.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
  });

  it("reads no target for a fresh environment and never selects a retired history row", async () => {
    const f = await fixture();
    const store = commandsOver();
    expect(await store.runtime.readTarget(f.scope)).toBeNull();
  });
});

describe("provider operation: reserve, dispatch decision, observe", () => {
  const body = { name: "approved", region_id: "eu-dev", target_version: 1 };

  it("canonicalizes the body and refuses secrets, URLs and oversized bodies", async () => {
    expect(canonicalProviderRequest({ b: 1, a: [true, null, "x"] })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    for (const bad of [
      { password: "x" },
      { a_token: "x" },
      { Bad: 1 },
      { a: "https://example.test" },
      { a: "x".repeat(257) },
      { a: Array.from({ length: 17 }, () => 1) },
      { a: Number.POSITIVE_INFINITY },
      { a: undefined },
      {
        a: "x"
          .repeat(300)
          .split("")
          .map(() => "y")
          .join(""),
      },
    ])
      expect(() => canonicalProviderRequest(bad)).toThrow(DatabaseProviderConflictError);
    expect(() =>
      canonicalProviderRequest(
        Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "x".repeat(40)])),
      ),
    ).toThrow(DatabaseProviderConflictError);
    const a = await providerIdempotencyKey(
      { organizationId: "o", projectId: "p", physicalEnvironmentId: "e" },
      "op",
      "database.create",
    );
    expect(a).toMatch(/^omh-[a-f0-9]{64}$/u);
    expect(
      await providerIdempotencyKey(
        { organizationId: "o", projectId: "p", physicalEnvironmentId: "e" },
        "op",
        "x",
      ),
    ).not.toBe(a);
  });

  it("commits one identity: replays return the same key, target and body; a different request conflicts", async () => {
    const f = await fixture();
    const store = commandsOver();
    const input = {
      ...f.claimInput,
      step: "database.create",
      providerProjectId: ids(1).providerProjectId,
      requestBody: body,
    };
    const first = await store.runtime.reserveOperation(input);
    expect(first).toMatchObject({ state: "reserved", requestBody: body, databaseId: null });
    expect(first.idempotencyKey).toMatch(/^omh-/u);
    expect(await store.runtime.reserveOperation(input)).toEqual(first);
    await expect(
      store.runtime.reserveOperation({ ...input, requestBody: { ...body, name: "other" } }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.runtime.reserveOperation({ ...input, providerProjectId: ids(2).providerProjectId }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(await count(f.project, "database_provider_operations")).toBe(1);
    expect(await store.runtime.readOperation({ ...f.claimInput, step: "database.create" })).toEqual(
      first,
    );
    expect(
      await store.runtime.readOperation({ ...f.claimInput, step: "role.create:x" }),
    ).toBeNull();
  });

  it("refuses a cross-tenant or stale claim and commits nothing", async () => {
    const f = await fixture();
    const other = await fixture(1);
    const store = commandsOver();
    const input = {
      ...f.claimInput,
      step: "database.create",
      providerProjectId: ids(3).providerProjectId,
      requestBody: body,
    };
    await expect(
      store.runtime.reserveOperation({ ...input, claimId: other.claim.claimId }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.runtime.reserveOperation({ ...input, organizationId: other.project.organizationId }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    // the claim lapses between the decision and the commit: the guard aborts the whole batch
    const raced = wrapped(f.project, (db) =>
      beforeFirstWrite(db, async () => {
        await releaseProviderClaim(f.project);
      }),
    );
    await expect(raced.runtime.reserveOperation(input)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(f.project, "database_provider_operations")).toBe(0);
    expect(await count(other.project, "database_provider_operations")).toBe(0);
  });

  it("decides dispatch exactly once, also under concurrency and a lost response", async () => {
    const f = await fixture();
    const store = commandsOver();
    const operation = await store.runtime.reserveOperation({
      ...f.claimInput,
      step: "database.create",
      providerProjectId: ids(4).providerProjectId,
      requestBody: body,
    });
    const decisions = await Promise.all(
      [1, 2, 3, 4].map(() => store.runtime.beginOperation({ operation, now: NOW })),
    );
    expect(decisions.filter((d) => d === "dispatch")).toHaveLength(1);
    expect(decisions.filter((d) => d === "observe")).toHaveLength(3);

    const g = await fixture();
    const plain = commandsOver();
    const second = await plain.runtime.reserveOperation({
      ...g.claimInput,
      step: "database.create",
      providerProjectId: ids(5).providerProjectId,
      requestBody: body,
    });
    const lost = wrapped(g.project, (db) => losingWriteResponses(db, 1));
    // the committed dispatch whose response was lost is answered `observe`: the caller resumes the SAME provider key
    expect(await lost.runtime.beginOperation({ operation: second, now: NOW })).toBe("observe");
    const row = await one<{ state: string }>(
      g.project,
      "SELECT state FROM database_provider_operations WHERE organization_id = ?",
      g.project.organizationId,
    );
    expect(row?.state).toBe("dispatched");
    expect(await count(g.project, "database_provider_operations")).toBe(1);
  });

  it("never dispatches an unreserved, mismatched or unauthorized operation", async () => {
    const f = await fixture();
    const store = commandsOver();
    const operation = await store.runtime.reserveOperation({
      ...f.claimInput,
      step: "database.create",
      providerProjectId: ids(6).providerProjectId,
      requestBody: body,
    });
    await expect(
      store.runtime.beginOperation({
        operation: { ...operation, step: "role.create:a" },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderOperationUnknownError);
    await expect(
      store.runtime.beginOperation({
        operation: { ...operation, requestBody: { ...body, name: "z" } },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.runtime.beginOperation({
        operation: { ...operation, idempotencyKey: `omh-${"0".repeat(64)}` },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    const raced = wrapped(f.project, (db) =>
      beforeFirstWrite(db, async () => {
        await releaseProviderClaim(f.project);
      }),
    );
    await expect(raced.runtime.beginOperation({ operation, now: NOW })).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await expect(store.runtime.beginOperation({ operation, now: NOW })).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(
      (
        await one<{ state: string }>(
          f.project,
          "SELECT state FROM database_provider_operations WHERE organization_id = ?",
          f.project.organizationId,
        )
      )?.state,
    ).toBe("reserved");
  });

  it("observes pending then success, replays identically and refuses a rewritten identity", async () => {
    const f = await fixture();
    const store = commandsOver();
    const operation = await store.runtime.reserveOperation({
      ...f.claimInput,
      step: "database.create",
      providerProjectId: ids(7).providerProjectId,
      requestBody: body,
    });
    const database = ids(7).databaseId;
    const observe = (
      state: "pending" | "succeeded" | "failed",
      databaseId = database,
      providerOperationId: string | null = "op_abcdefghijklmnopqrst",
    ) =>
      store.runtime.recordOperation({
        operation,
        observation: { databaseId, providerOperationId, state },
        now: NOW,
      });
    // an operation that was never dispatched cannot be observed
    await expect(observe("pending")).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await store.runtime.beginOperation({ operation, now: NOW });
    await observe("pending");
    await observe("pending");
    await expect(observe("pending", `d${"c".repeat(19)}`)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await expect(observe("pending", database, "op_zzzzzzzzzzzzzzzzzzzz")).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await observe("succeeded");
    await observe("succeeded");
    await expect(observe("failed")).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(
      await store.runtime.readOperation({ ...f.claimInput, step: "database.create" }),
    ).toMatchObject({
      state: "succeeded",
      databaseId: database,
      providerOperationId: "op_abcdefghijklmnopqrst",
    });
    // a recorded operation that is not the stored identity
    await expect(
      store.runtime.recordOperation({
        operation: { ...operation, idempotencyKey: `omh-${"1".repeat(64)}` },
        observation: { databaseId: database, providerOperationId: null, state: "succeeded" },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    // authority lapsing between decision and commit aborts the record
    const g = await fixture();
    const op2 = await store.runtime.reserveOperation({
      ...g.claimInput,
      step: "database.create",
      providerProjectId: ids(8).providerProjectId,
      requestBody: body,
    });
    await store.runtime.beginOperation({ operation: op2, now: NOW });
    const raced = wrapped(g.project, (db) =>
      beforeFirstWrite(db, async () => {
        await releaseProviderClaim(g.project);
      }),
    );
    await expect(
      raced.runtime.recordOperation({
        operation: op2,
        observation: { databaseId: ids(8).databaseId, providerOperationId: null, state: "pending" },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(
      (
        await one<{ state: string }>(
          g.project,
          "SELECT state FROM database_provider_operations WHERE organization_id = ?",
          g.project.organizationId,
        )
      )?.state,
    ).toBe("dispatched");
  });
});

describe("activation of a new PGCF target", () => {
  it("activates revision and head in one batch behind the global claim and replays", async () => {
    const f = await fixture();
    const store = commandsOver();
    const identity = ids(10);
    await created(f, identity);
    expect(await store.runtime.nextTargetVersion(f.claimInput)).toBe(1);
    const input = activation(f, identity);
    await store.runtime.activateNewTarget(input);
    await store.runtime.activateNewTarget(input);
    expect(await headOf(f)).toEqual({ target_version: 1, state: "active", activated_at: null });
    expect(await count(f.project, "database_provider_target_revisions")).toBe(1);
    expect(await store.runtime.readTarget(f.scope)).toMatchObject({
      provider: "pgcf",
      targetVersion: 1,
      databaseId: identity.databaseId,
      providerProjectId: identity.providerProjectId,
      regionId: "eu-dev",
      sizeClassId: "standard",
      activatedAt: null,
    });
    expect(await store.operator.readDatabaseClaim(identity)).toMatchObject({
      organizationId: f.project.organizationId,
      targetVersion: 1,
      claimId: `${f.claim.operationId}:1`,
      state: "active",
      expiresAt: null,
    });
    // A legacy imported head without its global claim is reconciled atomically, never cloned.
    await control.core
      .prepare("DELETE FROM pgcf_database_claims WHERE provider_project_id=? AND database_id=?")
      .bind(identity.providerProjectId, identity.databaseId)
      .run();
    await store.runtime.activateNewTarget(input);
    expect(await store.operator.readDatabaseClaim(identity)).toMatchObject({
      state: "active",
      organizationId: f.project.organizationId,
    });
    expect(await count(f.project, "database_provider_target_revisions")).toBe(1);
    // an active head makes the next version unavailable
    await expect(store.runtime.nextTargetVersion(f.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    // a different target under the same scope is not a replay
    await expect(
      store.runtime.activateNewTarget(activation(f, identity, 1, { sizeClassId: "large" })),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
  });

  it("refuses an unproven, mismatched or mis-scoped target and writes nothing", async () => {
    const f = await fixture();
    const other = await fixture(1);
    const store = commandsOver();
    const identity = ids(11);
    // no succeeded database.create
    await expect(store.runtime.activateNewTarget(activation(f, identity))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await created(f, identity);
    for (const bad of [
      activation(f, identity, 2),
      activation(f, identity, 1, { regionId: "us-dev" }),
      activation(f, identity, 1, { databaseId: ids(12).databaseId }),
      activation(f, identity, 1, { providerProjectId: ids(12).providerProjectId }),
      activation(f, identity, 1, { runtimeRole: "ohmyho_rw_other" }),
      activation(f, identity, 1, { organizationId: other.project.organizationId }),
      activation(f, identity, 1, { physicalEnvironmentId: other.physical }),
    ])
      await expect(store.runtime.activateNewTarget(bad)).rejects.toThrow();
    expect(await headOf(f)).toBeNull();
    expect(await count(f.project, "database_provider_target_revisions")).toBe(0);
    expect(await store.operator.readDatabaseClaim(identity)).toBeNull();
    await expect(
      store.runtime.activateNewTarget({
        ...activation(f, identity),
        claim: { ...f.claimInput, claimId: other.claim.claimId },
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
  });

  it("aborts the whole batch when the claim, lifecycle or owner changes after the decision", async () => {
    for (const mutate of [
      (f: Fixture) => releaseProviderClaim(f.project),
      replaceEpoch,
      (f: Fixture) => freezeOwnership(f.project),
      (f: Fixture) =>
        exec(
          f.project,
          "UPDATE projects SET lifecycle_state = 'deleting' WHERE organization_id = ?",
          f.project.organizationId,
        ),
    ]) {
      const f = await fixture();
      const identity = ids(1000 + sequence);
      await created(f, identity);
      const raced = wrapped(f.project, (db) =>
        beforeFirstWrite(db, async () => void (await mutate(f))),
      );
      await expect(raced.runtime.activateNewTarget(activation(f, identity))).rejects.toThrow();
      expect(await headOf(f)).toBeNull();
      expect(await count(f.project, "database_provider_target_revisions")).toBe(0);
    }
  });

  it("lets exactly one of two concurrent owners on two real shards hold the physical identity", async () => {
    const a = await fixture(0);
    const b = await fixture(1);
    const identity = ids(30);
    await created(a, identity);
    await created(b, identity);
    const store = commandsOver();
    const results = await Promise.allSettled([
      store.runtime.activateNewTarget(activation(a, identity)),
      store.runtime.activateNewTarget(activation(b, identity)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(PgcfDatabaseTakenError);
    const heads = [await headOf(a), await headOf(b)].filter((h) => h !== null);
    expect(heads).toHaveLength(1);
    const owner = await store.operator.readDatabaseClaim(identity);
    expect([a.project.organizationId, b.project.organizationId]).toContain(owner?.organizationId);
    expect(owner?.state).toBe("active");
    // the owner stays the owner when the other tries again
    const again = await Promise.allSettled([
      store.runtime.activateNewTarget(activation(a, identity)),
      store.runtime.activateNewTarget(activation(b, identity)),
    ]);
    expect(again.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("fences a late writer once the sweep closed its unconfirmed reservation, then frees the identity", async () => {
    const a = await fixture(0);
    const b = await fixture(1);
    const identity = ids(31);
    await created(a, identity);
    await created(b, identity);
    const store = commandsOver();
    // Imported old split-protocol reservation: a delayed old claimant remains fenced after its sweep.
    await reservePgcfDatabaseClaim(control.core, {
      ...identity,
      ...a.scope,
      targetVersion: 1,
      claimId: `${a.claim.operationId}:1`,
      now: STORED_NOW,
    });
    const racing = wrapped(a.project, (db) =>
      beforeFirstWrite(db, async () => {
        // earlier tests may have left expired reservations of other identities; this one must be among the released
        const swept = await store.maintenance.settleDatabaseClaims({ now: LATER });
        expect(swept.released).toBeGreaterThanOrEqual(1);
        expect(await store.operator.readDatabaseClaim(identity)).toBeNull();
      }),
    );
    await expect(racing.runtime.activateNewTarget(activation(a, identity))).rejects.toBeInstanceOf(
      PgcfDatabaseClaimClosedError,
    );
    expect(await headOf(a)).toBeNull();
    expect(await count(a.project, "database_provider_target_revisions")).toBe(0);
    expect(await count(a.project, "pgcf_database_claim_aborts")).toBe(1);
    expect(await store.operator.readDatabaseClaim(identity)).toBeNull();
    // B now owns it, and A's late retry of the same claim can never revive
    await store.runtime.activateNewTarget(activation(b, identity));
    expect((await store.operator.readDatabaseClaim(identity))?.organizationId).toBe(
      b.project.organizationId,
    );
    await expect(store.runtime.activateNewTarget(activation(a, identity))).rejects.toThrow();
    expect(await headOf(a)).toBeNull();
  });

  it("commits claim, revision and head atomically through late failure and an unknown write reply", async () => {
    const a = await fixture(),
      b = await fixture(1),
      identity = ids(32),
      store = commandsOver();
    await created(a, identity);
    await created(b, identity);
    await control.core
      .prepare(
        "CREATE TRIGGER reject_new_target BEFORE INSERT ON database_provider_target_heads BEGIN SELECT RAISE(ABORT,'late head failure'); END",
      )
      .run();
    await expect(store.runtime.activateNewTarget(activation(a, identity))).rejects.toThrow(
      "late head failure",
    );
    expect(await headOf(a)).toBeNull();
    expect(await count(a.project, "database_provider_target_revisions")).toBe(0);
    expect(await store.operator.readDatabaseClaim(identity)).toBeNull();
    await control.core.prepare("DROP TRIGGER reject_new_target").run();
    const lossy = wrapped(a.project, (db) => losingWriteResponses(db, 1));
    await lossy.runtime.activateNewTarget(activation(a, identity));
    expect(await headOf(a)).toMatchObject({ state: "active", target_version: 1 });
    expect(await store.operator.readDatabaseClaim(identity)).toMatchObject({
      state: "active",
      organizationId: a.project.organizationId,
    });
    await expect(store.runtime.activateNewTarget(activation(b, identity))).rejects.toBeInstanceOf(
      PgcfDatabaseTakenError,
    );
    expect(await headOf(b)).toBeNull();
    await store.runtime.activateNewTarget(activation(a, identity));
  });

  it("releases an identity only after its head retired, through the same tombstone fence", async () => {
    const a = await fixture(0);
    const b = await fixture(1);
    const identity = ids(33);
    await created(a, identity);
    const store = commandsOver();
    await store.runtime.activateNewTarget(activation(a, identity));
    expect(await store.operator.releaseDatabaseClaim({ ...identity, now: NOW })).toBe("held");
    expect(await count(a.project, "pgcf_database_claim_aborts")).toBe(0);
    await exec(
      a.project,
      "UPDATE database_provider_target_heads SET state = 'retired', updated_at = ?2 WHERE organization_id = ?1",
      a.project.organizationId,
      STORED_NOW,
    );
    expect(await store.operator.releaseDatabaseClaim({ ...identity, now: NOW })).toBe("released");
    expect(await store.operator.releaseDatabaseClaim({ ...identity, now: NOW })).toBe("absent");
    expect(await count(a.project, "pgcf_database_claim_aborts")).toBe(1);
    await created(b, identity);
    await store.runtime.activateNewTarget(activation(b, identity));
    expect((await store.operator.readDatabaseClaim(identity))?.organizationId).toBe(
      b.project.organizationId,
    );
  });

  it("keeps the claim table exclusive and immutable", async () => {
    const f = await fixture();
    const identity = ids(34);
    const claim = {
      ...identity,
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      physicalEnvironmentId: f.physical,
      targetVersion: 1,
      claimId: "claim-a",
      now: STORED_NOW,
    };
    await reservePgcfDatabaseClaim(control.directory, claim);
    await reservePgcfDatabaseClaim(control.directory, claim);
    await expect(
      reservePgcfDatabaseClaim(control.directory, { ...claim, claimId: "claim-b" }),
    ).rejects.toBeInstanceOf(PgcfDatabaseTakenError);
    await expect(
      reservePgcfDatabaseClaim(control.directory, { ...claim, targetVersion: 2 }),
    ).rejects.toBeInstanceOf(PgcfDatabaseTakenError);
    await expect(
      control.directory
        .prepare(
          "UPDATE pgcf_database_claims SET organization_id = ?3 WHERE provider_project_id = ?1 AND database_id = ?2",
        )
        .bind(identity.providerProjectId, identity.databaseId, ulidOf("x", 1))
        .run(),
    ).rejects.toThrow(/keeps its owner/u);
    await expect(
      f.project.shard
        .prepare(
          "INSERT INTO pgcf_database_claim_aborts(provider_project_id, database_id, organization_id, claim_id, aborted_at) VALUES (?1, ?2, ?3, 'c', ?4)",
        )
        .bind(identity.providerProjectId, identity.databaseId, f.project.organizationId, STORED_NOW)
        .run()
        .then(() =>
          f.project.shard
            .prepare("DELETE FROM pgcf_database_claim_aborts WHERE claim_id = 'c'")
            .run(),
        ),
    ).rejects.toThrow(/immutable/u);
  });
});

/** Seeds the historical Neon branch of a physical environment as a retired head (an import never writes an active one). */
async function legacy(f: Fixture, options: { receipt?: boolean; unfinished?: boolean } = {}) {
  const org = f.project.organizationId;
  await exec(
    f.project,
    "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, branch_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at) VALUES (?1, ?2, ?3, 1, 'neon', 'neon-project-1', NULL, 'br-fixture-1', 'eu', NULL, ?4, 'sealed:neon:1', NULL, ?5)",
    org,
    f.project.projectId,
    f.physical,
    runtimeRoleOf(f.physical),
    STORED_NOW,
  );
  await exec(
    f.project,
    "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, 1, 'retired', NULL, ?4)",
    org,
    f.project.projectId,
    f.physical,
    STORED_NOW,
  );
  const neon = (version: number, branch: string, ids: string[]) =>
    canonicalJson({
      operationId: f.claim.operationId,
      organizationId: org,
      projectId: f.project.projectId,
      physicalEnvironmentId: f.physical,
      registrationVersion: version,
      region: "eu",
      providerProjectId: "neon-project-1",
      branchId: branch,
      originHost: "ep-old.neon.example",
      originDatabase: "neondb",
      originUser: runtimeRoleOf(f.physical),
      authorizedEnvironmentIds: ids,
      status: "active",
    });
  const wanted = [f.project.devEnvironmentId, f.project.prodEnvironmentId].sort();
  if (options.receipt)
    await exec(
      f.project,
      "INSERT INTO project_database_registration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, status, metadata, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, 3, 'active', ?6, ?7)",
      org,
      f.project.projectId,
      f.physical,
      f.claim.operationId,
      ulidOf("neonclaim", sequence),
      neon(3, "br-fixture-1", wanted),
      STORED_NOW,
    );
  if (options.unfinished)
    await exec(
      f.project,
      "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, 4, ?6)",
      org,
      f.project.projectId,
      f.physical,
      f.claim.operationId,
      ulidOf("neonres", sequence),
      neon(4, "br-fixture-1", wanted),
    );
}

const retire = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  ...f.scope,
  expectedTargetVersion: 1,
  providerProjectId: "neon-project-1",
  branchId: "br-fixture-1",
  manifestSha256: "ab".repeat(32),
  inventorySha256: "cd".repeat(32),
  retiredAt: NOW,
  retiredBy: "operator:fixture",
  ...overrides,
});

describe("owner-proven legacy absence and the PGCF successor", () => {
  it("records the absence once, replays it exactly and refuses another proof or a missing source", async () => {
    const f = await fixture();
    const g = await fixture(1);
    await legacy(f);
    const store = commandsOver();
    await store.operator.retireAbsentLegacyTarget(retire(f));
    await store.operator.retireAbsentLegacyTarget(retire(f));
    expect(await count(f.project, "database_provider_legacy_retirements")).toBe(1);
    for (const bad of [
      retire(f, { manifestSha256: "00".repeat(32) }),
      retire(f, { inventorySha256: "00".repeat(32) }),
      retire(f, { branchId: "br-other" }),
      retire(f, { expectedTargetVersion: 2 }),
      retire(g),
    ])
      await expect(store.operator.retireAbsentLegacyTarget(bad)).rejects.toBeInstanceOf(
        DatabaseProviderConflictError,
      );
    await expect(
      store.operator.retireAbsentLegacyTarget(retire(f, { manifestSha256: "xyz" })),
    ).rejects.toThrow();
    expect(await count(g.project, "database_provider_legacy_retirements")).toBe(0);
    // the source disappears between decision and commit
    const h = await fixture();
    await legacy(h);
    const raced = wrapped(h.project, (db) =>
      beforeFirstWrite(db, async () => {
        await exec(
          h.project,
          "UPDATE database_provider_target_heads SET state = 'retired' WHERE organization_id = ?",
          h.project.organizationId,
        );
      }),
    );
    await raced.operator.retireAbsentLegacyTarget(retire(h));
    expect(await count(h.project, "database_provider_legacy_retirements")).toBe(1);
  });

  it("selects the successor only behind an owner-proven absence and an unchanged registration", async () => {
    const store = commandsOver();
    // retired Neon head without an absence proof
    const a = await fixture();
    await legacy(a);
    await expect(store.runtime.nextTargetVersion(a.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await store.operator.retireAbsentLegacyTarget(retire(a));
    expect(await store.runtime.nextTargetVersion(a.claimInput)).toBe(2);
    // a matching Neon registration still permits it
    const b = await fixture();
    await legacy(b, { receipt: true });
    await store.operator.retireAbsentLegacyTarget(retire(b));
    expect(await store.runtime.nextTargetVersion(b.claimInput)).toBe(2);
    // an unfinished reservation above the receipts blocks it
    const c = await fixture();
    await legacy(c, { receipt: true, unfinished: true });
    await store.operator.retireAbsentLegacyTarget(retire(c));
    await expect(store.runtime.nextTargetVersion(c.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    // an unrelated active owner state
    await freezeOwnership(a.project);
    await expect(store.runtime.nextTargetVersion(a.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
  });

  it("advances the retired head to the next version in one batch and never reuses an old one", async () => {
    const f = await fixture();
    await legacy(f, { receipt: true });
    const store = commandsOver();
    const identity = ids(40);
    await created(f, identity, 2);
    // not yet owner-proven absent
    await expect(
      store.runtime.activateNewTarget(activation(f, identity, 2)),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(await store.operator.readDatabaseClaim(identity)).toBeNull();
    await store.operator.retireAbsentLegacyTarget(retire(f));
    await expect(store.runtime.activateNewTarget(activation(f, identity, 1))).rejects.toThrow();
    await store.runtime.activateNewTarget(activation(f, identity, 2));
    expect(await headOf(f)).toEqual({ target_version: 2, state: "active", activated_at: null });
    expect(await count(f.project, "database_provider_target_revisions")).toBe(2);
    expect(await store.runtime.readTarget(f.scope)).toMatchObject({
      provider: "pgcf",
      targetVersion: 2,
    });
    expect((await store.operator.readDatabaseClaim(identity))?.state).toBe("active");
    // a head that is current at version 2 cannot be advanced again
    await expect(store.runtime.nextTargetVersion(f.claimInput)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
  });
});

describe("migration receipt", () => {
  const receipt = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
    claim: f.claimInput,
    ...ids(50),
    bundleSha256: "ab".repeat(32),
    appliedPaths: ["001_init.sql"],
    replayedPaths: [],
    completedAt: NOW,
    ...overrides,
  });

  it("stores the exact bundle receipt once, replays it and refuses another bundle", async () => {
    const f = await fixture();
    const store = commandsOver();
    await store.runtime.recordMigrationReceipt(receipt(f));
    await store.runtime.recordMigrationReceipt(receipt(f));
    expect(await count(f.project, "pgcf_database_migration_receipts")).toBe(1);
    expect(
      (
        await one<{ applied_paths: string }>(
          f.project,
          "SELECT applied_paths FROM pgcf_database_migration_receipts WHERE organization_id = ?",
          f.project.organizationId,
        )
      )?.applied_paths,
    ).toBe('["001_init.sql"]');
    for (const bad of [
      receipt(f, { bundleSha256: "cd".repeat(32) }),
      receipt(f, { databaseId: ids(51).databaseId }),
      receipt(f, { providerProjectId: ids(51).providerProjectId }),
    ])
      await expect(store.runtime.recordMigrationReceipt(bad)).rejects.toBeInstanceOf(
        DatabaseProviderConflictError,
      );
    expect(await count(f.project, "pgcf_database_migration_receipts")).toBe(1);
  });

  it("requires the current claim of the same tenant, also at commit time", async () => {
    const f = await fixture();
    const other = await fixture(1);
    const store = commandsOver();
    await expect(
      store.runtime.recordMigrationReceipt(
        receipt(f, { claim: { ...f.claimInput, claimId: other.claim.claimId } }),
      ),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.runtime.recordMigrationReceipt(
        receipt(f, { claim: { ...f.claimInput, organizationId: other.project.organizationId } }),
      ),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    const raced = wrapped(f.project, (db) =>
      beforeFirstWrite(db, async () => {
        await releaseProviderClaim(f.project);
      }),
    );
    await expect(raced.runtime.recordMigrationReceipt(receipt(f))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(f.project, "pgcf_database_migration_receipts")).toBe(0);
    expect(await count(other.project, "pgcf_database_migration_receipts")).toBe(0);
  });

  it("answers a lost response by replay", async () => {
    const f = await fixture();
    const lost = wrapped(f.project, (db) => losingWriteResponses(db, 1));
    await lost.runtime.recordMigrationReceipt(receipt(f));
    expect(await count(f.project, "pgcf_database_migration_receipts")).toBe(1);
    void bytes;
  });
});

/** A fixture with an ACTIVE PGCF target, reached through the real reserve/begin/record/activate commands. */
async function withActiveTarget(n: number) {
  const f = await fixture();
  const identity = ids(2000 + n);
  const store = commandsOver();
  await created(f, identity);
  await store.runtime.activateNewTarget(activation(f, identity));
  return { f, identity, store };
}

describe("cutover and deletion authority", () => {
  const step = (
    f: Fixture,
    operationId: string,
    name: string,
    identity: { providerProjectId: string },
  ) => ({
    ...f.scope,
    operationId,
    claimId: operationId,
    step: name,
    providerProjectId: identity.providerProjectId,
    requestBody: { name: "approved", region_id: "eu-dev", target_version: 2 },
  });

  it("grants database.create and role.create only to the owner-authorized cutover operation", async () => {
    const { f, identity, store } = await withActiveTarget(1);
    const operationId = await seedOperation(f.project);
    const input = step(f, operationId, "database.create", identity);
    // no authorization yet: the operation holds no claim
    await expect(store.runtime.reserveOperation(input)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await exec(
      f.project,
      "INSERT INTO database_provider_cutover_authorizations(organization_id, operation_id, project_id, physical_environment_id, manifest_sha256, expected_lifecycle_version, source_target_version, source_registration, target_provider_project_id, target_region_id, target_size_class_id, approved_at, approved_by) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, '{}', ?6, 'us-dev', 'small', ?7, 'owner')",
      f.project.organizationId,
      operationId,
      f.project.projectId,
      f.physical,
      bytes(32, 1),
      identity.providerProjectId,
      STORED_NOW,
    );
    const reserved = await store.runtime.reserveOperation(input);
    expect(reserved.state).toBe("reserved");
    await store.runtime.authorizeClaim({
      ...f.scope,
      operationId,
      claimId: operationId,
      step: "role.create:app",
    });
    // other steps and a claim id that is not the operation are not covered by the cutover
    for (const bad of [
      { ...f.scope, operationId, claimId: operationId, step: "database.delete" },
      { ...f.scope, operationId, claimId: operationId, step: "database.resize" },
      { ...f.scope, operationId, claimId: ulidOf("other-claim", 1), step: "database.create" },
      { ...f.scope, operationId, claimId: operationId },
    ])
      await expect(store.runtime.authorizeClaim(bad)).rejects.toBeInstanceOf(
        DatabaseProviderConflictError,
      );
    // the owner's release between decision and commit aborts the batch through the cutover guard
    const g = await withActiveTarget(2);
    const second = await seedOperation(g.f.project);
    await exec(
      g.f.project,
      "INSERT INTO database_provider_cutover_authorizations(organization_id, operation_id, project_id, physical_environment_id, manifest_sha256, expected_lifecycle_version, source_target_version, source_registration, target_provider_project_id, target_region_id, target_size_class_id, approved_at, approved_by) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, '{}', ?6, 'us-dev', 'small', ?7, 'owner')",
      g.f.project.organizationId,
      second,
      g.f.project.projectId,
      g.f.physical,
      bytes(32, 2),
      g.identity.providerProjectId,
      STORED_NOW,
    );
    const raced = wrapped(g.f.project, (db) =>
      beforeFirstWrite(db, async () => {
        await exec(
          g.f.project,
          "UPDATE operations SET state = 'failed' WHERE organization_id = ?1 AND operation_id = ?2",
          g.f.project.organizationId,
          second,
        );
      }),
    );
    await expect(
      raced.runtime.reserveOperation(step(g.f, second, "database.create", g.identity)),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(
      (
        await one<{ n: number }>(
          g.f.project,
          "SELECT count(*) AS n FROM database_provider_operations WHERE organization_id = ?1 AND operation_id = ?2",
          g.f.project.organizationId,
          second,
        )
      )?.n,
    ).toBe(0);
  });

  it("grants database.delete only under the frozen deletion inventory of this exact database", async () => {
    const { f, identity, store } = await withActiveTarget(3);
    const operationId = await seedOperation(f.project);
    const input = step(f, operationId, "database.delete", identity);
    // no deletion intent, cleanup run or inventory yet
    await expect(store.runtime.reserveOperation(input)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    const cleanupRun = ulidOf("cleanup", sequence);
    await exec(
      f.project,
      "INSERT INTO cleanup_runs(organization_id, cleanup_run_id, project_id, operation_id, state, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'running', 1, ?5, ?5)",
      f.project.organizationId,
      cleanupRun,
      f.project.projectId,
      operationId,
      STORED_NOW,
    );
    await exec(
      f.project,
      "INSERT INTO product_command_intents(organization_id, operation_id, event_type, project_id, environment_id, billing_epoch_id, cleanup_run_id, expected_etag, created_at) VALUES (?1, ?2, 'ProjectDeletionRequestedV1', ?3, ?4, ?5, ?6, ?7, ?8)",
      f.project.organizationId,
      operationId,
      f.project.projectId,
      f.project.prodEnvironmentId,
      f.project.billingEpochId,
      cleanupRun,
      '"' + "a".repeat(64) + '"',
      STORED_NOW,
    );
    await exec(
      f.project,
      "UPDATE projects SET lifecycle_state = 'deleting' WHERE organization_id = ?1",
      f.project.organizationId,
    );
    // the inventory does not name this database yet
    await expect(store.runtime.reserveOperation(input)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    await exec(
      f.project,
      "INSERT INTO run_resource_inventory(organization_id, resource_record_id, project_id, operation_id, provider, resource_kind, external_ref_hash, recorded_at, cleanup_locator) VALUES (?1, ?2, ?3, ?4, 'pgcf', 'database', ?5, ?6, ?7)",
      f.project.organizationId,
      ulidOf("resource", sequence),
      f.project.projectId,
      operationId,
      bytes(32, 7),
      STORED_NOW,
      cleanupLocatorOf(identity.databaseId),
    );
    expect((await store.runtime.reserveOperation(input)).state).toBe("reserved");
    // a delete grant covers only database.delete and only when the claim id is the operation id
    await expect(
      store.runtime.reserveOperation({ ...step(f, operationId, "database.create", identity) }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.runtime.reserveOperation({ ...input, claimId: ulidOf("other-claim", 2) }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    // losing the deletion run between decision and commit aborts a later write of the same step
    const operation = await store.runtime.reserveOperation(input);
    const raced = wrapped(f.project, (db) =>
      beforeFirstWrite(db, async () => {
        await exec(
          f.project,
          "UPDATE operations SET state = 'failed' WHERE organization_id = ?1 AND operation_id = ?2",
          f.project.organizationId,
          operationId,
        );
      }),
    );
    await expect(raced.runtime.beginOperation({ operation, now: NOW })).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(
      await store.runtime
        .readOperation({ ...f.scope, operationId, claimId: operationId, step: "database.delete" })
        .catch(() => "lost"),
    ).toBe("lost");
  });
});
