import { webcrypto } from "node:crypto";
import {
  createRecoveryInputCipher,
  parseRecoveryCommand,
  parseUlid,
  projectSqlRoleName,
  SystemClock,
} from "@ohmyhost/platform";
import {
  PgcfProjectProvider,
  type PgcfProviderAuditEvent,
  type PgcfProviderOptions,
} from "@ohmyhost/provider-pgcf";

import { createRecoveryControlClient } from "./control-client.js";
import { CONTROL_TOKEN_PATTERN, type RecoveryControl } from "./control-wire.js";
import { createRecoveryRuntime } from "./recovery-runtime.js";
import { createRecoveryArchiveStore } from "./r2-archives.js";
import type { RecoveryDatabaseReader } from "./job.js";
import { runNativeRestoreJob, type NativeRestoreControl } from "./native-restore-job.js";

export type RecoveryNamespace = "poc-private-fullstack" | "production";

/** The container's whole configuration. There is no Control database URL, Neon key or Cloudflare admin key in it. */
export interface ContainerRecoveryConfiguration {
  readonly pgcf: Pick<PgcfProviderOptions, "baseUrl" | "projectId" | "apiKey">;
  /**
   * When the PGCF integrator key stops being usable. Optional for deployed configurations that predate it: without it
   * no expiry is checked and each run logs `pgcf_key_expiry_unset`. A run that uses the key refuses after this instant.
   */
  readonly pgcfKeyExpiresAt?: string;
  readonly r2AccountId: string;
  readonly r2AccessKeyId: string;
  readonly r2ApiToken: string;
  readonly inputKeyBase64: string;
}

const REQUIRED = ["r2AccountId", "r2AccessKeyId", "r2ApiToken", "inputKeyBase64"] as const;

/** Trusted configuration: exact object, no Control SQL target and no legacy provider authority. */
export function parseContainerRecoveryConfiguration(
  raw: unknown,
  namespace: RecoveryNamespace,
): ContainerRecoveryConfiguration {
  const invalid = (): never => {
    throw new Error("RECOVERY_CONFIGURATION_INVALID");
  };
  if (namespace !== "poc-private-fullstack" && namespace !== "production") return invalid();
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 16384) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => ![...REQUIRED, "pgcf", "pgcfKeyExpiresAt"].includes(key)) ||
    (config["pgcfKeyExpiresAt"] !== undefined && !isInstant(config["pgcfKeyExpiresAt"])) ||
    REQUIRED.some(
      (key) =>
        typeof config[key] !== "string" ||
        (config[key] as string).length < 1 ||
        (config[key] as string).length > 4096,
    )
  )
    return invalid();
  const key = Buffer.from(config["inputKeyBase64"] as string, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64") !== config["inputKeyBase64"] ||
    config["r2AccountId"] !== "00000000000000000000000000000001" ||
    !/^[a-f0-9]{32}$/u.test(config["r2AccessKeyId"] as string) ||
    (config["r2ApiToken"] as string).length < 20 ||
    /\s/u.test(config["r2ApiToken"] as string)
  )
    return invalid();
  const pgcf = config["pgcf"];
  if (
    pgcf === null ||
    typeof pgcf !== "object" ||
    Array.isArray(pgcf) ||
    Object.keys(pgcf).sort().join(",") !== "apiKey,baseUrl,projectId"
  )
    return invalid();
  try {
    new PgcfProjectProvider(pgcf as PgcfProviderOptions);
  } catch {
    return invalid();
  }
  return config as unknown as ContainerRecoveryConfiguration;
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** The backup role of one physical environment (the original `pgcfBackupRoleName`). */
function backupRole(physicalEnvironmentId: string): string {
  return `ohmyho_backup_${parseUlid(physicalEnvironmentId).toLowerCase()}`;
}

/** The wake budget of an export whose database waits for the entitlement resume (the capture keeps 90 s otherwise). */
export const ENTITLEMENT_WAKE_BUDGET_MILLISECONDS = 600_000;

export function createContainerRecoveryDatabaseReader(
  pgcf:
    | Pick<PgcfProjectProvider, "projectId" | "readDatabase" | "readRoles" | "readConnection">
    | undefined,
): RecoveryDatabaseReader {
  return {
    async read(reference, signal) {
      signal.throwIfAborted();
      if (!pgcf || reference.provider !== "pgcf" || reference.providerProjectId !== pgcf.projectId)
        throw new Error("RECOVERY_DATABASE_SCOPE_INVALID");
      if ("kind" in reference) {
        parseUlid(reference.projectId);
        if (reference.roleName !== `omh_ab_${reference.projectId.toLowerCase()}`)
          throw new Error("RECOVERY_DATABASE_SCOPE_INVALID");
      } else {
        parseUlid(reference.databaseEnvironmentId);
        if (
          reference.databaseName !== reference.databaseId ||
          reference.roleName !== backupRole(reference.databaseEnvironmentId)
        )
          throw new Error("RECOVERY_DATABASE_SCOPE_INVALID");
      }
      const database = await pgcf.readDatabase(reference.databaseId);
      if (
        database.projectId !== reference.providerProjectId ||
        database.id !== reference.databaseId ||
        database.regionId !== reference.regionId ||
        database.desiredState === "deleted"
      )
        throw new Error("RECOVERY_DATABASE_SCOPE_INVALID");
      const role = (await pgcf.readRoles(reference.databaseId)).find(
        (item) => item.name === reference.roleName,
      );
      if (
        !role ||
        role.owner ||
        role.connectionLimit !== 2 ||
        ("kind" in reference
          ? role.databaseId !== reference.databaseId ||
            role.validUntil !== null ||
            role.bypassRls ||
            role.memberOf.length !== 0
          : !role.bypassRls ||
            !role.membershipOptions.inherit ||
            role.membershipOptions.set ||
            role.memberOf.length !== 1 ||
            role.memberOf[0] !== projectSqlRoleName(reference.databaseEnvironmentId, "readonly"))
      )
        throw new Error("RECOVERY_DATABASE_SCOPE_INVALID");
      const handle = await pgcf.readConnection(reference.databaseId, reference.roleName);
      signal.throwIfAborted();
      // Only the entitlement reconciler suspends a database manually, and it resumes one for a queued export within a
      // minute. While that suspension stands, or its resume is not ready yet, PGCF refuses connections until then.
      const awaitingEntitlementResume =
        (database.desiredState === "suspended" && database.suspensionReason === "manual") ||
        (database.desiredState === "running" && database.observedState !== "ready");
      // Customer SQL stays real PGCF over the WSS transport and the local proxy of the capture.
      return handle.consume(async (connectionUrl) => ({
        connectionUrl,
        transport: {
          provider: "pgcf" as const,
          websocketUrl: `wss://${handle.host}/`,
          databaseId: reference.databaseId,
          role: reference.roleName,
        },
        ...(awaitingEntitlementResume
          ? { wakeBudgetMilliseconds: ENTITLEMENT_WAKE_BUDGET_MILLISECONDS }
          : {}),
      }));
    },
  };
}

