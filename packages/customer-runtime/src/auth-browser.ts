import { createAuthClient } from "better-auth/client";

/** Available only on the authenticated browser self response, from Native mailbox proof. */
export interface NativeAuthRecoveryState {
  readonly recoveryAvailable: boolean;
}

type NativeSelfResponse<T> = T extends { data: infer Data }
  ? Omit<T, "data"> & {
      data: Data extends { user: infer User }
        ? Omit<Data, "user"> & { user: User & NativeAuthRecoveryState }
        : Data;
    }
  : T;

/** Retain this key when retrying an operation whose outcome is uncertain. */
export function createNativeAuthIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function disableNestedRetry<T extends { fetchOptions?: object | undefined }>(body: T): T {
  return body.fetchOptions ? { ...body, fetchOptions: { ...body.fetchOptions, retry: 0 } } : body;
}

/**
 * Browser-only, same-origin client. Authentication screens belong to the application.
 * For an operation that may need retry after an uncertain response, create and retain an
 * idempotency key before calling it, then pass that same key on every deliberate retry.
 */
export function createNativeAuthBrowser() {
  if (typeof window === "undefined") {
    throw new Error("Native Auth browser client requires a browser.");
  }
  const client = createAuthClient({
    baseURL: window.location.origin,
    basePath: "/api/auth/v1",
    fetchOptions: {
      credentials: "same-origin",
      retry: 0,
      onRequest(context) {
        const path = new URL(context.url, window.location.origin).pathname;
        if (
          context.method === "POST" &&
          [
            "/api/auth/v1/sign-up/email",
            "/api/auth/v1/send-verification-email",
            "/api/auth/v1/request-password-reset",
            "/api/auth/v1/accept-invitation",
            "/api/auth/v1/enroll-recovery",
          ].includes(path) &&
          !context.headers.has("idempotency-key")
        ) {
          context.headers.set("idempotency-key", createNativeAuthIdempotencyKey());
        }
      },
    },
  });
  return {
    signUp: {
      email: (...[body, options]: Parameters<typeof client.signUp.email>) =>
        client.signUp.email(disableNestedRetry(body), { ...options, retry: 0 }),
    },
    signIn: {
      email: (...[body, options]: Parameters<typeof client.signIn.email>) =>
        client.signIn.email(disableNestedRetry(body), { ...options, retry: 0 }),
      social: (input: {
        provider: "google" | "github";
        callbackURL?: string;
        errorCallbackURL?: string;
        newUserCallbackURL?: string;
        disableRedirect?: boolean;
        invitationToken?: string;
      }) =>
        client.$fetch<{ url: string; redirect: boolean }>("/sign-in/social", {
          method: "POST",
          retry: 0,
          body: {
            provider: input.provider,
            ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
            ...(input.errorCallbackURL === undefined
              ? {}
              : { errorCallbackURL: input.errorCallbackURL }),
            ...(input.newUserCallbackURL === undefined
              ? {}
              : { newUserCallbackURL: input.newUserCallbackURL }),
            ...(input.disableRedirect === undefined
              ? {}
              : { disableRedirect: input.disableRedirect }),
            ...(input.invitationToken === undefined
              ? {}
              : { invitationToken: input.invitationToken }),
          },
        }),
    },
    signOut: (...[body, options]: Parameters<typeof client.signOut>) =>
      client.signOut(body ? disableNestedRetry(body) : body, { ...options, retry: 0 }),
    getSession: async (...[body, options]: Parameters<typeof client.getSession>) => {
      const response = await client.getSession(body ? disableNestedRetry(body) : body, {
        ...options,
        retry: 0,
      });
      return response as NativeSelfResponse<typeof response>;
    },
    verifyEmail: (...[body, options]: Parameters<typeof client.verifyEmail>) =>
      client.verifyEmail(disableNestedRetry(body), { ...options, retry: 0 }),
    sendVerificationEmail: (...[body, options]: Parameters<typeof client.sendVerificationEmail>) =>
      client.sendVerificationEmail(disableNestedRetry(body), { ...options, retry: 0 }),
    requestPasswordReset: (...[body, options]: Parameters<typeof client.requestPasswordReset>) =>
      client.requestPasswordReset(disableNestedRetry(body), { ...options, retry: 0 }),
    resetPassword: (...[body, options]: Parameters<typeof client.resetPassword>) =>
      client.resetPassword(disableNestedRetry(body), { ...options, retry: 0 }),
    changePassword: (...[body, options]: Parameters<typeof client.changePassword>) =>
      client.changePassword(disableNestedRetry(body), { ...options, retry: 0 }),
    linkSocial: (input: {
      provider: "google" | "github";
      callbackURL?: string;
      errorCallbackURL?: string;
      newUserCallbackURL?: string;
      disableRedirect?: boolean;
    }) =>
      client.$fetch<{ url: string; redirect: boolean }>("/link-social", {
        method: "POST",
        retry: 0,
        body: {
          provider: input.provider,
          ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
          ...(input.errorCallbackURL === undefined
            ? {}
            : { errorCallbackURL: input.errorCallbackURL }),
          ...(input.newUserCallbackURL === undefined
            ? {}
            : { newUserCallbackURL: input.newUserCallbackURL }),
          ...(input.disableRedirect === undefined
            ? {}
            : { disableRedirect: input.disableRedirect }),
        },
      }),
    unlinkAccount: (...[body, options]: Parameters<typeof client.unlinkAccount>) =>
      client.unlinkAccount(disableNestedRetry(body), { ...options, retry: 0 }),
    listAccounts: client.listAccounts,
    acceptInvitation: (
      body: { token: string; password: string; name?: string },
      options: { idempotencyKey?: string } = {},
    ) =>
      client.$fetch<{ status: "accepted" }>("/accept-invitation", {
        method: "POST",
        body,
        retry: 0,
        ...(options.idempotencyKey === undefined
          ? {}
          : { headers: { "Idempotency-Key": options.idempotencyKey } }),
      }),
    reauthenticate: async (
      input: { password: string } | { provider: "google" | "github"; callbackURL?: string },
    ) => {
      const body =
        "password" in input
          ? { password: input.password }
          : {
              provider: input.provider,
              ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
            };
      const response = await client.$fetch<
        { authenticatedAt: Date } | { url: string; redirect: boolean }
      >("/reauthenticate", {
        method: "POST",
        body,
        retry: 0,
      });
      return response.data === null || !("authenticatedAt" in response.data)
        ? response
        : { ...response, data: { authenticatedAt: response.data.authenticatedAt.toISOString() } };
    },
    enrollRecovery: (
      body: { callbackURL?: string } = {},
      options: { idempotencyKey?: string } = {},
    ) =>
      client.$fetch<{ status: "sent" }>("/enroll-recovery", {
        method: "POST",
        body,
        retry: 0,
        ...(options.idempotencyKey === undefined
          ? {}
          : { headers: { "Idempotency-Key": options.idempotencyKey } }),
      }),
  };
}
