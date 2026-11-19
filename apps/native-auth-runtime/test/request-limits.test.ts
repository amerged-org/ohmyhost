import { expect, it, vi } from "vitest";
import { boundNativeRequest } from "../src/request-limits.js";

it("rejects oversized streamed bytes, invalid JSON and unsupported content types before the runtime", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(9000));
    },
    cancel,
  });
  const oversized = new Request("https://app.example/api/auth/v1/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const result = await boundNativeRequest(oversized, new AbortController().signal);
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  const failingCancel = vi.fn(async () => {
    throw new Error("transport_cancel_failed");
  });
  const failingStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(9000));
    },
    cancel: failingCancel,
  });
  const failing = await boundNativeRequest(
    new Request("https://app.example/api/auth/v1/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: failingStream,
      duplex: "half",
    } as RequestInit),
    new AbortController().signal,
  );
  expect((failing as Response).status).toBe(413);
  expect(failingCancel).toHaveBeenCalledOnce();
  const next = await boundNativeRequest(
    new Request("https://app.example/api/auth/v1/get-session"),
    new AbortController().signal,
  );
  expect(next).toBeInstanceOf(Request);
  const invalid = await boundNativeRequest(
    new Request("https://app.example/api/auth/v1/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    new AbortController().signal,
  );
  expect((invalid as Response).status).toBe(400);
  const unsupported = await boundNativeRequest(
    new Request("https://app.example/api/auth/v1/sign-in/email", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    new AbortController().signal,
  );
  expect((unsupported as Response).status).toBe(415);
  const longCookie = await boundNativeRequest(
    new Request("https://app.example/api/auth/v1/get-session", {
      headers: { cookie: "a".repeat(16385) },
    }),
    new AbortController().signal,
  );
  expect((longCookie as Response).status).toBe(413);
});
