import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OrganizationCreditError, SharedMailDomainError } from "@ohmyhost/database";
import { createUlidFactory, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import { CloudflareCustomerDnsRejectedError } from "@ohmyhost/provider-cloudflare";
import {
  ApplicationIdentityRuntime,
  CloudflareDomainRuntime,
  MailDnsRuntime,
  ScopedDnsRuntime,
} from "../../control-store/src/worker-main.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { cfFixture } from "../../control-store/test/support/cf-mail-fixture.js";
import {
  fundMail,
  publishMailRates,
  seedBoundNativeSender,
  seedReadyMailDomain,
  seedNativeWorkspaceDomain,
} from "../../control-store/test/support/mail-domain.js";
import { seam } from "../../control-store/test/support/wire.js";
import { createD1CloudflareProjectDeletionPersistence } from "../src/d1-project-deletion.js";
import { createD1ApplicationIdentityPersistence } from "../src/d1-application-identity.js";
import { createD1MailDnsPersistence } from "../src/d1-mail-dns-persistence.js";
import { createD1ScopedDnsPersistence } from "../src/d1-scoped-dns-persistence.js";
import { ScopedDnsConflictError } from "../src/scoped-dns-authorization.js";
import { createD1MailComponents } from "../src/d1-mail-components.js";
import { clock, deletingProject, digest, secrets } from "./support/cloudflare-core.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
  await publishMailRates(control);
}, 60_000);
afterAll(async () => control.dispose());
afterEach(() => vi.unstubAllGlobals());

/** The Cloudflare OAuth and DNS boundary as the scoped flows see it, plus the public DoH answer of the proof. */
function cloudflare() {
  const calls: string[] = [],
    records: Record<string, unknown>[] = [],
    state = { revoked: false, failReconcile: false, txt: new Set<string>() };
  const tokens = (n: number) => ({
    accessToken: `scoped-access-token-${n}`,
    refreshToken: `scoped-refresh-token-${n}`,
    tokenType: "Bearer" as const,
    expiresInSeconds: 3600,
    scopes: ["dns.write", "zone.read"] as ["dns.write", "zone.read"],
  });
  let refreshes = 0;
  const refreshInputs: string[] = [];
  const oauth = {
    authorizationUrl: ({ state: value }: { state: string }) =>
      `https://dash.cloudflare.com/oauth2/auth?state=${value}`,
    exchangeAuthorizationCode: async (code: string) => {
      if (code === "rejected-code") throw new Error("rejected");
      if (code === "revoke-code")
        return { ...tokens(0), refreshToken: "scoped-refresh-token-revoke" };
      return code === "absent-zone-code"
        ? { ...tokens(0), accessToken: "absent-zone-token" }
        : tokens(0);
    },
    revokeRefreshToken: vi.fn<(token: string) => Promise<void>>(async () => undefined),
    observeZone: async (token: string, zone: string) =>
      token === "absent-zone-token"
        ? ({ state: "absent", zoneName: zone } as const)
        : ({
            state: "found",
            zoneName: zone,
            zoneId: "d".repeat(32),
            accountId: "e".repeat(32),
          } as const),
  };
  const providerForUse = (beforeRequest: () => Promise<void>) => ({
    observeRefreshToken: async (token: string) => {
      await beforeRequest();
      calls.push("refresh");
      refreshInputs.push(token);
      return state.revoked
        ? ({ state: "revoked" } as const)
        : ({ state: "active", tokens: tokens(++refreshes) } as const);
    },
    reconcileRecords: async (
      _token: string,
      input: { records: readonly Record<string, unknown>[] },
    ) => {
      await beforeRequest();
      if (state.failReconcile) throw new Error("reconcile refused");
      calls.push("reconcile");
      const applied: Record<string, unknown>[] = input.records.map((record, index) => ({
        ...record,
        id: `${(records.length + index + 1).toString(16)}`.padStart(32, "0"),
      }));
      records.push(...applied);
      for (const record of applied)
        if (record["type"] === "TXT") state.txt.add(`${record["name"]}|${record["content"]}`);
      return { status: "applied" as const, records: applied as never };
    },
    deleteRecords: async (_token: string, input: { records: readonly { id: string }[] }) => {
      await beforeRequest();
      calls.push("delete");
      return { status: "deleted" as const, recordIds: input.records.map(({ id }) => id) };
    },
  });
  /** Public DNS-over-HTTPS: answers the TXT records the fake zone holds, as the proof observer reads them. */
  const doh = async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      name = url.searchParams.get("name") ?? "",
      answers = [...state.txt]
        .filter((entry) => entry.startsWith(`${name}|`))
        .map((entry) => ({ name: `${name}.`, type: 16, data: `"${entry.split("|")[1]}"` }));
    return Response.json({ Status: 0, Answer: answers });
  };
  return { calls, records, refreshInputs, state, oauth, providerForUse, doh };
}

function components(api: ReturnType<typeof cloudflare>) {
  const bindings = {
    SCOPED_DNS_RUNTIME: new ScopedDnsRuntime({} as never, control.bindings as never),
    APPLICATION_IDENTITY_RUNTIME: new ApplicationIdentityRuntime(
      {} as never,
      control.bindings as never,
    ),
    MAIL_DNS_RUNTIME: new MailDnsRuntime({} as never, control.bindings as never),
  };
  const core = new CloudflareDomainRuntime({} as never, control.bindings as never);
  return createD1MailComponents({
    bindings,
    clock,
    ids,
    secrets,
    oauth: api.oauth,
    providerForUse: api.providerForUse as never,
    customerDns: {
      loadAccess: async () => ({ status: "absent" }),
      deleteRecords: async (_token: string, request: { records: readonly { id: string }[] }) => ({
        recordIds: request.records.map(({ id }) => id),
      }),
    } as never,
    deletionDependencies: {
      clock,
      cipher: secrets.tokenCipher,
      persistence: createD1CloudflareProjectDeletionPersistence(core as never),
      providers: {} as never,
    },
  });
}

