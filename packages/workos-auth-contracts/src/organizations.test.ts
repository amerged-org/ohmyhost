import { describe, expect, it } from "vitest";

import {
  canonicalizeWorkosOrganizationSnapshot,
  parseWorkosManagementRpcRequest,
  parseWorkosManagementRpcResponse,
  parseWorkosOrganizationSnapshot,
} from "./index.js";

const organization = {
  id: "org_1",
  name: "Acme",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};
const membership = (id: string, userId: string, roles: string[]) => ({
  id,
  user_id: userId,
  organization_id: "org_1",
  status: "active",
  roles: roles.map((slug) => ({ slug })),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
});

describe("WorkOS organization synchronization contracts", () => {
  it("canonicalizes current snapshots independently of list order and duplicate roles", () => {
    const fetchedAt = new Date("2026-08-18T10:00:00Z");
    const first = parseWorkosOrganizationSnapshot(
      {
        organization,
        memberships: [
          membership("om_2", "user_2", ["member"]),
          membership("om_1", "user_1", ["admin", "admin"]),
        ],
      },
      fetchedAt,
    );
    const second = parseWorkosOrganizationSnapshot(
      {
        organization,
        memberships: [
          membership("om_1", "user_1", ["admin"]),
          membership("om_2", "user_2", ["member"]),
        ],
      },
      new Date("2026-08-18T10:01:00Z"),
    );
    expect(canonicalizeWorkosOrganizationSnapshot(first)).toBe(
      canonicalizeWorkosOrganizationSnapshot(second),
    );
    expect(first.memberships[0]?.roles).toEqual(["admin"]);
  });

  it("fails closed when a membership has multiple distinct roles", () => {
    expect(() =>
      parseWorkosOrganizationSnapshot(
        {
          organization,
          memberships: [membership("om_1", "user_1", ["viewer", "admin", "admin"])],
        },
        new Date("2026-08-18T10:00:00Z"),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "unsupported_multiple_roles",
        message: "Membership has unsupported multiple roles",
      }),
    );
  });

  it("allowlists management RPC operations and fields", () => {
    expect(
      parseWorkosManagementRpcRequest({
        method: "organizations.get_current_snapshot",
        requestId: "request_1",
        payload: { workosOrganizationId: "org_1" },
      }),
    ).toEqual({
      method: "organizations.get_current_snapshot",
      requestId: "request_1",
      payload: { workosOrganizationId: "org_1" },
    });
    expect(() =>
      parseWorkosManagementRpcRequest({
        method: "fga.check_candidate",
        requestId: "request_1",
        payload: {
          principal: { kind: "user", id: "user:user_1", authenticationMethod: "interactive" },
          organizationId: "org_1",
          resource: { type: "project", id: "project_1" },
          action: "read",
          context: { arbitrary: "must-be-rejected" },
        },
      }),
    ).toThrowError(/field is not allowed/u);
    expect(() =>
      parseWorkosManagementRpcRequest({
        method: "secrets.read",
        requestId: "request_1",
        payload: {},
      }),
    ).toThrowError(/not allowed/u);

    const principals = [
      { kind: "user", id: "user:user_1", authenticationMethod: "interactive" },
      { kind: "user", id: "user:user_1", authenticationMethod: "device_flow" },
      { kind: "organization_api_key", id: "api_key:key_1" },
      { kind: "m2m_service", id: "service:client_1" },
    ] as const;
    const parsedPrincipals = principals.map((principal, index) => {
      const request = parseWorkosManagementRpcRequest({
        method: "fga.check_candidate",
        requestId: `request_${index}`,
        payload: {
          principal,
          organizationId: "org_1",
          resource: { type: "project", id: "project_1" },
          action: "project.read",
        },
      });
      if (request.method !== "fga.check_candidate") throw new Error("Unexpected RPC method");
      return request.payload.principal;
    });
    expect(parsedPrincipals).toEqual(principals);
    expect(parsedPrincipals[0]).toMatchObject({ kind: "user", id: "user:user_1" });
    expect(parsedPrincipals[1]).toMatchObject({ kind: "user", id: "user:user_1" });
    expect(() =>
      parseWorkosManagementRpcRequest({
        method: "fga.check_candidate",
        requestId: "request_bad_principal",
        payload: {
          principal: { kind: "user", id: "user_1", authenticationMethod: "interactive" },
          organizationId: "org_1",
          resource: { type: "project", id: "project_1" },
          action: "project.read",
        },
      }),
    ).toThrowError(/not canonical/u);
    expect(() =>
      parseWorkosManagementRpcRequest({
        method: "fga.check_candidate",
        requestId: "request_bad_resource",
        payload: {
          principal: { kind: "organization_api_key", id: "api_key:key_1" },
          organizationId: "org_1",
          resource: { type: "secret", id: "secret_1" },
          action: "secrets.read_all",
        },
      }),
    ).toThrowError(/resource type is invalid/u);
    expect(() =>
      parseWorkosManagementRpcRequest({
        method: "fga.check_candidate",
        requestId: "request_bad_action",
        payload: {
          principal: { kind: "m2m_service", id: "service:client_1" },
          organizationId: "org_1",
          resource: { type: "project", id: "project_1" },
          action: "secrets.read_all",
        },
      }),
    ).toThrowError(/action is invalid/u);

    expect(
      parseWorkosManagementRpcResponse({
        method: "fga.check_candidate",
        requestId: "request_1",
        ok: true,
        result: { decision: "deny" },
      }),
    ).toEqual({
      method: "fga.check_candidate",
      requestId: "request_1",
      ok: true,
      result: { decision: "deny" },
    });
    expect(() =>
      parseWorkosManagementRpcResponse({
        method: "fga.check_candidate",
        requestId: "request_1",
        ok: true,
        result: { decision: "maybe" },
      }),
    ).toThrowError(/decision is invalid/u);

    const snapshot = parseWorkosOrganizationSnapshot(
      { organization, memberships: [membership("om_1", "user_1", ["member"])] },
      new Date("2026-08-18T10:00:00Z"),
    );
    expect(
      parseWorkosManagementRpcResponse({
        method: "organizations.get_current_snapshot",
        requestId: "request_2",
        ok: true,
        result: {
          snapshot: {
            ...snapshot,
            memberships: snapshot.memberships.map((item) => ({
              ...item,
              roles: ["member", "member"],
            })),
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      result: {
        snapshot: {
          fetchedAt: snapshot.fetchedAt,
          memberships: [{ roles: ["member"] }],
        },
      },
    });
    expect(() =>
      parseWorkosManagementRpcResponse({
        method: "organizations.get_current_snapshot",
        requestId: "request_multiple_roles",
        ok: true,
        result: {
          snapshot: {
            ...snapshot,
            memberships: snapshot.memberships.map((item) => ({
              ...item,
              roles: ["member", "admin"],
            })),
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_multiple_roles" }));
    expect(
      parseWorkosManagementRpcResponse({
        method: "organizations.get_current_snapshot",
        requestId: "request_3",
        ok: false,
        error: { code: "unavailable" },
      }),
    ).toEqual({
      method: "organizations.get_current_snapshot",
      requestId: "request_3",
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("allowlists the sanitized read-only capability probe contract", () => {
    expect(
      parseWorkosManagementRpcRequest({
        method: "capabilities.probe_read_only",
        requestId: "request_capabilities",
        payload: {},
      }),
    ).toEqual({
      method: "capabilities.probe_read_only",
      requestId: "request_capabilities",
      payload: {},
    });
    expect(() =>
      parseWorkosManagementRpcRequest({
        method: "capabilities.probe_read_only",
        requestId: "request_capabilities",
        payload: { provider: "workos" },
      }),
    ).toThrowError(/field is not allowed/u);

    expect(
      parseWorkosManagementRpcResponse({
        method: "capabilities.probe_read_only",
        requestId: "request_capabilities",
        ok: true,
        result: {
          observations: [
            { id: "organizations_read", available: true, statusCode: 200, count: 2 },
            { id: "webhook_endpoints_read", available: false, statusCode: 403 },
          ],
        },
      }),
    ).toEqual({
      method: "capabilities.probe_read_only",
      requestId: "request_capabilities",
      ok: true,
      result: {
        observations: [
          { id: "organizations_read", available: true, statusCode: 200, count: 2 },
          { id: "webhook_endpoints_read", available: false, statusCode: 403 },
        ],
      },
    });

    const invalidResults = [
      {
        observations: [{ id: "secrets_read", available: true, statusCode: 200 }],
      },
      {
        observations: [{ id: "organizations_read", available: true, statusCode: 99 }],
      },
      {
        observations: [{ id: "organizations_read", available: true, statusCode: 600 }],
      },
      {
        observations: [{ id: "organizations_read", available: true, statusCode: 200, count: -1 }],
      },
      {
        observations: [
          {
            id: "organizations_read",
            available: true,
            statusCode: 200,
            url: "https://api.workos.com/organizations",
          },
        ],
      },
      {
        observations: [
          {
            id: "organizations_read",
            available: true,
            statusCode: 200,
            headers: { authorization: "Bearer secret" },
          },
        ],
      },
      {
        observations: [
          {
            id: "organizations_read",
            available: false,
            statusCode: 500,
            message: "provider response",
          },
        ],
      },
      {
        provider: { name: "workos" },
        observations: [{ id: "organizations_read", available: true, statusCode: 200 }],
      },
    ];
    for (const result of invalidResults) {
      expect(() =>
        parseWorkosManagementRpcResponse({
          method: "capabilities.probe_read_only",
          requestId: "request_capabilities",
          ok: true,
          result,
        }),
      ).toThrowError();
    }
  });
});
