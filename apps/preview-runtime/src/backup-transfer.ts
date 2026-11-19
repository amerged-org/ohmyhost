import type { PreviewRuntimeFence } from "@ohmyhost/contracts/previews";
import type { BackupStorage } from "./backup.js";

// These are absolute resource ceilings, not performance or capacity guarantees.
export const BACKUP_LIMITS = {
  objectBytes: 2 * 1024 ** 3,
  partBytes: 128 * 1024 ** 2,
  partNumbers: 1024,
  distinctParts: 512,
  uploadBytes: 4 * 1024 ** 3,
  uploadRequests: 2048,
  downloadBytes: 4 * 1024 ** 3,
  downloadRequests: 8192,
  rangeBytes: 128 * 1024 ** 2,
  concurrentTransfers: 128,
  operationMs: 120_000,
  transferMs: 30_000,
} as const;
const KEY = "preview-backup-transfer-grant-v1";
const BINDING = "BACKUP_BUCKET";
const MIN_NON_FINAL_PART_BYTES = 5 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export interface BackupGrantScope {
  readonly fence: PreviewRuntimeFence;
  readonly intervalId: string;
}
export interface BackupGatewayGrant {
  readonly previewId: string;
  readonly operationId: string;
  readonly expiresAt: number;
}
export type BackupTransferMessage =
  | { readonly kind: "check"; readonly operationId: string }
  | {
      readonly kind: "reserve-upload";
      readonly operationId: string;
      readonly transferId: string;
      readonly partNumber: number;
      readonly bytes: number;
    }
  | {
      readonly kind: "dispatch-upload";
      readonly operationId: string;
      readonly transferId: string;
      readonly partNumber: number;
    }
  | {
      readonly kind: "finish-upload";
      readonly operationId: string;
      readonly transferId: string;
      readonly partNumber: number;
      readonly etag: string;
    }
  | {
      readonly kind: "reserve-download";
      readonly operationId: string;
      readonly transferId: string;
      readonly offset: number;
      readonly bytes: number;
    }
  | { readonly kind: "finish-download"; readonly operationId: string; readonly transferId: string };
export type BackupPartObservation = {
  readonly operationId: string;
  readonly key: string;
  readonly uploadId: string;
  readonly transferId: string;
  readonly partNumber: number;
} & ({ readonly kind: "uploaded"; readonly etag: string } | { readonly kind: "not-dispatched" });
export interface BackupTransferPermit {
  readonly operationId: string;
  readonly mode: "write" | "read";
  readonly binding: string;
  readonly key: string;
  readonly uploadId?: string;
  readonly size?: number;
  readonly expiresAt: number;
  readonly deadline: number;
}
interface Part {
  readonly bytes: number;
  readonly transferId: string;
  readonly etag: string | null;
  readonly state: "reserved" | "pending" | "uploaded" | "finished" | "not-dispatched";
}
interface Grant extends BackupGrantScope, BackupGatewayGrant {
  readonly mode: "write" | "read";
  readonly key: string | null;
  readonly uploadId: string | null;
  readonly size: number | null;
  readonly revoked: boolean;
  readonly completionSize: number | null;
  readonly completionDispatched: boolean;
  readonly completionOutcome: number | null;
  readonly parts: Readonly<Record<string, Part>>;
  readonly uploadRequests: number;
  readonly uploadBytes: number;
  readonly downloadRequests: number;
  readonly downloadBytes: number;
  readonly downloads: Readonly<Record<string, number>>;
  readonly settleAfter: number;
}

const fail = (): never => {
  throw new Error("preview_backup_transfer_denied");
};
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function validKey(key: string, previewId: string): boolean {
  const prefix = `preview-backups/${previewId}/`;
  return (
    key.startsWith(prefix) && key.endsWith(".tar.zst") && UUID.test(key.slice(prefix.length, -8))
  );
}
function safeId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

async function etagDigest(etag: string): Promise<string> {
  if (typeof etag !== "string" || etag.length === 0 || etag.length > 1024) return fail();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(etag));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One short, independent queue protects the durable grant; no lifecycle queue or external RPC enters it. */
