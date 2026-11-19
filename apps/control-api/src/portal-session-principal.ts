import type { Clock } from "@ohmyhost/platform";
import type { WorkosTokenVerificationPolicy } from "@ohmyhost/workos-token-verifier";

import { openBrowserSession } from "./browser-session.js";
import type { BearerAuthenticator } from "./contracts.js";

/** The portal cookie lives seven days; its access token is renewed only when the portal itself is visited. */
const PORTAL_SESSION_SECONDS = 7 * 24 * 60 * 60;

/**
 * The one policy for an access token read out of the sealed portal cookie. WorkOS access tokens live for minutes, so
 * by the time a customer returns from GitHub or Cloudflare the token in the cookie has usually expired while the
 * session behind it is live. The cookie is encrypted and origin-bound by the portal, so the token is accepted for as
 * long as the cookie is; the live session-status check, not `exp`, decides whether the session still exists.
 */
export function createPortalSessionTokenPolicies(bindings: {
  readonly WORKOS_ISSUER: string;
  readonly WORKOS_CLIENT_ID: string;
}): readonly WorkosTokenVerificationPolicy[] {
  return Object.freeze([
    Object.freeze({
      kind: "session" as const,
      issuer: bindings.WORKOS_ISSUER,
      clientId: bindings.WORKOS_CLIENT_ID,
      clockSkewSeconds: PORTAL_SESSION_SECONDS,
      maximumTokenAgeSeconds: PORTAL_SESSION_SECONDS,
    }),
  ]);
}

/**
 * Who is signed in to the portal in this browser: the user behind the sealed `__Host-omh-session` cookie, or null.
 * `authentication` verifies the cookie's token with `createPortalSessionTokenPolicies` and checks the WorkOS session
 * live. The cookie is SameSite=Lax, so the browser sends it on the top-level redirect back from GitHub or Cloudflare.
 */
export function createPortalSessionPrincipal(input: {
  readonly sessionPassword: string;
  readonly origin: string;
  readonly clock: Clock;
  readonly authentication: BearerAuthenticator;
}): (request: Request) => Promise<string | null> {
  return async (request) => {
    const session = await openBrowserSession(
      request.headers.get("cookie"),
      input.sessionPassword,
      input.origin,
      input.clock.now().getTime(),
    );
    if (session === null) return null;
    const principal = await input.authentication.authenticate(session.accessToken);
    return principal?.session === undefined ? null : principal.actorId;
  };
}
