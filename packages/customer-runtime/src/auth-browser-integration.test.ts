import { afterEach, expect, it, vi } from "vitest";
import { createNativeAuthBrowser } from "./auth-browser.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps verification and credential changes on the same-origin maintained client and returns server denials without retrying", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    addEventListener() {},
    removeEventListener() {},
  });
  const user = {
    id: "self-user",
    email: "self@example.test",
    emailVerified: true,
    name: "Self",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith("verify-email"))
      return url.searchParams.get("token") === "expired-verification"
        ? Response.json({ code: "TOKEN_EXPIRED", message: "Verification expired" }, { status: 400 })
        : Response.json({ status: true });
    if (url.pathname.endsWith("change-password"))
      return body.currentPassword === "incorrect-current"
        ? Response.json(
            { code: "INVALID_PASSWORD", message: "Password is invalid" },
            { status: 401 },
          )
        : Response.json({ token: null, user });
    if (url.pathname.endsWith("unlink-account"))
      return body.accountId === "last-login-method"
        ? Response.json(
            { code: "LAST_LOGIN_METHOD", message: "Keep a login method" },
            { status: 400 },
          )
        : Response.json({ status: true });
    throw new Error("Unexpected Native browser route");
  });
  vi.stubGlobal("fetch", fetcher);
  const client = createNativeAuthBrowser();
  const expired = await client.verifyEmail(
    { query: { token: "expired-verification" }, fetchOptions: { retry: 2 } },
    { retry: 2 },
  );
  expect(expired.data).toBeNull();
  expect(expired.error).toMatchObject({ code: "TOKEN_EXPIRED", status: 400 });
  const verified = await client.verifyEmail({
    query: { token: "valid-verification", callbackURL: "/login" },
  });
  expect(verified.data).toEqual({ status: true });
  const wrongPassword = await client.changePassword(
    {
      currentPassword: "incorrect-current",
      newPassword: "new-password-value",
      revokeOtherSessions: true,
      fetchOptions: { retry: 2 },
    },
    { retry: 2 },
  );
  expect(wrongPassword.data).toBeNull();
  expect(wrongPassword.error).toMatchObject({ code: "INVALID_PASSWORD", status: 401 });
  const changed = await client.changePassword({
    currentPassword: "correct-current",
    newPassword: "new-password-value",
    revokeOtherSessions: true,
  });
  expect(changed.data?.user.id).toBe(user.id);
  expect(changed.data?.token).toBeNull();
  const refused = await client.unlinkAccount(
    { accountId: "last-login-method", fetchOptions: { retry: 2 } },
    { retry: 2 },
  );
  expect(refused.data).toBeNull();
  expect(refused.error).toMatchObject({ code: "LAST_LOGIN_METHOD", status: 400 });
  expect((await client.unlinkAccount({ accountId: "linked-google-account" })).data).toEqual({
    status: true,
  });
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(fetcher.mock.calls.map(([url, init]) => [url.origin, url.pathname, init.method])).toEqual([
    ["https://app.example.test", "/api/auth/v1/verify-email", "GET"],
    ["https://app.example.test", "/api/auth/v1/verify-email", "GET"],
    ["https://app.example.test", "/api/auth/v1/change-password", "POST"],
    ["https://app.example.test", "/api/auth/v1/change-password", "POST"],
    ["https://app.example.test", "/api/auth/v1/unlink-account", "POST"],
    ["https://app.example.test", "/api/auth/v1/unlink-account", "POST"],
  ]);
  const verification = fetcher.mock.calls[1];
  const passwordChange = fetcher.mock.calls[3];
  const unlink = fetcher.mock.calls[5];
  if (!verification || !passwordChange || !unlink) throw new Error("Missing Native browser call");
  expect(verification[0].searchParams.get("token")).toBe("valid-verification");
  expect(verification[0].searchParams.get("callbackURL")).toBe("/login");
  expect(JSON.parse(String(passwordChange[1].body))).toEqual({
    currentPassword: "correct-current",
    newPassword: "new-password-value",
    revokeOtherSessions: true,
  });
  expect(JSON.parse(String(unlink[1].body))).toEqual({ accountId: "linked-google-account" });
  expect(fetcher.mock.calls.every(([, init]) => init.credentials === "same-origin")).toBe(true);
  expect(JSON.stringify(wrongPassword.error)).not.toContain("new-password-value");
});

it("sends session reads to the same-origin gateway with browser cookies enabled", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    addEventListener() {},
    removeEventListener() {},
  });
  let recoveryAvailable: boolean | null = null;
  const fetcher = vi.fn(async () =>
    Response.json(
      recoveryAvailable === null
        ? null
        : {
            user: {
              id: "self-user",
              email: "self@example.test",
              emailVerified: true,
              recoveryAvailable,
            },
            session: { id: "self-session", userId: "self-user", expiresAt: "2026-11-11T00:00:00Z" },
          },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = createNativeAuthBrowser();
  expect((await client.getSession()).data).toBeNull();
  for (const available of [false, true]) {
    recoveryAvailable = available;
    const session = (await client.getSession()).data;
    expect(session?.user.emailVerified).toBe(true);
    expect(session?.user.recoveryAvailable).toBe(available);
  }
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(String(url)).toBe("https://app.example.test/api/auth/v1/get-session");
  expect(options.credentials).toBe("same-origin");
});

