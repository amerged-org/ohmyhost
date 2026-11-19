import {
  parseWorkosSessionStatusRequest,
  parseWorkosSessionStatusResponse,
  type WorkosSessionStatusRequest,
} from "@ohmyhost/workos-auth-contracts";

const SESSION_STATUS_URL = "https://auth-status.internal/session-status";
const MAX_RESPONSE_BYTES = 2_048;
const TIMEOUT_MILLISECONDS = 5_000;

export interface WorkosSessionStatusPort {
  isActive(input: WorkosSessionStatusRequest): Promise<boolean>;
}

export interface WorkosSessionStatusBinding {
  fetch(request: Request): Promise<Response>;
}

export class WorkosSessionStatusUnavailableError extends Error {
  constructor() {
    super("WorkOS session status is unavailable");
    this.name = "WorkosSessionStatusUnavailableError";
  }
}

export function createWorkosSessionStatusClient(
  binding: WorkosSessionStatusBinding,
): WorkosSessionStatusPort {
  return {
    async isActive(rawInput) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const input = parseWorkosSessionStatusRequest(rawInput);
            const response = await binding.fetch(
              new Request(SESSION_STATUS_URL, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify(input),
                signal: controller.signal,
              }),
            );
            if (response.status !== 200 && response.status !== 503) throw unavailable();
            if (
              !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
            ) {
              throw unavailable();
            }
            if (response.headers.get("cache-control")?.toLowerCase() !== "no-store") {
              throw unavailable();
            }
            const status = parseWorkosSessionStatusResponse(
              JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES)) as unknown,
            );
            if (response.status === 503) throw unavailable();
            return status.active;
          })(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(unavailable());
            }, TIMEOUT_MILLISECONDS);
          }),
        ]);
      } catch {
        throw unavailable();
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

export async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw unavailable();
    }
  }
  if (response.body === null) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maximumBytes) throw unavailable();
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function unavailable(): WorkosSessionStatusUnavailableError {
  return new WorkosSessionStatusUnavailableError();
}
