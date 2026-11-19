/** Fixed failures survive streaming without exposing upstream URLs, bodies or provider errors. */
export class MailContentExpiredError extends Error {
  public readonly code = "mail_content_expired";
  public constructor() {
    super("mail_content_expired");
  }
}
export class MailAttachmentTooLargeError extends Error {
  public readonly code = "mail_attachment_too_large";
  public constructor() {
    super("mail_attachment_too_large");
  }
}
export class MailAttachmentScopeUnavailableError extends Error {
  public constructor() {
    super("Mail attachment unavailable");
  }
}
const CHUNK_BYTES = 64 * 1024;
const RECHECK_BYTES = 1024 * 1024;

/** No Core call spans CDN I/O; ownership is rechecked between bounded chunks. */
export async function streamMailAttachment(input: {
  fetch: typeof globalThis.fetch;
  url: string;
  size: number;
  maximumBytes: number;
  providerExpiresAt: string;
  messageExpiresAt: Date;
  now: () => Date;
  checkScope: () => Promise<boolean>;
  signal?: AbortSignal | undefined;
}): Promise<Response> {
  if (input.size > input.maximumBytes) throw new MailAttachmentTooLargeError();
  const expiry = Math.min(input.messageExpiresAt.getTime(), Date.parse(input.providerExpiresAt));
  if (!Number.isFinite(expiry) || input.now().getTime() >= expiry)
    throw new MailContentExpiredError();
  const deadline = Math.min(expiry, input.now().getTime() + 15000);
  const abort = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamBYOBReader | undefined;
  let output: ReadableByteStreamController | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let consumed = 0;
  let sinceCheck = 0;
  let checkedAt = input.now().getTime();
  let first = true;
  const redact = (error: unknown): Error =>
    error instanceof MailContentExpiredError ||
    error instanceof MailAttachmentTooLargeError ||
    error instanceof MailAttachmentScopeUnavailableError
      ? error
      : new Error("Mail attachment unavailable");
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopped = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", requestAborted);
      abort.abort();
      try {
        if (reader) await reader.cancel();
        else await response?.body?.cancel();
      } catch {
        /* Best effort upstream cleanup; it cannot expose a provider error. */
      }
    })();
    return closing;
  };
  const requestAborted = () => {
    output?.error(new Error("Mail attachment unavailable"));
    void close();
  };
  input.signal?.addEventListener("abort", requestAborted, { once: true });
  const timeCheck = () => {
    const now = input.now().getTime();
    if (now >= expiry) throw new MailContentExpiredError();
    if (now >= deadline) throw new Error("Mail attachment unavailable");
  };
  const recheck = async () => {
    timeCheck();
    if (!(await input.checkScope())) throw new MailAttachmentScopeUnavailableError();
    timeCheck();
    sinceCheck = 0;
    checkedAt = input.now().getTime();
  };
  const timer = setTimeout(
    () => {
      const error =
        input.now().getTime() >= expiry
          ? new MailContentExpiredError()
          : new Error("Mail attachment unavailable");
      output?.error(error);
      void close();
    },
    Math.max(1, deadline - input.now().getTime()),
  );
  try {
    if (input.signal?.aborted) throw new Error("Mail attachment unavailable");
    response = await input.fetch(input.url, {
      redirect: "manual",
      signal: abort.signal,
      headers: { "accept-encoding": "identity" },
    });
    timeCheck();
    if (stopped || !response.ok || response.status !== 200)
      throw new Error("Mail attachment unavailable");
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding !== "identity")
      throw new Error("Mail attachment unavailable");
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))
        throw new Error("Mail attachment unavailable");
      if (Number(declared) > input.maximumBytes) throw new MailAttachmentTooLargeError();
      if (Number(declared) !== input.size) throw new Error("Mail attachment unavailable");
    }
    if (!response.body) throw new Error("Mail attachment unavailable");
    reader = response.body.getReader({ mode: "byob" });
    await recheck();
    if (stopped) throw new Error("Mail attachment unavailable");
    const source = reader;
    const body = new ReadableStream(
      {
        type: "bytes",
        start(controller) {
          output = controller;
        },
        async pull(controller) {
          if (stopped) return;
          try {
            timeCheck();
            if (first || sinceCheck >= RECHECK_BYTES || input.now().getTime() - checkedAt >= 1000) {
              await recheck();
              first = false;
            }
            if (stopped) return;
            const next = await source.read(new Uint8Array(CHUNK_BYTES));
            if (stopped) return;
            timeCheck();
            if (next.done) {
              if (consumed !== input.size) throw new Error("Mail attachment unavailable");
              await recheck();
              await close();
              controller.close();
              return;
            }
            consumed += next.value.byteLength;
            sinceCheck += next.value.byteLength;
            if (consumed > input.maximumBytes) throw new MailAttachmentTooLargeError();
            if (consumed > input.size) throw new Error("Mail attachment unavailable");
            // Recheck immediately after the byte threshold, before releasing this bounded chunk.
            if (sinceCheck >= RECHECK_BYTES || input.now().getTime() - checkedAt >= 1000)
              await recheck();
            if (!stopped) controller.enqueue(next.value);
          } catch (error) {
            await close();
            controller.error(redact(error));
          }
        },
        async cancel() {
          await close();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    await close();
    throw redact(error);
  }
}
