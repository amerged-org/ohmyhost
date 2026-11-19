import { describe, expect, it, vi } from "vitest";
import {
  createD1ManagedSourceStore,
  D1_MANAGED_SOURCE_METHODS,
  type D1ManagedSourceRuntime,
} from "../src/d1-managed-source-store.js";

describe("accepted managed source notification", () => {
  it("returns the committed source even when the direct notification fails", async () => {
    const id = "01J00000000000000000000001";
    const now = "2026-11-16T00:00:00.000Z";
    const committed = {
      provider: "managed",
      sourceConnectionId: id,
      generation: 1,
      commitSha: "a".repeat(40),
      namespace: "repo",
      repositoryName: "app",
      status: "ready",
      linkedAt: now,
      updatedAt: now,
    };
    const runtime = Object.fromEntries(
      D1_MANAGED_SOURCE_METHODS.map((method) => [method, vi.fn(async () => null)]),
    ) as unknown as D1ManagedSourceRuntime;
    runtime.completeApiManagedSourcePublication = vi.fn(async () => committed);
    const notifyPreviewSource = vi.fn(async () => {
      throw new Error("runtime temporarily unavailable");
    });
    const store = createD1ManagedSourceStore({
      runtime,
      clock: { now: () => new Date(now) },
      notifyPreviewSource,
    });
    const result = await store.complete({
      organizationId: id,
      projectId: id,
      operationId: id,
      principalId: "user:owner",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      eventId: id,
      now,
    } as never);
    expect(result).toEqual(committed);
    expect(notifyPreviewSource).toHaveBeenCalledWith({ organizationId: id, projectId: id });
  });
});
