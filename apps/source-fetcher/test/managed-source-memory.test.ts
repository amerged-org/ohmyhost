import { expect, it, vi } from "vitest";
import {
  observeManagedSourceOperation,
  withManagedSourceMemoryBudget,
} from "../src/managed-git-rpc.js";

it("queues a second preview archive until the first provider operation really settles", async () => {
  let finish: () => void = () => {};
  const underlying = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await withManagedSourceMemoryBudget(async () => {
    observeManagedSourceOperation(underlying);
  });
  let secondStarted = false;
  const second = withManagedSourceMemoryBudget(async () => {
    secondStarted = true;
    return "next";
  });
  await Promise.resolve();
  expect(secondStarted).toBe(false);
  finish();
  await expect(second).resolves.toBe("next");
  expect(secondStarted).toBe(true);
  vi.useFakeTimers();
  try {
    let completeProvider: () => void = () => {};
    const provider = new Promise<void>((resolve) => {
      completeProvider = resolve;
    });
    const first = withManagedSourceMemoryBudget(() => provider);
    await Promise.resolve();
    const abandoned = withManagedSourceMemoryBudget(async () => "must not start");
    const refused = expect(abandoned).rejects.toMatchObject({ code: "managed_source_unavailable" });
    await vi.advanceTimersByTimeAsync(20_000);
    await refused;
    completeProvider();
    await first;
    await expect(withManagedSourceMemoryBudget(async () => "recovered")).resolves.toBe("recovered");
  } finally {
    vi.useRealTimers();
  }
});
