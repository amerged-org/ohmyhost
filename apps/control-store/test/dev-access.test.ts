import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { bucketOf } from "../src/router.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const digest = (n: number) => n.toString(16).padStart(64, "0");
const seal = (n: number) => ({
  ciphertext: "ab".repeat(20),
  nonce: "cd".repeat(12),
  valueSha256: digest(n),
  keyVersion: 1,
});

describe("devAccess", () => {
  it("issues single-use tickets, serves share links by generation and stores each request's response once", async () => {
    const store = createControlStore(control.bindings),
      { project, origin, principalId } = await seedDevAccessProject(control),
      scope = { organizationId: project.organizationId, projectId: project.projectId };
    const page = {
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      handle: project.handle,
      origin,
    };

    // Ticket: issuing bumps the epoch, a replay answers the same ticket, a stranger gets nothing.
    const ticketId = newUlid();
    const issue = {
      ...scope,
      principalId,
      ticketId,
      tokenSha256: digest(11),
      issuedAt: "2026-10-29T10:00:00.000Z",
      expiresAt: "2026-10-29T11:00:00.000Z",
    };
    const issued = await store.devAccess.issueDevAccessTicket(issue);
    expect(issued).toMatchObject({
      ticketId,
      origin,
      devAccessEpoch: 2,
      expiresAt: issue.expiresAt,
    });
    expect(await store.devAccess.issueDevAccessTicket(issue)).toEqual(issued);
    expect(
      await store.devAccess.issueDevAccessTicket({
        ...issue,
        ticketId: newUlid(),
        principalId: "user:stranger",
      }),
    ).toBeNull();
    expect(
      await store.devAccess.authorizeDevAccessSession({ ...page, devAccessEpoch: 2, principalId }),
    ).toBe(true);
    expect(
      await store.devAccess.authorizeDevAccessSession({ ...page, devAccessEpoch: 1, principalId }),
    ).toBe(false);
    const combined = {
      ...page,
      organizationHint: project.organizationId,
      shareSession: false,
      epoch: 2,
      principalId,
      devAccessEpoch: 2,
    };
    expect(await store.devAccess.authorizeDevCombined(combined)).toBe(true);
    expect(
      await store.devAccess.authorizeDevCombined({ ...combined, organizationHint: undefined }),
    ).toBe(true);
    expect(
      await store.devAccess.authorizeDevCombined({ ...combined, principalId: "user:stranger" }),
    ).toBe(false);
    expect(await store.devAccess.authorizeDevCombined({ ...combined, devAccessEpoch: 1 })).toBe(
      false,
    );
    await expect(
      store.devAccess.authorizeDevCombined({ ...combined, organizationHint: newUlid() }),
    ).rejects.toThrow("dev_access_unavailable");
    await expect(
      store.devAccess.authorizeDevCombined({ ...combined, organizationHint: "bad" }),
    ).rejects.toThrow();
    const redeem = {
      ...page,
      shareTokenSha256: digest(99),
      ticketTokenSha256: digest(11),
      consumedAt: "2026-10-29T10:05:00.000Z",
    };
    expect(await store.devAccess.redeemDevAccess(redeem)).toMatchObject({
      kind: "ticket",
      subjectId: principalId,
      scope: { devAccessEpoch: 2 },
    });
    expect(await store.devAccess.redeemDevAccess(redeem)).toBeNull();

    // Share link: absent at first, saved with generation 1, replaced by a rotation exactly once per key.
    const first = await store.devAccess.readDevShareState({ ...scope, principalId });
    expect(first).toMatchObject({ mode: "protected", link: null, generation: null });
    const epoch = (first as { scope: { devAccessEpoch: number } }).scope.devAccessEpoch;
    await store.devAccess.changeDevAccess({
      ...scope,
      principalId,
      now: "2026-10-29T10:10:00.000Z",
      expected: { mode: "protected", generation: null, linkValueSha256: null, epoch },
      link: { action: "save", ...seal(21) },
      bumpEpoch: false,
    });
    expect(
      await store.devAccess.redeemDevAccess({ ...redeem, shareTokenSha256: digest(21) }),
    ).toMatchObject({
      kind: "share",
      scope: { devAccessEpoch: 1 },
    });
    expect(await store.devAccess.authorizeDevPage({ ...page, shareSession: true, epoch: 1 })).toBe(
      true,
    );
    expect(
      await store.devAccess.authorizeDevCombined({
        ...page,
        organizationHint: project.organizationId,
        shareSession: true,
        epoch: 1,
        principalId: null,
        devAccessEpoch: null,
      }),
    ).toBe(true);
    expect(
      await store.devAccess.authorizeDevPage({ ...page, shareSession: false, epoch: null }),
    ).toBe(false);
    const share = {
      ...page,
      organizationHint: project.organizationId,
      shareSession: true,
      epoch: 1,
      principalId: null,
      devAccessEpoch: null,
    };
    await control.core
      .prepare(
        "UPDATE organization_memberships SET revoked_at='2026-10-29T10:00:00.000000Z' WHERE organization_id=?1",
      )
      .bind(project.organizationId)
      .run();
    expect(await store.devAccess.authorizeDevCombined(combined)).toBe(false);
    expect(await store.devAccess.authorizeDevCombined(share)).toBe(true);
    await control.core
      .prepare("UPDATE organization_memberships SET revoked_at=NULL WHERE organization_id=?1")
      .bind(project.organizationId)
      .run();
    await control.core
      .prepare(
        "UPDATE local_authorization_grants SET revoked_at='2026-10-29T10:00:00.000000Z' WHERE organization_id=?1",
      )
      .bind(project.organizationId)
      .run();
    expect(await store.devAccess.authorizeDevCombined(combined)).toBe(false);
    expect(await store.devAccess.authorizeDevCombined(share)).toBe(true);
    await control.core
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner','2026-10-29T10:00:00.000000Z')",
      )
      .bind(project.organizationId, newUlid(), principalId)
      .run();
    const bucket = await bucketOf(project.organizationId);
    await control.core
      .prepare(
        "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?1,'moved',?2,'2026-10-29T10:00:00.000000Z')",
      )
      .bind(bucket, newUlid())
      .run();
    try {
      await expect(store.devAccess.authorizeDevCombined(combined)).rejects.toThrow();
    } finally {
      await control.core.prepare("DELETE FROM bucket_fences WHERE bucket=?1").bind(bucket).run();
    }
    const rotate = {
      ...scope,
      principalId,
      now: "2026-10-29T10:20:00.000Z",
      expected: { mode: "protected" as const, generation: 1, linkValueSha256: digest(21), epoch },
      link: { action: "save" as const, ...seal(22) },
      bumpEpoch: true,
      rotationKeySha256: digest(31),
    };
    expect(await store.devAccess.changeDevAccess(rotate)).toMatchObject({
      generation: 2,
      epoch: epoch + 1,
    });
    expect(await store.devAccess.changeDevAccess(rotate)).toEqual({
      replayed: "rotation",
      generation: 2,
    });
    expect(await store.devAccess.authorizeDevPage({ ...page, shareSession: true, epoch: 1 })).toBe(
      false,
    );
    expect(await store.devAccess.authorizeDevPage({ ...page, shareSession: true, epoch: 2 })).toBe(
      true,
    );
    // A stale decision is refused so the caller decides again.
    await expect(
      store.devAccess.changeDevAccess({ ...rotate, rotationKeySha256: digest(32) }),
    ).rejects.toMatchObject({ code: "dev_access_state_changed" });

    // Public mode revokes the link; the response of its request is stored once and replays for the same key only.
    const request = {
      ...scope,
      principalId,
      now: "2026-10-29T10:30:00.000Z",
      expected: {
        mode: "protected" as const,
        generation: 2,
        linkValueSha256: digest(22),
        epoch: epoch + 1,
      },
      mode: "public" as const,
      link: { action: "revoke" as const },
      bumpEpoch: true,
      receipt: { keySha256: digest(41), requestSha256: digest(42), response: seal(43) },
    };
    expect(await store.devAccess.changeDevAccess(request)).toMatchObject({ replayed: null });
    expect(
      await store.devAccess.authorizeDevPage({ ...page, shareSession: false, epoch: null }),
    ).toBe(true);
    expect(
      await store.devAccess.authorizeDevCombined({
        ...page,
        organizationHint: project.organizationId,
        shareSession: false,
        epoch: null,
        principalId: null,
        devAccessEpoch: null,
      }),
    ).toBe(true);
    expect(await store.devAccess.changeDevAccess(request)).toEqual({
      replayed: "request",
      response: seal(43),
    });
    await expect(
      store.devAccess.changeDevAccess({
        ...request,
        receipt: { ...request.receipt, requestSha256: digest(44) },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(
      await store.devAccess.readDevShareState({
        ...scope,
        principalId,
        requestKeySha256: digest(41),
      }),
    ).toMatchObject({
      mode: "public",
      link: null,
      generation: 2,
      request: { requestSha256: digest(42), response: seal(43) },
    });

    // Without a deployment the platform may not probe the dev origin (and every table and column of the check resolves).
    expect(
      await store.devAccess.authorizeDevRuntimeProbe({
        ...scope,
        environmentId: project.devEnvironmentId,
        operationId: newUlid(),
        deploymentId: newUlid(),
        handle: project.handle,
        origin,
        path: "/healthz",
        method: "GET",
      }),
    ).toBe(false);
  });

  it("refuses an issued ticket, a share state and a new ticket once its issuer has a terminal user revocation", async () => {
    // A user revocation is global, so this test owns its Core.
    const own = await createTestControl(),
      store = createControlStore(own.bindings),
      { project, origin, principalId } = await seedDevAccessProject(own),
      scope = { organizationId: project.organizationId, projectId: project.projectId },
      page = {
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
        handle: project.handle,
        origin,
      },
      issue = {
        ...scope,
        principalId,
        ticketId: newUlid(),
        tokenSha256: digest(31),
        issuedAt: "2026-10-29T10:00:00.000Z",
        expiresAt: "2026-10-29T11:00:00.000Z",
      };
    expect(await store.devAccess.issueDevAccessTicket(issue)).not.toBeNull();
    // WorkOS deletes the user: a revocation row is the only thing that is written, no membership changes.
    await store.identity.recordTerminalRevocation({
      kind: "user",
      workosUserId: principalId.slice("user:".length),
      sourceEventId: "evt_user_deleted",
      effectiveAt: "2026-10-29T10:02:00.000Z",
    });
    expect(
      await store.devAccess.redeemDevAccess({
        ...page,
        shareTokenSha256: digest(98),
        ticketTokenSha256: digest(31),
        consumedAt: "2026-10-29T10:05:00.000Z",
      }),
    ).toBeNull();
    expect(await store.devAccess.readDevShareState({ ...scope, principalId })).toBeNull();
    expect(
      await store.devAccess.issueDevAccessTicket({
        ...issue,
        ticketId: newUlid(),
        tokenSha256: digest(32),
      }),
    ).toBeNull();
    await own.dispose();
  });

  it("ends an issued ticket and the Dev session of a member whose removal or barrier is recorded", async () => {
    for (const removal of ["snapshot", "barrier"] as const) {
      const own = await createTestControl(),
        store = createControlStore(own.bindings),
        { project, origin, principalId } = await seedDevAccessProject(own),
        scope = { organizationId: project.organizationId, projectId: project.projectId },
        page = {
          projectId: project.projectId,
          environmentId: project.devEnvironmentId,
          handle: project.handle,
          origin,
        },
        ticket = {
          ...scope,
          principalId,
          ticketId: newUlid(),
          tokenSha256: digest(61),
          issuedAt: "2026-10-29T10:00:00.000Z",
          expiresAt: "2026-10-29T11:00:00.000Z",
        },
        combined = {
          ...page,
          organizationHint: project.organizationId,
          shareSession: false,
          epoch: 2,
          principalId,
          devAccessEpoch: 2,
        };
      expect(await store.devAccess.issueDevAccessTicket(ticket)).not.toBeNull();
      expect(
        await store.devAccess.authorizeDevAccessSession({
          ...page,
          devAccessEpoch: 2,
          principalId,
        }),
      ).toBe(true);
      if (removal === "snapshot") {
        const organization = (
          await own.core
            .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?1")
            .bind(project.organizationId)
            .first<{ workos_organization_id: string }>()
        )?.workos_organization_id;
        // WorkOS no longer lists the admin: the organization snapshot revokes the membership.
        await store.identity.applyOrganizationSnapshot({
          organizationId: project.organizationId,
          workosOrganizationId: organization as string,
          state: "active",
          snapshotDigest: digest(77),
          snapshotFetchedAt: "2026-10-29T10:03:00.000Z",
          synchronizedAt: "2026-10-29T10:03:00.500Z",
          triggerEventId: "evt_admin_removed",
          memberships: [],
          auditEventId: newUlid(),
        });
      } else {
        const organization = (
          await own.core
            .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?1")
            .bind(project.organizationId)
            .first<{ workos_organization_id: string }>()
        )?.workos_organization_id;
        // WorkOS reports the removal; the barrier closes access until the next snapshot reconciles it.
        await store.identity.recordMembershipBarrier({
          workosOrganizationId: organization as string,
          workosUserId: "user_dev",
          sourceEventId: newUlid(),
          eventCreatedAt: "2026-10-29T10:03:00.000Z",
        });
      }
      expect(
        await store.devAccess.authorizeDevAccessSession({
          ...page,
          devAccessEpoch: 2,
          principalId,
        }),
      ).toBe(false);
      expect(await store.devAccess.authorizeDevCombined(combined)).toBe(false);
      expect(
        await store.devAccess.redeemDevAccess({
          ...page,
          shareTokenSha256: digest(97),
          ticketTokenSha256: digest(61),
          consumedAt: "2026-10-29T10:05:00.000Z",
        }),
      ).toBeNull();
      expect(
        await store.devAccess.issueDevAccessTicket({
          ...ticket,
          ticketId: newUlid(),
          tokenSha256: digest(62),
        }),
      ).toBeNull();
      await own.dispose();
    }
  }, 60_000);

  it("answers an issued ticket whose reply was lost from the committed row and never issues a second one", async () => {
    const { project, principalId } = await seedDevAccessProject(control),
      issue = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        principalId,
        ticketId: newUlid(),
        tokenSha256: digest(51),
        issuedAt: "2026-10-29T10:00:00.000Z",
        expiresAt: "2026-10-29T11:00:00.000Z",
      };
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    const issued = await flaky.devAccess.issueDevAccessTicket(issue);
    expect(issued).toMatchObject({ ticketId: issue.ticketId, principalId, devAccessEpoch: 2 });
    expect(
      await createControlStore(control.bindings).devAccess.issueDevAccessTicket(issue),
    ).toEqual(issued);
  });
});
