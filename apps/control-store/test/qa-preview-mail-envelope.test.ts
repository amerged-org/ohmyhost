import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createTestControl, coreRouter, type TestControl } from "./support/control-d1.js";
import { admitConsentingUser, STORED_NOW } from "./support/platform-fixtures.js";
import { mailFixture, fundMailFixture } from "./mail/mail-fixture.js";
import { newUlid } from "../src/catalog/common.js";

const fake = vi.hoisted(() => ({
  scope: {
    organizationId: "",
    projectId: "",
    environmentId: "",
    principalId: "user:user_01JWHSH01K3QSVWDSVMQNB7RC3",
  },
}));
vi.mock("../src/catalog/runtime-secrets/qa-preview-mail-scope.js", () => ({
  QA_PREVIEW_MAIL_SCOPE: fake.scope,
}));
import { readQaPreviewMailEnvelope } from "../src/catalog/runtime-secrets/qa-preview-mail.js";
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control?.dispose());

it("reads only an exact QA Dev mail envelope under real D1 grant, credit and sender authority", async () => {
  const actual = await vi.importActual<
    typeof import("../src/catalog/runtime-secrets/qa-preview-mail-scope.js")
  >("../src/catalog/runtime-secrets/qa-preview-mail-scope.js");
  expect(actual.QA_PREVIEW_MAIL_SCOPE).toEqual({
    organizationId: "01M145HEM4JWAP8KJBG92BSCGE",
    projectId: "01M700N2PQY18W4NGX2TSM9FKT",
    environmentId: "01M700N2PQY18W4NGX2TSM9FKZ",
    principalId: "user:user_01JWHSH01K3QSVWDSVMQNB7RC3",
  });
  const fixture = await mailFixture(control);
  await fundMailFixture(control, fixture);
  const project = fixture.fixture.project;
  Object.assign(fake.scope, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
  });
  const scope = {
    organizationId: parseUlid(project.organizationId),
    projectId: parseUlid(project.projectId),
    environmentId: parseUlid(project.devEnvironmentId),
  };
  await admitConsentingUser(control, project.organizationId, "user_01JWHSH01K3QSVWDSVMQNB7RC3");
  const value = "QATEST".repeat(7) + "X"; // disposable synthetic gateway key
  const sealed = await fixture.cipher.encrypt({ ...scope, name: "OHMYHOST_MAIL_KEY", value });
  await control.core.batch([
    control.core
      .prepare("DELETE FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2")
      .bind(project.organizationId, project.projectId),
    control.core
      .prepare(
        `INSERT INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,?4,'omh.st',?5,?6,?7,?8,?8,?9)`,
      )
      .bind(
        project.organizationId,
        project.projectId,
        newUlid(),
        project.handle,
        `${project.handle}.dev.check.omh.st`,
        `dev-${project.handle}.dev.check.omh.st`,
        fake.scope.principalId,
        new Uint8Array(32).fill(2),
        STORED_NOW,
      ),
    control.core
      .prepare(
        `INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'OHMYHOST_MAIL_KEY',?4,?5,?6,?7,1,?8,?8)`,
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        sealed.ciphertext,
        sealed.nonce,
        sealed.valueSha256,
        sealed.keyVersion,
        STORED_NOW,
      ),
  ]);
  const context = { directory: control.core, router: coreRouter(control) };
  const read = () => readQaPreviewMailEnvelope(context, undefined);
  const row = await read();
  expect(row).toMatchObject({
    ...scope,
    name: "OHMYHOST_MAIL_KEY",
    revision: 1,
    devAccessEpoch: 1,
    senderDomain: fixture.domain,
    senderRevision: "1",
  });
  expect(await fixture.cipher.decrypt({ ...scope, ...row })).toBe(value);
  await expect(
    readQaPreviewMailEnvelope(context, { projectId: project.projectId }),
  ).rejects.toThrow("qa_mail_key_unavailable");
  const run = (sql: string, ...args: unknown[]) =>
    control.core
      .prepare(sql)
      .bind(...args)
      .run();
  await run(
    "UPDATE environments SET dev_access_epoch=0 WHERE organization_id=?1 AND environment_id=?2",
    scope.organizationId,
    scope.environmentId,
  );
  await expect(read()).rejects.toThrow("qa_mail_key_unavailable");
  await run(
    "UPDATE environments SET dev_access_epoch=1 WHERE organization_id=?1 AND environment_id=?2",
    scope.organizationId,
    scope.environmentId,
  );
  await run(
    "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2",
    scope.organizationId,
    scope.projectId,
  );
  await expect(read()).rejects.toThrow("qa_mail_key_unavailable");
  await run(
    "UPDATE projects SET owner_state='active' WHERE organization_id=?1 AND project_id=?2",
    scope.organizationId,
    scope.projectId,
  );
  await run(
    "UPDATE project_mail_domain_bindings SET state='suspended' WHERE project_id=?1",
    scope.projectId,
  );
  await expect(read()).rejects.toThrow("qa_mail_key_unavailable");
  await run(
    "UPDATE project_mail_domain_bindings SET state='active' WHERE project_id=?1",
    scope.projectId,
  );
  await run(
    "UPDATE credit_account SET paid_until='2000-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    scope.organizationId,
  );
  await expect(read()).rejects.toThrow("qa_mail_key_unavailable");
  await run(
    "UPDATE credit_account SET paid_until='2099-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    scope.organizationId,
  );
  await run(
    "UPDATE local_authorization_grants SET revoked_at=?3 WHERE organization_id=?1 AND principal_id=?2",
    scope.organizationId,
    fake.scope.principalId,
    STORED_NOW,
  );
  await expect(read()).rejects.toThrow("qa_mail_key_unavailable");
});
