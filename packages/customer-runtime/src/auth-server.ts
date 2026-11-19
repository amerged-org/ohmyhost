/** A read-only binding scoped by the platform to this deployment's auth realm. */
export interface NativeAuthBinding {
  validateSession(input: Readonly<{ cookie: string }>): Promise<NativeAuthSession | null>;
}

export interface NativeAuthSession {
  readonly user: Readonly<{ id: string; email: string }>;
  readonly session: Readonly<{ id: string; expiresAt: string }>;
}

export class NativeAuthRequiredError extends Error {
  public constructor() {
    super("Authentication is required.");
    this.name = "NativeAuthRequiredError";
  }
}

/**
 * Validate a request against the live realm. This does not grant access to business data;
 * applications must separately authorize each resource operation.
 */
export function createNativeAuthServer(binding: NativeAuthBinding): {
  getSession(request: Request): Promise<NativeAuthSession | null>;
  requireUser(request: Request): Promise<NativeAuthSession["user"]>;
} {
  if (
    typeof binding !== "object" ||
    binding === null ||
    typeof binding.validateSession !== "function"
  ) {
    throw new TypeError("The OHMYHOST_AUTH server binding is required.");
  }
  async function getSession(request: Request): Promise<NativeAuthSession | null> {
    const result = await binding.validateSession({ cookie: request.headers.get("cookie") ?? "" });
    if (result === null) return null;
    if (
      typeof result !== "object" ||
      typeof result.user?.id !== "string" ||
      !result.user.id ||
      typeof result.user.email !== "string" ||
      !result.user.email ||
      typeof result.session?.id !== "string" ||
      !result.session.id ||
      typeof result.session.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(result.session.expiresAt))
    )
      throw new Error("auth_response_invalid");
    // Copy only the documented identity fields, never arbitrary binding data.
    return {
      user: { id: result.user.id, email: result.user.email },
      session: { id: result.session.id, expiresAt: result.session.expiresAt },
    };
  }
  return {
    getSession,
    async requireUser(request) {
      const session = await getSession(request);
      if (session === null) throw new NativeAuthRequiredError();
      return session.user;
    },
  };
}
