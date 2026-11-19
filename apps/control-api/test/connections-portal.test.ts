import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  handleConnectionsPortalRequest,
  type ConnectionPortalDependencies,
} from "../src/connections-portal.js";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
const PRINCIPAL = { organizationIds: [] } as unknown as AuthenticatedPrincipal;

const origin = "https://app.ohmyho.st",
  connectOrigin = "https://connect.ohmyho.st",
  opaque = "a".repeat(43),
  csrf = "b".repeat(43);
const handoffHash = createHash("sha256").update(opaque).digest("hex");
const intentCookie = `__Host-omh-connection-handoff=${handoffHash}`;
function fixture() {
  const principal = {
    ...PRINCIPAL,
    actorId: "user:user_test",
    session: {
      sessionId: "session_test",
      userId: "user_test",
      organizationId: "org_test",
      tokenExpiresAt: 2000000000,
    },
  };
  const handoff = {
    userId: "user_test",
    organizationId: "org",
    projectId: "project",
    environmentId: "environment",
    originatingDelegation: { action: "integrations:manage" },
  };
  return {
    origin,
    connectOrigin,
    authenticate: vi.fn(async () => ({ principal, csrf })),
    readHandoff: vi.fn(async () => handoff),
    consumeHandoff: vi.fn(async () => handoff),
    readiness: vi.fn(async () => true),
    begin: vi.fn(async () => ({ url: `${connectOrigin}/oauth/start?handoff=${opaque}` })),
    confirmation: {
      matchesConfirmation: vi.fn(
        async (input: { handoffHash: string }) => input.handoffHash === handoffHash,
      ),
    },
    complete: vi.fn<ConnectionPortalDependencies["complete"]>(async () => ({
      state: "active" as const,
      grantId: "00000000000000000000000002",
      organizationId: "00000000000000000000000001",
      projectId: "00000000000000000000000002",
      environmentId: "00000000000000000000000003",
    })),
  } satisfies ConnectionPortalDependencies;
}
function form(path: string, field: string, token = opaque, originHeader = origin) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin: originHeader, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, [field]: token }),
  });
}
it("requires the same browser and CSRF before consuming a handoff and preserves captured authority", async () => {
  const d = fixture();
  const resumeAfterLogin = vi.fn(async () => Response.redirect(`${origin}/login`, 303));
  const signedOut = { ...d, authenticate: vi.fn(async () => null), resumeAfterLogin };
  for (const path of [
    `/connections/authorize?request=${opaque}`,
    `/connections/complete?result=${opaque}`,
  ]) {
    const response = await handleConnectionsPortalRequest(new Request(origin + path), signedOut);
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(`${origin}/login`);
  }
  expect(d.readHandoff).not.toHaveBeenCalled();
  expect(d.consumeHandoff).not.toHaveBeenCalled();
  expect(d.complete).not.toHaveBeenCalled();
  expect(
    (await handleConnectionsPortalRequest(form("/connections/authorize", "request"), signedOut))
      ?.status,
  ).toBe(401);
  expect(resumeAfterLogin).toHaveBeenCalledTimes(2);
  d.authenticate.mockImplementation(async () => ({
    principal: {
      ...PRINCIPAL,
      actorId: "user:user_test",
      session: {
        sessionId: "session_test",
        userId: "user_test",
        organizationId: "org_test",
        tokenExpiresAt: 2000000000,
      },
    },
    csrf,
    headers: new Headers({ "set-cookie": "refresh=one" }),
  }));
  const display = await handleConnectionsPortalRequest(
    new Request(`${origin}/connections/authorize?request=${opaque}`),
    d,
  );
  expect(display?.status).toBe(200);
  expect(display?.headers.get("referrer-policy")).toBe("strict-origin");
  expect(display?.headers.get("set-cookie")).toBe("refresh=one");
  expect(display?.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  const head = await handleConnectionsPortalRequest(
    new Request(`${origin}/connections/authorize?request=${opaque}`, { method: "HEAD" }),
    d,
  );
  expect(head?.status).toBe(200);
  expect(head?.body).toBeNull();
  expect(head?.headers.get("referrer-policy")).toBe("strict-origin");
  const markup = await display?.text();
  expect(markup).toContain('action="/connections/authorize"');
  expect(markup).toContain('data-provider-icon="make"');
  expect(markup).toContain('src="data:image/png;base64,');
  expect(display?.headers.get("content-security-policy")).toContain(
    "img-src https://ohmyho.st data:",
  );

  expect(d.consumeHandoff).not.toHaveBeenCalled();
  expect(
    (
      await handleConnectionsPortalRequest(
        form("/connections/authorize", "request", opaque, "https://other.example"),
        d,
      )
    )?.status,
  ).toBe(404);
  expect(d.consumeHandoff).not.toHaveBeenCalled();
  expect(
    (
      await handleConnectionsPortalRequest(
        form("/connections/authorize", "request", opaque, "null"),
        d,
      )
    )?.status,
  ).toBe(404);
  expect(d.consumeHandoff).not.toHaveBeenCalled();
  const started = await handleConnectionsPortalRequest(
    form("/connections/authorize", "request"),
    d,
  );
  expect(started?.status).toBe(200);
  expect(started?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(started?.headers.get("cache-control")).toBe("no-store");
  expect(started?.headers.get("content-security-policy")).toContain("form-action 'self'");
  const bridge = await started?.text();
  const target = `${connectOrigin}/oauth/start?handoff=${opaque}`;
  expect(bridge).toContain(`<meta http-equiv="refresh" content="0;url=${target}">`);
  expect(bridge).toContain(`<a class="portal-button secondary" href="${target}" rel="noreferrer">`);
  expect(bridge).not.toContain("<script");
  expect(bridge).toContain("Redirecting to Make");
  expect(started?.headers.get("set-cookie")).toContain(
    `${intentCookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1200`,
  );
  expect(d.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      originatingDelegation: { action: "integrations:manage" },
      principalId: "user:user_test",
      sessionId: "session_test",
    }),
  );
  d.consumeHandoff.mockResolvedValueOnce({
    userId: "user_other",
    organizationId: "org",
    projectId: "project",
    environmentId: "environment",
    originatingDelegation: { action: "integrations:manage" },
  });
  expect(
    (await handleConnectionsPortalRequest(form("/connections/authorize", "request"), d))?.status,
  ).toBe(404);
  expect(d.begin).toHaveBeenCalledTimes(1);
  const invalid = fixture();
  invalid.begin.mockResolvedValueOnce({
    url: `https://foreign.example/oauth/start?handoff=${opaque}`,
  });
  const refused = await handleConnectionsPortalRequest(
    form("/connections/authorize", "request"),
    invalid,
  );
  expect(refused?.status).toBe(404);
  const refusedHtml = await refused?.text();
  expect(refusedHtml).not.toContain('http-equiv="refresh"');
  expect(refusedHtml).not.toContain("Back to your workspace");
});
it("confirms the opaque result only after CSRF and refuses unavailable providers before consumption", async () => {
  const d = fixture();
  const display = await handleConnectionsPortalRequest(
    new Request(`${origin}/connections/complete?result=${opaque}`),
    d,
  );
  expect(display?.status).toBe(200);
  expect(display?.headers.get("referrer-policy")).toBe("strict-origin");
  const manual = await display?.text();
  expect(manual).toContain('action="/connections/complete"');
  expect(manual).not.toContain("<script>");
  const callbackUrl = `${origin}/connections/complete?result=${opaque}`;
  const displayWith = (cookie: string, extra: Record<string, string> = {}, method = "GET") =>
    handleConnectionsPortalRequest(
      new Request(callbackUrl, { method, headers: { cookie, ...extra } }),
      d,
    );
  expect((await displayWith(intentCookie, {}, "HEAD"))?.body).toBeNull();
  for (const cookie of [`${intentCookie}; ${intentCookie}`, "__Host-omh-connection-handoff=bad"]) {
    expect(await (await displayWith(cookie))?.text()).not.toContain("<script>");
  }
  expect(
    await (await displayWith(intentCookie, { "sec-purpose": "prefetch;prerender" }))?.text(),
  ).not.toContain("<script>");
  expect(d.confirmation.matchesConfirmation).not.toHaveBeenCalled();
  expect(
    await (await displayWith(`__Host-omh-connection-handoff=${"0".repeat(64)}`))?.text(),
  ).not.toContain("<script>");
  const matched = await displayWith(intentCookie);
  const html = await matched?.text();
  const script = html?.match(/<script>(.*?)<\/script>/s)?.[1];
  const requestSubmit = vi.fn();
  const document = {
    prerendering: false,
    getElementById: (id: string) => (html?.includes(`<form id="${id}"`) ? { requestSubmit } : null),
    addEventListener: vi.fn<(name: string, activate: () => void) => void>(),
  };
  runInNewContext(script ?? "", { document });
  expect(requestSubmit).toHaveBeenCalledTimes(1);
  document.prerendering = true;
  runInNewContext(script ?? "", { document });
  expect(requestSubmit).toHaveBeenCalledTimes(1);
  expect(document.addEventListener.mock.calls[0]?.[0]).toBe("prerenderingchange");
  document.addEventListener.mock.calls[0]?.[1]();
  expect(requestSubmit).toHaveBeenCalledTimes(2);
  expect(html).toContain("<noscript>");
  expect(matched?.headers.get("content-security-policy")).toContain(
    `script-src 'sha256-${createHash("sha256")
      .update(script ?? "")
      .digest("base64")}'`,
  );
  expect(d.confirmation.matchesConfirmation).toHaveBeenLastCalledWith({
    result: opaque,
    principalId: "user:user_test",
    sessionId: "session_test",
    handoffHash,
  });
  d.confirmation.matchesConfirmation.mockRejectedValueOnce(new Error("unavailable"));
  expect(await (await displayWith(intentCookie))?.text()).not.toContain("<script>");
  expect(d.complete).not.toHaveBeenCalled();
  const legacy = await handleConnectionsPortalRequest(form("/connections/complete", "result"), d);
  expect(legacy?.status).toBe(200);
  const success = await legacy?.text();
  expect(success).toContain("Make connected");
  expect(success).toContain('data-provider-icon="make"');
  expect(d.complete).toHaveBeenCalledWith({
    result: opaque,
    principalId: "user:user_test",
    sessionId: "session_test",
  });
  d.complete.mockResolvedValueOnce({
    state: "active",
    grantId: "grant",
    organizationId: "workspace",
  });
  const workspace = await handleConnectionsPortalRequest(
    form("/connections/complete", "result"),
    d,
  );
  expect(workspace?.status).toBe(200);
  expect(await workspace?.text()).toBe(success);
  d.readiness.mockResolvedValue(false);
  expect(
    (await handleConnectionsPortalRequest(form("/connections/authorize", "request"), d))?.status,
  ).toBe(503);
  expect(d.consumeHandoff).not.toHaveBeenCalled();
});
