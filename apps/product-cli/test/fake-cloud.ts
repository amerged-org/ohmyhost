import { expect } from "vitest";

import type { LocalProfile } from "../src/profile-store.js";
import { login } from "./memory-profiles.js";

/**
 * Two independent ohmyho.st accounts, each with its own workspace, as WorkOS and the Control API
 * answer them. Tests pair it with in-memory saved logins; no real credential store is involved.
 */
export const ORG_A = "01K3AAAAAAAAAAAAAAAAAAAAAA";
export const ORG_B = "01K3BBBBBBBBBBBBBBBBBBBBBB";
export const PROJECT_A = "01K3PAAAAAAAAAAAAAAAAAAAAA";
export const PROJECT_B = "01K3PBBBBBBBBBBBBBBBBBBBBB";
export const ORG_LABS = { id: "01K3CCCCCCCCCCCCCCCCCCCCCC", workos_id: "org_labs", name: "Labs" };
export const OPERATION = "01K3QQQQQQQQQQQQQQQQQQQQQQ";
export const PLAN = "01K3RRRRRRRRRRRRRRRRRRRRRR";
export const ACCOUNTS = {
  amerged: {
    userId: "user_amerged",
    organizations: [{ id: ORG_A, workos_id: "org_amerged", name: "amerged" }],
  },
  sebmer: {
    userId: "user_sebmer",
    organizations: [{ id: ORG_B, workos_id: "org_sebmer", name: "Sebmer" }],
  },
} as const;
export type Account = keyof typeof ACCOUNTS;
export const PROJECTS: Readonly<Record<string, string>> = {
  [PROJECT_A]: ORG_A,
  [PROJECT_B]: ORG_B,
};
export const AMERGED = login("amerged", "user_amerged", ORG_A);
export const SEBMER = login("sebmer", "user_sebmer", ORG_B, "Sebmer");
/** A user API key of the amerged workspace. */
export const KEY_A = `sk_${"a".repeat(46)}`;
/** A key of the Sebmer workspace, and one of another user in the amerged workspace. */
export const KEY_B = `sk_${"b".repeat(46)}`;
export const KEY_TEAMMATE = `sk_${"t".repeat(46)}`;
/** Each user API key's account, as the API resolves it. */
const KEYS: Readonly<Record<string, { userId: string; organizationId: string }>> = {
  [KEY_A]: { userId: "user_amerged", organizationId: ORG_A },
  [KEY_B]: { userId: "user_sebmer", organizationId: ORG_B },
  [KEY_TEAMMATE]: { userId: "user_teammate", organizationId: ORG_A },
};

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** An access token whose claims the fake API trusts, as the real one trusts WorkOS signatures. */
export const accessToken = (userId: string, organizationId: string | null): string =>
  [
    segment({ alg: "RS256", typ: "JWT" }),
    segment({
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: userId,
      ...(organizationId === null ? {} : { org_id: organizationId }),
    }),
    segment("signature"),
  ].join(".");
export const claimsOf = (token: string): { sub: string; org_id?: string } =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    sub: string;
    org_id?: string;
  };
export const savedCredential = (profile: LocalProfile) => ({
  accessToken: accessToken(profile.userId, profile.organizationId),
  refreshToken: `refresh.${profile.userId}.saved`,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...(profile.organizationId === null
    ? {}
    : {
        workosOrganizationId: profile.organizationId === ORG_A ? "org_amerged" : "org_sebmer",
        organizationId: profile.organizationId,
      }),
});

/** WorkOS and the Control API as a customer's computer sees them, for two separate accounts. */
export class FakeCloud {
  /** Whoever the customer's browser is signed in as when a device code is confirmed. */
  browser: Account = "amerged";
  readonly calls: { method: string; path: string; authorization: string | null }[] = [];
  readonly githubConnected = new Set<string>([ORG_A]);
  readonly installedRepositories = new Set<string>(["acme/shop"]);
  identityUnavailable = false;
  /** A second workspace the amerged user may also belong to. */
  amergedAlsoInLabs = false;
  /** A status read waits here, so a test can hold one command while others run. */
  statusGate: Promise<void> | undefined;
  /** When set, a workspace refresh answers with this account's token instead of the caller's. */
  workspaceTokenFor: Account | undefined;
  /** The customer refuses the sign-in in the browser. */
  deviceDenied = false;
  #refreshes = 0;

