import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { buildRig, fundBuild, cid } from "../support/build-fixtures.js";
import { accountOf } from "../support/credit-fixtures.js";
import { transferBuildProject } from "../support/build-history.fixture.js";

/** The accepted Build facts settle against the organization and epoch that were current when the build was accepted. */
it.each([false, true])(
  "claims, authorizes and settles a measured build on the Core with exact money (historical owner moved: %s)",
  async (transferred) => {
    const control = await createTestControl();
    try {
      const r = await buildRig(control),
        p = r.project,
        build = r.store.build,
        claim = {
          ...r.claim,
          inputFingerprint: r.claim.inputFingerprint as `sha256:${string}`,
        },
        envelope = {
          ...r.envelope,
          inputFingerprint: r.envelope.inputFingerprint as `sha256:${string}`,
        },
        authorize = (scope = r.scope) =>
          build.authorizeBuildStart({ scope, claimId: r.claim.claimId });
      expect(await build.claimBuildInput(claim)).toMatchObject({
        status: "claimed",
        mode: "start",
        attemptNumber: 1,
      });
      // No credit is reserved yet: the launch is not authorized.
      expect(await authorize()).toBe(false);
      await fundBuild(r);
      expect(await authorize()).toBe(true);
      // The receipt is immutable and its replay is exact; a later claim sees the completed envelope.
      await build.putBuildReceipt(envelope);
      await build.putBuildReceipt(envelope);
      expect(await build.claimBuildInput({ ...claim, claimId: cid() })).toEqual({
        status: "completed",
        envelope,
      });
      let successor: Awaited<ReturnType<typeof transferBuildProject>> | undefined;
      const receipts = async () =>
        (await control.core.prepare("SELECT * FROM build_receipts").all()).results;
      if (transferred) {
        const beforeTransfer = await receipts();
        successor = await transferBuildProject(control, r);
        expect(await receipts()).toEqual(beforeTransfer);
        // The moved project grants no new launch authority to the former accepted facts.
        expect(await authorize()).toBe(false);
        await expect(build.claimBuildInput({ ...claim, claimId: cid() })).rejects.toThrow();
        await expect(build.putBuildReceipt(envelope)).rejects.toThrow();
      }
      const measured = {
        receipt: r.receipt,
        usage: {
          runner: "cloudflare-build-sandbox" as const,
          instanceType: "standard-3",
          status: "SUCCEEDED",
          startedAt: "2026-10-28T12:00:00.000Z",
          provisioningStartedAt: "2026-10-28T12:00:00.800Z",
          completedAt: "2026-10-28T12:01:57.286Z",
        },
      };
      // An unpriced instance never invents a charge or a usage row.
      await expect(
        build.putBuildUsage({
          ...measured,
          usage: { ...measured.usage, instanceType: "unpriced" },
        }),
      ).rejects.toThrow("no published price");
      expect(await control.core.prepare("SELECT count(*) AS n FROM build_usage").first()).toEqual({
        n: 0,
      });
      await build.putBuildUsage(measured);
      await build.putBuildUsage(measured);
      // 117 sandbox seconds at the published standard-3 rate are charged from the reserved 16.869120 credits.
      const logged = await control.core
        .prepare("SELECT kind,delta_micros,detail FROM credit_log WHERE key=?")
        .bind(`settle:${r.scope.operationId}`)
        .first<{ kind: string; delta_micros: number; detail: string }>();
      expect(logged).toMatchObject({ kind: "settle", delta_micros: -2_349_628 });
      expect(JSON.parse(logged?.detail ?? "{}")).toMatchObject({
        projectId: p.projectId,
        operationId: r.scope.operationId,
        seconds: "117",
        chargedMicros: 2_349_628,
        releasedMicros: 16_869_120 - 2_349_628,
      });
      // Money conservation: nothing stays reserved and exactly the charge is spent from the Free month.
      expect(await accountOf(control.core, p.organizationId)).toMatchObject({
        reserved_micros: 0,
        monthly_micros: 200_000_000 - 2_349_628,
        onetime_micros: 0,
      });
      expect(
        await control.core
          .prepare("SELECT used_micros FROM project_credit WHERE project_id=?")
          .bind(p.projectId)
          .first(),
      ).toEqual({ used_micros: 2_349_628 });
      expect(
        (
          await control.core
            .prepare("SELECT DISTINCT organization_id,billing_epoch_id FROM build_usage")
            .all()
        ).results,
      ).toEqual([{ organization_id: p.organizationId, billing_epoch_id: p.billingEpochId }]);
      if (successor !== undefined)
        expect(
          await control.core
            .prepare("SELECT count(*) AS n FROM credit_log WHERE organization_id=?")
            .bind(successor.nextOrg)
            .first(),
        ).toEqual({ n: 0 });
      // The usage is immutable: a different measurement of the same build is a conflict.
      await expect(
        build.putBuildUsage({
          ...measured,
          usage: { ...measured.usage, completedAt: "2026-10-28T12:02:00.000Z" },
        }),
      ).rejects.toMatchObject({ code: "build_input_conflict" });
      // A scope that names another entity as project is never authorized.
      expect(await authorize({ ...r.scope, projectId: p.organizationId })).toBe(false);
    } finally {
      await control.dispose();
    }
  },
  240_000,
);

