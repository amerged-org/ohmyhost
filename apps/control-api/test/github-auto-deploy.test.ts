import { describe, expect, it, vi } from "vitest";
import { GithubAutoDeployTargetDeniedError } from "@ohmyhost/database";
import { SourceAdmissionPolicyInconsistentError } from "../src/contracts.js";
import { drainGithubPushes } from "../src/github-auto-deploy.js";
import {
  createGithubAutoDeployConsumer,
  type GithubAutoDeployDatabase,
  type GithubPushClaim,
  type GithubTarget,
} from "../src/github-auto-deploy.js";
const claim: GithubPushClaim = {
  inboxEventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  deliveryGuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  installationId: "12345",
  repositoryId: "123",
  repositoryFullName: "aixyte/app",
  ref: "refs/heads/main",
  commitSha: "a".repeat(40),
  deleted: false,
  claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  claimedAt: "2026-08-25T12:00:00.000Z",
  attemptNumber: 1,
  maxAttempts: 3,
};
const target: GithubTarget = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  configGeneration: 2,
  branchRef: "refs/heads/main",
  installationId: "12345",
  repositoryId: "123",
  grantActive: true,
  repositoryRenamed: false,
};
function db(overrides: Partial<GithubAutoDeployDatabase> = {}): GithubAutoDeployDatabase {
  return {
    claimOne: vi.fn().mockResolvedValue(claim),
    targetsFor: vi.fn().mockResolvedValue([target]),
    reserve: vi.fn().mockResolvedValue({
      ...target,
      pushDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      outcome: "reserved",
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      workflowAttached: false,
    }),
    renew: vi.fn().mockResolvedValue(true),
    deny: vi.fn().mockResolvedValue("created"),
    failPlanning: vi.fn().mockResolvedValue("failed"),
    acknowledge: vi.fn().mockResolvedValue(true),
    fail: vi
      .fn()
      .mockImplementation(async (value) =>
        value.attemptNumber < value.maxAttempts ? "retry" : "reconciliation_required",
      ),
    ...overrides,
  };
}
const deployment = (operationId = "01ARZ3NDEKTSV4RRFFQ69G5FB1") => ({
  requestDev: vi.fn().mockResolvedValue({ status: "attached", operationId }),
});
describe("GitHub push consumer", () => {
  it("queues the configured exact commit", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({ database: db(), deployments }).pollOne(),
    ).resolves.toEqual({
      status: "queued",
      operationIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB1"],
      deniedProjectIds: [],
    });
    expect(deployments.requestDev).toHaveBeenCalledWith(
      expect.objectContaining({ sourceConnectionId: target.sourceConnectionId }),
    );
  });
  it.each([
    [{ ...target, branchRef: "refs/heads/release" }, "branch"],
    [undefined, "unconfigured"],
  ] as const)("ignores unmatched branch configuration", async (value, reason) => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({ targetsFor: vi.fn().mockResolvedValue(value ? [value] : []) }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({ status: "ignored", reason });
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it("answers a push to a renamed repository with a visible planning refusal and plans nothing", async () => {
    const database = db({
      targetsFor: vi.fn().mockResolvedValue([{ ...target, repositoryRenamed: true }]),
    });
    const deployments = deployment();
    expect(await createGithubAutoDeployConsumer({ database, deployments }).pollOne()).toEqual({
      status: "failed",
      operationIds: [],
      deniedProjectIds: [],
      failedProjectIds: [target.projectId],
    });
    expect(deployments.requestDev).not.toHaveBeenCalled();
    expect(database.failPlanning).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: target.projectId,
        planningFailureCode: "REPOSITORY_RENAMED",
        diagnostic: null,
      }),
    );
    expect(database.acknowledge).toHaveBeenCalled();
  });
  it("acknowledges branch deletion without code", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          claimOne: vi.fn().mockResolvedValue({ ...claim, deleted: true, commitSha: null }),
        }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({ status: "ignored", reason: "deleted" });
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it("rejects a foreign installation before fetch", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          claimOne: vi.fn().mockResolvedValue({ ...claim, installationId: "99999" }),
        }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({ status: "ignored", reason: "branch" });
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it("durably denies a revoked target", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          targetsFor: vi.fn().mockResolvedValue([{ ...target, grantActive: false }]),
        }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({
      status: "denied",
      operationIds: [],
      deniedProjectIds: [target.projectId],
    });
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it("does not let one revoked tenant DoS a valid project", async () => {
    const valid = { ...target, projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB2" };
    const deployments = deployment("01ARZ3NDEKTSV4RRFFQ69G5FB3");
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          targetsFor: vi.fn().mockResolvedValue([{ ...target, grantActive: false }, valid]),
        }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({
      status: "queued",
      operationIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB3"],
      deniedProjectIds: [target.projectId],
    });
    expect(deployments.requestDev).toHaveBeenCalledOnce();
  });
  it("turns revoke or disable after target read into per-target denial", async () => {
    const database = db({
      reserve: vi
        .fn()
        .mockRejectedValue(new GithubAutoDeployTargetDeniedError("GITHUB_AUTO_DEPLOY_DISABLED")),
    });
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({ database, deployments }).pollOne(),
    ).resolves.toEqual({
      status: "denied",
      operationIds: [],
      deniedProjectIds: [target.projectId],
    });
    expect(database.deny).toHaveBeenCalledWith(
      expect.objectContaining({ denialCode: "GITHUB_AUTO_DEPLOY_DISABLED" }),
    );
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it("renews the bounded lease before and between multiple target operations", async () => {
    const second = { ...target, projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB4" };
    const renew = vi.fn().mockResolvedValue(true);
    const deployments = {
      requestDev: vi
        .fn()
        .mockResolvedValueOnce({ status: "attached", operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB5" })
        .mockResolvedValueOnce({ status: "attached", operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB6" }),
    };
    await expect(
      createGithubAutoDeployConsumer({
        database: db({ targetsFor: vi.fn().mockResolvedValue([target, second]), renew }),
        deployments,
      }).pollOne(),
    ).resolves.toMatchObject({
      status: "queued",
      operationIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB5", "01ARZ3NDEKTSV4RRFFQ69G5FB6"],
    });
    expect(renew).toHaveBeenCalledTimes(7);
  });
  it("replays a bound duplicate without another deploy", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          reserve: vi.fn().mockResolvedValue({
            ...target,
            pushDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
            outcome: "replay",
            operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
            workflowAttached: true,
          }),
        }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({
      status: "replayed",
      operationIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB1"],
      deniedProjectIds: [],
    });
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it("recovers an operation reserved before its workflow attachment", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          reserve: vi.fn().mockResolvedValue({
            ...target,
            pushDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
            outcome: "replay",
            operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
            workflowAttached: false,
          }),
        }),
        deployments,
      }).pollOne(),
    ).resolves.toMatchObject({ status: "queued", operationIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB1"] });
    expect(deployments.requestDev).toHaveBeenCalledOnce();
  });
  it("stops before external work on stale renewal", async () => {
    const deployments = deployment();
    await expect(
      createGithubAutoDeployConsumer({
        database: db({ renew: vi.fn().mockResolvedValue(false) }),
        deployments,
      }).pollOne(),
    ).resolves.toEqual({ status: "stale" });
    expect(deployments.requestDev).not.toHaveBeenCalled();
  });
  it.each(["stale", "unavailable"])(
    "rejects an in-flight request when heartbeat is %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        let renewals = 0;
        const renew = async () => {
          if (++renewals > 3) {
            if (outcome === "unavailable") throw new Error("claim database unavailable");
            return false;
          }
          return true;
        };
        const database = db({ renew });
        const pending = createGithubAutoDeployConsumer({
          database,
          deployments: { requestDev: vi.fn(() => new Promise<never>(() => undefined)) },
        }).pollOne();
        await vi.advanceTimersByTimeAsync(20_000);
        await expect(pending).resolves.toEqual({
          status: "retry",
          code: "GITHUB_AUTO_DEPLOY_REQUEST_FAILED",
        });
        expect(database.fail).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("reconciles final-attempt uncertainty", async () => {
    await expect(
      createGithubAutoDeployConsumer({
        database: db({
          claimOne: vi.fn().mockResolvedValue({ ...claim, attemptNumber: 3 }),
          reserve: vi.fn().mockRejectedValue(new Error("uncertain")),
        }),
        deployments: deployment(),
      }).pollOne(),
    ).resolves.toEqual({
      status: "reconciliation_required",
      code: "GITHUB_AUTO_DEPLOY_REQUEST_FAILED",
    });
  });
  it("turns planning failure into the same visible terminal operation", async () => {
    const diagnostic = {
      code: "repository_configuration_invalid",
      path: "ohmyhost.yaml",
    } as const;
    for (const rejection of [
      { code: "FRAMEWORK_CONVERSION_REQUIRED", diagnostic },
      { code: "PAID_PLAN_REQUIRED", diagnostic: null },
    ] as const) {
      const database = db();
      await expect(
        createGithubAutoDeployConsumer({
          database,
          deployments: {
            requestDev: vi.fn().mockResolvedValue({
              status: "rejected",
              operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
              ...rejection,
            }),
          },
        }).pollOne(),
      ).resolves.toEqual({
        status: "failed",
        operationIds: [],
        deniedProjectIds: [],
        failedProjectIds: [target.projectId],
      });
      // The typed refusal travels with the code, so the operation error can name the fix.
      expect(database.failPlanning).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          pushDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          planningFailureCode: rejection.code,
          diagnostic: rejection.diagnostic,
        }),
      );
      expect(database.acknowledge).toHaveBeenCalled();
    }
  });
  it("retries transient planning uncertainty without terminalizing the operation", async () => {
    for (const [error, code] of [
      [new Error("database unavailable"), "GITHUB_AUTO_DEPLOY_REQUEST_FAILED"],
      // Platform policies that disagree are an outage of ohmyho.st, never the customer's push.
      [new SourceAdmissionPolicyInconsistentError(), "GITHUB_AUTO_DEPLOY_POLICY_INCONSISTENT"],
    ] as const) {
      const database = db();
      await expect(
        createGithubAutoDeployConsumer({
          database,
          deployments: { requestDev: vi.fn().mockRejectedValue(error) },
        }).pollOne(),
      ).resolves.toEqual({ status: "retry", code });
      expect(database.fail).toHaveBeenCalledWith(expect.objectContaining({ code }));
      expect(database.failPlanning).not.toHaveBeenCalled();
      expect(database.acknowledge).not.toHaveBeenCalled();
    }
  });
});