  public readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    this.calls.push({ method: request.method, path: url.pathname, authorization });
    if (url.origin === "https://api.workos.com") return this.#workos(url, await request.text());
    expect(url.origin).toBe("https://app.ohmyho.st");
    const identity = this.#identity(authorization);
    if (identity === null) return problem(401, "unauthenticated");
    if (url.pathname === "/v1/me") {
      if (this.identityUnavailable) throw new TypeError("network unreachable");
      return Response.json({
        actor_id: `user:${identity.userId}`,
        email: `${identity.userId}@example.invalid`,
        organization_ids: identity.organizationId === null ? [] : [identity.organizationId],
        organizations:
          identity.organizationId === null
            ? []
            : [
                {
                  id: identity.organizationId,
                  name:
                    identity.organizationId === ORG_A
                      ? "amerged"
                      : identity.organizationId === ORG_B
                        ? "Sebmer"
                        : ORG_LABS.name,
                },
              ],
      });
    }
    if (url.pathname === "/v1/me/profile") {
      if (identity.key) return problem(403, "forbidden");
      const organizations = this.#organizationsOf(identity.userId);
      return Response.json({
        user_id: identity.userId,
        name: identity.userId,
        email: `${identity.userId}@example.invalid`,
        email_verified: true,
        organizations,
        organization_ids: organizations.map((organization) => organization.id),
        signup_source: null,
        attributed_at: null,
        initial_workspace_id: null,
      });
    }
    // A created workspace is the Labs one, which the user reads only with amergedAlsoInLabs.
    if (url.pathname === "/v1/organizations" && request.method === "POST")
      return Response.json({ id: ORG_LABS.id, name: ORG_LABS.name }, { status: 201 });
    if (url.pathname.startsWith("/v1/organizations/")) return new Response(null, { status: 503 });
    if (url.pathname.startsWith("/v1/operations/")) return Response.json(operation("succeeded"));
    const project = /^\/v1\/projects\/([0-9A-Z]{26})(.*)$/u.exec(url.pathname);
    if (project === null) throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    const [, projectId = "", action = ""] = project;
    // A project is visible only inside the organization that owns it.
    if (PROJECTS[projectId] !== identity.organizationId) return problem(404, "resource_not_found");
    if (action === "" && request.method === "GET")
      return Response.json({
        id: projectId,
        organization_id: PROJECTS[projectId],
        name: "shop",
        handle: "calm-otter-waves",
        data_mode: "isolated",
        region: "us",
        created_at: "2026-09-24T00:00:00.000Z",
      });
    if (action === "/status") {
      await this.statusGate;
      return Response.json(projectStatus(projectId));
    }
    if (action === "/source:link") {
      const body = JSON.parse((await request.clone().text()) || "{}") as Record<string, string>;
      if (!this.githubConnected.has(PROJECTS[projectId] ?? ""))
        return problem(409, "github_connection_required");
      if (!this.installedRepositories.has(`${body["repository_owner"]}/${body["repository_name"]}`))
        return problem(403, "repository_not_installed");
      return Response.json(operation("queued"), { status: 202 });
    }
    if (action === "/deployments") return Response.json(operation("queued"), { status: 202 });
    // Secret metadata as the API answers it; the fake keeps no value.
    const secret = /^\/environments\/[0-9A-Z]{26}\/secrets(?:\/([A-Z][A-Z0-9_]{0,127}))?$/u.exec(
      action,
    );
    if (secret?.[1] !== undefined && request.method === "PUT")
      return Response.json({
        ...SECRET_DELIVERY,
        name: secret[1],
        revision: 1,
        key_version: 1,
        created_at: "2026-09-24T00:00:00.000Z",
        updated_at: "2026-09-24T00:00:00.000Z",
      });
    if (secret !== null && secret[1] === undefined && request.method === "GET")
      return Response.json({ ...SECRET_DELIVERY, items: [] });
    throw new Error(`unexpected request ${request.method} ${url.pathname}`);
  };

  #organizationsOf(userId: string) {
    const account = Object.values(ACCOUNTS).find((entry) => entry.userId === userId);
    return [
      ...(account?.organizations ?? []),
      ...(this.amergedAlsoInLabs && userId === "user_amerged" ? [ORG_LABS] : []),
    ];
  }

  /** Which account a bearer belongs to, as the API's own verification would decide. */
  #identity(
    authorization: string | null,
  ): { userId: string; organizationId: string | null; key: boolean } | null {
    const token = authorization?.replace(/^Bearer /u, "") ?? "";
    const key = KEYS[token];
    if (key !== undefined) return { ...key, key: true };
    try {
      const claims = claimsOf(token);
      return { userId: claims.sub, organizationId: claims.org_id ?? null, key: false };
    } catch {
      return null;
    }
  }

  #workos(url: URL, body: string): Response {
    const form = new URLSearchParams(body);
    if (url.pathname.endsWith("/authorize/device"))
      return Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://divine-climb-22.authkit.app/device",
        expires_in: 300,
        interval: 1,
      });
    const account = ACCOUNTS[this.browser];
    if (form.get("grant_type") !== "refresh_token" && this.deviceDenied)
      return Response.json({ error: "access_denied" }, { status: 400 });
    if (form.get("grant_type") !== "refresh_token")
      return Response.json({
        access_token: accessToken(account.userId, null),
        refresh_token: `refresh.${account.userId}.${String(++this.#refreshes)}`,
        token_type: "Bearer",
      });
    const userId = (form.get("refresh_token") ?? "").split(".")[1] ?? "";
    const organization = this.#organizationsOf(userId).find(
      (entry) => entry.workos_id === form.get("organization_id"),
    );
    if (organization === undefined)
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const answered =
      this.workspaceTokenFor === undefined
        ? { userId, organizationId: organization.id }
        : {
            userId: ACCOUNTS[this.workspaceTokenFor].userId,
            organizationId: ACCOUNTS[this.workspaceTokenFor].organizations[0].id,
          };
    return Response.json({
      access_token: accessToken(answered.userId, answered.organizationId),
      refresh_token: `refresh.${userId}.${String(++this.#refreshes)}`,
      token_type: "Bearer",
    });
  }
}