export class PreviewBackupGrantLedger {
  private queue: Promise<void> = Promise.resolve();
  private readonly revoked = new Set<string>();
  public constructor(private readonly storage: BackupStorage) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async active(operationId: string): Promise<Grant> {
    const grant = await this.storage.get<Grant>(KEY);
    if (
      !grant ||
      this.revoked.has(operationId) ||
      grant.operationId !== operationId ||
      grant.revoked ||
      Date.now() >= grant.expiresAt
    )
      return fail();
    return grant;
  }
  public async begin(
    input: BackupGrantScope & {
      readonly mode: "write" | "read";
      readonly key?: string;
      readonly size?: number;
    },
  ): Promise<BackupGatewayGrant> {
    return this.serial(async () => {
      const previous = await this.storage.get<Grant>(KEY);
      if (
        previous &&
        ((!previous.revoked && previous.expiresAt > Date.now()) ||
          (previous.completionDispatched && previous.completionOutcome === null) ||
          Object.values(previous.parts).some((part) => part.state === "pending"))
      )
        return fail();
      const { fence, intervalId, mode } = input;
      if (
        !ID.test(fence.previewId) ||
        !positive(fence.runtimeGeneration) ||
        !positive(fence.tokenGeneration) ||
        !safeId(intervalId)
      )
        return fail();
      if (
        mode === "read" &&
        (!input.key ||
          !validKey(input.key, fence.previewId) ||
          !positive(input.size ?? 0) ||
          (input.size ?? 0) > BACKUP_LIMITS.objectBytes)
      )
        return fail();
      if (mode === "write" && (input.key !== undefined || input.size !== undefined)) return fail();
      const grant: Grant = {
        fence: { ...fence },
        intervalId,
        previewId: fence.previewId,
        operationId: crypto.randomUUID(),
        expiresAt: Date.now() + BACKUP_LIMITS.operationMs,
        mode,
        key: input.key ?? null,
        size: input.size ?? null,
        uploadId: null,
        revoked: false,
        completionSize: null,
        completionDispatched: false,
        completionOutcome: null,
        parts: {},
        uploadRequests: 0,
        uploadBytes: 0,
        downloadRequests: 0,
        downloadBytes: 0,
        downloads: {},
        settleAfter: 0,
      };
      await this.storage.put(KEY, grant);
      return {
        previewId: grant.previewId,
        operationId: grant.operationId,
        expiresAt: grant.expiresAt,
      };
    });
  }
  public async bindKey(operationId: string, key: string): Promise<void> {
    return this.serial(async () => {
      const grant = await this.active(operationId);
      if (grant.mode !== "write" || grant.key !== null || !validKey(key, grant.previewId))
        return fail();
      await this.storage.put(KEY, { ...grant, key });
    });
  }
  public async bindUpload(operationId: string, key: string, uploadId: string): Promise<void> {
    return this.serial(async () => {
      const grant = await this.active(operationId);
      if (
        grant.mode !== "write" ||
        grant.key !== key ||
        grant.uploadId !== null ||
        !safeId(uploadId)
      )
        return fail();
      await this.storage.put(KEY, { ...grant, uploadId });
    });
  }
  public async assertActive(operationId: string): Promise<void> {
    return this.serial(async () => {
      await this.active(operationId);
    });
  }
  public async assertScope(operationId: string, scope: BackupGrantScope): Promise<void> {
    return this.serial(async () => {
      const grant = await this.active(operationId);
      if (
        grant.intervalId !== scope.intervalId ||
        grant.fence.previewId !== scope.fence.previewId ||
        grant.fence.runtimeGeneration !== scope.fence.runtimeGeneration ||
        grant.fence.tokenGeneration !== scope.fence.tokenGeneration
      )
        return fail();
    });
  }
  public async transfer(
    message: BackupTransferMessage,
    funding: (scope: BackupGrantScope) => Promise<boolean>,
  ): Promise<BackupTransferPermit> {
    const digest = message.kind === "finish-upload" ? await etagDigest(message.etag) : null;
    return this.serial(async () => {
      let grant = await this.active(message.operationId);
      if (!(await funding({ fence: grant.fence, intervalId: grant.intervalId }))) return fail();
      const now = Date.now();
      if (
        this.revoked.has(message.operationId) ||
        now >= grant.expiresAt ||
        !grant.key ||
        (grant.mode === "write" && !grant.uploadId)
      )
        return fail();
      const deadline = Math.min(grant.expiresAt, now + BACKUP_LIMITS.transferMs);
      if (message.kind === "reserve-upload") {
        const { partNumber, bytes, transferId } = message;
        const previous = grant.parts[String(partNumber)];
        if (
          grant.mode !== "write" ||
          grant.completionSize !== null ||
          !positive(partNumber) ||
          partNumber > BACKUP_LIMITS.partNumbers ||
          !positive(bytes) ||
          bytes > BACKUP_LIMITS.partBytes ||
          !UUID.test(transferId) ||
          Object.values(grant.parts).filter(
            (part) => part.state === "reserved" || part.state === "pending",
          ).length >= BACKUP_LIMITS.concurrentTransfers ||
          (previous && (previous.state === "reserved" || previous.state === "pending")) ||
          (!previous && Object.keys(grant.parts).length >= BACKUP_LIMITS.distinctParts) ||
          grant.uploadRequests >= BACKUP_LIMITS.uploadRequests ||
          grant.uploadBytes + bytes > BACKUP_LIMITS.uploadBytes
        )
          return fail();
        grant = {
          ...grant,
          parts: {
            ...grant.parts,
            [partNumber]: { bytes, transferId, etag: null, state: "reserved" },
          },
          uploadRequests: grant.uploadRequests + 1,
          uploadBytes: grant.uploadBytes + bytes,
          settleAfter: Math.max(grant.settleAfter, deadline),
        };
        await this.storage.put(KEY, grant);
      } else if (message.kind === "dispatch-upload" || message.kind === "finish-upload") {
        const part = grant.parts[String(message.partNumber)];
        if (
          grant.mode !== "write" ||
          grant.completionSize !== null ||
          !part ||
          part.transferId !== message.transferId ||
          (message.kind === "dispatch-upload"
            ? part.state !== "reserved"
            : part.state !== "uploaded" || part.etag !== digest || digest === null)
        )
          return fail();
        grant = {
          ...grant,
          parts: {
            ...grant.parts,
            [message.partNumber]: {
              ...part,
              state: message.kind === "dispatch-upload" ? "pending" : "finished",
            },
          },
        };
        await this.storage.put(KEY, grant);
      } else if (message.kind === "reserve-download") {
        const downloads = Object.fromEntries(
          Object.entries(grant.downloads).filter(([, expires]) => expires > now),
        );
        if (
          grant.mode !== "read" ||
          !UUID.test(message.transferId) ||
          downloads[message.transferId] !== undefined ||
          Object.keys(downloads).length >= BACKUP_LIMITS.concurrentTransfers ||
          !Number.isSafeInteger(message.offset) ||
          message.offset < 0 ||
          !positive(message.bytes) ||
          !Number.isSafeInteger(message.offset + message.bytes) ||
          message.bytes > BACKUP_LIMITS.rangeBytes ||
          grant.size === null ||
          message.offset >= grant.size ||
          grant.downloadRequests >= BACKUP_LIMITS.downloadRequests ||
          grant.downloadBytes + message.bytes > BACKUP_LIMITS.downloadBytes
        )
          return fail();
        grant = {
          ...grant,
          downloads: { ...downloads, [message.transferId]: deadline },
          downloadRequests: grant.downloadRequests + 1,
          downloadBytes: grant.downloadBytes + message.bytes,
        };
        await this.storage.put(KEY, grant);
      } else if (message.kind === "finish-download") {
        if (grant.mode !== "read" || grant.downloads[message.transferId] === undefined)
          return fail();
        const downloads = Object.fromEntries(
          Object.entries(grant.downloads).filter(([id]) => id !== message.transferId),
        );
        grant = { ...grant, downloads };
        await this.storage.put(KEY, grant);
      } else if (message.kind !== "check") return fail();
      if (this.revoked.has(message.operationId)) return fail();
      return {
        operationId: grant.operationId,
        mode: grant.mode,
        binding: BINDING,
        key: grant.key as string,
        ...(grant.uploadId ? { uploadId: grant.uploadId } : {}),
        ...(grant.size === null ? {} : { size: grant.size }),
        expiresAt: grant.expiresAt,
        deadline,
      };
    });
  }
  /** Only the trusted gateway observes the actual R2 call, independently of the SDK response. */
  public async recordPartOutcome(observation: BackupPartObservation): Promise<void> {
    const digest = observation.kind === "uploaded" ? await etagDigest(observation.etag) : null;
    return this.serial(async () => {
      const grant = await this.storage.get<Grant>(KEY);
      const part = grant?.parts[String(observation.partNumber)];
      if (
        !grant ||
        grant.operationId !== observation.operationId ||
        grant.key !== observation.key ||
        grant.uploadId !== observation.uploadId ||
        !part ||
        part.transferId !== observation.transferId
      )
        return fail();
      if (observation.kind === "uploaded") {
        if (
          digest === null ||
          (part.state !== "pending" && part.state !== "uploaded" && part.state !== "finished") ||
          (part.etag !== null && part.etag !== digest)
        )
          return fail();
      } else if (
        part.state !== "reserved" &&
        part.state !== "pending" &&
        part.state !== "not-dispatched"
      ) {
        return fail();
      }
      await this.storage.put(KEY, {
        ...grant,
        parts: {
          ...grant.parts,
          [observation.partNumber]: {
            ...part,
            etag: digest,
            state:
              observation.kind === "uploaded"
                ? part.state === "finished"
                  ? "finished"
                  : "uploaded"
                : "not-dispatched",
          },
        },
      });
    });
  }
  public async validateCompletion(
    operationId: string,
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<void> {
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > BACKUP_LIMITS.distinctParts)
      return fail();
    const digests = await Promise.all(parts.map((part) => etagDigest(part.etag)));
    return this.serial(async () => {
      const grant = await this.active(operationId);
      const entries = Object.entries(grant.parts);
      if (
        grant.mode !== "write" ||
        grant.uploadId !== uploadId ||
        grant.completionSize !== null ||
        parts.length === 0 ||
        parts.length !== entries.length ||
        parts.length > BACKUP_LIMITS.distinctParts
      )
        return fail();
      let total = 0;
      let previous = 0;
      let nonFinalBytes: number | null = null;
      for (const [index, part] of parts.entries()) {
        const stored = grant.parts[String(part.partNumber)];
        if (
          !Number.isSafeInteger(part.partNumber) ||
          part.partNumber <= previous ||
          !stored ||
          stored.state !== "finished" ||
          stored.etag === null ||
          stored.etag !== digests[index]
        )
          return fail();
        if (index < parts.length - 1) {
          if (
            stored.bytes < MIN_NON_FINAL_PART_BYTES ||
            (nonFinalBytes !== null && stored.bytes !== nonFinalBytes)
          )
            return fail();
          nonFinalBytes = stored.bytes;
        }
        previous = part.partNumber;
        total += stored.bytes;
        if (total > BACKUP_LIMITS.objectBytes) return fail();
      }
      await this.storage.put(KEY, { ...grant, completionSize: total });
    });
  }
  /** Record before dispatch, so a lost completion reply cannot be mistaken for quiescence. */
  public async markCompletionDispatched(operationId: string, uploadId: string): Promise<void> {
    return this.serial(async () => {
      const grant = await this.active(operationId);
      if (
        grant.mode !== "write" ||
        grant.uploadId !== uploadId ||
        grant.completionSize === null ||
        grant.completionDispatched ||
        Object.values(grant.parts).some((part) => part.state !== "finished")
      )
        return fail();
      await this.storage.put(KEY, { ...grant, completionDispatched: true });
    });
  }
  /** The same live invocation proved it never called complete; no RPC error implies this. */
  public async recordCompletionNotDispatched(
    operationId: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    return this.serial(async () => {
      const grant = await this.storage.get<Grant>(KEY);
      if (
        !grant ||
        grant.operationId !== operationId ||
        grant.key !== key ||
        grant.uploadId !== uploadId ||
        grant.completionOutcome !== null
      )
        return fail();
      await this.storage.put(KEY, { ...grant, completionDispatched: false });
    });
  }
  /** A late actual result belongs to its original grant even after cancellation/revocation. */
  public async recordCompletionOutcome(
    operationId: string,
    uploadId: string,
    size: number,
  ): Promise<void> {
    return this.serial(async () => {
      const grant = await this.storage.get<Grant>(KEY);
      if (
        !grant ||
        grant.operationId !== operationId ||
        grant.uploadId !== uploadId ||
        !grant.completionDispatched ||
        !positive(size) ||
        (grant.completionOutcome !== null && grant.completionOutcome !== size)
      )
        return fail();
      await this.storage.put(KEY, { ...grant, completionOutcome: size });
    });
  }
  public async confirmCompletion(
    operationId: string,
    uploadId: string,
    size: number,
  ): Promise<void> {
    return this.serial(async () => {
      const grant = await this.active(operationId);
      if (
        grant.mode !== "write" ||
        grant.uploadId !== uploadId ||
        grant.completionSize === null ||
        !grant.completionDispatched ||
        grant.completionOutcome !== size ||
        size !== grant.completionSize ||
        !positive(size) ||
        size > BACKUP_LIMITS.objectBytes
      )
        return fail();
    });
  }
  public async revoke(operationId: string): Promise<void> {
    // Prevent new reservations immediately, even while the durable write is queued.
    this.revoked.add(operationId);
    return this.serial(async () => {
      const grant = await this.storage.get<Grant>(KEY);
      if (grant?.operationId === operationId && !grant.revoked)
        await this.storage.put(KEY, { ...grant, revoked: true });
      this.revoked.delete(operationId);
    });
  }
  /** Called only after the lifecycle has confirmed that the old VM is stopped. */
  public async revokeOrphan(): Promise<void> {
    return this.serial(async () => {
      const grant = await this.storage.get<Grant>(KEY);
      if (grant && !grant.revoked) await this.storage.put(KEY, { ...grant, revoked: true });
    });
  }
  public async assertSettled(key: string, uploadId: string): Promise<void> {
    return this.serial(async () => {
      const grant = await this.storage.get<Grant>(KEY);
      if (
        grant?.key === key &&
        grant.uploadId === uploadId &&
        (Date.now() < grant.settleAfter ||
          Object.values(grant.parts).some((part) => part.state === "pending") ||
          (grant.completionDispatched && grant.completionOutcome === null))
      )
        throw new Error("preview_backup_multipart_outcome_unknown");
    });
  }
}
