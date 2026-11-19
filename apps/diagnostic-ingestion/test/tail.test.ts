import { describe, expect, it, vi } from "vitest";
import worker from "../src/tail-main.js";
const key = Buffer.alloc(32, 7).toString("base64");
const marker = {
  schemaVersion: "ohmyhost.diagnostic-marker/v1",
  diagnosticId: "01H00000000000000000000901",
  organizationId: "01H00000000000000000000902",
  projectId: "01H00000000000000000000903",
  environmentId: "01H00000000000000000000904",
  deploymentId: "01H00000000000000000000905",
  source: "control",
  code: "DEPLOYMENT_FAILED",
  occurredAt: new Date().toISOString(),
};
async function signedMarker() {
  const imported = await crypto.subtle.importKey(
    "raw",
    Buffer.from(key, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(JSON.stringify(marker))),
  ).toString("base64url");
  return { ...marker, markerSignature: signature };
}
describe("diagnostic tail", () => {
  it("queues only normalized signed payloads and never raw hostile arguments", async () => {
    const send = vi.fn();
    await worker.tail(
      [
        {
          logs: [{ message: ["password=secret"] }],
          exceptions: [{ message: "secret" }],
          diagnosticsChannelEvents: [
            { channel: "other", message: marker },
            {
              channel: "ohmyhost.diagnostic.v1",
              message: { ...marker, headers: { authorization: "secret" } },
            },
            { channel: "ohmyhost.diagnostic.v1", message: marker },
            {
              channel: "ohmyhost.diagnostic.v1",
              message: { ...marker, markerSignature: "A".repeat(43) },
            },
            { channel: "ohmyhost.diagnostic.v1", message: await signedMarker() },
          ],
        },
      ],
      {
        RUNTIME_CONFIGURATION_STATE: "configured",
        DIAGNOSTIC_PRODUCER_ID: "producer-a",
        DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64: key,
        DIAGNOSTIC_QUEUE: { send },
      },
    );
    expect(send).toHaveBeenCalledOnce();
    const serialized = String(send.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("secret");
  });
});
