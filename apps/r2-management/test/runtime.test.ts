import { describe, expect, it, vi } from "vitest";

import {
  CloudflareR2BucketQuotaExceededError,
  CloudflareR2BucketUncertainError,
} from "@ohmyhost/provider-cloudflare";
import type { R2BucketObservation } from "@ohmyhost/provider-cloudflare";
import type { R2BucketDeleteResult } from "@ohmyhost/provider-cloudflare";
import {
  ProjectR2BucketConflictError,
  type ProjectR2BucketClaimResult,
  type ProjectR2BucketReceipt,
} from "@ohmyhost/database";

import { createR2Management } from "../src/runtime.js";

const scope = {
  jurisdiction: "eu",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
} as const;
const bucketName = `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`;
const providerReceipt = {
  bucketName,
  bucketId: "0113a9e4549cf9b1ff1bf56e04da0cef",
  jurisdiction: "eu" as const,
  storageClass: "Standard" as const,
  publicAccess: false as const,
  observedAt: new Date("2026-08-24T20:00:00.000Z"),
};

function setup(jurisdiction: "eu" | "us" = "eu") {
  const scopedReceipt = { ...providerReceipt, jurisdiction };
  const persistence = {
    claim: vi.fn<() => Promise<ProjectR2BucketClaimResult>>(async () => ({
      status: "claimed",
      mode: "create",
    })),
    authorize: vi.fn(async () => true),
    put: vi.fn(async () => "created" as const),
    read: vi.fn<() => Promise<ProjectR2BucketReceipt | null>>(async () => null),
    proveBucketAbsence: vi.fn(async () => "proven" as const),
    supersedeBucketReservation: vi.fn(async () => "superseded" as const),
  };
  const provider = {
    observeBucket: vi.fn<() => Promise<R2BucketObservation>>(async () => ({
      state: "found",
      ...scopedReceipt,
    })),
    ensureBucket: vi.fn(async () => ({ outcome: "created" as const, receipt: scopedReceipt })),
    purgeAndDeleteBucket: vi.fn<() => Promise<R2BucketDeleteResult>>(async () => ({
      outcome: "deleted" as const,
      bucketName,
      objectCount: 2,
      bytes: 12,
    })),
  };
  return { management: createR2Management({ persistence, provider }), persistence, provider };
}

