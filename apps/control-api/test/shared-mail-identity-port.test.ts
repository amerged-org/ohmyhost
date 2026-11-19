import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  createSharedMailIdentityPort,
  type SharedMailIdentityBinding,
} from "../src/shared-mail-identity-port.js";

const org = "00000000000000000000087501",
  project = "00000000000000000000087502",
  domainId = "00000000000000000000087505",
  other = "00000000000000000000087506",
  now = "2026-10-30T10:00:00.000Z";
const scope = {
  organizationId: org,
  principalId: "user:user_control_ports",
  requestId: "req_ports",
};
const mutation = (name: string) => ({
  idempotencyKey: name,
  canonicalRequestDigest: createHash("sha256").update(name).digest(),
});
const names = [
  "readApplicationDomainIdentity",
  "declareApplicationDomainIdentity",
  "verifyApplicationDomainIdentity",
  "revokeApplicationDomainIdentity",
  "beginApplicationIdentityAuthorization",
  "getApplicationIdentityAuthorizationStatus",
  "beginWorkspaceMailAuthorization",
  "getWorkspaceMailAuthorizationStatus",
  "revokeApplicationIdentityAuthorization",
  "revokeWorkspaceMailAuthorization",
] as const;

function fixture() {
  const seen: { name: string; input: unknown }[] = [];
  const reply: { value: unknown } = { value: { ok: true } };
  const binding = Object.fromEntries(
    names.map((name) => [
      name,
      async (input: unknown) => {
        seen.push({ name, input });
        return reply.value;
      },
    ]),
  ) as SharedMailIdentityBinding;
  return { seen, reply, adapter: createSharedMailIdentityPort(binding) };
}
const proofScope = { ...scope, projectId: project };
const revise = { ...proofScope, ...mutation("identity"), expectedRevision: 1 };
const delegation = {
  grantId: other,
  clientId: "client_test",
  consentHash: "a".repeat(64),
  grantRevision: 2,
};

it("sends the exact private identity requests with hashed idempotency and returns the binding result", async () => {
  const { seen, reply, adapter } = fixture();
  for (const call of [
    () => adapter.readApplicationDomainIdentity(proofScope),
    () => adapter.declareApplicationDomainIdentity({ ...revise, hostname: "sign.example.com" }),
    () => adapter.verifyApplicationDomainIdentity(revise),
    () => adapter.revokeApplicationDomainIdentity(revise),
  ])
    expect(await call()).toEqual(reply.value);
  expect(seen.map((call) => call.name)).toEqual(names.slice(0, 4));
  expect(seen[0]?.input).toEqual({
    actorId: scope.principalId,
    organizationId: org,
    projectId: project,
  });
  expect(seen[1]?.input).toEqual({
    actorId: scope.principalId,
    organizationId: org,
    projectId: project,
    idempotencyKeySha256: `sha256:${createHash("sha256").update("identity").digest("hex")}`,
    requestSha256: `sha256:${revise.canonicalRequestDigest.toString("hex")}`,
    hostname: "sign.example.com",
  });
  expect(seen[2]?.input).toMatchObject({ expectedRevision: 1 });
  expect(seen[3]?.input).toMatchObject({ expectedRevision: 1 });
  expect(seen[2]?.input).not.toHaveProperty("delegation");
});

it("forwards the delegation on every identity mutation that accepts it", async () => {
  const { seen, adapter } = fixture();
  await adapter.declareApplicationDomainIdentity({
    ...revise,
    delegation,
    hostname: "sign.example.com",
  });
  await adapter.verifyApplicationDomainIdentity({ ...revise, delegation });
  await adapter.revokeApplicationDomainIdentity({ ...revise, delegation });
  expect(seen.map((call) => (call.input as { delegation: unknown }).delegation)).toEqual([
    delegation,
    delegation,
    delegation,
  ]);
});

it("maps a missing identity and a conflict to their reviewed error codes", async () => {
  const { reply, adapter } = fixture();
  reply.value = null;
  await expect(adapter.readApplicationDomainIdentity(proofScope)).rejects.toThrow(
    "application_identity_not_found",
  );
  reply.value = { status: "conflict", code: "application_identity_dns_pending" };
  await expect(adapter.verifyApplicationDomainIdentity(revise)).rejects.toThrow(
    "application_identity_dns_pending",
  );
  reply.value = { status: "conflict" };
  await expect(adapter.verifyApplicationDomainIdentity(revise)).rejects.toThrow(
    "application_identity_stale",
  );
});

it("renames the authorization start reply and forwards zone, mail domain and delegation", async () => {
  const { seen, reply, adapter } = fixture();
  reply.value = {
    authorizationId: other,
    authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?state=frozen",
    expiresAt: now,
  };
  for (const call of [
    () =>
      adapter.beginApplicationIdentityAuthorization({ ...revise, zone: "example.com", delegation }),
    () =>
      adapter.beginWorkspaceMailAuthorization({
        ...scope,
        ...mutation("identity"),
        mailDomainId: domainId,
        expectedRevision: 1,
        zone: "example.com",
        delegation,
      }),
  ])
    expect(await call()).toEqual({
      authorization_id: other,
      authorization_url: "https://dash.cloudflare.com/oauth2/auth?state=frozen",
      expires_at: now,
    });
  expect(seen[0]?.input).toMatchObject({ projectId: project, zone: "example.com", delegation });
  expect(seen[1]?.input).toMatchObject({ mailDomainId: domainId, zone: "example.com", delegation });
  expect(seen[1]?.input).not.toHaveProperty("projectId");
});

it("renames the authorization status and revoke replies", async () => {
  const { seen, reply, adapter } = fixture();
  reply.value = {
    status: "revoked",
    zone: "example.com",
    scopes: ["dns.write", "zone.read"],
    expiresAt: now,
  };
  for (const call of [
    () => adapter.getApplicationIdentityAuthorizationStatus(proofScope),
    () => adapter.getWorkspaceMailAuthorizationStatus({ ...scope, mailDomainId: domainId }),
    () => adapter.revokeApplicationIdentityAuthorization(revise),
    () =>
      adapter.revokeWorkspaceMailAuthorization({
        ...scope,
        ...mutation("identity"),
        mailDomainId: domainId,
        expectedRevision: 1,
      }),
  ])
    expect(await call()).toEqual({
      status: "revoked",
      zone: "example.com",
      scopes: ["dns.write", "zone.read"],
      expires_at: now,
    });
  expect(seen.map((call) => call.name)).toEqual([
    "getApplicationIdentityAuthorizationStatus",
    "getWorkspaceMailAuthorizationStatus",
    "revokeApplicationIdentityAuthorization",
    "revokeWorkspaceMailAuthorization",
  ]);
  expect(seen[1]?.input).toEqual({
    actorId: scope.principalId,
    organizationId: org,
    mailDomainId: domainId,
  });
});

it("rejects a conflict or a malformed authorization reply", async () => {
  const { reply, adapter } = fixture();
  reply.value = { status: "conflict", code: "dns_authorization_expired" };
  await expect(adapter.getApplicationIdentityAuthorizationStatus(proofScope)).rejects.toThrow(
    "dns_authorization_expired",
  );
  reply.value = { status: "conflict" };
  await expect(adapter.getApplicationIdentityAuthorizationStatus(proofScope)).rejects.toThrow(
    "dns_resource_stale",
  );
  for (const bad of ["bad private response", null, ["list"]]) {
    reply.value = bad;
    await expect(adapter.getApplicationIdentityAuthorizationStatus(proofScope)).rejects.toThrow(
      "Invalid DNS authorization result",
    );
  }
});
