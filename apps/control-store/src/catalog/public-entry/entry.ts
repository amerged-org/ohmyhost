import { z } from "zod";
import { guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { hexBytes, instant, sha256Hex, type CatalogContext } from "../common.js";
/** The marker of a row without a real source bucket: old rows and callers with no usable address. Never one of the 256. */
const NO_BUCKET = -2,
  // null: the Control API had no usable address; the store stores the marker and checks only the shared pool.
  bucket = z.number().int().min(0).max(255).nullable(),
  uuid = z
    .string()
    .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu)
    .transform((value) => value.toLowerCase()),
  text = z.string().refine((value) => !value.includes("\0")),
  contactInput = z.strictObject({
    requestId: uuid,
    payloadSha256: sha256Hex,
    name: text,
    email: text,
    company: text,
    message: text,
    now: instant,
    sourceBucket: bucket,
  }),
  voteInput = z.strictObject({
    key: uuid,
    feature: z.enum(["eu", "iso27001", "soc2"]),
    choice: z.enum(["up", "down"]).nullable(),
    voterSha256: sha256Hex,
    now: instant,
    sourceBucket: bucket,
  }),
  nowInput = z.strictObject({ now: instant });
/**
 * Rows anonymous callers may leave in the Core, per table, in two nested shares. The pool allows `day` new rows a UTC day
 * and `total` live rows. A source bucket (one of 256 digest buckets of the caller's address, an IPv6 /64 as one) may take
 * only `bucketDay` and `bucketTotal` of it, so a single flooding source can spend at most 2.5 % of the contact pool
 * (5 % of votes) and at least 40 (20) buckets are needed to exhaust a day. A contact row is at most about 26 KB (8,574
 * characters of three bytes), so 4,000 rows stay near 100 MB, 1 % of a D1 database. A vote row is about 300 bytes with
 * its indexes. Contact requests and votes are separate pools: votes never take room a contact request needs.
 */
export const PUBLIC_INTAKE_CAPS = {
  contact: { day: 400, total: 4000, bucketDay: 10, bucketTotal: 100 },
  vote: { day: 10000, total: 100000, bucketDay: 500, bucketTotal: 5000 },
} as const;
/** PostgreSQL UTC interval '12 months': clamp leap days instead of JavaScript's March rollover. */
export function publicEntryExpiry(now: string) {
  const date = new Date(now),
    year = date.getUTCFullYear() + 1,
    month = date.getUTCMonth(),
    last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(year);
  date.setUTCMonth(month);
  date.setUTCDate(Math.min(new Date(now).getUTCDate(), last));
  return storedTimestamp(date.toISOString()).slice(0, 23) + now.slice(23);
}
type IntakeKind = keyof typeof PUBLIC_INTAKE_CAPS;
/** Where a statement binds the new row's created_at and source bucket, and the four caps of its kind. */
interface IntakeSlots {
  readonly at: string;
  readonly bucket: string;
  readonly day: string;
  readonly total: string;
  readonly bucketDay: string;
  readonly bucketTotal: string;
}
/**
 * The SQL conditions of one kind's budget: `room` holds when one more row fits, and `reason` names what refuses it,
 * 'total' (the pool or the bucket's live rows) before 'day'. Each reads four counters of public_intake_budget.
 */
