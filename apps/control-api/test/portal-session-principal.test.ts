import { readdirSync, readFileSync } from "node:fs";
import { parseUlid } from "@ohmyhost/platform";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { closeBrowserSession } from "../src/browser-session.js";
import { AuthenticationUnavailableError } from "../src/contracts.js";
import {
  createPortalSessionPrincipal,
  createPortalSessionTokenPolicies,
} from "../src/portal-session-principal.js";
import { createWorkosBearerAuthenticator } from "../src/workos-authenticator.js";

const ISSUER = "https://api.workos.com/user_management/client_host";
const CLIENT = "client_host";
const ORIGIN = "https://dev.app.ohmyho.st";
const PASSWORD = "portal-session-password-0123456789abcdef";
const ORGANIZATION = parseUlid("00000000000000000000000001");
const DAY = 24 * 60 * 60;
const encode = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

let keys: CryptoKeyPair;
let jwks: { keys: unknown[] };
beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwks = {
    keys: [
      {
        ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
        kid: "portal-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
});
afterEach(() => vi.restoreAllMocks());

async function sign(claims: Record<string, unknown>) {
  const header = encode(JSON.stringify({ alg: "RS256", kid: "portal-key", typ: "JWT" })),
    body = encode(JSON.stringify(claims)),
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(`${header}.${body}`),
    );
  return `${header}.${body}.${encode(new Uint8Array(signature))}`;
}
/** A WorkOS session access token issued `age` seconds ago, expiring after `lifetime` (default five minutes). */
const sessionToken = (age = 0, extra: Record<string, unknown> = {}, lifetime = 300) =>
  sign({
    iss: ISSUER,
    sub: "user_1",
    client_id: CLIENT,
    org_id: "org_1",
    sid: "session_1",
    iat: now() - age,
    exp: now() - age + lifetime,
    ...extra,
  });
const cookieFor = async (
  accessToken: string,
  { createdAt = Date.now() - 1000, origin = ORIGIN } = {},
) =>
  (
    await closeBrowserSession(
      {
        accessToken,
        refreshToken: "refresh-token",
        csrf: "c".repeat(43),
        origin,
        createdAt,
        organizationId: null,
      },
      PASSWORD,
    )
  ).split(";")[0] ?? "";
const callback = (cookie?: string) =>
  new Request(`${ORIGIN}/v1/github/oauth/callback?state=s`, {
    headers: cookie === undefined ? {} : { cookie },
  });
/** The reader exactly as the Worker composes it, over a session-status check the test controls. */
function portal(isActive: (input: unknown) => Promise<boolean>) {
  return createPortalSessionPrincipal({
    sessionPassword: PASSWORD,
    origin: ORIGIN,
    clock: { now: () => new Date() },
    authentication: createWorkosBearerAuthenticator({
      policies: createPortalSessionTokenPolicies({
        WORKOS_ISSUER: ISSUER,
        WORKOS_CLIENT_ID: CLIENT,
      }),
      verifier: { jwks: { load: async () => jwks }, clock: { now: () => new Date() } },
      organizations: {
        resolve: async (id) => (id === "org_1" ? ORGANIZATION : null),
        resolveM2m: async () => null,
      },
      sessionStatus: { isActive: isActive as never },
    }),
  });
}

it("names the user behind a live session even when the cookie's access token expired, and fails closed otherwise", async () => {
  const active = vi.fn(async () => true);
  const read = portal(active);
  // Fresh, expired an hour ago and expired six days ago: the session, not `exp`, decides.
  for (const age of [0, 3600, 6 * DAY]) {
    expect(await read(callback(await cookieFor(await sessionToken(age))))).toBe("user:user_1");
  }
  expect(active).toHaveBeenLastCalledWith({
    sessionId: "session_1",
    userId: "user_1",
    organizationId: "org_1",
    tokenExpiresAt: now() - 6 * DAY + 300,
  });

  // A token whose expiry is more than the cookie's seven days gone is not read at all.
  active.mockClear();
  expect(await read(callback(await cookieFor(await sessionToken(8 * DAY))))).toBeNull();
  expect(active).not.toHaveBeenCalled();

  // An ended session is nobody, however fresh the token looks.
  expect(await portal(async () => false)(callback(await cookieFor(await sessionToken())))).toBe(
    null,
  );

  // A session-status outage is the authentication-unavailable error, never an answer. The callback routes turn it
  // into a 503 before any state is read.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const outage = portal(async () => {
    throw new Error("auth-status unavailable");
  });
  await expect(outage(callback(await cookieFor(await sessionToken())))).rejects.toBeInstanceOf(
    AuthenticationUnavailableError,
  );
});