const problem = (status: number, code: string): Response =>
  Response.json(
    {
      type: `https://docs.ohmyho.st/errors/${code.replaceAll("_", "-")}`,
      title: "Refused",
      status,
      code,
      request_id: "request-fake",
      retryable: false,
      suggested_action: "Server guidance.",
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
const SECRET_DELIVERY = {
  desired_generation: 1,
  applied_generation: 1,
  delivery_state: "ready",
  runtime_provider: "wfp",
  applied_secret_count: 1,
  last_error: null,
};
const operation = (state: "queued" | "succeeded") => ({
  id: OPERATION,
  state,
  created_at: "2026-09-24T00:00:00.000Z",
  updated_at: "2026-09-24T00:00:00.000Z",
});
const projectStatus = (projectId: string) => ({
  project_id: projectId,
  etag: `"sha256-${"a".repeat(64)}"`,
  handle: "calm-otter-waves",
  region: "us",
  dev_access_mode: "protected",
  lifecycle: "active",
  source: {
    provider: "github",
    installation_id: "42",
    repository_full_name: "acme/shop",
    status: "ready",
    linked_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:00:00.000Z",
  },
  default_environment: null,
  environments: [
    { id: "01K3EAAAAAAAAAAAAAAAAAAAAA", name: "dev" },
    { id: "01K3EBBBBBBBBBBBBBBBBBBBBB", name: "prod" },
  ],
  head_deployment: null,
  dev_url: null,
  prod_url: null,
  latest_operation: null,
  cleanup_state: "not_started",
});
