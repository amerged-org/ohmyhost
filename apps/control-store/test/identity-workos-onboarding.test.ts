import { afterAll, beforeAll, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createD1OnboardingPersistence } from "../../workos-management/src/d1-onboarding-port.js";
import { createD1CreditWarningPersistence } from "../../workos-management/src/d1-credit-warning-port.js";
import { projectInput } from "./support/seed.js";

import { bucketOf } from "../src/router.js";
import { newUlid } from "../src/catalog/common.js";
import { readAccount, runGrantCredit } from "../src/catalog/credit/index.js";
import { createControlStore } from "../src/store.js";
import { accountOf, credits, logOf } from "./credit/support.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
let port: ReturnType<typeof createD1OnboardingPersistence>;
const now = () => new Date().toISOString();
const stored = (value: string) => value.replace(/Z$/u, "000Z");
const rows = async (sql: string, ...values: unknown[]) =>
  (
    await control.core
      .prepare(sql)
      .bind(...values)
      .all()
  ).results;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  port = createD1OnboardingPersistence(store.identity);
}, 240_000);
afterAll(async () => control?.dispose());
const request = (userId: string, source = "direct") => ({
  userId,
  sessionId: `session_${userId}`,
  name: `Workspace ${userId}`,
  signupSource: source,
  idempotencyKey: `key-${newUlid()}`,
});

