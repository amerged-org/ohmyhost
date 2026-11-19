import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { createD1ResendIngressPersistence } from "../src/d1-resend-persistence.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120000);
afterAll(async () => control?.dispose());

const now = "2026-10-29T00:00:00.000Z";
const event = (eventId: string, type: string, data: Record<string, unknown>, fill = 0x47) => ({
  eventId,
  type,
  createdAt: now,
  data,
  now,
  digest: new Uint8Array(32).fill(fill),
  nextMessageId: () => newUlid(),
});

it("ingests a signed domain fact once through the real mail ingress and refuses a replay under another identity", async () => {
  const store = createControlStore(control.bindings),
    project = await seedProject(control),
    domainId = newUlid(),
    providerDomainId = `dom_${domainId.toLowerCase()}`,
    domain = `d-${domainId.slice(-10).toLowerCase()}.example.com`,
    writes: unknown[] = [],
    persistence = createD1ResendIngressPersistence({
      readReceipt: (input: unknown) => store.mailIngress.readReceipt(input),
      ingest: (input: unknown) => {
        writes.push(input);
        return store.mailIngress.ingest(input);
      },
    });
  await control.core
    .prepare(
      "INSERT INTO resend_mail_domains(domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,sending,receiving,configured_at)VALUES(?1,?2,?3,?4,?5,?6,1,0,'2026-10-28T10:00:00.000000Z')",
    )
    .bind(
      domainId,
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      domain,
      providerDomainId,
    )
    .run();
  const verified = event("evt_domain_verified", "domain.updated", {
    id: providerDomainId,
    name: domain,
    status: "verified",
    capabilities: { sending: "enabled", receiving: "disabled" },
    records: [
      { record: "DKIM", status: "verified" },
      { record: "SPF", status: "verified" },
    ],
  });

  // A foreign fact is acknowledged but leaves no receipt, so it may be offered again.
  const foreign = event("evt_foreign", "domain.deleted", {
    id: "dom_unknown",
    name: "other.example",
  });
  expect(await persistence.ingest(foreign)).toBeUndefined();
  expect(await store.mailIngress.readReceipt({ eventId: "evt_foreign" })).toBeNull();

  expect(await persistence.ingest(verified)).toBeUndefined();
  expect(
    await control.core
      .prepare("SELECT sending_status FROM resend_mail_domains WHERE domain_id=?")
      .bind(domainId)
      .first(),
  ).toEqual({ sending_status: "ready" });
  expect(await store.mailIngress.readReceipt({ eventId: "evt_domain_verified" })).toEqual({
    eventId: "evt_domain_verified",
    digest: "47".repeat(32),
  });

  // The receipt answers the replay before any second write; another payload under the same event id conflicts.
  const written = writes.length;
  expect(await persistence.ingest(verified)).toBeUndefined();
  expect(writes).toHaveLength(written);
  await expect(
    persistence.ingest(event("evt_domain_verified", "domain.updated", verified.data, 0x48)),
  ).rejects.toThrow("Resend event identity conflict");
});

it("requires the two private commands and refuses answers that are not the closed receipt shape", async () => {
  expect(() => createD1ResendIngressPersistence(null)).toThrow("mail_resend_core_binding_required");
  expect(() => createD1ResendIngressPersistence({ readReceipt: async () => null })).toThrow(
    "mail_resend_core_binding_required",
  );
  const probe = (readReceipt: () => unknown, ingest: () => unknown = () => undefined) =>
    createD1ResendIngressPersistence({
      readReceipt: async () => readReceipt(),
      ingest: async () => ingest(),
    }).ingest(event("evt_probe", "email.delivered", {}));
  const digest = "a".repeat(64);
  await expect(probe(() => [])).rejects.toThrow("mail_resend_core_response_invalid");
  await expect(probe(() => ({ eventId: "evt_probe" }))).rejects.toThrow(
    "mail_resend_core_response_invalid",
  );
  await expect(probe(() => ({ eventId: "evt_probe", digest: "short" }))).rejects.toThrow(
    "mail_resend_core_response_invalid",
  );
  await expect(probe(() => ({ eventId: 1, digest }))).rejects.toThrow(
    "mail_resend_core_response_invalid",
  );
  await expect(probe(() => ({ eventId: "evt_other", digest }))).rejects.toThrow(
    "mail_resend_core_response_invalid",
  );
  await expect(
    probe(
      () => null,
      () => "accepted",
    ),
  ).rejects.toThrow("mail_resend_core_response_invalid");
});