describe("application identity proof through the actual Core", () => {
  it("declares, authorizes the zone, publishes and verifies the challenge, and revokes it", async () => {
    const api = cloudflare();
    vi.stubGlobal("fetch", api.doh);
    const actor = await cfFixture(control),
      { project } = actor,
      user = actor,
      { scopedDns, identities } = await components(api),
      scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        actorId: user.principalId,
      },
      mutation = (label: string, extra: object = {}) => ({
        ...scope,
        idempotencyKeySha256: digest(`key:${label}`),
        requestSha256: digest(`request:${label}`),
        ...extra,
      });

    expect(await identities.readApplicationDomainIdentity(scope)).toBeNull();
    const declared = await identities.declareApplicationDomainIdentity(
      mutation("declare", { hostname: "www.example.com" }),
    );
    expect(declared).toMatchObject({
      hostname: "www.example.com",
      registrable_domain: "example.com",
      status: "pending",
      revision: 1,
      challenge: { type: "TXT", name: "_omh-project.www.example.com" },
    });
    expect(
      await identities.declareApplicationDomainIdentity(
        mutation("declare", { hostname: "www.example.com" }),
      ),
    ).toMatchObject({ revision: 1, challenge: declared.challenge });
    expect(await identities.readApplicationDomainIdentity(scope)).toMatchObject({ revision: 1 });

    // Without the zone authorization the proof stays pending; with it the TXT is published and observed.
    expect(
      await identities.verifyApplicationDomainIdentity(
        mutation("verify-1", { expectedRevision: 1 }),
      ),
    ).toEqual({ status: "conflict", code: "application_identity_dns_pending" });
    const begun = await scopedDns.beginApplicationIdentityAuthorization(
      mutation("zone", { expectedRevision: 1, zone: "example.com" }),
    );
    expect(await scopedDns.getApplicationIdentityAuthorizationStatus(scope)).toMatchObject({
      status: "pending",
      zone: "example.com",
    });
    const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "fixture-code-1",
        state,
        principalId: user.principalId,
      }),
    ).toEqual({
      status: "authorized",
    });
    expect(await scopedDns.getApplicationIdentityAuthorizationStatus(scope)).toMatchObject({
      status: "authorized",
    });
    const verified = await identities.verifyApplicationDomainIdentity(
      mutation("verify-2", { expectedRevision: 1 }),
    );
    expect(verified).toMatchObject({ status: "verified", revision: 1 });
    expect(api.calls).toEqual(["reconcile"]);
    expect(
      await identities.verifyApplicationDomainIdentity(
        mutation("verify-2", { expectedRevision: 1 }),
      ),
    ).toEqual(verified);

    expect(
      await identities.revokeApplicationDomainIdentity(mutation("revoke", { expectedRevision: 1 })),
    ).toMatchObject({ status: "revoked" });
    expect(
      await identities.revokeApplicationDomainIdentity(mutation("revoke", { expectedRevision: 1 })),
    ).toMatchObject({ status: "revoked" });
    expect(
      await identities.revokeApplicationDomainIdentity(mutation("again", { expectedRevision: 5 })),
    ).toEqual({ status: "conflict", code: "application_identity_stale" });
  });

  it("revokes the stored refresh token at Cloudflare and wipes its ciphertext, keeping it until a sweep succeeds", async () => {
    const api = cloudflare();
    vi.stubGlobal("fetch", api.doh);
    const actor = await cfFixture(control),
      { project } = actor,
      user = actor,
      { scopedDns, identities } = await components(api),
      scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        actorId: user.principalId,
      },
      mutation = (label: string, extra: object = {}) => ({
        ...scope,
        idempotencyKeySha256: digest(`key:${label}`),
        requestSha256: digest(`request:${label}`),
        ...extra,
      }),
      refreshSize = async () =>
        (
          await control.core
            .prepare(
              "SELECT length(refresh_ciphertext) AS size FROM scoped_customer_dns_grants WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2",
            )
            .bind(project.organizationId, project.projectId)
            .first<{ size: number }>()
        )?.size;
    await identities.declareApplicationDomainIdentity(
      mutation("declare-revoke", { hostname: "revoke.example.com" }),
    );
    const begun = await scopedDns.beginApplicationIdentityAuthorization(
      mutation("zone-revoke", { expectedRevision: 1, zone: "example.com" }),
    );
    const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "revoke-code",
        state,
        principalId: user.principalId,
      }),
    ).toEqual({ status: "authorized" });
    expect(await refreshSize()).toBeGreaterThan(0);

    // The revoke itself only commits the revocation; the ciphertext stays until the sweep has revoked the token.
    expect(
      await scopedDns.revokeApplicationIdentityAuthorization(
        mutation("revoke-grant", { expectedRevision: 1 }),
      ),
    ).toMatchObject({ status: "revoked" });
    expect(api.oauth.revokeRefreshToken).not.toHaveBeenCalled();
    expect(await refreshSize()).toBeGreaterThan(0);

    // Cloudflare is down, and later refuses the token with a 4xx: neither counts as revoked, the ciphertext stays.
    // Every revocation fails in these sweeps, so this grant's ciphertext is asserted whatever other revoked grant
    // the shared Core holds; the sweeps' global counts are not this grant's.
    api.oauth.revokeRefreshToken.mockRejectedValue(new Error("cloudflare unavailable"));
    expect((await scopedDns.sweepRevokedGrants({})).failed).toBeGreaterThanOrEqual(1);
    expect(await refreshSize()).toBeGreaterThan(0);
    api.oauth.revokeRefreshToken.mockRejectedValue(new CloudflareCustomerDnsRejectedError());
    expect((await scopedDns.sweepRevokedGrants({})).failed).toBeGreaterThanOrEqual(1);
    expect(api.oauth.revokeRefreshToken).toHaveBeenCalledWith("scoped-refresh-token-revoke");
    expect(await refreshSize()).toBeGreaterThan(0);

    // The next sweep revokes the same stored token at Cloudflare and then wipes the ciphertext.
    api.oauth.revokeRefreshToken.mockImplementation(async () => undefined);
    expect(await scopedDns.sweepRevokedGrants({})).toMatchObject({ failed: 0 });
    expect(api.oauth.revokeRefreshToken).toHaveBeenCalledWith("scoped-refresh-token-revoke");
    expect(await refreshSize()).toBe(0);
  });

  it("leaves the tokens of a grant alone that a new authorization only superseded", async () => {
    const api = cloudflare();
    vi.stubGlobal("fetch", api.doh);
    const actor = await cfFixture(control),
      { project } = actor,
      { scopedDns, identities } = await components(api),
      scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        actorId: actor.principalId,
      },
      mutation = (label: string, extra: object = {}) => ({
        ...scope,
        idempotencyKeySha256: digest(`key:${label}`),
        requestSha256: digest(`request:${label}`),
        ...extra,
      }),
      begin = async (label: string) =>
        new URL(
          (
            await scopedDns.beginApplicationIdentityAuthorization(
              mutation(label, { expectedRevision: 1, zone: "example.com" }),
            )
          ).authorizationUrl,
        ).searchParams.get("state") ?? "";
    await identities.declareApplicationDomainIdentity(
      mutation("declare-superseded", { hostname: "superseded.example.com" }),
    );
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "revoke-code",
        state: await begin("zone-superseded-1"),
        principalId: actor.principalId,
      }),
    ).toEqual({ status: "authorized" });
    // the customer starts again and never finishes: the first authorization is superseded, its grant is not revoked
    await begin("zone-superseded-2");
    const superseded = async () =>
      (
        await control.core
          .prepare(
            "SELECT length(refresh_ciphertext) AS size FROM scoped_customer_dns_grants WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2",
          )
          .bind(project.organizationId, project.projectId)
          .first<{ size: number }>()
      )?.size;
    expect(await superseded()).toBeGreaterThan(0);
    api.oauth.revokeRefreshToken.mockClear();
    // The sweep judges this project's grant only: other tests' revoked grants may be pending in the shared Core.
    await scopedDns.sweepRevokedGrants({});
    expect(await superseded()).toBeGreaterThan(0);
    expect(api.oauth.revokeRefreshToken).not.toHaveBeenCalledWith("scoped-refresh-token-revoke");
  });
});

