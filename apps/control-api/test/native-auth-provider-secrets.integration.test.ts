import { expect, it, vi } from "vitest";
import { createEnvironmentSecretCipherKeyring } from "@ohmyhost/platform";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createNativeAuthProviderSecretResolver } from "../src/native-auth-provider-secrets.js";
import { NativeAuthRuntime } from "../../control-store/src/worker-main.js";
import { NativeAuthProviderSecretService } from "../src/worker-main.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

it("decrypts only a live scoped provider and denies disabled, foreign or concurrently revoked authority", async () => {
  const control = await createTestControl();
  try {
    const plan = {
      ...sourceFrameworkPlan(false),
      auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
    };
    const fixture = await gatewayFixture(control, { frameworkPlan: plan });
    const { organizationId, projectId, environmentId } = fixture.scope;
    const scope = { organizationId, projectId, environmentId };
    const allowlistedBindings = {
      ...control.bindings,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: JSON.stringify({
        mode: "allowlist",
        projects: [{ organizationId, projectId }],
      }),
    };
    const store = createControlStore(allowlistedBindings);
    const cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: Buffer.alloc(32, 45).toString("base64"),
      currentKeyVersion: 1,
      crypto: globalThis.crypto,
    });
    const encrypted = await cipher.encrypt({
      ...scope,
      name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
      value: "private-provider-secret",
    });
    await expect(
      cipher.decrypt({
        ...scope,
        environmentId: newUlid(),
        name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
        ...encrypted,
      }),
    ).rejects.toThrow();
    const database = `d${newUlid().toLowerCase().slice(-19)}`,
      provider = `prj_${newUlid().toLowerCase().slice(-20)}`,
      operation = newUlid(),
      claim = newUlid(),
      schema = `omh_auth_${environmentId.toLowerCase()}`,
      role = `omh_ar_${environmentId.toLowerCase()}`;
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
        )
        .bind(organizationId, projectId, environmentId, `https://${fixture.hostname}`),
      control.core
        .prepare(
          "INSERT INTO credit_account(organization_id,monthly_micros,monthly_ends_at,paid_until,paid_source,updated_at) VALUES(?1,1000000000,'2999-01-01T00:00:00.000000Z','2999-01-01T00:00:00.000000Z','manual','2026-10-28T10:00:00.000000Z') ON CONFLICT(organization_id) DO UPDATE SET monthly_micros=1000000000,monthly_ends_at='2999-01-01T00:00:00.000000Z',paid_until='2999-01-01T00:00:00.000000Z',paid_source='manual'",
        )
        .bind(organizationId),
      control.core
        .prepare(
          "INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,'op_fixture','eu-dev','r256-s500m',1,'2026-10-28T09:20:00.000000Z','2026-10-28T09:00:00.000000Z')",
        )
        .bind(organizationId, projectId, provider, database),
      control.core
        .prepare(
          "INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu-dev','db.example',?8,?9,1,1,?10,'active')",
        )
        .bind(
          organizationId,
          projectId,
          environmentId,
          operation,
          claim,
          provider,
          database,
          schema,
          role,
          `${projectId}:${environmentId}`,
        ),
      control.core
        .prepare(
          "INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13)",
        )
        .bind(
          organizationId,
          projectId,
          environmentId,
          operation,
          claim,
          provider,
          database,
          schema,
          role,
          `omh_am_${environmentId.toLowerCase()}`,
          `omh_ab_${projectId.toLowerCase()}`,
          NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
          NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
        ),
      control.core
        .prepare(
          "INSERT INTO native_auth_providers(organization_id,project_id,environment_id,provider,enabled,client_id,ciphertext,nonce,value_sha256,key_version) VALUES(?1,?2,?3,'google',1,'client',?4,?5,?6,?7)",
        )
        .bind(
          organizationId,
          projectId,
          environmentId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.valueSha256,
          encrypted.keyVersion,
        ),
    ]);
    const authority = {
      resolve: (input: unknown) => store.identity.resolveNativeAuthAuthority(input),
      readNativeAuthProviderEnvelope: (input: unknown) =>
        store.identity.readNativeAuthProviderEnvelope(input),
    };
    const resolve = createNativeAuthProviderSecretResolver({ authority, cipher });
    const live = await fixture.store.identity.resolveNativeAuthAuthority({
      projectId,
      environmentId,
    });
    if (!live.deploymentId) throw new Error("Missing active fixture deployment");
    const request = {
      ...scope,
      deploymentId: live.deploymentId,
      provider: "google",
      configurationRevision: 1,
    };
    expect(
      await authority.resolve({ projectId, environmentId, deploymentId: live.deploymentId }),
    ).toMatchObject({
      enabled: true,
      sourceCapable: true,
      paidAllowed: true,
      runtimeAllowed: true,
      storageReady: true,
    });
    expect(await resolve(request)).toEqual({
      clientId: "client",
      clientSecret: "private-provider-secret",
      configurationRevision: 1,
    });
    const coreBinding = new NativeAuthRuntime({} as never, allowlistedBindings as never);
    const privateService = new NativeAuthProviderSecretService(
      {} as never,
      {
        NATIVE_AUTH_PROVIDER_RUNTIME: coreBinding,
        ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 45).toString("base64"),
        ENVIRONMENT_SECRET_KEY_VERSION: "1",
      } as never,
    );
    expect(await privateService.resolve(request)).toEqual({
      clientId: "client",
      clientSecret: "private-provider-secret",
      configurationRevision: 1,
    });
    await expect(resolve({ ...request, deploymentId: newUlid() })).rejects.toThrow(
      "native_auth_unavailable",
    );
    await expect(resolve({ ...request, organizationId: newUlid() })).rejects.toThrow(
      "native_auth_unavailable",
    );
    await expect(resolve({ ...request, provider: "github" })).rejects.toThrow(
      "native_auth_unavailable",
    );
    await expect(privateService.resolve({ ...request, organizationId: newUlid() })).rejects.toThrow(
      "native_auth_unavailable",
    );
    await control.core
      .prepare(
        "UPDATE native_auth_providers SET enabled=0 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(organizationId, projectId, environmentId)
      .run();
    await expect(resolve(request)).rejects.toThrow("native_auth_unavailable");
    await expect(privateService.resolve(request)).rejects.toThrow("native_auth_unavailable");
    await control.core
      .prepare(
        "UPDATE native_auth_providers SET enabled=1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(organizationId, projectId, environmentId)
      .run();
    const raceCipher = {
      ...cipher,
      async decrypt(input: Parameters<typeof cipher.decrypt>[0]) {
        const value = await cipher.decrypt(input);
        await control.core
          .prepare(
            "UPDATE native_auth_realms SET enabled=0 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
          )
          .bind(organizationId, projectId, environmentId)
          .run();
        return value;
      },
    };
    await expect(
      createNativeAuthProviderSecretResolver({ authority, cipher: raceCipher })(request),
    ).rejects.toThrow("native_auth_unavailable");
    await control.core
      .prepare(
        "UPDATE native_auth_realms SET enabled=1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(organizationId, projectId, environmentId)
      .run();
    const rotatingCipher = {
      ...cipher,
      async decrypt(input: Parameters<typeof cipher.decrypt>[0]) {
        const value = await cipher.decrypt(input);
        await control.core
          .prepare(
            "UPDATE native_auth_providers SET client_id='rotated' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
          )
          .bind(organizationId, projectId, environmentId)
          .run();
        return value;
      },
    };
    await expect(
      createNativeAuthProviderSecretResolver({ authority, cipher: rotatingCipher })(request),
    ).rejects.toThrow("native_auth_unavailable");
    const ownerRaceCipher = {
      ...cipher,
      async decrypt(input: Parameters<typeof cipher.decrypt>[0]) {
        const value = await cipher.decrypt(input);
        await control.core
          .prepare(
            "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(organizationId, projectId)
          .run();
        return value;
      },
    };
    await expect(
      createNativeAuthProviderSecretResolver({ authority, cipher: ownerRaceCipher })(request),
    ).rejects.toThrow("native_auth_unavailable");
  } finally {
    await control.dispose();
  }
}, 120000);
