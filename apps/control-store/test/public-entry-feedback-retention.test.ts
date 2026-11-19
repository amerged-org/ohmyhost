import { afterAll, beforeAll, expect, it } from "vitest";
import type { CatalogContext } from "../src/catalog/common.js";
import { purgePublicEntries } from "../src/catalog/public-entry/entry.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const insert = (feedbackId: string, submittedAt: string, report: string) =>
  control.core
    .prepare(
      "INSERT INTO customer_feedback(feedback_id,organization_id,actor_id,idempotency_key,request_sha256,report,submitted_at) VALUES(?1,?2,'user:retention',?3,zeroblob(32),?4,?5)",
    )
    .bind(feedbackId, ORGANIZATION, `key-${feedbackId}`, report, submittedAt)
    .run();
const row = (feedbackId: string) =>
  control.core
    .prepare("SELECT report,redacted_at,submitted_at FROM customer_feedback WHERE feedback_id=?1")
    .bind(feedbackId)
    .first<{ report: string; redacted_at: string | null; submitted_at: string }>();

it("redacts feedback older than twelve months by the retention sweep and keeps the recent report", async () => {
  await insert(
    "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    "2025-01-01T00:00:00.000000Z",
    '{"description":"old secret"}',
  );
  await insert(
    "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    "2026-10-01T00:00:00.000000Z",
    '{"description":"recent"}',
  );
  const context = { directory: control.core } as unknown as CatalogContext;
  await purgePublicEntries(context, { now: "2026-11-13T00:00:00.000Z" });

  const old = await row("01ARZ3NDEKTSV4RRFFQ69G5FB1");
  expect(old?.report).toBe("{}");
  expect(old?.redacted_at).toBe("2026-11-13T00:00:00.000000Z");
  expect(old?.submitted_at).toBe("2025-01-01T00:00:00.000000Z");
  expect((await row("01ARZ3NDEKTSV4RRFFQ69G5FB2"))?.report).toBe('{"description":"recent"}');
});

it("keeps the append-only triggers: only the redaction transition is an update, and no feedback is deleted", async () => {
  await insert("01ARZ3NDEKTSV4RRFFQ69G5FB3", "2025-02-01T00:00:00.000000Z", '{"description":"x"}');
  await expect(
    control.core
      .prepare(
        'UPDATE customer_feedback SET report=\'{"description":"changed"}\' WHERE feedback_id=?1',
      )
      .bind("01ARZ3NDEKTSV4RRFFQ69G5FB3")
      .run(),
  ).rejects.toThrow("customer_feedback is append-only");
  await expect(
    control.core
      .prepare("DELETE FROM customer_feedback WHERE feedback_id=?1")
      .bind("01ARZ3NDEKTSV4RRFFQ69G5FB3")
      .run(),
  ).rejects.toThrow("customer_feedback is append-only");
});
