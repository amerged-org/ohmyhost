import { expect, it } from "vitest";
import { intersectAuthorizationRestriction, restrictionAllows } from "./authorization.js";
import type { AuthorizationRestriction, AuthorizationResource } from "../../ports/index.js";
import { parseUlid } from "../../shared/index.js";

it("intersects signed Native actions with the existing credential ceiling without widening resource scope", () => {
  const organizationId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  const projectId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
  const environmentId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX");
  const mailDomainId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY");
  const foreignId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
  const resource: AuthorizationResource = {
    kind: "project",
    organizationId,
    projectId,
    environmentId,
  };
  const original: AuthorizationRestriction = {
    actions: ["auth:read", "secrets:write"],
    organizationIds: [organizationId],
    projectIds: [projectId],
    mailDomainIds: [mailDomainId],
  };
  const intersected = intersectAuthorizationRestriction(original, [
    "auth:read",
    "auth:manage",
    "unknown:grant",
    "mail-domains:admin",
  ]);
  expect(intersected).toEqual({ ...original, actions: ["auth:read"] });
  expect(original.actions).toEqual(["auth:read", "secrets:write"]);
  expect(restrictionAllows(intersected, resource, "auth:read")).toBe(true);
  expect(restrictionAllows(intersected, resource, "auth:manage")).toBe(false);
  expect(restrictionAllows(intersected, resource, "secrets:write")).toBe(false);
  expect(restrictionAllows(intersected, { ...resource, projectId: foreignId }, "auth:read")).toBe(
    false,
  );
  expect(
    restrictionAllows(intersected, { ...resource, organizationId: foreignId }, "auth:read"),
  ).toBe(false);
  const signedNative = intersectAuthorizationRestriction(undefined, [
    "unknown:grant",
    "auth:read",
    "auth:manage",
  ]);
  expect(signedNative).toEqual({ actions: ["auth:read", "auth:manage"] });
  expect(restrictionAllows(signedNative, resource, "auth:manage")).toBe(true);
  const noNativeRights = intersectAuthorizationRestriction(original, ["unknown:grant"]);
  expect(noNativeRights).toEqual({ ...original, actions: [] });
  expect(restrictionAllows(noNativeRights, resource, "auth:read")).toBe(false);
  expect(intersectAuthorizationRestriction(original, undefined)).toBe(original);
  expect(intersectAuthorizationRestriction(undefined, undefined)).toBeUndefined();
});
