import {
  UserApiKeyRequestError,
  USER_API_KEY_REQUEST_CODES,
  type UserApiKeyClaim,
  type WorkosIdentityPort,
} from "./identity-port.js";

/**
 * The closed set of `ControlRuntime` methods the WorkOS management Worker calls. A consumer holds the SERVICE
 * binding to the private `ControlRuntime` entrypoint and nothing else: no D1 binding and no connection pool. Each
 * method is one typed, guarded D1 batch on the organization's shard (or the directory); none accepts SQL, a
 * permission list, an event type or a clock the caller controls.
 */
export interface ControlRuntimeIdentityBinding {
  authorizeUserApiKeyScope(input: unknown): Promise<unknown>;
  claimUserApiKeyCreation(input: unknown): Promise<UserApiKeyClaim>;
  finishUserApiKeyCreation(input: unknown): Promise<unknown>;
  readUserApiKeyNames(input: unknown): Promise<ReadonlyMap<string, string>>;
  recordUserApiKeyRevocationAudit(input: unknown): Promise<unknown>;
  readSessionRevocation(input: unknown): Promise<{ readonly workosUserId: string | null } | null>;
  recordTerminalRevocation(input: unknown): Promise<"created" | "existing">;
  isSessionEligible(input: unknown): Promise<boolean>;
}

export const CONTROL_RUNTIME_IDENTITY_METHODS = [
  "authorizeUserApiKeyScope",
  "claimUserApiKeyCreation",
  "finishUserApiKeyCreation",
  "readUserApiKeyNames",
  "recordUserApiKeyRevocationAudit",
  "readSessionRevocation",
  "recordTerminalRevocation",
  "isSessionEligible",
] as const satisfies readonly (keyof ControlRuntimeIdentityBinding)[];

/** The Control service binding is absent or unusable: the request fails closed. */
export class ControlRuntimeUnavailableError extends Error {
  readonly code = "control_runtime_unavailable";
  constructor() {
    super("control_runtime_unavailable");
  }
}

/**
 * A service-binding stub answers `typeof` as callable for every property name, so a missing method can only
 * show itself when called. What can be checked up front is that a binding is present at all.
 */
export function requireControlRuntimeBinding(value: unknown): ControlRuntimeIdentityBinding {
  if (
    value === undefined ||
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new ControlRuntimeUnavailableError();
  }
  return value as ControlRuntimeIdentityBinding;
}

/**
 * A command refusal crosses the service binding as an error whose message is its closed code (the store's
 * `CommandConflictError` carries the code as its message). Anything else stays an unclassified failure.
 */
function refusal(error: unknown): UserApiKeyRequestError | undefined {
  const text =
    typeof error === "object" && error !== null
      ? ((error as { code?: unknown }).code ?? (error as { message?: unknown }).message)
      : undefined;
  const match = USER_API_KEY_REQUEST_CODES.find((code) => code === text);
  return match === undefined ? undefined : new UserApiKeyRequestError(match);
}

/**
 * The D1 implementation of the identity port. Every call is `() => binding.method(input)` over the real
 * service binding (a method detached from its stub would lose its receiver). Each port call is exactly one
 * ControlRuntime command: the original authoritative transaction maps to one D1 batch, never a sequence of
 * RPCs that a caller could interleave.
 */
export function createD1WorkosIdentityPort(input: {
  readonly runtime: unknown;
}): WorkosIdentityPort {
  const binding = requireControlRuntimeBinding(input.runtime);
  const call = async <Result>(run: () => Promise<Result>): Promise<Result> => {
    try {
      return await run();
    } catch (error) {
      throw refusal(error) ?? error;
    }
  };
  return {
    async authorizeUserApiKeyScope(scope) {
      await call(() => binding.authorizeUserApiKeyScope(scope));
    },
    claimUserApiKeyCreation: (claim) => call(() => binding.claimUserApiKeyCreation(claim)),
    async finishUserApiKeyCreation(finish) {
      await call(() => binding.finishUserApiKeyCreation(finish));
    },
    readUserApiKeyNames: async (read) =>
      new Map(await call(() => binding.readUserApiKeyNames({ ...read, keyIds: [...read.keyIds] }))),
    async recordUserApiKeyRevocationAudit(audit) {
      await call(() => binding.recordUserApiKeyRevocationAudit(audit));
    },
    readSessionRevocation: (read) => call(() => binding.readSessionRevocation(read)),
    recordTerminalRevocation: (revocation) =>
      call(() => binding.recordTerminalRevocation(revocation)),
    isSessionEligible: (eligibility) => call(() => binding.isSessionEligible(eligibility)),
  };
}
