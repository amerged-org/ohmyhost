import { expect, it, vi } from "vitest";
import { admitNativeEdgeRequest } from "../src/edge-rate-limit.js";

it("bounds each realm before selecting a hashed-address operation bucket", async () => {
  const general = vi.fn(async () => ({ success: true }));
  const signin = vi.fn(async () => ({ success: false }));
  const other = vi.fn(async () => ({ success: true }));
  const bindings = {
    NATIVE_AUTH_GENERAL_LIMITER: { limit: general },
    NATIVE_AUTH_REALM_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    NATIVE_AUTH_SIGNIN_LIMITER: { limit: signin },
    NATIVE_AUTH_SIGNUP_LIMITER: { limit: other },
    NATIVE_AUTH_RESET_LIMITER: { limit: other },
  };
  const input = {
    bindings,
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    method: "POST",
    path: "/api/auth/v1/sign-in/email",
    clientAddress: "192.0.2.1",
  };
  expect(await admitNativeEdgeRequest(input)).toBe(false);
  expect(general).toHaveBeenCalledOnce();
  expect(signin).toHaveBeenCalledOnce();
  expect(JSON.stringify(signin.mock.calls)).not.toContain("192.0.2.1");
  await expect(
    admitNativeEdgeRequest({ ...input, clientAddress: "untrusted.invalid" }),
  ).rejects.toThrow("auth_unavailable");
});

it("keeps one noisy client from spending the general bucket of its realm for every other client", async () => {
  // A limiter that counts each key separately, as the Cloudflare binding does, with the production limit of 100.
  const counts = new Map<string, number>();
  const counting = {
    limit: async ({ key }: { readonly key: string }) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return { success: used <= 100 };
    },
  };
  const allowed = { limit: async () => ({ success: true }) };
  const bindings = {
    NATIVE_AUTH_GENERAL_LIMITER: counting,
    NATIVE_AUTH_REALM_LIMITER: allowed,
    NATIVE_AUTH_SIGNIN_LIMITER: allowed,
    NATIVE_AUTH_SIGNUP_LIMITER: allowed,
    NATIVE_AUTH_RESET_LIMITER: allowed,
  };
  const admit = (clientAddress: string) =>
    admitNativeEdgeRequest({
      bindings,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      method: "GET",
      path: "/api/auth/v1/get-session",
      clientAddress,
    });
  for (let index = 0; index < 100; index++) expect(await admit("192.0.2.1")).toBe(true);
  // The noisy client is over its share; another client of the same realm is still admitted.
  expect(await admit("192.0.2.1")).toBe(false);
  expect(await admit("198.51.100.7")).toBe(true);
});

it("bounds the whole realm with an aggregate ceiling even when every client stays inside its own share", async () => {
  // Per-client buckets allow everyone; the realm ceiling is the only limit that can stop a spread-out flood.
  const perClient = { limit: async () => ({ success: true }) };
  const realmCounts = new Map<string, number>();
  const realm = {
    limit: async ({ key }: { readonly key: string }) => {
      const used = (realmCounts.get(key) ?? 0) + 1;
      realmCounts.set(key, used);
      return { success: used <= 3 };
    },
  };
  const allowed = { limit: async () => ({ success: true }) };
  const bindings = {
    NATIVE_AUTH_GENERAL_LIMITER: perClient,
    NATIVE_AUTH_REALM_LIMITER: realm,
    NATIVE_AUTH_SIGNIN_LIMITER: allowed,
    NATIVE_AUTH_SIGNUP_LIMITER: allowed,
    NATIVE_AUTH_RESET_LIMITER: allowed,
  };
  const admit = (clientAddress: string) =>
    admitNativeEdgeRequest({
      bindings,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      method: "GET",
      path: "/api/auth/v1/get-session",
      clientAddress,
    });
  expect(await admit("192.0.2.1")).toBe(true);
  expect(await admit("192.0.2.2")).toBe(true);
  expect(await admit("192.0.2.3")).toBe(true);
  expect(await admit("192.0.2.4")).toBe(false);
  // The ceiling is keyed by realm alone, never by client.
  expect([...realmCounts.keys()]).toEqual([
    "01ARZ3NDEKTSV4RRFFQ69G5FAV:01ARZ3NDEKTSV4RRFFQ69G5FAW",
  ]);
});

it("buckets one IPv6 /64 as one client at the edge, so rotating addresses inside the prefix share the budget", async () => {
  // A limiter that counts each key separately, as the Cloudflare binding does, with the production limit of 100.
  const counts = new Map<string, number>();
  const counting = {
    limit: async ({ key }: { readonly key: string }) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return { success: used <= 100 };
    },
  };
  const allowed = { limit: async () => ({ success: true }) };
  const bindings = {
    NATIVE_AUTH_GENERAL_LIMITER: counting,
    NATIVE_AUTH_REALM_LIMITER: allowed,
    NATIVE_AUTH_SIGNIN_LIMITER: allowed,
    NATIVE_AUTH_SIGNUP_LIMITER: allowed,
    NATIVE_AUTH_RESET_LIMITER: allowed,
  };
  const admit = (clientAddress: string) =>
    admitNativeEdgeRequest({
      bindings,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      method: "GET",
      path: "/api/auth/v1/get-session",
      clientAddress,
    });
  for (let index = 1; index <= 100; index++)
    expect(await admit(`2001:db8:1:2::${index.toString(16)}`)).toBe(true);
  // Another address of the same /64 is the same client, now over its share; another prefix is admitted.
  expect(await admit("2001:db8:1:2:ffff::1")).toBe(false);
  expect(await admit("2001:db8:1:3::1")).toBe(true);
});

it("charges a verification mail to a tight per-client bucket, so one client cannot mail-bomb a pending user", async () => {
  // A limiter that counts each key separately, with the production limit of 3 per minute for the sign-up binding.
  const counts = new Map<string, number>();
  const counting = {
    limit: async ({ key }: { readonly key: string }) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return { success: used <= 3 };
    },
  };
  const allowed = { limit: async () => ({ success: true }) };
  const bindings = {
    NATIVE_AUTH_GENERAL_LIMITER: allowed,
    NATIVE_AUTH_REALM_LIMITER: allowed,
    NATIVE_AUTH_SIGNIN_LIMITER: allowed,
    NATIVE_AUTH_SIGNUP_LIMITER: counting,
    NATIVE_AUTH_RESET_LIMITER: allowed,
  };
  const admit = () =>
    admitNativeEdgeRequest({
      bindings,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      method: "POST",
      path: "/api/auth/v1/send-verification-email",
      clientAddress: "192.0.2.9",
    });
  expect([await admit(), await admit(), await admit(), await admit()]).toEqual([
    true,
    true,
    true,
    false,
  ]);
  expect([...counts.keys()]).toHaveLength(1);
  expect([...counts.keys()][0]).toContain("/api/auth/v1/send-verification-email");
});
