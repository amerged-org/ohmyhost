import { describe, expect, expectTypeOf, it } from "vitest";

import { parseUlid } from "../shared/index.js";

import {
  AUTHORIZATION_ACTIONS,
  type AuthorizationCheck,
  type AuthorizationDecision,
  type AuthorizationPort,
  type AuthorizationPrincipal,
  type AuthorizationResource,
} from "./authorization.js";

describe("AuthorizationPort contract", () => {
  it("is backend-neutral and accepts every canonical principal through one decision method", () => {
    expectTypeOf<AuthorizationPort>().toHaveProperty("check");
    expectTypeOf<Parameters<AuthorizationPort["check"]>[0]>().toEqualTypeOf<AuthorizationCheck>();
    expectTypeOf<ReturnType<AuthorizationPort["check"]>>().toEqualTypeOf<
      Promise<AuthorizationDecision>
    >();
    expectTypeOf<AuthorizationCheck["principal"]>().toEqualTypeOf<AuthorizationPrincipal>();
    expectTypeOf<AuthorizationCheck["resource"]>().toEqualTypeOf<AuthorizationResource>();
  });

  it("represents organization and project checks without inventing a project ID", () => {
    expectTypeOf<Extract<AuthorizationResource, { kind: "organization" }>>().not.toHaveProperty(
      "projectId",
    );
    expectTypeOf<Extract<AuthorizationResource, { kind: "project" }>>().toHaveProperty("projectId");
  });

  it("exposes promotion planning and execution as separate authorization actions", async () => {
    const port: AuthorizationPort = { check: async () => "allow" };
    const resource = {
      kind: "project",
      organizationId: parseUlid("01H00000000000000000000001"),
      projectId: parseUlid("01H00000000000000000000002"),
    } as const;
    const principal = { kind: "user", subjectId: "user:owner" } as const;
    await expect(
      port.check({ principal, resource, action: "projects:promote-plan" }),
    ).resolves.toBe("allow");
    await expect(port.check({ principal, resource, action: "projects:promote" })).resolves.toBe(
      "allow",
    );
  });

  it("exposes the closed organization billing and project or environment actions", () => {
    expect(AUTHORIZATION_ACTIONS).toEqual([
      "api-keys:manage",
      "feedback:create",
      "credits:read",
      "billing:manage",
      "projects:create",
      "projects:read",
      "projects:write",
      "projects:dev-access",
      "projects:rollback-plan",
      "projects:rollback",
      "projects:promote-plan",
      "projects:promote",
      "projects:delete-plan",
      "projects:delete",
      "sources:link",
      "sources:read",
      "deployments:plan",
      "deployments:create",
      "deployments:read",
      "operations:read",
      "operations:reconcile",
      "logs:read",
      "integrations:read",
      "integrations:manage",
      "auth:read",
      "auth:manage",
      "secrets:read",
      "secrets:write",
      "secrets:delete",
      "audit:read",
      "mail-domains:read",
      "mail-domains:use",
      "mail-domains:admin",
    ]);
  });
});
