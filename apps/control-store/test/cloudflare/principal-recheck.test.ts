import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { declareZone, scope, sealed, time } from "../support/cloudflare-fixtures.js";
import { seedProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("reads a consented grant only while its consenting principal still holds write authority", async () => {
  const store = createControlStore(control.bindings);
  const project = await seedProject(control);
  const auth = { ...(await declareZone(control, project)), principalId: "user:user_consent" };
  await store.cloudflareDomain.claimAuthorization(auth);
  await store.cloudflareDomain.consumeAuthorization({
    authorizationId: auth.authorizationId,
    stateSha256: auth.stateSha256,
    principalId: auth.principalId,
    consumedAt: time(1),
  });
  await store.cloudflareDomain.putGrant({
    ...scope(project),
    authorizationId: auth.authorizationId,
    principalId: auth.principalId,
    zoneName: auth.zoneName,
    zoneId: "a".repeat(32),
    accountId: "b".repeat(32),
    scopes: ["dns.write", "zone.read"],
    ...sealed(1),
    accessExpiresAt: time(58),
    connectedAt: time(2),
  });
  expect(await store.cloudflareDomain.readGrant(scope(project))).toMatchObject({
    principalId: "user:user_consent",
    status: "active",
  });

  // The owner's membership is revoked: the grant still exists, but its DNS writes are no longer authorized.
  await control.core
    .prepare(
      "UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1 AND workos_user_id='user_consent'",
    )
    .bind(project.organizationId)
    .run();
  // The grant is withheld from DNS writes, and the status says it needs the owner's reauthorization.
  expect(await store.cloudflareDomain.readGrant(scope(project))).toEqual({
    status: "reauthorization_required",
    organizationId: project.organizationId,
    projectId: project.projectId,
    authorizationId: auth.authorizationId,
    principalId: "user:user_consent",
    zoneName: auth.zoneName,
  });
  expect(await store.cloudflareDomain.readStatus({ ...scope(project), now: time(3) })).toEqual({
    status: "reauthorization_required",
    zone: auth.zoneName,
    scopes: [],
    expiresAt: null,
  });
});

it("keeps a grant consented by an API key or service principal readable, since it never had a user's membership to recheck", async () => {
  const store = createControlStore(control.bindings);
  const project = await seedProject(control);
  const auth = { ...(await declareZone(control, project)), principalId: "service:client_consent" };
  await store.cloudflareDomain.claimAuthorization(auth);
  await store.cloudflareDomain.consumeAuthorization({
    authorizationId: auth.authorizationId,
    stateSha256: auth.stateSha256,
    principalId: auth.principalId,
    consumedAt: time(1),
  });
  await store.cloudflareDomain.putGrant({
    ...scope(project),
    authorizationId: auth.authorizationId,
    principalId: auth.principalId,
    zoneName: auth.zoneName,
    zoneId: "c".repeat(32),
    accountId: "d".repeat(32),
    scopes: ["dns.write", "zone.read"],
    ...sealed(1),
    accessExpiresAt: time(58),
    connectedAt: time(2),
  });
  expect(await store.cloudflareDomain.readGrant(scope(project))).toMatchObject({
    principalId: "service:client_consent",
    status: "active",
  });
});
