import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import type { CatalogContext } from "../../src/catalog/common.js";
import { recordAccountSignupSource } from "../../src/catalog/identity/account-metadata.js";
import {
  claimSignupFeedback,
  beginSignupFeedback,
  finishSignupFeedback,
  isSignupFeedbackClaim,
} from "../../src/catalog/mail/signup-feedback.js";
import { splitStatements } from "../support/sql.js";

let worker: Miniflare;
let db: D1Database;
let context: CatalogContext;
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const signup = (userId: string, recordedAt = iso(-3_600_000), utm?: Record<string, string>) =>
  recordAccountSignupSource(context, {
    userId,
    source: null,
    recordedAt,
    ...(utm === undefined ? {} : { utm }),
  });
const state = async (userId: string) =>
  db
    .prepare("SELECT state FROM signup_feedback_mail WHERE workos_user_id=?")
    .bind(userId)
    .first<{ state: string }>();

beforeAll(async () => {
  worker = new Miniflare({
    modules: true,
    script: "export default {fetch() { return new Response('ok'); }}",
    d1Databases: { CONTROL_CORE: "core" },
  });
  db = (await worker.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  await db
    .prepare(
      "CREATE TABLE guard_fail(code TEXT NOT NULL, CONSTRAINT guard_precondition_changed CHECK(code <> 'precondition_changed'), CONSTRAINT guard_unregistered CHECK(length(code)<0)) STRICT",
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE user_signup(workos_user_id TEXT PRIMARY KEY, origin_source TEXT, origin_present INTEGER NOT NULL DEFAULT 1, recorded_at TEXT NOT NULL) STRICT",
    )
    .run();
  const signupUtmMigration = readFileSync(
    new URL("../../migrations/core/0757_signup_utm.sql", import.meta.url),
    "utf8",
  );
  await db.batch(splitStatements(signupUtmMigration).map((sql) => db.prepare(sql)));
  const migration = readFileSync(
    new URL("../../migrations/core/0636_signup_feedback_mail.sql", import.meta.url),
    "utf8",
  );
  await db.batch(splitStatements(migration).map((sql) => db.prepare(sql)));
  context = {
    directory: db,
    router: { assertLayout: async () => undefined, routeShard: async () => ({ db }) },
  } as unknown as CatalogContext;
}, 240_000);
afterAll(async () => worker?.dispose());

it("only queues first signup after activation and resolves a claim exactly once", async () => {
  await signup("user_before_enable");
  expect(await state("user_before_enable")).toBeNull();
  expect(await claimSignupFeedback(context, { now: iso() })).toEqual([]);
  await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=1 WHERE singleton=1").run();
  await signup("user_before_enable");
  expect(await state("user_before_enable")).toBeNull();
  await signup("user_feedback_first", iso(-3_600_000), { utm_source: "campaign" });
  await signup("user_feedback_first");
  expect(
    await db
      .prepare("SELECT utm_parameters FROM user_signup WHERE workos_user_id=?")
      .bind("user_feedback_first")
      .first(),
  ).toEqual({ utm_parameters: JSON.stringify({ utm_source: "campaign" }) });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM signup_feedback_mail WHERE workos_user_id=?")
      .bind("user_feedback_first")
      .first(),
  ).toEqual({ n: 1 });
  const claim = (await claimSignupFeedback(context, { now: iso() }))[0];
  expect(claim?.userId).toBe("user_feedback_first");
  if (!claim) throw new Error("claim missing");
  const ref = { userId: claim.userId, claimToken: claim.claimToken };
  expect(await isSignupFeedbackClaim(context, ref)).toBe(true);
  expect(await beginSignupFeedback(context, { ...ref, now: iso() })).toBe(true);
  expect(
    await finishSignupFeedback(context, {
      ...ref,
      now: iso(),
      state: "accepted",
      providerMessageId: "message_1",
    }),
  ).toBe(true);
  expect(
    await finishSignupFeedback(context, {
      ...ref,
      now: iso(),
      state: "accepted",
      providerMessageId: "message_1",
    }),
  ).toBe(false);

  // A first-origin UPDATE is the second onboarding path; disabling the gate holds its queued job.
  await db
    .prepare("INSERT INTO user_signup(workos_user_id,origin_present,recorded_at) VALUES(?1,0,?2)")
    .bind("user_feedback_origin", iso().replace(/Z$/u, "000Z"))
    .run();
  await signup("user_feedback_origin");
  await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=0 WHERE singleton=1").run();
  expect(await claimSignupFeedback(context, { now: iso() })).toEqual([]);
  await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=1 WHERE singleton=1").run();
  const concurrent = await Promise.all([
    claimSignupFeedback(context, { now: iso() }),
    claimSignupFeedback(context, { now: iso() }),
  ]);
  const leases = concurrent.flat();
  expect(leases).toHaveLength(1);
  const origin = leases[0];
  if (!origin) throw new Error("origin claim missing");
  const originRef = { userId: origin.userId, claimToken: origin.claimToken };
  await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=0 WHERE singleton=1").run();
  expect(await beginSignupFeedback(context, { ...originRef, now: iso() })).toBe(false);
  await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=1 WHERE singleton=1").run();
  expect(
    await finishSignupFeedback(context, {
      ...originRef,
      now: iso(901_000),
      state: "skipped",
      providerMessageId: null,
    }),
  ).toBe(false);
  const renewed = (await claimSignupFeedback(context, { now: iso(901_000) }))[0];
  if (!renewed) throw new Error("expired claim not recovered");
  expect(renewed.userId).toBe("user_feedback_origin");
  expect(renewed.claimToken).not.toBe(origin.claimToken);
  const renewedRef = { userId: renewed.userId, claimToken: renewed.claimToken };
  expect(await beginSignupFeedback(context, { ...renewedRef, now: iso(901_000) })).toBe(true);
  expect(
    await finishSignupFeedback(context, {
      ...renewedRef,
      now: iso(901_000),
      state: "accepted",
      providerMessageId: "message_2",
    }),
  ).toBe(true);
});

