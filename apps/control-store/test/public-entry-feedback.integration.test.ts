import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseUlid } from "@ohmyhost/platform";
import { handlePublicEntry } from "../../control-api/src/public-entry.js";
import {
  createD1PublicEntry,
  purgeD1PublicEntries,
} from "../../control-api/src/d1-public-entry.js";
import { createD1FeedbackPersistence } from "../../control-api/src/d1-feedback.js";
import { createTestControl } from "./support/control-d1.js";
import { seedProject } from "./support/platform-fixtures.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";
import { newUlid } from "../src/catalog/common.js";
import { SharedCoreRouter } from "../src/router.js";
import { createPublicEntryCommands } from "../src/catalog/public-entry/commands.js";
import {
  PUBLIC_INTAKE_CAPS,
  publicEntryExpiry,
  purgePublicEntries,
  recordPublicContact,
  recordPublicFeatureVote,
} from "../src/catalog/public-entry/entry.js";

it("serves the actual public HTTP and customer feedback from the Core, including the exact sequence, replay, failure, expiry, scope and private history", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control),
      now = new Date("2028-02-29T12:13:14.123Z"),
      clock = { now: () => now },
      context = { directory: control.core, router: new SharedCoreRouter(control.core) },
      commands = createPublicEntryCommands((fn) => (input) => fn(context, input)),
      core = createD1PublicEntry(commands.entry, clock),
      voter = "11111111-1111-4111-8111-111111111111",
      http = async (path: string, body?: unknown) => {
        const response = await handlePublicEntry(
          new Request(
            `https://app.ohmyho.st/v1/${path === "contact" ? "contact-requests" : "site/" + path}`,
            body === undefined
              ? { headers: { "x-ohmyho-voter": voter } }
              : {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    origin: "https://ohmyho.st",
                    "x-ohmyho-voter": voter,
                  },
                  body: JSON.stringify(body),
                },
          ),
          core,
        );
        return { status: response.status, body: await response.json() };
      },
      reused = { status: 409, body: { status: 409, code: "idempotency_key_reused" } };
    // The vote position is an exact 64-bit sequence: start above 2^53 so any float rounding would show.
    await control.core
      .prepare(
        "UPDATE beta_feature_vote_allocator SET last_value=CAST(? AS INTEGER),is_called=1 WHERE singleton=1",
      )
      .bind("9007199254740993")
      .run();
    const contact = {
      name: "Reader",
      email: "reader@example.com",
      company: "",
      message: "Please provide the requested information.",
      idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    expect(await http("contact", contact)).toEqual({ status: 202, body: { accepted: true } });
    expect(
      await http("contact", { ...contact, idempotency_key: contact.idempotency_key.toUpperCase() }),
    ).toEqual({ status: 202, body: { accepted: true } });
    expect(await http("contact", { ...contact, message: "changed" })).toMatchObject(reused);
    const vote = {
      feature: "eu",
      choice: "up",
      idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const voted = {
      status: 202,
      body: {
        accepted: true,
        votes: [
          { feature: "eu", choice: "up" },
          { feature: "iso27001", choice: null },
          { feature: "soc2", choice: null },
        ],
      },
    };
    expect(await http("feature-interests", vote)).toEqual(voted);
    expect(await http("feature-interests", vote)).toEqual(voted);
    expect(await http("feature-interests", { ...vote, choice: "down" })).toMatchObject(reused);
    expect(await http("feature-interests")).toEqual({
      status: 200,
      body: { votes: voted.body.votes },
    });
    expect(
      await control.core
        .prepare("SELECT CAST(position AS TEXT) position,expires_at FROM beta_feature_interests")
        .first(),
    ).toEqual({ position: "9007199254740994", expires_at: "2029-02-28T12:13:14.123000Z" });
    // A write refused by a late constraint is a retryable 503 and, like a PostgreSQL sequence, still consumes
    // positions: the replay, the conflicting key and the refused insert advance 994 to 997.
    const rejected = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await control.core
      .prepare(
        `CREATE TRIGGER fixture_late_refusal BEFORE INSERT ON beta_feature_interests WHEN NEW.idempotency_key='${rejected}' BEGIN SELECT RAISE(ABORT,'fixture_late_refusal');END`,
      )
      .run();
    expect(await http("feature-interests", { ...vote, idempotency_key: rejected })).toMatchObject({
      status: 503,
      body: { status: 503, code: "service_unavailable", retryable: true },
    });
    expect(
      await control.core
        .prepare(
          "SELECT CAST(last_value AS TEXT) last_value,is_called FROM beta_feature_vote_allocator",
        )
        .first(),
    ).toEqual({ last_value: "9007199254740997", is_called: 1 });
    const lostKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await expect(
      recordPublicFeatureVote(
        { ...context, directory: losingWriteResponses(control.core, 1) },
        {
          key: lostKey,
          feature: "eu",
          choice: "up",
          voterSha256: "a1".repeat(32),
          now: now.toISOString(),
          sourceBucket: 0,
        },
      ),
    ).rejects.toThrow();
    expect(
      await control.core
        .prepare("SELECT idempotency_key FROM beta_feature_interests WHERE idempotency_key=?")
        .bind(lostKey)
        .first(),
    ).toBeNull();
    expect(await http("stats")).toEqual({
      status: 200,
      body: { deploys_7d: 0, observed_at: now.toISOString() },
    });
    const feedbackId = parseUlid(newUlid()),
      adapter = createD1FeedbackPersistence({
        runtime: commands.feedback,
        clock,
        ids: { next: () => feedbackId },
      }),
      report = {
        organization_id: p.organizationId,
        project_id: p.projectId,
        environment_id: p.devEnvironmentId,
        kind: "issue" as const,
        title: "Original customer result",
        description: "A minimal redacted reproduction with the expected and observed behavior.",
      },
      request = {
        report,
        actorId: "user:fixture",
        idempotencyKey: "feedback-pair",
        requestSha256: new Uint8Array(32).fill(1),
      };
    const submitted = {
      id: feedbackId,
      organization_id: p.organizationId,
      submitted_at: now.toISOString(),
    };
    expect(await adapter.submitFeedback(request)).toEqual(submitted);
    expect(await adapter.submitFeedback(request)).toEqual(submitted);
    await expect(
      adapter.submitFeedback({ ...request, requestSha256: new Uint8Array(32).fill(2) }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    // 27 recorded events: one internal-only, 26 customer-visible, the last one moves the status to planned.
    const visible: { id: string; created_at: string; reply: string; status?: "planned" }[] = [];
    for (let n = 0; n < 27; n++) {
      const eventId = newUlid(),
        recordedAt = new Date(now.getTime() + n + 1).toISOString(),
        internal = n === 1,
        body = internal ? "internal-only fixture" : "Customer-visible recorded response";
      await control.core
        .prepare(
          "INSERT INTO customer_feedback_events(event_id,feedback_id,visibility,status,release,body,actor_id,recorded_at)VALUES(?,?,?,?,NULL,?,'operator-fixture',?)",
        )
        .bind(
          eventId,
          feedbackId,
          internal ? "internal" : "customer",
          n === 26 ? "planned" : null,
          body,
          recordedAt.replace("Z", "000Z"),
        )
        .run();
      if (!internal)
        visible.push({
          id: eventId,
          created_at: recordedAt,
          reply: body,
          ...(n === 26 ? { status: "planned" as const } : {}),
        });
    }
    expect(visible).toHaveLength(26);
    const scope = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
      },
      read = { feedbackId, organizationIds: [parseUlid(p.organizationId)] },
      last = visible[25];
    if (last === undefined) throw new Error("missing last event");
    const view = await adapter.readFeedbackStatus(read);
    expect(view).toEqual({
      ...scope,
      status: {
        ...submitted,
        status: "planned",
        updated_at: last.created_at,
        history: visible.slice(0, 25),
        next_cursor: visible[24]?.id,
      },
    });
    expect(JSON.stringify(view)).not.toContain("internal-only");
    const cursor = parseUlid(view?.status?.next_cursor ?? "");
    expect(await adapter.readFeedbackStatus({ ...read, cursor })).toEqual({
      ...scope,
      status: {
        ...submitted,
        status: "planned",
        updated_at: last.created_at,
        history: [last],
        next_cursor: null,
      },
    });
    expect(
      await adapter.readFeedbackStatus({ ...read, organizationIds: [parseUlid(newUlid())] }),
    ).toBeNull();
    await control.core
      .prepare(
        "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
      )
      .bind(p.organizationId, p.projectId)
      .run();
    await expect(adapter.submitFeedback(request)).rejects.toMatchObject({
      code: "resource_not_found",
    });
    // Retention removes the expired contact request and vote, and redacts the feedback older than twelve months;
    // the feedback row itself stays.
    expect(
      await purgeD1PublicEntries(commands.retention, new Date("2029-03-01T00:00:00.000Z")),
    ).toBe(3);
    expect(await control.core.prepare("SELECT count(*) n FROM customer_feedback").first()).toEqual({
      n: 1,
    });
  } finally {
    await control.dispose();
  }
}, 120_000);

