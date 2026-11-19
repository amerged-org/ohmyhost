import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomerRuntimeGatewayError } from "./errors.js";
import { createTransactionalMailClient } from "./mail.js";
import { createMailAttachmentClient } from "./mail-attachment.js";

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const KEY = "k".repeat(43);
const input = {
  idempotencyKey: "password-reset:user-1:token-1",
  to: "admin@example.com",
  subject: "Reset your password",
  text: "Open the reset link.",
  html: "<p>Open the reset link.</p>",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client(fetch: (request: Request) => Promise<Response>, overrides: object = {}) {
  return createTransactionalMailClient({
    endpoint: "https://mail-gateway.internal",
    key: KEY,
    projectId: PROJECT,
    fetch,
    ...overrides,
  });
}

describe("transactional mail client", () => {
  it("streams scoped attachments over the fixed route and propagates consumption, cancellation and failure", async () => {
    const environmentId = REQUEST;
    const messageId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const downloadPath = `/v1/projects/${PROJECT}/environments/${environmentId}/mail/messages/${messageId}/attachments/attachment-1`;
    let pulls = 0;
    let cancels = 0;
    let request: Request | undefined;
    const configuration = {
      endpoint: "https://mail-gateway.internal",
      key: KEY,
      projectId: PROJECT,
      environmentId,
      fetch: vi.fn(async (value: Request) => {
        request = value;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                if (pulls === 1) controller.enqueue(new Uint8Array([1, 2, 3]));
                else controller.close();
              },
              cancel() {
                cancels++;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/octet-stream" } },
        );
      }),
    };
    const attachment = createMailAttachmentClient(configuration);
    const body = await attachment.download(downloadPath);
    expect(pulls).toBe(0);
    expect(request?.url).toBe("https://mail-gateway.internal/v1/attachments/download");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(await request?.json()).toEqual({
      project_id: PROJECT,
      environment_id: environmentId,
      message_id: messageId,
      attachment_id: "attachment-1",
    });
    const reader = body.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 2, 3]) });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(cancels).toBe(0);
    reader.releaseLock();
    const cancelled = await attachment.download(downloadPath);
    await cancelled.cancel("private cancellation reason");
    expect(cancels).toBe(1);
    expect(request?.signal.aborted).toBe(true);
    const controller = new AbortController();
    const aborted = await attachment.download(downloadPath, { signal: controller.signal });
    controller.abort("private abort reason");
    await expect(aborted.getReader().read()).rejects.toMatchObject({
      code: "gateway_timeout",
      status: 200,
    });
    expect(cancels).toBe(2);
    for (const path of [
      "https://provider.example/private",
      `${downloadPath}?secret=yes`,
      `${downloadPath}/extra`,
      downloadPath.replace(PROJECT, messageId),
      downloadPath.replace(environmentId, messageId),
      downloadPath.replace("attachment-1", "%61ttachment-1"),
      downloadPath.replace(messageId, "8".repeat(26)),
      downloadPath.replace("attachment-1", "a".repeat(129)),
    ]) {
      await expect(attachment.download(path)).rejects.toMatchObject({
        code: "gateway_request_invalid",
        status: null,
      });
    }
    expect(configuration.fetch).toHaveBeenCalledTimes(3);
    const mailOnlyBody = await createMailAttachmentClient({
      endpoint: configuration.endpoint,
      key: KEY,
      projectId: PROJECT,
      fetch: configuration.fetch,
    }).download(downloadPath);
    expect((await request?.json())?.environment_id).toBe(environmentId);
    await mailOnlyBody.cancel();
    await expect(
      attachment.download(downloadPath, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "gateway_timeout", status: null });
    expect(() => createMailAttachmentClient({ ...configuration, environmentId: "bad" })).toThrow(
      "environmentId is not a ULID",
    );
    const failed = await createMailAttachmentClient({
      ...configuration,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private provider detail"));
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    }).download(downloadPath);
    await expect(failed.getReader().read()).rejects.toMatchObject({
      code: "gateway_unavailable",
      status: 200,
      message: "gateway_unavailable",
    });
  });

  it("classifies bounded attachment errors and header timeouts without exposing transport details", async () => {
    const configuration = {
      endpoint: "https://mail-gateway.internal",
      key: KEY,
      projectId: PROJECT,
      environmentId: REQUEST,
    };
    const path = `/v1/projects/${PROJECT}/environments/${REQUEST}/mail/messages/${PROJECT}/attachments/a1`;
    for (const [status, code, expected, retryable] of [
      [400, "invalid_request", "gateway_request_invalid", false],
      [401, "unauthorized", "unauthorized", false],
      [403, "gateway_not_enabled", "gateway_not_enabled", false],
      [403, "gateway_route_denied", "gateway_route_denied", false],
      [404, "resource_not_found", "mail_message_not_found", false],
      [410, "mail_content_expired", "mail_content_expired", false],
      [413, "mail_attachment_too_large", "mail_attachment_too_large", false],
      [429, "gateway_rate_limited", "gateway_rate_limited", true],
      [503, "mail_gateway_unavailable", "gateway_unavailable", true],
      [503, "unknown private code", "gateway_response_invalid", false],
    ] as const) {
      await expect(
        createMailAttachmentClient({
          ...configuration,
          fetch: async () => Response.json({ code }, { status }),
        }).download(path),
      ).rejects.toMatchObject({ code: expected, status, retryable });
    }
    for (const response of [
      new Response("private upstream text", { status: 403 }),
      Response.json({ code: "unauthorized", secret: "private" }, { status: 401 }),
      Response.json({ code: "a".repeat(1024) }, { status: 503 }),
      new Response("invalid JSON", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json", "content-length": "2048" },
      }),
      new Response(null, { status: 200 }),
      Response.json({ status: "expired" }),
      new Response("<html>private upstream page</html>", {
        headers: { "content-type": "text/html" },
      }),
    ]) {
      await expect(
        createMailAttachmentClient({ ...configuration, fetch: async () => response }).download(
          path,
        ),
      ).rejects.toMatchObject({ code: "gateway_response_invalid", status: response.status });
    }
    await expect(
      createMailAttachmentClient({
        ...configuration,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("private response body error"));
              },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      }).download(path),
    ).rejects.toMatchObject({
      code: "gateway_unavailable",
      status: 503,
      message: "gateway_unavailable",
    });
    await expect(
      createMailAttachmentClient({
        ...configuration,
        fetch: async () => {
          throw new Error("private upstream text");
        },
      }).download(path),
    ).rejects.toMatchObject({
      code: "gateway_unavailable",
      status: null,
      message: "gateway_unavailable",
    });
    vi.useFakeTimers();
    const pending = createMailAttachmentClient({
      ...configuration,
      timeoutMilliseconds: 100,
      fetch: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("private timeout")));
        }),
    }).download(path);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "gateway_timeout",
      status: null,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    const stalled = createMailAttachmentClient({
      ...configuration,
      timeoutMilliseconds: 100,
      fetch: async () =>
        new Response(new ReadableStream(), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    }).download(path);
    const stalledRejection = expect(stalled).rejects.toMatchObject({
      code: "gateway_timeout",
      status: 503,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(101);
    await stalledRejection;
  });

  it("sends one bounded idempotent request and returns a redacted accepted receipt", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://mail-gateway.internal/v1/send");
      expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(request.headers.get("idempotency-key")).toBe(input.idempotencyKey);
      expect(await request.json()).toEqual({
        project_id: PROJECT,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
      return Response.json(
        {
          state: "accepted",
          request_id: REQUEST,
          message_id: "0102019-message-id",
        },
        { status: 202 },
      );
    });

    await expect(client(fetch).send(input)).resolves.toEqual({
      state: "accepted",
      requestId: REQUEST,
      messageId: "0102019-message-id",
    });
    expect(JSON.stringify(await client(fetch).send(input))).not.toContain(KEY);
  });

  it("preserves an uncertain idempotent outcome without inventing success", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ state: "uncertain", request_id: REQUEST }, { status: 202 }),
    );

    await expect(client(fetch).send(input)).resolves.toEqual({
      state: "uncertain",
      requestId: REQUEST,
    });
  });

  it.each([
    [401, { code: "unauthorized" }, "unauthorized", false],
    [400, { code: "invalid_request" }, "gateway_request_invalid", false],
    [409, { code: "mail_send_conflict" }, "mail_send_conflict", false],
    [
      423,
      { code: "mail_reputation_suspended", request_id: REQUEST },
      "mail_reputation_suspended",
      false,
    ],
    [429, { code: "mail_send_daily_limit" }, "mail_send_limit_exceeded", true],
    [502, { code: "mail_rejected", request_id: REQUEST }, "mail_rejected", false],
    [503, { code: "mail_gateway_unavailable" }, "gateway_unavailable", true],
  ])("maps gateway status %i to a stable redacted error", async (status, body, code, retryable) => {
    const fetch = vi.fn(async () => Response.json(body, { status }));

    await expect(client(fetch).send(input)).rejects.toMatchObject({ code, status, retryable });
  });

  it("names the gateway's own payment code with the action that clears it", async () => {
    for (const [code, message] of [
      [
        "paid_plan_required",
        "paid_plan_required: sending mail needs Paid access; the organization Owner starts Paid in billing, and top-ups do not.",
      ],
      [
        "insufficient_organization_credits",
        "insufficient_organization_credits: the organization has no credits for this send; add credits.",
      ],
      [
        "project_budget_exceeded",
        "project_budget_exceeded: this project's Stop budget is used up; raise it or switch it to continue.",
      ],
    ] as const) {
      const fetch = vi.fn(async () => Response.json({ code }, { status: 402 }));
      await expect(client(fetch).send(input)).rejects.toMatchObject({
        code,
        message,
        status: 402,
        retryable: false,
      });
    }
    // The retired aggregate code is no gateway answer any more.
    await expect(
      client(async () =>
        Response.json({ code: "mail_send_credit_exhausted" }, { status: 402 }),
      ).send(input),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  });

  it("accepts every address form the mail provider accepts", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { state: "accepted", request_id: REQUEST, message_id: "message-1" },
        { status: 202 },
      ),
    );
    for (const to of ["o'brien@example.com", "jane_@example.com", "Jane.Doe@Example.COM"]) {
      await expect(client(fetch).send({ ...input, to })).resolves.toMatchObject({
        state: "accepted",
      });
    }
    await expect(
      client(fetch).send({
        ...input,
        from: "no-reply@example.com",
        replyTo: "O'Brien@Example.COM",
      }),
    ).resolves.toMatchObject({ state: "accepted" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid request values before transport", async () => {
    const fetch = vi.fn();
    const runtime = client(fetch);

    await expect(runtime.send({ ...input, idempotencyKey: "bad key" })).rejects.toMatchObject({
      code: "gateway_request_invalid",
    });
    await expect(runtime.send({ ...input, to: "not-an-email" })).rejects.toBeInstanceOf(
      CustomerRuntimeGatewayError,
    );
    await expect(runtime.send({ ...input, subject: "\n" })).rejects.toMatchObject({
      code: "gateway_request_invalid",
    });
    await expect(runtime.send({ ...input, text: "\u0000" })).rejects.toMatchObject({
      code: "gateway_request_invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects browser execution and malformed connection authority", () => {
    vi.stubGlobal("window", {});
    expect(() => client(vi.fn())).toThrow("gateway_configuration_invalid: ");
    vi.unstubAllGlobals();

    for (const endpoint of [undefined, "http://mail.internal", "https://mail.internal/v1"]) {
      expect(() => client(vi.fn(), { endpoint })).toThrow(
        "gateway_configuration_invalid: endpoint is missing or not an https origin; OHMYHOST_MAIL_GATEWAY_URL and OHMYHOST_STORAGE_GATEWAY_URL exist only when ohmyhost.yaml enables that capability",
      );
    }
    const secret = "short-secret-key-value";
    let invalidKey: unknown;
    try {
      client(vi.fn(), { key: secret });
    } catch (error) {
      invalidKey = error;
    }
    expect(invalidKey).toMatchObject({ code: "gateway_configuration_invalid", retryable: false });
    expect(String(invalidKey)).toContain("gateway_configuration_invalid: key ");
    expect(String(invalidKey)).not.toContain(secret);
    expect(() => client(null as never)).toThrow("gateway_configuration_invalid: fetch ");
    expect(() => client(vi.fn(), { timeoutMilliseconds: 31_000 })).toThrow(
      "gateway_configuration_invalid: timeoutMilliseconds ",
    );
    expect(() => client(vi.fn(), { projectId: "not-ulid" })).toThrow(
      "gateway_configuration_invalid: projectId is not a ULID; pass OHMYHOST_PROJECT_ID",
    );
  });

  it("rejects malformed, oversized, unavailable and timed-out responses without body leakage", async () => {
    await expect(
      client(async () => new Response("not-json", { status: 202 })).send(input),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
    await expect(
      client(
        async () =>
          new Response(JSON.stringify({ state: "accepted" }), {
            status: 202,
            headers: { "content-length": "40000" },
          }),
      ).send(input),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
    await expect(
      client(async () => {
        throw new Error("provider secret detail");
      }).send(input),
    ).rejects.toMatchObject({ code: "gateway_unavailable", message: "gateway_unavailable" });

    vi.useFakeTimers();
    const pending = client(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { timeoutMilliseconds: 100 },
    ).send(input);
    const timedOut = expect(pending).rejects.toMatchObject({
      code: "gateway_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(101);
    await timedOut;
  });

  it("rejects unknown or structurally invalid gateway outcomes", async () => {
    await expect(
      client(async () => Response.json({ code: "unknown" }, { status: 418 })).send(input),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
    await expect(
      client(async () =>
        Response.json({ state: "accepted", request_id: "bad", message_id: "id" }, { status: 202 }),
      ).send(input),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  });
});