describe("the scheduled push drain under failure", () => {
  it("reports a total outage as failed after three failed claims instead of making twenty calls", async () => {
    const pollOne = vi.fn(async () => {
      throw new Error("github inbox unavailable");
    });
    await expect(drainGithubPushes({ pollOne }, { now: () => 0 })).resolves.toEqual({
      status: "failed",
      processed: 0,
      failed: 3,
    });
    expect(pollOne).toHaveBeenCalledTimes(3);
  });

  it("reports a tick that processed nothing and only failed as failed, even when the inbox then goes idle", async () => {
    const pollOne = vi
      .fn<() => Promise<{ status: string }>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce({ status: "idle" });
    await expect(drainGithubPushes({ pollOne }, { now: () => 0 })).resolves.toEqual({
      status: "failed",
      processed: 0,
      failed: 2,
    });
  });

  it("keeps draining past isolated failures once a push has been processed", async () => {
    const pollOne = vi
      .fn<() => Promise<{ status: string }>>()
      .mockResolvedValueOnce({ status: "ignored" })
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValueOnce({ status: "queued" })
      .mockResolvedValueOnce({ status: "idle" });
    await expect(drainGithubPushes({ pollOne }, { now: () => 0 })).resolves.toEqual({
      status: "idle",
      processed: 2,
      failed: 1,
    });
  });
});
