interface ProviderKey {
  readonly id: string;
  readonly user: string;
  readonly body: Record<string, unknown>;
}

/** Provider key ids are unique across fake instances: the Core store keeps every provider key id unique. */
let keySequence = 0;

/** The WorkOS provider at the outbound boundary: API keys and sessions, with injectable failures. */
export function provider() {
  const state = {
    posts: [] as string[],
    keys: [] as ProviderKey[],
    sessions: [] as { id: string; user_id: string; status: "active" | "revoked" }[],
    loseNextCreateResponse: false,
    failNextPermissionRead: false,
    beforeCreate: undefined as undefined | (() => Promise<void>),
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const keyView = (key: ProviderKey) => ({
    object: "api_key",
    id: key.id,
    owner: {
      type: "user",
      id: key.user,
      organization_id: key.body["organization_id"],
    },
    name: key.body["name"],
    obfuscated_value: "sk_...abcd",
    permissions: key.body["permissions"],
    expires_at: key.body["expires_at"] ?? null,
    created_at: "2026-10-28T12:00:00.000Z",
    last_used_at: null,
  });
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== "Bearer test-workos-management")
      return json({}, 401);
    if (request.method !== "GET") state.posts.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname.startsWith("/authorization/permissions/")) {
      if (state.failNextPermissionRead) {
        state.failNextPermissionRead = false;
        return json({ error: "unavailable" }, 503);
      }
      const slug = decodeURIComponent(url.pathname.slice("/authorization/permissions/".length));
      if (slug === "auth:read" || slug === "auth:manage")
        return json({ object: "permission", id: "perm_test", slug });
      return json({}, 404);
    }
    const keysPath = /^\/user_management\/users\/(user_[A-Za-z0-9_]+)\/api_keys$/u.exec(
      url.pathname,
    );
    if (keysPath !== null && request.method === "POST") {
      await state.beforeCreate?.();
      const body = (await request.json()) as Record<string, unknown>;
      const key = { id: `api_key_${++keySequence}`, user: keysPath[1] as string, body };
      state.keys.push(key);
      if (state.loseNextCreateResponse) {
        state.loseNextCreateResponse = false;
        return json({ error: "lost" }, 500);
      }
      return json({ ...keyView(key), value: `sk_${"a".repeat(32)}` }, 201);
    }
    if (keysPath !== null) {
      return json({
        object: "list",
        data: state.keys.filter((key) => key.user === keysPath[1]).map(keyView),
        list_metadata: { after: null },
      });
    }
    const revoke = /^\/api_keys\/(api_key_\d+)$/u.exec(url.pathname);
    if (revoke !== null && request.method === "DELETE") {
      const index = state.keys.findIndex((key) => key.id === revoke[1]);
      if (index >= 0) state.keys.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    const sessions = /^\/user_management\/users\/(user_[A-Za-z0-9_]+)\/sessions$/u.exec(
      url.pathname,
    );
    if (sessions !== null) {
      return json({
        data: state.sessions.filter(
          (session) => session.user_id === sessions[1] && session.status === "active",
        ),
        list_metadata: { before: null, after: null },
      });
    }
    if (url.pathname === "/user_management/sessions/revoke" && request.method === "POST") {
      const input = (await request.json()) as { session_id: string };
      const session = state.sessions.find((candidate) => candidate.id === input.session_id);
      if (session === undefined) return json({}, 404);
      session.status = "revoked";
      return new Response(null, { status: 204 });
    }
    return json({}, 404);
  };
  return { state, handle };
}
