import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid, type CatalogContext } from "../src/catalog/common.js";
import {
  applyWorkosSnapshot,
  isSessionEligible,
} from "../src/catalog/identity/membership-state.js";
import {
  createWorkosCallerCommands,
  readSessionRevocation,
  recordUserApiKeyRevocationAudit,
} from "../src/catalog/identity/workos-caller-commands.js";
import { recordTerminalRevocation } from "../src/catalog/identity/membership-state.js";
import { withRouteRefresh } from "../src/fence.js";
import type { D1Database } from "../src/d1-types.js";
import {
  coreRouter,
  createTestControl,
  losingNthResponse,
  organizationIdWithShard,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";
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

const at = (second: number) => `2026-10-28T13:00:${String(second).padStart(2, "0")}.000Z`;

async function seed(shard = 0) {
  sequence += 1;
  const organizationId = await organizationIdWithShard(2, shard, 11_000_000 + sequence * 7919);
  const workos = `org_wc_${sequence}`;
  const owner = `user_wcowner${sequence}`;
  await applyWorkosSnapshot(context, {
    organizationId,
    workosOrganizationId: workos,
    state: "active",
    snapshotDigest: digest(sequence + 5000),
    snapshotFetchedAt: at(1),
    synchronizedAt: at(2),
    triggerEventId: `event_wc_${sequence}`,
    auditEventId: newUlid(),
    memberships: [
      { workosUserId: owner, role: "admin", status: "active", digest: digest(sequence + 9000) },
    ],
  });
  return { organizationId, workos, owner, shard };
}

const audit = (s: Awaited<ReturnType<typeof seed>>, change: Record<string, unknown> = {}) => ({
  organizationId: s.organizationId,
  workosOrganizationId: s.workos,
  userId: s.owner,
  keyId: "api_key_1",
  stage: "requested" as const,
  auditEventId: newUlid(),
  now: at(10),
  ...change,
});

const auditRows = async (s: Awaited<ReturnType<typeof seed>>) =>
  (
    await shardOf(control, s.shard)
      .prepare(
        "SELECT event_type, actor_type, actor_id, payload FROM organization_audit_events WHERE organization_id = ? AND event_type LIKE 'UserApiKeyRevo%' ORDER BY occurred_at, audit_event_id",
      )
      .bind(s.organizationId)
      .all<{ event_type: string; actor_type: string; actor_id: string; payload: string }>()
  ).results;

describe("identity.readSessionRevocation", () => {
  it("answers the owner of a terminally revoked session from the directory and null for an unknown one", async () => {
    await recordTerminalRevocation(context, {
      kind: "session",
      sessionId: "session_wc_revoked",
      workosUserId: "user_wc_a",
      sourceEventId: "logout_wc_1",
      effectiveAt: at(5),
    });
    expect(await readSessionRevocation(context, { sessionId: "session_wc_revoked" })).toEqual({
      workosUserId: "user_wc_a",
    });
    expect(await readSessionRevocation(context, { sessionId: "session_wc_never" })).toBeNull();
    // A user revocation with the same id string is not a session revocation.
    await recordTerminalRevocation(context, {
      kind: "user",
      workosUserId: "user_wc_b",
      sourceEventId: "rev_wc_user",
      effectiveAt: at(5),
    });
    expect(await readSessionRevocation(context, { sessionId: "session_wc_user" })).toBeNull();
  });

  it("refuses anything but the strict session id", async () => {
    await expect(readSessionRevocation(context, { sessionId: "x" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      readSessionRevocation(context, { sessionId: "session_ok", extra: 1 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("identity.recordUserApiKeyRevocationAudit", () => {
  it("records the two closed stages once, replays an identical repeat and refuses another content under the id", async () => {
    const s = await seed(0);
    const requested = audit(s);
    expect(await recordUserApiKeyRevocationAudit(context, requested)).toEqual({ recorded: true });
    expect(await recordUserApiKeyRevocationAudit(context, requested)).toEqual({ recorded: true });
    expect(
      await recordUserApiKeyRevocationAudit(context, audit(s, { stage: "revoked", now: at(11) })),
    ).toEqual({ recorded: true });
    expect(await auditRows(s)).toEqual([
      {
        event_type: "UserApiKeyRevocationRequested",
        actor_type: "principal",
        actor_id: `user:${s.owner}`,
        payload: '{"key_id":"api_key_1"}',
      },
      {
        event_type: "UserApiKeyRevoked",
        actor_type: "principal",
        actor_id: `user:${s.owner}`,
        payload: '{"key_id":"api_key_1"}',
      },
    ]);
    await expect(
      recordUserApiKeyRevocationAudit(context, { ...requested, keyId: "api_key_2" }),
    ).rejects.toMatchObject({ code: "result_conflict" });
    await expect(
      recordUserApiKeyRevocationAudit(context, { ...requested, stage: "revoked" }),
    ).rejects.toMatchObject({ code: "result_conflict" });
    expect(await auditRows(s)).toHaveLength(2);
  });

  it("refuses another tenant's identity, an unknown organization and any open-ended field", async () => {
    const s = await seed(0);
    const other = await seed(1);
    await expect(
      recordUserApiKeyRevocationAudit(context, audit(s, { workosOrganizationId: other.workos })),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(
      recordUserApiKeyRevocationAudit(
        context,
        audit(s, { organizationId: await organizationIdWithShard(2, 0, 77_000_001) }),
      ),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    for (const forged of [
      { eventType: "OrganizationDeleted" },
      { actorId: "user:someone_else" },
      { payload: { anything: true } },
      { stage: "deleted" },
      { keyId: "key_1" },
      { userId: "someone" },
    ]) {
      await expect(
        recordUserApiKeyRevocationAudit(context, audit(s, forged)),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(await auditRows(s)).toEqual([]);
    expect(await auditRows(other)).toEqual([]);
  });

  it("answers the original event after a lost response and writes it once", async () => {
    const s = await seed(1);
    const lossy: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, {
        ...control.shards,
        CONTROL_SHARD_0001: losingNthResponse(shardOf(control, 1), 3),
      }),
    };
    const request = audit(s);
    expect(await recordUserApiKeyRevocationAudit(lossy, request)).toEqual({ recorded: true });
    expect(await auditRows(s)).toHaveLength(1);
  });

  it("aborts the write whole when the organization mapping changes between the read and the batch", async () => {
    const s = await seed(0);
    const db = shardOf(control, 0);
    const racing: D1Database = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        // The read is a two-statement batch (bucket check + snapshot); the write carries the guard and the event.
        if (statements.length > 2) {
          await db
            .prepare(
              "UPDATE organizations SET workos_organization_id = ? WHERE organization_id = ?",
            )
            .bind("org_wc_moved", s.organizationId)
            .run();
        }
        return db.batch(statements);
      },
    };
    const racingContext: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, { ...control.shards, CONTROL_SHARD_0000: racing }),
    };
    await expect(recordUserApiKeyRevocationAudit(racingContext, audit(s))).rejects.toMatchObject({
      code: "resource_not_found",
    });
    expect(await auditRows(s)).toEqual([]);
  });

  it("binds both commands through the store's fence and route refresh", async () => {
    const s = await seed(0);
    const commands = createWorkosCallerCommands(
      (command) => (input) => withRouteRefresh(context.router, () => command(context, input)),
    );
    expect(Object.keys(commands).sort()).toEqual([
      "readSessionRevocation",
      "recordUserApiKeyRevocationAudit",
    ]);
    expect(await commands.recordUserApiKeyRevocationAudit(audit(s))).toEqual({ recorded: true });
    expect(await commands.readSessionRevocation({ sessionId: "session_wc_none" })).toBeNull();
  });

  it("writes the revoked stage once per key: a retry adds nothing, and a key never requested writes nothing", async () => {
    const s = await seed(0);
    // Never requested by this user: nothing to attach the revoked stage to, so nothing is written.
    expect(
      await recordUserApiKeyRevocationAudit(
        context,
        audit(s, { stage: "revoked", keyId: "api_key_never" }),
      ),
    ).toEqual({ recorded: true });
    expect(
      await recordUserApiKeyRevocationAudit(
        context,
        audit(s, { stage: "revoked", userId: "user_wcother" }),
      ),
    ).toEqual({ recorded: true });
    expect(await auditRows(s)).toEqual([]);
    expect(await recordUserApiKeyRevocationAudit(context, audit(s))).toEqual({ recorded: true });
    expect(
      await recordUserApiKeyRevocationAudit(context, audit(s, { stage: "revoked", now: at(11) })),
    ).toEqual({ recorded: true });
    // The provider key was already gone on the retry: its revoked stage has a fresh audit id and adds nothing.
    expect(
      await recordUserApiKeyRevocationAudit(context, audit(s, { stage: "revoked", now: at(12) })),
    ).toEqual({ recorded: true });
    expect(await auditRows(s)).toEqual([
      {
        event_type: "UserApiKeyRevocationRequested",
        actor_type: "principal",
        actor_id: `user:${s.owner}`,
        payload: '{"key_id":"api_key_1"}',
      },
      {
        event_type: "UserApiKeyRevoked",
        actor_type: "principal",
        actor_id: `user:${s.owner}`,
        payload: '{"key_id":"api_key_1"}',
      },
    ]);
  });

  it("aborts a revoked write that a concurrent attempt recorded first, and answers the retry without a duplicate", async () => {
    const s = await seed(0);
    expect(await recordUserApiKeyRevocationAudit(context, audit(s))).toEqual({ recorded: true });
    const db = shardOf(control, 0);
    let injected = false;
    // The concurrent attempt records its revoked stage after this attempt's read and before its write batch.
    const racing: D1Database = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        if (statements.length > 2 && !injected) {
          injected = true;
          await db
            .prepare(
              "INSERT INTO organization_audit_events(organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            )
            .bind(
              s.organizationId,
              newUlid(),
              "UserApiKeyRevoked",
              "principal",
              `user:${s.owner}`,
              '{"key_id":"api_key_1"}',
              "2026-10-28T13:00:11.000000Z",
            )
            .run();
        }
        return db.batch(statements);
      },
    };
    const racingContext: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, { ...control.shards, CONTROL_SHARD_0000: racing }),
    };
    expect(
      await recordUserApiKeyRevocationAudit(
        racingContext,
        audit(s, { stage: "revoked", now: at(12) }),
      ),
    ).toEqual({ recorded: true });
    expect(injected).toBe(true);
    expect(await auditRows(s)).toEqual([
      {
        event_type: "UserApiKeyRevocationRequested",
        actor_type: "principal",
        actor_id: `user:${s.owner}`,
        payload: '{"key_id":"api_key_1"}',
      },
      {
        event_type: "UserApiKeyRevoked",
        actor_type: "principal",
        actor_id: `user:${s.owner}`,
        payload: '{"key_id":"api_key_1"}',
      },
    ]);
  });
});

describe("identity.isSessionEligible final directory recheck", () => {
  it("denies when a terminal revocation lands between the directory read and the shard read", async () => {
    const s = await seed(0);
    const db = shardOf(control, 0);
    let injected = false;
    // The shard answer is read after the first directory check. The membership read reaches the shard as one
    // fenced batch; a revocation committed right after it must not be combined with the active membership the
    // shard reported: the final primary re-check denies it.
    const racing: D1Database = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        const results = await db.batch(statements);
        if (!injected) {
          injected = true;
          await recordTerminalRevocation(context, {
            kind: "user",
            workosUserId: s.owner,
            sourceEventId: `rev_race_${sequence}`,
            effectiveAt: at(20),
          });
        }
        return results;
      },
    };
    const racingContext: CatalogContext = {
      directory: control.directory,
      router: coreRouter(control, { ...control.shards, CONTROL_SHARD_0000: racing }),
    };
    const input = {
      sessionId: "session_race",
      workosUserId: s.owner,
      workosOrganizationId: s.workos,
      observedAt: at(30),
    };
    expect(await isSessionEligible(racingContext, input)).toBe(false);
    expect(injected).toBe(true);
    // Control: without the revocation the same call is eligible.
    const clean = await seed(0);
    expect(
      await isSessionEligible(context, {
        ...input,
        workosUserId: clean.owner,
        workosOrganizationId: clean.workos,
      }),
    ).toBe(true);
  });
});