it("prepares durable provider identities and completes a Free workspace once while keeping initial-request and origin semantics", async () => {
  const input = request("user_onboard_direct");
  const prepared = await store.identity.prepareWorkosOnboarding({
    request: input,
    proposedRequestId: newUlid(),
    now: now(),
  });
  const id = prepared.row.request_id,
    workosId = `org_${id}`;
  expect(prepared.request).toEqual(input);
  expect(
    await rows(
      "SELECT origin_source,origin_present,attributed_source,bonus_micros,first_request_id FROM user_signup WHERE workos_user_id=?",
      input.userId,
    ),
  ).toEqual([
    {
      origin_source: "direct",
      origin_present: 1,
      attributed_source: "direct",
      bonus_micros: "0",
      first_request_id: id,
    },
  ]);
  expect(
    await store.identity.claimWorkosOnboardingOrganization({ requestId: id, userId: input.userId }),
  ).toBe(true);
  expect(
    await store.identity.claimWorkosOnboardingOrganization({ requestId: id, userId: input.userId }),
  ).toBe(false);
  expect(
    await store.identity.claimWorkosOnboardingOrganization({
      requestId: id,
      userId: "user_foreign",
    }),
  ).toBe(false);
  await store.identity.recordWorkosOnboardingOrganization({
    requestId: id,
    userId: input.userId,
    workosOrganizationId: workosId,
  });
  await store.identity.recordWorkosOnboardingOrganization({
    requestId: id,
    userId: input.userId,
    workosOrganizationId: workosId,
  });
  expect(
    await store.identity.claimWorkosOnboardingMembership({ requestId: id, userId: input.userId }),
  ).toBe(true);
  expect(
    await store.identity.claimWorkosOnboardingMembership({ requestId: id, userId: input.userId }),
  ).toBe(false);
  const complete = {
    request: input,
    requestId: id,
    workosOrganizationId: workosId,
    membershipUpdatedAt: now(),
    now: now(),
  };
  expect(await store.identity.completeWorkosOnboarding(complete)).toEqual({ id, name: input.name });
  expect(
    await rows(
      "SELECT state,beta_admitted_at IS NOT NULL AS beta FROM organizations WHERE organization_id=?",
      id,
    ),
  ).toEqual([{ state: "active", beta: 1 }]);
  expect(
    await rows("SELECT role,state FROM organization_memberships WHERE organization_id=?", id),
  ).toEqual([{ role: "admin", state: "active" }]);
  expect(
    await rows(
      "SELECT role FROM local_authorization_grants WHERE organization_id=? AND revoked_at IS NULL",
      id,
    ),
  ).toEqual([{ role: "owner" }]);
  // the organization starts Free: its credit account exists from the first batch, lapsed, so the first write renews it
  expect(await accountOf(control.core, id)).toMatchObject({
    monthly_micros: 0,
    monthly_ends_at: "1970-01-01T00:00:00.000000Z",
    onetime_micros: 0,
    paid_until: null,
  });
  expect(await readAccount(control.core, id, now())).toMatchObject({
    monthlyMicros: credits(200),
    availableMicros: credits(200),
    paid: false,
  });
  expect(await logOf(control.core, id)).toEqual([]);
  expect(await rows("SELECT key FROM credit_grant WHERE organization_id=?", id)).toEqual([]);
  const warnings = createD1CreditWarningPersistence(store.identity);
  expect(await warnings.readScope(id, now())).toBeNull();
  // an exhaustion is the warning scope of exactly its instant
  const exhaustedAt = "2026-10-30T10:00:00.000Z";
  await control.core
    .prepare("UPDATE credit_account SET exhausted_at = ?2 WHERE organization_id = ?1")
    .bind(id, stored(exhaustedAt))
    .run();
  expect(await warnings.readScope(id, exhaustedAt)).not.toBeNull();
  expect(await warnings.readScope(id, "2026-10-30T10:00:01.000Z")).toBeNull();
  expect(await warnings.isOwner(parseUlid(id), input.userId)).toBe(true);
  expect(
    await port.isSessionEligible({
      sessionId: input.sessionId,
      workosUserId: input.userId,
      workosOrganizationId: null,
      observedAt: now(),
    }),
  ).toBe(true);
  const before = await rows("SELECT * FROM onboarding_requests WHERE request_id=?", id);
  expect(await store.identity.completeWorkosOnboarding({ ...complete, now: now() })).toEqual({
    id,
    name: input.name,
  });
  expect(await rows("SELECT * FROM onboarding_requests WHERE request_id=?", id)).toEqual(before);
  expect(
    (
      await rows("SELECT count(*) AS n FROM organization_audit_events WHERE organization_id=?", id)
    )[0],
  ).toEqual({ n: 1 });
  const initial = await store.identity.prepareWorkosOnboarding({
    request: {
      ...input,
      initial: true,
      name: "Ignored new initial name",
      idempotencyKey: "initial-fresh-key",
    },
    proposedRequestId: newUlid(),
    now: now(),
  });
  expect(initial.row.request_id).toBe(id);
  expect(initial.request.name).toBe(input.name);
  await expect(
    store.identity.prepareWorkosOnboarding({
      request: { ...input, name: "Changed same key" },
      proposedRequestId: newUlid(),
      now: now(),
    }),
  ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  await expect(
    store.identity.prepareWorkosOnboarding({
      request: { ...input, signupSource: "other" },
      proposedRequestId: newUlid(),
      now: now(),
    }),
  ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  await control.core
    .prepare("UPDATE local_authorization_grants SET revoked_at=?1 WHERE organization_id=?2")
    .bind(stored(now()), id)
    .run();
  await expect(
    store.identity.completeWorkosOnboarding({ ...complete, now: now() }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
});

/** Fail the final real D1 batch after every business/financial statement, without faking any persistence result. */
function rejectFinalBatch(db: TestControl["core"]): TestControl["core"] {
  const wrap = (
    inner: ReturnType<TestControl["core"]["prepare"]>,
    sql: string,
  ): ReturnType<TestControl["core"]["prepare"]> & {
    inner: ReturnType<TestControl["core"]["prepare"]>;
    sql: string;
  } => ({
    inner,
    sql,
    bind: (...args) => wrap(inner.bind(...args), sql),
    first: () => inner.first(),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const typed = statements as (ReturnType<TestControl["core"]["prepare"]> & {
        inner: ReturnType<TestControl["core"]["prepare"]>;
        sql: string;
      })[];
      const raw = typed.map((x) => x.inner);
      if (typed.some((x) => x.sql.startsWith("UPDATE onboarding_requests SET organization_id=")))
        raw.push(db.prepare("INSERT INTO guard_fail(code) VALUES ('claim_lost')"));
      return db.batch(raw);
    },
  };
}
async function accepted(input: ReturnType<typeof request>, existingWorkosId?: string) {
  const prepared = await port.prepare({
    request: input,
    proposedRequestId: newUlid(),
    now: now(),
  });
  const id = prepared.row.request_id;
  const workosOrganizationId = existingWorkosId ?? `org_${id}`;
  await port.claimOrganization(id, input.userId);
  await port.recordOrganization(id, input.userId, workosOrganizationId);
  await port.claimMembership(id, input.userId);
  return {
    request: prepared.request,
    requestId: id,
    workosOrganizationId,
    membershipUpdatedAt: now(),
    now: now(),
  };
}

it("commits the signup grants, the credit account and Paid access in one batch, or rolls everything back", async () => {
  const referrer = newUlid();
  await store.identity.applyOrganizationSnapshot({
    organizationId: referrer,
    workosOrganizationId: "org_referrer",
    state: "active",
    snapshotDigest: "ab".repeat(32),
    snapshotFetchedAt: now(),
    synchronizedAt: now(),
    triggerEventId: "evt_referrer",
    memberships: [],
    auditEventId: newUlid(),
  });
  const source = `ref-${referrer.toLowerCase()}`;
  await control.core
    .prepare("INSERT INTO signup_sources VALUES (?1,1,1,CAST(?2 AS INTEGER))")
    .bind(source, credits(500))
    .run();
  const complete = await accepted(request("user_referred_new", source));
  complete.membershipUpdatedAt = complete.membershipUpdatedAt.replace(/Z$/u, "123Z");
  const failing = createControlStore({ CONTROL_CORE: rejectFinalBatch(control.core) });
  await expect(failing.identity.completeWorkosOnboarding(complete)).rejects.toThrow(
    /guard_claim_lost/u,
  );
  for (const table of [
    "org_directory",
    "organizations",
    "organization_memberships",
    "local_authorization_grants",
    "audit_events",
    "organization_audit_events",
    "credit_account",
    "credit_grant",
    "credit_log",
  ])
    expect(
      await rows(`SELECT * FROM ${table} WHERE organization_id=?`, complete.requestId),
      table,
    ).toEqual([]);
  expect(
    await rows(
      "SELECT organization_id,completed_at FROM onboarding_requests WHERE request_id=?",
      complete.requestId,
    ),
  ).toEqual([{ organization_id: null, completed_at: null }]);
  const made = await port.complete(complete);
  expect(made.id).toBe(complete.requestId);
  // Free allowance, 500 bonus credits and 1000 referral credits; they never expire, so they sit in the one-time bucket
  expect(await accountOf(control.core, made.id)).toMatchObject({
    monthly_micros: credits(200),
    onetime_micros: credits(1500),
    paid_source: "granted",
    paid_until: stored(new Date(Date.parse(complete.now) + 30 * 86_400_000).toISOString()),
  });
  expect(
    await rows(
      "SELECT key,amount_micros,paid_minor,reversed_micros FROM credit_grant WHERE organization_id=? ORDER BY key",
      made.id,
    ),
  ).toEqual([
    {
      key: `referral_signup:${complete.request.userId}`,
      amount_micros: credits(1000),
      paid_minor: null,
      reversed_micros: 0,
    },
    {
      key: `signup_bonus:${complete.request.userId}`,
      amount_micros: credits(500),
      paid_minor: null,
      reversed_micros: 0,
    },
  ]);
  expect((await logOf(control.core, made.id)).map((row) => row.kind).sort()).toEqual([
    "grant",
    "grant",
    "renew",
  ]);
  // the pointer of the earlier lots is not written any more: the grant key is the record
  expect(
    await rows(
      "SELECT credit_grant_id FROM user_signup WHERE workos_user_id=?",
      complete.request.userId,
    ),
  ).toEqual([{ credit_grant_id: null }]);
  const logged = (await logOf(control.core, made.id)).length;
  await store.identity.completeWorkosOnboarding({ ...complete, now: now() });
  expect((await logOf(control.core, made.id)).length).toBe(logged);
  expect(await accountOf(control.core, made.id)).toMatchObject({ onetime_micros: credits(1500) });

  // A poller may already have created the organization and its account: the same onboarding adds the grants to it
  const existingId = newUlid(),
    existingWorkos = "org_referred_existing";
  await store.identity.applyOrganizationSnapshot({
    organizationId: existingId,
    workosOrganizationId: existingWorkos,
    state: "active",
    snapshotDigest: "cd".repeat(32),
    snapshotFetchedAt: now(),
    synchronizedAt: now(),
    triggerEventId: "evt_existing",
    memberships: [
      {
        workosUserId: "user_referred_existing",
        role: "admin",
        status: "active",
        digest: "ef".repeat(32),
      },
    ],
    auditEventId: newUlid(),
  });
  // the snapshot that created the organization created its credit account too
  expect(await accountOf(control.core, existingId)).toMatchObject({
    monthly_micros: 0,
    onetime_micros: 0,
    paid_until: null,
  });
  await runGrantCredit(control.core, {
    organizationId: existingId,
    key: "promo:existing-account",
    kind: "onetime",
    amountMicros: credits(5),
    now: now(),
  });
  const existing = await accepted(request("user_referred_existing", source), existingWorkos);
  expect((await store.identity.completeWorkosOnboarding(existing)).id).toBe(existingId);
  expect(await accountOf(control.core, existingId)).toMatchObject({
    onetime_micros: credits(1505),
    paid_source: "granted",
  });
  expect(
    await rows("SELECT count(*) AS n FROM credit_grant WHERE organization_id=?", existingId),
  ).toEqual([{ n: 3 }]);

  // A frozen NULL origin records attribution but cannot earn a link's bonus after the fact.
  const frozen = request("user_frozen_origin", source);
  await control.core
    .prepare(
      "INSERT INTO user_signup(workos_user_id,origin_source,recorded_at,origin_present) VALUES (?1,NULL,?2,1)",
    )
    .bind(frozen.userId, stored(now()))
    .run();
  const frozenPrepared = await accepted(frozen);
  expect(
    await rows("SELECT bonus_micros FROM user_signup WHERE workos_user_id=?", frozen.userId),
  ).toEqual([{ bonus_micros: "0" }]);
  // the referral source still earns the distinct 1000-credit referral grant
  await store.identity.completeWorkosOnboarding(frozenPrepared);
  expect(
    await rows(
      "SELECT key,amount_micros FROM credit_grant WHERE organization_id=?",
      frozenPrepared.requestId,
    ),
  ).toEqual([{ key: "referral_signup:user_frozen_origin", amount_micros: credits(1000) }]);
  const flagProject = projectInput(referrer, "referral-flag");
  await store.projects.createInitialProject(flagProject);
  const periodId = newUlid();
  await control.core
    .prepare("INSERT INTO project_powered_by_flag_periods VALUES (?1,?2,?3,?4,NULL)")
    .bind(periodId, referrer, flagProject.projectId, stored(now()))
    .run();
  const flagSource = `flag-${flagProject.projectId.toLowerCase()}`;
  const shown = await accepted(request("user_flag_signup", flagSource));
  await port.complete(shown);
  expect(
    await rows("SELECT key FROM credit_grant WHERE organization_id=?", shown.requestId),
  ).toEqual([{ key: "referral_signup:user_flag_signup" }]);
  await expect(
    control.core
      .prepare("UPDATE project_powered_by_flag_periods SET enabled_at=? WHERE period_id=?")
      .bind(stored(now()), periodId)
      .run(),
  ).rejects.toThrow(/may only be closed/u);
  await control.core
    .prepare("UPDATE project_powered_by_flag_periods SET disabled_at=? WHERE period_id=?")
    .bind(stored(now()), periodId)
    .run();
  await expect(
    control.core
      .prepare("DELETE FROM project_powered_by_flag_periods WHERE period_id=?")
      .bind(periodId)
      .run(),
  ).rejects.toThrow(/may only be closed/u);
  // a closed flag refers nobody: the new organization is Free with nothing granted
  const closed = await accepted(request("user_closed_flag", flagSource));
  await port.complete(closed);
  expect(
    await rows("SELECT * FROM credit_grant WHERE organization_id=?", closed.requestId),
  ).toEqual([]);
  expect(await readAccount(control.core, closed.requestId, now())).toMatchObject({
    monthlyMicros: credits(200),
    onetimeMicros: 0,
    paid: false,
    paidSource: null,
  });
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
});

it("grants the referral credit by the rank of each user's first recording, so a late completion keeps its place", async () => {
  const referrer = newUlid();
  await store.identity.applyOrganizationSnapshot({
    organizationId: referrer,
    workosOrganizationId: "org_referrer_rank",
    state: "active",
    snapshotDigest: "cd".repeat(32),
    snapshotFetchedAt: now(),
    synchronizedAt: now(),
    triggerEventId: "evt_referrer_rank",
    memberships: [],
    auditEventId: newUlid(),
  });
  const source = `ref-${referrer.toLowerCase()}`;
  await control.core
    .prepare("INSERT INTO signup_sources VALUES (?1,1,1,CAST(?2 AS INTEGER))")
    .bind(source, 0)
    .run();
  // twenty-one users are recorded in order through this link; the first of them completes last
  const recorded: Awaited<ReturnType<typeof accepted>>[] = [];
  for (let index = 1; index <= 21; index += 1)
    recorded.push(await accepted(request(`user_rank_${String(index).padStart(2, "0")}`, source)));
  const [first, ...others] = recorded;
  if (first === undefined) throw new Error("the first user is missing");
  const grantedOf = async (requestId: string) =>
    rows("SELECT key FROM credit_grant WHERE organization_id=?", requestId);
  for (const user of others) {
    const made = await store.identity.completeWorkosOnboarding(user);
    const granted = (await grantedOf(made.id)).length > 0;
    // the 21st recording (the last of the others) is the only one without the credit
    expect(granted).toBe(user !== others[19]);
  }
  const made = await store.identity.completeWorkosOnboarding(first);
  expect(await grantedOf(made.id)).toEqual([{ key: "referral_signup:user_rank_01" }]);
});

it("answers a completion whose response was lost from what it committed, with the grants once", async () => {
  await control.core
    .prepare("INSERT INTO signup_sources VALUES ('lost_campaign',1,1,100000000)")
    .run();
  const complete = await accepted(request("user_lost_response", "lost_campaign"));
  const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
  expect(await lossy.identity.completeWorkosOnboarding(complete)).toEqual({
    id: complete.requestId,
    name: complete.request.name,
  });
  expect(await accountOf(control.core, complete.requestId)).toMatchObject({
    onetime_micros: credits(100),
  });
  expect(
    await rows("SELECT key FROM credit_grant WHERE organization_id=?", complete.requestId),
  ).toEqual([{ key: `signup_bonus:${complete.request.userId}` }]);
});

it("refuses a signup bonus that no JavaScript number can hold exactly", async () => {
  await control.core
    .prepare("INSERT INTO signup_sources VALUES ('huge_campaign',1,1,9223372036854775807)")
    .run();
  const huge = await accepted(request("user_huge_bonus", "huge_campaign"));
  await expect(store.identity.completeWorkosOnboarding(huge)).rejects.toThrow(/out of range/u);
  expect(await rows("SELECT * FROM organizations WHERE organization_id=?", huge.requestId)).toEqual(
    [],
  );
});

it("attributes one source bonus across concurrent workspace completions and refuses changed or foreign request authority", async () => {
  await control.core
    .prepare("INSERT INTO signup_sources VALUES ('shared_campaign',1,1,500000000)")
    .run();
  const first = await accepted(request("user_parallel_onboard", "shared_campaign"));
  const second = await accepted({
    ...request("user_parallel_onboard", "shared_campaign"),
    name: "Second workspace",
  });
  const [a, b] = await Promise.all([
    store.identity.completeWorkosOnboarding(first),
    store.identity.completeWorkosOnboarding(second),
  ]);
  expect(a.id).not.toBe(b.id);
  // exactly one of the two organizations holds the bonus; the user's other organization is Free
  const grants = await rows(
    "SELECT key,organization_id,amount_micros FROM credit_grant WHERE key LIKE 'signup_bonus:%' AND key = ?",
    `signup_bonus:${first.request.userId}`,
  );
  expect(grants).toHaveLength(1);
  expect(grants[0]?.["amount_micros"]).toBe(500_000_000);
  const bonusOrg = String(grants[0]?.["organization_id"]);
  expect([a.id, b.id]).toContain(bonusOrg);
  expect(await accountOf(control.core, bonusOrg)).toMatchObject({ onetime_micros: 500_000_000 });
  expect(await readAccount(control.core, bonusOrg === a.id ? b.id : a.id, now())).toMatchObject({
    onetimeMicros: 0,
    monthlyMicros: credits(200),
  });
  expect(
    await rows(
      "SELECT count(*) AS n FROM organizations WHERE organization_id IN (?1,?2) AND beta_admitted_at IS NOT NULL",
      a.id,
      b.id,
    ),
  ).toEqual([{ n: 2 }]);
  await expect(
    store.identity.completeWorkosOnboarding({
      ...first,
      request: { ...first.request, userId: "user_foreign" },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    port.complete({
      ...first,
      request: { ...first.request, name: "Changed" },
    }),
  ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  const inactive = request("user_inactive_campaign", "blocked_campaign");
  await control.core
    .prepare("INSERT INTO signup_sources VALUES ('blocked_campaign',0,1,1000)")
    .run();
  await expect(
    store.identity.prepareWorkosOnboarding({
      request: inactive,
      proposedRequestId: newUlid(),
      now: now(),
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(await rows("SELECT * FROM user_signup WHERE workos_user_id=?", inactive.userId)).toEqual(
    [],
  );
  const quarantined = await accepted(request("user_quarantined", "direct"));
  const bucket = await bucketOf(quarantined.requestId);
  await control.core
    .prepare("INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES (?1,'moving',?2,?3)")
    .bind(bucket, newUlid(), stored(now()))
    .run();
  await expect(store.identity.completeWorkosOnboarding(quarantined)).rejects.toMatchObject({
    code: "bucket_moving",
  });
  expect(
    await rows("SELECT * FROM organizations WHERE organization_id=?", quarantined.requestId),
  ).toEqual([]);
  await control.core.prepare("DELETE FROM bucket_fences WHERE bucket=?").bind(bucket).run();
  expect((await port.complete(quarantined)).id).toBe(quarantined.requestId);

  const mismatch = await accepted(request("user_mirror_mismatch", "direct"));
  const mismatchedId = newUlid();
  await store.identity.applyOrganizationSnapshot({
    organizationId: mismatchedId,
    workosOrganizationId: "org_actual_mismatched_owner",
    state: "active",
    snapshotDigest: "ab".repeat(32),
    snapshotFetchedAt: now(),
    synchronizedAt: now(),
    triggerEventId: "evt_mismatch",
    memberships: [],
    auditEventId: newUlid(),
  });
  await control.core
    .prepare("UPDATE org_directory SET workos_organization_id=?1 WHERE organization_id=?2")
    .bind(mismatch.workosOrganizationId, mismatchedId)
    .run();
  await expect(store.identity.completeWorkosOnboarding(mismatch)).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(
    await rows("SELECT * FROM organization_memberships WHERE organization_id=?", mismatchedId),
  ).toEqual([]);
  await control.core
    .prepare(
      "UPDATE org_directory SET workos_organization_id='org_actual_mismatched_owner' WHERE organization_id=?",
    )
    .bind(mismatchedId)
    .run();
});

it("refuses more than five new workspace requests per user and hour, so no account can flood the membership sync queue", async () => {
  const flooder = request("user_workspace_flood");
  const prepare = (idempotencyKey: string, at: Date = new Date(), userId = flooder.userId) =>
    store.identity.prepareWorkosOnboarding({
      request: {
        ...flooder,
        userId,
        sessionId: `session_${userId}`,
        idempotencyKey,
        initial: false,
      },
      proposedRequestId: newUlid(),
      now: at.toISOString(),
    });
  const keys = ["flood-1", "flood-2", "flood-3", "flood-4", "flood-5"];
  const accepted = await Promise.all(keys.map((key) => prepare(key)));
  const count = async () =>
    rows("SELECT count(*) AS n FROM onboarding_requests WHERE workos_user_id=?", flooder.userId);
  expect(await count()).toEqual([{ n: 5 }]);
  // Thirty further keys in a row are all refused and create no row; the provider is never asked for an organization.
  for (let index = 6; index <= 35; index += 1)
    await expect(prepare(`flood-${index}`)).rejects.toMatchObject({ code: "forbidden" });
  expect(await count()).toEqual([{ n: 5 }]);
  // A replay of an accepted key is an observation, not a new request: the limit never blocks it.
  expect((await prepare("flood-3")).row.request_id).toBe(accepted[2]?.row.request_id);
  // Another user is unaffected, and the limit is a rolling hour: the window moves on.
  expect(
    (await prepare("other-1", new Date(), "user_workspace_flood_other")).row.request_id,
  ).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
  const later = new Date(Date.now() + 61 * 60_000);
  expect((await prepare("flood-36", later)).row.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
  expect(await count()).toEqual([{ n: 6 }]);
});
