import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnconfirmedStorageClaim } from "../src/core-persistence.js";
import { createUploadSweep, type UploadSweepDependencies } from "../src/upload-sweep.js";

const NOW = new Date("2026-10-29T12:30:00.000Z");
const OLD_EXPIRY = new Date("2026-10-01T00:05:00.000Z");

type Outcome = "erase" | "defer" | "fail";

function claimOf(transferId: string): UnconfirmedStorageClaim {
  return {
    organizationId: "01J0000000000000000000000A",
    projectId: "01J0000000000000000000000B",
    environmentId: "01J0000000000000000000000C",
    dataEnvironmentId: "01J0000000000000000000000D",
    transferId,
    objectKey: `${transferId}.bin`,
    physicalObjectKey: `d/${transferId}.bin`,
    jurisdiction: "eu",
    requestedAt: new Date("2026-10-01T00:00:00.000Z"),
  };
}

/**
 * Sweeps claims whose outcome is fixed: `erase` completes at once (the payload is already erased), `defer` is held by the
 * late-PUT drain (its expiry is now), and `fail` is refused by the provider before anything is written.
 */
function sweepOf(
  outcomes: readonly (readonly [string, Outcome])[],
  markAttempts: UploadSweepDependencies["markAttempts"] = async () => undefined,
) {
  const stamps: { now: string; transferIds: readonly string[] }[] = [];
  const outcomeOf = new Map(outcomes);
  const sweep = createUploadSweep({
    listUnconfirmed: async () => outcomes.map(([transferId]) => claimOf(transferId)),
    markAttempts: async (input: { now: string; transferIds: readonly string[] }) => {
      stamps.push(input);
      await markAttempts(input);
    },
    persistence: () => ({
      claimDelete: async (input: { objectKey: string }) => {
        const transferId = input.objectKey.replace(".bin", "");
        const outcome = outcomeOf.get(transferId);
        return {
          state: "claimed",
          objectKey: input.objectKey,
          deletionId: "01J0000000000000000000000E",
          environmentId: "01J0000000000000000000000C",
          dataEnvironmentId: "01J0000000000000000000000D",
          physicalObjectKey: `d/${transferId}.bin`,
          jurisdiction: "eu",
          expiresAt: outcome === "defer" ? NOW : OLD_EXPIRY,
          completedAt: null,
          transferId,
          payloadErased: outcome === "erase",
        };
      },
      completeDelete: async () => "created",
    }),
    provider: {
      observeObject: async (input: unknown) => {
        const key = (input as { objectKey: string }).objectKey;
        const transferId = key.replace("d/", "").replace(".bin", "");
        if (outcomeOf.get(transferId) === "fail")
          throw Object.assign(new Error("denied"), { code: "denied" });
        return { state: "absent", objectKey: key };
      },
      erasePayloads: async () => [],
    },
    ids: { next: () => "01J0000000000000000000000E" },
    sha256: async () => new Uint8Array(32),
    now: () => NOW,
  } as unknown as UploadSweepDependencies);
  return { sweep, stamps };
}

describe("storage upload sweep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stamps every claim it did not erase in the pass, and no erased claim", async () => {
    const { sweep, stamps } = sweepOf([
      ["failing", "fail"],
      ["erasable", "erase"],
    ]);

    expect(await sweep.sweep()).toEqual({ listed: 2, erased: 1, deferred: 0, failed: 1 });
    expect(stamps).toEqual([{ now: NOW.toISOString(), transferIds: ["failing"] }]);
  });

  it("stamps a claim the late-PUT drain defers, as a claim not yet finished", async () => {
    const { sweep, stamps } = sweepOf([
      ["deferred", "defer"],
      ["erasable", "erase"],
    ]);

    expect(await sweep.sweep()).toEqual({ listed: 2, erased: 1, deferred: 1, failed: 0 });
    expect(stamps).toEqual([{ now: NOW.toISOString(), transferIds: ["deferred"] }]);
  });

  it("does not stamp at all when every listed claim was erased", async () => {
    const { sweep, stamps } = sweepOf([
      ["first", "erase"],
      ["second", "erase"],
    ]);

    expect(await sweep.sweep()).toEqual({ listed: 2, erased: 2, deferred: 0, failed: 0 });
    expect(stamps).toEqual([]);
  });

  it("keeps the summary and logs only the stamp failure's code when the stamp throws after the erasures", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });
    const { sweep } = sweepOf(
      [
        ["erasable", "erase"],
        ["failing", "fail"],
      ],
      async () => {
        throw Object.assign(new Error("transferId failing is unavailable"), {
          code: "stamp_unavailable",
        });
      },
    );

    expect(await sweep.sweep()).toEqual({ listed: 2, erased: 1, deferred: 0, failed: 1 });
    const stampFailures = warnings.filter((line) =>
      line.includes("storage_upload_sweep_stamp_failed"),
    );
    expect(stampFailures).toEqual([
      JSON.stringify({ event: "storage_upload_sweep_stamp_failed", code: "stamp_unavailable" }),
    ]);
  });
});
