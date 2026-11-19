import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRecoveryInputCipher,
  parseRecoveryJobInput,
  parseUlid,
  type Clock,
  type RecoveryJobInput,
} from "@ohmyhost/platform";
import {
  captureProjectRecoveryArchive,
  captureProjectRecoveryArchiveV2,
  type RecoveryDatabaseConnection,
} from "@ohmyhost/project-recovery/capture";
import {
  RecoveryArchiveError,
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  type RecoveryScope,
  type RecoveryScopeV2,
  type RecoveryResource,
} from "@ohmyhost/project-recovery";
import {
  RecoveryControlError,
  type RecoveryControl,
  type WireArchive,
  type WireDatabaseReference,
  type WireFence,
  type WireNativeAuthDatabase,
} from "./control-wire.js";

/** The capture use case consumes portable database references. The production wire and container composition still
 * admit PGCF ONLY; this legacy reference is used by the honest PostgreSQL comparison adapter in tests. */
export type RecoveryDatabaseReference =
  | WireDatabaseReference
  | WireNativeAuthDatabase
  | {
      readonly provider?: "neon";
      readonly providerProjectId: string;
      readonly branchId: string;
      readonly regionId: string;
      readonly postgresVersion: number;
      readonly databaseName: "neondb";
      readonly roleName: "neondb_owner";
      readonly databaseEnvironmentId: string;
    };
export interface RecoveryInventory {
  readonly dataMode: "shared" | "isolated";
  readonly environments: readonly {
    readonly environmentId: string;
    readonly name: "dev" | "prod";
    readonly databaseEnvironmentId: string;
    readonly database: RecoveryDatabaseReference | null;
  }[];
  readonly nativeAuthDatabase?: WireNativeAuthDatabase;
}
/** The use case's narrow in-process port. No SQL method, connection or transport/provider client belongs here. */
export interface RecoveryJobControl
  extends Omit<RecoveryControl, "readInventory" | "readCleanupTarget"> {
  readInventory(): Promise<RecoveryInventory | null>;
  readCleanupTarget?: RecoveryControl["readCleanupTarget"];
}
export type ProjectRecoveryArchiveInput = WireArchive;
export interface RecoveryDatabaseReader {
  read(
    reference: RecoveryDatabaseReference,
    signal: AbortSignal,
  ): Promise<string | RecoveryDatabaseConnection>;
}
export interface RecoveryArchiveStore {
  put(input: {
    bucket: string;
    key: string;
    path: string;
    archive: ProjectRecoveryArchiveInput;
    signal: AbortSignal;
  }): Promise<void>;
  verify(input: {
    bucket: string;
    key: string;
    archive: ProjectRecoveryArchiveInput;
    signal: AbortSignal;
  }): Promise<"verified" | "absent" | "different">;
}
export interface RecoveryJobCommand {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly claimId: string;
}
export interface RecoveryFenceSettings {
  readonly leaseMilliseconds: number;
  readonly renewEveryMilliseconds: number;
  /** The original capture bound (`withProjectRecoveryFence`): 600000 ms for the whole fenced body. */
  readonly captureTimeoutMilliseconds?: number;
}
export interface RecoveryJobDependencies {
  /** The only Control access: the closed Worker-mediated port, already bound to this job's scope by its token. */
  readonly control: RecoveryJobControl;
  readonly cipher: ReturnType<typeof createRecoveryInputCipher>;
  readonly database: RecoveryDatabaseReader;
  readonly archives: RecoveryArchiveStore;
  readonly clock: Clock;
  /** One fresh holder id per invocation; a repeat of the same call is a replay, never a second holder. */
  readonly holderIds?: { next(): string };
  readonly fence?: RecoveryFenceSettings;
}

const DEFAULT_FENCE = {
  leaseMilliseconds: 5 * 60_000,
  renewEveryMilliseconds: 60_000,
  captureTimeoutMilliseconds: 600_000,
} as const;
type Status = "absent" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
const WATCHDOG_POLL_MILLISECONDS = 1_000;

/**
 * Trusted Node execution only. Provider authority is supplied by the fixed platform composition.
 *
 * The PostgreSQL session advisory lock is replaced by a durable lease with an epoch: acquire, renew while capturing,
 * and every write that depends on being the holder carries the (epoch, holder). Losing the lease aborts the capture
 * and the invocation ends without writing: a stale holder never finishes a newer lease, and a crashed Node lets the
 * lease lapse so a later dispatch of the same original job takes over at the next epoch.
 *
 * The original order is kept: the job is claimed once to learn whether it can run at all, the fence is taken, and the
 * job is claimed AGAIN inside the fence, because the fence acquisition can take long enough for the sealed input to
 * expire. The fenced body is bounded by the original 600000 ms and by the independent lease watchdog.
 */
