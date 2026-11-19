import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  activationBatch,
  assertCurrentReview,
  makeReview,
  validateReview,
  summarizeStatus,
  productionWorkosKey,
} from "../scripts/signup-feedback-operator.mjs";

const first = "user_01AAAAAAAAAAAAAAAAAAAAAAAA";
const second = "user_01BBBBBBBBBBBBBBBBBBBBBBBB";
const third = "user_01CCCCCCCCCCCCCCCCCCCCCCCC";
const fourth = "user_01DDDDDDDDDDDDDDDDDDDDDDDD";
const identity = (id) => ({ id, name: id, email: `${id}@example.test`, verified: true });
const missing = { id: third, name: "", email: "", verified: false };
const build = () =>
  makeReview({
    signups: [second, third, first],
    identities: [identity(first), missing, identity(second)],
  });
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user_signup(workos_user_id TEXT PRIMARY KEY);
    CREATE TABLE organizations(organization_id TEXT PRIMARY KEY,state TEXT);
    CREATE TABLE organization_memberships(organization_id TEXT,workos_user_id TEXT,state TEXT);
    CREATE TABLE signup_feedback_mail_settings(singleton INTEGER PRIMARY KEY,enabled INTEGER);
    CREATE TABLE signup_feedback_mail(workos_user_id TEXT PRIMARY KEY,state TEXT,created_at TEXT,updated_at TEXT,next_attempt_at TEXT);
    CREATE TABLE command_log(command_id TEXT PRIMARY KEY,name TEXT,digest TEXT,result TEXT,applied_at INTEGER);
    CREATE TABLE guard_fail(code TEXT CHECK(code <> 'precondition_changed'));
    INSERT INTO signup_feedback_mail_settings VALUES(1,0);
    INSERT INTO organizations VALUES('a','active');`);
  for (const id of [first, second, third]) db.prepare("INSERT INTO user_signup VALUES(?)").run(id);
  db.prepare("INSERT INTO organization_memberships VALUES('a',?,'active')").run(first);
  return db;
}
function runBatch(db, batch) {
  db.exec("BEGIN");
  try {
    for (const statement of batch) {
      const args = Object.fromEntries(statement.params.map((value, i) => [`?${i + 1}`, value]));
      if (statement.params.length) db.prepare(statement.sql).run(args);
      else db.prepare(statement.sql).run();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
test("all-signup review binds verified and missing identities to the digest and refuses prior format", () => {
  const review = build();
  const acceptedIds = ["user_with_under_score", `user_${"a".repeat(123)}`];
  const accepted = makeReview({ signups: acceptedIds, identities: acceptedIds.map(identity) });
  assert.deepEqual(validateReview(accepted, accepted.sha256), accepted.snapshot);
  for (const id of ["user_", "user_a/b", "user_a-b", `user_${"a".repeat(124)}`]) {
    assert.throws(
      () => makeReview({ signups: [id], identities: [identity(id)] }),
      /invalid_user_ids/,
    );
  }
  assert.deepEqual(validateReview(review, review.sha256), review.snapshot);
  assert.deepEqual(review.snapshot.signups, [first, second, third]);
  const current = { signups: review.snapshot.signups, identities: review.snapshot.identities };
  assert.doesNotThrow(() => assertCurrentReview(review.snapshot, current));
  const changed = {
    ...current,
    identities: current.identities.map((i) =>
      i.id === first ? { ...i, email: "new@example.test" } : i,
    ),
  };
  assert.throws(
    () => assertCurrentReview(review.snapshot, changed),
    /identity_or_cohort_changed_review_again/,
  );
  const verifiedLater = {
    ...current,
    identities: current.identities.map((i) => (i.id === third ? identity(third) : i)),
  };
  assert.throws(
    () => assertCurrentReview(review.snapshot, verifiedLater),
    /identity_or_cohort_changed_review_again/,
  );
  assert.throws(() => validateReview(review, "0".repeat(64)), /review_digest_mismatch/);
  assert.throws(
    () => makeReview({ ...review.snapshot, identities: [identity(first)] }),
    /identity_snapshot_incomplete/,
  );
  review.snapshot.identities[0].email = "different@example.test";
  assert.throws(() => validateReview(review, review.sha256), /review_digest_mismatch/);
});
test("one atomic transaction queues every signup immediately and retains existing terminal jobs", () => {
  const db = fixture(),
    review = build();
  db.prepare("INSERT INTO signup_feedback_mail VALUES(?,'accepted','before','before',NULL)").run(
    first,
  );
  runBatch(db, activationBatch(review, review.sha256, new Date("2026-11-14T12:00:00Z")));
  const rows = db
    .prepare(
      "SELECT workos_user_id,state,next_attempt_at FROM signup_feedback_mail ORDER BY workos_user_id",
    )
    .all();
  assert.deepEqual(
    rows.map((r) => [r.workos_user_id, r.state, r.next_attempt_at]),
    [
      [first, "accepted", null],
      [second, "pending", null],
      [third, "pending", null],
    ],
  );
  assert.equal(db.prepare("SELECT enabled FROM signup_feedback_mail_settings").get().enabled, 1);
  assert.equal(db.prepare("SELECT digest FROM command_log").get().digest, review.sha256);
  assert.throws(
    () => runBatch(db, activationBatch(review, review.sha256)),
    /CHECK constraint failed/,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM signup_feedback_mail").get().n, 3);
});
test("signup set changes or an enabled gate abort the batch; memberships do not constrain the cohort", () => {
  for (const mutation of [
    `INSERT INTO user_signup VALUES('${fourth}')`,
    `DELETE FROM user_signup WHERE workos_user_id='${third}'`,
    "UPDATE signup_feedback_mail_settings SET enabled=1",
  ]) {
    const db = fixture(),
      review = build();
    db.exec(mutation);
    assert.throws(
      () => runBatch(db, activationBatch(review, review.sha256)),
      /CHECK constraint failed/,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM signup_feedback_mail").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM command_log").get().n, 0);
  }
  const db = fixture(),
    review = build();
  db.exec("UPDATE organizations SET state='suspended'; DELETE FROM organization_memberships");
  runBatch(db, activationBatch(review, review.sha256));
  assert.equal(db.prepare("SELECT count(*) AS n FROM signup_feedback_mail").get().n, 3);
});

test("operator status shows gate and counts only, including pending and uncertain", () => {
  assert.deepEqual(
    summarizeStatus(
      [{ enabled: 0 }],
      [
        { state: "pending", n: 2 },
        { state: "uncertain", n: 1 },
      ],
    ),
    {
      enabled: false,
      counts: { pending: 2, claimed: 0, sending: 0, accepted: 0, uncertain: 1, skipped: 0 },
    },
  );
  assert.throws(() => summarizeStatus([], []), /status_unconfirmed/);
  assert.throws(
    () => summarizeStatus([{ enabled: 1 }], [{ state: "unknown", n: 1 }]),
    /status_unconfirmed/,
  );
});

test("operator selects only the explicitly named production WorkOS key", () => {
  const testKey = ["sk", "test", "staging"].join("_");
  const liveKey = ["sk", "live", "production"].join("_");
  assert.throws(
    () => productionWorkosKey({ WORKOS_API_KEY: liveKey }),
    /production_workos_key_required/,
  );
  assert.throws(
    () => productionWorkosKey({ PROD_WORKOS_API_KEY: testKey }),
    /production_workos_key_required/,
  );
  assert.equal(
    productionWorkosKey({
      PROD_WORKOS_API_KEY: liveKey,
      WORKOS_API_KEY: testKey,
    }),
    liveKey,
  );
});
