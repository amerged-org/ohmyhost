import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptApiProductOperation } from "../../src/catalog/product-api/accept-product.js";
import { newUlid } from "../../src/catalog/common.js";
import { inventoryDigest } from "../../src/catalog/provisioning/lifecycle-inventory.js";
import { runReserve, setPaid, setProjectBudget } from "../../src/catalog/credit/index.js";
import { createTestControl, coreRouter, type TestControl } from "../support/control-d1.js";
import { BUILD_QUOTE_MICROS, exhaust, grantOneTime, makePaid } from "../support/credit-fixtures.js";
import { beforeFirstWrite, losingWriteResponses } from "../support/platform-fixtures.js";
import { sourceFrameworkPlan } from "../support/provider-fixtures.js";
import {
  acceptance,
  configureMail,
  createPlan,
  issueConfirmation,
  linkSource,
  planDataChange,
  planRequest,
  productRig,
  publishedRevision,
  type ProductRig,
} from "../support/product-api-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

const one = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

describe("productApi.acceptApiProductOperation", () => {
  it("accepts a source link and a handle change with their intents, replays the receipt and refuses a reused key", async () => {
    const rig = await productRig(control);
    const link = acceptance(rig, rig.devEnvironmentId, {
      eventType: "SourceLinkRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/source",
      installationId: "7",
      repositoryOwner: "o",
      repositoryName: "r",
    });
    const accepted = await rig.store.productApi.acceptApiProductOperation(link);
    expect(accepted).toMatchObject({ operationId: link.operationId, state: "queued" });
    expect(
      await one(
        "SELECT installation_id,repository_owner,repository_name FROM product_command_intents WHERE operation_id=?",
        link.operationId,
      ),
    ).toEqual({ installation_id: "7", repository_owner: "o", repository_name: "r" });
    expect(
      await one("SELECT event_type FROM outbox_events WHERE event_id=?", link.outboxEventId),
    ).toEqual({ event_type: "SourceLinkRequestedV1" });

    // The same key and digest with fresh ids is the first operation again and writes nothing.
    const again = { ...link, operationId: newUlid(), outboxEventId: newUlid() };
    expect(await rig.store.productApi.acceptApiProductOperation(again)).toEqual(accepted);
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", again.operationId),
    ).toEqual({ n: 0 });
    // A different request under the same key is a conflict.
    await expect(
      rig.store.productApi.acceptApiProductOperation({
        ...again,
        canonicalRequestDigest: new Uint8Array(32).fill(250),
      }),
    ).rejects.toThrow("idempotency_key_reused");

    const rename = acceptance(rig, rig.devEnvironmentId, {
      eventType: "ProjectHandleChangeRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/handle",
      httpMethod: "PUT",
      expectedEtag: '"etag"',
      requestedHandle: "renamed-shop",
    });
    expect(await rig.store.productApi.acceptApiProductOperation(rename)).toMatchObject({
      operationId: rename.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT requested_handle,expected_etag FROM product_command_intents WHERE operation_id=?",
        rename.operationId,
      ),
    ).toEqual({ requested_handle: "renamed-shop", expected_etag: '"etag"' });
    // A handle another project owns is refused without a trace.
    const other = await productRig(control);
    const taken = acceptance(other, other.devEnvironmentId, {
      eventType: "ProjectHandleChangeRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/handle",
      httpMethod: "PUT",
      expectedEtag: '"etag"',
      requestedHandle: rig.handle,
    });
    await expect(rig.store.productApi.acceptApiProductOperation(taken)).rejects.toThrow(
      "deployment_persistence_conflict",
    );
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", taken.operationId),
    ).toEqual({ n: 0 });
  }, 30_000);

  it("answers a lost response from the committed operation", async () => {
    const rig = await productRig(control);
    const request = acceptance(rig, rig.devEnvironmentId, {
      eventType: "SourceLinkRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/source",
      installationId: "7",
      repositoryOwner: "o",
      repositoryName: "r",
    });
    const lossy = losingWriteResponses(control.core, 1);
    const accepted = await acceptApiProductOperation(
      { directory: control.core, router: coreRouter(control, { CONTROL_SHARD_0000: lossy }) },
      request,
    );
    expect(accepted).toMatchObject({ operationId: request.operationId, state: "queued" });
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", request.operationId),
    ).toEqual({ n: 1 });
    expect(
      await one("SELECT count(*) n FROM outbox_events WHERE event_id=?", request.outboxEventId),
    ).toEqual({ n: 1 });
  }, 30_000);

  it("accepts a deployment against its plan with the build hold and refuses an unknown plan digest", async () => {
    const rig = await productRig(control),
      { sourceConnectionId } = await linkSource(rig),
      plan = await createPlan(rig, sourceConnectionId);
    const request = acceptance(rig, rig.devEnvironmentId, {
      eventType: "DeploymentRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments",
      planId: plan.planId,
      planDigest: plan.planDigest,
      deploymentId: newUlid(),
    });
    const accepted = await rig.store.productApi.acceptApiProductOperation(request);
    expect(accepted).toMatchObject({ operationId: request.operationId, state: "queued" });
    expect(
      await one("SELECT kind,status FROM deployments WHERE deployment_id=?", request.deploymentId),
    ).toEqual({ kind: "deploy", status: "queued" });
    expect(
      await one(
        "SELECT plan_id,source_connection_id,source_generation FROM product_command_intents WHERE operation_id=?",
        request.operationId,
      ),
    ).toEqual({
      plan_id: plan.planId,
      source_connection_id: sourceConnectionId,
      source_generation: 1,
    });
    // The build quote is reserved under the operation id, in the same batch, from the Free month of the organization.
    expect(
      await one(
        "SELECT organization_id,project_id,amount_micros FROM credit_reservation WHERE reservation_id=?",
        request.operationId,
      ),
    ).toEqual({
      organization_id: rig.organizationId,
      project_id: rig.projectId,
      amount_micros: BUILD_QUOTE_MICROS,
    });
    expect(
      await one(
        "SELECT monthly_micros,reserved_micros FROM credit_account WHERE organization_id=?",
        rig.organizationId,
      ),
    ).toEqual({ monthly_micros: 200_000_000, reserved_micros: BUILD_QUOTE_MICROS });
    expect(
      await one(
        "SELECT kind,delta_micros,json_extract(detail,'$.operationId') op FROM credit_log WHERE key=?",
        `reserve:${request.operationId}`,
      ),
    ).toEqual({ kind: "reserve", delta_micros: 0, op: request.operationId });

    // An unknown plan digest changes nothing.
    const wrong = acceptance(rig, rig.devEnvironmentId, {
      ...request,
      operationId: newUlid(),
      idempotencyKey: "wrong-digest",
      planDigest: new Uint8Array(32).fill(9),
      deploymentId: newUlid(),
    });
    await expect(rig.store.productApi.acceptApiProductOperation(wrong)).rejects.toThrow(
      "deployment_persistence_conflict",
    );
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", wrong.operationId),
    ).toEqual({ n: 0 });
  }, 30_000);

  describe("the build reservation of a deployment", () => {
    const deployment = (rig: ProductRig, plan: { planId: string; planDigest: Uint8Array }) =>
      acceptance(rig, rig.devEnvironmentId, {
        eventType: "DeploymentRequestedV1",
        routeTemplate: "/v1/projects/{project_id}/deployments",
        planId: plan.planId,
        planDigest: plan.planDigest,
        deploymentId: newUlid(),
      });
    const nothingBehind = async (operationId: string) => {
      expect(
        await one("SELECT count(*) n FROM operations WHERE operation_id=?", operationId),
      ).toEqual({ n: 0 });
      expect(
        await one("SELECT count(*) n FROM credit_reservation WHERE reservation_id=?", operationId),
      ).toEqual({ n: 0 });
    };

    it("refuses a build the available credit cannot cover, without any grace, and accepts exactly the quote", async () => {
      const rig = await productRig(control),
        { sourceConnectionId } = await linkSource(rig),
        api = rig.store.productApi;
      // The credit ran out an hour ago: serving continues in the grace, a build does not start.
      await exhaust(control.core, rig.organizationId, "2026-10-28T10:30:00.000000Z");
      const refused = deployment(rig, await createPlan(rig, sourceConnectionId));
      await expect(api.acceptApiProductOperation(refused)).rejects.toThrow(
        "insufficient_organization_credits",
      );
      await nothingBehind(refused.operationId);

      // One micro-credit short is still refused; exactly the quote is accepted and leaves nothing available.
      await grantOneTime(control.core, rig.organizationId, BUILD_QUOTE_MICROS - 1, "topup:short");
      await expect(api.acceptApiProductOperation(refused)).rejects.toThrow(
        "insufficient_organization_credits",
      );
      await grantOneTime(control.core, rig.organizationId, 1, "topup:exact");
      const accepted = await api.acceptApiProductOperation(refused);
      expect(accepted).toMatchObject({ operationId: refused.operationId, state: "queued" });
      expect(
        await one(
          "SELECT onetime_micros,reserved_micros,exhausted_at FROM credit_account WHERE organization_id=?",
          rig.organizationId,
        ),
      ).toEqual({
        onetime_micros: BUILD_QUOTE_MICROS,
        reserved_micros: BUILD_QUOTE_MICROS,
        exhausted_at: null,
      });
      // The replay of the accepted key reserves nothing a second time.
      expect(
        await api.acceptApiProductOperation({
          ...refused,
          operationId: newUlid(),
          outboxEventId: newUlid(),
        }),
      ).toEqual(accepted);
      expect(
        await one(
          "SELECT count(*) n FROM credit_log WHERE organization_id=? AND kind='reserve'",
          rig.organizationId,
        ),
      ).toEqual({ n: 1 });
      // The next deployment finds nothing available.
      const next = deployment(rig, await createPlan(rig, sourceConnectionId));
      await expect(api.acceptApiProductOperation(next)).rejects.toThrow(
        "insufficient_organization_credits",
      );
      await nothingBehind(next.operationId);
    }, 30_000);

    it("re-decides when the credit is taken between the read and the write of the acceptance", async () => {
      const rig = await productRig(control),
        { sourceConnectionId } = await linkSource(rig),
        request = deployment(rig, await createPlan(rig, sourceConnectionId)),
        racing = beforeFirstWrite(control.core, async () => {
          await runReserve(control.core, {
            organizationId: rig.organizationId,
            reservationId: newUlid(),
            projectId: rig.projectId,
            amountMicros: 195_000_000,
            now: "2026-10-28T11:29:00.000Z",
          });
        });
      await expect(
        acceptApiProductOperation(
          { directory: control.core, router: coreRouter(control, { CONTROL_SHARD_0000: racing }) },
          request,
        ),
      ).rejects.toThrow("insufficient_organization_credits");
      await nothingBehind(request.operationId);
      expect(
        await one(
          "SELECT reserved_micros FROM credit_account WHERE organization_id=?",
          rig.organizationId,
        ),
      ).toEqual({ reserved_micros: 195_000_000 });
    }, 30_000);

    describe("the Stop budget in the batch that reserves the build", () => {
      // `between` runs after the acceptance read its snapshot and before its write batch, so only the guard in that
      // batch can see what it changes.
      const race = async (
        initial: number,
        between: (stage: {
          rig: ProductRig;
          request: ReturnType<typeof deployment>;
          budget: (micros: number | null, mode?: "continue" | "stop") => Promise<unknown>;
        }) => Promise<void>,
      ) => {
        const rig = await productRig(control),
          { sourceConnectionId } = await linkSource(rig),
          request = deployment(rig, await createPlan(rig, sourceConnectionId));
        const budget = (micros: number | null, mode: "continue" | "stop" = "stop") =>
          control.core.batch(
            setProjectBudget(control.core, {
              organizationId: rig.organizationId,
              projectId: rig.projectId,
              budgetMicros: micros,
              mode,
              now: "2026-10-28T11:00:00.000Z",
            }).statements,
          );
        await budget(initial);
        let ran = 0;
        const racing = beforeFirstWrite(control.core, async () => {
          ran += 1;
          await between({ rig, request, budget });
        });
        const outcome = acceptApiProductOperation(
          { directory: control.core, router: coreRouter(control, { CONTROL_SHARD_0000: racing }) },
          request,
        );
        return { rig, request, outcome, ran: () => ran };
      };
      const reservedOf = async (rig: ProductRig) =>
        one(
          "SELECT count(*) n,COALESCE(sum(amount_micros),0) micros FROM credit_reservation WHERE organization_id=? AND project_id=?",
          rig.organizationId,
          rig.projectId,
        );

      it("refuses a build with the budget denial when an Owner lowers the limit below the quote, and leaves nothing behind", async () => {
        const { rig, request, outcome, ran } = await race(
          BUILD_QUOTE_MICROS * 2,
          async ({ budget }) => void (await budget(BUILD_QUOTE_MICROS - 1)),
        );
        await expect(outcome).rejects.toThrow("project_budget_exceeded");
        expect(ran()).toBe(1);
        await nothingBehind(request.operationId);
        expect(
          await one(
            "SELECT count(*) n FROM deployments WHERE deployment_id=?",
            request.deploymentId,
          ),
        ).toEqual({ n: 0 });
        expect(
          await one(
            "SELECT reserved_micros FROM credit_account WHERE organization_id=?",
            rig.organizationId,
          ),
        ).toEqual({ reserved_micros: 0 });
        expect(
          await one(
            "SELECT budget_micros FROM project_credit WHERE organization_id=? AND project_id=?",
            rig.organizationId,
            rig.projectId,
          ),
        ).toEqual({ budget_micros: BUILD_QUOTE_MICROS - 1 });
      }, 60_000);

      it("accepts a build that fits the lowered limit exactly and answers its replay and its twin from the stored operation", async () => {
        const exact = await race(
          BUILD_QUOTE_MICROS * 2,
          async ({ budget }) => void (await budget(BUILD_QUOTE_MICROS)),
        );
        const accepted = await exact.outcome;
        expect(accepted).toMatchObject({ operationId: exact.request.operationId, state: "queued" });
        expect(exact.ran()).toBe(1);
        expect(await reservedOf(exact.rig)).toEqual({ n: 1, micros: BUILD_QUOTE_MICROS });
        // The open reservation now fills the limit; the same key under a new operation id is answered, not denied.
        expect(
          await exact.rig.store.productApi.acceptApiProductOperation({
            ...exact.request,
            operationId: newUlid(),
            outboxEventId: newUlid(),
          }),
        ).toEqual(accepted);
        expect(await reservedOf(exact.rig)).toEqual({ n: 1, micros: BUILD_QUOTE_MICROS });

        // A twin of the same request commits first and holds the whole limit: the guard of the loser must not deny it.
        const twin = await race(BUILD_QUOTE_MICROS, async ({ rig, request }) => {
          await rig.store.productApi.acceptApiProductOperation(request);
        });
        expect(await twin.outcome).toMatchObject({
          operationId: twin.request.operationId,
          state: "queued",
        });
        expect(twin.ran()).toBe(1);
        expect(await reservedOf(twin.rig)).toEqual({ n: 1, micros: BUILD_QUOTE_MICROS });
      }, 60_000);

      it("counts the open reservations of the project, and never blocks a Continue or unset budget", async () => {
        // Another build of the same project reserves after the read: this one no longer fits and is refused.
        const crowded = await race(BUILD_QUOTE_MICROS * 1.5, async ({ rig }) => {
          await runReserve(control.core, {
            organizationId: rig.organizationId,
            reservationId: newUlid(),
            projectId: rig.projectId,
            amountMicros: BUILD_QUOTE_MICROS,
            now: "2026-10-28T11:29:00.000Z",
          });
        });
        await expect(crowded.outcome).rejects.toThrow("project_budget_exceeded");
        await nothingBehind(crowded.request.operationId);
        expect(await reservedOf(crowded.rig)).toEqual({ n: 1, micros: BUILD_QUOTE_MICROS });

        // The Owner ends the limit after the read: a Continue budget below the quote and a removed budget both pass.
        for (const [micros, mode] of [
          [1, "continue"],
          [null, "continue"],
        ] as const) {
          const open = await race(
            BUILD_QUOTE_MICROS * 2,
            async ({ budget }) => void (await budget(micros, mode)),
          );
          expect(await open.outcome).toMatchObject({
            operationId: open.request.operationId,
            state: "queued",
          });
          expect(await reservedOf(open.rig)).toEqual({ n: 1, micros: BUILD_QUOTE_MICROS });
        }
      }, 60_000);
    });

    it("holds a stop budget to the quote on top of the use of the month and the open reservations", async () => {
      const rig = await productRig(control),
        { sourceConnectionId } = await linkSource(rig),
        api = rig.store.productApi;
      const budget = async (budgetMicros: number) =>
        control.core.batch(
          setProjectBudget(control.core, {
            organizationId: rig.organizationId,
            projectId: rig.projectId,
            budgetMicros,
            mode: "stop",
            now: "2026-10-28T11:00:00.000Z",
          }).statements,
        );
      await budget(BUILD_QUOTE_MICROS - 1);
      const refused = deployment(rig, await createPlan(rig, sourceConnectionId));
      await expect(api.acceptApiProductOperation(refused)).rejects.toThrow(
        "project_budget_exceeded",
      );
      await nothingBehind(refused.operationId);
      await budget(BUILD_QUOTE_MICROS);
      expect(await api.acceptApiProductOperation(refused)).toMatchObject({ state: "queued" });
      // The open reservation counts against the budget until the build is settled.
      const next = deployment(rig, await createPlan(rig, sourceConnectionId));
      await expect(api.acceptApiProductOperation(next)).rejects.toThrow("project_budget_exceeded");
      await nothingBehind(next.operationId);
    }, 30_000);

    it("needs Paid coverage for a plan that enables the mail framework", async () => {
      const rig = await productRig(control),
        { sourceConnectionId } = await linkSource(rig),
        api = rig.store.productApi;
      await configureMail(rig);
      await makePaid(control.core, rig.organizationId);
      const mail = planRequest(rig, sourceConnectionId, {
        frameworkPlan: { ...sourceFrameworkPlan(false), mail: { enabled: true } },
      });
      expect(await api.createApiDeploymentPlan(mail)).toBe("created");
      const endPaid = () =>
        control.core.batch(
          setPaid(control.core, {
            organizationId: rig.organizationId,
            paidUntil: null,
            source: null,
            now: "2026-10-28T11:00:00.000Z",
          }).statements,
        );
      await endPaid();
      const refused = deployment(rig, mail);
      await expect(api.acceptApiProductOperation(refused)).rejects.toThrow("paid_plan_required");
      await nothingBehind(refused.operationId);

      // Paid, but the credit ran out more than a week ago: refused for the credit.
      await makePaid(control.core, rig.organizationId);
      await exhaust(control.core, rig.organizationId, "2026-10-01T00:00:00.000000Z");
      await expect(api.acceptApiProductOperation(refused)).rejects.toThrow(
        "insufficient_organization_credits",
      );
      await grantOneTime(control.core, rig.organizationId, 50_000_000, "topup:mail");
      expect(await api.acceptApiProductOperation(refused)).toMatchObject({ state: "queued" });
    }, 30_000);
  });

  it("accepts a rollback and a promotion over their consumed confirmations and refuses a stale target", async () => {
    const rig = await productRig(control);
    await linkSource(rig);
    const published = await publishedRevision(rig, rig.devEnvironmentId),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };

    const target = await api.readApiRollbackTarget({
      ...scope,
      deploymentId: published.deploymentId,
    });
    expect(target).toMatchObject({
      deploymentId: published.deploymentId,
      environmentId: rig.devEnvironmentId,
      revisionId: published.revisionId,
      artifactId: published.artifactId,
      expectedHeadVersion: 1,
      assignmentVersion: 1,
      registrationVersion: 0,
      dataChanged: false,
      dataChangeInProgress: false,
    });
    const rollbackRequest = async (overrides: Record<string, unknown> = {}) =>
      acceptance(rig, rig.devEnvironmentId, {
        eventType: "DeploymentRollbackRequestedV1",
        routeTemplate: "/v1/projects/{project_id}/deployments/{deployment_id}/rollback",
        deploymentId: newUlid(),
        targetDeploymentId: published.deploymentId,
        targetRevisionId: published.revisionId,
        targetArtifactId: published.artifactId,
        expectedHeadVersion: 1,
        expectedDataEnvironmentId: target?.dataEnvironmentId,
        expectedAssignmentVersion: 1,
        expectedRegistrationVersion: 0,
        expectedEtag: '"rollback"',
        confirmation: await issueConfirmation(
          rig,
          "rollback",
          '"rollback"',
          published.deploymentId,
        ),
        ...overrides,
      });
    const rollback = await rollbackRequest();
    expect(await api.acceptApiProductOperation(rollback)).toMatchObject({
      operationId: rollback.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT kind,rollback_target_deployment_id,rollback_target_revision_id FROM deployments WHERE deployment_id=?",
        rollback.deploymentId,
      ),
    ).toEqual({
      kind: "rollback",
      rollback_target_deployment_id: published.deploymentId,
      rollback_target_revision_id: published.revisionId,
    });
    expect(
      await one(
        "SELECT target_artifact_id,expected_etag FROM product_command_intents WHERE operation_id=?",
        rollback.operationId,
      ),
    ).toEqual({ target_artifact_id: published.artifactId, expected_etag: '"rollback"' });
    expect(
      await one(
        "SELECT consumed_at IS NOT NULL consumed FROM action_confirmations WHERE action='rollback' AND project_id=?",
        rig.projectId,
      ),
    ).toEqual({ consumed: 1 });
    // The consumed confirmation cannot be used again, and a target whose data moved is refused.
    await expect(
      api.acceptApiProductOperation({
        ...rollback,
        operationId: newUlid(),
        idempotencyKey: "reuse",
        deploymentId: newUlid(),
      }),
    ).rejects.toThrow("deployment_persistence_conflict");
    await expect(
      api.acceptApiProductOperation(await rollbackRequest({ expectedAssignmentVersion: 2 })),
    ).rejects.toThrow("rollback_target_data_changed");

    const environments = await api.readApiPromotionEnvironments(scope),
      promotion = await api.readApiPromotionTarget({
        ...scope,
        sourceEnvironmentId: rig.devEnvironmentId,
        targetEnvironmentId: rig.prodEnvironmentId,
      });
    expect(environments).toEqual({
      sourceEnvironmentId: rig.devEnvironmentId,
      targetEnvironmentId: rig.prodEnvironmentId,
    });
    expect(promotion).toMatchObject({
      dataMode: "shared",
      databaseEnabled: false,
      sourceDeploymentId: published.deploymentId,
      sourceRevisionId: published.revisionId,
      sourceArtifactId: published.artifactId,
      expectedSourceHeadVersion: 1,
      expectedTargetHeadVersion: 0,
    });
    const promote = acceptance(rig, rig.prodEnvironmentId, {
      eventType: "DeploymentPromotionRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments/promote",
      deploymentId: newUlid(),
      sourceEnvironmentId: rig.devEnvironmentId,
      sourceDeploymentId: published.deploymentId,
      sourceRevisionId: published.revisionId,
      sourceArtifactId: published.artifactId,
      sourceArtifactDigest: promotion?.sourceArtifactDigest,
      expectedSourceHeadVersion: 1,
      expectedHeadVersion: 0,
      expectedEtag: '"promote"',
      confirmation: await issueConfirmation(rig, "promote", '"promote"', published.deploymentId),
    });
    expect(await api.acceptApiProductOperation(promote)).toMatchObject({
      operationId: promote.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT kind,promotion_source_environment_id,promotion_source_revision_id FROM deployments WHERE deployment_id=?",
        promote.deploymentId,
      ),
    ).toEqual({
      kind: "promotion",
      promotion_source_environment_id: rig.devEnvironmentId,
      promotion_source_revision_id: published.revisionId,
    });
    expect(
      await one(
        "SELECT expected_source_head_version,expected_target_head_version FROM product_command_intents WHERE operation_id=?",
        promote.operationId,
      ),
    ).toEqual({ expected_source_head_version: 1, expected_target_head_version: 0 });
    // A promotion from a source head that moved is refused before anything is written.
    const stale = acceptance(rig, rig.prodEnvironmentId, {
      ...promote,
      operationId: newUlid(),
      idempotencyKey: "stale-head",
      deploymentId: newUlid(),
      expectedSourceHeadVersion: 2,
      confirmation: await issueConfirmation(rig, "promote", '"promote"', published.deploymentId),
    });
    await expect(api.acceptApiProductOperation(stale)).rejects.toThrow(
      "deployment_persistence_conflict",
    );
    expect(
      await one("SELECT count(*) n FROM operations WHERE operation_id=?", stale.operationId),
    ).toEqual({ n: 0 });
  }, 30_000);

  it("accepts a Dev data reset that clears the Dev deployment and inventories its script, and refuses a stale snapshot", async () => {
    const rig = await productRig(control, { shared: false });
    await linkSource(rig);
    await publishedRevision(rig, rig.devEnvironmentId);
    const api = rig.store.productApi,
      { state, confirmationId, request } = await planDataChange(rig, "reset_dev");
    expect(state).toMatchObject({
      lifecycleVersion: 1,
      billingEpochId: rig.billingEpochId,
      assignments: { dataMode: "isolated" },
      prodDatabaseReady: false,
      renewal: { kind: "absent", liveShareLinks: 0 },
    });
    expect(state.environmentHeads).toContainEqual({
      environmentId: rig.devEnvironmentId,
      expectedHeadVersion: 1,
    });
    expect(
      await one("SELECT action FROM action_confirmations WHERE confirmation_id=?", confirmationId),
    ).toEqual({ action: "data_change" });

    const stale = request({
      expectedEnvironmentHeads: state.environmentHeads.map((head) => ({
        ...head,
        expectedHeadVersion: 9,
      })),
    });
    await expect(api.acceptApiProductOperation(stale)).rejects.toThrow(
      "deployment_persistence_conflict",
    );
    const accepted = request();
    expect(await api.acceptApiProductOperation(accepted)).toMatchObject({
      operationId: accepted.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT data_change,cleanup_run_id FROM product_command_intents WHERE operation_id=?",
        accepted.operationId,
      ),
    ).toEqual({ data_change: "reset_dev", cleanup_run_id: accepted.cleanupRunId });
    expect(
      await one("SELECT state FROM cleanup_runs WHERE cleanup_run_id=?", accepted.cleanupRunId),
    ).toEqual({ state: "pending" });
    expect(
      await one(
        "SELECT active_deployment_id,head_version FROM environments WHERE environment_id=?",
        rig.devEnvironmentId,
      ),
    ).toEqual({ active_deployment_id: null, head_version: 2 });
    expect(
      await one(
        "SELECT provider,resource_kind FROM run_resource_inventory WHERE operation_id=?",
        accepted.operationId,
      ),
    ).toEqual({ provider: "cloudflare", resource_kind: "wfp-script" });
    // The queued data change blocks the next planning read.
    await expect(
      api.readApiProjectDataChangeState({
        organizationId: rig.organizationId,
        projectId: rig.projectId,
        principalId: rig.principalId,
      }),
    ).rejects.toThrow("data_change_blocked");
  }, 30_000);

  it("refuses a project deletion while another operation of the project is queued, and stores nothing", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    // A queued operation without a run or a provider claim: a deletion admitted now would tear down resources and never finish.
    await control.core
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,'2026-10-28T10:20:00.000000Z','2026-10-28T10:20:00.000000Z')",
      )
      .bind(rig.organizationId, newUlid(), rig.projectId, rig.billingEpochId)
      .run();
    const target = await api.readApiDeletePlanTarget(scope);
    const refused = acceptance(rig, rig.devEnvironmentId, {
      eventType: "ProjectDeletionRequestedV1",
      httpMethod: "DELETE",
      routeTemplate: "/v1/projects/{project_id}",
      cleanupRunId: newUlid(),
      expectedProjectVersion: 1,
      expectedEtag: target?.expectedEtag,
      confirmation: await issueConfirmation(rig, "delete", String(target?.expectedEtag)),
    });
    await expect(api.acceptApiProductOperation(refused)).rejects.toThrow(
      "project_operation_in_progress",
    );
    expect(
      await one("SELECT state FROM operations WHERE operation_id=?", refused.operationId),
    ).toBeNull();
    expect(
      await one("SELECT lifecycle_state FROM projects WHERE project_id=?", rig.projectId),
    ).toEqual({ lifecycle_state: "active" });
  });

  it("accepts a project deletion, refuses a second one while it runs, and lets the continuation after a failure inherit the recorded absence", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId },
      source = "source-bucket/archive/version-1";
    await control.core
      .prepare(
        "INSERT INTO product_source_archive_objects(operation_id,organization_id,project_id,environment_id,bucket_name,object_key,object_version_id,object_etag,byte_length,source_sha256,recorded_at) VALUES(?1,?2,?3,?4,'source-bucket','archive','version-1','etag',10,?5,'2026-10-28T10:10:00.000000Z')",
      )
      .bind(
        rig.input.operation.operationId,
        rig.organizationId,
        rig.projectId,
        rig.devEnvironmentId,
        new Uint8Array(32).fill(4),
      )
      .run();
    const deletion = async (admission: {
      expectedProjectVersion: number;
      environmentId: string;
    }) => {
      const target = await api.readApiDeletePlanTarget(scope);
      expect(target).toMatchObject({
        expectedProjectVersion: admission.expectedProjectVersion,
        expectedEtag: `project:${rig.projectId}:v${admission.expectedProjectVersion}`,
        managedRepositoryCount: 0,
        stagedSourceObjectCount: 0,
      });
      return acceptance(rig, admission.environmentId, {
        eventType: "ProjectDeletionRequestedV1",
        httpMethod: "DELETE",
        routeTemplate: "/v1/projects/{project_id}",
        cleanupRunId: newUlid(),
        expectedProjectVersion: admission.expectedProjectVersion,
        expectedEtag: target?.expectedEtag,
        confirmation: await issueConfirmation(rig, "delete", String(target?.expectedEtag)),
      });
    };

    const first = await deletion({
      expectedProjectVersion: 1,
      environmentId: rig.devEnvironmentId,
    });
    const pendingIdentity = "aa".repeat(32);
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',NULL,2,2)",
        )
        .bind(rig.organizationId, rig.projectId, rig.devEnvironmentId),
      control.core
        .prepare(
          "INSERT INTO native_auth_domain_operations(organization_id,project_id,kind,identity,original_input,state) VALUES(?1,?2,'paid_delete',?3,'{}','pending')",
        )
        .bind(rig.organizationId, rig.projectId, pendingIdentity),
      control.core
        .prepare(
          "INSERT INTO native_auth_domain_policy_syncs(organization_id,project_id,kind,identity,environment_id,old_origin,head_deployment_id,head_revision_id,head_version,configuration_revision,revocation_epoch,owner_enabled,registry_version,state) SELECT ?1,?2,'paid_delete',?3,environment_id,'https://old.example',active_deployment_id,active_revision_id,head_version,2,2,1,NULL,'pending' FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?4",
        )
        .bind(rig.organizationId, rig.projectId, pendingIdentity, rig.devEnvironmentId),
    ]);
    await expect(api.readApiDeletePlanTarget(scope)).rejects.toThrow("native_domain_sync_pending");
    await expect(api.readApiDeletionAdmission(scope)).rejects.toThrow("native_domain_sync_pending");
    await expect(api.acceptApiProductOperation(first)).rejects.toThrow(
      "native_domain_sync_pending",
    );
    expect(
      await one(
        "SELECT lifecycle_state,lifecycle_version FROM projects WHERE project_id=?",
        rig.projectId,
      ),
    ).toEqual({ lifecycle_state: "active", lifecycle_version: 1 });
    expect(
      await one(
        "SELECT enabled,configuration_revision,revocation_epoch FROM native_auth_realms WHERE project_id=?",
        rig.projectId,
      ),
    ).toEqual({ enabled: 1, configuration_revision: 2, revocation_epoch: 2 });
    expect(
      await one("SELECT state FROM operations WHERE operation_id=?", first.operationId),
    ).toBeNull();
    expect(
      await one("SELECT state FROM cleanup_runs WHERE cleanup_run_id=?", first.cleanupRunId),
    ).toBeNull();
    expect(
      await one(
        "SELECT event_type FROM product_command_intents WHERE operation_id=?",
        first.operationId,
      ),
    ).toBeNull();
    expect(
      await one(
        "SELECT state FROM native_auth_deletion_operations WHERE operation_id=?",
        first.operationId,
      ),
    ).toBeNull();
    expect(
      await one(
        "SELECT claim_id FROM product_provider_mutation_claims WHERE operation_id=?",
        first.operationId,
      ),
    ).toBeNull();
    expect(
      await control.core
        .prepare(
          "SELECT consumed_at FROM action_confirmations WHERE organization_id=?1 AND project_id=?2 AND token_sha256=?3",
        )
        .bind(rig.organizationId, rig.projectId, first.confirmation.tokenDigest)
        .first(),
    ).toEqual({ consumed_at: null });
    await control.core.batch([
      control.core
        .prepare(
          "UPDATE native_auth_domain_policy_syncs SET state='acknowledged',acknowledgement='{}' WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3",
        )
        .bind(rig.organizationId, rig.projectId, pendingIdentity),
      control.core
        .prepare(
          "UPDATE native_auth_domain_operations SET state='completed' WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3",
        )
        .bind(rig.organizationId, rig.projectId, pendingIdentity),
    ]);
    expect(
      await api.readApiDeletionAdmission({ ...scope, acceptingOperationId: first.operationId }),
    ).toEqual({
      environmentId: rig.devEnvironmentId,
      billingEpochId: rig.billingEpochId,
      expectedProjectVersion: 1,
      lifecycleState: "active",
      previousOperationId: null,
    });
    expect(await api.acceptApiProductOperation(first)).toMatchObject({
      operationId: first.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT lifecycle_state,lifecycle_version FROM projects WHERE project_id=?",
        rig.projectId,
      ),
    ).toEqual({ lifecycle_state: "deleting", lifecycle_version: 2 });
    expect(
      await one("SELECT state FROM cleanup_runs WHERE cleanup_run_id=?", first.cleanupRunId),
    ).toEqual({ state: "pending" });
    expect(
      (
        await control.core
          .prepare(
            "SELECT provider,resource_kind FROM run_resource_inventory WHERE operation_id=? ORDER BY provider,resource_kind",
          )
          .bind(first.operationId)
          .all()
      ).results,
    ).toEqual([
      { provider: "cloudflare", resource_kind: "source-object" },
      { provider: "control", resource_kind: "project" },
    ]);
    // The deletion in progress is not admitted twice.
    expect(await api.readApiDeletionAdmission(scope)).toBeNull();
    const early = acceptance(rig, rig.devEnvironmentId, {
      ...first,
      operationId: newUlid(),
      idempotencyKey: "early",
      cleanupRunId: newUlid(),
      expectedProjectVersion: 2,
      confirmation: await issueConfirmation(rig, "delete", String(first.expectedEtag)),
    });
    await expect(api.acceptApiProductOperation(early)).rejects.toThrow(
      "project_operation_in_progress",
    );

    // After the first deletion failed having removed the source object, the continuation inherits that absence.
    const transition = (type: string, state: string, count: number, failure?: object) =>
      rig.store.operations.transitionOperation({
        organizationId: rig.organizationId,
        operationId: first.operationId,
        expected: { state, eventCount: count },
        event: {
          eventId: newUlid(),
          type,
          idempotencyKey: `${type}-first`,
          occurredAt: "2026-10-28T11:35:00.000Z",
          ...(failure === undefined ? {} : { failure }),
        },
        audit: {
          auditEventId: newUlid(),
          projectId: rig.projectId,
          operationId: first.operationId,
          eventType: type,
          actorType: "system",
          actorId: "workflow",
          payload: {},
          occurredAt: "2026-10-28T11:35:00.000Z",
        },
      });
    await transition("OperationStarted", "queued", 1);
    await transition("OperationFailed", "running", 2, {
      code: "CLEANUP_FAILED",
      message: "cleanup failed",
    });
    const attempt = newUlid();
    await control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,error_code,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','source-object',?5,'removed',NULL,'2026-10-28T11:36:00.000000Z')",
      )
      .bind(
        attempt,
        rig.organizationId,
        rig.projectId,
        first.operationId,
        inventoryDigest("cloudflare", "source-object", source),
      )
      .run();
    const second = await deletion({
      expectedProjectVersion: 2,
      environmentId: rig.devEnvironmentId,
    });
    expect(
      await api.readApiDeletionAdmission({ ...scope, acceptingOperationId: second.operationId }),
    ).toMatchObject({
      lifecycleState: "deleting",
      previousOperationId: first.operationId,
    });
    expect(await api.acceptApiProductOperation(second)).toMatchObject({
      operationId: second.operationId,
      state: "queued",
    });
    expect(
      await one(
        "SELECT provider,resource_kind,outcome FROM run_cleanup_attempts WHERE operation_id=?",
        second.operationId,
      ),
    ).toEqual({ provider: "cloudflare", resource_kind: "source-object", outcome: "removed" });
    const audit = await one(
      "SELECT payload FROM organization_audit_events WHERE event_type='ProjectDeletionContinuationAccepted' AND organization_id=?",
      rig.organizationId,
    );
    expect(JSON.parse(String(audit?.["payload"]))).toMatchObject({
      projectId: rig.projectId,
      operationId: second.operationId,
      previousOperationId: first.operationId,
      inheritedObjectAbsence: [{ sourceAttemptId: attempt }],
    });
    expect(
      await one("SELECT lifecycle_version FROM projects WHERE project_id=?", rig.projectId),
    ).toEqual({ lifecycle_version: 3 });
  }, 30_000);
});

