import { WorkerEntrypoint } from "cloudflare:workers";
import { parseUlid } from "@ohmyhost/platform";
import {
  NeonManagementService as PgcfManagementService,
  type Bindings,
} from "./pgcf-worker-main.js";
import type { PgcfManagementDependencies } from "./pgcf-runtime.js";
import { readD1PgcfConfiguration } from "./d1-bindings.js";
import { createProductionPgcfProvider, pgcfManagementConnect } from "./provider-runtime.js";
import {
  createNativeAuthPlacementPersistence,
  createNativeAuthRegistrationPersistence,
  createNativeAuthRolePersistence,
  recordNativeAuthPreparation,
  type NativeAuthRegistryAuthority,
  type NativeAuthResourceRuntime,
} from "./native-auth-persistence.js";
import { placeNativeAuthDatabase } from "./native-auth-placement.js";
import { applyNativePreviewPolicyMigration } from "./native-preview-policy-migration.js";
import {
  deleteNativeAuthProject,
  type NativeDeletionCore,
  type NativeDeletionRuntime,
  type NativeDeletionRegistry,
} from "./native-auth-deletion.js";
import {
  ensureNativeAuthRealm,
  assertNativeAuthProviderRole,
  nativeAuthRoleNames,
  type NativeAuthRegistry,
} from "./native-auth-roles.js";
import {
  prepareNativeAuthRestore,
  type NativeRestorePreparationAuthority,
} from "./native-auth-restore-preparation.js";

export {
  default,
  createProductionD1DatabaseAccess,
  maintainProductionD1DatabaseProducts,
  NeonUsageService,
} from "./pgcf-worker-main.js";

/** Restore-only capability: SQL and credentials remain private to the database manager. */
export class NativeAuthRestorePreparationService extends WorkerEntrypoint<Bindings> {
  public async prepare(input: unknown) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new TypeError("Invalid Native restore scope");
    const bindings = readD1PgcfConfiguration(this.env),
      authority = bindings["NATIVE_AUTH_RESTORE_PREPARATION_RUNTIME"];
    if (typeof authority !== "object" || authority === null)
      throw new Error("Native restore authority unavailable");
    return prepareNativeAuthRestore({
      scope: input as Parameters<typeof prepareNativeAuthRestore>[0]["scope"],
      authority: authority as NativeRestorePreparationAuthority,
      provider: createProductionPgcfProvider(bindings),
      connect: pgcfManagementConnect(),
    });
  }
}

function nativeClaimInput(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "claimId,environmentId,operationId,organizationId,projectId"
  )
    throw new TypeError("Invalid Native Auth placement request");
  const value = input as Record<string, unknown>;
  return {
    organizationId: parseUlid(String(value["organizationId"])),
    projectId: parseUlid(String(value["projectId"])),
    environmentId: parseUlid(String(value["environmentId"])),
    operationId: parseUlid(String(value["operationId"])),
    claimId: parseUlid(String(value["claimId"])),
  };
}

export class NeonManagementService extends PgcfManagementService {
  readonly #managementConnect: PgcfManagementDependencies["connect"] | undefined;
  constructor(...args: ConstructorParameters<typeof PgcfManagementService>) {
    super(...args);
    this.#managementConnect = args[2];
  }
  /** Creates only the separately fenced Native target; realm readiness is a later operation. */
  public async placeNativeAuthDatabase(input: unknown) {
    return this.#placeNativeAuthDatabase(input, false);
  }

  /** Preview has its own source-bound Core claim and need not invent a deployed origin. */
  public async placePreviewNativeAuthDatabase(input: unknown) {
    const scope = nativeClaimInput(input),
      bindings = readD1PgcfConfiguration(this.env);
    const raw = bindings["PREVIEW_NATIVE_PREPARATION_RUNTIME"];
    if (!raw || typeof raw !== "object" || typeof Reflect.get(raw, "claim") !== "function")
      throw new Error("Preview Native authority unavailable");
    const claimed = await (raw as PreviewNativePreparationPort).claim({
      operationId: scope.operationId,
    });
    if (
      !claimed ||
      !["running", "uncertain"].includes(claimed.state) ||
      claimed.claimId !== scope.claimId ||
      claimed.organizationId !== scope.organizationId ||
      claimed.projectId !== scope.projectId ||
      claimed.environmentId !== scope.environmentId
    )
      throw new Error("Preview Native authority unavailable");
    const resource = bindings["NATIVE_AUTH_RESOURCE_RUNTIME"] as NativeAuthResourceRuntime;
    if (!resource || typeof resource.resolveNativeAuthDatabaseClaim !== "function")
      throw new Error("Preview Native authority unavailable");
    // A lost reply never authorizes replaying a provider mutation after the preview fence is revoked.
    await resource.resolveNativeAuthDatabaseClaim(scope);
    return this.#placeNativeAuthDatabase(scope, true);
  }

