import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { setPaid } from "../../src/catalog/credit/index.js";
import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject, STORED_NOW, type SeededProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("disables the Powered-by flag of a project with a paid domain only while the organization is Paid, judged from its paid_until", async () => {
  const store = createControlStore(control.bindings),
    paid = await seedProject(control),
    unpaid = await seedProject(control),
    now = "2026-10-29T07:00:00.000Z";

  // Paid coverage runs to the middle of November; the other organization has none.
  await control.core.batch(
    setPaid(control.core, {
      organizationId: paid.organizationId,
      paidUntil: "2026-11-15T00:00:00.000Z",
      source: "stripe",
      now,
    }).statements,
  );

  const set = (project: SeededProject, key: string, enabled: boolean) =>
    store.apiMetadata.setPoweredByFlag({
      organizationId: project.organizationId,
      projectId: project.projectId,
      principalId: "user:owner",
      idempotencyKey: key,
      canonicalRequestDigest: (key === "enable" ? "a" : "b").repeat(64),
      now,
      eventId: newUlid(),
      enabled,
      periodId: newUlid(),
    });
  for (const project of [paid, unpaid]) {
    expect(await set(project, "enable", true)).toEqual({ enabled: true, enabledAt: now });
    await control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES(?1,?2,?3,'awaiting_deployment','user:owner',zeroblob(32),zeroblob(32),?4,?4)",
      )
      .bind(project.organizationId, project.projectId, `${project.handle}.example.com`, STORED_NOW)
      .run();
  }

  // Without Paid coverage the dependent paid domain keeps the flag required.
  await expect(set(unpaid, "disable", false)).rejects.toMatchObject({
    code: "powered_by_flag_required",
  });
  expect(await set(paid, "disable", false)).toEqual({ enabled: false, enabledAt: null });
  expect(
    await store.apiMetadata.readPoweredByFlag({
      organizationId: paid.organizationId,
      projectId: paid.projectId,
    }),
  ).toEqual({ enabled: false, enabledAt: null });
  expect(
    await control.core
      .prepare(
        "SELECT count(*) n FROM project_powered_by_flag_periods WHERE project_id=?1 AND disabled_at IS NOT NULL",
      )
      .bind(paid.projectId)
      .first(),
  ).toEqual({ n: 1 });
});
