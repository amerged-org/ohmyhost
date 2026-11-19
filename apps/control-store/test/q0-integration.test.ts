import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { reserve } from "../src/catalog/credit/index.js";
import { BucketMovingError } from "../src/fence.js";
import { bucketOf } from "../src/router.js";
import { createControlStore } from "../src/store.js";
import { coreRouter, createTestControl, type TestControl } from "./support/control-d1.js";
import { grantOneTime } from "./support/credit-fixtures.js";
import { bytes, seedProject } from "./support/platform-fixtures.js";

const state = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = state.env;
  },
}));

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
  state.env = control.bindings;
});
afterAll(async () => control.dispose());

const at = "2026-10-28T10:00:05.000000Z";

describe("Q0 integrated store: authority, fence and composition", () => {
  it("keeps raw archive and global sweeps off the ordinary surfaces", () => {
    const store = createControlStore(control.bindings);
    // the one paid-domain admission the dedicated CloudflareDomainRuntime serves; no ordinary or maintenance entrypoint has it
    expect(Object.keys(store.billing)).toEqual(["admitPaidProjectDomain"]);
    expect(store.domains).not.toHaveProperty("settleDomainReservations");
    expect(store.maintenance).toHaveProperty("settleDomainReservations");
  });

  it("exposes platform commands on ControlRuntime, the global sweep only on MaintenanceRuntime, and no billing anywhere", async () => {
    const entry = await import("../src/worker-main.js");
    type Rpc = Record<string, (input: unknown) => Promise<unknown>>;
    const ordinary = new (entry.ControlRuntime as unknown as new () => Rpc)();
    const maintenance = new (entry.MaintenanceRuntime as unknown as new () => Rpc)();
    const platform = [
      "putEnvironmentSecret",
      "ensureEnvironmentSecret",
      "mutateEnvironmentSecret",
      "listEnvironmentSecrets",
      "authorizeProviderEnvironmentSecret",
      "claimCloudflareProjectDomainsOperation",
      "putCloudflareProjectDomains",
      "readCloudflareProjectDomains",
      "readCloudflareProjectDomainsForOperation",
      "readCloudflareProjectDomainsByIdempotency",
      "putCloudflareProjectDomainReceipt",
      "readCloudflareProjectDomainReceipts",
      "readCloudflareProjectDomainDeletionState",
      "markCloudflareProjectDomainsDeletedForDeletion",
    ];
    for (const method of platform) {
      await expect(ordinary[method]?.({ unexpected: true }), method).rejects.toThrow();
      expect(maintenance[method], method).toBeUndefined();
    }
    expect(ordinary["settleDomainReservations"]).toBeUndefined();
    expect(
      await maintenance["settleDomainReservations"]?.({ now: "2026-10-28T10:00:00.000Z" }),
    ).toEqual({
      confirmed: 0,
      released: 0,
    });
    for (const runtime of [ordinary, maintenance]) {
      for (const name of [
        "postUsage",
        "readLogPage",
        "deleteLogThrough",
        "admitPaidProjectDomain",
      ]) {
        expect(runtime[name], name).toBeUndefined();
      }
    }
  });

  it("admits a Paid project domain through the store's refreshed billing command: a free organization is refused, and the answer is stable", async () => {
    const store = createControlStore(control.bindings);
    const project = await seedProject(control);
    const input = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      now: at,
    };
    const first = await store.billing.admitPaidProjectDomain(input);
    expect(first).toBe("paid_plan_required");
    expect(await store.billing.admitPaidProjectDomain(input)).toBe(first);
  });

  it("composes a reservation with another accepted state in ONE batch: both land, or neither does", async () => {
    const project = await seedProject(control);
    const db = (await coreRouter(control).routeOrganization(project.organizationId)).db;
    await grantOneTime(db, project.organizationId, 1_000);
    const compose = async (reservationId: string, failOther: boolean) => {
      const plan = reserve(db, {
        organizationId: project.organizationId,
        projectId: project.projectId,
        reservationId,
        amountMicros: 400,
        now: at,
      });
      // Stand-in for the other context's accepted state and outbox rows: a row of its own in the same batch.
      const other = failOther
        ? db.prepare("INSERT INTO guard_fail(code) SELECT 'operation_conflict' WHERE 1")
        : db
            .prepare(
              "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES (?, 'composed.other', 'd', '{}', 1)",
            )
            .bind(`other-${reservationId}`);
      return db.batch([...plan.statements, other]);
    };
    const reservations = async () =>
      (
        await db
          .prepare("SELECT count(*) AS n FROM credit_reservation WHERE organization_id = ?")
          .bind(project.organizationId)
          .first<{ n: number }>()
      )?.n;
    await expect(compose("01HQ0HD000000000000000001A", true)).rejects.toThrow(
      /guard_operation_conflict/u,
    );
    expect(await reservations()).toBe(0);
    await compose("01HQ0HD000000000000000002B", false);
    expect(await reservations()).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM command_log WHERE name = 'composed.other'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});

describe("Q0 integrated store: the bucket fence covers platform and billing commands", () => {
  it("refuses secret, domain and billing writes of a moving bucket, and billing reads of a moved one, with nothing applied", async () => {
    const store = createControlStore(control.bindings);
    const project = await seedProject(control);
    const bucket = await bucketOf(project.organizationId);
    await project.shard
      .prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moving', ?, '2026-10-28T12:00:00.000000Z')",
      )
      .bind(bucket, "01HQ0MV000000000000000001D")
      .run();
    await expect(
      store.secrets.putEnvironmentSecret({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
        name: "DATABASE_URL",
        ciphertext: bytes(32, 0xa1),
        nonce: bytes(12, 0xb2),
        valueSha256: bytes(32, 0xc3),
        keyVersion: 1,
        writtenAt: at,
      }),
    ).rejects.toBeInstanceOf(BucketMovingError);
    await expect(
      store.credit.postUsage({
        organizationId: project.organizationId,
        source: "wfp",
        window: "2026-10-28T10:00:00.000Z",
        lines: [
          {
            projectId: project.projectId,
            environmentId: project.prodEnvironmentId,
            meter: "wfp.requests",
            quantity: "1",
            unit: "request",
            rateCardId: "fenced",
            chargeMicros: 1,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BucketMovingError);
    const count = async (table: string) =>
      (
        await project.shard
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE organization_id = ?`)
          .bind(project.organizationId)
          .first<{ n: number }>()
      )?.n;
    expect(await count("environment_secrets")).toBe(0);
    expect(await count("credit_log")).toBe(0);
    // Reads of a moving bucket stay served; a moved bucket refuses them as well.
    expect(await store.credit.readLogsToday({ organizationId: project.organizationId })).toEqual(
      [],
    );
    await project.shard
      .prepare("UPDATE bucket_fences SET state = 'moved' WHERE bucket = ?")
      .bind(bucket)
      .run();
    await expect(
      store.credit.readLogsToday({ organizationId: project.organizationId }),
    ).rejects.toBeInstanceOf(BucketMovingError);
    await expect(
      store.secrets.listEnvironmentSecrets({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      }),
    ).rejects.toBeInstanceOf(BucketMovingError);
    await project.shard.prepare("DELETE FROM bucket_fences WHERE bucket = ?").bind(bucket).run();
  });
});
