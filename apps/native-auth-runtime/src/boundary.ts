import {
  isNativeAuthPublicRoute,
  NATIVE_AUTH_REQUEST_DEADLINE_MS,
  type NativeAuthRealmContext,
  type NativeAuthSession,
} from "@ohmyhost/contracts/native-auth";

/** The caller must be a platform binding: this scope is never derived from HTTP headers. */
export interface NativeAuthAuthority {
  readonly realm: NativeAuthRealmContext;
  readonly revocationEpoch: number;
  readonly enabled: boolean;
  readonly sourceCapable: boolean;
  readonly paidAllowed: boolean;
  readonly runtimeAllowed: boolean;
}

/** Platform-sealed deployment identity; mutable realm settings are resolved on use. */
export type NativeAuthDeploymentScope = Pick<NativeAuthRealmContext, "projectId" | "environmentId">;

/** Implementations must check current realm and user epochs on every session lookup. */
export interface NativeAuthBoundaryPorts {
  resolve(scope: NativeAuthDeploymentScope): Promise<NativeAuthAuthority>;
  handle(request: Request, authority: NativeAuthAuthority): Promise<Response>;
  validate(cookie: string, authority: NativeAuthAuthority): Promise<NativeAuthSession | null>;
}

export class NativeAuthUnavailable extends Error {
  constructor() {
    super("auth_unavailable");
    this.name = "NativeAuthUnavailable";
  }
}

function allowed(authority: NativeAuthAuthority, scope: NativeAuthDeploymentScope): boolean {
  const current = authority.realm;
  return (
    authority.enabled &&
    authority.sourceCapable &&
    authority.paidAllowed &&
    authority.runtimeAllowed &&
    current.projectId === scope.projectId &&
    current.environmentId === scope.environmentId
  );
}

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unavailable(): Response {
  return secureResponse(Response.json({ error: "auth_unavailable" }, { status: 503 }));
}

function stripInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("x-ohmyhost-")) headers.delete(name);
  }
  return new Request(request, { headers });
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NativeAuthUnavailable()),
          NATIVE_AUTH_REQUEST_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Private platform API; the caller supplies scope from an authenticated routing binding. */
export function createNativeAuthBoundary(ports: NativeAuthBoundaryPorts) {
  return Object.freeze({
    async fetchPublic(request: Request, scope: NativeAuthRealmContext): Promise<Response> {
      const url = new URL(request.url);
      if (!isNativeAuthPublicRoute(request.method, url.pathname)) {
        return secureResponse(new Response(null, { status: 404 }));
      }
      if (url.origin !== scope.canonicalOrigin)
        return secureResponse(new Response(null, { status: 403 }));
      try {
        return await deadline(
          (async () => {
            const authority = await ports.resolve(scope);
            if (!allowed(authority, scope) || authority.realm.canonicalOrigin !== url.origin)
              return unavailable();
            return secureResponse(await ports.handle(stripInternalHeaders(request), authority));
          })(),
        );
      } catch {
        return unavailable();
      }
    },
    /** Capture scope in a platform-owned binding, never in customer-provided arguments. */
    bind(scope: NativeAuthDeploymentScope) {
      const boundScope = Object.freeze({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      });
      return Object.freeze({
        async validateSession({
          cookie,
        }: {
          readonly cookie: string;
        }): Promise<NativeAuthSession | null> {
          try {
            if (typeof cookie !== "string" || cookie.length > 16384)
              throw new NativeAuthUnavailable();
            return await deadline(
              (async () => {
                const authority = await ports.resolve(boundScope);
                if (!allowed(authority, boundScope)) throw new NativeAuthUnavailable();
                return ports.validate(cookie, authority);
              })(),
            );
          } catch {
            throw new NativeAuthUnavailable();
          }
        },
      });
    },
  });
}
