import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { scope, sha, time } from "../support/cloudflare-fixtures.js";
import { seedProject, type SeededProject } from "../support/platform-fixtures.js";
import { cfFixture } from "../support/cf-mail-fixture.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control.dispose());

const apply = (p: SeededProject, hostname: string, overrides: Record<string, unknown> = {}) => ({
  ...scope(p),
  hostname,
  gatewayScriptName: "ohmyho-gateway-production",
  principalId: "user:owner",
  idempotencyKeySha256: sha(0x81),
  requestSha256: sha(0x82),
  now: time(0),
  auditEventId: newUlid(),
  ...overrides,
});

/** A verified Paid proof of the hostname, stored as the Paid proof record of its project and hostname. */
async function proveHostname(p: SeededProject, hostname: string) {
  await p.shard
    .prepare(
      `INSERT INTO paid_hostname_proofs(organization_id,project_id,hostname,state,challenge_name,challenge_value,declared_at,verified_at,expires_at)
       VALUES(?1,?2,?3,'verified',?4,?5,?6,?6,?7)`,
    )
    .bind(
      p.organizationId,
      p.projectId,
      hostname,
      `_omh-project.${hostname}`,
      `omh-domain-v1=${"a".repeat(43)}`,
      storedTimestamp(time(0)),
      storedTimestamp("2026-12-01T00:00:00.000Z"),
    )
    .run();
}

/** A project's verified application domain identity (its mail sender domain), stored as the mail identity records it. */
async function proveMailIdentity(p: SeededProject, hostname: string) {
  const registrable = hostname.split(".").slice(-2).join(".");
  await p.shard
    .prepare(
      `INSERT INTO project_application_domain_identities(organization_id,project_id,hostname,registrable_domain,revision,
        state,challenge_name,challenge_value,declared_at,verified_at,expires_at,idempotency_key_sha256,request_sha256,actor_id)
       VALUES(?1,?2,?3,?4,1,'verified',?5,?6,?7,?7,?8,?9,?10,'user:owner')`,
    )
    .bind(
      p.organizationId,
      p.projectId,
      hostname,
      registrable,
      `_omh-project.${hostname}`,
      `omh-domain-v1=${"a".repeat(43)}`,
      storedTimestamp(time(0)),
      storedTimestamp("2026-12-01T00:00:00.000Z"),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    )
    .run();
}

/** Ages an unproven awaiting reservation past the seven-day hold. */
async function ageReservation(p: SeededProject) {
  const old = storedTimestamp("2026-10-01T00:00:00.000Z");
  await p.shard
    .prepare(
      "UPDATE paid_project_domains SET created_at=?3, updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(p.organizationId, p.projectId, old)
    .run();
}

/**
 * The database as a concurrent writer would leave it: `before` runs once, just before the claim's write batch, after
 * the claim has read the proof and the holders.
 */
function beforeWriteBatch(db: D1Database, before: () => Promise<void>): D1Database {
  let pending = true;
  type Wrapped = { inner: D1PreparedStatement; sql: string };
  const wrap = (inner: D1PreparedStatement, sql: string): Wrapped & D1PreparedStatement =>
    ({
      inner,
      sql,
      bind: (...values: unknown[]) => wrap(inner.bind(...values), sql),
      first: (...args: []) => inner.first(...args),
      all: () => inner.all(),
      run: () => inner.run(),
    }) as unknown as Wrapped & D1PreparedStatement;
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (statements: unknown[]) => {
      const wrapped = statements as Wrapped[];
      if (
        pending &&
        wrapped.some((statement) => /^\s*INSERT INTO paid_project_domains/u.test(statement.sql))
      ) {
        pending = false;
        await before();
      }
      return db.batch(wrapped.map((statement) => statement.inner));
    },
  } as unknown as D1Database;
}

