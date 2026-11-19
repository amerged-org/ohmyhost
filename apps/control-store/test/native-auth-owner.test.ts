import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

it("authorizes only the current owner of the exact live realm", async () => {
  const { project, principalId } = await seedDevAccessProject(control);
  await control.core
    .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  const store = createControlStore(control.bindings);
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    principalId,
  };
  expect(await store.identity.authorizeNativeAuthOwner(scope)).toBe(true);
  expect(await store.projects.authorizeOrganizationAction({ ...scope, action: "auth:read" })).toBe(
    "allow",
  );
  expect(
    await store.projects.authorizeOrganizationAction({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      principalId,
      action: "auth:read",
    }),
  ).toBe("deny");
  expect(
    await store.identity.authorizeNativeAuthOwner({ ...scope, environmentId: newUlid() }),
  ).toBe(false);
  expect(
    await store.identity.authorizeNativeAuthOwner({ ...scope, principalId: "user:user_other" }),
  ).toBe(false);
  await control.core
    .prepare("UPDATE organization_memberships SET role='member' WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  expect(await store.projects.authorizeOrganizationAction({ ...scope, action: "auth:read" })).toBe(
    "deny",
  );
  await control.core
    .prepare("UPDATE organization_memberships SET role='admin' WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  await control.core
    .prepare("UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  expect(await store.identity.authorizeNativeAuthOwner(scope)).toBe(false);
});
