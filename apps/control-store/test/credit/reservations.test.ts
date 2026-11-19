import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  releaseReservation,
  reserve,
  runReleaseReservation,
  runReserve,
  runSettleReservation,
  settleReservation,
} from "../../src/catalog/credit/index.js";
import { classifyFailure } from "../../src/guards.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { OCT, accountOf, all, credits, first, logOf, newOrganization } from "./support.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

let sequence = 0;
const reservationId = () => ulidOf("reservation", (sequence += 1));

const hold = (
  organizationId: string,
  id: string,
  projectId: string | null,
  amount: number,
  now = OCT,
) =>
  runReserve(control.core, {
    organizationId,
    reservationId: id,
    projectId,
    amountMicros: credits(amount),
    now,
    detail: { operationId: "op-1" },
  });

describe("reserving credit for a build", () => {
  it("refuses a reservation larger than the available credit and changes nothing", async () => {
    const p = await newOrganization(control);
    const org = p.organizationId;
    const first = reservationId();
    expect(await hold(org, first, p.projectId, 150)).toEqual({
      reserved: true,
      balanceMicros: credits(200),
      availableMicros: credits(50),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(200),
      reserved_micros: credits(150),
    });
    const refused = reservationId();
    expect(await hold(org, refused, p.projectId, 60)).toEqual({
      reserved: false,
      reason: "insufficient_credits",
    });
    expect(
      await all(control.core, "SELECT 1 FROM credit_reservation WHERE reservation_id = ?", refused),
    ).toEqual([]);
    expect(await accountOf(control.core, org)).toMatchObject({ reserved_micros: credits(150) });
    // exactly the rest fits
    expect(await hold(org, reservationId(), null, 50)).toMatchObject({
      reserved: true,
      availableMicros: 0,
    });
    const log = await logOf(control.core, org);
    expect(log.map((row) => [row.kind, row.delta_micros])).toEqual([
      ["renew", credits(200)],
      ["reserve", 0],
      ["reserve", 0],
    ]);
    expect(JSON.parse(log[1]?.detail ?? "")).toEqual({
      operationId: "op-1",
      projectId: p.projectId,
      reservedMicros: credits(150),
    });
  });

  it("leaves the balance alone: only another reservation sees the reserved credit as taken", async () => {
    const org = (await newOrganization(control)).organizationId;
    await hold(org, reservationId(), null, 100);
    expect((await accountOf(control.core, org)).monthly_micros).toBe(credits(200));
    expect(await hold(org, reservationId(), null, 101)).toEqual({
      reserved: false,
      reason: "insufficient_credits",
    });
  });

  it("answers a reservation id that is already in use and refuses an organization that does not exist", async () => {
    const org = (await newOrganization(control)).organizationId;
    const id = reservationId();
    await hold(org, id, null, 10);
    expect(await hold(org, id, null, 10)).toEqual({ reserved: false, reason: "duplicate" });
    expect(await accountOf(control.core, org)).toMatchObject({ reserved_micros: credits(10) });
    const ghost = reserve(control.core, {
      organizationId: ulidOf("ghost", 10),
      reservationId: reservationId(),
      projectId: null,
      amountMicros: 1,
      now: OCT,
    });
    expect(
      classifyFailure(await control.core.batch(ghost.statements).catch((e: unknown) => e)),
    ).toEqual({
      kind: "guard",
      code: "organization_inactive",
    });
    await expect(
      runReserve(control.core, {
        organizationId: ulidOf("ghost", 10),
        reservationId: reservationId(),
        projectId: null,
        amountMicros: 1,
        now: OCT,
      }),
    ).rejects.toThrow(/guard_organization_inactive/u);
    expect(() =>
      reserve(control.core, {
        organizationId: org,
        reservationId: id,
        projectId: null,
        amountMicros: 0,
        now: OCT,
      }),
    ).toThrow(RangeError);
  });
});