describe("R2 management", () => {
  it.each(["eu", "us"] as const)(
    "authorizes one %s create and persists its exact private bucket receipt",
    async (jurisdiction) => {
      const requestedScope = { ...scope, jurisdiction };
      const scopedReceipt = { ...providerReceipt, jurisdiction };
      const { management, persistence, provider } = setup(jurisdiction);

      await expect(management.ensureBucket(requestedScope)).resolves.toEqual({
        status: "ready",
        outcome: "created",
        receipt: { ...requestedScope, ...scopedReceipt },
      });
      expect(persistence.claim).toHaveBeenCalledWith(
        expect.objectContaining({ bucketName, jurisdiction, publicAccess: false }),
      );
      expect(persistence.authorize).toHaveBeenCalledOnce();
      expect(provider.ensureBucket).toHaveBeenCalledOnce();
      expect(persistence.put).toHaveBeenCalledWith({ ...requestedScope, ...scopedReceipt });
    },
  );

  it("reconciles an observe claim without replaying create", async () => {
    const { management, persistence, provider } = setup();
    persistence.claim.mockResolvedValueOnce({ status: "claimed", mode: "observe" });

    await expect(management.ensureBucket(scope)).resolves.toMatchObject({
      status: "ready",
      outcome: "reconciled",
      receipt: { bucketName },
    });
    expect(persistence.authorize).not.toHaveBeenCalled();
    expect(provider.ensureBucket).not.toHaveBeenCalled();
    expect(provider.observeBucket).toHaveBeenCalledOnce();
  });

  it("proves the absence of a spent reservation and supersedes it before reporting, so a new operation may reserve again", async () => {
    const { management, persistence, provider } = setup();
    persistence.claim.mockResolvedValueOnce({ status: "claimed", mode: "observe" });
    provider.observeBucket.mockResolvedValueOnce({
      state: "absent",
      bucketName,
      jurisdiction: "eu",
    });

    await expect(management.ensureBucket(scope)).resolves.toEqual({
      status: "reconciliation_required",
      reason: "provider_absent",
    });
    expect(persistence.proveBucketAbsence).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: scope.claimId,
        bucketName,
        observedAt: expect.any(Date) as Date,
      }),
    );
    expect(persistence.supersedeBucketReservation).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: scope.claimId, bucketName }),
    );
    expect(persistence.proveBucketAbsence.mock.invocationCallOrder[0]).toBeLessThan(
      persistence.supersedeBucketReservation.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(persistence.authorize).not.toHaveBeenCalled();
    expect(provider.ensureBucket).not.toHaveBeenCalled();
  });

  it("observes the bucket before its single create authorization, so an unknown read spends nothing", async () => {
    const { management, persistence, provider } = setup();
    provider.observeBucket.mockRejectedValueOnce(new CloudflareR2BucketUncertainError());

    await expect(management.ensureBucket(scope)).resolves.toEqual({
      status: "reconciliation_required",
      reason: "provider_unknown",
    });
    expect(persistence.authorize).not.toHaveBeenCalled();
    expect(provider.ensureBucket).not.toHaveBeenCalled();
  });

  it("hands the observation made before authorization to the create, so the create reads nothing after it", async () => {
    const { management, persistence, provider } = setup();
    const observation = { state: "absent" as const, bucketName, jurisdiction: "eu" as const };
    provider.observeBucket.mockResolvedValueOnce(observation);

    await management.ensureBucket(scope);
    expect(provider.observeBucket.mock.invocationCallOrder[0]).toBeLessThan(
      persistence.authorize.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(provider.ensureBucket).toHaveBeenCalledWith(
      expect.objectContaining({ bucketName }),
      observation,
    );
  });

  it("returns explicit reconciliation for absent, unknown, or changed claims", async () => {
    const absent = setup();
    absent.persistence.claim.mockResolvedValueOnce({ status: "claimed", mode: "observe" });
    absent.provider.observeBucket.mockResolvedValueOnce({
      state: "absent",
      bucketName,
      jurisdiction: "eu",
    });
    await expect(absent.management.ensureBucket(scope)).resolves.toEqual({
      status: "reconciliation_required",
      reason: "provider_absent",
    });

    const unknown = setup();
    unknown.persistence.claim.mockResolvedValueOnce({ status: "claimed", mode: "observe" });
    unknown.provider.observeBucket.mockRejectedValueOnce(new CloudflareR2BucketUncertainError());
    await expect(unknown.management.ensureBucket(scope)).resolves.toEqual({
      status: "reconciliation_required",
      reason: "provider_unknown",
    });

    const changed = setup();
    changed.persistence.authorize.mockResolvedValueOnce(false);
    await expect(changed.management.ensureBucket(scope)).resolves.toEqual({
      status: "reconciliation_required",
      reason: "claim_changed",
    });
    expect(changed.provider.ensureBucket).not.toHaveBeenCalled();
  });

  it("reports a durable target conflict as terminal instead of reconciliation", async () => {
    const { management, persistence, provider } = setup("us");
    persistence.claim.mockRejectedValueOnce(new ProjectR2BucketConflictError());

    await expect(management.ensureBucket({ ...scope, jurisdiction: "us" })).resolves.toEqual({
      status: "conflict",
      reason: "target_changed",
    });
    expect(provider.ensureBucket).not.toHaveBeenCalled();
    expect(persistence.put).not.toHaveBeenCalled();
  });

  it("replays completed persistence and exposes only the runtime bucket name", async () => {
    const { management, persistence, provider } = setup();
    const receipt = { ...scope, ...providerReceipt };
    persistence.claim.mockResolvedValueOnce({ status: "completed", receipt });
    persistence.read.mockResolvedValueOnce(receipt).mockResolvedValueOnce(null);

    await expect(management.ensureBucket(scope)).resolves.toEqual({
      status: "ready",
      outcome: "replayed",
      receipt,
    });
    await expect(
      management.readRuntimeBinding({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      }),
    ).resolves.toEqual({ status: "ready", bucketName, jurisdiction: "eu" });
    await expect(
      management.readRuntimeBinding({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(provider.ensureBucket).not.toHaveBeenCalled();
  });

  it("rejects widened requests and incomplete dependencies", async () => {
    expect(() => createR2Management({} as never)).toThrow("dependencies are invalid");
    const { management } = setup();
    await expect(management.ensureBucket({ ...scope, extra: true })).rejects.toThrow(
      "request is invalid",
    );
  });

  it.each([
    { name: "dev", environmentId: scope.environmentId },
    { name: "prod", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" },
  ])(
    "deletes the exact empty $name bucket receipt and returns only redacted absence evidence",
    async ({ environmentId }) => {
      const { management, persistence, provider } = setup();
      const scopedBucketName = `ohmyho-${scope.projectId.toLowerCase()}-${environmentId.toLowerCase()}`;
      const receipt = {
        ...scope,
        environmentId,
        ...providerReceipt,
        bucketName: scopedBucketName,
      };
      persistence.read.mockResolvedValueOnce(receipt);
      provider.purgeAndDeleteBucket.mockResolvedValueOnce({
        outcome: "deleted",
        bucketName: scopedBucketName,
        objectCount: 2,
        bytes: 12,
      });

      await expect(management.purgeAndDeleteBucket(receipt)).resolves.toEqual({
        status: "absent",
        outcome: "deleted",
        receipt,
        purge: { objectCount: 2, bytes: 12 },
      });
      expect(provider.purgeAndDeleteBucket).toHaveBeenCalledWith({
        ...providerReceipt,
        bucketName: scopedBucketName,
      });
    },
  );

  it("denies a mismatched project or bucket receipt before provider mutation", async () => {
    const { management, persistence, provider } = setup();
    const receipt = { ...scope, ...providerReceipt };
    persistence.read.mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    const otherProjectId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const crossProjectReceipt = {
      ...receipt,
      projectId: otherProjectId,
      bucketName: `ohmyho-${otherProjectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
    };

    await expect(management.purgeAndDeleteBucket(crossProjectReceipt)).rejects.toMatchObject({
      code: "r2_management_receipt_mismatch",
    });
    await expect(
      management.purgeAndDeleteBucket({
        ...receipt,
        bucketId: "1113a9e4549cf9b1ff1bf56e04da0cef",
      }),
    ).rejects.toMatchObject({ code: "r2_management_receipt_mismatch" });
    expect(provider.purgeAndDeleteBucket).not.toHaveBeenCalled();
  });

  it("reports uncertain deletion and idempotently replays confirmed provider absence", async () => {
    const uncertain = setup();
    const receipt = { ...scope, ...providerReceipt };
    uncertain.persistence.read.mockResolvedValueOnce(receipt);
    uncertain.provider.purgeAndDeleteBucket.mockRejectedValueOnce(
      new CloudflareR2BucketUncertainError(),
    );
    await expect(uncertain.management.purgeAndDeleteBucket(receipt)).resolves.toEqual({
      status: "reconciliation_required",
      reason: "provider_unknown",
    });

    const replay = setup();
    replay.persistence.read.mockResolvedValueOnce(receipt);
    replay.provider.purgeAndDeleteBucket.mockResolvedValueOnce({
      outcome: "absent",
      bucketName,
      objectCount: 0,
      bytes: 0,
    });
    await expect(replay.management.purgeAndDeleteBucket(receipt)).resolves.toEqual({
      status: "absent",
      outcome: "replayed",
      receipt,
      purge: { objectCount: 0, bytes: 0 },
    });
  });

  it("surfaces over-quota buckets without rewriting the provider failure", async () => {
    const { management, persistence, provider } = setup();
    const receipt = { ...scope, ...providerReceipt };
    persistence.read.mockResolvedValueOnce(receipt);
    provider.purgeAndDeleteBucket.mockRejectedValueOnce(new CloudflareR2BucketQuotaExceededError());

    await expect(management.purgeAndDeleteBucket(receipt)).rejects.toMatchObject({
      code: "cloudflare_r2_bucket_quota_exceeded",
    });
  });
});
