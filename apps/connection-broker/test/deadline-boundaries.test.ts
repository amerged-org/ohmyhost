import { expect, test, vi } from "vitest";
import { observeMutation } from "../src/management.js";

test("a timed-out credential observation cannot later authorize a mutation", async () => {
  vi.useFakeTimers();
  try {
    let release: () => void = () => {};
    const write = vi.fn();
    const observer = {
      async observeConnectionOrigin() {},
      observeIntegrationMutation: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const operation = observeMutation(observer, {
      resourceKind: "organization",
      organizationId: "organization",
      principalId: "user:user_owner",
      mutationAuthority: {
        kind: "session",
        userId: "user_owner",
        sessionId: "session",
        workosOrganizationId: null,
        tokenExpiresAt: 1,
      },
    }).then(write);
    const rejected = expect(operation).rejects.toThrow("connection_authority_unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    release();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
