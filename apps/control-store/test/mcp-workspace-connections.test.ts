import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { digest, seedOrganization } from "./support/seed.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

describe("workspace MCP connections", () => {
  it("lists the live consents of one workspace and disconnects one only for that workspace", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      organizationId = await seedOrganization(store, 2, 0),
      userId = "user_mcp_owner",
      connection = { organizationId, userId, clientId: "client_one", consentHash: digest(41) };
    await db.batch([
      db
        .prepare(
          "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?1",
        )
        .bind(organizationId),
      db
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'admin','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','mcp-workspace')",
        )
        .bind(organizationId, userId),
      db
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner','2026-10-28T10:00:00.000000Z')",
        )
        .bind(organizationId, newUlid(), `user:${userId}`),
    ]);
    const proof = await store.identity.ensureMcpConnectionProof({
      ...connection,
      projectId: null,
      now: "2026-10-28T12:10:00.000Z",
    });
    if (!proof) throw new Error("MCP connection proof fixture missing");

    expect(await store.identity.listOrganizationMcpConnections({ organizationId })).toEqual([
      {
        connection_id: proof.grantId,
        client_id: "client_one",
        user_id: userId,
        connected_at: expect.any(String),
      },
    ]);
    expect(
      await store.identity.revokeOrganizationMcpConnection({
        organizationId,
        connectionId: proof.grantId,
        now: "2026-10-28T12:11:00.000Z",
      }),
    ).toEqual({ state: "revoked" });
    expect(await store.identity.listOrganizationMcpConnections({ organizationId })).toEqual([]);
    expect(
      await store.identity.ensureMcpConnectionProof({
        ...connection,
        projectId: null,
        now: "2026-10-28T12:12:00.000Z",
      }),
    ).toBeNull();

    // The workspace tombstone is not the account-wide disconnect: no connection-wide revocation is written.
    const global = await db
      .prepare("SELECT count(*) AS n FROM mcp_connection_revocations WHERE user_id=?1")
      .bind(userId)
      .first<{ n: number }>();
    expect(global?.n).toBe(0);
    expect(
      await store.identity.revokeOrganizationMcpConnection({
        organizationId,
        connectionId: "00000000-0000-4000-8000-00000000dead",
        now: "2026-10-28T12:13:00.000Z",
      }),
    ).toBeNull();
  });
});