it("uses the frozen custom routes through the maintained client", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    addEventListener() {},
    removeEventListener() {},
  });
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    void init;
    return Response.json(
      url.pathname.endsWith("accept-invitation")
        ? { status: "accepted" }
        : url.pathname.endsWith("reauthenticate")
          ? { authenticatedAt: "2026-11-04T00:00:00Z" }
          : { status: "sent" },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const client = createNativeAuthBrowser();
  expect(
    (
      await client.acceptInvitation(
        { token: "token", password: "password" },
        { idempotencyKey: "invite-key" },
      )
    ).data,
  ).toEqual({
    status: "accepted",
  });
  expect((await client.reauthenticate({ password: "password" })).data).toEqual({
    authenticatedAt: "2026-11-04T00:00:00.000Z",
  });
  expect((await client.enrollRecovery()).data).toEqual({ status: "sent" });
  expect(fetcher.mock.calls.map(([url]) => url.pathname)).toEqual([
    "/api/auth/v1/accept-invitation",
    "/api/auth/v1/reauthenticate",
    "/api/auth/v1/enroll-recovery",
  ]);
  expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get("idempotency-key")).toBe("invite-key");
  expect(new Headers(fetcher.mock.calls[2]?.[1].headers).get("idempotency-key")).toMatch(
    /^[0-9a-f-]{36}$/u,
  );
});

it("adds mail-operation identities and preserves an explicit key for retries", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    addEventListener() {},
    removeEventListener() {},
  });
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    void url;
    void init;
    return Response.json({ status: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = createNativeAuthBrowser();
  await client.signUp.email({ email: "user@example.test", password: "password", name: "User" });
  await client.sendVerificationEmail({ email: "user@example.test" }, { onRequest() {} });
  await client.requestPasswordReset(
    { email: "user@example.test" },
    { headers: { "Idempotency-Key": "retained-key" } },
  );
  const headers = fetcher.mock.calls.map(([, init]) =>
    new Headers(init.headers).get("idempotency-key"),
  );
  expect(headers[0]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(headers[1]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(headers[0]).not.toBe(headers[1]);
  expect(headers[2]).toBe("retained-key");
});

it("does not automatically retry an uncertain mail operation with a new identity", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    addEventListener() {},
    removeEventListener() {},
  });
  const fetcher = vi.fn(async () => Response.json({ code: "auth_unavailable" }, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  await createNativeAuthBrowser().requestPasswordReset(
    { email: "user@example.test" },
    { retry: 1 },
  );
  await createNativeAuthBrowser().requestPasswordReset({
    email: "user@example.test",
    fetchOptions: { retry: 1 },
  });
  await createNativeAuthBrowser().signIn.email({
    email: "user@example.test",
    password: "password",
    fetchOptions: { retry: 1 },
  });
  await createNativeAuthBrowser().resetPassword({
    newPassword: "password",
    token: "token",
    fetchOptions: { retry: 1 },
  });
  await createNativeAuthBrowser().signOut({ fetchOptions: { retry: 1 } });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("passes invitation intent to social login without accepting client-selected OAuth scopes", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    addEventListener() {},
    removeEventListener() {},
  });
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    void url;
    void init;
    return Response.json({ url: "https://provider.example/authorize", redirect: false });
  });
  vi.stubGlobal("fetch", fetcher);
  await createNativeAuthBrowser().signIn.social({
    provider: "github",
    invitationToken: "invite",
    disableRedirect: true,
    scopes: ["repo"],
  } as never);
  const first = fetcher.mock.calls[0];
  if (!first) throw new Error("Missing social request");
  const [url, init] = first;
  expect(url.pathname).toBe("/api/auth/v1/sign-in/social");
  expect(JSON.parse(String(init.body))).toEqual({
    provider: "github",
    invitationToken: "invite",
    disableRedirect: true,
  });
  await createNativeAuthBrowser().reauthenticate({ provider: "google", callbackURL: "/settings" });
  const second = fetcher.mock.calls[1];
  if (!second) throw new Error("Missing reauthentication request");
  const [reauthUrl, reauthInit] = second;
  expect(reauthUrl.pathname).toBe("/api/auth/v1/reauthenticate");
  expect(JSON.parse(String(reauthInit.body))).toEqual({
    provider: "google",
    callbackURL: "/settings",
  });
  await createNativeAuthBrowser().linkSocial({
    provider: "github",
    callbackURL: "/settings",
    scopes: ["repo"],
    idToken: "untrusted",
  } as never);
  const third = fetcher.mock.calls[2];
  if (!third) throw new Error("Missing link request");
  const [linkUrl, linkInit] = third;
  expect(linkUrl.pathname).toBe("/api/auth/v1/link-social");
  expect(JSON.parse(String(linkInit.body))).toEqual({
    provider: "github",
    callbackURL: "/settings",
  });
});