describe("paid hostname proof", () => {
  it("lets a project with a verified proof take a hostname that only an unproven reservation holds", async () => {
    const hostname = "shop.proof-one.example";
    const squatter = await seedProject(control);
    const owner = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(apply(squatter, hostname));
    await proveHostname(owner, hostname);

    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(owner, hostname, { idempotencyKeySha256: sha(0x83), requestSha256: sha(0x84) }),
      ),
    ).resolves.toMatchObject({ hostname, state: "pending", hostnameProven: true });
  });

  it("refuses an unproven claim while another project's proven hold stands, and a second proven claim too", async () => {
    const hostname = "shop.proof-two.example";
    const owner = await seedProject(control);
    const unproven = await seedProject(control);
    const rival = await seedProject(control);
    await proveHostname(owner, hostname);
    await store.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname));
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(unproven, hostname)),
    ).rejects.toMatchObject({ name: "PaidDomainHostnameTakenError" });

    await proveHostname(rival, hostname);
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(rival, hostname)),
    ).rejects.toMatchObject({ name: "PaidDomainHostnameTakenError" });
  });

  it("holds a hostname against an unproven claim for seven days only", async () => {
    const fresh = "shop.proof-three.example";
    const stale = "shop.proof-four.example";
    const first = await seedProject(control);
    const second = await seedProject(control);
    const aged = await seedProject(control);
    const third = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(
      apply(first, fresh, { gatewayScriptName: null }),
    );
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(second, fresh, { gatewayScriptName: null }),
      ),
    ).rejects.toMatchObject({ name: "PaidDomainHostnameTakenError" });

    await store.cloudflareDomain.claimPaidDomainApply(
      apply(aged, stale, { gatewayScriptName: null }),
    );
    await ageReservation(aged);
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(third, stale, { gatewayScriptName: null })),
    ).resolves.toMatchObject({ hostname: stale, hostnameProven: false });
  });

  it("upgrades an unproven connection once the project proves the hostname, under a new key", async () => {
    const hostname = "shop.proof-upgrade.example";
    const owner = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(
      apply(owner, hostname, { idempotencyKeySha256: sha(0x85), requestSha256: sha(0x86) }),
    );
    await proveHostname(owner, hostname);

    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(owner, hostname, { idempotencyKeySha256: sha(0x87), requestSha256: sha(0x88) }),
      ),
    ).resolves.toMatchObject({ hostname, state: "pending", hostnameProven: true });
    // The new key is now the connection's key: the same request replays as it.
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(owner, hostname, { idempotencyKeySha256: sha(0x87), requestSha256: sha(0x88) }),
      ),
    ).resolves.toMatchObject({ hostname, hostnameProven: true });
  });

  it("stores the proof the write sees, not the proof the claim read before it", async () => {
    const hostname = "shop.proof-race-one.example";
    const owner = await seedProject(control);
    await proveHostname(owner, hostname);
    const racing = createControlStore({
      CONTROL_CORE: beforeWriteBatch(control.core, async () => {
        await control.core
          .prepare(
            "UPDATE paid_hostname_proofs SET state='pending', verified_at=NULL, expires_at=NULL WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(owner.organizationId, owner.projectId)
          .run();
      }),
    });
    await expect(
      racing.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname)),
    ).resolves.toMatchObject({ hostname, hostnameProven: false });
  });

  it("answers a proven claim that loses the hostname at write time as taken, not as a store fault", async () => {
    const hostname = "shop.proof-race-two.example";
    const owner = await seedProject(control);
    const rival = await seedProject(control);
    await proveHostname(owner, hostname);
    const racing = createControlStore({
      CONTROL_CORE: beforeWriteBatch(control.core, async () => {
        await proveHostname(rival, hostname);
        await control.core
          .prepare(
            `INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at,hostname_proven_at)
             VALUES(?1,?2,?3,'ohmyho-gateway-production','pending','user:rival',?4,?5,?6,?6,?6,?6)`,
          )
          .bind(
            rival.organizationId,
            rival.projectId,
            hostname,
            new Uint8Array(32).fill(0x9a),
            new Uint8Array(32).fill(0x9b),
            storedTimestamp(time(0)),
          )
          .run();
      }),
    });
    await expect(
      racing.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname)),
    ).rejects.toMatchObject({ name: "PaidDomainHostnameTakenError" });
  });

  it("displaces an unproven connection when a proven owner claims its hostname, and that owner is refused as taken", async () => {
    const hostname = "shop.proof-displace.example";
    const unproven = await seedProject(control);
    const proven = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(apply(unproven, hostname));
    await proveHostname(proven, hostname);
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(proven, hostname)),
    ).resolves.toMatchObject({ hostname, hostnameProven: true });

    const row = await unproven.shard
      .prepare("SELECT state FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2")
      .bind(unproven.organizationId, unproven.projectId)
      .first<{ state: string }>();
    expect(row?.state).toBe("displaced");
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(unproven, hostname, { idempotencyKeySha256: sha(0x9c), requestSha256: sha(0x9d) }),
      ),
    ).rejects.toMatchObject({ name: "PaidDomainHostnameTakenError" });
  });

  /** The holder lets go of its hostname: its connection is deleted, as the deletion completes it. */
  async function releaseHold(p: SeededProject) {
    const at = storedTimestamp(time(1));
    await p.shard
      .prepare(
        "UPDATE paid_project_domains SET state='deleted',deleted_at=?3,updated_at=?3,delete_idempotency_sha256=?4,delete_request_sha256=?4 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId, at, new Uint8Array(32).fill(0xd1))
      .run();
  }

  it("lets a displaced owner recover under its own key once it proves the hostname and the holder lets go", async () => {
    const hostname = "shop.proof-recover.example";
    const unproven = await seedProject(control);
    const proven = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(apply(unproven, hostname));
    await proveHostname(proven, hostname);
    await store.cloudflareDomain.claimPaidDomainApply(apply(proven, hostname));
    await releaseHold(proven);
    await proveHostname(unproven, hostname);

    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(unproven, hostname)),
    ).resolves.toMatchObject({ hostname, state: "pending", hostnameProven: true });
    const row = await unproven.shard
      .prepare(
        "SELECT state,hostname_proven_at FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(unproven.organizationId, unproven.projectId)
      .first<{ state: string; hostname_proven_at: string | null }>();
    expect(row?.state).toBe("pending");
    expect(row?.hostname_proven_at).not.toBeNull();
  });

  it("re-applies a displaced connection as a fresh one, even under its old key, without a production deployment error", async () => {
    const hostname = "shop.proof-fresh.example";
    const unproven = await seedProject(control);
    const proven = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(apply(unproven, hostname));
    await proveHostname(proven, hostname);
    await store.cloudflareDomain.claimPaidDomainApply(apply(proven, hostname));
    await releaseHold(proven);

    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(unproven, hostname, { gatewayScriptName: null }),
      ),
    ).resolves.toMatchObject({ hostname, state: "awaiting_deployment", hostnameProven: false });
    const row = await unproven.shard
      .prepare("SELECT state FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2")
      .bind(unproven.organizationId, unproven.projectId)
      .first<{ state: string }>();
    expect(row?.state).toBe("awaiting_deployment");
  });

  it("does not take a verified mail identity for the hostname as its Paid proof", async () => {
    const hostname = "shop.mail-identity.example";
    const owner = await seedProject(control);
    await proveMailIdentity(owner, hostname);
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname)),
    ).resolves.toMatchObject({ hostname, hostnameProven: false });
  });

  it("does not prove a Paid hostname from a Paid proof that has expired", async () => {
    const hostname = "shop.expired-proof.example";
    const owner = await seedProject(control);
    await proveHostname(owner, hostname);
    await owner.shard
      .prepare(
        "UPDATE paid_hostname_proofs SET verified_at=?3, expires_at=?4 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(
        owner.organizationId,
        owner.projectId,
        storedTimestamp("2020-01-01T00:00:00.000Z"),
        storedTimestamp("2020-02-01T00:00:00.000Z"),
      )
      .run();
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname)),
    ).resolves.toMatchObject({ hostname, hostnameProven: false });
  });

  it("proves a Paid hostname without revoking the project's mail identity", async () => {
    const owner = await seedProject(control);
    await proveMailIdentity(owner, "mail.identity-kept.example");
    const hostname = "shop.identity-kept.example.net";
    await proveHostname(owner, hostname);
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname)),
    ).resolves.toMatchObject({ hostname, state: "pending", hostnameProven: true });
    const identity = await owner.shard
      .prepare(
        "SELECT state FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(owner.organizationId, owner.projectId)
      .first<{ state: string }>();
    expect(identity?.state).toBe("verified");
  });

  it("declares a mail identity for another domain while a live Paid hostname sits outside it", async () => {
    const owner = await seedProject(control);
    const hostname = "shop.mail-free.example.org";
    await proveHostname(owner, hostname);
    await store.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname));
    await expect(proveMailIdentity(owner, "mail.elsewhere.example.com")).resolves.toBeUndefined();
  });
});