it("refuses a database-enabled deployment that would make an eleventh database of the organization, and does not count a retired database", async () => {
  const rig = await productRig(control),
    { sourceConnectionId } = await linkSource(rig);
  const plan = planRequest(rig, sourceConnectionId, {
    frameworkPlan: sourceFrameworkPlan(true),
  });
  expect(await rig.store.productApi.createApiDeploymentPlan(plan)).toBe("created");
  // Ten live databases of this organization, each in a physical environment of the project that has no deployment.
  const databases: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const physical = newUlid();
    databases.push(physical);
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,'2026-10-01T00:00:00.000000Z')",
        )
        .bind(rig.organizationId, rig.projectId, physical),
      control.core
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev','r256-s500m',?6,?7,'2026-10-01T00:00:00.000000Z')",
        )
        .bind(
          rig.organizationId,
          rig.projectId,
          physical,
          `prj_${"a".repeat(20)}`,
          `${"b".repeat(18)}${String(index).padStart(2, "0")}`,
          `ohmyho_rw_${physical.toLowerCase()}`,
          `registry:${physical}`,
        ),
      control.core
        .prepare(
          "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active','2026-10-01T00:00:00.000000Z','2026-10-01T00:00:00.000000Z')",
        )
        .bind(rig.organizationId, rig.projectId, physical),
    ]);
  }
  const deployment = () =>
    acceptance(rig, rig.devEnvironmentId, {
      eventType: "DeploymentRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments",
      planId: plan.planId,
      planDigest: plan.planDigest,
      deploymentId: newUlid(),
    });
  await expect(rig.store.productApi.acceptApiProductOperation(deployment())).rejects.toThrow(
    "database_limit_reached",
  );
  // A retired database is no longer one of the organization's databases, so the deployment is admitted.
  await control.core
    .prepare(
      "UPDATE database_provider_target_heads SET state='retired',updated_at='2026-10-02T00:00:00.000000Z' WHERE organization_id=?1 AND physical_environment_id=?2",
    )
    .bind(rig.organizationId, databases[0])
    .run();
  await expect(rig.store.productApi.acceptApiProductOperation(deployment())).resolves.toMatchObject(
    { state: "queued" },
  );
}, 120_000);

