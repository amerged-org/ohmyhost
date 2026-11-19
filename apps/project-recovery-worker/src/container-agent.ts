import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parseRecoveryCommand } from "@ohmyhost/platform";

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;

/** Only the private Container object knows this one-instance bearer; no public route is exposed. */
export function createRecoveryAgentServer(
  token: string,
  run: (command: unknown) => Promise<unknown>,
) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new TypeError("Invalid recovery agent token");
  const expected = Buffer.from(token);
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/invoke" || !authorized(request, expected)) {
      send(response, 404);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await boundedBody(request);
    } catch {
      send(response, 413);
      return;
    }
    let command: unknown;
    try {
      command = parseRecoveryCommand(JSON.parse(bytes.toString("utf8")));
    } catch {
      send(response, 400);
      return;
    }
    try {
      const result = Buffer.from(JSON.stringify(await run(command)), "utf8");
      if (result.length > MAX_RESULT_BYTES) throw new Error("Result exceeds limit");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(result);
    } catch {
      send(response, 503);
    }
  });
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const length = Number(request.headers["content-length"] ?? "0");
  if (length > MAX_COMMAND_BYTES) throw new Error("Command exceeds limit");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_COMMAND_BYTES) throw new Error("Command exceeds limit");
    chunks.push(bytes);
  }
  if (size < 2) throw new Error("Command is empty");
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number) {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}
