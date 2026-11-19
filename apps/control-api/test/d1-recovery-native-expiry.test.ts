import { expect, it, vi } from "vitest";
import { dispatchD1ProjectRecovery } from "../src/d1-recovery-dispatch.js";

it("dispatches Core-selected Native expiry through the existing private purge and retries unknown outcomes", async () => {
  const purge = {
    organizationId: "00000000000000000000000001",
    projectId: "00000000000000000000000002",
    operationId: "00000000000000000000000003",
    exportId: "00000000000000000000000003",
  };
  const invokeRecovery = vi
    .fn()
    .mockRejectedValueOnce(new Error("unknown"))
    .mockResolvedValueOnce({ status: "absent", exportId: purge.exportId });
  const maintenance = {
    prepareProjectRecoveryMaintenance: vi.fn().mockResolvedValue({
      cleared: 0,
      terminal: null,
      expired: [],
      dueNativeArchivePurges: [purge],
    }),
    claimProjectRecoveryOutbox: vi.fn().mockResolvedValue(null),
  };
  const input = {
    runtime: {},
    maintenance,
    clock: { now: () => new Date("2026-11-04T00:00:00.000Z") },
    ids: { next: () => "00000000000000000000000004" },
    uuid: () => "fixture",
    binding: { invokeRecovery },
  };
  await expect(dispatchD1ProjectRecovery(input as never)).resolves.toMatchObject({
    status: "idle",
  });
  await expect(dispatchD1ProjectRecovery(input as never)).resolves.toMatchObject({
    status: "idle",
  });
  expect(invokeRecovery).toHaveBeenCalledTimes(2);
  expect(invokeRecovery).toHaveBeenCalledWith({ action: "purge", ...purge });
});
