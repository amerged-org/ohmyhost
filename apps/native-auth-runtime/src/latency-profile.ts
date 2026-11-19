/** Redacted, opt-in measurements for one private C5 Development session request. */
const phases = [
  "initialAuthorityMs",
  "registryMs",
  "poolInitMs",
  "limiterCheckoutMs",
  "limiterTransactionMs",
  "sessionCheckoutMs",
  "sessionBeginMs",
  "realmLockMs",
  "entryRegistryMs",
  "entryAuthorityMs",
  "engineMs",
  "userLockMs",
  "commitRegistryMs",
  "commitAuthorityMs",
  "commitMs",
  "totalMs",
] as const;
export type NativeLatencyPhase = (typeof phases)[number];
export type NativeLatencyOutcome = "active" | "absent" | "unavailable";
export interface NativeLatencyProfile {
  start(): number | null;
  end(phase: NativeLatencyPhase, started: number | null): void;
  finish(outcome: NativeLatencyOutcome): void;
}

/** The Worker binding is platform-owned; customer headers cannot enable this. */
export function nativeLatencyEnabled(
  flag: unknown,
  scope: { readonly projectId: string; readonly environmentId: string },
): boolean {
  return (
    flag === "c5-development-v1" &&
    scope.projectId === "01M6PG6R7A0B8YJ9PBMZ9AB565" &&
    scope.environmentId === "01M6PG6R7A0B8YJ9PBMZ9AB56A"
  );
}

export function createNativeLatencyProfile(
  input: {
    readonly clock?: () => number;
    readonly emit?: (record: string) => void;
  } = {},
): NativeLatencyProfile {
  const clock = input.clock ?? (() => performance.now());
  const emit = input.emit ?? ((record: string) => console.log(record));
  const durations = Object.fromEntries(phases.map((phase) => [phase, null])) as Record<
    NativeLatencyPhase,
    number | null
  >;
  const start = () => {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const end = (phase: NativeLatencyPhase, started: number | null) => {
    try {
      if (started === null || !phases.includes(phase)) return;
      const elapsed = clock() - started;
      if (Number.isFinite(elapsed) && elapsed >= 0) durations[phase] = elapsed;
    } catch {
      // Measurement must never affect authentication.
    }
  };
  const initial = start();
  let finished = false;
  return {
    start,
    end,
    finish(outcome) {
      try {
        if (finished) return;
        finished = true;
        end("totalMs", initial);
        // Nested timings overlap and are not additive. No scope or request content is emitted.
        const safeOutcome = ["active", "absent", "unavailable"].includes(outcome)
          ? outcome
          : "unavailable";
        emit(
          JSON.stringify({
            kind: "native_private_latency_v1",
            outcome: safeOutcome,
            timingsAreNonAdditive: true,
            durations,
          }),
        );
      } catch {
        // Logging must never affect authentication.
      }
    },
  };
}

/** Instrumentation must not replace either a successful result or its original error. */
export function startNativeLatency(profile: NativeLatencyProfile | undefined): number | null {
  try {
    return profile?.start() ?? null;
  } catch {
    return null;
  }
}
export function endNativeLatency(
  profile: NativeLatencyProfile | undefined,
  phase: NativeLatencyPhase,
  started: number | null,
): void {
  try {
    profile?.end(phase, started);
  } catch {
    // Instrumentation is always non-authoritative.
  }
}

export interface NativeLatencyRequest {
  readonly kind: "native_private_latency_request_v2";
}
export interface NativeLatencyEnvelope {
  readonly kind: "native_private_session_v2";
  readonly status: NativeLatencyOutcome;
  readonly session: import("@ohmyhost/contracts/native-auth").NativeAuthSession | null;
  readonly profile: Record<NativeLatencyPhase, number | null> | null;
}

/** A private diagnostic request is closed; arbitrary extra properties never enable profiling. */
export function isNativeLatencyRequest(value: unknown): value is NativeLatencyRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).join(",") === "kind" &&
    Reflect.get(value, "kind") === "native_private_latency_request_v2"
  );
}

