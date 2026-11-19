import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedCoreRouter } from "../src/router.js";

import { AUTHORIZATION_ACTIONS } from "../../../packages/platform/src/ports/authorization.js";
import { newUlid, type CatalogContext } from "../src/catalog/common.js";
import type { D1PreparedStatement } from "../src/d1-types.js";
import {
  applyWorkosSnapshot,
  isSessionEligible,
  recordMembershipBarrier,
  recordTerminalRevocation,
} from "../src/catalog/identity/membership-state.js";
import {
  authorizeUserApiKeyScope,
  claimUserApiKeyCreation,
  finishUserApiKeyCreation,
  readUserApiKeyNames,
  USER_API_KEY_PERMISSIONS,
} from "../src/catalog/identity/user-api-key-requests.js";
import {
  ensureMcpConnectionProof,
  completeMcpGithub,
  completeMcpSecret,
  readNativeProviderHandoffState,
  claimNativeProviderHandoff,
  completeNativeProviderHandoff,
  consumeMcpHandoff,
  findMcpHandoff,
  insertMcpHandoff,
  revokeMcpConsent,
} from "../src/catalog/identity/mcp-delegations.js";
import { authorizeOrganizationAction } from "../src/catalog/projects/customer-projects-access.js";
import { createControlStore } from "../src/store.js";
import {
  coreRouter,
  createTestControl,
  losingNthResponse,
  organizationIdWithShard,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";
import { digest, projectInput } from "./support/seed.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";

let control: TestControl;
let context: CatalogContext;
let store: ReturnType<typeof createControlStore>;
let sequence = 0;

beforeAll(async () => {
  control = await createTestControl(2);
  context = {
    directory: control.directory,
    router: coreRouter(control, control.shards),
  };
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const at = (second: number, ms = 0) =>
  `2026-10-28T12:00:${String(second).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;

interface Seeded {
  readonly organizationId: string;
  readonly workos: string;
  readonly shard: number;
}

/** An active, beta-admitted organization with an owner and a plain member, created by the real snapshot command. */
async function seed(shard = 0): Promise<Seeded & { owner: string; member: string }> {
  sequence += 1;
  const organizationId = await organizationIdWithShard(2, shard, 9_000_000 + sequence * 7919);
  const workos = `org_q1_${sequence}`;
  const owner = `user_owner${sequence}`;
  const member = `user_member${sequence}`;
  await applyWorkosSnapshot(
    context,
    snapshot(organizationId, workos, 1, [
      [owner, "admin"],
      [member, "member"],
    ]),
  );
  await shardOf(control, shard)
    .prepare("UPDATE organizations SET beta_admitted_at = ? WHERE organization_id = ?")
    .bind("2026-10-28T08:00:00.000000Z", organizationId)
    .run();
  return { organizationId, workos, shard, owner, member };
}

function snapshot(
  organizationId: string,
  workos: string,
  n: number,
  members: [string, string][],
  state: "active" | "suspended" = "active",
) {
  return {
    organizationId,
    workosOrganizationId: workos,
    state,
    snapshotDigest: digest(n * 1000 + sequence),
    snapshotFetchedAt: at(n),
    synchronizedAt: at(n, 500),
    triggerEventId: `event_${sequence}_${n}`,
    auditEventId: newUlid(),
    memberships: members.map(([workosUserId, role]) => ({
      workosUserId,
      role,
      status: "active" as const,
      digest: digest(n * 77 + workosUserId.length + role.length + sequence * 13),
    })),
  };
}

const grants = async (s: Seeded) =>
  (
    await shardOf(control, s.shard)
      .prepare(
        "SELECT principal_id, role, revoked_at FROM local_authorization_grants WHERE organization_id = ? ORDER BY principal_id, created_at",
      )
      .bind(s.organizationId)
      .all<{ principal_id: string; role: string; revoked_at: string | null }>()
  ).results;

describe("identity.applyWorkosSnapshot", () => {
  it("writes the organization, memberships, projected grants and the directory mirror in one batch", async () => {
    const s = await seed();
    expect(await grants(s)).toEqual([
      { principal_id: `user:${s.member}`, role: "member", revoked_at: null },
      { principal_id: `user:${s.owner}`, role: "owner", revoked_at: null },
    ]);
    const mirror = await control.directory
      .prepare("SELECT state FROM org_directory WHERE organization_id = ?")
      .bind(s.organizationId)
      .first<{ state: string }>();
    expect(mirror?.state).toBe("active");
  });

  it("is replay safe when the response of the committed batch is lost", async () => {
    sequence += 1;
    const organizationId = await organizationIdWithShard(2, 1, 9_500_000 + sequence * 31);
    const input = snapshot(organizationId, `org_lost_${sequence}`, 1, [["user_lost", "admin"]]);
    const lossy: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, {
        ...control.shards,
        CONTROL_SHARD_0001: losingNthResponse(shardOf(control, 1), 3),
      }),
    };
    const result = await applyWorkosSnapshot(lossy, input);
    expect(result).toMatchObject({ organizationChanged: true, changedMemberships: 1 });
    const count = await shardOf(control, 1)
      .prepare("SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ?")
      .bind(organizationId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("revokes grants of absent and demoted members, and of everyone when the organization is suspended", async () => {
    const s = await seed();
    await applyWorkosSnapshot(
      context,
      snapshot(s.organizationId, s.workos, 2, [[s.member, "admin"]]),
    );
    const rows = await grants(s);
    expect(rows.filter((row) => row.revoked_at === null)).toEqual([
      { principal_id: `user:${s.member}`, role: "owner", revoked_at: null },
    ]);
    await applyWorkosSnapshot(
      context,
      snapshot(s.organizationId, s.workos, 3, [[s.member, "admin"]], "suspended"),
    );
    expect((await grants(s)).every((row) => row.revoked_at !== null)).toBe(true);
    const mirror = await control.directory
      .prepare("SELECT state FROM org_directory WHERE organization_id = ?")
      .bind(s.organizationId)
      .first<{ state: string }>();
    expect(mirror?.state).toBe("suspended");
  });

  it("refuses a WorkOS organization mapped to another internal organization, across tenants", async () => {
    const s = await seed();
    const other = await organizationIdWithShard(2, 1, 9_900_000 + sequence);
    await expect(
      applyWorkosSnapshot(context, snapshot(other, s.workos, 1, [])),
    ).rejects.toMatchObject({ code: "workos_organization_mapped" });
  });

  it("rejects a snapshot that lists one user twice", async () => {
    const s = await seed();
    await expect(
      applyWorkosSnapshot(
        context,
        snapshot(s.organizationId, s.workos, 4, [
          [s.owner, "admin"],
          [s.owner, "admin"],
        ]),
      ),
    ).rejects.toMatchObject({ code: "duplicate_membership" });
  });

  it("rejects a conflicting digest at the same fetch time and tolerates an identical one", async () => {
    const s = await seed();
    const same = snapshot(s.organizationId, s.workos, 1, [
      [s.owner, "admin"],
      [s.member, "member"],
    ]);
    await expect(
      applyWorkosSnapshot(context, {
        ...same,
        snapshotDigest: digest(424242),
        auditEventId: newUlid(),
      }),
    ).rejects.toMatchObject({ code: "snapshot_timestamp_collision" });
  });

  it("ignores a snapshot of a deleted organization", async () => {
    const s = await seed();
    await shardOf(control, s.shard)
      .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
      .bind(s.organizationId)
      .run();
    const result = await applyWorkosSnapshot(
      context,
      snapshot(s.organizationId, s.workos, 5, [[s.owner, "admin"]]),
    );
    expect(result.ignoredAfterDeletion).toBe(true);
  });
});

describe("membership barriers and session eligibility", () => {
  const eligibility = (s: { workos: string }, user: string, session = "session_a") =>
    isSessionEligible(context, {
      sessionId: session,
      workosUserId: user,
      workosOrganizationId: s.workos,
      observedAt: "2026-10-28T13:00:00.000Z",
    });

  it("fails closed while a barrier is open and reopens eligibility when a snapshot covers it", async () => {
    const s = await seed();
    expect(await eligibility(s, s.member)).toBe(true);
    const barrier = (event: string, createdAt: string) => ({
      workosOrganizationId: s.workos,
      workosUserId: s.member,
      sourceEventId: event,
      eventCreatedAt: createdAt,
    });
    expect(
      await recordMembershipBarrier(context, barrier("evt_1", "2026-10-28T12:30:00.000Z")),
    ).toBe("opened");
    expect(await eligibility(s, s.member)).toBe(false);
    expect(
      await recordMembershipBarrier(context, barrier("evt_1", "2026-10-28T12:30:00.000Z")),
    ).toBe("existing");
    expect(
      await recordMembershipBarrier(context, barrier("evt_0", "2026-10-28T12:00:00.000Z")),
    ).toBe("ignored_older");
    await expect(
      recordMembershipBarrier(context, barrier("evt_other", "2026-10-28T12:30:00.000Z")),
    ).rejects.toMatchObject({ code: "membership_barrier_ambiguous" });
    const early = snapshot(s.organizationId, s.workos, 2, [
      [s.owner, "admin"],
      [s.member, "member"],
    ]);
    await applyWorkosSnapshot(context, {
      ...early,
      snapshotFetchedAt: "2026-10-28T12:10:00.000Z",
      synchronizedAt: "2026-10-28T12:10:00.500Z",
    });
    expect(await eligibility(s, s.member)).toBe(false);
    const late = snapshot(s.organizationId, s.workos, 3, [
      [s.owner, "admin"],
      [s.member, "member"],
    ]);
    await applyWorkosSnapshot(context, {
      ...late,
      snapshotFetchedAt: "2026-10-28T12:40:00.000Z",
      synchronizedAt: "2026-10-28T12:40:00.500Z",
    });
    expect(await eligibility(s, s.member)).toBe(true);
  });

  it("keeps a barrier of a not yet mapped organization in the directory until its first snapshot", async () => {
    sequence += 1;
    const workos = `org_pending_${sequence}`;
    const input = {
      workosOrganizationId: workos,
      workosUserId: "user_early",
      sourceEventId: "evt_p1",
      eventCreatedAt: "2026-10-28T12:30:00.000Z",
    };
    expect(await recordMembershipBarrier(context, input)).toBe("opened");
    expect(await recordMembershipBarrier(context, input)).toBe("existing");
    expect(
      await recordMembershipBarrier(context, {
        ...input,
        sourceEventId: "evt_p2",
        eventCreatedAt: "2026-10-28T12:31:00.000Z",
      }),
    ).toBe("opened");
    expect(
      await recordMembershipBarrier(context, {
        ...input,
        sourceEventId: "evt_p0",
        eventCreatedAt: "2026-10-28T12:00:00.000Z",
      }),
    ).toBe("ignored_older");
    await expect(
      recordMembershipBarrier(context, {
        ...input,
        sourceEventId: "evt_px",
        eventCreatedAt: "2026-10-28T12:31:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "membership_barrier_ambiguous" });
    expect(await eligibility({ workos }, "user_early")).toBe(false);
    const organizationId = await organizationIdWithShard(2, 0, 9_700_000 + sequence);
    const first = snapshot(organizationId, workos, 1, [["user_early", "member"]]);
    await applyWorkosSnapshot(context, first);
    const shardBarrier = await shardOf(control, 0)
      .prepare(
        "SELECT source_event_id, reconciled_at FROM workos_membership_sync_barriers WHERE organization_id = ?",
      )
      .bind(organizationId)
      .first<{ source_event_id: string; reconciled_at: string | null }>();
    expect(shardBarrier).toEqual({ source_event_id: "evt_p2", reconciled_at: null });
    const pending = await control.directory
      .prepare(
        "SELECT count(*) AS n FROM pending_membership_barriers WHERE workos_organization_id = ?",
      )
      .bind(workos)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
    expect(await eligibility({ workos }, "user_early")).toBe(false);
  });

  it("answers not eligible for unknown, suspended and unmapped scopes and eligible without an organization", async () => {
    expect(await eligibility({ workos: "org_nobody" }, "user_x")).toBe(false);
    expect(
      await isSessionEligible(context, {
        sessionId: "session_z",
        workosUserId: "user_x",
        workosOrganizationId: null,
        observedAt: "2026-10-28T13:00:00.000Z",
      }),
    ).toBe(true);
    const s = await seed();
    await applyWorkosSnapshot(
      context,
      snapshot(s.organizationId, s.workos, 2, [[s.owner, "admin"]], "suspended"),
    );
    expect(await eligibility(s, s.owner)).toBe(false);
  });

  it("makes terminal revocations irreversible, idempotent and conflict checked", async () => {
    const s = await seed();
    const base = {
      kind: "session" as const,
      sessionId: "session_dead",
      workosUserId: s.owner,
      workosOrganizationId: s.workos,
      sourceEventId: "rev_1",
      effectiveAt: "2026-10-28T12:50:00.000Z",
    };
    expect(await recordTerminalRevocation(context, base)).toBe("created");
    expect(await recordTerminalRevocation(context, base)).toBe("existing");
    expect(await eligibility(s, s.owner, "session_dead")).toBe(false);
    expect(await eligibility(s, s.owner, "session_alive")).toBe(true);
    await expect(
      recordTerminalRevocation(context, { ...base, effectiveAt: "2026-10-28T12:51:00.000Z" }),
    ).rejects.toMatchObject({ code: "revocation_replay_conflict" });
    await expect(
      recordTerminalRevocation(context, { ...base, sessionId: "session_other" }),
    ).rejects.toMatchObject({ code: "revocation_identity_conflict" });
    expect(
      await recordTerminalRevocation(context, {
        kind: "user",
        workosUserId: s.member,
        sourceEventId: "rev_u",
        effectiveAt: "2026-10-28T12:50:00.000Z",
      }),
    ).toBe("created");
    expect(await eligibility(s, s.member, "session_alive")).toBe(false);
    expect(
      await recordTerminalRevocation(context, {
        kind: "organization",
        workosOrganizationId: s.workos,
        sourceEventId: "rev_o",
        effectiveAt: "2026-10-28T12:50:00.000Z",
      }),
    ).toBe("created");
    expect(await eligibility(s, s.owner, "session_alive")).toBe(false);
    const session = await control.directory
      .prepare("SELECT purge_after FROM revocations WHERE source_event_id = 'rev_1'")
      .first<{ purge_after: string | null }>();
    expect(session?.purge_after).toBe("2026-12-02T12:50:00.000000Z");
  });

  it("denies organization actions of a user with a terminal user revocation while an active owner stays allowed", async () => {
    const s = await seed();
    const allowed = (user: string) =>
      authorizeOrganizationAction(context, {
        organizationId: s.organizationId,
        principalId: `user:${user}`,
        action: "projects:read",
      });
    expect(await allowed(s.owner)).toBe("allow");
    await recordTerminalRevocation(context, {
      kind: "user",
      workosUserId: s.owner,
      sourceEventId: "rev_owner_user",
      effectiveAt: "2026-10-28T12:50:00.000Z",
    });
    expect(await allowed(s.owner)).toBe("deny");
  });
});

// The source stores AUTHORIZATION_ACTIONS without "api-keys:manage", in source order (the actual constant, not a copy).
const SOURCE_KEY_PERMISSIONS = AUTHORIZATION_ACTIONS.filter(
  (action) => action !== "api-keys:manage",
);

describe("user API key requests", () => {
  const scope = (s: Seeded, user: string, now = "2026-10-28T13:00:00.000Z") => ({
    organizationId: s.organizationId,
    workosOrganizationId: s.workos,
    userId: user,
    sessionId: "session_k",
    now,
  });
  const claim = (s: Seeded, user: string, key: string, name = "ci key") => ({
    ...scope(s, user),
    requestId: newUlid(),
    auditEventId: newUlid(),
    name,
    idempotencyKey: key,
  });

  it("claims once, observes a repeat, rejects key reuse with another request and records the result once", async () => {
    const s = await seed();
    const first = claim(s, s.owner, "idem-1");
    const created = await claimUserApiKeyCreation(context, first);
    expect(created).toMatchObject({
      action: "create",
      providerName: `ci key [${first.requestId}]`,
      // source parity: every action but api-keys:manage, fixed by the server (no caller input)
      permissions: SOURCE_KEY_PERMISSIONS,
    });
    // drift guard: a new platform action must be mirrored (or deliberately excluded) here, never silently missed
    expect([...USER_API_KEY_PERMISSIONS]).toEqual([...SOURCE_KEY_PERMISSIONS]);
    expect(SOURCE_KEY_PERMISSIONS).toHaveLength(AUTHORIZATION_ACTIONS.length - 1);
    await expect(
      claimUserApiKeyCreation(context, { ...claim(s, s.owner, "idem-p"), permissions: ["x"] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const again = await claimUserApiKeyCreation(context, {
      ...claim(s, s.owner, "idem-1"),
      requestId: newUlid(),
    });
    expect(again).toMatchObject({ action: "observe", requestId: first.requestId });
    await expect(
      claimUserApiKeyCreation(context, claim(s, s.owner, "idem-1", "other name")),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    const finish = {
      ...scope(s, s.owner),
      requestId: first.requestId,
      auditEventId: newUlid(),
      outcome: { kind: "created" as const, keyId: `api_key_${first.requestId}` },
    };
    await finishUserApiKeyCreation(context, finish);
    await finishUserApiKeyCreation(context, { ...finish, auditEventId: newUlid() });
    await expect(
      finishUserApiKeyCreation(context, {
        ...finish,
        auditEventId: newUlid(),
        outcome: { kind: "rejected", code: "KEY_PERMISSIONS_UNAVAILABLE" },
      }),
    ).rejects.toMatchObject({ code: "result_conflict" });
    await expect(
      finishUserApiKeyCreation(context, { ...finish, requestId: newUlid() }),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    expect(await claimUserApiKeyCreation(context, claim(s, s.owner, "idem-1"))).toMatchObject({
      action: "observe",
      keyId: `api_key_${first.requestId}`,
    });
    const names = await readUserApiKeyNames(context, {
      organizationId: s.organizationId,
      userId: s.owner,
      keyIds: [`api_key_${first.requestId}`, "api_key_unknown"],
    });
    expect([...names]).toEqual([[`api_key_${first.requestId}`, "ci key"]]);
    const other = await readUserApiKeyNames(context, {
      organizationId: s.organizationId,
      userId: s.member,
      keyIds: [`api_key_${first.requestId}`],
    });
    expect(other.size).toBe(0);
    // The same user under another organization cannot see the key that this organization recorded.
    const elsewhere = await seed();
    const foreign = await readUserApiKeyNames(context, {
      organizationId: elsewhere.organizationId,
      userId: s.owner,
      keyIds: [`api_key_${first.requestId}`],
    });
    expect(foreign.size).toBe(0);
  });

  it("records a rejection and rejects invalid input with the closed error set", async () => {
    const s = await seed();
    const request = claim(s, s.member, "idem-2");
    await claimUserApiKeyCreation(context, request);
    await finishUserApiKeyCreation(context, {
      ...scope(s, s.member),
      requestId: request.requestId,
      auditEventId: newUlid(),
      outcome: { kind: "rejected", code: "KEY_PERMISSIONS_UNAVAILABLE" },
    });
    // A rejection created no provider key, so the same idempotency key starts a fresh attempt once the platform
    // configuration is fixed; the rejected attempt is replaced, never replayed.
    const retry = await claimUserApiKeyCreation(context, claim(s, s.member, "idem-2"));
    expect(retry).toMatchObject({ action: "create", keyId: null });
    expect(retry.requestId).not.toBe(request.requestId);
    await expect(
      claimUserApiKeyCreation(context, claim(s, s.member, "idem-2", "other name")),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(await claimUserApiKeyCreation(context, claim(s, s.member, "idem-2"))).toMatchObject({
      action: "observe",
      requestId: retry.requestId,
    });
    await expect(claimUserApiKeyCreation(context, { ...request, name: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(authorizeUserApiKeyScope(context, { nope: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(finishUserApiKeyCreation(context, { nope: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(readUserApiKeyNames(context, { nope: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("refuses non members, other tenants, an open barrier, a revoked session and a lost beta admission", async () => {
    const s = await seed(0);
    const t = await seed(1);
    await expect(
      claimUserApiKeyCreation(context, claim(s, "user_stranger", "idem-3")),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(
      claimUserApiKeyCreation(context, {
        ...claim(t, t.owner, "idem-3"),
        organizationId: s.organizationId,
      }),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    await authorizeUserApiKeyScope(context, scope(s, s.owner));
    await recordMembershipBarrier(context, {
      workosOrganizationId: s.workos,
      workosUserId: s.owner,
      sourceEventId: "bar_1",
      eventCreatedAt: "2026-10-28T12:30:00.000Z",
    });
    await expect(authorizeUserApiKeyScope(context, scope(s, s.owner))).rejects.toMatchObject({
      code: "resource_not_found",
    });
    await recordTerminalRevocation(context, {
      kind: "session",
      sessionId: "session_k",
      workosUserId: t.owner,
      sourceEventId: "rev_k",
      effectiveAt: "2026-10-28T12:00:00.000Z",
    });
    await expect(authorizeUserApiKeyScope(context, scope(t, t.owner))).rejects.toMatchObject({
      code: "resource_not_found",
    });
    await shardOf(control, 1)
      .prepare("UPDATE organizations SET beta_admitted_at = NULL WHERE organization_id = ?")
      .bind(t.organizationId)
      .run();
    await expect(
      authorizeUserApiKeyScope(context, { ...scope(t, t.owner), sessionId: "session_fresh" }),
    ).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("claims exactly once under a lost response and under concurrent twins", async () => {
    const s = await seed(1);
    const lossy: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, {
        ...control.shards,
        CONTROL_SHARD_0001: losingNthResponse(shardOf(control, 1), 4),
      }),
    };
    const request = claim(s, s.owner, "idem-lost");
    expect(await claimUserApiKeyCreation(lossy, request)).toMatchObject({
      action: "create",
      requestId: request.requestId,
    });
    const twins = await Promise.all(
      [0, 1, 2].map(() => claimUserApiKeyCreation(context, { ...claim(s, s.member, "idem-twin") })),
    );
    expect(new Set(twins.map((twin) => twin.requestId)).size).toBe(1);
    expect(twins.filter((twin) => twin.action === "create")).toHaveLength(1);
    const count = await shardOf(control, 1)
      .prepare("SELECT count(*) AS n FROM user_api_key_requests WHERE organization_id = ?")
      .bind(s.organizationId)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("refuses a claim whose authorization is lost between the check and the write, and writes nothing", async () => {
    const s = await seed(0);
    // The write batch is the one that carries the INSERT; the member leaves just before it (the number of
    // preceding batches is an implementation detail and not asserted).
    let writes = 0;
    const inner = new WeakMap<object, D1PreparedStatement>();
    const wrapped = new Map<D1PreparedStatement, string>();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const proxy: D1PreparedStatement = {
        bind: (...values) => wrap(statement.bind(...values), sql),
        first: () => statement.first(),
        all: () => statement.all(),
        run: () => statement.run(),
      };
      inner.set(proxy, statement);
      wrapped.set(proxy, sql);
      return proxy;
    };
    const racing: CatalogContext = {
      directory: control.directory,
      router: new SharedCoreRouter({
        prepare: (sql) => wrap(shardOf(control, 0).prepare(sql), sql),
        batch: async (statements) => {
          const isWrite = statements.some((statement) =>
            /INSERT INTO user_api_key_requests/u.test(wrapped.get(statement) ?? ""),
          );
          if (isWrite) writes += 1;
          if (isWrite && writes === 1) {
            await shardOf(control, 0)
              .prepare(
                "UPDATE organization_memberships SET state = 'revoked' WHERE organization_id = ? AND workos_user_id = ?",
              )
              .bind(s.organizationId, s.member)
              .run();
          }
          return shardOf(control, 0).batch(
            statements.map((statement) => inner.get(statement) ?? statement),
          );
        },
      }),
    };
    await expect(
      claimUserApiKeyCreation(racing, claim(s, s.member, "idem-race")),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    expect(writes).toBe(1);
    const rows = await shardOf(control, 0)
      .prepare("SELECT count(*) AS n FROM user_api_key_requests WHERE organization_id = ?")
      .bind(s.organizationId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const effects = await shardOf(control, 0)
      .prepare(
        "SELECT count(*) AS n FROM organization_audit_events WHERE organization_id = ? AND event_type = 'UserApiKeyCreationStarted'",
      )
      .bind(s.organizationId)
      .first<{ n: number }>();
    expect(effects?.n).toBe(0);
  });

  it("leaves constraint violations of a finish to the database as in the source: no mapping, and the whole batch rolls back", async () => {
    const s = await seed(1);
    const a = claim(s, s.owner, "idem-a");
    const b = claim(s, s.owner, "idem-b");
    await claimUserApiKeyCreation(context, a);
    await claimUserApiKeyCreation(context, b);
    const finish = (request: { requestId: string }, keyId: string, now?: string) => ({
      ...scope(s, s.owner, now),
      requestId: request.requestId,
      auditEventId: newUlid(),
      outcome: { kind: "created" as const, keyId },
    });
    const completed = async () =>
      (
        await shardOf(control, 1)
          .prepare(
            "SELECT count(*) AS n FROM organization_audit_events WHERE organization_id = ? AND event_type = 'UserApiKeyCreationCompleted'",
          )
          .bind(s.organizationId)
          .first<{ n: number }>()
      )?.n;
    // finished before requested_at: the source's `finished_at >= requested_at` CHECK surfaces unmapped
    const early = await finishUserApiKeyCreation(
      context,
      finish(a, "api_key_same", "2026-10-28T12:00:00.000Z"),
    ).catch((error: unknown) => error);
    expect(early).toBeInstanceOf(Error);
    expect(early).not.toHaveProperty("code");
    expect(await completed()).toBe(0);
    await finishUserApiKeyCreation(context, finish(a, "api_key_same"));
    expect(await completed()).toBe(1);
    // the same provider key on another request: the UNIQUE violation is unmapped too and writes no audit event
    const duplicate = await finishUserApiKeyCreation(context, finish(b, "api_key_same")).catch(
      (error: unknown) => error,
    );
    expect(duplicate).toBeInstanceOf(Error);
    expect(duplicate).not.toHaveProperty("code");
    expect(await completed()).toBe(1);
    // result_conflict stays the same-request mismatch
    await expect(
      finishUserApiKeyCreation(context, finish(a, "api_key_other")),
    ).rejects.toMatchObject({ code: "result_conflict" });
    const unfinished = await shardOf(control, 1)
      .prepare(
        "SELECT count(*) AS n FROM user_api_key_requests WHERE organization_id = ? AND finished_at IS NULL",
      )
      .bind(s.organizationId)
      .first<{ n: number }>();
    expect(unfinished?.n).toBe(1);
  });
});

/** Secret and GitHub handoffs live at most ten minutes (original178); grants live up to an hour. */
const CONNECTION_LINK_LIFETIME = {
  createdAt: "2026-10-28T12:05:00.000Z",
  expiresAt: "2026-10-28T12:15:00.000Z",
};

describe("MCP handoffs and delegation grants", () => {
  async function seedProject(s: Seeded & { owner: string }) {
    const project = projectInput(
      s.organizationId,
      `h${sequence}x${Math.floor(Math.random() * 1e6)}`,
    );
    await store.projects.createInitialProject({ ...project, principalId: `user:${s.owner}` });
    return project;
  }
  const hash = (n: number) => digest(0xabc000 + n * 17 + sequence);
  const who = (s: Seeded & { owner: string }, n = 1) => ({
    organizationId: s.organizationId,
    userId: s.owner,
    clientId: `client_${n}`,
    consentHash: digest(0xc0de00 + n),
  });
  const handoff = (
    s: Seeded & { owner: string },
    requestHash: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ...who(s),
    requestHash,
    kind: "grant" as const,
    projectIds: [] as string[],
    allowCreate: false,
    allowPublish: true,
    secretTarget: null,
    createdAt: "2026-10-28T12:00:00.000Z",
    expiresAt: "2026-10-28T12:30:00.000Z",
    ...extra,
  });

  it("creates connection evidence without a grant and keeps explicit workspace revocation terminal", async () => {
    const s = await seed(0);
    const project = await seedProject(s);
    const input = { ...who(s), projectId: project.projectId, now: "2026-10-28T12:10:00.000Z" };
    const [first, concurrent] = await Promise.all([
      ensureMcpConnectionProof(context, input),
      ensureMcpConnectionProof(context, input),
    ]);
    expect(concurrent?.grantId).toBe(first?.grantId);
    expect(first).toMatchObject({ projectId: project.projectId });
    expect(await ensureMcpConnectionProof(context, input)).toMatchObject({
      grantId: first?.grantId,
    });
    expect(await ensureMcpConnectionProof(context, { ...input, userId: s.member })).not.toBeNull();
    expect(
      await ensureMcpConnectionProof(context, { ...input, userId: "user_stranger" }),
    ).toBeNull();
    await shardOf(control, 0)
      .prepare(
        "UPDATE projects SET ownership_version=ownership_version+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(s.organizationId, project.projectId)
      .run();
    const nextEpoch = await ensureMcpConnectionProof(context, input);
    expect(nextEpoch?.grantId).toBeDefined();
    expect(nextEpoch?.grantId).not.toBe(first?.grantId);
    const other = await seed(0);
    await applyWorkosSnapshot(
      context,
      snapshot(other.organizationId, other.workos, 2, [
        [other.owner, "admin"],
        [s.owner, "member"],
      ]),
    );
    const otherProof = { ...input, organizationId: other.organizationId, projectId: null };
    expect(await ensureMcpConnectionProof(context, otherProof)).not.toBeNull();
    const connection = {
      userId: s.owner,
      clientId: input.clientId,
      consentHash: input.consentHash,
    };
    expect(await store.remoteMcp.readMcpAuthorizedMemberships(connection)).toEqual({
      disconnected: false,
      organizationIds: [s.organizationId, other.organizationId].sort(),
    });
    await shardOf(control, 0)
      .prepare(
        "INSERT INTO mcp_client_revocations(organization_id,user_id,client_id,consent_hash,revoked_at) VALUES (?1,?2,?3,?4,?5)",
      )
      .bind(
        s.organizationId,
        s.owner,
        input.clientId,
        input.consentHash,
        "2026-10-28T12:10:30.000000Z",
      )
      .run();
    expect(await ensureMcpConnectionProof(context, input)).toBeNull();
    expect(await ensureMcpConnectionProof(context, otherProof)).not.toBeNull();
    expect(await store.remoteMcp.readMcpAuthorizedMemberships(connection)).toEqual({
      disconnected: false,
      organizationIds: [other.organizationId],
    });
    await revokeMcpConsent(context, {
      userId: s.owner,
      clientId: who(s).clientId,
      consentHash: who(s).consentHash,
      now: "2026-10-28T12:11:00.000Z",
    });
    expect(await ensureMcpConnectionProof(context, input)).toBeNull();
    expect(await ensureMcpConnectionProof(context, otherProof)).toBeNull();
    expect(await store.remoteMcp.readMcpAuthorizedMemberships(connection)).toEqual({
      disconnected: true,
      organizationIds: [],
    });
    const noMembership = {
      userId: `user_nomembership${sequence}`,
      clientId: input.clientId,
      consentHash: input.consentHash,
    };
    await revokeMcpConsent(context, { ...noMembership, now: "2026-10-28T12:11:01.000Z" });
    const future = await seed(0);
    await applyWorkosSnapshot(
      context,
      snapshot(future.organizationId, future.workos, 2, [
        [future.owner, "admin"],
        [s.owner, "member"],
        [noMembership.userId, "member"],
      ]),
    );
    expect(
      await ensureMcpConnectionProof(context, {
        ...otherProof,
        ...noMembership,
        organizationId: future.organizationId,
      }),
    ).toBeNull();
    expect(
      await ensureMcpConnectionProof(context, {
        ...otherProof,
        organizationId: future.organizationId,
      }),
    ).toBeNull();
  });

  it("persists handoff authority and refuses consumption after disconnect", async () => {
    const s = await seed(0);
    const whoNow = who(s);
    const proof = await ensureMcpConnectionProof(context, {
      ...whoNow,
      projectId: null,
      now: "2026-10-28T12:00:00.000Z",
    });
    if (!proof) throw new Error("Connection proof fixture missing");
    const authority = {
      grantId: proof.grantId,
      clientId: whoNow.clientId,
      consentHash: whoNow.consentHash,
      action: "sources:link",
      authorizationRestriction: { actions: ["sources:link"], organizationIds: [s.organizationId] },
    };
    const requestHash = hash(101);
    await insertMcpHandoff(
      context,
      handoff(s, requestHash, {
        kind: "github",
        ...CONNECTION_LINK_LIFETIME,
        authority,
        githubTarget: { idempotencyKey: "github-key" },
        allowPublish: false,
      }),
    );
    expect((await findMcpHandoff(context, { requestHash }))?.authority).toEqual(authority);
    const happyHash = hash(102);
    const happy = handoff(s, happyHash, {
      kind: "github",
      ...CONNECTION_LINK_LIFETIME,
      authority,
      githubTarget: { idempotencyKey: "github-happy" },
      allowPublish: false,
    });
    await expect(insertMcpHandoff(context, { ...happy, mailDomains: [] })).rejects.toThrow();
    await expect(
      insertMcpHandoff(context, { ...happy, allowMailDomainCreate: false }),
    ).rejects.toThrow();
    await expect(
      consumeMcpHandoff(context, {
        requestHash: happyHash,
        userId: s.owner,
        organizationId: s.organizationId,
        now: "2026-10-28T12:00:30.000Z",
        approve: true,
        publish: false,
        selectedMailDomainIds: [],
      }),
    ).rejects.toThrow();
    await insertMcpHandoff(context, happy);
    expect(
      await shardOf(control, 0)
        .prepare(
          "SELECT mail_domain_scopes,allow_mail_domain_create FROM mcp_portal_handoffs WHERE request_hash=?",
        )
        .bind(happyHash)
        .first(),
    ).toEqual({ mail_domain_scopes: "[]", allow_mail_domain_create: 0 });
    await insertMcpHandoff(context, happy);
    const consume = {
      requestHash: happyHash,
      userId: s.owner,
      organizationId: s.organizationId,
      now: "2026-10-28T12:00:30.000Z",
      approve: true,
      publish: false,
    };
    expect(await consumeMcpHandoff(context, consume)).toMatchObject({
      outcome: "github_started",
      authority,
    });
    expect(await consumeMcpHandoff(context, consume)).toMatchObject({ outcome: "github_started" });
    await completeMcpGithub(context, { requestHash: happyHash, succeeded: false });
    expect((await findMcpHandoff(context, { requestHash: happyHash }))?.outcome).toBe(
      "github_failed",
    );
    const demotedHash = hash(103);
    await insertMcpHandoff(context, { ...happy, requestHash: demotedHash });
    await applyWorkosSnapshot(
      context,
      snapshot(s.organizationId, s.workos, 2, [
        [s.owner, "member"],
        [s.member, "member"],
      ]),
    );
    expect(await consumeMcpHandoff(context, { ...consume, requestHash: demotedHash })).toBeNull();
    expect((await findMcpHandoff(context, { requestHash: demotedHash }))?.consumedAt).toBeNull();
    await applyWorkosSnapshot(
      context,
      snapshot(s.organizationId, s.workos, 3, [
        [s.owner, "admin"],
        [s.member, "member"],
      ]),
    );
    const project = await seedProject(s);
    const projectProof = await ensureMcpConnectionProof(context, {
      ...whoNow,
      projectId: project.projectId,
      now: consume.now,
    });
    if (!projectProof) throw new Error("Secret proof unavailable");
    const nativeHash = hash(150);
    const nativeTarget = {
      projectId: project.projectId,
      environmentId: project.developmentEnvironmentId,
      environment: "dev",
      name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
      nativeProvider: {
        provider: "google",
        configurationRevision: 3,
        enabled: true,
        clientId: "client",
      },
    };
    const nativeHandoff = handoff(s, nativeHash, {
      kind: "secret",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      projectIds: [project.projectId],
      allowPublish: false,
      secretTarget: nativeTarget,
      authority: {
        grantId: projectProof.grantId,
        clientId: whoNow.clientId,
        consentHash: whoNow.consentHash,
        action: "auth:manage",
      },
    });
    await insertMcpHandoff(context, nativeHandoff);
    expect((await findMcpHandoff(context, { requestHash: nativeHash }))?.secretTarget).toEqual(
      nativeTarget,
    );
    await expect(
      insertMcpHandoff(context, {
        ...nativeHandoff,
        requestHash: hash(151),
        secretTarget: { ...nativeTarget, name: "NATIVE_AUTH_GITHUB_CLIENT_SECRET" },
      }),
    ).rejects.toThrow();
    const nativeScope = {
      organizationId: s.organizationId,
      userId: s.owner,
      requestHash: nativeHash,
    };
    const firstAttempt = newUlid(),
      retryAttempt = newUlid();
    const lostScope = { ...nativeScope, requestHash: hash(158) };
    await insertMcpHandoff(context, { ...nativeHandoff, requestHash: lostScope.requestHash });
    const lostAttempt = newUlid();
    const lossy = losingWriteResponses(control.core, 1);
    const recovered = await claimNativeProviderHandoff(
      { directory: lossy, router: new SharedCoreRouter(lossy) },
      { ...lostScope, valueSha256: "aa".repeat(32), attemptId: lostAttempt },
    );
    expect(recovered).toMatchObject({ secretTarget: nativeTarget });
    expect(await readNativeProviderHandoffState(context, lostScope)).toBe("pending");
    expect(
      await claimNativeProviderHandoff(context, {
        ...lostScope,
        valueSha256: "aa".repeat(32),
        attemptId: lostAttempt,
      }),
    ).toMatchObject({ secretTarget: nativeTarget });
    expect(
      await consumeMcpHandoff(context, {
        ...nativeScope,
        now: new Date().toISOString(),
        approve: true,
        publish: false,
      }),
    ).toBeNull();
    expect(await readNativeProviderHandoffState(context, nativeScope)).toBe("retryable");
    for (const started of [false, true]) {
      const cancelledScope = { ...nativeScope, requestHash: hash(started ? 156 : 155) };
      await insertMcpHandoff(context, {
        ...nativeHandoff,
        requestHash: cancelledScope.requestHash,
      });
      if (started) {
        const attemptId = newUlid();
        await claimNativeProviderHandoff(context, {
          ...cancelledScope,
          valueSha256: "ef".repeat(32),
          attemptId,
        });
        expect(
          await consumeMcpHandoff(context, {
            ...cancelledScope,
            now: new Date().toISOString(),
            approve: false,
            publish: false,
          }),
        ).toBeNull();
        await completeNativeProviderHandoff(context, {
          organizationId: s.organizationId,
          requestHash: cancelledScope.requestHash,
          attemptId,
          succeeded: false,
        });
      }
      const decline = {
        ...cancelledScope,
        now: new Date().toISOString(),
        approve: false,
        publish: false,
      };
      expect(await consumeMcpHandoff(context, { ...decline, userId: s.member })).toBeNull();
      expect(await consumeMcpHandoff(context, decline)).toMatchObject({ outcome: "declined" });
      // A user's decline is a state the agent can report; only the claim refuses the declined handoff.
      expect(await readNativeProviderHandoffState(context, cancelledScope)).toBe("declined");
      expect(
        await claimNativeProviderHandoff(context, {
          ...cancelledScope,
          valueSha256: "ef".repeat(32),
          attemptId: newUlid(),
        }),
      ).toBeNull();
      expect(
        (await findMcpHandoff(context, { requestHash: cancelledScope.requestHash }))?.outcome,
      ).toBe("declined");
    }
    expect(
      await claimNativeProviderHandoff(context, {
        ...nativeScope,
        valueSha256: "ab".repeat(32),
        attemptId: firstAttempt,
      }),
    ).toMatchObject({ secretTarget: nativeTarget, outcome: "secret_submitted" });
    expect(await readNativeProviderHandoffState(context, nativeScope)).toBe("pending");
    expect(
      await claimNativeProviderHandoff(context, {
        ...nativeScope,
        valueSha256: "ab".repeat(32),
        attemptId: retryAttempt,
      }),
    ).toBeNull();
    expect(
      await completeNativeProviderHandoff(context, {
        organizationId: s.organizationId,
        requestHash: nativeHash,
        attemptId: firstAttempt,
        succeeded: false,
      }),
    ).toBe(true);
    expect(await readNativeProviderHandoffState(context, nativeScope)).toBe("retryable");
    expect(
      await claimNativeProviderHandoff(context, {
        ...nativeScope,
        valueSha256: "cd".repeat(32),
        attemptId: newUlid(),
      }),
    ).toBeNull();
    expect(
      await claimNativeProviderHandoff(context, {
        ...nativeScope,
        valueSha256: "ab".repeat(32),
        attemptId: retryAttempt,
      }),
    ).toMatchObject({ secretTarget: nativeTarget });
    expect(
      await completeNativeProviderHandoff(context, {
        organizationId: s.organizationId,
        requestHash: nativeHash,
        attemptId: firstAttempt,
        succeeded: true,
      }),
    ).toBe(false);
    expect(
      await completeNativeProviderHandoff(context, {
        organizationId: s.organizationId,
        requestHash: nativeHash,
        attemptId: retryAttempt,
        succeeded: true,
      }),
    ).toBe(true);
    expect(await readNativeProviderHandoffState(context, nativeScope)).toBe("succeeded");
    expect((await findMcpHandoff(context, { requestHash: nativeHash }))?.outcome).toBe(
      "secret_failed",
    );
    const attemptEvents = await control.core
      .prepare(
        "SELECT attempt_id,event FROM native_auth_handoff_attempt_events WHERE organization_id=?1 AND request_hash=?2 ORDER BY attempt_id,event",
      )
      .bind(s.organizationId, nativeHash)
      .all<{ attempt_id: string; event: string }>();
    expect(attemptEvents.results).toHaveLength(4);
    expect(
      await claimNativeProviderHandoff(context, {
        ...nativeScope,
        valueSha256: "ab".repeat(32),
        attemptId: newUlid(),
      }),
    ).toBeNull();
    expect(
      await readNativeProviderHandoffState(context, { ...nativeScope, userId: s.member }),
    ).toBeNull();
    const expiredHash = hash(152);
    await insertMcpHandoff(context, {
      ...nativeHandoff,
      requestHash: expiredHash,
      createdAt: new Date(Date.now() - 300_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const expiredScope = { ...nativeScope, requestHash: expiredHash };
    expect(await readNativeProviderHandoffState(context, expiredScope)).toBe("expired");
    expect(
      await claimNativeProviderHandoff(context, {
        ...expiredScope,
        valueSha256: "ab".repeat(32),
        attemptId: newUlid(),
      }),
    ).toBeNull();
    const raceScope = { ...nativeScope, requestHash: hash(153) };
    await insertMcpHandoff(context, { ...nativeHandoff, requestHash: raceScope.requestHash });
    const raceAttempts = [newUlid(), newUlid()];
    const racedClaims = await Promise.all(
      raceAttempts.map((attemptId) =>
        claimNativeProviderHandoff(context, {
          ...raceScope,
          valueSha256: "ab".repeat(32),
          attemptId,
        }),
      ),
    );
    expect(racedClaims.filter((value) => value !== null)).toHaveLength(1);
    const originalAttempt = raceAttempts[racedClaims.findIndex((value) => value !== null)];
    await control.core
      .prepare(
        "UPDATE native_auth_handoff_attempts SET lease_until='1970-01-01T00:00:00.000000Z' WHERE organization_id=?1 AND request_hash=?2",
      )
      .bind(s.organizationId, raceScope.requestHash)
      .run();
    expect(await readNativeProviderHandoffState(context, raceScope)).toBe("retryable");
    expect(
      await claimNativeProviderHandoff(context, {
        ...raceScope,
        valueSha256: "ab".repeat(32),
        attemptId: newUlid(),
      }),
    ).not.toBeNull();
    expect(
      await completeNativeProviderHandoff(context, {
        organizationId: s.organizationId,
        requestHash: raceScope.requestHash,
        attemptId: originalAttempt,
        succeeded: true,
      }),
    ).toBe(false);
    const limitedScope = { ...nativeScope, requestHash: hash(154) };
    await insertMcpHandoff(context, {
      ...nativeHandoff,
      requestHash: limitedScope.requestHash,
      authority: {
        grantId: projectProof.grantId,
        clientId: whoNow.clientId,
        consentHash: whoNow.consentHash,
        action: "auth:manage",
        authorizationRestriction: { actions: ["secrets:write"] },
      },
    });
    expect(
      await claimNativeProviderHandoff(context, {
        ...limitedScope,
        valueSha256: "ab".repeat(32),
        attemptId: newUlid(),
      }),
    ).toBeNull();
    expect(
      await consumeMcpHandoff(context, {
        ...limitedScope,
        now: new Date().toISOString(),
        approve: false,
        publish: false,
      }),
    ).toBeNull();
    const staleHash = hash(104);
    await insertMcpHandoff(
      context,
      handoff(s, staleHash, {
        kind: "secret",
        ...CONNECTION_LINK_LIFETIME,
        projectIds: [project.projectId],
        allowPublish: false,
        secretTarget: {
          projectId: project.projectId,
          environmentId: project.developmentEnvironmentId,
          environment: "dev",
          name: "STABLE_DENIAL",
        },
        authority: {
          grantId: projectProof.grantId,
          clientId: whoNow.clientId,
          consentHash: whoNow.consentHash,
          action: "secrets:write",
        },
      }),
    );
    await control.core
      .prepare("UPDATE projects SET ownership_version=ownership_version+1 WHERE project_id=?")
      .bind(project.projectId)
      .run();
    expect(await readNativeProviderHandoffState(context, nativeScope)).toBeNull();
    expect(await consumeMcpHandoff(context, { ...consume, requestHash: staleHash })).toBeNull();
    expect((await findMcpHandoff(context, { requestHash: staleHash }))?.consumedAt).toBeNull();
    await revokeMcpConsent(context, {
      userId: s.owner,
      clientId: whoNow.clientId,
      consentHash: whoNow.consentHash,
      now: "2026-10-28T12:01:00.000Z",
    });
    expect(
      await consumeMcpHandoff(context, {
        requestHash,
        userId: s.owner,
        organizationId: s.organizationId,
        now: "2026-10-28T12:02:00.000Z",
        approve: true,
        publish: false,
      }),
    ).toBeNull();
  });

  it("records an approved plain secret link as failed until its stored write completes, never as submitted before", async () => {
    // A link consumed by an invocation that ends before its write is stored must read as failed, with the link used up.
    const s = await seed(0);
    const whoNow = who(s);
    const project = await seedProject(s);
    const proof = await ensureMcpConnectionProof(context, {
      ...whoNow,
      projectId: project.projectId,
      now: "2026-10-28T12:00:00.000Z",
    });
    if (!proof) throw new Error("Secret proof unavailable");
    const secretHash = hash(160);
    await insertMcpHandoff(
      context,
      handoff(s, secretHash, {
        kind: "secret",
        ...CONNECTION_LINK_LIFETIME,
        projectIds: [project.projectId],
        allowPublish: false,
        secretTarget: {
          projectId: project.projectId,
          environmentId: project.developmentEnvironmentId,
          environment: "dev",
          name: "PLAIN_SECRET",
        },
        authority: {
          grantId: proof.grantId,
          clientId: whoNow.clientId,
          consentHash: whoNow.consentHash,
          action: "secrets:write",
        },
      }),
    );
    const consume = {
      requestHash: secretHash,
      userId: s.owner,
      organizationId: s.organizationId,
      now: "2026-10-28T12:00:30.000Z",
      approve: true,
      publish: false,
    };
    expect(await consumeMcpHandoff(context, consume)).toMatchObject({ outcome: "secret_failed" });
    expect((await findMcpHandoff(context, { requestHash: secretHash }))?.outcome).toBe(
      "secret_failed",
    );
    await completeMcpSecret(context, { requestHash: secretHash, succeeded: true });
    expect((await findMcpHandoff(context, { requestHash: secretHash }))?.outcome).toBe(
      "secret_submitted",
    );
  });
});