it("takes a person only from a sealed cookie holding a live session token of this client", async () => {
  const active = vi.fn(async () => true);
  const read = portal(active);
  const sealed = (accessToken: string) => cookieFor(accessToken);
  const refused = [
    // Another client or another issuer.
    await sealed(await sessionToken(0, { client_id: "client_other" })),
    await sealed(await sessionToken(0, { iss: "https://api.workos.com/user_management/other" })),
    // An M2M token (a client, not a user) and a Connect user token (another client, an audience and a consent).
    await sealed(
      await sign({
        iss: ISSUER,
        sub: "client_1",
        aud: "control-api",
        org_id: "org_1",
        scope: "projects:write",
        iat: now(),
        exp: now() + 300,
      }),
    ),
    await sealed(
      await sign({
        iss: ISSUER,
        sub: "user_1",
        aud: `${ORIGIN}/mcp`,
        client_id: "client_chat",
        sid: "app_consent_chat",
        scope: "openid",
        iat: now(),
        exp: now() + 300,
      }),
    ),
    // A session token with no session and an API key.
    await sealed(await sessionToken(0, { sid: undefined })),
    await sealed(`sk_${"a".repeat(30)}`),
  ];
  for (const cookie of refused) expect(await read(callback(cookie))).toBeNull();
  expect(active).not.toHaveBeenCalled();
  // A live session of a workspace the platform does not know is nobody either.
  expect(
    await read(callback(await sealed(await sessionToken(0, { org_id: "org_unmapped" })))),
  ).toBeNull();
  active.mockClear();

  // The cookie itself: absent, garbled, older than seven days, or sealed for another origin.
  const valid = await sessionToken();
  for (const cookie of [
    undefined,
    "__Host-omh-session=Fe26.2*not-a-real-seal~2",
    await cookieFor(valid, { createdAt: Date.now() - 8 * DAY * 1000 }),
    await cookieFor(valid, { origin: "https://other.example" }),
  ])
    expect(await read(callback(cookie))).toBeNull();
  expect(active).not.toHaveBeenCalled();
  expect(await read(callback(await cookieFor(valid)))).toBe("user:user_1");

  // A missing session password is a configuration fault, not "signed out".
  await expect(
    createPortalSessionPrincipal({
      sessionPassword: "",
      origin: ORIGIN,
      clock: { now: () => new Date() },
      authentication: { authenticate: async () => null },
    })(callback(await cookieFor(valid))),
  ).rejects.toThrow("Session configuration unavailable");
});

it("uses one seven-day portal-cookie policy for provider callbacks and connection consent", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((name) =>
    name.endsWith(".ts"),
  );
  // The policy is built in exactly one place, the Worker's portal cookie reader.
  expect(
    files.filter((name) => source(name).includes("createPortalSessionTokenPolicies")).sort(),
  ).toEqual(["portal-session-principal.ts", "worker-main.ts"]);
  const worker = source("worker-main.ts");
  expect(worker.match(/createPortalSessionTokenPolicies\(/gu)).toHaveLength(1);
  expect(worker).toMatch(
    /const portalAuthentication = createWorkosBearerAuthenticator\(\{\s*policies: createPortalSessionTokenPolicies\(/su,
  );
  expect(worker).toMatch(
    /createPortalSessionPrincipal\(\{[^}]*authentication: portalAuthentication/su,
  );
  expect(worker).toMatch(
    /if \(connectionPortalPath\) \{[\s\S]*?authenticate: async \(req\) => \{[\s\S]*?const session = await openBrowserSession\([\s\S]*?const principal = await portalAuthentication\.authenticate\(session\.accessToken\)/u,
  );
  expect(worker).toMatch(
    /const authentication = createWorkosBearerAuthenticator\(\{\s*apiKeys:[\s\S]*?policies: createWorkosTokenPolicies\(/u,
  );
  // The callback principal reader remains limited to the two provider callback handlers.
  expect(files.filter((name) => source(name).includes("portalSessionPrincipal")).sort()).toEqual([
    "app.ts",
    "contracts.ts",
    "worker-main.ts",
  ]);
  const app = source("app.ts"),
    routes = [...app.matchAll(/^ {2}app\.[a-z]+\(\s*"([^"]+)"/gmu)].map((match) => ({
      path: match[1],
      at: match.index ?? 0,
    }));
  const readers = [...app.matchAll(/portalSessionPrincipal/gu)].map(
    (match) => routes.filter((route) => route.at < (match.index ?? 0)).at(-1)?.path,
  );
  expect(readers.length).toBeGreaterThan(0);
  expect(new Set(readers)).toEqual(
    new Set(["/v1/cloudflare/oauth/callback", "/v1/github/oauth/callback"]),
  );
});