function intakeCaps(kind: IntakeKind, slot: IntakeSlots) {
  const counter = (bucket: string, day: string) =>
      `coalesce((SELECT entries FROM public_intake_budget WHERE kind='${kind}' AND bucket=${bucket} AND day=${day}),0)`,
    today = `substr(${slot.at},1,10)`,
    // A negative bucket is the marker: it has no share of its own, only the pool's.
    mine = (cap: string, day: string) =>
      `(${slot.bucket}>=0 AND ${counter(slot.bucket, day)}>=${cap})`,
    total = `(${counter("-1", "'total'")}>=${slot.total} OR ${mine(slot.bucketTotal, "'total'")})`,
    day = `(${counter("-1", today)}>=${slot.day} OR ${mine(slot.bucketDay, today)})`;
  return {
    room: `NOT ${total} AND NOT ${day}`,
    reason: `CASE WHEN ${total} THEN 'total' WHEN ${day} THEN 'day' END`,
  };
}
/** The refusal of a new row: the day budget returns at 00:00 UTC, the total only as retention or an operator frees rows. */
function intakeRefusal(reason: "total" | "day" | null) {
  return new Error(`public_intake_${reason ?? "day"}_full`);
}
/** Why a new row would be refused now, or null when it fits or its key is already stored. */
async function intakeReason(
  db: CatalogContext["directory"],
  kind: IntakeKind,
  i: { key: string; now: string; sourceBucket: number },
) {
  const caps = PUBLIC_INTAKE_CAPS[kind],
    stored =
      kind === "contact"
        ? "SELECT 1 FROM contact_requests WHERE request_id=?1"
        : "SELECT 1 FROM beta_feature_interests WHERE idempotency_key=?1",
    { reason } = intakeCaps(kind, {
      at: "?2",
      bucket: "?3",
      day: "?4",
      total: "?5",
      bucketDay: "?6",
      bucketTotal: "?7",
    });
  const row = await db
    .prepare(`SELECT ${reason} reason WHERE NOT EXISTS(${stored})`)
    .bind(i.key, i.now, i.sourceBucket, caps.day, caps.total, caps.bucketDay, caps.bucketTotal)
    .first<{ reason: "total" | "day" | null }>();
  return row?.reason ?? null;
}
export async function recordPublicContact(context: CatalogContext, raw: unknown): Promise<boolean> {
  const i = contactInput.parse(raw),
    source = i.sourceBucket ?? NO_BUCKET,
    db = context.directory,
    caps = PUBLIC_INTAKE_CAPS.contact,
    { room } = intakeCaps("contact", {
      at: "?7",
      bucket: "?9",
      day: "?10",
      total: "?11",
      bucketDay: "?12",
      bucketTotal: "?13",
    }),
    read = () =>
      db
        .prepare(
          "SELECT lower(hex(payload_sha256)) digest FROM contact_requests WHERE request_id=?",
        )
        .bind(i.requestId)
        .first<{ digest: string }>();
  let stored: Record<string, unknown> | undefined;
  try {
    // One statement checks the budget and inserts, so concurrent requests cannot both take the last place. A replay
    // inserts nothing (conflict, so it is never counted twice) and a request over budget inserts nothing; the read
    // tells the two apart.
    const rows = await db.batch([
      db
        .prepare(
          `INSERT INTO contact_requests(request_id,payload_sha256,name,email,company,message,created_at,expires_at,source_bucket)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE ${room} ON CONFLICT(request_id) DO NOTHING`,
        )
        .bind(
          i.requestId,
          hexBytes(i.payloadSha256),
          i.name,
          i.email,
          i.company,
          i.message,
          i.now,
          publicEntryExpiry(i.now),
          source,
          caps.day,
          caps.total,
          caps.bucketDay,
          caps.bucketTotal,
        ),
      db
        .prepare(
          "SELECT lower(hex(payload_sha256)) digest FROM contact_requests WHERE request_id=?",
        )
        .bind(i.requestId),
    ]);
    stored = rows[1]?.results[0];
  } catch (error) {
    const observed = await read();
    if (observed !== null) return observed.digest === i.payloadSha256;
    throw error;
  }
  if (stored === undefined)
    throw intakeRefusal(
      await intakeReason(db, "contact", { ...i, key: i.requestId, sourceBucket: source }),
    );
  return stored["digest"] === i.payloadSha256;
}
export async function recordPublicFeatureVote(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = voteInput.parse(raw),
    source = i.sourceBucket ?? NO_BUCKET,
    db = context.directory,
    caps = PUBLIC_INTAKE_CAPS.vote,
    { room } = intakeCaps("vote", {
      at: "?3",
      bucket: "?8",
      day: "?9",
      total: "?10",
      bucketDay: "?11",
      bucketTotal: "?12",
    });
  // A new vote over budget is refused before it writes the one shared allocator row; a stored key still replays.
  const refused = await intakeReason(db, "vote", { ...i, sourceBucket: source });
  if (refused !== null) throw intakeRefusal(refused);
  // Like original nextval, this commits BEFORE the row insert and survives its failure or conflict.
  // An unknown allocation reply never guesses/re-reads/retries the counter or sends an INSERT.
  const allocation = await db.batch([
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM beta_feature_vote_allocator WHERE singleton=1) OR EXISTS(SELECT 1 FROM beta_feature_vote_allocator WHERE singleton=1 AND is_called=1 AND last_value=9223372036854775807)",
      ),
      db.prepare(
        "UPDATE beta_feature_vote_allocator SET last_value=CASE WHEN is_called=0 THEN last_value ELSE last_value+1 END,is_called=1 WHERE singleton=1 RETURNING CAST(last_value AS TEXT) position",
      ),
    ]),
    position = allocation[1]?.results[0]?.["position"];
  if (typeof position !== "string" || !/^[1-9][0-9]*$/u.test(position))
    throw new Error("public_vote_allocation_unknown");
  const matches = (row: Record<string, unknown> | undefined | null) =>
      row?.["digest"] === i.voterSha256 &&
      row?.["feature"] === i.feature &&
      row?.["choice"] === i.choice,
    read = () =>
      db
        .prepare(
          "SELECT lower(hex(voter_sha256)) digest,feature,choice FROM beta_feature_interests WHERE idempotency_key=?",
        )
        .bind(i.key)
        .first();
  let stored: Record<string, unknown> | undefined;
  try {
    // The insert repeats the budget check, so votes racing for the last place cannot exceed it.
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO beta_feature_interests(idempotency_key,feature,created_at,voter_sha256,choice,position,expires_at,source_bucket)
 SELECT ?1,?2,?3,?4,?5,CAST(?6 AS INTEGER),?7,?8 WHERE ${room} ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .bind(
          i.key,
          i.feature,
          i.now,
          hexBytes(i.voterSha256),
          i.choice,
          position,
          publicEntryExpiry(i.now),
          source,
          caps.day,
          caps.total,
          caps.bucketDay,
          caps.bucketTotal,
        ),
      db
        .prepare(
          "SELECT lower(hex(voter_sha256)) digest,feature,choice FROM beta_feature_interests WHERE idempotency_key=?",
        )
        .bind(i.key),
    ]);
    stored = result[1]?.results[0];
  } catch (error) {
    const observed = await read();
    if (observed !== null) return matches(observed);
    throw error;
  }
  if (stored === undefined)
    throw intakeRefusal(await intakeReason(db, "vote", { ...i, sourceBucket: source }));
  return matches(stored);
}
export async function readPublicFeatureVotes(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ voterSha256: sha256Hex, now: instant }).parse(raw);
  return (
    await context.directory
      .prepare(
        `SELECT requested.feature,(SELECT choice FROM beta_feature_interests vote
 WHERE vote.voter_sha256=?1 AND vote.feature=requested.feature AND vote.expires_at>?2 ORDER BY position DESC LIMIT 1) choice
 FROM (SELECT 'eu' feature UNION ALL SELECT 'iso27001' UNION ALL SELECT 'soc2') requested`,
      )
      .bind(hexBytes(i.voterSha256), i.now)
      .all()
  ).results;
}
export async function readPublicStats(context: CatalogContext, raw: unknown) {
  const i = nowInput.parse(raw),
    from = storedTimestamp(new Date(Date.parse(i.now) - 7 * 86400000).toISOString()),
    row = await context.directory
      .prepare(
        `SELECT count(DISTINCT d.project_id) n FROM deployments d
 JOIN project_directory current ON current.project_id=d.project_id
 JOIN projects p ON p.project_id=current.project_id AND p.organization_id=current.organization_id
 WHERE d.status='succeeded' AND p.lifecycle_state='active' AND d.updated_at>=?1 AND d.updated_at<=?2`,
      )
      .bind(from, i.now)
      .first<{ n: number }>();
  if (!row || !Number.isInteger(row.n) || row.n < 0 || row.n > 2147483647)
    throw new Error("public_aggregate_unavailable");
  return row.n;
}
/**
 * Three independent retention statements; partial/unknown outcomes are not silently repeated. The budget triggers write
 * public_intake_budget for every deleted row and D1 counts those writes in `meta.changes`, so the two tables that have
 * them report the rows they removed by RETURNING instead.
 */
