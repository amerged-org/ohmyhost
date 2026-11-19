import { afterAll, beforeAll, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  cfFixture,
  seedLegacyDomain,
  seedProjectDeletion,
  seedWorkspaceDomain,
} from "../support/cf-mail-fixture.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";

let control: TestControl, store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const receiptOf = async (table: string, key: string, id: string) =>
  JSON.parse(
    (
      await control.core
        .prepare(`SELECT dns_receipts FROM ${table} WHERE ${key} = ?`)
        .bind(id)
        .first<{ dns_receipts: string }>()
    )?.dns_receipts ?? "null",
  ) as unknown;

it("serves the workspace, legacy and deletion DNS requirements and stores exact token-free receipts", async () => {
  const f = await cfFixture(control);
  const dns = store.cfMailDns;
  const workspace = await seedWorkspaceDomain(f, { provisioned: true });
  const scope = { organizationId: f.organizationId, mailDomainId: workspace.domainId };
  expect(await dns.workspace(scope)).toEqual({
    domain: workspace.domain,
    custody_project_id: f.projectId,
    records: '[{"name":"workspace"}]',
  });
  await expect(dns.workspace({ ...scope, mailDomainId: newUlid() })).rejects.toThrow(
    "Workspace mail DNS resource is unavailable",
  );
  const receipt = { zoneId: "1".repeat(32), records: [{ id: "r1", name: workspace.domain }] };
  await dns.saveWorkspace({ ...scope, receipt });
  expect(await receiptOf("workspace_mail_domains", "domain_id", workspace.domainId)).toEqual(
    receipt,
  );
  await expect(
    dns.saveWorkspace({ ...scope, receipt: { ...receipt, refresh_token: "secret" } }),
  ).rejects.toThrow("Invalid mail input");

  const legacyId = await seedLegacyDomain(f);
  const legacyScope = {
    organizationId: f.organizationId,
    projectId: f.projectId,
    environmentId: f.project.prodEnvironmentId,
  };
  expect(await dns.legacy(legacyScope)).toMatchObject({
    domain_id: legacyId,
    project_id: f.projectId,
    records: '[{"name":"legacy"}]',
  });
  expect(await dns.legacy({ ...legacyScope, projectId: newUlid() })).toBeNull();
  await dns.saveLegacy({ domainId: legacyId, receipt });
  expect(await receiptOf("resend_mail_domains", "domain_id", legacyId)).toEqual(receipt);
  expect(await dns.saveLegacy({ domainId: newUlid(), receipt })).toBeUndefined();

  const operationId = await seedProjectDeletion(f);
  const deletion = {
    organizationId: f.organizationId,
    projectId: f.projectId,
    operationId,
    domainId: legacyId,
  };
  const pending = (await dns.deletion(deletion)) as { domain: string; dns_receipts: string };
  expect(pending.domain).toContain("example.com");
  expect(JSON.parse(pending.dns_receipts)).toEqual(receipt);
  await expect(dns.deletion({ ...deletion, operationId: newUlid() })).rejects.toThrow(
    "Mail deletion unavailable",
  );
});

it("surfaces a lost reply of a committed receipt as an unknown outcome", async () => {
  const f = await cfFixture(control);
  const workspace = await seedWorkspaceDomain(f, { provisioned: true });
  const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
  const receipt = { zoneId: "2".repeat(32), records: [] };
  await expect(
    lossy.cfMailDns.saveWorkspace({
      organizationId: f.organizationId,
      mailDomainId: workspace.domainId,
      receipt,
    }),
  ).rejects.toThrow("store_outcome_unknown");
  expect(await receiptOf("workspace_mail_domains", "domain_id", workspace.domainId)).toEqual(
    receipt,
  );
});