export function createRecoveryJobRunner(dependencies: RecoveryJobDependencies) {
  const settings = { ...DEFAULT_FENCE, ...dependencies.fence };
  const holderIds = dependencies.holderIds ?? { next: () => randomUUID() };
  return Object.freeze({
    async run(raw: RecoveryJobCommand): Promise<{ status: Status }> {
      const command = parseCommand(raw);
      const control = dependencies.control;
      const claim = await control.claim();
      if (claim.status === "absent") return { status: "absent" };
      if (claim.status !== "claimed") return { status: claim.status };
      // The store ends a denied claim in the same batch; a denial that is still reported is ended the same way.
      if (claim.denialCode !== null) return failWithoutFence(control, claim.denialCode);

      const holderId = holderIds.next();
      let lease;
      const acquireSentAt = dependencies.clock.now().getTime();
      try {
        lease = await control.acquireFence({
          holderId,
          leaseMilliseconds: settings.leaseMilliseconds,
        });
      } catch (error) {
        return afterAcquireFailure(control, error);
      }
      const fence: WireFence = { epoch: lease.epoch, holderId: lease.holderId };
      const abort = new AbortController();
      const renewal = keepLeaseAlive(
        control,
        fence,
        settings,
        dependencies.clock,
        abort,
        lease,
        acquireSentAt,
      );
      // Original `withProjectRecoveryFence`: any(timeout 600000 ms, connection lost) -- here: any(timeout, lease lost).
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(settings.captureTimeoutMilliseconds),
      ]);
      let finished = false;
      try {
        const claimed = await control.claim({ holderId, epoch: fence.epoch });
        if (claimed.status === "absent") return { status: "absent" };
        if (claimed.status !== "claimed") {
          // `failed` is a denied claim that released this fence in its own batch.
          finished = claimed.status === "failed";
          return { status: claimed.status };
        }
        if (claimed.denialCode !== null) {
          const result = await control.finish({ failureCode: claimed.denialCode, fence });
          finished = result.outcome !== "waiting";
          return { status: result.outcome === "waiting" ? "running" : result.status };
        }
        const target = { bucket: claimed.archiveBucket, key: claimed.archiveKey, signal };
        if (claimed.preparedArchive !== null) {
          const archive = claimed.preparedArchive;
          const replayTarget =
            archive.nativeManifest === undefined
              ? target
              : {
                  ...target,
                  key: `native-exports/${command.organizationId}/${command.projectId}/${command.operationId}.zip`,
                };
          const status = await readback(dependencies.archives, { ...replayTarget, archive });
          if (status === "verified") {
            await finishSuccess(control, archive, fence, signal);
            finished = true;
            return { status: "succeeded" };
          }
          if (archive.nativeManifest !== undefined)
            throw new ArchiveReadbackUncertainError("recovery_storage_unavailable");
          // The recorded receipt never landed (its upload died with the earlier container): it is cleared, and the
          // archive is captured again from the sealed input. Without that input nothing can be recaptured.
          if (claimed.sealedInput === null) throw new ArchiveLostError("recovery_archive_lost");
          await control.discardArchive({ archive, fence });
        }
        if (claimed.sealedInput === null) throw new RecoveryArchiveError("recovery_input_invalid");
        const plaintext = await dependencies.cipher.open(command, claimed.sealedInput);
        let input: RecoveryJobInput;
        try {
          input = parseRecoveryJobInput(plaintext);
        } finally {
          plaintext.fill(0);
        }
        const initial = await control.readInventory();
        if (initial === null) throw new RecoveryArchiveError("recovery_scope_mismatch");
        const environments = environmentIds(initial);
        if (initial.nativeAuthDatabase) {
          if (!control.authorizeNativeCapture)
            throw new ArchiveReadbackUncertainError("recovery_control_unavailable");
          await control.authorizeNativeCapture({ fence });
        }
        const physical = physicalDatabases(initial);
        const databases = [];
        for (const [environmentId, reference] of physical) {
          signal.throwIfAborted();
          const connection = await dependencies.database.read(reference, signal);
          databases.push({
            environmentId,
            ...(typeof connection === "string" ? { connectionUrl: connection } : connection),
          });
        }
        if (
          initial.nativeAuthDatabase &&
          initial.nativeAuthDatabase.projectId !== command.projectId
        )
          throw new RecoveryArchiveError("recovery_scope_mismatch");
        const scope: RecoveryScope = {
          organizationId: command.organizationId,
          projectId: command.projectId,
          backupId: command.operationId,
          dataMode: initial.dataMode,
          databaseEnvironments: [...physical.keys()].sort(),
          environments,
        };
        const directory = await mkdtemp(join(tmpdir(), "omh-recovery-job-"));
        try {
          const path = join(directory, "archive.zip");
          const options = {
            passphrase: input.passphrase,
            archivePath: path,
            maximumBytes: 256 * 1024 * 1024,
            signal,
          };
          let receipt;
          if (initial.nativeAuthDatabase) {
            const auth = initial.nativeAuthDatabase;
            const authConnection = await dependencies.database.read(auth, signal);
            if (typeof authConnection === "string")
              throw new RecoveryArchiveError("recovery_database_unavailable");
            const authResource: RecoveryResource = {
              kind: "native_auth_database",
              databaseId: auth.databaseId,
            };
            const resources: RecoveryResource[] = [...physical.keys()]
              .sort()
              .map((environmentId) => ({ kind: "application_database", environmentId }));
            resources.push(authResource);
            const typedScope: RecoveryScopeV2 = {
              schemaVersion: "ohmyhost.recovery-scope/v2",
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              backupId: scope.backupId,
              dataMode: scope.dataMode,
              environments: scope.environments,
              resources,
              nativeManifest: {
                schemaVersion: "ohmyhost.native-auth-inventory/v1",
                organizationId: command.organizationId,
                projectId: command.projectId,
                databaseId: auth.databaseId,
                migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
                migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
                realms: auth.realms,
              },
            };
            receipt = await captureProjectRecoveryArchiveV2({
              ...options,
              scope: typedScope,
              databases: [
                ...databases.map(({ environmentId, ...connection }) => ({
                  resource: { kind: "application_database" as const, environmentId },
                  ...connection,
                })),
                { resource: authResource, ...authConnection },
              ],
            });
          } else {
            receipt = await captureProjectRecoveryArchive({ ...options, scope, databases });
          }
          const archive: ProjectRecoveryArchiveInput = {
            sqlFiles: receipt.sqlFiles,
            bytes: receipt.bytes,
            sha256: new Uint8Array(Buffer.from(receipt.sha256.slice(7), "hex")),
            capturedAt: receipt.capturedAt,
            ...("nativeManifest" in receipt &&
            receipt.nativeManifest !== undefined &&
            receipt.nativeManifestSha256 !== undefined
              ? {
                  nativeManifest: JSON.stringify(receipt.nativeManifest),
                  nativeManifestSha256: new Uint8Array(
                    Buffer.from(receipt.nativeManifestSha256.slice(7), "hex"),
                  ),
                }
              : {}),
          };
          if (initial.nativeAuthDatabase) {
            const current = await control.readInventory();
            if (
              !current?.nativeAuthDatabase ||
              JSON.stringify(current.nativeAuthDatabase) !==
                JSON.stringify(initial.nativeAuthDatabase) ||
              archive.nativeManifest === undefined
            )
              throw new RecoveryArchiveError("recovery_scope_mismatch");
          }
          signal.throwIfAborted();
          await control.prepareArchive({ archive, fence });
          const uploadTarget =
            archive.nativeManifest === undefined
              ? target
              : {
                  ...target,
                  key: `native-exports/${command.organizationId}/${command.projectId}/${command.operationId}.zip`,
                };
          if (archive.nativeManifest !== undefined) {
            if (!control.dispatchArchive)
              throw new ArchiveReadbackUncertainError("recovery_storage_unavailable");
            const permit = await control.dispatchArchive({ archive, fence });
            if (!permit.granted) {
              await requireVerified(dependencies.archives, { ...uploadTarget, archive });
              await finishSuccess(control, archive, fence, signal);
              finished = true;
              return { status: "succeeded" };
            }
          }
          try {
            await dependencies.archives.put({ ...uploadTarget, path, archive });
          } catch {
            // A lost upload response is uncertain; only the independent readback below decides success.
          }
          await requireVerified(dependencies.archives, { ...uploadTarget, archive });
          await finishSuccess(control, archive, fence, signal);
          finished = true;
          return { status: "succeeded" };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      } catch (error) {
        const outcome = await afterFailure(control, error, fence, abort);
        finished = outcome.finished;
        return { status: outcome.status };
      } finally {
        renewal.stop();
        // A finished job released its lease in the finishing batch; any other exit gives it back early.
        if (!finished) await control.releaseFence(fence).catch(() => undefined);
      }
    },
  });
}

