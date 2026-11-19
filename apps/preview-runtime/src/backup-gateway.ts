import { DirectoryBackupGateway } from "@cloudflare/sandbox";
import {
  BACKUP_LIMITS,
  type BackupPartObservation,
  type BackupTransferMessage,
  type BackupTransferPermit,
} from "./backup-transfer.js";

interface GatewayProps {
  readonly protocolVersion: number;
  readonly mode: "write" | "read" | "control" | "deny";
  readonly binding?: string;
  readonly key?: string;
  readonly uploadId?: string;
  readonly previewId?: string;
  readonly operationId?: string;
  readonly expiresAt?: number;
}
interface GatewayEnvironment {
  readonly PREVIEW_CONTAINERS: {
    getByName(name: string): {
      reserveBackupTransfer(message: BackupTransferMessage): Promise<BackupTransferPermit>;
      observeBackupPart(observation: BackupPartObservation): Promise<void>;
    };
  };
}
interface UploadBucket {
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    uploadPart(partNumber: number, body: ReadableStream): Promise<{ etag: string }>;
  };
}
const PART = /^\/parts\/([1-9][0-9]{0,3})$/u;
const RANGE = /^bytes=([0-9]{1,15})-([0-9]{1,15})$/u;
const LENGTH = /^[1-9][0-9]{0,9}$/u;
const denied = () => new Response("Backup transfer unavailable", { status: 403 });
function ignoreCancellation(): void {}
function cancelStream(stream: { cancel(reason?: unknown): Promise<void> }, reason?: unknown): void {
  void stream.cancel(reason).catch(ignoreCancellation);
}

/** A deadline and periodic durable-grant check also cover stalls after preflight. */
class TransferWindow {
  private readonly expired: Promise<never>;
  private reject!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout>;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly cancellers: Array<(reason: Error) => void> = [];
  public constructor(
    deadline: number,
    private readonly check?: () => Promise<void>,
  ) {
    this.expired = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    this.expired.catch(() => undefined);
    this.timer = setTimeout(() => this.fail(), Math.max(0, deadline - Date.now()));
    if (check) this.schedule();
  }
  private fail(): void {
    if (this.closed) return;
    const error = new Error("preview_backup_transfer_expired");
    this.close();
    this.reject(error);
    for (const cancel of this.cancellers) cancel(error);
  }
  private schedule(): void {
    const check = this.check;
    if (!check) return;
    this.poll = setTimeout(() => {
      void this.wait(check()).then(
        () => {
          if (!this.closed) this.schedule();
        },
        () => this.fail(),
      );
    }, 5_000);
  }
  public onCancel(cancel: (reason: Error) => void): void {
    this.cancellers.push(cancel);
  }
  public wait<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.expired]);
  }
  public cancel(): void {
    this.fail();
  }
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (this.poll !== undefined) clearTimeout(this.poll);
  }
}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  bytes: number,
  window: TransferWindow,
  finish?: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  const cancel = (reason: unknown) => {
    cancelStream(reader, reason);
  };
  window.onCancel(cancel);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await window.wait(reader.read());
        if (next.done) {
          if (seen !== bytes) throw new Error("preview_backup_stream_length");
          if (finish) {
            await window.wait(finish());
            window.close();
          }
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > bytes - seen)
          throw new Error("preview_backup_stream_length");
        seen += next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        cancel(error);
        if (finish) window.close();
        controller.error(error);
      }
    },
    cancel(reason) {
      cancel(reason);
      if (finish) window.close();
    },
  });
}