describe("paid hostname proof records", () => {
  const challenge = (letter: string) => `omh-domain-v1=${letter.repeat(43)}`;
  const ensure = (p: SeededProject, hostname: string, letter: string, now: string) =>
    store.cloudflareDomain.ensurePaidDomainProof({
      ...scope(p),
      hostname,
      challengeValue: challenge(letter),
      now,
    });
  const verify = (p: SeededProject, hostname: string, letter: string, now: string) =>
    store.cloudflareDomain.verifyPaidDomainProof({
      ...scope(p),
      hostname,
      challengeValue: challenge(letter),
      now,
      expiresAt: "2026-12-01T00:00:00.000Z",
    });

  it("issues one pending challenge per project and hostname, and keeps the first", async () => {
    const hostname = "shop.record-one.example";
    const owner = await seedProject(control);
    const first = await ensure(owner, hostname, "a", time(0));
    const second = await ensure(owner, hostname, "b", time(1));
    expect(first).toMatchObject({
      hostname,
      state: "pending",
      challengeName: `_omh-project.${hostname}`,
      challengeValue: challenge("a"),
      verifiedAt: null,
      expiresAt: null,
    });
    expect(second).toEqual(first);
  });

  it("verifies a pending challenge only with its exact value, and that proof then serves a claim", async () => {
    const hostname = "shop.record-two.example";
    const owner = await seedProject(control);
    await ensure(owner, hostname, "c", time(0));
    await expect(verify(owner, hostname, "d", time(1))).resolves.toBeNull();
    await expect(verify(owner, hostname, "c", time(1))).resolves.toMatchObject({
      state: "verified",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(owner, hostname)),
    ).resolves.toMatchObject({
      hostname,
      hostnameProven: true,
    });
  });

  it("reads a hostname's challenge at any time, and the latest pending one of the project within seven days", async () => {
    const owner = await seedProject(control);
    const older = "shop.record-three.example";
    const newer = "shop.record-four.example";
    await ensure(owner, older, "e", time(0));
    await ensure(owner, newer, "f", time(1));
    await expect(
      store.cloudflareDomain.readPaidDomainProof({
        ...scope(owner),
        hostname: older,
        now: "2027-06-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ hostname: older, challengeValue: challenge("e") });
    await expect(
      store.cloudflareDomain.readPaidDomainProof({ ...scope(owner), hostname: null, now: time(2) }),
    ).resolves.toMatchObject({ hostname: newer, challengeValue: challenge("f") });
    await expect(
      store.cloudflareDomain.readPaidDomainProof({
        ...scope(owner),
        hostname: null,
        now: "2026-11-30T00:00:00.000Z",
      }),
    ).resolves.toBeNull();
  });

  it("verifies an expired proof again with its challenge, and leaves a live proof alone", async () => {
    const hostname = "shop.record-five.example";
    const owner = await seedProject(control);
    await ensure(owner, hostname, "g", time(0));
    await verify(owner, hostname, "g", time(1));
    await expect(verify(owner, hostname, "g", time(2))).resolves.toBeNull();
    await owner.shard
      .prepare(
        "UPDATE paid_hostname_proofs SET verified_at=?3, expires_at=?4 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(
        owner.organizationId,
        owner.projectId,
        storedTimestamp("2020-01-01T00:00:00.000Z"),
        storedTimestamp("2020-02-01T00:00:00.000Z"),
      )
      .run();
    await expect(verify(owner, hostname, "g", time(3))).resolves.toMatchObject({
      state: "verified",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
  });
});

describe("paid hostname proof ends with its connection", () => {
  it("forgets the proof of a deleted connection, so the same hostname needs a fresh proof", async () => {
    const hostname = "shop.ends-with-connection.example";
    const owner = await cfFixture(control);
    const p = owner.project;
    await proveHostname(p, hostname);
    await store.cloudflareDomain.claimPaidDomainApply(
      apply(p, hostname, { principalId: owner.principalId }),
    );
    await store.cloudflareDomain.claimPaidDomainDelete({
      ...scope(p),
      hostname,
      principalId: owner.principalId,
      idempotencyKeySha256: sha(0x91),
      requestSha256: sha(0x92),
      now: time(1),
    });
    await store.cloudflareDomain.markPaidDomainDeleted({
      ...scope(p),
      hostname,
      idempotencyKeySha256: sha(0x91),
      now: time(2),
    });
    const left = await p.shard
      .prepare(
        "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(
        apply(p, hostname, {
          principalId: owner.principalId,
          idempotencyKeySha256: sha(0x93),
          requestSha256: sha(0x94),
        }),
      ),
    ).resolves.toMatchObject({ hostname, hostnameProven: false });
  });
});

describe("paid hostname proof budget", () => {
  const issue = (p: SeededProject, hostname: string, now: string = time(0)) =>
    store.cloudflareDomain.ensurePaidDomainProof({
      ...scope(p),
      hostname,
      challengeValue: `omh-domain-v1=${"d".repeat(43)}`,
      now,
    });
  const read = (p: SeededProject, hostname: string | null, now: string = time(0)) =>
    store.cloudflareDomain.readPaidDomainProof({ ...scope(p), hostname, now });

  it("issues at most ten pending challenges per project, and none for an eleventh hostname", async () => {
    const owner = await seedProject(control);
    for (let n = 0; n < 10; n += 1)
      await expect(issue(owner, `budget-${n}.cap-budget.example`)).resolves.toMatchObject({
        hostname: `budget-${n}.cap-budget.example`,
      });
    await expect(issue(owner, "budget-10.cap-budget.example")).resolves.toBeNull();
    await expect(read(owner, "budget-10.cap-budget.example")).resolves.toBeNull();
    const pending = await owner.shard
      .prepare(
        "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND state='pending'",
      )
      .bind(owner.organizationId, owner.projectId)
      .first<{ n: number }>();
    expect(pending?.n).toBe(10);
  });

  it("prunes a pending challenge older than seven days unless it is the project's connection hostname", async () => {
    const owner = await seedProject(control);
    const stale = "stale.prune-budget.example";
    const connected = "connected.prune-budget.example";
    await issue(owner, stale, time(0));
    await issue(owner, connected, time(0));
    await store.cloudflareDomain.claimPaidDomainApply(
      apply(owner, connected, { gatewayScriptName: null }),
    );
    await issue(owner, "fresh.prune-budget.example", "2026-11-30T00:00:00.000Z");
    await expect(read(owner, stale, "2026-11-30T00:00:00.000Z")).resolves.toBeNull();
    await expect(read(owner, connected, "2026-11-30T00:00:00.000Z")).resolves.toMatchObject({
      hostname: connected,
    });
  });
});

describe("paid hostname proof for an inactive project", () => {
  it("issues no challenge for a project that is leaving its active lifecycle", async () => {
    const owner = await seedProject(control);
    await owner.shard
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting', lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(owner.organizationId, owner.projectId)
      .run();
    await expect(
      store.cloudflareDomain.ensurePaidDomainProof({
        ...scope(owner),
        hostname: "inactive.inactive-proof.example",
        challengeValue: `omh-domain-v1=${"e".repeat(43)}`,
        now: time(0),
      }),
    ).resolves.toBeNull();
  });
});

describe("paid hostname proof is not shared between projects", () => {
  it("does not let another project's proof or challenge value satisfy a claim", async () => {
    const hostname = "shop.cross-project.example";
    const proven = await seedProject(control);
    const other = await seedProject(control);
    await proveHostname(proven, hostname);
    await store.cloudflareDomain.ensurePaidDomainProof({
      ...scope(other),
      hostname,
      challengeValue: `omh-domain-v1=${"f".repeat(43)}`,
      now: time(0),
    });
    await expect(
      store.cloudflareDomain.verifyPaidDomainProof({
        ...scope(other),
        hostname,
        challengeValue: `omh-domain-v1=${"a".repeat(43)}`,
        now: time(1),
        expiresAt: "2026-12-01T00:00:00.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(other, hostname)),
    ).resolves.toMatchObject({ hostname, hostnameProven: false });
  });
});

describe("paid claim after a lost reply", () => {
  it("names a fresh key's apply by the connection it meets, never by the other key's replay", async () => {
    const owner = await seedProject(control);
    // The first attempt is accepted. Another claim of the project lands before this batch, and the reply of
    // this batch is lost before it writes anything: the outcome is unknown and only the lookup can answer it.
    const lost = createControlStore({
      CONTROL_CORE: beforeWriteBatch(control.core, async () => {
        await store.cloudflareDomain.claimPaidDomainApply(
          apply(owner, "shop.lost-first.example", {
            idempotencyKeySha256: sha(0x85),
            requestSha256: sha(0x86),
          }),
        );
        throw new Error("Network connection lost");
      }),
    });
    await expect(
      lost.cloudflareDomain.claimPaidDomainApply(
        apply(owner, "shop.lost-second.example", {
          idempotencyKeySha256: sha(0x83),
          requestSha256: sha(0x84),
        }),
      ),
    ).rejects.toMatchObject({ name: "PaidDomainAlreadyConfiguredError" });
  });
});
