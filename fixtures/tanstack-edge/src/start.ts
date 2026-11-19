import { env } from "cloudflare:workers";
import { createMiddleware, createStart } from "@tanstack/react-start";

type FixtureAuth = {
  validateSession(input: { cookie: string }): Promise<{ user: { id: string } } | null>;
};

function emailHtml(name: string) {
  return `<!doctype html><html lang="en"><body><img src="https://brand.example.test/brand/assets/logo.png" width="194"><p>${name}</p></body></html>`;
}

const hosted = createMiddleware().server(async ({ request, next }) => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/fixture") return Response.json({ api: "tanstack" });
  if (pathname === "/api/email") return Response.json({ html: emailHtml("fixture") });
  if (pathname === "/api/auth/session" || pathname === "/api/private") {
    const auth = (env as unknown as { OHMYHOST_AUTH: FixtureAuth }).OHMYHOST_AUTH;
    const session = await auth.validateSession({ cookie: request.headers.get("cookie") ?? "" });
    return Response.json(
      { user: session?.user.id ?? null },
      { status: pathname === "/api/private" && session === null ? 401 : 200 },
    );
  }
  return next();
});

export const startInstance = createStart(() => ({ requestMiddleware: [hosted] }));
