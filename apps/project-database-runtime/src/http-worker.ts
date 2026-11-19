import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type ClientConfig, type PoolConfig } from "pg";

const MAIL_GATEWAY_SERVICE_URL = "https://mail-gateway.internal/v1/send";
const MAIL_OPERATION_PATHS = new Set([
  "/sign-up/email",
  "/send-verification-email",
  "/request-password-reset",
]);
const INTERNAL_HEADERS = Object.freeze([
  "x-ohmyhost-app-name",
  "x-ohmyhost-auth-secret",
  "x-ohmyhost-auth-url",
  "x-ohmyhost-mail-key",
  "x-ohmyhost-project-id",
  "x-ohmyhost-egress-project-id",
]);

export interface ProjectDatabaseHttpBindings {
  readonly DATABASE_CONNECTION_STRING: string;
  readonly OHMYHOST_MAIL_GATEWAY?: { fetch(request: Request): Promise<Response> } | undefined;
  readonly PROJECT_ID: string;
}

export interface ProjectDatabaseHttpDependencies {
  readonly createPool?: (configuration: PoolConfig) => Pool;
  readonly sharedPool?: Pool;
}

export function createProjectDatabaseHttpWorker(
  dependencies: ProjectDatabaseHttpDependencies = {},
) {
  const createPool = dependencies.createPool ?? ((configuration) => new Pool(configuration));
  return Object.freeze({
    async fetch(request: Request, bindings: ProjectDatabaseHttpBindings): Promise<Response> {
      if (!validBindings(bindings)) return unavailable();
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/auth")) return new Response(null, { status: 404 });
      const configuration = readAuthConfiguration(request, bindings.PROJECT_ID);
      if (configuration === null) return unavailable();
      // The physical environment shares one two-connection auth lane across all requests.
      const pool =
        dependencies.sharedPool ??
        createPool({
          ...databaseConfiguration(bindings.DATABASE_CONNECTION_STRING),
          max: 2,
        });
      const database = new Kysely({ dialect: new PostgresDialect({ pool }) }).withSchema("auth");
      const auth = betterAuth(
        createProjectAuthOptions({
          database: { db: database, type: "postgres", transaction: true },
          ...configuration,
          ...(typeof bindings.OHMYHOST_MAIL_GATEWAY?.fetch === "function" &&
          typeof configuration.mailKey === "string" &&
          configuration.mailKey.length >= 16 &&
          configuration.mailKey.length <= 512
            ? {
                sendMail: (message: Parameters<typeof sendProjectMail>[3]) =>
                  sendProjectMail(
                    bindings.OHMYHOST_MAIL_GATEWAY,
                    configuration.mailKey,
                    bindings.PROJECT_ID,
                    message,
                  ),
              }
            : {}),
        }),
      );
      try {
        return await auth.handler(publicRequest(request, configuration.origin));
      } catch (error) {
        console.error("project_auth_failed", diagnostic(error));
        return unavailable();
      } finally {
        if (!dependencies.sharedPool) await database.destroy();
      }
    },
  });
}

export function createProjectAuthOptions(input: {
  readonly database: BetterAuthOptions["database"];
  readonly origin: string;
  readonly secret: string;
  readonly appName: string;
  readonly sendMail?: (message: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
    readonly idempotencyKey: string;
  }) => Promise<void>;
}): BetterAuthOptions {
  const sendMail = (message: Parameters<NonNullable<typeof input.sendMail>>[0]) => {
    if (input.sendMail === undefined) throw missingEmailSender();
    return input.sendMail(message);
  };
  return {
    appName: input.appName,
    baseURL: `${input.origin}/api/auth`,
    basePath: "/api/auth",
    secret: input.secret,
    database: input.database,
    trustedOrigins: [new URL(input.origin).origin],
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (input.sendMail === undefined && MAIL_OPERATION_PATHS.has(context.path)) {
          throw missingEmailSender();
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) =>
        sendMail({
          to: user.email,
          subject: `Reset your ${input.appName} password`,
          text: `Reset your password: ${url}`,
          html: `<p>Reset your password: <a href="${escapeHtml(url)}">Reset password</a></p>`,
          idempotencyKey: await authMailIdempotencyKey("reset", user.id, token),
        }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url, token }) =>
        sendMail({
          to: user.email,
          subject: `Verify your ${input.appName} email`,
          text: `Verify your email: ${url}`,
          html: `<p>Verify your email: <a href="${escapeHtml(url)}">Verify email</a></p>`,
          idempotencyKey: await authMailIdempotencyKey("verify", user.id, token),
        }),
    },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: true,
      cookiePrefix: "ohmyhost_app",
      database: { generateId: "uuid", joins: true },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    rateLimit: { enabled: true, storage: "database" },
  };
}