/** One live PGCF database of the project in a physical environment that no logical environment points at. */
async function addLiveDatabase(rig: ProductRig, active = true): Promise<string> {
  const physical = newUlid();
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,'2026-10-01T00:00:00.000000Z')",
      )
      .bind(rig.organizationId, rig.projectId, physical),
    control.core
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev','r256-s500m',?6,?7,'2026-10-01T00:00:00.000000Z')",
      )
      .bind(
        rig.organizationId,
        rig.projectId,
        physical,
        `prj_${"a".repeat(20)}`,
        `c${newUlid().toLowerCase().slice(-19)}`,
        `ohmyho_rw_${physical.toLowerCase()}`,
        `registry:${physical}`,
      ),
    control.core
      .prepare(
        "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active','2026-10-01T00:00:00.000000Z','2026-10-01T00:00:00.000000Z')",
      )
      .bind(rig.organizationId, rig.projectId, physical),
  ]);
  if (!active)
    await control.core
      .prepare(
        "UPDATE database_provider_target_heads SET state='retired',updated_at='2026-10-02T00:00:00.000000Z' WHERE organization_id=?1 AND physical_environment_id=?2",
      )
      .bind(rig.organizationId, physical)
      .run();
  return physical;
}

it("caps the promotion of a database-enabled revision into an isolated production at ten live databases of the organization", async () => {
  // Ten live databases: the promotion would create the eleventh, so it is refused before anything is written.
  const full = await productRig(control, { shared: false });
  await linkSource(full);
  const fullPublished = await publishedRevision(full, full.devEnvironmentId, {
    frameworkPlan: sourceFrameworkPlan(true),
  });
  const fullLive: string[] = [];
  for (let index = 0; index < 10; index += 1) fullLive.push(await addLiveDatabase(full));
  const promote = async (rig: ProductRig, published: typeof fullPublished) => {
    const promotion = await rig.store.productApi.readApiPromotionTarget({
      organizationId: rig.organizationId,
      projectId: rig.projectId,
      sourceEnvironmentId: rig.devEnvironmentId,
      targetEnvironmentId: rig.prodEnvironmentId,
    });
    return acceptance(rig, rig.prodEnvironmentId, {
      eventType: "DeploymentPromotionRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments/promote",
      deploymentId: newUlid(),
      sourceEnvironmentId: rig.devEnvironmentId,
      sourceDeploymentId: published.deploymentId,
      sourceRevisionId: published.revisionId,
      sourceArtifactId: published.artifactId,
      sourceArtifactDigest: promotion?.sourceArtifactDigest,
      expectedSourceHeadVersion: 1,
      expectedHeadVersion: 0,
      expectedEtag: '"promote"',
      confirmation: await issueConfirmation(rig, "promote", '"promote"', published.deploymentId),
    });
  };
  const refused = await promote(full, fullPublished);
  await expect(full.store.productApi.acceptApiProductOperation(refused)).rejects.toThrow(
    "database_limit_reached",
  );
  expect(
    await one("SELECT count(*) n FROM operations WHERE operation_id=?", refused.operationId),
  ).toEqual({ n: 0 });
  // A retired database leaves the count, so the promotion is admitted with nine live databases.
  await control.core
    .prepare(
      "UPDATE database_provider_target_heads SET state='retired',updated_at='2026-10-02T00:00:00.000000Z' WHERE organization_id=?1 AND physical_environment_id=?2",
    )
    .bind(full.organizationId, fullLive[0])
    .run();
  await expect(
    full.store.productApi.acceptApiProductOperation(await promote(full, fullPublished)),
  ).resolves.toMatchObject({ state: "queued" });

  // Nine live and one retired database: the retired one is not counted, so the promotion is admitted.
  const nine = await productRig(control, { shared: false });
  await linkSource(nine);
  const ninePublished = await publishedRevision(nine, nine.devEnvironmentId, {
    frameworkPlan: sourceFrameworkPlan(true),
  });
  for (let index = 0; index < 9; index += 1) await addLiveDatabase(nine);
  await addLiveDatabase(nine, false);
  await expect(
    nine.store.productApi.acceptApiProductOperation(await promote(nine, ninePublished)),
  ).resolves.toMatchObject({ state: "queued" });

  // A source plan without a database is not capped, even with ten live databases in the organization.
  const plain = await productRig(control, { shared: false });
  await linkSource(plain);
  const plainPublished = await publishedRevision(plain, plain.devEnvironmentId, {
    frameworkPlan: sourceFrameworkPlan(false),
  });
  for (let index = 0; index < 10; index += 1) await addLiveDatabase(plain);
  await expect(
    plain.store.productApi.acceptApiProductOperation(await promote(plain, plainPublished)),
  ).resolves.toMatchObject({ state: "queued" });
}, 120_000);

