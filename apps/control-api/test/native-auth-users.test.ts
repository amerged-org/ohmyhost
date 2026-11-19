import { expect, it, vi } from "vitest";
import { createNativeAuthUserPort } from "../src/native-auth-users.js";
import { ENVIRONMENT_ID, ORGANIZATION_ID, PROJECT_ID } from "./helpers/app-routes-fixture.js";

it("preserves scope and mutation identity and waits for invitation delivery before acknowledging", async () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  const mutateUser = vi.fn(async (input: unknown) => {
    void input;
    return {
      userId,
      action: "create-invite" as const,
      user: {
        id: userId,
        email: "user@example.test",
        status: "pending",
        recoveryAvailable: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
  });
  const getUser = vi.fn(async (input: unknown) => {
    void input;
    return {
      id: userId,
      email: "user@example.test",
      status: "pending" as const,
      recoveryAvailable: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
  });
  const deliverInvitation = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(undefined);
  const acceptMutation = vi.fn(async (input: unknown) => {
    void input;
    return { outcome: "accepted" as const };
  });
  const port = createNativeAuthUserPort({
    acceptMutation,
    admin: { mutateUser, getUser, listUsers: async () => [] },
    deliverInvitation,
  });
  const input = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
    idempotencyKey: "invite",
    canonicalRequestDigest: new Uint8Array(32),
    email: "user@example.test",
  };
  await expect(port.createUser(input)).rejects.toThrow("unavailable");
  expect(acceptMutation.mock.invocationCallOrder[0]).toBeLessThan(
    mutateUser.mock.invocationCallOrder[0] as number,
  );
  expect(acceptMutation).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "create-invite",
      resourceId: null,
      canonicalRequestDigest: "00".repeat(32),
    }),
  );
  expect(getUser).not.toHaveBeenCalled();
  await expect(port.createUser(input)).resolves.toMatchObject({
    id: userId,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(getUser).not.toHaveBeenCalled();
  expect(mutateUser.mock.calls[0]).toEqual(mutateUser.mock.calls[1]);
  expect(deliverInvitation).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: ENVIRONMENT_ID, idempotencyKey: "invite", userId }),
  );
});

it("derives a bounded next cursor from an extra private row", async () => {
  const rows = [1, 2, 3].map((n) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    email: `u${n}@example.test`,
    status: "active" as const,
    recoveryAvailable: true,
    createdAt: "2026-01-01T00:00:00Z",
  }));
  const listUsers = vi.fn(async (input: unknown) => {
    void input;
    return rows;
  });
  const port = createNativeAuthUserPort({
    acceptMutation: async () => ({ outcome: "accepted" }),
    admin: {
      listUsers,
      getUser: async () => null,
      mutateUser: async () => {
        throw new Error("unused");
      },
    },
    deliverInvitation: async () => {},
  });
  const page = await port.listUsers({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
    limit: 2,
  });
  expect(page.items).toHaveLength(2);
  expect(page.nextCursor).toBe(rows[1]?.id);
  expect(listUsers).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 3, environmentId: ENVIRONMENT_ID }),
  );
});

it("checks the user identity and accepted action before deleting or changing an account", async () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  const foreignId = "00000000-0000-4000-8000-000000000002";
  const record = {
    id: userId,
    email: "user@example.test",
    status: "active" as const,
    recoveryAvailable: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const getUser = vi.fn(async () => record);
  const acceptMutation = vi.fn(async (input: unknown) => {
    void input;
    return { outcome: "accepted" as const };
  });
  const mutateUser = vi.fn(async (raw: unknown) => {
    const mutation = (
      raw as { mutation: { action: "delete" | "suspend" | "resend-invitation"; userId: string } }
    ).mutation;
    return {
      action: mutation.action,
      userId: mutation.userId,
      user: mutation.action === "delete" ? null : record,
    };
  });
  const deliverInvitation = vi.fn(async () => {});
  const port = createNativeAuthUserPort({
    acceptMutation,
    admin: { getUser, mutateUser, listUsers: async () => [] },
    deliverInvitation,
  });
  const scope = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:owner",
    requestId: "request",
    userId,
  };
  await expect(port.getUser(scope)).resolves.toMatchObject(record);
  await expect(port.getUser({ ...scope, userId: foreignId })).rejects.toThrow(
    "native_user_response_invalid",
  );
  const write = {
    ...scope,
    idempotencyKey: "action",
    canonicalRequestDigest: new Uint8Array(32).fill(4),
  };
  await expect(port.userAction({ ...write, action: "suspend" })).resolves.toMatchObject({
    id: userId,
  });
  await expect(port.userAction({ ...write, action: "invite" })).resolves.toMatchObject({
    id: userId,
  });
  expect(deliverInvitation).toHaveBeenCalledWith(
    expect.objectContaining({ action: "resend-invitation", userId, resourceId: userId }),
  );
  await expect(port.deleteUser(write)).resolves.toBeUndefined();
  expect(acceptMutation.mock.calls.map(([value]) => value)).toEqual([
    expect.objectContaining({ action: "suspend", resourceId: userId }),
    expect.objectContaining({ action: "resend-invitation", resourceId: userId }),
    expect.objectContaining({ action: "delete", resourceId: userId }),
  ]);
  expect(
    acceptMutation.mock.invocationCallOrder.every(
      (order, index) => order < (mutateUser.mock.invocationCallOrder[index] as number),
    ),
  ).toBe(true);
});