export async function purgePublicEntries(context: CatalogContext, raw: unknown) {
  const i = nowInput.parse(raw),
    db = context.directory,
    beta = await db.prepare("DELETE FROM beta_interests WHERE expires_at<=?").bind(i.now).run(),
    contacts = await db
      .prepare("DELETE FROM contact_requests WHERE expires_at<=? RETURNING 1")
      .bind(i.now)
      .all();
  const votes = await db
    .prepare("DELETE FROM beta_feature_interests WHERE expires_at<=? RETURNING 1")
    .bind(i.now)
    .all();
  // Customer feedback is kept twelve months, then only its report is redacted: the row stays as an audit fact.
  const cutoff = new Date(Date.parse(i.now));
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const feedback = await db
    .prepare(
      "UPDATE customer_feedback SET report='{}',redacted_at=?1 WHERE redacted_at IS NULL AND report<>'{}' AND submitted_at<=?2 RETURNING 1",
    )
    .bind(microsecondStamp(i.now), microsecondStamp(cutoff.toISOString()))
    .all();
  return (
    beta.meta.changes + contacts.results.length + votes.results.length + feedback.results.length
  );
}

/** The stored form of an instant: six fraction digits, as the Core writes every timestamp. */
function microsecondStamp(iso: string): string {
  return `${iso.slice(0, 23)}000Z`;
}