describe("settling a reservation", () => {
  const settle = (organizationId: string, id: string, charged: number, now = OCT) =>
    runSettleReservation(control.core, {
      organizationId,
      reservationId: id,
      chargedMicros: credits(charged),
      now,
      detail: { operationId: "op-1" },
    });

  it("charges the actual cost, gives back the rest and removes the reservation", async () => {
    const p = await newOrganization(control);
    const org = p.organizationId;
    const id = reservationId();
    await hold(org, id, p.projectId, 100);
    expect(await settle(org, id, 30)).toEqual({
      settled: true,
      reservedMicros: credits(100),
      chargedMicros: credits(30),
      releasedMicros: credits(70),
      balanceMicros: credits(170),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(170),
      reserved_micros: 0,
      exhausted_at: null,
    });
    expect(
      await all(control.core, "SELECT 1 FROM credit_reservation WHERE reservation_id = ?", id),
    ).toEqual([]);
    expect(
      (
        await first<{ used_micros: number }>(
          control.core,
          "SELECT used_micros FROM project_credit WHERE project_id = ?",
          p.projectId,
        )
      ).used_micros,
    ).toBe(credits(30));
    const row = (await logOf(control.core, org)).find((entry) => entry.key === `settle:${id}`);
    expect(row).toMatchObject({
      kind: "settle",
      delta_micros: -credits(30),
      balance_micros: credits(170),
    });
    expect(JSON.parse(row?.detail ?? "")).toEqual({
      operationId: "op-1",
      projectId: p.projectId,
      reservedMicros: credits(100),
      chargedMicros: credits(30),
      releasedMicros: credits(70),
    });
  });

  it("charges more than was reserved when the build cost more, and spends like usage", async () => {
    const org = (await newOrganization(control)).organizationId;
    const id = reservationId();
    await hold(org, id, null, 100);
    expect(await settle(org, id, 250)).toMatchObject({
      settled: true,
      releasedMicros: 0,
      balanceMicros: 0,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      overrun_micros: credits(50),
      reserved_micros: 0,
      exhausted_at: "2026-10-30T10:00:00.000000Z",
    });
    // a reservation without a project counts against none
    expect(
      await all(control.core, "SELECT 1 FROM project_credit WHERE organization_id = ?", org),
    ).toEqual([]);
  });

  it("renews a month that ended while the build ran before it charges", async () => {
    const org = (await newOrganization(control)).organizationId;
    const id = reservationId();
    await hold(org, id, null, 100);
    expect(await settle(org, id, 40, "2026-11-02T00:00:00.000Z")).toMatchObject({
      settled: true,
      balanceMicros: credits(160),
    });
    expect((await logOf(control.core, org)).map((row) => row.kind)).toEqual([
      "renew",
      "reserve",
      "expire",
      "renew",
      "settle",
    ]);
  });

  it("settles and releases once, and names why a second attempt did nothing", async () => {
    const p = await newOrganization(control);
    const org = p.organizationId;
    const other = (await newOrganization(control)).organizationId;
    const settled = reservationId();
    const released = reservationId();
    await hold(org, settled, null, 10);
    await hold(org, released, null, 20);
    expect(await settle(other, settled, 5)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
    expect(await settle(org, settled, 5)).toMatchObject({ settled: true });
    expect(await settle(org, settled, 5)).toEqual({ settled: false, reason: "already_resolved" });
    expect(await settle(org, reservationId(), 5)).toEqual({
      settled: false,
      reason: "unknown_reservation",
    });
    expect(
      await runReleaseReservation(control.core, {
        organizationId: other,
        reservationId: released,
        now: OCT,
      }),
    ).toEqual({ released: false, reason: "unknown_reservation" });
    expect(
      await runReleaseReservation(control.core, {
        organizationId: org,
        reservationId: released,
        now: OCT,
      }),
    ).toEqual({
      released: true,
      releasedMicros: credits(20),
      balanceMicros: credits(195),
    });
    expect(
      await runReleaseReservation(control.core, {
        organizationId: org,
        reservationId: released,
        now: OCT,
      }),
    ).toEqual({
      released: false,
      reason: "already_resolved",
    });
    expect(await settle(org, released, 5)).toEqual({ settled: false, reason: "already_resolved" });
    expect(await accountOf(control.core, org)).toMatchObject({
      reserved_micros: 0,
      monthly_micros: credits(195),
    });
    const log = await logOf(control.core, org);
    expect(log.filter((row) => row.kind === "release")).toHaveLength(1);
    expect(log.filter((row) => row.kind === "settle")).toHaveLength(1);
  });
});

describe("composing a reservation with the caller's own writes", () => {
  it("commits the reservation with them, and a failing write of the caller rolls it back", async () => {
    const p = await newOrganization(control);
    const org = p.organizationId;
    const db = control.core;
    const id = reservationId();
    const plan = reserve(db, {
      organizationId: org,
      reservationId: id,
      projectId: p.projectId,
      amountMicros: credits(25),
      now: OCT,
    });
    const own = (key: string) =>
      db
        .prepare(
          "INSERT INTO usage_cursor(source, through) VALUES (?1, '2026-10-30T00:00:00.000000Z')",
        )
        .bind(key);
    const results = await db.batch([own("compose-a"), ...plan.statements]);
    expect(plan.read(results.slice(1))).toMatchObject({
      reserved: true,
      availableMicros: credits(175),
    });

    // the same plan behind a statement that fails: nothing of either part persists
    const rolledBack = reservationId();
    const second = reserve(db, {
      organizationId: org,
      reservationId: rolledBack,
      projectId: null,
      amountMicros: credits(5),
      now: OCT,
    });
    await expect(db.batch([...second.statements, own("compose-a")])).rejects.toThrow(/UNIQUE/u);
    expect(
      await all(db, "SELECT 1 FROM credit_reservation WHERE reservation_id = ?", rolledBack),
    ).toEqual([]);
    expect(await accountOf(db, org)).toMatchObject({ reserved_micros: credits(25) });

    // settle and release compose the same way
    const settled = settleReservation(db, {
      organizationId: org,
      reservationId: id,
      chargedMicros: credits(10),
      now: OCT,
    });
    const next = reservationId();
    await hold(org, next, null, 15);
    const releasing = releaseReservation(db, {
      organizationId: org,
      reservationId: next,
      now: OCT,
    });
    const both = await db.batch([own("compose-b"), ...settled.statements, ...releasing.statements]);
    const settledAt = 1 + settled.statements.length;
    expect(settled.read(both.slice(1, settledAt))).toMatchObject({
      chargedMicros: credits(10),
      releasedMicros: credits(15),
    });
    expect(releasing.read(both.slice(settledAt))).toMatchObject({
      released: true,
      releasedMicros: credits(15),
    });
    expect(await accountOf(db, org)).toMatchObject({
      reserved_micros: 0,
      monthly_micros: credits(190),
    });
  });
});