function readAuthConfiguration(request: Request, projectId: string) {
  const suppliedProjectId = request.headers.get("x-ohmyhost-project-id");
  const origin = request.headers.get("x-ohmyhost-auth-url");
  const secret = request.headers.get("x-ohmyhost-auth-secret");
  const mailKey = request.headers.get("x-ohmyhost-mail-key");
  const appName = request.headers.get("x-ohmyhost-app-name");
  if (
    suppliedProjectId !== projectId ||
    typeof origin !== "string" ||
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 256 ||
    typeof appName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(appName)
  ) {
    return null;
  }
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({ origin, secret, mailKey, appName });
}

function publicRequest(request: Request, publicBaseUrl: string): Request {
  const headers = new Headers(request.headers);
  for (const name of INTERNAL_HEADERS) headers.delete(name);
  const incoming = new URL(request.url);
  const target = new URL(publicBaseUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return new Request(new Request(target, request), { headers });
}

export async function sendProjectMail(
  service: ProjectDatabaseHttpBindings["OHMYHOST_MAIL_GATEWAY"],
  key: string | null,
  projectId: string,
  message: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
    readonly idempotencyKey: string;
  },
): Promise<void> {
  if (
    typeof service?.fetch !== "function" ||
    typeof key !== "string" ||
    key.length < 16 ||
    key.length > 512
  ) {
    throw missingEmailSender();
  }
  const response = await service.fetch(
    new Request(MAIL_GATEWAY_SERVICE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-ohmyhost-egress-project-id": projectId,
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({ ...message, project_id: projectId, idempotencyKey: undefined }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (response.status !== 202) throw new Error("mail_delivery_failed");
}

export async function authMailIdempotencyKey(
  kind: "reset" | "verify",
  userId: string,
  token: string,
): Promise<string> {
  if (
    (kind !== "reset" && kind !== "verify") ||
    userId.length < 1 ||
    userId.length > 128 ||
    token.length < 1 ||
    token.length > 512
  ) {
    throw new Error("auth_mail_idempotency_invalid");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}\0${userId}\0${token}`)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function databaseConfiguration(connectionString: string): ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 12_000,
    statement_timeout: 10_000,
  };
}

function missingEmailSender() {
  return APIError.from("SERVICE_UNAVAILABLE", {
    code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED",
    message: "Configure an email sender for this authentication operation",
  });
}

function validBindings(value: ProjectDatabaseHttpBindings): boolean {
  return (
    typeof value?.DATABASE_CONNECTION_STRING === "string" &&
    value.DATABASE_CONNECTION_STRING.length > 0 &&
    /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value.PROJECT_ID)
  );
}

function unavailable(): Response {
  return Response.json(
    { error: "service_unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

function diagnostic(error: unknown) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{2,32}$/u.test(error.code)
      ? error.code
      : null;
  const constraint =
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    typeof error.constraint === "string" &&
    /^[A-Za-z0-9_]{1,64}$/u.test(error.constraint)
      ? error.constraint
      : null;
  return Object.freeze({
    name: error instanceof Error ? error.name : "UnknownError",
    code,
    constraint,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}
