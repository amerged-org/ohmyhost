import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../src/catalog/common.js";
import { createControlStore } from "../src/store.js";
import { bucketOf } from "../src/router.js";
import {
  createTestControl,
  organizationIdWithShard,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const digest = (n: number) => n.toString(16).padStart(64, "0");
// The store command is the full WorkOS snapshot; these cases cover its organization part (no members).
const full = <Input extends object>(input: Input) => ({
  ...input,
  triggerEventId: "evt_organization_part",
  memberships: [],
  auditEventId: newUlid(),
});
const snapshot = (
  organizationId: string,
  workos: string,
  n: number,
  state: "active" | "suspended" = "active",
) => ({
  organizationId,
  workosOrganizationId: workos,
  state,
  snapshotDigest: digest(n),
  snapshotFetchedAt: `2026-10-28T10:00:0${n}.000Z`,
  synchronizedAt: `2026-10-28T10:00:0${n}.500Z`,
});

const shardRow = async (shard: number, id: string) =>
  shardOf(control, shard)
    .prepare(
      "SELECT state, mapping_revision, lower(hex(snapshot_sha256)) AS d, snapshot_fetched_at, synchronized_at FROM organizations WHERE organization_id = ?",
    )
    .bind(id)
    .first<{
      state: string;
      mapping_revision: number;
      d: string;
      snapshot_fetched_at: string;
      synchronized_at: string;
    }>();

describe("identity.applyOrganizationSnapshot", () => {
  it("creates the Directory claim and the organization row in the one shared core", async () => {
    const id = await organizationIdWithShard(2, 1, 1000);
    expect(
      await store.identity.applyOrganizationSnapshot(full(snapshot(id, "org_one", 1))),
    ).toEqual({
      organizationId: id,
      organizationChanged: true,
      changedMemberships: 0,
      ignoredAfterDeletion: false,
    });
    const claim = await control.directory
      .prepare("SELECT bucket, state FROM org_directory WHERE organization_id = ?")
      .bind(id)
      .first();
    expect(claim).toEqual({ bucket: await bucketOf(id), state: "active" });
    expect(await shardRow(1, id)).toMatchObject({
      state: "active",
      mapping_revision: 1,
      d: digest(1),
      snapshot_fetched_at: "2026-10-28T10:00:01.000000Z",
    });
  });

  it("refreshes only the timestamps for an identical snapshot and moves on for a newer one", async () => {
    const id = await organizationIdWithShard(2, 0, 2000);
    await store.identity.applyOrganizationSnapshot(full(snapshot(id, "org_two", 1)));
    const later = {
      ...snapshot(id, "org_two", 1),
      snapshotFetchedAt: "2026-10-28T10:05:00.000Z",
      synchronizedAt: "2026-10-28T10:05:00.000Z",
    };
    expect(await store.identity.applyOrganizationSnapshot(full(later))).toEqual({
      organizationId: id,
      organizationChanged: false,
      changedMemberships: 0,
      ignoredAfterDeletion: false,
    });
    expect(await shardRow(0, id)).toMatchObject({
      mapping_revision: 1,
      snapshot_fetched_at: "2026-10-28T10:05:00.000000Z",
    });
    const older = {
      ...snapshot(id, "org_two", 1),
      snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
      synchronizedAt: "2026-10-28T09:00:00.000Z",
    };
    await store.identity.applyOrganizationSnapshot(full(older));
    expect(await shardRow(0, id)).toMatchObject({
      snapshot_fetched_at: "2026-10-28T10:05:00.000000Z",
      synchronized_at: "2026-10-28T10:05:00.000000Z",
    });

    const suspended = {
      ...snapshot(id, "org_two", 2, "suspended"),
      snapshotFetchedAt: "2026-10-28T11:00:00.000Z",
      synchronizedAt: "2026-10-28T11:00:00.000Z",
    };
    expect(await store.identity.applyOrganizationSnapshot(full(suspended))).toEqual({
      organizationId: id,
      organizationChanged: true,
      changedMemberships: 0,
      ignoredAfterDeletion: false,
    });
    expect(await shardRow(0, id)).toMatchObject({
      state: "suspended",
      mapping_revision: 2,
      d: digest(2),
    });
    expect(
      (
        await control.directory
          .prepare("SELECT state FROM org_directory WHERE organization_id = ?")
          .bind(id)
          .first<{ state: string }>()
      )?.state,
    ).toBe("suspended");
  });

  it("refuses a different snapshot with a stale timestamp and a digest reused for other state", async () => {
    const id = await organizationIdWithShard(2, 0, 3000);
    await store.identity.applyOrganizationSnapshot(full(snapshot(id, "org_three", 5)));
    await expect(
      store.identity.applyOrganizationSnapshot(
        full({
          ...snapshot(id, "org_three", 6),
          snapshotFetchedAt: "2026-10-28T10:00:05.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "snapshot_timestamp_collision" });
    await expect(
      store.identity.applyOrganizationSnapshot(
        full({
          ...snapshot(id, "org_three", 5, "suspended"),
          snapshotFetchedAt: "2026-10-28T12:00:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "snapshot_digest_collision" });
  });

  it("refuses a WorkOS organization that belongs to another internal organization", async () => {
    const first = await organizationIdWithShard(2, 0, 4000);
    const second = await organizationIdWithShard(2, 1, 4100);
    await store.identity.applyOrganizationSnapshot(full(snapshot(first, "org_four", 1)));
    await expect(
      store.identity.applyOrganizationSnapshot(full(snapshot(second, "org_four", 1))),
    ).rejects.toMatchObject({ code: "workos_organization_mapped" });
    await expect(
      store.identity.applyOrganizationSnapshot(full(snapshot(first, "org_other", 2))),
    ).rejects.toMatchObject({ code: "workos_organization_mapped" });
    expect(await shardRow(1, second)).toBeNull();
  });

  it("treats a deleted organization as terminal: the snapshot is ignored and audited, nothing is revived", async () => {
    const id = await organizationIdWithShard(2, 1, 5000);
    await store.identity.applyOrganizationSnapshot(full(snapshot(id, "org_five", 1)));
    await shardOf(control, 1)
      .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
      .bind(id)
      .run();
    // the original ignores a snapshot of a deleted organization (it records WorkosOrganizationSnapshotIgnoredAfterDeletion)
    expect(
      await store.identity.applyOrganizationSnapshot(full(snapshot(id, "org_five", 3))),
    ).toEqual({
      organizationId: id,
      organizationChanged: false,
      changedMemberships: 0,
      ignoredAfterDeletion: true,
    });
    expect(await shardRow(1, id)).toMatchObject({
      state: "deleted",
      mapping_revision: 1,
      d: digest(1),
    });
    expect(
      (
        await shardOf(control, 1)
          .prepare(
            "SELECT count(*) AS n FROM organization_audit_events WHERE organization_id = ? AND event_type = 'WorkosOrganizationSnapshotIgnoredAfterDeletion'",
          )
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("creates exactly one organization when twins race, and applies racing updates one revision at a time", async () => {
    const id = await organizationIdWithShard(2, 0, 6000);
    const created = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.identity.applyOrganizationSnapshot(full(snapshot(id, "org_six", 1))),
      ),
    );
    expect(created.filter((result) => result.organizationChanged)).toHaveLength(1);
    const racing = await Promise.allSettled(
      [2, 3, 4, 5].map((n) =>
        store.identity.applyOrganizationSnapshot(
          full({
            ...snapshot(id, "org_six", n),
            snapshotFetchedAt: `2026-10-28T10:1${n}:00.000Z`,
            synchronizedAt: `2026-10-28T10:1${n}:00.000Z`,
          }),
        ),
      ),
    );
    // each applied snapshot moved the revision by exactly one; a racing older one is refused, never applied twice
    const applied = racing.filter(
      (result) => result.status === "fulfilled" && result.value.organizationChanged,
    ).length;
    expect(applied).toBeGreaterThan(0);
    expect((await shardRow(0, id))?.mapping_revision).toBe(1 + applied);
    expect(
      (
        await control.directory
          .prepare("SELECT count(*) AS n FROM org_directory WHERE organization_id = ?")
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("validates the input", async () => {
    await expect(store.identity.applyOrganizationSnapshot({})).rejects.toThrow();
    await expect(
      store.identity.applyOrganizationSnapshot(
        full({
          ...snapshot("01ARZ3NDEKTSV4RRFFQ69G5FAV", "org_x", 1),
          snapshotFetchedAt: "yesterday",
        }),
      ),
    ).rejects.toThrow(/ISO-8601/u);
    await expect(
      store.identity.applyOrganizationSnapshot(full(snapshot("not-a-ulid", "org_x", 1))),
    ).rejects.toThrow();
  });
});
