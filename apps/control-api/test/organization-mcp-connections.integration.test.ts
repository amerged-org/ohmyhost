import { parseUlid } from "@ohmyhost/platform";
import { expect, it } from "vitest";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { digest, seedOrganization } from "../../control-store/test/support/seed.js";
import { createControlApi } from "../src/index.js";
import {
  createOrganizationMcpConnectionsPort,
  isOrganizationMcpConnectionsRuntime,
} from "../src/organization-mcp-connections.js";
import { API, BEARER, PRINCIPAL, routeDependencies } from "./helpers/app-routes-fixture.js";

it("lists and disconnects one workspace's MCP consents through the real Core and the route", async () => {
  const control = await createTestControl();
  try {
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

    // The Core's identity commands satisfy the port's runtime contract; a runtime without them does not.
    expect(isOrganizationMcpConnectionsRuntime(store.identity)).toBe(true);
    expect(
      isOrganizationMcpConnectionsRuntime({ listOrganizationMcpConnections: async () => [] }),
    ).toBe(false);
    expect(isOrganizationMcpConnectionsRuntime(null)).toBe(false);

    const connections = createOrganizationMcpConnectionsPort({
      runtime: store.identity,
      clock: { now: () => new Date("2026-10-28T12:11:00.000Z") },
    });
    expect(await connections.list({ organizationId })).toEqual({
      connections: [
        {
          connection_id: proof.grantId,
          client_id: "client_one",
          user_id: userId,
          connected_at: "2026-10-28T12:10:00.000Z",
        },
      ],
    });

    // The route is Owner-gated (`sources:link`) and serves the real port; the account is the workspace's own.
    const check = async () => "allow" as const;
    const app = createControlApi(
      routeDependencies({
        authentication: {
          authenticate: async (token) =>
            token === "valid"
              ? { ...PRINCIPAL, organizationIds: [parseUlid(organizationId)] }
              : null,
        },
        authorization: { check },
        organizationMcpConnections: connections,
      }),
    );
    const base = `${API}/v1/organizations/${organizationId}/mcp-connections`;
    const listed = await app.request(base, { headers: BEARER });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      connections: [{ connection_id: proof.grantId, client_id: "client_one" }],
    });

    // The disconnect leaves this workspace's list, and the consent no longer proves a connection.
    const revoked = await app.request(`${base}/${proof.grantId}`, {
      method: "DELETE",
      headers: BEARER,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ state: "revoked" });
    expect(await connections.list({ organizationId })).toEqual({ connections: [] });
    expect(
      await store.identity.ensureMcpConnectionProof({
        ...connection,
        projectId: null,
        now: "2026-10-28T12:12:00.000Z",
      }),
    ).toBeNull();

    // An unknown grant is a not-found: the Core answers null and the route refuses it.
    const unknown = await app.request(`${base}/00000000-0000-4000-8000-00000000dead`, {
      method: "DELETE",
      headers: BEARER,
    });
    expect(unknown.status).toBe(404);

    // A foreign workspace never reaches the port, and a denied Owner gate hides the list and the disconnect.
    const foreign = await app.request(
      `${API}/v1/organizations/00000000000000000000000009/mcp-connections`,
      { headers: BEARER },
    );
    expect(foreign.status).toBe(404);
    const denied = createControlApi(
      routeDependencies({
        authentication: {
          authenticate: async (token) =>
            token === "valid"
              ? { ...PRINCIPAL, organizationIds: [parseUlid(organizationId)] }
              : null,
        },
        authorization: { check: async () => "deny" as const },
        organizationMcpConnections: connections,
      }),
    );
    expect((await denied.request(base, { headers: BEARER })).status).toBe(404);
  } finally {
    await control.dispose();
  }
});
