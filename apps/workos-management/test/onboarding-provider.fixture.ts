import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";

export async function onboardingProvider(loseMembershipResponse = false) {
  const posts: string[] = [];
  const organizations = new Map<string, Record<string, unknown>>();
  const memberships: Record<string, unknown>[] = [];
  const sessions: { id: string; user_id: string; status: "active" | "revoked" }[] = [];
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let body = "";
    for await (const chunk of request) body += String(chunk);
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer test-workos-management") {
      response.statusCode = 401;
      response.end("{}");
      return;
    }
    if (request.method === "POST") posts.push(url.pathname);
    if (/^\/user_management\/users\/user_[A-Za-z0-9_]+\/sessions$/u.test(url.pathname)) {
      const userId = url.pathname.split("/")[3];
      response.end(
        JSON.stringify({
          data: sessions.filter(
            (session) => session.user_id === userId && session.status === "active",
          ),
          list_metadata: { before: null, after: null },
        }),
      );
    } else if (/^\/user_management\/users\/user_[A-Za-z0-9_]+$/u.test(url.pathname)) {
      response.end(
        JSON.stringify({
          id: url.pathname.split("/").at(-1),
          first_name: "Test",
          last_name: "User",
          email: "profile@example.invalid",
          email_verified: true,
        }),
      );
    } else if (url.pathname === "/user_management/sessions/revoke" && request.method === "POST") {
      const input = JSON.parse(body) as { session_id: string };
      const session = sessions.find((session) => session.id === input.session_id);
      if (!session) {
        response.statusCode = 404;
        response.end("{}");
      } else {
        session.status = "revoked";
        response.statusCode = 204;
        response.end();
      }
    } else if (url.pathname.startsWith("/organizations/external_id/")) {
      const organization = organizations.get(url.pathname.split("/").at(-1) ?? "");
      if (!organization) {
        response.statusCode = 404;
        response.end("{}");
      } else response.end(JSON.stringify(organization));
    } else if (/^\/organizations\/org_[A-Za-z0-9_]+$/u.test(url.pathname)) {
      const organization = [...organizations.values()].find(
        (candidate) => candidate["id"] === url.pathname.split("/").at(-1),
      );
      if (!organization) {
        response.statusCode = 404;
        response.end("{}");
      } else response.end(JSON.stringify(organization));
    } else if (url.pathname === "/organizations" && request.method === "POST") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const organization = {
        ...parsed,
        id: `org_${String(parsed["external_id"])}`,
        created_at: "2026-09-05T09:59:00.000Z",
        updated_at: "2026-09-05T09:59:00.000Z",
      };
      organizations.set(String(parsed["external_id"]), organization);
      response.statusCode = 201;
      response.end(JSON.stringify(organization));
    } else if (
      url.pathname === "/user_management/organization_memberships" &&
      request.method === "GET"
    ) {
      response.end(
        JSON.stringify({
          data: memberships.filter(
            (item) =>
              (!url.searchParams.has("organization_id") ||
                item["organization_id"] === url.searchParams.get("organization_id")) &&
              item["user_id"] === url.searchParams.get("user_id"),
          ),
          list_metadata: { before: null, after: null },
        }),
      );
    } else if (
      url.pathname === "/user_management/organization_memberships" &&
      request.method === "POST"
    ) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const membership = {
        id: "om_customer",
        organization_id: parsed["organization_id"],
        user_id: parsed["user_id"],
        status: "active",
        roles: [{ slug: parsed["role_slug"] }],
        created_at: "2026-09-05T09:59:00.000Z",
        updated_at: "2026-09-05T09:59:00.000Z",
      };
      memberships.push(membership);
      response.statusCode = loseMembershipResponse ? 503 : 201;
      response.end(
        JSON.stringify(
          loseMembershipResponse ? { message: "Private provider failure" } : membership,
        ),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing provider fixture address");
  return {
    posts,
    sessions,
    fetcher: async (request: Request) => {
      const url = new URL(request.url);
      if (url.origin !== "https://api.workos.com") throw new Error("Unexpected provider origin");
      return fetch(
        new Request(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, request),
      );
    },
    revoke() {
      for (const membership of memberships) membership["status"] = "inactive";
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