async function finishSuccess(
  control: RecoveryJobControl,
  archive: ProjectRecoveryArchiveInput,
  fence: WireFence,
  signal: AbortSignal,
): Promise<void> {
  // A lease lost between the readback and the finish never records success: the batch is refused by its guard too.
  signal.throwIfAborted();
  const result = await control.finish({ archive, fence });
  if (result.status !== "succeeded") throw new RecoveryControlError("project_recovery_conflict");
}

async function failWithoutFence(
  control: RecoveryJobControl,
  code: string,
): Promise<{ status: Status }> {
  const result = await control.finish({ failureCode: code });
  return { status: result.outcome === "waiting" ? "running" : result.status };
}

async function afterAcquireFailure(
  control: RecoveryJobControl,
  error: unknown,
): Promise<{ status: Status }> {
  if (error instanceof RecoveryControlError) {
    // Another live capture, or an outcome nobody knows: the same original job stays running and is dispatched again.
    if (error.code === "recovery_source_busy" || error.retryable) return { status: "running" };
    if (error.code === "recovery_scope_unavailable")
      return failWithoutFence(control, "RECOVERY_SCOPE_UNAVAILABLE");
    if (error.code === "project_recovery_conflict") {
      const state = await control.readClaimState();
      return { status: state?.status ?? "absent" };
    }
  }
  throw error;
}

