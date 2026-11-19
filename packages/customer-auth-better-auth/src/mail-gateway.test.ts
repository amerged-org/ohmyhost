import { webcrypto } from "node:crypto";

import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import { createMailGatewayEmailSender, CustomerAuthEmailDeliveryError } from "./mail-gateway.js";

const projectId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");

describe("Better Auth mail gateway sender", () => {
  it("sends a stable verification request without exposing the key in body", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      expect(this).toBeUndefined();
      const request = new Request(input, init);
      expect(request.url).toBe("https://mail.example.test/v1/send");
      expect(request.headers.get("authorization")).toBe(`Bearer ${"A".repeat(43)}`);
      expect(request.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/u);
      const body = await request.json();
      expect(body).toEqual({
        project_id: projectId,
        to: "person@example.net",
        subject: "Verify your account",
        text: "Verify your account: https://app.example.test/api/auth/verify?token=a",
        html: '<p><a href="https://app.example.test/api/auth/verify?token=a">Verify your account</a></p>',
      });
      expect(JSON.stringify(body)).not.toContain("A".repeat(43));
      return Response.json(
        {
          state: "accepted",
          request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          message_id: "0102019-message-id",
        },
        { status: 202 },
      );
    });
    const sender = createMailGatewayEmailSender({
      projectId,
      gatewayOrigin: "https://mail.example.test",
      key: "A".repeat(43),
      fetch,
      crypto: webcrypto as unknown as Crypto,
      timeoutMilliseconds: 100,
    });
    await expect(
      sender.send({
        kind: "verification",
        to: "person@example.net",
        url: "https://app.example.test/api/auth/verify?token=a",
      }),
    ).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(100);
    timeout.mockRestore();
  });

  it("gives every password-changed notice its own idempotency key and keeps a reset link's key stable", async () => {
    const keys: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Request(input, init).headers.get("idempotency-key") ?? "");
      return Response.json(
        {
          state: "accepted",
          request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          message_id: "0102019-message-id",
        },
        { status: 202 },
      );
    });
    const sender = createMailGatewayEmailSender({
      projectId,
      gatewayOrigin: "https://mail.example.test",
      key: "A".repeat(43),
      fetch,
      crypto: webcrypto as unknown as Crypto,
      timeoutMilliseconds: 100,
    });
    const changed = {
      kind: "password-changed" as const,
      to: "person@example.net",
      url: "https://app.example.test/login",
    };
    const reset = {
      kind: "password-reset" as const,
      to: "person@example.net",
      url: "https://app.example.test/reset-password?token=a",
    };
    await sender.send(changed);
    await sender.send(changed);
    await sender.send(reset);
    await sender.send(reset);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(keys[1]).toMatch(/^[0-9a-f]{64}$/u);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
  });

  it("sends to every address Better Auth accepts at sign-up, and still refuses a space or a bracket", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { to: string };
      expect(new Request(input, init).headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/u);
      return Response.json(
        {
          state: "accepted",
          request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          message_id: body.to,
        },
        { status: 202 },
      );
    });
    const sender = createMailGatewayEmailSender({
      projectId,
      gatewayOrigin: "https://mail.example.test",
      key: "A".repeat(43),
      fetch,
      crypto: webcrypto as unknown as Crypto,
      timeoutMilliseconds: 100,
    });
    for (const to of ["o'brien@example.com", "bob_@example.com", "_bob@example.com"]) {
      await expect(
        sender.send({ kind: "verification", to, url: "https://app.example.test/verify?token=a" }),
      ).resolves.toBeUndefined();
      expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toMatchObject({ to });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const to of ["bob smith@example.com", "<bob>@example.com"]) {
      await expect(
        sender.send({ kind: "verification", to, url: "https://app.example.test/verify?token=a" }),
      ).rejects.toBeInstanceOf(CustomerAuthEmailDeliveryError);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed on uncertain, rejected, malformed, or oversized gateway responses", async () => {
    expect(() =>
      createMailGatewayEmailSender({
        projectId: "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
        gatewayOrigin: "https://mail.example.test",
        key: "A".repeat(43),
        fetch: globalThis.fetch,
        crypto: webcrypto as unknown as Crypto,
      }),
    ).toThrow("Invalid canonical ULID");
    for (const timeoutMilliseconds of [0, 30_001, 1.5]) {
      expect(() =>
        createMailGatewayEmailSender({
          projectId,
          gatewayOrigin: "https://mail.example.test",
          key: "A".repeat(43),
          fetch: globalThis.fetch,
          crypto: webcrypto as unknown as Crypto,
          timeoutMilliseconds,
        }),
      ).toThrow("Mail gateway email sender input is invalid");
    }
    let cancellationAttempts = 0;
    const oversizedWithFailedCancellation = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancellationAttempts++;
          return Promise.reject(new Error("sensitive transport cleanup failure"));
        },
      }),
      { status: 202, headers: { "content-length": "4097" } },
    );
    const responses = [
      Response.json(
        { state: "uncertain", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX" },
        { status: 202 },
      ),
      Response.json({ code: "mail_rejected" }, { status: 502 }),
      new Response("not-json", { status: 202 }),
      new Response("x".repeat(4_097), { status: 202 }),
      oversizedWithFailedCancellation,
    ];
    const sender = createMailGatewayEmailSender({
      projectId,
      gatewayOrigin: "https://mail.example.test",
      key: "A".repeat(43),
      fetch: vi.fn(async () => responses.shift() as Response),
      crypto: webcrypto as unknown as Crypto,
    });
    for (let index = 0; index < 5; index += 1) {
      await expect(
        sender.send({
          kind: "password-reset",
          to: "person@example.net",
          url: "https://app.example.test/api/auth/reset?token=a",
        }),
      ).rejects.toBeInstanceOf(CustomerAuthEmailDeliveryError);
    }
    expect(cancellationAttempts).toBe(1);
    expect(oversizedWithFailedCancellation.bodyUsed).toBe(true);
  });

  it("sends a password-change notification without a reset token", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        subject: "Your password was changed",
        text: "Your password was changed: https://app.example.test/login",
        html: '<p><a href="https://app.example.test/login">Review your account</a></p>',
      });
      return Response.json(
        {
          state: "accepted",
          request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          message_id: "0102019-message-id",
        },
        { status: 202 },
      );
    });
    const sender = createMailGatewayEmailSender({
      projectId,
      gatewayOrigin: "https://mail.example.test",
      key: "A".repeat(43),
      fetch,
      crypto: webcrypto as unknown as Crypto,
    });
    await expect(
      sender.send({
        kind: "password-changed",
        to: "person@example.net",
        url: "https://app.example.test/login",
      }),
    ).resolves.toBeUndefined();
  });
});
