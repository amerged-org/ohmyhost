import { expect, it } from "vitest";

import { createTransactionalMailClient } from "./mail.js";
import { createPrivateStorageClient } from "./storage.js";

const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const transferId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const scenarios = [
  [403, { code: "gateway_not_enabled" }, "gateway_not_enabled", false],
  [403, { code: "gateway_route_denied" }, "gateway_route_denied", false],
  [429, { code: "gateway_rate_limited" }, "gateway_rate_limited", true],
  [503, { code: "mail_gateway_unavailable" }, "gateway_unavailable", true],
  [503, { code: "storage_gateway_unavailable" }, "gateway_unavailable", true],
  [403, "private upstream response", "gateway_response_invalid", false],
  [502, "private upstream response", "gateway_response_invalid", false],
  [503, "private upstream response", "gateway_response_invalid", false],
  [
    403,
    { code: "gateway_route_denied", extra: "private value" },
    "gateway_response_invalid",
    false,
  ],
  [429, { code: "unknown" }, "gateway_response_invalid", false],
  [503, null, "gateway_response_invalid", false],
  [200, { state: "unexpected" }, "gateway_response_invalid", false],
  [202, { state: "unexpected" }, "gateway_response_invalid", false],
] as const;

it.each(["mail", "reserve", "complete", "read", "delete", "readMany", "deleteMany"] as const)(
  "preserves relay codes, received status and redacted retry advice through %s",
  async (operation) => {
    for (const [status, body, code, retryable] of scenarios) {
      const transport = async (request: Request) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${"k".repeat(43)}`);
        return typeof body === "string"
          ? new Response(body, { status })
          : Response.json(body, { status });
      };
      const configuration = {
        endpoint: "https://gateway.example.test",
        key: "k".repeat(43),
        projectId,
        environmentId,
        fetch: transport,
        capabilityFetch: transport,
      };
      const storage = createPrivateStorageClient(configuration);
      const result =
        operation === "mail"
          ? createTransactionalMailClient(configuration).send({
              idempotencyKey: "mail-1",
              to: "person@example.test",
              subject: "Test",
              text: "Test",
            })
          : operation === "reserve"
            ? storage.reserveUpload({
                idempotencyKey: "upload-1",
                objectKey: "file.pdf",
                contentType: "application/pdf",
                contentLength: 1,
              })
            : operation === "complete"
              ? storage.completeUpload(transferId)
              : operation === "read"
                ? storage.createSignedRead("file.pdf")
                : operation === "delete"
                  ? storage.deleteObject({ idempotencyKey: "delete-1", objectKey: "file.pdf" })
                  : operation === "readMany"
                    ? storage.readMany({ objectKeys: ["file.pdf"] })
                    : storage.deleteMany({
                        objects: [{ objectKey: "file.pdf", idempotencyKey: "delete-1" }],
                      });
      await expect(result).rejects.toMatchObject({ code, status, retryable });
      await expect(result).rejects.toThrow(new RegExp(`^${code}(?::|$)`, "u"));
      await expect(result).rejects.not.toThrow(/private|add.*origin|service binding/iu);
    }
  },
);

it("redacts failed response-body reads while retaining the received HTTP status", async () => {
  const transport = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private upstream response"));
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  const configuration = {
    endpoint: "https://gateway.example.test",
    key: "k".repeat(43),
    projectId,
    environmentId,
    fetch: transport,
    capabilityFetch: transport,
  };
  const storage = createPrivateStorageClient(configuration);
  for (const result of [
    createTransactionalMailClient(configuration).send({
      idempotencyKey: "mail-1",
      to: "person@example.test",
      subject: "Test",
      text: "Test",
    }),
    storage.reserveUpload({
      idempotencyKey: "upload-1",
      objectKey: "file.pdf",
      contentType: "application/pdf",
      contentLength: 1,
    }),
    storage.readMany({ objectKeys: ["file.pdf"] }),
    storage.deleteMany({ objects: [{ objectKey: "file.pdf", idempotencyKey: "delete-1" }] }),
  ]) {
    await expect(result).rejects.toMatchObject({
      code: "gateway_unavailable",
      message: "gateway_unavailable",
      status: 503,
      retryable: true,
    });
  }
});
