import { describe, expect, it } from "vitest";
import { restrictionAllows } from "../src/catalog/identity/operation-delegations.js";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const mailDomainId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
describe("durable authorization restrictions", () => {
  it("applies resource bounds to their own family without widening create", () => {
    const cap = { projectIds: [projectId], mailDomainIds: [mailDomainId] };
    expect(restrictionAllows(cap, { organizationId, projectId, action: "projects:write" })).toBe(
      true,
    );
    expect(
      restrictionAllows(cap, { organizationId, mailDomainId, action: "mail-domains:use" }),
    ).toBe(true);
    expect(restrictionAllows(cap, { organizationId, action: "projects:create" })).toBe(false);
    expect(restrictionAllows(cap, { organizationId, action: "mail-domains:admin" })).toBe(false);
    expect(restrictionAllows(cap, { organizationId, action: "projects:read" })).toBe(true);
    expect(
      restrictionAllows({ actions: [] }, { organizationId, projectId, action: "projects:write" }),
    ).toBe(false);
  });
});
