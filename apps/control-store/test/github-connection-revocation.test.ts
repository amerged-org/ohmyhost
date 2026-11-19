import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedProject, STORED_NOW } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const at = (minute: number) => `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000000Z`;

describe("github connection revocation", () => {
  it("records one repository grant revocation per active grant when the connection is revoked", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      organizationId = project.organizationId,
      connectionId = newUlid(),
      sourceConnection = newUlid(),
      grantId = newUlid();
    await db.batch([
      db
        .prepare(
          "INSERT INTO github_organization_connections(connection_id,organization_id,installation_id,account_id,account_login,account_type,github_user_id,github_user_login,principal_id,settings_url,connected_at) VALUES(?1,?2,'42','7','octo','Organization','9','owner','user:user_gh','https://github.com/settings/installations/42',?3)",
        )
        .bind(connectionId, organizationId, STORED_NOW),
      db
        .prepare(
          "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','77',?5)",
        )
        .bind(
          organizationId,
          sourceConnection,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','42','77','octo','app','contents:read',?6)",
        )
        .bind(
          organizationId,
          grantId,
          project.projectId,
          project.billingEpochId,
          sourceConnection,
          STORED_NOW,
        ),
    ]);

    const revoked = await store.github.revokeGithubConnection({
      organizationId,
      connectionId,
      now: at(20),
      reason: "permission_revoked",
    });
    expect(revoked).toMatchObject({ revoked_at: at(20) });
    const revocations = async () =>
      db
        .prepare(
          "SELECT grant_id,project_id,reason,revoked_at FROM repository_grant_revocations WHERE organization_id=?1",
        )
        .bind(organizationId)
        .all<Record<string, unknown>>();
    expect((await revocations()).results).toEqual([
      {
        grant_id: grantId,
        project_id: project.projectId,
        reason: "permission_revoked",
        revoked_at: at(20),
      },
    ]);

    // A repeated disconnect changes nothing: the grant keeps its first revocation.
    await store.github.revokeGithubConnection({
      organizationId,
      connectionId,
      now: at(30),
      reason: "permission_revoked",
    });
    expect((await revocations()).results).toHaveLength(1);
  });
});
