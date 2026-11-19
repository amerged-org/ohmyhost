import { nativeClientRateKey } from "./client-rate-key.js";

export interface NativeEdgeLimiter {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
}
export interface NativeEdgeLimitBindings {
  readonly NATIVE_AUTH_GENERAL_LIMITER: NativeEdgeLimiter;
  /** The realm-wide aggregate ceiling: far above any one client's share, it bounds a flood spread over many clients. */
  readonly NATIVE_AUTH_REALM_LIMITER: NativeEdgeLimiter;
  readonly NATIVE_AUTH_SIGNIN_LIMITER: NativeEdgeLimiter;
  readonly NATIVE_AUTH_SIGNUP_LIMITER: NativeEdgeLimiter;
  readonly NATIVE_AUTH_RESET_LIMITER: NativeEdgeLimiter;
}

/** clientAddress comes from the trusted gateway, never from a customer-supplied auth header. */
export async function admitNativeEdgeRequest(input: {
  readonly bindings: NativeEdgeLimitBindings;
  readonly projectId: string;
  readonly environmentId: string;
  readonly method: string;
  readonly path: string;
  readonly clientAddress: string;
}): Promise<boolean> {
  if (
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(input.projectId) ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(input.environmentId) ||
    !/^[0-9a-fA-F:.]{2,45}$/u.test(input.clientAddress)
  )
    throw new Error("auth_unavailable");
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(nativeClientRateKey(input.clientAddress.toLowerCase())),
    ),
  );
  const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const realm = `${input.projectId}:${input.environmentId}`;
  // The general bucket is per client within the realm, so one address cannot spend the realm's budget for others.
  const general = await input.bindings.NATIVE_AUTH_GENERAL_LIMITER.limit({
    key: `${realm}:${digest}`,
  });
  if (!general.success) return false;
  const aggregate = await input.bindings.NATIVE_AUTH_REALM_LIMITER.limit({ key: realm });
  if (!aggregate.success) return false;
  const selected =
    input.method === "POST" && input.path === "/api/auth/v1/sign-in/email"
      ? input.bindings.NATIVE_AUTH_SIGNIN_LIMITER
      : input.method === "POST" && input.path === "/api/auth/v1/sign-up/email"
        ? input.bindings.NATIVE_AUTH_SIGNUP_LIMITER
        : input.method === "POST" && input.path === "/api/auth/v1/request-password-reset"
          ? input.bindings.NATIVE_AUTH_RESET_LIMITER
          : // A verification mail is tight per client too; it shares the sign-up limit of three a minute.
            input.method === "POST" && input.path === "/api/auth/v1/send-verification-email"
            ? input.bindings.NATIVE_AUTH_SIGNUP_LIMITER
            : null;
  return (
    selected === null || (await selected.limit({ key: `${realm}:${input.path}:${digest}` })).success
  );
}