  async #placeNativeAuthDatabase(input: unknown, preview: boolean) {
    const claim = nativeClaimInput(input);
    const bindings = readD1PgcfConfiguration(this.env);
    const core = bindings["NATIVE_AUTH_RESOURCE_RUNTIME"];
    if (typeof core !== "object" || core === null)
      throw new Error("Native Auth resource binding unavailable");
    if (!(await (core as NativeAuthResourceRuntime).readNativeAuthDatabaseReconciliation(claim))) {
      const realm = await (core as NativeAuthResourceRuntime).initializeNativeAuthRealm(claim);
      if (!preview && (realm.status !== "ready" || realm.canonicalOrigin === null))
        return { status: "origin_pending" as const };
    }
    return placeNativeAuthDatabase(
      createProductionPgcfProvider(bindings),
      createNativeAuthPlacementPersistence(core as NativeAuthResourceRuntime),
      claim,
    );
  }

  /** Project deletion uses its own frozen project proof, not a Native deployment claim. */
  public async deleteNativeAuthProject(input: unknown) {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "operationId,organizationId,projectId"
    )
      throw new TypeError("Invalid Native Auth deletion request");
    const raw = input as Record<string, unknown>;
    const scope = {
      organizationId: parseUlid(String(raw["organizationId"])),
      projectId: parseUlid(String(raw["projectId"])),
      operationId: parseUlid(String(raw["operationId"])),
    };
    const bindings = readD1PgcfConfiguration(this.env),
      core = bindings["NATIVE_AUTH_DELETION_RUNTIME"];
    if (typeof core !== "object" || core === null)
      throw new Error("Native Auth deletion binding unavailable");
    const runtime = core as NativeDeletionRuntime;
    const deletionCore: NativeDeletionCore = {
      readNativeAuthProjectDeletion: (value) => runtime.read(value),
      recordNativeAuthDeletionQuiescence: (value) => runtime.recordQuiescence(value),
      beginNativeAuthProjectDeletion: (value) => runtime.begin(value),
      recordNativeAuthProjectDeletionObservation: (value) => runtime.recordObservation(value),
      recordNativeAuthDeletionPurge: (value) => runtime.recordPurge(value),
      finishNativeAuthProjectDeletion: (value) => runtime.finish(value),
    };
    return deleteNativeAuthProject({
      scope,
      core: deletionCore,
      provider: createProductionPgcfProvider(bindings),
      connect: this.#managementConnect ?? pgcfManagementConnect(),
      registry: (region) => {
        const value =
          bindings[region === "eu-dev" ? "NATIVE_AUTH_REGISTRY_EU" : "NATIVE_AUTH_REGISTRY_US"];
        if (typeof value !== "object" || value === null)
          throw new Error("Native Auth registry unavailable");
        return value as NativeDeletionRegistry;
      },
    });
  }

  /** Prepares and verifies a scoped realm, then privately registers its runtime credential. */
  public async prepareNativeAuthRealm(input: unknown) {
    const scope = nativeClaimInput(input),
      bindings = readD1PgcfConfiguration(this.env);
    const rawCore = bindings["NATIVE_AUTH_RESOURCE_RUNTIME"],
      rawAuthority = bindings["NATIVE_AUTH_REGISTRY_AUTHORITY"];
    if (
      typeof rawCore !== "object" ||
      rawCore === null ||
      typeof rawAuthority !== "object" ||
      rawAuthority === null
    )
      throw new Error("Native Auth authority unavailable");
    const core = rawCore as NativeAuthResourceRuntime,
      authority = rawAuthority as NativeAuthRegistryAuthority;
    const claim = await core.resolveNativeAuthDatabaseClaim(scope),
      target = await core.readNativeAuthTarget({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      });
    const provider = createProductionPgcfProvider(bindings);
    if (
      !target ||
      target.providerProjectId !== provider.projectId ||
      target.regionId !== claim.regionId ||
      target.sizeClassId !== "r256-s500m"
    )
      throw new Error("Native Auth target unavailable");
    const registry =
      bindings[claim.regionId === "eu-dev" ? "NATIVE_AUTH_REGISTRY_EU" : "NATIVE_AUTH_REGISTRY_US"];
    if (typeof registry !== "object" || registry === null)
      throw new Error("Native Auth registry unavailable");
    const names = nativeAuthRoleNames(scope.projectId, scope.environmentId);
    const environmentSet = await authority.readDatabaseEnvironments(scope);
    const existingRegistration = await authority.readRegistration({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    });
    const generation =
      existingRegistration === null
        ? await authority.resolveRegistrationGeneration({
            ...scope,
            providerProjectId: target.providerProjectId,
            databaseId: target.databaseId,
            regionId: claim.regionId,
            targetVersion: target.targetVersion,
          })
        : {
            registryVersion: existingRegistration.registryVersion,
            registryReference: existingRegistration.registryReference,
          };
    await core.resolveNativeAuthDatabaseClaim(scope);
    const ownerHandle = await provider.readConnection(target.databaseId, "app");
    const connect = this.#managementConnect ?? pgcfManagementConnect();
    const prepared = await ensureNativeAuthRealm({
      provider,
      environmentIds: environmentSet.environmentIds,
      existingRegistration,
      readExistingRegistration: () =>
        authority.readRegistration({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        }),
      persistence: createNativeAuthRolePersistence(core, claim, provider.projectId),
      registry: registry as NativeAuthRegistry,
      registrationPersistence: createNativeAuthRegistrationPersistence(authority),
      registration: {
        ...scope,
        providerProjectId: target.providerProjectId,
        databaseId: target.databaseId,
        regionId: claim.regionId,
        originHost: ownerHandle.host,
        schema: names.schema,
        role: names.runtime,
        targetVersion: target.targetVersion,
        ...generation,
      },
      authorize: async () => {
        await core.resolveNativeAuthDatabaseClaim(scope);
      },
      recordPreparation: async (proof) => {
        await recordNativeAuthPreparation(core, proof);
      },
      roles: {
        async withRole(role, work) {
          await core.resolveNativeAuthDatabaseClaim(scope);
          const handle = await provider.readConnection(target.databaseId, role);
          if (handle.host !== ownerHandle.host)
            throw new Error("Native Auth database origin changed");
          return handle.consume(async (uri) => {
            const connection = await connect(uri, {
              provider: "pgcf",
              host: handle.host,
              databaseId: target.databaseId,
              role,
            });
            try {
              return await work(connection.client);
            } finally {
              await connection.close();
            }
          });
        },
      },
    });
    if (prepared.status !== "ready") return prepared;
    const policy = await core.readProvisioningPolicy(scope);
    if (
      policy.organizationId !== scope.organizationId ||
      policy.region !== (claim.regionId === "eu-dev" ? "eu" : "us") ||
      policy.realm.projectId !== scope.projectId ||
      policy.realm.environmentId !== scope.environmentId
    )
      throw new Error("Native Auth policy unavailable");
    const admin =
      bindings[claim.regionId === "eu-dev" ? "NATIVE_AUTH_ADMIN_EU" : "NATIVE_AUTH_ADMIN_US"];
    if (
      typeof admin !== "object" ||
      admin === null ||
      typeof Reflect.get(admin, "applyRealmPolicy") !== "function"
    )
      throw new Error("Native Auth policy binding unavailable");
    const effect = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      configurationRevision: policy.realm.configurationRevision,
      revocationEpoch: policy.revocationEpoch,
      enabled: policy.ownerEnabled,
      canonicalOrigin: policy.realm.canonicalOrigin,
    };
    const applied = await (
      admin as { applyRealmPolicy(input: typeof effect): Promise<unknown> }
    ).applyRealmPolicy(effect);
    if (!applied || typeof applied !== "object" || Reflect.get(applied, "outcome") !== "applied")
      throw new Error("Native Auth policy unavailable");
    const after = await core.readProvisioningPolicy(scope);
    if (
      after.organizationId !== policy.organizationId ||
      after.region !== policy.region ||
      after.ownerEnabled !== policy.ownerEnabled ||
      after.revocationEpoch !== policy.revocationEpoch ||
      after.realm.configurationRevision !== policy.realm.configurationRevision ||
      after.realm.canonicalOrigin !== policy.realm.canonicalOrigin
    )
      throw new Error("Native Auth policy changed");
    return {
      ...prepared,
      policy: {
        configurationRevision: policy.realm.configurationRevision,
        revocationEpoch: policy.revocationEpoch,
        enabled: policy.ownerEnabled,
        canonicalOrigin: policy.realm.canonicalOrigin,
      },
    };
  }
}