async function afterFailure(
  control: RecoveryJobControl,
  error: unknown,
  fence: WireFence,
  abort: AbortController,
): Promise<{ status: Status; finished: boolean }> {
  const lost = error instanceof RecoveryControlError && error.code === "recovery_fence_lost";
  // The lease is gone (or its renewal failed): this holder writes nothing more. A later dispatch continues the job.
  if (lost || leaseLost(abort.signal)) return { status: "running", finished: false };
  if (error instanceof ArchiveReadbackUncertainError) return { status: "running", finished: false };
  if (error instanceof RecoveryControlError) {
    if (error.retryable) return { status: "running", finished: false };
    if (error.code === "recovery_source_busy") return { status: "running", finished: false };
  }
  const failureCode =
    error instanceof RecoveryArchiveError
      ? error.code.toUpperCase()
      : error instanceof ArchiveLostError
        ? "RECOVERY_ARCHIVE_LOST"
        : "RECOVERY_JOB_FAILED";
  try {
    const result = await control.finish({ failureCode, fence });
    return {
      status: result.outcome === "waiting" ? "running" : result.status,
      finished: result.outcome !== "waiting",
    };
  } catch (finishError) {
    if (finishError instanceof RecoveryControlError) return { status: "running", finished: false };
    throw finishError;
  }
}

function leaseLost(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof RecoveryControlError;
}

interface Renewal {
  stop(): void;
}

/**
 * Keeps the lease alive while the capture runs and enforces it independently of the renewal calls.
 *
 * The watchdog is armed for the last CONFIRMED lease end and is re-armed only by a renewal the store answered. A
 * renewal that hangs, queues or fails therefore cannot keep the capture running past the last confirmed lease: the
 * watchdog aborts it at that instant whether or not a request is still pending. The confirmed end is the earlier of
 * the store's `leaseExpiresAt` and the local send time plus the requested duration, so latency of the answer never
 * extends it and a clock skew of the container can only shorten it. A transport retry of one renewal sends the same
 * command again; only its answer confirms anything.
 */
