import { expect, it, vi } from "vitest";
import { parseUlid, restrictionAllows } from "@ohmyhost/platform";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import { createRemoteMcpComposition } from "../src/remote-mcp-composition.js";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
import { connect, remoteMcpFixture } from "./helpers/d1-remote-mcp-fixture.js";

// The Worker host binds env through its constructor; the Core's private entrypoints run unchanged in process.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, environment: unknown) {
      this.env = environment;
    }
  },
}));

it("intersects signed Connect consent, workspace sender grants and browser sessions over the real Core", async () => {
  const control = await createTestControl();
  try {
    const f = await remoteMcpFixture(control),
      now = new Date(),
      human: AuthenticatedPrincipal = {
        actorId: `user:${f.userId}`,
        credentialId: "workos_session:session_mcp",
        authorizationPrincipal: { kind: "user", subjectId: `user:${f.userId}` },
        organizationIds: [f.organizationId],
        session: {
          sessionId: "session_mcp",
          userId: f.userId,
          organizationId: f.workosOrganizationId,
          tokenExpiresAt: Math.floor(now.getTime() / 1000) + 300,
        },
      };
    let browserCredential = human.credentialId;
    const dispatched: { principal: AuthenticatedPrincipal | null; path: string }[] = [],
      composition = createRemoteMcpComposition({
        persistence: f.persistence,
        clock: { now: () => now },
        origin: connect.origin,
        issuer: connect.issuer,
        jwks: { load: async () => f.jwks },
        // The WorkOS bearer boundary: the session token "browser" belongs to the signed-in member.
        authentication: {
          authenticate: async (token) =>
            token === "browser"
              ? { ...human, credentialId: browserCredential }
              : token === "anonymous"
                ? { ...human, session: undefined }
                : null,
        },
        authorization: { check: async () => "allow" },
        resolveOrganization: async (id) =>
          id === f.workosOrganizationId ? f.organizationId : null,
        dispatch: async (request) => {
          dispatched.push({
            principal: await composition.internalAuthentication.resolve(request),
            path: new URL(request.url).pathname,
          });
          return Response.json({
            items: [
              { id: f.project.projectId, organization_id: f.project.organizationId },
              { id: ulidOf("foreign-project", 1), organization_id: f.project.organizationId },
            ],
            next_cursor: null,
          });
        },
      }),
      connected = await composition.authenticate(await f.connectToken());
    if (!connected) throw new Error("Signed Connect principal unavailable");
    expect(
      await composition.authenticate(
        await f.connectToken({ aud: `${connect.origin}/mcp/chatgpt` }),
      ),
    ).toBeNull();
    expect(
      (await composition.authenticate(await f.connectToken({ org_id: "org_deleted" })))
        ?.organizationIds,
    ).toEqual([f.organizationId]);

    const organization = { kind: "organization" as const, organizationId: f.organizationId };
    const project = {
      kind: "project" as const,
      organizationId: f.organizationId,
      projectId: parseUlid(f.project.projectId),
    };
    // Existing OAuth has no per-project grant prerequisite; canonical authorization follows the proof fence.
    expect(await composition.remoteAuthorization(connected, organization, "projects:create")).toBe(
      true,
    );
    expect(await composition.remoteAuthorization(connected, project, "sources:read")).toBe(true);
    expect(await composition.remoteDelegation(connected, f.project.projectId)).toMatchObject({
      clientId: connect.clientId,
    });
    const second = await remoteMcpFixture(control);
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_mcpother','admin','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','other-member')",
        )
        .bind(f.organizationId),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_mcpother','owner','2026-10-28T10:00:00.000000Z')",
        )
        .bind(f.organizationId, newUlid()),
    ]);
    const synchronize = (stamp: string, role: "admin" | "member" = "admin") =>
      f.store.identity.applyOrganizationSnapshot({
        organizationId: f.organizationId,
        workosOrganizationId: f.workosOrganizationId,
        state: "active",
        snapshotDigest: (role === "admin" ? "04" : "05").repeat(32),
        snapshotFetchedAt: stamp,
        synchronizedAt: stamp,
        triggerEventId: `snapshot-${stamp}`,
        auditEventId: newUlid(),
        memberships: [
          {
            workosUserId: f.userId,
            role,
            status: "active",
            digest: (role === "admin" ? "06" : "07").repeat(32),
          },
          {
            workosUserId: "user_mcpother",
            role: "admin",
            status: "active",
            digest: "08".repeat(32),
          },
        ],
      });
    const authority = {
      organizationId: f.organizationId,
      projectId: f.project.projectId,
      principalId: `user:${f.userId}`,
      action: "sources:read" as const,
    };
    await control.core
      .prepare(
        "INSERT INTO workos_membership_sync_barriers(organization_id,workos_user_id,source_event_id,event_created_at,reconciled_at) VALUES(?1,?2,'membership-pending','2026-11-04T10:00:00.000000Z',NULL)",
      )
      .bind(f.organizationId, f.userId)
      .run();
    expect(
      await f.store.identity.isSessionEligible({
        sessionId: "session_mcp",
        workosUserId: f.userId,
        workosOrganizationId: f.workosOrganizationId,
        observedAt: now.toISOString(),
      }),
    ).toBe(false);
    const whilePending = await composition.internalAuthentication.revalidate(connected);
    expect(whilePending?.organizationIds).toEqual([second.organizationId]);
    expect(await f.store.projects.authorizeOrganizationAction(authority)).toBe("deny");
    expect(await composition.remoteAuthorization(connected, project, "sources:read")).toBe(false);
    if (!whilePending)
      throw new Error("Account identity unavailable during workspace synchronization");
    expect(
      await composition.remoteAuthorization(
        whilePending,
        {
          kind: "project",
          organizationId: second.organizationId,
          projectId: parseUlid(second.project.projectId),
        },
        "sources:read",
      ),
    ).toBe(true);
    expect(
      (
        await composition.authenticate(
          await f.connectToken({ sub: "user_mcpother", sid: "app_consent_other" }),
        )
      )?.organizationIds,
    ).toEqual([f.organizationId]);
    await synchronize("2026-11-04T09:59:59.000Z");
    expect(
      (await composition.internalAuthentication.revalidate(connected))?.organizationIds,
    ).toEqual([second.organizationId]);
    await synchronize("2026-11-04T10:00:02.000Z", "member");
    expect(
      (await composition.internalAuthentication.revalidate(connected))?.organizationIds,
    ).toEqual([f.organizationId, second.organizationId].sort());
    expect(
      await f.store.projects.authorizeOrganizationAction({
        ...authority,
        action: "projects:write",
      }),
    ).toBe("deny");
    await synchronize("2026-11-04T10:00:03.000Z");
    expect(await composition.remoteAuthorization(connected, project, "sources:read")).toBe(true);
    await control.core
      .prepare(
        "INSERT INTO pending_membership_barriers(workos_organization_id,workos_user_id,source_event_id,event_created_at) VALUES(?1,?2,'pending-directory','2026-11-04T10:00:04.000000Z')",
      )
      .bind(f.workosOrganizationId, f.userId)
      .run();
    expect(
      (await composition.internalAuthentication.revalidate(connected))?.organizationIds,
    ).toEqual([second.organizationId]);
    expect(await f.store.projects.authorizeOrganizationAction(authority)).toBe("deny");
    expect(await composition.remoteAuthorization(connected, project, "sources:read")).toBe(false);
    await synchronize("2026-11-04T10:00:05.000Z");
    expect(
      (await composition.internalAuthentication.revalidate(connected))?.organizationIds,
    ).toEqual([f.organizationId, second.organizationId].sort());
    const restricted = await composition.authenticate(
      await f.connectToken({
        ohmyhost_authorization: { actions: ["projects:read"], projectIds: [f.project.projectId] },
      }),
    );
    expect(restricted?.authorizationRestriction).toEqual({
      actions: ["projects:read"],
      projectIds: [f.project.projectId],
    });
    expect(
      await composition.authenticate(
        await f.connectToken({ ohmyhost_authorization: { actions: ["unknown"] } }),
      ),
    ).toBeNull();

    // A browser session is kept for revalidation; a token without a session never becomes one.
    const secondOrganization = parseUlid(ulidOf("other-org", 1));
    const secondDomain = parseUlid(ulidOf("other-domain", 1));
    const bounds = { projectIds: [parseUlid(f.project.projectId)], mailDomainIds: [secondDomain] };
    expect(restrictionAllows(bounds, project, "projects:read")).toBe(true);
    expect(
      restrictionAllows(
        bounds,
        { kind: "mail_domain", organizationId: secondOrganization, mailDomainId: secondDomain },
        "mail-domains:read",
      ),
    ).toBe(true);
    expect(
      restrictionAllows(
        bounds,
        { kind: "organization", organizationId: f.organizationId },
        "projects:create",
      ),
    ).toBe(false);
    expect(restrictionAllows({ actions: [] }, organization, "projects:read")).toBe(false);
    expect(restrictionAllows({}, organization, "projects:read")).toBe(true);
    const multi = createRemoteMcpComposition({
      persistence: {
        ...f.persistence,
        authorizedMemberships: async () => ({
          disconnected: false,
          organizationIds: [f.organizationId, secondOrganization],
        }),
        projectOrganization: async () => f.organizationId,
        mailDomainOrganization: async () => secondOrganization,
        recoveryContext: async () => [
          {
            organization_id: f.organizationId,
            project_id: f.project.projectId,
            state: "succeeded",
            event_type: "ProjectExportRequestedV1",
            environment_name: null,
          },
        ],
      },
      clock: { now: () => now },
      origin: connect.origin,
      issuer: connect.issuer,
      jwks: { load: async () => f.jwks },
      authentication: { authenticate: async () => null },
      authorization: { check: async () => "allow" },
      resolveOrganization: async () => f.organizationId,
      dispatch: async () => new Response(),
    });
    const multiPrincipal = await multi.authenticate(
      await f.connectToken({
        ohmyhost_authorization: { actions: ["projects:read", "mail-domains:read"], ...bounds },
      }),
    );
    expect(multiPrincipal?.organizationIds).toEqual([f.organizationId, secondOrganization].sort());
    if (!multiPrincipal) throw new Error("Restricted principal unavailable");
    expect(
      (
        await multi.dispatch(
          new Request(`${connect.origin}/v1/operations/${newUlid()}:reconcile`, { method: "POST" }),
          multiPrincipal,
        )
      ).status,
    ).toBe(200);
    expect(await composition.authenticateBrowser("anonymous")).toBeNull();
    expect(await composition.authenticateBrowser("unknown")).toBeNull();
    const browser = await composition.authenticateBrowser("browser");
    expect(browser).toMatchObject({ actorId: human.actorId, credentialId: human.credentialId });
    if (!browser) throw new Error("Browser principal unavailable");
    expect(await composition.internalAuthentication.revalidate(human)).toBeNull();
    expect((await composition.internalAuthentication.revalidate(browser))?.credentialId).toBe(
      human.credentialId,
    );
    const proof = await composition.remoteDelegation(connected, f.project.projectId);
    if (!proof) throw new Error("Connection proof unavailable");
    const delegatedBrowser = composition.withHandoff(browser, {
      ...proof,
      action: "secrets:write",
      authorizationRestriction: { actions: ["secrets:write"] },
    });
    expect(
      (await composition.internalAuthentication.revalidate(delegatedBrowser))?.handoffDelegation,
    ).toEqual(delegatedBrowser.handoffDelegation);
    expect((await composition.internalAuthentication.revalidate(connected))?.actorId).toBe(
      human.actorId,
    );
    // The same session token that now resolves to another credential is no longer the same caller.
    browserCredential = "workos_session:replaced";
    expect(await composition.internalAuthentication.revalidate(browser)).toBeNull();

    // Dispatch leaves canonical REST response handling to the application.
    const listed = await composition.dispatch(
      new Request(`${connect.origin}/v1/projects`),
      connected,
    );
    expect(await listed.json()).toEqual({
      items: [
        { id: f.project.projectId, organization_id: f.project.organizationId },
        { id: ulidOf("foreign-project", 1), organization_id: f.project.organizationId },
      ],
      next_cursor: null,
    });
    expect(dispatched).toEqual([{ principal: connected, path: "/v1/projects" }]);

    // The caller cannot smuggle credentials, another origin or a non-API path through the dispatch.
    for (const rejected of [
      new Request(`${connect.origin}/v1/projects`, { headers: { authorization: "Bearer forged" } }),
      new Request(`${connect.origin}/v1/projects`, { headers: { cookie: "session=forged" } }),
      new Request("https://attacker.example/v1/projects"),
      new Request(`${connect.origin}/mcp`),
    ]) {
      const denied = await composition.dispatch(rejected, connected);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(await denied.json()).toEqual({ code: "forbidden", status: 403 });
    }
    // Publication reaches the canonical application without a separate grant overlay.
    const plan = (environment: string) =>
      composition.dispatch(
        new Request(`${connect.origin}/v1/projects/${f.project.projectId}/deployments:plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environment }),
        }),
        connected,
      );
    expect((await plan("prod")).status).toBe(200);
    expect((await plan("dev")).status).toBe(200);
    // A recovery of an operation that is not the caller's accepted command is refused as well.
    expect(
      (
        await composition.dispatch(
          new Request(`${connect.origin}/v1/operations/${newUlid()}:reconcile`, { method: "POST" }),
          connected,
        )
      ).status,
    ).toBe(403);

    // Terminal deletion is authoritative before the poller changes the active projection.
    expect(
      await f.store.identity.recordTerminalRevocation({
        kind: "organization",
        workosOrganizationId: f.workosOrganizationId,
        sourceEventId: "organization-deleted-before-reconciliation",
        effectiveAt: "2026-11-04T10:01:00.000Z",
      }),
    ).toBe("created");
    expect(
      await control.core
        .prepare("SELECT state FROM organizations WHERE organization_id=?")
        .bind(f.organizationId)
        .first(),
    ).toEqual({ state: "active" });
    expect(
      await f.store.identity.isSessionEligible({
        sessionId: "session_mcp",
        workosUserId: f.userId,
        workosOrganizationId: f.workosOrganizationId,
        observedAt: now.toISOString(),
      }),
    ).toBe(false);
    const afterDeletion = await composition.internalAuthentication.revalidate(connected);
    expect(afterDeletion?.actorId).toBe(connected.actorId);
    expect(afterDeletion?.organizationIds).toEqual([second.organizationId]);
    expect(await f.store.projects.authorizeOrganizationAction(authority)).toBe("deny");
    expect(await composition.remoteAuthorization(connected, project, "sources:read")).toBe(false);
    expect(
      await f.persistence.store.ensureConnectionProof(
        {
          organizationId: f.organizationId,
          userId: f.userId,
          clientId: "new-client-after-deletion",
          consentHash: "55".repeat(32),
        },
        f.project.projectId,
        now.toISOString(),
      ),
    ).toBeNull();
    if (!afterDeletion) throw new Error("Account identity lost with a deleted workspace");
    expect(
      await composition.remoteAuthorization(
        afterDeletion,
        {
          kind: "project",
          organizationId: second.organizationId,
          projectId: parseUlid(second.project.projectId),
        },
        "sources:read",
      ),
    ).toBe(true);
  } finally {
    await control.dispose();
  }
}, 120000);

it("persists composition-produced operation authority through the public route and actual product port", async () => {
  const control = await createTestControl();
  try {
    const f = await remoteMcpFixture(control);
    const { createD1ProjectApplication, createD1ProjectAuthorization } = await import(
      "../src/d1-project-application.js"
    );
    const { createD1ProductSurfacePort } = await import("../src/d1-product-surface.js");
    const { createUlidFactory, SystemEntropy } = await import("@ohmyhost/platform");
    const { routeDependencies } = await import("./helpers/app-routes-fixture.js");
    const clock = { now: () => new Date() };
    const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
    const runtime = f.bindings
      .CONTROL_RUNTIME as unknown as import("../src/d1-project-persistence.js").D1ProjectRuntime;
    const defaults = routeDependencies();
    const composition = createRemoteMcpComposition({
      persistence: f.persistence,
      clock,
      origin: connect.origin,
      issuer: connect.issuer,
      jwks: { load: async () => f.jwks },
      authentication: { authenticate: async () => null },
      authorization: createD1ProjectAuthorization(runtime),
      resolveOrganization: async () => f.organizationId,
      dispatch: async (request) => app.fetch(request),
    });
    const surface = createD1ProductSurfacePort({
      runtime: f.store
        .productApi as unknown as import("../src/d1-product-surface.js").D1ProductSurfaceRuntime,
      clock,
      ids,
      sourceInspector: {} as never,
      dataChanges: {} as never,
    });
    const revokeMailAuthorization = vi.fn(async () => ({
      status: "not_authorized",
      zone: null,
      scopes: [],
      expires_at: null,
    }));
    const mailDomainId = await f.seedMailDomain();
    const otherMailDomainId = await f.seedMailDomain("other.example.com");
    const app = createD1ProjectApplication({
      runtime,
      authentication: { authenticate: async () => null },
      platform: "development",
      clock,
      ids,
      applicationId: "mcp-authority-test",
      rateLimits: defaults.rateLimits,
      reporter: defaults.reporter,
      remote: {
        internalAuthentication: composition.internalAuthentication,
        remoteAuthorization: composition.remoteAuthorization,
        remoteDelegation: composition.remoteDelegation,
        remoteMailDomainDelegation: composition.remoteMailDomainDelegation,
      },
      extended: {
        productSurface: surface,
        sharedMailIdentity: { revokeWorkspaceMailAuthorization: revokeMailAuthorization } as never,
      },
    });
    const all = await composition.authenticate(await f.connectToken());
    if (!all) throw new Error("Connected principal absent");
    const mailPrincipal = await composition.authenticate(
      await f.connectToken({
        ohmyhost_authorization: { actions: ["mail-domains:admin"], mailDomainIds: [mailDomainId] },
      }),
    );
    if (!mailPrincipal) throw new Error("Restricted mail principal absent");
    expect(mailPrincipal.organizationIds).toEqual([f.organizationId]);
    const revokeMail = (domainId: string) =>
      composition.dispatch(
        new Request(
          `${connect.origin}/v1/organizations/${f.organizationId}/mail-domains/${domainId}/dns-authorization`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json", "idempotency-key": "mail-revoke" },
            body: JSON.stringify({ expected_revision: 1 }),
          },
        ),
        mailPrincipal,
      );
    const mailResponse = await revokeMail(mailDomainId);
    expect(mailResponse.status, await mailResponse.clone().text()).toBe(200);
    expect(revokeMailAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: f.organizationId,
        mailDomainId,
        principalId: `user:${f.userId}`,
        delegation: expect.objectContaining({
          action: "mail-domains:admin",
          clientId: connect.clientId,
          grantRevision: 1,
          authorizationRestriction: {
            actions: ["mail-domains:admin"],
            mailDomainIds: [mailDomainId],
          },
        }),
      }),
    );
    expect((await revokeMail(otherMailDomainId)).status).toBe(404);
    expect(revokeMailAuthorization).toHaveBeenCalledOnce();
    const status = await composition.dispatch(
      new Request(`${connect.origin}/v1/projects/${f.project.projectId}/status`),
      all,
    );
    expect(status.status, await status.clone().text()).toBe(200);
    const etag = ((await status.json()) as { etag: string }).etag;
    if (!etag) throw new Error("Project ETag absent");
    const restricted = await composition.authenticate(
      await f.connectToken({
        ohmyhost_authorization: {
          actions: ["projects:write"],
          projectIds: [f.project.projectId],
        },
      }),
    );
    if (!restricted) throw new Error("Restricted principal absent");
    expect(await composition.remoteDelegation(restricted, f.project.projectId)).toHaveProperty(
      "grantRevision",
      1,
    );
    const changed = await composition.dispatch(
      new Request(`${connect.origin}/v1/projects/${f.project.projectId}/handle`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "delegated-rename",
          "if-match": etag,
        },
        body: JSON.stringify({ handle: "calm-portal-authority" }),
      }),
      restricted,
    );
    expect(changed.status, await changed.clone().text()).toBe(202);
    const accepted = (await changed.json()) as { id: string };
    const evidence = await control.core
      .prepare(
        "SELECT authorization_action,authorization_restriction FROM operation_mcp_delegations WHERE operation_id=?",
      )
      .bind(accepted.id)
      .first<{ authorization_action: string; authorization_restriction: string }>();
    expect(evidence?.authorization_action).toBe("projects:write");
    expect(JSON.parse(evidence?.authorization_restriction ?? "null")).toEqual({
      actions: ["projects:write"],
      projectIds: [f.project.projectId],
    });
    const execution = {
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      operationId: accepted.id,
    };
    await expect(f.persistence.authorizeExecution(execution)).resolves.toBeUndefined();
    await control.core
      .prepare(
        "INSERT INTO workos_membership_sync_barriers(organization_id,workos_user_id,source_event_id,event_created_at,reconciled_at) VALUES(?1,?2,'queued-membership','2026-11-04T10:00:00.000000Z',NULL)",
      )
      .bind(f.organizationId, f.userId)
      .run();
    await expect(f.persistence.authorizeExecution(execution)).rejects.toThrow();
    await control.core
      .prepare(
        "UPDATE workos_membership_sync_barriers SET reconciled_at='2026-11-04T10:00:01.000000Z' WHERE organization_id=?1 AND workos_user_id=?2",
      )
      .bind(f.organizationId, f.userId)
      .run();
    await expect(f.persistence.authorizeExecution(execution)).resolves.toBeUndefined();
    await composition.access.revoke(restricted);
    expect((await revokeMail(mailDomainId)).status).toBe(404);
    expect(revokeMailAuthorization).toHaveBeenCalledOnce();
    await expect(
      f.persistence.authorizeExecution({
        organizationId: f.project.organizationId,
        projectId: f.project.projectId,
        operationId: accepted.id,
      }),
    ).rejects.toThrow();
  } finally {
    await control.dispose();
  }
}, 120000);
