import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { sourceFrameworkPlan } from "../support/provider-fixtures.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { exhaust } from "../support/credit-fixtures.js";
import {
  configureMail,
  createPlan,
  fundOrganization,
  grantPaidAccess,
  linkSource,
  planRequest,
  productRig,
  publishedRevision,
} from "../support/product-api-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
}, 120_000);
afterAll(async () => control?.dispose());

const one = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

describe("productApi planning commands", () => {
  it("issues an action confirmation once, answers its replay, refuses a changed replay and checks it before use", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi;
    await linkSource(rig);
    const published = await publishedRevision(rig, rig.devEnvironmentId),
      confirmation = {
        confirmationId: newUlid(),
        organizationId: rig.organizationId,
        projectId: rig.projectId,
        issuedToPrincipalId: rig.principalId,
        action: "promote",
        targetDeploymentId: published.deploymentId,
        subjectEtag: '"subject"',
        tokenDigest: new Uint8Array(32).fill(0xe1),
        issuedAt: "2026-10-28T11:20:00.000Z",
      };
    expect(await api.issueApiActionConfirmation(confirmation)).toBe("created");
    // A promote confirmation carries the source generation it was issued under.
    expect(
      await one(
        "SELECT source_generation,expires_at FROM action_confirmations WHERE confirmation_id=?",
        confirmation.confirmationId,
      ),
    ).toEqual({ source_generation: 1, expires_at: "2026-10-28T11:30:00.000000Z" });
    expect(await api.issueApiActionConfirmation(confirmation)).toBe("existing");
    await expect(
      api.issueApiActionConfirmation({ ...confirmation, subjectEtag: '"other"' }),
    ).rejects.toThrow("deployment_persistence_conflict");
    // A target belongs to promote and rollback only.
    await expect(
      api.issueApiActionConfirmation({
        ...confirmation,
        confirmationId: newUlid(),
        action: "delete",
      }),
    ).rejects.toThrow();

    const use = (overrides: Record<string, unknown> = {}) =>
      api.requireApiUsableConfirmation({
        organizationId: rig.organizationId,
        projectId: rig.projectId,
        principalId: rig.principalId,
        action: "promote",
        targetDeploymentId: confirmation.targetDeploymentId,
        subjectEtag: '"subject"',
        tokenDigest: confirmation.tokenDigest,
        now: "2026-10-28T11:25:00.000Z",
        ...overrides,
      });
    await expect(use()).resolves.toBeUndefined();
    await expect(use({ tokenDigest: new Uint8Array(32).fill(1) })).rejects.toThrow(
      "confirmation_invalid",
    );
    await expect(use({ now: "2026-10-28T11:31:00.000Z" })).rejects.toThrow("confirmation_expired");
  }, 30_000);

  it("creates an immutable deployment plan, replays it exactly and gates Mail on its domain and Paid access", async () => {
    const rig = await productRig(control),
      { sourceConnectionId } = await linkSource(rig),
      api = rig.store.productApi,
      plan = await createPlan(rig, sourceConnectionId);
    expect(
      await one(
        "SELECT source_generation,expires_at FROM deployment_plans WHERE plan_id=?",
        plan.planId,
      ),
    ).toEqual({ source_generation: 1, expires_at: "2026-10-29T11:00:00.000000Z" });
    // The identical request is the existing plan; any other fact under the same id is a conflict.
    expect(await api.createApiDeploymentPlan(plan)).toBe("existing");
    await expect(api.createApiDeploymentPlan({ ...plan, risks: ["different"] })).rejects.toThrow(
      "deployment_persistence_conflict",
    );
    await expect(
      api.createApiDeploymentPlan({ ...planRequest(rig, sourceConnectionId), sourceGeneration: 2 }),
    ).rejects.toThrow("deployment_persistence_conflict");

    // A Mail plan needs a configured Mail domain, Paid access and credit.
    const mail = () =>
      planRequest(rig, sourceConnectionId, {
        frameworkPlan: { ...sourceFrameworkPlan(false), mail: { enabled: true } },
      });
    await expect(api.createApiDeploymentPlan(mail())).rejects.toMatchObject({
      code: "mail_domain_required",
    });
    await configureMail(rig);
    await expect(api.createApiDeploymentPlan(mail())).rejects.toMatchObject({
      code: "paid_plan_required",
    });
    await grantPaidAccess(rig);
    // Paid, but the credit ran out more than a week ago.
    await exhaust(control.core, rig.organizationId, "2026-10-01T00:00:00.000000Z");
    await expect(api.createApiDeploymentPlan(mail())).rejects.toMatchObject({
      code: "insufficient_organization_credits",
    });
    await fundOrganization(rig);
    const paid = mail();
    expect(await api.createApiDeploymentPlan(paid)).toBe("created");
    expect(
      await one(
        "SELECT json_extract(framework_plan,'$.mail.enabled') enabled FROM deployment_plans WHERE plan_id=?",
        paid.planId,
      ),
    ).toEqual({ enabled: 1 });
  }, 30_000);
});