it("revokes the refresh token of a grant that a re-authorization displaces, and keeps it recorded until Cloudflare accepts it", async () => {
  const api = cloudflare();
  vi.stubGlobal("fetch", api.doh);
  const actor = await cfFixture(control),
    { project } = actor,
    user = actor,
    { scopedDns, identities } = await components(api),
    scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      actorId: user.principalId,
    },
    mutation = (label: string, extra: object = {}) => ({
      ...scope,
      idempotencyKeySha256: digest(`key:${label}`),
      requestSha256: digest(`request:${label}`),
      ...extra,
    }),
    displaced = async () =>
      (
        await control.core
          .prepare(
            "SELECT count(*) AS n FROM scoped_customer_dns_displaced_tokens WHERE organization_id=?1",
          )
          .bind(project.organizationId)
          .first<{ n: number }>()
      )?.n;
  await identities.declareApplicationDomainIdentity(
    mutation("declare-replace", { hostname: "replace.example.com" }),
  );
  const begin = async (label: string) =>
    new URL(
      (
        await scopedDns.beginApplicationIdentityAuthorization(
          mutation(label, { expectedRevision: 1, zone: "example.com" }),
        )
      ).authorizationUrl,
    ).searchParams.get("state") ?? "";
  expect(
    await scopedDns.completeScopedAuthorization({
      code: "revoke-code",
      state: await begin("zone-replace-1"),
      principalId: user.principalId,
    }),
  ).toEqual({ status: "authorized" });
  expect(await displaced()).toBe(0);
  // The second authorization replaces the grant's token pair; the first pair is recorded, not forgotten.
  expect(
    await scopedDns.completeScopedAuthorization({
      code: "replace-code",
      state: await begin("zone-replace-2"),
      principalId: user.principalId,
    }),
  ).toEqual({ status: "authorized" });
  expect(await displaced()).toBe(1);

  // Cloudflare is down: the displaced token stays recorded for the next sweep.
  api.oauth.revokeRefreshToken.mockRejectedValueOnce(new Error("cloudflare unavailable"));
  expect(await scopedDns.sweepRevokedGrants({})).toMatchObject({
    displaced: { attempted: 1, revoked: 0, failed: 1 },
  });
  expect(await displaced()).toBe(1);

  // The next sweep revokes the displaced token itself and forgets it; the current token is never revoked.
  expect(await scopedDns.sweepRevokedGrants({})).toMatchObject({
    displaced: { attempted: 1, revoked: 1, failed: 0 },
  });
  expect(api.oauth.revokeRefreshToken).toHaveBeenLastCalledWith("scoped-refresh-token-revoke");
  expect(api.oauth.revokeRefreshToken).not.toHaveBeenCalledWith("scoped-refresh-token-0");
  expect(await displaced()).toBe(0);
});

