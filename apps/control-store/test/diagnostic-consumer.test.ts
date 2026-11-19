import { expect, it, vi } from "vitest";
import { createTestControl } from "./support/control-d1.js";
import { workflowFixture } from "./provisioning/workflow-fixture.js";
import { createControlStore } from "../src/store.js";
import type { D1Database } from "../src/d1-types.js";
import { newUlid } from "../src/catalog/common.js";
const entryState = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = entryState.env;
  },
}));
async function entrypoint(bindings: { CONTROL_CORE: D1Database }) {
  entryState.env = bindings;
  const entry = await import("../src/worker-main.js");
  return new (entry.DiagnosticConsumerRuntime as unknown as new () => InstanceType<
    typeof entry.DiagnosticConsumerRuntime
  >)();
}
it("records only signed-marker fields with their identity and retention and purges one atomic bounded page without retrying an unknown deletion", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    const store = r.store,
      input = {
        id: newUlid(),
        organizationId: r.p.organizationId,
        projectId: r.p.projectId,
        environmentId: r.input.environmentId,
        deploymentId: r.deployment,
        source: "runtime" as const,
        code: "RUNTIME_FAILED",
        catalogMessage: "CUSTOMER_RUNTIME_FAILED",
        occurredAt: "2026-10-28T11:00:00.000001Z",
        recordedAt: "2026-10-28T11:00:01.000Z",
      };
    expect(await (await entrypoint(c.bindings)).recordDiagnostic(input)).toBe("created");
    expect(
      await store.diagnosticConsumer.recordDiagnostic({
        ...input,
        recordedAt: "2026-10-28T11:00:02.000Z",
      }),
    ).toBe("existing");
    await expect(
      store.diagnosticConsumer.recordDiagnostic({
        ...input,
        occurredAt: "2026-10-28T11:00:00.000002Z",
      }),
    ).rejects.toThrow("identity conflicts");
    await expect(
      store.diagnosticConsumer.recordDiagnostic({ ...input, excerpt: "private text" }),
    ).rejects.toThrow();
    await expect(
      store.diagnosticConsumer.recordDiagnostic({ ...input, catalogMessage: "raw error" }),
    ).rejects.toThrow();
    await expect(
      store.diagnosticConsumer.recordDiagnostic({
        ...input,
        id: newUlid(),
        environmentId: newUlid(),
      }),
    ).rejects.toThrow();
    const row = await c.core
      .prepare("SELECT * FROM deployment_diagnostics WHERE diagnostic_event_id=?")
      .bind(input.id)
      .first();
    expect(row?.["occurred_at"]).toBe(input.occurredAt);
    expect(row?.["request_id"]).toBeNull();
    expect(row?.["excerpt"]).toBeNull();
    // Both timestamps must precede cutoff, and a page must never exceed its stated limit.
    const cutoff = "2026-11-05T11:00:02.000Z";
    for (let n = 0; n < 5; n++) {
      const one = {
        ...input,
        id: newUlid(),
        occurredAt: "2026-11-04T00:00:00.000Z",
        recordedAt: n === 4 ? "2026-11-06T00:00:00.000Z" : "2026-11-04T00:00:00.000Z",
      };
      await store.diagnosticConsumer.recordDiagnostic(one);
    }
    const ids = async () =>
      (
        await c.core
          .prepare(
            "SELECT diagnostic_event_id id FROM deployment_diagnostics ORDER BY occurred_at,diagnostic_event_id",
          )
          .all()
      ).results.map((row) => row["id"]);
    // Recording the newest diagnostic (recorded 2026-11-06) retires everything recorded more than seven days before it.
    const all = await ids();
    expect(all).toHaveLength(5);
    expect(all).not.toContain(input.id);
    const purge = { cutoff, limit: 2 };
    // Oldest first, never more than the page limit, and the row recorded after the cutoff survives.
    expect(await (await entrypoint(c.bindings)).purgeDiagnostics(purge)).toBe(2);
    expect(await ids()).toEqual(all.slice(2));
    expect(await store.diagnosticConsumer.purgeDiagnostics(purge)).toBe(2);
    expect(await ids()).toEqual(all.slice(4));
    expect(await store.diagnosticConsumer.purgeDiagnostics(purge)).toBe(0);
    await expect(
      store.diagnosticConsumer.purgeDiagnostics({ cutoff, limit: 1001 }),
    ).rejects.toThrow();
    const lost: D1Database = {
      prepare: (sql) => c.core.prepare(sql),
      async batch(statements) {
        await c.core.batch(statements);
        throw new Error("Network connection lost");
      },
    };
    for (let n = 0; n < 2; n++)
      await store.diagnosticConsumer.recordDiagnostic({
        ...input,
        id: newUlid(),
        occurredAt: "2026-11-06T00:00:00.000Z",
        recordedAt: "2026-11-06T00:00:00.000Z",
      });
    const beforeUnknown = await c.core
      .prepare("SELECT count(*) n FROM deployment_diagnostics")
      .first<{ n: number }>();
    const unknownPurge = { cutoff: "2026-11-10T00:00:00.000Z", limit: 1 };
    await expect(
      createControlStore({ CONTROL_CORE: lost }).diagnosticConsumer.purgeDiagnostics(unknownPurge),
    ).rejects.toMatchObject({ name: "StoreOutcomeUnknownError" });
    expect(
      (await c.core.prepare("SELECT count(*) n FROM deployment_diagnostics").first())?.["n"],
    ).toBe((beforeUnknown?.n ?? 0) - 1);
    const missing: D1Database = {
      prepare: (sql) => c.core.prepare(sql),
      async batch() {
        return [];
      },
    };
    await expect(
      createControlStore({ CONTROL_CORE: missing }).diagnosticConsumer.purgeDiagnostics(purge),
    ).rejects.toMatchObject({ name: "StoreOutcomeUnknownError" });
    const broken: D1Database = {
      prepare: (sql) => c.core.prepare(sql),
      async batch() {
        throw new Error("fixture permanent failure");
      },
    };
    await expect(
      createControlStore({ CONTROL_CORE: broken }).diagnosticConsumer.purgeDiagnostics(purge),
    ).rejects.toThrow("permanent failure");
  } finally {
    await c.dispose();
  }
}, 120_000);
