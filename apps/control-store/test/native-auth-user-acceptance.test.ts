import { afterAll, beforeAll, expect, it } from "vitest";
import {
  acceptNativeAuthUserMutation,
  authorizeAcceptedNativeAuthUserMutation,
} from "../src/catalog/identity/native-auth-user-acceptance.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";
import { losingWriteResponses, STORED_NOW } from "./support/platform-fixtures.js";
import { SharedCoreRouter } from "../src/router.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control?.dispose());

it("binds acceptance and private effect to exact Owner, request, realm and current delegation", async () => {
  const { project, principalId } = await seedDevAccessProject(control);
  await control.core
    .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  await control.core
    .prepare(
      `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
    )
    .bind(project.organizationId, project.projectId, project.devEnvironmentId)
    .run();
  const context = { directory: control.core, router: new SharedCoreRouter(control.core) };
  const grantId = crypto.randomUUID(),
    hash = "ab".repeat(32);
  await control.core
    .prepare(
      `INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at) VALUES(?1,?2,'user_dev','client-1',?3,?4,1,?5,0,1,?6)`,
    )
    .bind(
      project.organizationId,
      grantId,
      hash,
      project.projectId,
      project.billingEpochId,
      STORED_NOW,
    )
    .run();
  const request = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    principalId,
    action: "suspend",
    resourceId: "c6b92630-44e3-4d0b-9fd7-45f81d407df2",
    idempotencyKey: "once",
    canonicalRequestDigest: "a".repeat(64),
    delegation: { grantId, clientId: "client-1", consentHash: hash, action: "auth:manage" },
  };
  await expect(
    acceptNativeAuthUserMutation(context, { ...request, resourceId: null }),
  ).rejects.toThrow("native_auth_user_acceptance_conflict");
  await expect(
    acceptNativeAuthUserMutation(context, { ...request, action: "create-invite" }),
  ).rejects.toThrow("native_auth_user_acceptance_conflict");
  await expect(
    acceptNativeAuthUserMutation(context, {
      ...request,
      delegation: {
        ...request.delegation,
        authorizationRestriction: { actions: ["secrets:write"] },
      },
    }),
  ).rejects.toThrow();
  const lossy = losingWriteResponses(control.core, 1);
  await expect(
    acceptNativeAuthUserMutation(
      { directory: lossy, router: new SharedCoreRouter(lossy) },
      request,
    ),
  ).rejects.toThrow();
  expect(await acceptNativeAuthUserMutation(context, request)).toEqual({ outcome: "replayed" });
  expect(
    await acceptNativeAuthUserMutation(context, { ...request, idempotencyKey: "second" }),
  ).toEqual({ outcome: "accepted" });
  expect(await authorizeAcceptedNativeAuthUserMutation(context, request)).toBe(true);
  await expect(
    acceptNativeAuthUserMutation(context, { ...request, canonicalRequestDigest: "b".repeat(64) }),
  ).rejects.toThrow("idempotency_key_reused");
  await expect(
    authorizeAcceptedNativeAuthUserMutation(context, { ...request, action: "delete" }),
  ).rejects.toThrow();
  await expect(
    authorizeAcceptedNativeAuthUserMutation(context, {
      ...request,
      environmentId: project.prodEnvironmentId,
    }),
  ).rejects.toThrow();
  await expect(
    authorizeAcceptedNativeAuthUserMutation(context, {
      ...request,
      resourceId: "f90b2731-f11a-402f-b03c-56201f4f74aa",
    }),
  ).rejects.toThrow();
  await expect(
    authorizeAcceptedNativeAuthUserMutation(context, {
      ...request,
      principalId: "user:user_foreign",
    }),
  ).rejects.toThrow();
  await expect(
    authorizeAcceptedNativeAuthUserMutation(context, { ...request, delegation: undefined }),
  ).rejects.toThrow();
  const stored = await control.core
    .prepare("SELECT * FROM native_auth_user_mutation_acceptances WHERE project_id=?1")
    .bind(project.projectId)
    .all();
  expect(JSON.stringify(stored)).not.toContain("@example");
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET app_name='Renamed',configuration_revision=2 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(project.organizationId, project.projectId, project.devEnvironmentId)
    .run();
  expect(await authorizeAcceptedNativeAuthUserMutation(context, request)).toBe(true);
  expect(await acceptNativeAuthUserMutation(context, request)).toEqual({ outcome: "replayed" });
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET enabled=0,configuration_revision=3,revocation_epoch=2 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(project.organizationId, project.projectId, project.devEnvironmentId)
    .run();
  await expect(authorizeAcceptedNativeAuthUserMutation(context, request)).rejects.toThrow();
  await expect(acceptNativeAuthUserMutation(context, request)).rejects.toThrow(
    "native_auth_operation_revoked",
  );
  const newRequest = { ...request, idempotencyKey: "after-revocation" };
  expect(await acceptNativeAuthUserMutation(context, newRequest)).toEqual({ outcome: "accepted" });
  expect(await authorizeAcceptedNativeAuthUserMutation(context, newRequest)).toBe(true);
  const epochs = await control.core
    .prepare(
      "SELECT idempotency_key,revocation_epoch FROM native_auth_user_mutation_acceptances WHERE project_id=?1 ORDER BY idempotency_key",
    )
    .bind(project.projectId)
    .all<{ idempotency_key: string; revocation_epoch: number }>();
  expect(epochs.results).toContainEqual({ idempotency_key: "once", revocation_epoch: 1 });
  expect(epochs.results).toContainEqual({
    idempotency_key: "after-revocation",
    revocation_epoch: 2,
  });
  await control.core
    .prepare("UPDATE mcp_client_grants SET revoked_at=?1 WHERE grant_id=?2")
    .bind(STORED_NOW, grantId)
    .run();
  await expect(authorizeAcceptedNativeAuthUserMutation(context, newRequest)).rejects.toThrow();
  await expect(acceptNativeAuthUserMutation(context, newRequest)).rejects.toThrow();
  await control.core
    .prepare("UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  await expect(
    acceptNativeAuthUserMutation(context, {
      ...request,
      delegation: undefined,
      idempotencyKey: "next",
    }),
  ).rejects.toThrow();
});
