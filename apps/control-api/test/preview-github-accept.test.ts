import { describe, expect, it, vi } from "vitest";
import {
  createGithubPreviewAcceptor,
  createGithubInitialPreviewSource,
  createD1GithubAutoDeployDatabase,
} from "../src/d1-github-auto-deploy.js";

describe("GitHub preview source acceptance", () => {
  it("seeds the first open and recovers an existing head after a missed push notification", async () => {
    const id = "01J00000000000000000000001";
    const scope = {
      organizationId: id,
      projectId: id,
      environment: "prod" as const,
      principalId: "user:owner",
    };
    const candidate = {
      organizationId: id,
      projectId: id,
      sourceConnectionId: id,
      sourceGeneration: 1,
      expectedSequence: 0,
      branchRef: null,
      configGeneration: null,
      installationId: "7",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    };
    const acceptInitialGithubSource = vi.fn(async () => ({ sequence: 1, accepted: true }));
    const resolvePreviewGithubHead = vi.fn(async () => ({
      defaultBranch: "refs/heads/main",
      head: "a".repeat(40),
    }));
    const notify = vi.fn(async () => {});
    for (const targetSource of [null, { commitSha: "b".repeat(40), sequence: 1 }])
      await createGithubInitialPreviewSource({
        core: {
          get: async () => ({ preview: { targetSource } }),
          readInitialGithubCandidate: async () => candidate,
          acceptInitialGithubSource,
        } as never,
        source: { resolvePreviewGithubHead },
        notify,
      })(scope);
    expect(resolvePreviewGithubHead).toHaveBeenCalledWith(expect.objectContaining({ ref: null }));
    expect(acceptInitialGithubSource).toHaveBeenCalledWith(
      expect.objectContaining({
        branchRef: "refs/heads/main",
        observedDefaultBranch: "refs/heads/main",
        observedHead: "a".repeat(40),
      }),
    );
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("reobserves the provider head after a concurrent acceptance and never applies a stale push", async () => {
    const id = "01J00000000000000000000001";
    const claim = {
      inboxEventId: id,
      claimId: id,
      deliveryGuid: "event",
      installationId: "7",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
      ref: "refs/heads/main",
      commitSha: "a".repeat(40),
      deleted: false,
      claimedAt: "2026-11-16T00:00:00.000Z",
      attemptNumber: 1,
      maxAttempts: 3,
    };
    const candidate = {
      organizationId: id,
      projectId: id,
      sourceConnectionId: id,
      sourceGeneration: 1,
      expectedSequence: 0,
      branchRef: null,
      configGeneration: null,
      installationId: "7",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    };
    const readGithubCandidates = vi.fn(async () => [candidate]);
    const acceptGithubSource = vi.fn(async () => {
      throw new Error("preview_github_head_changed");
    });
    const resolvePreviewGithubHead = vi
      .fn()
      .mockResolvedValueOnce({ defaultBranch: claim.ref, head: claim.commitSha })
      .mockResolvedValueOnce({ defaultBranch: claim.ref, head: "b".repeat(40) });
    const accept = createGithubPreviewAcceptor({
      core: { readGithubCandidates, acceptGithubSource },
      source: { resolvePreviewGithubHead },
      notify: async () => {},
    });
    await accept(claim);
    expect(acceptGithubSource).toHaveBeenCalledTimes(1);
    expect(resolvePreviewGithubHead).toHaveBeenCalledTimes(2);
  });
  it("keeps formal deployment target discovery available when preview acceptance fails or is absent", async () => {
    const id = "01J00000000000000000000001";
    const target = {
      organizationId: id,
      projectId: id,
      sourceConnectionId: id,
      configGeneration: 1,
      branchRef: "refs/heads/main",
      installationId: "7",
      repositoryId: "42",
      grantActive: true,
      repositoryRenamed: false,
    };
    const readGithubAutoDeployTargets = vi.fn(async () => [target]);
    for (const acceptPreview of [
      undefined,
      async () => {
        throw new Error("source unavailable");
      },
    ]) {
      const database = createD1GithubAutoDeployDatabase({
        github: { readGithubAutoDeployTargets } as never,
        inbox: { renewInboxLease: async () => true } as never,
        drain: {
          claimInboxEvent: async () => ({
            organizationId: null,
            inboxEventId: id,
            externalEventId: "event",
            claimId: id,
            attemptNumber: 1,
            maxAttempts: 3,
            payload: {
              installationId: "7",
              repositoryId: "42",
              repositoryFullName: "owner/repo",
              ref: "refs/heads/main",
              commitSha: "a".repeat(40),
              deleted: false,
            },
          }),
        },
        clock: { now: () => new Date("2026-11-16T00:00:00.000Z") },
        ids: { next: () => id } as never,
        billingEpochOf: async () => id,
        ...(acceptPreview === undefined ? {} : { acceptPreview }),
      });
      const claim = await database.claimOne();
      if (!claim) throw new Error("push missing");
      await expect(database.targetsFor(claim)).resolves.toEqual([target]);
    }
    expect(readGithubAutoDeployTargets).toHaveBeenCalledTimes(2);
  });

  it("renews a slow preview head read and refuses formal effects when that exact push lease is lost", async () => {
    vi.useFakeTimers();
    try {
      for (const renewal of ["renewed", "stale", "unavailable"] as const) {
        const id = "01J00000000000000000000001";
        let finishPreview!: () => void;
        const pendingPreview = new Promise<void>((resolve) => {
          finishPreview = resolve;
        });
        const renewInboxLease = vi.fn().mockResolvedValueOnce(true);
        if (renewal === "unavailable")
          renewInboxLease.mockRejectedValueOnce(new Error("Core unavailable"));
        else renewInboxLease.mockResolvedValueOnce(renewal === "renewed");
        renewInboxLease.mockResolvedValue(true);
        const readGithubAutoDeployTargets = vi.fn(async () => []);
        const database = createD1GithubAutoDeployDatabase({
          github: { readGithubAutoDeployTargets } as never,
          inbox: { renewInboxLease } as never,
          drain: {
            claimInboxEvent: async () => ({
              organizationId: null,
              inboxEventId: id,
              externalEventId: "slow-preview",
              claimId: id,
              attemptNumber: 1,
              maxAttempts: 3,
              payload: {
                installationId: "7",
                repositoryId: "42",
                repositoryFullName: "owner/repo",
                ref: "refs/heads/main",
                commitSha: "a".repeat(40),
                deleted: false,
              },
            }),
          } as never,
          clock: { now: () => new Date("2026-11-16T00:00:00.000Z") },
          ids: { next: () => id } as never,
          billingEpochOf: async () => id,
          acceptPreview: async () => pendingPreview,
        });
        const claim = await database.claimOne();
        if (!claim) throw new Error("push missing");
        const discovering = database.targetsFor(claim);
        const result =
          renewal === "renewed"
            ? expect(discovering).resolves.toEqual([])
            : expect(discovering).rejects.toThrow(
                renewal === "stale"
                  ? "GitHub push claim became stale"
                  : "GitHub push claim renewal failed",
              );
        await vi.advanceTimersByTimeAsync(20_000);
        expect(renewInboxLease).toHaveBeenCalledTimes(2);
        finishPreview();
        await result;
        expect(readGithubAutoDeployTargets).toHaveBeenCalledTimes(renewal === "renewed" ? 1 : 0);
        const settledCalls = renewInboxLease.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(renewInboxLease).toHaveBeenCalledTimes(settledCalls);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
