import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import type { D1Database } from "../../src/d1-types.js";
import { authorizeAiKey } from "../../src/catalog/ai/auth.js";
import {
  authorizeMailGatewayKey,
  readMailSendingKey,
  readSender,
} from "../../src/catalog/mail/auth.js";
import { hash, mailFixture } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
it("authenticates the gateway key and returns the sealed sender custody without moving plaintext/AAD into Core", async () => {
  const f = await mailFixture(control),
    input = { projectId: f.scope.projectId, keySha256: hash(f.key) };
  expect(await authorizeMailGatewayKey(f.context, input)).toEqual({
    ...f.scope,
    domain: f.domain,
  });
  const wire = await readMailSendingKey(f.context, { ...f.scope, now: f.now });
  expect(wire).toEqual({
    domainId: f.domainId,
    keyOrganizationId: f.scope.organizationId,
    keyProjectId: f.scope.projectId,
    keyEnvironmentId: f.scope.environmentId,
    ciphertext: hex(f.sealed.ciphertext),
    nonce: hex(f.sealed.nonce),
    valueSha256: hex(f.sealed.valueSha256),
    keyVersion: f.sealed.keyVersion,
  });
  const sealed = {
    ciphertext: bytes(wire.ciphertext),
    nonce: bytes(wire.nonce),
    valueSha256: bytes(wire.valueSha256),
    keyVersion: wire.keyVersion,
  };
  expect(await f.cipher.decrypt({ ...f.scope, name: "RESEND_DOMAIN_SEND_KEY", ...sealed })).toBe(
    f.providerKey,
  );
  await expect(
    f.cipher.decrypt({
      ...f.scope,
      projectId: newUlid(),
      name: "RESEND_DOMAIN_SEND_KEY",
      ...sealed,
    }),
  ).rejects.toThrow();
  expect(await authorizeMailGatewayKey(f.context, { ...input, projectId: newUlid() })).toBeNull();
  expect(
    await authorizeMailGatewayKey(f.context, { ...input, keySha256: "00".repeat(32) }),
  ).toBeNull();
});
it("keeps receiving ownership after outbound detachment and refuses actual lifecycle revocation", async () => {
  const f = await mailFixture(control),
    input = { projectId: f.scope.projectId, keySha256: hash(f.key) };
  await f.update(
    "UPDATE project_mail_domain_bindings SET state='detached',sending=0,revision=revision+1,updated_at=?1 WHERE project_id=?2",
    [new Date().toISOString(), f.scope.projectId],
  );
  expect(await authorizeMailGatewayKey(f.context, input)).toBeNull();
  expect(await authorizeMailGatewayKey(f.context, { ...input, receiving: true })).toEqual({
    ...f.scope,
    domain: f.domain,
  });
  await f.update(
    "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  expect(await authorizeMailGatewayKey(f.context, { ...input, receiving: true })).toBeNull();
});
it("retains same-main-domain proof and suppression decisions for nonlegacy shared senders", async () => {
  const f = await mailFixture(control, false),
    input = { projectId: f.scope.projectId, keySha256: hash(f.key) };
  expect(await authorizeMailGatewayKey(f.context, input)).toEqual({ ...f.scope, domain: f.domain });
  await f.update(
    "UPDATE workspace_mail_domains SET reputation_state='suspended',reputation_suspended_at=?1,reputation_suspension_reason='bounce_rate',reputation_triggering_event_id='11111111-1111-4111-8111-111111111111' WHERE domain_id=?2",
    [new Date().toISOString(), f.domainId],
  );
  await expect(authorizeMailGatewayKey(f.context, input)).rejects.toMatchObject({
    code: "mail_reputation_suspended",
  });
  await expect(readMailSendingKey(f.context, { ...f.scope, now: f.now })).rejects.toMatchObject({
    code: "mail_reputation_suspended",
  });
});

it("authenticates the exact Dev key after a verified revision-four rebind while preserving identity and custody fences", async () => {
  const f = await mailFixture(control, false),
    dev = { ...f.scope, environmentId: f.fixture.project.devEnvironmentId },
    key = `${newUlid()}${newUlid()}`.slice(0, 43),
    sealed = await f.cipher.encrypt({ ...dev, name: "OHMYHOST_MAIL_KEY", value: key });
  await f.insert("environment_secrets", {
    organization_id: dev.organizationId,
    project_id: dev.projectId,
    environment_id: dev.environmentId,
    name: "OHMYHOST_MAIL_KEY",
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    value_sha256: sealed.valueSha256,
    key_version: sealed.keyVersion,
    revision: 1,
    created_at: f.now,
    updated_at: f.now,
  });
  await f.update("UPDATE project_mail_domain_bindings SET revision=2 WHERE project_id=?1", [
    f.scope.projectId,
  ]);
  await f.update(
    "UPDATE project_mail_domain_bindings SET revision=3,state='detached',sending=0 WHERE project_id=?1",
    [f.scope.projectId],
  );
  await f.update(
    "UPDATE project_mail_domain_bindings SET revision=4,state='active',sending=1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  const auth = { projectId: dev.projectId, keySha256: hash(key) };
  expect(await authorizeMailGatewayKey(f.context, auth)).toEqual({ ...dev, domain: f.domain });
  expect(await readSender(control.core, { ...dev, now: f.now })).toMatchObject({
    bindingRevision: "4",
    domainId: f.domainId,
    keyOrganizationId: f.scope.organizationId,
    keyProjectId: f.scope.projectId,
    keyEnvironmentId: f.scope.environmentId,
  });
  const custody = await readMailSendingKey(f.context, { ...dev, now: f.now });
  expect(
    await f.cipher.decrypt({
      organizationId: custody.keyOrganizationId,
      projectId: custody.keyProjectId,
      environmentId: custody.keyEnvironmentId,
      name: "RESEND_DOMAIN_SEND_KEY",
      ciphertext: bytes(custody.ciphertext),
      nonce: bytes(custody.nonce),
      valueSha256: bytes(custody.valueSha256),
      keyVersion: custody.keyVersion,
    }),
  ).toBe(f.providerKey);
  expect(
    await authorizeMailGatewayKey(f.context, { ...auth, keySha256: hash("wrong") }),
  ).toBeNull();
  const duplicate = await f.cipher.encrypt({ ...dev, name: "OHMYHOST_MAIL_KEY", value: f.key });
  const replaceDev = (value: typeof sealed) =>
    f.update(
      "UPDATE environment_secrets SET ciphertext=?1,nonce=?2,value_sha256=?3,key_version=?4,revision=revision+1 WHERE project_id=?5 AND environment_id=?6 AND name='OHMYHOST_MAIL_KEY'",
      [
        value.ciphertext,
        value.nonce,
        value.valueSha256,
        value.keyVersion,
        dev.projectId,
        dev.environmentId,
      ],
    );
  await replaceDev(duplicate);
  expect(
    await authorizeMailGatewayKey(f.context, { projectId: dev.projectId, keySha256: hash(f.key) }),
  ).toBeNull();
  await replaceDev(sealed);
  expect(await authorizeMailGatewayKey(f.context, auth)).toEqual({ ...dev, domain: f.domain });
  await f.update(
    "UPDATE project_application_domain_identities SET revision=revision+1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  expect(await authorizeMailGatewayKey(f.context, auth)).toBeNull();
  await f.update(
    "UPDATE project_mail_domain_bindings SET application_identity_revision=2,revision=revision+1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  expect(await authorizeMailGatewayKey(f.context, auth)).toEqual({ ...dev, domain: f.domain });
  const past = new Date(Date.now() - 60000).toISOString(),
    before = new Date(Date.now() - 120000).toISOString();
  await f.update(
    "UPDATE project_application_domain_identities SET verified_at=?1,expires_at=?2 WHERE project_id=?3",
    [before, past, f.scope.projectId],
  );
  expect(await authorizeMailGatewayKey(f.context, auth)).toBeNull();
});

it("finds the mail and AI gateway keys through an index on environment secrets, not a scan of every tenant", async () => {
  // Capture the statements the two key lookups run, then ask the migrated Core how it executes each one.
  const statements: string[] = [];
  const directory = {
    prepare: (sql: string) => {
      statements.push(sql);
      return control.core.prepare(sql);
    },
  } as unknown as D1Database;
  const context = { directory, router: coreRouter(control) };
  const keySha256 = "00".repeat(32);
  await authorizeMailGatewayKey(context, { projectId: newUlid(), keySha256 });
  await authorizeAiKey(context, { projectId: newUlid(), keySha256 });
  expect(statements).toHaveLength(2);
  for (const sql of statements) {
    const plan = await control.core
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(null, null, null)
      .all<{ detail: string }>();
    expect(
      plan.results.filter((row) => /^SCAN (s|other|environment_secrets)\b/u.test(row.detail)),
      sql.slice(0, 80),
    ).toEqual([]);
  }
});
