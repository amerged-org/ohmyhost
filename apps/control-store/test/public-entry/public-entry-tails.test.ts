import { expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { publicEntryExpiry, recordPublicContact } from "../../src/catalog/public-entry/entry.js";
import { submitCustomerFeedback } from "../../src/catalog/public-entry/feedback.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl } from "../support/control-d1.js";
import { losingWriteResponses, seedProject } from "../support/platform-fixtures.js";

it("clamps the twelve-month expiry of a leap day to the last day of the month", () => {
  expect(publicEntryExpiry("2028-02-29T12:13:14.123456Z")).toBe("2029-02-28T12:13:14.123456Z");
  expect(publicEntryExpiry("2026-10-31T00:00:00.000000Z")).toBe("2027-10-31T00:00:00.000000Z");
});

it("answers a contact request and a feedback report from their committed rows after a lost reply", async () => {
  const control = await createTestControl();
  try {
    const lossy = (extra: object = {}) => ({
      directory: losingWriteResponses(control.core, 1),
      router: new SharedCoreRouter(control.core),
      ...extra,
    });
    const contact = {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payloadSha256: "ab".repeat(32),
      name: "Reader",
      email: "reader@example.com",
      company: "",
      message: "Please provide the requested information.",
      now: "2028-02-29T12:13:14.123456Z",
      sourceBucket: 0,
    };
    expect(await recordPublicContact(lossy(), contact)).toBe(true);
    expect(
      await control.core
        .prepare("SELECT lower(hex(payload_sha256)) digest,expires_at FROM contact_requests")
        .first(),
    ).toEqual({ digest: contact.payloadSha256, expires_at: "2029-02-28T12:13:14.123456Z" });

    const project = await seedProject(control),
      feedbackId = newUlid(),
      submittedAt = "2026-10-29T10:00:00.000Z";
    const submission = {
      report: {
        organization_id: project.organizationId,
        project_id: project.projectId,
        environment_id: project.devEnvironmentId,
        kind: "issue" as const,
        title: "Original customer result",
        description: "A minimal redacted reproduction with the expected and observed behavior.",
      },
      actorId: "user:fixture",
      idempotencyKey: "feedback-tail",
      requestSha256: "01".repeat(32),
      feedbackId,
      submittedAt,
    };
    const lostRouter = {
      directory: control.core,
      router: new SharedCoreRouter(losingWriteResponses(control.core, 1)),
    };
    const stored = {
      outcome: "stored",
      receipt: {
        id: feedbackId,
        organization_id: project.organizationId,
        submitted_at: submittedAt,
      },
    };
    expect(await submitCustomerFeedback(lostRouter, submission)).toEqual(stored);
    expect(await control.core.prepare("SELECT count(*) n FROM customer_feedback").first()).toEqual({
      n: 1,
    });
    expect(await submitCustomerFeedback(lostRouter, submission)).toEqual(stored);
  } finally {
    await control.dispose();
  }
}, 30_000);