describe("workspace mail DNS through the actual Core", () => {
  it("authorizes the mail zone, publishes the records for a project domain and a workspace sender, and retires them", async () => {
    const api = cloudflare(),
      actor = await cfFixture(control),
      { project } = actor,
      user = actor,
      domain = await seedReadyMailDomain(control, project, { receiving: false }),
      { scopedDns, resendDns } = await components(api),
      org = project.organizationId,
      scope = { organizationId: org, mailDomainId: domain.domainId, actorId: user.principalId },
      mutation = (label: string) => ({
        ...scope,
        expectedRevision: 1,
        idempotencyKeySha256: digest(`key:${label}`),
        requestSha256: digest(`request:${label}`),
      }),
      records = [
        { type: "MX", name: domain.domain, value: "feedback-smtp.example.net.", priority: 10 },
        { type: "TXT", name: `send.${domain.domain}`, value: "v=spf1 include:example.net ~all" },
        { type: "CNAME", name: `resend._domainkey.${domain.domain}`, value: "dkim.example.net." },
      ];
    await fundMail(control, org);
    await control.core
      .prepare("UPDATE resend_mail_domains SET records=?2 WHERE domain_id=?1")
      .bind(domain.domainId, JSON.stringify(records))
      .run();

    // Without a grant the DNS stays manual; the grant comes from the purpose-bound authorization.
    expect(
      await resendDns.ensureMailRecords({ ...domain.scope, domainId: domain.domainId }),
    ).toMatchObject({ status: "action_required" });
    await expect(
      scopedDns.beginWorkspaceMailAuthorization({ ...mutation("bad"), zone: "no-zone" }),
    ).rejects.toThrow("Scoped DNS request is invalid");
    const begun = await scopedDns.beginWorkspaceMailAuthorization({
      ...mutation("zone"),
      zone: "example.com",
    });
    expect(await scopedDns.getWorkspaceMailAuthorizationStatus(scope)).toMatchObject({
      status: "pending",
    });
    const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";
    // Another user's browser can neither complete nor consume the consent: the owner's attempt still runs.
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "fixture-code-1",
        state,
        principalId: "user:someone-else",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "rejected-code",
        state,
        principalId: user.principalId,
      }),
    ).toEqual({
      status: "token_exchange_failed",
    });
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "fixture-code-1",
        state,
        principalId: user.principalId,
      }),
    ).toEqual({
      status: "invalid",
    });
    const again = await scopedDns.beginWorkspaceMailAuthorization({
      ...mutation("zone-2"),
      zone: "example.com",
    });
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "absent-zone-code",
        state: new URL(again.authorizationUrl).searchParams.get("state") ?? "",
        principalId: user.principalId,
      }),
    ).toEqual({ status: "zone_observe_failed" });
    const granted = await scopedDns.beginWorkspaceMailAuthorization({
      ...mutation("zone-3"),
      zone: "example.com",
    });
    expect(
      await scopedDns.completeScopedAuthorization({
        code: "fixture-code-3",
        state: new URL(granted.authorizationUrl).searchParams.get("state") ?? "",
        principalId: user.principalId,
      }),
    ).toEqual({ status: "authorized" });
    expect(await scopedDns.getWorkspaceMailAuthorizationStatus(scope)).toMatchObject({
      status: "authorized",
    });

    // The project-owned domain publishes its provider records through the workspace grant.
    expect(
      await resendDns.ensureMailRecords({ ...domain.scope, domainId: domain.domainId }),
    ).toMatchObject({ status: "configured" });
    expect(api.records.map((record) => record["type"])).toEqual(["MX", "TXT", "CNAME"]);
    const receipt = JSON.parse(
      (
        await control.core
          .prepare("SELECT dns_receipts r FROM resend_mail_domains WHERE domain_id=?")
          .bind(domain.domainId)
          .first<{ r: string }>()
      )?.r ?? "{}",
    );
    expect(receipt).toMatchObject({ zoneName: "example.com", records: [{}, {}, {}] });

    // The workspace sender publishes only while its own command or capability lease is held.
    await expect(
      resendDns.ensureWorkspaceMailRecords({ organizationId: org, mailDomainId: domain.domainId }),
    ).rejects.toThrow("Workspace mail DNS resource is unavailable");
    await control.core
      .prepare(
        "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,created_at,lease_until) VALUES(?1,'ws-create',?2,'create',?3,?4,?5,?6)",
      )
      .bind(
        org,
        domain.domainId,
        user.principalId,
        new Uint8Array(32).fill(7),
        "2026-10-28T10:00:00.000000Z",
        "2099-01-01T00:00:00.000000Z",
      )
      .run();
    expect(
      await resendDns.ensureWorkspaceMailRecords({
        organizationId: org,
        mailDomainId: domain.domainId,
      }),
    ).toMatchObject({ status: "configured" });

    // Retirement deletes exactly the receipted records once; its replay answers the stored outcome.
    await control.core.batch([
      control.core
        .prepare("UPDATE workspace_mail_domains SET status='retiring' WHERE domain_id=?")
        .bind(domain.domainId),
      control.core
        .prepare(
          "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,created_at,lease_until) VALUES(?1,'ws-retire',?2,'retire',?3,?4,?5,?6)",
        )
        .bind(
          org,
          domain.domainId,
          user.principalId,
          new Uint8Array(32).fill(8),
          "2026-10-28T10:00:00.000000Z",
          "2099-01-01T00:00:00.000000Z",
        ),
    ]);
    const retired = await scopedDns.retireWorkspaceMailRecords({
      organizationId: org,
      mailDomainId: domain.domainId,
    });
    expect(retired).toMatchObject({ status: "deleted" });
    expect(retired.recordIds).toHaveLength(3);
    expect(api.calls.filter((call) => call === "delete")).toHaveLength(1);
    expect(
      await scopedDns.retireWorkspaceMailRecords({
        organizationId: org,
        mailDomainId: domain.domainId,
      }),
    ).toEqual(retired);

    // An authorization is revoked by its idempotent command and then reads as revoked.
    expect(await scopedDns.revokeWorkspaceMailAuthorization(mutation("revoke"))).toMatchObject({
      status: "revoked",
      zone: "example.com",
    });
    expect(await scopedDns.revokeWorkspaceMailAuthorization(mutation("revoke"))).toMatchObject({
      status: "revoked",
    });
  });

  it("closes a sender without records and refuses the cleanup of one that is not being retired", async () => {
    const api = cloudflare(),
      actor = await cfFixture(control),
      { project } = actor,
      user = actor,
      native = await seedNativeWorkspaceDomain(control, project),
      { scopedDns } = await components(api),
      request = { organizationId: project.organizationId, mailDomainId: native.domainId };
    await expect(scopedDns.retireWorkspaceMailRecords(request)).rejects.toMatchObject({
      code: "mail_retirement_unavailable",
    });
    await control.core.batch([
      control.core
        .prepare("UPDATE workspace_mail_domains SET status='retiring' WHERE domain_id=?")
        .bind(native.domainId),
      control.core
        .prepare(
          "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,created_at,lease_until) VALUES(?1,'native-retire',?2,'retire',?3,?4,?5,?6)",
        )
        .bind(
          project.organizationId,
          native.domainId,
          user.principalId,
          new Uint8Array(32).fill(9),
          "2026-10-28T10:00:00.000000Z",
          "2099-01-01T00:00:00.000000Z",
        ),
    ]);
    expect(await scopedDns.retireWorkspaceMailRecords(request)).toEqual({
      status: "deleted",
      recordIds: [],
    });
    expect(api.calls).toEqual([]);
  });
});

