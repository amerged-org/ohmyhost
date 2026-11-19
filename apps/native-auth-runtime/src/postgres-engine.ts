import { betterAuth } from "better-auth";
import { type Pool, type PoolConfig } from "pg";
import { isNativeAuthRedirectPath, type NativeAuthSession } from "@ohmyhost/contracts/native-auth";
import { createNativeAuthEngineOptions, type NativeAuthEngineConfiguration } from "./engine.js";

/** Supplied only by the private credential registry for a single realm role. */
export interface NativeAuthPostgresConfiguration
  extends Omit<NativeAuthEngineConfiguration, "database"> {
  readonly connectionString: string;
  readonly schema: string;
}

/**
 * Mandatory enforcement around engine operations. This port is not a replacement
 * for database transactions: its implementation must fence mutation and token
 * consumption against current realm/user status and revocation epochs.
 */
export interface NativeAuthEnginePolicy {
  handle(request: Request, execute: () => Promise<Response>): Promise<Response>;
  validate(session: NativeAuthSession): Promise<NativeAuthSession | null>;
}

export function createNativeAuthPostgresEngine(
  input: NativeAuthPostgresConfiguration,
  policy: NativeAuthEnginePolicy,
  createPool: (configuration: PoolConfig) => Pool,
) {
  const allowedPaths = input.allowedRedirectPaths ?? [
    "/login",
    "/reset-password",
    "/accept-invitation",
  ];
  if (
    !/^postgres(?:ql)?:\/\//u.test(input.connectionString) ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(input.schema) ||
    allowedPaths.some((path) => !isNativeAuthRedirectPath(path)) ||
    !allowedPaths.includes(input.resetPasswordPath ?? "/reset-password") ||
    typeof createPool !== "function" ||
    typeof policy?.handle !== "function" ||
    typeof policy.validate !== "function"
  ) {
    throw new TypeError("invalid_native_auth_postgres_configuration");
  }
  const pool = createPool({
    connectionString: input.connectionString,
    options: `-c search_path=${input.schema}`,
    max: 2,
    connectionTimeoutMillis: 10000,
    query_timeout: 12000,
    statement_timeout: 10000,
  });
  const auth = betterAuth(createNativeAuthEngineOptions({ ...input, database: pool }));
  const redirectAllowed = (value: unknown): boolean => {
    if (value === undefined || value === null || value === "") return true;
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value, input.canonicalOrigin);
      return (
        url.origin === input.canonicalOrigin &&
        url.search === "" &&
        url.hash === "" &&
        allowedPaths.includes(url.pathname) &&
        (value === url.pathname || value === url.href)
      );
    } catch {
      return false;
    }
  };
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const requestUrl = new URL(request.url);
      for (const key of ["callbackURL", "redirectTo", "errorCallbackURL", "newUserCallbackURL"]) {
        if (
          requestUrl.searchParams.getAll(key).length > 1 ||
          !redirectAllowed(requestUrl.searchParams.get(key))
        )
          return new Response(null, { status: 400 });
      }
      if (request.method === "POST") {
        if (!request.headers.get("content-type")?.includes("application/json"))
          return new Response(null, { status: 415 });
        try {
          const body: unknown = await request.clone().json();
          if (typeof body === "object" && body !== null && !Array.isArray(body)) {
            const record = body as Record<string, unknown>;
            for (const key of [
              "callbackURL",
              "redirectTo",
              "errorCallbackURL",
              "newUserCallbackURL",
            ]) {
              if (!redirectAllowed(record[key])) return new Response(null, { status: 400 });
            }
          }
        } catch {
          return new Response(null, { status: 400 });
        }
      }
      const response = await policy.handle(request, () => auth.handler(request));
      const path = new URL(request.url).pathname;
      if (path !== "/api/auth/v1/sign-in/email" && path !== "/api/auth/v1/get-session")
        return response;
      if (!response.headers.get("content-type")?.includes("application/json")) return response;
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        delete record["token"];
        if (
          typeof record["session"] === "object" &&
          record["session"] !== null &&
          !Array.isArray(record["session"])
        ) {
          delete (record["session"] as Record<string, unknown>)["token"];
        }
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    async validateSession(cookie: string): Promise<NativeAuthSession | null> {
      const result = await auth.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableRefresh: true },
      });
      if (!result) return null;
      return policy.validate({
        user: { id: result.user.id, email: result.user.email },
        session: { id: result.session.id, expiresAt: result.session.expiresAt.toISOString() },
      });
    },
    close(): Promise<void> {
      return pool.end();
    },
  });
}