async function boundedText(response: Response, window: TransferWindow): Promise<string> {
  if (!response.body) throw new Error("preview_backup_upload_failed");
  const reader = response.body.getReader();
  window.onCancel((reason) => {
    cancelStream(reader, reason);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let result = "";
  try {
    for (;;) {
      const next = await window.wait(reader.read());
      if (next.done) return result + decoder.decode();
      size += next.value.byteLength;
      if (size > 8192) throw new Error("preview_backup_upload_failed");
      result += decoder.decode(next.value, { stream: true });
    }
  } catch (error) {
    cancelStream(reader, error);
    throw error;
  }
}

// The SDK declaration uses Workers' two-parameter base type, while this project keeps a
// minimal local Workers declaration. The runtime constructor and inherited methods are unchanged.
const GatewayBase = DirectoryBackupGateway as unknown as new (
  context: unknown,
  env: unknown,
) => {
  readonly ctx: { readonly props: unknown; waitUntil(promise: Promise<unknown>): void };
  readonly env: unknown;
  fetch(request: Request): Promise<Response>;
};

/** Inherits the SDK's control RPC; only the untrusted data fetch is narrowed. */
export class PreviewBackupGateway extends GatewayBase {
  public override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props as GatewayProps;
    const refuse = () => {
      if (request.body) cancelStream(request.body);
      return denied();
    };
    if (
      props.protocolVersion !== 1 ||
      (props.mode !== "write" && props.mode !== "read") ||
      !props.previewId ||
      !props.operationId ||
      !props.key ||
      !props.binding ||
      !Number.isSafeInteger(props.expiresAt) ||
      (props.expiresAt as number) <= Date.now()
    )
      return refuse();
    const actor = (this.env as GatewayEnvironment).PREVIEW_CONTAINERS.getByName(props.previewId);
    const operationId = props.operationId;
    const url = new URL(request.url);
    const transferId = crypto.randomUUID();
    let message: BackupTransferMessage;
    let bytes: number;
    let offset = 0;
    let partNumber = 0;
    if (props.mode === "write") {
      const match = PART.exec(url.pathname);
      const length = request.headers.get("content-length") ?? "";
      if (
        request.method !== "PUT" ||
        !match ||
        !LENGTH.test(length) ||
        !request.body ||
        !props.uploadId
      )
        return refuse();
      partNumber = Number(match[1]);
      bytes = Number(length);
      if (partNumber > BACKUP_LIMITS.partNumbers || bytes > BACKUP_LIMITS.partBytes)
        return refuse();
      message = { kind: "reserve-upload", operationId, transferId, partNumber, bytes };
    } else {
      const match = RANGE.exec(request.headers.get("range") ?? "");
      if (request.method !== "GET" || url.pathname !== "/object" || !match) return refuse();
      offset = Number(match[1]);
      const last = Number(match[2]);
      bytes = last - offset + 1;
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(last) ||
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        bytes > BACKUP_LIMITS.rangeBytes
      )
        return refuse();
      message = { kind: "reserve-download", operationId, transferId, offset, bytes };
    }
    const matches = (permit: BackupTransferPermit) =>
      permit.operationId === operationId &&
      permit.mode === props.mode &&
      permit.binding === props.binding &&
      permit.key === props.key &&
      permit.expiresAt === props.expiresAt &&
      (props.mode !== "write" || permit.uploadId === props.uploadId);
    let permit: BackupTransferPermit;
    const preflight = new TransferWindow(
      Math.min(props.expiresAt as number, Date.now() + BACKUP_LIMITS.transferMs),
    );
    try {
      permit = await preflight.wait(actor.reserveBackupTransfer(message));
      if (!matches(permit) || permit.deadline <= Date.now() || permit.deadline > permit.expiresAt)
        return refuse();
    } catch {
      return refuse();
    } finally {
      preflight.close();
    }
    const window = new TransferWindow(permit.deadline, async () => {
      const checked = await actor.reserveBackupTransfer({ kind: "check", operationId });
      if (!matches(checked)) throw new Error("preview_backup_transfer_denied");
    });
    try {
      if (props.mode === "write") {
        const body = boundedStream(request.body as ReadableStream<Uint8Array>, bytes, window);
        const guardedRequest = new Request(request, { body });
        const binding = props.binding;
        const key = props.key;
        const uploadId = props.uploadId as string;
        const bucket = Object.getOwnPropertyDescriptor(this.env, binding)?.value as UploadBucket;
        // The SDK can return a body error before uploadPart settles. Observe that exact R2
        // promise in a request-local binding; never mutate the shared Worker environment.
        const observedBucket = Object.create(bucket, {
          resumeMultipartUpload: {
            value: (requestedKey: string, requestedUploadId: string) => {
              if (requestedKey !== key || requestedUploadId !== uploadId)
                throw new Error("preview_backup_transfer_denied");
              const upload = bucket.resumeMultipartUpload(key, uploadId);
              return {
                uploadPart: async (requestedPart: number, stream: ReadableStream) => {
                  const identity = { operationId, transferId, key, uploadId, partNumber };
                  let dispatched = false;
                  try {
                    if (requestedPart !== partNumber)
                      throw new Error("preview_backup_transfer_denied");
                    const dispatch = await window.wait(
                      actor.reserveBackupTransfer({
                        kind: "dispatch-upload",
                        operationId,
                        transferId,
                        partNumber,
                      }),
                    );
                    if (!matches(dispatch) || Date.now() >= permit.deadline)
                      throw new Error("preview_backup_transfer_expired");
                    dispatched = true;
                    const observed = upload.uploadPart(partNumber, stream).then(async (part) => {
                      await actor.observeBackupPart({
                        ...identity,
                        kind: "uploaded",
                        etag: part.etag,
                      });
                      return part;
                    });
                    // Retain late success only within the original bounded transfer lifetime.
                    // A lost reply after that lifetime remains durably unknown.
                    const lifetime = new TransferWindow(permit.deadline);
                    this.ctx.waitUntil(
                      lifetime
                        .wait(observed)
                        .then(ignoreCancellation, ignoreCancellation)
                        .finally(() => lifetime.close()),
                    );
                    return await observed;
                  } catch (error) {
                    if (!dispatched)
                      await actor.observeBackupPart({ ...identity, kind: "not-dispatched" });
                    throw error;
                  }
                },
              };
            },
          },
        });
        const observedEnv = Object.create(this.env as object, {
          [binding]: { value: observedBucket },
        });
        const sdk = new GatewayBase(this.ctx, observedEnv);
        const response = await window.wait(sdk.fetch(guardedRequest));
        if (!response.ok) {
          if (response.body) cancelStream(response.body);
          throw new Error("preview_backup_upload_failed");
        }
        const text = await boundedText(response, window);
        const value: unknown = JSON.parse(text);
        if (
          !value ||
          typeof value !== "object" ||
          !("etag" in value) ||
          typeof value.etag !== "string" ||
          value.etag.length === 0 ||
          value.etag.length > 1024
        )
          throw new Error("preview_backup_upload_failed");
        await window.wait(
          actor.reserveBackupTransfer({
            kind: "finish-upload",
            operationId,
            transferId,
            partNumber,
            etag: value.etag,
          }),
        );
        window.close();
        return Response.json({ etag: value.etag });
      }
      const response = await window.wait(super.fetch(request));
      if (response.status !== 206 || !response.body || !permit.size) {
        if (response.body) cancelStream(response.body);
        throw new Error("preview_backup_download_failed");
      }
      const actualBytes = Math.min(bytes, permit.size - offset);
      const contentRange = `bytes ${offset}-${offset + actualBytes - 1}/${permit.size}`;
      if (response.headers.get("content-range") !== contentRange) {
        cancelStream(response.body);
        throw new Error("preview_backup_download_failed");
      }
      const body = boundedStream(response.body, actualBytes, window, async () => {
        await actor.reserveBackupTransfer({ kind: "finish-download", operationId, transferId });
      });
      return new Response(body, { status: 206, headers: { "content-range": contentRange } });
    } catch {
      window.cancel();
      return new Response("Backup transfer failed", { status: 502 });
    }
  }
}
