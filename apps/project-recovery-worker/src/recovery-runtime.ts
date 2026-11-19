import { parseRecoveryCommand } from "@ohmyhost/platform";
import { createRecoveryJobRunner, type RecoveryJobDependencies } from "./job.js";
import type { createRecoveryArchiveStore } from "./r2-archives.js";

/**
 * Private recovery protocol: callers supply scope, never database credentials or storage locators. Control is reached
 * only through the Worker-mediated port in `dependencies.control`, already bound to this job's scope by its token.
 */
export function createRecoveryRuntime(
  dependencies: RecoveryJobDependencies & {
    readonly archiveDownloads: Pick<
      ReturnType<typeof createRecoveryArchiveStore>,
      "download" | "remove" | "removeRestorePin" | "inspectRestorePin"
    > &
      Partial<
        Pick<
          ReturnType<typeof createRecoveryArchiveStore>,
          "inspectNativeExport" | "removeVerifiedNativeExport"
        >
      >;
    readonly restore?: () => Promise<unknown>;
  },
) {
  const runner = createRecoveryJobRunner(dependencies);
  return async (event: unknown) => {
    const command = parseRecoveryCommand(event);
    if (command.action === "restore") {
      if (!dependencies.restore) throw new Error("recovery_restore_scope_unavailable");
      return dependencies.restore();
    }
    if (command.action === "reconcile-restore-pin") {
      const pin = await dependencies.control.readPinReconciliation();
      const expected = `restore-pins/${command.organizationId}/${command.projectId}/${command.restoreId}.zip`;
      if (
        pin.key !== expected ||
        (pin.state !== "reserved" && pin.state !== "verified" && pin.state !== "tombstoned")
      )
        throw new Error("recovery_cleanup_scope_unavailable");
      const outcome = await dependencies.archiveDownloads.inspectRestorePin({
        bucket: pin.bucket,
        scope: {
          organizationId: command.organizationId,
          projectId: command.projectId,
          restoreId: command.restoreId,
        },
        bytes: pin.bytes,
        sha256: Uint8Array.from(pin.sha256.match(/../gu) ?? [], (hex) => Number.parseInt(hex, 16)),
        signal: AbortSignal.timeout(60000),
        allowTombstone: pin.state === "reserved",
      });
      if (pin.state !== "reserved" && outcome !== pin.state)
        throw new Error("recovery_cleanup_scope_unavailable");
      const result = await dependencies.control.completePinReconciliation({ outcome });
      if (result.status !== outcome) throw new Error("recovery_cleanup_scope_unavailable");
      return { status: outcome, restoreId: command.restoreId };
    }
    const scope = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      operationId: command.operationId,
    };
    if (command.action === "run") return runner.run({ ...scope, claimId: command.claimId });
    if (command.action === "purge") {
      if (dependencies.control.readCleanupTarget === undefined)
        throw new Error("recovery_cleanup_scope_unavailable");
      const target = await dependencies.control.readCleanupTarget();
      if (target.exportId !== command.exportId)
        throw new Error("recovery_cleanup_scope_unavailable");
      if (target.nativeEffect) {
        const keyPattern = new RegExp(
          `^native-exports/[0-7][0-9A-HJKMNP-TV-Z]{25}/${command.projectId}/[0-7][0-9A-HJKMNP-TV-Z]{25}\\.zip$`,
          "u",
        );
        if (
          !keyPattern.test(target.key) ||
          !dependencies.control.recordNativeExportRetired ||
          !dependencies.archiveDownloads.inspectNativeExport ||
          !dependencies.archiveDownloads.removeVerifiedNativeExport
        )
          throw new Error("recovery_cleanup_scope_unavailable");
        const effect = target.nativeEffect;
        const input = {
          bucket: target.bucket,
          key: target.key,
          bytes: effect.bytes,
          sha256: Uint8Array.from(effect.sha256.match(/../gu) ?? [], (hex) =>
            Number.parseInt(hex, 16),
          ),
          signal: AbortSignal.timeout(60_000),
        };
        if (effect.state === "verified") {
          await dependencies.archiveDownloads.removeVerifiedNativeExport(input);
          await dependencies.control.recordNativeExportRetired({ outcome: "absent" });
        } else if (effect.state !== "absent") {
          const outcome = await dependencies.archiveDownloads.inspectNativeExport({
            ...input,
            allowTombstone: effect.state === "reserved" || effect.state === "dispatched",
          });
          if (effect.state === "tombstoned" && outcome !== "tombstoned")
            throw new Error("recovery_cleanup_scope_unavailable");
          if (outcome === "verified") {
            await dependencies.archiveDownloads.removeVerifiedNativeExport(input);
            await dependencies.control.recordNativeExportRetired({ outcome: "absent" });
          } else {
            await dependencies.control.recordNativeExportRetired({ outcome: "tombstoned" });
          }
        }
      } else {
        await dependencies.archiveDownloads.remove({
          bucket: target.bucket,
          key: target.key,
          signal: AbortSignal.timeout(60_000),
        });
      }
      return { status: "absent" as const, exportId: command.exportId };
    }
    if (command.action === "purge-restore-pin") {
      const target = await dependencies.control.readRestorePinDeletionTarget();
      if (target.restoreId !== command.restoreId)
        throw new Error("recovery_cleanup_scope_unavailable");
      await dependencies.archiveDownloads.removeRestorePin({
        bucket: target.bucket,
        scope: {
          organizationId: command.organizationId,
          projectId: command.projectId,
          restoreId: command.restoreId,
        },
        signal: AbortSignal.timeout(60_000),
      });
      await dependencies.control.recordRestorePinDeletionAbsent();
      return { status: "absent" as const, restoreId: command.restoreId };
    }
    const now = dependencies.clock.now().toISOString();
    const archive = await dependencies.control.readArchive();
    if (
      archive === null ||
      archive.operationId !== command.operationId ||
      Date.parse(archive.expiresAt) - Date.parse(now) < 86400000
    )
      return { status: "unavailable" as const };
    const download = await dependencies.archiveDownloads.download({
      bucket: archive.bucket,
      key: archive.key,
      archiveExpiresAt: archive.expiresAt,
    });
    return {
      status: "ready" as const,
      operationId: command.operationId,
      bytes: archive.bytes,
      sha256: `sha256:${Buffer.from(archive.sha256).toString("hex")}`,
      sqlFiles: archive.sqlFiles,
      capturedAt: archive.capturedAt,
      archiveExpiresAt: archive.expiresAt,
      url: download.url,
      downloadExpiresAt: download.expiresAt,
    };
  };
}
