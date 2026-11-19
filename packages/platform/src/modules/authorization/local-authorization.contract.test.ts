import { describe, expect, it, vi } from "vitest";

import { intersectAuthorizationRestriction } from "./authorization.js";

import {
  AUTHORIZATION_ACTIONS,
  createLocalAuthorizationPort,
  mapWorkosRolesToLocalRole,
  restrictionAllows,
  parseUlid,
  type AuthorizationAction,
  type AuthorizationCheck,
  type LocalAuthorizationGrant,
  type LocalAuthorizationGrantReader,
} from "../../index.js";

const organizationId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const otherOrganizationId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const projectId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const billingEpochId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const environmentId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const mailDomainId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const principal = { kind: "user", subjectId: "user:user_01" } as const;

const projectCheck = (action: AuthorizationAction): AuthorizationCheck => ({
  principal,
  resource: { kind: "project", organizationId, projectId },
  action,
});

const grant = (overrides: Partial<LocalAuthorizationGrant> = {}): LocalAuthorizationGrant => ({
  grantId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
  principal,
  resource: { kind: "project", organizationId, projectId },
  role: "owner",
  createdAt: "2026-08-19T10:00:00.000Z",
  revokedAt: null,
  projectScope: {
    ownershipVersion: 1,
    billingEpochId,
    state: "active",
  },
  ...overrides,
});

const readerReturning = (value: LocalAuthorizationGrant | null): LocalAuthorizationGrantReader => ({
  findGrant: vi.fn().mockResolvedValue(value),
});

