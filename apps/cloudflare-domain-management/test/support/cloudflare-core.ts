import { createHash } from "node:crypto";
import { SystemClock, parseUlid } from "@ohmyhost/platform";
import { CloudflareDomainRuntime } from "../../../control-store/src/worker-main.js";
import { createControlStore } from "../../../control-store/src/store.js";
import { newUlid } from "../../../control-store/src/catalog/common.js";
import type { TestControl } from "../../../control-store/test/support/control-d1.js";
import {
  bytes,
  seedProject,
  STORED_NOW,
  type SeededProject,
} from "../../../control-store/test/support/platform-fixtures.js";
import {
  seedDeletionIntent,
  seedOperation,
} from "../../../control-store/test/support/accepted-operation.js";
import { createCloudflareDomainSecrets } from "../../src/secrets.js";

export const clock = new SystemClock(),
  secrets = createCloudflareDomainSecrets({
    keyBase64: Buffer.alloc(32, 0x42).toString("base64"),
    keyVersion: 1,
    crypto: globalThis.crypto,
  }),
  digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;

export const iso = (delta: number) => new Date(Date.now() + delta).toISOString();
const aad = (project: SeededProject, authorizationId: string, kind: "access" | "refresh") =>
  `ohmyhost.cloudflare-project-grant/v1:${project.organizationId}:${project.projectId}:${authorizationId}:${kind}`;

/**
 * A project whose deletion is running, with the platform domains the Core configured, the provider observations
 * recorded for them and (optionally) the customer's sealed OAuth grant.
 */
export async function deletingProject(
  control: TestControl,
  handle: string,
  options: {
    grant?: "fresh" | "stale";
    receipts?: boolean;
    customHostname?: boolean;
    beforeDeletion?: (project: SeededProject) => Promise<void>;
  } = {},
) {
  const project = await seedProject(control, { handle }),
    scope = { organizationId: project.organizationId, projectId: project.projectId },
    store = createControlStore(control.bindings),
    core = new CloudflareDomainRuntime({} as never, control.bindings as never),
    production = `${handle}.check.omh.st`,
    zoneId = "c".repeat(32);
  await store.domains.claimCloudflareProjectDomainsOperation({
    ...scope,
    platform: "production",
    proposedOperationId: newUlid(),
    principalId: "user:owner",
    idempotencyKeySha256: bytes(32, 1),
    requestSha256: bytes(32, 2),
    configuredAt: iso(0),
  });
  const receipt = (n: number, observedAt = iso(-n)) => ({
    ...scope,
    receiptId: newUlid(),
    observedAt,
    providerResourceId: n.toString(16).padStart(32, "0"),
  });
  if (options.receipts !== false) {
    await store.domains.putCloudflareProjectDomainReceipt({
      ...receipt(1),
      kind: "dns_record",
      zoneId,
      zoneName: "omh.st",
      type: "CNAME",
      name: production,
      content: "check.omh.st",
      ttl: 300,
      proxied: false,
      comment: `ohmyhost:${project.projectId}:web:v1`,
    });
    await store.domains.putCloudflareProjectDomainReceipt({
      ...receipt(2),
      kind: "worker_route",
      environmentName: "prod",
      zoneId,
      pattern: `${production}/*`,
      script: "ohmyho-gateway-production",
    });
  }
  if (options.customHostname)
    await store.domains.putCloudflareProjectDomainReceipt({
      ...receipt(3),
      kind: "custom_hostname",
      environmentName: "prod",
      hostname: production,
      status: "active",
      providerCreatedAt: iso(-10),
      ownershipVerification: { type: "txt", name: `_cf.${production}`, value: "token" },
      ownershipVerificationHttp: { httpUrl: `https://${production}/.well-known/x`, httpBody: "b" },
      verificationErrors: [],
    });
  let authorizationId = "";
  if (options.grant !== undefined) {
    authorizationId = newUlid();
    const state = Uint8Array.from(createHash("sha256").update(authorizationId).digest());
    await control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,?6,NULL,'awaiting_deployment','user:owner',?3,?4,?5,?5,NULL)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        bytes(32, 3),
        bytes(32, 4),
        STORED_NOW,
        `${handle}.example.test`,
      )
      .run();
    await core.claimAuthorization({
      ...scope,
      authorizationId,
      principalId: "user:owner",
      zoneName: "example.test",
      idempotencyKeySha256: digest(`grant:${handle}`),
      requestSha256: digest(`grant request:${handle}`),
      stateSha256: state,
      issuedAt: iso(-60_000),
      expiresAt: iso(540_000),
    });
    await core.consumeAuthorization({
      authorizationId,
      stateSha256: state,
      principalId: "user:owner",
      consumedAt: iso(-50_000),
    });
    const access = await secrets.tokenCipher.seal(
        "fixture-access-token-1",
        aad(project, authorizationId, "access"),
      ),
      refresh = await secrets.tokenCipher.seal(
        "fixture-refresh-token-1",
        aad(project, authorizationId, "refresh"),
      );
    await core.putGrant({
      ...scope,
      authorizationId,
      principalId: "user:owner",
      zoneName: "example.test",
      zoneId: "a".repeat(32),
      accountId: "b".repeat(32),
      scopes: ["dns.write", "zone.read"],
      accessCiphertext: access.ciphertext,
      accessNonce: access.nonce,
      refreshCiphertext: refresh.ciphertext,
      refreshNonce: refresh.nonce,
      keyVersion: access.keyVersion,
      accessExpiresAt: iso(options.grant === "fresh" ? 3_600_000 : -3_600_000),
      connectedAt: iso(-40_000),
    });
  }
  await options.beforeDeletion?.(project);
  const operationId = await seedOperation(project);
  await seedDeletionIntent(project, project.prodEnvironmentId, operationId);
  await control.core
    .prepare(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(scope.organizationId, scope.projectId)
    .run();
  return {
    project,
    request: {
      organizationId: parseUlid(scope.organizationId),
      projectId: parseUlid(scope.projectId),
      operationId: parseUlid(operationId),
    },
    authorizationId,
    production,
    handle,
  };
}