it("does not replay an uncertain send and retries only before the provider boundary", async () => {
  await signup("user_feedback_second");
  const claim = (await claimSignupFeedback(context, { now: iso() }))[0];
  if (!claim) throw new Error("claim missing");
  const ref = { userId: claim.userId, claimToken: claim.claimToken };
  expect(await isSignupFeedbackClaim(context, ref)).toBe(true);
  expect(await beginSignupFeedback(context, { ...ref, now: iso() })).toBe(true);
  expect(await beginSignupFeedback(context, { ...ref, now: iso() })).toBe(false);
  expect(
    await finishSignupFeedback(context, {
      ...ref,
      now: iso(),
      state: "uncertain",
      providerMessageId: null,
    }),
  ).toBe(true);
  expect(await claimSignupFeedback(context, { now: iso(86_400_000) })).toEqual([]);
  expect(await state(claim.userId)).toEqual({ state: "uncertain" });

  await signup("user_feedback_unverified");
  const retryClaim = (await claimSignupFeedback(context, { now: iso() }))[0];
  if (!retryClaim) throw new Error("retry claim missing");
  const retryRef = { userId: retryClaim.userId, claimToken: retryClaim.claimToken };
  expect(
    await finishSignupFeedback(context, {
      ...retryRef,
      now: iso(),
      state: "pending",
      providerMessageId: null,
    }),
  ).toBe(true);
  expect(await claimSignupFeedback(context, { now: iso() })).toEqual([]);
  const retried = (await claimSignupFeedback(context, { now: iso(86_401_000) }))[0];
  expect(retried?.userId).toBe("user_feedback_unverified");
  if (!retried) throw new Error("retry missing");
  await finishSignupFeedback(context, {
    userId: retried.userId,
    claimToken: retried.claimToken,
    now: iso(86_401_000),
    state: "pending",
    providerMessageId: null,
  });

  await signup("user_feedback_lost_response");
  const lost = (await claimSignupFeedback(context, { now: iso() }))[0];
  if (!lost) throw new Error("lost-response claim missing");
  expect(
    await beginSignupFeedback(context, {
      userId: lost.userId,
      claimToken: lost.claimToken,
      now: iso(),
    }),
  ).toBe(true);
  expect(await claimSignupFeedback(context, { now: iso(901_000) })).toEqual([]);
  expect(await state(lost.userId)).toEqual({ state: "uncertain" });
});

it("waits one hour for both new signup paths while an existing-cohort entry is due immediately", async () => {
  const base = new Date();
  const at = (milliseconds: number) => new Date(base.getTime() + milliseconds).toISOString();
  await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=1 WHERE singleton=1").run();
  await signup("user_delay_insert", at(0));
  await db
    .prepare("INSERT INTO user_signup(workos_user_id,origin_present,recorded_at) VALUES(?1,0,?2)")
    .bind("user_delay_update", at(0).replace(/Z$/u, "000Z"))
    .run();
  await signup("user_delay_update", at(0));
  await db
    .prepare("INSERT INTO user_signup(workos_user_id,origin_present,recorded_at) VALUES(?1,0,?2)")
    .bind("user_delay_existing", at(0).replace(/Z$/u, "000Z"))
    .run();
  await db
    .prepare(
      "INSERT INTO signup_feedback_mail(workos_user_id,state,created_at,updated_at) VALUES(?1,'pending',?2,?2)",
    )
    .bind("user_delay_existing", at(0).replace(/Z$/u, "000Z"))
    .run();
  const immediate = await claimSignupFeedback(context, { now: at(0) });
  expect(immediate.map((row) => row.userId)).toEqual(["user_delay_existing"]);
  if (!immediate[0]) throw new Error("existing cohort claim missing");
  await finishSignupFeedback(context, {
    userId: immediate[0].userId,
    claimToken: immediate[0].claimToken,
    now: at(0),
    state: "skipped",
    providerMessageId: null,
  });
  expect(await claimSignupFeedback(context, { now: at(3_599_999) })).toEqual([]);
  const due = await claimSignupFeedback(context, { now: at(3_600_000) });
  expect(due.map((row) => row.userId).sort()).toEqual(["user_delay_insert", "user_delay_update"]);

  // Preserve microseconds across midnight; SQLite must not round up the stored fraction.
  await db
    .prepare("INSERT INTO user_signup(workos_user_id,origin_present,recorded_at) VALUES(?1,1,?2)")
    .bind("user_delay_midnight", "2026-11-13T23:30:00.999999Z")
    .run();
  const midnight = await db
    .prepare("SELECT next_attempt_at FROM signup_feedback_mail WHERE workos_user_id=?1")
    .bind("user_delay_midnight")
    .first<{ next_attempt_at: string }>();
  expect(midnight?.next_attempt_at).toBe("2026-11-14T00:30:00.999999Z");
});