it("refuses a deployment while a provider cutover of its project is unreleased under its own code, and accepts it once released", async () => {
  const rig = await productRig(control),
    { sourceConnectionId } = await linkSource(rig),
    plan = await createPlan(rig, sourceConnectionId);
  // An authorized cutover of the project that no release has closed.
  const cutoverOperationId = newUlid();
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued','2026-10-01T00:00:00.000000Z','2026-10-01T00:00:00.000000Z')",
      )
      .bind(rig.organizationId, rig.projectId, cutoverOperationId, rig.billingEpochId),
    control.core
      .prepare(
        "INSERT INTO database_provider_cutover_authorizations(organization_id,operation_id,project_id,physical_environment_id,manifest_sha256,expected_lifecycle_version,source_target_version,source_registration,target_provider_project_id,target_region_id,target_size_class_id,approved_at,approved_by) VALUES(?1,?2,?3,?4,?5,1,1,'{}',?6,'us-dev','small','2026-10-01T00:00:00.000000Z','owner')",
      )
      .bind(
        rig.organizationId,
        cutoverOperationId,
        rig.projectId,
        newUlid(),
        new Uint8Array(32),
        `prj_${"a".repeat(20)}`,
      ),
  ]);
  const request = acceptance(rig, rig.devEnvironmentId, {
    eventType: "DeploymentRequestedV1",
    routeTemplate: "/v1/projects/{project_id}/deployments",
    planId: plan.planId,
    planDigest: plan.planDigest,
    deploymentId: newUlid(),
  });
  await expect(rig.store.productApi.acceptApiProductOperation(request)).rejects.toThrow(
    "cutover_pending",
  );
  expect(
    await one("SELECT COUNT(*) AS n FROM deployments WHERE deployment_id=?", request.deploymentId),
  ).toEqual({ n: 0 });

  await control.core
    .prepare(
      "INSERT INTO database_provider_cutover_releases(organization_id,operation_id,released_at,released_by) VALUES(?1,?2,'2026-10-02T00:00:00.000000Z','owner')",
    )
    .bind(rig.organizationId, cutoverOperationId)
    .run();
  await expect(rig.store.productApi.acceptApiProductOperation(request)).resolves.toMatchObject({
    operationId: request.operationId,
    state: "queued",
  });
});