it("bounds anonymous intake per source bucket and in total, while replays, conflicts, retention and the vote pool stay exact", async () => {
  const control = await createTestControl();
  try {
    const context = { directory: control.core, router: new SharedCoreRouter(control.core) },
      { contact: caps, vote: voteCaps } = PUBLIC_INTAKE_CAPS,
      sha = (text: string) => createHash("sha256").update(text).digest("hex"),
      at = (day: string) => `${day}T10:00:00.000Z`,
      stored = (day: string) => at(day).replace("Z", "000Z"),
      id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      // Real requests as the largest accepted contact would arrive: 8,000 three-byte characters.
      contact = (
        n: number,
        day: string,
        sourceBucket: number | null,
        message = "中".repeat(8000),
      ) => ({
        requestId: id(n),
        payloadSha256: sha(message + n),
        name: "Reader",
        email: "reader@example.com",
        company: "",
        message,
        now: at(day),
        sourceBucket,
      }),
      vote = (n: number, day: string, sourceBucket: number) => ({
        key: id(n),
        feature: "eu",
        choice: "up",
        voterSha256: "a1".repeat(32),
        now: at(day),
        sourceBucket,
      }),
      // Rows an earlier flood or earlier days left: `rows` rows from number `first`, spread over `spread` buckets.
      fill = (
        table: "contact_requests" | "beta_feature_interests",
        day: string,
        first: number,
        rows: number,
        bucket: number,
        spread = 1,
      ) =>
        control.core
          .prepare(
            `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i+1 FROM n WHERE i<?1+?2-1)
${
  table === "contact_requests"
    ? `INSERT INTO contact_requests(request_id,payload_sha256,name,email,company,message,created_at,expires_at,source_bucket)
SELECT printf('00000000-0000-4000-8000-%012d',i),zeroblob(32),'Filler','filler@example.com','','x',?3,?4,?5+(i-?1)%?6 FROM n`
    : `INSERT INTO beta_feature_interests(idempotency_key,feature,created_at,voter_sha256,choice,position,expires_at,source_bucket)
SELECT printf('00000000-0000-4000-8000-%012d',i),'eu',?3,zeroblob(32),'up',i,?4,?5+(i-?1)%?6 FROM n`
}`,
          )
          .bind(first, rows, stored(day), publicEntryExpiry(stored(day)), bucket, spread)
          .run(),
      one = async <T>(sql: string, ...values: unknown[]) =>
        (await control.core
          .prepare(sql)
          .bind(...values)
          .first<T>()) ?? undefined,
      count = async (table: string) =>
        (await one<{ n: number }>(`SELECT count(*) n FROM ${table}`))?.n,
      counted = async (kind: string, bucket: number, day: string) =>
        (
          await one<{ n: number }>(
            "SELECT coalesce(sum(entries),0) n FROM public_intake_budget WHERE kind=? AND bucket=? AND day=?",
            kind,
            bucket,
            day,
          )
        )?.n;
    // One source floods its bucket to the daily sub-cap, then is refused, while every other bucket is still served.
    for (let n = 1; n <= caps.bucketDay; n++)
      expect(await recordPublicContact(context, contact(n, "2028-03-10", 7))).toBe(true);
    await expect(recordPublicContact(context, contact(900, "2028-03-10", 7))).rejects.toThrow(
      "public_intake_day_full",
    );
    expect(await count("contact_requests")).toBe(caps.bucketDay);
    expect(await recordPublicContact(context, contact(901, "2028-03-10", 8))).toBe(true);
    // A stored key is never counted twice, from any bucket; a different payload under it is still a conflict.
    expect(await recordPublicContact(context, contact(1, "2028-03-10", 7))).toBe(true);
    expect(await recordPublicContact(context, contact(1, "2028-03-10", 8))).toBe(true);
    expect(
      await recordPublicContact(context, {
        ...contact(1, "2028-03-10", 7),
        payloadSha256: sha("x"),
      }),
    ).toBe(false);
    expect(await count("contact_requests")).toBe(caps.bucketDay + 1);
    expect(await counted("contact", 7, "2028-03-10")).toBe(caps.bucketDay);
    expect(await counted("contact", 8, "2028-03-10")).toBe(1);
    expect(await counted("contact", -1, "2028-03-10")).toBe(caps.bucketDay + 1);
    expect(
      await one("SELECT source_bucket FROM contact_requests WHERE request_id=?", id(901)),
    ).toEqual({
      source_bucket: 8,
    });
    // Other buckets are accepted until the day's pool is spent; then a fresh bucket is refused too.
    await fill("contact_requests", "2028-03-10", 1000, caps.day - caps.bucketDay - 2, 100, 40);
    expect(await recordPublicContact(context, contact(902, "2028-03-10", 200))).toBe(true);
    await expect(recordPublicContact(context, contact(903, "2028-03-10", 201))).rejects.toThrow(
      "public_intake_day_full",
    );
    // The next day brings a new share, also to the bucket that flooded.
    expect(await recordPublicContact(context, contact(904, "2028-03-11", 7))).toBe(true);
    // A bucket's live rows are capped over the retention period; another bucket still has room.
    await fill("contact_requests", "2028-01-15", 3000, caps.bucketTotal, 9);
    await expect(recordPublicContact(context, contact(905, "2028-03-12", 9))).rejects.toThrow(
      "public_intake_total_full",
    );
    expect(await recordPublicContact(context, contact(906, "2028-03-12", 10))).toBe(true);
    // The pool of live rows is capped too, however many buckets share it.
    let first = 5000;
    for (
      let left = caps.total - ((await count("contact_requests")) ?? 0), day = 1;
      left > 0;
      day++
    ) {
      const rows = Math.min(caps.day, left);
      await fill(
        "contact_requests",
        `2028-02-${String(day).padStart(2, "0")}`,
        first,
        rows,
        20,
        80,
      );
      first += rows;
      left -= rows;
    }
    expect(await count("contact_requests")).toBe(caps.total);
    await expect(recordPublicContact(context, contact(907, "2028-03-13", 250))).rejects.toThrow(
      "public_intake_total_full",
    );
    expect(await count("contact_requests")).toBe(caps.total);
    // The budget follows the rows exactly, so retention frees it with the oldest day.
    const all = () => counted("contact", -1, "total");
    expect(await all()).toBe(caps.total);
    const purged = await purgePublicEntries(context, { now: "2029-02-02T00:00:00.000Z" });
    expect(purged).toBeGreaterThan(0);
    expect(await all()).toBe(await count("contact_requests"));
    expect(
      (
        await one<{ n: number }>(
          "SELECT sum(entries) n FROM public_intake_budget WHERE kind='contact' AND bucket>=0 AND day='total'",
        )
      )?.n,
    ).toBe(await count("contact_requests"));
    expect(await recordPublicContact(context, contact(908, "2028-03-13", 250))).toBe(true);
    // A caller without a usable address has no bucket: it is served up to the pool's cap and counted in no real bucket.
    await fill("contact_requests", "2028-04-01", 12000, caps.day - caps.bucketDay - 1, -2);
    for (let n = 0; n <= caps.bucketDay; n++)
      expect(await recordPublicContact(context, contact(950 + n, "2028-04-01", null))).toBe(true);
    await expect(recordPublicContact(context, contact(970, "2028-04-01", null))).rejects.toThrow(
      "public_intake_day_full",
    );
    expect(
      await one("SELECT source_bucket FROM contact_requests WHERE request_id=?", id(950)),
    ).toEqual({
      source_bucket: -2,
    });
    expect(
      (
        await one<{ n: number }>(
          "SELECT count(*) n FROM public_intake_budget WHERE kind='contact' AND bucket BETWEEN 0 AND 255 AND day='2028-04-01'",
        )
      )?.n,
    ).toBe(0);
    // Votes have their own pool: a flood of one bucket is refused before the shared allocator is written ...
    await fill("beta_feature_interests", "2028-03-13", 1, voteCaps.bucketDay, 3);
    const allocator = () => one("SELECT last_value,is_called FROM beta_feature_vote_allocator");
    const before = await allocator();
    await expect(recordPublicFeatureVote(context, vote(7001, "2028-03-13", 3))).rejects.toThrow(
      "public_intake_day_full",
    );
    expect(await allocator()).toEqual(before);
    expect(await recordPublicFeatureVote(context, vote(7002, "2028-03-13", 4))).toBe(true);
    expect(await recordPublicFeatureVote(context, vote(7002, "2028-03-13", 3))).toBe(true);
    // ... and a spent vote pool never takes room from the contact requests.
    await fill(
      "beta_feature_interests",
      "2028-03-13",
      20000,
      voteCaps.day - voteCaps.bucketDay - 1,
      100,
      100,
    );
    await expect(recordPublicFeatureVote(context, vote(7003, "2028-03-13", 250))).rejects.toThrow(
      "public_intake_day_full",
    );
    expect(await recordPublicContact(context, contact(909, "2028-03-13", 251))).toBe(true);
  } finally {
    await control.dispose();
  }
}, 240_000);