interface PreviewNativePreparationClaim {
  readonly operationId: string;
  readonly claimId: string;
  readonly previewId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly runtimeGeneration: number;
  readonly tokenGeneration: number;
  readonly authGeneration: number;
  readonly state: "pending" | "running" | "uncertain" | "succeeded" | "failed";
  readonly errorCode: string | null;
}
interface PreviewNativePreparationPort {
  claim(input: { operationId: string }): Promise<PreviewNativePreparationClaim>;
  recordPolicy(input: {
    operationId: string;
    authGeneration: number;
    configurationRevision: number;
    revocationEpoch: number;
    registryVersion: number;
  }): Promise<void>;
  finish(input: {
    operationId: string;
    outcome: "succeeded" | "uncertain" | "failed";
    errorCode: string | null;
  }): Promise<PreviewNativePreparationClaim>;
}
/** Preview actor receives only this preparation method; provider credentials stay in this Worker. */
export class PreviewNativePreparationService extends WorkerEntrypoint<Bindings> {
  readonly #management: NeonManagementService;
  readonly #connect: PgcfManagementDependencies["connect"];
  constructor(
    context: unknown,
    environment: Bindings,
    connect?: PgcfManagementDependencies["connect"],
  ) {
    super(context, environment);
    this.#connect = connect ?? pgcfManagementConnect();
    this.#management = new NeonManagementService(context, environment, connect);
  }
  public async prepare(input: unknown) {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "operationId"
    )
      throw new TypeError("Invalid preview Native preparation");
    const operationId = parseUlid(String(Reflect.get(input, "operationId"))),
      bindings = readD1PgcfConfiguration(this.env),
      raw = bindings["PREVIEW_NATIVE_PREPARATION_RUNTIME"];
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof Reflect.get(raw, "claim") !== "function" ||
      typeof Reflect.get(raw, "finish") !== "function"
    )
      throw new Error("Preview Native authority unavailable");
    const core = raw as PreviewNativePreparationPort,
      claim = await core.claim({ operationId });
    if (claim.state === "succeeded" || claim.state === "failed") return claim;
    if (!["running", "uncertain"].includes(claim.state))
      throw new Error("Preview Native preparation unavailable");
    const scope = {
      organizationId: claim.organizationId,
      projectId: claim.projectId,
      environmentId: claim.environmentId,
      operationId: claim.operationId,
      claimId: claim.claimId,
    };
    try {
      const resource = bindings["NATIVE_AUTH_RESOURCE_RUNTIME"] as NativeAuthResourceRuntime;
      const registry = bindings["NATIVE_AUTH_REGISTRY_AUTHORITY"] as NativeAuthRegistryAuthority;
      if (
        !resource ||
        typeof resource.resolveNativeAuthDatabaseClaim !== "function" ||
        typeof resource.readNativeAuthPreviewReconciliation !== "function" ||
        !registry ||
        typeof registry.readRegistration !== "function"
      )
        throw new Error("Preview Native authority unavailable");
      // Observe only operation identities already retained by Core. This survives a new
      // source or revoked preview, without replaying a create or acquiring credentials.
      const reconciliation = await resource.readNativeAuthPreviewReconciliation(scope),
        provider = createProductionPgcfProvider(bindings);
      for (const role of reconciliation.roles) {
        if (role.providerOperationId === null) continue;
        if (role.providerProjectId !== provider.projectId)
          throw new Error("Preview Native reconciliation unavailable");
        const observed = await provider.readOperation(role.providerOperationId);
        if (
          observed.id !== role.providerOperationId ||
          observed.projectId !== role.providerProjectId ||
          observed.databaseId !== role.databaseId ||
          observed.kind !== "database.role.create"
        )
          throw new Error("Preview Native reconciliation unavailable");
        if (observed.status !== "succeeded" && observed.status !== "failed") continue;
        if (observed.status === "succeeded") {
          const actual = (await provider.readRoles(role.databaseId)).find(
            (entry) => entry.name === role.roleName,
          );
          if (!actual) continue;
          assertNativeAuthProviderRole(actual, role.databaseId, {
            name: role.roleName,
            connection_limit: 2,
            bypass_rls: false,
          });
        }
        await resource.recordNativeAuthRoleObservation({
          ...role,
          state: observed.status,
        });
      }
      const currentClaim = await resource.resolveNativeAuthDatabaseClaim(scope);
      let registration = await registry.readRegistration({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      });
      let configurationRevision: number, revocationEpoch: number;
      if (registration) {
        const target = await resource.readNativeAuthTarget({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        });
        if (
          !target ||
          registration.organizationId !== scope.organizationId ||
          registration.projectId !== scope.projectId ||
          registration.environmentId !== scope.environmentId ||
          registration.status !== "active" ||
          registration.databaseId !== target.databaseId ||
          registration.targetVersion !== target.targetVersion ||
          registration.regionId !== currentClaim.regionId
        )
          throw new Error("Preview Native registration unavailable");
        const existingPolicy = await resource.readProvisioningPolicy(scope);
        configurationRevision = existingPolicy.realm.configurationRevision;
        revocationEpoch = existingPolicy.revocationEpoch;
      } else {
        const placed = await this.#management.placePreviewNativeAuthDatabase(scope);
        if (placed.status === "reconciliation_required")
          return core.finish({
            operationId,
            outcome: "uncertain",
            errorCode: "NATIVE_PREPARE_RECONCILIATION_REQUIRED",
          });
        if (placed.status !== "ready")
          return core.finish({
            operationId,
            outcome: "failed",
            errorCode: "NATIVE_PREPARE_ORIGIN_UNAVAILABLE",
          });
        const prepared = await this.#management.prepareNativeAuthRealm(scope);
        if (prepared.status === "reconciliation_required")
          return core.finish({
            operationId,
            outcome: "uncertain",
            errorCode: "NATIVE_PREPARE_RECONCILIATION_REQUIRED",
          });
        if (prepared.status !== "ready" || prepared.registration.status !== "active")
          return core.finish({
            operationId,
            outcome: "failed",
            errorCode: "NATIVE_PREPARE_UNAVAILABLE",
          });
        registration = prepared.registration;
        configurationRevision = prepared.policy.configurationRevision;
        revocationEpoch = prepared.policy.revocationEpoch;
      }
      await resource.resolveNativeAuthDatabaseClaim(scope);
      const databaseId = registration.databaseId,
        names = nativeAuthRoleNames(scope.projectId, scope.environmentId),
        handle = await provider.readConnection(databaseId, names.migrator);
      await handle.consume(async (uri) => {
        const connection = await this.#connect(uri, {
          provider: "pgcf",
          host: handle.host,
          databaseId,
          role: names.migrator,
        });
        try {
          await applyNativePreviewPolicyMigration({
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            databaseId,
            client: connection.client,
          });
        } finally {
          await connection.close();
        }
      });
      const placement = await resource.resolveNativeAuthDatabaseClaim(scope);
      const refreshed = await core.claim({ operationId });
      if (
        !["running", "uncertain"].includes(refreshed.state) ||
        refreshed.claimId !== claim.claimId ||
        refreshed.previewId !== claim.previewId ||
        refreshed.tokenGeneration !== claim.tokenGeneration ||
        refreshed.authGeneration !== claim.authGeneration
      )
        throw new Error("Preview Native authority unavailable");
      const policyService =
        bindings[
          placement.regionId === "eu-dev" ? "NATIVE_PREVIEW_POLICY_EU" : "NATIVE_PREVIEW_POLICY_US"
        ];
      if (
        !policyService ||
        typeof policyService !== "object" ||
        typeof Reflect.get(policyService, "applyPreviewRealmPolicy") !== "function"
      )
        throw new Error("Preview Native policy unavailable");
      const policyInput = {
        fence: {
          previewId: claim.previewId,
          runtimeGeneration: refreshed.runtimeGeneration,
          tokenGeneration: refreshed.tokenGeneration,
        },
        authGeneration: claim.authGeneration,
        configurationRevision,
        revocationEpoch,
      };
      const applied = await (
        policyService as { applyPreviewRealmPolicy(input: typeof policyInput): Promise<unknown> }
      ).applyPreviewRealmPolicy(policyInput);
      if (!applied || typeof applied !== "object" || Reflect.get(applied, "outcome") !== "applied")
        throw new Error("Preview Native policy unavailable");
      await core.recordPolicy({
        operationId,
        authGeneration: claim.authGeneration,
        configurationRevision,
        revocationEpoch,
        registryVersion: registration.registryVersion,
      });
      return core.finish({ operationId, outcome: "succeeded", errorCode: null });
    } catch {
      try {
        return await core.finish({
          operationId,
          outcome: "failed",
          errorCode: "NATIVE_PREPARE_UNAVAILABLE",
        });
      } catch {
        return core.finish({
          operationId,
          outcome: "uncertain",
          errorCode: "NATIVE_PREPARE_RECONCILIATION_REQUIRED",
        });
      }
    }
  }
}
