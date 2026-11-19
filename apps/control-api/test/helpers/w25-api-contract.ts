import { expect } from "vitest";
import { createControlApi } from "../../src/app.js";
import { sharedMailError } from "../../src/shared-mail.js";
import type { ControlApiDependencies, AuthenticatedPrincipal } from "../../src/contracts.js";
import {
  createClient,
  executeSharedMail,
  type SharedMailCommand,
} from "../../../../packages/sdk-ts/src/index.js";
import { assertSharedMailResponse } from "../../../../packages/sdk-ts/src/shared-mail-response.js";
import { parseUlid } from "@ohmyhost/platform";

export async function assertW25ApiContractPack(): Promise<void> {
  const org = parseUlid("01H00000000000000000000601"),
    domainId = parseUlid("01H00000000000000000000602"),
    project = parseUlid("01H00000000000000000000603"),
    prod = parseUlid("01H00000000000000000000604"),
    other = parseUlid("01H00000000000000000000605");
  const now = "2026-10-21T00:00:00.000Z";
  const domain = {
    domain_id: domainId,
    organization_id: org,
    domain: "mail.example.com",
    registrable_domain: "example.com",
    revision: 1,
    status: "active",
    sending: "ready",
    receiving: "disabled",
    configured_at: now,
    observed_at: null,
    dns_records: [
      {
        type: "MX",
        name: "send.mail.example.com",
        value: "feedback.example.com",
        priority: 10,
        purpose: "SPF",
        status: "verified",
      },
    ],
    bindings_count: 1,
  };
  const identity = {
    organization_id: org,
    project_id: project,
    hostname: "sign.example.com",
    registrable_domain: "example.com",
    revision: 1,
    status: "verified",
    challenge: {
      type: "TXT",
      name: "_omh-project.sign.example.com",
      value: "challenge-12345678901234567890",
    },
    verified_at: now,
    expires_at: "2026-11-21T00:00:00.000Z",
  };
  const binding = {
    mail_domain_id: domainId,
    organization_id: org,
    project_id: project,
    environment_id: prod,
    revision: 1,
    sending: true,
    sender_addresses: ["contracts@mail.example.com"],
    default_from: "contracts@mail.example.com",
    default_reply_to: "owner@example.com",
    legacy: false,
    status: "active",
    application_domain_identity: {
      hostname: identity.hostname,
      registrable_domain: identity.registrable_domain,
      revision: 1,
      status: "verified",
    },
  };
  const authorization = {
    authorization_id: other,
    authorization_url: "https://dash.cloudflare.com/oauth2/auth?state=opaque",
    expires_at: identity.expires_at,
  };
  const status: {
    status: string;
    zone: string | null;
    scopes: string[];
    expires_at: string | null;
  } = { status: "not_authorized", zone: null, scopes: [], expires_at: null };
  const principal: AuthenticatedPrincipal = {
    actorId: "user_w25",
    credentialId: "w25",
    authorizationPrincipal: { kind: "user", subjectId: "user:w25" },
    organizationIds: [org],
  };
  let authenticated: AuthenticatedPrincipal | null = principal,
    denied = "",
    unavailable = false,
    returnNull = false,
    failPrivate = "";
  let corruptResponse = false,
    delegated = true;
  const frozenDelegation = {
    grantId: other,
    clientId: "client_w25",
    consentHash: "a".repeat(64),
    grantRevision: 3,
  };
  const calls: { name: string; input: unknown }[] = [];
  const privateCall = (name: string, result: unknown) => async (input: unknown) => {
    calls.push({ name, input });
    if (failPrivate) throw new Error(failPrivate);
    return returnNull
      ? null
      : corruptResponse
        ? { ...(result as object), provider_secret: "must-never-leak" }
        : structuredClone(result);
  };
  const deps = {
    authentication: { authenticate: async () => authenticated },
    authorization: {
      check: async (request: { action: string }) => {
        if (unavailable) throw new Error("unavailable");
        return request.action === denied ? "deny" : "allow";
      },
    },
    persistence: {
      getProject: async (organizationId: string, projectId: string) =>
        organizationId === org && projectId === project
          ? {
              projectId: project,
              organizationId: org,
              name: "W25",
              handle: "w25",
              dataMode: "isolated",
              region: "eu",
              createdAt: now,
            }
          : null,
    },
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    allowedOrigins: new Set<string>(),
    applicationId: "w25",
    requestId: () => "req_w25_test",
    clock: { now: () => new Date(now) },
    ids: { next: () => other },
    remoteAuthorization: async () => true,
    remoteDelegation: async () => (delegated ? frozenDelegation : null),
    remoteMailDomainDelegation: async () => (delegated ? frozenDelegation : null),
    sharedMail: {
      listWorkspaceMailDomains: privateCall("list", {
        items: [domain, { ...domain, domain_id: other }],
      }),
      createWorkspaceMailDomain: privateCall("create", domain),
      readWorkspaceMailDomain: privateCall("read", domain),
      retireWorkspaceMailDomain: privateCall("retire", { ...domain, status: "retired" }),
      readProjectMailDomainBinding: privateCall("binding-read", binding),
      putProjectMailDomainBinding: privateCall("binding-set", binding),
      detachProjectMailDomainBinding: privateCall("binding-detach", {
        ...binding,
        sending: false,
        status: "detached",
      }),
    },
    sharedMailIdentity: {
      readApplicationDomainIdentity: privateCall("identity-read", identity),
      declareApplicationDomainIdentity: privateCall("identity-declare", identity),
      verifyApplicationDomainIdentity: privateCall("identity-verify", identity),
      revokeApplicationDomainIdentity: privateCall("identity-revoke", {
        ...identity,
        status: "revoked",
      }),
      revokeApplicationIdentityAuthorization: privateCall("identity-auth-revoke", status),
      revokeWorkspaceMailAuthorization: privateCall("mail-auth-revoke", status),
      beginApplicationIdentityAuthorization: privateCall("identity-authorize", authorization),
      getApplicationIdentityAuthorizationStatus: privateCall("identity-auth-status", status),
      beginWorkspaceMailAuthorization: privateCall("mail-authorize", authorization),
      getWorkspaceMailAuthorizationStatus: privateCall("mail-auth-status", status),
    },
  } as unknown as ControlApiDependencies;
  const app = createControlApi(deps);
  const orgScope = { organizationId: org },
    envScope = { projectId: project, environmentId: prod },
    projectScope = { projectId: project },
    mutation = { idempotencyKey: "w25-request", expectedRevision: 1 };
  const commands: SharedMailCommand[] = [
    { ...orgScope, action: "domains_list" },
    { ...orgScope, ...mutation, action: "domain_create", domain: domain.domain, sending: true },
    { ...orgScope, action: "domain_get", mailDomainId: domainId },
    { ...orgScope, ...mutation, action: "domain_retire", mailDomainId: domainId },
    {
      ...orgScope,
      ...mutation,
      action: "domain_dns_authorize",
      mailDomainId: domainId,
      zone: "example.com",
    },
    { ...orgScope, action: "domain_dns_status", mailDomainId: domainId },
    { ...envScope, action: "binding_get" },
    {
      ...envScope,
      ...mutation,
      action: "binding_set",
      mailDomainId: domainId,
      sending: true,
      senderAddresses: binding.sender_addresses,
      defaultFrom: binding.default_from,
      defaultReplyTo: binding.default_reply_to,
    },
    { ...envScope, ...mutation, action: "binding_detach" },
    { ...projectScope, action: "identity_get" },
    { ...projectScope, ...mutation, action: "identity_declare", hostname: identity.hostname },
    { ...projectScope, ...mutation, action: "identity_verify" },
    { ...projectScope, ...mutation, action: "identity_revoke" },
    { ...projectScope, ...mutation, action: "identity_authorize", zone: "example.com" },
    { ...projectScope, action: "identity_authorization_status" },
  ];
  commands.push(
    { ...orgScope, ...mutation, action: "domain_dns_revoke", mailDomainId: domainId },
    { ...projectScope, ...mutation, action: "identity_authorization_revoke" },
  );
  const client = createClient({
    baseUrl: "https://app.ohmyho.st",
    headers: { authorization: "Bearer w25" },
    fetch: async (request) => app.request(new Request(request)),
  });
  for (const command of commands) {
    const result = await executeSharedMail(client, command);
    expect(result).toBeTruthy();
    expect(() =>
      assertSharedMailResponse(
        { ...(result as object), unexpected_provider_field: "secret" },
        command,
      ),
    ).toThrow();
  }
  expect(new Set(calls.map((c) => c.name)).size).toBe(17);
  const write = calls.find((c) => c.name === "binding-set")?.input;
  expect(write).toMatchObject({
    organizationId: org,
    projectId: project,
    environmentId: prod,
    mailDomainId: domainId,
    expectedRevision: 1,
    idempotencyKey: mutation.idempotencyKey,
    defaultReplyTo: "owner@example.com",
  });
  expect((write as { canonicalRequestDigest: Uint8Array }).canonicalRequestDigest).toHaveLength(32);
  const bindingPath = `/v1/projects/${project}/environments/${prod}/mail-domain-binding`,
    domainPath = `/v1/organizations/${org}/mail-domains/${domainId}`,
    identityPath = `/v1/projects/${project}/application-domain-identity`;
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(`https://app.ohmyho.st${path}`, {
      method,
      headers: {
        authorization: "Bearer w25",
        "content-type": "application/json",
        "idempotency-key": "w25",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  Object.assign(status, {
    status: "authorized",
    zone: "example.com",
    scopes: ["dns.write", "zone.read"],
    expires_at: identity.expires_at,
  });
  for (const path of [domainPath, identityPath]) {
    const response = await request(path + "/dns-authorization");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  }
  expect(
    await executeSharedMail(client, {
      ...orgScope,
      action: "domain_dns_status",
      mailDomainId: domainId,
    }),
  ).toEqual(status);
  for (const scopes of [
    ["dns.delete"],
    ["dns.write", "dns.write"],
    ["dns.write", "zone.read", "zone.delete"],
  ]) {
    status.scopes = scopes;
    const response = await request(domainPath + "/dns-authorization");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("dns.delete");
  }
  Object.assign(status, { status: "not_authorized", zone: null, scopes: [], expires_at: null });
  for (const action of ["projects:read", "projects:write", "mail-domains:use"]) {
    denied = action;
    const before = calls.filter((c) => c.name === "binding-set").length;
    const response = await request(bindingPath, "PUT", {
      mail_domain_id: domainId,
      sending: true,
      sender_addresses: binding.sender_addresses,
      default_from: binding.default_from,
      default_reply_to: null,
      expected_revision: 0,
    });
    expect(response.status).toBe(404);
    expect(calls.filter((c) => c.name === "binding-set")).toHaveLength(before);
  }
  denied = "mail-domains:read";
  expect((await request(bindingPath)).status).toBe(404);
  denied = "mail-domains:use";
  expect((await request(bindingPath, "DELETE", { expected_revision: 1 })).status).toBe(404);
  denied = "";
  unavailable = true;
  expect((await request(domainPath)).status).toBe(503);
  unavailable = false;
  authenticated = null;
  expect((await request(domainPath)).status).toBe(401);
  authenticated = principal;
  expect((await request(domainPath.replace(org, other))).status).toBe(404);
  expect((await request(bindingPath.replace(project, other))).status).toBe(404);
  expect((await request(domainPath + "?hostname=forged.example.com")).status).toBe(400);
  expect((await request(identityPath.replace(project, "invalid"))).status).toBe(400);
  for (const body of [
    { hostname: identity.hostname, extra: true },
    { hostname: "https://example.com" },
    { hostname: "*.example.com" },
    { hostname: "x".repeat(17000) },
  ])
    expect((await request(identityPath, "PUT", body)).status).toBe(400);
  for (const changed of [
    { default_reply_to: "x\r\nBcc:bad@evil.com" },
    { sender_addresses: ["x@mail.example.com"], default_from: "absent@mail.example.com" },
    { expected_revision: -1 },
    { sender_addresses: Array.from({ length: 33 }, (_, i) => `x${i}@mail.example.com`) },
    { mail_domain_id: "invalid" },
  ])
    expect(
      (
        await request(bindingPath, "PUT", {
          mail_domain_id: domainId,
          sending: true,
          sender_addresses: binding.sender_addresses,
          default_from: binding.default_from,
          default_reply_to: null,
          expected_revision: 0,
          ...changed,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await request(`/v1/organizations/${org}/mail-domains`, "POST", {
        domain: "mail.example.com",
        sending: false,
      })
    ).status,
  ).toBe(400);
  returnNull = true;
  expect((await request(identityPath)).status).toBe(404);
  expect((await request(bindingPath)).status).toBe(404);
  returnNull = false;
  failPrivate = "mail_domain_mismatch";
  expect(
    (
      await request(bindingPath, "PUT", {
        mail_domain_id: domainId,
        sending: true,
        sender_addresses: binding.sender_addresses,
        default_from: binding.default_from,
        default_reply_to: null,
        expected_revision: 0,
      })
    ).status,
  ).toBe(409);
  failPrivate = "";
  corruptResponse = true;
  const unsafe = await request(domainPath);
  expect(unsafe.status).toBe(503);
  expect(await unsafe.text()).not.toContain("must-never-leak");
  corruptResponse = false;
  authenticated = {
    ...principal,
    connectUser: {} as NonNullable<AuthenticatedPrincipal["connectUser"]>,
  };
  const selected = await request(`/v1/organizations/${org}/mail-domains`);
  expect(selected.status).toBe(200);
  expect(((await selected.json()) as { items: unknown[] }).items).toHaveLength(2);
  const fullAccount = authenticated;
  authenticated = {
    ...fullAccount,
    authorizationRestriction: { actions: ["mail-domains:read"], mailDomainIds: [domainId] },
  };
  const limited = await request(`/v1/organizations/${org}/mail-domains`);
  expect(limited.status).toBe(200);
  expect(((await limited.json()) as { items: unknown[] }).items).toHaveLength(1);
  expect((await request(domainPath.replace(domainId, other))).status).toBe(404);
  authenticated = fullAccount;
  expect(
    (
      await request(identityPath + "/dns-authorization", "POST", {
        expected_revision: 1,
        zone: "example.com",
      })
    ).status,
  ).toBe(200);
  expect(calls.at(-1)?.input).toMatchObject({ delegation: frozenDelegation });
  expect(
    (
      await request(domainPath + "/dns-authorization", "POST", {
        expected_revision: 1,
        zone: "example.com",
      })
    ).status,
  ).toBe(200);
  expect(calls.at(-1)?.input).toMatchObject({ delegation: frozenDelegation });
  delegated = false;
  expect(
    (
      await request(identityPath + "/dns-authorization", "POST", {
        expected_revision: 1,
        zone: "example.com",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(domainPath + "/dns-authorization", "POST", {
        expected_revision: 1,
        zone: "example.com",
      })
    ).status,
  ).toBe(404);
  authenticated = principal;
  for (const [error, statusCode] of [
    ["mail_scope_unavailable", 404],
    ["mail_domain_conflict", 409],
    ["mail_domain_pending_limit", 409],
    ["mail_domain_mismatch", 409],
    ["mail_binding_revision_conflict", 409],
    ["application_identity_stale", 409],
    ["idempotency_key_reused", 409],
    ["Invalid mail configuration", 400],
    ["unexpected_provider_secret", 503],
    ["paid_plan_required", 402],
    ["insufficient_organization_credits", 402],
    ["project_budget_exceeded", 402],
    ["mail_provider_capacity_reached", 503],
    ["Mail domain requires a registrable public domain", 400],
    ["A customer application domain is required", 400],
    ["A customer mail domain is required", 400],
    ["Invalid sender local part", 400],
    ["dns_authority_revoked", 404],
    ["mail_dns_authorization_required", 409],
    ["mail_dns_receipt_changed", 409],
  ] as const)
    expect(sharedMailError(new Error(error)).status).toBe(statusCode);
  const preserved = sharedMailError(new Error("mail_scope_unavailable"));
  expect(sharedMailError(preserved)).toBe(preserved);
  for (const [command, result] of [
    [commands[6], { ...binding, default_from: null }],
    [commands[9], { ...identity, project_id: other }],
    [
      commands[9],
      { ...identity, challenge: { ...identity.challenge, name: "_omh-project.foreign.com" } },
    ],
    [commands[4], { ...authorization, authorization_url: "https://attacker.example/oauth" }],
    [commands[5], { ...status, status: "not_authorized", scopes: ["dns.write"] }],
  ] as const) {
    if (!command) throw Error("missing test command");
    expect(() => assertSharedMailResponse(result, command)).toThrow();
  }
}
