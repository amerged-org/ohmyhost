import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { seedAcceptedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { freezeOwnership, seedProject, STORED_NOW } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("answers every remote MCP read from the committed rows: memberships, environments, delegations, grants, recovery context and created projects", async () => {
  const mcp = createControlStore(control.bindings).remoteMcp,
    p = await seedProject(control),
    frozen = await seedProject(control),
    db = control.core,
    consentHash = "c".repeat(64),
    grantId = "11111111-2222-4333-8444-555555555555",
    mailDomainId = newUlid();

  // Memberships: an active member is listed, a user with a terminal revocation is not.
  await db.batch([
    db
      .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
      .bind(p.organizationId, STORED_NOW),
    ...["user_member", "user_revoked"].map((user) =>
      db
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'member','active',1,?3,?4,'evt')",
        )
        .bind(p.organizationId, user, new Uint8Array(32).fill(1), STORED_NOW),
    ),
    db
      .prepare(
        "INSERT INTO revocations(kind,resource_id,source_event_id,effective_at,purge_after) VALUES('user','user_revoked','evt-revoked',?1,NULL)",
      )
      .bind(STORED_NOW),
  ]);
  expect(
    await mcp.readMcpAuthorizedMemberships({
      userId: "user_member",
      clientId: "client_one",
      consentHash,
    }),
  ).toEqual({ disconnected: false, organizationIds: [p.organizationId] });
  expect(
    await mcp.readMcpAuthorizedMemberships({
      userId: "user_revoked",
      clientId: "client_one",
      consentHash,
    }),
  ).toEqual({ disconnected: true, organizationIds: [] });

  // Environment, project owner and plan names.
  const scope = { organizationId: p.organizationId, projectId: p.projectId };
  expect(await mcp.readMcpEnvironmentName({ ...scope, environmentId: p.devEnvironmentId })).toBe(
    "dev",
  );
  expect(await mcp.readMcpEnvironmentName({ ...scope, environmentId: newUlid() })).toBeNull();
  await freezeOwnership(frozen);
  expect(await mcp.readMcpProjectOrganization({ projectId: p.projectId, activeOnly: true })).toBe(
    p.organizationId,
  );
  expect(
    await mcp.readMcpProjectOrganization({ projectId: frozen.projectId, activeOnly: true }),
  ).toBeNull();
  expect(
    await mcp.readMcpProjectOrganization({ projectId: frozen.projectId, activeOnly: false }),
  ).toBe(frozen.organizationId);

  // Consent evidence: the mail delegation needs the admin permission, the grant revision is read as text.
  const identity = {
    organizationId: p.organizationId,
    userId: "user_member",
    clientId: "client_one",
    consentHash,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,allow_publish,revision,created_at) VALUES(?1,?2,?3,?4,?5,0,5,?6)",
      )
      .bind(p.organizationId, grantId, identity.userId, identity.clientId, consentHash, STORED_NOW),
  ]);
  expect(await mcp.readMcpMailDomainOrganization({ mailDomainId })).toBeNull();
  expect(await mcp.readMcpGrantRevision({ grantId })).toBe("5");
  expect(
    await mcp.readMcpGrantRevision({ grantId: "99999999-2222-4333-8444-555555555555" }),
  ).toBeNull();

  // An accepted deployment: its recovery context, plan environment, creating request and stale source.
  const accepted = await seedAcceptedOperation(p, p.prodEnvironmentId);
  expect(
    await mcp.readMcpRecoveryContext({
      operationId: accepted.operationId,
      organizationIds: [p.organizationId],
    }),
  ).toEqual([
    {
      organization_id: p.organizationId,
      project_id: p.projectId,
      state: "running",
      event_type: "DeploymentRequestedV1",
      environment_name: "prod",
    },
  ]);
  expect(
    await mcp.readMcpRecoveryContext({
      operationId: accepted.operationId,
      organizationIds: [frozen.organizationId],
    }),
  ).toEqual([]);
  expect(
    await mcp.readMcpPlanEnvironmentName({
      projectId: p.projectId,
      planId: accepted.intent.plan_id,
    }),
  ).toBe("prod");
  await expect(
    mcp.authorizeMcpExecution({ ...scope, operationId: accepted.operationId }),
  ).resolves.toBeUndefined();
});
