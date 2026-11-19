import { expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { createTestControl } from "../support/control-d1.js";
import {
  beforeFirstWrite,
  freezeOwnership,
  losingWriteResponses,
} from "../support/platform-fixtures.js";
import { gatewayFixture } from "./gateway-fixture.js";

it("activates, observes, replays, compensates and removes only the exact real current route while lookup keeps the published head", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control),
      management = r.store.gateway.management;
    const active = await management.activate(r.activation);
    expect(active).toMatchObject({
      revision: 2,
      predecessorRevision: 1,
      candidateReceiptId: r.candidateReceiptId,
      operationId: r.accepted.operationId,
      active: true,
    });
    expect(active.observedAt).toBeInstanceOf(Date);
    expect(await management.activate(r.activation)).toEqual(active);
    await expect(
      management.activate({ ...r.activation, egressAllowedOrigins: ["not-a-url"] }),
    ).rejects.toThrow();
    await expect(
      management.activate({
        ...r.activation,
        egressAllowedOrigins: ["https://z.example.test", "https://a.example.test"],
      }),
    ).rejects.toThrow();
    expect(await management.observe(r.scope)).toEqual(active);
    expect(await r.store.gateway.lookup.resolve({ hostname: r.hostname })).toMatchObject({
      targetDeploymentId: r.published.deploymentId,
      hostname: r.hostname,
    });
    const restored = await management.compensate({ ...r.mutation, expectedRevision: 2 });
    expect(restored).toMatchObject({
      revision: 3,
      predecessorRevision: 2,
      candidateReceiptId: r.published.candidateReceiptId,
      active: true,
    });
    expect(await management.compensate({ ...r.mutation, expectedRevision: 2 })).toEqual(restored);
    const removed = await management.remove({ ...r.mutation, expectedRevision: 3 });
    expect(removed).toMatchObject({
      revision: 4,
      predecessorRevision: 3,
      candidateReceiptId: r.published.candidateReceiptId,
      active: false,
    });
    expect(await management.remove({ ...r.mutation, expectedRevision: 3 })).toEqual(removed);
    expect(await r.store.gateway.lookup.resolve({ hostname: r.hostname })).toBeNull();
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 120_000);

it("guards the final owner snapshot and reconciles committed twin/lost responses without another route", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    const [first, second] = await Promise.all([
      lossy.gateway.management.activate(r.activation),
      r.store.gateway.management.activate(r.activation),
    ]);
    expect(second).toEqual(first);
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM shared_gateway_route_revisions WHERE organization_id=?")
        .bind(r.project.organizationId)
        .first(),
    ).toEqual({ n: 2 });
    // The twin above may win before the lossy call writes. Exercise a committed-but-lost reply separately so recovery
    // must read the command's durable identity, rather than merely replaying a concurrent winner's initial snapshot.
    const lost = await gatewayFixture(control);
    const recovered = await createControlStore({
      CONTROL_CORE: losingWriteResponses(control.core, 1),
    }).gateway.management.activate(lost.activation);
    expect(recovered).toMatchObject({
      revision: 2,
      predecessorRevision: 1,
      candidateReceiptId: lost.candidateReceiptId,
      operationId: lost.accepted.operationId,
      active: true,
    });
    expect(await lost.store.gateway.management.activate(lost.activation)).toEqual(recovered);
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM shared_gateway_route_revisions WHERE organization_id=?")
        .bind(lost.project.organizationId)
        .first(),
    ).toEqual({ n: 2 });
    const race = await gatewayFixture(control);
    const fenced = createControlStore({
      CONTROL_CORE: beforeFirstWrite(control.core, () => freezeOwnership(race.project)),
    });
    await expect(fenced.gateway.management.activate(race.activation)).rejects.toMatchObject({
      code: "shared_gateway_conflict",
    });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM shared_gateway_route_revisions WHERE organization_id=?")
        .bind(race.project.organizationId)
        .first(),
    ).toEqual({ n: 1 });
  } finally {
    await control.dispose();
  }
}, 120_000);

it("forces the SQL-clock original probe interval, replays its identity and refuses caller clocks", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control),
      windowId = r.accepted.claimId;
    const input = { ...r.scope, deploymentId: r.deploymentId, windowId };
    const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    const result = await lossy.gateway.probe.beginProbe(input);
    const row = await r.db
      .prepare("SELECT starts_at,expires_at FROM runtime_probe_windows WHERE window_id=?")
      .bind(windowId)
      .first<{ starts_at: string; expires_at: string }>();
    if (row === null) throw new Error("Probe receipt missing");
    expect(Date.parse(row.expires_at) - Date.parse(row.starts_at)).toBe(210_000);
    expect(result.expiresAt).toBe(new Date(row.expires_at).toISOString());
    expect(await r.store.gateway.probe.beginProbe(input)).toEqual(result);
    await expect(
      r.store.gateway.probe.beginProbe({ ...input, now: "2099-01-01T00:00:00.000Z" }),
    ).rejects.toThrow();
    await expect(
      r.store.gateway.probe.beginProbe({ ...input, duration: 900000 }),
    ).rejects.toThrow();
    expect(await r.db.prepare("SELECT count(*) n FROM runtime_probe_windows").first()).toEqual({
      n: 1,
    });
  } finally {
    await control.dispose();
  }
}, 120_000);
