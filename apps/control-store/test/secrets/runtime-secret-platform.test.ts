import { createControlStore } from "../../src/store.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";
import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createD1RuntimeSecretPersistence } from "../../../runtime-secret-delivery/src/d1-persistence.js";
import { createTestControl, coreRouter } from "../support/control-d1.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { claimDelivery } from "../../src/catalog/runtime-secrets/claim.js";

it("persists all six platform secret compounds exactly and rolls the final storage write back with secret/generation", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const scope = {
      organizationId: parseUlid(r.scope.organizationId),
      projectId: parseUlid(r.scope.projectId),
      environmentId: parseUlid(r.scope.environmentId),
    };
    const ctx = { directory: control.core, router: coreRouter(control) },
      d1 = createD1RuntimeSecretPersistence(r.store.runtimeSecrets),
      at = new Date().toISOString();
    const claim = {
      ...scope,
      operationId: parseUlid(r.accepted.operationId),
      leaseId: parseUlid(newUlid()),
      runtimeProvider: "wfp" as const,
      trigger: "deploy" as const,
      claimedAt: new Date(Date.now() - 60000).toISOString(),
      leaseMilliseconds: 120000,
    };
    await claimDelivery(ctx, claim);
    const sealed = {
      ...scope,
      operationId: claim.operationId,
      claimId: parseUlid(r.accepted.claimId),
      ciphertext: new Uint8Array(24).fill(4),
      nonce: new Uint8Array(12).fill(5),
      valueSha256: new Uint8Array(32).fill(6),
      keyVersion: 1,
      writtenAt: at,
    };
    const database = { ...sealed, name: "DATABASE_URL" as const };
    const stored = (name: string, revision: number, keyVersion = 1) => ({
      name,
      revision,
      keyVersion,
      createdAt: at,
      updatedAt: at,
    });
    // A changed digest replaces the secret and bumps its revision; the creation instant stays.
    expect(await d1.installPlatform(database)).toEqual(stored("DATABASE_URL", 1));
    const changed = { ...database, valueSha256: new Uint8Array(32).fill(7) };
    expect(await d1.installPlatform(changed)).toEqual(stored("DATABASE_URL", 2));
    const auth = { ...sealed, name: "BETTER_AUTH_SECRET" as const };
    expect(await d1.ensurePlatform(auth)).toEqual(stored("BETTER_AUTH_SECRET", 1));
    const authRepeat = {
      ...auth,
      ciphertext: new Uint8Array(24).fill(8),
      valueSha256: new Uint8Array(32).fill(9),
      keyVersion: 2,
    };
    // Ensure never overwrites: a second ensure with new material and key version reports the stored one.
    expect(await d1.ensurePlatform(authRepeat)).toEqual(stored("BETTER_AUTH_SECRET", 1));
    const storage = {
      ...sealed,
      name: "OHMYHOST_STORAGE_KEY" as const,
      valueSha256: new Uint8Array(32).fill(10),
    };
    await expect(d1.ensureStorageGateway(storage)).rejects.toThrow();
    const count = () =>
      control.core
        .prepare(
          "SELECT count(*) n FROM environment_secrets WHERE organization_id=? AND name='OHMYHOST_STORAGE_KEY'",
        )
        .bind(scope.organizationId)
        .first();
    expect(await count()).toEqual({ n: 0 });
    const insertRow = async (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      await control.core
        .prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
        .bind(
          ...Object.values(row).map((v) =>
            typeof v === "boolean"
              ? v
                ? 1
                : 0
              : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(v)
                ? storedTimestamp(v)
                : v,
          ),
        )
        .run();
    };
    await insertRow("project_r2_bucket_receipts", {
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      environment_id: scope.environmentId,
      operation_id: claim.operationId,
      claim_id: r.accepted.claimId,
      bucket_name: `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
      provider_bucket_id: "f".repeat(32),
      jurisdiction: "us",
      storage_class: "Standard",
      public_access: false,
      observed_at: at,
      created_at: at,
    });
    await control.core
      .prepare(
        "CREATE TRIGGER test_fail_storage_key BEFORE INSERT ON storage_gateway_keys BEGIN SELECT RAISE(ABORT,'test final storage failure'); END",
      )
      .run();
    const before = await control.core
      .prepare(
        "SELECT desired_generation FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
      )
      .bind(scope.organizationId, scope.environmentId)
      .first();
    await expect(d1.ensureStorageGateway(storage)).rejects.toThrow("test final storage failure");
    expect(await count()).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare(
          "SELECT desired_generation FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
        )
        .bind(scope.organizationId, scope.environmentId)
        .first(),
    ).toEqual(before);
    await control.core.prepare("DROP TRIGGER test_fail_storage_key").run();
    // The first write commits but its reply is lost: the caller still gets the stored secret, and a repeat agrees.
    expect(
      await createD1RuntimeSecretPersistence(
        createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }).runtimeSecrets,
      ).ensureStorageGateway(storage),
    ).toEqual(stored("OHMYHOST_STORAGE_KEY", 1));
    expect(await d1.ensureStorageGateway(storage)).toEqual(stored("OHMYHOST_STORAGE_KEY", 1));
    const mail = {
      ...sealed,
      name: "OHMYHOST_MAIL_KEY" as const,
      valueSha256: new Uint8Array(32).fill(11),
    };
    await expect(d1.ensureMailGateway(mail)).rejects.toThrow();
    const domain = String(newUlid());
    await insertRow("workspace_mail_domains", {
      organization_id: scope.organizationId,
      domain_id: domain,
      domain: "mail.example.test",
      registrable_domain: "example.test",
      custody_organization_id: scope.organizationId,
      custody_project_id: scope.projectId,
      custody_environment_id: scope.environmentId,
      status: "active",
      sending_status: "ready",
      configured_at: at,
    });
    await insertRow("project_mail_domain_bindings", {
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      environment_id: scope.environmentId,
      mail_domain_id: domain,
      revision: 1,
      state: "active",
      sending: true,
      legacy: true,
      sender_addresses: "[]",
      configured_at: at,
      updated_at: at,
    });
    expect(await d1.ensureMailGateway(mail)).toEqual(stored("OHMYHOST_MAIL_KEY", 1));
    expect(await d1.ensureMailGateway(mail)).toEqual(stored("OHMYHOST_MAIL_KEY", 1));
    expect(
      await control.core
        .prepare(
          "SELECT key_version,lower(hex(key_sha256)) hash FROM storage_gateway_keys WHERE organization_id=?",
        )
        .bind(scope.organizationId)
        .first(),
    ).toEqual({ key_version: 1, hash: "0a".repeat(32) });
    expect(
      (
        await control.core
          .prepare("SELECT state,version FROM mail_reputation_states WHERE organization_id=?")
          .bind(scope.organizationId)
          .all()
      ).results,
    ).toEqual([{ state: "active", version: 1 }]);
    const ai = {
      ...sealed,
      name: "OHMYHOST_AI_KEY" as const,
      valueSha256: new Uint8Array(32).fill(12),
    };
    expect(await r.store.runtimeSecrets.ensureAiGateway(ai)).toEqual(stored("OHMYHOST_AI_KEY", 1));
    // Ensure never overwrites: new material, digest and key version report the stored AI key.
    expect(
      await r.store.runtimeSecrets.ensureAiGateway({
        ...ai,
        ciphertext: new Uint8Array(24).fill(13),
        valueSha256: new Uint8Array(32).fill(14),
        keyVersion: 2,
      }),
    ).toEqual(stored("OHMYHOST_AI_KEY", 1));
    await expect(
      r.store.runtimeSecrets.ensureAiGateway({ ...ai, name: "OHMYHOST_MAIL_KEY" as const }),
    ).rejects.toHaveProperty("name", "RuntimeSecretDeliveryInputError");
    await expect(
      r.store.runtimeSecrets.ensureAiGateway({ ...ai, claimId: parseUlid(newUlid()) }),
    ).rejects.toHaveProperty("name", "RuntimeSecretDeliveryScopeError");
    expect(
      await control.core
        .prepare(
          "SELECT lower(hex(value_sha256)) hash FROM environment_secrets WHERE organization_id=? AND name='OHMYHOST_AI_KEY'",
        )
        .bind(scope.organizationId)
        .first(),
    ).toEqual({ hash: "0c".repeat(32) });
    const browser = {
      ...sealed,
      name: "OHMYHOST_BROWSER_KEY" as const,
      valueSha256: new Uint8Array(32).fill(15),
    };
    expect(await r.store.runtimeSecrets.ensureBrowserGateway(browser)).toEqual(
      stored("OHMYHOST_BROWSER_KEY", 1),
    );
    expect(
      await r.store.runtimeSecrets.ensureBrowserGateway({
        ...browser,
        ciphertext: new Uint8Array(24).fill(16),
        valueSha256: new Uint8Array(32).fill(17),
        keyVersion: 2,
      }),
    ).toEqual(stored("OHMYHOST_BROWSER_KEY", 1));
    await expect(
      r.store.runtimeSecrets.ensureBrowserGateway({ ...browser, claimId: parseUlid(newUlid()) }),
    ).rejects.toHaveProperty("name", "RuntimeSecretDeliveryScopeError");
    expect(
      await control.core
        .prepare(
          "SELECT lower(hex(value_sha256)) hash FROM environment_secrets WHERE organization_id=? AND name='OHMYHOST_BROWSER_KEY'",
        )
        .bind(scope.organizationId)
        .first(),
    ).toEqual({ hash: "0f".repeat(32) });
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 240000);
