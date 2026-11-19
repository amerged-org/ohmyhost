import { expect, it, vi } from "vitest";
import { assertW25ClientConsentPack } from "./helpers/w25-client-consent.js";
import { assertW25ApiContractPack } from "./helpers/w25-api-contract.js";
import { assertScopedIdentityPack } from "../../cloudflare-domain-management/test/scoped-identity-pack.js";
import { assertSharedMailResponse } from "../../../packages/sdk-ts/src/shared-mail-response.js";
import { createControlApi } from "../src/app.js";
import { sharedMailError } from "../src/shared-mail.js";
import {
  API,
  JSON_BEARER,
  ORGANIZATION_ID,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

it("W25 preserves exact scoped mail and application-identity contracts", async () => {
  await assertW25ApiContractPack();
  await assertW25ClientConsentPack();
  await assertScopedIdentityPack();
  const scope = {
    organizationId: "01H00000000000000000000601",
    mailDomainId: "01H00000000000000000000602",
  };
  const value = {
    domain_id: scope.mailDomainId,
    organization_id: scope.organizationId,
    domain: "mail.example.com",
    registrable_domain: "example.com",
    revision: 1,
    status: "active",
    sending: "ready",
    receiving: "disabled",
    configured_at: "2026-10-21T00:00:00.000Z",
    observed_at: null,
    dns_records: [],
    bindings_count: 1,
  };
  expect(() => assertSharedMailResponse(value, { ...scope, action: "domain_get" })).not.toThrow();
  for (const changed of [
    { ...value, provider_key: "must never escape" },
    { ...value, organization_id: "01H00000000000000000000603" },
    { ...value, domain_id: "01H00000000000000000000603" },
    { ...value, bindings_count: -1 },
  ])
    expect(() => assertSharedMailResponse(changed, { ...scope, action: "domain_get" })).toThrow();
}, 120_000);

it("refuses a shared-mail Idempotency-Key the Core cannot store as a 400 before the port, never a retryable 503", async () => {
  const createWorkspaceMailDomain = vi.fn(async () => ({ ensured: true }));
  const app = createControlApi(
    routeDependencies({ sharedMail: { createWorkspaceMailDomain } as never }),
  );
  const response = await app.request(`${API}/v1/organizations/${ORGANIZATION_ID}/mail-domains`, {
    method: "POST",
    headers: { ...JSON_BEARER, "Idempotency-Key": "create mail domain acme" },
    body: JSON.stringify({ domain: "mail.example.com", sending: true }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_request", retryable: false });
  expect(createWorkspaceMailDomain).not.toHaveBeenCalled();
  // A refusal the Core makes for an input it rejects is the caller's error, not an outage.
  expect(sharedMailError(new TypeError("Invalid mail input")).status).toBe(400);
});
