// Better Auth's database option type names Bun's SQLite; referencing only those declarations avoids changing Node's global APIs.
/// <reference types="bun-types/sqlite.d.ts" preserve="true" />
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Pool } from "pg";

import { CUSTOMER_AUTH_INSTALLATION_CONTRACT } from "./installation-contract.js";

const MAIL_OPERATION_PATHS = new Set([
  "/sign-up/email",
  "/send-verification-email",
  "/request-password-reset",
  "/reset-password",
]);

export interface CustomerAuthEmail {
  readonly kind: "password-changed" | "password-reset" | "verification";
  readonly to: string;
  readonly url: string;
}

export interface CustomerAuthEmailSender {
  send(message: CustomerAuthEmail): Promise<void>;
}

export interface CustomerAuthRuntimeInput {
  readonly appName: string;
  readonly publicOrigin: string;
  readonly database: Pool;
  readonly secret: string;
  readonly email?: CustomerAuthEmailSender;
}

export function createCustomerAuthOptions(input: CustomerAuthRuntimeInput): BetterAuthOptions {
  const publicOrigin = parsePublicOrigin(input.publicOrigin);
  const authBasePath = CUSTOMER_AUTH_INSTALLATION_CONTRACT.http.routePath;
  if (
    typeof input.appName !== "string" ||
    input.appName.trim() !== input.appName ||
    input.appName.length < 1 ||
    input.appName.length > 80 ||
    typeof input.database?.query !== "function" ||
    typeof input.secret !== "string" ||
    input.secret.length < 32 ||
    input.secret.length > 512 ||
    (input.email !== undefined && typeof input.email?.send !== "function")
  ) {
    throw new TypeError("Customer auth runtime input is invalid");
  }
  const send = async (kind: CustomerAuthEmail["kind"], email: string, url: string) => {
    if (input.email === undefined) {
      throw APIError.from("SERVICE_UNAVAILABLE", {
        code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED",
        message: "Configure an email sender for this authentication operation",
      });
    }
    await input.email.send({
      kind,
      to: email,
      url:
        kind === "password-changed"
          ? sameOriginExactUrl(url, publicOrigin, "/login")
          : sameOriginAuthUrl(url, publicOrigin, authBasePath),
    });
  };
  const options: BetterAuthOptions = {
    appName: input.appName,
    baseURL: publicOrigin,
    basePath: authBasePath,
    trustedOrigins: [publicOrigin],
    secret: input.secret,
    database: input.database,
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (input.email === undefined && MAIL_OPERATION_PATHS.has(context.path)) {
          throw APIError.from("SERVICE_UNAVAILABLE", {
            code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED",
            message: "Configure an email sender for this authentication operation",
          });
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3_600,
      sendResetPassword: ({ user, url }) => send("password-reset", user.email, url),
      // The password has already changed, and Better Auth revokes the sessions only after this hook returns.
      // The notice is best effort: a rejected send must not leave the sessions of a reset account valid.
      onPasswordReset: async ({ user }) => {
        try {
          await send("password-changed", user.email, `${publicOrigin}/login`);
        } catch {
          // The provider error may carry recipient or provider detail, so it is neither rethrown nor logged.
          console.warn("customer_auth_password_changed_notice_failed");
        }
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: input.email !== undefined,
      autoSignInAfterVerification: false,
      expiresIn: 3_600,
      sendVerificationEmail: ({ user, url }) => send("verification", user.email, url),
    },
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
      },
    },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: true,
      database: {
        generateId: CUSTOMER_AUTH_INSTALLATION_CONTRACT.database.idGeneration,
        joins: true,
      },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
  };
  return Object.freeze(options);
}

export function createCustomerAuth(input: CustomerAuthRuntimeInput) {
  return betterAuth(createCustomerAuthOptions(input));
}

export function createCustomerAuthPostgresPool(connectionString: string): Pool {
  validateConnectionString(connectionString);
  return new Pool(poolConfiguration(connectionString));
}

function validateConnectionString(connectionString: string): void {
  if (
    typeof connectionString !== "string" ||
    connectionString.length < 1 ||
    connectionString.length > 8_192 ||
    !/^postgres(?:ql)?:\/\//u.test(connectionString)
  ) {
    throw new TypeError("Customer auth database URL is invalid");
  }
}

function poolConfiguration(connectionString: string) {
  return {
    connectionString,
    options: `-c search_path=${CUSTOMER_AUTH_INSTALLATION_CONTRACT.database.schema}`,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  };
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;

function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Customer auth public origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Customer auth public origin is invalid");
  }
  return url.origin;
}

function sameOriginAuthUrl(value: string, publicOrigin: string, authBasePath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Customer auth e-mail URL is invalid");
  }
  if (
    url.origin !== publicOrigin ||
    (url.pathname !== authBasePath && !url.pathname.startsWith(`${authBasePath}/`))
  ) {
    throw new TypeError("Customer auth e-mail URL is invalid");
  }
  return url.href;
}

function sameOriginExactUrl(value: string, publicOrigin: string, pathname: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Customer auth e-mail URL is invalid");
  }
  if (
    url.origin !== publicOrigin ||
    url.pathname !== pathname ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Customer auth e-mail URL is invalid");
  }
  return url.href;
}
