import { expect, it } from "vitest";
import { createTestControl } from "./support/control-d1.js";
import { losingWriteResponses, seedProject, ulidOf } from "./support/platform-fixtures.js";
import { SharedCoreRouter } from "../src/router.js";
import {
  submitCustomerFeedback,
  readCustomerFeedbackStatus,
} from "../src/catalog/public-entry/feedback.js";
import {
  applyFeedbackOperatorUpdate,
  readFeedbackOperatorPreview,
} from "../src/catalog/public-entry/feedback-operator.js";

it("previews an exact receipt and commits one customer-visible event, audit and replay even after a lost reply", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      id = ulidOf("feedback-operator", 1);
    const context = { directory: control.core, router: new SharedCoreRouter(control.core) };
    await submitCustomerFeedback(context, {
      report: {
        organization_id: project.organizationId,
        kind: "issue",
        title: "A problem",
        description: "The request did not complete.",
      },
      actorId: "user:customer",
      idempotencyKey: "operator-test",
      requestSha256: "01".repeat(32),
      feedbackId: id,
      submittedAt: "2025-01-01T00:00:00.123456Z",
    });
    const preview = await readFeedbackOperatorPreview(context, {
      feedbackId: id,
      runtimeEnvironment: "production",
    });
    expect(preview).toEqual({
      environment: "production",
      receipt: {
        id,
        organization_id: project.organizationId,
        submitted_at: "2025-01-01T00:00:00.123Z",
      },
      currentStatus: "received",
      lastEventId: null,
    });
    if (preview === null) throw new Error("missing preview");
    const update = {
      receipt: preview.receipt,
      expectedEnvironment: preview.environment,
      runtimeEnvironment: preview.environment,
      expectedStatus: preview.currentStatus,
      expectedLastEventId: preview.lastEventId,
      eventId: ulidOf("feedback-event", 1),
      actorId: "user:user_operator",
      status: "resolved",
      release: "0.1.50",
      reply: "The requested behavior is now available. 😀",
    };
    const lossy = losingWriteResponses(control.core, 1);
    const applied = await applyFeedbackOperatorUpdate(
      { directory: lossy, router: new SharedCoreRouter(lossy) },
      update,
    );
    expect(applied).toMatchObject({
      outcome: "recorded",
      eventId: update.eventId,
      status: "resolved",
      receipt: preview.receipt,
    });
    expect(await applyFeedbackOperatorUpdate(context, update)).toEqual(applied);
    await expect(
      applyFeedbackOperatorUpdate(context, {
        ...update,
        reply: "A different explanation for the same event.",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM customer_feedback_events WHERE feedback_id=?")
        .bind(id)
        .first(),
    ).toEqual({ n: 1 });
    const audit = await control.core
      .prepare(
        "SELECT actor_type,actor_id,event_type,payload FROM organization_audit_events WHERE audit_event_id=?",
      )
      .bind(update.eventId)
      .first();
    expect(audit).toMatchObject({
      actor_type: "operator",
      actor_id: "user:user_operator",
      event_type: "CustomerFeedbackStatusChangedV1",
    });
    expect(JSON.parse(String(audit?.["payload"]))).toMatchObject({
      feedbackId: id,
      environment: "production",
      status: "resolved",
      expectedLastEventId: null,
    });
    const customer = await readCustomerFeedbackStatus(context, {
      feedbackId: id,
      organizationIds: [project.organizationId],
    });
    expect(customer?.status).toMatchObject({
      status: "resolved",
      history: [{ id: update.eventId, status: "resolved", release: "0.1.50", reply: update.reply }],
    });
    await expect(
      control.core
        .prepare("UPDATE customer_feedback_events SET status='closed' WHERE event_id=?")
        .bind(update.eventId)
        .run(),
    ).rejects.toThrow();
  } finally {
    await control.dispose();
  }
}, 120_000);

