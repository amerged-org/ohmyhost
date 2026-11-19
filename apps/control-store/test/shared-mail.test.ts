import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { storedTimestamp } from "../src/timestamps.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { fundOrganization } from "./support/mail-events-fixture.js";
import { seedProject } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const sha = (character: string) => character.repeat(64);

describe("shared mail admission", () => {
  it("creates, binds, detaches and retires a workspace sender with one receipt per request", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      now = new Date().toISOString(),
      organizationId = project.organizationId,
      domainId = newUlid(),
      domain = `mail-${domainId.slice(-10).toLowerCase()}.example.com`,
      scope = {
        organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      },
      request = (key: string, digest = sha("a")) => ({
        organizationId,
        idempotencyKey: key,
        principalId: "user:fixture",
        requestSha256: digest,
        now,
      });
    await fundOrganization(control, organizationId, now);
    await db
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
      )
      .bind(storedTimestamp(now))
      .run();

    // create: one receipt per key, a key never serves another request, a live name is never created twice
    const create = { ...request("create-1"), domainId, domain };
    expect(await store.sharedMail.createDomain(create)).toEqual({ domainId, response: null });
    expect(await store.sharedMail.createDomain(create)).toEqual({ domainId, response: null });
    await expect(
      store.sharedMail.createDomain({ ...create, requestSha256: sha("b") }),
    ).rejects.toThrow("idempotency_key_reused");
    await expect(
      store.sharedMail.createDomain({ ...request("create-2"), domainId: newUlid(), domain }),
    ).rejects.toThrow("mail_domain_conflict");
    const complete = (response: unknown) =>
      store.sharedMail.completeCommand({
        organizationId,
        idempotencyKey: "create-1",
        response,
        now,
      });
    expect(await complete({ ok: 1 })).toEqual({ ok: 1 });
    expect(await complete({ ok: 2 })).toEqual({ ok: 1 });
    expect(await store.sharedMail.createDomain(create)).toEqual({ domainId, response: { ok: 1 } });
    const listed = (await store.sharedMail.listDomains({ organizationId })) as { domain: string }[];
    expect(listed.map((row) => row.domain)).toEqual([domain]);
    expect(await store.sharedMail.readDomain({ organizationId, domainId })).toMatchObject({
      sending: "pending",
      revision: 1,
      bindings_count: 0,
    });

    // bind needs the provider's ready sender and a verified proof of the same registrable domain
    const bind = {
      ...request("bind-1"),
      ...scope,
      domainId,
      sending: true,
      senderAddresses: [`hello@${domain}`],
      defaultFrom: `hello@${domain}`,
      defaultReplyTo: null,
      expectedRevision: 0,
    };
    await expect(store.sharedMail.bindProject(bind)).rejects.toThrow("mail_domain_mismatch");
    await db
      .prepare(
        "UPDATE workspace_mail_domains SET sending_status='ready',provider_domain_id=?3,sending_key_id=?4,sending_key_ciphertext=zeroblob(32),sending_key_nonce=zeroblob(12),sending_key_sha256=zeroblob(32),sending_key_version=1 WHERE organization_id=?1 AND domain_id=?2",
      )
      .bind(organizationId, domainId, `provider_${domainId}`, `key_${domainId}`)
      .run();
    await db
      .prepare(
        "INSERT INTO project_application_domain_identities(project_id,organization_id,hostname,registrable_domain,revision,state,challenge_name,challenge_value,declared_at,verified_at,expires_at,idempotency_key_sha256,request_sha256,actor_id) VALUES(?1,?2,'app.example.com','example.com',1,'verified','_omh-project.app.example.com',?3,?4,?4,?5,zeroblob(32),zeroblob(32),'user:fixture')",
      )
      .bind(
        project.projectId,
        organizationId,
        "a".repeat(43),
        storedTimestamp(now),
        storedTimestamp(new Date(Date.parse(now) + 86_400_000).toISOString()),
      )
      .run();
    const bound = await store.sharedMail.bindProject(bind);
    expect(bound).toMatchObject({
      mail_domain_id: domainId,
      revision: 1,
      sending: true,
      status: "active",
      sender_addresses: [`hello@${domain}`],
      application_domain_identity: { hostname: "app.example.com", status: "verified" },
    });
    expect(await store.sharedMail.bindProject(bind)).toEqual(bound);
    expect(await store.sharedMail.readBinding({ ...scope, now })).toEqual(bound);
    await expect(
      store.sharedMail.bindProject({ ...bind, ...request("bind-2"), expectedRevision: 0 }),
    ).rejects.toThrow("mail_binding_revision_conflict");
    expect(await store.sharedMail.readDomain({ organizationId, domainId })).toMatchObject({
      bindings_count: 1,
    });

    // detach stops sending at the expected revision only
    await expect(
      store.sharedMail.detachProject({ ...request("detach-1"), ...scope, expectedRevision: 9 }),
    ).rejects.toThrow("mail_binding_revision_conflict");
    const detached = await store.sharedMail.detachProject({
      ...request("detach-2"),
      ...scope,
      expectedRevision: 1,
    });
    expect(detached).toMatchObject({ revision: 2, sending: false, status: "detached" });
    expect(
      await store.sharedMail.detachProject({
        ...request("detach-2"),
        ...scope,
        expectedRevision: 1,
      }),
    ).toEqual(detached);

    // retire opens its receipt only at the current sender revision
    await expect(
      store.sharedMail.beginRetire({ ...request("retire-1"), domainId, expectedRevision: 9 }),
    ).rejects.toThrow("mail_resource_revision_conflict");
    const retire = { ...request("retire-2"), domainId, expectedRevision: 1 };
    expect(await store.sharedMail.beginRetire(retire)).toEqual({ response: null });
    expect(await store.sharedMail.beginRetire(retire)).toEqual({ response: null });
    await expect(
      store.sharedMail.completeCommand({
        organizationId,
        idempotencyKey: "absent",
        response: { ok: 1 },
        now,
      }),
    ).rejects.toThrow("mail_operation_pending");
  });

  it("lists only the unverified workspace reservations older than the cutoff, for expiry", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      tag = newUlid().slice(-10).toLowerCase(),
      old = "2026-11-01T10:00:00.000Z",
      fresh = "2026-11-12T10:00:00.000Z",
      cutoff = "2026-11-06T10:00:00.000Z",
      make = async (label: string, now: string) => {
        const organizationId = (await seedProject(control)).organizationId,
          domainId = newUlid();
        await fundOrganization(control, organizationId, new Date().toISOString());
        await store.sharedMail.createDomain({
          organizationId,
          idempotencyKey: `create-${label}-${domainId}`,
          principalId: "user:fixture",
          requestSha256: sha("c"),
          now,
          domainId,
          domain: `${label}-${tag}.example.com`,
        });
        return { organizationId, domainId };
      };
    const stale = await make("stale", old),
      recent = await make("recent", fresh),
      verified = await make("verified", old);
    await db
      .prepare("UPDATE workspace_mail_domains SET sending_status='ready' WHERE domain_id=?1")
      .bind(verified.domainId)
      .run();
    const listed = await store.mailManagementJobs.listExpiredUnverifiedWorkspaces({
      cutoff,
      limit: 50,
    });
    expect(listed.map((row) => row.domainId)).toContain(stale.domainId);
    expect(listed.map((row) => row.domainId)).not.toContain(recent.domainId);
    expect(listed.map((row) => row.domainId)).not.toContain(verified.domainId);
    expect(listed.find((row) => row.domainId === stale.domainId)).toEqual({
      organizationId: stale.organizationId,
      domainId: stale.domainId,
      expectedRevision: 1,
    });
  });

  it("caps an organization's unverified workspace senders; verify or retire frees a slot", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      now = new Date().toISOString(),
      tag = newUlid().slice(-10).toLowerCase(),
      name = (index: number) => `pending-${index}-${tag}.example.com`,
      create = (organizationId: string, index: number) => {
        const domainId = newUlid();
        return store.sharedMail
          .createDomain({
            organizationId,
            idempotencyKey: `create-${domainId}`,
            principalId: "user:fixture",
            requestSha256: sha("a"),
            now,
            domainId,
            domain: name(index),
          })
          .then(() => domainId);
      },
      a = await seedProject(control),
      b = await seedProject(control);
    await fundOrganization(control, a.organizationId, now);
    await fundOrganization(control, b.organizationId, now);
    await db
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
      )
      .bind(storedTimestamp(now))
      .run();

    // a legacy project domain is mirrored here with a status of its own that never changes: it takes no slot
    await db
      .prepare(
        "INSERT INTO resend_mail_domains(organization_id,domain_id,project_id,environment_id,domain,sending,receiving,receiving_suspended,configured_at) VALUES(?,?,?,?,?,1,0,0,?)",
      )
      .bind(
        a.organizationId,
        newUlid(),
        a.projectId,
        a.prodEnvironmentId,
        `legacy-${tag}.example.com`,
        storedTimestamp(now),
      )
      .run();

    // five unverified senders fill the cap; the sixth is refused, and another organization is unaffected
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push(await create(a.organizationId, index));
    expect(ids).toHaveLength(5);
    const retiring = ids[1] ?? "";
    await expect(create(a.organizationId, 5)).rejects.toThrow("mail_domain_pending_limit");
    await expect(create(b.organizationId, 5)).resolves.toBeDefined();

    // verifying one sender frees its slot
    await db
      .prepare(
        "UPDATE workspace_mail_domains SET sending_status='ready' WHERE organization_id=?1 AND domain=?2",
      )
      .bind(a.organizationId, name(0))
      .run();
    await expect(create(a.organizationId, 6)).resolves.toBeDefined();
    await expect(create(a.organizationId, 7)).rejects.toThrow("mail_domain_pending_limit");

    // retiring one pending sender frees its slot too (retiring alone still holds it)
    await store.mailWorkspace.beginRetirement({
      organizationId: a.organizationId,
      domainId: retiring,
      expectedRevision: 1,
      now,
    });
    await expect(create(a.organizationId, 7)).rejects.toThrow("mail_domain_pending_limit");
    await store.mailWorkspace.finishRetirement({
      organizationId: a.organizationId,
      domainId: retiring,
      now,
    });
    await expect(create(a.organizationId, 7)).resolves.toBeDefined();

    // concurrent creates at four pending: only one is admitted
    const c = await seedProject(control);
    await fundOrganization(control, c.organizationId, now);
    for (let index = 10; index < 14; index += 1) await create(c.organizationId, index);
    const settled = await Promise.allSettled([
      create(c.organizationId, 14),
      create(c.organizationId, 15),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((result) => result.status === "rejected");
    expect(String((refused as PromiseRejectedResult).reason)).toContain(
      "mail_domain_pending_limit",
    );
  });

  it("blocks a workspace sender's retirement only while a reserved send can still settle", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      now = new Date().toISOString(),
      tag = newUlid().slice(-10).toLowerCase(),
      project = await seedProject(control),
      hoursAgo = (hours: number) =>
        storedTimestamp(new Date(Date.parse(now) - hours * 3_600_000).toISOString());
    await fundOrganization(control, project.organizationId, now);
    const activeSender = async (index: number) => {
      const domainId = newUlid();
      await store.sharedMail.createDomain({
        organizationId: project.organizationId,
        idempotencyKey: `create-${domainId}`,
        principalId: "user:fixture",
        requestSha256: sha("a"),
        now,
        domainId,
        domain: `retire-${index}-${tag}.example.com`,
      });
      await db
        .prepare("UPDATE workspace_mail_domains SET status='active' WHERE domain_id=?1")
        .bind(domainId)
        .run();
      return domainId;
    };
    const reservedSend = (domainId: string, requestedAt: string) =>
      db
        .prepare(
          "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,requested_at,updated_at,mail_domain_id) VALUES(?1,?2,?3,?4,zeroblob(32),zeroblob(32),zeroblob(32),?5,?5,?6)",
        )
        .bind(
          newUlid(),
          project.organizationId,
          project.projectId,
          `send-${domainId}`,
          requestedAt,
          domainId,
        )
        .run();
    const begin = (domainId: string) =>
      store.mailWorkspace.beginRetirement({
        organizationId: project.organizationId,
        domainId,
        expectedRevision: 1,
        now,
      });
    // A reserved send that never reached the provider, 48 hours old, can no longer settle: it does not block.
    const stale = await activeSender(0);
    await reservedSend(stale, hoursAgo(48));
    await expect(begin(stale)).resolves.toBeDefined();
    // The same send one hour old can still settle, so retirement is refused as in use.
    const fresh = await activeSender(1);
    await reservedSend(fresh, hoursAgo(1));
    await expect(begin(fresh)).rejects.toThrow("mail_domain_in_use");
  });
});
