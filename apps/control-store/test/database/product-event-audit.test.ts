import { afterAll, beforeAll, expect, it } from "vitest";
import { recordProductDatabaseEventAudit } from "../../src/catalog/database/product-access.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { NOW } from "../support/platform-fixtures.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});

it("records one principal audit event per database event change in the project's billing epoch", async () => {
  const f = await seedProductRuntimeFixture(control);
  const recorded = await recordProductDatabaseEventAudit(f.context, {
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev",
    principalId: "user:fixture",
    eventType: "ProjectDatabaseEventChangedV1",
    payload: { operation: "webhook.delete", resource_id: "whk_abcdefghij0123456789" },
    occurredAt: NOW,
  });
  expect(recorded).toEqual({ recorded: true });
  const row = await control.core
    .prepare(
      "SELECT actor_type,actor_id,event_type,payload,occurred_at,billing_epoch_id FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND event_type='ProjectDatabaseEventChangedV1'",
    )
    .bind(f.organizationId, f.projectId)
    .all();
  expect(row.results).toEqual([
    {
      actor_type: "principal",
      actor_id: "user:fixture",
      event_type: "ProjectDatabaseEventChangedV1",
      payload: JSON.stringify({
        operation: "webhook.delete",
        resource_id: "whk_abcdefghij0123456789",
      }),
      occurred_at: "2026-10-28T10:00:00.000000Z",
      billing_epoch_id: expect.any(String),
    },
  ]);
});

it("refuses an audit event for a project the Core does not know", async () => {
  const f = await seedProductRuntimeFixture(control);
  await expect(
    recordProductDatabaseEventAudit(f.context, {
      organizationId: f.organizationId,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FZZ",
      environment: "dev",
      principalId: "user:fixture",
      eventType: "ProjectDatabaseEventChangedV1",
      payload: {},
      occurredAt: NOW,
    }),
  ).rejects.toThrow();
});

it("records each export download link as an audit event and refuses the seventh one of an organization within a minute", async () => {
  const f = await seedProductRuntimeFixture(control);
  const link = (index: number, occurredAt: string) => ({
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev" as const,
    principalId: "user:fixture",
    eventType: "ProjectExportDownloadLinkIssuedV1" as const,
    payload: { operation_id: `01ARZ3NDEKTSV4RRFFQ69G5FA${index}` },
    occurredAt,
  });
  for (let index = 0; index < 6; index += 1)
    expect(await recordProductDatabaseEventAudit(f.context, link(index, NOW))).toEqual({
      recorded: true,
    });
  expect(await recordProductDatabaseEventAudit(f.context, link(6, NOW))).toEqual({
    recorded: false,
  });
  expect(
    await recordProductDatabaseEventAudit(f.context, link(7, "2026-10-28T10:02:00.000Z")),
  ).toEqual({ recorded: true });
  expect(
    await control.core
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE organization_id=?1 AND event_type='ProjectExportDownloadLinkIssuedV1'",
      )
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 7 });
});
