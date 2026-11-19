import { expect, it } from "vitest";
import { createControlStore } from "../src/store.js";
import { createTestControl } from "./support/control-d1.js";
import { seedProject } from "./support/platform-fixtures.js";

it("rejects every retired mail-picker input without writes and persists the exact Native secret handoff", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control);
    const store = createControlStore(control.bindings);
    const authority = {
      grantId: "11111111-1111-4111-8111-111111111111",
      clientId: "native-scope-client",
      consentHash: "ab".repeat(32),
      action: "auth:manage",
      authorizationRestriction: {
        actions: ["auth:read", "auth:manage"],
        organizationIds: [project.organizationId],
        projectIds: [project.projectId],
      },
    };
    const handoff = {
      organizationId: project.organizationId,
      userId: "user_fixture",
      clientId: authority.clientId,
      consentHash: authority.consentHash,
      requestHash: "cd".repeat(32),
      authority,
      kind: "secret",
      projectIds: [project.projectId],
      allowCreate: false,
      allowPublish: false,
      secretTarget: {
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
        environment: "dev",
        name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
        nativeProvider: { provider: "google", configurationRevision: 1, enabled: true },
      },
      createdAt: "2026-11-05T10:00:00.000Z",
      expiresAt: "2026-11-05T10:05:00.000Z",
    };
    const mailDomainId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    for (const retired of [
      { mailDomains: [{ mailDomainId, permissions: ["read", "read"] }] },
      {
        mailDomains: [
          { mailDomainId, permissions: ["read"] },
          { mailDomainId, permissions: ["use"] },
        ],
      },
      {
        mailDomains: [
          { mailDomainId, permissions: ["read", "use"] },
          { mailDomainId: project.projectId, permissions: ["admin"] },
        ],
      },
      { mailDomains: [] },
      { allowMailDomainCreate: false },
      { allowMailDomainCreate: true },
    ]) {
      await expect(
        store.identity.insertMcpHandoff({ ...handoff, ...retired }),
      ).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: [],
            keys: Object.keys(retired),
          }),
        ]),
      });
    }
    const countHandoffs = () =>
      control.core
        .prepare(
          "SELECT (SELECT count(*) FROM mcp_handoff_routes WHERE organization_id=?1) routes,(SELECT count(*) FROM mcp_portal_handoffs WHERE organization_id=?1) handoffs",
        )
        .bind(project.organizationId)
        .first();
    expect(await countHandoffs()).toEqual({ routes: 0, handoffs: 0 });
    await store.identity.insertMcpHandoff(handoff);
    for (const retired of [{ selectedMailDomainIds: [] }, { allowMailDomainCreate: false }]) {
      await expect(
        store.identity.consumeMcpHandoff({
          requestHash: handoff.requestHash,
          userId: handoff.userId,
          organizationId: handoff.organizationId,
          now: handoff.createdAt,
          approve: true,
          publish: false,
          ...retired,
        }),
      ).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: [],
            keys: Object.keys(retired),
          }),
        ]),
      });
    }
    expect(await countHandoffs()).toEqual({ routes: 1, handoffs: 1 });
    expect(await store.identity.findMcpHandoff({ requestHash: handoff.requestHash })).toMatchObject(
      {
        authority,
        projectIds: [project.projectId],
        secretTarget: handoff.secretTarget,
        consumedAt: null,
        outcome: null,
      },
    );
    const stored = await control.core
      .prepare(
        "SELECT mail_domain_scopes,allow_mail_domain_create FROM mcp_portal_handoffs WHERE request_hash=?1",
      )
      .bind(handoff.requestHash)
      .first();
    expect(stored).toEqual({ mail_domain_scopes: "[]", allow_mail_domain_create: 0 });
  } finally {
    await control.dispose();
  }
});
