import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import * as mail from "../../src/catalog/mail/delivery.js";
import * as commands from "../../src/catalog/mail/delivery-commands.js";
import { mailFixture, seedReceivedMail } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { SharedCoreRouter } from "../../src/router.js";
import type { D1Database } from "../../src/d1-types.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
const HOUR = 3600000;
const after = (instant: string, milliseconds: number) =>
  new Date(Date.parse(instant) + milliseconds).toISOString();
/** A Core whose first committed write loses its reply, so the caller must surface the unknown outcome. */
function replyLostOnce(): {
  context: { directory: D1Database; router: SharedCoreRouter };
  lose(): void;
} {
  let lose = true;
  const db: D1Database = {
    prepare: (sql) => control.core.prepare(sql),
    batch: async (statements) => {
      const result = await control.core.batch(statements);
      if (lose && result.some((row) => Number(row.meta?.changes ?? 0) > 0)) {
        lose = false;
        throw new Error("Network connection lost");
      }
      return result;
    },
  };
  return {
    context: { directory: db, router: new SharedCoreRouter(db) },
    lose: () => {
      lose = true;
    },
  };
}
async function fixture() {
  const f = await mailFixture(control),
    { messageId, providerMessageId } = await seedReceivedMail(f);
  /** The complete received-mail row: the 72-hour deadline, a pending first delivery, and the receiving domain's webhook. */
  const row = (patch: Record<string, unknown> = {}) => ({
    message_id: messageId,
    provider_message_id: providerMessageId,
    domain_id: f.domainId,
    organization_id: f.scope.organizationId,
    project_id: f.scope.projectId,
    environment_id: f.scope.environmentId,
    received_at: f.now,
    expires_at: after(f.now, 72 * HOUR),
    state: "pending",
    attempts: 0,
    first_attempt_at: null,
    lease_until: null,
    next_attempt_at: f.now,
    last_http_status: null,
    billed_at: null,
    domain: f.domain,
    webhook_url: "https://receiver.example.com/mail",
    webhook_secret_generation: 0,
    ...patch,
  });
  return { ...f, messageId, row, request: { ...f.scope, messageId, now: f.now } };
}
it("reads, lists, schedules and claims a received message and retains the pre-update claim reply, receiving owner and manual retry", async () => {
  const f = await fixture();
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(f.row());
  const list = { ...f.scope, now: f.now };
  expect(await mail.listReceivedMail(f.context, list)).toEqual([
    { message_id: f.messageId, received_at: f.now, state: "pending", attempts: 0 },
  ]);
  expect(await mail.listDueReceivedMail(f.context, { now: f.now })).toContainEqual({
    messageId: f.messageId,
    ...f.scope,
  });
  for (const field of ["organizationId", "projectId", "environmentId"] as const) {
    const wrong = { ...f.request, [field]: newUlid() };
    expect(await mail.readReceivedMail(f.context, wrong)).toBeNull();
    expect(await mail.claimReceivedMailAttempt(f.context, wrong)).toBeNull();
    expect(
      await mail.listReceivedMail(f.context, { ...f.scope, [field]: wrong[field], now: f.now }),
    ).toEqual([]);
  }
  // The claim returns the row as it was before the update, with only the attempt and the first attempt time set.
  const claim = await mail.claimReceivedMailAttempt(f.context, f.request);
  expect(claim).toEqual(f.row({ attempts: 1, first_attempt_at: f.now }));
  await mail.completeReceivedMailAttempt(f.context, {
    messageId: f.messageId,
    attempt: 1,
    now: f.now,
    status: 500,
  });
  const failed = f.row({
    attempts: 1,
    first_attempt_at: f.now,
    last_http_status: 500,
    next_attempt_at: after(f.now, HOUR),
  });
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(failed);
  // The retry is not due for an hour, but the owner may retry manually at once.
  expect(await mail.claimReceivedMailAttempt(f.context, f.request)).toBeNull();
  expect(await mail.claimReceivedMailAttempt(f.context, { ...f.request, manual: true })).toEqual({
    ...failed,
    attempts: 2,
  });
  // Outbound lifecycle revocation removes the inbound access too.
  await f.update(
    "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  expect(await mail.readReceivedMail(f.context, f.request)).toBeNull();
}, 120000);
it("runs all four attempts on the 1/24/71-hour schedule, expires the fourth lease and the 72-hour deadline, and keeps the deadline immutable", async () => {
  const f = await fixture();
  // After each failed attempt: the next attempt is due 1 h, 24 h and 71 h after the first one (the fourth is final).
  const nextAfter = [HOUR, 24 * HOUR, 71 * HOUR, 71 * HOUR];
  let last = f.row();
  for (const [index, hours] of [0, 1, 24, 71].entries()) {
    const now = after(f.now, hours * HOUR),
      request = { ...f.request, now };
    expect(await mail.claimReceivedMailAttempt(f.context, request)).toEqual({
      ...last,
      attempts: index + 1,
      first_attempt_at: f.now,
    });
    await mail.completeReceivedMailAttempt(f.context, {
      messageId: f.messageId,
      attempt: index + 1,
      now,
      status: 500,
    });
    last = f.row({
      attempts: index + 1,
      first_attempt_at: f.now,
      last_http_status: 500,
      next_attempt_at: after(f.now, nextAfter[index] ?? 0),
      state: index === 3 ? "delivery_failed" : "pending",
    });
    expect(await mail.readReceivedMail(f.context, request)).toEqual(last);
  }
  const expired = after(f.now, 72 * HOUR);
  for (const now of [after(f.now, 71 * HOUR + 1000), expired]) {
    const terminal = { ...f.request, now };
    expect(await mail.claimReceivedMailAttempt(f.context, terminal)).toBeNull();
    expect(await mail.readReceivedMail(f.context, terminal)).toEqual({
      ...last,
      state: now === expired ? "expired" : "delivery_failed",
    });
  }
  await mail.expireReceivedMail(f.context, { now: expired });
  expect(await mail.readReceivedMail(f.context, { ...f.request, now: expired })).toEqual({
    ...last,
    state: "expired",
  });
  await expect(
    control.core
      .prepare("UPDATE mail_received_messages SET expires_at=? WHERE message_id=?")
      .bind(storedTimestamp(f.now), f.messageId)
      .run(),
  ).rejects.toThrow();
  // A fourth attempt whose lease runs out without completion fails the delivery; a lost reply of that housekeeping is surfaced.
  const timeout = await fixture();
  for (const [index, hours] of [0, 1, 24, 71].entries()) {
    const now = after(timeout.now, hours * HOUR),
      claimed = await mail.claimReceivedMailAttempt(timeout.context, { ...timeout.request, now });
    expect(claimed).toMatchObject({ attempts: index + 1, first_attempt_at: timeout.now });
    if (index < 3)
      await mail.completeReceivedMailAttempt(timeout.context, {
        messageId: timeout.messageId,
        attempt: index + 1,
        now,
        status: 500,
      });
  }
  const expiredLease = after(timeout.now, 71 * HOUR + 120001),
    lost = replyLostOnce();
  await expect(mail.expireReceivedMail(lost.context, { now: expiredLease })).rejects.toThrow(
    ": store_outcome_unknown",
  );
  expect(
    await mail.readReceivedMail(timeout.context, { ...timeout.request, now: expiredLease }),
  ).toEqual(
    timeout.row({
      attempts: 4,
      first_attempt_at: timeout.now,
      last_http_status: 500,
      next_attempt_at: after(timeout.now, 71 * HOUR),
      state: "delivery_failed",
    }),
  );
}, 120000);
it("surfaces committed claim/completion loss and rolls back the message attempt if the manual command cannot be claimed", async () => {
  const f = await fixture(),
    lost = replyLostOnce();
  await expect(mail.claimReceivedMailAttempt(lost.context, f.request)).rejects.toThrow(
    ": store_outcome_unknown",
  );
  // The committed claim holds the lease: nobody else may start the same attempt.
  expect(await mail.claimReceivedMailAttempt(f.context, f.request)).toBeNull();
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(
    f.row({
      attempts: 1,
      first_attempt_at: f.now,
      lease_until: after(f.now, 120000),
      next_attempt_at: after(f.now, HOUR),
      state: "delivering",
    }),
  );
  lost.lose();
  await expect(
    mail.completeReceivedMailAttempt(lost.context, {
      messageId: f.messageId,
      attempt: 1,
      now: f.now,
      status: 200,
    }),
  ).rejects.toThrow(": store_outcome_unknown");
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(
    f.row({
      attempts: 1,
      first_attempt_at: f.now,
      last_http_status: 200,
      next_attempt_at: after(f.now, HOUR),
      state: "delivered",
    }),
  );
  const retry = await fixture(),
    before = await mail.readReceivedMail(retry.context, retry.request);
  expect(before).toEqual(retry.row());
  await expect(
    mail.claimReceivedMailAttempt(retry.context, {
      ...retry.request,
      manual: true,
      commandKey: "missing-command",
    }),
  ).rejects.toThrow("already claimed");
  expect(await mail.readReceivedMail(retry.context, retry.request)).toEqual(before);

  const digest = "47".repeat(32),
    accepted = { ...retry.scope, key: "manual-retry", digest, now: retry.now };
  expect(await commands.acceptMailDeliveryRetry(retry.context, accepted)).toEqual({
    created: true,
    response: null,
    claimedAttempt: null,
  });
  expect(await commands.acceptMailDeliveryRetry(retry.context, accepted)).toEqual({
    created: false,
    response: null,
    claimedAttempt: null,
  });
  await expect(
    commands.acceptMailDeliveryRetry(retry.context, { ...accepted, digest: "f".repeat(64) }),
  ).rejects.toThrow("idempotency_key_reused");
  // The 2-minute lease of the accepted command blocks a resume until it has run out.
  const resume = { ...retry.scope, key: accepted.key, now: accepted.now };
  expect(await commands.resumeMailDeliveryRetry(retry.context, resume)).toBe(false);
  const resumed = { ...resume, now: after(retry.now, 120000) };
  expect(await commands.resumeMailDeliveryRetry(retry.context, resumed)).toBe(true);
  expect(
    await mail.claimReceivedMailAttempt(retry.context, {
      ...retry.request,
      commandKey: accepted.key,
      manual: true,
    }),
  ).toEqual(retry.row({ attempts: 1, first_attempt_at: retry.now }));
  await commands.completeMailDeliveryRetry(retry.context, {
    ...resumed,
    response: { attempted: true, delivered: false },
  });
  expect(await commands.acceptMailDeliveryRetry(retry.context, accepted)).toEqual({
    created: false,
    response: { attempted: true, delivered: false },
    claimedAttempt: 1,
  });
  // Each command step survives a lost reply: the retried call observes the committed result.
  const unknownAccepted = { ...accepted, key: "manual-unknown" },
    lostAccept = replyLostOnce();
  await expect(
    commands.acceptMailDeliveryRetry(lostAccept.context, unknownAccepted),
  ).rejects.toThrow(": store_outcome_unknown");
  expect(await commands.acceptMailDeliveryRetry(retry.context, unknownAccepted)).toEqual({
    created: false,
    response: null,
    claimedAttempt: null,
  });
  const unknownResume = { ...resumed, key: unknownAccepted.key },
    lostResume = replyLostOnce();
  await expect(commands.resumeMailDeliveryRetry(lostResume.context, unknownResume)).rejects.toThrow(
    ": store_outcome_unknown",
  );
  expect(await commands.resumeMailDeliveryRetry(retry.context, unknownResume)).toBe(false);
  const unknownDone = { ...unknownResume, response: { attempted: false } },
    lostDone = replyLostOnce();
  await expect(commands.completeMailDeliveryRetry(lostDone.context, unknownDone)).rejects.toThrow(
    ": store_outcome_unknown",
  );
  expect(await commands.acceptMailDeliveryRetry(retry.context, unknownAccepted)).toEqual({
    created: false,
    response: { attempted: false },
    claimedAttempt: null,
  });
}, 120000);
it("refuses an automatic claim while a deferral holds the message, and lets the owner's manual retry through", async () => {
  const f = await fixture(),
    deferred = after(f.now, mail.PREREQUISITE_DEFERRAL_MILLISECONDS);
  await mail.deferReceivedMailAttempt(f.context, { ...f.request, attempt: 0 });
  // The deferred message is not due, so an automatic claim returns nothing and changes nothing.
  expect(await mail.claimReceivedMailAttempt(f.context, f.request)).toBeNull();
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(
    f.row({ next_attempt_at: deferred }),
  );
  // Once the deferral has passed, the automatic claim is served as the first attempt.
  expect(await mail.claimReceivedMailAttempt(f.context, { ...f.request, now: deferred })).toEqual(
    f.row({ attempts: 1, first_attempt_at: deferred, next_attempt_at: deferred }),
  );

  // The owner's manual retry is not held back by the deferral, as it is not held back by a retry schedule.
  const manual = await fixture();
  await mail.deferReceivedMailAttempt(manual.context, { ...manual.request, attempt: 0 });
  expect(
    await mail.claimReceivedMailAttempt(manual.context, { ...manual.request, manual: true }),
  ).toEqual(
    manual.row({
      attempts: 1,
      first_attempt_at: manual.now,
      next_attempt_at: after(manual.now, mail.PREREQUISITE_DEFERRAL_MILLISECONDS),
    }),
  );
}, 120000);

it("defers a due prerequisite failure one deferral without spending the attempt, fenced on the due row, and surfaces a lost deferral reply", async () => {
  const f = await fixture(),
    deferred = after(f.now, mail.PREREQUISITE_DEFERRAL_MILLISECONDS);
  // A deferral for another attempt number changes nothing.
  await mail.deferReceivedMailAttempt(f.context, { ...f.request, attempt: 1 });
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(f.row());
  await mail.deferReceivedMailAttempt(f.context, { ...f.request, attempt: 0 });
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(
    f.row({ next_attempt_at: deferred }),
  );
  // The moved row leaves the due queue until the deferral has passed, and a second deferral at that instant is a no-op.
  const due = { ...f.scope, messageId: f.messageId };
  expect(await mail.listDueReceivedMail(f.context, { now: f.now })).not.toContainEqual(due);
  await mail.deferReceivedMailAttempt(f.context, { ...f.request, attempt: 0 });
  expect(await mail.readReceivedMail(f.context, f.request)).toEqual(
    f.row({ next_attempt_at: deferred }),
  );
  expect(await mail.listDueReceivedMail(f.context, { now: deferred })).toContainEqual(due);

  const lost = await fixture(),
    reply = replyLostOnce();
  await expect(
    mail.deferReceivedMailAttempt(reply.context, { ...lost.request, attempt: 0 }),
  ).rejects.toThrow(": store_outcome_unknown");
  // The committed deferral is what the owner reads back.
  expect(await mail.readReceivedMail(lost.context, lost.request)).toEqual(
    lost.row({ next_attempt_at: after(lost.now, mail.PREREQUISITE_DEFERRAL_MILLISECONDS) }),
  );
}, 120000);

it("keeps an in-flight fourth attempt when a second claim arrives during its lease", async () => {
  const f = await fixture();
  for (const [index, hours] of [0, 1, 24].entries()) {
    const now = after(f.now, hours * HOUR);
    await mail.claimReceivedMailAttempt(f.context, { ...f.request, now });
    await mail.completeReceivedMailAttempt(f.context, {
      messageId: f.messageId,
      attempt: index + 1,
      now,
      status: 500,
    });
  }
  const claimed = after(f.now, 71 * HOUR);
  expect(
    await mail.claimReceivedMailAttempt(f.context, { ...f.request, now: claimed }),
  ).toMatchObject({ attempts: 4 });
  // A second claim (a cron sync or a manual retry) inside the fourth lease must neither fail the delivery nor drop it.
  const during = after(f.now, 71 * HOUR + 1000);
  expect(await mail.claimReceivedMailAttempt(f.context, { ...f.request, now: during })).toBeNull();
  expect(await mail.readReceivedMail(f.context, { ...f.request, now: during })).toMatchObject({
    attempts: 4,
    state: "delivering",
  });
  await mail.completeReceivedMailAttempt(f.context, {
    messageId: f.messageId,
    attempt: 4,
    now: during,
    status: 200,
  });
  expect(await mail.readReceivedMail(f.context, { ...f.request, now: during })).toMatchObject({
    state: "delivered",
    last_http_status: 200,
  });
}, 120000);