function keepLeaseAlive(
  control: RecoveryJobControl,
  fence: WireFence,
  settings: { leaseMilliseconds: number; renewEveryMilliseconds: number },
  clock: Clock,
  abort: AbortController,
  initial: { leaseExpiresAt: string },
  initialSentAt: number,
): Renewal {
  let deadline = confirmedEnd(initial.leaseExpiresAt, initialSentAt, settings.leaseMilliseconds);
  let stopped = false;
  let inFlight = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
    const remaining = deadline - clock.now().getTime();
    if (remaining <= 0) {
      abort.abort(new RecoveryControlError("recovery_fence_lost"));
      return;
    }
    // Re-checked against the clock at least once per second, so a stalled timer or a clock that moved cannot
    // postpone the end of the lease.
    watchdog = setTimeout(arm, Math.min(remaining, WATCHDOG_POLL_MILLISECONDS));
  };
  arm();
  const tick = async () => {
    if (stopped || abort.signal.aborted || inFlight) return;
    inFlight = true;
    const sentAt = clock.now().getTime();
    try {
      const lease = await control.renewFence({
        ...fence,
        leaseMilliseconds: settings.leaseMilliseconds,
      });
      if (stopped || abort.signal.aborted) return;
      const confirmed = confirmedEnd(lease.leaseExpiresAt, sentAt, settings.leaseMilliseconds);
      if (confirmed > deadline) {
        deadline = confirmed;
        arm();
      }
    } catch (error) {
      if (stopped) return;
      // A transient failure keeps the lease where it stands: the watchdog still ends the capture at its last
      // confirmed end. A refusal means the lease is gone now.
      if (!(error instanceof RecoveryControlError && error.retryable))
        abort.abort(
          error instanceof RecoveryControlError
            ? error
            : new RecoveryControlError("recovery_fence_lost"),
        );
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), settings.renewEveryMilliseconds);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (watchdog !== undefined) clearTimeout(watchdog);
    },
  };
}

function confirmedEnd(leaseExpiresAt: string, sentAt: number, leaseMilliseconds: number): number {
  const stated = Date.parse(leaseExpiresAt);
  return Number.isFinite(stated) ? Math.min(stated, sentAt + leaseMilliseconds) : sentAt;
}

function parseCommand(input: RecoveryJobCommand): RecoveryJobCommand {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "claimId,operationId,organizationId,projectId" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.claimId)
  )
    throw new RecoveryArchiveError("recovery_input_invalid");
  return {
    organizationId: parseUlid(input.organizationId),
    projectId: parseUlid(input.projectId),
    operationId: parseUlid(input.operationId),
    claimId: input.claimId,
  };
}
function physicalDatabases(inventory: RecoveryInventory): Map<string, RecoveryDatabaseReference> {
  const result = new Map<string, RecoveryDatabaseReference>();
  for (const environment of inventory.environments)
    if (environment.database !== null)
      result.set(environment.databaseEnvironmentId, environment.database);
  return result;
}
function environmentIds(inventory: RecoveryInventory): RecoveryScope["environments"] {
  const prod = inventory.environments.at(-1),
    dev = inventory.environments.length === 2 ? inventory.environments[0] : undefined;
  if (
    inventory.environments.length < 1 ||
    inventory.environments.length > 2 ||
    prod?.name !== "prod" ||
    (inventory.environments.length === 2 && dev?.name !== "dev")
  )
    throw new RecoveryArchiveError("recovery_scope_mismatch");
  return {
    ...(dev === undefined ? {} : { dev: dev.databaseEnvironmentId }),
    prod: prod.databaseEnvironmentId,
  };
}
class ArchiveReadbackUncertainError extends Error {}
/** A recorded archive that never landed and cannot be captured again: the job fails with RECOVERY_ARCHIVE_LOST. */
class ArchiveLostError extends Error {}

/** Reads the object back: `absent` or `verified`. A different object is a failure, an unreadable one is uncertain. */
async function readback(
  store: RecoveryArchiveStore,
  input: Parameters<RecoveryArchiveStore["verify"]>[0],
): Promise<"verified" | "absent"> {
  let status: Awaited<ReturnType<RecoveryArchiveStore["verify"]>>;
  try {
    status = await store.verify(input);
  } catch {
    throw new ArchiveReadbackUncertainError("recovery_storage_unavailable");
  }
  if (status === "different") throw new RecoveryArchiveError("recovery_checksum_mismatch");
  return status;
}

async function requireVerified(
  store: RecoveryArchiveStore,
  input: Parameters<RecoveryArchiveStore["verify"]>[0],
): Promise<void> {
  if ((await readback(store, input)) !== "verified") {
    if (input.archive.nativeManifest !== undefined)
      throw new ArchiveReadbackUncertainError("recovery_storage_unavailable");
    throw new RecoveryArchiveError("recovery_io_failed");
  }
}
