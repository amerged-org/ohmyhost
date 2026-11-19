import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid, type CatalogContext } from "../src/catalog/common.js";
import { purgeMcpHandoffRoutes } from "../src/catalog/identity/handoff-routes-retention.js";
import {
  consumeMcpHandoff,
  ensureMcpConnectionProof,
  findMcpHandoff,
  insertMcpHandoff,
} from "../src/catalog/identity/mcp-delegations.js";
import {
  applyWorkosSnapshot,
  isSessionEligible,
  promotePendingBarriers,
  recordMembershipBarrier,
} from "../src/catalog/identity/membership-state.js";
import { chunked } from "../src/catalog/identity/shared.js";
import type { D1Database } from "../src/d1-types.js";
import { BucketMovingError, withRouteRefresh } from "../src/fence.js";
import { bucketOf, SharedCoreRouter } from "../src/router.js";
import {
  coreRouter,
  createTestControl,
  organizationIdWithShard,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";
import { digest } from "./support/seed.js";

let control: TestControl;
let context: CatalogContext;
let sequence = 0;

beforeAll(async () => {
  control = await createTestControl(2);
  context = {
    directory: control.directory,
    router: coreRouter(control, control.shards),
  };
});
afterAll(async () => control.dispose());

const at = (second: number, ms = 0) =>
  `2026-10-28T12:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;

const member = (index: number) => `user_m${String(index).padStart(5, "0")}`;

function bigSnapshot(
  organizationId: string,
  workos: string,
  n: number,
  count: number,
  roleOf: (index: number) => string = () => "member",
  extra: Record<string, unknown> = {},
) {
  return {
    organizationId,
    workosOrganizationId: workos,
    state: "active" as const,
    snapshotDigest: digest(n * 100_003 + sequence),
    snapshotFetchedAt: at(n),
    synchronizedAt: at(n, 500),
    triggerEventId: `event_${sequence}_${n}`,
    auditEventId: newUlid(),
    memberships: Array.from({ length: count }, (_, index) => ({
      workosUserId: member(index),
      role: roleOf(index),
      status: "active" as const,
      digest: digest(n * 7_919 + index * 31 + sequence * 1_000_003),
    })),
    ...extra,
  };
}

async function fresh(shard = 0) {
  sequence += 1;
  return {
    organizationId: await organizationIdWithShard(2, shard, 11_000_000 + sequence * 104_729),
    workos: `org_scale_${sequence}`,
    workosOrganizationId: `org_scale_${sequence}`,
    shard,
  };
}

const count = async (db: D1Database, sql: string, ...binds: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n;

describe("unbounded snapshots in one atomic batch", () => {
  it("applies 1,300 memberships with no cap, as one write batch, and every one is visible together", async () => {
    const s = await fresh(0);
    let batches = 0;
    const counting: CatalogContext = {
      directory: control.directory,
      router: new SharedCoreRouter({
        prepare: (sql) => shardOf(control, 0).prepare(sql),
        batch: async (statements) => {
          batches += 1;
          return shardOf(control, 0).batch(statements);
        },
      }),
    };
    const input = bigSnapshot(s.organizationId, s.workos, 1, 1_300, (index) =>
      index % 10 === 0 ? "admin" : "member",
    );
    const result = await applyWorkosSnapshot(counting, input);
    expect(result).toMatchObject({ organizationChanged: true, changedMemberships: 1_300 });
    // command log lookup, read batch and ONE write batch: the Directory claim and mirror are statements of that batch.
    expect(batches).toBe(3);
    const db = shardOf(control, 0);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM organization_memberships WHERE organization_id = ?",
        s.organizationId,
      ),
    ).toBe(1_300);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
        s.organizationId,
      ),
    ).toBe(1_300);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ? AND role = 'owner'",
        s.organizationId,
      ),
    ).toBe(130);
    // the digest of a member survives the hex round trip byte for byte
    const stored = await db
      .prepare(
        "SELECT lower(hex(snapshot_sha256)) AS d FROM organization_memberships WHERE organization_id = ? AND workos_user_id = ?",
      )
      .bind(s.organizationId, member(1_299))
      .first<{ d: string }>();
    expect(stored?.d).toBe(input.memberships[1_299]?.digest);
  });

  it("changes, demotes and revokes absent members of a large organization set-based, replay safe", async () => {
    const s = await fresh(1);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 1, 1_100));
    // 2: members 0..599 promoted, 600..999 unchanged, 1000..1099 absent
    const second = bigSnapshot(s.organizationId, s.workos, 2, 1_000, (index) =>
      index < 600 ? "admin" : "member",
    );
    const unchanged = Array.from({ length: 400 }, (_, offset) => 600 + offset);
    // an unchanged member keeps its digest of the first snapshot so it is not rewritten
    const first = bigSnapshot(s.organizationId, s.workos, 1, 1_100);
    for (const index of unchanged) {
      (second.memberships[index] as { digest: string }).digest = (
        first.memberships[index] as { digest: string }
      ).digest;
    }
    const result = await applyWorkosSnapshot(context, second);
    expect(result).toMatchObject({ organizationChanged: true, changedMemberships: 600 + 100 });
    const db = shardOf(control, 1);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM organization_memberships WHERE organization_id = ? AND state = 'revoked'",
        s.organizationId,
      ),
    ).toBe(100);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL AND role = 'owner'",
        s.organizationId,
      ),
    ).toBe(600);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
        s.organizationId,
      ),
    ).toBe(1_000);
    // the very same command again is answered from its log: no second effect
    expect(await applyWorkosSnapshot(context, second)).toEqual(result);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ?",
        s.organizationId,
      ),
    ).toBe(1_100 + 600);
  });

  it("rolls back the whole large snapshot when its inbox claim is stale: no partial membership visibility", async () => {
    const s = await fresh(0);
    const input = bigSnapshot(s.organizationId, s.workos, 1, 900, () => "member", {
      claim: { inboxEventId: newUlid(), claimId: newUlid(), acknowledgedAt: at(1, 600) },
    });
    await expect(applyWorkosSnapshot(context, input)).rejects.toMatchObject({
      code: "inbox_claim_stale",
    });
    const db = shardOf(control, 0);
    for (const table of [
      "organizations",
      "organization_memberships",
      "local_authorization_grants",
      "audit_events",
      "organization_audit_events",
    ]) {
      expect(
        await count(
          db,
          `SELECT count(*) AS n FROM ${table} WHERE organization_id = ?`,
          s.organizationId,
        ),
      ).toBe(0);
    }
  });

  it("serialises two concurrent snapshots of one organization: the newer one always wins whole", async () => {
    const s = await fresh(0);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 1, 700));
    const older = bigSnapshot(s.organizationId, s.workos, 2, 700, () => "admin");
    const newer = bigSnapshot(s.organizationId, s.workos, 3, 700, () => "member");
    const settled = await Promise.allSettled([
      applyWorkosSnapshot(context, older),
      applyWorkosSnapshot(context, newer),
    ]);
    expect(settled[1]?.status).toBe("fulfilled");
    if (settled[0]?.status === "rejected") {
      expect(settled[0].reason).toMatchObject({ code: "snapshot_timestamp_collision" });
    }
    const db = shardOf(control, 0);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM organization_memberships WHERE organization_id = ? AND role = 'member' AND state = 'active'",
        s.organizationId,
      ),
    ).toBe(700);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL AND role = 'member'",
        s.organizationId,
      ),
    ).toBe(700);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL AND role = 'owner'",
        s.organizationId,
      ),
    ).toBe(0);
  });

  it("re-reads and decides again when a membership appears between read and write", async () => {
    const s = await fresh(1);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 1, 5));
    let calls = 0;
    const racing: CatalogContext = {
      directory: control.directory,
      router: new SharedCoreRouter({
        prepare: (sql) => shardOf(control, 1).prepare(sql),
        batch: async (statements) => {
          calls += 1;
          // calls: 1 log lookup, 2 read batch, 3 the first write attempt
          if (calls === 3) {
            await shardOf(control, 1)
              .prepare(
                "INSERT INTO organization_memberships(organization_id, workos_user_id, role, state, mapping_revision, snapshot_sha256, effective_at, trigger_event_id) VALUES (?1, 'user_raced', 'member', 'active', 1, ?2, ?3, 'evt')",
              )
              .bind(s.organizationId, new Uint8Array(32), at(1, 100).replace("Z", "000Z"))
              .run();
          }
          return shardOf(control, 1).batch(statements);
        },
      }),
    };
    await applyWorkosSnapshot(racing, bigSnapshot(s.organizationId, s.workos, 2, 5));
    const raced = await shardOf(control, 1)
      .prepare(
        "SELECT state FROM organization_memberships WHERE organization_id = ? AND workos_user_id = 'user_raced'",
      )
      .bind(s.organizationId)
      .first<{ state: string }>();
    // the stale decision was refused whole and decided again: the raced member is revoked as absent
    expect(raced?.state).toBe("revoked");
  });

  it("splits any list into bounded chunks", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([])).toEqual([]);
  });
});

describe("pending barriers are resumable after every lost step", () => {
  const pendingOf = (workos: string) =>
    count(
      control.directory,
      "SELECT count(*) AS n FROM pending_membership_barriers WHERE workos_organization_id = ?",
      workos,
    );

  it("adopts a pending barrier and cleans the Directory in the snapshot's own batch, and answers a lost response from the log", async () => {
    const s = await fresh(0);
    await recordMembershipBarrier(context, {
      workosOrganizationId: s.workos,
      workosUserId: "user_late",
      sourceEventId: "evt_late",
      eventCreatedAt: at(50),
    });
    expect(await pendingOf(s.workos)).toBe(1);
    const lossy: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, { alias: losingWriteResponses(control.core, 1) }),
    };
    // fetched BEFORE the event: the barrier must stay open however many times this is resent
    const input = bigSnapshot(s.organizationId, s.workos, 5, 3, () => "member", {});
    (input.memberships[0] as { workosUserId: string }).workosUserId = "user_late";
    // the batch commits and its response is lost: the retry is answered from the command log
    expect(await applyWorkosSnapshot(lossy, input)).toMatchObject({
      organizationId: s.organizationId,
    });
    // adoption and Directory cleanup committed TOGETHER: the barrier is real in the organization, nothing is pending
    expect(await pendingOf(s.workos)).toBe(0);
    expect(
      await count(
        shardOf(control, 0),
        "SELECT count(*) AS n FROM workos_membership_sync_barriers WHERE organization_id = ? AND reconciled_at IS NULL",
        s.organizationId,
      ),
    ).toBe(1);
    expect(
      await isSessionEligible(context, {
        sessionId: "session_late",
        workosUserId: "user_late",
        workosOrganizationId: s.workos,
        observedAt: at(60),
      }),
    ).toBe(false);
    expect(await applyWorkosSnapshot(context, input)).toMatchObject({
      organizationId: s.organizationId,
    });
    expect(
      await count(
        shardOf(control, 0),
        "SELECT count(*) AS n FROM organization_audit_events WHERE organization_id = ? AND event_type = 'WorkosOrganizationSnapshotApplied'",
        s.organizationId,
      ),
    ).toBe(1);
  });

  it("leaves no Directory claim, organization or consumed pending barrier when the snapshot batch fails late", async () => {
    const s = await fresh(0);
    await recordMembershipBarrier(context, {
      workosOrganizationId: s.workos,
      workosUserId: "user_rolled_back",
      sourceEventId: "evt_rolled_back",
      eventCreatedAt: at(50),
    });
    await control.core
      .prepare(
        "CREATE TRIGGER late_snapshot_audit BEFORE INSERT ON organization_audit_events BEGIN SELECT RAISE(ABORT, 'late failure'); END",
      )
      .run();
    await expect(
      applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 5, 3)),
    ).rejects.toThrow();
    // the former phases (Directory claim, snapshot, barrier promotion, mirror) were separate commits: now none survives
    expect(
      await count(
        control.directory,
        "SELECT count(*) AS n FROM org_directory WHERE organization_id = ? OR workos_organization_id = ?",
        s.organizationId,
        s.workos,
      ),
    ).toBe(0);
    expect(
      await count(
        control.directory,
        "SELECT count(*) AS n FROM organizations WHERE organization_id = ?",
        s.organizationId,
      ),
    ).toBe(0);
    expect(await pendingOf(s.workos)).toBe(1);
    await control.core.prepare("DROP TRIGGER late_snapshot_audit").run();
    expect(
      await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 6, 3)),
    ).toMatchObject({ organizationId: s.organizationId });
    expect(await pendingOf(s.workos)).toBe(0);
  });

  it("keeps a barrier when the first snapshot crashed after claiming the directory, and adopts it later", async () => {
    const s = await fresh(1);
    // the claim of the directory row is durable, the shard row does not exist yet
    await context.directory
      .prepare(
        "INSERT INTO org_directory(organization_id, workos_organization_id, bucket, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)",
      )
      .bind(
        s.organizationId,
        s.workos,
        await bucketOf(s.organizationId),
        "2026-10-28T12:00:00.000000Z",
      )
      .run();
    const event = {
      workosOrganizationId: s.workos,
      workosUserId: member(0),
      sourceEventId: "evt_claimed",
      eventCreatedAt: at(40),
    };
    expect(await recordMembershipBarrier(context, event)).toBe("opened");
    expect(await pendingOf(s.workos)).toBe(1);
    expect(
      await isSessionEligible(context, {
        sessionId: "session_x",
        workosUserId: member(0),
        workosOrganizationId: s.workos,
        observedAt: at(59),
      }),
    ).toBe(false);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 45, 2));
    expect(await pendingOf(s.workos)).toBe(0);
    // an equally new snapshot (fetched after the event) closes it
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 55, 2));
    expect(
      await isSessionEligible(context, {
        sessionId: "session_x",
        workosUserId: member(0),
        workosOrganizationId: s.workos,
        observedAt: at(59),
      }),
    ).toBe(true);
  });

  it("adopts a pending row that raced the first snapshot, from the eligibility check and from the barrier command", async () => {
    const s = await fresh(0);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 1, 2));
    // a row left pending although the shard row exists (written between the shard read and the directory write)
    await context.directory
      .prepare(
        "INSERT INTO pending_membership_barriers(workos_organization_id, workos_user_id, source_event_id, event_created_at) VALUES (?1, ?2, 'evt_race', '2026-10-28T12:00:30.000000Z')",
      )
      .bind(s.workos, member(1))
      .run();
    expect(
      await isSessionEligible(context, {
        sessionId: "session_r",
        workosUserId: member(1),
        workosOrganizationId: s.workos,
        observedAt: at(59),
      }),
    ).toBe(false);
    expect(await pendingOf(s.workos)).toBe(0);
    expect(
      await count(
        shardOf(control, 0),
        "SELECT count(*) AS n FROM workos_membership_sync_barriers WHERE organization_id = ? AND reconciled_at IS NULL",
        s.organizationId,
      ),
    ).toBe(1);
    // nothing pending: promoting is a no-op
    expect(await promotePendingBarriers(context, s)).toBe(0);
    // an organization without a shard row cannot adopt yet and the row stays
    const ghost = await fresh(1);
    await context.directory
      .prepare(
        "INSERT INTO pending_membership_barriers(workos_organization_id, workos_user_id, source_event_id, event_created_at) VALUES (?1, 'user_g', 'evt_g', '2026-10-28T12:00:30.000000Z')",
      )
      .bind(ghost.workos)
      .run();
    expect(await promotePendingBarriers(context, ghost)).toBe(0);
    expect(await pendingOf(ghost.workos)).toBe(1);
  });

  it("advances an existing shard barrier only for a strictly newer pending event", async () => {
    const s = await fresh(1);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 1, 2));
    const open = (id: string, createdAt: string) => ({
      workosOrganizationId: s.workos,
      workosUserId: member(0),
      sourceEventId: id,
      eventCreatedAt: createdAt,
    });
    await recordMembershipBarrier(context, open("evt_a", at(20)));
    const pend = (id: string, createdAt: string) =>
      context.directory
        .prepare(
          "INSERT OR REPLACE INTO pending_membership_barriers(workos_organization_id, workos_user_id, source_event_id, event_created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(s.workos, member(0), id, createdAt.replace("Z", "000Z"))
        .run();
    const barrier = () =>
      shardOf(control, 1)
        .prepare(
          "SELECT source_event_id FROM workos_membership_sync_barriers WHERE organization_id = ? AND workos_user_id = ?",
        )
        .bind(s.organizationId, member(0))
        .first<{ source_event_id: string }>();
    await pend("evt_old", at(10));
    // an older event than the barrier changes nothing in the shard and is dropped from the directory
    expect(await promotePendingBarriers(context, s)).toBe(1);
    expect((await barrier())?.source_event_id).toBe("evt_a");
    expect(await pendingOf(s.workos)).toBe(0);
    await pend("evt_new", at(30));
    expect(await promotePendingBarriers(context, s)).toBe(1);
    expect((await barrier())?.source_event_id).toBe("evt_new");
    expect(await pendingOf(s.workos)).toBe(0);
  });
});

describe("directory mirror and fences", () => {
  it("never moves the directory mirror back when an older snapshot is resent from its log", async () => {
    const s = await fresh(0);
    const older = bigSnapshot(s.organizationId, s.workos, 2, 2);
    await applyWorkosSnapshot(context, older);
    await applyWorkosSnapshot(context, {
      ...bigSnapshot(s.organizationId, s.workos, 3, 2),
      state: "suspended",
    });
    const mirror = () =>
      control.directory
        .prepare("SELECT state FROM org_directory WHERE organization_id = ?")
        .bind(s.organizationId)
        .first<{ state: string }>();
    expect((await mirror())?.state).toBe("suspended");
    await applyWorkosSnapshot(context, older);
    expect((await mirror())?.state).toBe("suspended");
    // the mirror is a statement of the snapshot batch: it equals the organization row, never a separate step
    expect(
      (
        await control.directory
          .prepare("SELECT state FROM organizations WHERE organization_id = ?")
          .bind(s.organizationId)
          .first<{ state: string }>()
      )?.state,
    ).toBe("suspended");
  });

  it("stops a snapshot at a fenced bucket whole and applies nothing", async () => {
    const s = await fresh(0);
    await applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 1, 3));
    await shardOf(control, 0)
      .prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moving', ?, '2026-10-28T12:00:00.000000Z')",
      )
      .bind(await bucketOf(s.organizationId), newUlid())
      .run();
    await expect(
      withRouteRefresh(context.router, () =>
        applyWorkosSnapshot(context, bigSnapshot(s.organizationId, s.workos, 2, 900)),
      ),
    ).rejects.toBeInstanceOf(BucketMovingError);
    expect(
      await count(
        shardOf(control, 0),
        "SELECT count(*) AS n FROM organization_memberships WHERE organization_id = ?",
        s.organizationId,
      ),
    ).toBe(3);
  });
});

describe("MCP consumption survives a lost response", () => {
  const hash = (n: number) => digest(0xdead00 + n * 13 + sequence);
  const who = (organizationId: string, owner: string) => ({
    organizationId,
    userId: owner,
    clientId: "client_lost",
    consentHash: digest(0xfeed00 + sequence),
  });

  async function organizationWithOwner(shard: number) {
    const s = await fresh(shard);
    await applyWorkosSnapshot(
      context,
      bigSnapshot(s.organizationId, s.workos, 1, 1, () => "admin"),
    );
    await shardOf(control, shard)
      .prepare("UPDATE organizations SET beta_admitted_at = ? WHERE organization_id = ?")
      .bind("2026-10-28T08:00:00.000000Z", s.organizationId)
      .run();
    return { ...s, owner: member(0) };
  }

  const handoff = async (s: { organizationId: string; owner: string }, requestHash: string) => {
    const identity = who(s.organizationId, s.owner);
    const proof = await ensureMcpConnectionProof(context, {
      ...identity,
      projectId: null,
      now: "2026-10-28T12:05:00.000Z",
    });
    if (!proof) throw new Error("Feature handoff proof missing");
    return {
      ...identity,
      requestHash,
      kind: "github" as const,
      authority: {
        grantId: proof.grantId,
        clientId: identity.clientId,
        consentHash: identity.consentHash,
        action: "sources:link" as const,
      },
      projectIds: [] as string[],
      allowCreate: false,
      allowPublish: false,
      secretTarget: null,
      githubTarget: { idempotencyKey: `feature-${requestHash}` },
      createdAt: "2026-10-28T12:05:00.000Z",
      expiresAt: "2026-10-28T12:15:00.000Z",
    };
  };

  it("answers the resend of a committed consumption instead of null, and only that exact decision", async () => {
    const s = await organizationWithOwner(0);
    await insertMcpHandoff(context, await handoff(s, hash(1)));
    let armed = true;
    const lossy: CatalogContext = {
      directory: control.directory,
      router: new SharedCoreRouter({
        prepare: (sql) => shardOf(control, 0).prepare(sql),
        batch: async (statements) => {
          const results = await shardOf(control, 0).batch(statements);
          const consumed = await shardOf(control, 0)
            .prepare(
              "SELECT 1 AS v FROM mcp_portal_handoffs WHERE request_hash = ? AND consumed_at IS NOT NULL",
            )
            .bind(hash(1))
            .first();
          if (armed && consumed !== null) {
            armed = false;
            throw new Error("Network connection lost");
          }
          return results;
        },
      }),
    };
    const consume = (ctx: CatalogContext, now: string, approve = true) =>
      consumeMcpHandoff(ctx, {
        requestHash: hash(1),
        userId: s.owner,
        organizationId: s.organizationId,
        now,
        approve,
        publish: false,
      });
    const answered = await consume(lossy, "2026-10-28T12:10:00.000Z");
    expect(answered).toMatchObject({
      outcome: "github_started",
      consumedAt: "2026-10-28T12:10:00.000Z",
    });
    expect(
      await count(
        shardOf(control, 0),
        "SELECT count(*) AS n FROM mcp_client_grants WHERE organization_id = ?",
        s.organizationId,
      ),
    ).toBe(1);
    // the same decision at the same instant is the same command: it answers again
    expect(await consume(context, "2026-10-28T12:10:00.000Z")).toMatchObject({
      outcome: "github_started",
    });
    // a LATER resend, another instant or the other decision is a different command: single use holds
    expect(await consume(context, "2026-10-28T12:11:00.000Z")).toBeNull();
    expect(await consume(context, "2026-10-28T12:10:00.000Z", false)).toBeNull();
    expect(await findMcpHandoff(context, { requestHash: hash(1) })).toMatchObject({
      outcome: "github_started",
    });
  });

  it("purges only handoff routes that expired before the cutoff, in bounded chunks", async () => {
    const s = await organizationWithOwner(1);
    const early = { createdAt: "2026-10-28T09:20:00.000Z", expiresAt: "2026-10-28T09:30:00.000Z" };
    await insertMcpHandoff(context, { ...(await handoff(s, hash(2))), ...early });
    await insertMcpHandoff(context, {
      ...(await handoff(s, hash(3))),
      createdAt: "2026-10-28T09:50:00.000Z",
      // A protected feature handoff lasts ten minutes; this one outlives the first cutoff.
      expiresAt: "2026-10-28T10:00:00.000Z",
    });
    const routes = () =>
      count(
        control.directory,
        "SELECT count(*) AS n FROM mcp_handoff_routes WHERE organization_id = ?",
        s.organizationId,
      );
    expect(await routes()).toBe(2);
    expect(
      await purgeMcpHandoffRoutes(context, { before: "2026-10-28T09:29:59.000Z", limit: 10 }),
    ).toBe(0);
    expect(
      await purgeMcpHandoffRoutes(context, { before: "2026-10-28T09:30:00.000Z", limit: 10 }),
    ).toBe(1);
    expect(await routes()).toBe(1);
    expect(await findMcpHandoff(context, { requestHash: hash(3) })).not.toBeNull();
    expect(
      await purgeMcpHandoffRoutes(context, { before: "2026-10-28T14:00:00.000Z", limit: 100 }),
    ).toBeGreaterThanOrEqual(1);
    expect(await routes()).toBe(0);
    // the shard row outlives its route harmlessly: it can no longer be found or consumed
    expect(await findMcpHandoff(context, { requestHash: hash(2) })).toBeNull();
  });
});
