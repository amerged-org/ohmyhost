import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../src/catalog/common.js";
import { createControlStore } from "../src/store.js";
import { createTestControl, shardOf, type TestControl } from "./support/control-d1.js";
import { digest, projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

describe("original evidence policy", () => {
  it("keeps all three original evidence namespaces immutable despite projection exports or prototype horizons", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    await store.projects.createInitialProject(projectInput(organizationId, "retained-handle"));
    const db = shardOf(control, 0);
    for (const tableName of [
      "audit_events",
      "organization_audit_events",
      "operation_events",
    ] as const) {
      const before = (
        await db
          .prepare(`SELECT * FROM ${tableName} WHERE organization_id=?`)
          .bind(organizationId)
          .all()
      ).results;
      expect(before.length).toBeGreaterThan(0);
      await expect(
        store.maintenance.advanceRetentionHorizon({
          shardId: 0,
          tableName,
          exportedThrough: "2099-01-01T00:00:00.000Z",
          now: "2027-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "evidence_immutable" });
      // Even an old prototype horizon or an asserted new read-only projection export grants no DELETE permission.
      await db
        .prepare(
          "INSERT INTO retention_horizon VALUES(?,'2099-01-01T00:00:00.000000Z','2027-01-01T00:00:00.000000Z')",
        )
        .bind(tableName)
        .run();
      const exported = {
        exportId: newUlid(),
        organizationId,
        tableName,
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2028-01-01T00:00:00.000Z",
        rowCount: before.length,
        sha256: digest(3),
        r2Key: `projection-fixture/${tableName}`,
        createdAt: "2027-01-01T00:00:00.000Z",
        sourceFormat: "d1-control-evidence-projection-v1",
      };
      expect(await store.maintenance.recordEvidenceExport(exported)).toBe("recorded");
      await expect(
        store.maintenance.purgeEvidenceBelowHorizon({ organizationId, tableName, limit: 100 }),
      ).rejects.toMatchObject({ code: "evidence_immutable" });
      await expect(
        db.prepare(`DELETE FROM ${tableName} WHERE organization_id=?`).bind(organizationId).run(),
      ).rejects.toThrow("append-only");
      await expect(
        db
          .prepare(
            `UPDATE ${tableName} SET occurred_at='2098-01-01T00:00:00.000000Z' WHERE organization_id=?`,
          )
          .bind(organizationId)
          .run(),
      ).rejects.toThrow("append-only");
      expect(
        (
          await db
            .prepare(`SELECT * FROM ${tableName} WHERE organization_id=?`)
            .bind(organizationId)
            .all()
        ).results,
      ).toEqual(before);
      const page = await store.maintenance.pageEvidenceRows({
        organizationId,
        tableName,
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2028-01-01T00:00:00.000Z",
        limit: 100,
      });
      expect(page.rows).toHaveLength(before.length);
    }
  });
});
