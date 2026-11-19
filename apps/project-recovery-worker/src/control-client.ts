import {
  CONTROL_ERROR_CODES,
  MAX_CONTROL_RESPONSE_BYTES,
  RECOVERY_CONTROL_HOST,
  RecoveryControlError,
  decodeControlResult,
  encodeControlBody,
  type ControlErrorCode,
  type RecoveryControl,
  type RecoveryControlMethod,
} from "./control-wire.js";
import type { NativeRestoreControl } from "./native-restore-job.js";

export interface RecoveryControlClientOptions {
  /** The ephemeral job token. It lives in the process environment only and is never logged. */
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMilliseconds?: number;
  /** Attempts per call after a transport failure or an unknown outcome (every method replays by its own identity). */
  readonly attempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * The Node side of the Worker-mediated Control access: plain HTTP to the one virtual hostname, which the Container
 * egress interception answers. It carries no database URL, SQL or provider key, and it cannot name another job: the
 * Worker takes the scope from the token it issued. Every answer is shape-checked; binary values return byte for byte.
 */
export function createRecoveryControlClient(
  options: RecoveryControlClientOptions,
): RecoveryControl {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(options.token))
    throw new TypeError("Invalid recovery control token");
  const send = options.fetch ?? fetch;
  const attempts = Math.max(1, Math.min(options.attempts ?? 3, 5));
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));

  async function call(method: RecoveryControlMethod, body: Record<string, unknown> = {}) {
    let last: RecoveryControlError = new RecoveryControlError("control_unavailable");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await once(method, body);
      } catch (error) {
        if (!(error instanceof RecoveryControlError) || !error.retryable) throw error;
        last = error;
        if (attempt < attempts) await sleep(250 * attempt);
      }
    }
    throw last;
  }

  async function once(method: RecoveryControlMethod, body: Record<string, unknown>) {
    let response: Response;
    try {
      response = await send(`http://${RECOVERY_CONTROL_HOST}/v1/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: encodeControlBody(body),
        redirect: "error",
        signal: AbortSignal.timeout(options.requestTimeoutMilliseconds ?? DEFAULT_TIMEOUT),
      });
    } catch {
      // Lost response or unreachable: the command may or may not have applied.
      throw new RecoveryControlError("control_outcome_unknown");
    }
    const text = await boundedText(response);
    if (response.status === 200) return decodeControlResult(method, text);
    throw new RecoveryControlError(errorCode(text, response.status));
  }

  return Object.freeze({
    readClaimState: () => call("readClaimState") as ReturnType<RecoveryControl["readClaimState"]>,
    claim: (input) => call("claim", { ...input }) as ReturnType<RecoveryControl["claim"]>,
    acquireFence: (input) =>
      call("acquireFence", { ...input }) as ReturnType<RecoveryControl["acquireFence"]>,
    renewFence: (input) =>
      call("renewFence", { ...input }) as ReturnType<RecoveryControl["renewFence"]>,
    releaseFence: (input) =>
      call("releaseFence", { ...input }) as ReturnType<RecoveryControl["releaseFence"]>,
    readInventory: () => call("readInventory") as ReturnType<RecoveryControl["readInventory"]>,
    authorizeNativeCapture: (input) =>
      call("authorizeNativeCapture", { ...input }) as Promise<{ readonly authorized: true }>,
    prepareArchive: (input) =>
      call("prepareArchive", { ...input }) as ReturnType<RecoveryControl["prepareArchive"]>,
    dispatchArchive: (input) =>
      call("dispatchArchive", { ...input }) as Promise<{ readonly granted: boolean }>,
    discardArchive: (input) =>
      call("discardArchive", { ...input }) as ReturnType<RecoveryControl["discardArchive"]>,
    finish: (input) => call("finish", { ...input }) as ReturnType<RecoveryControl["finish"]>,
    readArchive: () => call("readArchive") as ReturnType<RecoveryControl["readArchive"]>,
    recordNativeExportRetired: (input) => call("recordNativeExportRetired", { ...input }),
    readCleanupTarget: () =>
      call("readCleanupTarget") as ReturnType<RecoveryControl["readCleanupTarget"]>,
    readRestorePinDeletionTarget: () =>
      call("readRestorePinDeletionTarget") as ReturnType<
        RecoveryControl["readRestorePinDeletionTarget"]
      >,
    recordRestorePinDeletionAbsent: () =>
      call("recordRestorePinDeletionAbsent") as ReturnType<
        RecoveryControl["recordRestorePinDeletionAbsent"]
      >,
    readPinReconciliation: () =>
      call("readPinReconciliation") as ReturnType<RecoveryControl["readPinReconciliation"]>,
    completePinReconciliation: (input) =>
      call("completePinReconciliation", { ...input }) as ReturnType<
        RecoveryControl["completePinReconciliation"]
      >,
    readRestoreClaim: () =>
      call("readRestoreClaim") as ReturnType<NativeRestoreControl["readRestoreClaim"]>,
    readRestoreInput: () =>
      call("readRestoreInput") as ReturnType<NativeRestoreControl["readRestoreInput"]>,
    reserveRestorePin: () =>
      call("reserveRestorePin") as ReturnType<NativeRestoreControl["reserveRestorePin"]>,
    recordRestorePin: () =>
      call("recordRestorePin") as ReturnType<NativeRestoreControl["recordRestorePin"]>,
    recordRestorePinAbsent: () =>
      call("recordRestorePinAbsent") as ReturnType<NativeRestoreControl["recordRestorePinAbsent"]>,
    beginRestore: () => call("beginRestore") as ReturnType<NativeRestoreControl["beginRestore"]>,
    assertRestoreImportAllowed: () =>
      call("assertRestoreImportAllowed") as ReturnType<
        NativeRestoreControl["assertRestoreImportAllowed"]
      >,
    isRestoreAcknowledged: (input) =>
      call("isRestoreAcknowledged", { ...input }) as ReturnType<
        NativeRestoreControl["isRestoreAcknowledged"]
      >,
    applyRestoreOffline: (input) =>
      call("applyRestoreOffline", { ...input }) as ReturnType<
        NativeRestoreControl["applyRestoreOffline"]
      >,
    acknowledgeRestore: (input) =>
      call("acknowledgeRestore", { ...input }) as ReturnType<
        NativeRestoreControl["acknowledgeRestore"]
      >,
    isRestoreRealmImported: (input) =>
      call("isRestoreRealmImported", { ...input }) as ReturnType<
        NativeRestoreControl["isRestoreRealmImported"]
      >,
    markRestoreRealmImported: (input) =>
      call("markRestoreRealmImported", { ...input }) as ReturnType<
        NativeRestoreControl["markRestoreRealmImported"]
      >,
    markRestoreImported: () =>
      call("markRestoreImported") as ReturnType<NativeRestoreControl["markRestoreImported"]>,
    revalidateRestore: (input) =>
      call("revalidateRestore", { ...input }) as ReturnType<
        NativeRestoreControl["revalidateRestore"]
      >,
    sanitizeRestore: (input) =>
      call("sanitizeRestore", { ...input }) as ReturnType<NativeRestoreControl["sanitizeRestore"]>,
    completeRestore: () =>
      call("completeRestore") as ReturnType<NativeRestoreControl["completeRestore"]>,
  } satisfies RecoveryControl & NativeRestoreControl);
}

async function boundedText(response: Response): Promise<string> {
  const stated = Number(response.headers.get("content-length") ?? "0");
  if (stated > MAX_CONTROL_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RecoveryControlError("control_unavailable");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RecoveryControlError("control_unavailable");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof RecoveryControlError) throw error;
    throw new RecoveryControlError("control_outcome_unknown");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function errorCode(body: string, status: number): ControlErrorCode {
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    if (CONTROL_ERROR_CODES.includes(code as ControlErrorCode)) return code as ControlErrorCode;
  } catch {
    // Not a Worker answer (a proxy refusal): unknown outcome unless the status says nothing could have run.
  }
  return status >= 500 ? "control_outcome_unknown" : "forbidden";
}
