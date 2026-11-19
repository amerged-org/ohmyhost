import type { BetterAuthOptions } from "better-auth";
import { isNativeAuthRedirectPath } from "@ohmyhost/contracts/native-auth";
import { nativeApplicationFallbackPath } from "./application-redirect.js";

/** Private configuration obtained from the platform; never from customer headers. */
export interface NativeAuthEngineConfiguration {
  readonly canonicalOrigin: string;
  readonly applicationName: string;
  readonly secret: string;
  readonly previewId?: string;
  readonly database: BetterAuthOptions["database"];
  readonly resetPasswordPath?: string;
  readonly allowedRedirectPaths?: readonly string[];
  readonly sendMail: (
    message: Readonly<{
      kind: "verification" | "password-reset";
      to: string;
      url: string;
      token: string;
    }>,
  ) => Promise<void>;
}

/**
 * Baseline engine options. This alone is not a runtime: the caller must enforce
 * realm/user authority, local mailbox proof, invitation and social policies.
 */
function commonNativeAuthOptions(input: Omit<NativeAuthEngineConfiguration, "sendMail">): {
  options: BetterAuthOptions;
  resetPath: string;
  allowedPaths: readonly string[];
} {
  const origin = new URL(input.canonicalOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.canonicalOrigin ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    input.secret.length < 32 ||
    (input.previewId !== undefined &&
      !/^(?:[a-f0-9]{32}|[0-7][0-9A-HJKMNP-TV-Z]{25})$/u.test(input.previewId)) ||
    input.applicationName.trim().length === 0 ||
    input.database == null
  ) {
    throw new TypeError("invalid_native_auth_configuration");
  }
  const resetPath = input.resetPasswordPath ?? "/reset-password";
  const allowedPaths = input.allowedRedirectPaths ?? [
    "/login",
    "/reset-password",
    "/accept-invitation",
  ];
  if (
    !isNativeAuthRedirectPath(resetPath) ||
    allowedPaths.some((path) => !isNativeAuthRedirectPath(path)) ||
    !allowedPaths.includes(resetPath)
  ) {
    throw new TypeError("invalid_native_auth_reset_path");
  }
  const options: BetterAuthOptions = {
    appName: input.applicationName,
    baseURL: input.canonicalOrigin,
    basePath: "/api/auth/v1",
    secret: input.secret,
    // Platform diagnostics use closed reason codes; library errors may contain adapter row data.
    logger: { disabled: true },
    // Re-throw unexpected engine errors to the Native boundary before the router can log raw data.
    onAPIError: { throw: true },
    database: input.database,
    trustedOrigins: [input.canonicalOrigin],
    session: { expiresIn: 604800, updateAge: 86400, cookieCache: { enabled: false } },
    account: {
      storeAccountCookie: false,
      accountLinking: {
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }),
        },
        update: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }),
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
      },
    },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // better-auth prepends __Secure- to every name when useSecureCookies is on, so the __Host- prefix is written
      // into the cookie prefix instead. Secure and Path=/ come from the defaults; no Domain is ever set.
      useSecureCookies: false,
      cookiePrefix:
        input.previewId === undefined
          ? "__Host-omh_native"
          : `__Host-omh_native_preview_${input.previewId}`,
      defaultCookieAttributes: { secure: true },
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
  };
  return { options, resetPath, allowedPaths };
}

export function createNativeAuthEngineOptions(
  input: NativeAuthEngineConfiguration,
): BetterAuthOptions {
  const { options, resetPath, allowedPaths } = commonNativeAuthOptions(input);
  return {
    ...options,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) => {
        const url = new URL(resetPath, input.canonicalOrigin);
        url.searchParams.set("token", token);
        return input.sendMail({ kind: "password-reset", to: user.email, url: url.href, token });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: ({ user, url, token }) => {
        const verificationUrl = new URL(url);
        // Better Auth fills "/" when no callbackURL was given; the owner's first allowed path replaces it.
        if (verificationUrl.searchParams.get("callbackURL") === "/")
          verificationUrl.searchParams.set(
            "callbackURL",
            nativeApplicationFallbackPath(allowedPaths),
          );
        const callback = verificationUrl.searchParams.get("callbackURL");
        const callbackUrl = callback ? new URL(callback, input.canonicalOrigin) : null;
        if (
          verificationUrl.origin !== input.canonicalOrigin ||
          verificationUrl.pathname !== "/api/auth/v1/verify-email" ||
          verificationUrl.hash !== "" ||
          verificationUrl.searchParams.getAll("token").length !== 1 ||
          verificationUrl.searchParams.get("token") !== token ||
          verificationUrl.searchParams.getAll("callbackURL").length > 1 ||
          [...verificationUrl.searchParams.keys()].some(
            (key) => key !== "token" && key !== "callbackURL",
          ) ||
          (callbackUrl !== null &&
            (callbackUrl.origin !== input.canonicalOrigin ||
              callbackUrl.search !== "" ||
              callbackUrl.hash !== "" ||
              !allowedPaths.includes(callbackUrl.pathname) ||
              (callback !== callbackUrl.pathname && callback !== callbackUrl.href)))
        ) {
          throw new TypeError("invalid_native_auth_verification_url");
        }
        return input.sendMail({
          kind: "verification",
          to: user.email,
          url: verificationUrl.href,
          token,
        });
      },
    },
  };
}

/** Social callbacks use Native's own mailbox challenges, never engine password mail. */
export function createNativeSocialEngineOptions(
  input: Omit<NativeAuthEngineConfiguration, "sendMail">,
): BetterAuthOptions {
  return {
    ...commonNativeAuthOptions(input).options,
    emailAndPassword: { enabled: false },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
    },
  };
}
