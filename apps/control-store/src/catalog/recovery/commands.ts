import type { BindCommand } from "../platform-commands.js";
import {
  acquireRecoveryFence,
  readRecoveryCaptureHeld,
  releaseRecoveryFence,
  renewRecoveryFence,
  type RecoveryFenceLease,
  type RecoveryFenceRelease,
} from "./fence.js";
import {
  acceptRecoveryJob,
  authorizeNativeRecoveryCapture,
  claimRecoveryJob,
  discardRecoveryArchive,
  dispatchRecoveryArchive,
  discardRecoveryInputs,
  finishRecoveryJob,
  prepareRecoveryArchive,
  prepareRecoveryDispatch,
  readProjectExportStatus,
  readRecoveryArchive,
  readRecoveryJobState,
  readUnfinishedExpiredRecoveries,
  type AcceptRecoveryJobResult,
  type ClaimRecoveryJobResult,
  type FinishRecoveryJobResult,
  type ProjectExportStatus,
  type RecoveryArchiveLocator,
  type RecoveryDispatchResult,
  type RecoveryJobStatus,
  type UnfinishedRecovery,
} from "./jobs.js";
import { readRecoveryScope, type RecoveryScope } from "./scope.js";
import { readRecoveryCleanupTarget, recordNativeExportRetired } from "./cleanup.js";
import {
  readNativeRestorePinDeletionTarget,
  recordNativeRestorePinDeletionAbsent,
} from "./native-restore-cleanup.js";
import { acceptProjectExport, readExportReplay, readRecoveryOperation } from "./api.js";
import { recordRecoveryDispatchFailure } from "./dispatch.js";
import {
  prepareRecoveryMaintenance,
  claimRecoveryOutbox,
  acknowledgeRecoveryOutbox,
} from "./maintenance.js";

/**
 * The closed, typed surface a later Node container caller may use, through the Worker-mediated virtual hostname and a
 * private service binding (never a D1 binding, a database URL or SQL). Every method names one exact organization,
 * project and job; the transport adds the ephemeral job token and the container identity and refuses a request whose
 * scope differs from the ones they were issued for. Nothing here is a public endpoint.
 */
export interface RecoveryPort {
  readClaimState(input: {
    organizationId: string;
    projectId: string;
    operationId: string;
  }): Promise<{ readonly status: RecoveryJobStatus } | null>;
  claim(input: unknown): Promise<ClaimRecoveryJobResult>;
  acquireFence(input: unknown): Promise<RecoveryFenceLease>;
  renewFence(input: unknown): Promise<RecoveryFenceLease>;
  releaseFence(input: unknown): Promise<RecoveryFenceRelease>;
  readScope(input: unknown): Promise<RecoveryScope | null>;
  authorizeNativeCapture(input: unknown): Promise<{ readonly authorized: true }>;
  prepareArchive(input: unknown): Promise<{ readonly outcome: "prepared" | "replayed" }>;
  dispatchArchive(input: unknown): Promise<{ readonly granted: boolean }>;
  discardArchive(input: unknown): Promise<{ readonly outcome: "discarded" | "replayed" }>;
  finish(input: unknown): Promise<FinishRecoveryJobResult>;
}

/**
 * Typed commands of the Q5-A recovery lane. The integrator binds them like every other catalog command (bucket fence
 * plus one route refresh). `executor` is the future Node port; `owner` is the API-side authority (accept, exact-scope
 * reads, the deletion side of the fence); `maintenance` are shard drains reachable only through the scheduler entry.
 */
export function createRecoveryCommands(bind: BindCommand) {
  const executor: RecoveryPort = Object.freeze({
    readClaimState: bind(readRecoveryJobState) as RecoveryPort["readClaimState"],
    claim: bind(claimRecoveryJob),
    acquireFence: bind(acquireRecoveryFence),
    renewFence: bind(renewRecoveryFence),
    releaseFence: bind(releaseRecoveryFence),
    readScope: bind(readRecoveryScope),
    authorizeNativeCapture: bind(authorizeNativeRecoveryCapture),
    prepareArchive: bind(prepareRecoveryArchive),
    dispatchArchive: bind(dispatchRecoveryArchive),
    discardArchive: bind(discardRecoveryArchive),
    finish: bind(finishRecoveryJob),
  });
  return Object.freeze({
    executor,
    cleanup: Object.freeze({
      readCleanupTarget: bind(readRecoveryCleanupTarget),
      recordNativeExportRetired: bind(recordNativeExportRetired),
      readNativeRestorePinDeletionTarget: bind(readNativeRestorePinDeletionTarget),
      recordNativeRestorePinDeletionAbsent: bind(recordNativeRestorePinDeletionAbsent),
    }),
    owner: Object.freeze({
      readOperation: bind(readRecoveryOperation),
      recordDispatchFailure: bind(recordRecoveryDispatchFailure),
      acknowledgeOutbox: bind(acknowledgeRecoveryOutbox),
      readExportReplay: bind(readExportReplay),
      acceptProjectExport: bind(acceptProjectExport),
      acceptRecoveryJob: bind(acceptRecoveryJob) as (
        input: unknown,
      ) => Promise<AcceptRecoveryJobResult>,
      readExportStatus: bind(readProjectExportStatus) as (
        input: unknown,
      ) => Promise<ProjectExportStatus | null>,
      readArchive: bind(readRecoveryArchive) as (
        input: unknown,
      ) => Promise<RecoveryArchiveLocator | null>,
      readCaptureHeld: bind(readRecoveryCaptureHeld),
      prepareDispatch: bind(prepareRecoveryDispatch) as (
        input: unknown,
      ) => Promise<RecoveryDispatchResult>,
    }),
    maintenance: Object.freeze({
      prepareMaintenance: bind(prepareRecoveryMaintenance),
      claimOutbox: bind(claimRecoveryOutbox),
      discardInputs: bind(discardRecoveryInputs),
      readUnfinishedExpired: bind(readUnfinishedExpiredRecoveries) as (
        input: unknown,
      ) => Promise<UnfinishedRecovery[]>,
    }),
  });
}

export type RecoveryCommands = ReturnType<typeof createRecoveryCommands>;