describe("local authorization policy", () => {
  it("limits integration management to owners and respects project credential ceilings", async () => {
    const organization = { kind: "organization" as const, organizationId };
    const environment = { kind: "project" as const, organizationId, projectId, environmentId };
    for (const resource of [organization, environment]) {
      const projectScope = resource.kind === "project" ? grant().projectScope : null;
      const owner = createLocalAuthorizationPort(
        readerReturning(grant({ resource, projectScope })),
      );
      const member = createLocalAuthorizationPort(
        readerReturning(grant({ resource, projectScope, role: "member" })),
      );
      await expect(
        owner.check({ principal, resource, action: "integrations:manage" }),
      ).resolves.toBe("allow");
      await expect(
        member.check({ principal, resource, action: "integrations:manage" }),
      ).resolves.toBe("deny");
      await expect(
        member.check({ principal, resource, action: "integrations:read" }),
      ).resolves.toBe("allow");
    }
    expect(
      restrictionAllows({ projectIds: [projectId] }, organization, "integrations:manage"),
    ).toBe(false);
    expect(restrictionAllows({ projectIds: [projectId] }, organization, "integrations:read")).toBe(
      false,
    );
    expect(
      restrictionAllows({ actions: ["integrations:read"] }, environment, "integrations:manage"),
    ).toBe(false);
    expect(restrictionAllows({ projectIds: [projectId] }, environment, "integrations:manage")).toBe(
      true,
    );
    const owner = createLocalAuthorizationPort(readerReturning(grant()));
    await expect(owner.check(projectCheck("integrations:manage"))).resolves.toBe("deny");
  });

  it("requires an Owner and an exact environment for Native Auth, independent of secret grants", async () => {
    const resource = { kind: "project" as const, organizationId, projectId, environmentId };
    const owner = createLocalAuthorizationPort(readerReturning(grant({ resource })));
    const member = createLocalAuthorizationPort(
      readerReturning(grant({ role: "member", resource })),
    );
    for (const action of ["auth:read", "auth:manage"] as const) {
      await expect(owner.check({ principal, resource, action })).resolves.toBe("allow");
      await expect(member.check({ principal, resource, action })).resolves.toBe("deny");
      await expect(owner.check(projectCheck(action))).resolves.toBe("deny");
      expect(restrictionAllows({ actions: ["secrets:write"] }, resource, action)).toBe(false);
      expect(restrictionAllows({ actions: [action] }, resource, action)).toBe(true);
    }
  });

  it("intersects independent credential action ceilings while retaining tenant resource limits", async () => {
    const scope = ["projects:read", "projects:write", "mail-domains:read", "unknown:action"];
    const accepted = intersectAuthorizationRestriction(
      {
        actions: ["projects:read", "mail-domains:read", "deployments:create"],
        organizationIds: [organizationId],
        projectIds: [projectId],
        mailDomainIds: [mailDomainId],
      },
      scope,
    );
    expect(accepted).toEqual({
      actions: ["projects:read", "mail-domains:read"],
      organizationIds: [organizationId],
      projectIds: [projectId],
      mailDomainIds: [mailDomainId],
    });
    scope.push("deployments:create");
    const project = { kind: "project" as const, organizationId, projectId };
    const domain = { kind: "mail_domain" as const, organizationId, mailDomainId };
    const owner = createLocalAuthorizationPort(readerReturning(grant({ resource: project })));
    await expect(
      owner.check({ principal, resource: project, action: "projects:write" }),
    ).resolves.toBe("allow");
    expect(restrictionAllows(accepted, project, "projects:read")).toBe(true);
    expect(restrictionAllows(accepted, project, "projects:write")).toBe(false);
    expect(restrictionAllows(accepted, project, "deployments:create")).toBe(false);
    expect(
      restrictionAllows(accepted, { ...project, projectId: environmentId }, "projects:read"),
    ).toBe(false);
    expect(
      restrictionAllows(
        accepted,
        { ...project, organizationId: otherOrganizationId },
        "projects:read",
      ),
    ).toBe(false);
    expect(restrictionAllows(accepted, domain, "mail-domains:read")).toBe(true);
    expect(
      restrictionAllows(accepted, { ...domain, mailDomainId: environmentId }, "mail-domains:read"),
    ).toBe(false);
  });

  it("distinguishes absent action scope from an explicit empty ceiling and cannot widen a read-only ceiling", () => {
    const project = { kind: "project" as const, organizationId, projectId };
    const readOnly = { actions: ["projects:read"] as const, projectIds: [projectId] };
    const broaderToken = intersectAuthorizationRestriction(readOnly, [
      "projects:read",
      "projects:write",
    ]);
    expect(broaderToken).toEqual(readOnly);
    expect(restrictionAllows(broaderToken, project, "projects:read")).toBe(true);
    expect(restrictionAllows(broaderToken, project, "projects:write")).toBe(false);
    expect(
      restrictionAllows(
        intersectAuthorizationRestriction(undefined, undefined),
        project,
        "projects:write",
      ),
    ).toBe(true);
    expect(
      restrictionAllows(intersectAuthorizationRestriction(undefined, []), project, "projects:read"),
    ).toBe(false);
    expect(
      restrictionAllows(
        intersectAuthorizationRestriction({ actions: [] }, ["projects:read"]),
        project,
        "projects:read",
      ),
    ).toBe(false);
  });
  it("keeps environment-secret metadata and mutations owner-only", async () => {
    expect(AUTHORIZATION_ACTIONS).toEqual(
      expect.arrayContaining(["secrets:read", "secrets:write", "secrets:delete"]),
    );
    const resource = { kind: "project" as const, organizationId, projectId, environmentId };
    const owner = createLocalAuthorizationPort(readerReturning(grant({ resource })));
    const member = createLocalAuthorizationPort(
      readerReturning(grant({ role: "member", resource })),
    );
    for (const action of ["secrets:read", "secrets:write", "secrets:delete"] as const) {
      await expect(owner.check({ principal, resource, action })).resolves.toBe("allow");
      await expect(member.check({ principal, resource, action })).resolves.toBe("deny");
    }
    await expect(owner.check(projectCheck("secrets:read"))).resolves.toBe("deny");
  });

  it("keeps the public action vocabulary closed and lets an owner perform every compatible action", async () => {
    for (const action of AUTHORIZATION_ACTIONS) {
      const organizationScoped =
        action === "api-keys:manage" ||
        action === "projects:create" ||
        action === "credits:read" ||
        action === "billing:manage";
      const environmentScoped =
        action.startsWith("secrets:") ||
        action.startsWith("auth:") ||
        action.startsWith("integrations:");
      const mailDomainScoped = action.startsWith("mail-domains:");
      const resource = mailDomainScoped
        ? { kind: "mail_domain" as const, organizationId, mailDomainId }
        : organizationScoped
          ? { kind: "organization" as const, organizationId }
          : {
              kind: "project" as const,
              organizationId,
              projectId,
              ...(environmentScoped ? { environmentId } : {}),
            };
      const candidate = grant({
        resource,
        projectScope:
          organizationScoped || mailDomainScoped
            ? null
            : { ownershipVersion: 1, billingEpochId, state: "active" },
      });
      await expect(
        createLocalAuthorizationPort(readerReturning(candidate)).check({
          principal,
          resource,
          action,
        }),
      ).resolves.toBe("allow");
    }
  });

  it("denies incompatible action and resource combinations before reading a grant", async () => {
    const reader = readerReturning(grant());
    const port = createLocalAuthorizationPort(reader);

    await expect(
      port.check({
        principal,
        resource: { kind: "organization", organizationId },
        action: "deployments:create",
      }),
    ).resolves.toBe("deny");
    await expect(port.check(projectCheck("projects:create"))).resolves.toBe("deny");
    expect(reader.findGrant).not.toHaveBeenCalled();
  });

  it("allows audit reads at organization and project scope", async () => {
    const organizationResource = { kind: "organization" as const, organizationId };
    const organizationGrant = grant({ resource: organizationResource, projectScope: null });
    await expect(
      createLocalAuthorizationPort(readerReturning(organizationGrant)).check({
        principal,
        resource: organizationResource,
        action: "audit:read",
      }),
    ).resolves.toBe("allow");
    await expect(
      createLocalAuthorizationPort(readerReturning(grant())).check(projectCheck("audit:read")),
    ).resolves.toBe("allow");
  });

  it("allows project discovery at organization scope without widening mutations", async () => {
    const resource = { kind: "organization" as const, organizationId };
    for (const role of ["owner", "member"] as const) {
      const organizationGrant = grant({ resource, role, projectScope: null });
      await expect(
        createLocalAuthorizationPort(readerReturning(organizationGrant)).check({
          principal,
          resource,
          action: "projects:read",
        }),
      ).resolves.toBe("allow");
    }
    await expect(
      createLocalAuthorizationPort(
        readerReturning(
          grant({
            resource: { kind: "organization", organizationId: otherOrganizationId },
            projectScope: null,
          }),
        ),
      ).check({ principal, resource, action: "projects:read" }),
    ).resolves.toBe("deny");
  });

  it("lets a member read but denies every mutation", async () => {
    const port = createLocalAuthorizationPort(readerReturning(grant({ role: "member" })));

    await expect(port.check(projectCheck("projects:read"))).resolves.toBe("allow");
    await expect(port.check(projectCheck("operations:read"))).resolves.toBe("allow");
    await expect(port.check(projectCheck("operations:reconcile"))).resolves.toBe("deny");
    await expect(port.check(projectCheck("deployments:create"))).resolves.toBe("deny");
    await expect(port.check(projectCheck("projects:dev-access"))).resolves.toBe("deny");
    await expect(port.check(projectCheck("projects:rollback"))).resolves.toBe("deny");
    await expect(port.check(projectCheck("projects:delete"))).resolves.toBe("deny");
  });

  it("denies a cross-organization or cross-resource grant even if a reader returns it", async () => {
    const crossOrganization = grant({
      resource: { kind: "project", organizationId: otherOrganizationId, projectId },
    });
    const port = createLocalAuthorizationPort(readerReturning(crossOrganization));

    await expect(port.check(projectCheck("projects:read"))).resolves.toBe("deny");
  });

  it("denies revoked, stale-ownership, frozen-transfer, and malformed-role grants", async () => {
    const cases: readonly LocalAuthorizationGrant[] = [
      grant({ revokedAt: "2026-08-19T10:01:00.000Z" }),
      grant({ projectScope: null }),
      grant({
        projectScope: { ownershipVersion: 2, billingEpochId, state: "transfer_pending_frozen" },
      }),
      grant({ role: "admin" as never }),
    ];

    for (const candidate of cases) {
      await expect(
        createLocalAuthorizationPort(readerReturning(candidate)).check(
          projectCheck("deployments:create"),
        ),
      ).resolves.toBe("deny");
    }
  });

  it("denies API keys and M2M services before consulting user grants", async () => {
    const reader = readerReturning(grant());
    const port = createLocalAuthorizationPort(reader);

    await expect(
      port.check({
        ...projectCheck("projects:read"),
        principal: { kind: "organization_api_key", subjectId: "api_key:key_01" },
      }),
    ).resolves.toBe("deny");
    await expect(
      port.check({
        ...projectCheck("projects:read"),
        principal: { kind: "m2m_service", subjectId: "service:service_01" },
      }),
    ).resolves.toBe("deny");
    expect(reader.findGrant).not.toHaveBeenCalled();
  });

  it("propagates a database outage so the HTTP boundary can return unavailable", async () => {
    const failure = new Error("database unavailable");
    const port = createLocalAuthorizationPort({ findGrant: vi.fn().mockRejectedValue(failure) });

    await expect(port.check(projectCheck("projects:read"))).rejects.toBe(failure);
  });

  it("maps one supported WorkOS role and rejects ambiguity or unknown roles", () => {
    expect(mapWorkosRolesToLocalRole(["admin"])).toBe("owner");
    expect(mapWorkosRolesToLocalRole(["member"])).toBe("member");
    expect(mapWorkosRolesToLocalRole(["admin", "member"])).toBeNull();
    expect(mapWorkosRolesToLocalRole([])).toBeNull();
    expect(mapWorkosRolesToLocalRole(["viewer"])).toBeNull();
  });
});
