import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { storedTimestamp } from "../../control-store/src/timestamps.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { grantOneTime, makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { createD1SharedMailPort, isD1SharedMailRuntime } from "../src/d1-shared-mail.js";
import { sharedMailError } from "../src/shared-mail.js";

it("runs the shared-mail port over the Core: provider phases run once per receipt, replays answer from it", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      project = await seedProject(control),
      organizationId = project.organizationId,
      calls: string[] = [],
      provider = {
        async ensureWorkspaceMailDomain(input: unknown) {
          calls.push(`ensure:${(input as { commandOperation: string }).commandOperation}`);
          return { ensured: true };
        },
        async syncWorkspaceMailDomain(input: unknown) {
          calls.push(`sync:${(input as { commandOperation: string }).commandOperation}`);
          return {};
        },
        async retireWorkspaceMailDomain() {
          calls.push("retire");
          return { retired: true };
        },
      },
      port = createD1SharedMailPort({
        runtime: store.sharedMail as never,
        provider,
        clock: { now: () => new Date() },
        ids: { next: () => parseUlid(newUlid()) },
      }),
      scope = {
        organizationId,
        principalId: "user:fixture",
        requestId: "req_fixture",
      },
      mutation = (key: string) => ({
        idempotencyKey: key,
        canonicalRequestDigest: new Uint8Array(32).fill(7),
      }),
      project_ = {
        ...scope,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      },
      now = new Date().toISOString();
    await makePaid(control.core, organizationId, undefined, now);
    await grantOneTime(control.core, organizationId, 1_000_000_000, undefined, now);
    await control.core
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
      )
      .bind(storedTimestamp(now))
      .run();

    const domain = `mail-${newUlid().slice(-10).toLowerCase()}.example.com`,
      create = { ...scope, ...mutation("create-1"), domain, sending: true as const };
    expect(await port.createWorkspaceMailDomain(create)).toEqual({ ensured: true });
    expect(await port.createWorkspaceMailDomain(create)).toEqual({ ensured: true });
    expect(calls).toEqual(["ensure:create"]);
    const listed = (await port.listWorkspaceMailDomains(scope)) as {
      items: { domain_id: string }[];
    };
    expect(listed.items).toHaveLength(1);
    const mailDomainId = listed.items[0]?.domain_id ?? "";
    expect(await port.readWorkspaceMailDomain({ ...scope, mailDomainId })).toMatchObject({
      domain_id: mailDomainId,
      domain,
    });
    expect(isD1SharedMailRuntime(store.sharedMail)).toBe(true);
    expect(isD1SharedMailRuntime({ listDomains: () => [] })).toBe(false);
    await expect(port.readProjectMailDomainBinding(project_)).rejects.toThrow(
      "mail_scope_unavailable",
    );

    await control.core
      .prepare(
        "UPDATE workspace_mail_domains SET sending_status='ready',provider_domain_id=?3,sending_key_id=?4,sending_key_ciphertext=zeroblob(32),sending_key_nonce=zeroblob(12),sending_key_sha256=zeroblob(32),sending_key_version=1 WHERE organization_id=?1 AND domain_id=?2",
      )
      .bind(organizationId, mailDomainId, `provider_${mailDomainId}`, `key_${mailDomainId}`)
      .run();
    await control.core
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
    const bind = {
      ...project_,
      ...mutation("bind-1"),
      mailDomainId,
      expectedRevision: 0,
      sending: true,
      senderAddresses: [`hello@${domain}`],
      defaultFrom: `hello@${domain}`,
      defaultReplyTo: null,
    };
    const bound = await port.putProjectMailDomainBinding(bind);
    expect(bound).toMatchObject({ mail_domain_id: mailDomainId, revision: 1, status: "active" });
    expect(await port.readProjectMailDomainBinding(project_)).toEqual(bound);
    expect(
      await port.detachProjectMailDomainBinding({
        ...project_,
        ...mutation("detach-1"),
        expectedRevision: 1,
      }),
    ).toMatchObject({ revision: 2, status: "detached" });
    expect(
      await port.retireWorkspaceMailDomain({
        ...scope,
        ...mutation("retire-1"),
        mailDomainId,
        expectedRevision: 1,
      }),
    ).toEqual({ retired: true });
    expect(calls).toEqual(["ensure:create", "sync:bind", "sync:detach", "retire"]);
  } finally {
    await control.dispose();
  }
});

it("names what keeps a workspace mail domain in use instead of a generic change", () => {
  expect(sharedMailError(new Error("mail_domain_in_use"))).toMatchObject({
    status: 409,
    code: "mail_domain_conflict",
    message: expect.stringContaining("24 hours"),
  });
});
