import type {
  PreviewRuntimeFence,
  PreviewRuntimeRecord,
  ProjectPreviewRuntime,
  SourceVersion,
} from "@ohmyhost/contracts/previews";
import type { FrameworkPlan } from "@ohmyhost/platform";
import { PreviewBackups, type BackupMetadata } from "./backup.js";
import { applySourceDelta, type SourceWriter } from "./source-sync.js";
import type { PreviewSourcePort, PreviewSourceResult, PreviewStorage } from "./runtime-types.js";

const IDLE_MS = 10 * 60_000;
const HOLD_MS = 45_000;
// Individual SDK commands have shorter deadlines; this also bounds a whole guest exchange.
const GUEST_WAIT_MS = 270_000;
const SESSION_KEY = "product-session-v1";
const RUN_KEY = "product-run-v1";
const TARGET_KEY = "product-source-notification-v1";
const INTENT_KEY = "product-run-intent-v1";
const STOP_KEY = "product-stop-intent-v1";

function reservationRejected(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "preview_version_conflict" ||
      /CHECK constraint failed: guard_insufficient_credits(?:$|:)/u.test(error.message))
  );
}

interface Run {
  readonly fence: PreviewRuntimeFence;
  readonly intervalId: string;
  readonly applicationId: string;
  readonly startedAt: number | null;
  readonly holdSequence: number;
  readonly holdAt: number;
}
interface RunIntent {
  readonly fence: PreviewRuntimeFence;
  readonly intervalId: string;
  readonly applicationId: string;
  readonly rowVersion: number;
  readonly startedAt: number;
}
interface SessionState {
  readonly state: "cold" | "starting" | "ready" | "sleeping";
  readonly phase:
    | "idle"
    | "admission"
    | "source"
    | "container"
    | "restore"
    | "apply"
    | "install"
    | "backup"
    | "configuration"
    | "server"
    | "ready"
    | "failed";
  readonly failure:
    | "admission"
    | "source"
    | "containment"
    | "backup"
    | "startup"
    | "native_preparing"
    | null;
  readonly failedAt: SessionState["phase"] | null;
  readonly fence: PreviewRuntimeFence | null;
  readonly applied: SourceVersion | null;
  readonly plan: FrameworkPlan | null;
  readonly planHash: string | null;
  readonly region: "eu" | "us" | null;
  readonly lastActivityAt: number;
}
export interface PreviewSessionDriver {
  running(): boolean;
  ensureUsageAuthority(): Promise<string>;
  start(
    fence: PreviewRuntimeFence,
    intervalId: string,
    source: PreviewSourceResult,
    publicOrigin: string,
    signal?: AbortSignal,
  ): Promise<void>;
  prepareWorkspace(signal?: AbortSignal): Promise<void>;
  prepareCaches(applicationRoot: string, signal?: AbortSignal): Promise<void>;
  readonly writer: SourceWriter | ((signal?: AbortSignal) => SourceWriter);
  install(source: PreviewSourceResult, signal?: AbortSignal): Promise<void>;
  ensurePrepared(fence: PreviewRuntimeFence, source: PreviewSourceResult): Promise<void>;
  prepare(source: PreviewSourceResult, publicOrigin: string, signal?: AbortSignal): Promise<void>;
  serve(publicOrigin: string, signal?: AbortSignal): Promise<void>;
  updateSource(
    fence: PreviewRuntimeFence,
    source: PreviewSourceResult,
    publicOrigin: string,
    signal?: AbortSignal,
  ): Promise<void>;
  destroy(): Promise<void>;
  closeConnections(): Promise<void>;
  drainNative(fence: PreviewRuntimeFence, region: "eu" | "us"): Promise<void>;
}
export interface PreviewSessionPorts {
  readonly core: ProjectPreviewRuntime;
  readonly source: PreviewSourcePort;
  readonly storage: PreviewStorage;
  readonly backups: PreviewBackups;
  readonly cancelBackup: () => Promise<void>;
  readonly reconcileBackup: () => Promise<void>;
  readonly driver: PreviewSessionDriver;
  readonly now?: () => number;
  readonly waitUntil: (operation: Promise<unknown>) => void;
}

