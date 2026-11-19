import { CustomerRuntimeGatewayError } from "./errors.js";
import {
  exactRecord,
  fetchWithTimeout,
  invalidResponse,
  requireConfiguredUlid,
  throwGatewayRelayError,
  validateGatewayConnection,
  type GatewayConnection,
} from "./http.js";

export interface MailAttachmentDownloadOptions {
  readonly signal?: AbortSignal;
}

/** Server-only receiving access using OHMYHOST_MAIL_KEY and global fetch. */
export function createMailAttachmentClient(
  configuration: GatewayConnection & {
    readonly projectId: string;
    /** Optional expected environment; otherwise use the canonical metadata download_path scope. */
    readonly environmentId?: string;
  },
) {
  const connection = validateGatewayConnection(configuration);
  const projectId = requireConfiguredUlid(
    configuration.projectId,
    "projectId",
    "OHMYHOST_PROJECT_ID",
  );
  const environmentId =
    configuration.environmentId === undefined
      ? undefined
      : requireConfiguredUlid(
          configuration.environmentId,
          "environmentId",
          "OHMYHOST_ENVIRONMENT_ID",
        );
  return Object.freeze({
    /** Consume to EOF for success, or cancel the stream when its bytes are no longer needed. */
    async download(
      downloadPath: string,
      options: MailAttachmentDownloadOptions = {},
    ): Promise<ReadableStream<Uint8Array>> {
      const match =
        typeof downloadPath === "string"
          ? /^\/v1\/projects\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/environments\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/mail\/messages\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/attachments\/([A-Za-z0-9_-]{1,128})$/u.exec(
              downloadPath,
            )
          : null;
      if (
        match === null ||
        match[1] !== projectId ||
        (environmentId !== undefined && match[2] !== environmentId)
      ) {
        throw new CustomerRuntimeGatewayError("gateway_request_invalid", null, false);
      }
      const body = JSON.stringify({
        project_id: projectId,
        environment_id: match[2],
        message_id: match[3],
        attachment_id: match[4],
      });
      if (new TextEncoder().encode(body).byteLength > 1024) {
        throw new CustomerRuntimeGatewayError("gateway_request_invalid", null, false);
      }
      const cancellation = new AbortController();
      const signal =
        options.signal === undefined
          ? cancellation.signal
          : AbortSignal.any([cancellation.signal, options.signal]);
      if (signal.aborted) throw new CustomerRuntimeGatewayError("gateway_timeout", null, true);
      const response = await fetchWithTimeout(
        connection.fetch,
        new Request(new URL("/v1/attachments/download", connection.endpoint), {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.key}`,
            "content-type": "application/json",
          },
          body,
          signal,
        }),
        connection.timeoutMilliseconds,
      );
      if (response.status !== 200) {
        try {
          throwAttachmentError(
            response.status,
            await readAttachmentError(response, connection.timeoutMilliseconds),
          );
        } finally {
          cancellation.abort();
        }
      }
      if (
        response.body === null ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/octet-stream"
      ) {
        cancellation.abort();
        void response.body?.cancel().catch(ignoreCancellationError);
        invalidResponse(response.status);
      }
      return attachmentStream(response.body, response.status, cancellation, signal);
    },
  });
}

/** A pull reads one source chunk; cancellation never drains or duplicates the attachment. */
function attachmentStream(
  body: ReadableStream<Uint8Array>,
  status: number,
  cancellation: AbortController,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const source = body.getReader();
  let finished = false;
  let abort: () => void;
  function finish(cancel: boolean) {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    if (cancel) {
      cancellation.abort();
      void source.cancel().catch(ignoreCancellationError);
    }
    source.releaseLock();
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          controller.error(new CustomerRuntimeGatewayError("gateway_timeout", status, true));
          finish(true);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      async pull(controller) {
        try {
          const next = await source.read();
          if (finished) return;
          if (next.done) {
            finish(false);
            controller.close();
          } else if (next.value instanceof Uint8Array) {
            controller.enqueue(next.value);
          } else {
            invalidResponse(status);
          }
        } catch {
          if (finished) return;
          finish(true);
          controller.error(new CustomerRuntimeGatewayError("gateway_unavailable", status, true));
        }
      },
      cancel() {
        finish(true);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Only small error records are buffered; binary successes never enter this parser. */
async function readAttachmentError(
  response: Response,
  timeoutMilliseconds: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json" ||
    response.body === null ||
    (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > 1024))
  ) {
    void response.body?.cancel().catch(ignoreCancellationError);
    invalidResponse(response.status);
  }
  const source = response.body.getReader();
  const bytes = new Uint8Array(1024);
  let length = 0;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CustomerRuntimeGatewayError("gateway_timeout", response.status, true)),
        timeoutMilliseconds,
      );
    });
    for (;;) {
      const next = await Promise.race([source.read(), expired]);
      if (next.done) {
        finished = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || length + next.value.byteLength > bytes.byteLength)
        invalidResponse(response.status);
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
      ) as unknown;
    } catch {
      return invalidResponse(response.status);
    }
  } catch (error) {
    if (error instanceof CustomerRuntimeGatewayError) throw error;
    throw new CustomerRuntimeGatewayError("gateway_unavailable", response.status, true);
  } finally {
    clearTimeout(timer);
    if (!finished) void source.cancel().catch(ignoreCancellationError);
    source.releaseLock();
  }
}

function ignoreCancellationError(): void {
  // The original download failure remains the public error.
}

function throwAttachmentError(status: number, body: unknown): never {
  throwGatewayRelayError(status, body);
  const record = exactRecord(body, ["code"], status);
  const code = record["code"];
  if (status === 400 && code === "invalid_request")
    throw new CustomerRuntimeGatewayError("gateway_request_invalid", status, false);
  if (status === 401 && code === "unauthorized")
    throw new CustomerRuntimeGatewayError("unauthorized", status, false);
  if (status === 404 && code === "resource_not_found")
    throw new CustomerRuntimeGatewayError("mail_message_not_found", status, false);
  if (status === 410 && code === "mail_content_expired")
    throw new CustomerRuntimeGatewayError("mail_content_expired", status, false);
  if (status === 413 && code === "mail_attachment_too_large")
    throw new CustomerRuntimeGatewayError("mail_attachment_too_large", status, false);
  return invalidResponse(status);
}