describe("the technical lease of a scoped DNS use", () => {
  async function authorizedProject(api: ReturnType<typeof cloudflare>, label: string) {
    const actor = await cfFixture(control),
      { project } = actor,
      user = actor,
      parts = await components(api),
      scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        actorId: user.principalId,
      },
      mutation = (key: string, extra: object = {}) => ({
        ...scope,
        idempotencyKeySha256: digest(`key:${label}:${key}`),
        requestSha256: digest(`request:${label}:${key}`),
        ...extra,
      });
    const declared = await parts.identities.declareApplicationDomainIdentity(
      mutation("declare", { hostname: "www.example.com" }),
    );
    const begun = await parts.scopedDns.beginApplicationIdentityAuthorization(
      mutation("zone", { expectedRevision: 1, zone: "example.com" }),
    );
    await parts.scopedDns.completeScopedAuthorization({
      code: "fixture-code-1",
      state: new URL(begun.authorizationUrl).searchParams.get("state") ?? "",
      principalId: user.principalId,
    });
    const ensure = () =>
      parts.scopedDns.ensureApplicationIdentityChallenge({
        organizationId: project.organizationId,
        projectId: project.projectId,
        expectedRevision: 1,
      });
    return { project, user, parts, scope, mutation, declared, ensure };
  }
  const grantRow = (project: { organizationId: string }) =>
    control.core
      .prepare(
        "SELECT revoked_at r,access_expires_at e,dns_receipts d FROM scoped_customer_dns_grants WHERE organization_id=?",
      )
      .bind(project.organizationId)
      .first<{ r: string | null; e: string; d: string }>();
  const stale = (project: { organizationId: string }) =>
    control.core
      .prepare(
        "UPDATE scoped_customer_dns_grants SET access_expires_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?",
      )
      .bind(project.organizationId)
      .run();

  it("replaces an obsolete challenge record, refreshes a stale token and closes a revoked one", async () => {
    const api = cloudflare(),
      f = await authorizedProject(api, "lease");
    await f.ensure();
    expect(api.calls).toEqual(["reconcile"]);
    const published = JSON.parse((await grantRow(f.project))?.d ?? "[]") as { name: string }[];
    expect(published).toHaveLength(1);
    // A record of an earlier challenge value is deleted before the current one is reconciled.
    await control.core
      .prepare("UPDATE scoped_customer_dns_grants SET dns_receipts=?2 WHERE organization_id=?1")
      .bind(
        f.project.organizationId,
        JSON.stringify([
          {
            id: "f".repeat(32),
            type: "TXT",
            name: published[0]?.name,
            content: `omh-domain-v1=${"z".repeat(43)}`,
            ttl: 300,
            proxied: false,
            comment: `ohmyhost:${f.project.projectId}:app-identity:v1`,
          },
        ]),
      )
      .run();
    await f.ensure();
    expect(api.calls).toEqual(["reconcile", "delete", "reconcile"]);

    // A stale access token is renewed from the refresh token inside the same lease.
    await stale(f.project);
    await f.ensure();
    expect(api.calls.slice(3)).toEqual(["refresh", "reconcile"]);
    expect(Date.parse((await grantRow(f.project))?.e ?? "")).toBeGreaterThan(Date.now());

    // Cloudflare refusing the refresh token revokes the grant instead of using it.
    await stale(f.project);
    api.state.revoked = true;
    await f.ensure();
    expect(api.calls.slice(5)).toEqual(["refresh"]);
    expect((await grantRow(f.project))?.r).not.toBeNull();
    expect(
      await f.parts.scopedDns.getApplicationIdentityAuthorizationStatus(f.scope),
    ).toMatchObject({ status: "revoked" });
    await f.ensure();
    expect(api.calls).toHaveLength(6);
  });

  it("keeps the rotated refresh token when the DNS work that follows its refresh fails", async () => {
    const api = cloudflare(),
      f = await authorizedProject(api, "rotated");
    await f.ensure();
    await stale(f.project);
    api.state.failReconcile = true;
    await expect(f.ensure()).rejects.toThrow("reconcile refused");
    // Cloudflare rotated the pair in that refresh, so the next refresh must present the rotated refresh token.
    api.state.failReconcile = false;
    await stale(f.project);
    await f.ensure();
    expect(api.refreshInputs).toEqual(["scoped-refresh-token-0", "scoped-refresh-token-1"]);
  });

  it("reports the failed DNS work, not the storage refusal of the rotated pair stored after it", async () => {
    const api = cloudflare(),
      f = await authorizedProject(api, "refused");
    await f.ensure();
    await stale(f.project);
    api.state.failReconcile = true;
    // The store refuses every write of the sealed access token, so storing the rotated pair fails as well.
    await control.core
      .prepare(
        "CREATE TRIGGER refuse_rotated_pair BEFORE UPDATE OF access_ciphertext ON scoped_customer_dns_grants BEGIN SELECT RAISE(ABORT, 'rotated pair refused'); END",
      )
      .run();
    try {
      await expect(f.ensure()).rejects.toThrow("reconcile refused");
    } finally {
      await control.core.prepare("DROP TRIGGER refuse_rotated_pair").run();
      api.state.failReconcile = false;
    }
  });

  it("revokes the exchanged refresh token when the callback's zone is not the requested one", async () => {
    const api = cloudflare(),
      actor = await cfFixture(control),
      { project } = actor,
      parts = await components(api),
      mutation = (key: string, extra: object = {}) => ({
        organizationId: project.organizationId,
        projectId: project.projectId,
        actorId: actor.principalId,
        idempotencyKeySha256: digest(`key:zone-revoke:${key}`),
        requestSha256: digest(`request:zone-revoke:${key}`),
        ...extra,
      });
    await parts.identities.declareApplicationDomainIdentity(
      mutation("declare", { hostname: "www.example.com" }),
    );
    const begun = await parts.scopedDns.beginApplicationIdentityAuthorization(
      mutation("zone", { expectedRevision: 1, zone: "example.com" }),
    );
    await expect(
      parts.scopedDns.completeScopedAuthorization({
        code: "absent-zone-code",
        state: new URL(begun.authorizationUrl).searchParams.get("state") ?? "",
        principalId: actor.principalId,
      }),
    ).resolves.toEqual({ status: "zone_observe_failed" });
    expect(api.oauth.revokeRefreshToken).toHaveBeenCalledWith("scoped-refresh-token-0");
  });

  it("releases the lease after a failed effect and stands down once the actor lost the authority", async () => {
    const api = cloudflare(),
      f = await authorizedProject(api, "failure"),
      leases = () =>
        control.core
          .prepare("SELECT count(*) n FROM scoped_dns_provider_uses WHERE organization_id=?")
          .bind(f.project.organizationId)
          .first<{ n: number }>();
    const provider = api.providerForUse;
    api.providerForUse = ((before: () => Promise<void>) => ({
      ...provider(before),
      reconcileRecords: async () => {
        await before();
        throw new Error("provider outage");
      },
    })) as never;
    // The stub is read when the components are created, so a new composition carries the failing provider.
    const failing = await components(api);
    await expect(
      failing.scopedDns.ensureApplicationIdentityChallenge({
        organizationId: f.project.organizationId,
        projectId: f.project.projectId,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("provider outage");
    expect(await leases()).toEqual({ n: 0 });
    // A stale revision never reaches the provider.
    await expect(
      failing.scopedDns.ensureApplicationIdentityChallenge({
        organizationId: f.project.organizationId,
        projectId: f.project.projectId,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "application_identity_stale" });
    // Without the admin role the claim answers nothing and nothing is published.
    await control.core
      .prepare("UPDATE organization_memberships SET role='member' WHERE organization_id=?")
      .bind(f.project.organizationId)
      .run();
    api.calls.length = 0;
    await f.ensure();
    expect(api.calls).toEqual([]);
    await expect(
      f.parts.scopedDns.revokeApplicationIdentityAuthorization({
        ...f.scope,
        expectedRevision: 1,
        idempotencyKeySha256: digest("key:revoke"),
        requestSha256: digest("request:revoke"),
      }),
    ).rejects.toMatchObject({ code: "dns_authority_revoked" });
  });
});

describe("automatic revalidation and mail DNS deletion", () => {
  it("renews a due proof only while its public TXT record is observed", async () => {
    const api = cloudflare();
    vi.stubGlobal("fetch", api.doh);
    const project = await seedProject(control),
      bound = await seedBoundNativeSender(
        control,
        project,
        new Date(Date.now() + 3 * 86_400_000).toISOString(),
      ),
      { identities } = await components(api),
      request = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        expectedRevision: 1,
      };
    // The project's declared website under the same registrable domain is part of the proof's scope.
    await control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'shop.example.com',NULL,'awaiting_deployment','user:owner',?3,?4,?5,?5,NULL)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        "2026-10-28T10:00:00.000000Z",
      )
      .run();
    void bound;
    expect(await identities.revalidateApplicationDomainIdentity(request)).toMatchObject({
      status: "needs_attention",
      revision: 1,
    });
    api.state.txt.add(`_omh-project.app.example.com|omh-domain-v1=${"a".repeat(43)}`);
    const renewed = await identities.revalidateApplicationDomainIdentity(request);
    expect(renewed).toMatchObject({ status: "revalidated", revision: 1 });
    expect(Date.parse(renewed.expiresAt ?? "")).toBeGreaterThan(Date.now() + 20 * 86_400_000);
    expect(await identities.revalidateApplicationDomainIdentity(request)).toMatchObject({
      status: "not_due",
    });
    expect(
      await identities.revalidateApplicationDomainIdentity({ ...request, expectedRevision: 2 }),
    ).toMatchObject({ status: "stale", revision: 2 });
  });

  it("deletes the receipted mail records with the deletion operation's own grant access", async () => {
    const api = cloudflare();
    let domain: Awaited<ReturnType<typeof seedReadyMailDomain>> | undefined;
    const f = await deletingProject(control, "mail-deletion", {
      grant: "fresh",
      receipts: false,
      beforeDeletion: async (project) => {
        domain = await seedReadyMailDomain(control, project, {
          receiving: false,
          domain: (id) => `mail-${id.slice(-8).toLowerCase()}.example.test`,
        });
      },
    });
    if (domain === undefined) throw new Error("mail domain fixture");
    const { resendDns } = await components(api),
      request = { ...f.request, domainId: domain.domainId };
    expect(await resendDns.deleteMailRecords(request)).toEqual({ recordIds: [] });
    const record = (n: number) => ({
      id: n.toString(16).padStart(32, "0"),
      type: "TXT",
      name: `send.${domain?.domain}`,
      content: "v=spf1 ~all",
      ttl: 300,
      proxied: false,
      comment: `ohmyhost:${f.request.projectId}:mail:v1`,
    });
    await control.core
      .prepare("UPDATE resend_mail_domains SET dns_receipts=?2 WHERE domain_id=?1")
      .bind(
        domain.domainId,
        JSON.stringify({ zoneId: "a".repeat(32), zoneName: "example.test", records: [record(1)] }),
      )
      .run();
    expect(await resendDns.deleteMailRecords(request)).toEqual({ recordIds: [record(1).id] });
    await control.core
      .prepare("UPDATE resend_mail_domains SET dns_receipts=?2 WHERE domain_id=?1")
      .bind(
        domain.domainId,
        JSON.stringify({ zoneId: "b".repeat(32), zoneName: "example.test", records: [record(1)] }),
      )
      .run();
    await expect(resendDns.deleteMailRecords(request)).rejects.toThrow(
      "Mail DNS deletion requires original zone access",
    );
    await expect(
      resendDns.deleteMailRecords({ ...request, domainId: f.request.projectId }),
    ).rejects.toThrow("Mail deletion unavailable");
  });
});