/** Trusted Node code in one Container; claim, fence and every durable fact live in Control behind the mediated port. */
export function createContainerRecoveryRuntime(
  config: ContainerRecoveryConfiguration,
  namespace: RecoveryNamespace,
  controlToken: string | undefined,
  control?: RecoveryControl & Partial<NativeRestoreControl>,
) {
  return async (event: unknown) => {
    const command = parseRecoveryCommand(event);
    if (
      control === undefined &&
      (typeof controlToken !== "string" || !CONTROL_TOKEN_PATTERN.test(controlToken))
    )
      throw new Error("RECOVERY_CONFIGURATION_INVALID");
    const clock = new SystemClock();
    // Only the runs that reach PGCF with the integrator key are checked against its expiry; R2-only actions never do.
    const usesPgcf = command.action === "run" || command.action === "restore";
    if (config.pgcfKeyExpiresAt === undefined) {
      console.log(JSON.stringify({ event: "pgcf_key_expiry_unset", level: "warn" }));
    } else if (usesPgcf && clock.now().getTime() >= Date.parse(config.pgcfKeyExpiresAt)) {
      throw new Error("RECOVERY_PROVIDER_KEY_EXPIRED");
    }
    if (usesPgcf) {
      console.log(
        JSON.stringify({
          event: "database_provider_key_use",
          action: command.action,
          keyExpiresAt: config.pgcfKeyExpiresAt ?? null,
        }),
      );
    }
    const archives = createRecoveryArchiveStore({
      accountId: config.r2AccountId,
      bucket:
        namespace === "production" ? "ohmyho-production-backups" : "ohmyho-development-backups",
      accessKeyId: config.r2AccessKeyId,
      apiToken: config.r2ApiToken,
      now: clock.now.bind(clock),
    });
    try {
      const client = control ?? createRecoveryControlClient({ token: controlToken as string });
      const cipher = createRecoveryInputCipher({
        key: new Uint8Array(Buffer.from(config.inputKeyBase64, "base64")),
        keyVersion: 1,
        crypto: webcrypto as unknown as Crypto,
      });
      const provider = new PgcfProjectProvider({
        ...config.pgcf,
        fetch: globalThis.fetch,
        caller: "project-recovery-worker",
        audit: emitRecoveryProviderAudit,
      });
      const runtime = createRecoveryRuntime({
        control: client,
        archives,
        archiveDownloads: archives,
        clock,
        cipher,
        database: createContainerRecoveryDatabaseReader(provider),
        ...(command.action === "restore"
          ? {
              restore: () =>
                runNativeRestoreJob({
                  scope: {
                    organizationId: command.organizationId,
                    projectId: command.projectId,
                    restoreId: command.restoreId,
                  },
                  control: restoreControl(client),
                  archives,
                  provider,
                  cipher,
                  signal: AbortSignal.timeout(900000),
                }),
            }
          : {}),
      });
      return await runtime(command);
    } finally {
      archives.close();
    }
  };
}

function restoreControl(
  value: RecoveryControl & Partial<NativeRestoreControl>,
): NativeRestoreControl {
  const methods: readonly (keyof NativeRestoreControl)[] = [
    "readRestoreClaim",
    "readRestoreInput",
    "beginRestore",
    "reserveRestorePin",
    "recordRestorePin",
    "recordRestorePinAbsent",
    "assertRestoreImportAllowed",
    "isRestoreAcknowledged",
    "applyRestoreOffline",
    "acknowledgeRestore",
    "isRestoreRealmImported",
    "markRestoreRealmImported",
    "markRestoreImported",
    "revalidateRestore",
    "sanitizeRestore",
    "completeRestore",
  ];
  if (methods.some((method) => typeof value[method] !== "function"))
    throw new Error("recovery_restore_scope_unavailable");
  return value as RecoveryControl & NativeRestoreControl;
}

function emitRecoveryProviderAudit(event: PgcfProviderAuditEvent): void {
  console.log(JSON.stringify({ event: "database_provider_request", ...event }));
}