/**
 * A build that reports a final status but no provisioning instant ran nothing measurable: its reservation is released
 * without a charge instead of failing the usage write, and the replay is exact.
 */
it.each(["SUCCEEDED", "FAILED"] as const)(
  "releases the reservation of a %s build without a provisioning instant, charges nothing and replays",
  async (status) => {
    const control = await createTestControl();
    try {
      const r = await buildRig(control),
        build = r.store.build,
        claim = {
          ...r.claim,
          inputFingerprint: r.claim.inputFingerprint as `sha256:${string}`,
        },
        envelope = {
          ...r.envelope,
          inputFingerprint: r.envelope.inputFingerprint as `sha256:${string}`,
        },
        unstarted = {
          receipt: r.receipt,
          usage: {
            runner: "cloudflare-build-sandbox" as const,
            instanceType: "standard-3",
            status,
            startedAt: "2026-10-28T12:00:00.000Z",
            provisioningStartedAt: null,
            completedAt: "2026-10-28T12:05:00.000Z",
          },
        };
      expect(await build.claimBuildInput(claim)).toMatchObject({
        status: "claimed",
        mode: "start",
      });
      await fundBuild(r);
      expect(await build.authorizeBuildStart({ scope: r.scope, claimId: r.claim.claimId })).toBe(
        true,
      );
      await build.putBuildReceipt(envelope);
      const funded = await accountOf(control.core, r.project.organizationId);
      expect(funded.reserved_micros).toBe(16_869_120);
      await build.putBuildUsage(unstarted);
      await build.putBuildUsage(unstarted);
      expect(await accountOf(control.core, r.project.organizationId)).toMatchObject({
        reserved_micros: 0,
        monthly_micros: funded.monthly_micros,
        onetime_micros: funded.onetime_micros,
      });
      expect(
        await control.core
          .prepare("SELECT kind, delta_micros FROM credit_log WHERE key=?")
          .bind(`release:${r.scope.operationId}`)
          .first(),
      ).toEqual({ kind: "release", delta_micros: 0 });
      expect(
        await control.core
          .prepare("SELECT count(*) AS n FROM build_usage WHERE status=?")
          .bind(status)
          .first(),
      ).toEqual({ n: 1 });
    } finally {
      await control.dispose();
    }
  },
);

/** A build whose sandbox never started releases its reservation without a charge and its replay is exact. */
it("releases the reservation of a build that never started, charges nothing and replays", async () => {
  const control = await createTestControl();
  try {
    const r = await buildRig(control),
      build = r.store.build,
      claim = {
        ...r.claim,
        inputFingerprint: r.claim.inputFingerprint as `sha256:${string}`,
      },
      envelope = {
        ...r.envelope,
        inputFingerprint: r.envelope.inputFingerprint as `sha256:${string}`,
      },
      neverStarted = {
        receipt: r.receipt,
        usage: {
          runner: "cloudflare-build-sandbox" as const,
          instanceType: "standard-3",
          status: "TIMED_OUT",
          startedAt: "2026-10-28T12:00:00.000Z",
          provisioningStartedAt: null,
          completedAt: "2026-10-28T12:05:00.000Z",
        },
      };
    expect(await build.claimBuildInput(claim)).toMatchObject({ status: "claimed", mode: "start" });
    await fundBuild(r);
    expect(await build.authorizeBuildStart({ scope: r.scope, claimId: r.claim.claimId })).toBe(
      true,
    );
    await build.putBuildReceipt(envelope);
    const funded = await accountOf(control.core, r.project.organizationId);
    expect(funded.reserved_micros).toBe(16_869_120);
    await build.putBuildUsage(neverStarted);
    await build.putBuildUsage(neverStarted);
    // The reservation returns in full: the balance is unchanged and nothing is spent.
    expect(await accountOf(control.core, r.project.organizationId)).toMatchObject({
      reserved_micros: 0,
      monthly_micros: funded.monthly_micros,
      onetime_micros: funded.onetime_micros,
    });
    expect(
      await control.core
        .prepare("SELECT count(*) AS n FROM credit_reservation WHERE reservation_id=?")
        .bind(r.scope.operationId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare("SELECT kind, delta_micros FROM credit_log WHERE key=?")
        .bind(`release:${r.scope.operationId}`)
        .first(),
    ).toEqual({ kind: "release", delta_micros: 0 });
    expect(
      await control.core
        .prepare("SELECT count(*) AS n FROM credit_log WHERE key=?")
        .bind(`settle:${r.scope.operationId}`)
        .first(),
    ).toEqual({ n: 0 });
    // One immutable usage row records the build without a provisioning instant.
    expect(
      await control.core
        .prepare("SELECT count(*) AS n, count(provisioning_started_at) AS started FROM build_usage")
        .first(),
    ).toEqual({ n: 1, started: 0 });
  } finally {
    await control.dispose();
  }
});
