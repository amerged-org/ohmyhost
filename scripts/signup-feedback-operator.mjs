/* global AbortSignal, console, fetch, process */
/** Private, explicitly invoked operator workflow. Never use this to preview/send on its own. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const USER_ID = /^user_[A-Za-z0-9_]{1,123}$/u;
const DATABASE_ID = "22802c60-952a-4d8e-974d-43de060ed347";
const RECEIPT = "signup-feedback:production:activation:v1";
const SIGNUPS = `SELECT workos_user_id AS id FROM user_signup ORDER BY id`;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (code) => {
  throw new Error(code);
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function ids(input) {
  if (
    !Array.isArray(input) ||
    input.length > 1000 ||
    input.some((id) => typeof id !== "string" || !USER_ID.test(id))
  )
    fail("invalid_user_ids");
  const sorted = [...input].sort();
  if (new Set(sorted).size !== sorted.length) fail("duplicate_user_id");
  return sorted;
}
export function makeReview({ signups, identities }) {
  const cohort = ids(signups);
  if (!Array.isArray(identities) || identities.length !== cohort.length)
    fail("identity_snapshot_incomplete");
  const byId = new Map();
  for (const identity of identities) {
    if (
      !identity ||
      !cohort.includes(identity.id) ||
      byId.has(identity.id) ||
      typeof identity.email !== "string" ||
      typeof identity.name !== "string" ||
      typeof identity.verified !== "boolean"
    )
      fail("identity_snapshot_invalid");
    byId.set(identity.id, {
      id: identity.id,
      name: identity.name,
      email: identity.email,
      verified: identity.verified,
    });
  }
  const snapshot = {
    version: 2,
    database: DATABASE_ID,
    signups: cohort,
    identities: cohort.map((id) => byId.get(id)),
  };
  return { snapshot, sha256: digest(snapshot) };
}
export function validateReview(review, expectedDigest) {
  if (
    !review ||
    !/^[a-f0-9]{64}$/u.test(expectedDigest ?? "") ||
    review.sha256 !== expectedDigest ||
    digest(review.snapshot) !== expectedDigest
  )
    fail("review_digest_mismatch");
  const snapshot = review.snapshot;
  if (snapshot?.version !== 2 || snapshot.database !== DATABASE_ID) fail("review_target_invalid");
  const normalized = makeReview(snapshot);
  if (normalized.sha256 !== expectedDigest) fail("review_not_canonical");
  return snapshot;
}
export function assertCurrentReview(snapshot, current) {
  if (
    JSON.stringify(current) !==
    JSON.stringify({ signups: snapshot.signups, identities: snapshot.identities })
  )
    fail("identity_or_cohort_changed_review_again");
}
export function activationBatch(review, expectedDigest, now = new Date()) {
  const snapshot = validateReview(review, expectedDigest);
  if (!Number.isFinite(now.getTime())) fail("invalid_timestamp");
  const cohort = JSON.stringify(snapshot.signups);
  const time = now.toISOString().replace(/Z$/u, "000Z");
  const result = JSON.stringify({
    sha256: expectedDigest,
    selected: snapshot.signups.length,
  });
  const guard = `INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE
    NOT EXISTS(SELECT 1 FROM signup_feedback_mail_settings WHERE singleton=1 AND enabled=0)
    OR EXISTS(SELECT 1 FROM command_log WHERE command_id=?2)
    OR EXISTS(SELECT id FROM (${SIGNUPS}) EXCEPT SELECT value FROM json_each(?1))
    OR EXISTS(SELECT value FROM json_each(?1) EXCEPT SELECT id FROM (${SIGNUPS}))`;
  return [
    { sql: guard, params: [cohort, RECEIPT] },
    {
      sql: `INSERT INTO signup_feedback_mail(workos_user_id,state,created_at,updated_at)
      SELECT value,'pending',?2,?2 FROM json_each(?1) WHERE 1 ON CONFLICT(workos_user_id) DO NOTHING`,
      params: [cohort, time],
    },
    {
      sql: "UPDATE signup_feedback_mail_settings SET enabled=1 WHERE singleton=1 AND enabled=0",
      params: [],
    },
    {
      sql: "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?1,?2,?3,?4,?5)",
      params: [RECEIPT, "signup-feedback.activate", expectedDigest, result, now.getTime()],
    },
  ];
}
export function summarizeStatus(gates, rows) {
  if (
    !Array.isArray(gates) ||
    gates.length !== 1 ||
    ![0, 1].includes(gates[0].enabled) ||
    !Array.isArray(rows)
  )
    fail("status_unconfirmed");
  const states = ["pending", "claimed", "sending", "accepted", "uncertain", "skipped"];
  const counts = Object.fromEntries(states.map((state) => [state, 0]));
  const seen = new Set();
  for (const row of rows) {
    if (
      !states.includes(row.state) ||
      seen.has(row.state) ||
      !Number.isSafeInteger(row.n) ||
      row.n < 0
    )
      fail("status_unconfirmed");
    seen.add(row.state);
    counts[row.state] = row.n;
  }
  return { enabled: gates[0].enabled === 1, counts };
}
export function productionWorkosKey(env) {
  const key = env.PROD_WORKOS_API_KEY;
  if (typeof key !== "string" || key.length === 0 || key.startsWith("sk_test_"))
    fail("production_workos_key_required");
  return key;
}
function config(needsWorkos) {
  const accountId = process.env.CLOUDFLARE_CONTROL_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN_ADMIN;
  const workos = needsWorkos ? productionWorkosKey(process.env) : undefined;
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token || (needsWorkos && !workos))
    fail("operator_credentials_required");
  return { accountId, token, workos };
}
async function query(conf, batch) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${conf.accountId}/d1/database/${DATABASE_ID}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${conf.token}`, "content-type": "application/json" },
      body: JSON.stringify({ batch }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  const result = await response.json().catch(() => null);
  if (
    !response.ok ||
    result?.success !== true ||
    !Array.isArray(result.result) ||
    result.result.length !== batch.length ||
    result.result.some((entry) => entry.success !== true)
  )
    fail("d1_operation_unconfirmed");
  return result.result.map((entry) => entry.results);
}
async function identity(conf, id) {
  const response = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(id)}`,
    {
      headers: { authorization: `Bearer ${conf.workos}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 404) return { id, name: "", email: "", verified: false };
  if (!response.ok) fail("workos_identity_unavailable");
  const user = await response.json();
  if (user.id !== id || (typeof user.email !== "string" && user.email != null))
    fail("workos_identity_invalid");
  return {
    id,
    name: [user.first_name, user.last_name]
      .filter((s) => typeof s === "string" && s.trim())
      .join(" "),
    email: user.email ?? "",
    verified: user.email_verified === true,
  };
}
async function signupSnapshot(conf) {
  const [[...rows]] = await query(conf, [{ sql: SIGNUPS, params: [] }]);
  const signups = ids(rows.map((row) => row.id));
  const identities = [];
  for (const id of signups) identities.push(await identity(conf, id));
  return { signups, identities };
}
async function assertPrivateDestination(path) {
  if (!path || !isAbsolute(path)) fail("private_path_required");
  const parent = await realpath(dirname(resolve(path)));
  const repo = await realpath(REPO);
  if (parent === repo || parent.startsWith(repo + sep)) fail("snapshot_must_be_outside_repository");
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const conf = config(action !== "status");
  if (action === "status" && args.length === 0) {
    const [gates, rows] = await query(conf, [
      { sql: "SELECT enabled FROM signup_feedback_mail_settings WHERE singleton=1", params: [] },
      { sql: "SELECT state,count(*) AS n FROM signup_feedback_mail GROUP BY state", params: [] },
    ]);
    console.log(JSON.stringify(summarizeStatus(gates, rows), null, 2));
  } else if (action === "preview" && args.length === 0) {
    console.log(JSON.stringify(await signupSnapshot(conf), null, 2));
  } else if (action === "prepare" && args.length === 1) {
    await assertPrivateDestination(args[0]);
    const review = makeReview(await signupSnapshot(conf));
    await writeFile(args[0], JSON.stringify(review, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(
      `Private review file created; SHA-256: ${review.sha256}. Review the full file before approval.`,
    );
  } else if (action === "activate" && args.length === 2) {
    await assertPrivateDestination(args[0]);
    const file = await stat(args[0]);
    if (!file.isFile() || (file.mode & 0o077) !== 0) fail("review_file_permissions_invalid");
    const review = JSON.parse(await readFile(args[0], "utf8"));
    const snapshot = validateReview(review, args[1]);
    const [[existing], [gate]] = await query(conf, [
      {
        sql: "SELECT digest FROM command_log WHERE command_id=?1 AND name='signup-feedback.activate'",
        params: [RECEIPT],
      },
      { sql: "SELECT enabled FROM signup_feedback_mail_settings WHERE singleton=1", params: [] },
    ]);
    if (existing) {
      if (existing.digest !== args[1] || gate?.enabled !== 1) fail("activation_receipt_conflict");
      console.log(`Previously activated for reviewed digest ${args[1]}.`);
      return;
    }
    // Refuse changed addresses or names before the D1 transaction; identity reads never alter provider state.
    const current = await signupSnapshot(conf);
    assertCurrentReview(snapshot, current);
    // Do not retry uncertain D1 writes: inspect the private command_log receipt and gate first.
    await query(conf, activationBatch(review, args[1]));
    const [[receipt], [updatedGate]] = await query(conf, [
      {
        sql: "SELECT digest FROM command_log WHERE command_id=?1 AND name='signup-feedback.activate'",
        params: [RECEIPT],
      },
      { sql: "SELECT enabled FROM signup_feedback_mail_settings WHERE singleton=1", params: [] },
    ]);
    if (receipt?.digest !== args[1] || updatedGate?.enabled !== 1)
      fail("activation_readback_unconfirmed");
    console.log(`Activation accepted and read back for reviewed digest ${args[1]}.`);
  } else
    fail(
      "usage: status | preview | prepare PRIVATE_NEW_FILE | activate PRIVATE_REVIEW_FILE REVIEWED_SHA256",
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