describe("private replies of the mail Core capabilities", () => {
  const refused = async (call: () => Promise<unknown>) =>
    call().then(
      () => new Error("expected a refusal"),
      (error: unknown) => error as Error & { code?: string },
    );

  it("maps the Core's refusals and refuses scoped DNS answers that are not exactly what it states", async () => {
    const project = await seedProject(control),
      org = parseUlid(project.organizationId),
      resourceId = parseUlid(project.projectId),
      wire = seam(new ScopedDnsRuntime({} as never, control.bindings as never)),
      persistence = await createD1ScopedDnsPersistence(wire.binding),
      scope = { organizationId: org, purpose: "application_identity" as const, resourceId },
      now = () => "2026-10-29T10:00:00.000Z",
      authorization = {
        ...scope,
        resourceRevision: 1,
        authorizationId: parseUlid(newUlid()),
        principalId: "user:owner",
        zoneName: "example.com",
        idempotencyKeySha256: Buffer.alloc(32, 1),
        requestSha256: Buffer.alloc(32, 2),
        stateSha256: Buffer.alloc(32, 3),
        issuedAt: now(),
        expiresAt: "2026-10-29T10:10:00.000Z",
        delegation: null,
      },
      use = {
        leaseToken: crypto.randomUUID(),
        resource: {
          ...scope,
          revision: 1,
          hostname: "www.example.com",
          challengeName: null,
          challengeValue: null,
        },
        grant: {} as never,
      };
    for (const [message, expected] of [
      ["dns_authority_revoked", ScopedDnsConflictError],
      ["store_busy", Error],
      ["SQLITE_ERROR: private detail", Error],
    ] as const) {
      wire.refuse("status", message);
      const failure = await refused(() => persistence.status(scope, now));
      expect(failure).toBeInstanceOf(expected);
      if (message === "store_busy") expect(failure).toMatchObject({ code: "store_busy" });
      if (message.startsWith("SQLITE")) expect(failure.message).toBe("scoped_dns_core_unavailable");
    }
    const rows: [string, unknown, () => Promise<unknown>][] = [
      ["issue", { organizationId: org }, () => persistence.issue(authorization)],
      [
        "consume",
        "ticket",
        () =>
          persistence.consume(
            authorization.authorizationId,
            Buffer.alloc(32),
            authorization.principalId,
            now,
          ),
      ],
      [
        "status",
        { status: "authorized", zone: null, scopes: [], expiresAt: null },
        () => persistence.status(scope, now),
      ],
      [
        "status",
        { status: "not_authorized", zone: "example.com", scopes: [], expiresAt: null },
        () => persistence.status(scope, now),
      ],
      [
        "status",
        {
          status: "pending",
          zone: "example.com",
          scopes: ["dns.write"],
          expiresAt: "2026-10-29T10:00:00.000Z",
        },
        () => persistence.status(scope, now),
      ],
      [
        "revoke",
        {
          status: "authorized",
          zone: "example.com",
          scopes: ["dns.write", "zone.read"],
          expiresAt: "2026-10-29T10:00:00.000Z",
        },
        () => persistence.revoke({ ...authorization, resourceRevision: 1 }, now),
      ],
      [
        "saveGrant",
        "stored",
        () =>
          persistence.saveGrant({
            ...authorization,
            zoneId: "a".repeat(32),
            accountId: "b".repeat(32),
            accessCiphertext: Buffer.alloc(32),
            accessNonce: Buffer.alloc(12),
            refreshCiphertext: Buffer.alloc(32),
            refreshNonce: Buffer.alloc(12),
            keyVersion: 1,
            accessExpiresAt: now(),
            connectedAt: now(),
          }),
      ],
      [
        "claimUse",
        { leaseToken: use.leaseToken, resource: {}, grant: {} },
        () => persistence.claimUse(scope, use.leaseToken, false, now),
      ],
      ["claimUse", "claim", () => persistence.claimUse(scope, use.leaseToken, false, now)],
      ["renewUse", "renewed", () => persistence.renewUse(use)],
      ["authorizeUse", "yes", () => persistence.authorizeUse(use)],
      [
        "finishUse",
        "done",
        () => persistence.finishUse(use, { kind: "revoked", revokedAt: now() }),
      ],
      ["releaseUse", "released", () => persistence.releaseUse(use)],
      [
        "readCleanup",
        { records: "none", cleanup: null, receipt: "{}" },
        () => persistence.readCleanup({ ...scope, purpose: "workspace_mail" }),
      ],
      [
        "readCleanup",
        {
          records: [],
          zoneId: "z",
          zoneName: "n",
          cleanup: { status: "open", recordIds: [] },
          receipt: "{}",
        },
        () => persistence.readCleanup({ ...scope, purpose: "workspace_mail" }),
      ],
      [
        "completeEmptyCleanup",
        { status: "deleted", recordIds: ["a"] },
        () => persistence.completeEmptyCleanup({ ...scope, purpose: "workspace_mail" }, "{}", now),
      ],
    ];
    for (const [name, reply, call] of rows) {
      wire.reply(name as never, reply);
      expect(await refused(call)).toMatchObject({ message: "scoped_dns_response_invalid" });
    }
    await expect(createD1ScopedDnsPersistence({})).rejects.toThrow("scoped_dns_binding_required");
    const foreign = seam(new ScopedDnsRuntime({} as never, control.bindings as never));
    foreign.reply("readAuthorization", { organizationId: org });
    await expect(createD1ScopedDnsPersistence(foreign.binding)).rejects.toThrow(
      "scoped_dns_response_invalid",
    );
  });

  it("maps the Core's refusals and refuses application identity answers that are not exactly what it states", async () => {
    const project = await seedProject(control),
      scope = {
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        actorId: "user:owner",
      },
      mutation = {
        ...scope,
        idempotencyKeySha256: digest("key"),
        requestSha256: digest("request"),
        delegation: null,
      },
      wire = seam(new ApplicationIdentityRuntime({} as never, control.bindings as never)),
      persistence = await createD1ApplicationIdentityPersistence(wire.binding),
      automatic = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        expectedRevision: 1,
      },
      clockNow = () => new Date("2026-10-29T10:00:00.000Z"),
      view = {
        organization_id: scope.organizationId,
        project_id: scope.projectId,
        hostname: "www.example.com",
        registrable_domain: "example.com",
        status: "pending",
        revision: 1,
        challenge: { type: "TXT", name: "_omh-project.www.example.com", value: "v" },
        verified_at: null,
        expires_at: "2026-10-30T10:00:00.000Z",
      };
    for (const [message, expected] of [
      ["dns_authority_revoked", ScopedDnsConflictError],
      ["mail_domain_mismatch", SharedMailDomainError],
      ["store_outcome_unknown", Error],
      ["SQLITE_ERROR: private detail", Error],
    ] as const) {
      wire.refuse("read", message);
      expect(await refused(() => persistence.read(scope))).toBeInstanceOf(expected);
    }
    const rows: [string, unknown, () => Promise<unknown>][] = [
      ["read", { organizationId: scope.organizationId }, () => persistence.read(scope)],
      [
        "declare",
        null,
        () =>
          persistence.declare(
            mutation,
            { hostname: "www.example.com", registrableDomain: "example.com" },
            clockNow(),
            () => "challenge",
          ),
      ],
      [
        "replay",
        { ...view, challenge: { type: "A", name: "n", value: "v" } },
        () => persistence.replay(mutation, "verify"),
      ],
      ["replay", { ...view, status: "gone" }, () => persistence.replay(mutation, "verify")],
      ["replay", { ...view, expires_at: "later" }, () => persistence.replay(mutation, "revoke")],
      [
        "readForVerification",
        { organizationId: "x" },
        () => persistence.readForVerification(mutation),
      ],
      [
        "completeAction",
        { ...view, revision: 0 },
        () => persistence.verify(mutation, 1, "v", clockNow()),
      ],
      ["completeAction", "view", () => persistence.revoke(mutation, 1, clockNow)],
      [
        "readAutomatic",
        { hostname: "www.example.com" },
        () => persistence.readAutomatic(automatic, clockNow),
      ],
      [
        "completeAutomatic",
        { status: "weird", revision: 1, expiresAt: null },
        () => persistence.completeAutomatic(automatic, {} as never, clockNow),
      ],
      [
        "completeAutomatic",
        { status: "stale", revision: 1, expiresAt: "later" },
        () => persistence.completeAutomatic(automatic, {} as never, clockNow),
      ],
    ];
    for (const [name, reply, call] of rows) {
      wire.reply(name as never, reply);
      expect(await refused(call)).toBeInstanceOf(TypeError);
    }
    await expect(createD1ApplicationIdentityPersistence({})).rejects.toThrow(
      "application_identity_binding_required",
    );
    const foreign = seam(new ApplicationIdentityRuntime({} as never, control.bindings as never));
    foreign.reply("read", { ...view });
    await expect(createD1ApplicationIdentityPersistence(foreign.binding)).rejects.toThrow(
      "application_identity_response_invalid",
    );
  });

  it("maps the Core's refusals and refuses mail DNS answers that are not exactly what it states", async () => {
    const wire = seam(new MailDnsRuntime({} as never, control.bindings as never)),
      persistence = await createD1MailDnsPersistence(wire.binding),
      mail = { organizationId: parseUlid(newUlid()), mailDomainId: parseUlid(newUlid()) },
      legacyScope = {
        organizationId: parseUlid(newUlid()),
        projectId: parseUlid(newUlid()),
        environmentId: parseUlid(newUlid()),
      },
      deletion = {
        ...legacyScope,
        operationId: parseUlid(newUlid()),
        domainId: parseUlid(newUlid()),
      };
    for (const [message, expected] of [
      ["paid_plan_required", OrganizationCreditError],
      ["Workspace mail DNS resource is unavailable", Error],
      ["store_busy", Error],
      ["SQLITE_ERROR: private detail", Error],
    ] as const) {
      wire.refuse("requirePaid", message);
      const failure = await refused(() =>
        persistence.requirePaid(mail.organizationId, () => "now"),
      );
      expect(failure).toBeInstanceOf(expected);
      if (message === "store_busy") expect(failure).toMatchObject({ code: "store_busy" });
      if (message.startsWith("SQLITE")) expect(failure.message).toBe("mail_dns_core_unavailable");
    }
    const rows: [string, unknown, () => Promise<unknown>][] = [
      ["workspace", { domain: "d" }, () => persistence.workspace(mail)],
      [
        "workspace",
        { domain: "d", custody_project_id: newUlid(), records: "{" },
        () => persistence.workspace(mail),
      ],
      [
        "workspace",
        { domain: "d", custody_project_id: newUlid(), records: "{}" },
        () => persistence.workspace(mail),
      ],
      ["legacy", { domain_id: newUlid() }, () => persistence.legacy(legacyScope)],
      ["deletion", { domain: "d", dns_receipts: "[]" }, () => persistence.deletion(deletion)],
      ["deletion", { domain: 7, dns_receipts: "{}" }, () => persistence.deletion(deletion)],
      ["requirePaid", "paid", () => persistence.requirePaid(mail.organizationId, () => "now")],
      ["saveWorkspace", "saved", () => persistence.saveWorkspace(mail, {})],
      ["saveLegacy", "saved", () => persistence.saveLegacy(mail.mailDomainId, {})],
    ];
    for (const [name, reply, call] of rows) {
      wire.reply(name as never, reply);
      expect(await refused(call)).toBeInstanceOf(TypeError);
    }
    wire.reply("legacy", {
      domain_id: newUlid(),
      provider_domain_id: null,
      domain: "mail.example.com",
      records: '[{"type":"MX"}]',
      project_id: newUlid(),
    });
    expect(await persistence.legacy(legacyScope)).toMatchObject({ records: [{ type: "MX" }] });
    await expect(createD1MailDnsPersistence({})).rejects.toThrow("mail_dns_binding_required");
    const foreign = seam(new MailDnsRuntime({} as never, control.bindings as never));
    foreign.reply("legacy", { domain_id: newUlid() });
    await expect(createD1MailDnsPersistence(foreign.binding)).rejects.toThrow(
      "mail_dns_response_invalid",
    );
  });
});