/** One actor owns all lifecycle/source writes; a separate alarm renews the current usage hold. */
export class PreviewSessionController {
  private queue: Promise<void> = Promise.resolve();
  private meterQueue: Promise<unknown> = Promise.resolve();
  private publicOrigin: string | null = null;
  private restartPending: object | null = null;
  private active: AbortController | null = null;
  private running: AbortController | null = null;
  private stopping: Promise<number> | null = null;
  private closing: Promise<void> | null = null;
  public constructor(private readonly ports: PreviewSessionPorts) {}
  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private meter<T>(run: () => Promise<T>): Promise<T> {
    const next = this.meterQueue.then(run, run);
    this.meterQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private assertActive(operation: AbortController): void {
    if (this.active !== operation || operation.signal.aborted)
      throw new Error("preview_operation_cancelled");
  }
  private beginOperation(): AbortController {
    const operation = new AbortController();
    this.active = operation;
    return operation;
  }
  private endOperation(operation: AbortController): void {
    if (this.active === operation) this.active = null;
  }
  private writer(signal: AbortSignal): SourceWriter {
    return typeof this.ports.driver.writer === "function"
      ? this.ports.driver.writer(signal)
      : this.ports.driver.writer;
  }
  /** Abort the exchange and its VM on timeout; abort also releases the serialized caller. */
  private async guest<T>(
    operation: AbortController,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertActive(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("preview_operation_cancelled"));
      operation.signal.addEventListener("abort", rejectAbort, { once: true });
      timer = setTimeout(() => {
        void this.abortRun().catch(() => undefined);
      }, GUEST_WAIT_MS);
    });
    try {
      const value = await Promise.race([run(operation.signal), cancelled]);
      this.assertActive(operation);
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (rejectAbort) operation.signal.removeEventListener("abort", rejectAbort);
    }
  }
  /** Revoke first and initiate native destruction without waiting on guest or serial work. */
  private abortRun(): Promise<number> {
    this.active?.abort();
    this.running?.abort();
    this.running = null;
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      const stoppedAt = this.now();
      try {
        void this.ports.cancelBackup?.().catch(() => undefined);
      } catch {
        // Native destruction must still run if cancellation itself fails.
      }
      try {
        this.closing = this.ports.driver.closeConnections();
      } catch (error) {
        this.closing = Promise.reject(error);
      }
      void this.closing.catch(() => undefined);
      await this.ports.driver.destroy();
      return stoppedAt;
    })();
    this.stopping = stopping;
    void stopping.catch(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    return stopping;
  }
  private async state(): Promise<SessionState> {
    return (
      (await this.ports.storage.get<SessionState>(SESSION_KEY)) ?? {
        state: "cold",
        phase: "idle",
        failure: null,
        failedAt: null,
        fence: null,
        applied: null,
        plan: null,
        planHash: null,
        region: null,
        lastActivityAt: 0,
      }
    );
  }
  private async phase(phase: SessionState["phase"], operation: AbortController): Promise<void> {
    this.assertActive(operation);
    const state = await this.state();
    this.assertActive(operation);
    await this.ports.storage.put(SESSION_KEY, {
      ...state,
      phase,
      failure: null,
      failedAt: null,
    });
  }
  private async current(fence: PreviewRuntimeFence): Promise<PreviewRuntimeRecord> {
    const record = await this.ports.core.authorizeRuntime(fence);
    if (!record || record.retirement !== "none") throw new Error("preview_scope_unavailable");
    return record;
  }
  private async recordApplied(
    fence: PreviewRuntimeFence,
    source: SourceVersion,
    operation: AbortController,
  ): Promise<PreviewRuntimeRecord> {
    let current = await this.current(fence);
    for (;;) {
      const target = current.targetSource;
      if (
        !target ||
        target.sequence < source.sequence ||
        target.sourceConnectionId !== source.sourceConnectionId ||
        target.sourceGeneration !== source.sourceGeneration
      )
        throw new Error("preview_source_superseded");
      try {
        this.assertActive(operation);
        const result = await this.ports.core.recordAppliedSource({
          ...fence,
          expectedRowVersion: current.rowVersion,
          source,
        });
        this.assertActive(operation);
        return result;
      } catch (error) {
        this.assertActive(operation);
        const next = await this.current(fence);
        if (next.rowVersion <= current.rowVersion) throw error;
        current = next;
      }
    }
  }
  private async recordReady(
    fence: PreviewRuntimeFence,
    operation: AbortController,
  ): Promise<PreviewRuntimeRecord> {
    let current = await this.current(fence);
    for (;;) {
      try {
        this.assertActive(operation);
        const result = await this.ports.core.recordState({
          ...fence,
          expectedRowVersion: current.rowVersion,
          state: "ready",
        });
        this.assertActive(operation);
        return result;
      } catch (error) {
        this.assertActive(operation);
        const next = await this.current(fence);
        if (next.rowVersion <= current.rowVersion) throw error;
        current = next;
      }
    }
  }
  private async publishBackup(
    fence: PreviewRuntimeFence,
    backup: BackupMetadata | null,
    operation: AbortController,
  ): Promise<number | undefined> {
    let record = await this.current(fence);
    for (;;) {
      const expiry = Date.parse(record.lastActivityAt) + 30 * 24 * 60 * 60 * 1000;
      try {
        this.assertActive(operation);
        await this.ports.core.recordBackup({
          ...fence,
          expectedRowVersion: record.rowVersion,
          backup:
            backup === null
              ? null
              : {
                  handle: backup.record.id,
                  source: backup.source,
                  expiresAt: new Date(expiry).toISOString(),
                },
        });
        this.assertActive(operation);
        return backup === null ? undefined : expiry;
      } catch (error) {
        this.assertActive(operation);
        const next = await this.current(fence);
        if (next.rowVersion <= record.rowVersion) throw error;
        record = next;
      }
    }
  }
  private async acknowledgeDeletes(fence: PreviewRuntimeFence): Promise<void> {
    await this.ports.backups.retryDeletes();
    const deleted = new Set(await this.ports.backups.deletedHandles());
    const pending = await this.ports.core.listBackupCleanup(fence);
    for (const item of pending) {
      if (!deleted.has(item.handle)) throw new Error("preview_backup_reconciliation_required");
      await this.ports.core.acknowledgeBackupCleanup({
        ...fence,
        cleanupId: item.cleanupId,
        handle: item.handle,
      });
      await this.ports.backups.acknowledgeDeleted(item.handle);
    }
  }
  private async arm(): Promise<void> {
    const state = await this.state();
    const run = await this.ports.storage.get<Run>(RUN_KEY);
    const candidates: number[] = [];
    if (run) candidates.push(run.holdAt + HOLD_MS);
    if (state.state === "ready") candidates.push(state.lastActivityAt + IDLE_MS);
    const target = (await this.ports.storage.get<number>(TARGET_KEY)) ?? 0;
    if (state.state === "ready" && state.applied && target > state.applied.sequence)
      candidates.push(this.now() + 2_000);
    const backup = await this.ports.backups.current(this.now()).catch(() => null);
    if (backup) candidates.push(backup.expiresAt);
    if (candidates.length)
      await this.ports.storage.setAlarm(Math.max(this.now() + 1, Math.min(...candidates)));
    else await this.ports.storage.deleteAlarm();
  }

  public async status(): Promise<SessionState & { restartPending: boolean }> {
    return { ...(await this.state()), restartPending: this.restartPending !== null };
  }

  /** The capability origin is kept in memory only; an ingress request reestablishes it. */
  public async rememberOrigin(origin: string, synchronize = true): Promise<void> {
    this.publicOrigin = origin;
    if (!synchronize) return;
    const state = await this.state();
    const target = (await this.ports.storage.get<number>(TARGET_KEY)) ?? 0;
    if (state.state === "ready" && state.applied && target > state.applied.sequence)
      this.ports.waitUntil(this.synchronize());
  }

  private async recoverIntent(): Promise<void> {
    const stopped = await this.ports.storage.get<PreviewRuntimeFence | null>(STOP_KEY);
    if (stopped) {
      const scope = await this.ports.core.getCleanupState({ previewId: stopped.previewId });
      if (
        scope &&
        scope.runtimeGeneration === stopped.runtimeGeneration &&
        scope.tokenGeneration === stopped.tokenGeneration &&
        scope.retirement === "none"
      )
        await this.ports.core.recordStopped(stopped);
      await this.ports.storage.put(STOP_KEY, null);
    }
    const intent = await this.ports.storage.get<RunIntent | null>(INTENT_KEY);
    if (!intent) return;
    const known = await this.ports.storage.get<Run | null>(RUN_KEY);
    if (!known) {
      let result: Awaited<ReturnType<ProjectPreviewRuntime["reserveUsage"]>>;
      try {
        result = await this.reserveIntent(intent);
      } catch (error) {
        if (reservationRejected(error)) return;
        throw error;
      }
      const preview = result.preview;
      const fence = {
        previewId: preview.previewId,
        runtimeGeneration: preview.runtimeGeneration,
        tokenGeneration: preview.tokenGeneration,
      };
      await this.ports.storage.put(RUN_KEY, {
        fence,
        intervalId: intent.intervalId,
        applicationId: intent.applicationId,
        startedAt: null,
        holdSequence: 1,
        holdAt: intent.startedAt,
      } satisfies Run);
    }
    await this.ports.storage.put(INTENT_KEY, null);
    await this.stopRun();
  }

  private async reserveIntent(intent: RunIntent) {
    try {
      return await this.ports.core.reserveUsage({
        ...intent.fence,
        expectedRowVersion: intent.rowVersion,
        intervalId: intent.intervalId,
        applicationId: intent.applicationId,
        seconds: 60,
        holdSequence: 1,
        start: true,
      });
    } catch (error) {
      // Core checks an exact interval replay before its version/credit checks. These
      // rejections prove no reservation committed; unknown replies retain the intent.
      if (reservationRejected(error)) await this.ports.storage.put(INTENT_KEY, null);
      throw error;
    }
  }

  /** Notifications are durable before acknowledgement and never wake a sleeping actor. */
  public async sourceChanged(sequence: number): Promise<{ synchronization: Promise<void> }> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("preview_source_invalid");
    const old = (await this.ports.storage.get<number>(TARGET_KEY)) ?? 0;
    const accepted = sequence > old;
    if (accepted) await this.ports.storage.put(TARGET_KEY, sequence);
    const state = await this.state();
    if (state.fence)
      this.ports.waitUntil(
        this.serial(async () => {
          const scope = await this.ports.core.getCleanupState({
            previewId: (state.fence as PreviewRuntimeFence).previewId,
          });
          if (scope?.retirement === "none" && scope.backupExpiresAt)
            await this.ports.backups.synchronizeExpiry(Date.parse(scope.backupExpiresAt));
          const latest = await this.state();
          if (accepted && latest.state === "ready")
            await this.ports.storage.put(SESSION_KEY, { ...latest, lastActivityAt: this.now() });
          await this.arm();
        }),
      );
    if (state.state === "ready") {
      await this.arm();
      const synchronization = this.synchronize();
      this.ports.waitUntil(synchronization);
      return { synchronization };
    }
    return { synchronization: this.queue };
  }

  public async wake(fence: PreviewRuntimeFence, publicOrigin: string): Promise<void> {
    this.publicOrigin = publicOrigin;
    let failurePhase: SessionState["phase"] = "admission";
    try {
      return await this.serial(async () => {
        await this.recoverIntent();
        const recovered = await this.ports.core.getCleanupState({ previewId: fence.previewId });
        if (
          recovered &&
          recovered.retirement === "none" &&
          recovered.tokenGeneration === fence.tokenGeneration
        )
          fence = { ...fence, runtimeGeneration: recovered.runtimeGeneration };
        let state = await this.state();
        let current = await this.current(fence);
        if (
          state.state === "ready" &&
          this.ports.driver.running() &&
          state.fence &&
          state.fence.runtimeGeneration === fence.runtimeGeneration &&
          state.fence.tokenGeneration === fence.tokenGeneration
        ) {
          await this.touchCurrent(state);
          return;
        }
        if (state.state === "starting" || state.state === "ready" || this.ports.driver.running()) {
          await this.stopRun();
          current = await this.current(fence);
        }
        const operation = this.beginOperation();
        try {
          if (!current.targetSource) throw new Error("preview_source_unavailable");
          await this.ports.reconcileBackup();
          await this.phase("admission", operation);
          const applicationId = await this.ports.driver.ensureUsageAuthority();
          const now = this.now();
          this.assertActive(operation);
          current = await this.ports.core.renewActivity({
            ...fence,
            expectedRowVersion: current.rowVersion,
            occurredAt: new Date(now).toISOString(),
          });
          const intervalId = crypto.randomUUID();
          // Persist intent before reservation so a lost RPC reply cannot silently create another run.
          const intent: RunIntent = {
            fence,
            intervalId,
            applicationId,
            rowVersion: current.rowVersion,
            startedAt: now,
          };
          this.assertActive(operation);
          await this.ports.storage.put(INTENT_KEY, intent);
          const reservation = await this.reserveIntent(intent);
          this.assertActive(operation);
          current = reservation.preview;
          const runtimeFence = {
            previewId: current.previewId,
            runtimeGeneration: current.runtimeGeneration,
            tokenGeneration: current.tokenGeneration,
          };
          const run: Run = {
            fence: runtimeFence,
            intervalId,
            applicationId,
            startedAt: null,
            holdSequence: 1,
            holdAt: now,
          };
          this.assertActive(operation);
          await this.ports.storage.put(RUN_KEY, run);
          await this.ports.storage.put(INTENT_KEY, null);
          state = {
            state: "starting",
            phase: "source",
            failure: null,
            failedAt: null,
            fence: runtimeFence,
            applied: null,
            plan: null,
            planHash: null,
            region: current.region,
            lastActivityAt: now,
          };
          this.assertActive(operation);
          await this.ports.storage.put(SESSION_KEY, state);
          await this.arm();
          try {
            failurePhase = "backup";
            await this.ports.backups.reconcileHandoff((value) =>
              this.publishBackup(runtimeFence, value, operation),
            );
            await this.acknowledgeDeletes(runtimeFence);
            let backup = await this.ports.backups.current(now);
            if (
              backup &&
              (backup.source.sourceConnectionId !== current.targetSource?.sourceConnectionId ||
                backup.source.sourceGeneration !== current.targetSource?.sourceGeneration)
            )
              backup = null;
            let from = backup?.source ?? null;
            failurePhase = "source";
            await this.phase("source", operation);
            const source = await this.ports.source.previewDiff({
              previewId: current.previewId,
              runtimeGeneration: current.runtimeGeneration,
              tokenGeneration: current.tokenGeneration,
              from,
              to: current.targetSource as SourceVersion,
            });
            if (source.from === null) {
              backup = null;
              from = null;
            }
            await this.ports.driver.ensurePrepared(runtimeFence, source);
            failurePhase = "container";
            await this.phase("container", operation);
            if ((await this.ports.driver.ensureUsageAuthority()) !== applicationId)
              throw new Error("preview_usage_identity_changed");
            await this.meter(async () => {
              this.assertActive(operation);
              const active = await this.ports.storage.get<Run | null>(RUN_KEY);
              if (!active || active.intervalId !== intervalId)
                throw new Error("preview_usage_fenced");
              this.assertActive(operation);
              await this.ports.storage.put(RUN_KEY, { ...active, startedAt: this.now() });
            });
            this.assertActive(operation);
            this.stopping = null;
            this.closing = null;
            await this.guest(operation, (signal) =>
              this.ports.driver.start(runtimeFence, intervalId, source, publicOrigin, signal),
            );
            await this.guest(operation, (signal) => this.ports.driver.prepareWorkspace(signal));
            if (backup) {
              failurePhase = "restore";
              await this.phase("restore", operation);
              await this.guest(operation, () => this.ports.backups.restore(now));
              await this.guest(operation, (signal) => this.ports.driver.prepareWorkspace(signal));
            }
            failurePhase = "apply";
            await this.phase("apply", operation);
            await this.guest(operation, (signal) =>
              applySourceDelta(source, from, this.writer(signal), true),
            );
            await this.guest(operation, (signal) =>
              this.ports.driver.prepareCaches(
                source.inspection.frameworkPlan.applicationRoot,
                signal,
              ),
            );
            current = await this.recordApplied(runtimeFence, source.to, operation);
            if (!backup || source.dependenciesChanged) {
              failurePhase = "install";
              await this.phase("install", operation);
              await this.guest(operation, (signal) => this.ports.driver.install(source, signal));
              failurePhase = "backup";
              await this.phase("backup", operation);
              await this.guest(operation, () =>
                this.ports.backups.checkpoint(
                  source.to,
                  Date.parse(current.lastActivityAt),
                  (value) => this.publishBackup(runtimeFence, value, operation),
                ),
              );
              await this.acknowledgeDeletes(runtimeFence);
            }
            failurePhase = "configuration";
            await this.phase("configuration", operation);
            await this.guest(operation, (signal) =>
              this.ports.driver.prepare(source, publicOrigin, signal),
            );
            await this.guest(operation, (signal) =>
              this.ports.driver.updateSource(runtimeFence, source, publicOrigin, signal),
            );
            failurePhase = "server";
            await this.phase("server", operation);
            await this.guest(operation, (signal) => this.ports.driver.serve(publicOrigin, signal));
            current = await this.recordReady(runtimeFence, operation);
            state = {
              state: "ready",
              phase: "ready",
              failure: null,
              failedAt: null,
              fence: runtimeFence,
              applied: source.to,
              plan: source.inspection.frameworkPlan,
              planHash: source.inspection.buildPlanSha256,
              region: current.region,
              lastActivityAt: now,
            };
            this.assertActive(operation);
            await this.ports.storage.put(SESSION_KEY, state);
            this.assertActive(operation);
            this.running = operation;
            await this.arm();
            if (current.targetSource && current.targetSource.sequence > source.to.sequence)
              this.ports.waitUntil(this.synchronize());
          } catch (error) {
            await this.stopRun().catch(() => undefined);
            throw error;
          }
        } finally {
          this.endOperation(operation);
        }
      });
    } catch (error) {
      const failure: SessionState["failure"] =
        error instanceof Error && error.message === "preview_native_preparing"
          ? "native_preparing"
          : failurePhase === "admission"
            ? "admission"
            : failurePhase === "source" || failurePhase === "apply"
              ? "source"
              : failurePhase === "backup" || failurePhase === "restore"
                ? "backup"
                : "startup";
      const state = await this.state();
      if (
        state.state !== "ready" &&
        !(error instanceof Error && error.message === "preview_operation_cancelled")
      )
        await this.ports.storage.put(SESSION_KEY, {
          ...state,
          phase: "failed",
          failure,
          failedAt: failurePhase,
        });
      throw error;
    }
  }

  public touch(): Promise<void> {
    return this.serial(() => this.touchCurrent());
  }

  private async touchCurrent(state?: SessionState): Promise<void> {
    const selected = state ?? (await this.state());
    if (selected.state !== "ready" || !selected.fence) return;
    const now = this.now();
    const current = await this.current(selected.fence);
    await this.ports.core.renewActivity({
      ...selected.fence,
      expectedRowVersion: current.rowVersion,
      occurredAt: new Date(now).toISOString(),
    });
    await this.ports.backups.renew(now, async () => undefined);
    await this.ports.storage.put(SESSION_KEY, { ...selected, lastActivityAt: now });
    await this.arm();
  }

  public async synchronize(): Promise<void> {
    let restart: { fence: PreviewRuntimeFence; origin: string } | null = null;
    const restartMarker = {};
    const pending = this.serial(async () => {
      let state = await this.state();
      if (
        state.state !== "ready" ||
        !state.fence ||
        !state.applied ||
        !this.publicOrigin ||
        !this.ports.driver.running()
      )
        return;
      const operation = this.beginOperation();
      try {
        for (;;) {
          this.assertActive(operation);
          const fence = state.fence as PreviewRuntimeFence,
            applied = state.applied as SourceVersion,
            origin = this.publicOrigin as string;
          const current = await this.current(fence);
          const target = current.targetSource;
          if (!target || target.sequence <= applied.sequence) break;
          const sameIdentity =
            target.sourceConnectionId === applied.sourceConnectionId &&
            target.sourceGeneration === applied.sourceGeneration;
          if (!sameIdentity) {
            restart = { fence, origin };
            this.restartPending = restartMarker;
            await this.stopRun();
            break;
          }
          let source: PreviewSourceResult;
          try {
            source = await this.ports.source.previewDiff({
              previewId: current.previewId,
              runtimeGeneration: current.runtimeGeneration,
              tokenGeneration: current.tokenGeneration,
              from: applied,
              to: target,
            });
          } catch (error) {
            // A newer accepted target can supersede an immutable fetch before it writes anything.
            const latest = await this.current(fence);
            if (
              latest.targetSource &&
              latest.targetSource.sequence > target.sequence &&
              latest.targetSource.sourceConnectionId === target.sourceConnectionId &&
              latest.targetSource.sourceGeneration === target.sourceGeneration
            )
              continue;
            throw error;
          }
          if (
            source.from === null ||
            source.dependenciesChanged ||
            source.inspection.buildPlanSha256 !== state.planHash
          ) {
            restart = { fence, origin };
            this.restartPending = restartMarker;
            await this.stopRun();
            break;
          }
          await this.ports.driver.ensurePrepared(fence, source);
          try {
            await this.guest(operation, (signal) =>
              applySourceDelta(source, applied, this.writer(signal), true),
            );
            // This acknowledges delivery of the accepted event, not the VM's executing code.
            const latest = await this.recordApplied(fence, target, operation);
            state = {
              ...state,
              applied: target,
              plan: source.inspection.frameworkPlan,
              planHash: source.inspection.buildPlanSha256,
            };
            this.assertActive(operation);
            await this.ports.storage.put(SESSION_KEY, state);
            if (latest.targetSource && latest.targetSource.sequence > target.sequence) continue;
            await this.guest(operation, (signal) =>
              this.ports.driver.updateSource(fence, source, origin, signal),
            );
            this.assertActive(operation);
            await this.touchCurrent(state);
          } catch (error) {
            await this.stopRun().catch(() => undefined);
            throw error;
          }
        }
      } finally {
        this.endOperation(operation);
      }
    });
    try {
      await pending;
      if (restart !== null) {
        const next: { fence: PreviewRuntimeFence; origin: string } = restart;
        await this.wake(next.fence, next.origin);
      }
    } finally {
      if (this.restartPending === restartMarker) this.restartPending = null;
    }
  }

  private async stopRun(alreadyStoppedAt?: number): Promise<void> {
    const stoppedAt = alreadyStoppedAt ?? (await this.abortRun());
    await this.meter(async () => {
      const run = await this.ports.storage.get<Run>(RUN_KEY);
      if (!run) return;
      await this.ports.core.closeUsage({
        previewId: run.fence.previewId,
        runtimeGeneration: run.fence.runtimeGeneration,
        intervalId: run.intervalId,
        activeMilliseconds: run.startedAt === null ? 0 : Math.max(0, stoppedAt - run.startedAt),
        containerStartAttempted: run.startedAt !== null,
      });
      await this.ports.storage.put(STOP_KEY, run.fence);
      await this.ports.storage.put(RUN_KEY, null);
      const state = await this.state();
      try {
        const scope = await this.ports.core.getCleanupState({ previewId: run.fence.previewId });
        if (
          scope &&
          scope.runtimeGeneration === run.fence.runtimeGeneration &&
          scope.tokenGeneration === run.fence.tokenGeneration &&
          scope.retirement === "none"
        )
          await this.ports.core.recordStopped(run.fence);
        await this.ports.storage.put(STOP_KEY, null);
      } finally {
        await this.ports.storage.put(SESSION_KEY, {
          ...state,
          state: state.applied ? "sleeping" : "cold",
        });
      }
    });
    await this.arm();
    await this.closing;
  }

  public async fence(fence: PreviewRuntimeFence, reason: "rotate" | "destroy"): Promise<void> {
    const current = await this.ports.core.getCleanupState({ previewId: fence.previewId });
    if (
      !current ||
      current.runtimeGeneration !== fence.runtimeGeneration ||
      current.tokenGeneration !== fence.tokenGeneration ||
      current.retirement !== (reason === "rotate" ? "rotating" : "destroying")
    )
      throw new Error("preview_fence_invalid");
    const stopping = this.abortRun();
    const draining = this.ports.driver.drainNative(fence, current.region);
    void draining.catch(() => undefined);
    const stoppedAt = await stopping;
    await this.serial(() => this.stopRun(stoppedAt));
    await draining;
    if (reason === "destroy")
      await this.serial(async () => {
        await this.ports.reconcileBackup();
        await this.ports.backups.deleteAll(async () => undefined);
        await this.acknowledgeDeletes(fence);
        await this.ports.storage.put(SESSION_KEY, {
          state: "cold",
          phase: "idle",
          failure: null,
          failedAt: null,
          fence: null,
          applied: null,
          plan: null,
          planHash: null,
          region: null,
          lastActivityAt: 0,
        });
      });
  }

  public async cleanupScope(fence: PreviewRuntimeFence): Promise<string | null> {
    const key = "product-scope-cleanup-intent-v1";
    const saved = await this.ports.storage.get<{
      fence: PreviewRuntimeFence;
      handle: string | null;
    } | null>(key);
    const matches =
      saved &&
      saved.fence.previewId === fence.previewId &&
      saved.fence.runtimeGeneration === fence.runtimeGeneration &&
      saved.fence.tokenGeneration === fence.tokenGeneration;
    const current = await this.ports.core.getCleanupState({ previewId: fence.previewId });
    if (
      !current ||
      current.runtimeGeneration !== fence.runtimeGeneration ||
      current.tokenGeneration !== fence.tokenGeneration ||
      current.retirement !== "destroying"
    )
      throw new Error("preview_fence_invalid");
    // A returned SDK handle may still be awaiting handoff while Core pins its predecessor.
    // Re-read Core even for a saved intent so an old actor-selected handle can recover.
    const handle = current.backupHandle;
    if (!matches || saved.handle !== handle) await this.ports.storage.put(key, { fence, handle });
    await this.fence(fence, "destroy");
    return handle;
  }

  /** Core has already claimed this exact expired handle before the SDK object is removed. */
  public async expireBackup(fence: PreviewRuntimeFence): Promise<void> {
    await this.serial(async () => {
      const current = await this.ports.backups.current(0);
      if (current && current.expiresAt <= this.now())
        await this.ports.backups.expire(this.now(), current.generation, async () => undefined);
      await this.acknowledgeDeletes(fence);
      await this.arm();
    });
  }

  public async alarm(): Promise<{ synchronization: Promise<void> }> {
    await this.meter(async () => {
      const run = await this.ports.storage.get<Run>(RUN_KEY);
      if (!run || this.now() < run.holdAt + HOLD_MS) return;
      const current = await this.current(run.fence);
      const holdSequence = run.holdSequence + 1;
      await this.ports.core.reserveUsage({
        ...run.fence,
        expectedRowVersion: current.rowVersion,
        intervalId: run.intervalId,
        applicationId: run.applicationId,
        seconds: 60,
        holdSequence,
        start: false,
      });
      await this.ports.storage.put(RUN_KEY, { ...run, holdSequence, holdAt: this.now() });
    }).catch(async () => {
      const stoppedAt = await this.abortRun();
      await this.serial(() => this.stopRun(stoppedAt));
    });
    const state = await this.state();
    if (state.state === "ready" && !this.ports.driver.running()) {
      const stoppedAt = await this.abortRun();
      await this.serial(() => this.stopRun(stoppedAt));
      return { synchronization: this.queue };
    }
    if (state.state === "ready" && this.now() >= state.lastActivityAt + IDLE_MS) {
      const stoppedAt = await this.abortRun();
      await this.serial(() => this.stopRun(stoppedAt));
    }
    const target = (await this.ports.storage.get<number>(TARGET_KEY)) ?? 0;
    let synchronization: Promise<void>;
    if (state.state === "ready" && state.applied && target > state.applied.sequence) {
      synchronization = this.synchronize();
      this.ports.waitUntil(synchronization);
    } else synchronization = this.queue;
    await this.arm();
    return { synchronization };
  }
}