it("allows only one of two concurrent decisions on the same reviewed head", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      id = ulidOf("feedback-race", 1);
    const context = { directory: control.core, router: new SharedCoreRouter(control.core) };
    await submitCustomerFeedback(context, {
      report: {
        organization_id: project.organizationId,
        kind: "issue",
        title: "Race",
        description: "A minimal concurrent status change.",
      },
      actorId: "user:customer",
      idempotencyKey: "race",
      requestSha256: "03".repeat(32),
      feedbackId: id,
      submittedAt: "2025-01-01T00:00:00.000Z",
    });
    const preview = await readFeedbackOperatorPreview(context, {
      feedbackId: id,
      runtimeEnvironment: "production",
    });
    if (preview === null) throw new Error("missing preview");
    const base = {
      receipt: preview.receipt,
      expectedEnvironment: "production",
      runtimeEnvironment: "production",
      expectedStatus: preview.currentStatus,
      expectedLastEventId: preview.lastEventId,
      actorId: "user:user_operator",
    };
    const results = await Promise.allSettled([
      applyFeedbackOperatorUpdate(context, {
        ...base,
        eventId: ulidOf("feedback-race-event", 1),
        status: "planned",
      }),
      applyFeedbackOperatorUpdate(context, {
        ...base,
        eventId: ulidOf("feedback-race-event", 2),
        status: "in_progress",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "feedback_state_changed" } },
    ]);
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM customer_feedback_events WHERE feedback_id=?")
        .bind(id)
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await control.core
        .prepare(
          "SELECT count(*) n FROM organization_audit_events WHERE event_type='CustomerFeedbackStatusChangedV1' AND organization_id=?",
        )
        .bind(project.organizationId)
        .first(),
    ).toEqual({ n: 1 });
  } finally {
    await control.dispose();
  }
}, 120_000);

it("rejects stale previews, invalid terminal explanations, wrong environments and atomic audit failure", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      id = ulidOf("feedback-operator", 2);
    const context = { directory: control.core, router: new SharedCoreRouter(control.core) };
    await submitCustomerFeedback(context, {
      report: {
        organization_id: project.organizationId,
        kind: "bug",
        title: "A bug",
        description: "A small reproduction of the error.",
      },
      actorId: "user:customer",
      idempotencyKey: "operator-test-two",
      requestSha256: "02".repeat(32),
      feedbackId: id,
      submittedAt: "2025-01-01T00:00:00.000Z",
    });
    const preview = await readFeedbackOperatorPreview(context, {
      feedbackId: id,
      runtimeEnvironment: "development",
    });
    if (preview === null) throw new Error("missing preview");
    const base = {
      receipt: preview.receipt,
      expectedStatus: preview.currentStatus,
      expectedLastEventId: preview.lastEventId,
      expectedEnvironment: "development",
      runtimeEnvironment: "development",
      eventId: ulidOf("feedback-event", 2),
      actorId: "user:user_operator",
      status: "resolved",
      release: "0.1.50",
      reply: "A sufficiently detailed explanation.",
    };
    await expect(
      applyFeedbackOperatorUpdate(context, { ...base, reply: "Too short" }),
    ).rejects.toThrow();
    await expect(
      applyFeedbackOperatorUpdate(context, {
        ...base,
        reply: "An invalid surrogate must be refused: \ud800",
      }),
    ).rejects.toThrow();
    await expect(
      applyFeedbackOperatorUpdate(context, { ...base, expectedEnvironment: "production" }),
    ).rejects.toThrow();
    await expect(
      applyFeedbackOperatorUpdate(context, { ...base, release: undefined }),
    ).rejects.toThrow();
    await control.core
      .prepare(
        "CREATE TRIGGER fixture_operator_audit_failure BEFORE INSERT ON organization_audit_events WHEN NEW.event_type='CustomerFeedbackStatusChangedV1' BEGIN SELECT RAISE(ABORT,'fixture_audit_failure'); END",
      )
      .run();
    await expect(applyFeedbackOperatorUpdate(context, base)).rejects.toThrow();
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM customer_feedback_events WHERE feedback_id=?")
        .bind(id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM command_log WHERE command_id=?")
        .bind(`feedback-operator:${base.eventId}`)
        .first(),
    ).toEqual({ n: 0 });
    await control.core.prepare("DROP TRIGGER fixture_operator_audit_failure").run();
    await applyFeedbackOperatorUpdate(context, {
      ...base,
      eventId: ulidOf("feedback-event", 3),
      status: "in_review",
      release: undefined,
      reply: undefined,
    });
    await expect(applyFeedbackOperatorUpdate(context, base)).rejects.toMatchObject({
      code: "feedback_state_changed",
    });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM customer_feedback_events WHERE feedback_id=?")
        .bind(id)
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await readFeedbackOperatorPreview(context, {
        feedbackId: ulidOf("missing-feedback", 1),
        runtimeEnvironment: "development",
      }),
    ).toBeNull();
  } finally {
    await control.dispose();
  }
}, 120_000);
