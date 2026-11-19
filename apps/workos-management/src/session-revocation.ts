import type { WorkosSessionRevocationIdentityPort } from "./identity-port.js";
import { readJson } from "./workos-readonly-transport.js";

export class SessionRevocationError extends Error {
  constructor(public readonly code: "invalid_request" | "forbidden" | "service_unavailable") {
    super(code);
  }
}

/** The private caller supplies identities from the verified current access token, never client input. */
export function createWorkosSessionRevocation(input: {
  readonly identity: WorkosSessionRevocationIdentityPort;
  readonly credential: string;
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
}) {
  const requestProvider = async (path: string, body?: object) => {
    const response = await input.fetcher(
      new Request(`https://api.workos.com${path}`, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${input.credential}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new SessionRevocationError("service_unavailable");
    }
    return response;
  };
  const active = async (userId: string, sessionId: string) => {
    let after: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) });
      const result: unknown = await readJson(
        await requestProvider(`/user_management/users/${userId}/sessions?${query}`),
        65_536,
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new SessionRevocationError("service_unavailable");
      const value = result as {
        data?: { id: string; user_id: string; status: string }[];
        list_metadata?: { after?: string | null };
      };
      if (
        !Array.isArray(value.data) ||
        value.data.some(
          (session) =>
            !session ||
            typeof session.id !== "string" ||
            session.user_id !== userId ||
            !["active", "revoked", "expired"].includes(session.status),
        ) ||
        !value.list_metadata ||
        !("after" in value.list_metadata)
      )
        throw new SessionRevocationError("service_unavailable");
      const session = value.data.find((session) => session.id === sessionId);
      if (session) return session.status === "active";
      after = value.list_metadata.after ?? null;
      if (after === null) return false;
      if (typeof after !== "string" || after.length > 128 || seen.has(after))
        throw new SessionRevocationError("service_unavailable");
      seen.add(after);
    }
    throw new SessionRevocationError("service_unavailable");
  };
  return {
    async revoke(value: unknown): Promise<{ revoked: true }> {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new SessionRevocationError("invalid_request");
      const request = value as { userId: string; sessionId: string };
      if (
        Object.keys(request).sort().join(",") !== "sessionId,userId" ||
        typeof request.userId !== "string" ||
        !/^user_[A-Za-z0-9_]{1,123}$/u.test(request.userId) ||
        typeof request.sessionId !== "string" ||
        !/^session_[A-Za-z0-9_]{1,120}$/u.test(request.sessionId)
      )
        throw new SessionRevocationError("invalid_request");
      try {
        const previous = await input.identity.readSessionRevocation({
          sessionId: request.sessionId,
        });
        if (previous !== null) {
          if (previous.workosUserId !== request.userId)
            throw new SessionRevocationError("forbidden");
          return { revoked: true };
        }
        if (!(await active(request.userId, request.sessionId)))
          throw new SessionRevocationError("forbidden");
        const response = await requestProvider("/user_management/sessions/revoke", {
          session_id: request.sessionId,
        });
        await response.body?.cancel();
        if (await active(request.userId, request.sessionId))
          throw new SessionRevocationError("service_unavailable");
        await input.identity.recordTerminalRevocation({
          kind: "session",
          sessionId: request.sessionId,
          workosUserId: request.userId,
          sourceEventId: `logout:${input.ids.next()}`,
          effectiveAt: input.clock.now().toISOString(),
        });
        return { revoked: true };
      } catch (error) {
        if (error instanceof SessionRevocationError) throw error;
        throw new SessionRevocationError("service_unavailable");
      }
    },
  };
}
