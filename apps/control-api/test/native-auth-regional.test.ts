import { expect, it, vi } from "vitest";
import { createRegionalNativeAuthAdmin } from "../src/native-auth-regional.js";
import type { NativeAuthAdmin } from "../src/native-auth-composition.js";
import type { D1ProjectRuntime } from "../src/d1-project-persistence.js";

it("selects only the Core project's region and rejects a mismatched project", async () => {
  const getCustomerProject = vi.fn(async () => ({
    organizationId: "org",
    projectId: "project",
    region: "eu" as const,
  }));
  const eu = { listUsers: vi.fn(async () => []) } as unknown as NativeAuthAdmin;
  const us = { listUsers: vi.fn(async () => []) } as unknown as NativeAuthAdmin;
  const admin = createRegionalNativeAuthAdmin({
    runtime: { getCustomerProject } as unknown as D1ProjectRuntime,
    us,
    eu,
  });
  await expect(
    admin.listUsers({ organizationId: "org", projectId: "project", region: "us" }),
  ).resolves.toEqual([]);
  expect(eu.listUsers).toHaveBeenCalledOnce();
  expect(us.listUsers).not.toHaveBeenCalled();
  await expect(
    admin.listUsers({ organizationId: "foreign", projectId: "project" }),
  ).rejects.toThrow("native_auth_unavailable");
  expect(eu.listUsers).toHaveBeenCalledOnce();
});

it("routes policy, user and invitation operations to the live project region and denies a lost scope", async () => {
  let region: "us" | "eu" = "us";
  let active = true;
  const getCustomerProject = vi.fn(async () =>
    active ? { organizationId: "org", projectId: "project", region } : null,
  );
  const makeAdmin = () => ({
    applyRealmPolicy: vi.fn(async () => ({ outcome: "applied" as const })),
    applyProviderPolicy: vi.fn(async () => ({ outcome: "applied" as const })),
    listUsers: vi.fn(async () => []),
    getUser: vi.fn(async () => null),
    mutateUser: vi.fn(async () => ({ userId: "user", action: "delete" as const, user: null })),
    deliverInvitation: vi.fn(async () => ({ status: "accepted" as const })),
  });
  const us = makeAdmin(),
    eu = makeAdmin();
  const admin = createRegionalNativeAuthAdmin({
    runtime: { getCustomerProject } as unknown as D1ProjectRuntime,
    us,
    eu,
  });
  const scope = { organizationId: "org", projectId: "project", environmentId: "dev" };
  await admin.applyRealmPolicy(scope);
  await admin.getUser(scope);
  region = "eu";
  await admin.applyProviderPolicy(scope);
  await admin.mutateUser(scope);
  await admin.deliverInvitation(scope);
  expect(us.applyRealmPolicy).toHaveBeenCalledWith(scope);
  expect(us.getUser).toHaveBeenCalledWith(scope);
  expect(eu.applyProviderPolicy).toHaveBeenCalledWith(scope);
  expect(eu.mutateUser).toHaveBeenCalledWith(scope);
  expect(eu.deliverInvitation).toHaveBeenCalledWith(scope);
  active = false;
  await expect(admin.applyRealmPolicy(scope)).rejects.toThrow("native_auth_unavailable");
  await expect(admin.deliverInvitation(scope)).rejects.toThrow("native_auth_unavailable");
  expect(us.applyRealmPolicy).toHaveBeenCalledTimes(1);
  expect(eu.deliverInvitation).toHaveBeenCalledTimes(1);
});