/** Rebuild the complete closed numeric shape; never forward arbitrary RPC content. */
export function nativeLatencyDurations(
  value: unknown,
): Record<NativeLatencyPhase, number | null> | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...phases].sort().join(",")
    )
      return null;
    const result = {} as Record<NativeLatencyPhase, number | null>;
    for (const phase of phases) {
      const item: unknown = Reflect.get(value, phase);
      if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0))
        return null;
      result[phase] = item as number | null;
    }
    return result;
  } catch {
    return null;
  }
}

/** Parse only a capture from this request's recorder and match it to the actual auth outcome. */
export function nativeCapturedDurations(
  value: unknown,
  outcome: NativeLatencyOutcome,
): Record<NativeLatencyPhase, number | null> | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "durations,kind,outcome,timingsAreNonAdditive" ||
      Reflect.get(value, "kind") !== "native_private_latency_v1" ||
      Reflect.get(value, "outcome") !== outcome ||
      Reflect.get(value, "timingsAreNonAdditive") !== true
    )
      return null;
    return nativeLatencyDurations(Reflect.get(value, "durations"));
  } catch {
    return null;
  }
}

/** Old Durable Objects return the existing DTO/null; only a closed v2 envelope is decoded. */
export function unwrapNativeLatencySession(
  value: unknown,
  emit: (record: string) => void = (record) => console.log(record),
  outerDuration?: () => number | null,
): import("@ohmyhost/contracts/native-auth").NativeAuthSession | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("auth_unavailable");
  if (!Object.hasOwn(value, "kind"))
    return value as import("@ohmyhost/contracts/native-auth").NativeAuthSession;
  if (
    Object.keys(value).sort().join(",") !== "kind,profile,session,status" ||
    Reflect.get(value, "kind") !== "native_private_session_v2"
  )
    throw new Error("auth_unavailable");
  const status: unknown = Reflect.get(value, "status");
  const candidate: unknown = Reflect.get(value, "session");
  if (status !== "active" && status !== "absent" && status !== "unavailable")
    throw new Error("auth_unavailable");
  let result: import("@ohmyhost/contracts/native-auth").NativeAuthSession | null = null;
  if (status === "active") {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "session,user"
    )
      throw new Error("auth_unavailable");
    const user: unknown = Reflect.get(candidate, "user");
    const session: unknown = Reflect.get(candidate, "session");
    if (
      typeof user !== "object" ||
      user === null ||
      Array.isArray(user) ||
      Object.keys(user).sort().join(",") !== "email,id" ||
      typeof session !== "object" ||
      session === null ||
      Array.isArray(session) ||
      Object.keys(session).sort().join(",") !== "expiresAt,id"
    )
      throw new Error("auth_unavailable");
    const userId: unknown = Reflect.get(user, "id");
    const email: unknown = Reflect.get(user, "email");
    const sessionId: unknown = Reflect.get(session, "id");
    const expiresAt: unknown = Reflect.get(session, "expiresAt");
    if (
      typeof userId !== "string" ||
      !userId ||
      typeof email !== "string" ||
      !email ||
      typeof sessionId !== "string" ||
      !sessionId ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt))
    )
      throw new Error("auth_unavailable");
    result = { user: { id: userId, email }, session: { id: sessionId, expiresAt } };
  } else if (candidate !== null) throw new Error("auth_unavailable");
  try {
    const durations = nativeLatencyDurations(Reflect.get(value, "profile"));
    let outerServiceMs: number | null = null;
    if (outerDuration !== undefined) {
      try {
        const elapsed = outerDuration();
        if (typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0)
          outerServiceMs = elapsed;
      } catch {
        /* Diagnostics must not affect authentication. */
      }
    }
    if (durations)
      emit(
        JSON.stringify({
          kind:
            outerDuration === undefined ? "native_private_latency_v2" : "native_private_latency_v3",
          ...(outerDuration === undefined ? {} : { outerServiceMs }),
          outcome: status,
          timingsAreNonAdditive: true,
          durations,
        }),
      );
  } catch {
    // Malformed profiling data or a failed logger cannot replace the auth result.
  }
  if (status === "unavailable") throw new Error("auth_unavailable");
  return result;
}
