import {
  createNativeAuthServer,
  NativeAuthRequiredError,
  type NativeAuthBinding,
} from "@ohmyhost/customer-runtime/auth-server";
import { browserScript, providers } from "../browser-bundle.js";

const headers = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Native Auth canary</title><h1>Native Auth canary</h1>
<p>Use only the authorized disposable test accounts. Tokens from mail stay in this browser.</p>
<form id="auth" method="post" action="/"><label>Email <input name="email" type="email" autocomplete="username"></label><br>
<label>Name <input name="name" autocomplete="name"></label><br>
<label>Password <input name="password" type="password" autocomplete="current-password"></label><br>
<label>Mail token <input name="token" type="password" autocomplete="off"></label><br>
<button value="signup">Sign up</button><button value="verify">Verify email</button><button value="send-verification">Resend verification</button>
<button value="login">Sign in</button><button value="logout">Sign out</button><button value="request-reset">Request reset</button>
<button value="reset">Reset password</button><button value="invite">Accept invitation</button><button value="reauth">Reauthenticate</button>
<button value="recovery">Enroll recovery</button><button value="protected">Protected read</button>
${providers.google ? '<button value="google">Google sign in</button><button value="link-google">Link Google</button><button value="reauth-google">Reauthenticate Google</button>' : ""}
${providers.github ? '<button value="github">GitHub sign in</button><button value="link-github">Link GitHub</button><button value="reauth-github">Reauthenticate GitHub</button>' : ""}</form>
<pre id="result" role="status"></pre><script type="module" src="/canary.js"></script></html>`;

export default {
  async fetch(request: Request, env: { OHMYHOST_AUTH: NativeAuthBinding }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response(null, { status: 405, headers });
    if (url.pathname === "/health") return Response.json({ status: "ok" }, { headers });
    if (["/", "/login", "/reset-password", "/accept-invitation"].includes(url.pathname))
      return new Response(html, {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    if (url.pathname === "/canary.js")
      return new Response(browserScript, {
        headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
      });
    if (url.pathname === "/protected") {
      try {
        const user = await createNativeAuthServer(env.OHMYHOST_AUTH).requireUser(request);
        return Response.json({ id: user.id, email: user.email }, { headers });
      } catch (error) {
        if (error instanceof NativeAuthRequiredError)
          return Response.json({ error: "authentication_required" }, { status: 401, headers });
        return Response.json({ error: "authentication_unavailable" }, { status: 503, headers });
      }
    }
    return new Response(null, { status: 404, headers });
  },
};
